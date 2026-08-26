import { AxAgentClarificationError } from '../agent/agentInternal/agentStateTypes.js';
import { axAuthorize, axSnapshotAuthority } from '../authority/authority.js';
import type { AxAuthorityContext } from '../authority/types.js';
import type { AxGenDeltaOut, AxProgrammable } from '../dsp/types.js';
import { AxEventComponentManager } from './components.js';
import {
  AxEventRouteBuilder,
  AxEventTargetBuilder,
  mapEventInput,
  normalizeEventInputValue,
  resolveEventPath,
  selectEventInputPlan,
  validateEventRoute,
  validateEventTarget,
  verifyEventTargetProgram,
} from './mapping.js';
import {
  AxInMemoryEventStore,
  AxInMemoryProgramStateStore,
} from './memoryStore.js';
import {
  type AxEventCloseOptions,
  type AxEventContext,
  type AxEventContinuation,
  AxEventContinuationNotFoundError,
  type AxEventContinuationRegistration,
  type AxEventDeadLetter,
  type AxEventDelivery,
  type AxEventEffect,
  type AxEventEffectFence,
  type AxEventEffectIntent,
  type AxEventEffectResolution,
  type AxEventEffectSettlement,
  type AxEventEffectStore,
  type AxEventIngress,
  AxEventInputError,
  AxEventOutcomeUnknownError,
  AxEventOutputPersistenceError,
  type AxEventProgramStateAdapter,
  type AxEventPublishReceipt,
  type AxEventRoute,
  type AxEventRun,
  type AxEventRuntimeOptions,
  type AxEventSink,
  type AxEventStore,
  type AxEventTarget,
  type AxEventValue,
  type AxEventVerificationResult,
  type AxEventVerifierContext,
  type AxEventVerifierPolicy,
  type AxProgramStateEnvelope,
  AxSystemEventClock,
  axIsEventOutputPersistenceError,
} from './types.js';
import {
  axEventCanonicalJson,
  axEventContinuationFingerprint,
  axEventErrorMessage,
  axEventId,
  axEventIdentityScope,
  axEventMatches,
  axEventSizeBytes,
  axValidateEventEnvelope,
} from './util.js';

type AnyProgram = AxProgrammable<any, any>;

type InvocationResult = {
  output?: unknown;
  chunks?: AxGenDeltaOut<unknown>[];
  waiting: boolean;
  invoked: boolean;
};

type VerifierPolicyState = {
  startedAt: number;
  runs: number;
  tokens: number;
  costUSD: number;
  lastFingerprint?: string;
  lastFailure?: Readonly<{ code: string; evidence?: AxEventValue }>;
};

type VerificationOutcome = {
  verification: Readonly<AxEventVerificationResult>;
  continuation?: Readonly<{
    value: AxEventContinuation;
    ingress: AxEventIngress;
    availableAt: number;
  }>;
};

const VERIFIER_SOURCE = 'ax://event-runtime/verifier';
const VERIFIER_CODE_BYTES = 256;
const VERIFIER_FINGERPRINT_BYTES = 1_024;
const VERIFIER_ERROR_BYTES = 1_024;
const DEFAULT_AUTHORITY_RESOLVE_TIMEOUT_MS = 30_000;

function combineAbortSignals(...signals: readonly AbortSignal[]): AbortSignal {
  return AbortSignal.any([...signals]);
}

function verifierRouteId(target: Readonly<AxEventTarget>): string {
  return `ax.verifier:${target.id}:${target.verifier!.id}`;
}

function verifierEventType(target: Readonly<AxEventTarget>): string {
  return `ax.event.verifier.resume.${encodeURIComponent(target.id)}.${encodeURIComponent(target.verifier!.id)}`;
}

function isEffectStore(store: AxEventStore): store is AxEventEffectStore {
  const candidate = store as Partial<AxEventEffectStore>;
  return (
    store.capabilities.effectLedger === true &&
    typeof candidate.declareEffect === 'function' &&
    typeof candidate.transitionEffect === 'function' &&
    typeof candidate.listEffects === 'function'
  );
}

function closeTimerNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

class AxRuntimeEventContext implements AxEventContext {
  private readonly registrations: Array<{
    id: string;
    value: Readonly<AxEventContinuationRegistration>;
  }> = [];
  private readonly afterRegistrationCallbacks: Array<
    () => void | Promise<void>
  > = [];

  constructor(
    readonly runtimeId: string,
    readonly runId: string,
    readonly deliveryId: string,
    readonly routeId: string,
    readonly targetId: string | undefined,
    readonly instanceKey: string,
    readonly ingress: Readonly<AxEventIngress>,
    readonly identity: Readonly<NonNullable<AxEventIngress['identity']>>,
    readonly trust: NonNullable<AxEventIngress['trust']>,
    readonly attempt: number,
    readonly idempotencyKey: string,
    readonly abortSignal: AbortSignal,
    readonly authority?: Readonly<AxAuthorityContext>,
    readonly continuation?: Readonly<AxEventContinuation>,
    readonly fencingToken?: number,
    private readonly store?: AxEventStore,
    private readonly now: () => number = Date.now,
    private readonly runtimeRevoked: () => boolean = () => false
  ) {}

  registerContinuation(
    registration: Readonly<AxEventContinuationRegistration>
  ): string {
    this.assertActive();
    if (registration.correlation.length === 0) {
      throw new Error(
        'Event continuations require at least one correlation key'
      );
    }
    for (const correlation of registration.correlation) {
      if (!correlation.kind.trim() || !correlation.value.trim()) {
        throw new Error(
          'Event continuation correlation values must be non-empty'
        );
      }
    }
    const id = axEventId('continuation');
    this.registrations.push({ id, value: structuredClone(registration) });
    return id;
  }

  afterContinuationsRegistered(callback: () => void | Promise<void>): void {
    this.assertActive();
    this.afterRegistrationCallbacks.push(callback);
  }

  async declareEffect(
    intent: Readonly<AxEventEffectIntent>
  ): Promise<Readonly<AxEventEffect>> {
    this.assertActive();
    const store = this.effectStore();
    const effect = await store.declareEffect(
      {
        ...structuredClone(intent),
        id: axEventId('effect'),
        deliveryId: this.deliveryId,
        runId: this.runId,
        identityScope: axEventIdentityScope(this.identity),
        createdAt: this.now(),
      },
      this.effectFence()
    );
    this.assertActive();
    return effect;
  }

  async markEffectDispatched(
    effectId: string,
    expectedVersion: number
  ): Promise<Readonly<AxEventEffect>> {
    this.assertActive();
    const effect = await this.effectStore().transitionEffect(
      effectId,
      expectedVersion,
      { type: 'dispatched', at: this.now() },
      this.effectFence()
    );
    this.assertActive();
    return effect;
  }

  async settleEffect(
    effectId: string,
    expectedVersion: number,
    settlement: Readonly<AxEventEffectSettlement>
  ): Promise<Readonly<AxEventEffect>> {
    this.assertActive();
    const effect = await this.effectStore().transitionEffect(
      effectId,
      expectedVersion,
      { type: 'settled', at: this.now(), settlement },
      this.effectFence()
    );
    this.assertActive();
    return effect;
  }

  async listEffects(): Promise<readonly Readonly<AxEventEffect>[]> {
    this.assertActive();
    const effects = await this.effectStore().listEffects(this.deliveryId);
    this.assertActive();
    return effects;
  }

  takeRegistrations() {
    return this.registrations.splice(0, this.registrations.length);
  }

  takeAfterRegistrationCallbacks() {
    return this.afterRegistrationCallbacks.splice(
      0,
      this.afterRegistrationCallbacks.length
    );
  }

  private effectStore(): AxEventEffectStore {
    if (!this.store || !isEffectStore(this.store)) {
      throw new Error('AxEventStore does not support the effect ledger');
    }
    return this.store;
  }

  private assertActive(): void {
    if (this.abortSignal.aborted) throw this.abortSignal.reason;
    if (this.runtimeRevoked()) {
      throw new Error('AxEventRuntime store shutdown has started');
    }
  }

  private effectFence(): AxEventEffectFence {
    if (this.fencingToken === undefined) {
      throw new Error('Event effects require a fenced delivery claim');
    }
    return {
      deliveryId: this.deliveryId,
      fencingToken: this.fencingToken,
    };
  }
}

export function eventTarget(id: string): AxEventTargetBuilder;
export function eventTarget<IN, OUT>(
  target: Readonly<AxEventTarget<IN, OUT>>
): AxEventTarget<IN, OUT>;
export function eventTarget<IN, OUT>(
  target: string | Readonly<AxEventTarget<IN, OUT>>
): AxEventTargetBuilder | AxEventTarget<IN, OUT> {
  return typeof target === 'string'
    ? new AxEventTargetBuilder(target)
    : validateEventTarget(target);
}

export function eventRoute(id: string): AxEventRouteBuilder;
export function eventRoute(route: Readonly<AxEventRoute>): AxEventRoute;
export function eventRoute(
  route: string | Readonly<AxEventRoute>
): AxEventRouteBuilder | AxEventRoute {
  return typeof route === 'string'
    ? new AxEventRouteBuilder(route)
    : validateEventRoute(route);
}

export class AxEventRuntime {
  readonly id: string;
  private readonly options: Readonly<AxEventRuntimeOptions>;
  private readonly store;
  private readonly stateStore;
  private readonly clock;
  private readonly routes = new Map<string, AxEventRoute>();
  private readonly targets = new Map<string, AxEventTarget<any, any>>();
  private readonly targetSources = new Map<string, AxEventTarget<any, any>>();
  private readonly singletonTargetInstances = new Map<string, string>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly activeRedriveControllers = new Map<
    string,
    AbortController
  >();
  private readonly deliveryRedriveBarriers = new Map<string, Promise<void>>();
  private readonly inFlightRedriveOperations = new Set<Promise<unknown>>();
  private readonly sourceComponents = new AxEventComponentManager();
  private readonly sourceStartupController = new AbortController();
  private readonly sourceLifetimeController = new AbortController();
  private readonly activeStreamIterators = new Map<
    string,
    AsyncIterator<AxGenDeltaOut<unknown>>
  >();
  private readonly workerController = new AbortController();
  private readonly inFlightPublishes = new Set<Promise<unknown>>();
  private readonly inFlightStoreOperations = new Set<Promise<unknown>>();
  private workerPromises: Promise<void>[] = [];
  private startPromise?: Promise<void>;
  private started = false;
  private closing = false;
  private storeShutdownStarted = false;
  private closePromise?: Promise<void>;

  constructor(options: Readonly<AxEventRuntimeOptions>) {
    this.options = options;
    this.id = options.id ?? axEventId('event-runtime');
    if (
      options.clock &&
      options.store?.clock &&
      options.clock !== options.store.clock
    ) {
      throw new Error(
        'AxEventRuntime and AxEventStore must use the same AxEventClock instance'
      );
    }
    this.clock =
      options.clock ?? options.store?.clock ?? new AxSystemEventClock();
    this.store =
      options.store ?? new AxInMemoryEventStore({ clock: this.clock });
    this.stateStore =
      options.programStateStore ?? new AxInMemoryProgramStateStore();
    for (const value of options.routes) {
      const route = eventRoute(value);
      if (this.routes.has(route.id)) {
        throw new Error(`Duplicate AxEventRoute id: ${route.id}`);
      }
      this.routes.set(route.id, route);
      if (route.target) {
        const target = eventTarget(route.target);
        const previous = this.targetSources.get(target.id);
        if (previous && previous !== route.target) {
          throw new Error(`Duplicate AxEventTarget id: ${target.id}`);
        }
        this.targetSources.set(target.id, route.target);
        this.targets.set(target.id, target);
      }
    }
    for (const target of this.targets.values()) {
      if (!target.verifier) continue;
      const route = eventRoute({
        id: verifierRouteId(target),
        match: {
          sources: [VERIFIER_SOURCE],
          types: [verifierEventType(target)],
        },
        action: 'resume',
        target,
        correlation: (ingress) => ({
          kind: 'ax.verifier',
          value: String(
            (ingress.event.data as { continuation: string }).continuation
          ),
        }),
      });
      if (this.routes.has(route.id)) {
        throw new Error(
          `Reserved AxEventRoute id is already configured: ${route.id}`
        );
      }
      this.routes.set(route.id, route);
    }
  }

