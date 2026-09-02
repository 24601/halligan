import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AxEventBackpressureError,
  type AxEventIngress,
  type AxEventPublishReceipt,
  type AxEventSourceContext,
  AxManualEventClock,
} from '../event/types.js';
import { axEventMatches } from '../event/util.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import { axProjectTrajectory } from '../trajectory/projection.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import {
  AxInMemoryTrajectoryRollupStore,
  axBuildTrajectoryRollups,
  axDeterministicTrajectorySummarizer,
} from '../trajectory/rollups.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import { axResolveMindReplyState } from './chat.js';
import { axNextMindPace } from './pacer.js';
import {
  type AxMindTrajectoryConsumer,
  AxTrajectoryEventSource,
} from './sources.js';
import type {
  AxMindDiagnostic,
  AxMindPacerConfig,
  AxMindPacerState,
  AxMindSubscription,
  AxMindWakeClass,
  AxMindWakeOutcome,
} from './types.js';
import { axDefaultMindSubscription } from './types.js';

/**
 * The axmind fixtures are TypeScript-consumed in v1:
 * `conformanceSuitePaths` in tools/axir/internal/axir/verify.go is a hardcoded
 * directory list that does not include `axmind`, so the five generated targets
 * do not read them. THIS FILE is what actually runs them, so shipping them is
 * not a claim of coverage nobody exercises.
 */
const MIND_FIXTURES = fileURLToPath(
  new URL('../../../ir/conformance/axmind/', import.meta.url)
);
const EVENT_FIXTURES = fileURLToPath(
  new URL('../../../ir/conformance/axevent/', import.meta.url)
);

function fixture<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
}

describe('ir/conformance/axmind/pacing-ladder.json', () => {
  interface PacingFixture {
    readonly name: string;
    readonly defaultConfig: AxMindPacerConfig;
    readonly cases: readonly {
      readonly name: string;
      readonly config?: AxMindPacerConfig;
      readonly state: AxMindPacerState;
      readonly event: {
        readonly wakeClass: AxMindWakeClass;
        readonly outcome: AxMindWakeOutcome;
        readonly now: number;
      };
      readonly expected: {
        readonly kind: 'arm' | 'unchanged';
        readonly level: number;
        readonly ticks: number;
        readonly delayMs?: number;
        readonly wakeAt?: number;
        readonly parked?: string;
        readonly parkedUntil?: number;
        readonly spontaneousWakes?: number;
      };
    }[];
  }
  const loaded = fixture<PacingFixture>(MIND_FIXTURES, 'pacing-ladder.json');

  it('covers the dwell, the thought cap, the error descent, unchanged and the fuse', () => {
    expect(loaded.cases.length).toBeGreaterThanOrEqual(11);
    const names = loaded.cases.map((one) => one.name).join(' ');
    for (const required of [
      'dwells',
      'descends',
      'thought cap',
      'no dwell',
      'leaves the running timer alone',
      'rate fuse parks',
    ]) {
      expect(names).toContain(required);
    }
  });

  it.each(loaded.cases.map((one) => [one.name, one] as const))(
    '%s',
    (_name, one) => {
      const decision = axNextMindPace(
        one.state,
        one.event,
        one.config ?? loaded.defaultConfig
      );
      expect(decision.kind).toBe(one.expected.kind);
      expect(decision.state.level).toBe(one.expected.level);
      expect(decision.state.ticks).toBe(one.expected.ticks);
      if (one.expected.delayMs !== undefined) {
        expect(decision.kind === 'arm' ? decision.delayMs : undefined).toBe(
          one.expected.delayMs
        );
      }
      if (one.expected.wakeAt !== undefined) {
        expect(decision.state.wakeAt).toBe(one.expected.wakeAt);
      }
      expect(decision.state.parked).toBe(one.expected.parked);
      if (one.expected.parkedUntil !== undefined) {
        expect(decision.state.parkedUntil).toBe(one.expected.parkedUntil);
      }
      if (one.expected.spontaneousWakes !== undefined) {
        expect(decision.state.spontaneousWakes).toHaveLength(
          one.expected.spontaneousWakes
        );
      }
    }
  );
});

