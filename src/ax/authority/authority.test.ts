import { describe, expect, it, vi } from 'vitest';
import { axMCPChildExecutionOptions } from '../mcp/execution.js';
import {
  type AxAuthorizationDeniedError,
  axAttenuateAuthority,
  axAuthorityClaim,
  axAuthorize,
  axFunctionAuthorityTarget,
} from './authority.js';
import type {
  AxAuthorityContext,
  AxAuthorizationRequestContext,
  AxCapabilityGrant,
  AxResourceScope,
} from './types.js';

const NOW = 10_000;
const resource: AxResourceScope = {
  type: 'document',
  id: 'doc-1',
  tenantId: 'tenant-a',
};

function grant(override: Partial<AxCapabilityGrant> = {}): AxCapabilityGrant {
  return {
    version: 1,
    id: 'grant-1',
    principalId: 'principal-a',
    actor: { id: 'actor-a', kind: 'agent' },
    operations: ['document.read'],
    resources: [resource],
    issuedAt: NOW - 100,
    expiresAt: NOW + 100,
    leaseEpoch: 3,
    ...override,
  };
}

function authority(
  override: Partial<AxAuthorityContext> = {}
): AxAuthorityContext {
  return {
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'actor-a', kind: 'agent' },
    grants: [grant()],
    leaseEpoch: 3,
    now: () => NOW,
    authorize: (operation, context) => allow(operation, context),
    ...override,
  };
}

function allow(
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>,
  override: Record<string, unknown> = {}
) {
  return {
    version: 1 as const,
    receiptId: 'receipt-1',
    requestId: context.requestId,
    decision: 'allow' as const,
    operation,
    resource: context.resource,
    principalId: context.principal.id,
    actor: { id: context.actor.id, kind: context.actor.kind },
    grantIds: context.grants.map((value) => value.id),
    leaseEpoch: context.leaseEpoch,
    authorizedAt: context.now,
    ...override,
  };
}

