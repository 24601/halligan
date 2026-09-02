import type { AxEventClock } from '../event/types.js';
import {
  type AxTrajectorySpillPolicy,
  axSpillTrajectoryFields,
} from './spill.js';
import {
  AxTrajectoryAppendError,
  type AxTrajectoryAppendRequest,
  type AxTrajectoryBlobStore,
  type AxTrajectoryCursor,
  AxTrajectoryCursorError,
  type AxTrajectoryDrainBudget,
  type AxTrajectoryDrainResult,
  type AxTrajectoryFieldValue,
  type AxTrajectoryHeader,
  AxTrajectoryQueryError,
  type AxTrajectoryReadQuery,
  type AxTrajectoryStats,
  type AxTrajectoryStep,
  type AxTrajectoryStepClass,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTailResult,
  type AxTrajectoryTypeDescriptor,
  type AxTrajectoryTypeRegistry,
  axTrajectoryMaxStepIds,
} from './types.js';
import {
  axNormalizeTrajectoryTimestamp,
  axTrajectoryCompactData,
  axTrajectoryId,
  axTrajectoryInvalidFieldPath,
  axTrajectoryStepBytes,
} from './util.js';

const DEFAULT_DRAIN_STEPS = 256;
const DEFAULT_DRAIN_BYTES = 1024 * 1024;

function failQuery(
  message: string,
  reason: ConstructorParameters<typeof AxTrajectoryQueryError>[1]
): never {
  throw new AxTrajectoryQueryError(message, reason);
}

function failCursor(
  message: string,
  reason: ConstructorParameters<typeof AxTrajectoryCursorError>[1]
): never {
  throw new AxTrajectoryCursorError(message, reason);
}

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return;
  }
  for (const item of Object.values(value)) freezeDeep(item);
}

/**
 * Invariant I1 in the runtime, not only in the type system. A returned step is
 * a live reference into the store's own index, so without this a reader can
 * rewrite `source` -- the authority field self-trigger suppression keys on --
 * for every later reader in the process. `readonly` fields evaporate at any
 * `as`, any JS caller and any adapter boundary; a frozen object does not.
 */
export function axFreezeTrajectoryStep(
  step: AxTrajectoryStep
): Readonly<AxTrajectoryStep> {
  freezeDeep(step.data);
  if (step.blobs) {
    for (const ref of step.blobs) Object.freeze(ref);
    Object.freeze(step.blobs);
  }
  return Object.freeze(step);
}

/**
 * Everything a bounded read needs about one appended frame WITHOUT
 * materializing it. `at`/`span` locate the frame in whatever the store's
 * medium is -- an array slot for the reference store, a byte range in
 * `steps.jsonl` for the file store -- so a file-backed log can seek instead of
 * holding every parsed step resident. That is what makes I12 ("no read
 * primitive is unbounded") true below the API boundary as well as at it.
 */
export interface AxTrajectoryLogEntry {
  readonly stepId: string;
  readonly type: string;
  readonly stepClass: AxTrajectoryStepClass;
  readonly ts: number;
  /** Persisted step size, for the drain byte budget and store ceilings. */
  readonly bytes: number;
  readonly at: number;
  readonly span: number;
}

export interface AxTrajectoryLogOptions {
  readonly header: Readonly<AxTrajectoryHeader>;
  /** Instance identity carried in cursor tokens so a recreated log is caught. */
  readonly identity: string;
  /** Materializes one frame. Called only for steps a read actually returns. */
  readonly resolve: (
    entry: Readonly<AxTrajectoryLogEntry>,
    seq: number
  ) => Readonly<AxTrajectoryStep>;
}

/**
 * The append-only index and every read primitive over it, shared verbatim by
 * both shipped stores. One implementation of `read`, `tailBackward`,
 * `getStep(s)`, `readFrom` and cursor validation means a fix lands in both
 * stores at once; the conformance kit cannot catch a divergence it does not
 * already assert, so the divergence must be impossible instead.
 */
export class AxTrajectoryLog {
  readonly header: Readonly<AxTrajectoryHeader>;
  readonly identity: string;

