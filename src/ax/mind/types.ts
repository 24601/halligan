import type { AxAgentCatalogSkill } from '../agent/agentInternal/skillsTypes.js';
import type { AxAIService } from '../ai/types.js';
import type { AxSignature } from '../dsp/sig.js';
import type { AxProgramForwardOptions, AxProgrammable } from '../dsp/types.js';
import type { AxEventContext, AxEventSink } from '../event/types.js';
import type {
  AxTrajectoryStep,
  AxTrajectoryStepClass,
} from '../trajectory/types.js';

export type AxMindThinkerKind = 'monolith' | 'responder' | 'auxiliary';

export interface AxMindSubscription {
  /** Absent means every wakeable narrative and conversational type. */
  readonly types?: readonly string[];
  readonly classes?: readonly AxTrajectoryStepClass[];
  /** Suppression is BY THE STEP'S `source` FIELD, not by process identity. */
  readonly triggerSelf: boolean;
  /** 0 disables. Default 300_000. */
  readonly watchdogMs: number;
  /**
   * Admission bound for this thinker. On reaching it the source stops
   * advancing THIS consumer's cursor; nothing is dropped. Default 4.
   */
  readonly maxInFlight?: number;
}

/** The conservative subscription: reacts to others, never to itself. */
export const axDefaultMindSubscription: Readonly<AxMindSubscription> =
  Object.freeze({
    triggerSelf: false,
    watchdogMs: 300_000,
    maxInFlight: 4,
  } as const);

/**
 * A thinker is AxEventTarget-shaped, on purpose: it composes as a flow node,
 * an event target, and an optimize()/GEPA subject for free. `ai` is required
 * and exactly one of program/createProgram must be supplied, because
 * validateEventTarget (event/mapping.ts) enforces both.
 *
 * The `context` assembler lands with the projection it reads
 * (`AxTrajectoryProjection`, lane A2) in the runtime commit; nothing in the
 * pacing, routing, source, chat, salience or skill machinery needs it.
 */
export interface AxMindThinker<IN = any, OUT = any> {
  readonly name: string;
  readonly kind: AxMindThinkerKind;
  readonly subscription: Readonly<AxMindSubscription>;
  readonly ai: Readonly<AxAIService>;
  readonly program?: AxProgrammable<IN, OUT>;
  readonly createProgram?: (
    instance: Readonly<{ thinker: string; instanceKey: string }>
  ) => AxProgrammable<IN, OUT> | Promise<AxProgrammable<IN, OUT>>;
  /** Required with createProgram when declarative input plans are used. */
  readonly inputSignature?: Readonly<AxSignature>;
  /** Classifies the run's durable effect for pacing. Defaults to the work probe. */
  readonly classify?: (
    result: Readonly<AxMindStepResult<OUT>>
  ) => AxMindWakeOutcome | Promise<AxMindWakeOutcome>;
  readonly forwardOptions?: Readonly<AxProgramForwardOptions<string>>;
  readonly retrySafety?: 'idempotent' | 'effect-aware' | 'unknown';
  readonly sinks?: readonly AxEventSink<OUT>[];
  /** Per-wake ceilings. Never inherited from the mind's total. */
  readonly budget?: Readonly<AxMindThinkerBudget>;
  /** Enables scheduled spontaneity. At most one thinker may set it. */
  readonly pacer?: Readonly<AxMindPacerConfig>;
}

export interface AxMindThinkerBudget {
  readonly maxWallClockMs: number;
  readonly maxTokens: number;
  readonly maxSubRuns: number;
  readonly maxDepth: number;
}
export const axDefaultMindThinkerBudget: Readonly<AxMindThinkerBudget> =
  Object.freeze({
    maxWallClockMs: 600_000,
    maxTokens: 120_000,
    maxSubRuns: 8,
    maxDepth: 2,
  } as const);

export type AxMindWakeClass =
  | 'reactive'
  | 'spontaneous'
  | 'watchdog'
  | 'bootstrap'
  | 'manual'
  | 'noop';

export type AxMindWakeOutcome =
  | 'visible'
  | 'thought'
  | 'empty'
  | 'error'
  | 'noop';

