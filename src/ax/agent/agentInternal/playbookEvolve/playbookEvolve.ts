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
 */

import type { AxGenIn, AxGenOut } from '../../../dsp/types.js';
import { normalizeAgentEvalDataset } from '../../optimize.js';
import type {
  AxAgentEvalDataset,
  AxAgentJudgeOptions,
} from '../agentOptimizeTypes.js';
import { createAgentOptimizeMetric } from '../optimizer.js';
import type {
  AxAgentEvalBatchResult,
  AxAgentEvalBudget,
} from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import { clusterFailures } from './failureClusters.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveOutcome,
  AxAgentPlaybookEvolveResult,
  AxAgentPlaybookRetentionAnchor,
  AxAgentPlaybookRetentionReceipt,
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

function validateRetentionWeights(
  tasks: readonly { weight?: number }[],
  label: string
): void {
  let total = 0;
  for (const task of tasks) {
    const weight = task.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `AxAgent.playbook().evolve(): ${label} task weights must be finite and non-negative.`
      );
    }
    total += weight;
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `AxAgent.playbook().evolve(): ${label} must have positive finite total weight.`
    );
  }
}

function validateRetentionPolicy(
  policy: NonNullable<AxAgentPlaybookEvolveOptions['retentionPolicy']>,
  verify: boolean,
  currentTasks: readonly { weight?: number }[]
): void {
  if (!verify) {
    throw new Error(
      'AxAgent.playbook().evolve(): retentionPolicy requires verify: true.'
    );
  }
  if (policy.slices.length === 0) {
    throw new Error(
      'AxAgent.playbook().evolve(): retentionPolicy requires at least one slice.'
    );
  }
  const thresholds = [
    ['minCurrentGain', policy.minCurrentGain],
    ['maxWorstHistoricalLoss', policy.maxWorstHistoricalLoss],
    ['maxMeanHistoricalLoss', policy.maxMeanHistoricalLoss],
  ] as const;
  for (const [name, value] of thresholds) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `AxAgent.playbook().evolve(): retentionPolicy.${name} must be finite and non-negative.`
      );
    }
  }
  validateRetentionWeights(currentTasks, 'retention current-task set');
  const identities = new Set<string>();
  for (const slice of policy.slices) {
    if (!slice.name.trim() || !slice.version.trim()) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention slice name and version must be non-empty.'
      );
    }
    if (slice.tasks.length === 0) {
      throw new Error(
        `AxAgent.playbook().evolve(): retention slice ${slice.name}@${slice.version} has no tasks.`
      );
    }
    validateRetentionWeights(
      slice.tasks,
      `retention slice ${slice.name}@${slice.version}`
    );
    const identity = `${slice.name}\u0000${slice.version}`;
    if (identities.has(identity)) {
      throw new Error(
        `AxAgent.playbook().evolve(): duplicate retention slice ${slice.name}@${slice.version}.`
      );
    }
    identities.add(identity);
  }
}

export async function evolveAgentPlaybook<
  IN extends AxGenIn,
  OUT extends AxGenOut,
