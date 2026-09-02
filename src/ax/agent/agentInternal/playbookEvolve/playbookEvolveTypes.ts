/**
 * Public types for `agent.playbook().evolve(dataset, options)` — verified (or
 * trust-batch) playbook learning. The engine (batch eval → failure clustering
 * → grounded weakness mining → bounded playbook proposal → regression-gated
 * accept) is hidden behind the method, exactly as `optimize()` hides GEPA.
 * Verified learning produces only playbook bullets.
 */

import type { AxAIService } from '../../../ai/types.js';
import type { AxMetricFn } from '../../../dsp/common_types.js';
import type { AxPlaybookSnapshot } from '../../../dsp/playbook.js';
import type { AxGenIn, AxGenOut } from '../../../dsp/types.js';
import type {
  AxAgentEvalPrediction,
  AxAgentEvalTask,
  AxAgentJudgeOptions,
} from '../agentOptimizeTypes.js';
import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookCostFn,
  AxAgentPlaybookEviction,
  AxAgentPlaybookEvidenceGates,
  AxAgentPlaybookEvidenceReceipt,
  AxAgentPlaybookEvidenceWarning,
  AxAgentPlaybookIntervalOptions,
  AxAgentPlaybookOverheadReport,
  AxAgentPlaybookPromotionRecord,
  AxAgentPlaybookPruneProposal,
  AxAgentPlaybookReachProbe,
  AxAgentPlaybookRedundancyReport,
  AxAgentPlaybookSealedTestReport,
  AxAgentPlaybookTransferReport,
  AxAgentPlaybookUsageTap,
  AxAgentPlaybookValidityOptions,
  AxAgentPlaybookVarianceBandOptions,
  AxAgentPlaybookVarianceBandReport,
  AxAgentTrajectoryClassifier,
} from './playbookEvidenceTypes.js';

/** One executed (task, prediction, score) triple from the batch harness. */
export type AxAgentPlaybookEvolveRunRecord<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> = {
  task: AxAgentEvalTask<IN>;
  /** Absent when the run threw before producing a prediction. */
  prediction?: AxAgentEvalPrediction<OUT>;
  score: number;
  /** `score >= scoreThreshold` and the run neither threw nor stalled. */
  passed: boolean;
  /** Message of a thrown (non-clarification) run error. */
  error?: string;
  /**
   * One entry per attempt, including re-draws and attempts discarded as
   * environment failures. Equal weight regardless of calls or tokens. Present
   * only when an evidence option asked the harness to capture them.
   */
  attempts?: readonly AxAgentPlaybookAttemptRecord[];
};

/** A verifier-grounded weakness mined from one failure cluster. */
export type AxAgentPlaybookWeakness = {
  id: string;
  /** Deterministic cluster fingerprint the weakness was mined from. */
  clusterSignature: string;
  description: string;
  rootCause: string;
  /** The avoidance rule/lesson the proposal carries into the playbook. */
  proposedGuidance: string;
  /**
   * Quotes from the actual failure excerpts that ground this weakness. Only
   * quotes that substring-match the real excerpts survive; a weakness with
   * zero surviving quotes is discarded.
   */
  evidenceQuotes: readonly string[];
  /** Tasks in the cluster (by id or index). */
  taskIds: readonly string[];
  /** Report-only configuration suggestions; never auto-applied. */
  configRecommendations: readonly string[];
};

/** A bounded proposal: one curated playbook update per mined weakness. */
export type AxAgentPlaybookEvolveProposal = {
  weaknessId: string;
  /** Cluster signature recorded on the update event (dedupe ledger). */
  clusterSignature: string;
  /** Digest handed to the playbook update (curator input). */
  feedback: string;
};

/** A historical slice Ax clones and freezes before establishing its anchor. */
export type AxAgentPlaybookRetentionSlice = {
  /** Stable human-readable identity, for example `billing-refunds`. */
  name: string;
  /** Caller-managed dataset or contract version, for example `2026-08`. */
  version: string;
  /** Evaluator-owned tasks. These are scored but never shown to the miner. */
  tasks: readonly AxAgentEvalTask<any>[];
};

/**
 * Optional stability/plasticity gate for verified playbook proposals. All
 * thresholds are explicit; supplying this policy changes no evaluator and
 * does not promote or deploy anything outside the existing evolve call.
 */
