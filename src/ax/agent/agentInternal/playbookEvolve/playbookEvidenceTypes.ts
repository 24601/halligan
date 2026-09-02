/**
 * Evidence types for `agent.playbook().evolve()`.
 *
 * This is the playbook-evolve sub-namespace's `types.ts`: every new `Ax*`
 * interface, type alias and error class lives here, and the implementation
 * modules (`statistics.ts`, `termination.ts`, `validity.ts`, `reach.ts`,
 * `accounting.ts`, `gates.ts`, `evidenceReceipt.ts`) hold the logic.
 *
 * Design rules this file encodes, and which the implementation must preserve:
 *  - An unknown value is `undefined`, never zero and never estimated.
 *  - A measurement that Ax cannot observe reports `unmeasured` / `unobservable`
 *    with a named reason, and fails closed under a `require` gate.
 *  - Every report that can be absent has an inhabited `not_run` state carrying
 *    a reason, so absence is visible in the receipt rather than a missing key.
 */

import type { AxAIService, AxModelConfig } from '../../../ai/types.js';
import type {
  AxAuthorityContext,
  AxAuthorizationReceipt,
} from '../../../authority/types.js';
import type { AxPlaybookSnapshot } from '../../../dsp/playbook.js';
import type { AxProgramUsage } from '../../../dsp/types.js';
import type {
  AxAgentEvalFunctionCall,
  AxAgentEvalPrediction,
  AxAgentEvalTask,
} from '../agentOptimizeTypes.js';

// ---------------------------------------------------------------------------
// 4.0 Shared scalars
// ---------------------------------------------------------------------------

/** Which evaluated corpus a measurement came from. */
export type AxAgentPlaybookSplitName = 'current' | 'heldOut' | 'slice';

/** One split's aggregate for one artifact state. */
export type AxAgentPlaybookSplitScore = Readonly<{
  mean: number;
  executedRuns: number;
  /** Attempts discarded as environment failures. Never counted as zeros. */
  discardedRuns: number;
  expectedRuns: number;
  complete: boolean;
}>;

/**
 * Model identity behind a measurement.
 * `effort` reuses ax's closed request-hint union (`AxModelConfig['effort']`)
 * and is populated only from the caller's model config — no provider reports
 * it on usage, so it is `undefined` whenever the config did not set one. It is
 * never widened to `string`.
 */
export type AxAgentPlaybookModelIdentity = Readonly<{
  ai: string;
  model: string;
  effort?: NonNullable<AxModelConfig['effort']>;
}>;

// ---------------------------------------------------------------------------
// 4.1 Compute accounting
// ---------------------------------------------------------------------------

export type AxAgentPlaybookComputePhaseName =
  | 'baseline'
  | 'variance_band'
  /** Weakness mining, including proposal construction, which is itself free. */
  | 'mining'
  | 'candidate_eval'
  | 'retention_eval'
  | 'control_arm'
  | 'harness_term_ablation'
  | 'transfer'
  | 'redundancy_ablation'
  | 'sealed_test'
  | 'judge'
  | 'veto'
  | 'authority';

/** How a token or cost figure was arrived at. Absence is always explained. */
export type AxAgentPlaybookTokensBasis =
  | 'observed'
  | 'partial'
  | 'unobservable'
  | 'unreported'
  | 'none';

export type AxAgentPlaybookComputePhase = Readonly<{
  name: AxAgentPlaybookComputePhaseName;
  /** (agent run + metric) pairs drawn from a metric budget. */
  metricCalls: number;
  /** Model calls made outside the metric budget: miner, judge, refiner. */
  modelCalls: number;
  /**
   * Sum of `AxTokenUsage.totalTokens` over every usage record observed in this
   * phase — NOT `promptTokens + completionTokens`, which would drop
   * `reasoningTokens`/`thoughtsTokens`, i.e. exactly the compute a
   * matched-budget claim must not lose. `undefined` when nothing in the phase
   * reported usage, or when the phase's calls are structurally unobservable.
   */
  totalTokens?: number;
  /**
   * 'observed'      every call in the phase surfaced usage.
   * 'partial'       some calls surfaced usage.
   * 'unobservable'  the phase's calls cannot surface usage without `usageTap`:
   *                 'mining' (the miner builds its own AxGen and returns no
   *                 usage) and 'judge' (reached only as an opaque AxMetricFn).
   * 'unreported'    the phase's calls COULD surface usage and none did — the
   *                 provider reported nothing. Distinct from 'unobservable'
   *                 because a `usageTap` is not the remedy here: labelling an
   *                 observable phase unobservable points a reader at a fix
   *                 that would change nothing.
   * 'none'          the phase made no model calls.
   */
  tokensBasis: AxAgentPlaybookTokensBasis;
  wallClockMs: number;
  /**
   * Distinct model identities that produced usage IN THIS PHASE. Present only
   * when at least one was observed, so a phase-scoped accounting cannot name a
   * model that never ran in it.
   */
  models?: readonly AxAgentPlaybookModelIdentity[];
}>;

/**
 * Every model call the run made, including failed candidates, the control arm,
 * mining, judging, and every ablation. Never estimated: an unknown value is
 * `undefined`.
 *
 * DENOMINATOR (the load-bearing definition, invariant I6):
 *   `metricCalls` is the HONEST RUN TOTAL — the sum of `phases[].metricCalls`
 *   over every phase, including the control arm, the band, transfer cells,
 *   ablations and the sealed test. `AxAgentPlaybookEvolveResult.metricCallsUsed`
 *   is unchanged and remains the LEGACY EVOLVE-ONLY counter. The two are equal
 *   only when no evidence phase ran. `evolveOnlyMetricCalls` restates the
 *   legacy number inside the accounting so a receipt read in isolation still
 *   shows both.
 */