  private readonly entries: AxTrajectoryLogEntry[] = [];
  private readonly seqById = new Map<string, number>();
  private readonly newestByClass = new Map<
    AxTrajectoryStepClass,
    { seq: number; stepId: string; ts: number }
  >();
  private readonly resolve: AxTrajectoryLogOptions['resolve'];
  /** Persisted bytes indexed so far, for a store's own size ceiling. */
  bytes = 0;
  /** Frames the tolerant parser dropped, cumulative. */
  corrupt = 0;
  /** How many of those a drain has already reported to a consumer. */
  private reportedCorrupt = 0;

  constructor(options: Readonly<AxTrajectoryLogOptions>) {
    this.header = options.header;
    this.identity = options.identity;
    this.resolve = options.resolve;
  }

  get length(): number {
    return this.entries.length;
  }

  /** One past the last indexed frame, in `at` units. */
  get end(): number {
    const last = this.entries[this.entries.length - 1];
    return last ? last.at + last.span : 0;
  }

  entry(seq: number): Readonly<AxTrajectoryLogEntry> | undefined {
    return this.entries[seq];
  }

  seqOf(stepId: string): number | undefined {
    return this.seqById.get(stepId);
  }

  /** Records a frame. The only place an appended step enters the index. */
  index(entry: Readonly<AxTrajectoryLogEntry>): number {
    const seq = this.entries.length;
    this.entries.push(entry);
    this.seqById.set(entry.stepId, seq);
    this.bytes += entry.bytes;
    this.newestByClass.set(entry.stepClass, {
      seq,
      stepId: entry.stepId,
      ts: entry.ts,
    });
    return seq;
  }

  step(seq: number): Readonly<AxTrajectoryStep> | undefined {
    const entry = this.entries[seq];
    return entry ? this.resolve(entry, seq) : undefined;
  }

  stats(trajectoryId: string): Readonly<AxTrajectoryStats> {
    const newest = this.entries[this.entries.length - 1];
    return {
      trajectoryId,
      stepCount: this.entries.length,
      newestSeq: newest ? this.entries.length - 1 : -1,
      newestTs: newest ? newest.ts : 0,
      newestStepId: newest ? newest.stepId : '',
      newestByClass: Object.fromEntries(this.newestByClass),
    };
  }

