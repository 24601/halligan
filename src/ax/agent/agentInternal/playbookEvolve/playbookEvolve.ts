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
import type { AxAccountingLedger } from './accounting.js';
import {
  accountingForPhases,
  candidateAccounting,
  createAccountingLedger,
  overheadReportFrom,
  overheadSplitFrom,
  unobservableTokenPhases,
} from './accounting.js';
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
import { buildEvidenceReceipt } from './evidenceReceipt.js';
import { clusterFailures } from './failureClusters.js';
import { evaluateAgentPromotionGate } from './gate.js';
import { evaluateGateChain, gateChainAccepts } from './gates.js';
import type {
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookComputePhaseName,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookEvidenceReceipt,
  AxAgentPlaybookEvidenceWarning,
  AxAgentPlaybookGateReport,
  AxAgentPlaybookInterval,
  AxAgentPlaybookNomination,
  AxAgentPlaybookOverheadReport,
  AxAgentPlaybookOverheadSplit,
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
  AxAgentPlaybookEvolveRunRecord,
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
import { createReachCollector } from './reach.js';
import {
  clustersFromPairedRecords,
  pairedBootstrapInterval,
  seedFromDigest,
  validateIntervalOptions,
  varianceBandFrom,
} from './statistics.js';
import { terminationReportOf } from './termination.js';
import { evaluateValidity, registeredFunctionNames } from './validity.js';
import { mineWeakness } from './weaknessMiner.js';

const DEFAULT_MAX_PROPOSALS = 4;
const DEFAULT_EPSILON = 0.01;
const DEFAULT_MIN_HELD_IN_GAIN = 0.05;
const DEFAULT_SCORE_THRESHOLD = 0.7;
const DEFAULT_MAX_ENVIRONMENT_DISCARD_RATE = 0.1;
const DEFAULT_OVERHEAD_WARN_RATIO = 0.25;
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
  if (
    gates?.controlArmMargin !== undefined &&
    (!gates.controlArm || gates.controlArm === 'off')
  ) {
    // A margin with no gate to apply it configures nothing. Accepting it
    // silently is the same declared-and-inert failure the gates above fail
    // closed on.
    throw new AxAgentPlaybookEvolveError(
      'control_arm_failed',
      'control_arm',
      'gates.controlArmMargin has no effect without gates.controlArm; a margin with no control-arm gate configures nothing.'
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

/**
 * The caller owns its `AxAIService`; Ax never wraps one. When a `usageTap` is
 * supplied Ax subscribes for the length of the run, attributes whatever arrives
 * to the open phase (see `AxAccountingLedger.tapUsage`), and always
 * unsubscribes — including when the run throws.
 */
export async function evolveAgentPlaybook<
  IN extends AxGenIn,
  OUT extends AxGenOut,
>(
  self: any,
  dataset: Readonly<AxAgentEvalDataset<IN>>,
  options?: Readonly<AxAgentPlaybookEvolveOptions<IN>>
): Promise<AxAgentPlaybookEvolveResult<OUT>> {
  const nowFn = options?.now ?? Date.now;
  const ledger = createAccountingLedger(nowFn);
  const unsubscribe = options?.usageTap?.subscribe((usage) => {
    ledger.tapUsage(usage);
  });
  try {
    return await runEvolve<IN, OUT>(self, dataset, ledger, nowFn, options);
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // A caller's unsubscribe must not mask the run's own outcome.
    }
  }
}

async function runEvolve<IN extends AxGenIn, OUT extends AxGenOut>(
  self: any,
  dataset: Readonly<AxAgentEvalDataset<IN>>,
  ledger: AxAccountingLedger,
  nowFn: () => number,
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
  const maxEnvironmentDiscardRate =
    options?.maxEnvironmentDiscardRate ?? DEFAULT_MAX_ENVIRONMENT_DISCARD_RATE;
  const overheadWarnRatio =
    options?.overheadWarnRatio ?? DEFAULT_OVERHEAD_WARN_RATIO;
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
    sliceName?: string,
    reach?: { observe: (args: any) => void }
  ): Promise<AxAgentEvalBatchResult<IN, OUT>> => {
    const handle = ledger.phase(phase);
    const before = budget.remaining;
    try {
      const result = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks,
        split,
        ...(sliceName ? { sliceName } : {}),
        ...(reach
          ? {
              onAttempt: (observed: any) =>
                reach.observe({
                  task: observed.task,
                  ...(observed.prediction
                    ? { prediction: observed.prediction }
                    : {}),
                  split: observed.split,
                  ...(observed.sliceName
                    ? { sliceName: observed.sliceName }
                    : {}),
                }),
            }
          : {}),
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
  /**
   * The anchor pass's per-slice records, kept so a slice can carry its own
   * paired interval on the receipt. Retention anchors are fixed pre-proposal,
   * so these never re-anchor the way the current/held-out records do.
   */
  const sliceAnchorRecords: (readonly AxAgentPlaybookEvolveRunRecord<
    IN,
    OUT
  >[])[] = [];
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
      sliceAnchorRecords.push(result.records);
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
  // zero. Runs BEFORE any mutation and fails closed on budget before making
  // one — the baseline batches above have already been spent by this point, so
  // this is "before any mutation", not "before any spend".
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

  // ---- Evidence state carried across candidates ----
  // The anchor a candidate is compared against is the LAST ACCEPTED state, not
  // the original baseline — the same re-anchoring the legacy scalar scores do,
  // which is exactly why `heldOut` is a selection split and not a sealed test.
  let anchorTrainRecords = baselineTrain.records;
  let anchorHeldOutRecords = baselineHeldOutBatch?.records;
  let heldOutSelectionComparisons = 0;
  const runWarnings: AxAgentPlaybookEvidenceWarning[] = [];
  const seenRunWarnings = new Set<string>();
  /**
   * The overhead of the LAST ACCEPTED candidate — the one that produced the
   * final artifact — against the anchor it was actually compared with. Surfaced
   * on the result so a reader who sees `overhead_exceeds_gain` in `warnings`
   * finds the number the warning quotes instead of `undefined`.
   */
  let finalOverhead: AxAgentPlaybookOverheadReport | undefined;
  const registered = registeredFunctionNames(s);
  const nowIso = () => new Date(nowFn()).toISOString();
  const currentSeed = () =>
    intervalSettings.seed ??
    seedFromDigest(canonicalDigest(trainTasks.map((task) => task.id ?? '')));
  const heldOutSeed = () =>
    intervalSettings.seed ??
    seedFromDigest(
      canonicalDigest((validationTasks ?? []).map((task) => task.id ?? ''))
    );
  const sliceSeed = (tasks: readonly AxAgentEvalTask<IN>[]) =>
    intervalSettings.seed ??
    seedFromDigest(canonicalDigest(tasks.map((task) => task.id ?? '')));
  const intervalFor = (
    anchor: readonly { task: object; score: number }[] | undefined,
    candidate: readonly { task: object; score: number }[] | undefined,
    seed: number
  ): AxAgentPlaybookInterval | undefined => {
    if (!anchor || !candidate) return undefined;
    const clusters = clustersFromPairedRecords(anchor, candidate);
    if (!clusters) return undefined;
    return pairedBootstrapInterval({
      clusters,
      seed,
      resamples: intervalSettings.resamples,
      level: intervalSettings.level,
    });
  };
  /** Bullet ids present in the playbook the evaluation actually rendered. */
  const renderedBulletIdsNow = (): readonly string[] => {
    try {
      const sections = (playbookHandle?.getState?.() as any)?.playbook
        ?.sections;
      if (!sections) return [];
      return Object.values(sections)
        .flat()
        .map((bullet: any) => bullet?.id)
        .filter((id: unknown): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  };
  const bulletsById = (ids: readonly string[]): readonly any[] => {
    try {
      const sections = (playbookHandle?.getState?.() as any)?.playbook
        ?.sections;
      if (!sections) return [];
      const wanted = new Set(ids);
      return Object.values(sections)
        .flat()
        .filter((bullet: any) => wanted.has(bullet?.id));
    } catch {
      return [];
    }
  };
  const splitDigestBasis: 'task_ids' | 'frozen_corpus' = retentionPolicy
    ? 'frozen_corpus'
    : 'task_ids';
  /**
   * Split digests are computed from FROZEN CORPUS values only when a retention
   * policy already froze and cloned them. Otherwise they are digests of the
   * semantic task ids: `canonicalSerialize` rejects class instances and cycles,
   * so digesting a caller's raw task objects would turn a `gates.reach: 'warn'`
   * run into a new throw. When a task has no semantic id the digests are empty
   * and the receipt records the weaker binding rather than failing.
   */
  const splitDigestOf = (
    tasks: readonly AxAgentEvalTask<IN>[] | undefined
  ): string => {
    if (!tasks?.length) return '';
    if (retentionPolicy) return canonicalDigest(tasks);
    const ids = tasks.map((task) => task.id);
    return ids.every((id) => typeof id === 'string' && id.length > 0)
      ? canonicalDigest(ids)
      : '';
  };

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

      // The reach collector observes every attempt of THIS candidate's
      // evaluation. It is created after the apply so the rendered playbook it
      // reads is the one the evaluation will actually see.
      const reachCollector = evidenceEnabled
        ? createReachCollector({
            ...(options?.reachProbe ? { probe: options.reachProbe } : {}),
            ...(options?.conditionsForTask
              ? { conditionsForTask: options.conditionsForTask }
              : {}),
            candidateBulletIds: applied.bulletIds,
            candidateBullets: bulletsById(applied.bulletIds),
            renderedBulletIds: renderedBulletIdsNow(),
            now: nowFn,
            nowIso: nowIso(),
            ...(options?.reachProbeBudgetMs !== undefined
              ? { probeBudgetMs: options.reachProbeBudgetMs }
              : {}),
          })
        : undefined;

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

      // Snapshot before this candidate's own evaluations so its receipt carries
      // ITS cost, not the running total of every candidate before it.
      const candidateSpendBefore = usedCalls();
      const candidateStartedAt = nowFn();
      const revalTrain = await runPhaseBatch(
        'candidate_eval',
        trainTasks,
        'current',
        undefined,
        reachCollector
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
          'heldOut',
          undefined,
          reachCollector
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
      const gateBase = {
        heldIn,
        revalTrain,
        heldOut,
        revalHeldOut,
        revalHeldOutBatch,
        epsilon,
        currentGainThreshold,
        requireHeldOut,
        hasRetentionPolicy: retentionPolicy !== undefined,
        retentionBatchesComplete: candidateRetentionBatches.every(
          ({ batch }) => batch.complete
        ),
      } as const;
      // `revalComplete`/`gainOk`/`heldOutOk` do not depend on retention, and
      // the retention receipt needs all three before it can be assembled — so
      // the pure gate runs once here and once again below with the measured
      // retention verdict folded in.
      const provisional = evaluateAgentPromotionGate({
        ...gateBase,
        retentionOk: true,
      });
      const { revalComplete, gainOk, heldOutOk, currentGain } = provisional;
      let retentionReceipt: AxAgentPlaybookRetentionReceipt | undefined;
      let retentionLoss: { worst: number; mean: number } | undefined;
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
        retentionLoss = {
          worst: worstHistoricalLoss,
          mean: meanHistoricalLoss,
        };
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
      const verdict = evaluateAgentPromotionGate({
        ...gateBase,
        retentionOk,
        ...(retentionLoss ? { retentionLoss } : {}),
      });
      const legacyAccept = verdict.accept;

      // ---- Evidence conjuncts ----
      let evidence: AxAgentPlaybookEvidenceReceipt | undefined;
      let gateReport: AxAgentPlaybookGateReport | undefined;
      if (evidenceEnabled) {
        const terminationSplits = [revalTrain.termination];
        if (revalHeldOutBatch) {
          terminationSplits.push(revalHeldOutBatch.termination);
        }
        const termination = terminationReportOf(terminationSplits);

        const validity = evaluateValidity({
          inputs: [
            { split: 'current', records: revalTrain.records },
            ...(revalHeldOutBatch
              ? ([
                  { split: 'heldOut', records: revalHeldOutBatch.records },
                ] as const)
              : []),
          ],
          ...(options?.validity ? { options: options.validity } : {}),
          ...(registered ? { registered } : {}),
        });

        const currentInterval = intervalFor(
          anchorTrainRecords,
          revalTrain.records,
          currentSeed()
        );
        const heldOutInterval = intervalFor(
          anchorHeldOutRecords,
          revalHeldOutBatch?.records,
          heldOutSeed()
        );
        const bandSpread = varianceBands?.find(
          (band) => band.split === 'current'
        )?.spread;

        const reach = reachCollector?.report({
          delta: currentGain,
        });

        const overheadSplits: AxAgentPlaybookOverheadSplit[] = [];
        const currentOverhead = overheadSplitFrom({
          split: 'current',
          anchor: anchorTrainRecords,
          candidate: revalTrain.records,
          seed: currentSeed(),
          resamples: intervalSettings.resamples,
          level: intervalSettings.level,
        });
        if (currentOverhead) overheadSplits.push(currentOverhead);
        if (anchorHeldOutRecords && revalHeldOutBatch) {
          const heldOutOverhead = overheadSplitFrom({
            split: 'heldOut',
            anchor: anchorHeldOutRecords,
            candidate: revalHeldOutBatch.records,
            seed: heldOutSeed(),
            resamples: intervalSettings.resamples,
            level: intervalSettings.level,
          });
          if (heldOutOverhead) overheadSplits.push(heldOutOverhead);
        }
        const overhead = overheadReportFrom(overheadSplits);

        gateReport = await evaluateGateChain({
          kind: 'curate',
          gain: {
            revalComplete,
            currentGain,
            threshold: currentGainThreshold,
            ...(termination.incompleteFromEnvironmentFailures
              ? {
                  incompleteFromEnvironmentFailures: true,
                  tasksWithNoScoredAttempt: termination.splits.reduce(
                    (sum, split) => sum + split.tasksWithNoScoredAttempt,
                    0
                  ),
                }
              : {}),
          },
          ...(revalHeldOut !== undefined && heldOut !== undefined
            ? {
                heldOut: {
                  delta: revalHeldOut - heldOut,
                  tolerance: epsilon,
                },
              }
            : {}),
          ...(retentionPolicy
            ? {
                retention: {
                  ok: retentionOk,
                  detail: retentionReceipt
                    ? `worst ${retentionReceipt.worstHistoricalLoss.toFixed(3)}, mean ${retentionReceipt.meanHistoricalLoss.toFixed(3)}`
                    : 'retention receipt unavailable',
                },
              }
            : {}),
          validity: {
            mode: options?.gates?.validity ?? 'off',
            report: validity,
          },
          interval: {
            mode: options?.gates?.interval ?? 'off',
            ...(currentInterval ? { current: currentInterval } : {}),
            ...(heldOutInterval ? { heldOut: heldOutInterval } : {}),
            ...(bandSpread !== undefined ? { bandSpread } : {}),
          },
          ...(reach
            ? {
                reach: {
                  mode: options?.gates?.reach ?? 'off',
                  report: reach.report,
                },
              }
            : {}),
        });

        const warnings: AxAgentPlaybookEvidenceWarning[] = [
          ...(reach?.warnings ?? []),
        ];
        if (currentInterval?.direction === 'unresolved') {
          warnings.push({
            code: 'interval_unresolved',
            message: `the current-split interval [${currentInterval.lower.toFixed(3)}, ${currentInterval.upper.toFixed(3)}] contains zero; the delta is unresolved, not an effect`,
            scope: 'current',
          });
        }
        if (bandSpread !== undefined && Math.abs(currentGain) <= bandSpread) {
          warnings.push({
            code: 'delta_within_variance_band',
            message: `delta ${currentGain.toFixed(3)} is within the unchanged-artifact band spread ${bandSpread.toFixed(3)}`,
            scope: 'current',
          });
        }
        if (termination.worstDiscardRate > maxEnvironmentDiscardRate) {
          warnings.push({
            code: 'high_environment_discard_rate',
            message: `environment-failure discard rate ${termination.worstDiscardRate.toFixed(3)} exceeds ${maxEnvironmentDiscardRate}${runsPerTask === 1 ? ' at runsPerTask: 1, which has no redundancy at all' : ''}`,
          });
        }
        if (termination.incompleteFromEnvironmentFailures) {
          warnings.push({
            code: 'evaluation_incomplete_environment',
            message:
              'a task ended with no scored attempt after re-draws were exhausted; the candidate cannot be promoted on incomplete evidence',
          });
        }
        if (overhead?.worstRelativeDelta !== undefined) {
          if (legacyAccept && overhead.worstRelativeDelta > overheadWarnRatio) {
            warnings.push({
              code: 'overhead_exceeds_gain',
              message: `the accepted artifact costs ${(overhead.worstRelativeDelta * 100).toFixed(1)}% more turns/calls/tokens than the anchor; report it next to the gain`,
            });
          }
        }
        if (heldOut !== undefined) {
          warnings.push({
            code: 'held_out_reused_for_selection',
            message: `heldOut has been re-anchored to an accepted candidate ${heldOutSelectionComparisons} time(s); this is a SELECTION split, not a sealed test, and the implied family-wise error rate at level ${intervalSettings.level} is ${(1 - intervalSettings.level ** heldOutSelectionComparisons).toFixed(3)}`,
            scope: 'heldOut',
          });
        }

        const nomination: AxAgentPlaybookNomination = (() => {
          const candidateDigest = canonicalDigest({
            proposal,
            bulletIds: applied.bulletIds,
          });
          const splitDigests = {
            current: splitDigestOf(trainTasks),
            ...(validationTasks?.length
              ? { heldOut: splitDigestOf(validationTasks) }
              : {}),
            slices: (retentionPolicy?.slices ?? []).map((slice, index) => ({
              name: slice.name,
              version: slice.version,
              digest: sliceTaskSetDigests[index] ?? '',
            })),
          };
          const judgeModel = revalTrain.usage.find(
            (usage) => typeof usage?.ai === 'string'
          );
          const core = {
            candidateDigest,
            ...(retentionPolicy?.evaluatorId
              ? { evaluatorId: retentionPolicy.evaluatorId }
              : {}),
            ...(judgeModel
              ? { judgeModel: { ai: judgeModel.ai, model: judgeModel.model } }
              : {}),
            splitDigests,
          };
          const passed = (gateReport?.entries ?? [])
            .filter((entry) => entry.status === 'pass')
            .map((entry) => entry.id);
          const failedGates = (gateReport?.entries ?? [])
            .filter(
              (entry) =>
                entry.status === 'fail' || entry.status === 'unmeasured'
            )
            .map((entry) => entry.id);
          return {
            ...core,
            splitDigestBasis,
            // Receipt metadata and a post-hoc integrity value. NOT an
            // authorization binding: a mid-run digest is a value no host could
            // have pre-granted.
            promotionDigest: canonicalDigest(core),
            // Empty until a promotionAuthority names one. Ax never derives a
            // resource id, because a derived id is one the host cannot grant.
            resourceId: '',
            gatesPassed: passed,
            gatesFailed: failedGates,
            nominated: legacyAccept && gateChainAccepts(gateReport!),
          };
        })();

        // Per-slice paired intervals, so a retention slice reports its own
        // uncertainty instead of leaving the receipt's `slices` array empty
        // whenever a retentionPolicy is configured.
        const sliceIntervals = (retentionPolicy?.slices ?? []).flatMap(
          (slice, index) => {
            const interval = intervalFor(
              sliceAnchorRecords[index],
              candidateRetentionBatches[index]?.batch.records,
              sliceSeed(slice.tasks as readonly AxAgentEvalTask<IN>[])
            );
            return interval
              ? [{ name: slice.name, version: slice.version, interval }]
              : [];
          }
        );

        const chainAccepts = gateChainAccepts(gateReport);
        if (legacyAccept && chainAccepts && overhead) finalOverhead = overhead;
        evidence = buildEvidenceReceipt({
          kind: 'curate',
          nomination,
          intervals: {
            current:
              currentInterval ??
              ({
                point: currentGain,
                lower: currentGain,
                upper: currentGain,
                level: intervalSettings.level,
                resamples: 0,
                unit: 'task',
                clusters: 0,
                seed: currentSeed(),
                direction: 'unresolved',
              } as AxAgentPlaybookInterval),
            ...(heldOutInterval ? { heldOut: heldOutInterval } : {}),
            ...(sliceIntervals.length > 0 ? { slices: sliceIntervals } : {}),
          },
          reach: reach?.report ?? {
            basis: 'rendered_only',
            counterfactual: true,
            gateEligible: false,
            splits: [],
          },
          validity,
          termination,
          ...(overhead ? { overhead } : {}),
          gates: gateReport,
          promotion: { status: 'not_required', nomination },
          accounting: candidateAccounting({
            metricCalls: usedCalls() - candidateSpendBefore,
            usage: [
              ...revalTrain.usage,
              ...(revalHeldOutBatch?.usage ?? []),
              ...candidateRetentionBatches.flatMap(({ batch }) => batch.usage),
            ],
            wallClockMs: nowFn() - candidateStartedAt,
            usesBuiltInJudge,
          }),
          selectionComparisons: heldOutSelectionComparisons,
          level: intervalSettings.level,
          warnings,
          decision: legacyAccept && chainAccepts ? 'accepted' : 'rejected',
        });
        // The run-level list is a summary, not a concatenation: the same
        // disclosure repeated once per candidate is noise a reader learns to
        // skip, which is how a real warning gets missed.
        for (const warning of warnings) {
          const key = `${warning.code}|${warning.scope ?? ''}`;
          if (seenRunWarnings.has(key)) continue;
          seenRunWarnings.add(key);
          runWarnings.push(warning);
        }
      }

      const accept =
        legacyAccept && (gateReport ? gateChainAccepts(gateReport) : true);
      const gateRejection =
        legacyAccept && gateReport?.failedGate
          ? `${gateReport.failedGate} gate failed: ${
              gateReport.failedPredicate ??
              gateReport.entries.find(
                (entry) => entry.id === gateReport.failedGate
              )?.detail ??
              ''
            }`
          : undefined;

      outcomes.push({
        proposal,
        kind: 'curate',
        ...(evidence ? { evidence } : {}),
        status: accept ? 'accepted' : 'rejected',
        accepted: accept,
        reason: gateRejection ?? verdict.reason,
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
        // The next candidate is compared against THIS candidate's records, so
        // pairing stays reference-aligned and the re-anchoring is explicit.
        anchorTrainRecords = revalTrain.records;
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
          anchorHeldOutRecords = revalHeldOutBatch?.records;
          // Every accept re-anchors the held-out split to the accepted
          // candidate, which is exactly what makes it a selection split.
          heldOutSelectionComparisons++;
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
  if (evidenceEnabled) {
    // Absence is visible, never silent: a run with evidence machinery on that
    // did NOT run a matched-budget arm says so on the record.
    runWarnings.push({
      code: 'control_arm_not_run',
      message:
        'no matched-budget control arm was configured, so this run cannot say whether simple test-time scaling reproduces the gain',
    });
    runWarnings.push({
      code: 'transfer_not_run',
      message:
        'no transfer targets were configured, so per-cell regressions on other backbones are unmeasured',
    });
    runWarnings.push({
      code: 'sealed_test_not_run',
      message:
        'no sealed test was configured; every held-out number here is a selection number',
    });
    if (accounting.costBasis === 'unknown' && accepted.length > 0) {
      // Restricted to accepts on purpose: firing on every run is how "no
      // winner is reported without its cost" decays into ignorable noise.
      runWarnings.push({
        code: 'cost_unknown',
        message:
          'a candidate was accepted with no costFor hook, so its cost is unknown; Ax has no provider cost field and never estimates one',
      });
    }
    // Scoped to the STRUCTURALLY unobservable phases only, so the warning's
    // "without a usageTap" remedy is always the true one. An observable phase
    // that reported nothing reads `tokensBasis: 'unreported'` and is not named
    // here.
    const unobservable = unobservableTokenPhases(accounting);
    if (unobservable.length > 0) {
      runWarnings.push({
        code: 'tokens_unobservable',
        message: `token totals for ${unobservable.join(', ')} cannot be observed without a usageTap; they are reported absent rather than as zero`,
      });
    }
  }

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
    ...(finalOverhead ? { overhead: finalOverhead } : {}),
    ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
  };
}
