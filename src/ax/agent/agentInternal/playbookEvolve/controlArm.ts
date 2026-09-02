/**
 * The matched-budget control arm for `agent.playbook().evolve()`.
 *
 * `arXiv:2607.12227` reports that automatic harness evolution did NOT
 * consistently outperform simple test-time scaling under comparable budgets.
 * Nothing in the pre-evidence loop could have detected that: a candidate was
 * compared against a one-shot baseline of itself, so "the evolved playbook
 * scores higher" and "spending the same compute on more samples scores higher"
 * were indistinguishable.
 *
 * Three arms run on the UNEVOLVED program (restored by the snapshot state
 * machine, `snapshots.ts`) at the evolution run's own accounted budget:
 *
 *   best_of_n     N independent samples per task, the best one selected. The
 *                 selector is the SCORING METRIC, which makes this an
 *                 oracle-strong upper bound on test-time scaling — deliberately
 *                 stronger than anything deployable, because it makes the
 *                 evolved artifact's claim harder, not easier. The strength is
 *                 recorded structurally on every arm (`selector`) so it cannot
 *                 be lost when a number is copied into a PR body.
 *   self_refine   one sample, then R rounds re-invoking the SAME program with
 *                 its own previous answer plus a fixed critique instruction.
 *   harness_term  the evolved plumbing with a CONTENT-FREE artifact of the same
 *                 rendered size in the playbook slot. It is the only arm that
 *                 separates "this bullet helped" from "any text in that slot
 *                 helped", it is the cheapest of the three, and it is in the
 *                 default list for exactly that reason: making the most
 *                 informative arm opt-in would make it the one nobody runs.
 *
 * Budget honesty (invariant I6): the arm draws from a SEPARATE counter, so it
 * can never starve the run, and its consumption still lands in
 * `accounting.metricCalls`, so the honest run total includes it. Those two are
 * not in tension — the first is about starvation, the second about honesty.
 * The ceiling is read from the legacy `metricCallsUsed` at the instant the
 * curate loop ends, before the arm spends anything, so the matching is not
 * circular.
 */

import {
  estimateTokenCount,
  renderPlaybook,
} from '../../../dsp/optimizers/acePlaybook.js';
import type {
  AxACEBullet,
  AxACEPlaybook,
} from '../../../dsp/optimizers/aceTypes.js';
import type { AxGenIn, AxGenOut, AxProgramUsage } from '../../../dsp/types.js';
import type { AxAgentEvalTask } from '../agentOptimizeTypes.js';
import { phaseAccounting } from './accounting.js';
import { canonicalDigest } from './canonical.js';
import type {
  AxAgentEvalBatchResult,
  AxAgentEvalBudget,
} from './evalHarness.js';
import type {
  AxAgentPlaybookControlArmKind,
  AxAgentPlaybookControlArmOptions,
  AxAgentPlaybookControlArmReport,
  AxAgentPlaybookControlArmResult,
  AxAgentPlaybookGateMode,
  AxAgentPlaybookSplitScore,
} from './playbookEvidenceTypes.js';

/** The fixed critique the self-refinement arm appends. Never model-authored. */
export const SELF_REFINE_INSTRUCTION =
  'Critique the previous answer above for correctness and completeness, then produce an improved final answer.';

const NEUTRAL_SECTION = 'neutral_control';
const NEUTRAL_BULLET_ID = 'neutral-control-0';
/**
 * Deliberately content-free: it carries no task guidance of any kind, so a gain
 * it reproduces is attributable to the playbook SLOT, not to the playbook.
 */
const NEUTRAL_SENTENCE =
  'This line is intentionally free of task guidance and carries no instruction. ';
/** The rendered token count must land within this fraction of the target. */
const NEUTRAL_TOLERANCE = 0.05;

export type AxNeutralArtifact = Readonly<{
  playbook: AxACEPlaybook;
  text: string;
  digest: string;
  renderedTokens: number;
  targetTokens: number;
  /** False when the target is smaller than the render's own scaffolding. */
  withinTolerance: boolean;
}>;

