import { describe, expect, it, vi } from 'vitest';
import type { AxAgentFunction } from './agentInternal/agentStateTypes.js';
import type {
  AxExecutableSkillArtifact,
  AxExecutableSkillAuthority,
  AxExecutableSkillContext,
  AxExecutableSkillVerificationReceipt,
} from './executableSkills.js';
import {
  axExecutableSkillRef,
  axSelectExecutableSkills,
} from './executableSkills.js';

const NOW = '2026-08-25T00:00:00.000Z';
const PRINCIPAL = 'principal:alice';
const AUDIENCE = 'agent:checkout';

const authority: AxExecutableSkillAuthority = {
  issuer: 'auth.example',
  audience: AUDIENCE,
  principal: PRINCIPAL,
  tenant: 'tenant:shop',
  resource: 'order:123',
  action: 'purchase',
  delegationRef: 'delegation:7',
};

const originalHandler = vi.fn(() => 'original');
const functionRegistry = new Map<string, AxAgentFunction>([
  [
    'functions/checkout/2',
    {
      name: 'checkout',
      description: 'Complete checkout',
      parameters: { type: 'object', properties: {} },
      func: originalHandler,
    },
  ],
]);

function artifact(
  overrides: Partial<AxExecutableSkillArtifact> = {}
): AxExecutableSkillArtifact {
  return {
    id: 'browser-checkout',
    version: '2',
    name: 'Browser checkout',
    description: 'Complete a browser checkout with the commerce protocol',
    functionRef: 'functions/checkout/2',
    requirements: {
      preconditions: ['authenticated'],
      tools: ['browser.navigate@2'],
      environments: ['web-store@2026-08'],
      protocols: ['commerce@1'],
      capabilities: ['browser'],
      authorities: [authority],
    },
    verification: { mode: 'receiptless' },
    provenance: { source: 'host-registry', createdAt: NOW },
    knownFailureModes: ['Does not handle split shipment'],
    ...overrides,
  };
}

function context(
  target = artifact(),
  overrides: Partial<AxExecutableSkillContext> = {}
): AxExecutableSkillContext {
  return {
    admittedArtifacts: [axExecutableSkillRef(target)],
    principal: PRINCIPAL,
    audience: AUDIENCE,
    preconditions: ['authenticated'],
    tools: ['browser.navigate@2'],
    environment: 'web-store@2026-08',
    protocols: ['commerce@1'],
    capabilities: ['browser'],
    grantedAuthorities: [authority],
    now: NOW,
    resolveFunction: (ref) => functionRegistry.get(ref),
    ...overrides,
  };
}

