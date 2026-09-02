import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AxInMemoryTrajectoryRollupStore,
  AxInMemoryTrajectoryStore,
  AxManualEventClock,
  type AxTrajectoryCursor,
  type AxTrajectoryDrainResult,
  type AxTrajectoryHeader,
  type AxTrajectoryReadQuery,
  type AxTrajectoryRollupStore,
  type AxTrajectoryStats,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryStoreCapabilities,
  type AxTrajectorySummarizer,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTailResult,
  axBuildTrajectoryRollups,
  axDeterministicTrajectorySummarizer,
  axProjectTrajectory,
  axResolveTrajectoryCitations,
  axTrajectoryContextBudget,
  axTrajectoryRecentSize,
} from '../src/ax/index.js';

/**
 * Repeated verbatim in the PR body and in this script's own output. Saying it
 * once, in the artifact itself, is the only version that survives being quoted
 * out of context.
 */
export const AX_TRAJECTORY_PROJECTION_HONESTY =
  'This is a deterministic zero-cost mechanism evaluation with fault injection. It is bounded machinery evidence -- projection shape and size, coverage, chronology, and drill-down resolution. It is not a held-out model comparison. It says nothing about whether the mind thinks well, chooses good routes, or writes useful memories, and no claim of that kind is made.';

const FANOUT = 10;
/** Host-supplied, never inferred from a model name (RFC 4.8). */
const CONTEXT_WINDOW_TOKENS = 200_000;
const BUDGET_TOKENS = axTrajectoryContextBudget({
  contextWindowTokens: CONTEXT_WINDOW_TOKENS,
});
const CHARS_PER_TOKEN = 4;

/**
 * A read-only generated log. Raw seq 0 is the structural header, then the
 * pattern repeats [machinery, narrative], so the filtered index and the raw
 * seq are deliberately different numbers and a projection that confuses them
 * mis-cites here rather than in a host's real log. It exists because 1e6 real
 * appends into the reference store is 500 MB of frozen objects; the two small
 * sizes are ALSO run through the real store and the rows are compared, so the
 * generator cannot quietly disagree with the implementation it stands in for.
 */
class SyntheticTrajectoryStore implements AxTrajectoryStore {
  readonly capabilities: Readonly<AxTrajectoryStoreCapabilities> = {
    durability: 'volatile',
    coordination: 'single-writer',
    appendAtomicity: true,
    blobs: false,
    cursorTokens: false,
    consumerCursors: false,
  };
  readonly clock = new AxManualEventClock(1_000);
  readonly trajectoryId = 'synthetic';
  constructor(readonly narrativeSteps: number) {}

  get stepCount(): number {
    return 1 + 2 * this.narrativeSteps;
  }

  /** Filtered index -> raw seq. Inverse of `indexOf`. */
  seqOfIndex(index: number): number {
    return 2 * index + 2;
  }

  indexOf(stepId: string): number | undefined {
    const seq = Number(stepId.slice(1));
    if (!Number.isInteger(seq) || seq < 2 || seq % 2 !== 0) return undefined;
    return (seq - 2) / 2;
  }

  private at(seq: number): Readonly<AxTrajectoryStep> {
    if (seq === 0) {
      return {
        stepId: 's0',
        trajectoryId: this.trajectoryId,
        seq: 0,
        type: 'trajectory',
        ts: 1_000,
        data: { slug: 'synthetic' },
      };
    }
    const narrative = seq % 2 === 0;
    const index = narrative ? (seq - 2) / 2 : (seq - 1) / 2;
    return {
      stepId: `s${seq}`,
      trajectoryId: this.trajectoryId,
      seq,
      type: narrative ? 'thought' : 'run',
      ts: 1_000 + seq,
      ...(narrative ? { source: 'agent' } : {}),
      data: narrative
        ? { content: `thought ${index}` }
        : { command: `machinery ${index}` },
    };
  }

  private matches(
    step: Readonly<AxTrajectoryStep>,
    types: readonly string[] | undefined
  ): boolean {
    return !types || types.includes(step.type);
  }

