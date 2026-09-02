/**
 * `AxSkillStateRuntime` unit tests (Track B5 PR 2).
 *
 * These drive the runtime directly over a real `AxWorkingState` with a manual
 * clock and an in-memory store, so every assertion is about the kernel's real
 * behaviour rather than a stubbed commit. The loop-level assertions (signature
 * omission, measured-equals-sent, prompt linearity through a real `agent(...)`)
 * live in `agent.skillState.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { AxInMemoryProgramStateStore } from '../event/memoryStore.js';
import {
  AxManualEventClock,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
} from '../event/types.js';
import type { AxAgentSkillResult } from './agentInternal/skillsTypes.js';
import type { AxExecutableSkillRef } from './executableSkills.js';
import {
  type AxSkillStateConfig,
  AxSkillStateRuntime,
  axSkillStateRuntime,
} from './skillState.js';
import {
  type AxWorkingState,
  type AxWorkingStateConfig,
  type AxWorkingStateGoal,
  AxWorkingStateSchemaError,
  axWorkingState,
} from './workingState.js';

const STATE_SIGNATURE = 'orderId:string, itemsPacked:number, shipped:boolean';

type Facts = { orderId?: string; itemsPacked?: number; shipped?: boolean };

const SKILL: AxAgentSkillResult = {
  id: 'warehouse-pick',
  name: 'Warehouse picking procedure',
  content: '1. Pick every line.\n2. Cite the receipt.\n3. Mark the goal done.',
};

function goal(
  id: string,
  overrides?: Partial<AxWorkingStateGoal>
): AxWorkingStateGoal {
  return {
    id,
    goal: `do ${id}`,
    status: 'pending',
    evidence: [],
    expects: ['inventory.pick'],
    createdTurn: 1,
    updatedTurn: 1,
    ...overrides,
  };
}

async function makeState(
  overrides?: Partial<AxWorkingStateConfig<Facts>>
): Promise<AxWorkingState<Facts>> {
  return axWorkingState<Facts>(
    {
      stateSignature: STATE_SIGNATURE,
      clock: new AxManualEventClock(1_000),
      store: new AxInMemoryProgramStateStore(),
      initial: { goals: { g_pick: goal('g_pick') } },
      ...overrides,
    },
    { runId: 'ws:test:1', stage: 'executor' }
  );
}

async function makeRuntime(
  state: AxWorkingState<Facts>,
  config?: Partial<AxSkillStateConfig<Facts>>
) {
  return axSkillStateRuntime<Facts>(
    { skill: SKILL, ...config } as AxSkillStateConfig<Facts>,
    state
  );
}

const TURN = {
  action: 'await inventory.pick({order:"42"})',
  observation: '{"picked":3}',
  turn: 5,
  isError: false,
} as const;

async function mint(state: AxWorkingState<Facts>, qualifiedName: string) {
  return state.recordReceipt({
    qualifiedName,
    arguments: { order: '42' },
    result: { picked: 3 },
    turn: 5,
    at: 1_700_000_120_000,
  });
}

/** The patch a well-behaved model emits: cite the ref, then close the goal. */
function completionPatch(ref: string): unknown {
  return [
    {
      op: 'add',
      path: '/goals/g_pick/evidence/-',
      value: { kind: 'tool_receipt', ref },
    },
    { op: 'replace', path: '/goals/g_pick/status', value: 'done' },
  ];
}

