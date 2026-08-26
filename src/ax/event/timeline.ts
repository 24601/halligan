export const AxTemporalEnvelopeSchema = 'ax.interaction.temporal' as const;
export const AxInteractionTimelineSchema = 'ax.interaction.timeline' as const;
export const AxInteractionTimelineVersion = 1 as const;

export const AxInteractionTimelineDefaults = Object.freeze({
  maxEvents: 1_024,
  maxBytes: 1_048_576,
  maxStreams: 128,
  reorderWindowUs: 250_000,
});

export type AxSessionTimeRange = Readonly<{
  timebase: 'session';
  startUs: number;
  endUs: number;
}>;

export type AxMediaTimeRange = Readonly<{
  timebase: 'media';
  startUs: number;
  endUs: number;
}>;

export type AxAudioFrameInteractionEvent = Readonly<{
  kind: 'audio_frame';
  mediaId: string;
  mediaRange: AxMediaTimeRange;
  observedRange?: AxSessionTimeRange;
  sampleCount?: number;
}>;

export type AxTranscriptInteractionEvent = Readonly<{
  kind: 'transcript';
  text: string;
  final: boolean;
  mediaRange?: AxMediaTimeRange;
  observedRange?: AxSessionTimeRange;
  confidence?: number;
}>;

export type AxVisualObservationInteractionEvent = Readonly<{
  kind: 'visual_observation';
  mediaId: string;
  observedRange: AxSessionTimeRange;
  mediaRange?: AxMediaTimeRange;
  mimeType?: string;
}>;

export type AxTextInteractionEvent = Readonly<{
  kind: 'text';
  text: string;
  observedRange?: AxSessionTimeRange;
}>;

export type AxToolActivityInteractionEvent = Readonly<{
  kind: 'tool_activity';
  toolCallId: string;
  phase: 'requested' | 'started' | 'completed' | 'failed' | 'cancelled';
  toolName?: string;
  observedRange?: AxSessionTimeRange;
}>;

export type AxGeneratedMediaInteractionEvent = Readonly<{
  kind: 'generated_media';
  mediaId: string;
  modality: 'audio' | 'image' | 'video';
  mediaRange?: AxMediaTimeRange;
  generatedRange?: AxSessionTimeRange;
  playedRange?: AxSessionTimeRange;
  mimeType?: string;
}>;

export type AxControlInteractionEvent = Readonly<{
  kind: 'control';
  signal: 'start' | 'stop' | 'interrupt' | 'resume' | 'cancel' | 'end_of_turn';
  targetEventIds?: readonly string[];
  observedRange?: AxSessionTimeRange;
}>;

export type AxInteractionEvent =
  | AxAudioFrameInteractionEvent
  | AxTranscriptInteractionEvent
  | AxVisualObservationInteractionEvent
  | AxTextInteractionEvent
  | AxToolActivityInteractionEvent
  | AxGeneratedMediaInteractionEvent
  | AxControlInteractionEvent;

/**
 * Provider-neutral timing metadata for one immutable interaction observation.
 * Session and media times are host-assigned monotonic microseconds. `wallTime`
 * is optional diagnostic context and is never used for ordering.
 */
export interface AxTemporalEnvelope<
  EVENT extends AxInteractionEvent = AxInteractionEvent,
> {
  readonly schema: typeof AxTemporalEnvelopeSchema;
  readonly version: typeof AxInteractionTimelineVersion;
  readonly eventId: string;
  readonly streamId: string;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly participantId?: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly revision: number;
  readonly sessionTimeUs: number;
  readonly wallTime?: string;
  readonly causalParentIds?: readonly string[];
  /** Non-causal references. Links do not establish temporal alignment. */
  readonly linkIds?: readonly string[];
  readonly event: Readonly<EVENT>;
}

export type AxTemporalClassification =
  | 'in_order'
  | 'new_epoch'
  | 'revision'
  | 'reordered'
  | 'late'
  | 'duplicate'
  | 'stale_epoch'
  | 'stale_revision'
  | 'identity_conflict'
  | 'sequence_conflict'
  | 'temporal_conflict'
  | 'causal_cycle'
  | 'stream_limit'
  | 'oversize';

export interface AxInteractionTimelineOptions {
  readonly sessionId: string;
  /** Maximum retained latest-revision envelopes. */
  readonly maxEvents?: number;
  /** Maximum UTF-8 bytes across retained envelope JSON. */
  readonly maxBytes?: number;
  /** Maximum stream-frontier records retained for this session. */
  readonly maxStreams?: number;
  /** Arrival lag at or below this session-time delta is `reordered`. */
  readonly reorderWindowUs?: number;
}

