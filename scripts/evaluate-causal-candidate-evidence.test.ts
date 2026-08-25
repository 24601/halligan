import { describe, expect, it } from 'vitest';
import { evaluateCausalCandidateEvidence } from './evaluate-causal-candidate-evidence.js';

describe('causal candidate evidence evaluation', () => {
  it('preserves causal audit and negative evidence without model calls', () => {
    const result = evaluateCausalCandidateEvidence();

    expect(result.auditFidelity).toEqual({ baseline: 0, evidenceManifest: 1 });
    expect(result.predictionCalibration.directionAccuracy).toBeCloseTo(1 / 3);
    expect(result.predictionCalibration.brierScore).toBeCloseTo(0.4466667);
    expect(result.ablationAttributionConsistency).toBe(1);
    expect(result.replayExact).toBe(true);
    expect(result.rollbackHistoryExact).toBe(true);
    expect(result.settlementAppended).toBe(true);
    expect(result.rawEvidenceRedacted).toBe(true);
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
