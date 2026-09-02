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
import { accountingForPhases, createAccountingLedger } from './accounting.js';
import {
  atMostWithFloatingPointTolerance,
  canonicalDigest,
  cloneAndFreeze,
  deepFreeze,
} from './canonical.js';
import type {
  AxAgentEvalBatchResult,
  AxAgentEvalBudget,
} from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import { clusterFailures } from './failureClusters.js';
import type {
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookComputePhaseName,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookSplitName,
  AxAgentPlaybookVarianceBand,
  AxAgentPlaybookVarianceBandReport,
} from './playbookEvidenceTypes.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveOutcome,
  AxAgentPlaybookEvolveProgressEvent,
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
import {
  seedFromDigest,
  validateIntervalOptions,
  varianceBandFrom,
} from './statistics.js';
import { mineWeakness } from './weaknessMiner.js';

const DEFAULT_MAX_PROPOSALS = 4;
const DEFAULT_EPSILON = 0.01;
const DEFAULT_MIN_HELD_IN_GAIN = 0.05;
const DEFAULT_SCORE_THRESHOLD = 0.7;
const MAX_RUNS_PER_TASK = 100;
const MAX_METRIC_CALLS = 1_000_000;
const RESTORATION_FAILURE = Symbol.for(
  '@ax-llm/ax/agent-playbook-restoration-failure'
);
/** Phases the legacy `metricCallsUsed` counter has always counted. */
const EVOLVE_ONLY_PHASES: ReadonlySet<AxAgentPlaybookComputePhaseName> =
  new Set<AxAgentPlaybookComputePhaseName>([
    'baseline',
    'candidate_eval',
    'retention_eval',
  ]);

function positiveSafeInteger(
  value: number,
  name: 'runsPerTask' | 'maxMetricCalls',
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `AxAgent.playbook().evolve(): ${name} must be a positive safe integer at most ${maximum}.`
    );
  }
  return value;
}

function retentionEvidenceError(
  label: string,
  result: AxAgentEvalBatchResult
): Error {
  return new Error(
    `AxAgent.playbook().evolve(): ${label} requires complete, finite evaluator evidence.`,
    result.failure === undefined ? undefined : { cause: result.failure }
  );
}

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
  currentTasks: readonly { weight?: number }[],
  heldOutTasks?: readonly { weight?: number }[]
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
  if (!policy.evaluatorId.trim() || policy.evaluatorId.length > 200) {
    throw new Error(
      'AxAgent.playbook().evolve(): retentionPolicy.evaluatorId must be 1-200 characters.'
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
  if (heldOutTasks?.length) {
    validateRetentionWeights(heldOutTasks, 'retention held-out set');
  }
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
    const identity = JSON.stringify([slice.name, slice.version]);
    if (identities.has(identity)) {
      throw new Error(
        `AxAgent.playbook().evolve(): duplicate retention slice ${slice.name}@${slice.version}.`
      );
    }
    identities.add(identity);
  }
}

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
      const raw = idOf(task);
      const id = typeof raw === 'string' ? raw.trim() : '';
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

/**
 * Options whose presence turns on an evidence path. Every one of them is
 * meaningless with `verify: false` — the trust-batch path accepts every
 * proposal with no evaluation at all — so combining them fails closed rather
 * than silently doing nothing.
 */
const EVIDENCE_OPTION_KEYS = [
  'gates',
  'varianceBand',
  'intervalOptions',
  'validity',
  'reachProbe',
  'conditionsForTask',
  'classifyTermination',
  'maxDiscardRedraws',
] as const;

function activeEvidenceOptions(
  options?: Readonly<AxAgentPlaybookEvolveOptions<any>>
): readonly string[] {
  if (!options) return [];
  const active: string[] = [];
  for (const key of EVIDENCE_OPTION_KEYS) {
    const value = (options as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'gates') {
      const modes = Object.values(value as Record<string, unknown>).filter(
        (mode) => mode === 'warn' || mode === 'require'
      );
      if (modes.length === 0) continue;
    }
    active.push(key);
  }
  return active;
}

