/**
 * Discriminative task selection and its inverse-probability estimator.
 *
 * GEPA draws minibatches uniformly, so most of a run's budget is spent
 * re-measuring tasks every candidate already solves and tasks no candidate can
 * solve. Neither tells you anything about which candidate is better.
 *
 * The sampler concentrates draws on tasks that DISCRIMINATE — tasks whose
 * outcome has actually varied across candidates — while reserving a
 * non-optional share of the mass for uniform exploration, so a capability that
 * only shows up on currently-impossible tasks does not become invisible.
 *
 * The sampler ships WITH its estimator on purpose. Under a non-uniform draw,
 * raw batch sums are no longer comparable across iterations; an
 * inclusion-probability-weighted (Hájek) estimate is what makes a parent/child
 * comparison mean the same thing on an easy draw and a hard one. Shipping the
 * sampler alone would silently corrupt the promotion decision.
 *
 * Pure and unwired; every function here is deterministic except
 * `axSampleByInclusion`, which consumes exactly one value from the caller's
 * generator.
 */

export type AxMinibatchStrategy = 'uniform' | 'discriminative';

/** The only two evaluation phases that feed the stat table. */
export type AxTaskStatPhase = 'parent_minibatch' | 'child_minibatch';

/** Per-validation-task pass history across candidates evaluated so far in this run. */
export interface AxTaskStat {
  readonly index: number;
  readonly successes: number;
  readonly trials: number;
  readonly lastSeenIteration: number;
}

export interface AxTaskDiscriminationOptions {
  /** Score at or above which a task counts as solved. Default: 0.5. */
  readonly successThreshold?: number;
  /** Share of inclusion mass reserved for uniform exploration. Default: 0.2. Clamped to [0.05, 1]. */
  readonly explorationFloor?: number;
  /** Maximum per-task rows surfaced into the run-level summary. Default: 200. Clamped to [1, 1000]. */
  readonly maxReportedTasks?: number;
  /** Maximum published inclusion snapshots in the run-level summary. Default: 20. Clamped to [0, 200]. */
  readonly maxInclusionSnapshots?: number;
}

export type AxResolvedTaskDiscriminationOptions =
  Required<AxTaskDiscriminationOptions>;

export class AxTaskDiscriminationError extends Error {
  readonly code:
    | 'batch_size_exceeds_population'
    | 'non_finite_probability'
    | 'inclusion_sum_mismatch'
    | 'unknown_task_index'
    | 'paired_index_mismatch';

  constructor(code: AxTaskDiscriminationError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'AxTaskDiscriminationError';
    this.code = code;
  }
}

const DISCRIMINATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'batch_size_exceeds_population',
  'non_finite_probability',
  'inclusion_sum_mismatch',
  'unknown_task_index',
  'paired_index_mismatch',
]);

/** Cross-realm structural guard. */
export function axIsTaskDiscriminationError(
  error: unknown
): error is AxTaskDiscriminationError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxTaskDiscriminationError' &&
    typeof candidate.code === 'string' &&
    DISCRIMINATION_ERROR_CODES.has(candidate.code)
  );
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const finiteOr = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : value;

export function axResolveTaskDiscriminationOptions(
  options?: Readonly<AxTaskDiscriminationOptions>
): AxResolvedTaskDiscriminationOptions {
  return Object.freeze({
    successThreshold: finiteOr(options?.successThreshold, 0.5),
    // The floor is NOT allowed to reach zero. A selector that can starve
    // always-failed tasks completely makes a capability that only shows on
    // currently-impossible tasks structurally invisible.
    explorationFloor: clamp(finiteOr(options?.explorationFloor, 0.2), 0.05, 1),
    maxReportedTasks: Math.floor(
      clamp(finiteOr(options?.maxReportedTasks, 200), 1, 1000)
    ),
    maxInclusionSnapshots: Math.floor(
      clamp(finiteOr(options?.maxInclusionSnapshots, 20), 0, 200)
    ),
  });
}

let constructTaskStatTable: (
  size: number,
  options: AxResolvedTaskDiscriminationOptions
) => AxTaskStatTable;

/**
 * Mutable per-run table. Not published; snapshots are.
 *
 * Construct through `axCreateTaskStatTable`, which validates and captures the
 * resolved options once — the options are deliberately NOT threaded through
 * every `record` call, so a caller cannot change the success threshold halfway
 * through a run and leave the table meaning two different things.
 */
