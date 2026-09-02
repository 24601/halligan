import { describe, expect, it, vi } from 'vitest';
import { AxMockAIService } from '../../../ai/mock/api.js';
import { agent } from '../../index.js';
import { axIsAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
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

/**
 * Legacy identity (invariant I1). The rest of this suite uses `toMatchObject`,
 * which passes both for an additive field and for a silently CHANGED one, so
 * it cannot catch a legacy regression on its own. These tests strip exactly the
 * new keys and deep-equal the remainder — `records` included — against a
 * checked-in golden object.
 */
describe('agent.playbook().evolve() legacy identity', () => {
  /** Exactly the keys the evidence work adds. Everything else must be equal. */
  const NEW_RESULT_KEYS = [
    'control',
    'accounting',
    'applied',
    'varianceBand',
    'transfer',
    'redundancy',
    'overhead',
    'sealedTest',
    'rolledBackReason',
    'warnings',
  ] as const;
  const NEW_OUTCOME_KEYS = [
    'kind',
    'prune',
    'evictions',
    'evidence',
    'promotion',
  ] as const;

  const stripLegacy = (result: any) => {
    const legacy = { ...result };
    for (const key of NEW_RESULT_KEYS) delete legacy[key];
    legacy.outcomes = result.outcomes.map((outcome: any) => {
      const stripped = { ...outcome };
      for (const key of NEW_OUTCOME_KEYS) delete stripped[key];
      return stripped;
    });
    // `records` is returned verbatim and gains `attempts`; omitting it from the
    // strip list would exclude the largest field from the identity claim.
    legacy.records = result.records.map((record: any) => {
      const stripped = { ...record };
      delete stripped.attempts;
      return stripped;
    });
    return legacy;
  };

  it('keeps every pre-existing result field and call count identical when no evidence option is set', async () => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    let agentRuns = 0;
    const runForEvaluation = (ag as any)._forwardForEvaluation.bind(ag);
    (ag as any)._forwardForEvaluation = async (...args: any[]) => {
      agentRuns++;
      return runForEvaluation(...args);
    };
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: async (args: any) => {
          metricCalls++;
          return scoreByAnswer(args);
        },
        maxProposals: 1,
      }
    );

    // Exact integers, not "greater than": a changed number of agent runs is
    // precisely what a silent legacy regression looks like.
    expect(metricCalls).toBe(6);
    expect(agentRuns).toBe(6);
    expect(result.metricCallsUsed).toBe(6);

    const legacy = stripLegacy(result);
    expect(legacy).toEqual({
      baseline: { heldIn: 0.2, heldOut: 0.2 },
      final: { heldIn: 1, heldOut: 1 },
      weaknesses: result.weaknesses,
      outcomes: [
        {
          proposal: result.outcomes[0]!.proposal,
          status: 'accepted',
          accepted: true,
          reason: 'held-in improved, held-out non-regressing',
          heldIn: { before: 0.2, after: 1 },
          heldOut: { before: 0.2, after: 1 },
        },
      ],
      recommendations: result.recommendations,
      playbookSnapshot: result.playbookSnapshot,
      metricCallsUsed: 6,
      records: [
        {
          task: TASKS[0],
          prediction: result.records[0]!.prediction,
          score: 0.2,
          passed: false,
        },
        {
          task: TASKS[1],
          prediction: result.records[1]!.prediction,
          score: 0.2,
          passed: false,
        },
      ],
    });

    // The new fields take exactly the documented no-option values.
    expect(result.control).toEqual({
      status: 'not_run',
      reason: 'controlArm option not supplied',
    });
    expect(result.applied).toBe('live');
    expect(result.outcomes[0]!.kind).toBe('curate');
    expect(result.outcomes[0]!.evidence).toBeUndefined();
    expect(result.outcomes[0]!.promotion).toBeUndefined();
    expect(result.varianceBand).toBeUndefined();
    expect(result.transfer).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(result.records[0]).not.toHaveProperty('attempts');
  });

  it('keeps record.task reference-identical to the evaluated split', async () => {
    // The paired bootstrap's pairing precondition is reference equality across
    // passes. A future "hardening" that stores `structuredClone(task)` on the
    // record silently turns every interval into `unmeasured` — a data-flow bug
    // that would look like a statistics bug. Without a retention policy the
    // evaluated split IS the caller's array; with one it is the frozen corpus
    // clone, which is created ONCE and reused by every pass (see the harness
    // test that pins the isolateTaskInputs half of this property).
    const { ag } = makeAgent();
    const result = await ag
      .playbook()
      .evolve(
        { train: TASKS, validation: VALIDATION_TASKS },
        { metric: scoreByAnswer, maxProposals: 1 }
      );
    expect(result.records).toHaveLength(TASKS.length);
    for (const [index, record] of result.records.entries()) {
      expect(record.task).toBe(TASKS[index]);
    }

    const { ag: frozen } = makeAgent();
    const withRetention = await frozen.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: retentionMetric({}),
        maxProposals: 1,
        retentionPolicy: retentionPolicy(1),
      }
    );
    // The frozen corpus is a clone of the caller's array, so it is NOT the same
    // object — but it must be frozen and stable, which is what makes every
    // pass in the run pair against the same task objects.
    for (const record of withRetention.records) {
      expect(Object.isFrozen(record.task)).toBe(true);
      expect(record.task).not.toBe(TASKS[0]);
    }
  });

  it('defaults control to a visible not_run rather than omitting it', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
    });
    expect(result).toHaveProperty('control');
    expect(result.control.status).toBe('not_run');
    expect(result.control.reason).toBeTruthy();
  });

  // One case per branch, each its own test: nine full evolve() runs in a
  // single `it` is a wall-clock hazard under parallel load, and the point of
  // the pinning is per-branch anyway.
  it.each([
    [
      'accept without a held-out set',
      TASKS,
      { metric: scoreByAnswer, maxProposals: 1 },
      'held-in improved (no held-out set provided — consider one)',
    ],
    [
      'accept with a held-out set',
      { train: TASKS, validation: VALIDATION_TASKS },
      { metric: scoreByAnswer, maxProposals: 1 },
      'held-in improved, held-out non-regressing',
    ],
    [
      'held-in gain below the threshold',
      TASKS,
      { metric: async () => 0.2, maxProposals: 1 },
      'held-in gain 0.000 below 0.05',
    ],
    [
      'held-out regression',
      { train: TASKS, validation: [{ ...TASKS[0]!, id: 'holdout' }] },
      {
        requireHeldOut: true,
        maxProposals: 1,
        metric: async ({ example, prediction }: any) =>
          example.id === 'holdout'
            ? prediction?.output?.answer === 'ok-fixed'
              ? 0
              : 1
            : prediction?.output?.answer === 'ok-fixed'
              ? 1
              : 0.2,
      },
      'held-out regressed -1.000',
    ],
    [
      'budget exhausted before validation',
      TASKS,
      { metric: scoreByAnswer, maxProposals: 1, maxMetricCalls: 2 },
      'metric_budget exhausted before validation',
    ],
    [
      'retention current-task gain below the policy threshold',
      TASKS,
      {
        metric: async () => 0.2,
        maxProposals: 1,
        retentionPolicy: retentionPolicy(1),
      },
      'current-task gain 0.000 below 0.5',
    ],
    [
      'retention historical loss over the stability threshold',
      TASKS,
      {
        metric: retentionMetric({
          'history-refunds': 0,
          'history-routing': 0,
        }),
        maxProposals: 1,
        retentionPolicy: retentionPolicy(0),
      },
      'historical loss exceeded retention threshold (worst 1.000, mean 1.000)',
    ],
    [
      'accept under a retention policy',
      TASKS,
      {
        metric: retentionMetric({
          'history-refunds': 1,
          'history-routing': 1,
        }),
        maxProposals: 1,
        retentionPolicy: retentionPolicy(1),
      },
      'current task improved, historical retention thresholds satisfied',
    ],
    [
      'trust batch',
      TASKS,
      { metric: scoreByAnswer, maxProposals: 1, verify: false },
      'applied without verification (verify: false)',
    ],
  ])(
    'pins the exact reason string for the %s branch',
    async (_name, data, options, expected) => {
      const { ag } = makeAgent();
      const result = await ag.playbook().evolve(data as any, options as any);
      expect(result.outcomes[0]!.reason).toBe(expected);
    }
  );
});

