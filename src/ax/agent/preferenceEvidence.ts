import type { AxAgentMemoryResult } from './agentInternal/memoriesTypes.js';
import { rankDocuments } from './agentInternal/relevanceRanker.js';

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
  recordedAt: string;
}>;

export type AxPreferenceEvidenceAssertion = AxPreferenceRevisionBase &
  Readonly<{
    operation: 'assert';
    kind: AxPreferenceEvidenceKind;
    value: string;
    sourceRef: string;
    confidence: number;
    scope: string;
    applicability?: AxPreferenceApplicability;
    expiresAt?: string;
    contradicts?: readonly string[];
    supersedes?: readonly string[];
    /** Required for confirmed preferences and accepted only through host policy. */
    authorityRef?: string;
    /** Required for confirmed preferences and accepted only through host policy. */
    consentRef?: string;
  }>;

export type AxPreferenceEvidenceRetraction = AxPreferenceRevisionBase &
  Readonly<{
    operation: 'retract';
    sourceRef: string;
    authorityRef: string;
  }>;

export type AxPreferenceEvidenceErasure = AxPreferenceRevisionBase &
  Readonly<{
    operation: 'erase';
    authorityRef: string;
  }>;

export type AxPreferenceEvidenceRevision =
  | AxPreferenceEvidenceAssertion
  | AxPreferenceEvidenceRetraction
  | AxPreferenceEvidenceErasure;

/**
 * Host-persisted evidence for one opaque principal. Ax neither authenticates
 * principal IDs nor stores these records. The host must keep identity and
 * authority outside model-authored text.
 */
export type AxPreferenceEvidenceRecord = Readonly<{
  id: string;
  principalId: string;
  revisions: readonly AxPreferenceEvidenceRevision[];
}>;

export type AxPreferenceEvidenceExclusionReason =
  | 'malformed'
  | 'principal-mismatch'
  | 'untrusted-source'
  | 'untrusted-authority'
  | 'untrusted-consent'
  | 'scope-mismatch'
  | 'applicability-mismatch'
  | 'future'
  | 'expired'
  | 'retracted'
  | 'erased'
  | 'superseded'
  | 'contradicted'
  | 'policy-blocked';

export type AxPreferenceEvidenceExclusion = Readonly<{
  recordId: string;
  reason: AxPreferenceEvidenceExclusionReason;
}>;

export type AxSelectedPreferenceEvidence = Readonly<{
  recordId: string;
  principalId: string;
  revision: AxPreferenceEvidenceAssertion;
  relevance: number;
}>;

export type AxPreferenceEvidenceSelection = Readonly<{
  /** Confirmed, authorized preferences safe to adapt into existing memory. */
  applied: readonly AxSelectedPreferenceEvidence[];
  /** Relevant observations/inferences for host inspection, never application. */
  informational: readonly AxSelectedPreferenceEvidence[];
  excluded: readonly AxPreferenceEvidenceExclusion[];
}>;

export type AxPreferenceEvidenceContext = Readonly<{
  /** Principal established by the host, never read from evidence/model text. */
  principalId: string;
  query: string;
  scope: string;
  attributes?: Readonly<Record<string, string>>;
  now: string;
  acceptedSourceRefs: readonly string[];
  acceptedAuthorityRefs: readonly string[];
  acceptedConsentRefs: readonly string[];
  topK?: number;
  minConfidence?: number;
  /** Host safety/product policy; evidence cannot authorize its own application. */
  allowApplication?: (evidence: AxPreferenceEvidenceAssertion) => boolean;
}>;

const issuedMemories = new WeakMap<object, readonly AxAgentMemoryResult[]>();

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validInstant(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function validRefs(value: unknown): value is readonly string[] {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => nonEmpty(entry)))
  );
}

function validApplicability(
  value: unknown
): value is AxPreferenceApplicability {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as AxPreferenceApplicability;
  return [candidate.allOf, candidate.noneOf].every(
    (group) =>
      group === undefined ||
      (group !== null &&
        typeof group === 'object' &&
        !Array.isArray(group) &&
        Object.entries(group).every(
          ([key, entry]) => nonEmpty(key) && nonEmpty(entry)
        ))
  );
}

