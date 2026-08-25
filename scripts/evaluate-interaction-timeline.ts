import { pathToFileURL } from 'node:url';

import {
  AxInteractionTimeline,
  AxInteractionTimelineVersion,
  AxManualEventClock,
  type AxTemporalClassification,
  type AxTemporalEnvelope,
  AxTemporalEnvelopeSchema,
} from '../src/ax/index.js';

type Fixture = Readonly<{
  name: string;
  expected: AxTemporalClassification;
  envelope: Readonly<AxTemporalEnvelope>;
}>;

const acceptedClassifications = new Set<AxTemporalClassification>([
  'in_order',
  'new_epoch',
  'revision',
  'reordered',
  'late',
]);

const temporal = (
  overrides: Partial<AxTemporalEnvelope> = {}
): AxTemporalEnvelope => ({
  schema: AxTemporalEnvelopeSchema,
  version: AxInteractionTimelineVersion,
  eventId: 'audio-0',
  streamId: 'audio',
  sessionId: 'synthetic-session',
  sourceId: 'synthetic-source',
  participantId: 'participant-a',
  epoch: 0,
  sequence: 0,
  revision: 0,
  sessionTimeUs: 0,
  wallTime: '2026-01-01T00:00:00Z',
  event: {
    kind: 'audio_frame',
    mediaId: 'audio-frame-0',
    mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
    observedRange: { timebase: 'session', startUs: 0, endUs: 20_000 },
  },
  ...overrides,
});

const fixtures = (): readonly Fixture[] => [
  { name: 'audio-start', expected: 'in_order', envelope: temporal() },
  {
    name: 'visual-observation',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'visual-0',
      streamId: 'visual',
      sessionTimeUs: 15_000,
      participantId: 'participant-b',
      event: {
        kind: 'visual_observation',
        mediaId: 'image-0',
        observedRange: {
          timebase: 'session',
          startUs: 15_000,
          endUs: 16_000,
        },
        mimeType: 'image/png',
      },
    }),
  },
  { name: 'duplicate-audio', expected: 'duplicate', envelope: temporal() },
  {
    name: 'audio-gap',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'audio-2',
      sequence: 2,
      sessionTimeUs: 40_000,
      event: {
        kind: 'audio_frame',
        mediaId: 'audio-frame-2',
        mediaRange: {
          timebase: 'media',
          startUs: 40_000,
          endUs: 60_000,
        },
      },
    }),
  },
  {
    name: 'visual-gap',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'visual-2',
      streamId: 'visual',
      sequence: 2,
      sessionTimeUs: 70_000,
      participantId: 'participant-b',
      event: {
        kind: 'visual_observation',
        mediaId: 'image-2',
        observedRange: {
          timebase: 'session',
          startUs: 70_000,
          endUs: 71_000,
        },
      },
    }),
  },
  {
    name: 'late-visual',
    expected: 'late',
    envelope: temporal({
      eventId: 'visual-1',
      streamId: 'visual',
      sequence: 1,
      sessionTimeUs: 20_000,
      participantId: 'participant-b',
      event: {
        kind: 'visual_observation',
        mediaId: 'image-1',
        observedRange: {
          timebase: 'session',
          startUs: 20_000,
          endUs: 21_000,
        },
      },
    }),
  },
  {
    name: 'audio-second-gap',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'audio-4',
      sequence: 4,
      sessionTimeUs: 80_000,
      event: {
        kind: 'audio_frame',
        mediaId: 'audio-frame-4',
        mediaRange: {
          timebase: 'media',
          startUs: 80_000,
          endUs: 100_000,
        },
      },
    }),
  },
  {
    name: 'reordered-audio',
    expected: 'reordered',
    envelope: temporal({
      eventId: 'audio-3',
      sequence: 3,
      sessionTimeUs: 75_000,
      event: {
        kind: 'audio_frame',
        mediaId: 'audio-frame-3',
        mediaRange: {
          timebase: 'media',
          startUs: 60_000,
          endUs: 80_000,
        },
      },
    }),
  },
  {
    name: 'skewed-transcript',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'transcript-0',
      streamId: 'transcript',
      sessionTimeUs: 25_000,
      wallTime: '2025-12-31T23:59:55Z',
      event: {
        kind: 'transcript',
        text: 'synthetic transcript',
        final: false,
        mediaRange: { timebase: 'media', startUs: 0, endUs: 40_000 },
      },
    }),
  },
  {
    name: 'crossmodal-link',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'text-0',
      streamId: 'text',
      sessionTimeUs: 30_000,
      linkIds: ['visual-0'],
      event: { kind: 'text', text: 'Reference the observed image.' },
    }),
  },
  {
    name: 'tool-after-dropped-predecessors',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'tool-0',
      streamId: 'tool',
      sequence: 2,
      sessionTimeUs: 50_000,
      event: {
        kind: 'tool_activity',
        toolCallId: 'tool-call-0',
        toolName: 'synthetic_lookup',
        phase: 'completed',
      },
    }),
  },
  {
    name: 'generated-media',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'generated-0',
      streamId: 'generated',
      sessionTimeUs: 90_000,
      causalParentIds: ['text-0'],
      event: {
        kind: 'generated_media',
        mediaId: 'generated-audio-0',
        modality: 'audio',
        generatedRange: {
          timebase: 'session',
          startUs: 85_000,
          endUs: 90_000,
        },
        playedRange: {
          timebase: 'session',
          startUs: 90_000,
          endUs: 110_000,
        },
      },
    }),
  },
  {
    name: 'stream-restart',
    expected: 'new_epoch',
    envelope: temporal({
      eventId: 'audio-restart',
      epoch: 1,
      sequence: 0,
      sessionTimeUs: 100_000,
      event: {
        kind: 'control',
        signal: 'start',
        targetEventIds: ['audio-4'],
      },
    }),
  },
  {
    name: 'stale-epoch',
    expected: 'stale_epoch',
    envelope: temporal({
      eventId: 'audio-stale',
      epoch: 0,
      sequence: 5,
      sessionTimeUs: 110_000,
    }),
  },
  {
    name: 'forward-causal-reference',
    expected: 'in_order',
    envelope: temporal({
      eventId: 'causal-a',
      streamId: 'control',
      sequence: 0,
      sessionTimeUs: 120_000,
      causalParentIds: ['causal-b'],
      event: { kind: 'control', signal: 'start' },
    }),
  },
  {
    name: 'causal-cycle',
    expected: 'causal_cycle',
    envelope: temporal({
      eventId: 'causal-b',
      streamId: 'control',
      sequence: 1,
      sessionTimeUs: 130_000,
      causalParentIds: ['causal-a'],
      event: { kind: 'control', signal: 'stop' },
    }),
  },
  {
    name: 'transcript-revision',
    expected: 'revision',
    envelope: temporal({
      eventId: 'transcript-0',
      streamId: 'transcript',
      revision: 1,
      sessionTimeUs: 25_000,
      wallTime: '2025-12-31T23:59:55Z',
      event: {
        kind: 'transcript',
        text: 'synthetic transcript.',
        final: true,
        mediaRange: { timebase: 'media', startUs: 0, endUs: 40_000 },
      },
    }),
  },
  {
    name: 'stale-transcript-revision',
    expected: 'stale_revision',
    envelope: temporal({
      eventId: 'transcript-0',
      streamId: 'transcript',
      revision: 0,
      sessionTimeUs: 25_000,
      event: {
        kind: 'transcript',
        text: 'synthetic transcript',
        final: false,
      },
    }),
  },
];

