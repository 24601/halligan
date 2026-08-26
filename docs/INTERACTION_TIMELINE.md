# Temporal Interaction Timeline

`AxInteractionTimeline` is an opt-in, provider-neutral TypeScript record for
temporally projecting crossmodal interaction observations. It accepts immutable
`AxTemporalEnvelope` values for:

- audio frames and transcripts;
- visual observations and text;
- tool activity and generated media; and
- control signals such as interruption, resume, and end of turn.

The timeline classifies arrivals, keeps bounded latest revisions, projects them
in a deterministic temporal order, and serializes a versioned snapshot. It is
browser-compatible and uses web-standard `TextEncoder` for byte accounting.

This is not a capture API, media store, renderer, room or world model, event
queue, authentication provider, or product policy. Appending an envelope does
not call a provider or wake an Ax program. Use `AxEventRuntime` separately when
an explicitly authorized route should invoke a program.

## Clocks And Ranges

Every numeric time is a non-negative safe integer in microseconds.

- `sessionTimeUs` is assigned by the host from one monotonic clock authority
  for the session. It is the primary temporal projection key across streams.
- A range whose `timebase` is `session` uses that same session clock.
- A range whose `timebase` is `media` uses the media clock owned by its
  `streamId`. `mediaId` identifies an opaque referenced media object when the
  event kind has one.
- Ranges are half-open, `[startUs, endUs)`. Equal endpoints are allowed for a
  point or empty-duration observation.
- `wallTime` is optional RFC 3339 diagnostic context. It is never used for
  ordering, lateness, retention, or causal validation.

The host owns clock selection, monotonicity, and any mapping from device or
provider clocks into session time. The timeline does not estimate clock offset,
network delay, capture latency, or drift. Two events with similar timestamps
are temporally near according to the supplied clock; that fact alone does not
show that their contents are semantically aligned or synchronized in the real
world.

Observed, generated, and played ranges describe different facts. For example,
a generated audio event can record when bytes were generated separately from
when the host reports playback. The timeline does not infer one range from
another.

## Identity, Restarts, And References

Applications assign stable, opaque `sessionId`, `streamId`, `eventId`, and
`sourceId` values. `participantId` is optional and opaque. These values carry
attribution only; they are not credentials and are not proof of authentication.

Within a stream:

- `sequence` orders events in an `epoch`;
- an increased `epoch` declares a stream restart;
- `revision` replaces the retained content for one stable event position; and
- `sequenceGap` reports positions not yet observed at that arrival.

The stable revision identity is `eventId`, `sessionId`, `streamId`, `sourceId`,
`participantId`, `epoch`, `sequence`, and `sessionTimeUs`. A revision may change
the event payload, optional wall time, causal parents, or links, but not those
identity fields. Only the latest accepted revision is retained.

A sequence gap is not proof of permanent loss: a missing position may arrive
later. Conversely, retention can evict an old envelope, so the absence of an
old event from a projection is not proof it never arrived.

- `causalParentIds` declares directed causal edges. Forward references are
  allowed; an arrival that closes a cycle among retained envelopes is rejected.
- `linkIds` and control-event `targetEventIds` are references only. They do not
  establish causality or semantic alignment.

## Deterministic Classification

Malformed envelopes throw `AxTemporalValidationError`. Valid envelopes are
then evaluated in this fail-closed priority order:

1. session identity and per-envelope byte bound;
2. exact duplicate, stale revision, or conflicting stable event identity;
3. new-stream capacity and stale epoch;
4. duplicate stream position;
5. session/media temporal consistency against retained evidence and the stream
   frontier; and
6. causal cycle.

An accepted envelope is then classified as:

- `revision` for a newer revision at the same stable position;
- `new_epoch` for a valid restart;
- `in_order` for a new stream or a sequence beyond its frontier;
- `reordered` for an earlier sequence within `reorderWindowUs` of the stream's
  session-time frontier; or
- `late` for an earlier sequence outside that window.

Rejected classifications are `duplicate`, `stale_epoch`, `stale_revision`,
`identity_conflict`, `sequence_conflict`, `temporal_conflict`, `causal_cycle`,
`stream_limit`, and `oversize`. An exact duplicate requires structurally equal
JSON at the same `eventId` and revision; changed content at that identity is an
`identity_conflict`.

Classification uses stream sequence and the host-supplied monotonic session and
media times. Arrival order and wall time never become projection authority.

## Bounds And Projection

Defaults are deliberately finite:

| Option | Default | Meaning |
|---|---:|---|
| `maxEvents` | 1,024 | Latest-revision envelopes retained |
| `maxBytes` | 1,048,576 | Sum of UTF-8 bytes for each retained envelope's JSON |
| `maxStreams` | 128 | Stream frontiers retained for the session |
| `reorderWindowUs` | 250,000 | Maximum frontier lag classified as `reordered` |

`append()` returns a new frozen timeline and leaves the previous timeline
unchanged. Retention evicts the oldest retained positions other than the
envelope accepted by that append until both event and byte bounds hold. Stream
frontiers survive envelope eviction and count against `maxStreams` for the
lifetime of the timeline.

