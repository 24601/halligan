import type { AxAuthorizationDeniedError } from './authority.js';
import type {
  AxCapabilityGrant,
  AxEvidenceObservation,
  AxEvidenceRequirement,
  AxGuardEvaluation,
  AxGuardEvaluationContext,
  AxGuardFailure,
  AxGuardFailureCode,
  AxGuardOp,
} from './types.js';

/** Bounds `canonicalValue` against a cyclic or pathological host datum. */
const MAX_VALUE_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural check for the closed `AxAuthorityValue` JSON union. Deliberately
 * duplicated rather than imported from `src/ax/event/util.ts`: reusing
 * `axEventCanonicalJson` would create an `authority -> event` runtime edge for
 * fifteen lines of code.
 */
function isAuthorityValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_VALUE_DEPTH) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isAuthorityValue(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((entry) =>
    isAuthorityValue(entry, depth + 1)
  );
}

/**
 * Canonical JSON of an `AxAuthorityValue`: object keys sorted, `undefined`
 * dropped. Equality of two canonical strings is the only value comparison the
 * guard algebra performs.
 */
function canonicalValue(value: unknown, depth = 0): string {
  if (depth > MAX_VALUE_DEPTH) return '"[ax:depth]"';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValue(entry, depth + 1)).join(',')}]`;
  }
  if (!isRecord(value)) return '"[ax:non-value]"';
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalValue(entry, depth + 1)}`
    );
  return `{${entries.join(',')}}`;
}

/**
 * Structural validator, exported because hosts build requirements by hand.
 * Rejects an unknown operator (F4) and `fresh` without `maxAgeMs` (F5), which
 * is why `captureGrant` can enforce both at capture rather than at every
 * `axAuthorize` call.
 */
export function axIsEvidenceRequirement(
  value: unknown
): value is AxEvidenceRequirement {
  if (!isRecord(value)) return false;
  const { kind, trustedSources, maxAgeMs, match } = value;
  if (typeof kind !== 'string' || !kind.trim()) return false;
  if (!Array.isArray(trustedSources) || trustedSources.length === 0) {
    return false;
  }
  if (
    !trustedSources.every(
      (source) => typeof source === 'string' && source.trim().length > 0
    )
  ) {
    return false;
  }
  if (
    maxAgeMs !== undefined &&
    (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
  ) {
    return false;
  }
  if (!isRecord(match)) return false;
  switch (match.op) {
    case 'eq':
    case 'ne':
      return isAuthorityValue(match.value);
    case 'in':
    case 'notIn':
      return (
        Array.isArray(match.values) &&
        match.values.every((entry) => isAuthorityValue(entry))
      );
    case 'contains':
      return typeof match.value === 'string';
    case 'fresh':
      return typeof maxAgeMs === 'number';
    default:
      return false;
  }
}

/** An observation Ax will consider. Malformed entries are never candidates. */
function isEvidenceObservation(
  value: unknown
): value is Readonly<AxEvidenceObservation> {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.kind === 'string' &&
    Boolean(value.kind.trim()) &&
    typeof value.sourceId === 'string' &&
    Boolean(value.sourceId.trim()) &&
    typeof value.observedAt === 'number' &&
    Number.isFinite(value.observedAt) &&
    typeof value.leaseEpoch === 'number' &&
    Number.isInteger(value.leaseEpoch) &&
    value.leaseEpoch >= 0 &&
    isAuthorityValue(value.value)
  );
}

/**
 * Canonical identity of a requirement, used for dedupe in
 * `axCollectGrantRequirements` and for the attenuation superset rule.
 * `trustedSources` is compared as a set; everything else positionally.
 */
export function evidenceRequirementKey(
  requirement: Readonly<AxEvidenceRequirement>
): string {
  const sources = [...(requirement?.trustedSources ?? [])].sort();
  return canonicalValue([
    requirement?.kind ?? null,
    sources,
    requirement?.maxAgeMs ?? null,
    requirement?.match ?? null,
  ]);
}

function failure(
  kind: unknown,
  op: unknown,
  code: AxGuardFailureCode
): Readonly<AxGuardFailure> {
  return Object.freeze({
    kind: typeof kind === 'string' ? kind : '',
    // A malformed requirement echoes its declared operator string, or
    // `'unknown'` when none was declared. This is host-authored text; it is
    // never an observation value, source ID, or resource ID.
    op: (typeof op === 'string' ? op : 'unknown') as AxGuardOp,
    code,
  });
}

