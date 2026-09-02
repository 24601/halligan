/**
 * Paired, task-clustered bootstrap intervals and the unchanged-artifact
 * variance band.
 *
 * Pure: no I/O, no clock, no `Math.random`. Every interval on a receipt must be
 * reproducible from the receipt, so the PRNG is a seeded mulberry32 and the
 * seed travels on the interval.
 *
 * The resampling unit is ALWAYS the task (invariant I2). Resampling attempts
 * would treat 20 repeats of 3 tasks as 60 independent observations and narrow
 * every interval by roughly the square root of the repeat count — an interval
 * that looks rigorous and is not.
 *
 * Build-vs-buy: `simple-statistics`, `bootstrap-ci` and `d3-random` were
 * considered and rejected — `@ax-llm/ax` has exactly one runtime dependency and
 * builds `platform: 'neutral'`. The custom surface is two pure functions with
 * no lifecycle and no exit-path cost.
 */

import type {
  AxAgentPlaybookInterval,
  AxAgentPlaybookIntervalOptions,
  AxAgentPlaybookSplitName,
  AxAgentPlaybookVarianceBand,
} from './playbookEvidenceTypes.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';

export const DEFAULT_RESAMPLES = 10_000;
export const DEFAULT_LEVEL = 0.95;
const MIN_RESAMPLES = 200;
const MAX_RESAMPLES = 100_000;

/**
 * One resampling unit: a task, with the paired deltas observed for it. The
 * simple candidate-vs-anchor case has exactly one delta per task; the pooled
 * variance band has one per extra repeat.
 */
export type AxTaskCluster = Readonly<{
  weight: number;
  deltas: readonly number[];
}>;

/**
 * Deterministic 32-bit PRNG. Integer ops only, so the sequence is identical on
 * every JS engine and in a browser.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Low 32 bits of a `fnv1a64:<hex>` digest, so an unseeded run is reproducible. */
export function seedFromDigest(digest: string): number {
  const hex = digest.includes(':')
    ? digest.slice(digest.indexOf(':') + 1)
    : digest;
  const low = hex.slice(-8);
  const parsed = Number.parseInt(low, 16);
  return Number.isFinite(parsed) ? parsed | 0 : 0;
}

export function validateIntervalOptions(
  options?: Readonly<AxAgentPlaybookIntervalOptions>
): Required<Pick<AxAgentPlaybookIntervalOptions, 'resamples' | 'level'>> & {
  seed?: number;
} {
  const resamples = options?.resamples ?? DEFAULT_RESAMPLES;
  const level = options?.level ?? DEFAULT_LEVEL;
  if (
    !Number.isSafeInteger(resamples) ||
    resamples < MIN_RESAMPLES ||
    resamples > MAX_RESAMPLES
  ) {
    throw new AxAgentPlaybookEvolveError(
      'interval_options_invalid',
      'candidate_eval',
      `intervalOptions.resamples must be a safe integer in [${MIN_RESAMPLES}, ${MAX_RESAMPLES}].`
    );
  }
  if (!Number.isFinite(level) || level <= 0 || level >= 1) {
    throw new AxAgentPlaybookEvolveError(
      'interval_options_invalid',
      'candidate_eval',
      'intervalOptions.level must be a number in (0, 1).'
    );
  }
  if (options?.seed !== undefined && !Number.isSafeInteger(options.seed)) {
    throw new AxAgentPlaybookEvolveError(
      'interval_options_invalid',
      'candidate_eval',
      'intervalOptions.seed must be a safe integer.'
    );
  }
  return {
    resamples,
    level,
    ...(options?.seed !== undefined ? { seed: options.seed } : {}),
  };
}

export function weightedMean(clusters: readonly AxTaskCluster[]): number {
  let weightSum = 0;
  let total = 0;
  for (const cluster of clusters) {
    if (cluster.deltas.length === 0) continue;
    const mean =
      cluster.deltas.reduce((sum, delta) => sum + delta, 0) /
      cluster.deltas.length;
    weightSum += cluster.weight;
    total += cluster.weight * mean;
  }
  return weightSum > 0 ? total / weightSum : 0;
}

/**
 * Percentile bootstrap over task clusters. Returns `undefined` — read
 * downstream as `unmeasured`, which fails closed under a `require` gate — when
 * there is nothing valid to resample.
 */
