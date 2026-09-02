import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type AxEventIngress,
  type AxEventPublishReceipt,
  type AxEventSourceContext,
  AxManualEventClock,
  type AxMindPacerConfig,
  type AxMindPacerState,
  type AxMindTickDutyState,
  AxMindTickEventSource,
  type AxMindWakeClass,
  type AxMindWakeOutcome,
  AxTimerEventSource,
  axDefaultMindPacerConfig,
  axInitialMindPacerState,
  axMindPaceDelay,
  axMindPacerFuse,
  axMindTickDue,
  axNextMindPace,
} from '../src/ax/index.js';

/**
 * Repeated verbatim in the PR body, in docs/MIND.md, in the skill doc and in
 * this script's own output. Saying it once, in the artifact itself, is the
 * only version that survives being quoted out of context.
 */
export const AX_MIND_PACER_HONESTY =
  'This is a deterministic zero-cost mechanism evaluation with fault injection. It is bounded machinery evidence -- pacing, liveness, idempotency, projection shape and size, store conformance, and crash classification. It is not a held-out model comparison. It says nothing about whether the mind thinks well, chooses good routes, or writes useful memories, and no claim of that kind is made.';

export const AX_MIND_PACER_BASELINES =
  'AxTimerEventSource at intervalMs = capMs (the ax primitive a user would otherwise reach for), and in-step sleep at a 60s cap (60 wakes/hour).';

const HOUR_MS = 3_600_000;
const HORIZON_MS = 24 * HOUR_MS;
/** The tick grid AxMindTickEventSource actually runs on. */
const TICK_MS = 1_000;
const CAPS = [60_000, 300_000, 600_000] as const;
/** A hard stop, so a degenerate ladder fails loudly instead of hanging. */
const MAX_STEPS = 500_000;

export type AxMindPacerScenario =
  | 'idle'
  | 'thought-loop'
  | 'engaged'
  | 'error-storm'
  | 'rate-fuse';

export interface AxMindPacerRow {
  readonly scenario: AxMindPacerScenario;
  readonly capMs: number;
  readonly fuse: number;
  /**
   * THE headline: spontaneous wakes in the LAST hour of the simulated day,
   * with the ladder fully descended. This is the steady state the cost model
   * is written about.
   */
  readonly steadyWakesPerHour: number;
  /**
   * The counter-metric to the headline: the 24-hour average INCLUDING the
   * descent from cold. It is always the larger number, and quoting the steady
   * rate without it would understate what a real quiet period costs.
   */
  readonly spontaneousWakesPerHour: number;
  /**
   * Wakes after which the ladder sat at level 0, per hour. A mind that never
   * wakes scores perfectly on cost and has stopped existing; a mind that
   * resets constantly is engaged, not cheap. Neither number means anything
   * alone, which is why both are reported.
   */
  readonly resetsPerHour: number;
  readonly reactiveWakes: number;
  /** First moment the armed delay reached capMs. */
  readonly timeToCapMs: number | null;
  /** Delay armed by the wake that immediately followed engagement. */
  readonly engagementResetMs: number | null;
  /** Largest gap the scenario ever armed. */
  readonly maxIntervalMs: number;
  readonly parked: boolean;
  readonly parkedAtMs: number | null;
  readonly finalLevel: number;
  /** 24h / capMs: what AxTimerEventSource at intervalMs = capMs would cost. */
  readonly baselineTimerWakes: number;
  /** 24h at a 60s in-step sleep. */
  readonly baselineSleepWakes: number;
  readonly wakesSavedVsTimer: number;
  readonly wakesSavedVsSleep: number;
  /** Every armed delay recomputed from axMindPaceDelay; 0 means no drift. */
  readonly ladderDisagreements: number;
}

export interface AxMindPacerReport {
  readonly command: string;
  readonly honesty: string;
  readonly baseline: string;
  readonly budget: Readonly<{
    providerCalls: number;
    tokens: number;
    usd: number;
    horizonHours: number;
  }>;
  readonly rows: readonly AxMindPacerRow[];
  /** The real AxTimerEventSource baseline, published through a real source. */
  readonly measuredTimerBaseline: Readonly<{
    intervalMs: number;
    hours: number;
    published: number;
  }>;
  /** The real tick source, driven by the real duty query. */
  readonly measuredTickSource: Readonly<{
    capMs: number;
    hours: number;
    published: number;
    simulated: number;
  }>;
  /**
   * The timer baseline's engagement latency: a timer at intervalMs = capMs
   * cannot react sooner than its own interval, whatever arrives.
   */
  readonly timerEngagementLatencyMs: number;
  /** The shipped default with a thought loop: the fuse is the binding limit. */
  readonly thoughtLoopOnDefaults: Readonly<{
    parked: boolean;
    parkedAtMs: number | null;
    wakesBeforePark: number;
  }>;
}

