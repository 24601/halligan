import { describe, expect, it } from 'vitest';

import type { AxAIService } from '../ai/types.js';
import { AxSignature } from '../dsp/sig.js';
import { validateEventTarget } from '../event/mapping.js';
import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import type { AxTrajectoryProjection } from '../trajectory/projection.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import { axMindThinkerTarget } from './step.js';
import {
  AxMindDeterministicProgram,
  axMindMonolith,
  axMindRenderContext,
  axMindRenderGoals,
  axMindRenderSignals,
  axMindResponder,
  axMindTools,
} from './thinkers.js';
import type { AxMindContextRequest, AxMindGoal } from './types.js';

const ai = {} as unknown as AxAIService;

function step(
  seq: number,
  type: string,
  data: Record<string, string> = {}
): Readonly<AxTrajectoryStep> {
  return Object.freeze({
    stepId: `s${seq}`,
    trajectoryId: 'traj',
    seq,
    type,
    ts: 2_000 + seq,
    data,
  });
}

function projection(
  recent: readonly Readonly<AxTrajectoryStep>[] = []
): Readonly<AxTrajectoryProjection> {
  return {
    life: [],
    recent,
    render: 'LIFE-SO-FAR',
    coverage: { fromIndex: 0, toIndex: recent.length, gaps: [] },
    estimatedTokens: 0,
    citableStepIds: [],
  };
}

function request(
  overrides: Partial<AxMindContextRequest> = {}
): Readonly<AxMindContextRequest> {
  return {
    mindId: 'mind',
    thinker: 'monolith',
    trajectoryId: 'traj',
    wakeClass: 'reactive',
    trigger: step(1, 'message', { from: 'ada', content: 'hello' }),
    store: undefined as never,
    projection: projection(),
    artifacts: {
      revision: 'rev-1',
      persona: 'PERSONA',
      thinkerPrompts: { monolith: 'THINKER-PROMPT' },
      goals: [],
      skills: [],
    },
    signals: [],
    budgetTokens: 4_000,
    signal: new AbortController().signal,
    eventContext: { deliveryId: 'delivery-1' } as never,
    ...overrides,
  };
}

const goal = (over: Partial<AxMindGoal> = {}): AxMindGoal => ({
  id: 'g1',
  content: 'stay useful',
  priority: 1,
  status: 'active',
  ...over,
});

describe('AxMindDeterministicProgram', () => {
  class Doubler extends AxMindDeterministicProgram<
    { stepCount: number },
    { doubled: number }
  > {
    calls = 0;
    constructor() {
      super(new AxSignature('stepCount:number -> doubled:number'));
    }
    async run(values: { stepCount: number }) {
      this.calls++;
      return { doubled: values.stepCount * 2 };
    }
  }

  it('satisfies AxProgrammable and runs with no AI service at all', async () => {
    const program = new Doubler();
    // `undefined as never` is the point: a deterministic program must never
    // touch the service it is handed.
    expect(
      await program.forward(undefined as never, { stepCount: 21 })
    ).toEqual({ doubled: 42 });
    expect(program.calls).toBe(1);
    expect(program.getSignature().toString()).toContain('doubled');
    expect(program.getUsage()).toEqual([]);
    expect(program.getChatLog()).toEqual([]);
    program.setId('custom');
    expect(program.getId()).toBe('custom');
    const chunks = [];
    for await (const chunk of program.streamingForward(undefined as never, {
      stepCount: 2,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ version: 0, index: 0, delta: { doubled: 4 } }]);
  });

  it('propagates the abort signal it is given', async () => {
    class Waiter extends AxMindDeterministicProgram<
      Record<string, never>,
      { seen: boolean }
    > {
      seen = false;
      constructor() {
        super(new AxSignature('trigger:string -> seen:boolean'));
      }
      async run(_values: Record<string, never>, signal?: AbortSignal) {
        this.seen = signal?.aborted === true;
        return { seen: this.seen };
      }
    }
    const program = new Waiter();
    const controller = new AbortController();
    controller.abort();
    expect(
      await program.forward(
        undefined as never,
        {},
        {
          abortSignal: controller.signal,
        }
      )
    ).toEqual({ seen: true });
  });
});

