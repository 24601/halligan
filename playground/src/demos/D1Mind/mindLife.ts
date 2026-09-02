import {
  AxInMemoryEventStore,
  AxInMemoryTrajectoryRollupStore,
  AxInMemoryTrajectoryStore,
  AxManualEventClock,
  type AxMind,
  AxMindDeterministicProgram,
  type AxMindPacerConfig,
  type AxMindThinker,
  AxSignature,
  type AxTrajectoryProjection,
  type AxTrajectoryRollupBlock,
  type AxTrajectoryStep,
  axBuildTrajectoryRollups,
  axDefaultMindPacerConfig,
  axDefaultMindSubscription,
  axDeterministicTrajectorySummarizer,
  axMindStaticArtifacts,
  axProjectTrajectory,
  axTrajectoryContextBudget,
  axTrajectoryDefaultFanout,
  axTrajectoryRecentSize,
  mind,
} from '../../lib/axImport.js';
import { type AxPrng, epochOrigin, prng } from '../../lib/seeds.js';

/**
 * The hero's mind. Everything below runs the real runtime: the routes, the
 * dispatcher, the pacing ladder, the reply guard, the projection and the
 * tiered rollups. There are zero model calls, because the thinker is an
 * `AxMindDeterministicProgram` -- exactly the arrangement
 * `src/examples/mind-persistent-agent.ts` ships. The only substitutions Pry
 * makes are the stores: `AxInMemoryTrajectoryStore` and
 * `AxInMemoryEventStore` instead of the node-only JSONL/SQLite ones.
 *
 * No number rendered by this demo is typed into a fixture. Every figure is
 * read back out of the store, the projection, the rollup store or the pacer.
 */
export const THINKER = 'reflector';
export const TRAJECTORY = 'pry-hero';

/** The reflector's own words, computed from the life it was handed. */
class Reflector extends AxMindDeterministicProgram<
  { mindContext: string; newest: string },
  { reflection: string }
> {
  constructor(private readonly host: AxMind) {
    super(
      AxSignature.create(
        'mindContext:string, newest:string -> reflection:string'
      )
    );
  }

  async run(values: {
    mindContext: string;
    newest: string;
  }): Promise<{ reflection: string }> {
    // Nothing new since its own last note: it writes nothing, the work probe
    // sees no durable effect, the wake settles `empty`, and the pacing ladder
    // is allowed to descend. This is the whole reason the hero has a ladder to
    // draw -- a thinker that always writes something never backs off.
    if (values.newest.startsWith('thought') || values.newest === 'none') {
      return { reflection: 'nothing new since my last note' };
    }
    const lines = values.mindContext
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const reflection = `I read ${lines.length} lines of my own life this wake; the newest was ${values.newest}.`;
    await this.host.append({
      type: 'thought',
      source: THINKER,
      launchedBy: THINKER,
      data: { content: reflection },
    });
    return { reflection };
  }
}

function describeNewest(recent: readonly Readonly<AxTrajectoryStep>[]): string {
  const step = recent.at(-1);
  if (!step) return 'none';
  const content = String(step.data.content ?? '').slice(0, 48);
  return `${step.type} from ${step.source ?? 'host'}${content ? `: ${content}` : ''}`;
}

export interface LifeOptions {
  readonly seed: number;
  readonly capMs: number;
  readonly contextWindowTokens: number;
  readonly trajectoryId?: string;
  readonly fanout?: number;
  /** Share a store and a clock with another life -- used by the fork demo. */
  readonly store?: AxInMemoryTrajectoryStore;
  readonly clock?: AxManualEventClock;
  /** The trajectory already exists (a fork child); do not create it. */
  readonly existing?: boolean;
}

export interface SealEvent {
  readonly tier: number;
  readonly start: number;
  readonly end: number;
}

export interface LifeSnapshot {
  readonly steps: readonly Readonly<AxTrajectoryStep>[];
  readonly stepCount: number;
  readonly projection: Readonly<AxTrajectoryProjection> | null;
  readonly blocks: readonly Readonly<AxTrajectoryRollupBlock>[];
  readonly onPath: ReadonlySet<string>;
  readonly now: number;
}

