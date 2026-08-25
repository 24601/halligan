import { describe, expect, it } from 'vitest';
import { evaluateCausalCandidateEvidence } from './evaluate-causal-candidate-evidence.js';

describe('causal candidate evidence evaluation', () => {
  it('preserves causal audit and negative evidence without model calls', async () => {
    const result = await evaluateCausalCandidateEvidence();

    expect(result.auditFidelity).toEqual({ baseline: 0, evidenceManifest: 1 });
    expect(result.thresholdAttainment.rate).toBeCloseTo(1 / 3);
    expect(result.thresholdAttainment.confidenceBrierScore).toBeCloseTo(
      0.4466667
    );
    expect(result.ablationAttributionConsistency).toBe(1);
    expect(result.replayExact).toBe(true);
    expect(result.rollbackHistoryExact).toBe(true);
    expect(result.settlementAppended).toBe(true);
    expect(result.evidenceSummariesOmitted).toBe(true);
    expect(result.adversarial).toEqual({
      forgedManifestRejected: true,
      legacyHashCollisionSeparated: true,
      invalidChronologyRejected: true,
    });
    expect(result.negativeCasesPreserved).toEqual([
      'claim-no-benefit',
      'claim-misleading',
    ]);
    expect(result.budget).toMatchObject({
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: 1000,
    });
  });
});
