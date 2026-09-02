import { describe, expect, it, vi } from 'vitest';
import type { AxProgramUsage } from '../../../dsp/types.js';
import {
  accountingForPhases,
  candidateAccounting,
  createAccountingLedger,
  emptyAccounting,
  overheadReportFrom,
  overheadSplitFrom,
  phaseAccounting,
  unobservableTokenPhases,
} from './accounting.js';
import type { AxAgentEvalBudget } from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import {
  buildEvidenceReceipt,
  evidenceReceiptDigest,
  impliedFamilyWiseErrorRate,
} from './evidenceReceipt.js';
import { evaluateGateChain, GATE_ORDER, gateChainAccepts } from './gates.js';
import type {
  AxAgentPlaybookAttemptRecord,
  AxAgentTrajectoryClassifier,
} from './playbookEvidenceTypes.js';
import {
  AxAgentPlaybookEvolveError,
  axIsAgentPlaybookEvolveError,
} from './playbookEvidenceTypes.js';
import { createReachCollector } from './reach.js';
import {
  clustersFromPairedRecords,
  createSeededRandom,
  pairedBootstrapInterval,
  seedFromDigest,
  validateIntervalOptions,
  varianceBandFrom,
  weightedMean,
} from './statistics.js';
import {
  axClassifyAxServiceTermination,
  extractErrorIdentity,
  isAssertionAttempt,
  totalTokensOf,
} from './termination.js';
import {
  evaluateValidity,
  registeredFunctionNames,
  validityPredicateName,
} from './validity.js';

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

  it('attributes tapped usage to an open unobservable phase and refuses it elsewhere', () => {
    const ledger = createAccountingLedger(tickingClock());
    const baseline = ledger.phase('baseline');
    baseline.addMetricCalls(1);
    // Dropped: `baseline` already counted this call's usage off the
    // prediction, so accepting it here would count the same tokens twice.
    expect(ledger.tapUsage([usageOf(999)])).toBe(false);
    baseline.close();
    const mining = ledger.phase('mining');
    mining.addModelCalls(1);
    expect(ledger.tapUsage([usageOf(120)])).toBe(true);
    mining.close();
    const accounting = ledger.assemble({
      evolveOnlyMetricCalls: 1,
      usageTapped: true,
    });
    const byName = new Map(accounting.phases.map((p) => [p.name, p]));
    expect(byName.get('mining')?.totalTokens).toBe(120);
    expect(byName.get('mining')?.tokensBasis).toBe('observed');
    expect(byName.get('baseline')?.totalTokens).toBeUndefined();
    expect(accounting.totalTokens).toBe(120);
  });

  it('scopes a phase report to the models that actually ran in it', () => {
    const ledger = createAccountingLedger(tickingClock());
    const baseline = ledger.phase('baseline');
    baseline.addMetricCalls(1);
    baseline.addUsage([
      {
        ai: 'mock',
        model: 'student',
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 10 },
      } as AxProgramUsage,
    ]);
    baseline.close();
    const band = ledger.phase('variance_band');
    band.addMetricCalls(1);
    band.addUsage([
      {
        ai: 'mock',
        model: 'band-only',
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 20 },
      } as AxProgramUsage,
    ]);
    band.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 1 });
    expect(accounting.models.map((entry) => entry.model).sort()).toEqual([
      'band-only',
      'student',
    ]);
    // A band-scoped report must NOT name the model that only ran in baseline.
    const scoped = accountingForPhases(accounting, ['variance_band']);
    expect(scoped.models).toEqual([{ ai: 'mock', model: 'band-only' }]);
    expect(scoped.metricCalls).toBe(1);
    expect(scoped.evolveOnlyMetricCalls).toBe(0);
  });

  it('drops tapped usage that arrives with no phase open', () => {
    const ledger = createAccountingLedger(tickingClock());
    expect(ledger.tapUsage([usageOf(50)])).toBe(false);
    const accounting = ledger.assemble({
      evolveOnlyMetricCalls: 0,
      usageTapped: true,
    });
    expect(accounting.totalTokens).toBeUndefined();
    expect(accounting.tokensBasis).toBe('none');
  });

  it('reports a tapped phase that still saw nothing as unreported', () => {
    const ledger = createAccountingLedger(tickingClock());
    const mining = ledger.phase('mining');
    mining.addModelCalls(2);
    mining.close();
    const accounting = ledger.assemble({
      evolveOnlyMetricCalls: 0,
      usageTapped: true,
    });
    // A tap was installed and nothing arrived: that is 'unreported', not the
    // structural 'unobservable' the same phase reads without one.
    expect(accounting.phases[0]?.tokensBasis).toBe('unreported');
  });

  it('reports an observable phase that surfaced nothing as unreported, not unobservable', () => {
    // `baseline` reads usage straight off the predictions. A usageTap would
    // change nothing about it, so labelling it 'unobservable' would point a
    // reader at a remedy that does not apply.
    const ledger = createAccountingLedger(tickingClock());
    const baseline = ledger.phase('baseline');
    baseline.addMetricCalls(2);
    baseline.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 2 });
    const byName = new Map(accounting.phases.map((p) => [p.name, p]));
    expect(byName.get('baseline')?.tokensBasis).toBe('unreported');
    expect(byName.get('baseline')?.totalTokens).toBeUndefined();
    expect(accounting.tokensBasis).toBe('unreported');
    expect(unobservableTokenPhases(accounting)).toEqual([]);
  });

  it('names only the structurally unobservable phases as unobservable', () => {
    const ledger = createAccountingLedger(tickingClock());
    const baseline = ledger.phase('baseline');
    baseline.addMetricCalls(2);
    baseline.close();
    const mining = ledger.phase('mining');
    mining.addModelCalls(1);
    mining.close();
    const accounting = ledger.assemble({ evolveOnlyMetricCalls: 2 });
    expect(unobservableTokenPhases(accounting)).toEqual(['mining']);
    // Mixed bases roll up to partial rather than claiming either extreme.
    expect(accounting.tokensBasis).toBe('partial');
  });

  it('reports a candidate accounting with no reported usage as unreported', () => {
    const accounting = candidateAccounting({
      metricCalls: 2,
      usage: [],
      wallClockMs: 12,
      usesBuiltInJudge: false,
    });
    expect(accounting.phases[0]?.tokensBasis).toBe('unreported');
    expect(accounting.tokensBasis).toBe('unreported');
    expect(accounting.totalTokens).toBeUndefined();
  });

  it('keeps candidateAccounting byte-identical to its phaseAccounting delegate', () => {
    // `candidateAccounting` was refactored into a `phaseAccounting` call. The
    // refactor is only "pure" if the two produce the same block, and the
    // candidate's own `evolveOnlyMetricCalls` rule (its metric calls ARE
    // evolve-only, a control arm's are not) is exactly what a careless later
    // edit would flatten.
    const args = {
      metricCalls: 3,
      usage: [usageOf(40), usageOf(60)],
      wallClockMs: 21,
      usesBuiltInJudge: true,
    } as const;
    expect(candidateAccounting({ ...args, usage: [...args.usage] })).toEqual(
      phaseAccounting({
        phase: 'candidate_eval',
        ...args,
        usage: [...args.usage],
        evolveOnlyMetricCalls: args.metricCalls,
      })
    );
    // And it is NOT the same as a phase block that zeroes the legacy counter,
    // which is what a control arm's block does.
    expect(
      candidateAccounting({ ...args, usage: [...args.usage] })
    ).not.toEqual(
      phaseAccounting({
        phase: 'candidate_eval',
        ...args,
        usage: [...args.usage],
        evolveOnlyMetricCalls: 0,
      })
    );
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

// --- statistics.ts ---------------------------------------------------------

describe('paired task-clustered bootstrap', () => {
  const cluster = (delta: number, weight = 1) => ({ weight, deltas: [delta] });

  it('produces the same sequence for the same seed', () => {
    const first = Array.from({ length: 8 }, createSeededRandom(42));
    const second = Array.from({ length: 8 }, createSeededRandom(42));
    const other = Array.from({ length: 8 }, createSeededRandom(43));
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('resamples tasks, not attempts', () => {
    // 3 tasks x 20 attempts. Adding attempts without adding tasks must not
    // narrow the interval: treating 60 episodes as 60 independent observations
    // is exactly the error that makes a bootstrap look rigorous and not be.
    const three = [0.1, 0.2, 0.3].map((delta) => ({
      weight: 1,
      deltas: [delta],
    }));
    const threeWithRepeats = [0.1, 0.2, 0.3].map((delta) => ({
      weight: 1,
      deltas: Array.from({ length: 20 }, () => delta),
    }));
    const sparse = pairedBootstrapInterval({
      clusters: three,
      seed: 7,
      resamples: 2_000,
    })!;
    const dense = pairedBootstrapInterval({
      clusters: threeWithRepeats,
      seed: 7,
      resamples: 2_000,
    })!;
    expect(sparse.unit).toBe('task');
    expect(sparse.clusters).toBe(3);
    expect(dense.clusters).toBe(3);
    expect(dense.lower).toBeCloseTo(sparse.lower, 10);
    expect(dense.upper).toBeCloseTo(sparse.upper, 10);
  });

  it('reports unresolved whenever the interval contains zero', () => {
    const interval = pairedBootstrapInterval({
      clusters: [cluster(-0.4), cluster(0.5), cluster(-0.3), cluster(0.4)],
      seed: 11,
      resamples: 2_000,
    })!;
    expect(interval.lower).toBeLessThan(0);
    expect(interval.upper).toBeGreaterThan(0);
    expect(interval.direction).toBe('unresolved');
  });

  it('reports positive only when the lower bound exceeds zero', () => {
    const positive = pairedBootstrapInterval({
      clusters: [0.4, 0.5, 0.45, 0.55, 0.5].map((d) => cluster(d)),
      seed: 3,
      resamples: 2_000,
    })!;
    expect(positive.lower).toBeGreaterThan(0);
    expect(positive.direction).toBe('positive');

    const negative = pairedBootstrapInterval({
      clusters: [-0.4, -0.5, -0.45, -0.55, -0.5].map((d) => cluster(d)),
      seed: 3,
      resamples: 2_000,
    })!;
    expect(negative.upper).toBeLessThan(0);
    expect(negative.direction).toBe('negative');
  });

  it('weights tasks by task.weight', () => {
    // Hand-computed: (3*1.0 + 1*(-1.0)) / 4 = 0.5
    expect(weightedMean([cluster(1, 3), cluster(-1, 1)])).toBeCloseTo(0.5, 12);
    const interval = pairedBootstrapInterval({
      clusters: [cluster(1, 3), cluster(-1, 1)],
      seed: 5,
      resamples: 500,
    })!;
    expect(interval.point).toBeCloseTo(0.5, 12);
  });

  it('is exactly reproducible from the recorded seed', () => {
    const clusters = [0.2, -0.1, 0.4, 0.05].map((d) => cluster(d));
    const first = pairedBootstrapInterval({
      clusters,
      seed: 99,
      resamples: 1_000,
    })!;
    const second = pairedBootstrapInterval({
      clusters,
      seed: first.seed,
      resamples: first.resamples,
      level: first.level,
    })!;
    expect(second.lower).toBe(first.lower);
    expect(second.upper).toBe(first.upper);
    expect(second.point).toBe(first.point);
  });

  it('returns unmeasured when the pairing precondition fails', () => {
    const taskA = { id: 'a' };
    const taskB = { id: 'b' };
    expect(
      clustersFromPairedRecords(
        [{ task: taskA, score: 1 }],
        [{ task: taskB, score: 1 }]
      )
    ).toBeUndefined();
    expect(
      clustersFromPairedRecords(
        [{ task: taskA, score: 1 }],
        [
          { task: taskA, score: 1 },
          { task: taskB, score: 1 },
        ]
      )
    ).toBeUndefined();
    expect(clustersFromPairedRecords([], [])).toBeUndefined();
    expect(
      pairedBootstrapInterval({ clusters: [], seed: 1, resamples: 500 })
    ).toBeUndefined();
    expect(
      pairedBootstrapInterval({
        clusters: [{ weight: 1, deltas: [Number.NaN] }],
        seed: 1,
        resamples: 500,
      })
    ).toBeUndefined();
  });

  it('rejects out-of-range interval options before anything runs', () => {
    for (const bad of [
      { resamples: 199 },
      { resamples: 100_001 },
      { resamples: 1.5 },
      { level: 0 },
      { level: 1 },
      { seed: 1.5 },
    ]) {
      const error = (() => {
        try {
          validateIntervalOptions(bad as any);
          return undefined;
        } catch (err) {
          return err;
        }
      })();
      expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
      expect((error as any).code).toBe('interval_options_invalid');
    }
    expect(validateIntervalOptions()).toEqual({
      resamples: 10_000,
      level: 0.95,
    });
  });

  it('derives a stable seed from a task-set digest', () => {
    expect(seedFromDigest('fnv1a64:0123456789abcdef')).toBe(
      seedFromDigest('fnv1a64:0123456789abcdef')
    );
    expect(seedFromDigest('fnv1a64:0000000000000001')).not.toBe(
      seedFromDigest('fnv1a64:0000000000000002')
    );
  });
});

describe('variance band', () => {
  const recordsOf = (tasks: readonly object[], scores: readonly number[]) =>
    tasks.map((task, index) => ({ task, score: scores[index]! }));

  it('computes spread as max mean minus min mean', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const band = varianceBandFrom({
      split: 'current',
      repeats: [
        recordsOf(tasks, [0.5, 0.5, 0.5]),
        recordsOf(tasks, [0.6, 0.5, 0.5]),
        recordsOf(tasks, [0.4, 0.5, 0.5]),
      ],
      means: [0.5, 0.533, 0.466],
      seed: 21,
      resamples: 500,
    })!;
    expect(band.repeats).toBe(3);
    expect(band.spread).toBeCloseTo(0.533 - 0.466, 10);
    expect(band.interval.unit).toBe('task');
    expect(band.interval.clusters).toBe(3);
  });

  it('keeps a repeated task object as its own cluster', () => {
    // A split may legitimately hold the same task object twice. Clustering by
    // task identity collapses them into one cluster and NARROWS the band, so
    // the count is pinned to the number of positions, not distinct objects.
    const repeated = { id: 'a' };
    const tasks = [repeated, repeated, { id: 'b' }];
    const band = varianceBandFrom({
      split: 'current',
      repeats: [
        recordsOf(tasks, [0.5, 0.5, 0.5]),
        recordsOf(tasks, [0.9, 0.1, 0.5]),
      ],
      means: [0.5, 0.5],
      seed: 7,
      resamples: 500,
    })!;
    expect(band.interval.clusters).toBe(3);
  });

  it('is unmeasured with fewer than two repeats or on a broken pairing', () => {
    const tasks = [{ id: 'a' }];
    expect(
      varianceBandFrom({
        split: 'current',
        repeats: [recordsOf(tasks, [0.5])],
        means: [0.5],
        seed: 1,
        resamples: 500,
      })
    ).toBeUndefined();
    expect(
      varianceBandFrom({
        split: 'current',
        repeats: [recordsOf(tasks, [0.5]), recordsOf([{ id: 'other' }], [0.5])],
        means: [0.5, 0.5],
        seed: 1,
        resamples: 500,
      })
    ).toBeUndefined();
  });
});

// --- overhead --------------------------------------------------------------

describe('anchor-vs-candidate overhead', () => {
  const attempt = (
    over: Partial<AxAgentPlaybookAttemptRecord>
  ): AxAgentPlaybookAttemptRecord => ({
    attempt: 0,
    redraw: 0,
    score: 1,
    termination: { kind: 'completed' },
    callCount: 1,
    turnCount: 1,
    latencyMs: 1,
    ...over,
  });

  it('reports turn and call overhead with intervals', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }];
    const anchor = tasks.map((task) => ({
      task,
      attempts: [attempt({ turnCount: 10, callCount: 4 })],
    }));
    const candidate = tasks.map((task) => ({
      task,
      attempts: [attempt({ turnCount: 14, callCount: 5 })],
    }));
    const split = overheadSplitFrom({
      split: 'heldOut',
      anchor,
      candidate,
      seed: 4,
      resamples: 500,
    })!;
    expect(split.turns.anchorMean).toBe(10);
    expect(split.turns.candidateMean).toBe(14);
    expect(split.turns.delta).toBe(4);
    expect(split.turns.relativeDelta).toBeCloseTo(0.4, 12);
    expect(split.calls.relativeDelta).toBeCloseTo(0.25, 12);
    // No usage was reported on either side, so tokens are omitted, not zeroed.
    expect(split.tokens).toBeUndefined();

    const report = overheadReportFrom([split])!;
    expect(report.worstRelativeDelta).toBeCloseTo(0.4, 12);
  });

  it('excludes discarded attempts from the per-task mean', () => {
    const tasks = [{ id: 'a' }];
    const anchor = tasks.map((task) => ({
      task,
      attempts: [attempt({ turnCount: 4 })],
    }));
    const candidate = tasks.map((task) => ({
      task,
      attempts: [
        attempt({ turnCount: 4 }),
        attempt({
          turnCount: 1_000,
          score: undefined,
          termination: { kind: 'environment_failure', cause: 'network' },
        }),
      ],
    }));
    const split = overheadSplitFrom({
      split: 'current',
      anchor,
      candidate,
      seed: 1,
      resamples: 500,
    })!;
    expect(split.turns.candidateMean).toBe(4);
    expect(split.turns.delta).toBe(0);
  });

  it('omits relativeDelta rather than reporting infinity against a zero anchor', () => {
    const tasks = [{ id: 'a' }];
    const split = overheadSplitFrom({
      split: 'current',
      anchor: tasks.map((task) => ({
        task,
        attempts: [attempt({ turnCount: 0, callCount: 0 })],
      })),
      candidate: tasks.map((task) => ({
        task,
        attempts: [attempt({ turnCount: 3, callCount: 0 })],
      })),
      seed: 1,
      resamples: 500,
    })!;
    expect(split.turns.relativeDelta).toBeUndefined();
    expect(split.turns.delta).toBe(3);
  });

  it('is unmeasured when the pairing breaks or attempts are absent', () => {
    expect(
      overheadSplitFrom({
        split: 'current',
        anchor: [{ task: { id: 'a' }, attempts: [attempt({})] }],
        candidate: [{ task: { id: 'b' }, attempts: [attempt({})] }],
        seed: 1,
        resamples: 500,
      })
    ).toBeUndefined();
    const shared = { id: 'a' };
    expect(
      overheadSplitFrom({
        split: 'current',
        anchor: [{ task: shared }],
        candidate: [{ task: shared }],
        seed: 1,
        resamples: 500,
      })
    ).toBeUndefined();
    expect(overheadReportFrom([])).toBeUndefined();
  });
});

