import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
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

  it('accepts a Uint8Array created in another realm', () => {
    const crossRealm = runInNewContext('new Uint8Array(72)') as Uint8Array;
    expect(
      axVisualPerceptualDigest({ width: 9, height: 8, luma: crossRealm })
    ).toEqual({ algorithm: 'dhash-64', value: '0000000000000000' });
  });

  it('rejects DataView and other typed-array brands, including tag spoofs', () => {
    const dataView = new DataView(new ArrayBuffer(72));
    Object.defineProperty(dataView, 'length', { value: 72 });
    Object.defineProperty(dataView, Symbol.toStringTag, {
      value: 'Uint8Array',
    });

    for (const invalid of [
      dataView,
      new Uint16Array(72),
      new Uint8ClampedArray(72),
    ]) {
      expect(() =>
        axVisualPerceptualDigest({
          width: 9,
          height: 8,
          luma: invalid as unknown as Uint8Array,
        })
      ).toThrow(/9 x 8/);
    }
  });

  it('rejects a SharedArrayBuffer while a worker mutates its bytes', async () => {
    const bytes = new SharedArrayBuffer(72);
    const control = new SharedArrayBuffer(4);
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const bytes = new Uint8Array(workerData.bytes);
        const control = new Int32Array(workerData.control);
        parentPort.postMessage('ready');
        while (Atomics.load(control, 0) === 0) {
          bytes.fill(0);
          bytes.fill(255);
        }
      `,
      { eval: true, workerData: { bytes, control } }
    );

    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });

    try {
      const sharedLuma = new Uint8Array(bytes);
      for (let attempt = 0; attempt < 100; attempt++) {
        expect(() =>
          axVisualPerceptualDigest({
            width: 9,
            height: 8,
            luma: sharedLuma,
          })
        ).toThrow(/SharedArrayBuffer/);
      }
      expect(
        sampler().observe(
          frame(1, 0, {
            perceptualInput: { width: 9, height: 8, luma: sharedLuma },
          })
        ).reason
      ).toBe('shared_memory');
    } finally {
      Atomics.store(new Int32Array(control), 0, 1);
      await worker.terminate();
    }
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

  it('latches well-formed revocation before payload rejection', () => {
    const invalidFrames: Partial<AxVisualObservation>[] = [
      { byteLength: 1_001 },
      {
        freshness: {
          capturedAtMs: 100,
          observedAtMs: 100,
          expiresAtMs: 101,
        },
      },
      {
        freshness: {
          capturedAtMs: 1_000,
          observedAtMs: 1_000,
          expiresAtMs: 2_000,
        },
      },
      {
        digest: { algorithm: 'dhash-64', value: 'malformed' },
        perceptualInput: undefined,
      },
    ];

    for (const invalid of invalidFrames) {
      const policy = sampler();
      policy.observe(frame(1, 0));
      expect(
        policy.observe(
          frame(2, 100, {
            ...invalid,
            authority: {
              authorityRef: 'authority-a',
              consentRef: 'consent-a',
              revision: 2,
              revoked: true,
            },
          }),
          200
        ).reason
      ).toBe('revoked');
      expect(policy.observe(frame(3, 300)).reason).toBe('stale_authority');
    }
  });

  it('keeps a newer authority revision when payload snapshotting throws', () => {
    const policy = sampler();
    policy.observe(frame(1, 0));
    const observation = frame(2, 100, {
      authority: {
        authorityRef: 'authority-b',
        consentRef: 'consent-b',
        revision: 2,
      },
    });
    Object.defineProperty(observation, 'digest', {
      get: () => {
        throw new Error('synthetic payload getter failure');
      },
    });

    expect(policy.observe(observation).reason).toBe('malformed');
    expect(policy.observe(frame(3, 200)).reason).toBe('stale_authority');
  });

  it('does not bind a stream until a frame passes payload validation and budget', () => {
    const policy = sampler();
    expect(
      policy.observe(
        frame(1, 0, {
          sourceId: 'attacker-source',
          streamId: 'attacker-stream',
          digest: { algorithm: 'dhash-64', value: 'malformed' },
          perceptualInput: undefined,
        })
      ).reason
    ).toBe('malformed');
    expect(policy.observe(frame(1, 100)).reason).toBe('initial');
  });

  it('rejects an invalid supplied digest instead of falling back to perceptual input', () => {
    expect(
      sampler().observe(
        frame(1, 0, {
          digest: { algorithm: 'dhash-64', value: 'malformed' },
        })
      ).reason
    ).toBe('malformed');
  });

  it('snapshots a stateful digest getter once without perceptual fallback', () => {
    const observation = frame(1, 0);
    let reads = 0;
    Object.defineProperty(observation, 'digest', {
      get: () => {
        reads++;
        return reads === 1
          ? { algorithm: 'dhash-64', value: 'malformed' }
          : undefined;
      },
    });

    expect(sampler().observe(observation).reason).toBe('malformed');
    expect(reads).toBe(1);
  });

  it('copies and freezes supplied digests and decisions', () => {
    const digest = {
      algorithm: 'dhash-64' as const,
      value: '0000000000000000',
    };
    const policy = sampler();
    const first = policy.observe(
      frame(1, 0, { digest, perceptualInput: undefined })
    );
    digest.value = 'ffffffffffffffff';
    const second = policy.observe(
      frame(2, 100, {
        digest: { algorithm: 'dhash-64', value: '0000000000000000' },
        perceptualInput: undefined,
      })
    );

    expect(second.reason).toBe('unchanged');
    expect(first.digest?.value).toBe('0000000000000000');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.digest)).toBe(true);
    expect(Object.isFrozen(first.budget)).toBe(true);
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

  it('copies and freezes options so callers cannot change enforcement', () => {
    const options = {
      maxObservationBytes: 1_000,
      budget: { maxFrames: 1 },
    };
    const policy = new AxFrameSampler(options);
    options.maxObservationBytes = 1;
    options.budget.maxFrames = 10;

    expect(Object.isFrozen(policy.options)).toBe(true);
    expect(Object.isFrozen(policy.options.budget)).toBe(true);
    expect(() => {
      (policy.options.budget as { maxFrames: number }).maxFrames = 10;
    }).toThrow(TypeError);

    expect(policy.observe(frame(1, 0)).reason).toBe('initial');
    expect(
      policy.observe(
        frame(2, 100, {
          digest: { algorithm: 'dhash-64', value: 'ffffffffffffffff' },
          perceptualInput: undefined,
        })
      ).reason
    ).toBe('budget_frames');
  });

  it('allows a budget-rejected revision to retry after the rolling window clears', () => {
    const policy = sampler({
      maxObservationAgeMs: 2_000,
      budget: { windowMs: 1_000, maxFrames: 1 },
    });
    policy.observe(frame(1, 0));
    const candidate = frame(2, 100, {
      freshness: {
        capturedAtMs: 100,
        observedAtMs: 100,
        expiresAtMs: 3_000,
      },
      digest: { algorithm: 'dhash-64', value: 'ffffffffffffffff' },
      perceptualInput: undefined,
    });
    expect(policy.observe(candidate, 100).reason).toBe('budget_frames');
    expect(policy.observe(candidate, 1_001).reason).toBe('scene_cut');
  });

  it('rejects clock rollback and starts a fresh rolling-time epoch', () => {
    const policy = sampler({
      maxObservationAgeMs: 2_000,
      budget: { windowMs: 1_000, maxFrames: 1 },
    });
    policy.observe(frame(1, 1_000));
    const candidate = frame(2, 100, {
      digest: { algorithm: 'dhash-64', value: 'ffffffffffffffff' },
      perceptualInput: undefined,
    });
    expect(policy.observe(candidate, 100).reason).toBe('clock_rollback');
    expect(policy.observe(candidate, 101).reason).toBe('scene_cut');
  });

  it('converts throwing accessors into malformed suppression', () => {
    const observation = frame(1, 0);
    Object.defineProperty(observation, 'authority', {
      get: () => {
        throw new Error('synthetic getter failure');
      },
    });
    expect(sampler().observe(observation).reason).toBe('malformed');
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
