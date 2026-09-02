import { describe, expect, it } from 'vitest';
import { runWorkingStateEvaluation } from './eval-working-state.js';

describe('working-state mechanism evaluation', () => {
  it('emits every declared column for every horizon and arm, and the headline invariants hold', async () => {
    const report = await runWorkingStateEvaluation();

    expect(report.kind).toBe('deterministic-mechanism-characterization');
    expect(report.independentModelHeldOut).toBe(false);
    // Four horizons times three arms; a dropped cell must fail the suite rather
    // than silently shrink the evidence.
    expect(report.rows).toHaveLength(report.horizons.length * 3);

    for (const row of report.rows) {
      for (const column of [
        'turns',
        'modelCalls',
        'cumulativeTokens',
        'peakPromptChars',
        'meanPromptCharsPerTurn',
        'meanMutableCharsPerTurn',
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

    // The skillState arm keeps the gate and the accuracy while discarding the
    // transcript, and its dynamic tail grows more slowly than either
    // transcript arm.
    for (const horizon of report.horizons) {
      const skillState = report.rows.find(
        (row) => row.horizon === horizon && row.arm === 'skill-state'
      )!;
      const withState = report.rows.find(
        (row) => row.horizon === horizon && row.arm === 'working-state'
      )!;
      expect([horizon, skillState.falseCompletionsParked >= 1]).toEqual([
        horizon,
        true,
      ]);
      expect([horizon, skillState.stateRecoverySteps]).toEqual([horizon, 0]);
      expect([horizon, skillState.goalsCompleted]).toEqual([
        horizon,
        withState.goalsCompleted,
      ]);
    }
    const growth = report.mutableTailGrowth;
    expect(typeof growth['skill-state']).toBe('number');
    // Not vacuous: both transcript arms genuinely grow.
    expect(growth.baseline!).toBeGreaterThan(1.5);
    expect(growth['working-state']!).toBeGreaterThan(1.5);
    expect(growth['skill-state']!).toBeLessThan(growth.baseline!);
    expect(growth['skill-state']!).toBeLessThan(growth['working-state']!);

    const skillState100 = report.rows.find(
      (row) => row.horizon === 100 && row.arm === 'skill-state'
    )!;
    const workingState100 = report.rows.find(
      (row) => row.horizon === 100 && row.arm === 'working-state'
    )!;
    expect(skillState100.meanMutableCharsPerTurn).toBeLessThan(
      workingState100.meanMutableCharsPerTurn
    );
    expect(skillState100.modelCalls).toBeLessThan(workingState100.modelCalls);
    expect(skillState100.modelCalls).toBeLessThan(baseline100.modelCalls);

    // The counter-metric is reported beside the metric, and is a cost.
    const overhead = report.promptOverheadByHorizon['100'];
    expect(typeof overhead).toBe('number');
    expect(overhead!).toBeGreaterThan(0);

    expect(report.completionInterlock.converted).toBeGreaterThanOrEqual(1);
    expect(report.completionInterlock.auditGoalStatus).toBe('pending');
    expect(report.determinism.digestsEqualAcrossRuns).toBe(true);
    expect(report.determinism.traceSteps).toBeGreaterThan(0);

    // The honesty clause travels with the numbers.
    expect(report.negativeResults.length).toBeGreaterThanOrEqual(7);
    // The residual growth term is named rather than hidden.
    expect(report.negativeResults.join(' ')).toContain('TASK-SIZE term');
    expect(report.negativeResults.join(' ')).toContain('mechanism evidence');
  }, 300_000);
});
