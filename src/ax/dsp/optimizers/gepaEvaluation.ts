import type { AxAIService } from '../../ai/types.js';
import type {
  AxExample,
  AxMetricFn,
  AxMultiMetricFn,
  AxTypedExample,
} from '../common_types.js';
import type {
  AxFunctionCallTrace,
  AxGenOut,
  AxProgrammable,
} from '../types.js';
import type { AxGEPAAdapter } from './gepaAdapter.js';
import { AxTaskDiscriminationError } from './taskDiscrimination.js';
import {
  type AxResolvedTrajectoryAdmissionOptions,
  type AxTrajectoryAdmissionReport,
  type AxTrajectoryTermination,
  axClassifyTrajectory,
  axSummarizeTrajectoryAdmission,
} from './trajectoryTermination.js';

/**
 * Everything `evaluateGEPABatch` needs to classify a row's termination.
 *
 * `affectedKinds` are the `AxOptimizableComponent.kind` values the evaluated
 * candidate config carries. They are handed to the host classifier as advisory
 * context AND used by Ax to decide which rows may never be relabelled as
 * environment failures — a candidate that carries a `program-source` component
 * IS its evolved AST, so that AST's runtime failures are the candidate's own.
 */
export type AxGEPATerminationArgs = AxResolvedTrajectoryAdmissionOptions & {
  readonly affectedKinds: readonly string[];
};

type AxRowTerminationInput = {
  readonly exampleIndex: number;
  readonly prediction: unknown;
  readonly error?: string;
  readonly failureKind?: 'runtime' | 'adapter' | 'validator';
  readonly nonReclassifiable: boolean;
};

/**
 * Classify one row and fold it into the batch's running admission state.
 *
 * The classifier is never called directly: `axClassifyTrajectory` is the
 * enforcement wrapper that normalizes an out-of-union return value and
 * overrides a non-reclassifiable environment failure.
 */
const classifyRow = (
  termination: Readonly<AxGEPATerminationArgs>,
  phase: string,
  row: Readonly<AxRowTerminationInput>,
  sink: { terminations: AxTrajectoryTermination[]; overriddenRows: number }
): AxTrajectoryTermination => {
  const classified = axClassifyTrajectory(termination.classifier, {
    phase,
    exampleIndex: row.exampleIndex,
    prediction: row.prediction,
    error: row.error,
    failureKind: row.failureKind,
    candidateKinds: termination.affectedKinds,
    nonReclassifiable: row.nonReclassifiable,
  });
  sink.terminations.push(classified.termination);
  if (classified.overridden) sink.overriddenRows += 1;
  return classified.termination;
};

const admissionOf = (
  termination: Readonly<AxGEPATerminationArgs>,
  sink: Readonly<{
    terminations: readonly AxTrajectoryTermination[];
    overriddenRows: number;
  }>
): Readonly<{
  admission: AxTrajectoryAdmissionReport;
  admittedIndices: readonly number[];
}> => {
  const admittedIndices: number[] = [];
  for (const [index, value] of sink.terminations.entries()) {
    if (value.kind !== 'environment_failure') admittedIndices.push(index);
  }
  return {
    admission: axSummarizeTrajectoryAdmission(
      sink.terminations,
      sink.overriddenRows,
      termination
    ),
    admittedIndices,
  };
};

export type AxGEPABatchRow = {
  input: AxExample;
  prediction: unknown;
  scores: Record<string, number>;
  scalar: number;
  feedback?: string;
  /** Present only when a termination classifier was supplied. */
  termination?: AxTrajectoryTermination;
  /** `false` only for `environment_failure` rows. Absent means admitted. */
  admitted?: boolean;
};