export type AxAgentPlaybookComputeAccounting = Readonly<{
  /** Honest run total. Equals the sum of `phases[].metricCalls`. */
  metricCalls: number;
  /** The legacy `metricCallsUsed` counter: baseline + candidate + retention. */
  evolveOnlyMetricCalls: number;
  modelCalls: number;
  totalTokens?: number;
  tokensBasis: AxAgentPlaybookTokensBasis;
  /** Caller-computed via `costFor`. Ax never derives or estimates a cost. */
  costUsd?: number;
  /** Makes the absence of a cost explicit rather than a missing key. */
  costBasis: 'caller_supplied' | 'unknown';
  wallClockMs: number;
  phases: readonly AxAgentPlaybookComputePhase[];
  /** Distinct model identities that produced any measurement in this run. */
  models: readonly AxAgentPlaybookModelIdentity[];
}>;

/**
 * Caller-owned cost hook. Ax has NO provider cost field anywhere in
 * `AxProgramUsage` -> `AxModelUsage` -> `AxTokenUsage`, so without this hook
 * `costUsd` is permanently `undefined` and `costBasis` permanently `'unknown'`.
 * Returning `undefined` is the honest answer and is never treated as zero.
 */
export type AxAgentPlaybookCostFn = (
  usage: readonly AxProgramUsage[]
) => number | undefined;

/**
 * Optional usage tap for the two structurally unobservable phases. The caller
 * wraps its own `AxAIService` and forwards each response's usage; Ax attributes
 * whatever arrives to the phase that is open when it arrives, AND ONLY when
 * that phase is structurally unobservable. Usage forwarded while an observable
 * phase is open is DROPPED: that phase already counted the same call off the
 * prediction, so accepting it would double the total. Without a tap,
 * `phases['mining'|'judge'].tokensBasis` is `'unobservable'` and their
 * `totalTokens` is `undefined` — reported, never guessed. With one that reports
 * nothing, the basis is `'unreported'`. Ax never wraps a caller-owned service
 * itself: ownership stays with the caller, and Ax always unsubscribes.
 */
export type AxAgentPlaybookUsageTap = Readonly<{
  subscribe: (
    onUsage: (usage: readonly AxProgramUsage[]) => void
  ) => () => void;
}>;

// ---------------------------------------------------------------------------
// 4.2 Intervals and the variance band
// ---------------------------------------------------------------------------

/** A paired, task-clustered bootstrap interval. Resampling unit is the task. */
export type AxAgentPlaybookInterval = Readonly<{
  /** Weighted mean paired delta (candidate - anchor). */
  point: number;
  lower: number;
  upper: number;
  /** Two-sided coverage. Default 0.95. */
  level: number;
  resamples: number;
  unit: 'task';
  /** Number of task clusters resampled (not episodes). */
  clusters: number;
  seed: number;
  /** 'unresolved' whenever the interval contains zero. Never rounded away. */
  direction: 'positive' | 'negative' | 'unresolved';
}>;

export type AxAgentPlaybookIntervalOptions = Readonly<{
  /** Bootstrap resamples. Default 10_000. A safe integer in [200, 100_000]. */
  resamples?: number;
  /** Two-sided coverage in (0, 1). Default 0.95. */
  level?: number;
  /** Deterministic seed. Defaults to a digest of the split's task-set digest. */
  seed?: number;
}>;

/** Re-runs of the UNCHANGED artifact, establishing the smallest real delta. */
export type AxAgentPlaybookVarianceBand = Readonly<{
  split: AxAgentPlaybookSplitName;
  /** Independent re-evaluations, including the anchor itself. >= 2. */
  repeats: number;
  means: readonly number[];
  /** max(means) - min(means). A delta at or below this is noise. */
  spread: number;
  /** Pooled paired interval over (repeat_i - repeat_0). */
  interval: AxAgentPlaybookInterval;
}>;

export type AxAgentPlaybookVarianceBandReport =
  | Readonly<{ status: 'not_run'; reason: string }>
  | Readonly<{
      status: 'completed';
      bands: readonly AxAgentPlaybookVarianceBand[];
      accounting: AxAgentPlaybookComputeAccounting;
    }>;

export type AxAgentPlaybookVarianceBandOptions = Readonly<{
  /**
   * Extra unchanged-artifact evaluations per split, beyond the anchor.
   * Default 1 (=> repeats 2).
   */
  extraRepeats?: number;
  /** Splits to band. Default: every configured split except retention slices. */
  splits?: readonly ('current' | 'heldOut')[];
}>;

// ---------------------------------------------------------------------------
// 4.3 Matched-budget control arm
// ---------------------------------------------------------------------------

/**
 * 'best_of_n'       N samples of the unevolved program, one selected.
 * 'self_refine'     one sample then R critique/revise rounds, unevolved.
 * 'harness_term'    the EVOLVED pipeline with a neutral, content-free artifact
 *                   of the same rendered size in the playbook slot. Separates
 *                   "this bullet helped" from "any text in that slot helped".
 */
export type AxAgentPlaybookControlArmKind =
  | 'best_of_n'
  | 'self_refine'
  | 'harness_term';

export type AxAgentPlaybookControlArmResult = Readonly<{
  kind: AxAgentPlaybookControlArmKind;
  /**
   * What the arm ACTUALLY ran: samples drawn per task (best_of_n), refinement
   * rounds re-invoked (self_refine), or 1 (harness_term). Never the planned
   * figure — an arm that drew one sample under a starved budget and reported
   * best-of-2 would overstate the control the evolved artifact was compared
   * against, biasing the comparison towards accepting the artifact.
   */
  n: number;
  /**
   * How best-of-N picked a sample. Only 'metric' is implemented: it selects
   * with the scoring metric and is therefore an ORACLE-STRONG upper bound on
   * test-time scaling, chosen because it makes halligan's own claim harder,
   * not easier. 'judge' is RESERVED and rejected at option validation with
   * `control_arm_failed` until it ships; the field exists so the receipt
   * records the strength of the control it was compared against.
   */
  selector: 'metric' | 'judge';
  /** Always present; the deciding split is always `heldOut`. */
  heldOut: AxAgentPlaybookSplitScore;
  /** Reported for completeness only. Never the comparison basis. */
  current?: AxAgentPlaybookSplitScore;
  accounting: AxAgentPlaybookComputeAccounting;
  /**
   * `harness_term` only: the digest of the content-free artifact that occupied
   * the playbook slot. Recorded so the ablation is reproducible — an arm whose
   * neutral text is unknown proves nothing about the artifact it replaced.
   */
  neutralArtifactDigest?: string;
  /**
   * `harness_term` only: what the neutral artifact actually rendered to. The
   * size match is what makes the ablation an ablation, so the number is on the
   * receipt rather than asserted in prose.
   */
  neutralArtifactTokens?: number;
}>;

