import type { AxRuntimeCapabilityRequirements } from '../../agent/runtimeCapabilities.js';
import {
  type AxCandidateEffectDeclaration,
  AxCandidateEffectManifestError,
  type AxCandidateEffectPolicy,
  axDeclaresToolCapability,
  axValidateCandidateEffectDeclaration,
} from './candidateEffectManifest.js';
import type { AxHarnessStamp } from './harnessRecipe.js';
import {
  type AxComponentClass,
  type AxMutationAnnotation,
  type AxMutationEffort,
  type AxPatchType,
  axMutationDepths,
  axMutationEfforts,
  axPatchClassOfType,
} from './mutationTaxonomy.js';
import type { AxMinibatchStrategy } from './taskDiscrimination.js';
import type {
  AxEnvironmentFailureCause,
  AxTrajectoryAdmissionReport,
} from './trajectoryTermination.js';

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
  /**
   * Host free text, validated only as non-empty. NEVER a gate input: a gate
   * built on it is one a host bypasses by typing a different word.
   */
  readonly surface: string;
  /**
   * UNCHANGED TYPE `string`, deliberately not rebranded: `requiredFingerprint`
   * already enforces `/^sha256:[0-9a-f]{64}$/` at runtime, and rebranding a
   * public field would break every host that builds a record from a literal.
   */
  readonly beforeFingerprint?: string;
  readonly afterFingerprint: string;
  /** Advisory label carried for readers. Never a gate input on its own. */
  readonly componentClass?: AxComponentClass;
  /** The structured component kind. THIS is the gate input. */
  readonly componentKind?: string;
  /** Declared `AxProgramSourceCapability[]` for a `program-source` component. Gate input. */
  readonly toolCapabilities?: readonly string[];
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
  /** Per-component matrix generalizing the single ablation above. */
  readonly leaveOneOut?: AxCausalLeaveOneOutMatrix;
  /** Host self-report. Required whenever `leaveOneOut` is present. */
  readonly metricCalls?: number;
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
  /** Explicitly no attribution. Mutually exclusive with `ablation`. */
  readonly attribution?: AxCausalAttributionStatement;
  readonly mutation?: AxMutationAnnotation;
  readonly cost?: AxCausalCandidateCost;
  readonly harness?: AxHarnessStamp;
  readonly discrimination?: AxCausalCandidateDiscrimination;
  readonly admission?: AxTrajectoryAdmissionReport;
  readonly effects?: readonly AxCandidateEffectDeclaration[];
  readonly runtimeRequirements?: AxRuntimeCapabilityRequirements;
}

export interface AxCausalLeaveOneOutRow {
  readonly removedComponentId: string;
  readonly heldIn: AxCausalCandidateSplitOutcome;
  readonly heldOut: AxCausalCandidateSplitOutcome;
  readonly attribution: 'supports' | 'contradicts' | 'inconclusive';
}

export interface AxCausalLeaveOneOutMatrix {
  readonly rows: readonly AxCausalLeaveOneOutRow[];
  /**
   * Metric calls this matrix consumed. A HOST SELF-REPORT: Ax ships no
   * ablation runner, so it validates the shape (a positive integer, required
   * whenever a matrix is present) and cannot cross-check it against any
   * counter it owns.
   */
  readonly metricCalls: number;
}

/**
 * The honest alternative to an ablation. Never a default: a record must
 * either carry an attribution or say, in as many words, that it has none.
 */
export interface AxCausalAttributionStatement {
  readonly status: 'inconclusive';
  readonly reason: string;
}

export interface AxCausalCandidateCost {
  readonly metricCalls: number;
  readonly proposerCalls?: number;
  readonly effort?: AxMutationEffort;
  /** `undefined` when unknown. NEVER estimated: "free" and "unmeasured" are different claims. */
  readonly costUsd?: number;
  readonly wallMs?: number;
}

export interface AxCausalCandidateDiscrimination {
  readonly strategy: AxMinibatchStrategy;
  /**
   * Which instrument decided. The merge gate is a score-disagreement
   * stratified subsample with no inclusion probabilities, so no IPW estimate of
   * it exists and it always reports `'sum'` — even under
   * `minibatchStrategy: 'discriminative'`.
   */
  readonly estimator: 'sum' | 'ipw_hajek';
  readonly gate: 'reflective_mutation' | 'system_merge';
  readonly estimate: number;
  /** Approximate. Reported, never gated on. */
  readonly stderr?: number;
  readonly effectiveSampleSize?: number;
  /** Rows compared, after intersecting the parent and child admitted sets. */
  readonly pairedRowCount: number;
}

