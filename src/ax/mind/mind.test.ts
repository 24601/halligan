import { describe, expect, it } from 'vitest';

import { AxAgentSessionHost } from '../agent/retainedSessions.js';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxAIService } from '../ai/types.js';
import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import { AxInMemoryEventStore } from '../event/memoryStore.js';
import { AxManualEventClock } from '../event/types.js';
import { axEventId } from '../event/util.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import type { AxTrajectoryRollupStore } from '../trajectory/rollups.js';
import {
  AxTrajectoryQueryError,
  AxTrajectoryRollupError,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
} from '../trajectory/types.js';
import { AxMind, type AxMindOptions, mind } from './mind.js';
import { axMindMonolith, axMindResponder } from './thinkers.js';
import {
  AxInMemoryMindOwnershipStore,
  type AxMindDiagnostic,
  type AxMindEffectLedger,
  type AxMindThinker,
  axDefaultMindSubscription,
  axIsMindBudgetExceededError,
  axIsMindChatError,
  axIsMindConfigurationError,
  axMindStaticArtifacts,
} from './types.js';

const TRAJECTORY = 'traj-mind';
const registry = axTrajectoryTypeRegistry();
const ai = {} as unknown as AxAIService;

/** Yields to the macrotask queue and advances event time in small steps. */
async function settle(
  clock: AxManualEventClock,
  stepMs = 5,
  rounds = 80
): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advanceBy(stepMs);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface ProbeProgram extends AxProgrammable<any, any> {
  readonly calls: Array<{
    values: any;
    routeId?: string;
    eventType?: string;
  }>;
}

/**
 * A model-free program. Every mind test runs the REAL dispatcher, the REAL
 * routes and the REAL sources; only the model is absent, so a call that
 * should never happen is a counter a test can read.
 */
function probeProgram(
  body?: (values: any, options: any) => unknown | Promise<unknown>
): ProbeProgram {
  const signature = new AxSignature('context:string -> reply?:string');
  const calls: ProbeProgram['calls'] = [];
  return {
    calls,
    getId: () => 'probe',
    setId: () => undefined,
    getSignature: () => signature,
    getTraces: () => [],
    setDemos: () => undefined,
    applyOptimization: () => undefined,
    getOptimizableComponents: () => [],
    applyOptimizedComponents: () => undefined,
    getUsage: () => [],
    getChatLog: () => [],
    resetUsage: () => undefined,
    forward: async (_ai: unknown, values: any, options: any) => {
      calls.push({
        values,
        routeId: options?.eventContext?.routeId,
        eventType: options?.eventContext?.ingress?.event?.type,
      });
      return (await body?.(values, options)) ?? { reply: 'ok' };
    },
    streamingForward: async function* () {}.bind(
      null
    ) as unknown as AxProgrammable<any, any>['streamingForward'],
  } as unknown as ProbeProgram;
}

function thinkerWith(
  name: string,
  program: AxProgrammable<any, any>,
  overrides: Partial<AxMindThinker<any, any>> = {}
): AxMindThinker<any, any> {
  return {
    name,
    kind: 'monolith',
    subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
    ai,
    program,
    context: (request) => ({ context: request.projection.render }),
    ...overrides,
  } as AxMindThinker<any, any>;
}

async function seed(clock: AxManualEventClock): Promise<AxTrajectoryStore> {
  const store = new AxInMemoryTrajectoryStore({ clock });
  await store.create({ trajectoryId: TRAJECTORY });
  return store;
}

function baseOptions(
  store: AxTrajectoryStore,
  thinkers: readonly AxMindThinker<any, any>[],
  overrides: Partial<AxMindOptions> = {}
): AxMindOptions {
  return {
    id: 'mind-under-test',
    trajectoryId: TRAJECTORY,
    store,
    registry,
    artifacts: axMindStaticArtifacts({
      revision: 'rev-1',
      persona: 'a careful mind',
      thinkerPrompts: {},
      goals: [],
      skills: [],
    }),
    thinkers,
    budget: { contextWindowTokens: 8_000 },
    allowVolatileTrajectory: true,
    tickMs: 5,
    sourcePollMs: 5,
    ...overrides,
  };
}

async function typesIn(
  store: AxTrajectoryStore
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const tail = await store.tailBackward({
    trajectoryId: TRAJECTORY,
    limit: 500,
    maxScan: 5_000,
  });
  return tail.steps;
}