// --- validity.ts -----------------------------------------------------------

describe('validity conjuncts', () => {
  const predictionOf = (over: Record<string, any> = {}) => ({
    completionType: 'final' as const,
    output: {},
    actionLog: '',
    functionCalls: [],
    toolErrors: [],
    turnCount: 1,
    ...over,
  });

  const recordOf = (over: Record<string, any> = {}) => ({
    task: { input: {}, criteria: 'c' },
    score: 1,
    passed: true,
    prediction: predictionOf(over.prediction ?? {}),
    ...(over.attempts ? { attempts: over.attempts } : {}),
  });

  const attemptOf = (over: Partial<AxAgentPlaybookAttemptRecord> = {}) =>
    ({
      attempt: 0,
      redraw: 0,
      score: 1,
      termination: { kind: 'completed' },
      callCount: 0,
      turnCount: 1,
      latencyMs: 10,
      ...over,
    }) as AxAgentPlaybookAttemptRecord;

  const find = (report: any, id: string, split = 'current') =>
    report.predicates.find((p: any) => p.id === id && p.split === split);

  it('computes final_completion_rate from completionType', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf(),
            recordOf(),
            recordOf({
              prediction: { completionType: 'askClarification' },
            }),
          ],
        },
      ],
    });
    const predicate = find(report, 'final_completion_rate');
    expect(predicate.observed).toBeCloseTo(2 / 3, 12);
    expect(predicate.threshold).toBe(0.9);
    expect(predicate.status).toBe('fail');
    expect(report.failed).toBe('validity:final_completion_rate@current');
  });

  it('exports no predicate named output_schema_compliance', () => {
    // Ax has no schema-validation outcome on a prediction, so a predicate with
    // that name would be claiming a measurement that does not exist.
    const report = evaluateValidity({
      inputs: [{ split: 'current', records: [recordOf()] }],
    });
    expect(
      report.predicates.some(
        (p) => (p.id as string) === 'output_schema_compliance'
      )
    ).toBe(false);
    expect(validityPredicateName('final_completion_rate', 'current')).toBe(
      'validity:final_completion_rate@current'
    );
  });

  it('detects assertion failures by error name and by cause name', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              attempts: [
                attemptOf({ errorName: 'AxAssertionError' }),
                attemptOf({
                  errorName: 'AxGenerateError',
                  errorCauseName: 'AxStreamingAssertionError',
                }),
                attemptOf({}),
                attemptOf({}),
              ],
            }),
          ],
        },
      ],
    });
    const predicate = find(report, 'assertion_pass_rate');
    expect(predicate.observed).toBeCloseTo(0.5, 12);
    expect(predicate.status).toBe('fail');
  });

  it('reports assertion_pass_rate unmeasured without attempt records', () => {
    const report = evaluateValidity({
      inputs: [{ split: 'current', records: [recordOf()] }],
    });
    const predicate = find(report, 'assertion_pass_rate');
    expect(predicate.status).toBe('unmeasured');
    expect(predicate.observed).toBeUndefined();
  });

  it('computes unknown_function_call_rate in Ax from the registered set', () => {
    // No host classifier: the rate is Ax's own reading.
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  { qualifiedName: 'db.search', name: 'search', arguments: {} },
                  { qualifiedName: 'ghost.call', name: 'call', arguments: {} },
                ],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
    });
    const predicate = find(report, 'unknown_function_call_rate');
    expect(predicate.observed).toBeCloseTo(0.5, 12);
    expect(predicate.status).toBe('fail');
    expect(predicate.overriddenByHost).toBeUndefined();
  });

  it('is unmeasured when the registered set cannot be resolved', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  { qualifiedName: 'db.search', name: 'search', arguments: {} },
                ],
              },
            }),
          ],
        },
      ],
    });
    expect(find(report, 'unknown_function_call_rate').status).toBe(
      'unmeasured'
    );
  });

  it('records overriddenByHost when a classifier changes the computed value', () => {
    // A classifier returning 'ok' for everything is recorded, not hidden.
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  { qualifiedName: 'ghost.call', name: 'call', arguments: {} },
                ],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
      options: { classifyFunctionCall: () => 'ok' },
    });
    const predicate = find(report, 'unknown_function_call_rate');
    expect(predicate.observed).toBe(0);
    expect(predicate.status).toBe('pass');
    expect(predicate.overriddenByHost).toBe(true);
  });

  it('counts a failing call once even though the pipeline also derives prediction.toolErrors from it', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  {
                    qualifiedName: 'db.search',
                    name: 'search',
                    arguments: {},
                    error: 'timeout',
                  },
                  { qualifiedName: 'db.search', name: 'search', arguments: {} },
                ],
                // Exactly what pipelineForwardForEvaluation derives from the
                // call above. Summing both sources would report 1.0.
                toolErrors: ['db.search: timeout'],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
      options: { maxToolErrorRate: 0.6 },
    });
    const predicate = find(report, 'tool_error_rate');
    expect(predicate.observed).toBeCloseTo(0.5, 12);
    expect(predicate.status).toBe('pass');
  });

  it('counts a prediction-level tool error with no matching call exactly once', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  { qualifiedName: 'db.search', name: 'search', arguments: {} },
                ],
                toolErrors: ['sandbox unavailable', 'sandbox unavailable'],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
      options: { maxToolErrorRate: 0.9 },
    });
    const predicate = find(report, 'tool_error_rate');
    // 1 unmatched error over (1 call + 1 unmatched error).
    expect(predicate.observed).toBeCloseTo(0.5, 12);
    expect(predicate.status).toBe('pass');
  });

  it('never reports a tool_error_rate above 1', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  {
                    qualifiedName: 'db.search',
                    name: 'search',
                    arguments: {},
                    error: 'timeout',
                  },
                  {
                    qualifiedName: 'db.search',
                    name: 'search',
                    arguments: {},
                    error: 'timeout',
                  },
                ],
                toolErrors: [
                  'db.search: timeout',
                  'db.search: timeout',
                  'sandbox unavailable',
                ],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
      options: { maxToolErrorRate: 0.1 },
    });
    const predicate = find(report, 'tool_error_rate');
    expect(predicate.observed).toBeLessThanOrEqual(1);
    // 2 errored calls + 1 unmatched entry over 2 calls + 1 unmatched entry.
    expect(predicate.observed).toBeCloseTo(1, 12);
    expect(predicate.status).toBe('fail');
  });

  it('keeps a host "ok" override authoritative over the derived toolErrors string', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              prediction: {
                functionCalls: [
                  {
                    qualifiedName: 'db.search',
                    name: 'search',
                    arguments: {},
                    error: 'timeout',
                  },
                ],
                toolErrors: ['db.search: timeout'],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
      options: { maxToolErrorRate: 0, classifyFunctionCall: () => 'ok' },
    });
    const predicate = find(report, 'tool_error_rate');
    expect(predicate.observed).toBe(0);
    expect(predicate.status).toBe('pass');
    expect(predicate.overriddenByHost).toBe(true);
  });

  it('names the failing predicate with its split and runs on both splits', () => {
    const report = evaluateValidity({
      inputs: [
        { split: 'current', records: [recordOf({ attempts: [attemptOf()] })] },
        {
          split: 'heldOut',
          records: [
            recordOf({
              attempts: [attemptOf()],
              prediction: {
                functionCalls: [
                  {
                    qualifiedName: 'db.search',
                    name: 'search',
                    arguments: {},
                    error: 'boom',
                  },
                ],
              },
            }),
          ],
        },
      ],
      registered: new Set(['db.search']),
      options: { maxToolErrorRate: 0 },
    });
    expect(report.predicates.some((p) => p.split === 'heldOut')).toBe(true);
    expect(report.failed).toBe('validity:tool_error_rate@heldOut');
  });

  it('leaves token and latency ceilings off unless configured', () => {
    const withoutCeilings = evaluateValidity({
      inputs: [
        { split: 'current', records: [recordOf({ attempts: [attemptOf()] })] },
      ],
    });
    expect(find(withoutCeilings, 'token_ceiling')).toBeUndefined();
    expect(find(withoutCeilings, 'latency_ceiling')).toBeUndefined();

    const withCeilings = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              attempts: [attemptOf({ totalTokens: 900, latencyMs: 50 })],
            }),
          ],
        },
      ],
      options: { maxMeanTotalTokens: 500, maxMeanLatencyMs: 100 },
    });
    expect(find(withCeilings, 'token_ceiling').status).toBe('fail');
    expect(find(withCeilings, 'latency_ceiling').status).toBe('pass');
  });

  it('excludes discarded attempts from the assertion denominator', () => {
    const report = evaluateValidity({
      inputs: [
        {
          split: 'current',
          records: [
            recordOf({
              attempts: [
                attemptOf({}),
                attemptOf({
                  score: undefined,
                  termination: {
                    kind: 'environment_failure',
                    cause: 'network',
                  },
                  errorName: 'AxAssertionError',
                }),
              ],
            }),
          ],
        },
      ],
    });
    expect(find(report, 'assertion_pass_rate').observed).toBe(1);
  });

  it('resolves the registered function set structurally or reports undefined', () => {
    expect(
      registeredFunctionNames({
        options: { functions: [{ name: 'search', namespace: 'db' }] },
      })
    ).toEqual(new Set(['search', 'db.search']));
    expect(registeredFunctionNames({})).toBeUndefined();
    expect(
      registeredFunctionNames({ options: { functions: [] } })
    ).toBeUndefined();
    expect(registeredFunctionNames(undefined)).toBeUndefined();
  });
});

