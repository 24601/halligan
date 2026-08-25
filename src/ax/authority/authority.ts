import type { AxFunction } from '../ai/types.js';
import type {
  AxActor,
  AxAuthorityClaim,
  AxAuthorityContext,
  AxAuthorityDelegationOptions,
  AxAuthorityValue,
  AxAuthorizationAuditEvent,
  AxAuthorizationReceipt,
  AxCapabilityGrant,
  AxResourceScope,
} from './types.js';

let fallbackRequestId = 0;
const deniedAuthorizationReceipts = new WeakMap<
  AxAuthorizationDeniedError,
  Readonly<AxAuthorizationReceipt>
>();

export class AxAuthorizationDeniedError extends Error {
  constructor(
    readonly code:
      | 'host_denied'
      | 'no_matching_grant'
      | 'invalid_receipt'
      | 'cancelled',
    message: string
  ) {
    super(message);
    this.name = 'AxAuthorizationDeniedError';
  }
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function validateValue(value: unknown, path: string, seen: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    finite(value, path);
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${path} is not a persistable authority value`);
  }
  if (seen.has(value)) throw new Error(`${path} must not be cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateValue(entry, `${path}[${index}]`, seen)
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be a plain object`);
    }
    for (const [key, entry] of Object.entries(value)) {
      validateValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function validateClaims(
  claims: readonly Readonly<AxAuthorityClaim>[] | undefined,
  path: string
): void {
  for (const [index, claim] of (claims ?? []).entries()) {
    nonEmpty(claim?.type, `${path}[${index}].type`);
    validateValue(claim.value, `${path}[${index}].value`, new Set());
  }
}

function validateResource(resource: Readonly<AxResourceScope>, path: string) {
  nonEmpty(resource?.type, `${path}.type`);
  nonEmpty(resource?.id, `${path}.id`);
  if (resource.tenantId !== undefined)
    nonEmpty(resource.tenantId, `${path}.tenantId`);
}

function validateActor(actor: Readonly<AxActor>, path: string): void {
  nonEmpty(actor?.id, `${path}.id`);
  if (!['human', 'agent', 'service', 'unknown'].includes(actor?.kind)) {
    throw new Error(`${path}.kind is invalid`);
  }
  validateClaims(actor.claims, `${path}.claims`);
}

export function axValidateCapabilityGrant(
  grant: Readonly<AxCapabilityGrant>
): void {
  if (grant?.version !== 1) {
    throw new Error('AxCapabilityGrant.version must be 1');
  }
  nonEmpty(grant.id, 'AxCapabilityGrant.id');
  nonEmpty(grant.principalId, 'AxCapabilityGrant.principalId');
  finite(grant.leaseEpoch, 'AxCapabilityGrant.leaseEpoch');
  if (!Number.isInteger(grant.leaseEpoch) || grant.leaseEpoch < 0) {
    throw new Error(
      'AxCapabilityGrant.leaseEpoch must be a non-negative integer'
    );
  }
  if (!grant.operations.length)
    throw new Error('AxCapabilityGrant.operations must not be empty');
  grant.operations.forEach((operation, index) =>
    nonEmpty(operation, `AxCapabilityGrant.operations[${index}]`)
  );
  if (!grant.resources.length)
    throw new Error('AxCapabilityGrant.resources must not be empty');
  grant.resources.forEach((resource, index) =>
    validateResource(resource, `AxCapabilityGrant.resources[${index}]`)
  );
  for (const name of ['issuedAt', 'expiresAt', 'revokedAt'] as const) {
    if (grant[name] !== undefined)
      finite(grant[name], `AxCapabilityGrant.${name}`);
  }
  if (grant.parentGrantId !== undefined)
    nonEmpty(grant.parentGrantId, 'AxCapabilityGrant.parentGrantId');
  if (grant.actor) validateActor(grant.actor, 'AxCapabilityGrant.actor');
  validateClaims(grant.claims, 'AxCapabilityGrant.claims');
}

function sameResource(
  left: Readonly<AxResourceScope>,
  right: Readonly<AxResourceScope>
): boolean {
  return (
    left.type === right.type &&
    left.id === right.id &&
    left.tenantId === right.tenantId
  );
}

function matchingGrants(
  authority: Readonly<AxAuthorityContext>,
  operation: string,
  resource: Readonly<AxResourceScope>,
  now: number
): readonly Readonly<AxCapabilityGrant>[] {
  return authority.grants.filter((grant) => {
    axValidateCapabilityGrant(grant);
    return (
      grant.principalId === authority.principal.id &&
      grant.leaseEpoch === authority.leaseEpoch &&
      grant.operations.includes(operation) &&
      grant.resources.some((candidate) => sameResource(candidate, resource)) &&
      (grant.actor === undefined ||
        (grant.actor.id === authority.actor.id &&
          grant.actor.kind === authority.actor.kind)) &&
      (grant.issuedAt === undefined || grant.issuedAt <= now) &&
      (grant.expiresAt === undefined || grant.expiresAt > now) &&
      (grant.revokedAt === undefined || grant.revokedAt > now) &&
      (authority.principal.tenantId === undefined ||
        resource.tenantId === authority.principal.tenantId)
    );
  });
}

function requestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ax-authority-${Date.now()}-${++fallbackRequestId}`
  );
}

