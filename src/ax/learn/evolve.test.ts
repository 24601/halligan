import { describe, expect, it, vi } from 'vitest';
import type { AxAgentEvalTask } from '../agent/agentInternal/agentOptimizeTypes.js';
import { agent } from '../agent/index.js';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxMetricFn } from '../dsp/common_types.js';
import { AxManualEventClock } from '../event/types.js';
import { axEventCanonicalDigest } from '../event/util.js';
import { axApplyHarnessTree, axCurrentHarnessInstallation } from './apply.js';
import {
  type AxHarnessEvolveAgent,
  type AxHarnessSelector,
  axHarnessEvolve,
} from './evolve.js';
import { AxInMemoryLearningStore } from './memoryStore.js';
import { axLearningSurface } from './releases.js';
import {
  type AxHarnessEntry,
  AxHarnessEvolveConfigError,
  type AxHarnessInstallTarget,
  type AxHarnessMutation,
  AxLearningSuppressedError,
} from './types.js';

const NOW = 10_000;

/**
 * A step runs 2 x tasks x sides episodes against a mock provider, which is
 * well past vitest's 5s default even with no network.
 */
const SLOW = 120_000;

const instruction = (id: string, text = 'Answer briefly.'): AxHarnessEntry => ({
  id,
  kind: 'instruction',
  config: { text },
});

const SEED = [instruction('tone')];

const ADD_BULLET: AxHarnessMutation = {
  op: 'create',
  id: 'b1',
  options: {
    kind: 'playbookBullet',
    config: {
      id: 'be-brief',
      section: 'General',
      content: 'Prefer the shortest correct answer.',
    },
  },
};

const task = (id: string): AxAgentEvalTask<{ query: string }> => ({
  id,
  input: { query: `question ${id}` },
  criteria: 'answers the question',
});

// One task per split by default: every episode is a real agent run, so the
// suite pays 2 x tasks x sides for each step. The interleaving test, which is
// the only one that needs to see alternation, asks for the wider split.
const TRAIN = [task('t1')];
const VALIDATION = [task('v1')];
const WIDE_TRAIN = [task('t1'), task('t2')];
const WIDE_VALIDATION = [task('v1'), task('v2')];

function makeAI() {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async () => ({
      results: [
        { index: 0, content: 'Answer: fine', finishReason: 'stop' as const },
      ],
      modelUsage: {
        ai: 'mock-ai',
        model: 'mock-model',
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    }),
  });
}

