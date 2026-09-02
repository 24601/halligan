/**
 * Type surface for `src/ax/learn/` — the serve → observe → grow → nominate
 * learning loop.
 *
 * Everything here is a declaration: interfaces, closed unions, and the typed
 * `Ax*Error` classes with their structural guards. No logic, no clock reads, no
 * IO. Implementations live beside this file.
 */

import type { AxAgentCatalogSkill } from '../agent/agentInternal/skillsTypes.js';
import type { AxAuthorizationReceipt } from '../authority/types.js';
import type { AxACEPlaybook } from '../dsp/optimizers/aceTypes.js';
import type { AxPlaybookSnapshot } from '../dsp/playbook.js';
import type { AxEventClock } from '../event/types.js';

// ---------------------------------------------------------------------------
// 4.1 Values, ids, refs
// ---------------------------------------------------------------------------

export type AxLearningScalar = string | number | boolean | null;

export type AxLearningValue =
  | AxLearningScalar
  | readonly AxLearningValue[]
  | { readonly [key: string]: AxLearningValue };

export type AxLearningRecordId = string;

/**
 * What the agent was ACTUALLY serving when the interaction ran.
 *
 * Sourced from the live harness installation on the agent, never from the store
 * head. Reading a head is not serving it: an agent that was never installed, or
 * that another process moved past, must not stamp its records with a release it
 * did not run.
 */
export interface AxLearningArtifactRef {
  /** The release whose entries are installed. Non-empty. */
  readonly releaseId: string;
  /** `sha256:<64 hex>` over the canonical admitted entry list of the INSTALLED tree. */
  readonly contentId: string;
  readonly parentReleaseId?: string;
  /**
   * The head `contentId` the surface last observed. Absent when the surface has
   * never observed a head. Best-effort and non-blocking: computed from the
   * surface's cached head, not from a store read on the serving path.
   */
  readonly headContentId?: string;
  /** `contentId !== headContentId` at serve time. A mismatch is recorded, never hidden. */
  readonly stale: boolean;
}

// ---------------------------------------------------------------------------
// 4.2 Records
// ---------------------------------------------------------------------------

export interface AxLearningInteractionPayload {
  /** Program identity: the agent's signature string at serve time. */
  readonly signature: string;
  readonly programId: string;
  readonly input: AxLearningValue;
  /** Absent when the run threw and failure recording is enabled. */
  readonly output?: AxLearningValue;
  /** Present only for a recorded failed run. Never carries a stack. */
  readonly failure?: Readonly<{ name: string; message: string }>;
  readonly model?: string;
  readonly usage?: Readonly<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }>;
  /** Opaque host correlation. Ax stores tags and never interprets them. */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface AxLearningInteractionRecord {
  readonly kind: 'interaction';
  readonly id: AxLearningRecordId;
  readonly scenario: string;
  readonly createdAt: number;
  /**
   * OPTIONAL, and absent exactly when no harness tree was installed on the
   * agent at serve time. An absent ref means "this exchange is not attributable
   * to any release" — it is never fabricated from the store head. Never present
   * on reports.
   */
  readonly artifactRef?: Readonly<AxLearningArtifactRef>;
  readonly payload: Readonly<AxLearningInteractionPayload>;
}

export interface AxLearningReportPayload {
  /** Finite number. `boolean` is not a number and is rejected. */
  readonly score?: number;
  /** Opaque to the core; a processor interprets it. */
  readonly feedback?: string | Readonly<Record<string, AxLearningValue>>;
  /** Opaque EXCEPT `metadata.training.eligible` (default true). */
  readonly metadata?: Readonly<Record<string, AxLearningValue>>;
}

export interface AxLearningReportRecord {
  readonly kind: 'report';
  readonly id: AxLearningRecordId;
  readonly scenario: string;
  readonly createdAt: number;
  /** The receipts this report grades. Only interaction ids are receipts. */
  readonly references: readonly AxLearningRecordId[];
  readonly payload: Readonly<AxLearningReportPayload>;
}

