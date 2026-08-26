/**
 * Sequential agent-layer batch evaluation for `agent.playbook().evolve()`.
 *
 * Strictly sequential by design: `_forwardForEvaluation` saves/clears/
 * restores the primary actor's state, discovery state, and llmQuery budget
 * around each call — concurrent calls on one agent instance would interleave
 * those save/restore pairs and corrupt state.
 */

import type { AxAIService } from '../../../ai/types.js';
import type { AxMetricFn } from '../../../dsp/common_types.js';
import type { AxGenIn, AxGenOut } from '../../../dsp/types.js';
import type {
  AxAgentEvalPrediction,
  AxAgentEvalTask,
} from '../agentOptimizeTypes.js';
import type { AxAgentPlaybookEvolveRunRecord } from './playbookEvolveTypes.js';

/** Mutable (run + judge) pair budget shared across all improve() batches. */
export type AxAgentEvalBudget = { remaining: number };

const MAX_RUNS_PER_TASK = 100;
const MAX_METRIC_CALLS = 1_000_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AxAgent.playbook().evolve(): aborted');
  }
}

export type AxAgentEvalBatchResult<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> = {
  records: AxAgentPlaybookEvolveRunRecord<IN, OUT>[];
  /** Weighted mean score over executed records (0 when none ran). */
  mean: number;
  /** True when the budget ran out before every task executed. */
  exhausted: boolean;
  /** Number of agent + metric attempts completed, including failed attempts. */
  executedRuns: number;
  /** Number of attempts required for complete evidence. */
  expectedRuns: number;
  /** False when any run threw or returned a non-finite scalar score. */
  validEvidence: boolean;
  /** First evaluator failure, preserved for fail-closed callers. */
  failure?: unknown;
  /**
   * True only when every requested run completed with a finite metric and the
   * weighted aggregate has finite non-negative weights, positive total weight,
   * and a finite mean.
   */
  complete: boolean;
};

export async function runAgentEvalBatch<
  IN extends AxGenIn,
  OUT extends AxGenOut,
>(args: {
  agent: any;
  ai: Readonly<AxAIService>;
  tasks: readonly AxAgentEvalTask<IN>[];
  metric: AxMetricFn;
  scoreThreshold: number;
  budget: AxAgentEvalBudget;
  /** Runs per task; scores average into one record. Default 1. */
  runsPerTask?: number;
  /** Clone agent and metric inputs per run to preserve an internal corpus. */
  isolateTaskInputs?: boolean;
  abortSignal?: AbortSignal;
}): Promise<AxAgentEvalBatchResult<IN, OUT>> {
  const records: AxAgentPlaybookEvolveRunRecord<IN, OUT>[] = [];
  const runsPerTask = args.runsPerTask ?? 1;
  if (
    !Number.isSafeInteger(runsPerTask) ||
    runsPerTask <= 0 ||
    runsPerTask > MAX_RUNS_PER_TASK
  ) {
    throw new Error(
      `AxAgent.playbook().evolve(): runsPerTask must be a positive safe integer at most ${MAX_RUNS_PER_TASK}.`
    );
  }
  if (
    !Number.isSafeInteger(args.budget.remaining) ||
    args.budget.remaining < 0 ||
    args.budget.remaining > MAX_METRIC_CALLS
  ) {
    throw new Error(
      `AxAgent.playbook().evolve(): metric budget must be a non-negative safe integer at most ${MAX_METRIC_CALLS}.`
    );
  }
  let exhausted = false;
  let executedRuns = 0;
  let validEvidence = true;
  let failure: unknown;
  let hasFailure = false;

  for (const task of args.tasks) {
    const scores: number[] = [];
    let lastPrediction: AxAgentEvalPrediction<OUT> | undefined;
    let lastError: string | undefined;

    for (let run = 0; run < runsPerTask; run++) {
      throwIfAborted(args.abortSignal);
      if (args.budget.remaining <= 0) {
        exhausted = true;
        break;
      }
      args.budget.remaining--;
      executedRuns++;

      try {
        const agentTask = args.isolateTaskInputs ? structuredClone(task) : task;
        const prediction = await args.agent._forwardForEvaluation(
          args.ai,
          agentTask,
          {
            ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
          }
        );
        throwIfAborted(args.abortSignal);
        const metricTask = args.isolateTaskInputs
          ? structuredClone(task)
          : task;
        const metricResult = await args.metric({
          prediction: prediction as Record<string, unknown>,
          example:
            metricTask as unknown as Parameters<AxMetricFn>[0]['example'],
        });
        throwIfAborted(args.abortSignal);
        const score =
          typeof metricResult === 'number' ? metricResult : metricResult.score;
        const validScore = Number.isFinite(score);
        scores.push(validScore ? score : 0);
        validEvidence &&= validScore;
        if (!validScore) {
          lastError = 'metric returned a non-finite score';
          if (!hasFailure) {
            failure = new TypeError(
              'AxAgent.playbook().evolve(): evaluator metric must return a finite score.'
            );
            hasFailure = true;
          }
        }
        lastPrediction = prediction;
      } catch (err) {
        if (args.abortSignal?.aborted) {
          throw err;
        }
        scores.push(0);
        validEvidence = false;
        lastError = err instanceof Error ? err.message : String(err);
        if (!hasFailure) {
          failure = err;
          hasFailure = true;
        }
      }
    }

    if (scores.length === 0) {
      // Budget ran out before this task's first run.
      break;
    }
    const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    records.push({
      task,
      ...(lastPrediction ? { prediction: lastPrediction } : {}),
      score: mean,
      passed:
        mean >= args.scoreThreshold &&
        lastPrediction?.completionType === 'final',
      ...(lastError && !lastPrediction ? { error: lastError } : {}),
    });
    if (exhausted) {
      break;
    }
  }

  let weightSum = 0;
  let scoreSum = 0;
  let weightsValid = true;
  for (const record of records) {
    const weight = record.task.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      weightsValid = false;
    }
    weightSum += weight;
    scoreSum += weight * record.score;
  }
  const aggregateMean = weightSum > 0 ? scoreSum / weightSum : 0;
  return {
    records,
    mean: aggregateMean,
    exhausted,
    executedRuns,
    expectedRuns: args.tasks.length * runsPerTask,
    validEvidence,
    ...(hasFailure ? { failure } : {}),
    complete:
      !exhausted &&
      validEvidence &&
      executedRuns === args.tasks.length * runsPerTask &&
      records.length === args.tasks.length &&
      weightsValid &&
      Number.isFinite(weightSum) &&
      weightSum > 0 &&
      Number.isFinite(aggregateMean),
  };
}