describe('AxMind configuration', () => {
  it('refuses duplicate thinkers, two pacers, a reserved name, and a mismatched clock', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const one = thinkerWith('monolith', probeProgram());

    const duplicate = () =>
      mind(baseOptions(store, [one, thinkerWith('monolith', probeProgram())]));
    expect(duplicate).toThrow(/two thinkers named monolith/);
    try {
      duplicate();
    } catch (error) {
      expect(axIsMindConfigurationError(error)).toBe(true);
      expect((error as { reason: string }).reason).toBe('duplicate_thinker');
    }

    const paced = { baseMs: 1, factor: 2, capMs: 10, hold: 1, thoughtCapMs: 5 };
    expect(() =>
      mind(
        baseOptions(store, [
          thinkerWith('a', probeProgram(), { pacer: paced }),
          thinkerWith('b', probeProgram(), { pacer: paced }),
        ])
      )
    ).toThrow(/scheduled spontaneity has exactly one owner/);

    expect(() =>
      mind(baseOptions(store, [thinkerWith('recall', probeProgram())]))
    ).toThrow(/the agent runtime already owns/);

    expect(() =>
      mind(baseOptions(store, [one], { clock: new AxManualEventClock(1_000) }))
    ).toThrow(/must share one AxEventClock instance/);

    // A negative that matters: the valid configuration constructs, so the
    // four refusals above are about the defect and not about the harness.
    expect(mind(baseOptions(store, [one]))).toBeInstanceOf(AxMind);
  });

  it('starts no timers, no sources and no loop until start()', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    let sleeps = 0;
    const counting = new Proxy(clock, {
      get(target, key, receiver) {
        if (key === 'sleep') {
          return (ms: number, signal?: AbortSignal) => {
            sleeps++;
            return target.sleep(ms, signal);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const store2 = new AxInMemoryTrajectoryStore({ clock: counting });
    await store2.create({ trajectoryId: TRAJECTORY });
    const program = probeProgram();
    const instance = mind(
      baseOptions(store2, [thinkerWith('monolith', program)], {
        clock: counting,
      })
    );
    await settle(clock, 0, 3);
    expect(sleeps).toBe(0);
    expect(program.calls).toHaveLength(0);
    // The route table and the source list exist before start; they are
    // inspectable configuration, not running machinery.
    expect(instance.routes().length).toBeGreaterThan(0);
    expect(instance.sources()).toHaveLength(3);
    void store;
  });
});

describe('AxMind start', () => {
  it('refuses a volatile TRAJECTORY store, and names that store', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const refused = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        allowVolatileTrajectory: false,
      })
    );
    await expect(refused.start()).rejects.toThrow(
      /volatile TRAJECTORY store \(traj-mind\)/
    );
    // The escape hatch is real, so the refusal is a policy and not a bug.
    const allowed = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())])
    );
    await allowed.start();
    await allowed.close({ drain: false, timeoutMs: 200 });
  });

  it('refuses a store that cannot promise atomic appends', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const torn = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'capabilities') {
          return { ...target.capabilities, appendAtomicity: false };
        }
        return Reflect.get(target, key, receiver);
      },
    }) as AxTrajectoryStore;
    const instance = mind(
      baseOptions(torn, [thinkerWith('monolith', probeProgram())])
    );
    await expect(instance.start()).rejects.toThrow(/append atomicity/);
  });

  it('refuses a trajectory the store has never heard of', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryTrajectoryStore({ clock });
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())])
    );
    await expect(instance.start()).rejects.toThrow(/no such trajectory/);
  });

  it('tells itself about its own downtime, in band', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    clock.advanceBy(7_500_000); // just over two hours
    const diagnostics: AxMindDiagnostic[] = [];
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        wakeGapMinMs: 300_000,
        onDiagnostic: (one) => diagnostics.push(one),
      })
    );
    await instance.start();
    const steps = await typesIn(store);
    const note = steps.find(
      (step) => step.type === 'observation' && step.source === 'system'
    );
    expect(note?.data.content).toMatch(/2h 5m passed since the previous step/);
    expect(diagnostics.map((one) => one.code)).toContain('wake-gap-noted');
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('appends no downtime note when the log is fresh', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    clock.advanceBy(1_000);
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())])
    );
    await instance.start();
    const steps = await typesIn(store);
    expect(
      steps.filter(
        (step) => step.type === 'observation' && step.source === 'system'
      )
    ).toHaveLength(0);
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('bootstraps through the dispatcher, not a direct call', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', program)])
    );
    await instance.start();
    await settle(clock);
    const first = program.calls[0];
    expect(first?.eventType).toBe('ax.mind.bootstrap');
    // The route id is the mind's own table entry, so the step really went
    // through routeMatches, authorize, the claim and the delivery record.
    expect(first?.routeId).toBe('mind-under-test.wake.monolith.signals');
    expect(instance.routes().map((route) => route.id)).toContain(
      first?.routeId
    );
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('fails loudly when a second owner takes the same trajectory', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const ownership = new AxInMemoryMindOwnershipStore();
    const first = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        ownership,
      })
    );
    await first.start();
    const second = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        ownership,
      })
    );
    await expect(second.start()).rejects.toThrow(/already owned by/);
    // Releasing the lease makes the takeover legal, so the refusal above is
    // about ownership and not about the store being unusable twice.
    await first.close({ drain: false, timeoutMs: 200 });
    const third = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        ownership,
      })
    );
    await third.start();
    await third.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind liveness and budgets', () => {
  it('recovers a broken trigger chain within one watchdog window', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          subscription: { ...axDefaultMindSubscription, watchdogMs: 100 },
        }),
      ])
    );
    await instance.start();
    // Under the watchdog window: only the bootstrap wake has landed.
    await settle(clock, 4, 12);
    const afterBootstrap = program.calls.length;
    expect(afterBootstrap).toBe(1);
    // Nothing publishes another wake: no append, no pacer (this thinker
    // declares none), no manual trigger. Only the watchdog can revive it.
    await settle(clock, 20, 40);
    const revived = program.calls.slice(afterBootstrap);
    expect(revived.length).toBeGreaterThan(0);
    expect(revived[0]?.eventType).toBe('ax.mind.idle');
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('is dead without the watchdog, which is what makes the recovery real', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
        }),
      ])
    );
    await instance.start();
    await settle(clock, 20, 80);
    expect(program.calls).toHaveLength(1);
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('aborts a step over maxWallClockMs, appends error, and descends', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    let aborted = 0;
    const program = probeProgram(
      (_values, options) =>
        new Promise((_resolve, reject) => {
          const signal: AbortSignal = options.abortSignal;
          signal.addEventListener('abort', () => {
            aborted++;
            reject(signal.reason ?? new Error('aborted'));
          });
        })
    );
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          budget: {
            maxWallClockMs: 50,
            maxTokens: 1_000,
            maxSubRuns: 2,
            maxDepth: 1,
          },
          pacer: {
            baseMs: 40,
            factor: 2,
            capMs: 160,
            hold: 3,
            thoughtCapMs: 80,
          },
        }),
      ])
    );
    await instance.start();
    await settle(clock, 10, 80);
    expect(aborted).toBeGreaterThan(0);
    const steps = await typesIn(store);
    const errors = steps.filter((step) => step.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.data.reason).toBe('run-failed');
    expect(String(errors[0]?.data.content)).toMatch(/wallClock/);
    // M9: an errored run descends immediately, with no dwell. A crash must
    // never read as calm resting.
    const pacer = instance.getPacerState('monolith');
    expect(pacer?.level).toBeGreaterThanOrEqual(1);
    expect(pacer?.lastOutcome).toBe('error');
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('dead-letters a throwing context assembler before any model call', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const diagnostics: AxMindDiagnostic[] = [];
    const instance = mind(
      baseOptions(
        store,
        [
          thinkerWith('monolith', program, {
            context: () => {
              throw new Error('the projection is unreadable');
            },
          }),
        ],
        { onDiagnostic: (one) => diagnostics.push(one) }
      )
    );
    await instance.start();
    await settle(clock);
    // The whole claim in one number: zero model calls.
    expect(program.calls).toHaveLength(0);
    expect(
      diagnostics.filter((one) => one.code === 'context-assembly-failed').length
    ).toBeGreaterThan(0);
    // And the mind is still alive: it answers, and its route table stands.
    expect(instance.health().state).toBeDefined();
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('refuses close() from inside a thinker tool call and records why', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    let refusal: unknown;
    // The thinker reaches the mind exactly the way a real tool does: every
    // handler axMindTools builds runs through runThinkerTool, which is the
    // boundary close_from_inside is decided on.
    const host: { mind?: AxMind } = {};
    const program = probeProgram(async () => {
      await host.mind?.runThinkerTool(async () => {
        try {
          await host.mind?.close();
        } catch (error) {
          refusal = error;
        }
      });
      return { reply: 'still here' };
    });
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', program)])
    );
    host.mind = instance;
    await instance.start();
    await settle(clock);
    expect((refusal as { reason?: string })?.reason).toBe('close_from_inside');
    expect(String(refusal)).toMatch(/does not restart itself/);
    const steps = await typesIn(store);
    expect(
      steps.some(
        (step) =>
          step.type === 'mind-error' &&
          step.data.refused === 'close_from_inside'
      )
    ).toBe(true);
    // The mind survived its own refusal: the host can still close it.
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('lets the host close a PACED mind, which is never idle by construction', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
          pacer: {
            baseMs: 20,
            factor: 2,
            capMs: 40,
            hold: 3,
            thoughtCapMs: 40,
          },
        }),
      ])
    );
    await instance.start();
    await settle(clock, 5, 40);
    // It is genuinely still waking: a paced mind never goes idle, so
    // `waitForIdle` cannot be its shutdown path, and a close that refused
    // while a step ran would leave a persistent mind unclosable.
    const before = program.calls.length;
    expect(before).toBeGreaterThan(2);
    expect(instance.getPacerState('monolith')?.wakeAt).toBeDefined();
    await instance.close({ drain: true, timeoutMs: 500 });
    await settle(clock, 20, 20);
    expect(program.calls.length).toBeLessThanOrEqual(before + 2);
  });

  it('exposes no way to modify, delete, rewrite or compact a step', async () => {
    const surface = Object.getOwnPropertyNames(AxMind.prototype);
    for (const forbidden of [
      'update',
      'updateStep',
      'delete',
      'deleteStep',
      'rewrite',
      'compact',
      'truncate',
      'prune',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
    // The one write verb it does have, so the negative above is a policy and
    // not an empty prototype.
    expect(surface).toContain('append');
  });
});

