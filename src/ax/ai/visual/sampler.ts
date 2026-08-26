import type {
  AxFrameSamplerBudget,
  AxFrameSamplerDecision,
  AxFrameSamplerOptions,
  AxFrameSamplerReason,
  AxVisualAuthority,
  AxVisualChangeDigest,
  AxVisualObservation,
  AxVisualPerceptualInput,
} from './types.js';

const DEFAULT_OPTIONS: AxFrameSamplerOptions = {
  budget: {
    windowMs: 1_000,
    maxFrames: 2,
    maxBytes: 2_000_000,
    maxTokens: 4_000,
  },
  minIntervalMs: 200,
  maxIntervalMs: 2_000,
  changeThreshold: 0.125,
  sceneCutThreshold: 0.5,
  maxObservationAgeMs: 1_000,
  maxFutureSkewMs: 50,
  maxObservationBytes: 10_000_000,
};

type BudgetEntry = {
  atMs: number;
  bytes: number;
  tokens: number;
};

type AuthoritySnapshot = Readonly<{
  sourceId: string;
  streamId: string;
  authority: AxVisualAuthority;
}>;

type ObservationSnapshot = Readonly<{
  frameId: string;
  revision: number;
  freshness: AxVisualObservation['freshness'];
  dimensions: AxVisualObservation['dimensions'];
  mediaType: string;
  byteLength: number;
  tokenEstimate: number;
  digest?: AxVisualChangeDigest;
  perceptualInput?: AxVisualPerceptualInput;
}>;

type IntrinsicGetter = (this: unknown) => unknown;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag
)?.get as IntrinsicGetter | undefined;
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length'
)?.get as IntrinsicGetter | undefined;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset'
)?.get as IntrinsicGetter | undefined;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)?.get as IntrinsicGetter | undefined;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer'
)?.get as IntrinsicGetter | undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)?.get as IntrinsicGetter | undefined;
const sharedArrayBufferByteLengthGetter =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : (Object.getOwnPropertyDescriptor(
        SharedArrayBuffer.prototype,
        'byteLength'
      )?.get as IntrinsicGetter | undefined);

class AxVisualSharedMemoryError extends Error {
  constructor() {
    super('SharedArrayBuffer-backed visual input is unsupported');
    this.name = 'AxVisualSharedMemoryError';
  }
}

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const mergeOptions = (
  options?: Partial<Omit<AxFrameSamplerOptions, 'budget'>> & {
    budget?: Partial<AxFrameSamplerBudget>;
  }
): AxFrameSamplerOptions => ({
  ...DEFAULT_OPTIONS,
  ...options,
  budget: { ...DEFAULT_OPTIONS.budget, ...options?.budget },
});

const validateOptions = (options: AxFrameSamplerOptions): void => {
  if (
    !isPositiveFinite(options.budget.windowMs) ||
    !isNonNegativeInteger(options.budget.maxFrames) ||
    !isNonNegativeInteger(options.budget.maxBytes) ||
    !isNonNegativeInteger(options.budget.maxTokens) ||
    !isNonNegativeInteger(options.minIntervalMs) ||
    !isPositiveFinite(options.maxIntervalMs) ||
    options.maxIntervalMs < options.minIntervalMs ||
    !Number.isFinite(options.changeThreshold) ||
    options.changeThreshold < 0 ||
    options.changeThreshold > 1 ||
    !Number.isFinite(options.sceneCutThreshold) ||
    options.sceneCutThreshold < options.changeThreshold ||
    options.sceneCutThreshold > 1 ||
    !isNonNegativeInteger(options.maxObservationAgeMs) ||
    !isNonNegativeInteger(options.maxFutureSkewMs) ||
    !isNonNegativeInteger(options.maxObservationBytes)
  ) {
    throw new Error('Invalid AxFrameSampler options');
  }
};

export const axVisualPerceptualDigest = (
  input: AxVisualPerceptualInput
): AxVisualChangeDigest => {
  const width = input.width;
  const height = input.height;
  const luma = copyUint8Array(input.luma);
  if (width !== 9 || height !== 8 || !luma || luma.length !== 72) {
    throw new Error('dhash-64 requires a 9 x 8 Uint8Array luminance grid');
  }

  let value = '';
  let nibble = 0;
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      nibble = (nibble << 1) | Number(luma[y * 9 + x]! > luma[y * 9 + x + 1]!);
      bit++;
      if (bit === 4) {
        value += nibble.toString(16);
        nibble = 0;
        bit = 0;
      }
    }
  }
  return Object.freeze({ algorithm: 'dhash-64', value });
};

