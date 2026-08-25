import { describe, expect, it } from 'vitest';
import { runPreferenceEvidenceEvaluation } from './evaluate-preference-evidence.js';

describe('preference evidence evaluation', () => {
  it('passes the frozen later principal/temporal mechanism fixture', () => {
    const result = runPreferenceEvidenceEvaluation(10);

    expect(result.split).toMatchObject({
      developmentCases: 3,
      heldOutCases: 16,
      frozenLaterSet: true,
      principalDisjoint: true,
      policyUsesExpectedText: false,
    });
    expect(result.developmentEvidenceAware).toEqual({
      exactRetrieval: 3,
      correctApplications: 1,
      falsePersonalizationCases: 0,
      missedPersonalizationCases: 0,
    });
    expect(result.staticNoPersonalization).toMatchObject({
      exactRetrieval: 14,
      falsePersonalizationCases: 0,
      missedPersonalizationCases: 2,
    });
    expect(result.naiveLatestValue.falsePersonalizationCases).toBeGreaterThan(
      0
    );
    expect(result.evidenceAware).toEqual({
      exactRetrieval: 16,
      correctApplications: 2,
      falsePersonalizationCases: 0,
      missedPersonalizationCases: 0,
    });
    expect(result.retentionAndForgetting).toEqual({
      stablePreferenceRetained: true,
      expiredEvidenceForgotten: true,
      ambiguousAndNoisyEvidenceWithheld: true,
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
      shapeBound: true,
      callbacksBeforeRejection: 0,
    });
    expect(result.failures).toEqual([]);
    expect(result.resources.providerCalls).toBe(0);
    expect(result.resources.costUsd).toBe(0);
  });
});
