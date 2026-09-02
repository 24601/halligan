/**
 * Per-cell transfer for `agent.playbook().evolve()` (RFC B2 §4.6, §7.1 phases
 * 3 and 8).
 *
 * One cell per (target, split). Each cell carries its own anchor score, its own
 * candidate score, its own delta and its own paired interval, and there is
 * DELIBERATELY no average anywhere in this file or in the report it builds: an
 * average is exactly what hides a single catastrophic cell, which is the whole
 * reason per-cell reporting exists. `playbookEvidence.test-d.ts` pins the
 * absence at the type level; `playbookTransfer.test.ts` pins it at runtime.
 *
 * The anchor pass runs BEFORE any mutation (phase 3), on the same unevolved
 * artifact the run started from, so a cell's anchor is never borrowed from the
 * primary model's baseline — a different backbone scores the same artifact
 * differently, and comparing a target's candidate score against the primary's
 * anchor would attribute the model gap to the playbook.
 *
 * Fail-closed direction: a target that could not be evaluated at all makes the
 * whole report `not_run` with the reason, and a cell whose evaluation was
 * incomplete makes the report `partial` and fails a required gate. A report
 * that cannot be read is never a pass.
 */

import type { AxAIService } from '../../../ai/types.js';
import type { AxGenIn, AxGenOut } from '../../../dsp/types.js';
import type { AxAgentEvalTask } from '../agentOptimizeTypes.js';
import type { AxAgentEvalBatchResult } from './evalHarness.js';
import type {
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookModelIdentity,
  AxAgentPlaybookSplitScore,
  AxAgentPlaybookTransferCell,
  AxAgentPlaybookTransferOptions,
  AxAgentPlaybookTransferReport,
  AxAgentPlaybookTransferTarget,
} from './playbookEvidenceTypes.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import type { AxPairedRecord } from './statistics.js';
import {
  clustersFromPairedRecords,
  pairedBootstrapInterval,
} from './statistics.js';
import { modelIdentityOf } from './termination.js';

/** §4.6: per-cell regression floor. */
export const DEFAULT_TRANSFER_REGRESSION_FLOOR = 0.02;

export type AxTransferSplit = 'current' | 'heldOut';

/** `${targetId}:${split}` — the key `regressedCells` reports. */
export function transferCellKey(
  targetId: string,
  split: AxTransferSplit
): string {
  return `${targetId}:${split}`;
}

/**
 * §4.6: `['heldOut']` by default, or `['current']` when the caller supplied no
 * validation set. An explicit `splits` is honoured verbatim and validated.
 */
export function transferSplitsOf(
  options: Readonly<AxAgentPlaybookTransferOptions>,
  hasHeldOut: boolean
): readonly AxTransferSplit[] {
  if (options.splits !== undefined) return options.splits;
  return hasHeldOut ? ['heldOut'] : ['current'];
}

function fail(message: string): never {
  throw new AxAgentPlaybookEvolveError(
    'transfer_target_invalid',
    'transfer',
    message
  );
}

/**
 * Every transfer misconfiguration, rejected BEFORE any mutation (§6). Blank and
 * duplicate ids are the two that matter most: Ax never derives a cell label
 * from `AxAIService.getId()`, so a blank id produces an unattributable cell and
 * a duplicate silently overwrites one target's results with another's.
 */
