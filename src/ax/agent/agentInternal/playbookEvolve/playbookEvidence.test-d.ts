/**
 * Compile-time contracts for the playbook evidence surface, enforced by
 * `npm run test:type-tests`. Several of these are the only place a rule is
 * enforceable at all: "there is no transfer average" and "the sealed test can
 * never have influenced a decision" are type-level properties, not runtime
 * ones.
 */

import type { AxAgentEvalTask } from '../agentOptimizeTypes.js';
import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookEvidenceReceipt,
  AxAgentPlaybookGateId,
  AxAgentPlaybookInterval,
  AxAgentPlaybookPromotionDenialCode,
  AxAgentPlaybookPromotionRecord,
  AxAgentPlaybookPromotionVeto,
  AxAgentPlaybookPruneProposal,
  AxAgentPlaybookReachReport,
  AxAgentPlaybookSealedTestReport,
  AxAgentPlaybookTransferReport,
  AxAgentPlaybookTransferTarget,
  AxAgentPlaybookValidityPredicateId,
  AxAgentPlaybookVetoResult,
  AxAgentTrajectoryClassifier,
  AxAgentTrajectoryTermination,
} from './playbookEvidenceTypes.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveResult,
} from './playbookEvolveTypes.js';

// The transfer report must never grow an average: an average is exactly what
// hides a single catastrophic cell.
declare const transfer: AxAgentPlaybookTransferReport;
if (transfer.status === 'completed') {
  // @ts-expect-error - reporting a transfer average is banned.
  void transfer.meanDelta;
  // @ts-expect-error - reporting a transfer average is banned.
  void transfer.averageDelta;
  const cells: readonly { targetId: string; delta: number }[] = transfer.cells;
  void cells;
}

// The control arm report is REQUIRED on the result and defaults to a visible
// not_run, so its absence can never be silent.
declare const result: AxAgentPlaybookEvolveResult;
const control: AxAgentPlaybookControlArmReport = result.control;
if (control.status === 'not_run') void control.reason;

// `applied` is a three-state discriminant, not a boolean: 'dry_run' (the
// snapshot is a safe draft) and 'rolled_back' (the snapshot is poison) must
// not collapse into `false`.
const applied: 'live' | 'dry_run' | 'rolled_back' = result.applied;
// @ts-expect-error - `applied` is not assignable to a boolean.
const appliedAsBoolean: boolean = result.applied;
void applied;
void appliedAsBoolean;

// `accounting` is required too.
void result.accounting.metricCalls;
void result.accounting.evolveOnlyMetricCalls;

// The sealed test can never have influenced a decision, at the type level.
declare const sealed: AxAgentPlaybookSealedTestReport;
if (sealed.status === 'completed') {
  const influenced: true = sealed.influencedNoDecision;
  // @ts-expect-error - there is no inhabitant where it influenced a decision.
  const influencedFalse: false = sealed.influencedNoDecision;
  void influenced;
  void influencedFalse;
}

// Transfer targets and the sealed split are caller-owned and READONLY: Ax never
// derives a cell label from the service, and never mutates either collection.
declare const evolveOptions: AxAgentPlaybookEvolveOptions;
declare const transferTargets: readonly AxAgentPlaybookTransferTarget[];
declare const sealedTasks: readonly AxAgentEvalTask[];
const withTransfer: AxAgentPlaybookEvolveOptions = {
  ...evolveOptions,
  transfer: { targets: transferTargets, splits: ['heldOut'] },
  sealedTest: sealedTasks,
};
void withTransfer;
if (withTransfer.transfer) {
  // @ts-expect-error - the target list is readonly; Ax never appends to it.
  withTransfer.transfer.targets.push(transferTargets[0]!);
}

// Reach exposes gate eligibility structurally, so a caller cannot mistake a
// counterfactual basis for evidence.
declare const reach: AxAgentPlaybookReachReport;
const eligible: boolean = reach.gateEligible;
const counterfactual: boolean = reach.counterfactual;
void eligible;
void counterfactual;

// A promotion record is a closed union discriminated on `status`.
declare const promotion: AxAgentPlaybookPromotionRecord;
switch (promotion.status) {
  case 'promoted':
    void promotion.receipt;
    break;
  case 'promoted_then_rolled_back':
    void promotion.rolledBackByGate;
    break;
  case 'denied':
    void promotion.code;
    break;
  case 'vetoed':
    void promotion.vetoes;
    break;
  case 'not_nominated':
  case 'not_required':
    void promotion.nomination;
    break;
}

// The denial-code union mirrors EVERY member of the authority error's code,
// including `guard_predicate_failed` — an evidence guard on the matching grant
// refused before the host authorizer was ever called, which is not a host
// decision and must not be reported as one.
const denialCodes: readonly AxAgentPlaybookPromotionDenialCode[] = [
  'host_denied',
  'no_matching_grant',
  'invalid_receipt',
  'cancelled',
  'timeout',
  'guard_predicate_failed',
];
void denialCodes;

// Termination is a closed union; only environment_failure carries a cause.
declare const termination: AxAgentTrajectoryTermination;
if (termination.kind === 'environment_failure') void termination.cause;
if (termination.kind === 'policy_failure') {
  // @ts-expect-error - only an environment failure names a cause.
  void termination.cause;
}

// A classifier returning undefined is legal — that is how a host says "I
// cannot classify this", which Ax reads as a policy failure.
const classifier: AxAgentTrajectoryClassifier = () => undefined;
void classifier;