/** The smallest agent the retained-session host will run. No model, no I/O. */
class EchoRetainedAgent {
  async forward(_ai: unknown, values: { value: string }) {
    return { echoed: values.value };
  }
  getState() {
    return undefined;
  }
  setState() {
    return undefined;
  }
  getUsage() {
    return [] as never;
  }
  resetUsage() {
    return undefined;
  }
  stop() {
    return undefined;
  }
}

describe('AxMind sub-runs', () => {
  it('forks, runs under the tree budget, and always merges back', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const sessions = new AxAgentSessionHost({
      registrations: [
        {
          key: 'echo',
          create: () => new EchoRetainedAgent() as never,
        },
      ],
      ai,
    });
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        sessions,
        subRunPollMs: 0,
      })
    );
    await instance.start();
    const result = await instance.subRun<{ echoed: string }>({
      registrationKey: 'echo',
      input: { value: 'hello' },
      slug: 'echo-run',
      summarize: (output) => `echoed ${output.echoed}`,
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.output?.echoed).toBe('hello');
    const steps = await typesIn(store);
    const merge = steps.find((step) => step.stepId === result.mergeStepId);
    expect(merge?.type).toBe('merge');
    expect(merge?.data.content).toBe('echoed hello');
    expect(merge?.data.outcome).toBe('succeeded');
    await sessions.close({ abort: true });
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('merges a failure back too, so a sub-run is never invisible', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const sessions = new AxAgentSessionHost({
      registrations: [
        {
          key: 'boom',
          create: () =>
            ({
              forward: async () => {
                throw new Error('the child gave up');
              },
              getState: () => undefined,
              setState: () => undefined,
              getUsage: () => [],
              resetUsage: () => undefined,
              stop: () => undefined,
            }) as never,
        },
      ],
      ai,
    });
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        sessions,
        subRunPollMs: 0,
      })
    );
    await instance.start();
    const result = await instance.subRun({
      registrationKey: 'boom',
      input: { value: 'x' },
    });
    expect(result.outcome).toBe('failed');
    const steps = await typesIn(store);
    const merge = steps.find((step) => step.stepId === result.mergeStepId);
    expect(merge?.type).toBe('merge');
    expect(String(merge?.data.content)).toMatch(/failed: .*gave up/);
    await sessions.close({ abort: true });
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('caps sub-runs by depth and by spend', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const shallow = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        defaultThinkerBudget: {
          maxWallClockMs: 1_000,
          maxTokens: 100,
          maxSubRuns: 4,
          maxDepth: 0,
        },
      })
    );
    await shallow.start();
    const depthError = await shallow
      .subRun({ registrationKey: 'echo', input: {} })
      .catch((error) => error);
    expect(axIsMindBudgetExceededError(depthError)).toBe(true);
    expect((depthError as { dimension: string }).dimension).toBe('depth');
    await shallow.close({ drain: false, timeoutMs: 200 });

    const clock2 = new AxManualEventClock(1_000);
    const store2 = new AxInMemoryTrajectoryStore({ clock: clock2 });
    await store2.create({ trajectoryId: TRAJECTORY });
    const spend: unknown[] = [];
    const host: { mind?: AxMind } = {};
    const program = probeProgram(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        spend.push(
          await host.mind
            ?.subRun({ registrationKey: 'missing', input: {} })
            .catch((error) => error)
        );
      }
      return { reply: 'done' };
    });
    const spender = mind(
      baseOptions(store2, [
        thinkerWith('monolith', program, {
          budget: {
            maxWallClockMs: 5_000,
            maxTokens: 100,
            maxSubRuns: 2,
            maxDepth: 2,
          },
        }),
      ])
    );
    host.mind = spender;
    await spender.start();
    await settle(clock2);
    // Two forks are admitted; the third is refused by the spend cap, not by
    // the missing runner (the first two merged a failure back and returned).
    expect((spend[0] as { outcome?: string })?.outcome ?? 'threw').toBe(
      'failed'
    );
    expect(axIsMindBudgetExceededError(spend[2])).toBe(true);
    expect((spend[2] as { dimension: string }).dimension).toBe('subRuns');
    await spender.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind health and shutdown', () => {
  it('reports stalled from LAG while every source handle is alive', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const program = probeProgram(async () => {
      await blocked;
      return { reply: 'finally' };
    });
    const instance = mind(
      baseOptions(
        store,
        [
          thinkerWith('monolith', program, {
            subscription: {
              ...axDefaultMindSubscription,
              watchdogMs: 0,
              maxInFlight: 1,
            },
          }),
        ],
        { health: { lagSteps: 2, stalledMs: 500 } }
      )
    );
    await instance.start();
    await settle(clock, 2, 10);
    for (let index = 0; index < 12; index++) {
      await instance.append({
        trajectoryId: TRAJECTORY,
        type: 'observation',
        source: 'host',
        data: { content: `note ${index}` },
      });
    }
    await settle(clock, 2, 20);
    const lagging = instance.health();
    expect(lagging.lagSteps).toBeGreaterThan(2);
    // Every handle is alive: the tick source is still publishing and the
    // trajectory source is still draining. Health is LAG, not liveness.
    clock.advanceBy(2_000);
    expect(instance.health().state).toBe('stalled');
    release?.();
    await settle(clock, 5, 60);
    // Nothing was dropped: the deferred steps are delivered once the
    // admission bound clears, so the backlog really was the log.
    expect(program.calls.length).toBeGreaterThan(1);
    expect(instance.health().state).not.toBe('stalled');
    await instance.close({ drain: false, timeoutMs: 500 });
  });

  it('reports the durability it actually got, per store', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())])
    );
    await instance.start();
    expect(instance.health().durability.trajectory).toBe('volatile');
    expect(instance.health().durability.events).toBe('volatile');
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('stops every loop on close and stays stopped', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          subscription: { ...axDefaultMindSubscription, watchdogMs: 50 },
        }),
      ])
    );
    await instance.start();
    await settle(clock, 10, 30);
    const before = program.calls.length;
    expect(before).toBeGreaterThan(1); // the watchdog was running
    await instance.close({ drain: true, timeoutMs: 500 });
    const stepsBefore = (await typesIn(store)).length;
    await settle(clock, 50, 40);
    expect(program.calls.length).toBe(before);
    expect((await typesIn(store)).length).toBe(stepsBefore);
    // Closing twice is a no-op, not a second teardown.
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('hands a thinker no transport identity and no route table', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const seen: Record<string, unknown>[] = [];
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', probeProgram(), {
          context: (request) => {
            seen.push(request as unknown as Record<string, unknown>);
            return { context: request.projection.render };
          },
        }),
      ])
    );
    await instance.start();
    await settle(clock);
    const request = seen[0];
    expect(request).toBeDefined();
    // Authority items 3 and 5: identity and routing are host-owned and are
    // not reachable from anything a thinker program is handed.
    for (const forbidden of [
      'transport',
      'routes',
      'selfName',
      'authority',
      'close',
      'ownership',
    ]) {
      expect(Object.hasOwn(request!, forbidden)).toBe(false);
    }
    // What it DOES carry, so the negatives above are about authority and not
    // about an empty object.
    expect(request?.projection).toBeDefined();
    expect(request?.artifacts).toMatchObject({ revision: 'rev-1' });
    expect(Array.isArray(request?.signals)).toBe(true);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