describe('Ax host authority boundary', () => {
  it('derives exact generic, child-agent, MCP, and UCP bindings', () => {
    const host = authority();
    expect(
      axFunctionAuthorityTarget(
        { name: 'read', description: 'read', func: () => undefined },
        host
      )
    ).toMatchObject({
      operation: 'function.call',
      resource: { type: 'function', id: 'read' },
    });
    expect(
      axFunctionAuthorityTarget(
        {
          name: 'child',
          componentId: 'agent:workers:child',
          description: 'child',
          func: () => undefined,
        },
        host
      )
    ).toMatchObject({
      operation: 'agent.invoke',
      resource: { type: 'agent', id: 'agent:workers:child' },
    });
    for (const protocol of [
      { kind: 'mcp' as const, operation: 'mcp.tool.call', type: 'mcp.tool' },
      {
        kind: 'ucp' as const,
        operation: 'ucp.operation.call',
        type: 'ucp.operation',
      },
    ]) {
      expect(
        axFunctionAuthorityTarget(
          {
            name: 'lookup',
            description: 'lookup',
            protocol: {
              kind: protocol.kind,
              namespace: 'records',
              name: 'lookup',
            },
            func: () => undefined,
          },
          host
        )
      ).toMatchObject({
        operation: protocol.operation,
        resource: { type: protocol.type, id: 'records:lookup' },
      });
    }
  });

  it('requires an active exact operation, resource, tenant, actor, and lease grant', async () => {
    await expect(
      axAuthorize(authority(), 'document.read', resource)
    ).resolves.toMatchObject({ decision: 'allow', grantIds: ['grant-1'] });

    const cases: Array<[string, AxAuthorityContext, string, AxResourceScope]> =
      [
        [
          'expired',
          authority({ grants: [grant({ expiresAt: NOW })] }),
          'document.read',
          resource,
        ],
        [
          'revoked',
          authority({ grants: [grant({ revokedAt: NOW - 1 })] }),
          'document.read',
          resource,
        ],
        [
          'stale lease',
          authority({ leaseEpoch: 4 }),
          'document.read',
          resource,
        ],
        [
          'wrong actor',
          authority({ actor: { id: 'human-a', kind: 'human' } }),
          'document.read',
          resource,
        ],
        ['wrong operation', authority(), 'document.write', resource],
        [
          'wrong resource',
          authority(),
          'document.read',
          { ...resource, id: 'doc-2' },
        ],
        [
          'wrong tenant',
          authority(),
          'document.read',
          { ...resource, tenantId: 'tenant-b' },
        ],
      ];
    for (const [name, context, operation, scopedResource] of cases) {
      await expect(
        axAuthorize(context, operation, scopedResource),
        name
      ).rejects.toMatchObject({ code: 'no_matching_grant' });
    }
  });

  it('rejects malformed legacy claims before invoking host policy', async () => {
    const authorize = vi.fn();
    const malformed = authority({
      authorize,
      principal: {
        id: 'principal-a',
        tenantId: 'tenant-a',
        claims: [{ type: 'legacy', value: undefined as never }],
      },
    });
    await expect(
      axAuthorize(malformed, 'document.read', resource)
    ).rejects.toThrow('not a persistable authority value');
    expect(authorize).not.toHaveBeenCalled();
    expect(() => axAuthorityClaim('legacy', { value: Number.NaN })).toThrow(
      'finite number'
    );
  });

  it('fails closed when a host receipt is bound to anything else', async () => {
    for (const override of [
      { requestId: 'another-request' },
      { operation: 'document.write' },
      { resource: { ...resource, id: 'doc-2' } },
      { principalId: 'principal-b' },
      { actor: { id: 'actor-a', kind: 'human' } },
      { grantIds: ['forged-grant'] },
      { grantIds: [] },
      { leaseEpoch: 4 },
      { expiresAt: NOW },
    ]) {
      const context = authority({
        authorize: (operation, request) => allow(operation, request, override),
      });
      await expect(
        axAuthorize(context, 'document.read', resource)
      ).rejects.toMatchObject({ code: 'invalid_receipt' });
    }
  });

  it('lets the authoritative host deny an otherwise matching grant', async () => {
    const context = authority({
      authorize: (operation, request) =>
        allow(operation, request, { decision: 'deny', grantIds: [] }),
    });
    await expect(
      axAuthorize(context, 'document.read', resource)
    ).rejects.toEqual(
      expect.objectContaining<Partial<AxAuthorizationDeniedError>>({
        code: 'host_denied',
      })
    );
  });

  it('enforces child attenuation and rejects privilege expansion', async () => {
    const parent = authority();
    const childGrant = grant({
      id: 'grant-child',
      principalId: 'principal-child',
      parentGrantId: 'grant-1',
      actor: { id: 'actor-child', kind: 'agent' },
      expiresAt: NOW + 50,
    });
    const child = axAttenuateAuthority(parent, {
      principal: { id: 'principal-child', tenantId: 'tenant-a' },
      actor: { id: 'actor-child', kind: 'agent' },
      delegation: { parentPrincipalId: 'principal-a', depth: 1 },
      grants: [childGrant],
    });
    await expect(
      axAuthorize(child, 'document.read', resource)
    ).resolves.toMatchObject({ decision: 'allow' });
    const childOptions = axMCPChildExecutionOptions({
      authority: parent,
      authorityInheritance: {
        principal: child.principal,
        actor: child.actor,
        delegation: child.delegation!,
        grants: child.grants,
      },
    });
    expect(childOptions.authority).toMatchObject({
      principal: { id: 'principal-child' },
      actor: { id: 'actor-child', kind: 'agent' },
    });

    const deniedChild = axMCPChildExecutionOptions({
      authority: parent,
      authorityInheritance: 'none' as const,
    });
    await expect(
      axAuthorize(deniedChild.authority, 'document.read', resource)
    ).rejects.toMatchObject({ code: 'no_matching_grant' });

    expect(() =>
      axAttenuateAuthority(parent, {
        principal: { id: 'principal-child', tenantId: 'tenant-a' },
        actor: { id: 'actor-child', kind: 'agent' },
        delegation: { parentPrincipalId: 'principal-a', depth: 1 },
        grants: [
          {
            ...childGrant,
            operations: ['document.read', 'document.write'],
          },
        ],
      })
    ).toThrow('expands parent authority');

    expect(() =>
      axAttenuateAuthority(
        authority({
          grants: [grant({ principalId: 'another-principal' })],
        }),
        {
          principal: { id: 'principal-child', tenantId: 'tenant-a' },
          actor: { id: 'actor-child', kind: 'agent' },
          delegation: { parentPrincipalId: 'principal-a', depth: 1 },
          grants: [childGrant],
        }
      )
    ).toThrow('expands parent authority');
  });

  it('cancels child authorization and emits only redacted audit data', async () => {
    const audits: unknown[] = [];
    const controller = new AbortController();
    controller.abort('cancel child');
    const context = authority({
      principal: {
        id: 'principal-secret',
        tenantId: 'tenant-a',
        claims: [axAuthorityClaim('private', 'claim-secret')],
      },
      grants: [grant({ principalId: 'principal-secret' })],
      onAudit: (event) => {
        audits.push(event);
      },
    });
    await expect(
      axAuthorize(context, 'document.read', resource, controller.signal)
    ).rejects.toMatchObject({ code: 'cancelled' });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain('principal-secret');
    expect(serialized).not.toContain('claim-secret');
    expect(serialized).not.toContain('doc-1');
    expect(audits).toEqual([
      expect.objectContaining({ code: 'cancelled', resourceType: 'document' }),
    ]);
  });
});
