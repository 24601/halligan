import { describe, expect, it } from 'vitest';

import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import { AxEventRuntime, eventTarget } from '../event/runtime.js';
import {
  type AxEventIngress,
  type AxEventTarget,
  AxManualEventClock,
} from '../event/types.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import {
  axMindEventRoutes,
  axMindEventSource,
  axMindEventTypes,
  axMindPendingClass,
  axMindStepEventExtensions,
  axMindSubscribedStepTypes,
  axMindThinkerSubject,
  axMindWakeRoute,
} from './routes.js';
import {
  type AxMindSubscription,
  type AxMindThinker,
  axDefaultMindSubscription,
} from './types.js';

const MIND = 'mind-under-test';
const SOURCE = axMindEventSource(MIND);
const registry = axTrajectoryTypeRegistry();

/** The event-plane house pattern: a program object, no AI service required. */
function program(record: (input: unknown) => void): AxProgrammable<any, any> {
  return {
    getId: () => 'thinker-program',
    getSignature: () => new AxSignature('eventId?:string -> handled:boolean'),
    forward: (_ai: unknown, input: unknown) => {
      record(input);
      return Promise.resolve({ handled: true });
    },
    streamingForward: async function* () {},
  } as unknown as AxProgrammable<any, any>;
}

function thinker(
  name: string,
  subscription: Partial<AxMindSubscription> = {}
): Readonly<AxMindThinker> {
  return {
    name,
    kind: 'monolith',
    subscription: { ...axDefaultMindSubscription, ...subscription },
    ai: {} as never,
    program: program(() => {}),
  };
}

function target(
  id: string,
  seen: unknown[] = []
): { target: AxEventTarget<any, any>; seen: unknown[] } {
  return {
    seen,
    target: eventTarget({
      id,
      ai: {} as never,
      program: program(() => {}),
      mapInput: (ingress) => {
        seen.push(ingress.event);
        return {};
      },
    }),
  };
}

function stepEvent(
  step: Readonly<Partial<AxTrajectoryStep> & { type: string }>,
  id = `step-${step.type}-${step.source ?? 'none'}`
): AxEventIngress {
  const full: AxTrajectoryStep = {
    stepId: id,
    trajectoryId: 'traj',
    seq: 1,
    ts: 1_000,
    data: {},
    ...step,
  };
  return {
    event: {
      specversion: '1.0',
      id,
      source: SOURCE,
      type: axMindEventTypes.step,
      subject: full.type,
      data: { stepId: full.stepId, seq: full.seq, type: full.type },
      extensions: axMindStepEventExtensions(full),
    },
    trust: 'trusted',
  };
}

function paceEvent(
  thinkerName: string,
  id: string,
  coalesced?: number
): AxEventIngress {
  return {
    event: {
      specversion: '1.0',
      id,
      source: SOURCE,
      type: axMindEventTypes.wake,
      subject: axMindThinkerSubject(thinkerName),
      data: {
        thinker: thinkerName,
        ...(coalesced !== undefined ? { coalesced } : {}),
      },
      extensions: { stepsource: 'mind-tick' },
    },
    trust: 'trusted',
  };
}

function runtimeFor(
  thinkers: readonly Readonly<AxMindThinker>[],
  targets: Record<string, AxEventTarget<any, any>>,
  clock?: AxManualEventClock
) {
  return new AxEventRuntime({
    ...(clock ? { clock } : {}),
    workerConcurrency: 1,
    routes: [
      ...axMindEventRoutes({
        mindId: MIND,
        thinkers,
        targets,
        registry,
        sourceId: SOURCE,
        tickMs: 100,
      }),
    ],
  });
}

describe('axMindSubscribedStepTypes', () => {
  it('defaults to wakeable narrative types and never to machinery', () => {
    const types = axMindSubscribedStepTypes(
      axDefaultMindSubscription,
      registry
    );
    expect(types).toContain('message');
    expect(types).toContain('observation');
    expect(types).toContain('error');
    // Machinery bookkeeping is opt-in: the mind's own pace records, feedback
    // and reply claims never wake a default thinker.
    expect(types).not.toContain('mind-wake');
    expect(types).not.toContain('feedback');
    expect(types).not.toContain('reply-claim');
  });

  it('drops a subscribed type the registry declares unwakeable', () => {
    const types = axMindSubscribedStepTypes(
      { ...axDefaultMindSubscription, types: ['message', 'feedback'] },
      registry
    );
    expect(types).toEqual(['message']);
  });

  it('unions explicit types with subscribed classes', () => {
    const types = axMindSubscribedStepTypes(
      {
        ...axDefaultMindSubscription,
        types: ['mind-wake'],
        classes: ['narrative'],
      },
      registry
    );
    expect(types).toContain('mind-wake');
    expect(types).toContain('thought');
  });
});