export function validateTransferOptions(
  options: Readonly<AxAgentPlaybookTransferOptions>,
  hasHeldOut: boolean
): void {
  if (!Array.isArray(options.targets) || options.targets.length === 0) {
    fail('transfer.targets must name at least one target.');
  }
  const seen = new Set<string>();
  for (const [index, target] of options.targets.entries()) {
    if (!target || typeof target !== 'object') {
      fail(`transfer.targets[${index}] is not a target object.`);
    }
    const id = typeof target.id === 'string' ? target.id.trim() : '';
    if (!id) {
      fail(
        `transfer.targets[${index}] has no id; Ax never derives a cell label from the service instance, so every target needs a stable caller-owned id.`
      );
    }
    if (seen.has(id)) {
      fail(
        `transfer.targets[${index}] repeats the id '${id}'; cell labels must be unique or one target's cells overwrite another's.`
      );
    }
    seen.add(id);
    if (!target.ai || typeof target.ai !== 'object') {
      fail(`transfer.targets[${index}] ('${id}') has no ai service.`);
    }
    if (
      target.evaluatorId !== undefined &&
      typeof target.evaluatorId !== 'string'
    ) {
      fail(
        `transfer.targets[${index}] ('${id}') has a non-string evaluatorId.`
      );
    }
  }
  if (options.splits !== undefined) {
    if (options.splits.length === 0) {
      fail('transfer.splits must name at least one split.');
    }
    for (const split of options.splits) {
      if (split !== 'current' && split !== 'heldOut') {
        fail(`transfer.splits contains an unknown split '${String(split)}'.`);
      }
    }
  }
  if (
    transferSplitsOf(options, hasHeldOut).includes('heldOut') &&
    !hasHeldOut
  ) {
    fail(
      'transfer.splits names heldOut but the dataset has no validation set; a held-out cell with no held-out tasks measures nothing.'
    );
  }
  if (options.regressionFloor !== undefined) {
    if (
      !Number.isFinite(options.regressionFloor) ||
      options.regressionFloor < 0
    ) {
      fail('transfer.regressionFloor must be a finite non-negative number.');
    }
  }
  if (options.maxMetricCalls !== undefined) {
    if (
      !Number.isSafeInteger(options.maxMetricCalls) ||
      options.maxMetricCalls <= 0
    ) {
      fail('transfer.maxMetricCalls must be a positive safe integer.');
    }
  }
}

/**
 * The full cost of the matrix: anchor pass (phase 3) plus candidate pass
 * (phase 8), for every target and every split. Read before any mutation so an
 * insufficient `maxMetricCalls` fails closed instead of producing half a
 * matrix.
 */
export function transferRequiredMetricCalls(args: {
  targetCount: number;
  splits: readonly AxTransferSplit[];
  trainCount: number;
  heldOutCount: number;
  runsPerTask: number;
}): number {
  const perPass = args.splits.reduce(
    (sum, split) =>
      sum + (split === 'current' ? args.trainCount : args.heldOutCount),
    0
  );
  return perPass * args.runsPerTask * args.targetCount * 2;
}

export function splitScoreOfBatch(
  batch: Readonly<AxAgentEvalBatchResult<any, any>>
): AxAgentPlaybookSplitScore {
  return {
    mean: batch.mean,
    executedRuns: batch.executedRuns,
    discardedRuns: batch.discardedRuns,
    expectedRuns: batch.expectedRuns,
    complete: batch.complete,
  };
}

/** One evaluated (target, split) pass. */
export type AxTransferPass = Readonly<{
  targetId: string;
  split: AxTransferSplit;
  score: AxAgentPlaybookSplitScore;
  records: readonly AxPairedRecord[];
  model?: AxAgentPlaybookModelIdentity;
}>;

export type AxTransferEvaluate<
  IN extends AxGenIn,
  OUT extends AxGenOut,
> = (args: {
  target: Readonly<AxAgentPlaybookTransferTarget>;
  ai: Readonly<AxAIService>;
  split: AxTransferSplit;
  tasks: readonly AxAgentEvalTask<IN>[];
}) => Promise<AxAgentEvalBatchResult<IN, OUT>>;

/**
 * Run one pass of the matrix against whatever artifact is currently live. The
 * caller decides which artifact that is — phase 3 calls this before any
 * mutation, phase 8 after the curate and prune loops.
 *
 * Sequential on purpose: `_forwardForEvaluation` saves and restores agent state
 * around every call, so concurrent target evaluations on one agent instance
 * would interleave those save/restore pairs.
 */
