import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../../../ai/mock/api.js';
import { agent } from '../../index.js';

const makeModelUsage = () => ({
  ai: 'mock',
  model: 'mock',
  tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const BULLET_MARKER = 'AVOID_BROKEN_HELPER';

/**
 * Scripted mock model for the full playbook.evolve() loop:
 *  - distiller: hands off to the executor.
 *  - executor: errors on a missing helper UNTIL a playbook bullet is applied
 *    (the actor prompt then carries `## Context Playbook`), after which it
 *    finishes cleanly — so accept/reject flows are driven by the real
 *    playbook mutation.
 *  - miner (failure analyst): emits a weakness grounded in the excerpt text.
 *  - responder: answer reflects whether the run recovered.
 * The ACE reflector/curator are spied per-agent (see makeAgent) to add the
 * bullet deterministically.
 */
function evolveScriptedAI() {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      const systemPrompt = String(req.chatPrompt[0]?.content ?? '');
      const userText = req.chatPrompt
        .filter((m) => m.role === 'user')
        .map((m) => String(m.content ?? ''))
        .join('\n');
      const reply = (content: string) => ({
        results: [{ index: 0, content, finishReason: 'stop' as const }],
        modelUsage: makeModelUsage() as any,
      });
      if (systemPrompt.includes('You (`distiller`)')) {
        return reply('Javascript Code: await final("Answer the question", {})');
      }
      if (systemPrompt.includes('You (`executor`)')) {
        if (systemPrompt.includes('## Context Playbook')) {
          return reply(
            'Javascript Code: await final("Answer the question", { note: "fixed" })'
          );
        }
        if (userText.includes('brokenHelper is not defined')) {
          return reply(
            'Javascript Code: await final("Answer the question", { note: "gave up" })'
          );
        }
        return reply('Javascript Code: console.log(brokenHelper())');
      }
      if (systemPrompt.includes('failure analyst')) {
        return reply(
          [
            'Weakness Description: The actor calls an undeclared helper.',
            'Root Cause: Generated code references brokenHelper, which does not exist in the runtime.',
            `Proposed Guidance: ${BULLET_MARKER}: never call undeclared helpers; compute inline.`,
            'Evidence Quotes: ["brokenHelper is not defined"]',
          ].join('\n')
        );
      }
      return reply(
        userText.includes('fixed') ? 'Answer: ok-fixed' : 'Answer: gave-up'
      );
    },
  });
}

const TASKS = [
  { input: { question: 'q1' }, criteria: 'answers correctly', id: 't1' },
  { input: { question: 'q2' }, criteria: 'answers correctly', id: 't2' },
];

const scoreByAnswer = async ({ prediction }: any) =>
  prediction?.output?.answer === 'ok-fixed' ? 1 : 0.2;

/**
 * Build an agent with an attached (non-learning) playbook whose ACE
 * reflector/curator are stubbed to add one marker bullet — so an accepted
 * proposal deterministically flips the executor onto the good path.
 */
function makeAgent() {
  const ai = evolveScriptedAI();
  const ag = agent('question:string -> answer:string', {
    ai,
    directResponse: 'off',
    playbook: { learn: false },
    maxTurns: 4,
  }) as any;
  const engine: any = (ag.getPlaybook().inner as any).engine;
  engine.getOrCreateReflectorProgram().forward = async () => ({
    reasoning: 'r',
    errorIdentification: 'e',
    rootCauseAnalysis: 'rc',
    correctApproach: 'c',
    keyInsight: 'k',
    bulletTags: [],
  });
  engine.getOrCreateCuratorProgram().forward = async () => ({
    operations: [
      {
        type: 'ADD',
        section: 'failures_to_avoid',
        content: `${BULLET_MARKER}: compute inline; never call undeclared helpers.`,
      },
    ],
  });
  return { ag, ai };
}

const actorPromptOf = (ag: any): string =>
  (ag.executor as any).actorProgram?.getSignature?.().getDescription?.() ?? '';

const RETENTION_TASKS = [
  {
    name: 'legacy-refunds',
    version: '2026-07',
    tasks: [
      {
        input: { question: 'old refund workflow' },
        criteria: 'preserves the historical workflow',
        id: 'history-refunds',
      },
    ],
  },
  {
    name: 'legacy-routing',
    version: '3',
    tasks: [
      {
        input: { question: 'old routing workflow' },
        criteria: 'preserves the historical workflow',
        id: 'history-routing',
      },
    ],
  },
] as const;

const retentionMetric =
  (candidateHistoricalScores: Readonly<Record<string, number>>) =>
  async ({ example, prediction }: any) => {
    const fixed = prediction?.output?.answer === 'ok-fixed';
    if (String(example.id).startsWith('history-')) {
      return fixed ? (candidateHistoricalScores[example.id] ?? 0) : 1;
    }
    return fixed ? 1 : 0.2;
  };