function scenarioOutcome(scenario: AxMindPacerScenario): AxMindWakeOutcome {
  switch (scenario) {
    case 'thought-loop':
      return 'thought';
    case 'error-storm':
      return 'error';
    default:
      return 'empty';
  }
}

interface SimulationResult {
  readonly spontaneous: number;
  readonly spontaneousInLastHour: number;
  readonly reactive: number;
  readonly resets: number;
  readonly timeToCapMs: number | null;
  readonly engagementResetMs: number | null;
  readonly maxIntervalMs: number;
  readonly parked: boolean;
  readonly parkedAtMs: number | null;
  readonly state: Readonly<AxMindPacerState>;
  readonly ladderDisagreements: number;
}

/**
 * The ladder itself, driven by the SHIPPED `axNextMindPace` rather than by a
 * copy of the table. That is what stops this evidence rotting: a change to the
 * ladder moves these numbers instead of leaving them describing an
 * implementation that no longer exists.
 *
 * A wake armed with `delayMs: 0` fires on the NEXT grid slot, not at the same
 * instant, because that is what `AxMindTickEventSource` does with an injected
 * clock. Simulating an instantaneous re-fire would report a wake rate no real
 * mind can produce.
 */
function simulate(
  config: Readonly<AxMindPacerConfig>,
  scenario: AxMindPacerScenario,
  options: Readonly<{ horizonMs: number; reactiveEveryMs?: number }>
): SimulationResult {
  const outcome = scenarioOutcome(scenario);
  let state = axInitialMindPacerState;
  let now = 0;
  let spontaneous = 0;
  let spontaneousInLastHour = 0;
  let reactive = 0;
  let resets = 0;
  let timeToCapMs: number | null = null;
  let engagementResetMs: number | null = null;
  let maxIntervalMs = 0;
  let parkedAtMs: number | null = null;
  let ladderDisagreements = 0;
  let previousLevel = 0;
  let nextReactiveAt = options.reactiveEveryMs ?? Number.POSITIVE_INFINITY;
  let engagementJustHappened = false;

  const apply = (
    wakeClass: AxMindWakeClass,
    at: number
  ): number | undefined => {
    const decision = axNextMindPace(
      state,
      {
        wakeClass,
        outcome: wakeClass === 'reactive' ? 'visible' : outcome,
        now: at,
      },
      config
    );
    state = decision.state;
    if (state.parked === 'rate_fuse' && parkedAtMs === null) parkedAtMs = at;
    if (decision.kind !== 'arm') return undefined;
    // The armed delay must be the ladder's own function of the level it
    // reports, or one of the two has drifted from the other.
    const expected =
      outcome === 'thought' && wakeClass !== 'reactive'
        ? Math.min(axMindPaceDelay(state.level, config), config.thoughtCapMs)
        : axMindPaceDelay(state.level, config);
    if (wakeClass !== 'reactive' && decision.delayMs !== expected) {
      ladderDisagreements++;
    }
    if (
      state.level < previousLevel ||
      (state.level === 0 && previousLevel === 0 && wakeClass === 'reactive')
    ) {
      resets++;
    }
    previousLevel = state.level;
    maxIntervalMs = Math.max(maxIntervalMs, decision.delayMs);
    if (timeToCapMs === null && decision.delayMs >= config.capMs) {
      timeToCapMs = at;
    }
    if (engagementJustHappened && wakeClass !== 'reactive') {
      engagementResetMs = decision.delayMs;
      engagementJustHappened = false;
    }
    return at + decision.delayMs;
  };

  // Bootstrap goes through the ladder like every other wake (row 2 of §7.1).
  let wakeAt = apply('bootstrap', now);
  for (let iteration = 0; iteration < MAX_STEPS; iteration++) {
    const spontaneousAt =
      wakeAt === undefined || state.parked === 'rate_fuse'
        ? Number.POSITIVE_INFINITY
        : Math.max(wakeAt, now + TICK_MS);
    const at = Math.min(spontaneousAt, nextReactiveAt);
    if (!Number.isFinite(at) || at >= options.horizonMs) break;
    now = at;
    if (at === nextReactiveAt) {
      reactive++;
      resets++;
      engagementJustHappened = true;
      wakeAt = apply('reactive', now);
      nextReactiveAt = now + (options.reactiveEveryMs ?? HORIZON_MS);
      continue;
    }
    spontaneous++;
    if (now >= options.horizonMs - HOUR_MS) spontaneousInLastHour++;
    wakeAt = apply('spontaneous', now);
  }
  return {
    spontaneous,
    spontaneousInLastHour,
    reactive,
    resets,
    timeToCapMs,
    engagementResetMs,
    maxIntervalMs,
    parked: state.parked === 'rate_fuse',
    parkedAtMs,
    state,
    ladderDisagreements,
  };
}

