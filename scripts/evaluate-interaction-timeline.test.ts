import { describe, expect, it } from 'vitest';

import { runInteractionTimelineEvaluation } from './evaluate-interaction-timeline.js';

describe('interaction timeline deterministic evaluation', () => {
  it('outperforms the declared naive arrival-order mechanism without model calls', () => {
    const report = runInteractionTimelineEvaluation();

    expect(report.budget).toMatchObject({
      providerCalls: 0,
      providerTokens: 0,
      costUSD: 0,
      inputs: 18,
    });
    expect(report.timeline).toMatchObject({
      classificationFidelity: 1,
      pairwiseTemporalOrderFidelity: 1,
      falseAcceptance: 0,
      falseRejection: 0,
    });
    expect(report.naiveArrivalOrder.classificationFidelity).toBeLessThan(1);
    expect(report.naiveArrivalOrder.pairwiseTemporalOrderFidelity).toBeLessThan(
      1
    );
    expect(report.naiveArrivalOrder.falseAcceptance).toBeGreaterThan(0);
    expect(report.naiveArrivalOrder.falseRejection).toBe(0);
    expect(report.checks).toMatchObject({
      crossmodalLinkPreserved: true,
      causalCycleRejected: true,
      droppedPredecessorGapDetected: true,
      temporalProjectionMatchesExpected: true,
      boundedProjectionWithinLimits: true,
    });
    expect(report.checks.arrivalTimesMs).toEqual(
      Array.from({ length: 18 }, (_, index) => (index + 1) * 5)
    );
    expect(report.projection.boundedEvents).toBeLessThanOrEqual(6);
    expect(report.projection.boundedBytes).toBeLessThanOrEqual(4_096);
    expect(report.projection.boundedOmittedEvents).toBeGreaterThan(0);
    expect(
      report.projection.serializationMetadataOverheadBytes
    ).toBeGreaterThan(0);
    expect(report.limitations).toContain(
      'Temporal ordering and link preservation do not demonstrate semantic alignment or real-world synchronization.'
    );
  });
});
