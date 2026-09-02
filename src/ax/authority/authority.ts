import type { AxFunction } from '../ai/types.js';
import {
  axCollectGrantRequirements,
  axEvaluateGuards,
  axIsEvidenceRequirement,
  evidenceRequirementKey,
} from './evidence.js';
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
  AxDelegationClaims,
  AxEvidenceObservation,
  AxEvidenceRequirement,
  AxResourceScope,
} from './types.js';

let fallbackRequestId = 0;
const authoritySnapshots = new WeakSet<object>();
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 30_000;
/** Bounds the per-grant contingency list a host may declare. */
const MAX_GRANT_REQUIREMENTS = 32;
/**
 * Bounds the observation set a host may attach to one authority — including the
 * set a per-request `observeEvidence` supplier returns, which is cloned and
 * frozen on every `axAuthorize` call and scanned once per requirement.
 */
const MAX_EVIDENCE_OBSERVATIONS = 64;
/** Matches the advisory bound the rest of this subsystem's labels use. */
const MAX_FAILED_PREDICATE_KIND = 240;
const EMPTY_EVIDENCE: readonly Readonly<AxEvidenceObservation>[] =
  Object.freeze([]);

export class AxAuthorizationDeniedError extends Error {
  constructor(
    readonly code:
      | 'host_denied'
      | 'no_matching_grant'
      | 'invalid_receipt'
      | 'cancelled'
      | 'timeout'
      | 'guard_predicate_failed',
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

function captureValue(
  value: unknown,
  path: string,
  seen: Set<object>
): AxAuthorityValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    finite(value, path);
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${path} is not a persistable authority value`);
  }
  if (seen.has(value)) throw new Error(`${path} must not be cyclic`);
  seen.add(value);
  let captured: AxAuthorityValue;
  if (Array.isArray(value)) {
    captured = Object.freeze(
      Array.from(value, (entry, index) =>
        captureValue(entry, `${path}[${index}]`, seen)
      )
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be a plain object`);
    }
    captured = Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [
            key,
            captureValue(entry, `${path}.${key}`, seen),
          ])
      )
    );
  }
  seen.delete(value);
  return captured;
}

function captureClaims(
  claims: readonly Readonly<AxAuthorityClaim>[] | undefined,
  path: string
): readonly Readonly<AxAuthorityClaim>[] | undefined {
  if (!claims) return;
  return Object.freeze(
    Array.from(claims, (claim, index) => {
      const type = claim?.type;
      const value = claim?.value;
      nonEmpty(type, `${path}[${index}].type`);
      return Object.freeze({
        type,
        value: captureValue(value, `${path}[${index}].value`, new Set()),
      });
    })
  );
}

function captureResource(
  resource: Readonly<AxResourceScope>,
  path: string
): Readonly<AxResourceScope> {
  const type = resource?.type;
  const id = resource?.id;
  const tenantId = resource?.tenantId;
  nonEmpty(type, `${path}.type`);
  nonEmpty(id, `${path}.id`);
  if (tenantId !== undefined) nonEmpty(tenantId, `${path}.tenantId`);
  return Object.freeze({
    type,
    id,
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
}

function captureActor(
  actor: Readonly<AxActor>,
  path: string
): Readonly<AxActor> {
  const id = actor?.id;
  const kind = actor?.kind;
  const claims = actor?.claims;
  nonEmpty(id, `${path}.id`);
  if (!['human', 'agent', 'service', 'unknown'].includes(kind)) {
    throw new Error(`${path}.kind is invalid`);
  }
  const capturedClaims = captureClaims(claims, `${path}.claims`);
  return Object.freeze({
    id,
    kind,
    ...(capturedClaims ? { claims: capturedClaims } : {}),
  });
}

/**
 * `captureGrant` reconstructs a grant from an explicit field list, so a field
 * it does not name is silently dropped. Requirements are captured here — and
 * validated here — so that a declared contingency survives
 * `axSnapshotAuthority` and so a malformed one throws from
 * `axValidateCapabilityGrant` rather than at guard-evaluation time.
 */
function captureRequirements(
  value: unknown,
  label: string
): readonly Readonly<AxEvidenceRequirement>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_GRANT_REQUIREMENTS) {
    throw new Error(`${label} exceeds ${MAX_GRANT_REQUIREMENTS} entries`);
  }
  return Object.freeze(
    Array.from(value, (entry, index) => {
      if (!axIsEvidenceRequirement(entry)) {
        throw new Error(`${label}[${index}] is malformed`);
      }
      return Object.freeze({
        kind: entry.kind,
        trustedSources: Object.freeze([...entry.trustedSources]),
        ...(entry.maxAgeMs !== undefined ? { maxAgeMs: entry.maxAgeMs } : {}),
        match: Object.freeze({ ...entry.match }),
      }) as Readonly<AxEvidenceRequirement>;
    })
  );
}

