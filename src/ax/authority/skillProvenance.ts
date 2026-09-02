// Type-only imports. `authority` must not gain a runtime edge onto `event`.
import type { AxEventEffect, AxEventEffectStatus } from '../event/types.js';
import type { AxAuthorizationReceipt } from './types.js';

/** One effect the source trajectory declared, reduced to non-secret identity. */
export type AxSkillProvenanceEffectRef = Readonly<{
  effectId: string;
  operation: string;
  /** `AxEventEffect.requestDigest` — SHA-256 of the canonical request bytes. */
  requestDigest: string;
  status: AxEventEffectStatus;
  replaySafety: 'idempotent' | 'unknown';
}>;

/** One authorization the source trajectory obtained. Refs are lookup keys. */
export type AxSkillProvenanceAuthorization = Readonly<{
  receiptId: string;
  operation: string;
  /** Resource *type* only. Resource IDs are never carried. */
  resourceType: string;
  grantIds: readonly string[];
  leaseEpoch: number;
}>;

export type AxSkillVerifierVerdict = 'allowed' | 'parked' | 'waived';

export type AxSkillVerifierDecision = Readonly<{
  verifier: string;
  verdict: AxSkillVerifierVerdict;
  scope?: string;
}>;

/**
 * The authorization facts a learned artifact's source trajectory depended on.
 * Derived deterministically from the effect ledger and authorization receipts.
 * There is no model in the extraction loop and never will be.
 *
 * This is an authority boundary, not a cryptographic attestation: `digest` is
 * a non-cryptographic identity checksum, exactly as the retention digests in
 * `playbookEvolve` are documented to be.
 */
export type AxSkillProvenance = Readonly<{
  version: 1;
  effects: readonly AxSkillProvenanceEffectRef[];
  authorizations: readonly AxSkillProvenanceAuthorization[];
  /** Sorted unique union of every retained authorization's grant IDs. */
  hostGrants: readonly string[];
  /**
   * Caller-supplied, NOT derived. `AxAuthorizationReceipt` carries no guard
   * result, so Ax cannot derive which evidence requirements a trajectory
   * satisfied — only which grants paid for it.
   */
  verifierDecisions: readonly AxSkillVerifierDecision[];
  /** Host-declared environment facts. Ax never probes the environment. */
  environment: Readonly<Record<string, string>>;
  leaseEpoch: number;
  /** Canonical ISO timestamp supplied by the caller's clock. */
  capturedAt: string;
  /** True when the accumulator hit its cap and older entries were dropped. */
  truncated?: true;
  /** `fnv1a64:` identity over the canonical facts. Not authenticity. */
  digest: string;
}>;

/** Caller-owned join input. Ax does not infer which receipt paid for which effect. */
export type AxSkillProvenanceSource = Readonly<{
  effects?: readonly Readonly<AxEventEffect>[];
  receipts?: readonly Readonly<AxAuthorizationReceipt>[];
  verifierDecisions?: readonly Readonly<AxSkillVerifierDecision>[];
  environment?: Readonly<Record<string, string>>;
  leaseEpoch: number;
  capturedAt: string;
  truncated?: boolean;
}>;

/** Bounds, mirroring the catalog bounds in `executableSkills.ts`. */
export const AX_SKILL_PROVENANCE_MAX_EFFECTS = 256;
export const AX_SKILL_PROVENANCE_MAX_AUTHORIZATIONS = 256;

const EFFECT_STATUSES: readonly AxEventEffectStatus[] = [
  'intent',
  'dispatched',
  'succeeded',
  'failed',
  'parked',
];

/** Statuses that mean the recorded effect never reached a terminal outcome. */
const UNSETTLED_STATUSES: readonly AxEventEffectStatus[] = [
  'intent',
  'dispatched',
  'parked',
];

