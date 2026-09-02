import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { AxManualEventClock } from '../event/types.js';

import {
  AxInMemoryLearningStore,
  axInMemoryLearningStore,
} from './memoryStore.js';
import {
  axCreateLearningInteractionRecord,
  axCreateLearningReportRecord,
} from './records.js';
import type { AxHarnessTree, AxLearningRelease } from './types.js';
import {
  AxLearningRecordConflictError,
  AxLearningReleaseConflictError,
  axIsLearningReleaseConflictError,
} from './types.js';

const NOW = 1_700_000_000_000;
const SCENARIO = 'support-triage';

function interaction(id: string, output: unknown = { answer: id }) {
  return axCreateLearningInteractionRecord({
    id,
    scenario: SCENARIO,
    createdAt: NOW,
    signature: 'question:string -> answer:string',
    programId: 'prog-1',
    input: { question: id },
    output: output as never,
  });
}

function report(id: string, references: readonly string[], score = 1) {
  return axCreateLearningReportRecord({
    id,
    scenario: SCENARIO,
    createdAt: NOW,
    input: { references, score },
  });
}

const TREE: AxHarnessTree = [
  {
    id: 'tone',
    kind: 'instruction',
    config: { text: 'Answer briefly.' },
  },
];

function release(
  releaseId: string,
  step: number,
  override: Partial<AxLearningRelease> = {}
): AxLearningRelease {
  return {
    releaseId,
    scenario: SCENARIO,
    contentId: `sha256:${releaseId}`,
    step,
    operation: 'evolve',
    current: false,
    restorable: true,
    recordedAt: NOW + step,
    entries: TREE,
    ...override,
  };
}

describe('AxInMemoryLearningStore records', () => {
  it('assigns a strictly increasing sequence per scenario', async () => {
    const store = axInMemoryLearningStore({ clock: new AxManualEventClock() });
    const first = await store.append(interaction('a'));
    const second = await store.append(interaction('b'));
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.inserted && second.inserted).toBe(true);
  });

  it('dedupes an identical resend by id and reports duplicate', async () => {
    const store = new AxInMemoryLearningStore();
    const original = await store.append(interaction('a'));
    // A retried append with a later clock is the same observation: the content
    // comparison excludes createdAt precisely so at-least-once callers can retry.
    const resent = axCreateLearningInteractionRecord({
      id: 'a',
      scenario: SCENARIO,
      createdAt: NOW + 60_000,
      signature: 'question:string -> answer:string',
      programId: 'prog-1',
      input: { question: 'a' },
      output: { answer: 'a' },
    });
    const again = await store.append(resent);
    expect(again.inserted).toBe(false);
    expect(again.reason).toBe('duplicate');
    expect(again.sequence).toBeUndefined();
    // The PREVIOUSLY stored record is authoritative, not the resend.
    expect(again.record).toBe(original.record);
    expect(again.record.createdAt).toBe(NOW);
  });

  it('raises AxLearningRecordConflictError on same id with different content', async () => {
    const store = new AxInMemoryLearningStore();
    await store.append(interaction('a'));
    await expect(
      store.append(interaction('a', { answer: 'rewritten' }))
    ).rejects.toBeInstanceOf(AxLearningRecordConflictError);
    // The stored record is untouched by the refused write.
    const stored = await store.get(SCENARIO, 'a');
    expect(stored).toEqual(interaction('a'));
  });

  it('accepts and ignores a report whose references were consumed', async () => {
    const store = new AxInMemoryLearningStore();
    await store.append(interaction('a'));
    await store.markConsumed(SCENARIO, ['a']);

    const submitted = report('grade-1', ['a']);
    const result = await store.append(submitted);
    expect(result.inserted).toBe(false);
    expect(result.reason).toBe('references-consumed');
    // The SUBMITTED record comes back — it was never stored.
    expect(result.record).toBe(submitted);
    expect(await store.get(SCENARIO, 'grade-1')).toBeUndefined();

    // The report's own id is now consumed, so a retry is equally cheap.
    const retry = await store.append(submitted);
    expect(retry.reason).toBe('duplicate');
  });

  it('treats a consumed interaction id as a silent no-op, not a conflict', async () => {
    const store = new AxInMemoryLearningStore();
    await store.append(interaction('a'));
    await store.markConsumed(SCENARIO, ['a']);
    const again = await store.append(interaction('a', { answer: 'other' }));
    expect(again.inserted).toBe(false);
    expect(again.reason).toBe('duplicate');
  });

  it('stores a report with zero references rather than consuming it', async () => {
    // `every` over an empty list is vacuously true; consuming such a report
    // would hide malformed feedback the reducer must count instead.
    const store = new AxInMemoryLearningStore();
    const result = await store.append(report('grade-1', []));
    expect(result.inserted).toBe(true);
    expect(await store.get(SCENARIO, 'grade-1')).toBeDefined();
  });

  it('keeps scenarios isolated', async () => {
    const store = new AxInMemoryLearningStore();
    await store.append(interaction('a'));
    await store.append({ ...interaction('a'), scenario: 'other' });
    expect(await store.get('other', 'a')).toBeDefined();
    const page = await store.page('other', {});
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.sequence).toBe(1);
  });
});

