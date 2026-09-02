import { describe, expect, it } from 'vitest';

import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import type { AxTrajectoryStore } from '../trajectory/types.js';
import {
  axMindPaceDelay,
  axMindPacerFuse,
  axMindPaceStepData,
  axMindPaceStepType,
  axMindVisibleStepTypes,
  axMindWakeOutcomeOf,
  axMindWorkProbe,
  axNextMindPace,
  axRecoverMindPacerState,
} from './pacer.js';
import {
  type AxMindPacerConfig,
  type AxMindPacerState,
  type AxMindWakeClass,
  type AxMindWakeOutcome,
  axDefaultMindPacerConfig,
  axInitialMindPacerState,
} from './types.js';

const HOUR = 3_600_000;
const TRAJECTORY = 'traj-pacer';

/** A fuse well above any descent, so a ladder test measures only the ladder. */
const LADDER: Readonly<AxMindPacerConfig> = Object.freeze({
  ...axDefaultMindPacerConfig,
  maxWakesPerHour: 10_000,
});

function step(
  state: Readonly<AxMindPacerState>,
  wakeClass: AxMindWakeClass,
  outcome: AxMindWakeOutcome,
  now: number,
  config: Readonly<AxMindPacerConfig> = LADDER
) {
  return axNextMindPace(state, { wakeClass, outcome, now }, config);
}

/** Drive the ladder from `state` until it reaches the cap; report the cost. */
function descend(
  outcome: AxMindWakeOutcome,
  config: Readonly<AxMindPacerConfig> = LADDER
) {
  let state = axInitialMindPacerState;
  let now = 0;
  let wakes = 0;
  const delays: number[] = [];
  while (wakes < 200) {
    const decision = step(state, 'spontaneous', outcome, now, config);
    wakes++;
    state = decision.state;
    if (decision.kind === 'unchanged') break;
    delays.push(decision.delayMs);
    if (decision.delayMs >= config.capMs) break;
    now += decision.delayMs;
  }
  return { state, now, wakes, delays };
}

async function seedTrajectory(): Promise<{
  store: AxTrajectoryStore;
  clock: AxManualEventClock;
}> {
  const clock = new AxManualEventClock(1_000);
  const store = new AxInMemoryTrajectoryStore({ clock });
  await store.create({ trajectoryId: TRAJECTORY });
  return { store, clock };
}

async function recordPace(
  store: AxTrajectoryStore,
  thinker: string,
  wakeClass: AxMindWakeClass,
  outcome: AxMindWakeOutcome,
  now: number,
  state: Readonly<AxMindPacerState>,
  config: Readonly<AxMindPacerConfig> = LADDER
): Promise<Readonly<AxMindPacerState>> {
  const decision = axNextMindPace(state, { wakeClass, outcome, now }, config);
  await store.append({
    trajectoryId: TRAJECTORY,
    type: axMindPaceStepType,
    ts: now,
    launchedBy: thinker,
    data: axMindPaceStepData({ wakeClass, outcome, decision }),
  });
  return decision.state;
}