export class AxTaskStatTable {
  readonly size: number;
  /**
   * Copied out of the options record at construction, not held by reference:
   * a table whose success threshold can be changed mid-run means two different
   * things in one history.
   */
  private readonly successThreshold: number;
  private readonly successes: Float64Array;
  private readonly trials: Float64Array;
  private readonly lastSeen: Float64Array;

  private constructor(
    size: number,
    options: AxResolvedTaskDiscriminationOptions
  ) {
    this.size = size;
    this.successThreshold = options.successThreshold;
    this.successes = new Float64Array(size);
    this.trials = new Float64Array(size);
    this.lastSeen = new Float64Array(size).fill(-1);
  }

  // The constructor is private and there is no public `create`: the ONLY way in
  // is `axCreateTaskStatTable`, which validates. A second entry point would be
  // a second place for the size/options invariants to be skipped.
  static {
    constructTaskStatTable = (size, options) =>
      new AxTaskStatTable(size, options);
  }

  /**
   * Record one candidate's ADMITTED outcome on one task.
   *
   * Discarded rows must not be recorded: an environment failure is not evidence
   * about task difficulty either, and folding it in would make a flaky provider
   * look like a hard task.
   */
  record(index: number, scalar: number, iteration: number): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.size ||
      !Number.isFinite(scalar)
    ) {
      throw new AxTaskDiscriminationError(
        'unknown_task_index',
        `cannot record task index ${String(index)} with scalar ${String(scalar)} in a table of size ${this.size}`
      );
    }
    this.trials[index] = (this.trials[index] ?? 0) + 1;
    if (scalar >= this.successThreshold) {
      this.successes[index] = (this.successes[index] ?? 0) + 1;
    }
    this.lastSeen[index] = iteration;
  }

  /** Every task, index ascending, including tasks never sampled. */
  stats(): readonly AxTaskStat[] {
    const out: AxTaskStat[] = [];
    for (let index = 0; index < this.size; index++) {
      out.push(
        Object.freeze({
          index,
          successes: this.successes[index]!,
          trials: this.trials[index]!,
          lastSeenIteration: this.lastSeen[index]!,
        })
      );
    }
    return Object.freeze(out);
  }

  reset(): void {
    this.successes.fill(0);
    this.trials.fill(0);
    this.lastSeen.fill(-1);
  }
}

export function axCreateTaskStatTable(
  size: number,
  options: Readonly<AxResolvedTaskDiscriminationOptions>
): AxTaskStatTable {
  if (!Number.isInteger(size) || size < 1) {
    throw new AxTaskDiscriminationError(
      'unknown_task_index',
      `task stat table size must be a positive integer, received ${String(size)}`
    );
  }
  return constructTaskStatTable(size, options);
}

export interface AxTaskInclusion {
  readonly index: number;
  /** First-order inclusion probability in (0, 1]. Sum over all tasks equals the batch size. */
  readonly probability: number;
  readonly successes: number;
  readonly trials: number;
}

const SUM_TOLERANCE = 1e-9;

/**
 * Beta(1,1)-smoothed Bernoulli-variance inclusion probabilities with a
 * mandatory exploration floor, water-filled so every probability is at most 1
 * and the sum is exactly the batch size. Deterministic: no randomness.
 *
 *   p̂_i = (s_i + 1) / (n_i + 2)     Laplace smoothing, so p̂ ∈ (0,1) strictly
 *   v_i = p̂_i (1 − p̂_i)             Bernoulli variance: peaks at p̂ = 0.5
 *   w_i = v_i / Σ v                  normalized
 *   u_i = (1 − ε) w_i + ε / N        exploration floor mixed in
 *   π_i = m · u_i, then water-filled to keep π_i ≤ 1 with Σ π = m
 *
 * With no recorded trials every p̂ is exactly 0.5, so every v is 0.25 and the
 * distribution is provably uniform: the first minibatch under this strategy is
 * statistically identical to a uniform draw.
 */
