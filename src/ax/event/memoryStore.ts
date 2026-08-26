import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventContinuation,
  type AxEventCorrelationKey,
  type AxEventDeadLetter,
  type AxEventDelivery,
  type AxEventEffect,
  type AxEventEffectCreateRequest,
  type AxEventEffectFence,
  type AxEventEffectStore,
  type AxEventEffectTransition,
  type AxEventEnqueueRequest,
  type AxEventPublishReceipt,
  type AxEventRun,
  type AxEventStore,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
  AxSystemEventClock,
} from './types.js';
import {
  axApplyEventEffectTransition,
  axEventContinuationFingerprint,
  axEventEffectRequestDigest,
  axEventId,
  axEventIngressFingerprint,
  axEventScopedCorrelationKey,
  axEventScopedDedupeKey,
  axValidateEventEffectCreateRequest,
} from './util.js';

export interface AxInMemoryEventStoreOptions {
  clock?: AxEventClock;
  maxPendingDeliveries?: number;
  maxPendingBytes?: number;
  maxEventBytes?: number;
}

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

const MAX_FENCING_TOKEN = Number.MAX_SAFE_INTEGER;

export class AxInMemoryEventStore implements AxEventStore, AxEventEffectStore {
  readonly capabilities = {
    durability: 'volatile',
    coordination: 'single-worker',
    leases: false,
    transactions: false,
    compareAndSet: false,
    outputPersistence: true,
    effectLedger: true,
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
    { eventId: string; deliveryIds: string[]; ingressFingerprint: string }
  >();
  private readonly runs = new Map<string, AxEventRun>();
  private readonly effects = new Map<string, AxEventEffect>();
  private readonly effectKeys = new Map<string, string>();
  private readonly continuations = new Map<string, AxEventContinuation>();
  private readonly continuationKeys = new Map<string, string>();
  private readonly continuationAdmissions = new Map<string, string>();
  private readonly deadLetters = new Map<string, AxEventDeadLetter>();
  private readonly workWaiters = new Set<Waiter>();
  private readonly capacityWaiters = new Set<Waiter>();
  private sequence = 0;
  private pendingDeliveries = 0;
  private pendingBytes = 0;
  private closed = false;

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
    this.assertWritable(signal);
    const dedupeKey = axEventScopedDedupeKey(request.ingress);
    const ingressFingerprint = axEventIngressFingerprint(request.ingress);
    const duplicate = this.dedupe.get(dedupeKey);
    if (duplicate) {
      if (duplicate.ingressFingerprint !== ingressFingerprint) {
        throw new Error(
          `Event identity conflicts with previously accepted ingress ${request.ingress.event.source}:${request.ingress.event.id}`
        );
      }
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

    // There are no awaits after this check, so shutdown/abort cannot race the
    // following in-memory mutation in the same JavaScript turn.
    this.assertWritable(signal);
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
      ingressFingerprint,
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

  async claim(
    workerId: string,
    now: number,
    leaseMs = 30_000
  ): Promise<AxEventDelivery | undefined> {
    this.assertWritable();
    for (const id of this.deliveryOrder) {
      const delivery = this.deliveries.get(id);
      if (!delivery) continue;
      const recovered =
        (delivery.status === 'claimed' || delivery.status === 'running') &&
        delivery.leaseExpiresAt !== undefined &&
        delivery.leaseExpiresAt <= now;
      if (delivery.status !== 'queued' && !recovered) continue;
      if (delivery.status === 'queued' && delivery.availableAt > now) continue;
      if (this.hasEarlierInstanceWork(delivery)) continue;
      const fencingToken = delivery.fencingToken ?? 0;
      this.assertFencingTokenCanAdvance(delivery.id, fencingToken);
      const claimed: AxEventDelivery = {
        ...delivery,
        status: 'claimed',
        claimedBy: workerId,
        fencingToken: fencingToken + 1,
        leaseExpiresAt: now + leaseMs,
        ...(recovered ? { recoveredFromExpiredLease: true } : {}),
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
    leaseExpiresAt: number,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertWritable(signal);
    this.assertSafeFencingToken(deliveryId, fencingToken);
    const delivery = this.deliveries.get(deliveryId);
    const now = this.clock.now();
    if (
      !delivery ||
      delivery.claimedBy !== workerId ||
      delivery.fencingToken !== fencingToken ||
      (delivery.status !== 'claimed' && delivery.status !== 'running') ||
      delivery.leaseExpiresAt === undefined ||
      delivery.leaseExpiresAt <= now ||
      leaseExpiresAt <= now
    ) {
      throw new Error(`Stale event claim for ${deliveryId}`);
    }
    this.assertWritable(signal);
    this.deliveries.set(deliveryId, { ...delivery, leaseExpiresAt });
  }

  async getDelivery(
    deliveryId: string
  ): Promise<Readonly<AxEventDelivery> | undefined> {
    const delivery = this.deliveries.get(deliveryId);
    return delivery ? structuredClone(delivery) : undefined;
  }

  async saveDelivery(delivery: Readonly<AxEventDelivery>): Promise<void> {
    this.assertWritable();
    this.assertActiveClaim(
      delivery.id,
      delivery.claimedBy,
      delivery.fencingToken
    );
    const previous = this.deliveries.get(delivery.id);
    if (delivery.admittedContinuation && !previous?.admittedContinuation) {
      throw new Error(
        `Continuation admission for ${delivery.id} must be created atomically`
      );
    }
    if (
      delivery.admittedContinuation &&
      previous?.admittedContinuation &&
      axEventContinuationFingerprint(delivery.admittedContinuation) !==
        axEventContinuationFingerprint(previous.admittedContinuation)
    ) {
      throw new Error(`Continuation admission for ${delivery.id} is immutable`);
    }
    const stored = structuredClone({
      ...delivery,
      ...(previous?.admittedContinuation
        ? { admittedContinuation: previous.admittedContinuation }
        : {}),
    });
    this.deliveries.set(delivery.id, stored);
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
    this.assertWritable();
    this.assertActiveClaim(run.deliveryId, run.claimedBy, run.fencingToken);
    this.runs.set(run.id, structuredClone(run));
  }

  async getRun(runId: string): Promise<Readonly<AxEventRun> | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async declareEffect(
    request: Readonly<AxEventEffectCreateRequest>,
    fence: Readonly<AxEventEffectFence>
  ): Promise<Readonly<AxEventEffect>> {
    this.assertWritable();
    axValidateEventEffectCreateRequest(request);
    const requestDigest = await axEventEffectRequestDigest(request);
    this.assertWritable();
    this.assertFence(fence);
    if (request.deliveryId !== fence.deliveryId) {
      throw new Error(`Event effect fence does not own ${request.deliveryId}`);
    }
    const key = this.effectKey(
      request.deliveryId,
      request.operation,
      request.idempotencyKey
    );
    const existingId = this.effectKeys.get(key);
    if (existingId) {
      const existing = this.effects.get(existingId)!;
      if (existing.requestDigest !== requestDigest) {
        throw new Error(
          `Event effect intent conflicts with existing ${request.operation}:${request.idempotencyKey}`
        );
      }
      return structuredClone(existing);
    }
    const effect: AxEventEffect = {
      id: request.id,
      deliveryId: request.deliveryId,
      runId: request.runId,
      identityScope: request.identityScope,
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
      replaySafety: request.replaySafety ?? 'unknown',
      requestDigest,
      status: 'intent',
      ...(request.metadata
        ? { metadata: structuredClone(request.metadata) }
        : {}),
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
      dispatchCount: 0,
      version: 1,
    };
    this.effects.set(effect.id, effect);
    this.effectKeys.set(key, effect.id);
    return structuredClone(effect);
  }

  async transitionEffect(
    effectId: string,
    expectedVersion: number,
    transition: Readonly<AxEventEffectTransition>,
    fence: Readonly<AxEventEffectFence>
  ): Promise<Readonly<AxEventEffect>> {
    this.assertWritable();
    this.assertFence(fence);
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error(`Unknown event effect: ${effectId}`);
    if (effect.deliveryId !== fence.deliveryId) {
      throw new Error(`Event effect fence does not own ${effectId}`);
    }
    const next = axApplyEventEffectTransition(effect, transition);
    if (next.version === effect.version) return structuredClone(effect);
    if (effect.version !== expectedVersion) {
      throw new Error(`Stale event effect version for ${effectId}`);
    }
    this.effects.set(effectId, structuredClone(next));
    return structuredClone(next);
  }

  async listEffects(
    deliveryId: string
  ): Promise<readonly Readonly<AxEventEffect>[]> {
    return [...this.effects.values()]
      .filter((effect) => effect.deliveryId === deliveryId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((effect) => structuredClone(effect));
  }

  async registerContinuation(
    continuation: Readonly<AxEventContinuation>
  ): Promise<void> {
    this.assertWritable();
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

  async admitContinuation(
    deliveryId: string,
    workerId: string,
    fencingToken: number,
    identityScope: string,
    correlation: Readonly<AxEventCorrelationKey>,
    now: number
  ): Promise<Readonly<AxEventContinuation> | undefined> {
    this.assertWritable();
    this.assertActiveClaim(deliveryId, workerId, fencingToken);
    const delivery = this.deliveries.get(deliveryId)!;
    if (delivery.identityScope !== identityScope) {
      throw new Error(
        `Continuation admission identity does not own delivery ${deliveryId}`
      );
    }
    if (delivery.admittedContinuation) {
      const admitted = delivery.admittedContinuation;
      if (
        admitted.identityScope !== identityScope ||
        !admitted.correlation.some(
          (value) =>
            value.kind === correlation.kind && value.value === correlation.value
        )
      ) {
        throw new Error(
          `outcome_unknown: continuation admission for ${deliveryId} conflicts with its resume correlation`
        );
      }
      return structuredClone(admitted);
    }
    const key = axEventScopedCorrelationKey(
      identityScope,
      correlation.kind,
      correlation.value
    );
    const continuationId = this.continuationKeys.get(key);
    if (!continuationId) return;
    const continuation = this.continuations.get(continuationId);
    if (!continuation) return;
    if (continuation.expiresAt !== undefined && continuation.expiresAt <= now) {
      await this.completeContinuation(continuationId);
      return;
    }
    const owner = this.continuationAdmissions.get(continuationId);
    if (owner && owner !== deliveryId) return;
    const admitted = structuredClone(continuation);
    this.continuationAdmissions.set(continuationId, deliveryId);
    this.deliveries.set(deliveryId, {
      ...delivery,
      admittedContinuation: admitted,
    });
    return structuredClone(admitted);
  }

  async saveDeliveryAndCompleteContinuation(
    delivery: Readonly<AxEventDelivery>
  ): Promise<void> {
    this.assertWritable();
    if (
      delivery.status !== 'succeeded' &&
      delivery.status !== 'waiting_event'
    ) {
      throw new Error(
        `Event delivery ${delivery.id} must be successfully terminal before continuation completion`
      );
    }
    this.assertActiveClaim(
      delivery.id,
      delivery.claimedBy,
      delivery.fencingToken
    );
    const previous = this.deliveries.get(delivery.id)!;
    const admitted = previous.admittedContinuation;
    if (
      !admitted ||
      !delivery.admittedContinuation ||
      axEventContinuationFingerprint(admitted) !==
        axEventContinuationFingerprint(delivery.admittedContinuation)
    ) {
      throw new Error(
        `outcome_unknown: continuation admission for ${delivery.id} is missing or changed`
      );
    }
    const admissionOwner = this.continuationAdmissions.get(admitted.id);
    if (admissionOwner && admissionOwner !== delivery.id) {
      throw new Error(
        `outcome_unknown: continuation ${admitted.id} is bound to another delivery`
      );
    }
    const continuation = this.continuations.get(admitted.id);
    if (
      continuation &&
      axEventContinuationFingerprint(continuation) !==
        axEventContinuationFingerprint(admitted)
    ) {
      throw new Error(
        `outcome_unknown: continuation ${admitted.id} no longer matches its delivery admission`
      );
    }

    const stored = structuredClone({
      ...delivery,
      admittedContinuation: admitted,
    });
    const keys = admitted.correlation.map((correlation) =>
      axEventScopedCorrelationKey(
        admitted.identityScope,
        correlation.kind,
        correlation.value
      )
    );

    // All validation and cloning precede this synchronous mutation block. It
    // is indivisible with respect to every other in-memory store operation.
    this.deliveries.set(delivery.id, stored);
    for (const key of keys) {
      if (this.continuationKeys.get(key) === admitted.id) {
        this.continuationKeys.delete(key);
      }
    }
    this.continuations.delete(admitted.id);
    this.continuationAdmissions.delete(admitted.id);
    if (!this.isTerminal(previous.status)) {
      this.pendingDeliveries--;
      this.pendingBytes -= previous.sizeBytes;
      this.notify(this.capacityWaiters);
    }
  }

  async completeContinuation(id: string): Promise<void> {
    this.assertWritable();
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
    this.continuationAdmissions.delete(id);
  }

  async addDeadLetter(deadLetter: Readonly<AxEventDeadLetter>): Promise<void> {
    this.assertWritable();
    this.deadLetters.set(deadLetter.id, structuredClone(deadLetter));
  }

  async getDeadLetter(
    id: string
  ): Promise<Readonly<AxEventDeadLetter> | undefined> {
    const deadLetter = this.deadLetters.get(id);
    return deadLetter ? structuredClone(deadLetter) : undefined;
  }

  async removeDeadLetter(id: string): Promise<void> {
    this.assertWritable();
    this.deadLetters.delete(id);
  }

  async listDeadLetters(): Promise<readonly Readonly<AxEventDeadLetter>[]> {
    return [...this.deadLetters.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((value) => structuredClone(value));
  }

  async redriveDelivery(deliveryId: string, now: number): Promise<void> {
    this.assertWritable();
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new Error(`Unknown event delivery: ${deliveryId}`);
    if (!this.isTerminal(delivery.status)) {
      throw new Error(`Event delivery ${deliveryId} is not terminal`);
    }
    const fencingToken = delivery.fencingToken ?? 0;
    this.assertFencingTokenCanAdvance(delivery.id, fencingToken);
    const redriven: AxEventDelivery = {
      ...delivery,
      status: 'queued',
      attempt: 0,
      availableAt: now,
      error: undefined,
      claimedBy: undefined,
      runId: undefined,
      leaseExpiresAt: undefined,
      invocationStarted: undefined,
      fencingToken: fencingToken + 1,
    };
    this.deliveries.set(deliveryId, redriven);
    this.pendingDeliveries++;
    this.pendingBytes += redriven.sizeBytes;
    this.notify(this.workWaiters);
  }

  async nextAvailableAt(_now: number): Promise<number | undefined> {
    let next: number | undefined;
    for (const delivery of this.deliveries.values()) {
      const availableAt =
        delivery.status === 'queued'
          ? delivery.availableAt
          : (delivery.status === 'claimed' || delivery.status === 'running') &&
              delivery.leaseExpiresAt !== undefined
            ? delivery.leaseExpiresAt
            : undefined;
      if (
        availableAt !== undefined &&
        (next === undefined || availableAt < next)
      ) {
        next = availableAt;
      }
    }
    return next;
  }

  async waitForWork(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (
      [...this.deliveries.values()].some(
        (delivery) =>
          delivery.status === 'queued' ||
          ((delivery.status === 'claimed' || delivery.status === 'running') &&
            delivery.leaseExpiresAt !== undefined)
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
    if (this.closed) return;
    this.closed = true;
    const error = new Error('AxInMemoryEventStore closed');
    for (const waiter of [...this.workWaiters, ...this.capacityWaiters]) {
      waiter.reject(error);
    }
    this.workWaiters.clear();
    this.capacityWaiters.clear();
  }

  private assertWritable(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw (
        signal.reason ?? new Error('AxInMemoryEventStore operation aborted')
      );
    }
    if (this.closed) throw new Error('AxInMemoryEventStore closed');
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
      status === 'cancelled' ||
      status === 'dead_lettered' ||
      status === 'output_persistence_failed' ||
      status === 'parked' ||
      status === 'outcome_unknown' ||
      status === 'waiting_event'
    );
  }

  private notify(waiters: Set<Waiter>): void {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  }

  private assertFence(fence: Readonly<AxEventEffectFence>): void {
    this.assertSafeFencingToken(fence.deliveryId, fence.fencingToken);
    const delivery = this.deliveries.get(fence.deliveryId);
    if (
      !delivery ||
      !Number.isSafeInteger(delivery.fencingToken) ||
      delivery.fencingToken! < 0 ||
      delivery.fencingToken !== fence.fencingToken ||
      !delivery.claimedBy ||
      (delivery.status !== 'claimed' && delivery.status !== 'running') ||
      delivery.leaseExpiresAt === undefined ||
      delivery.leaseExpiresAt <= this.clock.now()
    ) {
      throw new Error(
        `Stale or expired fencing token for event delivery ${fence.deliveryId}`
      );
    }
  }

  private assertActiveClaim(
    deliveryId: string,
    claimedBy: string | undefined,
    fencingToken: number | undefined
  ): void {
    if (!claimedBy || fencingToken === undefined) {
      throw new Error(`Stale event claim for ${deliveryId}`);
    }
    this.assertSafeFencingToken(deliveryId, fencingToken);
    const delivery = this.deliveries.get(deliveryId);
    if (
      !delivery ||
      !Number.isSafeInteger(delivery.fencingToken) ||
      delivery.fencingToken! < 0 ||
      delivery.claimedBy !== claimedBy ||
      delivery.fencingToken !== fencingToken ||
      (delivery.status !== 'claimed' && delivery.status !== 'running') ||
      delivery.leaseExpiresAt === undefined ||
      delivery.leaseExpiresAt <= this.clock.now()
    ) {
      throw new Error(`Stale or expired event claim for ${deliveryId}`);
    }
  }

  private assertSafeFencingToken(
    deliveryId: string,
    fencingToken: number
  ): void {
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 0) {
      throw new Error(
        `Unsafe fencing token for event delivery ${deliveryId}; rotate the delivery identity`
      );
    }
  }

  private assertFencingTokenCanAdvance(
    deliveryId: string,
    fencingToken: number
  ): void {
    this.assertSafeFencingToken(deliveryId, fencingToken);
    if (fencingToken >= MAX_FENCING_TOKEN) {
      throw new Error(
        `Fencing token exhausted for event delivery ${deliveryId}; rotate the delivery identity`
      );
    }
  }

  private effectKey(
    deliveryId: string,
    operation: string,
    idempotencyKey: string
  ): string {
    return `${deliveryId}\n${operation}\n${idempotencyKey}`;
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