export interface AxInteractionTimelineResolvedOptions {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxStreams: number;
  readonly reorderWindowUs: number;
}

export interface AxInteractionTimelineProjectionOptions {
  readonly streamIds?: readonly string[];
  readonly participantIds?: readonly string[];
  readonly kinds?: readonly AxInteractionEvent['kind'][];
  readonly startSessionTimeUs?: number;
  readonly endSessionTimeUs?: number;
  readonly maxEvents?: number;
  /** Exact UTF-8 byte limit for the projected envelope array JSON. */
  readonly maxBytes?: number;
}

export interface AxInteractionTimelineProjection {
  readonly schema: typeof AxInteractionTimelineSchema;
  readonly version: typeof AxInteractionTimelineVersion;
  readonly sessionId: string;
  readonly events: readonly Readonly<AxTemporalEnvelope>[];
  readonly omittedEventCount: number;
  /** Exact UTF-8 bytes of `JSON.stringify(events)`. */
  readonly bytes: number;
}

export interface AxInteractionTimelineStreamState {
  readonly streamId: string;
  readonly epoch: number;
  readonly maxSequence: number;
  readonly maxEventId: string;
  readonly maxSessionTimeUs: number;
}

export interface AxInteractionTimelineSnapshot {
  readonly schema: typeof AxInteractionTimelineSchema;
  readonly version: typeof AxInteractionTimelineVersion;
  readonly sessionId: string;
  readonly options: Readonly<AxInteractionTimelineResolvedOptions>;
  readonly streams: readonly Readonly<AxInteractionTimelineStreamState>[];
  /** Retention order, oldest first. Projection applies temporal ordering. */
  readonly events: readonly Readonly<AxTemporalEnvelope>[];
}

export interface AxInteractionTimelineAppendResult {
  readonly accepted: boolean;
  readonly classification: AxTemporalClassification;
  readonly timeline: AxInteractionTimeline;
  /** Gap observed at this arrival; it is not proof that packets were dropped. */
  readonly sequenceGap: number;
  readonly evictedEventIds: readonly string[];
}

export class AxTemporalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AxTemporalValidationError';
  }
}

const textEncoder = new TextEncoder();
const MAX_ID_LENGTH = 256;
const MAX_LINKS = 64;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_STRING_BYTES_PER_CODE_UNIT = 6;

const jsonBytes = (value: unknown): number =>
  textEncoder.encode(JSON.stringify(value)).byteLength;

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])
    )
  );
};

const fail = (message: string): never => {
  throw new AxTemporalValidationError(message);
};

function assertRecord(
  value: unknown,
  message: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(message);
  }
}

function assertArray(
  value: unknown,
  message: string
): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(message);
}

function assertInteger(
  value: unknown,
  name: string,
  minimum = 0
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

const assertOptionalInteger = (
  value: unknown,
  name: string,
  minimum = 0
): void => {
  if (value !== undefined) assertInteger(value, name, minimum);
};

function assertId(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    fail(
      `${name} must be a non-empty string of at most ${MAX_ID_LENGTH} chars`
    );
  }
}

const assertIdList = (value: unknown, name: string): void => {
  if (value === undefined) return;
  assertArray(value, `${name} must be an array`);
  if (value.length > MAX_LINKS) {
    fail(`${name} must contain at most ${MAX_LINKS} IDs`);
  }
  const ids = new Set<string>();
  for (const item of value) {
    assertId(item, `${name} item`);
    if (ids.has(item)) fail(`${name} must not contain duplicate IDs`);
    ids.add(item);
  }
};

