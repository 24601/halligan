import { describe, expect, it } from 'vitest';
import type { AxFunction } from '../../ai/types.js';
import type { AxAuthorityContext } from '../../authority/types.js';
import { AxJSRuntime } from '../../funcs/jsRuntime.js';
import { wrapFunction } from './runtimeGlobals.js';

function authorityFixture(decision: 'allow' | 'deny' = 'allow') {
  let authorizationCalls = 0;
  const grant = {
    version: 1 as const,
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
    revokedAt: undefined as number | undefined,
  };
  const authority: AxAuthorityContext = {
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'agent-a', kind: 'agent' },
    grants: [grant],
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
        grantIds: context.grants.map((candidate) => candidate.id),
        leaseEpoch: context.leaseEpoch,
        authorizedAt: context.now,
      };
    },
  };
  return {
    authority,
    grant,
    authorizationCalls: () => authorizationCalls,
  };
}

async function executeWithSpeculation(
  callable: (...args: unknown[]) => Promise<unknown>,
  code = 'const value = await tools.lookup({ id: "record-a" }); return value;',
  globals: Record<string, unknown> = {}
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
  const session = runtime.createSession({
    ...globals,
    tools: { lookup: callable },
  });
  try {
    try {
      return { value: await session.execute(code), events };
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

  it('authorizes a speculative physical call before launch without double authorization', async () => {
    const fixture = authorityFixture();
    let executions = 0;
    let observations = 0;
    let seenReceipt: unknown;
    const fn: AxFunction = {
      name: 'lookup',
      componentId: 'records:lookup',
      description: 'lookup a synthetic record',
      parameters: { type: 'object', additionalProperties: true },
      func: (_args, extra) => {
        executions++;
        seenReceipt = extra?.authorityReceipt;
        return 'value';
      },
    };
    const callable = wrapFunction(
      fn,
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
      leaseEpoch: 1,
    });
  });

  it('launches zero physical work when speculative authorization is denied', async () => {
    const fixture = authorityFixture('deny');
    let executions = 0;
    let observations = 0;
    const fn: AxFunction = {
      name: 'lookup',
      componentId: 'records:lookup',
      description: 'lookup a synthetic record',
      parameters: { type: 'object', additionalProperties: true },
      func: () => {
        executions++;
        return 'must-not-run';
      },
    };
    const callable = wrapFunction(
      fn,
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
    expect(observations).toBe(1);
  });

  it('discards an authorized future after grant revocation and falls back normally', async () => {
    const fixture = authorityFixture();
    let executions = 0;
    let physicalStartedResolve!: () => void;
    const physicalStarted = new Promise<void>((resolve) => {
      physicalStartedResolve = resolve;
    });
    let releaseWorkerResolve!: () => void;
    const releaseWorker = new Promise<void>((resolve) => {
      releaseWorkerResolve = resolve;
    });
    const fn: AxFunction = {
      name: 'lookup',
      componentId: 'records:lookup',
      description: 'lookup a synthetic record',
      parameters: { type: 'object', additionalProperties: true },
      func: () => {
        executions++;
        physicalStartedResolve();
        return 'stale-value';
      },
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
      fixture.authority
    );

    const execution = executeWithSpeculation(
      callable,
      'await gate.wait({}); const value = await tools.lookup({ id: "record-a" }); return value;',
      { gate: { wait: () => releaseWorker } }
    );
    await physicalStarted;
    fixture.grant.revokedAt = 100;
    releaseWorkerResolve();
    const outcome = await execution;

    expect(outcome.error).toMatchObject({
      message: 'No active capability grant matches function.call',
    });
    expect(
      outcome.events.some(
        (event) =>
          event.kind === 'miss' && event.reason === 'authority-invalidated'
      )
    ).toBe(true);
    expect(fixture.authorizationCalls()).toBe(1);
    expect(executions).toBe(1);
  });
});
