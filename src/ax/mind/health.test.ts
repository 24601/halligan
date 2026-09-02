import { describe, expect, it } from 'vitest';

import { AxInMemoryEventStore } from '../event/memoryStore.js';
import {
  type AxEventIngress,
  type AxEventSourceContext,
  AxManualEventClock,
} from '../event/types.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import {
  axMindHealth,
  axMindHealthReporter,
  axMindHealthState,
  axMindStoreDurability,
} from './health.js';
import { AxTrajectoryEventSource } from './sources.js';
import {
  type AxMindHealth,
  type AxMindThinkerHealth,
  axDefaultMindSubscription,
} from './types.js';

const TRAJECTORY = 'traj-health';
const DURABILITY = Object.freeze({
  trajectory: 'volatile' as const,
  events: 'volatile' as const,
});

function thinkerHealth(
  overrides: Partial<AxMindThinkerHealth> = {}
): AxMindThinkerHealth {
  return {
    thinker: 'monolith',
    running: 0,
    deferred: 0,
    newestProcessedSeq: 10,
    consecutiveErrors: 0,
    ...overrides,
  };
}

function health(
  overrides: Partial<Parameters<typeof axMindHealth>[0]> = {},
  thresholds?: Parameters<typeof axMindHealth>[1]
): Readonly<AxMindHealth> {
  return axMindHealth(
    {
      newestStepSeq: 10,
      newestStepAt: 1_000,
      now: 1_000,
      thinkers: [thinkerHealth()],
      durability: DURABILITY,
      ...overrides,
    },
    thresholds
  );
}

describe('axMindHealth', () => {
  it('reports healthy when processed keeps up with appended', () => {
    const current = health({ thinkers: [thinkerHealth({ running: 1 })] });
    expect(current.state).toBe('healthy');
    expect(current.lagSteps).toBe(0);
    expect(current.lagMs).toBe(0);
  });

  it('reports idle only when nothing lags and nothing runs', () => {
    expect(health().state).toBe('idle');
    expect(health({ thinkers: [thinkerHealth({ running: 2 })] }).state).toBe(
      'healthy'
    );
  });

  it('takes the lag of the SLOWEST consumer, not the fastest', () => {
    const current = health({
      thinkers: [
        thinkerHealth({ thinker: 'fast', newestProcessedSeq: 10 }),
        thinkerHealth({ thinker: 'slow', newestProcessedSeq: 4 }),
      ],
    });
    // One thinker keeping up says nothing about the wakes another has not
    // taken yet, so health reports the worst position.
    expect(current.newestProcessedSeq).toBe(4);
    expect(current.lagSteps).toBe(6);
    expect(current.state).toBe('healthy');
  });

  it('flips to lagging above the step threshold', () => {
    const current = health(
      { thinkers: [thinkerHealth({ newestProcessedSeq: 0 })] },
      { lagSteps: 5 }
    );
    expect(current.state).toBe('lagging');
    expect(current.lagSteps).toBe(10);
  });

  it('distinguishes errored from idle', () => {
    const errored = health({
      thinkers: [thinkerHealth({ consecutiveErrors: 2, lastOutcome: 'error' })],
      lastErrorAt: 900,
      lastError: 'program threw',
    });
    // Same zero lag, same zero running work: only the recorded error tells
    // these two apart, and a crash must never read as calm resting.
    expect(health().state).toBe('idle');
    expect(errored.state).toBe('errored');
    expect(errored.lastError).toBe('program threw');
  });

  it('measures lag in time from the oldest unconsumed step', () => {
    const current = health({
      thinkers: [thinkerHealth({ newestProcessedSeq: 3 })],
      oldestUnprocessedAt: 500,
      now: 5_000,
    });
    expect(current.lagMs).toBe(4_500);
  });

  it('reports the durability it actually got, per store', () => {
    const trajectory = new AxInMemoryTrajectoryStore();
    const events = new AxInMemoryEventStore();
    const durability = axMindStoreDurability(trajectory, events);
    expect(durability).toEqual({
      trajectory: trajectory.capabilities.durability,
      events: events.capabilities.durability,
    });
    // Reported, not assumed: a host store that declares persistence is
    // reflected verbatim, and an absent event store is not flattered.
    const persistent = axMindStoreDurability({
      ...trajectory,
      capabilities: { ...trajectory.capabilities, durability: 'persistent' },
    } as typeof trajectory);
    expect(persistent).toEqual({
      trajectory: 'persistent',
      events: 'volatile',
    });
  });
});