`project()` can filter by stream, participant, event kind, and the half-open
session interval `[startSessionTimeUs, endSessionTimeUs)`. It sorts by
`sessionTimeUs`, then stable stream/epoch/sequence/revision/event-ID tie-breaks.
Its `maxBytes` is the exact UTF-8 size of `JSON.stringify(events)`, including
array punctuation. Projection stops before the first envelope that would exceed
the event or byte bound and reports `omittedEventCount`.

Retention and projection byte budgets have different definitions. Retention
counts the sum of individual envelope JSON sizes. Projection counts the entire
JSON array. A serialized snapshot also includes schema, options, and stream
frontiers.

`deserialize()` treats its optional second argument as the host's authority for
maximum events, retained bytes, and streams. Those limits default to the finite
timeline defaults above; snapshot-declared options cannot raise them. Pass
larger limits explicitly when restoring a timeline intentionally configured
above the defaults. The host limits also bound serialized input before parsing,
and retained-envelope bytes are accumulated before cloning or processing later
entries.

## Example

```ts
import {
  AxInteractionTimeline,
  AxInteractionTimelineVersion,
  AxTemporalEnvelopeSchema,
} from '@ax-llm/ax';

let timeline = AxInteractionTimeline.create({
  sessionId: 'session-1',
  maxEvents: 128,
  maxBytes: 128 * 1024,
});

const result = timeline.append({
  schema: AxTemporalEnvelopeSchema,
  version: AxInteractionTimelineVersion,
  eventId: 'audio-0',
  streamId: 'audio',
  sessionId: 'session-1',
  sourceId: 'capture-a',
  participantId: 'participant-a',
  epoch: 0,
  sequence: 0,
  revision: 0,
  sessionTimeUs: 10_000,
  event: {
    kind: 'audio_frame',
    mediaId: 'frame-0',
    mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
  },
});

if (result.accepted) timeline = result.timeline;
const context = timeline.project({ maxEvents: 32, maxBytes: 16 * 1024 });
```

Run the complete credential-free example from the repository root:

```bash
node --import=tsx src/examples/interaction-timeline.ts
```

The repository's `npm run tsx` wrapper is also suitable when a local `.env`
file exists.

## Deterministic Evaluation

Run the zero-cost conformance evaluation and its relational gate:

```bash
npm run eval:interaction-timeline
npx vitest run scripts/evaluate-interaction-timeline.test.ts
```

The `ax-interaction-timeline-evaluation-v1` fixture uses an
`AxManualEventClock` for a deterministic five-millisecond arrival schedule, 18
synthetic arrivals, and a separately declared 13-event expected temporal order.
The fixture envelope fields, not the arrival clock, supply session and media
time. It includes reordered and duplicated input, temporarily and permanently
missing sequence positions, wall-time skew, stream restart, stale epoch and
revision, crossmodal references, generated media, and a causal cycle.

The declared naive baseline accepts every arrival, labels every input
`in_order`, and preserves first-arrival order. Classification fidelity is the
fraction of 18 expected labels matched exactly. Alignment fidelity is the
fraction of the 78 ordered event pairs from the declared 13-event temporal
order that appear in the same order. Missing expected IDs count against every
affected pair. False acceptance and rejection compare each mechanism's
accept/reject decision with the declared fixture decision.

Current deterministic result:

| Measure | Timeline | Naive arrival order |
|---|---:|---:|
| Classification fidelity | 1.0000 (18/18) | 0.5556 (10/18) |
| Pairwise temporal-order fidelity | 1.0000 (78/78) | 0.8205 (64/78) |
| False acceptances | 0 | 4 |
| False rejections | 0 | 0 |

The final timeline retains 13 envelopes. Its full projected envelope array is
5,269 bytes. A projection bounded to six events and 4,096 bytes returns six
events, 2,453 bytes, and seven omissions. The serialized snapshot is 6,147
bytes, or 878 bytes more than the full projected array for schema, options, and
stream-frontier metadata. The naive baseline's array of all 18 arrivals is
7,310 bytes; it is not directly equivalent because it includes duplicates and
rejected inputs.

These expected classifications and ordering are fixture assertions, not
independently observed ground truth. The numbers characterize this fixed
synthetic protocol fixture, not runtime latency, model quality, clock accuracy,
semantic alignment, or real-world synchronization.

## Limits, Privacy, And Cardinality

- Duplicate identity and causal-cycle memory is limited to retained envelopes.
  Stream epoch/sequence/session-time frontiers survive eviction, but an evicted
  event body or causal edge cannot be reconstructed.
- Media-time consistency beyond retained evidence is not represented in stream
  frontiers.
- Forward causal references can remain unresolved. The timeline rejects cycles;
  it does not require every parent or link to be present.
- Reordering tolerance is a classification threshold, not a jitter buffer and
  not a latency promise.
- Text and transcripts can contain sensitive content. `sourceId`,
  `participantId`, tool names, MIME types, and link graphs can also reveal
  metadata. Apply minimization and access controls before persistence or model
  projection.
- Keep IDs opaque and bounded. Do not put credentials or unnecessary personal
  data in IDs, and do not create unbounded per-frame stream or participant IDs.
- Serialization is versioned JSON, not encrypted storage or authentication.
  The host owns transport integrity, persistence, authorization, and deletion.

The timeline helps applications preserve declared temporal evidence and build
bounded context without depending on provider-specific message types. It does
not decide which evidence a model should receive, whether an interruption is
allowed, who may join an interaction, or whether two modalities mean the same
thing.