export interface AxCausalCandidateEvidencePolicy {
  readonly attribution: 'off' | 'required';
  readonly effects: AxCandidateEffectPolicy;
}

/** Replay-time policy floor demanded by the CALLER, independent of the artifact. */
export interface AxCausalCandidateEvidenceCloneOptions {
  /**
   * The MINIMUM policy the caller demands. The effective policy is
   * `max(manifest.policy, requirePolicyAtLeast)` per field, and the records are
   * re-validated under it — so an artifact that declares `'off'` cannot lower a
   * reader's floor by self-describing.
   */
  readonly requirePolicyAtLeast?: Readonly<AxCausalCandidateEvidencePolicy>;
}

export class AxCausalAttributionRequiredError extends Error {
  readonly name = 'AxCausalAttributionRequiredError';
  readonly code = 'attribution_required';
  readonly recordId: string;
  readonly candidateId: string;
  readonly componentCount: number;

  constructor(
    args: Readonly<{
      recordId: string;
      candidateId: string;
      componentCount: number;
    }>
  ) {
    super(
      `attribution_required: record ${args.recordId} promotes candidate ${args.candidateId} across ${args.componentCount} components with neither a leave-one-out matrix covering them nor an explicit inconclusive attribution`
    );
    this.recordId = args.recordId;
    this.candidateId = args.candidateId;
    this.componentCount = args.componentCount;
  }
}

/** Cross-realm structural guard. */
export function axIsCausalAttributionRequiredError(
  error: unknown
): error is AxCausalAttributionRequiredError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxCausalAttributionRequiredError' &&
    candidate.code === 'attribution_required'
  );
}

/**
 * Derive one leave-one-out row's attribution column from the observed
 * outcomes.
 *
 * `supports` means removing the component made the candidate WORSE on the
 * held-out split — i.e. the component was carrying the gain. `contradicts`
 * means removing it made no difference or helped. Anything inside `epsilon` is
 * `inconclusive`, which is a first-class answer and not a failure.
 *
 * Convenience only: a host may compute this column itself, and Ax validates the
 * column it is given rather than recomputing it.
 */
export function axDeriveLeaveOneOutAttribution(
  candidate: Readonly<AxCausalCandidateSplitOutcome>,
  ablated: Readonly<AxCausalCandidateSplitOutcome>,
  options?: Readonly<{ epsilon?: number }>
): 'supports' | 'contradicts' | 'inconclusive' {
  const epsilon =
    options?.epsilon !== undefined && Number.isFinite(options.epsilon)
      ? Math.abs(options.epsilon)
      : 1e-9;
  const gainOf = (
    outcome: Readonly<AxCausalCandidateSplitOutcome>
  ): number | undefined => {
    const metrics = outcome?.metrics ?? [];
    if (metrics.length === 0) return undefined;
    return metrics.reduce(
      (total, metric) => total + (metric.after - metric.before),
      0
    );
  };
  const candidateGain = gainOf(candidate);
  const ablatedGain = gainOf(ablated);
  if (candidateGain === undefined || ablatedGain === undefined) {
    return 'inconclusive';
  }
  const delta = candidateGain - ablatedGain;
  if (Math.abs(delta) <= epsilon) return 'inconclusive';
  return delta > 0 ? 'supports' : 'contradicts';
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
  /**
   * VERSION DISCIPLINE: emitted at `4` whenever ANY version-4 feature is used
   * — a `policy`, OR any of the eight new record fields. It is NOT gated on
   * `policy` alone.
   *
   * Gating on `policy` would let a run write records carrying `mutation` /
   * `cost` / `harness` / `discrimination` / `admission` while self-describing
   * as `version: 3`. `normalizeRecord` is a whitelist rebuild, so an older
   * reader would reconstruct those records WITHOUT the new keys and then throw
   * on the byte-equality check. Version 3 has to keep identifying the exact
   * legacy record schema.
   *
   * FORWARD INCOMPATIBILITY: no `version: 4` manifest is readable by an older
   * `@ax-llm/ax` build, because that build's clone pins `version !== 3` and an
   * exact eight-key top level. That is inherent to the existing validator.
   * Hosts that must read a run's evidence with an older build should leave
   * `attributionPolicy` and `effectPolicy` off and carry no version-4 record
   * fields.
   */
  readonly version: 3 | 4;
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
  /**
   * Version 4 only, and COVERED BY THE RECEIPT CHAIN. Without that coverage,
   * flipping `attribution` from `'required'` to `'off'` in a stored manifest
   * would leave every receipt verifying — the gate would authorize itself.
   */
  readonly policy?: AxCausalCandidateEvidencePolicy;
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
  /**
   * Default `'off'`. `'required'` refuses a promoted multi-component record
   * that carries neither a covering leave-one-out matrix nor an explicit
   * inconclusive attribution.
   */
  attributionPolicy?: 'off' | 'required';
  /**
   * Default `'off'`. `'required'` refuses a promoted candidate that patches a
   * declared program-source tool capability without an effect declaration, and
   * a promoted `program.source_replace` with no runtime requirements.
   */
  effectPolicy?: AxCandidateEffectPolicy;
}