describe('axNextMindPace', () => {
  it('engaged reactive wake resets level and ticks to zero', () => {
    const deep = { ...axInitialMindPacerState, level: 5, ticks: 2 };
    const decision = step(deep, 'reactive', 'empty', 10_000);
    expect(decision.kind).toBe('arm');
    expect(decision.state.level).toBe(0);
    expect(decision.state.ticks).toBe(0);
    expect(decision.kind === 'arm' && decision.delayMs).toBe(0);
    expect(decision.state.wakeAt).toBe(10_000);
    // Reactive wakes are not spontaneous spend and never enter the fuse window.
    expect(decision.state.spontaneousWakes).toEqual([]);
  });

  it('visible work on a spontaneous wake resets to zero', () => {
    const deep = { ...axInitialMindPacerState, level: 6, ticks: 1 };
    const decision = step(deep, 'spontaneous', 'visible', 20_000);
    expect(decision.kind).toBe('arm');
    expect(decision.kind === 'arm' && decision.delayMs).toBe(0);
    expect(decision.state.level).toBe(0);
    expect(decision.state.ticks).toBe(0);
    // The wake still happened, so the fuse window records it.
    expect(decision.state.spontaneousWakes).toEqual([20_000]);
  });

  it('thought-only descends the ladder but rests at the thought cap', () => {
    const run = descend('thought');
    expect(run.delays.every((delay) => delay <= LADDER.thoughtCapMs)).toBe(
      true
    );
    expect(run.delays.at(-1)).toBe(LADDER.thoughtCapMs);
    // The level keeps climbing past the point where delay(level) would exceed
    // the thought cap -- the ceiling is on the DELAY, not on the ladder.
    expect(run.state.level).toBeGreaterThanOrEqual(5);
    expect(axMindPaceDelay(run.state.level, LADDER)).toBeGreaterThan(
      LADDER.thoughtCapMs
    );
  });

  it('an empty wake dwells hold times before descending', () => {
    let state = axInitialMindPacerState;
    const seen: Array<{ level: number; ticks: number; delayMs: number }> = [];
    for (let index = 0; index < 4; index++) {
      const decision = step(state, 'spontaneous', 'empty', index);
      state = decision.state;
      seen.push({
        level: state.level,
        ticks: state.ticks,
        delayMs: decision.kind === 'arm' ? decision.delayMs : -1,
      });
    }
    // hold = 3: ticks 1, 2, then the third empty wake descends and resets.
    expect(seen.map((entry) => entry.ticks)).toEqual([1, 2, 0, 1]);
    expect(seen.map((entry) => entry.level)).toEqual([0, 0, 1, 1]);
    expect(seen.map((entry) => entry.delayMs)).toEqual([
      0,
      0,
      LADDER.baseMs,
      LADDER.baseMs,
    ]);
  });

  it('an errored run descends immediately with no dwell', () => {
    const first = step(axInitialMindPacerState, 'spontaneous', 'error', 0);
    expect(first.state.level).toBe(1);
    expect(first.state.ticks).toBe(0);
    expect(first.kind === 'arm' && first.delayMs).toBe(LADDER.baseMs);
    const second = step(first.state, 'spontaneous', 'error', 1);
    expect(second.state.level).toBe(2);
    expect(second.kind === 'arm' && second.delayMs).toBe(
      LADDER.baseMs * LADDER.factor
    );
    // An error storm reaches the cap strictly faster than an empty one.
    expect(descend('error').wakes).toBeLessThan(descend('empty').wakes);
  });

  it("a noop wake returns 'unchanged' and does not touch wakeAt", () => {
    const armed = step(
      axInitialMindPacerState,
      'spontaneous',
      'empty',
      0
    ).state;
    const decision = step(armed, 'reactive', 'noop', 999_999);
    expect(decision.kind).toBe('unchanged');
    // The running timer survives verbatim: re-arming here would silently reset
    // the backoff on every outgoing reply.
    expect(decision.state.wakeAt).toBe(armed.wakeAt);
    expect(decision.state.level).toBe(armed.level);
    expect(decision.state.ticks).toBe(armed.ticks);
  });

  it('steady-state spontaneous wakes per hour at cap 300s is 12', () => {
    // Measured on the SHIPPED default, not on a config with the fuse turned
    // off: a headline cost number the default cannot reach is a Goodhart
    // number. `parked` is asserted at every step for the same reason.
    const config = axDefaultMindPacerConfig;
    const atCap = { ...axInitialMindPacerState, level: 20, ticks: 0 };
    let state = atCap;
    let now = 0;
    let wakes = 0;
    while (now < HOUR) {
      const decision = step(state, 'spontaneous', 'empty', now, config);
      expect(decision.kind).toBe('arm');
      wakes++;
      state = decision.state;
      expect(state.parked).toBeUndefined();
      now += decision.kind === 'arm' ? decision.delayMs : HOUR;
    }
    expect(wakes).toBe(12);
    expect(axMindPaceDelay(state.level, config)).toBe(config.capMs);
  });

  it('a whole idle hour from engagement never trips the default fuse', () => {
    // Descent AND steady state together, from cold, on the shipped default.
    // The counter-metric beside the 12/hr headline: the hour that costs most
    // is the one that starts at full engagement, and it must stay under the
    // ceiling or the advertised steady state is unreachable.
    const config = axDefaultMindPacerConfig;
    let state = axInitialMindPacerState;
    let now = 0;
    let wakes = 0;
    while (now < HOUR) {
      const decision = step(state, 'spontaneous', 'empty', now, config);
      expect(decision.kind).toBe('arm');
      wakes++;
      state = decision.state;
      expect(state.parked).toBeUndefined();
      now += decision.kind === 'arm' ? decision.delayMs : HOUR;
    }
    expect(wakes).toBe(29);
    expect(wakes).toBeLessThan(axMindPacerFuse(config));
    expect(state.spontaneousWakes).toHaveLength(29);
  });

  it('raising the cap to 600s halves the wakes per hour', () => {
    const slower: AxMindPacerConfig = {
      ...axDefaultMindPacerConfig,
      capMs: 600_000,
    };
    let state = { ...axInitialMindPacerState, level: 20, ticks: 0 };
    let now = 0;
    let wakes = 0;
    while (now < HOUR) {
      const decision = step(state, 'spontaneous', 'empty', now, slower);
      wakes++;
      state = decision.state;
      now += decision.kind === 'arm' ? decision.delayMs : HOUR;
    }
    expect(wakes).toBe(6);
  });

  it('the default fuse covers a full descent and still bounds spend', () => {
    // 18 (steady-state tolerance) + 3 x 7 (hold wakes per ladder level). The
    // steady-state half alone parked the shipped default 7.75 minutes into
    // every quiet period, at level 5 -- nowhere near the 300s cap the cost
    // model is written about.
    expect(axMindPacerFuse(axDefaultMindPacerConfig)).toBe(39);
    const descent = descend('empty', axDefaultMindPacerConfig);
    expect(descent.state.parked).toBeUndefined();
    // It reaches the cap it was descending towards, which is the state the
    // documented 12/hr steady rate describes.
    expect(descent.delays.at(-1)).toBe(axDefaultMindPacerConfig.capMs);
    expect(descent.wakes).toBeLessThan(
      axMindPacerFuse(axDefaultMindPacerConfig)
    );
    // An explicitly stated ceiling is still absolute, and still parks.
    const tight = { ...axDefaultMindPacerConfig, maxWakesPerHour: 6 };
    expect(axMindPacerFuse(tight)).toBe(6);
    expect(descend('empty', tight).state.parked).toBe('rate_fuse');
    // A degenerate ladder (no descent possible) collapses to one level.
    expect(
      axMindPacerFuse({ ...axDefaultMindPacerConfig, baseMs: 300_000 })
    ).toBe(21);
  });

  it('the rate fuse parks spontaneity and leaves reactive wakes working', () => {
    const config: AxMindPacerConfig = { ...LADDER, maxWakesPerHour: 3 };
    let state = axInitialMindPacerState;
    // The wake being processed counts, so the third of a three-wake fuse is
    // the one that trips: two arm, the third parks.
    for (let index = 0; index < 2; index++) {
      const decision = step(state, 'spontaneous', 'empty', index, config);
      expect(decision.kind).toBe('arm');
      state = decision.state;
    }
    const tripped = step(state, 'spontaneous', 'empty', 2, config);
    expect(tripped.kind).toBe('unchanged');
    expect(tripped.state.parked).toBe('rate_fuse');
    // The drain time is published, so one re-evaluation can be armed instead
    // of none (parked forever) or one per tick (the fuse as an amplifier).
    expect(tripped.state.parkedUntil).toBe(HOUR);
    expect(tripped.state.wakeAt).toBe(state.wakeAt);

    // Reactive wakes keep being processed while parked: the pacer records the
    // wake, refuses only to ARM another spontaneous one, and never grows the
    // spontaneous window.
    const reactive = step(tripped.state, 'reactive', 'visible', 3, config);
    expect(reactive.kind).toBe('unchanged');
    expect(reactive.state.lastWakeClass).toBe('reactive');
    expect(reactive.state.lastOutcome).toBe('visible');
    expect(reactive.state.spontaneousWakes).toEqual([0, 1, 2]);

    // Once the hour window drains, spontaneity resumes without operator help.
    const later = step(
      reactive.state,
      'spontaneous',
      'empty',
      HOUR + 10,
      config
    );
    expect(later.kind).toBe('arm');
    expect(later.state.parked).toBeUndefined();
  });
});