export const blockKey = (block: Readonly<{ tier: number; start: number }>) =>
  `t${block.tier}s${block.start}`;

/**
 * One running life: a store, a rollup store, a manual clock and a mind. The
 * caller owns the clock -- nothing in here advances time on its own, which is
 * what makes "one simulated hour in eight seconds" exact rather than
 * approximate.
 */
export class Life {
  readonly clock: AxManualEventClock;
  readonly store: AxInMemoryTrajectoryStore;
  readonly rollups = new AxInMemoryTrajectoryRollupStore();
  readonly events: AxInMemoryEventStore;
  readonly summarizer = axDeterministicTrajectorySummarizer();
  readonly trajectoryId: string;
  readonly pacerConfig: Readonly<AxMindPacerConfig>;
  readonly fanout: number;
  readonly budgetTokens: number;
  readonly random: AxPrng;
  mind!: AxMind;

  private started = false;
  private pokeCount = 0;

  constructor(readonly options: LifeOptions) {
    this.trajectoryId = options.trajectoryId ?? TRAJECTORY;
    this.clock = options.clock ?? new AxManualEventClock(epochOrigin);
    this.store =
      options.store ?? new AxInMemoryTrajectoryStore({ clock: this.clock });
    this.events = new AxInMemoryEventStore({ clock: this.clock });
    this.random = prng(options.seed);
    this.fanout = options.fanout ?? axTrajectoryDefaultFanout;
    this.pacerConfig = Object.freeze({
      ...axDefaultMindPacerConfig,
      capMs: options.capMs,
    });
    // Read from the shipped formula, never assumed: budget = min(fraction *
    // window, maxTokens). A bigger window is not permission to spend it.
    this.budgetTokens = axTrajectoryContextBudget({
      contextWindowTokens: options.contextWindowTokens,
    });
  }

  get recentSize(): number {
    return axTrajectoryRecentSize(this.budgetTokens);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.options.existing) {
      await this.store.create({ trajectoryId: this.trajectoryId });
    }

    const thinker: AxMindThinker = {
      name: THINKER,
      kind: 'monolith',
      subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
      ai: {} as never, // a deterministic program never touches the service
      createProgram: async ({ mind: host }) => new Reflector(host),
      context: (request) => ({
        mindContext: request.projection.render,
        newest: describeNewest(request.projection.recent),
      }),
      // Scheduled spontaneity lives on the thinker: at most one thinker may
      // set it, and without it a mind only ever wakes reactively.
      pacer: this.pacerConfig,
    };

    this.mind = mind({
      id: this.trajectoryId,
      trajectoryId: this.trajectoryId,
      store: this.store,
      rollups: this.rollups,
      summarizer: this.summarizer,
      artifacts: axMindStaticArtifacts({
        revision: 'pry-1',
        persona: 'You keep your own notes. Nobody is watching.',
        thinkerPrompts: {},
        goals: [
          {
            id: 'g1',
            content: 'Notice what changed since the last wake',
            priority: 5,
            status: 'active',
          },
        ],
        skills: [],
      }),
      thinkers: [thinker],
      budget: { contextWindowTokens: this.options.contextWindowTokens },
      clock: this.clock,
      pacer: this.pacerConfig,
      // The always-alive tick grid. 1s is far finer than the smallest ladder
      // delay (5s) and costs a quarter of the per-advance work a 250ms grid
      // does, which is what keeps a fast-forward from monopolising the main
      // thread.
      tickMs: 1_000,
      sourcePollMs: 250,
      allowVolatileTrajectory: true,
      event: { store: this.events, clock: this.clock, allowVolatile: true },
    });

