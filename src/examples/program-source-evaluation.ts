import { AxAIOpenAIModel, ai, optimize, programSource } from '@ax-llm/ax';
import { runProgramSourceEvaluation } from '../ax/dsp/programSourceEvaluation.js';

console.log('MECHANISM EVIDENCE ONLY — NOT MODEL-QUALITY EVIDENCE');
console.log(await runProgramSourceEvaluation());

const paidRequested =
  process.argv.includes('--paid') || process.env.AX_PROGRAM_SOURCE_PAID === '1';
if (paidRequested) {
  if (!process.argv.includes('--ack-paid-calls')) {
    throw new Error(
      'Paid path requested. Re-run with --paid --ack-paid-calls to explicitly acknowledge paid API calls.'
    );
  }
  console.log(
    'PAID CALLS ACKNOWLEDGED: running at most 8 metric calls and 1 optimizer trial.'
  );
  if (!process.env.OPENAI_APIKEY) {
    throw new Error(
      'OPENAI_APIKEY is required for the acknowledged paid path.'
    );
  }
  const service = ai({
    name: 'openai',
    apiKey: process.env.OPENAI_APIKEY,
    config: { model: AxAIOpenAIModel.GPT54Mini },
  });
  const realProgram = programSource('text:string -> answer:string');
  const train = [
    { text: 'urgent outage', answer: 'urgent' },
    { text: 'routine update', answer: 'normal' },
  ];
  const heldOut = [
    { text: 'customer-impacting outage', answer: 'urgent' },
    { text: 'weekly status note', answer: 'normal' },
  ];
  const result = await optimize(
    realProgram,
    train,
    ({ prediction, example }) =>
      (prediction as { answer?: unknown }).answer ===
      (example as { answer: string }).answer
        ? 1
        : 0,
    {
      studentAI: service,
      teacherAI: service,
      validationExamples: heldOut,
      numTrials: 1,
      maxMetricCalls: 8,
      bootstrap: false,
    }
  );
  console.log({
    boundedPaidBestScore: result.bestScore,
    maxMetricCalls: 8,
    model: 'gpt-5.4-mini',
  });
} else {
  console.log(
    'Optional real-model path skipped (use --paid --ack-paid-calls; this incurs paid calls).'
  );
}