describe('axRecoverMindPacerState', () => {
  it('reconstructs level and ticks from the log alone', async () => {
    const { store } = await seedTrajectory();
    let live = axInitialMindPacerState;
    let now = 10_000;
    const script: Array<[AxMindWakeClass, AxMindWakeOutcome]> = [
      ['reactive', 'visible'],
      ['spontaneous', 'empty'],
      ['spontaneous', 'empty'],
      ['spontaneous', 'empty'],
      ['spontaneous', 'thought'],
      ['spontaneous', 'error'],
    ];
    for (const [wakeClass, outcome] of script) {
      live = await recordPace(store, 'monolith', wakeClass, outcome, now, live);
      now += 30_000;
    }
    expect(live.level).toBeGreaterThan(0);

    const recovered = await axRecoverMindPacerState(
      store,
      TRAJECTORY,
      'monolith',
      LADDER
    );
    expect(recovered.level).toBe(live.level);
    expect(recovered.ticks).toBe(live.ticks);
    expect(recovered.wakeAt).toBe(live.wakeAt);
    expect(recovered.lastOutcome).toBe('error');
    expect(recovered.lastWakeClass).toBe('spontaneous');
    expect([...recovered.spontaneousWakes]).toEqual([...live.spontaneousWakes]);
  });

  it('ignores another thinker records and starts fresh with no history', async () => {
    const { store } = await seedTrajectory();
    let other = axInitialMindPacerState;
    for (let index = 0; index < 4; index++) {
      other = await recordPace(
        store,
        'responder',
        'spontaneous',
        'empty',
        1_000 + index,
        other
      );
    }
    expect(other.level).toBeGreaterThan(0);
    const mine = await axRecoverMindPacerState(store, TRAJECTORY, 'monolith');
    expect(mine).toEqual(axInitialMindPacerState);
  });

  it('a simulated crash loop does not restore full-speed waking', async () => {
    const config: AxMindPacerConfig = { ...LADDER, maxWakesPerHour: 4 };
    const { store } = await seedTrajectory();
    // Each "process" starts cold, recovers from the log, wakes once, and dies.
    for (let index = 0; index < 4; index++) {
      const recovered = await axRecoverMindPacerState(
        store,
        TRAJECTORY,
        'monolith',
        config
      );
      expect(recovered.parked).toBeUndefined();
      await recordPace(
        store,
        'monolith',
        'spontaneous',
        'empty',
        2_000 + index * 10,
        recovered,
        config
      );
    }
    const afterCrashLoop = await axRecoverMindPacerState(
      store,
      TRAJECTORY,
      'monolith',
      config
    );
    // The fifth process inherits the fuse from the autobiography, not a fresh
    // in-memory counter, so restarting is not a way to buy more wakes.
    expect(afterCrashLoop.parked).toBe('rate_fuse');
    // Recovery rebuilds the drain time too: a restart does not lose the one
    // fact that says when spontaneity may resume.
    expect(afterCrashLoop.parkedUntil).toBe(2_000 + HOUR);
    const next = axNextMindPace(
      afterCrashLoop,
      { wakeClass: 'spontaneous', outcome: 'empty', now: 2_100 },
      config
    );
    expect(next.kind).toBe('unchanged');
  });
});

