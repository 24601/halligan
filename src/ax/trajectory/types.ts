import type { AxEventClock, AxEventValue } from '../event/types.js';

/**
 * Step field values reuse the event plane's value type. A second recursive
 * JSON type would be an alias whose conversion can only be the identity,
 * because every step crosses the plane as AxEventEnvelope.data.
 */
export type AxTrajectoryFieldValue = AxEventValue;

/**
 * One immutable line of the autobiography. Once appended, never modified.
 * `ts` is epoch milliseconds normalized at the boundary; a string timestamp
 * never enters the model, which removes the whole UTC-skew bug class.
 */
export interface AxTrajectoryStep {
  readonly stepId: string;
  readonly trajectoryId: string;
  /** Dense, gap-free, per-trajectory append index. Assigned by the store. */
  readonly seq: number;
  readonly type: string;
  readonly ts: number;
  /** The run header step whose stepId identifies this run. NEVER file position. */
  readonly runId?: string;
  /** The step that caused a thinker to fire. */
  readonly triggerStep?: string;
  /** The thinker's name. Explicitly NOT `source`; readers must not conflate. */
  readonly launchedBy?: string;
  /** Writer identity for narrative steps. Machinery steps never carry it. */
  readonly source?: string;
  readonly data: Readonly<Record<string, AxTrajectoryFieldValue>>;
  /** Fields whose full value lives in the blob store. */
  readonly blobs?: readonly Readonly<AxTrajectoryBlobRef>[];
}

/**
 * A spilled field. The step retains an inline head in `data[field]`;
 * `bytes` is the FULL size and `digest` identifies the exact bytes.
 * Readers that need the whole value MUST rehydrate (invariant I7).
 */
export interface AxTrajectoryBlobRef {
  readonly field: string;
  readonly ref: string;
  readonly bytes: number;
  /** SHA-256 of the full value. Verified on every resolve. */
  readonly digest: string;
  readonly inlineBytes: number;
  readonly truncated: true;
}

export interface AxTrajectoryAppendRequest {
  readonly trajectoryId: string;
  /** Preserved when preset — fork steps cross-reference a pre-generated id. */
  readonly stepId?: string;
  readonly type: string;
  readonly ts?: number;
  readonly runId?: string;
  readonly triggerStep?: string;
  readonly launchedBy?: string;
  readonly source?: string;
  readonly data?: Readonly<Record<string, AxTrajectoryFieldValue>>;
}

export interface AxTrajectoryAppendReceipt {
  readonly stepId: string;
  readonly seq: number;
  readonly ts: number;
  readonly durability: 'volatile' | 'persistent';
  readonly spilled: readonly string[];
  /** True when a preset stepId replayed an identical append. */
  readonly duplicate: boolean;
}

export interface AxTrajectoryHeader {
  readonly trajectoryId: string;
  readonly slug?: string;
  readonly createdAt: number;
  readonly parentTrajectoryId?: string;
  readonly parentStepId?: string;
  readonly depth: number;
}

/**
 * Narrative-vs-machinery is a REGISTRY PROPERTY, not an allowlist by omission.
 * A type with no descriptor resolves to 'unknown': excluded from projections
 * and unable to wake a thinker, but still readable and still appendable.
 */
export type AxTrajectoryStepClass =
  | 'narrative'
  | 'machinery'
  | 'structural'
  | 'unknown';

export interface AxTrajectoryTypeDescriptor {
  readonly type: string;
  readonly stepClass: AxTrajectoryStepClass;
  /** Part of a human conversation. */
  readonly conversational?: boolean;
  /** May an append of this type wake a thinker at all? */
  readonly wakeable: boolean;
  /** A pure wake signal: coalesces last-wins instead of queueing. */
  readonly wakeSignal?: boolean;
  /** May a step of this type carry `source`? Machinery types may not. */
  readonly carriesSource: boolean;
  /** Never re-triggers its own writer, even under triggerSelf. */
  readonly neverRetriggersSelf?: boolean;
  /** String fields eligible for size-based blob spill. */
  readonly spillFields?: readonly string[];
  /** Counts as visible work for pacing. */
  readonly visibleWork?: boolean;
}

export interface AxTrajectoryTypeRegistry {
  describe(type: string): Readonly<AxTrajectoryTypeDescriptor>;
  has(type: string): boolean;
  readonly types: readonly Readonly<AxTrajectoryTypeDescriptor>[];
}

export class AxTrajectoryAppendError extends Error {
  readonly code = 'trajectory_append_failed';
  constructor(
    message: string,
    readonly phase: 'validate' | 'blob' | 'commit' | 'index',
    /** Closed set; `source_on_machinery_step` fails closed at the write boundary. */
    readonly reason:
      | 'duplicate_step_id'
      | 'source_on_machinery_step'
      | 'unknown_trajectory'
      | 'blob_write_failed'
      | 'invalid_field'
      | 'store_failure',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryAppendError';
  }
}

export class AxTrajectoryCursorError extends Error {
  readonly code = 'trajectory_cursor_invalid';
  constructor(
    message: string,
    readonly reason:
      | 'identity_changed'
      | 'beyond_end'
      | 'not_a_frame_boundary'
      | 'shrank'
      | 'unknown_trajectory',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryCursorError';
  }
}