function neutralBullet(content: string, nowIso: string): AxACEBullet {
  return {
    id: NEUTRAL_BULLET_ID,
    section: NEUTRAL_SECTION,
    content,
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function neutralPlaybookOf(content: string, nowIso: string): AxACEPlaybook {
  return {
    version: 1,
    sections: { [NEUTRAL_SECTION]: [neutralBullet(content, nowIso)] },
    stats: {
      bulletCount: 1,
      helpfulCount: 0,
      harmfulCount: 0,
      tokenEstimate: estimateTokenCount(content),
    },
    updatedAt: nowIso,
  };
}

/**
 * A neutral artifact rendering to within +/-5% of `targetTokens`.
 *
 * The size match is what makes the ablation an ablation: an artifact that is
 * merely "some other text" would confound content with length, which is the
 * confound the arm exists to remove. Caller-supplied text is used verbatim and
 * NOT padded — a caller who names the neutral artifact owns its size, and the
 * receipt records what was actually rendered.
 */
export function neutralArtifactFor(args: {
  targetTokens: number;
  nowIso: string;
  text?: string;
}): AxNeutralArtifact {
  const measure = (content: string) =>
    estimateTokenCount(
      renderPlaybook(neutralPlaybookOf(content, args.nowIso), {
        now: args.nowIso,
      })
    );
  if (args.text !== undefined) {
    const rendered = measure(args.text);
    return {
      playbook: neutralPlaybookOf(args.text, args.nowIso),
      text: args.text,
      digest: canonicalDigest(args.text),
      renderedTokens: rendered,
      targetTokens: args.targetTokens,
      withinTolerance:
        Math.abs(rendered - args.targetTokens) <=
        Math.max(1, args.targetTokens * NEUTRAL_TOLERANCE),
    };
  }
  // `estimateTokenCount` is ceil(chars / 4), so the filler length that hits the
  // target is exact arithmetic rather than a search: measure the scaffolding
  // once with an empty bullet and fill the remainder.
  const scaffoldingTokens = measure('');
  const scaffoldingChars = scaffoldingTokens * 4;
  const wantedChars = Math.max(0, args.targetTokens * 4 - scaffoldingChars);
  let text = '';
  while (text.length < wantedChars) text += NEUTRAL_SENTENCE;
  text = text.slice(0, wantedChars);
  const rendered = measure(text);
  return {
    playbook: neutralPlaybookOf(text, args.nowIso),
    text,
    digest: canonicalDigest(text),
    renderedTokens: rendered,
    targetTokens: args.targetTokens,
    withinTolerance:
      Math.abs(rendered - args.targetTokens) <=
      Math.max(1, args.targetTokens * NEUTRAL_TOLERANCE),
  };
}

/**
 * Re-invoke the same program with its own previous answer. Appends to an
 * EXISTING string input field rather than adding a new key: a signature renders
 * only its declared fields, so a new key would be silently dropped and the
 * "refinement" would never reach the model at all.
 *
 * Returns `undefined` when the task has no string input field to carry the
 * critique — reported as an arm that could not run, never as a round that
 * quietly did nothing.
 */
export function refinementTaskOf<IN extends AxGenIn>(args: {
  task: Readonly<AxAgentEvalTask<IN>>;
  previousAnswer: unknown;
  round: number;
}): AxAgentEvalTask<IN> | undefined {
  const input = args.task.input as unknown;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const entries = Object.entries(input as Record<string, unknown>);
  const target = entries.find(([, value]) => typeof value === 'string');
  if (!target) return undefined;
  const [field, value] = target;
  const previous =
    typeof args.previousAnswer === 'string'
      ? args.previousAnswer
      : JSON.stringify(args.previousAnswer ?? null);
  return {
    ...args.task,
    input: {
      ...(input as Record<string, unknown>),
      [field]: `${value as string}\n\n[self-refinement round ${args.round}] Previous answer: ${previous}\n${SELF_REFINE_INSTRUCTION}`,
    } as IN,
  };
}

/** Per-task scores aligned to `tasks` by object identity; `undefined` = unscored. */
export function scoresByTaskIndex<IN extends AxGenIn, OUT extends AxGenOut>(
  batch: Readonly<AxAgentEvalBatchResult<IN, OUT>>,
  tasks: readonly AxAgentEvalTask<IN>[]
): (number | undefined)[] {
  const index = new Map<object, number>();
  for (const [position, task] of tasks.entries()) {
    if (!index.has(task as object)) index.set(task as object, position);
  }
  const scores: (number | undefined)[] = new Array(tasks.length).fill(
    undefined
  );
  for (const record of batch.records) {
    const position = index.get(record.task as object);
    if (position === undefined) continue;
    scores[position] = record.score;
  }
  return scores;
}

/** Weighted mean over the tasks that produced a score. Never over a prefix. */
export function weightedMeanOfScores<IN extends AxGenIn>(
  scores: readonly (number | undefined)[],
  tasks: readonly AxAgentEvalTask<IN>[]
): number {
  let weightSum = 0;
  let total = 0;
  for (const [position, score] of scores.entries()) {
    if (score === undefined) continue;
    const weight = tasks[position]?.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) continue;
    weightSum += weight;
    total += weight * score;
  }
  return weightSum > 0 ? total / weightSum : 0;
}

export type AxControlArmEvaluate<IN extends AxGenIn, OUT extends AxGenOut> = (
  args: Readonly<{
    phase: 'control_arm' | 'harness_term_ablation';
    tasks: readonly AxAgentEvalTask<IN>[];
    budget: AxAgentEvalBudget;
    metricTaskOf?: (task: AxAgentEvalTask<IN>) => AxAgentEvalTask<IN>;
  }>
) => Promise<AxAgentEvalBatchResult<IN, OUT>>;

export type AxControlArmContext<IN extends AxGenIn, OUT extends AxGenOut> = {
  arms: readonly AxAgentPlaybookControlArmKind[];
  /** The deciding split. Always held-out; there is no fallback to current. */
  tasks: readonly AxAgentEvalTask<IN>[];
  runsPerTask: number;
  /** The ceiling, read from the legacy counter before the arm spends anything. */
  matched: number;
  options: Readonly<AxAgentPlaybookControlArmOptions>;
  /** Rendered token count of the EVOLVED artifact, for the neutral ablation. */
  evolvedRenderedTokens: number;
  nowIso: string;
  now: () => number;
  usesBuiltInJudge: boolean;
  evaluate: AxControlArmEvaluate<IN, OUT>;
  /** Swap the live artifact for the neutral one, and put the baseline back. */
  loadNeutralArtifact: (playbook: AxACEPlaybook) => void;
  restoreUnevolvedArtifact: () => void;
  progress: (phase: 'control' | 'ablation', message: string) => void;
  abortSignal?: AbortSignal;
};

export type AxControlArmRun = Readonly<{
  result: AxAgentPlaybookControlArmResult;
  /** Per-task selected scores, aligned to the split. Used for the interval. */
  scores: readonly (number | undefined)[];
}>;

export type AxControlArmOutcome = Readonly<{
  runs: readonly AxControlArmRun[];
  /** Arms that could not run at all, with the reason. */
  skipped: readonly Readonly<{
    kind: AxAgentPlaybookControlArmKind;
    reason: string;
  }>[];
}>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AxAgent.playbook().evolve(): aborted');
  }
}

