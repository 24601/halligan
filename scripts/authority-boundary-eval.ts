import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { agent } from '../src/ax/agent/index.js';
import { AxMockAIService } from '../src/ax/ai/mock/api.js';
import type { AxFunction } from '../src/ax/ai/types.js';
import {
  axAttenuateAuthority,
  axAuthorityClaim,
  axAuthorize,
  axSnapshotAuthority,
} from '../src/ax/authority/authority.js';
import type {
  AxAuthorityContext,
  AxAuthorizationRequestContext,
  AxCapabilityGrant,
  AxResourceScope,
} from '../src/ax/authority/types.js';
import { AxGen } from '../src/ax/dsp/generate.js';
import { AxSignature } from '../src/ax/dsp/sig.js';
import type { AxProgrammable } from '../src/ax/dsp/types.js';
import { AxInMemoryEventStore } from '../src/ax/event/memoryStore.js';
import {
  AxEventRuntime,
  eventRoute,
  eventTarget,
} from '../src/ax/event/runtime.js';
import { AxJSRuntime } from '../src/ax/funcs/jsRuntime.js';
import { AxMCPClient } from '../src/ax/mcp/client.js';
import { axMCPChildExecutionOptions } from '../src/ax/mcp/execution.js';
import type { AxMCPTransport } from '../src/ax/mcp/transport.js';
import { AxUCPClient } from '../src/ax/ucp/client.js';
import { AX_UCP_VERSION } from '../src/ax/ucp/types.js';

const NOW = 20_000;
const resource: AxResourceScope = {
  type: 'record',
  id: 'record-1',
  tenantId: 'tenant-a',
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`authority evaluation failed: ${message}`);
}

function baseGrant(
  override: Partial<AxCapabilityGrant> = {}
): AxCapabilityGrant {
  return {
    version: 1,
    id: 'grant-parent',
    principalId: 'principal-a',
    actor: { id: 'actor-a', kind: 'agent' },
    operations: ['record.read'],
    resources: [resource],
    issuedAt: NOW - 10,
    expiresAt: NOW + 10,
    leaseEpoch: 7,
    ...override,
  };
}

function receipt(
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>,
  override: Record<string, unknown> = {}
) {
  return {
    version: 1 as const,
    receiptId: 'receipt',
    requestId: context.requestId,
    decision: 'allow' as const,
    operation,
    resource: context.resource,
    principalId: context.principal.id,
    actor: { id: context.actor.id, kind: context.actor.kind },
    grantIds: context.grants.map((grant) => grant.id),
    leaseEpoch: context.leaseEpoch,
    authorizedAt: context.now,
    ...override,
  };
}

function context(
  override: Partial<AxAuthorityContext> = {}
): AxAuthorityContext {
  return {
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'actor-a', kind: 'agent' },
    grants: [baseGrant()],
    leaseEpoch: 7,
    now: () => NOW,
    authorize: (operation, request) => receipt(operation, request),
    ...override,
  };
}

