import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventContinuation,
  type AxEventContinuationEnqueueRequest,
  type AxEventCorrelationKey,
  type AxEventDeadLetter,
  type AxEventDelivery,
  type AxEventEnqueueRequest,
  type AxEventPublishReceipt,
  type AxEventRun,
  type AxEventStore,
  type AxEventVerifierTransitionRecord,
  type AxEventVerifierTransitionRequest,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
  AxSystemEventClock,
} from './types.js';
import {
  axEventCanonicalDigest,
  axEventCanonicalJson,
  axEventId,
  axEventIdentityScope,
  axEventScopedCorrelationKey,
  axEventScopedDedupeKey,
} from './util.js';

export interface AxInMemoryEventStoreOptions {
  clock?: AxEventClock;
  maxPendingDeliveries?: number;
  maxPendingBytes?: number;
  maxEventBytes?: number;
}

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

export class AxInMemoryEventStore implements AxEventStore {
  readonly capabilities = {
    durability: 'volatile',
    coordination: 'single-worker',
    leases: false,
    transactions: false,
    compareAndSet: false,
    outputPersistence: true,
    verifierTransitions: 'axevent-verifier-transition-v2',
  } as const;

  private readonly clock: AxEventClock;
  private readonly maxPendingDeliveries: number;
  private readonly maxPendingBytes: number;
  private readonly maxEventBytes: number;
  private readonly deliveries = new Map<string, AxEventDelivery>();
  private readonly deliveryOrdering = new Map<string, 'strict' | 'relaxed'>();
  private readonly deliveryOrder: string[] = [];
  private readonly dedupe = new Map<
    string,
    { eventId: string; deliveryIds: string[] }
  >();
  private readonly runs = new Map<string, AxEventRun>();
  private readonly continuations = new Map<string, AxEventContinuation>();
  private readonly continuationKeys = new Map<string, string>();
  private readonly verifierTransitions = new Map<
    string,
    AxEventVerifierTransitionRecord
  >();
  private readonly deadLetters = new Map<string, AxEventDeadLetter>();
  private readonly workWaiters = new Set<Waiter>();
  private readonly capacityWaiters = new Set<Waiter>();
  private sequence = 0;
  private pendingDeliveries = 0;
  private pendingBytes = 0;

  constructor(options: Readonly<AxInMemoryEventStoreOptions> = {}) {
    this.clock = options.clock ?? new AxSystemEventClock();
    this.maxPendingDeliveries = options.maxPendingDeliveries ?? 10_000;
    this.maxPendingBytes = options.maxPendingBytes ?? 64 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 1024 * 1024;
  }

  async enqueue(
    request: Readonly<AxEventEnqueueRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    const dedupeKey = axEventScopedDedupeKey(request.ingress);
    const duplicate = this.dedupe.get(dedupeKey);
    if (duplicate) {
      return {
        eventId: duplicate.eventId,
        accepted: true,
        duplicate: true,
        durability: 'volatile',
        deliveryIds: [...duplicate.deliveryIds],
      };
    }

    const eventBytes = Math.max(
      0,
      ...request.deliveries.map((delivery) => delivery.sizeBytes)
    );
    if (eventBytes > this.maxEventBytes) {
      throw new AxEventBackpressureError(
        `Event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`
      );
    }
    const deadline = this.clock.now() + request.publishTimeoutMs;
    let required = this.capacityRequirement(request);
    while (!this.hasCapacity(required.count, required.bytes)) {
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) throw new AxEventBackpressureError();
      await this.waitForCapacity(remaining, signal);
      required = this.capacityRequirement(request);
    }

