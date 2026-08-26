import { createHash, randomUUID } from 'node:crypto';
import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventContinuation,
  type AxEventContinuationEnqueueRequest,
  type AxEventCorrelationKey,
  type AxEventDeadLetter,
  type AxEventDelivery,
  type AxEventEffect,
  type AxEventEffectCreateRequest,
  type AxEventEffectFence,
  type AxEventEffectStore,
  type AxEventEffectTransition,
  type AxEventEnqueueRequest,
  AxEventOutputPersistenceError,
  type AxEventPayloadStore,
  type AxEventPublishReceipt,
  type AxEventRun,
  type AxEventStagedPayloadStore,
  type AxEventStore,
  type AxEventVerifierTransitionRecord,
  type AxEventVerifierTransitionRequest,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
  AxSystemEventClock,
  axApplyEventEffectTransition,
  axEventCanonicalJson,
  axEventContinuationFingerprint,
  axEventEffectRequestDigest,
  axEventEffectRequestFingerprint,
  axEventIdentityScope,
  axEventIngressFingerprint,
  axEventScopedCorrelationKey,
  axEventScopedDedupeKey,
  axIsEventOutputPersistenceError,
  axValidateEventEffectCreateRequest,
} from '@ax-llm/ax';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 7;
const MULTI_WORKER_CONFORMANCE = 'axevent-store-v7';
const VERIFIER_MIGRATION_CLEANUP_KEY = 'verifier-v2-cleanup-pending';
const MAX_FENCING_TOKEN = Number.MAX_SAFE_INTEGER;
const LEGACY_UNVERIFIABLE_INGRESS_PREFIX = 'legacy-unverifiable:';
const TERMINAL = [
  'waiting_event',
  'succeeded',
  'failed',
  'verification_failed',
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
  /** Required to offload payloads; legacy put/delete stores remain read-only. */
  payloadStaging?: Readonly<AxSQLiteEventPayloadStagingPolicy>;
  retention: Readonly<AxSQLiteEventRetention>;
}

export interface AxSQLiteEventPayloadStagingPolicy {
  maxOutstandingCount: number;
  maxOutstandingBytes: number;
  maxPayloadBytes: number;
  stageTtlMs: number;
  persistenceTimeoutMs: number;
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
  admitted_continuation_json: string | null;
};

type PayloadStageRow = {
  stage_id: string;
  run_id: string;
  delivery_id: string;
  fencing_token: number;
  reference: string | null;
  size_bytes: number;
  expires_at: number;
  state: 'staging' | 'commit_pending' | 'committed' | 'abort_pending';
};

type AxSQLiteEventMigrationShape = Readonly<{
  empty: boolean;
  effects: 'absent' | 'ledger' | 'fingerprint' | 'payload' | 'admission';
  verifier: 'absent' | 'legacy-v2' | 'compact-v3' | 'current-v4';
}>;

function parseContinuationAdmission(
  deliveryId: string,
  json: string
): AxEventContinuation {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `outcome_unknown: continuation admission for ${deliveryId} is malformed`,
      { cause: error }
    );
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as AxEventContinuation).id !== 'string' ||
    typeof (value as AxEventContinuation).targetId !== 'string' ||
    typeof (value as AxEventContinuation).routeId !== 'string' ||
    typeof (value as AxEventContinuation).instanceKey !== 'string' ||
    typeof (value as AxEventContinuation).identityScope !== 'string' ||
    !Array.isArray((value as AxEventContinuation).correlation) ||
    !(value as AxEventContinuation).correlation.every(
      (correlation) =>
        typeof correlation?.kind === 'string' &&
        typeof correlation.value === 'string'
    ) ||
    !Number.isFinite((value as AxEventContinuation).createdAt) ||
    ((value as AxEventContinuation).expiresAt !== undefined &&
      !Number.isFinite((value as AxEventContinuation).expiresAt))
  ) {
    throw new Error(
      `outcome_unknown: continuation admission for ${deliveryId} is malformed`
    );
  }
  return value as AxEventContinuation;
}

function safeParseContinuationAdmission(
  deliveryId: string,
  json: string | null
): AxEventContinuation | undefined {
  if (json === null) return;
  try {
    return parseContinuationAdmission(deliveryId, json);
  } catch {
    return;
  }
}