describe('axMindPendingClass', () => {
  it('derives coalescing from the registry wakeSignal flag', () => {
    expect(axMindPendingClass('message', registry)).toBe('queue');
    expect(axMindPendingClass('observation', registry)).toBe('queue');
    expect(axMindPendingClass('mind-wake', registry)).toBe('coalesce');
    expect(axMindPendingClass('manual-trigger', registry)).toBe('coalesce');
    // An unregistered type is not a wake signal, so it queues.
    expect(axMindPendingClass('host.custom', registry)).toBe('queue');
  });
});

describe('axMindWakeRoute', () => {
  it('sets debounceMs whenever it sets coalesce', () => {
    const queue = axMindWakeRoute(thinker('monolith'), target('t').target, {
      registry,
      sourceId: SOURCE,
      tickMs: 250,
    });
    expect(queue.coalesce).toBeUndefined();
    expect(queue.debounceMs).toBeUndefined();
    expect(queue.ordering).toBe('strict');

    const signals = axMindWakeRoute(thinker('monolith'), target('t').target, {
      registry,
      sourceId: SOURCE,
      tickMs: 250,
      pending: 'coalesce',
    });
    expect(signals.coalesce).toBe('latest');
    expect(signals.debounceMs).toBe(250);
    // validateEventRoute rejects coalesce without debounceMs; a route that
    // cannot be validated is a route that never runs.
    expect(() => new AxEventRuntime({ routes: [signals] })).not.toThrow();
  });

  it('keys the instance by thinker so one run happens at a time', async () => {
    const route = axMindWakeRoute(thinker('monolith'), target('t').target, {
      registry,
      sourceId: SOURCE,
      tickMs: 100,
    });
    expect(
      route.instanceKey?.(stepEvent({ type: 'message', source: 'chat' }))
    ).toBe('monolith');
  });

  it('a thinker cannot reach the transport identity or the route table', () => {
    const one = thinker('monolith');
    const table = axMindEventRoutes({
      mindId: MIND,
      thinkers: [one],
      targets: { monolith: target('t').target },
      registry,
      sourceId: SOURCE,
      tickMs: 100,
    });
    // The thinker record carries no from-identity, no transport and no routes:
    // all three are host-owned options the mind never exposes to a program.
    expect(Object.keys(one)).toEqual([
      'name',
      'kind',
      'subscription',
      'ai',
      'program',
    ]);
    expect(JSON.stringify(Object.keys(one))).not.toContain('transport');
    // The table is frozen and rebuilt per call, so a program that reached one
    // route could still not edit the mind's routing.
    expect(Object.isFrozen(table)).toBe(true);
    expect(() => {
      (table as AxEventRuntime[]).push({} as never);
    }).toThrow();
  });
});