  async create(): Promise<Readonly<AxTrajectoryHeader>> {
    throw new Error('the synthetic log is read-only');
  }
  async append(): Promise<never> {
    throw new Error('the synthetic log is read-only');
  }
  async fork(): Promise<never> {
    throw new Error('the synthetic log is read-only');
  }
  async merge(): Promise<never> {
    throw new Error('the synthetic log is read-only');
  }
  async getTrajectory(): Promise<Readonly<AxTrajectoryHeader> | undefined> {
    return {
      trajectoryId: this.trajectoryId,
      createdAt: 1_000,
      depth: 0,
    };
  }
  async read(
    query: Readonly<AxTrajectoryReadQuery>
  ): Promise<readonly Readonly<AxTrajectoryStep>[]> {
    const from = Math.max(0, query.fromSeq ?? 0);
    const to = Math.min(this.stepCount, query.toSeq ?? this.stepCount);
    const out: Readonly<AxTrajectoryStep>[] = [];
    for (let seq = from; seq < to; seq += 1) {
      const step = this.at(seq);
      if (!this.matches(step, query.types)) continue;
      out.push(step);
      if (query.limit !== undefined && out.length >= query.limit) break;
    }
    return out;
  }
  async tailBackward(
    query: Readonly<AxTrajectoryTailQuery>
  ): Promise<Readonly<AxTrajectoryTailResult>> {
    const maxScan = query.maxScan ?? Math.max(200, 20 * query.limit);
    let cursor = Math.min(query.beforeSeq ?? this.stepCount, this.stepCount);
    let scanned = 0;
    const found: Readonly<AxTrajectoryStep>[] = [];
    while (found.length < query.limit && scanned < maxScan && cursor > 0) {
      cursor -= 1;
      scanned += 1;
      const step = this.at(cursor);
      if (this.matches(step, query.types)) found.push(step);
    }
    return { steps: found.reverse(), scanned, exhausted: cursor === 0 };
  }
  async getStep(
    _trajectoryId: string,
    stepId: string
  ): Promise<Readonly<AxTrajectoryStep> | undefined> {
    const seq = Number(stepId.slice(1));
    if (!Number.isInteger(seq) || seq < 0 || seq >= this.stepCount) {
      return undefined;
    }
    return this.at(seq);
  }
  async getSteps(
    trajectoryId: string,
    stepIds: readonly string[]
  ): Promise<readonly Readonly<AxTrajectoryStep>[]> {
    const out: Readonly<AxTrajectoryStep>[] = [];
    for (const stepId of stepIds) {
      const step = await this.getStep(trajectoryId, stepId);
      if (step) out.push(step);
    }
    return out;
  }
  async readFrom(
    cursor: Readonly<AxTrajectoryCursor> | undefined
  ): Promise<Readonly<AxTrajectoryDrainResult>> {
    return {
      steps: [],
      cursor: cursor ?? {
        trajectoryId: this.trajectoryId,
        seq: this.stepCount,
      },
      caughtUp: true,
      corrupt: 0,
    };
  }
  async stats(): Promise<Readonly<AxTrajectoryStats> | undefined> {
    const newest = this.at(this.stepCount - 1);
    return {
      trajectoryId: this.trajectoryId,
      stepCount: this.stepCount,
      newestSeq: newest.seq,
      newestTs: newest.ts,
      newestStepId: newest.stepId,
      newestByClass: {},
    };
  }
  async loadCursor(): Promise<undefined> {
    return undefined;
  }
  async saveCursor(): Promise<void> {}
}

interface Fixture {
  readonly label: string;
  readonly store: AxTrajectoryStore;
  readonly trajectoryId: string;
  readonly narrativeSteps: number;
  indexOf(stepId: string): number | undefined;
}

