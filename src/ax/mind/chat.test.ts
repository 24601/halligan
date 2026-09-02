import { describe, expect, it } from 'vitest';

import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import { AxInMemoryEventStore } from '../event/memoryStore.js';
import { AxEventRuntime, eventRoute, eventTarget } from '../event/runtime.js';
import {
  type AxEventContext,
  type AxEventIngress,
  AxManualEventClock,
} from '../event/types.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import {
  axMindChat,
  axMindChatIdempotencyKey,
  axMindChatOperation,
  axMindInferReplyTo,
  axMindReconcileChatSends,
  axResolveMindReplyState,
} from './chat.js';
import {
  type AxMindChatMessage,
  type AxMindChatTransport,
  type AxMindEffectLedger,
  type AxMindSendReceipt,
  axIsMindChatError,
} from './types.js';

const TRAJECTORY = 'traj-chat';
const SELF = 'mind';

function transportFor(
  behaviour: { failures?: number } = {}
): AxMindChatTransport & {
  sent: Array<{ message: Readonly<AxMindChatMessage>; key: string }>;
} {
  let failures = behaviour.failures ?? 0;
  const sent: Array<{ message: Readonly<AxMindChatMessage>; key: string }> = [];
  return {
    id: 'test-transport',
    selfName: SELF,
    sent,
    async send(message, context): Promise<AxMindSendReceipt> {
      if (failures > 0) {
        failures--;
        throw new Error('transport is unreachable');
      }
      sent.push({ message, key: context.idempotencyKey });
      return { externalId: `ext-${sent.length}`, at: 1_000 + sent.length };
    },
  };
}

function ledgerProgram(
  forward: (context: Readonly<AxEventContext>) => unknown | Promise<unknown>
): AxProgrammable<any, any> {
  const signature = new AxSignature('eventId?:string -> handled:boolean');
  return {
    getId: () => 'ledger-program',
    getSignature: () => signature,
    forward: async (_ai: unknown, _input: unknown, options: any) => {
      await forward(options.eventContext);
      return { handled: true };
    },
    streamingForward: async function* () {},
  } as unknown as AxProgrammable<any, any>;
}

function ingress(id: string): AxEventIngress {
  return {
    event: {
      specversion: '1.0',
      id,
      source: 'test://mind-chat',
      type: 'mind.wake',
    },
    identity: { tenantId: 'tenant-a' },
    trust: 'authenticated',
  };
}

/**
 * A REAL effect ledger: the runtime hands the program its `AxEventContext`,
 * which is exactly how a thinker reaches one through `extra.eventContext`.
 */
async function withLedgers<T>(
  bodies: readonly ((ledger: AxMindEffectLedger) => Promise<T>)[]
): Promise<T[]> {
  const store = new AxInMemoryEventStore();
  const results: T[] = [];
  const errors: unknown[] = [];
  const runtime = new AxEventRuntime({
    store,
    maxAttempts: 1,
    routes: bodies.map((body, index) =>
      eventRoute({
        id: `ledger-route-${index}`,
        match: { types: ['mind.wake'] },
        action: 'wake',
        target: eventTarget({
          id: `ledger-target-${index}`,
          ai: {} as never,
          program: ledgerProgram(async (context) => {
            try {
              results.push(await body(context));
            } catch (error) {
              errors.push(error);
            }
          }),
          mapInput: () => ({}),
          retrySafety: 'effect-aware',
        }),
      })
    ),
  });
  await runtime.start();
  await runtime.publish(ingress(`wake-${Math.random()}`));
  await runtime.waitForIdle();
  await runtime.close();
  if (errors.length) throw errors[0];
  return results;
}

async function withLedger<T>(
  body: (ledger: AxMindEffectLedger) => Promise<T>
): Promise<T> {
  const [result] = await withLedgers([body]);
  return result as T;
}

async function seed() {
  const clock = new AxManualEventClock(1_000);
  const store = new AxInMemoryTrajectoryStore({ clock });
  await store.create({ trajectoryId: TRAJECTORY });
  return { store, clock };
}

