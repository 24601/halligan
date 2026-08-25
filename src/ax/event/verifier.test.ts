import { describe, expect, it, vi } from 'vitest';
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
    const { runtime } = setup({
      id: 'max-runs',
      maxRuns: 2,
      verify: (_output, context) => {
        runIds.push(context.run.id);
        return { status: 'fail', failure: { code: 'still_bad' } };
      },
    });
    await runtime.start();
    await runtime.publish(ingress());
    await runtime.waitForIdle();
    expect(runIds).toHaveLength(2);
    expect((await runtime.getRun(runIds[1]!))?.verification).toMatchObject({
      status: 'exhausted',
      reason: 'max_runs',
    });
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
    const { runtime } = setup({
      id: `verifier-${status}`,
      timeoutMs: 5,
      verify: (output, context) => {
        runId = context.run.id;
        return verify(output, context) as any;
      },
    });
    await runtime.start();
    await runtime.publish(ingress(status));
    await runtime.waitForIdle();
    expect((await runtime.getRun(runId))?.verification?.status).toBe(status);
    expect((await runtime.getRun(runId))?.status).toBe('verification_failed');
    await runtime.close();
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
    await first.publish(ingress());
    while (verify.mock.calls.length < 1)
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
});
