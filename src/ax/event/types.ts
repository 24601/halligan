import type { AxAIService } from '../ai/types.js';
import type { AxSignature } from '../dsp/sig.js';
import type {
  AxGenDeltaOut,
  AxProgramForwardOptions,
  AxProgrammable,
} from '../dsp/types.js';

export type AxEventTrust = 'trusted' | 'authenticated' | 'untrusted';

export type AxEventScalar = string | number | boolean | null;
export type AxEventValue =
  | AxEventScalar
  | readonly AxEventValue[]
  | { readonly [key: string]: AxEventValue };

export interface AxEventEnvelope<T = AxEventValue> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject?: string;
  time?: string;
  datacontenttype?: string;
  dataschema?: string;
  data?: T;
  extensions?: Readonly<Record<string, AxEventScalar>>;
}

export interface AxEventIdentity {
  tenantId?: string;
  accountId?: string;
  userId?: string;
  sessionId?: string;
}

export interface AxEventCorrelationKey {
  kind: string;
  value: string;
}

export interface AxEventIngress<T = AxEventValue> {
  event: Readonly<AxEventEnvelope<T>>;
  identity?: Readonly<AxEventIdentity>;
  trust?: AxEventTrust;
  correlation?: readonly Readonly<AxEventCorrelationKey>[];
  partitionKey?: string;
}

export interface AxEventPublishReceipt {
  eventId: string;
  accepted: boolean;
  duplicate: boolean;
  durability: 'volatile' | 'persistent';
  deliveryIds: readonly string[];
}

export interface AxEventClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AxSystemEventClock implements AxEventClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, Math.max(0, ms));
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  }
}

/** Deterministic clock for conformance tests, replay, and host schedulers. */
export class AxManualEventClock implements AxEventClock {
  private sleepers: Array<{
    at: number;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];

  constructor(private value = 0) {}

  now(): number {
    return this.value;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sleeper = { at: this.value + ms, resolve, reject };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((value) => value !== sleeper);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  }

  advanceBy(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(
        'AxManualEventClock advanceBy requires a non-negative value'
      );
    }
    this.value += ms;
    const ready = this.sleepers.filter((sleeper) => sleeper.at <= this.value);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper.at > this.value);
    for (const sleeper of ready) sleeper.resolve();
  }

  set(time: number): void {
    if (time < this.value)
      throw new Error('AxManualEventClock cannot move backwards');
    this.advanceBy(time - this.value);
  }
}

export class AxEventBackpressureError extends Error {
  constructor(message = 'AxEventRuntime inbox capacity was exhausted') {
    super(message);
    this.name = 'AxEventBackpressureError';
  }
}

export class AxEventContinuationNotFoundError extends Error {
  constructor(readonly correlation: Readonly<AxEventCorrelationKey>) {
    super(
      `No active event continuation owns ${correlation.kind}:${correlation.value}`
    );
    this.name = 'AxEventContinuationNotFoundError';
  }
}

export class AxEventOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AxEventOutcomeUnknownError';
  }
}

export class AxEventInputError extends Error {
  readonly code = 'event_input_invalid';

  constructor(message: string, options?: ErrorOptions) {
    super(`event_input_invalid: ${message}`, options);
    this.name = 'AxEventInputError';
  }
}

export class AxEventOutputPersistenceError extends Error {
  readonly code = 'output_persistence_failed';

  constructor(
    message: string,
    readonly phase: 'preflight' | 'stage' | 'commit' | 'recovery',
    options?: ErrorOptions
  ) {
    super(`output_persistence_failed: ${message}`, options);
    this.name = 'AxEventOutputPersistenceError';
  }
}

/** Cross-realm guard for stores loaded through another package instance. */
export function axIsEventOutputPersistenceError(
  error: unknown
): error is AxEventOutputPersistenceError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; phase?: unknown };
  return (
    candidate.code === 'output_persistence_failed' &&
    (candidate.phase === 'preflight' ||
      candidate.phase === 'stage' ||
      candidate.phase === 'commit' ||
      candidate.phase === 'recovery')
  );
}

