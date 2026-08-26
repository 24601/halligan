import {
  AxAIOpenAIModel,
  type AxMetricResult,
  ai,
  ax,
  optimize,
} from '@ax-llm/ax';

if (process.env.AX_RUN_LIVE_QUALITATIVE_GEPA_EVAL !== '1') {
  throw new Error(
    'Set AX_RUN_LIVE_QUALITATIVE_GEPA_EVAL=1 to acknowledge this bounded paid evaluation.'
  );
}

const llm = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

const train = [
  { messageText: 'Urgent outage in payments', expectedPriority: 'urgent' },
  { messageText: 'Weekly product update', expectedPriority: 'normal' },
];
const heldOut = [
  { messageText: 'The server is down', expectedPriority: 'urgent' },
  { messageText: 'Team lunch reminder', expectedPriority: 'normal' },
];

const numericProgram = ax(
  'messageText:string -> priority:class "urgent, normal" "Operational urgency"'
);
const qualitativeProgram = ax(
  'messageText:string -> priority:class "urgent, normal" "Operational urgency"'
);

const numericMetric = ({
  prediction,
  example,
}: {
  prediction: any;
  example: any;
}) => (prediction.priority === example.expectedPriority ? 1 : 0);
const qualitativeMetric = ({
  prediction,
  example,
}: {
  prediction: any;
  example: any;
}): AxMetricResult<'accuracy'> => {
  const correct = prediction.priority === example.expectedPriority;
  return {
    score: correct ? 1 : 0,
    feedback: correct
      ? undefined
      : `Expected ${example.expectedPriority}. Treat outages and down systems as urgent; routine updates and reminders are normal.`,
    scores: { accuracy: correct ? 1 : 0 },
  };
};

const numericResult = await optimize(numericProgram, train, numericMetric, {
  studentAI: llm,
  teacherAI: llm,
  bootstrap: false,
  validationExamples: heldOut,
  numTrials: 1,
  minibatch: false,
  maxMetricCalls: 8,
  seed: 7,
});
numericProgram.applyOptimization(numericResult.optimizedProgram!);

const qualitativeResult = await optimize(
  qualitativeProgram,
  train,
  qualitativeMetric,
  {
    studentAI: llm,
    teacherAI: llm,
    bootstrap: false,
    validationExamples: heldOut,
    numTrials: 1,
    minibatch: false,
    maxMetricCalls: 8,
    seed: 7,
  }
);
qualitativeProgram.applyOptimization(qualitativeResult.optimizedProgram!);

let numericHeldOut = 0;
let qualitativeHeldOut = 0;
for (const example of heldOut) {
  const numericPrediction = await numericProgram.forward(llm, example);
  const qualitativePrediction = await qualitativeProgram.forward(llm, example);
  numericHeldOut += numericMetric({ prediction: numericPrediction, example });
  qualitativeHeldOut += qualitativeMetric({
    prediction: qualitativePrediction,
    example,
  }).score;
}

console.log({
  numericHeldOut: numericHeldOut / heldOut.length,
  qualitativeHeldOut: qualitativeHeldOut / heldOut.length,
  numericMetricCalls: numericResult.stats.totalCalls,
  qualitativeMetricCalls: qualitativeResult.stats.totalCalls,
});