async function inbound(
  store: AxInMemoryTrajectoryStore,
  from: string,
  content: string
): Promise<Readonly<AxTrajectoryStep>> {
  const receipt = await store.append({
    trajectoryId: TRAJECTORY,
    type: 'message',
    source: 'chat',
    data: { from, to: SELF, content },
  });
  return (await store.getStep(TRAJECTORY, receipt.stepId))!;
}

async function messages(
  store: AxInMemoryTrajectoryStore
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const tail = await store.tailBackward({
    trajectoryId: TRAJECTORY,
    limit: 50,
    types: ['message'],
  });
  return tail.steps;
}

describe('axMindChatIdempotencyKey', () => {
  it('is byte-identical across attempts with different claim ids', async () => {
    const first = await axMindChatIdempotencyKey({
      identityScope: TRAJECTORY,
      to: 'ada',
      replyTo: 'step-7',
      claimId: 'claim-a',
    });
    const second = await axMindChatIdempotencyKey({
      identityScope: TRAJECTORY,
      to: 'ada',
      replyTo: 'step-7',
      claimId: 'claim-b',
    });
    // Disjunctive, not conjunctive: a per-attempt claimId inside a key that
    // also carries replyTo would make the key per-attempt and destroy the
    // cross-attempt dedupe every guard here depends on.
    expect(first).toBe(second);
    expect(first.startsWith('ax.mind.chat:')).toBe(true);
  });

  it('separates recipients, trajectories and antecedents', async () => {
    const base = {
      identityScope: TRAJECTORY,
      to: 'ada',
      replyTo: 'step-7',
    } as const;
    const key = await axMindChatIdempotencyKey(base);
    expect(await axMindChatIdempotencyKey({ ...base, to: 'bob' })).not.toBe(
      key
    );
    expect(
      await axMindChatIdempotencyKey({ ...base, replyTo: 'step-8' })
    ).not.toBe(key);
    expect(
      await axMindChatIdempotencyKey({ ...base, identityScope: 'other' })
    ).not.toBe(key);
  });

  it('falls back to the claim, then to the caller discriminator', async () => {
    const claimed = await axMindChatIdempotencyKey({
      identityScope: TRAJECTORY,
      to: 'ada',
      claimId: 'claim-a',
    });
    expect(
      await axMindChatIdempotencyKey({
        identityScope: TRAJECTORY,
        to: 'ada',
        claimId: 'claim-b',
      })
    ).not.toBe(claimed);
    // An unsolicited message has neither: two identical bodies to one
    // recipient ARE the duplicate the key should catch.
    const unsolicited = await axMindChatIdempotencyKey({
      identityScope: TRAJECTORY,
      to: 'ada',
      fallback: 'digest-of-hello',
    });
    expect(
      await axMindChatIdempotencyKey({
        identityScope: TRAJECTORY,
        to: 'ada',
        fallback: 'digest-of-hello',
      })
    ).toBe(unsolicited);
  });
});

