import { describe, expect, it, vi } from 'vitest';
import { wrapFunction } from '../agent/agentInternal/runtimeGlobals.js';
import type { AxFunction } from '../ai/types.js';
import { AxJSRuntime } from './jsRuntime.js';
import { setJSRuntimeHostFunctionSpeculationAdapter } from './jsRuntimeHostFunction.js';
import type {
  AxJSRuntimeSpeculationEvent,
  AxJSRuntimeSpeculationOptions,
} from './jsRuntimeSpeculation.js';

type TestCallable = (...args: unknown[]) => Promise<unknown>;

function createTestCallable(
  handler: (
    args: readonly unknown[],
    signal: AbortSignal | undefined
  ) => unknown | Promise<unknown>
): TestCallable {
  const callable: TestCallable = (...args) =>
    Promise.resolve(handler(args, undefined));
  setJSRuntimeHostFunctionSpeculationAdapter(callable, {
    launch: (args, signal) => ({
      result: Promise.resolve(handler(args, signal)),
    }),
    commit: (_args, launch) => launch.result,
  });
  return callable;
}

function speculation(
  events: AxJSRuntimeSpeculationEvent[],
  callables: AxJSRuntimeSpeculationOptions['callables'],
  options?: Pick<
    AxJSRuntimeSpeculationOptions,
    'maxCallsPerExecution' | 'maxConcurrency'
  >
): AxJSRuntimeSpeculationOptions {
  return {
    callables,
    ...options,
    onEvent: (event) => events.push(event),
  };
}

async function run(
  code: string,
  globals: Record<string, unknown>,
  speculationOptions?: AxJSRuntimeSpeculationOptions,
  signal?: AbortSignal
): Promise<unknown> {
  const runtime = new AxJSRuntime({
    outputMode: 'return',
    useNodePermissionModel: false,
    speculation: speculationOptions,
  });
  const session = runtime.createSession(globals);
  try {
    return await session.execute(code, { signal });
  } finally {
    session.close();
  }
}

const pure = (deterministic: boolean) => ({
  purity: 'pure' as const,
  deterministic,
});

