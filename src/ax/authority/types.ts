export type AxAuthorityValue =
  | string
  | number
  | boolean
  | null
  | readonly AxAuthorityValue[]
  | { readonly [key: string]: AxAuthorityValue };

/** Opaque host-issued claim. Ax preserves claims but does not interpret them. */
export interface AxAuthorityClaim {
  type: string;
  value: AxAuthorityValue;
}

/** Host-owned subject identity. This is not an authentication credential. */
export interface AxPrincipal {
  id: string;
  tenantId?: string;
  claims?: readonly Readonly<AxAuthorityClaim>[];
}

/** The process or person currently exercising a principal's authority. */
export interface AxActor {
  id: string;
  kind: 'human' | 'agent' | 'service' | 'unknown';
  claims?: readonly Readonly<AxAuthorityClaim>[];
}

/** Host-asserted delegation provenance. Ax only validates depth and parent. */
export interface AxDelegationClaims {
  parentPrincipalId: string;
  depth: number;
  claims?: readonly Readonly<AxAuthorityClaim>[];
}

/** Exact resource identity. Ax does not implement wildcard policy matching. */
export interface AxResourceScope {
  type: string;
  id: string;
  tenantId?: string;
}

/**
 * One host-observed fact, bound to the lease epoch it was observed under.
 * Host-owned in every field. Ax never derives an observation from model
 * output, prompt text, tool arguments, or an event payload.
 */
export interface AxEvidenceObservation {
  readonly version: 1;
  /** Fact class, e.g. `'session.mfa'`, `'device.posture'`, `'tenant.id'`. */
  readonly kind: string;
  /** Host-owned producer identity. Never derived from model or payload text. */
  readonly sourceId: string;
  /** Epoch milliseconds on the host clock. */
  readonly observedAt: number;
  readonly value: AxAuthorityValue;
  /** The lease epoch this observation was taken under. */
  readonly leaseEpoch: number;
}

/**
 * Six operators. Closed union, no composition, no nesting, no cross-requirement
 * references. A seventh must be justified in `docs/HOST_AUTHORITY.md` against a
 * real host requirement.
 */
export type AxGuardOp = 'eq' | 'ne' | 'in' | 'notIn' | 'contains' | 'fresh';

/** Closed predicate algebra. Ax evaluates these; Ax never authors them. */
export type AxEvidenceMatch =
  | Readonly<{ op: 'eq' | 'ne'; value: AxAuthorityValue }>
  | Readonly<{ op: 'in' | 'notIn'; values: readonly AxAuthorityValue[] }>
  | Readonly<{ op: 'contains'; value: string }>
  | Readonly<{ op: 'fresh' }>;

/** A contingency a grant carries. Attenuation may add these, never remove them. */
export interface AxEvidenceRequirement {
  readonly kind: string;
  /** Exact source IDs whose observations may satisfy this. No wildcards. */
  readonly trustedSources: readonly string[];
  /** Maximum observation age in ms. Required when `match.op === 'fresh'`. */
  readonly maxAgeMs?: number;
  readonly match: Readonly<AxEvidenceMatch>;
}

export type AxGuardFailureCode =
  | 'missing_observation'
  | 'untrusted_source'
  | 'ambiguous_observation'
  | 'lease_epoch_mismatch'
  | 'stale'
  | 'predicate_failed'
  | 'malformed_requirement';

/** Diagnosable without disclosing: op + kind + code, never a value. */
export interface AxGuardFailure {
  readonly kind: string;
  /**
   * The declared operator, or the literal `'unknown'` when a requirement named
   * an operator outside the closed six. A host string is never echoed here, so
   * an exhaustive `switch` over this field — and the `failedPredicateKind`
   * audit label derived from it — stays inside a known vocabulary.
   */
  readonly op: AxGuardOp | 'unknown';
  readonly code: AxGuardFailureCode;
}

export interface AxGuardEvaluation {
  readonly allow: boolean;
  readonly failures: readonly Readonly<AxGuardFailure>[];
}

export interface AxGuardEvaluationContext {
  /**
   * Carried for caller diagnostics only. Guard resolution is by fact `kind`,
   * trusted source, lease epoch, and freshness; neither the operation nor the
   * resource participates in it. Resource scoping happens earlier, in grant
   * matching, and `axCollectGrantRequirements` is what makes the requirement
   * set resource-specific.
   */
  readonly operation: string;
  /** Carried for caller diagnostics only. See `operation`. */
  readonly resource: Readonly<AxResourceScope>;
  readonly requirements: readonly Readonly<AxEvidenceRequirement>[];
  readonly evidence: readonly Readonly<AxEvidenceObservation>[];
  readonly leaseEpoch: number;
  readonly now: number;
}