export type AxLearningRecord =
  | Readonly<AxLearningInteractionRecord>
  | Readonly<AxLearningReportRecord>;

/** The caller-facing input to a report append. */
export interface AxLearningReportInput {
  readonly references: readonly AxLearningRecordId[];
  readonly score?: number;
  readonly feedback?: string | Readonly<Record<string, AxLearningValue>>;
  readonly metadata?: Readonly<Record<string, AxLearningValue>>;
  /** Client-chosen id for the report's OWN record. Makes the call retry-safe. Not a receipt. */
  readonly id?: AxLearningRecordId;
}

/** Returned to the caller of a recorded run. */
export interface AxLearningReceipt {
  readonly recordId: AxLearningRecordId;
  readonly scenario: string;
  /** Absent when no tree was installed — see `AxLearningInteractionRecord.artifactRef`. */
  readonly artifactRef?: Readonly<AxLearningArtifactRef>;
  readonly recordedAt: number;
  readonly durability: 'volatile' | 'persistent';
  /** True when the append deduped against an existing record. */
  readonly duplicate: boolean;
}

// ---------------------------------------------------------------------------
// 4.6 Harness tree entries (the functions over them land with `tree.ts`)
// ---------------------------------------------------------------------------

export type AxHarnessEntryKind = 'instruction' | 'playbookBullet' | 'skill';

/**
 * A proposer-authored bullet carries CONTENT ONLY. `helpfulCount`,
 * `harmfulCount`, `createdAt`, `updatedAt`, `revision`, `lineage` and
 * `evidence` are rejected by admission (not silently stripped) and are
 * synthesized by the installer: bullet evidence sits behind Ax's evaluator
 * boundary, and letting a proposer write it hands the model the pen.
 */
export interface AxHarnessBulletConfig {
  readonly id: string;
  readonly section: string;
  readonly content: string;
  readonly tags?: readonly string[];
}

export type AxHarnessEntry = Readonly<
  | {
      id: string;
      kind: 'instruction';
      disabled?: boolean;
      /** Installs into the executor stage's slot `learn:<entry id>`. */
      config: Readonly<{ text: string }>;
    }
  | {
      id: string;
      kind: 'playbookBullet';
      disabled?: boolean;
      config: Readonly<AxHarnessBulletConfig>;
    }
  | {
      id: string;
      kind: 'skill';
      disabled?: boolean;
      /**
       * Maps 1:1 onto `AxAgentCatalogSkill`: `skillId` → `id` (the dedup key
       * AND the path-segment-constrained name), `content` → `content`. `name`
       * is the human-readable title.
       */
      config: Readonly<{
        skillId: string;
        name: string;
        description?: string;
        content: string;
      }>;
    }
>;

export type AxHarnessTree = readonly AxHarnessEntry[];

/**
 * The comparable composition a tree renders to, over the three ax primitives
 * it addresses. Produced by `axRenderHarnessTree`, consumed by
 * `axApplyHarnessTree` and by candidate/current comparison.
 */
export interface AxHarnessRendering {
  /** The executor actor's composed instruction text. Absent when no instruction entry is enabled. */
  readonly instructions: Readonly<{ actor?: string }>;
  readonly playbook: Readonly<AxACEPlaybook>;
  readonly skills: readonly Readonly<AxAgentCatalogSkill>[];
}

/** Why one entry was refused admission. Closed; the report carries the path. */
export type AxHarnessAdmissionReason =
  | 'duplicate-entry-id'
  | 'invalid-entry-id'
  | 'unknown-kind'
  | 'empty-text'
  | 'invalid-name-segment'
  | 'non-json-config'
  | 'unknown-config-key'
  | 'forbidden-bullet-field'
  | 'inline-credential'
  | 'credential-shaped-literal'
  | 'duplicate-render-target'
  | 'oversized-entry'
  | 'oversized-tree';

export interface AxHarnessEntryInspection {
  readonly entryId: string;
  readonly admitted: boolean;
  readonly reasons: readonly Readonly<{
    reason: AxHarnessAdmissionReason;
    /** JSON path inside the entry, e.g. `config.metadata.apiKey`. NEVER the value. */
    path: string;
  }>[];
}

