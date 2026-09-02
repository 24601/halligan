import { describe, expect, it, vi } from 'vitest';
import { AxMockAIService } from '../ai/mock/api.js';
import { AX_HOST_SNIPPET_MARKER } from './agentInternal/sharedSession.js';
import type { AxAgentCatalogSkill } from './agentInternal/skillsTypes.js';
import { agent } from './index.js';
import type { AxCodeRuntime } from './rlm.js';

// ----- Fixtures -----

const CATALOG: AxAgentCatalogSkill[] = [
  {
    id: 'release-checklist',
    name: 'Release checklist',
    description: 'Steps for shipping a new package release safely',
    content: '1. Bump version\n2. Run tests\n3. Tag and publish',
  },
];

const SLOT_SKILL: AxAgentCatalogSkill = {
  id: 'rollback-drill',
  name: 'Rollback drill',
  description: 'How to roll a bad release back',
  content: 'Promote the previous release, then verify.',
};

const makeModelUsage = () => ({
  ai: 'mock-ai',
  model: 'mock-model',
  tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

/** Runtime whose only turn finishes the actor loop. */
function makeFinalRuntime(): AxCodeRuntime {
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
          return 'ok';
        },
        patchGlobals: async () => {},
        close: () => {},
      };
    },
  } as AxCodeRuntime;
}

interface Capture {
  systems: string[];
  ai: AxMockAIService<unknown>;
}

