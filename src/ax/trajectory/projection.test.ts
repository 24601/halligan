import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AxMockAIService } from '../ai/mock/api.js';
import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryTrajectoryStore } from './memoryStore.js';
import {
  type AxTrajectoryProjection,
  type AxTrajectoryProjectionSection,
  axProjectTrajectory,
  axRenderTrajectoryProjection,
  axResolveTrajectoryCitations,
  axTrajectoryContextBudget,
  axTrajectoryRecentSize,
} from './projection.js';
import { axTrajectoryTypeRegistry } from './registry.js';
import {
  AxInMemoryTrajectoryRollupStore,
  type AxTrajectoryRollupBlock,
  type AxTrajectoryRollupStore,
  type AxTrajectorySummarizer,
  axBuildTrajectoryRollups,
  axDeterministicTrajectorySummarizer,
  axTrajectoryProgramSummarizer,
} from './rollups.js';
import { AxTrajectoryRollupError, axIsTrajectoryQueryError } from './types.js';

interface Log {
  readonly store: AxInMemoryTrajectoryStore;
  readonly trajectoryId: string;
  /** stepId of every narrative step, in filtered-index order. */
  readonly narrative: readonly string[];
}

/**
 * Every third step is machinery, so the filtered index and the raw seq are
 * deliberately different numbers: a projection that confuses them fails here
 * rather than silently mis-citing under a host's real log.
 */
async function makeLog(
  narrativeSteps: number,
  options?: Readonly<{ unknownEvery?: number; big?: number }>
): Promise<Log> {
  const clock = new AxManualEventClock(1_000);
  const store = new AxInMemoryTrajectoryStore({ clock });
  const { trajectoryId } = await store.create({});
  const narrative: string[] = [];
  for (let index = 0; index < narrativeSteps; index += 1) {
    await store.append({
      trajectoryId,
      type: 'run',
      data: { command: `machinery ${index}` },
    });
    if (options?.unknownEvery && index % options.unknownEvery === 0) {
      await store.append({
        trajectoryId,
        type: 'host-invented-type',
        data: { content: `unknown ${index}` },
      });
    }
    const big = options?.big !== undefined && index === options.big;
    const receipt = await store.append({
      trajectoryId,
      type: 'thought',
      source: 'agent',
      data: { content: big ? 'X'.repeat(9_000) : `thought ${index}` },
    });
    narrative.push(receipt.stepId);
  }
  return { store, trajectoryId, narrative };
}

async function buildAll(
  log: Log,
  rollups: AxTrajectoryRollupStore,
  extra?: Readonly<{
    summarizer?: AxTrajectorySummarizer;
    backfill?: boolean;
    fanout?: number;
    maxBlocks?: number;
  }>
): Promise<{ sealed: number; skipped: number; failed: number }> {
  const totals = { sealed: 0, skipped: 0, failed: 0 };
  for (let round = 0; round < 2_000; round += 1) {
    const result = await axBuildTrajectoryRollups({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
      summarizer: extra?.summarizer ?? axDeterministicTrajectorySummarizer(),
      backfill: extra?.backfill ?? true,
      maxBlocks: extra?.maxBlocks ?? 128,
      ...(extra?.fanout ? { fanout: extra.fanout } : {}),
    });
    totals.sealed += result.sealed;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
    if (result.sealed === 0) break;
  }
  return totals;
}

function summaries(
  projection: Readonly<AxTrajectoryProjection>
): readonly Readonly<AxTrajectoryRollupBlock>[] {
  const out: Readonly<AxTrajectoryRollupBlock>[] = [];
  for (const section of projection.life) {
    if (section.kind === 'summary') out.push(section.block);
  }
  return out;
}

function spans(
  projection: Readonly<AxTrajectoryProjection>
): readonly (readonly [number, number, string])[] {
  return projection.life.map((section: AxTrajectoryProjectionSection) =>
    section.kind === 'summary'
      ? ([
          section.block.start,
          section.block.end,
          `t${section.block.tier}`,
        ] as const)
      : ([section.start, section.end, section.reason] as const)
  );
}

