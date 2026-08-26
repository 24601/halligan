import { describe, expect, it } from 'vitest';
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

  it('restores the live playbook byte-for-byte when apply:false aborts during the second candidate revalidation', async () => {
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
    let candidateMetricCalls = 0;
    const handle = {
      update: async () => {
        revision++;
        rules = [...rules, `candidate-${revision}`];
      },
      render: () => rules.join('\n'),
      getState: () => ({ revision, rules: [...rules] }),
      load: (snapshot: Readonly<{ revision: number; rules: string[] }>) => {
        revision = snapshot.revision;
        rules = [...snapshot.rules];
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
            { input: { case: 'held-out' }, criteria: 'pass', id: 'validation' },
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
                prediction.output.revision === 2 &&
                candidateMetricCalls === 4
              ) {
                controller.abort('abort second candidate revalidation');
              }
              return 1;
            }
            return 0;
          },
        }
      )
    ).rejects.toThrow(/aborted/);

    expect(candidateMetricCalls).toBe(4);
    expect(handle.getState()).toEqual(before);
    expect(JSON.stringify(handle.getState())).toBe(beforeBytes);
    expect(handle.render()).toBe('');
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
});