/** REQUIRED on the result. `not_run` is the default so its absence is visible. */
export type AxAgentPlaybookControlArmReport =
  | Readonly<{ status: 'not_run'; reason: string }>
  | Readonly<{
      status: 'failed';
      reason: string;
      accounting: AxAgentPlaybookComputeAccounting;
    }>
  | Readonly<{
      status: 'partial' | 'completed';
      /** The evolution run's own consumption, replayed as the arm's ceiling. */
      matchedBudget: AxAgentPlaybookComputeAccounting;
      /**
       * How `matchedBudget` was derived. 'evolve_total' is the default and is
       * DELIBERATELY GENEROUS to the control arm: it includes baseline and
       * retention-anchor calls that produced no candidate, so the arm gets more
       * compute than the search actually spent proposing. Recorded structurally
       * because a matched-budget claim copied into a PR body must carry its own
       * basis.
       */
      budgetBasis: 'evolve_total' | 'caller_supplied';
      arms: readonly AxAgentPlaybookControlArmResult[];
      /** Best held-out mean across arms. `split` is always 'heldOut'. */
      best: Readonly<{
        kind: AxAgentPlaybookControlArmKind;
        split: 'heldOut';
        mean: number;
      }>;
      /** Evolved final held-out mean minus `best.mean`. */
      evolvedAdvantage: number;
      interval: AxAgentPlaybookInterval;
      /** Restated so the arm's contamination status travels with it. */
      heldOutSelectionComparisons: number;
      accounting: AxAgentPlaybookComputeAccounting;
    }>;

export type AxAgentPlaybookControlArmOptions = Readonly<{
  /** Arms to run. Default `['best_of_n', 'self_refine', 'harness_term']`. */
  arms?: readonly AxAgentPlaybookControlArmKind[];
  /** Samples per task for best-of-N. Derived from the matched budget if absent. */
  bestOfN?: number;
  /** Self-refinement rounds. Derived from the matched budget when absent. */
  refineRounds?: number;
  /**
   * Control-arm metric budget. Defaults to the evolution run's own
   * `metricCallsUsed` (`budgetBasis: 'evolve_total'`); supplying it sets
   * `budgetBasis: 'caller_supplied'`.
   */
  maxMetricCalls?: number;
  /** Default and only implemented value: 'metric'. */
  selector?: 'metric' | 'judge';
  /** Model that runs the refinement/selection turns. Defaults to `studentAI`. */
  ai?: Readonly<AxAIService>;
  /**
   * Neutral artifact text for the 'harness_term' arm. Defaults to a
   * deterministic filler padded to within +/-5% of the evolved playbook's
   * rendered token count. Recorded on the receipt by digest.
   */
  neutralArtifact?: string;
}>;

// ---------------------------------------------------------------------------
// 4.4 Reach
// ---------------------------------------------------------------------------

/**
 * How reach was measured. ONLY `host_probe` is evidence; the other two are
 * labels on a counterfactual and can never satisfy the reach gate.
 *
 *  - 'host_probe'
 *      A candidate bullet was observed by the host at the deciding step of the
 *      real episode. The only basis that answers the question.
 *
 *  - 'applicability_counterfactual'
 *      `isBulletApplicable(bullet, { conditions: conditionsForTask(task) })`
 *      was true. TWO reasons this is not evidence:
 *      (1) `isBulletApplicable` short-circuits to `true` whenever
 *          `evidence.applicability` is undefined, and evolve-curated bullets
 *          carry none, so this basis reads 1.0 unconditionally for exactly the
 *          bullets the reach gate exists to interrogate.
 *      (2) The playbook is rendered ONCE per apply; the evaluation path applies
 *          no per-task render conditions, so `conditionsForTask` asks what
 *          WOULD have been applicable under conditions that never rendered the
 *          prompt the run actually saw.
 *
 *  - 'rendered_only'
 *      A candidate bullet appeared in the rendered playbook. Not evidence of
 *      anything but length.
 */
export type AxAgentPlaybookReachBasis =
  | 'host_probe'
  | 'applicability_counterfactual'
  | 'rendered_only';

export type AxAgentPlaybookReachObservation = Readonly<{
  /** True only when a candidate bullet was applicable at the deciding step. */
  applicableAtDecidingStep: boolean;
  /**
   * Times a candidate bullet was invoked in this episode. Host-counted; Ax has
   * no bullet-firing counter of its own. Must be a non-negative safe integer;
   * anything else makes the split `unmeasured`.
   */
  invocations: number;
}>;

/**
 * Runs once per attempt, synchronously, inside the evaluation loop. It MUST be
 * pure and fast: it is invoked `expectedRuns` times, it is not given a signal,
 * and it is not awaited, so a slow probe multiplies the run's wall clock by the
 * attempt count. Ax bounds it defensively — a probe that throws marks the split
 * `unmeasured` and emits `reach_probe_failed` rather than failing the run, and
 * a probe whose cumulative self-timed cost exceeds `reachProbeBudgetMs` is
 * disabled for the remainder with the same warning.
 */
export type AxAgentPlaybookReachProbe<IN = any, OUT = any> = (
  args: Readonly<{
    /** Bullet ids the current proposal added or changed. */
    candidateBulletIds: readonly string[];
    /** Bullet ids present in the playbook rendered for this evaluation. */
    renderedBulletIds: readonly string[];
    task: Readonly<AxAgentEvalTask<IN>>;
    prediction?: Readonly<AxAgentEvalPrediction<OUT>>;
    split: AxAgentPlaybookSplitName;
    sliceName?: string;
  }>
) => AxAgentPlaybookReachObservation | undefined;

export type AxAgentPlaybookReachSplit = Readonly<{
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  basis: AxAgentPlaybookReachBasis;
  /** True for every basis except 'host_probe'. Carried on the receipt. */
  counterfactual: boolean;
  taskCount: number;
  /** Tasks where >= 1 candidate bullet was reached under `basis`. */
  reachedTasks: number;
  /** reachedTasks / taskCount. */
  reachRate: number;
  /** Mean candidate-bullet invocations. undefined unless basis is host_probe. */
  invocationsPerEpisode?: number;
}>;