function parseVerifierReceipt(
  operationId: string,
  json: string,
  childDeliveryId: string,
  childEventId?: string
): AxEventPublishReceipt {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Verifier transition receipt is malformed: ${operationId}`,
      { cause: error }
    );
  }
  const receipt = value as Partial<AxEventPublishReceipt>;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof receipt.eventId !== 'string' ||
    receipt.eventId.length === 0 ||
    (childEventId !== undefined && receipt.eventId !== childEventId) ||
    receipt.accepted !== true ||
    receipt.duplicate !== false ||
    receipt.durability !== 'persistent' ||
    !Array.isArray(receipt.deliveryIds) ||
    receipt.deliveryIds.length !== 1 ||
    receipt.deliveryIds[0] !== childDeliveryId
  ) {
    throw new Error(`Verifier transition receipt is malformed: ${operationId}`);
  }
  return value as AxEventPublishReceipt;
}

function assertContinuationCorrelation(
  deliveryId: string,
  continuation: Readonly<AxEventContinuation>,
  identityScope: string,
  correlation: Readonly<AxEventCorrelationKey>
): void {
  if (
    continuation.identityScope !== identityScope ||
    !continuation.correlation.some(
      (value) =>
        value.kind === correlation.kind && value.value === correlation.value
    )
  ) {
    throw new Error(
      `outcome_unknown: continuation admission for ${deliveryId} conflicts with its resume correlation`
    );
  }
}

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
    verifierTransitions: 'axevent-verifier-transition-v2',
  } as const;

  private readonly db: Database.Database;
  readonly clock: AxEventClock;
  private readonly maxPendingDeliveries: number;
  private readonly maxPendingBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxInlinePayloadBytes: number;
  private readonly payloadStaging?: Readonly<AxSQLiteEventPayloadStagingPolicy>;
  private closed = false;

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
    this.payloadStaging = options.payloadStaging;
    if (this.payloadStaging) this.validatePayloadStaging(this.payloadStaging);
    this.db = new Database(options.filename);
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('secure_delete = ON');
    this.migrate();
    this.completeVerifierMigrationCleanup();
    this.prune(this.clock.now());
  }

  async enqueue(
    request: Readonly<AxEventEnqueueRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    this.assertWritable(signal);
    const eventBytes = Buffer.byteLength(JSON.stringify(request.ingress));
    if (eventBytes > this.maxEventBytes) {
      throw new AxEventBackpressureError(
        `Event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`
      );
    }
    const deadline = this.clock.now() + request.publishTimeoutMs;
    for (;;) {
      // tryEnqueue is one synchronous SQLite transaction. This final check is
      // therefore immediately adjacent to the mutation boundary.
      this.assertWritable(signal);
      const result = this.tryEnqueue(request);
      if (result) return result;
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) throw new AxEventBackpressureError();
      await this.clock.sleep(Math.min(25, remaining), signal);
    }
  }

  async enqueueContinuation(
    request: Readonly<AxEventContinuationEnqueueRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    const eventBytes = Buffer.byteLength(
      JSON.stringify(request.enqueue.ingress)
    );
    if (eventBytes > this.maxEventBytes) {
      throw new AxEventBackpressureError(
        `Event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`
      );
    }
    const deadline = this.clock.now() + request.enqueue.publishTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const result = this.db.transaction(() => {
        const receipt = this.tryEnqueue(request.enqueue);
        if (!receipt) return;
        if (receipt.duplicate) {
          this.assertContinuationMatch(request.continuation);
        } else {
          this.insertContinuation(request.continuation);
        }
        return receipt;
      })();
      if (result) return result;
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) throw new AxEventBackpressureError();
      await this.clock.sleep(Math.min(25, remaining), signal);
    }
  }

  async transitionVerifier(
    request: Readonly<AxEventVerifierTransitionRequest>,
    signal?: AbortSignal
  ): Promise<AxEventPublishReceipt> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Verifier transition cancelled');
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(request.child.ingress));
    if (eventBytes > this.maxEventBytes) {
      throw new AxEventBackpressureError(
        `Event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`
      );
    }
    const requestCommitment = this.canonicalCommitment(request);
    const expectedChildCommitment = this.canonicalCommitment(
      this.verifierChildProjection(request)
    );
    return this.db.transaction(() => {
      const journal = this.readVerifierTransition(request.operationId);
      if (journal) {
        this.assertVerifierTransitionRequest(
          journal,
          request,
          requestCommitment,
          expectedChildCommitment
        );
        return { ...journal.receipt, duplicate: true };
      }
      const parent = this.db
        .prepare('SELECT * FROM event_deliveries WHERE id=?')
        .get(request.parent.delivery.id) as DeliveryRow | undefined;
      if (
        !parent ||
        parent.fencing_token !== request.parent.expectedFencingToken ||
        (parent.status !== 'claimed' && parent.status !== 'running')
      ) {
        throw new Error(
          `Stale verifier transition for ${request.parent.delivery.id}`
        );
      }
      if (
        request.parent.delivery.status !== 'waiting_event' ||
        request.parent.run.status !== 'waiting_event' ||
        request.child.deliveries.length !== 1
      ) {
        throw new Error('Verifier transition requires one waiting child');
      }

      this.assertNoNonterminalEffects(request.parent.delivery.id);
      this.assertVerifierContinuationConsumption(
        request,
        this.rowToDelivery(parent)
      );
      this.updateDelivery(request.parent.delivery);
      const receipt = this.tryEnqueue(request.child, [request.childDeliveryId]);
      if (!receipt) throw new AxEventBackpressureError();
      if (receipt.duplicate) {
        throw new Error(
          `Verifier transition child is already owned: ${request.childDeliveryId}`
        );
      }
      this.insertContinuation(request.continuation);
      if (request.consumeContinuationId) {
        this.completeContinuationNow(request.consumeContinuationId);
      }
      this.saveTransitionRun(request.parent.run);
      const child = this.db
        .prepare('SELECT * FROM event_deliveries WHERE id=?')
        .get(request.childDeliveryId) as DeliveryRow | undefined;
      if (!child)
        throw new Error('Verifier transition child was not persisted');
      const persistedChild = this.rowToDelivery(child);
      const childCommitment = this.canonicalCommitment(
        this.persistedChildProjection(persistedChild)
      );
      if (childCommitment !== expectedChildCommitment) {
        throw new Error('Verifier transition child does not match request');
      }
      const record: AxEventVerifierTransitionRecord = {
        operationId: request.operationId,
        requestCommitment,
        receipt,
        childDeliveryId: request.childDeliveryId,
        childCommitment,
      };
      this.db
        .prepare(
          `INSERT INTO event_verifier_transitions
           (operation_id, request_commitment, receipt_json, child_delivery_id,
            child_commitment, created_at)
           VALUES(?,?,?,?,?,?)`
        )
        .run(
          request.operationId,
          record.requestCommitment,
          JSON.stringify(record.receipt),
          record.childDeliveryId,
          record.childCommitment,
          this.clock.now()
        );
      return receipt;
    })();
  }

  async confirmVerifierTransition(
    request: Readonly<AxEventVerifierTransitionRequest>
  ): Promise<Readonly<AxEventPublishReceipt> | undefined> {
    const requestCommitment = this.canonicalCommitment(request);
    const expectedChildCommitment = this.canonicalCommitment(
      this.verifierChildProjection(request)
    );
    const record = this.readVerifierTransition(request.operationId);
    if (!record) return;
    this.assertVerifierTransitionRequest(
      record,
      request,
      requestCommitment,
      expectedChildCommitment
    );
    const child = this.db
      .prepare('SELECT * FROM event_deliveries WHERE id=?')
      .get(record.childDeliveryId) as DeliveryRow | undefined;
    if (
      child &&
      this.canonicalCommitment(
        this.persistedChildProjection(this.rowToDelivery(child))
      ) !== record.childCommitment
    ) {
      throw new Error(
        `Verifier transition child is corrupt: ${request.operationId}`
      );
    }
    return record.receipt;
  }

  async claim(
    workerId: string,
    now: number,
    leaseMs = 30_000
  ): Promise<AxEventDelivery | undefined> {
    await this.reconcilePayloadStages();
    return this.db.transaction((): AxEventDelivery | undefined => {
      const row = this.db
        .prepare(
          `SELECT d.* FROM event_deliveries d
           WHERE (
             (d.status = 'queued' AND d.available_at <= ?)
             OR
             (d.status IN ('claimed','running') AND d.lease_expires_at <= ?)
           )
           AND NOT EXISTS (
             SELECT 1 FROM event_payload_stages payload
             WHERE payload.delivery_id=d.id
               AND payload.state!='committed'
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
      const recovered =
        row.status !== 'queued' ||
        (row.run_id !== null && row.invocation_started === 1);
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
    leaseExpiresAt: number,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertWritable(signal);
    this.assertSafeFencingToken(deliveryId, fencingToken);
    const now = this.clock.now();
    if (leaseExpiresAt <= now) {
      throw new Error(`Stale event claim for ${deliveryId}`);
    }
    // No await separates this revocation check from the fenced SQL update.
    this.assertWritable(signal);
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
    this.db.transaction(() => this.updateDelivery(delivery)).immediate();
  }

  private updateDelivery(delivery: Readonly<AxEventDelivery>): void {
    if (!delivery.claimedBy || delivery.fencingToken === undefined) {
      throw new Error(`Stale event claim for ${delivery.id}`);
    }
    this.assertSafeFencingToken(delivery.id, delivery.fencingToken);
    if (
      delivery.status === 'succeeded' ||
      delivery.status === 'waiting_event'
    ) {
      this.assertNoNonterminalEffects(delivery.id);
    }
    const persisted = this.db
      .prepare(
        `SELECT admitted_continuation_json FROM event_deliveries
         WHERE id=? AND claimed_by=? AND fencing_token=?
           AND status IN ('claimed','running')
           AND lease_expires_at > ?`
      )
      .get(
        delivery.id,
        delivery.claimedBy,
        delivery.fencingToken,
        this.clock.now()
      ) as { admitted_continuation_json: string | null } | undefined;
    if (!persisted) {
      throw new Error(`Stale or expired event claim for ${delivery.id}`);
    }
    if (delivery.admittedContinuation) {
      if (persisted.admitted_continuation_json === null) {
        throw new Error(
          `Continuation admission for ${delivery.id} must be created atomically`
        );
      }
      const admitted = parseContinuationAdmission(
        delivery.id,
        persisted.admitted_continuation_json
      );
      if (
        axEventContinuationFingerprint(admitted) !==
        axEventContinuationFingerprint(delivery.admittedContinuation)
      ) {
        throw new Error(
          `Continuation admission for ${delivery.id} is immutable`
        );
      }
    }
    const result = this.db
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
      );
    if (result.changes !== 1) {
      throw new Error(`Stale or expired event claim for ${delivery.id}`);
    }
  }

  async saveRun(run: Readonly<AxEventRun>): Promise<void> {
    if (!run.claimedBy || run.fencingToken === undefined) {
      throw new Error(`Stale event claim for ${run.deliveryId}`);
    }
    this.assertSafeFencingToken(run.deliveryId, run.fencingToken);
    await this.reconcilePayloadStages();
    this.db
      .transaction(() =>
        this.assertActiveClaim(
          run.deliveryId,
          run.claimedBy!,
          run.fencingToken!
        )
      )
      .immediate();
    const stored: AxEventRun = structuredClone(run);
    const hasPayload = run.output !== undefined || run.chunks !== undefined;
    const payload = { output: run.output, chunks: run.chunks };
    let payloadBytes = 0;
    if (hasPayload) {
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(payload));
      } catch (error) {
        throw new AxEventOutputPersistenceError(
          `run ${run.id} output is not JSON-serializable`,
          'preflight',
          { cause: error }
        );
      }
    }
    if (hasPayload && payloadBytes > this.maxInlinePayloadBytes) {
      if (run.outputRef && this.hasCommittedPayload(run.id, run.outputRef)) {
        try {
          this.saveRunMetadataWithCommittedPayload(run);
        } catch (error) {
          throw this.outputPersistenceError('recovery', run.id, error);
        }
        return;
      }
      await this.saveStagedRun(run, payload, payloadBytes);
      return;
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
    await this.abortSupersededPayloadStages(run.id);
  }

  async getRun(runId: string): Promise<Readonly<AxEventRun> | undefined> {
    await this.reconcilePayloadStages();
    const row = this.db
      .prepare('SELECT run_json FROM event_runs WHERE id=?')
      .get(runId) as { run_json: string } | undefined;
    if (!row) return;
    const run = JSON.parse(row.run_json) as AxEventRun;
    if (run.outputRef && this.options.payloadStore) {
      const pending = this.db
        .prepare(
          `SELECT 1 FROM event_payload_stages
           WHERE run_id=? AND reference=? AND state='commit_pending'`
        )
        .get(run.id, run.outputRef);
      if (pending) return run;
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
    this.db.transaction(() => this.insertContinuation(continuation))();
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

  async admitContinuation(
    deliveryId: string,
    workerId: string,
    fencingToken: number,
    identityScope: string,
    correlation: Readonly<AxEventCorrelationKey>,
    now: number
  ): Promise<Readonly<AxEventContinuation> | undefined> {
    this.assertSafeFencingToken(deliveryId, fencingToken);
    return this.db
      .transaction((): AxEventContinuation | undefined => {
        const delivery = this.db
          .prepare(
            `SELECT admitted_continuation_json, identity_scope
             FROM event_deliveries
             WHERE id=? AND claimed_by=? AND fencing_token=?
               AND status IN ('claimed','running')
               AND lease_expires_at > ?`
          )
          .get(deliveryId, workerId, fencingToken, this.clock.now()) as
          | {
              admitted_continuation_json: string | null;
              identity_scope: string;
            }
          | undefined;
        if (!delivery) {
          throw new Error(`Stale or expired event claim for ${deliveryId}`);
        }
        if (delivery.identity_scope !== identityScope) {
          throw new Error(
            `Continuation admission identity does not own delivery ${deliveryId}`
          );
        }
        if (delivery.admitted_continuation_json !== null) {
          const admitted = parseContinuationAdmission(
            deliveryId,
            delivery.admitted_continuation_json
          );
          assertContinuationCorrelation(
            deliveryId,
            admitted,
            identityScope,
            correlation
          );
          const owner = this.db
            .prepare(
              'SELECT admitted_delivery_id FROM event_continuations WHERE id=?'
            )
            .get(admitted.id) as
            | { admitted_delivery_id: string | null }
            | undefined;
          if (
            owner?.admitted_delivery_id &&
            owner.admitted_delivery_id !== deliveryId
          ) {
            throw new Error(
              `outcome_unknown: continuation ${admitted.id} is bound to another delivery`
            );
          }
          return admitted;
        }

        const row = this.db
          .prepare(
            `SELECT c.id, c.continuation_json, c.expires_at,
                    c.admitted_delivery_id
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
          | {
              id: string;
              continuation_json: string;
              expires_at: number | null;
              admitted_delivery_id: string | null;
            }
          | undefined;
        if (!row) return;
        if (row.expires_at !== null && row.expires_at <= now) {
          this.db
            .prepare(
              'DELETE FROM event_continuation_keys WHERE continuation_id=?'
            )
            .run(row.id);
          this.db
            .prepare(
              `UPDATE event_continuations SET completed_at=?
               WHERE id=? AND completed_at IS NULL`
            )
            .run(now, row.id);
          return;
        }
        if (
          row.admitted_delivery_id &&
          row.admitted_delivery_id !== deliveryId
        ) {
          return;
        }
        const admitted = parseContinuationAdmission(
          deliveryId,
          row.continuation_json
        );
        assertContinuationCorrelation(
          deliveryId,
          admitted,
          identityScope,
          correlation
        );
        const continuationUpdate = this.db
          .prepare(
            `UPDATE event_continuations SET admitted_delivery_id=?
             WHERE id=? AND completed_at IS NULL
               AND (admitted_delivery_id IS NULL OR admitted_delivery_id=?)`
          )
          .run(deliveryId, row.id, deliveryId);
        if (continuationUpdate.changes !== 1) return;
        const deliveryUpdate = this.db
          .prepare(
            `UPDATE event_deliveries SET admitted_continuation_json=?
             WHERE id=? AND claimed_by=? AND fencing_token=?
               AND status IN ('claimed','running')
               AND lease_expires_at > ?
               AND admitted_continuation_json IS NULL`
          )
          .run(
            JSON.stringify(admitted),
            deliveryId,
            workerId,
            fencingToken,
            this.clock.now()
          );
        if (deliveryUpdate.changes !== 1) {
          throw new Error(
            `Stale or conflicting continuation admission for ${deliveryId}`
          );
        }
        return admitted;
      })
      .immediate();
  }

  async saveDeliveryAndCompleteContinuation(
    delivery: Readonly<AxEventDelivery>
  ): Promise<void> {
    this.assertWritable();
    if (
      delivery.status !== 'succeeded' &&
      delivery.status !== 'waiting_event'
    ) {
      throw new Error(
        `Event delivery ${delivery.id} must be successfully terminal before continuation completion`
      );
    }
    if (!delivery.claimedBy || delivery.fencingToken === undefined) {
      throw new Error(`Stale event claim for ${delivery.id}`);
    }
    this.assertSafeFencingToken(delivery.id, delivery.fencingToken);
    const result = this.db
      .transaction(() => {
        this.assertNoNonterminalEffects(delivery.id);
        const persisted = this.db
          .prepare(
            `SELECT admitted_continuation_json FROM event_deliveries
             WHERE id=? AND claimed_by=? AND fencing_token=?
               AND status IN ('claimed','running')
               AND lease_expires_at > ?`
          )
          .get(
            delivery.id,
            delivery.claimedBy,
            delivery.fencingToken,
            this.clock.now()
          ) as { admitted_continuation_json: string | null } | undefined;
        if (!persisted) return { changes: 0 };
        if (
          persisted.admitted_continuation_json === null ||
          !delivery.admittedContinuation
        ) {
          throw new Error(
            `outcome_unknown: continuation admission for ${delivery.id} is missing`
          );
        }
        const admitted = parseContinuationAdmission(
          delivery.id,
          persisted.admitted_continuation_json
        );
        if (
          axEventContinuationFingerprint(admitted) !==
          axEventContinuationFingerprint(delivery.admittedContinuation)
        ) {
          throw new Error(
            `outcome_unknown: continuation admission for ${delivery.id} changed before completion`
          );
        }
        const continuation = this.db
          .prepare(
            `SELECT continuation_json, admitted_delivery_id
             FROM event_continuations WHERE id=?`
          )
          .get(admitted.id) as
          | {
              continuation_json: string;
              admitted_delivery_id: string | null;
            }
          | undefined;
        if (
          continuation?.admitted_delivery_id &&
          continuation.admitted_delivery_id !== delivery.id
        ) {
          throw new Error(
            `outcome_unknown: continuation ${admitted.id} is bound to another delivery`
          );
        }
        if (
          continuation &&
          axEventContinuationFingerprint(
            parseContinuationAdmission(
              delivery.id,
              continuation.continuation_json
            )
          ) !== axEventContinuationFingerprint(admitted)
        ) {
          throw new Error(
            `outcome_unknown: continuation ${admitted.id} no longer matches its delivery admission`
          );
        }

        const deliveryUpdate = this.db
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
          );
        if (deliveryUpdate.changes !== 1) return deliveryUpdate;
        this.db
          .prepare(
            'DELETE FROM event_continuation_keys WHERE continuation_id=?'
          )
          .run(admitted.id);
        this.db
          .prepare(
            `UPDATE event_continuations SET completed_at=COALESCE(completed_at, ?)
             WHERE id=?
               AND (admitted_delivery_id IS NULL OR admitted_delivery_id=?)`
          )
          .run(this.clock.now(), admitted.id, delivery.id);
        return deliveryUpdate;
      })
      .immediate();
    if (result.changes !== 1) {
      throw new Error(`Stale or expired event claim for ${delivery.id}`);
    }
  }

  async completeContinuation(id: string): Promise<void> {
    this.db.transaction(() => this.completeContinuationNow(id))();
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

  async redriveDelivery(
    deliveryId: string,
    now: number,
    options?: Readonly<{ preserveRun?: boolean }>
  ): Promise<void> {
    const result = this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            `SELECT fencing_token, run_id FROM event_deliveries
             WHERE id=? AND status IN (${TERMINAL.map(() => '?').join(',')})`
          )
          .get(deliveryId, ...TERMINAL) as
          | { fencing_token: number; run_id: string | null }
          | undefined;
        if (!row) return;
        if (options?.preserveRun && !row.run_id) {
          throw new Error(
            `Event delivery ${deliveryId} has no run to preserve`
          );
        }
        this.assertFencingTokenCanAdvance(deliveryId, row.fencing_token);
        return this.db
          .prepare(
            `UPDATE event_deliveries SET status='queued', attempt=0, available_at=?,
             claimed_by=NULL, run_id=?, error=NULL, lease_expires_at=NULL,
             invocation_started=?, fencing_token=?
             WHERE id=? AND fencing_token=?
               AND status IN (${TERMINAL.map(() => '?').join(',')})`
          )
          .run(
            now,
            options?.preserveRun ? row.run_id : null,
            options?.preserveRun ? 1 : 0,
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
    if (this.closed) return;
    // Establish a store epoch before asynchronous close reconciliation. Any
    // delayed public mutation that resumes later must fail before touching DB.
    this.closed = true;
    try {
      await this.reconcilePayloadStages();
    } finally {
      this.db.close();
    }
  }

  private async saveStagedRun(
    run: Readonly<AxEventRun>,
    payload: unknown,
    payloadBytes: number
  ): Promise<void> {
    const payloadStore = this.stagedPayloadStore('preflight');
    const policy = this.payloadStaging!;
    if (payloadBytes > policy.maxPayloadBytes) {
      throw new AxEventOutputPersistenceError(
        `run ${run.id} is ${payloadBytes} bytes; staged maximum is ${policy.maxPayloadBytes}`,
        'preflight'
      );
    }
    this.assertPayloadLeaseBudget(
      run.deliveryId,
      run.claimedBy!,
      run.fencingToken!,
      policy.persistenceTimeoutMs * 2
    );

    const now = this.clock.now();
    const stageId = `event-payload-stage:${randomUUID()}`;
    const expiresAt = now + policy.stageTtlMs;
    this.db
      .transaction(() => {
        this.assertActiveClaim(
          run.deliveryId,
          run.claimedBy!,
          run.fencingToken!
        );
        const outstanding = this.db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
             FROM event_payload_stages WHERE state != 'committed'`
          )
          .get() as { count: number; bytes: number };
        if (
          outstanding.count >= policy.maxOutstandingCount ||
          outstanding.bytes + payloadBytes > policy.maxOutstandingBytes
        ) {
          throw new AxEventOutputPersistenceError(
            `staged payload capacity is exhausted (${outstanding.count}/${policy.maxOutstandingCount} stages, ${outstanding.bytes}/${policy.maxOutstandingBytes} bytes)`,
            'preflight'
          );
        }
        this.db
          .prepare(
            `INSERT INTO event_payload_stages(
               stage_id, run_id, delivery_id, fencing_token, reference,
               size_bytes, expires_at, state, created_at, updated_at
             ) VALUES(?,?,?,?,NULL,?,?, 'staging',?,?)`
          )
          .run(
            stageId,
            run.id,
            run.deliveryId,
            run.fencingToken,
            payloadBytes,
            expiresAt,
            now,
            now
          );
      })
      .immediate();

    let reference: string;
    try {
      const staged = await this.withPayloadDeadline(
        'stage',
        policy.persistenceTimeoutMs,
        (signal) =>
          payloadStore.stage({
            stageId,
            key: `event-run:${run.id}:${run.fencingToken}`,
            value: payload,
            sizeBytes: payloadBytes,
            expiresAt,
            signal,
          })
      );
      if (!staged.reference.trim()) {
        throw new Error('payload stage returned an empty reference');
      }
      reference = staged.reference;
    } catch (error) {
      try {
        this.quarantinePayloadStageById(stageId, 'payload staging failed');
        await this.abortPayloadStage(stageId, payloadStore);
      } catch {
        // The typed error below remains the stable runtime classification.
      }
      throw this.outputPersistenceError('stage', run.id, error);
    }

    try {
      this.db
        .transaction(() => {
          this.assertActiveClaim(
            run.deliveryId,
            run.claimedBy!,
            run.fencingToken!
          );
          const stored: AxEventRun = {
            ...structuredClone(run),
            output: undefined,
            chunks: undefined,
            outputRef: reference,
          };
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
          const updated = this.db
            .prepare(
              `UPDATE event_payload_stages
               SET reference=?, state='commit_pending', updated_at=?
               WHERE stage_id=? AND state='staging'`
            )
            .run(reference, this.clock.now(), stageId);
          if (updated.changes !== 1) {
            throw new Error(`Payload stage reservation was lost for ${run.id}`);
          }
        })
        .immediate();
    } catch (error) {
      try {
        this.quarantinePayloadStageById(
          stageId,
          'payload ownership was lost after staging'
        );
        await this.abortPayloadStage(stageId, payloadStore);
      } catch {
        // The typed error below remains the stable runtime classification.
      }
      throw this.outputPersistenceError('stage', run.id, error);
    }

    try {
      await this.withPayloadDeadline(
        'commit',
        policy.persistenceTimeoutMs,
        (signal) => payloadStore.commit(stageId, signal)
      );
    } catch (error) {
      // Provider commit may have completed even when its response is lost.
      // Keep commit_pending and the finalizing run for fenced restart recovery.
      throw this.outputPersistenceError('commit', run.id, error);
    }

    try {
      this.db
        .transaction(() => {
          this.assertActiveClaim(
            run.deliveryId,
            run.claimedBy!,
            run.fencingToken!
          );
          this.db
            .prepare(
              `UPDATE event_payload_stages SET state='abort_pending', updated_at=?
               WHERE run_id=? AND stage_id!=? AND state='committed'`
            )
            .run(this.clock.now(), run.id, stageId);
          const updated = this.db
            .prepare(
              `UPDATE event_payload_stages SET state='committed', updated_at=?
               WHERE stage_id=? AND state='commit_pending'`
            )
            .run(this.clock.now(), stageId);
          const current = this.db
            .prepare('SELECT state FROM event_payload_stages WHERE stage_id=?')
            .get(stageId) as { state: PayloadStageRow['state'] } | undefined;
          if (updated.changes !== 1 && current?.state !== 'committed') {
            throw new Error(
              `payload stage commit acknowledgement was lost for run ${run.id}`
            );
          }
        })
        .immediate();
    } catch (error) {
      throw this.outputPersistenceError('commit', run.id, error);
    }
    try {
      await this.abortSupersededPayloadStages(run.id, stageId);
    } catch (error) {
      throw this.outputPersistenceError('commit', run.id, error);
    }
  }

  private hasCommittedPayload(runId: string, reference: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM event_payload_stages
           WHERE run_id=? AND reference=? AND state='committed'`
        )
        .get(runId, reference)
    );
  }

  private saveRunMetadataWithCommittedPayload(run: Readonly<AxEventRun>): void {
    const stored: AxEventRun = {
      ...structuredClone(run),
      output: undefined,
      chunks: undefined,
    };
    this.db
      .transaction(() => {
        this.assertActiveClaim(
          run.deliveryId,
          run.claimedBy!,
          run.fencingToken!
        );
        if (
          !run.outputRef ||
          !this.hasCommittedPayload(run.id, run.outputRef)
        ) {
          throw new Error(`Committed payload ownership was lost for ${run.id}`);
        }
        this.db
          .prepare(
            `UPDATE event_runs SET run_json=?, updated_at=?, finished_at=?
             WHERE id=?`
          )
          .run(
            JSON.stringify(stored),
            this.clock.now(),
            run.finishedAt ?? null,
            run.id
          );
      })
      .immediate();
  }

  private async reconcilePayloadStages(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT stage_id, run_id, delivery_id, fencing_token, reference,
                size_bytes, expires_at, state
         FROM event_payload_stages WHERE state != 'committed'
         ORDER BY created_at`
      )
      .all() as PayloadStageRow[];
    if (!rows.length) return;
    let payloadStore: AxEventStagedPayloadStore;
    try {
      payloadStore = this.stagedPayloadStore('recovery');
    } catch {
      for (const row of rows) {
        try {
          this.quarantinePayloadStage(
            row,
            'staged payload recovery is unavailable'
          );
        } catch {}
      }
      return;
    }
    for (const row of rows) {
      try {
        if (row.state === 'staging') {
          if (row.expires_at > this.clock.now()) continue;
          this.quarantinePayloadStage(row, 'payload staging expired');
          await this.abortPayloadStage(row.stage_id, payloadStore);
          continue;
        }
        if (row.state === 'abort_pending') {
          if (this.isSupersededPayloadStage(row)) {
            await this.abortPayloadStage(row.stage_id, payloadStore);
            continue;
          }
          this.quarantinePayloadStage(row, 'payload staging was aborted');
          await this.abortPayloadStage(row.stage_id, payloadStore);
          continue;
        }
        if (row.expires_at <= this.clock.now()) {
          this.quarantinePayloadStage(row, 'staged payload recovery expired');
          await this.abortPayloadStage(row.stage_id, payloadStore);
          continue;
        }
        try {
          await this.withPayloadDeadline(
            'recovery',
            this.payloadStaging!.persistenceTimeoutMs,
            (signal) => payloadStore.commit(row.stage_id, signal)
          );
        } catch (error) {
          // Leave commit_pending quarantined. Claim excludes this delivery, so
          // a provider outage cannot poison unrelated work or replay the target.
          void this.outputPersistenceError('recovery', row.run_id, error);
          continue;
        }
        this.db
          .transaction(() => {
            const runRow = this.db
              .prepare('SELECT run_json FROM event_runs WHERE id=?')
              .get(row.run_id) as { run_json: string } | undefined;
            if (!runRow) {
              throw new Error(`Missing staged event run ${row.run_id}`);
            }
            const run = JSON.parse(runRow.run_json) as AxEventRun;
            if (
              (run.status !== 'finalizing' && run.status !== 'succeeded') ||
              run.outputRef !== row.reference
            ) {
              throw new Error(`Invalid staged event run ${row.run_id}`);
            }
            this.db
              .prepare(
                `UPDATE event_payload_stages SET state='abort_pending', updated_at=?
                 WHERE run_id=? AND stage_id!=? AND state='committed'`
              )
              .run(this.clock.now(), row.run_id, row.stage_id);
            const updated = this.db
              .prepare(
                `UPDATE event_payload_stages SET state='committed', updated_at=?
                 WHERE stage_id=? AND state='commit_pending'`
              )
              .run(this.clock.now(), row.stage_id);
            if (updated.changes !== 1) return;
            const deliveryUpdated = this.db
              .prepare(
                `UPDATE event_deliveries
                 SET run_id=?, invocation_started=1
                 WHERE id=? AND status IN ('claimed','running')`
              )
              .run(row.run_id, row.delivery_id);
            if (deliveryUpdated.changes !== 1) {
              throw new Error(
                `Payload recovery could not bind run ${row.run_id} to delivery ${row.delivery_id}`
              );
            }
          })
          .immediate();
      } catch {
        // Corruption or a failed local recovery acknowledgement is isolated to
        // its owning delivery. Preserve unrelated claim/getRun/close liveness.
        try {
          this.quarantinePayloadStage(
            row,
            'payload recovery record is invalid'
          );
        } catch {}
        await this.abortPayloadStage(row.stage_id, payloadStore);
      }
    }
    try {
      await this.abortSupersededPayloadStages();
    } catch {}
  }

  private quarantinePayloadStage(
    row: Readonly<PayloadStageRow>,
    reason: string
  ): void {
    const message = `output_persistence_failed: ${reason} for run ${row.run_id}`;
    this.db
      .transaction(() => {
        const runRow = this.db
          .prepare('SELECT run_json FROM event_runs WHERE id=?')
          .get(row.run_id) as { run_json: string } | undefined;
        if (runRow) {
          try {
            const run = JSON.parse(runRow.run_json) as AxEventRun;
            if (
              run &&
              typeof run === 'object' &&
              !Array.isArray(run) &&
              run.deliveryId === row.delivery_id
            ) {
              const failed: AxEventRun = {
                ...run,
                output: undefined,
                chunks: undefined,
                outputRef: undefined,
                status: 'output_persistence_failed',
                finishedAt: this.clock.now(),
                error: message,
              };
              this.db
                .prepare(
                  `UPDATE event_runs SET run_json=?, updated_at=?, finished_at=?
                   WHERE id=?`
                )
                .run(
                  JSON.stringify(failed),
                  this.clock.now(),
                  failed.finishedAt,
                  row.run_id
                );
            }
          } catch {
            // The fenced delivery and stage journal remain authoritative even
            // when optional diagnostic run metadata is corrupt.
          }
        }
        this.db
          .prepare(
            `UPDATE event_deliveries
             SET status='output_persistence_failed', error=?,
                 run_id=COALESCE(run_id, ?), invocation_started=1
             WHERE id=? AND fencing_token=? AND status IN ('claimed','running')`
          )
          .run(message, row.run_id, row.delivery_id, row.fencing_token);
        this.db
          .prepare(
            `UPDATE event_payload_stages SET state='abort_pending', updated_at=?
             WHERE stage_id=?`
          )
          .run(this.clock.now(), row.stage_id);
      })
      .immediate();
  }

  private quarantinePayloadStageById(stageId: string, reason: string): void {
    const row = this.db
      .prepare(
        `SELECT stage_id, run_id, delivery_id, fencing_token, reference,
                size_bytes, expires_at, state
         FROM event_payload_stages WHERE stage_id=?`
      )
      .get(stageId) as PayloadStageRow | undefined;
    if (row) this.quarantinePayloadStage(row, reason);
  }

  private isSupersededPayloadStage(row: Readonly<PayloadStageRow>): boolean {
    if (row.reference === null) return false;
    const runRow = this.db
      .prepare('SELECT run_json FROM event_runs WHERE id=?')
      .get(row.run_id) as { run_json: string } | undefined;
    if (!runRow) return false;
    try {
      const run = JSON.parse(runRow.run_json) as AxEventRun;
      return (
        run !== null &&
        typeof run === 'object' &&
        !Array.isArray(run) &&
        run.deliveryId === row.delivery_id &&
        run.outputRef !== row.reference
      );
    } catch {
      return false;
    }
  }

  private async abortSupersededPayloadStages(
    runId?: string,
    exceptStageId?: string
  ): Promise<void> {
    if (runId) {
      this.db
        .prepare(
          `UPDATE event_payload_stages SET state='abort_pending', updated_at=?
           WHERE run_id=? AND state='committed'
             AND (? IS NULL OR stage_id!=?)`
        )
        .run(
          this.clock.now(),
          runId,
          exceptStageId ?? null,
          exceptStageId ?? null
        );
    }
    const rows = this.db
      .prepare(
        `SELECT stage_id FROM event_payload_stages
         WHERE state='abort_pending' ORDER BY created_at`
      )
      .all() as { stage_id: string }[];
    if (!rows.length) return;
    const payloadStore = this.stagedPayloadStore('recovery');
    for (const row of rows) {
      await this.abortPayloadStage(row.stage_id, payloadStore);
    }
  }

  private async abortPayloadStage(
    stageId: string,
    payloadStore: AxEventStagedPayloadStore
  ): Promise<void> {
    try {
      await this.withPayloadDeadline(
        'recovery',
        this.payloadStaging!.persistenceTimeoutMs,
        (signal) => payloadStore.abort(stageId, signal)
      );
      this.db
        .prepare(
          `DELETE FROM event_payload_stages
           WHERE stage_id=? AND state='abort_pending'`
        )
        .run(stageId);
    } catch {}
  }

  private stagedPayloadStore(
    phase: 'preflight' | 'recovery'
  ): AxEventStagedPayloadStore {
    const store = this.options.payloadStore as
      | Partial<AxEventStagedPayloadStore>
      | undefined;
    if (
      !store ||
      typeof store.stage !== 'function' ||
      typeof store.commit !== 'function' ||
      typeof store.abort !== 'function' ||
      !this.payloadStaging
    ) {
      throw new AxEventOutputPersistenceError(
        'oversized payloads require an AxEventStagedPayloadStore and explicit payloadStaging policy',
        phase
      );
    }
    return store as AxEventStagedPayloadStore;
  }

  private assertPayloadLeaseBudget(
    deliveryId: string,
    claimedBy: string,
    fencingToken: number,
    requiredMs: number
  ): void {
    const row = this.db
      .prepare(
        `SELECT lease_expires_at FROM event_deliveries
         WHERE id=? AND claimed_by=? AND fencing_token=?
           AND status IN ('claimed','running') AND lease_expires_at > ?`
      )
      .get(deliveryId, claimedBy, fencingToken, this.clock.now()) as
      | { lease_expires_at: number }
      | undefined;
    if (!row || row.lease_expires_at - this.clock.now() < requiredMs) {
      throw new AxEventOutputPersistenceError(
        `claim lease cannot cover bounded payload persistence for run delivery ${deliveryId}`,
        'preflight'
      );
    }
  }

  private async withPayloadDeadline<T>(
    phase: 'stage' | 'commit' | 'recovery',
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort(`Event payload ${phase} timed out`);
            reject(new Error(`Event payload ${phase} timed out`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private outputPersistenceError(
    phase: 'stage' | 'commit' | 'recovery',
    runId: string,
    cause: unknown
  ): AxEventOutputPersistenceError {
    if (axIsEventOutputPersistenceError(cause)) return cause;
    return new AxEventOutputPersistenceError(
      `payload ${phase} failed for run ${runId}`,
      phase,
      { cause }
    );
  }

  private validatePayloadStaging(
    policy: Readonly<AxSQLiteEventPayloadStagingPolicy>
  ): void {
    for (const [name, value] of Object.entries(policy)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
          `AxSQLiteEventStore payloadStaging.${name} must be a positive safe integer`
        );
      }
    }
    if (policy.stageTtlMs <= policy.persistenceTimeoutMs * 2) {
      throw new Error(
        'AxSQLiteEventStore payloadStaging.stageTtlMs must exceed two persistence timeouts'
      );
    }
  }

  private tryEnqueue(
    request: Readonly<AxEventEnqueueRequest>,
    deliveryIdsOverride?: readonly string[]
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
      if (
        deliveryIdsOverride &&
        deliveryIdsOverride.length !== request.deliveries.length
      ) {
        throw new Error('Explicit event delivery IDs do not match deliveries');
      }
      const insert = this.db.prepare(
        `INSERT INTO event_deliveries(
          id, ingress_json, identity_scope, route_id, action, target_id,
          instance_key, status, attempt, available_at, accepted_at, size_bytes,
          retry_safety, ordering_mode
        ) VALUES(?,?,?,?,?,?,?,'queued',0,?,?,?,?,?)`
      );
      for (const [index, descriptor] of request.deliveries.entries()) {
        const id = deliveryIdsOverride?.[index] ?? randomUUID();
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

  private insertContinuation(
    continuation: Readonly<AxEventContinuation>
  ): void {
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
  }

  private completeContinuationNow(id: string): void {
    this.db
      .prepare('DELETE FROM event_continuation_keys WHERE continuation_id=?')
      .run(id);
    this.db
      .prepare(
        'UPDATE event_continuations SET completed_at=? WHERE id=? AND completed_at IS NULL'
      )
      .run(this.clock.now(), id);
  }

  private getDuplicateReceipt(
    ingress: Readonly<AxEventEnqueueRequest['ingress']>
  ): AxEventPublishReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT event_id, delivery_ids_json FROM event_dedupe WHERE dedupe_key=?'
      )
      .get(axEventScopedDedupeKey(ingress)) as
      | { event_id: string; delivery_ids_json: string }
      | undefined;
    return row
      ? {
          eventId: row.event_id,
          accepted: true,
          duplicate: true,
          durability: 'persistent',
          deliveryIds: JSON.parse(row.delivery_ids_json) as string[],
        }
      : undefined;
  }

  private saveTransitionRun(run: Readonly<AxEventRun>): void {
    const existing = this.db
      .prepare('SELECT run_json FROM event_runs WHERE id=?')
      .get(run.id) as { run_json: string } | undefined;
    if (!existing) throw new Error(`Unknown event run: ${run.id}`);
    const previous = JSON.parse(existing.run_json) as AxEventRun;
    const stored = previous.outputRef
      ? {
          ...run,
          output: undefined,
          chunks: undefined,
          outputRef: previous.outputRef,
        }
      : run;
    if (
      Buffer.byteLength(JSON.stringify(stored)) > this.maxInlinePayloadBytes
    ) {
      throw new Error(
        `output_persistence_failed: run ${run.id} metadata exceeded ${this.maxInlinePayloadBytes} inline bytes`
      );
    }
    this.db
      .prepare(
        `UPDATE event_runs SET run_json=?, updated_at=?, finished_at=?
         WHERE id=? AND delivery_id=?`
      )
      .run(
        JSON.stringify(stored),
        this.clock.now(),
        run.finishedAt ?? null,
        run.id,
        run.deliveryId
      );
  }

  private assertContinuationMatch(
    requested: Readonly<AxEventContinuation>
  ): void {
    const row = this.db
      .prepare(
        `SELECT continuation_json FROM event_continuations
         WHERE id=? AND completed_at IS NULL`
      )
      .get(requested.id) as { continuation_json: string } | undefined;
    if (!row) {
      throw new Error(
        `Duplicate resume event has no active continuation: ${requested.id}`
      );
    }
    const existing = JSON.parse(row.continuation_json) as AxEventContinuation;
    if (JSON.stringify(existing) !== JSON.stringify(requested)) {
      throw new Error(
        `Event continuation id is already owned: ${requested.id}`
      );
    }
  }

  private readVerifierTransition(
    operationId: string
  ): AxEventVerifierTransitionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT operation_id, request_commitment, receipt_json,
                child_delivery_id, child_commitment
         FROM event_verifier_transitions
         WHERE operation_id=?`
      )
      .get(operationId) as
      | {
          operation_id: string;
          request_commitment: string;
          receipt_json: string;
          child_delivery_id: string;
          child_commitment: string;
        }
      | undefined;
    if (!row) return;
    const child = this.db
      .prepare('SELECT ingress_json FROM event_deliveries WHERE id=?')
      .get(row.child_delivery_id) as { ingress_json: string } | undefined;
    const childIngress = child
      ? (JSON.parse(child.ingress_json) as AxEventEnqueueRequest['ingress'])
      : undefined;
    return {
      operationId: row.operation_id,
      requestCommitment: row.request_commitment,
      receipt: parseVerifierReceipt(
        row.operation_id,
        row.receipt_json,
        row.child_delivery_id,
        childIngress?.event.id
      ),
      childDeliveryId: row.child_delivery_id,
      childCommitment: row.child_commitment,
    };
  }

  private assertVerifierContinuationConsumption(
    request: Readonly<AxEventVerifierTransitionRequest>,
    parent: Readonly<AxEventDelivery>
  ): void {
    const admitted = parent.admittedContinuation;
    const requested = request.parent.delivery.admittedContinuation;
    if (!request.consumeContinuationId) {
      if (admitted || requested) {
        throw new Error(
          `Verifier transition must consume the continuation admitted to ${parent.id}`
        );
      }
      return;
    }
    if (
      !admitted ||
      !requested ||
      admitted.id !== request.consumeContinuationId ||
      requested.id !== request.consumeContinuationId ||
      axEventContinuationFingerprint(admitted) !==
        axEventContinuationFingerprint(requested)
    ) {
      throw new Error(
        `Verifier transition cannot consume a continuation not admitted to ${parent.id}`
      );
    }
    const continuation = this.db
      .prepare(
        `SELECT continuation_json, admitted_delivery_id
         FROM event_continuations WHERE id=? AND completed_at IS NULL`
      )
      .get(admitted.id) as
      | { continuation_json: string; admitted_delivery_id: string | null }
      | undefined;
    if (
      !continuation ||
      continuation.admitted_delivery_id !== parent.id ||
      axEventContinuationFingerprint(
        parseContinuationAdmission(parent.id, continuation.continuation_json)
      ) !== axEventContinuationFingerprint(admitted)
    ) {
      throw new Error(
        `Verifier transition cannot consume a continuation not admitted to ${parent.id}`
      );
    }
  }

  private assertVerifierTransitionRequest(
    record: Readonly<AxEventVerifierTransitionRecord>,
    request: Readonly<AxEventVerifierTransitionRequest>,
    requestCommitment: string,
    childCommitment: string
  ): void {
    if (
      record.operationId !== request.operationId ||
      record.requestCommitment !== requestCommitment ||
      record.childDeliveryId !== request.childDeliveryId ||
      record.childCommitment !== childCommitment ||
      axEventCanonicalJson(record.receipt) !==
        axEventCanonicalJson({
          eventId: request.child.ingress.event.id,
          accepted: true,
          duplicate: false,
          durability: 'persistent',
          deliveryIds: [request.childDeliveryId],
        })
    ) {
      throw new Error(
        `Verifier transition operation is already owned: ${request.operationId}`
      );
    }
  }

  private verifierChildProjection(
    request: Readonly<AxEventVerifierTransitionRequest>
  ): Omit<
    AxEventDelivery,
    | 'sequence'
    | 'status'
    | 'attempt'
    | 'claimedBy'
    | 'runId'
    | 'error'
    | 'leaseExpiresAt'
    | 'fencingToken'
    | 'invocationStarted'
    | 'recoveredFromExpiredLease'
  > {
    const descriptor = request.child.deliveries[0]!;
    return {
      id: request.childDeliveryId,
      ingress: request.child.ingress,
      identityScope: axEventIdentityScope(request.child.ingress.identity),
      routeId: descriptor.routeId,
      action: descriptor.action,
      ...(descriptor.targetId ? { targetId: descriptor.targetId } : {}),
      instanceKey: descriptor.instanceKey,
      availableAt: descriptor.availableAt ?? request.child.acceptedAt,
      acceptedAt: request.child.acceptedAt,
      sizeBytes: descriptor.sizeBytes,
      retrySafety: descriptor.retrySafety ?? 'unknown',
      ordering: descriptor.ordering ?? 'strict',
    };
  }

  private persistedChildProjection(
    delivery: Readonly<AxEventDelivery>
  ): ReturnType<AxSQLiteEventStore['verifierChildProjection']> {
    return {
      id: delivery.id,
      ingress: delivery.ingress,
      identityScope: delivery.identityScope,
      routeId: delivery.routeId,
      action: delivery.action,
      ...(delivery.targetId ? { targetId: delivery.targetId } : {}),
      instanceKey: delivery.instanceKey,
      availableAt: delivery.availableAt,
      acceptedAt: delivery.acceptedAt,
      sizeBytes: delivery.sizeBytes,
      retrySafety: delivery.retrySafety,
      ordering: delivery.ordering,
    };
  }

  private canonicalCommitment(value: unknown): string {
    return createHash('sha256')
      .update(axEventCanonicalJson(value))
      .digest('hex');
  }

  private effectRequestDigest(effect: Readonly<AxEventEffect>): string {
    return createHash('sha256')
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
  }

  private rowToDelivery(row: DeliveryRow): AxEventDelivery {
    this.assertSafeFencingToken(row.id, row.fencing_token);
    const admittedContinuation = safeParseContinuationAdmission(
      row.id,
      row.admitted_continuation_json
    );
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
      ...(admittedContinuation ? { admittedContinuation } : {}),
    };
  }

  private assertWritable(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('AxSQLiteEventStore operation aborted');
    }
    if (this.closed) throw new Error('AxSQLiteEventStore closed');
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

  private assertNoNonterminalEffects(deliveryId: string): void {
    const pending = this.db
      .prepare(
        `SELECT 1 FROM event_effects
         WHERE delivery_id=? AND status IN ('intent','dispatched','parked')
         LIMIT 1`
      )
      .get(deliveryId);
    if (pending) {
      throw new Error(`Event delivery ${deliveryId} has a nonterminal effect`);
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

  private tableColumns(table: string): string[] {
    return (
      this.db.pragma(`table_info(${table})`) as ReadonlyArray<{ name: string }>
    ).map((column) => column.name);
  }

  private hasExactColumns(table: string, expected: readonly string[]): boolean {
    const actual = this.tableColumns(table);
    return (
      actual.length === expected.length &&
      actual.every((column, index) => column === expected[index])
    );
  }

  private indexColumns(index: string): string[] {
    return (
      this.db.pragma(`index_info(${index})`) as ReadonlyArray<{
        seqno: number;
        name: string;
      }>
    )
      .toSorted((left, right) => left.seqno - right.seqno)
      .map((column) => column.name);
  }

  private hasExactIndex(index: string, expected: readonly string[]): boolean {
    const actual = this.indexColumns(index);
    return (
      actual.length === expected.length &&
      actual.every((column, position) => column === expected[position])
    );
  }

  private hasUniqueIndex(table: string, expected: readonly string[]): boolean {
    const indexes = this.db.pragma(`index_list(${table})`) as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
    }>;
    return indexes.some(
      (index) => index.unique === 1 && this.hasExactIndex(index.name, expected)
    );
  }

  private inspectMigrationShape(
    reportedVersion: number
  ): AxSQLiteEventMigrationShape {
    if (!Number.isSafeInteger(reportedVersion) || reportedVersion < 0) {
      throw new Error(
        `Unsupported AxSQLiteEventStore schema ${reportedVersion}`
      );
    }
    if (reportedVersion > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported AxSQLiteEventStore schema ${reportedVersion}`
      );
    }

    const coreTables = [
      'event_deliveries',
      'event_dedupe',
      'event_runs',
      'event_continuations',
      'event_continuation_keys',
      'event_dead_letters',
      'event_program_state',
    ] as const;
    const corePresence = coreTables.map(
      (table) => this.tableColumns(table).length > 0
    );
    if (corePresence.every((present) => !present)) {
      const featureTables = [
        'event_effects',
        'event_payload_stages',
        'event_verifier_transitions',
        'event_store_metadata',
      ];
      if (featureTables.some((table) => this.tableColumns(table).length > 0)) {
        throw new Error('Malformed partial AxSQLiteEventStore schema');
      }
      return { empty: true, effects: 'absent', verifier: 'absent' };
    }
    if (!corePresence.every(Boolean)) {
      throw new Error('Malformed partial AxSQLiteEventStore core schema');
    }

    const deliveryBase = [
      'sequence',
      'id',
      'ingress_json',
      'identity_scope',
      'route_id',
      'action',
      'target_id',
      'instance_key',
      'status',
      'attempt',
      'available_at',
      'accepted_at',
      'claimed_by',
      'run_id',
      'error',
      'size_bytes',
      'retry_safety',
      'ordering_mode',
      'lease_expires_at',
      'fencing_token',
      'invocation_started',
    ] as const;
    const continuationBase = [
      'id',
      'identity_scope',
      'continuation_json',
      'created_at',
      'expires_at',
      'completed_at',
    ] as const;
    const dedupeBase = [
      'dedupe_key',
      'event_id',
      'delivery_ids_json',
      'created_at',
    ] as const;
    const deliveryLegacy = this.hasExactColumns(
      'event_deliveries',
      deliveryBase
    );
    const deliveryAdmission = this.hasExactColumns('event_deliveries', [
      ...deliveryBase,
      'admitted_continuation_json',
    ]);
    const continuationLegacy = this.hasExactColumns(
      'event_continuations',
      continuationBase
    );
    const continuationAdmission = this.hasExactColumns('event_continuations', [
      ...continuationBase,
      'admitted_delivery_id',
    ]);
    const dedupeLegacy = this.hasExactColumns('event_dedupe', dedupeBase);
    const dedupeIngress =
      this.hasExactColumns('event_dedupe', [
        'dedupe_key',
        'event_id',
        'delivery_ids_json',
        'ingress_json',
        'created_at',
      ]) ||
      this.hasExactColumns('event_dedupe', [...dedupeBase, 'ingress_json']);
    const dedupeFingerprint =
      this.hasExactColumns('event_dedupe', [
        'dedupe_key',
        'event_id',
        'delivery_ids_json',
        'ingress_json',
        'ingress_fingerprint',
        'created_at',
      ]) ||
      this.hasExactColumns('event_dedupe', [
        'dedupe_key',
        'event_id',
        'delivery_ids_json',
        'ingress_json',
        'created_at',
        'ingress_fingerprint',
      ]) ||
      this.hasExactColumns('event_dedupe', [
        'dedupe_key',
        'event_id',
        'delivery_ids_json',
        'created_at',
        'ingress_json',
        'ingress_fingerprint',
      ]);
    if (
      (!deliveryLegacy && !deliveryAdmission) ||
      (!continuationLegacy && !continuationAdmission) ||
      (!dedupeLegacy && !dedupeIngress && !dedupeFingerprint) ||
      !this.hasExactColumns('event_runs', [
        'id',
        'delivery_id',
        'run_json',
        'updated_at',
        'finished_at',
      ]) ||
      !this.hasExactColumns('event_continuation_keys', [
        'correlation_key',
        'continuation_id',
      ]) ||
      !this.hasExactColumns('event_dead_letters', [
        'id',
        'delivery_id',
        'dead_letter_json',
        'created_at',
      ]) ||
      !this.hasExactColumns('event_program_state', [
        'state_key',
        'revision',
        'state_json',
        'updated_at',
      ]) ||
      !this.hasExactIndex('event_delivery_claim', [
        'status',
        'available_at',
        'lease_expires_at',
        'sequence',
      ])
    ) {
      throw new Error('Malformed AxSQLiteEventStore core table or index shape');
    }

    const admissionIndexSql = (
      this.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='index' AND name='event_continuation_admission'`
        )
        .get() as { sql: string | null } | undefined
    )?.sql
      ?.replaceAll(/\s+/g, ' ')
      .toLowerCase();
    const hasAdmissionIndex =
      this.hasUniqueIndex('event_continuations', ['admitted_delivery_id']) &&
      Boolean(
        admissionIndexSql?.includes('where admitted_delivery_id is not null')
      );
    const admissionSignals = [
      deliveryAdmission,
      continuationAdmission,
      hasAdmissionIndex,
    ];
    if (!admissionSignals.every(Boolean) && admissionSignals.some(Boolean)) {
      throw new Error('Malformed partial continuation admission schema');
    }
    if (
      admissionSignals.every(Boolean) &&
      (!dedupeFingerprint || deliveryLegacy || continuationLegacy)
    ) {
      throw new Error('Malformed continuation admission lineage');
    }

    const effectColumns = this.tableColumns('event_effects');
    const effects = effectColumns.length > 0;
    if (
      effects &&
      (!this.hasExactColumns('event_effects', [
        'id',
        'delivery_id',
        'operation',
        'idempotency_key',
        'status',
        'effect_json',
        'created_at',
        'updated_at',
        'settled_at',
      ]) ||
        !this.hasUniqueIndex('event_effects', [
          'delivery_id',
          'operation',
          'idempotency_key',
        ]) ||
        !this.hasExactIndex('event_effects_delivery', [
          'delivery_id',
          'status',
          'created_at',
        ]))
    ) {
      throw new Error('Malformed event effect ledger schema');
    }
    if (
      !effects &&
      (dedupeIngress || dedupeFingerprint || admissionSignals.some(Boolean))
    ) {
      throw new Error('Malformed partial event effect schema');
    }

    const payloadColumns = this.tableColumns('event_payload_stages');
    const payload = payloadColumns.length > 0;
    const payloadTableSql = (
      this.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='event_payload_stages'`
        )
        .get() as { sql: string | null } | undefined
    )?.sql
      ?.replaceAll(/\s+/g, '')
      .toLowerCase();
    if (
      payload &&
      (!effects ||
        !dedupeFingerprint ||
        !this.hasExactColumns('event_payload_stages', [
          'stage_id',
          'run_id',
          'delivery_id',
          'fencing_token',
          'reference',
          'size_bytes',
          'expires_at',
          'state',
          'created_at',
          'updated_at',
        ]) ||
        !this.hasExactIndex('event_payload_stage_state', [
          'state',
          'expires_at',
        ]) ||
        !this.hasExactIndex('event_payload_stage_run', ['run_id']) ||
        !payloadTableSql?.includes(
          "check(statein('staging','commit_pending','committed','abort_pending'))"
        ))
    ) {
      throw new Error('Malformed partial event payload staging schema');
    }
    if (admissionSignals.every(Boolean) && !payload) {
      throw new Error(
        'Malformed continuation admission without payload schema'
      );
    }

    const journal = this.tableColumns('event_verifier_transitions');
    const metadata = this.tableColumns('event_store_metadata');
    let verifier: AxSQLiteEventMigrationShape['verifier'];
    if (journal.length === 0) {
      if (metadata.length > 0) {
        throw new Error('Malformed partial event verifier schema');
      }
      verifier = 'absent';
    } else if (
      this.hasExactColumns('event_verifier_transitions', [
        'operation_id',
        'request_json',
        'record_json',
        'created_at',
      ])
    ) {
      if (metadata.length > 0) {
        throw new Error('Malformed mixed event verifier schema');
      }
      verifier = 'legacy-v2';
    } else if (
      this.hasExactColumns('event_verifier_transitions', [
        'operation_id',
        'request_commitment',
        'receipt_json',
        'child_delivery_id',
        'child_commitment',
        'created_at',
      ])
    ) {
      if (metadata.length === 0) {
        verifier = 'compact-v3';
      } else if (
        this.hasExactColumns('event_store_metadata', [
          'metadata_key',
          'metadata_value',
        ])
      ) {
        verifier = 'current-v4';
      } else {
        throw new Error('Malformed event verifier metadata schema');
      }
    } else {
      throw new Error('Malformed event verifier transition journal');
    }

    const effectLineage: AxSQLiteEventMigrationShape['effects'] =
      admissionSignals.every(Boolean)
        ? 'admission'
        : payload
          ? 'payload'
          : dedupeFingerprint
            ? 'fingerprint'
            : effects
              ? 'ledger'
              : 'absent';

    return {
      empty: false,
      effects: effectLineage,
      verifier,
    };
  }

  private assertCombinedSchema(): void {
    const shape = this.inspectMigrationShape(SCHEMA_VERSION);
    if (
      shape.empty ||
      shape.effects !== 'admission' ||
      shape.verifier !== 'current-v4' ||
      !this.tableColumns('event_payload_stages').length ||
      !this.tableColumns('event_deliveries').includes(
        'admitted_continuation_json'
      )
    ) {
      throw new Error('AxSQLiteEventStore v7 migration is incomplete');
    }
    const missingFingerprint = this.db
      .prepare(
        `SELECT 1 FROM event_dedupe
         WHERE ingress_fingerprint IS NULL LIMIT 1`
      )
      .get();
    if (missingFingerprint) {
      throw new Error(
        'Cannot safely migrate event dedupe rows without canonical ingress fingerprints'
      );
    }
    const malformedDedupe = this.db
      .prepare(
        `SELECT 1 FROM event_dedupe
         WHERE json_valid(delivery_ids_json)=0
            OR (ingress_json IS NOT NULL AND json_valid(ingress_json)=0)
            OR (ingress_json IS NULL AND ingress_fingerprint NOT LIKE ?)
         LIMIT 1`
      )
      .get(`${LEGACY_UNVERIFIABLE_INGRESS_PREFIX}%`);
    if (malformedDedupe) {
      throw new Error('AxSQLiteEventStore v7 has malformed dedupe data');
    }
    const dedupeRows = this.db
      .prepare(
        `SELECT dedupe_key, delivery_ids_json, ingress_json, ingress_fingerprint
         FROM event_dedupe`
      )
      .all() as Array<{
      dedupe_key: string;
      delivery_ids_json: string;
      ingress_json: string | null;
      ingress_fingerprint: string;
    }>;
    for (const row of dedupeRows) {
      const deliveryIds = JSON.parse(row.delivery_ids_json) as unknown;
      if (
        !Array.isArray(deliveryIds) ||
        !deliveryIds.every((deliveryId) => typeof deliveryId === 'string')
      ) {
        throw new Error('AxSQLiteEventStore v7 has malformed dedupe data');
      }
      if (row.ingress_json !== null) {
        const ingress = JSON.parse(
          row.ingress_json
        ) as AxEventEnqueueRequest['ingress'];
        if (axEventIngressFingerprint(ingress) !== row.ingress_fingerprint) {
          throw new Error(
            `AxSQLiteEventStore v7 ingress fingerprint conflicts with ${row.dedupe_key}`
          );
        }
      }
    }
    const malformedEffect = this.db
      .prepare(
        `SELECT 1 FROM event_effects
         WHERE json_valid(effect_json)=0
            OR json_extract(effect_json, '$.id') IS NOT id
            OR json_extract(effect_json, '$.deliveryId') IS NOT delivery_id
            OR json_extract(effect_json, '$.operation') IS NOT operation
            OR json_extract(effect_json, '$.idempotencyKey') IS NOT idempotency_key
            OR json_type(effect_json, '$.requestDigest') IS NOT 'text'
         LIMIT 1`
      )
      .get();
    if (malformedEffect) {
      throw new Error('AxSQLiteEventStore v7 has malformed effect data');
    }
    const effects = this.db
      .prepare('SELECT id, effect_json FROM event_effects')
      .all() as Array<{ id: string; effect_json: string }>;
    for (const row of effects) {
      const effect = JSON.parse(row.effect_json) as AxEventEffect;
      if (effect.requestDigest !== this.effectRequestDigest(effect)) {
        throw new Error(
          `AxSQLiteEventStore v7 effect request digest conflicts with ${row.id}`
        );
      }
    }
    const malformedVerifier = this.db
      .prepare(
        `SELECT 1 FROM event_verifier_transitions
         WHERE request_commitment=''
            OR child_delivery_id=''
            OR child_commitment=''
            OR json_valid(receipt_json)=0
         LIMIT 1`
      )
      .get();
    if (malformedVerifier) {
      throw new Error('AxSQLiteEventStore v7 has malformed verifier data');
    }
    const verifierRows = this.db
      .prepare(
        `SELECT v.operation_id, v.receipt_json, v.child_delivery_id,
                d.ingress_json
         FROM event_verifier_transitions v
         LEFT JOIN event_deliveries d ON d.id=v.child_delivery_id`
      )
      .all() as Array<{
      operation_id: string;
      receipt_json: string;
      child_delivery_id: string;
      ingress_json: string | null;
    }>;
    for (const row of verifierRows) {
      const ingress = row.ingress_json
        ? (JSON.parse(row.ingress_json) as AxEventEnqueueRequest['ingress'])
        : undefined;
      parseVerifierReceipt(
        row.operation_id,
        row.receipt_json,
        row.child_delivery_id,
        ingress?.event.id
      );
    }
    const malformedAdmission = this.db
      .prepare(
        `SELECT 1 FROM event_deliveries
         WHERE admitted_continuation_json IS NOT NULL
           AND json_valid(admitted_continuation_json)=0
         LIMIT 1`
      )
      .get();
    if (malformedAdmission) {
      throw new Error('AxSQLiteEventStore v7 has malformed admission data');
    }
    const admissions = this.db
      .prepare(
        `SELECT d.id, d.identity_scope, d.route_id, d.target_id,
                d.instance_key, d.admitted_continuation_json,
                c.continuation_json, c.admitted_delivery_id
         FROM event_deliveries d
         LEFT JOIN event_continuations c
           ON c.id=json_extract(d.admitted_continuation_json, '$.id')
         WHERE d.admitted_continuation_json IS NOT NULL`
      )
      .all() as Array<{
      id: string;
      identity_scope: string;
      route_id: string;
      target_id: string | null;
      instance_key: string;
      admitted_continuation_json: string;
      continuation_json: string | null;
      admitted_delivery_id: string | null;
    }>;
    for (const row of admissions) {
      const admitted = parseContinuationAdmission(
        row.id,
        row.admitted_continuation_json
      );
      if (
        admitted.identityScope !== row.identity_scope ||
        admitted.targetId !== row.target_id
      ) {
        throw new Error(
          `AxSQLiteEventStore v7 admission conflicts with delivery ${row.id}`
        );
      }
      if (
        row.continuation_json !== null &&
        (row.admitted_delivery_id !== row.id ||
          axEventContinuationFingerprint(
            parseContinuationAdmission(row.id, row.continuation_json)
          ) !== axEventContinuationFingerprint(admitted))
      ) {
        throw new Error(
          `AxSQLiteEventStore v7 admission conflicts with continuation ${admitted.id}`
        );
      }
    }
    const foreignKeyViolation = (
      this.db.pragma('foreign_key_check') as unknown[]
    )[0];
    if (foreignKeyViolation) {
      throw new Error('AxSQLiteEventStore v7 has a foreign-key violation');
    }
  }

  private migrate(): void {
    this.db
      .transaction(() => {
        const reportedVersion = this.db.pragma('user_version', {
          simple: true,
        }) as number;
        const shape = this.inspectMigrationShape(reportedVersion);
        let version = shape.empty
          ? 0
          : {
              absent: 1,
              ledger: 2,
              fingerprint: 4,
              payload: 5,
              admission: 6,
            }[shape.effects];
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
          invocation_started INTEGER NOT NULL DEFAULT 0,
          admitted_continuation_json TEXT
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
          completed_at INTEGER,
          admitted_delivery_id TEXT
        );
        CREATE TABLE event_continuation_keys (
          correlation_key TEXT PRIMARY KEY,
          continuation_id TEXT NOT NULL REFERENCES event_continuations(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX event_continuation_admission
          ON event_continuations(admitted_delivery_id)
          WHERE admitted_delivery_id IS NOT NULL;
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
        CREATE TABLE IF NOT EXISTS event_payload_stages (
          stage_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          reference TEXT,
          size_bytes INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('staging','commit_pending','committed','abort_pending')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS event_payload_stage_state ON event_payload_stages(state, expires_at);
        CREATE INDEX IF NOT EXISTS event_payload_stage_run ON event_payload_stages(run_id);
      `)
            )
            .immediate();
          version = 6;
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
              this.db
                .prepare(
                  `DELETE FROM event_dedupe
               WHERE created_at < ?
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(event_dedupe.delivery_ids_json) ids
                   JOIN event_deliveries d ON d.id=ids.value
                   WHERE d.status NOT IN (${TERMINAL.map(() => '?').join(',')})
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(event_dedupe.delivery_ids_json) ids
                   JOIN event_effects e ON e.delivery_id=ids.value
                 )`
                )
                .run(
                  this.clock.now() - this.options.retention.eventAndResultMs,
                  ...TERMINAL
                );
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
                  `SELECT dedupe_key, delivery_ids_json, ingress_json,
                          ingress_fingerprint
               FROM event_dedupe`
                )
                .all() as {
                dedupe_key: string;
                delivery_ids_json: string;
                ingress_json: string | null;
                ingress_fingerprint: string | null;
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
                if (
                  row.ingress_fingerprint &&
                  row.ingress_fingerprint !== ingressFingerprint
                ) {
                  throw new Error(
                    `Event ingress fingerprint conflicts with ${row.dedupe_key}`
                  );
                }
                update.run(
                  ingressJson,
                  row.ingress_fingerprint ?? ingressFingerprint,
                  row.dedupe_key
                );
              }
              const effects = this.db
                .prepare('SELECT id, effect_json FROM event_effects')
                .all() as { id: string; effect_json: string }[];
              const updateEffect = this.db.prepare(
                'UPDATE event_effects SET effect_json=? WHERE id=?'
              );
              for (const row of effects) {
                const effect = JSON.parse(row.effect_json) as AxEventEffect;
                const requestDigest = this.effectRequestDigest(effect);
                if (
                  effect.requestDigest &&
                  effect.requestDigest !== requestDigest
                ) {
                  throw new Error(
                    `Event effect request digest conflicts with ${effect.id}`
                  );
                }
                if (effect.requestDigest) continue;
                effect.requestDigest = requestDigest;
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
          version = 4;
        }
        if (version === 4) {
          this.db
            .transaction(() =>
              this.db.exec(`
        CREATE TABLE IF NOT EXISTS event_payload_stages (
          stage_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          reference TEXT,
          size_bytes INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('staging','commit_pending','committed','abort_pending')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS event_payload_stage_state ON event_payload_stages(state, expires_at);
        CREATE INDEX IF NOT EXISTS event_payload_stage_run ON event_payload_stages(run_id);
        PRAGMA user_version = 5;
      `)
            )
            .immediate();
          version = 5;
        }
        if (version === 5) {
          this.db
            .transaction(() => {
              const deliveryColumns = new Set(
                (
                  this.db.pragma('table_info(event_deliveries)') as {
                    name: string;
                  }[]
                ).map((column) => column.name)
              );
              if (!deliveryColumns.has('admitted_continuation_json')) {
                this.db.exec(
                  `ALTER TABLE event_deliveries
               ADD COLUMN admitted_continuation_json TEXT`
                );
              }
              const continuationColumns = new Set(
                (
                  this.db.pragma('table_info(event_continuations)') as {
                    name: string;
                  }[]
                ).map((column) => column.name)
              );
              if (!continuationColumns.has('admitted_delivery_id')) {
                this.db.exec(
                  `ALTER TABLE event_continuations
               ADD COLUMN admitted_delivery_id TEXT`
                );
              }
              this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS event_continuation_admission
              ON event_continuations(admitted_delivery_id)
              WHERE admitted_delivery_id IS NOT NULL;
          `);
              const candidates = this.db
                .prepare(
                  `SELECT d.id AS delivery_id, d.run_id, d.invocation_started,
                      r.run_json
               FROM event_deliveries d
               LEFT JOIN event_runs r ON r.delivery_id=d.id
               WHERE d.action='resume'
               ORDER BY d.id, r.updated_at, r.id`
                )
                .all() as {
                delivery_id: string;
                run_id: string | null;
                invocation_started: number;
                run_json: string | null;
              }[];
              const byDelivery = new Map<
                string,
                Map<
                  string,
                  { continuation: AxEventContinuation; continuationId: string }
                >
              >();
              const invalidate = this.db.prepare(
                `UPDATE event_deliveries SET admitted_continuation_json='null'
             WHERE id=?`
              );
              const invalidDeliveries = new Set<string>();
              for (const candidate of candidates) {
                if (invalidDeliveries.has(candidate.delivery_id)) continue;
                if (
                  candidate.run_json === null &&
                  candidate.run_id === null &&
                  candidate.invocation_started === 0
                ) {
                  // A never-invoked delivery has no legacy admission to preserve;
                  // leave it eligible for its first atomic admission under v6.
                  continue;
                }
                try {
                  const run = JSON.parse(
                    candidate.run_json ?? ''
                  ) as AxEventRun;
                  const continuation = run.admittedContinuation;
                  if (
                    !continuation ||
                    run.deliveryId !== candidate.delivery_id ||
                    run.targetId !== continuation.targetId ||
                    run.instanceKey !== continuation.instanceKey
                  ) {
                    invalidate.run(candidate.delivery_id);
                    byDelivery.delete(candidate.delivery_id);
                    invalidDeliveries.add(candidate.delivery_id);
                    continue;
                  }
                  const entries =
                    byDelivery.get(candidate.delivery_id) ?? new Map();
                  entries.set(axEventContinuationFingerprint(continuation), {
                    continuation,
                    continuationId: continuation.id,
                  });
                  byDelivery.set(candidate.delivery_id, entries);
                } catch {
                  invalidate.run(candidate.delivery_id);
                  byDelivery.delete(candidate.delivery_id);
                  invalidDeliveries.add(candidate.delivery_id);
                }
              }
              const valid = new Map<
                string,
                Array<{ deliveryId: string; continuation: AxEventContinuation }>
              >();
              for (const [deliveryId, entries] of byDelivery) {
                if (entries.size !== 1) {
                  invalidate.run(deliveryId);
                  continue;
                }
                const entry = [...entries.values()][0]!;
                const owners = valid.get(entry.continuationId) ?? [];
                owners.push({ deliveryId, continuation: entry.continuation });
                valid.set(entry.continuationId, owners);
              }
              const bindContinuation = this.db.prepare(
                `UPDATE event_continuations SET admitted_delivery_id=?
             WHERE id=?
               AND (admitted_delivery_id IS NULL OR admitted_delivery_id=?)`
              );
              const bindDelivery = this.db.prepare(
                `UPDATE event_deliveries SET admitted_continuation_json=?
             WHERE id=? AND admitted_continuation_json IS NULL`
              );
              for (const [continuationId, entries] of valid) {
                if (entries.length !== 1) {
                  for (const entry of entries) invalidate.run(entry.deliveryId);
                  continue;
                }
                const entry = entries[0]!;
                const existing = this.db
                  .prepare('SELECT id FROM event_continuations WHERE id=?')
                  .get(continuationId);
                if (existing) {
                  const result = bindContinuation.run(
                    entry.deliveryId,
                    continuationId,
                    entry.deliveryId
                  );
                  if (result.changes !== 1) {
                    invalidate.run(entry.deliveryId);
                    continue;
                  }
                }
                bindDelivery.run(
                  JSON.stringify(entry.continuation),
                  entry.deliveryId
                );
              }
              this.db.pragma('user_version = 6');
            })
            .immediate();
        }
        this.db
          .transaction(() => {
            const journalColumns = new Set(
              (
                this.db.pragma(
                  'table_info(event_verifier_transitions)'
                ) as Array<{
                  name: string;
                }>
              ).map((column) => column.name)
            );
            if (journalColumns.size === 0) {
              this.db.exec(`
            CREATE TABLE event_verifier_transitions (
              operation_id TEXT PRIMARY KEY,
              request_commitment TEXT NOT NULL,
              receipt_json TEXT NOT NULL,
              child_delivery_id TEXT NOT NULL,
              child_commitment TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
          `);
            } else if (journalColumns.has('request_json')) {
              const rows = this.db
                .prepare(
                  `SELECT operation_id, request_json, record_json, created_at
               FROM event_verifier_transitions`
                )
                .all() as Array<{
                operation_id: string;
                request_json: string;
                record_json: string;
                created_at: number;
              }>;
              this.db.exec(`
            ALTER TABLE event_verifier_transitions RENAME TO event_verifier_transitions_v2;
            CREATE TABLE event_verifier_transitions (
              operation_id TEXT PRIMARY KEY,
              request_commitment TEXT NOT NULL,
              receipt_json TEXT NOT NULL,
              child_delivery_id TEXT NOT NULL,
              child_commitment TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
          `);
              const insert = this.db.prepare(
                `INSERT INTO event_verifier_transitions VALUES(?,?,?,?,?,?)`
              );
              for (const row of rows) {
                const request = JSON.parse(
                  row.request_json
                ) as AxEventVerifierTransitionRequest;
                const record = JSON.parse(row.record_json) as {
                  receipt: AxEventPublishReceipt;
                  child: AxEventDelivery;
                };
                insert.run(
                  row.operation_id,
                  this.canonicalCommitment(request),
                  JSON.stringify(record.receipt),
                  record.child.id,
                  this.canonicalCommitment(
                    this.persistedChildProjection(record.child)
                  ),
                  row.created_at
                );
              }
              this.db.exec('DROP TABLE event_verifier_transitions_v2');
            } else if (!journalColumns.has('request_commitment')) {
              throw new Error('Malformed event verifier transition journal');
            }
            this.db.exec(`
          CREATE TABLE IF NOT EXISTS event_store_metadata (
            metadata_key TEXT PRIMARY KEY,
            metadata_value TEXT NOT NULL
          );
        `);
            if (
              shape.verifier === 'legacy-v2' ||
              shape.verifier === 'compact-v3'
            ) {
              this.db
                .prepare(
                  `INSERT OR REPLACE INTO event_store_metadata VALUES(?, '1')`
                )
                .run(VERIFIER_MIGRATION_CLEANUP_KEY);
            }
            this.db.pragma('user_version = 7');
          })
          .immediate();
        this.assertCombinedSchema();
      })
      .immediate();
  }

  private completeVerifierMigrationCleanup(): void {
    const pending = this.db
      .prepare(
        'SELECT 1 FROM event_store_metadata WHERE metadata_key=? AND metadata_value=?'
      )
      .get(VERIFIER_MIGRATION_CLEANUP_KEY, '1');
    if (!pending) return;
    const [checkpoint] = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
    }>;
    if (checkpoint?.busy) {
      throw new Error('Verifier journal migration cleanup is still pending');
    }
    this.db
      .prepare('DELETE FROM event_store_metadata WHERE metadata_key=?')
      .run(VERIFIER_MIGRATION_CLEANUP_KEY);
  }

  private prune(now: number): void {
    const retention = this.options.retention;
    this.db.transaction(() => {
      const eventCutoff = now - retention.eventAndResultMs;
      this.db
        .prepare(
          `DELETE FROM event_effects
           WHERE settled_at IS NOT NULL AND settled_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM event_deliveries d
               WHERE d.id=event_effects.delivery_id
                 AND d.status NOT IN (${TERMINAL.map(() => '?').join(',')})
             )`
        )
        .run(
          now -
            Math.max(
              retention.eventAndResultMs,
              retention.settledEffectsMs ??
                retention.runMetadataAndDeadLettersMs
            ),
          ...TERMINAL
        );
      this.db
        .prepare('DELETE FROM event_dedupe WHERE created_at < ?')
        .run(eventCutoff);
      this.db
        .prepare(
          `UPDATE event_payload_stages SET state='abort_pending', updated_at=?
           WHERE state='committed' AND run_id IN (
             SELECT id FROM event_runs
             WHERE finished_at IS NOT NULL AND finished_at < ?
           )`
        )
        .run(now, eventCutoff);
      this.db
        .prepare(
          `UPDATE event_runs
           SET run_json=json_remove(run_json, '$.output', '$.chunks', '$.outputRef')
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