describe('axResolveMindReplyState', () => {
  const trigger = {
    stepId: 'trigger',
    trajectoryId: TRAJECTORY,
    seq: 1,
    type: 'message',
    ts: 1_000,
    data: { from: 'ada', to: SELF, content: 'hi' },
  } satisfies AxTrajectoryStep;
  const options = {
    triggerStepId: 'trigger',
    triggerSeq: 1,
    triggerFrom: 'ada',
    selfName: SELF,
    // The mind's own writer identities. Outbound-ness is decided by the
    // host-stamped `source`, never by the remote-controlled `data.from`.
    selfSources: ['responder'],
    now: 2_000,
    claimTtlMs: 1_000,
  };
  const step = (
    overrides: Partial<AxTrajectoryStep> & { seq: number; type: string }
  ): AxTrajectoryStep => ({
    stepId: `s${overrides.seq}`,
    trajectoryId: TRAJECTORY,
    ts: 1_500,
    data: {},
    ...overrides,
  });

  it('is unanswered with nothing but the trigger', () => {
    expect(axResolveMindReplyState([trigger], options)).toEqual({
      state: 'unanswered',
      failedOpen: false,
      widened: false,
    });
  });

  it('a fresh claim blocks and a stale one does not', () => {
    const claim = step({
      seq: 2,
      type: 'reply-claim',
      triggerStep: 'trigger',
      data: { claimId: 'c1', expiresAt: 2_500 },
    });
    expect(axResolveMindReplyState([trigger, claim], options).state).toBe(
      'claimed'
    );
    const stale = { ...claim, data: { claimId: 'c1', expiresAt: 1_999 } };
    const resolved = axResolveMindReplyState([trigger, stale], options);
    // Fails OPEN: the crashed-composer case must retry, and treating a stale
    // claim as handled is how messages dropped forever.
    expect(resolved.state).toBe('unanswered');
    expect(resolved.failedOpen).toBe(true);
  });

  it('a claim with a non-finite time counts as stale', () => {
    const claim = step({
      seq: 2,
      type: 'reply-claim',
      triggerStep: 'trigger',
      ts: Number.NaN,
      data: { claimId: 'c1', expiresAt: Number.POSITIVE_INFINITY },
    });
    const resolved = axResolveMindReplyState([trigger, claim], options);
    expect(resolved.state).toBe('unanswered');
    expect(resolved.failedOpen).toBe(true);
  });

  it('the OLDEST live claim owns the reply and a loser claim is inert', () => {
    const first = step({
      seq: 2,
      type: 'reply-claim',
      triggerStep: 'trigger',
      launchedBy: 'responder-a',
      data: { claimId: 'c1', expiresAt: 9_000 },
    });
    const loser = step({
      seq: 3,
      type: 'reply-claim',
      triggerStep: 'trigger',
      launchedBy: 'responder-b',
      data: { claimId: 'c2', expiresAt: 9_000 },
    });
    const steps = [trigger, first, loser];
    // The winner is not blocked by the claim the loser could not retract --
    // steps are immutable, so any-live-claim-blocks would deadlock the winner.
    expect(
      axResolveMindReplyState(steps, { ...options, owner: 'responder-a' }).state
    ).toBe('unanswered');
    expect(
      axResolveMindReplyState(steps, { ...options, owner: 'responder-b' }).state
    ).toBe('claimed');
    // With no asking thinker, a live claim blocks: an anonymous reader must
    // not conclude the message is free to answer.
    expect(axResolveMindReplyState(steps, options).state).toBe('claimed');
  });

  it('a recorded decline outranks the positional net', () => {
    const declined = step({
      seq: 2,
      type: 'observation',
      triggerStep: 'trigger',
      data: { decision: 'no-reply' },
    });
    const later = step({
      seq: 3,
      type: 'message',
      source: 'responder',
      data: { from: SELF, to: 'ada', content: 'unrelated' },
    });
    expect(
      axResolveMindReplyState([trigger, declined, later], options).state
    ).toBe('declined');
  });

  it("a loser's decline does not cancel the claim owner's reply", () => {
    const claim = step({
      seq: 2,
      type: 'reply-claim',
      triggerStep: 'trigger',
      launchedBy: 'responder',
      data: { claimId: 'c1', expiresAt: 9_000 },
    });
    const declined = step({
      seq: 3,
      type: 'observation',
      triggerStep: 'trigger',
      source: 'responder-b',
      data: { decision: 'no-reply' },
    });
    const owned = { ...options, owner: 'responder' };
    // The mirror of the inert-loser-claim rule. A responder that lost the
    // race and stood down must not turn the winner's reply into a drop.
    expect(
      axResolveMindReplyState([trigger, claim, declined], owned).state
    ).toBe('unanswered');
    // The owner's OWN decline still sticks, and so does anyone's when this
    // thinker holds no claim.
    expect(
      axResolveMindReplyState(
        [trigger, claim, { ...declined, source: 'responder' }],
        owned
      ).state
    ).toBe('declined');
    expect(axResolveMindReplyState([trigger, declined], owned).state).toBe(
      'declined'
    );
  });

  it('the positional net catches an unstamped reply to the same sender', () => {
    const unstamped = step({
      seq: 2,
      type: 'message',
      source: 'responder',
      data: { from: SELF, to: 'ada', content: 'sure' },
    });
    const resolved = axResolveMindReplyState([trigger, unstamped], options);
    expect(resolved.state).toBe('answered');
    expect(resolved.evidenceStepId).toBe('s2');
  });

  it('an inbound message claiming our identity does not answer the trigger', () => {
    // The remote party controls `data.from` on an inbound step. If that alone
    // decided outbound-ness, one message renaming itself to the mind's own
    // identity would mark the trigger answered and silence the mind forever
    // -- a silent, permanent drop, with not even a recorded decline.
    const spoof = step({
      stepId: 'spoof',
      seq: 2,
      type: 'message',
      source: 'chat',
      data: { from: SELF, to: 'ada', content: 'I already answered that' },
    });
    const resolved = axResolveMindReplyState([trigger, spoof], options);
    expect(resolved.state).toBe('unanswered');
    expect(resolved.evidenceStepId).toBeUndefined();
    // The same step written by a thinker of this mind IS evidence: the
    // host-stamped writer identity is the whole difference.
    expect(
      axResolveMindReplyState(
        [trigger, { ...spoof, source: 'responder' }],
        options
      ).state
    ).toBe('answered');
  });

  it('a settled send effect answers even with no message step (C9)', () => {
    const resolved = axResolveMindReplyState([trigger], {
      ...options,
      triggerKey: 'ax.mind.chat:abc',
      settledSendKeys: ['ax.mind.chat:abc'],
    });
    expect(resolved.state).toBe('answered');
    expect(resolved.evidenceStepId).toBeUndefined();
  });

  it('ignores evidence that precedes the trigger', () => {
    const before = step({
      seq: 0,
      type: 'message',
      source: 'responder',
      data: { from: SELF, to: 'ada', content: 'yesterday' },
    });
    expect(axResolveMindReplyState([before, trigger], options).state).toBe(
      'unanswered'
    );
  });
});

