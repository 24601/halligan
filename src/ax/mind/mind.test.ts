import { describe, expect, it } from 'vitest';

import { AxAgentSessionHost } from '../agent/retainedSessions.js';
import type { AxAIService } from '../ai/types.js';
import { AxSignature } from '../dsp/sig.js';
import type { AxProgrammable } from '../dsp/types.js';
import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryTrajectoryStore } from '../trajectory/memoryStore.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import type {
  AxTrajectoryStep,
  AxTrajectoryStore,
} from '../trajectory/types.js';
import { AxMind, type AxMindOptions, mind } from './mind.js';
import {
  AxInMemoryMindOwnershipStore,
  type AxMindDiagnostic,
  type AxMindThinker,
  axDefaultMindSubscription,
  axIsMindBudgetExceededError,
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