function row(scenario: AxMindPacerScenario, capMs: number): AxMindPacerRow {
  const config: AxMindPacerConfig =
    scenario === 'rate-fuse'
      ? { ...axDefaultMindPacerConfig, capMs, maxWakesPerHour: 6 }
      : scenario === 'thought-loop'
        ? // The fuse is lifted here ON PURPOSE, so this row measures the
          // THOUGHT CAP. The shipped default is reported separately in
          // `thoughtLoopOnDefaults`, where the fuse is the binding limit.
          { ...axDefaultMindPacerConfig, capMs, maxWakesPerHour: 10_000 }
        : { ...axDefaultMindPacerConfig, capMs };
  const result = simulate(config, scenario, {
    horizonMs: HORIZON_MS,
    ...(scenario === 'engaged' ? { reactiveEveryMs: 5 * 60_000 } : {}),
  });
  const hours = HORIZON_MS / HOUR_MS;
  const baselineTimerWakes = Math.floor(HORIZON_MS / capMs);
  const baselineSleepWakes = Math.floor(HORIZON_MS / 60_000);
  return {
    scenario,
    capMs,
    fuse: axMindPacerFuse(config),
    steadyWakesPerHour: result.spontaneousInLastHour,
    spontaneousWakesPerHour: result.spontaneous / hours,
    resetsPerHour: result.resets / hours,
    reactiveWakes: result.reactive,
    timeToCapMs: result.timeToCapMs,
    engagementResetMs: result.engagementResetMs,
    maxIntervalMs: result.maxIntervalMs,
    parked: result.parked,
    parkedAtMs: result.parkedAtMs,
    finalLevel: result.state.level,
    baselineTimerWakes,
    baselineSleepWakes,
    wakesSavedVsTimer: baselineTimerWakes - result.spontaneous,
    wakesSavedVsSleep: baselineSleepWakes - result.spontaneous,
    ladderDisagreements: result.ladderDisagreements,
  };
}

