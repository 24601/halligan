import { AxMockAIService } from '../ai/mock/api.js';
import type { AxChatResponse, AxFunction } from '../ai/types.js';
import {
  type AxProgramSourceDocument,
  type AxProgramSourceExpression,
  type AxProgramSourceStatement,
  axProgramSourceVersion,
  programSource,
} from './programSource.js';

type Example = Readonly<{ id: string; urgent: boolean; answer: string }>;
type CandidateResult = Readonly<{
  name: string;
  status: 'promoted' | 'rejected' | 'invalid';
  trainScore?: number;
  heldOutScore?: number;
  sourceBytes: number;
  statementCount?: number;
  runtimeMs: number;
  costUsd: 0;
  reason?: string;
}>;

export type ProgramSourceEvaluationReport = Readonly<{
  evidence: 'mechanism-only-not-model-quality';
  seed: Readonly<{
    trainScore: number;
    heldOutScore: number;
    sourceBytes: number;
    statementCount: number;
  }>;
  candidates: readonly CandidateResult[];
  negative: Readonly<{
    seedScore: number;
    candidateScore: number;
    status: 'rejected-no-value';
    sourceBytes: number;
    statementCount: number;
    runtimeMs: number;
    costUsd: 0;
  }>;
  promoted: string;
  finalSourceBytes: number;
  finalStatementCount: number;
  runtimeMs: number;
  costUsd: 0;
  usage: Readonly<{
    metricCalls: number;
    predictorCalls: number;
    toolCalls: number;
  }>;
  budgets: Readonly<{
    metricCalls: number;
    predictorCalls: number;
    toolCalls: number;
    wallTimeMs: number;
  }>;
}>;

const budgets = {
  metricCalls: 30,
  predictorCalls: 12,
  toolCalls: 8,
  wallTimeMs: 10_000,
} as const;
const lit = (value: unknown): AxProgramSourceExpression => ({
  op: 'literal',
  value,
});
const ref = (path: string): AxProgramSourceExpression => ({ op: 'ref', path });
const source = (
  steps: readonly AxProgramSourceStatement[],
  capabilities: AxProgramSourceDocument['capabilities'] = []
) => JSON.stringify({ version: axProgramSourceVersion, capabilities, steps });
const statementCount = (sourceText: string): number | undefined => {
  try {
    const document = JSON.parse(sourceText) as {
      steps?: readonly Record<string, unknown>[];
    };
    if (!Array.isArray(document.steps)) return undefined;
    const count = (steps: readonly Record<string, unknown>[]): number =>
      steps.reduce((total, statement) => {
        const nested = [
          statement.then,
          statement.else,
          statement.body,
        ].reduce<number>(
          (sum, value) =>
            sum +
            (Array.isArray(value)
              ? count(value as Record<string, unknown>[])
              : 0),
          0
        );
        return total + 1 + nested;
      }, 0);
    return count(document.steps);
  } catch {
    return undefined;
  }
};
const answer = (
  value: AxProgramSourceExpression
): AxProgramSourceStatement => ({
  op: 'return',
  outputs: { answer: value },
});
const branch = (
  id: string,
  value: string,
  otherwise: AxProgramSourceExpression
): AxProgramSourceExpression => ({
  op: 'select',
  condition: { op: 'eq', left: ref('inputs.id'), right: lit(id) },
  // biome-ignore lint/suspicious/noThenProperty: `then` is required by the JSON AST.
  then: lit(value),
  else: otherwise,
});

