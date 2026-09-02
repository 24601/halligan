import { beforeAll, describe, expect, it } from 'vitest';

import { axDefaultMindPacerConfig, axMindPaceDelay } from '../src/ax/index.js';
import {
  AX_MIND_PACER_BASELINES,
  AX_MIND_PACER_HONESTY,
  type AxMindPacerReport,
  type AxMindPacerRow,
  assertMindPacerEvaluation,
  runMindPacerEvaluation,
} from './mind-pacer-eval.js';

let report: Readonly<AxMindPacerReport>;

beforeAll(async () => {
  report = await runMindPacerEvaluation();
}, 120_000);

const pick = (scenario: string, capMs: number): AxMindPacerRow =>
  report.rows.find(
    (row) => row.scenario === scenario && row.capMs === capMs
  ) as AxMindPacerRow;

/** Mutates a copy of the report, so the gate can be shown to actually bite. */
function mutate(
  change: (rows: AxMindPacerRow[]) => void
): Readonly<AxMindPacerReport> {
  const rows = report.rows.map((row) => ({ ...row }));
  change(rows);
  return { ...report, rows };
}

describe('mind pacing evaluation', () => {
  it('spends nothing and states what it is not', () => {
    expect(report.budget).toMatchObject({
      providerCalls: 0,
      tokens: 0,
      usd: 0,
    });
    expect(report.honesty).toBe(AX_MIND_PACER_HONESTY);
    expect(report.honesty).toContain('not a held-out model comparison');
    expect(report.baseline).toBe(AX_MIND_PACER_BASELINES);
    expect(report.baseline).toContain('AxTimerEventSource');
  });

  it('covers five scenarios across three caps', () => {
    expect(report.rows).toHaveLength(15);
    expect(new Set(report.rows.map((row) => row.capMs))).toEqual(
      new Set([60_000, 300_000, 600_000])
    );
    expect(new Set(report.rows.map((row) => row.scenario))).toEqual(
      new Set(['idle', 'thought-loop', 'engaged', 'error-storm', 'rate-fuse'])
    );
  });

  it('passes its own shipped gate', () => {
    expect(() => assertMindPacerEvaluation(report)).not.toThrow();
  });

  it('bounds the idle wake rate two-sided, and reports the descent beside it', () => {
    const idle600 = pick('idle', 600_000);
    const idle300 = pick('idle', 300_000);
    expect(idle600.steadyWakesPerHour).toBeLessThanOrEqual(6);
    expect(idle600.steadyWakesPerHour).toBeGreaterThan(0);
    expect(idle300.steadyWakesPerHour).toBeLessThanOrEqual(12);
    expect(idle300.steadyWakesPerHour).toBeGreaterThan(0);
    // A day that starts cold costs MORE than the steady rate. Quoting the
    // headline without this number would understate a real quiet period.
    expect(idle300.spontaneousWakesPerHour).toBeGreaterThan(
      idle300.steadyWakesPerHour
    );
    // The counter-metric: an idle mind resets nothing. A mind whose resets
    // and wakes are both high is engaged, not cheap.
    expect(idle300.resetsPerHour).toBe(0);
    expect(pick('engaged', 300_000).resetsPerHour).toBeGreaterThan(0);
  });

  it('reaches the cap strictly faster on errors than on idling', () => {
    for (const capMs of [60_000, 300_000, 600_000]) {
      const storm = pick('error-storm', capMs);
      const idle = pick('idle', capMs);
      expect(storm.timeToCapMs).not.toBeNull();
      expect(storm.timeToCapMs!).toBeLessThan(idle.timeToCapMs!);
    }
  });

  it('keeps rumination under the thought cap and still visible', () => {
    for (const capMs of [60_000, 300_000, 600_000]) {
      const thought = pick('thought-loop', capMs);
      expect(thought.maxIntervalMs).toBeLessThanOrEqual(
        axDefaultMindPacerConfig.thoughtCapMs
      );
      expect(thought.steadyWakesPerHour).toBeGreaterThanOrEqual(
        (3_600_000 / axDefaultMindPacerConfig.thoughtCapMs) * 0.9
      );
    }
    // The honest counter-result: on the SHIPPED default the FUSE, not the
    // thought cap, is what bounds a rumination loop, and it parks inside the
    // first hour.
    expect(report.thoughtLoopOnDefaults.parked).toBe(true);
    expect(report.thoughtLoopOnDefaults.parkedAtMs).toBeLessThan(3_600_000);
    expect(report.thoughtLoopOnDefaults.wakesBeforePark).toBeGreaterThan(0);
  });

  it('answers engagement immediately and parks a runaway', () => {
    for (const capMs of [60_000, 300_000, 600_000]) {
      expect(pick('engaged', capMs).engagementResetMs).toBe(0);
      const fuse = pick('rate-fuse', capMs);
      expect(fuse.parked).toBe(true);
      expect(fuse.steadyWakesPerHour).toBeLessThanOrEqual(fuse.fuse);
      expect(fuse.parkedAtMs).not.toBeNull();
    }
  });

  it('measures its declared baselines rather than asserting them', () => {
    // 24h at 300s, published through a real AxTimerEventSource on a manual
    // clock: 288 events.
    expect(report.measuredTimerBaseline.published).toBe(288);
    expect(report.timerEngagementLatencyMs).toBe(300_000);
    // Real pipes: the shipped tick source and the simulation agree.
    expect(report.measuredTickSource.published).toBe(
      report.measuredTickSource.simulated
    );
    expect(report.measuredTickSource.published).toBeGreaterThan(0);
  });

  it('does not claim a saving it does not have', () => {
    // A permanently idle mind at cap = intervalMs costs MORE than the timer,
    // because the descent from cold is real spend. The report says so.
    for (const capMs of [300_000, 600_000]) {
      expect(pick('idle', capMs).wakesSavedVsTimer).toBeLessThanOrEqual(0);
      expect(pick('idle', capMs).wakesSavedVsSleep).toBeGreaterThan(1_000);
    }
  });

  it('agrees with axNextMindPace, so the evidence cannot rot', () => {
    for (const row of report.rows) expect(row.ladderDisagreements).toBe(0);
    // And the ladder itself still says what the rows assume.
    expect(
      axMindPaceDelay(20, { ...axDefaultMindPacerConfig, capMs: 600_000 })
    ).toBe(600_000);
  });

  it.each([
    [
      'an idle rate over the ceiling',
      (rows: AxMindPacerRow[]) => {
        const row = rows.find(
          (one) => one.scenario === 'idle' && one.capMs === 600_000
        )!;
        Object.assign(row, { steadyWakesPerHour: 7 });
      },
    ],
    [
      'a mind that stopped waking entirely',
      (rows: AxMindPacerRow[]) => {
        const row = rows.find(
          (one) => one.scenario === 'idle' && one.capMs === 600_000
        )!;
        Object.assign(row, { steadyWakesPerHour: 0 });
      },
    ],
    [
      'engagement that no longer resets the ladder',
      (rows: AxMindPacerRow[]) => {
        for (const row of rows.filter((one) => one.scenario === 'engaged')) {
          Object.assign(row, { engagementResetMs: 5_000 });
        }
      },
    ],
    [
      'an error storm that descends no faster than idling',
      (rows: AxMindPacerRow[]) => {
        for (const row of rows.filter(
          (one) => one.scenario === 'error-storm'
        )) {
          Object.assign(row, { timeToCapMs: 999_999_999 });
        }
      },
    ],
    [
      'a fuse that never parks',
      (rows: AxMindPacerRow[]) => {
        for (const row of rows.filter((one) => one.scenario === 'rate-fuse')) {
          Object.assign(row, { parked: false });
        }
      },
    ],
    [
      'a rumination loop over the thought cap',
      (rows: AxMindPacerRow[]) => {
        for (const row of rows.filter(
          (one) => one.scenario === 'thought-loop'
        )) {
          Object.assign(row, { maxIntervalMs: 600_000 });
        }
      },
    ],
    [
      'a claimed saving against the timer baseline',
      (rows: AxMindPacerRow[]) => {
        const row = rows.find(
          (one) => one.scenario === 'idle' && one.capMs === 300_000
        )!;
        Object.assign(row, { wakesSavedVsTimer: 120 });
      },
    ],
    [
      'a delay the ladder does not agree with',
      (rows: AxMindPacerRow[]) => {
        Object.assign(rows[0]!, { ladderDisagreements: 1 });
      },
    ],
  ])('the gate rejects %s', (_name, change) => {
    expect(() => assertMindPacerEvaluation(mutate(change))).toThrow(
      /mind pacing evaluation failed/
    );
  });
});
