/**
 * The normative `AxLearningStore` contract, as an executable suite.
 *
 * Hosts may supply their own store (SQLite, Postgres, a hosted log), and the
 * loop's correctness depends on semantics no type can express: what a duplicate
 * id means, what happens to a report whose references already trained, and
 * whether the release chain really moves by compare-and-set. A store that has
 * not run this has not implemented the port.
 *
 * The suite reports what it SKIPPED rather than passing silently: a
 * single-writer store cannot demonstrate the cross-instance CAS assertions, so
 * those are named in `skipped` and their single-instance halves still run.
 */

import type { AxEventClock } from '../event/types.js';

import {
  axCreateLearningInteractionRecord,
  axCreateLearningReportRecord,
} from './records.js';
import {
  type AxHarnessTree,
  type AxLearningRelease,
  type AxLearningStore,
  type AxLearningStoreCapabilities,
  axIsLearningRecordConflictError,
  axIsLearningReleaseConflictError,
} from './types.js';

export interface AxLearningStoreConformanceFactoryOptions {
  /** Identifies the backing store. Two calls with the same key must address the same data. */
  databaseKey: string;
}

export type AxLearningStoreConformanceFactory = (
  options: Readonly<AxLearningStoreConformanceFactoryOptions>
) => AxLearningStore | Promise<AxLearningStore>;

export interface AxLearningStoreConformanceReport {
  assertions: number;
  /** Named assertions this store's capabilities put out of reach. */
  skipped: readonly string[];
  capability: Readonly<AxLearningStoreCapabilities>;
}

const CROSS_INSTANCE_APPEND =
  'cross-instance putRelease CAS (store is single-writer)';
const CROSS_INSTANCE_PROMOTE =
  'cross-instance promoteRelease CAS (store is single-writer)';

const TREE: AxHarnessTree = [
  { id: 'seed', kind: 'instruction', config: { text: 'Be brief.' } },
];

function release(
  scenario: string,
  releaseId: string,
  step: number,
  recordedAt: number
): AxLearningRelease {
  return {
    releaseId,
    scenario,
    contentId: `sha256:${releaseId}`,
    step,
    operation: step === 1 ? 'creation' : 'evolve',
    current: false,
    restorable: true,
    recordedAt,
    entries: TREE,
  };
}