/** Hides chosen (tier, start) keys so a descent has something real to descend into. */
class HidingRollupStore implements AxTrajectoryRollupStore {
  readonly getBlockCalls: string[] = [];
  constructor(
    private readonly inner: AxInMemoryTrajectoryRollupStore,
    private readonly hidden: ReadonlySet<string> = new Set()
  ) {}
  loadMeta(trajectoryId: string, signal?: AbortSignal) {
    return this.inner.loadMeta(trajectoryId, signal);
  }
  saveMeta(trajectoryId: string, meta: never, signal?: AbortSignal) {
    return this.inner.saveMeta(trajectoryId, meta, signal);
  }
  async getBlock(
    trajectoryId: string,
    tier: number,
    start: number,
    signal?: AbortSignal
  ) {
    this.getBlockCalls.push(`${tier}:${start}`);
    if (this.hidden.has(`${tier}:${start}`)) return undefined;
    return this.inner.getBlock(trajectoryId, tier, start, signal);
  }
  putBlock(trajectoryId: string, block: never, signal?: AbortSignal) {
    return this.inner.putBlock(trajectoryId, block, signal);
  }
}

describe('axTrajectoryContextBudget', () => {
  it('caps a huge window: a bigger window is not permission to spend it', () => {
    expect(axTrajectoryContextBudget({ contextWindowTokens: 500_000 })).toBe(
      4_000
    );
    expect(axTrajectoryContextBudget({ contextWindowTokens: 2_000_000 })).toBe(
      4_000
    );
  });

  it('lets the fraction govern a window smaller than the cap', () => {
    // 0.6 * 4000 = 2400, under the 4000 cap, so the fraction is what binds.
    expect(axTrajectoryContextBudget({ contextWindowTokens: 4_000 })).toBe(
      2_400
    );
    expect(
      axTrajectoryContextBudget({ contextWindowTokens: 4_000, fraction: 0.25 })
    ).toBe(1_000);
  });

  it('applies the cap even at 8k, and honours a raised cap', () => {
    // RFC 8.5 lists both `500_000 -> 4000` and `8_000 -> 4800` under one
    // min(fraction*window, maxTokens) rule; they cannot both hold. The cap row
    // is the one the RFC's own prose is about, so the cap wins by default and
    // the 4800 number is reachable by raising maxTokens explicitly.
    expect(axTrajectoryContextBudget({ contextWindowTokens: 8_000 })).toBe(
      4_000
    );
    expect(
      axTrajectoryContextBudget({
        contextWindowTokens: 8_000,
        maxTokens: 8_000,
      })
    ).toBe(4_800);
  });

  it('fails closed on an unusable window rather than inventing one', () => {
    expect(axTrajectoryContextBudget({ contextWindowTokens: Number.NaN })).toBe(
      0
    );
    expect(axTrajectoryContextBudget({ contextWindowTokens: -1 })).toBe(0);
    expect(
      axTrajectoryContextBudget({
        contextWindowTokens: 100_000,
        fraction: Number.POSITIVE_INFINITY,
      })
    ).toBe(4_000);
  });
});

describe('axTrajectoryRecentSize', () => {
  it('derives R from the budget and floors it at 20', () => {
    expect(axTrajectoryRecentSize(4_000)).toBe(40);
    expect(axTrajectoryRecentSize(100_000)).toBe(1_000);
    // floor(0.4 * 400 / 40) = 4, floored to the minimum.
    expect(axTrajectoryRecentSize(400)).toBe(20);
    expect(axTrajectoryRecentSize(0)).toBe(20);
  });

  it('honours the tokensPerStep escape hatch without becoming a knob', () => {
    expect(axTrajectoryRecentSize(4_000, 10)).toBe(160);
    expect(axTrajectoryRecentSize(4_000, 0)).toBe(40);
  });
});