describe('ir/conformance/axmind/reply-resolution.json', () => {
  interface ReplyFixture {
    readonly base: {
      readonly triggerStepId: string;
      readonly triggerSeq: number;
      readonly triggerFrom: string;
      readonly selfName: string;
      readonly selfSources: readonly string[];
      readonly now: number;
      readonly claimTtlMs: number;
    };
    readonly cases: readonly {
      readonly row: number;
      readonly name: string;
      readonly steps: readonly Readonly<AxTrajectoryStep>[];
      readonly options?: Record<string, unknown> & {
        readonly nonFiniteClaim?: boolean;
      };
      readonly expected: {
        readonly state: string;
        readonly evidenceStepId?: string;
        readonly failedOpen: boolean;
      };
    }[];
  }
  const loaded = fixture<ReplyFixture>(MIND_FIXTURES, 'reply-resolution.json');

  it('covers all eight rows of the resolution table', () => {
    expect(new Set(loaded.cases.map((one) => one.row))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8])
    );
  });

  it.each(loaded.cases.map((one) => [one.name, one] as const))(
    '%s',
    (_name, one) => {
      const { nonFiniteClaim, ...options } = one.options ?? {};
      const steps = one.steps.map((step) =>
        nonFiniteClaim && step.type === 'reply-claim'
          ? // A claim whose time is unreadable, expressed as the shape a
            // tolerant parse would actually produce.
            ({ ...step, ts: Number.NaN, data: { ...step.data } } as const)
          : step
      );
      const resolution = axResolveMindReplyState(steps, {
        ...loaded.base,
        ...(options as Record<string, never>),
      });
      expect(resolution.state).toBe(one.expected.state);
      expect(resolution.failedOpen).toBe(one.expected.failedOpen);
      if (one.expected.evidenceStepId !== undefined) {
        expect(resolution.evidenceStepId).toBe(one.expected.evidenceStepId);
      }
    }
  );
});

describe('ir/conformance/axmind/projection-staircase.json', () => {
  interface StaircaseFixture {
    readonly cases: readonly {
      readonly name: string;
      readonly preEnable: number;
      readonly after: number;
      readonly fanout: number;
      readonly recentSteps: number;
      readonly sealRollups: boolean;
      readonly expected: {
        readonly life: readonly string[];
        readonly recentSteps: number;
        readonly coverage: {
          readonly fromIndex: number;
          readonly toIndex: number;
          readonly gaps: readonly { from: number; to: number }[];
        };
      };
    }[];
  }
  const loaded = fixture<StaircaseFixture>(
    MIND_FIXTURES,
    'projection-staircase.json'
  );

  it.each(loaded.cases.map((one) => [one.name, one] as const))(
    '%s',
    async (_name, one) => {
      const clock = new AxManualEventClock(1_000);
      const store = new AxInMemoryTrajectoryStore({ clock });
      await store.create({ trajectoryId: 'fixture' });
      const append = async (content: string) => {
        await store.append({
          trajectoryId: 'fixture',
          type: 'observation',
          source: 'host',
          data: { content },
        });
      };
      for (let index = 0; index < one.preEnable; index++) {
        await append(`pre ${index}`);
      }
      const rollups = new AxInMemoryTrajectoryRollupStore();
      const summarizer = axDeterministicTrajectorySummarizer();
      // Enablement is forward-only, so the marker is planted here.
      await axBuildTrajectoryRollups({
        trajectoryId: 'fixture',
        store,
        rollups,
        summarizer,
        fanout: one.fanout,
      });
      for (let index = 0; index < one.after; index++) {
        await append(`post ${index}`);
      }
      if (one.sealRollups) {
        await axBuildTrajectoryRollups({
          trajectoryId: 'fixture',
          store,
          rollups,
          summarizer,
          fanout: one.fanout,
          maxBlocks: 500,
        });
      }
      const projection = await axProjectTrajectory({
        trajectoryId: 'fixture',
        store,
        rollups,
        fanout: one.fanout,
        recentSteps: one.recentSteps,
        budgetTokens: 4_000,
      });
      const life = projection.life.map((section) =>
        section.kind === 'summary'
          ? `${section.block.tier}:${section.block.start}-${section.block.end}`
          : `gap:${section.start}-${section.end}:${section.reason}`
      );
      expect(life).toEqual(one.expected.life);
      expect(projection.recent).toHaveLength(one.expected.recentSteps);
      expect(projection.coverage).toEqual(one.expected.coverage);
    }
  );
});

