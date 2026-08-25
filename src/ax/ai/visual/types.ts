/** Opaque host-owned authority references. Ax compares only their revision. */
export type AxVisualAuthority = Readonly<{
  authorityRef: string;
  consentRef: string;
  revision: number;
  revoked?: boolean;
}>;

/** A 64-bit difference hash over a host-normalized 9 × 8 luminance grid. */
export type AxVisualChangeDigest = Readonly<{
  algorithm: 'dhash-64';
  value: string;
}>;

/**
 * Host-normalized luminance used when the host does not supply a digest.
 * This is not an encoded image and Ax does not capture, decode, or render it.
 */
export type AxVisualPerceptualInput = Readonly<{
  width: 9;
  height: 8;
  luma: Uint8Array;
}>;

/** Metadata for one host-captured frame candidate. The frame payload stays with the host. */
export type AxVisualObservation = Readonly<{
  sourceId: string;
  streamId: string;
  frameId: string;
  revision: number;
  freshness: Readonly<{
    capturedAtMs: number;
    observedAtMs: number;
    expiresAtMs: number;
  }>;
  dimensions: Readonly<{
    width: number;
    height: number;
  }>;
  mediaType: string;
  byteLength: number;
  tokenEstimate: number;
  authority: AxVisualAuthority;
  digest?: AxVisualChangeDigest;
  perceptualInput?: AxVisualPerceptualInput;
}>;

export type AxFrameSamplerBudget = Readonly<{
  /** Rolling accounting window. */
  windowMs: number;
  maxFrames: number;
  maxBytes: number;
  maxTokens: number;
}>;

export type AxFrameSamplerOptions = Readonly<{
  budget: AxFrameSamplerBudget;
  /** Minimum time between ordinary change-triggered samples. Scene cuts bypass it. */
  minIntervalMs: number;
  /** Sample a valid frame after this interval even if its digest is unchanged. */
  maxIntervalMs: number;
  /** Normalized Hamming distance in [0, 1]. */
  changeThreshold: number;
  /** Normalized Hamming distance in [changeThreshold, 1]. */
  sceneCutThreshold: number;
  maxObservationAgeMs: number;
  maxFutureSkewMs: number;
  maxObservationBytes: number;
}>;

export type AxFrameSamplerReason =
  | 'initial'
  | 'change'
  | 'scene_cut'
  | 'max_interval'
  | 'unchanged'
  | 'min_interval'
  | 'budget_frames'
  | 'budget_bytes'
  | 'budget_tokens'
  | 'stale_revision'
  | 'stale_authority'
  | 'stale_time'
  | 'future_time'
  | 'expired'
  | 'revoked'
  | 'oversized'
  | 'malformed'
  | 'stream_mismatch';

export type AxFrameSamplerDecision = Readonly<{
  action: 'sample' | 'suppress' | 'change-trigger';
  reason: AxFrameSamplerReason;
  digest?: AxVisualChangeDigest;
  changeScore?: number;
  budget: Readonly<{
    frames: number;
    bytes: number;
    tokens: number;
  }>;
}>;