// --- reach.ts --------------------------------------------------------------

describe('reach instrumentation', () => {
  const task = (id: string) => ({ input: {}, criteria: 'c', id });
  const clock = () => {
    let value = 0;
    return () => {
      value += 1;
      return value;
    };
  };

  const collectorOf = (over: Record<string, any> = {}) =>
    createReachCollector({
      candidateBulletIds: ['b1'],
      renderedBulletIds: ['b1', 'b2'],
      now: clock(),
      nowIso: '2026-01-01T00:00:00.000Z',
      ...over,
    });

  it('sets gateEligible only for the host_probe basis', () => {
    const probed = collectorOf({
      probe: () => ({ applicableAtDecidingStep: true, invocations: 1 }),
    });
    probed.observe({ task: task('t1'), split: 'current' });
    expect(probed.report().report).toMatchObject({
      basis: 'host_probe',
      counterfactual: false,
      gateEligible: true,
    });

    const counterfactual = collectorOf({
      conditionsForTask: () => [],
      candidateBullets: [],
    });
    counterfactual.observe({ task: task('t1'), split: 'current' });
    expect(counterfactual.report().report).toMatchObject({
      basis: 'applicability_counterfactual',
      counterfactual: true,
      gateEligible: false,
    });

    const rendered = collectorOf();
    rendered.observe({ task: task('t1'), split: 'current' });
    expect(rendered.report().report).toMatchObject({
      basis: 'rendered_only',
      counterfactual: true,
      gateEligible: false,
    });
  });

  it('reports reachRate 1.0 for an unconstrained bullet AND labels it', () => {
    // The honest-reporting case: an evolve-curated bullet has no applicability
    // tokens, so isBulletApplicable returns true for every task. A 1.0
    // appearing UNLABELLED in a receipt is the failure this asserts against —
    // the assertion is on the label, not on the number.
    const collector = collectorOf({
      conditionsForTask: () => ['anything'],
      candidateBullets: [
        { id: 'b1', content: 'never call undeclared helpers', section: 's' },
      ],
    });
    for (const id of ['t1', 't2', 't3']) {
      collector.observe({ task: task(id), split: 'current' });
    }
    const { report, warnings } = collector.report({ delta: 0.2 });
    expect(report.splits[0]?.reachRate).toBe(1);
    expect(report.splits[0]?.counterfactual).toBe(true);
    expect(report.gateEligible).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('reach_counterfactual_basis');
  });

  it('reports invocations per episode under the host probe', () => {
    const collector = collectorOf({
      probe: () => ({ applicableAtDecidingStep: true, invocations: 2 }),
    });
    collector.observe({ task: task('t1'), split: 'heldOut' });
    collector.observe({ task: task('t2'), split: 'heldOut' });
    const split = collector.report().report.splits[0]!;
    expect(split.reachedTasks).toBe(2);
    expect(split.invocationsPerEpisode).toBe(2);
  });

  it('marks the split unmeasured when the probe throws, without failing the run', () => {
    const collector = collectorOf({
      probe: () => {
        throw new Error('probe exploded');
      },
    });
    expect(() =>
      collector.observe({ task: task('t1'), split: 'current' })
    ).not.toThrow();
    const { report, warnings } = collector.report({ delta: 0.2 });
    expect(report.gateEligible).toBe(false);
    expect(report.splits[0]?.reachRate).toBe(0);
    expect(warnings.map((w) => w.code)).toContain('reach_probe_failed');
  });

  it('does not let a throwing conditionsForTask abort the run', () => {
    // Symmetric with the probe path: a faulty caller callback marks the split
    // unmeasured, it does not take the whole evolve() run down.
    const collector = collectorOf({
      conditionsForTask: () => {
        throw new Error('caller conditions blew up');
      },
      candidateBullets: [{ id: 'b1', content: 'x' }],
    });
    expect(() =>
      collector.observe({ task: task('t1'), split: 'current' })
    ).not.toThrow();
    expect(() =>
      collector.observe({ task: task('t2'), split: 'current' })
    ).not.toThrow();
    const { report, warnings } = collector.report({ delta: 0.2 });
    expect(report.basis).toBe('applicability_counterfactual');
    expect(report.gateEligible).toBe(false);
    expect(report.splits[0]?.reachRate).toBe(0);
    const fault = warnings.find((w) => w.code === 'reach_probe_failed');
    expect(fault?.message).toMatch(/conditionsForTask threw/);
  });

  it('rejects a malformed observation rather than trusting it', () => {
    const collector = collectorOf({
      probe: () => ({ applicableAtDecidingStep: true, invocations: -1 }) as any,
    });
    collector.observe({ task: task('t1'), split: 'current' });
    const { report, warnings } = collector.report();
    expect(report.gateEligible).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('reach_probe_failed');
  });

  it('disables a probe that exceeds its cumulative budget', () => {
    let now = 0;
    const collector = createReachCollector({
      candidateBulletIds: ['b1'],
      renderedBulletIds: ['b1'],
      now: () => {
        now += 40;
        return now;
      },
      nowIso: '2026-01-01T00:00:00.000Z',
      probeBudgetMs: 50,
      probe: () => ({ applicableAtDecidingStep: true, invocations: 1 }),
    });
    for (const id of ['t1', 't2', 't3']) {
      collector.observe({ task: task(id), split: 'current' });
    }
    const { report, warnings } = collector.report();
    expect(report.gateEligible).toBe(false);
    expect(
      warnings.find((w) => w.code === 'reach_probe_failed')?.message
    ).toMatch(/cumulative budget/);
  });

  it('warns reach_zero_positive_delta when a host-probed reach is 0 and the delta is positive', () => {
    const collector = collectorOf({
      probe: () => ({ applicableAtDecidingStep: false, invocations: 0 }),
    });
    collector.observe({ task: task('t1'), split: 'current' });
    const { warnings } = collector.report({ delta: 0.3 });
    expect(warnings.map((w) => w.code)).toContain('reach_zero_positive_delta');
  });

  it('warns reach_unmeasured on a rendered-only basis with a positive delta', () => {
    const collector = collectorOf();
    collector.observe({ task: task('t1'), split: 'current' });
    const { warnings } = collector.report({ delta: 0.3 });
    expect(warnings.map((w) => w.code)).toContain('reach_unmeasured');
  });
});

