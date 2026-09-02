/**
 * Loop-level `actorMemoryMode: 'skillState'` wiring.
 *
 * Every scenario drives a real `agent(...)` over a scripted mock model and an
 * EVALUATING code runtime, so the actor's `statePatch` really travels through
 * the provider parse path, the turn hook and the working-state kernel. A test
 * that handed the patch straight to `AxSkillStateRuntime` would prove nothing
 * about the mode, which is exactly what these assertions are for.
 */

import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../ai/types.js';
import { AxInMemoryProgramStateStore } from '../event/memoryStore.js';
import { AxManualEventClock } from '../event/types.js';
import {
  type AxWorkingStateScript,
  axCreateEvaluatingRuntime,
  axCreateScriptedMock,
} from './benchmarks/workingStateHarness.js';
import type { AxAgentFunction } from './index.js';
import { agent } from './index.js';
import type { AxSkillStateTransition } from './skillState.js';
import type {
  AxWorkingStateConfig,
  AxWorkingStateGoal,
  AxWorkingStateTraceStep,
} from './workingState.js';

const STATE_SIGNATURE = 'orderId:string, itemsPacked:number, shipped:boolean';

const SKILL = {
  id: 'warehouse-pick',
  name: 'Warehouse picking procedure',
  content: 'PROCEDURE-BODY-MARKER: pick, cite the receipt, close the goal.',
};