const expectedTemporalOrder = Object.freeze([
  'audio-0',
  'visual-0',
  'visual-1',
  'transcript-0',
  'text-0',
  'audio-2',
  'tool-0',
  'visual-2',
  'audio-3',
  'audio-4',
  'generated-0',
  'audio-restart',
  'causal-a',
]);

const pairwiseTemporalOrderFidelity = (
  canonical: readonly string[],
  candidate: readonly string[]
): number => {
  const positions = new Map(candidate.map((id, index) => [id, index]));
  let correct = 0;
  let total = 0;
  for (let left = 0; left < canonical.length; left++) {
    for (let right = left + 1; right < canonical.length; right++) {
      total++;
      const leftPosition = positions.get(canonical[left]!);
      const rightPosition = positions.get(canonical[right]!);
      if (
        leftPosition !== undefined &&
        rightPosition !== undefined &&
        leftPosition < rightPosition
      ) {
        correct++;
      }
    }
  }
  return total === 0 ? 1 : correct / total;
};

export const runInteractionTimelineEvaluation = () => {
  const cases = fixtures();
  const clock = new AxManualEventClock(0);
  let timeline = AxInteractionTimeline.create({
    sessionId: 'synthetic-session',
    reorderWindowUs: 10_000,
    maxEvents: 64,
    maxBytes: 64 * 1_024,
    maxStreams: 16,
  });
  const classifications: AxTemporalClassification[] = [];
  const accepted: boolean[] = [];
  const sequenceGaps: number[] = [];
  const arrivalTimesMs: number[] = [];
  for (const fixture of cases) {
    clock.advanceBy(5);
    arrivalTimesMs.push(clock.now());
    const result = timeline.append(fixture.envelope);
    classifications.push(result.classification);
    accepted.push(result.accepted);
    sequenceGaps.push(result.sequenceGap);
    timeline = result.timeline;
  }

  const expectedAccepted = cases.map((fixture) =>
    acceptedClassifications.has(fixture.expected)
  );
  const expectedClassifications = cases.map((fixture) => fixture.expected);
  const timelineCorrect = classifications.filter(
    (classification, index) => classification === expectedClassifications[index]
  ).length;
  const baselineClassifications = cases.map(
    () => 'in_order' as AxTemporalClassification
  );
  const baselineAccepted = cases.map(() => true);
  const baselineCorrect = baselineClassifications.filter(
    (classification, index) => classification === expectedClassifications[index]
  ).length;
  const errorCounts = (actual: readonly boolean[]) => ({
    falseAcceptance: actual.filter(
      (value, index) => value && !expectedAccepted[index]
    ).length,
    falseRejection: actual.filter(
      (value, index) => !value && expectedAccepted[index]
    ).length,
  });

  const projection = timeline.project();
  const timelineOrder = projection.events.map((event) => event.eventId);
  const baselineOrder = cases
    .map((fixture) => fixture.envelope.eventId)
    .filter((eventId, index, values) => values.indexOf(eventId) === index)
    .filter((eventId) => expectedTemporalOrder.includes(eventId));
  const boundedProjection = timeline.project({ maxEvents: 6, maxBytes: 4_096 });
  const serializedBytes = new TextEncoder().encode(
    timeline.serialize()
  ).byteLength;
  const baselineBytes = new TextEncoder().encode(
    JSON.stringify(cases.map((fixture) => fixture.envelope))
  ).byteLength;
  const timelineErrors = errorCounts(accepted);
  const baselineErrors = errorCounts(baselineAccepted);

  return Object.freeze({
    protocol: 'ax-interaction-timeline-evaluation-v1',
    baseline: Object.freeze({
      name: 'naive_arrival_order',
      rule: 'accept every arrival, label every input in_order, and preserve first-arrival order',
    }),
    budget: Object.freeze({
      providerCalls: 0,
      providerTokens: 0,
      costUSD: 0,
      manualClockFinalMs: clock.now(),
      inputs: cases.length,
    }),
    timeline: Object.freeze({
      classificationFidelity: timelineCorrect / cases.length,
      pairwiseTemporalOrderFidelity: pairwiseTemporalOrderFidelity(
        expectedTemporalOrder,
        timelineOrder
      ),
      ...timelineErrors,
      observedSequenceGaps: sequenceGaps.reduce((sum, gap) => sum + gap, 0),
      retainedEvents: timeline.retainedEventCount,
    }),
    naiveArrivalOrder: Object.freeze({
      classificationFidelity: baselineCorrect / cases.length,
      pairwiseTemporalOrderFidelity: pairwiseTemporalOrderFidelity(
        expectedTemporalOrder,
        baselineOrder
      ),
      ...baselineErrors,
      observedSequenceGaps: 0,
      acceptedInputs: cases.length,
    }),
    projection: Object.freeze({
      fullEvents: projection.events.length,
      fullBytes: projection.bytes,
      boundedEvents: boundedProjection.events.length,
      boundedBytes: boundedProjection.bytes,
      boundedOmittedEvents: boundedProjection.omittedEventCount,
      serializedBytes,
      serializationMetadataOverheadBytes: serializedBytes - projection.bytes,
      naiveArrivalBytes: baselineBytes,
    }),
    checks: Object.freeze({
      classifications: Object.freeze(
        cases.map((fixture, index) =>
          Object.freeze({
            name: fixture.name,
            expected: fixture.expected,
            actual: classifications[index]!,
          })
        )
      ),
      arrivalTimesMs: Object.freeze(arrivalTimesMs),
      crossmodalLinkPreserved:
        projection.events.find((event) => event.eventId === 'text-0')
          ?.linkIds?.[0] === 'visual-0',
      causalCycleRejected:
        classifications[
          cases.findIndex((item) => item.name === 'causal-cycle')
        ] === 'causal_cycle',
      droppedPredecessorGapDetected:
        sequenceGaps[
          cases.findIndex(
            (item) => item.name === 'tool-after-dropped-predecessors'
          )
        ] === 2,
      temporalProjectionMatchesExpected:
        JSON.stringify(timelineOrder) === JSON.stringify(expectedTemporalOrder),
      boundedProjectionWithinLimits:
        boundedProjection.events.length <= 6 &&
        boundedProjection.bytes <= 4_096,
    }),
    limitations: Object.freeze([
      'Session and media timestamps are supplied by the host clock authority; this evaluation does not estimate clock offset or drift.',
      'Temporal ordering and link preservation do not demonstrate semantic alignment or real-world synchronization.',
      'Expected classifications and temporal order are synthetic fixture assertions, not independently observed ground truth.',
      'A sequence gap is evidence of a missing arrival at that point, not proof of permanent packet loss.',
      'Duplicate and causal-cycle detection are limited to retained envelopes; stream epoch and sequence frontiers outlive envelope eviction.',
      'Byte overhead is deterministic protocol metadata overhead, not a runtime latency benchmark.',
    ]),
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(runInteractionTimelineEvaluation(), null, 2));
}
