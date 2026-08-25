import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxChatRequest, AxChatResponse, AxFunction } from '../ai/types.js';
import type { AxMCPClient } from '../mcp/client.js';
import { AxMCPExecutionContext } from '../mcp/execution.js';
import {
  axReactCanonicalJSON,
  axReactSerializeHistory,
  react,
} from './react.js';
import { f } from './sig.js';

const nativeTurn = (
  calls: { id?: string; name: string; args?: unknown }[],
  content?: string
): AxChatResponse => ({
  results: [
    {
      index: 0,
      ...(content ? { content } : {}),
      functionCalls: calls.map((call, index) => ({
        id: call.id ?? `provider-${index}`,
        type: 'function' as const,
        function: { name: call.name, params: call.args ?? {} },
      })),
    },
  ],
});

const promptTurn = (
  calls: { name: string; arguments?: unknown }[],
  thought?: string
): AxChatResponse => ({
  results: [
    {
      index: 0,
      content: JSON.stringify({
        ...(thought ? { thought } : {}),
        calls: calls.map((call) => ({
          name: call.name,
          arguments: call.arguments ?? {},
        })),
      }),
    },
  ],
});

const tool = (
  name: string,
  func: AxFunction['func'],
  options: Partial<AxFunction> = {}
): AxFunction => ({
  name,
  description: `Run ${name}`,
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number', description: 'Input value' },
    },
    required: ['value'],
    additionalProperties: false,
  },
  func,
  ...options,
});

