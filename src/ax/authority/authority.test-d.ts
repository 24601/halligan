import {
  type AxAuthorityContext,
  type AxAuthorizationReceipt,
  type AxCapabilityGrant,
  type AxPrincipal,
  axAttenuateAuthority,
  axAuthorize,
  axSnapshotAuthority,
} from '../index.js';

const principal: AxPrincipal = { id: 'subject', tenantId: 'tenant' };
const grant: AxCapabilityGrant = {
  version: 1,
  id: 'grant',
  principalId: principal.id,
  actor: { id: 'agent', kind: 'agent' },
  operations: ['function.call'],
  resources: [{ type: 'function', id: 'lookup', tenantId: 'tenant' }],
  leaseEpoch: 1,
};
const authority: AxAuthorityContext = {
  principal,
  actor: { id: 'agent', kind: 'agent' },
  grants: [grant],
  leaseEpoch: 1,
  authorizeTimeoutMs: 1_000,
  authorize: (operation, context): AxAuthorizationReceipt => ({
    version: 1,
    receiptId: 'receipt',
    requestId: context.requestId,
    decision: 'allow',
    operation,
    resource: context.resource,
    principalId: context.principal.id,
    actor: { id: context.actor.id, kind: context.actor.kind },
    grantIds: context.grants.map((value) => value.id),
    leaseEpoch: context.leaseEpoch,
    authorizedAt: context.now,
  }),
};

const snapshot: Readonly<AxAuthorityContext> = axSnapshotAuthority(authority);
void snapshot;

void axAuthorize(authority, 'function.call', {
  type: 'function',
  id: 'lookup',
  tenantId: 'tenant',
});

void axAttenuateAuthority(authority, {
  principal: { id: 'child', tenantId: 'tenant' },
  actor: { id: 'child-agent', kind: 'agent' },
  delegation: { parentPrincipalId: principal.id, depth: 1 },
  grants: [
    {
      ...grant,
      id: 'child-grant',
      principalId: 'child',
      actor: { id: 'child-agent', kind: 'agent' },
      parentGrantId: grant.id,
    },
  ],
});
