import type { AxAIService } from '../../ai/types.js';
import type {
  AxExample,
  AxMetricFn,
  AxMultiMetricFn,
} from '../common_types.js';
import type {
  AxFunctionCallTrace,
  AxGenOut,
  AxProgrammable,
} from '../types.js';
import type { AxGEPAAdapter, AxGEPAEvaluationBatch } from './gepaAdapter.js';
import {
  normalizeGEPAMetricResult,
  scalarizeGEPAScores,
} from './gepaEvaluation.js';

export type AxRolloutTrace<Out = unknown> = {
  calls: AxFunctionCallTrace[];
  output?: Out;
  error?: string;
};

type AxGenAdapterOptions<IN, OUT extends AxGenOut> = {
  program: AxProgrammable<IN, OUT>;
  ai: AxAIService;
  metricFn: AxMetricFn | AxMultiMetricFn;
  sampleCount: number;
};

function componentFunctionId(componentKey: string): string | undefined {
  const marker = '::fn:';
  const start = componentKey.indexOf(marker);
  if (start < 0) return undefined;
  const rest = componentKey.slice(start + marker.length);
  const [id] = rest.split(':');
  return id || undefined;
}

function traceMentionsFunction(
  trace: Readonly<AxRolloutTrace>,
  functionId: string
): boolean {
  return trace.calls.some((call) => call.componentId === functionId);
}

export function createAxGenAdapter<IN, OUT extends AxGenOut>({
  program,
  ai,
  metricFn,
  sampleCount,
}: AxGenAdapterOptions<IN, OUT>): AxGEPAAdapter<
  IN,
  AxRolloutTrace<OUT>,
  OUT | { error: string }
> {
  const applyConfig = (candidate: Readonly<Record<string, string>>) => {
    const fn = (program as any).applyOptimizedComponents;
    if (typeof fn === 'function') fn.call(program, candidate);
  };

  return {
    async evaluate(batch, candidate, captureTraces = false) {
      applyConfig(candidate);
      const outputs: Array<OUT | { error: string }> = [];
      const scores: number[] = [];
      const scoreVectors: Record<string, number>[] = [];
      const feedback: Array<string | undefined> = [];
      const trajectories: AxRolloutTrace<OUT>[] = [];

      for (const datum of batch) {
        const calls: AxFunctionCallTrace[] = [];
        try {
          const output = await program.forward(ai, datum, {
            sampleCount,
            onFunctionCall: captureTraces
              ? (call: Readonly<AxFunctionCallTrace>) => {
                  calls.push({ ...call });
                }
              : undefined,
          } as any);
          outputs.push(output);
          const metricResult = await normalizeGEPAMetricResult(
            metricFn,
            output,
            datum as AxExample
          );
          const score =
            metricResult.scalar ?? scalarizeGEPAScores(metricResult.scores);
          scores.push(score);
          scoreVectors.push(metricResult.scores);
          feedback.push(metricResult.feedback);
          if (captureTraces) trajectories.push({ calls, output });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outputs.push({ error: message });
          scores.push(0);
          const observedKeys = new Set<string>();
          for (const vector of scoreVectors) {
            for (const key of Object.keys(vector)) observedKeys.add(key);
          }
          scoreVectors.push(
            observedKeys.size === 0
              ? { score: 0 }
              : Object.fromEntries([...observedKeys].map((key) => [key, 0]))
          );
          feedback.push(undefined);
          if (captureTraces) trajectories.push({ calls, error: message });
        }
      }

      return {
        outputs,
        scores,
        scoreVectors,
        feedback,
        trajectories: captureTraces ? trajectories : undefined,
      } satisfies AxGEPAEvaluationBatch<
        AxRolloutTrace<OUT>,
        OUT | { error: string }
      >;
    },

    make_reflective_dataset(_candidate, evalBatch, componentsToUpdate) {
      const traces = evalBatch.trajectories ?? [];
      const out: Record<string, any[]> = {};
      for (const key of componentsToUpdate) {
        const functionId = componentFunctionId(key);
        const relevant = traces
          .map((trace, index) => ({
            trace,
            score: Number(evalBatch.scores[index] ?? 0),
            feedback: evalBatch.feedback?.[index],
          }))
          .filter(({ trace, score }) => {
            if (!functionId) return true;
            return traceMentionsFunction(trace, functionId) || score === 0;
          });
        out[key] = relevant.map(({ trace, score, feedback }) => ({
          score,
          feedback,
          calls: trace.calls,
          output: trace.output,
          error: trace.error,
        }));
      }
      return out;
    },
  };
}