/**
 * A probe whose usage ACCUMULATES across runs, the way every real `AxProgram`'s
 * does: `getUsage()` reports everything since the last `resetUsage()`, and the
 * runtime reuses one program per thinker for the mind's whole life.
 */
function accumulatingProgram(perCall: number): ProbeProgram {
  let total = 0;
  const program = probeProgram(() => {
    total += perCall;
    return { reply: 'ok' };
  });
  (program as unknown as { getUsage: () => unknown }).getUsage = () => [
    {
      ai: 'probe',
      model: 'probe',
      tokens: {
        promptTokens: total,
        completionTokens: 0,
        totalTokens: total,
      },
    },
  ];
  return program;
}

/**
 * Advances event time until a condition holds, or gives up after a bounded
 * number of passes. A fixed round count is a wall-clock assumption in
 * disguise: the same 80 rounds that are generous on a laptop are not on a
 * loaded CI runner, and the ASSERTIONS below are what must stay strict.
 */
async function pumpUntil(
  clock: AxManualEventClock,
  done: () => boolean | Promise<boolean>,
  options: Readonly<{ stepMs?: number; rounds?: number; passes?: number }> = {}
): Promise<void> {
  const passes = options.passes ?? 40;
  for (let pass = 0; pass < passes; pass++) {
    if (await done()) return;
    await settle(clock, options.stepMs ?? 5, options.rounds ?? 20);
  }
  await done();
}

const FAST_PACER = Object.freeze({
  baseMs: 1,
  factor: 1,
  capMs: 10,
  hold: 50,
  thoughtCapMs: 5,
});

async function errorSteps(
  store: AxTrajectoryStore
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  return (await typesIn(store)).filter((step) => step.type === 'error');
}