export function axComputeInclusionProbabilities(
  stats: readonly AxTaskStat[],
  batchSize: number,
  options: Readonly<AxResolvedTaskDiscriminationOptions>
): readonly AxTaskInclusion[] {
  const population = stats.length;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new AxTaskDiscriminationError(
      'non_finite_probability',
      `batch size must be a positive integer, received ${String(batchSize)}`
    );
  }
  if (batchSize > population) {
    throw new AxTaskDiscriminationError(
      'batch_size_exceeds_population',
      `cannot draw ${batchSize} distinct tasks from a population of ${population}`
    );
  }

  const seen = new Set<number>();
  const variances: number[] = [];
  let varianceSum = 0;
  for (const stat of stats) {
    if (
      !Number.isInteger(stat.index) ||
      stat.index < 0 ||
      stat.index >= population ||
      seen.has(stat.index)
    ) {
      throw new AxTaskDiscriminationError(
        'unknown_task_index',
        `task stats must carry each index in [0, ${population}) exactly once; saw ${String(stat.index)}`
      );
    }
    seen.add(stat.index);
    if (
      !Number.isFinite(stat.successes) ||
      !Number.isFinite(stat.trials) ||
      stat.trials < 0 ||
      stat.successes < 0 ||
      stat.successes > stat.trials
    ) {
      throw new AxTaskDiscriminationError(
        'non_finite_probability',
        `task ${stat.index} has an impossible history: ${String(stat.successes)} successes in ${String(stat.trials)} trials`
      );
    }
    const smoothed = (stat.successes + 1) / (stat.trials + 2);
    const variance = smoothed * (1 - smoothed);
    variances.push(variance);
    varianceSum += variance;
  }
  // Laplace smoothing keeps p̂ strictly inside (0,1), so the variance sum is
  // strictly positive for any history. There is no degenerate branch to guard.
  if (!(varianceSum > 0) || !Number.isFinite(varianceSum)) {
    throw new AxTaskDiscriminationError(
      'non_finite_probability',
      'smoothed variance sum is not a positive finite number'
    );
  }

  const epsilon = options.explorationFloor;
  const weights = variances.map(
    (variance) =>
      (1 - epsilon) * (variance / varianceSum) + epsilon / population
  );

  // Water-fill. Each pass clamps at least one index, so it terminates in at
  // most `population` passes.
  const probabilities = new Array<number>(population).fill(0);
  const clamped = new Array<boolean>(population).fill(false);
  let clampedCount = 0;
  for (let pass = 0; pass <= population; pass++) {
    let unclampedWeight = 0;
    for (let i = 0; i < population; i++) {
      if (!clamped[i]) unclampedWeight += weights[i]!;
    }
    const remaining = batchSize - clampedCount;
    let overflowed = false;
    for (let i = 0; i < population; i++) {
      if (clamped[i]) {
        probabilities[i] = 1;
        continue;
      }
      const share =
        unclampedWeight > 0 ? (remaining * weights[i]!) / unclampedWeight : 0;
      probabilities[i] = share;
      if (share > 1) overflowed = true;
    }
    if (!overflowed) break;
    for (let i = 0; i < population; i++) {
      if (!clamped[i] && probabilities[i]! > 1) {
        clamped[i] = true;
        clampedCount += 1;
      }
    }
  }

  let total = 0;
  for (let i = 0; i < population; i++) {
    const probability = probabilities[i]!;
    if (!Number.isFinite(probability) || probability <= 0 || probability > 1) {
      throw new AxTaskDiscriminationError(
        'non_finite_probability',
        `task ${i} received an inclusion probability of ${String(probability)}, which is outside (0, 1]`
      );
    }
    total += probability;
  }
  if (Math.abs(total - batchSize) > SUM_TOLERANCE) {
    throw new AxTaskDiscriminationError(
      'inclusion_sum_mismatch',
      `inclusion probabilities sum to ${total}, expected ${batchSize}`
    );
  }

  const byIndex = new Map(stats.map((stat) => [stat.index, stat]));
  const inclusions: AxTaskInclusion[] = [];
  for (let index = 0; index < population; index++) {
    const stat = byIndex.get(index)!;
    inclusions.push(
      Object.freeze({
        index,
        probability: probabilities[index]!,
        successes: stat.successes,
        trials: stat.trials,
      })
    );
  }
  return Object.freeze(inclusions);
}