/**
 * Versioned, host-issued capability data consumed by Ax's mechanism checks.
 * This is not a token, credential, signature, or proof of authenticity.
 */
export interface AxCapabilityGrant {
  version: 1;
  id: string;
  principalId: string;
  actor?: Readonly<Pick<AxActor, 'id' | 'kind'>>;
  operations: readonly string[];
  resources: readonly Readonly<AxResourceScope>[];
  issuedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  leaseEpoch: number;
  parentGrantId?: string;
  claims?: readonly Readonly<AxAuthorityClaim>[];
  /**
   * Contingencies this grant's authority depends on. Attenuation may only add.
   * Captured and validated by `axValidateCapabilityGrant`; a malformed
   * requirement throws there, not at guard-evaluation time.
   */
  requirements?: readonly Readonly<AxEvidenceRequirement>[];
}

export interface AxAuthorizationRequestContext {
  requestId: string;
  principal: Readonly<AxPrincipal>;
  actor: Readonly<AxActor>;
  delegation?: Readonly<AxDelegationClaims>;
  resource: Readonly<AxResourceScope>;
  grants: readonly Readonly<AxCapabilityGrant>[];
  leaseEpoch: number;
  now: number;
  signal?: AbortSignal;
  /** Ax always supplies this (possibly empty). Optional for source compatibility. */
  evidence?: readonly Readonly<AxEvidenceObservation>[];
  /** Deduped union of the matching grants' requirements, in grant order. */
  requirements?: readonly Readonly<AxEvidenceRequirement>[];
}

/** A host callback must echo this binding exactly for Ax to accept it. */
export interface AxAuthorizationReceipt {
  version: 1;
  receiptId: string;
  requestId: string;
  decision: 'allow' | 'deny';
  operation: string;
  resource: Readonly<AxResourceScope>;
  principalId: string;
  actor: Readonly<Pick<AxActor, 'id' | 'kind'>>;
  grantIds: readonly string[];
  leaseEpoch: number;
  authorizedAt: number;
  expiresAt?: number;
  reason?: string;
}

export type AxAuthorizer = (
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>
) =>
  | Readonly<AxAuthorizationReceipt>
  | Promise<Readonly<AxAuthorizationReceipt>>;

/** Redacted by construction: no IDs, claims, arguments, or receipt reason. */
export interface AxAuthorizationAuditEvent {
  operation: string;
  resourceType: string;
  actorKind: AxActor['kind'];
  decision: 'allow' | 'deny';
  grantCount: number;
  at: number;
  code:
    | 'authorized'
    | 'host_denied'
    | 'no_matching_grant'
    | 'invalid_receipt'
    | 'cancelled'
    | 'timeout'
    | 'guard_predicate_failed';
  /**
   * Deliberate, bounded exception to redaction-by-construction: `"<op>:<kind>"`
   * of the first failed guard, truncated to 240 characters. Never an
   * observation value, source ID, claim, or resource ID.
   */
  failedPredicateKind?: string;
}

export interface AxAuthorityContext {
  principal: Readonly<AxPrincipal>;
  actor: Readonly<AxActor>;
  delegation?: Readonly<AxDelegationClaims>;
  grants: readonly Readonly<AxCapabilityGrant>[];
  leaseEpoch: number;
  authorize: AxAuthorizer;
  /** Maximum host-authorizer duration. Defaults to 30 seconds. */
  authorizeTimeoutMs?: number;
  now?: () => number;
  /**
   * Host-observed facts for this execution. Never sourced from model output.
   * Deep-cloned and frozen by `axSnapshotAuthority` like every other host datum.
   */
  evidence?: readonly Readonly<AxEvidenceObservation>[];
  /**
   * Per-request evidence supplier, mirroring the `now?: () => number` idiom.
   * When present it is called once per `axAuthorize` and its result replaces
   * `evidence` for that request. This is what makes `maxAgeMs` usable: the
   * snapshot cache means a frozen `evidence` array only ever ages within a run.
   * Must be synchronous and side-effect free; a throw denies fail-closed with
   * `missing_observation`.
   */
  observeEvidence?: () => readonly Readonly<AxEvidenceObservation>[];
  onAudit?: (
    event: Readonly<AxAuthorizationAuditEvent>
  ) => void | Promise<void>;
}

export interface AxAuthorityDelegationOptions {
  principal: Readonly<AxPrincipal>;
  actor: Readonly<AxActor>;
  delegation: Readonly<AxDelegationClaims>;
  grants: readonly Readonly<AxCapabilityGrant>[];
}

export type AxAuthorityInheritance =
  | 'all'
  | 'none'
  | Readonly<AxAuthorityDelegationOptions>;