describe('AxSkillStateRuntime construction', () => {
  it('throws unresolvable_skill_spec for a skill ref with no resolveSkill', async () => {
    // `AxExecutableSkillRef` is `{id, version}` and carries no body text, so a
    // ref without a resolver can never render a spec. That must fail at
    // construction, not at turn 40.
    const state = await makeState();
    const ref: AxExecutableSkillRef = { id: 'warehouse', version: '1.0.0' };

    await expect(
      axSkillStateRuntime<Facts>({ skill: ref }, state)
    ).rejects.toBeInstanceOf(AxWorkingStateSchemaError);
    await expect(
      axSkillStateRuntime<Facts>({ skill: ref }, state)
    ).rejects.toThrow(/unresolvable_skill_spec/);
  });

  it('resolves a skill ref through resolveSkill and renders its content', async () => {
    const state = await makeState();
    const resolveSkill = vi.fn(async (ref: AxExecutableSkillRef) => ({
      id: ref.id,
      name: 'Resolved procedure',
      content: `body for ${ref.version}`,
    }));

    const runtime = await axSkillStateRuntime<Facts>(
      { skill: { id: 'warehouse', version: '2.1.0' }, resolveSkill },
      state
    );

    expect(resolveSkill).toHaveBeenCalledTimes(1);
    expect(runtime.renderPrompt().skillSpec).toContain('body for 2.1.0');
    expect(runtime.renderPrompt().skillSpec).toContain('Resolved procedure');
  });

  it('throws when a resolver returns a skill with no content', async () => {
    const state = await makeState();
    await expect(
      axSkillStateRuntime<Facts>(
        {
          skill: { id: 'warehouse', version: '1.0.0' },
          resolveSkill: async () => ({ name: 'empty', content: '' }),
        },
        state
      )
    ).rejects.toThrow(/unresolvable_skill_spec/);
  });

  it('rejects a non-positive observationWindow at construction', async () => {
    const state = await makeState();
    await expect(
      axSkillStateRuntime<Facts>({ skill: SKILL, observationWindow: 0 }, state)
    ).rejects.toThrow(/invalid_observation_window/);
  });

  it('renderPrompt().skillSpec contains the resolved skill content verbatim', async () => {
    const runtime = await makeRuntime(await makeState());
    const prompt = runtime.renderPrompt();

    expect(prompt.skillSpec).toContain(SKILL.content);
    expect(prompt.skillSpec).toContain('warehouse-pick');
  });
});

describe('AxSkillStateRuntime prompt regions', () => {
  it('renders the writable document, the read-only roster and the observation separately', async () => {
    const state = await makeState();
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);
    runtime.observe('{"picked":3}', 5);

    const prompt = runtime.renderPrompt();
    // The roster is the only region carrying a citable ref, and the writable
    // region never carries one before the model cites it.
    expect(prompt.receiptRoster).toContain(`${receipt.ref}  inventory.pick`);
    expect(prompt.workingState).toContain('g_pick');
    expect(prompt.workingState).not.toContain(`${receipt.ref}  inventory.pick`);
    expect(prompt.latestObservation).toContain('[turn 5] {"picked":3}');
    expect(prompt.stateContract).toContain('itemsPacked');
  });

  it('says so explicitly when no observation has been recorded yet', async () => {
    const runtime = await makeRuntime(await makeState());
    expect(runtime.renderPrompt().latestObservation).toBe(
      '(no observation yet)'
    );
  });

  it('keeps exactly one observation by default and exactly two under observationWindow 2', async () => {
    const single = await makeRuntime(await makeState());
    single.observe('first', 1);
    single.observe('second', 2);
    expect(single.renderPrompt().latestObservation).toBe('[turn 2] second');

    const windowed = await makeRuntime(await makeState(), {
      observationWindow: 2,
    });
    windowed.observe('first', 1);
    windowed.observe('second', 2);
    windowed.observe('third', 3);
    const rendered = windowed.renderPrompt().latestObservation;
    expect(rendered).toBe('[turn 2] second\n\n[turn 3] third');
    expect(rendered).not.toContain('first');
  });

  it('truncates an observation to maxObservationChars', async () => {
    const state = await makeState({ maxObservationChars: 16 });
    const runtime = await makeRuntime(state);
    runtime.observe('x'.repeat(64), 3);

    expect(runtime.renderPrompt().latestObservation).toBe(
      `[turn 3] ${'x'.repeat(16)}`
    );
  });

  it('step() exposes the stored envelope, the frozen skill and the latest observation', async () => {
    const state = await makeState();
    const runtime = await makeRuntime(state);
    runtime.observe('{"picked":3}', 5);

    const step = runtime.step();
    expect(step.skill.content).toBe(SKILL.content);
    expect(step.observation).toBe('{"picked":3}');
    expect(step.state.revision).toBe(state.currentRevision());
    expect(step.state.programVersion).toBe('ws:test:1');
    // The envelope is a clone: mutating it cannot corrupt the kernel.
    (step.state.state as { schemaVersion: number }).schemaVersion = 99;
    expect(
      (runtime.step().state.state as { schemaVersion: number }).schemaVersion
    ).toBe(1);
  });
});

