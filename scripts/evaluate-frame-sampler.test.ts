import { describe, expect, it } from 'vitest';
import { runFrameSamplerEvaluation } from './evaluate-frame-sampler.js';

describe('deterministic frame sampler evaluation', () => {
  it('reports bounded policy and baseline mechanism evidence', () => {
    const report = runFrameSamplerEvaluation();
    expect(report.bounds).toMatchObject({
      syntheticFrames: 13,
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
    });
    expect(report.adaptive).toMatchObject({
      sampledFrames: 4,
      changeRecall: 0.75,
      changePrecision: 0.75,
      sceneCutRecall: 2 / 3,
      staleAcceptance: 0,
      falseSuppressions: 1,
    });
    expect(report.naiveEveryFrame).toMatchObject({
      sampledFrames: 13,
      changeRecall: 1,
      staleAcceptance: 1,
    });
    expect(report.avoidedVersusEveryFrame).toEqual({
      frames: 9,
      bytes: 2_800,
      tokens: 225,
    });
    expect(report.avoidedBreakdown).toEqual({
      invalidStaleOrUnauthorized: { frames: 5, bytes: 2_400, tokens: 125 },
      redundancyOrBudget: { frames: 4, bytes: 400, tokens: 100 },
    });
    expect(report.reasons).toEqual([
      'initial',
      'unchanged',
      'unchanged',
      'change',
      'stale_revision',
      'unchanged',
      'scene_cut',
      'malformed',
      'oversized',
      'revoked',
      'stale_authority',
      'scene_cut',
      'budget_frames',
    ]);
    expect(report.noBenefitControl).toEqual({
      materialChanges: 0,
      adaptiveFrames: 1,
      fixedRateFrames: 7,
      everyFrameFrames: 20,
      qualityClaim: 'none',
    });
    expect(report.latency.observations).toBe(10_000);
    expect(report.latency.meanMs).toBeGreaterThanOrEqual(0);
  });
});