export type AxAgentPlaybookReachReport = Readonly<{
  basis: AxAgentPlaybookReachBasis;
  /** Mirrors `splits[].counterfactual`; true unless basis is 'host_probe'. */
  counterfactual: boolean;
  /** True only when basis is 'host_probe'. The gate reads THIS, not reachRate. */
  gateEligible: boolean;
  splits: readonly AxAgentPlaybookReachSplit[];
}>;

// ---------------------------------------------------------------------------
// 4.5 Validity conjuncts
// ---------------------------------------------------------------------------

/**
 * NAMING NOTE. Ax has no schema-validation outcome on a prediction:
 * `AxAgentEvalPrediction` carries `actionLog`, `guidanceLog`, `functionCalls`,
 * `toolErrors`, `turnCount`, `usage`, `failureSignals`, `recursive*`,
 * `completionType` and `output`. Implemented from what exists, the first
 * predicate can only mean "rate of `completionType === 'final'`", so it is
 * NAMED that. It stays useful as a conjunct because the harness's `passed`
 * flag ANDs it with the score threshold and therefore hides it.
 */
export type AxAgentPlaybookValidityPredicateId =
  | 'final_completion_rate'
  | 'assertion_pass_rate'
  | 'unknown_function_call_rate'
  | 'tool_error_rate'
  | 'token_ceiling'
  | 'latency_ceiling';

export type AxAgentPlaybookValidityPredicate = Readonly<{
  id: AxAgentPlaybookValidityPredicateId;
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  /** 'unmeasured' when Ax cannot observe it without host help. Never guessed. */
  status: 'pass' | 'fail' | 'unmeasured';
  /** Observed rate/value. undefined when unmeasured. */
  observed?: number;
  threshold?: number;
  /** True when `classifyFunctionCall` changed the value Ax computed. */
  overriddenByHost?: boolean;
  /** Stable name used in `reason` and in the gate report. */
  name: string;
}>;

export type AxAgentPlaybookValidityReport = Readonly<{
  predicates: readonly AxAgentPlaybookValidityPredicate[];
  /** Predicates the gate treats as required. An unmeasured one fails closed. */
  required: readonly AxAgentPlaybookValidityPredicateId[];
  /** First failing predicate name, in declaration order. */
  failed?: string;
}>;

export type AxAgentPlaybookValidityOptions = Readonly<{
  /** Rate of `completionType === 'final'`. Default 0.9. */
  minFinalCompletionRate?: number;
  /** Default 1. Computed from the attempt records' error identity. */
  minAssertionPassRate?: number;
  /** Default 0. Computed IN AX; see `classifyFunctionCall`. */
  maxUnknownFunctionCallRate?: number;
  /** Off unless set. Computed in Ax from call errors + `prediction.toolErrors`. */
  maxToolErrorRate?: number;
  /** Mean `AxTokenUsage.totalTokens` per attempt. Off unless set. */
  maxMeanTotalTokens?: number;
  /** Mean attempt wall-clock. Off unless set. */
  maxMeanLatencyMs?: number;
  /** Which predicates the gate requires. Defaults to every measurable one. */
  required?: readonly AxAgentPlaybookValidityPredicateId[];
  /**
   * OVERRIDE, not the only source. Ax computes `unknown_function_call_rate`
   * itself by comparing each `AxAgentEvalFunctionCall.qualifiedName` against
   * the agent's registered function set, and `tool_error_rate` from
   * `call.error` plus `prediction.toolErrors`. Making these host-owned would be
   * both a capability downgrade and a laundering surface — a classifier that
   * returns 'ok' for everything passes the gate. When supplied, the
   * classifier's verdict wins per call AND the receipt records
   * `overriddenByHost: true`, so the substitution is visible.
   */
  classifyFunctionCall?: (
    call: Readonly<AxAgentEvalFunctionCall>
  ) => 'ok' | 'unknown_function' | 'tool_error';
}>;

// ---------------------------------------------------------------------------
// 4.6 Transfer
// ---------------------------------------------------------------------------

export type AxAgentPlaybookTransferTarget = Readonly<{
  /** Stable caller-owned cell label. Ax never derives it from the service. */
  id: string;
  ai: Readonly<AxAIService>;
  /** Caller-managed evaluator identity when the judge differs per target. */
  evaluatorId?: string;
}>;

export type AxAgentPlaybookTransferCell = Readonly<{
  targetId: string;
  split: 'current' | 'heldOut';
  anchor: AxAgentPlaybookSplitScore;
  candidate: AxAgentPlaybookSplitScore;
  /** candidate.mean - anchor.mean. */
  delta: number;
  interval: AxAgentPlaybookInterval;
  /** delta < -floor. */
  regressed: boolean;
  model?: AxAgentPlaybookModelIdentity;
}>;

/**
 * The full cell matrix. There is deliberately NO mean/average field: the
 * headline finding this type exists to preserve is that averages hide
 * large negative cells. A type test asserts its absence.
 */
export type AxAgentPlaybookTransferReport =
  | Readonly<{ status: 'not_run'; reason: string }>
  | Readonly<{
      status: 'partial' | 'completed';
      floor: number;
      cells: readonly AxAgentPlaybookTransferCell[];
      /** `${targetId}:${split}` for every regressed cell. */
      regressedCells: readonly string[];
      accounting: AxAgentPlaybookComputeAccounting;
    }>;

export type AxAgentPlaybookTransferOptions = Readonly<{
  targets: readonly AxAgentPlaybookTransferTarget[];
  /** Splits evaluated per target. Default `['heldOut']`. */
  splits?: readonly ('current' | 'heldOut')[];
  /** Per-cell regression floor. Default 0.02. */
  regressionFloor?: number;
  /** Cell metric budget. Ax fails closed before mutation when insufficient. */
  maxMetricCalls?: number;
}>;

// ---------------------------------------------------------------------------
// 4.7 Termination classification and attempt records
// ---------------------------------------------------------------------------

export type AxAgentTrajectoryTerminationKind =
  | 'completed'
  | 'policy_failure'
  | 'environment_failure';

