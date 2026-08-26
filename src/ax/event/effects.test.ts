import { describe, expect, it, vi } from 'vitest';
import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import { AxInMemoryEventStore } from './memoryStore.js';
import { AxEventRuntime, eventRoute, eventTarget } from './runtime.js';
import {
  type AxEventContext,
  type AxEventDelivery,
  type AxEventEffectResolution,
  type AxEventIngress,
  type AxEventRun,
  type AxEventStore,
  AxManualEventClock,
} from './types.js';

const ai = {} as never;

function effectProgram(
  forward: (context: Readonly<AxEventContext>) => unknown | Promise<unknown>
): AxProgrammable<any, any> {
  const signature = new AxSignature('eventId?:string -> handled:boolean');
  return {
    getId: () => 'effect-program',
    getSignature: () => signature,
    forward: async (_ai: unknown, _input: unknown, options: any) =>
      forward(options.eventContext),
    streamingForward: async function* () {},
  } as unknown as AxProgrammable<any, any>;
}

function ingress(id: string): AxEventIngress {
  return {
    event: {
      specversion: '1.0',
      id,
      source: 'test://effects',
      type: 'effect.requested',
    },
    identity: { tenantId: 'tenant-a' },
    trust: 'authenticated',
  };
}

function runtimeFor(
  store: AxEventStore,
  forward: (context: Readonly<AxEventContext>) => unknown | Promise<unknown>,
  options: Partial<ConstructorParameters<typeof AxEventRuntime>[0]> = {},
  targetRetrySafety: 'idempotent' | 'effect-aware' | 'unknown' = 'effect-aware'
): AxEventRuntime {
  return new AxEventRuntime({
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxAttempts: 3,
    ...options,
    store,
    routes: [
      eventRoute({
        id: 'effect-route',
        match: { types: ['effect.requested'] },
        action: 'wake',
        target: eventTarget({
          id: 'effect-target',
          ai,
          program: effectProgram(forward),
          mapInput: () => ({}),
          retrySafety: targetRetrySafety,
        }),
      }),
    ],
  });
}

