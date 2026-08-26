import { describe, expect, it, vi } from 'vitest';
import { AxAgentClarificationError } from '../agent/agentInternal/agentStateTypes.js';
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
            if (run.status === 'succeeded' && run.output !== undefined) {
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
