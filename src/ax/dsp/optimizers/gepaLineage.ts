import type { AxGEPARunAdmissionReport } from '../optimizerTypes.js';
import { type AxSha256Digest64, axSha256Digest64Sync } from './digests.js';
import type { AxHarnessStamp } from './harnessRecipe.js';
import type {
  AxMutationAnnotation,
  AxMutationDepthHistogram,
} from './mutationTaxonomy.js';
import type { AxTaskDiscriminationSummary } from './taskDiscrimination.js';
import type { AxTrajectoryAdmissionReport } from './trajectoryTermination.js';

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
  /**
   * Emit the version-2 annotations Ax can compute with NO host input: paired
   * reflection outcomes on every reflective-mutation record, the deployable
   * best chain, and the causal-evidence cross-link id.
   *
   * Default `false`. That default is what keeps a plain `candidateLineage:
   * true` run emitting a `version: 1` manifest with every new field absent
   * (INV-L1) — the other version-2 fields each have their own compile option
   * (`harnessRecipe`, `mutationAnnotation`, `trajectoryTermination`,
   * `minibatchStrategy`) and these three do not.
   *
   * NAMING: the flag gates all THREE of those annotations, not only the
   * reflection outcomes it is named for. Splitting it into three switches, or
   * renaming it, would widen the public option surface for a distinction no
   * caller has asked for — one switch for "the annotations Ax computes on its
   * own" is the smaller contract. Documented here and in `ax-gepa.md` rather
   * than left for a reader to discover from the implementation (§12/M4-minor).
   */
  includeReflectionOutcomes?: boolean;
  /** Include bounded per-category example indices in reflection outcomes. Default: false. */
  includeReflectionIndices?: boolean;
  /** Maximum indices per reflection category. Default: 20; clamped to [1, 200]. */
  maxReflectionIndices?: number;
}

export type AxGEPAReflectionCategory =
  | 'fixed'
  | 'regressed'
  | 'still_failing'
  | 'still_passing';

/** Fixed emission order, so two reflection arrays diff positionally. */
const REFLECTION_CATEGORIES: readonly AxGEPAReflectionCategory[] =
  Object.freeze([
    'fixed',
    'regressed',
    'still_failing',
    'still_passing',
  ] as const);

export interface AxGEPAReflectionOutcome {
  readonly category: AxGEPAReflectionCategory;
  readonly count: number;
  /** Bounded; present only with `includeReflectionIndices`. */
  readonly exampleIndices?: readonly number[];
}

/**
 * Deterministic paired classification of a parent/child evaluation pair.
 *
 * Module-internal-but-exported: the missing `ax` prefix is what keeps it out of
 * the public barrel (`hasValidPrefix`, `scripts/generateIndex.ts`), matching the
 * existing `buildGEPACandidateComponentDelta` precedent.
 *
 * Rows are paired by FEEDBACK-SET INDEX, and a row counts only when it was
 * admitted on BOTH sides. Rows present on one side only, and rows either side
 * discarded, are excluded from every category — so the four counts always sum
 * to the paired admitted row count, which is the number a reader can check.
 * (The RFC says unpaired rows are "ignored and counted"; the return type it
 * fixes has nowhere to put a count, so they are excluded and the sum invariant
 * is what makes the exclusion visible.)
 */
export function buildGEPAReflectionOutcomes(
  parent: readonly Readonly<{
    index: number;
    scalar: number;
    admitted: boolean;
  }>[],
  child: readonly Readonly<{
    index: number;
    scalar: number;
    admitted: boolean;
  }>[],
  options: Readonly<{
    successThreshold: number;
    includeIndices: boolean;
    maxIndices: number;
  }>
): readonly AxGEPAReflectionOutcome[] {
  const childByIndex = new Map<number, { scalar: number; admitted: boolean }>();
  for (const row of child) {
    if (!childByIndex.has(row.index)) {
      childByIndex.set(row.index, {
        scalar: row.scalar,
        admitted: row.admitted,
      });
    }
  }
  const counts = new Map<AxGEPAReflectionCategory, number>();
  const indices = new Map<AxGEPAReflectionCategory, number[]>();
  for (const category of REFLECTION_CATEGORIES) {
    counts.set(category, 0);
    indices.set(category, []);
  }
  const seen = new Set<number>();
  for (const parentRow of parent) {
    if (seen.has(parentRow.index)) continue;
    seen.add(parentRow.index);
    const childRow = childByIndex.get(parentRow.index);
    if (!childRow || !parentRow.admitted || !childRow.admitted) continue;
    const parentPass = parentRow.scalar >= options.successThreshold;
    const childPass = childRow.scalar >= options.successThreshold;
    const category: AxGEPAReflectionCategory = parentPass
      ? childPass
        ? 'still_passing'
        : 'regressed'
      : childPass
        ? 'fixed'
        : 'still_failing';
    counts.set(category, counts.get(category)! + 1);
    const bucket = indices.get(category)!;
    if (options.includeIndices && bucket.length < options.maxIndices) {
      bucket.push(parentRow.index);
    }
  }
  // Zero-count entries are RETAINED so the array shape is stable and diffable.
  return Object.freeze(
    REFLECTION_CATEGORIES.map((category) =>
      Object.freeze({
        category,
        count: counts.get(category)!,
        ...(options.includeIndices
          ? { exampleIndices: Object.freeze([...indices.get(category)!]) }
          : {}),
      })
    )
  );
}

