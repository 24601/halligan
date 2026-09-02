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

/** Recompute a receipt's digest, for an integrity check on a stored receipt. */
export function evidenceReceiptDigest(
  receipt: Readonly<AxAgentPlaybookEvidenceReceipt>
): string {
  const { digest: _ignored, ...body } = receipt;
  return canonicalDigest(body);
}