describe('mind wake routing through a real runtime', () => {
  it('suppresses a self-sourced step but not an external writer of the same type', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor([thinker('monolith')], {
      monolith: target('monolith', seen).target,
    });
    await runtime.start();

    const own = await runtime.publish(
      stepEvent({ type: 'observation', source: 'monolith' }, 'own')
    );
    const external = await runtime.publish(
      stepEvent({ type: 'observation', source: 'chat' }, 'external')
    );
    await runtime.waitForIdle();

    // No delivery is CREATED for the suppressed step: authorize runs inside
    // routeMatches, so the model is never reached, not merely not run.
    expect(own.deliveryIds).toEqual([]);
    expect(external.deliveryIds).toHaveLength(1);
    expect(seen).toHaveLength(1);
    await runtime.close();
  });

  it('delivers a self-sourced step when triggerSelf is set', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor([thinker('monolith', { triggerSelf: true })], {
      monolith: target('monolith', seen).target,
    });
    await runtime.start();
    const own = await runtime.publish(
      stepEvent({ type: 'observation', source: 'monolith' }, 'own-allowed')
    );
    await runtime.waitForIdle();
    expect(own.deliveryIds).toHaveLength(1);
    await runtime.close();
  });

  it("never re-triggers on the thinker's own error step even with triggerSelf", async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor([thinker('monolith', { triggerSelf: true })], {
      monolith: target('monolith', seen).target,
    });
    await runtime.start();
    const own = await runtime.publish(
      stepEvent({ type: 'error', source: 'monolith' }, 'own-error')
    );
    const other = await runtime.publish(
      stepEvent({ type: 'error', source: 'responder' }, 'other-error')
    );
    await runtime.waitForIdle();
    expect(own.deliveryIds).toEqual([]);
    expect(other.deliveryIds).toHaveLength(1);
    await runtime.close();
  });

  it('suppresses the mind own pace record even when it subscribes to it', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor(
      [thinker('monolith', { types: ['mind-wake'], triggerSelf: false })],
      { monolith: target('monolith', seen).target }
    );
    await runtime.start();
    // A machinery step carries no `source`, so writer identity travels as
    // `launchedBy`; without checking it a thinker would wake itself forever on
    // its own pace records.
    const mine = await runtime.publish(
      stepEvent({ type: 'mind-wake', launchedBy: 'monolith' }, 'own-pace')
    );
    const theirs = await runtime.publish(
      stepEvent({ type: 'mind-wake', launchedBy: 'responder' }, 'their-pace')
    );
    expect(mine.deliveryIds).toEqual([]);
    expect(theirs.deliveryIds).toHaveLength(1);
    await runtime.close({ drain: false });
  });

  it('payload types queue strictly and every one is delivered', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor([thinker('monolith')], {
      monolith: target('monolith', seen).target,
    });
    await runtime.start();
    const receipts = [];
    for (const index of [1, 2, 3]) {
      receipts.push(
        await runtime.publish(
          stepEvent(
            { type: 'message', source: 'chat', seq: index },
            `m${index}`
          )
        )
      );
    }
    await runtime.waitForIdle();
    // Each message carries a distinct payload, so each deserves its own wake:
    // three deliveries, three runs, no collapsing.
    expect(receipts.flatMap((receipt) => receipt.deliveryIds)).toHaveLength(3);
    expect(seen).toHaveLength(3);
    await runtime.close();
  });

  it('wake-signal types coalesce to the latest and record coalesced:n', async () => {
    const clock = new AxManualEventClock(1_000);
    const seen: unknown[] = [];
    const runtime = runtimeFor(
      [thinker('monolith')],
      { monolith: target('monolith', seen).target },
      clock
    );
    await runtime.start();
    const receipts = [];
    for (let index = 1; index <= 5; index++) {
      receipts.push(
        await runtime.publish(paceEvent('monolith', `w${index}`, index))
      );
    }
    // Five wake signals behind a busy thinker collapse into one delivery
    // rather than building a backlog of stale wakeups to burn tokens on.
    const first = receipts[0]!.deliveryIds;
    expect(first).toHaveLength(1);
    for (const receipt of receipts) expect(receipt.deliveryIds).toEqual(first);
    clock.advanceBy(100);
    for (let index = 0; index < 50; index++) await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect((seen[0] as { data: { coalesced: number } }).data.coalesced).toBe(5);
    await runtime.close({ drain: false });
  });

  it('a wakeable:false type matches no route', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor(
      [thinker('monolith', { classes: ['narrative', 'machinery'] })],
      { monolith: target('monolith', seen).target }
    );
    await runtime.start();
    // `feedback` is how salience is recorded; if it could wake a thinker the
    // injection would re-dispatch the very run it was injected into.
    const feedback = await runtime.publish(
      stepEvent({ type: 'feedback', launchedBy: 'host' }, 'fb')
    );
    await runtime.waitForIdle();
    expect(feedback.deliveryIds).toEqual([]);
    expect(seen).toHaveLength(0);
    await runtime.close();
  });

  it('routes only events from the mind own source', async () => {
    const seen: unknown[] = [];
    const runtime = runtimeFor([thinker('monolith')], {
      monolith: target('monolith', seen).target,
    });
    await runtime.start();
    const forged = stepEvent({ type: 'message', source: 'chat' }, 'forged');
    const receipt = await runtime.publish({
      ...forged,
      event: { ...forged.event, source: 'app://somewhere-else' },
    });
    await runtime.waitForIdle();
    expect(receipt.deliveryIds).toEqual([]);
    await runtime.close();
  });
});