type AxCausalCandidateRetentionOptions = Omit<
  AxCausalCandidateEvidenceOptions,
  'authority' | 'verifyAuthority' | 'attributionPolicy' | 'effectPolicy'
>;

const DEFAULT_POLICY: AxCausalCandidateEvidencePolicy = Object.freeze({
  attribution: 'off',
  effects: 'off',
});

const isDefaultPolicy = (
  policy: Readonly<AxCausalCandidateEvidencePolicy>
): boolean => policy.attribution === 'off' && policy.effects === 'off';

/** `'required'` dominates `'off'`; a caller floor can only ever tighten. */
const strictestPolicy = (
  left: Readonly<AxCausalCandidateEvidencePolicy>,
  right: Readonly<AxCausalCandidateEvidencePolicy> | undefined
): AxCausalCandidateEvidencePolicy =>
  right === undefined
    ? left
    : {
        attribution:
          left.attribution === 'required' || right.attribution === 'required'
            ? 'required'
            : 'off',
        effects:
          left.effects === 'required' || right.effects === 'required'
            ? 'required'
            : 'off',
      };

const normalizePolicy = (
  policy: unknown,
  field: string
): AxCausalCandidateEvidencePolicy => {
  if (!hasExactKeys(policy, ['attribution', 'effects'])) {
    throw new Error(`${field} must declare exactly attribution and effects`);
  }
  return {
    attribution: oneOf(
      policy.attribution as 'off' | 'required',
      ['off', 'required'],
      `${field}.attribution`
    ),
    effects: oneOf(
      policy.effects as AxCandidateEffectPolicy,
      ['off', 'required'],
      `${field}.effects`
    ),
  };
};

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
};

const nonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
};

const finiteNumber = (value: number, field: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  return value;
};

/**
 * Every version-4 record field is rebuilt key by key, in a fixed order, from a
 * closed whitelist — the same discipline the legacy fields already follow. A
 * verbatim passthrough would look simpler and would silently let an artifact
 * carry arbitrary structure through the replay validator.
 *
 * `runtimeRequirements` is the one exception and says so where it is handled.
 */
const normalizeMutation = (
  mutation: Readonly<AxMutationAnnotation>,
  field: string
): AxMutationAnnotation => {
  if (!mutation || typeof mutation !== 'object') {
    throw new Error(`${field} must be a mutation annotation`);
  }
  const type = oneOf(
    mutation.patch?.type as AxPatchType,
    Object.keys(axPatchClassOfType) as AxPatchType[],
    `${field}.patch.type`
  );
  const derivedClass = axPatchClassOfType[type];
  if (mutation.patch.class !== derivedClass) {
    throw new Error(
      `${field}.patch.class must be ${derivedClass} for patch type ${type}`
    );
  }
  const classes = boundedArray(
    mutation.componentClasses,
    `${field}.componentClasses`
  ).map((componentClass, index) =>
    oneOf(
      componentClass as AxComponentClass,
      [
        'context',
        'tools',
        'runtime',
        'evaluation',
        'orchestration',
      ] as AxComponentClass[],
      `${field}.componentClasses[${index}]`
    )
  );
  if (new Set(classes).size !== classes.length) {
    throw new Error(`${field}.componentClasses must be unique`);
  }
  return {
    depth: oneOf(mutation.depth, [...axMutationDepths], `${field}.depth`),
    patch: { class: derivedClass, type },
    componentClasses: classes,
    effort:
      mutation.effort === undefined
        ? undefined
        : oneOf(mutation.effort, [...axMutationEfforts], `${field}.effort`),
    costUsd:
      mutation.costUsd === undefined
        ? undefined
        : (() => {
            const value = finiteNumber(mutation.costUsd, `${field}.costUsd`);
            if (value < 0) throw new Error(`${field}.costUsd must be >= 0`);
            return value;
          })(),
  };
};

