import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventIngress,
  type AxEventPublishReceipt,
  type AxEventSourceContext,
  AxManualEventClock,
} from '../event/types.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import type { AxTrajectoryStore } from '../trajectory/types.js';
import { axMindEventTypes } from './routes.js';
import {
  type AxMindTickDutyState,
  AxMindTickEventSource,
  type AxMindTrajectoryConsumer,
  AxTrajectoryEventSource,
  axMindTickDue,
} from './sources.js';
import { axDefaultMindSubscription } from './types.js';

const TRAJECTORY = 'traj-sources';
const registry = axTrajectoryTypeRegistry();

/** Counts sleeps so "constructing starts no timers" is a measurable claim. */
class CountingClock implements AxEventClock {
  sleeps = 0;
  constructor(readonly inner: AxManualEventClock) {}
  now(): number {
    return this.inner.now();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps++;
    return this.inner.sleep(ms, signal);
  }
}

function harness(signal: AbortSignal) {
  const published: AxEventIngress[] = [];
  const errors: unknown[] = [];
  let failures = 0;
  const context: AxEventSourceContext = {
    signal,
    publish: async (ingress) => {
      if (failures > 0) {
        failures--;
        throw new AxEventBackpressureError();
      }
      published.push(ingress);
      return {
        eventId: ingress.event.id,
        accepted: true,
        duplicate: false,
        durability: 'volatile',
        deliveryIds: [`delivery-${published.length}`],
      } satisfies AxEventPublishReceipt;
    },
    reportError: (error) => errors.push(error),
  };
  return {
    context,
    published,
    errors,
    failNext: (count: number) => {
      failures = count;
    },
    stepIds: () => published.map((one) => one.event.data as { stepId: string }),
  };
}

function consumer(
  thinker: string,
  inFlight: () => number,
  overrides: Partial<AxMindTrajectoryConsumer['subscription']> = {}
): AxMindTrajectoryConsumer {
  return {
    thinker,
    subscription: { ...axDefaultMindSubscription, ...overrides },
    inFlight,
  };
}

async function seed(clock: AxManualEventClock): Promise<AxTrajectoryStore> {
  const store = new AxInMemoryTrajectoryStore({ clock });
  await store.create({ trajectoryId: TRAJECTORY });
  return store;
}

async function message(store: AxTrajectoryStore, content: string) {
  return store.append({
    trajectoryId: TRAJECTORY,
    type: 'message',
    source: 'chat',
    data: { from: 'ada', to: 'mind', content },
  });
}

function dutyState(
  overrides: Partial<AxMindTickDutyState> = {}
): AxMindTickDutyState {
  return {
    thinker: 'monolith',
    lastActivityAt: 0,
    running: 0,
    deferred: 0,
    watchdogMs: 300_000,
    ...overrides,
  };
}

