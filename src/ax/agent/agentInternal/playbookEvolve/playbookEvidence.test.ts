import { describe, expect, it, vi } from 'vitest';
import type { AxProgramUsage } from '../../../dsp/types.js';
import { createAccountingLedger, emptyAccounting } from './accounting.js';
import type { AxAgentEvalBudget } from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentTrajectoryClassifier,
} from './playbookEvidenceTypes.js';
import {
  AxAgentPlaybookEvolveError,
  axIsAgentPlaybookEvolveError,
} from './playbookEvidenceTypes.js';
import {
  axClassifyAxServiceTermination,
  extractErrorIdentity,
  isAssertionAttempt,
  totalTokensOf,
} from './termination.js';

// --- local factories -------------------------------------------------------

type ScriptedAttempt = {
  /** Thrown instead of returning a prediction. */
  throws?: unknown;
  completionType?: 'final' | 'askClarification';
  turnCount?: number;
  functionCalls?: number;
  usage?: AxProgramUsage[];
};

const usageOf = (totalTokens: number, extra?: Partial<AxProgramUsage>) =>
  ({
    ai: 'mock',
    model: 'mock-1',
    tokens: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens,
    },
    ...extra,
  }) as AxProgramUsage;

/**
 * A stub agent whose per-(task, attempt) behaviour is scripted, so a test can
 * drive a specific discard/re-draw/exhaustion shape without a model.
 */
function scriptedAgent(
  script: (taskId: string, attemptIndex: number) => ScriptedAttempt
) {
  const attemptsByTask = new Map<string, number>();
  let calls = 0;
  return {
    calls: () => calls,
    agent: {
      _forwardForEvaluation: async (_ai: unknown, task: { id?: string }) => {
        const id = task.id ?? 'anon';
        const index = attemptsByTask.get(id) ?? 0;
        attemptsByTask.set(id, index + 1);
        calls++;
        const step = script(id, index);
        if (step.throws !== undefined) throw step.throws;
        return {
          completionType: step.completionType ?? 'final',
          output: { answer: 'ok' },
          actionLog: '',
          functionCalls: Array.from(
            { length: step.functionCalls ?? 0 },
            (_, i) => ({
              qualifiedName: `tool_${i}`,
              name: `tool_${i}`,
              arguments: {},
            })
          ),
          toolErrors: [],
          turnCount: step.turnCount ?? 1,
          ...(step.usage ? { usage: step.usage } : {}),
        };
      },
    },
  };
}

const tasksOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    input: { q: index },
    criteria: 'c',
    id: `t${index + 1}`,
  }));

const budgetOf = (remaining: number): AxAgentEvalBudget => ({ remaining });

const constantMetric =
  (score = 1) =>
  async () =>
    score;

/** Marks the given (task, attempt) pairs as environment failures. */
const discardClassifier =
  (discards: ReadonlySet<string>): AxAgentTrajectoryClassifier =>
  (args) =>
    discards.has(`${args.task.id}:${args.attempt}:${args.redraw}`)
      ? { kind: 'environment_failure', cause: 'provider_rate_limit' }
      : undefined;

const baseBatchArgs = (overrides: Record<string, unknown>) => ({
  ai: {} as any,
  metric: constantMetric(),
  scoreThreshold: 0.7,
  ...overrides,
});

// --- termination.ts --------------------------------------------------------