  read(
    query: Readonly<AxTrajectoryReadQuery>
  ): readonly Readonly<AxTrajectoryStep>[] {
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
      this.entries.length,
      query.toSeq ?? this.entries.length
    );
    if (to < from) {
      failQuery(`read range ${from}..${to} is inverted`, 'invalid_range');
    }
    const matches = matcher(query.types, query.classes);
    const out: Readonly<AxTrajectoryStep>[] = [];
    for (let seq = from; seq < to; seq++) {
      const entry = this.entries[seq]!;
      if (!matches(entry)) continue;
      out.push(this.resolve(entry, seq));
      if (query.limit !== undefined && out.length >= query.limit) break;
    }
    return out;
  }

  /** §7.9. Only matching frames are materialized; the scan reads metadata. */
  tailBackward(
    query: Readonly<AxTrajectoryTailQuery>
  ): Readonly<AxTrajectoryTailResult> {
    const matches = matcher(query.types, query.classes);
    const maxScan = query.maxScan ?? Math.max(200, 20 * query.limit);
    const chunkSize = Math.max(64, query.limit * 4);
    let cursor = Math.min(
      query.beforeSeq ?? this.entries.length,
      this.entries.length
    );
    let scanned = 0;
    const found: Readonly<AxTrajectoryStep>[] = [];
    while (found.length < query.limit && scanned < maxScan && cursor > 0) {
      const size = Math.min(chunkSize, cursor, maxScan - scanned);
      if (size <= 0) break;
      let examined = 0;
      for (let offset = 1; offset <= size; offset++) {
        const seq = cursor - offset;
        const entry = this.entries[seq]!;
        scanned++;
        examined++;
        if (matches(entry)) found.push(this.resolve(entry, seq));
        if (found.length >= query.limit) break;
      }
      // Decrement by what was actually examined, so `exhausted` means the head
      // was reached rather than "the last chunk happened to be large".
      cursor -= examined;
    }
    return { steps: found.reverse(), scanned, exhausted: cursor === 0 };
  }

  getStep(stepId: string): Readonly<AxTrajectoryStep> | undefined {
    const seq = this.seqById.get(stepId);
    return seq === undefined ? undefined : this.step(seq);
  }

  getSteps(stepIds: readonly string[]): readonly Readonly<AxTrajectoryStep>[] {
    if (stepIds.length > axTrajectoryMaxStepIds) {
      failQuery(
        `getSteps accepts at most ${axTrajectoryMaxStepIds} ids, got ${stepIds.length}`,
        'too_many_ids'
      );
    }
    const out: Readonly<AxTrajectoryStep>[] = [];
    for (const stepId of stepIds) {
      const step = this.getStep(stepId);
      if (step) out.push(step);
    }
    return out;
  }

  readFrom(
    trajectoryId: string,
    cursor: Readonly<AxTrajectoryCursor> | undefined,
    budget: Readonly<AxTrajectoryDrainBudget>
  ): Readonly<AxTrajectoryDrainResult> {
    const maxSteps = budget.maxSteps ?? DEFAULT_DRAIN_STEPS;
    const maxBytes = budget.maxBytes ?? DEFAULT_DRAIN_BYTES;
    const steps: Readonly<AxTrajectoryStep>[] = [];
    let seq = this.validateCursor(trajectoryId, cursor);
    let bytes = 0;
    while (seq < this.entries.length && steps.length < maxSteps) {
      const entry = this.entries[seq]!;
      if (steps.length > 0 && bytes + entry.bytes > maxBytes) break;
      steps.push(this.resolve(entry, seq));
      bytes += entry.bytes;
      seq++;
    }
    const caughtUp = seq === this.entries.length;
    // `corrupt` is what THIS drain skipped, per AxTrajectoryDrainResult's own
    // wording. Reporting the running total forever would leave a polling
    // consumer staring at the same non-zero number for the life of the log.
    let corrupt = 0;
    if (caughtUp && this.corrupt > this.reportedCorrupt) {
      corrupt = this.corrupt - this.reportedCorrupt;
      this.reportedCorrupt = this.corrupt;
    }
    return {
      steps,
      cursor: this.cursorAt(trajectoryId, seq),
      caughtUp,
      corrupt,
    };
  }

  cursorAt(trajectoryId: string, seq: number): Readonly<AxTrajectoryCursor> {
    const entry = this.entries[seq];
    return {
      trajectoryId,
      seq,
      token: `${this.identity}:${entry ? entry.at : this.end}`,
    };
  }

  /**
   * C14. `seq` alone is not a durable position: a tolerant parse that drops an
   * interior frame renumbers everything after it, so a stored `seq` would
   * silently name a different record. The token's frame location is therefore
   * authoritative for WHERE to resume, and a location that no longer lands on
   * a frame boundary is rejected rather than rounded to one.
   */
  validateCursor(
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
    if (!Number.isInteger(cursor.seq) || cursor.seq < 0) {
      failCursor(
        `cursor seq ${cursor.seq} is not a frame boundary`,
        'not_a_frame_boundary'
      );
    }
    const token = cursor.token;
    if (token === undefined) {
      if (cursor.seq > this.entries.length) {
        failCursor(`cursor seq ${cursor.seq} is beyond the end`, 'beyond_end');
      }
      return cursor.seq;
    }
    const split = token.lastIndexOf(':');
    if (token.slice(0, split) !== this.identity) {
      failCursor(
        `cursor token is from another instance of ${trajectoryId}`,
        'identity_changed'
      );
    }
    const at = Number(token.slice(split + 1));
    if (!Number.isFinite(at) || at > this.end) {
      failCursor(`the log shrank below cursor position ${at}`, 'shrank');
    }
    if (cursor.seq > this.entries.length) {
      failCursor(`cursor seq ${cursor.seq} is beyond the end`, 'beyond_end');
    }
    const resolved = this.seqAt(at);
    if (resolved === undefined) {
      failCursor(
        `cursor position ${at} is not a frame boundary`,
        'not_a_frame_boundary'
      );
    }
    return resolved;
  }

  /** Binary search: `at` is ascending, and `end` is the past-the-last slot. */
  private seqAt(at: number): number | undefined {
    if (at === this.end) return this.entries.length;
    let low = 0;
    let high = this.entries.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = this.entries[mid]!.at;
      if (value === at) return mid;
      if (value < at) low = mid + 1;
      else high = mid - 1;
    }
    return undefined;
  }
}