async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function productionModelDispatchProbe(): Promise<void> {
  let ordinaryCalls = 0;
  let mcpEffects = 0;
  let ucpEffects = 0;
  const hostRequests: string[] = [];
  const mcpTransport: AxMCPTransport = {
    send: async (request) => {
      if (request.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'synthetic', version: '1' },
          },
        };
      }
      if (request.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'effect',
                description: 'Synthetic effect',
                inputSchema: { type: 'object', additionalProperties: true },
              },
            ],
          },
        };
      }
      if (request.method === 'tools/call') mcpEffects++;
      return { jsonrpc: '2.0', id: request.id, result: {} };
    },
    sendNotification: async () => {},
  };
  const mcp = new AxMCPClient(mcpTransport, { namespace: 'synthetic' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    if (!init?.method) {
      return Response.json({
        ucp: {
          version: AX_UCP_VERSION,
          services: {
            'dev.ucp.shopping': [
              {
                version: AX_UCP_VERSION,
                transport: 'rest',
                endpoint: 'https://service.example/ucp',
              },
            ],
          },
          capabilities: {
            'dev.ucp.shopping.checkout': [{ version: AX_UCP_VERSION }],
          },
        },
      });
    }
    ucpEffects++;
    return Response.json({
      ucp: { version: AX_UCP_VERSION, status: 'success' },
      id: 'synthetic-result',
    });
  };
  const ucp = new AxUCPClient({
    profileUrl: 'https://service.example',
    agentProfile: 'https://agent.example/.well-known/ucp',
    transport: 'rest',
    mcp: { ssrfProtection: { disabled: true } },
  });
  const dispatchAuthority = context({
    grants: [
      baseGrant({
        id: 'ordinary-grant',
        operations: ['function.call'],
        resources: [
          { type: 'function', id: 'utils.lookup', tenantId: 'tenant-a' },
        ],
      }),
      baseGrant({
        id: 'mcp-grant',
        operations: ['mcp.tool.call'],
        resources: [
          {
            type: 'mcp.tool',
            id: 'synthetic:effect',
            tenantId: 'tenant-a',
          },
        ],
      }),
      baseGrant({
        id: 'ucp-grant',
        operations: ['ucp.operation.call'],
        resources: [
          {
            type: 'ucp.operation',
            id: 'ucp:create_checkout',
            tenantId: 'tenant-a',
          },
        ],
      }),
    ],
    authorize: (operation, request) => {
      hostRequests.push(JSON.stringify(request));
      return receipt(operation, request, {
        decision: operation === 'function.call' ? 'allow' : 'deny',
        grantIds:
          operation === 'function.call'
            ? request.grants.map((grant) => grant.id)
            : [],
      });
    },
  });
  let executorTurn = 0;
  const ai = new AxMockAIService({
    features: { functions: true, streaming: false },
    chatResponse: async (request) => {
      const system = String(request.chatPrompt[0]?.content ?? '');
      const reply = (content: string) => ({
        results: [{ index: 0, content, finishReason: 'stop' as const }],
      });
      if (system.includes('You (`distiller`)')) {
        return reply(
          'Javascript Code: ```javascript\nawait final("Run synthetic calls", {});\n```'
        );
      }
      if (system.includes('You (`executor`)')) {
        executorTurn++;
        return reply(
          executorTurn === 1
            ? `Javascript Code: \`\`\`javascript
const forged = { principal: { id: "model-principal" }, grants: [{ id: "model-grant" }] };
const ordinary = await utils.lookup(forged);
let mcpDenied = false;
let ucpDenied = false;
try { await mcp.synthetic.tools.effect(forged); } catch { mcpDenied = true; }
try { await ucp.ucp.create_checkout({ checkout: { line_items: [] }, ...forged }); } catch { ucpDenied = true; }
await final("Report synthetic dispatch", { ordinary, mcpDenied, ucpDenied });
\`\`\``
            : 'Javascript Code: ```javascript\nawait final("Done", {});\n```'
        );
      }
      return reply('answer: complete');
    },
  });
  const program = agent('query:string -> answer:string', {
    functions: [
      {
        name: 'lookup',
        description: 'Synthetic ordinary function',
        parameters: { type: 'object', additionalProperties: true },
        func: () => {
          ordinaryCalls++;
          return 'ordinary-ok';
        },
      },
    ],
    mcp: [mcp],
    ucp: [ucp],
    contextFields: [],
    runtime: new AxJSRuntime(),
  });
  try {
    await program.forward(
      ai,
      { query: 'synthetic dispatch' },
      { authority: dispatchAuthority }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(ordinaryCalls === 1, 'production ordinary function dispatch');
  assert(mcpEffects === 0, 'denied production MCP host execution');
  assert(ucpEffects === 0, 'denied production UCP host execution');
  assert(hostRequests.length === 3, 'production host authorization calls');
  assert(
    hostRequests.every((request) => !request.includes('model-principal')),
    'production forged principal isolation'
  );
  assert(
    hostRequests.every((request) => !request.includes('model-grant')),
    'production forged grant isolation'
  );
}

export interface AuthorityEvaluationReport {
  baseline: {
    name: 'unscoped operation callback';
    adversarialAttemptsAccepted: number;
  };
  scoped: {
    adversarialAttemptsDenied: number;
    totalAdversarialAttempts: number;
  };
  receiptBinding: 'passed';
  attenuation: 'passed';
  cancellation: 'passed';
  malformedClaims: 'passed';
  forgedModelClaims: 'passed';
  immutableSnapshots: 'passed';
  authorizerTimeout: 'passed';
  modelCallablePaths: {
    productionFunction: 'passed';
    productionMCP: 'passed';
    productionUCP: 'passed';
    nativeDSP: 'passed';
    sinkRedrive: 'passed';
  };
  auditRedaction: 'passed';
  overhead: {
    iterations: number;
    baselineMeanMs: number;
    scopedMeanMs: number;
    incrementalMeanMs: number;
  };
}

export async function runAuthorityEvaluation(
  iterations = 500
): Promise<AuthorityEvaluationReport> {
  const unscopedAuthorize = async (_operation: string) => true;
  const attacks: Array<{
    authority: AxAuthorityContext;
    operation: string;
    resource: AxResourceScope;
  }> = [
    {
      authority: context({ grants: [baseGrant({ expiresAt: NOW })] }),
      operation: 'record.read',
      resource,
    },
    {
      authority: context({ grants: [baseGrant({ revokedAt: NOW - 1 })] }),
      operation: 'record.read',
      resource,
    },
    {
      authority: context({ leaseEpoch: 8 }),
      operation: 'record.read',
      resource,
    },
    { authority: context(), operation: 'record.write', resource },
    {
      authority: context(),
      operation: 'record.read',
      resource: { ...resource, id: 'record-2' },
    },
    {
      authority: context(),
      operation: 'record.read',
      resource: { ...resource, tenantId: 'tenant-b' },
    },
    {
      authority: context({ actor: { id: 'human-a', kind: 'human' } }),
      operation: 'record.read',
      resource,
    },
    {
      authority: context({
        authorize: (operation, request) =>
          receipt(operation, request, { requestId: 'wrong-request' }),
      }),
      operation: 'record.read',
      resource,
    },
  ];
  let baselineAccepted = 0;
  let scopedDenied = 0;
  for (const attack of attacks) {
    if (await unscopedAuthorize(attack.operation)) baselineAccepted++;
    if (
      await denied(() =>
        axAuthorize(attack.authority, attack.operation, attack.resource)
      )
    ) {
      scopedDenied++;
    }
  }
  assert(baselineAccepted === attacks.length, 'baseline comparison');
  assert(scopedDenied === attacks.length, 'scoped adversarial denials');

  const parent = context();
  const child = axAttenuateAuthority(parent, {
    principal: { id: 'principal-child', tenantId: 'tenant-a' },
    actor: { id: 'actor-child', kind: 'agent' },
    delegation: { parentPrincipalId: 'principal-a', depth: 1 },
    grants: [
      baseGrant({
        id: 'grant-child',
        principalId: 'principal-child',
        actor: { id: 'actor-child', kind: 'agent' },
        parentGrantId: 'grant-parent',
        expiresAt: NOW + 5,
      }),
    ],
  });
  await axAuthorize(child, 'record.read', resource);
  assert(
    await denied(() =>
      Promise.resolve().then(() =>
        axAttenuateAuthority(parent, {
          principal: { id: 'principal-child', tenantId: 'tenant-a' },
          actor: { id: 'actor-child', kind: 'agent' },
          delegation: { parentPrincipalId: 'principal-a', depth: 1 },
          grants: [
            baseGrant({
              id: 'grant-child-expanded',
              principalId: 'principal-child',
              parentGrantId: 'grant-parent',
              operations: ['record.read', 'record.write'],
            }),
          ],
        })
      )
    ),
    'child privilege expansion'
  );

  const controller = new AbortController();
  controller.abort('child cancelled');
  assert(
    await denied(() =>
      axAuthorize(child, 'record.read', resource, controller.signal)
    ),
    'child cancellation'
  );

  const firstNested = axMCPChildExecutionOptions({
    authority: parent,
    authorityInheritance: {
      principal: child.principal,
      actor: child.actor,
      delegation: child.delegation!,
      grants: child.grants,
    },
  });
  assert(
    !('authorityInheritance' in firstNested),
    'explicit attenuation consumption'
  );
  const secondNested = axMCPChildExecutionOptions(firstNested);
  assert(
    secondNested.authority?.principal.id === 'principal-child' &&
      secondNested.authority.delegation?.depth === 1,
    'two-level child authority propagation'
  );

  assert(
    await denied(() =>
      axAuthorize(
        context({
          principal: {
            id: 'principal-a',
            tenantId: 'tenant-a',
            claims: [{ type: 'legacy', value: undefined as never }],
          },
        }),
        'record.read',
        resource
      )
    ),
    'malformed legacy claim'
  );

  const mutableClaim = { nested: { role: 'reader' } };
  const mutableGrant = baseGrant({ resources: [{ ...resource }] });
  const immutable = axSnapshotAuthority(
    context({
      principal: {
        id: 'principal-a',
        tenantId: 'tenant-a',
        claims: [{ type: 'profile', value: mutableClaim }],
      },
      grants: [mutableGrant],
    })
  );
  mutableClaim.nested.role = 'administrator';
  (mutableGrant.operations as string[])[0] = 'record.write';
  assert(
    immutable.grants[0]?.operations[0] === 'record.read',
    'grant mutation after snapshot'
  );
  assert(
    JSON.stringify(immutable.principal.claims).includes('reader'),
    'nested claim mutation after snapshot'
  );
  let getterReads = 0;
  const getterGrant = {
    ...baseGrant(),
    get operations() {
      getterReads++;
      return getterReads === 1 ? ['record.read'] : ['record.write'];
    },
  } as AxCapabilityGrant;
  const getterSnapshot = axSnapshotAuthority(
    context({ grants: [getterGrant] })
  );
  assert(getterReads === 1, 'getter-backed grant single capture');
  assert(
    getterSnapshot.grants[0]?.operations[0] === 'record.read',
    'getter-backed grant captured value'
  );
  await axAuthorize(getterSnapshot, 'record.read', resource);
  assert(getterReads === 1, 'getter-backed grant post-validation reread');

  let timedOutSignal: AbortSignal | undefined;
  assert(
    await denied(() =>
      axAuthorize(
        context({
          authorizeTimeoutMs: 5,
          authorize: (_operation, request) => {
            timedOutSignal = request.signal;
            return new Promise<never>(() => {});
          },
        }),
        'record.read',
        resource
      )
    ),
    'hung authorizer timeout'
  );
  assert(timedOutSignal?.aborted, 'hung authorizer abort signal');

  await productionModelDispatchProbe();

  let nestedDenied = false;
  const nestedAuthority = context({
    grants: [
      baseGrant({
        id: 'invoke-parent',
        operations: ['function.call'],
        resources: [
          { type: 'function', id: 'nestedprobe', tenantId: 'tenant-a' },
        ],
      }),
      baseGrant({ id: 'read-parent' }),
    ],
  });
  const nestedFunction: AxFunction = {
    name: 'nestedProbe',
    componentId: 'nested-probe',
    description: 'synthetic nested probe',
    parameters: { type: 'object', additionalProperties: true },
    func: async (_args, extra) => {
      const options = axMCPChildExecutionOptions({
        authority: extra?.authority,
        authorityInheritance: extra?.authorityInheritance,
      });
      nestedDenied = await denied(() =>
        axAuthorize(options.authority, 'record.read', resource)
      );
      return nestedDenied;
    },
  };
  let nestedStep = 0;
  const nestedAI = new AxMockAIService({
    features: { functions: true, streaming: false },
    chatResponse: async () => {
      nestedStep++;
      return nestedStep === 1
        ? {
            results: [
              {
                index: 0,
                content: '',
                finishReason: 'function_call' as const,
                functionCalls: [
                  {
                    id: 'model-call',
                    type: 'function' as const,
                    function: {
                      name: 'nestedProbe',
                      params: JSON.stringify({ authorityInheritance: 'all' }),
                    },
                  },
                ],
              },
            ],
          }
        : {
            results: [
              {
                index: 0,
                content: 'answer: complete',
                finishReason: 'stop' as const,
              },
            ],
          };
    },
  });
  const nestedGen = new AxGen<{ query: string }, { answer: string }>(
    'query:string -> answer:string',
    { functions: [nestedFunction] }
  );
  await nestedGen.forward(
    nestedAI,
    { query: 'run nested probe' },
    {
      authority: nestedAuthority,
      authorityInheritance: 'none',
      stream: false,
    }
  );
  assert(nestedDenied, 'native nested authority inheritance none');

  const eventStore = new AxInMemoryEventStore();
  let sinkWrites = 0;
  let includeRedriveGrant = true;
  const eventAuthority = (): AxAuthorityContext => ({
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'actor-a', kind: 'agent' },
    grants: [
      {
        version: 1,
        id: 'event-target',
        principalId: 'principal-a',
        operations: ['event.target.invoke'],
        resources: [
          { type: 'event.target', id: 'eval-target', tenantId: 'tenant-a' },
        ],
        leaseEpoch: 7,
      },
      ...(includeRedriveGrant
        ? [
            {
              version: 1 as const,
              id: 'event-sink',
              principalId: 'principal-a',
              operations: ['event.sink.write'],
              resources: [
                {
                  type: 'event.sink',
                  id: 'eval-sink',
                  tenantId: 'tenant-a',
                },
              ],
              leaseEpoch: 7,
            },
          ]
        : []),
    ],
    leaseEpoch: 7,
    now: () => NOW,
    authorize: (operation, request) => receipt(operation, request),
  });
  const eventProgram: AxProgrammable<
    { eventId?: string },
    { handled: boolean }
  > = {
    forward: async () => ({ handled: true }),
    streamingForward: async function* () {
      yield { version: 0, index: 0, delta: { handled: true } };
    },
    getSignature: () => new AxSignature('eventId?:string -> handled:boolean'),
    getId: () => 'eval-program',
  };
  const eventRuntime = new AxEventRuntime({
    authority: eventAuthority,
    maxAttempts: 1,
    store: eventStore,
    routes: [
      eventRoute({
        id: 'eval-route',
        match: { types: ['eval.event'] },
        action: 'wake',
        target: eventTarget({
          id: 'eval-target',
          ai: {} as never,
          program: eventProgram,
          mapInput: () => ({ eventId: 'eval-event' }),
          retrySafety: 'idempotent',
          sinks: [
            {
              id: 'eval-sink',
              write: async () => {
                sinkWrites++;
                throw new Error('synthetic sink failure');
              },
            },
          ],
        }),
      }),
    ],
  });
  await eventRuntime.start();
  await eventRuntime.publish({
    event: {
      specversion: '1.0',
      id: 'eval-event',
      source: 'urn:synthetic',
      type: 'eval.event',
      data: { value: 'synthetic' },
    },
  });
  await eventRuntime.waitForIdle();
  const eventDeadLetters = await eventRuntime.listDeadLetters();
  const sinkDeadLetter = eventDeadLetters.find(
    (value) => value.kind === 'sink'
  );
  assert(
    sinkDeadLetter,
    `sink dead letter fixture: ${JSON.stringify(eventDeadLetters)}`
  );
  includeRedriveGrant = false;
  assert(
    await denied(() => eventRuntime.redrive(sinkDeadLetter.id)),
    'sink redrive without current authority'
  );
  assert(sinkWrites === 1, 'unauthorized sink redrive executed');
  await eventRuntime.close();

  const audits: unknown[] = [];
  await axAuthorize(
    context({
      principal: {
        id: 'principal-secret',
        tenantId: 'tenant-a',
        claims: [axAuthorityClaim('private', 'claim-secret')],
      },
      grants: [baseGrant({ principalId: 'principal-secret' })],
      onAudit: (event) => {
        audits.push(event);
      },
    }),
    'record.read',
    resource
  );
  const auditJson = JSON.stringify(audits);
  assert(!auditJson.includes('secret'), 'audit redaction');
  assert(!auditJson.includes('record-1'), 'audit resource ID redaction');

  const baselineStart = performance.now();
  for (let index = 0; index < iterations; index++) {
    await unscopedAuthorize('record.read');
  }
  const baselineMs = performance.now() - baselineStart;
  const scopedStart = performance.now();
  for (let index = 0; index < iterations; index++) {
    await axAuthorize(context(), 'record.read', resource);
  }
  const scopedMs = performance.now() - scopedStart;
  const baselineMeanMs = baselineMs / iterations;
  const scopedMeanMs = scopedMs / iterations;

  return {
    baseline: {
      name: 'unscoped operation callback',
      adversarialAttemptsAccepted: baselineAccepted,
    },
    scoped: {
      adversarialAttemptsDenied: scopedDenied,
      totalAdversarialAttempts: attacks.length,
    },
    receiptBinding: 'passed',
    attenuation: 'passed',
    cancellation: 'passed',
    malformedClaims: 'passed',
    forgedModelClaims: 'passed',
    immutableSnapshots: 'passed',
    authorizerTimeout: 'passed',
    modelCallablePaths: {
      productionFunction: 'passed',
      productionMCP: 'passed',
      productionUCP: 'passed',
      nativeDSP: 'passed',
      sinkRedrive: 'passed',
    },
    auditRedaction: 'passed',
    overhead: {
      iterations,
      baselineMeanMs,
      scopedMeanMs,
      incrementalMeanMs: scopedMeanMs - baselineMeanMs,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const report = await runAuthorityEvaluation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