describe('ir/conformance/axmind/dispatch-decisions.json', () => {
  interface DispatchFixture {
    readonly trajectoryId: string;
    readonly thinker: string;
    readonly cases: readonly {
      readonly row: number;
      readonly name: string;
      readonly append?: {
        readonly type: string;
        readonly source?: string;
        readonly launchedBy?: string;
        readonly trajectoryId?: string;
      };
      readonly appendMany?: {
        readonly type: string;
        readonly count: number;
        readonly source?: string;
      };
      readonly subscription: Partial<AxMindSubscription>;
      readonly inFlight?: number;
      readonly backpressure?: number;
      readonly expected: {
        readonly action: 'drop' | 'defer' | 'publish';
        readonly authorized?: boolean;
        readonly published?: number;
        readonly coalesced?: number;
        readonly diagnostic?: string;
        readonly deliveredOnNextPass?: boolean;
      };
    }[];
  }
  const loaded = fixture<DispatchFixture>(
    MIND_FIXTURES,
    'dispatch-decisions.json'
  );
  const registry = axTrajectoryTypeRegistry();

  it('covers every row of the decision table', () => {
    expect(new Set(loaded.cases.map((one) => one.row))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 10])
    );
  });

  it.each(
    loaded.cases.map((one) => [`row ${one.row}: ${one.name}`, one] as const)
  )('%s', async (_name, one) => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryTrajectoryStore({ clock });
    await store.create({ trajectoryId: loaded.trajectoryId });
    await store.create({ trajectoryId: 'another-life' });
    const published: AxEventIngress[] = [];
    const diagnostics: AxMindDiagnostic[] = [];
    let failures = one.backpressure ?? 0;
    const context: AxEventSourceContext = {
      signal: new AbortController().signal,
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
          deliveryIds: [`d-${published.length}`],
        } satisfies AxEventPublishReceipt;
      },
      reportError: () => undefined,
    };
    let inFlight = one.inFlight ?? 0;
    const consumer: AxMindTrajectoryConsumer = {
      thinker: loaded.thinker,
      subscription: { ...axDefaultMindSubscription, ...one.subscription },
      inFlight: () => inFlight,
    };
    const source = new AxTrajectoryEventSource({
      id: 'fixture-source',
      store,
      trajectoryId: loaded.trajectoryId,
      registry,
      clock,
      consumers: [consumer],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    // The cursor starts at the end, so only what this case appends is seen.
    await source.drain(context);
    const write = async (
      type: string,
      source_?: string,
      launchedBy?: string,
      trajectoryId?: string
    ) => {
      await store.append({
        trajectoryId: trajectoryId ?? loaded.trajectoryId,
        type,
        ...(source_ ? { source: source_ } : {}),
        ...(launchedBy ? { launchedBy } : {}),
        data: { content: 'x' },
      });
    };
    if (one.append) {
      await write(
        one.append.type,
        one.append.source,
        one.append.launchedBy,
        one.append.trajectoryId
      );
    }
    for (let index = 0; index < (one.appendMany?.count ?? 0); index++) {
      await write(one.appendMany!.type, one.appendMany?.source);
    }
    await source.drain(context);

    if (one.expected.action === 'drop') {
      expect(published).toHaveLength(0);
      return;
    }
    if (one.expected.action === 'defer') {
      expect(published).toHaveLength(0);
      expect(diagnostics.map((one_) => one_.code)).toContain(
        one.expected.diagnostic
      );
      // NOTHING IS DROPPED: clearing the block delivers the held step.
      inFlight = 0;
      failures = 0;
      await source.drain(context);
      expect(published.length).toBeGreaterThan(0);
      return;
    }
    expect(published.length).toBe(one.expected.published ?? 1);
    if (one.expected.coalesced !== undefined) {
      const data = published[0]!.event.data as { coalesced?: number };
      expect(data.coalesced).toBe(one.expected.coalesced);
    }
    // Row 4 and row 5 publish and then have the route's authorize predicate
    // refuse them; the delivery is what never gets created.
    if (one.expected.authorized !== undefined) {
      const { axMindWakeRoute } = await import('./routes.js');
      const route = axMindWakeRoute(
        {
          name: loaded.thinker,
          kind: 'monolith',
          subscription: { ...axDefaultMindSubscription, ...one.subscription },
          ai: {} as never,
          context: () => ({}),
        } as never,
        { id: loaded.thinker, ai: {} as never, mapInput: () => ({}) },
        { registry, sourceId: 'ax://mind/fixture', tickMs: 1_000 }
      );
      const authorize = route.authorize as (
        ingress: Readonly<AxEventIngress>
      ) => boolean;
      expect(authorize(published[0]!)).toBe(one.expected.authorized);
    }
  });
});

