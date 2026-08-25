import { describe, expect, it } from 'vitest';
import { runProgramSourceEvaluation } from './programSourceEvaluation.js';

describe('program-source hill-climbing evaluation', () => {
  it('promotes only held-out improvement within deterministic budgets', async () => {
    const report = await runProgramSourceEvaluation();
    expect(report.seed).toMatchObject({
      trainScore: 0.5,
      heldOutScore: 0.5,
      statementCount: 2,
    });
    expect(report.candidates).toMatchObject([
      { name: 'invalid-source', status: 'invalid' },
      {
        name: 'train-memorizer',
        status: 'rejected',
        trainScore: 1,
        heldOutScore: 0,
        statementCount: 1,
        costUsd: 0,
      },
      {
        name: 'general-tool-rule',
        status: 'promoted',
        trainScore: 1,
        heldOutScore: 1,
        statementCount: 2,
        costUsd: 0,
      },
    ]);
    expect(report.promoted).toBe('general-tool-rule');
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
