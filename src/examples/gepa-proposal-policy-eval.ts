/**
 * Reproducible GEPA proposal-policy hill-climb evaluation.
 *
 * Controlled, zero-cost mechanics/generalization gate:
 *   node --import=tsx src/examples/gepa-proposal-policy-eval.ts
 *
 * Optional bounded live proposer comparison (at most 6 model calls and 32 metric calls):
 *   OPENAI_APIKEY=... node --import=tsx src/examples/gepa-proposal-policy-eval.ts --real
 *
 * The controlled teacher is deliberately deterministic and adversarial. It
 * validates optimizer mechanics, proposal context, train acceptance, held-out
 * selection, and rejection behavior. It does not establish real-model efficacy.
 */

import { AxMockAIService } from '../ax/ai/mock/api.js';
import { renderGEPAOptimizationReferences } from '../ax/dsp/optimizers/gepaReflection.js';
import {
  AxAIOpenAIModel,
  type AxAIService,
  AxGEPA,
  type AxGEPAOptimizationReference,
  type AxGEPAProposalOptions,
  ai,
} from '../ax/index.js';

type Example = Readonly<{ itemId: string; hazardous: boolean }>;

const BASE_INSTRUCTION = 'Classify every item as safe.';
const MEMORIZED_INSTRUCTION =
  'MEMORIZE amber-cobra=hazardous, amber-lynx=hazardous, amber-moth=hazardous, blue-ibis=safe; otherwise hazardous.';
const GENERAL_INSTRUCTION =
  'GENERAL RULE: an item is hazardous exactly when its identifier starts with amber-.';
const NO_BENEFIT_INSTRUCTION = 'Continue classifying every item as safe.';

const train: readonly Example[] = [
  { itemId: 'amber-cobra', hazardous: true },
  { itemId: 'amber-lynx', hazardous: true },
  { itemId: 'amber-moth', hazardous: true },
  { itemId: 'blue-ibis', hazardous: false },
];

const heldOut: readonly Example[] = [
  { itemId: 'amber-otter', hazardous: true },
  { itemId: 'blue-yak', hazardous: false },
  { itemId: 'green-tern', hazardous: false },
  { itemId: 'violet-wren', hazardous: false },
];

const generalReference: AxGEPAOptimizationReference = {
  name: 'hazard-prefix-rule',
  description: 'Domain-wide classification rule',
  content:
    'An item is hazardous if and only if its identifier starts with `amber-`. Generalize this rule; never copy example identifiers or answers.',
};

const irrelevantReference: AxGEPAOptimizationReference = {
  name: 'writing-style',
  description: 'Irrelevant to classification correctness',
  content: 'Prefer short sentences and active voice.',
};

function predict(instruction: string, itemId: string): boolean {
  if (instruction.includes('MEMORIZE')) {
    const trainingAnswers = new Map<string, boolean>([
      ['amber-cobra', true],
      ['amber-lynx', true],
      ['amber-moth', true],
      ['blue-ibis', false],
    ]);
    return trainingAnswers.get(itemId) ?? true;
  }
  if (
    instruction.includes('GENERAL RULE') ||
    (/amber-/i.test(instruction) &&
      /(start|begin|prefix|identifier)/i.test(instruction))
  ) {
    return itemId.startsWith('amber-');
  }
  return false;
}

function scoreInstruction(
  instruction: string,
  examples: readonly Example[]
): number {
  return (
    examples.filter(
      (example) => predict(instruction, example.itemId) === example.hazardous
    ).length / examples.length
  );
}

