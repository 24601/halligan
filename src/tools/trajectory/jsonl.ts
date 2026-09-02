import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
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
  type AxTrajectoryDrainBudget,
  AxTrajectoryForkError,
  type AxTrajectoryForkRequest,
  type AxTrajectoryForkResult,
  type AxTrajectoryHeader,
  AxTrajectoryLog,
  type AxTrajectoryLogEntry,
  type AxTrajectoryMergeRequest,
  AxTrajectoryQueryError,
  type AxTrajectoryReadQuery,
  type AxTrajectorySpillPolicy,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryStoreCapabilities,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTypeRegistry,
  axEventCanonicalDigest,
  axFreezeTrajectoryStep,
  axPrepareTrajectoryStep,
  axSpillTrajectoryStep,
  axTrajectoryId,
  axTrajectoryStepFingerprint,
  axTrajectoryTypeRegistry,
  axTrajectoryUtf8ByteLength,
} from '@ax-llm/ax';

export const AX_JSONL_TRAJECTORY_SCHEMA_VERSION = 1;

const STEPS_FILE = 'steps.jsonl';
const HEADER_FILE = 'header.json';
const BLOBS_DIR = 'blobs';
const CURSORS_DIR = 'cursors';
const READ_CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

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

function failQuery(
  message: string,
  reason: QueryReason,
  options?: ErrorOptions
): never {
  throw new AxTrajectoryQueryError(message, reason, options);
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

/**
 * `writeSync` may write fewer bytes than it was given; a short write on the
 * step file would truncate the frame the surrounding code calls atomic.
 */
function writeAll(fd: number, data: string): void {
  const buffer = Buffer.from(data, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written);
  }
}

let temporaryCounter = 0;

/**
 * Creates `path` atomically: the bytes land in a sibling temp file, are
 * flushed, and only then move into place. Opening the final path with `'w'`
 * would truncate it first, so a crash mid-rewrite could leave a live reference
 * pointing at half a file (I2's "a dangling ref is impossible").
 */
