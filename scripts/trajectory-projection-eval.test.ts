import { beforeAll, describe, expect, it } from 'vitest';

import {
  AX_TRAJECTORY_PROJECTION_HONESTY,
  type AxTrajectoryProjectionReport,
  type AxTrajectoryProjectionRow,
  assertTrajectoryProjectionEvaluation,
  runTrajectoryProjectionEvaluation,
} from './trajectory-projection-eval.js';

let report: Readonly<AxTrajectoryProjectionReport>;

beforeAll(async () => {
  report = await runTrajectoryProjectionEvaluation();
}, 300_000);

const realRows = (): readonly AxTrajectoryProjectionRow[] =>
  report.rows.filter((row) => row.summarizer !== 'hollow-blocks');

function mutate(
  change: (rows: AxTrajectoryProjectionRow[]) => void
): Readonly<AxTrajectoryProjectionReport> {
  const rows = report.rows.map((row) => ({ ...row }));
  change(rows);
  return { ...report, rows };
}

describe('trajectory projection evaluation', () => {
  it('spends nothing and states what it is not', () => {
    // `providerCalls` is an instrumented count of outbound fetches made while
    // the rows were measured, not a literal checked against itself.
    expect(report.budget).toMatchObject({
      providerCalls: 0,
      tokens: 0,
      usd: 0,
    });
    expect(report.honesty).toBe(AX_TRAJECTORY_PROJECTION_HONESTY);
    expect(report.honesty).toContain('not a held-out model comparison');
    expect(report.baseline).toContain('Full raw replay');
  });

  it('covers 10 / 1e3 / 1e5 / 1e6 filtered steps', () => {
    expect(new Set(realRows().map((row) => row.narrativeSteps))).toEqual(
      new Set([10, 1_000, 100_000, 1_000_000])
    );
  });

  it.each([10, 1_000, 100_000, 1_000_000])(
    'is total, chronological and drillable at %i steps',
    (size) => {
      for (const row of realRows().filter(
        (entry) => entry.narrativeSteps === size
      )) {
        expect(row.filteredSteps).toBe(size);
        expect(row.coverage).toBe(1);
        expect(row.drillDownResolved).toBe(1);
        expect(row.citationsOutOfRange).toBe(0);
        expect(row.chronologyInversions).toBe(0);
        expect(row.lifeSections).toBeLessThanOrEqual(row.sectionBound);
        // Tiers are an optimization: deleting every block leaves the tail.
        expect(row.degradedRecentSteps).toBe(row.recentSteps);
        // ...and leaves it for a BOUNDED number of store round-trips.
        expect(row.degradedRollupReads).toBeLessThanOrEqual(row.descentBudget);
        expect(row.recentSteps).toBe(Math.min(size, row.recentSize));
        if (size > row.recentSize) {
          // Two-sided: a ceiling on sections is also met by emitting none.
          expect(row.lifeSections).toBeGreaterThan(0);
          expect(row.citedIds).toBeGreaterThan(0);
          expect(row.blocksSealed).toBeGreaterThan(0);
        }
      }
    }
  );

  it('beats a raw replay that does not fit the budget at all', () => {
    for (const row of realRows().filter(
      (entry) => entry.narrativeSteps >= 100_000
    )) {
      expect(row.rawReplayTokens).toBeGreaterThan(row.budgetTokens);
      expect(row.compression).toBeGreaterThan(10);
      expect(row.projectionTokens).toBeGreaterThan(0);
    }
  });

  it('agrees with the reference store wherever both were run', () => {
    for (const size of [10, 1_000]) {
      const memory = realRows().find(
        (row) => row.narrativeSteps === size && row.store === 'memory'
      );
      const synthetic = realRows().find(
        (row) => row.narrativeSteps === size && row.store === 'synthetic'
      );
      expect(memory).toBeDefined();
      expect(synthetic).toBeDefined();
      expect({
        life: memory?.lifeSections,
        recent: memory?.recentSteps,
        sealed: memory?.blocksSealed,
        cited: memory?.citedIds,
      }).toEqual({
        life: synthetic?.lifeSections,
        recent: synthetic?.recentSteps,
        sealed: synthetic?.blocksSealed,
        cited: synthetic?.citedIds,
      });
    }
  });

  it('shows coverage alone is gameable and the paired metric catches it', () => {
    const hollow = report.rows.find(
      (row) => row.summarizer === 'hollow-blocks'
    );
    expect(hollow).toBeDefined();
    // Blocks sealed by something that never read the log still claim every
    // index -- which is exactly why coverage is never reported alone.
    expect(hollow?.coverage).toBe(1);
    expect(hollow?.drillDownResolved).toBeLessThan(1);
    expect(hollow?.citationsOutOfRange).toBeGreaterThan(0);
  });

  it('runs inside its declared wall-clock budget', () => {
    expect(report.budget.wallClockMs).toBeLessThan(30_000);
  });
});