const assertJsonValue = (value: unknown, path = 'value'): void => {
  const ancestors = new WeakSet<object>();
  const pending: Array<
    | Readonly<{ item: unknown; itemPath: string; depth: number }>
    | Readonly<{ completed: object }>
  > = [{ item: value, itemPath: path, depth: 0 }];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if ('completed' in entry) {
      ancestors.delete(entry.completed);
      continue;
    }
    const { item, itemPath, depth } = entry;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean'
    ) {
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        fail(`${itemPath} must contain finite numbers`);
      }
      continue;
    }
    if (Array.isArray(item)) {
      if (depth >= MAX_JSON_DEPTH) {
        fail(`${itemPath} must not exceed ${MAX_JSON_DEPTH} levels`);
      }
      if (ancestors.has(item)) fail(`${itemPath} must not contain cycles`);
      ancestors.add(item);
      pending.push({ completed: item });
      for (let index = item.length - 1; index >= 0; index--) {
        pending.push({
          item: item[index],
          itemPath: `${itemPath}[${index}]`,
          depth: depth + 1,
        });
      }
      continue;
    }
    assertRecord(item, `${itemPath} must contain only plain JSON values`);
    if (depth >= MAX_JSON_DEPTH) {
      fail(`${itemPath} must not exceed ${MAX_JSON_DEPTH} levels`);
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) {
      fail(`${itemPath} must contain only plain JSON values`);
    }
    if (ancestors.has(item)) fail(`${itemPath} must not contain cycles`);
    ancestors.add(item);
    pending.push({ completed: item });
    const entries = Object.entries(item);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      if (child === undefined) fail(`${itemPath}.${key} must not be undefined`);
      pending.push({
        item: child,
        itemPath: `${itemPath}.${key}`,
        depth: depth + 1,
      });
    }
  }
};

const assertRange = (
  value: unknown,
  name: string,
  timebase: 'session' | 'media'
): void => {
  assertRecord(value, `${name} must be an object`);
  if (value.timebase !== timebase) {
    fail(`${name} must use the ${timebase} timebase`);
  }
  assertInteger(value.startUs, `${name}.startUs`);
  assertInteger(value.endUs, `${name}.endUs`);
  if (value.endUs < value.startUs) {
    fail(`${name}.endUs must be greater than or equal to startUs`);
  }
};

const assertOptionalRange = (
  value: unknown,
  name: string,
  timebase: 'session' | 'media'
): void => {
  if (value !== undefined) assertRange(value, name, timebase);
};

const isRfc3339 = (value: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
};

function assertEvent(value: unknown): asserts value is AxInteractionEvent {
  assertRecord(value, 'event must be an interaction event object');
  if (typeof value.kind !== 'string') {
    fail('event must be an interaction event object');
  }
  switch (value.kind) {
    case 'audio_frame':
      assertId(value.mediaId, 'event.mediaId');
      assertRange(value.mediaRange, 'event.mediaRange', 'media');
      assertOptionalRange(
        value.observedRange,
        'event.observedRange',
        'session'
      );
      assertOptionalInteger(value.sampleCount, 'event.sampleCount');
      break;
    case 'transcript':
      if (typeof value.text !== 'string' || typeof value.final !== 'boolean') {
        fail('transcript events require string text and boolean final');
      }
      assertOptionalRange(value.mediaRange, 'event.mediaRange', 'media');
      assertOptionalRange(
        value.observedRange,
        'event.observedRange',
        'session'
      );
      if (
        value.confidence !== undefined &&
        (typeof value.confidence !== 'number' ||
          !Number.isFinite(value.confidence) ||
          value.confidence < 0 ||
          value.confidence > 1)
      ) {
        fail('event.confidence must be between 0 and 1');
      }
      break;
    case 'visual_observation':
      assertId(value.mediaId, 'event.mediaId');
      assertRange(value.observedRange, 'event.observedRange', 'session');
      assertOptionalRange(value.mediaRange, 'event.mediaRange', 'media');
      if (value.mimeType !== undefined && typeof value.mimeType !== 'string') {
        fail('event.mimeType must be a string');
      }
      break;
    case 'text':
      if (typeof value.text !== 'string') fail('text events require text');
      assertOptionalRange(
        value.observedRange,
        'event.observedRange',
        'session'
      );
      break;
    case 'tool_activity':
      assertId(value.toolCallId, 'event.toolCallId');
      if (
        !['requested', 'started', 'completed', 'failed', 'cancelled'].includes(
          String(value.phase)
        )
      ) {
        fail('tool activity events require a supported phase');
      }
      if (value.toolName !== undefined)
        assertId(value.toolName, 'event.toolName');
      assertOptionalRange(
        value.observedRange,
        'event.observedRange',
        'session'
      );
      break;
    case 'generated_media':
      assertId(value.mediaId, 'event.mediaId');
      if (!['audio', 'image', 'video'].includes(String(value.modality))) {
        fail('generated media events require a supported modality');
      }
      assertOptionalRange(value.mediaRange, 'event.mediaRange', 'media');
      assertOptionalRange(
        value.generatedRange,
        'event.generatedRange',
        'session'
      );
      assertOptionalRange(value.playedRange, 'event.playedRange', 'session');
      if (value.mimeType !== undefined && typeof value.mimeType !== 'string') {
        fail('event.mimeType must be a string');
      }
      break;
    case 'control':
      if (
        ![
          'start',
          'stop',
          'interrupt',
          'resume',
          'cancel',
          'end_of_turn',
        ].includes(String(value.signal))
      ) {
        fail('control events require a supported signal');
      }
      assertIdList(value.targetEventIds, 'event.targetEventIds');
      assertOptionalRange(
        value.observedRange,
        'event.observedRange',
        'session'
      );
      break;
    default:
      fail(`unsupported interaction event kind: ${value.kind}`);
  }
}

