/**
 * Compute accounting for `agent.playbook().evolve()`.
 *
 * One denominator, defined once (invariant I6): `accounting.metricCalls` is the
 * honest run total — the sum over every phase, including the control arm, the
 * variance band, transfer cells, ablations and the sealed test —
 * while `accounting.evolveOnlyMetricCalls` restates the legacy
 * `result.metricCallsUsed` counter so a receipt read in isolation shows both.
 *
 * Absence is never rounded to zero, and the two kinds of absence are kept
 * apart: a phase whose calls CANNOT surface usage reports
 * `tokensBasis: 'unobservable'` (a `usageTap` is the remedy), a phase that
 * could and did not reports `'unreported'` (no remedy exists in Ax), and both
 * carry `totalTokens: undefined`. A run with no `costFor` hook reports
 * `costBasis: 'unknown'`.
 */

import type { AxProgramUsage } from '../../../dsp/types.js';
import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentPlaybookComputeAccounting,
  AxAgentPlaybookComputePhase,
  AxAgentPlaybookComputePhaseName,
  AxAgentPlaybookCostFn,
  AxAgentPlaybookModelIdentity,
  AxAgentPlaybookOverheadMeasure,
  AxAgentPlaybookOverheadReport,
  AxAgentPlaybookOverheadSplit,
  AxAgentPlaybookTokensBasis,
} from './playbookEvidenceTypes.js';
import type { AxTaskCluster } from './statistics.js';
import { pairedBootstrapInterval } from './statistics.js';

/**
 * Phases whose calls cannot surface usage without a caller-supplied
 * `usageTap`: the miner builds its own `AxGen` and returns no usage, and the
 * judge is reached only as an opaque `AxMetricFn`.
 */
const STRUCTURALLY_UNOBSERVABLE_PHASES: ReadonlySet<AxAgentPlaybookComputePhaseName> =
  new Set<AxAgentPlaybookComputePhaseName>(['mining', 'judge']);

type PhaseState = {
  name: AxAgentPlaybookComputePhaseName;
  metricCalls: number;
  modelCalls: number;
  callsWithUsage: number;
  totalTokens: number;
  observedAnyUsage: boolean;
  wallClockMs: number;
  openedAt?: number;
  /** Model identities observed in THIS phase, keyed `${ai} ${model}`. */
  models: Map<string, AxAgentPlaybookModelIdentity>;
};

export type AxPhaseHandle = {
  /** Record (agent run + metric) pairs drawn from a metric budget. */
  addMetricCalls: (count: number) => void;
  /** Record model calls made outside the metric budget. */
  addModelCalls: (count: number) => void;
  /** Attribute observed usage to this phase. */
  addUsage: (usage: readonly AxProgramUsage[]) => void;
  /** Stop this phase's wall clock. Idempotent. */
  close: () => void;
};

export type AxAccountingLedger = {
  /** Open (or reopen) a phase and start its wall clock. */
  phase: (name: AxAgentPlaybookComputePhaseName) => AxPhaseHandle;
  /**
   * Usage forwarded by a caller-owned `usageTap`, attributed to the phase that
   * is open when it arrives. Attribution is DELIBERATELY restricted to the
   * structurally unobservable phases: every other phase already reads its own
   * usage off the predictions, so accepting tapped usage there would count the
   * same tokens twice. Returns true when the usage was attributed.
   */
  tapUsage: (usage: readonly AxProgramUsage[]) => boolean;
  /** Every usage record the run observed, in observation order. */
  usage: () => readonly AxProgramUsage[];
  /** Total wall clock since the ledger was created. */
  wallClockMs: () => number;
  assemble: (args: {
    evolveOnlyMetricCalls: number;
    costFor?: AxAgentPlaybookCostFn;
    /** True when a caller-supplied usage tap is forwarding model usage. */
    usageTapped?: boolean;
  }) => AxAgentPlaybookComputeAccounting;
};

function tokensOf(usage: AxProgramUsage): number | undefined {
  const total = usage?.tokens?.totalTokens;
  return typeof total === 'number' && Number.isFinite(total)
    ? total
    : undefined;
}

function rememberModel(state: PhaseState, entry: AxProgramUsage): void {
  if (typeof entry?.ai !== 'string' || typeof entry?.model !== 'string') return;
  const key = `${entry.ai} ${entry.model}`;
  if (state.models.has(key)) return;
  state.models.set(key, { ai: entry.ai, model: entry.model });
}

