import { describe, expect, it } from 'vitest';
import { runDemandBoundaryEvaluation } from './eval-demand-boundary.js';

describe('advisory demand mechanism evaluation', () => {
  it('matches the declared deterministic evidence bounds', async () => {
    const report = await runDemandBoundaryEvaluation();
    expect(report.fixture).toMatchObject({
      kind: 'deterministic-mechanism-characterization',
      independentModelHeldOut: false,
      examples: 40,
      positives: 8,
      negatives: 32,
    });
    expect(report.reactive).toMatchObject({ tp: 2, fp: 0, tn: 32, fn: 6 });
    expect(report.naiveThreshold).toMatchObject({
      tp: 7,
      fp: 5,
      tn: 27,
      fn: 1,
    });
    expect(report.boundary).toMatchObject({ tp: 4, fp: 1, tn: 31, fn: 4 });
    expect(report.overhead).toMatchObject({
      detectorCalls: 40,
      grantValidationCalls: 2,
      detectorLatenciesCapped: 0,
      observationBytes: 10_146,
      detectionBytes: 13_523,
      retainedRecords: 40,
    });
    expect(report.overhead.recordedDetectorLatencyMs).toBeGreaterThanOrEqual(0);
    expect(report.overhead.evaluationLatencyMs).toBeGreaterThanOrEqual(0);
    expect(report.calibration.examples).toBe(39);
    expect(report.calibration.brier).toBeCloseTo(0.132825641, 9);
    expect(report.calibration.ece).toBeCloseTo(0.22974359, 8);
  });
});