describe('termination classification', () => {
  it('defaults every non-final trajectory to policy_failure', async () => {
    // An askClarification is the agent's own choice, not the environment's:
    // laundering it out of the denominator would hide a real defect.
    const { agent } = scriptedAgent(() => ({
      completionType: 'askClarification',
    }));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(2),
        budget: budgetOf(10),
        captureAttempts: true,
      }) as any
    );
    expect(result.termination.policyFailures).toBe(2);
    expect(result.termination.completed).toBe(0);
    expect(result.termination.environmentFailures).toBe(0);
    expect(result.discardedRuns).toBe(0);
    expect(result.records[0]?.attempts?.[0]?.termination.kind).toBe(
      'policy_failure'
    );
  });

  it('leaves environment failures out of the score denominator', async () => {
    // 5 tasks x 2 runs; three attempts are declared environment failures. The
    // score mean must be over the surviving seven attempts, and the discarded
    // three must not be scored as zeros.
    const discards = new Set(['t1:0:0', 't2:1:0', 't3:0:0']);
    const { agent } = scriptedAgent(() => ({}));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(5),
        budget: budgetOf(50),
        runsPerTask: 2,
        classifyTermination: discardClassifier(discards),
      }) as any
    );
    expect(result.executedRuns).toBe(7);
    expect(result.discardedRuns).toBe(3);
    expect(result.expectedRuns).toBe(10);
    expect(result.termination.discardRate).toBeCloseTo(0.3);
    expect(result.mean).toBe(1);
    expect(result.records).toHaveLength(5);
    expect(result.complete).toBe(true);
  });

  it('produces no record and fails completeness when every attempt of a task is discarded', async () => {
    const discards = new Set(['t2:0:0']);
    const { agent } = scriptedAgent(() => ({}));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(3),
        budget: budgetOf(30),
        classifyTermination: discardClassifier(discards),
      }) as any
    );
    expect(result.records.map((r) => r.task.id)).toEqual(['t1', 't3']);
    expect(result.complete).toBe(false);
    expect(result.termination.tasksWithNoScoredAttempt).toBe(1);
  });

  it('does NOT stop the batch when a task has no scored attempt', async () => {
    // A `break` here would report a mean over a silent prefix of the split
    // while still looking like a complete evaluation downstream.
    const discards = new Set(['t2:0:0']);
    const { agent, calls } = scriptedAgent(() => ({}));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(5),
        budget: budgetOf(50),
        classifyTermination: discardClassifier(discards),
      }) as any
    );
    expect(result.records.map((r) => r.task.id)).toEqual([
      't1',
      't3',
      't4',
      't5',
    ]);
    expect(result.records).toHaveLength(4);
    expect(result.termination.tasksWithNoScoredAttempt).toBe(1);
    expect(result.truncatedAtTaskIndex).toBeUndefined();
    expect(result.exhausted).toBe(false);
    expect(calls()).toBe(5);
  });

  it('still stops the batch on budget exhaustion and sets truncatedAtTaskIndex', async () => {
    const { agent, calls } = scriptedAgent(() => ({}));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(5),
        budget: budgetOf(2),
      }) as any
    );
    expect(result.exhausted).toBe(true);
    expect(result.truncatedAtTaskIndex).toBe(2);
    expect(result.records).toHaveLength(2);
    expect(calls()).toBe(2);
    expect(result.complete).toBe(false);
  });

  it('decrements the budget for discarded attempts', async () => {
    const discards = new Set(['t1:0:0', 't2:0:0']);
    const { agent } = scriptedAgent(() => ({}));
    const budget = budgetOf(10);
    await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(3),
        budget,
        classifyTermination: discardClassifier(discards),
      }) as any
    );
    // The calls really happened, so they really cost budget.
    expect(budget.remaining).toBe(7);
  });

  it('re-draws a discarded attempt within the same budget up to maxDiscardRedraws', async () => {
    // One 429 then a success at runsPerTask: 1. Without the re-draw this task
    // would have produced no record and the candidate would have been rejected
    // with a false "budget exhausted" reason.
    const discards = new Set(['t1:0:0']);
    const { agent, calls } = scriptedAgent(() => ({}));
    const budget = budgetOf(10);
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(1),
        budget,
        classifyTermination: discardClassifier(discards),
        maxDiscardRedraws: 1,
      }) as any
    );
    expect(result.records).toHaveLength(1);
    expect(result.termination.redraws).toBe(1);
    expect(result.termination.environmentFailures).toBe(1);
    expect(result.termination.completed).toBe(1);
    expect(calls()).toBe(2);
    expect(budget.remaining).toBe(8);
    expect(result.records[0]?.attempts?.map((a) => a.redraw)).toEqual([0, 1]);
  });

  it('stops re-drawing at maxDiscardRedraws and reports the unscored task', async () => {
    const { agent, calls } = scriptedAgent(() => ({}));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(1),
        budget: budgetOf(10),
        classifyTermination: (() => ({
          kind: 'environment_failure',
          cause: 'network',
        })) as AxAgentTrajectoryClassifier,
        maxDiscardRedraws: 2,
      }) as any
    );
    expect(calls()).toBe(3);
    expect(result.records).toHaveLength(0);
    expect(result.termination.tasksWithNoScoredAttempt).toBe(1);
    expect(result.termination.causes).toEqual([{ cause: 'network', count: 3 }]);
  });

  it('weights one attempt as one vote regardless of call and token count', async () => {
    // A 50-call / 8_000-token trajectory and a 2-call / 200-token trajectory
    // with the same score must contribute identically.
    const { agent } = scriptedAgent((id) =>
      id === 't1'
        ? { functionCalls: 50, turnCount: 40, usage: [usageOf(8_000)] }
        : { functionCalls: 2, turnCount: 2, usage: [usageOf(200)] }
    );
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(2),
        budget: budgetOf(10),
        metric: constantMetric(0.5),
        captureAttempts: true,
      }) as any
    );
    expect(result.records[0]?.score).toBe(0.5);
    expect(result.records[1]?.score).toBe(0.5);
    expect(result.mean).toBe(0.5);
  });

  it('records callCount, turnCount, totalTokens and latency per attempt', async () => {
    const { agent } = scriptedAgent(() => ({
      functionCalls: 3,
      turnCount: 7,
      usage: [usageOf(120), usageOf(80)],
    }));
    let clock = 1_000;
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(1),
        budget: budgetOf(5),
        captureAttempts: true,
        now: () => {
          clock += 5;
          return clock;
        },
      }) as any
    );
    const attempt = result.records[0]?.attempts?.[0];
    expect(attempt?.callCount).toBe(3);
    expect(attempt?.turnCount).toBe(7);
    expect(attempt?.totalTokens).toBe(200);
    expect(attempt?.latencyMs).toBeGreaterThan(0);
    expect(attempt?.model).toEqual({ ai: 'mock', model: 'mock-1' });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("stores the caller's task object on the record even when inputs are isolated", async () => {
    // isolateTaskInputs clones only the object handed to the agent and the
    // metric — never the one stored on the record. That is what makes an
    // anchor pass and a candidate pass pair by reference, which is the paired
    // bootstrap's precondition.
    const tasks = tasksOf(3);
    const { agent } = scriptedAgent(() => ({}));
    const first = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks,
        budget: budgetOf(10),
        isolateTaskInputs: true,
      }) as any
    );
    const second = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks,
        budget: budgetOf(10),
        isolateTaskInputs: true,
      }) as any
    );
    for (const [index, record] of first.records.entries()) {
      expect(record.task).toBe(tasks[index]);
      expect(second.records[index]?.task).toBe(record.task);
    }
  });

  it('omits attempt records entirely when no evidence option asked for them', async () => {
    const { agent } = scriptedAgent(() => ({}));
    const result = await runAgentEvalBatch(
      baseBatchArgs({ agent, tasks: tasksOf(1), budget: budgetOf(5) }) as any
    );
    expect(result.records[0]).not.toHaveProperty('attempts');
  });
});

