import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryTrajectoryStore } from './memoryStore.js';
import type { AxTrajectoryStore } from './types.js';

const NOW = 10_000;

function newStore(
  options?: ConstructorParameters<typeof AxInMemoryTrajectoryStore>[0]
) {
  const clock = new AxManualEventClock(NOW);
  const store = new AxInMemoryTrajectoryStore({ clock, ...options });
  return { store, clock };
}

async function seeded() {
  const { store, clock } = newStore();
  const header = await store.create({ slug: 'life' });
  return { store, clock, trajectoryId: header.trajectoryId };
}

describe('AxInMemoryTrajectoryStore append', () => {
  it('assigns dense monotonic seq under 200 concurrent appends', async () => {
    const { store, trajectoryId } = await seeded();

    const receipts = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        store.append({
          trajectoryId,
          type: 'thought',
          source: 'monolith',
          data: { index },
        })
      )
    );

    // create() writes the header step at seq 0, so user appends run 1..200.
    const assigned = receipts.map((r) => r.seq).sort((a, b) => a - b);
    expect(assigned).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(new Set(receipts.map((r) => r.stepId)).size).toBe(200);

    const stats = await store.stats(trajectoryId);
    expect(stats?.stepCount).toBe(201);
    expect(stats?.newestSeq).toBe(200);
    const all = await store.read({ trajectoryId, fromSeq: 0, toSeq: 201 });
    expect(all.map((step) => step.seq)).toEqual(
      Array.from({ length: 201 }, (_, i) => i)
    );
  });

  it('preserves a caller-preset stepId', async () => {
    const { store, trajectoryId } = await seeded();
    const receipt = await store.append({
      trajectoryId,
      stepId: 'preset-1',
      type: 'action',
      source: 'monolith',
    });
    expect(receipt.stepId).toBe('preset-1');
    expect((await store.getStep(trajectoryId, 'preset-1'))?.type).toBe(
      'action'
    );
  });

  it('treats an identical preset replay as a duplicate and a divergent one as a collision', async () => {
    const { store, trajectoryId } = await seeded();
    const request = {
      trajectoryId,
      stepId: 'preset-1',
      type: 'action',
      source: 'monolith',
      data: { note: 'a' },
    } as const;

    const first = await store.append(request);
    const replay = await store.append(request);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.seq).toBe(first.seq);
    // The replay must not have appended a second step.
    expect((await store.stats(trajectoryId))?.stepCount).toBe(2);

    await expect(
      store.append({ ...request, data: { note: 'b' } })
    ).rejects.toMatchObject({
      name: 'AxTrajectoryAppendError',
      reason: 'duplicate_step_id',
      phase: 'validate',
    });
  });

  it('stamps ts from the injected clock, never Date.now', async () => {
    const { store, clock, trajectoryId } = await seeded();
    const first = await store.append({
      trajectoryId,
      type: 'thought',
      source: 'm',
    });
    clock.advanceBy(5_000);
    const second = await store.append({
      trajectoryId,
      type: 'thought',
      source: 'm',
    });

    expect(first.ts).toBe(NOW);
    expect(second.ts).toBe(NOW + 5_000);
    expect(second.ts).toBeLessThan(Date.now());
  });

  it('rejects a non-finite caller timestamp', async () => {
    const { store, trajectoryId } = await seeded();
    await expect(
      store.append({
        trajectoryId,
        type: 'thought',
        source: 'm',
        ts: Number.NaN,
      })
    ).rejects.toMatchObject({ reason: 'invalid_field' });
  });

  it('rejects source on a machinery step type', async () => {
    const { store, trajectoryId } = await seeded();
    await expect(
      store.append({ trajectoryId, type: 'reply-claim', source: 'monolith' })
    ).rejects.toMatchObject({
      reason: 'source_on_machinery_step',
      phase: 'validate',
    });
    // And the rejected step never became visible.
    expect((await store.stats(trajectoryId))?.stepCount).toBe(1);
  });

  it('accepts an unregistered type and round-trips it unchanged', async () => {
    const { store, trajectoryId } = await seeded();
    const receipt = await store.append({
      trajectoryId,
      type: 'host.custom',
      source: 'host',
      data: { shape: { nested: [1, 'two', true, null] } },
    });
    const step = await store.getStep(trajectoryId, receipt.stepId);
    expect(step?.type).toBe('host.custom');
    expect(step?.data.shape).toEqual({ nested: [1, 'two', true, null] });
  });

  it('rejects a field value that cannot be persisted', async () => {
    const { store, trajectoryId } = await seeded();
    await expect(
      store.append({
        trajectoryId,
        type: 'thought',
        source: 'm',
        data: { bad: Number.POSITIVE_INFINITY },
      })
    ).rejects.toMatchObject({ reason: 'invalid_field' });
  });

  it('makes no step visible when the blob write fails', async () => {
    const { store, trajectoryId } = await newStoreWithTrajectory();
    const before = await store.stats(trajectoryId);
    store.failNextBlobWrite();

    await expect(
      store.append({
        trajectoryId,
        type: 'action',
        source: 'm',
        data: { content: 'x'.repeat(8_000) },
      })
    ).rejects.toMatchObject({
      reason: 'blob_write_failed',
      phase: 'blob',
    });

    // I2: blobs are durable before the step, so a failed blob leaves nothing.
    expect((await store.stats(trajectoryId))?.stepCount).toBe(
      before?.stepCount
    );
  });

  it('rejects an append to an unknown trajectory', async () => {
    const { store } = newStore();
    await expect(
      store.append({ trajectoryId: 'nope', type: 'thought', source: 'm' })
    ).rejects.toMatchObject({ reason: 'unknown_trajectory' });
  });

  it('freezes an appended step so a reader cannot rewrite the log', async () => {
    const { store, trajectoryId } = await seeded();
    const receipt = await store.append({
      trajectoryId,
      type: 'message',
      source: 'human',
      data: { content: 'original', nested: { deep: 1 } },
    });
    const step = (await store.getStep(trajectoryId, receipt.stepId))!;

    expect(Object.isFrozen(step)).toBe(true);
    expect(Object.isFrozen(step.data)).toBe(true);
    expect(Object.isFrozen(step.data.nested)).toBe(true);
    // `source` is the authority field: M2's self-trigger suppression keys on
    // it, so a reader that can relabel a step in place can make machinery
    // read as a thinker for every later reader in the process.
    expect(() => {
      (step as { source?: string }).source = 'impostor';
    }).toThrow(TypeError);
    expect(() => {
      (step.data as Record<string, unknown>).content = 'REWRITTEN';
    }).toThrow(TypeError);

    const again = (await store.getStep(trajectoryId, receipt.stepId))!;
    expect(again.source).toBe('human');
    expect(again.data.content).toBe('original');
  });
});

