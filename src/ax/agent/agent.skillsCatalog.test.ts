import { describe, expect, it, vi } from 'vitest';
import { AxMockAIService } from '../ai/mock/api.js';
import { axExtractSkillProvenance } from '../authority/skillProvenance.js';
import {
  AX_HOST_SNIPPET_MARKER,
  AX_INPUTS_PATCH_GLOBAL,
} from './agentInternal/sharedSession.js';
import {
  createCatalogSkillsSearch,
  rankCatalogSkills,
  serializeSkillsPromptState,
} from './agentInternal/skillsHelpers.js';
import type { AxAgentCatalogSkill } from './agentInternal/skillsTypes.js';
import type { AxAgentContextEvent } from './contextEvents.js';
import { agent } from './index.js';
import type { AxCodeRuntime } from './rlm.js';
import { axBuildExecutorDefinition } from './rlm.js';
import type { AxAgentSkillCostProfile } from './skillCost.js';

// ----- Fixtures -----

const CATALOG: AxAgentCatalogSkill[] = [
  {
    id: 'release-checklist',
    name: 'Release checklist',
    description: 'Steps for shipping a new package release safely',
    content: '1. Bump version\n2. Run tests\n3. Tag and publish',
  },
  {
    id: 'incident-response',
    name: 'Incident response',
    description: 'How to acknowledge, triage, and escalate incidents',
    content: 'Acknowledge the page, assess blast radius, escalate to on-call.',
  },
  {
    id: 'style-guide',
    name: 'Writing style guide',
    description: 'Tone and formatting rules for customer-facing docs',
    content: 'Use plain language. Prefer short sentences.',
  },
];