/**
 * The single deployable candidate and its ancestry.
 *
 * No `score`: it would duplicate `AxOptimizedProgram.bestScore`, which is
 * already the maximum over INDIVIDUAL frontier candidates and already
 * corresponds to the one deployable `componentMap`. No archive-best / per-task
 * oracle composite is produced anywhere in this subsystem — computing one
 * purely so it could be labelled non-deployable would add Goodhart surface for
 * a number nothing consumes.
 */
export interface AxGEPADeployableBestChain {
  readonly candidateId: string;
  /** Root-first ancestry, ending at `candidateId`. Derived from existing parent links. */
  readonly ancestry: readonly string[];
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
  /** Mean scalar used by GEPA's acceptance and score decisions. */
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
  /**
   * Host-annotated mutation depth, patch taxonomy, component classes, effort
   * and cost. Present only under `AxCompileOptions.mutationAnnotation`, and
   * only when the annotator returned an annotation Ax could validate against
   * the component kinds the candidate actually touched.
   */
  readonly mutation?: AxMutationAnnotation;
  /**
   * Paired parent/child outcome categories for a reflective-mutation candidate.
   * Present only under `includeReflectionOutcomes`.
   */
  readonly reflection?: readonly AxGEPAReflectionOutcome[];
  /**
   * The `AxCausalCandidateEvidenceRecord.id` a host should use when it attaches
   * causal evidence for this candidate, so the join between the two manifests
   * is one Ax published rather than one every host reinvents. Ax does not
   * create causal evidence records; this is a cross-link, not a claim that one
   * exists.
   */
  readonly causalEvidenceRecordId?: string;
  /** Harness recipe digest and bound model id this candidate was produced under. */
  readonly harness?: AxHarnessStamp;
  /**
   * PER-BATCH admission for the evaluation that decided this candidate — the
   * child minibatch for a reflective mutation, the merge subsample for a merge.
   * The run-level fold lives on the manifest.
   */
  readonly admission?: AxTrajectoryAdmissionReport;
}

export interface AxGEPACandidateLineageManifest {
  /**
   * `2` whenever ANY version-2 field is present on the manifest or on any
   * record; `1` otherwise. A `version: 1` manifest therefore still identifies
   * the exact legacy record schema, byte for byte.
   */
  readonly version: 1 | 2;
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
    | 'aborted'
    /**
     * The run-level trajectory-admission ceiling fired: a host classifier
     * discarded more than `maxRunDiscardRate` of the evaluated rows. Only
     * reachable when `AxCompileOptions.trajectoryTermination` is supplied.
     */
    | 'excessive_environment_failures';
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
  /** Version 2 only. Depth counts over every proposed candidate, plus `unannotated`. */
  readonly mutationDepthHistogram?: AxMutationDepthHistogram;
  /** Version 2 only. Bounded run-level discriminative-sampler report. */
  readonly discrimination?: AxTaskDiscriminationSummary;
  /** Version 2 only. The run's harness stamp. */
  readonly harness?: AxHarnessStamp;
  /** Version 2 only. The deployable candidate and its ancestry. No archive-best. */
  readonly bestChain?: AxGEPADeployableBestChain;
  /**
   * Version 2 only. WHOLE-RUN admission accounting.
   *
   * Typed `AxGEPARunAdmissionReport`, not the per-batch
   * `AxTrajectoryAdmissionReport` the RFC names: `inconclusive` is a per-batch
   * verdict whose run-level fold is an OR, so it travels here as
   * `anyBatchInconclusive` rather than telling a reader the whole run was
   * inconclusive because one batch was.
   */
  readonly admission?: AxGEPARunAdmissionReport;
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
    includeReflectionOutcomes: options?.includeReflectionOutcomes ?? false,
    includeReflectionIndices: options?.includeReflectionIndices ?? false,
    maxReflectionIndices: boundedInteger(
      options?.maxReflectionIndices,
      20,
      200
    ),
  };
}

/**
 * Stable, browser-safe identifier over UTF-8 bytes.
 * SHA-256 truncated to 64 bits; not a confidentiality control and not a
 * full cryptographic commitment. Default manifests still omit raw values.
 *
 * The return type is narrowed to the branded `AxSha256Digest64` so a caller
 * cannot pass this correlation fingerprint where an identity digest is
 * required. The BYTES are unchanged: the synchronous SHA-256 that produces
 * them moved verbatim into `digests.ts`.
 */
export function fingerprintGEPAValue(value: string): AxSha256Digest64 {
  return axSha256Digest64Sync(value);
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
