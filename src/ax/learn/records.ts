/**
 * Learning-record construction, validation, and canonical content.
 *
 * A record is the one durable entity the whole loop is derived from, so it is
 * validated the moment it is built rather than at some later dedupe or digest:
 * `axEventCanonicalJson` is `JSON.stringify` over a key-sorted normalize and
 * would silently coerce a `Date`, flatten a `Map`, and turn a `NaN` into
 * `null`. Every caller-supplied value therefore passes
 * `axAssertPersistableValue` first, and a failure names the JSON path.
 */

import { axEventCanonicalJson } from '../event/util.js';
import { axAssertPersistableValue } from '../util/persistable.js';

import {
  type AxLearningAppendResult,
  type AxLearningArtifactRef,
  type AxLearningInteractionPayload,
  type AxLearningInteractionRecord,
  type AxLearningReceipt,
  type AxLearningRecord,
  type AxLearningRecordId,
  AxLearningRecordValidationError,
  type AxLearningReportInput,
  type AxLearningReportRecord,
  type AxLearningStoreCapabilities,
  type AxLearningValue,
} from './types.js';

/** The fields a caller may hand to an interaction record. */
export interface AxLearningInteractionInput {
  readonly id: AxLearningRecordId;
  readonly scenario: string;
  readonly createdAt: number;
  /** Copied from the live installation. Absent when no tree was installed. */
  readonly artifactRef?: Readonly<AxLearningArtifactRef>;
  readonly signature: string;
  readonly programId: string;
  readonly input: AxLearningValue;
  /** Mutually exclusive with `failure`. */
  readonly output?: AxLearningValue;
  /** The thrown value of a failed run. Normalized to `{ name, message }`. */
  readonly failure?: unknown;
  readonly model?: string;
  readonly usage?: Readonly<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }>;
  readonly tags?: Readonly<Record<string, string>>;
}

/** The fields a caller may hand to a report record. */
export interface AxLearningReportRecordInput {
  readonly id: AxLearningRecordId;
  readonly scenario: string;
  readonly createdAt: number;
  readonly input: Readonly<AxLearningReportInput>;
}

function requireNonEmpty(value: string, path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AxLearningRecordValidationError(
      path,
      `AxLearningRecord: ${path} must be a non-empty string`
    );
  }
}

function requireFinite(value: number, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AxLearningRecordValidationError(
      path,
      `AxLearningRecord: ${path} must be a finite number`
    );
  }
}

function assertPersistable(value: unknown, path: string): void {
  try {
    axAssertPersistableValue(value, path, { label: 'AxLearningRecord value' });
  } catch (error) {
    throw new AxLearningRecordValidationError(
      path,
      error instanceof Error ? error.message : String(error),
      { cause: error }
    );
  }
}

/**
 * Reduce a thrown value to the two fields a record may carry.
 *
 * A stack is deliberately dropped: records are persisted verbatim, shipped to a
 * proposer, and read by whoever pulls the scenario, and a stack carries
 * filesystem paths from the serving host.
 */
export function axLearningFailureFrom(
  error: unknown
): Readonly<{ name: string; message: string }> {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name || 'Error',
      message: error.message,
    });
  }
  return Object.freeze({ name: 'Error', message: String(error) });
}

function validateArtifactRef(ref: Readonly<AxLearningArtifactRef>): void {
  requireNonEmpty(ref.releaseId, 'artifactRef.releaseId');
  requireNonEmpty(ref.contentId, 'artifactRef.contentId');
  if (
    ref.parentReleaseId !== undefined &&
    ref.parentReleaseId.trim().length === 0
  ) {
    throw new AxLearningRecordValidationError(
      'artifactRef.parentReleaseId',
      'AxLearningRecord: parentReleaseId must be a non-empty string when present'
    );
  }
  if (typeof ref.stale !== 'boolean') {
    throw new AxLearningRecordValidationError(
      'artifactRef.stale',
      'AxLearningRecord: stale must be a boolean'
    );
  }
  // I1b: `stale` is DERIVED — `contentId !== headContentId` — not an opinion.
  // Taking a caller's word for it would let a serve under a superseded tree be
  // stamped fresh, which is exactly the mismatch this record exists to expose.
  // With no observed head there is nothing to compare against, so the claim is
  // the producer's and is left alone.
  if (ref.headContentId !== undefined) {
    requireNonEmpty(ref.headContentId, 'artifactRef.headContentId');
    const mismatched = ref.contentId !== ref.headContentId;
    if (ref.stale !== mismatched) {
      throw new AxLearningRecordValidationError(
        'artifactRef.stale',
        `AxLearningRecord: stale must be ${mismatched} when contentId ${
          mismatched ? 'differs from' : 'equals'
        } headContentId`
      );
    }
  }
}

/**
 * Build a validated interaction record.
 *
 * Exactly one of `output` / `failure` must be present: a record with both would
 * claim the run succeeded and failed, and a record with neither is not an
 * observation of anything.
 */