export type AxGEPABatchEvaluation = {
  rows: AxGEPABatchRow[];
  /**
   * UNCHANGED MEANING: computed over ALL rows, exactly as before admission
   * existed. Recomputing these over admitted rows would silently change the
   * meaning of GEPA's accept expressions and of `skipPerfectScore`, and would
   * put the two sides of a promotion comparison on different denominators.
   * Admission is reported additively, in the fields below.
   */
  avg: Record<string, number>;
  scalars: number[];
  sum: number;
  trajectories?: readonly unknown[];
  failures?: readonly {
    kind: 'runtime' | 'adapter';
    message: string;
  }[];
  /** Present only when a termination classifier was supplied. */
  terminations?: readonly AxTrajectoryTermination[];
  admission?: AxTrajectoryAdmissionReport;
  /** Indices INTO `rows` that were admitted. Only with a classifier. */
  admittedIndices?: readonly number[];
  /** Feedback-set indices parallel to `rows`. Only when supplied by the caller. */
  exampleIndices?: readonly number[];
};

export type AxGEPAEvaluationState = {
  totalCalls: number;
  observedScoreKeys: Set<string>;
  stopReason?: 'budget_exhausted' | 'aborted';
};

const avgVec = (
  vectors: readonly Readonly<Record<string, number>>[]
): Record<string, number> => {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const vector of vectors) {
    for (const [key, value] of Object.entries(vector)) {
      sums[key] = (sums[key] ?? 0) + value;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const out: Record<string, number> = {};
  for (const key of Object.keys(sums)) {
    out[key] = sums[key]! / (counts[key] ?? 1);
  }
  return out;
};

const zeroScoreVector = (
  knownKeys: ReadonlySet<string>
): Record<string, number> => {
  if (knownKeys.size === 0) return { score: 0 };
  return Object.fromEntries([...knownKeys].map((key) => [key, 0]));
};

export const normalizeGEPABatchScoreVectors = (
  vectors: readonly Readonly<Record<string, number>>[],
  failedRows: ReadonlySet<number>,
  knownKeys: ReadonlySet<string> = new Set()
): Record<string, number>[] => {
  const siblingKeys = new Set(knownKeys);
  for (const [index, vector] of vectors.entries()) {
    if (failedRows.has(index)) continue;
    for (const key of Object.keys(vector)) siblingKeys.add(key);
  }
  if (siblingKeys.size === 0) {
    return vectors.map((vector) => ({ ...vector }));
  }
  return vectors.map((vector) =>
    Object.fromEntries(
      [...siblingKeys].map((key) => [
        key,
        Number.isFinite(vector[key]) ? vector[key] : 0,
      ])
    )
  );
};

const MAX_METRIC_FEEDBACK_CHARS = 4_000;

export const normalizeGEPAMetricFeedback = (
  feedback: unknown
): string | undefined => {
  if (typeof feedback !== 'string') return undefined;
  const characters: string[] = [];
  const source = feedback.replace(/\r\n?/g, '\n');
  for (const character of source) {
    if (characters.length >= MAX_METRIC_FEEDBACK_CHARS) break;
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === '\n' ||
      character === '\t' ||
      (codePoint >= 32 && codePoint !== 127)
    ) {
      characters.push(character);
    }
  }
  const sanitized = characters.join('').trim();
  return sanitized || undefined;
};

type AxNormalizedGEPAMetricResult = {
  scores: Record<string, number>;
  scalar?: number;
  feedback?: string;
};

export const normalizeGEPAMetricResult = async (
  metricFn: AxMetricFn | AxMultiMetricFn,
  prediction: unknown,
  example: AxExample
): Promise<AxNormalizedGEPAMetricResult> => {
  const raw = await (metricFn as any)({ prediction, example });
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { scores: { score: raw }, scalar: raw }
      : { scores: {} };
  }
  if (!raw || typeof raw !== 'object') return { scores: {} };

  const structured =
    typeof (raw as any).score === 'number' &&
    (typeof (raw as any).feedback === 'string' ||
      ((raw as any).scores !== null &&
        typeof (raw as any).scores === 'object'));
  if (structured) {
    const scalar =
      typeof (raw as any).score === 'number' &&
      Number.isFinite((raw as any).score)
        ? (raw as any).score
        : undefined;
    const scores: Record<string, number> = {};
    const objectives = (raw as any).scores;
    if (objectives && typeof objectives === 'object') {
      for (const [key, value] of Object.entries(objectives)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          scores[key] = value;
        }
      }
    }
    if (Object.keys(scores).length === 0 && scalar !== undefined) {
      scores.score = scalar;
    }
    return {
      scores,
      scalar,
      feedback: normalizeGEPAMetricFeedback((raw as any).feedback),
    };
  }

  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      scores[key] = value;
    }
  }
  return { scores };
};