async function newStoreWithTrajectory() {
  const { store, clock } = newStore();
  const header = await store.create({});
  return { store, clock, trajectoryId: header.trajectoryId };
}

describe('AxInMemoryTrajectoryStore reads', () => {
  it('groups interleaved runs by runId, never by position', async () => {
    const { store, trajectoryId } = await seeded();
    const runA = 'run-a';
    const runB = 'run-b';
    // Deliberately interleaved: position-based grouping would split these.
    for (const runId of [runA, runB, runA, runB, runA]) {
      await store.append({
        trajectoryId,
        type: 'action',
        source: 'm',
        runId,
        data: { runId },
      });
    }

    const steps = await store.read({ trajectoryId, fromSeq: 0, toSeq: 100 });
    const byRun = (id: string) => steps.filter((step) => step.runId === id);
    expect(byRun(runA)).toHaveLength(3);
    expect(byRun(runB)).toHaveLength(2);
    // Positions of run A are non-contiguous, which is the whole point.
    expect(byRun(runA).map((step) => step.seq)).toEqual([1, 3, 5]);
  });

  it('rejects an unbounded read', async () => {
    const { store, trajectoryId } = await seeded();
    await expect(store.read({ trajectoryId })).rejects.toMatchObject({
      name: 'AxTrajectoryQueryError',
      reason: 'unbounded_read',
    });
    await expect(
      store.read({ trajectoryId, fromSeq: 0 })
    ).rejects.toMatchObject({ reason: 'unbounded_read' });
    // A limit alone, or a full range, is bounded and therefore fine.
    await expect(store.read({ trajectoryId, limit: 1 })).resolves.toHaveLength(
      1
    );
  });

  it('filters a read by type and by step class', async () => {
    const { store, trajectoryId } = await seeded();
    await store.append({ trajectoryId, type: 'thought', source: 'm' });
    await store.append({ trajectoryId, type: 'run' });
    await store.append({ trajectoryId, type: 'message', source: 'human' });

    const narrative = await store.read({
      trajectoryId,
      classes: ['narrative'],
      limit: 10,
    });
    expect(narrative.map((step) => step.type)).toEqual(['thought', 'message']);
    const runs = await store.read({ trajectoryId, types: ['run'], limit: 10 });
    expect(runs).toHaveLength(1);
  });

  it('tailBackward returns oldest-first and reports scanned/exhausted', async () => {
    const { store, trajectoryId } = await seeded();
    // 90% machinery, which is exactly the case a raw line window fails on.
    for (let index = 0; index < 50; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
      if (index % 10 === 0) {
        await store.append({
          trajectoryId,
          type: 'message',
          source: 'human',
          data: { index },
        });
      }
    }

    const tail = await store.tailBackward({
      trajectoryId,
      limit: 3,
      types: ['message'],
    });
    expect(tail.steps.map((step) => step.data.index)).toEqual([20, 30, 40]);
    expect(tail.steps.map((step) => step.seq)).toEqual(
      [...tail.steps].map((step) => step.seq).sort((a, b) => a - b)
    );
    expect(tail.scanned).toBeGreaterThan(3);
    expect(tail.exhausted).toBe(false);
  });

  it('tailBackward stops at maxScan and reports exhausted false', async () => {
    const { store, trajectoryId } = await seeded();
    for (let index = 0; index < 100; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
    }

    const tail = await store.tailBackward({
      trajectoryId,
      limit: 5,
      types: ['message'],
      maxScan: 10,
    });
    expect(tail.steps).toEqual([]);
    expect(tail.scanned).toBe(10);
    // Budget spent, not "no more matches" — the distinction is the deliverable.
    expect(tail.exhausted).toBe(false);

    const full = await store.tailBackward({
      trajectoryId,
      limit: 5,
      types: ['message'],
      maxScan: 1_000,
    });
    expect(full.exhausted).toBe(true);
  });

  it('tailBackward honours beforeSeq as an exclusive upper bound', async () => {
    const { store, trajectoryId } = await seeded();
    for (let index = 0; index < 10; index++) {
      await store.append({
        trajectoryId,
        type: 'action',
        source: 'm',
        data: { index },
      });
    }
    const tail = await store.tailBackward({
      trajectoryId,
      limit: 2,
      types: ['action'],
      beforeSeq: 5,
    });
    expect(tail.steps.map((step) => step.seq)).toEqual([3, 4]);
  });

  it('getSteps returns the requested ids and rejects over the id cap', async () => {
    const { store, trajectoryId } = await seeded();
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      ids.push((await store.append({ trajectoryId, type: 'run' })).stepId);
    }

    const picked = await store.getSteps(trajectoryId, [ids[3]!, ids[0]!]);
    expect(picked.map((step) => step.stepId)).toEqual([ids[3], ids[0]]);
    // Unknown ids yield a short array rather than holes.
    expect(await store.getSteps(trajectoryId, ['nope'])).toEqual([]);
    expect(await store.getStep(trajectoryId, 'nope')).toBeUndefined();

    await expect(
      store.getSteps(
        trajectoryId,
        Array.from({ length: 257 }, (_, i) => `id-${i}`)
      )
    ).rejects.toMatchObject({ reason: 'too_many_ids' });
  });
});

