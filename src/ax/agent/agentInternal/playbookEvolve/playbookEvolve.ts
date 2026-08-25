/**
 * `agent.playbook().evolve()` orchestrator — verified (or trust-batch)
 * playbook learning from a task set:
 *
 *   baseline batch eval → deterministic failure clustering → per-cluster
 *   grounded weakness mining → bounded playbook proposal → (verify) sequential
 *   accept gate.
 *
 * With `verify` (default) a proposal is kept only when the held-in (train)
 * score improves by at least `minHeldInGain` AND the held-out (validation)
 * score does not drop by more than `epsilon`; rejected proposals roll back
 * exactly, and accepted scores become the next proposal's baseline. With
 * `verify: false` the mined lessons are applied without the gate (trust-batch).
 * `requireHeldOut` adds a fail-closed production promotion policy on top.
 */

import type { AxGenIn, AxGenOut } from '../../../dsp/types.js';
import { normalizeAgentEvalDataset } from '../../optimize.js';
import type {
  AxAgentEvalDataset,
  AxAgentEvalTask,
  AxAgentJudgeOptions,
} from '../agentOptimizeTypes.js';
import { createAgentOptimizeMetric } from '../optimizer.js';
import type { AxAgentEvalBudget } from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import { clusterFailures } from './failureClusters.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveOutcome,
  AxAgentPlaybookEvolveResult,
  AxAgentPlaybookWeakness,
} from './playbookEvolveTypes.js';
import type { AxAppliedProposal } from './proposals.js';
import {
  applyProposal,
  buildProposal,
  currentPlaybookText,
} from './proposals.js';
import { mineWeakness } from './weaknessMiner.js';

const DEFAULT_MAX_PROPOSALS = 4;
const DEFAULT_EPSILON = 0.01;
const DEFAULT_MIN_HELD_IN_GAIN = 0.05;
const DEFAULT_SCORE_THRESHOLD = 0.7;

function assertRequiredHeldOut<IN extends AxGenIn>(args: {
  train: readonly AxAgentEvalTask<IN>[];
  validation?: readonly AxAgentEvalTask<IN>[];
  taskId?: (task: Readonly<AxAgentEvalTask<IN>>) => string | undefined;
}): void {
  if (!args.validation?.length) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut requires a non-empty validation set.'
    );
  }
  const idOf = args.taskId ?? ((task: AxAgentEvalTask<IN>) => task.id);
  const ids = (split: 'train' | 'validation', tasks: typeof args.train) =>
    tasks.map((task, index) => {
      const id = idOf(task)?.trim();
      if (!id) {
        throw new Error(
          `AxAgent.playbook().evolve(): requireHeldOut cannot prove disjointness: ${split}[${index}] has no semantic task id; set task.id or provide taskId.`
        );
      }
      return id;
    });
  const trainIds = new Set(ids('train', args.train));
  const overlaps = [
    ...new Set(
      ids('validation', args.validation).filter((id) => trainIds.has(id))
    ),
  ];
  if (overlaps.length > 0) {
    throw new Error(
      `AxAgent.playbook().evolve(): requireHeldOut requires disjoint train and validation sets; overlapping task id(s): ${overlaps.join(', ')}.`
    );
  }
}

export async function evolveAgentPlaybook<
  IN extends AxGenIn,
  OUT extends AxGenOut,
