import { axTrajectoryTypeRegistry } from './registry.js';
import type {
  AxTrajectoryRollupBlock,
  AxTrajectoryRollupMeta,
  AxTrajectoryRollupStore,
} from './rollups.js';
import { axResolveTrajectorySteps } from './spill.js';
import {
  AxTrajectoryQueryError,
  AxTrajectoryRollupError,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryTypeRegistry,
  axTrajectoryMaxStepIds,
} from './types.js';
import { positiveOr } from './util.js';

/** Documented knob #1. A block at tier k covers fanout^k filtered steps. */
export const axTrajectoryDefaultFanout = 10;
/** Documented knob #2. See `axTrajectoryContextBudget`. */
export const axTrajectoryDefaultBudgetTokens = 4_000;
/** Derived: the rendered cost of one raw narrative step. Escape hatch only. */
export const axTrajectoryTokensPerStep = 40;
/** Derived floor for R. Below this a "recent stream" stops being one. */
export const axTrajectoryMinRecentSteps = 20;
/** Derived: raw steps examined per forward-scan page. Escape hatch only. */
export const axTrajectoryScanPageSteps = 512;

const CHARS_PER_TOKEN = 4;

/**
 * budget = min(fraction * window, maxTokens). A bigger window is not
 * permission to spend it. `contextWindowTokens` is host-supplied and is NEVER
 * inferred from a model name. A non-finite or non-positive window yields 0:
 * an unknown window buys no budget rather than a default one.
 */
export interface AxTrajectoryContextBudgetOptions {
  readonly contextWindowTokens: number;
  /** Default 0.6. Clamped to (0, 1]. */
  readonly fraction?: number;
  /** Default 4000. The absolute cap. */
  readonly maxTokens?: number;
}

export function axTrajectoryContextBudget(
  options: Readonly<AxTrajectoryContextBudgetOptions>
): number {
  const window = Number.isFinite(options.contextWindowTokens)
    ? Math.max(0, options.contextWindowTokens)
    : 0;
  const raw = options.fraction ?? 0.6;
  const fraction = Number.isFinite(raw) && raw > 0 ? Math.min(1, raw) : 0.6;
  const cap = positiveOr(
    options.maxTokens ?? axTrajectoryDefaultBudgetTokens,
    axTrajectoryDefaultBudgetTokens
  );
  return Math.max(0, Math.min(Math.floor(fraction * window), Math.floor(cap)));
}

/**
 * R, derived rather than configured: max(20, floor(0.4 * budget / perStep)).
 * The raw tail is the part of the projection that is testimony rather than
 * summary, so it is sized from the budget and floored, never from a knob.
 */
export function axTrajectoryRecentSize(
  budgetTokens: number,
  tokensPerStep: number = axTrajectoryTokensPerStep
): number {
  const perStep = positiveOr(tokensPerStep, axTrajectoryTokensPerStep);
  const budget = Number.isFinite(budgetTokens) ? Math.max(0, budgetTokens) : 0;
  return Math.max(
    axTrajectoryMinRecentSteps,
    Math.floor((0.4 * budget) / perStep)
  );
}

export interface AxTrajectoryProjectionOptions {
  readonly trajectoryId: string;
  readonly store: AxTrajectoryStore;
  readonly rollups?: AxTrajectoryRollupStore;
  readonly registry?: AxTrajectoryTypeRegistry;
  /** Defaults to every 'narrative' type in the registry. Never machinery. */
  readonly types?: readonly string[];
  /** Documented knob #1. Default 10. */
  readonly fanout?: number;
  /** Documented knob #2. Default 4000. */
  readonly budgetTokens?: number;
  readonly signal?: AbortSignal;
  /** Derived escape hatch: R. */
  readonly recentSteps?: number;
  /** Derived escape hatch: the R divisor. */
  readonly tokensPerStep?: number;
  /** Derived escape hatch: raw steps per forward-scan page. */
  readonly scanPageSteps?: number;
  /** Derived escape hatch: N, for a host that already tracks the count. */
  readonly filteredCount?: number;
}

export type AxTrajectoryProjectionSection =
  | Readonly<{ kind: 'summary'; block: Readonly<AxTrajectoryRollupBlock> }>
  | Readonly<{
      kind: 'gap';
      start: number;
      end: number;
      reason: 'pre-enable' | 'missing';
    }>;