export type AxEventRouteAction = 'observe' | 'invalidate' | 'resume' | 'wake';

export interface AxEventMatcher {
  sources?: readonly string[];
  types?: readonly string[];
  subjects?: readonly string[];
  extensions?: Readonly<Record<string, AxEventScalar>>;
}

export interface AxEventContinuationRegistration {
  correlation: readonly Readonly<AxEventCorrelationKey>[];
  expiresAt?: number;
  metadata?: Readonly<Record<string, AxEventValue>>;
}

export interface AxEventContinuation {
  id: string;
  targetId: string;
  routeId: string;
  instanceKey: string;
  identityScope: string;
  correlation: readonly Readonly<AxEventCorrelationKey>[];
  createdAt: number;
  expiresAt?: number;
  stateVersion?: number;
  metadata?: Readonly<Record<string, AxEventValue>>;
}

export type AxEventEffectStatus =
  | 'intent'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'parked';

export interface AxEventEffectIntent {
  /** Stable domain operation name, such as `payments.capture`. */
  operation: string;
  /** Stable key that the effect implementation must pass to the provider. */
  idempotencyKey: string;
  /** Declare idempotent only when replay with the same key is safe. */
  replaySafety?: 'idempotent' | 'unknown';
  /**
   * Persistable, redacted request descriptor bound to this effect identity.
   * Include every request field whose change must make key reuse fail closed.
   * Credentials do not belong here.
   */
  metadata?: Readonly<Record<string, AxEventValue>>;
}

export interface AxEventEffect {
  id: string;
  deliveryId: string;
  runId: string;
  identityScope: string;
  operation: string;
  idempotencyKey: string;
  replaySafety: 'idempotent' | 'unknown';
  /** SHA-256 of the canonical operation, key, safety, and metadata bytes. */
  requestDigest: string;
  status: AxEventEffectStatus;
  metadata?: Readonly<Record<string, AxEventValue>>;
  receipt?: AxEventValue;
  error?: string;
  parkedReason?: string;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  settledAt?: number;
  dispatchCount: number;
  version: number;
}

export type AxEventEffectSettlement =
  | Readonly<{ status: 'succeeded'; receipt?: AxEventValue }>
  | Readonly<{
      status: 'failed';
      receipt?: AxEventValue;
      error?: string;
    }>;

export interface AxEventEffectCreateRequest extends AxEventEffectIntent {
  id: string;
  deliveryId: string;
  runId: string;
  identityScope: string;
  createdAt: number;
}

export type AxEventEffectTransition =
  | Readonly<{ type: 'dispatched'; at: number }>
  | Readonly<{
      type: 'settled';
      at: number;
      settlement: Readonly<AxEventEffectSettlement>;
    }>
  | Readonly<{ type: 'parked'; at: number; reason: string }>
  | Readonly<{ type: 'not_dispatched'; at: number }>;

export type AxEventEffectResolution =
  | Readonly<{ status: 'succeeded'; receipt?: AxEventValue }>
  | Readonly<{
      status: 'failed';
      receipt?: AxEventValue;
      error?: string;
    }>
  | Readonly<{ status: 'not_dispatched' }>
  | Readonly<{ status: 'indeterminate' }>
  | Readonly<{ status: 'parked'; reason: string }>;

export interface AxEventEffectResolverContext {
  readonly delivery: Readonly<AxEventDelivery>;
  readonly abortSignal: AbortSignal;
}

export type AxEventEffectResolver = (
  effect: Readonly<AxEventEffect>,
  context: Readonly<AxEventEffectResolverContext>
) => AxEventEffectResolution | Promise<Readonly<AxEventEffectResolution>>;

export interface AxEventEffectFence {
  deliveryId: string;
  fencingToken: number;
}