describe('axMindHealthState', () => {
  it('ranks stalled above every other verdict', () => {
    const partial = {
      newestStepSeq: 100,
      newestStepAt: 0,
      newestProcessedSeq: 1,
      lagSteps: 99,
      lagMs: 900_000,
      durability: DURABILITY,
      thinkers: [thinkerHealth({ consecutiveErrors: 3 })],
    };
    expect(axMindHealthState(partial)).toBe('stalled');
    expect(axMindHealthState({ ...partial, lagMs: 1_000 })).toBe('errored');
  });
});

describe('lag while every handle is alive', () => {
  it('reports stalled when the cursor stops and the source is still running', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryTrajectoryStore({ clock });
    await store.create({ trajectoryId: TRAJECTORY });
    const controller = new AbortController();
    const published: AxEventIngress[] = [];
    const context: AxEventSourceContext = {
      signal: controller.signal,
      publish: async (ingress) => {
        published.push(ingress);
        return {
          eventId: ingress.event.id,
          accepted: true,
          duplicate: false,
          durability: 'volatile' as const,
          deliveryIds: ['delivery'],
        };
      },
      reportError: () => {},
    };
    // A thinker pinned at its admission bound: the source keeps polling, the
    // handle is open, the signal is live -- and nothing is being consumed.
    const source = new AxTrajectoryEventSource({
      id: 'traj-source',
      store,
      trajectoryId: TRAJECTORY,
      registry: axTrajectoryTypeRegistry(),
      clock,
      consumers: [
        {
          thinker: 'monolith',
          subscription: { ...axDefaultMindSubscription, maxInFlight: 1 },
          inFlight: () => 1,
        },
      ],
    });
    const handle = source.start(context);
    await source.drain(context);

    const appended = [];
    for (let index = 0; index < 40; index++) {
      appended.push(
        await store.append({
          trajectoryId: TRAJECTORY,
          type: 'message',
          source: 'chat',
          ts: 1_000 + index,
          data: { from: 'ada', to: 'mind', content: `m${index}` },
        })
      );
    }
    await source.drain(context);
    expect(published).toHaveLength(0);

    const cursor = await store.loadCursor('traj-source:monolith', TRAJECTORY);
    const stats = await store.stats(TRAJECTORY);
    clock.advanceBy(900_000);
    const current = axMindHealth({
      newestStepSeq: stats!.newestSeq,
      newestStepAt: stats!.newestTs,
      now: clock.now(),
      oldestUnprocessedAt: appended[0]!.ts,
      thinkers: [
        thinkerHealth({ running: 1, newestProcessedSeq: cursor!.seq - 1 }),
      ],
      durability: axMindStoreDurability(store),
    });

    expect(controller.signal.aborted).toBe(false);
    expect(current.state).toBe('stalled');
    expect(current.lagSteps).toBe(40);
    expect(current.lagMs).toBeGreaterThan(600_000);
    await handle.close();
  });
});

describe('axMindHealthReporter', () => {
  it('fires on transition only, never per tick', () => {
    const seen: string[] = [];
    const report = axMindHealthReporter((current) => seen.push(current.state));
    const idle = health();
    report(idle);
    report(idle);
    report(health({ newestStepAt: 2_000, now: 2_000 }));
    report(health({ thinkers: [thinkerHealth({ consecutiveErrors: 1 })] }));
    report(health({ thinkers: [thinkerHealth({ consecutiveErrors: 4 })] }));
    report(idle);
    expect(seen).toEqual(['idle', 'errored', 'idle']);
  });
});