describe('ir/conformance/axevent/mind-wake-source-routing.json', () => {
  interface RoutingFixture {
    readonly event: AxEventIngress['event'];
    readonly identity_scope: string;
    readonly trust: 'untrusted' | 'authenticated' | 'trusted';
    readonly routes: readonly {
      readonly id: string;
      readonly action: string;
      readonly targetId?: string;
      readonly match: {
        readonly sources?: readonly string[];
        readonly types?: readonly string[];
      };
    }[];
    readonly expected: readonly {
      readonly routeId: string;
      readonly action: string;
      readonly targetId: string | null;
      readonly instanceKey: string;
      readonly idempotencyKey: string;
    }[];
  }
  const loaded = fixture<RoutingFixture>(
    EVENT_FIXTURES,
    'mind-wake-source-routing.json'
  );

  it('is portable: it uses only the sources and types the Core IR matcher has', () => {
    for (const route of loaded.routes) {
      expect(Object.keys(route.match).sort()).toEqual(
        expect.arrayContaining([])
      );
      for (const key of Object.keys(route.match)) {
        // `subjects` and `extensions` are TypeScript-only
        // (ir/axcore/event.axir event_route_commands matches sources+types).
        expect(['sources', 'types']).toContain(key);
      }
    }
  });

  it('selects exactly the expected routes through the shipped matcher', () => {
    const ingress: AxEventIngress = {
      event: loaded.event,
      trust: loaded.trust,
    };
    const commands = loaded.routes
      .filter((route) => axEventMatches(ingress, route.match))
      .map((route) => ({
        routeId: route.id,
        action: route.action,
        targetId: route.targetId ?? null,
        instanceKey: loaded.event.subject ?? loaded.identity_scope,
        idempotencyKey: `${route.id}:${loaded.event.id}`,
      }));
    expect(commands).toEqual(loaded.expected);
  });

  it('rejects a wrong producer identity and a wrong type, not just a wrong id', () => {
    const wrongSource: AxEventIngress = {
      event: { ...loaded.event, source: 'ax://mind/bob' },
      trust: loaded.trust,
    };
    const wrongType: AxEventIngress = {
      event: { ...loaded.event, type: 'ax.something.else' },
      trust: loaded.trust,
    };
    const signals = loaded.routes.find(
      (route) => route.id === 'mind.wake.monolith.signals'
    )!;
    expect(axEventMatches(wrongSource, signals.match)).toBe(false);
    expect(axEventMatches(wrongType, signals.match)).toBe(false);
    // An open list means "any", never "none": an implementation that reads an
    // absent list as a closed empty set matches nothing at all.
    const open = loaded.routes.find(
      (route) => route.id === 'any-source-observer'
    )!;
    expect(axEventMatches(wrongSource, open.match)).toBe(true);
  });
});