export interface AxTrajectoryProjection {
  /** Coarse to fine, oldest first. Chronological under straddle descent. */
  readonly life: readonly AxTrajectoryProjectionSection[];
  /** Verbatim raw tail, oldest first, spilled fields already rehydrated. */
  readonly recent: readonly Readonly<AxTrajectoryStep>[];
  readonly render: string;
  readonly coverage: Readonly<{
    fromIndex: number;
    toIndex: number;
    gaps: readonly Readonly<{ from: number; to: number }>[];
  }>;
  readonly estimatedTokens: number;
  readonly citableStepIds: readonly string[];
}

interface AxTrajectorySegment {
  readonly tier: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Positional decomposition of [0, cut0) in base `fanout`, emitted in ASCENDING
 * start order. Ascending start over a prefix decomposition IS "tiers
 * descending, blocks ascending within a tier" -- and it is chronological by
 * construction, so no later reverse can flip block order inside a tier.
 */
function decompose(cut0: number, fanout: number): AxTrajectorySegment[] {
  const out: AxTrajectorySegment[] = [];
  let pos = 0;
  while (pos < cut0) {
    let tier = 1;
    let size = fanout;
    while (pos % (size * fanout) === 0 && pos + size * fanout <= cut0) {
      size *= fanout;
      tier += 1;
    }
    out.push({ tier, start: pos, end: pos + size });
    pos += size;
  }
  return out;
}

function pushGap(
  out: AxTrajectoryProjectionSection[],
  start: number,
  end: number,
  reason: 'pre-enable' | 'missing'
): void {
  const previous = out[out.length - 1];
  if (
    previous &&
    previous.kind === 'gap' &&
    previous.reason === reason &&
    previous.end === start
  ) {
    out[out.length - 1] = { kind: 'gap', start: previous.start, end, reason };
    return;
  }
  out.push({ kind: 'gap', start, end, reason });
}

interface AssembleContext {
  readonly trajectoryId: string;
  readonly rollups?: AxTrajectoryRollupStore;
  readonly fanout: number;
  readonly startIndex: number;
  readonly signal?: AbortSignal;
  /** Mutable descent budget. See `axTrajectoryDescentBudget`. */
  readonly budget: { left: number };
}

/**
 * Nodes the staircase may visit before the rest of the pyramid is reported as
 * one gap instead of probed. A missing COARSE block forks into F children, so
 * an unsealed or deleted subtree costs O(N / F) store round-trips per wake
 * without this -- measured at 1,104 `getBlock` calls to emit a single gap
 * section over a 10k-step log with its blocks dropped. F^2 per pyramid level
 * pays for a full straddle descent at every tier with room to spare, and the
 * healthy fully-sealed case costs one probe per section (~24 at 10k).
 */
export function axTrajectoryDescentBudget(
  cut0: number,
  fanout: number
): number {
  const depth = Math.max(
    1,
    Math.ceil(Math.log(Math.max(cut0, 1)) / Math.log(fanout))
  );
  return fanout * fanout * (depth + 1);
}

/** RFC 7.8, one row of the table per branch. */
async function assemble(
  segment: AxTrajectorySegment,
  context: Readonly<AssembleContext>,
  out: AxTrajectoryProjectionSection[]
): Promise<void> {
  context.signal?.throwIfAborted();
  // Prune BEFORE descent, and before the budget: without this the descent
  // forks once per node over the whole empty pre-enable tree on every single
  // call, and a free prune must never be starved by a paid one.
  if (segment.end <= context.startIndex) {
    pushGap(out, segment.start, segment.end, 'pre-enable');
    return;
  }
  if (context.budget.left <= 0) {
    pushGap(out, segment.start, segment.end, 'missing');
    return;
  }
  context.budget.left -= 1;
  const block = await context.rollups?.getBlock(
    context.trajectoryId,
    segment.tier,
    segment.start,
    context.signal
  );
  // All three coordinates, not just `end`: a block filed under the wrong key
  // by a buggy or hostile store port would otherwise print under a range it
  // does not cover, and the citation guard is keyed on that range.
  if (
    block &&
    block.tier === segment.tier &&
    block.start === segment.start &&
    block.end === segment.end
  ) {
    out.push({ kind: 'summary', block });
    return;
  }
  if (segment.tier > 1) {
    // Straddle descent. A missing COARSE block is expected when it straddles
    // the forward-only marker; skipping the segment would silently drop every
    // finer block that does exist the moment cut0 crosses an F^k boundary.
    const childSize = (segment.end - segment.start) / context.fanout;
    for (let index = 0; index < context.fanout; index += 1) {
      await assemble(
        {
          tier: segment.tier - 1,
          start: segment.start + index * childSize,
          end: segment.start + (index + 1) * childSize,
        },
        context,
        out
      );
    }
    return;
  }
  // Only a tier-1 miss is truly absent history.
  pushGap(
    out,
    segment.start,
    segment.end,
    segment.start < context.startIndex ? 'pre-enable' : 'missing'
  );
}

export function narrativeTypes(
  registry: AxTrajectoryTypeRegistry,
  requested: readonly string[] | undefined
): readonly string[] {
  const narrative = registry.types
    .filter((descriptor) => descriptor.stepClass === 'narrative')
    .map((descriptor) => descriptor.type);
  if (!requested) return narrative;
  const allowed = new Set(narrative);
  // A requested machinery or unknown type is dropped rather than honoured:
  // this is the NARRATIVE projection, and I6 is enforced here, not by
  // trusting every caller to pass the right list.
  const kept = requested.filter((type) => allowed.has(type));
  if (requested.length > 0 && kept.length === 0) {
    // Every store matcher reads [] as "matches nothing", so silently returning
    // it hands the caller an empty projection with `toIndex: 0` and no way to
    // tell that from an empty log.
    throw new AxTrajectoryQueryError(
      `no narrative type among [${requested.join(', ')}]`,
      'unsupported_types'
    );
  }
  return kept;
}

/**
 * The render is newline-delimited and its frames are what tell a summary from
 * testimony, so no single interpolated value may span lines. Applied per FIELD
 * as well as per line: a newline inside one field would otherwise split the
 * step's own frame.
 */
export function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n');
}