const makeModelUsage = () => ({
  ai: 'mock-ai',
  model: 'mock-model',
  tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

/**
 * Runtime whose first turn calls discover({skills}) and second turn finishes.
 */
function makeSkillsDiscoverRuntime(searchQuery: string): AxCodeRuntime {
  const turn = 0;
  return {
    getUsageInstructions: () => '',
    createSession(globals) {
      return {
        execute: async (code: string) => {
          if (code.startsWith(AX_HOST_SNIPPET_MARKER)) return 'host-snippet';
          if (globals?.final && code.includes('final(')) {
            (globals.final as (...args: unknown[]) => void)('done', {
              data: 'done',
            });
            return 'done';
          }
          if (code.includes('discover(') && globals?.discover) {
            await (globals.discover as (v: unknown) => Promise<void>)({
              skills: [searchQuery],
            });
            return 'discover ok';
          }
          return 'ok';
        },
        // REPL-faithful: merge (phase-2 rebinding) + honor staged input merges.
        patchGlobals: async (patch: Record<string, unknown>) => {
          const { [AX_INPUTS_PATCH_GLOBAL]: staged, ...rest } = patch;
          Object.assign(globals ?? {}, rest);
          if (globals && staged && typeof staged === 'object') {
            globals.inputs = Object.assign(
              (globals.inputs as Record<string, unknown>) ?? {},
              staged
            );
          }
        },
        close: () => {},
      };
    },
  } as AxCodeRuntime & { turn?: typeof turn };
}

interface ExecutorCapture {
  systems: string[];
  users: string[];
}

/** Mock AI: executor turn 1 discovers, turn 2 finals; distiller forwards. */
function makeSkillsMockAI(capture: ExecutorCapture) {
  let executorTurn = 0;
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      const system = String(req.chatPrompt[0]?.content ?? '');
      const user = String(req.chatPrompt[1]?.content ?? '');
      if (system.includes('You (`executor`)')) {
        executorTurn++;
        capture.systems.push(system);
        capture.users.push(user);
        return {
          results: [
            {
              index: 0,
              content:
                executorTurn === 1
                  ? "Javascript Code: await discover({ skills: ['release'] })"
                  : 'Javascript Code: await final("done", { data: "done" })',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: makeModelUsage(),
        };
      }
      if (system.includes('You (`distiller`)')) {
        return {
          results: [
            {
              index: 0,
              content: 'Javascript Code: final("forward the request", {})',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: makeModelUsage(),
        };
      }
      return {
        results: [
          { index: 0, content: 'Answer: done', finishReason: 'stop' as const },
        ],
        modelUsage: makeModelUsage(),
      };
    },
  });
}

// ----- Unit: built-in catalog search -----

describe('createCatalogSkillsSearch', () => {
  it('matches by name/description and returns full results', () => {
    const search = createCatalogSkillsSearch(CATALOG);
    const results = search(['how do I ship a release']) as {
      id?: string;
      name: string;
      content: string;
    }[];
    expect(results[0]?.id).toBe('release-checklist');
    expect(results[0]?.content).toContain('Bump version');
  });

  it('is best-effort over a single-entry catalog (minDocs 1)', () => {
    const search = createCatalogSkillsSearch([CATALOG[0]!]);
    const results = search(['release']) as { id?: string }[];
    expect(results[0]?.id).toBe('release-checklist');
  });

  it('unions matches across multiple search strings without duplicates', () => {
    const search = createCatalogSkillsSearch(CATALOG);
    const results = search([
      'release checklist',
      'incident escalation',
      'release',
    ]) as { id?: string }[];
    const ids = results.map((r) => r.id);
    expect(ids).toContain('release-checklist');
    expect(ids).toContain('incident-response');
    expect(new Set(ids).size).toBe(ids.length); // no dupes
  });

  it('returns [] when nothing matches', () => {
    const search = createCatalogSkillsSearch(CATALOG);
    expect(search(['xyzzy quux'])).toEqual([]);
  });
});

describe('rankCatalogSkills (advisory hint — strict guards)', () => {
  it('ranks the on-topic skill first with name included', () => {
    const ranked = rankCatalogSkills(
      'prepare the next package release for shipping',
      CATALOG
    );
    expect(ranked[0]?.id).toBe('release-checklist');
    expect(ranked[0]?.name).toBe('Release checklist');
  });

  it('suppresses on no signal', () => {
    expect(rankCatalogSkills('xyzzy quux', CATALOG)).toEqual([]);
  });

  it('promotes a cheap skill from BELOW the similarity cut', () => {
    // Value-aware ranking scored an already-truncated list, so it could only
    // reorder inside the similarity top-K and never actually promote anything.
    const bodies = [
      'deploy production service '.repeat(8),
      'deploy production service '.repeat(3),
      'deploy production widget '.repeat(3),
      'deploy widget widget '.repeat(3),
      'service widget widget '.repeat(2),
      'production widget widget widget ',
    ];
    const catalog: AxAgentCatalogSkill[] = bodies.map((content, index) => ({
      id: `runbook-${index}`,
      name: `Runbook ${index}`,
      description: `Notes number ${index}`,
      content,
    }));
    const query = 'deploy the service to production';
    const profile = (
      id: string,
      successes: number,
      tokensTotal: number
    ): AxAgentSkillCostProfile => ({
      id,
      loads: 20,
      uses: 20,
      successes,
      tokensTotal,
      wallMsTotal: 0,
      verificationRoundsTotal: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const similarityOnly = rankCatalogSkills(query, catalog).map((r) => r.id);
    expect(similarityOnly).toEqual(['runbook-0', 'runbook-1', 'runbook-2']);

    const valueAware = rankCatalogSkills(query, catalog, {
      costProfiles: [
        // Cheap and always successful, but ranked 4th on similarity alone.
        profile('runbook-3', 20, 200),
        // Expensive and never successful, but the similarity leader.
        profile('runbook-0', 0, 400_000),
      ],
    }).map((r) => r.id);

    expect(valueAware).toContain('runbook-3');
    expect(valueAware[0]).toBe('runbook-3');
    // Still truncated to the caller's topK — the shortlist is widened for
    // scoring, not handed to the model.
    expect(valueAware).toHaveLength(similarityOnly.length);
    expect(valueAware).not.toContain('runbook-0');
  });
});

// ----- Prompt: static Available Skills catalog section -----

describe('skills catalog — executor prompt section', () => {
  it('renders the id-sorted catalog index when skillsMode is on', () => {
    const def = axBuildExecutorDefinition(undefined, [], [], {
      skillsMode: true,
      skillsCatalog: [
        { id: 'z-skill', name: 'Zed' },
        { id: 'a-skill', name: 'Aye', description: 'first' },
      ],
    });
    expect(def).toContain('### Available Skills');
    const aIdx = def.indexOf('`a-skill`');
    const zIdx = def.indexOf('`z-skill`');
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(aIdx); // sorted by id
    expect(def).toContain('— Aye — first');
  });

  it('omits the section without a catalog (golden-churn guard)', () => {
    const withCallbackOnly = axBuildExecutorDefinition(undefined, [], [], {
      skillsMode: true,
    });
    expect(withCallbackOnly).not.toContain('### Available Skills');
    const noSkills = axBuildExecutorDefinition(undefined, [], [], {});
    expect(noSkills).not.toContain('### Available Skills');
    expect(noSkills).not.toContain('### Loaded Skills');
  });
});

// ----- E2E: batteries-included discover({skills}) -----

describe('skills catalog — end to end', () => {
  it('discover({skills}) works with a catalog and NO host callback', async () => {
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const loaded: string[] = [];
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('release'),
      skillsCatalog: CATALOG,
      maxTurns: 4,
      onLoadedSkills: (results) => {
        loaded.push(...results.map((r) => r.id ?? r.name));
      },
    });

    await a.forward(mockAI, { query: 'help me ship the release' });

    // Built-in search matched and loaded the skill…
    expect(loaded).toContain('release-checklist');
    // …the catalog index is in the cached system prompt…
    expect(capture.systems[0]).toContain('### Available Skills');
    expect(capture.systems[0]).toContain('`release-checklist`');
    // …and the loaded guide reaches the next turn's prompt values.
    expect(capture.users[1] ?? '').toContain('Bump version');
  });

  it('host onSkillsSearch takes precedence over the catalog', async () => {
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const hostSearch = vi.fn(async () => [
      { id: 'host-skill', name: 'Host skill', content: 'HOST CONTENT' },
    ]);
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('release'),
      skillsCatalog: CATALOG,
      onSkillsSearch: hostSearch,
      maxTurns: 4,
    });

    await a.forward(mockAI, { query: 'help me ship the release' });

    expect(hostSearch).toHaveBeenCalled();
    // Host result loaded, not the catalog match.
    expect(capture.users[1] ?? '').toContain('HOST CONTENT');
    expect(capture.users[1] ?? '').not.toContain('Bump version');
  });

  it('emits a skills relevance_ranking event and rides the dynamic field', async () => {
    const events: AxAgentContextEvent[] = [];
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('release'),
      skillsCatalog: CATALOG,
      relevanceRanking: true,
      maxTurns: 4,
      onContextEvent: (event) => {
        events.push(event);
      },
    });

    await a.forward(mockAI, {
      query: 'prepare the next package release for shipping',
    });

    const skillEvent = events.find(
      (e) => e.kind === 'relevance_ranking' && e.domain === 'skills'
    );
    expect(skillEvent).toBeDefined();
    if (skillEvent?.kind !== 'relevance_ranking')
      throw new Error('unreachable');
    expect(skillEvent.suppressed).toBe(false);
    expect(skillEvent.shortlist[0]?.id).toBe('release-checklist');
    // Hint content is in the dynamic user turn, labeled by domain.
    expect(capture.users[0] ?? '').toContain('Skills:');
    expect(capture.users[0] ?? '').toContain('`release-checklist`');
    // And the hint instruction section is present even without discovery.
    expect(capture.systems[0]).toContain('### Likely Relevant');
  });

  it('keeps the cached executor system prompt byte-identical across tasks', async () => {
    const runForward = async (query: string) => {
      const capture: ExecutorCapture = { systems: [], users: [] };
      const mockAI = makeSkillsMockAI(capture);
      const a = agent('query:string -> answer:string', {
        ai: mockAI,
        runtime: makeSkillsDiscoverRuntime('release'),
        skillsCatalog: CATALOG,
        relevanceRanking: true,
        maxTurns: 4,
      });
      await a.forward(mockAI, { query });
      return capture.systems[0] ?? '';
    };

    const first = await runForward('prepare the next package release');
    const second = await runForward('how do we respond to the incident page');
    expect(first).not.toBe('');
    expect(first).toBe(second);
  });
});