export type AxAgentPlaybookRetentionPolicy = {
  /** Caller-managed identity/version of the metric or judge configuration. */
  evaluatorId: string;
  slices: readonly AxAgentPlaybookRetentionSlice[];
  /** Plasticity: minimum gain on the current training task set. */
  minCurrentGain: number;
  /** Stability: maximum loss on any one historical slice. */
  maxWorstHistoricalLoss: number;
  /** Stability: maximum unweighted mean loss across historical slices. */
  maxMeanHistoricalLoss: number;
};

/** Immutable anchor score established before any proposal is applied. */
export type AxAgentPlaybookRetentionAnchor = {
  name: string;
  version: string;
  taskCount: number;
  taskSetDigest: string;
  policyDigest: string;
  evaluatorId: string;
  sequence: number;
  score: number;
  evidence: {
    executedRuns: number;
    expectedRuns: number;
    complete: true;
  };
};

/** Per-slice evidence and aggregate accounting for one promotion decision. */
export type AxAgentPlaybookRetentionReceipt = {
  policy: {
    digest: string;
    evaluatorId: string;
    currentTaskSetDigest: string;
    heldOutTaskSetDigest?: string;
  };
  sequence: number;
  currentTask: {
    before: number;
    after: number;
    gain: number;
    taskSetDigest: string;
    anchorSequence: number;
    candidateSequence: number;
    anchorEvidence: {
      executedRuns: number;
      expectedRuns: number;
      complete: true;
    };
    candidateEvidence: {
      executedRuns: number;
      expectedRuns: number;
      complete: true;
    };
  };
  heldOut?: {
    taskSetDigest: string;
    anchorSequence: number;
    candidateSequence: number;
    anchorEvidence: {
      executedRuns: number;
      expectedRuns: number;
      complete: true;
    };
    candidateEvidence: {
      executedRuns: number;
      expectedRuns: number;
      complete: true;
    };
  };
  slices: readonly {
    name: string;
    version: string;
    taskCount: number;
    taskSetDigest: string;
    anchorSequence: number;
    candidateSequence: number;
    anchorScore: number;
    candidateScore: number;
    historicalLoss: number;
    anchorEvidence: {
      executedRuns: number;
      expectedRuns: number;
      complete: true;
    };
    candidateEvidence: {
      executedRuns: number;
      expectedRuns: number;
      complete: true;
    };
  }[];
  worstHistoricalLoss: number;
  meanHistoricalLoss: number;
  thresholds: {
    minCurrentGain: number;
    maxWorstHistoricalLoss: number;
    maxMeanHistoricalLoss: number;
  };
  accepted: boolean;
};

export type AxAgentPlaybookEvolveOutcome = {
  proposal: AxAgentPlaybookEvolveProposal;
  status: 'accepted' | 'rejected';
  accepted: boolean;
  reason: string;
  heldIn: { before: number; after: number };
  heldOut?: { before: number; after: number };
  /** Present only when every configured retention slice was evaluated. */
  retention?: AxAgentPlaybookRetentionReceipt;
  /**
   * REQUIRED. `'curate'` for every legacy path; `'prune'` for a removal
   * proposal. Breaking for construction sites (host test doubles, adapters),
   * declared as such: an optional discriminant would reintroduce exactly the
   * silent-absence problem the evidence work exists to remove.
   */
  kind: 'curate' | 'prune';
  /** Present only when `kind === 'prune'`. */
  prune?: AxAgentPlaybookPruneProposal;
  /**
   * Bullets the ACE curator evicted while applying THIS proposal, recovered
   * from the artifact-history delta. Non-empty triggers `curate_eviction`.
   */
  evictions?: readonly AxAgentPlaybookEviction[];
  /** Present when any evidence option is set. */
  evidence?: AxAgentPlaybookEvidenceReceipt;
  /** Mirrors `evidence.promotion`. Includes the rolled-back status. */
  promotion?: AxAgentPlaybookPromotionRecord;
};

export type AxAgentPlaybookEvolveProgressEvent = {
  phase:
    | 'baseline'
    | 'mining'
    | 'proposal'
    | 'validation'
    | 'done'
    | 'band'
    | 'control'
    | 'ablation'
    | 'transfer'
    | 'prune'
    | 'promotion'
    | 'sealed_test';
  message: string;
  metricCallsUsed: number;
};