function writeDurable(path: string, data: string, fsync: boolean): void {
  const temporary = `${path}.${Date.now().toString(36)}${temporaryCounter++}.tmp`;
  const fd = openSync(temporary, 'w');
  try {
    writeAll(fd, data);
    if (fsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
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
    const path = this.path(ref);
    const bytes = axTrajectoryUtf8ByteLength(request.value);
    // Content-addressed, so an existing ref already holds exactly these bytes
    // and a committed step may already point at it. Re-writing it buys
    // nothing and risks truncating a live reference.
    if (!existsSync(path)) writeDurable(path, request.value, this.fsync);
    return { ref, bytes, digest };
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
  readonly log: AxTrajectoryLog;
  readonly path: string;
  /** True byte length of steps.jsonl, including any unterminated tail. */
  bytes: number;
  /** The tail is an unterminated frame, so the next append must close it. */
  torn: boolean;
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
 * in-memory reference store, with the same assertion count, because every read
 * primitive is the shared `AxTrajectoryLog`'s.
 *
 * **Memory.** Opening a trajectory indexes `steps.jsonl` a chunk at a time and
 * keeps one `AxTrajectoryLogEntry` per frame -- id, type, class, ts, and the
 * byte range -- never the parsed steps. A read seeks to the frames it is about
 * to return and parses only those, so resident memory is O(steps), not
 * O(bytes), and the 312 MB / 19k-step log the subsystem exists for does not
 * have to fit in the heap.
 *
 * **Durability limit, stated.** With `fsync` on, file contents are flushed
 * before a step that references them becomes visible, but the containing
 * DIRECTORY is not fsynced after a create or a rename. Against a real power
 * cut a just-created blob or cursor file can therefore be absent even though
 * its data was flushed. That degrades to C2 (an orphan blob) or to a cursor
 * that reads as absent, both of which recover by replaying -- never to a
 * dangling reference -- but the guarantee is weaker than a full O_DIRECTORY
 * fsync and is not claimed to be otherwise.
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
  private resolved = 0;

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

  /**
   * Frames this store has materialized to satisfy reads, since construction.
   * The observable form of the memory claim above: a bounded read parses the
   * frames it returns and no others, so this tracks result size rather than
   * log size. Indexing does not count -- it parses each line and discards it.
   */
  get framesResolved(): number {
    return this.resolved;
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
    appendFileSync(this.stepsPath(trajectoryId), '{"stepId":"torn"');
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
      if (existing) return existing.log.header;
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
    return this.load(trajectoryId)?.log.header;
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
    return this.load(trajectoryId)?.log.stats(trajectoryId);
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
      const depth = parent.log.header.depth + 1;
      if (request.maxDepth !== undefined && depth > request.maxDepth) {
        failFork(
          `fork depth ${depth} exceeds ${request.maxDepth}`,
          'depth_exceeded'
        );
      }
      const childTrajectoryId = axTrajectoryId('traj');
      const forkStepId = axTrajectoryId('step');
      this.materialize({
        trajectoryId: childTrajectoryId,
        slug: request.slug,
        createdAt: this.clock.now(),
        parentTrajectoryId: request.parentTrajectoryId,
        parentStepId: forkStepId,
        depth,
      });
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
    writeDurable(
      this.cursorPath(consumerId, cursor.trajectoryId),
      JSON.stringify(cursor),
      this.fsync
    );
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

  /**
   * Length-prefixed on the encoded consumer id. `encodeURIComponent` leaves
   * `_` alone, so a plain `a__b` join maps consumer `a__b`/trajectory `c` and
   * consumer `a`/trajectory `b__c` onto the same cursor file.
   */
  private cursorPath(consumerId: string, trajectoryId: string): string {
    const consumer = segment(consumerId);
    return join(
      this.directory,
      CURSORS_DIR,
      `${consumer.length}_${consumer}__${segment(trajectoryId)}.json`
    );
  }

  private newRecord(
    header: AxTrajectoryHeader,
    identity: string
  ): TrajectoryRecord {
    const path = this.stepsPath(header.trajectoryId);
    const record: TrajectoryRecord = {
      path,
      bytes: 0,
      torn: false,
      log: new AxTrajectoryLog({
        header,
        identity,
        resolve: (entry, seq) => {
          this.resolved++;
          return readFrame(path, entry, seq);
        },
      }),
    };
    this.records.set(header.trajectoryId, record);
    return record;
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
    return this.newRecord(header, stored.identity);
  }

  /** Loads (and tolerantly parses) a trajectory, or returns undefined. */
  private load(trajectoryId: string): TrajectoryRecord | undefined {
    const cached = this.records.get(trajectoryId);
    if (cached) return cached;
    const dir = this.trajectoryDir(trajectoryId);
    const headerPath = join(dir, HEADER_FILE);
    if (!existsSync(headerPath)) return undefined;
    let stored: StoredHeader;
    try {
      stored = JSON.parse(readFileSync(headerPath, 'utf8')) as StoredHeader;
    } catch (cause) {
      // A half-written header cannot identify the trajectory, so the read
      // fails closed with an Ax error rather than a raw SyntaxError. The
      // step file is untouched and a host can restore the header.
      failQuery(
        `the header of trajectory ${trajectoryId} is unreadable`,
        'unknown_trajectory',
        { cause }
      );
    }
    const { identity, schemaVersion, ...header } = stored;
    void schemaVersion;
    const record = this.newRecord(header, identity);
    if (existsSync(record.path)) this.indexFile(record);
    return record;
  }

  /**
   * Streams `steps.jsonl` in chunks and indexes one entry per complete frame.
   * Nothing but the entries is retained: the parsed step is discarded, so a
   * log far larger than memory can still be opened.
   */
  private indexFile(record: TrajectoryRecord): void {
    const fd = openSync(record.path, 'r');
    try {
      const chunk = Buffer.allocUnsafe(READ_CHUNK);
      let pending = Buffer.alloc(0);
      let at = 0;
      let read = readSync(fd, chunk, 0, READ_CHUNK, null);
      while (read > 0) {
        pending = Buffer.concat([pending, chunk.subarray(0, read)]);
        let newline = pending.indexOf(NEWLINE);
        while (newline !== -1) {
          this.indexFrame(
            record,
            pending.subarray(0, newline),
            at,
            newline + 1
          );
          at += newline + 1;
          pending = pending.subarray(newline + 1);
          newline = pending.indexOf(NEWLINE);
        }
        read = readSync(fd, chunk, 0, READ_CHUNK, null);
      }
      // A trailing chunk with no newline is a torn write: dropped and counted,
      // never glued onto the record before it (invariant I3).
      if (pending.length > 0) {
        record.log.corrupt++;
        record.torn = true;
      }
      record.bytes = at + pending.length;
    } finally {
      closeSync(fd);
    }
  }

  private indexFrame(
    record: TrajectoryRecord,
    line: Buffer,
    at: number,
    span: number
  ): void {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8'));
    } catch {
      record.log.corrupt++;
      return;
    }
    if (!isStepShaped(parsed)) {
      record.log.corrupt++;
      return;
    }
    record.log.index({
      stepId: parsed.stepId,
      type: parsed.type,
      stepClass: this.registry.describe(parsed.type).stepClass,
      ts: parsed.ts,
      // The frame's own bytes, minus the terminator: the on-the-wire size a
      // drain budget is denominated in, with no re-serialization on load.
      bytes: span - 1,
      at,
      span,
    });
  }

  private record(trajectoryId: string): TrajectoryRecord {
    const record = this.load(trajectoryId);
    if (!record) {
      failQuery(`unknown trajectory ${trajectoryId}`, 'unknown_trajectory');
    }
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
    const record = this.load(request.trajectoryId);
    if (!record) {
      failAppend(
        `unknown trajectory ${request.trajectoryId}`,
        'validate',
        'unknown_trajectory'
      );
    }
    const { log } = record;
    const prepared = axPrepareTrajectoryStep(
      request,
      this.registry,
      this.clock
    );
    const previousSeq = log.seqOf(prepared.stepId);
    const seq = previousSeq ?? log.length;
    // I2: every blob is durably on disk before the step line is appended.
    const built = await axSpillTrajectoryStep({
      request,
      prepared,
      seq,
      blobs: this.blobs,
      policy: this.spill,
      signal,
    });

    if (previousSeq !== undefined) {
      // The fingerprint is taken over the PERSISTED step, so a replay compares
      // equal without rehydrating a blob and it recomputes from the bytes.
      const previous = log.step(previousSeq)!;
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
        durability: 'persistent',
        spilled: (previous.blobs ?? []).map((blob) => blob.field),
        duplicate: true,
      };
    }

    // One `\n`-terminated write per step: a reader either sees the whole line
    // or, after a power loss, a trailing fragment the parser drops (I3). A
    // torn tail is closed with its own terminator first, so the new frame is
    // never glued onto the fragment that a crash left behind.
    const line = `${JSON.stringify(built.step)}\n`;
    const prefix = record.torn ? '\n' : '';
    const fd = openSync(record.path, 'a');
    try {
      writeAll(fd, `${prefix}${line}`);
      if (this.fsync) fsyncSync(fd);
    } catch (cause) {
      failAppend(
        `step ${prepared.stepId} could not be appended`,
        'commit',
        'store_failure',
        { cause }
      );
    } finally {
      closeSync(fd);
    }
    const at = record.bytes + prefix.length;
    const span = axTrajectoryUtf8ByteLength(line);
    record.bytes = at + span;
    record.torn = false;
    log.index({
      stepId: prepared.stepId,
      type: request.type,
      stepClass: prepared.descriptor.stepClass,
      ts: prepared.ts,
      bytes: span - 1,
      at,
      span,
    });
    return {
      stepId: prepared.stepId,
      seq,
      ts: prepared.ts,
      durability: 'persistent',
      spilled: built.spilled,
      duplicate: false,
    };
  }
}

/** Seeks to one indexed frame and parses only that frame. */
function readFrame(
  path: string,
  entry: Readonly<AxTrajectoryLogEntry>,
  seq: number
): Readonly<AxTrajectoryStep> {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(entry.span);
    const read = readSync(fd, buffer, 0, entry.span, entry.at);
    const parsed = JSON.parse(
      buffer.subarray(0, read).toString('utf8')
    ) as AxTrajectoryStep;
    // `seq` is the store's, never the file's: a tolerant parse that dropped an
    // interior frame renumbers everything after it (I4 keeps seq dense).
    return axFreezeTrajectoryStep({ ...parsed, seq });
  } finally {
    closeSync(fd);
  }
}