describe('structural error identity', () => {
  it('captures errorName, errorCauseName and errorCode without instanceof', async () => {
    // A bare structural error object: no Error subclass, no realm sharing.
    const { agent } = scriptedAgent(() => ({
      throws: { name: 'AxAssertionError', code: 'assert_failed', message: 'x' },
    }));
    const result = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(1),
        budget: budgetOf(5),
        captureAttempts: true,
      }) as any
    );
    const attempt = result.records[0]?.attempts?.[0];
    expect(attempt?.errorName).toBe('AxAssertionError');
    expect(attempt?.errorCode).toBe('assert_failed');
    expect(isAssertionAttempt(attempt as AxAgentPlaybookAttemptRecord)).toBe(
      true
    );
  });

  it('walks the cause chain for a wrapped assertion error', () => {
    // generate.ts wraps non-validation errors in AxGenerateError with the
    // original as `cause`, so the identity can be one level down.
    const identity = extractErrorIdentity({
      name: 'AxGenerateError',
      cause: { name: 'AxStreamingAssertionError' },
    });
    expect(identity.errorName).toBe('AxGenerateError');
    expect(identity.errorCauseName).toBe('AxStreamingAssertionError');
    expect(isAssertionAttempt(identity as AxAgentPlaybookAttemptRecord)).toBe(
      true
    );
  });

  it('stops the cause walk at three levels', () => {
    const identity = extractErrorIdentity({
      name: 'L0',
      cause: { cause: { cause: { cause: { name: 'TooDeep' } } } },
    });
    expect(identity.errorCauseName).toBeUndefined();
  });

  it('survives a self-referential cause chain', () => {
    const error: Record<string, unknown> = { name: 'Loop' };
    error.cause = error;
    expect(extractErrorIdentity(error).errorCauseName).toBe('Loop');
  });

  it('truncates an over-long identity to 200 characters', () => {
    const identity = extractErrorIdentity({ name: 'x'.repeat(500) });
    expect(identity.errorName).toHaveLength(200);
  });

  it('reports no assertion for an unrelated error', () => {
    expect(isAssertionAttempt({ errorName: 'AxAIServiceNetworkError' })).toBe(
      false
    );
    expect(isAssertionAttempt({})).toBe(false);
  });
});