export type AxAgentEnvironmentFailureCause =
  | 'provider_rate_limit'
  | 'provider_unavailable'
  | 'network'
  | 'timeout'
  | 'sandbox_unavailable'
  | 'tool_unavailable'
  | 'host_declared';

export type AxAgentTrajectoryTermination =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'policy_failure'; reason?: string }>
  | Readonly<{
      kind: 'environment_failure';
      cause: AxAgentEnvironmentFailureCause;
      reason?: string;
    }>;

/**
 * Host-owned and conservative. Returning `undefined` means 'policy_failure' — a
 * program that reliably drives a tool into a timeout IS worse, and must not be
 * laundered out of the denominator. Ax never infers `environment_failure` on
 * its own.
 *
 * Runs once per attempt, synchronously, inside the evaluation loop, with no
 * signal, so it MUST be pure and fast. Unlike the reach probe it is NOT bounded
 * by a soft budget: it decides the score denominator, so silently disabling it
 * would change results. A classifier that throws raises
 * `AxAgentPlaybookEvolveError('classifier_invalid', …)` — a classifier that
 * cannot classify returns `undefined`.
 */
export type AxAgentTrajectoryClassifier<IN = any, OUT = any> = (
  args: Readonly<{
    task: Readonly<AxAgentEvalTask<IN>>;
    prediction?: Readonly<AxAgentEvalPrediction<OUT>>;
    error?: unknown;
    /** Structural error identity, pre-extracted. */
    errorName?: string;
    errorCauseName?: string;
    errorCode?: string;
    attempt: number;
    /** Which re-draw this is; 0 for the first try. */
    redraw: number;
    split: AxAgentPlaybookSplitName;
    sliceName?: string;
  }>
) => AxAgentTrajectoryTermination | undefined;

/** One attempt. Evidence is one attempt, one vote — counts never weight it. */
export type AxAgentPlaybookAttemptRecord = Readonly<{
  attempt: number;
  /** 0 for the first try; >0 for a re-draw of a discarded attempt. */
  redraw: number;
  /** undefined when the attempt was discarded as an environment failure. */
  score?: number;
  termination: AxAgentTrajectoryTermination;
  /**
   * Structural error identity, captured because the harness otherwise reduces
   * every error to `err.message` and the run record's `error` is a bare
   * `string | undefined`. Without these, nothing downstream can compute
   * `assertion_pass_rate`.
   *
   * `errorName` is `error.name`; `errorCauseName` walks `error.cause` up to 3
   * levels deep and takes the first `.name` found; `errorCode` is `error.code`
   * when it is a string. Every value is truncated to 200 chars. Structural
   * reads only — never `instanceof`, per the cross-realm rule.
   */
  errorName?: string;
  errorCauseName?: string;
  errorCode?: string;
  /** Function calls made. Reported so 'won' is distinguishable from 'won cheaply'. */
  callCount: number;
  turnCount: number;
  /** Sum of `AxTokenUsage.totalTokens`. undefined when nothing reported usage. */
  totalTokens?: number;
  latencyMs: number;
  model?: AxAgentPlaybookModelIdentity;
}>;

export type AxAgentPlaybookTerminationSplit = Readonly<{
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  completed: number;
  policyFailures: number;
  environmentFailures: number;
  /**
   * `environmentFailures / expectedRuns` — a rate PER EXPECTED RUN, not per
   * drawn attempt. With `maxDiscardRedraws > 0` more attempts are drawn than
   * expected, so a split where every draw and re-draw was discarded reads
   * above 1.0. That is the intended reading: the denominator is the evidence
   * the split was supposed to produce, not the work it cost.
   */
  discardRate: number;
  /** Attempts re-drawn after a discard. Each consumed budget. */
  redraws: number;
  /** Tasks that ended with zero scored attempts after re-draws were exhausted. */
  tasksWithNoScoredAttempt: number;
  causes: readonly Readonly<{
    cause: AxAgentEnvironmentFailureCause;
    count: number;
  }>[];
}>;

export type AxAgentPlaybookTerminationReport = Readonly<{
  splits: readonly AxAgentPlaybookTerminationSplit[];
  /** Highest per-split discard rate in this evaluation. */
  worstDiscardRate: number;
  /** True when any split had a task with no scored attempt. */
  incompleteFromEnvironmentFailures: boolean;
}>;

// ---------------------------------------------------------------------------
// 4.7b Anchor-vs-candidate overhead
// ---------------------------------------------------------------------------

export type AxAgentPlaybookOverheadMeasure = Readonly<{
  anchorMean: number;
  candidateMean: number;
  /** candidateMean - anchorMean. */
  delta: number;
  /** delta / anchorMean. undefined when anchorMean is 0. */
  relativeDelta?: number;
  /** Same paired task-clustered machinery as every other interval. */
  interval: AxAgentPlaybookInterval;
}>;

export type AxAgentPlaybookOverheadSplit = Readonly<{
  split: 'current' | 'heldOut';
  turns: AxAgentPlaybookOverheadMeasure;
  calls: AxAgentPlaybookOverheadMeasure;
  /** undefined when no usage was reported on either side. Never estimated. */
  tokens?: AxAgentPlaybookOverheadMeasure;
}>;

export type AxAgentPlaybookOverheadReport = Readonly<{
  splits: readonly AxAgentPlaybookOverheadSplit[];
  /** Largest positive `relativeDelta` across every measure and split. */
  worstRelativeDelta?: number;
}>;

// ---------------------------------------------------------------------------
// 4.8 Pruning
// ---------------------------------------------------------------------------

export type AxAgentPlaybookPruneOperation = 'remove' | 'deprecate';

export type AxAgentPlaybookPruneTrigger =
  | 'rendered_size_budget'
  | 'redundancy_sweep'
  | 'caller_requested';