const VERIFIER_VERDICTS: readonly AxSkillVerifierVerdict[] = [
  'allowed',
  'parked',
  'waived',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped. Behaviourally
 * identical to `axEventCanonicalJson`, and deliberately duplicated rather than
 * imported — importing it would create an `authority -> event` runtime edge for
 * fifteen lines. A shared-vector test pins the two against each other.
 */
function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .filter(
            (key) => (current as Record<string, unknown>)[key] !== undefined
          )
          .map((key) => [
            key,
            normalize((current as Record<string, unknown>)[key]),
          ])
      );
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

/** Sync, browser-safe, and honest about what it proves: identity, not authenticity. */
function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

function normalizeEnvironment(
  environment: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (!environment) return Object.freeze({});
  const entries = Object.keys(environment)
    .filter((key) => typeof environment[key] === 'string')
    .sort(compareStrings)
    .map((key) => [key, environment[key] as string] as const);
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeVerifierDecisions(
  decisions: readonly Readonly<AxSkillVerifierDecision>[] | undefined
): readonly AxSkillVerifierDecision[] {
  if (!decisions?.length) return Object.freeze([]);
  const byKey = new Map<string, AxSkillVerifierDecision>();
  for (const decision of decisions) {
    if (!decision || typeof decision.verifier !== 'string') continue;
    if (!VERIFIER_VERDICTS.includes(decision.verdict)) continue;
    const scope =
      typeof decision.scope === 'string' ? decision.scope : undefined;
    const normalized: AxSkillVerifierDecision = Object.freeze({
      verifier: decision.verifier,
      verdict: decision.verdict,
      ...(scope !== undefined ? { scope } : {}),
    });
    byKey.set(canonicalJson(normalized), normalized);
  }
  return Object.freeze(
    [...byKey.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, decision]) => decision)
  );
}

/**
 * Deterministic, synchronous, model-free. Input order does not affect output.
 * Over-cap input is deduped first, then the OLDEST remaining entries are dropped
 * and `truncated: true` is stamped, so a weakened record is visible rather than
 * silently smaller.
 */
