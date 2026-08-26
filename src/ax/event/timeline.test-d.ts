import {
  AxInteractionTimeline,
  AxInteractionTimelineVersion,
  type AxTemporalEnvelope,
  AxTemporalEnvelopeSchema,
} from '../index.js';

const audioEnvelope: AxTemporalEnvelope<{
  readonly kind: 'audio_frame';
  readonly mediaId: string;
  readonly mediaRange: {
    readonly timebase: 'media';
    readonly startUs: number;
    readonly endUs: number;
  };
}> = {
  schema: AxTemporalEnvelopeSchema,
  version: AxInteractionTimelineVersion,
  eventId: 'audio-0',
  streamId: 'audio',
  sessionId: 'session-0',
  sourceId: 'source-0',
  epoch: 0,
  sequence: 0,
  revision: 0,
  sessionTimeUs: 0,
  event: {
    kind: 'audio_frame',
    mediaId: 'frame-0',
    mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
  },
};

const timeline = AxInteractionTimeline.create({ sessionId: 'session-0' });
const result = timeline.append(audioEnvelope);
const _nextTimeline: AxInteractionTimeline = result.timeline;

// @ts-expect-error temporal envelopes are immutable
audioEnvelope.sequence = 1;

// @ts-expect-error session ranges cannot be used as media ranges
audioEnvelope.event.mediaRange.timebase = 'session';

void _nextTimeline;