/** Never prints a spilled field's truncated head (invariant I7). */
export function stepText(step: Readonly<AxTrajectoryStep>): string {
  const unresolved = new Map(
    (step.blobs ?? []).map((ref) => [ref.field, ref] as const)
  );
  const parts: string[] = [];
  for (const [field, value] of Object.entries(step.data)) {
    const ref = unresolved.get(field);
    if (ref) {
      parts.push(
        `${field}=<unresolved ${ref.bytes}B ${ref.digest.slice(0, 12)}>`
      );
      continue;
    }
    parts.push(
      `${oneLine(field)}=${
        typeof value === 'string' ? oneLine(value) : JSON.stringify(value)
      }`
    );
  }
  return parts.join(' ');
}

function renderSections(
  life: readonly AxTrajectoryProjectionSection[],
  recent: readonly Readonly<AxTrajectoryStep>[],
  coverage: Readonly<{ fromIndex: number; toIndex: number }>
): string {
  const lines: string[] = [
    `# Life so far (filtered steps ${coverage.fromIndex}-${coverage.toIndex}, oldest first)`,
  ];
  if (life.length === 0) lines.push('(nothing summarized yet)');
  for (const section of life) {
    if (section.kind === 'gap') {
      lines.push(
        `[${section.start}-${section.end}] (${section.reason}: ${
          section.end - section.start
        } steps not summarized)`
      );
      continue;
    }
    const block = section.block;
    // `summary` and `themes` are model output. Unescaped, a summary carrying
    // the recent-stream header forges verbatim testimony inside the section
    // that exists to say "this is a pointer, not testimony".
    lines.push(`[${block.start}-${block.end}] ${oneLine(block.summary)}`);
    if (block.themes.length > 0) {
      lines.push(`  themes: ${block.themes.map(oneLine).join(', ')}`);
    }
  }
  lines.push('# Recent (verbatim, oldest first)');
  if (recent.length === 0) lines.push('(no recent steps)');
  for (const step of recent) {
    lines.push(`[${step.seq} ${step.type}] ${stepText(step)}`);
  }
  return lines.join('\n');
}

