import { AxAgentClarificationError } from '../agent/agentInternal/agentStateTypes.js';
import type { AxGenDeltaOut, AxProgrammable } from '../dsp/types.js';
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
  type AxEventSourceHandle,
  type AxEventStore,
  type AxEventTarget,
  type AxProgramStateEnvelope,
  AxSystemEventClock,
  axIsEventOutputPersistenceError,
} from './types.js';
import {
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
  private readonly activeStreamIterators = new Map<
    string,
    AsyncIterator<AxGenDeltaOut<unknown>>
  >();
  private readonly sourceHandles: AxEventSourceHandle[] = [];
  private readonly sourceController = new AbortController();
  private readonly workerController = new AbortController();
  private readonly inFlightPublishes = new Set<Promise<unknown>>();
  private readonly inFlightStoreOperations = new Set<Promise<unknown>>();
  private workerPromises: Promise<void>[] = [];
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
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closing) throw new Error('AxEventRuntime is closing');
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
    this.started = true;
    const workers = this.options.workerConcurrency ?? 4;
    if (!Number.isInteger(workers) || workers < 1) {
      throw new Error('AxEventRuntime workerConcurrency must be positive');
    }
    this.workerPromises = Array.from({ length: workers }, (_, index) =>
      this.workerLoop(`${this.options.workerId ?? this.id}:${index}`)
    );
    try {
      for (const source of this.options.sources ?? []) {
        const handle = await source.start({
          signal: this.sourceController.signal,
          publish: (ingress, signal) => this.publish(ingress, signal),
          reportError: (error) => {
            void Promise.resolve()
              .then(() => this.options.onSourceError?.(source.id, error))
              .catch(() => undefined);
          },
        });
        if (handle) this.sourceHandles.push(handle);
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
      ? AbortSignal.any([signal, this.sourceController.signal])
      : this.sourceController.signal;
    this.assertPublishActive(publishSignal);
    axValidateEventEnvelope(ingress.event);
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
    const operationId = axEventId('event-redrive');
    const controller = new AbortController();
    this.activeRuns.set(operationId, controller);
    try {
      const deadLetter = await this.store.getDeadLetter(deadLetterId);
      this.assertRunActive(controller.signal);
      if (!deadLetter)
        throw new Error(`Unknown event dead letter: ${deadLetterId}`);
      if (deadLetter.kind === 'delivery') {
        await this.store.redriveDelivery(
          deadLetter.deliveryId,
          this.clock.now()
        );
        this.assertRunActive(controller.signal);
        await this.store.removeDeadLetter(deadLetterId);
        return;
      }
      const run = deadLetter.runId
        ? await this.store.getRun(deadLetter.runId)
        : undefined;
      this.assertRunActive(controller.signal);
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
      const context = new AxRuntimeEventContext(
        this.id,
        run.id,
        delivery.id,
        delivery.routeId,
        target.id,
        continuation?.instanceKey ?? run.instanceKey,
        delivery.ingress,
        delivery.ingress.identity ?? {},
        delivery.ingress.trust ?? 'untrusted',
        run.attempt,
        delivery.id,
        controller.signal,
        continuation,
        undefined,
        undefined,
        () => this.clock.now(),
        () => this.storeShutdownStarted
      );
      await sink.write(run.output, {
        run,
        eventContext: context,
        idempotencyKey: `${run.id}:${sink.id}`,
        signal: controller.signal,
      });
      this.assertRunActive(controller.signal);
      await this.store.removeDeadLetter(deadLetterId);
    } finally {
      this.activeRuns.delete(operationId);
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
    this.closing = true;
    this.sourceController.abort('AxEventRuntime closing');
    const sourceClose = Promise.allSettled(
      this.sourceHandles.map((handle) =>
        Promise.resolve().then(() => handle.close())
      )
    );
    await this.waitUntilCloseDeadline(sourceClose, deadline);
    await this.waitUntilCloseDeadline(
      this.waitForTrackedOperations(this.inFlightPublishes),
      deadline
    );
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
    }
    this.workerController.abort('AxEventRuntime closed');
    for (const controller of this.activeRuns.values()) {
      controller.abort('AxEventRuntime closed');
    }
    for (const iterator of this.activeStreamIterators.values()) {
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
    }
    const workers = Promise.allSettled(this.workerPromises);
    await this.waitUntilCloseDeadline(
      Promise.allSettled([
        workers,
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
          } else {
            await this.clock.sleep(Math.max(1, next - now), signal);
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
        if (route.action === 'observe') {
          await route.observe?.(claimed.ingress, eventContext);
          this.assertRunActive(controller.signal);
        } else if (route.action === 'invalidate') {
          await route.invalidator!.invalidate(claimed.ingress, eventContext);
          this.assertRunActive(controller.signal);
        } else {
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

        const registrations = eventContext.takeRegistrations();
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
        const waiting = result.waiting || continuations.length > 0;
        run = {
          ...run,
          status: waiting ? 'waiting_event' : 'succeeded',
          finishedAt: this.clock.now(),
          ...(continuations.length
            ? { continuationIds: continuations.map((value) => value.id) }
            : {}),
        };
        // Persist the complete output before any final sink dispatch.
        this.assertRunActive(controller.signal);
        await this.store.saveRun(run);
        this.assertRunActive(controller.signal);
        if (!waiting && target && run.output !== undefined) {
          run = await this.dispatchFinalSinks(target, run, eventContext);
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
          await this.store.saveRun(run);
        }
        this.assertRunActive(controller.signal);
        await this.saveSuccessfulDelivery(
          {
            ...claimed,
            status: waiting ? 'waiting_event' : 'succeeded',
            attempt,
            runId,
          },
          continuation
        );
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
            // acknowledgement did not. Keep the succeeded run and journal for
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
        // The persisted succeeded run and admitted continuation remain the
        // source of truth. Leave the active delivery non-terminal so an expired
        // lease can retry only atomic completion/sink recovery.
        return;
      }
      await this.deadLetterDelivery(claimed, axEventErrorMessage(error));
    }
  }

  private async resumePersistedCompletion(
    claimed: Readonly<AxEventDelivery>,
    workerId: string,
    route: Readonly<AxEventRoute>,
    persisted: Readonly<AxEventRun> | undefined
  ): Promise<boolean> {
    if (
      !claimed.recoveredFromExpiredLease ||
      persisted?.status !== 'succeeded'
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
      const completionEffectParkReason =
        await this.parkUnsettledCompletionEffects(claimed, controller.signal);
      this.assertRunActive(controller.signal);
      if (completionEffectParkReason) {
        await this.parkDelivery(claimed, completionEffectParkReason);
        return true;
      }
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
        run = await this.dispatchFinalSinks(target, run, context);
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
    eventContext: AxRuntimeEventContext
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
      if (
        effect.status !== 'dispatched' ||
        effect.replaySafety === 'idempotent'
      ) {
        continue;
      }
      parkedReason = this.effectReason(
        `Cancelled with indeterminate effect: ${cancellationReason}`
      );
      if (this.storeShutdownStarted) return;
      await this.store.transitionEffect(
        effect.id,
        effect.version,
        {
          type: 'parked',
          at: this.clock.now(),
          reason: parkedReason,
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
