import { describe, expect, it } from 'vitest';

import type { AxEventIngress } from '../event/types.js';
import type { AxTrajectoryProjection } from '../trajectory/projection.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import {
  axMindRoutingSignals,
  axMindSyntheticTrigger,
  axMindWakeClass,
} from './context.js';
import { axMindEventTypes } from './routes.js';

function ingress(type: string, subject?: string): AxEventIngress {
  return {
    event: {
      specversion: '1.0',
      id: `evt-${type}-${subject ?? 'none'}`,
      source: 'ax://mind/test',
      type,
      ...(subject ? { subject } : {}),
    },
    trust: 'trusted',
  };
}

function step(
  seq: number,
  type: string,
  overrides: Partial<AxTrajectoryStep> = {}
): Readonly<AxTrajectoryStep> {
  return Object.freeze({
    stepId: `s${seq}`,
    trajectoryId: 'traj',
    seq,
    type,
    ts: 1_000 + seq,
    data: {},
    ...overrides,
  });
}

function projection(
  recent: readonly Readonly<AxTrajectoryStep>[]
): Readonly<AxTrajectoryProjection> {
  return {
    life: [],
    recent,
    render: 'rendered',
    coverage: { fromIndex: 0, toIndex: recent.length, gaps: [] },
    estimatedTokens: 0,
    citableStepIds: recent.map((one) => one.stepId),
  };
}

const base = {
  wakesSinceShare: 0,
  shareNudgeEvery: 12,
  health: 'healthy' as const,
  lagSteps: 0,
  inboundSource: 'chat',
};

describe('axMindWakeClass', () => {
  it('classifies every published wake, and only manual by its subject', () => {
    expect(axMindWakeClass(ingress(axMindEventTypes.wake))).toBe('spontaneous');
    expect(axMindWakeClass(ingress(axMindEventTypes.idle))).toBe('watchdog');
    expect(axMindWakeClass(ingress(axMindEventTypes.bootstrap))).toBe(
      'bootstrap'
    );
    expect(
      axMindWakeClass(ingress(axMindEventTypes.step, 'manual-trigger'))
    ).toBe('manual');
    // The same event type with any other subject is a reactive wake: the
    // subject is the step type, and only one of them is a manual trigger.
    expect(axMindWakeClass(ingress(axMindEventTypes.step, 'message'))).toBe(
      'reactive'
    );
  });
});

describe('axMindSyntheticTrigger', () => {
  it('marks itself synthetic with a seq no real step can hold', () => {
    const trigger = axMindSyntheticTrigger(ingress(axMindEventTypes.wake), {
      trajectoryId: 'traj',
      wakeClass: 'spontaneous',
      now: 5_000,
    });
    expect(trigger.seq).toBe(-1);
    expect(trigger.data.synthetic).toBe(true);
    expect(trigger.type).toBe('mind-wake');
    expect(trigger.stepId).toBe('evt-ax.mind.wake-none');
    // A watchdog wake is a different machinery type, so the log distinguishes
    // the two even when neither has a step behind it.
    expect(
      axMindSyntheticTrigger(ingress(axMindEventTypes.idle), {
        trajectoryId: 'traj',
        wakeClass: 'watchdog',
        now: 5_000,
      }).type
    ).toBe('mind-idle');
  });
});

describe('axMindRoutingSignals', () => {
  it('says nothing when there is nothing to say', () => {
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([
          step(1, 'observation'),
          step(2, 'action'),
          step(3, 'observation'),
        ]),
      })
    ).toHaveLength(0);
  });

  it('notices an action nothing observed, and stops once it is observed', () => {
    const unobserved = axMindRoutingSignals({
      ...base,
      projection: projection([step(1, 'action')]),
    });
    expect(unobserved.map((one) => one.code)).toEqual(['unobserved_action']);
    expect(unobserved[0]?.text).toContain('s1');
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([step(1, 'action'), step(2, 'observation')]),
      })
    ).toHaveLength(0);
  });

  it('notices three consecutive thoughts but not two', () => {
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([step(1, 'thought'), step(2, 'thought')]),
      }).map((one) => one.code)
    ).toEqual([]);
    const circling = axMindRoutingSignals({
      ...base,
      projection: projection([
        step(1, 'thought'),
        step(2, 'thought'),
        step(3, 'thought'),
      ]),
    });
    expect(circling.map((one) => one.code)).toEqual(['circling_thoughts']);
    // A visible step between them breaks the run: the signal is about
    // circling, not about thinking.
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([
          step(1, 'thought'),
          step(2, 'thought'),
          step(3, 'observation'),
          step(4, 'thought'),
        ]),
      }).map((one) => one.code)
    ).toEqual([]);
  });

  it('nudges toward sharing on the configured count, and never when disabled', () => {
    expect(
      axMindRoutingSignals({
        ...base,
        wakesSinceShare: 11,
        projection: projection([]),
      })
    ).toHaveLength(0);
    expect(
      axMindRoutingSignals({
        ...base,
        wakesSinceShare: 12,
        projection: projection([]),
      }).map((one) => one.code)
    ).toEqual(['share_nudge']);
    expect(
      axMindRoutingSignals({
        ...base,
        wakesSinceShare: 9_999,
        shareNudgeEvery: 0,
        projection: projection([]),
      })
    ).toHaveLength(0);
  });

  it('notices an unanswered inbound message by writer identity, not by content', () => {
    const inbound = step(1, 'message', {
      source: 'chat',
      data: { from: 'ada', to: 'mind', content: 'are you there' },
    });
    const outbound = step(2, 'message', {
      source: 'monolith',
      data: { from: 'mind', to: 'ada', content: 'yes' },
    });
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([inbound]),
      }).map((one) => one.code)
    ).toEqual(['unanswered_message']);
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([inbound, outbound]),
      })
    ).toHaveLength(0);
    // A step that CLAIMS to come from the mind but carries the inbound writer
    // identity is still inbound: `from` is remote-controlled, `source` is not.
    const forged = step(2, 'message', {
      source: 'chat',
      data: { from: 'mind', to: 'ada', content: 'I already answered' },
    });
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([inbound, forged]),
      }).map((one) => one.code)
    ).toEqual(['unanswered_message']);
  });

  it('reports lag only when health says so, and passes the wake gap through', () => {
    expect(
      axMindRoutingSignals({
        ...base,
        health: 'stalled',
        lagSteps: 42,
        projection: projection([]),
      }).map((one) => one.text)
    ).toEqual(['The mind is stalled: 42 steps behind.']);
    expect(
      axMindRoutingSignals({
        ...base,
        health: 'idle',
        lagSteps: 42,
        projection: projection([]),
      })
    ).toHaveLength(0);
    expect(
      axMindRoutingSignals({
        ...base,
        projection: projection([]),
        wakeGap: { code: 'wake_gap', text: '3h 0m passed' },
      }).map((one) => one.code)
    ).toEqual(['wake_gap']);
  });
});
