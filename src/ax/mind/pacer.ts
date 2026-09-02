import type {
  AxTrajectoryFieldValue,
  AxTrajectoryStore,
  AxTrajectoryTypeRegistry,
} from '../trajectory/types.js';
import {
  type AxMindPaceDecision,
  type AxMindPacerConfig,
  type AxMindPacerState,
  type AxMindStepResult,
  type AxMindWakeClass,
  type AxMindWakeOutcome,
  type AxMindWorkProbe,
  axDefaultMindPacerConfig,
  axInitialMindPacerState,
} from './types.js';

const HOUR_MS = 3_600_000;

/** The durable pace record. A machinery type, so it carries no `source`. */
export const axMindPaceStepType = 'mind-wake';

/** delay(0) = 0; delay(n >= 1) = min(baseMs * factor^(n-1), capMs). */
export function axMindPaceDelay(
  level: number,
  config: Readonly<AxMindPacerConfig> = axDefaultMindPacerConfig
): number {
  if (level <= 0) return 0;
  return Math.min(config.baseMs * config.factor ** (level - 1), config.capMs);
}

/**
 * The absolute fuse, derived from the cost knob when not stated.
 *
 * `ceil(3_600_000/capMs x 1.5)` is the STEADY-STATE tolerance only. A descent
 * from engagement additionally costs `hold` wakes at every level on the way
 * down, and on the shipped defaults that descent (21) is larger than the
 * steady-state figure (18): deriving the fuse from the steady state alone
 * parked a default-configured mind under eight minutes into every quiet
 * period, so the documented "12 wakes/hour at capMs = 300_000" was a state the
 * shipped default could never occupy. The fuse is an absolute ceiling on a
 * bounded ladder, not a rate limit; a host that wants a tighter one states
 * `maxWakesPerHour` outright.
 */
export function axMindPacerFuse(
  config: Readonly<AxMindPacerConfig> = axDefaultMindPacerConfig
): number {
  if (config.maxWakesPerHour !== undefined) return config.maxWakesPerHour;
  const levels =
    config.factor > 1 && config.capMs > config.baseMs
      ? Math.ceil(
          Math.log(config.capMs / config.baseMs) / Math.log(config.factor)
        ) + 1
      : 1;
  return Math.ceil((HOUR_MS / config.capMs) * 1.5) + config.hold * levels;
}

/** Wake classes that mean "a human or a host is engaged with this mind". */
function engaged(wakeClass: AxMindWakeClass, outcome: AxMindWakeOutcome) {
  return (
    wakeClass === 'reactive' ||
    wakeClass === 'bootstrap' ||
    wakeClass === 'manual' ||
    outcome === 'visible'
  );
}

/**
 * The whole ladder in one pure function. No clock, no IO, no store: the
 * caller supplies `now`, so a test advances time by choosing a number.
 *
 * `unchanged` is not "no state change" -- the rolling fuse window still
 * advances -- it is "DO NOT TOUCH THE RUNNING TIMER". Re-arming on a no-op
 * silently resets the backoff on every outgoing reply (M8).
 */
export function axNextMindPace(
  state: Readonly<AxMindPacerState>,
  event: Readonly<{
    wakeClass: AxMindWakeClass;
    outcome: AxMindWakeOutcome;
    now: number;
  }>,
  config: Readonly<AxMindPacerConfig> = axDefaultMindPacerConfig
): AxMindPaceDecision {
  const cutoff = event.now - HOUR_MS;
  const kept = state.spontaneousWakes.filter((at) => at > cutoff);
  // A spontaneous wake costs money whatever it returns, so the fuse counts it
  // by wake class and never by outcome. Reactive wakes are excluded: they only
  // happen when a human is talking.
  const spontaneousWakes =
    event.wakeClass === 'spontaneous' ? [...kept, event.now] : kept;
  const carry = {
    lastOutcome: event.outcome,
    lastWakeClass: event.wakeClass,
    spontaneousWakes: Object.freeze(spontaneousWakes),
  };
  const hold = () =>
    ({
      ...(state.wakeAt !== undefined ? { wakeAt: state.wakeAt } : {}),
      level: state.level,
      ticks: state.ticks,
      ...carry,
    }) as const;

  // The fuse outranks every row: exceeding it parks spontaneity outright.
  // Reactive DELIVERIES keep running -- routes never consult the pacer -- but
  // nothing arms another spontaneous wake until the hour window drains.
  if (spontaneousWakes.length >= axMindPacerFuse(config)) {
    // The oldest wake in the window leaves it one hour after it happened, and
    // that is the first moment the fuse can read differently. Publishing it
    // is what lets a caller arm one re-evaluation rather than re-firing the
    // stale `wakeAt` this state deliberately keeps.
    const parkedUntil = (spontaneousWakes[0] ?? event.now) + HOUR_MS;
    return {
      kind: 'unchanged',
      state: Object.freeze({
        ...hold(),
        parked: 'rate_fuse' as const,
        parkedUntil,
      }),
    };
  }
  if (event.outcome === 'noop' || event.wakeClass === 'noop') {
    return { kind: 'unchanged', state: Object.freeze(hold()) };
  }

  let level = state.level;
  let ticks = state.ticks;
  let delayMs: number;
  if (engaged(event.wakeClass, event.outcome)) {
    level = 0;
    ticks = 0;
    delayMs = 0;
  } else if (event.outcome === 'error') {
    // A crash must never masquerade as calm resting: descend with no dwell.
    level = state.level + 1;
    ticks = 0;
    delayMs = axMindPaceDelay(level, config);
  } else {
    const next = ticks + 1;
    if (next >= config.hold) {
      level = state.level + 1;
      ticks = 0;
    } else {
      ticks = next;
    }
    delayMs = axMindPaceDelay(level, config);
    if (event.outcome === 'thought') {
      delayMs = Math.min(delayMs, config.thoughtCapMs);
    }
  }
  return {
    kind: 'arm',
    delayMs,
    state: Object.freeze({
      level,
      ticks,
      wakeAt: event.now + delayMs,
      ...carry,
    }),
  };
}