function seededGoal(
  id: string,
  overrides?: Partial<AxWorkingStateGoal>
): AxWorkingStateGoal {
  return {
    id,
    goal: `complete ${id}`,
    status: 'pending',
    evidence: [],
    expects: ['inventory.pick'],
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

type Built = {
  built: ReturnType<typeof agent>;
  ai: AxAIService;
  executorPrompts: string[];
  transitions: AxSkillStateTransition<any>[];
  traces: AxWorkingStateTraceStep[];
};

function buildSkillStateAgent(
  script: AxWorkingStateScript,
  overrides?: {
    workingState?: Partial<AxWorkingStateConfig<any>>;
    skillState?: Record<string, unknown>;
    memoryMode?: 'transcript' | 'skillState';
    maxTurns?: number;
  }
): Built {
  const { ai, executorPrompts } = axCreateScriptedMock(script);
  const transitions: AxSkillStateTransition<any>[] = [];
  const traces: AxWorkingStateTraceStep[] = [];
  const workingState: AxWorkingStateConfig<any> = {
    stateSignature: STATE_SIGNATURE,
    clock: new AxManualEventClock(1_000),
    store: new AxInMemoryProgramStateStore(),
    runIdFactory: () => 'ws:skillstate:1',
    initial: { goals: { g_pick: seededGoal('g_pick') } },
    trace: true,
    onTrace: (step) => traces.push(step),
    ...overrides?.workingState,
  };
  const built = agent('task:string -> answer:string', {
    functions: [pickFn],
    runtime: axCreateEvaluatingRuntime(),
    maxTurns: overrides?.maxTurns ?? 6,
    workingState,
    actorMemoryMode: overrides?.memoryMode ?? 'skillState',
    skillState: {
      skill: SKILL,
      onTransition: (transition) => transitions.push(transition),
      ...overrides?.skillState,
    },
  });
  return {
    built,
    ai: ai as unknown as AxAIService,
    executorPrompts,
    transitions,
    traces,
  };
}

const DISTILL = ['await final("distilled", {"evidence":"orders"})'];

function actorSignatureFields(built: ReturnType<typeof agent>): {
  inputs: string[];
  outputs: string[];
} {
  const signature = (
    built as unknown as { executor: { actorProgram: any } }
  ).executor.actorProgram.getSignature();
  return {
    inputs: (signature.getInputFields() as { name: string }[]).map(
      (field) => field.name
    ),
    outputs: (signature.getOutputFields() as { name: string }[]).map(
      (field) => field.name
    ),
  };
}

describe('actorMemoryMode config-time validation', () => {
  it('throws skillstate_requires_working_state without a working state', () => {
    expect(() =>
      agent('task:string -> answer:string', {
        functions: [pickFn],
        runtime: axCreateEvaluatingRuntime(),
        actorMemoryMode: 'skillState',
        skillState: { skill: SKILL },
      })
    ).toThrow(/skillstate_requires_working_state/);
  });

  it('throws skillstate_requires_skill without a skill config', () => {
    expect(() =>
      agent('task:string -> answer:string', {
        functions: [pickFn],
        runtime: axCreateEvaluatingRuntime(),
        actorMemoryMode: 'skillState',
        workingState: { stateSignature: STATE_SIGNATURE },
      })
    ).toThrow(/skillstate_requires_skill/);
  });

  it('throws unresolvable_skill_spec for a ref with no resolver at construction', () => {
    // Not at turn 40: a ref carries no body text, so the prompt could never be
    // built.
    expect(() =>
      agent('task:string -> answer:string', {
        functions: [pickFn],
        runtime: axCreateEvaluatingRuntime(),
        actorMemoryMode: 'skillState',
        workingState: { stateSignature: STATE_SIGNATURE },
        skillState: { skill: { id: 'warehouse', version: '1.0.0' } },
      })
    ).toThrow(/unresolvable_skill_spec/);
  });
});

describe('skillState actor signature', () => {
  it('omits actionLog and summarizedActorLog and adds skillSpec and latestObservation', () => {
    const { built } = buildSkillStateAgent({
      distiller: DISTILL,
      executor: [],
    });
    const { inputs, outputs } = actorSignatureFields(built);

    // The mechanism is STRUCTURAL: the transcript fields are gone from the
    // signature, not merely left empty in the values.
    expect(inputs).not.toContain('actionLog');
    expect(inputs).not.toContain('summarizedActorLog');
    expect(inputs).toContain('skillSpec');
    expect(inputs).toContain('latestObservation');
    expect(inputs).toContain('workingState');
    expect(inputs).toContain('receiptRoster');
    expect(outputs).toEqual(['javascriptCode', 'statePatch', 'rationale']);
  });

  it('keeps the transcript signature under the default memory mode', () => {
    const { built } = buildSkillStateAgent(
      { distiller: DISTILL, executor: [] },
      { memoryMode: 'transcript' }
    );
    const { inputs, outputs } = actorSignatureFields(built);

    expect(inputs).toContain('actionLog');
    expect(inputs).toContain('summarizedActorLog');
    expect(inputs).not.toContain('skillSpec');
    expect(inputs).not.toContain('latestObservation');
    expect(outputs).toEqual(['javascriptCode']);
  });
});

describe('skillState turn loop', () => {
  it('commits an actor-emitted patch that cites a receipt from the roster', async () => {
    const { built, ai, transitions } = buildSkillStateAgent({
      distiller: DISTILL,
      executor: [
        // Turn 1: do the work. No patch yet — the receipt does not exist until
        // the call returns.
        'console.log(JSON.stringify(await inventory.pick({order:"42"})))',
        // Turn 2: the roster now carries r1, so the goal can close.
        {
          code: 'console.log("closing")',
          statePatch: [
            {
              op: 'add',
              path: '/goals/g_pick/evidence/-',
              value: { kind: 'tool_receipt', ref: 'r1' },
            },
            { op: 'replace', path: '/goals/g_pick/status', value: 'done' },
          ],
          rationale: 'r1 proves the pick happened',
        },
        'await final("done", {"answer":"ok"})',
      ],
    });

    await built.forward(ai, { task: 'pick order 42' } as never);

    expect(built.getWorkingState()?.goals.g_pick?.status).toBe('done');
    const accepted = transitions.filter((entry) => entry.accepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.patch).toHaveLength(2);
    expect(accepted[0]?.committedRevision).toBeGreaterThan(0);
  });

  it('parks a receipt-free completion the actor emitted and leaves the goal pending', async () => {
    const { built, ai, transitions } = buildSkillStateAgent({
      distiller: DISTILL,
      executor: [
        {
          code: 'console.log("claiming without evidence")',
          statePatch: [
            { op: 'replace', path: '/goals/g_pick/status', value: 'done' },
          ],
        },
        'await final("done", {"answer":"ok"})',
      ],
    });

    await built.forward(ai, { task: 'pick order 42' } as never);

    expect(built.getWorkingState()?.goals.g_pick?.status).toBe('pending');
    expect(transitions.some((entry) => entry.accepted)).toBe(false);
    expect(transitions[0]?.rejection).toBe('invariant');
  });

  it('records proposal none and leaves the state unchanged when no patch is emitted', async () => {
    const { built, ai, traces, transitions } = buildSkillStateAgent({
      distiller: DISTILL,
      executor: [
        'console.log(JSON.stringify(await inventory.pick({order:"42"})))',
        'await final("done", {"answer":"ok"})',
      ],
    });

    await built.forward(ai, { task: 'pick order 42' } as never);

    // An absent optional output is not a parse failure and not an error turn.
    expect(traces.every((step) => step.proposal === 'none')).toBe(true);
    expect(traces.every((step) => step.outcome === 'unchanged')).toBe(true);
    expect(transitions).toHaveLength(0);
    expect(built.getWorkingState()?.goals.g_pick?.status).toBe('pending');
  });

  it('shows the frozen spec, the roster and only the latest observation to the actor', async () => {
    const { built, ai, executorPrompts } = buildSkillStateAgent({
      distiller: DISTILL,
      executor: [
        'console.log("OBSERVATION-ONE")',
        'console.log("OBSERVATION-TWO")',
        'await final("done", {"answer":"ok"})',
      ],
    });

    await built.forward(ai, { task: 'pick order 42' } as never);

    const third = executorPrompts[2]!;
    expect(third).toContain('PROCEDURE-BODY-MARKER');
    expect(third).toContain('Receipt Roster');
    // The prior turn's output is present; the one before it is gone. In
    // transcript mode both would still be replayed.
    expect(third).toContain('OBSERVATION-TWO');
    expect(third).not.toContain('OBSERVATION-ONE');
  });

  it('does no transcript compaction or checkpoint summarization at all', async () => {
    // The cost the mode exists to remove is the RENDERING, compaction and
    // model-backed summarization of a growing transcript. The same script under
    // the transcript substrate trips both; under skillState neither fires.
    const script: AxWorkingStateScript = {
      distiller: DISTILL,
      executor: [
        ...Array.from(
          { length: 18 },
          (_unused, index) => `console.log("${'padding '.repeat(200)}${index}")`
        ),
        'await final("done", {"answer":"ok"})',
      ],
    };
    const run = async (memoryMode: 'transcript' | 'skillState') => {
      const kinds: string[] = [];
      const { ai } = axCreateScriptedMock(script);
      const built = agent('task:string -> answer:string', {
        functions: [pickFn],
        runtime: axCreateEvaluatingRuntime(),
        maxTurns: 30,
        contextPolicy: { preset: 'checkpointed', budget: 'compact' },
        workingState: {
          stateSignature: STATE_SIGNATURE,
          clock: new AxManualEventClock(1_000),
          store: new AxInMemoryProgramStateStore(),
          runIdFactory: () => `ws:compaction:${memoryMode}`,
          initial: { goals: { g_pick: seededGoal('g_pick') } },
        },
        actorMemoryMode: memoryMode,
        skillState: { skill: SKILL },
        onContextEvent: (event) => {
          kinds.push((event as unknown as { kind: string }).kind);
        },
      });
      await built.forward(
        ai as unknown as AxAIService,
        {
          task: 'work through the queue',
        } as never
      );
      return kinds;
    };

    const transcriptKinds = await run('transcript');
    const skillStateKinds = await run('skillState');

    const compactionish = (kinds: string[]) =>
      kinds.filter(
        (kind) => kind === 'action_compacted' || kind === 'checkpoint_created'
      ).length;

    // The comparison would be vacuous if the transcript arm never compacted.
    expect(compactionish(transcriptKinds)).toBeGreaterThan(0);
    expect(compactionish(skillStateKinds)).toBe(0);
    // The budget meter still runs in both arms.
    expect(
      skillStateKinds.filter((kind) => kind === 'budget_check').length
    ).toBeGreaterThan(10);
  }, 60_000);

  it('digests the actor rationale and keeps the text out of every retained surface', async () => {
    const { built, ai, transitions, executorPrompts } = buildSkillStateAgent({
      distiller: DISTILL,
      executor: [
        'console.log(JSON.stringify(await inventory.pick({order:"42"})))',
        {
          code: 'console.log("closing")',
          statePatch: [
            {
              op: 'add',
              path: '/goals/g_pick/evidence/-',
              value: { kind: 'tool_receipt', ref: 'r1' },
            },
            { op: 'replace', path: '/goals/g_pick/status', value: 'done' },
          ],
          rationale: 'SECRET-RATIONALE-TOKEN',
        },
        'await final("done", {"answer":"ok"})',
      ],
    });

    await built.forward(ai, { task: 'pick order 42' } as never);

    expect(transitions[0]?.rationaleDigest).toMatch(/^[0-9a-f]{64}$/);
    // Emitted once by the model; it must never come BACK in a later prompt.
    expect(executorPrompts[2]).not.toContain('SECRET-RATIONALE-TOKEN');
    expect(JSON.stringify(built.getWorkingState())).not.toContain(
      'SECRET-RATIONALE-TOKEN'
    );
    expect(JSON.stringify(transitions)).not.toContain('SECRET-RATIONALE-TOKEN');
  });

  it('keeps per-turn prompt characters flat across a long scripted run', async () => {
    // The linearity mechanism at unit scale: the benchmark measures it at
    // horizon scale.
    const budgetChars: number[] = [];
    const { ai, executorPrompts } = axCreateScriptedMock({
      distiller: DISTILL,
      executor: [
        ...Array.from(
          { length: 24 },
          (_unused, index) => `console.log("work ${index}")`
        ),
        'await final("done", {"answer":"ok"})',
      ],
    });
    const built = agent('task:string -> answer:string', {
      functions: [pickFn],
      runtime: axCreateEvaluatingRuntime(),
      maxTurns: 40,
      workingState: {
        stateSignature: STATE_SIGNATURE,
        clock: new AxManualEventClock(1_000),
        store: new AxInMemoryProgramStateStore(),
        runIdFactory: () => 'ws:skillstate:flat',
        initial: { goals: { g_pick: seededGoal('g_pick') } },
      },
      actorMemoryMode: 'skillState',
      skillState: { skill: SKILL },
      onContextEvent: (event) => {
        const payload = event as unknown as {
          kind: string;
          stage?: string;
          mutablePromptChars?: number;
        };
        if (payload.kind === 'budget_check' && payload.stage === 'executor') {
          budgetChars.push(payload.mutablePromptChars ?? 0);
        }
      },
    });

    await built.forward(
      ai as unknown as AxAIService,
      {
        task: 'work through the queue',
      } as never
    );

    expect(budgetChars.length).toBeGreaterThan(20);
    const first = budgetChars[1]!;
    const last = budgetChars[budgetChars.length - 1]!;
    // Flat, not merely "smaller": the dynamic tail is the state document plus
    // one observation, and neither grows with the turn count.
    expect(last / first).toBeLessThan(1.25);
    expect(executorPrompts.length).toBeGreaterThan(20);
  });

  it('measures the prompt it sends, apart from the derived pressure hint', async () => {
    const budget: Array<{ mutable: number; fixed: number }> = [];
    const { ai, executorPromptChars: sentChars } = axCreateScriptedMock({
      distiller: DISTILL,
      executor: [
        'console.log("work")',
        'console.log("more")',
        'await final("done", {"answer":"ok"})',
      ],
    });
    const built = agent('task:string -> answer:string', {
      functions: [pickFn],
      runtime: axCreateEvaluatingRuntime(),
      maxTurns: 6,
      workingState: {
        stateSignature: STATE_SIGNATURE,
        clock: new AxManualEventClock(1_000),
        store: new AxInMemoryProgramStateStore(),
        runIdFactory: () => 'ws:skillstate:measure',
        initial: { goals: { g_pick: seededGoal('g_pick') } },
      },
      actorMemoryMode: 'skillState',
      skillState: { skill: SKILL },
      // `preset: 'full'` renders no context-pressure field at all, so measured
      // characters and sent characters must match EXACTLY here.
      contextPolicy: { preset: 'full' },
      onContextEvent: (event) => {
        const payload = event as unknown as {
          kind: string;
          stage?: string;
          mutablePromptChars?: number;
          fixedPromptChars?: number;
        };
        if (payload.kind === 'budget_check' && payload.stage === 'executor') {
          budget.push({
            mutable: payload.mutablePromptChars ?? 0,
            fixed: payload.fixedPromptChars ?? 0,
          });
        }
      },
    });

    await built.forward(
      ai as unknown as AxAIService,
      {
        task: 'measure me',
      } as never
    );

    const index = 1;
    const measured = budget[index]!.mutable + budget[index]!.fixed;
    // EXACT: the sum of the sent message contents, with no join characters
    // added. Dropping any one prompt region from the measured value — the
    // frozen spec, the state document, the roster or the observation — breaks
    // this equality.
    expect(measured).toBe(sentChars[index]!);
  });

  it('measures the prompt it sends in transcript mode too', async () => {
    // The measurement rework is not skillState-only: with no derived pressure
    // field rendered, the DEFAULT substrate's budget meter is exact as well.
    const budget: Array<{ mutable: number; fixed: number }> = [];
    const { ai, executorPromptChars: sentChars } = axCreateScriptedMock({
      distiller: DISTILL,
      executor: [
        'console.log("work")',
        'console.log("more")',
        'await final("done", {"answer":"ok"})',
      ],
    });
    const built = agent('task:string -> answer:string', {
      functions: [pickFn],
      runtime: axCreateEvaluatingRuntime(),
      maxTurns: 6,
      contextPolicy: { preset: 'full' },
      onContextEvent: (event) => {
        const payload = event as unknown as {
          kind: string;
          stage?: string;
          mutablePromptChars?: number;
          fixedPromptChars?: number;
        };
        if (payload.kind === 'budget_check' && payload.stage === 'executor') {
          budget.push({
            mutable: payload.mutablePromptChars ?? 0,
            fixed: payload.fixedPromptChars ?? 0,
          });
        }
      },
    });

    await built.forward(
      ai as unknown as AxAIService,
      {
        task: 'measure me',
      } as never
    );

    const index = 1;
    expect(budget[index]!.mutable + budget[index]!.fixed).toBe(
      sentChars[index]!
    );
  });
});
