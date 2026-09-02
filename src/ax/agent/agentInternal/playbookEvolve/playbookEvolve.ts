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

import type { AxAIService } from '../../../ai/types.js';
import type { AxAuthorizationReceipt } from '../../../authority/types.js';
import {
  estimateTokenCount,
  renderPlaybook,
} from '../../../dsp/optimizers/acePlaybook.js';
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
  emptyAccounting,
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
import {
  bestControlArmOf,
  controlArmComparisonMade,
  controlArmVerdict,
  runControlArms,
} from './controlArm.js';
import type {
  AxAgentEvalBatchResult,
  AxAgentEvalBudget,
} from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import {
  buildEvidenceReceipt,
  rescindPromotion,
  supersedeEvidenceReceipt,
} from './evidenceReceipt.js';
import { clusterFailures } from './failureClusters.js';
import { evaluateAgentPromotionGate } from './gate.js';
import type { AxGateChainInput } from './gates.js';
import { evaluateGateChain, gateChainAccepts } from './gates.js';
import type {
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookComputePhaseName,
  AxAgentPlaybookControlArmKind,
  AxAgentPlaybookControlArmOptions,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookEvidenceReceipt,
  AxAgentPlaybookEvidenceWarning,
  AxAgentPlaybookGateReport,
  AxAgentPlaybookInterval,
  AxAgentPlaybookNomination,
  AxAgentPlaybookOverheadReport,
  AxAgentPlaybookOverheadSplit,
  AxAgentPlaybookPromotionDenialCode,
  AxAgentPlaybookPromotionRecord,
  AxAgentPlaybookPromotionVeto,
  AxAgentPlaybookPruneOptions,
  AxAgentPlaybookPruneProposal,
  AxAgentPlaybookRedundancyEntry,
  AxAgentPlaybookRedundancyReport,
  AxAgentPlaybookSealedTestReport,
  AxAgentPlaybookSplitName,
  AxAgentPlaybookTransferReport,
  AxAgentPlaybookVarianceBand,
  AxAgentPlaybookVarianceBandReport,
  AxAgentPlaybookVetoResult,
} from './playbookEvidenceTypes.js';
import {
  AxAgentPlaybookEvolveError,
  axIsAgentPlaybookEvolveError,
} from './playbookEvidenceTypes.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveOutcome,
  AxAgentPlaybookEvolveProgressEvent,
  AxAgentPlaybookEvolveProposal,
  AxAgentPlaybookEvolveResult,
  AxAgentPlaybookEvolveRunRecord,
  AxAgentPlaybookRetentionAnchor,
  AxAgentPlaybookRetentionReceipt,
  AxAgentPlaybookWeakness,
} from './playbookEvolveTypes.js';
import {
  promotionRecordOf,
  requestPromotionAuthority,
  runPromotionVetoes,
  validatePromotionAuthority,
} from './promotion.js';
import type { AxAppliedProposal } from './proposals.js';
import {
  applyProposal,
  buildProposal,
  buildPruneRationaleText,
  collectEvictions,
  currentPlaybookText,
} from './proposals.js';
import {
  applyPrune,
  PRUNE_DEFAULT_MAX_ABLATIONS,
  PRUNE_DEFAULT_MAX_CURRENT_LOSS,
  PRUNE_DEFAULT_MIN_TOKEN_REDUCTION,
  PRUNE_DEFAULT_OPERATION,
  pruneCandidateRanking,
  pruneOverflowSet,
  redundancyVerdictOf,
  renderedTokensOf,
  selectPruneProposals,
  transformPlaybookForPrune,
} from './pruning.js';
import { createReachCollector } from './reach.js';
import {
  captureSnapshot,
  snapshotStateOf,
  withRestoredArtifact,
} from './snapshots.js';
import type { AxTaskCluster } from './statistics.js';
import {
  clustersFromPairedRecords,
  pairedBootstrapInterval,
  seedFromDigest,
  validateIntervalOptions,
  varianceBandFrom,
} from './statistics.js';
import { terminationReportOf } from './termination.js';
import type { AxTransferPass, AxTransferSplit } from './transfer.js';
import {
  DEFAULT_TRANSFER_REGRESSION_FLOOR,
  runTransferPass,
  splitScoreOfBatch,
  transferCellsFrom,
  transferComparisonMade,
  transferReportFrom,
  transferRequiredMetricCalls,
  transferSplitsOf,
  transferVerdict,
  validateTransferOptions,
} from './transfer.js';
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
 * The sealed test's disjointness proof (RFC 7.8). Same machinery and same
 * message shape as `assertRequiredHeldOut`, under its own error code: a sealed
 * set that overlaps a split the run selected on is not a sealed test, it is a
 * second reading of a selection split wearing the word 'sealed'.
 *
 * Runs at option validation, BEFORE any evaluation, so the failure costs
 * nothing and cannot be mistaken for a measurement.
 */
