import { describe, expect, it } from 'vitest';
import {
  evaluatePreferenceEvidenceExpectation,
  runPreferenceEvidenceEvaluation,
} from './evaluate-preference-evidence.js';

describe('preference evidence evaluation', () => {
  it('runs the digest-frozen post-baseline artifact with exact green expectations', () => {
    const result = runPreferenceEvidenceEvaluation(10);

    expect(result.artifact).toMatchObject({
      id: 'preference-evidence-later-v1',
      commit: '0f70af1aa9723c7059c0850b034918ba733ee958',
      sha256:
        '756d76538ab5733c86894b8aecb62af7218563f301a80c599970c1d5922daa9f',
      digestVerifiedBeforeParse: true,
      mechanismBaselineCommit: '8e1152f8974231ea7e81d8078acbd7e84386c438',
      policyAuthority: 'synthetic-event-policy-v1',
      cases: 17,
    });
    expect(result.staticNoPersonalization).toEqual({
      exactRetrieval: 14,
      correctApplications: 0,
      falsePersonalizationCases: 0,
      missedPersonalizationCases: 3,
    });
    expect(result.naiveLatestValue).toEqual({
      exactRetrieval: 16,
      correctApplications: 2,
      falsePersonalizationCases: 0,
      missedPersonalizationCases: 1,
    });
    expect(result.evidenceAware).toEqual({
      exactRetrieval: 17,
      correctApplications: 3,
      falsePersonalizationCases: 0,
      missedPersonalizationCases: 0,
    });
    expect(result.retentionAndForgetting).toEqual({
      stablePreferenceRetained: true,
      expiredEvidenceForgotten: true,
    });
    expect(result.lifecycle).toEqual({
      retractionWithheld: true,
      retractionHistoryRetained: true,
      erasureWithheld: true,
      staleReplayWithheld: true,
      authorizedNewEpochApplied: true,
      monotonicErasureVersion: true,
      erasureFidelity: true,
    });
    expect(result.authority).toEqual({
      forgedConsentWithheld: true,
      wrongDestructiveAuthorityClassWithheld: true,
    });
    expect(result.stress).toEqual({
      countBound: true,
      queryBound: true,
      totalByteBound: true,
      shapeIsolated: true,
      callbacksBeforeRejection: 0,
    });
    expect(result.negativeResults).toMatchObject({
      noBenefitControlExact: true,
      uncertainInferenceExactRejection: true,
      noisyWeakContradictionResolved: true,
    });
    expect(result.negativeResults.preservedFailures).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.reasonCoverage).toEqual({
      exactCases: 17,
      wrongReasonCases: 0,
      uncheckedAppliedOnlyCases: 0,
    });
    expect(result.resources.providerCalls).toBe(0);
    expect(result.resources.costUsd).toBe(0);
    expect(result.claimScope).toContain(
      'no independent personalization-accuracy'
    );
  });

  it('fails a wrong-reason rejection even when applied IDs match', () => {
    expect(
      evaluatePreferenceEvidenceExpectation(
        {
          applied: [],
          exclusions: [{ recordId: 'record-1', reason: 'stale-stream' }],
          callbacks: {
            stream: 1,
            receipt: 0,
            destructive: 0,
            policy: 0,
            receiptPurposes: [],
          },
        },
        {
          applied: [],
          exclusions: [{ recordId: 'record-1', reason: 'expired' }],
          callbacks: {
            stream: 1,
            receipt: 1,
            destructive: 0,
            policy: 0,
            receiptPurposes: ['source'],
          },
        }
      )
    ).toEqual({
      applied: true,
      exclusions: false,
      callbacks: false,
      passed: false,
    });
  });
});
