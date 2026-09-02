/**
 * Verifier-gated working state (LIVE — real model, real tokens).
 *
 * An inventory agent with a host-seeded goal ledger. A goal flips to `done`
 * only when the model cites a receipt the harness minted for a real tool
 * dispatch, so a self-reported completion parks visibly instead of committing.
 * The checker additionally refuses a `shipped` fact write that no pick receipt
 * supports.
 *
 * Nothing here fabricates the agent's answer or a receipt: the receipts come
 * from the real dispatch site, and the printed document is the committed one.
 *
 * Run: `OPENAI_APIKEY=… npm run tsx src/examples/agent-working-state.ts`
 */
import {
  AxAIOpenAIModel,
  type AxEventVerifierResult,
  type AxWorkingStateTraceStep,
  agent,
  ai,
  f,
  fn,
} from '@ax-llm/ax';

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY;
if (!apiKey) {
  throw new Error(
    'OPENAI_API_KEY (or OPENAI_APIKEY) is required for the working-state example'
  );
}

const inventoryTools = [
  fn('pick')
    .namespace('inventory')
    .description('Pick every line on an order and return what was picked.')
    .arg('order', f.string('Order id such as 42'))
    .returns(f.json('The picked lines'))
    .handler(async ({ order }) => ({ order, picked: 3, status: 'picked' }))
    .build(),
  fn('dispatch')
    .namespace('shipping')
    .description('Hand a picked order to the carrier.')
    .arg('order', f.string('Order id such as 42'))
    .returns(f.json('The carrier acknowledgement'))
    .handler(async ({ order }) => ({
      order,
      carrier: 'UPS',
      status: 'shipped',
    }))
    .build(),
];

const traceSteps: AxWorkingStateTraceStep[] = [];

const inventoryAgent = agent('task:string -> answer:string', {
  functions: inventoryTools,
  workingState: {
    // Only these OUTPUT fields are legal roots under /facts.
    stateSignature: 'orderId:string, itemsPacked:number, shipped:boolean',
    initial: {
      goals: {
        g_pick: {
          id: 'g_pick',
          goal: 'Pick every line on order 42',
          status: 'pending',
          evidence: [],
          expects: ['inventory.pick'],
          createdTurn: 0,
          updatedTurn: 0,
        },
        g_ship: {
          id: 'g_ship',
          goal: 'Hand order 42 to the carrier',
          status: 'pending',
          evidence: [],
          expects: ['shipping.dispatch'],
          createdTurn: 0,
          updatedTurn: 0,
        },
      },
      facts: { orderId: '42', itemsPacked: 0, shipped: false },
    },
    // The tightest available Goodhart control: only these callables can mint.
    receiptSources: ['inventory.*', 'shipping.*'],
    checker: {
      id: 'ship-guard',
      timeoutMs: 5_000,
      maxParksPerRun: 12,
      check: ({ proposedState, receipts }): AxEventVerifierResult =>
        proposedState.facts.shipped === true &&
        !receipts.some((receipt) => receipt.qualifiedName === 'inventory.pick')
          ? { status: 'fail', failure: { code: 'shipped_before_picked' } }
          : { status: 'pass' },
    },
    trace: true,
    onTrace: (step) => {
      traceSteps.push(step);
    },
  },
});

const llm = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

const result = await inventoryAgent.forward(llm, {
  task: 'Pick order 42, hand it to the carrier, and report what happened.',
});

console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify(inventoryAgent.getWorkingState(), null, 2));
console.log(
  JSON.stringify(
    traceSteps.map((step) => ({
      turn: step.turn,
      outcome: step.outcome,
      committed: step.committed,
      parked: step.parked,
      receipts: step.observation.receipts,
    })),
    null,
    2
  )
);
