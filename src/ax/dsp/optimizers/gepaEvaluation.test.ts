import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import { evaluateGEPABatch, scalarizeGEPAScores } from './gepaEvaluation.js';

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
    expect(state.totalCalls).toBe(1);
  });

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
        throw new Error('Invalid program source JSON');
      },
      scalarize: (scores) => scalarizeGEPAScores(scores),
      captureTraces: true,
      alignConfigErrors: true,
    });

    expect(forwards).toBe(0);
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
});