const retentionPolicy = (stabilityLimit: number) => ({
  slices: RETENTION_TASKS,
  minCurrentGain: 0.5,
  maxWorstHistoricalLoss: stabilityLimit,
  maxMeanHistoricalLoss: stabilityLimit,
});

describe('agent.playbook().evolve()', () => {
  it('mines the weakness, accepts a verified playbook bullet, and improves held-in', async () => {
    const { ag } = makeAgent();
    const events: string[] = [];
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: [TASKS[0]!] },
      {
        metric: scoreByAnswer,
        maxProposals: 2,
        onProgress: (e: any) => void events.push(`${e.phase}:${e.message}`),
      }
    );

    expect(result.baseline.heldIn).toBeCloseTo(0.2);
    expect(result.weaknesses).toHaveLength(1);
    expect(result.weaknesses[0]?.evidenceQuotes).toEqual([
      'brokenHelper is not defined',
    ]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.accepted).toBe(true);
    expect(result.outcomes[0]?.heldOut).toBeDefined();
    expect(result.final.heldIn).toBe(1);
    expect(result.final.heldOut).toBe(1);
    expect(actorPromptOf(ag)).toContain(BULLET_MARKER);
    expect(result.playbookSnapshot).toBeDefined();
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(1);
    expect(result.metricCallsUsed).toBeGreaterThan(0);
    expect(events.some((e) => e.startsWith('mining'))).toBe(true);
  });

  it('rejects a non-improving proposal and rolls the playbook back exactly', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: async () => 0.2, // never rewards the fix → gain gate fails
      maxProposals: 1,
    });
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.outcomes[0]?.reason).toContain('held-in gain');
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
    expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    expect(result.final.heldIn).toBeCloseTo(result.baseline.heldIn);
  });

  it('rejects when the held-out set regresses even though held-in improves', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: [{ ...TASKS[0]!, id: 'holdout' }] },
      {
        metric: async ({ example, prediction }: any) =>
          example.id === 'holdout'
            ? prediction?.output?.answer === 'ok-fixed'
              ? 0 // the "fix" tanks the held-out task
              : 1
            : prediction?.output?.answer === 'ok-fixed'
              ? 1
              : 0.2,
        maxProposals: 1,
      }
    );
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.outcomes[0]?.reason).toContain('held-out regressed');
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('apply: false rolls the accepted bullet back but returns the snapshot', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      apply: false,
    });
    expect(result.outcomes[0]?.accepted).toBe(true);
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
    expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    expect(result.playbookSnapshot?.playbook.stats.bulletCount).toBeGreaterThan(
      0
    );
  });

  it('verify: false applies the mined lesson without the gate (trust-batch)', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: async () => 0.2, // would fail the gate, but verify is off
      maxProposals: 1,
      verify: false,
    });
    expect(result.outcomes[0]?.accepted).toBe(true);
    expect(result.outcomes[0]?.reason).toContain('without verification');
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(1);
    expect(actorPromptOf(ag)).toContain(BULLET_MARKER);
  });

  it('skips validation when the metric budget is exhausted', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      maxMetricCalls: 2, // baseline only
    });
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.outcomes[0]?.reason).toContain('metric_budget');
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('throws without train tasks and without any AI', async () => {
    const { ag } = makeAgent();
    await expect(ag.playbook().evolve({ train: [] })).rejects.toThrow(
      /at least one training task/
    );
    // A bare agent cannot build a playbook handle at all.
    const bare = agent('question:string -> answer:string', {
      ai: undefined as any,
    }) as any;
    expect(() => bare.playbook()).toThrow(/studentAI is required/);
  });

  describe('retention policy', () => {
    it('removes a harmful current-only promotion and rolls back exactly', async () => {
      const metric = retentionMetric({
        'history-refunds': 0.7,
        'history-routing': 0.9,
      });
      const { ag: baselineAgent } = makeAgent();
      const baselineStartedAt = performance.now();
      const currentOnly = await baselineAgent.playbook().evolve(TASKS, {
        metric,
        maxProposals: 1,
      });
      const baselineMs = performance.now() - baselineStartedAt;

      expect(currentOnly.outcomes[0]?.accepted).toBe(true);
      expect(currentOnly.metricCallsUsed).toBe(4);

      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();
      const retentionStartedAt = performance.now();
      const result = await ag.playbook().evolve(TASKS, {
        metric,
        maxProposals: 1,
        retentionPolicy: retentionPolicy(0.15),
      });
      const retentionMs = performance.now() - retentionStartedAt;

      if (process.env.AX_PRINT_METRICS) {
        console.log(
          JSON.stringify({
            currentOnly: {
              accepted: true,
              metricCalls: currentOnly.metricCallsUsed,
              elapsedMs: Number(baselineMs.toFixed(2)),
            },
            stabilityPolicy: {
              accepted: false,
              metricCalls: result.metricCallsUsed,
              elapsedMs: Number(retentionMs.toFixed(2)),
            },
            falsePromotions: { currentOnly: 1, stabilityPolicy: 0 },
            metricCallOverhead:
              result.metricCallsUsed - currentOnly.metricCallsUsed,
          })
        );
      }

      expect(result.metricCallsUsed).toBe(8);
      expect(result.retentionAnchors).toEqual([
        {
          name: 'legacy-refunds',
          version: '2026-07',
          taskCount: 1,
          score: 1,
          evidence: { executedRuns: 1, expectedRuns: 1, complete: true },
        },
        {
          name: 'legacy-routing',
          version: '3',
          taskCount: 1,
          score: 1,
          evidence: { executedRuns: 1, expectedRuns: 1, complete: true },
        },
      ]);
      expect(result.outcomes[0]?.accepted).toBe(false);
      const receipt = result.outcomes[0]?.retention;
      expect(receipt).toMatchObject({
        currentTask: { before: 0.2, after: 1, gain: 0.8 },
        accepted: false,
        slices: [
          {
            name: 'legacy-refunds',
            version: '2026-07',
            anchorScore: 1,
            candidateScore: 0.7,
            anchorEvidence: {
              executedRuns: 1,
              expectedRuns: 1,
              complete: true,
            },
            candidateEvidence: {
              executedRuns: 1,
              expectedRuns: 1,
              complete: true,
            },
          },
          {
            name: 'legacy-routing',
            version: '3',
            anchorScore: 1,
            candidateScore: 0.9,
          },
        ],
      });
      expect(receipt?.worstHistoricalLoss).toBeCloseTo(0.3);
      expect(receipt?.meanHistoricalLoss).toBeCloseTo(0.2);
      expect(receipt?.slices[0]?.historicalLoss).toBeCloseTo(0.3);
      expect(receipt?.slices[1]?.historicalLoss).toBeCloseTo(0.1);
      expect(ag.getPlaybook().toJSON()).toEqual(before);
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    });

    it('accepts the same candidate under an explicit plasticity-favoring policy', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({
          'history-refunds': 0.7,
          'history-routing': 0.9,
        }),
        maxProposals: 1,
        retentionPolicy: retentionPolicy(0.35),
      });

      expect(result.outcomes[0]?.accepted).toBe(true);
      expect(result.outcomes[0]?.retention?.accepted).toBe(true);
      expect(result.outcomes[0]?.retention?.worstHistoricalLoss).toBeCloseTo(
        0.3
      );
      expect(actorPromptOf(ag)).toContain(BULLET_MARKER);
    });

    it('enforces the mean historical-loss threshold independently', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({
          'history-refunds': 0.8,
          'history-routing': 0.9,
        }),
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(0.25),
          maxMeanHistoricalLoss: 0.1,
        },
      });

      expect(result.outcomes[0]?.retention?.worstHistoricalLoss).toBeCloseTo(
        0.2
      );
      expect(result.outcomes[0]?.retention?.meanHistoricalLoss).toBeCloseTo(
        0.15
      );
      expect(result.outcomes[0]?.accepted).toBe(false);
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    });

    it('rejects a no-benefit candidate even when historical slices improve', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: async ({ example, prediction }: any) => {
          const fixed = prediction?.output?.answer === 'ok-fixed';
          return String(example.id).startsWith('history-')
            ? fixed
              ? 1
              : 0.8
            : fixed
              ? 0.22
              : 0.2;
        },
        maxProposals: 1,
        retentionPolicy: retentionPolicy(0),
      });

      expect(result.outcomes[0]?.accepted).toBe(false);
      expect(result.outcomes[0]?.reason).toContain('current-task gain');
      const receipt = result.outcomes[0]?.retention;
      expect(receipt).toMatchObject({
        currentTask: { before: 0.2, after: 0.22 },
        accepted: false,
      });
      expect(receipt?.currentTask.gain).toBeCloseTo(0.02);
      expect(receipt?.worstHistoricalLoss).toBeCloseTo(-0.2);
      expect(receipt?.meanHistoricalLoss).toBeCloseTo(-0.2);
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    });

    it('rejects a noisy candidate whose repeated current-task mean is insufficient', async () => {
      const { ag } = makeAgent();
      let candidateCurrentRun = 0;
      const result = await ag.playbook().evolve(TASKS, {
        metric: async ({ example, prediction }: any) => {
          const fixed = prediction?.output?.answer === 'ok-fixed';
          if (String(example.id).startsWith('history-')) return 1;
          if (!fixed) return 0.2;
          return candidateCurrentRun++ % 2 === 0 ? 1 : 0;
        },
        maxProposals: 1,
        runsPerTask: 2,
        retentionPolicy: retentionPolicy(0),
      });

      expect(result.metricCallsUsed).toBe(16);
      expect(result.outcomes[0]?.accepted).toBe(false);
      expect(result.outcomes[0]?.retention?.currentTask).toMatchObject({
        before: 0.2,
        after: 0.5,
      });
      expect(result.outcomes[0]?.reason).toContain('current-task gain');
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    });

    it('fails closed before mutation when the budget cannot establish complete anchors', async () => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();
      await expect(
        ag.playbook().evolve(TASKS, {
          metric: retentionMetric({}),
          maxProposals: 1,
          runsPerTask: 2,
          maxMetricCalls: 7,
          retentionPolicy: retentionPolicy(0.1),
        })
      ).rejects.toThrow(/cannot establish complete retention anchors/);
      expect(ag.getPlaybook().toJSON()).toEqual(before);
    });

    it('rejects invalid candidate evidence without emitting a promotion receipt', async () => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();
      const result = await ag.playbook().evolve(TASKS, {
        metric: async ({ example, prediction }: any) => {
          const fixed = prediction?.output?.answer === 'ok-fixed';
          if (fixed && String(example.id).startsWith('history-')) {
            return Number.NaN;
          }
          return fixed
            ? 1
            : String(example.id).startsWith('history-')
              ? 1
              : 0.2;
        },
        maxProposals: 1,
        retentionPolicy: retentionPolicy(0.5),
      });

      expect(result.outcomes[0]).toMatchObject({
        accepted: false,
        reason: 'retention evaluation produced invalid evaluator evidence',
      });
      expect(result.outcomes[0]?.retention).toBeUndefined();
      expect(ag.getPlaybook().toJSON()).toEqual(before);
    });

    it('fails before mining or mutation when an anchor metric is invalid', async () => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();

      await expect(
        ag.playbook().evolve(TASKS, {
          metric: async ({ example }: any) =>
            example.id === 'history-refunds' ? Number.NaN : 0.2,
          maxProposals: 1,
          retentionPolicy: retentionPolicy(0.5),
        })
      ).rejects.toThrow(/requires complete, finite evaluator evidence/);

      expect(ag.getPlaybook().toJSON()).toEqual(before);
    });

    it('rolls back exactly when aborted between candidate retention slices', async () => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();
      const controller = new AbortController();

      await expect(
        ag.playbook().evolve(TASKS, {
          metric: async ({ example, prediction }: any) => {
            const fixed = prediction?.output?.answer === 'ok-fixed';
            if (
              fixed &&
              example.id === 'history-refunds' &&
              !controller.signal.aborted
            ) {
              controller.abort();
            }
            return fixed
              ? 1
              : String(example.id).startsWith('history-')
                ? 1
                : 0.2;
          },
          maxProposals: 1,
          abortSignal: controller.signal,
          retentionPolicy: retentionPolicy(0.5),
        })
      ).rejects.toThrow(/aborted/);

      expect(ag.getPlaybook().toJSON()).toEqual(before);
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    });

    it('rejects invalid policy authority and identity configurations', async () => {
      const { ag } = makeAgent();
      await expect(
        ag.playbook().evolve(TASKS, {
          metric: scoreByAnswer,
          verify: false,
          retentionPolicy: retentionPolicy(0.1),
        })
      ).rejects.toThrow(/requires verify: true/);
      await expect(
        ag.playbook().evolve(TASKS, {
          metric: scoreByAnswer,
          retentionPolicy: {
            ...retentionPolicy(0.1),
            slices: [RETENTION_TASKS[0], RETENTION_TASKS[0]],
          },
        })
      ).rejects.toThrow(/duplicate retention slice/);
      await expect(
        ag.playbook().evolve(TASKS, {
          metric: scoreByAnswer,
          retentionPolicy: {
            ...retentionPolicy(0.1),
            maxMeanHistoricalLoss: Number.NaN,
          },
        })
      ).rejects.toThrow(/must be finite and non-negative/);
      await expect(
        ag.playbook().evolve(TASKS, {
          metric: scoreByAnswer,
          retentionPolicy: {
            ...retentionPolicy(0.1),
            slices: [
              {
                ...RETENTION_TASKS[0],
                tasks: [{ ...RETENTION_TASKS[0].tasks[0], weight: -1 }],
              },
            ],
          },
        })
      ).rejects.toThrow(/task weights must be finite and non-negative/);
    });
  });
});