function matcher(
  types: readonly string[] | undefined,
  classes: readonly AxTrajectoryStepClass[] | undefined
): (entry: Readonly<AxTrajectoryLogEntry>) => boolean {
  const typeSet = types ? new Set(types) : undefined;
  const classSet = classes ? new Set(classes) : undefined;
  return (entry) =>
    (!typeSet || typeSet.has(entry.type)) &&
    (!classSet || classSet.has(entry.stepClass));
}

export interface AxTrajectoryPreparedStep {
  readonly stepId: string;
  readonly ts: number;
  readonly data: Readonly<Record<string, AxTrajectoryFieldValue>>;
  readonly descriptor: Readonly<AxTrajectoryTypeDescriptor>;
}

/**
 * The write-boundary validation both stores run before anything is persisted,
 * including I13's fail-closed `source` check. Shared so a store cannot skip a
 * check by accident, and so I13 cannot be weakened in one store only.
 */
export function axPrepareTrajectoryStep(
  request: Readonly<AxTrajectoryAppendRequest>,
  registry: AxTrajectoryTypeRegistry,
  clock: AxEventClock
): AxTrajectoryPreparedStep {
  const descriptor = registry.describe(request.type);
  if (request.source !== undefined && !descriptor.carriesSource) {
    throw new AxTrajectoryAppendError(
      `step type "${request.type}" may not carry a source`,
      'validate',
      'source_on_machinery_step'
    );
  }
  const data = axTrajectoryCompactData(request.data);
  const invalid = axTrajectoryInvalidFieldPath(data);
  if (invalid) {
    throw new AxTrajectoryAppendError(
      `step field ${invalid} is not persistable`,
      'validate',
      'invalid_field'
    );
  }
  let ts = clock.now();
  if (request.ts !== undefined) {
    const normalized = axNormalizeTrajectoryTimestamp(request.ts);
    if (normalized === undefined) {
      throw new AxTrajectoryAppendError(
        `step ts ${request.ts} is not finite`,
        'validate',
        'invalid_field'
      );
    }
    ts = normalized;
  }
  return {
    stepId: request.stepId ?? axTrajectoryId('step'),
    ts,
    data,
    descriptor,
  };
}

export interface AxTrajectorySpillStepOptions {
  readonly request: Readonly<AxTrajectoryAppendRequest>;
  readonly prepared: AxTrajectoryPreparedStep;
  readonly seq: number;
  readonly blobs: AxTrajectoryBlobStore;
  readonly policy?: Readonly<AxTrajectorySpillPolicy>;
  readonly signal?: AbortSignal;
}

export interface AxTrajectorySpilledStep {
  readonly step: Readonly<AxTrajectoryStep>;
  readonly spilled: readonly string[];
  readonly bytes: number;
}

/**
 * Spills the oversized fields and builds the frozen step. Blob durability
 * precedes step construction here and step visibility in the caller, which is
 * the whole of I2: a failed blob write means no step is ever built.
 */
export async function axSpillTrajectoryStep(
  options: Readonly<AxTrajectorySpillStepOptions>
): Promise<AxTrajectorySpilledStep> {
  const { request, prepared, seq } = options;
  let spilled: Awaited<ReturnType<typeof axSpillTrajectoryFields>>;
  try {
    spilled = await axSpillTrajectoryFields({
      trajectoryId: request.trajectoryId,
      stepId: prepared.stepId,
      data: prepared.data,
      blobs: options.blobs,
      policy: options.policy,
      spillFields: prepared.descriptor.spillFields,
      signal: options.signal,
    });
  } catch (cause) {
    throw new AxTrajectoryAppendError(
      `blob spill failed for step ${prepared.stepId}`,
      'blob',
      'blob_write_failed',
      { cause }
    );
  }
  const step = axFreezeTrajectoryStep({
    stepId: prepared.stepId,
    trajectoryId: request.trajectoryId,
    seq,
    type: request.type,
    ts: prepared.ts,
    runId: request.runId,
    triggerStep: request.triggerStep,
    launchedBy: request.launchedBy,
    source: request.source,
    data: spilled.data,
    blobs: spilled.blobs.length > 0 ? spilled.blobs : undefined,
  });
  return {
    step,
    spilled: spilled.spilled,
    bytes: axTrajectoryStepBytes(step),
  };
}
