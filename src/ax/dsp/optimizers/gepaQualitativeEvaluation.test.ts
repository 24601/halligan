import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import type { AxMetricFn } from '../common_types.js';
import { createAxGenAdapter } from './axGenAdapter.js';
import { AxGEPA } from './gepa.js';
import type { AxGEPAAdapter } from './gepaAdapter.js';

type Example = { question: string; expected: 'urgent' | 'normal' };

const train: Example[] = [
  { question: 'Urgent outage in payments', expected: 'urgent' },
  { question: 'Weekly product update', expected: 'normal' },
];
const heldOut: Example[] = [
  { question: 'The server is down', expected: 'urgent' },
  { question: 'Team lunch reminder', expected: 'normal' },
];

const createProgram = (initialInstruction = 'always-normal') => {
  let instruction = initialInstruction;
  const program = {
    getId: () => 'root',
    setId: () => {},
    getSignature: () => ({
      getDescription: () => 'Classify operational urgency',
      toString: () => 'question:string -> answer:string',
    }),
    getOptimizableComponents: () => [
      { key: 'root::instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      instruction = updates['root::instruction'] ?? instruction;
    },
    forward: async (_ai: AxAIService, example: Example) => {
      const incident = /outage|down/i.test(example.question);
      const answer =
        instruction === 'incident-rule'
          ? incident
            ? 'urgent'
            : 'normal'
          : instruction === 'inverted-rule'
            ? incident
              ? 'normal'
              : 'urgent'
            : 'normal';
      return { answer, style: 'concise' };
    },
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: (artifact: any) => {
      program.applyOptimizedComponents(artifact.componentMap ?? {});
    },
    getUsage: () => [],
    resetUsage: () => {},
    instruction: () => instruction,
  };
  return program;
};

const numericMetric: AxMetricFn = ({ prediction, example }) =>
  (prediction as any).answer === (example as Example).expected ? 1 : 0;

const structuredMetric =
  (feedback: string | undefined): AxMetricFn =>
  ({ prediction, example }) => {
    const correct =
      (prediction as any).answer === (example as Example).expected;
    return {
      score: correct ? 1 : 0,
      feedback: correct ? undefined : feedback,
      scores: {
        accuracy: correct ? 1 : 0,
        brevity: (prediction as any).style === 'concise' ? 1 : 0,
      },
    };
  };

const heldOutScore = async (
  program: ReturnType<typeof createProgram>
): Promise<number> => {
  let total = 0;
  for (const example of heldOut) {
    const prediction = await program.forward({} as AxAIService, example);
    total += prediction.answer === example.expected ? 1 : 0;
  }
  return total / heldOut.length;
};

const optimizeWithDeterministicTeacher = async (args: {
  metric: AxMetricFn;
  initialInstruction?: string;
}) => {
  const program = createProgram(args.initialInstruction);
  const baseAdapter = createAxGenAdapter({
    program: program as any,
    ai: {} as AxAIService,
    metricFn: args.metric,
    sampleCount: 1,
  });
  const reflectedQuestions: string[] = [];
  const attemptedProposals: string[] = [];
  let lastEvaluatedBatch: readonly Example[] = [];
  const adapter: AxGEPAAdapter = {
    ...baseAdapter,
    evaluate(batch, candidate, captureTraces) {
      lastEvaluatedBatch = batch as readonly Example[];
      return baseAdapter.evaluate(batch, candidate, captureTraces);
    },
    make_reflective_dataset(candidate, batch, components) {
      const dataset = baseAdapter.make_reflective_dataset(
        candidate,
        batch,
        components
      );
      for (const [index] of (dataset['root::instruction'] ?? []).entries()) {
        const question = lastEvaluatedBatch[index]?.question;
        if (question) reflectedQuestions.push(question);
      }
      return dataset;
    },
    propose_new_texts(candidate, dataset) {
      const rows = dataset['root::instruction'] ?? [];
      const feedback = rows
        .map((row: any) => row.feedback)
        .filter((value: unknown): value is string => typeof value === 'string')
        .join('\n');
      const proposal = feedback.includes('outage and down')
        ? 'incident-rule'
        : feedback.includes('invert the incident rule')
          ? 'inverted-rule'
          : candidate['root::instruction']!;
      if (proposal !== candidate['root::instruction']) {
        attemptedProposals.push(proposal);
      }
      return { 'root::instruction': proposal };
    },
  };
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 1,
    minibatch: false,
    seed: 7,
  });
  const maxMetricCalls = 10;
  const result = await optimizer.compile(program as any, train, args.metric, {
    validationExamples: heldOut,
    gepaAdapter: adapter,
    maxMetricCalls,
    skipPerfectScore: true,
  });
  program.applyOptimization(result.optimizedProgram);
  return {
    result,
    instruction: program.instruction(),
    heldOutScore: await heldOutScore(program),
    reflectedQuestions,
    attemptedProposals,
    maxMetricCalls,
  };
};

describe('GEPA qualitative feedback evaluation', () => {
  it('improves held-out behavior over an identical numeric-only baseline', async () => {
    const baseline = await optimizeWithDeterministicTeacher({
      metric: numericMetric,
    });
    const qualitative = await optimizeWithDeterministicTeacher({
      metric: structuredMetric(
        'Treat outage and down incidents as urgent; routine updates remain normal.'
      ),
    });

    expect(baseline.instruction).toBe('always-normal');
    expect(baseline.heldOutScore).toBe(0.5);
    expect(qualitative.instruction).toBe('incident-rule');
    expect(qualitative.heldOutScore).toBe(1);
    expect(qualitative.attemptedProposals).toEqual(['incident-rule']);
    expect(qualitative.result.stats.totalCalls).toBeLessThanOrEqual(
      qualitative.maxMetricCalls
    );
    expect(qualitative.reflectedQuestions.length).toBeGreaterThan(0);
    expect(
      qualitative.reflectedQuestions.every((question) =>
        train.some((example) => example.question === question)
      )
    ).toBe(true);
    expect(
      qualitative.reflectedQuestions.some((question) =>
        heldOut.some((example) => example.question === question)
      )
    ).toBe(false);
  });

  it('does not claim benefit for empty, misleading, or already-solved feedback', async () => {
    const empty = await optimizeWithDeterministicTeacher({
      metric: structuredMetric('   '),
    });
    expect(empty.instruction).toBe('always-normal');
    expect(empty.heldOutScore).toBe(0.5);
    expect(empty.attemptedProposals).toEqual([]);

    const misleading = await optimizeWithDeterministicTeacher({
      metric: structuredMetric('Please invert the incident rule.'),
    });
    expect(misleading.attemptedProposals).toEqual(['inverted-rule']);
    expect(misleading.instruction).toBe('always-normal');
    expect(misleading.heldOutScore).toBe(0.5);

    const solved = await optimizeWithDeterministicTeacher({
      metric: structuredMetric(
        'Treat outage and down incidents as urgent; routine updates remain normal.'
      ),
      initialInstruction: 'incident-rule',
    });
    expect(solved.instruction).toBe('incident-rule');
    expect(solved.heldOutScore).toBe(1);
    expect(solved.attemptedProposals).toEqual([]);
  });
});
