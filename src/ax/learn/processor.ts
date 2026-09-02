/**
 * Eligibility, matching, and batching for late and out-of-order feedback.
 *
 * This is the piece with no analog anywhere else in ax. A report names one or
 * more interaction receipts, and it may arrive before them, long after them, or
 * for an exchange that has already trained. The reducer decides `train`, `wait`
 * or `never` for every record it sees, names and counts every `never` reason
 * forever, and hands out batches that stay stable until acknowledged.
 *
 * It is a pure function over an immutable state value: no clock, no IO, no
 * mutation of the state handed in. That is what makes the whole loop replayable
 * from the durable record log.
 */

import { axEventCanonicalJson } from '../event/util.js';

import type {
  AxLearningArtifactRef,
  AxLearningInteractionPayload,
  AxLearningInteractionRecord,
  AxLearningRecord,
  AxLearningRecordId,
  AxLearningReportPayload,
  AxLearningReportRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Units, samples, decisions
// ---------------------------------------------------------------------------

export interface AxLearningTrainingSample {
  /** The interaction receipt this sample came from. */
  readonly sourceRecordId: AxLearningRecordId;
  /** The recorded interaction payload, projected by `sampleFields`. */
  readonly payload: Readonly<Partial<AxLearningInteractionPayload>>;
  readonly score: number;
  readonly artifactRef?: Readonly<AxLearningArtifactRef>;
  readonly feedback?: AxLearningReportPayload['feedback'];
}

export interface AxLearningTrainingUnit {
  readonly reportId: AxLearningRecordId;
  readonly samples: readonly Readonly<AxLearningTrainingSample>[];
  /** Units sharing a group key batch together or not at all. */
  readonly groupKey?: string;
  /** At most one ready unit may hold a given slot. */
  readonly slot?: string;
}

/**
 * Named reasons. Logged once per distinct reason and counted forever.
 *
 * `'schema-invalid'` is deliberately absent: schema validation happens at
 * ingress, so a schema-invalid report never becomes a record and never reaches
 * the reducer. A future `observe` event route that appends a report record
 * directly must move that validation in here before the reason can exist.
 */
export type AxLearningNeverReason =
  | 'no-references'
  | 'no-score'
  | 'non-finite-score'
  | 'boolean-score'
  | 'training-opted-out'
  | 'duplicate-references'
  | 'multi-reference'
  | 'score-outside-window'
  | 'already-trained-source'
  | 'report-already-seen'
  | 'slot-occupied'
  | 'group-discarded';

export type AxLearningDecision = Readonly<
  | { outcome: 'train'; unit: Readonly<AxLearningTrainingUnit> }
  | { outcome: 'wait'; missing: readonly AxLearningRecordId[] }
  | { outcome: 'never'; reason: AxLearningNeverReason | (string & {}) }
>;

/** Three states, discriminated — not one nullable array. */
export type AxLearningReferenceResolution = Readonly<
  | {
      status: 'resolved';
      interactions: readonly Readonly<AxLearningInteractionRecord>[];
    }
  | { status: 'waiting'; missing: readonly AxLearningRecordId[] }
  | { status: 'malformed'; reason: 'duplicate-references' }
>;

export interface AxLearningReportContext {
  readonly report: Readonly<AxLearningReportRecord>;
  /** undefined when absent, non-numeric, boolean, or non-finite. */
  readonly score: number | undefined;
  /** `metadata.training.eligible !== false`. */
  readonly trainable: boolean;
  readonly references: readonly AxLearningRecordId[];
  readonly resolution: AxLearningReferenceResolution;
}

export interface AxLearningProcessor {
  /** Stable identity recorded on batches and gate decisions. */
  readonly id: string;
  readonly batchSize: number;
  /**
   * Called only after the universal gate's terminal checks have passed. May be
   * called with an unresolved context: return `wait` with the missing ids in
   * that case, and `train` only when `resolution.status === 'resolved'`.
   */
  judge(context: Readonly<AxLearningReportContext>): AxLearningDecision;
}

// ---------------------------------------------------------------------------
// The universal gate
// ---------------------------------------------------------------------------

function never(
  reason: AxLearningNeverReason | (string & {})
): AxLearningDecision {
  return Object.freeze({ outcome: 'never' as const, reason });
}

/** Normalize a raw score to the number the reducer will rank on. */
function normalizeScore(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * `metadata.training.eligible === false` is the ONE metadata key the framework
 * reads. Anything else — a missing key, a string, a `0` — keeps the report
 * trainable, so an opt-out has to be written deliberately.
 */
function isTrainable(payload: Readonly<AxLearningReportPayload>): boolean {
  const training = payload.metadata?.training;
  if (
    typeof training !== 'object' ||
    training === null ||
    Array.isArray(training)
  ) {
    return true;
  }
  return (training as { eligible?: unknown }).eligible !== false;
}

/**
 * The universal gate: the terminal checks and the wait state every processor
 * shares. Returns `undefined` when the report is resolved and eligible, so the
 * processor's own rules can run.
 */
export const axLearningEligibility = (
  context: Readonly<AxLearningReportContext>
): AxLearningDecision | undefined => {
  if (context.references.length === 0) return never('no-references');

  const raw = context.report.payload.score;
  if (raw === undefined) return never('no-score');
  if (typeof raw === 'boolean') return never('boolean-score');
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return never('non-finite-score');
  }

  if (!context.trainable) return never('training-opted-out');

  if (context.resolution.status === 'malformed') {
    return never(context.resolution.reason);
  }
  if (context.resolution.status === 'waiting') {
    return Object.freeze({
      outcome: 'wait' as const,
      missing: context.resolution.missing,
    });
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// The default processor
// ---------------------------------------------------------------------------

export interface AxScoreWindowProcessorOptions {
  readonly id?: string;
  readonly batchSize?: number;
  readonly minScore?: number;
  readonly maxScore?: number;
}

/**
 * The default processor: batch a report when its single referenced exchange
 * scored inside `[minScore, maxScore]`.
 *
 * `maxScore` defaults to 0, so out of the box only failures batch — the regime
 * where a harness change has something to learn from. `maxScore: Infinity`
 * makes the whole stream batch instead.
 */
export const axScoreWindowProcessor = (
  options?: Readonly<AxScoreWindowProcessorOptions>
): AxLearningProcessor => {
  const id = options?.id ?? 'axScoreWindow';
  const batchSize = options?.batchSize ?? 1;
  const minScore = options?.minScore ?? Number.NEGATIVE_INFINITY;
  const maxScore = options?.maxScore ?? 0;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error(
      'axScoreWindowProcessor: batchSize must be a positive safe integer'
    );
  }
  if (minScore > maxScore) {
    throw new Error(
      'axScoreWindowProcessor: minScore must not exceed maxScore'
    );
  }

  return Object.freeze({
    id,
    batchSize,
    judge(context: Readonly<AxLearningReportContext>): AxLearningDecision {
      // Arity and window are terminal BEFORE the references resolve, so a
      // report the processor can never use releases immediately instead of
      // parking forever.
      if (context.references.length !== 1) return never('multi-reference');
      const score = context.score;
      if (score === undefined || score < minScore || score > maxScore) {
        return never('score-outside-window');
      }
      if (context.resolution.status === 'waiting') {
        return Object.freeze({
          outcome: 'wait' as const,
          missing: context.resolution.missing,
        });
      }
      if (context.resolution.status !== 'resolved') {
        return never(context.resolution.reason);
      }
      const samples = context.resolution.interactions.map((interaction) =>
        Object.freeze({
          sourceRecordId: interaction.id,
          payload: interaction.payload,
          score,
          ...(interaction.artifactRef === undefined
            ? {}
            : { artifactRef: interaction.artifactRef }),
          ...(context.report.payload.feedback === undefined
            ? {}
            : { feedback: context.report.payload.feedback }),
        })
      );
      return Object.freeze({
        outcome: 'train' as const,
        unit: Object.freeze({ reportId: context.report.id, samples }),
      });
    },
  });
};

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export interface AxLearningBatch {
  readonly batchId: string;
  readonly scenario: string;
  readonly processorId: string;
  readonly batchNumber: number;
  readonly units: readonly Readonly<AxLearningTrainingUnit>[];
  readonly samples: readonly Readonly<AxLearningTrainingSample>[];
  /** Samples withheld by the byte cap. Counted so shrinkage is never silent. */
  readonly droppedSamples: number;
}

/** Opaque immutable reducer state. Structurally cloneable; safe to snapshot. */
export interface AxLearningEngineState {
  readonly scenario: string;
  readonly processorId: string;
  readonly batchSize: number;
  readonly readyCount: number;
  readonly waitingCount: number;
  readonly pendingBatchId?: string;
  readonly neverReasons: Readonly<Record<string, number>>;
  /** @internal opaque payload; do not read. Stable only through the reducers. */
  readonly _internal: unknown;
}

export interface AxLearningEngineDecisionEntry {
  readonly reportId: AxLearningRecordId;
  readonly decision: AxLearningDecision;
}

export interface AxLearningEngineStep {
  readonly state: AxLearningEngineState;
  readonly decisions: readonly Readonly<AxLearningEngineDecisionEntry>[];
}

export interface AxLearningEngineOptions {
  readonly scenario: string;
  readonly processor: AxLearningProcessor;
  /**
   * Which payload fields reach a training sample and therefore a model prompt.
   * Default `['input', 'output', 'failure']` — `model`, `usage` and host `tags`
   * are withheld unless asked for.
   */
  readonly sampleFields?: readonly (keyof AxLearningInteractionPayload)[];
  /** Canonical-JSON byte cap over a batch's whole sample set. Default 65_536. */
  readonly maxSampleBytes?: number;
}

const DEFAULT_SAMPLE_FIELDS: readonly (keyof AxLearningInteractionPayload)[] = [
  'input',
  'output',
  'failure',
];
const DEFAULT_MAX_SAMPLE_BYTES = 65_536;

type EngineInternal = {
  readonly processor: AxLearningProcessor;
  readonly sampleFields: readonly (keyof AxLearningInteractionPayload)[];
  readonly maxSampleBytes: number;
  readonly byId: ReadonlyMap<
    AxLearningRecordId,
    Readonly<AxLearningInteractionRecord>
  >;
  /** interaction id → report ids parked on it. The only index ingest walks. */
  readonly waiting: ReadonlyMap<AxLearningRecordId, readonly string[]>;
  readonly parked: ReadonlyMap<string, Readonly<AxLearningReportRecord>>;
  readonly seenReports: ReadonlySet<string>;
  readonly trainedSources: ReadonlySet<AxLearningRecordId>;
  readonly readyUnits: readonly Readonly<AxLearningTrainingUnit>[];
  readonly pendingBatch?: Readonly<AxLearningBatch>;
};

function internalOf(state: AxLearningEngineState): EngineInternal {
  return state._internal as EngineInternal;
}

function publish(
  state: AxLearningEngineState,
  internal: EngineInternal,
  neverReasons: Readonly<Record<string, number>>
): AxLearningEngineState {
  return Object.freeze({
    scenario: state.scenario,
    processorId: state.processorId,
    batchSize: state.batchSize,
    readyCount: internal.readyUnits.length,
    waitingCount: internal.parked.size,
    ...(internal.pendingBatch === undefined
      ? {}
      : { pendingBatchId: internal.pendingBatch.batchId }),
    neverReasons,
    _internal: Object.freeze(internal),
  });
}

function counted(
  reasons: Readonly<Record<string, number>>,
  reason: string
): Readonly<Record<string, number>> {
  return Object.freeze({ ...reasons, [reason]: (reasons[reason] ?? 0) + 1 });
}

export const axCreateLearningEngineState = (
  options: Readonly<AxLearningEngineOptions>
): AxLearningEngineState => {
  const { scenario, processor } = options;
  if (typeof scenario !== 'string' || scenario.length === 0) {
    throw new Error(
      'axCreateLearningEngineState: scenario must be a non-empty string'
    );
  }
  const maxSampleBytes = options.maxSampleBytes ?? DEFAULT_MAX_SAMPLE_BYTES;
  if (!Number.isSafeInteger(maxSampleBytes) || maxSampleBytes < 1) {
    throw new Error(
      'axCreateLearningEngineState: maxSampleBytes must be a positive safe integer'
    );
  }
  const internal: EngineInternal = {
    processor,
    sampleFields: Object.freeze([
      ...(options.sampleFields ?? DEFAULT_SAMPLE_FIELDS),
    ]),
    maxSampleBytes,
    byId: new Map(),
    waiting: new Map(),
    parked: new Map(),
    seenReports: new Set(),
    trainedSources: new Set(),
    readyUnits: Object.freeze([]),
  };
  return Object.freeze({
    scenario,
    processorId: processor.id,
    batchSize: processor.batchSize,
    readyCount: 0,
    waitingCount: 0,
    neverReasons: Object.freeze({}),
    _internal: Object.freeze(internal),
  });
};

function resolveReferences(
  references: readonly AxLearningRecordId[],
  byId: EngineInternal['byId']
): AxLearningReferenceResolution {
  if (new Set(references).size !== references.length) {
    return Object.freeze({
      status: 'malformed' as const,
      reason: 'duplicate-references' as const,
    });
  }
  const missing = references.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return Object.freeze({
      status: 'waiting' as const,
      missing: Object.freeze(missing),
    });
  }
  const interactions = references.map((id) => {
    const record = byId.get(id);
    if (!record) {
      throw new Error(
        `AxLearningEngine: reference ${id} vanished during resolution`
      );
    }
    return record;
  });
  return Object.freeze({
    status: 'resolved' as const,
    interactions: Object.freeze(interactions),
  });
}

function buildContext(
  report: Readonly<AxLearningReportRecord>,
  byId: EngineInternal['byId']
): AxLearningReportContext {
  return Object.freeze({
    report,
    score: normalizeScore(report.payload.score),
    trainable: isTrainable(report.payload),
    references: report.references,
    resolution: resolveReferences(report.references, byId),
  });
}

/**
 * Copy-on-write working set for one reducer call.
 *
 * Only the collections a call actually touches are copied, so ingesting an
 * interaction nobody was waiting on does not clone the whole record index. The
 * state handed in is never mutated: purity is what makes the loop replayable
 * from the durable log.
 */
class Draft {
  private byIdCopy: Map<
    AxLearningRecordId,
    Readonly<AxLearningInteractionRecord>
  > | null = null;
  private waitingCopy: Map<AxLearningRecordId, string[]> | null = null;
  private parkedCopy: Map<string, Readonly<AxLearningReportRecord>> | null =
    null;
  private seenCopy: Set<string> | null = null;
  private readyCopy: Readonly<AxLearningTrainingUnit>[] | null = null;
  private slotsCopy: Set<string> | null = null;

  reasons: Readonly<Record<string, number>>;

  constructor(
    private readonly internal: EngineInternal,
    reasons: Readonly<Record<string, number>>,
    private readonly baseSlots: ReadonlySet<string>
  ) {
    this.reasons = reasons;
  }

  get byId(): ReadonlyMap<
    AxLearningRecordId,
    Readonly<AxLearningInteractionRecord>
  > {
    return this.byIdCopy ?? this.internal.byId;
  }

  get waiting(): ReadonlyMap<AxLearningRecordId, readonly string[]> {
    return this.waitingCopy ?? this.internal.waiting;
  }

  get parked(): ReadonlyMap<string, Readonly<AxLearningReportRecord>> {
    return this.parkedCopy ?? this.internal.parked;
  }

  get seenReports(): ReadonlySet<string> {
    return this.seenCopy ?? this.internal.seenReports;
  }

  get readyUnits(): readonly Readonly<AxLearningTrainingUnit>[] {
    return this.readyCopy ?? this.internal.readyUnits;
  }

  get occupiedSlots(): ReadonlySet<string> {
    return this.slotsCopy ?? this.baseSlots;
  }

  /** Only `acknowledge` adds to this set, so ingest never needs to copy it. */
  get trainedSources(): ReadonlySet<AxLearningRecordId> {
    return this.internal.trainedSources;
  }

  private mutableById(): Map<
    AxLearningRecordId,
    Readonly<AxLearningInteractionRecord>
  > {
    this.byIdCopy ??= new Map(this.internal.byId);
    return this.byIdCopy;
  }

  private mutableWaiting(): Map<AxLearningRecordId, string[]> {
    this.waitingCopy ??= new Map(
      [...this.internal.waiting].map(([key, value]) => [key, [...value]])
    );
    return this.waitingCopy;
  }

  private mutableParked(): Map<string, Readonly<AxLearningReportRecord>> {
    this.parkedCopy ??= new Map(this.internal.parked);
    return this.parkedCopy;
  }

  private mutableReady(): Readonly<AxLearningTrainingUnit>[] {
    this.readyCopy ??= [...this.internal.readyUnits];
    return this.readyCopy;
  }

  private mutableSlots(): Set<string> {
    this.slotsCopy ??= new Set(this.baseSlots);
    return this.slotsCopy;
  }

  rememberInteraction(record: Readonly<AxLearningInteractionRecord>): void {
    this.mutableById().set(record.id, record);
  }

  markReportSeen(id: string): void {
    this.seenCopy ??= new Set(this.internal.seenReports);
    this.seenCopy.add(id);
  }

  takeWaiters(interactionId: AxLearningRecordId): readonly string[] {
    const waiters = this.waiting.get(interactionId);
    if (!waiters || waiters.length === 0) return [];
    this.mutableWaiting().delete(interactionId);
    return [...waiters];
  }

  park(report: Readonly<AxLearningReportRecord>): void {
    this.mutableParked().set(report.id, report);
    const waiting = this.mutableWaiting();
    for (const reference of report.references) {
      if (this.byId.has(reference)) continue;
      const waiters = waiting.get(reference) ?? [];
      if (!waiters.includes(report.id)) waiters.push(report.id);
      waiting.set(reference, waiters);
    }
  }

  /** Release a report and its waiting entries, touching only its own references. */
  release(report: Readonly<AxLearningReportRecord>): void {
    if (this.parked.has(report.id)) this.mutableParked().delete(report.id);
    for (const reference of report.references) {
      const waiters = this.waiting.get(reference);
      if (!waiters?.includes(report.id)) continue;
      const waitingMap = this.mutableWaiting();
      const next = waiters.filter((id) => id !== report.id);
      if (next.length === 0) waitingMap.delete(reference);
      else waitingMap.set(reference, next);
    }
  }

  pushReady(unit: Readonly<AxLearningTrainingUnit>): void {
    this.mutableReady().push(unit);
    if (unit.slot !== undefined) this.mutableSlots().add(unit.slot);
  }

  count(reason: string): void {
    this.reasons = counted(this.reasons, reason);
  }

  commit(): EngineInternal {
    return {
      ...this.internal,
      byId: this.byIdCopy ?? this.internal.byId,
      waiting: this.waitingCopy
        ? new Map(
            [...this.waitingCopy].map(([key, value]) => [
              key,
              Object.freeze([...value]),
            ])
          )
        : this.internal.waiting,
      parked: this.parkedCopy ?? this.internal.parked,
      seenReports: this.seenCopy ?? this.internal.seenReports,
      readyUnits: this.readyCopy
        ? Object.freeze([...this.readyCopy])
        : this.internal.readyUnits,
    };
  }
}

/** The slots held by ready units AND by an un-acknowledged pending batch. */
function occupiedSlotsOf(internal: EngineInternal): ReadonlySet<string> {
  const slots = new Set<string>();
  for (const unit of internal.readyUnits) {
    if (unit.slot !== undefined) slots.add(unit.slot);
  }
  for (const unit of internal.pendingBatch?.units ?? []) {
    if (unit.slot !== undefined) slots.add(unit.slot);
  }
  return slots;
}

/**
 * Judge one report against the current draft and record the consequence.
 *
 * Every terminal outcome increments its named counter, because feedback that
 * vanishes silently is the failure mode this whole subsystem exists to prevent.
 */
function judgeReport(
  draft: Draft,
  processor: AxLearningProcessor,
  report: Readonly<AxLearningReportRecord>
): AxLearningDecision {
  if (report.references.some((id) => draft.trainedSources.has(id))) {
    draft.count('already-trained-source');
    draft.release(report);
    return never('already-trained-source');
  }

  const context = buildContext(report, draft.byId);
  const gate = axLearningEligibility(context);
  if (gate?.outcome === 'never') {
    draft.count(gate.reason);
    draft.release(report);
    return gate;
  }

  const decision = processor.judge(context);
  if (decision.outcome === 'never') {
    draft.count(decision.reason);
    draft.release(report);
    return decision;
  }
  if (decision.outcome === 'wait') {
    if (decision.missing.length === 0) {
      throw new Error(
        `AxLearningEngine: processor ${processor.id} returned wait with no missing reference for report ${report.id}`
      );
    }
    draft.park(report);
    return decision;
  }

  const slot = decision.unit.slot;
  if (slot !== undefined && draft.occupiedSlots.has(slot)) {
    draft.count('slot-occupied');
    draft.release(report);
    return never('slot-occupied');
  }

  draft.release(report);
  draft.pushReady(decision.unit);
  return decision;
}

/**
 * Fold one record into the reducer state.
 *
 * An arriving interaction re-judges ONLY the reports parked on its id — the
 * waiting index is keyed by interaction id precisely so a backlog of unrelated
 * parked reports costs nothing.
 */
export const axLearningEngineIngest = (
  state: AxLearningEngineState,
  record: AxLearningRecord
): AxLearningEngineStep => {
  const internal = internalOf(state);
  const draft = new Draft(
    internal,
    state.neverReasons,
    occupiedSlotsOf(internal)
  );
  const decisions: AxLearningEngineDecisionEntry[] = [];

  if (record.kind === 'interaction') {
    if (draft.byId.has(record.id)) return { state, decisions: [] };
    const waiters = draft.takeWaiters(record.id);
    draft.rememberInteraction(record);
    for (const reportId of waiters) {
      const parkedReport = draft.parked.get(reportId);
      if (!parkedReport) continue;
      const decision = judgeReport(draft, internal.processor, parkedReport);
      decisions.push(Object.freeze({ reportId, decision }));
    }
  } else {
    if (draft.seenReports.has(record.id)) {
      draft.count('report-already-seen');
      return {
        state: publish(state, draft.commit(), draft.reasons),
        decisions: Object.freeze([]),
      };
    }
    draft.markReportSeen(record.id);
    const decision = judgeReport(draft, internal.processor, record);
    decisions.push(Object.freeze({ reportId: record.id, decision }));
  }

  return {
    state: publish(state, draft.commit(), draft.reasons),
    decisions: Object.freeze(decisions),
  };
};

export const axLearningEngineReady = (state: AxLearningEngineState): boolean =>
  state.pendingBatchId !== undefined || state.readyCount >= state.batchSize;

function projectSample(
  sample: Readonly<AxLearningTrainingSample>,
  fields: readonly (keyof AxLearningInteractionPayload)[]
): Readonly<AxLearningTrainingSample> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const value = sample.payload[field];
    if (value !== undefined) payload[field] = value;
  }
  return Object.freeze({ ...sample, payload: Object.freeze(payload) });
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(axEventCanonicalJson(value)).length;
}

