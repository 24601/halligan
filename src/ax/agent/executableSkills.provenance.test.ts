import { describe, expect, it, vi } from 'vitest';

import {
  type AxSkillAuthoritySnapshot,
  axExtractSkillProvenance,
} from '../authority/skillProvenance.js';
import type { AxAgentFunction } from './agentInternal/agentStateTypes.js';
import type {
  AxExecutableSkillArtifact,
  AxExecutableSkillContext,
} from './executableSkills.js';
import {
  axExecutableSkillRef,
  axSelectExecutableSkills,
} from './executableSkills.js';

const NOW = '2026-08-25T00:00:00.000Z';
const LATER = '2026-08-26T00:00:00.000Z';
const PRINCIPAL = 'principal:alice';
const AUDIENCE = 'agent:checkout';
const GRANT = 'grant:checkout:write';
const RECEIPT_SECRET = 'receipt-secret-42';
const RESOURCE_SECRET = 'order-secret-99';

const handler = vi.fn(() => 'ok');
const registry = new Map<string, AxAgentFunction>([
  [
    'functions/checkout/2',
    {
      name: 'checkout',
      description: 'Complete checkout',
      parameters: { type: 'object', properties: {} },
      func: handler,
    },
  ],
]);

function provenance(
  grantIds: readonly string[] = [GRANT],
  leaseEpoch = 3,
  environment: Record<string, string> = {}
) {
  return axExtractSkillProvenance({
    receipts: [
      {
        version: 1,
        receiptId: RECEIPT_SECRET,
        requestId: 'request-1',
        decision: 'allow',
        operation: 'checkout.submit',
        resource: { type: 'order', id: RESOURCE_SECRET },
        principalId: PRINCIPAL,
        actor: { id: AUDIENCE, kind: 'agent' },
        grantIds: [...grantIds],
        leaseEpoch,
        authorizedAt: 10,
      },
    ],
    environment,
    leaseEpoch,
    capturedAt: NOW,
  });
}

function artifact(
  overrides: Partial<AxExecutableSkillArtifact> = {}
): AxExecutableSkillArtifact {
  return {
    id: 'browser-checkout',
    version: '2',
    name: 'Browser checkout',
    description: 'Complete a browser checkout',
    functionRef: 'functions/checkout/2',
    verification: { mode: 'receiptless' },
    ...overrides,
  };
}

function context(
  target: AxExecutableSkillArtifact,
  overrides: Partial<AxExecutableSkillContext> = {}
): AxExecutableSkillContext {
  return {
    admittedArtifacts: [axExecutableSkillRef(target)],
    principal: PRINCIPAL,
    audience: AUDIENCE,
    now: NOW,
    resolveFunction: (ref) => registry.get(ref),
    ...overrides,
  };
}

const snapshot = (
  overrides: Partial<AxSkillAuthoritySnapshot> = {}
): AxSkillAuthoritySnapshot => ({
  grantIds: [GRANT],
  leaseEpoch: 3,
  ...overrides,
});

