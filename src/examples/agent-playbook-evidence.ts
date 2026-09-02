/**
 * Playbook evidence discipline (LIVE — real models, real tokens).
 *
 * One `agent.playbook().evolve()` run with the whole default-off evidence
 * surface turned on: a matched-budget control arm on the restored unevolved
 * program, an unchanged-artifact variance band, paired task-clustered bootstrap
 * intervals, validity conjuncts, reach, a per-cell transfer matrix against a
 * second backbone, and a sealed test evaluated once at the very end.
 *
 * Nothing here fabricates an evidence value. Every number printed is one the
 * run produced, including the ones that say a thing was NOT measured — a
 * `not_run` report and a `*_not_run` warning are the honest output when an
 * option is absent or when a phase had nothing to read.
 *
 * The two numbers to read first:
 *   - `sealedTest.delta` is the only non-selection number in the output.
 *   - `transfer.cells` has no average, on purpose. Read the cells.
 *
 * Run: `OPENAI_APIKEY=… npm run tsx src/examples/agent-playbook-evidence.ts`
 */
import { AxAIOpenAIModel, agent, ai } from '@ax-llm/ax';

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY;
if (!apiKey) {
  throw new Error(
    'OPENAI_API_KEY (or OPENAI_APIKEY) is required for the playbook evidence example'
  );
}

const student = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

/** The transfer target: a DIFFERENT backbone, so a cell measures transfer. */
const nano = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54Nano },
});

const support = agent(
  'ticket:string "A customer support ticket" -> reply:string "The support reply"',
  {
    ai: student,
    agentIdentity: {
      name: 'support',
      description:
        'Answers customer support tickets about refunds, shipping and returns.',
    },
    playbook: { learn: false },
  }
);

const task = (id: string, ticket: string, criteria: string) => ({
  id,
  input: { ticket },
  criteria,
});

// Semantic ids, because disjointness is proven by id and never by object
// identity or serialized contents.
const train = [
  task(
    'refund-late',
    'My refund has not arrived after 14 days.',
    'names the 14-day window and the next step'
  ),
  task(
    'return-damaged',
    'The mug arrived cracked. What now?',
    'offers a replacement or refund and asks for a photo'
  ),
  task(
    'ship-address',
    'I typed the wrong address. Can you fix it?',
    'says whether the order can still be redirected'
  ),
];
const validation = [
  task(
    'refund-partial',
    'I returned one of two items. Where is the partial refund?',
    'explains partial refund timing'
  ),
  task(
    'ship-delay',
    'My parcel has not moved for a week.',
    'gives a carrier-trace next step'
  ),
];
// Disjoint from BOTH splits by id: this is the only split that never selects.
const sealedTest = [
  task(
    'return-window',
    'Is a return still possible after 40 days?',
    'states the return window and the exception'
  ),
  task(
    'refund-method',
    'Can the refund go to a different card?',
    'states the original-payment-method rule'
  ),
];

/** A deterministic scorer, so the evidence is about the artifact, not a judge. */
const metric = async ({ prediction }: any) => {
  const reply = String(prediction?.output?.reply ?? '').toLowerCase();
  const signals = ['refund', 'return', 'ship', 'day', 'card', 'photo'];
  const hits = signals.filter((signal) => reply.includes(signal)).length;
  return Math.min(1, hits / 3);
};

const result = await support.playbook()!.evolve(
  { train, validation },
  {
    metric,
    requireHeldOut: true,
    runsPerTask: 2,
    varianceBand: { extraRepeats: 1 },
    intervalOptions: { level: 0.95, seed: 7 },
    controlArm: { arms: ['best_of_n', 'self_refine', 'harness_term'] },
    validity: { minFinalCompletionRate: 0.9, maxToolErrorRate: 0.1 },
    transfer: { targets: [{ id: 'nano', ai: nano }], splits: ['heldOut'] },
    gates: {
      interval: 'require',
      validity: 'require',
      controlArm: 'require',
      transfer: 'warn',
      reach: 'warn',
    },
    // The veto is the only channel that sees the candidate; the GRANT (not
    // shown) says whether this principal may promote into this playbook at all.
    promotionVeto: async (nomination) => !nomination.nominated,
    sealedTest,
  }
);

console.log(
  JSON.stringify(
    {
      applied: result.applied, // 'live' | 'dry_run' | 'rolled_back'
      baseline: result.baseline,
      final: result.final,
      control: result.control,
      transfer: result.transfer, // per cell; there is no average field
      overhead: result.overhead,
      sealedTest: result.sealedTest, // the only non-selection number here
      accounting: result.accounting,
      warnings: result.warnings, // includes held_out_reused_for_selection
      gates: result.outcomes.map(
        (outcome) => outcome.evidence?.gates.failedPredicate ?? outcome.reason
      ),
    },
    null,
    2
  )
);
