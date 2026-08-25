// cspell:ignore nestedprobe

import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxFunction } from '../ai/types.js';
import { axAuthorize } from '../authority/authority.js';
import type {
  AxAuthorityContext,
  AxAuthorityInheritance,
  AxAuthorizationRequestContext,
} from '../authority/types.js';
import { axMCPChildExecutionOptions } from '../mcp/execution.js';
import { AxGen } from './generate.js';

const resource = {
  type: 'document',
  id: 'doc-1',
  tenantId: 'tenant-a',
} as const;

function allow(
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>
) {
  return {
    version: 1 as const,
    receiptId: `receipt-${operation}`,
    requestId: context.requestId,
    decision: 'allow' as const,
    operation,
    resource: context.resource,
    principalId: context.principal.id,
    actor: { id: context.actor.id, kind: context.actor.kind },
    grantIds: context.grants.map((grant) => grant.id),
    leaseEpoch: context.leaseEpoch,
    authorizedAt: context.now,
  };
}

function authority(): AxAuthorityContext {
  return {
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'agent-a', kind: 'agent' },
    grants: [
      {
        version: 1,
        id: 'invoke-parent',
        principalId: 'principal-a',
        operations: ['function.call'],
        resources: [
          { type: 'function', id: 'nestedprobe', tenantId: 'tenant-a' },
        ],
        leaseEpoch: 1,
      },
      {
        version: 1,
        id: 'read-parent',
        principalId: 'principal-a',
        operations: ['document.read'],
        resources: [resource],
        leaseEpoch: 1,
      },
    ],
    leaseEpoch: 1,
    now: () => 100,
    authorize: allow,
  };
}

async function executeNestedProbe(
  inheritance: AxAuthorityInheritance,
  stream = false
) {
  let nestedAuthority: Readonly<AxAuthorityContext> | undefined;
  let nestedAllowed = false;
  const nested: AxFunction = {
    name: 'nestedProbe',
    componentId: 'nested-tool',
    description: 'Run a synthetic nested authorization probe',
    parameters: { type: 'object', additionalProperties: true },
    func: async (_args, extra) => {
      const child = axMCPChildExecutionOptions({
        authority: extra?.authority,
        authorityInheritance: extra?.authorityInheritance,
      });
      nestedAuthority = child.authority;
      try {
        await axAuthorize(child.authority, 'document.read', resource);
        nestedAllowed = true;
      } catch {}
      return { nestedAllowed };
    },
  };
  let calls = 0;
  const ai = new AxMockAIService({
    features: { functions: true, streaming: stream },
    chatResponse: async (_request, options) => {
      calls++;
      const response =
        calls === 1
          ? {
              results: [
                {
                  index: 0,
                  content: '',
                  functionCalls: [
                    {
                      id: 'call-1',
                      type: 'function' as const,
                      function: {
                        name: 'nestedProbe',
                        params: JSON.stringify({
                          authorityInheritance: 'all',
                          grants: [{ id: 'forged-by-model' }],
                        }),
                      },
                    },
                  ],
                  finishReason: 'function_call' as const,
                },
              ],
            }
          : {
              results: [
                {
                  index: 0,
                  content: 'Answer: complete',
                  finishReason: 'stop' as const,
                },
              ],
            };
      if (options?.stream) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(response);
            controller.close();
          },
        });
      }
      return response;
    },
  });
  const gen = new AxGen<{ question: string }, { answer: string }>(
    'question:string -> answer:string',
    { functions: [nested] }
  );
  await gen.forward(
    ai,
    { question: 'run nested probe' },
    { authority: authority(), authorityInheritance: inheritance, stream }
  );
  return { nestedAllowed, nestedAuthority };
}

describe('native model function authority inheritance', () => {
  it('threads none through native DSP execution and denies the nested call', async () => {
    const result = await executeNestedProbe('none');
    expect(result.nestedAllowed).toBe(false);
    expect(result.nestedAuthority?.grants).toEqual([]);
  });

  it('threads none through streaming DSP execution and denies the nested call', async () => {
    const result = await executeNestedProbe('none', true);
    expect(result.nestedAllowed).toBe(false);
    expect(result.nestedAuthority?.grants).toEqual([]);
  });

  it('threads an explicitly attenuated child through native DSP execution', async () => {
    const result = await executeNestedProbe({
      principal: { id: 'principal-child', tenantId: 'tenant-a' },
      actor: { id: 'agent-child', kind: 'agent' },
      delegation: { parentPrincipalId: 'principal-a', depth: 1 },
      grants: [
        {
          version: 1,
          id: 'read-child',
          principalId: 'principal-child',
          actor: { id: 'agent-child', kind: 'agent' },
          operations: ['document.read'],
          resources: [resource],
          leaseEpoch: 1,
          parentGrantId: 'read-parent',
        },
      ],
    });
    expect(result.nestedAllowed).toBe(true);
    expect(result.nestedAuthority?.principal.id).toBe('principal-child');
    expect(result.nestedAuthority?.grants.map((grant) => grant.id)).toEqual([
      'read-child',
    ]);
  });

  it('consumes explicit attenuation before a second child nesting', () => {
    const first = axMCPChildExecutionOptions({
      authority: authority(),
      authorityInheritance: {
        principal: { id: 'principal-child', tenantId: 'tenant-a' },
        actor: { id: 'agent-child', kind: 'agent' },
        delegation: { parentPrincipalId: 'principal-a', depth: 1 },
        grants: [
          {
            version: 1,
            id: 'read-child',
            principalId: 'principal-child',
            actor: { id: 'agent-child', kind: 'agent' },
            operations: ['document.read'],
            resources: [resource],
            leaseEpoch: 1,
            parentGrantId: 'read-parent',
          },
        ],
      } satisfies AxAuthorityInheritance,
    });
    expect(first).not.toHaveProperty('authorityInheritance');

    const second = axMCPChildExecutionOptions(first);
    expect(second.authority?.principal.id).toBe('principal-child');
    expect(second.authority?.delegation?.depth).toBe(1);
    expect(second.authority?.grants.map((grant) => grant.id)).toEqual([
      'read-child',
    ]);
  });
});