export function axExtractSkillProvenance(
  source: Readonly<AxSkillProvenanceSource>
): AxSkillProvenance {
  // Fail at the layer that MINTS the record, not three layers later as an
  // opaque `malformed_provenance`. Without this a caller could build a
  // digest-consistent provenance that `axIsSkillProvenance` rejects, and the
  // only symptom would be a park at retrieval time with no way back to the
  // bad input.
  if (
    typeof source.leaseEpoch !== 'number' ||
    !Number.isFinite(source.leaseEpoch)
  ) {
    throw new TypeError(
      'AxSkillProvenance: leaseEpoch must be a finite number'
    );
  }
  if (!isCanonicalIsoTimestamp(source.capturedAt)) {
    throw new TypeError(
      'AxSkillProvenance: capturedAt must be a canonical ISO timestamp'
    );
  }
  let truncated = source.truncated === true;

  const effectsById = new Map<
    string,
    Readonly<{ ref: AxSkillProvenanceEffectRef; createdAt: number }>
  >();
  for (const effect of source.effects ?? []) {
    if (!effect || typeof effect.id !== 'string') continue;
    effectsById.set(effect.id, {
      ref: Object.freeze({
        effectId: effect.id,
        operation: effect.operation,
        requestDigest: effect.requestDigest,
        status: effect.status,
        replaySafety: effect.replaySafety,
      }),
      createdAt:
        typeof effect.createdAt === 'number' &&
        Number.isFinite(effect.createdAt)
          ? effect.createdAt
          : 0,
    });
  }
  const orderedEffects = [...effectsById.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      compareStrings(left.ref.effectId, right.ref.effectId)
  );
  if (orderedEffects.length > AX_SKILL_PROVENANCE_MAX_EFFECTS) {
    orderedEffects.splice(
      0,
      orderedEffects.length - AX_SKILL_PROVENANCE_MAX_EFFECTS
    );
    truncated = true;
  }

  // Dedupe by operation + sorted grant IDs: two receipts that bought the same
  // authority over the same operation are one authority fact, not two.
  const authorizationsByKey = new Map<
    string,
    Readonly<{ ref: AxSkillProvenanceAuthorization; authorizedAt: number }>
  >();
  for (const receipt of source.receipts ?? []) {
    if (!receipt || typeof receipt.receiptId !== 'string') continue;
    const grantIds = sortedUnique(
      (receipt.grantIds ?? []).filter(
        (id): id is string => typeof id === 'string'
      )
    );
    const key = `${receipt.operation} ${grantIds.join(',')}`;
    const authorizedAt =
      typeof receipt.authorizedAt === 'number' &&
      Number.isFinite(receipt.authorizedAt)
        ? receipt.authorizedAt
        : 0;
    const existing = authorizationsByKey.get(key);
    // Keep the earliest receipt for a key so the retained record is stable
    // under input permutation.
    if (
      existing &&
      (existing.authorizedAt < authorizedAt ||
        (existing.authorizedAt === authorizedAt &&
          compareStrings(existing.ref.receiptId, receipt.receiptId) <= 0))
    ) {
      continue;
    }
    authorizationsByKey.set(key, {
      ref: Object.freeze({
        receiptId: receipt.receiptId,
        operation: receipt.operation,
        resourceType: receipt.resource?.type ?? '',
        grantIds: Object.freeze(grantIds),
        leaseEpoch: receipt.leaseEpoch,
      }),
      authorizedAt,
    });
  }
  const orderedAuthorizations = [...authorizationsByKey.values()].sort(
    (left, right) =>
      left.authorizedAt - right.authorizedAt ||
      compareStrings(left.ref.receiptId, right.ref.receiptId)
  );
  if (orderedAuthorizations.length > AX_SKILL_PROVENANCE_MAX_AUTHORIZATIONS) {
    orderedAuthorizations.splice(
      0,
      orderedAuthorizations.length - AX_SKILL_PROVENANCE_MAX_AUTHORIZATIONS
    );
    truncated = true;
  }

  const authorizations = orderedAuthorizations.map((entry) => entry.ref);
  const facts = {
    version: 1 as const,
    effects: Object.freeze(orderedEffects.map((entry) => entry.ref)),
    authorizations: Object.freeze(authorizations),
    hostGrants: Object.freeze(
      sortedUnique(authorizations.flatMap((entry) => [...entry.grantIds]))
    ),
    verifierDecisions: normalizeVerifierDecisions(source.verifierDecisions),
    environment: normalizeEnvironment(source.environment),
    leaseEpoch: source.leaseEpoch,
    capturedAt: source.capturedAt,
    ...(truncated ? { truncated: true as const } : {}),
  };
  return Object.freeze({ ...facts, digest: fnv1a64(canonicalJson(facts)) });
}

/** Recompute the identity digest. Used to detect tampering-by-editing. */
export function axSkillProvenanceDigest(
  provenance: Readonly<Omit<AxSkillProvenance, 'digest'>>
): string {
  const { digest: _ignored, ...facts } = provenance as Record<string, unknown>;
  return fnv1a64(canonicalJson(facts));
}

function isEffectRef(value: unknown): value is AxSkillProvenanceEffectRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.effectId === 'string' &&
    typeof value.operation === 'string' &&
    typeof value.requestDigest === 'string' &&
    EFFECT_STATUSES.includes(value.status as AxEventEffectStatus) &&
    (value.replaySafety === 'idempotent' || value.replaySafety === 'unknown')
  );
}

function isAuthorizationRef(
  value: unknown
): value is AxSkillProvenanceAuthorization {
  if (!isRecord(value)) return false;
  return (
    typeof value.receiptId === 'string' &&
    typeof value.operation === 'string' &&
    typeof value.resourceType === 'string' &&
    Array.isArray(value.grantIds) &&
    value.grantIds.every((id) => typeof id === 'string') &&
    typeof value.leaseEpoch === 'number' &&
    Number.isFinite(value.leaseEpoch)
  );
}

function isVerifierDecision(value: unknown): value is AxSkillVerifierDecision {
  if (!isRecord(value)) return false;
  if (typeof value.verifier !== 'string') return false;
  if (!VERIFIER_VERDICTS.includes(value.verdict as AxSkillVerifierVerdict)) {
    return false;
  }
  return value.scope === undefined || typeof value.scope === 'string';
}