export interface AxEventContext {
  readonly runtimeId: string;
  readonly runId: string;
  readonly deliveryId: string;
  readonly routeId: string;
  readonly targetId?: string;
  readonly instanceKey: string;
  readonly ingress: Readonly<AxEventIngress>;
  readonly identity: Readonly<AxEventIdentity>;
  readonly trust: AxEventTrust;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly fencingToken?: number;
  readonly abortSignal: AbortSignal;
  readonly continuation?: Readonly<AxEventContinuation>;
  registerContinuation(
    registration: Readonly<AxEventContinuationRegistration>
  ): string;
  declareEffect(
    intent: Readonly<AxEventEffectIntent>
  ): Promise<Readonly<AxEventEffect>>;
  markEffectDispatched(
    effectId: string,
    expectedVersion: number
  ): Promise<Readonly<AxEventEffect>>;
  settleEffect(
    effectId: string,
    expectedVersion: number,
    settlement: Readonly<AxEventEffectSettlement>
  ): Promise<Readonly<AxEventEffect>>;
  listEffects(): Promise<readonly Readonly<AxEventEffect>[]>;
}

export type AxEventInheritance = 'all' | 'none';

export interface AxProgramStateEnvelope {
  schemaVersion: number;
  programVersion: string;
  revision: number;
  state: unknown;
  updatedAt: number;
}

export interface AxProgramStateStore {
  load(key: string): Promise<Readonly<AxProgramStateEnvelope> | undefined>;
  compareAndSet(
    key: string,
    expectedRevision: number | undefined,
    state: Readonly<Omit<AxProgramStateEnvelope, 'revision'>>,
    fence?: Readonly<{ deliveryId: string; fencingToken: number }>
  ): Promise<Readonly<AxProgramStateEnvelope>>;
  delete(key: string): Promise<void>;
}

export interface AxEventProgramStateAdapter<P = AxProgrammable<any, any>> {
  schemaVersion: number;
  programVersion: string;
  restore(program: P, state: unknown): void | Promise<void>;
  capture(program: P): unknown | Promise<unknown>;
  migrateState?(
    args: Readonly<{
      state: unknown;
      fromSchemaVersion: number;
      fromProgramVersion: string;
      toSchemaVersion: number;
      toProgramVersion: string;
    }>
  ): unknown | Promise<unknown>;
}

export interface AxEventTargetInputContext {
  eventContext: Readonly<AxEventContext>;
  continuation?: Readonly<AxEventContinuation>;
}

export type AxEventPathSegment = string | number;

export type AxEventPathRoot =
  | 'constant'
  | 'correlation'
  | 'data'
  | 'envelope'
  | 'extensions'
  | 'identity'
  | 'trust'
  | 'continuation';

/** Immutable, segment-safe selector over an event ingress and continuation. */
export interface AxEventPath<T = unknown> {
  readonly root: AxEventPathRoot;
  readonly segments?: readonly AxEventPathSegment[];
  readonly correlationKind?: string;
  readonly value?: T;
}

export interface AxEventInputFieldMapping {
  readonly field: string;
  readonly path: Readonly<AxEventPath>;
}

export interface AxEventInputPlan<IN = any> {
  readonly project?: Readonly<AxEventPath>;
  readonly fields: readonly Readonly<AxEventInputFieldMapping>[];
  /** Phantom type used for contextual target input inference. */
  readonly __input?: IN;
}

export interface AxEventInputBuilder<IN = any> {
  project(path: Readonly<AxEventPath>): AxEventInputBuilder<IN>;
  field<K extends Extract<keyof IN, string>>(
    field: K,
    path: Readonly<AxEventPath>
  ): AxEventInputBuilder<IN>;
  build(): Readonly<AxEventInputPlan<IN>>;
}

export type AxEventInputDefinition<IN = any> =
  | Readonly<AxEventInputPlan<IN>>
  | Readonly<AxEventInputBuilder<IN>>
  | ((
      builder: AxEventInputBuilder<IN>
    ) => Readonly<AxEventInputPlan<IN>> | Readonly<AxEventInputBuilder<IN>>);

