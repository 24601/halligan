import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventContinuation,
  type AxEventContinuationEnqueueRequest,
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
  type AxEventVerifierTransitionRecord,
  type AxEventVerifierTransitionRequest,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
  AxSystemEventClock,
} from './types.js';
import {
  axApplyEventEffectTransition,
  axEventCanonicalDigest,
  axEventCanonicalJson,
  axEventContinuationFingerprint,
  axEventEffectRequestDigest,
  axEventId,
  axEventIdentityScope,
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
    verifierTransitions: 'axevent-verifier-transition-v2',
    effectLedger: true,
  } as const;

  readonly clock: AxEventClock;
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
  private readonly verifierTransitions = new Map<
    string,
    AxEventVerifierTransitionRecord
  >();
  private readonly continuationAdmissions = new Map<string, string>();
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
    request: Readonly<AxEventVerifierTransitionRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    this.assertVerifierTransitionNotCancelled(signal);
    const requestCommitment = await axEventCanonicalDigest(request);
    const childProjection = this.verifierChildProjection(request);
    const expectedChildCommitment =
      await axEventCanonicalDigest(childProjection);
    this.assertVerifierTransitionNotCancelled(signal);
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
      !request.parent.delivery.claimedBy ||
      parent.claimedBy !== request.parent.delivery.claimedBy ||
      parent.fencingToken !== request.parent.expectedFencingToken ||
      request.parent.delivery.fencingToken !==
        request.parent.expectedFencingToken ||
      (parent.status !== 'claimed' && parent.status !== 'running') ||
      parent.leaseExpiresAt === undefined ||
      parent.leaseExpiresAt <= this.clock.now()
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
    this.assertNoNonterminalEffects(parent.id);
    const admitted = parent.admittedContinuation;
    if (
      (admitted === undefined) !==
        (request.parent.delivery.admittedContinuation === undefined) ||
      (admitted &&
        request.parent.delivery.admittedContinuation &&
        axEventContinuationFingerprint(admitted) !==
          axEventContinuationFingerprint(
            request.parent.delivery.admittedContinuation
          ))
    ) {
      throw new Error(`Continuation admission for ${parent.id} is immutable`);
    }
    if (request.consumeContinuationId !== admitted?.id) {
      throw new Error(
        `Verifier transition continuation consumption does not match admission for ${parent.id}`
      );
    }
    if (admitted) {
      const admissionOwner = this.continuationAdmissions.get(admitted.id);
      const continuation = this.continuations.get(admitted.id);
      if (
        admissionOwner !== parent.id ||
        !continuation ||
        axEventContinuationFingerprint(continuation) !==
          axEventContinuationFingerprint(admitted)
      ) {
        throw new Error(
          `outcome_unknown: continuation admission for ${parent.id} is missing or changed`
        );
      }
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

    this.assertVerifierTransitionNotCancelled(signal);
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
      ingressFingerprint: axEventIngressFingerprint(request.child.ingress),
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
    this.assertWritable();
    for (const id of this.deliveryOrder) {
      const delivery = this.deliveries.get(id);
      if (!delivery) continue;
      const recovered =
        ((delivery.status === 'claimed' || delivery.status === 'running') &&
          delivery.leaseExpiresAt !== undefined &&
          delivery.leaseExpiresAt <= now) ||
        (delivery.status === 'queued' &&
          delivery.runId !== undefined &&
          delivery.invocationStarted === true);
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
    if (
      delivery.status === 'succeeded' ||
      delivery.status === 'waiting_event'
    ) {
      this.assertNoNonterminalEffects(delivery.id);
    }
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
    this.assertNoNonterminalEffects(delivery.id);
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

  async redriveDelivery(
    deliveryId: string,
    now: number,
    options?: Readonly<{ preserveRun?: boolean }>
  ): Promise<void> {
    this.assertWritable();
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new Error(`Unknown event delivery: ${deliveryId}`);
    if (!this.isTerminal(delivery.status)) {
      throw new Error(`Event delivery ${deliveryId} is not terminal`);
    }
    const fencingToken = delivery.fencingToken ?? 0;
    this.assertFencingTokenCanAdvance(delivery.id, fencingToken);
    if (options?.preserveRun && !delivery.runId) {
      throw new Error(`Event delivery ${deliveryId} has no run to preserve`);
    }
    const redriven: AxEventDelivery = {
      ...delivery,
      status: 'queued',
      attempt: 0,
      availableAt: now,
      error: undefined,
      claimedBy: undefined,
      runId: options?.preserveRun ? delivery.runId : undefined,
      leaseExpiresAt: undefined,
      invocationStarted: options?.preserveRun ? true : undefined,
      ...(options?.preserveRun ? { recoveredFromExpiredLease: true } : {}),
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
    let waiter: Waiter | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject };
        this.workWaiters.add(waiter);
        if (signal) {
          onAbort = () => {
            if (waiter) this.workWaiters.delete(waiter);
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    } finally {
      // Resolving the waiter via notify() never fires the abort listener, so
      // remove it here to avoid leaking a listener on a long-lived signal that
      // a worker loop reuses across many waitForWork() calls.
      if (waiter) this.workWaiters.delete(waiter);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
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

  private assertWritable(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw (
        signal.reason ?? new Error('AxInMemoryEventStore operation aborted')
      );
    }
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
      status === 'parked' ||
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

  private assertVerifierTransitionNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Verifier transition cancelled');
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

  private assertNoNonterminalEffects(deliveryId: string): void {
    const pending = [...this.effects.values()].some(
      (effect) =>
        effect.deliveryId === deliveryId &&
        (effect.status === 'intent' ||
          effect.status === 'dispatched' ||
          effect.status === 'parked')
    );
    if (pending) {
      throw new Error(`Event delivery ${deliveryId} has a nonterminal effect`);
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
    return JSON.stringify([deliveryId, operation, idempotencyKey]);
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