const normalizeHarnessStamp = (
  stamp: Readonly<AxHarnessStamp>,
  field: string
): AxHarnessStamp => {
  if (!stamp || typeof stamp !== 'object') {
    throw new Error(`${field} must be a harness stamp`);
  }
  if (stamp.stale !== undefined && stamp.stale !== true) {
    throw new Error(`${field}.stale may only be true when present`);
  }
  return {
    recipeDigest: requiredFingerprint(
      String(stamp.recipeDigest),
      `${field}.recipeDigest`
    ) as AxHarnessStamp['recipeDigest'],
    boundModelId: requiredText(stamp.boundModelId, `${field}.boundModelId`),
    stale: stamp.stale,
  };
};

const normalizeAdmission = (
  admission: Readonly<AxTrajectoryAdmissionReport>,
  field: string
): AxTrajectoryAdmissionReport => {
  if (
    !hasExactKeys(admission, [
      'evaluatedRows',
      'admittedRows',
      'discardedRows',
      'discardRate',
      'causes',
      'overriddenRows',
      'inconclusive',
    ])
  ) {
    throw new Error(`${field} must be a trajectory admission report`);
  }
  const causes = admission.causes;
  if (!causes || typeof causes !== 'object' || Array.isArray(causes)) {
    throw new Error(`${field}.causes must be a record`);
  }
  const normalizedCauses: Partial<Record<AxEnvironmentFailureCause, number>> =
    {};
  for (const [cause, count] of Object.entries(causes)) {
    normalizedCauses[
      oneOf<AxEnvironmentFailureCause>(
        cause as AxEnvironmentFailureCause,
        [
          'transport',
          'rate_limit',
          'timeout',
          'sandbox',
          'capability_unavailable',
          'host_abort',
          'other',
        ],
        `${field}.causes key`
      )
    ] = nonNegativeInteger(count as number, `${field}.causes.${cause}`);
  }
  if (typeof admission.inconclusive !== 'boolean') {
    throw new Error(`${field}.inconclusive must be a boolean`);
  }
  return {
    evaluatedRows: nonNegativeInteger(
      admission.evaluatedRows,
      `${field}.evaluatedRows`
    ),
    admittedRows: nonNegativeInteger(
      admission.admittedRows,
      `${field}.admittedRows`
    ),
    discardedRows: nonNegativeInteger(
      admission.discardedRows,
      `${field}.discardedRows`
    ),
    discardRate: finiteNumber(admission.discardRate, `${field}.discardRate`),
    causes: normalizedCauses,
    overriddenRows: nonNegativeInteger(
      admission.overriddenRows,
      `${field}.overriddenRows`
    ),
    inconclusive: admission.inconclusive,
  };
};

const normalizeDiscrimination = (
  discrimination: Readonly<AxCausalCandidateDiscrimination>,
  field: string
): AxCausalCandidateDiscrimination => ({
  strategy: oneOf(
    discrimination.strategy,
    ['uniform', 'discriminative'] as AxMinibatchStrategy[],
    `${field}.strategy`
  ),
  estimator: oneOf(
    discrimination.estimator,
    ['sum', 'ipw_hajek'],
    `${field}.estimator`
  ),
  gate: oneOf(
    discrimination.gate,
    ['reflective_mutation', 'system_merge'],
    `${field}.gate`
  ),
  estimate: finiteNumber(discrimination.estimate, `${field}.estimate`),
  stderr:
    discrimination.stderr === undefined
      ? undefined
      : finiteNumber(discrimination.stderr, `${field}.stderr`),
  effectiveSampleSize:
    discrimination.effectiveSampleSize === undefined
      ? undefined
      : finiteNumber(
          discrimination.effectiveSampleSize,
          `${field}.effectiveSampleSize`
        ),
  pairedRowCount: nonNegativeInteger(
    discrimination.pairedRowCount,
    `${field}.pairedRowCount`
  ),
});

