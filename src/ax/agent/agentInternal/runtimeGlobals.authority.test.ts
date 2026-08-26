import { describe, expect, it } from 'vitest';
import type { AxFunction } from '../../ai/types.js';
import type { AxAuthorityContext } from '../../authority/types.js';
import { AxJSRuntime } from '../../funcs/jsRuntime.js';
import { buildRuntimeGlobals, wrapFunction } from './runtimeGlobals.js';

function authorityFixture(decision: 'allow' | 'deny' = 'allow') {
  let authorizationCalls = 0;
  const authority: AxAuthorityContext = {
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'agent-a', kind: 'agent' },
    grants: [
      {
        version: 1,
        id: 'grant-a',
        principalId: 'principal-a',
        operations: ['function.call'],
        resources: [
          {
            type: 'function',
            id: 'records:lookup',
            tenantId: 'tenant-a',
          },
        ],
        leaseEpoch: 1,
      },
    ],
    leaseEpoch: 1,
    now: () => 100,
    authorize: (operation, context) => {
      authorizationCalls++;
      return {
        version: 1,
        receiptId: `receipt-${authorizationCalls}`,
        requestId: context.requestId,
        decision,
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      };
    },
  };
  return { authority, authorizationCalls: () => authorizationCalls };
}

async function executeWithSpeculation(
  callable: (...args: unknown[]) => Promise<unknown>
) {
  const events: Array<{ kind: string; reason?: string }> = [];
  const runtime = new AxJSRuntime({
    outputMode: 'return',
    useNodePermissionModel: false,
    speculation: {
      callables: {
        'tools.lookup': { purity: 'pure', deterministic: true },
      },
      onEvent: (event) => events.push(event),
    },
  });
  const session = runtime.createSession({ tools: { lookup: callable } });
  try {
    try {
      return {
        value: await session.execute(
          'const value = await tools.lookup({ id: "record-a" }); return value;'
        ),
        events,
      };
    } catch (error) {
      return { error, events };
    }
  } finally {
    session.close();
  }
}