describe('axClassifyAxServiceTermination', () => {
  const classify = (error: unknown, extra?: Record<string, unknown>) =>
    axClassifyAxServiceTermination({
      task: { input: {}, criteria: 'c' },
      error,
      attempt: 0,
      redraw: 0,
      split: 'current',
      ...extractErrorIdentity(error),
      ...extra,
    } as any);

  it('maps a 429 status error to provider_rate_limit structurally', () => {
    expect(classify({ name: 'AxAIServiceStatusError', status: 429 })).toEqual({
      kind: 'environment_failure',
      cause: 'provider_rate_limit',
    });
  });

  it('maps a 5xx status error to provider_unavailable', () => {
    expect(classify({ name: 'AxAIServiceStatusError', status: 503 })).toEqual({
      kind: 'environment_failure',
      cause: 'provider_unavailable',
    });
  });

  it('maps timeout and network errors by name', () => {
    expect(classify({ name: 'AxAIServiceTimeoutError' })).toEqual({
      kind: 'environment_failure',
      cause: 'timeout',
    });
    expect(classify({ name: 'AxAIServiceNetworkError' })).toEqual({
      kind: 'environment_failure',
      cause: 'network',
    });
  });

  it('returns undefined — i.e. policy_failure — for anything else', () => {
    expect(classify({ name: 'AxAIServiceStatusError', status: 400 })).toBe(
      undefined
    );
    expect(classify({ name: 'TypeError' })).toBe(undefined);
    expect(classify(undefined)).toBe(undefined);
  });
});

