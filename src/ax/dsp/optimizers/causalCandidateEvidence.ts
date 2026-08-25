export type AxCausalEvidenceKind =
  | 'failure'
  | 'trace'
  | 'feedback'
  | 'evaluation';

export interface AxCausalEvidenceReference {
  readonly id: string;
  readonly kind: AxCausalEvidenceKind;
  /** Caller-computed identifier for the source evidence; raw evidence is not retained. */
  readonly fingerprint: string;
  /** Optional bounded description, retained only when explicitly enabled. */
  readonly summary?: string;
}

export interface AxCausalAffectedComponent {
  readonly componentId: string;
  readonly surface: string;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint: string;
}

export interface AxCausalMetricPrediction {
  readonly metric: string;
  readonly split: 'held_in' | 'held_out';
  readonly expectedDirection: 'increase' | 'decrease' | 'unchanged';
  readonly minimumExpectedDelta?: number;
  readonly confidence?: number;
}

export interface AxCausalMetricOutcome {
  readonly metric: string;
  readonly before: number;
  readonly after: number;
  readonly sampleCount: number;
}

export interface AxCausalCandidateSplitOutcome {
  readonly metrics: readonly AxCausalMetricOutcome[];
}

export interface AxCausalCandidateAblation {
  readonly kind: 'ablation' | 'counterfactual';
  readonly removedComponentIds: readonly string[];
  readonly heldIn: AxCausalCandidateSplitOutcome;
  readonly heldOut: AxCausalCandidateSplitOutcome;
  readonly attribution: 'supports' | 'contradicts' | 'inconclusive';
  readonly summary?: string;
}

/**
 * Host-authored causal claim and evaluator receipt for one mutable candidate.
 * Ax records the claim; it does not infer that the hypothesis is true.
 */
export interface AxCausalCandidateEvidenceRecord {
  readonly id: string;
  /** May reference an optimizer-specific candidate/lineage ID when one exists. */
  readonly candidateId?: string;
  readonly evidence: readonly AxCausalEvidenceReference[];
  readonly hypothesis: string;
  readonly affectedComponents: readonly AxCausalAffectedComponent[];
  readonly predictedBenefit: readonly AxCausalMetricPrediction[];
  /** Explicitly empty means no regression was predicted. */
  readonly predictedRegressions: readonly AxCausalMetricPrediction[];
  readonly outcome: {
    readonly heldIn: AxCausalCandidateSplitOutcome;
    readonly heldOut: AxCausalCandidateSplitOutcome;
  };
  readonly decision: {
    readonly status: 'promoted' | 'rejected';
    readonly reason: string;
  };
  readonly ablation?: AxCausalCandidateAblation;
}

export interface AxCausalCandidateEvidenceManifest {
  readonly version: 1;
  readonly records: readonly AxCausalCandidateEvidenceRecord[];
  readonly omittedRecordCount: number;
  readonly maxRecords: number;
  readonly maxArtifactBytes: number;
  readonly privacy: {
    readonly rawEvidenceRetained: false;
    readonly evidenceSummaries: 'omitted' | 'bounded';
    readonly maxSummaryChars: number;
  };
  readonly authority: 'host_supplied';
}

export interface AxCausalCandidateEvidenceOptions {
  /** Maximum records retained, preserving input order. Default: 100. */
  maxRecords?: number;
  /** Maximum UTF-8 serialized manifest size. Default: 256 KiB. */
  maxArtifactBytes?: number;
  /** Opt in to bounded evidence and ablation summaries. Default: false. */
  includeEvidenceSummaries?: boolean;
  /** Maximum retained characters per opted-in summary. Default: 200. */
  maxSummaryChars?: number;
}

const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;
const DEFAULT_MAX_SUMMARY_CHARS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_ITEMS_PER_FIELD = 64;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value!)))
    : fallback;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > MAX_TEXT_CHARS) {
    throw new Error(`${field} exceeds ${MAX_TEXT_CHARS} characters`);
  }
  return normalized;
}

function requiredFingerprint(value: string, field: string): string {
  const normalized = requiredText(value, field);
  if (
    !/^(fnv1a32:[0-9a-f]{8}|sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128}|blake3:[0-9a-f]{64})$/.test(
      normalized
    )
  ) {
    throw new Error(`${field} must use a supported digest fingerprint`);
  }
  return normalized;
}