describe('AxInMemoryLearningStore growth', () => {
  it('evicts the oldest un-referenced interaction and counts the drop', async () => {
    const store = new AxInMemoryLearningStore({ maxRecordsPerScenario: 3 });
    for (const id of ['a', 'b', 'c']) await store.append(interaction(id));
    expect(store.droppedRecords).toBe(0);

    await store.append(interaction('d'));
    expect(store.droppedRecords).toBe(1);
    expect(await store.get(SCENARIO, 'a')).toBeUndefined();
    expect(await store.get(SCENARIO, 'b')).toBeDefined();
    expect(await store.get(SCENARIO, 'd')).toBeDefined();
  });

  it('never evicts a report or a live-referenced interaction', async () => {
    const store = new AxInMemoryLearningStore({ maxRecordsPerScenario: 3 });
    await store.append(interaction('a'));
    await store.append(report('grade-a', ['a'])); // protects 'a'
    await store.append(interaction('b'));
    await store.append(interaction('c'));

    // 'b' is the oldest droppable record; 'a' is protected by a live report.
    expect(store.droppedRecords).toBe(1);
    expect(await store.get(SCENARIO, 'a')).toBeDefined();
    expect(await store.get(SCENARIO, 'grade-a')).toBeDefined();
    expect(await store.get(SCENARIO, 'b')).toBeUndefined();
  });

  it('exceeds the cap rather than dropping a protected record', async () => {
    const store = new AxInMemoryLearningStore({ maxRecordsPerScenario: 1 });
    await store.append(interaction('a'));
    await store.append(report('grade-a', ['a']));
    await store.append(report('grade-a2', ['a']));
    // Nothing is droppable, so the cap yields instead of the invariant.
    expect(store.droppedRecords).toBe(0);
    expect(await store.get(SCENARIO, 'a')).toBeDefined();
    expect(await store.get(SCENARIO, 'grade-a2')).toBeDefined();
  });
});

describe('AxInMemoryLearningStore.page', () => {
  it('is a pure cursor and keeps no per-consumer state', async () => {
    const store = new AxInMemoryLearningStore();
    for (const id of ['a', 'b', 'c', 'd']) await store.append(interaction(id));

    const first = await store.page(SCENARIO, { limit: 2 });
    expect(first.entries.map((entry) => entry.record.id)).toEqual(['a', 'b']);
    expect(first.nextAfterSequence).toBe(2);

    // Reading the same cursor twice returns the same page: the store owns no
    // consumer position.
    const firstAgain = await store.page(SCENARIO, { limit: 2 });
    expect(firstAgain).toEqual(first);

    const second = await store.page(SCENARIO, {
      afterSequence: first.nextAfterSequence,
      limit: 2,
    });
    expect(second.entries.map((entry) => entry.record.id)).toEqual(['c', 'd']);
    expect(second.nextAfterSequence).toBeUndefined();

    const beyond = await store.page(SCENARIO, { afterSequence: 4 });
    expect(beyond.entries).toEqual([]);
    expect(beyond.nextAfterSequence).toBeUndefined();
  });

  it('rejects a non-positive limit', async () => {
    const store = new AxInMemoryLearningStore();
    await expect(store.page(SCENARIO, { limit: 0 })).rejects.toThrow(
      /positive safe integer/
    );
  });
});

