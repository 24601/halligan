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
};

export type AxGEPAEvaluationState = {
  totalCalls: number;
  observedScoreKeys: Set<string>;
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

const MAX_METRIC_FEEDBACK_CHARS = 4_000;

export const normalizeGEPAMetricFeedback = (
  feedback: unknown
): string | undefined => {
  if (typeof feedback !== 'string') return undefined;
  const sanitized = [...feedback.replace(/\r\n?/g, '\n')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        character === '\n' ||
        character === '\t' ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join('')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.slice(0, MAX_METRIC_FEEDBACK_CHARS);
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
    typeof (raw as any).feedback === 'string' ||
    ((raw as any).scores !== null && typeof (raw as any).scores === 'object');
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
}): Promise<AxGEPABatchEvaluation | undefined> {
  const requiredCalls = args.set.length;
  if (args.state.totalCalls + requiredCalls > args.maxMetricCalls) {
    if (args.throwIfInsufficient) {
      throw new Error(
        `AxGEPA: options.maxMetricCalls=${args.maxMetricCalls} is too small to evaluate the initial Pareto set; need at least ${requiredCalls} metric calls`
      );
    }
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
        const scalar = args.scalarize(scores);
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
  for (const [index, ex] of args.set.entries()) {
    args.applyConfig(args.cfg);
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
      const message = error instanceof Error ? error.message : String(error);
      prediction = { error: message };
      scores = zeroScoreVector(args.state.observedScoreKeys);
      if (args.captureTraces) trajectories.push({ calls, error: message });
      args.verboseLog?.(
        `Evaluation failed during ${args.phase}; scoring this example as zero. Error: ${message}`
      );
    }

    args.state.totalCalls += 1;
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

  return {
    rows,
    avg: avgVec(rows.map((row) => row.scores)),
    scalars: rows.map((row) => row.scalar),
    sum: rows.reduce((total, row) => total + row.scalar, 0),
    trajectories: args.captureTraces ? trajectories : undefined,
  };
}