describe('the raw recent stream', () => {
  it('excludes machinery and unknown steps from recent and from life', async () => {
    const log = await makeLog(60, { unknownEvery: 5 });
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
    });
    expect(projection.coverage.toIndex).toBe(60);
    expect(projection.recent.every((step) => step.type === 'thought')).toBe(
      true
    );
    expect(projection.render).not.toContain('machinery ');
    expect(projection.render).not.toContain('unknown ');
    expect(projection.render).not.toContain('host-invented-type');
  });

  it('drops a requested machinery type instead of honouring it', async () => {
    const log = await makeLog(30);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      types: ['run', 'thought'],
    });
    expect(projection.recent.every((step) => step.type === 'thought')).toBe(
      true
    );
    // 'run' is machinery, so asking for it changes nothing: the count is the
    // narrative count, not the narrative+machinery count.
    expect(projection.coverage.toIndex).toBe(30);
  });

  it('returns the tail oldest-first with no rollups at all', async () => {
    const log = await makeLog(35);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
    });
    // N (35) <= R (40), so cut0 is 0 and every filtered step is verbatim.
    expect(projection.life).toEqual([]);
    expect(projection.recent).toHaveLength(35);
    expect(projection.recent.map((step) => step.stepId)).toEqual(log.narrative);
  });

  it('rehydrates a spilled field and never renders its truncated head', async () => {
    const log = await makeLog(25, { big: 3 });
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
    });
    const step = projection.recent.find(
      (entry) => entry.seq >= 0 && entry.blobs
    );
    expect(step, 'the spilled step must resolve, not survive as a ref').toBe(
      undefined
    );
    expect(projection.render).toContain('X'.repeat(9_000));
    expect(projection.render).not.toContain('<unresolved');
  });

  it('follows the registry when a host declares its own narrative type', async () => {
    const registry = axTrajectoryTypeRegistry([
      {
        type: 'journal',
        stepClass: 'narrative',
        wakeable: true,
        carriesSource: true,
      },
      // Re-declaring a shipped narrative type as machinery must remove it.
      {
        type: 'thought',
        stepClass: 'machinery',
        wakeable: true,
        carriesSource: false,
      },
    ]);
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryTrajectoryStore({ clock, registry });
    const { trajectoryId } = await store.create({});
    for (let index = 0; index < 6; index += 1) {
      await store.append({
        trajectoryId,
        type: 'thought',
        data: { content: `t${index}` },
      });
      await store.append({
        trajectoryId,
        type: 'journal',
        source: 'agent',
        data: { content: `j${index}` },
      });
    }
    const projection = await axProjectTrajectory({
      trajectoryId,
      store,
      registry,
    });
    expect(projection.coverage.toIndex).toBe(6);
    expect(projection.recent.every((step) => step.type === 'journal')).toBe(
      true
    );
    expect(projection.render).not.toContain('t0');
  });

  it('throws a typed query error for an unknown trajectory', async () => {
    const log = await makeLog(1);
    await expect(
      axProjectTrajectory({ trajectoryId: 'nope', store: log.store })
    ).rejects.toSatisfy(axIsTrajectoryQueryError);
  });
});