const normalizeCost = (
  cost: Readonly<AxCausalCandidateCost>,
  field: string
): AxCausalCandidateCost => ({
  metricCalls: nonNegativeInteger(cost.metricCalls, `${field}.metricCalls`),
  proposerCalls:
    cost.proposerCalls === undefined
      ? undefined
      : nonNegativeInteger(cost.proposerCalls, `${field}.proposerCalls`),
  effort:
    cost.effort === undefined
      ? undefined
      : oneOf(
          cost.effort as AxMutationEffort,
          [...axMutationEfforts],
          `${field}.effort`
        ),
  costUsd:
    cost.costUsd === undefined
      ? undefined
      : (() => {
          const value = finiteNumber(cost.costUsd, `${field}.costUsd`);
          if (value < 0) throw new Error(`${field}.costUsd must be >= 0`);
          return value;
        })(),
  wallMs:
    cost.wallMs === undefined
      ? undefined
      : finiteNumber(cost.wallMs, `${field}.wallMs`),
});

/**
 * The one field carried by TOP-LEVEL WHITELIST rather than rebuilt in full.
 *
 * `AxRuntimeCapabilityRequirements` is a deeply nested descriptor owned by
 * `src/ax/agent/runtimeCapabilities.ts`. Rebuilding it here would put a second
 * copy of that schema in this file, and the two would drift the first time the
 * runtime subsystem gained a field. The keys are whitelisted so an artifact
 * cannot smuggle unknown top-level structure through replay; the values are
 * carried as written, and the manifest byte cap bounds their size.
 */
const RUNTIME_REQUIREMENT_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'inspect',
  'snapshot',
  'patch',
  'abort',
  'language',
  'platform',
  'protocol',
  'persistence',
  'resources',
  'authority',
]);

const normalizeRuntimeRequirements = (
  requirements: Readonly<AxRuntimeCapabilityRequirements>,
  field: string
): AxRuntimeCapabilityRequirements => {
  if (
    !requirements ||
    typeof requirements !== 'object' ||
    Array.isArray(requirements)
  ) {
    throw new Error(`${field} must be a runtime capability requirement record`);
  }
  const entries = Object.entries(requirements);
  if (entries.length === 0) {
    throw new Error(`${field} must declare at least one requirement`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!RUNTIME_REQUIREMENT_KEYS.has(key)) {
      throw new Error(`${field}.${key} is not a runtime requirement field`);
    }
    normalized[key] = value;
  }
  return normalized as AxRuntimeCapabilityRequirements;
};

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
      componentClass:
        component.componentClass === undefined
          ? undefined
          : oneOf(
              component.componentClass,
              [
                'context',
                'tools',
                'runtime',
                'evaluation',
                'orchestration',
              ] as AxComponentClass[],
              `record.affectedComponents[${index}].componentClass`
            ),
      componentKind:
        component.componentKind === undefined
          ? undefined
          : requiredText(
              component.componentKind,
              `record.affectedComponents[${index}].componentKind`
            ),
      toolCapabilities:
        component.toolCapabilities === undefined
          ? undefined
          : boundedArray(
              component.toolCapabilities,
              `record.affectedComponents[${index}].toolCapabilities`
            ).map((capability, capabilityIndex) =>
              requiredText(
                capability,
                `record.affectedComponents[${index}].toolCapabilities[${capabilityIndex}]`
              )
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
          leaveOneOut: record.ablation.leaveOneOut
            ? {
                rows: boundedArray(
                  record.ablation.leaveOneOut.rows,
                  'record.ablation.leaveOneOut.rows'
                ).map((row, index) => ({
                  removedComponentId: requiredText(
                    row.removedComponentId,
                    `record.ablation.leaveOneOut.rows[${index}].removedComponentId`
                  ),
                  heldIn: normalizeSplit(
                    row.heldIn,
                    `record.ablation.leaveOneOut.rows[${index}].heldIn`
                  ),
                  heldOut: normalizeSplit(
                    row.heldOut,
                    `record.ablation.leaveOneOut.rows[${index}].heldOut`
                  ),
                  attribution: oneOf(
                    row.attribution,
                    ['supports', 'contradicts', 'inconclusive'],
                    `record.ablation.leaveOneOut.rows[${index}].attribution`
                  ),
                })),
                // Required WHENEVER a matrix is present: a matrix that claims
                // no cost is a free ablation, and there is no such thing.
                metricCalls: positiveInteger(
                  record.ablation.leaveOneOut.metricCalls,
                  'record.ablation.leaveOneOut.metricCalls'
                ),
              }
            : undefined,
          metricCalls:
            record.ablation.metricCalls === undefined
              ? undefined
              : positiveInteger(
                  record.ablation.metricCalls,
                  'record.ablation.metricCalls'
                ),
        }
      : undefined,
    // Version-4 fields, emitted AFTER `ablation` and `undefined` when absent,
    // so a version-3 manifest written before this change re-serializes byte
    // for byte through the clone's equality check.
    attribution: record.attribution
      ? {
          status: oneOf(
            record.attribution.status,
            ['inconclusive'],
            'record.attribution.status'
          ),
          reason: requiredText(
            record.attribution.reason,
            'record.attribution.reason'
          ),
        }
      : undefined,
    mutation: record.mutation
      ? normalizeMutation(record.mutation, 'record.mutation')
      : undefined,
    cost: record.cost ? normalizeCost(record.cost, 'record.cost') : undefined,
    harness: record.harness
      ? normalizeHarnessStamp(record.harness, 'record.harness')
      : undefined,
    discrimination: record.discrimination
      ? normalizeDiscrimination(record.discrimination, 'record.discrimination')
      : undefined,
    admission: record.admission
      ? normalizeAdmission(record.admission, 'record.admission')
      : undefined,
    effects: record.effects
      ? boundedArray(record.effects, 'record.effects').map(
          (declaration, index) =>
            axValidateCandidateEffectDeclaration(
              declaration,
              `record.effects[${index}]`
            )
        )
      : undefined,
    runtimeRequirements: record.runtimeRequirements
      ? normalizeRuntimeRequirements(
          record.runtimeRequirements,
          'record.runtimeRequirements'
        )
      : undefined,
  };
}

