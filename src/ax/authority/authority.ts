import type { AxFunction } from '../ai/types.js';
import type {
  AxActor,
  AxAuthorityClaim,
  AxAuthorityContext,
  AxAuthorityDelegationOptions,
  AxAuthorityValue,
  AxAuthorizationAuditEvent,
  AxAuthorizationReceipt,
  AxAuthorizationRequestContext,
  AxCapabilityGrant,
  AxResourceScope,
} from './types.js';

let fallbackRequestId = 0;
const authoritySnapshots = new WeakSet<object>();
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 30_000;

export class AxAuthorizationDeniedError extends Error {
  constructor(
    readonly code:
      | 'host_denied'
      | 'no_matching_grant'
      | 'invalid_receipt'
      | 'cancelled'
      | 'timeout',
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

function cloneValue(value: AxAuthorityValue): AxAuthorityValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneValue(entry)));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: AxAuthorityValue };
    return Object.freeze(
      Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, cloneValue(record[key]!)])
      )
    );
  }
  return value;
}

function cloneClaims(
  claims: readonly Readonly<AxAuthorityClaim>[] | undefined
): readonly Readonly<AxAuthorityClaim>[] | undefined {
  if (!claims) return;
  return Object.freeze(
    claims.map((claim) =>
      Object.freeze({ type: claim.type, value: cloneValue(claim.value) })
    )
  );
}

function cloneResource(
  resource: Readonly<AxResourceScope>
): Readonly<AxResourceScope> {
  return Object.freeze({
    type: resource.type,
    id: resource.id,
    ...(resource.tenantId !== undefined ? { tenantId: resource.tenantId } : {}),
  });
}