describe('the staircase assembler', () => {
  it('covers the log totally from index zero for a fully sealed pyramid', async () => {
    const log = await makeLog(1_055);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(projection.coverage).toEqual({
      fromIndex: 0,
      toIndex: 1_055,
      gaps: [],
    });
    const ordered = spans(projection);
    expect(ordered[0]?.[0]).toBe(0);
    // Contiguous and strictly ascending: chronology, oldest first.
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]?.[0]).toBe(ordered[index - 1]?.[1]);
    }
    const cut0 = ordered[ordered.length - 1]?.[1] ?? 0;
    expect(cut0 + projection.recent.length).toBe(1_055);
  });

  it('stays under R + F*ceil(log_F N) life sections on a 3k-step log', async () => {
    const log = await makeLog(3_000);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    const bound = 10 * Math.ceil(Math.log(3_000) / Math.log(10));
    expect(projection.life.length).toBeLessThanOrEqual(bound);
    // Two-sided: a projection that emits nothing also satisfies a ceiling.
    expect(projection.life.length).toBeGreaterThan(0);
    expect(projection.recent.length).toBeGreaterThanOrEqual(40);
    expect(projection.recent.length).toBeLessThan(50);
    // The whole point: the staircase is far smaller than the raw replay.
    const raw = await log.store.read({
      trajectoryId: log.trajectoryId,
      fromSeq: 0,
      toSeq: 20_000,
      types: ['thought'],
    });
    expect(raw).toHaveLength(3_000);
    expect(projection.estimatedTokens).toBeLessThan(raw.length);
  });

  it('keeps chronology when cut0 crosses an F^k boundary', async () => {
    // N = 1045 -> cut0 = 1000, which is exactly an F^3 boundary; the segment
    // list changes shape here, and a naive per-tier reverse scrambles it.
    const log = await makeLog(1_045);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(spans(projection)).toEqual([[0, 1_000, 't3']]);
    expect(projection.recent).toHaveLength(45);

    // One step later the decomposition gains a tier-1 digit; the coarse block
    // must still come FIRST, not after the fine one.
    const log2 = await makeLog(1_055);
    const rollups2 = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log2, rollups2);
    const projection2 = await axProjectTrajectory({
      trajectoryId: log2.trajectoryId,
      store: log2.store,
      rollups: rollups2,
    });
    expect(spans(projection2)).toEqual([
      [0, 1_000, 't3'],
      [1_000, 1_010, 't1'],
    ]);
  });

  it('descends into a straddling coarse block and prints its built children', async () => {
    // startIndex lands at 450, so tier-2 block [400, 500) can never seal: its
    // first five children are pre-enable. Skipping the segment would drop the
    // five children that DO exist.
    const log = await makeLog(455);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await axBuildTrajectoryRollups({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
      summarizer: axDeterministicTrajectorySummarizer(),
    });
    const meta = await rollups.loadMeta(log.trajectoryId);
    expect(meta?.startIndex).toBe(450);

    for (let index = 0; index < 200; index += 1) {
      await log.store.append({
        trajectoryId: log.trajectoryId,
        type: 'thought',
        source: 'agent',
        data: { content: `later ${index}` },
      });
    }
    await buildAll(log, rollups, { backfill: false });
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    const ordered = spans(projection);
    // The straddling [400, 500) segment descended: its pre-enable half merges
    // with the pruned coarse prefix, and its five sealed children print. A
    // build that skipped the straddling segment would show [0, 500) instead
    // and lose all five.
    expect(ordered[0]).toEqual([0, 450, 'pre-enable']);
    expect(ordered.slice(1, 6)).toEqual([
      [450, 460, 't1'],
      [460, 470, 't1'],
      [470, 480, 't1'],
      [480, 490, 't1'],
      [490, 500, 't1'],
    ]);
    expect(projection.coverage.gaps).toEqual([{ from: 0, to: 450 }]);
  });

  it('reports a tier-1 miss as a gap instead of silently skipping it', async () => {
    const log = await makeLog(1_055);
    const inner = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, inner);
    const hiding = new HidingRollupStore(
      inner,
      new Set(['3:0', '2:100', '1:150'])
    );
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups: hiding,
    });
    const ordered = spans(projection);
    expect(ordered).toContainEqual([150, 160, 'missing']);
    expect(ordered).toContainEqual([140, 150, 't1']);
    expect(ordered).toContainEqual([160, 170, 't1']);
    expect(projection.coverage.gaps).toEqual([{ from: 150, to: 160 }]);
    // Every other tier-2 block under the hidden tier-3 root still prints.
    expect(ordered).toContainEqual([0, 100, 't2']);
  });

  it('prunes segments wholly before startIndex before descending', async () => {
    const log = await makeLog(505);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await axBuildTrajectoryRollups({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
      summarizer: axDeterministicTrajectorySummarizer(),
    });
    expect((await rollups.loadMeta(log.trajectoryId))?.startIndex).toBe(500);
    for (let index = 0; index < 300; index += 1) {
      await log.store.append({
        trajectoryId: log.trajectoryId,
        type: 'thought',
        source: 'agent',
        data: { content: `later ${index}` },
      });
    }
    await buildAll(log, rollups, { backfill: false });
    const counting = new HidingRollupStore(rollups);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups: counting,
    });
    expect(spans(projection)[0]).toEqual([0, 500, 'pre-enable']);
    // A descent that forked into the empty pre-enable tree would probe every
    // tier-1 node under [0, 500) -- fifty-five lookups for five segments.
    expect(counting.getBlockCalls.length).toBeLessThan(20);
    expect(counting.getBlockCalls).not.toContain('1:0');
  });

  it('still returns the raw tail when every rollup is deleted', async () => {
    const log = await makeLog(1_055);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    expect(rollups.deleteBlocks()).toBeGreaterThan(100);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(projection.recent).toHaveLength(45);
    expect(projection.recent.map((step) => step.stepId)).toEqual(
      log.narrative.slice(1_010)
    );
    expect(projection.coverage.gaps).toEqual([{ from: 0, to: 1_010 }]);
    expect(projection.life).toEqual([
      { kind: 'gap', start: 0, end: 1_010, reason: 'missing' },
    ]);
  });
});