export interface AxMindRoutingSignal {
  readonly code:
    | 'unobserved_action'
    | 'circling_thoughts'
    | 'share_nudge'
    | 'unanswered_message'
    | 'wake_gap'
    | 'health_lag';
  readonly text: string;
}

/** Engagement is defined by VISIBLE EFFECT, never by output volume. */
export interface AxMindWorkProbe {
  readonly lastVisibleStepId?: string;
  readonly lastThoughtStepId?: string;
}
export interface AxMindStepResult<OUT = unknown> {
  readonly output?: OUT;
  readonly error?: unknown;
  readonly before: Readonly<AxMindWorkProbe>;
  readonly after: Readonly<AxMindWorkProbe>;
}

export interface AxMindPacerConfig {
  /** delay(n>=1) = min(baseMs * factor^(n-1), capMs). delay(0) = 0. */
  readonly baseMs: number;
  readonly factor: number;
  /** The documented cost knob. */
  readonly capMs: number;
  /** Empty wakes at a level before descending. */
  readonly hold: number;
  /** Separate ceiling for thought-only runs. */
  readonly thoughtCapMs: number;
  /**
   * Absolute fuse. Derived from capMs as ceil(3_600_000/capMs * 1.5) when
   * omitted. Exceeding it PARKS spontaneity; reactive wakes continue.
   */
  readonly maxWakesPerHour?: number;
}
export const axDefaultMindPacerConfig: Readonly<AxMindPacerConfig> =
  Object.freeze({
    baseMs: 5_000,
    factor: 2,
    capMs: 300_000,
    hold: 3,
    thoughtCapMs: 60_000,
  } as const);

export interface AxMindPacerState {
  readonly level: number;
  readonly ticks: number;
  readonly wakeAt?: number;
  readonly lastOutcome?: AxMindWakeOutcome;
  readonly lastWakeClass?: AxMindWakeClass;
  /** Rolling epoch-ms stamps used by the rate fuse. Oldest first. */
  readonly spontaneousWakes: readonly number[];
  readonly parked?: 'rate_fuse';
}
export const axInitialMindPacerState: Readonly<AxMindPacerState> =
  Object.freeze({
    level: 0,
    ticks: 0,
    spontaneousWakes: Object.freeze([]),
  } as const);

/** `'unchanged'` means LEAVE THE RUNNING TIMER ALONE. */
export type AxMindPaceDecision =
  | Readonly<{ kind: 'arm'; state: AxMindPacerState; delayMs: number }>
  | Readonly<{ kind: 'unchanged'; state: AxMindPacerState }>;

/**
 * OPTIONAL single-owner lease guard. It is NOT an authority for pacer state
 * (that is the trajectory). Its only job is to make a second owner on the
 * same trajectory fail loudly rather than silently double the wake rate.
 */
export interface AxMindOwnershipStore {
  load(
    mindId: string,
    signal?: AbortSignal
  ): Promise<Readonly<{ ownerId: string; revision: number }> | undefined>;
  compareAndSet(
    mindId: string,
    expectedRevision: number | undefined,
    ownerId: string,
    signal?: AbortSignal
  ): Promise<Readonly<{ revision: number }>>;
}

export type AxMindHealthState =
  | 'healthy'
  | 'lagging'
  | 'stalled'
  | 'errored'
  | 'idle';

/** Health is LAG, not liveness. Every process can be alive while nothing is consumed. */
export interface AxMindHealth {
  readonly state: AxMindHealthState;
  readonly newestStepSeq: number;
  readonly newestStepAt: number;
  readonly newestProcessedSeq: number;
  readonly lagSteps: number;
  readonly lagMs: number;
  readonly lastDispatchAt?: number;
  readonly lastErrorAt?: number;
  readonly lastError?: string;
  /** Durability the mind actually got, reported not assumed. */
  readonly durability: Readonly<{
    trajectory: 'volatile' | 'persistent';
    events: 'volatile' | 'persistent';
  }>;
  readonly thinkers: readonly Readonly<AxMindThinkerHealth>[];
}
export interface AxMindThinkerHealth {
  readonly thinker: string;
  readonly running: number;
  readonly deferred: number;
  readonly newestProcessedSeq: number;
  readonly lastWakeAt?: number;
  readonly nextWakeAt?: number;
  readonly pacer?: Readonly<AxMindPacerState>;
  readonly consecutiveErrors: number;
  readonly lastOutcome?: AxMindWakeOutcome;
}
export interface AxMindHealthThresholds {
  /** Lag above this many steps flips to 'lagging'. Default 25. */
  readonly lagSteps?: number;
  /** Lag above this flips to 'stalled'. Default 2 * max(watchdogMs, capMs). */
  readonly stalledMs?: number;
}