function validAssertion(
  value: unknown
): value is AxPreferenceEvidenceAssertion {
  if (!value || typeof value !== 'object') return false;
  const revision = value as AxPreferenceEvidenceAssertion;
  return (
    revision.operation === 'assert' &&
    Number.isSafeInteger(revision.revision) &&
    revision.revision > 0 &&
    validInstant(revision.recordedAt) &&
    ['observation', 'inference', 'confirmed-preference'].includes(
      revision.kind
    ) &&
    nonEmpty(revision.value) &&
    nonEmpty(revision.sourceRef) &&
    Number.isFinite(revision.confidence) &&
    revision.confidence >= 0 &&
    revision.confidence <= 1 &&
    nonEmpty(revision.scope) &&
    validApplicability(revision.applicability) &&
    (revision.expiresAt === undefined || validInstant(revision.expiresAt)) &&
    validRefs(revision.contradicts) &&
    validRefs(revision.supersedes) &&
    (revision.kind !== 'confirmed-preference' ||
      (nonEmpty(revision.authorityRef) && nonEmpty(revision.consentRef)))
  );
}

function validRecord(record: AxPreferenceEvidenceRecord): boolean {
  if (
    !record ||
    !nonEmpty(record.id) ||
    !nonEmpty(record.principalId) ||
    !Array.isArray(record.revisions) ||
    record.revisions.length === 0
  ) {
    return false;
  }
  let previousRecordedAt = Number.NEGATIVE_INFINITY;
  return record.revisions.every((revision, index) => {
    if (
      !revision ||
      typeof revision !== 'object' ||
      revision.revision !== index + 1 ||
      !validInstant(revision.recordedAt)
    ) {
      return false;
    }
    const recordedAt = Date.parse(revision.recordedAt);
    if (recordedAt < previousRecordedAt) return false;
    previousRecordedAt = recordedAt;
    if (revision.operation === 'assert') return validAssertion(revision);
    if (revision.operation === 'retract') {
      return nonEmpty(revision.sourceRef) && nonEmpty(revision.authorityRef);
    }
    return revision.operation === 'erase' && nonEmpty(revision.authorityRef);
  });
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
  revision: AxPreferenceEvidenceAssertion;
}>;

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
      fields: [
        { text: revision.scope, identifier: true, weight: 2 },
        { text: revision.value },
      ],
    })),
    { topK: candidates.length, minDocs: 1, minScore: 0, marginRatio: 0 }
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

/**
 * Select authorized preference evidence without storage, identity inference,
 * model calls, or automatic promotion. Malformed and untrusted input fails
 * closed and remains visible through `excluded`.
 */
