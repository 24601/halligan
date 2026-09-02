import { describe, expect, it } from 'vitest';
import { axExtractSkillProvenance } from '../authority/skillProvenance.js';
import { estimateTokenCount } from '../dsp/optimizers/acePlaybook.js';
import type { AxAgentCatalogSkill } from './agentInternal/skillsTypes.js';
import {
  AX_DEFAULT_KERNEL_TOKEN_BUDGET,
  axActorSkillView,
  axCheckSkillRequirements,
  axDemoteSkill,
  axEligibleCatalogSkills,
  axEstimateSkillTokens,
  axPromoteSkill,
  axSelectCatalogSkills,
} from './skillCatalog.js';
import type { AxAgentSkillCostProfile } from './skillCost.js';

const NOW = '2026-01-01T00:00:00.000Z';
const GRANT = 'grant:files.read';

function skill(
  override: Partial<AxAgentCatalogSkill> & { id: string }
): AxAgentCatalogSkill {
  return {
    name: `Skill ${override.id}`,
    content: `body of ${override.id}`,
    ...override,
  };
}

function profile(
  override: Partial<AxAgentSkillCostProfile> & { id: string }
): AxAgentSkillCostProfile {
  return {
    loads: 0,
    uses: 0,
    successes: 0,
    tokensTotal: 0,
    wallMsTotal: 0,
    verificationRoundsTotal: 0,
    updatedAt: NOW,
    ...override,
  };
}

function provenance(grantIds: readonly string[]) {
  return axExtractSkillProvenance({
    receipts: [
      {
        version: 1,
        receiptId: 'r-1',
        requestId: 'q-1',
        decision: 'allow',
        operation: 'files.read',
        resource: { type: 'file', id: 'f-1' },
        principalId: 'p-1',
        actor: { id: 'a-1', kind: 'agent' },
        grantIds: [...grantIds],
        leaseEpoch: 2,
        authorizedAt: 1,
      },
    ],
    leaseEpoch: 2,
    capturedAt: NOW,
  });
}

describe('axCheckSkillRequirements', () => {
  it('treats an absent or empty requires object as eligible', () => {
    expect(axCheckSkillRequirements(undefined, {}).eligible).toBe(true);
    expect(axCheckSkillRequirements({}, undefined).eligible).toBe(true);
  });

  it('names the missing bin rather than only refusing', () => {
    const result = axCheckSkillRequirements(
      { bins: ['rg', 'jq'] },
      { bins: ['rg'] }
    );
    expect(result.eligible).toBe(false);
    expect(result.unmet).toEqual([{ field: 'bins', missing: ['jq'] }]);
  });

  it('satisfies anyBins with a single match and fails with none', () => {
    expect(
      axCheckSkillRequirements({ anyBins: ['rg', 'ag'] }, { bins: ['ag'] })
        .eligible
    ).toBe(true);
    const failed = axCheckSkillRequirements(
      { anyBins: ['rg', 'ag'] },
      { bins: ['grep'] }
    );
    expect(failed.eligible).toBe(false);
    expect(failed.unmet).toEqual([{ field: 'anyBins', missing: ['ag', 'rg'] }]);
  });

  it('matches os exactly and case-sensitively', () => {
    expect(
      axCheckSkillRequirements({ os: ['darwin'] }, { os: 'darwin' }).eligible
    ).toBe(true);
    expect(
      axCheckSkillRequirements({ os: ['darwin'] }, { os: 'Darwin' }).eligible
    ).toBe(false);
    expect(axCheckSkillRequirements({ os: ['darwin'] }, {}).eligible).toBe(
      false
    );
  });

  it('reports every unmet field, not just the first', () => {
    const result = axCheckSkillRequirements(
      { env: ['TOKEN'], capabilities: ['net'] },
      {}
    );
    expect(result.unmet.map((entry) => entry.field)).toEqual([
      'env',
      'capabilities',
    ]);
  });
});

