import type { AxEventClock } from '../event/types.js';
import { axEventCanonicalJson } from '../event/util.js';
import { axResolveTrajectoryStep } from './spill.js';
import type {
  AxTrajectoryStep,
  AxTrajectoryStore,
  AxTrajectoryStoreCapabilities,
} from './types.js';

export interface AxTrajectoryStoreConformanceInstance {
  readonly store: AxTrajectoryStore;
  /** Optional hook a store may expose so C-CORRUPT can run against it. */
  readonly corruptTrailingFrame?: (
    trajectoryId: string
  ) => void | Promise<void>;
  /** Optional hook so C-ORDER can inject a failing blob write. */
  readonly failNextBlobWrite?: () => void;
}

export interface AxTrajectoryStoreConformanceFactoryOptions {
  readonly databaseKey: string;
}

export type AxTrajectoryStoreConformanceFactory = (
  options: Readonly<AxTrajectoryStoreConformanceFactoryOptions>
) =>
  | AxTrajectoryStoreConformanceInstance
  | Promise<AxTrajectoryStoreConformanceInstance>;

export interface AxTrajectoryStoreConformanceReport {
  readonly assertions: number;
  readonly capability: Readonly<AxTrajectoryStoreCapabilities>;
}

type Counting = (condition: unknown, message: string) => void;

async function expectReason(
  assert: Counting,
  promise: Promise<unknown>,
  reason: string,
  label: string
): Promise<void> {
  try {
    await promise;
    assert(false, `${label}: expected a rejection with reason ${reason}`);
  } catch (error) {
    assert(
      (error as { reason?: unknown })?.reason === reason,
      `${label}: expected reason ${reason}, got ${String(
        (error as { reason?: unknown })?.reason
      )}`
    );
  }
}

/** A structurally-typed signal that counts its own listener registrations. */
function countingSignal(): { signal: AbortSignal; listeners: () => number } {
  let count = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    onabort: null,
    throwIfAborted(): void {},
    addEventListener(): void {
      count++;
    },
    removeEventListener(): void {
      count--;
    },
    dispatchEvent: (): boolean => true,
  } as unknown as AbortSignal;
  return { signal, listeners: () => count };
}

function stepDigest(step: Readonly<AxTrajectoryStep>): string {
  return axEventCanonicalJson(step);
}

/**
 * The normative append-only-log contract as executable code.
 *
 * A conformant store declares `blobs`, `cursorTokens` and `consumerCursors`:
 * they are contract requirements, not variants, so the assertion count is a
 * function of the two optional fault hooks alone. The shipped in-memory and
 * JSONL stores both provide those hooks and must therefore report the SAME
 * assertion count -- that equality is itself asserted by the durability
 * evaluation, because two implementations reporting different counts means
 * one of them quietly skipped part of the contract.
 */
