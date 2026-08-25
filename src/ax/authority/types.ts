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
    | 'timeout';
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
