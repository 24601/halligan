import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import { createAxGenAdapter } from './axGenAdapter.js';

describe('createAxGenAdapter', () => {
  it('slices fn components to relevant function-call traces plus zero-score rows', async () => {
    const program = {
      applyOptimizedComponents: () => {},
      forward: async (_ai: AxAIService, input: any, options: any) => {
        if (input.tool === 'lookup_user') {
          await options.onFunctionCall?.({
            fn: 'lookup_user',
            componentId: 'lookup_user',
            args: { q: input.q },
            result: 'lookup-result',
            ok: true,
            ms: 1,
          });
          return { answer: 'lookup' };
        }
        await options.onFunctionCall?.({
          fn: 'send_email',
          componentId: 'send_email',
          args: { q: input.q },
          result: 'email-result',
          ok: true,
          ms: 1,
        });
        return { answer: 'email' };
      },
    };

    const adapter = createAxGenAdapter({
      program: program as any,
      ai: {} as AxAIService,
      sampleCount: 1,
      metricFn: async ({ example }) => (example as any).score as number,
    });

    const evalBatch = await adapter.evaluate(
      [
        { tool: 'lookup_user', q: 'a', score: 1 },
        { tool: 'send_email', q: 'b', score: 1 },
        { tool: 'send_email', q: 'c', score: 0 },
      ],
      {},
      true
    );
    const ds = adapter.make_reflective_dataset({}, evalBatch, [
      'root::fn:lookup_user:desc',
    ]);

    expect(ds['root::fn:lookup_user:desc']).toHaveLength(2);
    expect(ds['root::fn:lookup_user:desc']?.[0].calls[0].fn).toBe(
      'lookup_user'
    );
    expect(ds['root::fn:lookup_user:desc']?.[1].score).toBe(0);
  });

  it('keeps structured scalar, objectives, and feedback aligned in reflective rows', async () => {
    const program = {
      applyOptimizedComponents: () => {},
      forward: async (_ai: AxAIService, input: any) => {
        if (input.id === 'error') throw new Error('failed');
        return { answer: input.id };
      },
    };
    const adapter = createAxGenAdapter({
      program: program as any,
      ai: {} as AxAIService,
      sampleCount: 1,
      metricFn: async ({ example }) => ({
        score: 0.8,
        feedback: `improve-${example.id}`,
        scores: { accuracy: 1, brevity: 0.25 },
      }),
    });

    const batch = await adapter.evaluate(
      [{ id: 'a' }, { id: 'error' }, { id: 'b' }],
      {},
      true
    );
    expect(batch.scores).toEqual([0.8, 0, 0.8]);
    expect(batch.scoreVectors).toEqual([
      { accuracy: 1, brevity: 0.25 },
      { accuracy: 0, brevity: 0 },
      { accuracy: 1, brevity: 0.25 },
    ]);
    expect(batch.feedback).toEqual(['improve-a', undefined, 'improve-b']);

    const dataset = adapter.make_reflective_dataset({}, batch, [
      'root::instruction',
    ]);
    expect(dataset['root::instruction']).toMatchObject([
      { score: 0.8, feedback: 'improve-a', output: { answer: 'a' } },
      { score: 0, error: 'failed' },
      { score: 0.8, feedback: 'improve-b', output: { answer: 'b' } },
    ]);
  });
});
