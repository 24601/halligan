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
  readonly sequence: number;
  readonly eventKind: 'candidate_decision' | 'settlement';
  readonly parentRecordId?: string;
  readonly settlesRecordId?: string;
  /** May reference an optimizer-specific candidate/lineage ID. */
  readonly candidateId: string;
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

export interface AxCausalEvidenceAuthority {
  readonly principalId: string;
  readonly evaluatorId: string;
  readonly verifierId: string;
  readonly receiptId: string;
  readonly receiptVersion: string;
}

export type AxCausalEvidenceAuthorityVerifier = (
  canonicalPayload: string,
  authority: Readonly<AxCausalEvidenceAuthority>,
  purpose: 'issue' | 'replay'
) => boolean;

export interface AxCausalEvidenceReceipt {
  readonly authority: AxCausalEvidenceAuthority;
  readonly recordCount: number;
  readonly totalRecordCount: number;
  readonly omittedRecordCount: number;
}

export interface AxCausalCandidateEvidenceManifest {
  readonly version: 3;
  readonly records: readonly AxCausalCandidateEvidenceRecord[];
  readonly totalRecordCount: number;
  readonly omittedRecordCount: number;
  readonly maxRecords: number;
  readonly maxArtifactBytes: number;
  readonly privacy: {
    readonly evidencePayloads: 'not_in_schema';
    readonly freeText: 'bounded_not_redacted';
    readonly evidenceSummaries: 'omitted' | 'bounded';
    readonly maxSummaryChars: number;
  };
  /** Append-only per-batch authority chain; the final receipt covers prior receipts. */
  readonly receipts: readonly AxCausalEvidenceReceipt[];
}

export interface AxCausalCandidateEvidenceOptions {
  /** Host identity and durable receipt metadata for this appended record batch. */
  authority: AxCausalEvidenceAuthority;
  /** Host-owned verification. Return false for an unknown or mismatched receipt. */
  verifyAuthority: AxCausalEvidenceAuthorityVerifier;
  /** Maximum records retained, preserving input order. Default: 100. */
  maxRecords?: number;
  /** Maximum UTF-8 serialized manifest size. Default: 256 KiB. */
  maxArtifactBytes?: number;
  /** Opt in to bounded evidence and ablation summaries. Default: false. */
  includeEvidenceSummaries?: boolean;
  /** Maximum retained characters per opted-in summary. Default: 200. */
  maxSummaryChars?: number;
}

type AxCausalCandidateRetentionOptions = Omit<
  AxCausalCandidateEvidenceOptions,
  'authority' | 'verifyAuthority'
>;

