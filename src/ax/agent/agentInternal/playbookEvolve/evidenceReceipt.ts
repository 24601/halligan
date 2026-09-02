/**
 * Evidence receipt assembly for `agent.playbook().evolve()`.
 *
 * One receipt per fully evaluated candidate, accepted or rejected — the
 * in-round reading of a rejected candidate is the auditability precondition,
 * not a nice-to-have. The receipt is digested over every field except its own
 * digest and recursively frozen, matching the retention receipt's guarantee.
 *
 * `heldOutContamination` is REQUIRED and is emitted whenever a held-out set is
 * used at all, not only when the number looks bad: `evolve()` re-anchors
 * `heldOut` to the accepted candidate after every accept, so a held-out delta
 * from this loop is a SELECTION number, never a sealed-test number.
 */

import { canonicalDigest, deepFreeze } from './canonical.js';
import type {
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookEvidenceReceipt,
  AxAgentPlaybookEvidenceWarning,
  AxAgentPlaybookGateId,
  AxAgentPlaybookGateReport,
  AxAgentPlaybookInterval,
  AxAgentPlaybookNomination,
  AxAgentPlaybookOverheadReport,
  AxAgentPlaybookPromotionRecord,
  AxAgentPlaybookReachReport,
  AxAgentPlaybookTerminationReport,
  AxAgentPlaybookValidityReport,
} from './playbookEvidenceTypes.js';

export const EVIDENCE_RECEIPT_SCHEMA = 'ax-agent-playbook-evidence-v1' as const;

/**
 * The family-wise error rate implied by re-using one held-out split for `k`
 * selection comparisons at coverage `level`. REPORTED, never corrected for: the
 * right correction depends on a stopping rule the caller owns, and a Bonferroni
 * factor applied without knowing which is a number that looks like rigour and
 * is not.
 */
export function impliedFamilyWiseErrorRate(
  selectionComparisons: number,
  level: number
): number {
  if (selectionComparisons <= 0) return 0;
  return 1 - level ** selectionComparisons;
}

export function buildEvidenceReceipt(args: {
  kind: 'curate' | 'prune';
  nomination: AxAgentPlaybookNomination;
  intervals: Readonly<{
    current: AxAgentPlaybookInterval;
    heldOut?: AxAgentPlaybookInterval;
    slices?: readonly Readonly<{
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
  selectionComparisons: number;
  level: number;
  warnings: readonly AxAgentPlaybookEvidenceWarning[];
  decision: 'accepted' | 'rejected' | 'superseded';
}): AxAgentPlaybookEvidenceReceipt {
  const body = {
    schema: EVIDENCE_RECEIPT_SCHEMA,
    kind: args.kind,
    nomination: args.nomination,
    intervals: {
      current: args.intervals.current,
      ...(args.intervals.heldOut ? { heldOut: args.intervals.heldOut } : {}),
      slices: args.intervals.slices ?? [],
    },
    reach: args.reach,
    validity: args.validity,
    termination: args.termination,
    ...(args.overhead ? { overhead: args.overhead } : {}),
    gates: args.gates,
    promotion: args.promotion,
    accounting: args.accounting,
    heldOutContamination: {
      selectionComparisons: args.selectionComparisons,
      impliedFamilyWiseErrorRate: impliedFamilyWiseErrorRate(
        args.selectionComparisons,
        args.level
      ),
      sealed: false as const,
    },
    warnings: args.warnings,
    decision: args.decision,
  };
  // Digested over every field except `digest` itself, so a receipt can be
  // re-derived and compared byte for byte.
  return deepFreeze({
    ...body,
    digest: canonicalDigest(body),
  }) as AxAgentPlaybookEvidenceReceipt;
}

/**
 * Move a promotion to `promoted_then_rolled_back` when a RUN-LEVEL gate
 * rescinds it.
 *
 * The receipt is kept: it really was issued, and Ax cannot revoke one —
 * `axAuthorize` exposes no revoke path, and revocation is a host lifecycle
 * operation. The honest report is "issued, then superseded", and the distinct
 * status is what makes a live promotion structurally distinguishable from a
 * rescinded one. Without it a consumer reading `outcomes[].promotion` could not
 * tell them apart, which would defeat the point of moving authority off the
 * judge.
 *
 * Every other status is returned unchanged: a candidate that was never promoted
 * has nothing to rescind, and inventing a rollback status for it would report a
 * promotion that never happened.
 */
export function rescindPromotion(
  promotion: Readonly<AxAgentPlaybookPromotionRecord>,
  args: Readonly<{ gate: AxAgentPlaybookGateId; reason: string }>
): AxAgentPlaybookPromotionRecord {
  if (promotion.status !== 'promoted') return promotion;
  return {
    status: 'promoted_then_rolled_back',
    nomination: promotion.nomination,
    receipt: promotion.receipt,
    vetoes: promotion.vetoes,
    rolledBackByGate: args.gate,
    rolledBackReason: args.reason,
  };
}

/**
 * Rebuild an accepted candidate's receipt as `superseded` after a run-level
 * rollback (invariant I8). The receipt is frozen and digested over its own
 * body, so this rebuilds rather than mutates — and the new digest covers the
 * new decision, so a superseded receipt cannot be mistaken for the accepted one
 * it replaced.
 */
export function supersedeEvidenceReceipt(
  receipt: Readonly<AxAgentPlaybookEvidenceReceipt>,
  args: Readonly<{ gate: AxAgentPlaybookGateId; reason: string }>
): AxAgentPlaybookEvidenceReceipt {
  const promotion = rescindPromotion(receipt.promotion, args);
  const warnings: AxAgentPlaybookEvidenceWarning[] = [
    ...receipt.warnings,
    {
      code: 'promotion_rolled_back',
      message: `the whole accepted set was rolled back by the ${args.gate} gate: ${args.reason}`,
    },
  ];
  const { digest: _ignored, ...body } = receipt;
  const next = {
    ...body,
    promotion,
    warnings,
    decision: 'superseded' as const,
  };
  return deepFreeze({
    ...next,
    digest: canonicalDigest(next),
  }) as AxAgentPlaybookEvidenceReceipt;
}

/** Recompute a receipt's digest, for an integrity check on a stored receipt. */
export function evidenceReceiptDigest(
  receipt: Readonly<AxAgentPlaybookEvidenceReceipt>
): string {
  const { digest: _ignored, ...body } = receipt;
  return canonicalDigest(body);
}