/**
 * Adjudication as data: every entry is inspected, so one bad entry does not
 * hide the verdict on the rest and a proposer gets a per-entry reason it can
 * act on.
 */
export interface AxHarnessAdmissionReport {
  readonly admitted: AxHarnessTree;
  readonly entries: readonly Readonly<AxHarnessEntryInspection>[];
  readonly ok: boolean;
}

export type AxHarnessMutation = Readonly<
  | { op: 'create'; id: string; options: Readonly<Omit<AxHarnessEntry, 'id'>> }
  /**
   * Shallow merge at the entry root, with `config` merged one level deeper so
   * a proposer can edit one bullet field without resupplying the rest. A
   * `null` value deletes the key. Root-level ids only (no `:`).
   */
  | { op: 'update'; id: string; options: Readonly<Record<string, unknown>> }
  | { op: 'remove'; id: string }
>;

/**
 * The playbook handle `axApplyHarnessTree` writes rendered bullets through.
 * Structural on purpose: the installer must not import the agent.
 */
export interface AxHarnessPlaybookHandle {
  getState(): AxPlaybookSnapshot;
  load(snapshot: Readonly<AxPlaybookSnapshot>): unknown;
}

/**
 * The structural port the installer writes through. `AxAgent` satisfies it.
 * Declared structurally so `src/ax/learn/apply.ts` takes no runtime dependency
 * on `src/ax/agent/`.
 */
export interface AxHarnessInstallTarget {
  setActorInstructionSlot(slot: string, text?: string): void;
  /** The slot's current text, so an install can be undone exactly. */
  getActorInstructionSlot?(slot: string): string | undefined;
  setSkillsCatalogSlot(
    slot: string,
    skills?: readonly Readonly<AxAgentCatalogSkill>[]
  ): void;
  /** The slot's current skills, so an install can be undone exactly. */
  getSkillsCatalogSlot?(
    slot: string
  ): readonly Readonly<AxAgentCatalogSkill>[] | undefined;
  getPlaybook(): AxHarnessPlaybookHandle | undefined;
  getSignature(): { toString(): string };
  /**
   * True when the target learns into its playbook after every completed run.
   * Installing a tree replaces the playbook, so a target that answers `true`
   * is refused without `acknowledgeContinuousPlaybookReset`.
   */
  hasContinuousPlaybookLearning?(): boolean;
}

export interface AxHarnessInstallation {
  readonly releaseId: string;
  readonly parentReleaseId?: string;
  /** contentId of the entry list installed here. This is what a record stamps. */
  readonly contentId: string;
  readonly installedAt: number;
  /**
   * How many playbook bullets the install replaced.
   *
   * A tree install replaces the playbook wholesale on any target that has a
   * playbook handle, so this counts whatever the prior snapshot held — host
   * bullets and run-accumulated ones alike. On a target that learns into its
   * playbook after every run the replacement is refused outright unless
   * `acknowledgeContinuousPlaybookReset` is set, so a continuous learner's
   * bullets are never discarded silently.
   */
  readonly discardedBulletCount: number;
  /** Restores the exact pre-install state through the same channels. Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 4.7 Releases
// ---------------------------------------------------------------------------

export interface AxHarnessGateMetrics {
  /** Per task, in task order. `null` marks an episode that could not run. */
  readonly candidateScores: readonly (number | null)[];
  readonly currentScores: readonly (number | null)[];
  readonly candidateScore: number | null;
  readonly currentScore: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly heldIn: Readonly<{ before: number; after: number }>;
  /** Absent ⇒ the step ran held-in-only. */
  readonly heldOut?: Readonly<{ before: number; after: number }>;
  /** sha256 over the sorted task ids of each split, frozen BEFORE `propose` ran. */
  readonly taskSetDigest: string;
  readonly heldOutTaskSetDigest?: string;
  readonly failures: Readonly<{
    new: readonly string[];
    persisting: readonly string[];
    fixed: readonly string[];
  }>;
  readonly episodeFailures: number;
  readonly batchId?: string;
  readonly processorId?: string;
}