/** A deterministic, zero-network hill climb over complete JSON program sources. */
export async function runProgramSourceEvaluation(): Promise<ProgramSourceEvaluationReport> {
  const started = Date.now();
  const usage = { metricCalls: 0, predictorCalls: 0, toolCalls: 0 };
  const consume = (kind: keyof typeof usage) => {
    if (Date.now() - started > budgets.wallTimeMs) {
      throw new Error(
        `Evaluation wall-time budget exceeded: ${budgets.wallTimeMs}ms`
      );
    }
    usage[kind] += 1;
    if (usage[kind] > budgets[kind]) {
      throw new Error(`Evaluation ${kind} budget exceeded: ${budgets[kind]}`);
    }
  };
  const train: Example[] = [
    { id: 'train-a', urgent: true, answer: 'urgent' },
    { id: 'train-b', urgent: false, answer: 'normal' },
    { id: 'train-c', urgent: true, answer: 'urgent' },
    { id: 'train-d', urgent: false, answer: 'normal' },
  ];
  const heldOut: Example[] = [
    { id: 'held-a', urgent: true, answer: 'urgent' },
    { id: 'held-b', urgent: false, answer: 'normal' },
  ];
  const classify: AxFunction = {
    name: 'classifyUrgency',
    description: 'Deterministically classify the supplied boolean.',
    parameters: {
      type: 'object',
      properties: {
        urgent: { type: 'boolean', description: 'Whether the item is urgent.' },
      },
      required: ['urgent'],
    },
    returns: { type: 'object' },
    func: ({ urgent }: { urgent: boolean }) => {
      consume('toolCalls');
      return { answer: urgent ? 'urgent' : 'normal' };
    },
  };
  const ai = new AxMockAIService<string>({
    features: { streaming: false },
    chatResponse: async () => {
      consume('predictorCalls');
      return {
        results: [
          { index: 0, content: 'Answer: normal', finishReason: 'stop' },
        ],
      } as AxChatResponse;
    },
  });
  const program = programSource('id:string, urgent:boolean -> answer:string', {
    tools: [classify],
    maxPredictorCalls: 1,
    maxToolCalls: 1,
    timeoutMs: 1_000,
  });
  const component = program
    .getOptimizableComponents()
    .find((item) => item.kind === 'program-source')!;
  const apply = (value: string) =>
    program.applyOptimizedComponents({ [component.key]: value });
  const score = async (examples: readonly Example[]) => {
    let correct = 0;
    for (const example of examples) {
      consume('metricCalls');
      const prediction = await program.forward(ai, {
        id: example.id,
        urgent: example.urgent,
      });
      if (prediction.answer === example.answer) correct += 1;
    }
    return correct / examples.length;
  };
  const seedSource = program.getProgramSource();
  const seed = {
    trainScore: await score(train),
    heldOutScore: await score(heldOut),
    sourceBytes: seedSource.length,
    statementCount: statementCount(seedSource)!,
  };
  let incumbentSource = seedSource;
  let incumbentTrain = seed.trainScore;
  let incumbentHeldOut = seed.heldOutScore;
  const results: CandidateResult[] = [];
  const memorizer = source([
    answer(
      branch(
        'train-a',
        'urgent',
        branch(
          'train-b',
          'normal',
          branch('train-c', 'urgent', branch('train-d', 'normal', lit('wrong')))
        )
      )
    ),
  ]);
  const general = source(
    [
      {
        op: 'tool',
        name: 'classifyUrgency',
        as: 'classified',
        args: { op: 'object', entries: { urgent: ref('inputs.urgent') } },
      },
      answer(ref('classified.answer')),
    ],
    ['tool:classifyUrgency']
  );

  for (const candidate of [
    { name: 'invalid-source', source: '{not-json' },
    { name: 'train-memorizer', source: memorizer },
    { name: 'general-tool-rule', source: general },
  ]) {
    const candidateStarted = Date.now();
    const validation = component.validate?.(candidate.source);
    if (validation !== true) {
      results.push({
        name: candidate.name,
        status: 'invalid',
        sourceBytes: candidate.source.length,
        runtimeMs: Date.now() - candidateStarted,
        costUsd: 0,
        reason: String(validation),
      });
      continue;
    }
    apply(candidate.source);
    const trainScore = await score(train);
    const heldOutScore = await score(heldOut);
    if (trainScore > incumbentTrain && heldOutScore >= incumbentHeldOut) {
      incumbentSource = candidate.source;
      incumbentTrain = trainScore;
      incumbentHeldOut = heldOutScore;
      results.push({
        name: candidate.name,
        status: 'promoted',
        trainScore,
        heldOutScore,
        sourceBytes: candidate.source.length,
        statementCount: statementCount(candidate.source),
        runtimeMs: Date.now() - candidateStarted,
        costUsd: 0,
      });
    } else {
      apply(incumbentSource);
      results.push({
        name: candidate.name,
        status: 'rejected',
        trainScore,
        heldOutScore,
        sourceBytes: candidate.source.length,
        statementCount: statementCount(candidate.source),
        runtimeMs: Date.now() - candidateStarted,
        costUsd: 0,
        reason: 'requires train improvement without held-out regression',
      });
    }
  }

  const negativeProgram = programSource('id:string -> answer:string', {
    maxPredictorCalls: 2,
    timeoutMs: 1_000,
  });
  const negativeSet = [{ id: 'n1' }, { id: 'n2' }];
  const negativeScore = async () => {
    let correct = 0;
    for (const item of negativeSet) {
      consume('metricCalls');
      const prediction = await negativeProgram.forward(ai, item);
      if (prediction.answer === 'normal') correct += 1;
    }
    return correct / negativeSet.length;
  };
  const negativeSeed = await negativeScore();
  const negativeSeedSource = negativeProgram.getProgramSource();
  const negativeComponent = negativeProgram
    .getOptimizableComponents()
    .find((item) => item.kind === 'program-source')!;
  negativeProgram.applyOptimizedComponents({
    [negativeComponent.key]: source(
      [
        {
          op: 'predict',
          as: 'firstPass',
          signature: '$program',
          input: ref('inputs'),
        },
        {
          op: 'predict',
          as: 'redundantSecondPass',
          signature: '$program',
          input: ref('inputs'),
        },
        answer(ref('redundantSecondPass.answer')),
      ],
      ['predict']
    ),
  });
  const negativeStarted = Date.now();
  const negativeCandidateSource = negativeProgram.getProgramSource();
  const negativeCandidate = await negativeScore();
  if (negativeCandidate > negativeSeed) {
    throw new Error('Negative control unexpectedly improved');
  }
  negativeProgram.setProgramSource(negativeSeedSource);
  const runtimeMs = Date.now() - started;
  if (
    usage.metricCalls > budgets.metricCalls ||
    usage.predictorCalls > budgets.predictorCalls ||
    usage.toolCalls > budgets.toolCalls ||
    runtimeMs > budgets.wallTimeMs
  ) {
    throw new Error(
      `Evaluation budget exceeded: ${JSON.stringify({ usage, runtimeMs, budgets })}`
    );
  }
  return {
    evidence: 'mechanism-only-not-model-quality',
    seed,
    candidates: results,
    negative: {
      seedScore: negativeSeed,
      candidateScore: negativeCandidate,
      status: 'rejected-no-value',
      sourceBytes: negativeCandidateSource.length,
      statementCount: statementCount(negativeCandidateSource)!,
      runtimeMs: Date.now() - negativeStarted,
      costUsd: 0,
    },
    promoted: 'general-tool-rule',
    finalSourceBytes: incumbentSource.length,
    finalStatementCount: statementCount(incumbentSource)!,
    runtimeMs,
    costUsd: 0,
    usage,
    budgets,
  };
}