function assertEnvelope(value: unknown): asserts value is AxTemporalEnvelope {
  assertJsonValue(value, 'envelope');
  assertRecord(value, 'envelope must be an object');
  if (value.schema !== AxTemporalEnvelopeSchema) {
    fail(`envelope.schema must be ${AxTemporalEnvelopeSchema}`);
  }
  if (value.version !== AxInteractionTimelineVersion) {
    fail(`unsupported temporal envelope version: ${String(value.version)}`);
  }
  assertId(value.eventId, 'eventId');
  assertId(value.streamId, 'streamId');
  assertId(value.sessionId, 'sessionId');
  assertId(value.sourceId, 'sourceId');
  if (value.participantId !== undefined) {
    assertId(value.participantId, 'participantId');
  }
  assertInteger(value.epoch, 'epoch');
  assertInteger(value.sequence, 'sequence');
  assertInteger(value.revision, 'revision');
  assertInteger(value.sessionTimeUs, 'sessionTimeUs');
  if (
    value.wallTime !== undefined &&
    (typeof value.wallTime !== 'string' || !isRfc3339(value.wallTime))
  ) {
    fail('wallTime must be an RFC 3339 timestamp with a timezone');
  }
  assertIdList(value.causalParentIds, 'causalParentIds');
  assertIdList(value.linkIds, 'linkIds');
  assertEvent(value.event);
}

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
};

const cloneEnvelope = (
  envelope: Readonly<AxTemporalEnvelope>
): Readonly<AxTemporalEnvelope> =>
  deepFreeze(
    JSON.parse(JSON.stringify(envelope)) as Readonly<AxTemporalEnvelope>
  );

const normalizeOptions = (
  options: Readonly<AxInteractionTimelineOptions>
): Readonly<AxInteractionTimelineResolvedOptions> => {
  assertId(options.sessionId, 'sessionId');
  const normalized = {
    maxEvents: options.maxEvents ?? AxInteractionTimelineDefaults.maxEvents,
    maxBytes: options.maxBytes ?? AxInteractionTimelineDefaults.maxBytes,
    maxStreams: options.maxStreams ?? AxInteractionTimelineDefaults.maxStreams,
    reorderWindowUs:
      options.reorderWindowUs ?? AxInteractionTimelineDefaults.reorderWindowUs,
  };
  assertInteger(normalized.maxEvents, 'maxEvents', 1);
  assertInteger(normalized.maxBytes, 'maxBytes', 2);
  assertInteger(normalized.maxStreams, 'maxStreams', 1);
  assertInteger(normalized.reorderWindowUs, 'reorderWindowUs');
  return Object.freeze(normalized);
};

const mediaRange = (
  event: Readonly<AxInteractionEvent>
): AxMediaTimeRange | undefined => {
  switch (event.kind) {
    case 'audio_frame':
    case 'transcript':
    case 'visual_observation':
    case 'generated_media':
      return event.mediaRange;
    default:
      return undefined;
  }
};

const hasTemporalConflict = (
  envelope: Readonly<AxTemporalEnvelope>,
  events: readonly Readonly<AxTemporalEnvelope>[],
  stream?: Readonly<AxInteractionTimelineStreamState>
): boolean => {
  if (
    stream &&
    envelope.epoch > stream.epoch &&
    envelope.sessionTimeUs < stream.maxSessionTimeUs
  ) {
    return true;
  }
  if (
    stream &&
    envelope.epoch === stream.epoch &&
    envelope.sequence < stream.maxSequence &&
    envelope.sessionTimeUs > stream.maxSessionTimeUs
  ) {
    return true;
  }
  if (
    stream &&
    envelope.epoch === stream.epoch &&
    envelope.sequence > stream.maxSequence &&
    envelope.sessionTimeUs < stream.maxSessionTimeUs
  ) {
    return true;
  }
  const incomingMedia = mediaRange(envelope.event);
  for (const existing of events) {
    if (
      existing.eventId === envelope.eventId ||
      existing.streamId !== envelope.streamId ||
      existing.epoch !== envelope.epoch
    ) {
      continue;
    }
    if (
      (existing.sequence < envelope.sequence &&
        existing.sessionTimeUs > envelope.sessionTimeUs) ||
      (existing.sequence > envelope.sequence &&
        existing.sessionTimeUs < envelope.sessionTimeUs)
    ) {
      return true;
    }
    const existingMedia = mediaRange(existing.event);
    if (
      incomingMedia &&
      existingMedia &&
      ((existing.sequence < envelope.sequence &&
        existingMedia.startUs > incomingMedia.startUs) ||
        (existing.sequence > envelope.sequence &&
          existingMedia.startUs < incomingMedia.startUs))
    ) {
      return true;
    }
  }
  return false;
};