function receiptMatches(
  value: unknown,
  operation: string,
  context: Readonly<AxAuthorityContext>,
  resource: Readonly<AxResourceScope>,
  request: string,
  grants: readonly Readonly<AxCapabilityGrant>[],
  now: number
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<AxAuthorizationReceipt>;
  const eligible = new Set(grants.map((grant) => grant.id));
  return (
    receipt.version === 1 &&
    Boolean(receipt.receiptId?.trim()) &&
    receipt.requestId === request &&
    receipt.operation === operation &&
    receipt.resource !== undefined &&
    sameResource(receipt.resource, resource) &&
    receipt.principalId === context.principal.id &&
    receipt.actor?.id === context.actor.id &&
    receipt.actor?.kind === context.actor.kind &&
    receipt.leaseEpoch === context.leaseEpoch &&
    Number.isFinite(receipt.authorizedAt) &&
    receipt.authorizedAt !== undefined &&
    receipt.authorizedAt <= now &&
    (receipt.expiresAt === undefined || receipt.expiresAt > now) &&
    (receipt.decision === 'allow' || receipt.decision === 'deny') &&
    Array.isArray(receipt.grantIds) &&
    (receipt.decision === 'deny' ||
      (receipt.grantIds.length === eligible.size &&
        new Set(receipt.grantIds).size === eligible.size &&
        receipt.grantIds.every((grantId) => eligible.has(grantId))))
  );
}