export type AxAgentPlaybookEvolveOptions<IN extends AxGenIn = AxGenIn> = {
  /**
   * Keep only proposals that provably help — re-score train + held-out after
   * each candidate bullet and accept only on a held-in gain without a
   * held-out regression, else roll it back. Default true. With `false`,
   * mined lessons are applied without the gate (fast trust-batch).
   */
  verify?: boolean;
  /**
   * Require a non-empty held-out set, prove it is disjoint from training, and
   * fail closed unless every baseline and candidate evaluation completes.
   * Also requires enough metric budget for one complete baseline + candidate
   * evaluation. Task weights must be finite and non-negative with a positive
   * finite total weight per split. Default false for backward compatibility.
   * Cannot be combined with `verify: false`.
   */
  requireHeldOut?: boolean;
  /**
   * Stable semantic task identity used to prove train/validation disjointness
   * when `requireHeldOut` is enabled. Defaults to each task's `id`. Ax does not
   * infer independence from object references or serialized task contents.
   * IDs must be non-empty strings; runtime non-string values are rejected.
   */
  taskId?: (task: Readonly<AxAgentEvalTask<IN>>) => string | undefined;
  /** Runs the agent during evaluation. Defaults to the agent's `ai`. */
  studentAI?: Readonly<AxAIService>;
  /** Mines weaknesses. Defaults to `judgeAI`, then the student. */
  teacherAI?: Readonly<AxAIService>;
  /** Scores runs via the built-in judge. Resolution mirrors `optimize()`. */
  judgeAI?: Readonly<AxAIService>;
  judgeOptions?: AxAgentJudgeOptions;
  /**
   * Optional deterministic scorer replacing the LLM judge. Structured metric
   * results use their scalar score; playbook evolution does not consume their
   * feedback or named objectives.
   */
  metric?: AxMetricFn;
  /** Maximum weaknesses mined / proposals evaluated. Default 4. */
  maxProposals?: number;
  /**
   * Budget counting (agent run + judge) pairs across baseline and
   * re-evaluations. Default `max(100, (maxProposals + 1) * (train + validation)
   * * runsPerTask)`. Must be a positive safe integer at most 1,000,000.
   */
  maxMetricCalls?: number;
  /**
   * Times each task runs per evaluation, with scores averaged. Must be a
   * positive safe integer at most 100. Default 1.
   * Use 2-3 when the dataset is small: accept/reject compares mean scores,
   * and on a handful of tasks a single lucky or unlucky run can otherwise
   * decide the gate. Each repeat spends budget.
   */
  runsPerTask?: number;
  /** Tolerated held-out drop when accepting a proposal (verify). Default 0.01. */
  epsilon?: number;
  /** Required held-in improvement to accept a proposal (verify). Default 0.05. */
  minHeldInGain?: number;
  /**
   * Optional named/versioned historical anchors and explicit
   * stability/plasticity thresholds. Requires `verify` (the default). Anchor
   * tasks consume metric budget and remain hidden from weakness mining.
   */
  retentionPolicy?: Readonly<AxAgentPlaybookRetentionPolicy>;
  /** Records scoring below this count as failures for mining. Default 0.7. */
  scoreThreshold?: number;
  /**
   * Keep accepted bullets on the live playbook (default). With `false`, the
   * playbook is rolled back at the end and the result's `playbookSnapshot`
   * carries the accepted state for a later `getPlaybook()?.load(...)`.
   */
  apply?: boolean;
  verbose?: boolean;
  onProgress?: (event: Readonly<AxAgentPlaybookEvolveProgressEvent>) => void;
  abortSignal?: AbortSignal;

  // --- Evidence options. All optional; all default to today's behaviour. ---
  // Options whose execution has not landed yet are deliberately absent rather
  // than declared-and-ignored: an accepted-but-inert option is exactly the
  // silent absence this machinery exists to remove. `gates.controlArm` and
  // `gates.transfer` therefore fail closed at option validation until their
  // arms ship.

  /** Gate modes for the evidence conjuncts. Every gate defaults to 'off'. */
  gates?: AxAgentPlaybookEvidenceGates;
  varianceBand?: AxAgentPlaybookVarianceBandOptions;
  intervalOptions?: AxAgentPlaybookIntervalOptions;
  validity?: AxAgentPlaybookValidityOptions;
  reachProbe?: AxAgentPlaybookReachProbe<IN>;
  /** Soft cumulative budget for `reachProbe` across the whole run. Default 1_000. */
  reachProbeBudgetMs?: number;
  /**
   * Per-task retrieval conditions for the `applicability_counterfactual` reach
   * basis. COUNTERFACTUAL BY CONSTRUCTION — it cannot satisfy the reach gate.
   */
  conditionsForTask?: (
    task: Readonly<AxAgentEvalTask<IN>>
  ) => readonly string[];
  classifyTermination?: AxAgentTrajectoryClassifier<IN>;
  /** Warn above this environment-failure discard rate. Default 0.1. */
  maxEnvironmentDiscardRate?: number;
  /**
   * Bounded re-draws per discarded attempt, within the SAME metric budget.
   * Default 1 when `classifyTermination` is supplied, 0 otherwise: without it,
   * one 429 at `runsPerTask: 1` rejects every candidate with a false reason.
   */
  maxDiscardRedraws?: number;
  /** Caller cost hook. Without it `costUsd` is undefined and the basis unknown. */
  costFor?: AxAgentPlaybookCostFn;
  /** Usage tap for the 'mining' and 'judge' phases. Caller-owned. */
  usageTap?: AxAgentPlaybookUsageTap;
  /** Warn when the accepted artifact's relative overhead exceeds this. Default 0.25. */
  overheadWarnRatio?: number;
  /** Injected clock for durations and latency ceilings. Default `Date.now`. */
  now?: () => number;
};