/** Runs the normative Ax learning-store contract against a host implementation. */
export async function runAxLearningStoreConformance(
  createStore: AxLearningStoreConformanceFactory,
  options: Readonly<{ clock: AxEventClock & { advanceBy(ms: number): void } }>
): Promise<AxLearningStoreConformanceReport> {
  const { clock } = options;
  let assertions = 0;
  const skipped: string[] = [];
  const assert = (condition: unknown, message: string): void => {
    assertions++;
    if (!condition) {
      throw new Error(`AxLearningStore conformance: ${message}`);
    }
  };
  const expectReject = async (
    promise: Promise<unknown>,
    guard: (error: unknown) => boolean,
    label: string
  ): Promise<void> => {
    assertions++;
    let caught: unknown;
    let rejected = false;
    try {
      await promise;
    } catch (error) {
      rejected = true;
      caught = error;
    }
    if (!rejected) {
      throw new Error(
        `AxLearningStore conformance: expected rejection for ${label}`
      );
    }
    if (!guard(caught)) {
      throw new Error(
        `AxLearningStore conformance: wrong rejection for ${label} (got ${String(caught)})`
      );
    }
  };

  const databaseKey = `learn-conformance-${Math.random().toString(36).slice(2)}`;
  const store = await createStore({ databaseKey });
  const capability = store.capabilities;
  const multiWriter = capability.coordination === 'multi-writer';
  const peer = multiWriter ? await createStore({ databaseKey }) : undefined;
  const scenario = `${databaseKey}-scenario`;

  const interaction = (id: string, answer: string) =>
    axCreateLearningInteractionRecord({
      id,
      scenario,
      createdAt: clock.now(),
      signature: 'question:string -> answer:string',
      programId: 'conformance',
      input: { question: id },
      output: { answer },
    });

  try {
    // 1 — append is atomic and assigns a strictly increasing sequence.
    const first = await store.append(interaction('rec-1', 'one'));
    clock.advanceBy(1_000);
    const second = await store.append(interaction('rec-2', 'two'));
    assert(first.inserted && second.inserted, 'both appends insert');
    assert(
      typeof first.sequence === 'number' &&
        typeof second.sequence === 'number' &&
        second.sequence > first.sequence,
      'sequence is strictly increasing'
    );

    // 2 — a duplicate id with identical content dedupes, and the PREVIOUSLY
    // stored record is the authoritative one.
    clock.advanceBy(1_000);
    const resend = axCreateLearningInteractionRecord({
      id: 'rec-1',
      scenario,
      createdAt: clock.now(),
      signature: 'question:string -> answer:string',
      programId: 'conformance',
      input: { question: 'rec-1' },
      output: { answer: 'one' },
    });
    const deduped = await store.append(resend);
    assert(
      !deduped.inserted && deduped.reason === 'duplicate',
      'identical resend dedupes'
    );
    assert(
      deduped.record.createdAt === first.record.createdAt,
      'dedupe returns the previously stored record'
    );

    // 3 — a duplicate id with different content is a conflict, not an
    // overwrite: silently rewriting a graded exchange would corrupt the loop.
    await expectReject(
      store.append(interaction('rec-1', 'rewritten')),
      axIsLearningRecordConflictError,
      'same id with different content'
    );

    // 4 — a report referencing a consumed id is accepted and ignored, and the
    // SUBMITTED record comes back because nothing was stored.
    await store.markConsumed(scenario, ['rec-2']);
    clock.advanceBy(1_000);
    const graded = axCreateLearningReportRecord({
      id: 'report-1',
      scenario,
      createdAt: clock.now(),
      input: { references: ['rec-2'], score: 1 },
    });
    const ignored = await store.append(graded);
    assert(
      !ignored.inserted && ignored.reason === 'references-consumed',
      'a report over consumed references is accepted and ignored'
    );
    assert(
      ignored.record.id === graded.id &&
        (await store.get(scenario, 'report-1')) === undefined,
      'the submitted record is returned and not stored'
    );

    // 5 — page is a pure cursor over the log.
    const page = await store.page(scenario, { afterSequence: first.sequence });
    assert(
      page.entries.every((entry) => entry.sequence > (first.sequence ?? 0)),
      'page returns only records after the cursor'
    );
    assert(
      page.entries.every(
        (entry, index) =>
          index === 0 ||
          entry.sequence > (page.entries[index - 1]?.sequence ?? 0)
      ),
      'page is ordered by sequence'
    );

    // 6 — chain appends move only by compare-and-set on the tail.
    const seed = release(scenario, 'rel-1', 1, clock.now());
    const appended = await store.putRelease(seed, null);
    assert(
      appended.current === false,
      'an appended release is never current — publication is not promotion'
    );
    await expectReject(
      store.putRelease(release(scenario, 'rel-2', 2, clock.now()), null),
      axIsLearningReleaseConflictError,
      'putRelease with a stale expected tail'
    );
    if (peer) {
      const winner = release(scenario, 'rel-2', 2, clock.now());
      await peer.putRelease(winner, 'rel-1');
      await expectReject(
        store.putRelease(release(scenario, 'rel-3', 3, clock.now()), 'rel-1'),
        axIsLearningReleaseConflictError,
        'cross-instance putRelease CAS'
      );
    } else {
      skipped.push(CROSS_INSTANCE_APPEND);
      await store.putRelease(
        release(scenario, 'rel-2', 2, clock.now()),
        'rel-1'
      );
    }

    // 7 — the head moves only by compare-and-set, and a loser changes nothing.
    clock.advanceBy(1_000);
    const promoted = await store.promoteRelease(scenario, 'rel-1', null);
    assert(promoted.current === true, 'a promoted release is current');
    await expectReject(
      store.promoteRelease(scenario, 'rel-2', null),
      axIsLearningReleaseConflictError,
      'promoteRelease with a stale expected head'
    );
    if (peer) {
      await expectReject(
        peer.promoteRelease(scenario, 'rel-2', null),
        axIsLearningReleaseConflictError,
        'cross-instance promoteRelease CAS'
      );
      assert(
        (await peer.head(scenario))?.releaseId === 'rel-1',
        'the head agrees across instances after a failed promotion'
      );
    } else {
      skipped.push(CROSS_INSTANCE_PROMOTE);
    }
    assert(
      (await store.head(scenario))?.releaseId === 'rel-1',
      'a failed promotion leaves the head where it was'
    );

    // 8 — the chain reads back as a decision log.
    const chain = await store.releases(scenario);
    assert(chain.length >= 2, 'releases() returns the whole chain');
    assert(
      chain.every(
        (row, index) => index === 0 || row.step > (chain[index - 1]?.step ?? 0)
      ),
      'releases() is oldest-first with a strictly increasing step'
    );
    assert(
      chain.filter((row) => row.current).length === 1,
      'exactly one release is current'
    );

    return { assertions, skipped, capability };
  } finally {
    await store.close?.();
    await peer?.close?.();
  }
}