export async function runTransferPass<
  IN extends AxGenIn,
  OUT extends AxGenOut,
>(args: {
  targets: readonly AxAgentPlaybookTransferTarget[];
  splits: readonly AxTransferSplit[];
  tasksFor: (split: AxTransferSplit) => readonly AxAgentEvalTask<IN>[];
  evaluate: AxTransferEvaluate<IN, OUT>;
}): Promise<readonly AxTransferPass[]> {
  const passes: AxTransferPass[] = [];
  for (const target of args.targets) {
    for (const split of args.splits) {
      const tasks = args.tasksFor(split);
      const batch = await args.evaluate({
        target,
        ai: target.ai,
        split,
        tasks,
      });
      const model = modelIdentityOf(batch.usage);
      passes.push({
        targetId: target.id,
        split,
        score: splitScoreOfBatch(batch),
        records: batch.records.map((record) => ({
          task: record.task as object,
          score: record.score,
        })),
        ...(model ? { model } : {}),
      });
    }
  }
  return passes;
}

const keyOf = (pass: AxTransferPass) =>
  transferCellKey(pass.targetId, pass.split);

/**
 * Pair the two passes into cells. A cell is emitted for every (target, split)
 * that produced BOTH an anchor and a candidate pass; a pair whose per-task
 * records cannot be aligned still yields a cell, with an interval that says
 * `clusters: 0` rather than a fabricated zero-width one, and the verdict reads
 * that as unmeasured.
 */
export function transferCellsFrom(args: {
  anchors: readonly AxTransferPass[];
  candidates: readonly AxTransferPass[];
  floor: number;
  seedFor: (split: AxTransferSplit) => number;
  resamples: number;
  level: number;
  weightOf?: (task: any) => number;
}): readonly AxAgentPlaybookTransferCell[] {
  const anchorByKey = new Map(args.anchors.map((pass) => [keyOf(pass), pass]));
  const cells: AxAgentPlaybookTransferCell[] = [];
  for (const candidate of args.candidates) {
    const anchor = anchorByKey.get(keyOf(candidate));
    if (!anchor) continue;
    const clusters = clustersFromPairedRecords(
      anchor.records,
      candidate.records,
      args.weightOf
    );
    const delta = candidate.score.mean - anchor.score.mean;
    const interval =
      clusters &&
      pairedBootstrapInterval({
        clusters,
        seed: args.seedFor(candidate.split),
        resamples: args.resamples,
        level: args.level,
      });
    const model = candidate.model ?? anchor.model;
    cells.push({
      targetId: candidate.targetId,
      split: candidate.split,
      anchor: anchor.score,
      candidate: candidate.score,
      delta,
      interval: interval ?? {
        point: delta,
        lower: delta,
        upper: delta,
        level: args.level,
        resamples: 0,
        unit: 'task',
        clusters: 0,
        seed: args.seedFor(candidate.split),
        direction: 'unresolved',
      },
      // Strictly beyond the floor. A delta exactly at `-floor` is the tolerance
      // the caller declared acceptable, not a regression.
      regressed: delta < -args.floor,
      ...(model ? { model } : {}),
    });
  }
  return cells;
}

/**
 * Assemble the report. `partial` means at least one cell is not a complete
 * measurement — a required gate fails closed on it — and `completed` means
 * every cell is a whole-split reading with a computed interval.
 */
export function transferReportFrom(args: {
  floor: number;
  cells: readonly AxAgentPlaybookTransferCell[];
  accounting: AxAgentPlaybookComputeAccounting;
  expectedCells: number;
}): AxAgentPlaybookTransferReport {
  const complete =
    args.cells.length === args.expectedCells &&
    args.cells.every(
      (cell) =>
        cell.anchor.complete &&
        cell.candidate.complete &&
        cell.interval.clusters > 0
    );
  return {
    status: complete ? 'completed' : 'partial',
    floor: args.floor,
    cells: args.cells,
    regressedCells: args.cells
      .filter((cell) => cell.regressed)
      .map((cell) => transferCellKey(cell.targetId, cell.split)),
    accounting: args.accounting,
  };
}

