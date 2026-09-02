/**
 * Benchmark: context-compression baseline sweep.
 *
 * Captures the CURRENT (hindsight) trajectory-compaction behavior of AxAgent
 * across the four shipped `contextPolicy` presets and three fixed scenarios,
 * deterministically and offline (mock AI). This is the baseline a future
 * plan-aware foresight retention strategy is A/B'd against.
 *
 * The sweep is split one test per scenario, and each test runs against a budget
 * measured on the host rather than vitest's fixed 5s default. Every assertion
 * here is scoped to a single scenario, so nothing is lost by the split, and no
 * single test carries the wall-clock cost of all twelve scenario/preset runs.
 * Running all twelve in one test took 1.1s to 2.8s idle against the 5s default,
 * which is not enough headroom on a loaded host: it timed out in 5 of 10 runs.
 *
 * Run `AX_PRINT_METRICS=1 npx vitest run src/ax/agent/benchmarks/context-compression.test.ts`
 * to print the metrics grid.
 */
import { describe, expect, it } from 'vitest';
import {
  type AxContextMetricsRow,
  type AxContextMetricsSummary,
  renderMetricsTable,
} from './contextMetrics.js';
import {
  AX_CONTEXT_PRESETS,
  type AxContextScenario,
  AX_CONTEXT_SCENARIOS,
  runOfflineScenario,
} from './contextScenarios.js';

type Sweep = {
  rows: AxContextMetricsRow[];
  get: (preset: string) => AxContextMetricsSummary;
};

async function sweepScenario(scenario: AxContextScenario): Promise<Sweep> {
  const rows: AxContextMetricsRow[] = [];
  const byPreset = new Map<string, AxContextMetricsSummary>();
  for (const preset of AX_CONTEXT_PRESETS) {
    const summary = await runOfflineScenario(scenario, preset);
    rows.push({ scenario: scenario.name, preset, summary });
    byPreset.set(preset, summary);
  }

  if (process.env.AX_PRINT_METRICS) {
    console.log(`\n${renderMetricsTable(rows)}\n`);
  }

  return {
    rows,
    get: (preset) => {
      const summary = byPreset.get(preset);
      if (!summary) {
        throw new Error(`missing metrics for ${scenario.name}:${preset}`);
      }
      return summary;
    },
  };
}

/** Holds for every scenario: telemetry exists and raw replay never compacts. */
function expectSweepInvariants(sweep: Sweep): void {
  for (const row of sweep.rows) {
    expect(row.summary.turns).toBeGreaterThan(0);
    expect(row.summary.cumulativeTokens).toBeGreaterThan(0);
  }
  // 'full' replays the action log raw, so it never compacts or checkpoints.
  expect(sweep.get('full').compactionRatio).toBe(0);
  expect(sweep.get('full').checkpoints).toBe(0);
}

function scenario(name: string): AxContextScenario {
  const found = AX_CONTEXT_SCENARIOS.find((entry) => entry.name === name);
  if (!found) throw new Error(`unknown scenario ${name}`);
  return found;
}

// A measured budget instead of vitest's fixed 5s default: time one
// scenario/preset run on THIS host, then allow each test 20x that. Every test
// below runs four presets, so the budget carries 5x headroom over its own work
// and scales with however loaded the host is when the file is imported.
const baselineStartedAt = Date.now();
await runOfflineScenario(scenario('long-padded'), 'full');
const BASELINE_RUN_MS = Math.max(1, Date.now() - baselineStartedAt);
const SWEEP_BUDGET_MS = Math.max(5_000, BASELINE_RUN_MS * 20);

describe('context-compression baseline sweep', () => {
  it(
    'captures long-padded metrics across presets',
    async () => {
      const sweep = await sweepScenario(scenario('long-padded'));
      expectSweepInvariants(sweep);

      // Trimming presets keep peak context <= raw 'full'.
      const full = sweep.get('full');
      for (const preset of ['checkpointed', 'adaptive', 'lean']) {
        expect(sweep.get(preset).peakMutablePromptChars).toBeLessThanOrEqual(
          full.peakMutablePromptChars
        );
      }
      // ...and at least one trimming preset actually checkpoints under pressure.
      const trimmingCheckpoints = (
        ['checkpointed', 'adaptive', 'lean'] as const
      )
        .map((preset) => sweep.get(preset).checkpoints)
        .reduce((sum, count) => sum + count, 0);
      expect(trimmingCheckpoints).toBeGreaterThan(0);
      // The core thesis: the most aggressive preset strictly beats raw replay,
      // and compaction is actually happening (non-zero chars removed).
      expect(sweep.get('lean').peakMutablePromptChars).toBeLessThan(
        full.peakMutablePromptChars
      );
      expect(sweep.get('checkpointed').compactionRatio).toBeGreaterThan(0);
    },
    SWEEP_BUDGET_MS
  );

  it(
    'captures short-clean metrics across presets',
    async () => {
      const sweep = await sweepScenario(scenario('short-clean'));
      expectSweepInvariants(sweep);

      // No pressure means no checkpoints under any preset.
      for (const preset of AX_CONTEXT_PRESETS) {
        expect(sweep.get(preset).checkpoints).toBe(0);
      }
    },
    SWEEP_BUDGET_MS
  );

  it(
    'captures error-recovery metrics across presets',
    async () => {
      const sweep = await sweepScenario(scenario('error-recovery'));
      expectSweepInvariants(sweep);

      // An errorPruning preset (lean) tombstones the resolved error.
      expect(sweep.get('lean').tombstones).toBeGreaterThan(0);
    },
    SWEEP_BUDGET_MS
  );

  it('covers every declared scenario', () => {
    expect(AX_CONTEXT_SCENARIOS.map((entry) => entry.name).sort()).toEqual([
      'error-recovery',
      'long-padded',
      'short-clean',
    ]);
  });
});