export function axCreateLearningInteractionRecord(
  args: Readonly<AxLearningInteractionInput>
): Readonly<AxLearningInteractionRecord> {
  requireNonEmpty(args.id, 'id');
  requireNonEmpty(args.scenario, 'scenario');
  requireFinite(args.createdAt, 'createdAt');
  requireNonEmpty(args.signature, 'payload.signature');
  requireNonEmpty(args.programId, 'payload.programId');

  const hasOutput = args.output !== undefined;
  const hasFailure = args.failure !== undefined;
  if (hasOutput === hasFailure) {
    throw new AxLearningRecordValidationError(
      'payload',
      hasOutput
        ? 'AxLearningRecord: an interaction carries either output or failure, never both'
        : 'AxLearningRecord: an interaction requires either output or failure'
    );
  }

  assertPersistable(args.input, 'payload.input');
  if (hasOutput) assertPersistable(args.output, 'payload.output');
  if (args.tags !== undefined) assertPersistable(args.tags, 'payload.tags');
  if (args.usage !== undefined) {
    for (const key of [
      'promptTokens',
      'completionTokens',
      'totalTokens',
    ] as const) {
      const value = args.usage[key];
      if (value !== undefined) requireFinite(value, `payload.usage.${key}`);
    }
  }
  if (args.model !== undefined) {
    requireNonEmpty(args.model, 'payload.model');
  }
  if (args.artifactRef !== undefined) validateArtifactRef(args.artifactRef);

  const payload: AxLearningInteractionPayload = {
    signature: args.signature,
    programId: args.programId,
    input: args.input,
    ...(hasOutput ? { output: args.output } : {}),
    ...(hasFailure ? { failure: axLearningFailureFrom(args.failure) } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.usage === undefined ? {} : { usage: { ...args.usage } }),
    ...(args.tags === undefined ? {} : { tags: { ...args.tags } }),
  };

  return Object.freeze({
    kind: 'interaction' as const,
    id: args.id,
    scenario: args.scenario,
    createdAt: args.createdAt,
    ...(args.artifactRef === undefined
      ? {}
      : { artifactRef: Object.freeze({ ...args.artifactRef }) }),
    payload: Object.freeze(payload),
  });
}

/**
 * Build a validated report record.
 *
 * The payload is constructed from exactly `score`, `feedback` and `metadata`:
 * unknown top-level keys are dropped rather than persisted, because a report's
 * method data belongs under `feedback` or `metadata` where a processor can find
 * it. A boolean `score` is refused outright — a boolean is not a number, and
 * accepting one would silently rank `true` above `false`.
 */
export function axCreateLearningReportRecord(
  args: Readonly<AxLearningReportRecordInput>
): Readonly<AxLearningReportRecord> {
  requireNonEmpty(args.id, 'id');
  requireNonEmpty(args.scenario, 'scenario');
  requireFinite(args.createdAt, 'createdAt');

  const { references, score, feedback, metadata } = args.input;
  if (!Array.isArray(references)) {
    throw new AxLearningRecordValidationError(
      'references',
      'AxLearningRecord: references must be an array of record ids'
    );
  }
  references.forEach((reference, index) =>
    requireNonEmpty(reference, `references[${index}]`)
  );

  if (score !== undefined) {
    if (typeof score === 'boolean') {
      throw new AxLearningRecordValidationError(
        'payload.score',
        'AxLearningRecord: score must be a number; a boolean is not a score'
      );
    }
    requireFinite(score, 'payload.score');
  }
  if (feedback !== undefined) assertPersistable(feedback, 'payload.feedback');
  if (metadata !== undefined) assertPersistable(metadata, 'payload.metadata');

  return Object.freeze({
    kind: 'report' as const,
    id: args.id,
    scenario: args.scenario,
    createdAt: args.createdAt,
    references: Object.freeze([...references]),
    payload: Object.freeze({
      ...(score === undefined ? {} : { score }),
      ...(feedback === undefined ? {} : { feedback }),
      ...(metadata === undefined ? {} : { metadata }),
    }),
  });
}

/**
 * The canonical bytes two records with the same id are compared on.
 *
 * `createdAt` is excluded: a retried append of the same observation is the same
 * observation even though the caller's clock moved, and treating it as a
 * conflict would make an at-least-once caller unable to retry.
 */
export function axLearningRecordContent(
  record: Readonly<AxLearningRecord>
): string {
  return axEventCanonicalJson(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== 'createdAt')
    )
  );
}

/** Build the caller-facing receipt for an append that has already settled. */
export function axLearningReceiptFrom(
  result: Readonly<AxLearningAppendResult>,
  durability: AxLearningStoreCapabilities['durability']
): Readonly<AxLearningReceipt> {
  const { record } = result;
  const artifactRef =
    record.kind === 'interaction' ? record.artifactRef : undefined;
  return Object.freeze({
    recordId: record.id,
    scenario: record.scenario,
    ...(artifactRef === undefined ? {} : { artifactRef }),
    recordedAt: record.createdAt,
    durability,
    duplicate: result.reason === 'duplicate',
  });
}