function phaseBasis(
  state: Readonly<PhaseState>,
  usageTapped: boolean
): AxAgentPlaybookTokensBasis {
  const calls = state.metricCalls + state.modelCalls;
  if (calls === 0 && !state.observedAnyUsage) return 'none';
  if (
    !state.observedAnyUsage &&
    STRUCTURALLY_UNOBSERVABLE_PHASES.has(state.name) &&
    !usageTapped
  ) {
    return 'unobservable';
  }
  // An OBSERVABLE phase that reported nothing is 'unreported', not
  // 'unobservable': the provider surfaced no usage, and no usage tap would
  // change that. Conflating the two puts a remedy on the receipt that does not
  // apply to the phase it names.
  if (!state.observedAnyUsage) return 'unreported';
  return state.callsWithUsage >= calls ? 'observed' : 'partial';
}

function rollUpBasis(
  phases: readonly AxAgentPlaybookComputePhase[]
): AxAgentPlaybookTokensBasis {
  const bases = phases.map((phase) => phase.tokensBasis);
  if (bases.length === 0 || bases.every((basis) => basis === 'none')) {
    return 'none';
  }
  const informative = bases.filter((basis) => basis !== 'none');
  if (informative.every((basis) => basis === 'observed')) return 'observed';
  if (informative.every((basis) => basis === 'unobservable')) {
    return 'unobservable';
  }
  if (informative.every((basis) => basis === 'unreported')) return 'unreported';
  return 'partial';
}

export function createAccountingLedger(
  now: () => number = Date.now
): AxAccountingLedger {
  const states = new Map<AxAgentPlaybookComputePhaseName, PhaseState>();
  const seenUsage: AxProgramUsage[] = [];
  const startedAt = now();
  /** The phase currently open, so tapped usage can be attributed to it. */
  let openPhase: PhaseState | undefined;

  const stateOf = (name: AxAgentPlaybookComputePhaseName): PhaseState => {
    const existing = states.get(name);
    if (existing) return existing;
    const created: PhaseState = {
      name,
      metricCalls: 0,
      modelCalls: 0,
      callsWithUsage: 0,
      totalTokens: 0,
      observedAnyUsage: false,
      wallClockMs: 0,
      models: new Map(),
    };
    states.set(name, created);
    return created;
  };

  const closeState = (state: PhaseState) => {
    if (state.openedAt === undefined) return;
    state.wallClockMs += now() - state.openedAt;
    state.openedAt = undefined;
    if (openPhase === state) openPhase = undefined;
  };

  return {
    phase(name) {
      const state = stateOf(name);
      if (openPhase && openPhase !== state) closeState(openPhase);
      state.openedAt = now();
      openPhase = state;
      return {
        addMetricCalls: (count) => {
          state.metricCalls += count;
        },
        addModelCalls: (count) => {
          state.modelCalls += count;
        },
        addUsage: (usage) => {
          for (const entry of usage) {
            if (!entry) continue;
            seenUsage.push(entry);
            rememberModel(state, entry);
            const tokens = tokensOf(entry);
            if (tokens !== undefined) {
              state.totalTokens += tokens;
              state.callsWithUsage++;
              state.observedAnyUsage = true;
            }
          }
        },
        close: () => closeState(state),
      };
    },
    tapUsage(usage) {
      const target = openPhase;
      if (!target || !STRUCTURALLY_UNOBSERVABLE_PHASES.has(target.name)) {
        return false;
      }
      for (const entry of usage) {
        if (!entry) continue;
        seenUsage.push(entry);
        rememberModel(target, entry);
        const tokens = tokensOf(entry);
        if (tokens === undefined) continue;
        target.totalTokens += tokens;
        target.callsWithUsage++;
        target.observedAnyUsage = true;
      }
      return true;
    },
    usage: () => seenUsage,
    wallClockMs: () => now() - startedAt,
    assemble({ evolveOnlyMetricCalls, costFor, usageTapped }) {
      for (const state of states.values()) closeState(state);
      const phases: AxAgentPlaybookComputePhase[] = [...states.values()].map(
        (state) => {
          const basis = phaseBasis(state, usageTapped === true);
          return {
            name: state.name,
            metricCalls: state.metricCalls,
            modelCalls: state.modelCalls,
            ...(state.observedAnyUsage
              ? { totalTokens: state.totalTokens }
              : {}),
            tokensBasis: basis,
            wallClockMs: state.wallClockMs,
            ...(state.models.size > 0
              ? { models: [...state.models.values()] }
              : {}),
          };
        }
      );
      const metricCalls = phases.reduce(
        (sum, phase) => sum + phase.metricCalls,
        0
      );
      const modelCalls = phases.reduce(
        (sum, phase) => sum + phase.modelCalls,
        0
      );
      const observedTokens = phases.some(
        (phase) => phase.totalTokens !== undefined
      )
        ? phases.reduce((sum, phase) => sum + (phase.totalTokens ?? 0), 0)
        : undefined;
      // Ax has no provider cost field anywhere in the usage chain, so a cost
      // exists only when the caller computed one. `undefined` is the answer,
      // never zero.
      const costUsd = costFor ? costFor(seenUsage) : undefined;
      const costValid =
        typeof costUsd === 'number' && Number.isFinite(costUsd)
          ? costUsd
          : undefined;
      const models: AxAgentPlaybookModelIdentity[] = [];
      const seenModels = new Set<string>();
      for (const entry of seenUsage) {
        if (typeof entry?.ai !== 'string' || typeof entry?.model !== 'string') {
          continue;
        }
        const key = `${entry.ai} ${entry.model}`;
        if (seenModels.has(key)) continue;
        seenModels.add(key);
        models.push({ ai: entry.ai, model: entry.model });
      }
      return {
        metricCalls,
        evolveOnlyMetricCalls,
        modelCalls,
        ...(observedTokens !== undefined
          ? { totalTokens: observedTokens }
          : {}),
        tokensBasis: rollUpBasis(phases),
        ...(costValid !== undefined ? { costUsd: costValid } : {}),
        costBasis: costValid !== undefined ? 'caller_supplied' : 'unknown',
        wallClockMs: now() - startedAt,
        phases,
        models,
      };
    },
  };
}