describe('AxTrajectoryEventSource', () => {
  it('starts at the end and replays nothing', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    await message(store, 'before the mind existed');
    const controller = new AbortController();
    const test = harness(controller.signal);
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [consumer('monolith', () => 0)],
    });

    await source.drain(test.context);
    expect(test.published).toHaveLength(0);

    await message(store, 'after');
    await source.drain(test.context);
    expect(test.published).toHaveLength(1);
    expect((test.published[0]!.event.data as { type: string }).type).toBe(
      'message'
    );
    // Only identity and classification cross the plane; content stays in the
    // store, which is what keeps an event far inside maxEventBytes.
    expect(test.published[0]!.event.data).not.toHaveProperty('content');
    expect(test.published[0]!.event.type).toBe(axMindEventTypes.step);
  });

  it('resumes from a persisted per-consumer cursor with no gap and no duplicate', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const controller = new AbortController();
    const first = harness(controller.signal);
    const options = {
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [consumer('monolith', () => 0)],
    };
    const source = new AxTrajectoryEventSource(options);
    await source.drain(first.context);
    await message(store, 'one');
    await message(store, 'two');
    await source.drain(first.context);
    expect(first.published).toHaveLength(2);

    // A fresh source, as after a restart: it resumes from the DURABLE cursor
    // the first one saved, so nothing is replayed and nothing is skipped.
    await message(store, 'three');
    const second = harness(controller.signal);
    const restarted = new AxTrajectoryEventSource(options);
    await restarted.drain(second.context);
    expect(second.published).toHaveLength(1);
    expect((second.published[0]!.event.data as { seq: number }).seq).toBe(
      (first.published[1]!.event.data as { seq: number }).seq + 1
    );
  });

  it('at the admission bound it holds the cursor and drops nothing', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const diagnostics: string[] = [];
    let acked = 0;
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [
        consumer('monolith', () => test.published.length - acked, {
          maxInFlight: 1,
        }),
      ],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    await source.drain(test.context);
    for (const body of ['one', 'two', 'three']) await message(store, body);

    // One at a time: each pass publishes one wake, then holds the cursor.
    await source.drain(test.context);
    expect(test.published).toHaveLength(1);
    expect(diagnostics).toContain('wake-deferred-backpressure');
    await source.drain(test.context);
    expect(test.published).toHaveLength(1);

    acked = 1;
    await source.drain(test.context);
    expect(test.published).toHaveLength(2);
    acked = 2;
    await source.drain(test.context);
    // Total deliveries equal total appends: deferral moves a wake in time, it
    // never removes one.
    expect(test.published).toHaveLength(3);
    expect(test.stepIds().map((one) => one.stepId)).toEqual([
      ...new Set(test.stepIds().map((one) => one.stepId)),
    ]);
  });

  it('handles AxEventBackpressureError as a deferral, not a loss', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const diagnostics: string[] = [];
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [consumer('monolith', () => 0)],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    await source.drain(test.context);
    const receipt = await message(store, 'must survive backpressure');
    test.failNext(1);
    await source.drain(test.context);
    expect(test.published).toHaveLength(0);
    expect(diagnostics).toContain('wake-deferred-backpressure');

    await source.drain(test.context);
    expect(test.published).toHaveLength(1);
    expect((test.published[0]!.event.data as { stepId: string }).stepId).toBe(
      receipt.stepId
    );
  });

  it('pauses one consumer on a cursor error and keeps the other running', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const controller = new AbortController();
    const test = harness(controller.signal);
    // A cursor past the end of the log: the store refuses it rather than
    // rounding it to a frame boundary, so the consumer stops loudly.
    await store.saveCursor('traj-source:broken', {
      trajectoryId: TRAJECTORY,
      seq: 9_999,
    });
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [consumer('broken', () => 0), consumer('healthy', () => 0)],
    });
    await source.drain(test.context);
    await message(store, 'still delivered to the healthy consumer');
    await source.drain(test.context);

    expect(test.errors).toHaveLength(1);
    expect((test.errors[0] as { code: string }).code).toBe(
      'trajectory_cursor_invalid'
    );
    const thinkers = test.published.map(
      (one) => (one.event.data as { thinker: string }).thinker
    );
    expect(thinkers).toEqual(['healthy']);
  });

  it('collapses a run of wake signals last-wins with a visible count', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const diagnostics: string[] = [];
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [
        consumer('cli', () => 0, { types: ['manual-trigger', 'message'] }),
      ],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    await source.drain(test.context);
    for (let index = 0; index < 5; index++) {
      await store.append({
        trajectoryId: TRAJECTORY,
        type: 'manual-trigger',
        data: { index },
      });
    }
    const last = await store.append({
      trajectoryId: TRAJECTORY,
      type: 'manual-trigger',
      data: { index: 5 },
    });
    await source.drain(test.context);

    expect(test.published).toHaveLength(1);
    const data = test.published[0]!.event.data as {
      stepId: string;
      coalesced: number;
    };
    // Queueing wake signals only builds a backlog of stale wakeups; collapsing
    // them is visible rather than a silent last-wins overwrite.
    expect(data.stepId).toBe(last.stepId);
    expect(data.coalesced).toBe(6);
    expect(diagnostics).toContain('wake-coalesced');
  });

  it('keeps payload steps whole while collapsing the signals around them', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      consumers: [
        consumer('cli', () => 0, { types: ['manual-trigger', 'message'] }),
      ],
    });
    await source.drain(test.context);
    await store.append({
      trajectoryId: TRAJECTORY,
      type: 'manual-trigger',
      data: {},
    });
    await message(store, 'one');
    await store.append({
      trajectoryId: TRAJECTORY,
      type: 'manual-trigger',
      data: {},
    });
    await message(store, 'two');
    await source.drain(test.context);
    expect(
      test.published.map((one) => (one.event.data as { type: string }).type)
    ).toEqual(['manual-trigger', 'message', 'manual-trigger', 'message']);
  });

  it('constructing starts no timers, and the loop leaks no abort listeners', async () => {
    const manual = new AxManualEventClock(1_000);
    const clock = new CountingClock(manual);
    const store = await seed(manual);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry,
      clock,
      pollIntervalMs: 50,
      consumers: [consumer('monolith', () => 0)],
    });
    // M16: ax starts no timers unless a source is started.
    expect(clock.sleeps).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    const handle = source.start(test.context);
    for (let cycle = 0; cycle < 25; cycle++) {
      manual.advanceBy(50);
      for (let index = 0; index < 5; index++) await Promise.resolve();
    }
    expect(clock.sleeps).toBeGreaterThan(0);
    // One listener for the lifetime link, and none accumulated per poll.
    expect(getEventListeners(controller.signal, 'abort').length).toBeLessThan(
      3
    );
    await handle.close();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('axMindTickDue', () => {
  it('is due exactly when the clock reaches the armed wake', () => {
    const armed = dutyState({ nextWakeAt: 5_000, watchdogMs: 0 });
    expect(axMindTickDue([armed], 4_999)).toEqual([]);
    expect(axMindTickDue([armed], 5_000)).toEqual([
      { thinker: 'monolith', kind: 'wake' },
    ]);
  });

  it('fires nothing when nothing armed it', () => {
    expect(axMindTickDue([dutyState({ lastActivityAt: 0 })], 1_000)).toEqual(
      []
    );
  });

  it('reports how many grid slots a late wake stands for', () => {
    const due = axMindTickDue(
      [dutyState({ nextWakeAt: 1_000, watchdogMs: 0 })],
      4_500,
      {
        intervalMs: 1_000,
      }
    );
    expect(due).toEqual([{ thinker: 'monolith', kind: 'wake', coalesced: 4 }]);
  });

  it('synthesizes idle only after a quiet-while-free window', () => {
    const quiet = dutyState({ lastActivityAt: 0, watchdogMs: 1_000 });
    expect(axMindTickDue([quiet], 999)).toEqual([]);
    expect(axMindTickDue([quiet], 1_000)).toEqual([
      { thinker: 'monolith', kind: 'idle' },
    ]);
  });

  it('busy or deferred work refreshes the watchdog window', () => {
    // A long agentic run holds the watchdog off deliberately, and must not end
    // in a spurious idle wake the moment it finishes.
    expect(
      axMindTickDue(
        [dutyState({ lastActivityAt: 0, watchdogMs: 1_000, running: 1 })],
        10_000
      )
    ).toEqual([]);
    expect(
      axMindTickDue(
        [dutyState({ lastActivityAt: 0, watchdogMs: 1_000, deferred: 2 })],
        10_000
      )
    ).toEqual([]);
    expect(
      axMindTickDue(
        [dutyState({ lastActivityAt: 9_500, watchdogMs: 1_000 })],
        10_000
      )
    ).toEqual([]);
  });

  it('a zero watchdog window disables the duty for that thinker', () => {
    expect(
      axMindTickDue([dutyState({ lastActivityAt: 0, watchdogMs: 0 })], 10_000)
    ).toEqual([]);
  });

  it('a scheduled wake outranks the watchdog for the same thinker', () => {
    const both = dutyState({
      nextWakeAt: 1_000,
      lastActivityAt: 0,
      watchdogMs: 500,
    });
    expect(axMindTickDue([both], 2_000)).toEqual([
      { thinker: 'monolith', kind: 'wake', coalesced: 2 },
    ]);
  });

  it('disabling pace leaves the watchdog working and vice versa', () => {
    const both = dutyState({
      nextWakeAt: 1_000,
      lastActivityAt: 0,
      watchdogMs: 500,
    });
    expect(axMindTickDue([both], 2_000, { pace: false })).toEqual([
      { thinker: 'monolith', kind: 'idle' },
    ]);
    expect(axMindTickDue([both], 2_000, { watchdog: false })).toEqual([
      { thinker: 'monolith', kind: 'wake', coalesced: 2 },
    ]);
    expect(
      axMindTickDue([both], 2_000, { pace: false, watchdog: false })
    ).toEqual([]);
  });
});