export async function runAxTrajectoryStoreConformance(
  createStore: AxTrajectoryStoreConformanceFactory,
  options: Readonly<{ clock: AxEventClock & { advanceBy(ms: number): void } }>
): Promise<AxTrajectoryStoreConformanceReport> {
  let assertions = 0;
  const assert: Counting = (condition, message) => {
    assertions++;
    if (!condition)
      throw new Error(`AxTrajectoryStore conformance: ${message}`);
  };
  const key = `conformance-${Math.random().toString(36).slice(2)}`;
  const primary = await createStore({ databaseKey: key });
  const { store } = primary;
  const clock = options.clock;

  try {
    // ---- C-CAP -----------------------------------------------------------
    const caps = store.capabilities;
    assert(
      caps.durability === 'volatile' || caps.durability === 'persistent',
      'C-CAP: durability is declared'
    );
    assert(
      caps.coordination === 'single-writer' ||
        caps.coordination === 'multi-writer',
      'C-CAP: coordination is declared'
    );
    assert(caps.appendAtomicity, 'C-CAP: appendAtomicity is required');
    assert(
      caps.blobs && Boolean(store.blobs),
      'C-CAP: blobs implies a blob store'
    );
    assert(
      caps.consumerCursors &&
        typeof store.loadCursor === 'function' &&
        typeof store.saveCursor === 'function',
      'C-CAP: consumerCursors implies loadCursor/saveCursor'
    );
    assert(caps.cursorTokens, 'C-CAP: cursorTokens is required');
    assert(
      typeof caps.conformance?.schemaVersion === 'number',
      'C-CAP: a conformant store stamps conformance.schemaVersion'
    );
    assert(
      caps.conformance?.multiWriter === undefined,
      'C-CAP: multiWriter is reserved for v2 and must be unset'
    );
    assert(store.clock === clock, 'C-CAP: the store adopts the injected clock');

    const header = await store.create({ slug: 'conformance' });
    const id = header.trajectoryId;
    assert(header.depth === 0, 'C-CAP: a root trajectory has depth 0');
    assert(
      (await store.getTrajectory(id))?.trajectoryId === id,
      'C-CAP: getTrajectory round-trips the header'
    );
    assert(
      (await store.getTrajectory('missing-trajectory')) === undefined,
      'C-CAP: getTrajectory of an unknown id is undefined'
    );

    // ---- C-SEQ / C-IMM ---------------------------------------------------
    const receipts: Awaited<ReturnType<AxTrajectoryStore['append']>>[] = [];
    for (let index = 0; index < 100; index++) {
      receipts.push(
        await store.append({
          trajectoryId: id,
          type: index % 10 === 0 ? 'message' : 'run',
          ...(index % 10 === 0 ? { source: 'human' } : {}),
          data: { index },
        })
      );
    }
    const baseSeq = receipts[0]!.seq;
    assert(
      receipts.every((receipt, index) => receipt.seq === baseSeq + index),
      'C-SEQ: seq is dense, gap-free and monotonic'
    );
    assert(
      receipts.every((receipt) => receipt.duplicate === false),
      'C-SEQ: fresh appends are not duplicates'
    );
    const last = receipts[receipts.length - 1]!;
    const stats = await store.stats(id);
    assert(
      stats?.newestSeq === last.seq && stats?.newestStepId === last.stepId,
      'C-SEQ: stats matches the last receipt'
    );
    assert(
      stats?.stepCount === last.seq + 1,
      'C-SEQ: stepCount matches the dense seq space'
    );

    const before = await store.read({
      trajectoryId: id,
      fromSeq: 0,
      toSeq: 100,
    });
    await store.append({ trajectoryId: id, type: 'run', data: { tail: true } });
    const after = await store.read({
      trajectoryId: id,
      fromSeq: 0,
      toSeq: 100,
    });
    assert(
      before.length === after.length &&
        before.every(
          (step, index) => stepDigest(step) === stepDigest(after[index]!)
        ),
      'C-IMM: no append mutates any earlier step'
    );
    // I1 in the runtime, not only in the type system. A returned step is a
    // live reference into the store's own index; a reader that can rewrite
    // `source` -- the authority field self-trigger suppression keys on --
    // relabels the record for every later reader in the process. Re-reading
    // through the store is not enough on its own: it would compare the
    // mutated object with itself, so the original values are captured first.
    const immutable = before[0]!;
    const originalIndex = immutable.data.index;
    const originalSource = immutable.source;
    assert(Object.isFrozen(immutable), 'C-IMM: a returned step is frozen');
    assert(
      Object.isFrozen(immutable.data),
      "C-IMM: a returned step's data is frozen"
    );
    try {
      (immutable.data as Record<string, unknown>).index = 'REWRITTEN';
      (immutable as { source?: string }).source = 'impostor';
    } catch {
      // Strict mode throws on a write to a frozen object. Either way, the
      // assertions below are what decide whether the store held.
    }
    const rewritten = (await store.getStep(id, immutable.stepId))!;
    assert(
      rewritten.data.index === originalIndex,
      'C-IMM: a write to a returned step never reaches the log'
    );
    assert(
      rewritten.source === originalSource,
      "C-IMM: a returned step's source cannot be rewritten in place"
    );

    // ---- C-ATOM ----------------------------------------------------------
    const atomicId = (await store.create({ slug: 'atomic' })).trajectoryId;
    const written = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.append({
          trajectoryId: atomicId,
          type: 'action',
          source: index % 2 === 0 ? 'writer-a' : 'writer-b',
          data: { index },
        })
      )
    );
    const atomicSteps = await store.read({
      trajectoryId: atomicId,
      fromSeq: 0,
      toSeq: 1_000,
    });
    const indexes = atomicSteps
      .filter((step) => step.type === 'action')
      .map((step) => step.data.index);
    assert(
      new Set(written.map((receipt) => receipt.seq)).size === 50,
      'C-ATOM: 50 interleaved appends take 50 distinct positions'
    );
    assert(
      new Set(indexes).size === 50 &&
        indexes.every((value) => typeof value === 'number'),
      'C-ATOM: every interleaved append is complete and readable'
    );
    assert(
      atomicSteps.every((step, position) => step.seq === position),
      'C-ATOM: no partial frame is visible to a reader'
    );

    // ---- C-BOUND ---------------------------------------------------------
    await expectReason(
      assert,
      store.read({ trajectoryId: id }),
      'unbounded_read',
      'C-BOUND'
    );
    const budgeted = await store.tailBackward({
      trajectoryId: id,
      limit: 5,
      types: ['nothing-matches'],
      maxScan: 7,
    });
    assert(
      budgeted.scanned <= 7 && budgeted.exhausted === false,
      'C-BOUND: tailBackward honours maxScan and reports exhausted:false'
    );
    const drained = await store.readFrom(undefined, id, { maxBytes: 1 });
    assert(
      drained.steps.length === 1 && drained.caughtUp === false,
      'C-BOUND: readFrom honours maxBytes and still makes progress'
    );
    await expectReason(
      assert,
      store.getSteps(
        id,
        Array.from({ length: 257 }, (_, index) => `id-${index}`)
      ),
      'too_many_ids',
      'C-BOUND'
    );

    // ---- C-TAIL ----------------------------------------------------------
    const tail = await store.tailBackward({
      trajectoryId: id,
      limit: 3,
      types: ['message'],
      maxScan: 1_000,
    });
    assert(
      tail.steps.length === 3 &&
        tail.steps.every((step) => step.type === 'message'),
      'C-TAIL: the filtered tail returns exactly the requested types'
    );
    assert(
      tail.steps[0]!.seq < tail.steps[1]!.seq &&
        tail.steps[1]!.seq < tail.steps[2]!.seq,
      'C-TAIL: the filtered tail is oldest-first'
    );
    assert(
      tail.steps[2]!.data.index === 90,
      'C-TAIL: the filtered tail ends on the newest match'
    );
    assert(
      tail.scanned > 3,
      'C-TAIL: scanning past machinery is reported in `scanned`'
    );

    // ---- C-BYID ----------------------------------------------------------
    const wanted = [receipts[7]!.stepId, receipts[42]!.stepId];
    const picked = await store.getSteps(id, wanted);
    assert(
      picked.length === 2 &&
        picked.every((step, i) => step.stepId === wanted[i]),
      'C-BYID: getSteps returns exactly the requested ids, in order'
    );
    assert(
      (await store.getStep(id, receipts[3]!.stepId))?.data.index === 3,
      'C-BYID: getStep resolves a cited id'
    );
    assert(
      (await store.getStep(id, 'no-such-step')) === undefined,
      'C-BYID: getStep of an unknown id is undefined'
    );
    assert(
      (await store.getSteps(id, ['no-such-step'])).length === 0,
      'C-BYID: getSteps returns a short array for unknown ids'
    );

    // ---- C-CURSOR --------------------------------------------------------
    const firstDrain = await store.readFrom(undefined, id, { maxSteps: 10 });
    assert(
      firstDrain.steps.length === 10 && firstDrain.steps[0]!.seq === 0,
      'C-CURSOR: an absent cursor starts at the head'
    );
    assert(
      typeof firstDrain.cursor.token === 'string',
      'C-CURSOR: cursorTokens produces an opaque resumable token'
    );
    const secondDrain = await store.readFrom(firstDrain.cursor, id, {
      maxSteps: 10,
    });
    assert(
      secondDrain.steps[0]!.seq === 10,
      'C-CURSOR: resuming yields exactly the steps after the cursor'
    );
    const peer = await createStore({ databaseKey: key });
    const reopened = await peer.store.readFrom(firstDrain.cursor, id, {
      maxSteps: 3,
    });
    assert(
      reopened.steps[0]!.seq === 10,
      'C-CURSOR: a token survives a reopen of the same store'
    );
    await expectReason(
      assert,
      store.readFrom({ trajectoryId: id, seq: 10_000 }, id, {}),
      'beyond_end',
      'C-CURSOR'
    );
    await expectReason(
      assert,
      store.readFrom(
        { trajectoryId: id, seq: 0, token: 'foreign-instance:0' },
        id,
        {}
      ),
      'identity_changed',
      'C-CURSOR'
    );

    // ---- C-CONSUMER ------------------------------------------------------
    assert(
      (await store.loadCursor('consumer-a', id)) === undefined,
      'C-CONSUMER: an unseen consumer has no cursor'
    );
    await store.saveCursor('consumer-a', firstDrain.cursor);
    await store.saveCursor('consumer-b', { trajectoryId: id, seq: 2 });
    assert(
      (await store.loadCursor('consumer-a', id))?.seq === 10,
      'C-CONSUMER: a saved cursor round-trips'
    );
    assert(
      (await store.loadCursor('consumer-b', id))?.seq === 2,
      'C-CONSUMER: advancing one consumer does not move another'
    );

    // ---- C-BLOB ----------------------------------------------------------
    const blobs = store.blobs!;
    const big = 'z'.repeat(1024 * 1024);
    const spilledReceipt = await store.append({
      trajectoryId: id,
      type: 'runtime-output',
      data: { stdout: big },
    });
    assert(
      spilledReceipt.spilled.includes('stdout'),
      'C-BLOB: a 1 MiB field spills'
    );
    const spilledStep = (await store.getStep(id, spilledReceipt.stepId))!;
    const ref = spilledStep.blobs?.[0];
    assert(
      ref?.bytes === big.length && ref?.truncated === true,
      'C-BLOB: the ref records the FULL byte count'
    );
    assert(
      (spilledStep.data.stdout as string).length < big.length,
      'C-BLOB: the inline head is truncated'
    );
    assert(
      Object.isFrozen(spilledStep.blobs) && Object.isFrozen(ref),
      'C-BLOB: the blob refs a step carries are frozen too (I1)'
    );
    const resolved = await axResolveTrajectoryStep(spilledStep, blobs);
    assert(
      resolved.data.stdout === big,
      'C-BLOB: the resolver returns the original bytes'
    );
    await expectReason(
      assert,
      blobs.get(ref!.ref, 'f'.repeat(64)),
      'digest_mismatch',
      'C-BLOB'
    );
    await expectReason(
      assert,
      blobs.get('blob-does-not-exist', ref!.digest),
      'missing',
      'C-BLOB'
    );

    // ---- C-ORDER (gated) -------------------------------------------------
    if (primary.failNextBlobWrite) {
      const beforeOrder = await store.stats(id);
      primary.failNextBlobWrite();
      await expectReason(
        assert,
        store.append({
          trajectoryId: id,
          stepId: 'order-probe',
          type: 'runtime-output',
          data: { stdout: big },
        }),
        'blob_write_failed',
        'C-ORDER'
      );
      const afterOrder = await store.stats(id);
      assert(
        afterOrder?.newestSeq === beforeOrder?.newestSeq,
        'C-ORDER: a failed blob write leaves stats unchanged'
      );
      assert(
        (await store.getStep(id, 'order-probe')) === undefined,
        'C-ORDER: blob durability precedes step visibility'
      );
    }

    // ---- C-SOURCE / C-OPEN ----------------------------------------------
    await expectReason(
      assert,
      store.append({
        trajectoryId: id,
        type: 'reply-claim',
        source: 'thinker',
      }),
      'source_on_machinery_step',
      'C-SOURCE'
    );
    const openReceipt = await store.append({
      trajectoryId: id,
      type: 'host.future-type',
      data: { nested: { list: [1, 'two', true, null] } },
    });
    const openStep = (await store.getStep(id, openReceipt.stepId))!;
    assert(
      openStep.type === 'host.future-type',
      'C-OPEN: an unregistered type round-trips'
    );
    assert(
      axEventCanonicalJson(openStep.data) ===
        axEventCanonicalJson({ nested: { list: [1, 'two', true, null] } }),
      'C-OPEN: an unregistered type keeps its payload intact'
    );

    // ---- C-FORK ----------------------------------------------------------
    const forked = await store.fork({ parentTrajectoryId: id });
    const forkStep = await store.getStep(id, forked.forkStepId);
    assert(
      forkStep?.data.childTrajectoryId === forked.childTrajectoryId,
      'C-FORK: the parent references the child'
    );
    const child = await store.getTrajectory(forked.childTrajectoryId);
    assert(
      child?.parentTrajectoryId === id &&
        child?.parentStepId === forked.forkStepId,
      'C-FORK: the child references the parent'
    );
    assert(child?.depth === 1, 'C-FORK: the child records its depth');
    const merged = await store.merge({
      parentTrajectoryId: id,
      childTrajectoryId: forked.childTrajectoryId,
      content: '(max turns reached)',
      outcome: 'failed',
    });
    const mergeStep = (await store.getStep(id, merged.stepId))!;
    assert(
      mergeStep.data.outcome === 'failed',
      'C-FORK: a failed sub-run merges back too'
    );
    assert(
      mergeStep.source === undefined,
      'C-FORK: a merge step carries no source'
    );

    // ---- C-CLOCK ---------------------------------------------------------
    const beforeClock = await store.append({
      trajectoryId: id,
      type: 'thought',
      source: 'clock-probe',
    });
    assert(
      beforeClock.ts === clock.now(),
      'C-CLOCK: ts comes from the injected clock'
    );
    clock.advanceBy(1_234);
    const afterClock = await store.append({
      trajectoryId: id,
      type: 'thought',
      source: 'clock-probe',
    });
    assert(
      afterClock.ts === beforeClock.ts + 1_234,
      'C-CLOCK: advanceBy moves the appended ts'
    );
    assert(
      (await store.getStep(id, beforeClock.stepId))?.ts === beforeClock.ts,
      'C-CLOCK: advancing the clock changes nothing already written'
    );

    // ---- C-CORRUPT (gated) -----------------------------------------------
    if (primary.corruptTrailingFrame) {
      const cid = (await store.create({ slug: 'corrupt' })).trajectoryId;
      const intact = await store.append({
        trajectoryId: cid,
        type: 'run',
        data: { intact: true },
      });
      await primary.corruptTrailingFrame(cid);
      const torn = await store.readFrom(undefined, cid, {});
      assert(torn.corrupt >= 1, 'C-CORRUPT: a torn trailing frame is counted');
      assert(
        torn.steps[torn.steps.length - 1]?.stepId === intact.stepId,
        'C-CORRUPT: the record before the torn frame is returned intact'
      );
      assert(
        (await store.stats(cid))?.newestStepId === intact.stepId,
        'C-CORRUPT: stats returns the last complete frame'
      );
    }

    // ---- C-ABORT ---------------------------------------------------------
    const counting = countingSignal();
    for (let index = 0; index < 5; index++) {
      await store.append(
        { trajectoryId: id, type: 'run', data: { index } },
        counting.signal
      );
      await store.readFrom(undefined, id, { maxSteps: 2 }, counting.signal);
      await store.tailBackward({ trajectoryId: id, limit: 1 }, counting.signal);
    }
    assert(
      counting.listeners() === 0,
      'C-ABORT: resolved calls leave no abort listener behind'
    );
    const controller = new AbortController();
    const aborted = controller.signal;
    controller.abort(new Error('conformance abort'));
    const abortable: Readonly<{
      label: string;
      work: () => Promise<unknown>;
    }>[] = [
      {
        label: 'append',
        work: () => store.append({ trajectoryId: id, type: 'run' }, aborted),
      },
      {
        label: 'read',
        work: () => store.read({ trajectoryId: id, limit: 1 }, aborted),
      },
      {
        label: 'tailBackward',
        work: () => store.tailBackward({ trajectoryId: id, limit: 1 }, aborted),
      },
      { label: 'getStep', work: () => store.getStep(id, 'x', aborted) },
      {
        label: 'readFrom',
        work: () => store.readFrom(undefined, id, {}, aborted),
      },
      { label: 'stats', work: () => store.stats(id, aborted) },
      {
        label: 'loadCursor',
        work: () => store.loadCursor('consumer-a', id, aborted),
      },
    ];
    for (const { label, work } of abortable) {
      let rejected = false;
      try {
        await work();
      } catch {
        rejected = true;
      }
      assert(
        rejected,
        `C-ABORT: ${label} rejects on an already-aborted signal`
      );
    }

    let closeThrew = false;
    try {
      await peer.store.close?.();
      await store.close?.();
      await store.close?.();
    } catch {
      closeThrew = true;
    }
    assert(!closeThrew, 'C-ABORT: close is idempotent');

    return { assertions, capability: caps };
  } finally {
    await store.close?.();
  }
}
