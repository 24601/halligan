import { describe, expect, it } from 'vitest';
import {
  CANDIDATES,
  runLearningSurfaceEvaluation,
} from './eval-learning-surface.js';

/**
 * The evaluation's invariants, asserted so the evidence cannot rot. Every
 * assertion here is one a stub would fail: the fault rows must show faults
 * were actually injected AND that no invariant broke, and the policy rows are
 * pinned to an exact per-scenario acceptance vector rather than to an
 * inequality a reject-everything selector would also satisfy.
 */
describe('learning-surface mechanism evaluation', { timeout: 300_000 }, () => {
  it('holds every durability invariant under every injected fault', async () => {
    const report = await runLearningSurfaceEvaluation();

    expect(report.kind).toBe('deterministic-mechanism-characterization');
    expect(report.independentModelHeldOut).toBe(false);
    expect(report.budget.providerCalls).toBe(0);
    expect(report.faultInjection).toHaveLength(5);

    for (const row of report.faultInjection) {
      // Non-hollow: the boundary really did fault on every seeded ordering.
      expect([row.boundary, row.faultsObserved]).toEqual([
        row.boundary,
        row.orderings,
      ]);
      expect([row.boundary, row.recordsLostAfterReceipt]).toEqual([
        row.boundary,
        0,
      ]);
      expect([row.boundary, row.receiptsWithoutRecord]).toEqual([
        row.boundary,
        0,
      ]);
      expect([row.boundary, row.headsMovedWithoutPromote]).toEqual([
        row.boundary,
        0,
      ]);
      expect([row.boundary, row.treesLeftInstalled]).toEqual([row.boundary, 0]);
    }

    // A crash between the decision and the append leaves nothing on the chain,
    // and an aborted step appends nothing either.
    const crash = report.faultInjection.find(
      (row) => row.boundary === 'evolve-crash-between-decide-and-nominate'
    );
    expect(crash?.releasesAppendedAfterFault).toBe(0);
    const aborted = report.faultInjection.find(
      (row) => row.boundary === 'abort-mid-evaluation'
    );
    expect(aborted?.releasesAppendedAfterFault).toBe(0);
    // A lost CAS race appends the winner's row exactly once — never a fork and
    // never a duplicate of our own.
    const cas = report.faultInjection.find(
      (row) => row.boundary === 'chain-append-cas-lost-race'
    );
    expect(cas?.releasesAppendedAfterFault).toBe(0);
  });

  it('pins the exact per-scenario acceptance vector for both policies', async () => {
    const report = await runLearningSurfaceEvaluation();
    const { acceptanceVector } = report.promotionPolicy;

    // A selector that always rejected would satisfy "false promotions <= the
    // other policy's", so the vector itself is the assertion.
    expect(acceptanceVector.scoreComparison).toEqual({
      overfit: true,
      generalizing: true,
      'no-benefit': false,
      harmful: false,
      'small-noisy-overfit': true,
      'small-noisy-generalizing': true,
      'small-gain-generalizing': true,
    });
    expect(acceptanceVector.axPlaybookGate).toEqual({
      overfit: false,
      generalizing: true,
      'no-benefit': false,
      harmful: false,
      'small-noisy-overfit': false,
      'small-noisy-generalizing': true,
      'small-gain-generalizing': false,
    });

    expect(report.promotionPolicy.scenarios).toEqual(
      CANDIDATES.map((candidate) => candidate.name)
    );
    expect(report.promotionPolicy.falsePromotions.axPlaybookGate).toBe(0);
    expect(
      report.promotionPolicy.falsePromotions.scoreComparison
    ).toBeGreaterThan(0);

    // The counter-metric, reported beside the metric: strictness has a cost,
    // and this line must never be silently empty.
    expect(
      report.promotionPolicy.helpfulCandidatesRejected.axPlaybookGate
    ).toEqual(['small-gain-generalizing']);

    // Every accepted candidate's held-out delta is reported, negatives
    // included — that is how a reader sees what each policy actually bought.
    const parityDeltas =
      report.promotionPolicy.acceptedHeldOutDeltas.scoreComparison;
    expect(parityDeltas.some((delta) => delta < 0)).toBe(true);
    expect(
      report.promotionPolicy.acceptedHeldOutDeltas.axPlaybookGate.every(
        (delta) => delta > 0
      )
    ).toBe(true);
  });

  it('bounds engine ingest cost by the parked reports on the arriving id', async () => {
    const report = await runLearningSurfaceEvaluation();
    const rows = report.overhead.engineIngest;
    expect(rows.map((row) => row.parkedReports)).toEqual([0, 100, 1_000]);
    // One report waits on the arriving id, so exactly one decision is emitted
    // however many unrelated reports are parked. A 10x increase in parked
    // reports must not move it.
    for (const row of rows) {
      expect([row.parkedReports, row.decisionsPerInteractionIngest]).toEqual([
        row.parkedReports,
        1,
      ]);
    }
  });

  it('reports the overhead columns and states its own limitations', async () => {
    const report = await runLearningSurfaceEvaluation();
    expect(report.overhead.runs).toBe(1_000);
    expect(report.overhead.bytesPerRecord).toBeGreaterThan(0);
    expect(Number.isFinite(report.overhead.addedMsPerRun)).toBe(true);
    // The disclaimer is part of the evidence, not decoration.
    expect(report.limitations.length).toBeGreaterThanOrEqual(4);
    expect(report.limitations[0]).toContain('not a live-model improvement');
    expect(report.baseline).toContain('scoreComparison');
  });
});