export interface AxEventContinuationPlan {
  readonly kind: string;
  readonly value: Readonly<AxEventPath>;
  readonly expiresInMs?: number;
  readonly metadata?: Readonly<Record<string, Readonly<AxEventPath>>>;
}

export interface AxEventTarget<IN = any, OUT = any> {
  id: string;
  ai: Readonly<AxAIService>;
  program?: AxProgrammable<IN, OUT>;
  createProgram?: (
    instance: Readonly<{
      targetId: string;
      instanceKey: string;
      identity: Readonly<AxEventIdentity>;
    }>
  ) => AxProgrammable<IN, OUT> | Promise<AxProgrammable<IN, OUT>>;
  /** Required when createProgram is combined with declarative input plans. */
  inputSignature?: Readonly<AxSignature>;
  input?: Readonly<AxEventInputPlan<IN>>;
  wakeInput?: Readonly<AxEventInputPlan<IN>>;
  resumeInput?: Readonly<AxEventInputPlan<IN>>;
  waitFor?: readonly Readonly<AxEventContinuationPlan>[];
  mapInput?: (
    ingress: Readonly<AxEventIngress>,
    context: Readonly<AxEventTargetInputContext>
  ) => IN | Promise<IN>;
  forwardOptions?: Readonly<AxProgramForwardOptions<string>>;
  execution?: 'forward' | 'streaming';
  state?: AxEventProgramStateAdapter<AxProgrammable<IN, OUT>>;
  sinks?: readonly AxEventSink<OUT>[];
  retrySafety?: 'idempotent' | 'effect-aware' | 'unknown';
}

