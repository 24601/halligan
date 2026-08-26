import type { AxAgentMemoryResult } from './agentInternal/memoriesTypes.js';
import { rankDocuments } from './agentInternal/relevanceRanker.js';

export const axPreferenceEvidenceLimits = Object.freeze({
  records: 256,
  revisionsPerRecord: 64,
  totalBytes: 262_144,
  recordBytes: 16_384,
  valueChars: 4_000,
  queryChars: 2_000,
  scopeChars: 256,
  idChars: 256,
  receiptRefChars: 512,
  attributes: 32,
  applicabilityEntries: 16,
  relationRefs: 32,
  objectDepth: 8,
  objectWidth: 64,
  topK: 20,
} as const);

const AX_PREFERENCE_EVIDENCE_LIMITS = axPreferenceEvidenceLimits;

export type AxPreferenceEvidenceKind =
  | 'observation'
  | 'inference'
  | 'confirmed-preference';

export type AxPreferenceApplicability = Readonly<{
  allOf?: Readonly<Record<string, string>>;
  noneOf?: Readonly<Record<string, string>>;
}>;

type AxPreferenceRevisionBase = Readonly<{
  revision: number;
  epoch: number;
  eventId: string;
  recordedAt: string;
}>;

type AxPreferenceClaimFields = Readonly<{
  value: string;
  sourceReceiptRef: string;
  confidence: number;
  scope: string;
  applicability?: AxPreferenceApplicability;
  expiresAt?: string;
  contradicts?: readonly string[];
  supersedes?: readonly string[];
  authorityReceiptRef?: string;
  consentReceiptRef?: string;
}>;

export type AxPreferenceEvidenceAssertion = AxPreferenceRevisionBase &
  AxPreferenceClaimFields &
  Readonly<{
    operation: 'assert';
    kind: AxPreferenceEvidenceKind;
  }>;

/** Explicitly reopens a terminal record in a new consent/lifecycle epoch. */
export type AxPreferenceEvidenceRenewal = AxPreferenceRevisionBase &
  AxPreferenceClaimFields &
  Readonly<{
    operation: 'renew';
    kind: 'confirmed-preference';
    authorityReceiptRef: string;
    consentReceiptRef: string;
  }>;

export type AxPreferenceEvidenceRetraction = AxPreferenceRevisionBase &
  Readonly<{
    operation: 'retract';
    sourceReceiptRef: string;
    authorityReceiptRef: string;
  }>;

export type AxPreferenceEvidenceErasure = AxPreferenceRevisionBase &
  Readonly<{
    operation: 'erase';
    sourceReceiptRef: string;
    destructiveAuthorityReceiptRef: string;
  }>;

export type AxPreferenceEvidenceRevision =
  | AxPreferenceEvidenceAssertion
  | AxPreferenceEvidenceRenewal
  | AxPreferenceEvidenceRetraction
  | AxPreferenceEvidenceErasure;

/** Host-owned monotonic stream snapshot for one opaque principal and record. */
export type AxPreferenceEvidenceRecord = Readonly<{
  id: string;
  principalId: string;
  streamId: string;
  streamVersion: number;
  epoch: number;
  revisions: readonly AxPreferenceEvidenceRevision[];
}>;

export type AxPreferenceEvidenceOperation =
  AxPreferenceEvidenceRevision['operation'];

export type AxPreferenceEvidenceReceiptPurpose =
  | 'source'
  | 'authority'
  | 'consent'
  | 'epoch-authority'
  | 'destructive-lifecycle';

export type AxPreferenceEvidenceStreamBinding = Readonly<{
  principalId: string;
  recordId: string;
  streamId: string;
  streamVersion: number;
  epoch: number;
  revision: number;
  eventId: string;
  operation: AxPreferenceEvidenceOperation;
}>;

export type AxPreferenceEvidenceStreamRequest =
  AxPreferenceEvidenceStreamBinding &
    Readonly<{
      /** streamVersion identifies the current snapshot being verified. */
      /** Detached, frozen snapshot for comparison with host-owned state. */
      record: AxPreferenceEvidenceRecord;
    }>;

export type AxPreferenceEvidenceReceiptRequest =
  AxPreferenceEvidenceStreamBinding &
    Readonly<{
      /** streamVersion identifies the immutable stream version that emitted event. */
      purpose: AxPreferenceEvidenceReceiptPurpose;
      receiptRef: string;
      /** Detached, frozen event payload for exact receipt verification. */
      event: AxPreferenceEvidenceRevision;
    }>;