describe('AxEventRuntime effects', () => {
  it('preserves legacy stores until application code opts into effects', async () => {
    const backing = new AxInMemoryEventStore();
    const { effectLedger: _effectLedger, ...legacyCapabilities } =
      backing.capabilities;
    const legacyStore = new Proxy(backing, {
      get(target, property) {
        if (property === 'capabilities') return legacyCapabilities;
        if (
          property === 'declareEffect' ||
          property === 'transitionEffect' ||
          property === 'listEffects'
        ) {
          return;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AxEventStore;
    const runtime = runtimeFor(
      legacyStore,
      async () => ({ handled: true }),
      {},
      'idempotent'
    );
    await runtime.start();
    const receipt = await runtime.publish(ingress('legacy-store'));
    await runtime.waitForIdle();

    expect((await backing.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'succeeded'
    );
    expect(() => runtime.getEffects(receipt.deliveryIds[0]!)).toThrow(
      'does not support the effect ledger'
    );
    await runtime.close();
    const resolverRuntime = runtimeFor(
      legacyStore,
      async () => ({ handled: true }),
      {
        effectResolver: () => ({ status: 'indeterminate' }),
      }
    );
    await expect(resolverRuntime.start()).rejects.toThrow(
      'effectResolver requires an effect-aware AxEventStore'
    );
    const effectAwareRuntime = runtimeFor(
      legacyStore,
      async () => ({ handled: true }),
      {},
      'effect-aware'
    );
    await expect(effectAwareRuntime.start()).rejects.toThrow(
      'configuration for effect-aware targets effect-target requires an effect-aware AxEventStore'
    );
  });

  it('reuses a persisted not-dispatched intent after a crash', async () => {
    const store = new AxInMemoryEventStore();
    const dispatch = vi.fn();
    let calls = 0;
    const runtime = runtimeFor(store, async (context) => {
      calls++;
      let effect = await context.declareEffect({
        operation: 'messages.send',
        idempotencyKey: context.idempotencyKey,
        replaySafety: 'idempotent',
        metadata: { recipient: 'redacted' },
      });
      if (calls === 1) throw new Error('crash before dispatch');
      expect(effect.status).toBe('intent');
      effect = await context.markEffectDispatched(effect.id, effect.version);
      dispatch(context.idempotencyKey);
      await context.settleEffect(effect.id, effect.version, {
        status: 'succeeded',
        receipt: { providerId: 'message-1' },
      });
      return { handled: true };
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('before-dispatch'));
    await runtime.waitForIdle();

    expect(calls).toBe(2);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await runtime.getEffects(receipt.deliveryIds[0]!)).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        dispatchCount: 1,
        receipt: { providerId: 'message-1' },
      }),
    ]);
    await runtime.close();
  });

  it('replays an indeterminate effect only when explicitly idempotent', async () => {
    const store = new AxInMemoryEventStore();
    const keys: string[] = [];
    let calls = 0;
    const runtime = runtimeFor(store, async (context) => {
      calls++;
      let effect = await context.declareEffect({
        operation: 'inventory.reserve',
        idempotencyKey: 'reservation-42',
        replaySafety: 'idempotent',
      });
      effect = await context.markEffectDispatched(effect.id, effect.version);
      keys.push(effect.idempotencyKey);
      if (calls === 1) throw new Error('crash after dispatch');
      await context.settleEffect(effect.id, effect.version, {
        status: 'succeeded',
        receipt: { reservationId: 'reservation-42' },
      });
      return { handled: true };
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('idempotent-replay'));
    await runtime.waitForIdle();

    expect(keys).toEqual(['reservation-42', 'reservation-42']);
    expect(await runtime.getEffects(receipt.deliveryIds[0]!)).toEqual([
      expect.objectContaining({ status: 'succeeded', dispatchCount: 2 }),
    ]);
    await runtime.close();
  });

  it('does not dispatch again after an effect settled before a crash', async () => {
    const store = new AxInMemoryEventStore();
    const dispatch = vi.fn();
    let calls = 0;
    const runtime = runtimeFor(store, async (context) => {
      calls++;
      let effect = await context.declareEffect({
        operation: 'billing.capture',
        idempotencyKey: 'charge-42',
      });
      if (effect.status === 'succeeded') return { handled: true };
      effect = await context.markEffectDispatched(effect.id, effect.version);
      dispatch();
      await context.settleEffect(effect.id, effect.version, {
        status: 'succeeded',
        receipt: { chargeId: 'charge-42' },
      });
      if (calls === 1) throw new Error('crash after settlement');
      return { handled: true };
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('after-settlement'));
    await runtime.waitForIdle();

    expect(calls).toBe(2);
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await runtime.getEffects(receipt.deliveryIds[0]!))[0]?.status).toBe(
      'succeeded'
    );
    await runtime.close();
  });

  it('parks an unresolved non-idempotent effect instead of retrying it', async () => {
    const store = new AxInMemoryEventStore();
    const forward = vi.fn(async (context: Readonly<AxEventContext>) => {
      const effect = await context.declareEffect({
        operation: 'email.send',
        idempotencyKey: 'email-42',
      });
      await context.markEffectDispatched(effect.id, effect.version);
      throw new Error('connection lost after dispatch');
    });
    const runtime = runtimeFor(store, forward);
    await runtime.start();
    const receipt = await runtime.publish(ingress('non-idempotent'));
    await runtime.waitForIdle();

    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe('parked');
    expect(forward).toHaveBeenCalledOnce();
    expect((await runtime.getEffects(delivery!.id))[0]).toEqual(
      expect.objectContaining({ status: 'parked' })
    );
    expect(await runtime.listDeadLetters()).toEqual([
      expect.objectContaining({
        kind: 'delivery',
        reason: expect.stringContaining('Indeterminate non-idempotent effect'),
      }),
    ]);
    await runtime.close();
  });

  it('preserves unknown target behavior while parking its effect evidence', async () => {
    const store = new AxInMemoryEventStore();
    const forward = vi.fn(async (context: Readonly<AxEventContext>) => {
      const effect = await context.declareEffect({
        operation: 'legacy-target.effect',
        idempotencyKey: 'legacy-target-effect-42',
        replaySafety: 'idempotent',
      });
      await context.markEffectDispatched(effect.id, effect.version);
      throw new Error('target outcome is unknown');
    });
    const runtime = runtimeFor(store, forward, {}, 'unknown');
    await runtime.start();
    const receipt = await runtime.publish(ingress('unknown-target-effect'));
    await runtime.waitForIdle();

    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe('outcome_unknown');
    expect(forward).toHaveBeenCalledOnce();
    expect((await runtime.getEffects(delivery!.id))[0]).toEqual(
      expect.objectContaining({
        status: 'parked',
        parkedReason: expect.stringContaining('outcome_unknown'),
      })
    );
    await runtime.close();
  });

  it.each<{
    name: string;
    resolution: AxEventEffectResolution;
    expectedEffect: string;
    expectedDelivery: string;
    expectedCalls: number;
  }>([
    {
      name: 'provider success',
      resolution: { status: 'succeeded', receipt: { providerId: 'resolved' } },
      expectedEffect: 'succeeded',
      expectedDelivery: 'succeeded',
      expectedCalls: 2,
    },
    {
      name: 'provider failure',
      resolution: { status: 'failed', error: 'rejected' },
      expectedEffect: 'failed',
      expectedDelivery: 'succeeded',
      expectedCalls: 2,
    },
    {
      name: 'not dispatched',
      resolution: { status: 'not_dispatched' },
      expectedEffect: 'succeeded',
      expectedDelivery: 'succeeded',
      expectedCalls: 2,
    },
    {
      name: 'still indeterminate',
      resolution: { status: 'indeterminate' },
      expectedEffect: 'parked',
      expectedDelivery: 'parked',
      expectedCalls: 1,
    },
    {
      name: 'manual review',
      resolution: { status: 'parked', reason: 'operator review required' },
      expectedEffect: 'parked',
      expectedDelivery: 'parked',
      expectedCalls: 1,
    },
  ])('applies the resolver outcome: $name', async (test) => {
    const store = new AxInMemoryEventStore();
    let calls = 0;
    const resolver = vi.fn(() => test.resolution);
    const runtime = runtimeFor(
      store,
      async (context) => {
        calls++;
        let effect = await context.declareEffect({
          operation: 'domain.resolve',
          idempotencyKey: 'resolve-42',
        });
        if (calls === 1) {
          await context.markEffectDispatched(effect.id, effect.version);
          throw new Error('crash after dispatch');
        }
        if (effect.status === 'intent') {
          effect = await context.markEffectDispatched(
            effect.id,
            effect.version
          );
          await context.settleEffect(effect.id, effect.version, {
            status: 'succeeded',
          });
        }
        return { handled: true };
      },
      { effectResolver: resolver }
    );
    await runtime.start();
    const receipt = await runtime.publish(ingress(`resolver-${test.name}`));
    await runtime.waitForIdle();

    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe(test.expectedDelivery);
    expect((await runtime.getEffects(delivery!.id))[0]?.status).toBe(
      test.expectedEffect
    );
    expect(calls).toBe(test.expectedCalls);
    expect(resolver).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('rejects stale effect revisions and accepts identical settlement replay', async () => {
    const store = new AxInMemoryEventStore();
    const runtime = runtimeFor(store, async (context) => {
      const intent = await context.declareEffect({
        operation: 'messages.compare-and-set',
        idempotencyKey: 'message-cas-42',
        replaySafety: 'idempotent',
      });
      const dispatched = await context.markEffectDispatched(
        intent.id,
        intent.version
      );
      await expect(
        context.markEffectDispatched(intent.id, intent.version)
      ).rejects.toThrow('Stale event effect version');
      const settlement = {
        status: 'succeeded' as const,
        receipt: { providerId: 'message-cas-42' },
      };
      const settled = await context.settleEffect(
        intent.id,
        dispatched.version,
        settlement
      );
      await expect(
        context.settleEffect(intent.id, dispatched.version, settlement)
      ).resolves.toEqual(settled);
      await expect(
        context.settleEffect(intent.id, settled.version, {
          status: 'failed',
          error: 'conflicting result',
        })
      ).rejects.toThrow('already settled');
      return { handled: true };
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('effect-version-cas'));
    await runtime.waitForIdle();
    expect((await store.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'succeeded'
    );
    await runtime.close();
  });

  it('rejects conflicting intent and oversized persisted effect data', async () => {
    const store = new AxInMemoryEventStore();
    const runtime = runtimeFor(store, async (context) => {
      const effect = await context.declareEffect({
        operation: 'bounded.effect',
        idempotencyKey: 'bounded-effect-42',
        metadata: { amount: 42, classification: 'redacted' },
      });
      const canonicalDuplicate = await context.declareEffect({
        operation: effect.operation,
        idempotencyKey: effect.idempotencyKey,
        metadata: { classification: 'redacted', amount: 42 },
      });
      expect(canonicalDuplicate.id).toBe(effect.id);
      expect(canonicalDuplicate.requestDigest).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        context.declareEffect({
          operation: effect.operation,
          idempotencyKey: effect.idempotencyKey,
          metadata: { amount: 43, classification: 'redacted' },
        })
      ).rejects.toThrow('intent conflicts');
      await expect(
        context.declareEffect({
          operation: 'bounded.metadata',
          idempotencyKey: 'bounded-metadata-42',
          metadata: { value: 'x'.repeat(17 * 1024) },
        })
      ).rejects.toThrow('maximum is 16384');
      await expect(
        context.settleEffect(effect.id, effect.version, {
          status: 'succeeded',
          receipt: { value: 'x'.repeat(65 * 1024) },
        })
      ).rejects.toThrow('maximum is 65536');
      await context.settleEffect(effect.id, effect.version, {
        status: 'succeeded',
      });
      return { handled: true };
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('effect-bounds'));
    await runtime.waitForIdle();
    expect((await store.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'succeeded'
    );
    await runtime.close();
  });

  it('times out a hung resolver and parks the indeterminate effect', async () => {
    const store = new AxInMemoryEventStore();
    let resolverSignal: AbortSignal | undefined;
    const runtime = runtimeFor(
      store,
      async (context) => {
        const effect = await context.declareEffect({
          operation: 'resolver.timeout',
          idempotencyKey: 'resolver-timeout-42',
        });
        await context.markEffectDispatched(effect.id, effect.version);
        throw new Error('crash after dispatch');
      },
      {
        effectResolverTimeoutMs: 20,
        effectResolver: (_effect, context) => {
          resolverSignal = context.abortSignal;
          return new Promise<AxEventEffectResolution>(() => {});
        },
      }
    );
    await runtime.start();
    const receipt = await runtime.publish(ingress('resolver-timeout'));
    await runtime.waitForIdle();

    expect((await store.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'parked'
    );
    expect((await runtime.getEffects(receipt.deliveryIds[0]!))[0]).toEqual(
      expect.objectContaining({
        status: 'parked',
        parkedReason: expect.stringContaining(
          'Effect resolver timed out after 20ms'
        ),
      })
    );
    expect(resolverSignal?.aborted).toBe(true);
    await runtime.close();
  });

  it('closes without waiting for a resolver that ignores abort', async () => {
    const store = new AxInMemoryEventStore();
    let resolverSignal: AbortSignal | undefined;
    let resolverStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    const runtime = runtimeFor(
      store,
      async (context) => {
        const effect = await context.declareEffect({
          operation: 'resolver.close',
          idempotencyKey: 'resolver-close-42',
        });
        await context.markEffectDispatched(effect.id, effect.version);
        throw new Error('crash after dispatch');
      },
      {
        effectResolverTimeoutMs: 60_000,
        effectResolver: (_effect, context) => {
          resolverSignal = context.abortSignal;
          resolverStarted();
          return new Promise<AxEventEffectResolution>(() => {});
        },
      }
    );
    await runtime.start();
    const receipt = await runtime.publish(ingress('resolver-close'));
    await started;
    const closeStartedAt = Date.now();
    await runtime.close({ drain: false });

    expect(Date.now() - closeStartedAt).toBeLessThan(1_000);
    expect(resolverSignal?.aborted).toBe(true);
    expect((await store.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'parked'
    );
    expect((await store.listEffects(receipt.deliveryIds[0]!))[0]?.status).toBe(
      'parked'
    );
  });

  it('deduplicates repeated intent declarations and event redelivery', async () => {
    const store = new AxInMemoryEventStore();
    const ids: string[] = [];
    const runtime = runtimeFor(store, async (context) => {
      const first = await context.declareEffect({
        operation: 'audit.append',
        idempotencyKey: 'audit-42',
        metadata: { classification: 'redacted' },
      });
      const duplicate = await context.declareEffect({
        operation: 'audit.append',
        idempotencyKey: 'audit-42',
        metadata: { classification: 'redacted' },
      });
      ids.push(first.id, duplicate.id);
      await context.settleEffect(first.id, first.version, {
        status: 'succeeded',
      });
      return { handled: true };
    });
    await runtime.start();
    const event = ingress('duplicate-intent');
    const first = await runtime.publish(event);
    const duplicate = await runtime.publish(event);
    await runtime.waitForIdle();

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.deliveryIds).toEqual(first.deliveryIds);
    expect(ids[0]).toBe(ids[1]);
    expect(await runtime.getEffects(first.deliveryIds[0]!)).toHaveLength(1);
    await runtime.close();
  });

  it('parks an indeterminate non-idempotent effect when its run is cancelled', async () => {
    const store = new AxInMemoryEventStore();
    let runId = '';
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const runtime = runtimeFor(store, async (context) => {
      runId = context.runId;
      const effect = await context.declareEffect({
        operation: 'exports.submit',
        idempotencyKey: 'export-42',
      });
      await context.markEffectDispatched(effect.id, effect.version);
      startedResolve();
      await new Promise<void>((_resolve, reject) => {
        context.abortSignal.addEventListener(
          'abort',
          () => reject(context.abortSignal.reason),
          { once: true }
        );
      });
      return { handled: true };
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('cancel-effect'));
    await started;
    expect(runtime.cancelRun(runId, 'operator cancelled')).toBe(true);
    await runtime.waitForIdle();

    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe('parked');
    expect((await runtime.getEffects(delivery!.id))[0]).toEqual(
      expect.objectContaining({
        status: 'parked',
        parkedReason: expect.stringContaining('operator cancelled'),
      })
    );
    expect(await runtime.listDeadLetters()).toEqual([
      expect.objectContaining({
        kind: 'delivery',
        reason: expect.stringContaining('operator cancelled'),
      }),
    ]);
    await runtime.close();
  });

  it('fails closed on unsafe, stale, expired, and exhausted in-memory fences', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryEventStore({ clock });
    const receipt = await store.enqueue({
      ingress: ingress('memory-fence-parity'),
      deliveries: [
        {
          routeId: 'effect-route',
          action: 'wake',
          targetId: 'effect-target',
          instanceKey: 'memory-fence-parity',
          sizeBytes: 1,
          retrySafety: 'effect-aware',
          ordering: 'strict',
        },
      ],
      acceptedAt: clock.now(),
      publishTimeoutMs: 100,
    });
    const deliveryId = receipt.deliveryIds[0]!;
    const claimed = (await store.claim('worker-a', clock.now(), 100))!;
    const runs = (token: number): AxEventRun => ({
      id: `run-${token}`,
      deliveryId,
      routeId: claimed.routeId,
      targetId: claimed.targetId,
      instanceKey: claimed.instanceKey,
      claimedBy: 'worker-a',
      status: 'running',
      attempt: 1,
      startedAt: clock.now(),
      fencingToken: token,
    });
    const deliveries = (
      store as unknown as { deliveries: Map<string, AxEventDelivery> }
    ).deliveries;

    const negative = { ...claimed, fencingToken: -1 };
    deliveries.set(deliveryId, negative);
    await expect(store.saveDelivery(negative)).rejects.toThrow(
      'Unsafe fencing token'
    );
    await expect(store.saveRun(runs(-9))).rejects.toThrow(
      'Unsafe fencing token'
    );
    await expect(
      store.saveRun(runs(Number.MAX_SAFE_INTEGER + 1))
    ).rejects.toThrow('Unsafe fencing token');
    await expect(
      store.renewClaim(deliveryId, 'worker-a', -1, clock.now() + 100)
    ).rejects.toThrow('Unsafe fencing token');
    await expect(
      store.declareEffect(
        {
          id: 'effect-negative-fence',
          deliveryId,
          runId: 'run-negative',
          identityScope: claimed.identityScope,
          operation: 'unsafe.write',
          idempotencyKey: 'unsafe-key',
          createdAt: clock.now(),
        },
        { deliveryId, fencingToken: -1 }
      )
    ).rejects.toThrow('Unsafe fencing token');

    deliveries.set(deliveryId, claimed);
    clock.advanceBy(101);
    await expect(store.saveDelivery(claimed)).rejects.toThrow(
      'Stale or expired event claim'
    );
    await expect(store.saveRun(runs(claimed.fencingToken!))).rejects.toThrow(
      'Stale or expired event claim'
    );

    deliveries.set(deliveryId, {
      ...claimed,
      status: 'queued',
      fencingToken: -9,
      availableAt: clock.now(),
      claimedBy: undefined,
      leaseExpiresAt: undefined,
    });
    await expect(store.claim('worker-b', clock.now(), 100)).rejects.toThrow(
      'Unsafe fencing token'
    );
    deliveries.set(deliveryId, {
      ...claimed,
      status: 'succeeded',
      fencingToken: Number.MAX_SAFE_INTEGER,
    });
    await expect(store.saveRun(runs(Number.MAX_SAFE_INTEGER))).rejects.toThrow(
      'Stale or expired event claim'
    );
    await expect(
      store.redriveDelivery(deliveryId, clock.now())
    ).rejects.toThrow('Fencing token exhausted');
    deliveries.set(deliveryId, {
      ...claimed,
      status: 'queued',
      fencingToken: Number.MAX_SAFE_INTEGER,
      availableAt: clock.now(),
      claimedBy: undefined,
      leaseExpiresAt: undefined,
    });
    await expect(store.claim('worker-b', clock.now(), 100)).rejects.toThrow(
      'Fencing token exhausted'
    );
  });

  it('reclaims an expired in-memory lease with a fresh fencing token', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryEventStore({ clock });
    const receipt = await store.enqueue({
      ingress: ingress('memory-expired-claim'),
      deliveries: [
        {
          routeId: 'effect-route',
          action: 'wake',
          targetId: 'effect-target',
          instanceKey: 'memory-expired-claim',
          sizeBytes: 1,
          retrySafety: 'effect-aware',
          ordering: 'strict',
        },
      ],
      acceptedAt: clock.now(),
      publishTimeoutMs: 100,
    });
    const first = (await store.claim('worker-a', clock.now(), 100))!;
    await store.saveDelivery({
      ...first,
      status: 'running',
      invocationStarted: true,
    });
    clock.advanceBy(101);

    const takeover = await store.claim('worker-b', clock.now(), 100);
    expect(takeover).toEqual(
      expect.objectContaining({
        id: receipt.deliveryIds[0],
        claimedBy: 'worker-b',
        fencingToken: 2,
        recoveredFromExpiredLease: true,
      })
    );
    await expect(
      store.saveDelivery({ ...first, status: 'succeeded' })
    ).rejects.toThrow('Stale or expired event claim');
  });
});