describe('the shipped gate has teeth', () => {
  it('passes the real report', () => {
    expect(() => assertTrajectoryProjectionEvaluation(report)).not.toThrow();
  });

  // Every metric the report prints is one the gate must actually check; a
  // green `npm run trajectory:projection:eval` beside a red test would mean
  // the script is decorative.
  it.each([
    [
      'a coverage hole',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows[0];
        if (row) row.coverage = 0.99;
      },
      'coverage',
    ],
    [
      'an unresolvable citation',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000);
        if (row) row.drillDownResolved = 0.9;
      },
      'drill-down',
    ],
    [
      'a citation outside its block',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000);
        if (row) row.citationsOutOfRange = 1;
      },
      'outside their block',
    ],
    [
      'a chronology inversion',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 100_000);
        if (row) row.chronologyInversions = 1;
      },
      'chronology inversions',
    ],
    [
      'more sections than the bound allows',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000_000);
        if (row) row.lifeSections = row.sectionBound + 1;
      },
      'exceed the bound',
    ],
    [
      'a projection that emitted no section at all',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000_000);
        if (row) {
          row.lifeSections = 0;
          row.citedIds = 0;
        }
      },
      'no life section',
    ],
    [
      'sections that cite nothing',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000_000);
        if (row) row.citedIds = 0;
      },
      'nothing was cited',
    ],
    [
      'a raw baseline that already fits the budget',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 100_000);
        if (row) row.rawReplayTokens = 10;
      },
      'already fits the budget',
    ],
    [
      'a degraded projection that lost the raw tail',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000);
        if (row) row.degradedRecentSteps = 0;
      },
      'changed the raw tail',
    ],
    [
      'a degraded projection that swept the whole missing pyramid',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.narrativeSteps === 1_000_000);
        if (row) row.degradedRollupReads = row.descentBudget + 1;
      },
      'descent budget',
    ],
    [
      'a generator that disagrees with the reference store',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find(
          (entry) =>
            entry.narrativeSteps === 1_000 && entry.store === 'synthetic'
        );
        if (row) row.blocksSealed += 1;
      },
      'disagrees with the reference store',
    ],
    [
      'a control that stopped demonstrating anything',
      (rows: AxTrajectoryProjectionRow[]) => {
        const row = rows.find((entry) => entry.summarizer === 'hollow-blocks');
        if (row) {
          row.drillDownResolved = 1;
          row.citationsOutOfRange = 0;
        }
      },
      'did not catch fabricated citations',
    ],
    [
      'a missing size',
      (rows: AxTrajectoryProjectionRow[]) => {
        const at = rows.findIndex(
          (entry) => entry.narrativeSteps === 1_000_000
        );
        if (at >= 0) rows.splice(at, 1);
      },
      'no row at 1000000',
    ],
  ])('rejects %s', (_label, change, message) => {
    expect(() =>
      assertTrajectoryProjectionEvaluation(mutate(change))
    ).toThrowError(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('rejects an edited honesty clause and a non-zero budget', () => {
    expect(() =>
      assertTrajectoryProjectionEvaluation({
        ...report,
        honesty: 'this proves the mind thinks well',
      })
    ).toThrow(/honesty clause/);
    expect(() =>
      assertTrajectoryProjectionEvaluation({
        ...report,
        budget: { ...report.budget, providerCalls: 1 },
      })
    ).toThrow(/zero provider calls/);
  });
});