async function memoryFixture(narrativeSteps: number): Promise<Fixture> {
  const store = new AxInMemoryTrajectoryStore({
    clock: new AxManualEventClock(1_000),
  });
  const { trajectoryId } = await store.create({});
  const index = new Map<string, number>();
  for (let at = 0; at < narrativeSteps; at += 1) {
    await store.append({
      trajectoryId,
      type: 'run',
      data: { command: `machinery ${at}` },
    });
    const receipt = await store.append({
      trajectoryId,
      type: 'thought',
      source: 'agent',
      data: { content: `thought ${at}` },
    });
    index.set(receipt.stepId, at);
  }
  return {
    label: 'memory',
    store,
    trajectoryId,
    narrativeSteps,
    indexOf: (stepId) => index.get(stepId),
  };
}

function syntheticFixture(narrativeSteps: number): Fixture {
  const store = new SyntheticTrajectoryStore(narrativeSteps);
  return {
    label: 'synthetic',
    store,
    trajectoryId: store.trajectoryId,
    narrativeSteps,
    indexOf: (stepId) => store.indexOf(stepId),
  };
}

/** The declared baseline: replaying every filtered step verbatim. */
async function rawReplayChars(fixture: Fixture): Promise<number> {
  const stats = await fixture.store.stats(fixture.trajectoryId);
  const end = stats?.stepCount ?? 0;
  let chars = 0;
  for (let seq = 0; seq < end; seq += 1_024) {
    const steps = await fixture.store.read({
      trajectoryId: fixture.trajectoryId,
      fromSeq: seq,
      toSeq: Math.min(end, seq + 1_024),
      types: ['thought'],
    });
    for (const step of steps) {
      const content = step.data.content;
      chars +=
        `[${step.seq} ${step.type}] content=${String(content)}`.length + 1;
    }
  }
  return chars;
}

export interface AxTrajectoryProjectionRow {
  readonly label: string;
  readonly store: string;
  readonly narrativeSteps: number;
  readonly summarizer: string;
  readonly fanout: number;
  readonly budgetTokens: number;
  readonly recentSize: number;
  readonly filteredSteps: number;
  readonly blocksSealed: number;
  readonly lifeSections: number;
  readonly recentSteps: number;
  readonly sectionBound: number;
  /** Filtered steps a section accounts for, over the filtered count. */
  readonly coverage: number;
  /**
   * Cited ids that actually resolve, over cited ids. Reported BESIDE coverage
   * because a hollow summarizer scores 1.0 on coverage alone.
   */
  readonly drillDownResolved: number;
  readonly citedIds: number;
  /** Cited ids outside the citing block's own index range. */
  readonly citationsOutOfRange: number;
  readonly chronologyInversions: number;
  readonly projectionChars: number;
  readonly projectionTokens: number;
  readonly rawReplayChars: number;
  readonly rawReplayTokens: number;
  readonly compression: number;
  /** Recent steps still returned after every rollup block is deleted. */
  readonly degradedRecentSteps: number;
  readonly buildMs: number;
  readonly projectMs: number;
}

interface HollowOptions {
  /** Seal blocks directly, citing ids that do not exist. */
  readonly hollow?: boolean;
}

