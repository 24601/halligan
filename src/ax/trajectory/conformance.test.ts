import { describe, expect, it } from 'vitest';

import { AxManualEventClock } from '../event/types.js';
import {
  type AxTrajectoryStoreConformanceInstance,
  runAxTrajectoryStoreConformance,
} from './conformance.js';
import { AxInMemoryTrajectoryStore } from './memoryStore.js';
import type {
  AxTrajectoryCursor,
  AxTrajectoryDrainBudget,
  AxTrajectoryDrainResult,
  AxTrajectoryTailQuery,
  AxTrajectoryTailResult,
} from './types.js';

/**
 * The kit's factory is called twice with the same databaseKey to prove a
 * cursor token survives a reopen, so the reference store must be memoized on
 * that key exactly the way a file-backed store shares a directory.
 */
function referenceFactory(clock: AxManualEventClock) {
  const stores = new Map<string, AxInMemoryTrajectoryStore>();
  return ({ databaseKey }: { databaseKey: string }) => {
    let store = stores.get(databaseKey);
    if (!store) {
      store = new AxInMemoryTrajectoryStore({ clock });
      stores.set(databaseKey, store);
    }
    const bound = store;
    return {
      store: bound,
      failNextBlobWrite: () => bound.failNextBlobWrite(),
      corruptTrailingFrame: (trajectoryId: string) =>
        bound.injectCorruptTrailingFrame(trajectoryId),
    } satisfies AxTrajectoryStoreConformanceInstance;
  };
}

/**
 * The exact contract size with both fault hooks provided. `jsonl.test.ts`
 * pins the same number and additionally asserts the two stores report the
 * same count, so a store that quietly skips part of the kit is visible.
 */
const CONFORMANCE_ASSERTIONS = 73;

describe('runAxTrajectoryStoreConformance', () => {
  it('passes against the in-memory reference store', async () => {
    const clock = new AxManualEventClock(1_000);
    const report = await runAxTrajectoryStoreConformance(
      referenceFactory(clock),
      { clock }
    );

    expect(report.assertions).toBe(CONFORMANCE_ASSERTIONS);
    expect(report.capability.durability).toBe('volatile');
    expect(report.capability.appendAtomicity).toBe(true);
    expect(report.capability.conformance?.schemaVersion).toBe(1);
  });

  it('rejects a store that ignores the read budget', async () => {
    const clock = new AxManualEventClock(1_000);
    const factory = referenceFactory(clock);

    // A store that always claims it reached the head is exactly the failure a
    // fixed-window reader has: it cannot tell "no more matches" from "budget
    // spent". The kit must catch it.
    await expect(
      runAxTrajectoryStoreConformance(
        (options) => {
          const instance = factory(options);
          const store = instance.store;
          const patched = Object.create(store) as typeof store & {
            tailBackward: typeof store.tailBackward;
          };
          patched.tailBackward = async (
            query: Readonly<AxTrajectoryTailQuery>,
            signal?: AbortSignal
          ): Promise<Readonly<AxTrajectoryTailResult>> => {
            const real = await store.tailBackward(query, signal);
            return { ...real, exhausted: true };
          };
          return { ...instance, store: patched };
        },
        { clock }
      )
    ).rejects.toThrow(/C-BOUND/);
  });

  it('rejects a store whose cursor does not resume', async () => {
    const clock = new AxManualEventClock(1_000);
    const factory = referenceFactory(clock);

    await expect(
      runAxTrajectoryStoreConformance(
        (options) => {
          const instance = factory(options);
          const store = instance.store;
          const patched = Object.create(store) as typeof store;
          patched.readFrom = (
            _cursor: Readonly<AxTrajectoryCursor> | undefined,
            trajectoryId: string,
            budget: Readonly<AxTrajectoryDrainBudget>,
            signal?: AbortSignal
          ): Promise<Readonly<AxTrajectoryDrainResult>> =>
            // Always restarts at the head: replays everything on every drain.
            store.readFrom(undefined, trajectoryId, budget, signal);
          return { ...instance, store: patched };
        },
        { clock }
      )
    ).rejects.toThrow(/C-CURSOR/);
  });

  it('rejects a store that lets a step survive a failed blob write', async () => {
    const clock = new AxManualEventClock(1_000);
    const factory = referenceFactory(clock);

    await expect(
      runAxTrajectoryStoreConformance(
        (options) => {
          const instance = factory(options);
          // Arming the fault but never applying it is precisely the I2
          // violation: the step becomes visible with no durable blob.
          return { ...instance, failNextBlobWrite: () => {} };
        },
        { clock }
      )
    ).rejects.toThrow(/C-ORDER/);
  });

  it('rejects a store that does not stamp a conformance schema version', async () => {
    const clock = new AxManualEventClock(1_000);
    const factory = referenceFactory(clock);

    await expect(
      runAxTrajectoryStoreConformance(
        (options) => {
          const instance = factory(options);
          const patched = Object.create(
            instance.store
          ) as typeof instance.store;
          Object.defineProperty(patched, 'capabilities', {
            value: {
              ...instance.store.capabilities,
              conformance: undefined,
            },
          });
          return { ...instance, store: patched };
        },
        { clock }
      )
    ).rejects.toThrow(/C-CAP/);
  });
});