function copyUint8Array(value: unknown): Uint8Array | undefined {
  if (
    !typedArrayTagGetter ||
    !typedArrayLengthGetter ||
    !typedArrayByteOffsetGetter ||
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter
  ) {
    return undefined;
  }
  if (typedArrayTagGetter.call(value) !== 'Uint8Array') return undefined;
  const length = typedArrayLengthGetter.call(value);
  const byteOffset = typedArrayByteOffsetGetter.call(value);
  const byteLength = typedArrayByteLengthGetter.call(value);
  const buffer = typedArrayBufferGetter.call(value);
  if (sharedArrayBufferByteLengthGetter) {
    try {
      sharedArrayBufferByteLengthGetter.call(buffer);
      throw new AxVisualSharedMemoryError();
    } catch (error) {
      if (error instanceof AxVisualSharedMemoryError) throw error;
    }
  }
  const bufferByteLength = arrayBufferByteLengthGetter?.call(buffer);
  if (
    !isNonNegativeInteger(length) ||
    !isNonNegativeInteger(byteOffset) ||
    !isNonNegativeInteger(byteLength) ||
    !isNonNegativeInteger(bufferByteLength) ||
    byteLength !== length ||
    byteOffset + byteLength > bufferByteLength
  ) {
    return undefined;
  }
  return new Uint8Array(
    new Uint8Array(buffer as ArrayBufferLike, byteOffset, byteLength)
  );
}

const normalizeDigest = (digest: unknown): AxVisualChangeDigest | undefined => {
  if (!digest || typeof digest !== 'object') {
    return undefined;
  }
  const algorithm = 'algorithm' in digest ? digest.algorithm : undefined;
  const value = 'value' in digest ? digest.value : undefined;
  if (
    algorithm !== 'dhash-64' ||
    typeof value !== 'string' ||
    !/^[0-9a-f]{16}$/.test(value)
  ) {
    return undefined;
  }
  return Object.freeze({ algorithm, value });
};