function evaluateRequirement(
  requirement: Readonly<AxEvidenceRequirement>,
  evidence: readonly Readonly<AxEvidenceObservation>[],
  leaseEpoch: number,
  now: number
): Readonly<AxGuardFailure> | undefined {
  const declaredKind = (requirement as { kind?: unknown } | undefined)?.kind;
  const declaredOp = (requirement as { match?: { op?: unknown } } | undefined)
    ?.match?.op;
  if (!axIsEvidenceRequirement(requirement)) {
    return failure(declaredKind, declaredOp, 'malformed_requirement');
  }
  const { kind, match } = requirement;
  const op = match.op;

  // Step 1, candidate selection. The first narrowing that empties the candidate
  // set names the failure, so a deny says which stage it failed at without
  // saying what any observation held.
  const sameKind = evidence.filter(
    (entry) => isEvidenceObservation(entry) && entry.kind === kind
  );
  if (!sameKind.length) return failure(kind, op, 'missing_observation');
  const trusted = sameKind.filter((entry) =>
    requirement.trustedSources.includes(entry.sourceId)
  );
  if (!trusted.length) return failure(kind, op, 'untrusted_source');
  // Lease binding is unconditional and is not an operator (F2).
  const bound = trusted.filter((entry) => entry.leaseEpoch === leaseEpoch);
  if (!bound.length) return failure(kind, op, 'lease_epoch_mismatch');
  // Ax never picks the freshest, the first, or the "best" (F3).
  if (bound.length > 1) return failure(kind, op, 'ambiguous_observation');
  const observation = bound[0] as Readonly<AxEvidenceObservation>;
  // Stated as the passing condition rather than its negation on purpose: a
  // non-finite `now` makes the comparison false and denies, where the negated
  // form (`now - observedAt > maxAgeMs`) is false for NaN and would silently
  // disable the only time-bounded operator. `axEvaluateGuards` already maps
  // every non-finite clock to NaN so `-Infinity` cannot pass either.
  if (
    requirement.maxAgeMs !== undefined &&
    !(now - observation.observedAt <= requirement.maxAgeMs)
  ) {
    return failure(kind, op, 'stale');
  }

  // Step 2, operator predicate.
  const observed = canonicalValue(observation.value);
  switch (match.op) {
    case 'eq':
      return observed === canonicalValue(match.value)
        ? undefined
        : failure(kind, op, 'predicate_failed');
    case 'ne':
      return observed !== canonicalValue(match.value)
        ? undefined
        : failure(kind, op, 'predicate_failed');
    case 'in':
      return match.values.some((entry) => canonicalValue(entry) === observed)
        ? undefined
        : failure(kind, op, 'predicate_failed');
    case 'notIn':
      return match.values.some((entry) => canonicalValue(entry) === observed)
        ? failure(kind, op, 'predicate_failed')
        : undefined;
    case 'contains': {
      const value = observation.value;
      if (typeof value === 'string') {
        return value.includes(match.value)
          ? undefined
          : failure(kind, op, 'predicate_failed');
      }
      if (Array.isArray(value)) {
        const needle = canonicalValue(match.value);
        return value.some((entry) => canonicalValue(entry) === needle)
          ? undefined
          : failure(kind, op, 'predicate_failed');
      }
      // No coercion: a non-string, non-array observation cannot contain.
      return failure(kind, op, 'predicate_failed');
    }
    case 'fresh':
      // Step 1's freshness check is the whole predicate; `maxAgeMs` is
      // structurally required for this operator.
      return undefined;
    default:
      return failure(kind, op, 'malformed_requirement');
  }
}

/**
 * Evaluate every requirement against the supplied observations. Pure,
 * synchronous, allocation-bounded, and deterministic for identical inputs.
 * Ax decides mechanism only; the host still holds final authority through
 * `AxAuthorityContext.authorize`. A failure carries an operator, a fact kind,
 * and a code — never an observation value or a source ID.
 */
export function axEvaluateGuards(
  context: Readonly<AxGuardEvaluationContext>
): Readonly<AxGuardEvaluation> {
  const requirements = context?.requirements ?? [];
  const evidence = context?.evidence ?? [];
  const leaseEpoch = context?.leaseEpoch as number;
  // The one host-supplied number this evaluator reads without a capture step.
  // A missing, NaN, or infinite clock cannot be used to decide freshness, so it
  // collapses to NaN and every `maxAgeMs` requirement fails closed with
  // `stale`. Requirements that do not read the clock are unaffected.
  const now = Number.isFinite(context?.now)
    ? (context.now as number)
    : Number.NaN;
  const failures: Readonly<AxGuardFailure>[] = [];
  for (const requirement of requirements) {
    const result = evaluateRequirement(requirement, evidence, leaseEpoch, now);
    if (result) failures.push(result);
  }
  return Object.freeze({
    allow: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

/**
 * Deduped union of requirements across grants, preserving first-seen order.
 *
 * NOTE, and it is a real semantic: this is the union over *all* matching
 * grants, so a requirement added to grant A also constrains grant B that
 * matched the same operation and resource and declared nothing. This is
 * coherent with `receiptMatches`, which already demands the receipt echo every
 * eligible grant ID, and it is the fail-closed direction.
 */
export function axCollectGrantRequirements(
  grants: readonly Readonly<AxCapabilityGrant>[]
): readonly Readonly<AxEvidenceRequirement>[] {
  const seen = new Set<string>();
  const collected: Readonly<AxEvidenceRequirement>[] = [];
  for (const grant of grants ?? []) {
    for (const requirement of grant?.requirements ?? []) {
      const key = evidenceRequirementKey(requirement);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(requirement);
    }
  }
  return Object.freeze(collected);
}

/** Cross-realm structural guard for the audit and deny paths. */
export function axIsGuardPredicateFailure(
  error: unknown
): error is AxAuthorizationDeniedError & { code: 'guard_predicate_failed' } {
  return (
    isRecord(error) &&
    error.name === 'AxAuthorizationDeniedError' &&
    error.code === 'guard_predicate_failed'
  );
}