export type AxPreferenceEvidenceExclusionReason =
  | 'malformed'
  | 'principal-mismatch'
  | 'stale-stream'
  | 'unverified-source'
  | 'unverified-authority'
  | 'unverified-consent'
  | 'unverified-destructive-lifecycle'
  | 'scope-mismatch'
  | 'applicability-mismatch'
  | 'future'
  | 'expired'
  | 'retracted'
  | 'erased'
  | 'superseded'
  | 'contradicted'
  | 'ambiguous-chronology'
  | 'policy-blocked';

export type AxPreferenceEvidenceExclusion = Readonly<{
  recordId: string;
  reason: AxPreferenceEvidenceExclusionReason;
}>;

export type AxPreferenceEvidenceClaim =
  | AxPreferenceEvidenceAssertion
  | AxPreferenceEvidenceRenewal;

export type AxSelectedPreferenceEvidence = Readonly<{
  recordId: string;
  principalId: string;
  revision: AxPreferenceEvidenceClaim;
  relevance: number;
}>;

export type AxPreferenceEvidenceSelection = Readonly<{
  applied: readonly AxSelectedPreferenceEvidence[];
  informational: readonly AxSelectedPreferenceEvidence[];
  excluded: readonly AxPreferenceEvidenceExclusion[];
}>;

export type AxPreferenceEvidenceContext = Readonly<{
  principalId: string;
  query: string;
  scope: string;
  attributes?: Readonly<Record<string, string>>;
  now: string;
  topK?: number;
  minConfidence?: number;
  /** Must verify the exact current host-owned stream/version/epoch binding. */
  verifyStreamState: (request: AxPreferenceEvidenceStreamRequest) => boolean;
  /** Must verify source, ordinary authority, consent, and epoch receipts. */
  verifyReceipt: (request: AxPreferenceEvidenceReceiptRequest) => boolean;
  /** Separate verifier for destructive erasure authority. */
  verifyDestructiveLifecycleReceipt: (
    request: AxPreferenceEvidenceReceiptRequest
  ) => boolean;
  allowApplication?: (evidence: AxPreferenceEvidenceClaim) => boolean;
}>;

const issuedMemories = new WeakMap<object, readonly AxAgentMemoryResult[]>();
const textEncoder = new TextEncoder();

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedString(value: unknown, max: number): value is string {
  return nonEmpty(value) && value.length <= max;
}