export type AxAgentPlaybookPruneProposal = Readonly<{
  pruneId: string;
  operation: AxAgentPlaybookPruneOperation;
  bulletIds: readonly string[];
  trigger: AxAgentPlaybookPruneTrigger;
  reason: string;
  /** Rendered-token estimate before and after. */
  renderedTokensBefore: number;
  renderedTokensAfter: number;
  /**
   * The thresholds this prune was ACTUALLY judged by (the prune gate variant),
   * so the outcome's retention receipt — whose `thresholds.minCurrentGain`
   * describes the retention POLICY — cannot be misread as the applied rule.
   */
  appliedThresholds: Readonly<{
    maxCurrentLoss: number;
    maxHeldOutLoss: number;
    minTokenReduction: number;
  }>;
}>;

export type AxAgentPlaybookRedundancyEntry = Readonly<{
  bulletId: string;
  section: string;
  /** Held-out mean WITHOUT this bullet, minus the full-playbook held-out mean. */
  heldOutDelta: number;
  interval: AxAgentPlaybookInterval;
  /**
   * 'redundant'    interval contains zero and |delta| <= the held-out band
   * 'load_bearing' interval excludes zero and delta < 0 (removal hurts)
   * 'harmful'      interval excludes zero and delta > 0 (removal helps)
   * 'unresolved'   interval contains zero but |delta| > band
   */
  verdict: 'load_bearing' | 'redundant' | 'harmful' | 'unresolved';
  renderedTokens: number;
}>;

export type AxAgentPlaybookRedundancyReport =
  | Readonly<{ status: 'not_run'; reason: string }>
  | Readonly<{
      status: 'partial' | 'completed';
      entries: readonly AxAgentPlaybookRedundancyEntry[];
      accounting: AxAgentPlaybookComputeAccounting;
    }>;

export type AxAgentPlaybookPruneOptions = Readonly<{
  /** Emit prune proposals after the curate loop. Default false. */
  enabled?: boolean;
  operation?: AxAgentPlaybookPruneOperation;
  /** Rendered-token ceiling. Overflow triggers proposals, never truncation. */
  maxRenderedTokens?: number;
  /** 'propose' emits gated prune proposals; 'warn' records a warning. */
  onOverflow?: 'propose' | 'warn';
  /** Leave-one-out ablations. Default 8. Each costs one held-out evaluation. */
  maxAblations?: number;
  /** Maximum tolerated current-task loss for a prune. Default 0. */
  maxCurrentLoss?: number;
  /** Maximum tolerated held-out loss for a prune. Default `epsilon`. */
  maxHeldOutLoss?: number;
  /** Minimum rendered-token reduction worth proposing. Default 1. */
  minTokenReduction?: number;
}>;

/**
 * A bullet the ACE curator evicted on the ordinary CURATE path, recovered from
 * the artifact-history delta. Section-overflow eviction removes the
 * lowest-ranked unprotected bullet with no receipt and no gate, so an accepted
 * curate proposal can silently delete an existing bullet today.
 */
export type AxAgentPlaybookEviction = Readonly<{
  bulletId: string;
  section: string;
  /** The proposal whose application caused the eviction. */
  weaknessId: string;
  /** 'section_overflow' is the only cause Ax can currently attribute. */
  cause: 'section_overflow';
}>;

// ---------------------------------------------------------------------------
// 4.9 Promotion authority
// ---------------------------------------------------------------------------

export type AxAgentPlaybookNomination = Readonly<{
  /** Digest of the candidate's rendered playbook delta + proposal. */
  candidateDigest: string;
  /** Caller-managed evaluator identity. Ax never validates it. */
  evaluatorId?: string;
  /**
   * Model identity of the judge that produced the scores, read from the
   * observed usage. Present so an evaluator swap between anchor and candidate
   * is detectable: `evaluatorId` is caller-managed and unvalidated, so a caller
   * who changes judge models mid-run would otherwise still produce a
   * self-consistent digest. `undefined` when no usage was observed.
   */
  judgeModel?: AxAgentPlaybookModelIdentity;
  splitDigests: Readonly<{
    current: string;
    heldOut?: string;
    slices: readonly Readonly<{
      name: string;
      version: string;
      digest: string;
    }>[];
  }>;
  /** How `splitDigests` were computed. */
  splitDigestBasis: 'task_ids' | 'frozen_corpus';
  /**
   * canonicalDigest({candidateDigest, evaluatorId, judgeModel, splitDigests}).
   * RECEIPT METADATA and a post-hoc integrity value. NOT the authorization
   * binding: grants are matched by exact resource identity before the host
   * authorizer runs, so a mid-run digest is a value no host could pre-grant.
   */
  promotionDigest: string;
  /** The stable identity `resource.id` was bound to. Host-grantable. */
  resourceId: string;
  gatesPassed: readonly AxAgentPlaybookGateId[];
  gatesFailed: readonly AxAgentPlaybookGateId[];
  /** The judge/metric gate produces this. It is a NOMINATION, never a promotion. */
  nominated: boolean;
}>;

export type AxAgentPlaybookVetoResult = Readonly<{
  vetoId: string;
  vetoed: boolean;
  reason?: string;
}>;

/**
 * Conjunctive and reject-only: a veto can block a promotion and can never cause
 * one.
 *
 * FAIL-CLOSED IN EVERY DIRECTION. A veto is recorded as VETOED when it: returns
 * `true`; returns `{ vetoed: true }`; throws; times out; or returns ANYTHING
 * THAT IS NOT a `boolean` and NOT an object with a `boolean` `vetoed` —
 * `undefined` (a host that forgot a `return`) included. Only an explicit
 * `false` / `{ vetoed: false }` declines to veto.
 */
export type AxAgentPlaybookPromotionVeto = (
  nomination: Readonly<AxAgentPlaybookNomination>,
  signal?: AbortSignal
) =>
  | boolean
  | AxAgentPlaybookVetoResult
  | Promise<boolean | AxAgentPlaybookVetoResult>;

export type AxAgentPlaybookPromotionAuthority = Readonly<{
  authority: Readonly<AxAuthorityContext>;
  /**
   * REQUIRED. The stable resource id bound into `AxResourceScope.id`. Must be
   * something the host has already granted — grants are matched by exact
   * equality BEFORE the host callback runs. Ax rejects a blank value at option
   * validation with `promotion_authority_invalid` rather than inventing one.
   */
  resourceId: string;
  /** Default 'ax.agent.playbook.promote'. */
  operation?: string;
  /** Default 'ax.agent.playbook.candidate'. */
  resourceType?: string;
  tenantId?: string;
}>;