describe('AxMind per-step budgets', () => {
  it('caps the tokens ONE step spends, never the thinker`s lifetime total', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    // Four hundred a wake under a thousand-token cap. A lifetime counter
    // crosses the cap on wake three and never comes back down, so the mind
    // errors on every wake forever; a per-step budget never trips at all.
    const program = accumulatingProgram(400);
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          budget: {
            maxWallClockMs: 5_000,
            maxTokens: 1_000,
            maxSubRuns: 2,
            maxDepth: 1,
          },
          pacer: FAST_PACER,
        }),
      ])
    );
    await instance.start();
    await pumpUntil(clock, () => program.calls.length >= 8);
    expect(program.calls.length).toBeGreaterThan(6);
    expect(await errorSteps(store)).toHaveLength(0);
    expect(instance.health().thinkers[0]?.consecutiveErrors).toBe(0);
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('still refuses ONE step that spends over the cap', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    // The negative half: the dimension is real, not merely unreachable.
    const program = accumulatingProgram(1_500);
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          budget: {
            maxWallClockMs: 5_000,
            maxTokens: 1_000,
            maxSubRuns: 2,
            maxDepth: 1,
          },
          pacer: FAST_PACER,
        }),
      ])
    );
    await instance.start();
    await pumpUntil(clock, async () => (await errorSteps(store)).length > 0);
    const errors = await errorSteps(store);
    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0]?.data.content)).toMatch(/tokens over 1000/);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind step settlement', () => {
  it('counts work a thinker does in its own sink, and never calls that wake idle', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    let writes = 0;
    const thinker = thinkerWith('worker', program, {
      subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
      sinks: [
        {
          id: 'worker.effect',
          write: async () => {
            writes++;
            await instance.append({
              trajectoryId: '',
              type: 'action',
              source: 'worker',
              launchedBy: 'worker',
              data: { content: 'answered from the sink' },
            });
          },
        },
      ],
    });
    // The sink closes over `instance`, which the factory below returns: a
    // closure body is evaluated when it runs, not when it is written.
    const instance = mind(baseOptions(store, [thinker]));
    await instance.start();
    await pumpUntil(clock, () => writes > 0);
    expect(writes).toBeGreaterThan(0);
    const steps = await typesIn(store);
    // The whole claim in two assertions: the sink's work is in the log, and
    // the mind did NOT write "nothing to do right now" beside it. An `idle`
    // step here is false, narrative, and uncorrectable (I1).
    expect(steps.some((step) => step.type === 'action')).toBe(true);
    expect(steps.filter((step) => step.type === 'idle')).toHaveLength(0);
    const paces = steps.filter((step) => step.type === 'mind-wake');
    expect(paces.length).toBeGreaterThan(0);
    expect(paces.map((step) => step.data.outcome)).toContain('visible');
    expect(paces.every((step) => step.data.outcome !== 'empty')).toBe(true);
    // And the share nudge counts a reply as sharing.
    expect(instance.health().thinkers[0]?.lastOutcome).toBe('visible');
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('keeps settling when one of a thinker`s own sinks fails', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const thinker = thinkerWith('worker', program, {
      subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
      sinks: [
        // A broken sink FIRST. The runtime dead-letters it and moves to the
        // next one, so the mind's trailing settle still gets its turn -- the
        // ladder does not depend on every host sink succeeding.
        {
          id: 'worker.broken',
          write: async () => {
            throw new Error('the sink is unreachable');
          },
        },
        {
          id: 'worker.effect',
          write: async () => {
            await instance.append({
              trajectoryId: '',
              type: 'action',
              source: 'worker',
              launchedBy: 'worker',
              data: { content: 'answered anyway' },
            });
          },
        },
      ],
    });
    const instance = mind(
      baseOptions(store, [thinker], { event: { maxAttempts: 1 } })
    );
    await instance.start();
    await pumpUntil(clock, async () =>
      (await typesIn(store)).some((step) => step.type === 'action')
    );
    const steps = await typesIn(store);
    expect(steps.some((step) => step.type === 'action')).toBe(true);
    expect(steps.filter((step) => step.type === 'mind-wake').length).toBe(1);
    expect((await instance.deadLetters()).length).toBeGreaterThan(0);
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('settles a delivery that never reached its program, on the tick, and re-arms', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const diagnostics: AxMindDiagnostic[] = [];
    const thinker = thinkerWith('worker', probeProgram(), {
      subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
      pacer: FAST_PACER,
      budget: {
        maxWallClockMs: 20,
        maxTokens: 1_000,
        maxSubRuns: 2,
        maxDepth: 1,
      },
    });
    const instance = mind(
      baseOptions(store, [thinker], {
        onDiagnostic: (one) => diagnostics.push(one),
        event: { maxAttempts: 1 },
      })
    );
    await instance.start();
    await settle(clock, 5, 10);
    // The mind's OWN target, driven the way the runtime drives it: the
    // assembler writes the in-flight record, and then the delivery goes away
    // -- an abort between assembly and forward, a lost lease, a shutdown.
    // Nothing else in the mind can notice, which is why the tick has to.
    const target = instance.routes()[0]?.target;
    expect(target?.mapInput).toBeDefined();
    await target?.mapInput?.(
      {
        event: {
          specversion: '1.0',
          id: 'synthetic-wake',
          source: 'ax://mind/mind-under-test',
          type: 'ax.mind.wake',
          subject: 'thinker:worker',
          data: { thinker: 'worker' },
          extensions: { stepsource: 'mind-tick' },
        },
        trust: 'trusted',
      } as never,
      { eventContext: { deliveryId: 'abandoned-delivery' } } as never
    );
    await pumpUntil(
      clock,
      () => diagnostics.some((one) => one.code === 'liveness-fallback-armed'),
      { stepMs: 20, rounds: 20 }
    );
    // The in-flight record is released and one wake is re-armed, so a mind
    // whose runs die between assembly and forward degrades to a delay rather
    // than leaking a step record and going silent.
    expect(
      diagnostics.filter((one) => one.code === 'liveness-fallback-armed').length
    ).toBeGreaterThan(0);
    const errors = await errorSteps(store);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((step) =>
        String(step.data.content).includes('never settled delivery')
      )
    ).toBe(true);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind rate fuse recovery', () => {
  it('un-parks with exactly one re-evaluation, with no watchdog to help', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const program = probeProgram();
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', program, {
          // No watchdog at all: the fuse's own re-evaluation is the ONLY
          // liveness layer left, which is what makes this test about the fuse.
          subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
          pacer: { ...FAST_PACER, maxWakesPerHour: 3 },
        }),
      ])
    );
    await instance.start();
    await pumpUntil(
      clock,
      () => instance.getPacerState('monolith')?.parked === 'rate_fuse'
    );
    expect(instance.getPacerState('monolith')?.parked).toBe('rate_fuse');
    const parkedAfter = program.calls.length;
    expect(parkedAfter).toBeGreaterThan(1);
    // Nothing wakes while the trailing hour is still full.
    await settle(clock, 5, 40);
    expect(program.calls.length).toBe(parkedAfter);
    // Drain it. Clearing `parked` alone is not enough: the fuse's decision is
    // `unchanged`, so the kept `wakeAt` is the one this thinker was already
    // dispatched for, and the pace duty is edge triggered on that pair.
    clock.advanceBy(3_600_000);
    let unparked = false;
    for (let round = 0; round < 30 && !unparked; round++) {
      await settle(clock, 2, 4);
      unparked = instance.getPacerState('monolith')?.parked === undefined;
    }
    expect(unparked).toBe(true);
    // The liveness claim, not the state field: the mind actually woke again.
    expect(program.calls.length).toBeGreaterThan(parkedAfter);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind projection dead-letters', () => {
  const budget = {
    maxWallClockMs: 5_000,
    maxTokens: 1_000,
    maxSubRuns: 2,
    maxDepth: 1,
  } as const;

  it('dead-letters a rollup meta conflict before any model call, and wakes again', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const diagnostics: AxMindDiagnostic[] = [];
    const program = probeProgram();
    const rollups = {
      loadMeta: async () => {
        throw new AxTrajectoryRollupError(
          'the sealed block disagrees with the meta',
          'meta_conflict'
        );
      },
      saveMeta: async () => undefined,
      getBlock: async () => undefined,
      putBlock: async () => undefined,
    } as unknown as AxTrajectoryRollupStore;
    const instance = mind(
      baseOptions(
        store,
        [
          thinkerWith('monolith', program, {
            subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
            pacer: FAST_PACER,
            budget,
          }),
        ],
        { rollups, onDiagnostic: (one) => diagnostics.push(one) }
      )
    );
    await instance.start();
    await pumpUntil(
      clock,
      () =>
        diagnostics.filter((one) => one.code === 'context-assembly-failed')
          .length > 2
    );
    // The whole claim in one number: zero model calls, ever.
    expect(program.calls).toHaveLength(0);
    const failures = diagnostics.filter(
      (one) => one.code === 'context-assembly-failed'
    );
    // And the mind is not dead: the bootstrap wake dead-lettered, and the
    // liveness fallback armed the next one, repeatedly.
    expect(failures.length).toBeGreaterThan(2);
    expect(
      diagnostics.filter((one) => one.code === 'liveness-fallback-armed').length
    ).toBeGreaterThan(0);
    // Bounded, not a hot loop: the fallback delay is the thinker's own cap.
    expect(failures.length).toBeLessThan(300);
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('dead-letters an unsupported type set before any model call, and wakes again', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const diagnostics: AxMindDiagnostic[] = [];
    const program = probeProgram();
    // A log with a real tail: the projection reads it with an explicit type
    // set, which is the read `unsupported_types` comes out of.
    for (let index = 0; index < 6; index++) {
      await store.append({
        trajectoryId: TRAJECTORY,
        type: 'observation',
        source: 'system',
        data: { content: `seeded ${index}` },
      });
    }
    let live = false;
    const failing: AxTrajectoryStore = Object.create(store);
    failing.tailBackward = async (request, signal) => {
      if (live && request.types?.length) {
        throw new AxTrajectoryQueryError(
          'no narrative type survives the requested set',
          'unsupported_types'
        );
      }
      return store.tailBackward(request, signal);
    };
    const instance = mind(
      baseOptions(
        failing,
        [
          thinkerWith('monolith', program, {
            subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
            pacer: FAST_PACER,
            budget,
          }),
        ],
        { onDiagnostic: (one) => diagnostics.push(one) }
      )
    );
    await instance.start();
    live = true;
    await pumpUntil(
      clock,
      () =>
        diagnostics.filter((one) => one.code === 'context-assembly-failed')
          .length > 2
    );
    expect(program.calls).toHaveLength(0);
    expect(
      diagnostics.filter((one) => one.code === 'context-assembly-failed').length
    ).toBeGreaterThan(2);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

/**
 * A host adapter over the REAL `AxInMemoryEventStore` effect state machine,
 * including its fencing. This is the seam `AxMindOptions.effectLedger` names,
 * and the shipped `axMindResponder` cannot send a single message without one.
 */
async function hostLedger(
  clock: AxManualEventClock
): Promise<AxMindEffectLedger> {
  const store = new AxInMemoryEventStore({ clock });
  await store.enqueue({
    ingress: {
      event: {
        specversion: '1.0',
        id: axEventId('ledger-lease'),
        source: 'ax://mind/test',
        type: 'ax.mind.wake',
      },
      trust: 'trusted',
    },
    deliveries: [
      {
        routeId: 'ledger',
        action: 'wake',
        targetId: 'ledger',
        instanceKey: 'ledger',
        sizeBytes: 0,
      },
    ],
    acceptedAt: clock.now(),
  });
  const delivery = await store.claim('ledger-worker', clock.now(), 3_600_000);
  if (!delivery) throw new Error('the ledger lease could not be claimed');
  const fence = {
    deliveryId: delivery.id,
    fencingToken: delivery.fencingToken ?? 0,
  };
  const runId = axEventId('run');
  return {
    declareEffect: (intent) =>
      store.declareEffect(
        {
          ...structuredClone(intent),
          id: axEventId('effect'),
          deliveryId: delivery.id,
          runId,
          identityScope: 'test',
          createdAt: clock.now(),
        },
        fence
      ),
    markEffectDispatched: (effectId, version) =>
      store.transitionEffect(
        effectId,
        version,
        { type: 'dispatched', at: clock.now() },
        fence
      ),
    settleEffect: (effectId, version, settlement) =>
      store.transitionEffect(
        effectId,
        version,
        { type: 'settled', at: clock.now(), settlement },
        fence
      ),
    listEffects: () => store.listEffects(delivery.id),
  };
}

/** The responder's own signature, answered by a mock provider. */
function respondingAI(decision: 'reply' | 'no-reply'): AxAIService {
  return new AxMockAIService<string>({
    name: 'mock-responder',
    chatResponse: async () => ({
      results: [
        {
          index: 0,
          content:
            decision === 'reply'
              ? 'Decision: reply\nReply: I am here.'
              : 'Decision: no-reply',
          finishReason: 'stop' as const,
        },
      ],
      modelUsage: {
        ai: 'mock-responder',
        model: 'mock',
        tokens: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
      },
    }),
  }) as unknown as AxAIService;
}

describe('the shipped thinkers, inside a mind', () => {
  it('replies exactly once per inbound message and records the wake as visible', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const sent: Array<Readonly<{ to: string; content: string }>> = [];
    const effectLedger = await hostLedger(clock);
    const instance = mind(
      baseOptions(store, [axMindResponder({ ai: respondingAI('reply') })], {
        effectLedger,
        transport: {
          id: 'test-transport',
          selfName: 'mind',
          send: async (message) => {
            sent.push({ to: message.to, content: message.content });
            return { externalId: `ext-${sent.length}`, at: clock.now() };
          },
        },
      })
    );
    await instance.start();
    await settle(clock, 5, 20);
    await instance.receive({ from: 'ada', to: 'mind', content: 'are you up?' });
    await pumpUntil(clock, () => sent.length >= 1);
    await instance.receive({ from: 'ada', to: 'mind', content: 'still?' });
    await pumpUntil(clock, () => sent.length >= 2);

    // Exactly one outbound per inbound, through the REAL sink, the REAL chat
    // and the REAL idempotency ledger -- the path no other test in this lane
    // ever executed.
    expect(sent).toHaveLength(2);
    expect(sent.every((one) => one.to === 'ada')).toBe(true);
    const steps = await typesIn(store);
    const outbound = steps.filter(
      (step) => step.type === 'message' && step.source === 'responder'
    );
    expect(outbound).toHaveLength(2);
    const inbound = steps.filter(
      (step) => step.type === 'message' && step.source === 'chat'
    );
    expect(new Set(outbound.map((step) => step.data.replyTo))).toEqual(
      new Set(inbound.map((step) => step.stepId))
    );
    // B2 at the shipped level: the reply is written from the sink, so a probe
    // that brackets `forward` alone records the answering wake as `idle` and
    // stamps `empty` on it. Only the bootstrap wake -- which genuinely had
    // nothing to answer -- may be idle here.
    const idles = steps.filter((step) => step.type === 'idle');
    expect(idles).toHaveLength(1);
    expect(idles[0]?.data.wakeClass).toBe('bootstrap');
    const reactive = steps.filter(
      (step) => step.type === 'mind-wake' && step.data.wakeClass === 'reactive'
    );
    expect(reactive).toHaveLength(2);
    expect(reactive.every((step) => step.data.outcome === 'visible')).toBe(
      true
    );
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('records a decline instead of dropping the message silently', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const sent: unknown[] = [];
    const effectLedger = await hostLedger(clock);
    const instance = mind(
      baseOptions(store, [axMindResponder({ ai: respondingAI('no-reply') })], {
        effectLedger,
        transport: {
          id: 'test-transport',
          selfName: 'mind',
          send: async () => {
            sent.push(1);
            return { externalId: 'ext-1', at: clock.now() };
          },
        },
      })
    );
    await instance.start();
    await settle(clock, 5, 20);
    const trigger = await instance.receive({
      from: 'ada',
      to: 'mind',
      content: 'no need to answer',
    });
    await pumpUntil(clock, async () =>
      (await typesIn(store)).some((step) => step.data.decision === 'no-reply')
    );
    expect(sent).toHaveLength(0);
    const steps = await typesIn(store);
    // M12: a decline is a RECORDED decision, not a silent drop, and it sticks
    // across redelivery because it is in the log.
    const declines = steps.filter(
      (step) => step.type === 'observation' && step.data.decision === 'no-reply'
    );
    expect(declines).toHaveLength(1);
    expect(declines[0]?.triggerStep).toBe(trigger.stepId);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind inbound refusals and reconciliation', () => {
  it('refuses self-addressed inbound as a CHAT refusal, explains in band, and stays alive', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        transport: {
          id: 'test-transport',
          selfName: 'mind',
          send: async () => ({ externalId: 'ext-1', at: clock.now() }),
        },
      })
    );
    await instance.start();
    await settle(clock, 5, 20);
    let thrown: unknown;
    try {
      await instance.receive({
        from: 'mind',
        to: 'ada',
        content: 'talking to myself',
      });
    } catch (error) {
      thrown = error;
    }
    // M13 names ONE error for self-addressed traffic in both directions. A
    // host guarding inbound with axIsMindChatError used to miss this entirely,
    // and the reason it saw said a source had failed.
    expect(axIsMindChatError(thrown)).toBe(true);
    expect((thrown as { reason: string }).reason).toBe('self_addressed');
    const steps = await typesIn(store);
    const refusals = steps.filter(
      (step) => step.data.refused === 'self_addressed'
    );
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0]?.data.content)).toMatch(/own identity/);
    // Nothing was accepted as a message, and the mind still takes real mail.
    expect(steps.filter((step) => step.type === 'message')).toHaveLength(0);
    const accepted = await instance.receive({
      from: 'ada',
      to: 'mind',
      content: 'hello',
    });
    expect(accepted.type).toBe('message');
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('reconciles a settled send the crash left out of the log (C10)', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const diagnostics: AxMindDiagnostic[] = [];
    const effectLedger = await hostLedger(clock);
    // A send that LEFT the process and settled, with no message step behind
    // it: the shape a crash between the transport and the append leaves.
    const declared = await effectLedger.declareEffect({
      operation: 'mind.chat.send',
      idempotencyKey: 'ax.mind.chat:reconciled',
      replaySafety: 'unknown',
      metadata: {
        to: 'ada',
        trajectoryId: TRAJECTORY,
        content: 'the message that got out',
      },
    });
    const dispatched = await effectLedger.markEffectDispatched(
      declared.id,
      declared.version
    );
    await effectLedger.settleEffect(dispatched.id, dispatched.version, {
      status: 'succeeded',
      externalId: 'ext-crash',
    });
    const instance = mind(
      baseOptions(store, [thinkerWith('monolith', probeProgram())], {
        effectLedger,
        onDiagnostic: (one) => diagnostics.push(one),
        transport: {
          id: 'test-transport',
          selfName: 'mind',
          send: async () => ({ externalId: 'ext-1', at: clock.now() }),
        },
      })
    );
    // reconcile() runs inside start(); the log converges to the ledger there.
    await instance.start();
    const steps = await typesIn(store);
    const recovered = steps.filter(
      (step) => step.type === 'message' && step.source === 'monolith'
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.data.content).toBe('the message that got out');
    expect(recovered[0]?.data.reconciled).toBe(declared.id);
    expect(
      diagnostics.some((one) => one.code === 'effect-step-reconciled')
    ).toBe(true);
    // Idempotent: a second reconcile does not append the message twice.
    await instance.reconcile();
    const again = (await typesIn(store)).filter(
      (step) => step.type === 'message' && step.source === 'monolith'
    );
    expect(again).toHaveLength(1);
    await instance.close({ drain: false, timeoutMs: 200 });
  });

  it('refuses a mind with an effect-aware thinker and no ledger', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const instance = mind(
      baseOptions(store, [
        thinkerWith('monolith', probeProgram(), {
          retrySafety: 'effect-aware',
        }),
      ])
    );
    await expect(instance.start()).rejects.toThrow(/no effect ledger/);
  });
});

