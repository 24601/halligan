import type { AxEventContext, AxEventIngress, AxEventValue } from './types.js';
import { axEventIdentityScope, axValidateEventEnvelope } from './util.js';

export type AxDemandDisposition =
  | 'ignore'
  | 'annotate'
  | 'notify'
  | 'propose'
  | 'act';

export type AxDemandOutcome = 'demand' | 'no_demand' | 'uncertain';

export interface AxDemandProvenance {
  source: string;
  reference: string;
  observedAt: number;
  polarity?: 'supports' | 'contradicts' | 'neutral';
}

export interface AxDemandObservation {
  id: string;
  source: string;
  type: string;
  observedAt: number;
  subject?: string;
  data?: AxEventValue;
  provenance: readonly Readonly<AxDemandProvenance>[];
  expiresAt?: number;
  dedupeKey?: string;
}

export interface AxDemandCalibration {
  method: string;
  version: string;
  expectedCalibrationError?: number;
  sampleSize?: number;
}

/** Untrusted detector output. The boundary never treats this as authority. */
export interface AxDemandDetection {
  outcome: AxDemandOutcome;
  /** Estimated probability that the observation represents demand. */
  confidence: number;
  requestedDisposition: AxDemandDisposition;
  reasonCode: string;
  reason?: string;
  evidence: readonly Readonly<AxDemandProvenance>[];
  calibration?: Readonly<AxDemandCalibration>;
  standingGrantRef?: string;
  expiresAt?: number;
}

export interface AxDemandDetector {
  id: string;
  version: string;
  detect(
    observation: Readonly<AxDemandObservation>,
    context: Readonly<{
      signal: AbortSignal;
      scope: Readonly<AxDemandScope>;
    }>
  ): Readonly<AxDemandDetection> | Promise<Readonly<AxDemandDetection>>;
}

export type AxDemandGrantState = 'valid' | 'revoked' | 'expired' | 'unknown';

export interface AxDemandScope {
  boundaryId: string;
  routeId: string;
  instanceKey: string;
  principalScope: string;
}

export interface AxDemandGrantValidationContext {
  reference: string;
  observation: Readonly<AxDemandObservation>;
  scope: Readonly<AxDemandScope>;
  signal: AbortSignal;
}

export interface AxDemandPolicy {
  allowedDispositions?: readonly AxDemandDisposition[];
  minimumConfidence?: Partial<Readonly<Record<AxDemandDisposition, number>>>;
  maxObservationAgeMs?: number;
  maxFutureSkewMs?: number;
  proposalTtlMs?: number;
  callbackTimeoutMs?: number;
  maxInFlight?: number;
  maxInFlightBytes?: number;
  requireStandingGrantFor?: readonly AxDemandDisposition[];
  maxScopeBytes?: number;
  maxObservationBytes?: number;
  maxDetectionBytes?: number;
}

export interface AxDemandProposal {
  disposition: AxDemandDisposition;
  requestedDisposition: AxDemandDisposition;
  authority: 'advisory';
  requiresHostReview: true;
  reasonCodes: readonly string[];
  standingGrantRef?: string;
  standingGrantState?: AxDemandGrantState;
  expiresAt: number;
  dedupeKey: string;
}

export interface AxDemandRecord {
  cursor: string;
  scope: Readonly<AxDemandScope>;
  observation: Readonly<AxDemandObservation>;
  detection: Readonly<AxDemandDetection>;
  proposal: Readonly<AxDemandProposal>;
  detector: Readonly<{ id: string; version: string }>;
  createdAt: number;
  metrics: Readonly<{
    detectorCalls: number;
    detectorLatencyMs: number;
    detectorLatencyCapped: boolean;
    observationBytes: number;
    detectionBytes: number;
  }>;
}

export interface AxDemandAppendResult {
  record: Readonly<AxDemandRecord>;
  duplicate: boolean;
}

export interface AxDemandStore {
  getByDedupeKey(key: string): Promise<Readonly<AxDemandRecord> | undefined>;
  /**
   * Atomically check signal immediately before committing a new record. If it
   * is aborted before commit, reject without retaining the record.
   */
  append(
    record: Readonly<Omit<AxDemandRecord, 'cursor'>>,
    options: Readonly<{ signal: AbortSignal }>
  ): Promise<Readonly<AxDemandAppendResult>>;
  list(
    options?: Readonly<{
      after?: string;
      limit?: number;
    }>
  ): Promise<
    Readonly<{ records: readonly Readonly<AxDemandRecord>[]; next?: string }>
  >;
}

export interface AxDemandBoundaryOptions {
  id?: string;
  detector: AxDemandDetector;
  store?: AxDemandStore;
  policy?: Readonly<AxDemandPolicy>;
  now?: () => number;
  measureNow?: () => number;
  validateStandingGrant?: (
    context: Readonly<AxDemandGrantValidationContext>
  ) => AxDemandGrantState | Promise<AxDemandGrantState>;
}

export interface AxDemandReceipt {
  record: Readonly<AxDemandRecord>;
  duplicate: boolean;
  /** Duplicate receipts are historical snapshots and never fresh authority. */
  historical: boolean;
}

