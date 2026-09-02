/**
 * Trajectory termination classification and admission accounting.
 *
 * GEPA scores a failed rollout as `0` and lets that zero sit in the promotion
 * denominator as evidence against the candidate. A trajectory that died because
 * a provider returned 429 is not evidence about the candidate; a trajectory
 * that died because the candidate's own generated code blew its budget is.
 * Telling those apart is a HOST judgement — Ax never infers an environment
 * failure — but the rows Ax refuses to let a host relabel are Ax's judgement,
 * and `axClassifyTrajectory` is where that refusal lives.
 *
 * Pure and unwired: nothing in this module reads or writes optimizer state.
 */

export type AxEnvironmentFailureCause =
  | 'transport'
  | 'rate_limit'
  | 'timeout'
  | 'sandbox'
  | 'capability_unavailable'
  | 'host_abort'
  | 'other';

export type AxTrajectoryTermination =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'policy_failure'; cause?: string }>
  | Readonly<{ kind: 'environment_failure'; cause: AxEnvironmentFailureCause }>;

export interface AxTrajectoryTerminationInput {
  readonly phase: string;
  readonly exampleIndex: number;
  readonly prediction?: unknown;
  readonly error?: string;
  readonly failureKind?: 'runtime' | 'adapter' | 'validator';
  readonly elapsedMs?: number;
  /**
   * Component kinds this candidate mutated, parsed via `parseComponentKey`.
   * Present so a classifier can see what it is judging. It is ADVISORY: Ax
   * enforces the non-reclassifiable rule itself, regardless of what the
   * classifier returns.
   */
  readonly candidateKinds?: readonly string[];
  /**
   * True when this row may not be reclassified as an environment failure.
   * Ax sets it; a classifier cannot clear it.
   */
  readonly nonReclassifiable: boolean;
}

/**
 * Host-owned. Ax never infers an environment failure.
 * Classify conservatively: return `policy_failure` whenever unsure, because
 * mis-labelling a policy failure launders a real defect out of the evidence.
 */
export type AxTrajectoryTerminationClassifier = (
  input: Readonly<AxTrajectoryTerminationInput>
) => AxTrajectoryTermination;

const ENVIRONMENT_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  'transport',
  'rate_limit',
  'timeout',
  'sandbox',
  'capability_unavailable',
  'host_abort',
  'other',
]);

const COMPLETED: AxTrajectoryTermination = Object.freeze({
  kind: 'completed',
} as const);

const POLICY_FAILURE: AxTrajectoryTermination = Object.freeze({
  kind: 'policy_failure',
} as const);

const NON_RECLASSIFIABLE: AxTrajectoryTermination = Object.freeze({
  kind: 'policy_failure',
  cause: 'non_reclassifiable',
} as const);

const INVALID_CLASSIFICATION: AxTrajectoryTermination = Object.freeze({
  kind: 'policy_failure',
  cause: 'invalid_classification',
} as const);

/**
 * Reproduces today's behaviour exactly: a row with no error completes, and
 * every failure is the candidate's policy failure. This default can never
 * return an environment failure, which is what keeps the opt-in path opt-in.
 */
export const axDefaultTrajectoryTermination: AxTrajectoryTerminationClassifier =
  (input) =>
    input.error === undefined && input.failureKind === undefined
      ? COMPLETED
      : POLICY_FAILURE;

/**
 * Normalize whatever a host classifier returned into the closed union.
 *
 * A JavaScript host is not bound by the TypeScript signature, and "unsure"
 * must resolve toward `policy_failure` — an unrecognized value must never
 * become an admission-removing environment failure.
 */
function normalizeTermination(value: unknown): AxTrajectoryTermination {
  if (!value || typeof value !== 'object') return INVALID_CLASSIFICATION;
  const candidate = value as { kind?: unknown; cause?: unknown };
  if (candidate.kind === 'completed') return COMPLETED;
  if (candidate.kind === 'policy_failure') {
    return typeof candidate.cause === 'string'
      ? { kind: 'policy_failure', cause: candidate.cause }
      : POLICY_FAILURE;
  }
  if (candidate.kind === 'environment_failure') {
    const cause =
      typeof candidate.cause === 'string' &&
      ENVIRONMENT_FAILURE_CAUSES.has(candidate.cause)
        ? (candidate.cause as AxEnvironmentFailureCause)
        : 'other';
    return { kind: 'environment_failure', cause };
  }
  return INVALID_CLASSIFICATION;
}

