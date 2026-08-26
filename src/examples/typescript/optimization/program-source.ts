// ax-example:start
// title: TypeScript Experimental Program-Source Optimization
// group: optimization
// description: Uses GEPA to propose and validate a complete capability-bounded program implementation.
// provider: openai
// env: OPENAI_API_KEY, OPENAI_APIKEY
// level: advanced
// order: 50
// ax-example:end
import {
  AxAIOpenAIModel,
  type AxFunction,
  ai,
  optimize,
  programSource,
} from '@ax-llm/ax';

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY;
if (!apiKey) {
  throw new Error('Set OPENAI_API_KEY or OPENAI_APIKEY to run this example.');
}

const llm = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54Mini, temperature: 0 },
});

const classifyUrgency: AxFunction = {
  name: 'classify_urgency',
  description: 'Classify whether a ticket is urgent from its text.',
  parameters: {
    type: 'object',
    properties: {
      ticketText: { type: 'string', description: 'Support ticket text' },
    },
    required: ['ticketText'],
  },
  returns: { type: 'string' },
  func: ({ ticketText }: { ticketText: string }) =>
    /outage|down|blocked/i.test(ticketText) ? 'urgent' : 'normal',
};

const triage = programSource(
  'ticketText:string -> priority:class "urgent, normal", rationale:string',
  {
    tools: [classifyUrgency],
    maxPredictorCalls: 4,
    maxToolCalls: 2,
    maxIterations: 48,
  }
);

const train = [
  { ticketText: 'Checkout is down for every customer.', priority: 'urgent' },
  { ticketText: 'Please update the billing address.', priority: 'normal' },
];
const heldOut = [
  { ticketText: 'Login outage blocks the EU region.', priority: 'urgent' },
  { ticketText: 'Question about next month’s invoice.', priority: 'normal' },
];
const metric = ({ prediction, example }: { prediction: any; example: any }) =>
  prediction.priority === example.priority ? 1 : 0;

const result = await optimize(triage, train, metric, {
  studentAI: llm,
  teacherAI: llm,
  validationExamples: heldOut,
  numTrials: 1,
  maxMetricCalls: 8,
  bootstrap: false,
});

if (!result.optimizedProgram) {
  throw new Error('Optimizer did not return a program-source artifact.');
}
triage.applyOptimization(result.optimizedProgram);

console.log({
  bestScore: result.bestScore,
  capabilities: triage.getCapabilities(),
  source: JSON.parse(triage.getProgramSource()),
});
