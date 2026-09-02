/**
 * Sequential agent-layer batch evaluation for `agent.playbook().evolve()`.
 *
 * Strictly sequential by design: `_forwardForEvaluation` saves/clears/
 * restores the primary actor's state, discovery state, and llmQuery budget
 * around each call — concurrent calls on one agent instance would interleave
 * those save/restore pairs and corrupt state.
 *
 * With no classifier supplied the batch is arithmetically identical to the
 * pre-evidence implementation: `discardedRuns` is always 0, no attempt is ever
 * re-drawn, and `complete` reduces to the old predicate.
 */

import type { AxAIService } from '../../../ai/types.js';
import type { AxMetricFn } from '../../../dsp/common_types.js';
import type { AxGenIn, AxGenOut, AxProgramUsage } from '../../../dsp/types.js';
import type {
  AxAgentEvalPrediction,
  AxAgentEvalTask,
} from '../agentOptimizeTypes.js';
import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentPlaybookSplitName,
  AxAgentPlaybookTerminationSplit,
  AxAgentTrajectoryClassifier,
  AxAgentTrajectoryTermination,
} from './playbookEvidenceTypes.js';
import type { AxAgentPlaybookEvolveRunRecord } from './playbookEvolveTypes.js';
import {
  classifyAttempt,
  createTerminationTally,
  defaultTerminationOf,
  extractErrorIdentity,
  modelIdentityOf,
  tallyTermination,
  terminationSplitOf,
  totalTokensOf,
} from './termination.js';

/** Mutable (run + judge) pair budget shared across all improve() batches. */
export type AxAgentEvalBudget = { remaining: number };

const MAX_RUNS_PER_TASK = 100;
const MAX_METRIC_CALLS = 1_000_000;
const MAX_DISCARD_REDRAWS = 10;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AxAgent.playbook().evolve(): aborted');
  }
}

/**
 * Per-attempt observer, invoked once for every attempt the batch makes,
 * including re-draws and discarded attempts. Used by the reach collector; it
 * must never throw (the collector bounds and records its own faults).
 */
