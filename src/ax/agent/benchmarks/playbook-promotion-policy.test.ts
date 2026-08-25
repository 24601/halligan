/**
 * Deterministic hill-climbing evaluation for agent playbook promotion.
 *
 * The candidate set intentionally mixes overfit, generalizing, noisy-small,
 * no-benefit, and harmful proposals. It exercises the real evolve orchestrator
 * and mutation/rollback path with a fixed external metric; no scores are tuned
 * from test outcomes.
 *
 * Run `AX_PRINT_METRICS=1 npx vitest run src/ax/agent/benchmarks/playbook-promotion-policy.test.ts`
 * to print the candidate table and aggregate policy comparison.
 */
import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../../ai/mock/api.js';
import { evolveAgentPlaybook } from '../agentInternal/playbookEvolve/playbookEvolve.js';

type ScoreSeries = readonly [number, ...number[]];

type CandidateScenario = {
  name: string;
  train: { baseline: ScoreSeries; candidate: ScoreSeries };
  heldOut: { baseline: ScoreSeries; candidate: ScoreSeries };
  runsPerTask?: number;
};

const CANDIDATES: readonly CandidateScenario[] = [
  {
    name: 'overfit',
    train: { baseline: [0.2], candidate: [0.9] },
    heldOut: { baseline: [0.8], candidate: [0.1] },
  },
  {
    name: 'generalizing',
    train: { baseline: [0.2], candidate: [0.9] },
    heldOut: { baseline: [0.4], candidate: [0.8] },
  },
  {
    name: 'no-benefit',
    train: { baseline: [0.4], candidate: [0.4] },
    heldOut: { baseline: [0.4], candidate: [0.4] },
  },
  {
    name: 'harmful',
    train: { baseline: [0.6], candidate: [0.2] },
    heldOut: { baseline: [0.6], candidate: [0.2] },
  },
  {
    name: 'small-noisy-overfit',
    train: { baseline: [0.1, 0.5, 0.3], candidate: [0.7, 0.9, 0.8] },
    heldOut: { baseline: [0.6, 0.8, 0.7], candidate: [0.2, 0.4, 0.3] },
    runsPerTask: 3,
  },
  {
    name: 'small-noisy-generalizing',
    train: { baseline: [0.1, 0.9, 0.2], candidate: [0.5, 0.9, 0.7] },
    heldOut: { baseline: [0.3, 0.5, 0.4], candidate: [0.4, 0.7, 0.6] },
    runsPerTask: 3,
  },
];

const mean = (scores: ScoreSeries): number =>
  scores.reduce((sum, score) => sum + score, 0) / scores.length;

const makeUsage = () => ({
  ai: 'mock',
  model: 'mock',
  tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

function minerAI() {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async () => ({
      results: [
        {
          index: 0,
          content: [
            'Weakness Description: The baseline uses a brittle strategy.',
            'Root Cause: The current playbook lacks the candidate rule.',
            'Proposed Guidance: Apply the deterministic candidate rule.',
            'Evidence Quotes: ["deterministic failure evidence"]',
          ].join('\n'),
          finishReason: 'stop' as const,
        },
      ],
      modelUsage: makeUsage() as any,
    }),
  });
}

function makeHarness(scenario: CandidateScenario) {
  let applied = false;
  let revision = 0;
  let metricCalls = 0;
  const counters = new Map<string, number>();
  const handle = {
    update: async () => {
      applied = true;
      revision++;
    },
    render: () => (applied ? '## Context Playbook\n- candidate' : ''),
    getState: () => ({ applied, revision }),
    load: (snapshot: Readonly<{ applied: boolean; revision: number }>) => {
      applied = snapshot.applied;
      revision = snapshot.revision;
    },
  };
  const ai = minerAI();
  const self = {
    init: { ai },
    getPlaybook: () => handle,
    _forwardForEvaluation: async () => ({
      completionType: 'final',
      output: { applied },
      actionLog: 'deterministic failure evidence',
      functionCalls: [],
      toolErrors: [],
      turnCount: 1,
      usage: [],
    }),
  };
  const metric = async ({ example }: any) => {
    metricCalls++;
    const split = String(example.id).startsWith('validation')
      ? 'heldOut'
      : 'train';
    const phase = applied ? 'candidate' : 'baseline';
    const key = `${split}:${phase}`;
    const scores = scenario[split][phase];
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    return scores[index % scores.length]!;
  };
  return {
    self,
    handle,
    metric,
    metricCalls: () => metricCalls,
  };
}

type PolicyRow = {
  scenario: string;
  policy: 'permissive' | 'strict';
  accepted: boolean;
  heldInGain: number;
  trueHeldOutGain: number;
  metricCalls: number;
  rollbackExact: boolean;
};