export function axIsSkillProvenance(
  value: unknown
): value is AxSkillProvenance {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.effects) || !value.effects.every(isEffectRef)) {
    return false;
  }
  if (
    !Array.isArray(value.authorizations) ||
    !value.authorizations.every(isAuthorizationRef)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.hostGrants) ||
    !value.hostGrants.every((id) => typeof id === 'string')
  ) {
    return false;
  }
  if (
    !Array.isArray(value.verifierDecisions) ||
    !value.verifierDecisions.every(isVerifierDecision)
  ) {
    return false;
  }
  if (!isRecord(value.environment)) return false;
  if (
    !Object.values(value.environment).every(
      (entry) => typeof entry === 'string'
    )
  ) {
    return false;
  }
  if (
    typeof value.leaseEpoch !== 'number' ||
    !Number.isFinite(value.leaseEpoch)
  )
    return false;
  if (!isCanonicalIsoTimestamp(value.capturedAt)) return false;
  if (value.truncated !== undefined && value.truncated !== true) return false;
  return typeof value.digest === 'string' && value.digest.length > 0;
}

// ---- retrieval-time re-check ----

/** Current host authority, supplied at retrieval. Never derived from the artifact. */
export type AxSkillAuthoritySnapshot = Readonly<{
  grantIds: readonly string[];
  leaseEpoch: number;
  verifierDecisions?: readonly Readonly<AxSkillVerifierDecision>[];
  environment?: Readonly<Record<string, string>>;
  /**
   * Canonical ISO timestamp. OPTIONAL, and ignored on any path that already has
   * an authoritative clock of its own. One clock is authoritative per path, and
   * it is the path's.
   */
  now?: string;
}>;

const AUTHORITY_SNAPSHOT_KEYS: readonly string[] = [
  'grantIds',
  'leaseEpoch',
  'verifierDecisions',
  'environment',
  'now',
];

/** Structural validator. Required because shallow key allowlists do not nest. */
export function axIsSkillAuthoritySnapshot(
  value: unknown
): value is AxSkillAuthoritySnapshot {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!AUTHORITY_SNAPSHOT_KEYS.includes(key)) return false;
  }
  if (
    !Array.isArray(value.grantIds) ||
    !value.grantIds.every((id) => typeof id === 'string')
  ) {
    return false;
  }
  if (
    typeof value.leaseEpoch !== 'number' ||
    !Number.isFinite(value.leaseEpoch)
  )
    return false;
  if (value.verifierDecisions !== undefined) {
    if (
      !Array.isArray(value.verifierDecisions) ||
      !value.verifierDecisions.every(isVerifierDecision)
    ) {
      return false;
    }
  }
  if (value.environment !== undefined) {
    if (!isRecord(value.environment)) return false;
    if (
      !Object.values(value.environment).every(
        (entry) => typeof entry === 'string'
      )
    ) {
      return false;
    }
  }
  if (value.now !== undefined && !isCanonicalIsoTimestamp(value.now)) {
    return false;
  }
  return true;
}

export type AxSkillPreconditionFailureKind =
  | 'grant_revoked'
  | 'lease_epoch_changed'
  | 'verifier_decision_missing'
  | 'verifier_decision_changed'
  | 'environment_drift'
  | 'effect_unsettled'
  | 'provenance_truncated'
  | 'malformed_provenance';

const FAILURE_KINDS: readonly AxSkillPreconditionFailureKind[] = [
  'effect_unsettled',
  'environment_drift',
  'grant_revoked',
  'lease_epoch_changed',
  'malformed_provenance',
  'provenance_truncated',
  'verifier_decision_changed',
  'verifier_decision_missing',
];

/** Counts only. The failing IDs and values never leave the check. */
export type AxSkillPreconditionFailure = Readonly<{
  kind: AxSkillPreconditionFailureKind;
  count: number;
}>;

