import { describe, expect, it } from 'vitest';

import { axEventCanonicalDigest } from '../event/util.js';
import {
  axDefaultTrajectorySpillPolicy,
  axResolveTrajectoryStep,
  axResolveTrajectorySteps,
  axSpillTrajectoryFields,
} from './spill.js';
import {
  AxTrajectoryBlobError,
  type AxTrajectoryBlobPutRequest,
  type AxTrajectoryBlobStore,
  type AxTrajectoryStep,
} from './types.js';
import { axTrajectoryUtf8ByteLength } from './util.js';

/**
 * A counting blob store. Local to this file on purpose: the batch prepass can
 * only be proved by an implementation that records every get.
 */
class SpyBlobStore implements AxTrajectoryBlobStore {
  readonly gets: string[] = [];
  readonly puts: string[] = [];
  private readonly values = new Map<string, string>();

  async put(request: Readonly<AxTrajectoryBlobPutRequest>) {
    const digest = await axEventCanonicalDigest(request.value);
    const ref = `blob-${digest.slice(0, 16)}`;
    this.puts.push(request.field);
    this.values.set(ref, request.value);
    return {
      ref,
      bytes: axTrajectoryUtf8ByteLength(request.value),
      digest,
    };
  }

  async get(ref: string, digest: string): Promise<string> {
    this.gets.push(ref);
    const value = this.values.get(ref);
    if (value === undefined) {
      throw new AxTrajectoryBlobError('blob missing', 'missing', ref, digest);
    }
    const actual = await axEventCanonicalDigest(value);
    if (actual !== digest) {
      throw new AxTrajectoryBlobError(
        'blob digest mismatch',
        'digest_mismatch',
        ref,
        digest
      );
    }
    return value;
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }

  /** Replace the stored bytes without touching the ref, i.e. bit rot. */
  corrupt(ref: string, value: string): void {
    this.values.set(ref, value);
  }
}

function step(
  overrides: Partial<AxTrajectoryStep> = {}
): Readonly<AxTrajectoryStep> {
  return {
    stepId: 'step-1',
    trajectoryId: 'traj-1',
    seq: 1,
    type: 'action',
    ts: 1_000,
    data: {},
    ...overrides,
  };
}

const BIG = 'x'.repeat(8_000);

describe('axSpillTrajectoryFields', () => {
  it('spills any string field above the limit, not just declared ones', async () => {
    const blobs = new SpyBlobStore();
    const result = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      // `stdout` is declared by the registry; `notes` is not. Generic spill is
      // the whole point: an allowlist is how a log reaches hundreds of MiB.
      data: { stdout: BIG, notes: BIG, tiny: 'ok', count: 12 },
      blobs,
      spillFields: ['stdout'],
    });

    expect(result.spilled.sort()).toEqual(['notes', 'stdout']);
    expect(result.blobs).toHaveLength(2);
    expect(result.data.tiny).toBe('ok');
    expect(result.data.count).toBe(12);
  });

  it('spills only declared fields when genericSpill is disabled', async () => {
    const blobs = new SpyBlobStore();
    const result = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { stdout: BIG, notes: BIG },
      blobs,
      policy: { spillBytes: 4_096, genericSpill: false },
      spillFields: ['stdout'],
    });

    expect(result.spilled).toEqual(['stdout']);
    expect(result.data.notes).toBe(BIG);
  });

  it('keeps a UTF-8-safe inline head and records full bytes', async () => {
    const blobs = new SpyBlobStore();
    // A 3-byte code point straddling the inline boundary would decode to
    // U+FFFD if the head were sliced by byte count alone.
    const value = '☃'.repeat(4_000);
    const result = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { content: value },
      blobs,
      policy: { spillBytes: 1_000, inlineBytes: 100 },
    });

    const ref = result.blobs[0]!;
    const head = result.data.content as string;
    expect(head).not.toContain('�');
    expect(ref.inlineBytes).toBeLessThanOrEqual(100);
    expect(ref.inlineBytes).toBe(axTrajectoryUtf8ByteLength(head));
    expect(ref.bytes).toBe(axTrajectoryUtf8ByteLength(value));
    expect(ref.truncated).toBe(true);
    expect(ref.field).toBe('content');
    // The head is a prefix of the original, never a re-encoding of it.
    expect(value.startsWith(head)).toBe(true);
  });

  it('is a no-op without a blob store', async () => {
    const result = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { content: BIG },
    });
    expect(result.spilled).toEqual([]);
    expect(result.data.content).toBe(BIG);
  });

  it('derives inlineBytes as a quarter of spillBytes by default', () => {
    expect(axDefaultTrajectorySpillPolicy.spillBytes).toBe(4_096);
    expect(axDefaultTrajectorySpillPolicy.genericSpill).toBe(true);
  });
});

