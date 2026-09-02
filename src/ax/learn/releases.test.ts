import { describe, expect, it } from 'vitest';
import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryLearningStore } from './memoryStore.js';
import { type AxLearningSurface, axLearningSurface } from './releases.js';
import { axHarnessContentId } from './tree.js';
import {
  AxHarnessAdmissionError,
  type AxHarnessEntry,
  type AxHarnessGateDecision,
  type AxHarnessTree,
  AxLearningReleaseConflictError,
  type AxLearningStore,
} from './types.js';

const NOW = 1_000;

const instruction = (id: string, text = 'Answer briefly.'): AxHarnessEntry => ({
  id,
  kind: 'instruction',
  config: { text },
});

const SEED: AxHarnessTree = [instruction('i1')];
const NEXT: AxHarnessTree = [instruction('i1', 'Answer in one sentence.')];

const GATE: Readonly<AxHarnessGateDecision> = Object.freeze({
  outcome: 'select',
  evaluator: 'harness_task_pairs',
  evaluatorVersion: '1',
  policy: 'axPlaybookGate',
  policyVersion: '1',
  reason: 'held-in improved, held-out non-regressing',
  metrics: Object.freeze({
    candidateScores: [1],
    currentScores: [0.5],
    candidateScore: 1,
    currentScore: 0.5,
    wins: 1,
    losses: 0,
    ties: 0,
    heldIn: { before: 0.5, after: 1 },
    taskSetDigest: 'digest',
    failures: { new: [], persisting: [], fixed: [] },
    episodeFailures: 0,
  }),
});

function makeIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

async function makeSurface(
  overrides: Readonly<Record<string, unknown>> = {}
): Promise<{
  surface: AxLearningSurface;
  store: AxInMemoryLearningStore;
  clock: AxManualEventClock;
}> {
  const clock = new AxManualEventClock(NOW);
  const store = new AxInMemoryLearningStore({ clock });
  const surface = await axLearningSurface({
    scenario: 'support',
    store,
    clock,
    seed: SEED,
    idFactory: makeIds('rel'),
    ...overrides,
  });
  return { surface, store, clock };
}

// ---------------------------------------------------------------------------

describe('AxLearningSurface — seeding', () => {
  it('publishes and promotes the creation release when the chain is empty', async () => {
    const { surface } = await makeSurface();
    const chain = await surface.releases();
    expect(chain).toHaveLength(1);
    expect(chain[0]?.operation).toBe('creation');
    expect(chain[0]?.current).toBe(true);
    expect(chain[0]?.step).toBe(1);
    expect(chain[0]?.gate).toBeUndefined();
    const head = await surface.currentTree();
    expect(head?.releaseId).toBe('rel-1');
    expect(head?.contentId).toBe(await axHarnessContentId(SEED));
  });

  it('does not re-seed a chain that already has releases', async () => {
    const clock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock });
    await axLearningSurface({
      scenario: 'support',
      store,
      clock,
      seed: SEED,
      idFactory: makeIds('first'),
    });
    const second = await axLearningSurface({
      scenario: 'support',
      store,
      clock,
      seed: NEXT,
      idFactory: makeIds('second'),
    });
    expect(await second.releases()).toHaveLength(1);
    expect((await second.currentTree())?.releaseId).toBe('first-1');
  });

  it('refuses to seed an un-admittable tree', async () => {
    const clock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock });
    await expect(
      axLearningSurface({
        scenario: 'support',
        store,
        clock,
        seed: [instruction('i1', 'key sk-abcdefghij0123456789')],
      })
    ).rejects.toThrow(AxHarnessAdmissionError);
    expect(await store.releases('support')).toHaveLength(0);
  });

  it('starts with no head when no seed is given', async () => {
    const clock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock });
    const surface = await axLearningSurface({
      scenario: 'support',
      store,
      clock,
    });
    expect(await surface.currentTree()).toBeUndefined();
    expect(surface.observedHeadContentId).toBeUndefined();
  });
});