const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;
const DEFAULT_MAX_SUMMARY_CHARS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_ITEMS_PER_FIELD = 64;

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

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
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must use a canonical SHA-256 fingerprint`);
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
  const metrics = boundedArray(split.metrics, `${field}.metrics`).map(
    (metric, index) =>
      normalizeMetricOutcome(metric, `${field}.metrics[${index}]`)
  );
  if (new Set(metrics.map((metric) => metric.metric)).size !== metrics.length) {
    throw new Error(`${field}.metrics must use unique metric names`);
  }
  return { metrics };
}

function normalizePrediction(
  prediction: Readonly<AxCausalMetricPrediction>,
  field: string
): AxCausalMetricPrediction {
  if (
    prediction.minimumExpectedDelta !== undefined &&
    (!Number.isFinite(prediction.minimumExpectedDelta) ||
      prediction.minimumExpectedDelta < 0)
  ) {
    throw new Error(
      `${field}.minimumExpectedDelta must be finite and non-negative`
    );
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
  options: Readonly<Required<AxCausalCandidateRetentionOptions>>
): AxCausalCandidateEvidenceRecord {
  const summary = (value: string | undefined): string | undefined => {
    if (!options.includeEvidenceSummaries || !value) return undefined;
    const truncated = [...value].slice(0, options.maxSummaryChars).join('');
    assertWellFormedUtf16(truncated);
    return truncated;
  };
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
    sequence: record.sequence,
    eventKind: oneOf(
      record.eventKind,
      ['candidate_decision', 'settlement'],
      'record.eventKind'
    ),
    parentRecordId: record.parentRecordId
      ? requiredText(record.parentRecordId, 'record.parentRecordId')
      : undefined,
    settlesRecordId: record.settlesRecordId
      ? requiredText(record.settlesRecordId, 'record.settlesRecordId')
      : undefined,
    candidateId: requiredText(record.candidateId, 'record.candidateId'),
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
  const predictionKeys = [
    ...record.predictedBenefit,
    ...record.predictedRegressions,
  ].map((prediction) => `${prediction.split}:${prediction.metric}`);
  unique(predictionKeys, `record ${record.id} predictions`);
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
    for (const [split, observed, ablated] of [
      ['held_in', record.outcome.heldIn, record.ablation.heldIn],
      ['held_out', record.outcome.heldOut, record.ablation.heldOut],
    ] as const) {
      const observedMetrics = observed.metrics
        .map((metric) => metric.metric)
        .sort();
      const ablatedMetrics = ablated.metrics
        .map((metric) => metric.metric)
        .sort();
      if (JSON.stringify(observedMetrics) !== JSON.stringify(ablatedMetrics)) {
        throw new Error(
          `record ${record.id} ${split} ablation metrics must match candidate outcomes`
        );
      }
    }
  }
}

function validateManifestRecords(
  records: readonly AxCausalCandidateEvidenceRecord[]
): void {
  const recordById = new Map<string, AxCausalCandidateEvidenceRecord>();
  const candidateDecisions = new Set<string>();
  const settledRecords = new Set<string>();
  const evidenceBindings = new Map<string, string>();
  for (const [index, record] of records.entries()) {
    if (!Number.isInteger(record.sequence) || record.sequence !== index) {
      throw new Error(`record ${record.id} sequence must equal ${index}`);
    }
    if (recordById.has(record.id)) {
      throw new Error('causal candidate evidence record IDs must be unique');
    }
    if (index === 0) {
      if (record.parentRecordId !== undefined) {
        throw new Error(
          'the first causal evidence record cannot have a parent'
        );
      }
    } else if (record.parentRecordId !== records[index - 1]!.id) {
      throw new Error(
        `record ${record.id} must name the immediately preceding parent record`
      );
    }
    if (record.eventKind === 'candidate_decision') {
      if (record.settlesRecordId !== undefined) {
        throw new Error('candidate decisions cannot settle another record');
      }
      if (candidateDecisions.has(record.candidateId)) {
        throw new Error(
          `candidate ${record.candidateId} already has a decision record`
        );
      }
      candidateDecisions.add(record.candidateId);
    } else {
      const target = record.settlesRecordId
        ? recordById.get(record.settlesRecordId)
        : undefined;
      if (
        !target ||
        target.eventKind !== 'candidate_decision' ||
        target.decision.status !== 'promoted' ||
        target.candidateId !== record.candidateId ||
        record.decision.status !== 'rejected'
      ) {
        throw new Error(
          `settlement ${record.id} must reject a prior promoted decision for the same candidate`
        );
      }
      if (settledRecords.has(target.id)) {
        throw new Error(`record ${target.id} is already settled`);
      }
      settledRecords.add(target.id);
    }
    for (const evidence of record.evidence) {
      const binding = `${evidence.kind}:${evidence.fingerprint}`;
      const previous = evidenceBindings.get(evidence.id);
      if (previous !== undefined && previous !== binding) {
        throw new Error(
          `evidence ID ${evidence.id} conflicts with a prior fingerprint binding`
        );
      }
      evidenceBindings.set(evidence.id, binding);
    }
    validateRecordLinks(record);
    recordById.set(record.id, record);
  }
}

function assertWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error(
          'causal evidence fingerprint input is not well-formed UTF-16'
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(
        'causal evidence fingerprint input is not well-formed UTF-16'
      );
    }
  }
}

/** Canonical NFC UTF-8 SHA-256 evidence identity. */
export async function axFingerprintCausalEvidence(
  value: string
): Promise<string> {
  assertWellFormedUtf16(value);
  const bytes = new TextEncoder().encode(value.normalize('NFC'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

/** Build a bounded, recursively immutable host-authored evidence manifest. */
export function axCreateCausalCandidateEvidenceManifest(
  records: readonly Readonly<AxCausalCandidateEvidenceRecord>[],
  options: Readonly<AxCausalCandidateEvidenceOptions>,
  priorReceipts: readonly Readonly<AxCausalEvidenceReceipt>[] = []
): AxCausalCandidateEvidenceManifest {
  if (typeof options?.verifyAuthority !== 'function') {
    throw new Error('causal candidate evidence authority verifier is required');
  }
  const resolved: Required<AxCausalCandidateRetentionOptions> = {
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
  if (records.length > 10_000) {
    throw new Error('causal candidate evidence exceeds 10000 input records');
  }
  const normalized = records.map((record) => normalizeRecord(record, resolved));
  validateManifestRecords(normalized);
  const totalRecordCount = normalized.length;
  if (totalRecordCount > resolved.maxRecords) {
    throw new Error(
      `causal candidate evidence exceeds maxRecords=${resolved.maxRecords}`
    );
  }
  const retained = normalized;
  const omittedRecordCount = 0;
  const authority = normalizeAuthority(options.authority);
  const inheritedReceipts = priorReceipts.map(normalizeReceipt);
  const makeManifest = (): AxCausalCandidateEvidenceManifest => ({
    version: 3,
    records: retained,
    totalRecordCount,
    omittedRecordCount,
    maxRecords: resolved.maxRecords,
    maxArtifactBytes: resolved.maxArtifactBytes,
    privacy: {
      evidencePayloads: 'not_in_schema',
      freeText: 'bounded_not_redacted',
      evidenceSummaries: resolved.includeEvidenceSummaries
        ? 'bounded'
        : 'omitted',
      maxSummaryChars: resolved.maxSummaryChars,
    },
    receipts: [
      ...inheritedReceipts,
      {
        authority,
        recordCount: retained.length,
        totalRecordCount,
        omittedRecordCount,
      },
    ],
  });
  const encoder = new TextEncoder();
  const manifest = makeManifest();
  if (
    encoder.encode(JSON.stringify(manifest)).byteLength >
    resolved.maxArtifactBytes
  ) {
    throw new Error(
      `causal candidate evidence exceeds maxArtifactBytes=${resolved.maxArtifactBytes}`
    );
  }
  validateReceiptChain(manifest, options.verifyAuthority, 'issue');
  return deepFreeze(manifest);
}

function normalizeAuthority(
  authority: Readonly<AxCausalEvidenceAuthority>
): AxCausalEvidenceAuthority {
  if (!authority || typeof authority !== 'object') {
    throw new Error('causal candidate evidence authority is required');
  }
  return {
    principalId: requiredText(authority.principalId, 'authority.principalId'),
    evaluatorId: requiredText(authority.evaluatorId, 'authority.evaluatorId'),
    verifierId: requiredText(authority.verifierId, 'authority.verifierId'),
    receiptId: requiredText(authority.receiptId, 'authority.receiptId'),
    receiptVersion: requiredText(
      authority.receiptVersion,
      'authority.receiptVersion'
    ),
  };
}

function normalizeReceipt(
  receipt: Readonly<AxCausalEvidenceReceipt>
): AxCausalEvidenceReceipt {
  return {
    authority: normalizeAuthority(receipt.authority),
    recordCount: receipt.recordCount,
    totalRecordCount: receipt.totalRecordCount,
    omittedRecordCount: receipt.omittedRecordCount,
  };
}

function canonicalizeReceipt(
  manifest: Readonly<AxCausalCandidateEvidenceManifest>,
  receiptIndex: number
): string {
  const receipt = manifest.receipts[receiptIndex]!;
  return JSON.stringify({
    version: manifest.version,
    records: manifest.records.slice(0, receipt.recordCount),
    recordCount: receipt.recordCount,
    totalRecordCount: receipt.totalRecordCount,
    omittedRecordCount: receipt.omittedRecordCount,
    maxRecords: manifest.maxRecords,
    maxArtifactBytes: manifest.maxArtifactBytes,
    privacy: manifest.privacy,
    authority: receipt.authority,
    priorReceipts: manifest.receipts.slice(0, receiptIndex),
  });
}

function validateReceiptChain(
  manifest: Readonly<AxCausalCandidateEvidenceManifest>,
  verifyAuthority: AxCausalEvidenceAuthorityVerifier,
  finalReceiptPurpose: 'issue' | 'replay'
): void {
  if (manifest.receipts.length === 0) {
    throw new Error('causal candidate evidence requires an authority receipt');
  }
  let priorRecordCount = -1;
  for (const [index, receipt] of manifest.receipts.entries()) {
    if (
      !hasExactKeys(receipt, [
        'authority',
        'recordCount',
        'totalRecordCount',
        'omittedRecordCount',
      ]) ||
      !hasExactKeys(receipt.authority, [
        'principalId',
        'evaluatorId',
        'verifierId',
        'receiptId',
        'receiptVersion',
      ]) ||
      !Number.isInteger(receipt.recordCount) ||
      receipt.recordCount < 0 ||
      receipt.recordCount > manifest.records.length ||
      receipt.recordCount <= priorRecordCount ||
      !Number.isInteger(receipt.totalRecordCount) ||
      !Number.isInteger(receipt.omittedRecordCount) ||
      receipt.omittedRecordCount < 0 ||
      receipt.totalRecordCount !==
        receipt.recordCount + receipt.omittedRecordCount ||
      (index < manifest.receipts.length - 1 &&
        (receipt.totalRecordCount !== receipt.recordCount ||
          receipt.omittedRecordCount !== 0))
    ) {
      throw new Error('invalid causal candidate evidence receipt chain');
    }
    const authority = normalizeAuthority(receipt.authority);
    const purpose =
      finalReceiptPurpose === 'issue' && index === manifest.receipts.length - 1
        ? 'issue'
        : 'replay';
    if (
      JSON.stringify(authority) !== JSON.stringify(receipt.authority) ||
      !verifyAuthority(canonicalizeReceipt(manifest, index), authority, purpose)
    ) {
      throw new Error(
        'causal candidate evidence authority verification failed'
      );
    }
    priorRecordCount = receipt.recordCount;
  }
  const finalReceipt = manifest.receipts.at(-1)!;
  if (
    finalReceipt.recordCount !== manifest.records.length ||
    finalReceipt.totalRecordCount !== manifest.totalRecordCount ||
    finalReceipt.omittedRecordCount !== manifest.omittedRecordCount
  ) {
    throw new Error('final authority receipt does not cover the manifest');
  }
}

/** Stable JSON payload covered by the final host authority receipt. */
export function axCanonicalizeCausalCandidateEvidenceManifest(
  manifest: Readonly<AxCausalCandidateEvidenceManifest>
): string {
  return canonicalizeReceipt(manifest, manifest.receipts.length - 1);
}

export function axCloneCausalCandidateEvidenceManifest(
  sourceManifest: Readonly<AxCausalCandidateEvidenceManifest>,
  verifyAuthority: AxCausalEvidenceAuthorityVerifier
): AxCausalCandidateEvidenceManifest {
  if (typeof verifyAuthority !== 'function') {
    throw new Error('causal candidate evidence authority verifier is required');
  }
  let manifest: AxCausalCandidateEvidenceManifest;
  try {
    manifest = JSON.parse(JSON.stringify(sourceManifest));
  } catch {
    throw new Error('causal candidate evidence manifest is not serializable');
  }
  if (
    !hasExactKeys(manifest, [
      'version',
      'records',
      'totalRecordCount',
      'omittedRecordCount',
      'maxRecords',
      'maxArtifactBytes',
      'privacy',
      'receipts',
    ]) ||
    !hasExactKeys(manifest.privacy, [
      'evidencePayloads',
      'freeText',
      'evidenceSummaries',
      'maxSummaryChars',
    ]) ||
    manifest.version !== 3 ||
    manifest.privacy?.evidencePayloads !== 'not_in_schema' ||
    manifest.privacy?.freeText !== 'bounded_not_redacted' ||
    !Number.isInteger(manifest.totalRecordCount) ||
    !Number.isInteger(manifest.omittedRecordCount) ||
    manifest.omittedRecordCount < 0 ||
    manifest.totalRecordCount !==
      manifest.records.length + manifest.omittedRecordCount
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
  const resolved: Required<AxCausalCandidateRetentionOptions> = {
    maxRecords: boundedInteger(
      manifest.maxRecords,
      DEFAULT_MAX_RECORDS,
      10_000
    ),
    maxArtifactBytes: boundedInteger(
      manifest.maxArtifactBytes,
      DEFAULT_MAX_ARTIFACT_BYTES,
      10 * 1024 * 1024
    ),
    includeEvidenceSummaries,
    maxSummaryChars: boundedInteger(
      manifest.privacy.maxSummaryChars,
      DEFAULT_MAX_SUMMARY_CHARS,
      2000
    ),
  };
  const validatedRecords = manifest.records.map((record) =>
    normalizeRecord(record, resolved)
  );
  validateManifestRecords(validatedRecords);
  if (
    resolved.maxRecords !== manifest.maxRecords ||
    resolved.maxArtifactBytes !== manifest.maxArtifactBytes ||
    resolved.maxSummaryChars !== manifest.privacy.maxSummaryChars ||
    manifest.records.length > manifest.maxRecords ||
    JSON.stringify(validatedRecords) !== JSON.stringify(manifest.records) ||
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
      manifest.maxArtifactBytes
  ) {
    throw new Error(
      'invalid, unauthorized, or unbounded causal candidate evidence manifest'
    );
  }
  validateReceiptChain(manifest, verifyAuthority, 'replay');
  return deepFreeze(manifest);
}
