import type { AxEventClock } from '../event/types.js';
import { AxSystemEventClock } from '../event/types.js';
import { axEventCanonicalDigest } from '../event/util.js';
import { axTrajectoryTypeRegistry } from './registry.js';
import {
  type AxTrajectorySpillPolicy,
  axSpillTrajectoryFields,
} from './spill.js';
import {
  AxTrajectoryAppendError,
  type AxTrajectoryAppendReceipt,
  type AxTrajectoryAppendRequest,
  AxTrajectoryBlobError,
  type AxTrajectoryBlobPutRequest,
  type AxTrajectoryBlobStore,
  type AxTrajectoryCreateRequest,
  type AxTrajectoryCursor,
  AxTrajectoryCursorError,
  type AxTrajectoryDrainBudget,
  type AxTrajectoryDrainResult,
  AxTrajectoryForkError,
  type AxTrajectoryForkRequest,
  type AxTrajectoryForkResult,
  type AxTrajectoryHeader,
  type AxTrajectoryMergeRequest,
  AxTrajectoryQueryError,
  type AxTrajectoryReadQuery,
  type AxTrajectoryStats,
  type AxTrajectoryStep,
  type AxTrajectoryStepClass,
  type AxTrajectoryStore,
  type AxTrajectoryStoreCapabilities,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTailResult,
  type AxTrajectoryTypeRegistry,
  axTrajectoryMaxStepIds,
} from './types.js';
import {
  axNormalizeTrajectoryTimestamp,
  axTrajectoryCompactData,
  axTrajectoryId,
  axTrajectoryInvalidFieldPath,
  axTrajectoryStepBytes,
  axTrajectoryStepFingerprint,
  axTrajectoryUtf8ByteLength,
} from './util.js';

const DEFAULT_DRAIN_STEPS = 256;
const DEFAULT_DRAIN_BYTES = 1024 * 1024;

type AppendPhase = ConstructorParameters<typeof AxTrajectoryAppendError>[1];
type AppendReason = ConstructorParameters<typeof AxTrajectoryAppendError>[2];
type CursorReason = ConstructorParameters<typeof AxTrajectoryCursorError>[1];
type QueryReason = ConstructorParameters<typeof AxTrajectoryQueryError>[1];
type ForkReason = ConstructorParameters<typeof AxTrajectoryForkError>[1];

function failAppend(
  message: string,
  phase: AppendPhase,
  reason: AppendReason,
  options?: ErrorOptions
): never {
  throw new AxTrajectoryAppendError(message, phase, reason, options);
}

function failCursor(message: string, reason: CursorReason): never {
  throw new AxTrajectoryCursorError(message, reason);
}

function failQuery(message: string, reason: QueryReason): never {
  throw new AxTrajectoryQueryError(message, reason);
}

function failFork(message: string, reason: ForkReason): never {
  throw new AxTrajectoryForkError(message, reason);
}

/** Content-addressed volatile blob store. Identical bytes share one ref. */
export class AxInMemoryTrajectoryBlobStore implements AxTrajectoryBlobStore {
  private readonly values = new Map<string, string>();

  async put(
    request: Readonly<AxTrajectoryBlobPutRequest>,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    const digest = await axEventCanonicalDigest(request.value);
    const ref = `blob-${digest}`;
    this.values.set(ref, request.value);
    return { ref, bytes: axTrajectoryUtf8ByteLength(request.value), digest };
  }

  async get(ref: string, digest: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const value = this.values.get(ref);
    if (value === undefined) {
      throw new AxTrajectoryBlobError(
        `blob ${ref} is missing`,
        'missing',
        ref,
        digest
      );
    }
    if ((await axEventCanonicalDigest(value)) !== digest) {
      throw new AxTrajectoryBlobError(
        `blob ${ref} failed digest verification`,
        'digest_mismatch',
        ref,
        digest
      );
    }
    return value;
  }

  async delete(ref: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.values.delete(ref);
  }
}

export interface AxInMemoryTrajectoryStoreOptions {
  readonly clock?: AxEventClock;
  readonly registry?: AxTrajectoryTypeRegistry;
  readonly spill?: Readonly<AxTrajectorySpillPolicy>;
  /** Host-supplied blob backend. Defaults to the volatile reference store. */
  readonly blobs?: AxTrajectoryBlobStore;
  readonly maxSteps?: number;
  readonly maxBytes?: number;
}

