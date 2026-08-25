import { createHash, randomUUID } from 'node:crypto';
import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventContinuation,
  type AxEventCorrelationKey,
  type AxEventDeadLetter,
  type AxEventDelivery,
  type AxEventEffect,
  type AxEventEffectCreateRequest,
  type AxEventEffectFence,
  type AxEventEffectStore,
  type AxEventEffectTransition,
  type AxEventEnqueueRequest,
  type AxEventPayloadStore,
  type AxEventPublishReceipt,
  type AxEventRun,
  type AxEventStore,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
  AxSystemEventClock,
  axApplyEventEffectTransition,
  axEventEffectRequestDigest,
  axEventEffectRequestFingerprint,
  axEventIdentityScope,
  axEventIngressFingerprint,
  axEventScopedCorrelationKey,
  axEventScopedDedupeKey,
  axValidateEventEffectCreateRequest,
} from '@ax-llm/ax';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 4;
const MULTI_WORKER_CONFORMANCE = 'axevent-store-v4';
const MAX_FENCING_TOKEN = Number.MAX_SAFE_INTEGER;
const LEGACY_UNVERIFIABLE_INGRESS_PREFIX = 'legacy-unverifiable:';
const TERMINAL = [
  'waiting_event',
  'succeeded',
  'failed',
  'cancelled',
  'dead_lettered',
  'output_persistence_failed',
  'parked',
  'outcome_unknown',
] as const;

export interface AxSQLiteEventRetention {
  eventAndResultMs: number;
  runMetadataAndDeadLettersMs: number;
  completedContinuationsMs: number;
  /** Defaults to runMetadataAndDeadLettersMs for retention objects from schema v1. */
  settledEffectsMs?: number;
}

export const AX_SQLITE_EVENT_STANDARD_RETENTION: Readonly<AxSQLiteEventRetention> =
  {
    eventAndResultMs: 7 * 24 * 60 * 60 * 1_000,
    runMetadataAndDeadLettersMs: 30 * 24 * 60 * 60 * 1_000,
    completedContinuationsMs: 7 * 24 * 60 * 60 * 1_000,
    settledEffectsMs: 30 * 24 * 60 * 60 * 1_000,
  };

export interface AxSQLiteEventStoreOptions {
  filename: string;
  clock?: AxEventClock;
  busyTimeoutMs?: number;
  maxPendingDeliveries?: number;
  maxPendingBytes?: number;
  maxEventBytes?: number;
  maxInlinePayloadBytes?: number;
  payloadStore?: AxEventPayloadStore;
  retention: Readonly<AxSQLiteEventRetention>;
}

type DeliveryRow = {
  id: string;
  sequence: number;
  ingress_json: string;
  identity_scope: string;
  route_id: string;
  action: AxEventDelivery['action'];
  target_id: string | null;
  instance_key: string;
  status: AxEventDelivery['status'];
  attempt: number;
  available_at: number;
  accepted_at: number;
  claimed_by: string | null;
  run_id: string | null;
  error: string | null;
  size_bytes: number;
  retry_safety: AxEventDelivery['retrySafety'];
  ordering_mode: AxEventDelivery['ordering'];
  lease_expires_at: number | null;
  fencing_token: number;
  invocation_started: number;
};

