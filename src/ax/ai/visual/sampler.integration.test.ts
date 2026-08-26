import { describe, expect, it } from 'vitest';
import { axFrameSampler } from './sampler.js';
import type { AxVisualObservation } from './types.js';

describe('host-driven visual observation integration', () => {
  it('keeps capture and payload forwarding under host control', async () => {
    const payloads = new Map<string, string>();
    const capture = async (
      revision: number,
      digest: string
    ): Promise<AxVisualObservation> => {
      const frameId = `synthetic-${revision}`;
      payloads.set(frameId, `host-owned-payload-${revision}`);
      return {
        sourceId: 'synthetic-source',
        streamId: 'synthetic-stream',
        frameId,
        revision,
        freshness: {
          capturedAtMs: revision * 250,
          observedAtMs: revision * 250,
          expiresAtMs: revision * 250 + 1_000,
        },
        dimensions: { width: 320, height: 180 },
        mediaType: 'image/webp',
        byteLength: 24,
        tokenEstimate: 8,
        authority: {
          authorityRef: 'host-authority',
          consentRef: 'host-consent',
          revision: 1,
        },
        digest: { algorithm: 'dhash-64', value: digest },
      };
    };

    const sampler = axFrameSampler({
      maxIntervalMs: 10_000,
      budget: { maxFrames: 10 },
    });
    const forwarded: string[] = [];
    for (const observation of [
      await capture(1, '0000000000000000'),
      await capture(2, '0000000000000000'),
      await capture(3, 'ffffffffffffffff'),
    ]) {
      const decision = sampler.observe(observation);
      if (decision.action !== 'suppress') {
        forwarded.push(payloads.get(observation.frameId)!);
      }
    }

    expect(forwarded).toEqual(['host-owned-payload-1', 'host-owned-payload-3']);
    expect(sampler).not.toHaveProperty('capture');
  });
});
