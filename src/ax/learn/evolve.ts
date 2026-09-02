/**
 * `axHarnessEvolve` — one verified evolution step over a harness tree.
 *
 * The step NOMINATES. It appends a release with `current: false` and returns
 * `status: 'nominated'`; it never moves the head, and nothing here calls
 * `surface.promote(...)`. A gate that deployed its own winner would be an
 * automatic, unconditional rollout wearing a gate's clothes.
 *
 * Three orderings are load-bearing and are asserted in the tests:
 *
 * 1. The split and its digests are frozen BEFORE `propose` is called, so the
 *    Goodhart claim ("the task set the candidate was written against is the
 *    one it was judged on") is true of the step order and not only of the
 *    prose.
 * 2. Both sides are trial-installed once before any episode runs, so an
 *    un-installable tree can never reach the chain.
 * 3. Episodes are interleaved and alternate first position, so provider drift
 *    hits both sides equally instead of penalising whichever ran last.
 *
 * The acceptance rule itself is not reimplemented here: `selection:
 * 'axPlaybookGate'` calls the same `evaluateAgentPromotionGate` that
 * `agent.playbook().evolve()` calls.
 */

import type {
  AxAgentEvalDataset,
  AxAgentEvalTask,
  AxAgentJudgeOptions,
} from '../agent/agentInternal/agentOptimizeTypes.js';
import { createAgentOptimizeMetric } from '../agent/agentInternal/optimizer.js';
import {
  type AxAgentEvalBudget,
  runAgentEvalBatch,
} from '../agent/agentInternal/playbookEvolve/evalHarness.js';
import { evaluateAgentPromotionGate } from '../agent/agentInternal/playbookEvolve/gate.js';
import type { AxAgentPlaybookEvolveRunRecord } from '../agent/agentInternal/playbookEvolve/playbookEvolveTypes.js';
import type { AxAIService } from '../ai/types.js';
import type { AxMetricFn } from '../dsp/common_types.js';
import type { AxGenIn, AxGenOut } from '../dsp/types.js';
import { type AxEventClock, AxSystemEventClock } from '../event/types.js';
import { axEventCanonicalDigest } from '../event/util.js';
import { mergeAbortSignals } from '../util/abort.js';

import { axApplyHarnessTree, axCurrentHarnessInstallation } from './apply.js';
import {
  type AxHarnessFailureManifest,
  type AxHarnessFailureObservation,
  axAdvanceHarnessFailureManifest,
} from './manifest.js';
import type { AxLearningBatch } from './processor.js';
import type { AxLearningSurface } from './releases.js';
import {
  axAdmitHarnessTree,
  axApplyHarnessMutations,
  axHarnessContentId,
  axRenderHarnessTree,
} from './tree.js';
import {
  type AxHarnessEntryKind,
  AxHarnessEvolveConfigError,
  type AxHarnessGateDecision,
  type AxHarnessGateMetrics,
  type AxHarnessInstallTarget,
  type AxHarnessMutation,
  type AxHarnessTree,
  type AxLearningRelease,
  type AxLearningValue,
  axIsHarnessAdmissionError,
} from './types.js';

const DEFAULT_EPSILON = 0.01;
const DEFAULT_MIN_HELD_IN_GAIN = 0.05;
const DEFAULT_SCORE_THRESHOLD = 0.7;
const DEFAULT_PROPOSE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PROPOSER_CALLS = 1;
const TRIAL_SLOT = 'learn';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The proposer's ONLY path to a model.
 *
 * The SERVED provider is deliberately absent: handing a caller callback the
 * production service is escalation, not containment. A proposer gets a teacher
 * and whatever the host names, under an explicit call budget.
 */
export interface AxHarnessModelBindings {
  readonly teacher?: Readonly<AxAIService>;
  readonly named: Readonly<Record<string, Readonly<AxAIService>>>;
}

export interface AxHarnessProposeArgs {
  /** The enabled composition in tree order. Disabled entries are excluded. */
  readonly nodes: readonly Readonly<{
    id: string;
    kind: AxHarnessEntryKind;
    config: AxLearningValue;
  }>[];
  /** Projected and byte-capped by the engine before it ever reaches here. */
  readonly samples: readonly Readonly<Record<string, unknown>>[];
  /** How many samples the byte cap withheld. Observable, never silent. */
  readonly droppedSamples: number;
  readonly models: Readonly<AxHarnessModelBindings>;
  readonly manifest?: Readonly<AxHarnessFailureManifest>;
  readonly step: number;
  readonly signal?: AbortSignal;
}