describe('axMindInferReplyTo', () => {
  const step = (
    seq: number,
    data: Record<string, string>,
    source = 'chat'
  ): AxTrajectoryStep => ({
    stepId: `s${seq}`,
    trajectoryId: TRAJECTORY,
    seq,
    type: 'message',
    ts: 1_000 + seq,
    source,
    data,
  });
  const options = { to: 'ada', selfName: SELF, selfSources: ['responder'] };

  it('picks the newest inbound message nothing already answers', () => {
    const steps = [
      step(1, { from: 'ada', to: SELF, content: 'one' }),
      step(2, { from: 'ada', to: SELF, content: 'two' }),
      step(
        3,
        { from: SELF, to: 'ada', content: 'answering one', replyTo: 's1' },
        'responder'
      ),
    ];
    expect(axMindInferReplyTo(steps, options)).toBe('s2');
  });

  it('invents no antecedent when there is nothing to answer', () => {
    const steps = [step(1, { from: 'bob', to: SELF, content: 'hi' })];
    expect(axMindInferReplyTo(steps, options)).toBeUndefined();
  });

  it('a message claiming our identity is neither an answer nor an antecedent', () => {
    const steps = [
      step(1, { from: 'ada', to: SELF, content: 'one' }),
      // Inbound, but claiming to be from us and to answer s1. Believing it
      // would skip s1 and make the mind answer the wrong message.
      step(2, {
        from: SELF,
        to: 'ada',
        content: 'not really us',
        replyTo: 's1',
      }),
    ];
    expect(axMindInferReplyTo(steps, options)).toBe('s1');
  });
});