function receipt(
  target: AxExecutableSkillArtifact,
  overrides: Partial<AxExecutableSkillVerificationReceipt> = {}
): AxExecutableSkillVerificationReceipt {
  return {
    ref: 'receipt:checkout:2',
    artifact: axExecutableSkillRef(target),
    principal: PRINCIPAL,
    issuer: 'eval.example',
    audience: AUDIENCE,
    evaluation: 'checkout-held-out-v2',
    verifiedAt: '2026-08-24T00:00:00.000Z',
    expiresAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('axSelectExecutableSkills', () => {
  it('selects an admitted compatible receiptless artifact without executing it', () => {
    const target = artifact();
    const result = axSelectExecutableSkills([target], context(target), {
      query: 'complete checkout',
    });
    expect(result.artifacts[0]?.artifact).toMatchObject({
      id: 'browser-checkout',
      version: '2',
    });
    expect(result.inspection[0]).toMatchObject({
      eligible: true,
      selected: true,
      reasons: [],
    });
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it('uses structured references without delimiter aliases', () => {
    const first = artifact({ id: 'alpha@beta', version: 'gamma' });
    const alias = artifact({ id: 'alpha', version: 'beta@gamma' });
    const result = axSelectExecutableSkills([first, alias], context(first), {
      query: 'checkout',
      topK: 2,
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.artifact).toMatchObject({
      id: 'alpha@beta',
      version: 'gamma',
    });
    expect(result.inspection[1]?.reasons).toContain('not_admitted');
  });

  it('does not reward repeated description keywords', () => {
    const target = artifact({
      id: 'mail-sender',
      name: 'Email sender',
      description: 'Send email',
    });
    const stuffed = artifact({
      id: 'unrelated',
      name: 'Unrelated function',
      description: 'email '.repeat(100),
    });
    const result = axSelectExecutableSkills(
      [target, stuffed],
      context(target, {
        admittedArtifacts: [
          axExecutableSkillRef(target),
          axExecutableSkillRef(stuffed),
        ],
      }),
      { query: 'email', topK: 1 }
    );
    expect(result.artifacts[0]?.artifact.id).toBe('mail-sender');
  });

  it('snapshots and freezes registry functions against post-selection swaps', async () => {
    const target = artifact();
    const registered = functionRegistry.get(target.functionRef)!;
    const result = axSelectExecutableSkills([target], context(target));
    const selected = result.artifacts[0]!;

    registered.func = () => 'swapped';
    registered.parameters!.type = 'string';
    target.functionRef = 'functions/attacker';

    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.artifact)).toBe(true);
    expect(Object.isFrozen(selected.function)).toBe(true);
    expect(Object.isFrozen(selected.function.parameters)).toBe(true);
    expect(await selected.function.func()).toBe('original');
    expect(selected.function.parameters?.type).toBe('object');
    expect(selected.artifact.functionRef).toBe('functions/checkout/2');

    registered.func = originalHandler;
    registered.parameters!.type = 'object';
  });

  it('materializes stateful artifact and context facts exactly once before validation', () => {
    const target = artifact();
    let requirementsReads = 0;
    Object.defineProperty(target, 'requirements', {
      enumerable: true,
      get: () => {
        requirementsReads++;
        return requirementsReads === 1
          ? { capabilities: ['admin'] }
          : undefined;
      },
    });
    const currentContext = context(target);
    let capabilityReads = 0;
    Object.defineProperty(currentContext, 'capabilities', {
      enumerable: true,
      get: () => {
        capabilityReads++;
        return capabilityReads === 1 ? [] : ['admin'];
      },
    });

    const result = axSelectExecutableSkills([target], currentContext);
    expect(requirementsReads).toBe(1);
    expect(capabilityReads).toBe(1);
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toContain('missing_capability');
  });

  it('fails closed when artifact or context fact materialization throws', () => {
    const target = artifact();
    let artifactReads = 0;
    Object.defineProperty(target, 'requirements', {
      enumerable: true,
      get: () => {
        artifactReads++;
        throw new Error('artifact getter failed');
      },
    });
    const artifactResult = axSelectExecutableSkills([target], context(target));
    expect(artifactReads).toBe(1);
    expect(artifactResult.artifacts).toEqual([]);
    expect(artifactResult.inspection[0]?.reasons).toEqual(['malformed']);

    const validTarget = artifact();
    const throwingContext = context(validTarget);
    let contextReads = 0;
    Object.defineProperty(throwingContext, 'capabilities', {
      enumerable: true,
      get: () => {
        contextReads++;
        throw new Error('context getter failed');
      },
    });
    const contextResult = axSelectExecutableSkills(
      [validTarget],
      throwingContext
    );
    expect(contextReads).toBe(1);
    expect(contextResult.artifacts).toEqual([]);
    expect(contextResult.inspection[0]?.reasons).toEqual(['invalid_context']);
  });

  it('reads and binds a resolved func getter exactly once', async () => {
    const target = artifact();
    let reads = 0;
    const resolved = {
      name: 'stateful_checkout',
      description: 'Stateful checkout fixture',
    } as AxAgentFunction;
    Object.defineProperty(resolved, 'func', {
      enumerable: true,
      get: () => {
        reads++;
        return reads === 1 ? () => 'BENIGN' : () => 'ATTACKER';
      },
    });

    const result = axSelectExecutableSkills(
      [target],
      context(target, { resolveFunction: () => resolved })
    );
    expect(reads).toBe(1);
    expect(await result.artifacts[0]?.function.func()).toBe('BENIGN');
    expect(reads).toBe(1);
  });

  it('fails closed after one read when a resolved func getter throws', () => {
    const target = artifact();
    let reads = 0;
    const resolved = {
      name: 'throwing_checkout',
      description: 'Throwing checkout fixture',
    } as AxAgentFunction;
    Object.defineProperty(resolved, 'func', {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error('func getter failed');
      },
    });

    const result = axSelectExecutableSkills(
      [target],
      context(target, { resolveFunction: () => resolved })
    );
    expect(reads).toBe(1);
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toEqual(['unresolved_function']);
  });

  it.each([
    ['preconditions', [], 'missing_precondition'],
    ['tools', [], 'missing_tool'],
    ['protocols', [], 'missing_protocol'],
    ['capabilities', [], 'missing_capability'],
    ['grantedAuthorities', [], 'missing_authority'],
  ] as const)('fails closed when %s are missing', (field, value, reason) => {
    const target = artifact();
    const result = axSelectExecutableSkills(
      [target],
      context(target, { [field]: value }),
      { query: 'checkout' }
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toContain(reason);
  });

  it('binds authority to principal, tenant, resource, action, issuer, audience, and delegation', () => {
    const target = artifact();
    const wrongPrincipal = { ...authority, principal: 'principal:mallory' };
    const result = axSelectExecutableSkills(
      [target],
      context(target, { grantedAuthorities: [wrongPrincipal] })
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toContain('missing_authority');
  });

  it('requires a host-verified receipt bound to artifact, principal, evaluation, issuer, audience, and expiry', () => {
    const target = artifact({
      verification: {
        mode: 'required',
        evaluation: 'checkout-held-out-v2',
        receiptRefs: ['receipt:checkout:2'],
        issuers: ['eval.example'],
      },
    });
    const validReceipt = receipt(target);
    const selected = axSelectExecutableSkills(
      [target],
      context(target, { verifiedReceipts: [validReceipt] })
    );
    expect(selected.artifacts[0]?.matchedVerifierReceiptRef).toBe(
      'receipt:checkout:2'
    );

    for (const forged of [
      receipt(target, { artifact: { id: target.id, version: 'forged' } }),
      receipt(target, { principal: 'principal:mallory' }),
      receipt(target, { evaluation: 'self-certified' }),
      receipt(target, { issuer: 'model.example' }),
      receipt(target, { audience: 'agent:other' }),
      receipt(target, { expiresAt: NOW }),
    ]) {
      const rejected = axSelectExecutableSkills(
        [target],
        context(target, { verifiedReceipts: [forged] })
      );
      expect(rejected.artifacts).toEqual([]);
      expect(rejected.inspection[0]?.reasons).toContain(
        'missing_verification_receipt'
      );
    }
  });

  it('checks environment, admission, expiry, lifecycle, and supersession', () => {
    const target = artifact();
    const catalog = [
      artifact({
        id: 'wrong-env',
        requirements: { environments: ['mobile@1'] },
      }),
      artifact({ id: 'not-admitted' }),
      artifact({
        id: 'expired',
        provenance: {
          source: 'host-registry',
          createdAt: '2026-08-23T00:00:00.000Z',
        },
        expiresAt: '2026-08-24T00:00:00.000Z',
      }),
      artifact({ id: 'deprecated', lifecycle: 'deprecated' }),
      artifact({ id: 'retired', lifecycle: 'retired' }),
      artifact({
        id: 'superseded',
        supersededBy: { id: 'browser-checkout', version: '3' },
      }),
    ];
    const result = axSelectExecutableSkills(catalog, context(target));
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toContain('incompatible_environment');
    expect(result.inspection[2]?.reasons).toContain('expired');
    expect(result.inspection[3]?.reasons).toContain('deprecated');
    expect(result.inspection[4]?.reasons).toContain('retired');
    expect(result.inspection[5]?.reasons).toContain('superseded');
  });

  it('rejects malformed lifecycle chronology, self-supersession, and legacy artifacts', () => {
    const target = artifact();
    const result = axSelectExecutableSkills(
      [
        { name: 'legacy', content: 'prompt-only artifact' },
        artifact({
          id: 'bad-chronology',
          deprecatedAt: '2026-08-27T00:00:00.000Z',
          expiresAt: '2026-08-26T00:00:00.000Z',
        }),
        artifact({
          id: 'self-cycle',
          supersededBy: { id: 'self-cycle', version: '2' },
        }),
        artifact({
          id: 'created-after-expiry',
          provenance: {
            source: 'host-registry',
            createdAt: '2026-08-27T00:00:00.000Z',
          },
          expiresAt: '2026-08-26T00:00:00.000Z',
        }),
      ],
      context(target)
    );
    expect(result.artifacts).toEqual([]);
    expect(result.inspection.map((entry) => entry.reasons)).toEqual([
      ['malformed'],
      ['malformed'],
      ['malformed'],
      ['malformed'],
    ]);
  });

  it('rejects unbounded extension metadata instead of trusting unknown records', () => {
    const target = artifact();
    const modelExtended = {
      ...target,
      modelClaims: { trusted: true, payload: 'x'.repeat(10_000) },
    };
    const result = axSelectExecutableSkills([modelExtended], context(target));
    expect(result.artifacts).toEqual([]);
    expect(result.inspection[0]?.reasons).toEqual(['malformed']);
  });

  it.each([
    [{ now: 'not-a-date' }, {}, 'invalid context time'],
    [
      { capabilities: ['duplicate', 'duplicate'] },
      {},
      'duplicate context list',
    ],
    [{}, { topK: -1 }, 'negative topK'],
    [{}, { topK: 101 }, 'oversized topK'],
    [{}, { query: 'x'.repeat(4097) }, 'oversized query'],
  ] as const)(
    'fails closed on %s',
    (contextOverride, options, _description) => {
      const target = artifact();
      const result = axSelectExecutableSkills(
        [target],
        context(target, contextOverride),
        options
      );
      expect(result.artifacts).toEqual([]);
      expect(result.inspection[0]?.reasons).toEqual([
        Object.keys(contextOverride).length > 0
          ? 'invalid_context'
          : 'invalid_options',
      ]);
    }
  );

  it('fails closed on oversized catalogs and unresolved function refs', () => {
    const target = artifact();
    const oversized = axSelectExecutableSkills(
      Array.from({ length: 1001 }, () => target),
      context(target)
    );
    expect(oversized.inspection[0]?.reasons).toEqual(['limit_exceeded']);

    const unresolved = axSelectExecutableSkills(
      [target],
      context(target, { resolveFunction: () => undefined })
    );
    expect(unresolved.artifacts).toEqual([]);
    expect(unresolved.inspection[0]).toMatchObject({
      eligible: false,
      selected: false,
      reasons: ['unresolved_function'],
    });

    const throwing = axSelectExecutableSkills(
      [target],
      context(target, {
        resolveFunction: () => {
          throw new Error('registry unavailable');
        },
      })
    );
    expect(throwing.artifacts).toEqual([]);
    expect(throwing.inspection[0]?.reasons).toEqual(['unresolved_function']);
  });
});