  async start(): Promise<void> {
    if (this.closing || this.closePromise) {
      throw new Error('AxEventRuntime is closing');
    }
    if (this.startPromise) return this.startPromise;
    const operation = this.startInternal();
    this.startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.closing || this.closePromise) {
      throw new Error('AxEventRuntime is closing');
    }
    if (this.started) return;
    const durableRequired = (this.options.sources ?? []).filter(
      (source) => source.requiresDurable
    );
    if (
      durableRequired.length > 0 &&
      this.store.capabilities.durability !== 'persistent' &&
      !this.options.allowVolatile
    ) {
      throw new Error(
        `Event sources ${durableRequired.map((source) => source.id).join(', ')} require a persistent AxEventStore`
      );
    }
    if (this.options.coordination === 'multi-worker') {
      const capability = this.store.capabilities;
      if (
        capability.coordination !== 'multi-worker' ||
        !capability.leases ||
        !capability.transactions ||
        !capability.compareAndSet ||
        !capability.outputPersistence ||
        !capability.conformance?.multiWorker
      ) {
        throw new Error(
          'AxEventRuntime multi-worker mode requires a conforming persistent store with leases, transactions, compare-and-set, and output persistence'
        );
      }
    }
    if ([...this.targets.values()].some((target) => target.verifier)) {
      if (
        this.store.capabilities.verifierTransitions !==
          'axevent-verifier-transition-v2' ||
        !this.store.transitionVerifier ||
        !this.store.confirmVerifierTransition
      ) {
        throw new Error(
          'Verifier targets require an AxEventStore with axevent-verifier-transition-v2 fenced transitions'
        );
      }
    }
    const effectAwareTargets = [...this.targets.values()].filter(
      (target) => target.retrySafety === 'effect-aware'
    );
    if (
      (this.options.effectResolver || effectAwareTargets.length > 0) &&
      !isEffectStore(this.store)
    ) {
      throw new Error(
        `AxEventRuntime ${
          this.options.effectResolver
            ? 'effectResolver'
            : `configuration for effect-aware targets ${effectAwareTargets.map((target) => target.id).join(', ')}`
        } requires an effect-aware AxEventStore`
      );
    }
    const resumeRoutes = [...this.routes.values()].filter(
      (route) => route.action === 'resume'
    );
    if (
      resumeRoutes.length > 0 &&
      (typeof this.store.admitContinuation !== 'function' ||
        typeof this.store.saveDeliveryAndCompleteContinuation !== 'function')
    ) {
      throw new Error(
        `Resume routes ${resumeRoutes.map((route) => route.id).join(', ')} require atomic continuation admission and delivery completion`
      );
    }
    const leaseMs = this.options.leaseMs ?? 30_000;
    const heartbeatMs = this.options.heartbeatMs ?? Math.floor(leaseMs / 3);
    if (leaseMs < 100 || heartbeatMs < 1 || heartbeatMs >= leaseMs) {
      throw new Error(
        'AxEventRuntime requires 0 < heartbeatMs < leaseMs and leaseMs >= 100'
      );
    }
    const effectResolverTimeoutMs =
      this.options.effectResolverTimeoutMs ?? 30_000;
    if (
      !Number.isFinite(effectResolverTimeoutMs) ||
      effectResolverTimeoutMs <= 0
    ) {
      throw new Error(
        'AxEventRuntime effectResolverTimeoutMs must be a positive finite number'
      );
    }
    const workers = this.options.workerConcurrency ?? 4;
    if (!Number.isInteger(workers) || workers < 1) {
      throw new Error('AxEventRuntime workerConcurrency must be positive');
    }
    this.started = true;
    this.workerPromises = Array.from({ length: workers }, (_, index) =>
      this.workerLoop(`${this.options.workerId ?? this.id}:${index}`)
    );
    try {
      for (const source of this.options.sources ?? []) {
        this.throwIfClosing();
        const componentId = `event-source:${source.id}`;
        await this.sourceComponents.define({
          id: componentId,
          version: '1',
          activate: (context) =>
            context.acquire('source-handle', async (signal) => {
              const handle = await source.start({
                signal: combineAbortSignals(
                  signal,
                  this.sourceLifetimeController.signal
                ),
                publish: (ingress, publishSignal) =>
                  this.publish(ingress, publishSignal),
                reportError: (error) => {
                  try {
                    void Promise.resolve(
                      this.options.onSourceError?.(source.id, error)
                    ).catch(() => undefined);
                  } catch {
                    // Source diagnostics must not change source lifecycle.
                  }
                },
              });
              return {
                value: handle,
                dispose: () => handle?.close(),
              };
            }),
        });
        this.throwIfClosing();
        await this.sourceComponents.activate(componentId, {
          signal: this.sourceStartupController.signal,
        });
        this.throwIfClosing();
      }
    } catch (error) {
      await this.close({ drain: false });
      throw error;
    }
  }

  publish(
    ingress: Readonly<AxEventIngress>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    const operation = this.publishInternal(ingress, signal);
    this.inFlightPublishes.add(operation);
    void operation.then(
      () => this.inFlightPublishes.delete(operation),
      () => this.inFlightPublishes.delete(operation)
    );
    return operation;
  }

  private async publishInternal(
    ingress: Readonly<AxEventIngress>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    if (!this.started) throw new Error('AxEventRuntime must be started first');
    const publishSignal = signal
      ? AbortSignal.any([signal, this.sourceLifetimeController.signal])
      : this.sourceLifetimeController.signal;
    this.assertPublishActive(publishSignal);
    axValidateEventEnvelope(ingress.event);
    if (ingress.event.source.startsWith('ax://event-runtime/')) {
      throw new Error(
        `Public event publish cannot use reserved source ${ingress.event.source}`
      );
    }
    const normalized: AxEventIngress = {
      event: structuredClone(ingress.event),
      identity: structuredClone(ingress.identity ?? {}),
      trust: ingress.trust ?? 'untrusted',
      correlation: structuredClone(ingress.correlation ?? []),
      ...(ingress.partitionKey ? { partitionKey: ingress.partitionKey } : {}),
    };
    const sizeBytes = axEventSizeBytes(normalized);
    const deliveries: Array<{
      routeId: string;
      action: AxEventRoute['action'];
      targetId?: string;
      instanceKey: string;
      sizeBytes: number;
      availableAt: number;
      coalesce?: 'latest';
      ordering?: 'strict' | 'relaxed';
      retrySafety?: 'idempotent' | 'effect-aware' | 'unknown';
    }> = [];
    for (const route of this.routes.values()) {
      this.assertPublishActive(publishSignal);
      if (!(await this.routeMatches(route, normalized, publishSignal)))
        continue;
      const identityScope = axEventIdentityScope(normalized.identity);
      const instanceKey =
        (await route.instanceKey?.(normalized)) ??
        normalized.partitionKey ??
        normalized.event.subject ??
        identityScope;
      this.assertPublishActive(publishSignal);
      deliveries.push({
        routeId: route.id,
        action: route.action,
        ...(route.target ? { targetId: route.target.id } : {}),
        instanceKey,
        sizeBytes,
        availableAt: this.clock.now() + (route.debounceMs ?? 0),
        ...(route.coalesce ? { coalesce: route.coalesce } : {}),
        ordering: route.ordering ?? 'strict',
        retrySafety: route.target
          ? (route.target.retrySafety ?? 'unknown')
          : 'idempotent',
      });
    }
    this.assertPublishActive(publishSignal);
    return this.store.enqueue(
      {
        ingress: normalized,
        deliveries,
        acceptedAt: this.clock.now(),
        publishTimeoutMs: this.options.publishTimeoutMs ?? 5_000,
      },
      publishSignal
    );
  }

  getRun(runId: string): Promise<Readonly<AxEventRun> | undefined> {
    return this.store.getRun(runId);
  }

  async getEffects(
    deliveryId: string
  ): Promise<readonly Readonly<AxEventEffect>[]> {
    if (!isEffectStore(this.store)) {
      throw new Error('AxEventStore does not support the effect ledger');
    }
    return this.store.listEffects(deliveryId);
  }

  listDeadLetters(): Promise<readonly Readonly<AxEventDeadLetter>[]> {
    return this.store.listDeadLetters();
  }

  async redrive(deadLetterId: string): Promise<void> {
    if (this.closing) throw new Error('AxEventRuntime is closing');
    if (this.activeRedriveControllers.has(deadLetterId)) {
      throw new Error(`Dead letter ${deadLetterId} is already being redriven`);
    }
    const controller = new AbortController();
    this.activeRedriveControllers.set(deadLetterId, controller);
    const operation = this.redriveInternal(deadLetterId, controller);
    this.inFlightRedriveOperations.add(operation);
    void operation.then(
      () => this.inFlightRedriveOperations.delete(operation),
      () => this.inFlightRedriveOperations.delete(operation)
    );
    return operation;
  }

  private async redriveInternal(
    deadLetterId: string,
    controller: AbortController
  ): Promise<void> {
    if (this.closing) throw new Error('AxEventRuntime is closing');
    try {
      const deadLetter = await this.awaitUnlessClosing(
        this.store.getDeadLetter(deadLetterId),
        controller.signal
      );
      if (controller.signal.aborted || this.closing) {
        throw new Error('AxEventRuntime is closing');
      }
      if (!deadLetter)
        throw new Error(`Unknown event dead letter: ${deadLetterId}`);
      if (deadLetter.kind === 'delivery') {
        await this.requeueDeadLetter(deadLetter.deliveryId, deadLetterId);
        return;
      }
      const run = deadLetter.runId
        ? await this.store.getRun(deadLetter.runId)
        : undefined;
      const delivery = await this.store.getDelivery(deadLetter.deliveryId);
      this.assertRunActive(controller.signal);
      if (!run || !delivery || !deadLetter.sinkId || run.output === undefined) {
        throw new Error(`Sink dead letter ${deadLetterId} cannot be redriven`);
      }
      const continuation =
        delivery.action === 'resume'
          ? this.requireResumeAdmission(delivery, run)
          : undefined;
      const targetId = continuation?.targetId ?? run.targetId;
      const target = targetId ? this.targets.get(targetId) : undefined;
      const sink = target?.sinks?.find(
        (value) => value.id === deadLetter.sinkId
      );
      if (!target || !sink) {
        throw new Error(`Sink ${deadLetter.sinkId} is no longer configured`);
      }
      if (controller.signal.aborted || this.closing) {
        throw new Error('AxEventRuntime is closing');
      }
      if (target.retrySafety === 'effect-aware') {
        // Effect-aware sinks must re-enter through the worker so effect ledger
        // mutations run under a newly claimed fence. Persisted completion
        // recovery dispatches only incomplete sinks and never reruns the target.
        await this.requeueDeadLetter(delivery.id, deadLetterId, {
          preserveRun: true,
        });
        return;
      }
      const authority = await this.resolveAuthority(
        delivery.ingress,
        AbortSignal.any([controller.signal, this.workerController.signal])
      );
      this.assertRunActive(controller.signal);
      const context = new AxRuntimeEventContext(
        this.id,
        run.id,
        delivery.id,
        delivery.routeId,
        target.id,
        continuation?.instanceKey ?? delivery.instanceKey,
        delivery.ingress,
        delivery.ingress.identity ?? {},
        delivery.ingress.trust ?? 'untrusted',
        delivery.attempt,
        delivery.id,
        controller.signal,
        authority,
        continuation,
        delivery.fencingToken,
        this.store,
        () => this.clock.now(),
        () => this.storeShutdownStarted
      );
      await this.authorizeEventOperation(
        context,
        'event.sink.write',
        'event.sink',
        sink.id
      );
      this.assertRunActive(controller.signal);
      await sink.write(run.output, {
        run,
        eventContext: context,
        idempotencyKey: `${run.id}:${sink.id}`,
        signal: controller.signal,
      });
      this.assertRunActive(controller.signal);
      await this.store.removeDeadLetter(deadLetterId);
    } finally {
      this.activeRedriveControllers.delete(deadLetterId);
    }
  }

  cancelRun(runId: string, reason = 'Cancelled by caller'): boolean {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = this.clock.now() + timeoutMs;
    while (!(await this.store.isIdle()) || this.activeRuns.size > 0) {
      if (this.clock.now() >= deadline) {
        throw new Error(
          `AxEventRuntime did not become idle within ${timeoutMs}ms`
        );
      }
      await this.clock.sleep(10);
    }
  }

  async close(options: Readonly<AxEventCloseOptions> = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(
        'AxEventRuntime close timeoutMs must be finite and non-negative'
      );
    }
    this.closing = true;
    this.sourceStartupController.abort('AxEventRuntime closing');
    this.sourceLifetimeController.abort('AxEventRuntime closing');
    this.sourceComponents.abortAll('AxEventRuntime closing');
    this.closePromise = this.performClose(options, timeoutMs);
    return this.closePromise;
  }

  private async performClose(
    options: Readonly<AxEventCloseOptions>,
    timeoutMs: number
  ): Promise<void> {
    // Shutdown's return guarantee must not depend on a replay/manual event
    // clock advancing. Host timers remain independent from event-time control.
    const deadline = closeTimerNow() + timeoutMs;
    const componentCleanup = Promise.resolve().then(() =>
      this.sourceComponents.dispose(undefined, { timeoutMs })
    );
    await this.waitUntilCloseDeadline(
      Promise.allSettled([componentCleanup]),
      deadline
    );
    await this.waitUntilCloseDeadline(
      this.waitForTrackedOperations(this.inFlightPublishes),
      deadline
    );
    const abortOperations = () => {
      this.workerController.abort('AxEventRuntime closed');
      for (const controller of this.activeRuns.values()) {
        controller.abort('AxEventRuntime closed');
      }
      for (const controller of this.activeRedriveControllers.values()) {
        controller.abort('AxEventRuntime closed');
      }
      for (const iterator of this.activeStreamIterators.values()) {
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => undefined);
      }
    };
    if (options.drain === false) abortOperations();
    if (options.drain !== false) {
      try {
        await this.waitUntilCloseDeadline(
          this.waitForIdle(timeoutMs),
          deadline
        );
      } catch {
        // The abort below makes unfinished volatile deliveries visible again on
        // an explicit redrive rather than hiding the shutdown failure.
      }
      abortOperations();
    }
    await this.waitUntilCloseDeadline(
      Promise.allSettled([
        ...this.workerPromises,
        ...this.inFlightRedriveOperations,
        this.waitForTrackedOperations(this.inFlightStoreOperations),
      ]),
      deadline
    );
    // A non-cooperative worker must not prevent the store's own best-effort
    // shutdown from ever starting. Rejections are observed but close remains a
    // bounded, non-throwing revocation attempt.
    this.storeShutdownStarted = true;
    const storeClose = Promise.resolve()
      .then(() => this.store.close?.())
      .catch(() => undefined);
    await this.waitUntilCloseDeadline(storeClose, deadline);
    this.started = false;
  }

  private throwIfClosing(): void {
    if (this.closing) throw new Error('AxEventRuntime is closing');
  }

  private async waitUntilCloseDeadline(
    operation: PromiseLike<unknown>,
    deadline: number
  ): Promise<void> {
    const settled = Promise.resolve(operation);
    const remaining = Math.max(0, deadline - closeTimerNow());
    if (remaining === 0) {
      void settled.catch(() => undefined);
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, remaining);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async waitForTrackedOperations(
    operations: ReadonlySet<Promise<unknown>>
  ): Promise<void> {
    while (operations.size > 0) {
      await Promise.allSettled([...operations]);
    }
  }

  private trackStoreOperation<T>(operation: Promise<T>): Promise<T> {
    this.inFlightStoreOperations.add(operation);
    void operation.then(
      () => this.inFlightStoreOperations.delete(operation),
      () => this.inFlightStoreOperations.delete(operation)
    );
    return operation;
  }

  private async routeMatches(
    route: Readonly<AxEventRoute>,
    ingress: Readonly<AxEventIngress>,
    signal: AbortSignal
  ): Promise<boolean> {
    this.assertPublishActive(signal);
    if (
      route.requireAuthenticated &&
      ingress.trust !== 'authenticated' &&
      ingress.trust !== 'trusted'
    ) {
      return false;
    }
    const matches =
      typeof route.match === 'function'
        ? await route.match(ingress)
        : axEventMatches(ingress, route.match);
    this.assertPublishActive(signal);
    if (!matches) return false;
    const authorized = (await route.authorize?.(ingress)) ?? true;
    this.assertPublishActive(signal);
    return authorized;
  }

  private async workerLoop(workerId: string): Promise<void> {
    const signal = this.workerController.signal;
    while (!signal.aborted) {
      let delivery: Readonly<AxEventDelivery> | undefined;
      try {
        delivery = await this.store.claim(
          workerId,
          this.clock.now(),
          this.options.leaseMs ?? 30_000
        );
      } catch {
        if (signal.aborted) return;
        try {
          await this.clock.sleep(25, signal);
        } catch {
          return;
        }
        continue;
      }
      if (!delivery) {
        try {
          const now = this.clock.now();
          const next = await this.store.nextAvailableAt(now);
          if (next === undefined) {
            await this.store.waitForWork(signal);
          } else if (next <= now) {
            await Promise.resolve();
          } else {
            await this.clock.sleep(next - now, signal);
          }
        } catch {
          if (signal.aborted) return;
          try {
            await this.clock.sleep(25, signal);
          } catch {
            return;
          }
        }
        continue;
      }
      await this.processDelivery(delivery, workerId).catch(() => undefined);
    }
  }

  private async processDelivery(
    initialClaim: Readonly<AxEventDelivery>,
    workerId: string
  ): Promise<void> {
    const redriveBarrier = this.deliveryRedriveBarriers.get(initialClaim.id);
    if (redriveBarrier) await redriveBarrier;
    if (this.workerController.signal.aborted || this.storeShutdownStarted)
      return;
    let claimed = initialClaim;
    let previousRun =
      claimed.recoveredFromExpiredLease && claimed.runId
        ? await this.store.getRun(claimed.runId)
        : undefined;
    if (this.workerController.signal.aborted || this.storeShutdownStarted)
      return;
    if (
      claimed.recoveredFromExpiredLease &&
      claimed.invocationStarted &&
      claimed.retrySafety !== 'idempotent' &&
      claimed.retrySafety !== 'effect-aware' &&
      previousRun?.status !== 'succeeded'
    ) {
      await this.parkOutcomeUnknownEffects(claimed);
      const reason =
        'outcome_unknown: expired worker lease after invocation started';
      await this.store.saveDelivery({
        ...claimed,
        status: 'outcome_unknown',
        error: reason,
      });
      await this.store.addDeadLetter({
        id: axEventId('dead-letter'),
        kind: 'delivery',
        deliveryId: claimed.id,
        reason,
        createdAt: this.clock.now(),
      });
      return;
    }
    const route = this.routes.get(claimed.routeId);
    if (!route) {
      await this.deadLetterDelivery(
        claimed,
        'Event route is no longer configured'
      );
      return;
    }
    let continuation: Readonly<AxEventContinuation> | undefined;
    let target = route.target;
    let targetId = target?.id;
    let instanceKey = claimed.instanceKey;
    try {
      if (route.action === 'resume' && claimed.runId && !previousRun) {
        // A previous attempt owns resume admission for the lifetime of this
        // delivery. Load it before any fresh correlation lookup so replacement
        // continuations can never redirect retries or recovery.
        previousRun = await this.store.getRun(claimed.runId);
        if (!previousRun) {
          throw new Error(
            `outcome_unknown: resume delivery ${claimed.id} lost its durable continuation admission`
          );
        }
      }
      if (route.action === 'resume') {
        const correlation =
          route.correlation?.(claimed.ingress) ??
          claimed.ingress.correlation?.[0];
        if (!correlation) {
          throw new Error(
            `Resume route ${route.id} did not produce a correlation key`
          );
        }
        if (previousRun && !claimed.admittedContinuation) {
          throw new Error(
            `outcome_unknown: resume delivery ${claimed.id} has a prior run without an exclusive continuation admission`
          );
        }
        if (
          !this.store.admitContinuation ||
          !claimed.claimedBy ||
          claimed.fencingToken === undefined
        ) {
          throw new Error(
            `outcome_unknown: event store cannot exclusively admit a continuation for ${claimed.id}`
          );
        }
        continuation = await this.store.admitContinuation(
          claimed.id,
          claimed.claimedBy,
          claimed.fencingToken,
          claimed.identityScope,
          correlation,
          this.clock.now()
        );
        if (this.workerController.signal.aborted || this.storeShutdownStarted) {
          return;
        }
        if (!continuation) {
          throw new AxEventContinuationNotFoundError(correlation);
        }
        claimed = {
          ...claimed,
          admittedContinuation: structuredClone(continuation),
        };
        if (previousRun) this.requireResumeAdmission(claimed, previousRun);
        targetId = continuation.targetId;
        target = this.targets.get(targetId);
        instanceKey = continuation.instanceKey;
        if (!target) {
          throw new Error(`Continuation target ${targetId} is not configured`);
        }
      }
      if (
        await this.resumePersistedCompletion(
          claimed,
          workerId,
          route,
          previousRun
        )
      ) {
        if (this.workerController.signal.aborted || this.storeShutdownStarted) {
          return;
        }
        return;
      }

      const runId = axEventId('event-run');
      const controller = new AbortController();
      const heartbeatController = new AbortController();
      this.activeRuns.set(runId, controller);
      const attempt = claimed.attempt + 1;
      const heartbeat = this.heartbeatClaim(
        claimed,
        workerId,
        controller,
        heartbeatController.signal
      );
      let effectParkReason: string | undefined;
      try {
        effectParkReason = await this.reconcileEffects(
          claimed,
          controller.signal
        );
        this.assertRunActive(controller.signal);
      } catch (error) {
        heartbeatController.abort('Event effect reconciliation failed');
        await heartbeat;
        this.activeRuns.delete(runId);
        throw error;
      }
      if (effectParkReason) {
        try {
          await this.parkDelivery(claimed, effectParkReason);
        } finally {
          heartbeatController.abort('Event delivery parked');
          await heartbeat;
          this.activeRuns.delete(runId);
        }
        return;
      }
      const refreshedClaim = await this.store.getDelivery(claimed.id);
      if (
        !refreshedClaim ||
        refreshedClaim.claimedBy !== workerId ||
        refreshedClaim.fencingToken !== claimed.fencingToken ||
        refreshedClaim.leaseExpiresAt === undefined ||
        refreshedClaim.leaseExpiresAt <= this.clock.now()
      ) {
        heartbeatController.abort('Event claim was lost during reconciliation');
        await heartbeat;
        this.activeRuns.delete(runId);
        throw new Error(`Stale event claim for ${claimed.id}`);
      }
      // Reconciliation may outlive the original lease while the heartbeat
      // extends it. Never overwrite that extension with the stale claim copy.
      claimed = refreshedClaim;
      this.assertRunActive(controller.signal);
      let authority: Readonly<AxAuthorityContext> | undefined;
      try {
        authority = await this.resolveAuthority(
          claimed.ingress,
          AbortSignal.any([controller.signal, this.workerController.signal])
        );
        this.assertRunActive(controller.signal);
      } catch (error) {
        heartbeatController.abort('Event authority resolution failed');
        await heartbeat;
        this.activeRuns.delete(runId);
        if (controller.signal.aborted && !this.storeShutdownStarted) {
          const cancellationReason = axEventErrorMessage(
            controller.signal.reason
          );
          const effectParkReason = await this.parkCancelledEffects(
            claimed,
            cancellationReason
          );
          const cancelledRun: AxEventRun = {
            id: runId,
            deliveryId: claimed.id,
            routeId: route.id,
            ...(targetId ? { targetId } : {}),
            instanceKey,
            ...(continuation
              ? { admittedContinuation: structuredClone(continuation) }
              : {}),
            claimedBy: workerId,
            status: effectParkReason ? 'parked' : 'cancelled',
            attempt,
            startedAt: this.clock.now(),
            finishedAt: this.clock.now(),
            error: effectParkReason ?? cancellationReason,
            ...(claimed.fencingToken !== undefined
              ? { fencingToken: claimed.fencingToken }
              : {}),
          };
          await this.store.saveRun(cancelledRun);
          if (effectParkReason) {
            await this.parkDelivery(
              { ...claimed, attempt, runId },
              effectParkReason,
              false
            );
          } else {
            await this.store.saveDelivery({
              ...claimed,
              status: 'cancelled',
              attempt,
              runId,
              error: cancellationReason,
            });
          }
          return;
        }
        throw error;
      }
      const eventContext = new AxRuntimeEventContext(
        this.id,
        runId,
        claimed.id,
        route.id,
        targetId,
        instanceKey,
        claimed.ingress,
        claimed.ingress.identity ?? {},
        claimed.ingress.trust ?? 'untrusted',
        attempt,
        claimed.id,
        controller.signal,
        authority,
        continuation,
        claimed.fencingToken,
        this.store,
        () => this.clock.now(),
        () => this.storeShutdownStarted
      );
      let run: AxEventRun = {
        id: runId,
        deliveryId: claimed.id,
        routeId: route.id,
        ...(targetId ? { targetId } : {}),
        instanceKey,
        ...(continuation
          ? { admittedContinuation: structuredClone(continuation) }
          : {}),
        claimedBy: workerId,
        status: 'running',
        attempt,
        startedAt: this.clock.now(),
        ...(claimed.fencingToken !== undefined
          ? { fencingToken: claimed.fencingToken }
          : {}),
      };
      this.assertRunActive(controller.signal);
      await this.store.saveDelivery({
        ...claimed,
        status: 'running',
        attempt,
        runId,
      });
      this.assertRunActive(controller.signal);
      await this.store.saveRun(run);
      let invoked = false;
      try {
        let result: InvocationResult = { waiting: false, invoked: false };
        let verification: VerificationOutcome | undefined;
        if (route.action === 'observe') {
          await this.authorizeEventOperation(
            eventContext,
            'event.observe',
            'event.route',
            route.id
          );
          await route.observe?.(claimed.ingress, eventContext);
          this.assertRunActive(controller.signal);
        } else if (route.action === 'invalidate') {
          await this.authorizeEventOperation(
            eventContext,
            'event.invalidate',
            'event.route',
            route.id
          );
          await route.invalidator!.invalidate(claimed.ingress, eventContext);
          this.assertRunActive(controller.signal);
        } else {
          await this.authorizeEventOperation(
            eventContext,
            'event.target.invoke',
            'event.target',
            target!.id
          );
          verification = target?.verifier
            ? await this.preflightVerifier(target, eventContext)
            : undefined;
          if (!verification) {
            result = await this.invokeTarget(
              target!,
              instanceKey,
              claimed.ingress,
              eventContext,
              run,
              async () => {
                await this.store.saveDelivery({
                  ...claimed,
                  status: 'running',
                  attempt,
                  runId,
                  invocationStarted: true,
                });
                invoked = true;
              }
            );
            this.assertRunActive(controller.signal);
            invoked = invoked || result.invoked;
            run = {
              ...run,
              ...(result.output !== undefined ? { output: result.output } : {}),
              ...(result.chunks ? { chunks: result.chunks } : {}),
            };
          }
        }

        await this.persistVerifierInput(run);
        verification ??=
          target?.verifier &&
          result.invoked &&
          !result.waiting &&
          run.output !== undefined
            ? await this.applyVerifier(target, run, eventContext)
            : undefined;

        const registrations = eventContext.takeRegistrations();
        if (verification?.continuation && registrations.length > 0) {
          throw new Error(
            'A verifier retry cannot publish ordinary continuations in the same delivery'
          );
        }
        const continuations: AxEventContinuation[] = [];
        for (const registration of registrations) {
          this.assertRunActive(controller.signal);
          const value: AxEventContinuation = {
            id: registration.id,
            targetId: targetId ?? `route:${route.id}`,
            routeId: route.id,
            instanceKey,
            identityScope: claimed.identityScope,
            correlation: registration.value.correlation,
            createdAt: this.clock.now(),
            ...(registration.value.expiresAt !== undefined
              ? { expiresAt: registration.value.expiresAt }
              : {}),
            ...(registration.value.metadata
              ? { metadata: registration.value.metadata }
              : {}),
          };
          await this.store.registerContinuation(value);
          this.assertRunActive(controller.signal);
          continuations.push(value);
        }
        for (const callback of eventContext.takeAfterRegistrationCallbacks()) {
          await callback();
          this.assertRunActive(controller.signal);
        }
        if (verification?.continuation) {
          continuations.push(verification.continuation.value);
        }

        const completionEffectParkReason =
          await this.parkUnsettledCompletionEffects(claimed, controller.signal);
        this.assertRunActive(controller.signal);
        if (completionEffectParkReason) {
          run = {
            ...run,
            status: 'parked',
            finishedAt: this.clock.now(),
            error: completionEffectParkReason,
          };
          await this.store.saveRun(run);
          this.assertRunActive(controller.signal);
          await this.parkDelivery(
            { ...claimed, attempt, runId },
            completionEffectParkReason,
            false
          );
          this.assertRunActive(controller.signal);
          return;
        }

        const waiting =
          result.waiting ||
          continuations.length > 0 ||
          verification?.verification.status === 'fail';
        const verificationFailed = Boolean(
          verification &&
            verification.verification.status !== 'pass' &&
            !verification.continuation
        );
        const finalizing =
          !waiting &&
          !verificationFailed &&
          target !== undefined &&
          run.output !== undefined;
        run = {
          ...run,
          status: verificationFailed
            ? 'verification_failed'
            : waiting
              ? 'waiting_event'
              : finalizing
                ? 'finalizing'
                : 'succeeded',
          ...(!finalizing ? { finishedAt: this.clock.now() } : {}),
          ...(verification ? { verification: verification.verification } : {}),
          ...(continuations.length
            ? { continuationIds: continuations.map((value) => value.id) }
            : {}),
        };
        this.assertRunActive(controller.signal);
        if (verification?.continuation) {
          await this.commitVerifierTransition(
            claimed,
            run,
            attempt,
            verification,
            continuation,
            target!,
            controller.signal
          );
        } else {
          // Persist the complete output before any final sink dispatch.
          await this.store.saveRun(run);
        }
        this.assertRunActive(controller.signal);
        if (finalizing && target) {
          run = await this.dispatchFinalSinks(
            target,
            run,
            eventContext,
            claimed
          );
          this.assertRunActive(controller.signal);
          const sinkEffectParkReason =
            await this.parkUnsettledCompletionEffects(
              claimed,
              controller.signal
            );
          this.assertRunActive(controller.signal);
          if (sinkEffectParkReason) {
            run = {
              ...run,
              status: 'parked',
              finishedAt: this.clock.now(),
              error: sinkEffectParkReason,
            };
            await this.store.saveRun(run);
            this.assertRunActive(controller.signal);
            await this.parkDelivery(
              { ...claimed, attempt, runId },
              sinkEffectParkReason,
              false
            );
            this.assertRunActive(controller.signal);
            return;
          }
          run = {
            ...run,
            status: 'succeeded',
            finishedAt: this.clock.now(),
          };
          await this.store.saveRun(run);
        }
        if (verification?.continuation) return;
        this.assertRunActive(controller.signal);
        const completedDelivery: AxEventDelivery = {
          ...claimed,
          status: verificationFailed
            ? 'verification_failed'
            : waiting
              ? 'waiting_event'
              : 'succeeded',
          attempt,
          runId,
        };
        if (verificationFailed) {
          await this.store.saveDelivery(completedDelivery);
        } else {
          await this.saveSuccessfulDelivery(completedDelivery, continuation);
        }
        this.assertRunActive(controller.signal);
      } catch (error) {
        if (this.storeShutdownStarted) return;
        if (controller.signal.aborted) {
          const effectParkReason = await this.parkCancelledEffects(
            claimed,
            axEventErrorMessage(controller.signal.reason)
          );
          if (this.storeShutdownStarted) return;
          if (effectParkReason) {
            run = {
              ...run,
              status: 'parked',
              finishedAt: this.clock.now(),
              error: effectParkReason,
            };
            await this.store.saveRun(run);
            if (this.storeShutdownStarted) return;
            await this.parkDelivery(
              { ...claimed, attempt, runId },
              effectParkReason,
              false
            );
            return;
          }
          run = {
            ...run,
            status: 'cancelled',
            finishedAt: this.clock.now(),
            error: axEventErrorMessage(controller.signal.reason),
          };
          await this.store.saveRun(run);
          if (this.storeShutdownStarted) return;
          await this.store.saveDelivery({
            ...claimed,
            status: 'cancelled',
            attempt,
            runId,
            error: run.error,
          });
          return;
        }
        if (axIsEventOutputPersistenceError(error)) {
          if (error.phase === 'commit' || error.phase === 'recovery') {
            // A staged provider commit may have succeeded even though its local
            // acknowledgement did not. Keep the finalizing run and journal for
            // fenced sink-only recovery; never overwrite it or rerun the target.
            return;
          }
          const persistedDelivery = await this.store.getDelivery(claimed.id);
          if (this.storeShutdownStarted) return;
          if (persistedDelivery?.status === 'output_persistence_failed') {
            // Staged stores mark the delivery terminal before releasing stage
            // ownership, closing the crash window before this caller observes
            // the structural error.
            return;
          }
          run = {
            ...run,
            output: undefined,
            chunks: undefined,
            status: 'output_persistence_failed',
            finishedAt: this.clock.now(),
            error: axEventErrorMessage(error),
          };
          await this.store.saveRun(run);
          if (this.storeShutdownStarted) return;
          await this.store.saveDelivery({
            ...claimed,
            status: 'output_persistence_failed',
            attempt,
            runId,
            error: run.error,
          });
          if (this.storeShutdownStarted) return;
          await this.store.addDeadLetter({
            id: axEventId('dead-letter'),
            kind: 'delivery',
            deliveryId: claimed.id,
            runId,
            reason: run.error ?? 'output_persistence_failed',
            createdAt: this.clock.now(),
          });
          return;
        }
        const unsafe =
          error instanceof AxEventOutcomeUnknownError ||
          (invoked &&
            target?.retrySafety !== 'idempotent' &&
            target?.retrySafety !== 'effect-aware');
        if (unsafe) {
          await this.parkOutcomeUnknownEffects({
            ...claimed,
            attempt,
            runId,
          });
          if (this.storeShutdownStarted) return;
          run = {
            ...run,
            status: 'outcome_unknown',
            finishedAt: this.clock.now(),
            error: axEventErrorMessage(error),
          };
          await this.store.saveRun(run);
          if (this.storeShutdownStarted) return;
          await this.store.saveDelivery({
            ...claimed,
            status: 'outcome_unknown',
            attempt,
            runId,
            error: run.error,
          });
          if (this.storeShutdownStarted) return;
          await this.store.addDeadLetter({
            id: axEventId('dead-letter'),
            kind: 'delivery',
            deliveryId: claimed.id,
            runId,
            reason: run.error ?? 'Event outcome is unknown',
            createdAt: this.clock.now(),
          });
          return;
        }
        const nonRetryable =
          error instanceof AxEventContinuationNotFoundError ||
          error instanceof AxEventInputError;
        if (!nonRetryable && attempt < (this.options.maxAttempts ?? 5)) {
          const effectParkReason = await this.reconcileEffects(
            { ...claimed, attempt, runId, invocationStarted: invoked },
            controller.signal
          );
          if (this.storeShutdownStarted) return;
          if (effectParkReason) {
            run = {
              ...run,
              status: 'parked',
              finishedAt: this.clock.now(),
              error: effectParkReason,
            };
            await this.store.saveRun(run);
            if (this.storeShutdownStarted) return;
            await this.parkDelivery(
              { ...claimed, attempt, runId },
              effectParkReason,
              false
            );
            return;
          }
          const retryMs = Math.min(
            this.options.retryMaxMs ?? 60_000,
            (this.options.retryBaseMs ?? 1_000) * 2 ** (attempt - 1)
          );
          run = {
            ...run,
            status: 'failed',
            finishedAt: this.clock.now(),
            error: axEventErrorMessage(error),
          };
          await this.store.saveRun(run);
          if (this.storeShutdownStarted) return;
          await this.store.saveDelivery({
            ...claimed,
            status: 'queued',
            attempt,
            availableAt: this.clock.now() + retryMs,
            error: run.error,
            runId,
          });
          return;
        }
        run = {
          ...run,
          status: 'failed',
          finishedAt: this.clock.now(),
          error: axEventErrorMessage(error),
        };
        await this.store.saveRun(run);
        if (this.storeShutdownStarted) return;
        await this.deadLetterDelivery(
          { ...claimed, attempt, runId },
          run.error ?? 'Event delivery failed'
        );
      } finally {
        heartbeatController.abort('Event delivery completed');
        await heartbeat;
        this.activeRuns.delete(runId);
      }
    } catch (error) {
      if (this.workerController.signal.aborted || this.storeShutdownStarted) {
        return;
      }
      if (
        axIsEventOutputPersistenceError(error) &&
        error.phase === 'recovery'
      ) {
        // The persisted finalizing/succeeded run and admitted continuation remain the
        // source of truth. Leave the active delivery non-terminal so an expired
        // lease can retry only atomic completion/sink recovery.
        return;
      }
      await this.deadLetterDelivery(claimed, axEventErrorMessage(error));
    }
  }

  private async commitVerifierTransition(
    claimed: Readonly<AxEventDelivery>,
    run: Readonly<AxEventRun>,
    attempt: number,
    outcome: Readonly<VerificationOutcome>,
    consumed: Readonly<AxEventContinuation> | undefined,
    target: Readonly<AxEventTarget>,
    signal: AbortSignal
  ): Promise<void> {
    const next = outcome.continuation!;
    const delivery: AxEventDelivery = {
      ...claimed,
      status: 'waiting_event',
      attempt,
      runId: run.id,
    };
    const request = {
      operationId: `${outcome.verification.chainId}:${outcome.verification.run}`,
      childDeliveryId: `verifier-delivery:${outcome.verification.chainId}:${outcome.verification.run}`,
      parent: {
        delivery,
        run,
        expectedFencingToken: claimed.fencingToken!,
      },
      continuation: next.value,
      child: {
        ingress: next.ingress,
        deliveries: [
          {
            routeId: next.value.routeId,
            action: 'resume' as const,
            targetId: next.value.targetId,
            instanceKey: claimed.instanceKey,
            sizeBytes: axEventSizeBytes(next.ingress),
            availableAt: next.availableAt,
            retrySafety: target.retrySafety ?? 'unknown',
            ordering: 'strict' as const,
          },
        ],
        acceptedAt: this.clock.now(),
        publishTimeoutMs: this.options.publishTimeoutMs ?? 5_000,
      },
      ...(consumed ? { consumeContinuationId: consumed.id } : {}),
    };
    if (signal.aborted) {
      throw signal.reason ?? new Error('Verifier transition cancelled');
    }
    const commit = Promise.resolve().then(() => {
      if (signal.aborted) {
        throw signal.reason ?? new Error('Verifier transition cancelled');
      }
      return this.store.transitionVerifier!(request, signal);
    });
    try {
      await commit;
    } catch (error) {
      if (await this.verifierTransitionCommitted(request)) return;
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      try {
        await this.store.transitionVerifier!(request, signal);
      } catch {
        if (await this.verifierTransitionCommitted(request)) return;
        throw error;
      }
    }
  }

  private async verifierTransitionCommitted(
    request: Readonly<import('./types.js').AxEventVerifierTransitionRequest>
  ): Promise<boolean> {
    const receipt = await this.store.confirmVerifierTransition!(request);
    if (!receipt) return false;
    if (
      axEventCanonicalJson(receipt) !==
      axEventCanonicalJson({
        eventId: request.child.ingress.event.id,
        accepted: true,
        duplicate: false,
        durability: this.store.capabilities.durability,
        deliveryIds: [request.childDeliveryId],
      })
    ) {
      throw new Error(
        `Verifier transition confirmation is invalid: ${request.operationId}`
      );
    }
    return true;
  }

  private async persistVerifierInput(run: Readonly<AxEventRun>): Promise<void> {
    try {
      await this.store.saveRun(run);
    } catch (error) {
      // Saving a run is idempotent. Replay once so a pre-commit failure can
      // recover and a lost commit acknowledgement can be confirmed without
      // invoking the target again.
      try {
        await this.store.saveRun(run);
      } catch {
        throw error;
      }
    }
  }

  private async applyVerifier(
    target: Readonly<AxEventTarget<any, any>>,
    run: Readonly<AxEventRun>,
    eventContext: Readonly<AxEventContext>
  ): Promise<VerificationOutcome> {
    const policy = target.verifier!;
    let chain: Readonly<{
      chainId: string;
      previous?: Readonly<VerifierPolicyState>;
    }> = { chainId: eventContext.deliveryId };
    let state: VerifierPolicyState = {
      startedAt: run.startedAt,
      runs: 0,
      tokens: 0,
      costUSD: 0,
    };
    const context: AxEventVerifierContext = {
      run,
      eventContext,
      signal: eventContext.abortSignal,
    };
    try {
      chain = this.verifierChain(target, eventContext);
      const previous = chain.previous;
      state = previous
        ? { ...previous }
        : {
            startedAt: run.startedAt,
            runs: 0,
            tokens: 0,
            costUSD: 0,
          };
      const usage = policy.usage
        ? await this.invokeVerifierCallback(
            policy,
            context,
            (callbackContext) => policy.usage!(run.output, callbackContext)
          )
        : {};
      this.validateVerifierMeasure('tokens', usage.tokens);
      this.validateVerifierMeasure('costUSD', usage.costUSD);
      const cumulativeTokens = state.tokens + (usage.tokens ?? 0);
      const cumulativeCostUSD = state.costUSD + (usage.costUSD ?? 0);
      this.validateVerifierMeasure('cumulative tokens', cumulativeTokens);
      this.validateVerifierMeasure('cumulative costUSD', cumulativeCostUSD);
      state = {
        startedAt: state.startedAt,
        runs: state.runs + 1,
        tokens: cumulativeTokens,
        costUSD: cumulativeCostUSD,
        ...(previous?.lastFingerprint !== undefined
          ? { lastFingerprint: previous.lastFingerprint }
          : {}),
        ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}),
      };
      const rawFingerprint = policy.fingerprint
        ? await this.invokeVerifierCallback(
            policy,
            context,
            (callbackContext) =>
              policy.fingerprint!(run.output, callbackContext)
          )
        : undefined;
      if (rawFingerprint !== undefined && !rawFingerprint.length) {
        throw new Error('Verifier fingerprint must be non-empty');
      }
      const fingerprint =
        rawFingerprint === undefined
          ? undefined
          : this.boundVerifierString(
              rawFingerprint,
              VERIFIER_FINGERPRINT_BYTES
            );
      const base = {
        policyId: policy.id,
        chainId: chain.chainId,
        run: state.runs,
        checkedAt: this.clock.now(),
        cumulativeUsage: {
          tokens: state.tokens,
          costUSD: state.costUSD,
        },
        ...(fingerprint !== undefined ? { fingerprint } : {}),
      };

      if (
        fingerprint !== undefined &&
        fingerprint === previous?.lastFingerprint &&
        previous.lastFailure
      ) {
        return {
          verification: {
            ...base,
            status: 'unchanged_state',
            failure: previous.lastFailure,
          },
        };
      }

      const result = await this.invokeVerifierCallback(
        policy,
        context,
        (callbackContext) => policy.verify(run.output, callbackContext)
      );
      if (result.status === 'pass') {
        return { verification: { ...base, status: 'pass' } };
      }
      if (!result.failure.code.trim()) {
        throw new Error('Verifier failure code must be non-empty');
      }
      const failure = {
        code: this.boundVerifierString(
          result.failure.code,
          VERIFIER_CODE_BYTES
        ),
        ...(result.failure.evidence !== undefined
          ? {
              evidence: this.boundVerifierEvidence(
                result.failure.evidence,
                policy.maxEvidenceBytes ?? 4_096
              ),
            }
          : {}),
      };
      if (state.runs >= (policy.maxRuns ?? 3)) {
        return {
          verification: {
            ...base,
            status: 'exhausted',
            reason: 'max_runs',
            failure,
          },
        };
      }
      const exhausted = this.verifierLimit(policy, state, this.clock.now());
      if (exhausted) {
        return {
          verification: {
            ...base,
            status: 'exhausted',
            reason: exhausted,
            failure,
          },
        };
      }

      const nextState: VerifierPolicyState = {
        ...state,
        ...(fingerprint !== undefined ? { lastFingerprint: fingerprint } : {}),
        lastFailure: failure,
      };
      const correlationValue = `${chain.chainId}:${state.runs}`;
      const continuation: AxEventContinuation = {
        id: `ax-verifier-continuation:${correlationValue}`,
        targetId: target.id,
        routeId: verifierRouteId(target),
        instanceKey: eventContext.instanceKey,
        identityScope: axEventIdentityScope(eventContext.identity),
        correlation: [{ kind: 'ax.verifier', value: correlationValue }],
        createdAt: this.clock.now(),
        stateVersion: state.runs,
        metadata: {
          verification: {
            policyId: policy.id,
            chainId: chain.chainId,
            run: state.runs,
            failure,
            state: nextState,
          },
        },
      };
      const backoffPolicy = policy.backoffMs;
      let backoff = 0;
      if (typeof backoffPolicy === 'function') {
        try {
          backoff = await this.invokeVerifierCallback(policy, context, () =>
            backoffPolicy(state.runs, failure)
          );
        } catch {
          backoff = 0;
        }
      } else if (backoffPolicy !== undefined) {
        backoff = backoffPolicy;
      }
      if (!Number.isFinite(backoff) || backoff < 0) {
        backoff = 0;
      }
      return {
        verification: { ...base, status: 'fail', failure },
        continuation: {
          value: continuation,
          ingress: {
            event: {
              specversion: '1.0',
              id: `verification:${chain.chainId}:${state.runs}`,
              source: VERIFIER_SOURCE,
              type: verifierEventType(target),
              time: new Date(this.clock.now()).toISOString(),
              data: { continuation: correlationValue },
            },
            identity: structuredClone(eventContext.identity),
            trust: eventContext.trust,
            correlation: continuation.correlation,
            partitionKey: eventContext.instanceKey,
          },
          availableAt: this.clock.now() + backoff,
        },
      };
    } catch (error) {
      if (eventContext.abortSignal.aborted) throw error;
      return {
        verification: {
          policyId: policy.id,
          chainId: chain.chainId,
          status:
            error instanceof Error &&
            error.name === 'AxEventVerifierTimeoutError'
              ? 'timeout'
              : 'error',
          run: state.runs,
          checkedAt: this.clock.now(),
          cumulativeUsage: {
            tokens: state.tokens,
            costUSD: state.costUSD,
          },
          error: this.boundVerifierString(
            axEventErrorMessage(error),
            VERIFIER_ERROR_BYTES
          ),
        },
      };
    }
  }

  private async preflightVerifier(
    target: Readonly<AxEventTarget>,
    eventContext: Readonly<AxEventContext>
  ): Promise<VerificationOutcome | undefined> {
    const policy = target.verifier!;
    try {
      const chain = this.verifierChain(target, eventContext);
      if (!chain.previous) return;
      const state = chain.previous;
      const reason =
        state.runs >= (policy.maxRuns ?? 3)
          ? ('max_runs' as const)
          : this.verifierLimit(policy, state, this.clock.now());
      if (!reason) return;
      return {
        verification: {
          policyId: policy.id,
          chainId: chain.chainId,
          status: 'exhausted',
          run: state.runs,
          checkedAt: this.clock.now(),
          cumulativeUsage: {
            tokens: state.tokens,
            costUSD: state.costUSD,
          },
          reason,
          ...(state.lastFingerprint !== undefined
            ? { fingerprint: state.lastFingerprint }
            : {}),
          ...(state.lastFailure ? { failure: state.lastFailure } : {}),
        },
      };
    } catch (error) {
      return {
        verification: {
          policyId: policy.id,
          chainId: eventContext.deliveryId,
          status: 'error',
          run: 0,
          checkedAt: this.clock.now(),
          cumulativeUsage: { tokens: 0, costUSD: 0 },
          error: this.boundVerifierString(
            axEventErrorMessage(error),
            VERIFIER_ERROR_BYTES
          ),
        },
      };
    }
  }

  private verifierChain(
    target: Readonly<AxEventTarget>,
    eventContext: Readonly<AxEventContext>
  ): Readonly<{
    chainId: string;
    previous?: Readonly<VerifierPolicyState>;
  }> {
    if (eventContext.continuation?.routeId !== verifierRouteId(target)) {
      return { chainId: eventContext.deliveryId };
    }
    const metadata = eventContext.continuation.metadata?.verification;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Verifier continuation metadata is missing');
    }
    const value = metadata as Record<string, AxEventValue>;
    const chainId = value.chainId;
    const stateValue = value.state;
    if (
      value.policyId !== target.verifier!.id ||
      typeof chainId !== 'string' ||
      !chainId ||
      new TextEncoder().encode(chainId).byteLength > 256 ||
      !stateValue ||
      typeof stateValue !== 'object' ||
      Array.isArray(stateValue)
    ) {
      throw new Error('Verifier continuation ownership is invalid');
    }
    const state = stateValue as unknown as VerifierPolicyState;
    const failure = state.lastFailure;
    if (
      !Number.isFinite(state.startedAt) ||
      !Number.isInteger(state.runs) ||
      state.runs < 1 ||
      !Number.isFinite(state.tokens) ||
      state.tokens < 0 ||
      !Number.isFinite(state.costUSD) ||
      state.costUSD < 0 ||
      (state.lastFingerprint !== undefined &&
        (typeof state.lastFingerprint !== 'string' ||
          new TextEncoder().encode(state.lastFingerprint).byteLength >
            VERIFIER_FINGERPRINT_BYTES)) ||
      (failure !== undefined &&
        (typeof failure.code !== 'string' ||
          new TextEncoder().encode(failure.code).byteLength >
            VERIFIER_CODE_BYTES ||
          (failure.evidence !== undefined &&
            new TextEncoder().encode(JSON.stringify(failure.evidence))
              .byteLength > (target.verifier!.maxEvidenceBytes ?? 4_096)))) ||
      eventContext.continuation.stateVersion !== state.runs ||
      value.run !== state.runs ||
      eventContext.continuation.id !==
        `ax-verifier-continuation:${chainId}:${state.runs}` ||
      !eventContext.continuation.correlation.some(
        (correlation) =>
          correlation.kind === 'ax.verifier' &&
          correlation.value === `${chainId}:${state.runs}`
      )
    ) {
      throw new Error('Verifier continuation state version is invalid');
    }
    return { chainId, previous: state };
  }

  private async invokeVerifierCallback<T>(
    policy: Readonly<AxEventVerifierPolicy>,
    context: Readonly<AxEventVerifierContext>,
    callback: (context: Readonly<AxEventVerifierContext>) => T | Promise<T>
  ): Promise<T> {
    const verifierController = new AbortController();
    const timeoutController = new AbortController();
    const forwardAbort = () => verifierController.abort(context.signal.reason);
    context.signal.addEventListener('abort', forwardAbort, { once: true });
    let timedOut = false;
    const timeout = this.clock
      .sleep(policy.timeoutMs ?? 30_000, timeoutController.signal)
      .then(() => {
        timedOut = true;
        verifierController.abort('Verifier timed out');
        const error = new Error('Verifier timed out');
        error.name = 'AxEventVerifierTimeoutError';
        throw error;
      })
      .catch((error) => {
        if (timeoutController.signal.aborted && !timedOut) {
          return new Promise<never>(() => undefined);
        }
        throw error;
      });
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          callback({
            ...context,
            signal: verifierController.signal,
          })
        ),
        timeout,
      ]);
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error('Verifier timed out');
        timeoutError.name = 'AxEventVerifierTimeoutError';
        throw timeoutError;
      }
      throw error;
    } finally {
      timeoutController.abort('Verifier completed');
      context.signal.removeEventListener('abort', forwardAbort);
    }
  }

  private verifierLimit(
    policy: Readonly<AxEventVerifierPolicy>,
    state: Readonly<VerifierPolicyState>,
    now: number
  ): AxEventVerificationResult['reason'] | undefined {
    if (policy.maxTokens !== undefined && state.tokens >= policy.maxTokens) {
      return 'max_tokens';
    }
    if (
      policy.maxWallTimeMs !== undefined &&
      now - state.startedAt >= policy.maxWallTimeMs
    ) {
      return 'max_wall_time';
    }
    if (policy.maxCostUSD !== undefined && state.costUSD >= policy.maxCostUSD) {
      return 'max_cost';
    }
    return;
  }

  private validateVerifierMeasure(name: string, value: number | undefined) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Verifier usage ${name} must be non-negative`);
    }
  }

  private boundVerifierEvidence(
    evidence: AxEventValue,
    maxBytes: number
  ): AxEventValue {
    const json = JSON.stringify(evidence);
    const encoder = new TextEncoder();
    if (encoder.encode(json).byteLength <= maxBytes) {
      return structuredClone(evidence);
    }
    const preview = `[truncated]${json}`;
    let low = 0;
    let high = preview.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        encoder.encode(JSON.stringify(preview.slice(0, middle))).byteLength <=
        maxBytes
      ) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return preview.slice(0, low);
  }

  private boundVerifierString(value: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).byteLength <= maxBytes) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return value.slice(0, low);
  }

  private async resumePersistedCompletion(
    claimed: Readonly<AxEventDelivery>,
    workerId: string,
    route: Readonly<AxEventRoute>,
    persisted: Readonly<AxEventRun> | undefined
  ): Promise<boolean> {
    if (
      !claimed.recoveredFromExpiredLease ||
      (persisted?.status !== 'finalizing' && persisted?.status !== 'succeeded')
    ) {
      return false;
    }
    const continuation =
      route.action === 'resume'
        ? this.requireResumeAdmission(claimed, persisted)
        : persisted.admittedContinuation;
    // Legacy wake runs may predate persisted target IDs; the configured wake
    // route remains their compatibility fallback. Resume runs never use it.
    const targetId =
      persisted.targetId ??
      (route.action === 'resume' ? undefined : route.target?.id);
    const target = targetId ? this.targets.get(targetId) : undefined;
    if (targetId && !target) {
      throw new Error(`Persisted target ${targetId} is not configured`);
    }
    const instanceKey = persisted.instanceKey;

    const controller = new AbortController();
    const heartbeatController = new AbortController();
    this.activeRuns.set(persisted.id, controller);
    const heartbeat = this.heartbeatClaim(
      claimed,
      workerId,
      controller,
      heartbeatController.signal
    );
    try {
      const effectParkReason = await this.reconcileEffects(
        claimed,
        controller.signal
      );
      this.assertRunActive(controller.signal);
      if (effectParkReason) {
        await this.parkDelivery(claimed, effectParkReason);
        return true;
      }
      if (persisted.status === 'succeeded') {
        const completionEffectParkReason =
          await this.parkUnsettledCompletionEffects(claimed, controller.signal);
        this.assertRunActive(controller.signal);
        if (completionEffectParkReason) {
          await this.parkDelivery(claimed, completionEffectParkReason);
          return true;
        }
      }
      const authority = await this.resolveAuthority(
        claimed.ingress,
        AbortSignal.any([controller.signal, this.workerController.signal])
      );
      this.assertRunActive(controller.signal);
      const context = new AxRuntimeEventContext(
        this.id,
        persisted.id,
        claimed.id,
        route.id,
        targetId,
        instanceKey,
        claimed.ingress,
        claimed.ingress.identity ?? {},
        claimed.ingress.trust ?? 'untrusted',
        persisted.attempt,
        claimed.id,
        controller.signal,
        authority,
        continuation,
        claimed.fencingToken,
        this.store,
        () => this.clock.now(),
        () => this.storeShutdownStarted
      );
      let run: AxEventRun = {
        ...persisted,
        claimedBy: workerId,
        ...(claimed.fencingToken !== undefined
          ? { fencingToken: claimed.fencingToken }
          : {}),
      };
      if (target && run.output !== undefined) {
        run = await this.dispatchFinalSinks(target, run, context, claimed);
        this.assertRunActive(controller.signal);
        const sinkEffectParkReason = await this.parkUnsettledCompletionEffects(
          claimed,
          controller.signal
        );
        this.assertRunActive(controller.signal);
        if (sinkEffectParkReason) {
          run = {
            ...run,
            status: 'parked',
            finishedAt: this.clock.now(),
            error: sinkEffectParkReason,
          };
          await this.store.saveRun(run);
          this.assertRunActive(controller.signal);
          await this.parkDelivery(
            {
              ...claimed,
              attempt: Math.max(claimed.attempt, persisted.attempt),
              runId: persisted.id,
            },
            sinkEffectParkReason,
            false
          );
          this.assertRunActive(controller.signal);
          return true;
        }
        run = {
          ...run,
          status: 'succeeded',
          finishedAt: this.clock.now(),
        };
        await this.store.saveRun(run);
      }
      this.assertRunActive(controller.signal);
      await this.saveSuccessfulDelivery(
        {
          ...claimed,
          status: 'succeeded',
          attempt: Math.max(claimed.attempt, persisted.attempt),
          runId: persisted.id,
        },
        continuation
      );
      return true;
    } finally {
      heartbeatController.abort('Persisted event completion resumed');
      await heartbeat;
      this.activeRuns.delete(persisted.id);
    }
  }

  private async saveSuccessfulDelivery(
    delivery: Readonly<AxEventDelivery>,
    continuation: Readonly<AxEventContinuation> | undefined
  ): Promise<void> {
    if (!continuation) {
      await this.store.saveDelivery(delivery);
      return;
    }
    if (!this.store.saveDeliveryAndCompleteContinuation) {
      throw new AxEventOutcomeUnknownError(
        `outcome_unknown: event store cannot atomically complete resume delivery ${delivery.id}`
      );
    }
    try {
      await this.store.saveDeliveryAndCompleteContinuation({
        ...delivery,
        admittedContinuation: structuredClone(continuation),
      });
    } catch (error) {
      if (axIsEventOutputPersistenceError(error)) throw error;
      throw new AxEventOutputPersistenceError(
        `atomic resume completion failed for delivery ${delivery.id}`,
        'recovery',
        { cause: error }
      );
    }
  }

  private requireResumeAdmission(
    delivery: Readonly<AxEventDelivery>,
    run: Readonly<AxEventRun>
  ): Readonly<AxEventContinuation> {
    const deliveryAdmission = delivery.admittedContinuation;
    const runAdmission = run.admittedContinuation;
    if (!deliveryAdmission || !runAdmission) {
      throw new Error(
        `outcome_unknown: resume delivery ${delivery.id} has no durable exclusive continuation admission`
      );
    }
    if (
      run.deliveryId !== delivery.id ||
      axEventContinuationFingerprint(deliveryAdmission) !==
        axEventContinuationFingerprint(runAdmission) ||
      run.targetId !== deliveryAdmission.targetId ||
      run.instanceKey !== deliveryAdmission.instanceKey
    ) {
      throw new Error(
        `outcome_unknown: resume run ${run.id} continuation admission does not match its delivery binding`
      );
    }
    return deliveryAdmission;
  }

  private assertRunActive(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason ?? new Error('Event run was aborted');
    }
    if (this.storeShutdownStarted) {
      throw new Error('AxEventRuntime store shutdown has started');
    }
  }

  private async requeueDeadLetter(
    deliveryId: string,
    deadLetterId: string,
    options?: Readonly<{ preserveRun?: boolean }>
  ): Promise<void> {
    if (this.deliveryRedriveBarriers.has(deliveryId)) {
      throw new Error(`Event delivery ${deliveryId} is already being redriven`);
    }
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.deliveryRedriveBarriers.set(deliveryId, barrier);
    try {
      await this.store.redriveDelivery(deliveryId, this.clock.now(), options);
      await this.store.removeDeadLetter(deadLetterId);
    } finally {
      if (this.deliveryRedriveBarriers.get(deliveryId) === barrier) {
        this.deliveryRedriveBarriers.delete(deliveryId);
      }
      release();
    }
  }

  private assertPublishActive(signal: AbortSignal): void {
    if (this.closing || this.storeShutdownStarted || signal.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error(
            typeof reason === 'string' ? reason : 'AxEventRuntime is closing'
          );
    }
  }

  private async invokeTarget(
    target: Readonly<AxEventTarget<any, any>>,
    instanceKey: string,
    ingress: Readonly<AxEventIngress>,
    eventContext: AxRuntimeEventContext,
    run: AxEventRun,
    onInvoke: () => Promise<void>
  ): Promise<InvocationResult> {
    const program = await this.resolveProgram(target, instanceKey, ingress);
    this.assertRunActive(eventContext.abortSignal);
    verifyEventTargetProgram(target, program);
    const stateAdapter = target.state ?? this.defaultStateAdapter(program);
    const stateKey = `${target.id}\n${axEventIdentityScope(ingress.identity)}\n${instanceKey}`;
    const stored = stateAdapter
      ? await this.stateStore.load(stateKey)
      : undefined;
    if (stored && stateAdapter) {
      let state = stored.state;
      if (
        stored.schemaVersion !== stateAdapter.schemaVersion ||
        stored.programVersion !== stateAdapter.programVersion
      ) {
        if (!stateAdapter.migrateState) {
          throw new Error(
            `state_migration_required:${target.id}:${stored.schemaVersion}:${stored.programVersion}`
          );
        }
        state = await stateAdapter.migrateState({
          state,
          fromSchemaVersion: stored.schemaVersion,
          fromProgramVersion: stored.programVersion,
          toSchemaVersion: stateAdapter.schemaVersion,
          toProgramVersion: stateAdapter.programVersion,
        });
        this.assertRunActive(eventContext.abortSignal);
      }
      await stateAdapter.restore(program, state);
      this.assertRunActive(eventContext.abortSignal);
    }
    const inputPlan = selectEventInputPlan(target, eventContext.continuation);
    let input: unknown;
    try {
      if (inputPlan) {
        input = mapEventInput(
          inputPlan,
          program.getSignature(),
          ingress,
          eventContext.continuation
        );
      } else {
        const mapped = await target.mapInput?.(ingress, {
          eventContext,
          continuation: eventContext.continuation,
        });
        this.assertRunActive(eventContext.abortSignal);
        if (mapped === undefined) {
          throw new AxEventInputError(
            `Target ${target.id} has no mapping for ${eventContext.continuation ? 'resume' : 'wake'}`
          );
        }
        input = normalizeEventInputValue(mapped, program.getSignature());
      }
    } catch (error) {
      if (error instanceof AxEventInputError) throw error;
      throw new AxEventInputError(`Target ${target.id} input mapping failed`, {
        cause: error,
      });
    }
    if (!eventContext.continuation) {
      for (const continuation of target.waitFor ?? []) {
        const value = resolveEventPath(continuation.value, ingress);
        if (
          (typeof value !== 'string' && typeof value !== 'number') ||
          !String(value).trim()
        ) {
          throw new AxEventInputError(
            `Target ${target.id} waitFor ${continuation.kind} did not resolve to a scalar`
          );
        }
        const metadataEntries = Object.entries(continuation.metadata ?? {}).map(
          ([key, selector]) =>
            [key, resolveEventPath(selector, ingress)] as const
        );
        const metadata = Object.fromEntries(
          metadataEntries.filter((entry) => entry[1] !== undefined)
        );
        eventContext.registerContinuation({
          correlation: [{ kind: continuation.kind, value: String(value) }],
          ...(continuation.expiresInMs !== undefined
            ? { expiresAt: this.clock.now() + continuation.expiresInMs }
            : {}),
          ...(metadataEntries.length ? { metadata: metadata as never } : {}),
        });
      }
    }
    const options = {
      ...(target.forwardOptions ?? {}),
      eventContext,
      eventInheritance: 'all' as const,
      ...(eventContext.authority ? { authority: eventContext.authority } : {}),
      abortSignal: eventContext.abortSignal,
    };
    let output: unknown;
    const chunks: AxGenDeltaOut<unknown>[] = [];
    try {
      await onInvoke();
      this.assertRunActive(eventContext.abortSignal);
      if (target.execution === 'streaming') {
        const stream = program.streamingForward(target.ai, input, options);
        const iterator = stream[Symbol.asyncIterator]();
        this.activeStreamIterators.set(run.id, iterator);
        try {
          for (;;) {
            const next = await iterator.next();
            this.assertRunActive(eventContext.abortSignal);
            if (next.done || eventContext.abortSignal.aborted) break;
            const chunk = next.value;
            chunks.push(structuredClone(chunk));
            const partialRun: AxEventRun = { ...run, chunks: [...chunks] };
            this.assertRunActive(eventContext.abortSignal);
            await this.store.saveRun(partialRun);
            this.assertRunActive(eventContext.abortSignal);
            for (const sink of target.sinks ?? []) {
              if (!sink.writeChunk || eventContext.abortSignal.aborted)
                continue;
              await this.dispatchChunkSink(
                sink,
                chunk,
                partialRun,
                eventContext
              );
            }
            output = chunk.partial ?? { ...(output as object), ...chunk.delta };
          }
        } finally {
          this.activeStreamIterators.delete(run.id);
          if (eventContext.abortSignal.aborted) {
            void Promise.resolve()
              .then(() => iterator.return?.())
              .catch(() => undefined);
          }
        }
      } else {
        output = await program.forward(target.ai, input, options);
        this.assertRunActive(eventContext.abortSignal);
      }
    } catch (error) {
      if (eventContext.abortSignal.aborted || this.storeShutdownStarted) {
        throw error;
      }
      if (error instanceof AxAgentClarificationError) {
        const state = error.getState();
        if (stateAdapter && state !== undefined) {
          this.assertRunActive(eventContext.abortSignal);
          await this.persistProgramState(
            stateKey,
            stored,
            stateAdapter,
            state,
            eventContext
          );
        }
        eventContext.registerContinuation({
          correlation: [{ kind: 'ax.clarification', value: run.id }],
          metadata: { question: error.question },
        });
        return { waiting: true, invoked: true };
      }
      if (stateAdapter) {
        const state = await stateAdapter.capture(program);
        this.assertRunActive(eventContext.abortSignal);
        await this.persistProgramState(
          stateKey,
          stored,
          stateAdapter,
          state,
          eventContext
        );
      }
      throw error;
    }
    if (stateAdapter) {
      const state = await stateAdapter.capture(program);
      this.assertRunActive(eventContext.abortSignal);
      try {
        await this.persistProgramState(
          stateKey,
          stored,
          stateAdapter,
          state,
          eventContext
        );
      } catch (error) {
        throw new AxEventOutcomeUnknownError(
          `Program completed but state persistence failed: ${axEventErrorMessage(error)}`,
          { cause: error }
        );
      }
    }
    return {
      output,
      ...(chunks.length ? { chunks } : {}),
      waiting: false,
      invoked: true,
    };
  }

  private async persistProgramState(
    key: string,
    stored: Readonly<AxProgramStateEnvelope> | undefined,
    adapter: Readonly<AxEventProgramStateAdapter<AnyProgram>>,
    state: unknown,
    eventContext: Readonly<AxEventContext>
  ): Promise<void> {
    this.assertRunActive(eventContext.abortSignal);
    await this.stateStore.compareAndSet(
      key,
      stored?.revision,
      {
        schemaVersion: adapter.schemaVersion,
        programVersion: adapter.programVersion,
        state,
        updatedAt: this.clock.now(),
      },
      eventContext.fencingToken === undefined
        ? undefined
        : {
            deliveryId: eventContext.deliveryId,
            fencingToken: eventContext.fencingToken,
          }
    );
  }

  private async resolveProgram(
    target: Readonly<AxEventTarget<any, any>>,
    instanceKey: string,
    ingress: Readonly<AxEventIngress>
  ): Promise<AnyProgram> {
    if (target.program) {
      const stateful = target.program as AnyProgram & {
        getState?: () => unknown;
        setState?: (state: unknown) => void;
      };
      if (target.state || (stateful.getState && stateful.setState)) {
        const previous = this.singletonTargetInstances.get(target.id);
        if (previous !== undefined && previous !== instanceKey) {
          throw new Error(
            `Stateful target ${target.id} used one program instance for both ${previous} and ${instanceKey}; configure createProgram(instance)`
          );
        }
        this.singletonTargetInstances.set(target.id, instanceKey);
      }
      return target.program;
    }
    return target.createProgram!({
      targetId: target.id,
      instanceKey,
      identity: ingress.identity ?? {},
    });
  }

  private defaultStateAdapter(
    program: AnyProgram
  ): AxEventProgramStateAdapter<AnyProgram> | undefined {
    const stateful = program as AnyProgram & {
      getState?: () => unknown;
      setState?: (state: unknown) => void;
    };
    if (!stateful.getState || !stateful.setState) return;
    return {
      schemaVersion: 1,
      programVersion: program.getId(),
      restore: (value, state) =>
        (value as typeof stateful).setState?.(structuredClone(state)),
      capture: (value) =>
        structuredClone((value as typeof stateful).getState?.()),
    };
  }

  private async dispatchFinalSinks(
    target: Readonly<AxEventTarget<any, any>>,
    run: AxEventRun,
    eventContext: AxRuntimeEventContext,
    delivery: Readonly<AxEventDelivery>
  ): Promise<AxEventRun> {
    const attempts = [];
    for (const sink of target.sinks ?? []) {
      this.assertRunActive(eventContext.abortSignal);
      const persisted = run.sinks?.find(
        (attempt) => attempt.sinkId === sink.id
      );
      if (persisted?.status === 'succeeded') {
        attempts.push(persisted);
        continue;
      }
      let error: unknown;
      let count = 0;
      for (; count < (this.options.maxAttempts ?? 5); count++) {
        try {
          await this.authorizeEventOperation(
            eventContext,
            'event.sink.write',
            'event.sink',
            sink.id
          );
          await sink.write(run.output, {
            run,
            eventContext,
            idempotencyKey: `${run.id}:${sink.id}`,
            signal: eventContext.abortSignal,
          });
          this.assertRunActive(eventContext.abortSignal);
          error = undefined;
          break;
        } catch (value) {
          if (eventContext.abortSignal.aborted || this.storeShutdownStarted) {
            throw value;
          }
          error = value;
          const effectParkReason = await this.reconcileEffects(
            delivery,
            eventContext.abortSignal
          );
          this.assertRunActive(eventContext.abortSignal);
          if (effectParkReason) {
            error = new Error(effectParkReason);
            break;
          }
          if (count + 1 < (this.options.maxAttempts ?? 5)) {
            await this.clock.sleep(
              Math.min(
                this.options.retryMaxMs ?? 60_000,
                (this.options.retryBaseMs ?? 1_000) * 2 ** count
              ),
              eventContext.abortSignal
            );
          }
        }
      }
      attempts.push({
        sinkId: sink.id,
        attempts: count + (error ? 0 : 1),
        status: error ? ('failed' as const) : ('succeeded' as const),
        ...(error ? { error: axEventErrorMessage(error) } : {}),
      });
      if (error) {
        this.assertRunActive(eventContext.abortSignal);
        await this.store.addDeadLetter({
          id: axEventId('dead-letter'),
          kind: 'sink',
          deliveryId: run.deliveryId,
          runId: run.id,
          sinkId: sink.id,
          reason: axEventErrorMessage(error),
          createdAt: this.clock.now(),
        });
      }
    }
    return { ...run, sinks: attempts };
  }

  private async dispatchChunkSink(
    sink: Readonly<AxEventSink<any>>,
    chunk: Readonly<AxGenDeltaOut<any>>,
    run: Readonly<AxEventRun>,
    eventContext: AxRuntimeEventContext
  ): Promise<void> {
    try {
      await this.authorizeEventOperation(
        eventContext,
        'event.sink.write_chunk',
        'event.sink',
        sink.id
      );
      this.assertRunActive(eventContext.abortSignal);
      await sink.writeChunk?.(chunk, {
        run,
        eventContext,
        idempotencyKey: `${run.id}:${sink.id}:chunk:${chunk.index}:${chunk.version}`,
        signal: eventContext.abortSignal,
      });
      this.assertRunActive(eventContext.abortSignal);
    } catch (error) {
      if (eventContext.abortSignal.aborted || this.storeShutdownStarted) {
        throw error;
      }
      await this.store.addDeadLetter({
        id: axEventId('dead-letter'),
        kind: 'sink',
        deliveryId: run.deliveryId,
        runId: run.id,
        sinkId: sink.id,
        reason: `Streaming chunk delivery failed: ${axEventErrorMessage(error)}`,
        createdAt: this.clock.now(),
      });
    }
  }

  private authorizeEventOperation(
    context: Readonly<AxEventContext>,
    operation: string,
    type: string,
    id: string
  ) {
    const verifiedIngressTenant =
      context.trust === 'authenticated' || context.trust === 'trusted'
        ? context.identity.tenantId
        : undefined;
    const tenantId =
      verifiedIngressTenant ?? context.authority?.principal.tenantId;
    return axAuthorize(
      context.authority,
      operation,
      {
        type,
        id,
        ...(tenantId ? { tenantId } : {}),
      },
      context.abortSignal
    );
  }

  private async awaitUnlessClosing<T>(
    operation: Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    if (signal.aborted || this.closing) {
      throw new Error('AxEventRuntime is closing');
    }
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        const abort = () => {
          reject(signal.reason ?? new Error('AxEventRuntime is closing'));
        };
        signal.addEventListener('abort', abort, { once: true });
        void operation.then(
          () => signal.removeEventListener('abort', abort),
          () => signal.removeEventListener('abort', abort)
        );
      }),
    ]);
  }

  private async resolveAuthority(
    ingress: Readonly<AxEventIngress>,
    signal?: AbortSignal
  ): Promise<Readonly<AxAuthorityContext> | undefined> {
    const resolver = this.options.authority;
    if (typeof resolver !== 'function') {
      return resolver ? axSnapshotAuthority(resolver) : undefined;
    }

    const timeoutMs = DEFAULT_AUTHORITY_RESOLVE_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      rejectAbort(
        signal?.reason ?? new Error('Authority resolution cancelled')
      );
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(`Host authority resolution timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
    });
    const callback = Promise.resolve().then(() => resolver(ingress));
    // Timeout/cancel drop this promise; swallow late reject so it cannot become
    // an unhandledRejection after Promise.race settles.
    void callback.catch(() => undefined);
    try {
      const authority = await Promise.race([callback, aborted, timedOut]);
      return authority ? axSnapshotAuthority(authority) : undefined;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async heartbeatClaim(
    delivery: Readonly<AxEventDelivery>,
    workerId: string,
    runController: AbortController,
    signal: AbortSignal
  ): Promise<void> {
    if (delivery.fencingToken === undefined) return;
    const heartbeatSignal = AbortSignal.any([
      signal,
      runController.signal,
      this.workerController.signal,
    ]);
    const heartbeatMs =
      this.options.heartbeatMs ??
      Math.floor((this.options.leaseMs ?? 30_000) / 3);
    const leaseMs = this.options.leaseMs ?? 30_000;
    while (!heartbeatSignal.aborted) {
      try {
        await this.clock.sleep(heartbeatMs, heartbeatSignal);
        if (heartbeatSignal.aborted) return;
        await this.trackStoreOperation(
          Promise.resolve().then(() =>
            this.store.renewClaim(
              delivery.id,
              workerId,
              delivery.fencingToken!,
              this.clock.now() + leaseMs,
              heartbeatSignal
            )
          )
        );
      } catch (error) {
        if (!heartbeatSignal.aborted) runController.abort(error);
        return;
      }
    }
  }

  private async reconcileEffects(
    delivery: Readonly<AxEventDelivery>,
    abortSignal: AbortSignal
  ): Promise<string | undefined> {
    if (!isEffectStore(this.store)) return;
    const store = this.store;
    const fence = this.effectFence(delivery);
    const effects = await store.listEffects(delivery.id);
    this.assertRunActive(abortSignal);
    const parkedReasons: string[] = [];
    for (let effect of effects) {
      if (
        effect.status === 'intent' ||
        effect.status === 'succeeded' ||
        effect.status === 'failed'
      ) {
        continue;
      }
      if (this.options.effectResolver) {
        try {
          const resolution = await this.resolveEffect(
            effect,
            delivery,
            abortSignal
          );
          this.assertRunActive(abortSignal);
          if (
            resolution.status === 'succeeded' ||
            resolution.status === 'failed'
          ) {
            effect = await store.transitionEffect(
              effect.id,
              effect.version,
              {
                type: 'settled',
                at: this.clock.now(),
                settlement: resolution,
              },
              fence
            );
          } else if (resolution.status === 'not_dispatched') {
            effect = await store.transitionEffect(
              effect.id,
              effect.version,
              { type: 'not_dispatched', at: this.clock.now() },
              fence
            );
          } else if (resolution.status === 'parked') {
            effect = await store.transitionEffect(
              effect.id,
              effect.version,
              {
                type: 'parked',
                at: this.clock.now(),
                reason: resolution.reason,
              },
              fence
            );
          }
        } catch (error) {
          if (this.storeShutdownStarted) throw error;
          const reason = this.effectReason(
            `Effect resolver failed or returned an invalid outcome for ${effect.operation}: ${axEventErrorMessage(error)}`
          );
          effect = await store.transitionEffect(
            effect.id,
            effect.version,
            { type: 'parked', at: this.clock.now(), reason },
            fence
          );
          parkedReasons.push(
            effect.parkedReason ?? `Event effect ${effect.operation} is parked`
          );
          continue;
        }
      }
      if (effect.status === 'parked') {
        parkedReasons.push(
          effect.parkedReason ?? `Event effect ${effect.operation} is parked`
        );
        continue;
      }
      if (
        effect.status === 'dispatched' &&
        effect.replaySafety !== 'idempotent'
      ) {
        const reason = this.effectReason(
          `Indeterminate non-idempotent effect ${effect.operation}:${effect.idempotencyKey}`
        );
        effect = await store.transitionEffect(
          effect.id,
          effect.version,
          { type: 'parked', at: this.clock.now(), reason },
          fence
        );
        parkedReasons.push(
          effect.parkedReason ?? `Event effect ${effect.operation} is parked`
        );
      }
    }
    return parkedReasons[0];
  }

  private async parkUnsettledCompletionEffects(
    delivery: Readonly<AxEventDelivery>,
    abortSignal: AbortSignal
  ): Promise<string | undefined> {
    if (!isEffectStore(this.store)) return;
    const fence = this.effectFence(delivery);
    const effects = await this.store.listEffects(delivery.id);
    this.assertRunActive(abortSignal);
    let firstReason: string | undefined;
    for (const effect of effects) {
      if (effect.status === 'succeeded' || effect.status === 'failed') continue;
      const reason =
        effect.parkedReason ??
        this.effectReason(
          `Target completed with unsettled effect ${effect.operation}:${effect.idempotencyKey} (${effect.status})`
        );
      firstReason ??= reason;
      if (effect.status === 'parked') continue;
      await this.store.transitionEffect(
        effect.id,
        effect.version,
        { type: 'parked', at: this.clock.now(), reason },
        fence
      );
      this.assertRunActive(abortSignal);
    }
    return firstReason;
  }

  private async resolveEffect(
    effect: Readonly<AxEventEffect>,
    delivery: Readonly<AxEventDelivery>,
    abortSignal: AbortSignal
  ): Promise<Readonly<AxEventEffectResolution>> {
    const resolver = this.options.effectResolver;
    if (!resolver) throw new Error('No event effect resolver is configured');
    if (abortSignal.aborted) throw abortSignal.reason;
    const timeoutMs = this.options.effectResolverTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const abortResolver = () => controller.abort(abortSignal.reason);
    abortSignal.addEventListener('abort', abortResolver, { once: true });
    const timeoutError = new Error(
      `Effect resolver timed out after ${timeoutMs}ms`
    );
    const timeout = this.clock.sleep(timeoutMs, controller.signal).then(() => {
      controller.abort(timeoutError);
      throw timeoutError;
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          resolver(effect, {
            delivery,
            abortSignal: controller.signal,
          })
        ),
        timeout,
      ]);
    } finally {
      abortSignal.removeEventListener('abort', abortResolver);
      if (!controller.signal.aborted) {
        controller.abort('Event effect resolver completed');
      }
    }
  }

  private async parkCancelledEffects(
    delivery: Readonly<AxEventDelivery>,
    cancellationReason: string
  ): Promise<string | undefined> {
    if (!isEffectStore(this.store)) return;
    const fence = this.effectFence(delivery);
    let parkedReason: string | undefined;
    const effects = await this.store.listEffects(delivery.id);
    if (this.storeShutdownStarted) return;
    for (const effect of effects) {
      if (effect.status === 'succeeded' || effect.status === 'failed') continue;
      const reason =
        effect.parkedReason ??
        this.effectReason(
          `Cancelled with unsettled effect ${effect.operation}:${effect.idempotencyKey} (${effect.status}): ${cancellationReason}`
        );
      parkedReason ??= reason;
      if (effect.status === 'parked') continue;
      if (this.storeShutdownStarted) return;
      await this.store.transitionEffect(
        effect.id,
        effect.version,
        {
          type: 'parked',
          at: this.clock.now(),
          reason,
        },
        fence
      );
    }
    return parkedReason;
  }

  private async parkOutcomeUnknownEffects(
    delivery: Readonly<AxEventDelivery>
  ): Promise<void> {
    if (!isEffectStore(this.store)) return;
    const fence = this.effectFence(delivery);
    const effects = await this.store.listEffects(delivery.id);
    if (this.storeShutdownStarted) return;
    for (const effect of effects) {
      if (effect.status !== 'dispatched') continue;
      if (this.storeShutdownStarted) return;
      await this.store.transitionEffect(
        effect.id,
        effect.version,
        {
          type: 'parked',
          at: this.clock.now(),
          reason: this.effectReason(
            `Target outcome is outcome_unknown with indeterminate effect ${effect.operation}:${effect.idempotencyKey}`
          ),
        },
        fence
      );
    }
  }

  private async parkDelivery(
    delivery: Readonly<AxEventDelivery>,
    reason: string,
    updatePreviousRun = true
  ): Promise<void> {
    if (this.storeShutdownStarted) return;
    if (updatePreviousRun && delivery.runId) {
      const previousRun = await this.store.getRun(delivery.runId);
      if (this.storeShutdownStarted) return;
      if (previousRun) {
        await this.store.saveRun({
          ...previousRun,
          claimedBy: delivery.claimedBy,
          status: 'parked',
          finishedAt: this.clock.now(),
          error: reason,
          ...(delivery.fencingToken !== undefined
            ? { fencingToken: delivery.fencingToken }
            : {}),
        });
        if (this.storeShutdownStarted) return;
      }
    }
    await this.store.saveDelivery({
      ...delivery,
      status: 'parked',
      error: reason,
    });
    if (this.storeShutdownStarted) return;
    await this.store.addDeadLetter({
      id: axEventId('dead-letter'),
      kind: 'delivery',
      deliveryId: delivery.id,
      ...(delivery.runId ? { runId: delivery.runId } : {}),
      reason,
      createdAt: this.clock.now(),
    });
  }

  private effectFence(delivery: Readonly<AxEventDelivery>): AxEventEffectFence {
    if (delivery.fencingToken === undefined) {
      throw new Error('Event effects require a fenced delivery claim');
    }
    return {
      deliveryId: delivery.id,
      fencingToken: delivery.fencingToken,
    };
  }

  private effectReason(reason: string): string {
    // 1,000 UTF-16 code units are always within the store's 4 KiB UTF-8 bound.
    return reason.slice(0, 1_000);
  }

  private async deadLetterDelivery(
    delivery: Readonly<AxEventDelivery>,
    reason: string
  ): Promise<void> {
    if (this.storeShutdownStarted) return;
    await this.store.saveDelivery({
      ...delivery,
      status: 'dead_lettered',
      error: reason,
    });
    if (this.storeShutdownStarted) return;
    await this.store.addDeadLetter({
      id: axEventId('dead-letter'),
      kind: 'delivery',
      deliveryId: delivery.id,
      ...(delivery.runId ? { runId: delivery.runId } : {}),
      reason,
      createdAt: this.clock.now(),
    });
  }
}

export function eventRuntime(
  options: Readonly<AxEventRuntimeOptions>
): AxEventRuntime {
  return new AxEventRuntime(options);
}