describe('executable skill authority provenance', () => {
  it('selection is unchanged when no artifact carries authorityProvenance', () => {
    const target = artifact();
    const withSnapshot = axSelectExecutableSkills(
      [target],
      context(target, { authoritySnapshot: snapshot() })
    );
    const without = axSelectExecutableSkills([target], context(target));
    expect(withSnapshot.artifacts).toHaveLength(1);
    expect(without.artifacts).toHaveLength(1);
    expect(withSnapshot.inspection[0]?.provenance).toBeUndefined();
  });

  it('admits an artifact whose recorded authority still holds', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const result = axSelectExecutableSkills(
      [target],
      context(target, { authoritySnapshot: snapshot() })
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.inspection[0]?.provenance?.outcome).toBe('admit');
  });

  it('parks an artifact whose recorded grant is no longer held', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const result = axSelectExecutableSkills(
      [target],
      context(target, { authoritySnapshot: snapshot({ grantIds: [] }) })
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.eligible).toBe(false);
    expect(result.inspection[0]?.reasons).toContain(
      'provenance_precondition_failed'
    );
    expect(result.inspection[0]?.provenance).toEqual({
      outcome: 'park',
      failures: [{ kind: 'grant_revoked', count: 1 }],
    });
  });

  it('never calls resolveFunction for a parked artifact', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const resolveFunction = vi.fn((ref: string) => registry.get(ref));
    axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: snapshot({ grantIds: [] }),
        resolveFunction,
      })
    );
    expect(resolveFunction).not.toHaveBeenCalled();
  });

  it('carries failure counts without any id or value', () => {
    const target = artifact({
      authorityProvenance: provenance([GRANT], 3, { sandbox: 'true' }),
    });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: snapshot({
          grantIds: [],
          environment: { sandbox: 'false' },
        }),
      })
    );
    const serialized = JSON.stringify(result.inspection[0]?.provenance);
    expect(serialized).not.toContain(GRANT);
    expect(serialized).not.toContain(RECEIPT_SECRET);
    expect(serialized).not.toContain(RESOURCE_SECRET);
    expect(serialized).not.toContain('sandbox');
    expect(result.inspection[0]?.provenance?.failures).toEqual([
      { kind: 'environment_drift', count: 1 },
      { kind: 'grant_revoked', count: 1 },
    ]);
  });

  it('coerces a downgrade policy entry to park for an executable artifact', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: snapshot({ grantIds: [] }),
        preconditionPolicy: { grant_revoked: 'downgrade' },
      })
    );
    // There is no advisory mode for something that executes.
    expect(result.inspection[0]?.provenance?.outcome).toBe('park');
    expect(result.inspection[0]?.provenance?.advisory).toBeUndefined();
    expect(result.artifacts).toEqual([]);
  });

  it('honours a drop policy entry', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: snapshot({ grantIds: [] }),
        preconditionPolicy: { grant_revoked: 'drop' },
      })
    );
    expect(result.inspection[0]?.provenance?.outcome).toBe('drop');
  });

  it('detaches and freezes the authority snapshot before the check', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const mutable: { grantIds: string[]; leaseEpoch: number } = {
      grantIds: [GRANT],
      leaseEpoch: 3,
    };
    const result = axSelectExecutableSkills(
      [target],
      context(target, { authoritySnapshot: mutable })
    );
    mutable.grantIds.length = 0;
    mutable.leaseEpoch = 99;
    expect(result.artifacts).toHaveLength(1);
    expect(result.inspection[0]?.provenance?.outcome).toBe('admit');
  });

  it('fails closed on an unknown key inside authoritySnapshot', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: {
          ...snapshot(),
          extra: 'nope',
        } as AxSkillAuthoritySnapshot,
      })
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection).toEqual([
      { eligible: false, selected: false, reasons: ['invalid_context'] },
    ]);
  });

  it('fails closed on an unknown key inside preconditionPolicy', () => {
    const target = artifact({ authorityProvenance: provenance() });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: snapshot(),
        preconditionPolicy: { not_a_kind: 'park' } as never,
      })
    );
    expect(result.inspection).toEqual([
      { eligible: false, selected: false, reasons: ['invalid_context'] },
    ]);
  });

  it('marks a malformed provenance object malformed, not eligible', () => {
    const target = artifact({
      authorityProvenance: { version: 1 } as never,
    });
    const result = axSelectExecutableSkills(
      [target],
      context(target, { authoritySnapshot: snapshot() })
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toEqual(['malformed']);
  });

  it('marks a tampered provenance digest malformed at re-check time', () => {
    // Structurally valid, so it survives artifact validation; the digest is
    // what catches an edit.
    const tampered = { ...provenance(), hostGrants: ['grant:injected'] };
    const target = artifact({ authorityProvenance: tampered });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: snapshot({ grantIds: ['grant:injected'] }),
      })
    );
    expect(result.inspection[0]?.provenance).toEqual({
      outcome: 'park',
      failures: [{ kind: 'malformed_provenance', count: 1 }],
    });
  });

  it('context.now wins over authoritySnapshot.now', () => {
    // `context.now` is the authoritative clock on this path: an artifact that
    // has expired by it is excluded no matter what the snapshot says.
    const target = artifact({
      authorityProvenance: provenance(),
      expiresAt: NOW,
    });
    const result = axSelectExecutableSkills(
      [target],
      context(target, {
        authoritySnapshot: { ...snapshot(), now: '2020-01-01T00:00:00.000Z' },
      })
    );
    expect(result.inspection[0]?.reasons).toContain('expired');

    const live = artifact({
      authorityProvenance: provenance(),
      expiresAt: LATER,
    });
    const alive = axSelectExecutableSkills(
      [live],
      context(live, {
        authoritySnapshot: { ...snapshot(), now: '2020-01-01T00:00:00.000Z' },
      })
    );
    expect(alive.artifacts).toHaveLength(1);
  });
});