describe('axMindChat send and reply', () => {
  it('stamps replyTo at the transport and infers it when omitted', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'are you there?');
    const result = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
      });
      return chat.reply({ to: 'ada', content: 'here' });
    });
    expect(result.sent).toBe(true);
    expect(result.step?.data.replyTo).toBe(trigger.stepId);
    expect(result.step?.triggerStep).toBe(trigger.stepId);
    expect(result.step?.source).toBe('responder');
    expect(result.step?.data.from).toBe(SELF);
    expect(transport.sent).toHaveLength(1);
  });

  it('a reply that answers nothing stays unstamped', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const result = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'monolith',
        transport,
        effects: () => effects,
      });
      return chat.reply({ to: 'ada', content: 'unprompted hello' });
    });
    expect(result.sent).toBe(true);
    expect(result.step?.data.replyTo).toBeUndefined();
    expect(result.step?.triggerStep).toBeUndefined();
  });

  it('refuses a second reply with already_answered', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'ping');
    const results = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
      });
      const first = await chat.reply({
        to: 'ada',
        content: 'pong',
        replyTo: trigger.stepId,
      });
      const second = await chat.reply({
        to: 'ada',
        content: 'pong again',
        replyTo: trigger.stepId,
      });
      return { first, second };
    });
    expect(results.first.sent).toBe(true);
    expect(results.second).toEqual({ sent: false, reason: 'already_answered' });
    expect(transport.sent).toHaveLength(1);
  });

  it('records NO_REPLY as a decision that sticks across redelivery', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'nothing to answer here');
    const results = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
      });
      const decision = await chat.recordDecision(
        'no-reply',
        trigger.stepId,
        'small talk'
      );
      const state = await chat.replyState(trigger.stepId);
      const retry = await chat.reply({
        to: 'ada',
        content: 'actually...',
        replyTo: trigger.stepId,
      });
      return { decision, state, retry };
    });
    expect(results.decision.data.decision).toBe('no-reply');
    expect(results.state.state).toBe('declined');
    // A decline is a RECORDED DECISION, never a silent drop, and it survives
    // the message being redelivered.
    expect(results.retry).toEqual({ sent: false, reason: 'declined' });
    expect(transport.sent).toHaveLength(0);
  });

  it('derives answered-ness when the decision observation is missing', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'ping');
    const state = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
      });
      await chat.send({ to: 'ada', content: 'pong', replyTo: trigger.stepId });
      // Crash C11: the outbound step landed, the decision observation never
      // did. The replyTo fact alone is load-bearing.
      return chat.replyState(trigger.stepId);
    });
    expect(state.state).toBe('answered');
  });

  it('refuses a self-addressed send and explains it in band', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const error = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'monolith',
        transport,
        effects: () => effects,
      });
      return chat.send({ to: SELF, content: 'note to self' }).catch((e) => e);
    });
    expect(axIsMindChatError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe('self_addressed');
    expect(transport.sent).toHaveLength(0);
    const observations = await store.tailBackward({
      trajectoryId: TRAJECTORY,
      limit: 5,
      types: ['observation'],
    });
    // Explained in band: the refusal teaches, in the mind's own log.
    expect(observations.steps).toHaveLength(1);
    expect(String(observations.steps[0]!.data.content)).toContain(
      'A message is for someone else'
    );
  });

  it('refuses an empty message and a send with no ledger', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const chat = axMindChat({
      trajectoryId: TRAJECTORY,
      store,
      clock,
      sender: 'monolith',
      transport,
    });
    await expect(chat.send({ to: 'ada', content: '  ' })).rejects.toMatchObject(
      {
        reason: 'empty_content',
      }
    );
    // M15: an outbound send is a declared effect BEFORE any I/O, so with no
    // ledger to declare it on the send is refused rather than done blind.
    await expect(chat.send({ to: 'ada', content: 'hi' })).rejects.toMatchObject(
      {
        code: 'mind_configuration_invalid',
        reason: 'effect_store_required',
      }
    );
    expect(transport.sent).toHaveLength(0);
  });

  it('widens the read when the trigger falls outside the tail window', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'the old question');
    for (let index = 0; index < 12; index++) {
      await inbound(store, 'bob', `noise ${index}`);
    }
    const state = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
        tailLimit: 4,
      });
      return chat.replyState(trigger.stepId);
    });
    // A window that misses the trigger could report an answered message as
    // unanswered and reply twice: worth one wider bounded read.
    expect(state.widened).toBe(true);
    expect(state.state).toBe('unanswered');
  });
});