function assertSealedTestDisjoint<IN extends AxGenIn>(args: {
  sealed: readonly AxAgentEvalTask<IN>[];
  train: readonly AxAgentEvalTask<IN>[];
  validation?: readonly AxAgentEvalTask<IN>[];
  taskId?: (task: Readonly<AxAgentEvalTask<IN>>) => string | undefined;
}): void {
  const fail = (message: string): never => {
    throw new AxAgentPlaybookEvolveError(
      'sealed_test_invalid',
      'sealed_test',
      message
    );
  };
  if (args.sealed.length === 0) {
    fail('sealedTest must contain at least one task.');
  }
  const idOf = args.taskId ?? ((task: AxAgentEvalTask<IN>) => task.id);
  const ids = (
    split: 'sealedTest' | 'train' | 'validation',
    tasks: readonly AxAgentEvalTask<IN>[]
  ) =>
    tasks.map((task, index) => {
      const raw = idOf(task);
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id) {
        fail(
          `sealedTest cannot prove disjointness: ${split}[${index}] has no semantic task id; set task.id or provide taskId.`
        );
      }
      return id;
    });
  const selectionIds = new Set([
    ...ids('train', args.train),
    ...ids('validation', args.validation ?? []),
  ]);
  const overlaps = [
    ...new Set(
      ids('sealedTest', args.sealed).filter((id) => selectionIds.has(id))
    ),
  ];
  if (overlaps.length > 0) {
    fail(
      `sealedTest requires tasks disjoint from train and validation; overlapping task id(s): ${overlaps.join(', ')}.`
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
  'controlArm',
  'varianceBand',
  'intervalOptions',
  'validity',
  'reachProbe',
  'conditionsForTask',
  'classifyTermination',
  'maxDiscardRedraws',
  'prune',
  'transfer',
  'sealedTest',
  'promotionAuthority',
  // A reject-only hook has nothing to reject on the trust-batch path: that
  // path accepts every proposal with no evaluation, so no nomination is ever
  // produced and the veto could never fire. An accepted-but-inert option is
  // exactly the silent absence this machinery exists to remove, so it fails
  // closed with the rest.
  'promotionVeto',
] as const;

const CONTROL_ARM_KINDS: ReadonlySet<AxAgentPlaybookControlArmKind> =
  new Set<AxAgentPlaybookControlArmKind>([
    'best_of_n',
    'self_refine',
    'harness_term',
  ]);

const DEFAULT_CONTROL_ARMS: readonly AxAgentPlaybookControlArmKind[] = [
  'best_of_n',
  'self_refine',
  'harness_term',
];

/**
 * Every rejection here is permanent behaviour, not a stub: a control arm that
 * cannot be compared against anything is worse than no control arm, because it
 * produces a number a reader will treat as a comparison.
 */
function validateControlArmOptions(
  controlArm: Readonly<AxAgentPlaybookControlArmOptions>,
  hasHeldOut: boolean
): void {
  const fail = (message: string): never => {
    throw new AxAgentPlaybookEvolveError(
      'control_arm_failed',
      'control_arm',
      message
    );
  };
  if (!hasHeldOut) {
    // Gate 1 REQUIRES a current-task gain, so the evolved artifact was selected
    // on `current` by construction. A control comparison there would reject good
    // candidates and accept over-fit ones roughly at random.
    fail(
      'controlArm requires a non-empty validation set; comparing an arm on the current split measures selection, not capability, and there is no fallback to it.'
    );
  }
  if (controlArm.arms !== undefined) {
    if (controlArm.arms.length === 0) {
      fail('controlArm.arms must name at least one arm.');
    }
    for (const kind of controlArm.arms) {
      if (!CONTROL_ARM_KINDS.has(kind)) {
        fail(`controlArm.arms contains an unknown arm '${String(kind)}'.`);
      }
    }
  }
  if (controlArm.selector !== undefined && controlArm.selector !== 'metric') {
    // Reserved, not implemented: a judge selector costs one judge call per task
    // on a non-default path. The field exists so the receipt records the
    // strength of the control the run was compared against.
    fail(
      `controlArm.selector '${controlArm.selector}' is reserved and not implemented; only 'metric' selection ships today.`
    );
  }
  for (const [name, value] of [
    ['bestOfN', controlArm.bestOfN],
    ['refineRounds', controlArm.refineRounds],
    ['maxMetricCalls', controlArm.maxMetricCalls],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`controlArm.${name} must be a positive safe integer.`);
    }
  }
  if (
    controlArm.neutralArtifact !== undefined &&
    typeof controlArm.neutralArtifact !== 'string'
  ) {
    fail('controlArm.neutralArtifact must be a string.');
  }
}

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
  verify: boolean,
  hasHeldOut: boolean
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
  if (gates?.controlArm && gates.controlArm !== 'off' && !options?.controlArm) {
    // A required (or warned) control-arm gate with no arm to compare against
    // is a gate that can never read anything. Fail closed at validation.
    throw new AxAgentPlaybookEvolveError(
      'control_arm_failed',
      'control_arm',
      'gates.controlArm needs a controlArm configuration; a control-arm gate with no arm cannot be evaluated.'
    );
  }
  if (options?.controlArm) {
    validateControlArmOptions(options.controlArm, hasHeldOut);
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
  if (
    gates?.transfer &&
    gates.transfer !== 'off' &&
    (options?.transfer?.targets?.length ?? 0) === 0
  ) {
    // A required (or warned) transfer gate with no target to evaluate is a gate
    // that can never read anything. Fail closed at validation, exactly as the
    // control-arm gate does.
    throw new AxAgentPlaybookEvolveError(
      'transfer_target_invalid',
      'transfer',
      'gates.transfer needs a transfer configuration with at least one target.'
    );
  }
  if (options?.transfer) {
    validateTransferOptions(options.transfer, hasHeldOut);
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
  if (options?.prune && options.prune.enabled !== true) {
    const configured = Object.keys(options.prune)
      .filter((key) => key !== 'enabled')
      .sort();
    if (configured.length > 0) {
      // The same rule `promotionVeto` gets: an option that is accepted, counted
      // as an evidence option, and then does nothing is the silent absence this
      // machinery exists to remove. `prune: { maxRenderedTokens: 400 }` reads
      // like a configured ceiling and enforces nothing.
      throw new AxAgentPlaybookEvolveError(
        'evidence_incomplete',
        'redundancy_ablation',
        `prune was configured with ${configured.join(', ')} but prune.enabled is not true, so the sweep never runs and none of it takes effect. Set prune.enabled: true, or drop the prune option.`
      );
    }
  }
  if (options?.prune?.enabled && !hasHeldOut) {
    // A leave-one-out verdict taken on the split the artifact was selected on
    // measures selection, not redundancy, so there is no fallback to `current`
    // here either.
    // Not `prune_apply_failed`: nothing was applied. The evidence a prune gate
    // needs cannot exist without a held-out split, which is what
    // `evidence_incomplete` names.
    throw new AxAgentPlaybookEvolveError(
      'evidence_incomplete',
      'redundancy_ablation',
      'prune.enabled requires a non-empty validation set; a leave-one-out redundancy reading on the current split measures selection, not redundancy.'
    );
  }
  validatePromotionAuthority(options?.promotionAuthority);
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
  validateEvidenceOptions(
    options,
    verify,
    (normalized.validation?.length ?? 0) > 0
  );
  if (options?.sealedTest) {
    assertSealedTestDisjoint({
      sealed: options.sealedTest,
      train: normalized.train,
      ...(normalized.validation ? { validation: normalized.validation } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
  }
  const evidenceEnabled = activeEvidenceOptions(options).length > 0;
  const usesBuiltInJudge = options?.metric === undefined;
  const maxDiscardRedraws =
    options?.maxDiscardRedraws ?? (options?.classifyTermination ? 1 : 0);
  const promotionVetoes: readonly AxAgentPlaybookPromotionVeto[] =
    options?.promotionVeto === undefined
      ? []
      : Array.isArray(options.promotionVeto)
        ? (options.promotionVeto as readonly AxAgentPlaybookPromotionVeto[])
        : [options.promotionVeto as AxAgentPlaybookPromotionVeto];
  /**
   * Gates 8 and 9 are the only ones that cost a host call, so the chain is run
   * twice ONLY when one of them is configured: once free, to produce the
   * nomination the veto is shown, and once with the thunks. With neither
   * configured the free report is the report and a legacy run pays nothing.
   */
  const hostGatesConfigured =
    promotionVetoes.length > 0 || options?.promotionAuthority !== undefined;
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
    reach?: { observe: (args: any) => void },
    /**
     * A SEPARATE counter, used only by the control arm. Its spend still lands
     * in `accounting.metricCalls` (the honest run total, I6) but it never moves
     * the run's own budget or the legacy `metricCallsUsed`, so an arm can
     * neither starve the search nor be hidden from the denominator.
     */
    armBudget?: AxAgentEvalBudget,
    metricTaskOf?: (task: AxAgentEvalTask<IN>) => AxAgentEvalTask<IN>,
    /**
     * The transfer matrix is the only caller that swaps the backbone: a cell is
     * the SAME artifact and the SAME metric on a DIFFERENT service, so the
     * service is the one thing a cell overrides and everything else — budget
     * accounting, termination classification, attempt capture — stays identical
     * to every other phase.
     */
    aiOverride?: Readonly<AxAIService>
  ): Promise<AxAgentEvalBatchResult<IN, OUT>> => {
    const handle = ledger.phase(phase);
    const spendFrom = armBudget ?? budget;
    const before = spendFrom.remaining;
    try {
      const result = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        ...(aiOverride ? { ai: aiOverride } : {}),
        budget: spendFrom,
        tasks,
        split,
        ...(sliceName ? { sliceName } : {}),
        ...(metricTaskOf ? { metricTaskOf } : {}),
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
      const spent = before - spendFrom.remaining;
      handle.addMetricCalls(spent);
      handle.close();
      // An arm draws from its own counter, so `usedCalls()` is already blind to
      // it; adding it to the evidence tally would double-subtract.
      if (!armBudget && !EVOLVE_ONLY_PHASES.has(phase)) {
        evidenceMetricCalls += spent;
      }
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

  // ---- Phase 0: capture the UNEVOLVED artifact ----
  // Unconditional, even with zero accepts and no evidence options: it is one
  // `getState()` and no metric calls, and a run-level phase must never have to
  // reconstruct a state that no longer exists. `captureSnapshot` is defensive
  // (a handle that cannot produce a state yields `undefined`) so this cannot
  // turn a working legacy call into a throw; the absence then surfaces as a
  // control arm that reports `failed`.
  const baselineSnapshot = captureSnapshot(playbookHandle);

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

  // ---- Phase 3: transfer anchors on the UNEVOLVED artifact ----
  // Runs before mining and before the curate loop, so a cell's anchor is the
  // target's own reading of the artifact the run started from. Borrowing the
  // primary model's baseline instead would attribute the model gap to the
  // playbook, which is the exact confusion per-cell reporting exists to remove.
  const transferOptions = options?.transfer;
  const transferSplits: readonly AxTransferSplit[] = transferOptions
    ? transferSplitsOf(transferOptions, (validationTasks?.length ?? 0) > 0)
    : [];
  const transferFloor =
    transferOptions?.regressionFloor ?? DEFAULT_TRANSFER_REGRESSION_FLOOR;
  const transferExpectedCells =
    (transferOptions?.targets.length ?? 0) * transferSplits.length;
  const tasksForTransferSplit = (split: AxTransferSplit) =>
    split === 'current' ? trainTasks : (validationTasks ?? []);
  /**
   * A SEPARATE counter, like the control arm's. Transfer runs on services the
   * caller owns and the run's own budget never paid for; charging it to the
   * search would let a transfer matrix starve the candidates it exists to
   * judge. Its spend still lands in `accounting.metricCalls`.
   */
  const transferBudget: AxAgentEvalBudget = { remaining: 0 };
  let transferAnchors: readonly AxTransferPass[] = [];
  let transferFailure: string | undefined;
  if (transferOptions) {
    const required = transferRequiredMetricCalls({
      targetCount: transferOptions.targets.length,
      splits: transferSplits,
      trainCount: trainTasks.length,
      heldOutCount: validationTasks?.length ?? 0,
      runsPerTask,
    });
    if (
      transferOptions.maxMetricCalls !== undefined &&
      transferOptions.maxMetricCalls < required
    ) {
      // Fail closed BEFORE any mutation: half a matrix is worse than none,
      // because the cells that did run look like the whole answer.
      throw new AxAgentPlaybookEvolveError(
        'budget_insufficient',
        'transfer',
        `transfer needs ${required} metric calls for ${transferExpectedCells} cell(s) (anchor + candidate pass, ${runsPerTask} run(s) per task); transfer.maxMetricCalls is ${transferOptions.maxMetricCalls}.`
      );
    }
    transferBudget.remaining = transferOptions.maxMetricCalls ?? required;
    progress(
      'transfer',
      `anchor pass: ${transferOptions.targets.length} target(s) x ${transferSplits.join(', ')} on the unevolved artifact`
    );
    try {
      transferAnchors = await runTransferPass<IN, OUT>({
        targets: transferOptions.targets,
        splits: transferSplits,
        tasksFor: tasksForTransferSplit,
        evaluate: (args) =>
          runPhaseBatch(
            'transfer',
            args.tasks,
            args.split,
            undefined,
            undefined,
            transferBudget,
            undefined,
            args.ai
          ),
      });
    } catch (error) {
      if (options?.abortSignal?.aborted) throw error;
      transferFailure = `the transfer anchor pass threw: ${error instanceof Error ? error.message : String(error)}`;
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

  /**
   * One evaluated candidate, whatever produced it. A curate proposal and a
   * prune proposal differ in exactly four places — how the mutation is applied,
   * which variant of gates 1/2 judges it, whether gate 7 has a rendered-size
   * reading, and the wording of an accepted reason — so they share one
   * evaluation, one retention receipt and one gate chain instead of two
   * implementations free to drift.
   */
  type CandidateSpec = Readonly<{
    kind: 'curate' | 'prune';
    /** Progress phase for this candidate's own events. */
    phase: AxAgentPlaybookEvolveProgressEvent['phase'];
    label: string;
    proposal: AxAgentPlaybookEvolveProposal;
    /** Present iff `kind === 'prune'`; carries gate 7's reading. */
    prune?: AxAgentPlaybookPruneProposal;
    /** Applies the mutation and returns its exact rollback. */
    apply: () => Promise<AxAppliedProposal>;
    /**
     * Gate 1 in `evaluateAgentPromotionGate`'s sign convention
     * (`currentGain >= threshold`): the minimum gain for a curate, and
     * `-maxCurrentLoss` for a prune — a removal is asked not to get worse, not
     * to win.
     */
    legacyGainThreshold: number;
    /** The same threshold in the gate chain's prune convention (`loss <= t`). */
    chainGainThreshold: number;
    /** Gate 2 tolerance: `epsilon` for a curate, `maxHeldOutLoss` for a prune. */
    heldOutTolerance: number;
  }>;

  const evaluateCandidate = async (spec: CandidateSpec): Promise<void> => {
    const { proposal } = spec;
    const requiredCalls =
      (trainTasks.length +
        (validationTasks?.length ?? 0) +
        retentionTaskCount) *
      runsPerTask;
    if (verify && budget.remaining < requiredCalls) {
      outcomes.push({
        proposal,
        kind: spec.kind,
        ...(spec.prune ? { prune: spec.prune } : {}),
        status: 'rejected',
        accepted: false,
        reason: 'metric_budget exhausted before validation',
        heldIn: { before: heldIn, after: heldIn },
      });
      progress(spec.phase, `${spec.label}: budget exhausted, skipped`);
      return;
    }

    progress('proposal', `${spec.label}: applying playbook proposal`);
    // Captured only when evidence is on: `getState()` clones the playbook,
    // and a legacy run must not pay for a diff nothing will read.
    const preApplySnapshot = evidenceEnabled
      ? captureSnapshot(playbookHandle)
      : undefined;
    let applied: AxAppliedProposal;
    try {
      applied = await spec.apply();
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        RESTORATION_FAILURE in err &&
        (err as Record<symbol, unknown>)[RESTORATION_FAILURE] === true
      ) {
        throw err;
      }
      // A prune's apply failure is a typed AxAgentPlaybookEvolveError and is
      // never swallowed into a rejection reason: `prune_apply_failed` means
      // the snapshot transform or its validation refused, which is a caller
      // or artifact defect, not a candidate that lost its gate.
      if (
        axIsAgentPlaybookEvolveError(err) &&
        err.code === 'prune_apply_failed'
      ) {
        throw err;
      }
      outcomes.push({
        proposal,
        kind: spec.kind,
        ...(spec.prune ? { prune: spec.prune } : {}),
        status: 'rejected',
        accepted: false,
        reason: `apply failed: ${err instanceof Error ? err.message : String(err)}`,
        heldIn: { before: heldIn, after: heldIn },
      });
      return;
    }
    inFlight = applied;
    // The eviction channel: `pruneSectionForAddition` drops the lowest-ranked
    // unprotected bullet on section overflow with no receipt and no gate, so
    // an accepted ADD can delete an existing bullet. Recorded, not closed.
    const evictions =
      preApplySnapshot && evidenceEnabled
        ? collectEvictions({
            before: preApplySnapshot,
            after: captureSnapshot(playbookHandle) ?? preApplySnapshot,
            weaknessId: proposal.weaknessId,
          })
        : [];

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
        kind: spec.kind,
        status: 'accepted',
        accepted: true,
        reason: 'applied without verification (verify: false)',
        heldIn: { before: heldIn, after: heldIn },
      });
      progress('validation', `${spec.label}: applied (trust-batch)`);
      return;
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
          : candidateRetentionBatches.find(({ batch }) => !batch.validEvidence)
              ?.batch;
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
      epsilon: spec.heldOutTolerance,
      currentGainThreshold: spec.legacyGainThreshold,
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
    let freeGateInput: AxGateChainInput | undefined;
    let promotion: AxAgentPlaybookPromotionRecord | undefined;
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

      freeGateInput = {
        kind: spec.kind,
        gain: {
          revalComplete,
          currentGain,
          threshold: spec.chainGainThreshold,
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
                tolerance: spec.heldOutTolerance,
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
        ...(spec.prune
          ? {
              pruneSize: {
                tokensBefore: spec.prune.renderedTokensBefore,
                tokensAfter: spec.prune.renderedTokensAfter,
                minTokenReduction:
                  spec.prune.appliedThresholds.minTokenReduction,
              },
            }
          : {}),
      };
      // The FREE gates decide the nomination, and the nomination is what a
      // veto is shown — so the free chain runs first and gates 8/9 are then
      // invoked as thunks over the very nomination they are judging. When no
      // host gate is configured the second pass is skipped entirely and this
      // report IS the report, which is what keeps a legacy run identical.
      gateReport = await evaluateGateChain(freeGateInput);

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
      if (evictions.length > 0) {
        // The real silent-loss channel, and it exists on the ADD path: an
        // accepted curate proposal deleted an existing bullet with no gate
        // and no receipt. Recorded here, not closed — closing it means
        // rejecting curator writes inside evolve(), which is a behaviour
        // change to the curate path and out of scope.
        warnings.push({
          code: 'curate_eviction',
          message: `applying ${proposal.weaknessId} evicted ${evictions.length} existing bullet(s) through section overflow (${evictions
            .map((eviction) => `${eviction.bulletId}@${eviction.section}`)
            .join(
              ', '
            )}); that deletion paid no gate and left no receipt of its own`,
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
            (entry) => entry.status === 'fail' || entry.status === 'unmeasured'
          )
          .map((entry) => entry.id);
        return {
          ...core,
          splitDigestBasis,
          // Receipt metadata and a post-hoc integrity value. NOT an
          // authorization binding: a mid-run digest is a value no host could
          // have pre-granted.
          promotionDigest: canonicalDigest(core),
          // The stable, host-grantable identity the grant binds to. Never
          // derived: a derived id is one the host cannot have pre-granted,
          // and `matchingGrants` filters by exact equality BEFORE the host
          // authorizer ever runs.
          resourceId: options?.promotionAuthority?.resourceId ?? '',
          gatesPassed: passed,
          gatesFailed: failedGates,
          nominated: legacyAccept && gateChainAccepts(gateReport!),
        };
      })();

      // Neither a veto nor an authorizer can CAUSE a promotion, so the
      // record starts at the strongest thing the free gates alone can say.
      promotion = hostGatesConfigured
        ? { status: 'not_nominated', nomination }
        : { status: 'not_required', nomination };

      // ---- Gates 8 and 9: the only gates that cost a host call ----
      if (hostGatesConfigured && freeGateInput) {
        const vetoResults: AxAgentPlaybookVetoResult[] = [];
        let authorityOutcome:
          | Readonly<
              | {
                  status: 'promoted';
                  receipt: Readonly<AxAuthorizationReceipt>;
                }
              | {
                  status: 'denied';
                  code: AxAgentPlaybookPromotionDenialCode;
                  reason: string;
                }
            >
          | undefined;
        gateReport = await evaluateGateChain({
          ...freeGateInput,
          ...(promotionVetoes.length > 0
            ? {
                veto: async () => {
                  const outcome = await runPromotionVetoes({
                    vetoes: promotionVetoes,
                    nomination,
                    timeoutMs: options?.promotionVetoTimeoutMs,
                    ...(options?.abortSignal
                      ? { signal: options.abortSignal }
                      : {}),
                  });
                  vetoResults.push(...outcome.results);
                  return { vetoed: outcome.vetoed, detail: outcome.detail };
                },
              }
            : {}),
          ...(options?.promotionAuthority
            ? {
                authority: async () => {
                  authorityOutcome = await requestPromotionAuthority({
                    promotionAuthority: options.promotionAuthority!,
                    nomination,
                    ...(options?.abortSignal
                      ? { signal: options.abortSignal }
                      : {}),
                  });
                  return authorityOutcome.status === 'promoted'
                    ? {
                        allowed: true,
                        detail: `promotion receipt ${authorityOutcome.receipt.receiptId} bound to resource '${nomination.resourceId}'`,
                      }
                    : {
                        allowed: false,
                        detail: `${authorityOutcome.code}: ${authorityOutcome.reason}`,
                      };
                },
              }
            : {}),
        });
        promotion = promotionRecordOf({
          nomination,
          vetoes: vetoResults,
          ...(authorityOutcome ? { authority: authorityOutcome } : {}),
          authorityConfigured: options?.promotionAuthority !== undefined,
        });
        // THE ONLY CHANNEL AN ABORTED RUN HAS. `outcomes[]` — and with it the
        // evidence receipt carrying this record — is unreachable when the run
        // rethrows `aborted` a few statements below, so a denial with code
        // 'cancelled' would otherwise be recorded into an object no consumer
        // could ever read. Emitted on every host-gated candidate, not only the
        // aborted one, so the promotion decision reads the same way whether or
        // not the run finishes.
        progress(
          'promotion',
          `${spec.label}: ${promotion.status}${
            promotion.status === 'denied'
              ? ` (${promotion.code}: ${promotion.reason})`
              : promotion.status === 'vetoed'
                ? ` (${promotion.vetoes
                    .filter((result) => result.vetoed)
                    .map(
                      (result) =>
                        `${result.vetoId}${result.reason ? `: ${result.reason}` : ''}`
                    )
                    .join('; ')})`
                : promotion.status === 'promoted'
                  ? ` (receipt ${promotion.receipt.receiptId} bound to resource '${nomination.resourceId}')`
                  : ''
          }`
        );
      }

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
        kind: spec.kind,
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
        promotion,
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
    // A prune's legacy verdict wording ("held-in gain below ...") describes a
    // rule it was not judged by, so a prune always names the gate that
    // decided. A curate keeps its exact legacy reason whenever the legacy
    // verdict is what rejected it.
    const gateRejection =
      gateReport?.failedGate && (spec.kind === 'prune' || legacyAccept)
        ? `${gateReport.failedGate} gate failed: ${
            gateReport.failedPredicate ??
            gateReport.entries.find(
              (entry) => entry.id === gateReport.failedGate
            )?.detail ??
            ''
          }`
        : undefined;
    const reason =
      gateRejection ??
      (spec.kind === 'prune' && accept && spec.prune
        ? `${spec.prune.operation} freed ${spec.prune.renderedTokensBefore - spec.prune.renderedTokensAfter} rendered token(s) with no measured current-task or held-out loss`
        : verdict.reason);

    outcomes.push({
      proposal,
      kind: spec.kind,
      ...(spec.prune ? { prune: spec.prune } : {}),
      ...(evictions.length > 0 ? { evictions } : {}),
      ...(evidence ? { evidence } : {}),
      ...(promotion && promotion.status !== 'not_required'
        ? { promotion }
        : {}),
      status: accept ? 'accepted' : 'rejected',
      accepted: accept,
      reason,
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
      progress(spec.phase, `${spec.label}: ACCEPTED`);
    } else {
      inFlight = undefined;
      applied.rollback();
      progress(spec.phase, `${spec.label}: rejected, rolled back`);
    }
  };

  /**
   * Phase 6. Leave-one-out on the CURRENT artifact, then one gated proposal.
   *
   * The sweep is a real cost — one held-out evaluation per ablated bullet — so
   * it is opt-in, bounded by `maxAblations`, and stops as soon as the remaining
   * budget cannot pay for a whole split. A partial sweep reports `partial`
   * rather than pretending it read every bullet.
   */
  const runPrunePhase = async (
    pruneOptions: Readonly<AxAgentPlaybookPruneOptions>
  ): Promise<AxAgentPlaybookRedundancyReport> => {
    const sweepAccounting = () =>
      accountingForPhases(
        ledger.assemble({ evolveOnlyMetricCalls: usedCalls() }),
        ['redundancy_ablation']
      );
    const state = captureSnapshot(playbookHandle);
    if (!state?.playbook) {
      return {
        status: 'not_run',
        reason:
          'the playbook handle produced no state, so no bullet could be ablated',
      };
    }
    const nowIsoValue = nowIso();
    const renderedTokens = renderedTokensOf(state.playbook, nowIsoValue);
    const maxRenderedTokens = pruneOptions.maxRenderedTokens;
    const onOverflow = pruneOptions.onOverflow ?? 'propose';
    const overBudget =
      maxRenderedTokens !== undefined && renderedTokens > maxRenderedTokens;
    const operation = pruneOptions.operation ?? PRUNE_DEFAULT_OPERATION;
    // The disclosure is DEFERRED until the phase knows what the overflow
    // actually cost. `renderPlaybook` truncates nothing — it emits every
    // applicable bullet — so the ceiling is a trigger, never a silent cut; but a
    // warning emitted before the prune it triggered goes on saying the playbook
    // is over budget even when the prune brought it back under, which is the
    // stale-disclosure failure this subsystem exists to remove.
    let disclosed = false;
    const discloseOverBudget = (settlement: string): void => {
      if (!overBudget || disclosed) return;
      disclosed = true;
      runWarnings.push({
        code: 'rendered_size_over_budget',
        message: `the rendered playbook is ${renderedTokens} estimated tokens against a ceiling of ${maxRenderedTokens}; ${settlement}. Nothing is ever truncated: renderPlaybook emits every applicable bullet.`,
      });
    };
    // `validateEvidenceOptions` already refuses `prune.enabled` without a
    // validation split, so the first clause is a type narrowing. The held-out
    // anchor is the part that can still go missing mid-run: every accept
    // re-anchors it, and a re-anchor batch that produced no records leaves the
    // sweep with nothing to compare an ablation against.
    const heldOutAnchorMean = heldOut;
    if (
      !validationTasks?.length ||
      !anchorHeldOutRecords ||
      heldOutAnchorMean === undefined
    ) {
      discloseOverBudget(
        'the leave-one-out sweep did not run, so nothing was pruned'
      );
      return {
        status: 'not_run',
        reason:
          'the leave-one-out sweep needs a non-empty validation set with a readable held-out anchor: a redundancy reading taken on the split the artifact was selected on measures selection, not redundancy',
      };
    }
    const ranking = pruneCandidateRanking(state.playbook, nowIsoValue);
    if (ranking.length === 0) {
      discloseOverBudget(
        'the rendered playbook has no removable bullet, so nothing was pruned'
      );
      return {
        status: 'not_run',
        reason: 'the rendered playbook has no removable bullet',
      };
    }
    const maxAblations = Math.max(
      1,
      Math.floor(pruneOptions.maxAblations ?? PRUNE_DEFAULT_MAX_ABLATIONS)
    );
    const bandSpread = varianceBands?.find(
      (band) => band.split === 'heldOut'
    )?.spread;
    const perAblation = validationTasks.length * runsPerTask;
    const entries: AxAgentPlaybookRedundancyEntry[] = [];
    let partial = false;
    for (const ref of ranking.slice(0, maxAblations)) {
      if (options?.abortSignal?.aborted) {
        throw new Error('AxAgent.playbook().evolve(): aborted');
      }
      if (budget.remaining < perAblation) {
        partial = true;
        break;
      }
      let measured:
        | Readonly<{
            batch: AxAgentEvalBatchResult<IN, OUT>;
            renderedTokensWithout: number;
          }>
        | undefined;
      let ablationError: unknown;
      try {
        const view = transformPlaybookForPrune({
          playbook: state.playbook,
          bulletIds: [ref.bullet.id],
          operation: 'remove',
          reason: 'leave-one-out ablation',
          nowIso: nowIsoValue,
        });
        const renderedTokensWithout = renderedTokensOf(
          view.playbook,
          nowIsoValue
        );
        playbookHandle?.load?.({
          playbook: view.playbook,
          artifact: state.artifact,
        });
        measured = {
          batch: await runPhaseBatch(
            'redundancy_ablation',
            validationTasks,
            'heldOut'
          ),
          renderedTokensWithout,
        };
      } catch (error) {
        ablationError = error;
      }
      // The ablated view is a playbook with a bullet deleted that NOBODY asked
      // to delete, so a failed restore is not a bookkeeping problem: it leaves
      // that view live. It gets the same one bounded retry §6 gives the
      // control-arm restore, and a second failure is a typed, named failure
      // rather than a raw ACE `load` error escaping from a `finally` and
      // replacing whatever was in flight.
      try {
        playbookHandle?.load?.(state);
      } catch (firstRestoreError) {
        try {
          playbookHandle?.load?.(state);
        } catch (secondRestoreError) {
          throw new AxAgentPlaybookEvolveError(
            'prune_apply_failed',
            'redundancy_ablation',
            `the leave-one-out ablation of bullet '${ref.bullet.id}' could not be undone after two attempts; the live playbook is still the ABLATED view and the artifact is indeterminate.`,
            {
              cause: new AggregateError(
                [
                  ...(ablationError === undefined ? [] : [ablationError]),
                  firstRestoreError,
                  secondRestoreError,
                ],
                `AxAgent.playbook().evolve(): the leave-one-out ablation of bullet '${ref.bullet.id}' could not be undone.`
              ),
            }
          );
        }
      }
      if (ablationError !== undefined) {
        if (options?.abortSignal?.aborted) throw ablationError;
        // An ablation that threw measured nothing. The sweep continues — a
        // single unreadable bullet must not silence every other verdict — and
        // the report says `partial` so no reader mistakes it for a full read.
        partial = true;
      }
      if (!measured) continue;
      const ablated = measured.batch;
      const interval = intervalFor(
        anchorHeldOutRecords,
        ablated.records,
        heldOutSeed()
      );
      if (!interval || !ablated.complete) {
        partial = true;
        if (!interval) continue;
      }
      const heldOutDelta = ablated.mean - heldOutAnchorMean;
      entries.push({
        bulletId: ref.bullet.id,
        section: ref.section,
        heldOutDelta,
        interval,
        verdict: redundancyVerdictOf({
          heldOutDelta,
          interval,
          ...(bandSpread !== undefined ? { bandSpread } : {}),
        }),
        // The bullet's RENDERED contribution, measured as the exact difference
        // between the full render and the render without it — not
        // `estimateTokenCount(content)`, which misses the per-bullet prefix and
        // the section framing `renderPlaybook` emits and therefore reads
        // systematically low in both the ordering key and the report.
        renderedTokens: Math.max(
          0,
          renderedTokens - measured.renderedTokensWithout
        ),
      });
    }
    if (entries.length === 0) {
      discloseOverBudget(
        'no leave-one-out ablation produced a reading, so nothing was pruned'
      );
      return {
        status: 'not_run',
        reason: partial
          ? 'no leave-one-out ablation could be read within the remaining budget'
          : 'no leave-one-out ablation produced a comparable held-out reading',
      };
    }
    const report: AxAgentPlaybookRedundancyReport = {
      status: partial ? 'partial' : 'completed',
      entries,
      accounting: sweepAccounting(),
    };
    if (onOverflow === 'warn' && overBudget) {
      discloseOverBudget(
        'onOverflow is "warn", so this is reported and nothing was pruned'
      );
      return report;
    }
    const thresholds = {
      maxCurrentLoss:
        pruneOptions.maxCurrentLoss ?? PRUNE_DEFAULT_MAX_CURRENT_LOSS,
      maxHeldOutLoss: pruneOptions.maxHeldOutLoss ?? epsilon,
      minTokenReduction:
        pruneOptions.minTokenReduction ?? PRUNE_DEFAULT_MIN_TOKEN_REDUCTION,
    };
    const proposals = selectPruneProposals({
      entries,
      playbook: state.playbook,
      operation,
      trigger: overBudget ? 'rendered_size_budget' : 'redundancy_sweep',
      thresholds,
      nowIso: nowIsoValue,
      // A size budget asks for the bytes back, not for every bullet the sweep
      // was able to call prunable. The overflow set is the smallest prefix of
      // the ranking that actually reaches the ceiling, so a playbook a few
      // tokens over its budget does not lose every redundant bullet it has.
      ...(overBudget && maxRenderedTokens !== undefined
        ? {
            restrictTo: pruneOverflowSet({
              entries,
              playbook: state.playbook,
              operation,
              maxRenderedTokens,
              nowIso: nowIsoValue,
            }),
          }
        : {}),
    });
    for (const prune of proposals) {
      const legacyProposal = buildPruneRationaleText(prune);
      await evaluateCandidate({
        kind: 'prune',
        phase: 'prune',
        label: prune.pruneId,
        proposal: legacyProposal,
        prune,
        apply: async () =>
          applyPrune({
            handle: playbookHandle,
            proposal: prune,
            legacyProposal,
            nowIso: nowIso(),
          }),
        // A removal cannot raise the current-task mean by `minCurrentGain`, so
        // gate 1 runs as a loss tolerance. Without this the prune gate ships
        // inert: every prune would be rejected before gate 7 was ever read.
        legacyGainThreshold: -thresholds.maxCurrentLoss,
        chainGainThreshold: thresholds.maxCurrentLoss,
        heldOutTolerance: thresholds.maxHeldOutLoss,
      });
    }
    // Now — and only now — the overflow disclosure can say what the overflow
    // cost, including whether the prune it triggered actually brought the render
    // back under the ceiling.
    const settledTokens = (() => {
      const settled = captureSnapshot(playbookHandle);
      return settled?.playbook
        ? renderedTokensOf(settled.playbook, nowIsoValue)
        : undefined;
    })();
    discloseOverBudget(
      proposals.length === 0
        ? 'no bullet was prunable, so nothing was proposed and the render is unchanged'
        : `${proposals.length} prune proposal(s) were emitted and the rendered playbook is now ${settledTokens ?? renderedTokens} estimated tokens, ${
            (settledTokens ?? renderedTokens) <= (maxRenderedTokens ?? 0)
              ? 'within the ceiling'
              : 'still over the ceiling'
          }`
    );
    return report;
  };

  let redundancy: AxAgentPlaybookRedundancyReport | undefined;

  try {
    for (const weakness of weaknesses) {
      if (options?.abortSignal?.aborted) {
        throw new Error('AxAgent.playbook().evolve(): aborted');
      }
      const proposal = buildProposal(weakness);
      await evaluateCandidate({
        kind: 'curate',
        phase: 'validation',
        label: weakness.id,
        proposal,
        apply: () => applyProposal({ proposal, playbookHandle }),
        legacyGainThreshold: currentGainThreshold,
        chainGainThreshold: currentGainThreshold,
        heldOutTolerance: epsilon,
      });
    }
    // ---- Phase 6: prune ----
    if (options?.prune?.enabled) {
      redundancy = await runPrunePhase(options.prune);
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

  // ---- Phase 7: capture the EVOLVED artifact ----
  // Captured before any run-level phase can disturb it, and unconditionally so
  // the digest a restore is checked against is the state the curate loop
  // actually left behind. It is only RETURNED when something was accepted,
  // which keeps `playbookSnapshot` byte-identical to the legacy contract.
  const evolvedSnapshot = captureSnapshot(playbookHandle);

  // ---- Phase 8: transfer candidates on the FINAL artifact ----
  // Same targets, same splits, same tasks, same metric — only the artifact
  // moved. That is what makes the per-cell delta a reading of the playbook and
  // not of the backbone.
  let transfer: AxAgentPlaybookTransferReport | undefined;
  if (transferOptions) {
    let candidates: readonly AxTransferPass[] = [];
    if (!transferFailure) {
      progress(
        'transfer',
        `candidate pass: ${transferOptions.targets.length} target(s) x ${transferSplits.join(', ')} on the final artifact`
      );
      try {
        candidates = await runTransferPass<IN, OUT>({
          targets: transferOptions.targets,
          splits: transferSplits,
          tasksFor: tasksForTransferSplit,
          evaluate: (args) =>
            runPhaseBatch(
              'transfer',
              args.tasks,
              args.split,
              undefined,
              undefined,
              transferBudget,
              undefined,
              args.ai
            ),
        });
      } catch (error) {
        if (options?.abortSignal?.aborted) throw error;
        transferFailure = `the transfer candidate pass threw: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    transfer = transferFailure
      ? // A target that could not be evaluated at all makes the WHOLE matrix
        // `not_run` rather than a partial one: the cells that did run would
        // otherwise read as the complete answer, and a required gate would pass
        // on a matrix missing exactly the target that broke.
        { status: 'not_run', reason: transferFailure }
      : transferReportFrom({
          floor: transferFloor,
          cells: transferCellsFrom({
            anchors: transferAnchors,
            candidates,
            floor: transferFloor,
            seedFor: (split) =>
              split === 'current' ? currentSeed() : heldOutSeed(),
            resamples: intervalSettings.resamples,
            level: intervalSettings.level,
          }),
          accounting: accountingForPhases(
            ledger.assemble({ evolveOnlyMetricCalls: usedCalls() }),
            ['transfer']
          ),
          expectedCells: transferExpectedCells,
        });
  }

  /**
   * Phase 9. Runs inside `load(baseline) … finally load(evolved)` (§7.1), which
   * is what makes "on the unevolved program" true rather than asserted, and
   * spends from a SEPARATE counter so it can never starve the search.
   */
  const runControlArmPhase = async (
    armOptions: Readonly<AxAgentPlaybookControlArmOptions>
  ): Promise<AxAgentPlaybookControlArmReport> => {
    const heldOutTasks = validationTasks ?? [];
    // Scoped to the arm's own phases, and assembled WITHOUT `costFor` so a
    // caller's cost hook is invoked exactly once, in the run's own accounting.
    const armAccounting = () =>
      accountingForPhases(
        ledger.assemble({ evolveOnlyMetricCalls: usedCalls() }),
        ['control_arm', 'harness_term_ablation']
      );
    if (!baselineSnapshot || !evolvedSnapshot) {
      return {
        status: 'failed',
        reason:
          'the playbook handle produced no snapshot, so no arm could be run against the unevolved program',
        accounting: emptyAccounting(),
      };
    }
    const arms = armOptions.arms ?? DEFAULT_CONTROL_ARMS;
    // The ceiling is read HERE — at the instant the curate loop ends and before
    // the arm spends anything — so the matching is not circular.
    const matched = armOptions.maxMetricCalls ?? usedCalls();
    const budgetBasis: 'evolve_total' | 'caller_supplied' =
      armOptions.maxMetricCalls === undefined
        ? 'evolve_total'
        : 'caller_supplied';
    const baselineState = snapshotStateOf(baselineSnapshot);
    const evolvedState = snapshotStateOf(evolvedSnapshot);
    const evolvedRenderedTokens = estimateTokenCount(
      renderPlaybook(evolvedSnapshot.playbook, { now: nowIso() })
    );
    progress(
      'control',
      `matched budget ${matched} metric calls (${budgetBasis}) across ${arms.length} arm(s) on ${heldOutTasks.length} held-out task(s)`
    );

    let armFailure: unknown;
    const restored = await withRestoredArtifact({
      handle: playbookHandle,
      restoreTo: baselineState,
      returnTo: evolvedState,
      run: async () => {
        try {
          return await runControlArms<IN, OUT>({
            arms,
            tasks: heldOutTasks,
            runsPerTask,
            matched,
            options: armOptions,
            evolvedRenderedTokens,
            nowIso: nowIso(),
            now: nowFn,
            usesBuiltInJudge,
            evaluate: (evaluateArgs) =>
              runPhaseBatch(
                evaluateArgs.phase,
                evaluateArgs.tasks,
                'heldOut',
                undefined,
                undefined,
                evaluateArgs.budget,
                evaluateArgs.metricTaskOf
              ),
            loadNeutralArtifact: (playbook) => {
              playbookHandle?.load?.({
                playbook,
                // A synthetic artifact has no history of its own; borrowing the
                // baseline's would attribute the neutral text to real curation.
                artifact: { playbook, feedback: [], history: [] },
              });
            },
            restoreUnevolvedArtifact: () => {
              playbookHandle?.load?.(baselineState.snapshot);
            },
            progress,
            ...(options?.abortSignal
              ? { abortSignal: options.abortSignal }
              : {}),
          });
        } catch (error) {
          // An abort is the caller's decision and keeps its exact legacy
          // message; anything else makes the arm `failed`, which is a run-level
          // rollback under `require` and never a silent pass.
          if (options?.abortSignal?.aborted) throw error;
          armFailure = error;
          return undefined;
        }
      },
    });

    if (restored.status === 'restore_failed') {
      return {
        status: 'failed',
        reason: restored.reason,
        accounting: armAccounting(),
      };
    }
    if (armFailure !== undefined || restored.value === undefined) {
      return {
        status: 'failed',
        reason: `a control arm threw: ${armFailure instanceof Error ? armFailure.message : String(armFailure)}`,
        accounting: armAccounting(),
      };
    }
    const { runs, skipped } = restored.value;
    if (runs.length === 0) {
      return {
        status: 'failed',
        reason: `no control arm could run (${skipped.map((entry) => `${entry.kind}: ${entry.reason}`).join('; ')})`,
        accounting: armAccounting(),
      };
    }
    const best = bestControlArmOf(runs);
    const evolvedHeldOutMean = heldOut ?? 0;
    // Pair the BEST arm's per-task scores against the final artifact's own
    // held-out records, by split position: the arm ran over the same split, but
    // a refinement round hands the agent a derived task object, so object
    // identity is not the pairing key here.
    const positionOf = new Map<object, number>();
    for (const [position, task] of heldOutTasks.entries()) {
      if (!positionOf.has(task as object)) {
        positionOf.set(task as object, position);
      }
    }
    const clusters: AxTaskCluster[] = [];
    for (const record of anchorHeldOutRecords ?? []) {
      const position = positionOf.get(record.task as object);
      if (position === undefined) continue;
      const armScore = best.scores[position];
      if (armScore === undefined) continue;
      clusters.push({
        weight: heldOutTasks[position]?.weight ?? 1,
        deltas: [record.score - armScore],
      });
    }
    const evolvedAdvantage = evolvedHeldOutMean - best.result.heldOut.mean;
    const interval =
      clusters.length > 0
        ? pairedBootstrapInterval({
            clusters,
            seed: heldOutSeed(),
            resamples: intervalSettings.resamples,
            level: intervalSettings.level,
          })
        : undefined;
    const incomplete =
      skipped.length > 0 ||
      interval === undefined ||
      runs.some((run) => !run.result.heldOut.complete);
    return {
      status: incomplete ? 'partial' : 'completed',
      matchedBudget: accountingForPhases(
        ledger.assemble({ evolveOnlyMetricCalls: usedCalls() }),
        [...EVOLVE_ONLY_PHASES]
      ),
      budgetBasis,
      arms: runs.map((run) => run.result),
      best: {
        kind: best.result.kind,
        split: 'heldOut',
        mean: best.result.heldOut.mean,
      },
      evolvedAdvantage,
      interval:
        interval ??
        ({
          point: evolvedAdvantage,
          lower: evolvedAdvantage,
          upper: evolvedAdvantage,
          level: intervalSettings.level,
          resamples: 0,
          unit: 'task',
          clusters: 0,
          seed: heldOutSeed(),
          direction: 'unresolved',
        } as AxAgentPlaybookInterval),
      heldOutSelectionComparisons,
      accounting: armAccounting(),
    };
  };

  // ---- Phase 9: matched-budget control arm on the UNEVOLVED artifact ----
  let control: AxAgentPlaybookControlArmReport = {
    status: 'not_run',
    reason: 'controlArm option not supplied',
  };
  const controlArmOptions = options?.controlArm;
  if (controlArmOptions) {
    control = await runControlArmPhase(controlArmOptions);
  }

  // ---- Phase 10: run-level verdict ----
  // A run-level gate judges the RUN, not a candidate, so its only remedy is to
  // roll the whole accepted set back. `warn` still has to say something: a mode
  // that produces no observable output is the silent absence this machinery
  // exists to remove.
  let rolledBackReason: string | undefined;
  /** Which run-level gate decided. Carried into the I8 cascade verbatim. */
  let rolledBackGate: 'transfer' | 'control_arm' = 'control_arm';
  const dryRun = options?.apply === false;
  /**
   * A run-level gate rescinds a live accepted set. A dry run applied nothing
   * and a run that accepted nothing changed nothing, so in both cases the
   * finding is reported and nothing is rolled back — relabelling either as
   * `rolled_back` would tell the caller an artifact went live and was withdrawn
   * and would run the I8 cascade over a state that never existed.
   */
  const rollbackAvailable = accepted.length > 0 && !dryRun;
  const rollbackSuffix =
    accepted.length === 0
      ? '; no candidate was accepted, so there is no artifact change to roll back'
      : dryRun
        ? '; this run was a dry run (apply: false), so nothing was applied for a run-level gate to roll back'
        : '';

  // The transfer gate is evaluated FIRST: a per-cell regression on another
  // backbone is a statement about the artifact itself, and a run that fails it
  // should say so under the transfer gate rather than under whichever gate
  // happened to be checked first.
  const transferGateMode = options?.gates?.transfer ?? 'off';
  if (transfer && transfer.status !== 'not_run') {
    if (transfer.regressedCells.length > 0) {
      // Emitted whatever the gate mode is, including 'off': a measured
      // regression on another backbone is a finding, not a gate artifact.
      const worst = [...transfer.cells]
        .filter((cell) => cell.regressed)
        .sort((a, b) => a.delta - b.delta)[0]!;
      runWarnings.push({
        code: 'transfer_cell_regressed',
        message: `${transfer.regressedCells.length} of ${transfer.cells.length} transfer cell(s) regressed beyond the ${transfer.floor} floor: ${transfer.regressedCells.join(', ')}; worst delta ${worst.delta.toFixed(3)}. No average is reported: an average over these cells would hide it.`,
        scope: `${worst.targetId}:${worst.split}`,
      });
    }
  }
  if (transferGateMode !== 'off') {
    const verdict = transferVerdict({
      report: transfer ?? {
        status: 'not_run',
        reason: 'transfer option not supplied',
      },
    });
    if (!verdict.passed) {
      if (transferGateMode === 'require' && rollbackAvailable) {
        rolledBackGate = 'transfer';
        rolledBackReason = `transfer gate failed: ${verdict.detail}`;
      } else if (
        // `transfer_cell_regressed` is already on the record above; a second
        // copy of the same finding is noise. Only the "there was nothing to
        // read" case still needs a warning of its own here.
        !transfer ||
        !transferComparisonMade(transfer)
      ) {
        runWarnings.push({
          code: 'transfer_unmeasured',
          message: `${verdict.detail}${rollbackSuffix}`,
        });
      }
    }
  }

  const controlGateMode = options?.gates?.controlArm ?? 'off';
  if (
    (control.status === 'partial' || control.status === 'completed') &&
    control.interval.clusters === 0
  ) {
    // The report carries an interval field whatever happens, so an interval
    // that was never computed says so on the record rather than sitting on the
    // receipt shaped exactly like a real paired bootstrap.
    runWarnings.push({
      code: 'interval_unresolved',
      message:
        "the control arm's advantage carries no paired interval: no held-out task could be paired between the best arm and the evolved artifact's own records, so `interval` is reported with clusters 0 and resamples 0 rather than as a computed comparison",
      scope: 'heldOut',
    });
  }
  if (controlGateMode !== 'off') {
    const verdict = controlArmVerdict({
      margin: options?.gates?.controlArmMargin ?? 0,
      report: control,
    });
    if (!verdict.passed) {
      // The FIRST failing run-level gate owns the rollback reason: a caller
      // reading `rolledBackReason` must see the gate that decided, not the last
      // one that also happened to fail.
      if (
        controlGateMode === 'require' &&
        rollbackAvailable &&
        !rolledBackReason
      ) {
        rolledBackGate = 'control_arm';
        rolledBackReason = `control_arm gate failed: ${verdict.detail}`;
      } else {
        // A run that accepted nothing has no artifact change for a run-level
        // gate to reject, and calling its unchanged baseline 'rolled_back'
        // would label a perfectly good artifact as poison. The finding is still
        // on the record, in `control` and in this warning.
        runWarnings.push({
          // `not_beaten` asserts a comparison happened. When the arm did not
          // run, threw, or measured nothing, that assertion would be false.
          code: controlArmComparisonMade(control)
            ? 'control_arm_not_beaten'
            : 'control_arm_unmeasured',
          message: `${verdict.detail}${rollbackSuffix}`,
          scope: 'heldOut',
        });
      }
    }
  }

  // ---- Finalize ----
  let applied: 'live' | 'dry_run' | 'rolled_back' =
    options?.apply === false ? 'dry_run' : 'live';
  let playbookSnapshot =
    accepted.length > 0
      ? (evolvedSnapshot ?? playbookHandle?.getState())
      : undefined;

  if (rolledBackReason) {
    const rollbackErrors = rollbackAccepted();
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        'AxAgent.playbook().evolve(): run-level rollback failed.'
      );
    }
    applied = 'rolled_back';
    // The artifact a run-level gate just rejected is POISON, not a draft: the
    // documented `getPlaybook()?.load(...)` recovery idiom must never hand a
    // caller one. This is exactly why `applied` is three-state and not a
    // boolean.
    playbookSnapshot = undefined;
    // Invariant I8: every accepted candidate becomes `superseded`, every live
    // promotion becomes `promoted_then_rolled_back`, and all of it moves
    // together with `applied` / `playbookSnapshot` / `rolledBackReason`.
    let rescindedPromotions = 0;
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome.accepted) continue;
      const evidence = outcome.evidence
        ? supersedeEvidenceReceipt(outcome.evidence, {
            gate: rolledBackGate,
            reason: rolledBackReason,
          })
        : undefined;
      const promotion = outcome.promotion
        ? rescindPromotion(outcome.promotion, {
            gate: rolledBackGate,
            reason: rolledBackReason,
          })
        : undefined;
      if (promotion?.status === 'promoted_then_rolled_back') {
        rescindedPromotions++;
      }
      outcomes[index] = {
        ...outcome,
        ...(evidence ? { evidence } : {}),
        ...(promotion ? { promotion } : {}),
      };
    }
    runWarnings.push({
      code: 'promotion_rolled_back',
      message: `${rolledBackReason}; the accepted set was rolled back, ${rescindedPromotions} promotion(s) rescinded, and every accepted candidate's receipt now reads 'superseded'`,
    });
  } else if (options?.apply === false) {
    const rollbackErrors = rollbackAccepted();
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        'AxAgent.playbook().evolve(): exact dry-run rollback failed.'
      );
    }
  }

  // ---- Phase 11: the sealed test ----
  // AFTER the run-level verdict and after the rollback, so there is no branch
  // in which a sealed reading could reach a gate, a threshold, an accept
  // decision or a rollback. `influencedNoDecision: true` is a literal type; this
  // placement is what makes it true rather than merely asserted.
  let sealedTest: AxAgentPlaybookSealedTestReport | undefined;
  const sealedTasks = options?.sealedTest;
  if (sealedTasks?.length) {
    sealedTest = await (async (): Promise<AxAgentPlaybookSealedTestReport> => {
      const liveSnapshot = captureSnapshot(playbookHandle);
      const finalSnapshot =
        applied === 'rolled_back'
          ? baselineSnapshot
          : (evolvedSnapshot ?? liveSnapshot);
      if (
        !playbookHandle ||
        !baselineSnapshot ||
        !finalSnapshot ||
        !liveSnapshot
      ) {
        return {
          status: 'not_run',
          reason:
            'the playbook handle produced no snapshot, so neither the baseline nor the final artifact could be put in front of the sealed split',
        };
      }
      const baselineState = snapshotStateOf(baselineSnapshot);
      const finalState = snapshotStateOf(finalSnapshot);
      const liveState = snapshotStateOf(liveSnapshot);
      if (finalState.digest === baselineState.digest) {
        // Same artifact on both sides. Running it anyway would spend
        // `2 x |sealed| x runsPerTask` calls to measure run-to-run noise and
        // then report it under a field a reader takes for the run's result.
        return {
          status: 'not_run',
          reason: `the run produced no artifact change (applied: ${applied}, ${accepted.length} accepted), so a sealed-test delta would measure run-to-run noise rather than the run`,
        };
      }
      const sealedBudget: AxAgentEvalBudget = {
        remaining: 2 * sealedTasks.length * runsPerTask,
      };
      const evaluateSealed = () =>
        runPhaseBatch(
          'sealed_test',
          sealedTasks,
          'slice',
          'sealed_test',
          undefined,
          sealedBudget
        );
      const pass = async (
        target: typeof baselineState,
        label: 'baseline' | 'final'
      ) => {
        progress(
          'sealed_test',
          `${label} artifact on ${sealedTasks.length} sealed task(s)`
        );
        return withRestoredArtifact({
          handle: playbookHandle,
          restoreTo: target,
          returnTo: liveState,
          run: evaluateSealed,
        });
      };
      const baselinePass = await pass(baselineState, 'baseline');
      if (baselinePass.status === 'restore_failed') {
        return { status: 'not_run', reason: baselinePass.reason };
      }
      const finalPass = await pass(finalState, 'final');
      if (finalPass.status === 'restore_failed') {
        return { status: 'not_run', reason: finalPass.reason };
      }
      const baselineBatch = baselinePass.value;
      const finalBatch = finalPass.value;
      const sealedSeed =
        intervalSettings.seed ??
        seedFromDigest(
          canonicalDigest(sealedTasks.map((task) => task.id ?? ''))
        );
      const delta = finalBatch.mean - baselineBatch.mean;
      const interval = intervalFor(
        baselineBatch.records,
        finalBatch.records,
        sealedSeed
      );
      if (!interval) {
        runWarnings.push({
          code: 'interval_unresolved',
          message:
            'the sealed test carries no paired interval: its baseline and final passes could not be aligned task by task, so the interval is reported with clusters 0 and resamples 0 rather than as a computed comparison',
          scope: 'sealed_test',
        });
      }
      return {
        status: 'completed',
        baseline: splitScoreOfBatch(baselineBatch),
        final: splitScoreOfBatch(finalBatch),
        delta,
        interval:
          interval ??
          ({
            point: delta,
            lower: delta,
            upper: delta,
            level: intervalSettings.level,
            resamples: 0,
            unit: 'task',
            clusters: 0,
            seed: sealedSeed,
            direction: 'unresolved',
          } as AxAgentPlaybookInterval),
        influencedNoDecision: true,
        accounting: accountingForPhases(
          ledger.assemble({ evolveOnlyMetricCalls: usedCalls() }),
          ['sealed_test']
        ),
      };
    })();
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
  if (evidenceEnabled) {
    if (!controlArmOptions) {
      // Absence is visible, never silent: a run with evidence machinery on that
      // did NOT run a matched-budget arm says so on the record.
      runWarnings.push({
        code: 'control_arm_not_run',
        message:
          'no matched-budget control arm was configured, so this run cannot say whether simple test-time scaling reproduces the gain',
      });
    } else if (
      !(controlArmOptions.arms ?? DEFAULT_CONTROL_ARMS).includes('harness_term')
    ) {
      // The neutral-artifact ablation is the only arm that separates "this
      // bullet helped" from "any text in that slot helped", so dropping it is
      // recorded rather than inferred from the arms list.
      runWarnings.push({
        code: 'harness_term_not_run',
        message:
          'the harness_term arm was excluded, so this run cannot attribute its gain to the bullet rather than to any text of the same size in the playbook slot',
      });
    }
    if (!transfer || transfer.status === 'not_run') {
      runWarnings.push({
        code: 'transfer_not_run',
        message: transfer
          ? `the transfer matrix did not produce a reading: ${transfer.reason}`
          : 'no transfer targets were configured, so per-cell regressions on other backbones are unmeasured',
      });
    }
    if (!sealedTest || sealedTest.status === 'not_run') {
      runWarnings.push({
        code: 'sealed_test_not_run',
        message: sealedTest
          ? `the sealed test did not run: ${sealedTest.reason}; every held-out number here is a selection number`
          : 'no sealed test was configured; every held-out number here is a selection number',
      });
    }
    if (!options?.promotionAuthority && accepted.length > 0) {
      // The default stays permissive — a promotion without a grant is allowed —
      // but it is never silent. Restricted to accepts for the same reason
      // `cost_unknown` is: a warning that fires on every run is one a reviewer
      // learns to skip.
      runWarnings.push({
        code: 'promotion_without_receipt',
        message: `${accepted.length} candidate(s) were promoted into the playbook with no promotionAuthority configured, so no AxAuthorizationReceipt exists for any of them`,
      });
    }
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
    applied,
    ...(varianceBand ? { varianceBand } : {}),
    ...(transfer ? { transfer } : {}),
    ...(sealedTest ? { sealedTest } : {}),
    ...(redundancy ? { redundancy } : {}),
    ...(finalOverhead ? { overhead: finalOverhead } : {}),
    ...(rolledBackReason ? { rolledBackReason } : {}),
    ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
  };
}
