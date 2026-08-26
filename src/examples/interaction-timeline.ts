import {
  AxInteractionTimeline,
  AxInteractionTimelineVersion,
  type AxTemporalEnvelope,
  AxTemporalEnvelopeSchema,
} from '../ax/index.js';

const envelopes = [
  {
    schema: AxTemporalEnvelopeSchema,
    version: AxInteractionTimelineVersion,
    eventId: 'audio-0',
    streamId: 'audio',
    sessionId: 'demo-session',
    sourceId: 'browser-audio',
    participantId: 'speaker-a',
    epoch: 0,
    sequence: 0,
    revision: 0,
    sessionTimeUs: 0,
    event: {
      kind: 'audio_frame',
      mediaId: 'audio-frame-0',
      mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
      observedRange: { timebase: 'session', startUs: 0, endUs: 20_000 },
    },
  },
  {
    schema: AxTemporalEnvelopeSchema,
    version: AxInteractionTimelineVersion,
    eventId: 'audio-2',
    streamId: 'audio',
    sessionId: 'demo-session',
    sourceId: 'browser-audio',
    participantId: 'speaker-a',
    epoch: 0,
    sequence: 2,
    revision: 0,
    sessionTimeUs: 40_000,
    event: {
      kind: 'audio_frame',
      mediaId: 'audio-frame-2',
      mediaRange: { timebase: 'media', startUs: 40_000, endUs: 60_000 },
    },
  },
  {
    schema: AxTemporalEnvelopeSchema,
    version: AxInteractionTimelineVersion,
    eventId: 'visual-0',
    streamId: 'visual',
    sessionId: 'demo-session',
    sourceId: 'browser-camera',
    participantId: 'speaker-a',
    epoch: 0,
    sequence: 0,
    revision: 0,
    sessionTimeUs: 15_000,
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
  },
  {
    schema: AxTemporalEnvelopeSchema,
    version: AxInteractionTimelineVersion,
    eventId: 'audio-1',
    streamId: 'audio',
    sessionId: 'demo-session',
    sourceId: 'browser-audio',
    participantId: 'speaker-a',
    epoch: 0,
    sequence: 1,
    revision: 0,
    sessionTimeUs: 20_000,
    linkIds: ['visual-0'],
    event: {
      kind: 'transcript',
      text: 'A synthetic transcript linked to the visual observation.',
      final: true,
      mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
    },
  },
] satisfies readonly AxTemporalEnvelope[];

let timeline = AxInteractionTimeline.create({
  sessionId: 'demo-session',
  maxEvents: 32,
  maxBytes: 32 * 1_024,
});
const classifications: string[] = [];

for (const envelope of envelopes) {
  const result = timeline.append(envelope);
  classifications.push(result.classification);
  timeline = result.timeline;
}

const projection = timeline.project({ maxEvents: 8, maxBytes: 8 * 1_024 });
console.log({
  classifications,
  temporalOrder: projection.events.map((event) => event.eventId),
  projectionBytes: projection.bytes,
});