type ArmTally = {
  executedRuns: number;
  discardedRuns: number;
  expectedRuns: number;
  complete: boolean;
  metricCalls: number;
  usage: AxProgramUsage[];
};

function newTally(): ArmTally {
  return {
    executedRuns: 0,
    discardedRuns: 0,
    expectedRuns: 0,
    complete: true,
    metricCalls: 0,
    usage: [],
  };
}

function absorb<IN extends AxGenIn, OUT extends AxGenOut>(
  tally: ArmTally,
  batch: Readonly<AxAgentEvalBatchResult<IN, OUT>>,
  spent: number
): void {
  tally.executedRuns += batch.executedRuns;
  tally.discardedRuns += batch.discardedRuns;
  tally.expectedRuns += batch.expectedRuns;
  tally.complete &&= batch.complete;
  tally.metricCalls += spent;
  tally.usage.push(...batch.usage);
}

function splitScoreOf<IN extends AxGenIn>(
  tally: ArmTally,
  scores: readonly (number | undefined)[],
  tasks: readonly AxAgentEvalTask<IN>[]
): AxAgentPlaybookSplitScore {
  return {
    mean: weightedMeanOfScores(scores, tasks),
    executedRuns: tally.executedRuns,
    discardedRuns: tally.discardedRuns,
    expectedRuns: tally.expectedRuns,
    complete: tally.complete && scores.every((score) => score !== undefined),
  };
}

/**
 * Run the configured arms against whatever artifact is live, which the caller
 * has already restored to the unevolved state. Each arm gets `floor(matched /
 * arms.length)` of the matched ceiling from its OWN counter.
 */