describe('classifier failure semantics', () => {
  it('raises classifier_invalid when the classifier throws', async () => {
    const { agent } = scriptedAgent(() => ({}));
    const failing = () => {
      throw new Error('boom');
    };
    await expect(
      runAgentEvalBatch(
        baseBatchArgs({
          agent,
          tasks: tasksOf(1),
          budget: budgetOf(5),
          classifyTermination: failing as AxAgentTrajectoryClassifier,
        }) as any
      )
    ).rejects.toThrow(
      /^AxAgent\.playbook\(\)\.evolve\(\): classifyTermination threw/
    );
  });

  it('exposes the error through the structural guard, not instanceof', async () => {
    const { agent } = scriptedAgent(() => ({}));
    const failing = () => {
      throw new Error('boom');
    };
    const err = await runAgentEvalBatch(
      baseBatchArgs({
        agent,
        tasks: tasksOf(1),
        budget: budgetOf(5),
        classifyTermination: failing as AxAgentTrajectoryClassifier,
      }) as any
    ).catch((error: unknown) => error);
    expect(axIsAgentPlaybookEvolveError(err)).toBe(true);
    expect((err as AxAgentPlaybookEvolveError).code).toBe('classifier_invalid');
    expect((err as AxAgentPlaybookEvolveError).phase).toBe('candidate_eval');
  });

  it('rejects an unknown termination kind', async () => {
    const { agent } = scriptedAgent(() => ({}));
    await expect(
      runAgentEvalBatch(
        baseBatchArgs({
          agent,
          tasks: tasksOf(1),
          budget: budgetOf(5),
          classifyTermination: (() => ({
            kind: 'nonsense',
          })) as unknown as AxAgentTrajectoryClassifier,
        }) as any
      )
    ).rejects.toThrow(/unknown termination kind/);
  });
});

describe('axIsAgentPlaybookEvolveError', () => {
  it('accepts a cross-realm structural twin and rejects near-misses', () => {
    expect(
      axIsAgentPlaybookEvolveError({
        name: 'AxAgentPlaybookEvolveError',
        code: 'budget_insufficient',
      })
    ).toBe(true);
    expect(
      axIsAgentPlaybookEvolveError({
        name: 'AxAgentPlaybookEvolveError',
        code: 'not_a_real_code',
      })
    ).toBe(false);
    expect(
      axIsAgentPlaybookEvolveError({ name: 'Error', code: 'veto_failed' })
    ).toBe(false);
    expect(axIsAgentPlaybookEvolveError(new Error('x'))).toBe(false);
    expect(axIsAgentPlaybookEvolveError(undefined)).toBe(false);
  });

  it('prefixes every message and preserves the cause', () => {
    const cause = new Error('root');
    const error = new AxAgentPlaybookEvolveError(
      'veto_failed',
      'veto',
      'veto rejected the candidate.',
      { cause }
    );
    expect(error.message).toBe(
      'AxAgent.playbook().evolve(): veto rejected the candidate.'
    );
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('AxAgentPlaybookEvolveError');
  });
});

// --- accounting.ts ---------------------------------------------------------