interface TrajectoryRecord {
  readonly header: AxTrajectoryHeader;
  /** Instance identity carried in cursor tokens so a recreated log is caught. */
  readonly identity: string;
  readonly steps: AxTrajectoryStep[];
  readonly byId: Map<string, AxTrajectoryStep>;
  readonly fingerprints: Map<string, string>;
  readonly newestByClass: Map<
    AxTrajectoryStepClass,
    { seq: number; stepId: string; ts: number }
  >;
  bytes: number;
  corruptTail: number;
}

function newRecord(header: AxTrajectoryHeader): TrajectoryRecord {
  return {
    header,
    identity: axTrajectoryId('inst'),
    steps: [],
    byId: new Map(),
    fingerprints: new Map(),
    newestByClass: new Map(),
    bytes: 0,
    corruptTail: 0,
  };
}

/**
 * Reference implementation of the append-only step log. Volatile by
 * declaration: it exists so hosts have something to run tests against and so
 * `runAxTrajectoryStoreConformance` has a second implementation to hold a
 * durable store against.
 */
export class AxInMemoryTrajectoryStore implements AxTrajectoryStore {
  readonly capabilities: Readonly<AxTrajectoryStoreCapabilities> =
    Object.freeze({
      durability: 'volatile',
      coordination: 'single-writer',
      appendAtomicity: true,
      blobs: true,
      cursorTokens: true,
      consumerCursors: true,
      conformance: Object.freeze({ schemaVersion: 1 }),
    } as const);

  readonly clock: AxEventClock;
  readonly blobs: AxTrajectoryBlobStore;

  private readonly registry: AxTrajectoryTypeRegistry;
  private readonly spill?: Readonly<AxTrajectorySpillPolicy>;
  private readonly maxSteps?: number;
  private readonly maxBytes?: number;
  private readonly records = new Map<string, TrajectoryRecord>();
  private readonly cursors = new Map<string, AxTrajectoryCursor>();
  private queue: Promise<unknown> = Promise.resolve();
  private blobFailures = 0;
  private closed = false;

  constructor(options?: Readonly<AxInMemoryTrajectoryStoreOptions>) {
    this.clock = options?.clock ?? new AxSystemEventClock();
    this.registry = options?.registry ?? axTrajectoryTypeRegistry();
    this.spill = options?.spill;
    this.blobs = options?.blobs ?? new AxInMemoryTrajectoryBlobStore();
    this.maxSteps = options?.maxSteps;
    this.maxBytes = options?.maxBytes;
  }

  /**
   * Fault seam: make the next blob write fail. Exposed so the shipped
   * conformance kit can prove blob durability precedes step visibility (I2)
   * against the reference implementation, not only against a file store.
   */
  failNextBlobWrite(): void {
    this.blobFailures++;
  }

  /**
   * Fault seam mirroring a torn trailing write in a file-backed store: the
   * frame is never returned by a read and is counted in `readFrom().corrupt`.
   */
  injectCorruptTrailingFrame(trajectoryId: string): void {
    this.record(trajectoryId).corruptTail++;
  }