/** True when a record carries any field that forces manifest version 4. */
function usesVersion4Fields(
  record: Readonly<AxCausalCandidateEvidenceRecord>
): boolean {
  return (
    record.attribution !== undefined ||
    record.mutation !== undefined ||
    record.cost !== undefined ||
    record.harness !== undefined ||
    record.discrimination !== undefined ||
    record.admission !== undefined ||
    record.effects !== undefined ||
    record.runtimeRequirements !== undefined ||
    record.ablation?.leaveOneOut !== undefined ||
    record.ablation?.metricCalls !== undefined ||
    record.affectedComponents.some(
      (component) =>
        component.componentClass !== undefined ||
        component.componentKind !== undefined ||
        component.toolCapabilities !== undefined
    )
  );
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
    // The SAME standard the single `ablation` above already meets, applied to
    // every leave-one-out row. Without this a row could name a component the
    // candidate never touched and carry an arbitrary metric set — a weaker
    // bar than the thing it generalizes.
    const rows = record.ablation.leaveOneOut?.rows ?? [];
    const removedIds = rows.map((row) => row.removedComponentId);
    if (new Set(removedIds).size !== removedIds.length) {
      throw new Error(
        `record ${record.id} leave-one-out rows must remove distinct components`
      );
    }
    for (const row of rows) {
      if (!componentIds.has(row.removedComponentId)) {
        throw new Error(
          `record ${record.id} leave-one-out component ${row.removedComponentId} is not affected by the candidate`
        );
      }
      for (const [split, observed, ablated] of [
        ['held_in', record.outcome.heldIn, row.heldIn],
        ['held_out', record.outcome.heldOut, row.heldOut],
      ] as const) {
        const observedMetrics = observed.metrics
          .map((metric) => metric.metric)
          .sort();
        const ablatedMetrics = ablated.metrics
          .map((metric) => metric.metric)
          .sort();
        if (
          JSON.stringify(observedMetrics) !== JSON.stringify(ablatedMetrics)
        ) {
          throw new Error(
            `record ${record.id} ${split} leave-one-out metrics for ${row.removedComponentId} must match candidate outcomes`
          );
        }
      }
    }
    if (rows.length > 0 && record.ablation.metricCalls === undefined) {
      throw new Error(
        `record ${record.id} must charge its leave-one-out metric calls to ablation.metricCalls`
      );
    }
  } else if (
    record.ablation === undefined &&
    record.attribution === undefined
  ) {
    // Nothing to check: an unattributed record is legal unless the policy says
    // otherwise, and the policy check lives in `validateManifestRecords`.
  }
  if (record.ablation && record.attribution) {
    // §7.6's last row. A record may not claim an attribution and disclaim one.
    throw new Error(
      `record ${record.id} cannot both claim an ablation and disclaim attribution`
    );
  }
}