export interface AxMindGoal {
  readonly id: string;
  readonly content: string;
  readonly priority: number;
  /** Uses AxACEBulletLifecycle vocabulary verbatim. */
  readonly status: 'active' | 'deprecated' | 'superseded';
  readonly supersededBy?: string;
  readonly expiresAt?: string;
  readonly reason?: string;
}

export interface AxMindSkill extends AxAgentCatalogSkill {
  /** Matched against HOST FACTS only. Model text can never satisfy one. */
  readonly requires?: Readonly<{
    env?: readonly string[];
    capabilities?: readonly string[];
    os?: readonly string[];
  }>;
}

/**
 * Host-editable artifacts: the versioned-harness seam. The writer half
 * (`AxMindArtifactSource.write`, its change and receipt records) lands with
 * the runtime that mediates it; nothing may edit an artifact without an
 * out-of-band host receipt.
 */
export interface AxMindArtifacts {
  /** Opaque identity of this artifact set. Stamped on every run step. */
  readonly revision: string;
  readonly persona: string;
  readonly thinkerPrompts: Readonly<Record<string, string>>;
  readonly goals: readonly Readonly<AxMindGoal>[];
  readonly skills: readonly Readonly<AxMindSkill>[];
  readonly kernelSkillIds?: readonly string[];
  /** Default 8000. */
  readonly kernelTokenBudget?: number;
}

export type AxMindReplyDecision = 'replied' | 'no-reply' | 'reply-failed';
export type AxMindReplyState =
  | 'answered'
  | 'declined'
  | 'claimed'
  | 'unanswered';

export interface AxMindReplyResolution {
  readonly state: AxMindReplyState;
  readonly evidenceStepId?: string;
  /** True when a claim was treated as stale because its time was unreadable. */
  readonly failedOpen: boolean;
  /** True when the bounded window missed the trigger and a wider read ran. */
  readonly widened: boolean;
}

export interface AxMindChatMessage {
  readonly from?: string;
  readonly to: string;
  readonly content: string;
  /** Stamped at the transport. Inferred when omitted. */
  readonly replyTo?: string;
}

export interface AxMindSendReceipt {
  readonly externalId?: string;
  readonly at: number;
}

export interface AxMindChatTransport {
  readonly id: string;
  /** Host-owned. The mind never picks its own from-identity. */
  readonly selfName: string;
  /** Called from inside a ledger effect. Must be idempotent on idempotencyKey. */
  send(
    message: Readonly<AxMindChatMessage>,
    context: Readonly<{
      idempotencyKey: string;
      effectId: string;
      signal: AbortSignal;
    }>
  ): Promise<Readonly<AxMindSendReceipt>>;
}

/**
 * The effect-ledger slice an outbound send needs. A real `AxEventContext`
 * satisfies it structurally, which is how a thinker reaches it: through
 * `extra.eventContext`, never through a ledger of the mind's own.
 */
export type AxMindEffectLedger = Readonly<
  Pick<
    AxEventContext,
    'declareEffect' | 'markEffectDispatched' | 'settleEffect' | 'listEffects'
  >
>;