/**
 * Build (or re-hand-out) the current batch.
 *
 * The same batch comes back until it is acknowledged: a caller that crashed
 * mid-nomination must be able to ask again and get the identical work, or the
 * loop is not replayable.
 */
export const axLearningEngineBuildBatch = (
  state: AxLearningEngineState,
  batchNumber: number
): Readonly<{
  state: AxLearningEngineState;
  batch: Readonly<AxLearningBatch>;
}> => {
  const internal = internalOf(state);
  if (internal.pendingBatch) {
    return { state, batch: internal.pendingBatch };
  }
  if (!Number.isSafeInteger(batchNumber) || batchNumber < 1) {
    throw new Error(
      'axLearningEngineBuildBatch: batchNumber must be a positive safe integer'
    );
  }

  const { batchSize } = state;
  const selected: Readonly<AxLearningTrainingUnit>[] = [];
  const remaining: Readonly<AxLearningTrainingUnit>[] = [];
  let reasons = state.neverReasons;

  // Group sizes are needed up front: a group batches whole or not at all, and
  // one larger than batchSize can never batch, so it is discarded with a
  // counted reason rather than silently blocking the queue forever.
  const groupSizes = new Map<string, number>();
  for (const unit of internal.readyUnits) {
    if (unit.groupKey === undefined) continue;
    groupSizes.set(unit.groupKey, (groupSizes.get(unit.groupKey) ?? 0) + 1);
  }

  for (const unit of internal.readyUnits) {
    const key = unit.groupKey;
    if (key !== undefined) {
      const size = groupSizes.get(key) ?? 0;
      if (size > batchSize) {
        // A group larger than the batch can never batch. Dropping it with a
        // counted reason beats letting it block the queue forever.
        reasons = counted(reasons, 'group-discarded');
        continue;
      }
      const alreadyTaken = selected.some((taken) => taken.groupKey === key);
      if (alreadyTaken) {
        selected.push(unit);
        continue;
      }
      if (selected.length + size <= batchSize) {
        selected.push(unit);
        continue;
      }
      remaining.push(unit);
      continue;
    }
    if (selected.length < batchSize) selected.push(unit);
    else remaining.push(unit);
  }

  // Apply the projection, then the byte cap. A unit is atomic, so the cap drops
  // whole units oldest-first and the survivors stay complete; every dropped
  // unit goes back on the ready queue for the next batch.
  const projected = selected.map((unit) =>
    Object.freeze({
      ...unit,
      samples: Object.freeze(
        unit.samples.map((sample) =>
          projectSample(sample, internal.sampleFields)
        )
      ),
    })
  );

  const kept = [...projected];
  const deferred: Readonly<AxLearningTrainingUnit>[] = [];
  let droppedSamples = 0;
  while (
    kept.length > 1 &&
    byteLength(kept.flatMap((unit) => unit.samples)) > internal.maxSampleBytes
  ) {
    const oldest = kept.shift();
    if (!oldest) break;
    droppedSamples += oldest.samples.length;
    deferred.push(oldest);
  }

  const batch: Readonly<AxLearningBatch> = Object.freeze({
    batchId: `${state.scenario}:${state.processorId}:${batchNumber}`,
    scenario: state.scenario,
    processorId: state.processorId,
    batchNumber,
    units: Object.freeze(kept),
    samples: Object.freeze(kept.flatMap((unit) => unit.samples)),
    droppedSamples,
  });

  // Deferred units keep their arrival order ahead of the units this batch did
  // not reach.
  const nextReady = Object.freeze([...deferred, ...remaining]);
  const nextInternal: EngineInternal = {
    ...internal,
    readyUnits: nextReady,
    pendingBatch: batch,
  };
  return { state: publish(state, nextInternal, reasons), batch };
};