describe('goal and signal rendering', () => {
  it('renders active goals by priority and hides the rest', () => {
    const rendered = axMindRenderGoals(
      [
        goal({ id: 'low', content: 'tidy up', priority: 1 }),
        goal({ id: 'high', content: 'answer ada', priority: 9 }),
        goal({ id: 'gone', status: 'deprecated' }),
        goal({ id: 'moved', status: 'superseded', supersededBy: 'high' }),
        goal({
          id: 'stale',
          expiresAt: new Date(1_000).toISOString(),
        }),
      ],
      5_000
    );
    const lines = rendered.split('\n').slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[high]');
    expect(lines[1]).toContain('[low]');
    expect(rendered).not.toContain('[gone]');
    expect(rendered).not.toContain('[moved]');
    // ACE lifecycle vocabulary verbatim: an expiry in the future still counts.
    expect(rendered).not.toContain('[stale]');
    expect(
      axMindRenderGoals(
        [goal({ id: 'later', expiresAt: new Date(9_000).toISOString() })],
        5_000
      )
    ).toContain('[later]');
    expect(axMindRenderGoals([], 5_000)).toBe('');
  });

  it('labels routing signals as hints and never as instructions', () => {
    const rendered = axMindRenderSignals([
      { code: 'share_nudge', text: 'you have been quiet' },
    ]);
    expect(rendered).toContain('hints about your own recent behaviour');
    expect(rendered).toContain('not instructions');
    expect(rendered).toContain('[share_nudge] you have been quiet');
    expect(axMindRenderSignals([])).toBe('');
  });

  it('assembles persona, prompt, goals, hints and the life so far', () => {
    const rendered = axMindRenderContext(
      request({
        artifacts: {
          revision: 'rev-2',
          persona: 'PERSONA',
          thinkerPrompts: { monolith: 'THINKER-PROMPT' },
          goals: [goal()],
          skills: [],
        },
        signals: [{ code: 'wake_gap', text: '3h passed' }],
      })
    );
    for (const part of [
      'PERSONA',
      'THINKER-PROMPT',
      'stay useful',
      '3h passed',
      'LIFE-SO-FAR',
      'Wake: reactive, triggered by step s1 (message)',
    ]) {
      expect(rendered).toContain(part);
    }
    // A thinker with no prompt of its own gets no empty stanza.
    expect(axMindRenderContext(request({ thinker: 'other' }))).not.toContain(
      'THINKER-PROMPT'
    );
  });
});