describe('the work probe', () => {
  it('derives visible types from the registry, not from a hardcoded list', () => {
    const registry = axTrajectoryTypeRegistry();
    const visible = axMindVisibleStepTypes(registry);
    expect(visible).toContain('message');
    expect(visible).toContain('action');
    expect(visible).not.toContain('thought');
    expect(visible).not.toContain('idle');
    // A host that declares its own visible type is picked up with no code edit.
    const extended = axTrajectoryTypeRegistry([
      {
        type: 'shipped-artifact',
        stepClass: 'narrative',
        wakeable: true,
        carriesSource: true,
        visibleWork: true,
      },
    ]);
    expect(axMindVisibleStepTypes(extended)).toContain('shipped-artifact');
  });

  it('classifies visible, thought and empty runs from two bounded tails', async () => {
    const { store } = await seedTrajectory();
    const registry = axTrajectoryTypeRegistry();
    const before = await axMindWorkProbe(store, TRAJECTORY, registry);
    expect(before).toEqual({});

    await store.append({
      trajectoryId: TRAJECTORY,
      type: 'thought',
      source: 'monolith',
      data: { content: 'nothing changed' },
    });
    const thought = await axMindWorkProbe(store, TRAJECTORY, registry);
    expect(axMindWakeOutcomeOf({ before, after: thought })).toBe('thought');

    await store.append({
      trajectoryId: TRAJECTORY,
      type: 'action',
      source: 'monolith',
      data: { content: 'did the thing' },
    });
    const visible = await axMindWorkProbe(store, TRAJECTORY, registry);
    expect(axMindWakeOutcomeOf({ before: thought, after: visible })).toBe(
      'visible'
    );
    // Nothing appended between two probes is an empty wake, not work.
    expect(axMindWakeOutcomeOf({ before: visible, after: visible })).toBe(
      'empty'
    );
    // A throw outranks the probe: a crash never masquerades as calm resting.
    expect(
      axMindWakeOutcomeOf({
        before: visible,
        after: visible,
        error: new Error('boom'),
      })
    ).toBe('error');
  });
});