/**
 * Retire the pending batch.
 *
 * The returned ids are exactly what the caller passes to
 * `store.markConsumed(...)`, and only AFTER the nomination is durable: consume
 * first and a crash loses the evidence for a decision nobody recorded.
 */
export const axLearningEngineAcknowledge = (
  state: AxLearningEngineState,
  batchId: string
): Readonly<{
  state: AxLearningEngineState;
  consumedIds: readonly AxLearningRecordId[];
}> => {
  const internal = internalOf(state);
  const pending = internal.pendingBatch;
  if (!pending || pending.batchId !== batchId) {
    throw new Error(
      `AxLearningEngine: no pending batch ${batchId} to acknowledge`
    );
  }
  const trainedSources = new Set(internal.trainedSources);
  const consumed: AxLearningRecordId[] = [];
  for (const unit of pending.units) {
    for (const sample of unit.samples) {
      trainedSources.add(sample.sourceRecordId);
      if (!consumed.includes(sample.sourceRecordId)) {
        consumed.push(sample.sourceRecordId);
      }
    }
    if (!consumed.includes(unit.reportId)) consumed.push(unit.reportId);
  }
  const { pendingBatch: _retired, ...rest } = internal;
  const nextInternal: EngineInternal = { ...rest, trainedSources };
  return {
    state: publish(state, nextInternal, state.neverReasons),
    consumedIds: Object.freeze(consumed),
  };
};

export const axLearningEngineNeverReasons = (
  state: AxLearningEngineState
): Readonly<Record<string, number>> => state.neverReasons;
