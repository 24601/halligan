import { describe, expect, it } from 'vitest';
import { AxFrameSampler, axVisualPerceptualDigest } from './sampler.js';
import type { AxVisualObservation } from './types.js';

const luma = (pixel: (x: number, y: number) => number): Uint8Array =>
  Uint8Array.from({ length: 72 }, (_, index) =>
    pixel(index % 9, Math.floor(index / 9))
  );

const frame = (
  revision: number,
  atMs: number,
  overrides: Partial<AxVisualObservation> = {}
): AxVisualObservation => ({
  sourceId: 'source-a',
  streamId: 'stream-a',
  frameId: `frame-${revision}`,
  revision,
  freshness: {
    capturedAtMs: atMs,
    observedAtMs: atMs,
    expiresAtMs: atMs + 1_000,
  },
  dimensions: { width: 640, height: 360 },
  mediaType: 'image/webp',
  byteLength: 100,
  tokenEstimate: 10,
  authority: {
    authorityRef: 'authority-a',
    consentRef: 'consent-a',
    revision: 1,
  },
  perceptualInput: { width: 9, height: 8, luma: luma((x) => x * 20) },
  ...overrides,
});

const sampler = (
  overrides: ConstructorParameters<typeof AxFrameSampler>[0] = {}
) =>
  new AxFrameSampler({
    minIntervalMs: 100,
    maxIntervalMs: 1_000,
    changeThreshold: 0.125,
    sceneCutThreshold: 0.75,
    maxObservationAgeMs: 500,
    maxFutureSkewMs: 10,
    maxObservationBytes: 1_000,
    budget: {
      windowMs: 1_000,
      maxFrames: 10,
      maxBytes: 10_000,
      maxTokens: 1_000,
    },
    ...overrides,
  });

describe('axVisualPerceptualDigest', () => {
  it('computes a deterministic browser-safe difference hash', () => {
    expect(
      axVisualPerceptualDigest({
        width: 9,
        height: 8,
        luma: luma((x) => x),
      })
    ).toEqual({ algorithm: 'dhash-64', value: '0000000000000000' });
    expect(
      axVisualPerceptualDigest({
        width: 9,
        height: 8,
        luma: luma((x) => 8 - x),
      })
    ).toEqual({ algorithm: 'dhash-64', value: 'ffffffffffffffff' });
  });

  it('rejects malformed normalized input', () => {
    expect(() =>
      axVisualPerceptualDigest({ width: 9, height: 8, luma: new Uint8Array(1) })
    ).toThrow(/9 x 8/);
  });
});

