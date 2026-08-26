import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import {
  evaluateGEPABatch,
  normalizeGEPAMetricResult,
  normalizeGEPAScores,
  scalarizeGEPAScores,
} from './gepaEvaluation.js';

describe('normalizeGEPAMetricResult', () => {
  it('preserves legacy scalar and multi-objective metric results', async () => {
    await expect(
      normalizeGEPAScores(async () => 0.75, {}, {})
    ).resolves.toEqual({
      score: 0.75,
    });
    await expect(
      normalizeGEPAScores(async () => ({ accuracy: 1, brevity: 0.5 }), {}, {})
    ).resolves.toEqual({ accuracy: 1, brevity: 0.5 });
    await expect(
      normalizeGEPAScores(
        async () => ({ score: 0.75, scores: 0.5, feedback: 0.25 }),
        {},
        {}
      )
    ).resolves.toEqual({ score: 0.75, scores: 0.5, feedback: 0.25 });
  });

  it('keeps the structured scalar separate from named Pareto objectives', async () => {
    const result = await normalizeGEPAMetricResult(
      async () => ({
        score: 0.9,
        feedback: '  Cite the source.  ',
        scores: { accuracy: 1, brevity: 0.25 },
      }),
      {},
      {}
    );

    expect(result).toEqual({
      scalar: 0.9,
      feedback: 'Cite the source.',
      scores: { accuracy: 1, brevity: 0.25 },
    });
  });

  it('drops empty/malformed fields and bounds sanitized feedback', async () => {
    const empty = await normalizeGEPAMetricResult(
      async () =>
        ({
          score: Number.NaN,
          feedback: ' \u0000\r\n ',
          scores: { valid: 0.5, infinite: Number.POSITIVE_INFINITY, bad: 'x' },
        }) as any,
      {},
      {}
    );
    expect(empty).toEqual({
      scores: { valid: 0.5 },
      scalar: undefined,
      feedback: undefined,
    });

    const bounded = await normalizeGEPAMetricResult(
      async () => ({ score: 1, feedback: `ok\u0000${'x'.repeat(5_000)}` }),
      {},
      {}
    );
    expect(bounded.feedback).not.toContain('\u0000');
    expect(bounded.feedback).toHaveLength(4_000);
  });
});

