import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AxEventRuntime,
  AxManualEventClock,
  type AxProgrammable,
  AxPushEventSource,
  AxUCPWebhookEventSource,
  axEventCanonicalJson,
  eventPath,
  eventRoute,
  eventTarget,
  runAxEventStoreConformance,
  s,
} from '@ax-llm/ax';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AX_SQLITE_EVENT_STANDARD_RETENTION,
  AxSQLiteEventStore,
} from './sqlite.js';

const directories: string[] = [];

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
    expect(report.assertions).toBeGreaterThanOrEqual(20);
    expect(report.capability.conformance?.multiWorker).toBe('axevent-store-v1');
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

  it('records oversized output failure without dispatching sinks or rerunning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const store = new AxSQLiteEventStore({
      filename: join(directory, 'runtime.sqlite'),
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 512,
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
        id: 'large-1',
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
    await runtime.close({ drain: false });
  });

  it('persists bounded huge Unicode verifier failures and errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const store = new AxSQLiteEventStore({
      filename: join(directory, 'bounded-verifier.sqlite'),
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      maxInlinePayloadBytes: 8_192,
    });
    const huge = '🔥'.repeat(20_000);
    const runIds = new Map<string, string>();
    const signature = s('trigger?:string -> resultText:string');
    const program = {
      getId: () => 'bounded-verifier-output',
      getSignature: () => signature,
      forward: async () => ({ resultText: 'small' }),
      streamingForward: async function* () {},
    } as unknown as AxProgrammable<any, any>;
    const runtime = new AxEventRuntime({
      store,
      workerConcurrency: 1,
      routes: [
        eventRoute({
          id: 'bounded-verifier-route',
          match: { types: ['bounded.verifier'] },
          action: 'wake',
          target: eventTarget({
            id: 'bounded-verifier-target',
            ai: {} as never,
            program,
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            verifier: {
              id: 'bounded-verifier',
              maxRuns: 1,
              fingerprint: () => huge,
              verify: (_output, context) => {
                runIds.set(
                  context.eventContext.ingress.event.id,
                  context.run.id
                );
                if (context.eventContext.ingress.event.id === 'huge-error') {
                  throw new Error(huge);
                }
                return {
                  status: 'fail',
                  failure: { code: huge, evidence: huge },
                };
              },
            },
          }),
        }),
      ],
    });
    await runtime.start();
    for (const id of ['huge-failure', 'huge-error']) {
      await runtime.publish({
        event: {
          specversion: '1.0',
          id,
          source: 'test://sqlite',
          type: 'bounded.verifier',
        },
      });
    }
    await runtime.waitForIdle();
    const [failure, error] = await Promise.all([
      runtime.getRun(runIds.get('huge-failure')!),
      runtime.getRun(runIds.get('huge-error')!),
    ]);
    expect(failure?.status).toBe('verification_failed');
    expect(
      Buffer.byteLength(failure!.verification!.failure!.code)
    ).toBeLessThanOrEqual(256);
    expect(
      Buffer.byteLength(
        JSON.stringify(failure!.verification!.failure!.evidence)
      )
    ).toBeLessThanOrEqual(4_096);
    expect(error?.status).toBe('verification_failed');
    expect(Buffer.byteLength(error!.verification!.error!)).toBeLessThanOrEqual(
      1_024
    );
    await runtime.close({ drain: false });
  });

  it('journals immutable transitions across repeated commit-ack loss', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ax-event-sqlite-'));
    directories.push(directory);
    const retention = {
      ...AX_SQLITE_EVENT_STANDARD_RETENTION,
      eventAndResultMs: 1,
    };
    const filename = join(directory, 'transition-journal.sqlite');
    let store = new AxSQLiteEventStore({
      filename,
      retention,
    });
    const transition = store.transitionVerifier.bind(store);
    const confirmTransition = store.confirmVerifierTransition.bind(store);
    vi.spyOn(store, 'confirmVerifierTransition')
      .mockResolvedValueOnce(undefined)
      .mockImplementation(confirmTransition);
    vi.spyOn(store, 'transitionVerifier').mockImplementation(
      async (request) => {
        await transition(request);
        throw new Error('commit acknowledgement lost');
      }
    );
    let attempts = 0;
    const sensitive = 'sensitive-journal-payload-do-not-retain';
    const verify = vi.fn(() =>
      attempts++ === 0
        ? {
            status: 'fail' as const,
            failure: { code: 'retry_once' },
          }
        : { status: 'pass' as const }
    );
    const signature = s('trigger?:string -> resultText:string');
    const program = {
      getId: () => 'journal-verifier-output',
      getSignature: () => signature,
      forward: async () => ({ resultText: sensitive }),
      streamingForward: async function* () {},
    } as unknown as AxProgrammable<any, any>;
    const runtime = new AxEventRuntime({
      store,
      workerConcurrency: 1,
      routes: [
        eventRoute({
          id: 'journal-verifier-route',
          match: { types: ['journal.verifier'] },
          action: 'wake',
          target: eventTarget({
            id: 'journal-verifier-target',
            ai: {} as never,
            program,
            mapInput: () => ({}),
            retrySafety: 'idempotent',
            verifier: { id: 'journal-verifier', verify },
          }),
        }),
      ],
    });
    await runtime.start();
    await runtime.publish({
      event: {
        specversion: '1.0',
        id: 'journal-event',
        source: 'test://sqlite',
        type: 'journal.verifier',
        data: { sensitive },
      },
    });
    await runtime.waitForIdle();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(store.transitionVerifier).toHaveBeenCalledTimes(2);
    const request = (store.transitionVerifier as any).mock.calls[0]![0];
    expect((await confirmTransition(request))?.deliveryIds).toEqual([
      request.childDeliveryId,
    ]);
    await expect(
      transition({
        ...request,
        child: {
          ...request.child,
          acceptedAt: request.child.acceptedAt + 1,
        },
      })
    ).rejects.toThrow('already owned');
    await expect(
      confirmTransition({
        ...request,
        parent: {
          ...request.parent,
          expectedFencingToken: request.parent.expectedFencingToken + 1,
        },
      })
    ).rejects.toThrow('already owned');
    const liveDb = (store as any).db;
    const compactJournal = liveDb
      .prepare(
        `SELECT request_commitment, receipt_json, child_delivery_id,
                child_commitment
         FROM event_verifier_transitions WHERE operation_id=?`
      )
      .get(request.operationId);
    expect(JSON.stringify(compactJournal)).not.toContain(sensitive);

    const receipt = await confirmTransition(request);
    const persistedChild = await store.getDelivery(request.childDeliveryId);
    liveDb
      .prepare('UPDATE event_deliveries SET route_id=? WHERE id=?')
      .run('corrupted-route', request.childDeliveryId);
    await expect(confirmTransition(request)).rejects.toThrow(
      'child is corrupt'
    );
    liveDb
      .prepare('UPDATE event_deliveries SET route_id=? WHERE id=?')
      .run(persistedChild!.routeId, request.childDeliveryId);
    const legacyRecord = {
      request,
      receipt,
      child: persistedChild,
    };
    const mismatchedRequest = {
      ...request,
      operationId: `${request.operationId}:mismatched-child`,
      childDeliveryId: `${request.childDeliveryId}:mismatched-child`,
    };
    const mismatchedRecord = {
      request: mismatchedRequest,
      receipt: {
        ...receipt,
        deliveryIds: [mismatchedRequest.childDeliveryId],
      },
      child: {
        ...persistedChild!,
        id: mismatchedRequest.childDeliveryId,
        routeId: 'legacy-mismatched-route',
      },
    };
    liveDb.exec(`
      DROP TABLE event_verifier_transitions;
      DROP TABLE event_store_metadata;
      CREATE TABLE event_verifier_transitions (
        operation_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    const insertLegacy = liveDb.prepare(
      `INSERT INTO event_verifier_transitions
         (operation_id, request_json, record_json, created_at)
         VALUES(?,?,?,?)`
    );
    insertLegacy.run(
      request.operationId,
      axEventCanonicalJson(request),
      JSON.stringify(legacyRecord),
      Date.now()
    );
    insertLegacy.run(
      mismatchedRequest.operationId,
      axEventCanonicalJson(mismatchedRequest),
      JSON.stringify(mismatchedRecord),
      Date.now()
    );
    await runtime.close({ drain: false });

    await new Promise((resolve) => setTimeout(resolve, 5));
    store = new AxSQLiteEventStore({
      filename: join(directory, 'transition-journal.sqlite'),
      retention,
    });
    expect(
      (await store.confirmVerifierTransition(request))?.deliveryIds
    ).toEqual([request.childDeliveryId]);
    await expect(
      store.confirmVerifierTransition(mismatchedRequest)
    ).rejects.toThrow('already owned');
    const db = (store as any).db;
    const retained = db
      .prepare(
        `SELECT request_commitment, receipt_json, child_delivery_id,
                child_commitment
         FROM event_verifier_transitions WHERE operation_id=?`
      )
      .get(request.operationId);
    expect(JSON.stringify(retained)).not.toContain(sensitive);
    expect(
      JSON.stringify(
        db.prepare('SELECT ingress_json FROM event_deliveries').all()
      )
    ).not.toContain(sensitive);
    expect(
      JSON.stringify(db.prepare('SELECT run_json FROM event_runs').all())
    ).not.toContain(sensitive);

    db.exec(`
      CREATE TABLE migration_crash_sentinel(value TEXT NOT NULL);
      INSERT INTO migration_crash_sentinel(value)
      VALUES('${sensitive}');
      DROP TABLE migration_crash_sentinel;
      INSERT OR REPLACE INTO event_store_metadata(metadata_key, metadata_value)
      VALUES('verifier-v2-cleanup-pending', '1');
    `);
    expect(
      readFileSync(`${filename}-wal`).includes(Buffer.from(sensitive))
    ).toBe(true);
    const cleanupStore = new AxSQLiteEventStore({ filename, retention });
    expect(
      (await cleanupStore.confirmVerifierTransition(request))?.deliveryIds
    ).toEqual([request.childDeliveryId]);
    await cleanupStore.close();
    const row = db
      .prepare(
        'SELECT receipt_json FROM event_verifier_transitions WHERE operation_id=?'
      )
      .get(request.operationId);
    const corrupted = JSON.parse(row.receipt_json);
    corrupted.deliveryIds = ['corrupted-child'];
    db.prepare(
      'UPDATE event_verifier_transitions SET receipt_json=? WHERE operation_id=?'
    ).run(JSON.stringify(corrupted), request.operationId);
    await expect(store.confirmVerifierTransition(request)).rejects.toThrow(
      'already owned'
    );
    await store.close();
    for (const entry of readdirSync(directory)) {
      expect(
        readFileSync(join(directory, entry)).includes(Buffer.from(sensitive))
      ).toBe(false);
    }
  });

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
