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
    context: Readonly<{ signal?: AbortSignal }>
  ): Readonly<AxDemandDetection> | Promise<Readonly<AxDemandDetection>>;
}

export type AxDemandGrantState = 'valid' | 'revoked' | 'expired' | 'unknown';

export interface AxDemandPolicy {
  allowedDispositions?: readonly AxDemandDisposition[];
  minimumConfidence?: Partial<Readonly<Record<AxDemandDisposition, number>>>;
  maxObservationAgeMs?: number;
  proposalTtlMs?: number;
  requireStandingGrantFor?: readonly AxDemandDisposition[];
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
  observation: Readonly<AxDemandObservation>;
  detection: Readonly<AxDemandDetection>;
  proposal: Readonly<AxDemandProposal>;
  detector: Readonly<{ id: string; version: string }>;
  createdAt: number;
  metrics: Readonly<{
    detectorCalls: number;
    detectorLatencyMs: number;
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
  append(
    record: Readonly<Omit<AxDemandRecord, 'cursor'>>
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
  detector: AxDemandDetector;
  store?: AxDemandStore;
  policy?: Readonly<AxDemandPolicy>;
  now?: () => number;
  validateStandingGrant?: (
    reference: string,
    observation: Readonly<AxDemandObservation>
  ) => AxDemandGrantState | Promise<AxDemandGrantState>;
}

export interface AxDemandReceipt {
  record: Readonly<AxDemandRecord>;
  duplicate: boolean;
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

const encoder = new TextEncoder();

function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function finiteProbability(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be non-empty`);
  return value;
}

function validateProvenance(
  evidence: readonly Readonly<AxDemandProvenance>[],
  label: string
): void {
  for (const [index, item] of evidence.entries()) {
    nonEmpty(item.source, `${label}[${index}].source`);
    nonEmpty(item.reference, `${label}[${index}].reference`);
    if (!Number.isFinite(item.observedAt)) {
      throw new Error(`${label}[${index}].observedAt must be finite`);
    }
  }
}

function validateObservation(observation: Readonly<AxDemandObservation>): void {
  nonEmpty(observation.id, 'AxDemandObservation.id');
  nonEmpty(observation.source, 'AxDemandObservation.source');
  nonEmpty(observation.type, 'AxDemandObservation.type');
  if (!Number.isFinite(observation.observedAt)) {
    throw new Error('AxDemandObservation.observedAt must be finite');
  }
  validateProvenance(observation.provenance, 'observation.provenance');
  axValidateEventEnvelope({
    specversion: '1.0',
    id: observation.id,
    source: observation.source,
    type: observation.type,
    ...(observation.data !== undefined ? { data: observation.data } : {}),
  });
  clone(observation);
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
  validateProvenance(detection.evidence, 'detection.evidence');
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
  clone(detection);
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

export class AxInMemoryDemandStore implements AxDemandStore {
  private readonly records: AxDemandRecord[] = [];
  private readonly byDedupeKey = new Map<string, AxDemandRecord>();

  constructor(seed: readonly Readonly<AxDemandRecord>[] = []) {
    for (const record of seed) {
      const copied = clone(record);
      this.records.push(copied);
      this.byDedupeKey.set(copied.proposal.dedupeKey, copied);
    }
  }

  getByDedupeKey(key: string): Promise<Readonly<AxDemandRecord> | undefined> {
    const record = this.byDedupeKey.get(key);
    return Promise.resolve(record ? clone(record) : undefined);
  }

  append(
    value: Readonly<Omit<AxDemandRecord, 'cursor'>>
  ): Promise<Readonly<AxDemandAppendResult>> {
    const duplicate = this.byDedupeKey.get(value.proposal.dedupeKey);
    if (duplicate) {
      return Promise.resolve({ record: clone(duplicate), duplicate: true });
    }
    const record: AxDemandRecord = {
      ...clone(value),
      cursor: String(this.records.length + 1),
    };
    this.records.push(record);
    this.byDedupeKey.set(record.proposal.dedupeKey, record);
    return Promise.resolve({ record: clone(record), duplicate: false });
  }

  list(
    options: Readonly<{ after?: string; limit?: number }> = {}
  ): Promise<
    Readonly<{ records: readonly Readonly<AxDemandRecord>[]; next?: string }>
  > {
    const after = options.after === undefined ? 0 : Number(options.after);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error('AxDemandStore cursor is invalid');
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('AxDemandStore limit must be between 1 and 1000');
    }
    const records = this.records.slice(after, after + limit).map(clone);
    const next = records.at(-1)?.cursor;
    return Promise.resolve({ records, ...(next ? { next } : {}) });
  }

  snapshot(): readonly Readonly<AxDemandRecord>[] {
    return this.records.map(clone);
  }
}

export class AxDemandBoundary {
  readonly store: AxDemandStore;
  private readonly detector: AxDemandDetector;
  private readonly policy: Readonly<{
    allowedDispositions: readonly AxDemandDisposition[];
    minimumConfidence: Readonly<Record<AxDemandDisposition, number>>;
    maxObservationAgeMs: number;
    proposalTtlMs: number;
    requireStandingGrantFor: readonly AxDemandDisposition[];
    maxObservationBytes: number;
    maxDetectionBytes: number;
  }>;
  private readonly now: () => number;
  private readonly validateStandingGrant?: AxDemandBoundaryOptions['validateStandingGrant'];

  constructor(options: Readonly<AxDemandBoundaryOptions>) {
    nonEmpty(options.detector.id, 'AxDemandDetector.id');
    nonEmpty(options.detector.version, 'AxDemandDetector.version');
    this.detector = options.detector;
    this.store = options.store ?? new AxInMemoryDemandStore();
    this.now = options.now ?? Date.now;
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
      proposalTtlMs: options.policy?.proposalTtlMs ?? 3_600_000,
      requireStandingGrantFor: options.policy?.requireStandingGrantFor ?? [
        'act',
      ],
      maxObservationBytes: options.policy?.maxObservationBytes ?? 1024 * 1024,
      maxDetectionBytes: options.policy?.maxDetectionBytes ?? 64 * 1024,
    };
    if (
      !Number.isFinite(this.policy.maxObservationAgeMs) ||
      this.policy.maxObservationAgeMs < 0 ||
      !Number.isFinite(this.policy.proposalTtlMs) ||
      this.policy.proposalTtlMs <= 0 ||
      !Number.isSafeInteger(this.policy.maxObservationBytes) ||
      this.policy.maxObservationBytes < 1 ||
      !Number.isSafeInteger(this.policy.maxDetectionBytes) ||
      this.policy.maxDetectionBytes < 1
    ) {
      throw new Error('AxDemandPolicy bounds are invalid');
    }
  }

  async observe(
    rawObservation: Readonly<AxDemandObservation>,
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<Readonly<AxDemandReceipt>> {
    validateObservation(rawObservation);
    const observation = clone(rawObservation);
    const observationBytes = bytes(observation);
    if (observationBytes > this.policy.maxObservationBytes) {
      throw new Error(
        `AxDemandObservation is ${observationBytes} bytes; maximum is ${this.policy.maxObservationBytes}`
      );
    }
    const dedupeKey = observation.dedupeKey ?? observation.id;
    const existing = await this.store.getByDedupeKey(dedupeKey);
    if (existing) return { record: existing, duplicate: true };

    const startedAt = this.now();
    let detection: Readonly<AxDemandDetection>;
    try {
      const candidate = await this.detector.detect(observation, options);
      validateDetection(candidate);
      const candidateBytes = bytes(candidate);
      if (candidateBytes > this.policy.maxDetectionBytes) {
        throw new Error(
          `AxDemandDetection is ${candidateBytes} bytes; maximum is ${this.policy.maxDetectionBytes}`
        );
      }
      detection = clone(candidate);
    } catch (error) {
      detection = uncertainDetection(
        'detector_invalid',
        error instanceof Error ? error.message : String(error)
      );
    }
    const finishedAt = this.now();
    const proposal = await this.propose(observation, detection, dedupeKey);
    const appended = await this.store.append({
      observation,
      detection,
      proposal,
      detector: { id: this.detector.id, version: this.detector.version },
      createdAt: finishedAt,
      metrics: {
        detectorCalls: 1,
        detectorLatencyMs: Math.max(0, finishedAt - startedAt),
        observationBytes,
        detectionBytes: bytes(detection),
      },
    });
    return appended;
  }

  list(options?: Readonly<{ after?: string; limit?: number }>) {
    return this.store.list(options);
  }

  private async propose(
    observation: Readonly<AxDemandObservation>,
    detection: Readonly<AxDemandDetection>,
    fallbackDedupeKey: string
  ): Promise<Readonly<AxDemandProposal>> {
    const now = this.now();
    const reasonCodes = [detection.reasonCode];
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
    const stale =
      now - observation.observedAt > this.policy.maxObservationAgeMs ||
      (observation.expiresAt !== undefined && observation.expiresAt <= now);
    if (stale) {
      disposition = safeDisposition('ignore');
      reasonCodes.push('stale_observation');
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
        try {
          standingGrantState = await this.validateStandingGrant(
            detection.standingGrantRef,
            observation
          );
        } catch {
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
    const expiresAt = Math.min(
      now + this.policy.proposalTtlMs,
      requestedExpiry
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
      id: `${axEventIdentityScope(ingress.identity)}\n${ingress.event.source}\n${ingress.event.id}`,
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
    await boundary.observe(observation, { signal: context.abortSignal });
  };
}