export type AxAgentEvalAttemptObserver<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> = (
  args: Readonly<{
    task: Readonly<AxAgentEvalTask<IN>>;
    taskIndex: number;
    prediction?: Readonly<AxAgentEvalPrediction<OUT>>;
    attempt: Readonly<AxAgentPlaybookAttemptRecord>;
    split: AxAgentPlaybookSplitName;
    sliceName?: string;
  }>
) => void;

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
  /**
   * Attempts a host classifier declared `environment_failure`. They consumed
   * budget and are NEVER scored as zeros. Always 0 without a classifier.
   */
  discardedRuns: number;
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
  /** Wall clock of the batch, from the injected clock. */
  durationMs: number;
  /** Every usage record observed on this batch's predictions. */
  usage: readonly AxProgramUsage[];
  /**
   * Index of the task the batch stopped at because the metric budget ran out.
   * Set ONLY for genuine exhaustion: a task whose every attempt was discarded
   * does not truncate the batch, it is counted in
   * `termination.tasksWithNoScoredAttempt` and evaluation continues.
   */
  truncatedAtTaskIndex?: number;
  /** Per-split termination counters for this batch. */
  termination: AxAgentPlaybookTerminationSplit;
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
  /** Host-owned trajectory classification. Absent means today's behaviour. */
  classifyTermination?: AxAgentTrajectoryClassifier<IN, OUT>;
  /** Bounded re-draws per discarded attempt, from the SAME budget. Default 0. */
  maxDiscardRedraws?: number;
  /**
   * Attach per-attempt records to every run record. Off by default so a legacy
   * call's `records` stay byte-identical; the orchestrator turns it on as soon
   * as any evidence option is set.
   */
  captureAttempts?: boolean;
  /** Split label carried onto attempt records and the termination counters. */
  split?: AxAgentPlaybookSplitName;
  sliceName?: string;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  onAttempt?: AxAgentEvalAttemptObserver<IN, OUT>;
  /**
   * Maps the task handed to the AGENT onto the task handed to the METRIC.
   * Identity unless supplied. Exists for the self-refinement control arm, which
   * re-invokes the program with its own previous output while the metric must
   * keep scoring the original example.
   */
  metricTaskOf?: (task: AxAgentEvalTask<IN>) => AxAgentEvalTask<IN>;
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
  const maxDiscardRedraws = args.maxDiscardRedraws ?? 0;
  if (
    !Number.isSafeInteger(maxDiscardRedraws) ||
    maxDiscardRedraws < 0 ||
    maxDiscardRedraws > MAX_DISCARD_REDRAWS
  ) {
    throw new Error(
      `AxAgent.playbook().evolve(): maxDiscardRedraws must be a non-negative safe integer at most ${MAX_DISCARD_REDRAWS}.`
    );
  }
  const now = args.now ?? Date.now;
  const split: AxAgentPlaybookSplitName = args.split ?? 'current';
  const expectedRuns = args.tasks.length * runsPerTask;
  const tally = createTerminationTally(split, expectedRuns, args.sliceName);
  const startedAt = now();

  let exhausted = false;
  let executedRuns = 0;
  let discardedRuns = 0;
  let validEvidence = true;
  let failure: unknown;
  let hasFailure = false;
  let truncatedAtTaskIndex: number | undefined;
  const usage: AxProgramUsage[] = [];

  /** One agent + metric attempt. Consumes exactly one unit of budget. */
  const runAttempt = async (
    task: AxAgentEvalTask<IN>
  ): Promise<{
    score: number;
    validScore: boolean;
    prediction?: AxAgentEvalPrediction<OUT>;
    error?: unknown;
    errorMessage?: string;
  }> => {
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
      // The self-refinement control arm hands the AGENT a task whose input
      // carries the previous answer plus a critique instruction, and must hand
      // the METRIC the original task — otherwise a metric that reads
      // `example.input` would score a different example on every refinement
      // round. Identity for every other caller.
      const scoredTask = args.metricTaskOf ? args.metricTaskOf(task) : task;
      const metricTask = args.isolateTaskInputs
        ? structuredClone(scoredTask)
        : scoredTask;
      const metricResult = await args.metric({
        prediction: prediction as Record<string, unknown>,
        example: metricTask as unknown as Parameters<AxMetricFn>[0]['example'],
      });
      throwIfAborted(args.abortSignal);
      const score =
        typeof metricResult === 'number' ? metricResult : metricResult.score;
      const validScore = Number.isFinite(score);
      return {
        score: validScore ? score : 0,
        validScore,
        prediction,
        ...(validScore
          ? {}
          : { errorMessage: 'metric returned a non-finite score' }),
      };
    } catch (err) {
      if (args.abortSignal?.aborted) {
        throw err;
      }
      return {
        score: 0,
        validScore: false,
        error: err,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  };

  for (const [taskIndex, task] of args.tasks.entries()) {
    const scores: number[] = [];
    const attempts: AxAgentPlaybookAttemptRecord[] = [];
    let lastPrediction: AxAgentEvalPrediction<OUT> | undefined;
    let lastError: string | undefined;
    let budgetExhaustedForThisTask = false;

    for (let run = 0; run < runsPerTask; run++) {
      throwIfAborted(args.abortSignal);
      if (args.budget.remaining <= 0) {
        exhausted = true;
        budgetExhaustedForThisTask = scores.length === 0;
        break;
      }

      let redraw = 0;
      let termination: AxAgentTrajectoryTermination;
      let outcome: Awaited<ReturnType<typeof runAttempt>>;

      // The re-draw loop: a discarded attempt may be re-run from the SAME
      // budget, up to maxDiscardRedraws, so one provider hiccup at
      // runsPerTask: 1 does not reject a candidate with a false reason.
      for (;;) {
        args.budget.remaining--;
        const attemptStartedAt = now();
        outcome = await runAttempt(task);
        const latencyMs = now() - attemptStartedAt;
        const identity = extractErrorIdentity(outcome.error);
        const fallback = defaultTerminationOf({
          ...(outcome.prediction ? { prediction: outcome.prediction } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          validScore: outcome.validScore,
        });
        termination = classifyAttempt({
          ...(args.classifyTermination
            ? { classifier: args.classifyTermination }
            : {}),
          classifierArgs: {
            task,
            ...(outcome.prediction ? { prediction: outcome.prediction } : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            ...identity,
            attempt: run,
            redraw,
            split,
            ...(args.sliceName ? { sliceName: args.sliceName } : {}),
          },
          fallback,
        });
        const discarded = termination.kind === 'environment_failure';
        const attemptUsage = outcome.prediction?.usage;
        if (attemptUsage?.length) usage.push(...attemptUsage);
        const model = modelIdentityOf(attemptUsage);
        const totalTokens = totalTokensOf(attemptUsage);
        const attemptRecord: AxAgentPlaybookAttemptRecord = {
          attempt: run,
          redraw,
          ...(discarded ? {} : { score: outcome.score }),
          termination,
          ...identity,
          callCount: outcome.prediction?.functionCalls?.length ?? 0,
          turnCount: outcome.prediction?.turnCount ?? 0,
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          latencyMs,
          ...(model ? { model } : {}),
        };
        attempts.push(attemptRecord);
        tallyTermination(tally, termination);
        args.onAttempt?.({
          task,
          taskIndex,
          ...(outcome.prediction ? { prediction: outcome.prediction } : {}),
          attempt: attemptRecord,
          split,
          ...(args.sliceName ? { sliceName: args.sliceName } : {}),
        });
        if (
          !discarded ||
          redraw >= maxDiscardRedraws ||
          args.budget.remaining <= 0
        ) {
          break;
        }
        redraw++;
        tally.redraws++;
      }

      if (termination.kind === 'environment_failure') {
        // An environment failure is not evidence about the artifact: it leaves
        // the score denominator entirely rather than being scored as a zero.
        discardedRuns++;
        continue;
      }
      executedRuns++;
      scores.push(outcome.score);
      validEvidence &&= outcome.validScore;
      if (!outcome.validScore) {
        lastError = outcome.errorMessage;
        if (!hasFailure) {
          failure =
            outcome.error ??
            new TypeError(
              'AxAgent.playbook().evolve(): evaluator metric must return a finite score.'
            );
          hasFailure = true;
        }
      }
      if (outcome.prediction) lastPrediction = outcome.prediction;
    }

    if (scores.length === 0) {
      if (budgetExhaustedForThisTask) {
        // Genuine exhaustion: stop, as before, and say where.
        truncatedAtTaskIndex = taskIndex;
        break;
      }
      // Every attempt was discarded with budget remaining. Keep measuring the
      // rest of the split — a `break` here would report a mean over a silent
      // prefix while still looking like a complete evaluation.
      tally.tasksWithNoScoredAttempt++;
      continue;
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
      ...(args.captureAttempts ||
      args.classifyTermination ||
      maxDiscardRedraws > 0
        ? { attempts }
        : {}),
    });
    if (exhausted) {
      truncatedAtTaskIndex ??= taskIndex + 1;
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
    discardedRuns,
    expectedRuns,
    validEvidence,
    ...(hasFailure ? { failure } : {}),
    complete:
      !exhausted &&
      validEvidence &&
      executedRuns + discardedRuns === expectedRuns &&
      records.length === args.tasks.length &&
      weightsValid &&
      Number.isFinite(weightSum) &&
      weightSum > 0 &&
      Number.isFinite(aggregateMean),
    durationMs: now() - startedAt,
    usage,
    ...(truncatedAtTaskIndex !== undefined ? { truncatedAtTaskIndex } : {}),
    termination: terminationSplitOf(tally),
  };
}