async function measure(
  fixture: Fixture,
  options?: Readonly<HollowOptions>
): Promise<AxTrajectoryProjectionRow> {
  const rollups = new AxInMemoryTrajectoryRollupStore();
  const summarizer: AxTrajectorySummarizer =
    axDeterministicTrajectorySummarizer();
  const recentSize = axTrajectoryRecentSize(BUDGET_TOKENS);
  let blocksSealed = 0;
  const buildStart = performance.now();
  if (options?.hollow) {
    blocksSealed = await sealHollowBlocks(
      fixture,
      rollups,
      recentSize,
      summarizer.id
    );
  } else {
    for (let round = 0; round < 64; round += 1) {
      const result = await axBuildTrajectoryRollups({
        trajectoryId: fixture.trajectoryId,
        store: fixture.store,
        rollups,
        summarizer,
        backfill: true,
        maxBlocks: 4_000_000,
        fanout: FANOUT,
      });
      blocksSealed += result.sealed;
      if (result.sealed === 0) break;
    }
  }
  const buildMs = performance.now() - buildStart;

  const projectStart = performance.now();
  const projection = await axProjectTrajectory({
    trajectoryId: fixture.trajectoryId,
    store: fixture.store,
    rollups,
    fanout: FANOUT,
    budgetTokens: BUDGET_TOKENS,
  });
  const projectMs = performance.now() - projectStart;

  const filtered = projection.coverage.toIndex;
  const gapSteps = projection.coverage.gaps.reduce(
    (total, gap) => total + (gap.to - gap.from),
    0
  );
  const covered = filtered - gapSteps;

  let citedIds = 0;
  let citationsOutOfRange = 0;
  for (const section of projection.life) {
    if (section.kind !== 'summary') continue;
    for (const stepId of section.block.stepIds) {
      citedIds += 1;
      const at = fixture.indexOf(stepId);
      if (
        at === undefined ||
        at < section.block.start ||
        at >= section.block.end
      ) {
        citationsOutOfRange += 1;
      }
    }
  }
  const resolved = await axResolveTrajectoryCitations(
    fixture.store,
    fixture.trajectoryId,
    projection.citableStepIds
  );

  // Chronology: contiguous ascending sections, then a raw tail that starts
  // exactly where the last section ended and never goes backwards.
  let inversions = 0;
  let cursor = 0;
  for (const section of projection.life) {
    const start =
      section.kind === 'summary' ? section.block.start : section.start;
    const end = section.kind === 'summary' ? section.block.end : section.end;
    if (start !== cursor) inversions += 1;
    cursor = end;
  }
  const firstRecent = projection.recent[0];
  if (firstRecent && fixture.indexOf(firstRecent.stepId) !== cursor) {
    inversions += 1;
  }
  for (let at = 1; at < projection.recent.length; at += 1) {
    const previous = projection.recent[at - 1];
    const current = projection.recent[at];
    if (previous && current && current.seq <= previous.seq) inversions += 1;
  }

  rollups.deleteBlocks();
  const degraded = await axProjectTrajectory({
    trajectoryId: fixture.trajectoryId,
    store: fixture.store,
    rollups,
    fanout: FANOUT,
    budgetTokens: BUDGET_TOKENS,
  });

  const rawChars = await rawReplayChars(fixture);
  const bound =
    filtered > 0
      ? FANOUT * Math.max(1, Math.ceil(Math.log(filtered) / Math.log(FANOUT)))
      : 0;
  return {
    label: `${fixture.narrativeSteps} steps`,
    store: fixture.label,
    narrativeSteps: fixture.narrativeSteps,
    summarizer: options?.hollow ? 'hollow-blocks' : summarizer.id,
    fanout: FANOUT,
    budgetTokens: BUDGET_TOKENS,
    recentSize,
    filteredSteps: filtered,
    blocksSealed,
    lifeSections: projection.life.length,
    recentSteps: projection.recent.length,
    sectionBound: bound,
    coverage: filtered === 0 ? 1 : covered / filtered,
    drillDownResolved:
      projection.citableStepIds.length === 0
        ? 0
        : resolved.length / projection.citableStepIds.length,
    citedIds,
    citationsOutOfRange,
    chronologyInversions: inversions,
    projectionChars: projection.render.length,
    projectionTokens: projection.estimatedTokens,
    rawReplayChars: rawChars,
    rawReplayTokens: Math.ceil(rawChars / CHARS_PER_TOKEN),
    compression:
      projection.estimatedTokens === 0
        ? 0
        : Math.ceil(rawChars / CHARS_PER_TOKEN) / projection.estimatedTokens,
    degradedRecentSteps: degraded.recent.length,
    buildMs: Math.round(buildMs),
    projectMs: Math.round(projectMs),
  };
}

/**
 * The Goodhart control: blocks sealed by something that never read the log.
 * Coverage is still total, because coverage only asks whether a section
 * claims the range. Only the drill-down rate notices.
 */
