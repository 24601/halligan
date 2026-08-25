import { pathToFileURL } from 'node:url';
import {
  type AxCausalCandidateEvidenceOptions,
  type AxCausalCandidateEvidenceRecord,
  type AxCausalEvidenceAuthorityVerifier,
  AxOptimizedProgramImpl,
  axAttachCausalCandidateEvidence,
  axDeserializeOptimizedProgram,
  axFingerprintCausalEvidence,
  axReplaceOptimizedProgramSnapshot,
  axSerializeOptimizedProgram,
} from '../src/ax/index.js';

const componentId = 'answerer::instruction';

function split(before: number, after: number) {
  return {
    metrics: [{ metric: 'accuracy', before, after, sampleCount: 20 }],
  };
}

function receiptRegistry(): {
  options: (receiptId: string) => AxCausalCandidateEvidenceOptions;
  verify: AxCausalEvidenceAuthorityVerifier;
} {
  const receipts = new Map<string, string>();
  const verify: AxCausalEvidenceAuthorityVerifier = (payload, authority) => {
    if (
      authority.principalId !== 'host:deterministic-fixture' ||
      authority.evaluatorId !== 'eval:causal-fixture-v2' ||
      authority.verifierId !== 'verifier:fixture-registry' ||
      authority.receiptVersion !== '1'
    ) {
      return false;
    }
    const prior = receipts.get(authority.receiptId);
    if (prior === undefined) receipts.set(authority.receiptId, payload);
    return prior === undefined || prior === payload;
  };
  return {
    options: (receiptId) => ({
      authority: {
        principalId: 'host:deterministic-fixture',
        evaluatorId: 'eval:causal-fixture-v2',
        verifierId: 'verifier:fixture-registry',
        receiptId,
        receiptVersion: '1',
      },
      verifyAuthority: verify,
    }),
    verify,
  };
}

async function scenario(args: {
  id: string;
  sequence: number;
  parentRecordId?: string;
  confidence: number;
  heldInAfter: number;
  heldOutAfter: number;
  decision: 'promoted' | 'rejected';
  ablationAfter: number;
  attribution: 'supports' | 'contradicts' | 'inconclusive';
}): Promise<AxCausalCandidateEvidenceRecord> {
  return {
    id: args.id,
    sequence: args.sequence,
    eventKind: 'candidate_decision',
    parentRecordId: args.parentRecordId,
    candidateId: args.id.replace('claim', 'candidate'),
    evidence: [
      {
        id: `${args.id}-trace`,
        kind: 'trace',
        fingerprint: await axFingerprintCausalEvidence(
          `private trace content for ${args.id}`
        ),
        summary: `sensitive ${args.id} trace excerpt`,
      },
    ],
    hypothesis: 'Adding an explicit grounding rule should improve accuracy.',
    affectedComponents: [
      {
        componentId,
        surface: 'instruction',
        beforeFingerprint: await axFingerprintCausalEvidence('old instruction'),
        afterFingerprint: await axFingerprintCausalEvidence(
          `${args.id} instruction`
        ),
      },
    ],
    predictedBenefit: [
      {
        metric: 'accuracy',
        split: 'held_out',
        expectedDirection: 'increase',
        minimumExpectedDelta: 0.1,
        confidence: args.confidence,
      },
    ],
    predictedRegressions: [],
    outcome: {
      heldIn: split(0.5, args.heldInAfter),
      heldOut: split(0.5, args.heldOutAfter),
    },
    decision: {
      status: args.decision,
      reason:
        args.decision === 'promoted'
          ? 'Held-out benefit met the promotion threshold.'
          : 'Held-out benefit did not meet the promotion threshold.',
    },
    ablation: {
      kind: 'ablation',
      removedComponentIds: [componentId],
      heldIn: split(args.heldInAfter, 0.5),
      heldOut: split(args.heldOutAfter, args.ablationAfter),
      attribution: args.attribution,
      summary: `Ablation result for ${args.id}`,
    },
  };
}

export interface AxCausalEvidenceEvaluationResult {
  scenarios: number;
  auditFidelity: { baseline: number; evidenceManifest: number };
  thresholdAttainment: { rate: number; confidenceBrierScore: number };
  ablationAttributionConsistency: number;
  replayExact: boolean;
  rollbackHistoryExact: boolean;
  settlementAppended: boolean;
  evidenceSummariesOmitted: boolean;
  adversarial: {
    forgedManifestRejected: boolean;
    legacyHashCollisionSeparated: boolean;
    invalidChronologyRejected: boolean;
  };
  bytes: { baseline: number; withEvidence: number; overhead: number };
  negativeCasesPreserved: readonly string[];
  budget: {
    providerCalls: 0;
    providerTokens: 0;
    costUsd: 0;
    maxWallTimeMs: 1000;
    elapsedWallTimeMs: number;
  };
}