describe('AxInMemoryTrajectoryStore cursors', () => {
  it('readFrom resumes exactly at the cursor with no replay and no gap', async () => {
    const { store, trajectoryId } = await seeded();
    for (let index = 0; index < 10; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
    }

    const first = await store.readFrom(undefined, trajectoryId, {
      maxSteps: 4,
    });
    expect(first.steps.map((step) => step.seq)).toEqual([0, 1, 2, 3]);
    expect(first.caughtUp).toBe(false);
    expect(first.corrupt).toBe(0);

    const second = await store.readFrom(first.cursor, trajectoryId, {
      maxSteps: 4,
    });
    expect(second.steps.map((step) => step.seq)).toEqual([4, 5, 6, 7]);

    const third = await store.readFrom(second.cursor, trajectoryId, {
      maxSteps: 100,
    });
    expect(third.steps.map((step) => step.seq)).toEqual([8, 9, 10]);
    expect(third.caughtUp).toBe(true);

    const empty = await store.readFrom(third.cursor, trajectoryId, {});
    expect(empty.steps).toEqual([]);
    expect(empty.caughtUp).toBe(true);
  });

  it('readFrom honours a byte budget but always returns at least one step', async () => {
    const { store, trajectoryId } = await seeded();
    for (let index = 0; index < 5; index++) {
      await store.append({
        trajectoryId,
        type: 'run',
        data: { padding: 'y'.repeat(500) },
      });
    }
    const drained = await store.readFrom(undefined, trajectoryId, {
      maxBytes: 700,
    });
    expect(drained.steps.length).toBeGreaterThanOrEqual(1);
    expect(drained.steps.length).toBeLessThan(6);
    expect(drained.caughtUp).toBe(false);
  });

  it("readFrom rejects a cursor beyond end with reason 'beyond_end'", async () => {
    const { store, trajectoryId } = await seeded();
    await expect(
      store.readFrom({ trajectoryId, seq: 99 }, trajectoryId, {})
    ).rejects.toMatchObject({
      name: 'AxTrajectoryCursorError',
      reason: 'beyond_end',
    });
  });

  it('readFrom rejects a cursor whose trajectory identity changed', async () => {
    const { store, trajectoryId } = await seeded();
    const drained = await store.readFrom(undefined, trajectoryId, {});

    await expect(
      store.readFrom(
        { ...drained.cursor, token: 'inst-someone-else:0' },
        trajectoryId,
        {}
      )
    ).rejects.toMatchObject({ reason: 'identity_changed' });

    await expect(
      store.readFrom({ trajectoryId: 'other', seq: 0 }, trajectoryId, {})
    ).rejects.toMatchObject({ reason: 'identity_changed' });
  });

  it('counts an injected torn trailing frame without ever returning it', async () => {
    const { store, trajectoryId } = await seeded();
    await store.append({ trajectoryId, type: 'run' });
    store.injectCorruptTrailingFrame(trajectoryId);

    const drained = await store.readFrom(undefined, trajectoryId, {});
    expect(drained.steps).toHaveLength(2);
    expect(drained.corrupt).toBe(1);
    // The torn frame is dropped, never glued onto the record before it.
    expect(drained.steps[1]?.type).toBe('run');
  });

  it('keeps per-consumer cursors independent', async () => {
    const { store, trajectoryId } = await seeded();
    for (let index = 0; index < 6; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
    }

    const fast = await store.readFrom(undefined, trajectoryId, { maxSteps: 5 });
    await store.saveCursor('fast', fast.cursor);
    await store.saveCursor('slow', { trajectoryId, seq: 1 });

    // A deferral on one consumer must never cost another its position (M4).
    expect((await store.loadCursor('fast', trajectoryId))?.seq).toBe(5);
    expect((await store.loadCursor('slow', trajectoryId))?.seq).toBe(1);
    expect(await store.loadCursor('third', trajectoryId)).toBeUndefined();

    const slowDrain = await store.readFrom(
      await store.loadCursor('slow', trajectoryId),
      trajectoryId,
      {}
    );
    expect(slowDrain.steps[0]?.seq).toBe(1);
    expect((await store.loadCursor('fast', trajectoryId))?.seq).toBe(5);
  });
});