export function axRenderTrajectoryProjection(
  projection: Readonly<AxTrajectoryProjection>
): string {
  return renderSections(
    projection.life,
    projection.recent,
    projection.coverage
  );
}

/** Drill-down: coarse entries are pointers, not testimony. */
export async function axResolveTrajectoryCitations(
  store: AxTrajectoryStore,
  trajectoryId: string,
  stepIds: readonly string[],
  signal?: AbortSignal
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const out: Readonly<AxTrajectoryStep>[] = [];
  for (
    let offset = 0;
    offset < stepIds.length;
    offset += axTrajectoryMaxStepIds
  ) {
    signal?.throwIfAborted();
    const batch = stepIds.slice(offset, offset + axTrajectoryMaxStepIds);
    const steps = await store.getSteps(trajectoryId, batch, signal);
    out.push(
      ...(await axResolveTrajectorySteps(steps, store.blobs, { signal }))
    );
  }
  return out;
}

export interface ScanCursor {
  readonly index: number;
  readonly seq: number;
}

/**
 * Walks raw seq space forward in bounded pages, counting filtered steps. With
 * a rollup checkpoint this is O(unsealed tail); without one it is O(N), which
 * is what having no index costs and is documented rather than hidden.
 */
export async function scanForward(
  options: Readonly<AxTrajectoryProjectionOptions>,
  types: readonly string[],
  from: ScanCursor,
  endSeq: number,
  onPage?: (
    steps: readonly Readonly<AxTrajectoryStep>[],
    index: number
  ) => boolean | undefined
): Promise<ScanCursor> {
  // Clamped, not just floored: a page of 0 -- which every value in (0, 1)
  // floors to -- makes `to === seq`, so the cursor never advances and the loop
  // spins forever on already-resolved promises, which starves the event loop
  // so thoroughly that even the abort timer below can never be scheduled.
  const page = Math.max(
    1,
    Math.floor(
      positiveOr(options.scanPageSteps ?? axTrajectoryScanPageSteps, 512)
    )
  );
  let index = from.index;
  let seq = from.seq;
  while (seq < endSeq) {
    options.signal?.throwIfAborted();
    const to = Math.min(endSeq, seq + page);
    const steps = await options.store.read(
      { trajectoryId: options.trajectoryId, fromSeq: seq, toSeq: to, types },
      options.signal
    );
    const stop = onPage?.(steps, index) === true;
    index += steps.length;
    seq = to;
    // A visitor that has what it came for stops the walk: without this,
    // first-time enablement pays two FULL O(N) passes over the raw log.
    if (stop) break;
  }
  return { index, seq };
}

export async function endSeqOf(
  options: Readonly<AxTrajectoryProjectionOptions>
): Promise<number> {
  const stats = await options.store.stats(options.trajectoryId, options.signal);
  if (!stats) {
    throw new AxTrajectoryQueryError(
      `unknown trajectory "${options.trajectoryId}"`,
      'unknown_trajectory'
    );
  }
  return stats.stepCount;
}

export function checkMeta(
  meta: Readonly<AxTrajectoryRollupMeta>,
  fanout: number,
  types: readonly string[],
  endSeq: number
): void {
  // A checkpoint past the end of the log is a rollup store bound to a DIFFERENT
  // life: a fork, a restore from backup, or a rebuilt log under a reused id.
  // Trusting it makes the projection report history that was never lived --
  // `total` comes straight from `sealedIndex` when the scan has nothing to do.
  if (meta.sealedSeq > endSeq || meta.sealedIndex > endSeq) {
    throw new AxTrajectoryRollupError(
      `rollup meta is sealed to seq ${meta.sealedSeq} / index ${meta.sealedIndex}, past the log's ${endSeq} steps`,
      'meta_conflict'
    );
  }
  if (meta.fanout !== fanout) {
    throw new AxTrajectoryRollupError(
      `rollup meta was built with fanout ${meta.fanout}, not ${fanout}`,
      'meta_conflict'
    );
  }
  const stored = [...meta.types].sort().join(',');
  if (stored !== [...types].sort().join(',')) {
    throw new AxTrajectoryRollupError(
      'rollup meta was built over a different filtered type set',
      'meta_conflict'
    );
  }
}