export function axSelectPreferenceEvidence(
  records: readonly AxPreferenceEvidenceRecord[],
  context: AxPreferenceEvidenceContext
): AxPreferenceEvidenceSelection {
  if (
    !nonEmpty(context.principalId) ||
    !nonEmpty(context.query) ||
    !nonEmpty(context.scope) ||
    !validInstant(context.now) ||
    (context.topK !== undefined &&
      (!Number.isSafeInteger(context.topK) || context.topK < 0)) ||
    (context.minConfidence !== undefined &&
      (!Number.isFinite(context.minConfidence) ||
        context.minConfidence < 0 ||
        context.minConfidence > 1))
  ) {
    throw new Error(
      'Preference evidence selection requires valid host context.'
    );
  }
  const acceptedSources = new Set(context.acceptedSourceRefs);
  const acceptedAuthorities = new Set(context.acceptedAuthorityRefs);
  const acceptedConsents = new Set(context.acceptedConsentRefs);
  const excluded: AxPreferenceEvidenceExclusion[] = [];
  const candidates: Candidate[] = [];
  const now = Date.parse(context.now);
  const minConfidence = context.minConfidence ?? 0;
  const idCounts = new Map<string, number>();
  for (const record of records) {
    if (nonEmpty(record?.id)) {
      idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
    }
  }

  for (const record of records) {
    if (!validRecord(record) || (idCounts.get(record.id) ?? 0) > 1) {
      excluded.push({
        recordId: nonEmpty(record?.id) ? record.id : '<unknown>',
        reason: 'malformed',
      });
      continue;
    }
    if (record.principalId !== context.principalId) {
      excluded.push({ recordId: record.id, reason: 'principal-mismatch' });
      continue;
    }
    const latest = record.revisions.at(-1) as AxPreferenceEvidenceRevision;
    if (Date.parse(latest.recordedAt) > now) {
      excluded.push({ recordId: record.id, reason: 'future' });
      continue;
    }
    if (latest.operation === 'erase') {
      if (!acceptedAuthorities.has(latest.authorityRef)) {
        excluded.push({ recordId: record.id, reason: 'untrusted-authority' });
        continue;
      }
      excluded.push({ recordId: record.id, reason: 'erased' });
      continue;
    }
    if (latest.operation === 'retract') {
      if (!acceptedSources.has(latest.sourceRef)) {
        excluded.push({ recordId: record.id, reason: 'untrusted-source' });
        continue;
      }
      if (!acceptedAuthorities.has(latest.authorityRef)) {
        excluded.push({ recordId: record.id, reason: 'untrusted-authority' });
        continue;
      }
      excluded.push({ recordId: record.id, reason: 'retracted' });
      continue;
    }
    if (!acceptedSources.has(latest.sourceRef)) {
      excluded.push({ recordId: record.id, reason: 'untrusted-source' });
      continue;
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
    if (latest.kind === 'confirmed-preference') {
      if (!acceptedAuthorities.has(latest.authorityRef as string)) {
        excluded.push({ recordId: record.id, reason: 'untrusted-authority' });
        continue;
      }
      if (!acceptedConsents.has(latest.consentRef as string)) {
        excluded.push({ recordId: record.id, reason: 'untrusted-consent' });
        continue;
      }
    }
    candidates.push({ record, revision: latest });
  }

  const relationshipSources = candidates.filter(
    ({ revision }) => revision.kind === 'confirmed-preference'
  );
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.record.id, candidate])
  );
  const superseded = new Set<string>();
  for (const source of relationshipSources) {
    for (const targetId of source.revision.supersedes ?? []) {
      const target = candidateById.get(targetId);
      if (
        target &&
        Date.parse(source.revision.recordedAt) >
          Date.parse(target.revision.recordedAt)
      ) {
        superseded.add(targetId);
      }
    }
  }
  const candidateIds = new Set(candidates.map(({ record }) => record.id));
  const contradicted = new Set<string>();
  for (const { record, revision } of relationshipSources) {
    for (const target of revision.contradicts ?? []) {
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

  const eligible = candidates.filter(({ record, revision }) => {
    if (superseded.has(record.id)) {
      excluded.push({ recordId: record.id, reason: 'superseded' });
      return false;
    }
    if (contradicted.has(record.id)) {
      excluded.push({ recordId: record.id, reason: 'contradicted' });
      return false;
    }
    if (
      revision.kind === 'confirmed-preference' &&
      context.allowApplication &&
      !context.allowApplication(revision)
    ) {
      excluded.push({ recordId: record.id, reason: 'policy-blocked' });
      return false;
    }
    return true;
  });
  const topK = context.topK ?? 3;

  const selection: AxPreferenceEvidenceSelection = {
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
  };
  issuedMemories.set(
    selection,
    selection.applied.map(({ recordId, revision }) => ({
      id: `preference:${recordId}@${revision.revision}`,
      content: [
        'Host-confirmed preference evidence.',
        `Scope: ${revision.scope}`,
        `Preference: ${revision.value}`,
      ].join('\n'),
    }))
  );
  return selection;
}

/** Convert only confirmed selections to Ax's existing opaque memory input. */
export function axPreferenceEvidenceToMemories(
  selection: AxPreferenceEvidenceSelection
): AxAgentMemoryResult[] {
  const memories = issuedMemories.get(selection);
  if (!memories) {
    throw new Error(
      'Preference memories require a selection issued by axSelectPreferenceEvidence().'
    );
  }
  return memories.map((memory) => ({ ...memory }));
}

/** Append a reversible retraction while retaining prior revision evidence. */
export function axRetractPreferenceEvidence(
  record: AxPreferenceEvidenceRecord,
  event: Readonly<{
    recordedAt: string;
    sourceRef: string;
    authorityRef: string;
  }>
): AxPreferenceEvidenceRecord {
  if (
    !validRecord(record) ||
    !validInstant(event.recordedAt) ||
    !nonEmpty(event.sourceRef) ||
    !nonEmpty(event.authorityRef) ||
    Date.parse(event.recordedAt) <
      Date.parse(
        (record.revisions.at(-1) as AxPreferenceEvidenceRevision).recordedAt
      )
  ) {
    throw new Error('Cannot retract malformed preference evidence.');
  }
  return {
    ...record,
    revisions: [
      ...record.revisions,
      {
        operation: 'retract',
        revision: record.revisions.length + 1,
        ...event,
      },
    ],
  };
}

/**
 * Produce an erasure tombstone and intentionally destroy prior content,
 * provenance, and consent references. Hosts may delete the tombstone too.
 */
export function axErasePreferenceEvidence(
  record: AxPreferenceEvidenceRecord,
  event: Readonly<{ recordedAt: string; authorityRef: string }>
): AxPreferenceEvidenceRecord {
  if (
    !validRecord(record) ||
    !validInstant(event.recordedAt) ||
    !nonEmpty(event.authorityRef) ||
    Date.parse(event.recordedAt) <
      Date.parse(
        (record.revisions.at(-1) as AxPreferenceEvidenceRevision).recordedAt
      )
  ) {
    throw new Error('Cannot erase malformed preference evidence.');
  }
  return {
    id: record.id,
    principalId: record.principalId,
    revisions: [
      {
        operation: 'erase',
        revision: 1,
        ...event,
      },
    ],
  };
}
