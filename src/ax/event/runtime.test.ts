import { describe, expect, it, vi } from 'vitest';
import { AxAgentClarificationError } from '../agent/agentInternal/agentStateTypes.js';
import type { AxAuthorityContext } from '../authority/types.js';
import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import { AxInMemoryEventStore } from './memoryStore.js';
import { AxEventRuntime, eventRoute, eventTarget } from './runtime.js';
import { AxPushEventSource, AxTimerEventSource } from './sources.js';
import {
  AxEventBackpressureError,
  type AxEventIngress,
  type AxEventSink,
  AxManualEventClock,
} from './types.js';

const ai = {} as any;

function program(
  forward: (input: any, options?: any) => unknown | Promise<unknown>,
  id = 'test-program',
  signature = 'eventId?:string -> handled:boolean'
): AxProgrammable<any, any> {
  const parsed = new AxSignature(signature);
  return {
    getId: () => id,
    getSignature: () => parsed,
    forward: (_ai: unknown, input: unknown, options?: unknown) =>
      Promise.resolve(forward(input, options)),
    streamingForward: async function* () {},
  } as unknown as AxProgrammable<any, any>;
}

function ingress(
  id: string,
  type: string,
  options: Partial<AxEventIngress> = {}
): AxEventIngress {
  return {
    event: {
      specversion: '1.0',
      id,
      source: 'app://tests',
      type,
      data: { value: id },
    },
    ...options,
  };
}

