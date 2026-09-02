import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  type AxAuthorizationDeniedError,
  axAuthorize,
  axSnapshotAuthority,
  axValidateCapabilityGrant,
} from './authority.js';
import type {
  AxAuthorityContext,
  AxAuthorizationAuditEvent,
  AxAuthorizationRequestContext,
  AxCapabilityGrant,
  AxEvidenceObservation,
  AxEvidenceRequirement,
  AxResourceScope,
} from './types.js';

const NOW = 10_000;
const LEASE = 3;
const resource: AxResourceScope = {
  type: 'document',
  id: 'doc-1',
  tenantId: 'tenant-a',
};

function requirement(
  override: Partial<AxEvidenceRequirement> = {}
): AxEvidenceRequirement {
  return {
    kind: 'session.mfa',
    trustedSources: ['idp-a'],
    match: { op: 'eq', value: 'strong' },
    ...override,
  };
}

function observation(
  override: Partial<AxEvidenceObservation> = {}
): AxEvidenceObservation {
  return {
    version: 1,
    kind: 'session.mfa',
    sourceId: 'idp-a',
    observedAt: NOW - 1_000,
    value: 'strong',
    leaseEpoch: LEASE,
    ...override,
  };
}

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
    leaseEpoch: LEASE,
    ...override,
  };
}

function allow(
  operation: string,
  context: Readonly<AxAuthorizationRequestContext>
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
  };
}

function harness(override: Partial<AxAuthorityContext> = {}) {
  const audits: AxAuthorizationAuditEvent[] = [];
  const requests: Readonly<AxAuthorizationRequestContext>[] = [];
  const authority: AxAuthorityContext = {
    principal: { id: 'principal-a', tenantId: 'tenant-a' },
    actor: { id: 'actor-a', kind: 'agent' },
    grants: [grant()],
    leaseEpoch: LEASE,
    now: () => NOW,
    authorize: (operation, context) => {
      requests.push(context);
      return allow(operation, context);
    },
    onAudit: (event) => {
      audits.push({ ...event });
    },
    ...override,
  };
  return { audits, authority, requests };
}

async function denialCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'allowed';
  } catch (error) {
    return (error as AxAuthorizationDeniedError).code;
  }
}