/** The fields a pace record carries, so recovery and the log agree on one shape. */
export function axMindPaceStepData(
  record: Readonly<{
    wakeClass: AxMindWakeClass;
    outcome: AxMindWakeOutcome;
    decision: Readonly<AxMindPaceDecision>;
  }>
): Readonly<Record<string, AxTrajectoryFieldValue>> {
  const { decision } = record;
  return Object.freeze({
    wakeClass: record.wakeClass,
    outcome: record.outcome,
    paceDecision: decision.kind,
    delayMs: decision.kind === 'arm' ? decision.delayMs : 0,
    level: decision.state.level,
    ticks: decision.state.ticks,
    ...(decision.state.wakeAt !== undefined
      ? { wakeAt: decision.state.wakeAt }
      : {}),
    ...(decision.state.parked ? { parked: decision.state.parked } : {}),
    ...(decision.state.parkedUntil !== undefined
      ? { parkedUntil: decision.state.parkedUntil }
      : {}),
  });
}

function integer(value: AxTrajectoryFieldValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function outcomeOf(
  value: AxTrajectoryFieldValue | undefined
): AxMindWakeOutcome | undefined {
  return typeof value === 'string' ? (value as AxMindWakeOutcome) : undefined;
}

/**
 * Rebuilds pacer state from the trajectory alone (I3 / crash C12). There is
 * no second authority for pacing state: a store that lost its process still
 * knows how fast it was allowed to wake, so a crash loop cannot restore
 * full-speed spontaneous waking.
 */
export async function axRecoverMindPacerState(
  store: AxTrajectoryStore,
  trajectoryId: string,
  thinker: string,
  config: Readonly<AxMindPacerConfig> = axDefaultMindPacerConfig,
  signal?: AbortSignal
): Promise<Readonly<AxMindPacerState>> {
  const fuse = axMindPacerFuse(config);
  // One more than the fuse: if every record read is inside the hour window the
  // fuse is already tripped, so a wider read could not change the verdict.
  const limit = Math.max(fuse + 1, 8);
  const tail = await store.tailBackward(
    { trajectoryId, types: [axMindPaceStepType], limit },
    signal
  );
  const mine = tail.steps.filter((step) => step.launchedBy === thinker);
  const newest = mine.at(-1);
  if (!newest) return axInitialMindPacerState;
  const cutoff = newest.ts - HOUR_MS;
  const spontaneousWakes = mine
    .filter((step) => step.data.wakeClass === 'spontaneous' && step.ts > cutoff)
    .map((step) => step.ts);
  const wakeAt = newest.data.wakeAt;
  const lastOutcome = outcomeOf(newest.data.outcome);
  const lastWakeClass = newest.data.wakeClass;
  return Object.freeze({
    level: integer(newest.data.level),
    ticks: integer(newest.data.ticks),
    ...(typeof wakeAt === 'number' && Number.isFinite(wakeAt)
      ? { wakeAt }
      : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    ...(typeof lastWakeClass === 'string'
      ? { lastWakeClass: lastWakeClass as AxMindWakeClass }
      : {}),
    spontaneousWakes: Object.freeze(spontaneousWakes),
    ...(spontaneousWakes.length >= fuse
      ? {
          parked: 'rate_fuse' as const,
          parkedUntil: (spontaneousWakes[0] ?? newest.ts) + HOUR_MS,
        }
      : {}),
  });
}

/** Registry-derived: what counts as visible work is a declared step property. */
export function axMindVisibleStepTypes(
  registry: AxTrajectoryTypeRegistry
): readonly string[] {
  return registry.types
    .filter((descriptor) => descriptor.visibleWork === true)
    .map((descriptor) => descriptor.type);
}

/**
 * Two bounded filtered tails, never a parse of model output. "Nothing
 * changed" is a thought, not work.
 */
export async function axMindWorkProbe(
  store: AxTrajectoryStore,
  trajectoryId: string,
  registry: AxTrajectoryTypeRegistry,
  signal?: AbortSignal
): Promise<Readonly<AxMindWorkProbe>> {
  const [visible, thought] = await Promise.all([
    store.tailBackward(
      { trajectoryId, limit: 1, types: axMindVisibleStepTypes(registry) },
      signal
    ),
    store.tailBackward({ trajectoryId, limit: 1, types: ['thought'] }, signal),
  ]);
  const lastVisibleStepId = visible.steps.at(-1)?.stepId;
  const lastThoughtStepId = thought.steps.at(-1)?.stepId;
  return Object.freeze({
    ...(lastVisibleStepId ? { lastVisibleStepId } : {}),
    ...(lastThoughtStepId ? { lastThoughtStepId } : {}),
  });
}

/** Engagement is visible effect; a throw is an error, never calm resting. */
export function axMindWakeOutcomeOf(
  result: Readonly<AxMindStepResult>
): AxMindWakeOutcome {
  if (result.error !== undefined) return 'error';
  if (result.after.lastVisibleStepId !== result.before.lastVisibleStepId) {
    return 'visible';
  }
  if (result.after.lastThoughtStepId !== result.before.lastThoughtStepId) {
    return 'thought';
  }
  return 'empty';
}
