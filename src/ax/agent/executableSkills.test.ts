import { describe, expect, it, vi } from 'vitest';
import type { AxExecutableSkillArtifact } from './executableSkills.js';
import {
  axExecutableSkillRef,
  axSelectExecutableSkills,
} from './executableSkills.js';

const handler = vi.fn();

function artifact(
  overrides: Partial<AxExecutableSkillArtifact> = {}
): AxExecutableSkillArtifact {
  return {
    id: 'browser-checkout',
    version: '2',
    name: 'Browser checkout',
    description: 'Complete a browser checkout with the commerce protocol',
    function: {
      name: 'checkout',
      description: 'Complete checkout',
      func: handler,
    },
    requirements: {
      preconditions: ['authenticated'],
      tools: ['browser.navigate@2'],
      environments: ['web-store@2026-08'],
      protocols: ['commerce@1'],
      capabilities: ['browser'],
      authorities: ['purchase'],
    },
    verifierReceiptRefs: ['eval://checkout/2'],
    provenance: { source: 'host-registry' },
    knownFailureModes: ['Does not handle split shipment'],
    ...overrides,
  };
}

const compatibleContext = {
  admittedArtifacts: ['browser-checkout@2'],
  preconditions: ['authenticated'],
  tools: ['browser.navigate@2'],
  environment: 'web-store@2026-08',
  protocols: ['commerce@1'],
  capabilities: ['browser'],
  authorities: ['purchase'],
  acceptedVerifierReceiptRefs: ['eval://checkout/2'],
  now: '2026-08-25T00:00:00.000Z',
} as const;

describe('axSelectExecutableSkills', () => {
  it('selects an admitted compatible artifact without executing it', () => {
    const result = axSelectExecutableSkills([artifact()], compatibleContext, {
      query: 'complete checkout',
    });
    expect(result.artifacts.map(axExecutableSkillRef)).toEqual([
      'browser-checkout@2',
    ]);
    expect(result.inspection[0]).toMatchObject({
      eligible: true,
      selected: true,
      reasons: [],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['preconditions', [], 'missing_precondition'],
    ['tools', [], 'missing_tool'],
    ['protocols', [], 'missing_protocol'],
    ['capabilities', [], 'missing_capability'],
    ['authorities', [], 'missing_authority'],
    ['acceptedVerifierReceiptRefs', [], 'unaccepted_verifier_receipt'],
  ] as const)('fails closed when %s are missing', (field, value, reason) => {
    const result = axSelectExecutableSkills(
      [artifact()],
      { ...compatibleContext, [field]: value },
      { query: 'checkout' }
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toContain(reason);
  });

  it('checks environment, admission, expiry, lifecycle, and supersession', () => {
    const catalog = [
      artifact({
        id: 'wrong-env',
        requirements: { environments: ['mobile@1'] },
      }),
      artifact({ id: 'not-admitted' }),
      artifact({ id: 'expired', expiresAt: '2026-08-24T00:00:00Z' }),
      artifact({ id: 'deprecated', lifecycle: 'deprecated' }),
      artifact({ id: 'retired', lifecycle: 'retired' }),
      artifact({ id: 'superseded', supersededBy: 'browser-checkout@3' }),
    ];
    const result = axSelectExecutableSkills(catalog, compatibleContext);
    expect(result.artifacts).toEqual([]);
    expect(result.inspection.map((entry) => entry.reasons[0])).toEqual([
      'not_admitted',
      'not_admitted',
      'not_admitted',
      'not_admitted',
      'not_admitted',
      'not_admitted',
    ]);
    expect(result.inspection[0]?.reasons).toContain('incompatible_environment');
    expect(result.inspection[2]?.reasons).toContain('expired');
    expect(result.inspection[3]?.reasons).toContain('deprecated');
    expect(result.inspection[4]?.reasons).toContain('retired');
    expect(result.inspection[5]?.reasons).toContain('superseded');
  });

  it('keeps malformed legacy and duplicate artifacts inspectable', () => {
    const valid = artifact();
    const result = axSelectExecutableSkills(
      [
        { name: 'legacy', content: 'prompt-only artifact' },
        valid,
        { ...valid },
      ],
      compatibleContext
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]).toEqual({
      eligible: false,
      selected: false,
      reasons: ['malformed'],
    });
    expect(result.inspection[1]?.reasons).toContain('duplicate_ref');
    expect(result.inspection[2]?.reasons).toContain('duplicate_ref');
  });

  it('does not treat model-claimed provenance or receipts as host trust', () => {
    const forged = artifact({
      id: 'forged',
      provenance: {
        source: 'trusted-host',
        createdBy: 'model says administrator',
      },
      verifierReceiptRefs: ['model://claims/passed'],
    });
    const result = axSelectExecutableSkills([forged], compatibleContext);
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toEqual(
      expect.arrayContaining(['not_admitted', 'unaccepted_verifier_receipt'])
    );
  });

  it('keeps inactive artifacts available for audit but never selects them', () => {
    const inactive = artifact({ lifecycle: 'inactive' });
    const result = axSelectExecutableSkills([inactive], compatibleContext, {
      query: 'checkout',
    });
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]).toMatchObject({
      eligible: false,
      selected: false,
      reasons: ['inactive'],
    });
  });
});
