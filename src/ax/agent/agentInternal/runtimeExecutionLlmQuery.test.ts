import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../../ai/mock/api.js';
import { f } from '../../dsp/sig.js';
import { getJSRuntimeHostFunctionSpeculationAdapter } from '../../funcs/jsRuntimeHostFunction.js';
import { buildLlmQueryBindings } from './runtimeExecutionLlmQuery.js';
import type { AxLlmQueryBudgetState } from './types.js';

const makeModelUsage = () => ({
  ai: 'mock-ai',
  model: 'mock-model',
  tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

describe('llmQuery speculative debit accounting', () => {
  it('refunds only the abandoned launch debit after a later call is retained', async () => {
    const budget: AxLlmQueryBudgetState = {
      global: { used: 0 },
      globalMax: 8,
      localUsed: 0,
      localMax: 8,
    };
    const { llmQuery } = buildLlmQueryBindings({
      self: { shouldBubbleUserError: () => false },
      ai: new AxMockAIService({
        features: { functions: false, streaming: false },
        chatResponse: async (req) => {
          const prompt = req.chatPrompt
            .map((message) => String(message.content ?? ''))
            .join('\n');
          return {
            results: [
              {
                index: 0,
                content: prompt.includes('Task: actual')
                  ? 'Answer: ACTUAL'
                  : 'Answer: STALE',
                finishReason: 'stop',
              },
            ],
            modelUsage: makeModelUsage(),
          };
        },
      }),
      debug: false,
      llmQueryBudgetState: budget,
      maxBatchedLlmQueryConcurrency: 1,
      recursionForwardOptions: {},
      parentForwardOptions: {},
      simpleChildSignature: f()
        .input('task', f.string())
        .output('answer', f.string())
        .build(),
      llmCallWarnThreshold: 8,
      getMaxRuntimeChars: () => 1000,
    });
    const adapter = getJSRuntimeHostFunctionSpeculationAdapter(llmQuery);
    expect(adapter).toBeDefined();

    const first = new AbortController();
    const second = new AbortController();
    const stale = await adapter!.launch(['planned'], first.signal);
    expect(budget.global.used).toBe(1);
    expect(budget.localUsed).toBe(1);

    const retained = await adapter!.launch(['actual'], second.signal);
    expect(budget.global.used).toBe(2);
    expect(budget.localUsed).toBe(2);
    retained.retain?.();

    stale.releaseDebit?.();
    expect(budget.global.used).toBe(1);
    expect(budget.localUsed).toBe(1);

    first.abort('stale');
    stale.releaseDebit?.();
    expect(budget.global.used).toBe(1);
    expect(budget.localUsed).toBe(1);
    await Promise.allSettled([stale.result, retained.result]);
  });
});