function createProgram() {
  let instruction = BASE_INSTRUCTION;
  const componentKey = 'root::instruction';
  const program = {
    getId: () => 'root',
    setId: () => {},
    namedProgramInstances: () => [{ id: 'root', program }],
    getOptimizableComponents: () => [
      {
        key: componentKey,
        kind: 'instruction',
        current: instruction,
        description: 'General item hazard classification rule.',
      },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      if (typeof updates[componentKey] === 'string') {
        instruction = updates[componentKey];
      }
    },
    forward: async (_ai: AxAIService, example: Example) => ({
      hazardous: predict(instruction, example.itemId),
    }),
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
  return program;
}

function createControlledTeacher() {
  let calls = 0;
  let proposalPrompt = '';
  const teacher = new AxMockAIService<string>({
    chatResponse: async (request) => {
      calls++;
      const prompt = JSON.stringify(request.chatPrompt);
      const isProposal = calls % 2 === 0;
      if (isProposal) proposalPrompt = prompt;
      const proposal = prompt.includes(generalReference.name)
        ? GENERAL_INSTRUCTION
        : prompt.includes(irrelevantReference.name)
          ? NO_BENEFIT_INSTRUCTION
          : MEMORIZED_INSTRUCTION;
      return {
        results: [
          {
            index: 0,
            content: isProposal
              ? `New Value: ${proposal}`
              : 'Feedback Summary: Derive a rule that improves classification.',
            finishReason: 'stop',
          },
        ],
      };
    },
  });
  return {
    teacher,
    measurements: () => ({
      teacherCalls: calls,
      proposalPrompt,
      proposalPromptChars: proposalPrompt.length,
    }),
  };
}

type RunOptions = Readonly<{
  label: string;
  teacher: AxAIService;
  proposal?: AxGEPAProposalOptions;
  maxMetricCalls: number;
}>;

async function runHillClimb(options: RunOptions) {
  const program = createProgram();
  let metricCalls = 0;
  const optimizer = new AxGEPA({
    studentAI: options.teacher,
    teacherAI: options.teacher,
    numTrials: 1,
    minibatch: false,
    earlyStoppingTrials: 2,
    minImprovementThreshold: 0,
    seed: 7,
  });

  const result = await optimizer.compile(
    program as any,
    train as any,
    ({ prediction, example }) => {
      metricCalls++;
      return (prediction as { hazardous: boolean }).hazardous ===
        (example as Example).hazardous
        ? 1
        : 0;
    },
    {
      validationExamples: heldOut as any,
      maxMetricCalls: options.maxMetricCalls,
      skipPerfectScore: false,
      gepaProposal: options.proposal,
    }
  );

  const selectedInstruction =
    result.optimizedProgram?.componentMap?.['root::instruction'] ?? '';
  const selector =
    result.optimizedProgram?.selectorState?.['root::instruction'];
  return {
    label: options.label,
    selectedInstruction,
    selectedHeldOutScore: result.bestScore,
    selectedTrainScore: scoreInstruction(selectedInstruction, train),
    metricCalls,
    maxMetricCalls: options.maxMetricCalls,
    acceptedCandidates: selector?.accepts ?? 0,
    rejectedCandidates: (selector?.proposals ?? 0) - (selector?.accepts ?? 0),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Evaluation assertion failed: ${message}`);
}

async function runControlled() {
  const baselineTeacher = createControlledTeacher();
  const informedTeacher = createControlledTeacher();
  const negativeTeacher = createControlledTeacher();

  const baseline = await runHillClimb({
    label: 'baseline-gepa',
    teacher: baselineTeacher.teacher,
    maxMetricCalls: 16,
  });
  const informed = await runHillClimb({
    label: 'reference-informed',
    teacher: informedTeacher.teacher,
    proposal: {
      references: [generalReference],
      additionalGuidance:
        'Prefer a transferable rule. Do not memorize identifiers or answers.',
      maxExamples: 1,
    },
    maxMetricCalls: 16,
  });
  const negative = await runHillClimb({
    label: 'irrelevant-reference-no-benefit',
    teacher: negativeTeacher.teacher,
    proposal: {
      references: [irrelevantReference],
      additionalGuidance:
        'Use a reference only when it improves classification correctness.',
      maxExamples: 1,
    },
    maxMetricCalls: 12,
  });

  const baselineMeasurements = baselineTeacher.measurements();
  const informedMeasurements = informedTeacher.measurements();
  const negativeMeasurements = negativeTeacher.measurements();

  assert(
    scoreInstruction(MEMORIZED_INSTRUCTION, train) === 1 &&
      scoreInstruction(MEMORIZED_INSTRUCTION, heldOut) === 0.25,
    'the memorized candidate must fit train and regress held-out'
  );
  assert(
    baseline.acceptedCandidates === 1 &&
      baseline.selectedInstruction === BASE_INSTRUCTION &&
      baseline.selectedHeldOutScore === 0.75,
    'GEPA must accept the train-improving memorized proposal locally but keep the superior held-out baseline'
  );
  assert(
    informed.acceptedCandidates === 1 &&
      informed.selectedInstruction === GENERAL_INSTRUCTION &&
      informed.selectedHeldOutScore === 1,
    'the reference-informed general rule must win on held-out examples'
  );
  assert(
    negative.rejectedCandidates === 1 &&
      negative.selectedInstruction === BASE_INSTRUCTION,
    'a no-benefit proposal from an irrelevant reference must be rejected'
  );
  assert(
    baseline.metricCalls === 16 &&
      informed.metricCalls === 16 &&
      negative.metricCalls === 12,
    'all runs must stay within their exact metric-call budgets'
  );
  assert(
    informedMeasurements.proposalPrompt.includes('amber-cobra') &&
      !informedMeasurements.proposalPrompt.includes('amber-lynx'),
    'maxExamples=1 must bound proposal evidence to the first example'
  );
  assert(
    informedMeasurements.proposalPrompt.includes(
      'BEGIN TRUSTED OPTIMIZATION REFERENCE 1'
    ),
    'the informed proposal must include a delimited trusted reference'
  );

  const report = {
    mode: 'controlled-zero-cost',
    scope:
      'Optimizer mechanics and generalization gating only; not real-model efficacy.',
    candidateScores: {
      base: {
        train: scoreInstruction(BASE_INSTRUCTION, train),
        heldOut: scoreInstruction(BASE_INSTRUCTION, heldOut),
      },
      memorized: {
        train: scoreInstruction(MEMORIZED_INSTRUCTION, train),
        heldOut: scoreInstruction(MEMORIZED_INSTRUCTION, heldOut),
      },
      general: {
        train: scoreInstruction(GENERAL_INSTRUCTION, train),
        heldOut: scoreInstruction(GENERAL_INSTRUCTION, heldOut),
      },
    },
    runs: { baseline, informed, negative },
    measuredOverhead: {
      baselineTeacherCalls: baselineMeasurements.teacherCalls,
      informedTeacherCalls: informedMeasurements.teacherCalls,
      negativeTeacherCalls: negativeMeasurements.teacherCalls,
      baselineProposalPromptChars: baselineMeasurements.proposalPromptChars,
      informedProposalPromptChars: informedMeasurements.proposalPromptChars,
      renderedGeneralReferenceChars:
        renderGEPAOptimizationReferences([generalReference])?.length ?? 0,
      note: 'References add prompt characters but no metric calls; maxExamples can reduce reflective-example prompt size.',
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

async function runReal() {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY;
  if (!apiKey) {
    throw new Error('Set OPENAI_API_KEY or OPENAI_APIKEY for --real.');
  }
  const teacher = ai({
    name: 'openai',
    apiKey,
    config: { model: AxAIOpenAIModel.GPT54Mini },
  });
  const baseline = await runHillClimb({
    label: 'live-baseline-gepa',
    teacher,
    proposal: { maxExamples: 1 },
    maxMetricCalls: 16,
  });
  const informed = await runHillClimb({
    label: 'live-reference-informed',
    teacher,
    proposal: {
      references: [generalReference],
      maxExamples: 1,
    },
    maxMetricCalls: 16,
  });
  console.log(
    JSON.stringify(
      {
        mode: 'optional-live-proposer',
        bounds: {
          trialsPerRun: 1,
          maximumTeacherModelCalls: 6,
          maximumMetricCalls: 32,
        },
        baseline,
        informed,
      },
      null,
      2
    )
  );
}

await (process.argv.includes('--real') ? runReal() : runControlled());