/**
 * Why a report that carries cells still carries no reading a gate may trust.
 *
 * The fail-open direction here is the dangerous one: a cell whose candidate
 * pass ran out of budget has a `mean` over a prefix of the split, and a prefix
 * mean that happens to be high would let a regressing target PASS. So an
 * incomplete cell is named, not silently accepted.
 */
function unmeasuredReason(
  report: Readonly<
    Extract<AxAgentPlaybookTransferReport, { status: 'partial' | 'completed' }>
  >
): string | undefined {
  if (report.cells.length === 0) {
    return 'the transfer matrix carries no cell at all, so no target was measured';
  }
  for (const cell of report.cells) {
    const key = transferCellKey(cell.targetId, cell.split);
    if (!cell.anchor.complete) {
      return `transfer cell ${key} has an incomplete anchor pass (${cell.anchor.executedRuns}/${cell.anchor.expectedRuns} run(s), ${cell.anchor.discardedRuns} discarded)`;
    }
    if (!cell.candidate.complete) {
      return `transfer cell ${key} has an incomplete candidate pass (${cell.candidate.executedRuns}/${cell.candidate.expectedRuns} run(s), ${cell.candidate.discardedRuns} discarded)`;
    }
    if (cell.interval.clusters === 0) {
      return `transfer cell ${key} could not pair a single task between its anchor and candidate passes, so its interval was never computed`;
    }
  }
  if (report.status === 'partial') {
    // Every present cell reads clean, so `partial` can only mean a PLANNED cell
    // produced no reading at all. Without this branch a matrix missing exactly
    // the target that broke would pass a required gate on the targets that did
    // not — the fail-open direction, and the one that favours the artifact.
    return `the transfer matrix is partial: at least one planned (target, split) cell produced no reading, and the ${report.cells.length} cell(s) present cannot stand in for it`;
  }
  return undefined;
}

/**
 * True when the matrix carries a comparison that was actually measured.
 * Distinguishes "a cell regressed" from "there was no cell reading to judge",
 * which is the difference between `transfer_cell_regressed` and
 * `transfer_unmeasured`.
 */
export function transferComparisonMade(
  report: Readonly<AxAgentPlaybookTransferReport>
): boolean {
  if (report.status === 'not_run') return false;
  return unmeasuredReason(report) === undefined;
}

/**
 * The RUN-LEVEL verdict. NO average is computed here, on purpose: a matrix
 * whose cells are `+0.50` and `-0.36` has a positive average and a target that
 * got materially worse, and the second fact is the one that decides.
 */
export function transferVerdict(args: {
  report: Readonly<AxAgentPlaybookTransferReport>;
}): Readonly<{ passed: boolean; detail: string }> {
  const { report } = args;
  if (report.status === 'not_run') {
    return {
      passed: false,
      detail: `transfer did not run: ${report.reason}`,
    };
  }
  const unmeasured = unmeasuredReason(report);
  if (unmeasured) {
    return {
      passed: false,
      detail: `${unmeasured}; a required gate cannot read an absent cell, so it fails closed`,
    };
  }
  if (report.regressedCells.length > 0) {
    const worst = [...report.cells]
      .filter((cell) => cell.regressed)
      .sort((a, b) => a.delta - b.delta)[0]!;
    return {
      passed: false,
      detail: `${report.regressedCells.length} of ${report.cells.length} transfer cell(s) regressed beyond the ${report.floor} floor: ${report.regressedCells.join(', ')}; worst ${transferCellKey(worst.targetId, worst.split)} ${worst.delta.toFixed(3)} (no average is reported: an average of these cells would hide it)`,
    };
  }
  return {
    passed: true,
    detail: `all ${report.cells.length} transfer cell(s) stayed within the ${report.floor} regression floor`,
  };
}