describe('axResolveTrajectoryStep', () => {
  it('rehydrates every spilled field and verifies the digest', async () => {
    const blobs = new SpyBlobStore();
    const spilled = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { stdout: BIG, stderr: `${BIG}!`, tiny: 'ok' },
      blobs,
    });
    const stored = step({ data: spilled.data, blobs: spilled.blobs });

    // Pre-condition: an unresolved read really is truncated.
    expect((stored.data.stdout as string).length).toBeLessThan(BIG.length);

    const resolved = await axResolveTrajectoryStep(stored, blobs);
    expect(resolved.data.stdout).toBe(BIG);
    expect(resolved.data.stderr).toBe(`${BIG}!`);
    expect(resolved.data.tiny).toBe('ok');
    expect(resolved.blobs).toBeUndefined();
    expect(blobs.gets).toHaveLength(2);

    // Idempotent: re-resolving a resolved step fetches nothing.
    const again = await axResolveTrajectoryStep(resolved, blobs);
    expect(again.data.stdout).toBe(BIG);
    expect(blobs.gets).toHaveLength(2);
  });

  it('resolves only the requested fields and keeps the rest referenced', async () => {
    const blobs = new SpyBlobStore();
    const spilled = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { stdout: BIG, stderr: `${BIG}!` },
      blobs,
    });
    const resolved = await axResolveTrajectoryStep(
      step({ data: spilled.data, blobs: spilled.blobs }),
      blobs,
      { fields: ['stdout'] }
    );

    expect(resolved.data.stdout).toBe(BIG);
    expect(resolved.blobs).toHaveLength(1);
    expect(resolved.blobs?.[0]?.field).toBe('stderr');
    expect(blobs.gets).toHaveLength(1);
  });

  it("throws AxTrajectoryBlobError('digest_mismatch') on corruption", async () => {
    const blobs = new SpyBlobStore();
    const spilled = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { content: BIG },
      blobs,
    });
    blobs.corrupt(spilled.blobs[0]!.ref, 'tampered');

    await expect(
      axResolveTrajectoryStep(
        step({ data: spilled.data, blobs: spilled.blobs }),
        blobs
      )
    ).rejects.toMatchObject({
      name: 'AxTrajectoryBlobError',
      code: 'trajectory_blob_failed',
      reason: 'digest_mismatch',
    });
  });

  it("throws AxTrajectoryBlobError('missing') for a deleted blob", async () => {
    const blobs = new SpyBlobStore();
    const spilled = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { content: BIG },
      blobs,
    });
    await blobs.delete(spilled.blobs[0]!.ref);

    await expect(
      axResolveTrajectoryStep(
        step({ data: spilled.data, blobs: spilled.blobs }),
        blobs
      )
    ).rejects.toMatchObject({ reason: 'missing' });
  });

  it("throws AxTrajectoryBlobError('missing') when no blob store is available", async () => {
    const blobs = new SpyBlobStore();
    const spilled = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { content: BIG },
      blobs,
    });

    await expect(
      axResolveTrajectoryStep(
        step({ data: spilled.data, blobs: spilled.blobs }),
        undefined
      )
    ).rejects.toBeInstanceOf(AxTrajectoryBlobError);
  });

  it('leaves an unspilled step untouched and fetches nothing', async () => {
    const blobs = new SpyBlobStore();
    const plain = step({ data: { content: 'small' } });
    const resolved = await axResolveTrajectoryStep(plain, blobs);
    expect(resolved).toBe(plain);
    expect(blobs.gets).toHaveLength(0);
  });
});

describe('axResolveTrajectorySteps', () => {
  it('fetches each distinct ref exactly once', async () => {
    const blobs = new SpyBlobStore();
    const shared = await axSpillTrajectoryFields({
      trajectoryId: 'traj-1',
      stepId: 'step-1',
      data: { content: BIG },
      blobs,
    });
    // Three steps citing the SAME content: a content-addressed store hands out
    // one ref, and the prepass must collapse them to one fetch.
    const steps = [1, 2, 3].map((seq) =>
      step({
        stepId: `step-${seq}`,
        seq,
        data: shared.data,
        blobs: shared.blobs,
      })
    );

    const resolved = await axResolveTrajectorySteps(steps, blobs);
    expect(resolved).toHaveLength(3);
    for (const one of resolved) expect(one.data.content).toBe(BIG);
    expect(blobs.gets).toEqual([shared.blobs[0]!.ref]);
  });
});
