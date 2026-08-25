import { describe, expect, it } from 'vitest';
import { runPreferenceEvidenceEvaluation } from './evaluate-preference-evidence.js';

describe('preference evidence evaluation', () => {
  it('passes the held-out temporal/principal mechanism fixture', () => {
    const result = runPreferenceEvidenceEvaluation(10);

    expect(result.split).toMatchObject({
      developmentCases: 3,
      heldOutCases: 11,
      queryPrincipalDisjoint: true,
    });
    expect(result.developmentEvidenceAware).toEqual({
      exactRetrieval: 3,
      falsePersonalization: 0,
      missedPersonalization: 0,
    });
    expect(result.staticNoPersonalization).toEqual({
      exactRetrieval: 10,
      falsePersonalization: 0,
      missedPersonalization: 1,
    });
    expect(result.naiveLatestValue.falsePersonalization).toBeGreaterThan(0);
    expect(result.evidenceAware).toEqual({
      exactRetrieval: 11,
      falsePersonalization: 0,
      missedPersonalization: 0,
    });
    expect(result.retention).toEqual({
      stablePreferenceRetained: true,
      expiredEvidenceForgotten: true,
    });
    expect(result.lifecycle).toEqual({
      retractionWithheld: true,
      erasureWithheld: true,
      erasureFidelity: true,
    });
    expect(result.negativeResults).toEqual({
      noBenefitControlTiesStatic: true,
      uncertainInferenceNotApplied: true,
      noisySmallDataNotApplied: true,
    });
    expect(result.resources.providerCalls).toBe(0);
    expect(result.resources.costUsd).toBe(0);
  });
});
