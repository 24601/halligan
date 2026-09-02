import { describe, expect, it } from 'vitest';

import { AxManualEventClock } from '../event/types.js';

import { runAxLearningStoreConformance } from './conformance.js';
import { AxInMemoryLearningStore } from './memoryStore.js';
import type {
  AxLearningAppendResult,
  AxLearningRecord,
  AxLearningRelease,
  AxLearningStore,
  AxLearningStorePage,
} from './types.js';

const NOW = 1_700_000_000_000;

describe('runAxLearningStoreConformance', () => {
  it('the in-memory store passes, with the cross-instance halves reported skipped', async () => {
    const report = await runAxLearningStoreConformance(
      () => new AxInMemoryLearningStore(),
      { clock: new AxManualEventClock(NOW) }
    );
    expect(report.capability.coordination).toBe('single-writer');
    expect(report.assertions).toBeGreaterThanOrEqual(16);
    // Skipped, not silently passed: a single-writer store cannot demonstrate
    // that two writers race for the tail and the head.
    expect(report.skipped).toEqual([
      'cross-instance putRelease CAS (store is single-writer)',
      'cross-instance promoteRelease CAS (store is single-writer)',
    ]);
  });

  it('closes the store it created', async () => {
    let created: AxInMemoryLearningStore | undefined;
    await runAxLearningStoreConformance(
      () => {
        created = new AxInMemoryLearningStore();
        return created;
      },
      { clock: new AxManualEventClock(NOW) }
    );
    await expect(created?.get('any', 'id')).rejects.toThrow(/store is closed/);
  });

  it('fails a store that overwrites a conflicting record instead of refusing', async () => {
    // The suite has to be one a hollow store cannot pass. This store is
    // last-write-wins, which is exactly the corruption the port forbids.
    class LastWriteWinsStore extends AxInMemoryLearningStore {
      override append(
        record: AxLearningRecord,
        signal?: AbortSignal
      ): Promise<Readonly<AxLearningAppendResult>> {
        return super
          .append(record, signal)
          .catch(() => Object.freeze({ record, inserted: true, sequence: 99 }));
      }
    }
    await expect(
      runAxLearningStoreConformance(() => new LastWriteWinsStore(), {
        clock: new AxManualEventClock(NOW),
      })
    ).rejects.toThrow(/expected rejection for same id with different content/);
  });

  it('fails a store whose append moves the chain head', async () => {
    // Publication is not promotion. A store that promotes on append hands the
    // model an automatic deploy, so the suite must catch it.
    class PromoteOnAppendStore extends AxInMemoryLearningStore {
      override async putRelease(
        release: Readonly<AxLearningRelease>,
        expectedTailReleaseId: string | null,
        signal?: AbortSignal
      ): Promise<Readonly<AxLearningRelease>> {
        const appended = await super.putRelease(
          release,
          expectedTailReleaseId,
          signal
        );
        return { ...appended, current: true };
      }
    }
    await expect(
      runAxLearningStoreConformance(() => new PromoteOnAppendStore(), {
        clock: new AxManualEventClock(NOW),
      })
    ).rejects.toThrow(/publication is not promotion/);
  });

  it('fails a store that reuses a sequence number', async () => {
    class FrozenSequenceStore extends AxInMemoryLearningStore {
      override async append(
        record: AxLearningRecord,
        signal?: AbortSignal
      ): Promise<Readonly<AxLearningAppendResult>> {
        const result = await super.append(record, signal);
        return result.inserted ? { ...result, sequence: 1 } : result;
      }
    }
    await expect(
      runAxLearningStoreConformance(() => new FrozenSequenceStore(), {
        clock: new AxManualEventClock(NOW),
      })
    ).rejects.toThrow(/sequence is strictly increasing/);
  });

  it('fails a store that keeps a report over already-consumed references', async () => {
    // "Accepted and ignored" is the whole reason a late grade for a trained
    // exchange is harmless. A store that keeps it would re-train on it.
    class KeepsConsumedReportsStore extends AxInMemoryLearningStore {
      override async append(
        record: AxLearningRecord,
        signal?: AbortSignal
      ): Promise<Readonly<AxLearningAppendResult>> {
        const result = await super.append(record, signal);
        return result.reason === 'references-consumed'
          ? { record, inserted: true, sequence: 98 }
          : result;
      }
    }
    await expect(
      runAxLearningStoreConformance(() => new KeepsConsumedReportsStore(), {
        clock: new AxManualEventClock(NOW),
      })
    ).rejects.toThrow(/accepted and ignored/);
  });

  it('fails a store whose page ignores the cursor', async () => {
    class IgnoresCursorStore extends AxInMemoryLearningStore {
      override page(
        scenario: string,
        _options: Readonly<{ afterSequence?: number; limit?: number }>,
        signal?: AbortSignal
      ): Promise<Readonly<AxLearningStorePage>> {
        return super.page(scenario, {}, signal);
      }
    }
    await expect(
      runAxLearningStoreConformance(() => new IgnoresCursorStore(), {
        clock: new AxManualEventClock(NOW),
      })
    ).rejects.toThrow(/page returns only records after the cursor/);
  });

  it('runs both cross-instance halves against a shared multi-writer backing', async () => {
    // One shared state, two facades that advertise multi-writer: the suite
    // must then exercise the CAS races rather than skip them.
    const shared = new Map<string, AxInMemoryLearningStore>();
    const factory = (options: { databaseKey: string }): AxLearningStore => {
      const backing =
        shared.get(options.databaseKey) ??
        shared
          .set(options.databaseKey, new AxInMemoryLearningStore())
          .get(options.databaseKey)!;
      return new Proxy(backing, {
        get(target, property, receiver) {
          if (property === 'capabilities') {
            return { ...target.capabilities, coordination: 'multi-writer' };
          }
          if (property === 'close') return undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as AxLearningStore;
    };

    const report = await runAxLearningStoreConformance(factory, {
      clock: new AxManualEventClock(NOW),
    });
    expect(report.skipped).toEqual([]);
    expect(report.capability.coordination).toBe('multi-writer');
  });
});