describe('live runtime function authority', () => {
  it('authorizes before executing and passes only the bound receipt', async () => {
    let executed = false;
    let seenReceipt: unknown;
    const fn: AxFunction = {
      name: 'lookup',
      componentId: 'records:lookup',
      description: 'lookup a synthetic record',
      parameters: { type: 'object', additionalProperties: true },
      func: (_args, extra) => {
        executed = true;
        seenReceipt = extra?.authorityReceipt;
        return 'value';
      },
    };
    const authority: AxAuthorityContext = {
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'agent-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'grant-a',
          principalId: 'principal-a',
          operations: ['function.call'],
          resources: [
            {
              type: 'function',
              id: 'records:lookup',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
      ],
      leaseEpoch: 1,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: 'receipt-a',
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
    };

    const callable = wrapFunction(
      fn,
      undefined,
      undefined,
      undefined,
      'tools.lookup',
      undefined,
      'external',
      undefined,
      undefined,
      authority
    );
    await expect(
      callable({ grants: [{ id: 'forged-by-model' }] })
    ).resolves.toBe('value');
    expect(executed).toBe(true);
    expect(seenReceipt).toMatchObject({
      operation: 'function.call',
      grantIds: ['grant-a'],
    });
    expect(JSON.stringify(seenReceipt)).not.toContain('forged-by-model');
  });

  it('authorizes speculative work before launch without double authorization', async () => {
    const fixture = authorityFixture();
    let executions = 0;
    let observations = 0;
    let seenReceipt: unknown;
    const callable = wrapFunction(
      {
        name: 'lookup',
        componentId: 'records:lookup',
        description: 'lookup a synthetic record',
        parameters: { type: 'object', additionalProperties: true },
        func: (_args, extra) => {
          executions++;
          seenReceipt = extra?.authorityReceipt;
          return 'value';
        },
      },
      undefined,
      undefined,
      undefined,
      'tools.lookup',
      undefined,
      'external',
      () => {
        observations++;
      },
      undefined,
      fixture.authority
    );

    const execution = await executeWithSpeculation(callable);

    expect(execution.value).toBe('value');
    expect(
      execution.events.filter((event) => event.kind === 'hit')
    ).toHaveLength(1);
    expect(fixture.authorizationCalls()).toBe(1);
    expect(executions).toBe(1);
    expect(observations).toBe(1);
    expect(seenReceipt).toMatchObject({
      decision: 'allow',
      operation: 'function.call',
      resource: { id: 'records:lookup' },
      leaseEpoch: 1,
    });
  });

  it('launches no physical or logical work when speculative authorization is denied', async () => {
    const fixture = authorityFixture('deny');
    let executions = 0;
    let observations = 0;
    const callable = wrapFunction(
      {
        name: 'lookup',
        componentId: 'records:lookup',
        description: 'lookup a synthetic record',
        parameters: { type: 'object', additionalProperties: true },
        func: () => {
          executions++;
          return 'must-not-run';
        },
      },
      undefined,
      undefined,
      undefined,
      'tools.lookup',
      undefined,
      'external',
      () => {
        observations++;
      },
      undefined,
      fixture.authority
    );

    const execution = await executeWithSpeculation(callable);

    expect(execution.error).toMatchObject({
      message: 'Host denied function.call',
    });
    expect(fixture.authorizationCalls()).toBe(1);
    expect(executions).toBe(0);
    expect(observations).toBe(0);
  });

  it('authorizes every model-callable MCP and UCP runtime operation', async () => {
    const namespace = 'synthetic';
    const targets = [
      ['mcp.prompt.list', 'mcp.prompt.catalog', namespace],
      ['mcp.prompt.get', 'mcp.prompt', `${namespace}:summary`],
      ['mcp.resource.list', 'mcp.resource.catalog', namespace],
      ['mcp.resource.templates', 'mcp.resource.catalog', namespace],
      ['mcp.resource.read', 'mcp.resource', `${namespace}:resource://one`],
      ['mcp.resource.subscribe', 'mcp.resource', `${namespace}:resource://one`],
      [
        'mcp.resource.unsubscribe',
        'mcp.resource',
        `${namespace}:resource://one`,
      ],
      ['mcp.task.list', 'mcp.task.catalog', namespace],
      ['mcp.task.get', 'mcp.task', `${namespace}:task-1`],
      ['mcp.task.result', 'mcp.task', `${namespace}:task-1`],
      ['mcp.task.cancel', 'mcp.task', `${namespace}:task-1`],
      [
        'mcp.completion.complete',
        'mcp.completion',
        `${namespace}:ref/prompt:summary`,
      ],
      ['ucp.profile.read', 'ucp.catalog', namespace],
      ['ucp.operation.list', 'ucp.catalog', namespace],
    ] as const;
    const authorized: string[] = [];
    const authority: AxAuthorityContext = {
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'agent-a', kind: 'agent' },
      grants: targets.map(([operation, type, id], index) => ({
        version: 1 as const,
        id: `grant-${index}`,
        principalId: 'principal-a',
        operations: [operation],
        resources: [{ type, id, tenantId: 'tenant-a' }],
        leaseEpoch: 1,
      })),
      leaseEpoch: 1,
      now: () => 100,
      authorize: (operation, context) => {
        authorized.push(operation);
        return {
          version: 1,
          receiptId: `receipt-${operation}`,
          requestId: context.requestId,
          decision: 'allow',
          operation,
          resource: context.resource,
          principalId: context.principal.id,
          actor: { id: context.actor.id, kind: context.actor.kind },
          grantIds: context.grants.map((grant) => grant.id),
          leaseEpoch: context.leaseEpoch,
          authorizedAt: context.now,
        };
      },
    };
    let clientCalls = 0;
    const called = <T>(value: T) => {
      clientCalls++;
      return value;
    };
    const client = {
      getNamespace: () => namespace,
      getPrompts: () => called([]),
      getPrompt: async () => called({ messages: [] }),
      getResources: () => called([]),
      getResourceTemplates: () => called([]),
      readResource: async () => called({ contents: [] }),
      subscribeResource: async () => called(undefined),
      unsubscribeResource: async () => called(undefined),
      listTasks: async () => called({ tasks: [] }),
      getTask: async () => called({ taskId: 'task-1' }),
      getTaskResult: async () => called({}),
      cancelTask: async () => called(undefined),
      complete: async () => called({ completion: { values: [] } }),
    };
    const ucpClient = {
      getNamespace: () => namespace,
      getOperationBindings: () => [],
      getProfile: () => called({ version: '1' }),
      getOperationNames: () => called([]),
    };
    const globals = buildRuntimeGlobals({
      agentFunctionModuleMetadata: new Map(),
      agentFunctions: [],
      _activeAuthority: authority,
      _activeMCPExecutionContext: {
        clients: [client],
        ucpClients: [ucpClient],
        getToolBindings: () => [],
      },
    }) as any;
    const mcp = globals.mcp[namespace];
    await mcp.prompts.list();
    await mcp.prompts.get('summary');
    await mcp.resources.list();
    await mcp.resources.templates();
    await mcp.resources.read('resource://one');
    await mcp.resources.subscribe('resource://one');
    await mcp.resources.unsubscribe('resource://one');
    await mcp.tasks.list();
    await mcp.tasks.get('task-1');
    await mcp.tasks.result('task-1');
    await mcp.tasks.cancel('task-1');
    await mcp.complete(
      { type: 'ref/prompt', name: 'summary' },
      { name: 'topic', value: 'synthetic' }
    );
    await globals.ucp[namespace].profile();
    await globals.ucp[namespace].operations();

    expect(authorized).toEqual(targets.map(([operation]) => operation));
    expect(clientCalls).toBe(targets.length);
    await expect(mcp.resources.read('resource://forged')).rejects.toMatchObject(
      {
        code: 'no_matching_grant',
      }
    );
    expect(clientCalls).toBe(targets.length);
  });

  it('does not authorize one MCP namespace with another namespace grant', async () => {
    const customerReads: string[] = [];
    const adminReads: string[] = [];
    const authority: AxAuthorityContext = {
      principal: { id: 'principal-a', tenantId: 'tenant-a' },
      actor: { id: 'agent-a', kind: 'agent' },
      grants: [
        {
          version: 1,
          id: 'grant-customer',
          principalId: 'principal-a',
          operations: ['mcp.resource.read'],
          resources: [
            {
              type: 'mcp.resource',
              id: 'customer:file:///records/1',
              tenantId: 'tenant-a',
            },
          ],
          leaseEpoch: 1,
        },
      ],
      leaseEpoch: 1,
      now: () => 100,
      authorize: (operation, context) => ({
        version: 1,
        receiptId: 'receipt-customer',
        requestId: context.requestId,
        decision: 'allow',
        operation,
        resource: context.resource,
        principalId: context.principal.id,
        actor: { id: context.actor.id, kind: context.actor.kind },
        grantIds: context.grants.map((grant) => grant.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      }),
    };
    const customer = {
      getNamespace: () => 'customer',
      getPrompts: () => [],
      getPrompt: async () => ({ messages: [] }),
      getResources: () => [],
      getResourceTemplates: () => [],
      readResource: async (uri: string) => {
        customerReads.push(uri);
        return { contents: [] };
      },
      subscribeResource: async () => undefined,
      unsubscribeResource: async () => undefined,
      listTasks: async () => ({ tasks: [] }),
      getTask: async () => ({ taskId: 'task-1' }),
      getTaskResult: async () => ({}),
      cancelTask: async () => undefined,
      complete: async () => ({ completion: { values: [] } }),
    };
    const admin = {
      ...customer,
      getNamespace: () => 'admin',
      readResource: async (uri: string) => {
        adminReads.push(uri);
        return { contents: [] };
      },
    };
    const globals = buildRuntimeGlobals({
      agentFunctionModuleMetadata: new Map(),
      agentFunctions: [],
      _activeAuthority: authority,
      _activeMCPExecutionContext: {
        clients: [customer, admin],
        ucpClients: [],
        getToolBindings: () => [],
      },
    }) as any;

    await expect(
      globals.mcp.customer.resources.read('file:///records/1')
    ).resolves.toEqual({ contents: [] });
    await expect(
      globals.mcp.admin.resources.read('file:///records/1')
    ).rejects.toMatchObject({ code: 'no_matching_grant' });
    expect(customerReads).toEqual(['file:///records/1']);
    expect(adminReads).toEqual([]);
  });
});