function oneOf<T extends string>(
  value: T,
  allowed: readonly T[],
  field: string
): T {
  if (!allowed.includes(value)) {
    throw new Error(`${field} has an unsupported value`);
  }
  return value;
}

function boundedArray<T>(values: readonly T[], field: string): readonly T[] {
  if (values.length === 0) throw new Error(`${field} must not be empty`);
  if (values.length > MAX_ITEMS_PER_FIELD) {
    throw new Error(`${field} exceeds ${MAX_ITEMS_PER_FIELD} items`);
  }
  return values;
}

function normalizeMetricOutcome(
  outcome: Readonly<AxCausalMetricOutcome>,
  field: string
): AxCausalMetricOutcome {
  if (
    !Number.isFinite(outcome.before) ||
    !Number.isFinite(outcome.after) ||
    !Number.isInteger(outcome.sampleCount) ||
    outcome.sampleCount <= 0
  ) {
    throw new Error(
      `${field} requires finite scores and a positive sampleCount`
    );
  }
  return {
    metric: requiredText(outcome.metric, `${field}.metric`),
    before: outcome.before,
    after: outcome.after,
    sampleCount: outcome.sampleCount,
  };
}

function normalizeSplit(
  split: Readonly<AxCausalCandidateSplitOutcome>,
  field: string
): AxCausalCandidateSplitOutcome {
  return {
    metrics: boundedArray(split.metrics, `${field}.metrics`).map(
      (metric, index) =>
        normalizeMetricOutcome(metric, `${field}.metrics[${index}]`)
    ),
  };
}

function normalizePrediction(
  prediction: Readonly<AxCausalMetricPrediction>,
  field: string
): AxCausalMetricPrediction {
  if (
    prediction.minimumExpectedDelta !== undefined &&
    !Number.isFinite(prediction.minimumExpectedDelta)
  ) {
    throw new Error(`${field}.minimumExpectedDelta must be finite`);
  }
  if (
    prediction.confidence !== undefined &&
    (!Number.isFinite(prediction.confidence) ||
      prediction.confidence < 0 ||
      prediction.confidence > 1)
  ) {
    throw new Error(`${field}.confidence must be between 0 and 1`);
  }
  return {
    metric: requiredText(prediction.metric, `${field}.metric`),
    split: oneOf(prediction.split, ['held_in', 'held_out'], `${field}.split`),
    expectedDirection: oneOf(
      prediction.expectedDirection,
      ['increase', 'decrease', 'unchanged'],
      `${field}.expectedDirection`
    ),
    minimumExpectedDelta: prediction.minimumExpectedDelta,
    confidence: prediction.confidence,
  };
}