export class AxSQLiteEventStore
  implements AxEventStore, AxEventEffectStore, AxProgramStateStore
{
  readonly capabilities = {
    durability: 'persistent',
    coordination: 'multi-worker',
    leases: true,
    transactions: true,
    compareAndSet: true,
    outputPersistence: true,
    effectLedger: true,
    conformance: {
      multiWorker: MULTI_WORKER_CONFORMANCE,
      schemaVersion: SCHEMA_VERSION,
    },
  } as const;

  private readonly db: Database.Database;
  private readonly clock: AxEventClock;
  private readonly maxPendingDeliveries: number;
  private readonly maxPendingBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxInlinePayloadBytes: number;

  constructor(private readonly options: Readonly<AxSQLiteEventStoreOptions>) {
    if (!options.retention) {
      throw new Error('AxSQLiteEventStore requires explicit retention');
    }
    this.clock = options.clock ?? new AxSystemEventClock();
    this.maxPendingDeliveries = options.maxPendingDeliveries ?? 100_000;
    this.maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 16 * 1024 * 1024;
    this.maxInlinePayloadBytes =
      options.maxInlinePayloadBytes ?? 16 * 1024 * 1024;
    this.db = new Database(options.filename);
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.prune(this.clock.now());
  }

  async enqueue(
    request: Readonly<AxEventEnqueueRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    const eventBytes = Buffer.byteLength(JSON.stringify(request.ingress));
    if (eventBytes > this.maxEventBytes) {
      throw new AxEventBackpressureError(
        `Event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`
      );
    }
    const deadline = this.clock.now() + request.publishTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const result = this.tryEnqueue(request);
      if (result) return result;
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) throw new AxEventBackpressureError();
      await this.clock.sleep(Math.min(25, remaining), signal);
    }
  }

  async claim(
    workerId: string,
    now: number,
    leaseMs = 30_000
  ): Promise<AxEventDelivery | undefined> {
    return this.db.transaction((): AxEventDelivery | undefined => {
      const row = this.db
        .prepare(
          `SELECT d.* FROM event_deliveries d
           WHERE (
             (d.status = 'queued' AND d.available_at <= ?)
             OR
             (d.status IN ('claimed','running') AND d.lease_expires_at <= ?)
           )
           AND (
             d.ordering_mode = 'relaxed'
             OR NOT EXISTS (
               SELECT 1 FROM event_deliveries earlier
               WHERE earlier.sequence < d.sequence
                 AND COALESCE(earlier.target_id, '') = COALESCE(d.target_id, '')
                 AND earlier.instance_key = d.instance_key
                 AND earlier.status NOT IN (${TERMINAL.map(() => '?').join(',')})
             )
           )
           ORDER BY d.sequence LIMIT 1`
        )
        .get(now, now, ...TERMINAL) as DeliveryRow | undefined;
      if (!row) return;
      const recovered = row.status !== 'queued';
      this.assertFencingTokenCanAdvance(row.id, row.fencing_token);
      const fencingToken = row.fencing_token + 1;
      const updated = this.db
        .prepare(
          `UPDATE event_deliveries
           SET status='claimed', claimed_by=?, lease_expires_at=?, fencing_token=?
           WHERE id=? AND fencing_token=?`
        )
        .run(workerId, now + leaseMs, fencingToken, row.id, row.fencing_token);
      if (updated.changes !== 1) return;
      return {
        ...this.rowToDelivery({
          ...row,
          status: 'claimed',
          claimed_by: workerId,
          lease_expires_at: now + leaseMs,
          fencing_token: fencingToken,
        }),
        ...(recovered ? { recoveredFromExpiredLease: true } : {}),
      };
    })();
  }

  async renewClaim(
    deliveryId: string,
    workerId: string,
    fencingToken: number,
    leaseExpiresAt: number
  ): Promise<void> {
    this.assertSafeFencingToken(deliveryId, fencingToken);
    const now = this.clock.now();
    if (leaseExpiresAt <= now) {
      throw new Error(`Stale event claim for ${deliveryId}`);
    }
    const result = this.db
      .prepare(
        `UPDATE event_deliveries SET lease_expires_at=?
         WHERE id=? AND claimed_by=? AND fencing_token=?
           AND status IN ('claimed','running')
           AND lease_expires_at > ?`
      )
      .run(leaseExpiresAt, deliveryId, workerId, fencingToken, now);
    if (result.changes !== 1)
      throw new Error(`Stale event claim for ${deliveryId}`);
  }

  async getDelivery(
    deliveryId: string
  ): Promise<Readonly<AxEventDelivery> | undefined> {
    const row = this.db
      .prepare('SELECT * FROM event_deliveries WHERE id=?')
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? this.rowToDelivery(row) : undefined;
  }

  async saveDelivery(delivery: Readonly<AxEventDelivery>): Promise<void> {
    if (!delivery.claimedBy || delivery.fencingToken === undefined) {
      throw new Error(`Stale event claim for ${delivery.id}`);
    }
    this.assertSafeFencingToken(delivery.id, delivery.fencingToken);
    const result = this.db
      .transaction(() =>
        this.db
          .prepare(
            `UPDATE event_deliveries SET
              status=?, attempt=?, available_at=?, run_id=?, error=?,
              invocation_started=?, retry_safety=?, ordering_mode=?
             WHERE id=? AND claimed_by=? AND fencing_token=?
               AND status IN ('claimed','running')
               AND lease_expires_at > ?`
          )
          .run(
            delivery.status,
            delivery.attempt,
            delivery.availableAt,
            delivery.runId ?? null,
            delivery.error ?? null,
            delivery.invocationStarted ? 1 : 0,
            delivery.retrySafety,
            delivery.ordering,
            delivery.id,
            delivery.claimedBy,
            delivery.fencingToken,
            this.clock.now()
          )
      )
      .immediate();
    if (result.changes !== 1) {
      throw new Error(`Stale or expired event claim for ${delivery.id}`);
    }
  }

  async saveRun(run: Readonly<AxEventRun>): Promise<void> {
    if (!run.claimedBy || run.fencingToken === undefined) {
      throw new Error(`Stale event claim for ${run.deliveryId}`);
    }
    this.assertSafeFencingToken(run.deliveryId, run.fencingToken);
    this.db
      .transaction(() =>
        this.assertActiveClaim(
          run.deliveryId,
          run.claimedBy!,
          run.fencingToken!
        )
      )
      .immediate();
    let stored: AxEventRun = structuredClone(run);
    const hasPayload = run.output !== undefined || run.chunks !== undefined;
    const payload = { output: run.output, chunks: run.chunks };
    if (
      hasPayload &&
      Buffer.byteLength(JSON.stringify(payload)) > this.maxInlinePayloadBytes
    ) {
      if (!this.options.payloadStore) {
        throw new Error(
          `output_persistence_failed: run ${run.id} exceeded ${this.maxInlinePayloadBytes} inline bytes`
        );
      }
      const outputRef = await this.options.payloadStore.put(
        `event-run:${run.id}:${run.fencingToken}:${randomUUID()}`,
        payload
      );
      stored = {
        ...stored,
        output: undefined,
        chunks: undefined,
        outputRef,
      };
    }
    this.db
      .transaction(() => {
        this.assertActiveClaim(
          run.deliveryId,
          run.claimedBy!,
          run.fencingToken!
        );
        this.db
          .prepare(
            `INSERT INTO event_runs(id, delivery_id, run_json, updated_at, finished_at)
             VALUES(?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               run_json=excluded.run_json, updated_at=excluded.updated_at,
               finished_at=excluded.finished_at`
          )
          .run(
            run.id,
            run.deliveryId,
            JSON.stringify(stored),
            this.clock.now(),
            run.finishedAt ?? null
          );
      })
      .immediate();
  }

  async getRun(runId: string): Promise<Readonly<AxEventRun> | undefined> {
    const row = this.db
      .prepare('SELECT run_json FROM event_runs WHERE id=?')
      .get(runId) as { run_json: string } | undefined;
    if (!row) return;
    const run = JSON.parse(row.run_json) as AxEventRun;
    if (run.outputRef && this.options.payloadStore) {
      const payload = (await this.options.payloadStore.get(run.outputRef)) as {
        output?: unknown;
        chunks?: AxEventRun['chunks'];
      };
      return { ...run, output: payload.output, chunks: payload.chunks };
    }
    return run;
  }

  async declareEffect(
    request: Readonly<AxEventEffectCreateRequest>,
    fence: Readonly<AxEventEffectFence>
  ): Promise<Readonly<AxEventEffect>> {
    axValidateEventEffectCreateRequest(request);
    const requestDigest = await axEventEffectRequestDigest(request);
    return this.db
      .transaction(() => {
        this.assertEffectFence(request.deliveryId, fence);
        const existing = this.db
          .prepare(
            `SELECT effect_json FROM event_effects
           WHERE delivery_id=? AND operation=? AND idempotency_key=?`
          )
          .get(request.deliveryId, request.operation, request.idempotencyKey) as
          | { effect_json: string }
          | undefined;
        if (existing) {
          const effect = JSON.parse(existing.effect_json) as AxEventEffect;
          if (effect.requestDigest !== requestDigest) {
            throw new Error(
              `Event effect intent conflicts with existing ${request.operation}:${request.idempotencyKey}`
            );
          }
          return effect;
        }
        const effect: AxEventEffect = {
          id: request.id,
          deliveryId: request.deliveryId,
          runId: request.runId,
          identityScope: request.identityScope,
          operation: request.operation,
          idempotencyKey: request.idempotencyKey,
          replaySafety: request.replaySafety ?? 'unknown',
          requestDigest,
          status: 'intent',
          ...(request.metadata
            ? { metadata: structuredClone(request.metadata) }
            : {}),
          createdAt: request.createdAt,
          updatedAt: request.createdAt,
          dispatchCount: 0,
          version: 1,
        };
        this.db
          .prepare(
            `INSERT INTO event_effects(
            id, delivery_id, operation, idempotency_key, status,
            effect_json, created_at, updated_at, settled_at
          ) VALUES(?,?,?,?,?,?,?,?,NULL)`
          )
          .run(
            effect.id,
            effect.deliveryId,
            effect.operation,
            effect.idempotencyKey,
            effect.status,
            JSON.stringify(effect),
            effect.createdAt,
            effect.updatedAt
          );
        return effect;
      })
      .immediate();
  }

  async transitionEffect(
    effectId: string,
    expectedVersion: number,
    transition: Readonly<AxEventEffectTransition>,
    fence: Readonly<AxEventEffectFence>
  ): Promise<Readonly<AxEventEffect>> {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            'SELECT delivery_id, effect_json FROM event_effects WHERE id=?'
          )
          .get(effectId) as
          | { delivery_id: string; effect_json: string }
          | undefined;
        if (!row) throw new Error(`Unknown event effect: ${effectId}`);
        this.assertEffectFence(row.delivery_id, fence);
        const current = JSON.parse(row.effect_json) as AxEventEffect;
        const next = axApplyEventEffectTransition(current, transition);
        if (next.version === current.version) return current;
        if (current.version !== expectedVersion) {
          throw new Error(`Stale event effect version for ${effectId}`);
        }
        this.db
          .prepare(
            `UPDATE event_effects SET status=?, effect_json=?, updated_at=?, settled_at=?
           WHERE id=?`
          )
          .run(
            next.status,
            JSON.stringify(next),
            next.updatedAt,
            next.settledAt ?? null,
            next.id
          );
        return next;
      })
      .immediate();
  }

  async listEffects(
    deliveryId: string
  ): Promise<readonly Readonly<AxEventEffect>[]> {
    return (
      this.db
        .prepare(
          `SELECT effect_json FROM event_effects
           WHERE delivery_id=? ORDER BY created_at, id`
        )
        .all(deliveryId) as { effect_json: string }[]
    ).map((row) => JSON.parse(row.effect_json) as AxEventEffect);
  }

  async registerContinuation(
    continuation: Readonly<AxEventContinuation>
  ): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO event_continuations
           (id, identity_scope, continuation_json, created_at, expires_at)
           VALUES(?,?,?,?,?)`
        )
        .run(
          continuation.id,
          continuation.identityScope,
          JSON.stringify(continuation),
          continuation.createdAt,
          continuation.expiresAt ?? null
        );
      const insert = this.db.prepare(
        'INSERT INTO event_continuation_keys(correlation_key, continuation_id) VALUES(?,?)'
      );
      for (const correlation of continuation.correlation) {
        insert.run(
          axEventScopedCorrelationKey(
            continuation.identityScope,
            correlation.kind,
            correlation.value
          ),
          continuation.id
        );
      }
    })();
  }

  async findContinuation(
    identityScope: string,
    correlation: Readonly<AxEventCorrelationKey>,
    now: number
  ): Promise<Readonly<AxEventContinuation> | undefined> {
    const row = this.db
      .prepare(
        `SELECT c.continuation_json, c.id, c.expires_at
         FROM event_continuation_keys k
         JOIN event_continuations c ON c.id=k.continuation_id
         WHERE k.correlation_key=? AND c.completed_at IS NULL`
      )
      .get(
        axEventScopedCorrelationKey(
          identityScope,
          correlation.kind,
          correlation.value
        )
      ) as
      | { continuation_json: string; id: string; expires_at: number | null }
      | undefined;
    if (!row) return;
    if (row.expires_at !== null && row.expires_at <= now) {
      await this.completeContinuation(row.id);
      return;
    }
    return JSON.parse(row.continuation_json) as AxEventContinuation;
  }

  async completeContinuation(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM event_continuation_keys WHERE continuation_id=?')
        .run(id);
      this.db
        .prepare(
          'UPDATE event_continuations SET completed_at=? WHERE id=? AND completed_at IS NULL'
        )
        .run(this.clock.now(), id);
    })();
  }

  async addDeadLetter(deadLetter: Readonly<AxEventDeadLetter>): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO event_dead_letters
         (id, delivery_id, dead_letter_json, created_at) VALUES(?,?,?,?)`
      )
      .run(
        deadLetter.id,
        deadLetter.deliveryId,
        JSON.stringify(deadLetter),
        deadLetter.createdAt
      );
  }

  async getDeadLetter(
    id: string
  ): Promise<Readonly<AxEventDeadLetter> | undefined> {
    const row = this.db
      .prepare('SELECT dead_letter_json FROM event_dead_letters WHERE id=?')
      .get(id) as { dead_letter_json: string } | undefined;
    return row
      ? (JSON.parse(row.dead_letter_json) as AxEventDeadLetter)
      : undefined;
  }

  async removeDeadLetter(id: string): Promise<void> {
    this.db.prepare('DELETE FROM event_dead_letters WHERE id=?').run(id);
  }

  async listDeadLetters(): Promise<readonly Readonly<AxEventDeadLetter>[]> {
    return (
      this.db
        .prepare(
          'SELECT dead_letter_json FROM event_dead_letters ORDER BY created_at'
        )
        .all() as { dead_letter_json: string }[]
    ).map((row) => JSON.parse(row.dead_letter_json) as AxEventDeadLetter);
  }

  async redriveDelivery(deliveryId: string, now: number): Promise<void> {
    const result = this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            `SELECT fencing_token FROM event_deliveries
             WHERE id=? AND status IN (${TERMINAL.map(() => '?').join(',')})`
          )
          .get(deliveryId, ...TERMINAL) as
          | { fencing_token: number }
          | undefined;
        if (!row) return;
        this.assertFencingTokenCanAdvance(deliveryId, row.fencing_token);
        return this.db
          .prepare(
            `UPDATE event_deliveries SET status='queued', attempt=0, available_at=?,
             claimed_by=NULL, run_id=NULL, error=NULL, lease_expires_at=NULL,
             invocation_started=0, fencing_token=?
             WHERE id=? AND fencing_token=?
               AND status IN (${TERMINAL.map(() => '?').join(',')})`
          )
          .run(
            now,
            row.fencing_token + 1,
            deliveryId,
            row.fencing_token,
            ...TERMINAL
          );
      })
      .immediate();
    if (!result || result.changes !== 1) {
      throw new Error(`Event delivery ${deliveryId} is not terminal`);
    }
  }

  async nextAvailableAt(now: number): Promise<number | undefined> {
    const row = this.db
      .prepare(
        `SELECT MIN(CASE
          WHEN status='queued' THEN available_at
          ELSE lease_expires_at END) AS next
         FROM event_deliveries
         WHERE status='queued' OR status IN ('claimed','running')`
      )
      .get() as { next: number | null };
    return row.next === null ? undefined : Math.max(now, row.next);
  }

  async waitForWork(signal?: AbortSignal): Promise<void> {
    while (!(await this.isIdle())) {
      if (signal?.aborted) throw signal.reason;
      await this.clock.sleep(25, signal);
      return;
    }
    await this.clock.sleep(25, signal);
  }

  async isIdle(): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM event_deliveries
         WHERE status NOT IN (${TERMINAL.map(() => '?').join(',')})`
      )
      .get(...TERMINAL) as { count: number };
    return row.count === 0;
  }

  async load(
    key: string
  ): Promise<Readonly<AxProgramStateEnvelope> | undefined> {
    const row = this.db
      .prepare('SELECT state_json FROM event_program_state WHERE state_key=?')
      .get(key) as { state_json: string } | undefined;
    return row
      ? (JSON.parse(row.state_json) as AxProgramStateEnvelope)
      : undefined;
  }

  async compareAndSet(
    key: string,
    expectedRevision: number | undefined,
    state: Readonly<Omit<AxProgramStateEnvelope, 'revision'>>,
    fence?: Readonly<{ deliveryId: string; fencingToken: number }>
  ): Promise<Readonly<AxProgramStateEnvelope>> {
    return this.db.transaction(() => {
      if (fence) this.assertFence(fence.deliveryId, fence.fencingToken);
      const current = this.db
        .prepare('SELECT revision FROM event_program_state WHERE state_key=?')
        .get(key) as { revision: number } | undefined;
      if (current?.revision !== expectedRevision) {
        throw new Error(
          `Program state compare-and-set failed for ${key}: expected ${String(expectedRevision)}, current ${String(current?.revision)}`
        );
      }
      const next: AxProgramStateEnvelope = {
        ...structuredClone(state),
        revision: (current?.revision ?? 0) + 1,
      };
      this.db
        .prepare(
          `INSERT INTO event_program_state(state_key, revision, state_json, updated_at)
           VALUES(?,?,?,?)
           ON CONFLICT(state_key) DO UPDATE SET revision=excluded.revision,
             state_json=excluded.state_json, updated_at=excluded.updated_at`
        )
        .run(key, next.revision, JSON.stringify(next), next.updatedAt);
      return next;
    })();
  }

  async delete(key: string): Promise<void> {
    this.db
      .prepare('DELETE FROM event_program_state WHERE state_key=?')
      .run(key);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private tryEnqueue(
    request: Readonly<AxEventEnqueueRequest>
  ): AxEventPublishReceipt | undefined {
    return this.db.transaction((): AxEventPublishReceipt | undefined => {
      const dedupeKey = axEventScopedDedupeKey(request.ingress);
      const ingressFingerprint = axEventIngressFingerprint(request.ingress);
      const duplicate = this.db
        .prepare(
          `SELECT event_id, delivery_ids_json, ingress_json, ingress_fingerprint
           FROM event_dedupe WHERE dedupe_key=?`
        )
        .get(dedupeKey) as
        | {
            event_id: string;
            delivery_ids_json: string;
            ingress_json: string | null;
            ingress_fingerprint: string | null;
          }
        | undefined;
      if (duplicate) {
        const legacyUnverifiable = duplicate.ingress_fingerprint?.startsWith(
          LEGACY_UNVERIFIABLE_INGRESS_PREFIX
        );
        if (legacyUnverifiable) {
          throw new Error(
            `Event identity cannot be verified against legacy ingress ${request.ingress.event.source}:${request.ingress.event.id}`
          );
        }
        if (duplicate.ingress_fingerprint !== ingressFingerprint) {
          throw new Error(
            `Event identity conflicts with previously accepted ingress ${request.ingress.event.source}:${request.ingress.event.id}`
          );
        }
        if (duplicate.ingress_json === null) {
          this.db
            .prepare(
              `UPDATE event_dedupe SET ingress_json=?
               WHERE dedupe_key=? AND ingress_json IS NULL`
            )
            .run(JSON.stringify(request.ingress), dedupeKey);
        }
        return {
          eventId: duplicate.event_id,
          accepted: true,
          duplicate: true,
          durability: 'persistent',
          deliveryIds: JSON.parse(duplicate.delivery_ids_json) as string[],
        };
      }
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes
           FROM event_deliveries WHERE status NOT IN (${TERMINAL.map(() => '?').join(',')})`
        )
        .get(...TERMINAL) as { count: number; bytes: number };
      const requiredBytes = request.deliveries.reduce(
        (sum, delivery) => sum + delivery.sizeBytes,
        0
      );
      if (
        pending.count + request.deliveries.length > this.maxPendingDeliveries ||
        pending.bytes + requiredBytes > this.maxPendingBytes
      ) {
        return;
      }
      const deliveryIds: string[] = [];
      const insert = this.db.prepare(
        `INSERT INTO event_deliveries(
          id, ingress_json, identity_scope, route_id, action, target_id,
          instance_key, status, attempt, available_at, accepted_at, size_bytes,
          retry_safety, ordering_mode
        ) VALUES(?,?,?,?,?,?,?,'queued',0,?,?,?,?,?)`
      );
      for (const descriptor of request.deliveries) {
        const id = randomUUID();
        deliveryIds.push(id);
        insert.run(
          id,
          JSON.stringify(request.ingress),
          axEventIdentityScope(request.ingress.identity),
          descriptor.routeId,
          descriptor.action,
          descriptor.targetId ?? null,
          descriptor.instanceKey,
          descriptor.availableAt ?? request.acceptedAt,
          request.acceptedAt,
          descriptor.sizeBytes,
          descriptor.retrySafety ?? 'unknown',
          descriptor.ordering ?? 'strict'
        );
      }
      this.db
        .prepare(
          `INSERT INTO event_dedupe(
             dedupe_key,event_id,delivery_ids_json,ingress_json,
             ingress_fingerprint,created_at
           ) VALUES(?,?,?,?,?,?)`
        )
        .run(
          dedupeKey,
          request.ingress.event.id,
          JSON.stringify(deliveryIds),
          JSON.stringify(request.ingress),
          ingressFingerprint,
          request.acceptedAt
        );
      return {
        eventId: request.ingress.event.id,
        accepted: true,
        duplicate: false,
        durability: 'persistent',
        deliveryIds,
      };
    })();
  }

  private rowToDelivery(row: DeliveryRow): AxEventDelivery {
    this.assertSafeFencingToken(row.id, row.fencing_token);
    return {
      id: row.id,
      sequence: row.sequence,
      ingress: JSON.parse(row.ingress_json),
      identityScope: row.identity_scope,
      routeId: row.route_id,
      action: row.action,
      ...(row.target_id ? { targetId: row.target_id } : {}),
      instanceKey: row.instance_key,
      status: row.status,
      attempt: row.attempt,
      availableAt: row.available_at,
      acceptedAt: row.accepted_at,
      ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.error ? { error: row.error } : {}),
      sizeBytes: row.size_bytes,
      retrySafety: row.retry_safety,
      ordering: row.ordering_mode,
      ...(row.lease_expires_at !== null
        ? { leaseExpiresAt: row.lease_expires_at }
        : {}),
      fencingToken: row.fencing_token,
      invocationStarted: row.invocation_started === 1,
    };
  }

  private assertFence(deliveryId: string, fencingToken?: number): void {
    if (fencingToken === undefined) return;
    this.assertSafeFencingToken(deliveryId, fencingToken);
    const row = this.db
      .prepare(
        `SELECT fencing_token, claimed_by, status, lease_expires_at
         FROM event_deliveries WHERE id=?`
      )
      .get(deliveryId) as
      | {
          fencing_token: number;
          claimed_by: string | null;
          status: AxEventDelivery['status'];
          lease_expires_at: number | null;
        }
      | undefined;
    if (
      !row ||
      !Number.isSafeInteger(row.fencing_token) ||
      row.fencing_token !== fencingToken ||
      row.claimed_by === null ||
      (row.status !== 'claimed' && row.status !== 'running') ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= this.clock.now()
    ) {
      throw new Error(
        `Stale or expired fencing token for event delivery ${deliveryId}`
      );
    }
  }

  private assertActiveClaim(
    deliveryId: string,
    claimedBy: string,
    fencingToken: number
  ): void {
    this.assertSafeFencingToken(deliveryId, fencingToken);
    const row = this.db
      .prepare(
        `SELECT 1 FROM event_deliveries
         WHERE id=? AND claimed_by=? AND fencing_token=?
           AND status IN ('claimed','running')
           AND lease_expires_at > ?`
      )
      .get(deliveryId, claimedBy, fencingToken, this.clock.now());
    if (!row) {
      throw new Error(`Stale or expired event claim for ${deliveryId}`);
    }
  }

  private assertEffectFence(
    deliveryId: string,
    fence: Readonly<AxEventEffectFence>
  ): void {
    if (deliveryId !== fence.deliveryId) {
      throw new Error(`Event effect fence does not own ${deliveryId}`);
    }
    this.assertSafeFencingToken(fence.deliveryId, fence.fencingToken);
    const row = this.db
      .prepare(
        `SELECT fencing_token, claimed_by, status, lease_expires_at
         FROM event_deliveries WHERE id=?`
      )
      .get(fence.deliveryId) as
      | {
          fencing_token: number;
          claimed_by: string | null;
          status: AxEventDelivery['status'];
          lease_expires_at: number | null;
        }
      | undefined;
    if (
      !row ||
      !Number.isSafeInteger(row.fencing_token) ||
      row.fencing_token !== fence.fencingToken ||
      row.claimed_by === null ||
      (row.status !== 'claimed' && row.status !== 'running') ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= this.clock.now()
    ) {
      throw new Error(
        `Stale or expired fencing token for event delivery ${fence.deliveryId}`
      );
    }
  }

  private assertSafeFencingToken(
    deliveryId: string,
    fencingToken: number
  ): void {
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 0) {
      throw new Error(
        `Unsafe fencing token for event delivery ${deliveryId}; rotate the delivery identity`
      );
    }
  }

  private assertFencingTokenCanAdvance(
    deliveryId: string,
    fencingToken: number
  ): void {
    this.assertSafeFencingToken(deliveryId, fencingToken);
    if (fencingToken >= MAX_FENCING_TOKEN) {
      throw new Error(
        `Fencing token exhausted for event delivery ${deliveryId}; rotate the delivery identity`
      );
    }
  }

  private migrate(): void {
    let version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error(`Unsupported AxSQLiteEventStore schema ${version}`);
    }
    if (version === 0) {
      this.db
        .transaction(() =>
          this.db.exec(`
        CREATE TABLE event_deliveries (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          ingress_json TEXT NOT NULL,
          identity_scope TEXT NOT NULL,
          route_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_id TEXT,
          instance_key TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          available_at INTEGER NOT NULL,
          accepted_at INTEGER NOT NULL,
          claimed_by TEXT,
          run_id TEXT,
          error TEXT,
          size_bytes INTEGER NOT NULL,
          retry_safety TEXT NOT NULL,
          ordering_mode TEXT NOT NULL,
          lease_expires_at INTEGER,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          invocation_started INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX event_delivery_claim ON event_deliveries(status, available_at, lease_expires_at, sequence);
        CREATE TABLE event_dedupe (
          dedupe_key TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          delivery_ids_json TEXT NOT NULL,
          ingress_json TEXT NOT NULL,
          ingress_fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE event_runs (
          id TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          run_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE TABLE event_continuations (
          id TEXT PRIMARY KEY,
          identity_scope TEXT NOT NULL,
          continuation_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          completed_at INTEGER
        );
        CREATE TABLE event_continuation_keys (
          correlation_key TEXT PRIMARY KEY,
          continuation_id TEXT NOT NULL REFERENCES event_continuations(id) ON DELETE CASCADE
        );
        CREATE TABLE event_dead_letters (
          id TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          dead_letter_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE event_program_state (
          state_key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE event_effects (
          id TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          effect_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          settled_at INTEGER,
          UNIQUE(delivery_id, operation, idempotency_key)
        );
        CREATE INDEX event_effects_delivery ON event_effects(delivery_id, status, created_at);
        PRAGMA user_version = 4;
      `)
        )
        .immediate();
      return;
    }
    if (version === 1) {
      this.db
        .transaction(() =>
          this.db.exec(`
        CREATE TABLE event_effects (
          id TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          effect_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          settled_at INTEGER,
          UNIQUE(delivery_id, operation, idempotency_key)
        );
        CREATE INDEX event_effects_delivery ON event_effects(delivery_id, status, created_at);
        PRAGMA user_version = 2;
      `)
        )
        .immediate();
      version = 2;
    }
    if (version === 2) {
      this.db
        .transaction(() => {
          const columns = new Set(
            (
              this.db.pragma('table_info(event_dedupe)') as {
                name: string;
              }[]
            ).map((column) => column.name)
          );
          if (!columns.has('ingress_json')) {
            this.db.exec(
              'ALTER TABLE event_dedupe ADD COLUMN ingress_json TEXT'
            );
          }
          if (!columns.has('ingress_fingerprint')) {
            this.db.exec(
              'ALTER TABLE event_dedupe ADD COLUMN ingress_fingerprint TEXT'
            );
          }
          const rows = this.db
            .prepare(
              `SELECT dedupe_key, delivery_ids_json, ingress_json
               FROM event_dedupe`
            )
            .all() as {
            dedupe_key: string;
            delivery_ids_json: string;
            ingress_json: string | null;
          }[];
          const lookup = this.db.prepare(
            'SELECT ingress_json FROM event_deliveries WHERE id=?'
          );
          const update = this.db.prepare(
            `UPDATE event_dedupe SET ingress_json=?, ingress_fingerprint=?
             WHERE dedupe_key=?`
          );
          for (const row of rows) {
            let ingressJson = row.ingress_json;
            if (!ingressJson) {
              const [deliveryId] = JSON.parse(
                row.delivery_ids_json
              ) as string[];
              const delivery = deliveryId
                ? (lookup.get(deliveryId) as
                    | { ingress_json: string }
                    | undefined)
                : undefined;
              ingressJson = delivery?.ingress_json ?? null;
            }
            const ingressFingerprint = ingressJson
              ? axEventIngressFingerprint(JSON.parse(ingressJson))
              : `${LEGACY_UNVERIFIABLE_INGRESS_PREFIX}${createHash('sha256')
                  .update(row.dedupe_key)
                  .digest('hex')}`;
            update.run(ingressJson, ingressFingerprint, row.dedupe_key);
          }
          const effects = this.db
            .prepare('SELECT id, effect_json FROM event_effects')
            .all() as { id: string; effect_json: string }[];
          const updateEffect = this.db.prepare(
            'UPDATE event_effects SET effect_json=? WHERE id=?'
          );
          for (const row of effects) {
            const effect = JSON.parse(row.effect_json) as AxEventEffect;
            if (effect.requestDigest) continue;
            effect.requestDigest = createHash('sha256')
              .update(
                axEventEffectRequestFingerprint({
                  id: effect.id,
                  deliveryId: effect.deliveryId,
                  runId: effect.runId,
                  identityScope: effect.identityScope,
                  operation: effect.operation,
                  idempotencyKey: effect.idempotencyKey,
                  replaySafety: effect.replaySafety,
                  metadata: effect.metadata,
                  createdAt: effect.createdAt,
                })
              )
              .digest('hex');
            updateEffect.run(JSON.stringify(effect), effect.id);
          }
          this.db.pragma('user_version = 3');
        })
        .immediate();
      version = 3;
    }
    if (version === 3) {
      this.db
        .transaction(() => {
          const columns = new Set(
            (
              this.db.pragma('table_info(event_dedupe)') as {
                name: string;
              }[]
            ).map((column) => column.name)
          );
          if (!columns.has('ingress_json')) {
            this.db.exec(
              'ALTER TABLE event_dedupe ADD COLUMN ingress_json TEXT'
            );
          }
          const missingFingerprint = this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM event_dedupe
               WHERE ingress_fingerprint IS NULL`
            )
            .get() as { count: number };
          if (missingFingerprint.count > 0) {
            throw new Error(
              'Cannot safely migrate event dedupe rows without canonical ingress fingerprints'
            );
          }
          this.db.pragma('user_version = 4');
        })
        .immediate();
    }
  }

  private prune(now: number): void {
    const retention = this.options.retention;
    this.db.transaction(() => {
      const eventCutoff = now - retention.eventAndResultMs;
      this.db
        .prepare(
          `DELETE FROM event_effects
           WHERE settled_at IS NOT NULL AND settled_at < ?`
        )
        .run(
          now -
            Math.max(
              retention.eventAndResultMs,
              retention.settledEffectsMs ??
                retention.runMetadataAndDeadLettersMs
            )
        );
      this.db
        .prepare('DELETE FROM event_dedupe WHERE created_at < ?')
        .run(eventCutoff);
      this.db
        .prepare(
          `UPDATE event_runs
           SET run_json=json_remove(run_json, '$.output', '$.chunks')
           WHERE finished_at IS NOT NULL AND finished_at < ?`
        )
        .run(eventCutoff);
      this.db
        .prepare(
          `DELETE FROM event_deliveries
           WHERE accepted_at < ? AND status IN (${TERMINAL.map(() => '?').join(',')})
             AND NOT EXISTS (
               SELECT 1 FROM event_effects e
               WHERE e.delivery_id=event_deliveries.id
             )`
        )
        .run(eventCutoff, ...TERMINAL);
      this.db
        .prepare('DELETE FROM event_runs WHERE updated_at < ?')
        .run(now - retention.runMetadataAndDeadLettersMs);
      this.db
        .prepare('DELETE FROM event_dead_letters WHERE created_at < ?')
        .run(now - retention.runMetadataAndDeadLettersMs);
      this.db
        .prepare(
          'DELETE FROM event_continuations WHERE completed_at IS NOT NULL AND completed_at < ?'
        )
        .run(now - retention.completedContinuationsMs);
    })();
  }
}
