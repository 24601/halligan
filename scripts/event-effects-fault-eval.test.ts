import { describe, expect, it } from 'vitest';
import { runAxEventEffectFaultEvaluation } from './event-effects-fault-eval.js';

describe('AxEventRuntime effect fault evaluation', () => {
  it('classifies and recovers every persisted effect boundary without record loss', async () => {
    const result = await runAxEventEffectFaultEvaluation();

    expect(result.claims).toEqual({
      scope: 'durability-classification-and-recovery',
      exactlyOnce: false,
      modelQuality: false,
    });
    for (const scenario of result.stateBoundaries) {
      expect(scenario.classification).toBe(scenario.expectedClassification);
      expect(scenario.lostRecords).toBe(0);
      expect(scenario.duplicateRecords).toBe(0);
    }
    expect(result.stateBoundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundary: 'dispatched',
          replaySafety: 'unknown',
          recoveredDeliveryStatus: 'parked',
          recoveryDispatches: 0,
        }),
        expect.objectContaining({
          boundary: 'settled-success',
          recoveredDeliveryStatus: 'succeeded',
          recoveryDispatches: 0,
        }),
      ])
    );
    expect(result.resolverOutcomes.map((row) => row.resolution)).toEqual([
      'succeeded',
      'failed',
      'not_dispatched',
      'indeterminate',
      'parked',
    ]);
    expect(result.legacyComparison.idempotentTarget).toEqual(
      expect.objectContaining({
        recoveredStatus: 'succeeded',
        recoveryDispatches: 1,
        duplicateEffectRisk: true,
        effectClassification: 'unavailable',
      })
    );
    expect(result.legacyComparison.unknownTarget).toEqual(
      expect.objectContaining({
        recoveredStatus: 'outcome_unknown',
        recoveryDispatches: 0,
        effectClassification: 'unavailable',
      })
    );
    expect(result.concurrency).toEqual({
      claimWinners: 1,
      effectRecords: 1,
      duplicateRecords: 0,
      staleRevisionRejected: true,
      expiredFenceRejected: true,
      staleFenceRejected: true,
    });
    expect(result.overhead.iterations).toBe(200);
    expect(result.overhead.effectStorageBytes).toBeGreaterThan(
      result.overhead.baselineStorageBytes
    );
    expect(Number.isFinite(result.overhead.incrementalMeanLatencyMs)).toBe(
      true
    );
    expect(result.overhead.incrementalStorageBytesPerEffect).toBeGreaterThan(0);
  }, 30_000);
});