/**
 * Version-4 policy gates. Applied to PROMOTED records only: a rejection needs
 * no attribution and declares no effects, because nothing was promoted on it.
 */
function validateRecordPolicy(
  record: AxCausalCandidateEvidenceRecord,
  policy: Readonly<AxCausalCandidateEvidencePolicy>
): void {
  if (record.decision.status !== 'promoted') return;

  if (
    policy.attribution === 'required' &&
    record.affectedComponents.length > 1
  ) {
    const rows = record.ablation?.leaveOneOut?.rows ?? [];
    const covered = new Set(rows.map((row) => row.removedComponentId));
    const affected = new Set(
      record.affectedComponents.map((component) => component.componentId)
    );
    // EXACT coverage: a missing row and an extra row both fail. An extra row
    // is already impossible (`validateRecordLinks` rejects an unaffected
    // component), so this is the missing-row half.
    const covers =
      covered.size === affected.size &&
      [...affected].every((componentId) => covered.has(componentId));
    if (!covers && record.attribution === undefined) {
      throw new AxCausalAttributionRequiredError({
        recordId: record.id,
        candidateId: record.candidateId,
        componentCount: record.affectedComponents.length,
      });
    }
  }

  if (policy.effects !== 'required') return;

  // EVERY effect gate keys on the record's OWN COMPONENT LIST — the structured
  // `componentKind` and `toolCapabilities` of what actually changed — never on
  // the OPTIONAL `mutation` annotation (§12/B1). `mutation` is authored by the
  // same host as the rest of the record, so a gate keyed on it is a gate the
  // author switches off by omitting one field, or by relabelling a
  // program-source patch as `steering`. That defeated the reader-side
  // `requirePolicyAtLeast.effects` floor, whose whole purpose is that an
  // artifact cannot lower a caller's bar by self-describing.
  const touchesTool = record.affectedComponents.some((component) =>
    axDeclaresToolCapability(component)
  );
  const touchesProgramSource = record.affectedComponents.some(
    (component) => component.componentKind === 'program-source'
  );
  if (touchesTool && (!record.effects || record.effects.length === 0)) {
    throw new AxCandidateEffectManifestError({
      code: 'effects_missing',
      message: `record ${record.id} promotes a patch on a component declaring a tool capability with no effect declaration`,
    });
  }
  if (
    record.effects &&
    record.effects.length > 0 &&
    (record.mutation?.patch.class === 'steering' || !touchesProgramSource)
  ) {
    // Description text cannot carry an effect. A record that declares one
    // either mislabels the patch or names no executable surface it could
    // possibly reach, and both are claims of a reach the record does not have.
    throw new AxCandidateEffectManifestError({
      code: 'effects_on_steering_surface',
      message: record.mutation
        ? `record ${record.id} attaches an effect declaration to a steering patch (${record.mutation.patch.type})`
        : `record ${record.id} attaches an effect declaration to a record whose affected components include no program-source surface`,
    });
  }
  if (
    (touchesProgramSource ||
      record.mutation?.patch.type === 'program.source_replace') &&
    record.runtimeRequirements === undefined
  ) {
    throw new AxCandidateEffectManifestError({
      code: 'runtime_requirements_missing',
      message: `record ${record.id} promotes a program-source candidate without declaring what the replacement runtime needs`,
    });
  }
}

/**
 * `policy` is an EXPLICIT parameter, not an ambient default: this function is
 * the only place both the structural invariants and the version-4 gates are
 * applied, and a validator that cannot be told what to enforce enforces
 * nothing.
 */
