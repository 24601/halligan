import { describe, expect, it, vi } from 'vitest';
import { AxMockAIService } from '../../../ai/mock/api.js';
import { agent } from '../../index.js';
import { evolveAgentPlaybook } from './playbookEvolve.js';

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
const VALIDATION_TASKS = [
  { input: { question: 'q3' }, criteria: 'answers correctly', id: 'v1' },
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
  evaluatorId: 'fixture-metric-v1',
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
    const acceptedBullet = Object.values(
      ag.getPlaybook().getState().playbook.sections
    ).flat()[0];
    expect(acceptedBullet?.evidence).toMatchObject({
      provenance: [{ source: 'agent-evolve' }],
      verification: [{ verifierId: 'agent.playbook.evolve', result: 'passed' }],
    });
    expect(result.metricCallsUsed).toBeGreaterThan(0);
    expect(events.some((e) => e.startsWith('mining'))).toBe(true);
  });

  it('keeps the permissive default when no held-out set is provided', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
    });
    expect(result.outcomes[0]).toMatchObject({
      status: 'accepted',
      accepted: true,
      reason: 'held-in improved (no held-out set provided — consider one)',
    });
  });

  it.each([
    ['missing', TASKS],
    ['empty', { train: TASKS, validation: [] }],
  ])(
    'rejects a %s held-out set before evaluation when required',
    async (_, data) => {
      const { ag } = makeAgent();
      let metricCalls = 0;
      await expect(
        ag.playbook().evolve(data, {
          requireHeldOut: true,
          metric: async (args: any) => {
            metricCalls++;
            return scoreByAnswer(args);
          },
        })
      ).rejects.toThrow(/requires a non-empty validation set/);
      expect(metricCalls).toBe(0);
      expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
    }
  );

  it('rejects semantic train/held-out overlap before evaluation', async () => {
    const { ag } = makeAgent();
    await expect(
      ag
        .playbook()
        .evolve(
          { train: TASKS, validation: [{ ...TASKS[0] }] },
          { requireHeldOut: true, metric: scoreByAnswer }
        )
    ).rejects.toThrow(/overlapping task id\(s\): t1/);
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('requires semantic ids and accepts an explicit taskId selector', async () => {
    const withoutIds = [...TASKS, ...VALIDATION_TASKS].map(
      ({ id: _, ...task }) => task
    );
    const { ag: missingIdAgent } = makeAgent();
    await expect(
      missingIdAgent
        .playbook()
        .evolve(
          { train: withoutIds.slice(0, 2), validation: withoutIds.slice(2) },
          { requireHeldOut: true, metric: scoreByAnswer }
        )
    ).rejects.toThrow(/has no semantic task id/);

    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: withoutIds.slice(0, 2), validation: withoutIds.slice(2) },
      {
        requireHeldOut: true,
        taskId: (task: any) => task.input.question,
        metric: scoreByAnswer,
        maxProposals: 1,
      }
    );
    expect(result.outcomes[0]).toMatchObject({
      status: 'accepted',
      accepted: true,
      reason: 'held-in improved, held-out non-regressing',
    });
  });

  it('accepts held-in improvement with complete non-regressing held-out evidence', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        requireHeldOut: true,
        metric: scoreByAnswer,
        maxProposals: 1,
      }
    );
    expect(result.outcomes[0]).toMatchObject({
      status: 'accepted',
      accepted: true,
      reason: 'held-in improved, held-out non-regressing',
      heldOut: { before: 0.2, after: 1 },
    });
  });

  it.each([
    ['errored', () => Promise.reject(new Error('judge unavailable'))],
    ['incomplete', () => Promise.resolve(Number.NaN)],
  ])(
    'fails before mutation when held-out baseline evaluation is %s',
    async (_, failMetric) => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().getState();
      await expect(
        ag.playbook().evolve(
          { train: TASKS, validation: VALIDATION_TASKS },
          {
            requireHeldOut: true,
            metric: async (args: any) =>
              args.example.id === 'v1' ? failMetric() : scoreByAnswer(args),
            maxProposals: 1,
          }
        )
      ).rejects.toThrow(
        /held-out baseline evaluation was incomplete or errored/
      );
      expect(ag.getPlaybook().getState()).toEqual(before);
    }
  );

  it.each([
    [
      'non-finite held-in weight',
      [{ ...TASKS[0]!, weight: Number.POSITIVE_INFINITY }],
      VALIDATION_TASKS,
      /held-in baseline evaluation was incomplete or errored/,
    ],
    [
      'zero held-in total weight',
      [{ ...TASKS[0]!, weight: 0 }],
      VALIDATION_TASKS,
      /held-in baseline evaluation was incomplete or errored/,
    ],
    [
      'non-finite held-out weight',
      TASKS,
      [{ ...VALIDATION_TASKS[0]!, weight: Number.POSITIVE_INFINITY }],
      /held-out baseline evaluation was incomplete or errored/,
    ],
  ])(
    'fails before proposal mutation for a %s',
    async (_, train, validation, expected) => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().getState();
      await expect(
        ag.playbook().evolve(
          { train, validation },
          {
            requireHeldOut: true,
            metric: scoreByAnswer,
            maxProposals: 1,
          }
        )
      ).rejects.toThrow(expected);
      expect(ag.getPlaybook().getState()).toEqual(before);
    }
  );

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

  it('restores the exact snapshot when playbook update mutates then throws', async () => {
    const { ag } = makeAgent();
    const before = structuredClone(ag.getPlaybook().toJSON());
    const beforePrompt = actorPromptOf(ag);
    const handle = ag.getPlaybook().inner;
    const update = handle.update.bind(handle);
    vi.spyOn(handle, 'update').mockImplementation(async (args: any) => {
      await update(args);
      throw new Error('post-mutation failure');
    });

    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
    });

    expect(result.outcomes[0]).toMatchObject({
      accepted: false,
      reason: 'apply failed: post-mutation failure',
    });
    expect(ag.getPlaybook().toJSON()).toEqual(before);
    expect(actorPromptOf(ag)).toBe(beforePrompt);
    expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
  });

  it('fails closed when a mutated playbook cannot be restored after update failure', async () => {
    const { ag } = makeAgent();
    const handle = ag.getPlaybook().inner;
    const update = handle.update.bind(handle);
    const updateError = new Error('post-mutation failure');
    const rollbackError = new Error('snapshot restoration failure');
    vi.spyOn(handle, 'update').mockImplementation(async (args: any) => {
      await update(args);
      throw updateError;
    });
    const load = vi.spyOn(handle, 'load').mockImplementation(() => {
      throw rollbackError;
    });

    try {
      await ag.playbook().evolve(TASKS, {
        metric: scoreByAnswer,
        maxProposals: 1,
      });
      throw new Error('expected evolve to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        updateError,
        rollbackError,
      ]);
    }
    expect(load).toHaveBeenCalledTimes(1);
    expect(actorPromptOf(ag)).toContain(BULLET_MARKER);
  });

  it('attempts a rejected candidate rollback only once', async () => {
    const { ag } = makeAgent();
    const rollbackError = new Error('rollback failure');
    const load = vi
      .spyOn(ag.getPlaybook().inner, 'load')
      .mockImplementation(() => {
        throw rollbackError;
      });

    await expect(
      ag.playbook().evolve(TASKS, {
        metric: async () => 0.2,
        maxProposals: 1,
      })
    ).rejects.toBe(rollbackError);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects when the held-out set regresses even though held-in improves', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: [{ ...TASKS[0]!, id: 'holdout' }] },
      {
        requireHeldOut: true,
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
    expect(result.outcomes[0]?.status).toBe('rejected');
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.outcomes[0]?.reason).toContain('held-out regressed');
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('apply: false rolls the accepted bullet back but returns the snapshot', async () => {
    const { ag } = makeAgent();
    const before = ag.getPlaybook().getState();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        requireHeldOut: true,
        metric: scoreByAnswer,
        maxProposals: 1,
        apply: false,
      }
    );
    expect(result.outcomes[0]?.accepted).toBe(true);
    expect(ag.getPlaybook().getState()).toEqual(before);
    expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    expect(result.playbookSnapshot?.playbook.stats.bulletCount).toBeGreaterThan(
      0
    );
  });

  it.each([
    [
      'numeric task.id',
      {
        train: [{ ...TASKS[0]!, id: 0 as unknown as string }],
        validation: VALIDATION_TASKS,
      },
      undefined,
    ],
    [
      'numeric taskId result',
      { train: TASKS, validation: VALIDATION_TASKS },
      () => 0 as unknown as string,
    ],
    [
      'object taskId result',
      { train: TASKS, validation: VALIDATION_TASKS },
      () => ({ id: 'task' }) as unknown as string,
    ],
  ])('rejects a %s with the semantic-ID error', async (_, dataset, taskId) => {
    const { ag } = makeAgent();
    await expect(
      ag.playbook().evolve(dataset, {
        requireHeldOut: true,
        metric: scoreByAnswer,
        ...(taskId ? { taskId } : {}),
      })
    ).rejects.toThrow(/has no semantic task id/);
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

  it('does not allow verify: false to bypass required held-out promotion', async () => {
    const { ag } = makeAgent();
    await expect(
      ag.playbook().evolve(
        { train: TASKS, validation: VALIDATION_TASKS },
        {
          requireHeldOut: true,
          verify: false,
          metric: scoreByAnswer,
        }
      )
    ).rejects.toThrow(/cannot be combined with verify: false/);
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
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

  it('fails before evaluation when strict budget cannot cover baseline plus candidate', async () => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    await expect(
      ag.playbook().evolve(
        { train: TASKS, validation: VALIDATION_TASKS },
        {
          requireHeldOut: true,
          metric: async (args: any) => {
            metricCalls++;
            return scoreByAnswer(args);
          },
          maxProposals: 1,
          maxMetricCalls: 5,
        }
      )
    ).rejects.toThrow(/needs at least 6 metric calls/);
    expect(metricCalls).toBe(0);
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it.each([
    ['errored', () => Promise.reject(new Error('judge unavailable'))],
    ['incomplete', () => Promise.resolve(Number.NaN)],
  ])(
    'rejects and rolls back when candidate held-out evaluation is %s',
    async (_, failMetric) => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().getState();
      const result = await ag.playbook().evolve(
        { train: TASKS, validation: VALIDATION_TASKS },
        {
          requireHeldOut: true,
          metric: async (args: any) => {
            if (
              args.example.id === 'v1' &&
              args.prediction?.output?.answer === 'ok-fixed'
            ) {
              return failMetric();
            }
            return scoreByAnswer(args);
          },
          maxProposals: 1,
        }
      );
      expect(result.outcomes[0]).toMatchObject({
        status: 'rejected',
        accepted: false,
        reason: 'held-out evaluation incomplete or errored',
      });
      expect(ag.getPlaybook().getState()).toEqual(before);
    }
  );

  it('rejects candidate weighted-aggregate overflow with exact rollback', async () => {
    const { ag } = makeAgent();
    const before = ag.getPlaybook().getState();
    const result = await ag.playbook().evolve(
      {
        train: TASKS,
        validation: [{ ...VALIDATION_TASKS[0]!, weight: Number.MAX_VALUE }],
      },
      {
        requireHeldOut: true,
        metric: async ({ example, prediction }: any) =>
          example.id === 'v1' && prediction?.output?.answer === 'ok-fixed'
            ? 2
            : scoreByAnswer({ prediction }),
        maxProposals: 1,
      }
    );
    expect(result.outcomes[0]).toMatchObject({
      status: 'rejected',
      accepted: false,
      reason: 'held-out evaluation incomplete or errored',
    });
    expect(result.outcomes[0]?.heldOut?.after).toBe(Number.POSITIVE_INFINITY);
    expect(ag.getPlaybook().getState()).toEqual(before);
  });

  it('requires and accepts complete evidence across repeated runs', async () => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        requireHeldOut: true,
        metric: async (args: any) => {
          metricCalls++;
          if (metricCalls === 2) return 0;
          return scoreByAnswer(args);
        },
        runsPerTask: 2,
        maxProposals: 1,
      }
    );
    expect(result.outcomes[0]?.status).toBe('accepted');
    expect(result.metricCallsUsed).toBe(12);
    expect(metricCalls).toBe(12);
  });

  it.each([
    [
      'held-in',
      'rejects',
      't1',
      () => Promise.reject(new Error('judge unavailable')),
    ],
    ['held-in', 'returns NaN', 't1', () => Promise.resolve(Number.NaN)],
    [
      'held-out',
      'rejects',
      'v1',
      () => Promise.reject(new Error('judge unavailable')),
    ],
    ['held-out', 'returns NaN', 'v1', () => Promise.resolve(Number.NaN)],
  ])(
    'rejects with the %s incomplete reason when a second repeat %s',
    async (split, _, failingTaskId, failMetric) => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().getState();
      const candidateRepeats = new Map<string, number>();
      const result = await ag.playbook().evolve(
        { train: TASKS, validation: VALIDATION_TASKS },
        {
          requireHeldOut: true,
          metric: async (args: any) => {
            if (args.prediction?.output?.answer === 'ok-fixed') {
              const repeat = (candidateRepeats.get(args.example.id) ?? 0) + 1;
              candidateRepeats.set(args.example.id, repeat);
              if (args.example.id === failingTaskId && repeat === 2) {
                return failMetric();
              }
            }
            return scoreByAnswer(args);
          },
          runsPerTask: 2,
          maxProposals: 1,
        }
      );
      expect(result.outcomes[0]).toMatchObject({
        status: 'rejected',
        accepted: false,
        reason: `${split} evaluation incomplete or errored`,
      });
      expect(candidateRepeats.get(failingTaskId)).toBe(2);
      expect(ag.getPlaybook().getState()).toEqual(before);
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    }
  );

  it.each([
    [
      'during the second candidate revalidation',
      'during-revalidation',
      4,
      /aborted/,
    ],
    ['between accepted candidates', 'between-candidates', 3, /aborted/],
    [
      'when the accepted progress observer throws',
      'observer-throws',
      3,
      /progress observer failed/,
    ],
    [
      'when accepted evidence recording throws',
      'evidence-throws',
      3,
      /evidence recorder failed/,
    ],
  ] as const)(
    'restores the live playbook byte-for-byte when apply:false fails %s',
    async (_, abortWhen, expectedCandidateMetricCalls, expectedError) => {
      const controller = new AbortController();
      const ai = new AxMockAIService({
        features: { functions: false, streaming: false },
        chatResponse: async () => ({
          results: [
            {
              index: 0,
              content: [
                'Weakness Description: A distinct baseline failure recurs.',
                'Root Cause: The current playbook lacks the candidate rule.',
                'Proposed Guidance: Apply the candidate rule.',
                'Evidence Quotes: ["deterministic failure evidence"]',
              ].join('\n'),
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: makeModelUsage() as any,
        }),
      });
      let revision = 0;
      let rules: string[] = [];
      let history: { updatedBulletIds: string[] }[] = [];
      let candidateMetricCalls = 0;
      const handle = {
        update: async () => {
          revision++;
          rules = [...rules, `candidate-${revision}`];
          history = [
            ...history,
            { updatedBulletIds: [`candidate-${revision}`] },
          ];
        },
        render: () => rules.join('\n'),
        getState: () => ({
          revision,
          rules: [...rules],
          artifact: {
            history: history.map((entry) => ({
              updatedBulletIds: [...entry.updatedBulletIds],
            })),
          },
        }),
        load: (
          snapshot: Readonly<{
            revision: number;
            rules: string[];
            artifact: { history: { updatedBulletIds: string[] }[] };
          }>
        ) => {
          revision = snapshot.revision;
          rules = [...snapshot.rules];
          history = snapshot.artifact.history.map((entry) => ({
            updatedBulletIds: [...entry.updatedBulletIds],
          }));
        },
        recordEvidence: () => {
          if (abortWhen === 'evidence-throws') {
            throw new Error('evidence recorder failed');
          }
        },
      };
      const self = {
        init: { ai },
        getPlaybook: () => handle,
        _forwardForEvaluation: async (_ai: unknown, task: { id: string }) => ({
          completionType: 'final',
          output: { revision },
          actionLog: 'deterministic failure evidence',
          functionCalls: [],
          toolErrors: revision === 0 ? [`${task.id}: baseline failure`] : [],
          turnCount: 1,
          usage: [],
        }),
      };
      const before = handle.getState();
      const beforeBytes = JSON.stringify(before);

      await expect(
        evolveAgentPlaybook(
          self,
          {
            train: [
              { input: { case: 'one' }, criteria: 'pass', id: 'train-1' },
              { input: { case: 'two' }, criteria: 'pass', id: 'train-2' },
            ],
            validation: [
              {
                input: { case: 'held-out' },
                criteria: 'pass',
                id: 'validation',
              },
            ],
          },
          {
            requireHeldOut: true,
            apply: false,
            abortSignal: controller.signal,
            maxProposals: 2,
            metric: async ({ prediction }: any) => {
              if (prediction.output.revision > 0) {
                candidateMetricCalls++;
                if (
                  abortWhen === 'during-revalidation' &&
                  prediction.output.revision === 2 &&
                  candidateMetricCalls === 4
                ) {
                  controller.abort('abort second candidate revalidation');
                }
                return 1;
              }
              return 0;
            },
            onProgress: ({ phase, message }) => {
              if (phase === 'validation' && message.endsWith(': ACCEPTED')) {
                if (abortWhen === 'between-candidates') {
                  controller.abort('abort between accepted candidates');
                } else if (abortWhen === 'observer-throws') {
                  throw new Error('progress observer failed');
                }
              }
            },
          }
        )
      ).rejects.toThrow(expectedError);

      expect(candidateMetricCalls).toBe(expectedCandidateMetricCalls);
      expect(handle.getState()).toEqual(before);
      expect(JSON.stringify(handle.getState())).toBe(beforeBytes);
      expect(handle.render()).toBe('');
    }
  );

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
        const currentOnlyAccepted = currentOnly.outcomes[0]?.accepted === true;
        const stabilityAccepted = result.outcomes[0]?.accepted === true;
        const measuredHistoricalRegression =
          (result.outcomes[0]?.retention?.worstHistoricalLoss ?? 0) > 0;
        console.log(
          JSON.stringify({
            currentOnly: {
              accepted: currentOnlyAccepted,
              metricCalls: currentOnly.metricCallsUsed,
              elapsedMs: Number(baselineMs.toFixed(2)),
            },
            stabilityPolicy: {
              accepted: stabilityAccepted,
              metricCalls: result.metricCallsUsed,
              elapsedMs: Number(retentionMs.toFixed(2)),
            },
            falsePromotions: {
              currentOnly: Number(
                currentOnlyAccepted && measuredHistoricalRegression
              ),
              stabilityPolicy: Number(
                stabilityAccepted && measuredHistoricalRegression
              ),
            },
            metricCallOverhead:
              result.metricCallsUsed - currentOnly.metricCallsUsed,
          })
        );
      }

      expect(result.metricCallsUsed).toBe(8);
      expect(result.retentionAnchors).toMatchObject([
        {
          name: 'legacy-refunds',
          version: '2026-07',
          taskCount: 1,
          evaluatorId: 'fixture-metric-v1',
          sequence: 2,
          score: 1,
          evidence: { executedRuns: 1, expectedRuns: 1, complete: true },
        },
        {
          name: 'legacy-routing',
          version: '3',
          taskCount: 1,
          evaluatorId: 'fixture-metric-v1',
          sequence: 3,
          score: 1,
          evidence: { executedRuns: 1, expectedRuns: 1, complete: true },
        },
      ]);
      expect(result.outcomes[0]?.accepted).toBe(false);
      const receipt = result.outcomes[0]?.retention;
      expect(receipt).toMatchObject({
        policy: { evaluatorId: 'fixture-metric-v1' },
        sequence: 7,
        currentTask: {
          before: 0.2,
          after: 1,
          gain: 0.8,
          anchorSequence: 1,
          candidateSequence: 4,
        },
        accepted: false,
        slices: [
          {
            name: 'legacy-refunds',
            version: '2026-07',
            anchorScore: 1,
            candidateScore: 0.7,
            anchorSequence: 2,
            candidateSequence: 5,
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
            anchorSequence: 3,
            candidateSequence: 6,
          },
        ],
      });
      expect(receipt?.policy.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
      expect(receipt?.policy.currentTaskSetDigest).toBe(
        receipt?.currentTask.taskSetDigest
      );
      expect(result.retentionAnchors?.[0]?.policyDigest).toBe(
        receipt?.policy.digest
      );
      expect(result.retentionAnchors?.[0]?.taskSetDigest).toBe(
        receipt?.slices[0]?.taskSetDigest
      );
      expect(Object.isFrozen(result.retentionAnchors)).toBe(true);
      expect(Object.isFrozen(result.retentionAnchors?.[0])).toBe(true);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt?.policy)).toBe(true);
      expect(Object.isFrozen(receipt?.slices)).toBe(true);
      expect(receipt?.worstHistoricalLoss).toBeCloseTo(0.3);
      expect(receipt?.meanHistoricalLoss).toBeCloseTo(0.2);
      expect(receipt?.slices[0]?.historicalLoss).toBeCloseTo(0.3);
      expect(receipt?.slices[1]?.historicalLoss).toBeCloseTo(0.1);
      expect(ag.getPlaybook().toJSON()).toEqual(before);
      expect(actorPromptOf(ag)).not.toContain(BULLET_MARKER);
    });

    it('accepts the same candidate under an explicit plasticity-favoring policy', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(
        { train: TASKS, validation: [{ ...TASKS[0]!, id: 'holdout' }] },
        {
          metric: retentionMetric({
            'history-refunds': 0.7,
            'history-routing': 0.9,
          }),
          maxProposals: 1,
          retentionPolicy: retentionPolicy(0.35),
        }
      );

      expect(result.outcomes[0]?.accepted).toBe(true);
      expect(result.outcomes[0]?.retention?.accepted).toBe(true);
      expect(result.outcomes[0]?.retention?.worstHistoricalLoss).toBeCloseTo(
        0.3
      );
      expect(result.outcomes[0]?.retention?.heldOut).toMatchObject({
        anchorSequence: 2,
        candidateSequence: 6,
        anchorEvidence: { complete: true },
        candidateEvidence: { complete: true },
      });
      expect(result.outcomes[0]?.retention?.sequence).toBe(9);
      expect(actorPromptOf(ag)).toContain(BULLET_MARKER);
    });

    it('accepts exact floating-point historical-loss boundaries', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({
          'history-refunds': 0.7,
          'history-routing': 0.9,
        }),
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(0.3),
          maxMeanHistoricalLoss: 0.2,
        },
      });

      expect(result.outcomes[0]?.retention).toMatchObject({
        worstHistoricalLoss: 0.30000000000000004,
        meanHistoricalLoss: 0.2,
        accepted: true,
      });
      expect(result.outcomes[0]?.accepted).toBe(true);
    });

    it('rejects historical loss genuinely above a floating-point boundary', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({
          'history-refunds': 0.699999999999,
          'history-routing': 0.9,
        }),
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(0.3),
          maxMeanHistoricalLoss: 0.3,
        },
      });

      expect(
        result.outcomes[0]?.retention?.worstHistoricalLoss
      ).toBeGreaterThan(0.3);
      expect(result.outcomes[0]?.accepted).toBe(false);
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

    it('rolls back and propagates the candidate evaluator failure as cause', async () => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();
      const evaluatorFailure = new Error('retention evaluator unavailable');

      try {
        await ag.playbook().evolve(TASKS, {
          metric: async ({ example, prediction }: any) => {
            const fixed = prediction?.output?.answer === 'ok-fixed';
            if (fixed && String(example.id).startsWith('history-')) {
              throw evaluatorFailure;
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
        throw new Error('expected evolve to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          'candidate retention evaluation'
        );
        expect((error as Error).cause).toBe(evaluatorFailure);
      }
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

    it('rolls back when the final candidate metric aborts then returns a valid score', async () => {
      const { ag } = makeAgent();
      const before = ag.getPlaybook().toJSON();
      const controller = new AbortController();

      await expect(
        ag.playbook().evolve(TASKS, {
          metric: async ({ example, prediction }: any) => {
            const fixed = prediction?.output?.answer === 'ok-fixed';
            if (
              fixed &&
              example.id === 'history-routing' &&
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

    it('preserves abort and rollback failures without retrying restoration', async () => {
      const { ag } = makeAgent();
      const controller = new AbortController();
      const rollbackError = new Error('abort rollback failure');
      const load = vi
        .spyOn(ag.getPlaybook().inner, 'load')
        .mockImplementation(() => {
          throw rollbackError;
        });

      try {
        await ag.playbook().evolve(TASKS, {
          metric: async ({ example, prediction }: any) => {
            const fixed = prediction?.output?.answer === 'ok-fixed';
            if (
              fixed &&
              example.id === 'history-routing' &&
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
        });
        throw new Error('expected evolve to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        const errors = (error as AggregateError).errors;
        expect(errors).toHaveLength(2);
        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toContain('aborted');
        expect(errors[1]).toBe(rollbackError);
      }
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('uses an immutable policy and task snapshot despite caller mutation', async () => {
      const { ag } = makeAgent();
      const policy = {
        evaluatorId: 'mutation-fixture-v1',
        slices: RETENTION_TASKS.map((slice) => ({
          ...slice,
          tasks: slice.tasks.map((task) => ({ ...task })),
        })),
        minCurrentGain: 0.5,
        maxWorstHistoricalLoss: 0.35,
        maxMeanHistoricalLoss: 0.35,
      };
      let mutated = false;
      const result = await ag.playbook().evolve(TASKS, {
        metric: async ({ example, prediction }: any) => {
          if (!mutated) {
            mutated = true;
            policy.maxWorstHistoricalLoss = 0;
            policy.slices[0]!.tasks[0]!.id = 'caller-mutated';
            policy.slices[0]!.tasks.push({
              input: { question: 'injected task' },
              criteria: 'must not enter the snapshot',
              id: 'caller-injected',
            });
          }
          const fixed = prediction?.output?.answer === 'ok-fixed';
          if (String(example.id).startsWith('history-')) {
            return fixed ? 0.8 : 1;
          }
          return fixed ? 1 : 0.2;
        },
        maxProposals: 1,
        retentionPolicy: policy,
      });

      expect(policy.slices[0]?.tasks).toHaveLength(2);
      expect(result.retentionAnchors?.[0]).toMatchObject({
        taskCount: 1,
        evaluatorId: 'mutation-fixture-v1',
      });
      expect(result.outcomes[0]?.retention).toMatchObject({
        thresholds: { maxWorstHistoricalLoss: 0.35 },
        accepted: true,
      });
      expect(result.outcomes[0]?.retention?.slices).toHaveLength(2);
      expect(result.outcomes[0]?.retention?.slices[0]).toMatchObject({
        taskCount: 1,
      });
    });

    it('canonically digests Date, Map, Set, and typed-array evidence', async () => {
      const mapA = new Map<unknown, unknown>([
        [{ key: 'same' }, 'left'],
        [{ key: 'same' }, 'right'],
      ]);
      const mapB = new Map<unknown, unknown>([
        [{ key: 'same' }, 'right'],
        [{ key: 'same' }, 'left'],
      ]);
      const evidence = (
        date: Date | string,
        map: Map<unknown, unknown>,
        set: Set<unknown>,
        bytes: Uint8Array | Uint16Array
      ) => ({
        input: { question: 'historical', date, map, set, bytes },
        criteria: 'preserves evidence',
        id: 'history-canonical',
      });
      const equivalentA = evidence(
        new Date('2026-08-26T00:00:00.000Z'),
        mapA,
        new Set([{ item: 1 }, { item: 1 }]),
        new Uint8Array([1, 2])
      );
      const equivalentB = evidence(
        new Date('2026-08-26T00:00:00.000Z'),
        mapB,
        new Set([{ item: 1 }, { item: 1 }]),
        new Uint8Array([1, 2])
      );
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({}),
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(1),
          slices: [
            { name: 'equivalent-a', version: '1', tasks: [equivalentA] },
            { name: 'equivalent-b', version: '1', tasks: [equivalentB] },
            {
              name: 'date-string',
              version: '1',
              tasks: [
                evidence(
                  '2026-08-26T00:00:00.000Z',
                  mapA,
                  new Set([{ item: 1 }, { item: 1 }]),
                  new Uint8Array([1, 2])
                ),
              ],
            },
            {
              name: 'set-multiplicity',
              version: '1',
              tasks: [
                evidence(
                  new Date('2026-08-26T00:00:00.000Z'),
                  mapA,
                  new Set([{ item: 1 }]),
                  new Uint8Array([1, 2])
                ),
              ],
            },
            {
              name: 'typed-array-kind',
              version: '1',
              tasks: [
                evidence(
                  new Date('2026-08-26T00:00:00.000Z'),
                  mapA,
                  new Set([{ item: 1 }, { item: 1 }]),
                  new Uint16Array([513])
                ),
              ],
            },
          ],
        },
      });
      const digests = result.retentionAnchors?.map(
        (anchor) => anchor.taskSetDigest
      );

      expect(digests?.[0]).toBe(digests?.[1]);
      expect(digests?.[0]).not.toBe(digests?.[2]);
      expect(digests?.[0]).not.toBe(digests?.[3]);
      expect(digests?.[0]).not.toBe(digests?.[4]);
    });

    it('isolates the canonical corpus from evaluator mutation', async () => {
      const sourceDate = new Date('2026-08-26T00:00:00.000Z');
      const sourceMap = new Map([['original', 1]]);
      const sourceSet = new Set(['original']);
      const sourceBytes = new Uint8Array([1, 2]);
      const observations: unknown[] = [];
      const { ag } = makeAgent();

      await ag.playbook().evolve(TASKS, {
        metric: async ({ example, prediction }: any) => {
          const fixed = prediction?.output?.answer === 'ok-fixed';
          if (example.id === 'history-mutable') {
            const input = example.input;
            observations.push({
              date: input.date.toISOString(),
              map: [...input.map.entries()],
              set: [...input.set],
              bytes: [...input.bytes],
            });
            input.date.setUTCFullYear(2030);
            input.map.set('mutated', 2);
            input.set.add('mutated');
            input.bytes[0] = 9;
            return 1;
          }
          return fixed ? 1 : 0.2;
        },
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(0),
          slices: [
            {
              name: 'mutable-evidence',
              version: '1',
              tasks: [
                {
                  input: {
                    question: 'historical',
                    date: sourceDate,
                    map: sourceMap,
                    set: sourceSet,
                    bytes: sourceBytes,
                  },
                  criteria: 'preserves evidence',
                  id: 'history-mutable',
                },
              ],
            },
          ],
        },
      });

      expect(observations).toEqual([
        {
          date: '2026-08-26T00:00:00.000Z',
          map: [['original', 1]],
          set: ['original'],
          bytes: [1, 2],
        },
        {
          date: '2026-08-26T00:00:00.000Z',
          map: [['original', 1]],
          set: ['original'],
          bytes: [1, 2],
        },
      ]);
      expect(sourceDate.toISOString()).toBe('2026-08-26T00:00:00.000Z');
      expect([...sourceMap.entries()]).toEqual([['original', 1]]);
      expect([...sourceSet]).toEqual(['original']);
      expect([...sourceBytes]).toEqual([1, 2]);
    });

    it('distinguishes sparse arrays and enumerable array properties', async () => {
      const empty: unknown[] = [];
      const sparse = Array(1);
      const explicitUndefined = [undefined];
      const extra = [] as unknown[] & { evidence?: string };
      extra.evidence = 'present';
      const task = (array: unknown[]) => ({
        input: { question: 'historical', array },
        criteria: 'preserves evidence',
        id: 'history-array',
      });
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({}),
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(1),
          slices: [
            { name: 'empty', version: '1', tasks: [task(empty)] },
            { name: 'sparse', version: '1', tasks: [task(sparse)] },
            {
              name: 'explicit-undefined',
              version: '1',
              tasks: [task(explicitUndefined)],
            },
            { name: 'extra-property', version: '1', tasks: [task(extra)] },
          ],
        },
      });
      const digests = result.retentionAnchors?.map(
        (anchor) => anchor.taskSetDigest
      );

      expect(new Set(digests).size).toBe(4);
    });

    it('keeps separator-containing slice identities distinct', async () => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(TASKS, {
        metric: retentionMetric({}),
        maxProposals: 1,
        retentionPolicy: {
          ...retentionPolicy(1),
          slices: [
            { ...RETENTION_TASKS[0], name: 'a\0b', version: 'c' },
            { ...RETENTION_TASKS[1], name: 'a', version: 'b\0c' },
          ],
        },
      });

      expect(result.retentionAnchors).toHaveLength(2);
    });

    it('validates held-out weights and omits empty held-out evidence', async () => {
      const { ag } = makeAgent();
      await expect(
        ag.playbook().evolve(
          {
            train: TASKS,
            validation: [{ ...TASKS[0]!, weight: -1 }],
          },
          {
            metric: retentionMetric({}),
            retentionPolicy: retentionPolicy(1),
          }
        )
      ).rejects.toThrow(/retention held-out set task weights/);

      const result = await ag.playbook().evolve(
        { train: TASKS, validation: [] },
        {
          metric: retentionMetric({}),
          maxProposals: 1,
          retentionPolicy: retentionPolicy(1),
        }
      );
      expect(
        result.outcomes[0]?.retention?.policy.heldOutTaskSetDigest
      ).toBeUndefined();
      expect(result.outcomes[0]?.retention?.heldOut).toBeUndefined();
    });

    it('caps an oversized computed metric budget default', async () => {
      const { ag } = makeAgent();
      const controller = new AbortController();
      controller.abort();
      const tasks = Array.from({ length: 2_098 }, (_, index) => ({
        input: { question: `historical-${index}` },
        criteria: 'preserves evidence',
        id: `history-${index}`,
      }));

      await expect(
        ag.playbook().evolve(TASKS, {
          metric: retentionMetric({}),
          runsPerTask: 100,
          abortSignal: controller.signal,
          retentionPolicy: {
            ...retentionPolicy(1),
            slices: [{ name: 'large-corpus', version: '1', tasks }],
          },
        })
      ).rejects.toThrow(/aborted/);
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
            evaluatorId: '',
          },
        })
      ).rejects.toThrow(/evaluatorId must be 1-200 characters/);
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
      for (const [name, value] of [
        ['runsPerTask', Number.NaN],
        ['runsPerTask', Number.POSITIVE_INFINITY],
        ['runsPerTask', 101],
        ['maxMetricCalls', Number.NaN],
        ['maxMetricCalls', Number.POSITIVE_INFINITY],
        ['maxMetricCalls', 1_000_001],
      ] as const) {
        await expect(
          ag.playbook().evolve(TASKS, {
            metric: scoreByAnswer,
            [name]: value,
          })
        ).rejects.toThrow(/positive safe integer/);
      }
    });
  });
});