// --- gates.ts + evidenceReceipt.ts -----------------------------------------

describe('gate chain', () => {
  const baseInput = (over: Record<string, any> = {}): any => ({
    kind: 'curate',
    gain: { revalComplete: true, currentGain: 0.2, threshold: 0.05 },
    ...over,
  });

  it('reports every gate including the skipped ones, in decision order', async () => {
    const report = await evaluateGateChain(baseInput());
    expect(report.entries.map((entry) => entry.id)).toEqual(GATE_ORDER);
    expect(gateChainAccepts(report)).toBe(true);
    const skipped = report.entries.filter(
      (entry) => entry.status === 'skipped'
    );
    expect(skipped.length).toBeGreaterThan(0);
    for (const entry of skipped) expect(entry.detail).toBeTruthy();
  });

  it('names the first required failure in decision order', async () => {
    const report = await evaluateGateChain(
      baseInput({
        gain: { revalComplete: true, currentGain: 0, threshold: 0.05 },
        heldOut: { delta: -1, tolerance: 0.01 },
      })
    );
    // Both gain and held_out fail; `gain` comes first in decision order.
    expect(report.failedGate).toBe('gain');
    expect(gateChainAccepts(report)).toBe(false);
  });

  it('never spends a host call on a candidate an earlier gate already rejected', async () => {
    const veto = vi.fn(async () => ({ vetoed: false, detail: 'no veto' }));
    const authority = vi.fn(async () => ({ allowed: true, detail: 'allowed' }));
    const report = await evaluateGateChain(
      baseInput({
        gain: { revalComplete: true, currentGain: 0, threshold: 0.05 },
        veto,
        authority,
      })
    );
    expect(report.failedGate).toBe('gain');
    // THE property: the two host-call gates are thunks and neither ran.
    expect(veto).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
    // They are still reported, with the reason they were not evaluated.
    const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
    expect(byId.get('veto')?.status).toBe('skipped');
    expect(byId.get('veto')?.detail).toContain(
      'the gain gate already rejected'
    );
    expect(byId.get('authority')?.status).toBe('skipped');
  });

  it('invokes both host-call thunks exactly once when every free gate passes', async () => {
    const veto = vi.fn(async () => ({ vetoed: false, detail: 'no veto' }));
    const authority = vi.fn(async () => ({ allowed: true, detail: 'allowed' }));
    const report = await evaluateGateChain(baseInput({ veto, authority }));
    expect(veto).toHaveBeenCalledTimes(1);
    expect(authority).toHaveBeenCalledTimes(1);
    expect(gateChainAccepts(report)).toBe(true);
  });

  it('stops before the authority call when the veto gate rejects', async () => {
    const veto = vi.fn(async () => ({ vetoed: true, detail: 'host vetoed' }));
    const authority = vi.fn(async () => ({ allowed: true, detail: 'allowed' }));
    const report = await evaluateGateChain(baseInput({ veto, authority }));
    expect(veto).toHaveBeenCalledTimes(1);
    expect(authority).not.toHaveBeenCalled();
    expect(report.failedGate).toBe('veto');
    expect(report.failedPredicate).toBe('host vetoed');
    expect(gateChainAccepts(report)).toBe(false);
  });

  it('passes a zero-gain prune under the loss-tolerance variant', async () => {
    // The decisive prune test: a removal with currentGain 0 and maxCurrentLoss
    // 0 must reach the later gates, not be short-circuited by the curate
    // threshold of 0.05. A curate-variant implementation fails here.
    const report = await evaluateGateChain({
      kind: 'prune',
      gain: { revalComplete: true, currentGain: 0, threshold: 0 },
      heldOut: { delta: 0, tolerance: 0.01 },
      pruneSize: {
        tokensBefore: 120,
        tokensAfter: 100,
        minTokenReduction: 1,
      },
    });
    expect(report.entries.find((entry) => entry.id === 'gain')?.status).toBe(
      'pass'
    );
    expect(
      report.entries.find((entry) => entry.id === 'prune_size')?.status
    ).toBe('pass');
    expect(gateChainAccepts(report)).toBe(true);
  });

  it('rejects a prune that loses more than the tolerance', async () => {
    const report = await evaluateGateChain({
      kind: 'prune',
      gain: { revalComplete: true, currentGain: -0.2, threshold: 0 },
      pruneSize: {
        tokensBefore: 120,
        tokensAfter: 100,
        minTokenReduction: 1,
      },
    });
    expect(report.failedGate).toBe('gain');
    expect(
      report.entries.find((entry) => entry.id === 'gain')?.detail
    ).toContain('prune current-task loss');
  });

  it('rejects a prune that does not shrink the rendered playbook enough', async () => {
    const report = await evaluateGateChain({
      kind: 'prune',
      gain: { revalComplete: true, currentGain: 0, threshold: 0 },
      pruneSize: {
        tokensBefore: 100,
        tokensAfter: 100,
        minTokenReduction: 1,
      },
    });
    expect(report.failedGate).toBe('prune_size');
  });

  it('skips the reach gate for a prune because a removed bullet has no reach', async () => {
    const report = await evaluateGateChain({
      kind: 'prune',
      gain: { revalComplete: true, currentGain: 0, threshold: 0 },
      pruneSize: { tokensBefore: 10, tokensAfter: 1, minTokenReduction: 1 },
      reach: {
        mode: 'require',
        report: {
          basis: 'host_probe',
          counterfactual: false,
          gateEligible: true,
          splits: [],
        },
      },
    });
    expect(report.entries.find((entry) => entry.id === 'reach')?.status).toBe(
      'skipped'
    );
  });

  it('names the environment-failure reason distinctly from the budget one', async () => {
    const report = await evaluateGateChain(
      baseInput({
        gain: {
          revalComplete: false,
          currentGain: 0,
          threshold: 0.05,
          incompleteFromEnvironmentFailures: true,
          tasksWithNoScoredAttempt: 1,
        },
      })
    );
    expect(report.failedPredicate).toBe(
      'evaluation incomplete due to environment failures (1 tasks)'
    );
    expect(report.failedPredicate).not.toContain('metric_budget');
  });

  it('fails a required reach gate on any counterfactual basis', async () => {
    for (const basis of [
      'applicability_counterfactual',
      'rendered_only',
    ] as const) {
      const report = await evaluateGateChain(
        baseInput({
          reach: {
            mode: 'require',
            report: {
              basis,
              counterfactual: true,
              gateEligible: false,
              splits: [
                {
                  split: 'current',
                  basis,
                  counterfactual: true,
                  taskCount: 3,
                  reachedTasks: 3,
                  reachRate: 1,
                },
              ],
            },
          },
        })
      );
      // reachRate is 1.0 and the gate still fails: the gate reads
      // gateEligible, never the rate.
      expect(report.failedGate).toBe('reach');
      expect(report.entries.find((entry) => entry.id === 'reach')?.status).toBe(
        'unmeasured'
      );
    }
  });

  it('carries the failing validity predicate verbatim into the report', async () => {
    const report = await evaluateGateChain(
      baseInput({
        validity: {
          mode: 'require',
          report: {
            predicates: [
              {
                id: 'tool_error_rate',
                split: 'heldOut',
                status: 'fail',
                observed: 0.31,
                threshold: 0.1,
                name: 'validity:tool_error_rate@heldOut',
              },
            ],
            required: ['tool_error_rate'],
            failed: 'validity:tool_error_rate@heldOut',
          },
        },
      })
    );
    expect(report.failedGate).toBe('validity');
    expect(report.failedPredicate).toBe('validity:tool_error_rate@heldOut');
  });

  it('treats an unmeasured interval as a failure under require and a warning under warn', async () => {
    const required = await evaluateGateChain(
      baseInput({ interval: { mode: 'require' } })
    );
    expect(required.failedGate).toBe('interval');
    const warned = await evaluateGateChain(
      baseInput({ interval: { mode: 'warn' } })
    );
    // 'warn' surfaces the unmeasured reading without rejecting the candidate.
    expect(warned.failedGate).toBeUndefined();
    expect(
      warned.entries.find((entry) => entry.id === 'interval')?.status
    ).toBe('unmeasured');
  });

  it('requires the point delta to beat the variance band when one is configured', async () => {
    const interval = {
      point: 0.02,
      lower: 0.01,
      upper: 0.03,
      level: 0.95,
      resamples: 1_000,
      unit: 'task' as const,
      clusters: 3,
      seed: 1,
      direction: 'positive' as const,
    };
    const withinBand = await evaluateGateChain(
      baseInput({
        interval: { mode: 'require', current: interval, bandSpread: 0.05 },
      })
    );
    expect(withinBand.failedGate).toBe('interval');
    const beatsBand = await evaluateGateChain(
      baseInput({
        interval: { mode: 'require', current: interval, bandSpread: 0.005 },
      })
    );
    expect(beatsBand.failedGate).toBeUndefined();
    // Without a band the detail says so, so the weaker reading is visible.
    const noBand = await evaluateGateChain(
      baseInput({ interval: { mode: 'warn', current: interval } })
    );
    expect(
      noBand.entries.find((entry) => entry.id === 'interval')?.detail
    ).toContain('excludes zero');
  });
});