    await this.mind.start();
    if (!this.options.existing) {
      await this.append(
        'observation',
        'the deploy finished and nobody said anything about it'
      );
    }
  }

  async append(type: string, content: string): Promise<void> {
    await this.mind.append({ type, source: 'host', data: { content } });
  }

  /** The "poke": a synthetic ingress through the real dispatch path. */
  async poke(kind: 'observation' | 'message' | 'error'): Promise<void> {
    this.pokeCount += 1;
    const n = this.pokeCount;
    const content =
      kind === 'observation'
        ? `a webhook arrived out of nowhere (#${n})`
        : kind === 'message'
          ? `someone asked whether anything had changed (#${n})`
          : `tool call failed: connect ECONNREFUSED 127.0.0.1:11434 (#${n})`;
    await this.mind.append({ type: kind, source: 'host', data: { content } });
  }

  /**
   * Advance simulated time. Sources are the only timers and they are asleep
   * until event time moves, so each chunk yields to the macrotask queue first
   * -- exactly the shape `mind-persistent-agent.ts` uses.
   */
  async advance(totalMs: number, chunkMs = 1000): Promise<void> {
    let left = Math.max(0, totalMs);
    let guard = 0;
    while (left > 0 && guard < 240) {
      const step = Math.min(chunkMs, left);
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.clock.advanceBy(step);
      left -= step;
      guard += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Seals every block whose fanout children now exist. Idempotent. */
  async seal(): Promise<readonly SealEvent[]> {
    const before = await this.rollups.loadMeta(this.trajectoryId);
    const result = await axBuildTrajectoryRollups({
      trajectoryId: this.trajectoryId,
      store: this.store,
      rollups: this.rollups,
      summarizer: this.summarizer,
      fanout: this.fanout,
      budgetTokens: this.budgetTokens,
      backfill: true,
    });
    if (result.sealed === 0) return [];
    const after = await this.rollups.loadMeta(this.trajectoryId);
    const sealed: SealEvent[] = [];
    const from = before?.sealedIndex ?? after?.startIndex ?? 0;
    const to = after?.sealedIndex ?? from;
    for (const tier of result.tiersTouched) {
      const size = this.fanout ** tier;
      for (
        let start = Math.floor(from / size) * size;
        start + size <= to;
        start += size
      ) {
        if (start < from) continue;
        sealed.push({ tier, start, end: start + size });
      }
    }
    return sealed;
  }

  /** Enumerates the sealed blocks the rollup store actually holds. */
  async listBlocks(): Promise<readonly Readonly<AxTrajectoryRollupBlock>[]> {
    const meta = await this.rollups.loadMeta(this.trajectoryId);
    if (!meta) return [];
    const out: Readonly<AxTrajectoryRollupBlock>[] = [];
    for (let tier = 1; tier <= 6; tier++) {
      const size = meta.fanout ** tier;
      if (size > Math.max(1, meta.sealedIndex - meta.startIndex)) break;
      for (
        let start = Math.floor(meta.startIndex / size) * size;
        start + size <= meta.sealedIndex;
        start += size
      ) {
        const block = await this.rollups.getBlock(
          this.trajectoryId,
          tier,
          start
        );
        if (block) out.push(block);
      }
    }
    return out;
  }

  async project(
    budgetTokens = this.budgetTokens
  ): Promise<Readonly<AxTrajectoryProjection>> {
    return axProjectTrajectory({
      trajectoryId: this.trajectoryId,
      store: this.store,
      rollups: this.rollups,
      fanout: this.fanout,
      budgetTokens,
    });
  }

  async snapshot(limit = 80): Promise<LifeSnapshot> {
    const tail = await this.store.tailBackward({
      trajectoryId: this.trajectoryId,
      limit,
      maxScan: limit * 8,
    });
    const stats = await this.store.stats(this.trajectoryId);
    const projection = await this.project().catch(() => null);
    const blocks = await this.listBlocks();
    const onPath = new Set<string>();
    for (const section of projection?.life ?? []) {
      if (section.kind === 'summary') onPath.add(blockKey(section.block));
    }
    return {
      steps: tail.steps,
      stepCount: stats?.stepCount ?? tail.steps.length,
      projection,
      blocks,
      onPath,
      now: this.clock.now(),
    };
  }

  pacer() {
    return this.mind.getPacerState(THINKER);
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.mind
      .close({ drain: false, timeoutMs: 200 })
      .catch(() => undefined);
  }
}
