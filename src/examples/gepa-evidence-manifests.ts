import {
  AxAIOpenAIModel,
  AxGEPA,
  AxInMemoryRejectedCandidateLedger,
  AxManualEventClock,
  ai,
  ax,
  axHarnessRecipe,
} from '@ax-llm/ax';

// Optimizes a real program with the full evidence surface turned on:
// discriminative minibatch selection, host-owned trajectory admission, a
// harness recipe with live staleness, per-candidate mutation annotation, and a
// rejected-candidate ledger fed back to the proposer as an untrusted prior.
//
// Nothing here fabricates a manifest. Every number printed at the end is read
// off the artifact GEPA actually produced.

const apiKey = process.env.OPENAI_APIKEY;
if (!apiKey) {
  throw new Error(
    'OPENAI_APIKEY is required. Export it and re-run: OPENAI_APIKEY=sk-... npm run tsx src/examples/gepa-evidence-manifests.ts'
  );
}

const STUDENT_MODEL = AxAIOpenAIModel.GPT54Mini;

const classifier = ax(
  'emailText:string "Email content" -> priority:class "high, normal, low" "Priority level"'
);

const train = [
  { emailText: 'URGENT: Server down!', priority: 'high' },
  { emailText: 'Meeting reminder for tomorrow', priority: 'normal' },
  { emailText: 'Weekly newsletter', priority: 'low' },
  { emailText: 'CRITICAL: Security breach', priority: 'high' },
  { emailText: 'Lunch plans?', priority: 'low' },
  { emailText: 'New feature rollout announcement', priority: 'normal' },
  { emailText: 'Production bug impacting checkout', priority: 'high' },
  { emailText: 'Team offsite agenda attached', priority: 'normal' },
];

const validation = [
  { emailText: 'Server CPU spiking, investigation needed', priority: 'high' },
  { emailText: 'Conference tickets available at discount', priority: 'low' },
  { emailText: 'Reminder: submit timesheets', priority: 'normal' },
  { emailText: 'Data breach follow-up actions required', priority: 'high' },
  { emailText: 'Office closed next Monday', priority: 'normal' },
  { emailText: 'Happy birthday to our teammate!', priority: 'low' },
];

const student = ai({
  name: 'openai',
  apiKey,
  config: { model: STUDENT_MODEL },
});

const teacher = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54 },
});

// The digest identifies the sockets this run was bound to; `boundModelId` is
// inside it, so the same bindings tuned against a different model are a
// different configuration.
const recipe = await axHarnessRecipe({
  bindings: [
    { port: 'model.student', atomId: STUDENT_MODEL, version: '1' },
    { port: 'model.teacher', atomId: AxAIOpenAIModel.GPT54, version: '1' },
  ],
  boundModelId: STUDENT_MODEL,
});

// A required, injected clock: expiry never depends on wall-clock time, and the
// ledger refuses an entry that could outlive its stated conditions.
const clock = new AxManualEventClock(Date.now());
const ledger = new AxInMemoryRejectedCandidateLedger({ clock });

const optimizer = new AxGEPA({
  studentAI: student,
  teacherAI: teacher,
  numTrials: 6,
  minibatch: true,
  minibatchSize: 3,
  earlyStoppingTrials: 4,
  seed: 42,
});

const result = await optimizer.compile(
  classifier,
  train,
  async ({ prediction, example }) =>
    prediction?.priority === example?.priority ? 1 : 0,
  {
    maxMetricCalls: 120,
    validationExamples: validation,
    candidateLineage: { includeReflectionOutcomes: true },
    minibatchStrategy: 'discriminative',
    // A provider outage is not the candidate's fault. Classify
    // CONSERVATIVELY: anything not clearly an environment failure stays in the
    // denominator, because mislabelling a policy failure launders a real
    // defect out of the evidence.
    trajectoryTermination: {
      classifier: (row) =>
        row.error?.includes('429') || row.error?.includes('503')
          ? { kind: 'environment_failure', cause: 'rate_limit' }
          : { kind: 'completed' },
      minAdmittedFraction: 0.5,
      maxRunDiscardRate: 0.5,
    },
    harnessRecipe: { recipe, currentModelId: STUDENT_MODEL },
    mutationAnnotation: {},
    rejectedCandidateLedger: {
      store: ledger,
      storeId: 'example-ledger',
      clock,
      // An `after_ms` clause is MANDATORY: without it an entry read with an
      // empty context would be permanent negative memory.
      expiresWhen: [
        { kind: 'after_ms', ttlMs: 24 * 60 * 60 * 1000 },
        { kind: 'model_changed', boundModelId: STUDENT_MODEL },
      ],
      expiryContext: { boundModelId: STUDENT_MODEL },
    },
  }
);

const manifest = result.optimizedProgram?.candidateLineage;

console.log('lineage version:', manifest?.version);
console.log('stopped reason:', manifest?.stoppedReason);
console.log('depth histogram:', manifest?.mutationDepthHistogram);
console.log('harness stamp:', manifest?.harness);
console.log('deployable best chain:', manifest?.bestChain);
console.log('run admission:', manifest?.admission);
console.log(
  'batch admission per record:',
  manifest?.records.map((record) => ({
    id: record.id,
    decision: record.decision,
    discardRate: record.admission?.discardRate,
    reflection: record.reflection?.map(
      (outcome) => `${outcome.category}=${outcome.count}`
    ),
  }))
);
console.log(
  'ledger ref on the artifact:',
  result.optimizedProgram?.rejectedCandidateLedgerRef
);
console.log(
  'rejected candidates still in the store:',
  (await ledger.list({ now: clock.now() })).length
);

await ledger.close?.();
