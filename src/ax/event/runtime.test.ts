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
  type AxEventContinuation,
  type AxEventIngress,
  type AxEventRun,
  type AxEventSink,
  AxManualEventClock,
} from './types.js';

const ai = {} as any;

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it('classifies output persistence failures across package realms by discriminant', async () => {
    const backing = new AxInMemoryEventStore();
    let completedWrites = 0;
    let sinkCalls = 0;
    const store = new Proxy(backing, {
      get(target, property) {
        if (property === 'saveRun') {
          return async (run: Parameters<typeof backing.saveRun>[0]) => {
            if (run.status === 'finalizing' && run.output !== undefined) {
              completedWrites++;
              throw {
                name: 'AxEventOutputPersistenceError',
                code: 'output_persistence_failed',
                phase: 'stage',
                message: 'foreign package instance rejected payload',
              };
            }
            return backing.saveRun(run);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: 'foreign-output-error-route',
          match: { types: ['foreign.output.error'] },
          action: 'wake',
          target: eventTarget({
            id: 'foreign-output-error-target',
            ai,
            program: program(() => ({ handled: true })),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [
              {
                id: 'must-not-run',
                write: () => {
                  sinkCalls++;
                },
              },
            ],
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('foreign-output-error', 'foreign.output.error')
    );
    await runtime.waitForIdle();

    expect(completedWrites).toBe(1);
    expect(sinkCalls).toBe(0);
    expect((await backing.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'output_persistence_failed'
    );
    await runtime.close({ drain: false });
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
    await expect(
      runtime.publish({
        ...tenantA,
        event: {
          ...tenantA.event,
          data: { value: 'changed' },
        },
      })
    ).rejects.toThrow('identity conflicts with previously accepted ingress');
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

  it('rejects a concurrent redrive of the same dead letter so close can abort the first', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted!: () => void;
    const lookupStart = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const store = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'getDeadLetter') {
          return async (id: string) => {
            lookupStarted();
            await lookupGate;
            return target.getDeadLetter(id);
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
          id: 'duplicate-redrive',
          match: { types: ['duplicate.redrive'] },
          action: 'observe',
          observe: () => {
            throw new Error('observed failure');
          },
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('duplicate-redrive-1', 'duplicate.redrive'));
    await runtime.waitForIdle();
    const deadLetter = (await backing.listDeadLetters())[0];
    expect(deadLetter).toBeDefined();
    const first = runtime.redrive(deadLetter!.id);
    await lookupStart;
    await expect(runtime.redrive(deadLetter!.id)).rejects.toThrow(
      /already being redriven/
    );
    const closed = runtime.close({ drain: false });
    await expect(
      Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
    ).resolves.toBe('closed');
    releaseLookup();
    await expect(first).rejects.toThrow(/clos(ing|ed)/);
  });

  it('does not emit unhandledRejection when a delayed lookup rejects after close', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseLookup!: (reason?: unknown) => void;
    const lookupGate = new Promise<void>((_resolve, reject) => {
      releaseLookup = reject;
    });
    let lookupStarted!: () => void;
    const lookupStart = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const store = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'getDeadLetter') {
          return async (id: string) => {
            lookupStarted();
            await lookupGate;
            return target.getDeadLetter(id);
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
          id: 'late-reject-redrive',
          match: { types: ['late.reject.redrive'] },
          action: 'observe',
          observe: () => {
            throw new Error('observed failure');
          },
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('late-reject-1', 'late.reject.redrive'));
    await runtime.waitForIdle();
    const deadLetter = (await backing.listDeadLetters())[0];
    const redrive = runtime.redrive(deadLetter!.id);
    await lookupStart;
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    await runtime.close({ drain: false });
    releaseLookup(new Error('late getDeadLetter rejection'));
    await expect(redrive).rejects.toThrow(/clos(ing|ed)/);
    await Promise.resolve();
    await Promise.resolve();
    process.off('unhandledRejection', onUnhandled);
    expect(rejections).toEqual([]);
  });

  it('shares one close promise so a second close waits for redrive quiescence', async () => {
    const store = new AxInMemoryEventStore();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStart = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let writesAfterFirstCloseReturned = 0;
    let firstCloseReturned = false;
    const write = vi.fn(async () => {
      if (write.mock.calls.length === 1) {
        throw new Error('synthetic sink failure');
      }
      writeStarted();
      await writeGate;
      if (firstCloseReturned) writesAfterFirstCloseReturned++;
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
              id: 'shared-close-target',
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
              id: 'shared-close-sink',
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
          id: 'shared-close-route',
          match: { types: ['shared.close'] },
          action: 'wake',
          target: eventTarget({
            id: 'shared-close-target',
            ai,
            program: program(() => ({ ok: true })),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [{ id: 'shared-close-sink', write }],
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('shared-close-1', 'shared.close'));
    await runtime.waitForIdle();
    const deadLetter = (await runtime.listDeadLetters()).find(
      (value) => value.kind === 'sink'
    );
    const redrive = runtime.redrive(deadLetter!.id);
    await writeStart;
    const firstClose = runtime.close({ drain: false }).then(() => {
      firstCloseReturned = true;
    });
    let secondReturnedEarly = false;
    const secondClose = runtime.close({ drain: false }).then(() => {
      if (!firstCloseReturned) secondReturnedEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstCloseReturned).toBe(false);
    expect(secondReturnedEarly).toBe(false);
    releaseWrite();
    await firstClose;
    await secondClose;
    await expect(redrive).rejects.toThrow(/clos(ing|ed)/);
    expect(secondReturnedEarly).toBe(false);
    expect(writesAfterFirstCloseReturned).toBe(0);
  });

  it('finishes dead-letter deletion after a committed delivery requeue even if close starts', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseRedrive!: () => void;
    const redriveGate = new Promise<void>((resolve) => {
      releaseRedrive = resolve;
    });
    let redriveStarted!: () => void;
    const redriveStart = new Promise<void>((resolve) => {
      redriveStarted = resolve;
    });
    const store = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'redriveDelivery') {
          return async (deliveryId: string, now: number) => {
            await target.redriveDelivery(deliveryId, now);
            redriveStarted();
            await redriveGate;
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
          id: 'atomic-delivery-redrive',
          match: { types: ['atomic.delivery.redrive'] },
          action: 'observe',
          observe: () => {
            throw new Error('observed failure');
          },
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(
      ingress('atomic-delivery-redrive-1', 'atomic.delivery.redrive')
    );
    await runtime.waitForIdle();
    const deadLetter = (await backing.listDeadLetters())[0];
    expect(deadLetter?.kind).toBe('delivery');
    const redrive = runtime.redrive(deadLetter!.id);
    await redriveStart;
    expect(['queued', 'claimed', 'running']).toContain(
      (await backing.getDelivery(deadLetter!.deliveryId))?.status
    );
    const closed = runtime.close({ drain: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseRedrive();
    await redrive;
    await closed;
    expect(await backing.listDeadLetters()).toEqual([]);
    expect(
      (await backing.getDelivery(deadLetter!.deliveryId))?.status
    ).not.toBe('dead_lettered');
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

  it('closes every started source when runtime startup or close runs', async () => {
    const lifecycle: string[] = [];
    const source = (id: string, fail = false) => ({
      id,
      start: async ({ signal }: { signal: AbortSignal }) => {
        lifecycle.push(`${id}:start`);
        if (fail) throw new Error(`${id}:failed`);
        return {
          close: () => {
            expect(signal.aborted).toBe(true);
            lifecycle.push(`${id}:close`);
          },
        };
      },
    });
    const runtime = new AxEventRuntime({
      routes: [],
      sources: [source('first'), source('second')],
    });
    await runtime.start();
    await runtime.close({ drain: false });
    await runtime.close({ drain: false });
    expect(lifecycle).toEqual([
      'first:start',
      'second:start',
      'second:close',
      'first:close',
    ]);

    lifecycle.length = 0;
    const failing = new AxEventRuntime({
      routes: [],
      sources: [source('first'), source('broken', true)],
    });
    await expect(failing.start()).rejects.toThrow('broken:failed');
    expect(lifecycle).toEqual(['first:start', 'broken:start', 'first:close']);
  });

  it('fences and cleans source startup that overlaps close', async () => {
    const startupGate = deferred();
    const firstStarted = deferred();
    const lifecycle: string[] = [];
    let liveSources = 0;
    const runtime = new AxEventRuntime({
      routes: [],
      sources: [
        {
          id: 'first',
          start: async ({ signal }) => {
            lifecycle.push('first:start');
            firstStarted.resolve();
            await startupGate.promise;
            liveSources++;
            return {
              close: () => {
                expect(signal.aborted).toBe(true);
                liveSources--;
                lifecycle.push('first:close');
              },
            };
          },
        },
        {
          id: 'second',
          start: () => {
            liveSources++;
            lifecycle.push('second:start');
            return {
              close: () => {
                liveSources--;
                lifecycle.push('second:close');
              },
            };
          },
        },
      ],
    });

    const starting = runtime.start();
    await firstStarted.promise;
    const closing = runtime.close({ drain: false });
    startupGate.resolve();
    const [startResult, closeResult] = await Promise.allSettled([
      starting,
      closing,
    ]);

    expect(startResult.status).toBe('rejected');
    expect(closeResult.status).toBe('fulfilled');
    expect(lifecycle).toEqual(['first:start', 'first:close']);
    expect(liveSources).toBe(0);
    await Promise.resolve();
    expect(lifecycle).toEqual(['first:start', 'first:close']);
  });

  it('aborts already-started sources immediately when a later start hangs', async () => {
    const secondStarted = deferred();
    const secondReleased = deferred();
    const readyAborted = deferred();
    const closed: string[] = [];
    const runtime = new AxEventRuntime({
      routes: [],
      sources: [
        {
          id: 'ready',
          start: async ({ signal }) => {
            signal.addEventListener(
              'abort',
              () => {
                readyAborted.resolve();
              },
              { once: true }
            );
            return {
              close: () => {
                expect(signal.aborted).toBe(true);
                closed.push('ready');
              },
            };
          },
        },
        {
          id: 'hung',
          start: async ({ signal }) => {
            secondStarted.resolve();
            await secondReleased.promise;
            return {
              close: () => {
                expect(signal.aborted).toBe(true);
                closed.push('hung');
              },
            };
          },
        },
      ],
    });
    const starting = runtime.start();
    await secondStarted.promise;
    const closing = runtime.close({ drain: false });
    await readyAborted.promise;
    secondReleased.resolve();
    await expect(starting).rejects.toThrow();
    await closing;
    expect(closed).toContain('ready');
  });

  it('rejects start while close is still tearing down', async () => {
    const started = deferred();
    const runtime = new AxEventRuntime({
      routes: [],
      sources: [
        {
          id: 'slow-close',
          start: async () => {
            started.resolve();
            return {
              close: () => new Promise(() => undefined),
            };
          },
        },
      ],
    });
    const starting = runtime.start();
    await started.promise;
    await starting;
    const closing = runtime.close({ drain: false, timeoutMs: 10 });
    await expect(runtime.start()).rejects.toThrow('is closing');
    await expect(closing).resolves.toBeUndefined();
  });

  it('bounds a hanging source disposer and still closes the store', async () => {
    const store = new AxInMemoryEventStore();
    const closeStore = vi.spyOn(store, 'close');
    const runtime = new AxEventRuntime({
      routes: [],
      store,
      sources: [
        {
          id: 'hanging-disposer',
          start: () => ({
            close: () => new Promise<void>(() => undefined),
          }),
        },
      ],
    });
    await runtime.start();

    await expect(
      Promise.race([
        runtime.close({ drain: false, timeoutMs: 10 }).then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
      ])
    ).resolves.toBe('closed');
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('observes rejecting source-error callbacks without unhandled rejection', async () => {
    const clock = new AxManualEventClock();
    const callback = vi.fn(async () => {
      throw new Error('source-error callback failed');
    });
    const runtime = new AxEventRuntime({
      clock,
      routes: [],
      sources: [
        new AxTimerEventSource({
          id: 'rejecting-source-error-callback',
          intervalMs: 10,
          type: 'timer.tick',
          clock,
          data: () => {
            throw new Error('timer failed');
          },
        }),
      ],
      onSourceError: callback,
    });
    await runtime.start();
    clock.advanceBy(10);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    await runtime.close({ drain: false, timeoutMs: 50 });
  });

  it('contains throwing source-error callbacks without stopping the source', async () => {
    const clock = new AxManualEventClock();
    const callback = vi.fn(() => {
      throw new Error('source-error callback failed');
    });
    const runtime = new AxEventRuntime({
      clock,
      routes: [],
      sources: [
        new AxTimerEventSource({
          id: 'throwing-source-error-callback',
          intervalMs: 10,
          type: 'timer.tick',
          clock,
          data: () => {
            throw new Error('timer failed');
          },
        }),
      ],
      onSourceError: callback,
    });
    await runtime.start();
    clock.advanceBy(10);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    await runtime.close({ drain: false, timeoutMs: 50 });
  });

  it('contains synchronous and asynchronous onSourceError failures', async () => {
    const unhandledRejection = vi.fn();
    const onSourceError = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sync callback failure');
      })
      .mockRejectedValueOnce(new Error('async callback failure'));
    process.on('unhandledRejection', unhandledRejection);
    const runtime = new AxEventRuntime({
      routes: [],
      sources: [
        {
          id: 'failing-error-observer',
          start: ({ reportError }) => {
            reportError(new Error('first source failure'));
            reportError(new Error('second source failure'));
          },
        },
      ],
      onSourceError,
    });
    try {
      await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onSourceError).toHaveBeenCalledTimes(2);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      await runtime.close({ drain: false });
    }
  });

  it('removes waitForWork abort listeners after each normal wake', async () => {
    const store = new AxInMemoryEventStore();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    for (let index = 0; index < 3; index++) {
      const waiting = store.waitForWork(controller.signal);
      await store.enqueue({
        ingress: ingress(`waiter-wake-${index}`, 'waiter.wake'),
        deliveries: [],
        acceptedAt: Date.now(),
        publishTimeoutMs: 100,
      });
      await waiting;
    }

    expect(add).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(
      remove.mock.calls.map(([type, listener]) => [type, listener])
    ).toEqual(add.mock.calls.map(([type, listener]) => [type, listener]));
    await store.close();
  });

  it('bounds only the return from a source close that later performs side effects', async () => {
    let sourceSignal: AbortSignal | undefined;
    let lateSideEffects = 0;
    const runtime = new AxEventRuntime({
      routes: [],
      sources: [
        {
          id: 'hung-close',
          start: (context) => {
            sourceSignal = context.signal;
            return {
              close: () =>
                new Promise<void>((resolve) => {
                  setTimeout(() => {
                    lateSideEffects++;
                    resolve();
                  }, 40);
                }),
            };
          },
        },
      ],
    });
    await runtime.start();
    const startedAt = Date.now();
    await runtime.close({ drain: false, timeoutMs: 10 });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(sourceSignal?.aborted).toBe(true);
    expect(lateSideEffects).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lateSideEffects).toBe(1);
  });

  it('bounds close independently from a manual event clock', async () => {
    const clock = new AxManualEventClock(0);
    const runtime = new AxEventRuntime({
      clock,
      routes: [],
      sources: [
        {
          id: 'manual-clock-hung-close',
          start: () => ({ close: () => new Promise<never>(() => {}) }),
        },
      ],
    });
    await runtime.start();

    const outcome = await Promise.race([
      runtime
        .close({ drain: false, timeoutMs: 10 })
        .then(() => 'closed' as const),
      new Promise<'wall-timeout'>((resolve) =>
        setTimeout(() => resolve('wall-timeout'), 75)
      ),
    ]);
    expect(outcome).toBe('closed');
    expect(clock.now()).toBe(0);
  });

  it('shares bounded close, swallows stream return throws, and suppresses late chunks', async () => {
    let releaseNext!: (value: {
      done: false;
      value: { version: number; index: number; delta: { handled: boolean } };
    }) => void;
    let nextStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nextStarted = resolve;
    });
    let returnCalls = 0;
    let lateChunkSinks = 0;
    const storeClose = vi.fn(async () => {
      throw new Error('store-close-fail');
    });
    const store = Object.assign(new AxInMemoryEventStore(), {
      close: storeClose,
    });
    const signature = new AxSignature('eventId?:string -> handled:boolean');
    const streamingProgram = {
      getId: () => 'non-cooperative-stream',
      getSignature: () => signature,
      forward: async () => ({ handled: true }),
      streamingForward: () => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => {
          nextStarted();
          return new Promise<{
            done: false;
            value: {
              version: number;
              index: number;
              delta: { handled: boolean };
            };
          }>((resolve) => {
            releaseNext = resolve;
          });
        },
        return: () => {
          returnCalls++;
          throw new Error('return-fail');
        },
      }),
    } as unknown as AxProgrammable<any, any>;
    const runtime = new AxEventRuntime({
      store,
      workerConcurrency: 1,
      routes: [
        eventRoute({
          id: 'stream-close',
          match: { types: ['stream.close'] },
          action: 'wake',
          target: eventTarget({
            id: 'stream-close-target',
            ai,
            program: streamingProgram,
            execution: 'streaming',
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [
              {
                id: 'late-chunk',
                write: () => {},
                writeChunk: () => {
                  lateChunkSinks++;
                },
              },
            ],
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('stream-close-1', 'stream.close'));
    await started;

    let repeatedCloseSettled = false;
    const firstClose = runtime.close({ drain: false, timeoutMs: 20 });
    const repeatedClose = runtime
      .close({ drain: false, timeoutMs: 20 })
      .then(() => {
        repeatedCloseSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(repeatedCloseSettled).toBe(false);
    await Promise.all([firstClose, repeatedClose]);
    expect(returnCalls).toBeGreaterThanOrEqual(1);
    expect(storeClose).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(storeClose).toHaveBeenCalledOnce();

    releaseNext({
      done: false,
      value: { version: 1, index: 0, delta: { handled: true } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lateChunkSinks).toBe(0);
  });

  it.each(['observe', 'invalidate'] as const)(
    'revokes late %s work before store disposal without compensating writes',
    async (action) => {
      const backing = new AxInMemoryEventStore();
      let disposed = false;
      let postCloseWrites = 0;
      const writes = new Set<PropertyKey>([
        'saveDelivery',
        'saveRun',
        'registerContinuation',
        'completeContinuation',
        'addDeadLetter',
      ]);
      const store = new Proxy(backing, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              disposed = true;
            };
          }
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (!writes.has(property)) return value.bind(target);
          return async (...args: unknown[]) => {
            if (disposed) postCloseWrites++;
            return value.apply(target, args);
          };
        },
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const hostStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let lateRegistrationRejected = false;
      const hostWork = async (
        _ingress: Readonly<AxEventIngress>,
        context: Readonly<{
          registerContinuation: (value: {
            correlation: { kind: string; value: string }[];
          }) => string;
        }>
      ) => {
        started();
        await gate;
        try {
          context.registerContinuation({
            correlation: [{ kind: 'late', value: action }],
          });
        } catch {
          lateRegistrationRejected = true;
        }
      };
      const route =
        action === 'observe'
          ? eventRoute({
              id: 'late-observer',
              match: { types: ['late.observe'] },
              action,
              observe: hostWork,
            })
          : eventRoute({
              id: 'late-invalidator',
              match: { types: ['late.invalidate'] },
              action,
              invalidator: { invalidate: hostWork },
            });
      const runtime = new AxEventRuntime({
        store,
        routes: [route],
      });
      await runtime.start();
      await runtime.publish(ingress(`late-${action}`, `late.${action}`));
      await hostStarted;
      await runtime.close({ drain: false, timeoutMs: 10 });
      expect(disposed).toBe(true);
      expect(postCloseWrites).toBe(0);

      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lateRegistrationRejected).toBe(true);
      expect(postCloseWrites).toBe(0);
    }
  );

  it('stops claim heartbeats when close revokes a permanently hung target', async () => {
    const store = new AxInMemoryEventStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const targetStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = new AxEventRuntime({
      store,
      leaseMs: 100,
      heartbeatMs: 10,
      routes: [
        eventRoute({
          id: 'heartbeat-close',
          match: { types: ['heartbeat.close'] },
          action: 'wake',
          target: eventTarget({
            id: 'heartbeat-close-target',
            ai,
            program: program(async () => {
              started();
              await gate;
              return { handled: true };
            }),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('heartbeat-close-1', 'heartbeat.close')
    );
    await targetStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.close({ drain: false, timeoutMs: 10 });
    const expiresAtClose = (await store.getDelivery(receipt.deliveryIds[0]!))
      ?.leaseExpiresAt;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      (await store.getDelivery(receipt.deliveryIds[0]!))?.leaseExpiresAt
    ).toBe(expiresAtClose);
    release();
    await Promise.resolve();
  });

  it('revokes an in-flight claim renewal before its delayed store mutation', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseRenewal!: () => void;
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    let renewalStarted!: () => void;
    const renewalStart = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let renewalRejected = false;
    const store = new Proxy(backing, {
      get(target, property) {
        if (property === 'renewClaim') {
          return async (...args: Parameters<typeof target.renewClaim>) => {
            renewalStarted();
            await renewalGate;
            try {
              return await target.renewClaim(...args);
            } catch (error) {
              renewalRejected = true;
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let releaseTarget!: () => void;
    const targetGate = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    let targetStarted!: () => void;
    const targetStart = new Promise<void>((resolve) => {
      targetStarted = resolve;
    });
    const runtime = new AxEventRuntime({
      store,
      leaseMs: 100,
      heartbeatMs: 10,
      routes: [
        eventRoute({
          id: 'in-flight-heartbeat-close',
          match: { types: ['heartbeat.in-flight-close'] },
          action: 'wake',
          target: eventTarget({
            id: 'in-flight-heartbeat-close-target',
            ai,
            program: program(async () => {
              targetStarted();
              await targetGate;
              return { handled: true };
            }),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('in-flight-heartbeat-close-1', 'heartbeat.in-flight-close')
    );
    await targetStart;
    const leaseBeforeRenewal = (
      await backing.getDelivery(receipt.deliveryIds[0]!)
    )?.leaseExpiresAt;
    await renewalStart;

    await runtime.close({ drain: false, timeoutMs: 10 });
    releaseRenewal();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(renewalRejected).toBe(true);
    expect(
      (await backing.getDelivery(receipt.deliveryIds[0]!))?.leaseExpiresAt
    ).toBe(leaseBeforeRenewal);
    releaseTarget();
  });

  it.each(['match', 'authorize', 'instanceKey'] as const)(
    'aborts an in-flight publish after an async %s callback before enqueue',
    async (phase) => {
      const backing = new AxInMemoryEventStore();
      let storeClosed = false;
      let enqueueCalls = 0;
      const store = new Proxy(backing, {
        get(target, property) {
          if (property === 'enqueue') {
            return async (...args: Parameters<typeof target.enqueue>) => {
              enqueueCalls++;
              if (storeClosed) throw new Error('enqueue after close');
              return target.enqueue(...args);
            };
          }
          if (property === 'close') {
            return async () => {
              storeClosed = true;
              await target.close();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      let releaseCallback!: () => void;
      const callbackGate = new Promise<void>((resolve) => {
        releaseCallback = resolve;
      });
      let callbackStarted!: () => void;
      const callbackStart = new Promise<void>((resolve) => {
        callbackStarted = resolve;
      });
      const waitForCallback = async <T>(result: T): Promise<T> => {
        callbackStarted();
        await callbackGate;
        return result;
      };
      const runtime = new AxEventRuntime({
        store,
        routes: [
          eventRoute({
            id: `publish-close-${phase}`,
            match:
              phase === 'match'
                ? () => waitForCallback(true)
                : { types: ['publish.close'] },
            action: 'observe',
            ...(phase === 'authorize'
              ? { authorize: () => waitForCallback(true) }
              : {}),
            ...(phase === 'instanceKey'
              ? { instanceKey: () => waitForCallback('instance') }
              : {}),
            observe: () => undefined,
          }),
        ],
      });
      await runtime.start();
      const publication = runtime.publish(
        ingress(`publish-close-${phase}`, 'publish.close')
      );
      await callbackStart;

      await runtime.close({ drain: false, timeoutMs: 10 });
      expect(storeClosed).toBe(true);
      releaseCallback();

      await expect(publication).rejects.toThrow('closing');
      expect(enqueueCalls).toBe(0);
    }
  );

  it('admits a one-shot continuation to only one concurrent delivery', async () => {
    const store = new AxInMemoryEventStore();
    const continuation: AxEventContinuation = {
      id: 'exclusive-continuation',
      targetId: 'exclusive-target',
      routeId: 'exclusive-start',
      instanceKey: 'exclusive-instance',
      identityScope: 'anonymous',
      correlation: [{ kind: 'job', value: 'exclusive-job' }],
      createdAt: Date.now(),
      metadata: { oneShot: true },
    };
    await store.registerContinuation(continuation);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let targetStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      targetStarted = resolve;
    });
    const admissions: string[] = [];
    let targetCalls = 0;
    const runtime = new AxEventRuntime({
      store,
      workerConcurrency: 2,
      routes: [
        eventRoute({
          id: 'exclusive-resume',
          match: { types: ['exclusive.resume'] },
          action: 'resume',
          ordering: 'relaxed',
          correlation: () => continuation.correlation[0]!,
          target: eventTarget({
            id: continuation.targetId,
            ai,
            program: program(async (_input, options) => {
              targetCalls++;
              admissions.push(options.eventContext.continuation.id);
              targetStarted();
              await gate;
              return { handled: true };
            }),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const first = await runtime.publish(
      ingress('exclusive-1', 'exclusive.resume')
    );
    const second = await runtime.publish(
      ingress('exclusive-2', 'exclusive.resume')
    );
    await started;
    for (let index = 0; index < 100; index++) {
      const statuses = await Promise.all(
        [...first.deliveryIds, ...second.deliveryIds].map(
          async (id) => (await store.getDelivery(id))?.status
        )
      );
      if (statuses.includes('dead_lettered')) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(targetCalls).toBe(1);
    expect(admissions).toEqual([continuation.id]);
    release();
    await runtime.waitForIdle();
    const statuses = await Promise.all(
      [...first.deliveryIds, ...second.deliveryIds].map(
        async (id) => (await store.getDelivery(id))?.status
      )
    );
    expect(statuses.sort()).toEqual(['dead_lettered', 'succeeded']);
    await runtime.close({ drain: false });
  });

  it('atomically completes a resume delivery with continuation consumption', async () => {
    const clock = new AxManualEventClock(1_000);
    const backing = new AxInMemoryEventStore({ clock });
    const continuation: AxEventContinuation = {
      id: 'atomic-resume-continuation',
      targetId: 'atomic-resume-target',
      routeId: 'atomic-resume-start',
      instanceKey: 'atomic-resume-instance',
      identityScope: 'anonymous',
      correlation: [{ kind: 'job', value: 'atomic-resume-job' }],
      createdAt: clock.now(),
    };
    await backing.registerContinuation(continuation);
    let atomicAttempts = 0;
    let splitCompletionCalls = 0;
    const store = new Proxy(backing, {
      get(target, property) {
        if (property === 'saveDeliveryAndCompleteContinuation') {
          return async (
            delivery: Parameters<
              typeof target.saveDeliveryAndCompleteContinuation
            >[0]
          ) => {
            atomicAttempts++;
            if (atomicAttempts === 1) {
              throw new Error('injected atomic completion failure');
            }
            return target.saveDeliveryAndCompleteContinuation(delivery);
          };
        }
        if (property === 'completeContinuation') {
          return async () => {
            splitCompletionCalls++;
            throw new Error('split continuation completion must not run');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let targetCalls = 0;
    const runtime = new AxEventRuntime({
      clock,
      store,
      leaseMs: 100,
      heartbeatMs: 25,
      routes: [
        eventRoute({
          id: 'atomic-resume',
          match: { types: ['atomic.resume'] },
          action: 'resume',
          correlation: () => continuation.correlation[0]!,
          target: eventTarget({
            id: continuation.targetId,
            ai,
            program: program(() => {
              targetCalls++;
              return { handled: true };
            }),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('atomic-resume-1', 'atomic.resume')
    );
    for (let index = 0; index < 100 && atomicAttempts === 0; index++) {
      await Promise.resolve();
    }
    const afterFailure = await backing.getDelivery(receipt.deliveryIds[0]!);
    expect(afterFailure?.status).toBe('running');
    expect(targetCalls).toBe(1);
    expect(splitCompletionCalls).toBe(0);
    await expect(
      backing.findContinuation(
        continuation.identityScope,
        continuation.correlation[0]!,
        clock.now()
      )
    ).resolves.toEqual(continuation);

    clock.advanceBy(101);
    for (let index = 0; index < 100; index++) {
      if (
        (await backing.getDelivery(receipt.deliveryIds[0]!))?.status ===
        'succeeded'
      ) {
        break;
      }
      await Promise.resolve();
    }

    expect(targetCalls).toBe(1);
    expect(atomicAttempts).toBe(2);
    expect(splitCompletionCalls).toBe(0);
    expect((await backing.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'succeeded'
    );
    await expect(
      backing.findContinuation(
        continuation.identityScope,
        continuation.correlation[0]!,
        clock.now()
      )
    ).resolves.toBeUndefined();
    await expect(
      backing.registerContinuation({
        ...continuation,
        id: 'atomic-resume-replacement',
        createdAt: clock.now(),
      })
    ).resolves.toBeUndefined();
    await runtime.close({ drain: false });
  });

  it('preserves exclusive admission across delivery and sink redrive', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryEventStore({ clock });
    const original: AxEventContinuation = {
      id: 'redrive-original',
      targetId: 'redrive-target',
      routeId: 'redrive-start',
      instanceKey: 'original-instance',
      identityScope: 'anonymous',
      correlation: [{ kind: 'job', value: 'redrive-job' }],
      createdAt: clock.now(),
      expiresAt: clock.now() + 50,
      metadata: { original: true },
    };
    await store.registerContinuation(original);
    const targetAdmissions: string[] = [];
    const targetInstances: string[] = [];
    const sinkAdmissions: string[] = [];
    const sinkInstances: string[] = [];
    let targetCalls = 0;
    let sinkCalls = 0;
    const runtime = new AxEventRuntime({
      clock,
      store,
      maxAttempts: 1,
      routes: [
        eventRoute({
          id: 'redrive-resume',
          match: { types: ['redrive.resume'] },
          action: 'resume',
          correlation: () => original.correlation[0]!,
          target: eventTarget({
            id: original.targetId,
            ai,
            program: program((_input, options) => {
              targetCalls++;
              targetAdmissions.push(options.eventContext.continuation.id);
              targetInstances.push(options.eventContext.instanceKey);
              if (targetCalls === 1) throw new Error('first target failure');
              return { handled: true };
            }),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [
              {
                id: 'redrive-sink',
                write: (_output, context) => {
                  sinkCalls++;
                  sinkAdmissions.push(context.eventContext.continuation!.id);
                  sinkInstances.push(context.eventContext.instanceKey);
                  if (sinkCalls === 1) throw new Error('first sink failure');
                },
              },
            ],
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('redrive-1', 'redrive.resume')
    );
    for (let index = 0; index < 100; index++) {
      if (
        (await store.getDelivery(receipt.deliveryIds[0]!))?.status ===
        'dead_lettered'
      ) {
        break;
      }
      await Promise.resolve();
    }
    const deliveryDeadLetter = (await runtime.listDeadLetters()).find(
      (deadLetter) => deadLetter.kind === 'delivery'
    )!;
    clock.advanceBy(51);
    await expect(
      store.findContinuation(
        original.identityScope,
        original.correlation[0]!,
        clock.now()
      )
    ).resolves.toBeUndefined();
    const replacement: AxEventContinuation = {
      ...original,
      id: 'redrive-replacement',
      instanceKey: 'replacement-instance',
      createdAt: clock.now(),
      expiresAt: undefined,
      metadata: { replacement: true },
    };
    await store.registerContinuation(replacement);

    await runtime.redrive(deliveryDeadLetter.id);
    for (let index = 0; index < 100; index++) {
      if (
        (await store.getDelivery(receipt.deliveryIds[0]!))?.status ===
        'succeeded'
      ) {
        break;
      }
      await Promise.resolve();
    }
    const sinkDeadLetter = (await runtime.listDeadLetters()).find(
      (deadLetter) => deadLetter.kind === 'sink'
    )!;
    await runtime.redrive(sinkDeadLetter.id);
    await vi.waitFor(async () =>
      expect({
        sinkAdmissions,
        status: (await store.getDelivery(receipt.deliveryIds[0]!))?.status,
        deadLetters: await runtime.listDeadLetters(),
      }).toEqual({
        sinkAdmissions: [original.id, original.id],
        status: 'succeeded',
        deadLetters: [],
      })
    );

    expect(targetAdmissions).toEqual([original.id, original.id]);
    expect(targetInstances).toEqual([
      original.instanceKey,
      original.instanceKey,
    ]);
    expect(sinkAdmissions).toEqual([original.id, original.id]);
    expect(sinkInstances).toEqual([original.instanceKey, original.instanceKey]);
    await expect(
      store.findContinuation(
        replacement.identityScope,
        replacement.correlation[0]!,
        clock.now()
      )
    ).resolves.toEqual(replacement);
    await runtime.close({ drain: false });
  });

  it('fails closed when a legacy sink redrive lacks a delivery admission', async () => {
    const store = new AxInMemoryEventStore();
    const receipt = await store.enqueue({
      ingress: ingress('legacy-sink-redrive', 'legacy.sink.redrive'),
      deliveries: [
        {
          routeId: 'legacy-sink-redrive-route',
          action: 'resume',
          targetId: 'legacy-sink-redrive-target',
          instanceKey: 'delivery-instance',
          sizeBytes: 1,
          retrySafety: 'idempotent',
          ordering: 'strict',
        },
      ],
      acceptedAt: Date.now(),
      publishTimeoutMs: 100,
    });
    const claimed = (await store.claim('worker-a', Date.now(), 1_000))!;
    const continuation: AxEventContinuation = {
      id: 'legacy-run-only-admission',
      targetId: 'legacy-sink-redrive-target',
      routeId: 'legacy-start',
      instanceKey: 'original-instance',
      identityScope: claimed.identityScope,
      correlation: [{ kind: 'job', value: 'legacy-job' }],
      createdAt: Date.now(),
    };
    const run: AxEventRun = {
      id: 'legacy-sink-redrive-run',
      deliveryId: claimed.id,
      routeId: claimed.routeId,
      targetId: continuation.targetId,
      instanceKey: continuation.instanceKey,
      admittedContinuation: continuation,
      claimedBy: claimed.claimedBy,
      fencingToken: claimed.fencingToken,
      status: 'succeeded',
      attempt: 1,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      output: { handled: true },
      sinks: [
        {
          sinkId: 'legacy-sink',
          attempts: 1,
          status: 'failed',
          error: 'offline',
        },
      ],
    };
    await store.saveDelivery({
      ...claimed,
      status: 'running',
      attempt: 1,
      runId: run.id,
    });
    await store.saveRun(run);
    await store.saveDelivery({
      ...claimed,
      status: 'succeeded',
      attempt: 1,
      runId: run.id,
    });
    await store.addDeadLetter({
      id: 'legacy-sink-dead-letter',
      kind: 'sink',
      deliveryId: receipt.deliveryIds[0]!,
      runId: run.id,
      sinkId: 'legacy-sink',
      reason: 'offline',
      createdAt: Date.now(),
    });
    let sinkCalls = 0;
    const target = eventTarget({
      id: continuation.targetId,
      ai,
      program: program(() => ({ handled: true })),
      mapInput: () => ({}),
      retrySafety: 'idempotent',
      sinks: [
        {
          id: 'legacy-sink',
          write: () => {
            sinkCalls++;
          },
        },
      ],
    });
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: claimed.routeId,
          match: { types: ['legacy.sink.redrive'] },
          action: 'resume',
          correlation: () => continuation.correlation[0]!,
          target,
        }),
      ],
    });

    await expect(runtime.redrive('legacy-sink-dead-letter')).rejects.toThrow(
      'no durable exclusive continuation admission'
    );
    expect(sinkCalls).toBe(0);
  });

  it('supervises a transient claim failure and continues the worker loop', async () => {
    const store = new AxInMemoryEventStore();
    const claim = store.claim.bind(store);
    let claimAttempts = 0;
    store.claim = async (...args) => {
      claimAttempts++;
      if (claimAttempts === 1) throw new Error('transient claim failure');
      return claim(...args);
    };
    let targetCalls = 0;
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: 'claim-retry',
          match: { types: ['claim.retry'] },
          action: 'wake',
          target: eventTarget({
            id: 'claim-retry-target',
            ai,
            program: program(() => {
              targetCalls++;
              return { handled: true };
            }),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await store.enqueue({
      ingress: ingress('claim-retry-1', 'claim.retry'),
      deliveries: [
        {
          routeId: 'claim-retry',
          action: 'wake',
          targetId: 'claim-retry-target',
          instanceKey: 'claim-retry-1',
          sizeBytes: 1,
          retrySafety: 'idempotent',
          ordering: 'strict',
        },
      ],
      acceptedAt: Date.now(),
      publishTimeoutMs: 100,
    });
    await runtime.start();
    await runtime.waitForIdle(1_000);
    expect(claimAttempts).toBeGreaterThan(1);
    expect(targetCalls).toBe(1);
    await runtime.close({ drain: false });
  });

  it('preserves the admitted continuation during sink-only recovery', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryEventStore({ clock });
    let targetCalls = 0;
    let sinkContinuation: Readonly<AxEventContinuation> | undefined;
    let sinkInstanceKey: string | undefined;
    const target = eventTarget({
      id: 'resume-recovery-target',
      ai,
      program: program(() => {
        targetCalls++;
        return { handled: false };
      }),
      mapInput: () => ({}),
      retrySafety: 'idempotent',
      sinks: [
        {
          id: 'resume-recovery-sink',
          write: (_output, context) => {
            sinkContinuation = context.eventContext.continuation;
            sinkInstanceKey = context.eventContext.instanceKey;
          },
        },
      ],
    });
    const runtime = new AxEventRuntime({
      clock,
      store,
      leaseMs: 100,
      heartbeatMs: 25,
      routes: [
        eventRoute({
          id: 'resume-recovery',
          match: { types: ['resume.recovery'] },
          action: 'resume',
          target,
          correlation: () => ({ kind: 'job', value: 'job-42' }),
        }),
      ],
    });
    const receipt = await store.enqueue({
      ingress: ingress('resume-recovery-1', 'resume.recovery'),
      deliveries: [
        {
          routeId: 'resume-recovery',
          action: 'resume',
          targetId: target.id,
          instanceKey: 'resume-recovery-1',
          sizeBytes: 1,
          retrySafety: 'idempotent',
          ordering: 'strict',
        },
      ],
      acceptedAt: clock.now(),
      publishTimeoutMs: 100,
    });
    const claimed = (await store.claim('worker-a', clock.now(), 100))!;
    const continuation: AxEventContinuation = {
      id: 'resume-recovery-continuation',
      targetId: target.id,
      routeId: 'start-recovery',
      instanceKey: 'original-instance',
      identityScope: 'anonymous',
      correlation: [{ kind: 'job', value: 'job-42' }],
      createdAt: clock.now(),
      expiresAt: clock.now() + 50,
      metadata: { admitted: 'yes' },
    };
    await store.registerContinuation(continuation);
    const exclusiveAdmission = await store.admitContinuation(
      claimed.id,
      claimed.claimedBy!,
      claimed.fencingToken!,
      continuation.identityScope,
      continuation.correlation[0]!,
      clock.now()
    );
    expect(exclusiveAdmission).toEqual(continuation);
    const admittedClaim = (await store.getDelivery(claimed.id))!;
    const run: AxEventRun = {
      id: 'resume-recovery-run',
      deliveryId: claimed.id,
      routeId: claimed.routeId,
      targetId: target.id,
      instanceKey: continuation.instanceKey,
      admittedContinuation: continuation,
      claimedBy: claimed.claimedBy,
      fencingToken: claimed.fencingToken,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      output: { handled: true },
    };
    await store.saveDelivery({
      ...admittedClaim,
      status: 'running',
      attempt: 1,
      runId: run.id,
      invocationStarted: true,
    });
    await store.saveRun(run);
    clock.advanceBy(51);
    await expect(
      store.findContinuation(
        continuation.identityScope,
        continuation.correlation[0]!,
        clock.now()
      )
    ).resolves.toBeUndefined();
    const replacement: AxEventContinuation = {
      id: 'replacement-continuation',
      targetId: target.id,
      routeId: 'replacement-start',
      instanceKey: 'replacement-instance',
      identityScope: 'anonymous',
      correlation: [{ kind: 'job', value: 'job-42' }],
      createdAt: clock.now(),
      metadata: { admitted: 'replacement' },
    };
    await store.registerContinuation(replacement);
    clock.advanceBy(50);

    await runtime.start();
    for (let index = 0; index < 50; index++) {
      if (
        (await store.getDelivery(receipt.deliveryIds[0]!))?.status ===
        'succeeded'
      )
        break;
      await Promise.resolve();
    }
    expect(targetCalls).toBe(0);
    expect(sinkContinuation).toEqual(continuation);
    expect(sinkInstanceKey).toBe(continuation.instanceKey);
    await expect(
      store.findContinuation(
        replacement.identityScope,
        replacement.correlation[0]!,
        clock.now()
      )
    ).resolves.toEqual(replacement);
    expect(await store.getDelivery(receipt.deliveryIds[0]!)).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        runId: run.id,
        fencingToken: 2,
      })
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

  it('uses one clock domain for runtime and store lease authority', async () => {
    const storeClock = new AxManualEventClock(1_000);
    const store = new AxInMemoryEventStore({ clock: storeClock });
    const forward = vi.fn(() => ({ handled: true }));
    const runtime = new AxEventRuntime({
      store,
      routes: [
        eventRoute({
          id: 'shared-clock-route',
          match: { types: ['shared.clock'] },
          action: 'wake',
          target: eventTarget({
            id: 'shared-clock-target',
            ai,
            program: program(forward),
            mapInput: () => ({}),
            retrySafety: 'idempotent',
          }),
        }),
      ],
    });
    await runtime.start();
    const receipt = await runtime.publish(
      ingress('shared-clock-1', 'shared.clock')
    );
    for (let index = 0; index < 50; index++) {
      if (
        (await store.getDelivery(receipt.deliveryIds[0]!))?.status ===
        'succeeded'
      ) {
        break;
      }
      await Promise.resolve();
    }
    expect(forward).toHaveBeenCalledOnce();
    expect(await store.getDelivery(receipt.deliveryIds[0]!)).toEqual(
      expect.objectContaining({ status: 'succeeded' })
    );
    await runtime.close();

    expect(
      () =>
        new AxEventRuntime({
          clock: new AxManualEventClock(1_000),
          store,
          routes: [],
        })
    ).toThrow('must use the same AxEventClock instance');
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

describe('AxEventRuntime worker idling', () => {
  it('drains strictly ordered deliveries under two workers without stalling timers', async () => {
    // Two workers, one instance key, strict ordering: worker A takes the first
    // delivery and worker B finds work that is DUE but not claimable. Retrying
    // that on the microtask queue alone stops every timer in the process --
    // MEASURED against `AxMind`, which configures one worker per thinker, the
    // spin deadlocks a two-thinker mind outright (see
    // `mind/mind.test.ts` > "runs a monolith beside a responder").
    const store = new AxInMemoryEventStore();
    const started: string[] = [];
    const finished: string[] = [];
    const runtime = new AxEventRuntime({
      store,
      workerConcurrency: 2,
      routes: [
        eventRoute({
          id: 'ordered',
          match: { types: ['work'] },
          action: 'wake',
          instanceKey: () => 'one',
          ordering: 'strict',
          target: eventTarget({
            id: 'ordered-target',
            ai,
            program: program(async (input: any) => {
              started.push(String(input.eventId));
              // A macrotask wait, which is what a starved event loop kills.
              await new Promise((resolve) => setTimeout(resolve, 0));
              finished.push(String(input.eventId));
              return { handled: true };
            }),
            mapInput: (ingress) => ({ eventId: ingress.event.id }),
          }),
        }),
      ],
    });
    await runtime.start();
    for (const id of ['work-1', 'work-2', 'work-3']) {
      await runtime.publish({
        event: { specversion: '1.0', id, source: 'test://work', type: 'work' },
        trust: 'trusted',
      } as AxEventIngress);
    }
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);
    await runtime.waitForIdle(5_000);
    await runtime.close({ drain: false });
    // The whole claim: every delivery ran to completion, and an unrelated
    // timer got its turn while they did.
    expect(finished).toHaveLength(3);
    expect(started).toHaveLength(3);
    expect(timerFired).toBe(true);
  });
});