describe('rollup sealing', () => {
  it('rejects a second put on a sealed key', async () => {
    const rollups = new AxInMemoryTrajectoryRollupStore();
    const block = {
      tier: 1,
      start: 0,
      end: 10,
      n: 10,
      summary: 's',
      themes: [],
      stepIds: [],
      summarizerId: 'x',
      promptVersion: '1',
      createdAt: 0,
    };
    await rollups.putBlock('t', block);
    await expect(rollups.putBlock('t', block)).rejects.toThrow(
      AxTrajectoryRollupError
    );
    await expect(rollups.putBlock('t', block)).rejects.toMatchObject({
      code: 'trajectory_rollup_invalid',
      reason: 'block_already_sealed',
    });
  });

  it('stamps every block with its summarizer id and prompt version', async () => {
    const log = await makeLog(120);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups, {
      summarizer: axDeterministicTrajectorySummarizer({
        id: 'stub-v9',
        promptVersion: '7',
      }),
    });
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    const blocks = summaries(projection);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.summarizerId).toBe('stub-v9');
      expect(block.promptVersion).toBe('7');
      expect(block.n).toBe(block.end - block.start);
      expect(block.createdAt).toBe(1_000);
    }
  });

  it('skips a failing block, counts it, and never fails the build', async () => {
    const log = await makeLog(120);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    let calls = 0;
    const flaky: AxTrajectorySummarizer = Object.freeze({
      id: 'flaky',
      promptVersion: '1',
      async summarize(request) {
        calls += 1;
        if (request.tier === 1 && request.start === 30) {
          throw new Error('summarizer down');
        }
        return { summary: `s${request.start}`, themes: [], stepIds: [] };
      },
    });
    const first = await axBuildTrajectoryRollups({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
      summarizer: flaky,
      backfill: true,
      maxBlocks: 128,
    });
    expect(first.failed).toBe(1);
    expect(first.sealed).toBeGreaterThan(5);
    expect(calls).toBeGreaterThan(1);
    // The checkpoint must NOT step over the block that failed, or it is never
    // retried and the gap is permanent.
    expect((await rollups.loadMeta(log.trajectoryId))?.sealedIndex).toBe(30);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(spans(projection)).toContainEqual([30, 40, 'missing']);

    const retry = await axBuildTrajectoryRollups({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
      summarizer: axDeterministicTrajectorySummarizer(),
      backfill: true,
      maxBlocks: 128,
    });
    expect(retry.sealed).toBeGreaterThan(0);
    expect(retry.failed).toBe(0);
    const healed = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(healed.coverage.gaps).toEqual([]);
  });

  it('is idempotent per summarizer and keeps a repeat build off the whole log', async () => {
    const log = await makeLog(600);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    const first = await buildAll(log, rollups);
    expect(first.sealed).toBeGreaterThan(0);

    let reads = 0;
    const counting = new Proxy(log.store, {
      get(target, property, receiver) {
        if (property === 'read') {
          return async (...args: readonly never[]) => {
            reads += 1;
            return (target.read as never as (...a: readonly never[]) => never)(
              ...args
            );
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const second = await axBuildTrajectoryRollups({
      trajectoryId: log.trajectoryId,
      store: counting,
      rollups,
      summarizer: axDeterministicTrajectorySummarizer(),
      backfill: true,
      maxBlocks: 128,
      scanPageSteps: 64,
    });
    expect(second.sealed).toBe(0);
    // 600 narrative steps sit in ~1800 raw seqs; a checkpoint-less rebuild
    // would page over all of them.
    expect(reads).toBeLessThan(4);
  });

  it('refuses a rollup meta built with a different fanout or type set', async () => {
    const log = await makeLog(60);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    await expect(
      axProjectTrajectory({
        trajectoryId: log.trajectoryId,
        store: log.store,
        rollups,
        fanout: 5,
      })
    ).rejects.toMatchObject({ reason: 'meta_conflict' });
    await expect(
      axProjectTrajectory({
        trajectoryId: log.trajectoryId,
        store: log.store,
        rollups,
        types: ['thought'],
      })
    ).rejects.toMatchObject({ reason: 'meta_conflict' });
  });
});

describe('drill-down', () => {
  it('resolves every cited step id, inside its own block range', async () => {
    const log = await makeLog(1_055);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    const index = new Map(log.narrative.map((stepId, at) => [stepId, at]));
    const blocks = summaries(projection);
    expect(blocks.length).toBeGreaterThan(0);
    let cited = 0;
    for (const block of blocks) {
      expect(block.stepIds.length).toBeGreaterThan(0);
      for (const stepId of block.stepIds) {
        const at = index.get(stepId);
        expect(at, `${stepId} is not a narrative step`).toBeDefined();
        expect(at).toBeGreaterThanOrEqual(block.start);
        expect(at).toBeLessThan(block.end);
        cited += 1;
      }
    }
    const resolved = await axResolveTrajectoryCitations(
      log.store,
      log.trajectoryId,
      projection.citableStepIds
    );
    expect(resolved).toHaveLength(projection.citableStepIds.length);
    expect(cited).toBeGreaterThan(10);
  });

  it('drops a citation the summarizer invented outside the block', async () => {
    const log = await makeLog(120);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    const liar: AxTrajectorySummarizer = Object.freeze({
      id: 'liar',
      promptVersion: '1',
      async summarize(request) {
        return {
          summary: 'everything, honestly',
          themes: ['all'],
          stepIds: [...request.inputs.map((i) => i.id), 'step-that-never-was'],
        };
      },
    });
    await buildAll(log, rollups, { summarizer: liar });
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(projection.citableStepIds).not.toContain('step-that-never-was');
    const resolved = await axResolveTrajectoryCitations(
      log.store,
      log.trajectoryId,
      projection.citableStepIds
    );
    // Coverage of 1.0 is worthless if the citations do not resolve.
    expect(resolved).toHaveLength(projection.citableStepIds.length);
  });

  it('chunks past the getSteps id ceiling and rehydrates spilled fields', async () => {
    const log = await makeLog(300, { big: 7 });
    const resolved = await axResolveTrajectoryCitations(
      log.store,
      log.trajectoryId,
      log.narrative
    );
    expect(resolved).toHaveLength(300);
    expect(resolved[7]?.data.content).toBe('X'.repeat(9_000));
    expect(resolved[7]?.blobs).toBeUndefined();
  });
});

describe('the renderer', () => {
  it('is a pure function of the projection', async () => {
    const log = await makeLog(1_055);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    await buildAll(log, rollups);
    const projection = await axProjectTrajectory({
      trajectoryId: log.trajectoryId,
      store: log.store,
      rollups,
    });
    expect(axRenderTrajectoryProjection(projection)).toBe(projection.render);
    expect(projection.render).toContain('# Life so far');
    expect(projection.render).toContain('# Recent (verbatim, oldest first)');
    expect(projection.estimatedTokens).toBeGreaterThan(0);
  });

  it('never reads a spillable field without going through the resolver', () => {
    // Invariant I7, lint-shaped: a truncated head that reaches a model reads
    // as testimony and is the 312 MB failure this subsystem exists to stop.
    for (const file of ['projection.ts', 'rollups.ts']) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        'utf8'
      );
      expect(source, `${file} must resolve before reading step data`).toContain(
        'axResolveTrajectorySteps'
      );
      expect(
        source,
        `${file} must not index step data positionally`
      ).not.toMatch(/step\.data\[/);
    }
    const source = readFileSync(
      fileURLToPath(new URL('projection.ts', import.meta.url)),
      'utf8'
    );
    // The one place data is read guards on the unresolved blob refs.
    expect(source).toMatch(
      /unresolved[\s\S]{0,400}Object\.entries\(step\.data\)/
    );
  });
});

describe('the summarizer is an ax program', () => {
  it('runs the rollup signature and maps its outputs onto a block', async () => {
    const seen: string[] = [];
    const ai = new AxMockAIService({
      features: { functions: false, streaming: false },
      chatResponse: async (request: unknown) => {
        seen.push(JSON.stringify(request));
        return {
          results: [
            {
              index: 0,
              content:
                'Life Summary: I read three files and fixed the parser.\nLife Themes: ["parser", "tests"]\nCited Step Ids: ["a", "zzz"]',
              finishReason: 'stop' as const,
            },
          ],
        };
      },
    });
    const summarizer = axTrajectoryProgramSummarizer({
      ai: ai as never,
      id: 'mock',
      promptVersion: '3',
    });
    expect(summarizer.id).toBe('mock');
    expect(summarizer.promptVersion).toBe('3');
    const result = await summarizer.summarize({
      tier: 1,
      start: 0,
      end: 10,
      inputs: [{ id: 'a', text: 'thought: content=hello' }],
    });
    expect(result.summary).toContain('fixed the parser');
    expect(result.themes).toEqual(['parser', 'tests']);
    expect(result.stepIds).toEqual(['a', 'zzz']);
    expect(seen.join('')).toContain('thought: content=hello');
  });

  it('drops the id the program invented when the block is sealed', async () => {
    const log = await makeLog(20);
    const rollups = new AxInMemoryTrajectoryRollupStore();
    const inventing: AxTrajectorySummarizer = Object.freeze({
      id: 'mock',
      promptVersion: '3',
      async summarize() {
        return { summary: 's', themes: [], stepIds: ['zzz'] };
      },
    });
    await buildAll(log, rollups, { summarizer: inventing });
    const block = await rollups.getBlock(log.trajectoryId, 1, 0);
    expect(block?.stepIds).not.toContain('zzz');
    expect(block?.stepIds).toHaveLength(10);
  });
});
