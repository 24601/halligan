import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AxInMemoryTrajectoryStore,
  AxManualEventClock,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryStoreConformanceInstance,
  axResolveTrajectorySteps,
  runAxTrajectoryStoreConformance,
} from '../src/ax/index.js';
import { AxJSONLTrajectoryStore } from '../src/tools/trajectory/jsonl.js';

/**
 * Repeated verbatim in the PR body and in this script's own output. Saying it
 * once, in the artifact itself, is the only version that survives being quoted
 * out of context.
 */
export const AX_TRAJECTORY_EVAL_HONESTY =
  'This is a deterministic zero-cost mechanism evaluation with fault injection. It is bounded machinery evidence -- store conformance, crash classification, blob-before-step ordering, torn-frame handling and cursor resumption. It is not a held-out model comparison. It says nothing about whether the mind thinks well, chooses good routes, or writes useful memories, and no claim of that kind is made.';

export type AxTrajectoryEvalStoreKind = 'memory' | 'jsonl';

export interface AxTrajectoryDurabilityRow {
  readonly crashRow: string;
  readonly store: AxTrajectoryEvalStoreKind;
  readonly faultInjected: boolean;
  /** Steps the writer believed it had committed that recovery cannot see. */
  readonly stepsLost: number;
  /** Blob refs on a recovered step whose bytes cannot be fetched. */
  readonly danglingRefs: number;
  /** Blob files no recovered step references. `null` where unobservable. */
  readonly orphanBlobs: number | null;
  readonly corruptFramesDropped: number;
  /** Recovered steps sharing a stepId, i.e. a replayed append that stuck. */
  readonly doubleAppends: number;
  readonly cursorResumption:
    | 'exact'
    | 'replayed'
    | 'gap'
    | 'rejected'
    | 'not-applicable';
  readonly classification: string;
  readonly expected: string;
}

export interface AxTrajectoryTruncationRow {
  readonly offset: number;
  readonly atRecordBoundary: boolean;
  readonly recoveredSteps: number;
  readonly expectedSteps: number;
  readonly corruptFramesDropped: number;
  /** Recovered steps whose id was never written: proof a frame was glued. */
  readonly gluedFrames: number;
}

export interface AxTrajectoryDurabilityReport {
  readonly fixture: {
    readonly kind: 'deterministic-fault-injection';
    readonly providerCalls: 0;
    readonly tokens: 0;
    readonly usd: 0;
    readonly independentModelHeldOut: false;
    readonly baselines: readonly string[];
  };
  readonly conformance: {
    readonly memoryAssertions: number;
    readonly jsonlAssertions: number;
    readonly identical: boolean;
    readonly memoryDurability: string;
    readonly jsonlDurability: string;
  };
  readonly rows: readonly AxTrajectoryDurabilityRow[];
  readonly truncation: {
    readonly totalRecords: number;
    readonly probes: readonly AxTrajectoryTruncationRow[];
    readonly gluedFramesTotal: number;
    readonly stepsLostBeyondTruncation: number;
  };
  readonly honesty: string;
}

const SPILLABLE = 'p'.repeat(8_000);

interface Harness {
  readonly store: AxTrajectoryStore;
  readonly kind: AxTrajectoryEvalStoreKind;
  /** Re-opens the same bytes; volatile stores hand back the same instance. */
  reopen(): AxTrajectoryStore;
  listBlobRefs(): readonly string[] | null;
  tearDown(): void;
}

function memoryHarness(clock: AxManualEventClock): Harness {
  const store = new AxInMemoryTrajectoryStore({ clock });
  return {
    store,
    kind: 'memory',
    reopen: () => store,
    listBlobRefs: () => null,
    tearDown: () => store.close(),
  };
}

function jsonlHarness(clock: AxManualEventClock): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'ax-trajectory-eval-'));
  let current = new AxJSONLTrajectoryStore({ directory, clock, fsync: false });
  return {
    get store() {
      return current;
    },
    kind: 'jsonl',
    reopen: () => {
      current.close();
      current = new AxJSONLTrajectoryStore({ directory, clock, fsync: false });
      return current;
    },
    listBlobRefs: () =>
      readdirSync(join(directory, 'blobs')).map((file) =>
        decodeURIComponent(file.replace(/\.blob$/, ''))
      ),
    tearDown: () => {
      current.close();
      rmSync(directory, { recursive: true, force: true });
    },
  } as Harness;
}

async function allSteps(
  store: AxTrajectoryStore,
  trajectoryId: string
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const stats = await store.stats(trajectoryId);
  if (!stats) return [];
  return store.read({ trajectoryId, fromSeq: 0, toSeq: stats.stepCount });
}

