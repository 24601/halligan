import {
  type AxAgentEvalTask,
  AxAIOpenAIModel,
  type AxHarnessTree,
  agent,
  ai,
  axApplyHarnessTree,
  axHarnessEvolve,
  axInMemoryLearningStore,
  axLearningSurface,
} from '@ax-llm/ax';

const apiKey = process.env.OPENAI_APIKEY ?? process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('Set OPENAI_APIKEY or OPENAI_API_KEY to run this example.');
}

const llm = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT5Mini, temperature: 0 },
});

// --- The versioned artifact -------------------------------------------------

const seed: AxHarnessTree = [
  {
    id: 'tone',
    kind: 'instruction',
    config: { text: 'Answer the support question in one sentence.' },
  },
];

const store = axInMemoryLearningStore();
const surface = await axLearningSurface({
  scenario: 'support-triage',
  store,
  seed,
});

const a = agent('question:string -> answer:string', {
  ai: llm,
  // A playbook handle so a `playbookBullet` entry has somewhere to install.
  // `learn: false` keeps run-accumulated bullets out of the evolved artifact.
  playbook: { learn: false },
  learning: { scenario: 'support-triage', store, surface },
});

// Serve the promoted head. Reading a head is not serving it, so the install is
// what makes a record's artifactRef honest.
const head = await surface.currentTree();
if (!head) throw new Error('the surface has no promoted head');
let installed = await axApplyHarnessTree(head.entries, a, {
  releaseId: head.releaseId,
  now: new Date().toISOString(),
});

// --- Serve, then grade ------------------------------------------------------

const questions = [
  'How long is the refund window?',
  'Can I change the shipping address after ordering?',
  'Do you ship to Norway?',
];

for (const question of questions) {
  const { output, receipt } = await a.learn().run(llm, { question });
  console.log(`${question}\n  -> ${output.answer}`);
  // One report per receipt. A report naming several receipts never batches.
  await a.learn().report({
    references: [receipt.recordId],
    score: output.answer.split(/[.!?]/).filter(Boolean).length === 1 ? 1 : 0,
    feedback: 'one sentence or it did not follow the instruction',
  });
}

// --- Grow -------------------------------------------------------------------

const task = (
  id: string,
  question: string
): AxAgentEvalTask<{
  question: string;
}> => ({
  id,
  input: { question },
  criteria: 'answers in exactly one sentence',
});

const oneSentence = ({ prediction }: { prediction: unknown }) => {
  const answer = String(
    (prediction as { output?: { answer?: string } })?.output?.answer ?? ''
  );
  return answer.split(/[.!?]/).filter((part) => part.trim()).length === 1
    ? 1
    : 0;
};

const step = await axHarnessEvolve({
  agent: a,
  ai: llm,
  surface,
  tasks: {
    train: [
      task('t1', 'How long is the refund window?'),
      task('t2', 'Do you ship to Norway?'),
    ],
    validation: [task('v1', 'Can I change my shipping address?')],
  },
  metric: oneSentence,
  // A deterministic host proposer. Wiring a model behind this is a separate
  // decision; whatever sits here writes CONTENT and nothing else.
  propose: () => [
    {
      op: 'create',
      id: 'brevity',
      options: {
        kind: 'playbookBullet',
        config: {
          id: 'one-sentence',
          section: 'General',
          content:
            'Answer with exactly one sentence. Do not add a closing pleasantry.',
        },
      },
    },
  ],
});

console.log(`\nstatus: ${step.status}`);
console.log(`reason: ${step.decision?.reason ?? step.reason}`);
console.log(
  `held-in ${JSON.stringify(step.decision?.metrics.heldIn)} held-out ${JSON.stringify(step.decision?.metrics.heldOut)}`
);
console.log(
  `suppressed recorded runs during the step: ${step.suppressedRecords}`
);

// --- Deploy: the human decision point ---------------------------------------

if (step.status === 'nominated' && step.release) {
  // NOTHING IN AX REACHES THIS LINE FOR YOU. `axHarnessEvolve` appended a
  // release with `current: false`; moving the head is a person's call, and this
  // example makes it explicitly.
  await surface.promote(step.release.releaseId, head.releaseId);
  installed.dispose();
  installed = await axApplyHarnessTree(step.release.entries, a, {
    releaseId: step.release.releaseId,
    parentReleaseId: step.release.parentReleaseId,
    now: new Date().toISOString(),
  });
}

const current = await surface.currentTree();
console.log(`\nserving release ${current?.releaseId} (${current?.contentId})`);
console.log(JSON.stringify(current?.entries, null, 2));

installed.dispose();
await store.close?.();
