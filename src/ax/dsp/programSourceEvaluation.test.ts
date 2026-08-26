import { describe, expect, it } from 'vitest';
import { runProgramSourceEvaluation } from './programSourceEvaluation.js';

describe('program-source hill-climbing evaluation', () => {
  it('selects on validation and reports a frozen final test within budgets', async () => {
    const report = await runProgramSourceEvaluation();
    expect(report.seed).toMatchObject({
      trainScore: 0.5,
      validationScore: 0.5,
      statementCount: 2,
    });
    expect(report.candidates).toMatchObject([
      { name: 'invalid-source', status: 'invalid' },
      {
        name: 'train-memorizer',
        status: 'rejected',
        trainScore: 1,
        validationScore: 0,
        statementCount: 1,
        costUsd: 0,
      },
      {
        name: 'general-tool-rule',
        status: 'promoted',
        trainScore: 1,
        validationScore: 1,
        statementCount: 2,
        costUsd: 0,
      },
    ]);
    expect(report.promoted).toBe('general-tool-rule');
    expect(report.finalTest).toEqual({
      examples: 2,
      seedScore: 0.5,
      optimizedScore: 1,
    });
    expect(report.negative).toMatchObject({
      seedScore: 1,
      candidateScore: 1,
      status: 'rejected-no-value',
      statementCount: 3,
      costUsd: 0,
    });
    expect(report.finalSourceBytes).toBeGreaterThan(0);
    expect(report.finalStatementCount).toBe(2);
    expect(report.costUsd).toBe(0);
    expect(report.usage).toEqual({
      metricCalls: 26,
      predictorCalls: 14,
      toolCalls: 8,
    });
    expect(report.budgets).toEqual({
      metricCalls: 30,
      predictorCalls: 16,
      toolCalls: 8,
      wallTimeMs: 10_000,
    });
    expect(report.usage.metricCalls).toBeLessThanOrEqual(
      report.budgets.metricCalls
    );
    expect(report.usage.predictorCalls).toBeLessThanOrEqual(
      report.budgets.predictorCalls
    );
    expect(report.usage.toolCalls).toBeLessThanOrEqual(
      report.budgets.toolCalls
    );
    expect(report.runtimeMs).toBeLessThanOrEqual(report.budgets.wallTimeMs);
  });
});