describe('AxMind sub-run ownership', () => {
  const cappedThinker = (name: string, maxSubRuns: number) =>
    thinkerWith(name, probeProgram(), {
      // NARROW subscriptions on purpose. Two thinkers that both subscribe to
      // every narrative type wake each other on their own `idle` steps and
      // never stop; the shipped pair avoids it because the responder listens
      // for `message` only. docs/MIND.md says so under "Two thinkers".
      subscription: {
        ...axDefaultMindSubscription,
        types: ['message'],
        watchdogMs: 0,
      },
      budget: {
        maxWallClockMs: 5_000,
        maxTokens: 1_000,
        maxSubRuns,
        maxDepth: 2,
      },
    });

  it('charges the NAMED thinker`s cap, never whichever ran first', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const instance = mind(
      baseOptions(store, [cappedThinker('a', 8), cappedThinker('b', 0)])
    );
    await instance.start();
    await settle(clock, 5, 20);
    const request = { registrationKey: 'child', input: {} } as const;
    // B's cap is zero, so B's sub-run is refused -- and A's, with the same
    // mind and the same call, is not. Insertion order used to decide this.
    let refused: unknown;
    try {
      await instance.subRun({ ...request, thinker: 'b' });
    } catch (error) {
      refused = error;
    }
    expect(axIsMindBudgetExceededError(refused)).toBe(true);
    expect((refused as { dimension: string }).dimension).toBe('subRuns');
    const result = await instance.subRun({ ...request, thinker: 'a' });
    // No session host is configured, so the child fails -- and still MERGES
    // BACK (I10), which is what proves the cap let it through.
    expect(result.outcome).toBe('failed');
    expect(result.mergeStepId).toBeDefined();
    await expect(
      instance.subRun({ ...request, thinker: 'nobody' })
    ).rejects.toThrow(/no thinker named nobody/);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

describe('AxMind self-suppression', () => {
  it('reports the wake it suppressed, which nothing else can see', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const diagnostics: AxMindDiagnostic[] = [];
    const program = probeProgram(async () => {
      await instance.append({
        trajectoryId: '',
        type: 'thought',
        source: 'monolith',
        launchedBy: 'monolith',
        data: { content: 'talking to myself' },
      });
      return { reply: 'ok' };
    });
    const instance = mind(
      baseOptions(
        store,
        [
          thinkerWith('monolith', program, {
            subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
          }),
        ],
        { onDiagnostic: (one) => diagnostics.push(one) }
      )
    );
    await instance.start();
    await pumpUntil(clock, () =>
      diagnostics.some((one) => one.code === 'wake-suppressed-self')
    );
    // A suppressed wake creates NO delivery and NO step: without the
    // diagnostic there is nowhere a host can see the decision at all.
    const suppressed = diagnostics.filter(
      (one) => one.code === 'wake-suppressed-self'
    );
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed[0]?.thinker).toBe('monolith');
    expect(suppressed[0]?.at).toBeGreaterThan(0);
    // And the suppression is real: one bootstrap call, no self-triggered loop.
    expect(program.calls).toHaveLength(1);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});

describe('the shipped pair, in one mind', () => {
  it('runs a monolith beside a responder without waking each other forever', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = await seed(clock);
    const effectLedger = await hostLedger(clock);
    const reflecting = new AxMockAIService<string>({
      name: 'mock-monolith',
      features: { functions: true },
      chatResponse: async () => ({
        results: [
          {
            index: 0,
            content: 'Reflection: nothing needs doing right now.',
            finishReason: 'stop' as const,
          },
        ],
        modelUsage: {
          ai: 'mock-monolith',
          model: 'mock',
          tokens: { promptTokens: 30, completionTokens: 9, totalTokens: 39 },
        },
      }),
    }) as unknown as AxAIService;
    const instance = mind(
      baseOptions(
        store,
        [
          axMindMonolith({
            ai: reflecting,
            subscription: { watchdogMs: 0 },
            pacer: FAST_PACER,
          }),
          axMindResponder({ ai: respondingAI('reply') }),
        ],
        {
          effectLedger,
          transport: {
            id: 'test-transport',
            selfName: 'mind',
            send: async () => ({ externalId: 'ext', at: clock.now() }),
          },
        }
      )
    );
    await instance.start();
    const wakesOf = async (thinker: string) =>
      (await typesIn(store)).filter(
        (step) => step.type === 'mind-wake' && step.launchedBy === thinker
      ).length;
    await pumpUntil(clock, async () => (await wakesOf('monolith')) >= 3);
    const steps = await typesIn(store);
    const monolithWakes = await wakesOf('monolith');
    const responderWakes = await wakesOf('responder');
    // The shipped pair is safe because the responder listens for `message`
    // ONLY. Two thinkers that both take the default (every narrative type)
    // subscription wake each other on their own `idle` steps forever, which
    // is a live token-burning runaway -- docs/MIND.md says so, and this is
    // the assertion that would catch the shipped pair growing into it. The
    // paced monolith advances; the responder wakes ONCE, for its bootstrap,
    // and the log grows with the pacer rather than with the pair.
    expect(monolithWakes).toBeGreaterThanOrEqual(3);
    expect(responderWakes).toBe(1);
    expect(steps.length).toBeLessThanOrEqual(monolithWakes * 4 + 20);
    await instance.close({ drain: false, timeoutMs: 200 });
  });
});