/**
 * Madow systematic probability-proportional-to-size sampling without
 * replacement. Consumes exactly one value from `rand`. Returns `batchSize`
 * distinct indices, and `P(i ∈ S) = π_i` exactly.
 *
 * Chosen over conditional-Poisson / Sampford πps — which give correct JOINT
 * inclusion probabilities — because those are rejection samplers with an
 * unbounded worst-case draw count, and GEPA's RNG is a single shared seeded
 * stream where a variable number of draws would stop a seeded run from
 * reproducing.
 * The price is that some pairs are never co-selected, which is exactly why the
 * standard error below is documented as an approximation and never gated on.
 */
export function axSampleByInclusion(
  inclusions: readonly AxTaskInclusion[],
  batchSize: number,
  rand: () => number
): readonly number[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new AxTaskDiscriminationError(
      'non_finite_probability',
      `batch size must be a positive integer, received ${String(batchSize)}`
    );
  }
  if (batchSize > inclusions.length) {
    throw new AxTaskDiscriminationError(
      'batch_size_exceeds_population',
      `cannot draw ${batchSize} distinct tasks from ${inclusions.length} inclusions`
    );
  }
  const ordered = [...inclusions].sort((a, b) => a.index - b.index);
  const cumulative: number[] = [];
  let running = 0;
  for (const inclusion of ordered) {
    if (
      !Number.isFinite(inclusion.probability) ||
      inclusion.probability <= 0 ||
      inclusion.probability > 1
    ) {
      throw new AxTaskDiscriminationError(
        'non_finite_probability',
        `task ${inclusion.index} has inclusion probability ${String(inclusion.probability)}, which is outside (0, 1]`
      );
    }
    running += inclusion.probability;
    cumulative.push(running);
  }
  if (Math.abs(running - batchSize) > 1e-6) {
    throw new AxTaskDiscriminationError(
      'inclusion_sum_mismatch',
      `inclusion probabilities sum to ${running}, expected ${batchSize}`
    );
  }

  const u = rand();
  if (!Number.isFinite(u) || u < 0 || u >= 1) {
    throw new AxTaskDiscriminationError(
      'non_finite_probability',
      `the random source returned ${String(u)}, which is outside [0, 1)`
    );
  }

  const drawn: number[] = [];
  let pointer = 0;
  for (let k = 0; k < batchSize; k++) {
    const target = u + k;
    while (pointer < ordered.length - 1 && cumulative[pointer]! <= target) {
      pointer += 1;
    }
    drawn.push(ordered[pointer]!.index);
  }
  if (new Set(drawn).size !== batchSize) {
    // Unreachable for valid inclusions (π ≤ 1 means each interval holds at most
    // one of the unit-spaced targets); surfaced rather than silently returning
    // a short or duplicated batch.
    throw new AxTaskDiscriminationError(
      'inclusion_sum_mismatch',
      `systematic sampling produced ${new Set(drawn).size} distinct indices for a batch of ${batchSize}`
    );
  }
  return Object.freeze(drawn);
}

export interface AxIpwEstimate {
  /** Hájek (ratio) estimate of the population mean, or of the paired mean difference. */
  readonly estimate: number;
  /**
   * Linearized standard error. Ignores joint inclusion probabilities, which
   * Madow systematic sampling drives to zero for some pairs, so this is an
   * APPROXIMATION and not a design-unbiased variance estimate. Report it; never
   * gate on it. If a real interval is needed, use a paired bootstrap over the
   * drawn sample.
   */
  readonly stderr: number;
  readonly effectiveSampleSize: number;
  readonly rowCount: number;
}

const EMPTY_ESTIMATE: AxIpwEstimate = Object.freeze({
  estimate: 0,
  stderr: 0,
  effectiveSampleSize: 0,
  rowCount: 0,
});

function weightsFor(
  rows: readonly Readonly<{ index: number; value: number }>[],
  inclusions: readonly AxTaskInclusion[]
): number[] {
  const byIndex = new Map(
    inclusions.map((inclusion) => [inclusion.index, inclusion.probability])
  );
  return rows.map((row) => {
    const probability = byIndex.get(row.index);
    if (probability === undefined) {
      throw new AxTaskDiscriminationError(
        'unknown_task_index',
        `row references task index ${String(row.index)}, which has no inclusion probability`
      );
    }
    if (!Number.isFinite(probability) || probability <= 0) {
      throw new AxTaskDiscriminationError(
        'non_finite_probability',
        `task ${row.index} has a non-positive inclusion probability`
      );
    }
    if (!Number.isFinite(row.value)) {
      throw new AxTaskDiscriminationError(
        'non_finite_probability',
        `task ${row.index} carries a non-finite value`
      );
    }
    return 1 / probability;
  });
}