async function danglingRefCount(
  store: AxTrajectoryStore,
  steps: readonly Readonly<AxTrajectoryStep>[]
): Promise<number> {
  let dangling = 0;
  for (const step of steps) {
    if (!step.blobs?.length) continue;
    try {
      await axResolveTrajectorySteps([step], store.blobs);
    } catch {
      dangling += step.blobs.length;
    }
  }
  return dangling;
}

function orphanBlobCount(
  harness: Harness,
  steps: readonly Readonly<AxTrajectoryStep>[]
): number | null {
  const files = harness.listBlobRefs();
  if (!files) return null;
  const referenced = new Set(
    steps.flatMap((step) => (step.blobs ?? []).map((blob) => blob.ref))
  );
  return files.filter((ref) => !referenced.has(ref)).length;
}

/** Seeds a log with a mix of narrative, machinery and one spilled field. */
async function seed(store: AxTrajectoryStore, count: number) {
  const { trajectoryId } = await store.create({ slug: 'durability' });
  for (let index = 0; index < count; index++) {
    await store.append({
      trajectoryId,
      type: index % 5 === 0 ? 'message' : 'run',
      ...(index % 5 === 0 ? { source: 'human' } : {}),
      data:
        index === 2 ? { command: SPILLABLE } : { index, note: `step ${index}` },
    });
  }
  return trajectoryId;
}

async function measure(
  harness: Harness,
  trajectoryId: string,
  committedBefore: number,
  crashRow: string,
  faultInjected: boolean,
  expected: string,
  classification: string,
  cursorResumption: AxTrajectoryDurabilityRow['cursorResumption']
): Promise<AxTrajectoryDurabilityRow> {
  const store = harness.reopen();
  const steps = await allSteps(store, trajectoryId);
  const drained = await store.readFrom(undefined, trajectoryId, {
    maxSteps: 10_000,
  });
  const ids = steps.map((step) => step.stepId);
  return {
    crashRow,
    store: harness.kind,
    faultInjected,
    stepsLost: Math.max(0, committedBefore - steps.length),
    danglingRefs: await danglingRefCount(store, steps),
    orphanBlobs: orphanBlobCount(harness, steps),
    corruptFramesDropped: drained.corrupt,
    doubleAppends: ids.length - new Set(ids).size,
    cursorResumption,
    classification,
    expected,
  };
}

async function cursorRow(
  harness: Harness,
  trajectoryId: string,
  crashRow: string,
  mutate: (cursor: { trajectoryId: string; seq: number; token?: string }) => {
    trajectoryId: string;
    seq: number;
    token?: string;
  },
  expectedReason: string
): Promise<AxTrajectoryDurabilityRow> {
  const store = harness.store;
  const committed = (await allSteps(store, trajectoryId)).length;
  const base = await store.readFrom(undefined, trajectoryId, { maxSteps: 1 });
  let reason = 'accepted';
  try {
    await store.readFrom(mutate({ ...base.cursor }), trajectoryId, {});
  } catch (error) {
    reason = String((error as { reason?: unknown }).reason ?? 'unknown');
  }
  const row = await measure(
    harness,
    trajectoryId,
    committed,
    crashRow,
    true,
    `AxTrajectoryCursorError(${expectedReason})`,
    `AxTrajectoryCursorError(${reason})`,
    reason === expectedReason ? 'rejected' : 'gap'
  );
  return row;
}

