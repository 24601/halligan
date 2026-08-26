export type AxGEPACandidateStrategy =
  | 'seed'
  | 'reflective_mutation'
  | 'system_merge';

export type AxGEPACandidateDecision = 'accepted' | 'rejected' | 'aborted';

export type AxGEPACandidateDisposition =
  | 'selected'
  | 'pareto'
  | 'archived'
  | 'rejected'
  | 'aborted';

export interface AxGEPACandidateLineageOptions {
  /** Maximum completed records. Default: 1000; finite values clamp to [1, 10,000]. */
  maxRecords?: number;
  /** Maximum final UTF-8 bytes. Default: 1 MB; finite values clamp to [4096, 10 MB]. */
  maxArtifactBytes?: number;
  /** Maximum changed components. Default: 64; finite values clamp to [1, 1024]. */
  maxComponentsPerCandidate?: number;
  /** Opt in to bounded component values. Values are fingerprinted only by default. */
  includeComponentValues?: boolean;
  /** Opted-in value characters. Default: 200; finite values clamp to [1, 10,000]. */
  maxComponentValueChars?: number;
  /** Opt in to bounded failure messages. Messages are fingerprinted only by default. */
  includeFailureMessages?: boolean;
  /** Opted-in message characters. Default: 200; finite values clamp to [1, 2000]. */
  maxFailureMessageChars?: number;
}

export interface AxGEPACandidateComponentDelta {
  readonly componentId: string;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint: string;
  readonly afterLength: number;
  readonly afterValue?: string;
  readonly valueTruncated?: boolean;
}

export interface AxGEPACandidateEvaluation {
  readonly phase: string;
  readonly objectives: Readonly<Record<string, number>>;
  readonly scalarScore: number;
  readonly metricCallsBefore: number;
  readonly metricCallsAfter: number;
  readonly metricCallBudget: number;
  readonly evaluatedExamples: number;
}

export interface AxGEPACandidateFailure {
  readonly kind: 'runtime' | 'adapter' | 'validator' | 'budget' | 'abort';
  readonly messageFingerprint?: string;
  readonly message?: string;
  readonly messageTruncated?: boolean;
}

export interface AxGEPACandidateLineageRecord {
  readonly id: string;
  readonly parentIds: readonly string[];
  readonly commonAncestorId?: string;
  readonly round: number;
  readonly strategy: AxGEPACandidateStrategy;
  readonly componentDelta: readonly AxGEPACandidateComponentDelta[];
  readonly omittedComponentCount: number;
  readonly evaluations: readonly AxGEPACandidateEvaluation[];
  readonly metricCallsAtDecision: number;
  readonly metricCallBudget: number;
  readonly decision: AxGEPACandidateDecision;
  readonly reason: string;
  readonly disposition: AxGEPACandidateDisposition;
  readonly dispositionReason?: string;
  readonly failures?: readonly AxGEPACandidateFailure[];
}

export interface AxGEPACandidateLineageManifest {
  readonly version: 1;
  readonly records: readonly AxGEPACandidateLineageRecord[];
  readonly maxRecords: number;
  readonly maxArtifactBytes: number;
  readonly omittedRecordCount: number;
  readonly selectedCandidateId?: string;
  readonly selectedCandidateRetained: boolean;
  readonly paretoCandidateIds: readonly string[];
  readonly metricCallsUsed: number;
  readonly metricCallBudget: number;
  readonly stoppedReason:
    | 'in_progress'
    | 'completed'
    | 'budget_exhausted'
    | 'early_stopping'
    | 'aborted';
  readonly termination: {
    readonly phase: string;
    readonly round: number;
    readonly metricCallsUsed: number;
  };
  readonly checkpointSemantics: 'snapshot_only';
  readonly privacy: {
    readonly componentValues: 'fingerprints' | 'bounded_values';
    readonly failureMessages: 'fingerprints' | 'bounded_messages';
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
    return false;
  }
  return Object.values(value).every(
    (child) => !child || typeof child !== 'object' || isDeepFrozen(child)
  );
}

/** Recursively freeze a manifest assembled from fresh publication data. */
export function freezeGEPACandidateLineageManifest(
  manifest: AxGEPACandidateLineageManifest
): AxGEPACandidateLineageManifest {
  return deepFreeze(manifest);
}