export type AxSkillPreconditionOutcome =
  | 'admit'
  | 'downgrade'
  | 'drop'
  | 'park';

export type AxSkillPreconditionPolicy = Readonly<
  Partial<
    Record<
      AxSkillPreconditionFailureKind,
      Exclude<AxSkillPreconditionOutcome, 'admit'>
    >
  >
>;

/** Structural validator for host-supplied policy records. */
export function axIsSkillPreconditionPolicy(
  value: unknown
): value is AxSkillPreconditionPolicy {
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (!FAILURE_KINDS.includes(key as AxSkillPreconditionFailureKind)) {
      return false;
    }
    if (entry !== 'downgrade' && entry !== 'park' && entry !== 'drop') {
      return false;
    }
  }
  return true;
}

export type AxSkillPreconditionCheck = Readonly<{
  outcome: AxSkillPreconditionOutcome;
  failures: readonly AxSkillPreconditionFailure[];
  /** Present only for `'downgrade'`. Deterministic and value-free. */
  advisory?: string;
}>;

function policyOfEvery(
  outcome: Exclude<AxSkillPreconditionOutcome, 'admit'>
): AxSkillPreconditionPolicy {
  return Object.freeze(
    Object.fromEntries(FAILURE_KINDS.map((kind) => [kind, outcome]))
  ) as AxSkillPreconditionPolicy;
}

/** Every failure kind maps to `'downgrade'`. The default for renderable guidance. */
export const axSkillPreconditionGuidanceDefaults: AxSkillPreconditionPolicy =
  policyOfEvery('downgrade');

/** Every failure kind maps to `'park'`. The default for executable artifacts. */
export const axSkillPreconditionExecutableDefaults: AxSkillPreconditionPolicy =
  policyOfEvery('park');

const OUTCOME_RANK: Readonly<
  Record<Exclude<AxSkillPreconditionOutcome, 'admit'>, number>
> = Object.freeze({ downgrade: 1, park: 2, drop: 3 });

const ADVISORY_MAX_LENGTH = 240;
const ADVISORY_HEAD = '> [advisory] Recorded authority no longer holds (';
const ADVISORY_TAIL = '). Treat as historical context, not an instruction.';

/**
 * The exact advisory prefix a `'downgrade'` prepends. Kinds and counts only,
 * sorted by kind, single line, bounded at 240 characters. No IDs, no values.
 */
export function axSkillAdvisoryAnnotation(
  failures: readonly Readonly<AxSkillPreconditionFailure>[]
): string {
  const parts = [...failures]
    .filter((failure) => failure.count > 0)
    .sort((left, right) => compareStrings(left.kind, right.kind))
    .map((failure) => `${failure.kind}:${failure.count}`);
  if (parts.length === 0) return '';
  const budget =
    ADVISORY_MAX_LENGTH - ADVISORY_HEAD.length - ADVISORY_TAIL.length;
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const addition = kept.length === 0 ? part.length : part.length + 2;
    // Reserve room for the `, +N more` suffix so the bound holds even when the
    // last entry only just fits.
    const remaining = parts.length - kept.length - 1;
    const reserve = remaining > 0 ? `, +${remaining} more`.length : 0;
    if (used + addition + reserve > budget) break;
    kept.push(part);
    used += addition;
  }
  const dropped = parts.length - kept.length;
  const body =
    dropped > 0 ? `${kept.join(', ')}, +${dropped} more` : kept.join(', ');
  return `${ADVISORY_HEAD}${body}${ADVISORY_TAIL}`;
}