describe('agent.playbook().evolve() evidence option validation', () => {
  it.each([
    ['gates', { gates: { validity: 'require' } }],
    ['varianceBand', { varianceBand: { extraRepeats: 1 } }],
    ['intervalOptions', { intervalOptions: { resamples: 500 } }],
    ['validity', { validity: { minFinalCompletionRate: 0.9 } }],
    ['reachProbe', { reachProbe: () => undefined }],
    ['conditionsForTask', { conditionsForTask: () => [] }],
    ['classifyTermination', { classifyTermination: () => undefined }],
    ['maxDiscardRedraws', { maxDiscardRedraws: 2 }],
  ])('rejects %s combined with verify: false', async (_name, option) => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    const error = await ag
      .playbook()
      .evolve(TASKS, {
        verify: false,
        metric: async (args: any) => {
          metricCalls++;
          return scoreByAnswer(args);
        },
        ...(option as any),
      })
      .catch((err: unknown) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect((error as any).code).toBe('evidence_requires_verify');
    expect((error as Error).message).toMatch(
      /^AxAgent\.playbook\(\)\.evolve\(\): /
    );
    // Fails closed before any evaluation.
    expect(metricCalls).toBe(0);
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('allows an all-off gates object with verify: false', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      verify: false,
      metric: scoreByAnswer,
      maxProposals: 1,
      gates: { validity: 'off', reach: 'off' },
    });
    expect(result.outcomes[0]?.accepted).toBe(true);
  });

  it('fails closed when a control-arm or transfer gate has no arm to read', async () => {
    for (const [gates, code] of [
      [{ controlArm: 'require' }, 'control_arm_failed'],
      [{ transfer: 'warn' }, 'transfer_target_invalid'],
    ] as const) {
      const { ag } = makeAgent();
      let metricCalls = 0;
      const error = await ag
        .playbook()
        .evolve(TASKS, {
          metric: async (args: any) => {
            metricCalls++;
            return scoreByAnswer(args);
          },
          gates,
        })
        .catch((err: unknown) => err);
      expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
      expect((error as any).code).toBe(code);
      expect(metricCalls).toBe(0);
    }
  });
});