describe('axSelectCatalogSkills', () => {
  it('selects exactly like today for a catalog with no tier or requires', () => {
    const catalog = [skill({ id: 'b' }), skill({ id: 'a' })];
    const selection = axSelectCatalogSkills(catalog);
    expect(selection.kernel).toEqual([]);
    expect(selection.index.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(selection.hidden).toEqual([]);
    expect(selection.overflow).toEqual([]);
    expect(selection.decisions).toEqual([]);
  });

  it('hides an ineligible skill from kernel, index, and overflow alike', () => {
    const catalog = [
      skill({ id: 'gated', tier: 'kernel', requires: { bins: ['jq'] } }),
      skill({ id: 'open' }),
    ];
    const selection = axSelectCatalogSkills(catalog, {
      environment: { bins: [] },
    });
    expect(selection.kernel).toEqual([]);
    expect(selection.index.map((entry) => entry.id)).toEqual(['open']);
    expect(selection.overflow).toEqual([]);
    expect(selection.hidden).toEqual([
      { id: 'gated', unmet: [{ field: 'bins', missing: ['jq'] }] },
    ]);
  });

  it('loads kernel skills in value order until the budget is exhausted', () => {
    const catalog = [
      skill({ id: 'cheap', tier: 'kernel', tokenEstimate: 40 }),
      skill({ id: 'costly', tier: 'kernel', tokenEstimate: 40 }),
      skill({ id: 'third', tier: 'kernel', tokenEstimate: 40 }),
    ];
    const selection = axSelectCatalogSkills(catalog, {
      kernelTokenBudget: 80,
      costProfiles: [
        profile({ id: 'cheap', uses: 10, successes: 10, tokensTotal: 100 }),
        profile({ id: 'costly', uses: 10, successes: 1, tokensTotal: 100_000 }),
        profile({ id: 'third', uses: 10, successes: 5, tokensTotal: 1000 }),
      ],
    });
    expect(selection.kernelTokensUsed).toBe(80);
    // Kernel membership is by value; the rendered order is id-sorted for cache
    // stability.
    expect(selection.kernel.map((entry) => entry.id)).toEqual([
      'cheap',
      'third',
    ]);
    expect(selection.overflow).toEqual([{ id: 'costly', tokenEstimate: 40 }]);
    // A demoted kernel skill is still reachable through the index.
    expect(selection.index.map((entry) => entry.id)).toEqual(['costly']);
  });

  it('breaks kernel ties on id so the prompt is prefix-cache stable', () => {
    const catalog = [
      skill({ id: 'zeta', tier: 'kernel', tokenEstimate: 10 }),
      skill({ id: 'alpha', tier: 'kernel', tokenEstimate: 10 }),
    ];
    const first = axSelectCatalogSkills(catalog, { kernelTokenBudget: 10 });
    const second = axSelectCatalogSkills([...catalog].reverse(), {
      kernelTokenBudget: 10,
    });
    expect(first.kernel.map((entry) => entry.id)).toEqual(['alpha']);
    expect(second.kernel.map((entry) => entry.id)).toEqual(['alpha']);
  });

  it('annotates a downgraded skill and keeps it in the kernel', () => {
    const catalog = [
      skill({
        id: 'gated',
        tier: 'kernel',
        tokenEstimate: 10,
        authorityProvenance: provenance([GRANT]),
      }),
    ];
    const selection = axSelectCatalogSkills(catalog, {
      authority: { grantIds: [], leaseEpoch: 2 },
      now: NOW,
    });
    expect(selection.kernel[0]?.advisory).toContain('grant_revoked:1');
    expect(selection.decisions).toEqual([
      {
        id: 'gated',
        check: {
          outcome: 'downgrade',
          failures: [{ kind: 'grant_revoked', count: 1 }],
          advisory: expect.stringContaining('grant_revoked:1'),
        },
      },
    ]);
  });

  it('a parked skill is absent from kernel and index and present in decisions', () => {
    const catalog = [
      skill({
        id: 'gated',
        tier: 'kernel',
        authorityProvenance: provenance([GRANT]),
      }),
      skill({ id: 'open' }),
    ];
    const selection = axSelectCatalogSkills(catalog, {
      authority: { grantIds: [], leaseEpoch: 2 },
      precondition: { grant_revoked: 'park' },
      now: NOW,
    });
    expect(selection.kernel).toEqual([]);
    expect(selection.index.map((entry) => entry.id)).toEqual(['open']);
    expect(selection.decisions[0]?.check.outcome).toBe('park');
  });

  it('admits an unprovenanced skill under any authority snapshot', () => {
    const selection = axSelectCatalogSkills([skill({ id: 'legacy' })], {
      authority: { grantIds: [], leaseEpoch: 99 },
      now: NOW,
    });
    expect(selection.index.map((entry) => entry.id)).toEqual(['legacy']);
    expect(selection.decisions).toEqual([]);
  });
});

describe('actor view and token estimation', () => {
  it('axActorSkillView drops purpose and authorityProvenance at runtime', () => {
    const view = axActorSkillView({
      ...skill({ id: 's' }),
      authorityProvenance: provenance([GRANT]),
    });
    expect(Object.keys(view).sort()).toEqual(['content', 'id', 'name']);
  });

  it('axEstimateSkillTokens matches estimateTokenCount for the same string', () => {
    const target = skill({ id: 's', name: 'N', content: 'C'.repeat(37) });
    expect(axEstimateSkillTokens(target)).toBe(
      estimateTokenCount(`${target.name}\n\n${target.content}`)
    );
  });

  it('an explicit tokenEstimate overrides the character estimate', () => {
    expect(axEstimateSkillTokens(skill({ id: 's', tokenEstimate: 3 }))).toBe(3);
  });
});

describe('promote and demote', () => {
  const catalog = [
    skill({ id: 'a', tier: 'kernel', tokenEstimate: 60 }),
    skill({ id: 'b', tokenEstimate: 60 }),
  ];

  it('refuses a promotion that would exceed the budget without throwing', () => {
    const result = axPromoteSkill(catalog, 'b', { kernelTokenBudget: 100 });
    expect(result.accepted).toBe(false);
    expect(
      result.catalog.find((entry) => entry.id === 'b')?.tier
    ).toBeUndefined();
    expect(result.kernelTokenBudget).toBe(100);
  });

  it('accepts a promotion that fits', () => {
    const result = axPromoteSkill(catalog, 'b', { kernelTokenBudget: 200 });
    expect(result.accepted).toBe(true);
    expect(result.catalog.find((entry) => entry.id === 'b')?.tier).toBe(
      'kernel'
    );
    expect(result.kernelTokensUsed).toBe(120);
  });

  it('defaults to the documented kernel budget', () => {
    expect(axPromoteSkill(catalog, 'b').kernelTokenBudget).toBe(
      AX_DEFAULT_KERNEL_TOKEN_BUDGET
    );
  });

  it('axDemoteSkill is idempotent for an already-indexed skill', () => {
    const once = axDemoteSkill(catalog, 'b');
    const twice = axDemoteSkill(once, 'b');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(twice.find((entry) => entry.id === 'b')?.tier).toBe('indexed');
  });

  it('does not mutate the input catalog', () => {
    axPromoteSkill(catalog, 'b', { kernelTokenBudget: 200 });
    axDemoteSkill(catalog, 'a');
    expect(catalog[0]?.tier).toBe('kernel');
    expect(catalog[1]?.tier).toBeUndefined();
  });
});

describe('axEligibleCatalogSkills', () => {
  it('is the shared gate for the kernel, the index, and discovery', () => {
    const catalog = [
      skill({ id: 'gated', requires: { env: ['TOKEN'] } }),
      skill({ id: 'open' }),
    ];
    const eligible = axEligibleCatalogSkills(catalog, { env: [] });
    expect(eligible.map((entry) => entry.id)).toEqual(['open']);
    expect(
      axEligibleCatalogSkills(catalog, { env: ['TOKEN'] }).map(
        (entry) => entry.id
      )
    ).toEqual(['gated', 'open']);
  });
});