describe('AxMindTickEventSource', () => {
  it('publishes a wake when the manual clock reaches the armed time', async () => {
    const manual = new AxManualEventClock(0);
    const clock = new CountingClock(manual);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const states: AxMindTickDutyState[] = [
      dutyState({ nextWakeAt: 3_000, watchdogMs: 0 }),
    ];
    const source = new AxMindTickEventSource({
      id: 'mind-tick',
      clock,
      intervalMs: 1_000,
      due: () => axMindTickDue(states, clock.now(), { intervalMs: 1_000 }),
    });
    expect(clock.sleeps).toBe(0);

    const handle = source.start(test.context);
    for (let tick = 0; tick < 2; tick++) {
      manual.advanceBy(1_000);
      for (let index = 0; index < 5; index++) await Promise.resolve();
    }
    expect(test.published).toHaveLength(0);
    manual.advanceBy(1_000);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(test.published).toHaveLength(1);
    expect(test.published[0]!.event.type).toBe(axMindEventTypes.wake);
    expect(test.published[0]!.event.subject).toBe('mind:monolith');
    await handle.close();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('publishes idle for the watchdog duty and reports it', async () => {
    const manual = new AxManualEventClock(0);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const diagnostics: string[] = [];
    const source = new AxMindTickEventSource({
      id: 'mind-tick',
      clock: manual,
      intervalMs: 1_000,
      due: () =>
        axMindTickDue(
          [dutyState({ lastActivityAt: 0, watchdogMs: 1_000 })],
          manual.now()
        ),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    await source.tick(test.context);
    expect(test.published).toHaveLength(0);
    manual.advanceBy(1_500);
    await source.tick(test.context);
    expect(test.published).toHaveLength(1);
    expect(test.published[0]!.event.type).toBe(axMindEventTypes.idle);
    expect(diagnostics).toEqual(['watchdog-fired']);
  });

  it('a disabled duty publishes nothing even when it is due', async () => {
    const manual = new AxManualEventClock(0);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const source = new AxMindTickEventSource({
      id: 'mind-tick',
      clock: manual,
      watchdog: false,
      due: () => [
        { thinker: 'monolith', kind: 'idle' as const },
        { thinker: 'monolith', kind: 'wake' as const },
      ],
    });
    await source.tick(test.context);
    expect(test.published.map((one) => one.event.type)).toEqual([
      axMindEventTypes.wake,
    ]);
  });

  it('leaves no abort listeners after 25 cycles and after close', async () => {
    const manual = new AxManualEventClock(0);
    const controller = new AbortController();
    const test = harness(controller.signal);
    const source = new AxMindTickEventSource({
      id: 'mind-tick',
      clock: manual,
      intervalMs: 10,
      due: () => [],
    });
    const handle = source.start(test.context);
    for (let cycle = 0; cycle < 25; cycle++) {
      manual.advanceBy(10);
      for (let index = 0; index < 3; index++) await Promise.resolve();
    }
    expect(getEventListeners(controller.signal, 'abort').length).toBeLessThan(
      3
    );
    await handle.close();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