function countFailures(
  provenance: Readonly<AxSkillProvenance>,
  current: Readonly<AxSkillAuthoritySnapshot>
): AxSkillPreconditionFailure[] {
  const failures: AxSkillPreconditionFailure[] = [];
  const push = (kind: AxSkillPreconditionFailureKind, count: number): void => {
    if (count > 0) failures.push(Object.freeze({ kind, count }));
  };

  const heldGrants = new Set(current.grantIds);
  push(
    'grant_revoked',
    provenance.hostGrants.filter((id) => !heldGrants.has(id)).length
  );
  push(
    'lease_epoch_changed',
    provenance.leaseEpoch === current.leaseEpoch ? 0 : 1
  );

  // Deliberate asymmetry: an absent host axis means "not supplied", which is
  // skipped rather than failed. Absence must not become an accidental deny.
  if (current.verifierDecisions) {
    const byVerifier = new Map(
      current.verifierDecisions.map((decision) => [decision.verifier, decision])
    );
    let missing = 0;
    let changed = 0;
    for (const recorded of provenance.verifierDecisions) {
      const held = byVerifier.get(recorded.verifier);
      if (!held) {
        missing += 1;
        continue;
      }
      if (held.verdict !== recorded.verdict || held.scope !== recorded.scope) {
        changed += 1;
      }
    }
    push('verifier_decision_missing', missing);
    push('verifier_decision_changed', changed);
  }

  if (current.environment) {
    const held = current.environment;
    push(
      'environment_drift',
      Object.keys(provenance.environment).filter(
        (key) => held[key] !== provenance.environment[key]
      ).length
    );
  }

  push(
    'effect_unsettled',
    provenance.effects.filter((effect) =>
      UNSETTLED_STATUSES.includes(effect.status)
    ).length
  );
  push('provenance_truncated', provenance.truncated === true ? 1 : 0);

  return failures.sort((left, right) => compareStrings(left.kind, right.kind));
}

/**
 * Re-evaluate recorded authority against current host authority.
 * `provenance === undefined` admits unconditionally: legacy artifacts are never
 * penalized for predating this field.
 *
 * The fourth argument is the calling path's authoritative clock. Every failure
 * axis in this release is a set comparison, so no outcome depends on it today;
 * it is accepted so callers thread one clock per path rather than reaching for
 * `AxSkillAuthoritySnapshot.now`, and so a future time-dependent axis does not
 * change this signature.
 */
/**
 * `_now` is the calling path's authoritative clock, accepted for signature
 * symmetry with the rest of the re-check surface and deliberately unused: every
 * failure axis here is a SET comparison (grants held, lease epoch, verifier
 * verdicts, environment keys, effect status, truncation), so no outcome depends
 * on the time. It is a parameter, not a behaviour — the clock is load-bearing
 * on the paths that own expiry (`AxExecutableSkillArtifact.expiresAt` via
 * `AxExecutableSkillContext.now`), not inside this function. If a
 * time-dependent axis is ever added it resolves `now ?? current.now`.
 */
export function axRecheckSkillProvenance(
  provenance: Readonly<AxSkillProvenance> | undefined,
  current: Readonly<AxSkillAuthoritySnapshot>,
  policy?: Readonly<AxSkillPreconditionPolicy>,
  _now?: string
): AxSkillPreconditionCheck {
  if (provenance === undefined) {
    return Object.freeze({ outcome: 'admit', failures: Object.freeze([]) });
  }

  const effective: AxSkillPreconditionPolicy = {
    ...axSkillPreconditionGuidanceDefaults,
    ...(policy ?? {}),
  };

  const malformed =
    !axIsSkillProvenance(provenance) ||
    axSkillProvenanceDigest(provenance) !== provenance.digest;
  const failures = malformed
    ? [Object.freeze({ kind: 'malformed_provenance' as const, count: 1 })]
    : countFailures(provenance, current);

  if (failures.length === 0) {
    return Object.freeze({ outcome: 'admit', failures: Object.freeze([]) });
  }

  let rank = 0;
  for (const failure of failures) {
    const outcome = effective[failure.kind] ?? 'downgrade';
    rank = Math.max(rank, OUTCOME_RANK[outcome]);
  }
  const outcome: AxSkillPreconditionOutcome =
    rank === 3 ? 'drop' : rank === 2 ? 'park' : 'downgrade';

  return Object.freeze({
    outcome,
    failures: Object.freeze(failures),
    ...(outcome === 'downgrade'
      ? { advisory: axSkillAdvisoryAnnotation(failures) }
      : {}),
  });
}
