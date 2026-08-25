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

const isNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

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
  if (
    input.width !== 9 ||
    input.height !== 8 ||
    !ArrayBuffer.isView(input.luma) ||
    Object.prototype.toString.call(input.luma) !== '[object Uint8Array]' ||
    input.luma.length !== 72
  ) {
    throw new Error('dhash-64 requires a 9 x 8 Uint8Array luminance grid');
  }

  let value = '';
  let nibble = 0;
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      nibble =
        (nibble << 1) |
        Number(input.luma[y * 9 + x]! > input.luma[y * 9 + x + 1]!);
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
  observation: AxVisualObservation | null | undefined,
  nowMs: number,
  maxBytes: number
): AxFrameSamplerReason | undefined => {
  if (!observation || typeof observation !== 'object') return 'malformed';
  const { freshness, dimensions } = observation;
  if (
    !freshness ||
    typeof freshness !== 'object' ||
    !dimensions ||
    typeof dimensions !== 'object' ||
    typeof observation.sourceId !== 'string' ||
    !observation.sourceId ||
    typeof observation.streamId !== 'string' ||
    !observation.streamId ||
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
  observation: AxVisualObservation | null | undefined
): AxVisualAuthority | undefined => {
  if (!observation || typeof observation !== 'object') return undefined;
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
    this.options = mergeOptions(options);
    validateOptions(this.options);
  }

  observe(
    observation: AxVisualObservation,
    nowMs?: number
  ): AxFrameSamplerDecision {
    try {
      return this.observeInternal(observation, nowMs);
    } catch {
      return this.decision('suppress', 'malformed');
    }
  }

  private observeInternal(
    observation: AxVisualObservation,
    nowMs?: number
  ): AxFrameSamplerDecision {
    const resolvedNowMs =
      nowMs ?? observation?.freshness?.observedAtMs ?? Number.NaN;
    const authority = normalizeAuthority(observation);
    if (!authority) return this.decision('suppress', 'malformed');

    if (
      this.stream &&
      (this.stream.sourceId !== observation.sourceId ||
        this.stream.streamId !== observation.streamId)
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

    const malformed = observationError(
      observation,
      resolvedNowMs,
      this.options.maxObservationBytes
    );
    if (malformed) return this.decision('suppress', malformed);

    const age = resolvedNowMs - observation.freshness.capturedAtMs;
    if (
      age < -this.options.maxFutureSkewMs ||
      resolvedNowMs - observation.freshness.observedAtMs <
        -this.options.maxFutureSkewMs
    ) {
      return this.decision('suppress', 'future_time');
    }
    if (age > this.options.maxObservationAgeMs) {
      return this.decision('suppress', 'stale_time');
    }
    if (resolvedNowMs > observation.freshness.expiresAtMs) {
      return this.decision('suppress', 'expired');
    }

    let digest: AxVisualChangeDigest;
    try {
      const suppliedDigest = observation.digest;
      if (suppliedDigest !== undefined) {
        const normalized = normalizeDigest(suppliedDigest);
        if (!normalized) return this.decision('suppress', 'malformed');
        digest = normalized;
      } else {
        digest = axVisualPerceptualDigest(observation.perceptualInput!);
      }
    } catch {
      return this.decision('suppress', 'malformed');
    }
    if (!digest) return this.decision('suppress', 'malformed');
    if (observation.revision <= this.latestRevision) {
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
      this.latestRevision = observation.revision;
      return this.decision(
        'suppress',
        changeScore! >= this.options.changeThreshold
          ? 'min_interval'
          : 'unchanged',
        digest,
        changeScore
      );
    }

    const budgetReason = this.budgetReason(observation);
    if (budgetReason) {
      return this.decision('suppress', budgetReason, digest, changeScore);
    }

    this.stream ??= {
      sourceId: observation.sourceId,
      streamId: observation.streamId,
    };
    this.latestRevision = observation.revision;
    this.lastDigest = digest;
    this.lastSampleAtMs = resolvedNowMs;
    this.budgetEntries.push({
      atMs: resolvedNowMs,
      bytes: observation.byteLength,
      tokens: observation.tokenEstimate,
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
    observation: AxVisualObservation
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