async function sealHollowBlocks(
  fixture: Fixture,
  rollups: AxTrajectoryRollupStore,
  _recentSize: number,
  summarizerId: string
): Promise<number> {
  const total = fixture.narrativeSteps;
  const stats = await fixture.store.stats(fixture.trajectoryId);
  await rollups.saveMeta(fixture.trajectoryId, {
    version: 1,
    fanout: FANOUT,
    startIndex: 0,
    types: ['thought', 'action', 'observation', 'idle', 'message', 'error'],
    sealedIndex: Math.floor(total / FANOUT) * FANOUT,
    sealedSeq: stats?.stepCount ?? 0,
  });
  let sealed = 0;
  for (let tier = 1; FANOUT ** tier <= total; tier += 1) {
    const size = FANOUT ** tier;
    for (let start = 0; start + size <= total; start += size) {
      await rollups.putBlock(fixture.trajectoryId, {
        tier,
        start,
        end: start + size,
        n: size,
        summary: 'I did a great deal of important work.',
        themes: ['work'],
        stepIds: [`fabricated-${tier}-${start}`],
        summarizerId,
        promptVersion: '1',
        createdAt: 1_000,
      });
      sealed += 1;
    }
  }
  return sealed;
}

export interface AxTrajectoryProjectionReport {
  readonly honesty: string;
  readonly claim: string;
  readonly baseline: string;
  readonly budget: Readonly<{
    providerCalls: number;
    tokens: number;
    usd: number;
    wallClockMs: number;
  }>;
  readonly rows: readonly AxTrajectoryProjectionRow[];
}

export async function runTrajectoryProjectionEvaluation(): Promise<
  Readonly<AxTrajectoryProjectionReport>
> {
  const started = performance.now();
  const rows: AxTrajectoryProjectionRow[] = [];
  // The two small sizes run on BOTH the reference store and the generator, so
  // the generator is checked against the implementation it stands in for.
  rows.push(await measure(await memoryFixture(10)));
  rows.push(await measure(syntheticFixture(10)));
  rows.push(await measure(await memoryFixture(1_000)));
  rows.push(await measure(syntheticFixture(1_000)));
  rows.push(await measure(syntheticFixture(100_000)));
  rows.push(await measure(syntheticFixture(1_000_000)));
  // The counter-metric's control.
  rows.push(await measure(syntheticFixture(1_000), { hollow: true }));
  return {
    honesty: AX_TRAJECTORY_PROJECTION_HONESTY,
    claim:
      'The trajectory projection is total (every filtered step is accounted for by a section) and logarithmic (life sections stay under F * ceil(log_F N)), it preserves chronology, and every id it cites resolves inside the block that cited it.',
    baseline:
      'Full raw replay of the same log: every filtered step rendered verbatim, measured with the same formatter.',
    budget: {
      providerCalls: 0,
      tokens: 0,
      usd: 0,
      wallClockMs: Math.round(performance.now() - started),
    },
    rows,
  };
}

function fail(message: string): never {
  throw new Error(`trajectory projection evaluation failed: ${message}`);
}