function validateEvidenceOptions(
  options: Readonly<AxAgentPlaybookEvolveOptions<any>> | undefined,
  verify: boolean
): void {
  const active = activeEvidenceOptions(options);
  if (!verify && active.length > 0) {
    throw new AxAgentPlaybookEvolveError(
      'evidence_requires_verify',
      'baseline',
      `${active.join(', ')} cannot be combined with verify: false; the trust-batch path accepts every proposal without evaluating it.`
    );
  }
  const gates = options?.gates;
  if (gates?.controlArm && gates.controlArm !== 'off') {
    // A required (or warned) control-arm gate with no arm to compare against
    // is a gate that can never read anything. Fail closed at validation.
    throw new AxAgentPlaybookEvolveError(
      'control_arm_failed',
      'control_arm',
      'gates.controlArm needs a controlArm configuration; a control-arm gate with no arm cannot be evaluated.'
    );
  }
  if (gates?.transfer && gates.transfer !== 'off') {
    throw new AxAgentPlaybookEvolveError(
      'transfer_target_invalid',
      'transfer',
      'gates.transfer needs a transfer configuration with at least one target.'
    );
  }
  if (gates?.interval === 'require' && !options?.varianceBand) {
    // A required gate that silently becomes a weaker gate is exactly the
    // failure shape this machinery exists to remove. Ax does not auto-enable
    // the band either: that would spend candidate budget without asking.
    throw new AxAgentPlaybookEvolveError(
      'interval_options_invalid',
      'variance_band',
      'gates.interval: require needs varianceBand; a required interval gate without a band silently degrades to "excludes zero".'
    );
  }
  validateIntervalOptions(options?.intervalOptions);
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
  validateEvidenceOptions(options, verify);
  const evidenceEnabled = activeEvidenceOptions(options).length > 0;
  const nowFn = options?.now ?? Date.now;
  const ledger = createAccountingLedger(nowFn);
  const usesBuiltInJudge = options?.metric === undefined;
  const maxDiscardRedraws =
    options?.maxDiscardRedraws ?? (options?.classifyTermination ? 1 : 0);
  const retentionPolicy = options?.retentionPolicy
    ? cloneAndFreeze(options.retentionPolicy, 'retentionPolicy')
    : undefined;
  const trainTasks = retentionPolicy
    ? cloneAndFreeze(normalized.train, 'retention current-task set')
    : normalized.train;
  const validationTasks = retentionPolicy
    ? normalized.validation
      ? cloneAndFreeze(normalized.validation, 'retention held-out set')
      : undefined
    : normalized.validation;
  if (retentionPolicy) {
    validateRetentionPolicy(
      retentionPolicy,
      verify,
      trainTasks,
      validationTasks
    );
  }
  const maxProposals = Math.max(
    1,
    Math.floor(options?.maxProposals ?? DEFAULT_MAX_PROPOSALS)
  );
  const runsPerTask = positiveSafeInteger(
    options?.runsPerTask ?? 1,
    'runsPerTask',
    MAX_RUNS_PER_TASK
  );
  const retentionTaskCount =
    retentionPolicy?.slices.reduce(
      (sum, slice) => sum + slice.tasks.length,
      0
    ) ?? 0;
  const datasetSize =
    (trainTasks.length + (validationTasks?.length ?? 0) + retentionTaskCount) *
    runsPerTask;
  const maxMetricCalls = positiveSafeInteger(
    options?.maxMetricCalls ??
      Math.min(
        MAX_METRIC_CALLS,
        Math.max(100, (maxProposals + 1) * datasetSize)
      ),
    'maxMetricCalls',
    MAX_METRIC_CALLS
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
  const currentGainThreshold = retentionPolicy?.minCurrentGain ?? minHeldInGain;
  const scoreThreshold = options?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const currentTaskSetDigest = retentionPolicy
    ? canonicalDigest(trainTasks)
    : undefined;
  const heldOutTaskSetDigest =
    retentionPolicy && validationTasks?.length
      ? canonicalDigest(validationTasks)
      : undefined;
  const sliceTaskSetDigests =
    retentionPolicy?.slices.map((slice) => canonicalDigest(slice.tasks)) ?? [];
  const retentionPolicyDigest = retentionPolicy
    ? canonicalDigest({
        schema: 'ax-agent-playbook-retention-v1',
        evaluatorId: retentionPolicy.evaluatorId,
        currentTaskSetDigest,
        heldOutTaskSetDigest,
        thresholds: {
          minCurrentGain: retentionPolicy.minCurrentGain,
          maxWorstHistoricalLoss: retentionPolicy.maxWorstHistoricalLoss,
          maxMeanHistoricalLoss: retentionPolicy.maxMeanHistoricalLoss,
          heldOutEpsilon: epsilon,
        },
        slices: retentionPolicy.slices.map((slice, index) => ({
          name: slice.name,
          version: slice.version,
          taskSetDigest: sliceTaskSetDigests[index],
        })),
      })
    : undefined;
  let retentionSequence = 0;
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
  /**
   * Metric calls spent by an evidence phase. They are real calls and land in
   * `accounting.metricCalls` (the honest run total), but they must NOT move the
   * legacy `metricCallsUsed` counter — invariant I6 says no new phase
   * increments it, so a caller reading the legacy number sees exactly what it
   * saw before this machinery existed.
   */
  let evidenceMetricCalls = 0;
  const usedCalls = () =>
    maxMetricCalls - budget.remaining - evidenceMetricCalls;

  const baselineRequiredCalls =
    (trainTasks.length + (validationTasks?.length ?? 0) + retentionTaskCount) *
    runsPerTask;
  if (retentionPolicy && maxMetricCalls < baselineRequiredCalls) {
    throw new Error(
      `AxAgent.playbook().evolve(): maxMetricCalls ${maxMetricCalls} cannot establish complete retention anchors (requires ${baselineRequiredCalls}).`
    );
  }

  const progress = (
    phase: AxAgentPlaybookEvolveProgressEvent['phase'],
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
    ...(retentionPolicy ? { isolateTaskInputs: true } : {}),
    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options?.classifyTermination
      ? { classifyTermination: options.classifyTermination }
      : {}),
    ...(maxDiscardRedraws > 0 ? { maxDiscardRedraws } : {}),
    ...(evidenceEnabled ? { captureAttempts: true } : {}),
    ...(options?.now ? { now: options.now } : {}),
  };

  /**
   * Every evaluation goes through here so the honest run total (I6) is the sum
   * over phases and no phase can spend budget without being counted. The
   * judge phase counts INVOCATIONS only: the judge is reached as an opaque
   * `AxMetricFn`, so its tokens are structurally unobservable.
   */
  const runPhaseBatch = async (
    phase: AxAgentPlaybookComputePhaseName,
    tasks: readonly AxAgentEvalTask<IN>[],
    split: AxAgentPlaybookSplitName,
    sliceName?: string
  ): Promise<AxAgentEvalBatchResult<IN, OUT>> => {
    const handle = ledger.phase(phase);
    const before = budget.remaining;
    try {
      const result = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks,
        split,
        ...(sliceName ? { sliceName } : {}),
      });
      handle.addUsage(result.usage);
      return result;
    } finally {
      const spent = before - budget.remaining;
      handle.addMetricCalls(spent);
      handle.close();
      if (!EVOLVE_ONLY_PHASES.has(phase)) evidenceMetricCalls += spent;
      if (usesBuiltInJudge && spent > 0) {
        const judge = ledger.phase('judge');
        judge.addModelCalls(spent);
        judge.close();
      }
    }
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
  progress('baseline', `evaluating ${trainTasks.length} train tasks`);
  const baselineTrain = await runPhaseBatch('baseline', trainTasks, 'current');
  if (retentionPolicy && !baselineTrain.complete) {
    throw retentionEvidenceError(
      'retention current-task anchor',
      baselineTrain
    );
  }
  let currentTaskAnchorSequence = retentionPolicy
    ? ++retentionSequence
    : undefined;
  let currentTaskAnchorEvidence = retentionPolicy
    ? {
        executedRuns: baselineTrain.executedRuns,
        expectedRuns: baselineTrain.expectedRuns,
        complete: true as const,
      }
    : undefined;
  if (requireHeldOut && !baselineTrain.complete) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut held-in baseline evaluation was incomplete or errored.'
    );
  }
  let heldIn = baselineTrain.mean;
  let heldOut: number | undefined;
  let baselineHeldOutBatch: AxAgentEvalBatchResult<IN, OUT> | undefined;
  let heldOutAnchorSequence: number | undefined;
  let heldOutAnchorEvidence:
    | {
        executedRuns: number;
        expectedRuns: number;
        complete: true;
      }
    | undefined;
  if (validationTasks?.length) {
    progress(
      'baseline',
      `evaluating ${validationTasks.length} validation tasks`
    );
    baselineHeldOutBatch = await runPhaseBatch(
      'baseline',
      validationTasks,
      'heldOut'
    );
    if (retentionPolicy && !baselineHeldOutBatch.complete) {
      throw retentionEvidenceError(
        'retention held-out anchor',
        baselineHeldOutBatch
      );
    }
    heldOut = baselineHeldOutBatch.mean;
    if (retentionPolicy) {
      heldOutAnchorSequence = ++retentionSequence;
      heldOutAnchorEvidence = {
        executedRuns: baselineHeldOutBatch.executedRuns,
        expectedRuns: baselineHeldOutBatch.expectedRuns,
        complete: true,
      };
    }
    if (requireHeldOut && !baselineHeldOutBatch.complete) {
      throw new Error(
        'AxAgent.playbook().evolve(): requireHeldOut held-out baseline evaluation was incomplete or errored.'
      );
    }
  }
  const baseline = {
    heldIn,
    ...(heldOut !== undefined ? { heldOut } : {}),
  };
  const retentionAnchors: AxAgentPlaybookRetentionAnchor[] = [];
  if (retentionPolicy) {
    for (const [index, slice] of retentionPolicy.slices.entries()) {
      progress(
        'baseline',
        `evaluating retention slice ${slice.name}@${slice.version} (${slice.tasks.length} tasks)`
      );
      const result = await runPhaseBatch(
        'retention_eval',
        slice.tasks,
        'slice',
        slice.name
      );
      if (!result.complete) {
        throw retentionEvidenceError(
          `retention slice ${slice.name}@${slice.version}`,
          result
        );
      }
      retentionAnchors.push(
        deepFreeze({
          name: slice.name,
          version: slice.version,
          taskCount: slice.tasks.length,
          taskSetDigest: sliceTaskSetDigests[index]!,
          policyDigest: retentionPolicyDigest!,
          evaluatorId: retentionPolicy.evaluatorId,
          sequence: ++retentionSequence,
          score: result.mean,
          evidence: {
            executedRuns: result.executedRuns,
            expectedRuns: result.expectedRuns,
            complete: true as const,
          },
        })
      );
    }
  }

  // ---- Variance band: re-runs of the UNCHANGED artifact ----
  // Establishes the smallest delta distinguishable from run-to-run noise, so a
  // candidate gain can be compared against the noise floor rather than against
  // zero. Runs BEFORE any mutation, and fails closed on budget before it.
  const intervalSettings = validateIntervalOptions(options?.intervalOptions);
  const bandSplits: readonly ('current' | 'heldOut')[] =
    options?.varianceBand?.splits ??
    (validationTasks?.length ? ['current', 'heldOut'] : ['current']);
  let varianceBands: AxAgentPlaybookVarianceBand[] | undefined;
  if (options?.varianceBand) {
    const extraRepeats = options.varianceBand.extraRepeats ?? 1;
    if (!Number.isSafeInteger(extraRepeats) || extraRepeats < 0) {
      throw new AxAgentPlaybookEvolveError(
        'interval_options_invalid',
        'variance_band',
        'varianceBand.extraRepeats must be a non-negative safe integer.'
      );
    }
    const bandTaskCount = bandSplits.reduce(
      (sum, split) =>
        sum +
        (split === 'current'
          ? trainTasks.length
          : (validationTasks?.length ?? 0)),
      0
    );
    const bandRequiredCalls = extraRepeats * bandTaskCount * runsPerTask;
    if (budget.remaining < bandRequiredCalls) {
      throw new AxAgentPlaybookEvolveError(
        'budget_insufficient',
        'variance_band',
        `varianceBand needs ${bandRequiredCalls} metric calls; ${budget.remaining} remain.`
      );
    }
    varianceBands = [];
    for (const split of bandSplits) {
      const tasks = split === 'current' ? trainTasks : validationTasks;
      const anchorBatch =
        split === 'current' ? baselineTrain : baselineHeldOutBatch;
      if (!tasks?.length || !anchorBatch) continue;
      const repeats = [anchorBatch.records];
      const means = [anchorBatch.mean];
      for (let repeat = 0; repeat < extraRepeats; repeat++) {
        progress(
          'band',
          `${split}: unchanged-artifact repeat ${repeat + 1}/${extraRepeats}`
        );
        const batch = await runPhaseBatch('variance_band', tasks, split);
        repeats.push(batch.records);
        means.push(batch.mean);
      }
      const band = varianceBandFrom({
        split,
        repeats,
        means,
        seed:
          intervalSettings.seed ??
          seedFromDigest(canonicalDigest(tasks.map((task) => task.id ?? ''))),
        resamples: intervalSettings.resamples,
        level: intervalSettings.level,
      });
      if (band) varianceBands.push(band);
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
  // `mineWeakness` builds its own AxGen and returns no usage, so this phase can
  // count invocations and nothing else — hence tokensBasis 'unobservable'.
  const miningPhase = ledger.phase('mining');
  for (const [index, cluster] of clusters.entries()) {
    if (options?.abortSignal?.aborted) {
      throw new Error('AxAgent.playbook().evolve(): aborted');
    }
    try {
      miningPhase.addModelCalls(1);
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
  miningPhase.close();

  // ---- Sequential propose -> (verify) accept/reject ----
  const outcomes: AxAgentPlaybookEvolveOutcome[] = [];
  const accepted: AxAppliedProposal[] = [];
  const rollbackAccepted = (): unknown[] => {
    const errors: unknown[] = [];
    for (const applied of [...accepted].reverse()) {
      try {
        applied.rollback();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };
  let inFlight: AxAppliedProposal | undefined;

  try {
    for (const weakness of weaknesses) {
      if (options?.abortSignal?.aborted) {
        throw new Error('AxAgent.playbook().evolve(): aborted');
      }
      const proposal = buildProposal(weakness);
      const requiredCalls =
        (trainTasks.length +
          (validationTasks?.length ?? 0) +
          retentionTaskCount) *
        runsPerTask;
      if (verify && budget.remaining < requiredCalls) {
        outcomes.push({
          proposal,
          kind: 'curate',
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
        if (
          err &&
          typeof err === 'object' &&
          RESTORATION_FAILURE in err &&
          (err as Record<symbol, unknown>)[RESTORATION_FAILURE] === true
        ) {
          throw err;
        }
        outcomes.push({
          proposal,
          kind: 'curate',
          status: 'rejected',
          accepted: false,
          reason: `apply failed: ${err instanceof Error ? err.message : String(err)}`,
          heldIn: { before: heldIn, after: heldIn },
        });
        continue;
      }
      inFlight = applied;

      // Trust-batch: keep the lesson without a gate.
      if (!verify) {
        accepted.push(applied);
        inFlight = undefined;
        outcomes.push({
          proposal,
          kind: 'curate',
          status: 'accepted',
          accepted: true,
          reason: 'applied without verification (verify: false)',
          heldIn: { before: heldIn, after: heldIn },
        });
        progress('validation', `${weakness.id}: applied (trust-batch)`);
        continue;
      }

      const revalTrain = await runPhaseBatch(
        'candidate_eval',
        trainTasks,
        'current'
      );
      const candidateCurrentSequence = retentionPolicy
        ? ++retentionSequence
        : undefined;
      let revalHeldOut: number | undefined;
      let revalHeldOutBatch: AxAgentEvalBatchResult<IN, OUT> | undefined;
      let candidateHeldOutSequence: number | undefined;
      if (validationTasks?.length) {
        revalHeldOutBatch = await runPhaseBatch(
          'candidate_eval',
          validationTasks,
          'heldOut'
        );
        revalHeldOut = revalHeldOutBatch.mean;
        if (retentionPolicy) {
          candidateHeldOutSequence = ++retentionSequence;
        }
      }
      const candidateRetentionBatches: {
        batch: AxAgentEvalBatchResult<IN, OUT>;
        sequence: number;
      }[] = [];
      if (retentionPolicy) {
        for (const slice of retentionPolicy.slices) {
          const batch = await runPhaseBatch(
            'retention_eval',
            slice.tasks,
            'slice',
            slice.name
          );
          candidateRetentionBatches.push({
            batch,
            sequence: ++retentionSequence,
          });
        }
      }

      // A re-eval that exhausted mid-way produced a subset mean — comparing it
      // to the full-set baseline is apples-to-oranges, so refuse the accept.
      // Retention additionally rejects any evaluator error/non-finite score.
      if (retentionPolicy) {
        const failedResult = !revalTrain.validEvidence
          ? revalTrain
          : revalHeldOutBatch && !revalHeldOutBatch.validEvidence
            ? revalHeldOutBatch
            : candidateRetentionBatches.find(
                ({ batch }) => !batch.validEvidence
              )?.batch;
        if (failedResult) {
          throw retentionEvidenceError(
            'candidate retention evaluation',
            failedResult
          );
        }
      }
      const revalComplete = retentionPolicy
        ? revalTrain.complete &&
          (revalHeldOutBatch?.complete ?? true) &&
          candidateRetentionBatches.every(({ batch }) => batch.complete)
        : requireHeldOut
          ? revalTrain.complete && revalHeldOutBatch?.complete === true
          : !revalTrain.exhausted && !revalHeldOutBatch?.exhausted;
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
            taskSetDigest: anchor.taskSetDigest,
            anchorSequence: anchor.sequence,
            candidateSequence: candidate.sequence,
            anchorScore: anchor.score,
            candidateScore: candidate.batch.mean,
            historicalLoss: anchor.score - candidate.batch.mean,
            anchorEvidence: anchor.evidence,
            candidateEvidence: {
              executedRuns: candidate.batch.executedRuns,
              expectedRuns: candidate.batch.expectedRuns,
              complete: true as const,
            },
          };
        });
        const losses = slices.map((slice) => slice.historicalLoss);
        const worstHistoricalLoss = Math.max(...losses);
        const meanHistoricalLoss =
          losses.reduce((sum, loss) => sum + loss, 0) / losses.length;
        retentionOk =
          atMostWithFloatingPointTolerance(
            worstHistoricalLoss,
            retentionPolicy.maxWorstHistoricalLoss
          ) &&
          atMostWithFloatingPointTolerance(
            meanHistoricalLoss,
            retentionPolicy.maxMeanHistoricalLoss
          );
        const accepted = gainOk && heldOutOk && retentionOk;
        retentionReceipt = deepFreeze({
          policy: {
            digest: retentionPolicyDigest!,
            evaluatorId: retentionPolicy.evaluatorId,
            currentTaskSetDigest: currentTaskSetDigest!,
            ...(heldOutTaskSetDigest ? { heldOutTaskSetDigest } : {}),
          },
          sequence: ++retentionSequence,
          currentTask: {
            before: heldIn,
            after: revalTrain.mean,
            gain: currentGain,
            taskSetDigest: currentTaskSetDigest!,
            anchorSequence: currentTaskAnchorSequence!,
            candidateSequence: candidateCurrentSequence!,
            anchorEvidence: currentTaskAnchorEvidence!,
            candidateEvidence: {
              executedRuns: revalTrain.executedRuns,
              expectedRuns: revalTrain.expectedRuns,
              complete: true,
            },
          },
          ...(heldOutTaskSetDigest && baselineHeldOutBatch && revalHeldOutBatch
            ? {
                heldOut: {
                  taskSetDigest: heldOutTaskSetDigest,
                  anchorSequence: heldOutAnchorSequence!,
                  candidateSequence: candidateHeldOutSequence!,
                  anchorEvidence: heldOutAnchorEvidence!,
                  candidateEvidence: {
                    executedRuns: revalHeldOutBatch.executedRuns,
                    expectedRuns: revalHeldOutBatch.expectedRuns,
                    complete: true as const,
                  },
                },
              }
            : {}),
          slices,
          worstHistoricalLoss,
          meanHistoricalLoss,
          thresholds: {
            minCurrentGain: retentionPolicy.minCurrentGain,
            maxWorstHistoricalLoss: retentionPolicy.maxWorstHistoricalLoss,
            maxMeanHistoricalLoss: retentionPolicy.maxMeanHistoricalLoss,
          },
          accepted,
        });
      }
      const accept = revalComplete && gainOk && heldOutOk && retentionOk;

      outcomes.push({
        proposal,
        kind: 'curate',
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

      if (options?.abortSignal?.aborted) {
        throw new Error('AxAgent.playbook().evolve(): aborted');
      }
      if (accept) {
        playbookHandle?.recordEvidence?.(applied.bulletIds, {
          source: 'agent-evolve',
          sourceRunId: proposal.clusterSignature,
          feedbackIds: [proposal.weaknessId],
          verification: [
            {
              verifierId: 'agent.playbook.evolve',
              testId: proposal.weaknessId,
              result: 'passed',
              summary: `held-in ${heldIn.toFixed(3)} -> ${revalTrain.mean.toFixed(3)}${
                heldOut !== undefined && revalHeldOut !== undefined
                  ? `; held-out ${heldOut.toFixed(3)} -> ${revalHeldOut.toFixed(3)}`
                  : ''
              }`,
            },
          ],
        });
        accepted.push(applied);
        inFlight = undefined;
        heldIn = revalTrain.mean;
        if (retentionPolicy) {
          currentTaskAnchorSequence = candidateCurrentSequence;
          currentTaskAnchorEvidence = {
            executedRuns: revalTrain.executedRuns,
            expectedRuns: revalTrain.expectedRuns,
            complete: true,
          };
        }
        if (revalHeldOut !== undefined) {
          heldOut = revalHeldOut;
          if (retentionPolicy) {
            heldOutAnchorSequence = candidateHeldOutSequence;
            heldOutAnchorEvidence = {
              executedRuns: revalHeldOutBatch!.executedRuns,
              expectedRuns: revalHeldOutBatch!.expectedRuns,
              complete: true,
            };
          }
        }
        progress('validation', `${weakness.id}: ACCEPTED`);
      } else {
        inFlight = undefined;
        applied.rollback();
        progress('validation', `${weakness.id}: rejected, rolled back`);
      }
    }
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    if (inFlight) {
      const applied = inFlight;
      inFlight = undefined;
      try {
        applied.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (options?.apply === false) {
      rollbackErrors.push(...rollbackAccepted());
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [err, ...rollbackErrors],
        'AxAgent.playbook().evolve(): candidate evaluation failed and exact rollback also failed.'
      );
    }
    throw err;
  }

  // ---- Finalize ----
  const playbookSnapshot =
    accepted.length > 0 ? playbookHandle?.getState() : undefined;

  if (options?.apply === false) {
    const rollbackErrors = rollbackAccepted();
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        'AxAgent.playbook().evolve(): exact dry-run rollback failed.'
      );
    }
  }

  progress(
    'done',
    `${accepted.length}/${outcomes.length} proposals accepted; held-in ${baseline.heldIn.toFixed(3)} -> ${heldIn.toFixed(3)}`
  );

  const accounting: AxAgentPlaybookComputeAccounting = ledger.assemble({
    evolveOnlyMetricCalls: usedCalls(),
    ...(options?.costFor ? { costFor: options.costFor } : {}),
    ...(options?.usageTap ? { usageTapped: true } : {}),
  });
  const control: AxAgentPlaybookControlArmReport = {
    status: 'not_run',
    reason: 'controlArm option not supplied',
  };
  const varianceBand: AxAgentPlaybookVarianceBandReport | undefined =
    options?.varianceBand
      ? varianceBands && varianceBands.length > 0
        ? {
            status: 'completed',
            bands: varianceBands,
            accounting: accountingForPhases(accounting, ['variance_band']),
          }
        : {
            status: 'not_run',
            reason:
              'varianceBand produced no comparable repeats; the band is reported absent rather than as a zero spread',
          }
      : undefined;

  return {
    baseline,
    final: { heldIn, ...(heldOut !== undefined ? { heldOut } : {}) },
    ...(retentionAnchors.length > 0
      ? { retentionAnchors: deepFreeze(retentionAnchors) }
      : {}),
    weaknesses,
    outcomes,
    recommendations: weaknesses.flatMap((w) => w.configRecommendations),
    ...(playbookSnapshot ? { playbookSnapshot } : {}),
    metricCallsUsed: usedCalls(),
    records: baselineTrain.records,
    control,
    accounting,
    applied: options?.apply === false ? 'dry_run' : 'live',
    ...(varianceBand ? { varianceBand } : {}),
  };
}
