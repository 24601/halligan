import type { AxEventIngress } from '../event/types.js';
import type { AxTrajectoryProjection } from '../trajectory/projection.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import { axMindEventTypes } from './routes.js';
import type {
  AxMindHealthState,
  AxMindRoutingSignal,
  AxMindWakeClass,
} from './types.js';

/** Consecutive thoughts with nothing visible between them before it is worth saying. */
export const axMindCirclingThoughts = 3;

/**
 * Which kind of wake this delivery is. The envelope decides, never the
 * thinker: a spontaneous wake and a reactive one land on the same route and
 * take different rows of the pacing ladder.
 */
export function axMindWakeClass(
  ingress: Readonly<AxEventIngress>
): AxMindWakeClass {
  switch (ingress.event.type) {
    case axMindEventTypes.wake:
      return 'spontaneous';
    case axMindEventTypes.idle:
      return 'watchdog';
    case axMindEventTypes.bootstrap:
      return 'bootstrap';
    default:
      return ingress.event.subject === 'manual-trigger' ? 'manual' : 'reactive';
  }
}

/**
 * A paced, watchdog or bootstrap wake has NO step behind it. Synthesizing one
 * -- negative `seq`, the wake's own machinery type -- is honest; handing the
 * assembler some unrelated newest step would make `trigger` a lie, and a
 * `trigger` a reader cannot trust is worse than one that is obviously absent.
 */
export function axMindSyntheticTrigger(
  ingress: Readonly<AxEventIngress>,
  options: Readonly<{
    trajectoryId: string;
    wakeClass: AxMindWakeClass;
    now: number;
  }>
): Readonly<AxTrajectoryStep> {
  const type = options.wakeClass === 'watchdog' ? 'mind-idle' : 'mind-wake';
  return Object.freeze({
    stepId: ingress.event.id,
    trajectoryId: options.trajectoryId,
    seq: -1,
    type,
    ts: options.now,
    data: Object.freeze({ wakeClass: options.wakeClass, synthetic: true }),
  });
}

export interface AxMindRoutingSignalInput {
  readonly projection: Readonly<AxTrajectoryProjection>;
  /** Wakes since this thinker last produced anything visible. */
  readonly wakesSinceShare: number;
  /** 0 disables the nudge entirely. */
  readonly shareNudgeEvery: number;
  readonly health: AxMindHealthState;
  readonly lagSteps: number;
  /** Set once, on the first wake after a restart that spanned a gap. */
  readonly wakeGap?: Readonly<AxMindRoutingSignal>;
  /** The writer identity inbound conversation arrives under. */
  readonly inboundSource: string;
}

/**
 * Deterministic HINTS, never rules. There is deliberately no priority ladder
 * here: a ladder is how a mind gets stuck in one lane, and the RFC's own
 * position is that what to do next is the model's decision. Every signal is
 * computed from the bounded projection the model is about to read, so a
 * signal can never describe a fact the model cannot see.
 */
export function axMindRoutingSignals(
  input: Readonly<AxMindRoutingSignalInput>
): readonly Readonly<AxMindRoutingSignal>[] {
  const signals: Readonly<AxMindRoutingSignal>[] = [];
  const recent = input.projection.recent;
  const lastAction = recent.findLast((step) => step.type === 'action');
  const lastObservation = recent.findLast(
    (step) => step.type === 'observation'
  );
  if (
    lastAction &&
    (!lastObservation || lastObservation.seq < lastAction.seq)
  ) {
    signals.push({
      code: 'unobserved_action',
      text: `Your most recent action (step ${lastAction.stepId}) has no observation after it yet.`,
    });
  }
  let thoughts = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    if (recent[index]?.type !== 'thought') break;
    thoughts++;
  }
  if (thoughts >= axMindCirclingThoughts) {
    signals.push({
      code: 'circling_thoughts',
      text: `Your last ${thoughts} steps were all thoughts, with nothing visible between them.`,
    });
  }
  if (
    input.shareNudgeEvery > 0 &&
    input.wakesSinceShare >= input.shareNudgeEvery
  ) {
    // Counter-pressure against restraint ratcheting: a mind that is rewarded
    // for staying quiet gets quieter every wake until it stops existing.
    signals.push({
      code: 'share_nudge',
      text: `You have woken ${input.wakesSinceShare} times without sharing anything with anyone.`,
    });
  }
  const lastInbound = recent.findLast(
    (step) => step.type === 'message' && step.source === input.inboundSource
  );
  const lastOutbound = recent.findLast(
    (step) =>
      step.type === 'message' &&
      step.source !== undefined &&
      step.source !== input.inboundSource
  );
  if (lastInbound && (!lastOutbound || lastOutbound.seq < lastInbound.seq)) {
    signals.push({
      code: 'unanswered_message',
      text: `Step ${lastInbound.stepId} is an inbound message with no reply after it.`,
    });
  }
  if (input.health === 'lagging' || input.health === 'stalled') {
    signals.push({
      code: 'health_lag',
      text: `The mind is ${input.health}: ${input.lagSteps} steps behind.`,
    });
  }
  if (input.wakeGap) signals.push(input.wakeGap);
  return Object.freeze(signals);
}