export interface AxInMemoryDemandStoreOptions {
  seed?: readonly Readonly<AxDemandRecord>[];
  maxRecords?: number;
  maxBytes?: number;
  maxScopes?: number;
  maxRecordsPerScope?: number;
  retentionMs?: number;
  now?: () => number;
}

const dispositions: readonly AxDemandDisposition[] = [
  'ignore',
  'annotate',
  'notify',
  'propose',
  'act',
];

const defaultMinimumConfidence: Readonly<Record<AxDemandDisposition, number>> =
  {
    ignore: 0,
    annotate: 0,
    notify: 0.75,
    propose: 0.85,
    act: 0.95,
  };

const maxTimerDelayMs = 2_147_483_647;
const encoder = new TextEncoder();

function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function frozenClone<T>(value: T): Readonly<T> {
  return deepFreeze(clone(value));
}

function finiteProbability(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function safeIntegerDifference(
  left: number,
  right: number,
  label: string
): number {
  const difference = left - right;
  if (!Number.isSafeInteger(difference)) {
    throw new Error(`${label} must be a safe integer duration`);
  }
  return difference;
}

function recordedElapsedMs(
  startedAt: number,
  finishedAt: number
): Readonly<{ value: number; capped: boolean }> {
  const elapsed = finishedAt - startedAt;
  if (!Number.isFinite(elapsed)) {
    return {
      value: elapsed > 0 ? Number.MAX_SAFE_INTEGER : 0,
      capped: true,
    };
  }
  if (elapsed < 0) return { value: 0, capped: true };
  if (elapsed > Number.MAX_SAFE_INTEGER) {
    return { value: Number.MAX_SAFE_INTEGER, capped: true };
  }
  return { value: elapsed, capped: false };
}

function validateRecordMetrics(
  record: Readonly<Omit<AxDemandRecord, 'cursor'> | AxDemandRecord>
): void {
  const { metrics } = record;
  if (
    !Number.isSafeInteger(metrics.detectorCalls) ||
    metrics.detectorCalls < 0 ||
    !Number.isFinite(metrics.detectorLatencyMs) ||
    metrics.detectorLatencyMs < 0 ||
    metrics.detectorLatencyMs > Number.MAX_SAFE_INTEGER ||
    typeof metrics.detectorLatencyCapped !== 'boolean' ||
    !Number.isSafeInteger(metrics.observationBytes) ||
    metrics.observationBytes < 0 ||
    !Number.isSafeInteger(metrics.detectionBytes) ||
    metrics.detectionBytes < 0
  ) {
    throw new Error('AxDemandRecord metrics are invalid');
  }
}

function snapshotProvenance(
  raw: readonly Readonly<AxDemandProvenance>[],
  label: string
): AxDemandProvenance[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  return Array.from(raw, (item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const source = item.source;
    const reference = item.reference;
    const observedAt = item.observedAt;
    const polarity = item.polarity;
    return {
      source,
      reference,
      observedAt,
      ...(polarity !== undefined ? { polarity } : {}),
    };
  });
}

function snapshotObservation(
  raw: Readonly<AxDemandObservation>
): AxDemandObservation {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('AxDemandObservation must be an object');
  }
  const id = raw.id;
  const source = raw.source;
  const type = raw.type;
  const observedAt = raw.observedAt;
  const subject = raw.subject;
  const data = raw.data;
  const provenance = raw.provenance;
  const expiresAt = raw.expiresAt;
  const dedupeKey = raw.dedupeKey;
  return {
    id,
    source,
    type,
    observedAt,
    ...(subject !== undefined ? { subject } : {}),
    ...(data !== undefined ? { data: clone(data) } : {}),
    provenance: snapshotProvenance(provenance, 'observation.provenance'),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(dedupeKey !== undefined ? { dedupeKey } : {}),
  };
}