export async function runControlArms<IN extends AxGenIn, OUT extends AxGenOut>(
  ctx: AxControlArmContext<IN, OUT>
): Promise<AxControlArmOutcome> {
  const runs: AxControlArmRun[] = [];
  const skipped: { kind: AxAgentPlaybookControlArmKind; reason: string }[] = [];
  const armBudget = Math.max(0, Math.floor(ctx.matched / ctx.arms.length));
  const passCost = ctx.tasks.length * ctx.runsPerTask;
  const selector = ctx.options.selector ?? 'metric';

  for (const kind of ctx.arms) {
    throwIfAborted(ctx.abortSignal);
    if (passCost <= 0) {
      skipped.push({ kind, reason: 'the deciding split has no tasks' });
      continue;
    }
    if (armBudget < passCost) {
      skipped.push({
        kind,
        reason: `the matched budget leaves ${armBudget} metric calls for this arm; one pass over the deciding split costs ${passCost}`,
      });
      continue;
    }
    const budget: AxAgentEvalBudget = { remaining: armBudget };
    const startedAt = ctx.now();
    const tally = newTally();
    let scores: (number | undefined)[] = [];
    let n = 0;
    let neutral: AxNeutralArtifact | undefined;

    if (kind === 'best_of_n') {
      n = ctx.options.bestOfN ?? Math.max(2, Math.floor(armBudget / passCost));
      scores = new Array(ctx.tasks.length).fill(undefined);
      for (let sample = 0; sample < n; sample++) {
        if (budget.remaining < passCost) break;
        ctx.progress('control', `best_of_n: sample ${sample + 1}/${n}`);
        const before = budget.remaining;
        const batch = await ctx.evaluate({
          phase: 'control_arm',
          tasks: ctx.tasks,
          budget,
        });
        absorb(tally, batch, before - budget.remaining);
        const pass = scoresByTaskIndex(batch, ctx.tasks);
        for (const [position, score] of pass.entries()) {
          if (score === undefined) continue;
          const best = scores[position];
          // Oracle-strong selection: the scoring metric picks the sample.
          if (best === undefined || score > best) scores[position] = score;
        }
      }
    } else if (kind === 'self_refine') {
      n =
        ctx.options.refineRounds ??
        Math.max(1, Math.floor(armBudget / passCost) - 1);
      ctx.progress('control', `self_refine: initial sample`);
      const before = budget.remaining;
      const first = await ctx.evaluate({
        phase: 'control_arm',
        tasks: ctx.tasks,
        budget,
      });
      absorb(tally, first, before - budget.remaining);
      scores = scoresByTaskIndex(first, ctx.tasks);
      let answers = answersByTaskIndex(first, ctx.tasks);
      let refinable = true;
      for (let round = 1; round <= n && refinable; round++) {
        if (budget.remaining < passCost) break;
        const derived: AxAgentEvalTask<IN>[] = [];
        const origins = new Map<object, AxAgentEvalTask<IN>>();
        const positions = new Map<object, number>();
        for (const [position, task] of ctx.tasks.entries()) {
          const refined = refinementTaskOf({
            task,
            previousAnswer: answers[position],
            round,
          });
          if (!refined) continue;
          derived.push(refined);
          origins.set(refined as object, task as AxAgentEvalTask<IN>);
          positions.set(refined as object, position);
        }
        if (derived.length === 0) {
          // No task can carry a critique, so there is no refinement to make.
          refinable = false;
          if (round === 1) {
            skipped.push({
              kind,
              reason:
                'no task in the deciding split has a string input field to carry a critique, so the program cannot be re-invoked with its own previous answer',
            });
          }
          break;
        }
        ctx.progress('control', `self_refine: round ${round}/${n}`);
        const roundBefore = budget.remaining;
        const batch = await ctx.evaluate({
          phase: 'control_arm',
          tasks: derived,
          budget,
          // The metric keeps scoring the ORIGINAL example; only the agent sees
          // the critique.
          metricTaskOf: (task) => origins.get(task as object) ?? task,
        });
        absorb(tally, batch, roundBefore - budget.remaining);
        const roundScores = scoresByTaskIndex(batch, derived);
        const roundAnswers = answersByTaskIndex(batch, derived);
        for (const [derivedIndex, task] of derived.entries()) {
          const position = positions.get(task as object);
          if (position === undefined) continue;
          const score = roundScores[derivedIndex];
          if (score !== undefined) scores[position] = score;
          const answer = roundAnswers[derivedIndex];
          if (answer !== undefined)
            answers = withAnswer(answers, position, answer);
        }
      }
      if (skipped.some((entry) => entry.kind === kind)) continue;
    } else {
      // harness_term
      if (ctx.evolvedRenderedTokens <= 0) {
        skipped.push({
          kind,
          reason:
            'the evolved playbook renders to nothing, so there is no artifact slot to neutralize',
        });
        continue;
      }
      n = 1;
      neutral = neutralArtifactFor({
        targetTokens: ctx.evolvedRenderedTokens,
        nowIso: ctx.nowIso,
        ...(ctx.options.neutralArtifact !== undefined
          ? { text: ctx.options.neutralArtifact }
          : {}),
      });
      ctx.progress(
        'ablation',
        `harness_term: neutral artifact ${neutral.renderedTokens} rendered tokens vs the evolved ${ctx.evolvedRenderedTokens}`
      );
      const before = budget.remaining;
      try {
        ctx.loadNeutralArtifact(neutral.playbook);
        const batch = await ctx.evaluate({
          phase: 'harness_term_ablation',
          tasks: ctx.tasks,
          budget,
        });
        absorb(tally, batch, before - budget.remaining);
        scores = scoresByTaskIndex(batch, ctx.tasks);
      } finally {
        // Every later arm must see the unevolved program, not the neutral one.
        ctx.restoreUnevolvedArtifact();
      }
    }

    const score = splitScoreOf(tally, scores, ctx.tasks);
    runs.push({
      result: {
        kind,
        n,
        selector,
        heldOut: score,
        accounting: phaseAccounting({
          phase:
            kind === 'harness_term' ? 'harness_term_ablation' : 'control_arm',
          metricCalls: tally.metricCalls,
          usage: tally.usage,
          wallClockMs: ctx.now() - startedAt,
          usesBuiltInJudge: ctx.usesBuiltInJudge,
          // I6: no evidence phase moves the legacy evolve-only counter.
          evolveOnlyMetricCalls: 0,
        }),
        ...(neutral
          ? {
              neutralArtifactDigest: neutral.digest,
              neutralArtifactTokens: neutral.renderedTokens,
            }
          : {}),
      },
      scores,
    });
  }

  return { runs, skipped };
}

