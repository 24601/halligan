/**
 * Working-state benchmark assertions (Track B5 PR 1).
 *
 * MECHANISM EVIDENCE, NOT MODEL QUALITY. The AI is a deterministic mock; the
 * scenario is a warehouse state machine, which is close to a best case for
 * state-as-substrate; the proposer is a deterministic host callback, so the
 * arms make comparable model calls and the built-in model-backed proposer's
 * cost is NOT measured here. Nothing below is a held-out improvement claim or
 * an independent evaluation.
 *
 * Print the grid with `AX_PRINT_METRICS=1 npx vitest run
 * src/ax/agent/benchmarks/working-state.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  axWorkingStatePromptOverhead,
  renderWorkingStateTable,
} from './workingStateMetrics.js';
import {
  AX_WORKING_STATE_HORIZONS,
  type AxWorkingStateScenarioResult,
  runWorkingStateScenario,
  runWorkingStateSweep,
} from './workingStateScenarios.js';

/**
 * Declared ceiling for the prompt-character overhead the two extra prompt
 * regions cost at the largest measured horizon. Reviewed in the PR body: PR 1
 * ADDS prompt characters (the state document and the roster ride beside the
 * action log). Removing the action-log growth term is PR 2's `skillState`, not
 * this PR's claim.
 */
const PROMPT_OVERHEAD_CEILING = 0.6;

/**
 * Declared ceiling for the pre-existing measurement gap: `contextPressure` is
 * rendered into the sent prompt but is not included in the measured value.
 */
const MEASUREMENT_GAP_CEILING = 0.02;

let sweep: readonly AxWorkingStateScenarioResult[];

const rowsOf = (results: readonly AxWorkingStateScenarioResult[]) =>
  results.map((result) => result.row);

const pick = (horizon: number, arm: 'baseline' | 'working-state') => {
  const found = sweep.find(
    (result) => result.row.horizon === horizon && result.row.arm === arm
  );
  if (!found) throw new Error(`no result for ${arm} at horizon ${horizon}`);
  return found;
};

describe('working-state benchmark', () => {
  beforeAll(async () => {
    sweep = await runWorkingStateSweep();
    if (process.env.AX_PRINT_METRICS === '1') {
      console.log(renderWorkingStateTable(rowsOf(sweep)));
      for (const horizon of AX_WORKING_STATE_HORIZONS) {
        const overhead = axWorkingStatePromptOverhead(rowsOf(sweep), horizon);
        console.log(
          `prompt-char overhead @${horizon}: ${(overhead! * 100).toFixed(1)}%`
        );
      }
    }
  }, 300_000);

  it('A1: a scripted false completion parks and the goal stays pending at every horizon', () => {
    // No claim about the run's REPORT: under the default `observe` policy the
    // gate constrains a side document, not the answer the run returns.
    for (const horizon of AX_WORKING_STATE_HORIZONS) {
      const result = pick(horizon, 'working-state');
      expect([horizon, result.row.falseCompletionsParked >= 1]).toEqual([
        horizon,
        true,
      ]);
      expect([horizon, result.goalStatuses.g_audit]).toEqual([
        horizon,
        'pending',
      ]);
      // The receipt-backed goals in the same run DID complete, so the gate is
      // strict rather than closed.
      expect([horizon, result.row.goalsCompleted > 0]).toEqual([horizon, true]);
    }
  });

  it('A2: with completionPolicy interlock, a final with a pending goal is converted at least once', async () => {
    const interlocked = await runWorkingStateScenario(10, 'working-state', {
      completionPolicy: 'interlock',
    });
    expect(interlocked.interlocksConverted).toBeGreaterThanOrEqual(1);
    expect(interlocked.goalStatuses.g_audit).toBe('pending');
  }, 120_000);

  it('A3: the working-state arm performs zero state-recovery steps at every horizon', () => {
    for (const horizon of AX_WORKING_STATE_HORIZONS) {
      expect([
        horizon,
        pick(horizon, 'working-state').row.stateRecoverySteps,
      ]).toEqual([horizon, 0]);
    }
  });

  it('A4: the baseline performs at least one state-recovery step at horizon 100', () => {
    // Without this the comparison in A3 would be vacuous.
    expect(pick(100, 'baseline').row.stateRecoverySteps).toBeGreaterThanOrEqual(
      1
    );
  });

  it('A5: accuracy at horizon 100 is not worse with working state than without', () => {
    // Asserted only as NOT WORSE. The scenario is authored, so a "better"
    // claim would be measuring the author, not the mechanism.
    expect(pick(100, 'working-state').row.accuracy).toBeGreaterThanOrEqual(
      pick(100, 'baseline').row.accuracy
    );
  });

  it('A6: prompt-character overhead is reported and below the declared ceiling', () => {
    const overhead = axWorkingStatePromptOverhead(rowsOf(sweep), 100);
    expect(overhead).toBeDefined();
    // PR 1 ADDS prompt characters. Measuring and bounding that is the honest
    // form of the claim; asserting a reduction here would be false.
    expect(overhead!).toBeGreaterThan(0);
    expect(overhead!).toBeLessThan(PROMPT_OVERHEAD_CEILING);
  });

  it('A7: two runs produce equal working-state trace digest sequences', async () => {
    const first = await runWorkingStateScenario(10, 'working-state');
    const second = await runWorkingStateScenario(10, 'working-state');
    expect(first.traceDigests.length).toBeGreaterThan(0);
    expect(first.traceDigests).toEqual(second.traceDigests);
  }, 120_000);

  it('A8: the new prompt regions are counted by the budget meter', () => {
    // `budget_check.mutablePromptChars` is the benchmark's headline metric, so
    // it must track the prompt that was actually SENT. It does, to within a
    // small pre-existing gap: `contextPressure` is sent but is not part of the
    // measured value. That gap is bounded here and closing it exactly is PR
    // 2's measured-equals-sent refactor, not this PR's.
    const check = (arm: 'baseline' | 'working-state') => {
      const measured = pick(100, arm).promptCheck!;
      return {
        measured,
        gapRatio:
          (measured.sentTotalChars -
            (measured.measuredMutableChars + measured.measuredFixedChars)) /
          measured.sentTotalChars,
      };
    };

    const baseline = check('baseline');
    const withState = check('working-state');
    expect(baseline.gapRatio).toBeLessThan(MEASUREMENT_GAP_CEILING);
    expect(withState.gapRatio).toBeLessThan(MEASUREMENT_GAP_CEILING);
    // The two new regions land INSIDE the measured mutable window rather than
    // being invisible to it.
    expect(withState.measured.measuredMutableChars).toBeGreaterThan(
      baseline.measured.measuredMutableChars
    );
  });
});