export type AxHarnessProposer = (
  args: Readonly<AxHarnessProposeArgs>
) =>
  | AxHarnessMutation
  | readonly AxHarnessMutation[]
  | null
  | Promise<AxHarnessMutation | readonly AxHarnessMutation[] | null>;

export interface AxHarnessCandidate {
  readonly candidateId: string;
  readonly currentEntries: AxHarnessTree;
  readonly candidateEntries: AxHarnessTree;
  readonly currentContentId: string;
  readonly candidateContentId: string;
  readonly mutations: readonly AxHarnessMutation[];
}

export interface AxHarnessEvaluation {
  readonly evaluator: string;
  readonly evaluatorVersion: string;
  readonly metrics: Readonly<AxHarnessGateMetrics>;
  readonly observations: readonly Readonly<AxHarnessFailureObservation>[];
}

export type AxHarnessSelector = (
  candidate: Readonly<AxHarnessCandidate>,
  evaluation: Readonly<AxHarnessEvaluation>
) => Readonly<AxHarnessGateDecision>;

export interface AxHarnessEvolveGateOptions<IN extends AxGenIn = AxGenIn> {
  /** Tolerated held-out drop. Default 0.01 — identical to evolve(). */
  readonly epsilon?: number;
  /** Required held-in improvement. Default 0.05 — identical to evolve(). */
  readonly minHeldInGain?: number;
  /**
   * Default TRUE — a deliberate divergence from `evolve()`, which defaults
   * false. With no `validation` split the step throws before any model call.
   * Setting it false opts into the held-in-only regime, which is the same
   * permissive regime this repo measures at a 66.7% false-promotion rate.
   */
  readonly requireHeldOut?: boolean;
  readonly taskId?: (task: Readonly<AxAgentEvalTask<IN>>) => string | undefined;
  readonly runsPerTask?: number;
  readonly maxMetricCalls?: number;
  readonly scoreThreshold?: number;
}

export interface AxHarnessEvolveProgressEvent {
  readonly phase:
    | 'seed'
    | 'propose'
    | 'evaluate'
    | 'decide'
    | 'nominate'
    | 'done';
  readonly message: string;
  readonly metricCallsUsed: number;
}

export interface AxHarnessEvolveOptions<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> {
  readonly agent: AxHarnessEvolveAgent<IN, OUT>;
  readonly ai: Readonly<AxAIService>;
  readonly surface: AxLearningSurface;
  readonly tasks: Readonly<AxAgentEvalDataset<IN>>;
  readonly propose: AxHarnessProposer;
  /** Hard cap on proposer invocations for this step. Default 1. */
  readonly maxProposerCalls?: number;
  /** Per-proposer-call deadline, composed with `abortSignal`. Default 60_000. */
  readonly proposeTimeoutMs?: number;
  readonly batch?: Readonly<AxLearningBatch>;
  readonly manifest?: Readonly<AxHarnessFailureManifest>;
  readonly metric?: AxMetricFn;
  readonly teacherAI?: Readonly<AxAIService>;
  readonly judgeAI?: Readonly<AxAIService>;
  readonly judgeOptions?: AxAgentJudgeOptions;
  readonly namedModels?: Readonly<Record<string, Readonly<AxAIService>>>;
  /**
   * Default `axPlaybookGate` — held-in gain plus held-out epsilon.
   * `scoreComparison` (wins > losses) exists ONLY for reef parity and is
   * structurally weaker. There is no `always`.
   */
  readonly selection?: 'axPlaybookGate' | 'scoreComparison' | AxHarnessSelector;
  readonly gate?: Readonly<AxHarnessEvolveGateOptions<IN>>;
  readonly clock?: AxEventClock;
  /**
   * Required when the agent learns into its playbook after every run. Every
   * install this step makes — including restoring the pre-step tree —
   * replaces the playbook, so the acknowledgement is carried through.
   */
  readonly acknowledgeContinuousPlaybookReset?: boolean;
  readonly onProgress?: (event: Readonly<AxHarnessEvolveProgressEvent>) => void;
  readonly abortSignal?: AbortSignal;
}