function normalizeRecord(
  record: Readonly<AxCausalCandidateEvidenceRecord>,
  options: Readonly<Required<AxCausalCandidateEvidenceOptions>>
): AxCausalCandidateEvidenceRecord {
  const summary = (value: string | undefined): string | undefined =>
    options.includeEvidenceSummaries && value
      ? value.slice(0, options.maxSummaryChars)
      : undefined;
  const predictions = (
    values: readonly AxCausalMetricPrediction[],
    field: string,
    allowEmpty = false
  ): readonly AxCausalMetricPrediction[] => {
    if (allowEmpty && values.length === 0) return [];
    return boundedArray(values, field).map((prediction, index) =>
      normalizePrediction(prediction, `${field}[${index}]`)
    );
  };

  return {
    id: requiredText(record.id, 'record.id'),
    candidateId: record.candidateId
      ? requiredText(record.candidateId, 'record.candidateId')
      : undefined,
    evidence: boundedArray(record.evidence, 'record.evidence').map(
      (evidence, index) => ({
        id: requiredText(evidence.id, `record.evidence[${index}].id`),
        kind: oneOf(
          evidence.kind,
          ['failure', 'trace', 'feedback', 'evaluation'],
          `record.evidence[${index}].kind`
        ),
        fingerprint: requiredFingerprint(
          evidence.fingerprint,
          `record.evidence[${index}].fingerprint`
        ),
        summary: summary(evidence.summary),
      })
    ),
    hypothesis: requiredText(record.hypothesis, 'record.hypothesis'),
    affectedComponents: boundedArray(
      record.affectedComponents,
      'record.affectedComponents'
    ).map((component, index) => ({
      componentId: requiredText(
        component.componentId,
        `record.affectedComponents[${index}].componentId`
      ),
      surface: requiredText(
        component.surface,
        `record.affectedComponents[${index}].surface`
      ),
      beforeFingerprint: component.beforeFingerprint
        ? requiredFingerprint(
            component.beforeFingerprint,
            `record.affectedComponents[${index}].beforeFingerprint`
          )
        : undefined,
      afterFingerprint: requiredFingerprint(
        component.afterFingerprint,
        `record.affectedComponents[${index}].afterFingerprint`
      ),
    })),
    predictedBenefit: predictions(
      record.predictedBenefit,
      'record.predictedBenefit'
    ),
    predictedRegressions: predictions(
      record.predictedRegressions,
      'record.predictedRegressions',
      true
    ),
    outcome: {
      heldIn: normalizeSplit(record.outcome.heldIn, 'record.outcome.heldIn'),
      heldOut: normalizeSplit(record.outcome.heldOut, 'record.outcome.heldOut'),
    },
    decision: {
      status: oneOf(
        record.decision.status,
        ['promoted', 'rejected'],
        'record.decision.status'
      ),
      reason: requiredText(record.decision.reason, 'record.decision.reason'),
    },
    ablation: record.ablation
      ? {
          kind: oneOf(
            record.ablation.kind,
            ['ablation', 'counterfactual'],
            'record.ablation.kind'
          ),
          removedComponentIds: boundedArray(
            record.ablation.removedComponentIds,
            'record.ablation.removedComponentIds'
          ).map((id, index) =>
            requiredText(id, `record.ablation.removedComponentIds[${index}]`)
          ),
          heldIn: normalizeSplit(
            record.ablation.heldIn,
            'record.ablation.heldIn'
          ),
          heldOut: normalizeSplit(
            record.ablation.heldOut,
            'record.ablation.heldOut'
          ),
          attribution: oneOf(
            record.ablation.attribution,
            ['supports', 'contradicts', 'inconclusive'],
            'record.ablation.attribution'
          ),
          summary: summary(record.ablation.summary),
        }
      : undefined,
  };
}

function validateRecordLinks(record: AxCausalCandidateEvidenceRecord): void {
  const unique = (values: readonly string[], field: string): void => {
    if (new Set(values).size !== values.length) {
      throw new Error(`${field} must contain unique identifiers`);
    }
  };
  unique(
    record.evidence.map((evidence) => evidence.id),
    `record ${record.id} evidence`
  );
  unique(
    record.affectedComponents.map((component) => component.componentId),
    `record ${record.id} affectedComponents`
  );
  const outcomeKeys = new Set([
    ...record.outcome.heldIn.metrics.map(
      (metric) => `held_in:${metric.metric}`
    ),
    ...record.outcome.heldOut.metrics.map(
      (metric) => `held_out:${metric.metric}`
    ),
  ]);
  for (const prediction of [
    ...record.predictedBenefit,
    ...record.predictedRegressions,
  ]) {
    if (!outcomeKeys.has(`${prediction.split}:${prediction.metric}`)) {
      throw new Error(
        `record ${record.id} prediction ${prediction.split}:${prediction.metric} has no matching outcome`
      );
    }
  }
  if (record.ablation) {
    const componentIds = new Set(
      record.affectedComponents.map((component) => component.componentId)
    );
    for (const removedId of record.ablation.removedComponentIds) {
      if (!componentIds.has(removedId)) {
        throw new Error(
          `record ${record.id} ablation component ${removedId} is not affected by the candidate`
        );
      }
    }
  }
}