describe('AxInMemoryTrajectoryStore fork and merge', () => {
  it('fork writes both directions and merge always carries an outcome', async () => {
    const { store, trajectoryId } = await seeded();
    const forked = await store.fork({ parentTrajectoryId: trajectoryId });

    const forkStep = await store.getStep(trajectoryId, forked.forkStepId);
    expect(forkStep?.type).toBe('fork');
    expect(forkStep?.data.childTrajectoryId).toBe(forked.childTrajectoryId);
    expect(forkStep?.source).toBeUndefined();

    const child = await store.getTrajectory(forked.childTrajectoryId);
    expect(child?.parentTrajectoryId).toBe(trajectoryId);
    expect(child?.parentStepId).toBe(forked.forkStepId);
    expect(child?.depth).toBe(1);

    const receipt = await store.merge({
      parentTrajectoryId: trajectoryId,
      childTrajectoryId: forked.childTrajectoryId,
      content: 'done',
      outcome: 'succeeded',
    });
    const mergeStep = await store.getStep(trajectoryId, receipt.stepId);
    expect(mergeStep?.type).toBe('merge');
    expect(mergeStep?.data.outcome).toBe('succeeded');
    expect(mergeStep?.data.content).toBe('done');
    expect(mergeStep?.source).toBeUndefined();

    // The child records the merge back too, so neither side needs a search.
    const childMerges = await store.read({
      trajectoryId: forked.childTrajectoryId,
      types: ['merge'],
      limit: 5,
    });
    expect(childMerges[0]?.data.parentStepId).toBe(receipt.stepId);
  });

  it('merge records a failed sub-run', async () => {
    const { store, trajectoryId } = await seeded();
    const forked = await store.fork({ parentTrajectoryId: trajectoryId });
    const receipt = await store.merge({
      parentTrajectoryId: trajectoryId,
      childTrajectoryId: forked.childTrajectoryId,
      content: '(max turns reached)',
      outcome: 'failed',
    });
    const step = await store.getStep(trajectoryId, receipt.stepId);
    expect(step?.data.outcome).toBe('failed');
    expect(step?.data.content).toBe('(max turns reached)');
  });

  it('rejects a fork past maxDepth and a fork of an unknown parent', async () => {
    const { store, trajectoryId } = await seeded();
    await expect(
      store.fork({ parentTrajectoryId: trajectoryId, maxDepth: 0 })
    ).rejects.toMatchObject({
      name: 'AxTrajectoryForkError',
      reason: 'depth_exceeded',
    });
    await expect(
      store.fork({ parentTrajectoryId: 'nope' })
    ).rejects.toMatchObject({ reason: 'unknown_parent' });
  });
});

