import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AxInMemoryTrajectoryStore,
  AxManualEventClock,
  type AxTrajectoryStoreConformanceInstance,
  axResolveTrajectoryStep,
  runAxTrajectoryStoreConformance,
} from '@ax-llm/ax';
import { afterEach, describe, expect, it } from 'vitest';

import { AxJSONLTrajectoryStore } from './jsonl.js';

/**
 * Pinned in src/ax/trajectory/conformance.test.ts too. Both stores must report
 * this number: a different count means one implementation quietly skipped part
 * of the contract, which is the whole point of shipping the kit.
 */
const CONFORMANCE_ASSERTIONS = 78;

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ax-trajectory-jsonl-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function newStore(directory: string, clock: AxManualEventClock) {
  return new AxJSONLTrajectoryStore({ directory, clock, fsync: false });
}

describe('AxJSONLTrajectoryStore conformance', () => {
  it('passes the shared kit with the same assertion count as the reference store', async () => {
    const clock = new AxManualEventClock(1_000);
    const base = root();
    const stores = new Map<string, AxJSONLTrajectoryStore>();

    const fileReport = await runAxTrajectoryStoreConformance(
      ({ databaseKey }) => {
        // Same databaseKey means the same directory, so the kit's reopen case
        // exercises a genuinely second store instance over the same bytes.
        let store = stores.get(databaseKey);
        if (!store) {
          store = newStore(join(base, databaseKey), clock);
          stores.set(databaseKey, store);
        }
        const bound = store;
        return {
          store: bound,
          failNextBlobWrite: () => bound.failNextBlobWrite(),
          corruptTrailingFrame: (trajectoryId: string) =>
            bound.injectCorruptTrailingFrame(trajectoryId),
        } satisfies AxTrajectoryStoreConformanceInstance;
      },
      { clock }
    );

    expect(fileReport.assertions).toBe(CONFORMANCE_ASSERTIONS);
    expect(fileReport.capability.durability).toBe('persistent');
    expect(fileReport.capability.conformance?.schemaVersion).toBe(1);

    // The identical kit against the volatile reference store must agree.
    const memoryClock = new AxManualEventClock(1_000);
    const memoryStores = new Map<string, AxInMemoryTrajectoryStore>();
    const memoryReport = await runAxTrajectoryStoreConformance(
      ({ databaseKey }) => {
        let store = memoryStores.get(databaseKey);
        if (!store) {
          store = new AxInMemoryTrajectoryStore({ clock: memoryClock });
          memoryStores.set(databaseKey, store);
        }
        const bound = store;
        return {
          store: bound,
          failNextBlobWrite: () => bound.failNextBlobWrite(),
          corruptTrailingFrame: (trajectoryId: string) =>
            bound.injectCorruptTrailingFrame(trajectoryId),
        } satisfies AxTrajectoryStoreConformanceInstance;
      },
      { clock: memoryClock }
    );

    expect(fileReport.assertions).toBe(memoryReport.assertions);
  });
});