describe('AxLearningSurface — publish is a nomination', () => {
  it('appends current:false and does NOT move the head', async () => {
    const { surface } = await makeSurface();
    const headBefore = await surface.currentTree();
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    expect(nomination.current).toBe(false);
    expect(nomination.operation).toBe('evolve');
    expect(nomination.step).toBe(2);
    expect(nomination.parentReleaseId).toBe('rel-1');
    expect(nomination.gate?.reason).toBe(GATE.reason);
    // The consumer's view is unchanged: this is the whole point.
    const headAfter = await surface.currentTree();
    expect(headAfter?.releaseId).toBe(headBefore?.releaseId);
    expect(headAfter?.contentId).toBe(headBefore?.contentId);
  });

  it('the first append after a seed requires the seed as expected tail', async () => {
    const { surface, store } = await makeSurface();
    // A caller racing the surface with a stale tail loses and changes nothing.
    await expect(
      store.putRelease(
        {
          releaseId: 'rogue',
          scenario: 'support',
          contentId: 'sha256:00',
          step: 2,
          operation: 'evolve',
          current: false,
          restorable: true,
          recordedAt: NOW,
          entries: NEXT,
        },
        null
      )
    ).rejects.toThrow(AxLearningReleaseConflictError);
    expect(await surface.releases()).toHaveLength(1);
  });

  it('refuses an un-admittable candidate before it reaches the chain', async () => {
    const { surface } = await makeSurface();
    await expect(
      surface.publish({
        entries: [instruction('i1', 'ghp_abcdefghij0123456789abcd')],
        gate: GATE,
      })
    ).rejects.toThrow(AxHarnessAdmissionError);
    expect(await surface.releases()).toHaveLength(1);
  });

  it('records the operation the caller names', async () => {
    const { surface } = await makeSurface();
    const release = await surface.publish({
      entries: NEXT,
      gate: GATE,
      operation: 'recovery',
    });
    expect(release.operation).toBe('recovery');
  });
});

describe('AxLearningSurface — promote is a separate CAS', () => {
  it('moves the head and demotes the previous one', async () => {
    const { surface } = await makeSurface();
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    const promoted = await surface.promote(nomination.releaseId, 'rel-1');
    expect(promoted.current).toBe(true);
    expect(promoted.promotedAt).toBe(NOW);
    const chain = await surface.releases();
    expect(chain.map((r) => r.current)).toEqual([false, true]);
    expect((await surface.currentTree())?.releaseId).toBe(nomination.releaseId);
  });

  it('a concurrent promote loses and the head is unchanged', async () => {
    const { surface } = await makeSurface();
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    await surface.promote(nomination.releaseId, 'rel-1');
    // A second promoter still believes the seed is the head.
    await expect(surface.promote('rel-1', 'rel-1')).rejects.toThrow(
      AxLearningReleaseConflictError
    );
    expect((await surface.currentTree())?.releaseId).toBe(nomination.releaseId);
  });

  it('reports the operation on the conflict', async () => {
    const { surface } = await makeSurface();
    try {
      await surface.promote('rel-1', 'nonexistent');
      throw new Error('expected a conflict');
    } catch (error) {
      const conflict = error as AxLearningReleaseConflictError;
      expect(conflict.code).toBe('learning_release_conflict');
      expect(conflict.operation).toBe('promote');
      expect(conflict.expectedReleaseId).toBe('nonexistent');
      expect(conflict.actualReleaseId).toBe('rel-1');
    }
  });

  it('updates observedHeadContentId without a second read', async () => {
    const { surface } = await makeSurface();
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    expect(surface.observedHeadContentId).toBe(await axHarnessContentId(SEED));
    await surface.promote(nomination.releaseId, 'rel-1');
    expect(surface.observedHeadContentId).toBe(await axHarnessContentId(NEXT));
  });
});

describe('AxLearningSurface — rollback', () => {
  it('republishes an old contentId under a new releaseId, increments step, and promotes', async () => {
    const { surface } = await makeSurface();
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    await surface.promote(nomination.releaseId, 'rel-1');

    const rolled = await surface.rollback('rel-1', nomination.releaseId);
    expect(rolled.releaseId).not.toBe('rel-1');
    expect(rolled.operation).toBe('rollback');
    expect(rolled.rollbackTargetReleaseId).toBe('rel-1');
    expect(rolled.contentId).toBe(await axHarnessContentId(SEED));
    expect(rolled.current).toBe(true);
    // Step is monotonic: rollback moves forward, never back.
    expect(rolled.step).toBe(3);
    const chain = await surface.releases();
    expect(chain.map((r) => r.step)).toEqual([1, 2, 3]);
    expect(chain.filter((r) => r.current)).toHaveLength(1);
  });

  it('refuses a non-restorable release', async () => {
    const { surface, store } = await makeSurface();
    await store.putRelease(
      {
        releaseId: 'frozen',
        scenario: 'support',
        contentId: 'sha256:00',
        step: 5,
        operation: 'evolve',
        current: false,
        restorable: false,
        recordedAt: NOW,
        entries: NEXT,
      },
      'rel-1'
    );
    await expect(surface.rollback('frozen', 'rel-1')).rejects.toThrow(
      /not restorable/
    );
    expect((await surface.currentTree())?.releaseId).toBe('rel-1');
  });

  it('refuses a rollback to a release that is not on the chain', async () => {
    const { surface } = await makeSurface();
    await expect(surface.rollback('nope', 'rel-1')).rejects.toThrow(
      AxLearningReleaseConflictError
    );
  });
});