/**
 * Host-observed facts are host-owned data at an execution boundary, so they get
 * the same clone-and-freeze treatment as principals, grants, and claims. A
 * structurally invalid observation throws rather than being silently ignored.
 */
function captureObservations(
  value: unknown,
  label: string
): readonly Readonly<AxEvidenceObservation>[] {
  if (value === undefined) return EMPTY_EVIDENCE;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_EVIDENCE_OBSERVATIONS) {
    throw new Error(`${label} exceeds ${MAX_EVIDENCE_OBSERVATIONS} entries`);
  }
  return Object.freeze(
    Array.from(value, (entry, index) => {
      const path = `${label}[${index}]`;
      const version = entry?.version;
      const kind = entry?.kind;
      const sourceId = entry?.sourceId;
      const observedAt = entry?.observedAt;
      const leaseEpoch = entry?.leaseEpoch;
      if (version !== 1) throw new Error(`${path}.version must be 1`);
      nonEmpty(kind, `${path}.kind`);
      nonEmpty(sourceId, `${path}.sourceId`);
      finite(observedAt, `${path}.observedAt`);
      finite(leaseEpoch, `${path}.leaseEpoch`);
      if (!Number.isInteger(leaseEpoch) || leaseEpoch < 0) {
        throw new Error(`${path}.leaseEpoch must be a non-negative integer`);
      }
      return Object.freeze({
        version: 1,
        kind,
        sourceId,
        observedAt,
        value: captureValue(entry?.value, `${path}.value`, new Set()),
        leaseEpoch,
      }) as Readonly<AxEvidenceObservation>;
    })
  );
}

function captureGrant(
  grant: Readonly<AxCapabilityGrant>
): Readonly<AxCapabilityGrant> {
  const version = grant?.version;
  const id = grant?.id;
  const principalId = grant?.principalId;
  const actor = grant?.actor;
  const operations = grant?.operations;
  const resources = grant?.resources;
  const issuedAt = grant?.issuedAt;
  const expiresAt = grant?.expiresAt;
  const revokedAt = grant?.revokedAt;
  const leaseEpoch = grant?.leaseEpoch;
  const parentGrantId = grant?.parentGrantId;
  const claims = grant?.claims;
  const requirements = grant?.requirements;
  if (version !== 1) throw new Error('AxCapabilityGrant.version must be 1');
  nonEmpty(id, 'AxCapabilityGrant.id');
  nonEmpty(principalId, 'AxCapabilityGrant.principalId');
  finite(leaseEpoch, 'AxCapabilityGrant.leaseEpoch');
  if (!Number.isInteger(leaseEpoch) || leaseEpoch < 0) {
    throw new Error(
      'AxCapabilityGrant.leaseEpoch must be a non-negative integer'
    );
  }
  if (!Array.isArray(operations) || !operations.length) {
    throw new Error('AxCapabilityGrant.operations must not be empty');
  }
  const capturedOperations = Object.freeze(
    Array.from(operations, (operation, index) => {
      nonEmpty(operation, `AxCapabilityGrant.operations[${index}]`);
      return operation;
    })
  );
  if (!Array.isArray(resources) || !resources.length) {
    throw new Error('AxCapabilityGrant.resources must not be empty');
  }
  const capturedResources = Object.freeze(
    Array.from(resources, (resource, index) =>
      captureResource(resource, `AxCapabilityGrant.resources[${index}]`)
    )
  );
  for (const [name, value] of [
    ['issuedAt', issuedAt],
    ['expiresAt', expiresAt],
    ['revokedAt', revokedAt],
  ] as const) {
    if (value !== undefined) finite(value, `AxCapabilityGrant.${name}`);
  }
  if (parentGrantId !== undefined) {
    nonEmpty(parentGrantId, 'AxCapabilityGrant.parentGrantId');
  }
  const capturedActor = actor
    ? captureActor(actor as Readonly<AxActor>, 'AxCapabilityGrant.actor')
    : undefined;
  const capturedClaims = captureClaims(claims, 'AxCapabilityGrant.claims');
  const capturedRequirements = captureRequirements(
    requirements,
    'AxCapabilityGrant.requirements'
  );
  return Object.freeze({
    version,
    id,
    principalId,
    ...(capturedActor
      ? {
          actor: Object.freeze({
            id: capturedActor.id,
            kind: capturedActor.kind,
          }),
        }
      : {}),
    operations: capturedOperations,
    resources: capturedResources,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    leaseEpoch,
    ...(parentGrantId !== undefined ? { parentGrantId } : {}),
    ...(capturedClaims ? { claims: capturedClaims } : {}),
    ...(capturedRequirements ? { requirements: capturedRequirements } : {}),
  });
}

