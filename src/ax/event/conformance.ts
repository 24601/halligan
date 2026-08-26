import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventContinuation,
  type AxEventEffectStore,
  type AxEventEnqueueRequest,
  type AxEventRun,
  type AxEventStore,
  type AxProgramStateStore,
} from './types.js';

export interface AxEventStoreConformanceInstance {
  store: AxEventStore;
  stateStore: AxProgramStateStore;
}

export interface AxEventStoreConformanceFactoryOptions {
  databaseKey: string;
  maxPendingDeliveries?: number;
}

export type AxEventStoreConformanceFactory = (
  options: Readonly<AxEventStoreConformanceFactoryOptions>
) => AxEventStoreConformanceInstance | Promise<AxEventStoreConformanceInstance>;

export interface AxEventStoreConformanceReport {
  assertions: number;
  capability: Readonly<AxEventStore['capabilities']>;
}

/** Runs the normative persistent/multi-worker Ax event-store contract. */
export async function runAxEventStoreConformance(
  createStore: AxEventStoreConformanceFactory,
  options: Readonly<{ clock: AxEventClock & { advanceBy(ms: number): void } }>
): Promise<AxEventStoreConformanceReport> {
  let assertions = 0;
  const assert = (condition: unknown, message: string): void => {
    assertions++;
    if (!condition) throw new Error(`AxEventStore conformance: ${message}`);
  };
  const key = `conformance-${Math.random().toString(36).slice(2)}`;
  const primary = await createStore({ databaseKey: key });
  const peer = await createStore({ databaseKey: key });
  const { store, stateStore } = primary;
  try {
    assert(store.capabilities.durability === 'persistent', 'durability');
    assert(store.capabilities.coordination === 'multi-worker', 'coordination');
    assert(store.capabilities.leases, 'leases');
    assert(store.capabilities.transactions, 'transactions');
    assert(store.capabilities.compareAndSet, 'compare-and-set');
    assert(store.capabilities.outputPersistence, 'output persistence');

    const first = enqueueRequest('same-event', 'tenant-a', options.clock.now());
    const accepted = await store.enqueue(first);
    const duplicate = await peer.store.enqueue(first);
    const otherTenant = await store.enqueue(
      enqueueRequest('same-event', 'tenant-b', options.clock.now())
    );
    assert(!accepted.duplicate, 'first enqueue is accepted');
    assert(duplicate.duplicate, 'identity-scoped duplicate is rejected');
    assert(!otherTenant.duplicate, 'different tenant does not collide');
    await expectReject(
      peer.store.enqueue({
        ...first,
        ingress: {
          ...first.ingress,
          event: { ...first.ingress.event, data: { eventId: 'changed' } },
        },
      }),
      'conflicting duplicate ingress'
    );
    assertions++;

    const claimed = await store.claim('worker-a', options.clock.now(), 100);
    assert(claimed?.claimedBy === 'worker-a', 'atomic claim');
    const contended = await peer.store.claim(
      'worker-b',
      options.clock.now(),
      100
    );
    assert(contended?.id !== claimed?.id, 'two workers do not share a claim');

    const staleCandidate = claimed!;
    options.clock.advanceBy(101);
    await expectReject(
      store.saveDelivery({ ...staleCandidate, status: 'succeeded' }),
      'expired claim without takeover'
    );
    assertions++;
    const takeover = await peer.store.claim(
      'worker-b',
      options.clock.now(),
      100
    );
    assert(takeover?.id === staleCandidate.id, 'expired lease is recovered');
    assert(
      (takeover?.fencingToken ?? 0) > (staleCandidate.fencingToken ?? 0),
      'takeover increments fencing token'
    );
    await expectReject(
      peer.store.saveDelivery({
        ...takeover!,
        claimedBy: 'worker-c',
        status: 'running',
      }),
      'wrong current owner'
    );
    assertions++;
    await expectReject(
      store.saveDelivery({ ...staleCandidate, status: 'succeeded' }),
      'stale fencing token'
    );
    assertions++;

    const state1 = await stateStore.compareAndSet('state', undefined, {
      schemaVersion: 1,
      programVersion: 'v1',
      state: { count: 1 },
      updatedAt: options.clock.now(),
    });
    assert(state1.revision === 1, 'state initial compare-and-set');
    await expectReject(
      stateStore.compareAndSet('state', undefined, {
        schemaVersion: 1,
        programVersion: 'v1',
        state: { count: 2 },
        updatedAt: options.clock.now(),
      }),
      'state compare-and-set conflict'
    );
    assertions++;
    await expectReject(
      stateStore.compareAndSet(
        'fenced-state',
        undefined,
        {
          schemaVersion: 1,
          programVersion: 'v1',
          state: { stale: true },
          updatedAt: options.clock.now(),
        },
        {
          deliveryId: staleCandidate.id,
          fencingToken: staleCandidate.fencingToken!,
        }
      ),
      'stale fenced state writer'
    );
    assertions++;

    if (store.capabilities.effectLedger) {
      assert(peer.store.capabilities.effectLedger, 'peer effect ledger');
      const effectStore = store as AxEventEffectStore;
      const peerEffectStore = peer.store as AxEventEffectStore;
      const effectRequest = {
        id: `${key}-effect`,
        deliveryId: takeover!.id,
        runId: `${key}-run`,
        identityScope: takeover!.identityScope,
        operation: 'conformance.effect',
        idempotencyKey: takeover!.id,
        replaySafety: 'idempotent' as const,
        metadata: { request: 'same', redacted: true },
        createdAt: options.clock.now(),
      };
      const effectFence = {
        deliveryId: takeover!.id,
        fencingToken: takeover!.fencingToken!,
      };
      const intent = await peerEffectStore.declareEffect(
        effectRequest,
        effectFence
      );
      const duplicateIntent = await effectStore.declareEffect(
        {
          ...effectRequest,
          id: `${key}-duplicate-effect`,
          metadata: { redacted: true, request: 'same' },
        },
        effectFence
      );
      assert(intent.status === 'intent', 'effect intent persists');
      assert(duplicateIntent.id === intent.id, 'effect intent is idempotent');
      assert(
        intent.requestDigest === duplicateIntent.requestDigest,
        'effect request canonicalization is stable'
      );
      await expectReject(
        effectStore.declareEffect(
          {
            ...effectRequest,
            id: `${key}-conflicting-effect`,
            metadata: { request: 'changed', redacted: true },
          },
          effectFence
        ),
        'changed request with reused effect identity'
      );
      assertions++;
      const dispatched = await peerEffectStore.transitionEffect(
        intent.id,
        intent.version,
        { type: 'dispatched', at: options.clock.now() },
        effectFence
      );
      assert(dispatched.status === 'dispatched', 'effect dispatch persists');
      await expectReject(
        peerEffectStore.transitionEffect(
          intent.id,
          intent.version,
          { type: 'dispatched', at: options.clock.now() },
          effectFence
        ),
        'stale effect revision'
      );
      assertions++;
      await expectReject(
        effectStore.transitionEffect(
          intent.id,
          dispatched.version,
          {
            type: 'settled',
            at: options.clock.now(),
            settlement: { status: 'succeeded' },
          },
          {
            deliveryId: staleCandidate.id,
            fencingToken: staleCandidate.fencingToken!,
          }
        ),
        'stale effect writer'
      );
      assertions++;
      const settled = await peerEffectStore.transitionEffect(
        intent.id,
        dispatched.version,
        {
          type: 'settled',
          at: options.clock.now(),
          settlement: {
            status: 'succeeded',
            receipt: { providerId: 'receipt' },
          },
        },
        effectFence
      );
      assert(settled.status === 'succeeded', 'effect settlement persists');
      assert(
        (await effectStore.listEffects(takeover!.id))[0]?.status ===
          'succeeded',
        'effect ledger is shared across workers'
      );
      await expectReject(
        effectStore.transitionEffect(
          intent.id,
          settled.version,
          { type: 'dispatched', at: options.clock.now() },
          effectFence
        ),
        'illegal effect transition'
      );
      assertions++;
    }

    const continuation: AxEventContinuation = {
      id: `${key}-continuation`,
      targetId: 'target',
      routeId: 'route',
      instanceKey: 'instance',
      identityScope: takeover!.identityScope,
      correlation: [{ kind: 'task', value: '42' }],
      createdAt: options.clock.now(),
    };
    await store.registerContinuation(continuation);
    await expectReject(
      peer.store.registerContinuation({
        ...continuation,
        id: `${key}-continuation-duplicate`,
      }),
      'continuation uniqueness'
    );
    assertions++;
    assert(
      typeof peer.store.admitContinuation === 'function',
      'exclusive continuation admission capability'
    );
    await expectReject(
      store.admitContinuation!(
        staleCandidate.id,
        staleCandidate.claimedBy!,
        staleCandidate.fencingToken!,
        continuation.identityScope,
        continuation.correlation[0]!,
        options.clock.now()
      ),
      'stale continuation admission fence'
    );
    assertions++;
    const admitted = await peer.store.admitContinuation!(
      takeover!.id,
      takeover!.claimedBy!,
      takeover!.fencingToken!,
      continuation.identityScope,
      continuation.correlation[0]!,
      options.clock.now()
    );
    assert(admitted?.id === continuation.id, 'continuation admission');
    const repeatedAdmission = await store.admitContinuation!(
      takeover!.id,
      takeover!.claimedBy!,
      takeover!.fencingToken!,
      continuation.identityScope,
      continuation.correlation[0]!,
      options.clock.now()
    );
    assert(
      repeatedAdmission?.id === continuation.id,
      'continuation admission is idempotent for its delivery'
    );
    await peer.store.completeContinuation(continuation.id);
    assert(
      !(await store.findContinuation(
        continuation.identityScope,
        continuation.correlation[0]!,
        options.clock.now()
      )),
      'continuation atomic consumption'
    );

    const run: AxEventRun = {
      id: `${key}-run`,
      deliveryId: takeover!.id,
      routeId: takeover!.routeId,
      instanceKey: takeover!.instanceKey,
      claimedBy: takeover!.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: options.clock.now(),
      finishedAt: options.clock.now(),
      output: { persisted: true },
      fencingToken: takeover!.fencingToken,
    };
    await peer.store.saveRun(run);
    assert(
      (await store.getRun(run.id))?.output !== undefined,
      'output persists before sinks'
    );
    await expectReject(
      store.saveRun({
        ...run,
        id: `${key}-stale-run`,
        claimedBy: staleCandidate.claimedBy,
        fencingToken: staleCandidate.fencingToken,
      }),
      'stale output writer'
    );
    assertions++;
  } finally {
    await Promise.allSettled([store.close?.(), peer.store.close?.()]);
  }

  const bounded = await createStore({
    databaseKey: `${key}-backpressure`,
    maxPendingDeliveries: 1,
  });
  try {
    await bounded.store.enqueue(
      enqueueRequest('capacity-1', 'tenant-a', options.clock.now())
    );
    const blocked = bounded.store.enqueue({
      ...enqueueRequest('capacity-2', 'tenant-a', options.clock.now()),
      publishTimeoutMs: 5,
    });
    options.clock.advanceBy(5);
    try {
      await blocked;
      assert(false, 'backpressure must reject');
    } catch (error) {
      assert(error instanceof AxEventBackpressureError, 'backpressure error');
    }
  } finally {
    await bounded.store.close?.();
  }

  return { assertions, capability: store.capabilities };
}

function enqueueRequest(
  eventId: string,
  tenantId: string,
  now: number
): AxEventEnqueueRequest {
  return {
    ingress: {
      event: {
        specversion: '1.0',
        id: eventId,
        source: 'conformance://store',
        type: 'conformance.event',
        data: { eventId },
      },
      identity: { tenantId },
      trust: 'authenticated',
    },
    deliveries: [
      {
        routeId: 'route',
        action: 'wake',
        targetId: 'target',
        instanceKey: `${tenantId}:instance`,
        sizeBytes: 128,
        retrySafety: 'idempotent',
        ordering: 'strict',
      },
    ],
    acceptedAt: now,
    publishTimeoutMs: 5_000,
  };
}

async function expectReject(
  promise: Promise<unknown>,
  label: string
): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`AxEventStore conformance: expected rejection for ${label}`);
}