/**
 * The enforcement wrapper. Calls the classifier, then OVERRIDES an
 * `environment_failure` to `{kind:'policy_failure', cause:'non_reclassifiable'}`
 * whenever `input.nonReclassifiable` is true, counting the override.
 *
 * Every call site uses this; the raw classifier is never invoked directly.
 * Ax marks a row non-reclassifiable for a `validateConfig` error and for a
 * `forward` throw on a candidate that touched a `program-source` component —
 * for such a candidate the evolved AST IS the candidate, so its budget errors,
 * worker timeouts and bad tool calls are the candidate failing.
 */
export function axClassifyTrajectory(
  classifier: AxTrajectoryTerminationClassifier,
  input: Readonly<AxTrajectoryTerminationInput>
): Readonly<{ termination: AxTrajectoryTermination; overridden: boolean }> {
  const termination = normalizeTermination(classifier(input));
  if (termination.kind === 'environment_failure' && input.nonReclassifiable) {
    return { termination: NON_RECLASSIFIABLE, overridden: true };
  }
  return { termination, overridden: false };
}

export interface AxTrajectoryAdmissionOptions {
  readonly classifier?: AxTrajectoryTerminationClassifier;
  /**
   * Minimum admitted fraction of a batch before its result may decide a
   * candidate. Below it the evaluation is `inconclusive` and the candidate
   * aborts rather than being accepted or rejected. Default: 0.5. Clamped to
   * [0, 1].
   */
  readonly minAdmittedFraction?: number;
  /**
   * Run-level ceiling. When the cumulative run discard rate exceeds this after
   * at least `minRunRowsForCeiling` evaluated rows, the run ENDS. A per-batch
   * floor alone cannot catch a classifier that discards 49% of every batch
   * forever. Default: 0.4. Clamped to [0, 1].
   */
  readonly maxRunDiscardRate?: number;
  /** Rows evaluated before `maxRunDiscardRate` may fire. Default: 50. Clamped to [1, 100000]. */
  readonly minRunRowsForCeiling?: number;
}

export type AxResolvedTrajectoryAdmissionOptions =
  Required<AxTrajectoryAdmissionOptions>;

const clampFraction = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

export function axResolveTrajectoryAdmissionOptions(
  options?: Readonly<AxTrajectoryAdmissionOptions>
): AxResolvedTrajectoryAdmissionOptions {
  const minRunRows = options?.minRunRowsForCeiling;
  return Object.freeze({
    classifier: options?.classifier ?? axDefaultTrajectoryTermination,
    minAdmittedFraction: clampFraction(options?.minAdmittedFraction, 0.5),
    maxRunDiscardRate: clampFraction(options?.maxRunDiscardRate, 0.4),
    minRunRowsForCeiling:
      minRunRows === undefined || !Number.isFinite(minRunRows)
        ? 50
        : Math.min(100_000, Math.max(1, Math.floor(minRunRows))),
  });
}

export interface AxTrajectoryAdmissionReport {
  readonly evaluatedRows: number;
  readonly admittedRows: number;
  readonly discardedRows: number;
  /** `discardedRows / evaluatedRows`, or 0 when nothing was evaluated. */
  readonly discardRate: number;
  readonly causes: Readonly<Partial<Record<AxEnvironmentFailureCause, number>>>;
  /** Rows where a host `environment_failure` was overridden as non-reclassifiable. */
  readonly overriddenRows: number;
  readonly inconclusive: boolean;
}

const isInconclusive = (
  evaluatedRows: number,
  admittedRows: number,
  minAdmittedFraction: number
): boolean =>
  evaluatedRows === 0 ||
  admittedRows === 0 ||
  admittedRows / evaluatedRows < minAdmittedFraction;

