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
  type AxProgramSourceStatement,
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
      runtime,
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
      runtime,
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