describe('AxJSRuntime speculative programmatic tool calling', () => {
  it('overlaps independent literal calls and reports hits', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const tool = createTestCallable(async ([input]) => {
      const value = (input as { value: string }).value;
      calls.push(value);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return value.toUpperCase();
    });

    await expect(
      run(
        'const a = await tools.read({ value: "a" }); const b = await tools.read({ value: "b" }); return [a, b];',
        { tools: { read: tool } },
        speculation(events, { 'tools.read': pure(false) })
      )
    ).resolves.toEqual(['A', 'B']);

    expect(calls).toEqual(['a', 'b']);
    expect(maxActive).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'miss')).toHaveLength(0);
  });

  it('gives each speculative launch an independent worker-equivalent clone', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    const mutate = createTestCallable(async ([input]) => {
      const value = input as { count: number };
      value.count++;
      return value.count;
    });
    const code =
      'const a = await tools.mutate(inputs.shared); const b = await tools.mutate(inputs.shared); return [a, b];';

    const baseline = await run(code, {
      inputs: { shared: { count: 0 } },
      tools: { mutate },
    });
    const speculative = await run(
      code,
      {
        inputs: { shared: { count: 0 } },
        tools: { mutate },
      },
      speculation(events, { 'tools.mutate': pure(false) })
    );

    expect(baseline).toEqual([1, 1]);
    expect(speculative).toEqual(baseline);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(2);
  });

  it('enforces the configured concurrency bound', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let active = 0;
    let maxActive = 0;
    const tool = createTestCallable(async ([input]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return (input as { value: number }).value;
    });

    await expect(
      run(
        'const a = await tools.read({ value: 1 }); const b = await tools.read({ value: 2 }); const c = await tools.read({ value: 3 }); return [a, b, c];',
        { tools: { read: tool } },
        speculation(
          events,
          { 'tools.read': pure(false) },
          { maxConcurrency: 2 }
        )
      )
    ).resolves.toEqual([1, 2, 3]);
    expect(maxActive).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(3);
  });

  it('commits Ax function observers exactly once and only for claimed calls', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    const observed: string[] = [];
    const recorded: string[] = [];
    let executions = 0;
    const fn: AxFunction = {
      name: 'read',
      description: 'Read a pure test value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Value' } },
        required: ['value'],
      },
      func: async ({ value }: { value: string }) => {
        executions++;
        return value.toUpperCase();
      },
    };
    const wrapped = wrapFunction(
      fn,
      undefined,
      undefined,
      undefined,
      'tools.read',
      (call) => recorded.push(call.arguments),
      'external',
      (call) => {
        observed.push(String(call.args.value));
      }
    );

    const runtime = new AxJSRuntime({
      outputMode: 'return',
      useNodePermissionModel: false,
      speculation: speculation(events, { 'tools.read': pure(true) }),
    });
    const session = runtime.createSession({ tools: { read: wrapped } });
    try {
      await expect(
        session.execute(
          'const value = await tools.read({ value: "claimed" }); return value;'
        )
      ).resolves.toBe('CLAIMED');
      await expect(
        session.execute(
          'throw new Error("stop"); const value = await tools.read({ value: "unclaimed" });'
        )
      ).rejects.toThrow('stop');
    } finally {
      session.close();
    }

    expect(executions).toBe(2);
    expect(observed).toEqual(['claimed']);
    expect(recorded).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(1);
    expect(events).toContainEqual({
      kind: 'cancelled',
      tool: 'tools.read',
      callIndex: 0,
      deterministic: true,
      reason: 'execution-failed',
    });
  });

  it('matches ordinary observer and recorder arguments after tool-local mutation', async () => {
    const execute = async (enabled: boolean) => {
      const events: AxJSRuntimeSpeculationEvent[] = [];
      const observed: unknown[] = [];
      const recorded: unknown[] = [];
      const wrapped = wrapFunction(
        {
          name: 'mutate',
          description: 'Mutate only the invocation-local argument clone',
          parameters: { type: 'object', additionalProperties: true },
          func: (args: { nested: { count: number } }) => {
            args.nested.count++;
            return args.nested.count;
          },
        },
        undefined,
        undefined,
        undefined,
        'tools.mutate',
        (call) => recorded.push(call.arguments),
        'external',
        (call) => observed.push(structuredClone(call.args))
      );
      const runtime = new AxJSRuntime({
        outputMode: 'return',
        useNodePermissionModel: false,
        speculation: enabled
          ? speculation(events, { 'tools.mutate': pure(true) })
          : undefined,
      });
      const session = runtime.createSession({ tools: { mutate: wrapped } });
      try {
        return {
          value: await session.execute(
            'const value = await tools.mutate({ nested: { count: 0 } }); return value;'
          ),
          events,
          observed,
          recorded,
        };
      } finally {
        session.close();
      }
    };

    const baseline = await execute(false);
    const speculative = await execute(true);

    expect(speculative.value).toBe(baseline.value);
    expect(speculative.observed).toEqual(baseline.observed);
    expect(speculative.recorded).toEqual(baseline.recorded);
    expect(baseline.observed).toEqual([{ nested: { count: 0 } }]);
    expect(baseline.recorded).toEqual([{ nested: { count: 1 } }]);
    expect(
      speculative.events.filter((event) => event.kind === 'hit')
    ).toHaveLength(1);
  });

  it('does not retry when tool-local argument mutation cannot be cloned', async () => {
    const execute = async (enabled: boolean) => {
      let executions = 0;
      const recorded: unknown[] = [];
      const wrapped = wrapFunction(
        {
          name: 'mutate',
          description: 'Create a cycle only inside the invocation-local input',
          parameters: { type: 'object', additionalProperties: true },
          func: (args: { nested: { self?: unknown } }) => {
            executions++;
            args.nested.self = args.nested;
            return executions;
          },
        },
        undefined,
        undefined,
        undefined,
        'tools.mutate',
        (call) => recorded.push(call.arguments)
      );
      const runtime = new AxJSRuntime({
        outputMode: 'return',
        useNodePermissionModel: false,
        speculation: enabled
          ? speculation([], { 'tools.mutate': pure(false) })
          : undefined,
      });
      const session = runtime.createSession({ tools: { mutate: wrapped } });
      try {
        return {
          value: await session.execute(
            'return await tools.mutate({ nested: {} });'
          ),
          executions,
          recorded,
        };
      } finally {
        session.close();
      }
    };

    const baseline = await execute(false);
    const speculative = await execute(true);

    expect(speculative).toEqual(baseline);
    expect(speculative.executions).toBe(1);
    expect(speculative.recorded).toEqual(['[object Object]']);
  });

  it('does not mutate worker state while planning syntactically invalid code', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let calls = 0;
    const tool = createTestCallable(async () => `value-${++calls}`);
    const runtime = new AxJSRuntime({
      outputMode: 'return',
      useNodePermissionModel: false,
      speculation: speculation(events, { 'tools.read': pure(true) }),
    });
    const session = runtime.createSession({ tools: { read: tool } });
    try {
      await expect(
        session.execute(
          'const guessed = await tools.read({ value: "x" }); const broken = ;'
        )
      ).resolves.toContain('SyntaxError');
      await expect(session.execute('return typeof guessed;')).resolves.toBe(
        'undefined'
      );
    } finally {
      session.close();
    }

    expect(calls).toBe(1);
    expect(events.some((event) => event.kind === 'hit')).toBe(false);
    expect(events).toContainEqual({
      kind: 'cancelled',
      tool: 'tools.read',
      callIndex: 0,
      deterministic: true,
      reason: 'execution-complete',
    });
  });

  it('supports safe dependencies on prior awaited speculative results', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    const args: string[] = [];
    const tool = createTestCallable(async ([input]) => {
      const value = (input as { value: string }).value;
      args.push(value);
      await Promise.resolve();
      return `${value}!`;
    });

    await expect(
      run(
        'const first = await tools.step({ value: "seed" }); const second = await tools.step({ value: "next:" + first }); return second;',
        { tools: { step: tool } },
        speculation(events, { 'tools.step': pure(false) })
      )
    ).resolves.toBe('next:seed!!');
    expect(args).toEqual(['seed', 'next:seed!']);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(2);
  });

  it('reuses deterministic duplicates but preserves logical hit multiplicity', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let executions = 0;
    const tool = createTestCallable(async () => {
      executions++;
      return { execution: executions };
    });

    await expect(
      run(
        'const a = await tools.stable({ value: 1 }); const b = await tools.stable({ value: 1 }); return [a, b];',
        { tools: { stable: tool } },
        speculation(events, { 'tools.stable': pure(true) })
      )
    ).resolves.toEqual([{ execution: 1 }, { execution: 1 }]);
    expect(executions).toBe(1);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(2);
  });

  it('does not deduplicate observably different object property orders', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let executions = 0;
    const tool = createTestCallable(async ([input]) => {
      executions++;
      return Object.keys(input as Record<string, unknown>).join(',');
    });

    await expect(
      run(
        'const a = await tools.inspect({ a: 1, b: 2 }); const b = await tools.inspect({ b: 2, a: 1 }); return [a, b];',
        { tools: { inspect: tool } },
        speculation(events, { 'tools.inspect': pure(true) })
      )
    ).resolves.toEqual(['a,b', 'b,a']);
    expect(executions).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(2);
  });

  it('distinguishes sparse array holes from explicit undefined values', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let executions = 0;
    const make = createTestCallable(async () => {
      const hole: unknown[] = [];
      hole.length = 1;
      return hole;
    });
    const inspect = createTestCallable(async ([input]) => {
      executions++;
      return 0 in (input as unknown[]);
    });

    await expect(
      run(
        'const hole = await tools.make({}); const a = await tools.inspect(hole); const b = await tools.inspect([hole[0]]); return [a, b];',
        { tools: { inspect, make } },
        speculation(events, {
          'tools.inspect': pure(true),
          'tools.make': pure(true),
        })
      )
    ).resolves.toEqual([false, true]);
    expect(executions).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(3);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(3);
  });

  it('falls back for argument graphs with observable shared references', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let executions = 0;
    const tool = createTestCallable(async ([input]) => {
      executions++;
      const values = input as unknown[];
      return values[0] === values[1];
    });

    await expect(
      run(
        'const same = await tools.inspect([inputs.value, inputs.value]); return same;',
        { inputs: { value: { id: 1 } }, tools: { inspect: tool } },
        speculation(events, { 'tools.inspect': pure(true) })
      )
    ).resolves.toBe(true);
    expect(executions).toBe(1);
    expect(events.some((event) => event.kind === 'dispatch')).toBe(false);
    expect(events.some((event) => event.reason === 'unsafe-dependency')).toBe(
      true
    );
  });

  it('keeps nondeterministic duplicate calls independent and FIFO', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let executions = 0;
    const tool = createTestCallable(async () => `sample-${++executions}`);

    await expect(
      run(
        'const a = await tools.sample({ value: 1 }); const b = await tools.sample({ value: 1 }); return [a, b];',
        { tools: { sample: tool } },
        speculation(events, { 'tools.sample': pure(false) })
      )
    ).resolves.toEqual(['sample-1', 'sample-2']);
    expect(executions).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(2);
  });

  it('never speculates an unapproved side-effecting callable', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let writes = 0;
    const write = async () => ++writes;

    await expect(
      run(
        'const result = await tools.write({ value: "x" }); return result;',
        { tools: { write } },
        speculation(events, { 'tools.other': pure(true) })
      )
    ).resolves.toBe(1);
    expect(writes).toBe(1);
    expect(events).toEqual([]);
  });

  it('executes calls inside branches and loops only in the worker', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    const calls: string[] = [];
    const tool = createTestCallable(async ([input]) => {
      const value = String((input as { value: unknown }).value);
      calls.push(value);
      return value.toUpperCase();
    });

    await expect(
      run(
        'const results = []; if (inputs.enabled) { results.push(await tools.read({ value: "branch" })); }; for (const value of inputs.values) { results.push(await tools.read({ value })); }; return results;',
        {
          inputs: { enabled: true, values: ['loop-a', 'loop-b'] },
          tools: { read: tool },
        },
        speculation(events, { 'tools.read': pure(true) })
      )
    ).resolves.toEqual(['BRANCH', 'LOOP-A', 'LOOP-B']);
    expect(calls).toEqual(['branch', 'loop-a', 'loop-b']);
    expect(events.some((event) => event.kind === 'dispatch')).toBe(false);
    expect(events).toContainEqual({
      kind: 'blocked',
      tool: 'tools.read',
      reason: 'unsupported-syntax',
    });
  });

  it('falls back when a configured callable lacks a cancellable host adapter', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let calls = 0;
    const raw = async () => ++calls;

    await expect(
      run(
        'const result = await tools.raw({ value: "x" }); return result;',
        { tools: { raw } },
        speculation(events, { 'tools.raw': pure(true) })
      )
    ).resolves.toBe(1);
    expect(calls).toBe(1);
    expect(events).toContainEqual({
      kind: 'blocked',
      tool: 'tools.raw',
      reason: 'callable-not-cancellable',
    });
    expect(events).toContainEqual({
      kind: 'miss',
      tool: 'tools.raw',
      deterministic: true,
      reason: 'no-match',
    });
  });

  it('does not propagate unsafe dependencies from unapproved calls', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let writes = 0;
    let reads = 0;
    const write = async () => `write-${++writes}`;
    const read = createTestCallable(async ([input]) => {
      reads++;
      return (input as { value: string }).value;
    });

    await expect(
      run(
        'const changed = await tools.write({}); const result = await tools.read({ value: changed }); return result;',
        { tools: { write, read } },
        speculation(events, { 'tools.read': pure(true) })
      )
    ).resolves.toBe('write-1');
    expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
    expect(events).toContainEqual({
      kind: 'blocked',
      tool: 'tools.read',
      callIndex: 0,
      deterministic: true,
      reason: 'unsafe-dependency',
    });
    expect(events.some((event) => event.kind === 'dispatch')).toBe(false);
  });

  it('surfaces a speculative error at the real call without retrying', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let calls = 0;
    const tool = createTestCallable(async () => {
      calls++;
      throw new Error('expected failure');
    });

    await expect(
      run(
        'await tools.fail({ value: "x" });',
        { tools: { fail: tool } },
        speculation(events, { 'tools.fail': pure(false) })
      )
    ).rejects.toThrow('expected failure');
    expect(calls).toBe(1);
    expect(events.some((event) => event.kind === 'hit')).toBe(true);
  });

  it('cancels claimed work when execution is aborted', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let observedAbort = false;
    const tool = createTestCallable(
      (_args, signal) =>
        new Promise((_resolve, reject) => {
          if (!signal) {
            reject(new Error('missing speculation signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(new Error('tool aborted'));
            },
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const execution = run(
      'const value = await tools.wait({ value: "x" }); return value;',
      { tools: { wait: tool } },
      speculation(events, { 'tools.wait': pure(false) }),
      controller.signal
    );
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'hit')).toBe(true);
    });
    controller.abort('test abort');

    await expect(execution).rejects.toThrow('Aborted');
    await vi.waitFor(() => expect(observedAbort).toBe(true));
    expect(events).toContainEqual({
      kind: 'cancelled',
      tool: 'tools.wait',
      callIndex: 0,
      deterministic: false,
      reason: 'execution-aborted',
    });
  });

  it('cancels unclaimed work and never reuses it in a later execute()', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let calls = 0;
    const tool = createTestCallable(async () => `value-${++calls}`);
    const runtime = new AxJSRuntime({
      outputMode: 'return',
      useNodePermissionModel: false,
      speculation: speculation(events, { 'tools.read': pure(true) }),
    });
    const session = runtime.createSession({ tools: { read: tool } });
    try {
      await expect(
        session.execute(
          'throw new Error("stop"); const stale = await tools.read({ value: "x" });'
        )
      ).rejects.toThrow('stop');
      await expect(
        session.execute(
          'const fresh = await tools.read({ value: "x" }); return fresh;'
        )
      ).resolves.toBe('value-2');
    } finally {
      session.close();
    }
    expect(calls).toBe(2);
    expect(events).toContainEqual({
      kind: 'cancelled',
      tool: 'tools.read',
      callIndex: 0,
      deterministic: true,
      reason: 'execution-failed',
    });
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(1);
  });

  it('revokes stale callable paths when globals are patched', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let staleCalls = 0;
    const stale = createTestCallable(async () => {
      staleCalls++;
      return 'stale';
    });
    const runtime = new AxJSRuntime({
      outputMode: 'return',
      useNodePermissionModel: false,
      speculation: speculation(events, { 'tools.read': pure(true) }),
    });
    const session = runtime.createSession({ tools: { read: stale } });
    try {
      await session.patchGlobals({ tools: { other: async () => 'other' } });
      await expect(
        session.execute(
          'const value = await tools.read({ value: "x" }); return value;'
        )
      ).resolves.toContain('tools.read is not a function');
    } finally {
      session.close();
    }

    expect(staleCalls).toBe(0);
    expect(events).toContainEqual({
      kind: 'blocked',
      tool: 'tools.read',
      reason: 'callable-unavailable',
    });
  });

  it('bounds canonical arguments before falling back to one normal call', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let calls = 0;
    const tool = createTestCallable(async ([input]) => {
      calls++;
      return (input as { value: string }).value.length;
    });

    await expect(
      run(
        'const size = await tools.read({ value: inputs.large }); return size;',
        { inputs: { large: 'x'.repeat(60_000) }, tools: { read: tool } },
        speculation(events, { 'tools.read': pure(true) })
      )
    ).resolves.toBe(60_000);
    expect(calls).toBe(1);
    expect(events.some((event) => event.reason === 'arguments-too-large')).toBe(
      true
    );
    expect(events.some((event) => event.kind === 'dispatch')).toBe(false);
  });

  it('bounds planned calls and executes overflow normally', async () => {
    const events: AxJSRuntimeSpeculationEvent[] = [];
    let calls = 0;
    const tool = createTestCallable(async ([input]) => {
      calls++;
      return (input as { value: number }).value;
    });

    await expect(
      run(
        'const a = await tools.read({ value: 1 }); const b = await tools.read({ value: 2 }); return [a, b];',
        { tools: { read: tool } },
        speculation(
          events,
          { 'tools.read': pure(false) },
          { maxCallsPerExecution: 1 }
        )
      )
    ).resolves.toEqual([1, 2]);
    expect(calls).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatch')).toHaveLength(1);
    expect(events.some((event) => event.reason === 'call-limit')).toBe(true);
    expect(events.some((event) => event.kind === 'miss')).toBe(true);
  });

  it('matches ordinary semantics when disabled or when syntax misses', async () => {
    let baselineCalls = 0;
    let speculativeCalls = 0;
    const baseline = async ({ value }: { value: string }) => {
      baselineCalls++;
      return value.toUpperCase();
    };
    const events: AxJSRuntimeSpeculationEvent[] = [];
    const speculative = createTestCallable(async ([input]) => {
      speculativeCalls++;
      return (input as { value: string }).value.toUpperCase();
    });
    const code =
      'const alias = tools.read; const value = await alias({ value: "same" }); return value;';

    const baselineResult = await run(code, { tools: { read: baseline } });
    const speculativeResult = await run(
      code,
      { tools: { read: speculative } },
      speculation(events, { 'tools.read': pure(true) })
    );

    expect(speculativeResult).toBe(baselineResult);
    expect({ baselineCalls, speculativeCalls }).toEqual({
      baselineCalls: 1,
      speculativeCalls: 1,
    });
    expect(events.some((event) => event.kind === 'dispatch')).toBe(false);
    expect(events.some((event) => event.kind === 'miss')).toBe(true);
  });

  it('rejects incomplete purity or unbounded configuration', () => {
    expect(
      () =>
        new AxJSRuntime({
          speculation: {
            callables: {
              'tools.read': {
                purity: 'impure',
                deterministic: true,
              } as never,
            },
          },
        })
    ).toThrow("must explicitly set purity: 'pure'");
    expect(
      () =>
        new AxJSRuntime({
          speculation: {
            callables: { 'tools.read': pure(true) },
            maxConcurrency: 33,
          },
        })
    ).toThrow('speculation.maxConcurrency');
  });
});