// ----- Tiering, eligibility gating, and the retrieval-time re-check -----

const GATED_CATALOG: AxAgentCatalogSkill[] = [
  {
    id: 'kernel-skill',
    name: 'Kernel skill',
    description: 'Always loaded',
    content: 'Kernel guidance the actor always sees.',
    tier: 'kernel',
    tokenEstimate: 5,
  },
  {
    id: 'gated-skill',
    name: 'Gated skill',
    description: 'Needs a binary this host does not have',
    content: 'Gated guidance.',
    requires: { bins: ['jq'] },
  },
  ...CATALOG,
];

describe('skills catalog — tiers, eligibility, and cost', () => {
  it('seeds kernel skills into the prompt state so used(id) resolves', async () => {
    // Injecting the kernel past `currentSkillsPromptState` would make every
    // kernel skill permanently undeclarable, and therefore permanently stuck
    // at the ranking prior.
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const used: { id: string }[] = [];
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsUsedRuntime('kernel-skill'),
      skillsCatalog: GATED_CATALOG,
      skillPolicy: { environment: { bins: [] } },
      maxTurns: 4,
      onUsedSkills: (skills: readonly { id: string }[]) => {
        used.push(...skills);
      },
    } as never);

    await a.forward(mockAI, { query: 'help me ship the release' });

    expect(used.map((skill) => skill.id)).toContain('kernel-skill');
    expect(capture.users[0] ?? '').toContain(
      'Kernel guidance the actor always sees.'
    );
  });

  it('hides an ineligible skill from the index and from discover({skills})', async () => {
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const loaded: string[] = [];
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('gated'),
      skillsCatalog: GATED_CATALOG,
      skillPolicy: { environment: { bins: [] } },
      maxTurns: 4,
      onLoadedSkills: (results: readonly { id?: string; name: string }[]) => {
        loaded.push(...results.map((r) => r.id ?? r.name));
      },
    } as never);

    await a.forward(mockAI, { query: 'gated' });

    expect(capture.systems[0]).not.toContain('`gated-skill`');
    expect(capture.systems[0]).toContain('`kernel-skill`');
    expect(loaded).not.toContain('gated-skill');
  });

  it('emits a skill_eligibility event naming the missing token', async () => {
    const events: AxAgentContextEvent[] = [];
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('release'),
      skillsCatalog: GATED_CATALOG,
      skillPolicy: { environment: { bins: [] } },
      maxTurns: 4,
      onContextEvent: (event: AxAgentContextEvent) => {
        events.push(event);
      },
    } as never);

    await a.forward(mockAI, { query: 'help me ship the release' });

    const eligibility = events.find(
      (event) => event.kind === 'skill_eligibility'
    );
    if (eligibility?.kind !== 'skill_eligibility')
      throw new Error('unreachable');
    expect(eligibility.hidden).toEqual([{ id: 'gated-skill', unmet: ['jq'] }]);
    expect(eligibility.kernelTokensUsed).toBe(5);
  });

  it('re-derives a downgraded skill advisory rather than storing it', async () => {
    const provenance = axExtractSkillProvenance({
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
          grantIds: ['grant:held'],
          leaseEpoch: 1,
          authorizedAt: 1,
        },
      ],
      leaseEpoch: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const events: AxAgentContextEvent[] = [];
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsUsedRuntime('kernel-skill'),
      skillsCatalog: [
        { ...GATED_CATALOG[0]!, authorityProvenance: provenance },
        ...CATALOG,
      ],
      skillPolicy: {
        authoritySnapshot: { grantIds: [], leaseEpoch: 1 },
        now: () => 0,
      },
      maxTurns: 4,
      onContextEvent: (event: AxAgentContextEvent) => {
        events.push(event);
      },
    } as never);

    await a.forward(mockAI, { query: 'help me ship the release' });

    expect(capture.users[0] ?? '').toContain('[advisory]');
    expect(capture.users[0] ?? '').toContain('grant_revoked:1');
    // The advisory is derived, so it is nowhere in the serialized skills
    // state: the round-trip shape five generated packages restore is untouched.
    const serialized = serializeSkillsPromptState(
      (a as unknown as { executor: { currentSkillsPromptState: never } })
        .executor.currentSkillsPromptState
    );
    expect(JSON.stringify(serialized ?? {})).not.toContain('advisory');
    expect(JSON.stringify(serialized ?? {})).toContain('kernel-skill');
    const decision = events.find(
      (event) => event.kind === 'skill_precondition'
    );
    if (decision?.kind !== 'skill_precondition') throw new Error('unreachable');
    expect(decision.outcome).toBe('downgrade');
    expect(decision.failures).toEqual([{ kind: 'grant_revoked', count: 1 }]);
  });

  it('drops a revoked INDEXED skill from the index, discover, and the prompt', async () => {
    // The kernel tier is not the only retrieval path. `discover({ skills })` is
    // the primary one, and a `drop` policy that only reached the kernel would
    // let a revoked skill be listed, searched, and rendered verbatim.
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const loaded: string[] = [];
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('revoked'),
      skillsCatalog: [
        {
          id: 'revoked-skill',
          name: 'Revoked skill',
          description: 'Distilled from a trajectory whose grant is now revoked',
          content: 'REVOKED SKILL BODY',
          authorityProvenance: revokedProvenance(),
        },
        ...CATALOG,
      ],
      skillPolicy: {
        authoritySnapshot: { grantIds: [], leaseEpoch: 1 },
        precondition: { grant_revoked: 'drop' as const },
        now: () => 0,
      },
      maxTurns: 4,
      onLoadedSkills: (results: readonly { id?: string; name: string }[]) => {
        loaded.push(...results.map((r) => r.id ?? r.name));
      },
    } as never);

    await a.forward(mockAI, { query: 'revoked' });

    expect(capture.systems[0]).not.toContain('`revoked-skill`');
    expect(capture.systems[0]).toContain('`release-checklist`');
    expect(loaded).not.toContain('revoked-skill');
    for (const user of capture.users) {
      expect(user).not.toContain('REVOKED SKILL BODY');
    }
  });

  it('carries the advisory onto an INDEXED skill loaded through discover', async () => {
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const loaded: { id?: string; advisory?: string }[] = [];
    const a = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsDiscoverRuntime('stale'),
      skillsCatalog: [
        {
          id: 'stale-skill',
          name: 'Stale skill',
          description: 'Distilled from a trajectory whose grant is now revoked',
          content: 'STALE SKILL BODY',
          authorityProvenance: revokedProvenance(),
        },
        ...CATALOG,
      ],
      // The default guidance policy downgrades rather than drops.
      skillPolicy: {
        authoritySnapshot: { grantIds: [], leaseEpoch: 1 },
        now: () => 0,
      },
      maxTurns: 4,
      onLoadedSkills: (
        results: readonly { id?: string; advisory?: string }[]
      ) => {
        loaded.push(...results);
      },
    } as never);

    await a.forward(mockAI, { query: 'stale' });

    const rendered = capture.users.join('\n');
    expect(rendered).toContain('STALE SKILL BODY');
    expect(rendered).toContain('[advisory]');
    expect(rendered).toContain('grant_revoked:1');
    // The host callback sees it too, without it ever being serialized.
    expect(
      loaded.find((entry) => entry.id === 'stale-skill')?.advisory
    ).toContain('grant_revoked:1');
    const serialized = serializeSkillsPromptState(
      (a as unknown as { executor: { currentSkillsPromptState: never } })
        .executor.currentSkillsPromptState
    );
    expect(JSON.stringify(serialized ?? {})).not.toContain('advisory');
  });

  it('does not inherit skillPolicy, verifierRails, or onSkillCost into a child agent', () => {
    const child = agent('taskBrief:string -> taskOutcome:string', {
      ai: new AxMockAIService({ features: { functions: false } }),
      name: 'child',
      description: 'A child agent used as a tool by its parent',
    } as never);
    const parent = agent('query:string -> answer:string', {
      ai: new AxMockAIService({ features: { functions: false } }),
      agents: [child],
      skillsCatalog: CATALOG,
      skillPolicy: { environment: { bins: ['jq'] } },
      verifierRails: [
        { id: 'rail', stage: 'afterToolCall' as const, verify: () => [] },
      ],
      onSkillCost: () => {},
    } as never);
    // Read the RESOLVED executor state, not the constructor options: the
    // options object is never written to, so asserting on it passes whether
    // or not inheritance exists.
    const resolved = (a: unknown) =>
      (a as { executor: Record<string, unknown> }).executor;
    // Positive control — the parent really did resolve all three.
    expect(resolved(parent).skillPolicy).toBeDefined();
    expect(resolved(parent).verifierRails).toBeDefined();
    expect(resolved(parent).onSkillCost).toBeDefined();
    // And none of them reached the child.
    expect(resolved(child).skillPolicy).toBeUndefined();
    expect(resolved(child).verifierRails).toBeUndefined();
    expect(resolved(child).onSkillCost).toBeUndefined();
    expect(resolved(child).skillsCatalog).toBeUndefined();
  });

  it('round-trips kernel tier membership through getState/setState', async () => {
    // The kernel is seeded into `currentSkillsPromptState`, so a restore must
    // put it back in the Loaded Skills section without re-running selection.
    const capture: ExecutorCapture = { systems: [], users: [] };
    const mockAI = makeSkillsMockAI(capture);
    const first = agent('query:string -> answer:string', {
      ai: mockAI,
      runtime: makeSkillsUsedRuntime('kernel-skill'),
      skillsCatalog: GATED_CATALOG,
      skillPolicy: { environment: { bins: [] } },
      maxTurns: 4,
    } as never);
    await first.forward(mockAI, { query: 'help me ship the release' });
    const state = first.getState();
    expect(JSON.stringify(state)).toContain('kernel-skill');

    const restoredCapture: ExecutorCapture = { systems: [], users: [] };
    const restoredAI = makeSkillsMockAI(restoredCapture);
    const second = agent('query:string -> answer:string', {
      ai: restoredAI,
      runtime: makeSkillsUsedRuntime('kernel-skill'),
      // Deliberately NO catalog: the kernel membership has to come back from
      // the state, not from a fresh selection.
      maxTurns: 4,
    } as never);
    second.setState(state as never);
    await second.forward(restoredAI, { query: 'again' });
    expect(restoredCapture.users[0] ?? '').toContain(
      'Kernel guidance the actor always sees.'
    );
  });
});

