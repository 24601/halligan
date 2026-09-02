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
const CONFORMANCE_ASSERTIONS = 81;

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
    const fileReport = await runAxTrajectoryStoreConformance(
      ({ databaseKey }) => {
        // Same databaseKey means the same directory and a NEW instance, so
        // the kit's reopen cases -- a cursor token and a consumer cursor
        // surviving -- exercise a genuinely second store over the same bytes.
        const bound = newStore(join(base, databaseKey), clock);
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

  it('resumes a durable cursor at the right record after an interior drop', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    const written: string[] = [];
    for (let index = 0; index < 6; index++) {
      const receipt = await store.append({
        trajectoryId,
        type: 'run',
        data: { index },
      });
      written.push(receipt.stepId);
    }
    const drained = await store.readFrom(undefined, trajectoryId, {
      maxSteps: 4,
    });
    await store.saveCursor('drainer', drained.cursor);
    store.close();

    // A record the consumer had ALREADY processed becomes unreadable, with
    // its byte length preserved so every later frame keeps its offset. The
    // tolerant parse drops it, which renumbers every following seq down by
    // one: `seq` alone is not a durable position.
    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[1] = 'x'.repeat(lines[1]!.length);
    writeFileSync(path, lines.join('\n'));

    const reopened = newStore(directory, clock);
    const cursor = await reopened.loadCursor('drainer', trajectoryId);
    expect(cursor?.seq).toBe(4);
    const resumed = await reopened.readFrom(cursor, trajectoryId, {});
    // Positioning from cursor.seq would have started one record too far and
    // silently never delivered a committed step. C14 must not fail open.
    expect(resumed.steps.map((step) => step.stepId)).toEqual(written.slice(3));
    expect(resumed.corrupt).toBe(1);
  });

  it('rejects a durable cursor no longer on a frame boundary', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    for (let index = 0; index < 6; index++) {
      await store.append({ trajectoryId, type: 'run', data: { index } });
    }
    const drained = await store.readFrom(undefined, trajectoryId, {
      maxSteps: 4,
    });
    await store.saveCursor('drainer', drained.cursor);
    store.close();

    // Same drop, but the replacement is a different length, so every later
    // frame moved and the saved offset now points into the middle of one.
    // There is no safe record to resume at, so C14 fails closed and loudly.
    const path = join(
      directory,
      encodeURIComponent(trajectoryId),
      'steps.jsonl'
    );
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[1] = '{"broken":true}';
    writeFileSync(path, lines.join('\n'));

    const reopened = newStore(directory, clock);
    const cursor = await reopened.loadCursor('drainer', trajectoryId);
    await expect(
      reopened.readFrom(cursor, trajectoryId, {})
    ).rejects.toMatchObject({
      name: 'AxTrajectoryCursorError',
      reason: 'not_a_frame_boundary',
    });
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

  it('never rewrites a blob a committed step already references', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    const big = 'q'.repeat(20_000);
    const first = await store.append({
      trajectoryId,
      type: 'runtime-output',
      data: { stdout: big },
    });
    const firstStep = (await store.getStep(trajectoryId, first.stepId))!;

    // Blobs are content-addressed, so a second step spilling identical bytes
    // re-derives the same ref. Opening that path with 'w' truncates a file a
    // committed step already points at, and a crash inside that window shows
    // up as digest_mismatch -- the dangling reference I2 says is impossible.
    const second = await store.append({
      trajectoryId,
      type: 'runtime-output',
      data: { stdout: big },
    });
    const blobs = readdirSync(join(directory, 'blobs'));
    expect(blobs).toHaveLength(1);
    expect(blobs.every((file) => !file.endsWith('.tmp'))).toBe(true);
    for (const step of [
      firstStep,
      (await store.getStep(trajectoryId, second.stepId))!,
    ]) {
      expect(
        (await axResolveTrajectoryStep(step, store.blobs)).data.stdout
      ).toBe(big);
    }

    // The bytes go out of band, then the same value is put again: a store
    // that rewrites an existing ref would restore them.
    const blobPath = join(directory, 'blobs', blobs[0]!);
    writeFileSync(blobPath, 'SENTINEL');
    await store.blobs.put({
      trajectoryId,
      stepId: 'probe',
      field: 'stdout',
      value: big,
    });
    expect(readFileSync(blobPath, 'utf8')).toBe('SENTINEL');
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

  it('keeps colliding consumer and trajectory names in separate files', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    await store.create({ trajectoryId: 'c' });
    await store.create({ trajectoryId: 'b__c' });
    // encodeURIComponent leaves `_` alone, so a plain `a__b` join maps
    // consumer a__b / trajectory c onto the same file as consumer a /
    // trajectory b__c, and one consumer silently inherits the other's cursor.
    await store.saveCursor('a__b', { trajectoryId: 'c', seq: 1 });
    await store.saveCursor('a', { trajectoryId: 'b__c', seq: 0 });

    expect((await store.loadCursor('a__b', 'c'))?.seq).toBe(1);
    expect((await store.loadCursor('a', 'b__c'))?.seq).toBe(0);
    expect(readdirSync(join(directory, 'cursors'))).toHaveLength(2);
  });

  it('reports a dropped frame to one drain, not to every drain forever', async () => {
    const clock = new AxManualEventClock(5_000);
    const directory = root();
    const store = newStore(directory, clock);
    const { trajectoryId } = await store.create({});
    await store.append({ trajectoryId, type: 'run', data: { index: 0 } });
    appendFileSync(
      join(directory, encodeURIComponent(trajectoryId), 'steps.jsonl'),
      '{ not json at all\n'
    );

    const reopened = newStore(directory, clock);
    const first = await reopened.readFrom(undefined, trajectoryId, {});
    expect(first.corrupt).toBe(1);
    // AxTrajectoryDrainResult.corrupt is "frames skipped by the tolerant
    // parser", i.e. by THIS drain. A polling consumer that saw the running
    // total would stare at the same non-zero number for the log's lifetime.
    const second = await reopened.readFrom(first.cursor, trajectoryId, {});
    expect(second.steps).toHaveLength(0);
    expect(second.caughtUp).toBe(true);
    expect(second.corrupt).toBe(0);
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
