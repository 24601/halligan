import { describe, expect, it } from 'vitest';
import type { AxCodeRuntime } from '../agent/rlm.js';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxChatRequest, AxChatResponse, AxFunction } from '../ai/types.js';
import { AxGen } from './generate.js';
import { AxGEPA } from './optimizers/gepa.js';
import {
  AxProgramSourceBudgetError,
  type AxProgramSourceDocument,
  type AxProgramSourceExpression,
  AxProgramSourceSessionExpiredError,
  type AxProgramSourceStatement,
  axProgramSourceRuntimeProtocol,
  axProgramSourceVersion,
  programSource,
} from './programSource.js';

const ref = (path: string): AxProgramSourceExpression => ({ op: 'ref', path });
const literal = (value: unknown): AxProgramSourceExpression => ({
  op: 'literal',
  value,
});
const source = (
  steps: readonly AxProgramSourceStatement[],
  capabilities: AxProgramSourceDocument['capabilities'] = []
): string =>
  JSON.stringify({ version: axProgramSourceVersion, capabilities, steps });

const compatibleRuntime = (runtime: AxCodeRuntime) => ({
  runtime,
  protocol: axProgramSourceRuntimeProtocol,
});

const returnAnswer = (
  value: AxProgramSourceExpression
): AxProgramSourceStatement => ({
  op: 'return',
  outputs: { answer: value },
});

const mockTextAI = (answer = 'ok') => {
  const ai = new AxMockAIService({
    features: { functions: true, streaming: false },
  });
  ai.chat = async () =>
    ({
      results: [
        { index: 0, content: `Answer: ${answer}`, finishReason: 'stop' },
      ],
    }) as AxChatResponse;
  return ai;
};

const echoTool = (onCall?: () => void): AxFunction => ({
  name: 'echo',
  description: 'Echo the provided value.',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'Value to echo.' },
    },
    required: ['value'],
  },
  returns: { type: 'object' },
  func: ({ value }: { value: string }) => {
    onCall?.();
    return { answer: value };
  },
});