const hasCausalCycle = (
  events: readonly Readonly<AxTemporalEnvelope>[]
): boolean => {
  const parents = new Map(
    events.map((event) => [event.eventId, event.causalParentIds ?? []] as const)
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (eventId: string): boolean => {
    if (visiting.has(eventId)) return true;
    if (visited.has(eventId) || !parents.has(eventId)) return false;
    visiting.add(eventId);
    for (const parentId of parents.get(eventId) ?? []) {
      if (visit(parentId)) return true;
    }
    visiting.delete(eventId);
    visited.add(eventId);
    return false;
  };
  return events.some((event) => visit(event.eventId));
};

const compareId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareTemporal = (
  left: Readonly<AxTemporalEnvelope>,
  right: Readonly<AxTemporalEnvelope>
): number =>
  left.sessionTimeUs - right.sessionTimeUs ||
  compareId(left.streamId, right.streamId) ||
  left.epoch - right.epoch ||
  left.sequence - right.sequence ||
  left.revision - right.revision ||
  compareId(left.eventId, right.eventId);

/**
 * Immutable, bounded timeline for one host-defined session clock. Appending
 * returns a new timeline; the original and accepted envelopes are frozen.
 */
export class AxInteractionTimeline {
  readonly sessionId: string;
  readonly options: Readonly<AxInteractionTimelineResolvedOptions>;
  readonly retainedEventCount: number;
  readonly retainedBytes: number;

  private constructor(
    sessionId: string,
    options: Readonly<AxInteractionTimelineResolvedOptions>,
    private readonly retainedEvents: readonly Readonly<AxTemporalEnvelope>[],
    private readonly streamStates: readonly Readonly<AxInteractionTimelineStreamState>[]
  ) {
    this.sessionId = sessionId;
    this.options = options;
    this.retainedEventCount = retainedEvents.length;
    this.retainedBytes = retainedEvents.reduce(
      (total, event) => total + jsonBytes(event),
      0
    );
    Object.freeze(this);
  }

  static create(
    options: Readonly<AxInteractionTimelineOptions>
  ): AxInteractionTimeline {
    return new AxInteractionTimeline(
      options.sessionId,
      normalizeOptions(options),
      Object.freeze([]),
      Object.freeze([])
    );
  }

  static deserialize(
    serialized: string,
    limits: Readonly<
      Partial<
        Pick<
          AxInteractionTimelineResolvedOptions,
          'maxEvents' | 'maxBytes' | 'maxStreams'
        >
      >
    > = {}
  ): AxInteractionTimeline {
    const maxEvents =
      limits.maxEvents ?? AxInteractionTimelineDefaults.maxEvents;
    const maxBytes = limits.maxBytes ?? AxInteractionTimelineDefaults.maxBytes;
    const maxStreams =
      limits.maxStreams ?? AxInteractionTimelineDefaults.maxStreams;
    assertInteger(maxEvents, 'deserialization maxEvents', 1);
    assertInteger(maxBytes, 'deserialization maxBytes', 2);
    assertInteger(maxStreams, 'deserialization maxStreams', 1);
    const snapshotOverheadBytes =
      maxEvents +
      maxStreams *
        (MAX_ID_LENGTH * MAX_JSON_STRING_BYTES_PER_CODE_UNIT * 2 + 512) +
      MAX_ID_LENGTH * MAX_JSON_STRING_BYTES_PER_CODE_UNIT +
      4_096;
    const serializedBytes = textEncoder.encode(serialized).byteLength;
    if (
      serializedBytes > maxBytes &&
      serializedBytes - maxBytes > snapshotOverheadBytes
    ) {
      fail('serialized timeline exceeds its deserialization byte limit');
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new AxTemporalValidationError(
        `timeline must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    assertRecord(value, 'timeline must be an object');
    if (value.schema !== AxInteractionTimelineSchema) {
      fail(`timeline.schema must be ${AxInteractionTimelineSchema}`);
    }
    if (value.version !== AxInteractionTimelineVersion) {
      fail(
        `unsupported interaction timeline version: ${String(value.version)}`
      );
    }
    assertId(value.sessionId, 'timeline.sessionId');
    assertRecord(value.options, 'timeline.options must be an object');
    const base = AxInteractionTimeline.create({
      sessionId: value.sessionId,
      maxEvents: value.options.maxEvents as number,
      maxBytes: value.options.maxBytes as number,
      maxStreams: value.options.maxStreams as number,
      reorderWindowUs: value.options.reorderWindowUs as number,
    });
    if (base.options.maxEvents > maxEvents) {
      fail('timeline options exceed the deserialization event limit');
    }
    if (base.options.maxBytes > maxBytes) {
      fail('timeline options exceed the deserialization byte limit');
    }
    if (base.options.maxStreams > maxStreams) {
      fail('timeline options exceed the deserialization stream limit');
    }
    assertArray(value.events, 'timeline events must be an array');
    assertArray(value.streams, 'timeline streams must be an array');
    if (value.events.length > base.options.maxEvents) {
      fail('timeline exceeds its retained event limit');
    }
    if (value.streams.length > base.options.maxStreams) {
      fail('timeline exceeds its stream limit');
    }
    const eventIds = new Set<string>();
    const streamPositions = new Set<string>();
    let retainedBytes = 0;
    const events = value.events.map((event, index) => {
      assertEnvelope(event);
      retainedBytes += jsonBytes(event);
      if (retainedBytes > base.options.maxBytes) {
        fail('timeline exceeds its retained byte limit');
      }
      if (event.sessionId !== base.sessionId) {
        fail(`timeline.events[${index}] belongs to a different session`);
      }
      if (eventIds.has(event.eventId)) {
        fail('timeline must retain only the latest revision of an event');
      }
      eventIds.add(event.eventId);
      const streamPosition = JSON.stringify([
        event.streamId,
        event.epoch,
        event.sequence,
      ]);
      if (streamPositions.has(streamPosition)) {
        fail('timeline event stream positions must be unique');
      }
      streamPositions.add(streamPosition);
      return cloneEnvelope(event);
    });
    const eventsByStream = new Map<string, Readonly<AxTemporalEnvelope>[]>();
    for (const event of events) {
      const streamEvents = eventsByStream.get(event.streamId) ?? [];
      streamEvents.push(event);
      eventsByStream.set(event.streamId, streamEvents);
    }
    for (const streamEvents of eventsByStream.values()) {
      streamEvents.sort(
        (left, right) =>
          left.epoch - right.epoch || left.sequence - right.sequence
      );
      let maxSessionTimeUs = -1;
      let mediaEpoch = -1;
      let maxMediaStartUs = -1;
      for (const event of streamEvents) {
        if (event.sessionTimeUs < maxSessionTimeUs) {
          fail('timeline contains a temporal conflict');
        }
        maxSessionTimeUs = event.sessionTimeUs;
        if (event.epoch !== mediaEpoch) {
          mediaEpoch = event.epoch;
          maxMediaStartUs = -1;
        }
        const range = mediaRange(event.event);
        if (range && range.startUs < maxMediaStartUs) {
          fail('timeline contains a temporal conflict');
        }
        if (range) maxMediaStartUs = range.startUs;
      }
    }
    if (hasCausalCycle(events)) fail('timeline contains a causal cycle');
    const streamIds = new Set<string>();
    const streamsById = new Map<
      string,
      Readonly<AxInteractionTimelineStreamState>
    >();
    const streams = value.streams.map((stream, index) => {
      assertRecord(stream, `timeline.streams[${index}] must be an object`);
      assertId(stream.streamId, `timeline.streams[${index}].streamId`);
      assertInteger(stream.epoch, `timeline.streams[${index}].epoch`);
      assertInteger(
        stream.maxSequence,
        `timeline.streams[${index}].maxSequence`
      );
      assertId(stream.maxEventId, `timeline.streams[${index}].maxEventId`);
      assertInteger(
        stream.maxSessionTimeUs,
        `timeline.streams[${index}].maxSessionTimeUs`
      );
      if (streamIds.has(stream.streamId))
        fail('timeline stream IDs must be unique');
      streamIds.add(stream.streamId);
      const normalized = Object.freeze({
        streamId: stream.streamId,
        epoch: stream.epoch,
        maxSequence: stream.maxSequence,
        maxEventId: stream.maxEventId,
        maxSessionTimeUs: stream.maxSessionTimeUs,
      });
      streamsById.set(normalized.streamId, normalized);
      return normalized;
    });
    for (const event of events) {
      const stream =
        streamsById.get(event.streamId) ??
        fail(`timeline stream frontier does not cover event ${event.eventId}`);
      if (
        event.epoch > stream.epoch ||
        event.sessionTimeUs > stream.maxSessionTimeUs ||
        (event.epoch === stream.epoch && event.sequence > stream.maxSequence)
      ) {
        fail(`timeline stream frontier does not cover event ${event.eventId}`);
      }
      if (
        event.epoch === stream.epoch &&
        event.sequence === stream.maxSequence &&
        (event.eventId !== stream.maxEventId ||
          event.sessionTimeUs !== stream.maxSessionTimeUs)
      ) {
        fail(`timeline stream frontier conflicts with event ${event.eventId}`);
      }
    }
    return new AxInteractionTimeline(
      base.sessionId,
      base.options,
      Object.freeze(events),
      Object.freeze(streams)
    );
  }

  append(
    candidate: Readonly<AxTemporalEnvelope>
  ): AxInteractionTimelineAppendResult {
    assertEnvelope(candidate);
    const reject = (
      classification: AxTemporalClassification
    ): AxInteractionTimelineAppendResult =>
      Object.freeze({
        accepted: false,
        classification,
        timeline: this,
        sequenceGap: 0,
        evictedEventIds: Object.freeze([]),
      });
    if (candidate.sessionId !== this.sessionId) {
      return reject('identity_conflict');
    }
    const eventBytes = jsonBytes(candidate);
    if (eventBytes > this.options.maxBytes) return reject('oversize');

    const current = this.retainedEvents.find(
      (event) => event.eventId === candidate.eventId
    );
    if (current?.revision === candidate.revision) {
      return reject(
        jsonEqual(current, candidate) ? 'duplicate' : 'identity_conflict'
      );
    }
    if (current && current.revision > candidate.revision) {
      return reject('stale_revision');
    }
    if (
      current &&
      (current.sessionId !== candidate.sessionId ||
        current.streamId !== candidate.streamId ||
        current.sourceId !== candidate.sourceId ||
        current.participantId !== candidate.participantId ||
        current.epoch !== candidate.epoch ||
        current.sequence !== candidate.sequence ||
        current.sessionTimeUs !== candidate.sessionTimeUs)
    ) {
      return reject('identity_conflict');
    }

    const stream = this.streamStates.find(
      (state) => state.streamId === candidate.streamId
    );
    if (!stream && this.streamStates.length >= this.options.maxStreams) {
      return reject('stream_limit');
    }
    if (stream && candidate.epoch < stream.epoch) {
      return reject('stale_epoch');
    }
    if (
      !current &&
      stream &&
      candidate.epoch === stream.epoch &&
      candidate.sequence === stream.maxSequence
    ) {
      return reject('sequence_conflict');
    }
    const samePosition = this.retainedEvents.find(
      (event) =>
        event.eventId !== candidate.eventId &&
        event.streamId === candidate.streamId &&
        event.epoch === candidate.epoch &&
        event.sequence === candidate.sequence
    );
    if (samePosition) return reject('sequence_conflict');

    const withoutCurrent = current
      ? this.retainedEvents.filter((event) => event.eventId !== current.eventId)
      : [...this.retainedEvents];
    if (hasTemporalConflict(candidate, withoutCurrent, stream)) {
      return reject('temporal_conflict');
    }
    const envelope = cloneEnvelope(candidate);
    if (hasCausalCycle([...withoutCurrent, envelope])) {
      return reject('causal_cycle');
    }

    let classification: AxTemporalClassification;
    let sequenceGap = 0;
    if (current) {
      classification = 'revision';
    } else if (!stream) {
      classification = 'in_order';
      sequenceGap = candidate.sequence;
    } else if (candidate.epoch > stream.epoch) {
      classification = 'new_epoch';
      sequenceGap = candidate.sequence;
    } else if (candidate.sequence > stream.maxSequence) {
      classification = 'in_order';
      sequenceGap = candidate.sequence - stream.maxSequence - 1;
    } else {
      classification =
        stream.maxSessionTimeUs - candidate.sessionTimeUs <=
        this.options.reorderWindowUs
          ? 'reordered'
          : 'late';
    }

    const retained = current
      ? this.retainedEvents.map((event) =>
          event.eventId === current.eventId ? envelope : event
        )
      : [...this.retainedEvents, envelope];
    const evictedEventIds: string[] = [];
    let retainedBytes = retained.reduce(
      (total, event) => total + jsonBytes(event),
      0
    );
    while (
      retained.length > this.options.maxEvents ||
      retainedBytes > this.options.maxBytes
    ) {
      const evictIndex = retained.findIndex(
        (event) => event.eventId !== envelope.eventId
      );
      if (evictIndex < 0) break;
      const [evicted] = retained.splice(evictIndex, 1);
      if (!evicted) break;
      retainedBytes -= jsonBytes(evicted);
      evictedEventIds.push(evicted.eventId);
    }

    const streams = [...this.streamStates];
    if (!stream) {
      streams.push(
        Object.freeze({
          streamId: candidate.streamId,
          epoch: candidate.epoch,
          maxSequence: candidate.sequence,
          maxEventId: candidate.eventId,
          maxSessionTimeUs: candidate.sessionTimeUs,
        })
      );
    } else if (
      candidate.epoch > stream.epoch ||
      (candidate.epoch === stream.epoch &&
        candidate.sequence > stream.maxSequence)
    ) {
      const next = Object.freeze({
        streamId: candidate.streamId,
        epoch: candidate.epoch,
        maxSequence: candidate.sequence,
        maxEventId: candidate.eventId,
        maxSessionTimeUs: candidate.sessionTimeUs,
      });
      streams[streams.indexOf(stream)] = next;
    }
    const timeline = new AxInteractionTimeline(
      this.sessionId,
      this.options,
      Object.freeze(retained),
      Object.freeze(streams)
    );
    return Object.freeze({
      accepted: true,
      classification,
      timeline,
      sequenceGap,
      evictedEventIds: Object.freeze(evictedEventIds),
    });
  }

  project(
    options: Readonly<AxInteractionTimelineProjectionOptions> = {}
  ): AxInteractionTimelineProjection {
    assertOptionalInteger(options.startSessionTimeUs, 'startSessionTimeUs');
    assertOptionalInteger(options.endSessionTimeUs, 'endSessionTimeUs');
    if (
      options.startSessionTimeUs !== undefined &&
      options.endSessionTimeUs !== undefined &&
      options.endSessionTimeUs < options.startSessionTimeUs
    ) {
      fail(
        'endSessionTimeUs must be greater than or equal to startSessionTimeUs'
      );
    }
    const maxEvents = options.maxEvents ?? this.options.maxEvents;
    const maxBytes = options.maxBytes ?? this.options.maxBytes;
    assertInteger(maxEvents, 'projection maxEvents', 1);
    assertInteger(maxBytes, 'projection maxBytes', 2);
    const streamIds = options.streamIds && new Set(options.streamIds);
    const participantIds =
      options.participantIds && new Set(options.participantIds);
    const kinds = options.kinds && new Set(options.kinds);
    const filtered = this.retainedEvents
      .filter(
        (event) =>
          (!streamIds || streamIds.has(event.streamId)) &&
          (!participantIds ||
            (event.participantId !== undefined &&
              participantIds.has(event.participantId))) &&
          (!kinds || kinds.has(event.event.kind)) &&
          (options.startSessionTimeUs === undefined ||
            event.sessionTimeUs >= options.startSessionTimeUs) &&
          (options.endSessionTimeUs === undefined ||
            event.sessionTimeUs < options.endSessionTimeUs)
      )
      .sort(compareTemporal);
    const selected: Readonly<AxTemporalEnvelope>[] = [];
    let selectedBytes = 2;
    for (const event of filtered) {
      if (selected.length >= maxEvents) break;
      const candidateBytes =
        selectedBytes + jsonBytes(event) + (selected.length === 0 ? 0 : 1);
      if (candidateBytes > maxBytes) break;
      selected.push(event);
      selectedBytes = candidateBytes;
    }
    const events = Object.freeze(selected);
    return Object.freeze({
      schema: AxInteractionTimelineSchema,
      version: AxInteractionTimelineVersion,
      sessionId: this.sessionId,
      events,
      omittedEventCount: filtered.length - events.length,
      bytes: selectedBytes,
    });
  }

  toJSON(): AxInteractionTimelineSnapshot {
    return deepFreeze({
      schema: AxInteractionTimelineSchema,
      version: AxInteractionTimelineVersion,
      sessionId: this.sessionId,
      options: { ...this.options },
      streams: this.streamStates.map((stream) => ({ ...stream })),
      events: [...this.retainedEvents],
    });
  }

  serialize(): string {
    return JSON.stringify(this.toJSON());
  }
}