// An interval always names its resampling unit and its seed, so it is
// reproducible from the receipt.
declare const interval: AxAgentPlaybookInterval;
const unit: 'task' = interval.unit;
const seed: number = interval.seed;
void unit;
void seed;

// An attempt's score is optional: a discarded attempt has none, and a zero
// would be a score it never earned.
declare const attempt: AxAgentPlaybookAttemptRecord;
const score: number | undefined = attempt.score;
void score;

// The receipt's decision distinguishes a rolled-back candidate from an
// accepted one.
declare const receipt: AxAgentPlaybookEvidenceReceipt;
const decision: 'accepted' | 'rejected' | 'superseded' = receipt.decision;
const sealedFlag: false = receipt.heldOutContamination.sealed;
void decision;
void sealedFlag;

const gateIds: readonly AxAgentPlaybookGateId[] = [
  'gain',
  'held_out',
  'retention',
  'validity',
  'interval',
  'reach',
  'prune_size',
  'veto',
  'authority',
  'transfer',
  'control_arm',
];
void gateIds;

const predicateIds: readonly AxAgentPlaybookValidityPredicateId[] = [
  'final_completion_rate',
  'assertion_pass_rate',
  'unknown_function_call_rate',
  'tool_error_rate',
  'token_ceiling',
  'latency_ceiling',
];
// The predicate formerly proposed as `output_schema_compliance` does not
// exist: Ax has no schema-validation outcome on a prediction to measure.
// @ts-expect-error - there is no output_schema_compliance predicate.
const missingPredicate: AxAgentPlaybookValidityPredicateId =
  'output_schema_compliance';
void predicateIds;
void missingPredicate;

// The control-arm report is a closed union: a `not_run` or `failed` arm has no
// comparison to read, so a consumer cannot reach `evolvedAdvantage` without
// first proving the arm actually ran. That is the type-level half of the
// gate's fail-closed rule.
declare const armReport: AxAgentPlaybookControlArmReport;
switch (armReport.status) {
  case 'not_run':
    // @ts-expect-error - there is no advantage to read when no arm ran.
    void armReport.evolvedAdvantage;
    void armReport.reason;
    break;
  case 'failed':
    // @ts-expect-error - a failed arm carries a reason, never a comparison.
    void armReport.best;
    void armReport.accounting;
    break;
  default: {
    const advantage: number = armReport.evolvedAdvantage;
    // The deciding split is always held-out, at the type level: there is no
    // configuration in which a control comparison falls back to `current`.
    const decidingSplit: 'heldOut' = armReport.best.split;
    const basis: 'evolve_total' | 'caller_supplied' = armReport.budgetBasis;
    void advantage;
    void decidingSplit;
    void basis;
  }
}

// A rescinded promotion is structurally distinguishable from a live one, which
// is the whole point of moving authority off the judge.
declare const rescinded: AxAgentPlaybookPromotionRecord;
if (rescinded.status === 'promoted_then_rolled_back') {
  const gate: AxAgentPlaybookGateId = rescinded.rolledBackByGate;
  void gate;
  void rescinded.receipt;
  void rescinded.rolledBackReason;
}

// A promotion is unreachable without a receipt, at the type level. Every other
// member of the union is an explicit refusal, so there is no inhabitant of
// `AxAgentPlaybookPromotionRecord` that says "promoted" with nothing to show
// for it — which is what "the judge nominates, the host promotes" means when
// a consumer reads it back off a stored outcome.
declare const promotionUnion: AxAgentPlaybookPromotionRecord;
switch (promotionUnion.status) {
  case 'not_required':
  case 'not_nominated':
    // @ts-expect-error - nothing was granted, so there is no receipt to read.
    void promotionUnion.receipt;
    void promotionUnion.nomination;
    break;
  case 'vetoed':
    // @ts-expect-error - a veto can only reject; it never yields a receipt.
    void promotionUnion.receipt;
    void promotionUnion.vetoes;
    break;
  case 'denied': {
    const code: AxAgentPlaybookPromotionDenialCode = promotionUnion.code;
    // @ts-expect-error - a denial carries a code and a reason, never a receipt.
    void promotionUnion.receipt;
    void code;
    break;
  }
  default: {
    const receipt = promotionUnion.receipt;
    // The grant binds a host-grantable identity. A digest is receipt metadata.
    const boundTo: string = promotionUnion.nomination.resourceId;
    void receipt;
    void boundTo;
  }
}

// A veto's return type has no `undefined` inhabitant: a host that forgets a
// `return` fails to compile before it discovers, at runtime, that Ax read its
// silence as a veto.
declare const veto: AxAgentPlaybookPromotionVeto;
const vetoAnswer: boolean | AxAgentPlaybookVetoResult = await veto(
  promotionUnion.nomination
);
void vetoAnswer;
// @ts-expect-error - a veto that forgets its `return` does not type-check. This
// is the probe that actually pins `undefined` out of the union: an assignment
// to `false` would keep erroring even if `undefined` were added to it.
const forgetfulVeto: AxAgentPlaybookPromotionVeto = () => undefined;
void forgetfulVeto;

// A prune records the thresholds it was judged by, separately from the
// retention policy's own. Reading one as the other is what the two fields
// exist to prevent.
declare const prune: AxAgentPlaybookPruneProposal;
const pruneLossTolerance: number = prune.appliedThresholds.maxCurrentLoss;
// @ts-expect-error - a prune is never judged by a minimum GAIN.
void prune.appliedThresholds.minCurrentGain;
void pruneLossTolerance;