describe('agent.playbook().evolve() compute accounting', () => {
  it('matches an independently counted metric tally and restates the legacy counter', async () => {
    const { ag } = makeAgent();
    // Counted OUTSIDE the accounting machinery: asserting the total against
    // the sum over phases would be true by construction and prove nothing.
    let metricCalls = 0;
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: async (args: any) => {
          metricCalls++;
          return scoreByAnswer(args);
        },
        maxProposals: 1,
      }
    );
    expect(result.accounting.metricCalls).toBe(metricCalls);
    expect(result.accounting.evolveOnlyMetricCalls).toBe(
      result.metricCallsUsed
    );
    // With no evidence phase running the two denominators coincide — a
    // consequence of nothing else spending budget, not a definition.
    expect(result.accounting.metricCalls).toBe(result.metricCallsUsed);
    // Secondary consistency check.
    expect(
      result.accounting.phases.reduce(
        (sum: number, phase: any) => sum + phase.metricCalls,
        0
      )
    ).toBe(metricCalls);
  });

  it('counts mining invocations and has no proposal phase', async () => {
    // `buildProposal` is pure — zero metric calls, zero model calls — so a
    // phase for it would be permanent noise.
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 2,
    });
    const phases = new Map(
      result.accounting.phases.map((phase: any) => [phase.name, phase])
    );
    expect([...phases.keys()]).not.toContain('proposal');
    // One invocation per failure cluster, whether or not the miner yielded a
    // grounded weakness: a discarded cluster still cost a model call, so this
    // is a floor, not an equality the mock happens to satisfy.
    expect(phases.get('mining')?.modelCalls).toBeGreaterThanOrEqual(
      result.weaknesses.length
    );
    expect(phases.get('mining')?.modelCalls).toBeGreaterThan(0);
    expect(phases.get('mining')?.metricCalls).toBe(0);
    expect(phases.get('mining')?.tokensBasis).toBe('unobservable');
    // A caller-supplied deterministic metric means there is no built-in judge
    // to account for, so the phase is absent rather than reported as zero.
    expect(phases.get('judge')).toBeUndefined();
    expect(phases.get('baseline')?.metricCalls).toBeGreaterThan(0);
    expect(phases.get('candidate_eval')?.metricCalls).toBeGreaterThan(0);
  });

  it('labels an observable phase that reported nothing unreported, and names only the structurally unobservable ones in the warning', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      gates: { validity: 'warn' },
    });
    const phases = new Map(
      result.accounting.phases.map((phase: any) => [phase.name, phase])
    );
    // The mock service reports no usage. `baseline` reads usage off the
    // predictions, so its absence is 'unreported' — a usageTap is not the
    // remedy and the receipt must not claim it is.
    expect(phases.get('baseline')?.tokensBasis).toBe('unreported');
    expect(phases.get('candidate_eval')?.tokensBasis).not.toBe('unobservable');
    expect(phases.get('mining')?.tokensBasis).toBe('unobservable');
    const warning = (result.warnings ?? []).find(
      (entry: any) => entry.code === 'tokens_unobservable'
    );
    expect(warning?.message).toContain('mining');
    expect(warning?.message).not.toContain('baseline');
    expect(warning?.message).not.toContain('candidate_eval');
  });

  it('attributes tapped usage to the open mining phase, drops it for observable phases, and always unsubscribes', async () => {
    const { ag, ai } = makeAgent();
    let emit: ((usage: readonly any[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const originalChat = (ai as any).chat.bind(ai);
    (ai as any).chat = async (req: any, chatOptions?: any) => {
      const response = await originalChat(req, chatOptions);
      // Every model call the caller's wrapped service sees is forwarded,
      // including the ones made while an observable phase is open.
      emit?.([
        {
          ai: 'mock',
          model: 'tapped',
          tokens: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        },
      ]);
      return response;
    };
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      usageTap: {
        subscribe: (onUsage: any) => {
          emit = onUsage;
          return unsubscribe;
        },
      },
    });
    const phases = new Map(
      result.accounting.phases.map((phase: any) => [phase.name, phase])
    );
    // Mining is structurally unobservable WITHOUT a tap. With one, the
    // forwarded usage lands on it.
    expect(phases.get('mining')?.tokensBasis).not.toBe('unobservable');
    expect(phases.get('mining')?.totalTokens).toBeGreaterThan(0);
    // The observable phases read their own usage off the predictions, so
    // tapped usage arriving while they are open is dropped rather than added
    // on top of what they already counted.
    expect(phases.get('baseline')?.totalTokens).toBeUndefined();
    expect(phases.get('candidate_eval')?.totalTokens).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the usage tap when the run throws', async () => {
    const { ag } = makeAgent();
    const unsubscribe = vi.fn();
    await expect(
      ag.playbook().evolve(
        { train: [] },
        {
          metric: scoreByAnswer,
          usageTap: { subscribe: () => unsubscribe },
        }
      )
    ).rejects.toThrow(/at least one training task/);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports cost as unknown without costFor and caller_supplied with it', async () => {
    const { ag: bare } = makeAgent();
    const withoutCost = await bare.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
    });
    expect(withoutCost.accounting.costUsd).toBeUndefined();
    expect(withoutCost.accounting.costBasis).toBe('unknown');

    const { ag } = makeAgent();
    const costFor = vi.fn(() => 1.25);
    const withCost = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      costFor,
    });
    expect(costFor).toHaveBeenCalledTimes(1);
    expect(withCost.accounting.costUsd).toBe(1.25);
    expect(withCost.accounting.costBasis).toBe('caller_supplied');
  });

  it('captures attempt records once an evidence option is set', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      classifyTermination: () => undefined,
    });
    expect(result.records[0]?.attempts).toHaveLength(1);
    // The baseline runs reach `completionType: 'final'` with a finite score,
    // so the conservative default calls them completed.
    expect(result.records[0]?.attempts?.[0]?.termination.kind).toBe(
      'completed'
    );
  });
});