export async function evaluateCausalCandidateEvidence(): Promise<AxCausalEvidenceEvaluationResult> {
  const started = performance.now();
  const records = await Promise.all([
    scenario({
      id: 'claim-helpful',
      sequence: 0,
      confidence: 0.8,
      heldInAfter: 0.8,
      heldOutAfter: 0.7,
      decision: 'promoted',
      ablationAfter: 0.5,
      attribution: 'supports',
    }),
    scenario({
      id: 'claim-no-benefit',
      sequence: 1,
      parentRecordId: 'claim-helpful',
      confidence: 0.7,
      heldInAfter: 0.7,
      heldOutAfter: 0.5,
      decision: 'rejected',
      ablationAfter: 0.5,
      attribution: 'inconclusive',
    }),
    scenario({
      id: 'claim-misleading',
      sequence: 2,
      parentRecordId: 'claim-no-benefit',
      confidence: 0.9,
      heldInAfter: 0.8,
      heldOutAfter: 0.4,
      decision: 'rejected',
      ablationAfter: 0.5,
      attribution: 'contradicts',
    }),
  ]);
  const receipts = receiptRegistry();
  const base = new AxOptimizedProgramImpl({
    bestScore: 0.7,
    stats: {} as any,
    componentMap: { [componentId]: 'ground answers in supplied evidence' },
    optimizerType: 'deterministic-fixture',
    optimizationTime: 0,
    totalRounds: 1,
    converged: true,
  });
  const attached = axAttachCausalCandidateEvidence(
    base,
    records,
    receipts.options('receipt-evaluation')
  );
  const historyBeforeRollback = JSON.stringify(
    attached.causalCandidateEvidence?.records
  );
  const rolledBack = axReplaceOptimizedProgramSnapshot(
    attached,
    base,
    receipts.verify
  );
  const settlement: AxCausalCandidateEvidenceRecord = {
    ...records[0]!,
    id: 'settlement-helpful-rollback',
    sequence: 3,
    eventKind: 'settlement',
    parentRecordId: 'claim-misleading',
    settlesRecordId: 'claim-helpful',
    decision: { status: 'rejected', reason: 'Candidate was rolled back.' },
  };
  const settled = axAttachCausalCandidateEvidence(
    rolledBack,
    [settlement],
    receipts.options('receipt-settlement')
  );
  const baselineJson = JSON.stringify(axSerializeOptimizedProgram(base));
  const evidenceJson = JSON.stringify(axSerializeOptimizedProgram(settled));
  const replayed = axDeserializeOptimizedProgram(JSON.parse(evidenceJson), {
    causalEvidenceVerifier: receipts.verify,
  });
  const replayJson = JSON.stringify(axSerializeOptimizedProgram(replayed));

  const requiredAuditFields = [
    'evidence',
    'hypothesis',
    'affectedComponents',
    'predictedBenefit',
    'predictedRegressions',
    'outcome',
    'decision',
    'ablation',
    'authority',
  ];
  const auditFidelity = settled.causalCandidateEvidence!.records.every(
    (record) =>
      record.evidence.length > 0 &&
      record.hypothesis.length > 0 &&
      record.affectedComponents.length > 0 &&
      record.predictedBenefit.length > 0 &&
      Array.isArray(record.predictedRegressions) &&
      record.outcome.heldIn.metrics.length > 0 &&
      record.outcome.heldOut.metrics.length > 0 &&
      Boolean(record.decision.status) &&
      Boolean(record.ablation)
  )
    ? 1
    : 0;
  const predictions = records.map((record) => {
    const prediction = record.predictedBenefit[0]!;
    const observed = record.outcome.heldOut.metrics[0]!;
    const delta = observed.after - observed.before;
    const threshold = prediction.minimumExpectedDelta ?? 0;
    const attained =
      prediction.expectedDirection === 'increase'
        ? delta >= threshold
        : prediction.expectedDirection === 'decrease'
          ? delta <= -threshold
          : Math.abs(delta) <= threshold;
    return { confidence: prediction.confidence ?? 0.5, attained };
  });
  const thresholdAttainmentRate =
    predictions.filter((prediction) => prediction.attained).length /
    predictions.length;
  const confidenceBrierScore =
    predictions.reduce(
      (sum, prediction) =>
        sum + (prediction.confidence - (prediction.attained ? 1 : 0)) ** 2,
      0
    ) / predictions.length;
  const expectedAttribution = records.map((record) => {
    const prediction = record.predictedBenefit[0]!;
    const observed = record.outcome.heldOut.metrics[0]!;
    const ablated = record.ablation!.heldOut.metrics[0]!;
    const candidateDelta = observed.after - observed.before;
    const threshold = prediction.minimumExpectedDelta ?? 0;
    if (candidateDelta >= threshold && ablated.after <= observed.before) {
      return 'supports';
    }
    if (candidateDelta < 0 && ablated.after > observed.after) {
      return 'contradicts';
    }
    return 'inconclusive';
  });
  const ablationAttributionConsistency =
    records.filter(
      (record, index) =>
        record.ablation?.attribution === expectedAttribution[index]
    ).length / records.length;

  const forged = JSON.parse(evidenceJson);
  forged.causalCandidateEvidence.omittedRecordCount += 1;
  forged.causalCandidateEvidence.totalRecordCount += 1;
  let forgedManifestRejected = false;
  try {
    axDeserializeOptimizedProgram(forged, {
      causalEvidenceVerifier: receipts.verify,
    });
  } catch {
    forgedManifestRejected = true;
  }
  const [legacyCollisionLeft, legacyCollisionRight] = await Promise.all([
    axFingerprintCausalEvidence('trace-1mf0zaf-23065'),
    axFingerprintCausalEvidence('trace-v4wu3d-67395'),
  ]);
  let invalidChronologyRejected = false;
  try {
    axAttachCausalCandidateEvidence(
      base,
      [{ ...records[0]!, sequence: 1 }],
      receipts.options('receipt-invalid-chronology')
    );
  } catch {
    invalidChronologyRejected = true;
  }

  const elapsedWallTimeMs = performance.now() - started;
  const result: AxCausalEvidenceEvaluationResult = {
    scenarios: records.length,
    auditFidelity: {
      baseline: requiredAuditFields.every((field) =>
        baselineJson.includes(field)
      )
        ? 1
        : 0,
      evidenceManifest: auditFidelity,
    },
    thresholdAttainment: {
      rate: thresholdAttainmentRate,
      confidenceBrierScore,
    },
    ablationAttributionConsistency,
    replayExact: evidenceJson === replayJson,
    rollbackHistoryExact:
      JSON.stringify(rolledBack.causalCandidateEvidence?.records) ===
      historyBeforeRollback,
    settlementAppended:
      JSON.stringify(settled.causalCandidateEvidence?.records.slice(0, 3)) ===
        historyBeforeRollback &&
      settled.causalCandidateEvidence?.records.at(-1)?.id === settlement.id,
    evidenceSummariesOmitted: !evidenceJson.includes('sensitive'),
    adversarial: {
      forgedManifestRejected,
      legacyHashCollisionSeparated:
        legacyCollisionLeft !== legacyCollisionRight,
      invalidChronologyRejected,
    },
    bytes: {
      baseline: new TextEncoder().encode(baselineJson).byteLength,
      withEvidence: new TextEncoder().encode(evidenceJson).byteLength,
      overhead:
        new TextEncoder().encode(evidenceJson).byteLength -
        new TextEncoder().encode(baselineJson).byteLength,
    },
    negativeCasesPreserved: ['claim-no-benefit', 'claim-misleading'],
    budget: {
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: 1000,
      elapsedWallTimeMs,
    },
  };
  if (
    result.auditFidelity.baseline !== 0 ||
    result.auditFidelity.evidenceManifest !== 1 ||
    Math.abs(result.thresholdAttainment.rate - 1 / 3) > 1e-9 ||
    Math.abs(
      result.thresholdAttainment.confidenceBrierScore - 0.4466666666666667
    ) > 1e-9 ||
    !result.replayExact ||
    !result.evidenceSummariesOmitted ||
    result.ablationAttributionConsistency !== 1 ||
    !result.rollbackHistoryExact ||
    !result.settlementAppended ||
    !Object.values(result.adversarial).every(Boolean) ||
    result.negativeCasesPreserved.length !== 2 ||
    elapsedWallTimeMs > result.budget.maxWallTimeMs
  ) {
    throw new Error(
      `causal evidence evaluation failed: ${JSON.stringify(result)}`
    );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(await evaluateCausalCandidateEvidence(), null, 2));
}
