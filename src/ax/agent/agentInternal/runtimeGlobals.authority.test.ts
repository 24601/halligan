import { describe, expect, it } from 'vitest';
import type { AxFunction } from '../../ai/types.js';
import type { AxAuthorityContext } from '../../authority/types.js';
import { wrapFunction } from './runtimeGlobals.js';

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
});