describe('Ax evidence guards at the authorization boundary', () => {
  it('audit sequence is byte-identical when no grant declares requirements', async () => {
    // The additive claim, asserted at the audit level rather than inferred.
    const { audits, authority } = harness();
    await axAuthorize(authority, 'document.read', resource);
    expect(audits).toEqual([
      {
        operation: 'document.read',
        resourceType: 'document',
        actorKind: 'agent',
        decision: 'allow',
        grantCount: 1,
        at: NOW,
        code: 'authorized',
      },
    ]);
    expect(Object.keys(audits[0] ?? {})).not.toContain('failedPredicateKind');
  });

  it('axSnapshotAuthority preserves and freezes grant requirements', () => {
    // captureGrant rebuilds a grant from an explicit field list, so an
    // unlisted field is silently dropped. Without carrying requirements there,
    // every guard check below would be vacuous.
    const sources = ['idp-a'];
    const snapshot = axSnapshotAuthority({
      ...harness().authority,
      grants: [
        grant({
          requirements: [{ ...requirement(), trustedSources: sources }],
        }),
      ],
    });
    const captured = snapshot.grants[0]?.requirements;
    expect(captured).toHaveLength(1);
    expect(captured?.[0]?.kind).toBe('session.mfa');
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.[0])).toBe(true);
    expect(Object.isFrozen(captured?.[0]?.trustedSources)).toBe(true);
    // The snapshot must not alias the caller's array.
    expect(captured?.[0]?.trustedSources).not.toBe(sources);
    sources.push('idp-evil');
    expect(captured?.[0]?.trustedSources).toEqual(['idp-a']);
  });

  it('axSnapshotAuthority deep-clones and freezes evidence', () => {
    const value = { level: 'strong' };
    const snapshot = axSnapshotAuthority({
      ...harness().authority,
      evidence: [observation({ value })],
    });
    const captured = snapshot.evidence?.[0];
    expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured?.value).not.toBe(value);
    value.level = 'weak';
    expect(captured?.value).toEqual({ level: 'strong' });
  });

  it('axAuthorize denies from a raw AxAuthorityContext whose grant declares a requirement', async () => {
    // End to end from an unsnapshotted context through captureGrant ->
    // matchingGrants -> guards. Evaluator-only tests would pass even if the
    // guard block never fired.
    const { authority } = harness({
      grants: [grant({ requirements: [requirement()] })],
    });
    expect(
      await denialCode(axAuthorize(authority, 'document.read', resource))
    ).toBe('guard_predicate_failed');
  });

  it('denies with guard_predicate_failed without calling the host authorizer', async () => {
    const { audits, authority, requests } = harness({
      grants: [grant({ requirements: [requirement()] })],
      evidence: [observation({ value: 'weak' })],
    });
    expect(
      await denialCode(axAuthorize(authority, 'document.read', resource))
    ).toBe('guard_predicate_failed');
    expect(requests).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe('deny');
    expect(audits[0]?.grantCount).toBe(1);
  });

  it('allows when the declared requirement is satisfied', async () => {
    const { audits, authority, requests } = harness({
      grants: [grant({ requirements: [requirement()] })],
      evidence: [observation()],
    });
    const receipt = await axAuthorize(authority, 'document.read', resource);
    expect(receipt?.decision).toBe('allow');
    expect(requests).toHaveLength(1);
    expect(audits.map((event) => event.code)).toEqual(['authorized']);
  });

  it('audit failedPredicateKind is exactly op:kind and leaks nothing else', async () => {
    const { audits, authority } = harness({
      grants: [
        grant({
          requirements: [
            requirement({
              kind: 'device.posture',
              trustedSources: ['mdm-secret-source'],
              match: { op: 'in', values: ['managed-secret-value'] },
            }),
          ],
        }),
      ],
      evidence: [],
    });
    await denialCode(axAuthorize(authority, 'document.read', resource));
    expect(audits[0]?.failedPredicateKind).toBe('in:device.posture');
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain('mdm-secret-source');
    expect(serialized).not.toContain('managed-secret-value');
    expect(serialized).not.toContain('doc-1');
  });

  it('passes evidence and requirements into the host request context', async () => {
    const { authority, requests } = harness({
      grants: [grant({ requirements: [requirement()] })],
      evidence: [observation()],
    });
    await axAuthorize(authority, 'document.read', resource);
    expect(requests[0]?.requirements).toHaveLength(1);
    expect(requests[0]?.requirements?.[0]?.kind).toBe('session.mfa');
    expect(requests[0]?.evidence).toHaveLength(1);
    expect(requests[0]?.evidence?.[0]?.sourceId).toBe('idp-a');
  });

  it('supplies empty evidence and requirements when the host declares none', async () => {
    const { authority, requests } = harness();
    await axAuthorize(authority, 'document.read', resource);
    expect(requests[0]?.evidence).toEqual([]);
    expect(requests[0]?.requirements).toEqual([]);
  });

  it('applies a requirement declared on one grant to a sibling grant', async () => {
    // The union semantic: a receipt must echo every eligible grant, so every
    // eligible grant's contingencies apply to the request.
    const { authority } = harness({
      grants: [
        grant({ id: 'grant-1' }),
        grant({ id: 'grant-2', requirements: [requirement()] }),
      ],
    });
    expect(
      await denialCode(axAuthorize(authority, 'document.read', resource))
    ).toBe('guard_predicate_failed');
  });

  it('axValidateCapabilityGrant throws on a malformed requirement', () => {
    // F4/F5 are enforced at capture, not re-derived on every authorize call.
    expect(() =>
      axValidateCapabilityGrant(
        grant({
          requirements: [
            { kind: 'k', trustedSources: ['s'], match: { op: 'sameAs' } },
          ] as unknown as readonly AxEvidenceRequirement[],
        })
      )
    ).toThrow(/AxCapabilityGrant.requirements\[0\] is malformed/);
    expect(() =>
      axValidateCapabilityGrant(
        grant({
          requirements: [
            { kind: 'k', trustedSources: ['s'], match: { op: 'fresh' } },
          ],
        })
      )
    ).toThrow(/malformed/);
    expect(() =>
      axValidateCapabilityGrant(
        grant({
          requirements: 'nope' as unknown as readonly AxEvidenceRequirement[],
        })
      )
    ).toThrow(/must be an array/);
    expect(() =>
      axValidateCapabilityGrant(
        grant({
          requirements: Array.from({ length: 33 }, (_entry, index) =>
            requirement({ kind: `kind-${index}` })
          ),
        })
      )
    ).toThrow(/exceeds 32 entries/);
  });

  it('observeEvidence is called once per authorize and its result wins over evidence', async () => {
    // The freshness path: a frozen snapshot array can only age within a run,
    // so maxAgeMs is only usable with a supplier that re-observes.
    let clock = NOW;
    let calls = 0;
    const { authority, requests } = harness({
      grants: [
        grant({
          // No expiry: the clock advances an hour and a half across the loop.
          expiresAt: undefined,
          requirements: [
            requirement({ match: { op: 'fresh' }, maxAgeMs: 60_000 }),
          ],
        }),
      ],
      // A stale frozen array that would fail every call after the first minute.
      evidence: [observation({ observedAt: NOW - 10_000_000 })],
      now: () => clock,
      observeEvidence: () => {
        calls++;
        return [observation({ observedAt: clock - 1_000 })];
      },
    });
    for (let call = 0; call < 100; call++) {
      clock = NOW + call * 60_000;
      const receipt = await axAuthorize(authority, 'document.read', resource);
      expect(receipt?.decision).toBe('allow');
    }
    expect(calls).toBe(100);
    expect(requests[99]?.evidence?.[0]?.observedAt).toBe(clock - 1_000);
  });

  it('a throwing observeEvidence denies fail-closed with missing_observation', async () => {
    const { audits, authority } = harness({
      grants: [grant({ requirements: [requirement()] })],
      evidence: [observation()],
      observeEvidence: () => {
        throw new Error('host evidence store offline');
      },
    });
    expect(
      await denialCode(axAuthorize(authority, 'document.read', resource))
    ).toBe('guard_predicate_failed');
    expect(audits[0]?.failedPredicateKind).toBe('eq:session.mfa');
  });

  it('a malformed observeEvidence result denies rather than being partially trusted', async () => {
    const { authority } = harness({
      grants: [grant({ requirements: [requirement()] })],
      observeEvidence: () =>
        [
          { kind: 'session.mfa', value: 'strong' },
        ] as unknown as readonly AxEvidenceObservation[],
    });
    expect(
      await denialCode(axAuthorize(authority, 'document.read', resource))
    ).toBe('guard_predicate_failed');
  });

  it('an already-aborted signal still reports cancelled, not guard_predicate_failed', async () => {
    // Cancellation precedence is unchanged by the guard block.
    const controller = new AbortController();
    controller.abort();
    const { authority } = harness({
      grants: [grant({ requirements: [requirement()] })],
    });
    expect(
      await denialCode(
        axAuthorize(authority, 'document.read', resource, controller.signal)
      )
    ).toBe('cancelled');
  });

  it('a guard denial precedes no_matching_grant only when a grant matched', async () => {
    // With no matching grant there is nothing to collect requirements from,
    // so the existing code and message are unchanged.
    const { audits, authority } = harness({
      grants: [grant({ requirements: [requirement()], operations: ['other'] })],
    });
    expect(
      await denialCode(axAuthorize(authority, 'document.read', resource))
    ).toBe('no_matching_grant');
    expect(audits[0]?.code).toBe('no_matching_grant');
  });

  it('removes all abort listeners after a guard denial', async () => {
    // A denial short-circuits before the host authorizer, but it still awaits
    // the audit callback, which races the caller's signal.
    const controller = new AbortController();
    const { signal } = controller;
    const { authority } = harness({
      grants: [grant({ requirements: [requirement()] })],
    });
    for (let call = 0; call < 25; call++) {
      expect(
        await denialCode(
          axAuthorize(authority, 'document.read', resource, signal)
        )
      ).toBe('guard_predicate_failed');
    }
    expect(getEventListeners(signal, 'abort').length).toBe(0);

    controller.abort();
    expect(
      await denialCode(
        axAuthorize(authority, 'document.read', resource, signal)
      )
    ).toBe('cancelled');
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });
});
