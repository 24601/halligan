import type { AxEventClock } from '../event/types.js';
import { AxSystemEventClock } from '../event/types.js';
import { axEventCanonicalDigest } from '../event/util.js';
import {
  AxTrajectoryLog,
  axPrepareTrajectoryStep,
  axSpillTrajectoryStep,
} from './log.js';
import { axTrajectoryTypeRegistry } from './registry.js';
import type { AxTrajectorySpillPolicy } from './spill.js';
import {
  AxTrajectoryAppendError,
  type AxTrajectoryAppendReceipt,
  type AxTrajectoryAppendRequest,
  AxTrajectoryBlobError,
  type AxTrajectoryBlobPutRequest,
  type AxTrajectoryBlobStore,
  type AxTrajectoryCreateRequest,
  type AxTrajectoryCursor,
  type AxTrajectoryDrainBudget,
  AxTrajectoryForkError,
  type AxTrajectoryForkRequest,
  type AxTrajectoryForkResult,
  type AxTrajectoryHeader,
  type AxTrajectoryMergeRequest,
  AxTrajectoryQueryError,
  type AxTrajectoryReadQuery,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryStoreCapabilities,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTypeRegistry,
} from './types.js';
import {
  axTrajectoryId,
  axTrajectoryStepFingerprint,
  axTrajectoryUtf8ByteLength,
} from './util.js';

type AppendPhase = ConstructorParameters<typeof AxTrajectoryAppendError>[1];
type AppendReason = ConstructorParameters<typeof AxTrajectoryAppendError>[2];
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
    // Content-addressed: identical bytes are already there, and rewriting a
    // ref a committed step points at is the one thing that could break it.
    if (!this.values.has(ref)) this.values.set(ref, request.value);
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
  readonly log: AxTrajectoryLog;
  /** The frames themselves. `AxTrajectoryLogEntry.at` is the slot index. */
  readonly steps: Readonly<AxTrajectoryStep>[];
}

function newRecord(header: AxTrajectoryHeader): TrajectoryRecord {
  const steps: Readonly<AxTrajectoryStep>[] = [];
  return {
    steps,
    log: new AxTrajectoryLog({
      header,
      identity: axTrajectoryId('inst'),
      resolve: (_entry, seq) => steps[seq]!,
    }),
  };
}

/**
 * Reference implementation of the append-only step log. Volatile by
 * declaration: it exists so hosts have something to run tests against and so
 * `runAxTrajectoryStoreConformance` has a second implementation to hold a
 * durable store against. Every read primitive is `AxTrajectoryLog`'s, shared
 * verbatim with the file store.
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
    this.record(trajectoryId).log.corrupt++;
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
      if (existing) return existing.log.header;
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
    return this.records.get(trajectoryId)?.log.header;
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
    return this.record(query.trajectoryId).log.read(query);
  }

  async tailBackward(
    query: Readonly<AxTrajectoryTailQuery>,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    return this.record(query.trajectoryId).log.tailBackward(query);
  }

  async getStep(trajectoryId: string, stepId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.record(trajectoryId).log.getStep(stepId);
  }

  async getSteps(
    trajectoryId: string,
    stepIds: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxTrajectoryStep>[]> {
    signal?.throwIfAborted();
    return this.record(trajectoryId).log.getSteps(stepIds);
  }

  async readFrom(
    cursor: Readonly<AxTrajectoryCursor> | undefined,
    trajectoryId: string,
    budget: Readonly<AxTrajectoryDrainBudget>,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    return this.record(trajectoryId).log.readFrom(trajectoryId, cursor, budget);
  }

  async stats(trajectoryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.records.get(trajectoryId)?.log.stats(trajectoryId);
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
      const depth = parent.log.header.depth + 1;
      if (request.maxDepth !== undefined && depth > request.maxDepth) {
        failFork(
          `fork depth ${depth} exceeds ${request.maxDepth}`,
          'depth_exceeded'
        );
      }
      const childTrajectoryId = axTrajectoryId('traj');
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
    return this.cursors.get(cursorKey(consumerId, trajectoryId));
  }

  async saveCursor(
    consumerId: string,
    cursor: Readonly<AxTrajectoryCursor>,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    this.record(cursor.trajectoryId);
    this.cursors.set(cursorKey(consumerId, cursor.trajectoryId), { ...cursor });
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
    const { log, steps } = record;
    const prepared = axPrepareTrajectoryStep(
      request,
      this.registry,
      this.clock
    );
    const previousSeq = log.seqOf(prepared.stepId);
    if (
      previousSeq === undefined &&
      this.maxSteps !== undefined &&
      log.length >= this.maxSteps
    ) {
      failAppend(
        `maxSteps ${this.maxSteps} reached`,
        'commit',
        'store_failure'
      );
    }

    const seq = previousSeq ?? log.length;
    const built = await axSpillTrajectoryStep({
      request,
      prepared,
      seq,
      blobs: this.spillBlobs(),
      policy: this.spill,
      signal,
    });

    if (previousSeq !== undefined) {
      const previous = steps[previousSeq]!;
      // The fingerprint is taken over the PERSISTED step, so a replay of a
      // spilled step compares equal without rehydrating a blob.
      if (
        axTrajectoryStepFingerprint(previous) !==
        axTrajectoryStepFingerprint(built.step)
      ) {
        failAppend(
          `step id ${prepared.stepId} already exists with different content`,
          'validate',
          'duplicate_step_id'
        );
      }
      return {
        stepId: prepared.stepId,
        seq: previousSeq,
        ts: previous.ts,
        durability: 'volatile',
        spilled: (previous.blobs ?? []).map((blob) => blob.field),
        duplicate: true,
      };
    }
    if (
      this.maxBytes !== undefined &&
      log.bytes + built.bytes > this.maxBytes
    ) {
      failAppend(
        `maxBytes ${this.maxBytes} reached`,
        'commit',
        'store_failure'
      );
    }
    steps.push(built.step);
    log.index({
      stepId: prepared.stepId,
      type: request.type,
      stepClass: prepared.descriptor.stepClass,
      ts: prepared.ts,
      bytes: built.bytes,
      at: seq,
      span: 1,
    });
    return {
      stepId: prepared.stepId,
      seq,
      ts: prepared.ts,
      durability: 'volatile',
      spilled: built.spilled,
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

/**
 * Length-prefixed, so no consumer/trajectory pair can collide with another.
 * Any single-character join is ambiguous the moment an id contains that
 * character, and consumer ids are host-supplied strings.
 */
function cursorKey(consumerId: string, trajectoryId: string): string {
  return `${consumerId.length}:${consumerId}:${trajectoryId}`;
}