describe('agent.playbook().evolve() variance band', () => {
  it('re-runs the unchanged artifact and reports the band with its own cost', async () => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    const events: string[] = [];
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: async (args: any) => {
          metricCalls++;
          return scoreByAnswer(args);
        },
        maxProposals: 1,
        varianceBand: { extraRepeats: 1 },
        onProgress: (e: any) => void events.push(e.phase),
      }
    );
    expect(events).toContain('band');
    expect(result.varianceBand?.status).toBe('completed');
    const bands = (result.varianceBand as any).bands;
    expect(bands.map((b: any) => b.split)).toEqual(['current', 'heldOut']);
    for (const band of bands) {
      expect(band.repeats).toBe(2);
      expect(band.means).toHaveLength(2);
      expect(band.spread).toBeGreaterThanOrEqual(0);
      expect(band.interval.unit).toBe('task');
    }
    // The band's calls land in the honest run total but NEVER in the legacy
    // evolve-only counter (invariant I6).
    const bandCalls = TASKS.length + VALIDATION_TASKS.length;
    expect(result.accounting.metricCalls).toBe(metricCalls);
    expect(result.accounting.evolveOnlyMetricCalls).toBe(
      result.metricCallsUsed
    );
    expect(result.accounting.metricCalls).toBeGreaterThan(
      result.accounting.evolveOnlyMetricCalls
    );
    expect((result.varianceBand as any).accounting.metricCalls).toBe(bandCalls);
  });

  it('fails closed before any mutation when the budget cannot cover the band', async () => {
    const { ag } = makeAgent();
    const error = await ag
      .playbook()
      .evolve(TASKS, {
        metric: scoreByAnswer,
        maxProposals: 1,
        maxMetricCalls: TASKS.length, // baseline only
        varianceBand: { extraRepeats: 2 },
      })
      .catch((err: unknown) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect((error as any).code).toBe('budget_insufficient');
    expect((error as any).phase).toBe('variance_band');
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('rejects a required interval gate with no band rather than silently weakening it', async () => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    const error = await ag
      .playbook()
      .evolve(TASKS, {
        metric: async (args: any) => {
          metricCalls++;
          return scoreByAnswer(args);
        },
        gates: { interval: 'require' },
      })
      .catch((err: unknown) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect((error as any).code).toBe('interval_options_invalid');
    expect((error as Error).message).toContain('silently degrades');
    expect(metricCalls).toBe(0);
  });

  it('rejects out-of-range interval options before evaluating anything', async () => {
    const { ag } = makeAgent();
    let metricCalls = 0;
    await expect(
      ag.playbook().evolve(TASKS, {
        metric: async (args: any) => {
          metricCalls++;
          return scoreByAnswer(args);
        },
        intervalOptions: { resamples: 10 },
      })
    ).rejects.toThrow(/intervalOptions\.resamples must be a safe integer/);
    expect(metricCalls).toBe(0);
  });

  it('leaves varianceBand undefined when the option is absent', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
    });
    expect(result.varianceBand).toBeUndefined();
  });
});

