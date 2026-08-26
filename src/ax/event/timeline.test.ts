import { describe, expect, it } from 'vitest';

import {
  type AxInteractionEvent,
  AxInteractionTimeline,
  AxInteractionTimelineDefaults,
  AxInteractionTimelineSchema,
  AxInteractionTimelineVersion,
  type AxTemporalEnvelope,
  AxTemporalEnvelopeSchema,
  AxTemporalValidationError,
} from './timeline.js';

const envelope = (
  overrides: Partial<AxTemporalEnvelope> = {}
): AxTemporalEnvelope => ({
  schema: AxTemporalEnvelopeSchema,
  version: AxInteractionTimelineVersion,
  eventId: 'event-0',
  streamId: 'text-stream',
  sessionId: 'session-1',
  sourceId: 'source-1',
  participantId: 'participant-1',
  epoch: 0,
  sequence: 0,
  revision: 0,
  sessionTimeUs: 0,
  event: { kind: 'text', text: 'hello' },
  ...overrides,
});

const append = (
  timeline: AxInteractionTimeline,
  candidate: AxTemporalEnvelope
) => timeline.append(candidate);

describe('AxInteractionTimeline', () => {
  it('accepts typed interaction events without retaining mutable inputs', () => {
    const events: AxInteractionEvent[] = [
      {
        kind: 'audio_frame',
        mediaId: 'audio-frame-0',
        mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
        observedRange: {
          timebase: 'session',
          startUs: 1_000,
          endUs: 21_000,
        },
        sampleCount: 480,
      },
      {
        kind: 'transcript',
        text: 'hello',
        final: true,
        mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
        confidence: 0.9,
      },
      {
        kind: 'visual_observation',
        mediaId: 'image-0',
        observedRange: {
          timebase: 'session',
          startUs: 30_000,
          endUs: 35_000,
        },
        mimeType: 'image/png',
      },
      {
        kind: 'text',
        text: 'look at image-0',
        observedRange: {
          timebase: 'session',
          startUs: 40_000,
          endUs: 40_000,
        },
      },
      {
        kind: 'tool_activity',
        toolCallId: 'tool-call-0',
        phase: 'completed',
        toolName: 'lookup',
      },
      {
        kind: 'generated_media',
        mediaId: 'generated-audio-0',
        modality: 'audio',
        generatedRange: {
          timebase: 'session',
          startUs: 50_000,
          endUs: 60_000,
        },
        playedRange: {
          timebase: 'session',
          startUs: 70_000,
          endUs: 80_000,
        },
      },
      {
        kind: 'control',
        signal: 'interrupt',
        targetEventIds: ['event-5'],
      },
    ];
    let timeline = AxInteractionTimeline.create({ sessionId: 'session-1' });
    events.forEach((event, index) => {
      const result = append(
        timeline,
        envelope({
          eventId: `event-${index}`,
          streamId: `stream-${index}`,
          sessionTimeUs: index * 10_000,
          event,
        })
      );
      expect(result.accepted).toBe(true);
      timeline = result.timeline;
    });

    const input = envelope({
      eventId: 'mutable',
      streamId: 'mutable-stream',
      event: { kind: 'text', text: 'before' },
    });
    const result = append(timeline, input);
    (input.event as { text: string }).text = 'after';

    const retained = result.timeline
      .project()
      .events.find((event) => event.eventId === 'mutable');
    expect(retained?.event).toEqual({ kind: 'text', text: 'before' });
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained?.event)).toBe(true);
    expect(result.timeline).not.toBe(timeline);
    expect(Object.isFrozen(result.timeline)).toBe(true);
  });

  it('classifies gaps, reorder, late arrival, restart, and stale epoch', () => {
    let timeline = AxInteractionTimeline.create({
      sessionId: 'session-1',
      reorderWindowUs: 10_000,
    });
    let result = append(timeline, envelope());
    expect(result).toMatchObject({
      accepted: true,
      classification: 'in_order',
      sequenceGap: 0,
    });
    timeline = result.timeline;

    expect(append(timeline, envelope())).toMatchObject({
      accepted: false,
      classification: 'duplicate',
    });
    expect(
      append(
        timeline,
        envelope({ event: { kind: 'text', text: 'conflicting duplicate' } })
      )
    ).toMatchObject({
      accepted: false,
      classification: 'identity_conflict',
    });

    result = append(
      timeline,
      envelope({ eventId: 'event-2', sequence: 2, sessionTimeUs: 20_000 })
    );
    expect(result).toMatchObject({
      accepted: true,
      classification: 'in_order',
      sequenceGap: 1,
    });
    timeline = result.timeline;

    result = append(
      timeline,
      envelope({ eventId: 'event-1', sequence: 1, sessionTimeUs: 12_000 })
    );
    expect(result.classification).toBe('reordered');
    timeline = result.timeline;

    result = append(
      timeline,
      envelope({ eventId: 'event-4', sequence: 4, sessionTimeUs: 100_000 })
    );
    expect(result.sequenceGap).toBe(1);
    timeline = result.timeline;

    result = append(
      timeline,
      envelope({ eventId: 'event-3', sequence: 3, sessionTimeUs: 30_000 })
    );
    expect(result.classification).toBe('late');
    timeline = result.timeline;

    result = append(
      timeline,
      envelope({
        eventId: 'event-restart',
        epoch: 1,
        sequence: 0,
        sessionTimeUs: 110_000,
      })
    );
    expect(result.classification).toBe('new_epoch');
    timeline = result.timeline;

    expect(
      append(
        timeline,
        envelope({
          eventId: 'event-stale',
          epoch: 0,
          sequence: 5,
          sessionTimeUs: 120_000,
        })
      )
    ).toMatchObject({ accepted: false, classification: 'stale_epoch' });
  });

  it('accepts only increasing revisions at a stable event position', () => {
    const first = envelope({
      eventId: 'transcript-0',
      event: { kind: 'transcript', text: 'hello', final: false },
    });
    const initial = AxInteractionTimeline.create({ sessionId: 'session-1' });
    const accepted = append(initial, first);
    const revised = append(
      accepted.timeline,
      envelope({
        eventId: 'transcript-0',
        revision: 1,
        event: { kind: 'transcript', text: 'hello.', final: true },
      })
    );
    expect(revised).toMatchObject({
      accepted: true,
      classification: 'revision',
    });
    expect(revised.timeline.retainedEventCount).toBe(1);
    expect(revised.timeline.project().events[0]?.event).toMatchObject({
      text: 'hello.',
      final: true,
    });
    expect(append(revised.timeline, first)).toMatchObject({
      accepted: false,
      classification: 'stale_revision',
    });
    expect(
      append(
        revised.timeline,
        envelope({
          eventId: 'transcript-0',
          revision: 2,
          sequence: 1,
        })
      )
    ).toMatchObject({
      accepted: false,
      classification: 'identity_conflict',
    });
    expect(
      append(
        revised.timeline,
        envelope({
          eventId: 'transcript-0',
          revision: 2,
          sessionTimeUs: 1,
        })
      )
    ).toMatchObject({
      accepted: false,
      classification: 'identity_conflict',
    });
  });

  it('rejects sequence, temporal, and causal conflicts deterministically', () => {
    const initial = AxInteractionTimeline.create({ sessionId: 'session-1' });
    const first = append(initial, envelope()).timeline;
    expect(
      append(
        first,
        envelope({ eventId: 'other-id', sequence: 0, sessionTimeUs: 0 })
      ).classification
    ).toBe('sequence_conflict');
    expect(
      append(
        first,
        envelope({ eventId: 'time-regression', sequence: 1, sessionTimeUs: 0 })
      ).classification
    ).toBe('in_order');

    const forward = append(
      first,
      envelope({ eventId: 'forward', sequence: 2, sessionTimeUs: 20_000 })
    ).timeline;
    expect(
      append(
        forward,
        envelope({
          eventId: 'time-conflict',
          sequence: 1,
          sessionTimeUs: 30_000,
        })
      ).classification
    ).toBe('temporal_conflict');

    const causalA = append(
      forward,
      envelope({
        eventId: 'causal-a',
        streamId: 'control',
        sequence: 0,
        sessionTimeUs: 30_000,
        causalParentIds: ['causal-b'],
        linkIds: ['event-0'],
        event: { kind: 'control', signal: 'start' },
      })
    );
    expect(causalA.accepted).toBe(true);
    const cycle = append(
      causalA.timeline,
      envelope({
        eventId: 'causal-b',
        streamId: 'control',
        sequence: 1,
        sessionTimeUs: 40_000,
        causalParentIds: ['causal-a'],
        event: { kind: 'control', signal: 'stop' },
      })
    );
    expect(cycle).toMatchObject({
      accepted: false,
      classification: 'causal_cycle',
      timeline: causalA.timeline,
    });
  });

  it('bounds retention and projections by exact event JSON bytes', () => {
    let timeline = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: 2,
      maxBytes: 10_000,
      reorderWindowUs: 500,
    });
    for (let index = 0; index < 3; index++) {
      const result = append(
        timeline,
        envelope({
          eventId: `event-${index}`,
          sequence: index,
          sessionTimeUs: index * 1_000,
        })
      );
      timeline = result.timeline;
      if (index === 2) expect(result.evictedEventIds).toEqual(['event-0']);
    }
    expect(timeline.retainedEventCount).toBe(2);

    const full = timeline.project();
    expect(full.events.map((event) => event.eventId)).toEqual([
      'event-1',
      'event-2',
    ]);
    expect(full.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(full.events)).byteLength
    );
    const one = timeline.project({ maxEvents: 1 });
    expect(one.events).toHaveLength(1);
    expect(one.omittedEventCount).toBe(1);
    const byteBounded = timeline.project({ maxBytes: full.bytes - 1 });
    expect(byteBounded.events).toHaveLength(1);
    expect(byteBounded.bytes).toBeLessThanOrEqual(full.bytes - 1);

    // Duplicate and cycle memory is bounded by retained envelopes. Stream
    // frontiers survive eviction, so this old sequence remains late.
    expect(append(timeline, envelope()).classification).toBe('late');
    expect(
      append(
        timeline,
        envelope({ eventId: 'future-old-sequence', sessionTimeUs: 3_000 })
      ).classification
    ).toBe('temporal_conflict');
  });

  it('rejects a later sequence that regresses session time after eviction', () => {
    let timeline = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: 1,
    });
    timeline = append(
      timeline,
      envelope({ eventId: 'seq-1', sequence: 1, sessionTimeUs: 100 })
    ).timeline;
    timeline = append(
      timeline,
      envelope({ eventId: 'seq-0', sequence: 0, sessionTimeUs: 90 })
    ).timeline;
    timeline = AxInteractionTimeline.deserialize(timeline.serialize());
    expect(
      append(
        timeline,
        envelope({ eventId: 'seq-2', sequence: 2, sessionTimeUs: 95 })
      )
    ).toMatchObject({
      accepted: false,
      classification: 'temporal_conflict',
    });
    expect(timeline.project().events.map((event) => event.eventId)).toEqual([
      'seq-0',
    ]);
  });

  it('never evicts the envelope accepted by a revision', () => {
    const first = envelope({
      eventId: 'a',
      sequence: 0,
      event: { kind: 'text', text: 'aa' },
    });
    const second = envelope({
      eventId: 'b',
      sequence: 1,
      sessionTimeUs: 1,
      event: { kind: 'text', text: 'bb' },
    });
    let timeline = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: 2,
      maxBytes: 550,
    });
    timeline = append(timeline, first).timeline;
    timeline = append(timeline, second).timeline;
    const revised = append(
      timeline,
      envelope({
        eventId: 'a',
        revision: 1,
        event: { kind: 'text', text: 'a'.repeat(80) },
      })
    );
    expect(revised.accepted).toBe(true);
    expect(revised.classification).toBe('revision');
    expect(revised.evictedEventIds).toEqual(['b']);
    expect(revised.timeline.project().events).toMatchObject([
      {
        eventId: 'a',
        revision: 1,
        event: { kind: 'text', text: 'a'.repeat(80) },
      },
    ]);
  });

  it('ignores undeclared mediaRange fields on non-media events', () => {
    const initial = AxInteractionTimeline.create({ sessionId: 'session-1' });
    const audio = append(
      initial,
      envelope({
        streamId: 'shared',
        event: {
          kind: 'audio_frame',
          mediaId: 'audio-0',
          mediaRange: { timebase: 'media', startUs: 100, endUs: 200 },
        },
      })
    ).timeline;
    const controlWithExtraMediaRange = envelope({
      eventId: 'control-1',
      streamId: 'shared',
      sequence: 1,
      sessionTimeUs: 1,
      event: {
        kind: 'control',
        signal: 'interrupt',
        mediaRange: { timebase: 'session', startUs: 0, endUs: 1 },
      } as unknown as AxInteractionEvent,
    });

    expect(append(audio, controlWithExtraMediaRange)).toMatchObject({
      accepted: true,
      classification: 'in_order',
    });
  });

  it('filters projections and sorts by authoritative session time, not arrival or wall time', () => {
    let timeline = AxInteractionTimeline.create({ sessionId: 'session-1' });
    const later = append(
      timeline,
      envelope({
        eventId: 'later',
        streamId: 'audio',
        sessionTimeUs: 20_000,
        wallTime: '2026-08-25T00:00:00Z',
        participantId: 'p-1',
        event: {
          kind: 'audio_frame',
          mediaId: 'audio-0',
          mediaRange: { timebase: 'media', startUs: 0, endUs: 20_000 },
        },
      })
    );
    timeline = later.timeline;
    timeline = append(
      timeline,
      envelope({
        eventId: 'earlier',
        streamId: 'visual',
        sessionTimeUs: 10_000,
        wallTime: '2026-08-25T00:00:10Z',
        participantId: 'p-2',
        event: {
          kind: 'visual_observation',
          mediaId: 'image-0',
          observedRange: {
            timebase: 'session',
            startUs: 10_000,
            endUs: 11_000,
          },
        },
      })
    ).timeline;

    expect(timeline.project().events.map((event) => event.eventId)).toEqual([
      'earlier',
      'later',
    ]);
    expect(
      timeline
        .project({
          participantIds: ['p-1'],
          kinds: ['audio_frame'],
          startSessionTimeUs: 15_000,
          endSessionTimeUs: 30_000,
        })
        .events.map((event) => event.eventId)
    ).toEqual(['later']);
  });

  it('uses locale-independent ID tie-breaks', () => {
    let timeline = AxInteractionTimeline.create({ sessionId: 'session-1' });
    timeline = append(
      timeline,
      envelope({ eventId: 'umlaut', streamId: 'ä' })
    ).timeline;
    timeline = append(
      timeline,
      envelope({ eventId: 'ascii', streamId: 'z' })
    ).timeline;

    expect(timeline.project().events.map((event) => event.eventId)).toEqual([
      'ascii',
      'umlaut',
    ]);
  });

  it('round-trips versioned snapshots with stream frontiers intact', () => {
    let timeline = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: 2,
      maxBytes: 5_000,
      maxStreams: 2,
      reorderWindowUs: 5_000,
    });
    timeline = append(timeline, envelope()).timeline;
    timeline = append(
      timeline,
      envelope({ eventId: 'event-1', sequence: 1, sessionTimeUs: 10_000 })
    ).timeline;
    const serialized = timeline.serialize();
    const restored = AxInteractionTimeline.deserialize(serialized);

    expect(restored.serialize()).toBe(serialized);
    expect(restored.toJSON()).toMatchObject({
      schema: AxInteractionTimelineSchema,
      version: 1,
      sessionId: 'session-1',
    });
    expect(
      append(
        restored,
        envelope({ eventId: 'event-2', sequence: 2, sessionTimeUs: 20_000 })
      ).classification
    ).toBe('in_order');

    const conflictingFrontier = JSON.parse(serialized) as {
      streams: Array<{ maxEventId: string }>;
    };
    conflictingFrontier.streams[0]!.maxEventId = 'different-event';
    expect(() =>
      AxInteractionTimeline.deserialize(JSON.stringify(conflictingFrontier))
    ).toThrow('timeline stream frontier conflicts with event event-1');

    const duplicatePosition = JSON.parse(serialized) as {
      events: Array<AxTemporalEnvelope>;
    };
    duplicatePosition.events[0] = {
      ...duplicatePosition.events[1]!,
      eventId: 'different-event',
    };
    expect(() =>
      AxInteractionTimeline.deserialize(JSON.stringify(duplicatePosition))
    ).toThrow('timeline event stream positions must be unique');

    let frontierEvicted = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: 1,
    });
    frontierEvicted = append(
      frontierEvicted,
      envelope({ eventId: 'event-2', sequence: 2, sessionTimeUs: 20_000 })
    ).timeline;
    frontierEvicted = append(
      frontierEvicted,
      envelope({ eventId: 'event-1', sequence: 1, sessionTimeUs: 10_000 })
    ).timeline;
    expect(
      AxInteractionTimeline.deserialize(frontierEvicted.serialize())
        .project()
        .events.map((event) => event.eventId)
    ).toEqual(['event-1']);
  });

  it('fails closed on invalid timebases, wall time, and serialized versions', () => {
    const timeline = AxInteractionTimeline.create({ sessionId: 'session-1' });
    expect(() =>
      append(
        timeline,
        envelope({
          event: {
            kind: 'audio_frame',
            mediaId: 'audio-0',
            mediaRange: {
              timebase: 'session',
              startUs: 0,
              endUs: 1,
            },
          } as unknown as AxInteractionEvent,
        })
      )
    ).toThrow(AxTemporalValidationError);
    expect(() =>
      append(timeline, envelope({ wallTime: '2026-08-25T00:00:00' }))
    ).toThrow('wallTime must be an RFC 3339 timestamp');
    expect(() =>
      append(timeline, envelope({ wallTime: '2026-02-30T00:00:00Z' }))
    ).toThrow('wallTime must be an RFC 3339 timestamp');
    expect(
      append(timeline, envelope({ wallTime: '2016-12-31T23:59:60Z' })).accepted
    ).toBe(true);
    expect(
      append(
        timeline,
        envelope({
          eventId: 'leap-second-offset',
          sequence: 1,
          sessionTimeUs: 1,
          wallTime: '2017-01-01T00:59:60+01:00',
        })
      ).accepted
    ).toBe(true);
    expect(
      append(
        timeline,
        envelope({
          eventId: 'leap-second-negative-offset',
          sequence: 2,
          sessionTimeUs: 2,
          wallTime: '2016-12-31T18:59:60-05:00',
        })
      ).accepted
    ).toBe(true);
    expect(() =>
      append(timeline, envelope({ wallTime: '2016-12-30T23:59:60Z' }))
    ).toThrow('wallTime must be an RFC 3339 timestamp');
    expect(() =>
      append(timeline, envelope({ wallTime: '2017-12-31T23:59:60Z' }))
    ).toThrow('wallTime must be an RFC 3339 timestamp');
    const cyclic = envelope() as AxTemporalEnvelope & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    expect(() => append(timeline, cyclic)).toThrow(
      'envelope.cycle must not contain cycles'
    );
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 129; index++) nested = { nested };
    expect(() =>
      append(
        timeline,
        envelope({
          event: {
            kind: 'control',
            signal: 'start',
            nested,
          } as unknown as AxInteractionEvent,
        })
      )
    ).toThrow('must not exceed 128 levels');

    const snapshot = timeline.toJSON() as unknown as Record<string, unknown>;
    expect(() =>
      AxInteractionTimeline.deserialize(
        JSON.stringify({ ...snapshot, version: 2 })
      )
    ).toThrow('unsupported interaction timeline version');
  });

  it('rejects accessor-backed envelopes without reading accessors', () => {
    const timeline = AxInteractionTimeline.create({ sessionId: 'session-1' });
    let getterReads = 0;
    const event = {
      signal: 'start',
      mediaRange: { timebase: 'media', startUs: 0, endUs: 1 },
    } as Record<string, unknown>;
    Object.defineProperty(event, 'kind', {
      enumerable: true,
      get: () => {
        getterReads++;
        return getterReads < 6 ? 'control' : 'audio_frame';
      },
    });

    expect(() =>
      append(
        timeline,
        envelope({ event: event as unknown as AxInteractionEvent })
      )
    ).toThrow('envelope.event.kind must not use accessors');
    expect(getterReads).toBe(0);
  });

  it('enforces the retained byte budget before processing later events', () => {
    const baseSnapshot = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: 2,
      maxBytes: 300,
    }).toJSON();
    const oversizedEvent = envelope({
      event: { kind: 'text', text: 'x'.repeat(300) },
    });
    const snapshot = JSON.stringify({
      ...baseSnapshot,
      events: [],
    }).replace(
      '"events":[]',
      `"events":[${JSON.stringify(oversizedEvent)},${'{"nested":'.repeat(20_000)}null${'}'.repeat(20_000)}]`
    );

    expect(() => AxInteractionTimeline.deserialize(snapshot)).toThrow(
      'timeline exceeds its retained byte limit'
    );
  });

  it('keeps snapshot-declared limits within host deserialization limits', () => {
    const snapshot = AxInteractionTimeline.create({
      sessionId: 'session-1',
      maxEvents: AxInteractionTimelineDefaults.maxEvents + 1,
    }).serialize();

    expect(() => AxInteractionTimeline.deserialize(snapshot)).toThrow(
      'timeline options exceed the deserialization event limit'
    );
    expect(
      AxInteractionTimeline.deserialize(snapshot, {
        maxEvents: AxInteractionTimelineDefaults.maxEvents + 1,
      }).options.maxEvents
    ).toBe(AxInteractionTimelineDefaults.maxEvents + 1);
    expect(() =>
      AxInteractionTimeline.deserialize(' '.repeat(2_000_000))
    ).toThrow('serialized timeline exceeds its deserialization byte limit');
  });

  it('round-trips maximal default snapshots with escaped IDs', () => {
    const escapedId = (prefix: string, index: number) => {
      const suffix = `${prefix}${index.toString(36)}`;
      return `${'\0'.repeat(256 - suffix.length)}${suffix}`;
    };
    const sessionId = '\0'.repeat(256);
    let timeline = AxInteractionTimeline.create({ sessionId });
    for (
      let index = 0;
      index < AxInteractionTimelineDefaults.maxStreams;
      index++
    ) {
      const result = timeline.append(
        envelope({
          eventId: escapedId('e', index),
          streamId: escapedId('s', index),
          sessionId,
          sourceId: 'source',
          participantId: 'participant',
          sessionTimeUs: index,
          event: { kind: 'text', text: '' },
        })
      );
      expect(result.accepted).toBe(true);
      timeline = result.timeline;
    }
    const fillerLength =
      AxInteractionTimelineDefaults.maxBytes - timeline.retainedBytes - 10_000;
    const revised = timeline.append(
      envelope({
        eventId: escapedId('e', 0),
        streamId: escapedId('s', 0),
        sessionId,
        sourceId: 'source',
        participantId: 'participant',
        revision: 1,
        event: { kind: 'text', text: 'x'.repeat(fillerLength) },
      })
    );
    expect(revised.accepted).toBe(true);
    expect(revised.timeline.retainedEventCount).toBe(
      AxInteractionTimelineDefaults.maxStreams
    );

    const serialized = revised.timeline.serialize();
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
      1_349_632
    );
    expect(AxInteractionTimeline.deserialize(serialized).serialize()).toBe(
      serialized
    );
  });

  it('accounts for projection bytes with one serialization per event', () => {
    let timeline = AxInteractionTimeline.create({ sessionId: 'session-1' });
    for (
      let index = 0;
      index < AxInteractionTimelineDefaults.maxEvents;
      index++
    ) {
      timeline = timeline.append(
        envelope({
          eventId: `event-${index}`,
          sequence: index,
          sessionTimeUs: index,
        })
      ).timeline;
    }

    const stringify = JSON.stringify;
    let stringifyCalls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      stringifyCalls++;
      return stringify(...args);
    }) as typeof JSON.stringify;
    let projection: ReturnType<AxInteractionTimeline['project']>;
    try {
      projection = timeline.project();
    } finally {
      JSON.stringify = stringify;
    }

    expect(projection.events).toHaveLength(
      AxInteractionTimelineDefaults.maxEvents
    );
    expect(stringifyCalls).toBe(AxInteractionTimelineDefaults.maxEvents);
    expect(projection.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(projection.events)).byteLength
    );
  });
});