async function runCandidate(
  scenario: CandidateScenario,
  policy: PolicyRow['policy']
): Promise<PolicyRow> {
  const harness = makeHarness(scenario);
  const before = harness.handle.getState();
  const train = [
    { input: { case: scenario.name }, criteria: 'pass', id: 'train' },
  ];
  const validation = [
    { input: { case: scenario.name }, criteria: 'pass', id: 'validation' },
  ];
  const result = await evolveAgentPlaybook(
    harness.self,
    policy === 'strict' ? { train, validation } : train,
    {
      metric: harness.metric,
      maxProposals: 1,
      runsPerTask: scenario.runsPerTask ?? 1,
      ...(policy === 'strict' ? { requireHeldOut: true } : {}),
    }
  );
  const accepted = result.outcomes[0]?.accepted === true;
  return {
    scenario: scenario.name,
    policy,
    accepted,
    heldInGain: mean(scenario.train.candidate) - mean(scenario.train.baseline),
    trueHeldOutGain:
      mean(scenario.heldOut.candidate) - mean(scenario.heldOut.baseline),
    metricCalls: harness.metricCalls(),
    rollbackExact:
      accepted ||
      JSON.stringify(harness.handle.getState()) === JSON.stringify(before),
  };
}

function renderRows(rows: readonly PolicyRow[]): string {
  const header =
    'scenario                 policy      accept  trainGain  heldOutGain  calls  rollback';
  const body = rows.map((row) =>
    [
      row.scenario.padEnd(24),
      row.policy.padEnd(11),
      String(row.accepted).padEnd(7),
      row.heldInGain.toFixed(3).padStart(9),
      row.trueHeldOutGain.toFixed(3).padStart(11),
      String(row.metricCalls).padStart(5),
      String(row.rollbackExact).padStart(9),
    ].join('  ')
  );
  return [header, '-'.repeat(header.length), ...body].join('\n');
}

describe('playbook held-out promotion policy evaluation', () => {
  it('compares permissive and strict promotion across a fixed candidate set', async () => {
    const rows: PolicyRow[] = [];
    for (const scenario of CANDIDATES) {
      rows.push(await runCandidate(scenario, 'permissive'));
      rows.push(await runCandidate(scenario, 'strict'));
    }

    const regressing = rows.filter((row) => row.trueHeldOutGain < -0.01);
    const falsePromotionRate = (policy: PolicyRow['policy']) => {
      const candidates = regressing.filter((row) => row.policy === policy);
      return (
        candidates.filter((row) => row.accepted).length / candidates.length
      );
    };
    const acceptedHeldOut = (policy: PolicyRow['policy']) =>
      rows
        .filter((row) => row.policy === policy && row.accepted)
        .map((row) => row.trueHeldOutGain);
    const permissiveAcceptedHeldOut = acceptedHeldOut('permissive');
    const strictAcceptedHeldOut = acceptedHeldOut('strict');

    expect(falsePromotionRate('permissive')).toBeCloseTo(2 / 3);
    expect(falsePromotionRate('strict')).toBe(0);
    expect(permissiveAcceptedHeldOut.some((gain) => gain < 0)).toBe(true);
    expect(strictAcceptedHeldOut).toEqual([0.4, expect.closeTo(1 / 6, 10)]);
    expect(rows.every((row) => row.rollbackExact)).toBe(true);
    expect(
      rows.find(
        (row) => row.scenario === 'generalizing' && row.policy === 'strict'
      )?.metricCalls
    ).toBe(4);
    expect(
      rows.find(
        (row) => row.scenario === 'generalizing' && row.policy === 'permissive'
      )?.metricCalls
    ).toBe(2);

    if (process.env.AX_PRINT_METRICS) {
      console.log(`\n${renderRows(rows)}\n`);
      console.log(
        JSON.stringify(
          {
            falsePromotionRate: {
              permissive: falsePromotionRate('permissive'),
              strict: falsePromotionRate('strict'),
            },
            acceptedHeldOutGain: {
              permissive: permissiveAcceptedHeldOut,
              strict: strictAcceptedHeldOut,
            },
            strictMetricCallOverheadOnGeneralizer: '2x',
          },
          null,
          2
        )
      );
    }
  });

  it('measures budget rejection, contamination detection, and rollback', async () => {
    const scenario = CANDIDATES[0]!;

    const permissive = makeHarness(scenario);
    const permissiveBefore = permissive.handle.getState();
    const permissiveResult = await evolveAgentPlaybook(
      permissive.self,
      [{ input: { case: 'budget' }, criteria: 'pass', id: 'train' }],
      { metric: permissive.metric, maxProposals: 1, maxMetricCalls: 1 }
    );
    expect(permissiveResult.outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: 'metric_budget exhausted before validation',
    });
    expect(permissive.handle.getState()).toEqual(permissiveBefore);

    const strictBudget = makeHarness(scenario);
    await expect(
      evolveAgentPlaybook(
        strictBudget.self,
        {
          train: [{ input: { case: 'budget' }, criteria: 'pass', id: 'train' }],
          validation: [
            { input: { case: 'budget' }, criteria: 'pass', id: 'validation' },
          ],
        },
        {
          requireHeldOut: true,
          metric: strictBudget.metric,
          maxProposals: 1,
          maxMetricCalls: 3,
        }
      )
    ).rejects.toThrow(/needs at least 4 metric calls/);
    expect(strictBudget.metricCalls()).toBe(0);

    const contaminated = makeHarness(scenario);
    await expect(
      evolveAgentPlaybook(
        contaminated.self,
        {
          train: [{ input: { case: 'train' }, criteria: 'pass', id: 'same' }],
          validation: [
            { input: { case: 'held-out' }, criteria: 'pass', id: 'same' },
          ],
        },
        { requireHeldOut: true, metric: contaminated.metric }
      )
    ).rejects.toThrow(/overlapping task id\(s\): same/);
    expect(contaminated.metricCalls()).toBe(0);
  });
});