describe('agent.playbook().evolve() evidence receipt and gates', () => {
  it('emits a receipt for every fully evaluated candidate, accepted or rejected', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: scoreByAnswer,
        maxProposals: 1,
        gates: { validity: 'warn' },
      }
    );
    const receipt = result.outcomes[0]!.evidence!;
    expect(receipt.schema).toBe('ax-agent-playbook-evidence-v1');
    expect(receipt.decision).toBe('accepted');
    expect(receipt.kind).toBe('curate');
    expect(receipt.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(Object.isFrozen(receipt)).toBe(true);
    // Every gate is on the record, including the skipped ones.
    expect(receipt.gates.entries.map((e: any) => e.id)).toEqual([
      'gain',
      'held_out',
      'retention',
      'validity',
      'interval',
      'reach',
      'prune_size',
      'veto',
      'authority',
    ]);
    expect(receipt.intervals.current.unit).toBe('task');
    expect(receipt.termination.splits.length).toBeGreaterThan(0);
    expect(receipt.promotion.status).toBe('not_required');
    // A held-out reading always carries its contamination disclosure.
    expect(receipt.heldOutContamination.sealed).toBe(false);
    expect(
      result.warnings?.some(
        (w: any) => w.code === 'held_out_reused_for_selection'
      )
    ).toBe(true);
  });

  it('rejects a candidate on a required validity predicate and names it in the reason', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: scoreByAnswer,
        maxProposals: 1,
        gates: { validity: 'require' },
        // The fixture's runs complete normally, so force a failure through a
        // ceiling the run cannot satisfy.
        validity: { maxMeanLatencyMs: -1 },
      }
    );
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.outcomes[0]?.reason).toMatch(
      /^validity gate failed: validity:latency_ceiling@current/
    );
    expect(result.outcomes[0]?.evidence?.decision).toBe('rejected');
    expect(result.outcomes[0]?.evidence?.gates.failedGate).toBe('validity');
    // Rejected means rolled back exactly, as before.
    expect(ag.getPlaybook().getState().playbook.stats.bulletCount).toBe(0);
  });

  it('cannot satisfy a required reach gate on a counterfactual basis', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: scoreByAnswer,
        maxProposals: 1,
        gates: { reach: 'require' },
        // An evolve-curated bullet has no applicability tokens, so this basis
        // reads 1.0 for every task — and still cannot pass the gate.
        conditionsForTask: () => ['anything'],
      }
    );
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.outcomes[0]?.evidence?.gates.failedGate).toBe('reach');
    const reach = result.outcomes[0]!.evidence!.reach;
    expect(reach.basis).toBe('applicability_counterfactual');
    expect(reach.counterfactual).toBe(true);
    expect(reach.gateEligible).toBe(false);
    expect(reach.splits[0]?.reachRate).toBe(1);
    expect(
      result.outcomes[0]?.evidence?.warnings.some(
        (w: any) => w.code === 'reach_counterfactual_basis'
      )
    ).toBe(true);
  });

  it('accepts under a host probe that observes the bullet at the deciding step', async () => {
    const { ag } = makeAgent();
    const seen: string[] = [];
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: scoreByAnswer,
        maxProposals: 1,
        gates: { reach: 'require' },
        reachProbe: ({ candidateBulletIds }: any) => {
          seen.push(...candidateBulletIds);
          return { applicableAtDecidingStep: true, invocations: 1 };
        },
      }
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(result.outcomes[0]?.accepted).toBe(true);
    const reach = result.outcomes[0]!.evidence!.reach;
    expect(reach.basis).toBe('host_probe');
    expect(reach.gateEligible).toBe(true);
    expect(reach.splits.every((s: any) => s.reachRate === 1)).toBe(true);
  });

  it('does not fail the run when the reach probe throws', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: scoreByAnswer,
        maxProposals: 1,
        gates: { reach: 'warn' },
        reachProbe: () => {
          throw new Error('probe exploded');
        },
      }
    );
    // Reach is evidence, not scoring: the run completes and the split is
    // marked unmeasured.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.evidence?.reach.gateEligible).toBe(false);
    expect(
      result.outcomes[0]?.evidence?.warnings.some(
        (w: any) => w.code === 'reach_probe_failed'
      )
    ).toBe(true);
  });

  it('surfaces the absence of a control arm, transfer and sealed test', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      gates: { validity: 'warn' },
    });
    const codes = (result.warnings ?? []).map((w: any) => w.code);
    expect(codes).toContain('control_arm_not_run');
    expect(codes).toContain('transfer_not_run');
    expect(codes).toContain('sealed_test_not_run');
    expect(codes).toContain('tokens_unobservable');
    // cost_unknown fires only when a candidate was accepted, so it stays
    // signal rather than firing on every run.
    expect(codes).toContain('cost_unknown');
  });

  it('does not emit cost_unknown when nothing was accepted', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: async () => 0.2, // never accepts
      maxProposals: 1,
      gates: { validity: 'warn' },
    });
    expect(result.outcomes[0]?.accepted).toBe(false);
    expect((result.warnings ?? []).map((w: any) => w.code)).not.toContain(
      'cost_unknown'
    );
  });

  it('scopes each receipt accounting to that candidate, not the running total', async () => {
    // Candidate 2's receipt must not carry candidate 1's calls: a receipt read
    // in isolation has to state what THAT candidate cost.
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: async () => 0.2, // reject every candidate so several are evaluated
        maxProposals: 2,
        gates: { validity: 'warn' },
      }
    );
    const perCandidate = TASKS.length + VALIDATION_TASKS.length;
    expect(result.outcomes.length).toBeGreaterThan(0);
    for (const outcome of result.outcomes) {
      expect(outcome.evidence?.accounting.metricCalls).toBe(perCandidate);
      expect(
        outcome.evidence?.accounting.phases.find(
          (phase: any) => phase.name === 'judge'
        )
      ).toBeUndefined();
    }
    // The run total still counts every candidate.
    expect(result.accounting.metricCalls).toBeGreaterThanOrEqual(
      perCandidate * result.outcomes.length
    );
  });

  it('does not repeat the same run-level warning once per candidate', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(
      { train: TASKS, validation: VALIDATION_TASKS },
      {
        metric: async () => 0.2,
        maxProposals: 2,
        gates: { validity: 'warn' },
      }
    );
    const keys = (result.warnings ?? []).map(
      (w: any) => `${w.code}|${w.scope ?? ''}`
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('held_out_reused_for_selection|heldOut');
  });

  it('reports the interval as unresolved rather than as an effect', async () => {
    const { ag } = makeAgent();
    const result = await ag.playbook().evolve(TASKS, {
      metric: scoreByAnswer,
      maxProposals: 1,
      gates: { validity: 'warn' },
      intervalOptions: { resamples: 500, seed: 12_345 },
    });
    const interval = result.outcomes[0]!.evidence!.intervals.current;
    expect(interval.seed).toBe(12_345);
    expect(interval.resamples).toBe(500);
    expect(interval.unit).toBe('task');
    expect(['positive', 'negative', 'unresolved']).toContain(
      interval.direction
    );
  });
});
