import { describe, expect, it, vi } from 'vitest';
import { AxMockAIService } from '../../ai/mock/api.js';
import { AxManualEventClock } from '../../event/types.js';
import { axApplyHarnessTree } from '../../learn/apply.js';
import { AxInMemoryLearningStore } from '../../learn/memoryStore.js';
import { axLearningSurface } from '../../learn/releases.js';
import { axReportSchema } from '../../learn/reportSchema.js';
import { axHarnessContentId } from '../../learn/tree.js';
import {
  type AxHarnessEntry,
  type AxHarnessGateDecision,
  type AxHarnessInstallTarget,
  type AxLearningInteractionRecord,
  type AxLearningRecord,
  AxLearningReportValidationError,
  AxLearningSuppressedError,
} from '../../learn/types.js';
import { agent } from '../index.js';

const NOW = 5_000;
const ISO = new Date(NOW).toISOString();

const instruction = (id: string, text = 'Answer briefly.'): AxHarnessEntry => ({
  id,
  kind: 'instruction',
  config: { text },
});

const SEED = [instruction('i1')];
const NEXT = [instruction('i1', 'Answer in exactly one sentence.')];

const GATE: Readonly<AxHarnessGateDecision> = Object.freeze({
  outcome: 'select',
  evaluator: 'harness_task_pairs',
  evaluatorVersion: '1',
  policy: 'axPlaybookGate',
  policyVersion: '1',
  reason: 'held-in improved',
  metrics: Object.freeze({
    candidateScores: [1],
    currentScores: [0],
    candidateScore: 1,
    currentScore: 0,
    wins: 1,
    losses: 0,
    ties: 0,
    heldIn: { before: 0, after: 1 },
    taskSetDigest: 'd',
    failures: { new: [], persisting: [], fixed: [] },
    episodeFailures: 0,
  }),
});

function makeAI(behaviour: 'ok' | 'throw' = 'ok') {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async () => {
      if (behaviour === 'throw') throw new Error('provider exploded');
      return {
        results: [
          { index: 0, content: 'Answer: fine', finishReason: 'stop' as const },
        ],
        modelUsage: {
          ai: 'mock-ai',
          model: 'mock-model',
          tokens: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        },
      };
    },
  });
}

