import { describe, expect, it } from 'vitest';
import { canonicalDigest } from './canonical.js';
import { axIsAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import {
  captureSnapshot,
  snapshotStateOf,
  withRestoredArtifact,
} from './snapshots.js';

// ---------------------------------------------------------------------------
// The baseline/evolved snapshot state machine (RFC 7.1, phases 0 / 7 / 9)
// ---------------------------------------------------------------------------

type FakeState = {
  playbook: { bullets: string[] };
  artifact: { epoch: number };
};

function fakeHandle(initial: FakeState) {
  let state: FakeState = structuredClone(initial);
  const loads: FakeState[] = [];
  let failLoads = 0;
  /** Restores are silently partial: `load` writes something else entirely. */
  let partialLoad: FakeState | undefined;
  return {
    loads,
    getState: () => structuredClone(state) as any,
    load: (snapshot: any) => {
      loads.push(structuredClone(snapshot));
      if (failLoads > 0) {
        failLoads--;
        throw new Error('load exploded');
      }
      const corrupted = partialLoad;
      partialLoad = undefined;
      state = structuredClone(corrupted ?? snapshot);
    },
    mutate: (next: FakeState) => {
      state = structuredClone(next);
    },
    failNextLoads: (count: number) => {
      failLoads = count;
    },
    /** The NEXT load lands somewhere else entirely: a silent partial restore. */
    corruptNextLoad: (next: FakeState) => {
      partialLoad = next;
    },
    current: () => structuredClone(state),
  };
}

const BASELINE: FakeState = {
  playbook: { bullets: [] },
  artifact: { epoch: 0 },
};
const EVOLVED: FakeState = {
  playbook: { bullets: ['b1'] },
  artifact: { epoch: 1 },
};

describe('playbook evolve snapshot state machine', () => {
  it('captures a state without throwing when the handle cannot produce one', () => {
    expect(captureSnapshot(undefined)).toBeUndefined();
    expect(
      captureSnapshot({
        getState: () => {
          throw new Error('no state');
        },
      })
    ).toBeUndefined();
    const handle = fakeHandle(BASELINE);
    expect(captureSnapshot(handle)).toEqual(BASELINE);
  });

  it('runs the body on the restored baseline and returns to the evolved state', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);
    expect(baseline.digest).not.toBe(evolved.digest);

    let observedInsideBody: string | undefined;
    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        observedInsideBody = canonicalDigest(handle.getState());
        return 'arm-ran';
      },
    });

    expect(observedInsideBody).toBe(baseline.digest);
    expect(outcome.status).toBe('ran');
    expect(outcome.status === 'ran' && outcome.value).toBe('arm-ran');
    // The SEQUENCE matters: asserting only "the body saw the baseline" would
    // pass on an implementation that never puts the evolved state back.
    expect(handle.loads).toEqual([BASELINE, EVOLVED]);
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('returns to the evolved state even when the body throws', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    await expect(
      withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          throw new Error('arm blew up');
        },
      })
    ).rejects.toThrow('arm blew up');
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('leaves the evolved artifact intact and skips the body when the baseline restore throws', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    handle.failNextLoads(1);
    let bodyRan = false;
    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        bodyRan = true;
      },
    });

    expect(bodyRan).toBe(false);
    expect(outcome.status).toBe('restore_failed');
    expect(outcome.status === 'restore_failed' && outcome.reason).toContain(
      'load exploded'
    );
    // `load` is atomic from the caller's view, so the run continues with the
    // evolved artifact still live.
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('treats a digest mismatch as a restore failure and still returns to the evolved state', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    // A silent partial restore is the failure the digest assertion exists for:
    // every arm number would be meaningless while the run looked healthy.
    handle.corruptNextLoad({
      playbook: { bullets: ['leftover'] },
      artifact: { epoch: 9 },
    });
    let bodyRan = false;
    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        bodyRan = true;
      },
    });

    expect(bodyRan).toBe(false);
    expect(outcome.status).toBe('restore_failed');
    expect(outcome.status === 'restore_failed' && outcome.reason).toContain(
      'the restore was partial'
    );
    // The artifact WAS mutated by the partial load, so the return restore runs
    // before the failure is reported — leaving the evolved artifact live.
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('retries the evolved restore once before giving up', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        handle.failNextLoads(1);
        return 'ok';
      },
    });

    expect(outcome.status).toBe('ran');
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
    // baseline restore + failed evolved restore + successful retry
    expect(handle.loads).toHaveLength(3);
  });

  it('throws control_arm_failed naming both digests and carrying the evolved snapshot when the restore fails twice', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    let thrown: unknown;
    try {
      await withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          handle.failNextLoads(2);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(axIsAgentPlaybookEvolveError(thrown)).toBe(true);
    const error = thrown as any;
    expect(error.code).toBe('control_arm_failed');
    expect(error.phase).toBe('control_arm');
    expect(error.message).toContain('AxAgent.playbook().evolve(): ');
    // Both digests are named because the agent is left in an indeterminate
    // state relative to what the run reports.
    expect(error.message).toContain(baseline.digest);
    expect(error.message).toContain(evolved.digest);
    // A thrown run has no result, so the recovery snapshot rides on the error.
    expect(error.playbookSnapshot).toEqual(EVOLVED);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect((error.cause as AggregateError).errors).toHaveLength(2);
  });

  it('aggregates the body failure with the restore failures', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    let thrown: unknown;
    try {
      await withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          handle.failNextLoads(2);
          throw new Error('arm blew up');
        },
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as any;
    expect(error.code).toBe('control_arm_failed');
    expect((error.cause as AggregateError).errors).toHaveLength(3);
    expect(
      ((error.cause as AggregateError).errors[0] as Error).message
    ).toContain('arm blew up');
  });
});
