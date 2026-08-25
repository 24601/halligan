/**
 * Offline evaluation for AxJSRuntime speculative programmatic tool calling.
 *
 * The fixtures use deterministic delayed host functions: no model, network,
 * credentials, or provider quota is involved. Run with metrics enabled:
 *
 * AX_PRINT_METRICS=1 ./node_modules/.bin/vitest run src/ax/funcs/benchmarks/jsRuntimeSpeculation.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { wrapFunction } from '../../agent/agentInternal/runtimeGlobals.js';
import type { AxFunction } from '../../ai/types.js';
import { AxJSRuntime } from '../jsRuntime.js';
import type {
  AxJSRuntimeSpeculationEvent,
  AxJSRuntimeSpeculationOptions,
} from '../jsRuntimeSpeculation.js';

type Accounting = {
  physicalCalls: number;
  logicalCalls: number;
  active: number;
  maxActive: number;
  aborted: number;
};

type Fixture = {
  globals: Record<string, unknown>;
  accounting: Accounting;
};

type RunResult = {
  durationMs: number;
  result?: unknown;
  error?: Error;
  events: AxJSRuntimeSpeculationEvent[];
  accounting: Accounting;
};

const pure = (deterministic: boolean) => ({
  purity: 'pure' as const,
  deterministic,
});

const createAccounting = (): Accounting => ({
  physicalCalls: 0,
  logicalCalls: 0,
  active: 0,
  maxActive: 0,
  aborted: 0,
});

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('fixture aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('fixture aborted'));
      },
      { once: true }
    );
  });
}

function fixtureTool(
  name: string,
  accounting: Accounting,
  handler: (
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ) => unknown | Promise<unknown>,
  rootSignal?: AbortSignal
): (...args: unknown[]) => Promise<unknown> {
  const fn: AxFunction = {
    name,
    description: `Offline ${name} fixture`,
    parameters: { type: 'object', properties: {} },
    func: async (args, extra) => {
      accounting.physicalCalls++;
      accounting.active++;
      accounting.maxActive = Math.max(accounting.maxActive, accounting.active);
      try {
        return await handler(args ?? {}, extra?.abortSignal);
      } catch (error) {
        if (extra?.abortSignal?.aborted) accounting.aborted++;
        throw error;
      } finally {
        accounting.active--;
      }
    },
  };
  return wrapFunction(
    fn,
    rootSignal,
    undefined,
    undefined,
    `tools.${name}`,
    undefined,
    'external',
    () => {
      accounting.logicalCalls++;
    }
  );
}

async function runFixture(
  code: string,
  fixture: Fixture,
  callables?: AxJSRuntimeSpeculationOptions['callables'],
  signal?: AbortSignal
): Promise<RunResult> {
  const events: AxJSRuntimeSpeculationEvent[] = [];
  const runtime = new AxJSRuntime({
    outputMode: 'return',
    useNodePermissionModel: false,
    speculation: callables
      ? {
          callables,
          maxConcurrency: 4,
          maxCallsPerExecution: 16,
          onEvent: (event) => events.push(event),
        }
      : undefined,
  });
  const session = runtime.createSession(fixture.globals);
  try {
    await session.execute('return "warm";');
    const startedAt = performance.now();
    try {
      const result = await session.execute(code, { signal });
      return {
        durationMs: performance.now() - startedAt,
        result,
        events,
        accounting: fixture.accounting,
      };
    } catch (error) {
      return {
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error : new Error(String(error)),
        events,
        accounting: fixture.accounting,
      };
    }
  } finally {
    session.close();
  }
}

function delayedFixture(rootSignal?: AbortSignal, fail = false): Fixture {
  const accounting = createAccounting();
  return {
    accounting,
    globals: {
      tools: {
        delay: fixtureTool(
          'delay',
          accounting,
          async (args, signal) => {
            await delay(Number(args.delayMs), signal);
            if (fail) throw new Error('fixture failure');
            return String(args.value).toUpperCase();
          },
          rootSignal
        ),
      },
    },
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function countEvents(result: RunResult, kind: string): number {
  return result.events.filter((event) => event.kind === kind).length;
}

function metric(value: number): string {
  return value.toFixed(1);
}

describe('AxJSRuntime speculation offline evaluation', () => {
  it('measures semantic equivalence, overlap, misses, and call accounting', async () => {
    const independentCode =
      'const a = await tools.delay({ value: "a", delayMs: 40 }); const b = await tools.delay({ value: "b", delayMs: 40 }); const c = await tools.delay({ value: "c", delayMs: 40 }); return [a, b, c];';
    const dependentCode =
      'const a = await tools.delay({ value: "a", delayMs: 30 }); const b = await tools.delay({ value: a + "b", delayMs: 30 }); return [a, b];';
    const missValues = Array.from({ length: 20 }, (_, index) => `m${index}`);
    const missBindings = missValues.map((_, index) => `miss${index}`);
    const missCode = `const alias = tools.delay; ${missValues
      .map(
        (value, index) =>
          `const ${missBindings[index]} = await alias({ value: "${value}", delayMs: 0 });`
      )
      .join(' ')} return [${missBindings.join(', ')}];`;
    const timings = {
      independent: { baseline: [] as number[], speculation: [] as number[] },
      dependent: { baseline: [] as number[], speculation: [] as number[] },
      miss: { baseline: [] as number[], speculation: [] as number[] },
    };

    for (let repetition = 0; repetition < 5; repetition++) {
      for (const enabled of repetition % 2 === 0
        ? [false, true]
        : [true, false]) {
        const independent = await runFixture(
          independentCode,
          delayedFixture(),
          enabled ? { 'tools.delay': pure(false) } : undefined
        );
        expect(independent.error).toBeUndefined();
        expect(independent.result).toEqual(['A', 'B', 'C']);
        expect(independent.accounting).toMatchObject({
          physicalCalls: 3,
          logicalCalls: 3,
          maxActive: enabled ? 3 : 1,
        });
        expect(countEvents(independent, 'hit')).toBe(enabled ? 3 : 0);
        timings.independent[enabled ? 'speculation' : 'baseline'].push(
          independent.durationMs
        );

        const dependent = await runFixture(
          dependentCode,
          delayedFixture(),
          enabled ? { 'tools.delay': pure(false) } : undefined
        );
        expect(dependent.error).toBeUndefined();
        expect(dependent.result).toEqual(['A', 'AB']);
        expect(dependent.accounting).toMatchObject({
          physicalCalls: 2,
          logicalCalls: 2,
          maxActive: 1,
        });
        expect(countEvents(dependent, 'hit')).toBe(enabled ? 2 : 0);
        timings.dependent[enabled ? 'speculation' : 'baseline'].push(
          dependent.durationMs
        );

        const miss = await runFixture(
          missCode,
          delayedFixture(),
          enabled ? { 'tools.delay': pure(false) } : undefined
        );
        expect(miss.error).toBeUndefined();
        expect(miss.result).toEqual(
          missValues.map((value) => value.toUpperCase())
        );
        expect(miss.accounting).toMatchObject({
          physicalCalls: missValues.length,
          logicalCalls: missValues.length,
          maxActive: 1,
        });
        expect(countEvents(miss, 'hit')).toBe(0);
        if (enabled) {
          expect(countEvents(miss, 'miss')).toBe(missValues.length);
        }
        timings.miss[enabled ? 'speculation' : 'baseline'].push(
          miss.durationMs
        );
      }
    }

    const rows = Object.entries(timings).map(([workload, values]) => {
      const baselineMs = median(values.baseline);
      const speculationMs = median(values.speculation);
      return {
        workload,
        baselineMs,
        speculationMs,
        speedup: baselineMs / speculationMs,
      };
    });
    const independent = rows.find((row) => row.workload === 'independent');
    const dependent = rows.find((row) => row.workload === 'dependent');
    const miss = rows.find((row) => row.workload === 'miss');
    expect(independent?.speedup).toBeGreaterThan(1.5);
    expect(dependent?.speedup).toBeLessThan(1.5);
    expect(miss?.speculationMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
      (miss?.baselineMs ?? 0) * 5 + 20
    );

    const duplicateAccounting = await evaluateDuplicates();
    const unsafeAccounting = await evaluateUnsafeCall();
    const failureAccounting = await evaluateFailure();
    const cancellationAccounting = await evaluateCancellation();
    const unclaimedAccounting = await evaluateUnclaimedCall();

    if (process.env.AX_PRINT_METRICS) {
      const timingRows = rows
        .map(
          (row) =>
            `| ${row.workload} | ${metric(row.baselineMs)} | ${metric(row.speculationMs)} | ${row.speedup.toFixed(2)}x |`
        )
        .join('\n');
      console.log(
        `\n| workload | disabled median (ms) | enabled median (ms) | ratio |\n|---|---:|---:|---:|\n${timingRows}\n\n` +
          `| accounting case | disabled physical/logical | enabled physical/logical | enabled aborted |\n|---|---:|---:|---:|\n` +
          `| deterministic duplicates | ${duplicateAccounting.deterministic.baseline} | ${duplicateAccounting.deterministic.speculation} | 0 |\n` +
          `| nondeterministic duplicates | ${duplicateAccounting.nondeterministic.baseline} | ${duplicateAccounting.nondeterministic.speculation} | 0 |\n` +
          `| unapproved side effect | ${unsafeAccounting.baseline} | ${unsafeAccounting.speculation} | 0 |\n` +
          `| claimed failure | ${failureAccounting.baseline} | ${failureAccounting.speculation} | 0 |\n` +
          `| claimed cancellation | n/a | ${cancellationAccounting} | 1 |\n` +
          `| unreached pure call after throw | ${unclaimedAccounting.baseline} | ${unclaimedAccounting.speculation} | 1 |\n`
      );
    }
  }, 15_000);
});

async function evaluateDuplicates(): Promise<{
  deterministic: { baseline: string; speculation: string };
  nondeterministic: { baseline: string; speculation: string };
}> {
  const code =
    'const a = await tools.read({ value: "same" }); const b = await tools.read({ value: "same" }); return [a, b];';
  const runDuplicate = async (deterministic: boolean, enabled: boolean) => {
    const accounting = createAccounting();
    let sequence = 0;
    const result = await runFixture(
      code,
      {
        accounting,
        globals: {
          tools: {
            read: fixtureTool('read', accounting, ({ value }) =>
              deterministic ? String(value) : `${value}-${++sequence}`
            ),
          },
        },
      },
      enabled ? { 'tools.read': pure(deterministic) } : undefined
    );
    return result;
  };

  const deterministicBaseline = await runDuplicate(true, false);
  const deterministicSpeculation = await runDuplicate(true, true);
  expect(deterministicSpeculation.result).toEqual(deterministicBaseline.result);
  expect(deterministicBaseline.accounting).toMatchObject({
    physicalCalls: 2,
    logicalCalls: 2,
  });
  expect(deterministicSpeculation.accounting).toMatchObject({
    physicalCalls: 1,
    logicalCalls: 2,
  });

  const nondeterministicBaseline = await runDuplicate(false, false);
  const nondeterministicSpeculation = await runDuplicate(false, true);
  expect(nondeterministicSpeculation.result).toEqual(
    nondeterministicBaseline.result
  );
  expect(nondeterministicBaseline.accounting).toMatchObject({
    physicalCalls: 2,
    logicalCalls: 2,
  });
  expect(nondeterministicSpeculation.accounting).toMatchObject({
    physicalCalls: 2,
    logicalCalls: 2,
  });

  return {
    deterministic: {
      baseline: '2/2',
      speculation: '1/2',
    },
    nondeterministic: {
      baseline: '2/2',
      speculation: '2/2',
    },
  };
}

async function evaluateUnsafeCall(): Promise<{
  baseline: string;
  speculation: string;
}> {
  const code =
    'const receipt = await tools.write({ value: "x" }); const value = await tools.read({ value: "safe" }); return [receipt, value];';
  const runUnsafe = async (enabled: boolean) => {
    const accounting = createAccounting();
    let writes = 0;
    const result = await runFixture(
      code,
      {
        accounting,
        globals: {
          tools: {
            write: fixtureTool('write', accounting, () => `write-${++writes}`),
            read: fixtureTool('read', accounting, ({ value }) => value),
          },
        },
      },
      enabled ? { 'tools.read': pure(true) } : undefined
    );
    expect(writes).toBe(1);
    expect(result.result).toEqual(['write-1', 'safe']);
    return result;
  };
  const baseline = await runUnsafe(false);
  const speculation = await runUnsafe(true);
  expect(speculation.accounting.physicalCalls).toBe(2);
  expect(speculation.accounting.logicalCalls).toBe(2);
  expect(countEvents(speculation, 'hit')).toBe(1);
  return {
    baseline: `${baseline.accounting.physicalCalls}/${baseline.accounting.logicalCalls}`,
    speculation: `${speculation.accounting.physicalCalls}/${speculation.accounting.logicalCalls}`,
  };
}

async function evaluateFailure(): Promise<{
  baseline: string;
  speculation: string;
}> {
  const code = 'await tools.delay({ value: "x", delayMs: 1 });';
  const baseline = await runFixture(code, delayedFixture(undefined, true));
  const speculation = await runFixture(code, delayedFixture(undefined, true), {
    'tools.delay': pure(false),
  });
  expect(baseline.error?.message).toContain('fixture failure');
  expect(speculation.error?.message).toContain('fixture failure');
  expect(baseline.accounting.physicalCalls).toBe(1);
  expect(speculation.accounting.physicalCalls).toBe(1);
  return { baseline: '1/1', speculation: '1/1' };
}

async function evaluateCancellation(): Promise<string> {
  const controller = new AbortController();
  const fixture = delayedFixture(controller.signal);
  const execution = runFixture(
    'await tools.delay({ value: "x", delayMs: 1000 });',
    fixture,
    { 'tools.delay': pure(false) },
    controller.signal
  );
  await vi.waitFor(() => expect(fixture.accounting.logicalCalls).toBe(1));
  controller.abort('evaluation abort');
  const result = await execution;
  expect(result.error?.message).toContain('Aborted');
  await vi.waitFor(() => expect(result.accounting.aborted).toBe(1));
  expect(result.accounting).toMatchObject({
    physicalCalls: 1,
    logicalCalls: 1,
    aborted: 1,
  });
  expect(countEvents(result, 'cancelled')).toBe(1);
  return '1/1';
}

async function evaluateUnclaimedCall(): Promise<{
  baseline: string;
  speculation: string;
}> {
  const code =
    'throw new Error("branch stopped"); const value = await tools.delay({ value: "x", delayMs: 1000 });';
  const baseline = await runFixture(code, delayedFixture());
  const speculation = await runFixture(code, delayedFixture(), {
    'tools.delay': pure(false),
  });
  expect(baseline.error?.message).toContain('branch stopped');
  expect(speculation.error?.message).toContain('branch stopped');
  await vi.waitFor(() => expect(speculation.accounting.aborted).toBe(1));
  expect(baseline.accounting).toMatchObject({
    physicalCalls: 0,
    logicalCalls: 0,
    aborted: 0,
  });
  expect(speculation.accounting).toMatchObject({
    physicalCalls: 1,
    logicalCalls: 0,
    aborted: 1,
  });
  expect(countEvents(speculation, 'cancelled')).toBe(1);
  return { baseline: '0/0', speculation: '1/0' };
}
