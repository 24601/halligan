// ax-example:start
// title: TypeScript Host-authorized Agent
// group: short-agents
// description: Carries exact host-owned identity and capability scope into an agent tool call.
// provider: openai
// env: OPENAI_API_KEY, OPENAI_APIKEY
// level: advanced
// order: 30
// ax-example:end
import {
  AxAIOpenAIModel,
  type AxAuthorityContext,
  agent,
  ai,
  f,
  fn,
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

const lookup = {
  ...fn('lookup')
    .namespace('records')
    .description('Look up one synthetic record by its exact identifier.')
    .arg('id', f.string('Record identifier.'))
    .returns(f.json('The matching record.'))
    .handler(({ id }, extra) => ({
      id,
      status: 'active',
      authorizationReceiptId: extra?.authorityReceipt?.receiptId,
    }))
    .build(),
  componentId: 'records:lookup',
};

const now = Date.now();
const authority: AxAuthorityContext = {
  principal: { id: 'subject-42', tenantId: 'tenant-a' },
  actor: { id: 'assistant-7', kind: 'agent' },
  leaseEpoch: 3,
  grants: [
    {
      version: 1,
      id: 'grant-9',
      principalId: 'subject-42',
      actor: { id: 'assistant-7', kind: 'agent' },
      operations: ['function.call'],
      resources: [
        { type: 'function', id: 'records:lookup', tenantId: 'tenant-a' },
      ],
      expiresAt: now + 60_000,
      leaseEpoch: 3,
    },
  ],
  authorize: (operation, request) => ({
    version: 1,
    receiptId: `receipt-${request.requestId}`,
    requestId: request.requestId,
    decision: 'allow', // after the host's authoritative policy check
    operation,
    resource: request.resource,
    principalId: request.principal.id,
    actor: { id: request.actor.id, kind: request.actor.kind },
    grantIds: request.grants.map((grant) => grant.id),
    leaseEpoch: request.leaseEpoch,
    authorizedAt: request.now,
  }),
};

const assistant = agent('recordId:string -> summary:string', {
  functions: [lookup],
  maxTurns: 4,
});

const result = await assistant.forward(
  llm,
  { recordId: 'record-17' },
  { authority }
);

console.log(result);
