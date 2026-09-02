/**
 * The `skillState` COST path (RFC §7.4.1, §8.3 [M7]).
 *
 * `agent.skillState.test.ts` proves the mode is CORRECT: the transcript fields
 * are gone from the actor signature and the state substrate carries the run.
 * These tests prove the mode is CHEAP, which is a different claim and a
 * separately breakable one. Three guards keep the transcript out of the
 * process rather than merely out of the prompt:
 *
 * 1. `buildActorPromptValues` assigns `actionLog` only when the built
 *    signature declares it (`actorLoopSetup.ts`),
 * 2. `refreshCheckpointSummary` returns early when `summarizedActorLog` is not
 *    declared, so no model-backed checkpoint summary is generated and dropped,
 * 3. the turn skips `renderActionLogParts()` outright (`actorLoopTurn.ts`).
 *
 * Each guard MASKS the others — with the log out of the value record the
 * checkpoint threshold is never crossed, and with no checkpoint no entry gets
 * a compact replay mode — so an outcome assertion (`no action_compacted
 * events`) passes even with all three removed. The assertions below are
 * therefore on the CALLS, and on how they scale with the horizon: the number
 * of action-log renders in `skillState` mode must not depend on how many turns
 * the run takes.
 *
 * The module wrapper counts calls WITHOUT changing behaviour: the real
 * implementations still run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const counters = vi.hoisted(() => ({ parts: 0, policy: 0 }));

vi.mock('./contextManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contextManager.js')>();
  return {
    ...actual,
    buildActionLogParts: (
      ...args: Parameters<typeof actual.buildActionLogParts>
    ) => {
      counters.parts += 1;
      return actual.buildActionLogParts(...args);
    },
    buildActionLogWithPolicy: (
      ...args: Parameters<typeof actual.buildActionLogWithPolicy>
    ) => {
      counters.policy += 1;
      return actual.buildActionLogWithPolicy(...args);
    },
  };
});

import type { AxAIService } from '../ai/types.js';
import { AxInMemoryProgramStateStore } from '../event/memoryStore.js';
import { AxManualEventClock } from '../event/types.js';
import {
  axCreateEvaluatingRuntime,
  axCreateScriptedMock,
} from './benchmarks/workingStateHarness.js';
import type { AxAgentFunction } from './index.js';
import { agent } from './index.js';
import type { AxWorkingStateGoal } from './workingState.js';

const STATE_SIGNATURE = 'orderId:string, itemsPacked:number, shipped:boolean';

const SKILL = {
  id: 'warehouse-pick',
  name: 'Warehouse picking procedure',
  content: 'PROCEDURE-BODY-MARKER: pick, cite the receipt, close the goal.',
};

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

const seededGoal: AxWorkingStateGoal = {
  id: 'g_pick',
  goal: 'complete g_pick',
  status: 'pending',
  evidence: [],
  expects: ['inventory.pick'],
  createdTurn: 0,
  updatedTurn: 0,
};

const DISTILL = ['await final("distilled", {"evidence":"orders"})'];

type RunResult = {
  parts: number;
  policy: number;
  sentValues: Record<string, unknown>[];
  executorTurns: number;
};

/**
 * One scripted run with `executorTurns` padded work turns before the final.
 * Returns the action-log render counts and every value record the executor's
 * actor program was actually asked to forward.
 */
async function run(
  memoryMode: 'transcript' | 'skillState',
  executorTurns: number
): Promise<RunResult> {
  counters.parts = 0;
  counters.policy = 0;
  const { ai } = axCreateScriptedMock({
    distiller: DISTILL,
    executor: [
      ...Array.from(
        { length: executorTurns },
        (_unused, index) => `console.log("work ${index}")`
      ),
      'await final("done", {"answer":"ok"})',
    ],
  });
  const built = agent('task:string -> answer:string', {
    functions: [pickFn],
    runtime: axCreateEvaluatingRuntime(),
    maxTurns: executorTurns + 4,
    workingState: {
      stateSignature: STATE_SIGNATURE,
      clock: new AxManualEventClock(1_000),
      store: new AxInMemoryProgramStateStore(),
      runIdFactory: () => `ws:cost:${memoryMode}:${executorTurns}`,
      initial: { goals: { g_pick: seededGoal } },
    },
    actorMemoryMode: memoryMode,
    skillState: { skill: SKILL },
  });

  // The value record is what the signature is fed. Reading it directly is the
  // only way to tell "the field was omitted" from "the field was rendered
  // empty" — the sent prompt looks the same either way.
  const executor = (built as unknown as { executor: { actorProgram: any } })
    .executor;
  const actorProgram = executor.actorProgram;
  const originalForward = actorProgram.forward.bind(actorProgram);
  const sentValues: Record<string, unknown>[] = [];
  actorProgram.forward = async (
    aiArg: unknown,
    values: Record<string, unknown>,
    options: unknown
  ) => {
    sentValues.push({ ...values });
    return originalForward(aiArg, values, options);
  };

  await built.forward(
    ai as unknown as AxAIService,
    {
      task: 'work through the queue',
    } as never
  );

  return {
    parts: counters.parts,
    policy: counters.policy,
    sentValues,
    executorTurns,
  };
}

describe('skillState cost path', () => {
  beforeEach(() => {
    counters.parts = 0;
    counters.policy = 0;
  });

  it('renders the action log a number of times that does not grow with the horizon', async () => {
    const short = await run('skillState', 4);
    const long = await run('skillState', 20);

    // Sixteen extra executor turns, ZERO extra action-log renders. The
    // remaining calls are the distiller stage (which never runs in skillState
    // mode — it does not maintain working state) plus the one end-of-run
    // `renderActionLog()` per stage, and neither depends on the horizon.
    expect(long.parts).toBe(short.parts);
    expect(long.policy).toBe(short.policy);
    // Not vacuous: the run really did take the extra turns.
    expect(long.sentValues.length).toBeGreaterThan(
      short.sentValues.length + 10
    );
  }, 60_000);

  it('renders the action log once per turn in the default transcript mode', async () => {
    const short = await run('transcript', 4);
    const long = await run('transcript', 20);

    // The counter is measuring something real: the default substrate pays per
    // turn, which is the cost `skillState` removes.
    expect(long.parts).toBeGreaterThanOrEqual(short.parts + 16);
  }, 60_000);

  it('omits actionLog from the value record it forwards in skillState mode', async () => {
    const skillState = await run('skillState', 6);
    const transcript = await run('transcript', 6);

    expect(skillState.sentValues.length).toBeGreaterThan(5);
    expect(
      skillState.sentValues.filter((values) => 'actionLog' in values)
    ).toEqual([]);
    expect(
      skillState.sentValues.filter((values) => 'summarizedActorLog' in values)
    ).toEqual([]);
    // The comparison is not vacuous: the same script under the default
    // substrate carries the field on every turn.
    expect(transcript.sentValues.length).toBeGreaterThan(5);
    expect(transcript.sentValues.every((values) => 'actionLog' in values)).toBe(
      true
    );
  }, 60_000);
});