/** Phases whose token totals cannot be observed without a caller usage tap. */
export function unobservableTokenPhases(
  accounting: Readonly<AxAgentPlaybookComputeAccounting>
): readonly AxAgentPlaybookComputePhaseName[] {
  return accounting.phases
    .filter((phase) => phase.tokensBasis === 'unobservable')
    .map((phase) => phase.name);
}

/** A zeroed accounting block, for results that never opened a phase. */
export function emptyAccounting(): AxAgentPlaybookComputeAccounting {
  return {
    metricCalls: 0,
    evolveOnlyMetricCalls: 0,
    modelCalls: 0,
    tokensBasis: 'none',
    costBasis: 'unknown',
    wallClockMs: 0,
    phases: [],
    models: [],
  };
}

// ---------------------------------------------------------------------------
// Anchor-vs-candidate overhead
// ---------------------------------------------------------------------------

/** A record the overhead machinery can read attempt counters from. */
export type AxOverheadRecord = Readonly<{
  task: object;
  attempts?: readonly AxAgentPlaybookAttemptRecord[];
}>;

type AttemptCounter = (
  attempt: Readonly<AxAgentPlaybookAttemptRecord>
) => number | undefined;

/**
 * Per-task mean of one attempt counter over the SCORED attempts. Discarded
 * attempts are excluded for the same reason they leave the score denominator:
 * they measure the environment, not the artifact.
 */