describe('AxJSONLTrajectoryStore on-disk contract', () => {
  it('writes one newline-terminated JSON line per step', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({ slug: 'life' });
    await store.append({ trajectoryId, type: 'thought', source: 'monolith' });
    await store.append({ trajectoryId, type: 'run', data: { command: 'ls' } });

    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const [index, line] of lines.entries()) {
      const parsed = JSON.parse(line);
      expect(parsed.seq).toBe(index);
      expect(parsed.trajectoryId).toBe(trajectoryId);
      // jq-friendly camelCase, no snake_case anywhere on the wire.
      expect(Object.keys(parsed).some((key) => key.includes('_'))).toBe(false);
    }
  });

  it('reopens from disk and resumes a byte-offset cursor', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const first = newStore(directory, clock);
    const { trajectoryId } = await first.create({});
    for (let index = 0; index < 6; index++) {
      await first.append({ trajectoryId, type: 'run', data: { index } });
    }
    const drained = await first.readFrom(undefined, trajectoryId, {
      maxSteps: 4,
    });
    await first.saveCursor('drainer', drained.cursor);
    first.close();

    const second = newStore(directory, clock);
    expect(second.listTrajectories()).toEqual([trajectoryId]);
    const cursor = await second.loadCursor('drainer', trajectoryId);
    expect(cursor?.seq).toBe(4);
    // The token carries a real byte offset into steps.jsonl.
    const offset = Number(cursor!.token!.split(':').pop());
    const size = readFileSync(
      join(directory, encodeURIComponent(trajectoryId), 'steps.jsonl'),
      'utf8'
    ).length;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(size);

    const resumed = await second.readFrom(cursor, trajectoryId, {});
    expect(resumed.steps.map((step) => step.seq)).toEqual([4, 5, 6]);
    expect(resumed.caughtUp).toBe(true);
    expect(resumed.corrupt).toBe(0);
  });

  it('drops a torn trailing frame, counts it, and never glues it on', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    const intact = await store.append({
      trajectoryId,
      type: 'run',
      data: { intact: true },
    });

    // A real power loss mid-write: a prefix of a line with no newline.
    appendFileSync(
      join(directory, encodeURIComponent(trajectoryId), 'steps.jsonl'),
      '{"stepId":"torn","trajectoryId":"'
    );

    const reopened = newStore(directory, clock);
    const drained = await reopened.readFrom(undefined, trajectoryId, {});
    expect(drained.corrupt).toBe(1);
    expect(drained.steps).toHaveLength(2);
    expect(drained.steps[1]?.stepId).toBe(intact.stepId);
    expect(await reopened.getStep(trajectoryId, 'torn')).toBeUndefined();
    expect((await reopened.stats(trajectoryId))?.newestStepId).toBe(
      intact.stepId
    );
  });

  it('drops an interior frame it cannot parse without losing the rest', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    await store.append({ trajectoryId, type: 'run', data: { index: 0 } });
    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    appendFileSync(path, '{ not json at all\n');
    const after = newStore(directory, clock);
    await after.append({ trajectoryId, type: 'run', data: { index: 1 } });

    const drained = await after.readFrom(undefined, trajectoryId, {});
    expect(drained.corrupt).toBe(1);
    expect(drained.steps.map((step) => step.data.index)).toEqual([
      undefined,
      0,
      1,
    ]);
    // seq stays dense after recovery, which is what cursors depend on.
    expect(drained.steps.map((step) => step.seq)).toEqual([0, 1, 2]);
  });

  it('keeps spilled blobs in their own directory and rehydrates them', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    const big = 'q'.repeat(20_000);
    const receipt = await store.append({
      trajectoryId,
      type: 'runtime-output',
      data: { stdout: big, stderr: 'small' },
    });

    expect(receipt.spilled).toEqual(['stdout']);
    const blobFiles = readdirSync(join(directory, 'blobs'));
    expect(blobFiles).toHaveLength(1);

    const step = (await store.getStep(trajectoryId, receipt.stepId))!;
    expect((step.data.stdout as string).length).toBeLessThan(big.length);
    const resolved = await axResolveTrajectoryStep(step, store.blobs);
    expect(resolved.data.stdout).toBe(big);
    expect(resolved.data.stderr).toBe('small');

    // Survives a reopen: the ref and digest live in the step line.
    const reopened = newStore(directory, clock);
    const again = (await reopened.getStep(trajectoryId, receipt.stepId))!;
    expect(
      (await axResolveTrajectoryStep(again, reopened.blobs)).data.stdout
    ).toBe(big);
  });

  it('leaves no step behind when the blob write fails', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    store.failNextBlobWrite();

    await expect(
      store.append({
        trajectoryId,
        stepId: 'probe',
        type: 'runtime-output',
        data: { stdout: 'w'.repeat(20_000) },
      })
    ).rejects.toMatchObject({ reason: 'blob_write_failed', phase: 'blob' });

    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    expect(readFileSync(path, 'utf8')).not.toContain('probe');
    expect(await store.getStep(trajectoryId, 'probe')).toBeUndefined();
    expect(existsSync(join(directory, 'blobs'))).toBe(true);
    expect(readdirSync(join(directory, 'blobs'))).toEqual([]);
  });

  it('reports a shrunken log rather than reading past its end', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    for (let index = 0; index < 4; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
    }
    const drained = await store.readFrom(undefined, trajectoryId, {});
    const beyond = {
      ...drained.cursor,
      token: `${drained.cursor.token!.split(':')[0]}:999999`,
    };

    await expect(
      store.readFrom(beyond, trajectoryId, {})
    ).rejects.toMatchObject({
      name: 'AxTrajectoryCursorError',
      reason: 'shrank',
    });
  });

  it('keeps per-consumer cursors in separate durable files', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    for (let index = 0; index < 4; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
    }
    await store.saveCursor('reader-a', { trajectoryId, seq: 3 });
    await store.saveCursor('reader-b', { trajectoryId, seq: 1 });

    const files = readdirSync(join(directory, 'cursors')).sort();
    expect(files).toHaveLength(2);
    const reopened = newStore(directory, clock);
    expect((await reopened.loadCursor('reader-a', trajectoryId))?.seq).toBe(3);
    expect((await reopened.loadCursor('reader-b', trajectoryId))?.seq).toBe(1);
    expect(await reopened.loadCursor('reader-c', trajectoryId)).toBeUndefined();
  });

  it('rejects source on a machinery step and an unknown trajectory', async () => {
    const clock = new AxManualEventClock(5_000);
    const store = newStore(root(), clock);
    const { trajectoryId } = await store.create({});
    await expect(
      store.append({ trajectoryId, type: 'mind-wake', source: 'thinker' })
    ).rejects.toMatchObject({ reason: 'source_on_machinery_step' });
    await expect(
      store.append({ trajectoryId: 'ghost', type: 'run' })
    ).rejects.toMatchObject({ reason: 'unknown_trajectory' });
    expect(await store.getTrajectory('ghost')).toBeUndefined();
    expect(await store.stats('ghost')).toBeUndefined();
  });

  it('materializes only the frames a bounded read returns', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    for (let index = 0; index < 200; index++) {
      await store.append({
        trajectoryId,
        type: index % 50 === 0 ? 'message' : 'run',
        ...(index % 50 === 0 ? { source: 'human' } : {}),
        data: { index },
      });
    }
    store.close();

    const reopened = newStore(directory, clock);
    // Opening indexes every line and keeps none of them.
    expect(await reopened.stats(trajectoryId)).toMatchObject({
      stepCount: 201,
    });
    expect(reopened.framesResolved).toBe(0);

    const tail = await reopened.tailBackward({
      trajectoryId,
      limit: 2,
      types: ['message'],
      maxScan: 400,
    });
    expect(tail.steps).toHaveLength(2);
    expect(tail.scanned).toBeGreaterThanOrEqual(100);
    // Scanning 100 machinery frames materialized only the two returned:
    // the filter runs on the index, not on parsed steps.
    expect(reopened.framesResolved).toBe(2);

    // Counter-metric: a full replay genuinely does materialize everything, so
    // the bounded number above is not a counter that never moves.
    const replay = await reopened.read({
      trajectoryId,
      fromSeq: 0,
      toSeq: 201,
    });
    expect(replay).toHaveLength(201);
    expect(reopened.framesResolved).toBe(203);
  });

  it('reads a step from disk rather than from a materialized log', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    const receipt = await store.append({
      trajectoryId,
      type: 'run',
      data: { tag: 'aaaa' },
    });
    expect((await store.getStep(trajectoryId, receipt.stepId))?.data.tag).toBe(
      'aaaa'
    );

    // Same byte length, so every frame offset is unchanged: a store holding
    // the parsed log in memory would keep answering 'aaaa'.
    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    writeFileSync(path, readFileSync(path, 'utf8').replace('aaaa', 'bbbb'));
    expect((await store.getStep(trajectoryId, receipt.stepId))?.data.tag).toBe(
      'bbbb'
    );
  });

  it('records fork and merge in both directions across reopen', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    const forked = await store.fork({ parentTrajectoryId: trajectoryId });
    const merged = await store.merge({
      parentTrajectoryId: trajectoryId,
      childTrajectoryId: forked.childTrajectoryId,
      content: '(stalled: no progress)',
      outcome: 'failed',
    });
    store.close();

    const reopened = newStore(directory, clock);
    const forkStep = await reopened.getStep(trajectoryId, forked.forkStepId);
    expect(forkStep?.data.childTrajectoryId).toBe(forked.childTrajectoryId);
    const child = await reopened.getTrajectory(forked.childTrajectoryId);
    expect(child?.parentStepId).toBe(forked.forkStepId);
    expect(child?.depth).toBe(1);
    const mergeStep = await reopened.getStep(trajectoryId, merged.stepId);
    expect(mergeStep?.data.outcome).toBe('failed');
    expect(mergeStep?.source).toBeUndefined();
  });
});