describe('AxProgramSource', () => {
  it('seeds a runnable single-predictor program without tools', async () => {
    const program = programSource('question:string -> answer:string');
    const document = JSON.parse(program.getProgramSource());

    expect(document).toMatchObject({
      version: axProgramSourceVersion,
      capabilities: ['predict'],
      steps: [
        {
          op: 'predict',
          signature: '$program',
          tools: [],
          input: { op: 'ref', path: 'inputs' },
        },
        { op: 'return' },
      ],
    });
    await expect(
      program.forward(mockTextAI('seed'), { question: 'q' })
    ).resolves.toEqual({ answer: 'seed' });
  });

  it('seeds predictor tool wiring and publishes complete proposal constraints', async () => {
    let request: AxChatRequest | undefined;
    const ai = mockTextAI('with-tools');
    ai.chat = async (nextRequest) => {
      request = nextRequest;
      return {
        results: [
          { index: 0, content: 'Answer: with-tools', finishReason: 'stop' },
        ],
      } as AxChatResponse;
    };
    const program = programSource('question:string -> answer:string', {
      tools: [echoTool()],
    });
    const component = program
      .getOptimizableComponents()
      .find((candidate) => candidate.kind === 'program-source');

    expect(program.getCapabilities()).toEqual(['predict', 'tool:echo']);
    expect(JSON.parse(program.getProgramSource()).steps[0].tools).toEqual([
      'echo',
    ]);
    expect(component?.constraints).toContain(
      'Outer signature (immutable): question:string -> answer:string'
    );
    expect(component?.constraints).toContain('Available tools:');
    expect(component?.constraints).toContain(
      'Allowed statements: predict, tool, if, forEach, return.'
    );

    await program.forward(ai, { question: 'q' });
    expect(JSON.stringify(request)).toContain('echo');
  });

  it('applies a validated whole-source candidate', async () => {
    const program = programSource('question:string -> answer:string');
    const candidate = source([returnAnswer(literal('candidate'))]);
    const component = program
      .getOptimizableComponents()
      .find((value) => value.kind === 'program-source')!;

    expect(component.validate?.(candidate)).toBe(true);
    program.applyOptimizedComponents({
      [`${program.getId()}::program-source`]: candidate,
    });

    expect(program.getProgramSource()).toBe(candidate);
    await expect(
      program.forward({} as never, { question: 'q' })
    ).resolves.toEqual({ answer: 'candidate' });
  });

  it('lets GEPA propose, evaluate, and apply a whole-source candidate', async () => {
    const ai = mockTextAI('seed');
    const program = programSource('question:string -> answer:string');
    const candidate = source([returnAnswer(literal('optimized'))]);
    const component = program
      .getOptimizableComponents()
      .find((value) => value.kind === 'program-source')!;
    const optimizer = new AxGEPA({
      studentAI: ai,
      teacherAI: ai,
      numTrials: 1,
      minibatch: false,
      seed: 1,
    });
    (optimizer as any).reflectTargetInstruction = async (...args: any[]) => {
      expect(args[0]).toBe(component.key);
      expect(args.at(-1)).toMatchObject({
        kind: 'program-source',
        format: axProgramSourceVersion,
      });
      return candidate;
    };

    const result = await optimizer.compile(
      program,
      [
        { question: 'q1', answer: 'optimized' },
        { question: 'q2', answer: 'optimized' },
      ],
      ({ prediction, example }) =>
        prediction.answer === example.answer ? 1 : 0,
      { maxMetricCalls: 10, skipPerfectScore: false }
    );

    expect(result.optimizedProgram?.componentMap?.[component.key]).toBe(
      candidate
    );
    program.applyOptimization(result.optimizedProgram!);
    await expect(
      program.forward({} as never, { question: 'q' })
    ).resolves.toEqual({ answer: 'optimized' });
  });

  it('rejects invalid source without replacing the bound program', () => {
    const program = programSource('question:string -> answer:string');
    const seed = program.getProgramSource();
    const component = program
      .getOptimizableComponents()
      .find((value) => value.kind === 'program-source')!;

    expect(component.validate?.('{broken')).toMatch(
      /Invalid program source JSON/
    );
    expect(() => program.setProgramSource('{broken')).toThrow(
      /Invalid program source JSON/
    );
    expect(program.getProgramSource()).toBe(seed);
  });

  it('rejects missing outputs at bind time and wrong output types at runtime', async () => {
    const program = programSource(
      'question:string -> answer:string, count:number'
    );
    expect(() =>
      program.setProgramSource(
        source([
          {
            op: 'return',
            outputs: { answer: literal('ok') },
          },
        ])
      )
    ).toThrow(/missing required output 'count'/);
    expect(() =>
      program.setProgramSource(
        source([
          {
            op: 'return',
            outputs: {
              answer: literal('ok'),
              count: literal(1),
              extra: literal('not declared'),
            },
          },
        ])
      )
    ).toThrow(/unknown output 'extra'/);

    const wrongType = programSource('question:string -> answer:string', {
      source: source([returnAnswer(literal(42))]),
    });
    await expect(
      wrongType.forward({} as never, { question: 'q' })
    ).rejects.toThrow(/Expected 'answer'.*string/i);
  });

  it('executes only explicitly declared tools and emits direct-tool traces', async () => {
    let calls = 0;
    const traces: unknown[] = [];
    const directToolSource = source(
      [
        {
          op: 'tool',
          name: 'echo',
          as: 'echoed',
          args: {
            op: 'object',
            entries: { value: ref('inputs.question') },
          },
        },
        returnAnswer(ref('echoed.answer')),
      ],
      ['tool:echo']
    );
    const program = programSource('question:string -> answer:string', {
      source: directToolSource,
      tools: [echoTool(() => calls++)],
    });

    await expect(
      program.forward(
        {} as never,
        { question: 'safe' },
        {
          onFunctionCall: (trace) => {
            traces.push(trace);
          },
        }
      )
    ).resolves.toEqual({ answer: 'safe' });
    expect(calls).toBe(1);
    expect(traces).toMatchObject([
      {
        fn: 'echo',
        args: { value: 'safe' },
        result: { answer: 'safe' },
        ok: true,
      },
    ]);

    expect(() =>
      program.setProgramSource(
        source([returnAnswer(literal('nope'))], ['tool:not_available'])
      )
    ).toThrow(/not allowed by the host/);
  });

  it('keeps optimizer source as inert data outside the runtime code string', async () => {
    const marker = "'); return globalThis.process?.env; //";
    let executedCode = '';
    let capturedGlobals: Record<string, unknown> | undefined;
    let sessions = 0;
    const runtime: AxCodeRuntime = {
      language: 'JavaScript',
      getUsageInstructions: () => '',
      createSession: (globals) => {
        sessions += 1;
        capturedGlobals = globals;
        return {
          execute: async (code) => {
            executedCode = code;
            return { answer: marker };
          },
          patchGlobals: async () => {},
          close: () => {},
        };
      },
    };
    const candidate = source([returnAnswer(literal(marker))]);
    const program = programSource('question:string -> answer:string', {
      source: candidate,
      runtime: compatibleRuntime(runtime),
    });

    await program.forward({} as never, { question: 'one' });
    await program.forward({} as never, { question: 'two' });

    expect(sessions).toBe(2);
    expect(executedCode).not.toContain(marker);
    expect(executedCode).not.toMatch(
      /\beval\s*\(|\bFunction\s*\(|\bimport\s*\(/
    );
    expect(
      JSON.stringify(capturedGlobals?.__axProgramSourceDocument)
    ).toContain(marker);
  });

  it('requires an explicit JavaScript program-source protocol for custom runtimes', () => {
    const runtime: AxCodeRuntime = {
      language: 'Python',
      getUsageInstructions: () => '',
      createSession: () => ({
        execute: async () => ({ answer: 'unsafe' }),
        patchGlobals: async () => {},
        close: () => {},
      }),
    };

    expect(() =>
      programSource('question:string -> answer:string', {
        runtime: compatibleRuntime(runtime),
      })
    ).toThrow(/language must be 'JavaScript'/);
    expect(() =>
      programSource('question:string -> answer:string', {
        runtime: {
          runtime: { ...runtime, language: 'JavaScript' },
          protocol: 'not-compatible',
        } as never,
      })
    ).toThrow(/Custom runtime protocol/);
  });

  it.each(['eval', 'import', 'filesystem', 'process', 'network'])(
    'rejects the unsupported %s source operation',
    (op) => {
      const program = programSource('question:string -> answer:string');
      expect(() =>
        program.setProgramSource(
          JSON.stringify({
            version: axProgramSourceVersion,
            capabilities: [],
            steps: [
              { op, as: 'escape' },
              { op: 'return', outputs: { answer: literal('nope') } },
            ],
          })
        )
      ).toThrow(/unsupported statement/);
    }
  );

  it('enforces predictor and tool-call budgets per invocation', async () => {
    const twoPredictors = source(
      [
        {
          op: 'predict',
          as: 'first',
          signature: '$program',
          input: ref('inputs'),
        },
        {
          op: 'predict',
          as: 'second',
          signature: '$program',
          input: ref('inputs'),
        },
        returnAnswer(ref('second.answer')),
      ],
      ['predict']
    );
    const predictorLimited = programSource('question:string -> answer:string', {
      source: twoPredictors,
      maxPredictorCalls: 1,
    });
    await expect(
      predictorLimited.forward(mockTextAI(), { question: 'q' })
    ).rejects.toBeInstanceOf(AxProgramSourceBudgetError);

    const twoTools = source(
      [
        {
          op: 'tool',
          name: 'echo',
          as: 'first',
          args: {
            op: 'object',
            entries: { value: ref('inputs.question') },
          },
        },
        {
          op: 'tool',
          name: 'echo',
          as: 'second',
          args: {
            op: 'object',
            entries: { value: ref('inputs.question') },
          },
        },
        returnAnswer(ref('second.answer')),
      ],
      ['tool:echo']
    );
    const toolLimited = programSource('question:string -> answer:string', {
      source: twoTools,
      tools: [echoTool()],
      maxToolCalls: 1,
    });
    await expect(
      toolLimited.forward({} as never, { question: 'q' })
    ).rejects.toBeInstanceOf(AxProgramSourceBudgetError);
  });

  it('fails closed on Unicode bytes, recursive depth, width, and cycles', async () => {
    const constant = source([returnAnswer(literal('ok'))]);
    const unicode = programSource('payload:string -> answer:string', {
      source: constant,
      valueLimits: { maxBytes: 20 },
    });
    await expect(
      unicode.forward({} as never, { payload: '😀😀😀' })
    ).rejects.toThrow(/serialized value byte limit: 20/);

    const deep = programSource('payload:json -> answer:string', {
      source: constant,
      valueLimits: { maxDepth: 2 },
    });
    await expect(
      deep.forward({} as never, { payload: { a: { b: { c: 'deep' } } } })
    ).rejects.toThrow(/value depth limit: 2/);

    const wide = programSource('payload:json -> answer:string', {
      source: constant,
      valueLimits: { maxWidth: 2 },
    });
    await expect(
      wide.forward({} as never, { payload: { a: 1, b: 2, c: 3 } })
    ).rejects.toThrow(/value width limit: 2/);

    const cyclicPayload: { self?: unknown } = {};
    cyclicPayload.self = cyclicPayload;
    await expect(
      programSource('payload:json -> answer:string', {
        source: constant,
      }).forward({} as never, { payload: cyclicPayload })
    ).rejects.toThrow(/cyclic value/);
  });

  it('bounds tool results and final outputs before crossing onward boundaries', async () => {
    const toolSource = source(
      [
        {
          op: 'tool',
          name: 'wide',
          as: 'result',
          args: { op: 'object', entries: {} },
        },
        returnAnswer(ref('result.answer')),
      ],
      ['tool:wide']
    );
    const wideTool: AxFunction = {
      name: 'wide',
      description: 'Return a deliberately wide result.',
      parameters: { type: 'object', properties: {} },
      returns: { type: 'object' },
      func: () => ({ answer: 'ok', extraA: 1, extraB: 2 }),
    };
    await expect(
      programSource('question:string -> answer:string', {
        source: toolSource,
        tools: [wideTool],
        valueLimits: { maxWidth: 2 },
      }).forward({} as never, { question: 'q' })
    ).rejects.toThrow(/tool 'wide' result exceeds value width limit: 2/);

    let argumentToolCalled = false;
    const argumentTool: AxFunction = {
      name: 'boundedArguments',
      description: 'Must not receive an oversized argument graph.',
      parameters: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'string' } } },
        required: ['values'],
      },
      returns: { type: 'object' },
      func: () => {
        argumentToolCalled = true;
        return { answer: 'unexpected' };
      },
    };
    const argumentSource = source(
      [
        {
          op: 'tool',
          name: 'boundedArguments',
          as: 'result',
          args: {
            op: 'object',
            entries: {
              values: {
                op: 'array',
                items: [literal('a'), literal('b'), literal('c')],
              },
            },
          },
        },
        returnAnswer(ref('result.answer')),
      ],
      ['tool:boundedArguments']
    );
    await expect(
      programSource('question:string -> answer:string', {
        source: argumentSource,
        tools: [argumentTool],
        valueLimits: { maxWidth: 2 },
      }).forward({} as never, { question: 'q' })
    ).rejects.toThrow(/tool 'boundedArguments' arguments exceeds value width/);
    expect(argumentToolCalled).toBe(false);

    const wideOutput = programSource('question:string -> answer:string', {
      source: source([returnAnswer(literal('😀😀😀'))]),
      valueLimits: { maxBytes: 20 },
    });
    await expect(
      wideOutput.forward({} as never, { question: 'q' })
    ).rejects.toThrow(
      /Program source output exceeds serialized value byte limit: 20/
    );
  });

  it('revokes timed-out bridge epochs and records a late host-tool completion', async () => {
    await programSource('question:string -> answer:string', {
      source: source([returnAnswer(literal('warm'))]),
      timeoutMs: 1_000,
    }).forward({} as never, { question: 'warm' });

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    let externalEffectAt = 0;
    const delayedTool: AxFunction = {
      name: 'delayed',
      description: 'Completes after the program-source session times out.',
      parameters: { type: 'object', properties: {} },
      returns: { type: 'object' },
      func: async (_args, extra) => {
        observedSignal = extra?.abortSignal;
        markStarted();
        await new Promise((resolve) => setTimeout(resolve, 400));
        externalEffectAt = Date.now();
        return { answer: 'late' };
      },
    };
    const delayedSource = source(
      [
        {
          op: 'tool',
          name: 'delayed',
          as: 'result',
          args: { op: 'object', entries: {} },
        },
        returnAnswer(ref('result.answer')),
      ],
      ['tool:delayed']
    );
    const program = programSource('question:string -> answer:string', {
      source: delayedSource,
      tools: [delayedTool],
      timeoutMs: 250,
    });
    const pending = program.forward({} as never, { question: 'q' });
    await Promise.race([
      started,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('tool did not start')), 1_000)
      ),
    ]);
    await expect(pending).rejects.toBeInstanceOf(
      AxProgramSourceSessionExpiredError
    );
    const timeoutObservedAt = Date.now();
    expect(observedSignal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(externalEffectAt).toBeGreaterThanOrEqual(timeoutObservedAt);
    expect(program.getLateBridgeEvents()).toMatchObject([
      {
        kind: 'tool',
        name: 'delayed',
        phase: 'completion',
        reason: 'timed out after 250ms',
      },
    ]);
  });

  it('enforces bounded loop execution', async () => {
    const loopSource = source([
      {
        op: 'forEach',
        items: ref('inputs.items'),
        item: 'item',
        result: 'copied',
        maxIterations: 3,
        body: [],
        collect: ref('item'),
      },
      {
        op: 'return',
        outputs: { collectedItems: ref('copied') },
      },
    ]);
    const program = programSource('items:string[] -> collectedItems:string[]', {
      source: loopSource,
      maxIterations: 3,
    });

    await expect(
      program.forward({} as never, { items: ['a', 'b'] })
    ).rejects.toThrow(/iteration budget exceeded: 3/);
  });

  it('serializes and reloads source while requiring runtime capabilities again', async () => {
    const optimized = source([returnAnswer(literal('restored'))]);
    const original = programSource('question:string -> answer:string', {
      source: optimized,
    });
    const serialized = JSON.parse(JSON.stringify(original.dumpState()));
    const restored = programSource('question:string -> answer:string');

    restored.loadState(serialized);

    expect(restored.getProgramSource()).toBe(optimized);
    await expect(
      restored.forward({} as never, { question: 'q' })
    ).resolves.toEqual({ answer: 'restored' });
  });

  it('preserves ordinary instruction components in a mixed program tree', () => {
    const parent = programSource('question:string -> answer:string', {
      source: source([returnAnswer(literal('parent'))]),
    });
    const child = new AxGen<{ inputText: string }, { categoryLabel: string }>(
      'inputText:string -> categoryLabel:string'
    );
    child.setInstruction('before');
    parent.register(child as never, 'classifier');

    const components = parent.getOptimizableComponents();
    expect(components.map((component) => component.kind)).toEqual([
      'program-source',
      'instruction',
    ]);

    parent.applyOptimizedComponents({
      'root::program-source': source([returnAnswer(literal('after'))]),
      'root.classifier::instruction': 'after instruction',
    });
    expect(child.getInstruction()).toBe('after instruction');
    expect(parent.getProgramSource()).toContain('after');
  });

  it('binds source before mutating other components in a mixed update', () => {
    const parent = programSource('question:string -> answer:string');
    const child = new AxGen<{ inputText: string }, { categoryLabel: string }>(
      'inputText:string -> categoryLabel:string'
    );
    child.setInstruction('before');
    parent.register(child as never, 'classifier');

    expect(() =>
      parent.applyOptimizedComponents({
        'root::program-source': '{broken',
        'root.classifier::instruction': 'must not apply',
      })
    ).toThrow(/Invalid program source JSON/);
    expect(child.getInstruction()).toBe('before');
  });

  it('honors abort before creating runtime authority', async () => {
    let sessions = 0;
    const runtime: AxCodeRuntime = {
      language: 'JavaScript',
      getUsageInstructions: () => '',
      createSession: () => {
        sessions += 1;
        throw new Error('must not create a session');
      },
    };
    const program = programSource('question:string -> answer:string', {
      source: source([returnAnswer(literal('never'))]),
      runtime: compatibleRuntime(runtime),
    });
    const controller = new AbortController();
    controller.abort('test stop');

    await expect(
      program.forward(
        {} as never,
        { question: 'q' },
        {
          abortSignal: controller.signal,
        }
      )
    ).rejects.toThrow('Aborted: test stop');
    expect(sessions).toBe(0);
  });
});
