/**
 * Volatile, single-writer reference implementation of `AxLearningStore`.
 *
 * It exists for tests, for local development, and as the executable definition
 * of the port's semantics: a durable host store is expected to reproduce the
 * behaviour asserted here and by `runAxLearningStoreConformance`, not to invent
 * its own.
 *
 * There is no delete path. `markConsumed` marks; the only thing that ever
 * removes a record is the `maxRecordsPerScenario` cap, which drops the oldest
 * un-referenced interaction, never a report, and counts every drop.
 */

import { type AxEventClock, AxSystemEventClock } from '../event/types.js';

import { axLearningRecordContent } from './records.js';
import {
  type AxLearningAppendResult,
  type AxLearningRecord,
  AxLearningRecordConflictError,
  type AxLearningRecordId,
  type AxLearningRelease,
  AxLearningReleaseConflictError,
  type AxLearningStore,
  type AxLearningStoreCapabilities,
  type AxLearningStorePage,
  type AxLearningStorePageEntry,
} from './types.js';

const DEFAULT_MAX_RECORDS_PER_SCENARIO = 10_000;
const DEFAULT_PAGE_LIMIT = 100;

export interface AxInMemoryLearningStoreOptions {
  readonly clock?: AxEventClock;
  /** Cap on stored records per scenario. Default 10,000. */
  readonly maxRecordsPerScenario?: number;
}

type StoredEntry = {
  sequence: number;
  record: AxLearningRecord;
};

type ScenarioState = {
  byId: Map<AxLearningRecordId, StoredEntry>;
  /** Insertion-ordered log; the cursor `page()` walks. */
  log: StoredEntry[];
  consumed: Set<AxLearningRecordId>;
  /** How many stored reports name each interaction id. */
  references: Map<AxLearningRecordId, number>;
  sequence: number;
  releases: AxLearningRelease[];
  headReleaseId: string | undefined;
};

function emptyScenario(): ScenarioState {
  return {
    byId: new Map(),
    log: [],
    consumed: new Set(),
    references: new Map(),
    sequence: 0,
    releases: [],
    headReleaseId: undefined,
  };
}

export class AxInMemoryLearningStore implements AxLearningStore {
  readonly capabilities: Readonly<AxLearningStoreCapabilities> = Object.freeze({
    durability: 'volatile' as const,
    coordination: 'single-writer' as const,
    compareAndSet: true,
    conformance: Object.freeze({ schemaVersion: 1 }),
  });

  readonly clock: AxEventClock;

  private readonly scenarios = new Map<string, ScenarioState>();
  private readonly maxRecordsPerScenario: number;
  private dropped = 0;
  private closed = false;