function validateManifestRecords(
  records: readonly AxCausalCandidateEvidenceRecord[],
  policy: Readonly<AxCausalCandidateEvidencePolicy>
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
    validateRecordPolicy(record, policy);
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
  const policy: AxCausalCandidateEvidencePolicy = {
    attribution: oneOf(
      options.attributionPolicy ?? 'off',
      ['off', 'required'],
      'options.attributionPolicy'
    ),
    effects: oneOf(
      options.effectPolicy ?? 'off',
      ['off', 'required'],
      'options.effectPolicy'
    ),
  };
  if (records.length > 10_000) {
    throw new Error('causal candidate evidence exceeds 10000 input records');
  }
  const normalized = records.map((record) => normalizeRecord(record, resolved));
  validateManifestRecords(normalized, policy);
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
  // ANY version-4 feature bumps the manifest — a declared policy, OR any
  // version-4 record field. Gating on `policy` alone would let a run with
  // annotations enabled ship version-4 records inside a manifest calling itself
  // version 3, which an older reader then rebuilds without those keys and
  // rejects on the byte-equality check.
  const version: 3 | 4 =
    !isDefaultPolicy(policy) || retained.some(usesVersion4Fields) ? 4 : 3;
  const makeManifest = (): AxCausalCandidateEvidenceManifest => ({
    version,
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
    // Emitted only on version 4, and only when it says something: `undefined`
    // is dropped by `JSON.stringify`, so a version-3 manifest is byte-identical
    // to one written before this change.
    ...(version === 4 && !isDefaultPolicy(policy) ? { policy } : {}),
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
  const base = {
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
  };
  // VERSION-GUARDED so every stored version-3 receipt keeps verifying byte for
  // byte. Without covering `policy`, flipping `attribution` from `'required'`
  // to `'off'` in a stored version-4 manifest leaves the whole receipt chain
  // valid — `version` is covered and the policy that version enables is not,
  // so the gate would authorize its own removal.
  return JSON.stringify(
    manifest.version >= 4 ? { ...base, policy: manifest.policy ?? null } : base
  );
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
  verifyAuthority: AxCausalEvidenceAuthorityVerifier,
  options?: Readonly<AxCausalCandidateEvidenceCloneOptions>
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
  const LEGACY_KEYS = [
    'version',
    'records',
    'totalRecordCount',
    'omittedRecordCount',
    'maxRecords',
    'maxArtifactBytes',
    'privacy',
    'receipts',
  ];
  if (
    // A version-4 manifest MAY carry `policy`; a version-3 one may not. The
    // key list stays exact in both cases, so an unknown top-level key is still
    // refused.
    !(
      hasExactKeys(manifest, LEGACY_KEYS) ||
      (manifest.version === 4 &&
        hasExactKeys(manifest, [...LEGACY_KEYS, 'policy']))
    ) ||
    !hasExactKeys(manifest.privacy, [
      'evidencePayloads',
      'freeText',
      'evidenceSummaries',
      'maxSummaryChars',
    ]) ||
    (manifest.version !== 3 && manifest.version !== 4) ||
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
  const declaredPolicy =
    manifest.policy === undefined
      ? DEFAULT_POLICY
      : normalizePolicy(manifest.policy, 'manifest.policy');
  if (manifest.version === 3 && manifest.policy !== undefined) {
    throw new Error(
      'a version 3 causal evidence manifest cannot declare a policy'
    );
  }
  const validatedRecords = manifest.records.map((record) =>
    normalizeRecord(record, resolved)
  );
  // B5's regression: a manifest that CALLS ITSELF version 3 while carrying
  // version-4 record fields is refused outright rather than being silently
  // rebuilt without them and then failing an opaque byte comparison.
  if (manifest.version === 3 && validatedRecords.some(usesVersion4Fields)) {
    throw new Error(
      'a version 3 causal evidence manifest cannot carry version 4 record fields'
    );
  }
  // The caller's floor can only TIGHTEN. An artifact declaring `'off'` cannot
  // lower a reader's demand by self-describing, which is the whole point of
  // `requirePolicyAtLeast`.
  const effectivePolicy = strictestPolicy(
    declaredPolicy,
    options?.requirePolicyAtLeast === undefined
      ? undefined
      : normalizePolicy(
          options.requirePolicyAtLeast,
          'options.requirePolicyAtLeast'
        )
  );
  validateManifestRecords(validatedRecords, effectivePolicy);
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