export function pairedBootstrapInterval(args: {
  clusters: readonly AxTaskCluster[];
  seed: number;
  resamples?: number;
  level?: number;
}): AxAgentPlaybookInterval | undefined {
  const clusters = args.clusters.filter(
    (cluster) =>
      cluster.deltas.length > 0 &&
      Number.isFinite(cluster.weight) &&
      cluster.weight >= 0 &&
      cluster.deltas.every((delta) => Number.isFinite(delta))
  );
  if (clusters.length === 0) return undefined;
  const weightTotal = clusters.reduce((sum, c) => sum + c.weight, 0);
  if (!(weightTotal > 0)) return undefined;

  const resamples = args.resamples ?? DEFAULT_RESAMPLES;
  const level = args.level ?? DEFAULT_LEVEL;
  const point = weightedMean(clusters);
  const random = createSeededRandom(args.seed);
  const stats = new Float64Array(resamples);
  const n = clusters.length;

  for (let b = 0; b < resamples; b++) {
    let weightSum = 0;
    let total = 0;
    for (let draw = 0; draw < n; draw++) {
      // Draw TASKS with replacement, not attempts.
      const index = Math.min(n - 1, Math.floor(random() * n));
      const cluster = clusters[index]!;
      const mean =
        cluster.deltas.reduce((sum, delta) => sum + delta, 0) /
        cluster.deltas.length;
      weightSum += cluster.weight;
      total += cluster.weight * mean;
    }
    stats[b] = weightSum > 0 ? total / weightSum : 0;
  }
  stats.sort();

  const alpha = (1 - level) / 2;
  const lower = stats[Math.floor(alpha * resamples)] ?? point;
  const upper =
    stats[Math.min(resamples - 1, Math.ceil((1 - alpha) * resamples) - 1)] ??
    point;
  return {
    point,
    lower,
    upper,
    level,
    resamples,
    unit: 'task',
    clusters: n,
    seed: args.seed,
    // An interval containing zero is 'unresolved'. It is never rounded to the
    // side the point estimate happens to fall on.
    direction: lower > 0 ? 'positive' : upper < 0 ? 'negative' : 'unresolved',
  };
}

/** A record pair the interval machinery can resample. */
export type AxPairedRecord = Readonly<{
  task: object;
  score: number;
}>;

/**
 * Build clusters from an anchor pass and a candidate pass over the SAME split.
 *
 * The pairing precondition is REFERENCE equality of the stored task objects.
 * It holds because `records.push({ task, … })` stores the same object from the
 * same array on every pass — `isolateTaskInputs` clones only what is handed to
 * the agent and the metric. A "hardening" that stores a clone on the record
 * would silently turn every interval into `unmeasured`.
 */
export function clustersFromPairedRecords(
  anchor: readonly AxPairedRecord[],
  candidate: readonly AxPairedRecord[],
  weightOf: (task: any) => number = (task) => task?.weight ?? 1
): readonly AxTaskCluster[] | undefined {
  if (anchor.length === 0 || anchor.length !== candidate.length) {
    return undefined;
  }
  const clusters: AxTaskCluster[] = [];
  for (const [index, anchorRecord] of anchor.entries()) {
    const candidateRecord = candidate[index]!;
    if (anchorRecord.task !== candidateRecord.task) return undefined;
    clusters.push({
      weight: weightOf(anchorRecord.task),
      deltas: [candidateRecord.score - anchorRecord.score],
    });
  }
  return clusters;
}

/**
 * The unchanged-artifact variance band: re-runs of the SAME artifact establish
 * the smallest delta that is distinguishable from run-to-run noise.
 */
export function varianceBandFrom(args: {
  split: AxAgentPlaybookSplitName;
  /** Repeat 0 is the anchor pass; the rest are extra unchanged re-evaluations. */
  repeats: readonly (readonly AxPairedRecord[])[];
  means: readonly number[];
  seed: number;
  resamples?: number;
  level?: number;
}): AxAgentPlaybookVarianceBand | undefined {
  if (args.repeats.length < 2 || args.means.length < 2) return undefined;
  const base = args.repeats[0]!;
  // Clustered BY POSITION, not by task identity: a split may legitimately
  // contain the same task object twice, and a map keyed by that object would
  // silently collapse the two into one cluster and narrow the interval.
  const pooled: { weight: number; deltas: number[] }[] = [];
  for (const [index, baseRecord] of base.entries()) {
    const cluster = {
      weight: (baseRecord.task as { weight?: number }).weight ?? 1,
      deltas: [] as number[],
    };
    pooled.push(cluster);
    for (const repeat of args.repeats.slice(1)) {
      const other = repeat[index];
      // Pairing is reference equality, exactly as for a candidate comparison.
      if (!other || other.task !== baseRecord.task) return undefined;
      cluster.deltas.push(other.score - baseRecord.score);
    }
  }
  const interval = pairedBootstrapInterval({
    clusters: pooled,
    seed: args.seed,
    ...(args.resamples !== undefined ? { resamples: args.resamples } : {}),
    ...(args.level !== undefined ? { level: args.level } : {}),
  });
  if (!interval) return undefined;
  return {
    split: args.split,
    repeats: args.means.length,
    means: args.means,
    // The band is the observed spread of the UNCHANGED artifact. A candidate
    // delta at or below it is noise.
    spread: Math.max(...args.means) - Math.min(...args.means),
    interval,
  };
}