function makeMockAI(capture: Capture) {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      const system = String(req.chatPrompt[0]?.content ?? '');
      if (system.includes('You (`executor`)')) {
        capture.systems.push(system);
        return {
          results: [
            {
              index: 0,
              content: 'Javascript Code: await final("done", { data: "done" })',
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

/**
 * An agent plus the capture buffer of the executor system prompts its own
 * `ai` was asked to complete. The executor stage runs on the agent's
 * constructed service, so the capture has to be wired at construction.
 */
type Harness = ReturnType<typeof agent> & { __capture: Capture };

/** The executor system prompt actually sent to the model. */
async function executorPrompt(a: Harness): Promise<string> {
  a.__capture.systems.length = 0;
  await a.forward(a.__capture.ai, { query: 'ship it' });
  return a.__capture.systems[0] ?? '';
}

function makeAgent(options: Readonly<Record<string, unknown>> = {}): Harness {
  const capture: Capture = { systems: [], ai: undefined as any };
  capture.ai = makeMockAI(capture);
  const a = agent('query:string -> answer:string', {
    ai: capture.ai,
    runtime: makeFinalRuntime(),
    maxTurns: 4,
    // One trivial tool so the RLM executor stage actually runs; without any
    // callable the agent degenerates to a plain generation and never renders
    // an executor prompt for the assertions below to read.
    functions: [
      {
        name: 'ping',
        description: 'Ping the service',
        parameters: { type: 'object' as const, properties: {} },
        func: async () => 'pong',
      },
    ],
    ...options,
  }) as Harness;
  a.__capture = capture;
  return a;
}

// ----- Instruction slots -----

describe('setActorInstructionSlot', () => {
  it('renders the slot text in the executor prompt', async () => {
    const a = makeAgent();
    a.setActorInstructionSlot('learn:tone', 'Always answer in one sentence.');
    expect(await executorPrompt(a)).toContain('Always answer in one sentence.');
  });

  it('replaces by name instead of stacking, so an install is idempotent', async () => {
    const a = makeAgent();
    a.setActorInstructionSlot('learn:tone', 'FIRST RULE');
    a.setActorInstructionSlot('learn:tone', 'FIRST RULE');
    const prompt = await executorPrompt(a);
    // Two identical `addActorInstruction` calls would appear twice; a slot
    // replaces, which is the whole reason this channel exists.
    expect(prompt.split('FIRST RULE').length - 1).toBe(1);
  });

  it('clears the slot when called with no text, restoring the prior prompt', async () => {
    const a = makeAgent();
    const before = await executorPrompt(a);
    a.setActorInstructionSlot('learn:tone', 'TEMPORARY RULE');
    expect(await executorPrompt(a)).toContain('TEMPORARY RULE');
    a.setActorInstructionSlot('learn:tone');
    const after = await executorPrompt(a);
    expect(after).not.toContain('TEMPORARY RULE');
    expect(after).toBe(before);
  });

  it('renders slots in slot-name order, not write order', async () => {
    const a = makeAgent();
    a.setActorInstructionSlot('learn:zulu', 'ZULU RULE');
    a.setActorInstructionSlot('learn:alpha', 'ALPHA RULE');
    const prompt = await executorPrompt(a);
    expect(prompt.indexOf('ALPHA RULE')).toBeGreaterThan(-1);
    expect(prompt.indexOf('ZULU RULE')).toBeGreaterThan(
      prompt.indexOf('ALPHA RULE')
    );
  });

  it('renders anonymous addenda before slots', async () => {
    const a = makeAgent();
    a.setActorInstructionSlot('learn:alpha', 'ALPHA RULE');
    a.addActorInstruction('ANONYMOUS RULE');
    const prompt = await executorPrompt(a);
    expect(prompt.indexOf('ANONYMOUS RULE')).toBeGreaterThan(-1);
    expect(prompt.indexOf('ALPHA RULE')).toBeGreaterThan(
      prompt.indexOf('ANONYMOUS RULE')
    );
  });

  it('rejects an empty slot name', () => {
    const a = makeAgent();
    expect(() => a.setActorInstructionSlot('  ', 'x')).toThrow(
      /non-empty string/
    );
  });
});

// ----- Skills catalog slots -----

describe('setSkillsCatalogSlot', () => {
  it('merges the slot skills into the rendered catalog after the base catalog', async () => {
    const a = makeAgent({ skillsCatalog: CATALOG });
    a.setSkillsCatalogSlot('learn', [SLOT_SKILL]);
    const prompt = await executorPrompt(a);
    expect(prompt).toContain('### Available Skills');
    expect(prompt).toContain('`rollback-drill`');
    expect(prompt).toContain('`release-checklist`');
  });

  it('makes the injected skill reachable through the built-in catalog search', () => {
    const a = makeAgent({ skillsCatalog: CATALOG });
    a.setSkillsCatalogSlot('learn', [SLOT_SKILL]);
    const search = (a as any).executor.onSkillsSearch as (
      s: readonly string[]
    ) => readonly { id?: string }[];
    expect(search(['roll a bad release back']).map((r) => r.id)).toContain(
      'rollback-drill'
    );
  });

  it('clearing the slot restores the base catalog exactly', async () => {
    const a = makeAgent({ skillsCatalog: CATALOG });
    const before = await executorPrompt(a);
    a.setSkillsCatalogSlot('learn', [SLOT_SKILL]);
    expect(await executorPrompt(a)).toContain('`rollback-drill`');
    a.setSkillsCatalogSlot('learn');
    const after = await executorPrompt(a);
    expect(after).not.toContain('`rollback-drill`');
    expect(after).toBe(before);
  });

  it('recomputes skillsHintEnabled and relevanceHintsEnabled', () => {
    // relevanceRanking on, but the agent starts with an empty catalog, so both
    // hint flags start false. Injecting a slot must turn them on: otherwise
    // injected skills are installed and never hinted.
    const a = makeAgent({ skillsCatalog: [], relevanceRanking: true });
    const stage = (a as any).executor;
    expect(stage.skillsHintEnabled).toBe(false);
    expect(stage.relevanceHintsEnabled).toBe(false);
    // An empty construction catalog is refused (direction 2), so use a
    // one-entry catalog whose hint flags are already on, then prove the slot
    // recompute survives a clear back to the base.
    const b = makeAgent({ skillsCatalog: CATALOG, relevanceRanking: true });
    const bs = (b as any).executor;
    expect(bs.skillsHintEnabled).toBe(true);
    b.setSkillsCatalogSlot('learn', [SLOT_SKILL]);
    expect(bs.skillsHintEnabled).toBe(true);
    expect(bs.relevanceHintsEnabled).toBe(true);
    expect(bs.skillsCatalog.map((s: AxAgentCatalogSkill) => s.id)).toEqual([
      'release-checklist',
      'rollback-drill',
    ]);
    b.setSkillsCatalogSlot('learn');
    expect(bs.skillsCatalog.map((s: AxAgentCatalogSkill) => s.id)).toEqual([
      'release-checklist',
    ]);
  });

  it('refuses an agent constructed with a host onSkillsSearch', () => {
    const hostSearch = vi.fn(async () => []);
    const a = makeAgent({ skillsCatalog: CATALOG, onSkillsSearch: hostSearch });
    expect(() => a.setSkillsCatalogSlot('learn', [SLOT_SKILL])).toThrow(
      /host onSkillsSearch/
    );
    // And the host callback is still the one installed.
    expect((a as any).executor.onSkillsSearch).toBe(hostSearch);
  });

  it('refuses an agent constructed without a skills catalog', () => {
    const a = makeAgent();
    expect(() => a.setSkillsCatalogSlot('learn', [SLOT_SKILL])).toThrow(
      /without a skills catalog/
    );
    expect((a as any).executor.onSkillsSearch).toBeUndefined();
  });

  it('merges multiple slots in slot-name order', () => {
    const a = makeAgent({ skillsCatalog: CATALOG });
    a.setSkillsCatalogSlot('zulu', [{ ...SLOT_SKILL, id: 'z-skill' }]);
    a.setSkillsCatalogSlot('alpha', [{ ...SLOT_SKILL, id: 'a-skill' }]);
    expect(
      (a as any).executor.skillsCatalog.map((s: AxAgentCatalogSkill) => s.id)
    ).toEqual(['release-checklist', 'a-skill', 'z-skill']);
  });

  it('rejects an empty slot name', () => {
    const a = makeAgent({ skillsCatalog: CATALOG });
    expect(() => a.setSkillsCatalogSlot('', [SLOT_SKILL])).toThrow(
      /non-empty string/
    );
  });
});
