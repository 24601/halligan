import type { AxEventStore } from '../event/types.js';
import type { AxTrajectoryStore } from '../trajectory/types.js';
import {
  type AxMindHealth,
  type AxMindHealthState,
  type AxMindHealthThresholds,
  type AxMindThinkerHealth,
  axDefaultMindPacerConfig,
  axDefaultMindSubscription,
} from './types.js';

const DEFAULT_LAG_STEPS = 25;

/**
 * `2 x max(watchdogMs, capMs)` (RFC 5.2): two full windows of the SLOWER of
 * the two clocks that legitimately keep a mind quiet. A constant derived from
 * the defaults alone would put a host with a long watchdog under a stalled
 * threshold inside its own watchdog window, and read a legitimate quiet period
 * as a stall.
 */
export function axMindStalledThreshold(
  windows?: Readonly<{ watchdogMs?: number; capMs?: number }>
): number {
  return (
    2 *
    Math.max(
      windows?.watchdogMs ?? axDefaultMindSubscription.watchdogMs,
      windows?.capMs ?? axDefaultMindPacerConfig.capMs
    )
  );
}

/**
 * Health is LAG -- newest appended versus newest processed -- and never
 * liveness. Every handle in the process can be alive while nothing is being
 * consumed, which is exactly the blindness a "the loop is running" check
 * cannot detect.
 */
export function axMindHealthState(
  health: Omit<AxMindHealth, 'state'>,
  thresholds?: Readonly<AxMindHealthThresholds>
): AxMindHealthState {
  const lagSteps = thresholds?.lagSteps ?? DEFAULT_LAG_STEPS;
  const stalledMs = thresholds?.stalledMs ?? axMindStalledThreshold();
  if (health.lagSteps > 0 && health.lagMs > stalledMs) return 'stalled';
  // An errored run is a DISTINCT STATE from an idle one, in the log and here:
  // a mind that keeps failing must never read as calm resting.
  if (health.thinkers.some((thinker) => thinker.consecutiveErrors > 0)) {
    return 'errored';
  }
  if (health.lagSteps > lagSteps) return 'lagging';
  if (
    health.lagSteps === 0 &&
    health.thinkers.every((thinker) => thinker.running === 0)
  ) {
    return 'idle';
  }
  return 'healthy';
}

export interface AxMindHealthInput {
  readonly newestStepSeq: number;
  readonly newestStepAt: number;
  readonly now: number;
  /** When the oldest unconsumed step was appended; how long lag has lasted. */
  readonly oldestUnprocessedAt?: number;
  readonly thinkers: readonly Readonly<AxMindThinkerHealth>[];
  readonly durability: AxMindHealth['durability'];
  readonly lastDispatchAt?: number;
  readonly lastErrorAt?: number;
  readonly lastError?: string;
}

/**
 * Derived, never persisted. A persisted health number is a lie waiting to
 * happen; this is recomputed from the store and the per-consumer cursors.
 */
export function axMindHealth(
  input: Readonly<AxMindHealthInput>,
  thresholds?: Readonly<AxMindHealthThresholds>
): Readonly<AxMindHealth> {
  // The slowest consumer defines the mind's lag: one thinker keeping up says
  // nothing about the wakes another one has not taken yet.
  const newestProcessedSeq = input.thinkers.length
    ? Math.min(...input.thinkers.map((thinker) => thinker.newestProcessedSeq))
    : input.newestStepSeq;
  const lagSteps = Math.max(0, input.newestStepSeq - newestProcessedSeq);
  const lagMs =
    lagSteps === 0
      ? 0
      : Math.max(
          0,
          input.now - (input.oldestUnprocessedAt ?? input.newestStepAt)
        );
  const partial: Omit<AxMindHealth, 'state'> = {
    newestStepSeq: input.newestStepSeq,
    newestStepAt: input.newestStepAt,
    newestProcessedSeq,
    lagSteps,
    lagMs,
    ...(input.lastDispatchAt !== undefined
      ? { lastDispatchAt: input.lastDispatchAt }
      : {}),
    ...(input.lastErrorAt !== undefined
      ? { lastErrorAt: input.lastErrorAt }
      : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    durability: input.durability,
    thinkers: Object.freeze([...input.thinkers]),
  };
  return Object.freeze({
    ...partial,
    state: axMindHealthState(partial, thresholds),
  });
}

/**
 * The durability the mind ACTUALLY got, read off the stores rather than
 * assumed. A volatile trajectory store with a persistent event store is a
 * legal configuration and a very different set of guarantees.
 */
export function axMindStoreDurability(
  trajectory: Readonly<AxTrajectoryStore>,
  events?: Readonly<AxEventStore>
): AxMindHealth['durability'] {
  return Object.freeze({
    trajectory: trajectory.capabilities.durability,
    events: events?.capabilities.durability ?? 'volatile',
  });
}

/**
 * Reports on TRANSITION only. A health callback that fires per tick is noise
 * a host learns to ignore, which is how a real transition gets missed.
 */
export function axMindHealthReporter(
  onHealth?: (health: Readonly<AxMindHealth>) => void
): (health: Readonly<AxMindHealth>) => void {
  let previous: AxMindHealthState | undefined;
  return (health) => {
    if (health.state === previous) return;
    previous = health.state;
    onHealth?.(health);
  };
}