export interface AxEventSinkContext<OUT = unknown> {
  run: Readonly<AxEventRun<OUT>>;
  eventContext: Readonly<AxEventContext>;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface AxEventSink<OUT = unknown> {
  id: string;
  write(
    output: OUT,
    context: Readonly<AxEventSinkContext<OUT>>
  ): void | Promise<void>;
  writeChunk?(
    chunk: Readonly<AxGenDeltaOut<OUT>>,
    context: Readonly<AxEventSinkContext<OUT>>
  ): void | Promise<void>;
}

export interface AxEventInvalidator {
  invalidate(
    ingress: Readonly<AxEventIngress>,
    context: Readonly<AxEventContext>
  ): void | Promise<void>;
}

export interface AxEventRoute {
  id: string;
  match:
    | Readonly<AxEventMatcher>
    | ((ingress: Readonly<AxEventIngress>) => boolean | Promise<boolean>);
  action: AxEventRouteAction;
  target?: AxEventTarget<any, any>;
  instanceKey?: (ingress: Readonly<AxEventIngress>) => string | Promise<string>;
  requireAuthenticated?: boolean;
  authorize?: (ingress: Readonly<AxEventIngress>) => boolean | Promise<boolean>;
  observe?: (
    ingress: Readonly<AxEventIngress>,
    context: Readonly<AxEventContext>
  ) => void | Promise<void>;
  invalidator?: AxEventInvalidator;
  correlation?: (
    ingress: Readonly<AxEventIngress>
  ) => Readonly<AxEventCorrelationKey> | undefined;
  /** Hold matching deliveries for this long before they become claimable. */
  debounceMs?: number;
  /** Explicitly replace an older queued delivery in the debounce window. */
  coalesce?: 'latest';
  /** Allow this route to run out of order for the same target/instance. */
  ordering?: 'strict' | 'relaxed';
}

export type AxEventDeliveryStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting_event'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'dead_lettered'
  | 'output_persistence_failed'
  | 'parked'
  | 'outcome_unknown';

export interface AxEventDelivery {
  id: string;
  sequence: number;
  ingress: Readonly<AxEventIngress>;
  identityScope: string;
  routeId: string;
  action: AxEventRouteAction;
  targetId?: string;
  instanceKey: string;
  status: AxEventDeliveryStatus;
  attempt: number;
  availableAt: number;
  acceptedAt: number;
  claimedBy?: string;
  runId?: string;
  error?: string;
  sizeBytes: number;
  retrySafety: 'idempotent' | 'effect-aware' | 'unknown';
  ordering: 'strict' | 'relaxed';
  leaseExpiresAt?: number;
  fencingToken?: number;
  invocationStarted?: boolean;
  recoveredFromExpiredLease?: boolean;
}

export type AxEventRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_event'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'output_persistence_failed'
  | 'parked'
  | 'outcome_unknown';

export interface AxEventSinkAttempt {
  sinkId: string;
  attempts: number;
  status: 'pending' | 'succeeded' | 'failed';
  error?: string;
}

export interface AxEventRun<OUT = unknown> {
  id: string;
  deliveryId: string;
  routeId: string;
  targetId?: string;
  instanceKey: string;
  /** Immutable continuation admission used by resume retries and recovery. */
  admittedContinuation?: Readonly<AxEventContinuation>;
  /** Worker owning the fenced claim when this run record was written. */
  claimedBy?: string;
  status: AxEventRunStatus;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  output?: OUT;
  chunks?: readonly AxGenDeltaOut<OUT>[];
  error?: string;
  continuationIds?: readonly string[];
  sinks?: readonly AxEventSinkAttempt[];
  fencingToken?: number;
  outputRef?: string;
}

export interface AxEventDeadLetter {
  id: string;
  kind: 'delivery' | 'sink';
  deliveryId: string;
  runId?: string;
  sinkId?: string;
  reason: string;
  createdAt: number;
}

export interface AxEventStoreCapabilities {
  durability: 'volatile' | 'persistent';
  coordination: 'single-worker' | 'multi-worker';
  leases: boolean;
  transactions: boolean;
  compareAndSet: boolean;
  outputPersistence: boolean;
  effectLedger?: boolean;
  conformance?: Readonly<{ multiWorker?: string; schemaVersion?: number }>;
}

export interface AxEventEnqueueRequest {
  ingress: Readonly<AxEventIngress>;
  deliveries: readonly Readonly<
    Pick<
      AxEventDelivery,
      'routeId' | 'action' | 'targetId' | 'instanceKey' | 'sizeBytes'
    > & {
      availableAt?: number;
      coalesce?: 'latest';
      retrySafety?: 'idempotent' | 'effect-aware' | 'unknown';
      ordering?: 'strict' | 'relaxed';
    }
  >[];
  acceptedAt: number;
  publishTimeoutMs: number;
}

export interface AxEventStore {
  readonly capabilities: Readonly<AxEventStoreCapabilities>;
  enqueue(
    request: Readonly<AxEventEnqueueRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt>;
  claim(
    workerId: string,
    now: number,
    leaseMs?: number
  ): Promise<AxEventDelivery | undefined>;
  renewClaim(
    deliveryId: string,
    workerId: string,
    fencingToken: number,
    leaseExpiresAt: number
  ): Promise<void>;
  getDelivery(
    deliveryId: string
  ): Promise<Readonly<AxEventDelivery> | undefined>;
  saveDelivery(delivery: Readonly<AxEventDelivery>): Promise<void>;
  saveRun(run: Readonly<AxEventRun>): Promise<void>;
  getRun(runId: string): Promise<Readonly<AxEventRun> | undefined>;
  registerContinuation(
    continuation: Readonly<AxEventContinuation>
  ): Promise<void>;
  findContinuation(
    identityScope: string,
    correlation: Readonly<AxEventCorrelationKey>,
    now: number
  ): Promise<Readonly<AxEventContinuation> | undefined>;
  completeContinuation(id: string): Promise<void>;
  addDeadLetter(deadLetter: Readonly<AxEventDeadLetter>): Promise<void>;
  getDeadLetter(id: string): Promise<Readonly<AxEventDeadLetter> | undefined>;
  removeDeadLetter(id: string): Promise<void>;
  listDeadLetters(): Promise<readonly Readonly<AxEventDeadLetter>[]>;
  redriveDelivery(deliveryId: string, now: number): Promise<void>;
  nextAvailableAt(now: number): Promise<number | undefined>;
  waitForWork(signal?: AbortSignal): Promise<void>;
  isIdle(): Promise<boolean>;
  close?(): void | Promise<void>;
}

/** Opt-in effect journal extension; legacy AxEventStore implementations remain valid. */
export interface AxEventEffectStore extends AxEventStore {
  readonly capabilities: Readonly<
    AxEventStoreCapabilities & { effectLedger: true }
  >;
  declareEffect(
    request: Readonly<AxEventEffectCreateRequest>,
    fence: Readonly<AxEventEffectFence>
  ): Promise<Readonly<AxEventEffect>>;
  transitionEffect(
    effectId: string,
    expectedVersion: number,
    transition: Readonly<AxEventEffectTransition>,
    fence: Readonly<AxEventEffectFence>
  ): Promise<Readonly<AxEventEffect>>;
  listEffects(deliveryId: string): Promise<readonly Readonly<AxEventEffect>[]>;
}

export interface AxEventSourceHandle {
  close(): void | Promise<void>;
}

export interface AxEventSourceContext {
  signal: AbortSignal;
  publish(
    ingress: Readonly<AxEventIngress>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt>;
  reportError(error: unknown): void;
}

export interface AxEventSource {
  id: string;
  requiresDurable?: boolean;
  start(
    context: Readonly<AxEventSourceContext>
  ): undefined | AxEventSourceHandle | Promise<AxEventSourceHandle | undefined>;
}

export interface AxEventRuntimeOptions {
  id?: string;
  routes: readonly AxEventRoute[];
  sources?: readonly AxEventSource[];
  store?: AxEventStore;
  programStateStore?: AxProgramStateStore;
  clock?: AxEventClock;
  workerId?: string;
  workerConcurrency?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  publishTimeoutMs?: number;
  allowVolatile?: boolean;
  onSourceError?: (sourceId: string, error: unknown) => void | Promise<void>;
  coordination?: 'single-worker' | 'multi-worker';
  leaseMs?: number;
  heartbeatMs?: number;
  /** Reconciles dispatched effects during retry/recovery; it never runs for new intent. */
  effectResolver?: AxEventEffectResolver;
  /** Maximum resolver duration before the effect is parked. Defaults to 30 seconds. */
  effectResolverTimeoutMs?: number;
}

export interface AxEventPayloadStore {
  put(key: string, value: unknown): Promise<string>;
  get(reference: string): Promise<unknown>;
  delete(reference: string): Promise<void>;
}

export interface AxEventPayloadStageRequest {
  /** Host-assigned operation identity; reuse must be idempotent for the same payload. */
  stageId: string;
  key: string;
  value: unknown;
  sizeBytes: number;
  /** Uncommitted ownership must be reclaimed by this time. */
  expiresAt: number;
  signal: AbortSignal;
}

/**
 * Optional bounded ownership protocol for payloads that cannot be stored inline.
 *
 * Distinct stage IDs may resolve to one shared content reference. abort() releases
 * only the named stage's ownership and must remain safe after an uncertain commit.
 * All operations are idempotent; an aborted stage can never be resurrected.
 */
export interface AxEventStagedPayloadStore extends AxEventPayloadStore {
  stage(
    request: Readonly<AxEventPayloadStageRequest>
  ): Promise<Readonly<{ reference: string }>>;
  commit(stageId: string, signal: AbortSignal): Promise<void>;
  abort(stageId: string, signal: AbortSignal): Promise<void>;
}

export interface AxEventCloseOptions {
  drain?: boolean;
  /** One host-time return deadline for source, drain, worker, and store shutdown. */
  timeoutMs?: number;
}