function ids(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

async function harness() {
  const clock = new AxManualEventClock(NOW);
  const store = new AxInMemoryLearningStore({ clock });
  const surface = await axLearningSurface({
    scenario: 'support',
    store,
    clock,
    seed: SEED,
    idFactory: ids('rel'),
  });
  const ai = makeAI();
  const a = agent('query:string -> answer:string', {
    ai,
    // A playbook handle has to exist for a `playbookBullet` entry to install;
    // `learn: false` keeps the agent from accumulating run state, which would
    // otherwise force an acknowledged reset on every trial install.
    playbook: { learn: false },
    learning: {
      scenario: 'support',
      store,
      surface,
      clock,
      idFactory: ids('rec'),
    },
  });
  // The annotation is the point: a real AxAgent must structurally satisfy the
  // evolve port, or this file stops compiling under `test:type-check`.
  const evolveAgent: AxHarnessEvolveAgent = a;
  return { a, ai, store, surface, clock, evolveAgent };
}

/** True while the CANDIDATE tree is the one installed on the agent. */
function candidateInstalled(target: AxHarnessInstallTarget): boolean {
  return (
    axCurrentHarnessInstallation(target)?.releaseId.endsWith('-candidate') ===
    true
  );
}

/**
 * A deterministic metric that scores by which side is installed, so a test can
 * state "the candidate is better on held-in and worse on held-out" exactly.
 */
function sideMetric(
  target: AxHarnessInstallTarget,
  table: Readonly<Record<string, { current: number; candidate: number }>>
): AxMetricFn {
  return ({ example }) => {
    const id = (example as { id?: string }).id ?? 'unknown';
    const row = table[id] ?? { current: 0, candidate: 0 };
    return candidateInstalled(target) ? row.candidate : row.current;
  };
}

const IMPROVES = {
  t1: { current: 0.2, candidate: 0.9 },
  t2: { current: 0.2, candidate: 0.9 },
  v1: { current: 0.5, candidate: 0.6 },
  v2: { current: 0.5, candidate: 0.6 },
};

const HELD_OUT_REGRESSES = {
  t1: { current: 0.2, candidate: 0.9 },
  t2: { current: 0.2, candidate: 0.9 },
  v1: { current: 0.9, candidate: 0.1 },
  v2: { current: 0.9, candidate: 0.1 },
};

async function evolve(
  h: Awaited<ReturnType<typeof harness>>,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return axHarnessEvolve({
    agent: h.evolveAgent,
    ai: h.ai,
    surface: h.surface,
    tasks: { train: TRAIN, validation: VALIDATION },
    propose: () => [ADD_BULLET],
    metric: sideMetric(h.a as unknown as AxHarnessInstallTarget, IMPROVES),
    clock: h.clock,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe(
  'axHarnessEvolve — configuration fails closed',
  { timeout: SLOW },
  () => {
    it('requireHeldOut defaults true and throws on a flat task array before any metric call', async () => {
      const h = await harness();
      const metric = vi.fn(() => 1);
      await expect(evolve(h, { tasks: TRAIN, metric })).rejects.toThrow(
        AxHarnessEvolveConfigError
      );
      expect(metric).not.toHaveBeenCalled();
      expect(await h.surface.releases()).toHaveLength(1);
    });

    it('names the field and points at the opt-out', async () => {
      const h = await harness();
      try {
        await evolve(h, { tasks: TRAIN });
        throw new Error('expected a refusal');
      } catch (error) {
        const config = error as AxHarnessEvolveConfigError;
        expect(config.code).toBe('harness_evolve_config_invalid');
        expect(config.field).toBe('gate.requireHeldOut');
        expect(config.message).toContain('66.7%');
      }
    });

    it('requireHeldOut:false on a flat array runs held-in-only and says so in the reason', async () => {
      const h = await harness();
      const result = await evolve(h, {
        tasks: TRAIN,
        gate: { requireHeldOut: false },
      });
      expect(result.status).toBe('nominated');
      expect(result.decision?.metrics.heldOut).toBeUndefined();
      expect(result.decision?.metrics.heldOutTaskSetDigest).toBeUndefined();
      expect(result.decision?.reason).toContain('no held-out set provided');
    });

    it('throws when the surface has no promoted head', async () => {
      const clock = new AxManualEventClock(NOW);
      const store = new AxInMemoryLearningStore({ clock });
      const surface = await axLearningSurface({
        scenario: 'support',
        store,
        clock,
      });
      const ai = makeAI();
      const a: AxHarnessEvolveAgent = agent('query:string -> answer:string', {
        ai,
      });
      await expect(
        axHarnessEvolve({
          agent: a,
          ai,
          surface,
          tasks: { train: TRAIN, validation: VALIDATION },
          propose: () => [ADD_BULLET],
          metric: () => 1,
          clock,
        })
      ).rejects.toThrow(/no promoted head/);
    });

    it('refuses a recovered tree that no longer passes admission, before any metric call', async () => {
      const clock = new AxManualEventClock(NOW);
      const store = new AxInMemoryLearningStore({ clock });
      const surface = await axLearningSurface({
        scenario: 'support',
        store,
        clock,
        seed: SEED,
        idFactory: ids('rel'),
      });
      // A release written straight into the store, bypassing the surface gate —
      // exactly the "persisted state loads" path admission exists for.
      await store.putRelease(
        {
          releaseId: 'tainted',
          scenario: 'support',
          contentId: 'sha256:00',
          step: 2,
          operation: 'evolve',
          current: false,
          restorable: true,
          recordedAt: NOW,
          entries: [instruction('bad', 'key sk-abcdefghij0123456789')],
        },
        'rel-1'
      );
      await store.promoteRelease('support', 'tainted', 'rel-1');
      const ai = makeAI();
      const a: AxHarnessEvolveAgent = agent('query:string -> answer:string', {
        ai,
      });
      const metric = vi.fn(() => 1);
      await expect(
        axHarnessEvolve({
          agent: a,
          ai,
          surface,
          tasks: { train: TRAIN, validation: VALIDATION },
          propose: () => [ADD_BULLET],
          metric,
          clock,
        })
      ).rejects.toThrow(/denied admission/);
      expect(metric).not.toHaveBeenCalled();
    });
  }
);

describe('axHarnessEvolve — skipping', { timeout: SLOW }, () => {
  it('a null proposal skips the step and appends nothing', async () => {
    const h = await harness();
    const metric = vi.fn(() => 1);
    const result = await evolve(h, { propose: () => null, metric });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no proposal');
    expect(metric).not.toHaveBeenCalled();
    expect(await h.surface.releases()).toHaveLength(1);
  });

  it('a no-op mutation skips before any episode', async () => {
    const h = await harness();
    const metric = vi.fn(() => 1);
    const result = await evolve(h, {
      propose: (): AxHarnessMutation[] => [
        {
          op: 'update',
          id: 'tone',
          options: { config: { text: 'Answer briefly.' } },
        },
      ],
      metric,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no-op mutation');
    expect(metric).not.toHaveBeenCalled();
  });

  it('an inadmissible proposal skips with the per-entry reason and appends nothing', async () => {
    const h = await harness();
    const result = await evolve(h, {
      propose: (): AxHarnessMutation[] => [
        {
          op: 'update',
          id: 'tone',
          options: { config: { text: 'use sk-abcdefghij0123456789' } },
        },
      ],
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('credential-shaped-literal');
    expect(result.reason).toContain('config.text');
    expect(await h.surface.releases()).toHaveLength(1);
  });

  it('an install failure skips the step and appends nothing', async () => {
    const h = await harness();
    // A skill entry on an agent with no skills catalog cannot install.
    const result = await evolve(h, {
      propose: (): AxHarnessMutation[] => [
        {
          op: 'create',
          id: 's1',
          options: {
            kind: 'skill',
            config: {
              skillId: 'new-skill',
              name: 'New skill',
              content: 'body',
            },
          },
        },
      ],
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('trial install failed');
    expect(await h.surface.releases()).toHaveLength(1);
    // …and the agent is left with nothing installed.
    expect(
      axCurrentHarnessInstallation(h.a as unknown as AxHarnessInstallTarget)
    ).toBeUndefined();
  });
});

describe('axHarnessEvolve — evaluation', { timeout: SLOW }, () => {
  it('nominates a candidate the gate selects, without moving the head', async () => {
    const h = await harness();
    const headBefore = await h.surface.currentTree();
    const result = await evolve(h);
    expect(result.status).toBe('nominated');
    expect(result.release?.current).toBe(false);
    expect(result.release?.operation).toBe('evolve');
    expect(result.release?.gate?.policy).toBe('axPlaybookGate');
    const headAfter = await h.surface.currentTree();
    expect(headAfter?.releaseId).toBe(headBefore?.releaseId);
  });

  it('computes taskSetDigest from the split alone, so a proposal cannot move it', async () => {
    // R3's Goodhart argument is only true if the digest is a function of the
    // frozen split and nothing else. Two checks make that concrete: the digest
    // equals an independently computed one over the sorted task ids, and a
    // DIFFERENT proposal on the same split produces the same digest.
    const expected = await axEventCanonicalDigest(['t1']);
    const expectedHeldOut = await axEventCanonicalDigest(['v1']);

    const h = await harness();
    let proposerRan = false;
    const first = await evolve(h, {
      propose: async () => {
        proposerRan = true;
        return [ADD_BULLET];
      },
    });
    expect(proposerRan).toBe(true);
    expect(first.decision?.metrics.taskSetDigest).toBe(expected);
    expect(first.decision?.metrics.heldOutTaskSetDigest).toBe(expectedHeldOut);

    const second = await harness();
    const other = await evolve(second, {
      propose: (): AxHarnessMutation[] => [
        {
          op: 'update',
          id: 'tone',
          options: { config: { text: 'A completely different rule.' } },
        },
      ],
    });
    expect(other.decision?.metrics.taskSetDigest).toBe(expected);
    expect(other.candidate?.candidateContentId).not.toBe(
      first.candidate?.candidateContentId
    );
  });

  it('interleaves the two sides and alternates first position', async () => {
    const h = await harness();
    const order: string[] = [];
    await evolve(h, {
      tasks: { train: WIDE_TRAIN, validation: WIDE_VALIDATION },
      onProgress: (event: { phase: string; message: string }) => {
        if (event.phase === 'evaluate') order.push(event.message);
      },
    });
    expect(order).toEqual([
      'train:t1:current',
      'train:t1:candidate',
      'train:t2:candidate',
      'train:t2:current',
      'validation:v1:current',
      'validation:v1:candidate',
      'validation:v2:candidate',
      'validation:v2:current',
    ]);
  });

  it('rejects a held-out regression that scoreComparison accepts', async () => {
    const strict = await harness();
    const strictResult = await evolve(strict, {
      metric: sideMetric(
        strict.a as unknown as AxHarnessInstallTarget,
        HELD_OUT_REGRESSES
      ),
    });
    expect(strictResult.status).toBe('rejected');
    expect(strictResult.decision?.reason).toContain('held-out regressed');
    expect(await strict.surface.releases()).toHaveLength(1);

    const parity = await harness();
    const parityResult = await evolve(parity, {
      selection: 'scoreComparison',
      metric: sideMetric(
        parity.a as unknown as AxHarnessInstallTarget,
        HELD_OUT_REGRESSES
      ),
    });
    expect(parityResult.status).toBe('nominated');
    expect(parityResult.decision?.policy).toBe('scoreComparison');
  });

  it('a candidate that crashes on one task can never win', async () => {
    const h = await harness();
    const target = h.a as unknown as AxHarnessInstallTarget;
    const result = await evolve(h, {
      metric: ({ example }: { example: Record<string, unknown> }) => {
        const id = (example as { id?: string }).id ?? '';
        if (candidateInstalled(target) && id === 't1') {
          throw new Error('candidate exploded');
        }
        return candidateInstalled(target) ? 0.95 : 0.2;
      },
    });
    expect(result.status).toBe('rejected');
    expect(result.decision?.metrics.candidateScores[0]).toBeNull();
    // A null score is stored as null, not as a zero, so "could not run" stays
    // distinguishable from "scored nothing".
    expect(result.decision?.metrics.currentScores[0]).not.toBeNull();
    expect(result.decision?.metrics.losses).toBeGreaterThan(0);
    expect(result.decision?.metrics.episodeFailures).toBeGreaterThan(0);
    void target;
  });

  it('records a normalized failure observation for a crashed episode', async () => {
    const h = await harness();
    const target = h.a as unknown as AxHarnessInstallTarget;
    const result = await evolve(h, {
      metric: () => {
        if (candidateInstalled(target)) {
          throw new Error('exploded after 500 ms at /Users/x/y/z.ts');
        }
        return 0.2;
      },
    });
    expect(result.manifest.entries.length).toBeGreaterThan(0);
    const cause = result.manifest.entries[0]?.cause ?? '';
    expect(cause).not.toContain('/Users/x/y/z.ts');
    expect(result.decision?.metrics.failures.new.length).toBeGreaterThan(0);
    // Every entry names a task, and the manifest describes the candidate.
    expect(result.manifest.entries.every((entry) => entry.count > 0)).toBe(
      true
    );
  });

  it('never attributes a CURRENT-side failure to the candidate', async () => {
    // The mirror of the test above, and the direction that matters most: the
    // manifest is the only thing the proposer is told about its own previous
    // attempts, and it rides inside the gate decision onto the release chain.
    // A step that nominates a healthy candidate must not ship a durable claim
    // that the candidate failed the tasks the BASELINE failed.
    const h = await harness();
    const target = h.a as unknown as AxHarnessInstallTarget;
    const result = await evolve(h, {
      metric: ({ example }: { example: Record<string, unknown> }) => {
        if (!candidateInstalled(target)) {
          throw new Error('the CURRENT tree exploded');
        }
        return ((example as { id?: string }).id ?? '').startsWith('t')
          ? 0.9
          : 0.6;
      },
    });

    expect(result.status).toBe('nominated');
    // The failures really happened and are not being hidden: they are counted
    // on the metrics and every current-side score is null.
    expect(result.decision?.metrics.episodeFailures).toBeGreaterThan(0);
    expect(result.decision?.metrics.currentScores[0]).toBeNull();
    // …but none of them is charged to the candidate.
    expect(result.manifest.entries).toEqual([]);
    expect(result.decision?.metrics.failures.new).toEqual([]);
    expect(result.decision?.metrics.failures.persisting).toEqual([]);
  });
});

describe(
  'axHarnessEvolve — the selector may not fabricate',
  { timeout: SLOW },
  () => {
    it('throws when the selector returns a different metrics object', async () => {
      const h = await harness();
      const rogue: AxHarnessSelector = (_candidate, evaluation) => ({
        outcome: 'select',
        evaluator: evaluation.evaluator,
        evaluatorVersion: evaluation.evaluatorVersion,
        policy: 'rogue',
        policyVersion: '1',
        reason: 'because I said so',
        metrics: { ...evaluation.metrics, wins: 99 },
      });
      await expect(evolve(h, { selection: rogue })).rejects.toThrow(
        /may not fabricate its own measurements/
      );
      expect(await h.surface.releases()).toHaveLength(1);
    });

    it('throws when the selector names no policy', async () => {
      const h = await harness();
      const nameless: AxHarnessSelector = (_candidate, evaluation) => ({
        outcome: 'reject',
        evaluator: evaluation.evaluator,
        evaluatorVersion: evaluation.evaluatorVersion,
        policy: '',
        policyVersion: '',
        reason: 'x',
        metrics: evaluation.metrics,
      });
      await expect(evolve(h, { selection: nameless })).rejects.toThrow(
        /non-empty policy/
      );
    });
  }
);

describe(
  'axHarnessEvolve — the proposer is contained',
  { timeout: SLOW },
  () => {
    it('receives no served AxAIService and no agent, store or surface', async () => {
      const h = await harness();
      let seen: Record<string, unknown> | undefined;
      await evolve(h, {
        teacherAI: h.ai,
        namedModels: { reviewer: h.ai },
        propose: (args: Record<string, unknown>) => {
          seen = args;
          return [ADD_BULLET];
        },
      });
      const models = seen?.models as Record<string, unknown>;
      expect(Object.keys(seen ?? {}).sort()).toEqual([
        'droppedSamples',
        'models',
        'nodes',
        'samples',
        'signal',
        'step',
      ]);
      expect(models.teacher).toBe(h.ai);
      expect((models.named as Record<string, unknown>).reviewer).toBe(h.ai);
      expect(Object.keys(models).sort()).toEqual(['named', 'teacher']);
    });

    it('is called at most maxProposerCalls times', async () => {
      const h = await harness();
      const propose = vi.fn(() => null);
      const result = await evolve(h, { propose, maxProposerCalls: 3 });
      expect(propose).toHaveBeenCalledTimes(3);
      expect(result.proposerCallsUsed).toBe(3);
      expect(result.status).toBe('skipped');
    });

    it('aborts a proposer that overruns proposeTimeoutMs', async () => {
      const h = await harness();
      // The step composes its own deadline with the caller's signal and hands
      // the proposer the merged one; a proposer that never settles is aborted
      // rather than hanging the step.
      await expect(
        evolve(h, {
          proposeTimeoutMs: 5,
          propose: (args: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              args.signal?.addEventListener('abort', () =>
                reject(new Error('proposer aborted'))
              );
            }),
        })
      ).rejects.toThrow('proposer aborted');
    });

    it('sees only the enabled nodes of the current tree', async () => {
      const h = await harness();
      let nodes: readonly { id: string }[] = [];
      await evolve(h, {
        propose: (args: { nodes: readonly { id: string }[] }) => {
          nodes = args.nodes;
          return [ADD_BULLET];
        },
      });
      expect(nodes.map((n) => n.id)).toEqual(['tone']);
    });
  }
);

describe('axHarnessEvolve — recording suppression', { timeout: SLOW }, () => {
  it('a live run() during the step appends nothing, throws, and is counted', async () => {
    const h = await harness();
    let suppressedInside = 0;
    const result = await evolve(h, {
      propose: async () => {
        await expect(
          h.a.learn().run(h.ai, { query: 'sneaky' })
        ).rejects.toThrow(AxLearningSuppressedError);
        suppressedInside = h.a.learn().suppressedRecords;
        return [ADD_BULLET];
      },
    });
    expect(suppressedInside).toBe(1);
    expect(result.suppressedRecords).toBe(1);
    const page = await h.store.page('support', {});
    expect(page.entries).toHaveLength(0);
  });

  it('a full step against a counting store appends zero records', async () => {
    const h = await harness();
    await evolve(h);
    const page = await h.store.page('support', {});
    expect(page.entries).toHaveLength(0);
  });

  it('releases suppression when the step is done', async () => {
    const h = await harness();
    await evolve(h);
    await expect(
      h.a.learn().run(h.ai, { query: 'after' })
    ).resolves.toBeDefined();
  });
});

describe(
  'axHarnessEvolve — the agent is left as it was found',
  { timeout: SLOW },
  () => {
    it('leaves nothing installed when it started with nothing installed', async () => {
      const h = await harness();
      const target = h.a as unknown as AxHarnessInstallTarget;
      await evolve(h);
      expect(axCurrentHarnessInstallation(target)).toBeUndefined();
      expect(target.getActorInstructionSlot?.('learn:tone')).toBeUndefined();
    });

    it('leaves the PRE-STEP installation in place even when the candidate wins', async () => {
      const h = await harness();
      const target = h.a as unknown as AxHarnessInstallTarget;
      await axApplyHarnessTree(SEED, target, {
        releaseId: 'rel-1',
        now: new Date(NOW).toISOString(),
      });
      const result = await evolve(h);
      expect(result.status).toBe('nominated');
      const after = axCurrentHarnessInstallation(target);
      expect(after?.releaseId).toBe('rel-1');
      expect(target.getActorInstructionSlot?.('learn:tone')).toBe(
        'Answer briefly.'
      );
      // The winner is NOT installed — installing a nomination is the host's act.
      expect(after?.contentId).not.toBe(result.candidate?.candidateContentId);
      after?.dispose();
    });

    it('restores the exact pre-step tree after a rejection', async () => {
      const h = await harness();
      const target = h.a as unknown as AxHarnessInstallTarget;
      const before = await axApplyHarnessTree(SEED, target, {
        releaseId: 'rel-1',
        now: new Date(NOW).toISOString(),
      });
      const contentBefore = before.contentId;
      const result = await evolve(h, {
        metric: sideMetric(target, HELD_OUT_REGRESSES),
      });
      expect(result.status).toBe('rejected');
      expect(axCurrentHarnessInstallation(target)?.contentId).toBe(
        contentBefore
      );
      axCurrentHarnessInstallation(target)?.dispose();
    });

    it('refuses a pre-step installation that is not on this chain', async () => {
      const h = await harness();
      const target = h.a as unknown as AxHarnessInstallTarget;
      await axApplyHarnessTree(SEED, target, {
        releaseId: 'from-somewhere-else',
        now: new Date(NOW).toISOString(),
      });
      await expect(evolve(h)).rejects.toThrow(/not on this scenario's chain/);
      // The caller's installation is untouched, so nothing was silently lost.
      expect(axCurrentHarnessInstallation(target)?.releaseId).toBe(
        'from-somewhere-else'
      );
      axCurrentHarnessInstallation(target)?.dispose();
    });
  }
);
