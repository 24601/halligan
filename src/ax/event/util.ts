import type {
  AxEventEffect,
  AxEventEffectCreateRequest,
  AxEventEffectTransition,
  AxEventEnvelope,
  AxEventIdentity,
  AxEventIngress,
  AxEventMatcher,
  AxEventScalar,
  AxEventValue,
} from './types.js';

export const AX_EVENT_EFFECT_METADATA_MAX_BYTES = 16 * 1024;
export const AX_EVENT_EFFECT_RECEIPT_MAX_BYTES = 64 * 1024;
const EVENT_EFFECT_TEXT_MAX_BYTES = 4 * 1024;

let fallbackId = 0;

export function axEventId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return `${prefix}-${randomUUID ? randomUUID() : `${Date.now()}-${++fallbackId}`}`;
}

export function axEventIdentityScope(
  identity: Readonly<AxEventIdentity> | undefined
): string {
  if (!identity) return 'anonymous';
  const values = [
    identity.tenantId ?? '',
    identity.accountId ?? '',
    identity.userId ?? '',
    identity.sessionId ?? '',
  ];
  return values.some(Boolean)
    ? values.map(encodeURIComponent).join('/')
    : 'anonymous';
}

export function axEventScopedDedupeKey(
  ingress: Readonly<AxEventIngress>
): string {
  return `${axEventIdentityScope(ingress.identity)}\n${ingress.event.source}\n${ingress.event.id}`;
}

/** Canonical JSON bytes used to bind an accepted event identity to its envelope. */
export function axEventIngressFingerprint(
  ingress: Readonly<AxEventIngress>
): string {
  return canonicalJson(ingress);
}

export function axEventScopedCorrelationKey(
  identityScope: string,
  kind: string,
  value: string
): string {
  return `${identityScope}\n${kind}\n${value}`;
}

function assertPersistable(
  value: unknown,
  path: string,
  seen: Set<object>
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Event value at ${path} must be a finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Event value at ${path} is not persistable`);
  }
  if (seen.has(value)) throw new Error(`Event value at ${path} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertPersistable(item, `${path}[${index}]`, seen)
    );
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`Event value at ${path} must be a plain object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertPersistable(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function axValidateEventEnvelope(
  envelope: Readonly<AxEventEnvelope<unknown>>
): asserts envelope is Readonly<AxEventEnvelope<AxEventValue>> {
  if (envelope.specversion !== '1.0') {
    throw new Error('AxEventEnvelope.specversion must be "1.0"');
  }
  for (const field of ['id', 'source', 'type'] as const) {
    if (!envelope[field]?.trim()) {
      throw new Error(`AxEventEnvelope.${field} must be a non-empty string`);
    }
  }
  if (envelope.time && !Number.isFinite(Date.parse(envelope.time))) {
    throw new Error('AxEventEnvelope.time must be an ISO-8601 timestamp');
  }
  if (envelope.data !== undefined) {
    assertPersistable(envelope.data, 'data', new Set());
  }
  if (envelope.extensions !== undefined) {
    assertPersistable(envelope.extensions, 'extensions', new Set());
  }
}

export function axEventSizeBytes(ingress: Readonly<AxEventIngress>): number {
  const json = JSON.stringify(ingress);
  return new TextEncoder().encode(json).byteLength;
}

function axEventValueSizeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateBoundedEffectValue(
  value: unknown,
  field: string,
  maximum: number
): void {
  assertPersistable(value, field, new Set());
  const bytes = axEventValueSizeBytes(value);
  if (bytes > maximum) {
    throw new Error(
      `AxEventEffect.${field} is ${bytes} bytes; maximum is ${maximum}`
    );
  }
}

function validateBoundedEffectText(value: string, field: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > EVENT_EFFECT_TEXT_MAX_BYTES) {
    throw new Error(
      `AxEventEffect.${field} is ${bytes} bytes; maximum is ${EVENT_EFFECT_TEXT_MAX_BYTES}`
    );
  }
}

export function axValidateEventEffectCreateRequest(
  request: Readonly<AxEventEffectCreateRequest>
): void {
  for (const field of [
    'id',
    'deliveryId',
    'runId',
    'identityScope',
    'operation',
    'idempotencyKey',
  ] as const) {
    if (!request[field].trim()) {
      throw new Error(`AxEventEffect.${field} must be a non-empty string`);
    }
    validateBoundedEffectText(request[field], field);
  }
  if (
    request.replaySafety !== undefined &&
    request.replaySafety !== 'idempotent' &&
    request.replaySafety !== 'unknown'
  ) {
    throw new Error('AxEventEffect.replaySafety is invalid');
  }
  if (request.metadata !== undefined) {
    validateBoundedEffectValue(
      request.metadata,
      'metadata',
      AX_EVENT_EFFECT_METADATA_MAX_BYTES
    );
  }
}

/**
 * Binds an effect identity to its canonical, redacted request descriptor.
 * The digest deliberately excludes delivery/run ids and timestamps so replay
 * can declare the same logical effect from a replacement run.
 */
export async function axEventEffectRequestDigest(
  request: Readonly<AxEventEffectCreateRequest>
): Promise<string> {
  const bytes = new TextEncoder().encode(
    axEventEffectRequestFingerprint(request)
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

/** Canonical bytes hashed by {@link axEventEffectRequestDigest}. */
export function axEventEffectRequestFingerprint(
  request: Readonly<AxEventEffectCreateRequest>
): string {
  return canonicalJson({
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
    replaySafety: request.replaySafety ?? 'unknown',
    metadata: request.metadata ?? null,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`;
}