  constructor(options?: Readonly<AxInMemoryLearningStoreOptions>) {
    this.clock = options?.clock ?? new AxSystemEventClock();
    const max =
      options?.maxRecordsPerScenario ?? DEFAULT_MAX_RECORDS_PER_SCENARIO;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error(
        'AxInMemoryLearningStore: maxRecordsPerScenario must be a positive safe integer'
      );
    }
    this.maxRecordsPerScenario = max;
  }

  /** How many records the cap has evicted since construction. */
  get droppedRecords(): number {
    return this.dropped;
  }

  append(
    record: AxLearningRecord,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningAppendResult>> {
    return this.settle(() => this.appendNow(record), signal);
  }

  get(
    scenario: string,
    id: AxLearningRecordId,
    signal?: AbortSignal
  ): Promise<AxLearningRecord | undefined> {
    return this.settle(
      () => this.scenario(scenario).byId.get(id)?.record,
      signal
    );
  }

  page(
    scenario: string,
    options: Readonly<{ afterSequence?: number; limit?: number }>,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningStorePage>> {
    return this.settle(() => this.pageNow(scenario, options), signal);
  }

  markConsumed(
    scenario: string,
    ids: readonly AxLearningRecordId[],
    signal?: AbortSignal
  ): Promise<void> {
    return this.settle(() => {
      const state = this.scenario(scenario);
      for (const id of ids) state.consumed.add(id);
    }, signal);
  }

  putRelease(
    release: Readonly<AxLearningRelease>,
    expectedTailReleaseId: string | null,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>> {
    return this.settle(
      () => this.putReleaseNow(release, expectedTailReleaseId),
      signal
    );
  }

  promoteRelease(
    scenario: string,
    releaseId: string,
    expectedHeadReleaseId: string | null,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>> {
    return this.settle(
      () => this.promoteReleaseNow(scenario, releaseId, expectedHeadReleaseId),
      signal
    );
  }

  head(
    scenario: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease> | undefined> {
    return this.settle(() => {
      const state = this.scenario(scenario);
      return state.releases.find(
        (release) => release.releaseId === state.headReleaseId
      );
    }, signal);
  }

  releases(
    scenario: string,
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxLearningRelease>[]> {
    return this.settle(() => [...this.scenario(scenario).releases], signal);
  }

  async close(_options?: Readonly<{ timeoutMs?: number }>): Promise<void> {
    // Idempotent: a host that closes twice during shutdown is not an error.
    this.closed = true;
    this.scenarios.clear();
  }

  // -------------------------------------------------------------------------

  /**
   * Run `compute` on a microtask so a caller's abort can genuinely interleave,
   * and remove the abort listener however the call settles.
   *
   * A worker loop reuses one long-lived signal across thousands of calls, so a
   * listener left behind per call is a leak; `memoryStore.test.ts` asserts the
   * listener count is zero after both the resolved and the aborted path.
   */
  private settle<T>(compute: () => T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (emit: () => void): void => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        emit();
      };
      const onAbort = (): void => finish(() => reject(signal?.reason));
      signal?.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        // An abort that won the race must leave the store untouched, so the
        // mutation is not even attempted once the call has settled.
        if (settled) return;
        try {
          const value = compute();
          finish(() => resolve(value));
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
  }

  private scenario(scenario: string): ScenarioState {
    if (this.closed) {
      throw new Error('AxInMemoryLearningStore: store is closed');
    }
    if (typeof scenario !== 'string' || scenario.length === 0) {
      throw new Error(
        'AxInMemoryLearningStore: scenario must be a non-empty string'
      );
    }
    const existing = this.scenarios.get(scenario);
    if (existing) return existing;
    const created = emptyScenario();
    this.scenarios.set(scenario, created);
    return created;
  }

  private appendNow(
    record: AxLearningRecord
  ): Readonly<AxLearningAppendResult> {
    const state = this.scenario(record.scenario);

    // A consumed id can never train again, so a late resend of it is a
    // deliberate no-op rather than a conflict.
    const stored = state.byId.get(record.id);
    if (state.consumed.has(record.id)) {
      return Object.freeze({
        record: stored?.record ?? record,
        inserted: false,
        reason: 'duplicate' as const,
      });
    }

    if (stored) {
      if (
        axLearningRecordContent(stored.record) ===
        axLearningRecordContent(record)
      ) {
        return Object.freeze({
          record: stored.record,
          inserted: false,
          reason: 'duplicate' as const,
        });
      }
      throw new AxLearningRecordConflictError(record.id, record.scenario);
    }

    // "Accepted and ignored": grading an exchange that has already trained
    // changes nothing, so the report is not stored, but its own id is marked so
    // a retry of the same report is equally cheap.
    if (
      record.kind === 'report' &&
      record.references.length > 0 &&
      record.references.every((reference) => state.consumed.has(reference))
    ) {
      state.consumed.add(record.id);
      return Object.freeze({
        record,
        inserted: false,
        reason: 'references-consumed' as const,
      });
    }

    const sequence = ++state.sequence;
    const entry: StoredEntry = { sequence, record };
    state.byId.set(record.id, entry);
    state.log.push(entry);
    if (record.kind === 'report') {
      for (const reference of record.references) {
        state.references.set(
          reference,
          (state.references.get(reference) ?? 0) + 1
        );
      }
    }
    this.evict(state);
    return Object.freeze({ record, inserted: true, sequence });
  }

  /**
   * Drop the oldest un-referenced interaction until the scenario is under its
   * cap. A report is never dropped, and neither is an interaction a stored
   * report still names — losing either would make an already-graded exchange
   * unresolvable. When nothing is droppable the cap is exceeded rather than an
   * invariant broken.
   */
  private evict(state: ScenarioState): void {
    while (state.log.length > this.maxRecordsPerScenario) {
      const index = state.log.findIndex(
        (entry) =>
          entry.record.kind === 'interaction' &&
          (state.references.get(entry.record.id) ?? 0) === 0
      );
      if (index < 0) return;
      const [victim] = state.log.splice(index, 1);
      if (!victim) return;
      state.byId.delete(victim.record.id);
      this.dropped++;
    }
  }

  private pageNow(
    scenario: string,
    options: Readonly<{ afterSequence?: number; limit?: number }>
  ): Readonly<AxLearningStorePage> {
    const state = this.scenario(scenario);
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(
        'AxInMemoryLearningStore: page limit must be a positive safe integer'
      );
    }
    const available = state.log.filter((entry) => entry.sequence > after);
    const page = available.slice(0, limit);
    const entries: readonly Readonly<AxLearningStorePageEntry>[] = page.map(
      (entry) =>
        Object.freeze({ sequence: entry.sequence, record: entry.record })
    );
    const last = page.at(-1);
    return Object.freeze({
      entries,
      ...(last && available.length > page.length
        ? { nextAfterSequence: last.sequence }
        : {}),
    });
  }

  private putReleaseNow(
    release: Readonly<AxLearningRelease>,
    expectedTailReleaseId: string | null
  ): Readonly<AxLearningRelease> {
    const state = this.scenario(release.scenario);
    if (
      typeof release.releaseId !== 'string' ||
      release.releaseId.length === 0
    ) {
      throw new Error(
        'AxInMemoryLearningStore: releaseId must be a non-empty string'
      );
    }
    const tail = state.releases.at(-1);
    const tailId = tail?.releaseId ?? null;
    if (tailId !== expectedTailReleaseId) {
      throw new AxLearningReleaseConflictError(
        release.scenario,
        'append',
        expectedTailReleaseId,
        tailId
      );
    }
    if (
      state.releases.some(
        (existing) => existing.releaseId === release.releaseId
      )
    ) {
      throw new Error(
        `AxInMemoryLearningStore: release ${release.releaseId} already exists`
      );
    }
    if (tail && release.step <= tail.step) {
      throw new Error(
        `AxInMemoryLearningStore: release step must increase (${tail.step} → ${release.step})`
      );
    }
    // An append is a nomination. Only promoteRelease moves the head, so the
    // stored row is always written non-current whatever the caller passed, and
    // it carries no promotion timestamp.
    const { promotedAt: _unpromoted, ...rest } = release;
    const appended: AxLearningRelease = Object.freeze({
      ...rest,
      current: false,
    });
    state.releases.push(appended);
    return appended;
  }

  private promoteReleaseNow(
    scenario: string,
    releaseId: string,
    expectedHeadReleaseId: string | null
  ): Readonly<AxLearningRelease> {
    const state = this.scenario(scenario);
    const headId = state.headReleaseId ?? null;
    if (headId !== expectedHeadReleaseId) {
      throw new AxLearningReleaseConflictError(
        scenario,
        'promote',
        expectedHeadReleaseId,
        headId
      );
    }
    const index = state.releases.findIndex(
      (release) => release.releaseId === releaseId
    );
    if (index < 0) {
      throw new Error(
        `AxInMemoryLearningStore: release ${releaseId} is not in scenario ${scenario}`
      );
    }
    const promotedAt = this.clock.now();
    state.releases = state.releases.map((release, position) =>
      Object.freeze({
        ...release,
        current: position === index,
        ...(position === index ? { promotedAt } : {}),
      })
    );
    state.headReleaseId = releaseId;
    const promoted = state.releases[index];
    if (!promoted) {
      throw new Error(
        `AxInMemoryLearningStore: release ${releaseId} vanished during promotion`
      );
    }
    return promoted;
  }
}

/** Factory for the volatile reference store. */
export const axInMemoryLearningStore = (
  options?: Readonly<AxInMemoryLearningStoreOptions>
): AxInMemoryLearningStore => new AxInMemoryLearningStore(options);