function validInstant(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertBoundedStructure(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): void {
  if (depth > AX_PREFERENCE_EVIDENCE_LIMITS.objectDepth) {
    throw new Error('Preference evidence exceeds the object depth limit.');
  }
  if (value === undefined || value === null) return;
  if (typeof value === 'string') return;
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value !== 'object') {
    throw new Error('Preference evidence must contain JSON-compatible data.');
  }
  if (seen.has(value)) {
    throw new Error('Preference evidence must not contain cycles.');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > AX_PREFERENCE_EVIDENCE_LIMITS.objectWidth) {
      throw new Error('Preference evidence exceeds the array width limit.');
    }
    for (const entry of value) assertBoundedStructure(entry, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Preference evidence must use plain objects.');
    }
    const entries = Object.entries(value);
    if (entries.length > AX_PREFERENCE_EVIDENCE_LIMITS.objectWidth) {
      throw new Error('Preference evidence exceeds the object width limit.');
    }
    for (const [, entry] of entries) {
      assertBoundedStructure(entry, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function recordIdOrUnknown(value: unknown): string {
  try {
    return isPlainObject(value) &&
      boundedString(value.id, AX_PREFERENCE_EVIDENCE_LIMITS.idChars)
      ? value.id
      : '<unknown>';
  } catch {
    return '<unknown>';
  }
}

function validRef(value: unknown): value is string {
  return boundedString(value, AX_PREFERENCE_EVIDENCE_LIMITS.receiptRefChars);
}

function validRelationRefs(value: unknown): value is readonly string[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= AX_PREFERENCE_EVIDENCE_LIMITS.relationRefs &&
      value.every((entry) =>
        boundedString(entry, AX_PREFERENCE_EVIDENCE_LIMITS.idChars)
      ))
  );
}

function validApplicability(
  value: unknown
): value is AxPreferenceApplicability {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as AxPreferenceApplicability;
  const groups = [candidate.allOf, candidate.noneOf];
  let entries = 0;
  for (const group of groups) {
    if (group === undefined) continue;
    if (!group || typeof group !== 'object' || Array.isArray(group))
      return false;
    const pairs = Object.entries(group);
    entries += pairs.length;
    if (
      pairs.some(
        ([key, entry]) =>
          !boundedString(key, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
          !boundedString(entry, AX_PREFERENCE_EVIDENCE_LIMITS.idChars)
      )
    ) {
      return false;
    }
  }
  return entries <= AX_PREFERENCE_EVIDENCE_LIMITS.applicabilityEntries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validBase(revision: AxPreferenceEvidenceRevision): boolean {
  return (
    isPlainObject(revision) &&
    positiveInteger(revision.revision) &&
    positiveInteger(revision.epoch) &&
    boundedString(revision.eventId, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) &&
    validInstant(revision.recordedAt)
  );
}

function validClaim(revision: AxPreferenceEvidenceClaim): boolean {
  return (
    validBase(revision) &&
    boundedString(revision.value, AX_PREFERENCE_EVIDENCE_LIMITS.valueChars) &&
    validRef(revision.sourceReceiptRef) &&
    Number.isFinite(revision.confidence) &&
    revision.confidence >= 0 &&
    revision.confidence <= 1 &&
    boundedString(revision.scope, AX_PREFERENCE_EVIDENCE_LIMITS.scopeChars) &&
    validApplicability(revision.applicability) &&
    (revision.expiresAt === undefined || validInstant(revision.expiresAt)) &&
    validRelationRefs(revision.contradicts) &&
    validRelationRefs(revision.supersedes) &&
    (revision.kind !== 'confirmed-preference' ||
      (validRef(revision.authorityReceiptRef) &&
        validRef(revision.consentReceiptRef)))
  );
}

function validRevision(revision: AxPreferenceEvidenceRevision): boolean {
  if (!validBase(revision)) return false;
  if (revision.operation === 'assert' || revision.operation === 'renew') {
    return validClaim(revision);
  }
  if (revision.operation === 'retract') {
    return (
      validRef(revision.sourceReceiptRef) &&
      validRef(revision.authorityReceiptRef)
    );
  }
  return (
    revision.operation === 'erase' &&
    validRef(revision.sourceReceiptRef) &&
    validRef(revision.destructiveAuthorityReceiptRef)
  );
}

function validRecord(record: AxPreferenceEvidenceRecord): boolean {
  if (
    !isPlainObject(record) ||
    !boundedString(record.id, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
    !boundedString(record.principalId, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
    !boundedString(record.streamId, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
    !positiveInteger(record.streamVersion) ||
    !positiveInteger(record.epoch) ||
    !Array.isArray(record.revisions) ||
    record.revisions.length === 0 ||
    record.revisions.length > AX_PREFERENCE_EVIDENCE_LIMITS.revisionsPerRecord
  ) {
    return false;
  }
  const first = record.revisions[0] as AxPreferenceEvidenceRevision;
  if (
    !validRevision(first) ||
    (first.revision === 1 &&
      (first.operation !== 'assert' || first.epoch !== 1)) ||
    (first.revision !== 1 && first.operation !== 'erase')
  ) {
    return false;
  }
  let previous: AxPreferenceEvidenceRevision | undefined;
  let epoch = first.epoch;
  let terminal = false;
  const eventIds = new Set<string>();
  for (const revision of record.revisions) {
    if (!validRevision(revision) || eventIds.has(revision.eventId))
      return false;
    eventIds.add(revision.eventId);
    if (previous) {
      if (
        revision.revision !== previous.revision + 1 ||
        Date.parse(revision.recordedAt) <= Date.parse(previous.recordedAt)
      ) {
        return false;
      }
    }
    if (revision.operation === 'renew') {
      if (!terminal || revision.epoch !== epoch + 1) return false;
      epoch = revision.epoch;
      terminal = false;
    } else {
      if (revision.epoch !== epoch || terminal) return false;
      if (revision.operation === 'retract' || revision.operation === 'erase') {
        terminal = true;
      }
    }
    previous = revision;
  }
  return record.streamVersion === previous?.revision && record.epoch === epoch;
}

function applies(
  applicability: AxPreferenceApplicability | undefined,
  attributes: Readonly<Record<string, string>>
): boolean {
  if (!applicability) return true;
  if (
    Object.entries(applicability.allOf ?? {}).some(
      ([key, value]) => attributes[key] !== value
    )
  ) {
    return false;
  }
  return !Object.entries(applicability.noneOf ?? {}).some(
    ([key, value]) => attributes[key] === value
  );
}

type Candidate = Readonly<{
  record: AxPreferenceEvidenceRecord;
  revision: AxPreferenceEvidenceClaim;
  resolvedSelfContradiction: boolean;
}>;

function claimPriority(kind: AxPreferenceEvidenceKind): number {
  if (kind === 'confirmed-preference') return 3;
  if (kind === 'observation') return 2;
  return 1;
}

function effectiveClaim(record: AxPreferenceEvidenceRecord): Readonly<{
  revision: AxPreferenceEvidenceRevision;
  resolvedSelfContradiction: boolean;
}> {
  const latest = record.revisions.at(-1) as AxPreferenceEvidenceRevision;
  if (latest.operation === 'retract' || latest.operation === 'erase') {
    return { revision: latest, resolvedSelfContradiction: false };
  }
  const claims = record.revisions.filter(
    (revision): revision is AxPreferenceEvidenceClaim =>
      revision.epoch === record.epoch &&
      (revision.operation === 'assert' || revision.operation === 'renew')
  );
  if (!claims.some((claim) => claim.contradicts?.includes(record.id))) {
    return { revision: latest, resolvedSelfContradiction: false };
  }
  const strongest = [...claims].sort(
    (left, right) =>
      claimPriority(right.kind) - claimPriority(left.kind) ||
      right.confidence - left.confidence ||
      right.revision - left.revision
  );
  const selected = strongest[0] as AxPreferenceEvidenceClaim;
  const runnerUp = strongest[1];
  const resolvedSelfContradiction = Boolean(
    runnerUp &&
      (claimPriority(selected.kind) > claimPriority(runnerUp.kind) ||
        (claimPriority(selected.kind) === claimPriority(runnerUp.kind) &&
          selected.confidence > runnerUp.confidence))
  );
  return {
    revision: resolvedSelfContradiction ? selected : latest,
    resolvedSelfContradiction,
  };
}

function currentStreamBinding(
  record: AxPreferenceEvidenceRecord,
  revision: AxPreferenceEvidenceRevision
): AxPreferenceEvidenceStreamBinding {
  return deepFreeze({
    principalId: record.principalId,
    recordId: record.id,
    streamId: record.streamId,
    streamVersion: record.streamVersion,
    epoch: revision.epoch,
    revision: revision.revision,
    eventId: revision.eventId,
    operation: revision.operation,
  });
}

function historicalReceiptBinding(
  current: AxPreferenceEvidenceStreamBinding,
  revision: AxPreferenceEvidenceRevision
): AxPreferenceEvidenceStreamBinding {
  return deepFreeze({ ...current, streamVersion: revision.revision });
}

function verify(
  verifier: (request: AxPreferenceEvidenceReceiptRequest) => boolean,
  binding: AxPreferenceEvidenceStreamBinding,
  revision: AxPreferenceEvidenceRevision,
  purpose: AxPreferenceEvidenceReceiptPurpose,
  receiptRef: string
): boolean {
  try {
    return (
      verifier(
        deepFreeze({ ...binding, purpose, receiptRef, event: revision })
      ) === true
    );
  } catch {
    return false;
  }
}

function verifyStream(
  verifier: (request: AxPreferenceEvidenceStreamRequest) => boolean,
  binding: AxPreferenceEvidenceStreamBinding,
  record: AxPreferenceEvidenceRecord
): boolean {
  try {
    return verifier(deepFreeze({ ...binding, record })) === true;
  } catch {
    return false;
  }
}

function rank(
  query: string,
  candidates: readonly Candidate[],
  topK: number
): AxSelectedPreferenceEvidence[] {
  if (candidates.length === 0 || topK <= 0) return [];
  const byId = new Map(
    candidates.map((candidate) => [candidate.record.id, candidate])
  );
  return rankDocuments(
    query,
    candidates.map(({ record, revision }) => ({
      id: record.id,
      fields: [{ text: revision.value }],
    })),
    { topK: candidates.length, minDocs: 1 }
  )
    .map((result) => ({ result, candidate: byId.get(result.id) }))
    .filter(
      (
        entry
      ): entry is {
        result: { id: string; score: number; matchedTerms: string[] };
        candidate: Candidate;
      } => entry.candidate !== undefined
    )
    .sort(
      (left, right) =>
        right.result.score - left.result.score ||
        right.candidate.revision.confidence -
          left.candidate.revision.confidence ||
        Date.parse(right.candidate.revision.recordedAt) -
          Date.parse(left.candidate.revision.recordedAt) ||
        right.candidate.record.streamVersion -
          left.candidate.record.streamVersion ||
        left.candidate.record.id.localeCompare(right.candidate.record.id)
    )
    .slice(0, topK)
    .map(({ result, candidate }) => ({
      recordId: candidate.record.id,
      principalId: candidate.record.principalId,
      revision: candidate.revision,
      relevance: result.score,
    }));
}

function validateContext(context: AxPreferenceEvidenceContext): void {
  if (
    !boundedString(
      context.principalId,
      AX_PREFERENCE_EVIDENCE_LIMITS.idChars
    ) ||
    !boundedString(context.query, AX_PREFERENCE_EVIDENCE_LIMITS.queryChars) ||
    !boundedString(context.scope, AX_PREFERENCE_EVIDENCE_LIMITS.scopeChars) ||
    !validInstant(context.now) ||
    typeof context.verifyStreamState !== 'function' ||
    typeof context.verifyReceipt !== 'function' ||
    typeof context.verifyDestructiveLifecycleReceipt !== 'function' ||
    (context.topK !== undefined &&
      (!Number.isSafeInteger(context.topK) ||
        context.topK < 0 ||
        context.topK > AX_PREFERENCE_EVIDENCE_LIMITS.topK)) ||
    (context.minConfidence !== undefined &&
      (!Number.isFinite(context.minConfidence) ||
        context.minConfidence < 0 ||
        context.minConfidence > 1))
  ) {
    throw new Error(
      'Preference evidence selection requires bounded host context.'
    );
  }
  const attributes = Object.entries(context.attributes ?? {});
  if (
    attributes.length > AX_PREFERENCE_EVIDENCE_LIMITS.attributes ||
    attributes.some(
      ([key, value]) =>
        !boundedString(key, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
        !boundedString(value, AX_PREFERENCE_EVIDENCE_LIMITS.idChars)
    )
  ) {
    throw new Error('Preference evidence context exceeds attribute limits.');
  }
}

type BoundedRecord = Readonly<{
  value: unknown;
  recordId: string;
  malformedStructure: boolean;
}>;

function boundedRecords(records: readonly unknown[]): BoundedRecord[] {
  if (records.length > AX_PREFERENCE_EVIDENCE_LIMITS.records) {
    throw new Error('Preference evidence exceeds the record count limit.');
  }
  let totalBytes = 0;
  return records.map((record) => {
    let serialized: string | undefined;
    try {
      assertBoundedStructure(record);
      serialized = JSON.stringify(record);
    } catch {
      return {
        value: undefined,
        recordId: recordIdOrUnknown(record),
        malformedStructure: true,
      };
    }
    if (serialized === undefined) {
      return {
        value: undefined,
        recordId: recordIdOrUnknown(record),
        malformedStructure: true,
      };
    }
    const bytes = textEncoder.encode(serialized).byteLength;
    if (bytes > AX_PREFERENCE_EVIDENCE_LIMITS.recordBytes) {
      return {
        value: undefined,
        recordId: recordIdOrUnknown(record),
        malformedStructure: true,
      };
    }
    totalBytes += bytes;
    if (totalBytes > AX_PREFERENCE_EVIDENCE_LIMITS.totalBytes) {
      throw new Error('Preference evidence exceeds the total byte limit.');
    }
    return {
      value: deepFreeze(JSON.parse(serialized) as unknown),
      recordId: recordIdOrUnknown(record),
      malformedStructure: false,
    };
  });
}

export function axSelectPreferenceEvidence(
  inputRecords: readonly AxPreferenceEvidenceRecord[],
  context: AxPreferenceEvidenceContext
): AxPreferenceEvidenceSelection {
  validateContext(context);
  const records = boundedRecords(inputRecords);
  const excluded: AxPreferenceEvidenceExclusion[] = [];
  const candidates: Candidate[] = [];
  const now = Date.parse(context.now);
  const minConfidence = context.minConfidence ?? 0;
  const idCounts = new Map<string, number>();
  for (const { value: record, malformedStructure } of records) {
    if (malformedStructure) continue;
    if (isPlainObject(record) && nonEmpty(record.id)) {
      idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
    }
  }

  for (const bounded of records) {
    const candidate = bounded.value;
    if (
      bounded.malformedStructure ||
      !validRecord(candidate as AxPreferenceEvidenceRecord) ||
      (idCounts.get((candidate as AxPreferenceEvidenceRecord).id) ?? 0) > 1
    ) {
      excluded.push({
        recordId: bounded.recordId,
        reason: 'malformed',
      });
      continue;
    }
    const record = candidate as AxPreferenceEvidenceRecord;
    if (record.principalId !== context.principalId) {
      excluded.push({ recordId: record.id, reason: 'principal-mismatch' });
      continue;
    }
    const effective = effectiveClaim(record);
    const latest = effective.revision;
    const streamBinding = currentStreamBinding(record, latest);
    if (!verifyStream(context.verifyStreamState, streamBinding, record)) {
      excluded.push({ recordId: record.id, reason: 'stale-stream' });
      continue;
    }
    const receiptBinding = historicalReceiptBinding(streamBinding, latest);
    if (Date.parse(latest.recordedAt) > now) {
      excluded.push({ recordId: record.id, reason: 'future' });
      continue;
    }
    if (
      !verify(
        context.verifyReceipt,
        receiptBinding,
        latest,
        'source',
        latest.sourceReceiptRef
      )
    ) {
      excluded.push({ recordId: record.id, reason: 'unverified-source' });
      continue;
    }
    if (latest.operation === 'erase') {
      if (
        !verify(
          context.verifyDestructiveLifecycleReceipt,
          receiptBinding,
          latest,
          'destructive-lifecycle',
          latest.destructiveAuthorityReceiptRef
        )
      ) {
        excluded.push({
          recordId: record.id,
          reason: 'unverified-destructive-lifecycle',
        });
        continue;
      }
      excluded.push({ recordId: record.id, reason: 'erased' });
      continue;
    }
    if (latest.operation === 'retract') {
      if (
        !verify(
          context.verifyReceipt,
          receiptBinding,
          latest,
          'authority',
          latest.authorityReceiptRef
        )
      ) {
        excluded.push({ recordId: record.id, reason: 'unverified-authority' });
        continue;
      }
      excluded.push({ recordId: record.id, reason: 'retracted' });
      continue;
    }
    if (latest.operation === 'renew') {
      if (
        !verify(
          context.verifyReceipt,
          receiptBinding,
          latest,
          'epoch-authority',
          latest.authorityReceiptRef
        )
      ) {
        excluded.push({ recordId: record.id, reason: 'unverified-authority' });
        continue;
      }
      if (
        !verify(
          context.verifyReceipt,
          receiptBinding,
          latest,
          'consent',
          latest.consentReceiptRef
        )
      ) {
        excluded.push({ recordId: record.id, reason: 'unverified-consent' });
        continue;
      }
    } else if (latest.kind === 'confirmed-preference') {
      if (
        !verify(
          context.verifyReceipt,
          receiptBinding,
          latest,
          'authority',
          latest.authorityReceiptRef as string
        )
      ) {
        excluded.push({ recordId: record.id, reason: 'unverified-authority' });
        continue;
      }
      if (
        !verify(
          context.verifyReceipt,
          receiptBinding,
          latest,
          'consent',
          latest.consentReceiptRef as string
        )
      ) {
        excluded.push({ recordId: record.id, reason: 'unverified-consent' });
        continue;
      }
    }
    if (latest.scope !== context.scope) {
      excluded.push({ recordId: record.id, reason: 'scope-mismatch' });
      continue;
    }
    if (!applies(latest.applicability, context.attributes ?? {})) {
      excluded.push({ recordId: record.id, reason: 'applicability-mismatch' });
      continue;
    }
    if (latest.expiresAt && Date.parse(latest.expiresAt) <= now) {
      excluded.push({ recordId: record.id, reason: 'expired' });
      continue;
    }
    if (latest.confidence < minConfidence) {
      excluded.push({ recordId: record.id, reason: 'policy-blocked' });
      continue;
    }
    if (latest.kind === 'confirmed-preference' && context.allowApplication) {
      let allowed = false;
      try {
        allowed = context.allowApplication(deepFreeze({ ...latest })) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        excluded.push({ recordId: record.id, reason: 'policy-blocked' });
        continue;
      }
    }
    candidates.push({
      record,
      revision: latest,
      resolvedSelfContradiction: effective.resolvedSelfContradiction,
    });
  }

  const relationshipSources = candidates.filter(
    ({ revision }) =>
      revision.kind === 'confirmed-preference' ||
      revision.kind === 'observation' ||
      revision.kind === 'inference'
  );
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.record.id, candidate])
  );
  const superseded = new Set<string>();
  const ambiguous = new Set<string>();
  for (const source of relationshipSources) {
    for (const targetId of source.revision.supersedes ?? []) {
      const target = candidateById.get(targetId);
      if (!target) continue;
      if (
        Date.parse(source.revision.recordedAt) >
        Date.parse(target.revision.recordedAt)
      ) {
        superseded.add(targetId);
      } else {
        ambiguous.add(source.record.id);
        ambiguous.add(targetId);
      }
    }
  }
  const candidateIds = new Set(candidates.map(({ record }) => record.id));
  const contradicted = new Set<string>();
  for (const {
    record,
    revision,
    resolvedSelfContradiction,
  } of relationshipSources) {
    for (const target of revision.contradicts ?? []) {
      if (target === record.id && resolvedSelfContradiction) continue;
      if (
        candidateIds.has(target) &&
        !superseded.has(target) &&
        !superseded.has(record.id)
      ) {
        contradicted.add(record.id);
        contradicted.add(target);
      }
    }
  }

  const eligible = candidates.filter(({ record }) => {
    if (ambiguous.has(record.id)) {
      excluded.push({ recordId: record.id, reason: 'ambiguous-chronology' });
      return false;
    }
    if (superseded.has(record.id)) {
      excluded.push({ recordId: record.id, reason: 'superseded' });
      return false;
    }
    if (contradicted.has(record.id)) {
      excluded.push({ recordId: record.id, reason: 'contradicted' });
      return false;
    }
    return true;
  });
  const topK = context.topK ?? 3;
  const selection = deepFreeze<AxPreferenceEvidenceSelection>({
    applied: rank(
      context.query,
      eligible.filter(
        ({ revision }) => revision.kind === 'confirmed-preference'
      ),
      topK
    ),
    informational: rank(
      context.query,
      eligible.filter(
        ({ revision }) => revision.kind !== 'confirmed-preference'
      ),
      topK
    ),
    excluded: excluded.sort(
      (left, right) =>
        left.recordId.localeCompare(right.recordId) ||
        left.reason.localeCompare(right.reason)
    ),
  });
  issuedMemories.set(
    selection,
    deepFreeze(
      selection.applied.map(({ recordId, revision }) => ({
        id: `preference:${recordId}@${revision.epoch}.${revision.revision}`,
        content: [
          'Host-confirmed preference evidence.',
          `Scope: ${revision.scope}`,
          `Preference: ${revision.value}`,
        ].join('\n'),
      }))
    )
  );
  return selection;
}

export function axPreferenceEvidenceToMemories(
  selection: AxPreferenceEvidenceSelection
): AxAgentMemoryResult[] {
  const memories = issuedMemories.get(selection);
  if (!memories) {
    throw new Error(
      'Preference memories require a selection issued by axSelectPreferenceEvidence().'
    );
  }
  return deepFreeze(
    memories.map((memory) => ({ ...memory }))
  ) as AxAgentMemoryResult[];
}

function latestRevision(
  record: AxPreferenceEvidenceRecord
): AxPreferenceEvidenceRevision {
  return record.revisions.at(-1) as AxPreferenceEvidenceRevision;
}

function publishLifecycleRecord(
  record: AxPreferenceEvidenceRecord
): AxPreferenceEvidenceRecord {
  const published = boundedRecords([record])[0]?.value as
    | AxPreferenceEvidenceRecord
    | undefined;
  if (!published || !validRecord(published)) {
    throw new Error(
      'Lifecycle operation produced invalid preference evidence.'
    );
  }
  return published;
}

function validLifecycleTime(
  record: AxPreferenceEvidenceRecord,
  recordedAt: string
): boolean {
  return (
    validInstant(recordedAt) &&
    Date.parse(recordedAt) > Date.parse(latestRevision(record).recordedAt)
  );
}

export function axRetractPreferenceEvidence(
  record: AxPreferenceEvidenceRecord,
  event: Readonly<{
    eventId: string;
    recordedAt: string;
    sourceReceiptRef: string;
    authorityReceiptRef: string;
  }>
): AxPreferenceEvidenceRecord {
  if (
    !validRecord(record) ||
    !validLifecycleTime(record, event.recordedAt) ||
    record.revisions.length >=
      AX_PREFERENCE_EVIDENCE_LIMITS.revisionsPerRecord ||
    latestRevision(record).operation === 'retract' ||
    latestRevision(record).operation === 'erase' ||
    !boundedString(event.eventId, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
    record.revisions.some((revision) => revision.eventId === event.eventId) ||
    !validRef(event.sourceReceiptRef) ||
    !validRef(event.authorityReceiptRef)
  ) {
    throw new Error(
      'Cannot retract malformed or terminal preference evidence.'
    );
  }
  return publishLifecycleRecord({
    ...record,
    streamVersion: record.streamVersion + 1,
    revisions: [
      ...record.revisions,
      {
        operation: 'retract',
        revision: record.streamVersion + 1,
        epoch: record.epoch,
        ...event,
      },
    ],
  });
}

export function axErasePreferenceEvidence(
  record: AxPreferenceEvidenceRecord,
  event: Readonly<{
    eventId: string;
    recordedAt: string;
    sourceReceiptRef: string;
    destructiveAuthorityReceiptRef: string;
  }>
): AxPreferenceEvidenceRecord {
  if (
    !validRecord(record) ||
    !validLifecycleTime(record, event.recordedAt) ||
    !boundedString(event.eventId, AX_PREFERENCE_EVIDENCE_LIMITS.idChars) ||
    record.revisions.some((revision) => revision.eventId === event.eventId) ||
    !validRef(event.sourceReceiptRef) ||
    !validRef(event.destructiveAuthorityReceiptRef)
  ) {
    throw new Error('Cannot erase malformed preference evidence.');
  }
  return publishLifecycleRecord({
    id: record.id,
    principalId: record.principalId,
    streamId: record.streamId,
    streamVersion: record.streamVersion + 1,
    epoch: record.epoch,
    revisions: [
      {
        operation: 'erase',
        revision: record.streamVersion + 1,
        epoch: record.epoch,
        eventId: event.eventId,
        recordedAt: event.recordedAt,
        sourceReceiptRef: event.sourceReceiptRef,
        destructiveAuthorityReceiptRef: event.destructiveAuthorityReceiptRef,
      },
    ],
  });
}

export function axRenewPreferenceEvidence(
  record: AxPreferenceEvidenceRecord,
  event: Readonly<
    Omit<
      AxPreferenceEvidenceRenewal,
      'operation' | 'revision' | 'epoch' | 'kind'
    >
  >
): AxPreferenceEvidenceRecord {
  if (!validRecord(record)) {
    throw new Error(
      'Preference renewal requires valid terminal evidence and strict chronology.'
    );
  }
  const latest = latestRevision(record);
  if (
    (latest.operation !== 'retract' && latest.operation !== 'erase') ||
    !validLifecycleTime(record, event.recordedAt) ||
    record.revisions.length >=
      AX_PREFERENCE_EVIDENCE_LIMITS.revisionsPerRecord ||
    record.revisions.some((revision) => revision.eventId === event.eventId)
  ) {
    throw new Error(
      'Preference renewal requires valid terminal evidence and strict chronology.'
    );
  }
  const renewal: AxPreferenceEvidenceRenewal = {
    ...event,
    operation: 'renew',
    revision: record.streamVersion + 1,
    epoch: record.epoch + 1,
    kind: 'confirmed-preference',
  };
  if (!validClaim(renewal)) {
    throw new Error('Cannot renew malformed preference evidence.');
  }
  return publishLifecycleRecord({
    ...record,
    streamVersion: renewal.revision,
    epoch: renewal.epoch,
    revisions: [...record.revisions, renewal],
  });
}