describe('AxInMemoryLearningStore release chain', () => {
  it('appends by CAS on the tail and never sets current', async () => {
    const store = new AxInMemoryLearningStore({
      clock: new AxManualEventClock(NOW),
    });
    const first = await store.putRelease(
      release('rel-1', 1, { operation: 'creation', current: true }),
      null
    );
    expect(first.current).toBe(false);
    expect(await store.head(SCENARIO)).toBeUndefined();

    await store.putRelease(
      release('rel-2', 2, { parentReleaseId: 'rel-1' }),
      'rel-1'
    );
    const all = await store.releases(SCENARIO);
    expect(all.map((row) => row.releaseId)).toEqual(['rel-1', 'rel-2']);
  });

  it('putRelease with a stale expected tail throws and moves nothing', async () => {
    const store = new AxInMemoryLearningStore();
    await store.putRelease(release('rel-1', 1), null);
    let caught: unknown;
    try {
      await store.putRelease(release('rel-2', 2), null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxLearningReleaseConflictError);
    expect(axIsLearningReleaseConflictError(caught)).toBe(true);
    const conflict = caught as AxLearningReleaseConflictError;
    expect(conflict.operation).toBe('append');
    expect(conflict.expectedReleaseId).toBeNull();
    expect(conflict.actualReleaseId).toBe('rel-1');
    expect((await store.releases(SCENARIO)).map((r) => r.releaseId)).toEqual([
      'rel-1',
    ]);
  });

  it('refuses a rewound step', async () => {
    const store = new AxInMemoryLearningStore();
    await store.putRelease(release('rel-1', 5), null);
    await expect(
      store.putRelease(release('rel-2', 5), 'rel-1')
    ).rejects.toThrow(/step must increase/);
  });

  it('promotes by CAS on the head and keeps exactly one row current', async () => {
    const clock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock });
    await store.putRelease(
      release('rel-1', 1, { operation: 'creation' }),
      null
    );
    await store.putRelease(release('rel-2', 2), 'rel-1');

    clock.advanceBy(1_000);
    const promoted = await store.promoteRelease(SCENARIO, 'rel-1', null);
    expect(promoted.current).toBe(true);
    expect(promoted.promotedAt).toBe(NOW + 1_000);
    expect((await store.head(SCENARIO))?.releaseId).toBe('rel-1');

    await store.promoteRelease(SCENARIO, 'rel-2', 'rel-1');
    const all = await store.releases(SCENARIO);
    expect(
      all.filter((row) => row.current).map((row) => row.releaseId)
    ).toEqual(['rel-2']);
  });

  it('promoteRelease with a stale expected head throws and the head is unchanged', async () => {
    const store = new AxInMemoryLearningStore();
    await store.putRelease(release('rel-1', 1), null);
    await store.putRelease(release('rel-2', 2), 'rel-1');
    await store.promoteRelease(SCENARIO, 'rel-1', null);

    let caught: unknown;
    try {
      await store.promoteRelease(SCENARIO, 'rel-2', null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxLearningReleaseConflictError);
    expect((caught as AxLearningReleaseConflictError).operation).toBe(
      'promote'
    );
    expect((caught as AxLearningReleaseConflictError).actualReleaseId).toBe(
      'rel-1'
    );
    expect((await store.head(SCENARIO))?.releaseId).toBe('rel-1');
  });

  it('refuses to promote a release that is not in the chain', async () => {
    const store = new AxInMemoryLearningStore();
    await store.putRelease(release('rel-1', 1), null);
    await expect(
      store.promoteRelease(SCENARIO, 'rel-missing', null)
    ).rejects.toThrow(/not in scenario/);
  });

  it('refuses a duplicate releaseId', async () => {
    const store = new AxInMemoryLearningStore();
    await store.putRelease(release('rel-1', 1), null);
    await expect(
      store.putRelease(release('rel-1', 2), 'rel-1')
    ).rejects.toThrow(/already exists/);
  });
});