export class AxTrajectoryBlobError extends Error {
  readonly code = 'trajectory_blob_failed';
  constructor(
    message: string,
    readonly reason: 'missing' | 'digest_mismatch' | 'write_failed',
    readonly ref: string,
    readonly digest?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryBlobError';
  }
}

export class AxTrajectoryForkError extends Error {
  readonly code = 'trajectory_fork_invalid';
  constructor(
    message: string,
    /**
     * `cycle` is for a store that accepts a caller-supplied child id. Neither
     * shipped store does -- both generate the child id -- so neither can
     * raise it, and neither pretends to with an unreachable branch.
     */
    readonly reason: 'unknown_parent' | 'cycle' | 'depth_exceeded',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryForkError';
  }
}

/**
 * Declared here by RFC 4.3 and thrown by the projection lane, not this one:
 * sealing is what raises it. Exported a lane early so the error surface is
 * complete and stable rather than growing under a consumer.
 */
export class AxTrajectoryRollupError extends Error {
  readonly code = 'trajectory_rollup_invalid';
  constructor(
    message: string,
    readonly reason:
      | 'block_already_sealed'
      | 'summarizer_failed'
      | 'meta_conflict',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryRollupError';
  }
}

/**
 * Registry construction failed. Kept separate from append failures because a
 * bad descriptor table is a configuration fault, not a write fault.
 */
export class AxTrajectoryRegistryError extends Error {
  readonly code = 'trajectory_registry_invalid';
  constructor(
    message: string,
    readonly reason: 'duplicate_type' | 'protected_flag' | 'invalid_descriptor',
    readonly type: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryRegistryError';
  }
}

/**
 * A read primitive was asked for an unbounded or oversized result.
 * Invariant I12 has no other way to fail closed at the read boundary.
 */