describe('AxLearningSurface — invariants', () => {
  it('releases() is oldest-first and every row carries its gate metrics', async () => {
    const { surface } = await makeSurface();
    await surface.publish({ entries: NEXT, gate: GATE });
    await surface.publish({
      entries: [instruction('i1', 'Third form.')],
      gate: { ...GATE, reason: 'second nomination' },
    });
    const chain = await surface.releases();
    expect(chain.map((r) => r.step)).toEqual([1, 2, 3]);
    expect(chain[1]?.gate?.metrics.candidateScore).toBe(1);
    expect(chain[2]?.gate?.reason).toBe('second nomination');
    // Neither nomination moved the head.
    expect((await surface.currentTree())?.releaseId).toBe('rel-1');
  });

  it('equal contentId means equal entry list across releases', async () => {
    const { surface } = await makeSurface();
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    await surface.promote(nomination.releaseId, 'rel-1');
    const rolled = await surface.rollback('rel-1', nomination.releaseId);
    const chain = await surface.releases();
    const seedRelease = chain.find((r) => r.releaseId === 'rel-1');
    expect(rolled.contentId).toBe(seedRelease?.contentId);
    expect(rolled.entries).toEqual(seedRelease?.entries);
  });

  it('refuses construction when the clock differs from the store instance', async () => {
    const storeClock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock: storeClock });
    await expect(
      axLearningSurface({
        scenario: 'support',
        store,
        clock: new AxManualEventClock(NOW),
      })
    ).rejects.toThrow(/pass that exact instance/);
  });

  it('refuses publish and promote against a compareAndSet:false store', async () => {
    const clock = new AxManualEventClock(NOW);
    const inner = new AxInMemoryLearningStore({ clock });
    const weak: AxLearningStore = {
      ...inner,
      capabilities: { ...inner.capabilities, compareAndSet: false },
      clock,
      append: inner.append.bind(inner),
      get: inner.get.bind(inner),
      page: inner.page.bind(inner),
      markConsumed: inner.markConsumed.bind(inner),
      putRelease: inner.putRelease.bind(inner),
      promoteRelease: inner.promoteRelease.bind(inner),
      head: inner.head.bind(inner),
      releases: inner.releases.bind(inner),
    };
    const surface = await axLearningSurface({
      scenario: 'support',
      store: weak,
      clock,
    });
    await expect(
      surface.publish({ entries: SEED, gate: GATE })
    ).rejects.toThrow(/compareAndSet/);
    await expect(surface.promote('x', null)).rejects.toThrow(/compareAndSet/);
  });

  it('rejects an adversarial tree carrying a provider-shaped key and a credential', async () => {
    const { surface } = await makeSurface();
    const adversarial = [
      {
        id: 'sneaky',
        kind: 'skill',
        config: {
          skillId: 'sneaky',
          name: 'Helper',
          content:
            'Call the provider directly with apiKey sk-abcdefghij0123456789 for speed.',
          apiKey: 'sk-abcdefghij0123456789',
        },
      },
    ] as unknown as AxHarnessTree;
    await expect(
      surface.publish({ entries: adversarial, gate: GATE })
    ).rejects.toThrow(AxHarnessAdmissionError);
    // Nothing reached the chain, so no delivered copy can carry it.
    expect(await surface.releases()).toHaveLength(1);
  });

  it('honours the caller signal on currentTree', async () => {
    const { surface } = await makeSurface();
    const controller = new AbortController();
    controller.abort();
    await expect(surface.currentTree(controller.signal)).rejects.toThrow();
  });
});
