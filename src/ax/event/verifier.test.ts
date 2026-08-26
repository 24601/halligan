import { describe, expect, it, vi } from 'vitest';
import { AxAgentClarificationError } from '../agent/agentInternal/agentStateTypes.js';
import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import {
  AxInMemoryEventStore,
  AxInMemoryProgramStateStore,
} from './memoryStore.js';
import { AxEventRuntime, eventRoute, eventTarget } from './runtime.js';
import type {
  AxEventContext,
  AxEventIngress,
  AxEventRun,
  AxEventVerifierPolicy,
} from './types.js';
import * as eventUtil from './util.js';

const ai = {} as any;

function ingress(id = 'goal-1'): AxEventIngress {
  return {
    event: {
      specversion: '1.0',
      id,
      source: 'app://tests',
      type: 'goal.run',
      data: { goal: 'fix the tests' },
    },
    identity: { tenantId: 'tenant-1' },
    trust: 'authenticated',
  };
}

function programmable(
  forward: (input: any, options?: any) => unknown | Promise<unknown>
): AxProgrammable<any, any> {
  const signature = new AxSignature(
    'goal:string, feedback?:json -> answer:string'
  );
  return {
    getId: () => 'goal-program',
    getSignature: () => signature,
    forward: (_ai: unknown, input: unknown, options?: unknown) =>
      Promise.resolve(forward(input, options)),
    streamingForward: async function* () {},
  } as AxProgrammable<any, any>;
}

function setup(
  verifier: Readonly<AxEventVerifierPolicy>,
  options: Readonly<{
    store?: AxInMemoryEventStore;
    stateStore?: AxInMemoryProgramStateStore;
    forward?: (input: any, options?: any) => unknown | Promise<unknown>;
    sink?: (output: unknown) => void | Promise<void>;
  }> = {}
) {
  const target = eventTarget({
    id: 'goal',
    ai,
    program: programmable(
      options.forward ?? ((input) => ({ answer: String(input.goal) }))
    ),
    mapInput: (_value, context) => ({
      goal: 'fix the tests',
      feedback: context.continuation?.metadata?.verification,
    }),
    retrySafety: 'idempotent',
    verifier,
    ...(options.sink ? { sinks: [{ id: 'final', write: options.sink }] } : {}),
  });
  const runtime = new AxEventRuntime({
    store: options.store,
    programStateStore: options.stateStore,
    workerConcurrency: 1,
    routes: [
      eventRoute({
        id: 'run-goal',
        match: { types: ['goal.run'] },
        action: 'wake',
        target,
      }),
    ],
  });
  return { runtime, target };
}