describe('AxEventRuntime', () => {
  it('does not invoke a program for observe or unmatched events', async () => {
    const observed = vi.fn();
    const runtime = new AxEventRuntime({
      routes: [
        eventRoute({
          id: 'observe-audit',
          match: { types: ['audit.created'] },
          action: 'observe',
          observe: observed,
        }),
      ],
    });
    await runtime.start();
    const unmatched = await runtime.publish(ingress('1', 'other'));
    const matched = await runtime.publish(ingress('2', 'audit.created'));
    await runtime.waitForIdle();
    expect(unmatched.deliveryIds).toEqual([]);
    expect(matched.deliveryIds).toHaveLength(1);
    expect(observed).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('persists a program result before dispatching its sink', async () => {
    const store = new AxInMemoryEventStore();
    const runtimeRef: { value?: AxEventRuntime } = {};
    const sink: AxEventSink = {
      id: 'capture',
      write: async (output, context) => {
        const persisted = await runtimeRef.value!.getRun(context.run.id);
        expect(persisted?.output).toEqual(output);
      },
    };
    const target = eventTarget({
      id: 'summarize',
      ai,
      program: program(
        ({ documentId }) => ({ summary: `seen:${documentId}` }),
        'test-program',
        'documentId:string -> summary:string'
      ),
      mapInput: (value) => ({
        documentId: String((value.event.data as { value: string }).value),
      }),
      retrySafety: 'idempotent',
      sinks: [sink],
    });
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: 'wake-summary',
          match: { types: ['document.changed'] },
          action: 'wake',
          target,
        }),
      ],
    });
    runtimeRef.value = runtime;
    await runtime.start();
    const receipt = await runtime.publish(ingress('doc-1', 'document.changed'));
    await runtime.waitForIdle();
    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    const run = await runtime.getRun(delivery!.runId!);
    expect(run?.status).toBe('succeeded');
    expect(run?.sinks).toEqual([
      { sinkId: 'capture', attempts: 1, status: 'succeeded' },
    ]);
    await runtime.close();
  });

  it('scopes dedupe by verified identity and rejects anonymous auth routes', async () => {
    const runtime = new AxEventRuntime({
      routes: [
        eventRoute({
          id: 'secure-observe',
          match: { types: ['secure.changed'] },
          action: 'observe',
          requireAuthenticated: true,
        }),
      ],
    });
    await runtime.start();
    const anonymous = await runtime.publish(ingress('same', 'secure.changed'));
    const tenantA = ingress('same', 'secure.changed', {
      identity: { tenantId: 'a' },
      trust: 'authenticated',
    });
    const tenantB = ingress('same', 'secure.changed', {
      identity: { tenantId: 'b' },
      trust: 'authenticated',
    });
    const firstA = await runtime.publish(tenantA);
    const secondA = await runtime.publish(tenantA);
    const firstB = await runtime.publish(tenantB);
    await runtime.waitForIdle();
    expect(anonymous.deliveryIds).toEqual([]);
    expect(firstA.duplicate).toBe(false);
    expect(secondA.duplicate).toBe(true);
    expect(firstB.duplicate).toBe(false);
    await runtime.close();
  });

  it('uses host-resolved authority instead of event claims and binds tenant scope', async () => {
    const invoked = vi.fn(() => ({ handled: true }));
    const authority: AxAuthorityContext = {
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'worker-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'event-grant',
          principalId: 'principal-a',
          actor: { id: 'worker-a', kind: 'agent' },
          operations: ['event.target.invoke'],
          resources: [
            { type: 'event.target', id: 'secure-target', tenantId: 'tenant-a' },
          ],
          leaseEpoch: 2,
        },
      ],
      leaseEpoch: 2,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: `receipt-${context.requestId}`,
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
    };
    const target = eventTarget({
      id: 'secure-target',
      ai,
      program: program(invoked),
      mapInput: () => ({ eventId: 'event' }),
      retrySafety: 'idempotent',
    });
    const runtime = new AxEventRuntime({
      authority: () => authority,
      maxAttempts: 1,
      routes: [
        eventRoute({
          id: 'secure-route',
          match: { types: ['secure.event'] },
          action: 'wake',
          target,
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(
      ingress('allowed', 'secure.event', {
        identity: { tenantId: 'tenant-a' },
        trust: 'authenticated',
      })
    );
    await runtime.publish(
      ingress('denied', 'secure.event', {
        identity: { tenantId: 'tenant-b' },
        trust: 'authenticated',
        event: {
          ...ingress('forged', 'secure.event').event,
          id: 'denied',
          data: { grants: [{ id: 'forged', operations: ['*'] }] },
        },
      })
    );
    await runtime.waitForIdle();
    expect(invoked).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('clears a rejecting authority resolver from activeRuns so waitForIdle can finish', async () => {
    const invoked = vi.fn();
    const runtime = new AxEventRuntime({
      maxAttempts: 1,
      authority: async () => {
        throw new Error('resolver rejected');
      },
      routes: [
        eventRoute({
          id: 'rejecting-authority',
          match: { types: ['authority.reject'] },
          action: 'wake',
          target: eventTarget({
            id: 'rejecting-authority-target',
            ai,
            program: program(invoked),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('authority-reject-1', 'authority.reject')
    );
    await expect(runtime.waitForIdle(200)).resolves.toBeUndefined();
    expect(invoked).not.toHaveBeenCalled();
    expect((await runtime.listDeadLetters()).length).toBeGreaterThan(0);
    expect(receipt.deliveryIds).toHaveLength(1);
    await runtime.close({ drain: false });
  });

  it('does not wedge close({drain:false}) on a never-settling authority resolver', async () => {
    const invoked = vi.fn();
    let lateReject: ((reason?: unknown) => void) | undefined;
    const runtime = new AxEventRuntime({
      maxAttempts: 1,
      authority: () =>
        new Promise<undefined>((_resolve, reject) => {
          lateReject = reject;
        }),
      routes: [
        eventRoute({
          id: 'hanging-authority',
          match: { types: ['authority.hang'] },
          action: 'wake',
          target: eventTarget({
            id: 'hanging-authority-target',
            ai,
            program: program(invoked),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('authority-hang-1', 'authority.hang'));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    const closed = runtime.close({ drain: false });
    await expect(
      Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
    ).resolves.toBe('closed');
    expect(invoked).not.toHaveBeenCalled();
    lateReject?.(new Error('late resolver rejection'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not wedge close({drain:false}) on a never-settling onAudit hook', async () => {
    const invoked = vi.fn();
    let lateReject: ((reason?: unknown) => void) | undefined;
    const neverAuthorize = new Promise<never>(() => {});
    const authority: AxAuthorityContext = {
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'worker-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'event-grant',
          principalId: 'principal-a',
          operations: ['event.target.invoke'],
          resources: [
            {
              type: 'event.target',
              id: 'audit-hang-target',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
      ],
      leaseEpoch: 1,
      now: () => 100,
      authorize: () => neverAuthorize,
      onAudit: () =>
        new Promise<void>((_resolve, reject) => {
          lateReject = reject;
        }),
    };
    const runtime = new AxEventRuntime({
      maxAttempts: 1,
      authority: () => authority,
      routes: [
        eventRoute({
          id: 'audit-hang',
          match: { types: ['authority.audit-hang'] },
          action: 'wake',
          target: eventTarget({
            id: 'audit-hang-target',
            ai,
            program: program(invoked),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('audit-hang-1', 'authority.audit-hang'));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    const closed = runtime.close({ drain: false });
    await expect(
      Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
    ).resolves.toBe('closed');
    expect(invoked).not.toHaveBeenCalled();
    lateReject?.(new Error('late audit rejection'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('terminally cancels a delivery aborted before authority resolution returns', async () => {
    const invoked = vi.fn();
    const store = new AxInMemoryEventStore();
    let release!: () => void;
    const gate = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const runtime = new AxEventRuntime({
      maxAttempts: 1,
      store,
      authority: () => gate,
      routes: [
        eventRoute({
          id: 'pre-resolution-cancel',
          match: { types: ['authority.pre-cancel'] },
          action: 'wake',
          target: eventTarget({
            id: 'pre-cancel-target',
            ai,
            program: program(invoked),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('pre-cancel-1', 'authority.pre-cancel')
    );
    for (let index = 0; index < 30; index++) await Promise.resolve();
    await runtime.close({ drain: false });
    release();
    await Promise.resolve();
    await Promise.resolve();
    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe('cancelled');
    expect(invoked).not.toHaveBeenCalled();
    await expect(runtime.waitForIdle(50)).resolves.toBeUndefined();
  });

  it('does not write a sink after close returns during a hanging redrive resolver', async () => {
    const store = new AxInMemoryEventStore();
    const write = vi
      .fn<(output: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error('synthetic sink failure'))
      .mockResolvedValue(undefined);
    const makeAuthority = (): AxAuthorityContext => ({
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'worker-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'target-1',
          principalId: 'principal-a',
          operations: ['event.target.invoke'],
          resources: [
            {
              type: 'event.target',
              id: 'redrive-hang-target',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
        {
          version: 1,
          id: 'sink-1',
          principalId: 'principal-a',
          operations: ['event.sink.write'],
          resources: [
            {
              type: 'event.sink',
              id: 'redrive-hang-sink',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
      ],
      leaseEpoch: 1,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: `receipt-${operation}`,
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
    });
    let hanging = false;
    let lateResolve: ((value?: unknown) => void) | undefined;
    const runtime = new AxEventRuntime({
      authority: () => {
        if (!hanging) return makeAuthority();
        return new Promise((resolve) => {
          lateResolve = () => resolve(makeAuthority());
        });
      },
      maxAttempts: 1,
      store,
      routes: [
        eventRoute({
          id: 'redrive-hang-route',
          match: { types: ['redrive.hang'] },
          action: 'wake',
          target: eventTarget({
            id: 'redrive-hang-target',
            ai,
            program: program(() => ({ ok: true })),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [{ id: 'redrive-hang-sink', write }],
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('redrive-hang-1', 'redrive.hang'));
    await runtime.waitForIdle();
    const deadLetter = (await runtime.listDeadLetters()).find(
      (value) => value.kind === 'sink'
    );
    expect(deadLetter).toBeDefined();
    expect(write).toHaveBeenCalledOnce();

    hanging = true;
    const redrive = runtime.redrive(deadLetter!.id);
    for (let index = 0; index < 20; index++) await Promise.resolve();
    const closed = runtime.close({ drain: false });
    await expect(
      Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
    ).resolves.toBe('closed');
    lateResolve?.();
    await expect(redrive).rejects.toThrow(/clos(ing|ed)/);
    expect(write).toHaveBeenCalledOnce();
    expect(await runtime.listDeadLetters()).toContainEqual(deadLetter);
  });

  it('does not invoke a target when close cancels during a successful authorization audit', async () => {
    const invoked = vi.fn();
    const store = new AxInMemoryEventStore();
    let lateReject: ((reason?: unknown) => void) | undefined;
    let auditStarted!: () => void;
    const auditStart = new Promise<void>((resolve) => {
      auditStarted = resolve;
    });
    const authority: AxAuthorityContext = {
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'worker-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'event-grant',
          principalId: 'principal-a',
          operations: ['event.target.invoke'],
          resources: [
            {
              type: 'event.target',
              id: 'audit-success-cancel-target',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
      ],
      leaseEpoch: 1,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: `receipt-${operation}`,
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
      onAudit: () => {
        auditStarted();
        return new Promise<void>((_resolve, reject) => {
          lateReject = reject;
        });
      },
    };
    const runtime = new AxEventRuntime({
      maxAttempts: 1,
      store,
      authority: () => authority,
      routes: [
        eventRoute({
          id: 'audit-success-cancel',
          match: { types: ['authority.audit-success-cancel'] },
          action: 'wake',
          target: eventTarget({
            id: 'audit-success-cancel-target',
            ai,
            program: program(invoked),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('audit-success-cancel-1', 'authority.audit-success-cancel')
    );
    await auditStart;
    const closed = runtime.close({ drain: false });
    await expect(
      Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
    ).resolves.toBe('closed');
    lateReject?.(new Error('late successful-audit rejection'));
    await Promise.resolve();
    await Promise.resolve();
    expect(invoked).not.toHaveBeenCalled();
    expect((await store.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'cancelled'
    );
  });

  it('does not return from close until an already-started redrive write settles', async () => {
    const store = new AxInMemoryEventStore();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStart = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let postCloseWrites = 0;
    const write = vi.fn(async () => {
      if (write.mock.calls.length === 1) {
        throw new Error('synthetic sink failure');
      }
      writeStarted();
      await writeGate;
      postCloseWrites++;
    });
    const makeAuthority = (): AxAuthorityContext => ({
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'worker-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'target-1',
          principalId: 'principal-a',
          operations: ['event.target.invoke'],
          resources: [
            {
              type: 'event.target',
              id: 'redrive-write-target',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
        {
          version: 1,
          id: 'sink-1',
          principalId: 'principal-a',
          operations: ['event.sink.write'],
          resources: [
            {
              type: 'event.sink',
              id: 'redrive-write-sink',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
      ],
      leaseEpoch: 1,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: `receipt-${operation}`,
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
    });
    const runtime = new AxEventRuntime({
      authority: () => makeAuthority(),
      maxAttempts: 1,
      store,
      routes: [
        eventRoute({
          id: 'redrive-write-route',
          match: { types: ['redrive.write'] },
          action: 'wake',
          target: eventTarget({
            id: 'redrive-write-target',
            ai,
            program: program(() => ({ ok: true })),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [{ id: 'redrive-write-sink', write }],
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('redrive-write-1', 'redrive.write'));
    await runtime.waitForIdle();
    const deadLetter = (await runtime.listDeadLetters()).find(
      (value) => value.kind === 'sink'
    );
    expect(deadLetter).toBeDefined();
    const redrive = runtime.redrive(deadLetter!.id);
    await writeStart;
    let closeSettled = false;
    const closed = runtime.close({ drain: false }).then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeSettled).toBe(false);
    expect(postCloseWrites).toBe(0);
    releaseWrite();
    await expect(redrive).rejects.toThrow(/clos(ing|ed)/);
    await closed;
    expect(closeSettled).toBe(true);
    expect(postCloseWrites).toBe(1);
    expect(await runtime.listDeadLetters()).toContainEqual(deadLetter);
  });

  it('does not requeue a delivery dead letter after close returns', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted!: () => void;
    const lookupStart = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let postCloseMutations = 0;
    const store = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'getDeadLetter') {
          return async (id: string) => {
            lookupStarted();
            await lookupGate;
            return target.getDeadLetter(id);
          };
        }
        if (property === 'redriveDelivery' || property === 'removeDeadLetter') {
          return async (...args: unknown[]) => {
            postCloseMutations++;
            const value = Reflect.get(target, property, receiver);
            return (value as (...inner: unknown[]) => unknown).apply(
              target,
              args
            );
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new AxEventRuntime({
      maxAttempts: 1,
      store,
      routes: [
        eventRoute({
          id: 'delivery-redrive',
          match: { types: ['delivery.redrive'] },
          action: 'observe',
          observe: () => {
            throw new Error('observed failure');
          },
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('delivery-redrive-1', 'delivery.redrive'));
    await runtime.waitForIdle();
    const deadLetter = (await backing.listDeadLetters())[0];
    expect(deadLetter?.kind).toBe('delivery');
    const redrive = runtime.redrive(deadLetter!.id);
    await lookupStart;
    await runtime.close({ drain: false });
    releaseLookup();
    await expect(redrive).rejects.toThrow(/clos(ing|ed)/);
    expect(postCloseMutations).toBe(0);
    expect((await backing.getDelivery(deadLetter!.deliveryId))?.status).toBe(
      'dead_lettered'
    );
  });

  it('re-resolves current authority before sink dead-letter redrive', async () => {
    const store = new AxInMemoryEventStore();
    const write = vi
      .fn<(output: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error('synthetic sink failure'))
      .mockResolvedValue(undefined);
    const makeAuthority = (
      leaseEpoch: number,
      includeSink: boolean
    ): AxAuthorityContext => ({
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'worker-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: `target-${leaseEpoch}`,
          principalId: 'principal-a',
          operations: ['event.target.invoke'],
          resources: [
            {
              type: 'event.target',
              id: 'redrive-target',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch,
        },
        ...(includeSink
          ? [
              {
                version: 1 as const,
                id: `sink-${leaseEpoch}`,
                principalId: 'principal-a',
                operations: ['event.sink.write'],
                resources: [
                  {
                    type: 'event.sink',
                    id: 'redrive-sink',
                    tenantId: 'tenant-a',
                  },
                ],
                leaseEpoch,
              },
            ]
          : []),
      ],
      leaseEpoch,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: `receipt-${leaseEpoch}-${operation}`,
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
    });
    let currentAuthority = makeAuthority(1, true);
    const target = eventTarget({
      id: 'redrive-target',
      ai,
      program: program(() => ({ ok: true })),
      mapInput: () => ({}),
      retrySafety: 'idempotent',
      sinks: [{ id: 'redrive-sink', write }],
    });
    const runtime = new AxEventRuntime({
      authority: () => currentAuthority,
      maxAttempts: 1,
      store,
      routes: [
        eventRoute({
          id: 'redrive-route',
          match: { types: ['redrive.event'] },
          action: 'wake',
          target,
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('redrive-1', 'redrive.event'));
    await runtime.waitForIdle();
    const deadLetter = (await runtime.listDeadLetters()).find(
      (value) => value.kind === 'sink'
    );
    expect(deadLetter).toBeDefined();
    expect(write).toHaveBeenCalledOnce();

    currentAuthority = makeAuthority(2, false);
    await expect(runtime.redrive(deadLetter!.id)).rejects.toMatchObject({
      code: 'no_matching_grant',
    });
    expect(write).toHaveBeenCalledOnce();
    expect(await runtime.listDeadLetters()).toContainEqual(deadLetter);

    currentAuthority = makeAuthority(2, true);
    await runtime.redrive(deadLetter!.id);
    expect(write).toHaveBeenCalledTimes(2);
    expect(await runtime.listDeadLetters()).not.toContainEqual(deadLetter);
    await runtime.close();
  });

  it('retries only an explicitly idempotent target', async () => {
    let calls = 0;
    const target = eventTarget({
      id: 'retryable',
      ai,
      program: program(() => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return { ok: true };
      }),
      mapInput: (value) => value.event.data,
      retrySafety: 'idempotent',
    });
    const runtime = new AxEventRuntime({
      retryBaseMs: 1,
      retryMaxMs: 1,
      routes: [
        eventRoute({
          id: 'retry-route',
          match: { types: ['retry'] },
          action: 'wake',
          target,
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('retry-1', 'retry'));
    await runtime.waitForIdle();
    expect(calls).toBe(2);
    expect(await runtime.listDeadLetters()).toEqual([]);
    await runtime.close();
  });

  it('marks an uncertain target failure outcome_unknown without replaying it', async () => {
    const store = new AxInMemoryEventStore();
    const forward = vi.fn(() => {
      throw new Error('may have sent a message');
    });
    const target = eventTarget({
      id: 'unsafe',
      ai,
      program: program(forward),
      mapInput: (value) => value.event.data,
    });
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: 'unsafe-route',
          match: { types: ['unsafe'] },
          action: 'wake',
          target,
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(ingress('unsafe-1', 'unsafe'));
    await runtime.waitForIdle();
    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe('outcome_unknown');
    expect(forward).toHaveBeenCalledOnce();
    expect(await runtime.listDeadLetters()).toHaveLength(1);
    await runtime.close();
  });

  it('registers and resumes a correlated continuation', async () => {
    const forward = vi.fn(({ phase }) => ({ phase }));
    const target = eventTarget({
      id: 'continuable',
      ai,
      program: program(
        forward,
        'continuable',
        'phase:string -> phaseResult?:string'
      ),
      mapInput: (value, context) => {
        if (value.event.type === 'job.started') {
          context.eventContext.registerContinuation({
            correlation: [{ kind: 'job', value: 'job-42' }],
          });
          return { phase: 'started' };
        }
        return { phase: 'resumed' };
      },
      retrySafety: 'idempotent',
    });
    const runtime = new AxEventRuntime({
      routes: [
        eventRoute({
          id: 'start-job',
          match: { types: ['job.started'] },
          action: 'wake',
          target,
        }),
        eventRoute({
          id: 'resume-job',
          match: { types: ['job.completed'] },
          action: 'resume',
          target,
          correlation: () => ({ kind: 'job', value: 'job-42' }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('job-start', 'job.started'));
    await runtime.waitForIdle();
    await runtime.publish(ingress('job-complete', 'job.completed'));
    await runtime.waitForIdle();
    expect(forward).toHaveBeenNthCalledWith(
      1,
      { phase: 'started' },
      expect.anything()
    );
    expect(forward).toHaveBeenNthCalledWith(
      2,
      { phase: 'resumed' },
      expect.anything()
    );
    await runtime.close();
  });

  it('turns Agent clarification into a durable waiting_event continuation', async () => {
    let calls = 0;
    const target = eventTarget({
      id: 'clarifying-agent',
      ai,
      program: program(() => {
        calls++;
        if (calls === 1) {
          throw new AxAgentClarificationError('Which account?');
        }
        return { answer: 'resumed' };
      }),
      mapInput: (value) => value.event.data,
      retrySafety: 'idempotent',
    });
    const store = new AxInMemoryEventStore();
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: 'ask',
          match: { types: ['agent.ask'] },
          action: 'wake',
          target,
        }),
        eventRoute({
          id: 'answer',
          match: { types: ['agent.answer'] },
          action: 'resume',
          correlation: (value) => ({
            kind: 'ax.clarification',
            value: String((value.event.data as { runId: string }).runId),
          }),
        }),
      ],
    });
    await runtime.start();
    const started = await runtime.publish(ingress('clarify-1', 'agent.ask'));
    await runtime.waitForIdle();
    const delivery = await store.getDelivery(started.deliveryIds[0]!);
    const firstRun = await runtime.getRun(delivery!.runId!);
    expect(firstRun?.status).toBe('waiting_event');
    await runtime.publish({
      ...ingress('clarify-2', 'agent.answer'),
      event: {
        ...ingress('clarify-2', 'agent.answer').event,
        data: { runId: firstRun!.id, answer: 'personal' },
      },
    });
    await runtime.waitForIdle();
    expect(calls).toBe(2);
    await runtime.close();
  });

  it('restores state into a fresh per-instance program from createProgram', async () => {
    const observed: number[] = [];
    const target = eventTarget({
      id: 'counter',
      ai,
      createProgram: () => {
        let count = 0;
        const signature = new AxSignature(
          'eventId?:string -> counterValue:number'
        );
        return {
          getId: () => 'counter-v1',
          getSignature: () => signature,
          getState: () => ({ count }),
          setState: (state: unknown) => {
            count = (state as { count: number }).count;
          },
          forward: async () => {
            count++;
            observed.push(count);
            return { count };
          },
          streamingForward: async function* () {},
        } as AxProgrammable<any, any> & {
          getState(): unknown;
          setState(state: unknown): void;
        };
      },
      mapInput: (value) => value.event.data,
      retrySafety: 'idempotent',
    });
    const runtime = new AxEventRuntime({
      routes: [
        eventRoute({
          id: 'count',
          match: { types: ['counter.increment'] },
          action: 'wake',
          target,
          instanceKey: () => 'account-1',
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('counter-1', 'counter.increment'));
    await runtime.waitForIdle();
    await runtime.publish(ingress('counter-2', 'counter.increment'));
    await runtime.waitForIdle();
    expect(observed).toEqual([1, 2]);
    await runtime.close();
  });

  it('debounces and explicitly coalesces to the latest event with a fake clock', async () => {
    const clock = new AxManualEventClock(1_000);
    const seen: unknown[] = [];
    const runtime = new AxEventRuntime({
      clock,
      workerConcurrency: 1,
      routes: [
        eventRoute({
          id: 'debounced',
          match: { types: ['search.changed'] },
          action: 'observe',
          debounceMs: 100,
          coalesce: 'latest',
          observe: (value) => seen.push(value.event.data),
        }),
      ],
    });
    await runtime.start();
    const first = await runtime.publish(ingress('search-1', 'search.changed'));
    const second = await runtime.publish(ingress('search-2', 'search.changed'));
    expect(second.deliveryIds).toEqual(first.deliveryIds);
    clock.advanceBy(99);
    await Promise.resolve();
    expect(seen).toEqual([]);
    clock.advanceBy(1);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(seen).toEqual([{ value: 'search-2' }]);
    await runtime.close({ drain: false });
  });

  it('supervises timer source failures through onSourceError', async () => {
    const clock = new AxManualEventClock(0);
    const onSourceError = vi.fn();
    const source = new AxTimerEventSource({
      id: 'failing-timer',
      intervalMs: 50,
      type: 'timer.tick',
      clock,
      data: () => {
        throw new Error('timer failed');
      },
    });
    const runtime = new AxEventRuntime({
      clock,
      routes: [],
      sources: [source],
      onSourceError,
    });
    await runtime.start();
    clock.advanceBy(50);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(onSourceError).toHaveBeenCalledWith(
      'failing-timer',
      expect.objectContaining({ message: 'timer failed' })
    );
    await runtime.close({ drain: false });
  });

  it('refuses durable sources on the volatile store by default', async () => {
    const source = new AxPushEventSource('queue', true);
    const runtime = new AxEventRuntime({ routes: [], sources: [source] });
    await expect(runtime.start()).rejects.toThrow('require a persistent');
  });

  it('refuses multi-worker mode without a conforming persistent store', async () => {
    const runtime = new AxEventRuntime({
      coordination: 'multi-worker',
      routes: [],
    });
    await expect(runtime.start()).rejects.toThrow(
      'conforming persistent store'
    );
  });

  it('uses the injected clock for deterministic backpressure timeouts', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryEventStore({
      clock,
      maxPendingDeliveries: 1,
    });
    const descriptor = {
      routeId: 'route',
      action: 'observe' as const,
      instanceKey: 'instance',
      sizeBytes: 10,
    };
    await store.enqueue({
      ingress: ingress('capacity-1', 'capacity'),
      deliveries: [descriptor],
      acceptedAt: clock.now(),
      publishTimeoutMs: 5_000,
    });
    const blocked = store.enqueue({
      ingress: ingress('capacity-2', 'capacity'),
      deliveries: [descriptor],
      acceptedAt: clock.now(),
      publishTimeoutMs: 5_000,
    });
    await Promise.resolve();
    clock.advanceBy(5_000);
    await expect(blocked).rejects.toBeInstanceOf(AxEventBackpressureError);
  });
});
