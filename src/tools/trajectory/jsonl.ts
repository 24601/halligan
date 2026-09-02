import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  type AxEventClock,
  AxSystemEventClock,
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
  type AxTrajectorySpillPolicy,
  type AxTrajectoryStats,
  type AxTrajectoryStep,
  type AxTrajectoryStepClass,
  type AxTrajectoryStore,
  type AxTrajectoryStoreCapabilities,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTailResult,
  type AxTrajectoryTypeRegistry,
  axEventCanonicalDigest,
  axNormalizeTrajectoryTimestamp,
  axSpillTrajectoryFields,
  axTrajectoryCompactData,
  axTrajectoryId,
  axTrajectoryInvalidFieldPath,
  axTrajectoryMaxStepIds,
  axTrajectoryStepBytes,
  axTrajectoryStepFingerprint,
  axTrajectoryTypeRegistry,
  axTrajectoryUtf8ByteLength,
} from '@ax-llm/ax';

export const AX_JSONL_TRAJECTORY_SCHEMA_VERSION = 1;

const DEFAULT_DRAIN_STEPS = 256;
const DEFAULT_DRAIN_BYTES = 1024 * 1024;
const STEPS_FILE = 'steps.jsonl';
const HEADER_FILE = 'header.json';
const BLOBS_DIR = 'blobs';
const CURSORS_DIR = 'cursors';

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

/** One directory segment per id. Rejects anything that could escape the root. */
function segment(id: string): string {
  if (id.length === 0 || id === '.' || id === '..') {
    failQuery(`"${id}" is not a usable trajectory id`, 'unknown_trajectory');
  }
  return encodeURIComponent(id);
}