export interface AxHarnessGateDecision {
  readonly outcome: 'select' | 'reject';
  readonly evaluator: 'harness_task_pairs' | (string & {});
  readonly evaluatorVersion: string;
  readonly policy: 'axPlaybookGate' | 'scoreComparison' | (string & {});
  readonly policyVersion: string;
  readonly reason: string;
  readonly metrics: Readonly<AxHarnessGateMetrics>;
  /** Additive seat for a promotion-authority receipt. Never set by Ax today. */
  readonly authority?: Readonly<AxAuthorizationReceipt>;
}

export interface AxLearningRelease {
  readonly releaseId: string;
  /** The isolated workload this chain belongs to. */
  readonly scenario: string;
  readonly parentReleaseId?: string;
  readonly contentId: string;
  /** Monotonic per scenario. Never rewound, including by rollback. */
  readonly step: number;
  readonly operation: 'creation' | 'evolve' | 'rollback' | 'recovery';
  /** TRUE only for the promoted head. An append always writes `false`. */
  readonly current: boolean;
  readonly restorable: boolean;
  readonly recordedAt: number;
  readonly promotedAt?: number;
  readonly entries: AxHarnessTree;
  /** The decision that nominated this release. Absent on `creation`. */
  readonly gate?: Readonly<AxHarnessGateDecision>;
  readonly rollbackTargetReleaseId?: string;
}

export interface AxLearningTreeDelivery {
  readonly releaseId: string;
  readonly parentReleaseId?: string;
  readonly contentId: string;
  readonly step: number;
  readonly entries: AxHarnessTree;
  readonly gate?: Readonly<AxHarnessGateDecision>;
}

// ---------------------------------------------------------------------------
// 4.3 Store port
// ---------------------------------------------------------------------------

export interface AxLearningStoreCapabilities {
  durability: 'volatile' | 'persistent';
  coordination: 'single-writer' | 'multi-writer';
  /** Chain appends and head promotions are compare-and-set. Required for a durable surface. */
  compareAndSet: boolean;
  conformance?: Readonly<{ schemaVersion?: number }>;
}

export interface AxLearningAppendResult {
  /**
   * The record the store considers authoritative:
   *   inserted            → the stored record
   *   duplicate           → the PREVIOUSLY stored record
   *   references-consumed → the submitted record, which was NOT stored
   */
  readonly record: AxLearningRecord;
  readonly inserted: boolean;
  /** Monotonic per scenario. Present only when `inserted`. */
  readonly sequence?: number;
  /** Why an append was a no-op. */
  readonly reason?: 'duplicate' | 'references-consumed';
}

export interface AxLearningStorePageEntry {
  readonly sequence: number;
  readonly record: AxLearningRecord;
}

export interface AxLearningStorePage {
  readonly entries: readonly Readonly<AxLearningStorePageEntry>[];
  /** Absent when the page reached the end of the log. */
  readonly nextAfterSequence?: number;
}

export interface AxLearningStore {
  readonly capabilities: Readonly<AxLearningStoreCapabilities>;
  /**
   * Clock used for store-owned timestamps. A surface constructed with its own
   * `clock` that is not this exact instance is refused at construction.
   */
  readonly clock?: AxEventClock;