async function audit(
  authority: Readonly<AxAuthorityContext>,
  event: Readonly<AxAuthorizationAuditEvent>
): Promise<void> {
  await authority.onAudit?.(event);
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Perform exact local scope checks, then require an exactly-bound host receipt.
 * Host verification remains authoritative; Ax does not authenticate grants.
 */
export async function axAuthorize(
  authority: Readonly<AxAuthorityContext> | undefined,
  operation: string,
  resource: Readonly<AxResourceScope>,
  signal?: AbortSignal
): Promise<Readonly<AxAuthorizationReceipt> | undefined> {
  if (!authority) return;
  nonEmpty(operation, 'authorization operation');
  validateResource(resource, 'authorization resource');
  nonEmpty(authority.principal?.id, 'AxPrincipal.id');
  if (authority.principal.tenantId !== undefined)
    nonEmpty(authority.principal.tenantId, 'AxPrincipal.tenantId');
  validateClaims(authority.principal.claims, 'AxPrincipal.claims');
  validateActor(authority.actor, 'AxActor');
  finite(authority.leaseEpoch, 'AxAuthorityContext.leaseEpoch');
  if (!Number.isInteger(authority.leaseEpoch) || authority.leaseEpoch < 0) {
    throw new Error(
      'AxAuthorityContext.leaseEpoch must be a non-negative integer'
    );
  }
  if (authority.delegation) {
    nonEmpty(
      authority.delegation.parentPrincipalId,
      'AxDelegationClaims.parentPrincipalId'
    );
    if (
      !Number.isInteger(authority.delegation.depth) ||
      authority.delegation.depth < 1
    ) {
      throw new Error('AxDelegationClaims.depth must be a positive integer');
    }
    validateClaims(authority.delegation.claims, 'AxDelegationClaims.claims');
  }
  const now = authority.now?.() ?? Date.now();
  if (cancelled(signal)) {
    await audit(authority, {
      operation,
      resourceType: resource.type,
      actorKind: authority.actor.kind,
      decision: 'deny',
      grantCount: 0,
      at: now,
      code: 'cancelled',
    });
    throw new AxAuthorizationDeniedError(
      'cancelled',
      'Authorization cancelled'
    );
  }
  const grants = matchingGrants(authority, operation, resource, now);
  if (!grants.length) {
    await audit(authority, {
      operation,
      resourceType: resource.type,
      actorKind: authority.actor.kind,
      decision: 'deny',
      grantCount: 0,
      at: now,
      code: 'no_matching_grant',
    });
    throw new AxAuthorizationDeniedError(
      'no_matching_grant',
      `No active capability grant matches ${operation}`
    );
  }
  const id = requestId();
  const receipt = await authority.authorize(operation, {
    requestId: id,
    principal: authority.principal,
    actor: authority.actor,
    delegation: authority.delegation,
    resource,
    grants,
    leaseEpoch: authority.leaseEpoch,
    now,
    signal,
  });
  const finishedAt = authority.now?.() ?? Date.now();
  const currentGrants = matchingGrants(
    authority,
    operation,
    resource,
    finishedAt
  );
  if (
    cancelled(signal) ||
    !receiptMatches(
      receipt,
      operation,
      authority,
      resource,
      id,
      currentGrants,
      finishedAt
    )
  ) {
    const code = cancelled(signal) ? 'cancelled' : 'invalid_receipt';
    await audit(authority, {
      operation,
      resourceType: resource.type,
      actorKind: authority.actor.kind,
      decision: 'deny',
      grantCount: grants.length,
      at: finishedAt,
      code,
    });
    throw new AxAuthorizationDeniedError(
      code,
      code === 'cancelled'
        ? 'Authorization cancelled'
        : 'Host authorization receipt did not match the exact request'
    );
  }
  const decision = receipt.decision;
  await audit(authority, {
    operation,
    resourceType: resource.type,
    actorKind: authority.actor.kind,
    decision,
    grantCount: receipt.grantIds.length,
    at: finishedAt,
    code: decision === 'allow' ? 'authorized' : 'host_denied',
  });
  if (decision === 'deny') {
    const error = new AxAuthorizationDeniedError(
      'host_denied',
      `Host denied ${operation}`
    );
    deniedAuthorizationReceipts.set(error, receipt);
    throw error;
  }
  return receipt;
}

/** @internal Return an already-validated exact host denial binding. */
export function getAuthorizationDeniedReceipt(
  error: unknown
): Readonly<AxAuthorizationReceipt> | undefined {
  return error instanceof AxAuthorizationDeniedError
    ? deniedAuthorizationReceipts.get(error)
    : undefined;
}

/** @internal Revalidate an exact receipt without invoking host policy twice. */
export function isAuthorizationReceiptCurrent(
  authority: Readonly<AxAuthorityContext>,
  operation: string,
  resource: Readonly<AxResourceScope>,
  receipt: Readonly<AxAuthorizationReceipt>
): boolean {
  try {
    const now = authority.now?.() ?? Date.now();
    const grants = matchingGrants(authority, operation, resource, now);
    return receiptMatches(
      receipt,
      operation,
      authority,
      resource,
      receipt.requestId,
      grants,
      now
    );
  } catch {
    return false;
  }
}

/** Derive the non-model-visible operation/resource binding for an Ax function. */
export function axFunctionAuthorityTarget(
  fn: Readonly<AxFunction>,
  authority: Readonly<AxAuthorityContext>,
  qualifiedName?: string
): Readonly<{ operation: string; resource: AxResourceScope }> {
  const protocol = fn.protocol;
  const operation =
    protocol?.kind === 'mcp'
      ? 'mcp.tool.call'
      : protocol?.kind === 'ucp'
        ? 'ucp.operation.call'
        : fn.componentId?.startsWith('agent:')
          ? 'agent.invoke'
          : 'function.call';
  const type =
    protocol?.kind === 'mcp'
      ? 'mcp.tool'
      : protocol?.kind === 'ucp'
        ? 'ucp.operation'
        : operation === 'agent.invoke'
          ? 'agent'
          : 'function';
  const id = protocol
    ? `${protocol.namespace}:${protocol.name}`
    : (fn.componentId ?? qualifiedName ?? fn.name);
  return {
    operation,
    resource: {
      type,
      id,
      ...(authority.principal.tenantId
        ? { tenantId: authority.principal.tenantId }
        : {}),
    },
  };
}

function containsResource(
  parent: Readonly<AxCapabilityGrant>,
  resource: Readonly<AxResourceScope>
): boolean {
  return parent.resources.some((candidate) =>
    sameResource(candidate, resource)
  );
}

/** Validate and construct a child authority that cannot expand parent grants. */
export function axAttenuateAuthority(
  parent: Readonly<AxAuthorityContext>,
  child: Readonly<AxAuthorityDelegationOptions>
): Readonly<AxAuthorityContext> {
  if (child.delegation.parentPrincipalId !== parent.principal.id) {
    throw new Error(
      'Child delegation parent does not match the parent principal'
    );
  }
  if (child.principal.tenantId !== parent.principal.tenantId) {
    throw new Error('Child delegation cannot change tenant scope');
  }
  const expectedDepth = (parent.delegation?.depth ?? 0) + 1;
  if (child.delegation.depth !== expectedDepth) {
    throw new Error(`Child delegation depth must be ${expectedDepth}`);
  }
  const parents = new Map(parent.grants.map((grant) => [grant.id, grant]));
  for (const grant of child.grants) {
    axValidateCapabilityGrant(grant);
    const source = grant.parentGrantId
      ? parents.get(grant.parentGrantId)
      : undefined;
    if (!source) throw new Error('Child grant must reference a parent grant');
    axValidateCapabilityGrant(source);
    if (
      source.principalId !== parent.principal.id ||
      (source.actor !== undefined &&
        (source.actor.id !== parent.actor.id ||
          source.actor.kind !== parent.actor.kind)) ||
      grant.principalId !== child.principal.id ||
      grant.actor === undefined ||
      grant.actor.id !== child.actor.id ||
      grant.actor.kind !== child.actor.kind ||
      grant.leaseEpoch !== source.leaseEpoch ||
      grant.leaseEpoch !== parent.leaseEpoch ||
      grant.operations.some(
        (operation) => !source.operations.includes(operation)
      ) ||
      grant.resources.some((resource) => !containsResource(source, resource)) ||
      (source.issuedAt !== undefined &&
        (grant.issuedAt === undefined || grant.issuedAt < source.issuedAt)) ||
      (source.expiresAt !== undefined &&
        (grant.expiresAt === undefined ||
          grant.expiresAt > source.expiresAt)) ||
      (source.revokedAt !== undefined &&
        (grant.revokedAt === undefined || grant.revokedAt > source.revokedAt))
    ) {
      throw new Error('Child capability grant expands parent authority');
    }
  }
  return Object.freeze({
    principal: child.principal,
    actor: child.actor,
    delegation: child.delegation,
    grants: Object.freeze([...child.grants]),
    leaseEpoch: parent.leaseEpoch,
    authorize: parent.authorize,
    now: parent.now,
    onAudit: parent.onAudit,
  });
}

/** Utility for typed synthetic claims without giving Ax claim semantics. */
export function axAuthorityClaim(
  type: string,
  value: AxAuthorityValue
): Readonly<AxAuthorityClaim> {
  const claim = { type, value };
  validateClaims([claim], 'claim');
  return Object.freeze(claim);
}