function ids(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

async function harness(
  options: Readonly<{
    behaviour?: 'ok' | 'throw';
    learningOverrides?: Record<string, unknown>;
    seed?: AxHarnessEntry[];
  }> = {}
) {
  const clock = new AxManualEventClock(NOW);
  const store = new AxInMemoryLearningStore({ clock });
  const surface = await axLearningSurface({
    scenario: 'support',
    store,
    clock,
    seed: options.seed ?? SEED,
    idFactory: ids('rel'),
  });
  const ai = makeAI(options.behaviour);
  const a = agent('query:string -> answer:string', {
    ai,
    learning: {
      scenario: 'support',
      store,
      surface,
      clock,
      idFactory: ids('rec'),
      ...options.learningOverrides,
    },
  });
  return { a, ai, store, surface, clock };
}

async function allRecords(
  store: AxInMemoryLearningStore
): Promise<readonly AxLearningRecord[]> {
  const page = await store.page('support', {});
  return page.entries.map((entry) => entry.record);
}

// ---------------------------------------------------------------------------

describe('learn() / getLearn()', () => {
  it('an agent with no learning config records nothing and getLearn() is undefined', async () => {
    const a = agent('query:string -> answer:string', { ai: makeAI() });
    expect(a.getLearn()).toBeUndefined();
    expect(() => a.learn()).toThrow(/without a `learning` config/);
  });

  it('learn() is memoized', async () => {
    const { a } = await harness();
    expect(a.learn()).toBe(a.learn());
    expect(a.getLearn()).toBe(a.learn());
  });
});

describe('AxAgentLearning.run()', () => {
  it('returns the output and a receipt whose record is already durable', async () => {
    const { a, ai, store } = await harness();
    const { output, receipt } = await a.learn().run(ai, { query: 'hello' });
    expect(output.answer).toBe('fine');
    expect(receipt.scenario).toBe('support');
    expect(receipt.durability).toBe('volatile');
    expect(receipt.duplicate).toBe(false);
    // The record exists by the time the caller sees the receipt.
    const stored = await store.get('support', receipt.recordId);
    expect(stored?.kind).toBe('interaction');
    expect((stored as AxLearningInteractionRecord).payload.input).toEqual({
      query: 'hello',
    });
    expect(
      (stored as AxLearningInteractionRecord).payload.output
    ).toBeDefined();
  });

  it('records the model and usage of the run it just made', async () => {
    const { a, ai, store } = await harness();
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    const stored = (await store.get(
      'support',
      receipt.recordId
    )) as AxLearningInteractionRecord;
    expect(stored.payload.model).toBe('mock-model');
    expect(stored.payload.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('a bare forward() on a learning-configured agent appends nothing', async () => {
    const { a, ai, store } = await harness();
    await a.forward(ai, { query: 'hello' });
    expect(await allRecords(store)).toHaveLength(0);
  });

  it('records no artifactRef when no tree is installed', async () => {
    const { a, ai, store } = await harness();
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    expect(receipt.artifactRef).toBeUndefined();
    const stored = (await store.get(
      'support',
      receipt.recordId
    )) as AxLearningInteractionRecord;
    expect(stored.artifactRef).toBeUndefined();
  });

  it('install A, promote B, then run(): the record names A and reports stale with B head', async () => {
    const { a, ai, store, surface } = await harness();
    // Serve the seed…
    const installation = await axApplyHarnessTree(
      SEED,
      a as unknown as AxHarnessInstallTarget,
      { releaseId: 'rel-1', now: ISO }
    );
    // …then let the chain move on underneath it.
    const nomination = await surface.publish({ entries: NEXT, gate: GATE });
    await surface.promote(nomination.releaseId, 'rel-1');
    // The surface has now OBSERVED the new head; the agent still serves A.
    const { receipt } = await a.learn().run(ai, { query: 'hello' });

    expect(receipt.artifactRef?.releaseId).toBe('rel-1');
    expect(receipt.artifactRef?.contentId).toBe(await axHarnessContentId(SEED));
    expect(receipt.artifactRef?.headContentId).toBe(
      await axHarnessContentId(NEXT)
    );
    expect(receipt.artifactRef?.stale).toBe(true);
    const stored = (await store.get(
      'support',
      receipt.recordId
    )) as AxLearningInteractionRecord;
    expect(stored.artifactRef?.stale).toBe(true);
    installation.dispose();
  });

  it('reports stale:false while the installed tree IS the head', async () => {
    const { a, ai, surface } = await harness();
    await surface.currentTree();
    const installation = await axApplyHarnessTree(
      SEED,
      a as unknown as AxHarnessInstallTarget,
      { releaseId: 'rel-1', now: ISO }
    );
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    expect(receipt.artifactRef?.stale).toBe(false);
    installation.dispose();
  });

  it('a throwing run records nothing by default', async () => {
    const { a, ai, store } = await harness({ behaviour: 'throw' });
    await expect(a.learn().run(ai, { query: 'hello' })).rejects.toThrow();
    expect(await allRecords(store)).toHaveLength(0);
  });

  it('records a failure without a stack when recordFailures is set', async () => {
    const { a, ai, store } = await harness({
      behaviour: 'throw',
      learningOverrides: { recordFailures: true },
    });
    await expect(a.learn().run(ai, { query: 'hello' })).rejects.toThrow();
    const records = await allRecords(store);
    expect(records).toHaveLength(1);
    const record = records[0] as AxLearningInteractionRecord;
    expect(record.payload.output).toBeUndefined();
    expect(record.payload.failure?.message).toBeDefined();
    expect(JSON.stringify(record)).not.toContain('at Object.');
  });

  it('an append failure rethrows by default and is routed to onRecordError when supplied', async () => {
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
    const broken = {
      ...store,
      capabilities: store.capabilities,
      clock,
      append: async () => {
        throw new Error('disk on fire');
      },
      get: store.get.bind(store),
      page: store.page.bind(store),
      markConsumed: store.markConsumed.bind(store),
      putRelease: store.putRelease.bind(store),
      promoteRelease: store.promoteRelease.bind(store),
      head: store.head.bind(store),
      releases: store.releases.bind(store),
    };
    const strict = agent('query:string -> answer:string', {
      ai,
      learning: { scenario: 'support', store: broken, surface, clock },
    });
    await expect(strict.learn().run(ai, { query: 'x' })).rejects.toThrow(
      'disk on fire'
    );

    const seen: unknown[] = [];
    const lenient = agent('query:string -> answer:string', {
      ai,
      learning: {
        scenario: 'support',
        store: broken,
        surface,
        clock,
        onRecordError: (error) => seen.push(error),
      },
    });
    // The agent run itself still succeeded; only the receipt is missing.
    await expect(lenient.learn().run(ai, { query: 'x' })).rejects.toThrow(
      /no receipt exists/
    );
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('disk on fire');
  });

  it('keeps the agent error when recordFailures cannot append it', async () => {
    // The mirror of I2b. Previously the store's error rejected `run()` and
    // the agent's own error was lost — not even attached — so the caller was
    // told "disk on fire" about a run that failed for an entirely different
    // reason.
    const clock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock });
    const surface = await axLearningSurface({
      scenario: 'support',
      store,
      clock,
      seed: SEED,
      idFactory: ids('rel'),
    });
    const ai = makeAI('throw');
    const broken = {
      ...store,
      capabilities: store.capabilities,
      clock,
      append: async () => {
        throw new Error('disk on fire');
      },
      get: store.get.bind(store),
      page: store.page.bind(store),
      markConsumed: store.markConsumed.bind(store),
      putRelease: store.putRelease.bind(store),
      promoteRelease: store.promoteRelease.bind(store),
      head: store.head.bind(store),
      releases: store.releases.bind(store),
    };

    const strict = agent('query:string -> answer:string', {
      ai,
      learning: {
        scenario: 'support',
        store: broken,
        surface,
        clock,
        recordFailures: true,
      },
    });
    let raised: unknown;
    try {
      await strict.learn().run(ai, { query: 'x' });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(AggregateError);
    const errors = (raised as AggregateError).errors as Error[];
    // The agent's own failure comes first and is never discarded.
    expect(errors[0]?.message).toContain('provider exploded');
    expect(errors[1]?.message).toBe('disk on fire');

    // With onRecordError the append error is routed and the ORIGINAL error is
    // what the caller sees, unwrapped.
    const routed: unknown[] = [];
    const lenient = agent('query:string -> answer:string', {
      ai,
      learning: {
        scenario: 'support',
        store: broken,
        surface,
        clock,
        recordFailures: true,
        onRecordError: (error: unknown) => routed.push(error),
      },
    });
    await expect(lenient.learn().run(ai, { query: 'x' })).rejects.toThrow(
      /provider exploded/
    );
    expect((routed[0] as Error).message).toBe('disk on fire');
  });

  it('onInteraction fires once, is awaited, and its rejection reaches onRecordError', async () => {
    const order: string[] = [];
    const { a, ai } = await harness({
      learningOverrides: {
        onInteraction: async () => {
          await Promise.resolve();
          order.push('callback');
        },
      },
    });
    await a.learn().run(ai, { query: 'x' });
    order.push('resolved');
    expect(order).toEqual(['callback', 'resolved']);

    const routed: unknown[] = [];
    const second = await harness({
      learningOverrides: {
        onInteraction: () => {
          throw new Error('callback exploded');
        },
        onRecordError: (error: unknown) => routed.push(error),
      },
    });
    await second.a.learn().run(second.ai, { query: 'x' });
    expect((routed[0] as Error).message).toBe('callback exploded');
  });

  it('accepts the memories augmentation forward() accepts, and does not record it as input', async () => {
    const { a, ai, store } = await harness();
    const { receipt } = await a.learn().run(ai, {
      query: 'hello',
      memories: [{ id: 'm1', content: 'the user prefers brevity' }],
    });
    const stored = (await store.get(
      'support',
      receipt.recordId
    )) as AxLearningInteractionRecord;
    expect(stored.payload.input).toEqual({ query: 'hello' });
  });
});

describe('AxAgentLearning.report()', () => {
  it('appends a report that grades one receipt', async () => {
    const { a, ai, store } = await harness();
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    const result = await a
      .learn()
      .report({ references: [receipt.recordId], score: 0 });
    expect(result.inserted).toBe(true);
    expect(await allRecords(store)).toHaveLength(2);
  });

  it('refuses a reference naming a report record', async () => {
    const { a, ai } = await harness();
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    const first = await a
      .learn()
      .report({ references: [receipt.recordId], score: 0, id: 'report-1' });
    expect(first.inserted).toBe(true);
    await expect(
      a.learn().report({ references: ['report-1'], score: 1 })
    ).rejects.toThrow(AxLearningReportValidationError);
  });

  it('validates through the configured report schema at ingress', async () => {
    const { a, ai } = await harness({
      learningOverrides: {
        reportSchema: axReportSchema({
          score: { type: 'number', required: true, min: 0, max: 1 },
        }),
      },
    });
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    await expect(
      a.learn().report({ references: [receipt.recordId], score: 5 })
    ).rejects.toThrow(/score/);
    await expect(
      a.learn().report({ references: [receipt.recordId] })
    ).rejects.toThrow(/score/);
  });

  it('is retry-safe when the caller supplies its own report id', async () => {
    const { a, ai } = await harness();
    const { receipt } = await a.learn().run(ai, { query: 'hello' });
    const input = { references: [receipt.recordId], score: 0, id: 'r-1' };
    const first = await a.learn().report(input);
    const second = await a.learn().report(input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.reason).toBe('duplicate');
  });
});

describe('suspendRecording()', () => {
  it('a live run() inside a suspension appends nothing, throws, and is counted', async () => {
    const { a, ai, store } = await harness();
    const release = a.learn().suspendRecording();
    await expect(a.learn().run(ai, { query: 'hello' })).rejects.toThrow(
      AxLearningSuppressedError
    );
    expect(await allRecords(store)).toHaveLength(0);
    expect(a.learn().suppressedRecords).toBe(1);
    release();
    await a.learn().run(ai, { query: 'hello' });
    expect(await allRecords(store)).toHaveLength(1);
    expect(a.learn().suppressedRecords).toBe(1);
  });

  it('refcounts, so nested suspensions compose and the release is idempotent', async () => {
    const { a, ai } = await harness();
    const outer = a.learn().suspendRecording();
    const inner = a.learn().suspendRecording();
    inner();
    inner();
    await expect(a.learn().run(ai, { query: 'x' })).rejects.toThrow(
      AxLearningSuppressedError
    );
    outer();
    await expect(a.learn().run(ai, { query: 'x' })).resolves.toBeDefined();
  });

  it('refuses BEFORE issuing the forward, so a suppressed run costs no model call', async () => {
    const chat = vi.fn(async () => ({
      results: [
        { index: 0, content: 'Answer: fine', finishReason: 'stop' as const },
      ],
      modelUsage: {
        ai: 'mock-ai',
        model: 'mock-model',
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    }));
    const clock = new AxManualEventClock(NOW);
    const store = new AxInMemoryLearningStore({ clock });
    const surface = await axLearningSurface({
      scenario: 'support',
      store,
      clock,
      seed: SEED,
      idFactory: ids('rel'),
    });
    const ai = new AxMockAIService({
      features: { functions: false, streaming: false },
      chatResponse: chat,
    });
    const a = agent('query:string -> answer:string', {
      ai,
      learning: { scenario: 'support', store, surface, clock },
    });
    a.learn().suspendRecording();
    await expect(a.learn().run(ai, { query: 'x' })).rejects.toThrow(
      AxLearningSuppressedError
    );
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('currentTree()', () => {
  it('delegates to the surface head', async () => {
    const { a } = await harness();
    const delivery = await a.learn().currentTree();
    expect(delivery?.releaseId).toBe('rel-1');
    expect(delivery?.entries).toHaveLength(1);
  });
});
