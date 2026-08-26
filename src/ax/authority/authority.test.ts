import { describe, expect, it, vi } from 'vitest';
import type { AxFunction } from '../ai/types.js';
import { axMCPChildExecutionOptions } from '../mcp/execution.js';
import {
  type AxAuthorizationDeniedError,
  axAttenuateAuthority,
  axAuthorityClaim,
  axAuthorize,
  axFunctionAuthorityTarget,
  axSnapshotAuthority,
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

  it('captures function authority target fields once into a coherent tuple', () => {
    const reads = {
      protocol: 0,
      kind: 0,
      namespace: 0,
      protocolName: 0,
      componentId: 0,
      functionName: 0,
      principal: 0,
      tenantId: 0,
    };
    const protocol = {
      get kind() {
        reads.kind++;
        return reads.kind === 1 ? 'mcp' : 'ucp';
      },
      get namespace() {
        reads.namespace++;
        return 'records';
      },
      get name() {
        reads.protocolName++;
        return 'lookup';
      },
    } as unknown as NonNullable<AxFunction['protocol']>;
    const fn = {
      get name() {
        reads.functionName++;
        return 'fallback';
      },
      get componentId() {
        reads.componentId++;
        return reads.componentId === 1 ? 'agent:first' : 'agent:forged';
      },
      get protocol() {
        reads.protocol++;
        return protocol;
      },
      description: 'getter-backed function',
      func: () => undefined,
    } as AxFunction;
    const principal = {
      id: 'principal-a',
      get tenantId() {
        reads.tenantId++;
        return 'tenant-a';
      },
    };
    const host = {
      ...authority(),
      get principal() {
        reads.principal++;
        return principal;
      },
    };

    expect(axFunctionAuthorityTarget(fn, host)).toEqual({
      operation: 'mcp.tool.call',
      resource: {
        type: 'mcp.tool',
        id: 'records:lookup',
        tenantId: 'tenant-a',
      },
    });
    expect(reads).toEqual({
      protocol: 1,
      kind: 1,
      namespace: 1,
      protocolName: 1,
      componentId: 1,
      functionName: 1,
      principal: 1,
      tenantId: 1,
    });

    let componentReads = 0;
    const componentFn = {
      name: 'fallback',
      get componentId() {
        componentReads++;
        return componentReads === 1 ? 'agent:first' : 'function:forged';
      },
      description: 'getter-backed component',
      func: () => undefined,
    } as AxFunction;
    expect(axFunctionAuthorityTarget(componentFn, authority())).toMatchObject({
      operation: 'agent.invoke',
      resource: { type: 'agent', id: 'agent:first' },
    });
    expect(componentReads).toBe(1);
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
      { expiresAt: String(NOW + 100) },
    ]) {
      const context = authority({
        authorize: (operation, request) => allow(operation, request, override),
      });
      await expect(
        axAuthorize(context, 'document.read', resource)
      ).rejects.toMatchObject({ code: 'invalid_receipt' });
    }
  });

  it('reports malformed host receipts as invalid without exposing runtime errors', async () => {
    const audits: unknown[] = [];
    for (const malformed of [
      null,
      {},
      { resource: null, actor: null, grantIds: null },
      { resource: resource, actor: {}, grantIds: [], receiptId: 1 },
    ]) {
      const context = authority({
        authorize: () => malformed as never,
        onAudit: (event) => {
          audits.push(event);
        },
      });
      await expect(
        axAuthorize(context, 'document.read', resource)
      ).rejects.toMatchObject({ code: 'invalid_receipt' });
    }
    expect(audits).toHaveLength(4);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_receipt', decision: 'deny' }),
      ])
    );
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

  it('deeply snapshots authority data before publication', async () => {
    const source = authority({
      principal: {
        id: 'principal-a',
        tenantId: 'tenant-a',
        claims: [
          { type: 'profile', value: { groups: ['readers'], nested: { n: 1 } } },
        ],
      },
      grants: [grant({ resources: [{ ...resource }] })],
    });
    const snapshot = axSnapshotAuthority(source);
    const sourceGrant = source.grants[0] as AxCapabilityGrant;
    (sourceGrant.operations as string[])[0] = 'document.write';
    (sourceGrant.resources[0] as AxResourceScope).id = 'doc-forged';
    const claim = source.principal.claims?.[0]?.value as {
      groups: string[];
      nested: { n: number };
    };
    claim.groups[0] = 'administrators';
    claim.nested.n = 2;

    expect(snapshot.grants[0]).toMatchObject({
      operations: ['document.read'],
      resources: [{ id: 'doc-1' }],
    });
    expect(snapshot.principal.claims?.[0]?.value).toEqual({
      groups: ['readers'],
      nested: { n: 1 },
    });
    expect(Object.isFrozen(snapshot.grants[0]?.operations)).toBe(true);
    expect(Object.isFrozen(snapshot.grants[0]?.resources[0])).toBe(true);
    expect(
      Object.isFrozen(
        (snapshot.principal.claims?.[0]?.value as { nested: object }).nested
      )
    ).toBe(true);
    await expect(
      axAuthorize(snapshot, 'document.read', resource)
    ).resolves.toMatchObject({ decision: 'allow' });
  });

  it('captures getter-backed authority fields exactly once before validation', async () => {
    let getterReads = 0;
    const getterGrant = {
      ...grant(),
      get operations() {
        getterReads++;
        return getterReads === 1 ? ['document.read'] : ['document.write'];
      },
    } as AxCapabilityGrant;
    const snapshot = axSnapshotAuthority(authority({ grants: [getterGrant] }));

    expect(getterReads).toBe(1);
    expect(snapshot.grants[0]?.operations).toEqual(['document.read']);
    await expect(
      axAuthorize(snapshot, 'document.read', resource)
    ).resolves.toMatchObject({ decision: 'allow' });
    await expect(
      axAuthorize(snapshot, 'document.write', resource)
    ).rejects.toMatchObject({ code: 'no_matching_grant' });
    expect(getterReads).toBe(1);
  });

  it('times out or cancels an authorizer that ignores abort', async () => {
    let timeoutSignal: AbortSignal | undefined;
    const never = new Promise<never>(() => {});
    await expect(
      axAuthorize(
        authority({
          authorizeTimeoutMs: 5,
          authorize: (_operation, request) => {
            timeoutSignal = request.signal;
            return never;
          },
        }),
        'document.read',
        resource
      )
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(timeoutSignal?.aborted).toBe(true);

    const controller = new AbortController();
    const pending = axAuthorize(
      authority({
        authorizeTimeoutMs: 1_000,
        authorize: () => never,
      }),
      'document.read',
      resource,
      controller.signal
    );
    controller.abort('stop');
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('ignores a late authorizer rejection after timeout', async () => {
    let lateReject!: (reason: unknown) => void;
    const late = new Promise<never>((_resolve, reject) => {
      lateReject = reject;
    });
    await expect(
      axAuthorize(
        authority({
          authorizeTimeoutMs: 5,
          authorize: (_operation, request) => {
            request.signal?.addEventListener(
              'abort',
              () => lateReject(new Error('host stopped after timeout')),
              { once: true }
            );
            return late;
          },
        }),
        'document.read',
        resource
      )
    ).rejects.toMatchObject({ code: 'timeout' });

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    await Promise.resolve();
    await Promise.resolve();
    process.off('unhandledRejection', onUnhandled);
    expect(rejections).toEqual([]);
  });
});