describe('AxFrameSampler', () => {
  it('samples the first frame, suppresses static and tiny/noise changes, and recalls material changes', () => {
    const policy = sampler();
    expect(policy.observe(frame(1, 0)).reason).toBe('initial');
    expect(policy.observe(frame(2, 150)).reason).toBe('unchanged');
    expect(
      policy.observe(
        frame(3, 300, {
          perceptualInput: {
            width: 9,
            height: 8,
            luma: luma((x, y) => x * 20 + ((x + y) % 2)),
          },
        })
      ).reason
    ).toBe('unchanged');
    const changed = policy.observe(
      frame(4, 450, {
        perceptualInput: {
          width: 9,
          height: 8,
          luma: luma((x, y) => ((x + y) % 2 ? 255 : 0)),
        },
      })
    );
    expect(changed.action).toBe('change-trigger');
    expect(changed.reason).toBe('change');
    expect(changed.changeScore).toBe(0.5);
  });

  it('lets scene cuts bypass the minimum interval', () => {
    const policy = sampler({ minIntervalMs: 500 });
    policy.observe(frame(1, 0));
    const cut = policy.observe(
      frame(2, 10, {
        perceptualInput: {
          width: 9,
          height: 8,
          luma: luma((x) => 255 - x * 20),
        },
      })
    );
    expect(cut).toMatchObject({
      action: 'change-trigger',
      reason: 'scene_cut',
    });
  });

  it('refuses stale and out-of-order revisions while allowing dropped frame numbers', () => {
    const policy = sampler();
    policy.observe(frame(1, 0));
    expect(policy.observe(frame(4, 100)).reason).toBe('unchanged');
    expect(policy.observe(frame(3, 200)).reason).toBe('stale_revision');
    expect(policy.observe(frame(4, 300)).reason).toBe('stale_revision');
  });

  it('fails closed on stale, future, expired, malformed, and oversized observations', () => {
    expect(sampler().observe(frame(1, 1_000), 1_501).reason).toBe('stale_time');
    expect(sampler().observe(frame(1, 1_000), 989).reason).toBe('future_time');
    expect(
      sampler().observe(
        frame(1, 1_000, {
          freshness: {
            capturedAtMs: 1_000,
            observedAtMs: 1_000,
            expiresAtMs: 1_010,
          },
        }),
        1_011
      ).reason
    ).toBe('expired');
    expect(
      sampler().observe(frame(1, 0, { mediaType: 'video/mp4' })).reason
    ).toBe('malformed');
    expect(sampler().observe(frame(1, 0, { byteLength: 1_001 })).reason).toBe(
      'oversized'
    );
    expect(
      sampler().observe(
        frame(1, 0, {
          digest: { algorithm: 'dhash-64', value: 'not-a-digest' },
          perceptualInput: undefined,
        })
      ).reason
    ).toBe('malformed');
    expect(
      sampler().observe({
        sourceId: 'partial',
      } as unknown as AxVisualObservation).reason
    ).toBe('malformed');
  });

  it('does not let invalid observations consume frame revisions', () => {
    const policy = sampler();
    expect(
      policy.observe(
        frame(10, 1_000, {
          digest: { algorithm: 'dhash-64', value: 'malformed' },
          perceptualInput: undefined,
        })
      ).reason
    ).toBe('malformed');
    expect(policy.observe(frame(1, 1_100)).reason).toBe('initial');
  });

  it('enforces frame, byte, and token budgets independently', () => {
    const changed = (
      revision: number,
      atMs: number,
      byteLength = 100,
      tokenEstimate = 10
    ) =>
      frame(revision, atMs, {
        byteLength,
        tokenEstimate,
        digest: {
          algorithm: 'dhash-64',
          value: revision % 2 ? '0000000000000000' : 'ffffffffffffffff',
        },
        perceptualInput: undefined,
      });

    const frames = sampler({ budget: { maxFrames: 1 } });
    frames.observe(changed(1, 0));
    expect(frames.observe(changed(2, 100)).reason).toBe('budget_frames');

    const bytes = sampler({ budget: { maxFrames: 10, maxBytes: 150 } });
    bytes.observe(changed(1, 0));
    expect(bytes.observe(changed(2, 100)).reason).toBe('budget_bytes');

    const tokens = sampler({
      budget: { maxFrames: 10, maxBytes: 10_000, maxTokens: 15 },
    });
    tokens.observe(changed(1, 0));
    expect(tokens.observe(changed(2, 100)).reason).toBe('budget_tokens');
  });

  it('suppresses revoked authority, refuses stale authority, and resumes only on a newer grant', () => {
    const policy = sampler();
    policy.observe(frame(1, 0));
    expect(
      policy.observe(
        frame(2, 100, {
          authority: {
            authorityRef: 'authority-a',
            consentRef: 'consent-a',
            revision: 2,
            revoked: true,
          },
        })
      ).reason
    ).toBe('revoked');
    expect(policy.observe(frame(3, 200)).reason).toBe('stale_authority');
    expect(
      policy.observe(
        frame(4, 300, {
          authority: {
            authorityRef: 'authority-b',
            consentRef: 'consent-b',
            revision: 3,
          },
        })
      ).reason
    ).toBe('unchanged');
  });

  it('latches a fresh newer revocation even on an out-of-order frame', () => {
    const policy = sampler();
    policy.observe(frame(5, 0));
    expect(
      policy.observe(
        frame(4, 100, {
          authority: {
            authorityRef: 'authority-a',
            consentRef: 'consent-a',
            revision: 2,
            revoked: true,
          },
        })
      ).reason
    ).toBe('revoked');
    expect(
      policy.observe(
        frame(6, 200, {
          authority: {
            authorityRef: 'authority-a',
            consentRef: 'consent-a',
            revision: 2,
          },
        })
      ).reason
    ).toBe('revoked');
  });

  it('binds one sampler to one source stream', () => {
    const policy = sampler({ budget: { maxFrames: 1 } });
    policy.observe(frame(1, 0));
    expect(
      policy.observe(frame(2, 2_000, { streamId: 'other-stream' })).reason
    ).toBe('stream_mismatch');
    expect(
      policy.observe(
        frame(3, 100, {
          digest: { algorithm: 'dhash-64', value: 'ffffffffffffffff' },
          perceptualInput: undefined,
        })
      ).reason
    ).toBe('budget_frames');
  });
});
