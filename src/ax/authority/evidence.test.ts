import { describe, expect, it } from 'vitest';
import {
  axCollectGrantRequirements,
  axEvaluateGuards,
  axIsEvidenceRequirement,
  axIsGuardPredicateFailure,
} from './evidence.js';
import type {
  AxCapabilityGrant,
  AxEvidenceMatch,
  AxEvidenceObservation,
  AxEvidenceRequirement,
  AxGuardEvaluationContext,
  AxResourceScope,
} from './types.js';

const NOW = 10_000;
const LEASE = 3;
const resource: AxResourceScope = {
  type: 'document',
  id: 'doc-1',
  tenantId: 'tenant-a',
};

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

function evaluate(
  requirements: readonly AxEvidenceRequirement[],
  evidence: readonly AxEvidenceObservation[],
  override: Partial<AxGuardEvaluationContext> = {}
) {
  return axEvaluateGuards({
    operation: 'document.read',
    resource,
    requirements,
    evidence,
    leaseEpoch: LEASE,
    now: NOW,
    ...override,
  });
}

/** Full enumeration, so a determinism test cannot quietly cover a subset. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

function grant(override: Partial<AxCapabilityGrant> = {}): AxCapabilityGrant {
  return {
    version: 1,
    id: 'grant-1',
    principalId: 'principal-a',
    operations: ['document.read'],
    resources: [resource],
    leaseEpoch: LEASE,
    ...override,
  };
}

describe('Ax evidence guard evaluation', () => {
  it('allows when no requirement is declared', () => {
    // The additive-by-default claim: a host that declares nothing sees no
    // failures and no behaviour change.
    const result = evaluate([], []);
    expect(result.allow).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('denies when the required observation kind is absent', () => {
    const result = evaluate([requirement()], []);
    expect(result.allow).toBe(false);
    expect(result.failures).toEqual([
      { kind: 'session.mfa', op: 'eq', code: 'missing_observation' },
    ]);
  });

  it('denies an observation from a source outside trustedSources', () => {
    // Exact-source matching mirrors the no-wildcard scope rule: an untrusted
    // producer of the right fact kind is not implicitly trusted.
    const result = evaluate(
      [requirement()],
      [observation({ sourceId: 'idp-b' })]
    );
    expect(result.failures[0]?.code).toBe('untrusted_source');
  });

  it('denies an observation carrying a prior lease epoch for every operator', () => {
    // Lease binding is unconditional (F2), not something an operator can relax.
    const matches: Readonly<AxEvidenceMatch>[] = [
      { op: 'eq', value: 'strong' },
      { op: 'ne', value: 'weak' },
      { op: 'in', values: ['strong'] },
      { op: 'notIn', values: ['weak'] },
      { op: 'contains', value: 'strong' },
      { op: 'fresh' },
    ];
    for (const match of matches) {
      const result = evaluate(
        [requirement({ match, maxAgeMs: 60_000 })],
        [observation({ leaseEpoch: LEASE - 1 })]
      );
      expect(result.allow).toBe(false);
      expect(result.failures[0]).toEqual({
        kind: 'session.mfa',
        op: match.op,
        code: 'lease_epoch_mismatch',
      });
    }
  });

  it('denies when two trusted observations of one kind are present', () => {
    // Ax never disambiguates (F3): it does not pick the freshest or the first.
    const result = evaluate(
      [requirement({ trustedSources: ['idp-a', 'idp-b'] })],
      [observation(), observation({ sourceId: 'idp-b', value: 'weak' })]
    );
    expect(result.failures[0]?.code).toBe('ambiguous_observation');
  });

  it('denies a stale observation and passes a fresh one at the boundary', () => {
    // maxAgeMs is inclusive: age === maxAgeMs still satisfies.
    const boundary = evaluate(
      [requirement({ match: { op: 'fresh' }, maxAgeMs: 1_000 })],
      [observation({ observedAt: NOW - 1_000 })]
    );
    expect(boundary.allow).toBe(true);
    const stale = evaluate(
      [requirement({ match: { op: 'fresh' }, maxAgeMs: 1_000 })],
      [observation({ observedAt: NOW - 1_001 })]
    );
    expect(stale.failures[0]).toEqual({
      kind: 'session.mfa',
      op: 'fresh',
      code: 'stale',
    });
  });

  it('denies every maxAgeMs requirement when the injected clock is not finite', () => {
    // `NaN > n` is false, so a negated staleness test would let a broken clock
    // disable the only time-bounded operator. Every non-finite clock — and an
    // absent one, since axEvaluateGuards is public API — must deny instead.
    const fresh = requirement({
      kind: 'session.mfa',
      maxAgeMs: 1,
      match: { op: 'fresh' },
    });
    const aged = requirement({ maxAgeMs: 1 });
    const timeless = requirement({ kind: 'device.posture' });
    const evidence = [
      observation(),
      observation({ kind: 'device.posture', value: 'strong' }),
    ];
    for (const now of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined as unknown as number,
      '10000' as unknown as number,
    ]) {
      const result = evaluate([fresh, aged, timeless], evidence, { now });
      expect(result.allow).toBe(false);
      expect(result.failures.map((entry) => entry.code)).toEqual([
        'stale',
        'stale',
      ]);
    }
    // The same inputs on a finite clock allow, so the denial is the clock's.
    expect(
      evaluate([fresh, aged, timeless], evidence, { now: NOW - 1_000 }).allow
    ).toBe(true);
  });

  it('evaluates eq/ne/in/notIn/contains/fresh positively and negatively', () => {
    const cases: readonly {
      match: Readonly<AxEvidenceMatch>;
      value: AxEvidenceObservation['value'];
      allow: boolean;
    }[] = [
      { match: { op: 'eq', value: 'strong' }, value: 'strong', allow: true },
      { match: { op: 'eq', value: 'strong' }, value: 'weak', allow: false },
      { match: { op: 'ne', value: 'weak' }, value: 'strong', allow: true },
      { match: { op: 'ne', value: 'weak' }, value: 'weak', allow: false },
      { match: { op: 'in', values: ['a', 'b'] }, value: 'b', allow: true },
      { match: { op: 'in', values: ['a', 'b'] }, value: 'c', allow: false },
      { match: { op: 'notIn', values: ['a'] }, value: 'b', allow: true },
      { match: { op: 'notIn', values: ['a'] }, value: 'a', allow: false },
      {
        match: { op: 'contains', value: 'strong' },
        value: 'hardware-strong',
        allow: true,
      },
      {
        match: { op: 'contains', value: 'weak' },
        value: 'hardware-strong',
        allow: false,
      },
      { match: { op: 'contains', value: 'b' }, value: ['a', 'b'], allow: true },
      {
        match: { op: 'contains', value: 'c' },
        value: ['a', 'b'],
        allow: false,
      },
      { match: { op: 'fresh' }, value: 'strong', allow: true },
    ];
    for (const testCase of cases) {
      const result = evaluate(
        [requirement({ match: testCase.match, maxAgeMs: 60_000 })],
        [observation({ value: testCase.value })]
      );
      expect({ match: testCase.match, allow: result.allow }).toEqual({
        match: testCase.match,
        allow: testCase.allow,
      });
      if (!testCase.allow) {
        expect(result.failures[0]?.code).toBe('predicate_failed');
      }
    }
  });

  it('accepts a null-prototype record as an authority value', () => {
    // captureValue accepts Object.create(null) records, so the evaluator must
    // not reject the same host datum as malformed.
    const value = Object.assign(Object.create(null), { level: 'strong' });
    const result = evaluate(
      [requirement({ match: { op: 'eq', value: { level: 'strong' } } })],
      [observation({ value })]
    );
    expect(result.allow).toBe(true);
    expect(
      axIsEvidenceRequirement({
        kind: 'session.mfa',
        trustedSources: ['idp-a'],
        match: Object.assign(Object.create(null), {
          op: 'eq',
          value: Object.assign(Object.create(null), { level: 'strong' }),
        }),
      })
    ).toBe(true);
  });

  it('compares object and array values canonically, not by reference', () => {
    // Canonicalization sorts object keys, so key order is not a difference.
    const allowed = evaluate(
      [requirement({ match: { op: 'eq', value: { b: 2, a: 1 } } })],
      [observation({ value: { a: 1, b: 2 } })]
    );
    expect(allowed.allow).toBe(true);
    const denied = evaluate(
      [requirement({ match: { op: 'eq', value: { a: 1, b: 3 } } })],
      [observation({ value: { a: 1, b: 2 } })]
    );
    expect(denied.allow).toBe(false);
  });

  it('contains fails when the observation value is neither a string nor an array', () => {
    // No coercion: a number does not "contain" its own digits.
    const result = evaluate(
      [requirement({ match: { op: 'contains', value: '1' } })],
      [observation({ value: 12 })]
    );
    expect(result.failures[0]).toEqual({
      kind: 'session.mfa',
      op: 'contains',
      code: 'predicate_failed',
    });
  });

  it('denies an unknown operator supplied as runtime data', () => {
    // F4 at the evaluator. The capture path throws earlier; this is the
    // defense for a host that calls axEvaluateGuards directly.
    const result = evaluate(
      [
        {
          kind: 'session.mfa',
          trustedSources: ['idp-a'],
          match: { op: 'sameAs' as unknown as 'eq', value: 'x' },
        },
      ],
      [observation()]
    );
    expect(result.failures[0]).toEqual({
      kind: 'session.mfa',
      op: 'unknown',
      code: 'malformed_requirement',
    });
    // The declared operator is arbitrary host text and is normalized, never
    // echoed: `op` is public API a consumer may switch on exhaustively, and
    // the audit event's failedPredicateKind is derived from it.
    const echoed = evaluate(
      [
        {
          kind: 'session.mfa',
          trustedSources: ['idp-a'],
          match: {
            op: 'SECRET-OPERATOR' as unknown as 'eq',
            value: 'x',
          },
        },
      ],
      [observation()]
    );
    expect(echoed.failures[0]?.op).toBe('unknown');
    expect(JSON.stringify(echoed.failures)).not.toContain('SECRET-OPERATOR');
  });

  it('denies a fresh requirement with no maxAgeMs', () => {
    const result = evaluate(
      [
        {
          kind: 'session.mfa',
          trustedSources: ['idp-a'],
          match: { op: 'fresh' },
        },
      ],
      [observation()]
    );
    expect(result.failures[0]?.code).toBe('malformed_requirement');
  });

  it('denies a requirement with an empty trustedSources list', () => {
    const result = evaluate(
      [requirement({ trustedSources: [] })],
      [observation()]
    );
    expect(result.failures[0]?.code).toBe('malformed_requirement');
  });

  it('ignores a structurally malformed observation rather than trusting it', () => {
    // A host datum that is not an observation is not evidence, so the
    // requirement fails closed instead of matching on a partial record.
    const result = evaluate(
      [requirement()],
      [
        {
          kind: 'session.mfa',
          sourceId: 'idp-a',
          value: 'strong',
        } as unknown as AxEvidenceObservation,
      ]
    );
    expect(result.failures[0]?.code).toBe('missing_observation');
  });

  it('failures never contain observation values or source ids', () => {
    // This is the redaction contract for the deny path.
    const result = evaluate(
      [
        requirement({ match: { op: 'eq', value: 'SECRET-EXPECTED' } }),
        requirement({
          kind: 'device.posture',
          trustedSources: ['mdm-SECRET-SOURCE'],
        }),
      ],
      [observation({ value: 'SECRET-OBSERVED' })]
    );
    const serialized = JSON.stringify(result.failures);
    expect(result.allow).toBe(false);
    expect(serialized).not.toContain('SECRET-OBSERVED');
    expect(serialized).not.toContain('SECRET-EXPECTED');
    expect(serialized).not.toContain('SECRET-SOURCE');
    expect(serialized).not.toContain('idp-a');
  });

  it('is deterministic across every input permutation', () => {
    // Every permutation of both inputs, enumerated rather than shuffled: a
    // seeded shuffle over three elements silently covered only three of the
    // six orders and never permuted the requirements at all.
    const requirements = [
      requirement({ kind: 'a', match: { op: 'eq', value: 1 } }),
      requirement({ kind: 'b', match: { op: 'eq', value: 2 } }),
      requirement({ kind: 'c', match: { op: 'eq', value: 3 } }),
    ];
    const evidence = [
      observation({ kind: 'a', value: 9 }),
      observation({ kind: 'b', value: 2 }),
      observation({ kind: 'd', value: 4 }),
    ];
    const evidenceOrders = permutations(evidence);
    const requirementOrders = permutations(requirements);
    expect(evidenceOrders).toHaveLength(6);
    expect(requirementOrders).toHaveLength(6);
    const baseline = evaluate(requirements, evidence);
    expect(baseline.failures).toHaveLength(2);
    const byKind = new Map(
      baseline.failures.map((entry) => [entry.kind, entry])
    );
    for (const orderedRequirements of requirementOrders) {
      // Independently derived: failures follow requirement order exactly, and
      // each requirement's own failure never changes.
      const expected = orderedRequirements
        .map((entry) => byKind.get(entry.kind))
        .filter((entry) => entry !== undefined);
      for (const orderedEvidence of evidenceOrders) {
        const result = evaluate(orderedRequirements, orderedEvidence);
        expect(result.failures).toEqual(expected);
        expect(result.allow).toBe(false);
      }
    }
  });

  it('reports one failure per requirement in requirement order', () => {
    const result = evaluate(
      [
        requirement({ kind: 'z' }),
        requirement({ kind: 'a' }),
        requirement({ kind: 'm' }),
      ],
      []
    );
    expect(result.failures.map((entry) => entry.kind)).toEqual(['z', 'a', 'm']);
  });
});

describe('axCollectGrantRequirements', () => {
  it('dedupes by canonical key and preserves first-seen order', () => {
    const first = requirement({ kind: 'session.mfa' });
    const second = requirement({ kind: 'device.posture' });
    // Same requirement re-expressed with a different source order and key
    // order: canonically identical, so it must not appear twice.
    const duplicate = {
      match: { op: 'eq', value: 'strong' },
      trustedSources: ['idp-a'],
      kind: 'session.mfa',
    } as AxEvidenceRequirement;
    const collected = axCollectGrantRequirements([
      grant({ id: 'g1', requirements: [first, second] }),
      grant({ id: 'g2', requirements: [duplicate] }),
    ]);
    expect(collected.map((entry) => entry.kind)).toEqual([
      'session.mfa',
      'device.posture',
    ]);
  });

  it('unions across grants, so a requirement on one grant constrains a sibling', () => {
    // The union is deliberate and fail-closed: a receipt must echo every
    // eligible grant, so every eligible grant's contingencies apply.
    const collected = axCollectGrantRequirements([
      grant({ id: 'g1' }),
      grant({ id: 'g2', requirements: [requirement()] }),
    ]);
    expect(collected).toHaveLength(1);
    const result = evaluate([...collected], []);
    expect(result.allow).toBe(false);
    expect(result.failures[0]?.code).toBe('missing_observation');
  });

  it('returns nothing when no grant declares a requirement', () => {
    expect(
      axCollectGrantRequirements([grant({ id: 'g1' }), grant({ id: 'g2' })])
    ).toEqual([]);
  });

  it('treats in/notIn members as a set, not a sequence', () => {
    // Reordering a set literal is not a different requirement, so it must not
    // dedupe as two, and must not read as dropping the parent's requirement
    // under attenuation.
    const collected = axCollectGrantRequirements([
      grant({
        id: 'g1',
        requirements: [
          requirement({ match: { op: 'in', values: ['strong', 'hardware'] } }),
          requirement({ match: { op: 'in', values: ['hardware', 'strong'] } }),
        ],
      }),
      grant({
        id: 'g2',
        requirements: [
          // A different member set is still a different requirement.
          requirement({ match: { op: 'in', values: ['strong'] } }),
          // A different operator over the same members is too.
          requirement({
            match: { op: 'notIn', values: ['hardware', 'strong'] },
          }),
        ],
      }),
    ]);
    expect(collected).toHaveLength(3);
  });

  it('treats trustedSources as a set but maxAgeMs as significant', () => {
    const collected = axCollectGrantRequirements([
      grant({
        id: 'g1',
        requirements: [
          requirement({ trustedSources: ['idp-a', 'idp-b'] }),
          requirement({ trustedSources: ['idp-b', 'idp-a'] }),
          requirement({ trustedSources: ['idp-a', 'idp-b'], maxAgeMs: 5 }),
        ],
      }),
    ]);
    expect(collected).toHaveLength(2);
  });
});

describe('axIsEvidenceRequirement', () => {
  it('accepts every well-formed operator shape', () => {
    const matches: Readonly<AxEvidenceMatch>[] = [
      { op: 'eq', value: null },
      { op: 'ne', value: { a: [1, true] } },
      { op: 'in', values: [1, 'two'] },
      { op: 'notIn', values: [] },
      { op: 'contains', value: 'x' },
    ];
    for (const match of matches) {
      expect(axIsEvidenceRequirement(requirement({ match }))).toBe(true);
    }
    expect(
      axIsEvidenceRequirement(
        requirement({ match: { op: 'fresh' }, maxAgeMs: 1 })
      )
    ).toBe(true);
  });

  it('rejects malformed requirements', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      'requirement',
      [],
      requirement({ kind: '' }),
      requirement({ trustedSources: [] }),
      requirement({ trustedSources: [''] }),
      requirement({ maxAgeMs: -1 }),
      requirement({ maxAgeMs: Number.NaN }),
      { kind: 'k', trustedSources: ['s'], match: { op: 'fresh' } },
      { kind: 'k', trustedSources: ['s'], match: { op: 'sameAs', kind: 'k2' } },
      { kind: 'k', trustedSources: ['s'], match: { op: 'in', value: 1 } },
      { kind: 'k', trustedSources: ['s'], match: { op: 'contains', value: 1 } },
      { kind: 'k', trustedSources: ['s'] },
    ];
    for (const value of rejected) {
      expect(axIsEvidenceRequirement(value)).toBe(false);
    }
  });
});

describe('axIsGuardPredicateFailure', () => {
  it('recognises a guard denial structurally and rejects anything else', () => {
    const denial = Object.assign(new Error('denied'), {
      name: 'AxAuthorizationDeniedError',
      code: 'guard_predicate_failed',
    });
    expect(axIsGuardPredicateFailure(denial)).toBe(true);
    expect(
      axIsGuardPredicateFailure(
        Object.assign(new Error('denied'), {
          name: 'AxAuthorizationDeniedError',
          code: 'host_denied',
        })
      )
    ).toBe(false);
    expect(axIsGuardPredicateFailure(new Error('denied'))).toBe(false);
    expect(axIsGuardPredicateFailure(undefined)).toBe(false);
  });
});