describe('claims and concurrent responders', () => {
  const RESPONDERS = ['responder-a', 'responder-b'] as const;

  it('two concurrent responders produce exactly one reply and one recorded decline', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'who is going to answer me?');
    // Two DELIVERIES from one publish, each with its own effect ledger. They
    // interleave at every await; arbitration is by the log, never by timing --
    // which is what makes the outcome deterministic rather than lucky.
    const responder = (name: string) => async (effects: AxMindEffectLedger) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: name,
        selfSources: RESPONDERS,
        transport,
        effects: () => effects,
      });
      try {
        await chat.claim(trigger.stepId);
      } catch (error) {
        if (!axIsMindChatError(error)) throw error;
        await chat.recordDecision(
          'no-reply',
          trigger.stepId,
          `${name} lost the claim: ${error.reason}`
        );
        return 'declined';
      }
      const result = await chat.reply({
        to: 'ada',
        content: `${name} here`,
        replyTo: trigger.stepId,
      });
      if (!result.sent) {
        await chat.recordDecision(
          'no-reply',
          trigger.stepId,
          'already handled'
        );
        return 'declined';
      }
      return 'replied';
    };

    const outcomes = await withLedgers([
      responder('responder-a'),
      responder('responder-b'),
    ]);
    expect(outcomes.filter((one) => one === 'replied')).toHaveLength(1);
    expect(outcomes.filter((one) => one === 'declined')).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);

    const outbound = (await messages(store)).filter(
      (step) => step.data.from === SELF
    );
    expect(outbound).toHaveLength(1);
    const declines = await store.tailBackward({
      trajectoryId: TRAJECTORY,
      limit: 10,
      types: ['observation'],
    });
    expect(
      declines.steps.filter((step) => step.data.decision === 'no-reply')
    ).toHaveLength(1);
  });

  it('a responder that read unanswered before the winner replied still cannot reply', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'anyone?');
    const outcome = await withLedger(async (effects) => {
      const chat = (name: string) =>
        axMindChat({
          trajectoryId: TRAJECTORY,
          store,
          clock,
          sender: name,
          selfSources: RESPONDERS,
          transport,
          effects: () => effects,
        });
      const alpha = chat('responder-a');
      const beta = chat('responder-b');
      // The lost-update shape, forced: BOTH read the state before either acts.
      const seenByAlpha = await alpha.replyState(trigger.stepId);
      const seenByBeta = await beta.replyState(trigger.stepId);
      await alpha.claim(trigger.stepId);
      const alphaReply = await alpha.reply({
        to: 'ada',
        content: 'alpha here',
        replyTo: trigger.stepId,
      });
      const betaClaim = await beta.claim(trigger.stepId).catch((one) => one);
      const betaReply = await beta.reply({
        to: 'ada',
        content: 'beta here',
        replyTo: trigger.stepId,
      });
      return { seenByAlpha, seenByBeta, alphaReply, betaClaim, betaReply };
    });
    expect(outcome.seenByAlpha.state).toBe('unanswered');
    expect(outcome.seenByBeta.state).toBe('unanswered');
    expect(outcome.alphaReply.sent).toBe(true);
    expect(axIsMindChatError(outcome.betaClaim)).toBe(true);
    // `already_answered`, not `claimed`: beta sees its SIBLING's outbound step
    // as ours because the mind passes every thinker identity. With only its
    // own name it would fall through to the weaker claim evidence.
    expect(outcome.betaReply).toEqual({
      sent: false,
      reason: 'already_answered',
    });
    expect(transport.sent).toHaveLength(1);
  });

  it('a fresh claim blocks a second claimer and a stale one does not', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'ping');
    const outcome = await withLedger(async (effects) => {
      const chat = (name: string) =>
        axMindChat({
          trajectoryId: TRAJECTORY,
          store,
          clock,
          sender: name,
          transport,
          effects: () => effects,
          claimTtlMs: 5_000,
        });
      await chat('a').claim(trigger.stepId);
      const blocked = await chat('b')
        .claim(trigger.stepId)
        .catch((error) => error);
      clock.advanceBy(5_001);
      const afterExpiry = await chat('b').claim(trigger.stepId);
      return { blocked, afterExpiry };
    });
    expect(axIsMindChatError(outcome.blocked)).toBe(true);
    expect((outcome.blocked as { reason: string }).reason).toBe('claimed');
    // The crashed composer's claim expires and the message becomes answerable
    // again, because a retry is safer than a dropped message.
    expect(outcome.afterExpiry.claimId).toBeTruthy();
  });
});