>(
  self: any,
  dataset: Readonly<AxAgentEvalDataset<IN>>,
  options?: Readonly<AxAgentPlaybookEvolveOptions<IN>>
): Promise<AxAgentPlaybookEvolveResult<OUT>> {
  const s = self as any;
  const normalized = normalizeAgentEvalDataset(dataset);
  if (normalized.train.length === 0) {
    throw new Error(
      'AxAgent.playbook().evolve(): at least one training task is required.'
    );
  }
  const requireHeldOut = options?.requireHeldOut === true;
  if (requireHeldOut && options?.verify === false) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut cannot be combined with verify: false.'
    );
  }
  if (requireHeldOut) {
    assertRequiredHeldOut({
      train: normalized.train,
      validation: normalized.validation,
      ...(options?.taskId ? { taskId: options.taskId } : {}),
    });
  }

  const studentAI = options?.studentAI ?? s.init?.ai ?? s.ai;
  if (!studentAI) {
    throw new Error(
      'AxAgent.playbook().evolve(): studentAI is required when the agent has no default ai.'
    );
  }
  const agentJudgeAI = s.init?.judgeAI ?? s.judgeAI;
  const teacherAI = options?.teacherAI ?? agentJudgeAI ?? studentAI;
  const judgeAI =
    options?.judgeAI ?? agentJudgeAI ?? options?.teacherAI ?? studentAI;
  const judgeOptions: AxAgentJudgeOptions = {
    ...(s.judgeOptions ?? {}),
    ...(options?.judgeOptions ?? {}),
  };
  const metric =
    options?.metric ?? createAgentOptimizeMetric(self, judgeAI, judgeOptions);

  const verify = options?.verify !== false;
  const maxProposals = Math.max(
    1,
    Math.floor(options?.maxProposals ?? DEFAULT_MAX_PROPOSALS)
  );
  const runsPerTask = Math.max(1, Math.floor(options?.runsPerTask ?? 1));
  const datasetSize =
    (normalized.train.length + (normalized.validation?.length ?? 0)) *
    runsPerTask;
  const maxMetricCalls = Math.max(
    1,
    Math.floor(
      options?.maxMetricCalls ?? Math.max(100, (maxProposals + 1) * datasetSize)
    )
  );
  if (
    requireHeldOut &&
    (!Number.isFinite(runsPerTask) || !Number.isFinite(maxMetricCalls))
  ) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut requires finite runsPerTask and maxMetricCalls.'
    );
  }
  if (requireHeldOut && maxMetricCalls < datasetSize * 2) {
    throw new Error(
      `AxAgent.playbook().evolve(): requireHeldOut needs at least ${datasetSize * 2} metric calls for one complete baseline + candidate evaluation; maxMetricCalls is ${maxMetricCalls}.`
    );
  }
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const minHeldInGain = options?.minHeldInGain ?? DEFAULT_MIN_HELD_IN_GAIN;
  const scoreThreshold = options?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  if (
    requireHeldOut &&
    (!Number.isFinite(epsilon) ||
      epsilon < 0 ||
      !Number.isFinite(minHeldInGain) ||
      minHeldInGain < 0)
  ) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut requires finite, non-negative epsilon and minHeldInGain.'
    );
  }
  const budget: AxAgentEvalBudget = { remaining: maxMetricCalls };
  const usedCalls = () => maxMetricCalls - budget.remaining;

  const progress = (
    phase: 'baseline' | 'mining' | 'proposal' | 'validation' | 'done',
    message: string
  ) => {
    options?.onProgress?.({ phase, message, metricCallsUsed: usedCalls() });
    if (options?.verbose) {
      console.log(`[playbook.evolve] ${phase}: ${message}`);
    }
  };

  const batchArgs = {
    agent: s,
    ai: studentAI,
    metric,
    scoreThreshold,
    budget,
    runsPerTask,
    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };

  // The playbook handle to curate into. The caller (agent.playbook().evolve)
  // ensures one exists; fall back to attaching one so a bare call still works.
  const playbookHandle =
    s.getPlaybook?.() ??
    (() => {
      const handle = s._buildStagePlaybook({
        target: 'actor',
        studentAI,
        teacherAI,
        maxReflectorRounds: 1,
      });
      s.playbookHandle = handle;
      return handle;
    })();

  // ---- Baseline ----
  progress('baseline', `evaluating ${normalized.train.length} train tasks`);
  const baselineTrain = await runAgentEvalBatch<IN, OUT>({
    ...batchArgs,
    tasks: normalized.train,
  });
  if (requireHeldOut && !baselineTrain.complete) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut held-in baseline evaluation was incomplete or errored.'
    );
  }
  let heldIn = baselineTrain.mean;
  let heldOut: number | undefined;
  if (normalized.validation?.length) {
    progress(
      'baseline',
      `evaluating ${normalized.validation.length} validation tasks`
    );
    const baselineHeldOut = await runAgentEvalBatch<IN, OUT>({
      ...batchArgs,
      tasks: normalized.validation,
    });
    if (requireHeldOut && !baselineHeldOut.complete) {
      throw new Error(
        'AxAgent.playbook().evolve(): requireHeldOut held-out baseline evaluation was incomplete or errored.'
      );
    }
    heldOut = baselineHeldOut.mean;
  }
  const baseline = {
    heldIn,
    ...(heldOut !== undefined ? { heldOut } : {}),
  };

  // ---- Mine weaknesses from failure clusters ----
  const clusters = clusterFailures(
    baselineTrain.records,
    scoreThreshold,
    maxProposals
  );
  progress(
    'mining',
    `${clusters.length} failure cluster(s) from ${baselineTrain.records.length} records`
  );

  const weaknesses: AxAgentPlaybookWeakness[] = [];
  for (const [index, cluster] of clusters.entries()) {
    if (options?.abortSignal?.aborted) {
      throw new Error('AxAgent.playbook().evolve(): aborted');
    }
    try {
      const weakness = await mineWeakness({
        ai: teacherAI,
        cluster,
        currentPlaybook: currentPlaybookText(s),
        index,
      });
      if (weakness) {
        weaknesses.push(weakness);
        progress('mining', `${weakness.id} [${weakness.clusterSignature}]`);
      } else {
        progress(
          'mining',
          `cluster [${cluster.signature}] discarded (no grounded evidence)`
        );
      }
    } catch (err) {
      progress(
        'mining',
        `cluster [${cluster.signature}] miner failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- Sequential propose -> (verify) accept/reject ----
  const outcomes: AxAgentPlaybookEvolveOutcome[] = [];
  const accepted: AxAppliedProposal[] = [];

  for (const weakness of weaknesses) {
    if (options?.abortSignal?.aborted) {
      throw new Error('AxAgent.playbook().evolve(): aborted');
    }
    const proposal = buildProposal(weakness);
    const requiredCalls =
      (normalized.train.length + (normalized.validation?.length ?? 0)) *
      runsPerTask;
    if (verify && budget.remaining < requiredCalls) {
      outcomes.push({
        proposal,
        status: 'rejected',
        accepted: false,
        reason: 'metric_budget exhausted before validation',
        heldIn: { before: heldIn, after: heldIn },
      });
      progress('validation', `${weakness.id}: budget exhausted, skipped`);
      continue;
    }

    progress('proposal', `${weakness.id}: applying playbook proposal`);
    let applied: AxAppliedProposal;
    try {
      applied = await applyProposal({ proposal, playbookHandle });
    } catch (err) {
      outcomes.push({
        proposal,
        status: 'rejected',
        accepted: false,
        reason: `apply failed: ${err instanceof Error ? err.message : String(err)}`,
        heldIn: { before: heldIn, after: heldIn },
      });
      continue;
    }

    // Trust-batch: keep the lesson without a gate.
    if (!verify) {
      accepted.push(applied);
      outcomes.push({
        proposal,
        status: 'accepted',
        accepted: true,
        reason: 'applied without verification (verify: false)',
        heldIn: { before: heldIn, after: heldIn },
      });
      progress('validation', `${weakness.id}: applied (trust-batch)`);
      continue;
    }

    let revalTrain: Awaited<ReturnType<typeof runAgentEvalBatch<IN, OUT>>>;
    let revalHeldOutBatch:
      | Awaited<ReturnType<typeof runAgentEvalBatch<IN, OUT>>>
      | undefined;
    try {
      revalTrain = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks: normalized.train,
      });
      if (normalized.validation?.length) {
        revalHeldOutBatch = await runAgentEvalBatch<IN, OUT>({
          ...batchArgs,
          tasks: normalized.validation,
        });
      }
    } catch (err) {
      applied.rollback();
      throw err;
    }
    let revalHeldOut: number | undefined;
    let revalHeldOutExhausted = false;
    if (revalHeldOutBatch) {
      revalHeldOut = revalHeldOutBatch.mean;
      revalHeldOutExhausted = revalHeldOutBatch.exhausted;
    }

    // A re-eval that exhausted mid-way produced a subset mean — comparing it
    // to the full-set baseline is apples-to-oranges, so refuse the accept.
    const revalComplete = requireHeldOut
      ? revalTrain.complete && revalHeldOutBatch?.complete === true
      : !revalTrain.exhausted && !revalHeldOutExhausted;
    const gainOk = revalComplete && revalTrain.mean - heldIn >= minHeldInGain;
    const heldOutOk =
      revalHeldOut === undefined ||
      heldOut === undefined ||
      revalHeldOut - heldOut >= -epsilon;
    const accept = revalComplete && gainOk && heldOutOk;

    outcomes.push({
      proposal,
      status: accept ? 'accepted' : 'rejected',
      accepted: accept,
      reason:
        requireHeldOut && !revalTrain.complete
          ? 'held-in evaluation incomplete or errored'
          : requireHeldOut && revalHeldOutBatch?.complete !== true
            ? 'held-out evaluation incomplete or errored'
            : !revalComplete
              ? 'metric_budget exhausted during re-evaluation'
              : accept
                ? heldOut === undefined
                  ? 'held-in improved (no held-out set provided — consider one)'
                  : 'held-in improved, held-out non-regressing'
                : !gainOk
                  ? `held-in gain ${(revalTrain.mean - heldIn).toFixed(3)} below ${minHeldInGain}`
                  : `held-out regressed ${((revalHeldOut ?? 0) - (heldOut ?? 0)).toFixed(3)}`,
      heldIn: { before: heldIn, after: revalTrain.mean },
      ...(revalHeldOut !== undefined && heldOut !== undefined
        ? { heldOut: { before: heldOut, after: revalHeldOut } }
        : {}),
    });

    if (accept) {
      accepted.push(applied);
      heldIn = revalTrain.mean;
      if (revalHeldOut !== undefined) {
        heldOut = revalHeldOut;
      }
      progress('validation', `${weakness.id}: ACCEPTED`);
    } else {
      applied.rollback();
      progress('validation', `${weakness.id}: rejected, rolled back`);
    }
  }

  // ---- Finalize ----
  const playbookSnapshot =
    accepted.length > 0 ? playbookHandle?.getState() : undefined;

  if (options?.apply === false) {
    for (const applied of [...accepted].reverse()) {
      applied.rollback();
    }
  }

  progress(
    'done',
    `${accepted.length}/${outcomes.length} proposals accepted; held-in ${baseline.heldIn.toFixed(3)} -> ${heldIn.toFixed(3)}`
  );

  return {
    baseline,
    final: { heldIn, ...(heldOut !== undefined ? { heldOut } : {}) },
    weaknesses,
    outcomes,
    recommendations: weaknesses.flatMap((w) => w.configRecommendations),
    ...(playbookSnapshot ? { playbookSnapshot } : {}),
    metricCallsUsed: usedCalls(),
    records: baselineTrain.records,
  };
}
