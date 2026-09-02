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
  axWorkingStatePromptGrowth,
  axWorkingStatePromptOverhead,
  renderWorkingStateTable,
} from './workingStateMetrics.js';
import {
  AX_WORKING_STATE_BENCH_HORIZONS,
  type AxWorkingStateScenarioResult,
  AX_WORKING_STATE_BENCH_MAX_HORIZON as MAX_HORIZON,
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

/**
 * Declared ceiling for the `skill-state` arm's per-turn dynamic-tail growth
 * between the two largest measured horizons. It is NOT 1.0: the scenario's
 * goal ledger grows with the number of orders, which is a TASK-SIZE term the
 * mode does not remove and does not claim to. The term the mode removes is the
 * TRANSCRIPT, which is why the assertion below is relative to the two
 * transcript arms as well.
 *
 * Measured 1.73 against 2.40 (`working-state`) and 2.95 (`baseline`), so the
 * ceiling leaves ~7% headroom rather than the 16% a `2.0` ceiling left — at
 * 2.0 a `skill-state` arm that had regressed to 1.9 would still have passed
 * while a baseline sat at 1.95.
 */
const SKILL_STATE_GROWTH_CEILING = 1.85;

/**
 * Declared margin by which the `skill-state` slope must beat the
 * `working-state` slope. The two arms carry the SAME state document, so the
 * only difference between them is the transcript: an arm that merely tied
 * would mean the transcript term had come back.
 */
const SKILL_STATE_GROWTH_MARGIN = 0.85;

/**
 * Declared ceiling on the `skill-state` arm's model calls ABOVE its executor
 * turn count. Measured 2 at every horizon (12/10, 27/25, 62/60): the run's
 * non-executor-turn calls do not scale with the horizon, because no checkpoint
 * summarizer runs and no turn is spent re-deriving known state. A regression
 * that let the summarizer back in reads 90 calls for 60 turns.
 */
const SKILL_STATE_MODEL_CALL_SLACK = 3;

let sweep: readonly AxWorkingStateScenarioResult[];

const rowsOf = (results: readonly AxWorkingStateScenarioResult[]) =>
  results.map((result) => result.row);

const pick = (
  horizon: number,
  arm: 'baseline' | 'working-state' | 'skill-state'
) => {
  const found = sweep.find(
    (result) => result.row.horizon === horizon && result.row.arm === arm
  );
  if (!found) throw new Error(`no result for ${arm} at horizon ${horizon}`);
  return found;
};

describe('working-state benchmark', () => {
  beforeAll(async () => {
    sweep = await runWorkingStateSweep(AX_WORKING_STATE_BENCH_HORIZONS);
    if (process.env.AX_PRINT_METRICS === '1') {
      console.log(renderWorkingStateTable(rowsOf(sweep)));
      for (const horizon of AX_WORKING_STATE_BENCH_HORIZONS) {
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
    for (const horizon of AX_WORKING_STATE_BENCH_HORIZONS) {
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
    for (const horizon of AX_WORKING_STATE_BENCH_HORIZONS) {
      expect([
        horizon,
        pick(horizon, 'working-state').row.stateRecoverySteps,
      ]).toEqual([horizon, 0]);
    }
  });

  it('A4: the baseline performs at least one state-recovery step at the largest measured horizon', () => {
    // Without this the comparison in A3 would be vacuous.
    expect(
      pick(MAX_HORIZON, 'baseline').row.stateRecoverySteps
    ).toBeGreaterThanOrEqual(1);
  });

  it('A5: accuracy at the largest measured horizon is not worse with working state than without', () => {
    // Asserted only as NOT WORSE. The scenario is authored, so a "better"
    // claim would be measuring the author, not the mechanism.
    expect(
      pick(MAX_HORIZON, 'working-state').row.accuracy
    ).toBeGreaterThanOrEqual(pick(MAX_HORIZON, 'baseline').row.accuracy);
  });

  it('A6: prompt-character overhead is reported and below the declared ceiling', () => {
    const overhead = axWorkingStatePromptOverhead(rowsOf(sweep), MAX_HORIZON);
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

  it('A9: the skillState substrate grows more slowly than either transcript arm', () => {
    // Measured on the MUTABLE tail: `meanPromptCharsPerTurn` folds in a large
    // constant system prompt that dilutes every slope.
    const growth = (arm: 'baseline' | 'working-state' | 'skill-state') =>
      axWorkingStatePromptGrowth(rowsOf(sweep), arm, 25, MAX_HORIZON)!;

    const baseline = growth('baseline');
    const workingState = growth('working-state');
    const skillState = growth('skill-state');

    // The comparison is not vacuous: both transcript arms genuinely grow.
    expect(baseline).toBeGreaterThan(1.5);
    expect(workingState).toBeGreaterThan(1.5);
    // The mode removes the transcript growth term while carrying the SAME
    // state document as the `working-state` arm.
    expect(skillState).toBeLessThan(baseline);
    expect(skillState).toBeLessThan(workingState * SKILL_STATE_GROWTH_MARGIN);
    expect(skillState).toBeLessThan(SKILL_STATE_GROWTH_CEILING);
  });

  it('A10: skillState sends a smaller dynamic tail and makes fewer model calls', () => {
    const skillState = pick(MAX_HORIZON, 'skill-state').row;
    const workingState = pick(MAX_HORIZON, 'working-state').row;
    const baseline = pick(MAX_HORIZON, 'baseline').row;

    // Same document, no transcript: roughly half the dynamic tail.
    expect(skillState.meanMutableCharsPerTurn).toBeLessThan(
      workingState.meanMutableCharsPerTurn
    );
    expect(skillState.peakPromptChars).toBeLessThan(baseline.peakPromptChars);
    // Fewer model calls than EITHER transcript arm: no checkpoint
    // summarization runs, and no turn is spent re-deriving known state.
    expect(skillState.modelCalls).toBeLessThan(workingState.modelCalls);
    expect(skillState.modelCalls).toBeLessThan(baseline.modelCalls);
  });

  it('A10b: skillState model calls track its turn count at every horizon', () => {
    // "Fewer than the other arms" is too loose to protect the headline number:
    // with all three §7.4.1 cost guards removed the arm regresses 62 -> 90 at
    // horizon 60 and still beats `working-state`'s 111. Tying model calls to
    // TURNS instead catches that, because the extra calls a returning
    // checkpoint summarizer makes scale with the horizon and the run's own
    // non-turn calls do not.
    for (const horizon of AX_WORKING_STATE_BENCH_HORIZONS) {
      const row = pick(horizon, 'skill-state').row;
      // Not vacuous: the arm really took a turn per scenario step, so the
      // bound below is measured against real work rather than a short run.
      expect([horizon, row.turns]).toEqual([horizon, horizon]);
      expect([horizon, row.modelCalls]).toEqual([
        horizon,
        Math.min(row.modelCalls, row.turns + SKILL_STATE_MODEL_CALL_SLACK),
      ]);
    }
    // ...and the bound is a real discriminator: the transcript arm at the
    // largest horizon fails it.
    const transcript = pick(MAX_HORIZON, 'working-state').row;
    expect(
      transcript.modelCalls > transcript.turns + SKILL_STATE_MODEL_CALL_SLACK
    ).toBe(true);
  });

  it('A11: skillState keeps the gate and the accuracy of the transcript arms', () => {
    for (const horizon of AX_WORKING_STATE_BENCH_HORIZONS) {
      const skillState = pick(horizon, 'skill-state');
      const workingState = pick(horizon, 'working-state');
      // The receipt gate is a property of the kernel, not of the substrate.
      expect([horizon, skillState.row.falseCompletionsParked >= 1]).toEqual([
        horizon,
        true,
      ]);
      expect([horizon, skillState.goalStatuses.g_audit]).toEqual([
        horizon,
        'pending',
      ]);
      // Same goals closed, no recovery turns, accuracy not worse — with the
      // transcript discarded.
      expect([horizon, skillState.row.goalsCompleted]).toEqual([
        horizon,
        workingState.row.goalsCompleted,
      ]);
      expect([horizon, skillState.row.stateRecoverySteps]).toEqual([
        horizon,
        0,
      ]);
      expect([
        horizon,
        skillState.row.accuracy >= pick(horizon, 'baseline').row.accuracy,
      ]).toEqual([horizon, true]);
    }
  });

  it('A8: the new prompt regions are counted by the budget meter', () => {
    // `budget_check.mutablePromptChars` is the benchmark's headline metric, so
    // it must track the prompt that was actually SENT. It does, to within a
    // small pre-existing gap: `contextPressure` is sent but is not part of the
    // measured value. That gap is bounded here and closing it exactly is PR
    // 2's measured-equals-sent refactor, not this PR's.
    const check = (arm: 'baseline' | 'working-state') => {
      const measured = pick(MAX_HORIZON, arm).promptCheck!;
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