describe('AxEventRuntime verifier continuation policy', () => {
  it('startup-gates verifier targets on the v2 transition capability', async () => {
    const store = new AxInMemoryEventStore();
    (store as any).capabilities = {
      ...store.capabilities,
      verifierTransitions: undefined,
    };
    const runtime = setup(
      { id: 'gate', verify: () => ({ status: 'pass' }) },
      { store }
    ).runtime;
    await expect(runtime.start()).rejects.toThrow(
      'axevent-verifier-transition-v2'
    );
  });

  it('rejects verifier-gated streaming before any chunk sink can run', () => {
    const writeChunk = vi.fn();
    expect(() =>
      eventTarget({
        id: 'streaming-verifier',
        ai,
        program: programmable(() => ({ answer: 'unused' })),
        mapInput: () => ({ goal: 'unused' }),
        execution: 'streaming',
        verifier: { id: 'gate', verify: () => ({ status: 'pass' }) },
        sinks: [{ id: 'chunks', write: vi.fn(), writeChunk }],
      })
    ).toThrow('cannot combine verifier with streaming');
    expect(writeChunk).not.toHaveBeenCalled();
  });

  it('persists output, passes the gate, and only then dispatches sinks', async () => {
    const store = new AxInMemoryEventStore();
    const order: string[] = [];
    const runtimeRef: { value?: AxEventRuntime } = {};
    const configured = setup(
      {
        id: 'tests-pass',
        verify: async (_output, context) => {
          const persisted = await runtimeRef.value!.getRun(context.run.id);
          expect(persisted?.output).toEqual(context.run.output);
          order.push('verify');
          return { status: 'pass' };
        },
      },
      { store, sink: () => order.push('sink') }
    );
    const runtime = configured.runtime;
    runtimeRef.value = runtime;
    await runtime.start();
    const receipt = await runtime.publish(ingress());
    await runtime.waitForIdle();
    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    const run = await runtime.getRun(delivery!.runId!);
    expect(run?.status).toBe('succeeded');
    expect(run?.verification?.status).toBe('pass');
    expect(order).toEqual(['verify', 'sink']);
    await runtime.close();
  });

  it('feeds bounded failure evidence into a resume and then passes', async () => {
    const runs: string[] = [];
    const feedback: unknown[] = [];
    const verify = vi.fn((_output, context: { run: AxEventRun }) => {
      runs.push(context.run.id);
      return runs.length === 1
        ? {
            status: 'fail' as const,
            failure: { code: 'tests_failed', evidence: 'x'.repeat(1_000) },
          }
        : { status: 'pass' as const };
    });
    const { runtime } = setup(
      { id: 'tests-retry', verify, maxEvidenceBytes: 64 },
      {
        forward: (input) => {
          feedback.push(input.feedback);
          return { answer: `attempt-${feedback.length}` };
        },
      }
    );
    await runtime.start();
    await runtime.publish(ingress());
    await runtime.waitForIdle();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(feedback[0]).toBeUndefined();
    const resumed = feedback[1] as any;
    expect(resumed.failure.code).toBe('tests_failed');
    expect(
      new TextEncoder().encode(JSON.stringify(resumed.failure.evidence))
        .byteLength
    ).toBeLessThanOrEqual(64);
    expect((await runtime.getRun(runs[1]!))?.verification?.status).toBe('pass');
    await runtime.close();
  });

  it('hands a failed parent to its child with one pending-delivery slot', async () => {
    const verify = vi
      .fn()
      .mockReturnValueOnce({
        status: 'fail',
        failure: { code: 'retry_once' },
      })
      .mockReturnValue({ status: 'pass' });
    const store = new AxInMemoryEventStore({ maxPendingDeliveries: 1 });
    const { runtime } = setup({ id: 'single-slot', verify }, { store });
    await runtime.start();
    await runtime.publish(ingress('single-slot'));
    await runtime.waitForIdle();
    expect(verify).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it('does not verify clarification invocations that produce no output', async () => {
    const verify = vi.fn(() => ({ status: 'pass' as const }));
    const { runtime } = setup(
      { id: 'clarification', verify },
      {
        forward: () => {
          throw new AxAgentClarificationError('Which goal?');
        },
      }
    );
    await runtime.start();
    await runtime.publish(ingress('clarification'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(verify).not.toHaveBeenCalled();
    await runtime.close({ drain: false });
  });

  it('keeps interleaved A, B, and A-resume verifier chains independent', async () => {
    let release!: () => void;
    let entered!: () => void;
    const verifierEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const verifierReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = new Map<string, number>();
    const feedback: Array<{ goal: string; code?: string }> = [];
    const runIds: string[] = [];
    const target = eventTarget({
      id: 'interleaved',
      ai,
      program: programmable(({ goal, feedback: failure }) => {
        const count = (attempts.get(goal) ?? 0) + 1;
        attempts.set(goal, count);
        feedback.push({ goal, code: failure?.failure?.code });
        return {
          answer: goal === 'A' && count === 1 ? 'A-bad' : `${goal}-good`,
        };
      }),
      mapInput: (value, context) => ({
        goal: context.continuation ? 'A' : value.event.id,
        feedback: context.continuation?.metadata?.verification,
      }),
      retrySafety: 'idempotent',
      verifier: {
        id: 'interleaved-gate',
        verify: async (output, context) => {
          runIds.push(context.run.id);
          if (output.answer === 'A-bad') {
            entered();
            await verifierReleased;
            return {
              status: 'fail',
              failure: { code: 'A_failure', evidence: 'only A' },
            };
          }
          return { status: 'pass' };
        },
      },
    });
    const runtime = new AxEventRuntime({
      workerConcurrency: 1,
      routes: [
        eventRoute({
          id: 'interleaved-route',
          match: { types: ['goal.run'] },
          action: 'wake',
          target,
          instanceKey: () => 'shared-instance',
        }),
      ],
    });
    await runtime.start();
    await runtime.publish(ingress('A'));
    await Promise.race([
      verifierEntered,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('A verifier did not start')), 500)
      ),
    ]);
    await runtime.publish(ingress('B'));
    release();
    await runtime.waitForIdle();
    expect(feedback).toEqual([
      { goal: 'A', code: undefined },
      { goal: 'B', code: undefined },
      { goal: 'A', code: 'A_failure' },
    ]);
    expect(attempts).toEqual(
      new Map([
        ['A', 2],
        ['B', 1],
      ])
    );
    const verifications = await Promise.all(
      runIds.map(async (runId) => (await runtime.getRun(runId))!.verification!)
    );
    expect(verifications.map((value) => value.run)).toEqual([1, 1, 2]);
    expect(verifications[0]!.chainId).toBe(verifications[2]!.chainId);
    expect(verifications[1]!.chainId).not.toBe(verifications[0]!.chainId);
    await runtime.close();
  });

  it.each([
    ['max_tokens', { maxTokens: 1, usage: () => ({ tokens: 1 }) }],
    ['max_cost', { maxCostUSD: 0.01, usage: () => ({ costUSD: 0.01 }) }],
  ] as const)('fails closed at the %s limit', async (reason, limit) => {
    let runId = '';
    const verify = vi.fn(() => ({
      status: 'fail' as const,
      failure: { code: 'limit_reached' },
    }));
    const { runtime } = setup({
      id: `limit-${reason}`,
      verify,
      ...limit,
      usage: (_output, context) => {
        runId = context.run.id;
        return limit.usage();
      },
    });
    await runtime.start();
    await runtime.publish(ingress(reason));
    await runtime.waitForIdle();
    const run = await runtime.getRun(runId);
    expect(run?.status).toBe('verification_failed');
    expect(run?.verification).toMatchObject({ status: 'exhausted', reason });
    expect(verify).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('fails closed when max runs are exhausted', async () => {
    const runIds: string[] = [];
    const sink = vi.fn();
    const { runtime } = setup(
      {
        id: 'max-runs',
        maxRuns: 2,
        verify: (_output, context) => {
          runIds.push(context.run.id);
          return { status: 'fail', failure: { code: 'still_bad' } };
        },
      },
      { sink }
    );
    await runtime.start();
    await runtime.publish(ingress());
    await runtime.waitForIdle();
    expect(runIds).toHaveLength(2);
    expect((await runtime.getRun(runIds[1]!))?.verification).toMatchObject({
      status: 'exhausted',
      reason: 'max_runs',
    });
    expect(sink).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('fails closed when wall time is exhausted between attempts', async () => {
    const runIds: string[] = [];
    const storedRuns: AxEventRun[] = [];
    const store = new AxInMemoryEventStore();
    const saveRun = store.saveRun.bind(store);
    vi.spyOn(store, 'saveRun').mockImplementation(async (run) => {
      storedRuns.push(structuredClone(run));
      await saveRun(run);
    });
    const verify = vi.fn(() => {
      return { status: 'fail' as const, failure: { code: 'not_yet' } };
    });
    const { runtime } = setup(
      {
        id: 'wall-time',
        verify,
        maxWallTimeMs: 50,
        backoffMs: 60,
      },
      {
        store,
        forward: (_input, options) => {
          runIds.push(options.eventContext.runId);
          return { answer: 'not-yet' };
        },
      }
    );
    await runtime.start();
    await runtime.publish(ingress());
    await runtime.waitForIdle();
    expect(verify).toHaveBeenCalledOnce();
    expect(runIds).toHaveLength(1);
    expect(storedRuns.at(-1)?.verification).toMatchObject({
      status: 'exhausted',
      reason: 'max_wall_time',
    });
    await runtime.close();
  });

  it('suppresses a repeated verifier call when the fingerprint is unchanged', async () => {
    const runIds: string[] = [];
    const verify = vi.fn((_output, context) => {
      runIds.push(context.run.id);
      return { status: 'fail' as const, failure: { code: 'same_failure' } };
    });
    let secondContext: AxEventContext | undefined;
    const { runtime } = setup(
      {
        id: 'fingerprint',
        verify,
        fingerprint: () => 'tree:abc123',
      },
      {
        forward: (_input, options) => {
          if (options.eventContext.continuation) {
            secondContext = options.eventContext;
          }
          return { answer: 'unchanged' };
        },
      }
    );
    await runtime.start();
    await runtime.publish(ingress());
    await runtime.waitForIdle();
    expect(verify).toHaveBeenCalledOnce();
    expect(secondContext).toBeDefined();
    const secondRun = await runtime.getRun(secondContext!.runId);
    expect(secondRun?.verification?.status).toBe('unchanged_state');
    expect(secondRun?.status).toBe('verification_failed');
    await runtime.close();
  });

  it.each([
    ['error', () => Promise.reject(new Error('verifier unavailable'))],
    ['timeout', () => new Promise(() => undefined)],
  ] as const)('fails closed on verifier %s', async (status, verify) => {
    let runId = '';
    const sink = vi.fn();
    const { runtime } = setup(
      {
        id: `verifier-${status}`,
        timeoutMs: 5,
        verify: (output, context) => {
          runId = context.run.id;
          return verify(output, context) as any;
        },
      },
      { sink }
    );
    await runtime.start();
    await runtime.publish(ingress(status));
    await runtime.waitForIdle();
    expect((await runtime.getRun(runId))?.verification?.status).toBe(status);
    expect((await runtime.getRun(runId))?.status).toBe('verification_failed');
    expect(sink).not.toHaveBeenCalled();
    await runtime.close();
  });

  it.each(['usage', 'fingerprint'] as const)(
    'times out a hanging %s callback before verify or sinks',
    async (callback) => {
      let runId = '';
      const verify = vi.fn(() => ({ status: 'pass' as const }));
      const sink = vi.fn();
      const hanging = (_output: unknown, context: { run: AxEventRun }) => {
        runId = context.run.id;
        return new Promise<never>(() => undefined);
      };
      const { runtime } = setup(
        {
          id: `hanging-${callback}`,
          timeoutMs: 5,
          verify,
          ...(callback === 'usage'
            ? { usage: hanging }
            : { fingerprint: hanging }),
        },
        { sink }
      );
      await runtime.start();
      await runtime.publish(ingress(callback));
      await runtime.waitForIdle();
      expect((await runtime.getRun(runId))?.verification?.status).toBe(
        'timeout'
      );
      expect(verify).not.toHaveBeenCalled();
      expect(sink).not.toHaveBeenCalled();
      await runtime.close();
    }
  );

  it('falls back to zero backoff when the backoff callback hangs', async () => {
    const verify = vi
      .fn()
      .mockReturnValueOnce({
        status: 'fail',
        failure: { code: 'retry' },
      })
      .mockReturnValue({ status: 'pass' });
    const { runtime } = setup({
      id: 'hanging-backoff',
      timeoutMs: 5,
      backoffMs: (() => new Promise<never>(() => undefined)) as never,
      verify,
    });
    await runtime.start();
    await runtime.publish(ingress('backoff'));
    await runtime.waitForIdle();
    expect(verify).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it('rejects public publishes that spoof the reserved verifier source', async () => {
    const { runtime } = setup({
      id: 'reserved-source',
      verify: () => ({ status: 'pass' }),
    });
    await runtime.start();
    await expect(
      runtime.publish({
        event: {
          specversion: '1.0',
          id: 'spoofed-verifier',
          source: 'ax://event-runtime/verifier',
          type: 'goal.run',
        },
      })
    ).rejects.toThrow('reserved source');
    await runtime.close({ drain: false });
  });

  it('fails closed when cumulative usage overflows', async () => {
    let runId = '';
    const { runtime } = setup({
      id: 'overflow',
      maxRuns: 3,
      usage: (_output, context) => {
        runId = context.run.id;
        return { tokens: Number.MAX_VALUE };
      },
      verify: () => ({
        status: 'fail',
        failure: { code: 'again' },
      }),
    });
    await runtime.start();
    await runtime.publish(ingress('overflow'));
    await runtime.waitForIdle();
    const run = await runtime.getRun(runId);
    expect(run?.verification?.status).toBe('error');
    expect(Number.isFinite(run?.verification?.cumulativeUsage.tokens)).toBe(
      true
    );
    await runtime.close();
  });

  it('bounds huge Unicode verifier fields in persisted state', async () => {
    const huge = '🔥'.repeat(10_000);
    const runIds: string[] = [];
    const { runtime } = setup({
      id: 'unicode',
      maxRuns: 2,
      fingerprint: () => huge,
      verify: (_output, context) => {
        runIds.push(context.run.id);
        return {
          status: 'fail',
          failure: { code: huge, evidence: huge },
        };
      },
    });
    await runtime.start();
    await runtime.publish(ingress('unicode'));
    await runtime.waitForIdle();
    const first = (await runtime.getRun(runIds[0]!))!.verification!;
    expect(
      new TextEncoder().encode(first.fingerprint).byteLength
    ).toBeLessThanOrEqual(1_024);
    expect(
      new TextEncoder().encode(first.failure!.code).byteLength
    ).toBeLessThanOrEqual(256);
    expect(
      new TextEncoder().encode(JSON.stringify(first.failure!.evidence))
        .byteLength
    ).toBeLessThanOrEqual(4_096);
    await runtime.close();
  });

  it.each([
    ['maxRuns', 1.5],
    ['maxEvidenceBytes', 16.5],
  ] as const)('rejects fractional verifier %s', (option, value) => {
    expect(() =>
      eventTarget({
        id: `fractional-${option}`,
        ai,
        program: programmable(() => ({ answer: 'unused' })),
        mapInput: () => ({ goal: 'unused' }),
        verifier: {
          id: 'fractional',
          verify: () => ({ status: 'pass' }),
          [option]: value,
        },
      })
    ).toThrow(option);
  });

  it('cancels an active verifier through the run abort signal', async () => {
    let context!: Readonly<{ run: AxEventRun; signal: AbortSignal }>;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { runtime } = setup({
      id: 'abort',
      verify: (_output, value) => {
        context = value;
        entered();
        return new Promise((_resolve, reject) =>
          value.signal.addEventListener(
            'abort',
            () => reject(value.signal.reason),
            { once: true }
          )
        );
      },
    });
    await runtime.start();
    await runtime.publish(ingress());
    await started;
    expect(runtime.cancelRun(context.run.id, 'host abort')).toBe(true);
    await runtime.waitForIdle();
    expect((await runtime.getRun(context.run.id))?.status).toBe('cancelled');
    await runtime.close();
  });

  it('does not install a verifier child when cancel is accepted before delayed transition', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseTransition!: () => void;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    let transitionStarted!: () => void;
    const transitionStart = new Promise<void>((resolve) => {
      transitionStarted = resolve;
    });
    let enteredTransition = false;
    let runId = '';
    let targetCalls = 0;
    const store = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'transitionVerifier') {
          return async (
            request: Parameters<typeof target.transitionVerifier>[0],
            signal?: AbortSignal
          ) => {
            enteredTransition = true;
            transitionStarted();
            await transitionGate;
            return target.transitionVerifier(request, signal);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { runtime } = setup(
      {
        id: 'cancel-during-transition',
        verify: (_output, context) => {
          runId = context.run.id;
          return {
            status: 'fail',
            failure: { code: 'retry' },
          };
        },
      },
      {
        store,
        forward: () => {
          targetCalls++;
          return { answer: 'fix the tests' };
        },
      }
    );
    await runtime.start();
    const receipt = await runtime.publish(ingress('cancel-during-transition'));
    await transitionStart;
    expect(runtime.cancelRun(runId, 'host abort')).toBe(true);
    releaseTransition();
    await runtime.waitForIdle();
    expect((await runtime.getRun(runId))?.status).toBe('cancelled');
    expect((await backing.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
      'cancelled'
    );
    expect(targetCalls).toBe(1);
    expect(enteredTransition).toBe(true);
    await runtime.close({ drain: false });
  });

  it('does not install a verifier child when cancel is accepted during in-memory digest awaits', async () => {
    const backing = new AxInMemoryEventStore();
    let releaseDigest!: () => void;
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    let digestStarted!: () => void;
    const digestStart = new Promise<void>((resolve) => {
      digestStarted = resolve;
    });
    let holdDigest = false;
    const digest = eventUtil.axEventCanonicalDigest;
    const digestSpy = vi
      .spyOn(eventUtil, 'axEventCanonicalDigest')
      .mockImplementation(async (value) => {
        if (holdDigest) {
          holdDigest = false;
          digestStarted();
          await digestGate;
        }
        return digest(value);
      });
    let enteredBacking = false;
    let runId = '';
    let targetCalls = 0;
    const store = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'transitionVerifier') {
          return (
            request: Parameters<typeof target.transitionVerifier>[0],
            signal?: AbortSignal
          ) => {
            holdDigest = true;
            const pending = target.transitionVerifier(request, signal);
            enteredBacking = true;
            return pending;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const { runtime } = setup(
        {
          id: 'cancel-during-digest',
          verify: (_output, context) => {
            runId = context.run.id;
            return {
              status: 'fail',
              failure: { code: 'retry' },
            };
          },
        },
        {
          store,
          forward: () => {
            targetCalls++;
            return { answer: 'fix the tests' };
          },
        }
      );
      await runtime.start();
      const receipt = await runtime.publish(ingress('cancel-during-digest'));
      await digestStart;
      expect(enteredBacking).toBe(true);
      expect(runtime.cancelRun(runId, 'host abort')).toBe(true);
      releaseDigest();
      await runtime.waitForIdle();
      expect((await runtime.getRun(runId))?.status).toBe('cancelled');
      expect((await backing.getDelivery(receipt.deliveryIds[0]!))?.status).toBe(
        'cancelled'
      );
      expect(
        await backing.getDelivery(
          `verifier-delivery:${receipt.deliveryIds[0]!}:1`
        )
      ).toBeUndefined();
      expect(targetCalls).toBe(1);
      await runtime.close({ drain: false });
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('restores a queued verifier continuation and policy state after restart', async () => {
    const store = new AxInMemoryEventStore();
    const stateStore = new AxInMemoryProgramStateStore();
    const verify = vi
      .fn()
      .mockReturnValueOnce({
        status: 'fail',
        failure: { code: 'first_failure' },
      })
      .mockReturnValue({ status: 'pass' });
    const first = setup(
      { id: 'restart', verify, backoffMs: 50 },
      { store, stateStore }
    ).runtime;
    await first.start();
    const receipt = await first.publish(ingress());
    while (verify.mock.calls.length < 1)
      await new Promise((r) => setTimeout(r, 1));
    const childId = `verifier-delivery:${receipt.deliveryIds[0]!}:1`;
    while (!(await store.getDelivery(childId)))
      await new Promise((r) => setTimeout(r, 1));
    await first.close({ drain: false });

    const second = setup(
      { id: 'restart', verify, backoffMs: 50 },
      { store, stateStore }
    ).runtime;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await second.start();
    await second.waitForIdle();
    expect(verify).toHaveBeenCalledTimes(2);
    await second.close();
  });

  it('deduplicates the original event without duplicating verifier runs', async () => {
    const verify = vi
      .fn()
      .mockReturnValueOnce({
        status: 'fail',
        failure: { code: 'retry_once' },
      })
      .mockReturnValue({ status: 'pass' });
    const { runtime } = setup({ id: 'dedupe', verify });
    await runtime.start();
    const first = await runtime.publish(ingress());
    const duplicate = await runtime.publish(ingress());
    await runtime.waitForIdle();
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it.each([
    'before-commit',
    'after-commit-ack-loss',
    'double-commit-ack-loss',
  ] as const)(
    'converges one verifier chain when transition fails %s',
    async (fault) => {
      const store = new AxInMemoryEventStore();
      const transition = store.transitionVerifier.bind(store);
      const confirmTransition = store.confirmVerifierTransition.bind(store);
      let injected = false;
      if (fault === 'double-commit-ack-loss') {
        vi.spyOn(store, 'confirmVerifierTransition')
          .mockResolvedValueOnce(undefined)
          .mockImplementation(confirmTransition);
      }
      vi.spyOn(store, 'transitionVerifier').mockImplementation(
        async (request) => {
          if (fault === 'double-commit-ack-loss') {
            await transition(request);
            throw new Error(fault);
          }
          if (!injected) {
            injected = true;
            if (fault === 'after-commit-ack-loss') await transition(request);
            throw new Error(fault);
          }
          return transition(request);
        }
      );
      const chainIds: string[] = [];
      const verify = vi.fn((_output, context) => {
        chainIds.push(context.eventContext.deliveryId);
        return verify.mock.calls.length === 1
          ? {
              status: 'fail' as const,
              failure: { code: 'retry_once' },
            }
          : { status: 'pass' as const };
      });
      const { runtime } = setup({ id: `fault-${fault}`, verify }, { store });
      await runtime.start();
      await runtime.publish(ingress(`fault-${fault}`));
      await runtime.waitForIdle();
      expect(verify).toHaveBeenCalledTimes(2);
      expect(new Set(chainIds).size).toBe(2);
      expect(store.transitionVerifier).toHaveBeenCalledTimes(
        fault === 'after-commit-ack-loss' ? 1 : 2
      );
      const operation = (store.transitionVerifier as any).mock.calls[0]![0];
      await expect(
        transition({
          ...operation,
          continuation: {
            ...operation.continuation,
            metadata: { conflicting: true },
          },
        })
      ).rejects.toThrow('already owned');
      await expect(
        confirmTransition({
          ...operation,
          parent: {
            ...operation.parent,
            expectedFencingToken: operation.parent.expectedFencingToken + 1,
          },
        })
      ).rejects.toThrow('already owned');
      if (fault === 'double-commit-ack-loss') {
        const journal = (store as any).verifierTransitions.get(
          operation.operationId
        );
        journal.receipt.deliveryIds = ['corrupted-child'];
        await expect(confirmTransition(operation)).rejects.toThrow(
          'already owned'
        );
      }
      await runtime.close();
    }
  );

  it.each(['before-save', 'after-save-ack-loss'] as const)(
    'persists verifier input exactly once across a run-save fault %s',
    async (fault) => {
      const store = new AxInMemoryEventStore();
      const saveRun = store.saveRun.bind(store);
      let injected = false;
      vi.spyOn(store, 'saveRun').mockImplementation(async (run) => {
        if (!injected && run.output !== undefined && !run.verification) {
          injected = true;
          if (fault === 'after-save-ack-loss') await saveRun(run);
          throw new Error(fault);
        }
        return saveRun(run);
      });
      const forward = vi.fn(() => ({ answer: 'durable' }));
      const verify = vi.fn(() => ({ status: 'pass' as const }));
      const { runtime } = setup(
        { id: `save-fault-${fault}`, verify },
        { store, forward }
      );
      await runtime.start();
      await runtime.publish(ingress(`save-fault-${fault}`));
      await runtime.waitForIdle();
      expect(forward).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledOnce();
      await runtime.close();
    }
  );

  it('does not mutate store state when a child projection fails validation', async () => {
    const store = new AxInMemoryEventStore();
    const receipt = await store.enqueue({
      ingress: ingress('half-commit'),
      deliveries: [
        {
          routeId: 'run-goal',
          action: 'wake',
          targetId: 'goal',
          instanceKey: 'half-commit',
          sizeBytes: 1,
        },
      ],
      acceptedAt: Date.now(),
      publishTimeoutMs: 100,
    });
    const parent = (await store.claim('worker-a', Date.now(), 30_000))!;
    const parentRun: AxEventRun = {
      id: 'half-commit-run',
      deliveryId: parent.id,
      routeId: parent.routeId,
      targetId: parent.targetId,
      instanceKey: parent.instanceKey,
      claimedBy: parent.claimedBy,
      fencingToken: parent.fencingToken,
      status: 'waiting_event',
      attempt: 1,
      startedAt: Date.now(),
    };
    await store.saveRun(parentRun);
    const request = {
      operationId: 'half-commit-op',
      childDeliveryId: 'half-commit-child',
      parent: {
        delivery: {
          ...parent,
          status: 'waiting_event' as const,
          runId: parentRun.id,
        },
        run: parentRun,
        expectedFencingToken: parent.fencingToken!,
      },
      continuation: {
        id: 'half-commit-continuation',
        targetId: 'goal',
        routeId: 'run-goal',
        instanceKey: parent.instanceKey,
        identityScope: parent.identityScope,
        correlation: [{ kind: 'ax.verifier', value: 'half-commit' }],
        createdAt: Date.now(),
      },
      child: {
        ingress: {
          event: {
            specversion: '1.0' as const,
            id: 'half-commit-child-event',
            source: 'app://tests',
            type: 'goal.run',
          },
        },
        deliveries: [
          {
            routeId: 'run-goal',
            action: 'resume' as const,
            instanceKey: parent.instanceKey,
            sizeBytes: 1,
          },
        ],
        acceptedAt: Date.now(),
        publishTimeoutMs: 100,
      },
    };
    vi.spyOn(store as never, 'persistedChildProjection').mockReturnValueOnce({
      id: 'mismatch',
    });
    await expect(store.transitionVerifier(request)).rejects.toThrow(
      'does not match request'
    );
    expect(await store.getDelivery(parent.id)).toEqual(parent);
    expect(await store.getDelivery('half-commit-child')).toBeUndefined();
    expect(await store.confirmVerifierTransition(request)).toBeUndefined();
    expect(receipt.deliveryIds).toEqual([parent.id]);
  });
});