/** Clone serialized caller data before recursively freezing it. */
export function cloneAndFreezeGEPACandidateLineageManifest(
  manifest: Readonly<AxGEPACandidateLineageManifest>
): AxGEPACandidateLineageManifest {
  if (isDeepFrozen(manifest)) {
    return manifest as AxGEPACandidateLineageManifest;
  }
  return freezeGEPACandidateLineageManifest(
    JSON.parse(JSON.stringify(manifest)) as AxGEPACandidateLineageManifest
  );
}

export type AxGEPAResolvedLineageOptions =
  Required<AxGEPACandidateLineageOptions>;

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number
): number =>
  Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value!)))
    : fallback;

export function resolveGEPALineageOptions(
  options?: Readonly<AxGEPACandidateLineageOptions>
): AxGEPAResolvedLineageOptions {
  return {
    maxRecords: boundedInteger(options?.maxRecords, 1000, 10_000),
    maxArtifactBytes: Math.max(
      4096,
      boundedInteger(options?.maxArtifactBytes, 1_000_000, 10_000_000)
    ),
    maxComponentsPerCandidate: boundedInteger(
      options?.maxComponentsPerCandidate,
      64,
      1024
    ),
    includeComponentValues: options?.includeComponentValues ?? false,
    maxComponentValueChars: boundedInteger(
      options?.maxComponentValueChars,
      200,
      10_000
    ),
    includeFailureMessages: options?.includeFailureMessages ?? false,
    maxFailureMessageChars: boundedInteger(
      options?.maxFailureMessageChars,
      200,
      2000
    ),
  };
}

/**
 * Stable, browser-safe identifier over UTF-8 bytes.
 * SHA-256 truncated to 64 bits; not a confidentiality control and not a
 * full cryptographic commitment. Default manifests still omit raw values.
 */
export function fingerprintGEPAValue(value: string): string {
  return `sha256-64:${syncSha25664Hex(value)}`;
}

function syncSha25664Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hashed = sha256BytesSync(bytes);
  return Array.from(hashed.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sha256BytesSync(message: Uint8Array): Uint8Array {
  const K = sha256K;
  const bitLen = message.length * 8;
  const withPad = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  withPad.set(message);
  withPad[message.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotRight(w[i - 15]!, 7) ^ rotRight(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 =
        rotRight(w[i - 2]!, 17) ^ rotRight(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotRight(e, 6) ^ rotRight(e, 11) ^ rotRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotRight(a, 2) ^ rotRight(a, 13) ^ rotRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  outView.setUint32(20, h5);
  outView.setUint32(24, h6);
  outView.setUint32(28, h7);
  return out;
}

const rotRight = (value: number, bits: number): number =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0;

const sha256K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function boundedValue(
  value: string,
  maxChars: number
): {
  value: string;
  truncated: boolean;
} {
  return {
    value: value.slice(0, maxChars),
    truncated: value.length > maxChars,
  };
}

export function buildGEPACandidateComponentDelta(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>>,
  options: Readonly<AxGEPAResolvedLineageOptions>
): {
  delta: AxGEPACandidateComponentDelta[];
  omittedComponentCount: number;
} {
  const changedIds = Object.keys(after)
    .filter((componentId) => before?.[componentId] !== after[componentId])
    .sort();
  const retainedIds = changedIds.slice(0, options.maxComponentsPerCandidate);
  return {
    delta: retainedIds.map((componentId) => {
      const afterValue = after[componentId]!;
      const beforeValue = before?.[componentId];
      const bounded = boundedValue(afterValue, options.maxComponentValueChars);
      return {
        componentId,
        beforeFingerprint:
          beforeValue === undefined
            ? undefined
            : fingerprintGEPAValue(beforeValue),
        afterFingerprint: fingerprintGEPAValue(afterValue),
        afterLength: afterValue.length,
        afterValue: options.includeComponentValues ? bounded.value : undefined,
        valueTruncated:
          options.includeComponentValues && bounded.truncated
            ? true
            : undefined,
      };
    }),
    omittedComponentCount: changedIds.length - retainedIds.length,
  };
}

export function buildGEPACandidateFailure(
  kind: AxGEPACandidateFailure['kind'],
  message: string | undefined,
  options: Readonly<AxGEPAResolvedLineageOptions>
): AxGEPACandidateFailure {
  if (!message) return { kind };
  const messageFingerprint = fingerprintGEPAValue(message);
  if (!options.includeFailureMessages) return { kind, messageFingerprint };
  const bounded = boundedValue(message, options.maxFailureMessageChars);
  return {
    kind,
    messageFingerprint,
    message: bounded.value,
    messageTruncated: bounded.truncated ? true : undefined,
  };
}