export type AxAgentPlaybookEvolveResult<OUT extends AxGenOut = AxGenOut> = {
  baseline: { heldIn: number; heldOut?: number };
  final: { heldIn: number; heldOut?: number };
  /** Fixed pre-proposal scores for configured historical retention slices. */
  retentionAnchors?: readonly AxAgentPlaybookRetentionAnchor[];
  weaknesses: readonly AxAgentPlaybookWeakness[];
  outcomes: readonly AxAgentPlaybookEvolveOutcome[];
  /** Config suggestions collected from mined weaknesses; never auto-applied. */
  recommendations: readonly string[];
  /**
   * Playbook state after the accepted bullets. Present when `applied` is
   * `'live'` or `'dry_run'` and at least one candidate was accepted, and
   * `undefined` whenever `applied === 'rolled_back'` — the documented recovery
   * idiom (`getPlaybook()?.load(...)`) must never hand a caller an artifact a
   * run-level gate just rejected.
   */
  playbookSnapshot?: AxPlaybookSnapshot;
  metricCallsUsed: number;
  /** The baseline corpus (post-run records with scores). */
  records: readonly AxAgentPlaybookEvolveRunRecord<any, OUT>[];
  /**
   * REQUIRED. `{ status: 'not_run', reason }` when no control arm was
   * configured, so a run without a matched-budget comparison says so on the
   * record instead of omitting the field.
   */
  control: AxAgentPlaybookControlArmReport;
  /** REQUIRED. Every model call the run made, under one defined denominator. */
  accounting: AxAgentPlaybookComputeAccounting;
  /**
   * REQUIRED. Three-state, because `false` conflated two opposite meanings:
   *   'live'        the accepted set is applied. `playbookSnapshot` is live.
   *   'dry_run'     `apply: false`; the accepted set was rolled back by
   *                 request. `playbookSnapshot` is the INTENDED artifact and is
   *                 safe to re-apply.
   *   'rolled_back' a run-level gate rejected the whole set.
   *                 `playbookSnapshot` is `undefined`: the artifact is poison.
   */
  applied: 'live' | 'dry_run' | 'rolled_back';
  varianceBand?: AxAgentPlaybookVarianceBandReport;
  transfer?: AxAgentPlaybookTransferReport;
  redundancy?: AxAgentPlaybookRedundancyReport;
  /** Anchor-vs-candidate turn / call / token cost of the final artifact. */
  overhead?: AxAgentPlaybookOverheadReport;
  /** Evaluated once at the end; forbidden from influencing any gate. */
  sealedTest?: AxAgentPlaybookSealedTestReport;
  /** Set only when `applied === 'rolled_back'`; names the gate. */
  rolledBackReason?: string;
  warnings?: readonly AxAgentPlaybookEvidenceWarning[];
};
