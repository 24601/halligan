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
    functions: [pickFn, noteFn, failFn],
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