function harness() {
  const published: AxEventIngress[] = [];
  const context: AxEventSourceContext = {
    signal: new AbortController().signal,
    publish: async (ingress) => {
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
  return { context, published };
}

/**
 * The declared baseline, MEASURED rather than asserted: a real
 * AxTimerEventSource on a manual clock, publishing through a real source
 * context for the same simulated day.
 */
async function measureTimerBaseline(
  intervalMs: number,
  hours: number
): Promise<number> {
  const clock = new AxManualEventClock(0);
  const { context, published } = harness();
  const source = new AxTimerEventSource({
    id: 'baseline-timer',
    intervalMs,
    type: 'ax.mind.wake',
    clock,
  });
  const handle = source.start(context);
  const ticks = Math.floor((hours * HOUR_MS) / intervalMs);
  for (let tick = 0; tick < ticks; tick++) {
    await new Promise((done) => setTimeout(done, 0));
    clock.advanceBy(intervalMs);
  }
  await new Promise((done) => setTimeout(done, 0));
  handle.close();
  return published.length;
}

/**
 * The mind's OWN tick source, driven by the real duty query over real pacer
 * state. If the simulation above and this disagree, the simulation is wrong.
 */
async function measureTickSource(
  capMs: number,
  hours: number
): Promise<Readonly<{ published: number; simulated: number }>> {
  const config: AxMindPacerConfig = { ...axDefaultMindPacerConfig, capMs };
  const clock = new AxManualEventClock(0);
  const { context, published } = harness();
  let state: Readonly<AxMindPacerState> = axInitialMindPacerState;
  let nextWakeAt: number | undefined;
  let dispatchedWakeAt: number | undefined;
  const bootstrap = axNextMindPace(
    state,
    { wakeClass: 'bootstrap', outcome: 'empty', now: 0 },
    config
  );
  state = bootstrap.state;
  if (bootstrap.kind === 'arm') nextWakeAt = bootstrap.state.wakeAt;
  const duty = (): readonly Readonly<AxMindTickDutyState>[] => [
    {
      thinker: 'monolith',
      ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
      ...(dispatchedWakeAt !== undefined ? { dispatchedWakeAt } : {}),
      ...(state.parked ? { parked: state.parked } : {}),
      lastActivityAt: clock.now(),
      running: 0,
      deferred: 0,
      watchdogMs: 0,
    },
  ];
  const source = new AxMindTickEventSource({
    id: 'mind-tick',
    clock,
    intervalMs: TICK_MS,
    watchdog: false,
    due: () => axMindTickDue(duty(), clock.now(), { intervalMs: TICK_MS }),
  });
  const before = published.length;
  const slots = Math.floor((hours * HOUR_MS) / TICK_MS);
  for (let slot = 0; slot < slots; slot++) {
    clock.advanceBy(TICK_MS);
    const wasPublished = published.length;
    await source.tick(context);
    if (published.length > wasPublished) {
      // The runtime stamps `dispatchedWakeAt` at DELIVERY, and then the step
      // settles into the next pace decision. Both are modelled here.
      dispatchedWakeAt = nextWakeAt;
      const decision = axNextMindPace(
        state,
        { wakeClass: 'spontaneous', outcome: 'empty', now: clock.now() },
        config
      );
      state = decision.state;
      if (decision.kind === 'arm') nextWakeAt = decision.state.wakeAt;
    }
  }
  const simulated = simulate(config, 'idle', { horizonMs: hours * HOUR_MS });
  return {
    published: published.length - before,
    simulated: simulated.spontaneous,
  };
}

export async function runMindPacerEvaluation(): Promise<
  Readonly<AxMindPacerReport>
> {
  const scenarios: readonly AxMindPacerScenario[] = [
    'idle',
    'thought-loop',
    'engaged',
    'error-storm',
    'rate-fuse',
  ];
  const rows: AxMindPacerRow[] = [];
  for (const scenario of scenarios) {
    for (const capMs of CAPS) rows.push(row(scenario, capMs));
  }
  const defaults = simulate(axDefaultMindPacerConfig, 'thought-loop', {
    horizonMs: HORIZON_MS,
  });
  return Object.freeze({
    command: 'npm run mind:pacer:eval',
    honesty: AX_MIND_PACER_HONESTY,
    baseline: AX_MIND_PACER_BASELINES,
    budget: { providerCalls: 0, tokens: 0, usd: 0, horizonHours: 24 },
    rows: Object.freeze(rows),
    measuredTimerBaseline: {
      intervalMs: 300_000,
      hours: 24,
      published: await measureTimerBaseline(300_000, 24),
    },
    measuredTickSource: {
      capMs: 300_000,
      hours: 2,
      ...(await measureTickSource(300_000, 2)),
    },
    timerEngagementLatencyMs: 300_000,
    thoughtLoopOnDefaults: {
      parked: defaults.parked,
      parkedAtMs: defaults.parkedAtMs,
      wakesBeforePark: defaults.spontaneous,
    },
  });
}

function fail(message: string): never {
  throw new Error(`mind pacing evaluation failed: ${message}`);
}

const pick = (
  report: Readonly<AxMindPacerReport>,
  scenario: AxMindPacerScenario,
  capMs: number
): AxMindPacerRow =>
  report.rows.find((one) => one.scenario === scenario && one.capMs === capMs) ??
  fail(`missing row ${scenario}@${capMs}`);

/**
 * The shipped gate. Every threshold is TWO-SIDED: a mind that never wakes
 * scores perfectly on cost and has stopped existing, so every ceiling here
 * carries a floor.
 */
export function assertMindPacerEvaluation(
  report: Readonly<AxMindPacerReport>
): void {
  if (report.budget.providerCalls !== 0 || report.budget.tokens !== 0) {
    fail('this evaluation must spend nothing');
  }
  const idle600 = pick(report, 'idle', 600_000);
  if (!(idle600.steadyWakesPerHour <= 6 && idle600.steadyWakesPerHour > 0)) {
    fail(
      `idle @600s is ${idle600.steadyWakesPerHour}/hr steady; the ceiling is 6.0 and the floor is above zero`
    );
  }
  const idle300 = pick(report, 'idle', 300_000);
  if (!(idle300.steadyWakesPerHour <= 12 && idle300.steadyWakesPerHour > 0)) {
    fail(
      `idle @300s is ${idle300.steadyWakesPerHour}/hr steady, outside (0, 12]`
    );
  }
  // The counter-metric is not allowed to hide: a day that starts cold costs
  // MORE than the steady rate, because the descent is real spend.
  for (const one of [idle300, idle600]) {
    if (one.spontaneousWakesPerHour < one.steadyWakesPerHour) {
      fail(
        `the 24h average at cap ${one.capMs} (${one.spontaneousWakesPerHour}/hr) is below the steady rate (${one.steadyWakesPerHour}/hr); the descent has gone missing`
      );
    }
  }
  // The knob is real: doubling the cap halves the idle rate.
  if (idle600.steadyWakesPerHour >= idle300.steadyWakesPerHour) {
    fail('raising the cap did not lower the idle wake rate');
  }
  for (const capMs of CAPS) {
    const thought = pick(report, 'thought-loop', capMs);
    if (thought.maxIntervalMs > axDefaultMindPacerConfig.thoughtCapMs) {
      fail(
        `a thought loop armed ${thought.maxIntervalMs}ms, over the ${axDefaultMindPacerConfig.thoughtCapMs}ms thought cap`
      );
    }
    const floor = (HOUR_MS / axDefaultMindPacerConfig.thoughtCapMs) * 0.9;
    if (thought.steadyWakesPerHour < floor) {
      fail(
        `a thought loop ran at ${thought.steadyWakesPerHour}/hr, under the ${floor}/hr floor: rumination must stay VISIBLE as well as cheap`
      );
    }
    const engaged = pick(report, 'engaged', capMs);
    if (engaged.engagementResetMs !== 0) {
      fail(
        `engagement armed ${engaged.engagementResetMs}ms instead of 0: a reactive wake must reset the ladder`
      );
    }
    if (engaged.resetsPerHour <= 0) fail('the engaged row recorded no resets');
    const storm = pick(report, 'error-storm', capMs);
    const idle = pick(report, 'idle', capMs);
    if (
      storm.timeToCapMs === null ||
      idle.timeToCapMs === null ||
      storm.timeToCapMs >= idle.timeToCapMs
    ) {
      fail(
        `an error storm reached the cap at ${storm.timeToCapMs} and idling at ${idle.timeToCapMs}; errors must descend strictly faster`
      );
    }
    const fuse = pick(report, 'rate-fuse', capMs);
    if (!fuse.parked) fail('the rate fuse never parked spontaneity');
    if (fuse.steadyWakesPerHour > fuse.fuse) {
      fail('the rate fuse allowed more wakes than its configured ceiling');
    }
    for (const one of [idle, thought, engaged, storm, fuse]) {
      if (one.ladderDisagreements !== 0) {
        fail(
          `${one.scenario}@${one.capMs} armed ${one.ladderDisagreements} delays axMindPaceDelay does not agree with`
        );
      }
    }
  }
  // The declared baselines, measured rather than asserted.
  if (report.measuredTimerBaseline.published !== 288) {
    fail(
      `AxTimerEventSource at 300s published ${report.measuredTimerBaseline.published} in 24h; 288 was expected`
    );
  }
  // WHERE IT DOES NOT HELP, asserted so the report cannot quietly claim a
  // saving it does not have: a permanently idle mind at cap = intervalMs
  // costs the same steady rate as the timer and MORE over the day, because
  // the descent from cold is real spend. The pacing buys engagement latency
  // and a spend ceiling, not a cheaper idle.
  for (const one of [idle300, idle600]) {
    if (one.wakesSavedVsTimer > 0) {
      fail(
        `the report claims ${one.wakesSavedVsTimer} wakes saved against a timer at intervalMs = capMs; a paced mind that starts cold cannot be cheaper than that timer, so this number is wrong`
      );
    }
  }
  // WHERE IT DOES HELP, first half: against the 60s in-step sleep the saving
  // is large and real.
  if (idle300.wakesSavedVsSleep <= 1_000) {
    fail(
      `only ${idle300.wakesSavedVsSleep} wakes saved against the 60s in-step sleep baseline; the whole point of a cap is that this number is large`
    );
  }
  // WHERE IT DOES HELP, second half: a timer cannot answer sooner than its
  // own interval, and cannot stop.
  if (report.timerEngagementLatencyMs !== 300_000) {
    fail('the timer baseline latency is not its own interval');
  }
  if (pick(report, 'engaged', 300_000).engagementResetMs !== 0) {
    fail('the paced mind did not answer engagement immediately');
  }
  // Real pipes: the shipped tick source and the simulation must agree.
  const tick = report.measuredTickSource;
  if (Math.abs(tick.published - tick.simulated) > 1) {
    fail(
      `AxMindTickEventSource published ${tick.published} wakes where the simulation says ${tick.simulated}`
    );
  }
  // And the honest counter-result: on the SHIPPED default the fuse, not the
  // thought cap, is what bounds a rumination loop.
  if (!report.thoughtLoopOnDefaults.parked) {
    fail(
      'a thought loop on the shipped default did not park; the fuse is not bounding spend'
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const report = await runMindPacerEvaluation();
  assertMindPacerEvaluation(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