  async create(
    request: Readonly<AxTrajectoryCreateRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryHeader>> {
    signal?.throwIfAborted();
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const trajectoryId = request.trajectoryId ?? axTrajectoryId('traj');
      const existing = this.records.get(trajectoryId);
      if (existing) return existing.header;
      const header: AxTrajectoryHeader = {
        trajectoryId,
        slug: request.slug,
        createdAt: this.clock.now(),
        depth: 0,
      };
      this.records.set(trajectoryId, newRecord(header));
      const data = { ...request.data };
      if (request.slug !== undefined) data.slug = request.slug;
      await this.write({ trajectoryId, type: 'trajectory', data }, signal);
      return header;
    });
  }

  async getTrajectory(trajectoryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.records.get(trajectoryId)?.header;
  }

  async append(
    request: Readonly<AxTrajectoryAppendRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryAppendReceipt>> {
    signal?.throwIfAborted();
    this.assertOpen();
    return this.serialize(() => {
      signal?.throwIfAborted();
      return this.write(request, signal);
    });
  }

  async read(
    query: Readonly<AxTrajectoryReadQuery>,
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxTrajectoryStep>[]> {
    signal?.throwIfAborted();
    const record = this.record(query.trajectoryId);
    if (
      query.limit === undefined &&
      (query.fromSeq === undefined || query.toSeq === undefined)
    ) {
      failQuery(
        'read requires a limit unless both fromSeq and toSeq are given',
        'unbounded_read'
      );
    }
    const from = Math.max(0, query.fromSeq ?? 0);
    const to = Math.min(
      record.steps.length,
      query.toSeq ?? record.steps.length
    );
    if (to < from)
      failQuery(`read range ${from}..${to} is inverted`, 'invalid_range');
    const matches = this.matcher(query.types, query.classes);
    const out: AxTrajectoryStep[] = [];
    for (let seq = from; seq < to; seq++) {
      const step = record.steps[seq]!;
      if (!matches(step)) continue;
      out.push(step);
      if (query.limit !== undefined && out.length >= query.limit) break;
    }
    return out;
  }

  async tailBackward(
    query: Readonly<AxTrajectoryTailQuery>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryTailResult>> {
    signal?.throwIfAborted();
    const record = this.record(query.trajectoryId);
    const matches = this.matcher(query.types, query.classes);
    const maxScan = query.maxScan ?? Math.max(200, 20 * query.limit);
    const chunkSize = Math.max(64, query.limit * 4);
    let cursor = Math.min(
      query.beforeSeq ?? record.steps.length,
      record.steps.length
    );
    let scanned = 0;
    const found: AxTrajectoryStep[] = [];
    while (found.length < query.limit && scanned < maxScan && cursor > 0) {
      const size = Math.min(chunkSize, cursor, maxScan - scanned);
      if (size <= 0) break;
      let examined = 0;
      for (let offset = 1; offset <= size; offset++) {
        const step = record.steps[cursor - offset]!;
        scanned++;
        examined++;
        if (matches(step)) found.push(step);
        if (found.length >= query.limit) break;
      }
      // Decrement by what was actually examined, so `exhausted` means the head
      // was reached rather than "the last chunk happened to be large".
      cursor -= examined;
    }
    return { steps: found.reverse(), scanned, exhausted: cursor === 0 };
  }

  async getStep(trajectoryId: string, stepId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.record(trajectoryId).byId.get(stepId);
  }

  async getSteps(
    trajectoryId: string,
    stepIds: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxTrajectoryStep>[]> {
    signal?.throwIfAborted();
    if (stepIds.length > axTrajectoryMaxStepIds) {
      failQuery(
        `getSteps accepts at most ${axTrajectoryMaxStepIds} ids, got ${stepIds.length}`,
        'too_many_ids'
      );
    }
    const record = this.record(trajectoryId);
    const out: AxTrajectoryStep[] = [];
    for (const stepId of stepIds) {
      const step = record.byId.get(stepId);
      if (step) out.push(step);
    }
    return out;
  }

  async readFrom(
    cursor: Readonly<AxTrajectoryCursor> | undefined,
    trajectoryId: string,
    budget: Readonly<AxTrajectoryDrainBudget>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryDrainResult>> {
    signal?.throwIfAborted();
    const record = this.record(trajectoryId);
    const maxSteps = budget.maxSteps ?? DEFAULT_DRAIN_STEPS;
    const maxBytes = budget.maxBytes ?? DEFAULT_DRAIN_BYTES;
    const steps: AxTrajectoryStep[] = [];
    let seq = this.validateCursor(record, trajectoryId, cursor);
    let bytes = 0;
    while (seq < record.steps.length && steps.length < maxSteps) {
      const step = record.steps[seq]!;
      const size = axTrajectoryStepBytes(step);
      if (steps.length > 0 && bytes + size > maxBytes) break;
      steps.push(step);
      bytes += size;
      seq++;
    }
    const caughtUp = seq === record.steps.length;
    return {
      steps,
      cursor: { trajectoryId, seq, token: `${record.identity}:${seq}` },
      caughtUp,
      corrupt: caughtUp ? record.corruptTail : 0,
    };
  }

  async stats(
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStats> | undefined> {
    signal?.throwIfAborted();
    const record = this.records.get(trajectoryId);
    if (!record) return undefined;
    const newest = record.steps[record.steps.length - 1];
    return {
      trajectoryId,
      stepCount: record.steps.length,
      newestSeq: newest ? newest.seq : -1,
      newestTs: newest ? newest.ts : 0,
      newestStepId: newest ? newest.stepId : '',
      newestByClass: Object.fromEntries(record.newestByClass),
    };
  }

  async fork(
    request: Readonly<AxTrajectoryForkRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryForkResult>> {
    signal?.throwIfAborted();
    return this.serialize(async () => {
      const parent = this.records.get(request.parentTrajectoryId);
      if (!parent) {
        failFork(
          `unknown parent trajectory ${request.parentTrajectoryId}`,
          'unknown_parent'
        );
      }
      const depth = parent.header.depth + 1;
      if (request.maxDepth !== undefined && depth > request.maxDepth) {
        failFork(
          `fork depth ${depth} exceeds ${request.maxDepth}`,
          'depth_exceeded'
        );
      }
      const childTrajectoryId = axTrajectoryId('traj');
      if (childTrajectoryId === request.parentTrajectoryId) {
        failFork('a trajectory cannot fork itself', 'cycle');
      }
      const forkStepId = axTrajectoryId('step');
      this.records.set(
        childTrajectoryId,
        newRecord({
          trajectoryId: childTrajectoryId,
          slug: request.slug,
          createdAt: this.clock.now(),
          parentTrajectoryId: request.parentTrajectoryId,
          parentStepId: forkStepId,
          depth,
        })
      );
      // Both directions are written before either is observable, so neither
      // side ever has to search for the other (I9).
      await this.write(
        {
          trajectoryId: childTrajectoryId,
          type: 'trajectory',
          data: {
            ...request.data,
            parentTrajectoryId: request.parentTrajectoryId,
            parentStepId: forkStepId,
            depth,
          },
        },
        signal
      );
      await this.write(
        {
          trajectoryId: request.parentTrajectoryId,
          stepId: forkStepId,
          type: 'fork',
          data: { ...request.data, childTrajectoryId, depth },
        },
        signal
      );
      return { childTrajectoryId, forkStepId, depth };
    });
  }

  async merge(
    request: Readonly<AxTrajectoryMergeRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryAppendReceipt>> {
    signal?.throwIfAborted();
    return this.serialize(async () => {
      this.record(request.parentTrajectoryId);
      this.record(request.childTrajectoryId);
      const parentStepId = axTrajectoryId('step');
      // A sub-run always merges something back, success or failure (I10).
      const receipt = await this.write(
        {
          trajectoryId: request.parentTrajectoryId,
          stepId: parentStepId,
          type: 'merge',
          data: {
            childTrajectoryId: request.childTrajectoryId,
            outcome: request.outcome,
            content: request.content,
          },
        },
        signal
      );
      await this.write(
        {
          trajectoryId: request.childTrajectoryId,
          type: 'merge',
          data: {
            parentTrajectoryId: request.parentTrajectoryId,
            parentStepId,
            outcome: request.outcome,
          },
        },
        signal
      );
      return receipt;
    });
  }

  async loadCursor(
    consumerId: string,
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryCursor> | undefined> {
    signal?.throwIfAborted();
    return this.cursors.get(`${consumerId}\n${trajectoryId}`);
  }

  async saveCursor(
    consumerId: string,
    cursor: Readonly<AxTrajectoryCursor>,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    this.record(cursor.trajectoryId);
    this.cursors.set(`${consumerId}\n${cursor.trajectoryId}`, { ...cursor });
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      failAppend('the trajectory store is closed', 'commit', 'store_failure');
    }
  }

  private record(trajectoryId: string): TrajectoryRecord {
    const record = this.records.get(trajectoryId);
    if (!record)
      failQuery(`unknown trajectory ${trajectoryId}`, 'unknown_trajectory');
    return record;
  }

  private matcher(
    types: readonly string[] | undefined,
    classes: readonly AxTrajectoryStepClass[] | undefined
  ): (step: Readonly<AxTrajectoryStep>) => boolean {
    const typeSet = types ? new Set(types) : undefined;
    const classSet = classes ? new Set(classes) : undefined;
    return (step) =>
      (!typeSet || typeSet.has(step.type)) &&
      (!classSet || classSet.has(this.registry.describe(step.type).stepClass));
  }

  private validateCursor(
    record: TrajectoryRecord,
    trajectoryId: string,
    cursor: Readonly<AxTrajectoryCursor> | undefined
  ): number {
    if (!cursor) return 0;
    if (cursor.trajectoryId !== trajectoryId) {
      failCursor(
        `cursor names ${cursor.trajectoryId}, not ${trajectoryId}`,
        'identity_changed'
      );
    }
    const token = cursor.token;
    if (token !== undefined) {
      const identity = token.slice(0, token.lastIndexOf(':'));
      if (identity !== record.identity) {
        failCursor(
          `cursor token is from another instance of ${trajectoryId}`,
          'identity_changed'
        );
      }
    }
    if (!Number.isInteger(cursor.seq) || cursor.seq < 0) {
      failCursor(
        `cursor seq ${cursor.seq} is not a frame boundary`,
        'not_a_frame_boundary'
      );
    }
    if (cursor.seq > record.steps.length) {
      failCursor(`cursor seq ${cursor.seq} is beyond the end`, 'beyond_end');
    }
    return cursor.seq;
  }

  /** Serializes every mutation, which is what makes `seq` dense (I4). */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async write(
    request: Readonly<AxTrajectoryAppendRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryAppendReceipt>> {
    this.assertOpen();
    const record = this.records.get(request.trajectoryId);
    if (!record) {
      failAppend(
        `unknown trajectory ${request.trajectoryId}`,
        'validate',
        'unknown_trajectory'
      );
    }
    const descriptor = this.registry.describe(request.type);
    if (request.source !== undefined && !descriptor.carriesSource) {
      failAppend(
        `step type "${request.type}" may not carry a source`,
        'validate',
        'source_on_machinery_step'
      );
    }
    const data = axTrajectoryCompactData(request.data);
    const invalid = axTrajectoryInvalidFieldPath(data);
    if (invalid) {
      failAppend(
        `step field ${invalid} is not persistable`,
        'validate',
        'invalid_field'
      );
    }
    let ts = this.clock.now();
    if (request.ts !== undefined) {
      const normalized = axNormalizeTrajectoryTimestamp(request.ts);
      if (normalized === undefined) {
        failAppend(
          `step ts ${request.ts} is not finite`,
          'validate',
          'invalid_field'
        );
      }
      ts = normalized;
    }
    const stepId = request.stepId ?? axTrajectoryId('step');
    const fingerprint = axTrajectoryStepFingerprint({
      stepId,
      trajectoryId: request.trajectoryId,
      type: request.type,
      runId: request.runId,
      triggerStep: request.triggerStep,
      launchedBy: request.launchedBy,
      source: request.source,
      data,
    });
    const previous = record.byId.get(stepId);
    if (previous) {
      if (record.fingerprints.get(stepId) !== fingerprint) {
        failAppend(
          `step id ${stepId} already exists with different content`,
          'validate',
          'duplicate_step_id'
        );
      }
      return {
        stepId,
        seq: previous.seq,
        ts: previous.ts,
        durability: 'volatile',
        spilled: (previous.blobs ?? []).map((blob) => blob.field),
        duplicate: true,
      };
    }
    if (this.maxSteps !== undefined && record.steps.length >= this.maxSteps) {
      failAppend(
        `maxSteps ${this.maxSteps} reached`,
        'commit',
        'store_failure'
      );
    }

    let spilled: Awaited<ReturnType<typeof axSpillTrajectoryFields>>;
    try {
      spilled = await axSpillTrajectoryFields({
        trajectoryId: request.trajectoryId,
        stepId,
        data,
        blobs: this.spillBlobs(),
        policy: this.spill,
        spillFields: descriptor.spillFields,
        signal,
      });
    } catch (cause) {
      // I2: the blob write failed, so no step becomes visible at all.
      failAppend(
        `blob spill failed for step ${stepId}`,
        'blob',
        'blob_write_failed',
        { cause }
      );
    }

    const step: AxTrajectoryStep = {
      stepId,
      trajectoryId: request.trajectoryId,
      seq: record.steps.length,
      type: request.type,
      ts,
      runId: request.runId,
      triggerStep: request.triggerStep,
      launchedBy: request.launchedBy,
      source: request.source,
      data: spilled.data,
      blobs: spilled.blobs.length > 0 ? spilled.blobs : undefined,
    };
    const size = axTrajectoryStepBytes(step);
    if (this.maxBytes !== undefined && record.bytes + size > this.maxBytes) {
      failAppend(
        `maxBytes ${this.maxBytes} reached`,
        'commit',
        'store_failure'
      );
    }
    record.steps.push(step);
    record.byId.set(stepId, step);
    record.fingerprints.set(stepId, fingerprint);
    record.bytes += size;
    record.newestByClass.set(descriptor.stepClass, {
      seq: step.seq,
      stepId,
      ts,
    });
    return {
      stepId,
      seq: step.seq,
      ts,
      durability: 'volatile',
      spilled: spilled.spilled,
      duplicate: false,
    };
  }

  /** Wraps the blob store when a fault is armed, so exactly one put fails. */
  private spillBlobs(): AxTrajectoryBlobStore {
    if (this.blobFailures <= 0) return this.blobs;
    const inner = this.blobs;
    return {
      put: async (request) => {
        this.blobFailures--;
        throw new AxTrajectoryBlobError(
          `injected blob write failure for field ${request.field}`,
          'write_failed',
          `pending:${request.stepId}:${request.field}`
        );
      },
      get: (ref, digest, signal) => inner.get(ref, digest, signal),
      delete: (ref, signal) => inner.delete?.(ref, signal) ?? Promise.resolve(),
    };
  }
}
