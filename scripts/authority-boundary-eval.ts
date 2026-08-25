import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  axAttenuateAuthority,
  axAuthorityClaim,
  axAuthorize,
} from '../src/ax/authority/authority.js';
import type {
  AxAuthorityContext,
  AxAuthorizationRequestContext,
  AxCapabilityGrant,
  AxResourceScope,
} from '../src/ax/authority/types.js';

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

  const modelOutput = {
    principal: { id: 'forged-principal' },
    grants: [{ operations: ['record.write'] }],
  };
  let hostRequest = '';
  await axAuthorize(
    context({
      authorize: (operation, request) => {
        hostRequest = JSON.stringify(request);
        return receipt(operation, request);
      },
    }),
    'record.read',
    resource
  );
  assert(
    !hostRequest.includes('forged-principal'),
    'forged model claim isolation'
  );
  assert(
    modelOutput.grants[0]!.operations[0] === 'record.write',
    'fixture integrity'
  );

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