export function assertTrajectoryProjectionEvaluation(
  report: Readonly<AxTrajectoryProjectionReport>
): void {
  if (report.honesty !== AX_TRAJECTORY_PROJECTION_HONESTY) {
    fail('the honesty clause was edited or dropped');
  }
  if (report.budget.providerCalls !== 0 || report.budget.tokens !== 0) {
    fail('the evaluation is supposed to make zero provider calls');
  }
  const real = report.rows.filter((row) => row.summarizer !== 'hollow-blocks');
  const sizes = new Set(real.map((row) => row.narrativeSteps));
  for (const size of [10, 1_000, 100_000, 1_000_000]) {
    if (!sizes.has(size)) fail(`no row at ${size} filtered steps`);
  }
  for (const row of real) {
    const at = `${row.store}/${row.narrativeSteps}`;
    if (row.filteredSteps !== row.narrativeSteps) {
      fail(
        `${at}: counted ${row.filteredSteps} filtered steps, not ${row.narrativeSteps}`
      );
    }
    if (row.coverage !== 1) fail(`${at}: coverage is ${row.coverage}, not 1.0`);
    if (row.drillDownResolved !== 1) {
      fail(`${at}: drill-down resolved ${row.drillDownResolved}, not 1.0`);
    }
    if (row.citationsOutOfRange !== 0) {
      fail(
        `${at}: ${row.citationsOutOfRange} cited ids fall outside their block`
      );
    }
    if (row.chronologyInversions !== 0) {
      fail(`${at}: ${row.chronologyInversions} chronology inversions`);
    }
    // Two-sided: coverage of 1.0 is also satisfiable by citing nothing at all.
    // A log shorter than R has no summaries to cite from -- it is all raw.
    if (row.lifeSections > 0 && row.citedIds <= 0) {
      fail(`${at}: sections were emitted but nothing was cited`);
    }
    if (row.lifeSections > row.sectionBound) {
      fail(
        `${at}: ${row.lifeSections} life sections exceed the bound ${row.sectionBound}`
      );
    }
    // Two-sided: a ceiling is also satisfied by emitting nothing.
    if (row.narrativeSteps > row.recentSize) {
      if (row.lifeSections <= 0) {
        fail(`${at}: a log longer than the raw tail emitted no life section`);
      }
      if (row.blocksSealed <= 0) fail(`${at}: no rollup block was sealed`);
    }
    if (row.recentSteps < Math.min(row.narrativeSteps, row.recentSize)) {
      fail(`${at}: the raw tail is shorter than R`);
    }
    // Tiers are an optimization, not a dependency.
    if (row.degradedRecentSteps !== row.recentSteps) {
      fail(`${at}: deleting every rollup changed the raw tail`);
    }
  }
  // The comparison has to mean something: at 1e5 and above, replaying the log
  // raw does not fit the budget the projection is built for.
  for (const row of real.filter((entry) => entry.narrativeSteps >= 100_000)) {
    if (row.rawReplayTokens <= row.budgetTokens) {
      fail(
        `${row.store}/${row.narrativeSteps}: the raw baseline already fits the budget`
      );
    }
    if (row.compression <= 10) {
      fail(
        `${row.store}/${row.narrativeSteps}: compression is only ${row.compression}`
      );
    }
  }
  // The generator must agree with the reference store it stands in for.
  for (const size of [10, 1_000]) {
    const memory = real.find(
      (row) => row.narrativeSteps === size && row.store === 'memory'
    );
    const synthetic = real.find(
      (row) => row.narrativeSteps === size && row.store === 'synthetic'
    );
    if (!memory || !synthetic) fail(`missing a paired row at ${size}`);
    if (
      memory.lifeSections !== synthetic.lifeSections ||
      memory.recentSteps !== synthetic.recentSteps ||
      memory.blocksSealed !== synthetic.blocksSealed ||
      memory.citedIds !== synthetic.citedIds
    ) {
      fail(`the synthetic store disagrees with the reference store at ${size}`);
    }
  }
  // The Goodhart control: coverage alone cannot tell a real index from a
  // fabricated one, and the paired metric must actually notice.
  const hollow = report.rows.find((row) => row.summarizer === 'hollow-blocks');
  if (!hollow) fail('the hollow-block control row is missing');
  if (hollow.coverage !== 1) {
    fail('the control no longer demonstrates that coverage alone is gameable');
  }
  if (hollow.drillDownResolved >= 1) {
    fail('drill-down resolution did not catch fabricated citations');
  }
  if (hollow.citationsOutOfRange <= 0) {
    fail('the range check did not catch fabricated citations');
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const report = await runTrajectoryProjectionEvaluation();
  assertTrajectoryProjectionEvaluation(report);
  process.stdout.write(
    `${JSON.stringify(
      { command: 'npm run trajectory:projection:eval', ...report },
      null,
      2
    )}\n`
  );
}