describe('AxInMemoryLearningStore abort hygiene', () => {
  it('does not leak abort listeners across 25 resolved appends', async () => {
    // Mirror a worker loop: one long-lived signal reused across many calls.
    // A listener left behind per call is a leak that grows without bound.
    const store = new AxInMemoryLearningStore();
    const controller = new AbortController();
    const { signal } = controller;
    for (let i = 0; i < 25; i++) {
      await store.append(interaction(`rec-${i}`), signal);
    }
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('removes the abort listener when the signal aborts mid-append', async () => {
    const store = new AxInMemoryLearningStore();
    const controller = new AbortController();
    const { signal } = controller;

    const pending = store.append(interaction('a'), signal);
    const reason = new Error('shutting down');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(getEventListeners(signal, 'abort').length).toBe(0);
    // An aborted append writes nothing.
    expect(await store.get(SCENARIO, 'a')).toBeUndefined();
  });

  it('rejects immediately on an already-aborted signal without listening', async () => {
    const store = new AxInMemoryLearningStore();
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    await expect(store.page(SCENARIO, {}, controller.signal)).rejects.toBe(
      reason
    );
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  });

  it('cleans up on every read and release method', async () => {
    const store = new AxInMemoryLearningStore();
    const controller = new AbortController();
    const { signal } = controller;
    await store.append(interaction('a'), signal);
    await store.get(SCENARIO, 'a', signal);
    await store.page(SCENARIO, {}, signal);
    await store.markConsumed(SCENARIO, [], signal);
    await store.putRelease(release('rel-1', 1), null, signal);
    await store.promoteRelease(SCENARIO, 'rel-1', null, signal);
    await store.head(SCENARIO, signal);
    await store.releases(SCENARIO, signal);
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });
});

describe('AxInMemoryLearningStore lifecycle', () => {
  it('advertises volatile, single-writer, compare-and-set capabilities', () => {
    const store = new AxInMemoryLearningStore();
    expect(store.capabilities).toEqual({
      durability: 'volatile',
      coordination: 'single-writer',
      compareAndSet: true,
      conformance: { schemaVersion: 1 },
    });
  });

  it('rejects a nonsensical cap at construction', () => {
    expect(
      () => new AxInMemoryLearningStore({ maxRecordsPerScenario: 0 })
    ).toThrow(/positive safe integer/);
  });

  it('close is idempotent and refuses later use', async () => {
    const store = new AxInMemoryLearningStore();
    await store.append(interaction('a'));
    await store.close();
    await store.close({ timeoutMs: 10 });
    await expect(store.get(SCENARIO, 'a')).rejects.toThrow(/store is closed/);
  });
});

describe('AxInMemoryLearningStore consumed ids', () => {
  it('still recognises a consumed id after the record itself is evicted', async () => {
    const store = new AxInMemoryLearningStore({ maxRecordsPerScenario: 2 });
    await store.append(interaction('a'));
    await store.markConsumed(SCENARIO, ['a']);
    await store.append(interaction('b'));
    await store.append(interaction('c'));
    // 'a' is gone from the log, but the consumed set outlives it: that set is
    // the enforcement of I9, so it is unbounded by design (class doc).
    expect(store.droppedRecords).toBe(1);
    expect(await store.get(SCENARIO, 'a')).toBeUndefined();

    const resent = await store.append(interaction('a'));
    expect(resent.inserted).toBe(false);
    expect(resent.reason).toBe('duplicate');
    expect(await store.get(SCENARIO, 'a')).toBeUndefined();
  });
});