export async function axProjectTrajectory(
  options: Readonly<AxTrajectoryProjectionOptions>
): Promise<Readonly<AxTrajectoryProjection>> {
  const registry = options.registry ?? axTrajectoryTypeRegistry();
  const types = narrativeTypes(registry, options.types);
  const fanout = Math.max(
    2,
    Math.floor(positiveOr(options.fanout ?? axTrajectoryDefaultFanout, 10))
  );
  const budgetTokens = Math.max(
    0,
    options.budgetTokens ?? axTrajectoryDefaultBudgetTokens
  );
  const recentSize = Math.max(
    1,
    Math.floor(
      options.recentSteps ??
        axTrajectoryRecentSize(budgetTokens, options.tokensPerStep)
    )
  );
  const endSeq = await endSeqOf(options);
  const meta = await options.rollups?.loadMeta(
    options.trajectoryId,
    options.signal
  );
  if (meta) checkMeta(meta, fanout, types, endSeq);

  const scanned =
    options.filteredCount !== undefined
      ? { index: Math.max(0, Math.floor(options.filteredCount)), seq: endSeq }
      : await scanForward(
          options,
          types,
          { index: meta?.sealedIndex ?? 0, seq: meta?.sealedSeq ?? 0 },
          endSeq
        );
  const total = scanned.index;
  const startIndex = meta?.startIndex ?? 0;
  const cut0 =
    total <= recentSize
      ? 0
      : Math.floor((total - recentSize) / fanout) * fanout;

  const context: AssembleContext = {
    trajectoryId: options.trajectoryId,
    ...(options.rollups ? { rollups: options.rollups } : {}),
    fanout,
    startIndex,
    ...(options.signal ? { signal: options.signal } : {}),
    budget: { left: axTrajectoryDescentBudget(cut0, fanout) },
  };
  const life: AxTrajectoryProjectionSection[] = [];
  for (const segment of decompose(cut0, fanout)) {
    await assemble(segment, context, life);
  }

  const tailLimit = total - cut0;
  const tail =
    tailLimit > 0
      ? await options.store.tailBackward(
          { trajectoryId: options.trajectoryId, limit: tailLimit, types },
          options.signal
        )
      : { steps: [], scanned: 0, exhausted: true };
  const recent = await axResolveTrajectorySteps(
    tail.steps,
    options.store.blobs,
    {
      signal: options.signal,
    }
  );
  // The tail scan is bounded, so it can come up short on a log that is mostly
  // machinery. That is reported as a gap, never papered over.
  if (recent.length < tailLimit) {
    pushGap(life, cut0, total - recent.length, 'missing');
  }

  const gaps: Readonly<{ from: number; to: number }>[] = [];
  for (const section of life) {
    if (section.kind === 'gap') {
      gaps.push({ from: section.start, to: section.end });
    }
  }
  const coverage = { fromIndex: 0, toIndex: total, gaps };
  const citable = new Set<string>();
  for (const section of life) {
    if (section.kind === 'summary') {
      for (const stepId of section.block.stepIds) citable.add(stepId);
    }
  }
  for (const step of recent) citable.add(step.stepId);
  const render = renderSections(life, recent, coverage);
  return Object.freeze({
    life: Object.freeze(life),
    recent: Object.freeze(recent),
    render,
    coverage: Object.freeze({ ...coverage, gaps: Object.freeze(gaps) }),
    estimatedTokens: Math.ceil(render.length / CHARS_PER_TOKEN),
    citableStepIds: Object.freeze([...citable]),
  });
}

/** The raw seq immediately after filtered index `target`. */
export async function seqAtIndex(
  options: Readonly<AxTrajectoryProjectionOptions>,
  types: readonly string[],
  endSeq: number,
  target: number
): Promise<ScanCursor> {
  let found: ScanCursor = { index: 0, seq: 0 };
  await scanForward(
    options,
    types,
    { index: 0, seq: 0 },
    endSeq,
    (steps, at) => {
      steps.forEach((step, offset) => {
        if (at + offset === target - 1)
          found = { index: target, seq: step.seq + 1 };
      });
      return found.seq > 0;
    }
  );
  return target === 0 ? { index: 0, seq: 0 } : found;
}