export function axApplyEventEffectTransition(
  effect: Readonly<AxEventEffect>,
  transition: Readonly<AxEventEffectTransition>
): AxEventEffect {
  if (!Number.isFinite(transition.at) || transition.at < effect.createdAt) {
    throw new Error(`Invalid transition time for event effect ${effect.id}`);
  }
  if (transition.type === 'dispatched') {
    if (effect.status !== 'intent' && effect.status !== 'dispatched') {
      throw new Error(
        `Illegal event effect transition ${effect.status} -> dispatched`
      );
    }
    return {
      ...effect,
      status: 'dispatched',
      dispatchedAt: transition.at,
      updatedAt: transition.at,
      dispatchCount: effect.dispatchCount + 1,
      version: effect.version + 1,
    };
  }
  if (transition.type === 'settled') {
    const { settlement } = transition;
    if (settlement.receipt !== undefined) {
      validateBoundedEffectValue(
        settlement.receipt,
        'receipt',
        AX_EVENT_EFFECT_RECEIPT_MAX_BYTES
      );
    }
    if (settlement.status === 'failed' && settlement.error !== undefined) {
      validateBoundedEffectText(settlement.error, 'error');
    }
    if (effect.status === 'succeeded' || effect.status === 'failed') {
      const same =
        effect.status === settlement.status &&
        JSON.stringify(effect.receipt) === JSON.stringify(settlement.receipt) &&
        effect.error ===
          (settlement.status === 'failed' ? settlement.error : undefined);
      if (same) return structuredClone(effect);
      throw new Error(
        `Event effect ${effect.id} already settled as ${effect.status}`
      );
    }
    if (
      effect.status !== 'intent' &&
      effect.status !== 'dispatched' &&
      effect.status !== 'parked'
    ) {
      throw new Error(
        `Illegal event effect transition ${effect.status} -> ${settlement.status}`
      );
    }
    return {
      ...effect,
      status: settlement.status,
      ...(settlement.receipt !== undefined
        ? { receipt: structuredClone(settlement.receipt) }
        : {}),
      ...(settlement.status === 'failed' && settlement.error
        ? { error: settlement.error }
        : {}),
      parkedReason: undefined,
      settledAt: transition.at,
      updatedAt: transition.at,
      version: effect.version + 1,
    };
  }
  if (transition.type === 'parked') {
    if (
      effect.status !== 'intent' &&
      effect.status !== 'dispatched' &&
      effect.status !== 'parked'
    ) {
      throw new Error(
        `Illegal event effect transition ${effect.status} -> parked`
      );
    }
    if (!transition.reason.trim()) {
      throw new Error('Parked event effects require a reason');
    }
    validateBoundedEffectText(transition.reason, 'parkedReason');
    if (
      effect.status === 'parked' &&
      effect.parkedReason === transition.reason
    ) {
      return structuredClone(effect);
    }
    return {
      ...effect,
      status: 'parked',
      parkedReason: transition.reason,
      updatedAt: transition.at,
      version: effect.version + 1,
    };
  }
  if (effect.status !== 'dispatched' && effect.status !== 'parked') {
    throw new Error(
      `Illegal event effect transition ${effect.status} -> intent`
    );
  }
  return {
    ...effect,
    status: 'intent',
    parkedReason: undefined,
    updatedAt: transition.at,
    version: effect.version + 1,
  };
}

function matchesList(
  value: string | undefined,
  list: readonly string[] | undefined
) {
  return !list || (value !== undefined && list.includes(value));
}

export function axEventMatches(
  ingress: Readonly<AxEventIngress>,
  matcher: Readonly<AxEventMatcher>
): boolean {
  const event = ingress.event;
  if (!matchesList(event.source, matcher.sources)) return false;
  if (!matchesList(event.type, matcher.types)) return false;
  if (!matchesList(event.subject, matcher.subjects)) return false;
  for (const [key, expected] of Object.entries(matcher.extensions ?? {})) {
    const actual: AxEventScalar | undefined = event.extensions?.[key];
    if (actual !== expected) return false;
  }
  return true;
}

export function axEventErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