describe('store contract failures', () => {
  it('a store that cannot read back its own append fails with a typed error', async () => {
    const { store, clock } = await seed();
    const trigger = await inbound(store, 'ada', 'ping');
    // A store that accepts an append and then cannot return the step has
    // broken its contract. `step!` would hand the caller `undefined` dressed
    // as a step and fail somewhere else entirely.
    const blind = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'getStep') return async () => undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const chat = axMindChat({
      trajectoryId: TRAJECTORY,
      store: blind,
      clock,
      sender: 'responder',
    });
    const error = await chat
      .recordDecision('no-reply', trigger.stepId)
      .catch((one) => one);
    expect(error).toMatchObject({
      code: 'trajectory_append_failed',
      reason: 'store_failure',
      phase: 'index',
    });
  });
});

describe('the ledger boundary', () => {
  it('a crash between dispatch and settle parks the effect and sends nothing twice', async () => {
    const { store, clock } = await seed();
    const transport = transportFor({ failures: 1 });
    const trigger = await inbound(store, 'ada', 'ping');
    const outcome = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
      });
      const message = {
        to: 'ada',
        content: 'pong',
        replyTo: trigger.stepId,
      } as const;
      const first = await chat.send(message).catch((error) => error);
      const second = await chat.send(message).catch((error) => error);
      return { first, second, effects: await effects.listEffects() };
    });
    // A thrown transport call is not proof of failure: the effect stays
    // `dispatched` for a resolver to classify, and the retry refuses rather
    // than sending a second copy of the same message.
    expect((outcome.first as { reason: string }).reason).toBe(
      'send_indeterminate'
    );
    expect((outcome.second as { reason: string }).reason).toBe(
      'send_indeterminate'
    );
    expect(transport.sent).toHaveLength(0);
    const sends = outcome.effects.filter(
      (effect) => effect.operation === axMindChatOperation
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]!.status).toBe('dispatched');
    expect(await messages(store)).toHaveLength(1);
  });

  it('the send site refuses a duplicate reply and appends nothing', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'ping');
    const outcome = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'responder',
        transport,
        effects: () => effects,
      });
      const first = await chat.send({
        to: 'ada',
        content: 'pong',
        replyTo: trigger.stepId,
      });
      // The last guard, reached by a bare `send` that never consulted
      // reply state: the same body, and a different body under the same
      // antecedent, are both refused before any effect is declared.
      const repeat = await chat
        .send({ to: 'ada', content: 'pong', replyTo: trigger.stepId })
        .catch((one) => one);
      const different = await chat
        .send({
          to: 'ada',
          content: 'a different pong',
          replyTo: trigger.stepId,
        })
        .catch((one) => one);
      return { first, repeat, different };
    });
    expect(axIsMindChatError(outcome.repeat)).toBe(true);
    expect((outcome.repeat as { reason: string }).reason).toBe(
      'already_answered'
    );
    expect((outcome.different as { reason: string }).reason).toBe(
      'already_answered'
    );
    expect(transport.sent).toHaveLength(1);
    // Trigger plus exactly one outbound step: a refusal writes no message.
    expect(await messages(store)).toHaveLength(2);
  });

  it('a duplicate send appends no second message step', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const outcome = await withLedger(async (effects) => {
      const chat = axMindChat({
        trajectoryId: TRAJECTORY,
        store,
        clock,
        sender: 'monolith',
        transport,
        effects: () => effects,
      });
      const body = { to: 'ada', content: 'the same unsolicited hello' };
      const first = await chat.send(body);
      // Key reuse: the effect is already `succeeded`, so nothing leaves the
      // process. The append-only log must not gain a second reply either --
      // there is no delete path to take one back.
      const second = await chat.send(body);
      return { first, second };
    });
    expect(transport.sent).toHaveLength(1);
    expect(outcome.second.stepId).toBe(outcome.first.stepId);
    expect(await messages(store)).toHaveLength(1);
  });

  it('key reuse with a different body fails closed at the ledger', async () => {
    const error = await withLedger(async (effects) => {
      const key = await axMindChatIdempotencyKey({
        identityScope: TRAJECTORY,
        to: 'ada',
        replyTo: 'trigger',
      });
      const declare = (content: string) =>
        effects.declareEffect({
          operation: axMindChatOperation,
          idempotencyKey: key,
          replaySafety: 'unknown',
          metadata: { to: 'ada', trajectoryId: TRAJECTORY, content },
        });
      await declare('pong');
      // Same key, DIFFERENT canonical request: the ledger refuses the reuse
      // rather than quietly treating a new message as the old one.
      return declare('a different pong').catch((one) => one);
    });
    expect(String((error as Error).message)).toContain(
      'conflicts with existing'
    );
  });

  it('a settled effect with no message step answers, and reconcile appends it', async () => {
    const { store, clock } = await seed();
    const transport = transportFor();
    const trigger = await inbound(store, 'ada', 'did you get this?');
    const options = {
      trajectoryId: TRAJECTORY,
      store,
      clock,
      sender: 'responder',
      transport,
    };
    const diagnostics: string[] = [];
    const outcome = await withLedger(async (effects) => {
      const key = await axMindChatIdempotencyKey({
        identityScope: TRAJECTORY,
        to: 'ada',
        replyTo: trigger.stepId,
      });
      // Crash C10 exactly: the effect settled, the process died before the
      // outbound message step was appended.
      const declared = await effects.declareEffect({
        operation: axMindChatOperation,
        idempotencyKey: key,
        replaySafety: 'unknown',
        metadata: {
          to: 'ada',
          trajectoryId: TRAJECTORY,
          content: 'yes, received',
          replyTo: trigger.stepId,
        },
      });
      const dispatched = await effects.markEffectDispatched(
        declared.id,
        declared.version
      );
      await effects.settleEffect(dispatched.id, dispatched.version, {
        status: 'succeeded',
        receipt: { at: 1_200 },
      });
      const chat = axMindChat({ ...options, effects: () => effects });
      const before = await chat.replyState(trigger.stepId);
      const appended = await axMindReconcileChatSends({
        ...options,
        effects: () => effects,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      });
      const again = await axMindReconcileChatSends({
        ...options,
        effects: () => effects,
      });
      return { before, appended, again };
    });

    // Answered-ness comes from the LEDGER, so a missing step cannot make the
    // mind re-compose an answer it already sent.
    expect(outcome.before.state).toBe('answered');
    expect(outcome.appended).toHaveLength(1);
    expect(outcome.appended[0]!.data.content).toBe('yes, received');
    expect(outcome.appended[0]!.data.replyTo).toBe(trigger.stepId);
    expect(diagnostics).toEqual(['effect-step-reconciled']);
    // The log converges to the ledger ONCE: reconcile is idempotent.
    expect(outcome.again).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });
});