/** Stable browser-safe identifier helper. This is not a cryptographic digest. */
export function axFingerprintCausalEvidence(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Build a bounded, recursively immutable host-authored evidence manifest. */
export function axCreateCausalCandidateEvidenceManifest(
  records: readonly Readonly<AxCausalCandidateEvidenceRecord>[],
  options: Readonly<AxCausalCandidateEvidenceOptions> = {}
): AxCausalCandidateEvidenceManifest {
  const resolved: Required<AxCausalCandidateEvidenceOptions> = {
    maxRecords: boundedInteger(options.maxRecords, DEFAULT_MAX_RECORDS, 10_000),
    maxArtifactBytes: boundedInteger(
      options.maxArtifactBytes,
      DEFAULT_MAX_ARTIFACT_BYTES,
      10 * 1024 * 1024
    ),
    includeEvidenceSummaries: options.includeEvidenceSummaries ?? false,
    maxSummaryChars: boundedInteger(
      options.maxSummaryChars,
      DEFAULT_MAX_SUMMARY_CHARS,
      2000
    ),
  };
  let retained = records
    .slice(0, resolved.maxRecords)
    .map((record) => normalizeRecord(record, resolved));
  const recordIds = retained.map((record) => record.id);
  if (new Set(recordIds).size !== recordIds.length) {
    throw new Error('causal candidate evidence record IDs must be unique');
  }
  for (const record of retained) validateRecordLinks(record);
  let omittedRecordCount = records.length - retained.length;
  const makeManifest = (): AxCausalCandidateEvidenceManifest => ({
    version: 1,
    records: retained,
    omittedRecordCount,
    maxRecords: resolved.maxRecords,
    maxArtifactBytes: resolved.maxArtifactBytes,
    privacy: {
      rawEvidenceRetained: false,
      evidenceSummaries: resolved.includeEvidenceSummaries
        ? 'bounded'
        : 'omitted',
      maxSummaryChars: resolved.maxSummaryChars,
    },
    authority: 'host_supplied',
  });
  const encoder = new TextEncoder();
  let manifest = makeManifest();
  while (
    encoder.encode(JSON.stringify(manifest)).byteLength >
      resolved.maxArtifactBytes &&
    retained.length > 0
  ) {
    retained = retained.slice(0, -1);
    omittedRecordCount += 1;
    manifest = makeManifest();
  }
  if (
    encoder.encode(JSON.stringify(manifest)).byteLength >
    resolved.maxArtifactBytes
  ) {
    throw new Error(
      `causal candidate evidence metadata exceeds maxArtifactBytes=${resolved.maxArtifactBytes}`
    );
  }
  return deepFreeze(manifest);
}

export function axCloneCausalCandidateEvidenceManifest(
  manifest: Readonly<AxCausalCandidateEvidenceManifest>
): AxCausalCandidateEvidenceManifest {
  if (
    manifest.version !== 1 ||
    manifest.authority !== 'host_supplied' ||
    manifest.privacy?.rawEvidenceRetained !== false ||
    !Number.isInteger(manifest.omittedRecordCount) ||
    manifest.omittedRecordCount < 0
  ) {
    throw new Error('invalid causal candidate evidence manifest metadata');
  }
  const includeEvidenceSummaries =
    manifest.privacy.evidenceSummaries === 'bounded';
  if (
    !includeEvidenceSummaries &&
    manifest.privacy.evidenceSummaries !== 'omitted'
  ) {
    throw new Error('invalid causal candidate evidence privacy mode');
  }
  const validated = axCreateCausalCandidateEvidenceManifest(manifest.records, {
    maxRecords: manifest.maxRecords,
    maxArtifactBytes: manifest.maxArtifactBytes,
    includeEvidenceSummaries,
    maxSummaryChars: manifest.privacy.maxSummaryChars,
  });
  if (
    validated.maxRecords !== manifest.maxRecords ||
    validated.maxArtifactBytes !== manifest.maxArtifactBytes ||
    validated.privacy.maxSummaryChars !== manifest.privacy.maxSummaryChars ||
    validated.omittedRecordCount !== 0 ||
    JSON.stringify(validated.records) !== JSON.stringify(manifest.records) ||
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
      manifest.maxArtifactBytes
  ) {
    throw new Error('invalid or unbounded causal candidate evidence manifest');
  }
  return deepFreeze(
    JSON.parse(JSON.stringify(manifest)) as AxCausalCandidateEvidenceManifest
  );
}