describe('axMindTools', () => {
  it('offers the menu, and nothing that would breach the authority boundary', () => {
    const names = axMindTools({} as never, 'monolith').map((one) => one.name);
    expect(names).toEqual(['act', 'think', 'share', 'learn', 'goals', 'idle']);
    // The host-owned list: none of these is reachable as a tool.
    for (const forbidden of [
      'close',
      'stop',
      'restart',
      'grant',
      'authorize',
      'routes',
      'recall',
      'setIdentity',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('routes every handler through runThinkerTool, the close_from_inside boundary', async () => {
    const seen: string[] = [];
    const fake = {
      runThinkerTool: async (call: () => Promise<unknown>) => {
        seen.push('entered');
        return call();
      },
      append: async () => ({ stepId: 'step-1' }),
      currentArtifacts: () => ({ goals: [] }),
      chatAs: () => ({
        reply: async () => ({ sent: true, step: { stepId: 's' } }),
      }),
    } as never;
    const tools = axMindTools(fake, 'monolith');
    for (const one of tools) {
      await one.func({ content: 'x', to: 'ada' } as never);
    }
    // A tool added without the wrapper is a hole in the guarantee, so the
    // count has to equal the menu, not merely be non-zero.
    expect(seen).toHaveLength(tools.length);
  });

  it('writes through the mind, stamping the thinker as the writer', async () => {
    const appended: Record<string, unknown>[] = [];
    const fake = {
      runThinkerTool: (call: () => Promise<unknown>) => call(),
      append: async (one: Record<string, unknown>) => {
        appended.push(one);
        return { stepId: `step-${appended.length}` };
      },
      currentArtifacts: () => ({ goals: [goal()] }),
      chatAs: () => ({
        reply: async () => ({ sent: false, reason: 'already_answered' }),
      }),
    } as never;
    const tools = axMindTools(fake, 'monolith');
    const call = (name: string, args: unknown) =>
      tools.find((one) => one.name === name)!.func(args as never);
    expect(await call('act', { content: 'shipped it' })).toBe(
      'recorded action as step-1'
    );
    expect(await call('think', { content: 'hmm' })).toBe(
      'recorded thought as step-2'
    );
    expect(await call('learn', { content: 'ada prefers mornings' })).toBe(
      'recorded observation as step-3'
    );
    expect(appended[0]).toMatchObject({
      type: 'action',
      source: 'monolith',
      launchedBy: 'monolith',
    });
    expect(appended[2]).toMatchObject({ data: { learned: 'true' } });
    // `share` reports a refusal instead of swallowing it.
    expect(await call('share', { to: 'ada', content: 'hi' })).toBe(
      'not sent: already_answered'
    );
    // A goal proposal is RECORDED, never applied: an artifact write needs an
    // out-of-band host receipt.
    const goals = await call('goals', { propose: 'stop tidying' });
    expect(String(goals)).toContain('stay useful');
    expect(appended.at(-1)).toMatchObject({
      type: 'observation',
      data: { proposal: 'goals' },
    });
  });
});

describe('shipped thinkers', () => {
  it('both pass validateEventTarget as real event targets', () => {
    for (const thinker of [axMindMonolith({ ai }), axMindResponder({ ai })]) {
      const target = axMindThinkerTarget(thinker, {
        run: async () => ({}),
        assemble: async () => ({}),
        mind: () => ({}) as never,
      });
      expect(() => validateEventTarget(target)).not.toThrow();
      expect(target.id).toBe(thinker.name);
    }
  });

  it('the monolith subscribes broadly and the responder only to messages', () => {
    expect(axMindMonolith({ ai }).subscription.types).toBeUndefined();
    expect(axMindResponder({ ai }).subscription.types).toEqual(['message']);
    // Neither triggers on its own writes by default.
    expect(axMindMonolith({ ai }).subscription.triggerSelf).toBe(false);
    expect(axMindResponder({ ai }).subscription.triggerSelf).toBe(false);
  });

  it('the responder is a single generation with no tool loop', async () => {
    const responder = axMindResponder({ ai });
    const program = await responder.createProgram!({
      thinker: 'responder',
      instanceKey: 'responder',
      mind: {} as never,
    });
    const signature = program.getSignature().toString();
    expect(signature).toContain('conversation');
    expect(signature).toContain('decision');
    // A tool loop would show up as functions on the program; a single
    // generation has none, which is what makes it cheap per message.
    expect((program as { getFunctions?: () => unknown }).getFunctions).toBe(
      undefined
    );
    expect(responder.subscription.watchdogMs).toBe(300_000);
  });

  it('the responder builds a chat-shaped context with an inner-life block', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryTrajectoryStore({ clock });
    void store;
    const responder = axMindResponder({ ai });
    const assembled = (await responder.context(
      request({
        thinker: 'responder',
        projection: projection([
          step(1, 'message', { from: 'ada', content: 'are you there' }),
          step(2, 'thought', { content: 'she asked something' }),
          step(3, 'message', { from: 'mind', content: 'yes' }),
        ]),
      })
    )) as { conversation: string; innerLife?: string };
    expect(assembled.conversation).toBe('ada: are you there\nmind: yes');
    expect(assembled.innerLife).toBe('thought: she asked something');
    // No inner life is an ABSENT field, not an empty one: the signature makes
    // it optional so the prompt does not carry a blank section.
    const bare = (await responder.context(
      request({
        projection: projection([
          step(1, 'message', { from: 'ada', content: 'hi' }),
        ]),
      })
    )) as { innerLife?: string };
    expect(bare.innerLife).toBeUndefined();
  });

  it('the monolith renders one prompt field carrying persona, goals and hints', async () => {
    const monolith = axMindMonolith({ ai });
    const assembled = (await monolith.context(
      request({
        signals: [{ code: 'share_nudge', text: 'you have been quiet' }],
        artifacts: {
          revision: 'rev-3',
          persona: 'PERSONA',
          thinkerPrompts: {},
          goals: [goal()],
          skills: [],
        },
      })
    )) as { mindContext: string };
    expect(Object.keys(assembled)).toEqual(['mindContext']);
    expect(assembled.mindContext).toContain('PERSONA');
    expect(assembled.mindContext).toContain('stay useful');
    expect(assembled.mindContext).toContain('[share_nudge]');
  });
});