const digestDistance = (
  left: AxVisualChangeDigest,
  right: AxVisualChangeDigest
): number => {
  let changed = 0;
  for (let index = 0; index < 16; index++) {
    const xor =
      Number.parseInt(left.value[index]!, 16) ^
      Number.parseInt(right.value[index]!, 16);
    changed +=
      (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return changed / 64;
};

const observationError = (
  observation: ObservationSnapshot,
  nowMs: number,
  maxBytes: number
): AxFrameSamplerReason | undefined => {
  const { freshness, dimensions } = observation;
  if (
    !freshness ||
    typeof freshness !== 'object' ||
    !dimensions ||
    typeof dimensions !== 'object' ||
    typeof observation.frameId !== 'string' ||
    !observation.frameId ||
    !isNonNegativeInteger(observation.revision) ||
    !isNonNegativeInteger(observation.byteLength) ||
    !isNonNegativeInteger(observation.tokenEstimate) ||
    !isPositiveFinite(dimensions.width) ||
    !isPositiveFinite(dimensions.height) ||
    typeof observation.mediaType !== 'string' ||
    !observation.mediaType.startsWith('image/') ||
    !Number.isFinite(freshness.capturedAtMs) ||
    !Number.isFinite(freshness.observedAtMs) ||
    !Number.isFinite(freshness.expiresAtMs) ||
    freshness.observedAtMs < freshness.capturedAtMs ||
    freshness.expiresAtMs < freshness.capturedAtMs ||
    !Number.isFinite(nowMs) ||
    (!observation.digest && !observation.perceptualInput)
  ) {
    return 'malformed';
  }
  if (observation.byteLength > maxBytes) return 'oversized';
  return undefined;
};

const normalizeAuthority = (
  observation: AuthoritySnapshot
): AxVisualAuthority | undefined => {
  const authority = observation.authority;
  if (!authority || typeof authority !== 'object') return undefined;
  const revision = authority.revision;
  const authorityRef = authority.authorityRef;
  const consentRef = authority.consentRef;
  const revoked = authority.revoked;
  if (
    !isNonNegativeInteger(revision) ||
    typeof authorityRef !== 'string' ||
    !authorityRef ||
    typeof consentRef !== 'string' ||
    !consentRef ||
    (revoked !== undefined && typeof revoked !== 'boolean')
  ) {
    return undefined;
  }
  return Object.freeze({ authorityRef, consentRef, revision, revoked });
};

const snapshotAuthority = (
  observation: AxVisualObservation
): AuthoritySnapshot => {
  const sourceId = observation.sourceId;
  const streamId = observation.streamId;
  const authority = observation.authority;
  const authoritySnapshot =
    authority && typeof authority === 'object'
      ? Object.freeze({
          authorityRef: authority.authorityRef,
          consentRef: authority.consentRef,
          revision: authority.revision,
          revoked: authority.revoked,
        })
      : authority;
  return Object.freeze({
    sourceId,
    streamId,
    authority: authoritySnapshot,
  });
};

const snapshotObservation = (
  observation: AxVisualObservation
): ObservationSnapshot => {
  const freshness = observation.freshness;
  const dimensions = observation.dimensions;
  const digest = observation.digest;
  const perceptualInput = observation.perceptualInput;
  return Object.freeze({
    frameId: observation.frameId,
    revision: observation.revision,
    freshness: Object.freeze({
      capturedAtMs: freshness.capturedAtMs,
      observedAtMs: freshness.observedAtMs,
      expiresAtMs: freshness.expiresAtMs,
    }),
    dimensions: Object.freeze({
      width: dimensions.width,
      height: dimensions.height,
    }),
    mediaType: observation.mediaType,
    byteLength: observation.byteLength,
    tokenEstimate: observation.tokenEstimate,
    digest:
      digest === undefined
        ? undefined
        : Object.freeze({
            algorithm: digest.algorithm,
            value: digest.value,
          }),
    perceptualInput:
      perceptualInput === undefined
        ? undefined
        : Object.freeze({
            width: perceptualInput.width,
            height: perceptualInput.height,
            luma: copyUint8Array(perceptualInput.luma) as Uint8Array,
          }),
  });
};

/**
 * Stateful, single-stream visual sampling policy. The host owns capture, payloads,
 * clocks, consent decisions, and model calls; the sampler retains metadata only.
 */
export class AxFrameSampler {
  readonly options: AxFrameSamplerOptions;
  private stream?: { sourceId: string; streamId: string };
  private latestRevision = -1;
  private authorityRevision = -1;
  private authorityRevoked = false;
  private latestClockMs?: number;
  private lastSampleAtMs?: number;
  private lastDigest?: AxVisualChangeDigest;
  private budgetEntries: BudgetEntry[] = [];

  constructor(
    options?: Partial<Omit<AxFrameSamplerOptions, 'budget'>> & {
      budget?: Partial<AxFrameSamplerBudget>;
    }
  ) {
    const merged = mergeOptions(options);
    validateOptions(merged);
    this.options = Object.freeze({
      ...merged,
      budget: Object.freeze({ ...merged.budget }),
    });
  }

  observe(
    observation: AxVisualObservation,
    nowMs?: number
  ): AxFrameSamplerDecision {
    try {
      return this.observeInternal(observation, nowMs);
    } catch (error) {
      return this.decision(
        'suppress',
        error instanceof AxVisualSharedMemoryError
          ? 'shared_memory'
          : 'malformed'
      );
    }
  }

  private observeInternal(
    observation: AxVisualObservation,
    nowMs?: number
  ): AxFrameSamplerDecision {
    const authoritySnapshot = snapshotAuthority(observation);
    const authority = normalizeAuthority(authoritySnapshot);
    if (!authority) return this.decision('suppress', 'malformed');

    const { sourceId, streamId } = authoritySnapshot;
    if (
      typeof sourceId !== 'string' ||
      !sourceId ||
      typeof streamId !== 'string' ||
      !streamId
    ) {
      return this.decision('suppress', 'malformed');
    }

    if (
      this.stream &&
      (this.stream.sourceId !== sourceId || this.stream.streamId !== streamId)
    ) {
      return this.decision('suppress', 'stream_mismatch');
    }
    if (authority.revision < this.authorityRevision) {
      return this.decision('suppress', 'stale_authority');
    }
    if (authority.revision > this.authorityRevision) {
      this.authorityRevision = authority.revision;
      this.authorityRevoked = authority.revoked === true;
    } else if (authority.revoked) {
      this.authorityRevoked = true;
    }
    if (this.authorityRevoked || authority.revoked) {
      return this.decision('suppress', 'revoked');
    }

    const snapshot = snapshotObservation(observation);
    const resolvedNowMs = nowMs ?? snapshot.freshness.observedAtMs;
    const malformed = observationError(
      snapshot,
      resolvedNowMs,
      this.options.maxObservationBytes
    );
    if (malformed) return this.decision('suppress', malformed);

    const age = resolvedNowMs - snapshot.freshness.capturedAtMs;
    if (
      age < -this.options.maxFutureSkewMs ||
      resolvedNowMs - snapshot.freshness.observedAtMs <
        -this.options.maxFutureSkewMs
    ) {
      return this.decision('suppress', 'future_time');
    }
    if (age > this.options.maxObservationAgeMs) {
      return this.decision('suppress', 'stale_time');
    }
    if (resolvedNowMs > snapshot.freshness.expiresAtMs) {
      return this.decision('suppress', 'expired');
    }

    let digest: AxVisualChangeDigest;
    try {
      const suppliedDigest = snapshot.digest;
      if (suppliedDigest !== undefined) {
        const normalized = normalizeDigest(suppliedDigest);
        if (!normalized) return this.decision('suppress', 'malformed');
        digest = normalized;
      } else {
        digest = axVisualPerceptualDigest(snapshot.perceptualInput!);
      }
    } catch {
      return this.decision('suppress', 'malformed');
    }
    if (!digest) return this.decision('suppress', 'malformed');
    if (snapshot.revision <= this.latestRevision) {
      return this.decision('suppress', 'stale_revision');
    }
    if (
      this.latestClockMs !== undefined &&
      resolvedNowMs < this.latestClockMs
    ) {
      this.latestClockMs = resolvedNowMs;
      this.lastSampleAtMs = undefined;
      this.budgetEntries = [];
      return this.decision('suppress', 'clock_rollback');
    }
    this.latestClockMs = resolvedNowMs;
    this.pruneBudget(resolvedNowMs);

    const changeScore = this.lastDigest
      ? digestDistance(this.lastDigest, digest)
      : undefined;
    const elapsed =
      this.lastSampleAtMs === undefined
        ? undefined
        : resolvedNowMs - this.lastSampleAtMs;

    let action: AxFrameSamplerDecision['action'];
    let reason: AxFrameSamplerReason;
    if (!this.lastDigest) {
      action = 'sample';
      reason = 'initial';
    } else if (changeScore! >= this.options.sceneCutThreshold) {
      action = 'change-trigger';
      reason = 'scene_cut';
    } else if (
      changeScore! >= this.options.changeThreshold &&
      elapsed! >= this.options.minIntervalMs
    ) {
      action = 'change-trigger';
      reason = 'change';
    } else if (elapsed! >= this.options.maxIntervalMs) {
      action = 'sample';
      reason = 'max_interval';
    } else {
      this.latestRevision = snapshot.revision;
      return this.decision(
        'suppress',
        changeScore! >= this.options.changeThreshold
          ? 'min_interval'
          : 'unchanged',
        digest,
        changeScore
      );
    }

    const budgetReason = this.budgetReason(snapshot);
    if (budgetReason) {
      return this.decision('suppress', budgetReason, digest, changeScore);
    }

    this.stream ??= {
      sourceId,
      streamId,
    };
    this.latestRevision = snapshot.revision;
    this.lastDigest = digest;
    this.lastSampleAtMs = resolvedNowMs;
    this.budgetEntries.push({
      atMs: resolvedNowMs,
      bytes: snapshot.byteLength,
      tokens: snapshot.tokenEstimate,
    });
    return this.decision(action, reason, digest, changeScore);
  }

  private pruneBudget(nowMs: number): void {
    const earliest = nowMs - this.options.budget.windowMs;
    this.budgetEntries = this.budgetEntries.filter(
      (entry) => entry.atMs > earliest
    );
  }

  private usage(): { frames: number; bytes: number; tokens: number } {
    return this.budgetEntries.reduce(
      (total, entry) => ({
        frames: total.frames + 1,
        bytes: total.bytes + entry.bytes,
        tokens: total.tokens + entry.tokens,
      }),
      { frames: 0, bytes: 0, tokens: 0 }
    );
  }

  private budgetReason(
    observation: ObservationSnapshot
  ): AxFrameSamplerReason | undefined {
    const usage = this.usage();
    if (usage.frames + 1 > this.options.budget.maxFrames)
      return 'budget_frames';
    if (usage.bytes + observation.byteLength > this.options.budget.maxBytes)
      return 'budget_bytes';
    if (
      usage.tokens + observation.tokenEstimate >
      this.options.budget.maxTokens
    )
      return 'budget_tokens';
    return undefined;
  }

  private decision(
    action: AxFrameSamplerDecision['action'],
    reason: AxFrameSamplerReason,
    digest?: AxVisualChangeDigest,
    changeScore?: number
  ): AxFrameSamplerDecision {
    const publishedDigest = digest
      ? Object.freeze({ algorithm: digest.algorithm, value: digest.value })
      : undefined;
    return Object.freeze({
      action,
      reason,
      digest: publishedDigest,
      changeScore,
      budget: Object.freeze(this.usage()),
    });
  }
}

export const axFrameSampler = (
  options?: ConstructorParameters<typeof AxFrameSampler>[0]
): AxFrameSampler => new AxFrameSampler(options);
