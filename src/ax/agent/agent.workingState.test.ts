/**
 * Loop-level working-state wiring: stage scoping, the per-`forward()` run id,
 * receipt minting at the dispatch site, the turn hook and the optional
 * completion interlock.
 *
 * Every scenario drives a real `agent(...)` over a scripted mock model and an
 * EVALUATING code runtime, so a tool call in the actor's code really reaches
 * `wrapFunction`. A stub that pattern-matched the call string could not tell a
 * real dispatch from a fabricated one, which is the whole point of the gate.
 */

import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../ai/types.js';
import { AxInMemoryProgramStateStore } from '../event/memoryStore.js';
import {
  type AxWorkingStateScript,
  axCreateEvaluatingRuntime,
  axCreateScriptedMock,
} from './agentInternal/workingStateHarness.js';
import type { AxAgentFunction } from './index.js';
import { agent } from './index.js';
import type {
  AxWorkingStateConfig,
  AxWorkingStateGoal,
} from './workingState.js';

const STATE_SIGNATURE = 'orderId:string, itemsPacked:number, shipped:boolean';

function seededGoal(
  id: string,
  overrides?: Partial<AxWorkingStateGoal>
): AxWorkingStateGoal {
  return {
    id,
    goal: `complete ${id}`,
    status: 'pending',
    evidence: [],
    createdTurn: 0,
    updatedTurn: 0,
    ...overrides,
  };
}

const pickFn: AxAgentFunction = {
  name: 'pick',
  description: 'Pick a line on an order',
  namespace: 'inventory',
  parameters: {
    type: 'object',
    properties: { order: { type: 'string', description: 'order id' } },
    required: ['order'],
  },
  func: async () => ({ picked: 3 }),
};

/** A void-returning tool: the receipt predicate must not require a result. */
const noteFn: AxAgentFunction = {
  name: 'note',
  description: 'Record a note; returns nothing',
  namespace: 'inventory',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'note' } },
    required: ['text'],
  },
  func: async () => undefined,
};

/**
 * A tool that completes the run from inside its own implementation. Its
 * recorder record is byte-identical in SHAPE to a void-returning tool's, which
 * is why the two are disambiguated at the dispatch site rather than by the
 * absence of an optional `result` field.
 */
const completeFn: AxAgentFunction = {
  name: 'submit',
  description: 'Submit the answer and end the run',
  namespace: 'inventory',
  parameters: {
    type: 'object',
    properties: { answer: { type: 'string', description: 'answer' } },
    required: ['answer'],
  },
  func: async (args, options) => {
    (
      options as { protocol?: { final: (...parts: unknown[]) => never } }
    ).protocol?.final('done', { answer: (args as { answer: string }).answer });
    return undefined;
  },
};

/**
 * An agent-derived callable. `normalizeAgentFunctionCollection` stamps exactly
 * this `_kind: 'internal'` marker on every child agent passed through
 * `functions: [...]`; a child agent's return value is its own `final()`
 * payload, i.e. model self-report, so it can never be environment evidence.
 */
const childAgentFn: AxAgentFunction = {
  name: 'delegate',
  description: 'Ask a child agent',
  namespace: 'agents',
  _kind: 'internal',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: 'question' } },
    required: ['question'],
  },
  func: async () => ({ answer: 'the child says it is done' }),
};

const failFn: AxAgentFunction = {
  name: 'fail',
  description: 'Always throws',
  namespace: 'inventory',
  parameters: { type: 'object', properties: {}, required: [] },
  func: async () => {
    throw new Error('warehouse offline');
  },
};

function makeAgent(
  script: AxWorkingStateScript,
  workingState?: AxWorkingStateConfig<any>,
  extra?: Record<string, unknown>
) {
  const { ai, executorPrompts } = axCreateScriptedMock(script);
  const built = agent('task:string -> answer:string', {
    functions: [pickFn, noteFn, completeFn, childAgentFn, failFn],
    runtime: axCreateEvaluatingRuntime(),
    maxTurns: 6,
    ...(workingState ? { workingState } : {}),
    ...extra,
  });
  return {
    ai: ai as unknown as AxAIService,
    agent: built,
    executorPrompts,
  };
}

const FINAL = 'await final("done", {"answer":"ok"})';
const DISTILL = 'await final("distilled", {"evidence":"summary"})';