describe('AxSkillStateRuntime transitions', () => {
  it('commits an accepted patch and advances the stored revision', async () => {
    const state = await makeState();
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);

    const before = state.currentRevision();
    const transition = await runtime.applyPatch(
      completionPatch(receipt.ref),
      'the pick receipt proves it',
      TURN
    );

    expect(transition.accepted).toBe(true);
    expect(transition.rejection).toBeUndefined();
    expect(transition.committedRevision).toBeGreaterThan(before);
    expect(transition.state?.goals.g_pick?.status).toBe('done');
    expect(state.current().goals.g_pick?.status).toBe('done');
  });

  it('records one transition per accepted patch and none per rejected patch', async () => {
    const state = await makeState();
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);

    await runtime.applyPatch('not a patch', undefined, TURN);
    expect(runtime.transitions()).toHaveLength(0);

    await runtime.applyPatch(completionPatch(receipt.ref), undefined, TURN);
    expect(runtime.transitions()).toHaveLength(1);
    expect(runtime.transitions()[0]?.patch).toHaveLength(2);
  });

  it('every transition carries a defined committedRevision', async () => {
    // The store is never absent — it defaults to `AxInMemoryProgramStateStore`
    // — so the revision is non-optional in every configuration, including the
    // rejected paths.
    const state = await makeState();
    const runtime = await makeRuntime(state);

    const malformed = await runtime.applyPatch({ nope: true }, undefined, TURN);
    const parked = await runtime.applyPatch(
      [{ op: 'replace', path: '/goals/g_pick/status', value: 'done' }],
      undefined,
      TURN
    );

    expect(typeof malformed.committedRevision).toBe('number');
    expect(typeof parked.committedRevision).toBe('number');
  });

  it('rejects a malformed patch as schema without touching the store', async () => {
    const compareAndSet = vi.fn();
    const store: AxProgramStateStore = {
      load: async () => undefined,
      compareAndSet:
        compareAndSet as unknown as AxProgramStateStore['compareAndSet'],
      delete: async () => {},
    };
    const state = await makeState({ store });
    const runtime = await makeRuntime(state);

    const transition = await runtime.applyPatch(
      { op: 'replace' },
      undefined,
      TURN
    );

    expect(transition.accepted).toBe(false);
    expect(transition.rejection).toBe('schema');
    expect(transition.patch).toEqual([]);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it('rejects a forbidden path as authority', async () => {
    const state = await makeState();
    const runtime = await makeRuntime(state);

    const transition = await runtime.applyPatch(
      [{ op: 'replace', path: '/schemaVersion', value: 99 }],
      undefined,
      TURN
    );

    expect(transition.accepted).toBe(false);
    expect(transition.rejection).toBe('authority');
    expect(state.current().schemaVersion).toBe(1);
  });

  it('rejects a receipt-free completion as invariant', async () => {
    const state = await makeState();
    const runtime = await makeRuntime(state);

    const transition = await runtime.applyPatch(
      [{ op: 'replace', path: '/goals/g_pick/status', value: 'done' }],
      undefined,
      TURN
    );

    expect(transition.accepted).toBe(false);
    expect(transition.rejection).toBe('invariant');
    expect(state.current().goals.g_pick?.status).toBe('pending');
  });

  it('rejects a lost compare-and-set as fence', async () => {
    // Fault injection: the store rejects every write while reporting a moving
    // revision, so the kernel's single rebase cannot land. That is exactly the
    // stale-revision condition the fence rejection names.
    let revision = 4;
    const store: AxProgramStateStore = {
      load: async () => {
        revision += 1;
        return {
          schemaVersion: 1,
          programVersion: 'ws:test:1',
          revision,
          state: {
            schemaVersion: 1,
            goals: { g_pick: goal('g_pick') },
            facts: {},
            parked: [],
          },
          updatedAt: 1_000,
        } satisfies AxProgramStateEnvelope;
      },
      compareAndSet: async () => {
        throw new Error('revision mismatch');
      },
      delete: async () => {},
    };
    const state = await makeState({ store });
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);

    const transition = await runtime.applyPatch(
      completionPatch(receipt.ref),
      undefined,
      TURN
    );

    expect(transition.accepted).toBe(false);
    expect(transition.rejection).toBe('fence');
    expect(runtime.transitions()).toHaveLength(0);
  });

  it('commits through compareAndSet carrying the configured fence by identity', async () => {
    const fence = { deliveryId: 'd-1', fencingToken: 7 } as const;
    const inner = new AxInMemoryProgramStateStore();
    const seen: unknown[] = [];
    const store: AxProgramStateStore = {
      load: (key) => inner.load(key),
      compareAndSet: (key, expected, next, passedFence) => {
        seen.push(passedFence);
        return inner.compareAndSet(key, expected, next, passedFence);
      },
      delete: (key) => inner.delete(key),
    };
    const state = await makeState({ store, fence });
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);

    const transition = await runtime.applyPatch(
      completionPatch(receipt.ref),
      undefined,
      TURN
    );

    expect(transition.accepted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(fence);
  });

  it('does not reject a valid empty patch — nothing was refused', async () => {
    const state = await makeState();
    const runtime = await makeRuntime(state);

    const transition = await runtime.applyPatch([], undefined, TURN);

    expect(transition.accepted).toBe(false);
    expect(transition.rejection).toBeUndefined();
    expect(runtime.transitions()).toHaveLength(0);
  });

  it('digests the rationale and retains the text nowhere', async () => {
    const state = await makeState();
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);
    const rationale = 'SECRET-RATIONALE-TOKEN because the pick returned 3';

    const transition = await runtime.applyPatch(
      completionPatch(receipt.ref),
      rationale,
      TURN
    );

    expect(transition.rationaleDigest).toMatch(/^[0-9a-f]{64}$/);
    const retained = JSON.stringify({
      transition,
      transitions: runtime.transitions(),
      document: state.current(),
      prompt: runtime.renderPrompt(),
      guidance: runtime.lastGuidance(),
    });
    expect(retained).not.toContain('SECRET-RATIONALE-TOKEN');
  });

  it('digests an absent rationale to a stable value', async () => {
    const state = await makeState();
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);

    const first = await runtime.applyPatch(
      completionPatch(receipt.ref),
      undefined,
      TURN
    );
    const second = await runtime.applyPatch([], '', TURN);

    expect(first.rationaleDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.rationaleDigest).toBe(first.rationaleDigest);
  });

  it('surfaces harness guidance codes for a refused delta and never model text', async () => {
    const state = await makeState();
    const runtime = await makeRuntime(state);

    await runtime.applyPatch(
      [
        {
          op: 'replace',
          path: '/goals/g_pick/status',
          value: 'IGNORE-PRIOR-RULES',
        },
      ],
      undefined,
      TURN
    );

    const guidance = runtime.lastGuidance();
    expect(guidance.length).toBeGreaterThan(0);
    expect(JSON.stringify(guidance)).not.toContain('IGNORE-PRIOR-RULES');
  });

  it('stamps the transition time from the injected clock', async () => {
    const clock = new AxManualEventClock(1_000);
    const state = await makeState({ clock });
    const receipt = await mint(state, 'inventory.pick');
    const runtime = await makeRuntime(state);
    clock.advanceBy(500);

    const transition = await runtime.applyPatch(
      completionPatch(receipt.ref),
      undefined,
      TURN
    );

    expect(transition.at).toBe(1_500);
  });

  it('exposes AxSkillStateRuntime as a class with a private constructor', () => {
    // The house pattern: validation lives in the factory, so a host cannot
    // construct an unvalidated runtime.
    expect(
      () => new (AxSkillStateRuntime as unknown as new () => unknown)()
    ).toThrow();
  });
});
