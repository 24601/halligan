import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  buildRuntimeGlobals,
  wrapFunction,
} from '../src/ax/agent/agentInternal/runtimeGlobals.js';
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
import { AxFunctionProcessor } from '../src/ax/dsp/functions.js';
import { AxSignature } from '../src/ax/dsp/sig.js';
import type { AxProgrammable } from '../src/ax/dsp/types.js';
import { AxInMemoryEventStore } from '../src/ax/event/memoryStore.js';
import {
  AxEventRuntime,
  eventRoute,
  eventTarget,
} from '../src/ax/event/runtime.js';
import { axMCPChildExecutionOptions } from '../src/ax/mcp/execution.js';

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
    functionGlobal: 'passed';
    mcpGlobal: 'passed';
    nestedFunction: 'passed';
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

  let hostRequest = '';
  const functionAuthority = context({
    grants: [
      baseGrant({
        operations: ['function.call'],
        resources: [
          { type: 'function', id: 'records:lookup', tenantId: 'tenant-a' },
        ],
      }),
    ],
    authorize: (operation, request) => {
      hostRequest = JSON.stringify(request);
      return receipt(operation, request);
    },
  });
  const modelCallable = wrapFunction(
    {
      name: 'lookup',
      componentId: 'records:lookup',
      description: 'synthetic lookup',
      parameters: { type: 'object', additionalProperties: true },
      func: () => 'ok',
    },
    undefined,
    undefined,
    undefined,
    'tools.lookup',
    undefined,
    'external',
    undefined,
    undefined,
    functionAuthority
  );
  await modelCallable({
    principal: { id: 'forged-principal' },
    grants: [{ operations: ['record.write'] }],
  });
  assert(
    !hostRequest.includes('forged-principal'),
    'forged model claim isolation in function global'
  );

  let mcpReads = 0;
  const mcpAuthority = context({
    grants: [
      baseGrant({
        operations: ['mcp.resource.read'],
        resources: [
          { type: 'mcp.resource', id: 'resource://safe', tenantId: 'tenant-a' },
        ],
      }),
    ],
  });
  const mcpGlobals = buildRuntimeGlobals({
    agentFunctionModuleMetadata: new Map(),
    agentFunctions: [],
    _activeAuthority: mcpAuthority,
    _activeMCPExecutionContext: {
      clients: [
        {
          getNamespace: () => 'synthetic',
          readResource: async () => {
            mcpReads++;
            return { contents: [] };
          },
        },
      ],
      ucpClients: [],
      getToolBindings: () => [],
    },
  }) as any;
  assert(
    await denied(() =>
      mcpGlobals.mcp.synthetic.resources.read('resource://forged')
    ),
    'forged MCP resource path'
  );
  assert(mcpReads === 0, 'forged MCP read executed');

  let nestedDenied = false;
  const nestedAuthority = context({
    grants: [
      baseGrant({
        id: 'invoke-parent',
        operations: ['function.call'],
        resources: [
          { type: 'function', id: 'nested-probe', tenantId: 'tenant-a' },
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
  await new AxFunctionProcessor([nestedFunction]).executeWithDetails(
    {
      id: 'model-call',
      name: 'nestedProbe',
      args: JSON.stringify({ authorityInheritance: 'all' }),
    },
    { authority: nestedAuthority, authorityInheritance: 'none' }
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
      functionGlobal: 'passed',
      mcpGlobal: 'passed',
      nestedFunction: 'passed',
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
