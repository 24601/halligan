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

/** Stable, browser-safe fingerprint. It is an identifier, not a cryptographic digest. */
export function fingerprintGEPAValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

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
  const bounded = boundedValue(message, options.maxFailureMessageChars);
  return {
    kind,
    messageFingerprint: fingerprintGEPAValue(message),
    message: options.includeFailureMessages ? bounded.value : undefined,
    messageTruncated:
      options.includeFailureMessages && bounded.truncated ? true : undefined,
  };
}