function perTaskMean(
  record: AxOverheadRecord,
  counter: AttemptCounter
): number | undefined {
  const values = (record.attempts ?? [])
    .filter((attempt) => attempt.termination.kind !== 'environment_failure')
    .map(counter)
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function measureFrom(args: {
  anchor: readonly AxOverheadRecord[];
  candidate: readonly AxOverheadRecord[];
  counter: AttemptCounter;
  seed: number;
  resamples?: number;
  level?: number;
}): AxAgentPlaybookOverheadMeasure | undefined {
  if (
    args.anchor.length === 0 ||
    args.anchor.length !== args.candidate.length
  ) {
    return undefined;
  }
  const clusters: AxTaskCluster[] = [];
  const anchorValues: number[] = [];
  const candidateValues: number[] = [];
  for (const [index, anchorRecord] of args.anchor.entries()) {
    const candidateRecord = args.candidate[index]!;
    // Pairing is reference equality on the stored task object.
    if (anchorRecord.task !== candidateRecord.task) return undefined;
    const anchorMean = perTaskMean(anchorRecord, args.counter);
    const candidateMean = perTaskMean(candidateRecord, args.counter);
    if (anchorMean === undefined || candidateMean === undefined)
      return undefined;
    anchorValues.push(anchorMean);
    candidateValues.push(candidateMean);
    clusters.push({
      weight: (anchorRecord.task as { weight?: number }).weight ?? 1,
      deltas: [candidateMean - anchorMean],
    });
  }
  const interval = pairedBootstrapInterval({
    clusters,
    seed: args.seed,
    ...(args.resamples !== undefined ? { resamples: args.resamples } : {}),
    ...(args.level !== undefined ? { level: args.level } : {}),
  });
  if (!interval) return undefined;
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const anchorMean = mean(anchorValues);
  const candidateMean = mean(candidateValues);
  const delta = candidateMean - anchorMean;
  return {
    anchorMean,
    candidateMean,
    delta,
    // Undefined rather than Infinity when the anchor cost nothing: a ratio
    // against zero is not a number a reader should act on.
    ...(anchorMean > 0 ? { relativeDelta: delta / anchorMean } : {}),
    interval,
  };
}

/**
 * Turn / call / token cost of the candidate against the anchor, on one split.
 * Reported next to the gain because an accuracy win that costs +44% turns is a
 * different result from one that costs nothing. No gate reads it — a turn-cost
 * threshold is caller policy, not a correctness property.
 */
export function overheadSplitFrom(args: {
  split: 'current' | 'heldOut';
  anchor: readonly AxOverheadRecord[];
  candidate: readonly AxOverheadRecord[];
  seed: number;
  resamples?: number;
  level?: number;
}): AxAgentPlaybookOverheadSplit | undefined {
  const shared = {
    anchor: args.anchor,
    candidate: args.candidate,
    seed: args.seed,
    ...(args.resamples !== undefined ? { resamples: args.resamples } : {}),
    ...(args.level !== undefined ? { level: args.level } : {}),
  };
  const turns = measureFrom({
    ...shared,
    counter: (attempt) => attempt.turnCount,
  });
  const calls = measureFrom({
    ...shared,
    counter: (attempt) => attempt.callCount,
  });
  if (!turns || !calls) return undefined;
  // Tokens are omitted rather than zeroed when no provider reported usage.
  const tokens = measureFrom({
    ...shared,
    counter: (attempt) => attempt.totalTokens,
  });
  return {
    split: args.split,
    turns,
    calls,
    ...(tokens ? { tokens } : {}),
  };
}

export function overheadReportFrom(
  splits: readonly AxAgentPlaybookOverheadSplit[]
): AxAgentPlaybookOverheadReport | undefined {
  if (splits.length === 0) return undefined;
  const relatives: number[] = [];
  for (const split of splits) {
    for (const measure of [split.turns, split.calls, split.tokens]) {
      if (measure?.relativeDelta !== undefined) {
        relatives.push(measure.relativeDelta);
      }
    }
  }
  const worst = relatives.length > 0 ? Math.max(...relatives) : undefined;
  return {
    splits,
    ...(worst !== undefined && worst > 0 ? { worstRelativeDelta: worst } : {}),
  };
}

/**
 * The subset of a run's accounting attributable to named phases, for a report
 * (the variance band, a control arm) that must carry its own cost.
 */
export function accountingForPhases(
  accounting: Readonly<AxAgentPlaybookComputeAccounting>,
  names: readonly AxAgentPlaybookComputePhaseName[]
): AxAgentPlaybookComputeAccounting {
  const wanted = new Set(names);
  const phases = accounting.phases.filter((phase) => wanted.has(phase.name));
  const observed = phases.some((phase) => phase.totalTokens !== undefined)
    ? phases.reduce((sum, phase) => sum + (phase.totalTokens ?? 0), 0)
    : undefined;
  return {
    metricCalls: phases.reduce((sum, phase) => sum + phase.metricCalls, 0),
    // A phase-scoped report has no evolve-only counter of its own: the legacy
    // number describes the whole run, so restating it here would double-count
    // it wherever the scoped block is read beside the run's.
    evolveOnlyMetricCalls: 0,
    modelCalls: phases.reduce((sum, phase) => sum + phase.modelCalls, 0),
    ...(observed !== undefined ? { totalTokens: observed } : {}),
    tokensBasis: rollUpBasis(phases),
    costBasis: 'unknown',
    wallClockMs: phases.reduce((sum, phase) => sum + phase.wallClockMs, 0),
    phases,
    // The models observed in THESE phases only. Copying the run's whole list
    // would let a variance-band accounting name a model that never ran in it.
    models: distinctModels(phases.flatMap((phase) => phase.models ?? [])),
  };
}

function distinctModels(
  entries: readonly AxAgentPlaybookModelIdentity[]
): readonly AxAgentPlaybookModelIdentity[] {
  const seen = new Set<string>();
  const models: AxAgentPlaybookModelIdentity[] = [];
  for (const entry of entries) {
    const key = `${entry.ai} ${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(entry);
  }
  return models;
}

/**
 * Accounting for ONE candidate's own evaluation, so its receipt carries its own
 * cost rather than the running total of every candidate before it. The judge is
 * counted by invocation only — it is reached as an opaque `AxMetricFn`, so its
 * tokens stay `unobservable` rather than being guessed.
 */
export function candidateAccounting(args: {
  metricCalls: number;
  usage: readonly AxProgramUsage[];
  wallClockMs: number;
  usesBuiltInJudge: boolean;
}): AxAgentPlaybookComputeAccounting {
  return phaseAccounting({
    phase: 'candidate_eval',
    metricCalls: args.metricCalls,
    usage: args.usage,
    wallClockMs: args.wallClockMs,
    usesBuiltInJudge: args.usesBuiltInJudge,
    // A candidate block's own evolve-only counter IS its own metric calls: the
    // legacy counter is evolve-only by definition and this block is scoped to
    // one candidate's evaluation, so restating it here is the honest value.
    evolveOnlyMetricCalls: args.metricCalls,
  });
}

/**
 * Accounting for ONE named phase's own spend, so a report that must carry its
 * own cost (a candidate receipt, a control arm) does not restate the running
 * total of everything before it.
 *
 * `evolveOnlyMetricCalls` is a caller decision because it is not derivable from
 * the phase: a candidate evaluation's own metric calls ARE evolve-only, while a
 * control arm's are not (invariant I6 — no new phase moves the legacy counter),
 * and inferring it from the phase name would bury that rule where nobody reads
 * it.
 */
export function phaseAccounting(args: {
  phase: AxAgentPlaybookComputePhaseName;
  metricCalls: number;
  usage: readonly AxProgramUsage[];
  wallClockMs: number;
  usesBuiltInJudge: boolean;
  evolveOnlyMetricCalls: number;
}): AxAgentPlaybookComputeAccounting {
  const observed = args.usage.filter((entry) => tokensOf(entry) !== undefined);
  const totalTokens =
    observed.length > 0
      ? observed.reduce((sum, entry) => sum + (tokensOf(entry) ?? 0), 0)
      : undefined;
  const models: AxAgentPlaybookModelIdentity[] = [];
  const seen = new Set<string>();
  for (const entry of args.usage) {
    if (typeof entry?.ai !== 'string' || typeof entry?.model !== 'string') {
      continue;
    }
    const key = `${entry.ai} ${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ ai: entry.ai, model: entry.model });
  }
  const phases: AxAgentPlaybookComputePhase[] = [
    {
      name: args.phase,
      metricCalls: args.metricCalls,
      modelCalls: 0,
      ...(models.length > 0 ? { models } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      // An evaluation phase reads usage straight off the predictions, so it is
      // observable by construction: nothing reported means 'unreported'.
      tokensBasis:
        args.metricCalls === 0
          ? 'none'
          : observed.length === 0
            ? 'unreported'
            : observed.length >= args.metricCalls
              ? 'observed'
              : 'partial',
      wallClockMs: args.wallClockMs,
    },
  ];
  if (args.usesBuiltInJudge && args.metricCalls > 0) {
    phases.push({
      name: 'judge',
      metricCalls: 0,
      modelCalls: args.metricCalls,
      tokensBasis: 'unobservable',
      wallClockMs: 0,
    });
  }
  return {
    metricCalls: args.metricCalls,
    evolveOnlyMetricCalls: args.evolveOnlyMetricCalls,
    modelCalls: args.usesBuiltInJudge ? args.metricCalls : 0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    tokensBasis: rollUpBasis(phases),
    costBasis: 'unknown',
    wallClockMs: args.wallClockMs,
    phases,
    models,
  };
}