describe('evidence receipt', () => {
  const interval = {
    point: 0.2,
    lower: 0.1,
    upper: 0.3,
    level: 0.95,
    resamples: 1_000,
    unit: 'task' as const,
    clusters: 3,
    seed: 7,
    direction: 'positive' as const,
  };
  const nomination = {
    candidateDigest: 'fnv1a64:aaaa',
    splitDigests: { current: 'fnv1a64:bbbb', slices: [] },
    splitDigestBasis: 'task_ids' as const,
    promotionDigest: 'fnv1a64:cccc',
    resourceId: '',
    gatesPassed: [],
    gatesFailed: [],
    nominated: true,
  };
  const receiptArgs = (over: Record<string, any> = {}) =>
    ({
      kind: 'curate' as const,
      nomination,
      intervals: { current: interval },
      reach: {
        basis: 'rendered_only' as const,
        counterfactual: true,
        gateEligible: false,
        splits: [],
      },
      validity: { predicates: [], required: [] },
      termination: {
        splits: [],
        worstDiscardRate: 0,
        incompleteFromEnvironmentFailures: false,
      },
      gates: { entries: [] },
      promotion: { status: 'not_required' as const, nomination },
      accounting: emptyAccounting(),
      selectionComparisons: 3,
      level: 0.95,
      warnings: [],
      decision: 'accepted' as const,
      ...over,
    }) as any;

  it('digests every field except the digest and stays stable otherwise', () => {
    const first = buildEvidenceReceipt(receiptArgs());
    const same = buildEvidenceReceipt(receiptArgs());
    const changed = buildEvidenceReceipt(receiptArgs({ decision: 'rejected' }));
    expect(first.digest).toBe(same.digest);
    expect(changed.digest).not.toBe(first.digest);
    expect(evidenceReceiptDigest(first)).toBe(first.digest);
  });

  it('is recursively frozen', () => {
    const receipt = buildEvidenceReceipt(receiptArgs());
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.intervals)).toBe(true);
    expect(Object.isFrozen(receipt.heldOutContamination)).toBe(true);
  });

  it('always carries the held-out contamination disclosure', () => {
    const receipt = buildEvidenceReceipt(receiptArgs());
    expect(receipt.heldOutContamination.selectionComparisons).toBe(3);
    // 1 - 0.95^3
    expect(receipt.heldOutContamination.impliedFamilyWiseErrorRate).toBeCloseTo(
      0.142625,
      6
    );
    expect(receipt.heldOutContamination.sealed).toBe(false);
    expect(impliedFamilyWiseErrorRate(0, 0.95)).toBe(0);
    expect(impliedFamilyWiseErrorRate(4, 0.95)).toBeCloseTo(0.185, 3);
  });
});