>(
  self: any,
  dataset: Readonly<AxAgentEvalDataset<IN>>,
  options?: Readonly<AxAgentPlaybookEvolveOptions>
): Promise<AxAgentPlaybookEvolveResult<OUT>> {
  const s = self as any;
  const normalized = normalizeAgentEvalDataset(dataset);
  if (normalized.train.length === 0) {
    throw new Error(
      'AxAgent.playbook().evolve(): at least one training task is required.'
    );
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
  const retentionPolicy = options?.retentionPolicy;
  if (retentionPolicy) {
    validateRetentionPolicy(retentionPolicy, verify, normalized.train);
  }
  const maxProposals = Math.max(
    1,
    Math.floor(options?.maxProposals ?? DEFAULT_MAX_PROPOSALS)
  );
  const runsPerTask = Math.max(1, Math.floor(options?.runsPerTask ?? 1));
  const retentionTaskCount =
    retentionPolicy?.slices.reduce(
      (sum, slice) => sum + slice.tasks.length,
      0
    ) ?? 0;
  const datasetSize =
    (normalized.train.length +
      (normalized.validation?.length ?? 0) +
      retentionTaskCount) *
    runsPerTask;
  const maxMetricCalls = Math.max(
    1,
    Math.floor(
      options?.maxMetricCalls ?? Math.max(100, (maxProposals + 1) * datasetSize)
    )
  );
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const minHeldInGain = options?.minHeldInGain ?? DEFAULT_MIN_HELD_IN_GAIN;
  const currentGainThreshold = retentionPolicy?.minCurrentGain ?? minHeldInGain;
  const scoreThreshold = options?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const budget: AxAgentEvalBudget = { remaining: maxMetricCalls };
  const usedCalls = () => maxMetricCalls - budget.remaining;

  const baselineRequiredCalls =
    (normalized.train.length +
      (normalized.validation?.length ?? 0) +
      retentionTaskCount) *
    runsPerTask;
  if (retentionPolicy && maxMetricCalls < baselineRequiredCalls) {
    throw new Error(
      `AxAgent.playbook().evolve(): maxMetricCalls ${maxMetricCalls} cannot establish complete retention anchors (requires ${baselineRequiredCalls}).`
    );
  }

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
  if (
    retentionPolicy &&
    (baselineTrain.exhausted || !baselineTrain.validEvidence)
  ) {
    throw new Error(
      'AxAgent.playbook().evolve(): retention current-task anchor requires complete, finite evaluator evidence.'
    );
  }
  let heldIn = baselineTrain.mean;
  let heldOut: number | undefined;
  let baselineHeldOutBatch: AxAgentEvalBatchResult<IN, OUT> | undefined;
  if (normalized.validation?.length) {
    progress(
      'baseline',
      `evaluating ${normalized.validation.length} validation tasks`
    );
    baselineHeldOutBatch = await runAgentEvalBatch<IN, OUT>({
      ...batchArgs,
      tasks: normalized.validation,
    });
    if (
      retentionPolicy &&
      (baselineHeldOutBatch.exhausted || !baselineHeldOutBatch.validEvidence)
    ) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention held-out anchor requires complete, finite evaluator evidence.'
      );
    }
    heldOut = baselineHeldOutBatch.mean;
  }
  const baseline = {
    heldIn,
    ...(heldOut !== undefined ? { heldOut } : {}),
  };
  const retentionAnchors: AxAgentPlaybookRetentionAnchor[] = [];
  if (retentionPolicy) {
    for (const slice of retentionPolicy.slices) {
      progress(
        'baseline',
        `evaluating retention slice ${slice.name}@${slice.version} (${slice.tasks.length} tasks)`
      );
      const result = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks: slice.tasks,
      });
      if (result.exhausted || !result.validEvidence) {
        throw new Error(
          `AxAgent.playbook().evolve(): retention slice ${slice.name}@${slice.version} requires complete, finite evaluator evidence.`
        );
      }
      retentionAnchors.push({
        name: slice.name,
        version: slice.version,
        taskCount: slice.tasks.length,
        score: result.mean,
        evidence: {
          executedRuns: result.executedRuns,
          expectedRuns: result.expectedRuns,
          complete: true,
        },
      });
    }
  }

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
      (normalized.train.length +
        (normalized.validation?.length ?? 0) +
        retentionTaskCount) *
      runsPerTask;
    if (verify && budget.remaining < requiredCalls) {
      outcomes.push({
        proposal,
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
        accepted: true,
        reason: 'applied without verification (verify: false)',
        heldIn: { before: heldIn, after: heldIn },
      });
      progress('validation', `${weakness.id}: applied (trust-batch)`);
      continue;
    }

    let rolledBack = false;
    try {
      const revalTrain = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks: normalized.train,
      });
      let revalHeldOut: number | undefined;
      let revalHeldOutBatch: AxAgentEvalBatchResult<IN, OUT> | undefined;
      if (normalized.validation?.length) {
        revalHeldOutBatch = await runAgentEvalBatch<IN, OUT>({
          ...batchArgs,
          tasks: normalized.validation,
        });
        revalHeldOut = revalHeldOutBatch.mean;
      }
      const candidateRetentionBatches: AxAgentEvalBatchResult<IN, OUT>[] = [];
      if (retentionPolicy) {
        for (const slice of retentionPolicy.slices) {
          candidateRetentionBatches.push(
            await runAgentEvalBatch<IN, OUT>({
              ...batchArgs,
              tasks: slice.tasks,
            })
          );
        }
      }

      // A re-eval that exhausted mid-way produced a subset mean — comparing it
      // to the full-set baseline is apples-to-oranges, so refuse the accept.
      // Retention additionally rejects any evaluator error/non-finite score.
      const retentionEvidenceInvalid = Boolean(
        retentionPolicy &&
          (!revalTrain.validEvidence ||
            (revalHeldOutBatch && !revalHeldOutBatch.validEvidence) ||
            candidateRetentionBatches.some((batch) => !batch.validEvidence))
      );
      const revalComplete =
        !revalTrain.exhausted &&
        !revalHeldOutBatch?.exhausted &&
        !candidateRetentionBatches.some((batch) => batch.exhausted) &&
        !retentionEvidenceInvalid;
      const currentGain = revalTrain.mean - heldIn;
      const gainOk = revalComplete && currentGain >= currentGainThreshold;
      const heldOutOk =
        revalHeldOut === undefined ||
        heldOut === undefined ||
        revalHeldOut - heldOut >= -epsilon;
      let retentionReceipt: AxAgentPlaybookRetentionReceipt | undefined;
      let retentionOk = true;
      if (retentionPolicy && revalComplete) {
        const slices = retentionAnchors.map((anchor, index) => {
          const candidate = candidateRetentionBatches[index]!;
          return {
            name: anchor.name,
            version: anchor.version,
            taskCount: anchor.taskCount,
            anchorScore: anchor.score,
            candidateScore: candidate.mean,
            historicalLoss: anchor.score - candidate.mean,
            anchorEvidence: anchor.evidence,
            candidateEvidence: {
              executedRuns: candidate.executedRuns,
              expectedRuns: candidate.expectedRuns,
              complete: true as const,
            },
          };
        });
        const losses = slices.map((slice) => slice.historicalLoss);
        const worstHistoricalLoss = Math.max(...losses);
        const meanHistoricalLoss =
          losses.reduce((sum, loss) => sum + loss, 0) / losses.length;
        retentionOk =
          worstHistoricalLoss <= retentionPolicy.maxWorstHistoricalLoss &&
          meanHistoricalLoss <= retentionPolicy.maxMeanHistoricalLoss;
        const accepted = gainOk && heldOutOk && retentionOk;
        retentionReceipt = {
          currentTask: {
            before: heldIn,
            after: revalTrain.mean,
            gain: currentGain,
          },
          slices,
          worstHistoricalLoss,
          meanHistoricalLoss,
          thresholds: {
            minCurrentGain: retentionPolicy.minCurrentGain,
            maxWorstHistoricalLoss: retentionPolicy.maxWorstHistoricalLoss,
            maxMeanHistoricalLoss: retentionPolicy.maxMeanHistoricalLoss,
          },
          accepted,
        };
      }
      const accept = revalComplete && gainOk && heldOutOk && retentionOk;

      outcomes.push({
        proposal,
        accepted: accept,
        reason: retentionEvidenceInvalid
          ? 'retention evaluation produced invalid evaluator evidence'
          : !revalComplete
            ? 'metric_budget exhausted during re-evaluation'
            : accept
              ? retentionPolicy
                ? 'current task improved, historical retention thresholds satisfied'
                : heldOut === undefined
                  ? 'held-in improved (no held-out set provided — consider one)'
                  : 'held-in improved, held-out non-regressing'
              : !gainOk
                ? retentionPolicy
                  ? `current-task gain ${currentGain.toFixed(3)} below ${currentGainThreshold}`
                  : `held-in gain ${currentGain.toFixed(3)} below ${currentGainThreshold}`
                : !heldOutOk
                  ? `held-out regressed ${((revalHeldOut ?? 0) - (heldOut ?? 0)).toFixed(3)}`
                  : `historical loss exceeded retention threshold (worst ${retentionReceipt?.worstHistoricalLoss.toFixed(3)}, mean ${retentionReceipt?.meanHistoricalLoss.toFixed(3)})`,
        heldIn: { before: heldIn, after: revalTrain.mean },
        ...(revalHeldOut !== undefined && heldOut !== undefined
          ? { heldOut: { before: heldOut, after: revalHeldOut } }
          : {}),
        ...(retentionReceipt ? { retention: retentionReceipt } : {}),
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
        rolledBack = true;
        progress('validation', `${weakness.id}: rejected, rolled back`);
      }
    } catch (err) {
      if (retentionPolicy && !rolledBack) {
        applied.rollback();
      }
      throw err;
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
    ...(retentionAnchors.length > 0 ? { retentionAnchors } : {}),
    weaknesses,
    outcomes,
    recommendations: weaknesses.flatMap((w) => w.configRecommendations),
    ...(playbookSnapshot ? { playbookSnapshot } : {}),
    metricCallsUsed: usedCalls(),
    records: baselineTrain.records,
  };
}
