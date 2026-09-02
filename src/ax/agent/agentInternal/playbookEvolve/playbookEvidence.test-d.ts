/**
 * Compile-time contracts for the playbook evidence surface, enforced by
 * `npm run test:type-tests`. Several of these are the only place a rule is
 * enforceable at all: "there is no transfer average" and "the sealed test can
 * never have influenced a decision" are type-level properties, not runtime
 * ones.
 */

import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookEvidenceReceipt,
  AxAgentPlaybookGateId,
  AxAgentPlaybookInterval,
  AxAgentPlaybookPromotionDenialCode,
  AxAgentPlaybookPromotionRecord,
  AxAgentPlaybookReachReport,
  AxAgentPlaybookSealedTestReport,
  AxAgentPlaybookTransferReport,
  AxAgentPlaybookValidityPredicateId,
  AxAgentTrajectoryClassifier,
  AxAgentTrajectoryTermination,
} from './playbookEvidenceTypes.js';
import type { AxAgentPlaybookEvolveResult } from './playbookEvolveTypes.js';

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

// The denial-code union mirrors all five members of the authority error's code.
const denialCodes: readonly AxAgentPlaybookPromotionDenialCode[] = [
  'host_denied',
  'no_matching_grant',
  'invalid_receipt',
  'cancelled',
  'timeout',
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