function answersByTaskIndex<IN extends AxGenIn, OUT extends AxGenOut>(
  batch: Readonly<AxAgentEvalBatchResult<IN, OUT>>,
  tasks: readonly AxAgentEvalTask<IN>[]
): (unknown | undefined)[] {
  const index = new Map<object, number>();
  for (const [position, task] of tasks.entries()) {
    if (!index.has(task as object)) index.set(task as object, position);
  }
  const answers: (unknown | undefined)[] = new Array(tasks.length).fill(
    undefined
  );
  for (const record of batch.records) {
    const position = index.get(record.task as object);
    if (position === undefined) continue;
    answers[position] = record.prediction?.output;
  }
  return answers;
}

function withAnswer(
  answers: readonly (unknown | undefined)[],
  position: number,
  answer: unknown
): (unknown | undefined)[] {
  const next = [...answers];
  next[position] = answer;
  return next;
}

/**
 * The RUN-LEVEL verdict. Fails closed: an arm that did not run, or failed, is
 * not a pass — under `require` it rolls the whole accepted set back rather than
 * letting the run report a gain nobody checked.
 */
export function controlArmVerdict(args: {
  mode: AxAgentPlaybookGateMode;
  margin: number;
  report: Readonly<AxAgentPlaybookControlArmReport>;
}): Readonly<{ passed: boolean; detail: string }> {
  const { report } = args;
  if (report.status === 'not_run') {
    return {
      passed: false,
      detail: `control arm did not run: ${report.reason}`,
    };
  }
  if (report.status === 'failed') {
    return { passed: false, detail: `control arm failed: ${report.reason}` };
  }
  const beatsMargin = report.evolvedAdvantage >= args.margin;
  const notNegative = report.interval.direction !== 'negative';
  const detail = `evolved held-out advantage ${report.evolvedAdvantage.toFixed(3)} over the best arm '${report.best.kind}' (${report.best.mean.toFixed(3)}) vs margin ${args.margin}; interval ${report.interval.direction} [${report.interval.lower.toFixed(3)}, ${report.interval.upper.toFixed(3)}]`;
  return { passed: beatsMargin && notNegative, detail };
}