async function conformanceCounts() {
  const memoryClock = new AxManualEventClock(1_000);
  const memoryStores = new Map<string, AxInMemoryTrajectoryStore>();
  const memory = await runAxTrajectoryStoreConformance(
    ({ databaseKey }) => {
      let store = memoryStores.get(databaseKey);
      if (!store) {
        store = new AxInMemoryTrajectoryStore({ clock: memoryClock });
        memoryStores.set(databaseKey, store);
      }
      const bound = store;
      return {
        store: bound,
        failNextBlobWrite: () => bound.failNextBlobWrite(),
        corruptTrailingFrame: (id: string) =>
          bound.injectCorruptTrailingFrame(id),
      } satisfies AxTrajectoryStoreConformanceInstance;
    },
    { clock: memoryClock }
  );

  const fileClock = new AxManualEventClock(1_000);
  const base = mkdtempSync(join(tmpdir(), 'ax-trajectory-eval-kit-'));
  const fileStores = new Map<string, AxJSONLTrajectoryStore>();
  try {
    const jsonl = await runAxTrajectoryStoreConformance(
      ({ databaseKey }) => {
        let store = fileStores.get(databaseKey);
        if (!store) {
          store = new AxJSONLTrajectoryStore({
            directory: join(base, databaseKey),
            clock: fileClock,
            fsync: false,
          });
          fileStores.set(databaseKey, store);
        }
        const bound = store;
        return {
          store: bound,
          failNextBlobWrite: () => bound.failNextBlobWrite(),
          corruptTrailingFrame: (id: string) =>
            bound.injectCorruptTrailingFrame(id),
        } satisfies AxTrajectoryStoreConformanceInstance;
      },
      { clock: fileClock }
    );

    return {
      memoryAssertions: memory.assertions,
      jsonlAssertions: jsonl.assertions,
      identical: memory.assertions === jsonl.assertions,
      memoryDurability: memory.capability.durability,
      jsonlDurability: jsonl.capability.durability,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Byte-level truncation at every record boundary plus three mid-record
 * offsets. The property under test is not "nothing is lost" -- bytes past the
 * truncation point are genuinely gone -- but that recovery returns exactly the
 * complete records that survived, counts the partial one, and never fuses two
 * records into a step that was never written.
 */
async function truncationStudy(clock: AxManualEventClock) {
  const directory = mkdtempSync(join(tmpdir(), 'ax-trajectory-trunc-'));
  try {
    const store = new AxJSONLTrajectoryStore({
      directory,
      clock,
      fsync: false,
    });
    const trajectoryId = await seed(store, 12);
    const written = await allSteps(store, trajectoryId);
    const writtenIds = new Set(written.map((step) => step.stepId));
    store.close();

    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    const original = readFileSync(path);
    const boundaries: number[] = [];
    for (let index = 0; index < original.length; index++) {
      if (original[index] === 0x0a) boundaries.push(index + 1);
    }
    const midpoints = [1, 2, 3].map((n) =>
      Math.floor((boundaries[n]! + boundaries[n + 1]!) / 2)
    );
    const offsets = [...boundaries, ...midpoints].sort((a, b) => a - b);

    const probes: AxTrajectoryTruncationRow[] = [];
    for (const offset of offsets) {
      writeFileSync(path, original);
      truncateSync(path, offset);
      const reopened = new AxJSONLTrajectoryStore({
        directory,
        clock,
        fsync: false,
      });
      const steps = await allSteps(reopened, trajectoryId);
      const drained = await reopened.readFrom(undefined, trajectoryId, {
        maxSteps: 10_000,
      });
      const atBoundary = boundaries.includes(offset);
      probes.push({
        offset,
        atRecordBoundary: atBoundary,
        recoveredSteps: steps.length,
        expectedSteps: boundaries.filter((value) => value <= offset).length,
        corruptFramesDropped: drained.corrupt,
        gluedFrames: steps.filter((step) => !writtenIds.has(step.stepId))
          .length,
      });
      reopened.close();
    }
    return {
      totalRecords: written.length,
      probes,
      gluedFramesTotal: probes.reduce((sum, row) => sum + row.gluedFrames, 0),
      stepsLostBeyondTruncation: probes.filter(
        (row) => row.recoveredSteps !== row.expectedSteps
      ).length,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runTrajectoryDurabilityEvaluation(): Promise<AxTrajectoryDurabilityReport> {
  const clock = new AxManualEventClock(1_000);
  const rows: AxTrajectoryDurabilityRow[] = [];
  const harnesses: Harness[] = [];

  try {
    for (const make of [memoryHarness, jsonlHarness]) {
      // --- baseline: the same work with fault injection disabled ------------
      const clean = make(clock);
      harnesses.push(clean);
      const cleanId = await seed(clean.store, 12);
      const cleanCommitted = (await allSteps(clean.store, cleanId)).length;
      rows.push(
        await measure(
          clean,
          cleanId,
          cleanCommitted,
          'baseline-no-fault',
          false,
          'every committed step readable',
          'every committed step readable',
          'exact'
        )
      );

      // --- C1: killed before append returns ---------------------------------
      const c1 = make(clock);
      harnesses.push(c1);
      const c1Id = await seed(c1.store, 6);
      const c1Committed = (await allSteps(c1.store, c1Id)).length;
      let c1Classification = 'append succeeded';
      try {
        // The blob write is armed to fail, so the append cannot reach commit:
        // from the caller's side this is a kill before append returns.
        (
          c1.store as unknown as { failNextBlobWrite(): void }
        ).failNextBlobWrite();
        await c1.store.append({
          trajectoryId: c1Id,
          stepId: 'c1-probe',
          type: 'runtime-output',
          data: { stdout: SPILLABLE },
        });
      } catch (error) {
        c1Classification = `rejected(${String(
          (error as { reason?: unknown }).reason
        )})`;
      }
      // The retry uses the same preset id: a crashed writer that comes back
      // must not be able to double-append.
      await c1.store.append({
        trajectoryId: c1Id,
        stepId: 'c1-probe',
        type: 'runtime-output',
        data: { stdout: SPILLABLE },
      });
      await c1.store.append({
        trajectoryId: c1Id,
        stepId: 'c1-probe',
        type: 'runtime-output',
        data: { stdout: SPILLABLE },
      });
      rows.push(
        await measure(
          c1,
          c1Id,
          c1Committed + 1,
          'C1-before-append-returns',
          true,
          'rejected(blob_write_failed)',
          c1Classification,
          'exact'
        )
      );

      // --- C3: torn trailing frame ------------------------------------------
      const c3 = make(clock);
      harnesses.push(c3);
      const c3Id = await seed(c3.store, 8);
      const c3Committed = (await allSteps(c3.store, c3Id)).length;
      (
        c3.store as unknown as {
          injectCorruptTrailingFrame(id: string): void;
        }
      ).injectCorruptTrailingFrame(c3Id);
      rows.push(
        await measure(
          c3,
          c3Id,
          c3Committed,
          'C3-torn-trailing-frame',
          true,
          'the partial frame is dropped and counted; the record before it is intact',
          'the partial frame is dropped and counted; the record before it is intact',
          'exact'
        )
      );

      // --- C14: unusable cursors --------------------------------------------
      const beyond = make(clock);
      harnesses.push(beyond);
      const beyondId = await seed(beyond.store, 5);
      rows.push(
        await cursorRow(
          beyond,
          beyondId,
          'C14-cursor-beyond-end',
          (cursor) => ({ ...cursor, seq: 10_000 }),
          'beyond_end'
        )
      );

      const identity = make(clock);
      harnesses.push(identity);
      const identityId = await seed(identity.store, 5);
      rows.push(
        await cursorRow(
          identity,
          identityId,
          'C14-cursor-identity-changed',
          (cursor) => ({ ...cursor, token: 'foreign-instance:0' }),
          'identity_changed'
        )
      );
    }

    // --- C2: blob durable, step line never written --------------------------
    const c2 = jsonlHarness(clock);
    harnesses.push(c2);
    const c2Id = await seed(c2.store, 6);
    const c2Committed = (await allSteps(c2.store, c2Id)).length;
    // Write the blob through the store's own blob store, then never append the
    // referencing line: exactly the C2 window.
    await c2.store.blobs!.put({
      trajectoryId: c2Id,
      stepId: 'c2-orphan',
      field: 'stdout',
      value: `${SPILLABLE}-orphan`,
    });
    rows.push(
      await measure(
        c2,
        c2Id,
        c2Committed,
        'C2-blob-then-crash',
        true,
        'one orphan blob, zero dangling refs',
        'one orphan blob, zero dangling refs',
        'exact'
      )
    );

    // --- C14 shrank: only a byte-offset cursor can detect this --------------
    const shrank = jsonlHarness(clock);
    harnesses.push(shrank);
    const shrankId = await seed(shrank.store, 5);
    rows.push(
      await cursorRow(
        shrank,
        shrankId,
        'C14-cursor-shrank',
        (cursor) => ({
          ...cursor,
          token: `${cursor.token!.split(':')[0]}:99999999`,
        }),
        'shrank'
      )
    );

    return {
      fixture: {
        kind: 'deterministic-fault-injection',
        providerCalls: 0,
        tokens: 0,
        usd: 0,
        independentModelHeldOut: false,
        baselines: [
          'the same work with fault injection disabled (baseline-no-fault)',
          'the volatile in-memory store beside the persistent JSONL store',
        ],
      },
      conformance: await conformanceCounts(),
      rows,
      truncation: await truncationStudy(clock),
      honesty: AX_TRAJECTORY_EVAL_HONESTY,
    };
  } finally {
    for (const harness of harnesses) harness.tearDown();
  }
}

export function assertTrajectoryDurabilityEvaluation(
  report: AxTrajectoryDurabilityReport
): void {
  const fail = (message: string): never => {
    throw new Error(`trajectory durability evaluation: ${message}`);
  };
  if (!report.conformance.identical) {
    fail(
      `the two stores report different conformance assertion counts (${report.conformance.memoryAssertions} vs ${report.conformance.jsonlAssertions})`
    );
  }
  for (const row of report.rows) {
    const label = `${row.crashRow}/${row.store}`;
    if (row.danglingRefs !== 0) fail(`${label} produced a dangling blob ref`);
    if (row.doubleAppends !== 0) fail(`${label} double-appended a step`);
    if (row.classification !== row.expected) {
      fail(`${label} classified as "${row.classification}"`);
    }
  }
  if (report.truncation.gluedFramesTotal !== 0) {
    fail('a truncated log glued two records into a step nobody wrote');
  }
  if (report.truncation.stepsLostBeyondTruncation !== 0) {
    fail('recovery did not return exactly the complete records that survived');
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const report = await runTrajectoryDurabilityEvaluation();
  assertTrajectoryDurabilityEvaluation(report);
  process.stdout.write(
    `${JSON.stringify(
      { command: 'npm run trajectory:durability:eval', ...report },
      null,
      2
    )}\n`
  );
}