/**
 * Summarize one batch. Only `environment_failure` rows are discarded: a policy
 * failure is the candidate's own result and stays in the denominator, scored
 * as it is scored today.
 *
 * `causes` counts categories only. Error text never enters an admission
 * report — the report travels into artifacts and logger events.
 */
export function axSummarizeTrajectoryAdmission(
  terminations: readonly AxTrajectoryTermination[],
  overriddenRows: number,
  options: Readonly<AxResolvedTrajectoryAdmissionOptions>
): AxTrajectoryAdmissionReport {
  const causes: Partial<Record<AxEnvironmentFailureCause, number>> = {};
  let discardedRows = 0;
  for (const termination of terminations) {
    if (termination.kind !== 'environment_failure') continue;
    discardedRows += 1;
    causes[termination.cause] = (causes[termination.cause] ?? 0) + 1;
  }
  const evaluatedRows = terminations.length;
  const admittedRows = evaluatedRows - discardedRows;
  return Object.freeze({
    evaluatedRows,
    admittedRows,
    discardedRows,
    discardRate: evaluatedRows === 0 ? 0 : discardedRows / evaluatedRows,
    causes: Object.freeze(causes),
    overriddenRows: Math.max(0, Math.floor(overriddenRows)),
    inconclusive: isInconclusive(
      evaluatedRows,
      admittedRows,
      options.minAdmittedFraction
    ),
  });
}

/**
 * Sum of two reports, for run-level aggregation. Associative; `inconclusive`
 * is OR-ed, and `discardRate` is recomputed from the summed counts rather than
 * averaged, so folding a run's batches in any order gives the same rate.
 */
export function axMergeTrajectoryAdmission(
  left: Readonly<AxTrajectoryAdmissionReport>,
  right: Readonly<AxTrajectoryAdmissionReport>
): AxTrajectoryAdmissionReport {
  const causes: Partial<Record<AxEnvironmentFailureCause, number>> = {
    ...left.causes,
  };
  for (const [cause, count] of Object.entries(right.causes)) {
    const key = cause as AxEnvironmentFailureCause;
    causes[key] = (causes[key] ?? 0) + (count ?? 0);
  }
  const evaluatedRows = left.evaluatedRows + right.evaluatedRows;
  const discardedRows = left.discardedRows + right.discardedRows;
  return Object.freeze({
    evaluatedRows,
    admittedRows: left.admittedRows + right.admittedRows,
    discardedRows,
    discardRate: evaluatedRows === 0 ? 0 : discardedRows / evaluatedRows,
    causes: Object.freeze(causes),
    overriddenRows: left.overriddenRows + right.overriddenRows,
    inconclusive: left.inconclusive || right.inconclusive,
  });
}

/** True when the run-level ceiling has fired. */
export function axExceedsRunDiscardCeiling(
  report: Readonly<AxTrajectoryAdmissionReport>,
  options: Readonly<AxResolvedTrajectoryAdmissionOptions>
): boolean {
  return (
    report.evaluatedRows >= options.minRunRowsForCeiling &&
    report.discardRate > options.maxRunDiscardRate
  );
}

/**
 * Intersect two evaluations' admitted index sets.
 *
 * This is the ONLY sanctioned way to build a promotion comparison under
 * admission. `sum` is a raw total rather than a per-example mean, and parent
 * and child are separate
 * evaluations that can discard different rows; comparing each side's own
 * admitted total means dropping k rows from the parent lowers the parent's sum
 * while leaving the child's untouched, and the child gets promoted for it.
 * Intersecting first gives both sides the same denominator by construction, on
 * every strategy and at every gate.
 *
 * Order-stable in `left`, deduplicating.
 */
export function axPairedAdmittedIndices(
  left: readonly number[],
  right: readonly number[]
): readonly number[] {
  const allowed = new Set(right);
  const seen = new Set<number>();
  const paired: number[] = [];
  for (const index of left) {
    if (!allowed.has(index) || seen.has(index)) continue;
    seen.add(index);
    paired.push(index);
  }
  return Object.freeze(paired);
}
