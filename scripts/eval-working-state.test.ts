import { describe, expect, it } from 'vitest';
import { runWorkingStateEvaluation } from './eval-working-state.js';

describe('working-state mechanism evaluation', () => {
  it('emits every declared column for every horizon and arm, and the headline invariants hold', async () => {
    const report = await runWorkingStateEvaluation();

    expect(report.kind).toBe('deterministic-mechanism-characterization');
    expect(report.independentModelHeldOut).toBe(false);
    // Four horizons times two arms; a dropped cell must fail the suite rather
    // than silently shrink the evidence.
    expect(report.rows).toHaveLength(report.horizons.length * 2);

    for (const row of report.rows) {
      for (const column of [
        'turns',
        'modelCalls',
        'cumulativeTokens',
        'peakPromptChars',
        'meanPromptCharsPerTurn',
        'stateRecoverySteps',
        'goalsCompleted',
        'falseCompletionsParked',
        'accuracy',
      ] as const) {
        expect([row.horizon, row.arm, column, typeof row[column]]).toEqual([
          row.horizon,
          row.arm,
          column,
          'number',
        ]);
      }
    }

    for (const horizon of report.horizons) {
      const withState = report.rows.find(
        (row) => row.horizon === horizon && row.arm === 'working-state'
      )!;
      const baseline = report.rows.find(
        (row) => row.horizon === horizon && row.arm === 'baseline'
      )!;
      // The gate parked a receipt-free completion claim while receipt-backed
      // goals in the same run completed: strict, not closed.
      expect([horizon, withState.falseCompletionsParked >= 1]).toEqual([
        horizon,
        true,
      ]);
      expect([horizon, withState.goalsCompleted > 0]).toEqual([horizon, true]);
      expect([horizon, withState.stateRecoverySteps]).toEqual([horizon, 0]);
      expect([horizon, withState.accuracy >= baseline.accuracy]).toEqual([
        horizon,
        true,
      ]);
    }

    // The baseline really has the problem being measured.
    const baseline100 = report.rows.find(
      (row) => row.horizon === 100 && row.arm === 'baseline'
    )!;
    expect(baseline100.stateRecoverySteps).toBeGreaterThanOrEqual(1);

    // The counter-metric is reported beside the metric, and is a cost.
    const overhead = report.promptOverheadByHorizon['100'];
    expect(typeof overhead).toBe('number');
    expect(overhead!).toBeGreaterThan(0);

    expect(report.completionInterlock.converted).toBeGreaterThanOrEqual(1);
    expect(report.completionInterlock.auditGoalStatus).toBe('pending');
    expect(report.determinism.digestsEqualAcrossRuns).toBe(true);
    expect(report.determinism.traceSteps).toBeGreaterThan(0);

    // The honesty clause travels with the numbers.
    expect(report.negativeResults.length).toBeGreaterThanOrEqual(5);
    expect(report.negativeResults.join(' ')).toContain('mechanism evidence');
  }, 300_000);
});
