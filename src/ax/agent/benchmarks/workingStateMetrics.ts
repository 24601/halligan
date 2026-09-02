/**
 * Metric row and table renderer for the working-state benchmark.
 *
 * Mirrors `contextMetrics.ts`: a plain row type, a pure aggregator, and a
 * fixed-width table printed under `AX_PRINT_METRICS=1`. No policy logic lives
 * here — the aggregator must stay arm-agnostic so a future arm can be added
 * without touching it.
 *
 * Internal benchmark helper — NOT exported from `src/ax/index.ts`.
 */

/** The two arms PR 1 measures: the transcript loop with and without state. */
export type AxWorkingStateArm = 'baseline' | 'working-state';

export type AxWorkingStateBenchRow = {
  horizon: number;
  arm: AxWorkingStateArm;
  /** Executor turns the run actually took (recovery turns included). */
  turns: number;
  /** Model calls the run made. The deterministic proposer makes none. */
  modelCalls: number;
  cumulativeTokens: number;
  peakPromptChars: number;
  meanPromptCharsPerTurn: number;
  /**
   * Turns spent re-deriving a fact the run already knew, because the prompt
   * did not carry it. Counted from what the prompt actually contained, never
   * from which arm is running.
   */
  stateRecoverySteps: number;
  goalsCompleted: number;
  falseCompletionsParked: number;
  /** Fraction of state probes answered correctly. */
  accuracy: number;
};

/** Collects `budget_check` prompt sizes for one run. */
export class AxWorkingStatePromptMeter {
  private readonly mutableChars: number[] = [];
  private readonly totalChars: number[] = [];

  public readonly onEvent = (event: {
    kind: string;
    stage?: string;
    mutablePromptChars?: number;
    fixedPromptChars?: number;
  }): void => {
    if (event.kind !== 'budget_check' || event.stage !== 'executor') return;
    this.mutableChars.push(event.mutablePromptChars ?? 0);
    this.totalChars.push(
      (event.mutablePromptChars ?? 0) + (event.fixedPromptChars ?? 0)
    );
  };

  public samples(): number {
    return this.totalChars.length;
  }

  public peak(): number {
    return this.totalChars.length === 0 ? 0 : Math.max(...this.totalChars);
  }

  public mean(): number {
    if (this.totalChars.length === 0) return 0;
    const sum = this.totalChars.reduce((total, value) => total + value, 0);
    return Math.round(sum / this.totalChars.length);
  }

  public mutableAt(index: number): number | undefined {
    return this.mutableChars[index];
  }

  public totalAt(index: number): number | undefined {
    return this.totalChars[index];
  }
}

/** Mean prompt chars per turn, arm over arm, as a growth factor. */
export function axWorkingStatePromptOverhead(
  rows: readonly AxWorkingStateBenchRow[],
  horizon: number
): number | undefined {
  const baseline = rows.find(
    (row) => row.horizon === horizon && row.arm === 'baseline'
  );
  const withState = rows.find(
    (row) => row.horizon === horizon && row.arm === 'working-state'
  );
  if (!baseline || !withState || baseline.meanPromptCharsPerTurn === 0) {
    return undefined;
  }
  return withState.meanPromptCharsPerTurn / baseline.meanPromptCharsPerTurn - 1;
}

const COLUMNS: readonly (keyof AxWorkingStateBenchRow)[] = [
  'horizon',
  'arm',
  'turns',
  'modelCalls',
  'cumulativeTokens',
  'peakPromptChars',
  'meanPromptCharsPerTurn',
  'stateRecoverySteps',
  'goalsCompleted',
  'falseCompletionsParked',
  'accuracy',
];

/** Fixed-width grid, printed under `AX_PRINT_METRICS=1`. */
export function renderWorkingStateTable(
  rows: readonly AxWorkingStateBenchRow[]
): string {
  const header = COLUMNS.map((column) => String(column));
  const body = rows.map((row) =>
    COLUMNS.map((column) => {
      const value = row[column];
      return typeof value === 'number' && !Number.isInteger(value)
        ? value.toFixed(2)
        : String(value);
    })
  );
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index]!.length))
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ');
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...body.map(line),
  ].join('\n');
}