/** The subset of the agent an evolve step drives. */
export interface AxHarnessEvolveAgent<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> extends AxHarnessInstallTarget {
  getLearn?():
    | { suspendRecording(): () => void; suppressedRecords: number }
    | undefined;
  _forwardForEvaluation?: unknown;
  __evolveTypes?: { in: IN; out: OUT };
}

export interface AxHarnessEvolveResult<OUT extends AxGenOut = AxGenOut> {
  /** `nominated` replaces `published`: ax never moves the head. */
  readonly status: 'nominated' | 'rejected' | 'skipped';
  readonly reason?: string;
  readonly candidate?: Readonly<AxHarnessCandidate>;
  readonly decision?: Readonly<AxHarnessGateDecision>;
  /** The appended, NON-current release. Promote it with `surface.promote(...)`. */
  readonly release?: Readonly<AxLearningRelease>;
  readonly manifest: Readonly<AxHarnessFailureManifest>;
  readonly metricCallsUsed: number;
  readonly proposerCallsUsed: number;
  /** Recorded runs suppressed while the step ran. Observable, never silent. */
  readonly suppressedRecords: number;
  readonly records: readonly AxAgentPlaybookEvolveRunRecord<any, OUT>[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Side = 'current' | 'candidate';

function normalizeTasks<IN extends AxGenIn>(
  dataset: Readonly<AxAgentEvalDataset<IN>>
): Readonly<{
  train: readonly AxAgentEvalTask<IN>[];
  validation?: readonly AxAgentEvalTask<IN>[];
}> {
  if (Array.isArray(dataset)) {
    return { train: dataset as readonly AxAgentEvalTask<IN>[] };
  }
  const shaped = dataset as {
    train: readonly AxAgentEvalTask<IN>[];
    validation?: readonly AxAgentEvalTask<IN>[];
  };
  return shaped.validation === undefined
    ? { train: shaped.train }
    : { train: shaped.train, validation: shaped.validation };
}

function taskIds<IN extends AxGenIn>(
  tasks: readonly AxAgentEvalTask<IN>[],
  resolve?: (task: Readonly<AxAgentEvalTask<IN>>) => string | undefined
): readonly string[] {
  return tasks.map(
    (task, index) => resolve?.(task) ?? task.id ?? `task-${index}`
  );
}

/** Mean of the finite scores, or `null` when nothing scored. */
function meanOf(scores: readonly (number | null)[]): number | null {
  const finite = scores.filter((score): score is number => score !== null);
  if (finite.length === 0) return null;
  return finite.reduce((sum, score) => sum + score, 0) / finite.length;
}

/** `null` ranks below every real score; a crash can never win. */
function rank(score: number | null): number {
  return score === null ? Number.NEGATIVE_INFINITY : score;
}

function toNodes(tree: AxHarnessTree) {
  return tree
    .filter((entry) => entry.disabled !== true)
    .map((entry) =>
      Object.freeze({
        id: entry.id,
        kind: entry.kind,
        config: entry.config as unknown as AxLearningValue,
      })
    );
}

async function withTimeout<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const signal = mergeAbortSignals(outer, controller.signal);
  const timer = setTimeout(() => {
    controller.abort(new Error('axHarnessEvolve: propose timed out'));
  }, timeoutMs);
  try {
    return await run(signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** `wins > losses`. reef parity only, and structurally weaker. */
const scoreComparisonSelector: AxHarnessSelector = (_candidate, evaluation) => {
  const { metrics } = evaluation;
  const accept = metrics.wins > metrics.losses;
  return Object.freeze({
    outcome: accept ? ('select' as const) : ('reject' as const),
    evaluator: evaluation.evaluator,
    evaluatorVersion: evaluation.evaluatorVersion,
    policy: 'scoreComparison' as const,
    policyVersion: '1',
    reason: accept
      ? `wins ${metrics.wins} > losses ${metrics.losses}`
      : `wins ${metrics.wins} did not exceed losses ${metrics.losses}`,
    metrics,
  });
};

function playbookGateSelector(
  options: Readonly<{
    epsilon: number;
    minHeldInGain: number;
    requireHeldOut: boolean;
    heldInComplete: boolean;
    heldInExhausted: boolean;
    heldOutComplete: boolean;
    heldOutExhausted: boolean;
    hasHeldOut: boolean;
  }>
): AxHarnessSelector {
  return (_candidate, evaluation) => {
    const { metrics } = evaluation;
    const verdict = evaluateAgentPromotionGate({
      heldIn: metrics.heldIn.before,
      revalTrain: {
        complete: options.heldInComplete,
        exhausted: options.heldInExhausted,
        mean: metrics.heldIn.after,
      },
      ...(options.hasHeldOut && metrics.heldOut
        ? {
            heldOut: metrics.heldOut.before,
            revalHeldOut: metrics.heldOut.after,
            revalHeldOutBatch: {
              complete: options.heldOutComplete,
              exhausted: options.heldOutExhausted,
              mean: metrics.heldOut.after,
            },
          }
        : {}),
      epsilon: options.epsilon,
      currentGainThreshold: options.minHeldInGain,
      requireHeldOut: options.requireHeldOut,
      hasRetentionPolicy: false,
      retentionOk: true,
      retentionBatchesComplete: true,
    });
    return Object.freeze({
      outcome: verdict.accept ? ('select' as const) : ('reject' as const),
      evaluator: evaluation.evaluator,
      evaluatorVersion: evaluation.evaluatorVersion,
      policy: 'axPlaybookGate' as const,
      policyVersion: '1',
      reason: verdict.reason,
      metrics,
    });
  };
}

// ---------------------------------------------------------------------------
// axHarnessEvolve
// ---------------------------------------------------------------------------

export const axHarnessEvolve = async <
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
>(
  options: Readonly<AxHarnessEvolveOptions<IN, OUT>>
): Promise<Readonly<AxHarnessEvolveResult<OUT>>> => {
  const {
    agent,
    ai,
    surface,
    propose,
    abortSignal,
    onProgress,
    acknowledgeContinuousPlaybookReset,
  } = options;
  const clock = options.clock ?? new AxSystemEventClock();
  const gateOptions = options.gate ?? {};
  const epsilon = gateOptions.epsilon ?? DEFAULT_EPSILON;
  const minHeldInGain = gateOptions.minHeldInGain ?? DEFAULT_MIN_HELD_IN_GAIN;
  const requireHeldOut = gateOptions.requireHeldOut ?? true;
  const runsPerTask = gateOptions.runsPerTask ?? 1;
  const scoreThreshold = gateOptions.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const target = agent as AxHarnessInstallTarget;

  // ---- Step 1: normalize the dataset and fail closed on the split ---------
  const split = normalizeTasks(options.tasks);
  if (split.train.length === 0) {
    throw new AxHarnessEvolveConfigError(
      'tasks',
      'axHarnessEvolve: the training split is empty; there is nothing to improve against.'
    );
  }
  if (requireHeldOut && (split.validation?.length ?? 0) === 0) {
    throw new AxHarnessEvolveConfigError(
      'gate.requireHeldOut',
      'axHarnessEvolve: requireHeldOut defaults to true and needs a { train, validation } dataset. Pass a validation split, or set gate.requireHeldOut: false to opt into the held-in-only regime — the same permissive regime measured at a 66.7% false-promotion rate.'
    );
  }

  const datasetSize =
    (split.train.length + (split.validation?.length ?? 0)) * runsPerTask * 2;
  const maxMetricCalls =
    gateOptions.maxMetricCalls ?? Math.max(100, datasetSize);
  if (!Number.isSafeInteger(maxMetricCalls) || maxMetricCalls <= 0) {
    throw new AxHarnessEvolveConfigError(
      'gate.maxMetricCalls',
      'axHarnessEvolve: maxMetricCalls must be a positive safe integer.'
    );
  }

  // ---- Step 2: freeze the split digests BEFORE any proposal --------------
  const trainIds = taskIds(split.train, gateOptions.taskId);
  const taskSetDigest = await axEventCanonicalDigest([...trainIds].sort());
  const heldOutIds = split.validation
    ? taskIds(split.validation, gateOptions.taskId)
    : undefined;
  const heldOutTaskSetDigest = heldOutIds
    ? await axEventCanonicalDigest([...heldOutIds].sort())
    : undefined;

  // ---- Step 3: read and re-admit the current tree -------------------------
  const current = await surface.currentTree(abortSignal);
  if (current === undefined) {
    throw new AxHarnessEvolveConfigError(
      'surface',
      'axHarnessEvolve: the scenario has no promoted head; seed the surface before evolving.'
    );
  }
  const currentEntries = axAdmitHarnessTree(current.entries);
  const step = current.step + 1;

  const budget: AxAgentEvalBudget = { remaining: maxMetricCalls };
  const learn = agent.getLearn?.();
  const suppressedBefore = learn?.suppressedRecords ?? 0;
  const records: AxAgentPlaybookEvolveRunRecord<any, OUT>[] = [];
  const observations: AxHarnessFailureObservation[] = [];
  let proposerCallsUsed = 0;

  const emit = (
    phase: AxHarnessEvolveProgressEvent['phase'],
    message: string
  ): void => {
    onProgress?.({
      phase,
      message,
      metricCallsUsed: maxMetricCalls - budget.remaining,
    });
  };

  const skipped = (
    reason: string,
    manifest: Readonly<AxHarnessFailureManifest>
  ): Readonly<AxHarnessEvolveResult<OUT>> =>
    Object.freeze({
      status: 'skipped' as const,
      reason,
      manifest,
      metricCallsUsed: maxMetricCalls - budget.remaining,
      proposerCallsUsed,
      suppressedRecords: (learn?.suppressedRecords ?? 0) - suppressedBefore,
      records: Object.freeze(records),
    });

  const inputManifest: Readonly<AxHarnessFailureManifest> =
    options.manifest ?? Object.freeze({ step: step - 1, entries: [] });

  // ---- Step 4: hold recording suspension for the whole step ---------------
  const releaseSuppression = learn?.suspendRecording();

  // The agent may already be serving a tree. Only one installation is allowed
  // at a time, so it is taken off for the duration and put back at the end;
  // the entries come from the chain, which is why a pre-step installation that
  // is not on this chain is refused rather than silently lost.
  const preInstallation = axCurrentHarnessInstallation(target);
  let preEntries: AxHarnessTree | undefined;
  let preReleaseId: string | undefined;
  let preParentReleaseId: string | undefined;
  if (preInstallation) {
    const chain = await surface.releases(abortSignal);
    const preRelease = chain.find(
      (release) => release.releaseId === preInstallation.releaseId
    );
    if (preRelease === undefined) {
      releaseSuppression?.();
      throw new AxHarnessEvolveConfigError(
        'agent',
        `axHarnessEvolve: the agent is serving release ${preInstallation.releaseId}, which is not on this scenario's chain, so the step could not put it back. Dispose the installation first.`
      );
    }
    preEntries = preRelease.entries;
    preReleaseId = preRelease.releaseId;
    preParentReleaseId = preRelease.parentReleaseId;
    preInstallation.dispose();
  }

  const nowIso = (): string => new Date(clock.now()).toISOString();

  const installSide = async (
    entries: AxHarnessTree,
    releaseId: string,
    parentReleaseId?: string
  ) =>
    axApplyHarnessTree(entries, target, {
      releaseId,
      ...(parentReleaseId === undefined ? {} : { parentReleaseId }),
      now: nowIso(),
      slot: TRIAL_SLOT,
      ...(acknowledgeContinuousPlaybookReset === undefined
        ? {}
        : { acknowledgeContinuousPlaybookReset }),
    });

  const runStep = async (): Promise<Readonly<AxHarnessEvolveResult<OUT>>> => {
    // ---- Step 5: propose, bounded ----------------------------------------
    emit('propose', 'requesting a proposal');
    const maxProposerCalls =
      options.maxProposerCalls ?? DEFAULT_MAX_PROPOSER_CALLS;
    if (!Number.isSafeInteger(maxProposerCalls) || maxProposerCalls <= 0) {
      throw new AxHarnessEvolveConfigError(
        'maxProposerCalls',
        'axHarnessEvolve: maxProposerCalls must be a positive safe integer.'
      );
    }
    const proposeTimeoutMs =
      options.proposeTimeoutMs ?? DEFAULT_PROPOSE_TIMEOUT_MS;

    let proposed: AxHarnessMutation | readonly AxHarnessMutation[] | null =
      null;
    for (let call = 0; call < maxProposerCalls; call += 1) {
      proposerCallsUsed += 1;
      proposed = await withTimeout(
        (signal) =>
          Promise.resolve(
            propose({
              nodes: toNodes(currentEntries),
              samples: options.batch?.samples ?? [],
              droppedSamples: options.batch?.droppedSamples ?? 0,
              models: Object.freeze({
                // The SERVED provider is deliberately not here.
                ...(options.teacherAI === undefined
                  ? {}
                  : { teacher: options.teacherAI }),
                named: Object.freeze({ ...(options.namedModels ?? {}) }),
              }),
              ...(options.manifest === undefined
                ? {}
                : { manifest: options.manifest }),
              step,
              ...(signal === undefined ? {} : { signal }),
            })
          ),
        proposeTimeoutMs,
        abortSignal
      );
      if (proposed !== null) break;
    }

    // ---- Step 6: nothing proposed ----------------------------------------
    const mutations =
      proposed === null
        ? []
        : ([] as AxHarnessMutation[]).concat(proposed as AxHarnessMutation[]);
    if (mutations.length === 0) {
      return skipped('no proposal', inputManifest);
    }

    // ---- Step 7: apply the mutations purely, and re-admit -----------------
    let candidateEntries: AxHarnessTree;
    try {
      candidateEntries = axApplyHarnessMutations(currentEntries, mutations);
    } catch (error) {
      const reason = axIsHarnessAdmissionError(error)
        ? `candidate denied admission: ${error.reason} at ${error.path} on entry ${error.entryId}`
        : `candidate mutation rejected: ${
            error instanceof Error ? error.message : String(error)
          }`;
      return skipped(reason, inputManifest);
    }

    // ---- Step 8: render both sides and compare content identity -----------
    const now = nowIso();
    axRenderHarnessTree(currentEntries, { now });
    axRenderHarnessTree(candidateEntries, { now });
    const currentContentId = await axHarnessContentId(currentEntries);
    const candidateContentId = await axHarnessContentId(candidateEntries);
    if (currentContentId === candidateContentId) {
      return skipped('no-op mutation', inputManifest);
    }

    const candidate: Readonly<AxHarnessCandidate> = Object.freeze({
      candidateId: candidateContentId,
      currentEntries,
      candidateEntries,
      currentContentId,
      candidateContentId,
      mutations: Object.freeze([...mutations]),
    });

    // ---- Step 9: trial-install BOTH sides before any episode --------------
    try {
      for (const [entries, releaseId] of [
        [currentEntries, current.releaseId],
        [candidateEntries, `${current.releaseId}-candidate`],
      ] as const) {
        const trial = await installSide(entries, releaseId);
        trial.dispose();
      }
    } catch (error) {
      // Nothing has been appended, so an un-installable tree cannot reach the
      // chain even in principle.
      return skipped(
        `trial install failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        inputManifest
      );
    }

    // ---- Step 10: interleaved paired evaluation ---------------------------
    const metric =
      options.metric ??
      createAgentOptimizeMetric(
        agent,
        options.judgeAI ?? options.teacherAI ?? ai,
        options.judgeOptions ?? {}
      );

    const scoreOne = async (
      side: Side,
      task: Readonly<AxAgentEvalTask<IN>>,
      taskId: string,
      splitName: 'train' | 'validation'
    ): Promise<{
      score: number | null;
      complete: boolean;
      exhausted: boolean;
    }> => {
      emit('evaluate', `${splitName}:${taskId}:${side}`);
      const entries = side === 'candidate' ? candidateEntries : currentEntries;
      const releaseId =
        side === 'candidate'
          ? `${current.releaseId}-candidate`
          : current.releaseId;
      let installation: Awaited<ReturnType<typeof installSide>> | undefined;
      try {
        installation = await installSide(entries, releaseId);
        const batch = await runAgentEvalBatch<IN, OUT>({
          agent,
          ai,
          tasks: [task],
          metric,
          scoreThreshold,
          budget,
          runsPerTask,
          ...(abortSignal === undefined ? {} : { abortSignal }),
          now: () => clock.now(),
        });
        records.push(...batch.records);
        if (!batch.complete || !batch.validEvidence) {
          observations.push({
            taskId,
            stage: batch.validEvidence ? 'metric' : 'run',
            cause:
              batch.records.find((record) => record.error)?.error ??
              (batch.exhausted
                ? 'metric budget exhausted'
                : 'incomplete evidence'),
          });
          return {
            score: null,
            complete: false,
            exhausted: batch.exhausted,
          };
        }
        return { score: batch.mean, complete: true, exhausted: false };
      } catch (error) {
        observations.push({
          taskId,
          stage: 'apply',
          cause: error instanceof Error ? error.message : String(error),
        });
        return { score: null, complete: false, exhausted: false };
      } finally {
        installation?.dispose();
      }
    };

    const runSplit = async (
      tasks: readonly AxAgentEvalTask<IN>[],
      ids: readonly string[],
      splitName: 'train' | 'validation'
    ) => {
      const candidateScores: (number | null)[] = [];
      const currentScores: (number | null)[] = [];
      let candidateComplete = true;
      let currentComplete = true;
      let exhausted = false;
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index] as Readonly<AxAgentEvalTask<IN>>;
        const id = ids[index] as string;
        // Alternate first position so provider drift hits both sides equally.
        const order: readonly Side[] =
          index % 2 === 0
            ? (['current', 'candidate'] as const)
            : (['candidate', 'current'] as const);
        for (const side of order) {
          const outcome = await scoreOne(side, task, id, splitName);
          if (side === 'candidate') {
            candidateScores[index] = outcome.score;
            candidateComplete &&= outcome.complete;
          } else {
            currentScores[index] = outcome.score;
            currentComplete &&= outcome.complete;
          }
          exhausted ||= outcome.exhausted;
        }
      }
      return {
        candidateScores,
        currentScores,
        candidateComplete,
        currentComplete,
        exhausted,
      };
    };

    const heldInRun = await runSplit(split.train, trainIds, 'train');
    const heldOutRun =
      split.validation && heldOutIds
        ? await runSplit(split.validation, heldOutIds, 'validation')
        : undefined;

    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (let index = 0; index < heldInRun.candidateScores.length; index += 1) {
      const c = rank(heldInRun.candidateScores[index] ?? null);
      const u = rank(heldInRun.currentScores[index] ?? null);
      if (c > u) wins += 1;
      else if (c < u) losses += 1;
      else ties += 1;
    }

    const heldInBefore = meanOf(heldInRun.currentScores) ?? 0;
    const heldInAfter = meanOf(heldInRun.candidateScores) ?? 0;
    const episodeFailures = [
      ...heldInRun.candidateScores,
      ...heldInRun.currentScores,
      ...(heldOutRun?.candidateScores ?? []),
      ...(heldOutRun?.currentScores ?? []),
    ].filter((score) => score === null).length;

    // The manifest is advanced from the candidate side's observations, before
    // the decision, because the gate metrics carry the classification and a
    // decision cannot reference a manifest computed after it.
    const advanced = await axAdvanceHarnessFailureManifest(
      inputManifest,
      observations,
      step
    );

    const metrics: Readonly<AxHarnessGateMetrics> = Object.freeze({
      candidateScores: Object.freeze([...heldInRun.candidateScores]),
      currentScores: Object.freeze([...heldInRun.currentScores]),
      candidateScore: meanOf(heldInRun.candidateScores),
      currentScore: meanOf(heldInRun.currentScores),
      wins,
      losses,
      ties,
      heldIn: Object.freeze({ before: heldInBefore, after: heldInAfter }),
      ...(heldOutRun === undefined
        ? {}
        : {
            heldOut: Object.freeze({
              before: meanOf(heldOutRun.currentScores) ?? 0,
              after: meanOf(heldOutRun.candidateScores) ?? 0,
            }),
          }),
      taskSetDigest,
      ...(heldOutTaskSetDigest === undefined ? {} : { heldOutTaskSetDigest }),
      failures: Object.freeze({
        new: advanced.new,
        persisting: advanced.persisting,
        fixed: advanced.fixed,
      }),
      episodeFailures,
      ...(options.batch === undefined
        ? {}
        : {
            batchId: options.batch.batchId,
            processorId: options.batch.processorId,
          }),
    });

    const evaluation: Readonly<AxHarnessEvaluation> = Object.freeze({
      evaluator: 'harness_task_pairs',
      evaluatorVersion: '1',
      metrics,
      observations: Object.freeze([...observations]),
    });

    // ---- Step 12: decide ---------------------------------------------------
    emit('decide', 'applying the selection policy');
    const selector: AxHarnessSelector =
      typeof options.selection === 'function'
        ? options.selection
        : options.selection === 'scoreComparison'
          ? scoreComparisonSelector
          : playbookGateSelector({
              epsilon,
              minHeldInGain,
              requireHeldOut,
              heldInComplete: heldInRun.candidateComplete,
              heldInExhausted: heldInRun.exhausted,
              heldOutComplete: heldOutRun?.candidateComplete ?? false,
              heldOutExhausted: heldOutRun?.exhausted ?? false,
              hasHeldOut: heldOutRun !== undefined,
            });

    const decision = selector(candidate, evaluation);
    if (decision.metrics !== evaluation.metrics) {
      // A policy may not fabricate its own measurements.
      throw new Error(
        'axHarnessEvolve: the selector returned metrics it did not receive; a policy may not fabricate its own measurements.'
      );
    }
    if (
      typeof decision.policy !== 'string' ||
      decision.policy.trim().length === 0 ||
      typeof decision.policyVersion !== 'string' ||
      decision.policyVersion.trim().length === 0
    ) {
      throw new Error(
        'axHarnessEvolve: the selector must name a non-empty policy and policyVersion.'
      );
    }

    // ---- Steps 13-14: nominate, or reject ---------------------------------
    if (decision.outcome !== 'select') {
      emit('done', `rejected: ${decision.reason}`);
      return Object.freeze({
        status: 'rejected' as const,
        reason: decision.reason,
        candidate,
        decision,
        manifest: advanced.manifest,
        metricCallsUsed: maxMetricCalls - budget.remaining,
        proposerCallsUsed,
        suppressedRecords: (learn?.suppressedRecords ?? 0) - suppressedBefore,
        records: Object.freeze(records),
      });
    }

    emit('nominate', 'appending the nomination');
    const release = await surface.publish(
      { entries: candidateEntries, gate: decision, operation: 'evolve' },
      abortSignal
    );
    emit('done', `nominated ${release.releaseId}`);
    return Object.freeze({
      status: 'nominated' as const,
      reason: decision.reason,
      candidate,
      decision,
      release,
      manifest: advanced.manifest,
      metricCallsUsed: maxMetricCalls - budget.remaining,
      proposerCallsUsed,
      suppressedRecords: (learn?.suppressedRecords ?? 0) - suppressedBefore,
      records: Object.freeze(records),
    });
  };

  // ---- Step 16: leave the agent exactly as it was found -------------------
  //
  // Restoration runs on both the success and the failure path, and a failure
  // to restore is never downgraded to a plain rejection: an agent left serving
  // a trial tree is worse news than whatever the step was already reporting.
  let result: Readonly<AxHarnessEvolveResult<OUT>> | undefined;
  let thrown: unknown;
  let restoreFailure: unknown;
  try {
    result = await runStep();
  } catch (error) {
    thrown = error;
  }
  axCurrentHarnessInstallation(target)?.dispose();
  if (preEntries && preReleaseId) {
    try {
      await installSide(preEntries, preReleaseId, preParentReleaseId);
    } catch (error) {
      restoreFailure = error;
    }
  }
  releaseSuppression?.();

  if (restoreFailure !== undefined) {
    throw new AggregateError(
      thrown === undefined ? [restoreFailure] : [thrown, restoreFailure],
      'axHarnessEvolve: the pre-step installation could not be restored'
    );
  }
  if (thrown !== undefined) throw thrown;
  return result as Readonly<AxHarnessEvolveResult<OUT>>;
};