    const deliveryIds: string[] = [];
    for (const descriptor of request.deliveries) {
      const coalesced =
        descriptor.coalesce === 'latest'
          ? this.findCoalescible(descriptor, request.acceptedAt)
          : undefined;
      if (coalesced) {
        this.pendingBytes -= coalesced.sizeBytes;
        const replaced: AxEventDelivery = {
          ...coalesced,
          ingress: structuredClone(request.ingress),
          identityScope: axEventScopedDedupeKey(request.ingress).split(
            '\n'
          )[0]!,
          availableAt: descriptor.availableAt ?? request.acceptedAt,
          acceptedAt: request.acceptedAt,
          sizeBytes: descriptor.sizeBytes,
          retrySafety: descriptor.retrySafety ?? coalesced.retrySafety,
          ordering: descriptor.ordering ?? coalesced.ordering,
        };
        this.deliveries.set(coalesced.id, replaced);
        this.deliveryOrdering.set(
          coalesced.id,
          descriptor.ordering ?? 'strict'
        );
        this.pendingBytes += descriptor.sizeBytes;
        deliveryIds.push(coalesced.id);
        continue;
      }
      const id = axEventId('delivery');
      const delivery: AxEventDelivery = {
        id,
        sequence: ++this.sequence,
        ingress: structuredClone(request.ingress),
        identityScope: axEventScopedDedupeKey(request.ingress).split('\n')[0]!,
        routeId: descriptor.routeId,
        action: descriptor.action,
        ...(descriptor.targetId ? { targetId: descriptor.targetId } : {}),
        instanceKey: descriptor.instanceKey,
        status: 'queued',
        attempt: 0,
        availableAt: descriptor.availableAt ?? request.acceptedAt,
        acceptedAt: request.acceptedAt,
        sizeBytes: descriptor.sizeBytes,
        retrySafety: descriptor.retrySafety ?? 'unknown',
        ordering: descriptor.ordering ?? 'strict',
      };
      this.deliveries.set(id, delivery);
      this.deliveryOrdering.set(id, descriptor.ordering ?? 'strict');
      this.deliveryOrder.push(id);
      deliveryIds.push(id);
      this.pendingDeliveries++;
      this.pendingBytes += delivery.sizeBytes;
    }
    this.dedupe.set(dedupeKey, {
      eventId: request.ingress.event.id,
      deliveryIds,
    });
    this.notify(this.workWaiters);
    return {
      eventId: request.ingress.event.id,
      accepted: true,
      duplicate: false,
      durability: 'volatile',
      deliveryIds,
    };
  }

  async enqueueContinuation(
    request: Readonly<AxEventContinuationEnqueueRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    const existing = this.continuations.get(request.continuation.id);
    if (existing) {
      this.assertContinuationMatch(existing, request.continuation);
      return this.enqueue(request.enqueue, signal);
    }
    await this.registerContinuation(request.continuation);
    try {
      return await this.enqueue(request.enqueue, signal);
    } catch (error) {
      await this.completeContinuation(request.continuation.id);
      throw error;
    }
  }

  async transitionVerifier(
    request: Readonly<AxEventVerifierTransitionRequest>
  ): Promise<AxEventPublishReceipt> {
    const requestCommitment = await axEventCanonicalDigest(request);
    const childProjection = this.verifierChildProjection(request);
    const expectedChildCommitment =
      await axEventCanonicalDigest(childProjection);
    const committed = this.verifierTransitions.get(request.operationId);
    if (committed) {
      this.assertVerifierTransition(
        committed,
        request,
        requestCommitment,
        expectedChildCommitment
      );
      return { ...structuredClone(committed.receipt), duplicate: true };
    }
    const dedupeKey = axEventScopedDedupeKey(request.child.ingress);
    const parent = this.deliveries.get(request.parent.delivery.id);
    if (
      !parent ||
      parent.fencingToken !== request.parent.expectedFencingToken ||
      (parent.status !== 'claimed' && parent.status !== 'running')
    ) {
      throw new Error(
        `Stale verifier transition for ${request.parent.delivery.id}`
      );
    }
    if (
      request.parent.delivery.status !== 'waiting_event' ||
      request.parent.run.status !== 'waiting_event' ||
      request.child.deliveries.length !== 1
    ) {
      throw new Error('Verifier transition requires one waiting child');
    }
    const descriptor = request.child.deliveries[0]!;
    if (
      this.deliveries.has(request.childDeliveryId) ||
      this.dedupe.has(dedupeKey)
    ) {
      throw new Error(
        `Verifier transition child is already owned: ${request.childDeliveryId}`
      );
    }
    const eventBytes = descriptor.sizeBytes;
    if (eventBytes > this.maxEventBytes) {
      throw new AxEventBackpressureError(
        `Event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`
      );
    }
    if (
      this.pendingDeliveries > this.maxPendingDeliveries ||
      this.pendingBytes - parent.sizeBytes + eventBytes > this.maxPendingBytes
    ) {
      throw new AxEventBackpressureError();
    }
    for (const correlation of request.continuation.correlation) {
      const key = axEventScopedCorrelationKey(
        request.continuation.identityScope,
        correlation.kind,
        correlation.value
      );
      const owner = this.continuationKeys.get(key);
      if (owner && owner !== request.continuation.id) {
        throw new Error(
          `Event continuation correlation is already owned: ${correlation.kind}:${correlation.value}`
        );
      }
    }

    const delivery: AxEventDelivery = {
      id: request.childDeliveryId,
      sequence: this.sequence + 1,
      ingress: structuredClone(request.child.ingress),
      identityScope: axEventIdentityScope(request.child.ingress.identity),
      routeId: descriptor.routeId,
      action: descriptor.action,
      ...(descriptor.targetId ? { targetId: descriptor.targetId } : {}),
      instanceKey: descriptor.instanceKey,
      status: 'queued',
      attempt: 0,
      availableAt: descriptor.availableAt ?? request.child.acceptedAt,
      acceptedAt: request.child.acceptedAt,
      sizeBytes: descriptor.sizeBytes,
      retrySafety: descriptor.retrySafety ?? 'unknown',
      ordering: descriptor.ordering ?? 'strict',
    };
    if (
      axEventCanonicalJson(this.persistedChildProjection(delivery)) !==
      axEventCanonicalJson(childProjection)
    ) {
      throw new Error('Verifier transition child does not match request');
    }
    this.sequence = delivery.sequence;
    this.runs.set(request.parent.run.id, structuredClone(request.parent.run));
    this.deliveries.set(
      request.parent.delivery.id,
      structuredClone(request.parent.delivery)
    );
    this.pendingDeliveries--;
    this.pendingBytes -= parent.sizeBytes;
    if (request.consumeContinuationId) {
      this.completeContinuationNow(request.consumeContinuationId);
    }
    this.continuations.set(
      request.continuation.id,
      structuredClone(request.continuation)
    );
    for (const correlation of request.continuation.correlation) {
      this.continuationKeys.set(
        axEventScopedCorrelationKey(
          request.continuation.identityScope,
          correlation.kind,
          correlation.value
        ),
        request.continuation.id
      );
    }
    this.deliveries.set(delivery.id, delivery);
    this.deliveryOrdering.set(delivery.id, delivery.ordering);
    this.deliveryOrder.push(delivery.id);
    this.pendingDeliveries++;
    this.pendingBytes += delivery.sizeBytes;
    this.dedupe.set(dedupeKey, {
      eventId: request.child.ingress.event.id,
      deliveryIds: [delivery.id],
    });
    const receipt: AxEventPublishReceipt = {
      eventId: request.child.ingress.event.id,
      accepted: true,
      duplicate: false,
      durability: 'volatile',
      deliveryIds: [delivery.id],
    };
    this.verifierTransitions.set(request.operationId, {
      operationId: request.operationId,
      requestCommitment,
      receipt: structuredClone(receipt),
      childDeliveryId: request.childDeliveryId,
      childCommitment: expectedChildCommitment,
    });
    this.notify(this.workWaiters);
    this.notify(this.capacityWaiters);
    return receipt;
  }

  async confirmVerifierTransition(
    request: Readonly<AxEventVerifierTransitionRequest>
  ): Promise<Readonly<AxEventPublishReceipt> | undefined> {
    const requestCommitment = await axEventCanonicalDigest(request);
    const childCommitment = await axEventCanonicalDigest(
      this.verifierChildProjection(request)
    );
    const value = this.verifierTransitions.get(request.operationId);
    if (!value) return;
    this.assertVerifierTransition(
      value,
      request,
      requestCommitment,
      childCommitment
    );
    const child = this.deliveries.get(value.childDeliveryId);
    if (
      child &&
      (await axEventCanonicalDigest(this.persistedChildProjection(child))) !==
        value.childCommitment
    ) {
      throw new Error(
        `Verifier transition child is corrupt: ${request.operationId}`
      );
    }
    return structuredClone(value.receipt);
  }

  async claim(
    workerId: string,
    now: number,
    leaseMs = 30_000
  ): Promise<AxEventDelivery | undefined> {
    for (const id of this.deliveryOrder) {
      const delivery = this.deliveries.get(id);
      if (!delivery || delivery.status !== 'queued') continue;
      if (delivery.availableAt > now) continue;
      if (this.hasEarlierInstanceWork(delivery)) continue;
      const claimed: AxEventDelivery = {
        ...delivery,
        status: 'claimed',
        claimedBy: workerId,
        fencingToken: (delivery.fencingToken ?? 0) + 1,
        leaseExpiresAt: now + leaseMs,
      };
      this.deliveries.set(id, claimed);
      return structuredClone(claimed);
    }
    return;
  }

  async renewClaim(
    deliveryId: string,
    workerId: string,
    fencingToken: number,
    leaseExpiresAt: number
  ): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (
      !delivery ||
      delivery.claimedBy !== workerId ||
      delivery.fencingToken !== fencingToken
    ) {
      throw new Error(`Stale event claim for ${deliveryId}`);
    }
    this.deliveries.set(deliveryId, { ...delivery, leaseExpiresAt });
  }

  async getDelivery(
    deliveryId: string
  ): Promise<Readonly<AxEventDelivery> | undefined> {
    const delivery = this.deliveries.get(deliveryId);
    return delivery ? structuredClone(delivery) : undefined;
  }

  async saveDelivery(delivery: Readonly<AxEventDelivery>): Promise<void> {
    const previous = this.deliveries.get(delivery.id);
    this.deliveries.set(delivery.id, structuredClone(delivery));
    if (
      previous &&
      !this.isTerminal(previous.status) &&
      this.isTerminal(delivery.status)
    ) {
      this.pendingDeliveries--;
      this.pendingBytes -= previous.sizeBytes;
      this.notify(this.capacityWaiters);
    }
    if (delivery.status === 'queued') this.notify(this.workWaiters);
  }

  async saveRun(run: Readonly<AxEventRun>): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async getRun(runId: string): Promise<Readonly<AxEventRun> | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async registerContinuation(
    continuation: Readonly<AxEventContinuation>
  ): Promise<void> {
    for (const correlation of continuation.correlation) {
      const key = axEventScopedCorrelationKey(
        continuation.identityScope,
        correlation.kind,
        correlation.value
      );
      const existing = this.continuationKeys.get(key);
      if (existing && existing !== continuation.id) {
        throw new Error(
          `Event continuation correlation is already owned: ${correlation.kind}:${correlation.value}`
        );
      }
    }
    this.continuations.set(continuation.id, structuredClone(continuation));
    for (const correlation of continuation.correlation) {
      this.continuationKeys.set(
        axEventScopedCorrelationKey(
          continuation.identityScope,
          correlation.kind,
          correlation.value
        ),
        continuation.id
      );
    }
  }

  async findContinuation(
    identityScope: string,
    correlation: Readonly<AxEventCorrelationKey>,
    now: number
  ): Promise<Readonly<AxEventContinuation> | undefined> {
    const key = axEventScopedCorrelationKey(
      identityScope,
      correlation.kind,
      correlation.value
    );
    const id = this.continuationKeys.get(key);
    if (!id) return;
    const continuation = this.continuations.get(id);
    if (!continuation) return;
    if (continuation.expiresAt !== undefined && continuation.expiresAt <= now) {
      await this.completeContinuation(id);
      return;
    }
    return structuredClone(continuation);
  }

  async completeContinuation(id: string): Promise<void> {
    this.completeContinuationNow(id);
  }

  private completeContinuationNow(id: string): void {
    const continuation = this.continuations.get(id);
    if (!continuation) return;
    for (const correlation of continuation.correlation) {
      this.continuationKeys.delete(
        axEventScopedCorrelationKey(
          continuation.identityScope,
          correlation.kind,
          correlation.value
        )
      );
    }
    this.continuations.delete(id);
  }

  async addDeadLetter(deadLetter: Readonly<AxEventDeadLetter>): Promise<void> {
    this.deadLetters.set(deadLetter.id, structuredClone(deadLetter));
  }

  async getDeadLetter(
    id: string
  ): Promise<Readonly<AxEventDeadLetter> | undefined> {
    const deadLetter = this.deadLetters.get(id);
    return deadLetter ? structuredClone(deadLetter) : undefined;
  }

  async removeDeadLetter(id: string): Promise<void> {
    this.deadLetters.delete(id);
  }

  async listDeadLetters(): Promise<readonly Readonly<AxEventDeadLetter>[]> {
    return [...this.deadLetters.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((value) => structuredClone(value));
  }

  async redriveDelivery(deliveryId: string, now: number): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new Error(`Unknown event delivery: ${deliveryId}`);
    if (!this.isTerminal(delivery.status)) {
      throw new Error(`Event delivery ${deliveryId} is not terminal`);
    }
    const redriven: AxEventDelivery = {
      ...delivery,
      status: 'queued',
      attempt: 0,
      availableAt: now,
      error: undefined,
      claimedBy: undefined,
      runId: undefined,
    };
    this.deliveries.set(deliveryId, redriven);
    this.pendingDeliveries++;
    this.pendingBytes += redriven.sizeBytes;
    this.notify(this.workWaiters);
  }

  async nextAvailableAt(_now: number): Promise<number | undefined> {
    let next: number | undefined;
    for (const delivery of this.deliveries.values()) {
      if (delivery.status !== 'queued') continue;
      if (next === undefined || delivery.availableAt < next) {
        next = delivery.availableAt;
      }
    }
    return next;
  }

  async waitForWork(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (
      [...this.deliveries.values()].some(
        (delivery) => delivery.status === 'queued'
      )
    ) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.workWaiters.add(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          this.workWaiters.delete(waiter);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  }

  async isIdle(): Promise<boolean> {
    return this.pendingDeliveries === 0;
  }

  async close(): Promise<void> {
    const error = new Error('AxInMemoryEventStore closed');
    for (const waiter of [...this.workWaiters, ...this.capacityWaiters]) {
      waiter.reject(error);
    }
    this.workWaiters.clear();
    this.capacityWaiters.clear();
  }

  private hasCapacity(count: number, bytes: number): boolean {
    return (
      this.pendingDeliveries + count <= this.maxPendingDeliveries &&
      this.pendingBytes + bytes <= this.maxPendingBytes
    );
  }

  private async waitForCapacity(
    ms: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    let waiter: Waiter | undefined;
    const capacity = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      this.capacityWaiters.add(waiter);
    });
    try {
      await Promise.race([
        capacity,
        this.clock.sleep(ms, signal).then(() => {
          throw new AxEventBackpressureError();
        }),
      ]);
    } finally {
      if (waiter) this.capacityWaiters.delete(waiter);
    }
  }

  private hasEarlierInstanceWork(delivery: Readonly<AxEventDelivery>): boolean {
    if (this.deliveryOrdering.get(delivery.id) === 'relaxed') return false;
    return [...this.deliveries.values()].some(
      (candidate) =>
        candidate.sequence < delivery.sequence &&
        candidate.targetId === delivery.targetId &&
        candidate.instanceKey === delivery.instanceKey &&
        !this.isTerminal(candidate.status)
    );
  }

  private findCoalescible(
    descriptor: Readonly<AxEventEnqueueRequest['deliveries'][number]>,
    now: number
  ): AxEventDelivery | undefined {
    return [...this.deliveries.values()].find(
      (delivery) =>
        delivery.status === 'queued' &&
        delivery.availableAt > now &&
        delivery.routeId === descriptor.routeId &&
        delivery.targetId === descriptor.targetId &&
        delivery.instanceKey === descriptor.instanceKey
    );
  }

  private capacityRequirement(request: Readonly<AxEventEnqueueRequest>): {
    count: number;
    bytes: number;
  } {
    let count = 0;
    let bytes = 0;
    for (const descriptor of request.deliveries) {
      const coalesced =
        descriptor.coalesce === 'latest'
          ? this.findCoalescible(descriptor, request.acceptedAt)
          : undefined;
      if (coalesced) {
        bytes += descriptor.sizeBytes - coalesced.sizeBytes;
      } else {
        count++;
        bytes += descriptor.sizeBytes;
      }
    }
    return { count, bytes };
  }

  private isTerminal(status: AxEventDelivery['status']): boolean {
    return (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'verification_failed' ||
      status === 'cancelled' ||
      status === 'dead_lettered' ||
      status === 'output_persistence_failed' ||
      status === 'outcome_unknown' ||
      status === 'waiting_event'
    );
  }

  private assertContinuationMatch(
    existing: Readonly<AxEventContinuation>,
    requested: Readonly<AxEventContinuation>
  ): void {
    if (JSON.stringify(existing) !== JSON.stringify(requested)) {
      throw new Error(
        `Event continuation id is already owned: ${requested.id}`
      );
    }
  }

  private assertVerifierTransition(
    record: Readonly<AxEventVerifierTransitionRecord>,
    request: Readonly<AxEventVerifierTransitionRequest>,
    requestCommitment: string,
    childCommitment: string
  ): void {
    if (
      record.operationId !== request.operationId ||
      record.requestCommitment !== requestCommitment ||
      record.childDeliveryId !== request.childDeliveryId ||
      record.childCommitment !== childCommitment ||
      axEventCanonicalJson(record.receipt) !==
        axEventCanonicalJson({
          eventId: request.child.ingress.event.id,
          accepted: true,
          duplicate: false,
          durability: 'volatile',
          deliveryIds: [request.childDeliveryId],
        })
    ) {
      throw new Error(
        `Verifier transition operation is already owned: ${request.operationId}`
      );
    }
  }

  private verifierChildProjection(
    request: Readonly<AxEventVerifierTransitionRequest>
  ): Omit<
    AxEventDelivery,
    | 'sequence'
    | 'status'
    | 'attempt'
    | 'claimedBy'
    | 'runId'
    | 'error'
    | 'leaseExpiresAt'
    | 'fencingToken'
    | 'invocationStarted'
    | 'recoveredFromExpiredLease'
  > {
    const descriptor = request.child.deliveries[0]!;
    return {
      id: request.childDeliveryId,
      ingress: request.child.ingress,
      identityScope: axEventIdentityScope(request.child.ingress.identity),
      routeId: descriptor.routeId,
      action: descriptor.action,
      ...(descriptor.targetId ? { targetId: descriptor.targetId } : {}),
      instanceKey: descriptor.instanceKey,
      availableAt: descriptor.availableAt ?? request.child.acceptedAt,
      acceptedAt: request.child.acceptedAt,
      sizeBytes: descriptor.sizeBytes,
      retrySafety: descriptor.retrySafety ?? 'unknown',
      ordering: descriptor.ordering ?? 'strict',
    };
  }

  private persistedChildProjection(
    delivery: Readonly<AxEventDelivery>
  ): ReturnType<AxInMemoryEventStore['verifierChildProjection']> {
    return {
      id: delivery.id,
      ingress: delivery.ingress,
      identityScope: delivery.identityScope,
      routeId: delivery.routeId,
      action: delivery.action,
      ...(delivery.targetId ? { targetId: delivery.targetId } : {}),
      instanceKey: delivery.instanceKey,
      availableAt: delivery.availableAt,
      acceptedAt: delivery.acceptedAt,
      sizeBytes: delivery.sizeBytes,
      retrySafety: delivery.retrySafety,
      ordering: delivery.ordering,
    };
  }

  private notify(waiters: Set<Waiter>): void {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  }
}

export class AxInMemoryProgramStateStore implements AxProgramStateStore {
  private readonly states = new Map<string, AxProgramStateEnvelope>();

  async load(
    key: string
  ): Promise<Readonly<AxProgramStateEnvelope> | undefined> {
    const value = this.states.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async compareAndSet(
    key: string,
    expectedRevision: number | undefined,
    state: Readonly<Omit<AxProgramStateEnvelope, 'revision'>>,
    _fence?: Readonly<{ deliveryId: string; fencingToken: number }>
  ): Promise<Readonly<AxProgramStateEnvelope>> {
    const current = this.states.get(key);
    if (current?.revision !== expectedRevision) {
      throw new Error(
        `Program state compare-and-set failed for ${key}: expected ${String(expectedRevision)}, current ${String(current?.revision)}`
      );
    }
    const next: AxProgramStateEnvelope = {
      ...structuredClone(state),
      revision: (current?.revision ?? 0) + 1,
    };
    this.states.set(key, next);
    return structuredClone(next);
  }

  async delete(key: string): Promise<void> {
    this.states.delete(key);
  }
}