export interface AxMindChat {
  /** Unsolicited outbound. Declares, dispatches and settles one effect. */
  send(
    message: Readonly<AxMindChatMessage>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>>;
  /** Guarded reply. Refuses unless replyState is `unanswered`. */
  reply(
    message: Readonly<AxMindChatMessage>,
    signal?: AbortSignal
  ): Promise<
    Readonly<{
      sent: boolean;
      step?: Readonly<AxTrajectoryStep>;
      reason?: 'already_answered' | 'declined' | 'claimed';
    }>
  >;
  claim(
    triggerStepId: string,
    signal?: AbortSignal
  ): Promise<Readonly<{ claimId: string; expiresAt: number }>>;
  replyState(
    triggerStepId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxMindReplyResolution>>;
  recordDecision(
    decision: AxMindReplyDecision,
    triggerStepId: string,
    note?: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>>;
}

export interface AxMindSalienceItem {
  readonly sourceStepId: string;
  readonly text: string;
  readonly createdAt: number;
}
export interface AxMindSalienceBuffer {
  /** False when this sourceStepId was already offered to ANY thinker. */
  offer(item: Readonly<AxMindSalienceItem>): boolean;
  take(thinker: string): Readonly<AxMindSalienceItem> | undefined;
  readonly size: number;
}

export class AxMindConfigurationError extends Error {
  readonly code = 'mind_configuration_invalid';
  constructor(
    message: string,
    readonly reason:
      | 'duplicate_thinker'
      | 'multiple_pacers'
      | 'clock_mismatch'
      | 'volatile_trajectory_store'
      | 'effect_store_required'
      | 'unknown_trajectory'
      | 'reserved_namespace'
      | 'append_atomicity_required',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxMindConfigurationError';
  }
}

export class AxMindChatError extends Error {
  readonly code = 'mind_chat_refused';
  constructor(
    message: string,
    readonly reason:
      | 'self_addressed'
      | 'already_answered'
      | 'claimed'
      | 'empty_content'
      | 'no_transport'
      | 'send_indeterminate'
      /**
       * The step a reply-state question names is not in this log. Reporting
       * `unanswered` for a step the log cannot see would authorize a reply to
       * a message that does not exist here, so it fails closed instead.
       */
      | 'unknown_trigger',
    readonly evidenceStepId?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxMindChatError';
  }
}

export class AxMindBudgetExceededError extends Error {
  readonly code = 'mind_budget_exceeded';
  constructor(
    readonly dimension: 'wallClock' | 'tokens' | 'subRuns' | 'depth',
    readonly limit: number,
    options?: ErrorOptions
  ) {
    super(`mind budget exceeded: ${dimension} over ${limit}`, options);
    this.name = 'AxMindBudgetExceededError';
  }
}

export class AxMindLivenessError extends Error {
  readonly code = 'mind_liveness';
  constructor(
    message: string,
    readonly reason:
      | 'stalled'
      | 'pacer_parked'
      | 'source_failed'
      | 'close_from_inside',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxMindLivenessError';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/** Structural guards, for errors that cross a host/adapter/realm boundary. */
export function axIsMindChatError(error: unknown): error is AxMindChatError {
  return (
    hasCode(error, 'mind_chat_refused') &&
    typeof (error as AxMindChatError).reason === 'string'
  );
}

export function axIsMindBudgetExceededError(
  error: unknown
): error is AxMindBudgetExceededError {
  return (
    hasCode(error, 'mind_budget_exceeded') &&
    typeof (error as AxMindBudgetExceededError).dimension === 'string' &&
    typeof (error as AxMindBudgetExceededError).limit === 'number'
  );
}

export function axIsMindConfigurationError(
  error: unknown
): error is AxMindConfigurationError {
  return (
    hasCode(error, 'mind_configuration_invalid') &&
    typeof (error as AxMindConfigurationError).reason === 'string'
  );
}

export type AxMindDiagnosticCode =
  | 'wake-suppressed-self'
  | 'wake-coalesced'
  | 'wake-deferred-backpressure'
  | 'watchdog-fired'
  | 'wake-gap-noted'
  | 'context-assembly-failed'
  | 'salience-injected'
  | 'reply-duplicate-suppressed'
  | 'reply-claim-stale'
  | 'skill-demoted-over-budget'
  | 'unknown-step-type'
  | 'pacer-rate-fuse'
  | 'effect-step-reconciled'
  | 'cursor-paused';

export interface AxMindDiagnostic {
  readonly code: AxMindDiagnosticCode;
  readonly thinker?: string;
  readonly stepId?: string;
  readonly at: number;
  readonly message: string;
}