describe('compute accounting', () => {
  const tickingClock = () => {
    let value = 0;
    return () => {
      value += 10;
      return value;
    };
  };

  it('sums AxTokenUsage.totalTokens rather than prompt + completion', () => {
    // A reasoning model reports 5_000 reasoning tokens inside totalTokens;
    // promptTokens + completionTokens would silently drop them.
    const usage = [
      {
        ai: 'mock',
        model: 'r1',
        tokens: {
          promptTokens: 10,
          completionTokens: 5,
          reasoningTokens: 5_000,
          totalTokens: 5_015,
        },
      } as AxProgramUsage,
    ];
    expect(totalTokensOf(usage)).toBe(5_015);
    const ledger = createAccountingLedger(tickingClock());
    const phase = ledger.phase('candidate_eval');
    phase.addMetricCalls(1);
    phase.addUsage(usage);
    phase.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 1 });
    expect(accounting.totalTokens).toBe(5_015);
    expect(accounting.tokensBasis).toBe('observed');
  });

  it('reports the honest run total as the sum over phases', () => {
    const ledger = createAccountingLedger(tickingClock());
    const baseline = ledger.phase('baseline');
    baseline.addMetricCalls(4);
    baseline.close();
    const band = ledger.phase('variance_band');
    band.addMetricCalls(4);
    band.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 4 });
    expect(accounting.metricCalls).toBe(8);
    expect(accounting.evolveOnlyMetricCalls).toBe(4);
    expect(accounting.phases.map((p) => p.name).sort()).toEqual([
      'baseline',
      'variance_band',
    ]);
  });

  it('reports mining and judge tokens as unobservable without a usage tap', () => {
    const ledger = createAccountingLedger(tickingClock());
    const mining = ledger.phase('mining');
    mining.addModelCalls(2);
    mining.close();
    const judge = ledger.phase('judge');
    judge.addModelCalls(4);
    judge.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 0 });
    const byName = new Map(accounting.phases.map((p) => [p.name, p]));
    expect(byName.get('mining')?.tokensBasis).toBe('unobservable');
    expect(byName.get('mining')?.totalTokens).toBeUndefined();
    expect(byName.get('judge')?.tokensBasis).toBe('unobservable');
    expect(accounting.tokensBasis).toBe('unobservable');
    expect(accounting.totalTokens).toBeUndefined();
  });

  it('reports partial when only some calls surfaced usage', () => {
    const ledger = createAccountingLedger(tickingClock());
    const phase = ledger.phase('candidate_eval');
    phase.addMetricCalls(4);
    phase.addUsage([usageOf(100)]);
    phase.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 4 });
    expect(accounting.phases[0]?.tokensBasis).toBe('partial');
  });

  it('reports costUsd undefined and costBasis unknown without costFor', () => {
    const ledger = createAccountingLedger(tickingClock());
    const phase = ledger.phase('baseline');
    phase.addMetricCalls(1);
    phase.addUsage([usageOf(10)]);
    phase.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 1 });
    expect(accounting.costUsd).toBeUndefined();
    expect(accounting.costBasis).toBe('unknown');
  });

  it('invokes costFor with the observed usage and reports caller_supplied', () => {
    const ledger = createAccountingLedger(tickingClock());
    const phase = ledger.phase('baseline');
    phase.addMetricCalls(1);
    phase.addUsage([usageOf(10), usageOf(20)]);
    phase.close();
    const costFor = vi.fn(
      (usage: readonly AxProgramUsage[]) => usage.length * 0.5
    );
    const accounting = ledger.assemble({
      evolveOnlyMetricCalls: 1,
      costFor,
    });
    expect(costFor).toHaveBeenCalledTimes(1);
    expect(costFor.mock.calls[0]?.[0]).toHaveLength(2);
    expect(accounting.costUsd).toBe(1);
    expect(accounting.costBasis).toBe('caller_supplied');
  });

  it('treats a non-finite cost as unknown rather than as a number', () => {
    const ledger = createAccountingLedger(tickingClock());
    const accounting = ledger.assemble({
      evolveOnlyMetricCalls: 0,
      costFor: () => Number.NaN,
    });
    expect(accounting.costUsd).toBeUndefined();
    expect(accounting.costBasis).toBe('unknown');
  });

  it('deduplicates the model identities that produced measurements', () => {
    const ledger = createAccountingLedger(tickingClock());
    const phase = ledger.phase('baseline');
    phase.addUsage([
      usageOf(1),
      usageOf(2),
      usageOf(3, { model: 'mock-2' } as Partial<AxProgramUsage>),
    ]);
    phase.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 0 });
    expect(accounting.models).toEqual([
      { ai: 'mock', model: 'mock-1' },
      { ai: 'mock', model: 'mock-2' },
    ]);
  });

  it('has a zeroed empty form with no phases', () => {
    const accounting = emptyAccounting();
    expect(accounting.metricCalls).toBe(0);
    expect(accounting.phases).toEqual([]);
    expect(accounting.tokensBasis).toBe('none');
    expect(accounting.costBasis).toBe('unknown');
  });
});