  append(
    record: AxLearningRecord,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningAppendResult>>;

  get(
    scenario: string,
    id: AxLearningRecordId,
    signal?: AbortSignal
  ): Promise<AxLearningRecord | undefined>;

  page(
    scenario: string,
    options: Readonly<{ afterSequence?: number; limit?: number }>,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningStorePage>>;

  markConsumed(
    scenario: string,
    ids: readonly AxLearningRecordId[],
    signal?: AbortSignal
  ): Promise<void>;

  /**
   * Append a release to the chain. `expectedTailReleaseId` is `null` for the
   * first release. A stale expectation throws `AxLearningReleaseConflictError`.
   * Appending NEVER moves the head — every appended release is `current: false`.
   */
  putRelease(
    release: Readonly<AxLearningRelease>,
    expectedTailReleaseId: string | null,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>>;

  /**
   * Compare-and-set the scenario head. The ONLY way a release becomes current.
   * `expectedHeadReleaseId` is `null` when no release has been promoted yet.
   */
  promoteRelease(
    scenario: string,
    releaseId: string,
    expectedHeadReleaseId: string | null,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>>;

  /** The promoted release, or undefined when nothing has been promoted. */
  head(
    scenario: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease> | undefined>;

  /** Oldest first, promoted or not. */
  releases(
    scenario: string,
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxLearningRelease>[]>;

  close?(options?: Readonly<{ timeoutMs?: number }>): Promise<void>;
}

// ---------------------------------------------------------------------------
// 4.11 Errors
// ---------------------------------------------------------------------------

/** Same record id, different content. The store never silently overwrites. */
export class AxLearningRecordConflictError extends Error {
  readonly code = 'learning_record_conflict';

  constructor(
    readonly recordId: AxLearningRecordId,
    readonly scenario: string,
    options?: ErrorOptions
  ) {
    super(
      `AxLearningStore: record ${recordId} in scenario ${scenario} already exists with different content`,
      options
    );
    this.name = 'AxLearningRecordConflictError';
  }
}

/** Non-persistable or self-contradictory record content, rejected at construction. */
export class AxLearningRecordValidationError extends Error {
  readonly code = 'learning_record_invalid';
  /**
   * JSON path of the checked subtree inside the record — `payload.output`, not
   * `payload.output.at[2]`. The message names the offending node exactly; this
   * is the coarse field a caller routes on. Never the value.
   */
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AxLearningRecordValidationError';
    this.path = path;
  }
}

/** Report ingress refused: a bad reference, a bad score, or a declared field. */
export class AxLearningReportValidationError extends Error {
  readonly code = 'learning_report_invalid';
  /** The declared field that broke, or one of `references` / `score`. */
  readonly field: string;

  constructor(field: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AxLearningReportValidationError';
    this.field = field;
  }
}

/** Raised by `putRelease`, `promoteRelease` and rollback on a stale expectation. */
export class AxLearningReleaseConflictError extends Error {
  readonly code = 'learning_release_conflict';
  readonly operation: 'append' | 'promote';

  constructor(
    readonly scenario: string,
    operation: 'append' | 'promote',
    readonly expectedReleaseId: string | null,
    readonly actualReleaseId: string | null,
    options?: ErrorOptions
  ) {
    super(
      `AxLearningStore: ${operation} in scenario ${scenario} expected ${expectedReleaseId ?? 'none'} but found ${actualReleaseId ?? 'none'}`,
      options
    );
    this.name = 'AxLearningReleaseConflictError';
    this.operation = operation;
  }
}

/**
 * A rollback named a release that cannot be restored.
 *
 * Separate from `AxLearningReleaseConflictError`, which is about a stale CAS
 * expectation: this one says the target itself is disqualified. Typed and
 * guarded like every other error that crosses a host boundary, rather than a
 * bare `Error` a caller can only match on by message.
 */
export class AxLearningRollbackRefusedError extends Error {
  readonly code = 'learning_rollback_refused';

  constructor(
    readonly scenario: string,
    readonly releaseId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxLearningRollbackRefusedError';
  }
}

/**
 * A recorded run was attempted while recording is suspended.
 *
 * Thrown BEFORE the forward is issued: a caller that asked for a receipt must
 * never be handed a fake one, and a receipt without a durable record is
 * forbidden. The suppression is counted, never silently dropped.
 */
export class AxLearningSuppressedError extends Error {
  readonly code = 'learning_recording_suspended';

  constructor(readonly scenario: string) {
    super(
      `AxAgentLearning: recording is suspended for scenario ${scenario}; no receipt can be issued`
    );
    this.name = 'AxLearningSuppressedError';
  }
}

/**
 * An evolve step was configured in a way that cannot produce a sound verdict:
 * `requireHeldOut` with no validation split, a non-positive budget, an agent
 * whose pre-step installation could not be restored.
 *
 * Always thrown before any model call.
 */
export class AxHarnessEvolveConfigError extends Error {
  readonly code = 'harness_evolve_config_invalid';
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'AxHarnessEvolveConfigError';
    this.field = field;
  }
}

/** One entry failed admission. Carries the FIRST denial plus the full report. */
export class AxHarnessAdmissionError extends Error {
  readonly code = 'harness_admission_denied';
  readonly reason: AxHarnessAdmissionReason;
  readonly entryId: string;
  /** JSON path inside the entry, e.g. `config.tags[0]`. Never the value. */
  readonly path: string;
  /** The full per-entry verdict, so a caller sees what else would have passed. */
  readonly report: Readonly<AxHarnessAdmissionReport>;

  constructor(
    reason: AxHarnessAdmissionReason,
    entryId: string,
    path: string,
    report: Readonly<AxHarnessAdmissionReport>,
    options?: ErrorOptions
  ) {
    super(
      `AxHarnessTree: entry ${entryId} denied admission (${reason}) at ${path}`,
      options
    );
    this.name = 'AxHarnessAdmissionError';
    this.reason = reason;
    this.entryId = entryId;
    this.path = path;
    this.report = report;
  }
}

/** A mutation could not be applied. The whole batch is a no-op. */
export class AxHarnessMutationError extends Error {
  readonly code = 'harness_mutation_invalid';

  constructor(
    readonly op: AxHarnessMutation['op'],
    readonly id: string,
    message: string
  ) {
    super(message);
    this.name = 'AxHarnessMutationError';
  }
}

/** Two entries render onto the same target. Raised by render, not by admission. */
export class AxHarnessRenderError extends Error {
  readonly code = 'harness_render_conflict';

  constructor(
    readonly target: string,
    message: string
  ) {
    super(message);
    this.name = 'AxHarnessRenderError';
  }
}

/** A rendered tree could not be installed on the target. */
export class AxHarnessApplyError extends Error {
  readonly code = 'harness_apply_failed';
  readonly channel: 'instruction' | 'playbookBullet' | 'skill';

  constructor(
    channel: AxHarnessApplyError['channel'],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxHarnessApplyError';
    this.channel = channel;
  }
}

/**
 * Structural guard. `instanceof` breaks when a host store is loaded through a
 * second copy of the package, so the discriminant is the contract.
 */
export function axIsLearningRecordConflictError(
  error: unknown
): error is AxLearningRecordConflictError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'learning_record_conflict'
  );
}

/** Structural guard; see `axIsLearningRecordConflictError`. */
export function axIsLearningReleaseConflictError(
  error: unknown
): error is AxLearningReleaseConflictError {
  if (
    typeof error !== 'object' ||
    error === null ||
    (error as { code?: unknown }).code !== 'learning_release_conflict'
  ) {
    return false;
  }
  const operation = (error as { operation?: unknown }).operation;
  return operation === 'append' || operation === 'promote';
}

/** Structural guard; see `axIsLearningRecordConflictError`. */
export function axIsLearningRollbackRefusedError(
  error: unknown
): error is AxLearningRollbackRefusedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'learning_rollback_refused'
  );
}

/** Structural guard; see `axIsLearningRecordConflictError`. */
export function axIsHarnessAdmissionError(
  error: unknown
): error is AxHarnessAdmissionError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'harness_admission_denied'
  );
}

/** Structural guard; see `axIsLearningRecordConflictError`. */
export function axIsHarnessApplyError(
  error: unknown
): error is AxHarnessApplyError {
  if (
    typeof error !== 'object' ||
    error === null ||
    (error as { code?: unknown }).code !== 'harness_apply_failed'
  ) {
    return false;
  }
  const channel = (error as { channel?: unknown }).channel;
  return (
    channel === 'instruction' ||
    channel === 'playbookBullet' ||
    channel === 'skill'
  );
}