export function axValidateCapabilityGrant(
  grant: Readonly<AxCapabilityGrant>
): void {
  captureGrant(grant);
}

/** Clone and deeply freeze host-owned authority data at an execution boundary. */
export function axSnapshotAuthority(
  authority: Readonly<AxAuthorityContext>
): Readonly<AxAuthorityContext> {
  if (authoritySnapshots.has(authority as object)) return authority;
  const principal = authority?.principal;
  const actor = authority?.actor;
  const delegation = authority?.delegation;
  const sourceGrants = authority?.grants;
  const leaseEpoch = authority?.leaseEpoch;
  const authorize = authority?.authorize;
  const configuredTimeout = authority?.authorizeTimeoutMs;
  const now = authority?.now;
  const sourceEvidence = authority?.evidence;
  const observeEvidence = authority?.observeEvidence;
  const onAudit = authority?.onAudit;

  const principalId = principal?.id;
  const tenantId = principal?.tenantId;
  const principalClaims = principal?.claims;
  nonEmpty(principalId, 'AxPrincipal.id');
  if (tenantId !== undefined) nonEmpty(tenantId, 'AxPrincipal.tenantId');
  const capturedPrincipalClaims = captureClaims(
    principalClaims,
    'AxPrincipal.claims'
  );
  const capturedPrincipal = Object.freeze({
    id: principalId,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(capturedPrincipalClaims ? { claims: capturedPrincipalClaims } : {}),
  });
  const capturedActor = captureActor(actor, 'AxActor');

  finite(leaseEpoch, 'AxAuthorityContext.leaseEpoch');
  if (!Number.isInteger(leaseEpoch) || leaseEpoch < 0) {
    throw new Error(
      'AxAuthorityContext.leaseEpoch must be a non-negative integer'
    );
  }
  if (typeof authorize !== 'function') {
    throw new Error('AxAuthorityContext.authorize must be a function');
  }
  const authorizeTimeoutMs = configuredTimeout ?? DEFAULT_AUTHORIZE_TIMEOUT_MS;
  if (!Number.isFinite(authorizeTimeoutMs) || authorizeTimeoutMs <= 0) {
    throw new Error(
      'AxAuthorityContext.authorizeTimeoutMs must be a positive finite number'
    );
  }
  let capturedDelegation: Readonly<AxDelegationClaims> | undefined;
  if (delegation) {
    const parentPrincipalId = delegation.parentPrincipalId;
    const depth = delegation.depth;
    const claims = delegation.claims;
    nonEmpty(parentPrincipalId, 'AxDelegationClaims.parentPrincipalId');
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error('AxDelegationClaims.depth must be a positive integer');
    }
    const capturedClaims = captureClaims(claims, 'AxDelegationClaims.claims');
    capturedDelegation = Object.freeze({
      parentPrincipalId,
      depth,
      ...(capturedClaims ? { claims: capturedClaims } : {}),
    });
  }
  if (!Array.isArray(sourceGrants)) {
    throw new Error('AxAuthorityContext.grants must be an array');
  }
  const grants = Object.freeze(Array.from(sourceGrants, captureGrant));
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) {
    throw new Error('AxAuthorityContext grant IDs must be unique');
  }
  if (observeEvidence !== undefined && typeof observeEvidence !== 'function') {
    throw new Error('AxAuthorityContext.observeEvidence must be a function');
  }
  const evidence =
    sourceEvidence === undefined
      ? undefined
      : captureObservations(sourceEvidence, 'AxAuthorityContext.evidence');
  const snapshot = Object.freeze({
    principal: capturedPrincipal,
    actor: capturedActor,
    ...(capturedDelegation ? { delegation: capturedDelegation } : {}),
    grants,
    leaseEpoch,
    authorize,
    authorizeTimeoutMs,
    ...(now ? { now } : {}),
    ...(evidence ? { evidence } : {}),
    ...(observeEvidence ? { observeEvidence } : {}),
    ...(onAudit ? { onAudit } : {}),
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

async function raceHostCallback<T>(
  callback: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onAbort?: (reason: unknown) => void
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    const reason =
      signal?.reason ??
      new AxAuthorizationDeniedError('cancelled', 'Authorization cancelled');
    onAbort?.(reason);
    rejectAbort(
      reason instanceof AxAuthorizationDeniedError
        ? reason
        : new AxAuthorizationDeniedError('cancelled', 'Authorization cancelled')
    );
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new AxAuthorizationDeniedError(
        'timeout',
        `Host authorization timed out after ${timeoutMs}ms`
      );
      onAbort?.(error);
      reject(error);
    }, timeoutMs);
  });
  void callback.catch(() => undefined);
  try {
    return await Promise.race([callback, aborted, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function audit(
  authority: Readonly<AxAuthorityContext>,
  event: Readonly<AxAuthorizationAuditEvent>,
  signal?: AbortSignal
): Promise<void> {
  if (!authority.onAudit) return;
  const timeoutMs =
    authority.authorizeTimeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS;
  const callback = Promise.resolve().then(() =>
    authority.onAudit?.(Object.freeze({ ...event }))
  );
  try {
    await raceHostCallback(callback, signal, timeoutMs);
  } catch (error) {
    if (
      error instanceof AxAuthorizationDeniedError &&
      (error.code === 'cancelled' || error.code === 'timeout')
    ) {
      return;
    }
    throw error;
  }
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
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
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
  // Timeout/cancel drop this promise; swallow late reject so it cannot become
  // an unhandledRejection after Promise.race settles.
  void callback.catch(() => {});
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
    const version = receipt.version;
    const receiptId = receipt.receiptId;
    const requestId = receipt.requestId;
    const decision = receipt.decision;
    const operation = receipt.operation;
    const resource = receipt.resource;
    const principalId = receipt.principalId;
    const actor = receipt.actor;
    const sourceGrantIds = receipt.grantIds;
    const leaseEpoch = receipt.leaseEpoch;
    const authorizedAt = receipt.authorizedAt;
    const expiresAt = receipt.expiresAt;
    const reason = receipt.reason;
    if (
      !resource ||
      typeof resource !== 'object' ||
      Array.isArray(resource) ||
      !actor ||
      typeof actor !== 'object' ||
      Array.isArray(actor) ||
      !Array.isArray(sourceGrantIds)
    ) {
      return;
    }
    const actorId = actor.id;
    const actorKind = actor.kind;
    const grantIds = Object.freeze(Array.from(sourceGrantIds));
    return Object.freeze({
      version,
      receiptId,
      requestId,
      decision,
      operation,
      resource: captureResource(resource, 'AxAuthorizationReceipt.resource'),
      principalId,
      actor: Object.freeze({ id: actorId, kind: actorKind }),
      grantIds,
      leaseEpoch,
      authorizedAt,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(reason !== undefined ? { reason } : {}),
    } as AxAuthorizationReceipt);
  } catch {
    return;
  }
}

/**
 * One evidence read per `axAuthorize`. A supplier is what makes `maxAgeMs`
 * usable: the snapshot cache means a frozen `evidence` array only ever ages
 * within a run, while `observeEvidence` re-reads the host's current facts.
 * A supplier that throws or returns malformed data yields no evidence, so every
 * declared requirement fails closed with `missing_observation`.
 */
function resolveEvidence(
  snapshot: Readonly<AxAuthorityContext>
): readonly Readonly<AxEvidenceObservation>[] {
  if (snapshot.observeEvidence) {
    try {
      return captureObservations(
        snapshot.observeEvidence(),
        'AxAuthorityContext.observeEvidence()'
      );
    } catch {
      return EMPTY_EVIDENCE;
    }
  }
  return snapshot.evidence ?? EMPTY_EVIDENCE;
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
  const scopedResource = captureResource(resource, 'authorization resource');
  const now = snapshot.now?.() ?? Date.now();
  // Every other host-supplied number on this path is validated; the clock is
  // load-bearing for grant expiry and for evidence freshness, so a non-finite
  // one is a host misconfiguration and must not reach either check.
  finite(now, 'authorization now');
  if (cancelled(signal)) {
    await audit(
      snapshot,
      {
        operation,
        resourceType: scopedResource.type,
        actorKind: snapshot.actor.kind,
        decision: 'deny',
        grantCount: 0,
        at: now,
        code: 'cancelled',
      },
      signal
    );
    throw new AxAuthorizationDeniedError(
      'cancelled',
      'Authorization cancelled'
    );
  }
  const grants = matchingGrants(snapshot, operation, scopedResource, now);
  if (!grants.length) {
    await audit(
      snapshot,
      {
        operation,
        resourceType: scopedResource.type,
        actorKind: snapshot.actor.kind,
        decision: 'deny',
        grantCount: 0,
        at: now,
        code: 'no_matching_grant',
      },
      signal
    );
    throw new AxAuthorizationDeniedError(
      'no_matching_grant',
      `No active capability grant matches ${operation}`
    );
  }
  // Guards run after a grant matched and before the host authorizer is called,
  // so a guard denial costs zero host calls and emits exactly one audit event.
  // They are deliberately not re-evaluated after the receipt: the receipt is
  // the authority and is already bound to the request context that carried
  // this evidence.
  const evidence = resolveEvidence(snapshot);
  const requirements = axCollectGrantRequirements(grants);
  if (requirements.length) {
    const evaluation = axEvaluateGuards({
      operation,
      resource: scopedResource,
      requirements,
      evidence,
      leaseEpoch: snapshot.leaseEpoch,
      now,
    });
    if (!evaluation.allow) {
      const first = evaluation.failures[0];
      await audit(
        snapshot,
        {
          operation,
          resourceType: scopedResource.type,
          actorKind: snapshot.actor.kind,
          decision: 'deny',
          grantCount: grants.length,
          at: now,
          code: 'guard_predicate_failed',
          // The one bounded exception to redaction-by-construction: operator
          // and fact kind, never an observation value or a source ID.
          ...(first
            ? {
                failedPredicateKind: `${first.op}:${first.kind}`.slice(
                  0,
                  MAX_FAILED_PREDICATE_KIND
                ),
              }
            : {}),
        },
        signal
      );
      throw new AxAuthorizationDeniedError(
        'guard_predicate_failed',
        `Evidence guard failed for ${operation}`
      );
    }
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
          resource: scopedResource,
          grants,
          leaseEpoch: snapshot.leaseEpoch,
          now,
          evidence,
          requirements,
        },
        signal
      )
    );
  } catch (error) {
    if (
      error instanceof AxAuthorizationDeniedError &&
      (error.code === 'cancelled' || error.code === 'timeout')
    ) {
      await audit(
        snapshot,
        {
          operation,
          resourceType: scopedResource.type,
          actorKind: snapshot.actor.kind,
          decision: 'deny',
          grantCount: grants.length,
          at: snapshot.now?.() ?? Date.now(),
          code: error.code,
        },
        signal
      );
    }
    throw error;
  }
  const finishedAt = snapshot.now?.() ?? Date.now();
  const currentGrants = matchingGrants(
    snapshot,
    operation,
    scopedResource,
    finishedAt
  );
  if (
    cancelled(signal) ||
    !receipt ||
    !receiptMatches(
      receipt,
      operation,
      snapshot,
      scopedResource,
      id,
      currentGrants,
      finishedAt
    )
  ) {
    const code = cancelled(signal) ? 'cancelled' : 'invalid_receipt';
    await audit(
      snapshot,
      {
        operation,
        resourceType: scopedResource.type,
        actorKind: snapshot.actor.kind,
        decision: 'deny',
        grantCount: grants.length,
        at: finishedAt,
        code,
      },
      signal
    );
    throw new AxAuthorizationDeniedError(
      code,
      code === 'cancelled'
        ? 'Authorization cancelled'
        : 'Host authorization receipt did not match the exact request'
    );
  }
  const decision = receipt.decision;
  await audit(
    snapshot,
    {
      operation,
      resourceType: scopedResource.type,
      actorKind: snapshot.actor.kind,
      decision,
      grantCount: receipt.grantIds.length,
      at: finishedAt,
      code: decision === 'allow' ? 'authorized' : 'host_denied',
    },
    signal
  );
  if (cancelled(signal)) {
    throw new AxAuthorizationDeniedError(
      'cancelled',
      'Authorization cancelled'
    );
  }
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
  const protocol = fn?.protocol;
  const protocolKind = protocol?.kind;
  const protocolNamespace = protocol?.namespace;
  const protocolName = protocol?.name;
  const componentId = fn?.componentId;
  const functionName = fn?.name;
  const principal = authority?.principal;
  const tenantId = principal?.tenantId;
  if (
    protocol !== undefined &&
    protocolKind !== 'mcp' &&
    protocolKind !== 'ucp'
  ) {
    throw new Error('AxFunction.protocol.kind must be mcp or ucp');
  }
  if (protocol) {
    nonEmpty(protocolNamespace, 'AxFunction.protocol.namespace');
    nonEmpty(protocolName, 'AxFunction.protocol.name');
  }
  const operation =
    protocolKind === 'mcp'
      ? 'mcp.tool.call'
      : protocolKind === 'ucp'
        ? 'ucp.operation.call'
        : componentId?.startsWith('agent:')
          ? 'agent.invoke'
          : 'function.call';
  const type =
    protocolKind === 'mcp'
      ? 'mcp.tool'
      : protocolKind === 'ucp'
        ? 'ucp.operation'
        : operation === 'agent.invoke'
          ? 'agent'
          : 'function';
  const id = protocol
    ? `${protocolNamespace}:${protocolName}`
    : (componentId ?? qualifiedName ?? functionName);
  nonEmpty(id, 'AxFunction authority resource ID');
  return {
    operation,
    resource: {
      type,
      id,
      ...(tenantId ? { tenantId } : {}),
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

/**
 * Contingency may only tighten: a child grant must carry every requirement its
 * parent declared, and may add more. Dropping one would expand the parent's
 * authority just as surely as adding an operation does.
 */
function retainsRequirements(
  parent: Readonly<AxCapabilityGrant>,
  child: Readonly<AxCapabilityGrant>
): boolean {
  const required = parent.requirements ?? [];
  if (!required.length) return true;
  const carried = new Set(
    (child.requirements ?? []).map(evidenceRequirementKey)
  );
  return required.every((requirement) =>
    carried.has(evidenceRequirementKey(requirement))
  );
}

/** The `matchingGrants` predicate minus its time window. See below for why. */
function grantAppliesTo(
  grant: Readonly<AxCapabilityGrant>,
  principalId: string,
  actor: Readonly<AxActor>,
  leaseEpoch: number,
  operation: string,
  resource: Readonly<AxResourceScope>
): boolean {
  return (
    grant.principalId === principalId &&
    grant.leaseEpoch === leaseEpoch &&
    grant.operations.includes(operation) &&
    containsResource(grant, resource) &&
    (grant.actor === undefined ||
      (grant.actor.id === actor.id && grant.actor.kind === actor.kind))
  );
}

/**
 * Requirements are enforced as the union across every grant that matches an
 * operation and resource, so a requirement declared on one grant also
 * constrains a sibling that declared none. The per-grant lineage rule above
 * cannot see that: a child delegating only the unannotated sibling would
 * inherit no contingency at all and would out-authorize its own delegator.
 * This check mirrors the evaluation semantic instead — for every operation and
 * resource a child grant names, the child's union must cover the parent's.
 *
 * The parent side deliberately ignores `issuedAt` / `expiresAt` / `revokedAt`:
 * attenuation has no clock, and counting a grant that may be inactive can only
 * demand more of the child, which is the fail-closed direction.
 */
function retainsUnionRequirements(
  parentSnapshot: Readonly<AxAuthorityContext>,
  childPrincipalId: string,
  childActor: Readonly<AxActor>,
  childGrants: readonly Readonly<AxCapabilityGrant>[]
): boolean {
  const leaseEpoch = parentSnapshot.leaseEpoch;
  for (const grant of childGrants) {
    for (const operation of grant.operations) {
      for (const resource of grant.resources) {
        const required = axCollectGrantRequirements(
          parentSnapshot.grants.filter((candidate) =>
            grantAppliesTo(
              candidate,
              parentSnapshot.principal.id,
              parentSnapshot.actor,
              leaseEpoch,
              operation,
              resource
            )
          )
        );
        if (!required.length) continue;
        const carried = new Set(
          axCollectGrantRequirements(
            childGrants.filter((candidate) =>
              grantAppliesTo(
                candidate,
                childPrincipalId,
                childActor,
                leaseEpoch,
                operation,
                resource
              )
            )
          ).map(evidenceRequirementKey)
        );
        if (
          required.some((entry) => !carried.has(evidenceRequirementKey(entry)))
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

/** Validate and construct a child authority that cannot expand parent grants. */
export function axAttenuateAuthority(
  parent: Readonly<AxAuthorityContext>,
  child: Readonly<AxAuthorityDelegationOptions>
): Readonly<AxAuthorityContext> {
  const parentSnapshot = axSnapshotAuthority(parent);
  const sourcePrincipal = child?.principal;
  const sourceActor = child?.actor;
  const sourceDelegation = child?.delegation;
  const sourceGrants = child?.grants;
  const principalId = sourcePrincipal?.id;
  const tenantId = sourcePrincipal?.tenantId;
  const principalClaims = sourcePrincipal?.claims;
  nonEmpty(principalId, 'AxPrincipal.id');
  if (tenantId !== undefined) nonEmpty(tenantId, 'AxPrincipal.tenantId');
  const capturedPrincipalClaims = captureClaims(
    principalClaims,
    'AxPrincipal.claims'
  );
  const childPrincipal = Object.freeze({
    id: principalId,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(capturedPrincipalClaims ? { claims: capturedPrincipalClaims } : {}),
  });
  const childActor = captureActor(sourceActor, 'AxActor');
  const parentPrincipalId = sourceDelegation?.parentPrincipalId;
  const depth = sourceDelegation?.depth;
  const delegationClaims = sourceDelegation?.claims;
  nonEmpty(parentPrincipalId, 'AxDelegationClaims.parentPrincipalId');
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error('AxDelegationClaims.depth must be a positive integer');
  }
  const capturedDelegationClaims = captureClaims(
    delegationClaims,
    'AxDelegationClaims.claims'
  );
  const childDelegation = Object.freeze({
    parentPrincipalId,
    depth,
    ...(capturedDelegationClaims ? { claims: capturedDelegationClaims } : {}),
  });
  if (!Array.isArray(sourceGrants)) {
    throw new Error('AxAuthorityDelegationOptions.grants must be an array');
  }
  const childGrants = Object.freeze(Array.from(sourceGrants, captureGrant));
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
        (grant.revokedAt === undefined ||
          grant.revokedAt > source.revokedAt)) ||
      !retainsRequirements(source, grant)
    ) {
      throw new Error('Child capability grant expands parent authority');
    }
  }
  if (
    !retainsUnionRequirements(
      parentSnapshot,
      childPrincipal.id,
      childActor,
      childGrants
    )
  ) {
    throw new Error('Child capability grant expands parent authority');
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
    // Without these two, guards and delegation would be mutually exclusive:
    // every inherited requirement would fail with missing_observation.
    evidence: parentSnapshot.evidence,
    observeEvidence: parentSnapshot.observeEvidence,
    onAudit: parentSnapshot.onAudit,
  });
}

/** Utility for typed synthetic claims without giving Ax claim semantics. */
export function axAuthorityClaim(
  type: string,
  value: AxAuthorityValue
): Readonly<AxAuthorityClaim> {
  nonEmpty(type, 'claim[0].type');
  return Object.freeze({
    type,
    value: captureValue(value, 'claim[0].value', new Set()),
  });
}