/** Provenance whose recorded grant is absent from the current snapshot. */
function revokedProvenance() {
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
        grantIds: ['grant:held'],
        leaseEpoch: 1,
        authorizedAt: 1,
      },
    ],
    leaseEpoch: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** Runtime whose first turn declares a skill used and second turn finishes. */
function makeSkillsUsedRuntime(skillId: string): AxCodeRuntime {
  return {
    getUsageInstructions: () => '',
    createSession(globals) {
      return {
        execute: async (code: string) => {
          if (code.startsWith(AX_HOST_SNIPPET_MARKER)) return 'host-snippet';
          if (globals?.final && code.includes('final(')) {
            (globals.final as (...args: unknown[]) => void)('done', {
              data: 'done',
            });
            return 'done';
          }
          if (code.includes('discover(') && globals?.used) {
            (globals.used as (id: string, reason: string) => void)(
              skillId,
              'followed it'
            );
            return 'used ok';
          }
          return 'ok';
        },
        // Required for `getState()`; the runtime bindings are irrelevant here,
        // the skills-prompt state is what this exercises.
        snapshotGlobals: async () => ({
          version: 1 as const,
          entries: [],
          bindings: {},
        }),
        patchGlobals: async (patch: Record<string, unknown>) => {
          const { [AX_INPUTS_PATCH_GLOBAL]: staged, ...rest } = patch;
          Object.assign(globals ?? {}, rest);
          if (globals && staged && typeof staged === 'object') {
            globals.inputs = Object.assign(
              (globals.inputs as Record<string, unknown>) ?? {},
              staged
            );
          }
        },
        close: () => {},
      };
    },
  } as AxCodeRuntime;
}
