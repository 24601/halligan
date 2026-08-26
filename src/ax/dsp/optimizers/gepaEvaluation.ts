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

export type AxGEPABatchRow = {
  input: AxExample;
  prediction: unknown;
  scores: Record<string, number>;
  scalar: number;
  feedback?: string;
};

export type AxGEPABatchEvaluation = {
  rows: AxGEPABatchRow[];
  avg: Record<string, number>;
  scalars: number[];
  sum: number;
  trajectories?: readonly unknown[];
  failures?: readonly {
    kind: 'runtime' | 'adapter';
    message: string;
  }[];
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
  scalarize: (scores: Readonly<Record<string, number>>) => number;
  verboseLog?: (message: string) => void;
  throwIfInsufficient?: boolean;
  captureTraces?: boolean;
  captureFailures?: boolean;
  abortSignal?: AbortSignal;
}): Promise<AxGEPABatchEvaluation | undefined> {
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
        rows.push({
          input: ex as AxExample,
          prediction,
          scores,
          scalar,
          feedback: normalizeGEPAMetricFeedback(evalBatch.feedback?.[index]),
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
    args.applyConfig(args.cfg);
    args.state.totalCalls += 1;
    let prediction: unknown;
    let scores: Record<string, number>;
    let metricScalar: number | undefined;
    let feedback: string | undefined;
    const calls: AxFunctionCallTrace[] = [];

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
      if (args.captureTraces) trajectories.push({ calls, output: prediction });
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
      if (args.captureTraces) trajectories.push({ calls, error: message });
      args.verboseLog?.(
        `Evaluation failed during ${args.phase}; scoring this example as zero. Error: ${message}`
      );
    }

    const scalar = metricScalar ?? args.scalarize(scores);
    rows.push({
      input: ex as AxExample,
      prediction,
      scores,
      scalar,
      feedback,
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
  };
}