describe('evaluateGEPABatch', () => {
  it('captures traces, preserves score vectors, and charges one call per rollout', async () => {
    const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
    const program = {
      applyOptimizedComponents: () => {},
      forward: async (_ai: AxAIService, input: any, options: any) => {
        await options.onFunctionCall?.({
          fn: 'lookup_user',
          componentId: 'lookup_user',
          args: { id: input.id },
          result: 'ok',
          ok: true,
          ms: 1,
        });
        return { value: input.id };
      },
    };

    const result = await evaluateGEPABatch({
      program: program as any,
      ai: {} as AxAIService,
      metricFn: async ({ example }) => ({
        exact: (example as any).id === '1' ? 1 : 0,
        helpful: 0.5,
      }),
      cfg: {},
      set: [{ id: '1' }, { id: '2' }] as any,
      phase: 'test',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {},
      scalarize: (scores) => scalarizeGEPAScores(scores),
      captureTraces: true,
    });

    expect(state.totalCalls).toBe(2);
    expect(result?.rows[0]?.scores).toEqual({ exact: 1, helpful: 0.5 });
    expect(result?.scalars[0]).toBe(0.75);
    expect((result?.trajectories?.[0] as any)?.calls[0]).toMatchObject({
      componentId: 'lookup_user',
    });
  });

  it('adapts scalar-only custom adapter output into score vectors', async () => {
    const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
    const result = await evaluateGEPABatch({
      program: {} as any,
      ai: {} as AxAIService,
      metricFn: async () => 0,
      adapter: {
        evaluate: async () => ({ outputs: [{ ok: true }], scores: [0.25] }),
        make_reflective_dataset: () => ({}),
      },
      cfg: {},
      set: [{ id: '1' }] as any,
      phase: 'adapter',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {},
      scalarize: (scores) => scalarizeGEPAScores(scores),
    });

    expect(result?.rows[0]?.scores).toEqual({ score: 0.25 });
    expect(result?.rows[0]?.scalar).toBe(0.25);
    expect(state.totalCalls).toBe(1);
  });

  it('does not publish a completed adapter batch after abort', async () => {
    const controller = new AbortController();
    const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
    const result = await evaluateGEPABatch({
      program: {} as any,
      ai: {} as AxAIService,
      metricFn: async () => 0,
      adapter: {
        evaluate: async () => {
          controller.abort();
          return {
            outputs: [{ ok: true }, { ok: true }],
            scores: [1, 1],
          };
        },
        make_reflective_dataset: () => ({}),
      },
      cfg: {},
      set: [{ id: '1' }, { id: '2' }] as any,
      phase: 'adapter-abort',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {},
      scalarize: (scores) => scalarizeGEPAScores(scores),
      abortSignal: controller.signal,
    });

    expect(result).toBeUndefined();
    expect(state).toMatchObject({ totalCalls: 2, stopReason: 'aborted' });
  });

  it('retains completed direct-call accounting when abort ends a batch', async () => {
    const controller = new AbortController();
    const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
    let forwardCalls = 0;
    const result = await evaluateGEPABatch({
      program: {
        forward: async () => {
          forwardCalls += 1;
          return { ok: true };
        },
      } as any,
      ai: {} as AxAIService,
      metricFn: async () => {
        controller.abort();
        return 1;
      },
      cfg: {},
      set: [{ id: '1' }, { id: '2' }] as any,
      phase: 'direct-abort',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {},
      scalarize: (scores) => scalarizeGEPAScores(scores),
      abortSignal: controller.signal,
    });

    expect(result).toBeUndefined();
    expect(forwardCalls).toBe(1);
    expect(state).toMatchObject({ totalCalls: 1, stopReason: 'aborted' });
  });

  it('uses an adapter explicit scalar instead of averaging named objectives', async () => {
    const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
    const result = await evaluateGEPABatch({
      program: {} as any,
      ai: {} as AxAIService,
      metricFn: async () => 0,
      adapter: {
        evaluate: async () => ({
          outputs: [{ ok: true }],
          scores: [0.4],
          scoreVectors: [{ accuracy: 1, brevity: 1 }],
          feedback: ['wrong format'],
        }),
        make_reflective_dataset: () => ({}),
      },
      cfg: {},
      set: [{ id: '1' }] as any,
      phase: 'adapter-explicit',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {},
      scalarize: (scores) => scalarizeGEPAScores(scores),
    });

    expect(result?.rows[0]?.scores).toEqual({ accuracy: 1, brevity: 1 });
    expect(result?.rows[0]?.scalar).toBe(0.4);
    expect(result?.rows[0]?.feedback).toBe('wrong format');
  });

  it('keeps a legacy multi-objective vector that also has a string feedback field', async () => {
    await expect(
      normalizeGEPAScores(
        async () => ({
          accuracy: 1,
          brevity: 0.5,
          feedback: 'cite the source',
        }),
        {},
        {}
      )
    ).resolves.toEqual({ accuracy: 1, brevity: 0.5 });
  });

  it('aligns structured feedback, scores, outputs, and traces across failures', async () => {
    const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
    const program = {
      forward: async (_ai: AxAIService, input: any) => {
        if (input.id === 'error') throw new Error('rollout failed');
        return { id: input.id };
      },
    };

    const result = await evaluateGEPABatch({
      program: program as any,
      ai: {} as AxAIService,
      metricFn: async ({ example }) => ({
        score: example.id === 'a' ? 0.8 : 0.4,
        feedback: `feedback-${example.id}`,
        scores: { quality: example.id === 'a' ? 1 : 0.5 },
      }),
      cfg: {},
      set: [{ id: 'a' }, { id: 'error' }, { id: 'b' }] as any,
      phase: 'alignment',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {},
      scalarize: (scores) => scalarizeGEPAScores(scores),
      captureTraces: true,
    });

    expect(result?.rows).toMatchObject([
      {
        prediction: { id: 'a' },
        scores: { quality: 1 },
        scalar: 0.8,
        feedback: 'feedback-a',
      },
      {
        prediction: { error: 'rollout failed' },
        scores: { quality: 0 },
        scalar: 0,
      },
      {
        prediction: { id: 'b' },
        scores: { quality: 0.5 },
        scalar: 0.4,
        feedback: 'feedback-b',
      },
    ]);
    expect(result?.rows[1]?.feedback).toBeUndefined();
    expect(result?.trajectories).toHaveLength(3);
    expect(result?.trajectories?.[1]).toMatchObject({
      error: 'rollout failed',
    });
  });

  it.each([0, 1, 2])(
    'zero-fills named objectives when direct rollout %i fails',
    async (failureIndex) => {
      const state = { totalCalls: 0, observedScoreKeys: new Set<string>() };
      const result = await evaluateGEPABatch({
        program: {
          forward: async (_ai: AxAIService, input: any) => {
            if (input.fail) throw new Error('rollout failed');
            return { ok: true };
          },
        } as any,
        ai: {} as AxAIService,
        metricFn: async () => ({
          score: 0.8,
          scores: { accuracy: 1, brevity: 1 },
        }),
        cfg: {},
        set: [0, 1, 2].map((index) => ({ fail: index === failureIndex })),
        phase: 'failure-order',
        sampleCount: 1,
        maxMetricCalls: 10,
        state,
        applyConfig: () => {},
        scalarize: (scores) => scalarizeGEPAScores(scores),
      });

      expect(result?.rows.map((row) => row.scores)).toEqual(
        [0, 1, 2].map((index) =>
          index === failureIndex
            ? { accuracy: 0, brevity: 0 }
            : { accuracy: 1, brevity: 1 }
        )
      );
      expect(result?.avg).toEqual({
        accuracy: 2 / 3,
        brevity: 2 / 3,
      });
    }
  );

  it('turns candidate bind errors into aligned failure rows', async () => {
    const state = {
      totalCalls: 0,
      observedScoreKeys: new Set<string>(['quality']),
    };
    let forwards = 0;
    const result = await evaluateGEPABatch({
      program: {
        forward: async () => {
          forwards += 1;
          return { value: 'stale' };
        },
      } as any,
      ai: {} as AxAIService,
      metricFn: async () => ({ quality: 1 }),
      cfg: { 'root::program-source': '{broken' },
      set: [{ id: '1' }, { id: '2' }] as any,
      phase: 'invalid candidate',
      sampleCount: 1,
      maxMetricCalls: 10,
      state,
      applyConfig: () => {
        throw new Error('must not apply an invalid source');
      },
      validateConfig: () => {
        throw new Error('Invalid program source JSON');
      },
      scalarize: (scores) => scalarizeGEPAScores(scores),
      captureTraces: true,
    });

    expect(forwards).toBe(0);
    expect(state.totalCalls).toBe(2);
    expect(result?.scalars).toEqual([0, 0]);
    expect(result?.rows.map((row) => row.prediction)).toEqual([
      { error: 'Invalid program source JSON' },
      { error: 'Invalid program source JSON' },
    ]);
    expect(result?.trajectories).toEqual([
      { calls: [], error: 'Invalid program source JSON' },
      { calls: [], error: 'Invalid program source JSON' },
    ]);
  });

  it('preserves ordinary GEPA config-error semantics by default', async () => {
    await expect(
      evaluateGEPABatch({
        program: {} as any,
        ai: {} as AxAIService,
        metricFn: async () => 1,
        cfg: { 'root::instruction': 'candidate' },
        set: [{ id: '1' }] as any,
        phase: 'ordinary candidate',
        sampleCount: 1,
        maxMetricCalls: 10,
        state: { totalCalls: 0, observedScoreKeys: new Set<string>() },
        applyConfig: () => {
          throw new Error('ordinary config error');
        },
        scalarize: (scores) => scalarizeGEPAScores(scores),
      })
    ).rejects.toThrow('ordinary config error');
  });

  it('preserves ordinary config errors in a mixed program-source tree', async () => {
    await expect(
      evaluateGEPABatch({
        program: {} as any,
        ai: {} as AxAIService,
        metricFn: async () => 1,
        cfg: {
          'root::program-source': '{valid}',
          'root.child::instruction': 'candidate',
        },
        set: [{ id: '1' }] as any,
        phase: 'mixed candidate',
        sampleCount: 1,
        maxMetricCalls: 10,
        state: { totalCalls: 0, observedScoreKeys: new Set<string>() },
        validateConfig: () => {},
        applyConfig: () => {
          throw new Error('ordinary mixed config error');
        },
        scalarize: (scores) => scalarizeGEPAScores(scores),
      })
    ).rejects.toThrow('ordinary mixed config error');
  });
});