export const normalizeGEPAScores = async (
  metricFn: AxMetricFn | AxMultiMetricFn,
  prediction: unknown,
  example: AxExample
): Promise<Record<string, number>> => {
  return (await normalizeGEPAMetricResult(metricFn, prediction, example))
    .scores;
};

export const scalarizeGEPAScores = (
  scores: Readonly<Record<string, number>>,
  options?: Readonly<{
    paretoMetricKey?: string;
    paretoScalarize?: (scores: Readonly<Record<string, number>>) => number;
  }>
): number => {
  if (typeof options?.paretoScalarize === 'function') {
    return options.paretoScalarize(scores);
  }
  if (options?.paretoMetricKey) {
    const value = scores[options.paretoMetricKey];
    return Number.isFinite(value) ? (value as number) : 0;
  }
  const vals = Object.values(scores);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
};

export async function evaluateGEPABatch<IN, OUT extends AxGenOut>(args: {
  program: Readonly<AxProgrammable<IN, OUT>>;
  ai: AxAIService;
  metricFn: AxMetricFn | AxMultiMetricFn;
  adapter?: AxGEPAAdapter;
  cfg: Readonly<Record<string, string>>;
  set: readonly AxTypedExample<IN>[];
  phase: string;
  sampleCount: number;
  maxMetricCalls: number;
  state: AxGEPAEvaluationState;
  applyConfig: (cfg: Readonly<Record<string, string>>) => void;
  validateConfig?: (cfg: Readonly<Record<string, string>>) => void;
  scalarize: (scores: Readonly<Record<string, number>>) => number;
  verboseLog?: (message: string) => void;
  throwIfInsufficient?: boolean;
  captureTraces?: boolean;
  captureFailures?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Resolved admission options plus the evaluated candidate's component kinds.
   * Absent keeps today's behaviour exactly: no classification, no admission
   * report, no new fields on the result.
   */
  termination?: Readonly<AxGEPATerminationArgs>;
  /**
   * Feedback-set index of each entry in `set`, so a caller can key per-task
   * statistics without re-deriving the mapping. Must be the same length as
   * `set`.
   */
  exampleIndices?: readonly number[];
}): Promise<AxGEPABatchEvaluation | undefined> {
  if (
    args.exampleIndices !== undefined &&
    args.exampleIndices.length !== args.set.length
  ) {
    throw new AxTaskDiscriminationError(
      'unknown_task_index',
      `AxGEPA: exampleIndices length ${args.exampleIndices.length} does not match evaluated set length ${args.set.length}`
    );
  }
  const terminationSink = args.termination
    ? { terminations: [] as AxTrajectoryTermination[], overriddenRows: 0 }
    : undefined;
  /**
   * A candidate carrying a `program-source` component IS its evolved AST, so
   * every failure that AST produces — a budget error, a worker timeout, a
   * revoked execution epoch, a bad tool call — is the candidate failing, and a
   * host may not relabel any of its rows as an environment failure. Overriding
   * only ever turns an environment failure INTO a policy failure, so a broad
   * rule here can only make the evidence more conservative.
   */
  const nonReclassifiableCandidate =
    args.termination?.affectedKinds.includes('program-source') ?? false;
  const failures:
    | Array<{
        kind: 'runtime' | 'adapter';
        message: string;
      }>
    | undefined = args.captureFailures ? [] : undefined;
  args.state.stopReason = undefined;
  if (args.abortSignal?.aborted) {
    args.state.stopReason = 'aborted';
    return undefined;
  }
  const requiredCalls = args.set.length;
  if (args.state.totalCalls + requiredCalls > args.maxMetricCalls) {
    if (args.throwIfInsufficient) {
      throw new Error(
        `AxGEPA: options.maxMetricCalls=${args.maxMetricCalls} is too small to evaluate the initial Pareto set; need at least ${requiredCalls} metric calls`
      );
    }
    args.state.stopReason = 'budget_exhausted';
    return undefined;
  }

  args.verboseLog?.(
    `${args.phase}: evaluating ${args.set.length} example${args.set.length === 1 ? '' : 's'}`
  );

  if (args.adapter) {
    try {
      const evalBatch = await args.adapter.evaluate(
        args.set as any,
        args.cfg,
        args.captureTraces
      );
      if (args.abortSignal?.aborted) {
        args.state.stopReason = 'aborted';
        args.state.totalCalls += requiredCalls;
        return undefined;
      }
      const rows: AxGEPABatchRow[] = [];
      for (const [index, ex] of args.set.entries()) {
        const prediction = evalBatch.outputs[index];
        const scores =
          evalBatch.scoreVectors?.[index] ??
          (Number.isFinite(evalBatch.scores[index])
            ? { score: Number(evalBatch.scores[index]) }
            : zeroScoreVector(args.state.observedScoreKeys));
        for (const key of Object.keys(scores))
          args.state.observedScoreKeys.add(key);
        const explicitScalar = evalBatch.scores[index];
        const scalar = Number.isFinite(explicitScalar)
          ? Number(explicitScalar)
          : args.scalarize(scores);
        // The adapter success path has no `validateConfig` and no per-row
        // failure of its own, so the classifier sees no error and no failure
        // kind. With the default classifier every row completes and admission
        // is a no-op here; only a host classifier reading the adapter's own
        // prediction can discard one.
        const rowTermination =
          args.termination && terminationSink
            ? classifyRow(
                args.termination,
                args.phase,
                {
                  exampleIndex: args.exampleIndices?.[index] ?? index,
                  prediction,
                  nonReclassifiable: nonReclassifiableCandidate,
                },
                terminationSink
              )
            : undefined;
        rows.push({
          input: ex as AxExample,
          prediction,
          scores,
          scalar,
          feedback: normalizeGEPAMetricFeedback(evalBatch.feedback?.[index]),
          ...(rowTermination
            ? {
                termination: rowTermination,
                ...(rowTermination.kind === 'environment_failure'
                  ? { admitted: false }
                  : {}),
              }
            : {}),
        });
        args.state.totalCalls += 1;
        args.verboseLog?.(
          `${args.phase}: completed ${index + 1}/${args.set.length} (score=${scalar.toFixed(3)})`
        );
      }
      return {
        rows,
        avg: avgVec(rows.map((row) => row.scores)),
        scalars: rows.map((row) => row.scalar),
        sum: rows.reduce((total, row) => total + row.scalar, 0),
        trajectories: evalBatch.trajectories ?? undefined,
        ...(args.termination && terminationSink
          ? {
              terminations: terminationSink.terminations,
              ...admissionOf(args.termination, terminationSink),
            }
          : {}),
        ...(args.exampleIndices ? { exampleIndices: args.exampleIndices } : {}),
      };
    } catch (error) {
      if (args.abortSignal?.aborted) {
        args.state.stopReason = 'aborted';
        return undefined;
      }
      failures?.push({
        kind: 'adapter',
        message: error instanceof Error ? error.message : String(error),
      });
      args.verboseLog?.(
        `Evaluation adapter failed during ${args.phase}; falling back to direct evaluation. Error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // The adapter path is a whole-batch try/catch that falls through to this
  // loop, so any rows it already classified must not be counted twice.
  if (terminationSink) {
    terminationSink.terminations = [];
    terminationSink.overriddenRows = 0;
  }
  const rows: AxGEPABatchRow[] = [];
  const trajectories: Array<{
    calls: AxFunctionCallTrace[];
    output?: unknown;
    error?: string;
  }> = [];
  const failedRows = new Set<number>();
  for (const [index, ex] of args.set.entries()) {
    if (args.abortSignal?.aborted) {
      args.state.stopReason = 'aborted';
      return undefined;
    }
    args.state.totalCalls += 1;
    let prediction: unknown;
    let scores: Record<string, number>;
    let metricScalar: number | undefined;
    let feedback: string | undefined;
    const calls: AxFunctionCallTrace[] = [];
    let configError: string | undefined;
    let rowError: string | undefined;
    let rowFailureKind: 'runtime' | 'adapter' | 'validator' | undefined;

    if (args.validateConfig) {
      try {
        args.validateConfig(args.cfg);
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
    }

    if (configError !== undefined) {
      prediction = { error: configError };
      scores = zeroScoreVector(args.state.observedScoreKeys);
      failedRows.add(index);
      rowError = configError;
      rowFailureKind = 'validator';
      if (args.captureTraces) trajectories.push({ calls, error: configError });
      args.verboseLog?.(
        `Evaluation failed during ${args.phase}; scoring this example as zero. Error: ${configError}`
      );
    } else {
      // Applying ordinary components remains a configuration operation: those
      // errors must propagate rather than become candidate rollout scores.
      args.applyConfig(args.cfg);
      try {
        prediction = await args.program.forward(
          args.ai,
          ex as IN,
          {
            sampleCount: args.sampleCount,
            onFunctionCall: args.captureTraces
              ? (call: Readonly<AxFunctionCallTrace>) => {
                  calls.push({ ...call });
                }
              : undefined,
            abortSignal: args.abortSignal,
          } as any
        );
        const metricResult = await normalizeGEPAMetricResult(
          args.metricFn,
          prediction,
          ex as AxExample
        );
        scores = metricResult.scores;
        metricScalar = metricResult.scalar;
        feedback = metricResult.feedback;
        for (const key of Object.keys(scores))
          args.state.observedScoreKeys.add(key);
        if (args.captureTraces)
          trajectories.push({ calls, output: prediction });
      } catch (error) {
        if (args.abortSignal?.aborted) {
          args.state.stopReason = 'aborted';
          return undefined;
        }
        const message = error instanceof Error ? error.message : String(error);
        failures?.push({ kind: 'runtime', message });
        prediction = { error: message };
        scores = zeroScoreVector(args.state.observedScoreKeys);
        failedRows.add(index);
        rowError = message;
        rowFailureKind = 'runtime';
        if (args.captureTraces) trajectories.push({ calls, error: message });
        args.verboseLog?.(
          `Evaluation failed during ${args.phase}; scoring this example as zero. Error: ${message}`
        );
      }
    }

    const scalar = metricScalar ?? args.scalarize(scores);
    // A `validateConfig` failure is the candidate's own config being invalid,
    // so it is never reclassifiable — allowing it would let a host promote a
    // candidate on exactly the subset where its config happens to parse.
    const rowTermination =
      args.termination && terminationSink
        ? classifyRow(
            args.termination,
            args.phase,
            {
              exampleIndex: args.exampleIndices?.[index] ?? index,
              prediction,
              error: rowError,
              failureKind: rowFailureKind,
              nonReclassifiable:
                configError !== undefined || nonReclassifiableCandidate,
            },
            terminationSink
          )
        : undefined;
    rows.push({
      input: ex as AxExample,
      prediction,
      scores,
      scalar,
      feedback,
      ...(rowTermination
        ? {
            termination: rowTermination,
            ...(rowTermination.kind === 'environment_failure'
              ? { admitted: false }
              : {}),
          }
        : {}),
    });
    args.verboseLog?.(
      `${args.phase}: completed ${index + 1}/${args.set.length} (score=${scalar.toFixed(3)})`
    );
  }

  const scoreVectors = normalizeGEPABatchScoreVectors(
    rows.map((row) => row.scores),
    failedRows,
    args.state.observedScoreKeys
  );
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    scores: scoreVectors[index]!,
  }));

  return {
    rows: normalizedRows,
    avg: avgVec(scoreVectors),
    scalars: normalizedRows.map((row) => row.scalar),
    sum: normalizedRows.reduce((total, row) => total + row.scalar, 0),
    trajectories: args.captureTraces ? trajectories : undefined,
    failures: failures?.length ? failures : undefined,
    ...(args.termination && terminationSink
      ? {
          terminations: terminationSink.terminations,
          ...admissionOf(args.termination, terminationSink),
        }
      : {}),
    ...(args.exampleIndices ? { exampleIndices: args.exampleIndices } : {}),
  };
}