describe('working state stage scoping', () => {
  it('the distiller stage constructs no working state and the executor does', async () => {
    // A stage with `executesTools: false` can mint no receipt, so a ledger it
    // maintained would be evidence-free by construction.
    const { agent: built, ai } = makeAgent(
      { distiller: [DISTILL], executor: [FINAL] },
      {
        stateSignature: STATE_SIGNATURE,
        initial: { goals: { g_pick: seededGoal('g_pick') } },
      }
    );

    await built.forward(ai, { task: 'pack order 42' } as never);

    const inner = built as unknown as {
      distiller: { getWorkingState: () => unknown };
      executor: { getWorkingState: () => unknown };
    };
    expect(inner.distiller.getWorkingState()).toBeUndefined();
    expect(inner.executor.getWorkingState()).toBeDefined();
    expect(built.getWorkingState()?.goals.g_pick?.status).toBe('pending');
  });

  it('two forwards use two different store keys and neither conflicts', async () => {
    // A stable PROGRAM id would make the store key constant across runs.
    const store = new AxInMemoryProgramStateStore();
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.pick({order:"42"})', FINAL],
      },
      { stateSignature: STATE_SIGNATURE, store }
    );

    await built.forward(ai, { task: 'first' } as never);
    const firstRunId = built.getState()?.workingState?.runId;
    await built.forward(ai, { task: 'second' } as never);
    const secondRunId = built.getState()?.workingState?.runId;

    expect(firstRunId).toBeDefined();
    expect(secondRunId).toBeDefined();
    expect(secondRunId).not.toBe(firstRunId);
  });

  it('exports the working-state snapshot on AxAgentState only when configured', async () => {
    const withState = makeAgent(
      { distiller: [DISTILL], executor: [FINAL] },
      {
        stateSignature: STATE_SIGNATURE,
        initial: { goals: { g_pick: seededGoal('g_pick') } },
      }
    );
    await withState.agent.forward(withState.ai, { task: 'x' } as never);
    expect(
      withState.agent.getState()?.workingState?.document.goals.g_pick
    ).toBeDefined();

    const without = makeAgent({ distiller: [DISTILL], executor: [FINAL] });
    await without.agent.forward(without.ai, { task: 'x' } as never);
    expect(without.agent.getState()?.workingState).toBeUndefined();
  });

  it('getWorkingState returns undefined after a direct-respond run', async () => {
    // The run ends at the distiller, so no stage maintained state and the
    // getter must say so rather than returning the previous run's document.
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL, 'await respond("Report it", {"n":1})'],
        executor: [FINAL],
      },
      { stateSignature: STATE_SIGNATURE }
    );

    await built.forward(ai, { task: 'first' } as never);
    expect(built.getWorkingState()).toBeDefined();

    await built.forward(ai, { task: 'second' } as never);
    expect(built.getWorkingState()).toBeUndefined();
  });
});

describe('working state receipts from the dispatch site', () => {
  const receiptConfig = (
    overrides?: Partial<AxWorkingStateConfig<any>>
  ): AxWorkingStateConfig<any> => ({
    stateSignature: STATE_SIGNATURE,
    proposer: 'actor',
    initial: {
      goals: { g_pick: seededGoal('g_pick', { expects: ['inventory.pick'] }) },
    },
    ...overrides,
  });

  it('mints a receipt for a successful tool call', async () => {
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.pick({order:"42"})', FINAL],
      },
      receiptConfig()
    );

    await built.forward(ai, { task: 'pack' } as never);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: 'tool_receipt',
      ref: 'r1',
      qualifiedName: 'inventory.pick',
      observations: 1,
    });
    expect(receipts[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The clock is read at the dispatch site, not at turn-hook time.
    expect(receipts[0]!.at).toBeGreaterThan(0);
  });

  it('mints a receipt for a successful tool that returns undefined', async () => {
    // The success predicate is `error === undefined`, never
    // `result !== undefined`: a void-returning tool is still evidence.
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.note({text:"packed"})', FINAL],
      },
      receiptConfig()
    );

    await built.forward(ai, { task: 'note' } as never);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    expect(receipts.map((receipt) => receipt.qualifiedName)).toEqual([
      'inventory.note',
    ]);
  });

  it('mints no receipt for an errored tool call', async () => {
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.fail({})', FINAL],
      },
      receiptConfig()
    );

    await built.forward(ai, { task: 'fail' } as never);
    expect(built.getState()?.workingState?.receipts ?? []).toHaveLength(0);
  });

  it('mints no receipt for a tool that completes the run', async () => {
    // The completion record reaches `observeResult` through the same recorder
    // and is shape-identical to a void-returning tool's. It is disambiguated
    // at the SOURCE, never by a missing optional field — so the void-returning
    // tool above mints while this one does not.
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.submit({answer:"ok"})'],
      },
      receiptConfig()
    );

    const result = await built.forward(ai, { task: 'finish' } as never);
    // The tool really ran and really completed the run, so the absence of a
    // receipt is a decision rather than a no-op.
    expect(result).toMatchObject({ answer: expect.any(String) });
    expect(built.getState()?.actionLogEntries?.length).toBe(1);
    expect(built.getState()?.workingState?.receipts ?? []).toHaveLength(0);
  });

  it('mints no receipt for an agent-derived callable', async () => {
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'await agents.delegate({question:"is it packed?"}); await inventory.pick({order:"42"})',
          FINAL,
        ],
      },
      receiptConfig()
    );

    await built.forward(ai, { task: 'delegate' } as never);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    // The real tool in the same turn still mints, so the assertion is about
    // eligibility rather than about receipts being broken.
    expect(receipts.map((receipt) => receipt.qualifiedName)).toEqual([
      'inventory.pick',
    ]);
  });

  it('mints no receipt for a callable outside receiptSources', async () => {
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'await inventory.pick({order:"42"}); await inventory.note({text:"x"})',
          FINAL,
        ],
      },
      receiptConfig({ receiptSources: ['inventory.pick'] })
    );

    await built.forward(ai, { task: 'both' } as never);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    expect(receipts.map((receipt) => receipt.qualifiedName)).toEqual([
      'inventory.pick',
    ]);
  });
});