describe('react', () => {
  it('uses native tools and derives a typed submit tool from outputs', async () => {
    const requests: AxChatRequest<unknown>[] = [];
    const lookup = vi.fn(async ({ value }: { value: number }) => ({ value }));
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        turn++;
        return turn === 1
          ? nativeTurn([{ name: 'lookup', args: { value: '7' } }])
          : nativeTurn([
              { name: 'submit', args: { answer: 'seven', score: '7' } },
            ]);
      },
    });

    const result = await react(
      'question:string -> answer:string, score:number',
      { functions: [tool('lookup', lookup)] }
    ).forward(ai, { question: 'What is the value?' });

    expect(result).toMatchObject({
      success: true,
      output: { answer: 'seven', score: 7 },
      terminationReason: 'submit',
    });
    expect(lookup).toHaveBeenCalledWith({ value: 7 });
    expect(requests[0]?.functions?.map((fn) => fn.name)).toEqual([
      'lookup',
      'submit',
    ]);
    expect(requests[0]?.functions?.at(-1)?.parameters).toMatchObject({
      type: 'object',
      required: ['answer', 'score'],
      additionalProperties: false,
    });
    expect(requests[0]?.functionCall).toBe('auto');
    const system = requests[0]?.chatPrompt[0];
    expect(system?.role).toBe('system');
    expect(system && 'content' in system ? system.content : '').not.toContain(
      'Return exactly one JSON object'
    );
    expect(requests[1]?.chatPrompt.at(-1)).toMatchObject({
      role: 'function',
      functionId: 'provider-0',
      cache: true,
    });
    const replayedCall = requests[1]?.chatPrompt.find(
      (message) => message.role === 'assistant'
    );
    expect(
      replayedCall?.role === 'assistant'
        ? replayedCall.functionCalls?.[0]?.id
        : undefined
    ).toBe('provider-0');
    const storedCall = result.history.events.find(
      (event) => event.role === 'assistant'
    );
    expect(
      storedCall?.role === 'assistant' ? storedCall.calls[0] : {}
    ).toMatchObject({
      id: expect.stringMatching(/^axr_[a-f0-9]{32}$/),
      providerId: 'provider-0',
    });
  });

  it('falls back to a strict prompt protocol for text-only providers', async () => {
    const requests: AxChatRequest<unknown>[] = [];
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: false },
      chatResponse: async (request) => {
        requests.push(request);
        turn++;
        return turn === 1
          ? promptTurn([{ name: 'lookup', arguments: { value: 2 } }])
          : promptTurn([{ name: 'submit', arguments: { answer: 'done' } }]);
      },
    });

    const result = await react('question:string -> answer:string', {
      functions: [
        tool('lookup', async ({ value }: { value: number }) => value),
      ],
    }).forward(ai, { question: 'Use the text protocol' });

    expect(result).toMatchObject({ success: true, output: { answer: 'done' } });
    expect(requests.every((request) => request.functions === undefined)).toBe(
      true
    );
    expect(
      requests.every((request) => request.functionCall === undefined)
    ).toBe(true);
    const system = requests[0]?.chatPrompt[0];
    expect(system && 'content' in system ? system.content : '').toContain(
      'Return exactly one JSON object'
    );
    expect(requests[1]?.chatPrompt.at(-1)).toMatchObject({
      role: 'user',
      cache: true,
    });
    expect(result.history.events[0]).toMatchObject({
      role: 'assistant',
      calls: [{ name: 'lookup' }],
    });
  });

  it('fails closed when the prompt protocol uses an invalid thought type', async () => {
    const ai = new AxMockAIService({
      features: { functions: false },
      chatResponse: async () => ({
        results: [
          {
            index: 0,
            content: JSON.stringify({ thought: 42, calls: [] }),
          },
        ],
      }),
    });

    const result = await react('question:string -> answer:string').forward(ai, {
      question: 'Use strict JSON',
    });

    expect(result).toMatchObject({
      success: false,
      output: { answer: null },
      terminationReason: 'protocol_error',
      error: { code: 'invalid_model_turn' },
    });
  });

  it('awaits async tools and validates their declared result schemas', async () => {
    let resolved = false;
    let turn = 0;
    const requests: AxChatRequest<unknown>[] = [];
    const delayed = tool(
      'delayed',
      async ({ value }: { value: number }) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        resolved = true;
        return String(value + 1);
      },
      { returns: { type: 'number' } }
    );
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        turn++;
        if (turn === 1) {
          return nativeTurn([{ name: 'delayed', args: { value: 4 } }]);
        }
        expect(resolved).toBe(true);
        const resultMessage = request.chatPrompt.find(
          (message) => message.role === 'function'
        );
        expect(resultMessage).toMatchObject({ result: '5', isError: false });
        return nativeTurn([{ name: 'submit', args: { answer: 'validated' } }]);
      },
    });

    const result = await react('question:string -> answer:string', {
      functions: [delayed],
    }).forward(ai, { question: 'Wait for the result' });

    expect(result.success).toBe(true);
  });

  it('executes multiple calls with bounded parallelism and stable result order', async () => {
    let active = 0;
    let peak = 0;
    const work = tool('work', async ({ value }: { value: number }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (4 - value) * 5));
      active--;
      return { value };
    });
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        turn++;
        if (turn === 1) {
          return nativeTurn([
            { id: 'same', name: 'work', args: { value: 1 } },
            { id: 'same', name: 'work', args: { value: 2 } },
            { id: 'same', name: 'work', args: { value: 3 } },
          ]);
        }
        const results = request.chatPrompt.filter(
          (message) => message.role === 'function'
        );
        const replayedCalls = request.chatPrompt.flatMap((message) =>
          message.role === 'assistant' ? (message.functionCalls ?? []) : []
        );
        expect(results.map((message) => message.result)).toEqual([
          '{"value":1}',
          '{"value":2}',
          '{"value":3}',
        ]);
        expect(replayedCalls[0]?.id).toBe('same');
        expect(new Set(replayedCalls.map((call) => call.id)).size).toBe(3);
        expect(results.map((message) => message.functionId)).toEqual(
          replayedCalls.map((call) => call.id)
        );
        return nativeTurn([{ name: 'submit', args: { answer: 'ordered' } }]);
      },
    });

    const result = await react('question:string -> answer:string', {
      functions: [work],
      maxParallelTools: 2,
    }).forward(ai, { question: 'Run all work' });

    expect(result.success).toBe(true);
    expect(peak).toBe(2);
    const ids = result.history.events
      .filter((event) => event.role === 'tool')
      .map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('axr_'))).toBe(true);
  });

  it('records tool failures as observations and permits recovery', async () => {
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        turn++;
        if (turn === 1) {
          return nativeTurn([{ name: 'explode', args: { value: 1 } }]);
        }
        if (turn === 2) {
          const failure = request.chatPrompt.find(
            (message) => message.role === 'function'
          );
          expect(failure).toMatchObject({ isError: true });
          expect(
            failure && 'result' in failure ? failure.result : ''
          ).toContain('tool_error');
          expect(
            failure && 'result' in failure ? failure.result : ''
          ).not.toContain('secret stack detail');
          return nativeTurn([{ name: 'lookup', args: { value: 2 } }]);
        }
        return nativeTurn([{ name: 'submit', args: { answer: 'recovered' } }]);
      },
    });

    const result = await react('question:string -> answer:string', {
      functions: [
        tool('explode', async () => {
          throw new Error('secret stack detail');
        }),
        tool('lookup', async ({ value }: { value: number }) => value),
      ],
    }).forward(ai, { question: 'Recover from an error' });

    expect(result).toMatchObject({
      success: true,
      output: { answer: 'recovered' },
    });
  });

  it('executes attached MCP tools and validates structured content', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'forty two' }],
      structuredContent: { value: '42' },
    }));
    const client = {
      getNamespace: () => 'test-mcp',
      getTools: () => [
        {
          name: 'mcp_lookup',
          description: 'Read a value over MCP',
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'number', description: 'Value to read' },
            },
            required: ['value'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: {
              value: { type: 'number', description: 'Read value' },
            },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
      callTool,
    } as unknown as AxMCPClient;
    const context = new AxMCPExecutionContext(client);
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        turn++;
        if (turn === 1) {
          expect(request.functions?.map((fn) => fn.name)).toContain(
            'mcp_lookup'
          );
          return nativeTurn([{ name: 'mcp_lookup', args: { value: '42' } }]);
        }
        const result = request.chatPrompt.find(
          (message) => message.role === 'function'
        );
        expect(result).toMatchObject({
          result: '{"value":42}',
          isError: false,
        });
        return nativeTurn([{ name: 'submit', args: { answer: 'mcp' } }]);
      },
    });

    const result = await react('question:string -> answer:string').forward(
      ai,
      { question: 'Use MCP' },
      { _mcpExecutionContext: context }
    );

    expect(result.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith(
      'mcp_lookup',
      { value: 42 },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('executes no tools for mixed submit or oversized call batches', async () => {
    const execute = vi.fn(async ({ value }: { value: number }) => value);
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () => {
        turn++;
        if (turn === 1) {
          return nativeTurn([
            { name: 'lookup', args: { value: 1 } },
            { name: 'submit', args: { answer: 'mixed' } },
          ]);
        }
        if (turn === 2) {
          return nativeTurn([
            { name: 'lookup', args: { value: 2 } },
            { name: 'lookup', args: { value: 3 } },
          ]);
        }
        return nativeTurn([{ name: 'submit', args: { answer: 'clean' } }]);
      },
    });

    const result = await react('question:string -> answer:string', {
      functions: [tool('lookup', execute)],
      maxToolCallsPerIteration: 1,
      maxIterations: 3,
    }).forward(ai, { question: 'Reject unsafe batches' });

    expect(result.success).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const errors = result.history.events
      .filter((event) => event.role === 'tool' && event.isError)
      .map((event) => event.result);
    expect(
      errors.some((value) => value.includes('submit_must_be_only_call'))
    ).toBe(true);
    expect(errors.some((value) => value.includes('too_many_tool_calls'))).toBe(
      true
    );
  });

  it('rejects protocol metadata in submit arguments without leaking it', async () => {
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        turn++;
        if (turn === 1) {
          return nativeTurn([
            {
              name: 'submit',
              args: { answer: 'bad', __tool_call__: 'submit' },
            },
          ]);
        }
        const invalid = request.chatPrompt.find(
          (message) => message.role === 'function'
        );
        expect(invalid).toMatchObject({ isError: true });
        return nativeTurn([{ name: 'submit', args: { answer: 'clean' } }]);
      },
    });

    const result = await react('question:string -> answer:string').forward(ai, {
      question: 'Submit cleanly',
    });

    expect(result).toMatchObject({
      success: true,
      output: { answer: 'clean' },
    });
    expect(result.success && Object.keys(result.output)).toEqual(['answer']);
  });

  it('applies Standard Schema transforms to inputs and submitted outputs', async () => {
    const requests: AxChatRequest<unknown>[] = [];
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        return nativeTurn([{ name: 'submit', args: { answer: 'done' } }]);
      },
    });
    const signature = f()
      .input(
        'question',
        z.string().transform((value) => value.trim())
      )
      .output(
        'answer',
        z.string().transform((value) => value.toUpperCase())
      )
      .build();

    const result = await react(signature).forward(ai, { question: '  task  ' });

    expect(result).toMatchObject({
      success: true,
      output: { answer: 'DONE' },
    });
    expect(requests[0]?.chatPrompt).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: 'Inputs (canonical JSON):\n{"question":"task"}',
      })
    );
  });

  it('forces exactly one submit-only attempt after iteration exhaustion', async () => {
    const requests: AxChatRequest<unknown>[] = [];
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        turn++;
        return turn === 1
          ? nativeTurn([], 'Still reasoning')
          : nativeTurn([{ name: 'submit', args: { answer: 'best effort' } }]);
      },
    });

    const result = await react('question:string -> answer:string', {
      maxIterations: 1,
    }).forward(ai, { question: 'Use the budget' });

    expect(result).toMatchObject({
      success: true,
      output: { answer: 'best effort' },
      terminationReason: 'forced_submit',
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.functions?.map((fn) => fn.name)).toEqual(['submit']);
    expect(requests[1]?.functionCall).toEqual({
      type: 'function',
      function: { name: 'submit' },
    });
  });

  it('preserves all output keys on forced-submit validation failure', async () => {
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () => {
        turn++;
        return turn === 1
          ? nativeTurn([])
          : nativeTurn([{ name: 'submit', args: { answer: 'missing score' } }]);
      },
    });

    const result = await react(
      'question:string -> answer:string, score:number',
      { maxIterations: 1 }
    ).forward(ai, { question: 'Fail completely' });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        output: { answer: null, score: null },
        terminationReason: 'forced_submit_failed',
      })
    );
  });

  it('returns structured exhaustion failure when forced submit is absent', async () => {
    const ai = new AxMockAIService({
      features: { functions: false },
      chatResponse: async () => promptTurn([]),
    });
    const result = await react('question:string -> answer:string', {
      maxIterations: 1,
    }).forward(ai, { question: 'Never submit' });

    expect(result).toMatchObject({
      success: false,
      output: { answer: null },
      terminationReason: 'forced_submit_failed',
      error: { code: 'forced_submit_failed' },
    });
  });

  it('reports abort consistently during the forced submit turn', async () => {
    const controller = new AbortController();
    let turn = 0;
    let forcedStarted = false;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () => {
        turn++;
        if (turn === 1) return nativeTurn([]);
        forcedStarted = true;
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled forced turn')),
            { once: true }
          );
        });
        return nativeTurn([]);
      },
    });
    const pending = react('question:string -> answer:string', {
      maxIterations: 1,
    }).forward(
      ai,
      { question: 'Abort forced submit' },
      { abortSignal: controller.signal }
    );

    await vi.waitFor(() => expect(forcedStarted).toBe(true));
    controller.abort('test abort');
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      output: { answer: null },
      terminationReason: 'aborted',
      error: { code: 'aborted' },
    });
  });

  it('resumes without mutating prior history or reusing call IDs', async () => {
    let firstTurn = 0;
    const firstAI = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () => {
        firstTurn++;
        return firstTurn === 1
          ? nativeTurn([{ name: 'lookup', args: { value: 1 } }])
          : nativeTurn([]);
      },
    });
    const program = react('question:string -> answer:string', {
      functions: [
        tool('lookup', async ({ value }: { value: number }) => value),
      ],
      replayProfile: 'mock-native:v1',
      maxIterations: 1,
    });
    const first = await program.forward(firstAI, { question: 'Resume me' });
    const snapshot = axReactSerializeHistory(first.history);
    const priorIds = first.history.events
      .filter((event) => event.role === 'tool')
      .map((event) => event.id);

    const secondAI = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () =>
        nativeTurn([{ name: 'submit', args: { answer: 'resumed' } }]),
    });
    const second = await program.forward(
      secondAI,
      { question: 'Resume me' },
      { history: first.history }
    );

    expect(second).toMatchObject({
      success: true,
      output: { answer: 'resumed' },
    });
    expect(axReactSerializeHistory(first.history)).toBe(snapshot);
    const allIds = second.history.events
      .filter((event) => event.role === 'tool')
      .map((event) => event.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toEqual(expect.arrayContaining(priorIds));

    const fork = await program.forward(
      secondAI,
      { question: 'Resume me' },
      { history: first.history }
    );
    const secondNewIds = allIds.filter((id) => !priorIds.includes(id));
    const forkIds = fork.history.events
      .filter((event) => event.role === 'tool')
      .map((event) => event.id)
      .filter((id) => !priorIds.includes(id));
    expect(secondNewIds).toHaveLength(1);
    expect(forkIds).toHaveLength(1);
    expect(forkIds[0]).not.toBe(secondNewIds[0]);
  });

  it('binds resume to the executable catalog and host authority', async () => {
    const privilegedLookup = tool(
      'privilegedLookup',
      async ({ value }: { value: number }) => ({ value })
    );
    let firstTurn = 0;
    const firstAI = new AxMockAIService({
      name: 'native-provider',
      features: { functions: true },
      chatResponse: async () => {
        firstTurn++;
        return firstTurn === 1
          ? nativeTurn([{ name: 'privilegedLookup', args: { value: 7 } }])
          : nativeTurn([]);
      },
    });
    const first = await react('question:string -> answer:string', {
      functions: [privilegedLookup],
      historyAuthority: 'tenant-a:privileged:v1',
      replayProfile: 'native-provider:deployment-a:default-model-a:v1',
      maxIterations: 1,
    }).forward(firstAI, { question: 'Authorized resume' });
    expect(first.success).toBe(false);

    const resumeAI = new AxMockAIService({
      name: 'native-provider',
      features: { functions: true },
      chatResponse: async () =>
        nativeTurn([{ name: 'submit', args: { answer: 'resumed' } }]),
    });
    const recreated = react('question:string -> answer:string', {
      functions: [
        tool('privilegedLookup', async ({ value }: { value: number }) => ({
          value,
        })),
      ],
      historyAuthority: 'tenant-a:privileged:v1',
      replayProfile: 'native-provider:deployment-a:default-model-a:v1',
    });
    await expect(
      recreated.forward(
        resumeAI,
        { question: 'Authorized resume' },
        { history: first.history }
      )
    ).resolves.toMatchObject({ success: true, output: { answer: 'resumed' } });

    const noTools = react('question:string -> answer:string', {
      historyAuthority: 'tenant-a:privileged:v1',
      replayProfile: 'native-provider:deployment-a:default-model-a:v1',
    });
    await expect(
      noTools.forward(
        resumeAI,
        { question: 'Authorized resume' },
        { history: first.history }
      )
    ).rejects.toThrow('current executable tool catalog');

    const changedSchema = react('question:string -> answer:string', {
      functions: [
        tool('privilegedLookup', async () => 'changed', {
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Changed input' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        }),
      ],
      historyAuthority: 'tenant-a:privileged:v1',
      replayProfile: 'native-provider:deployment-a:default-model-a:v1',
    });
    await expect(
      changedSchema.forward(
        resumeAI,
        { question: 'Authorized resume' },
        { history: first.history }
      )
    ).rejects.toThrow('current executable tool catalog');

    await expect(
      recreated.forward(
        resumeAI,
        { question: 'Authorized resume' },
        {
          history: first.history,
          historyAuthority: 'tenant-a:privileged:v2',
        }
      )
    ).rejects.toThrow('current host authority/version');

    const changedProvider = new AxMockAIService({
      name: 'other-native-provider',
      features: { functions: true },
      chatResponse: async () =>
        nativeTurn([{ name: 'submit', args: { answer: 'alias resumed' } }]),
    });
    await expect(
      recreated.forward(
        changedProvider,
        { question: 'Authorized resume' },
        { history: first.history }
      )
    ).resolves.toMatchObject({
      success: true,
      output: { answer: 'alias resumed' },
    });

    const changedProtocol = react('question:string -> answer:string', {
      functions: [privilegedLookup],
      historyAuthority: 'tenant-a:privileged:v1',
      replayProfile: 'native-provider:deployment-a:default-model-b:v2',
    });
    await expect(
      changedProtocol.forward(
        resumeAI,
        { question: 'Authorized resume' },
        { history: first.history }
      )
    ).rejects.toThrow('current native replay profile/protocol');
  });

  it('binds native replay to request config and service-object identity', async () => {
    let turns = 0;
    const ai = new AxMockAIService({
      id: 'shared-provider-id',
      name: 'same-provider-name',
      features: { functions: true },
      chatResponse: async () => {
        turns++;
        return turns === 1
          ? nativeTurn([{ name: 'lookup', args: { value: 1 } }])
          : nativeTurn([]);
      },
    });
    const program = react('question:string -> answer:string', {
      functions: [
        tool('lookup', async ({ value }: { value: number }) => value),
      ],
      maxIterations: 1,
    });
    const first = await program.forward(
      ai,
      { question: 'Replay profile binding' },
      { modelConfig: { temperature: 0 } }
    );
    expect(first.success).toBe(false);

    await expect(
      program.forward(
        ai,
        { question: 'Replay profile binding' },
        { history: first.history, modelConfig: { temperature: 0.5 } }
      )
    ).rejects.toThrow('current native replay profile/protocol');

    const differentAdapter = new AxMockAIService({
      id: 'shared-provider-id',
      name: 'same-provider-name',
      features: { functions: true },
      chatResponse: async () =>
        nativeTurn([{ name: 'submit', args: { answer: 'not replayed' } }]),
    });
    await expect(
      program.forward(
        differentAdapter,
        { question: 'Replay profile binding' },
        { history: first.history, modelConfig: { temperature: 0 } }
      )
    ).rejects.toThrow('current native replay profile/protocol');
  });

  it('rejects lossy or effectful native replay config before chat', async () => {
    const chat = vi.fn(async () =>
      nativeTurn([{ name: 'submit', args: { answer: 'accepted' } }])
    );
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: chat,
    });
    const program = react('question:string -> answer:string');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const shared = { value: 1 };
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'temperature', {
      enumerable: true,
      get: () => {
        getterCalls++;
        return 0;
      },
    });
    const sparse = new Array(1);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 34; depth++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const invalidConfigs: unknown[] = [
      circular,
      { value: new Map([['x', 1]]) },
      { value: new Set([1]) },
      { value: /x/ },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: -0 },
      { left: shared, right: shared },
      { value: undefined },
      { value: { toJSON: () => 'hidden' } },
      { value: sparse },
      accessor,
      deep,
      { value: 'x'.repeat(64_001) },
    ];

    for (const modelConfig of invalidConfigs) {
      await expect(
        program.forward(
          ai,
          { question: 'Reject lossy config' },
          { modelConfig: modelConfig as never }
        )
      ).rejects.toThrow(/Native ReAct (modelConfig|replay profile)/);
    }
    expect(getterCalls).toBe(0);
    expect(chat).not.toHaveBeenCalled();

    await expect(
      program.forward(
        ai,
        { question: 'Accept literal collision marker' },
        { modelConfig: { stopSequences: ['[Circular]'] } }
      )
    ).resolves.toMatchObject({
      success: true,
      output: { answer: 'accepted' },
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].modelConfig).toEqual({
      stopSequences: ['[Circular]'],
      stream: false,
      n: 1,
    });
  });

  it('keeps concurrent native replay binding call-scoped', async () => {
    const ai = new AxMockAIService<string>({
      features: { functions: true },
      chatResponse: async (request) => {
        const input = request.chatPrompt.find(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('Inputs')
        );
        const question =
          input?.role === 'user' && typeof input.content === 'string'
            ? input.content
            : '';
        await new Promise((resolve) =>
          setTimeout(resolve, question.includes('run-a') ? 15 : 1)
        );
        return nativeTurn([
          {
            name: 'submit',
            args: { answer: question.includes('run-a') ? 'a' : 'b' },
          },
        ]);
      },
    });
    const lastModel = vi
      .spyOn(ai, 'getLastUsedChatModel')
      .mockImplementation(() => {
        throw new Error('shared last-used model must not be read');
      });
    const lastConfig = vi
      .spyOn(ai, 'getLastUsedModelConfig')
      .mockImplementation(() => {
        throw new Error('shared last-used config must not be read');
      });
    const program = react('question:string -> answer:string');
    const [firstA, firstB] = await Promise.all([
      program.forward(
        ai,
        { question: 'run-a' },
        { model: 'model-a', modelConfig: { temperature: 0 } }
      ),
      program.forward(
        ai,
        { question: 'run-b' },
        { model: 'model-b', modelConfig: { temperature: 1 } }
      ),
    ]);
    expect(firstA).toMatchObject({ success: true, output: { answer: 'a' } });
    expect(firstB).toMatchObject({ success: true, output: { answer: 'b' } });

    const [resumedA, resumedB] = await Promise.all([
      program.forward(
        ai,
        { question: 'run-a' },
        {
          history: firstA.history,
          model: 'model-a',
          modelConfig: { temperature: 0 },
        }
      ),
      program.forward(
        ai,
        { question: 'run-b' },
        {
          history: firstB.history,
          model: 'model-b',
          modelConfig: { temperature: 1 },
        }
      ),
    ]);
    expect(resumedA).toMatchObject({ success: true, output: { answer: 'a' } });
    expect(resumedB).toMatchObject({ success: true, output: { answer: 'b' } });
    expect(lastModel).not.toHaveBeenCalled();
    expect(lastConfig).not.toHaveBeenCalled();
  });

  it('accepts canonical semantic history edits as caller-owned input', async () => {
    let firstTurn = 0;
    const requests: AxChatRequest<unknown>[] = [];
    const ai = new AxMockAIService({
      name: 'native-provider',
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        firstTurn++;
        if (firstTurn === 1) {
          return nativeTurn(
            [{ name: 'lookup', args: { value: 1 } }],
            'original assistant text'
          );
        }
        if (firstTurn === 2) return nativeTurn([]);
        return nativeTurn([
          { name: 'submit', args: { answer: 'caller-authorized resume' } },
        ]);
      },
    });
    const program = react('question:string -> answer:string', {
      functions: [
        tool('lookup', async ({ value }: { value: number }) => ({ value })),
      ],
      maxIterations: 1,
    });
    const first = await program.forward(ai, { question: 'Semantic integrity' });
    const edited = structuredClone(first.history);
    const assistant = edited.events[0];
    const result = edited.events[1];
    if (assistant?.role !== 'assistant' || result?.role !== 'tool') {
      throw new Error('expected one complete tool group');
    }
    assistant.content = 'caller-edited assistant text';
    assistant.calls[0]!.arguments = '{"value":99}';
    result.result = '{"value":999}';

    await expect(
      program.forward(
        ai,
        { question: 'Semantic integrity' },
        { history: edited }
      )
    ).resolves.toMatchObject({
      success: true,
      output: { answer: 'caller-authorized resume' },
    });
    const replay = requests.at(-1)?.chatPrompt ?? [];
    expect(replay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'caller-edited assistant text',
        }),
        expect.objectContaining({
          role: 'function',
          result: '{"value":999}',
        }),
      ])
    );
  });

  it('serializes arguments, results, and history canonically', async () => {
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: false },
      chatResponse: async () => {
        turn++;
        return turn === 1
          ? promptTurn([
              { name: 'echo', arguments: { zed: 1, alpha: { y: 2, x: 1 } } },
            ])
          : promptTurn([{ name: 'submit', arguments: { answer: 'stable' } }]);
      },
    });
    const echo: AxFunction = {
      name: 'echo',
      description: 'Echo an object',
      parameters: { type: 'object', additionalProperties: true },
      func: async () => ({ zed: 2, alpha: 1 }),
    };
    const result = await react('question:string -> answer:string', {
      functions: [echo],
    }).forward(ai, { question: 'Canonicalize' });

    const firstAssistant = result.history.events[0];
    const firstTool = result.history.events[1];
    expect(firstAssistant?.role).toBe('assistant');
    expect(
      firstAssistant?.role === 'assistant'
        ? firstAssistant.calls[0]?.arguments
        : undefined
    ).toBe('{"alpha":{"x":1,"y":2},"zed":1}');
    expect(firstTool?.role === 'tool' ? firstTool.result : undefined).toBe(
      '{"alpha":1,"zed":2}'
    );
    expect(axReactSerializeHistory(result.history)).toBe(
      axReactSerializeHistory(structuredClone(result.history))
    );
    expect(axReactCanonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const unsafe = JSON.parse(
      '{"__proto__":{"polluted":true},"safe":1}'
    ) as Record<string, unknown>;
    expect(axReactCanonicalJSON(unsafe)).toBe(
      '{"__proto__":{"polluted":true},"safe":1}'
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('aborts tools cooperatively without committing incomplete groups', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const blocking = tool(
      'blocking',
      async (_args: unknown, options: { abortSignal?: AbortSignal }) => {
        receivedSignal = options.abortSignal;
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true }
          );
        });
      }
    );
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () =>
        nativeTurn([{ name: 'blocking', args: { value: 1 } }]),
    });
    const promise = react('question:string -> answer:string', {
      functions: [blocking],
    }).forward(ai, { question: 'Abort' }, { abortSignal: controller.signal });

    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    controller.abort('test abort');
    const result = await promise;

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      success: false,
      output: { answer: null },
      terminationReason: 'aborted',
    });
    expect(result.history.events).toEqual([]);
  });

  it('compacts replay by complete assistant/tool groups', async () => {
    const requests: AxChatRequest<unknown>[] = [];
    let turn = 0;
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        turn++;
        if (turn <= 3) {
          return nativeTurn([{ name: 'lookup', args: { value: turn } }]);
        }
        return nativeTurn([{ name: 'submit', args: {} }]);
      },
    });
    const program = react('question:string -> answer:string', {
      functions: [
        tool('lookup', async ({ value }: { value: number }) => ({ value })),
      ],
      replayProfile: 'mock-native:compaction:v1',
      maxIterations: 3,
      maxPromptHistoryGroups: 1,
    });
    const first = await program.forward(ai, { question: 'Compact' });
    expect(first.success).toBe(false);

    const resumeAI = new AxMockAIService({
      features: { functions: true },
      chatResponse: async (request) => {
        requests.push(request);
        return nativeTurn([{ name: 'submit', args: { answer: 'resumed' } }]);
      },
    });
    await program.forward(
      resumeAI,
      { question: 'Compact' },
      { history: first.history }
    );

    const replay = requests.at(-1)?.chatPrompt ?? [];
    expect(
      replay.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('ReAct context compacted')
      )
    ).toBe(true);
    const replayCalls = replay.flatMap((message) =>
      message.role === 'assistant' ? (message.functionCalls ?? []) : []
    );
    const replayResults = replay.filter(
      (message) => message.role === 'function'
    );
    expect(replayCalls).toHaveLength(1);
    expect(replayResults).toHaveLength(1);
    expect(replayResults[0]).toMatchObject({ functionId: replayCalls[0]?.id });
    expect(first.history.events.length).toBe(8);
  });

  it('keeps replay structurally valid when large tool results are truncated', async () => {
    for (const mode of ['native', 'prompt'] as const) {
      const requests: AxChatRequest<unknown>[] = [];
      let turn = 0;
      const ai = new AxMockAIService({
        features: { functions: true },
        chatResponse: async (request) => {
          requests.push(request);
          turn++;
          const calls =
            turn === 1
              ? [{ name: 'large', args: { value: 1 } }]
              : [{ name: 'submit', args: { answer: 'done' } }];
          return mode === 'native'
            ? nativeTurn(calls)
            : promptTurn(
                calls.map((call) => ({
                  name: call.name,
                  arguments: call.args,
                }))
              );
        },
      });
      const result = await react('question:string -> answer:string', {
        functions: [tool('large', async () => ({ value: 'x'.repeat(200) }))],
        maxPromptValueCharacters: 48,
      }).forward(
        ai,
        { question: 'Truncate safely' },
        { functionCallMode: mode }
      );

      expect(result.success, JSON.stringify(result)).toBe(true);
      const replay = requests[1]?.chatPrompt ?? [];
      if (mode === 'native') {
        const toolResult = replay.find(
          (message) => message.role === 'function'
        );
        expect(toolResult?.role).toBe('function');
        expect(() =>
          JSON.parse(toolResult?.role === 'function' ? toolResult.result : '')
        ).not.toThrow();
        expect(
          JSON.parse(toolResult?.role === 'function' ? toolResult.result : '')
        ).toContain('truncated JSON value');
      } else {
        const observation = replay.find(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('toolResults')
        );
        expect(observation?.role).toBe('user');
        const parsed = JSON.parse(
          observation?.role === 'user' ? observation.content : ''
        ) as { toolResults: { result: unknown }[] };
        expect(parsed.toolResults[0]?.result).toContain('truncated JSON value');
      }
    }
  });

  it('fails closed on mismatched or malformed resume history', async () => {
    const ai = new AxMockAIService({
      features: { functions: true },
      chatResponse: async () =>
        nativeTurn([{ name: 'submit', args: { answer: 'done' } }]),
    });
    const result = await react('question:string -> answer:string').forward(ai, {
      question: 'Original',
    });

    await expect(
      react('question:string -> answer:string').forward(
        ai,
        { question: 'Different' },
        { history: result.history }
      )
    ).rejects.toThrow('does not match');
    const malformed = structuredClone(result.history);
    malformed.events.pop();
    await expect(
      react('question:string -> answer:string').forward(
        ai,
        { question: 'Original' },
        { history: malformed }
      )
    ).rejects.toThrow('complete ordered group');

    const nonCanonical = structuredClone(result.history);
    const submit = nonCanonical.events.find(
      (event) => event.role === 'assistant'
    );
    if (submit?.role === 'assistant') {
      submit.calls[0]!.arguments = '{"answer": "done"}';
    }
    await expect(
      react('question:string -> answer:string').forward(
        ai,
        { question: 'Original' },
        { history: nonCanonical }
      )
    ).rejects.toThrow('must be canonical JSON');
  });

  it('rejects reserved and duplicate tool names before execution', () => {
    expect(() =>
      react('question:string -> answer:string', {
        functions: [tool('sub-mit', async () => 'bad')],
      })
    ).toThrow("Function name 'submit' is reserved");
    expect(() =>
      react('question:string -> answer:string', {
        functions: [
          tool('look-up', async () => 1),
          tool('look_up', async () => 2),
        ],
      })
    ).toThrow('Duplicate function name');
    expect(() =>
      react('question:string -> answer:string', {
        functions: [tool('---', async () => 1)],
      })
    ).toThrow('Invalid function name');
  });
});