function cloneGrant(
  grant: Readonly<AxCapabilityGrant>
): Readonly<AxCapabilityGrant> {
  return Object.freeze({
    version: grant.version,
    id: grant.id,
    principalId: grant.principalId,
    ...(grant.actor
      ? { actor: Object.freeze({ id: grant.actor.id, kind: grant.actor.kind }) }
      : {}),
    operations: Object.freeze([...grant.operations]),
    resources: Object.freeze(grant.resources.map(cloneResource)),
    ...(grant.issuedAt !== undefined ? { issuedAt: grant.issuedAt } : {}),
    ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
    ...(grant.revokedAt !== undefined ? { revokedAt: grant.revokedAt } : {}),
    leaseEpoch: grant.leaseEpoch,
    ...(grant.parentGrantId !== undefined
      ? { parentGrantId: grant.parentGrantId }
      : {}),
    ...(grant.claims ? { claims: cloneClaims(grant.claims) } : {}),
  });
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

/** Clone and deeply freeze host-owned authority data at an execution boundary. */
export function axSnapshotAuthority(
  authority: Readonly<AxAuthorityContext>
): Readonly<AxAuthorityContext> {
  if (authoritySnapshots.has(authority as object)) return authority;
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
  if (typeof authority.authorize !== 'function') {
    throw new Error('AxAuthorityContext.authorize must be a function');
  }
  const authorizeTimeoutMs =
    authority.authorizeTimeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS;
  if (!Number.isFinite(authorizeTimeoutMs) || authorizeTimeoutMs <= 0) {
    throw new Error(
      'AxAuthorityContext.authorizeTimeoutMs must be a positive finite number'
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
  const grants = authority.grants.map((grant) => {
    axValidateCapabilityGrant(grant);
    return cloneGrant(grant);
  });
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) {
    throw new Error('AxAuthorityContext grant IDs must be unique');
  }
  const snapshot = Object.freeze({
    principal: Object.freeze({
      id: authority.principal.id,
      ...(authority.principal.tenantId !== undefined
        ? { tenantId: authority.principal.tenantId }
        : {}),
      ...(authority.principal.claims
        ? { claims: cloneClaims(authority.principal.claims) }
        : {}),
    }),
    actor: Object.freeze({
      id: authority.actor.id,
      kind: authority.actor.kind,
      ...(authority.actor.claims
        ? { claims: cloneClaims(authority.actor.claims) }
        : {}),
    }),
    ...(authority.delegation
      ? {
          delegation: Object.freeze({
            parentPrincipalId: authority.delegation.parentPrincipalId,
            depth: authority.delegation.depth,
            ...(authority.delegation.claims
              ? { claims: cloneClaims(authority.delegation.claims) }
              : {}),
          }),
        }
      : {}),
    grants: Object.freeze(grants),
    leaseEpoch: authority.leaseEpoch,
    authorize: authority.authorize,
    authorizeTimeoutMs,
    ...(authority.now ? { now: authority.now } : {}),
    ...(authority.onAudit ? { onAudit: authority.onAudit } : {}),
  });
  authoritySnapshots.add(snapshot);
  return snapshot;
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
    typeof receipt.receiptId === 'string' &&
    Boolean(receipt.receiptId.trim()) &&
    receipt.requestId === request &&
    receipt.operation === operation &&
    receipt.resource !== null &&
    typeof receipt.resource === 'object' &&
    !Array.isArray(receipt.resource) &&
    typeof receipt.resource.type === 'string' &&
    typeof receipt.resource.id === 'string' &&
    (receipt.resource.tenantId === undefined ||
      typeof receipt.resource.tenantId === 'string') &&
    sameResource(receipt.resource, resource) &&
    receipt.principalId === context.principal.id &&
    receipt.actor !== null &&
    typeof receipt.actor === 'object' &&
    receipt.actor?.id === context.actor.id &&
    receipt.actor?.kind === context.actor.kind &&
    receipt.leaseEpoch === context.leaseEpoch &&
    Number.isFinite(receipt.authorizedAt) &&
    receipt.authorizedAt !== undefined &&
    receipt.authorizedAt <= now &&
    (receipt.expiresAt === undefined ||
      (Number.isFinite(receipt.expiresAt) && receipt.expiresAt > now)) &&
    (receipt.decision === 'allow' || receipt.decision === 'deny') &&
    Array.isArray(receipt.grantIds) &&
    receipt.grantIds.every((grantId) => typeof grantId === 'string') &&
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
  await authority.onAudit?.(Object.freeze({ ...event }));
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function callAuthorizer(
  authority: Readonly<AxAuthorityContext>,
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>,
  signal?: AbortSignal
): Promise<Readonly<AxAuthorizationReceipt>> {
  const controller = new AbortController();
  const timeoutMs =
    authority.authorizeTimeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort(signal?.reason);
    rejectAbort(
      new AxAuthorizationDeniedError('cancelled', 'Authorization cancelled')
    );
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new AxAuthorizationDeniedError(
        'timeout',
        `Host authorization timed out after ${timeoutMs}ms`
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const callback = Promise.resolve().then(() =>
    authority.authorize(
      operation,
      Object.freeze({ ...context, signal: controller.signal })
    )
  );
  try {
    return await Promise.race([callback, aborted, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function snapshotReceipt(
  value: unknown
): Readonly<AxAuthorizationReceipt> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  try {
    const receipt = value as Partial<AxAuthorizationReceipt>;
    if (
      !receipt.resource ||
      typeof receipt.resource !== 'object' ||
      Array.isArray(receipt.resource) ||
      !receipt.actor ||
      typeof receipt.actor !== 'object' ||
      Array.isArray(receipt.actor) ||
      !Array.isArray(receipt.grantIds)
    ) {
      return;
    }
    return Object.freeze({
      version: receipt.version,
      receiptId: receipt.receiptId,
      requestId: receipt.requestId,
      decision: receipt.decision,
      operation: receipt.operation,
      resource: cloneResource(receipt.resource),
      principalId: receipt.principalId,
      actor: Object.freeze({ id: receipt.actor.id, kind: receipt.actor.kind }),
      grantIds: Object.freeze([...receipt.grantIds]),
      leaseEpoch: receipt.leaseEpoch,
      authorizedAt: receipt.authorizedAt,
      ...(receipt.expiresAt !== undefined
        ? { expiresAt: receipt.expiresAt }
        : {}),
      ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
    } as AxAuthorizationReceipt);
  } catch {
    return;
  }
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
  const snapshot = axSnapshotAuthority(authority);
  nonEmpty(operation, 'authorization operation');
  validateResource(resource, 'authorization resource');
  const now = snapshot.now?.() ?? Date.now();
  if (cancelled(signal)) {
    await audit(snapshot, {
      operation,
      resourceType: resource.type,
      actorKind: snapshot.actor.kind,
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
  const grants = matchingGrants(snapshot, operation, resource, now);
  if (!grants.length) {
    await audit(snapshot, {
      operation,
      resourceType: resource.type,
      actorKind: snapshot.actor.kind,
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
  let receipt: Readonly<AxAuthorizationReceipt> | undefined;
  try {
    receipt = snapshotReceipt(
      await callAuthorizer(
        snapshot,
        operation,
        {
          requestId: id,
          principal: snapshot.principal,
          actor: snapshot.actor,
          delegation: snapshot.delegation,
          resource: cloneResource(resource),
          grants,
          leaseEpoch: snapshot.leaseEpoch,
          now,
        },
        signal
      )
    );
  } catch (error) {
    if (
      error instanceof AxAuthorizationDeniedError &&
      (error.code === 'cancelled' || error.code === 'timeout')
    ) {
      await audit(snapshot, {
        operation,
        resourceType: resource.type,
        actorKind: snapshot.actor.kind,
        decision: 'deny',
        grantCount: grants.length,
        at: snapshot.now?.() ?? Date.now(),
        code: error.code,
      });
    }
    throw error;
  }
  const finishedAt = snapshot.now?.() ?? Date.now();
  const currentGrants = matchingGrants(
    snapshot,
    operation,
    resource,
    finishedAt
  );
  if (
    cancelled(signal) ||
    !receipt ||
    !receiptMatches(
      receipt,
      operation,
      snapshot,
      resource,
      id,
      currentGrants,
      finishedAt
    )
  ) {
    const code = cancelled(signal) ? 'cancelled' : 'invalid_receipt';
    await audit(snapshot, {
      operation,
      resourceType: resource.type,
      actorKind: snapshot.actor.kind,
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
  await audit(snapshot, {
    operation,
    resourceType: resource.type,
    actorKind: snapshot.actor.kind,
    decision,
    grantCount: receipt.grantIds.length,
    at: finishedAt,
    code: decision === 'allow' ? 'authorized' : 'host_denied',
  });
  if (decision === 'deny') {
    throw new AxAuthorizationDeniedError(
      'host_denied',
      `Host denied ${operation}`
    );
  }
  return receipt;
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
  const parentSnapshot = axSnapshotAuthority(parent);
  const childPrincipal = Object.freeze({
    id: child.principal.id,
    ...(child.principal.tenantId !== undefined
      ? { tenantId: child.principal.tenantId }
      : {}),
    ...(child.principal.claims
      ? { claims: cloneClaims(child.principal.claims) }
      : {}),
  });
  const childActor = Object.freeze({
    id: child.actor.id,
    kind: child.actor.kind,
    ...(child.actor.claims ? { claims: cloneClaims(child.actor.claims) } : {}),
  });
  const childDelegation = Object.freeze({
    parentPrincipalId: child.delegation.parentPrincipalId,
    depth: child.delegation.depth,
    ...(child.delegation.claims
      ? { claims: cloneClaims(child.delegation.claims) }
      : {}),
  });
  const childGrants = Object.freeze(child.grants.map(cloneGrant));
  if (childDelegation.parentPrincipalId !== parentSnapshot.principal.id) {
    throw new Error(
      'Child delegation parent does not match the parent principal'
    );
  }
  if (childPrincipal.tenantId !== parentSnapshot.principal.tenantId) {
    throw new Error('Child delegation cannot change tenant scope');
  }
  const expectedDepth = (parentSnapshot.delegation?.depth ?? 0) + 1;
  if (childDelegation.depth !== expectedDepth) {
    throw new Error(`Child delegation depth must be ${expectedDepth}`);
  }
  const parents = new Map(
    parentSnapshot.grants.map((grant) => [grant.id, grant])
  );
  for (const grant of childGrants) {
    axValidateCapabilityGrant(grant);
    const source = grant.parentGrantId
      ? parents.get(grant.parentGrantId)
      : undefined;
    if (!source) throw new Error('Child grant must reference a parent grant');
    axValidateCapabilityGrant(source);
    if (
      source.principalId !== parentSnapshot.principal.id ||
      (source.actor !== undefined &&
        (source.actor.id !== parentSnapshot.actor.id ||
          source.actor.kind !== parentSnapshot.actor.kind)) ||
      grant.principalId !== childPrincipal.id ||
      grant.actor === undefined ||
      grant.actor.id !== childActor.id ||
      grant.actor.kind !== childActor.kind ||
      grant.leaseEpoch !== source.leaseEpoch ||
      grant.leaseEpoch !== parentSnapshot.leaseEpoch ||
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
  return axSnapshotAuthority({
    principal: childPrincipal,
    actor: childActor,
    delegation: childDelegation,
    grants: childGrants,
    leaseEpoch: parentSnapshot.leaseEpoch,
    authorize: parentSnapshot.authorize,
    authorizeTimeoutMs: parentSnapshot.authorizeTimeoutMs,
    now: parentSnapshot.now,
    onAudit: parentSnapshot.onAudit,
  });
}

/** Utility for typed synthetic claims without giving Ax claim semantics. */
export function axAuthorityClaim(
  type: string,
  value: AxAuthorityValue
): Readonly<AxAuthorityClaim> {
  const claim = { type, value };
  validateClaims([claim], 'claim');
  return Object.freeze({ type, value: cloneValue(value) });
}