export class AxTrajectoryQueryError extends Error {
  readonly code = 'trajectory_query_invalid';
  constructor(
    message: string,
    readonly reason:
      | 'unbounded_read'
      | 'too_many_ids'
      | 'invalid_range'
      | 'unknown_trajectory',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxTrajectoryQueryError';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/** Structural guards, for errors that cross a host/adapter/realm boundary. */
export function axIsTrajectoryAppendError(
  error: unknown
): error is AxTrajectoryAppendError {
  return (
    hasCode(error, 'trajectory_append_failed') &&
    typeof (error as AxTrajectoryAppendError).reason === 'string' &&
    typeof (error as AxTrajectoryAppendError).phase === 'string'
  );
}

export function axIsTrajectoryCursorError(
  error: unknown
): error is AxTrajectoryCursorError {
  return (
    hasCode(error, 'trajectory_cursor_invalid') &&
    typeof (error as AxTrajectoryCursorError).reason === 'string'
  );
}

export function axIsTrajectoryBlobError(
  error: unknown
): error is AxTrajectoryBlobError {
  return (
    hasCode(error, 'trajectory_blob_failed') &&
    typeof (error as AxTrajectoryBlobError).reason === 'string' &&
    typeof (error as AxTrajectoryBlobError).ref === 'string'
  );
}

export function axIsTrajectoryQueryError(
  error: unknown
): error is AxTrajectoryQueryError {
  return (
    hasCode(error, 'trajectory_query_invalid') &&
    typeof (error as AxTrajectoryQueryError).reason === 'string'
  );
}

export interface AxTrajectoryStoreCapabilities {
  readonly durability: 'volatile' | 'persistent';
  readonly coordination: 'single-writer' | 'multi-writer';
  /** Appends are atomic against concurrent writers and torn reads. */
  readonly appendAtomicity: boolean;
  readonly blobs: boolean;
  /** readFrom() accepts an opaque resumable token beyond `seq`. */
  readonly cursorTokens: boolean;
  /** Durable per-consumer cursors (loadCursor/saveCursor) are honoured. */
  readonly consumerCursors: boolean;
  /** Set ONLY by a store that passes runAxTrajectoryStoreConformance. */
  readonly conformance?: Readonly<{
    schemaVersion?: number;
    /** Reserved for v2. Nothing sets it in v1. */
    multiWriter?: string;
  }>;
}

/** `seq` is the portable position; `token` is an optional store-private fast path. */
export interface AxTrajectoryCursor {
  readonly trajectoryId: string;
  readonly seq: number;
  readonly token?: string;
}

export interface AxTrajectoryReadQuery {
  readonly trajectoryId: string;
  readonly fromSeq?: number;
  readonly toSeq?: number;
  /** Required unless BOTH fromSeq and toSeq are given (invariant I12). */
  readonly limit?: number;
  readonly types?: readonly string[];
  readonly classes?: readonly AxTrajectoryStepClass[];
}

/**
 * The only unbounded-safe backward primitive: read backwards until `limit`
 * matching steps are found, `maxScan` steps have been examined, or the head
 * is reached. Reports both, so a caller can tell "no more matches" from
 * "budget spent" — precisely what a fixed line window could not.
 */
export interface AxTrajectoryTailQuery {
  readonly trajectoryId: string;
  readonly limit: number;
  readonly types?: readonly string[];
  readonly classes?: readonly AxTrajectoryStepClass[];
  /** Hard ceiling on steps examined. Defaults to max(200, 20 * limit). */
  readonly maxScan?: number;
  /** Exclusive upper bound, for the before/after work probe. */
  readonly beforeSeq?: number;
}

export interface AxTrajectoryTailResult {
  /** Oldest-first, so callers never re-reverse. */
  readonly steps: readonly Readonly<AxTrajectoryStep>[];
  readonly scanned: number;
  /** True when the head was reached before the budget ran out. */
  readonly exhausted: boolean;
}

export interface AxTrajectoryDrainBudget {
  readonly maxSteps?: number;
  readonly maxBytes?: number;
}

export interface AxTrajectoryDrainResult {
  readonly steps: readonly Readonly<AxTrajectoryStep>[];
  readonly cursor: Readonly<AxTrajectoryCursor>;
  readonly caughtUp: boolean;
  /** Frames skipped by the tolerant parser. Never fatal; always reported. */
  readonly corrupt: number;
}

export interface AxTrajectoryStats {
  readonly trajectoryId: string;
  readonly stepCount: number;
  readonly newestSeq: number;
  readonly newestTs: number;
  readonly newestStepId: string;
  readonly newestByClass: Readonly<
    Partial<
      Record<
        AxTrajectoryStepClass,
        Readonly<{ seq: number; stepId: string; ts: number }>
      >
    >
  >;
}

export interface AxTrajectoryForkRequest {
  readonly parentTrajectoryId: string;
  readonly slug?: string;
  readonly maxDepth?: number;
  readonly data?: Readonly<Record<string, AxTrajectoryFieldValue>>;
}

export interface AxTrajectoryForkResult {
  readonly childTrajectoryId: string;
  /** Pre-generated so parent and child cross-reference each other. */
  readonly forkStepId: string;
  readonly depth: number;
}

export interface AxTrajectoryMergeRequest {
  readonly parentTrajectoryId: string;
  readonly childTrajectoryId: string;
  readonly content: string;
  /** Failure merges back too: '(max turns reached)', '(stalled: ...)'. */
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
}

export interface AxTrajectoryCreateRequest {
  readonly trajectoryId?: string;
  readonly slug?: string;
  readonly data?: Readonly<Record<string, AxTrajectoryFieldValue>>;
}

export interface AxTrajectoryStore {
  readonly capabilities: Readonly<AxTrajectoryStoreCapabilities>;
  /** Adopted by a host when it is given no clock; both must be one instance. */
  readonly clock: AxEventClock;

  create(
    request: Readonly<AxTrajectoryCreateRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryHeader>>;

  getTrajectory(
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryHeader> | undefined>;

  /** Atomic against concurrent appends. Never partially visible. */
  append(
    request: Readonly<AxTrajectoryAppendRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryAppendReceipt>>;

  read(
    query: Readonly<AxTrajectoryReadQuery>,
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxTrajectoryStep>[]>;

  tailBackward(
    query: Readonly<AxTrajectoryTailQuery>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryTailResult>>;

  /** Drill-down by cited id. Without this the tiered index is unusable. */
  getStep(
    trajectoryId: string,
    stepId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep> | undefined>;

  getSteps(
    trajectoryId: string,
    stepIds: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxTrajectoryStep>[]>;

  readFrom(
    cursor: Readonly<AxTrajectoryCursor> | undefined,
    trajectoryId: string,
    budget: Readonly<AxTrajectoryDrainBudget>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryDrainResult>>;

  stats(
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStats> | undefined>;

  fork(
    request: Readonly<AxTrajectoryForkRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryForkResult>>;

  merge(
    request: Readonly<AxTrajectoryMergeRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryAppendReceipt>>;

  /**
   * Durable per-consumer cursors. One consumer per reader, so a deferral on a
   * slow consumer never costs another consumer its position.
   */
  loadCursor(
    consumerId: string,
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryCursor> | undefined>;

  saveCursor(
    consumerId: string,
    cursor: Readonly<AxTrajectoryCursor>,
    signal?: AbortSignal
  ): Promise<void>;

  /** Undefined when capabilities.blobs is false. */
  readonly blobs?: AxTrajectoryBlobStore;

  close?(options?: Readonly<{ timeoutMs?: number }>): void | Promise<void>;
}

export interface AxTrajectoryBlobPutRequest {
  readonly trajectoryId: string;
  readonly stepId: string;
  readonly field: string;
  readonly value: string;
}

export interface AxTrajectoryBlobStore {
  put(
    request: Readonly<AxTrajectoryBlobPutRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<{ ref: string; bytes: number; digest: string }>>;
  /** Verifies the digest and throws AxTrajectoryBlobError on mismatch. */
  get(ref: string, digest: string, signal?: AbortSignal): Promise<string>;
  delete?(ref: string, signal?: AbortSignal): Promise<void>;
}

/** Maximum ids accepted by getSteps in one call (invariant I12). */
export const axTrajectoryMaxStepIds = 256;