function snapshotDetection(
  raw: Readonly<AxDemandDetection>
): AxDemandDetection {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('AxDemandDetection must be an object');
  }
  const outcome = raw.outcome;
  const confidence = raw.confidence;
  const requestedDisposition = raw.requestedDisposition;
  const reasonCode = raw.reasonCode;
  const reason = raw.reason;
  const evidence = raw.evidence;
  const rawCalibration = raw.calibration;
  const standingGrantRef = raw.standingGrantRef;
  const expiresAt = raw.expiresAt;
  let calibration: AxDemandCalibration | undefined;
  if (rawCalibration !== undefined) {
    if (typeof rawCalibration !== 'object' || rawCalibration === null) {
      throw new Error('detection.calibration must be an object');
    }
    const method = rawCalibration.method;
    const version = rawCalibration.version;
    const expectedCalibrationError = rawCalibration.expectedCalibrationError;
    const sampleSize = rawCalibration.sampleSize;
    calibration = {
      method,
      version,
      ...(expectedCalibrationError !== undefined
        ? { expectedCalibrationError }
        : {}),
      ...(sampleSize !== undefined ? { sampleSize } : {}),
    };
  }
  return {
    outcome,
    confidence,
    requestedDisposition,
    reasonCode,
    ...(reason !== undefined ? { reason } : {}),
    evidence: snapshotProvenance(evidence, 'detection.evidence'),
    ...(calibration ? { calibration } : {}),
    ...(standingGrantRef !== undefined ? { standingGrantRef } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function validateProvenance(
  evidence: readonly Readonly<AxDemandProvenance>[],
  label: string
): void {
  for (const [index, item] of evidence.entries()) {
    nonEmpty(item.source, `${label}[${index}].source`);
    nonEmpty(item.reference, `${label}[${index}].reference`);
    finiteTimestamp(item.observedAt, `${label}[${index}].observedAt`);
    if (
      item.polarity !== undefined &&
      !['supports', 'contradicts', 'neutral'].includes(item.polarity)
    ) {
      throw new Error(`${label}[${index}].polarity is invalid`);
    }
  }
}

function validateObservation(observation: Readonly<AxDemandObservation>): void {
  nonEmpty(observation.id, 'AxDemandObservation.id');
  nonEmpty(observation.source, 'AxDemandObservation.source');
  nonEmpty(observation.type, 'AxDemandObservation.type');
  finiteTimestamp(observation.observedAt, 'AxDemandObservation.observedAt');
  if (observation.expiresAt !== undefined) {
    finiteTimestamp(observation.expiresAt, 'AxDemandObservation.expiresAt');
  }
  validateProvenance(observation.provenance, 'observation.provenance');
  axValidateEventEnvelope({
    specversion: '1.0',
    id: observation.id,
    source: observation.source,
    type: observation.type,
    ...(observation.data !== undefined ? { data: observation.data } : {}),
  });
}

function validateDetection(detection: Readonly<AxDemandDetection>): void {
  if (!['demand', 'no_demand', 'uncertain'].includes(detection.outcome)) {
    throw new Error('detection.outcome is invalid');
  }
  finiteProbability(detection.confidence, 'detection.confidence');
  if (!dispositions.includes(detection.requestedDisposition)) {
    throw new Error('detection.requestedDisposition is invalid');
  }
  nonEmpty(detection.reasonCode, 'detection.reasonCode');
  if (detection.reason !== undefined) {
    nonEmpty(detection.reason, 'detection.reason');
  }
  if (detection.standingGrantRef !== undefined) {
    nonEmpty(detection.standingGrantRef, 'detection.standingGrantRef');
  }
  validateProvenance(detection.evidence, 'detection.evidence');
  if (detection.expiresAt !== undefined) {
    finiteTimestamp(detection.expiresAt, 'detection.expiresAt');
  }
  if (detection.calibration) {
    nonEmpty(detection.calibration.method, 'detection.calibration.method');
    nonEmpty(detection.calibration.version, 'detection.calibration.version');
    if (detection.calibration.expectedCalibrationError !== undefined) {
      finiteProbability(
        detection.calibration.expectedCalibrationError,
        'detection.calibration.expectedCalibrationError'
      );
    }
    if (
      detection.calibration.sampleSize !== undefined &&
      (!Number.isSafeInteger(detection.calibration.sampleSize) ||
        detection.calibration.sampleSize < 0)
    ) {
      throw new Error('detection.calibration.sampleSize must be non-negative');
    }
  }
}

function uncertainDetection(
  reasonCode: string,
  reason: string
): AxDemandDetection {
  return {
    outcome: 'uncertain',
    confidence: 0,
    requestedDisposition: 'annotate',
    reasonCode,
    reason: reason.slice(0, 4_096),
    evidence: [],
  };
}

class AxDemandCallbackTimeoutError extends Error {
  constructor() {
    super('Ax demand callback timed out');
    this.name = 'AxDemandCallbackTimeoutError';
  }
}

class AxDemandCallbackCapacityError extends Error {
  constructor() {
    super('AxDemandBoundary callback capacity was exhausted');
    this.name = 'AxDemandCallbackCapacityError';
  }
}

class AxDemandCancelledError extends Error {
  constructor(readonly reason: unknown) {
    super('Ax demand observation was cancelled');
    this.name = 'AbortError';
  }
}

async function runBoundedCallback<T>(
  callback: (signal: AbortSignal) => T | Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  reserve: (size: number) => () => void,
  reservationBytes: number
): Promise<T> {
  if (signal?.aborted) throw new AxDemandCancelledError(signal.reason);
  const release = reserve(reservationBytes);
  const controller = new AbortController();
  let terminalError:
    | AxDemandCancelledError
    | AxDemandCallbackTimeoutError
    | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => {
      const error = new AxDemandCancelledError(signal?.reason);
      terminalError = error;
      reject(error);
      controller.abort(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new AxDemandCallbackTimeoutError();
      terminalError = error;
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  const operation = Promise.resolve()
    .then(() => callback(controller.signal))
    .then(
      (value) => {
        release();
        return value;
      },
      (error) => {
        release();
        throw terminalError ?? error;
      }
    );
  try {
    return await Promise.race([operation, cancellation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function waitForSharedWork<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal?.aborted) throw new AxDemandCancelledError(signal.reason);
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AxDemandCancelledError(signal?.reason));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export class AxInMemoryDemandStore implements AxDemandStore {
  private readonly records: Array<{
    record: AxDemandRecord;
    size: number;
  }> = [];
  private readonly byDedupeKey = new Map<string, AxDemandRecord>();
  private readonly limits: Readonly<{
    maxRecords: number;
    maxBytes: number;
    maxScopes: number;
    maxRecordsPerScope: number;
    retentionMs: number;
  }>;
  private readonly now: () => number;
  private totalBytes = 0;
  private nextCursor = 1;

  constructor(
    options:
      | Readonly<AxInMemoryDemandStoreOptions>
      | readonly Readonly<AxDemandRecord>[] = {}
  ) {
    const normalized: Readonly<AxInMemoryDemandStoreOptions> = Array.isArray(
      options
    )
      ? { seed: options }
      : (options as Readonly<AxInMemoryDemandStoreOptions>);
    this.now = normalized.now ?? Date.now;
    this.limits = {
      maxRecords: normalized.maxRecords ?? 10_000,
      maxBytes: normalized.maxBytes ?? 64 * 1024 * 1024,
      maxScopes: normalized.maxScopes ?? 1_000,
      maxRecordsPerScope: normalized.maxRecordsPerScope ?? 1_000,
      retentionMs: normalized.retentionMs ?? 7 * 86_400_000,
    };
    if (
      !Number.isSafeInteger(this.limits.maxRecords) ||
      this.limits.maxRecords < 1 ||
      !Number.isSafeInteger(this.limits.maxBytes) ||
      this.limits.maxBytes < 1 ||
      !Number.isSafeInteger(this.limits.maxScopes) ||
      this.limits.maxScopes < 1 ||
      !Number.isSafeInteger(this.limits.maxRecordsPerScope) ||
      this.limits.maxRecordsPerScope < 1 ||
      !Number.isSafeInteger(this.limits.retentionMs) ||
      this.limits.retentionMs < 0
    ) {
      throw new Error('AxInMemoryDemandStore bounds are invalid');
    }
    for (const record of normalized.seed ?? []) {
      const copied = clone(record);
      finiteTimestamp(copied.createdAt, 'AxDemandRecord.createdAt');
      validateRecordMetrics(copied);
      const size = bytes(copied);
      if (this.byDedupeKey.has(copied.proposal.dedupeKey)) {
        throw new Error(
          'AxInMemoryDemandStore seed dedupe keys must be unique'
        );
      }
      this.records.push({ record: copied, size });
      this.totalBytes += size;
      this.byDedupeKey.set(copied.proposal.dedupeKey, copied);
      const cursor = Number(copied.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 1) {
        throw new Error('AxInMemoryDemandStore seed cursor is invalid');
      }
      const following =
        cursor === Number.MAX_SAFE_INTEGER
          ? Number.POSITIVE_INFINITY
          : cursor + 1;
      this.nextCursor = Math.max(this.nextCursor, following);
    }
    this.records.sort(
      (left, right) => Number(left.record.cursor) - Number(right.record.cursor)
    );
    for (let index = 1; index < this.records.length; index++) {
      if (
        this.records[index - 1]!.record.cursor ===
        this.records[index]!.record.cursor
      ) {
        throw new Error('AxInMemoryDemandStore seed cursors must be unique');
      }
    }
    this.enforceBounds();
  }

  getByDedupeKey(key: string): Promise<Readonly<AxDemandRecord> | undefined> {
    this.pruneExpired();
    const record = this.byDedupeKey.get(key);
    return Promise.resolve(record ? clone(record) : undefined);
  }

  append(
    value: Readonly<Omit<AxDemandRecord, 'cursor'>>,
    options: Readonly<{ signal: AbortSignal }>
  ): Promise<Readonly<AxDemandAppendResult>> {
    if (options.signal.aborted) {
      throw new AxDemandCancelledError(options.signal.reason);
    }
    this.pruneExpired();
    finiteTimestamp(value.createdAt, 'AxDemandRecord.createdAt');
    validateRecordMetrics(value);
    const duplicate = this.byDedupeKey.get(value.proposal.dedupeKey);
    if (duplicate) {
      return Promise.resolve({ record: clone(duplicate), duplicate: true });
    }
    if (!Number.isSafeInteger(this.nextCursor)) {
      throw new Error('AxInMemoryDemandStore cursor capacity was exhausted');
    }
    if (options.signal.aborted) {
      throw new AxDemandCancelledError(options.signal.reason);
    }
    const cursor = this.nextCursor;
    this.nextCursor =
      cursor === Number.MAX_SAFE_INTEGER
        ? Number.POSITIVE_INFINITY
        : cursor + 1;
    const record: AxDemandRecord = {
      ...clone(value),
      cursor: String(cursor),
    };
    const size = bytes(record);
    if (size > this.limits.maxBytes) {
      throw new Error('AxDemandRecord exceeds the store byte bound');
    }
    this.records.push({ record, size });
    this.totalBytes += size;
    this.byDedupeKey.set(record.proposal.dedupeKey, record);
    this.enforceBounds();
    return Promise.resolve({ record: clone(record), duplicate: false });
  }

  list(
    options: Readonly<{ after?: string; limit?: number }> = {}
  ): Promise<
    Readonly<{ records: readonly Readonly<AxDemandRecord>[]; next?: string }>
  > {
    this.pruneExpired();
    const after = options.after === undefined ? 0 : Number(options.after);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error('AxDemandStore cursor is invalid');
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('AxDemandStore limit must be between 1 and 1000');
    }
    const records = this.records
      .filter(({ record }) => Number(record.cursor) > after)
      .slice(0, limit)
      .map(({ record }) => clone(record));
    const next = records.at(-1)?.cursor;
    return Promise.resolve({ records, ...(next ? { next } : {}) });
  }

  snapshot(): readonly Readonly<AxDemandRecord>[] {
    this.pruneExpired();
    return this.records.map(({ record }) => clone(record));
  }

  private scopeKey(record: Readonly<AxDemandRecord>): string {
    return JSON.stringify([
      record.scope.boundaryId,
      record.scope.routeId,
      record.scope.instanceKey,
      record.scope.principalScope,
    ]);
  }

  private removeAt(index: number): void {
    const removed = this.records.splice(index, 1)[0];
    if (!removed) return;
    this.totalBytes -= removed.size;
    if (
      this.byDedupeKey.get(removed.record.proposal.dedupeKey) === removed.record
    ) {
      this.byDedupeKey.delete(removed.record.proposal.dedupeKey);
    }
  }

  private pruneExpired(): void {
    const cutoff = safeIntegerDifference(
      finiteTimestamp(this.now(), 'AxInMemoryDemandStore.now()'),
      this.limits.retentionMs,
      'AxInMemoryDemandStore retention cutoff'
    );
    for (let index = this.records.length - 1; index >= 0; index--) {
      if (this.records[index]!.record.createdAt < cutoff) this.removeAt(index);
    }
  }

  private enforceBounds(): void {
    const counts = () => {
      const result = new Map<string, number>();
      for (const { record } of this.records) {
        const key = this.scopeKey(record);
        result.set(key, (result.get(key) ?? 0) + 1);
      }
      return result;
    };
    let byScope = counts();
    while (byScope.size > this.limits.maxScopes) {
      const oldestScope = this.records[0]
        ? this.scopeKey(this.records[0].record)
        : undefined;
      if (!oldestScope) break;
      for (let index = this.records.length - 1; index >= 0; index--) {
        if (this.scopeKey(this.records[index]!.record) === oldestScope) {
          this.removeAt(index);
        }
      }
      byScope = counts();
    }
    for (const [scope, count] of byScope) {
      let excess = count - this.limits.maxRecordsPerScope;
      for (let index = 0; excess > 0 && index < this.records.length; ) {
        if (this.scopeKey(this.records[index]!.record) === scope) {
          this.removeAt(index);
          excess--;
        } else {
          index++;
        }
      }
    }
    while (
      this.records.length > this.limits.maxRecords ||
      this.totalBytes > this.limits.maxBytes
    ) {
      this.removeAt(0);
    }
  }
}

export class AxDemandBoundary {
  readonly id: string;
  readonly store: AxDemandStore;
  private readonly detector: AxDemandDetector;
  private readonly detectorIdentity: Readonly<{ id: string; version: string }>;
  private readonly policy: Readonly<{
    allowedDispositions: readonly AxDemandDisposition[];
    minimumConfidence: Readonly<Record<AxDemandDisposition, number>>;
    maxObservationAgeMs: number;
    maxFutureSkewMs: number;
    proposalTtlMs: number;
    callbackTimeoutMs: number;
    maxInFlight: number;
    maxInFlightBytes: number;
    requireStandingGrantFor: readonly AxDemandDisposition[];
    maxScopeBytes: number;
    maxObservationBytes: number;
    maxDetectionBytes: number;
  }>;
  private readonly now: () => number;
  private readonly measureNow: () => number;
  private readonly validateStandingGrant?: AxDemandBoundaryOptions['validateStandingGrant'];
  private readonly inFlight = new Map<
    string,
    {
      promise: Promise<Readonly<AxDemandReceipt>>;
      controller: AbortController;
      waiters: number;
      size: number;
    }
  >();
  private inFlightBytes = 0;
  private activeCallbacks = 0;
  private activeCallbackBytes = 0;

  constructor(options: Readonly<AxDemandBoundaryOptions>) {
    const rawDetector = options.detector;
    const detectorId = rawDetector.id;
    const detectorVersion = rawDetector.version;
    const detect = rawDetector.detect;
    nonEmpty(detectorId, 'AxDemandDetector.id');
    nonEmpty(detectorVersion, 'AxDemandDetector.version');
    this.id = nonEmpty(
      options.id ?? `${detectorId}@${detectorVersion}`,
      'AxDemandBoundary.id'
    );
    this.detector = Object.freeze({
      id: detectorId,
      version: detectorVersion,
      detect,
    });
    this.detectorIdentity = Object.freeze({
      id: detectorId,
      version: detectorVersion,
    });
    this.now = options.now ?? Date.now;
    this.measureNow =
      options.measureNow ??
      (() => globalThis.performance?.now?.() ?? Date.now());
    this.store = options.store ?? new AxInMemoryDemandStore({ now: this.now });
    this.validateStandingGrant = options.validateStandingGrant;
    const allowed = options.policy?.allowedDispositions ?? dispositions;
    if (
      !allowed.length ||
      allowed.some((value) => !dispositions.includes(value)) ||
      (!allowed.includes('ignore') && !allowed.includes('annotate'))
    ) {
      throw new Error(
        'AxDemandPolicy.allowedDispositions must include ignore or annotate'
      );
    }
    const minimumConfidence = {
      ...defaultMinimumConfidence,
      ...options.policy?.minimumConfidence,
    };
    for (const [key, value] of Object.entries(minimumConfidence)) {
      finiteProbability(value, `minimumConfidence.${key}`);
    }
    this.policy = {
      allowedDispositions: [...allowed],
      minimumConfidence,
      maxObservationAgeMs: options.policy?.maxObservationAgeMs ?? 86_400_000,
      maxFutureSkewMs: options.policy?.maxFutureSkewMs ?? 300_000,
      proposalTtlMs: options.policy?.proposalTtlMs ?? 3_600_000,
      callbackTimeoutMs: options.policy?.callbackTimeoutMs ?? 30_000,
      maxInFlight: options.policy?.maxInFlight ?? 1_000,
      maxInFlightBytes: options.policy?.maxInFlightBytes ?? 64 * 1024 * 1024,
      requireStandingGrantFor: [
        ...(options.policy?.requireStandingGrantFor ?? ['act']),
      ],
      maxScopeBytes: options.policy?.maxScopeBytes ?? 16 * 1024,
      maxObservationBytes: options.policy?.maxObservationBytes ?? 1024 * 1024,
      maxDetectionBytes: options.policy?.maxDetectionBytes ?? 64 * 1024,
    };
    if (
      !Number.isSafeInteger(this.policy.maxObservationAgeMs) ||
      this.policy.maxObservationAgeMs < 0 ||
      !Number.isSafeInteger(this.policy.maxFutureSkewMs) ||
      this.policy.maxFutureSkewMs < 0 ||
      !Number.isSafeInteger(this.policy.proposalTtlMs) ||
      this.policy.proposalTtlMs <= 0 ||
      !Number.isSafeInteger(this.policy.callbackTimeoutMs) ||
      this.policy.callbackTimeoutMs <= 0 ||
      this.policy.callbackTimeoutMs > maxTimerDelayMs ||
      !Number.isSafeInteger(this.policy.maxInFlight) ||
      this.policy.maxInFlight < 1 ||
      !Number.isSafeInteger(this.policy.maxInFlightBytes) ||
      this.policy.maxInFlightBytes < 1 ||
      !Number.isSafeInteger(this.policy.maxScopeBytes) ||
      this.policy.maxScopeBytes < 1 ||
      !Number.isSafeInteger(this.policy.maxObservationBytes) ||
      this.policy.maxObservationBytes < 1 ||
      !Number.isSafeInteger(this.policy.maxDetectionBytes) ||
      this.policy.maxDetectionBytes < 1 ||
      this.policy.requireStandingGrantFor.some(
        (value) => !dispositions.includes(value)
      )
    ) {
      throw new Error('AxDemandPolicy bounds are invalid');
    }
  }

  async observe(
    rawObservation: Readonly<AxDemandObservation>,
    options: Readonly<{
      signal?: AbortSignal;
      scope?: Readonly<Partial<Omit<AxDemandScope, 'boundaryId'>>>;
    }> = {}
  ): Promise<Readonly<AxDemandReceipt>> {
    const signal = options.signal;
    const rawScope = options.scope;
    if (signal?.aborted) {
      throw new AxDemandCancelledError(signal.reason);
    }
    const observation = deepFreeze(snapshotObservation(rawObservation));
    validateObservation(observation);
    const observationBytes = bytes(observation);
    if (observationBytes > this.policy.maxObservationBytes) {
      throw new Error(
        `AxDemandObservation is ${observationBytes} bytes; maximum is ${this.policy.maxObservationBytes}`
      );
    }
    if (
      rawScope !== undefined &&
      (typeof rawScope !== 'object' || rawScope === null)
    ) {
      throw new Error('AxDemandScope must be an object');
    }
    const routeId = rawScope?.routeId;
    const instanceKey = rawScope?.instanceKey;
    const principalScope = rawScope?.principalScope;
    const scope = deepFreeze({
      boundaryId: this.id,
      routeId: routeId ?? 'direct',
      instanceKey: instanceKey ?? 'default',
      principalScope: principalScope ?? 'anonymous',
    });
    nonEmpty(scope.routeId, 'AxDemandScope.routeId');
    nonEmpty(scope.instanceKey, 'AxDemandScope.instanceKey');
    nonEmpty(scope.principalScope, 'AxDemandScope.principalScope');
    const scopeBytes = bytes(scope);
    if (scopeBytes > this.policy.maxScopeBytes) {
      throw new Error('AxDemandScope exceeds the configured byte bound');
    }
    const localDedupeKey = observation.dedupeKey ?? observation.id;
    nonEmpty(localDedupeKey, 'AxDemandObservation.dedupeKey');
    const dedupeKey = JSON.stringify([
      scope.boundaryId,
      scope.routeId,
      scope.instanceKey,
      scope.principalScope,
      localDedupeKey,
    ]);
    const existing = await this.store.getByDedupeKey(dedupeKey);
    if (signal?.aborted) {
      throw new AxDemandCancelledError(signal.reason);
    }
    if (existing) {
      return { record: existing, duplicate: true, historical: true };
    }
    let pending = this.inFlight.get(dedupeKey);
    const duplicate = Boolean(pending);
    if (!pending) {
      const size = observationBytes + scopeBytes + bytes(dedupeKey);
      if (
        this.inFlight.size >= this.policy.maxInFlight ||
        this.inFlightBytes + size > this.policy.maxInFlightBytes
      ) {
        throw new Error('AxDemandBoundary in-flight capacity was exhausted');
      }
      const controller = new AbortController();
      const promise = this.process(
        observation,
        observationBytes,
        scopeBytes,
        scope,
        dedupeKey,
        controller.signal
      );
      pending = { promise, controller, waiters: 0, size };
      this.inFlight.set(dedupeKey, pending);
      this.inFlightBytes += size;
      const cleanup = () => {
        if (this.inFlight.get(dedupeKey) === pending) {
          this.inFlight.delete(dedupeKey);
          this.inFlightBytes -= size;
        }
      };
      void promise.then(cleanup, cleanup);
    }
    pending.waiters++;
    try {
      const receipt = await waitForSharedWork(pending.promise, signal);
      return duplicate ? { ...receipt, duplicate: true } : receipt;
    } finally {
      pending.waiters--;
      if (pending.waiters === 0 && this.inFlight.get(dedupeKey) === pending) {
        pending.controller.abort('No observers remain for demand work');
      }
    }
  }

  private async process(
    observation: Readonly<AxDemandObservation>,
    observationBytes: number,
    scopeBytes: number,
    scope: Readonly<AxDemandScope>,
    dedupeKey: string,
    signal: AbortSignal
  ): Promise<Readonly<AxDemandReceipt>> {
    const startedAt = this.measureNow();
    if (!Number.isFinite(startedAt)) {
      throw new Error('AxDemandBoundary.measureNow() must be finite');
    }
    let detection: Readonly<AxDemandDetection>;
    try {
      const candidate = await runBoundedCallback(
        (callbackSignal) =>
          this.detector.detect(
            frozenClone(observation),
            Object.freeze({ signal: callbackSignal, scope: frozenClone(scope) })
          ),
        signal,
        this.policy.callbackTimeoutMs,
        (size) => this.reserveCallback(size),
        observationBytes + scopeBytes
      );
      const candidateSnapshot = snapshotDetection(candidate);
      validateDetection(candidateSnapshot);
      const candidateBytes = bytes(candidateSnapshot);
      if (candidateBytes > this.policy.maxDetectionBytes) {
        throw new Error(
          `AxDemandDetection is ${candidateBytes} bytes; maximum is ${this.policy.maxDetectionBytes}`
        );
      }
      detection = deepFreeze(candidateSnapshot);
    } catch (error) {
      if (
        error instanceof AxDemandCancelledError ||
        error instanceof AxDemandCallbackCapacityError
      ) {
        throw error;
      }
      detection = uncertainDetection(
        error instanceof AxDemandCallbackTimeoutError
          ? 'detector_timeout'
          : 'detector_invalid',
        error instanceof Error ? error.message : String(error)
      );
    }
    const finishedAt = this.measureNow();
    if (!Number.isFinite(finishedAt)) {
      throw new Error('AxDemandBoundary.measureNow() must be finite');
    }
    const detectorLatency = recordedElapsedMs(startedAt, finishedAt);
    const proposal = await this.propose(
      observation,
      detection,
      scope,
      dedupeKey,
      signal,
      observationBytes + scopeBytes
    );
    if (signal.aborted) {
      throw new AxDemandCancelledError(signal.reason);
    }
    const appended = await this.store.append(
      {
        scope,
        observation,
        detection,
        proposal,
        detector: this.detectorIdentity,
        createdAt: finiteTimestamp(this.now(), 'AxDemandBoundary.now()'),
        metrics: {
          detectorCalls: 1,
          detectorLatencyMs: detectorLatency.value,
          detectorLatencyCapped: detectorLatency.capped,
          observationBytes,
          detectionBytes: bytes(detection),
        },
      },
      { signal }
    );
    return {
      ...appended,
      historical: appended.duplicate,
    };
  }

  list(options?: Readonly<{ after?: string; limit?: number }>) {
    return this.store.list(options);
  }

  private async propose(
    observation: Readonly<AxDemandObservation>,
    detection: Readonly<AxDemandDetection>,
    scope: Readonly<AxDemandScope>,
    fallbackDedupeKey: string,
    signal: AbortSignal | undefined,
    callbackBaseBytes: number
  ): Promise<Readonly<AxDemandProposal>> {
    const now = finiteTimestamp(this.now(), 'AxDemandBoundary.now()');
    const reasonCodes: string[] = [];
    let disposition = detection.requestedDisposition;
    let standingGrantState: AxDemandGrantState | undefined;
    const safeDisposition = (preferred: 'ignore' | 'annotate') =>
      this.policy.allowedDispositions.includes(preferred)
        ? preferred
        : preferred === 'ignore'
          ? 'annotate'
          : 'ignore';

    if (detection.outcome === 'no_demand') {
      disposition = safeDisposition('ignore');
      reasonCodes.push('explicit_no_demand');
    } else if (detection.outcome === 'uncertain') {
      disposition = safeDisposition('annotate');
      reasonCodes.push('explicit_uncertain');
    }
    const observationAge = safeIntegerDifference(
      now,
      observation.observedAt,
      'AxDemandObservation age'
    );
    const futureSkew = safeIntegerDifference(
      observation.observedAt,
      now,
      'AxDemandObservation future skew'
    );
    const stale =
      observationAge > this.policy.maxObservationAgeMs ||
      (observation.expiresAt !== undefined && observation.expiresAt <= now);
    if (stale) {
      disposition = safeDisposition('ignore');
      reasonCodes.push('stale_observation');
    }
    if (futureSkew > this.policy.maxFutureSkewMs) {
      disposition = safeDisposition('ignore');
      reasonCodes.push('future_observation');
    }
    if (detection.expiresAt !== undefined && detection.expiresAt <= now) {
      disposition = safeDisposition('ignore');
      reasonCodes.push('expired_detection');
    }
    const polarities = new Set(
      [...observation.provenance, ...detection.evidence]
        .map((value) => value.polarity)
        .filter(Boolean)
    );
    if (polarities.has('supports') && polarities.has('contradicts')) {
      disposition =
        disposition === 'ignore'
          ? safeDisposition('ignore')
          : safeDisposition('annotate');
      reasonCodes.push('conflicting_evidence');
    }
    if (!this.policy.allowedDispositions.includes(disposition)) {
      disposition = safeDisposition('annotate');
      reasonCodes.push('disposition_not_allowed');
    }
    if (detection.confidence < this.policy.minimumConfidence[disposition]) {
      disposition = safeDisposition('annotate');
      reasonCodes.push('low_confidence');
    }
    if (this.policy.requireStandingGrantFor.includes(disposition)) {
      if (!detection.standingGrantRef || !this.validateStandingGrant) {
        standingGrantState = 'unknown';
      } else {
        const validateStandingGrant = this.validateStandingGrant;
        try {
          standingGrantState = await runBoundedCallback(
            (callbackSignal) =>
              validateStandingGrant.call(
                undefined,
                Object.freeze({
                  reference: detection.standingGrantRef!,
                  observation: frozenClone(observation),
                  scope: frozenClone(scope),
                  signal: callbackSignal,
                })
              ),
            signal,
            this.policy.callbackTimeoutMs,
            (size) => this.reserveCallback(size),
            callbackBaseBytes + bytes(detection.standingGrantRef)
          );
        } catch (error) {
          if (
            error instanceof AxDemandCancelledError ||
            error instanceof AxDemandCallbackCapacityError
          ) {
            throw error;
          }
          standingGrantState = 'unknown';
        }
      }
      if (standingGrantState !== 'valid') {
        disposition = safeDisposition('annotate');
        reasonCodes.push(`standing_grant_${standingGrantState}`);
      }
    }
    const requestedExpiry = Math.min(
      detection.expiresAt ?? Number.POSITIVE_INFINITY,
      observation.expiresAt ?? Number.POSITIVE_INFINITY
    );
    const policyExpiry =
      this.policy.proposalTtlMs > Number.MAX_SAFE_INTEGER - now
        ? Number.MAX_SAFE_INTEGER
        : now + this.policy.proposalTtlMs;
    const expiresAt = finiteTimestamp(
      Math.min(policyExpiry, requestedExpiry),
      'AxDemandProposal.expiresAt'
    );
    return Object.freeze({
      disposition,
      requestedDisposition: detection.requestedDisposition,
      authority: 'advisory',
      requiresHostReview: true,
      reasonCodes: Object.freeze([...new Set(reasonCodes)]),
      ...(detection.standingGrantRef
        ? { standingGrantRef: detection.standingGrantRef }
        : {}),
      ...(standingGrantState ? { standingGrantState } : {}),
      expiresAt,
      // Only the host-owned observation may select dedupe identity. A detector
      // cannot suppress another observation by emitting a shared key.
      dedupeKey: fallbackDedupeKey,
    });
  }

  private reserveCallback(size: number): () => void {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error('AxDemandBoundary callback reservation size is invalid');
    }
    if (
      this.activeCallbacks >= this.policy.maxInFlight ||
      size > this.policy.maxInFlightBytes - this.activeCallbackBytes
    ) {
      throw new AxDemandCallbackCapacityError();
    }
    this.activeCallbacks++;
    this.activeCallbackBytes += size;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCallbacks--;
      this.activeCallbackBytes -= size;
    };
  }
}

export function axDemandEventObserver(
  boundary: AxDemandBoundary,
  map?: (
    ingress: Readonly<AxEventIngress>,
    context: Readonly<AxEventContext>
  ) => Readonly<AxDemandObservation>
): (
  ingress: Readonly<AxEventIngress>,
  context: Readonly<AxEventContext>
) => Promise<void> {
  return async (ingress, context) => {
    const observation = map?.(ingress, context) ?? {
      id: `${ingress.event.source}\n${ingress.event.id}`,
      source: ingress.event.source,
      type: ingress.event.type,
      observedAt: ingress.event.time
        ? Date.parse(ingress.event.time)
        : Date.now(),
      ...(ingress.event.subject ? { subject: ingress.event.subject } : {}),
      ...(ingress.event.data !== undefined
        ? { data: clone(ingress.event.data) }
        : {}),
      provenance: [
        {
          source: ingress.event.source,
          reference: ingress.event.id,
          observedAt: ingress.event.time
            ? Date.parse(ingress.event.time)
            : Date.now(),
        },
      ],
    };
    await boundary.observe(observation, {
      signal: context.abortSignal,
      scope: {
        routeId: context.routeId,
        instanceKey: context.instanceKey,
        principalScope: axEventIdentityScope(context.identity),
      },
    });
  };
}