describe('AxInMemoryTrajectoryStore signals and shape', () => {
  it('leaves no abort listeners after 25 resolved reads', async () => {
    const { store, trajectoryId } = await seeded();
    const controller = new AbortController();
    const { signal } = controller;

    for (let index = 0; index < 25; index++) {
      await store.append(
        { trajectoryId, type: 'run', data: { index } },
        signal
      );
      const drained = await store.readFrom(undefined, trajectoryId, {}, signal);
      expect(drained.steps.length).toBe(index + 2);
      await store.tailBackward({ trajectoryId, limit: 1 }, signal);
    }

    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('rejects on an already-aborted signal and leaves no listener', async () => {
    const { store, trajectoryId } = await seeded();
    const controller = new AbortController();
    const reason = new Error('shutting down');
    controller.abort(reason);

    await expect(
      store.append({ trajectoryId, type: 'run' }, controller.signal)
    ).rejects.toBe(reason);
    await expect(
      store.readFrom(undefined, trajectoryId, {}, controller.signal)
    ).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  });

  it('exposes no update or delete method on the port', async () => {
    const { store } = newStore();
    const port: AxTrajectoryStore = store;
    const surface = port as unknown as Record<string, unknown>;
    for (const name of ['update', 'delete', 'remove', 'truncate', 'setStep']) {
      expect(surface[name], name).toBeUndefined();
    }
    // Immutability is structural: nothing on the port can rewrite a step.
    expect(
      Object.getOwnPropertyNames(AxInMemoryTrajectoryStore.prototype).filter(
        (name) => /^(update|delete|remove|truncate)/.test(name)
      )
    ).toEqual([]);
  });

  it('declares volatile capabilities and a conformance schema version', async () => {
    const { store } = newStore();
    expect(store.capabilities.durability).toBe('volatile');
    expect(store.capabilities.coordination).toBe('single-writer');
    expect(store.capabilities.appendAtomicity).toBe(true);
    expect(store.capabilities.conformance?.schemaVersion).toBe(1);
    expect(store.capabilities.conformance?.multiWriter).toBeUndefined();
  });

  it('enforces maxSteps by rejecting rather than evicting', async () => {
    const { store } = newStore({ maxSteps: 3 });
    const header = await store.create({});
    await store.append({ trajectoryId: header.trajectoryId, type: 'run' });
    await store.append({ trajectoryId: header.trajectoryId, type: 'run' });
    await expect(
      store.append({ trajectoryId: header.trajectoryId, type: 'run' })
    ).rejects.toMatchObject({ reason: 'store_failure' });
    // Nothing was evicted: I1 forbids it, so the bound must reject instead.
    expect((await store.stats(header.trajectoryId))?.stepCount).toBe(3);
  });
});