function hajek(values: readonly number[], weights: readonly number[]) {
  let sumW = 0;
  let sumWy = 0;
  let sumW2 = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]!;
    sumW += w;
    sumWy += w * values[i]!;
    sumW2 += w * w;
  }
  if (sumW <= 0) return EMPTY_ESTIMATE;
  const estimate = sumWy / sumW;
  let residual = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]!;
    const deviation = values[i]! - estimate;
    residual += w * w * deviation * deviation;
  }
  return Object.freeze({
    estimate,
    stderr: Math.sqrt(residual) / sumW,
    effectiveSampleSize: (sumW * sumW) / sumW2,
    rowCount: values.length,
  });
}

/**
 * Hájek (ratio) estimate of the population mean from a πps sample.
 *
 * An empty row set returns a zero estimate rather than throwing: under the
 * promotion gates a zero difference fails the default `> threshold` test, so
 * "no admitted rows" resolves toward NOT promoting.
 */
export function axIpwScore(
  rows: readonly Readonly<{ index: number; value: number }>[],
  inclusions: readonly AxTaskInclusion[]
): AxIpwEstimate {
  if (rows.length === 0) return EMPTY_ESTIMATE;
  const weights = weightsFor(rows, inclusions);
  return hajek(
    rows.map((row) => row.value),
    weights
  );
}

/**
 * Paired parent/child difference estimator.
 *
 * `parent` and `child` MUST already be restricted to the same index set — the
 * rows admitted in BOTH evaluations. Pairing is never inferred here, because
 * inferring it is precisely how two different denominators get compared: drop
 * k rows from the parent and the child wins for free.
 */
export function axIpwPairedDifference(
  parent: readonly Readonly<{ index: number; value: number }>[],
  child: readonly Readonly<{ index: number; value: number }>[],
  inclusions: readonly AxTaskInclusion[]
): AxIpwEstimate {
  if (parent.length !== child.length) {
    throw new AxTaskDiscriminationError(
      'paired_index_mismatch',
      `parent has ${parent.length} rows and child has ${child.length}; both must cover the same admitted index set`
    );
  }
  if (parent.length === 0) return EMPTY_ESTIMATE;
  const parentByIndex = new Map<number, number>();
  for (const row of parent) {
    if (parentByIndex.has(row.index)) {
      throw new AxTaskDiscriminationError(
        'paired_index_mismatch',
        `parent repeats task index ${row.index}`
      );
    }
    parentByIndex.set(row.index, row.value);
  }
  const differences: number[] = [];
  const paired: { index: number; value: number }[] = [];
  const seen = new Set<number>();
  for (const row of child) {
    if (seen.has(row.index)) {
      throw new AxTaskDiscriminationError(
        'paired_index_mismatch',
        `child repeats task index ${row.index}`
      );
    }
    seen.add(row.index);
    const parentValue = parentByIndex.get(row.index);
    if (parentValue === undefined) {
      throw new AxTaskDiscriminationError(
        'paired_index_mismatch',
        `child covers task index ${row.index} but the parent does not`
      );
    }
    differences.push(row.value - parentValue);
    paired.push({ index: row.index, value: row.value - parentValue });
  }
  const weights = weightsFor(paired, inclusions);
  return hajek(differences, weights);
}

/** Bounded, publishable snapshot for one iteration. */
export interface AxTaskInclusionSnapshot {
  readonly iteration: number;
  readonly strategy: AxMinibatchStrategy;
  readonly batchSize: number;
  readonly taskCount: number;
  readonly inclusions: readonly AxTaskInclusion[];
  readonly omittedTaskCount: number;
  readonly sampledIndices: readonly number[];
}

export interface AxTaskDiscriminationSummary {
  readonly strategy: AxMinibatchStrategy;
  readonly iterations: number;
  readonly snapshots: readonly AxTaskInclusionSnapshot[];
  readonly omittedSnapshotCount: number;
  /** Fraction of tasks that were all-pass or all-fail across every recorded trial. */
  readonly nonDiscriminativeTaskFraction: number;
  readonly finalStats: readonly AxTaskStat[];
  /** UTF-8 bytes this summary occupies once serialized. Budgeted. */
  readonly serializedBytes: number;
}