/** Mirrors all FIVE members of `AxAuthorizationDeniedError.code`. */
export type AxAgentPlaybookPromotionDenialCode =
  | 'host_denied'
  | 'no_matching_grant'
  | 'invalid_receipt'
  | 'cancelled'
  | 'timeout';

export type AxAgentPlaybookPromotionRecord =
  | Readonly<{ status: 'not_required'; nomination: AxAgentPlaybookNomination }>
  | Readonly<{ status: 'not_nominated'; nomination: AxAgentPlaybookNomination }>
  | Readonly<{
      status: 'vetoed';
      nomination: AxAgentPlaybookNomination;
      vetoes: readonly AxAgentPlaybookVetoResult[];
    }>
  | Readonly<{
      status: 'denied';
      nomination: AxAgentPlaybookNomination;
      code: AxAgentPlaybookPromotionDenialCode;
      reason: string;
    }>
  | Readonly<{
      status: 'promoted';
      nomination: AxAgentPlaybookNomination;
      /** Bound to `nomination.resourceId`. Verified again on return. */
      receipt: Readonly<AxAuthorizationReceipt>;
      vetoes: readonly AxAgentPlaybookVetoResult[];
    }>
  /**
   * The candidate WAS promoted with a valid receipt, and a later RUN-LEVEL gate
   * rolled the whole accepted set back. The receipt is kept — it really was
   * issued — but the status makes a live promotion structurally distinguishable
   * from a rescinded one.
   */
  | Readonly<{
      status: 'promoted_then_rolled_back';
      nomination: AxAgentPlaybookNomination;
      receipt: Readonly<AxAuthorizationReceipt>;
      vetoes: readonly AxAgentPlaybookVetoResult[];
      /** The run-level gate that caused it, e.g. 'control_arm'. */
      rolledBackByGate: AxAgentPlaybookGateId;
      rolledBackReason: string;
    }>;

// ---------------------------------------------------------------------------
// 4.10 Gates, warnings, the evidence receipt
// ---------------------------------------------------------------------------

export type AxAgentPlaybookGateId =
  | 'gain'
  | 'held_out'
  | 'retention'
  | 'validity'
  | 'interval'
  | 'reach'
  | 'prune_size'
  | 'veto'
  | 'authority'
  | 'transfer'
  | 'control_arm';

export type AxAgentPlaybookGateMode = 'off' | 'warn' | 'require';

export type AxAgentPlaybookGateEntry = Readonly<{
  id: AxAgentPlaybookGateId;
  mode: AxAgentPlaybookGateMode;
  status: 'pass' | 'fail' | 'warn' | 'skipped' | 'unmeasured';
  /** Stable-prefixed detail, e.g. 'validity:tool_error_rate@heldOut 0.31 > 0.10'. */
  detail: string;
}>;

export type AxAgentPlaybookGateReport = Readonly<{
  entries: readonly AxAgentPlaybookGateEntry[];
  /** First failing required gate, in decision order. */
  failedGate?: AxAgentPlaybookGateId;
  /** The named failing predicate, carried verbatim into `outcome.reason`. */
  failedPredicate?: string;
}>;

export type AxAgentPlaybookEvidenceWarningCode =
  | 'reach_zero_positive_delta'
  | 'reach_unmeasured'
  /** Basis is 'applicability_counterfactual' or 'rendered_only'. */
  | 'reach_counterfactual_basis'
  | 'reach_probe_failed'
  | 'interval_unresolved'
  | 'delta_within_variance_band'
  | 'control_arm_not_run'
  /**
   * A matched-budget arm reproduced (or beat) the evolved run's held-out score
   * while `gates.controlArm` was only `'warn'`. Without it a warn-mode gate
   * would produce no observable output at all, which is the silent absence this
   * machinery exists to remove.
   */
  | 'control_arm_not_beaten'
  /**
   * A run-level control-arm gate had nothing to read: the arm did not run,
   * failed, measured no task on the deciding split, or produced no record
   * that could be paired. Kept distinct from `control_arm_not_beaten`, which asserts that a
   * comparison happened and the evolved artifact lost it.
   */
  | 'control_arm_unmeasured'
  | 'harness_term_not_run'
  | 'transfer_not_run'
  | 'cost_unknown'
  | 'tokens_unobservable'
  | 'high_environment_discard_rate'
  /** A task ended with no scored attempt after re-draws were exhausted. */
  | 'evaluation_incomplete_environment'
  | 'rendered_size_over_budget'
  /** A curate proposal evicted an existing bullet via section overflow. */
  | 'curate_eviction'
  | 'overhead_exceeds_gain'
  | 'promotion_without_receipt'
  /** A promoted candidate was rescinded by a run-level gate. */
  | 'promotion_rolled_back'
  /** heldOut re-anchored k times; names k and the family-wise error rate. */
  | 'held_out_reused_for_selection'
  | 'sealed_test_not_run';

export type AxAgentPlaybookEvidenceWarning = Readonly<{
  code: AxAgentPlaybookEvidenceWarningCode;
  message: string;
  /** `${split}` or `${targetId}:${split}` when the warning is scoped. */
  scope?: string;
}>;

/** One per fully evaluated candidate. Frozen at runtime. */
export type AxAgentPlaybookEvidenceReceipt = Readonly<{
  schema: 'ax-agent-playbook-evidence-v1';
  /** canonicalDigest of every field below except `digest`. */
  digest: string;
  kind: 'curate' | 'prune';
  nomination: AxAgentPlaybookNomination;
  intervals: Readonly<{
    current: AxAgentPlaybookInterval;
    heldOut?: AxAgentPlaybookInterval;
    slices: readonly Readonly<{
      name: string;
      version: string;
      interval: AxAgentPlaybookInterval;
    }>[];
  }>;
  reach: AxAgentPlaybookReachReport;
  validity: AxAgentPlaybookValidityReport;
  termination: AxAgentPlaybookTerminationReport;
  overhead?: AxAgentPlaybookOverheadReport;
  gates: AxAgentPlaybookGateReport;
  promotion: AxAgentPlaybookPromotionRecord;
  accounting: AxAgentPlaybookComputeAccounting;
  /** Contamination disclosure for the split every held-out reading was taken on. */
  heldOutContamination: Readonly<{
    /** Times `heldOut` was re-anchored to an accepted candidate before this. */
    selectionComparisons: number;
    /** 1 - level^k. Reported, never corrected for. */
    impliedFamilyWiseErrorRate: number;
    sealed: false;
  }>;
  warnings: readonly AxAgentPlaybookEvidenceWarning[];
  /**
   * 'accepted'   the candidate passed the per-candidate chain and is live.
   * 'rejected'   the candidate failed the per-candidate chain.
   * 'superseded' the candidate passed and was then rolled back by a run-level
   *              gate. Kept distinct so a rolled-back candidate never reads as
   *              'accepted'.
   */
  decision: 'accepted' | 'rejected' | 'superseded';
}>;

