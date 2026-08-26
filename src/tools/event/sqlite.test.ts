import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AxEventOutputPersistenceError,
  type AxEventRun,
  AxEventRuntime,
  type AxEventStagedPayloadStore,
  AxManualEventClock,
  type AxProgrammable,
  AxPushEventSource,
  AxUCPWebhookEventSource,
  eventPath,
  eventRoute,
  eventTarget,
  runAxEventStoreConformance,
  s,
} from '@ax-llm/ax';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AX_SQLITE_EVENT_STANDARD_RETENTION,
  AxSQLiteEventStore,
} from './sqlite.js';

const directories: string[] = [];

const payloadStaging = {
  maxOutstandingCount: 4,
  maxOutstandingBytes: 1024 * 1024,
  maxPayloadBytes: 1024 * 1024,
  stageTtlMs: 1_000,
  persistenceTimeoutMs: 10,
} as const;

function storeRequest(id: string, now: number) {
  return {
    ingress: {
      event: {
        specversion: '1.0' as const,
        id,
        source: 'test://sqlite-effects',
        type: 'effect.test',
      },
      identity: { tenantId: 'tenant' },
      trust: 'authenticated' as const,
    },
    deliveries: [
      {
        routeId: 'route',
        action: 'wake' as const,
        targetId: 'target',
        instanceKey: id,
        sizeBytes: 128,
        retrySafety: 'idempotent' as const,
        ordering: 'strict' as const,
      },
    ],
    acceptedAt: now,
    publishTimeoutMs: 1_000,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AxSQLiteEventStore', () => {
  it('passes the persistent multi-worker conformance kit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const clock = new AxManualEventClock(10_000);
    const report = await runAxEventStoreConformance(
      ({ databaseKey, maxPendingDeliveries }) => {
        const store = new AxSQLiteEventStore({
          filename: join(directory, `${databaseKey}.sqlite`),
          clock,
          retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
          maxPendingDeliveries,
        });
        return { store, stateStore: store };
      },
      { clock }
    );
    expect(report.assertions).toBeGreaterThanOrEqual(32);
    expect(report.capability.conformance?.multiWorker).toBe('axevent-store-v4');
  });

  it('requires explicit retention and WAL-enabled local storage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    expect(
      () =>
        new AxSQLiteEventStore({
          filename: join(directory, 'missing-retention.sqlite'),
        } as never)
    ).toThrow('requires explicit retention');
  });

  it('restores unresolved effects after restart and prunes only settled effects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'effect-restart.sqlite');
    const clock = new AxManualEventClock(1_000);
    const retention = {
      eventAndResultMs: 100,
      runMetadataAndDeadLettersMs: 1_000,
      completedContinuationsMs: 1_000,
      settledEffectsMs: 50,
    };
    const first = new AxSQLiteEventStore({ filename, clock, retention });
    const settledReceipt = await first.enqueue(
      storeRequest('settled', clock.now())
    );
    const settledDelivery = await first.claim('worker', clock.now(), 100);
    const settledFence = {
      deliveryId: settledDelivery!.id,
      fencingToken: settledDelivery!.fencingToken!,
    };
    const settledEffect = await first.declareEffect(
      {
        id: 'settled-effect',
        deliveryId: settledDelivery!.id,
        runId: 'settled-run',
        identityScope: settledDelivery!.identityScope,
        operation: 'effect.settled',
        idempotencyKey: 'settled-key',
        createdAt: clock.now(),
      },
      settledFence
    );
    await first.transitionEffect(
      settledEffect.id,
      settledEffect.version,
      {
        type: 'settled',
        at: clock.now(),
        settlement: { status: 'succeeded' },
      },
      settledFence
    );
    await first.saveDelivery({ ...settledDelivery!, status: 'succeeded' });

    const unresolvedReceipt = await first.enqueue(
      storeRequest('unresolved', clock.now())
    );
    const unresolvedDelivery = await first.claim('worker', clock.now(), 100);
    const unresolvedFence = {
      deliveryId: unresolvedDelivery!.id,
      fencingToken: unresolvedDelivery!.fencingToken!,
    };
    await first.declareEffect(
      {
        id: 'unresolved-effect',
        deliveryId: unresolvedDelivery!.id,
        runId: 'unresolved-run',
        identityScope: unresolvedDelivery!.identityScope,
        operation: 'effect.unresolved',
        idempotencyKey: 'unresolved-key',
        createdAt: clock.now(),
      },
      unresolvedFence
    );
    await first.saveDelivery({ ...unresolvedDelivery!, status: 'parked' });
    await first.close();

    clock.advanceBy(51);
    const restarted = new AxSQLiteEventStore({ filename, clock, retention });
    expect(await restarted.listEffects(settledReceipt.deliveryIds[0]!)).toEqual(
      [expect.objectContaining({ status: 'succeeded' })]
    );
    expect(await restarted.getDelivery(settledReceipt.deliveryIds[0]!)).toEqual(
      expect.objectContaining({ status: 'succeeded' })
    );
    expect(
      await restarted.listEffects(unresolvedReceipt.deliveryIds[0]!)
    ).toEqual([expect.objectContaining({ status: 'intent' })]);
    expect(
      await restarted.getDelivery(unresolvedReceipt.deliveryIds[0]!)
    ).toEqual(expect.objectContaining({ status: 'parked' }));
    await restarted.close();

    clock.advanceBy(50);
    const expired = new AxSQLiteEventStore({ filename, clock, retention });
    expect(await expired.listEffects(settledReceipt.deliveryIds[0]!)).toEqual(
      []
    );
    expect(await expired.getDelivery(settledReceipt.deliveryIds[0]!)).toBe(
      undefined
    );
    expect(
      await expired.listEffects(unresolvedReceipt.deliveryIds[0]!)
    ).toEqual([expect.objectContaining({ status: 'intent' })]);
    await expired.close();
  });

  it('migrates schema-v1 databases and legacy retention objects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'legacy.sqlite');
    const clock = new AxManualEventClock(1_000);
    const current = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    const receipt = await current.enqueue(storeRequest('legacy', clock.now()));
    await current.close();

    const legacy = new Database(filename);
    legacy.exec(`
      DROP TABLE event_effects;
      ALTER TABLE event_dedupe DROP COLUMN ingress_fingerprint;
      ALTER TABLE event_dedupe DROP COLUMN ingress_json;
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const migrated = new AxSQLiteEventStore({
      filename,
      clock,
      retention: {
        eventAndResultMs: 1_000,
        runMetadataAndDeadLettersMs: 1_000,
        completedContinuationsMs: 1_000,
      },
    });
    expect(migrated.capabilities.conformance.schemaVersion).toBe(5);
    expect(await migrated.getDelivery(receipt.deliveryIds[0]!)).toEqual(
      expect.objectContaining({ status: 'queued' })
    );
    expect(await migrated.listEffects(receipt.deliveryIds[0]!)).toEqual([]);
    await expect(
      migrated.enqueue(storeRequest('legacy', clock.now()))
    ).resolves.toEqual(expect.objectContaining({ duplicate: true }));
    const changed = storeRequest('legacy', clock.now());
    await expect(
      migrated.enqueue({
        ...changed,
        ingress: {
          ...changed.ingress,
          event: { ...changed.ingress.event, type: 'effect.changed' },
        },
      })
    ).rejects.toThrow('identity conflicts with previously accepted ingress');
    await migrated.close();
  });

  it('migrates schema-v2 effect request digests without losing replay identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'legacy-v2.sqlite');
    const clock = new AxManualEventClock(1_000);
    const current = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await current.enqueue(storeRequest('legacy-v2', clock.now()));
    const claimed = await current.claim('worker', clock.now(), 100);
    const fence = {
      deliveryId: claimed!.id,
      fencingToken: claimed!.fencingToken!,
    };
    const request = {
      id: 'legacy-v2-effect',
      deliveryId: claimed!.id,
      runId: 'legacy-v2-run',
      identityScope: claimed!.identityScope,
      operation: 'legacy.effect',
      idempotencyKey: 'legacy-effect-key',
      replaySafety: 'idempotent' as const,
      metadata: { amount: 42, redacted: true },
      createdAt: clock.now(),
    };
    const original = await current.declareEffect(request, fence);
    await current.close();

    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE event_dedupe DROP COLUMN ingress_fingerprint;
      UPDATE event_effects
      SET effect_json=json_remove(effect_json, '$.requestDigest');
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    const [migratedEffect] = await migrated.listEffects(claimed!.id);
    expect(migratedEffect).toEqual(
      expect.objectContaining({
        id: original.id,
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    await expect(
      migrated.declareEffect(
        {
          ...request,
          id: 'legacy-v2-duplicate',
          metadata: { redacted: true, amount: 42 },
        },
        fence
      )
    ).resolves.toEqual(expect.objectContaining({ id: original.id }));
    await expect(
      migrated.declareEffect(
        {
          ...request,
          id: 'legacy-v2-conflict',
          metadata: { amount: 43, redacted: true },
        },
        fence
      )
    ).rejects.toThrow('intent conflicts');
    await migrated.close();
  });

  it('migrates and replays a schema-v2 zero-route dedupe record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'legacy-v2-zero-route.sqlite');
    const clock = new AxManualEventClock(1_000);
    const request = {
      ...storeRequest('legacy-v2-zero-route', clock.now()),
      deliveries: [],
    };
    const current = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await expect(current.enqueue(request)).resolves.toEqual(
      expect.objectContaining({ duplicate: false, deliveryIds: [] })
    );
    await current.close();

    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE event_dedupe DROP COLUMN ingress_fingerprint;
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await expect(migrated.enqueue(request)).resolves.toEqual(
      expect.objectContaining({ duplicate: true, deliveryIds: [] })
    );
    await migrated.close();

    const verified = new Database(filename);
    expect(verified.pragma('user_version', { simple: true })).toBe(5);
    expect(
      verified
        .prepare(
          `SELECT COUNT(*) AS count FROM event_dedupe
           WHERE ingress_json IS NULL OR ingress_fingerprint IS NULL`
        )
        .get()
    ).toEqual({ count: 0 });
    verified.close();
  });

  it('expires an unverifiable zero-route tombstone before migration and permits identity reuse', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'legacy-v2-expired-zero-route.sqlite');
    const clock = new AxManualEventClock(10_000);
    const retention = {
      ...AX_SQLITE_EVENT_STANDARD_RETENTION,
      eventAndResultMs: 100,
    };
    const request = {
      ...storeRequest('legacy-v2-expired-zero-route', clock.now()),
      deliveries: [],
    };
    const current = new AxSQLiteEventStore({ filename, clock, retention });
    await current.enqueue(request);
    await current.close();

    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE event_dedupe DROP COLUMN ingress_fingerprint;
      ALTER TABLE event_dedupe DROP COLUMN ingress_json;
      UPDATE event_dedupe SET created_at=0;
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new AxSQLiteEventStore({ filename, clock, retention });
    await expect(migrated.enqueue(request)).resolves.toEqual(
      expect.objectContaining({ duplicate: false, deliveryIds: [] })
    );
    await migrated.close();
  });

  it('quarantines a legacy zero-route dedupe record without retained ingress', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'legacy-unverifiable-zero-route.sqlite');
    const clock = new AxManualEventClock(1_000);
    const request = {
      ...storeRequest('legacy-unverifiable-zero-route', clock.now()),
      deliveries: [],
    };
    const current = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await current.enqueue(request);
    await current.close();

    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE event_dedupe DROP COLUMN ingress_fingerprint;
      ALTER TABLE event_dedupe DROP COLUMN ingress_json;
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await expect(migrated.enqueue(request)).rejects.toThrow(
      'cannot be verified against legacy ingress'
    );
    await expect(
      migrated.enqueue({
        ...request,
        ingress: {
          ...request.ingress,
          event: { ...request.ingress.event, type: 'effect.changed' },
        },
      })
    ).rejects.toThrow('cannot be verified against legacy ingress');
    await migrated.close();

    const verified = new Database(filename);
    expect(
      verified
        .prepare(`SELECT ingress_json, ingress_fingerprint FROM event_dedupe`)
        .get()
    ).toEqual({
      ingress_json: null,
      ingress_fingerprint: expect.stringMatching(/^legacy-unverifiable:/),
    });
    expect(
      verified.prepare('SELECT COUNT(*) AS count FROM event_deliveries').get()
    ).toEqual({ count: 0 });
    verified.close();
  });

  it('aborts only stale staged ownership when a deduplicated payload write loses takeover', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-takeover.sqlite');
    const clock = new AxManualEventClock(1_000);
    let payloadStarted!: () => void;
    let releasePayload!: () => void;
    const started = new Promise<void>((resolve) => {
      payloadStarted = resolve;
    });
    const firstPayload = new Promise<void>((resolve) => {
      releasePayload = resolve;
    });
    const aborted: string[] = [];
    const committed: string[] = [];
    const stagedValues = new Map<string, unknown>();
    let stages = 0;
    let winnerPayload: unknown;
    const payloadStore: AxEventStagedPayloadStore = {
      stage: async ({ stageId, value }) => {
        stages++;
        stagedValues.set(stageId, value);
        if (stages === 1) {
          payloadStarted();
          await firstPayload;
        }
        return { reference: 'payload://content-addressed' };
      },
      commit: async (stageId) => {
        committed.push(stageId);
        winnerPayload = stagedValues.get(stageId);
      },
      abort: async (stageId) => {
        aborted.push(stageId);
        stagedValues.delete(stageId);
      },
      put: async () => {
        throw new Error('legacy put must not be called');
      },
      get: async () => winnerPayload,
      delete: async () => {
        throw new Error('shared references must not be deleted');
      },
    };
    const first = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStore,
      payloadStaging,
    });
    const peer = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStore,
      payloadStaging,
    });
    await first.enqueue(storeRequest('payload-takeover', clock.now()));
    const claimed = await first.claim('worker-a', clock.now(), 100);
    const run: AxEventRun = {
      id: 'payload-takeover-run',
      deliveryId: claimed!.id,
      routeId: claimed!.routeId,
      instanceKey: claimed!.instanceKey,
      claimedBy: claimed!.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      output: { persisted: true },
      fencingToken: claimed!.fencingToken,
    };
    const saving = first.saveRun(run);
    await started;
    clock.advanceBy(101);
    const takeover = await peer.claim('worker-b', clock.now(), 100);
    expect(takeover?.id).toBe(claimed?.id);
    const winner: AxEventRun = {
      ...run,
      id: 'payload-winner-run',
      claimedBy: takeover!.claimedBy,
      fencingToken: takeover!.fencingToken,
      output: { winner: true },
    };
    await peer.saveRun(winner);
    releasePayload();

    await expect(saving).rejects.toMatchObject({
      code: 'output_persistence_failed',
      phase: 'stage',
    });
    expect(await first.getRun(run.id)).toBeUndefined();
    await expect(peer.getRun(winner.id)).resolves.toEqual(
      expect.objectContaining({ output: { winner: true } })
    );
    expect(committed).toHaveLength(1);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).not.toBe(committed[0]);
    await first.close();
    await peer.close();
  });

  it('revalidates lease ownership after payload persistence without takeover', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-expiry.sqlite');
    const clock = new AxManualEventClock(1_000);
    const aborted: string[] = [];
    const store = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStore: {
        stage: async () => {
          clock.advanceBy(101);
          return { reference: 'payload://expired' };
        },
        commit: async () => {},
        abort: async (stageId) => {
          aborted.push(stageId);
        },
        put: async () => 'payload://legacy-unused',
        get: async () => undefined,
        delete: async () => {},
      },
      payloadStaging,
    });
    await store.enqueue(storeRequest('payload-expiry', clock.now()));
    const claimed = await store.claim('worker-a', clock.now(), 100);
    const run: AxEventRun = {
      id: 'payload-expiry-run',
      deliveryId: claimed!.id,
      routeId: claimed!.routeId,
      instanceKey: claimed!.instanceKey,
      claimedBy: claimed!.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      output: { persisted: true },
      fencingToken: claimed!.fencingToken,
    };

    await expect(store.saveRun(run)).rejects.toMatchObject({
      code: 'output_persistence_failed',
      phase: 'stage',
    });
    await expect(
      store.saveDelivery({ ...claimed!, status: 'succeeded' })
    ).rejects.toThrow('Stale or expired event claim');
    expect(await store.getRun(run.id)).toBeUndefined();
    expect(aborted).toHaveLength(1);
    await store.close();
  });

  it('rejects a stale live commit acknowledgement after peer takeover', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-commit-takeover.sqlite');
    const clock = new AxManualEventClock(1_000);
    let commitCalls = 0;
    let takeover: Awaited<ReturnType<AxSQLiteEventStore['claim']>>;
    const peerRef: { current?: AxSQLiteEventStore } = {};
    const payloadStore: AxEventStagedPayloadStore = {
      stage: async () => ({ reference: 'payload://commit-takeover' }),
      commit: async () => {
        commitCalls++;
        if (commitCalls === 1) {
          clock.advanceBy(101);
          takeover = await peerRef.current!.claim('worker-b', clock.now(), 100);
        }
      },
      abort: async () => {},
      put: async () => 'payload://legacy-unused',
      get: async () => ({ output: { persisted: true } }),
      delete: async () => {},
    };
    const first = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStore,
      payloadStaging,
    });
    const peer = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStore,
      payloadStaging,
    });
    peerRef.current = peer;
    await first.enqueue(storeRequest('payload-commit-takeover', clock.now()));
    const claimed = (await first.claim('worker-a', clock.now(), 100))!;
    await expect(
      first.saveRun({
        id: 'payload-commit-takeover-run',
        deliveryId: claimed.id,
        routeId: claimed.routeId,
        instanceKey: claimed.instanceKey,
        claimedBy: claimed.claimedBy,
        status: 'succeeded',
        attempt: 1,
        startedAt: clock.now(),
        finishedAt: clock.now(),
        output: { persisted: true },
        fencingToken: claimed.fencingToken,
      })
    ).rejects.toMatchObject({
      code: 'output_persistence_failed',
      phase: 'commit',
    });
    expect(takeover).toEqual(
      expect.objectContaining({
        id: claimed.id,
        claimedBy: 'worker-b',
        fencingToken: 2,
        recoveredFromExpiredLease: true,
        runId: 'payload-commit-takeover-run',
      })
    );
    expect(commitCalls).toBe(2);
    await first.close();
    await peer.close();
  });

  it('types a database failure after provider commit and retains the journal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-post-commit-db-failure.sqlite');
    const clock = new AxManualEventClock(1_000);
    let providerCommitted = false;
    const storeRef: { current?: AxSQLiteEventStore } = {};
    const store = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStaging,
      payloadStore: {
        stage: async () => ({ reference: 'payload://post-commit' }),
        commit: async () => {
          providerCommitted = true;
          (storeRef.current as unknown as { db: { close(): void } }).db.close();
        },
        abort: async () => {},
        put: async () => 'payload://legacy-unused',
        get: async () => ({ output: { persisted: true } }),
        delete: async () => {},
      },
    });
    storeRef.current = store;
    await store.enqueue(storeRequest('payload-post-commit', clock.now()));
    const claimed = (await store.claim('worker-a', clock.now(), 100))!;
    await expect(
      store.saveRun({
        id: 'payload-post-commit-run',
        deliveryId: claimed.id,
        routeId: claimed.routeId,
        instanceKey: claimed.instanceKey,
        claimedBy: claimed.claimedBy,
        status: 'succeeded',
        attempt: 1,
        startedAt: clock.now(),
        finishedAt: clock.now(),
        output: { persisted: true },
        fencingToken: claimed.fencingToken,
      })
    ).rejects.toMatchObject({
      code: 'output_persistence_failed',
      phase: 'commit',
    });
    expect(providerCommitted).toBe(true);
    const inspect = new Database(filename, { readonly: true });
    expect(
      inspect
        .prepare(
          `SELECT state FROM event_payload_stages
           WHERE run_id='payload-post-commit-run'`
        )
        .get()
    ).toEqual({ state: 'commit_pending' });
    inspect.close();
  });

  it('fails before upload for legacy stores and insufficient lease budget', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const clock = new AxManualEventClock(1_000);
    let legacyPuts = 0;
    const legacy = new AxSQLiteEventStore({
      filename: join(directory, 'payload-legacy.sqlite'),
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStore: {
        put: async () => {
          legacyPuts++;
          throw new Error('must not upload');
        },
        get: async () => undefined,
        delete: async () => {},
      },
    });
    await legacy.enqueue(storeRequest('payload-legacy', clock.now()));
    const legacyClaim = (await legacy.claim('worker-a', clock.now(), 100))!;
    const run: AxEventRun = {
      id: 'payload-preflight-run',
      deliveryId: legacyClaim.id,
      routeId: legacyClaim.routeId,
      instanceKey: legacyClaim.instanceKey,
      claimedBy: legacyClaim.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      output: { large: true },
      fencingToken: legacyClaim.fencingToken,
    };
    await expect(legacy.saveRun(run)).rejects.toBeInstanceOf(
      AxEventOutputPersistenceError
    );
    expect(legacyPuts).toBe(0);
    await legacy.close();

    let stages = 0;
    const shortLease = new AxSQLiteEventStore({
      filename: join(directory, 'payload-short-lease.sqlite'),
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStaging,
      payloadStore: {
        stage: async () => {
          stages++;
          return { reference: 'payload://must-not-stage' };
        },
        commit: async () => {},
        abort: async () => {},
        put: async () => 'payload://legacy-unused',
        get: async () => undefined,
        delete: async () => {},
      },
    });
    await shortLease.enqueue(storeRequest('payload-short-lease', clock.now()));
    const shortClaim = (await shortLease.claim('worker-a', clock.now(), 19))!;
    await expect(
      shortLease.saveRun({
        ...run,
        id: 'payload-short-lease-run',
        deliveryId: shortClaim.id,
        routeId: shortClaim.routeId,
        instanceKey: shortClaim.instanceKey,
        claimedBy: shortClaim.claimedBy,
        fencingToken: shortClaim.fencingToken,
      })
    ).rejects.toMatchObject({
      code: 'output_persistence_failed',
      phase: 'preflight',
    });
    expect(stages).toBe(0);
    await shortLease.close();
  });

  it('bounds orphaned staged ownership by count, bytes, and operation timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-bounds.sqlite');
    const clock = new AxManualEventClock(1_000);
    const initial = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await initial.close();
    const seeded = new Database(filename);
    seeded
      .prepare(
        `INSERT INTO event_payload_stages(
           stage_id, run_id, delivery_id, fencing_token, reference,
           size_bytes, expires_at, state, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'orphaned-stage',
        'orphan-run',
        'orphan-delivery',
        1,
        'payload://shared',
        64,
        clock.now() + 1_000,
        'abort_pending',
        clock.now(),
        clock.now()
      );
    seeded.close();

    let stageCalls = 0;
    const boundedPolicy = {
      ...payloadStaging,
      maxOutstandingCount: 1,
      maxOutstandingBytes: 64,
    };
    const store = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 1,
      payloadStaging: boundedPolicy,
      payloadStore: {
        stage: async () => {
          stageCalls++;
          return { reference: 'payload://must-not-stage' };
        },
        commit: async () => {},
        abort: async () => new Promise<void>(() => {}),
        put: async () => 'payload://legacy-unused',
        get: async () => undefined,
        delete: async () => {},
      },
    });
    await store.enqueue(storeRequest('payload-bounds', clock.now()));
    const startedAt = Date.now();
    const claimed = (await store.claim('worker-a', clock.now(), 1_000))!;
    await expect(
      store.saveRun({
        id: 'payload-bounds-run',
        deliveryId: claimed.id,
        routeId: claimed.routeId,
        instanceKey: claimed.instanceKey,
        claimedBy: claimed.claimedBy,
        status: 'succeeded',
        attempt: 1,
        startedAt: clock.now(),
        finishedAt: clock.now(),
        output: { large: true },
        fencingToken: claimed.fencingToken,
      })
    ).rejects.toMatchObject({
      code: 'output_persistence_failed',
      phase: 'preflight',
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(stageCalls).toBe(0);
    const outstanding = new Database(filename, { readonly: true });
    expect(
      outstanding
        .prepare(
          `SELECT COUNT(*) AS count, SUM(size_bytes) AS bytes
           FROM event_payload_stages WHERE state!='committed'`
        )
        .get()
    ).toEqual({ count: 1, bytes: 64 });
    outstanding.close();
    await store.close();
  });

  it('reconciles a commit-pending staged payload after store restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-restart.sqlite');
    const clock = new AxManualEventClock(1_000);
    const initial = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await initial.enqueue(storeRequest('payload-restart', clock.now()));
    const claimed = (await initial.claim('worker-a', clock.now(), 100))!;
    await initial.close();

    const stageId = 'event-payload-stage:restart';
    const run: AxEventRun = {
      id: 'payload-restart-run',
      deliveryId: claimed.id,
      routeId: claimed.routeId,
      instanceKey: claimed.instanceKey,
      claimedBy: claimed.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      outputRef: 'payload://restart',
      fencingToken: claimed.fencingToken,
    };
    const seeded = new Database(filename);
    seeded
      .prepare(
        `INSERT INTO event_runs(id, delivery_id, run_json, updated_at, finished_at)
         VALUES(?,?,?,?,?)`
      )
      .run(
        run.id,
        run.deliveryId,
        JSON.stringify(run),
        clock.now(),
        clock.now()
      );
    seeded
      .prepare(
        `INSERT INTO event_payload_stages(
           stage_id, run_id, delivery_id, fencing_token, reference,
           size_bytes, expires_at, state, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        stageId,
        run.id,
        run.deliveryId,
        run.fencingToken,
        run.outputRef,
        128,
        clock.now() + 1_000,
        'commit_pending',
        clock.now(),
        clock.now()
      );
    seeded.close();

    const commits: string[] = [];
    const restarted = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      payloadStaging,
      payloadStore: {
        stage: async () => ({ reference: 'payload://restart' }),
        commit: async (id) => {
          commits.push(id);
        },
        abort: async () => {},
        put: async () => 'payload://legacy-unused',
        get: async () => ({ output: { recovered: true } }),
        delete: async () => {},
      },
    });
    await expect(restarted.getRun(run.id)).resolves.toEqual(
      expect.objectContaining({ output: { recovered: true } })
    );
    expect(commits).toEqual([stageId]);
    clock.advanceBy(101);
    let targetCalls = 0;
    let sinkCalls = 0;
    const signature = s('trigger?:string -> recovered:boolean');
    const program = {
      getId: () => 'payload-restart-target',
      getSignature: () => signature,
      forward: async () => {
        targetCalls++;
        return { recovered: false };
      },
      streamingForward: async function* () {},
    } as unknown as AxProgrammable<any, any>;
    const runtime = new AxEventRuntime({
      store: restarted,
      programStateStore: restarted,
      coordination: 'multi-worker',
      workerConcurrency: 1,
      leaseMs: 100,
      heartbeatMs: 25,
      routes: [
        eventRoute({
          id: 'route',
          match: { types: ['effect.test'] },
          action: 'wake',
          target: eventTarget({
            id: 'target',
            ai: {} as never,
            program,
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [
              {
                id: 'recovered-sink',
                write: (output) => {
                  sinkCalls++;
                  expect(output).toEqual({ recovered: true });
                },
              },
            ],
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.waitForIdle();
    expect(targetCalls).toBe(0);
    expect(sinkCalls).toBe(1);
    expect(await restarted.getDelivery(claimed.id)).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        fencingToken: 2,
        runId: run.id,
      })
    );
    await runtime.close({ drain: false });
  });

  it('quarantines failed payload recovery without poisoning unrelated claims', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-recovery-failure.sqlite');
    const clock = new AxManualEventClock(1_000);
    const initial = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    const blockedReceipt = await initial.enqueue(
      storeRequest('payload-recovery-blocked', clock.now())
    );
    const blocked = (await initial.claim('worker-a', clock.now(), 100))!;
    const unrelatedReceipt = await initial.enqueue(
      storeRequest('payload-recovery-unrelated', clock.now())
    );
    await initial.close();

    const run: AxEventRun = {
      id: 'payload-recovery-blocked-run',
      deliveryId: blocked.id,
      routeId: blocked.routeId,
      targetId: blocked.targetId,
      instanceKey: blocked.instanceKey,
      claimedBy: blocked.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      outputRef: 'payload://recovery-blocked',
      fencingToken: blocked.fencingToken,
    };
    const seeded = new Database(filename);
    seeded
      .prepare(
        `INSERT INTO event_runs(id, delivery_id, run_json, updated_at, finished_at)
         VALUES(?,?,?,?,?)`
      )
      .run(
        run.id,
        run.deliveryId,
        JSON.stringify(run),
        clock.now(),
        clock.now()
      );
    seeded
      .prepare(
        `INSERT INTO event_payload_stages(
           stage_id, run_id, delivery_id, fencing_token, reference,
           size_bytes, expires_at, state, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'event-payload-stage:recovery-blocked',
        run.id,
        run.deliveryId,
        run.fencingToken,
        run.outputRef,
        128,
        clock.now() + 1_000,
        'commit_pending',
        clock.now(),
        clock.now()
      );
    seeded.close();
    clock.advanceBy(101);

    let commitCalls = 0;
    const restarted = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      payloadStaging,
      payloadStore: {
        stage: async () => ({ reference: 'payload://unused' }),
        commit: async () => {
          commitCalls++;
          throw new Error('payload provider unavailable');
        },
        abort: async () => {},
        put: async () => 'payload://legacy-unused',
        get: async () => {
          throw new Error('uncommitted payload must not be read');
        },
        delete: async () => {},
      },
    });
    await expect(restarted.getRun(run.id)).resolves.toEqual(
      expect.objectContaining({
        id: run.id,
        status: 'succeeded',
        outputRef: run.outputRef,
      })
    );
    const claimed = await restarted.claim('worker-b', clock.now(), 100);
    expect(claimed?.id).toBe(unrelatedReceipt.deliveryIds[0]);
    expect(claimed?.id).not.toBe(blockedReceipt.deliveryIds[0]);
    expect(commitCalls).toBeGreaterThanOrEqual(2);
    await expect(restarted.close()).resolves.toBeUndefined();
  });

  it('releases committed staged ownership when result retention expires', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'payload-retention.sqlite');
    const clock = new AxManualEventClock(1_000);
    const retention = {
      ...AX_SQLITE_EVENT_STANDARD_RETENTION,
      eventAndResultMs: 100,
    };
    const values = new Map<string, unknown>();
    const aborted: string[] = [];
    const payloadStore: AxEventStagedPayloadStore = {
      stage: async ({ stageId, value }) => {
        values.set(stageId, value);
        return { reference: `payload://${stageId}` };
      },
      commit: async () => {},
      abort: async (stageId) => {
        aborted.push(stageId);
        values.delete(stageId);
      },
      put: async () => 'payload://legacy-unused',
      get: async (reference) => values.get(reference.replace('payload://', '')),
      delete: async () => {},
    };
    const initial = new AxSQLiteEventStore({
      filename,
      clock,
      retention,
      maxInlinePayloadBytes: 1,
      payloadStaging,
      payloadStore,
    });
    await initial.enqueue(storeRequest('payload-retention', clock.now()));
    const claimed = (await initial.claim('worker-a', clock.now(), 1_000))!;
    const run: AxEventRun = {
      id: 'payload-retention-run',
      deliveryId: claimed.id,
      routeId: claimed.routeId,
      instanceKey: claimed.instanceKey,
      claimedBy: claimed.claimedBy,
      status: 'succeeded',
      attempt: 1,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      output: { retained: true },
      fencingToken: claimed.fencingToken,
    };
    await initial.saveRun(run);
    await initial.saveDelivery({
      ...claimed,
      status: 'succeeded',
      runId: run.id,
    });
    await initial.close();
    clock.advanceBy(101);

    const restarted = new AxSQLiteEventStore({
      filename,
      clock,
      retention,
      maxInlinePayloadBytes: 1,
      payloadStaging,
      payloadStore,
    });
    const retainedRun = await restarted.getRun(run.id);
    expect(retainedRun).not.toHaveProperty('output');
    expect(retainedRun).not.toHaveProperty('outputRef');
    expect(aborted).toHaveLength(1);
    const db = new Database(filename, { readonly: true });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM event_payload_stages').get()
    ).toEqual({ count: 0 });
    db.close();
    await restarted.close();
  });

  it('fails closed before fencing tokens leave the safe integer range', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const filename = join(directory, 'fencing-token-limit.sqlite');
    const clock = new AxManualEventClock(1_000);
    const initial = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    const receipt = await initial.enqueue(
      storeRequest('fencing-token-limit', clock.now())
    );
    await initial.close();

    const seeded = new Database(filename);
    seeded
      .prepare('UPDATE event_deliveries SET fencing_token=? WHERE id=?')
      .run(Number.MAX_SAFE_INTEGER - 1, receipt.deliveryIds[0]);
    seeded.close();

    const store = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    const lastSafeClaim = await store.claim('worker-a', clock.now(), 100);
    expect(lastSafeClaim?.fencingToken).toBe(Number.MAX_SAFE_INTEGER);
    clock.advanceBy(101);
    await expect(store.claim('worker-b', clock.now(), 100)).rejects.toThrow(
      'Fencing token exhausted'
    );
    await store.close();

    const terminal = new Database(filename);
    terminal
      .prepare(
        `UPDATE event_deliveries
         SET status='succeeded', claimed_by=NULL, lease_expires_at=NULL
         WHERE id=?`
      )
      .run(receipt.deliveryIds[0]);
    terminal.close();
    const redrive = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await expect(
      redrive.redriveDelivery(receipt.deliveryIds[0]!, clock.now())
    ).rejects.toThrow('Fencing token exhausted');
    await redrive.close();

    const unsafe = new Database(filename);
    unsafe
      .prepare(
        `UPDATE event_deliveries
         SET status='queued', fencing_token=?
         WHERE id=?`
      )
      .run(BigInt(Number.MAX_SAFE_INTEGER) + 1n, receipt.deliveryIds[0]);
    unsafe.close();
    const rejected = new AxSQLiteEventStore({
      filename,
      clock,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await expect(rejected.claim('worker-c', clock.now(), 100)).rejects.toThrow(
      'Unsafe fencing token'
    );
    await rejected.close();
  });

  it.each(['rejection', 'timeout'] as const)(
    'records staged payload %s without dispatching sinks or rerunning',
    async (failureMode) => {
      const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
      directories.push(directory);
      const aborted: string[] = [];
      const store = new AxSQLiteEventStore({
        filename: join(directory, `runtime-${failureMode}.sqlite`),
        retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
        maxInlinePayloadBytes: 512,
        payloadStaging,
        payloadStore: {
          stage:
            failureMode === 'rejection'
              ? async () => {
                  throw new Error('provider rejected upload');
                }
              : async () => new Promise<never>(() => {}),
          commit: async () => {},
          abort: async (stageId) => {
            aborted.push(stageId);
          },
          put: async () => {
            throw new Error('legacy put must not be called');
          },
          get: async () => undefined,
          delete: async () => {},
        },
      });
      let calls = 0;
      let sinkCalls = 0;
      const signature = s('trigger?:string -> resultText:string');
      const program = {
        getId: () => 'large-output',
        getSignature: () => signature,
        forward: async () => {
          calls++;
          return { value: 'x'.repeat(2_000) };
        },
        streamingForward: async function* () {},
      } as unknown as AxProgrammable<any, any>;
      const runtime = new AxEventRuntime({
        store,
        programStateStore: store,
        coordination: 'multi-worker',
        routes: [
          eventRoute({
            id: 'large-output-route',
            match: { types: ['large.output'] },
            action: 'wake',
            target: eventTarget({
              id: 'large-output-target',
              ai: {} as never,
              program,
              mapInput: () => ({}),
              retrySafety: 'idempotent',
              sinks: [
                {
                  id: 'must-not-run',
                  write: () => {
                    sinkCalls++;
                  },
                },
              ],
            }),
          }),
        ],
      });
      await runtime.start();
      const receipt = await runtime.publish({
        event: {
          specversion: '1.0',
          id: `large-${failureMode}`,
          source: 'test://sqlite',
          type: 'large.output',
        },
        trust: 'trusted',
      });
      await runtime.waitForIdle();
      const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
      expect(delivery?.status).toBe('output_persistence_failed');
      expect(calls).toBe(1);
      expect(sinkCalls).toBe(0);
      expect(aborted).toHaveLength(1);
      await runtime.close({ drain: false });
    }
  );

  it('persists output before isolated sink retries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const store = new AxSQLiteEventStore({
      filename: join(directory, 'sink.sqlite'),
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    let modelCalls = 0;
    let sinkCalls = 0;
    const signature = s('trigger?:string -> persisted:boolean');
    const program = {
      getId: () => 'sink-output',
      getSignature: () => signature,
      forward: async () => {
        modelCalls++;
        return { persisted: true };
      },
      streamingForward: async function* () {},
    } as unknown as AxProgrammable<any, any>;
    const runtime = new AxEventRuntime({
      store,
      programStateStore: store,
      coordination: 'multi-worker',
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
      routes: [
        eventRoute({
          id: 'sink-route',
          match: { types: ['sink.test'] },
          action: 'wake',
          target: eventTarget({
            id: 'sink-target',
            ai: {} as never,
            program,
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            sinks: [
              {
                id: 'failing-sink',
                write: async (_output, context) => {
                  sinkCalls++;
                  expect((await store.getRun(context.run.id))?.output).toEqual({
                    persisted: true,
                  });
                  throw new Error('sink unavailable');
                },
              },
            ],
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish({
      event: {
        specversion: '1.0',
        id: 'sink-1',
        source: 'test://sqlite',
        type: 'sink.test',
      },
      trust: 'trusted',
    });
    await runtime.waitForIdle();
    expect(modelCalls).toBe(1);
    expect(sinkCalls).toBe(2);
    expect(await runtime.listDeadLetters()).toEqual([
      expect.objectContaining({ kind: 'sink', sinkId: 'failing-sink' }),
    ]);
    await runtime.close({ drain: false });
  });

  it('starts durable UCP wake/resume ingress and persists output before sinks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const store = new AxSQLiteEventStore({
      filename: join(directory, 'ucp-examples.sqlite'),
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    const checkoutStarted = new AxPushEventSource('checkout-started');
    const webhook = new AxUCPWebhookEventSource({
      client: {
        verifyOrderEvent: async () => ({
          id: 'order-1',
          checkout_id: 'checkout-1',
          event_id: 'hook-1',
          event_type: 'fulfilled',
        }),
      },
      identity: { tenantId: 'shop' },
    });
    const signature = s('checkoutId:string, eventType:string -> status:string');
    let calls = 0;
    let sinkCalls = 0;
    const program = {
      getId: () => 'checkout-flow',
      getSignature: () => signature,
      forward: async (_ai: unknown, input: { eventType: string }) => {
        calls++;
        return { status: input.eventType };
      },
      streamingForward: async function* () {},
    } as unknown as AxProgrammable<
      { checkoutId: string; eventType: string },
      { status: string }
    >;
    const target = eventTarget('checkout-flow')
      .program(program)
      .ai({} as never)
      .wakeInput((input) =>
        input
          .field('checkoutId', eventPath.data('checkoutId'))
          .field('eventType', eventPath.constant('started'))
      )
      .resumeInput((input) =>
        input
          .field('checkoutId', eventPath.continuation('checkoutId'))
          .field('eventType', eventPath.type())
      )
      .waitFor('ucp.checkout', eventPath.data('checkoutId'), {
        metadata: { checkoutId: eventPath.data('checkoutId') },
      })
      .sink({
        id: 'assert-persisted',
        write: async (_output, context) => {
          sinkCalls++;
          expect((await store.getRun(context.run.id))?.output).toEqual({
            status: 'ucp.order.fulfilled',
          });
        },
      })
      .retrySafety('idempotent')
      .build();
    const runtime = new AxEventRuntime({
      store,
      programStateStore: store,
      sources: [checkoutStarted, webhook],
      routes: [
        eventRoute('checkout-start')
          .types('app.checkout.started')
          .wake(target)
          .build(),
        eventRoute('checkout-resume')
          .types('ucp.order.fulfilled')
          .correlate('ucp.checkout', eventPath.extension('checkoutid'))
          .resume(target)
          .build(),
      ],
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    await checkoutStarted.publish({
      event: {
        specversion: '1.0',
        id: 'checkout-start-1',
        source: 'app://checkout',
        type: 'app.checkout.started',
        data: { checkoutId: 'checkout-1' },
      },
      identity: { tenantId: 'shop' },
      trust: 'authenticated',
    });
    await runtime.waitForIdle();
    const receipt = await webhook.ingest(
      new Request('https://app.example/ucp/hooks', {
        method: 'POST',
        headers: { 'Webhook-Id': 'hook-1' },
        body: '{}',
      })
    );
    expect(receipt.durability).toBe('persistent');
    await runtime.waitForIdle();
    expect(calls).toBe(2);
    expect(sinkCalls).toBe(1);
    const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
    expect(delivery?.status).toBe('succeeded');
    expect((await store.getRun(delivery!.runId!))?.output).toEqual({
      status: 'ucp.order.fulfilled',
    });
    await runtime.close({ drain: false });
    await store.close();
  });
});
