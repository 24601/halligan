import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AxLearningSurfaceEvalReport,
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
  // One evaluation, shared. It is deterministic by construction, so four
  // separate runs bought nothing but ~20s on the root `npm test` chain.
  let report: AxLearningSurfaceEvalReport;
  beforeAll(async () => {
    report = await runLearningSurfaceEvaluation();
  });

  it('holds every durability invariant under every injected fault', async () => {
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
      // …and it faulted on genuinely different configurations, not on twenty
      // byte-identical repetitions of one.
      expect([row.boundary, row.distinctConfigurations > 1]).toEqual([
        row.boundary,
        true,
      ]);
    }

    // Pinned exactly, so a seeding regression that collapses a boundary's
    // configuration space cannot pass as "still 20 orderings". `evolve-crash`
    // has a four-configuration space (pre/post commit x two episode orders)
    // and covers all of it.
    expect(
      Object.fromEntries(
        report.faultInjection.map((row) => [
          row.boundary,
          row.distinctConfigurations,
        ])
      )
    ).toEqual({
      'append-pre-commit': 20,
      'append-post-commit': 20,
      'chain-append-cas-lost-race': 9,
      'evolve-crash-between-decide-and-nominate': 4,
      'abort-mid-evaluation': 12,
    });

    // Every `releasesAppendedAfterFault` counts UNEXPECTED appends. A crash
    // after the commit is supposed to leave exactly its own nomination on the
    // chain — that variant is now modelled, and the row it left must be
    // `current: false` — while a pre-commit crash and an aborted step leave
    // nothing at all.
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
    expect(report.overhead.runs).toBe(1_000);
    expect(report.overhead.bytesPerRecord).toBeGreaterThan(0);
    expect(Number.isFinite(report.overhead.addedMsPerRun)).toBe(true);
    // The disclaimer is part of the evidence, not decoration.
    expect(report.limitations.length).toBeGreaterThanOrEqual(4);
    expect(report.limitations[0]).toContain('not a live-model improvement');
    expect(report.baseline).toContain('scoreComparison');
  });
});