/**
 * A split evaluated EXACTLY ONCE, at the very end, on the final artifact and
 * the baseline artifact, and never consulted by a gate, a threshold, an accept
 * decision or a rollback. It exists because `heldOut` is not a sealed test: it
 * is re-anchored to the accepted candidate after every accept, so with
 * `maxProposals` it has selected the artifact up to that many times.
 */
export type AxAgentPlaybookSealedTestReport =
  | Readonly<{ status: 'not_run'; reason: string }>
  | Readonly<{
      status: 'completed';
      baseline: AxAgentPlaybookSplitScore;
      final: AxAgentPlaybookSplitScore;
      delta: number;
      interval: AxAgentPlaybookInterval;
      /** Always true. A type test asserts there is no way to make it false. */
      influencedNoDecision: true;
      accounting: AxAgentPlaybookComputeAccounting;
    }>;

export type AxAgentPlaybookEvidenceGates = Readonly<{
  /**
   * Candidate run must beat the best control arm on HELD-OUT. Default 'off'.
   * Anything but 'off' requires a non-empty validation set.
   */
  controlArm?: AxAgentPlaybookGateMode;
  /** Margin the evolved run must clear. Default 0. */
  controlArmMargin?: number;
  /**
   * Interval must exclude zero AND the point delta must exceed the variance
   * band. Default 'off'. `'require'` without a configured `varianceBand` is
   * rejected at option validation — a required gate must not silently degrade
   * to the weaker "excludes zero" check.
   */
  interval?: AxAgentPlaybookGateMode;
  /** Every required validity predicate must pass on BOTH splits. Default 'off'. */
  validity?: AxAgentPlaybookGateMode;
  /** No evaluated cell may regress beyond the floor. Default 'off'. */
  transfer?: AxAgentPlaybookGateMode;
  /**
   * Reach must be non-zero under `basis === 'host_probe'`. Default 'off'. The
   * two free bases are counterfactual and yield `status: 'unmeasured'`, which
   * fails closed under 'require'. There is no configuration in which a
   * rendered-or-applicable count satisfies this gate.
   */
  reach?: AxAgentPlaybookGateMode;
}>;

// ---------------------------------------------------------------------------
// 4.11 Errors
// ---------------------------------------------------------------------------

export type AxAgentPlaybookEvolveErrorCode =
  | 'evidence_incomplete'
  | 'budget_insufficient'
  | 'control_arm_failed'
  | 'promotion_authority_invalid'
  | 'veto_failed'
  | 'prune_apply_failed'
  | 'transfer_target_invalid'
  | 'classifier_invalid'
  | 'interval_options_invalid'
  /** An evidence option was combined with `verify: false`. */
  | 'evidence_requires_verify'
  | 'sealed_test_invalid';

const AX_AGENT_PLAYBOOK_EVOLVE_ERROR_CODES = [
  'evidence_incomplete',
  'budget_insufficient',
  'control_arm_failed',
  'promotion_authority_invalid',
  'veto_failed',
  'prune_apply_failed',
  'transfer_target_invalid',
  'classifier_invalid',
  'interval_options_invalid',
  'evidence_requires_verify',
  'sealed_test_invalid',
] as const;

/**
 * Thrown only by the NEW evidence paths. Every pre-existing throw site keeps
 * its exact plain-`Error` message and type so existing tests and callers are
 * unaffected.
 *
 * MESSAGE PREFIX IS MANDATORY. `super()` is called with
 * `` `AxAgent.playbook().evolve(): ${message}` ``, matching every other throw
 * in this subsystem, so log-grep and the existing tests stay coherent. Callers
 * pass the unprefixed message.
 */
export class AxAgentPlaybookEvolveError extends Error {
  public override readonly name = 'AxAgentPlaybookEvolveError' as const;
  public readonly code: AxAgentPlaybookEvolveErrorCode;
  /** Where it failed, for the receipt. */
  public readonly phase: AxAgentPlaybookComputePhaseName;
  /**
   * The artifact the caller can recover to with one `getPlaybook()?.load(...)`.
   *
   * Set on exactly ONE path: the control arm restored the unevolved playbook,
   * ran, and then could not put the evolved one back after two attempts. That
   * leaves the agent in the baseline state while the run describes the evolved
   * one, so the snapshot rides on the error — a thrown run has no result to
   * carry it.
   */
  public readonly playbookSnapshot?: AxPlaybookSnapshot;

  constructor(
    code: AxAgentPlaybookEvolveErrorCode,
    phase: AxAgentPlaybookComputePhaseName,
    message: string,
    options?: { cause?: unknown; playbookSnapshot?: AxPlaybookSnapshot }
  ) {
    super(
      `AxAgent.playbook().evolve(): ${message}`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.code = code;
    this.phase = phase;
    if (options?.playbookSnapshot !== undefined) {
      this.playbookSnapshot = options.playbookSnapshot;
    }
  }
}

/**
 * Cross-realm structural guard: check the discriminant AND the closed code
 * union. Never `instanceof`; never a bare `'code' in error`.
 */
export function axIsAgentPlaybookEvolveError(
  error: unknown
): error is AxAgentPlaybookEvolveError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxAgentPlaybookEvolveError' &&
    typeof candidate.code === 'string' &&
    (AX_AGENT_PLAYBOOK_EVOLVE_ERROR_CODES as readonly string[]).includes(
      candidate.code
    )
  );
}