function writeDurable(path: string, data: string, fsync: boolean): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data);
    if (fsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Content-addressed blob directory. Each blob is written and durably flushed
 * before the step that references it is appended (invariant I2), so a crash
 * can leave an orphan blob but never a dangling reference.
 */
export class AxJSONLTrajectoryBlobStore implements AxTrajectoryBlobStore {
  private failNext = 0;

  constructor(
    private readonly directory: string,
    private readonly fsync: boolean
  ) {
    mkdirSync(directory, { recursive: true });
  }

  /** Fault seam used by the conformance kit's C-ORDER case. */
  failNextPut(): void {
    this.failNext++;
  }

  async put(
    request: Readonly<AxTrajectoryBlobPutRequest>,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    const digest = await axEventCanonicalDigest(request.value);
    const ref = `blob-${digest}`;
    if (this.failNext > 0) {
      this.failNext--;
      throw new AxTrajectoryBlobError(
        `injected blob write failure for field ${request.field}`,
        'write_failed',
        ref,
        digest
      );
    }
    writeDurable(this.path(ref), request.value, this.fsync);
    return {
      ref,
      bytes: axTrajectoryUtf8ByteLength(request.value),
      digest,
    };
  }

  async get(ref: string, digest: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const path = this.path(ref);
    if (!existsSync(path)) {
      throw new AxTrajectoryBlobError(
        `blob ${ref} is missing`,
        'missing',
        ref,
        digest
      );
    }
    const value = readFileSync(path, 'utf8');
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
    const path = this.path(ref);
    if (existsSync(path)) unlinkSync(path);
  }

  private path(ref: string): string {
    return join(this.directory, `${encodeURIComponent(ref)}.blob`);
  }
}

export interface AxJSONLTrajectoryStoreOptions {
  /** Root directory. Created if absent; one subdirectory per trajectory. */
  readonly directory: string;
  readonly clock?: AxEventClock;
  readonly registry?: AxTrajectoryTypeRegistry;
  readonly spill?: Readonly<AxTrajectorySpillPolicy>;
  /** fsync every write. Default true; turn it off only for throwaway tests. */
  readonly fsync?: boolean;
}

interface StoredHeader extends AxTrajectoryHeader {
  readonly identity: string;
  readonly schemaVersion: number;
}

interface TrajectoryRecord {
  readonly header: AxTrajectoryHeader;
  readonly identity: string;
  readonly steps: AxTrajectoryStep[];
  readonly byId: Map<string, AxTrajectoryStep>;
  readonly fingerprints: Map<string, string>;
  readonly newestByClass: Map<
    AxTrajectoryStepClass,
    { seq: number; stepId: string; ts: number }
  >;
  /** Byte offset just past each step's line, for byte-offset cursor tokens. */
  readonly offsets: number[];
  bytes: number;
  corrupt: number;
}

function isStepShaped(value: unknown): value is AxTrajectoryStep {
  const step = value as Partial<AxTrajectoryStep> | null;
  return (
    typeof step === 'object' &&
    step !== null &&
    typeof step.stepId === 'string' &&
    typeof step.trajectoryId === 'string' &&
    typeof step.seq === 'number' &&
    typeof step.type === 'string' &&
    typeof step.ts === 'number' &&
    typeof step.data === 'object' &&
    step.data !== null
  );
}

/**
 * File-backed append-only trajectory store: one `steps.jsonl` per trajectory,
 * one line per step, blobs content-addressed in a shared directory, cursors in
 * their own files. Passes the same `runAxTrajectoryStoreConformance` kit as the
 * in-memory reference store, with the same assertion count.
 */
export class AxJSONLTrajectoryStore implements AxTrajectoryStore {
  readonly capabilities: Readonly<AxTrajectoryStoreCapabilities> =
    Object.freeze({
      durability: 'persistent',
      coordination: 'single-writer',
      appendAtomicity: true,
      blobs: true,
      cursorTokens: true,
      consumerCursors: true,
      conformance: Object.freeze({
        schemaVersion: AX_JSONL_TRAJECTORY_SCHEMA_VERSION,
      }),
    } as const);

  readonly clock: AxEventClock;
  readonly blobs: AxJSONLTrajectoryBlobStore;

  private readonly directory: string;
  private readonly registry: AxTrajectoryTypeRegistry;
  private readonly spill?: Readonly<AxTrajectorySpillPolicy>;
  private readonly fsync: boolean;
  private readonly records = new Map<string, TrajectoryRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: Readonly<AxJSONLTrajectoryStoreOptions>) {
    this.directory = options.directory;
    this.clock = options.clock ?? new AxSystemEventClock();
    this.registry = options.registry ?? axTrajectoryTypeRegistry();
    this.spill = options.spill;
    this.fsync = options.fsync !== false;
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(join(this.directory, CURSORS_DIR), { recursive: true });
    this.blobs = new AxJSONLTrajectoryBlobStore(
      join(this.directory, BLOBS_DIR),
      this.fsync
    );
  }

  /** Fault seam: make the next blob write fail (conformance case C-ORDER). */
  failNextBlobWrite(): void {
    this.blobs.failNextPut();
  }

  /**
   * Fault seam: append an unterminated frame, exactly as a power loss mid-write
   * would leave one, and drop the in-memory index so the next read has to go
   * through the tolerant parser rather than trusting cached state.
   */
  injectCorruptTrailingFrame(trajectoryId: string): void {
    this.record(trajectoryId);
    appendFileSync(this.stepsPath(trajectoryId), '{"stepId":"torn","trajec');
    this.records.delete(trajectoryId);
  }

  async create(
    request: Readonly<AxTrajectoryCreateRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryHeader>> {
    signal?.throwIfAborted();
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const trajectoryId = request.trajectoryId ?? axTrajectoryId('traj');
      const existing = this.load(trajectoryId);
      if (existing) return existing.header;
      const header: AxTrajectoryHeader = {
        trajectoryId,
        slug: request.slug,
        createdAt: this.clock.now(),
        depth: 0,
      };
      this.materialize(header);
      const data = { ...request.data };
      if (request.slug !== undefined) data.slug = request.slug;
      await this.write({ trajectoryId, type: 'trajectory', data }, signal);
      return header;
    });
  }

  async getTrajectory(trajectoryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.load(trajectoryId)?.header;
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
    if (to < from) {
      failQuery(`read range ${from}..${to} is inverted`, 'invalid_range');
    }
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
      cursor: this.cursorAt(record, trajectoryId, seq),
      caughtUp,
      corrupt: caughtUp ? record.corrupt : 0,
    };
  }

  async stats(
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStats> | undefined> {
    signal?.throwIfAborted();
    const record = this.load(trajectoryId);
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
      const parent = this.load(request.parentTrajectoryId);
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
      this.materialize({
        trajectoryId: childTrajectoryId,
        slug: request.slug,
        createdAt: this.clock.now(),
        parentTrajectoryId: request.parentTrajectoryId,
        parentStepId: forkStepId,
        depth,
      });
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
    const path = this.cursorPath(consumerId, trajectoryId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AxTrajectoryCursor;
    } catch {
      // A torn cursor file is treated as absent: replaying from the head is
      // always safe, whereas trusting half a cursor is not.
      return undefined;
    }
  }

  async saveCursor(
    consumerId: string,
    cursor: Readonly<AxTrajectoryCursor>,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    this.record(cursor.trajectoryId);
    const path = this.cursorPath(consumerId, cursor.trajectoryId);
    const temporary = `${path}.tmp`;
    writeDurable(temporary, JSON.stringify(cursor), this.fsync);
    renameSync(temporary, path);
  }

  close(): void {
    this.closed = true;
  }

  /** Trajectory ids present on disk, for a host that resumes an existing root. */
  listTrajectories(): readonly string[] {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== BLOBS_DIR &&
          entry.name !== CURSORS_DIR
      )
      .map((entry) => decodeURIComponent(entry.name))
      .sort();
  }

  private assertOpen(): void {
    if (this.closed) {
      failAppend('the trajectory store is closed', 'commit', 'store_failure');
    }
  }

  private trajectoryDir(trajectoryId: string): string {
    return join(this.directory, segment(trajectoryId));
  }

  private stepsPath(trajectoryId: string): string {
    return join(this.trajectoryDir(trajectoryId), STEPS_FILE);
  }

  private cursorPath(consumerId: string, trajectoryId: string): string {
    return join(
      this.directory,
      CURSORS_DIR,
      `${segment(consumerId)}__${segment(trajectoryId)}.json`
    );
  }

  private materialize(header: AxTrajectoryHeader): TrajectoryRecord {
    const dir = this.trajectoryDir(header.trajectoryId);
    mkdirSync(dir, { recursive: true });
    const stored: StoredHeader = {
      ...header,
      identity: axTrajectoryId('inst'),
      schemaVersion: AX_JSONL_TRAJECTORY_SCHEMA_VERSION,
    };
    writeDurable(join(dir, HEADER_FILE), JSON.stringify(stored), this.fsync);
    appendFileSync(join(dir, STEPS_FILE), '');
    const record: TrajectoryRecord = {
      header,
      identity: stored.identity,
      steps: [],
      byId: new Map(),
      fingerprints: new Map(),
      newestByClass: new Map(),
      offsets: [],
      bytes: 0,
      corrupt: 0,
    };
    this.records.set(header.trajectoryId, record);
    return record;
  }

  /** Loads (and tolerantly parses) a trajectory, or returns undefined. */
  private load(trajectoryId: string): TrajectoryRecord | undefined {
    const cached = this.records.get(trajectoryId);
    if (cached) return cached;
    const dir = this.trajectoryDir(trajectoryId);
    const headerPath = join(dir, HEADER_FILE);
    if (!existsSync(headerPath)) return undefined;
    const stored = JSON.parse(readFileSync(headerPath, 'utf8')) as StoredHeader;
    const { identity, schemaVersion, ...header } = stored;
    void schemaVersion;
    const record: TrajectoryRecord = {
      header,
      identity,
      steps: [],
      byId: new Map(),
      fingerprints: new Map(),
      newestByClass: new Map(),
      offsets: [],
      bytes: 0,
      corrupt: 0,
    };
    const stepsPath = join(dir, STEPS_FILE);
    if (existsSync(stepsPath)) {
      const text = readFileSync(stepsPath, 'utf8');
      const lines = text.split('\n');
      // A trailing chunk with no newline is a torn write: dropped and counted,
      // never glued onto the record before it (invariant I3).
      const trailing = lines.pop();
      if (trailing !== undefined && trailing !== '') record.corrupt++;
      let offset = 0;
      for (const line of lines) {
        offset += axTrajectoryUtf8ByteLength(line) + 1;
        if (line === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          record.corrupt++;
          continue;
        }
        if (!isStepShaped(parsed)) {
          record.corrupt++;
          continue;
        }
        this.index(record, parsed, offset);
      }
    }
    this.records.set(trajectoryId, record);
    return record;
  }

  private index(
    record: TrajectoryRecord,
    step: AxTrajectoryStep,
    offset: number
  ): void {
    const positioned: AxTrajectoryStep = { ...step, seq: record.steps.length };
    record.steps.push(positioned);
    record.byId.set(positioned.stepId, positioned);
    record.fingerprints.set(
      positioned.stepId,
      axTrajectoryStepFingerprint(positioned)
    );
    record.offsets.push(offset);
    record.bytes += axTrajectoryStepBytes(positioned);
    record.newestByClass.set(
      this.registry.describe(positioned.type).stepClass,
      {
        seq: positioned.seq,
        stepId: positioned.stepId,
        ts: positioned.ts,
      }
    );
  }

  private record(trajectoryId: string): TrajectoryRecord {
    const record = this.load(trajectoryId);
    if (!record) {
      failQuery(`unknown trajectory ${trajectoryId}`, 'unknown_trajectory');
    }
    return record;
  }

  private cursorAt(
    record: TrajectoryRecord,
    trajectoryId: string,
    seq: number
  ): Readonly<AxTrajectoryCursor> {
    const offset = seq === 0 ? 0 : (record.offsets[seq - 1] ?? 0);
    return { trajectoryId, seq, token: `${record.identity}:${offset}` };
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
      const split = token.lastIndexOf(':');
      const identity = token.slice(0, split);
      if (identity !== record.identity) {
        failCursor(
          `cursor token is from another instance of ${trajectoryId}`,
          'identity_changed'
        );
      }
      const offset = Number(token.slice(split + 1));
      const size = statSync(this.stepsPath(trajectoryId)).size;
      if (Number.isFinite(offset) && offset > size) {
        failCursor(`the log shrank below cursor offset ${offset}`, 'shrank');
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
    const record = this.load(request.trajectoryId);
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
        durability: 'persistent',
        spilled: (previous.blobs ?? []).map((blob) => blob.field),
        duplicate: true,
      };
    }

    let spilled: Awaited<ReturnType<typeof axSpillTrajectoryFields>>;
    try {
      // I2: every blob is durably on disk before the step line is appended.
      spilled = await axSpillTrajectoryFields({
        trajectoryId: request.trajectoryId,
        stepId,
        data,
        blobs: this.blobs,
        policy: this.spill,
        spillFields: descriptor.spillFields,
        signal,
      });
    } catch (cause) {
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
    // One `\n`-terminated write per step: a reader either sees the whole line
    // or, after a power loss, a trailing fragment the parser drops (I3).
    const line = `${JSON.stringify(step)}\n`;
    const path = this.stepsPath(request.trajectoryId);
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, line);
      if (this.fsync) fsyncSync(fd);
    } catch (cause) {
      failAppend(
        `step ${stepId} could not be appended`,
        'commit',
        'store_failure',
        { cause }
      );
    } finally {
      closeSync(fd);
    }
    const offset =
      (record.offsets[record.offsets.length - 1] ?? 0) +
      axTrajectoryUtf8ByteLength(line);
    this.index(record, step, offset);
    return {
      stepId,
      seq: step.seq,
      ts,
      durability: 'persistent',
      spilled: spilled.spilled,
      duplicate: false,
    };
  }
}
