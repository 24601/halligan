/**
 * Runnable evaluation for verifier-gated working state and the `skillState`
 * memory mode (Track B5 PRs 1 and 2).
 *
 * Runs the same deterministic sweep the vitest benchmark asserts, prints the
 * grid, and writes `artifacts/working-state-eval.json` as the PR's evidence
 * artifact. Zero API keys, zero cost, zero network.
 *
 * MECHANISM EVIDENCE, NOT MODEL QUALITY. The AI is a deterministic mock, the
 * scenario is a state machine (close to a best case for state-as-substrate),
 * and the proposer is a deterministic host callback — so the built-in
 * model-backed proposer's cost is NOT measured here. Nothing in the emitted
 * JSON is a held-out improvement claim or an independent evaluation.
 *
 * Paired with `scripts/eval-working-state.test.ts`, which is wired into the
 * root `npm test` chain so this evidence cannot silently rot.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  axWorkingStatePromptGrowth,
  axWorkingStatePromptOverhead,
  renderWorkingStateTable,
} from '../src/ax/agent/benchmarks/workingStateMetrics.js';
import {
  AX_WORKING_STATE_HORIZONS,
  runWorkingStateScenario,
  runWorkingStateSweep,
} from '../src/ax/agent/benchmarks/workingStateScenarios.js';

export const AX_WORKING_STATE_EVAL_ARTIFACT =
  'artifacts/working-state-eval.json';

export async function runWorkingStateEvaluation() {
  const sweep = await runWorkingStateSweep();
  const rows = sweep.map((result) => result.row);
  const interlocked = await runWorkingStateScenario(10, 'working-state', {
    completionPolicy: 'interlock',
  });
  const repeat = await runWorkingStateScenario(10, 'working-state');
  const first = sweep.find(
    (result) => result.row.horizon === 10 && result.row.arm === 'working-state'
  );

  return {
    kind: 'deterministic-mechanism-characterization' as const,
    independentModelHeldOut: false,
    claim:
      'A goal flips to done only on a harness-minted tool receipt; a receipt-free completion claim parks visibly, and a run carrying the state document needs no state-recovery turns. Under `actorMemoryMode: "skillState"` the same document is carried WITHOUT the transcript, so the per-turn dynamic tail grows more slowly than either transcript arm and fewer model calls are made.',
    baseline:
      'The same transcript actor loop at the same horizons with `workingState` unset (`baseline`), and the transcript loop WITH working state beside it (`working-state`).',
    horizons: [...AX_WORKING_STATE_HORIZONS],
    arms: ['baseline', 'working-state', 'skill-state'] as const,
    rows,
    promptOverheadByHorizon: Object.fromEntries(
      AX_WORKING_STATE_HORIZONS.map((horizon) => [
        String(horizon),
        axWorkingStatePromptOverhead(rows, horizon) ?? null,
      ])
    ),
    // The SLOPE of the dynamic tail between the two largest horizons, per arm.
    // Slope rather than totals: the totals depend on the mock's content sizes,
    // the slope depends on the mechanism.
    mutableTailGrowth: Object.fromEntries(
      (['baseline', 'working-state', 'skill-state'] as const).map((arm) => [
        arm,
        axWorkingStatePromptGrowth(
          rows,
          arm,
          AX_WORKING_STATE_HORIZONS[AX_WORKING_STATE_HORIZONS.length - 2]!,
          AX_WORKING_STATE_HORIZONS[AX_WORKING_STATE_HORIZONS.length - 1]!
        ) ?? null,
      ])
    ),
    completionInterlock: {
      converted: interlocked.interlocksConverted,
      auditGoalStatus: interlocked.goalStatuses.g_audit ?? null,
    },
    determinism: {
      traceSteps: first?.traceDigests.length ?? 0,
      digestsEqualAcrossRuns:
        JSON.stringify(first?.traceDigests ?? []) ===
        JSON.stringify(repeat.traceDigests),
    },
    negativeResults: [
      'This is mechanism evidence, not model quality: the AI is a deterministic mock and the scenario is a state machine, which is close to a best case for state-as-substrate.',
      'Working state alone ADDS prompt characters rather than removing them — the state document and the receipt roster ride beside the action log. Only `actorMemoryMode: "skillState"` removes the action-log growth term.',
      'The `skill-state` arm still GROWS with the horizon in this scenario, because the scenario seeds one goal per order: the goal ledger is a TASK-SIZE term the mode does not remove and does not claim to. The term it removes is the transcript, which is why the growth numbers are reported per arm rather than as an absolute flatness claim.',
      '`cumulativeTokens` counts the actor and responder usage the mock reports; it does NOT count the checkpoint-summarizer calls the transcript arms make. `modelCalls` is the honest cost proxy here, and it is the column on which the `skill-state` arm is compared.',
      'The proposer here is a deterministic host callback, so the arms make comparable model calls. A host using the built-in model-backed proposer pays one extra model call per changed turn, which this evaluation does not measure.',
      'Accuracy is asserted only as NOT WORSE. The scenario is authored, so a "better" claim would be measuring the author rather than the mechanism.',
      'Under the default `completionPolicy: "observe"`, working state does NOT gate the run\'s report: a ledger with pending goals does not stop a final().',
      'A host that enables `allowModelAuthoredGoals` with a broad `expectsAllowlist` can still be farmed inside that allowlist.',
    ],
  };
}

if (process.argv[1]?.endsWith('eval-working-state.ts')) {
  const report = await runWorkingStateEvaluation();
  console.log(renderWorkingStateTable(report.rows));
  for (const [horizon, overhead] of Object.entries(
    report.promptOverheadByHorizon
  )) {
    console.log(
      `prompt-char overhead @${horizon}: ${
        overhead === null ? 'n/a' : `${(overhead * 100).toFixed(1)}%`
      }`
    );
  }
  for (const [arm, growth] of Object.entries(report.mutableTailGrowth)) {
    console.log(
      `mutable-tail growth ${arm}: ${
        growth === null ? 'n/a' : `${growth.toFixed(2)}x`
      }`
    );
  }
  const outPath = resolve(process.cwd(), AX_WORKING_STATE_EVAL_ARTIFACT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${AX_WORKING_STATE_EVAL_ARTIFACT}`);
}
