import { describe, expect, it, vi } from 'vitest';

import { collectCoveredFailureSignatures } from '../../agent/playbookConfig.js';
import type { AxAIService } from '../../ai/types.js';
import { AxPlaybook } from '../playbook.js';
import { f } from '../sig.js';
import { ax } from '../template.js';
import { AxACE, AxACEOptimizedProgram } from './ace.js';
import {
  applyCuratorOperations,
  axProjectActorPlaybook,
  axRenderActorPlaybook,
  createEmptyPlaybook,
  createExecutablePlaybookView,
  dedupePlaybookByContent,
  isBulletApplicable,
  renderPlaybook,
} from './acePlaybook.js';
import type {
  AxACEActorPlaybookView,
  AxACEBullet,
  AxACECuratorOperation,
  AxACEPlaybook,
} from './aceTypes.js';

const NOW = '2026-01-01T00:00:00.000Z';

/**
 * The exact `fnv1a64` of the legacy render, pinned so a change to
 * `renderPlaybook` shows up as a failing byte-identity test rather than as a
 * silently different actor prompt.
 */
const LEGACY_RENDER_DIGEST = 'fnv1a64:00251c5b9f9ccb36';

function digest(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function bullet(override: Partial<AxACEBullet> & { id: string }): AxACEBullet {
  return {
    section: 'Guidelines',
    content: `content for ${override.id}`,
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...override,
  };
}

/** 12 actor bullets and 8 optimizer bullets, matching the C2 fixture shape. */
function mixedPlaybook(): AxACEPlaybook {
  const playbook = createEmptyPlaybook('Mixed tier playbook');
  playbook.sections.Guidelines = Array.from({ length: 12 }, (_unused, index) =>
    bullet({ id: `actor-${index}`, content: `actor secret text ${index}` })
  );
  playbook.sections['Common Pitfalls'] = Array.from(
    { length: 8 },
    (_unused, index) =>
      bullet({
        id: `optimizer-${index}`,
        section: 'Common Pitfalls',
        content: `optimizer only diagnostic ${index}`,
        visibility: 'optimizer',
      })
  );
  playbook.updatedAt = NOW;
  return playbook;
}

function legacyPlaybook(): AxACEPlaybook {
  const playbook = createEmptyPlaybook('Legacy playbook');
  playbook.sections.Guidelines = [
    bullet({ id: 'legacy-0', content: 'keep reasoning explicit' }),
    bullet({ id: 'legacy-1', content: 'cite the source' }),
  ];
  playbook.sections['Common Pitfalls'] = [
    bullet({
      id: 'legacy-2',
      section: 'Common Pitfalls',
      content: 'missing policy hints',
    }),
  ];
  playbook.updatedAt = NOW;
  return playbook;
}

const optimizerIds = (playbook: AxACEPlaybook): string[] =>
  Object.values(playbook.sections)
    .flat()
    .filter((entry) => entry.visibility === 'optimizer')
    .map((entry) => entry.id);

const optimizerContents = (playbook: AxACEPlaybook): string[] =>
  Object.values(playbook.sections)
    .flat()
    .filter((entry) => entry.visibility === 'optimizer')
    .map((entry) => entry.content);

describe('legacy byte identity', () => {
  it('renderPlaybook output hash is unchanged for a playbook with no new fields', () => {
    expect(digest(renderPlaybook(legacyPlaybook(), { now: NOW }))).toBe(
      LEGACY_RENDER_DIGEST
    );
  });

  it('the actor projection renders byte-identically for a legacy playbook', () => {
    const playbook = legacyPlaybook();
    const options = { now: NOW, includeInapplicable: true } as const;
    expect(
      axRenderActorPlaybook(axProjectActorPlaybook(playbook, options))
    ).toBe(renderPlaybook(playbook, options));
  });

  it('an empty playbook still projects to an empty actor render', () => {
    const playbook = createEmptyPlaybook();
    expect(
      axRenderActorPlaybook(axProjectActorPlaybook(playbook, { now: NOW }))
    ).toBe('');
  });
});

describe('the optimizer keeps seeing the optimizer tier', () => {
  it('renderPlaybook still emits optimizer-tier bullets', () => {
    const playbook = mixedPlaybook();
    const rendered = renderPlaybook(playbook, {
      includeInapplicable: true,
      now: NOW,
    });
    for (const id of optimizerIds(playbook)) {
      expect(rendered).toContain(id);
    }
  });

  it('createExecutablePlaybookView retains optimizer-tier bullets', () => {
    const playbook = mixedPlaybook();
    const view = createExecutablePlaybookView(playbook, NOW);
    expect(optimizerIds(view)).toHaveLength(8);
  });

  it('isBulletApplicable returns true for an optimizer-tier bullet', () => {
    // Visibility belongs to the projection, not to applicability: filtering it
    // here would blind the reflector, the curator, and coverage accounting.
    expect(
      isBulletApplicable(
        bullet({ id: 'optimizer-x', visibility: 'optimizer' }),
        { now: NOW }
      )
    ).toBe(true);
  });

  it('the rendered reflector prompt contains every optimizer-tier bullet id', async () => {
    const playbook = mixedPlaybook();
    const ace = new AxACE(
      { studentAI: {} as AxAIService, teacherAI: {} as AxAIService },
      { initialPlaybook: playbook }
    );
    ace.hydrate(
      ax(f().input('question', f.string()).output('answer', f.string()).build())
    );
    const reflector = (ace as any).getOrCreateReflectorProgram();
    const forwardSpy = vi.spyOn(reflector, 'forward').mockResolvedValue({
      reasoning: 'r',
      errorIdentification: 'no error',
      rootCauseAnalysis: '',
      correctApproach: '',
      keyInsight: '',
      bulletTags: [],
    });

    await (ace as any).runReflector({
      example: { question: 'q', answer: 'a' },
      generatorOutput: { reasoning: '', answer: {}, bulletIds: [] },
    });

    const sent = (forwardSpy.mock.calls[0]?.[1] as any).playbook as string;
    for (const id of optimizerIds(playbook)) {
      expect(sent).toContain(id);
    }
    for (const content of optimizerContents(playbook)) {
      expect(sent).toContain(content);
    }
  });

  it('the rendered curator prompt contains every optimizer-tier bullet id', async () => {
    const playbook = mixedPlaybook();
    const mockAI = {
      name: 'mock',
      chat: vi.fn().mockResolvedValue({
        results: [{ index: 0, content: '{"reasoning":"m","operations":[]}' }],
      }),
      getOptions: () => ({ tracer: undefined }),
      getLogger: () => undefined,
    } as unknown as AxAIService;
    const ace = new AxACE({
      studentAI: {} as AxAIService,
      teacherAI: mockAI,
    });
    const curator = (ace as any).getOrCreateCuratorProgram();
    const forwardSpy = vi.spyOn(curator, 'forward');

    await (ace as any).runCurator({
      program: ax(
        f().input('question', f.string()).output('answer', f.string()).build()
      ),
      example: { question: 'q' },
      reflection: { keyInsight: 'k' },
      playbook,
    });

    const sent = (forwardSpy.mock.calls[0]?.[1] as any).playbook as string;
    for (const id of optimizerIds(playbook)) {
      expect(sent).toContain(id);
    }
  });
});

describe('the actor never sees the optimizer tier', () => {
  it('axProjectActorPlaybook omits optimizer-tier bullets', () => {
    const playbook = mixedPlaybook();
    const view = axProjectActorPlaybook(playbook, { now: NOW });
    expect(optimizerIds(view.playbook)).toEqual([]);
    expect(view.playbook.sections.Guidelines).toHaveLength(12);
  });

  it('axRenderActorPlaybook throws for a hand-built view object', () => {
    // A public `kind` literal is a label; the brand is the enforcement, and a
    // view a host deserialized from JSON can never carry it.
    const forged = {
      kind: 'ax-ace-actor-playbook-view',
      playbook: mixedPlaybook(),
      decisions: [],
    } as AxACEActorPlaybookView;
    expect(() => axRenderActorPlaybook(forged)).toThrow(TypeError);
    const roundTripped = JSON.parse(
      JSON.stringify(axProjectActorPlaybook(mixedPlaybook(), { now: NOW }))
    ) as AxACEActorPlaybookView;
    expect(() => axRenderActorPlaybook(roundTripped)).toThrow(TypeError);
  });

  it('AxPlaybook.render never emits optimizer-tier content', () => {
    const playbook = mixedPlaybook();
    const live = new AxPlaybook(
      ax(
        f().input('question', f.string()).output('answer', f.string()).build()
      ),
      { studentAI: {} as AxAIService, initialPlaybook: playbook }
    );
    const rendered = live.render({ now: NOW, includeInapplicable: true });
    for (const content of optimizerContents(playbook)) {
      expect(rendered).not.toContain(content);
    }
    expect(rendered).toContain('actor secret text 0');
    expect(live.renderForActor({ now: NOW }).kind).toBe(
      'ax-ace-actor-playbook-view'
    );
  });

  it('collectCoveredFailureSignatures coverage is unchanged by the tier', () => {
    // Coverage reads `isBulletApplicable`, which deliberately ignores the tier.
    const playbook = mixedPlaybook();
    const snapshot = {
      playbook,
      artifact: {
        playbook,
        feedback: [
          {
            example: { failureSignatures: ['sig-a'] },
            prediction: {},
            score: 0,
            generatorOutput: { reasoning: '', answer: {}, bulletIds: [] },
            timestamp: NOW,
          },
        ],
        history: [
          {
            source: 'online',
            epoch: 0,
            exampleIndex: 0,
            operations: [],
            updatedBulletIds: ['optimizer-0'],
          },
        ],
      },
    } as never;
    const covered = collectCoveredFailureSignatures(snapshot, { now: NOW });
    expect([...covered]).toEqual(['sig-a']);
  });

  it('neither actor path leaks optimizer-tier bullet content, not just ids', () => {
    const playbook = mixedPlaybook();
    const contents = optimizerContents(playbook);
    const ids = optimizerIds(playbook);

    const projected = axRenderActorPlaybook(
      axProjectActorPlaybook(playbook, { includeInapplicable: true, now: NOW })
    );

    const applied = ax(
      f().input('question', f.string()).output('answer', f.string()).build()
    );
    new AxACEOptimizedProgram({
      bestScore: 1,
      stats: {} as any,
      playbook,
      artifact: { playbook, feedback: [], history: [] },
      baseInstruction: 'base instruction',
    }).applyTo(applied);
    const appliedDescription = applied.getSignature().getDescription() ?? '';

    const ace = new AxACE(
      { studentAI: {} as AxAIService, teacherAI: {} as AxAIService },
      { initialPlaybook: playbook }
    );
    const composed = (ace as any).composeInstruction('base', playbook, {
      includeInapplicable: true,
      now: NOW,
    }) as string;

    for (const surface of [projected, appliedDescription, composed]) {
      for (const content of contents) {
        expect(surface).not.toContain(content);
      }
      for (const id of ids) {
        expect(surface).not.toContain(id);
      }
      // The actor guidance is still there: a renderer that dropped everything
      // would pass the leak assertions above and fail this one.
      expect(surface).toContain('actor secret text 0');
    }
  });
});

describe('visibility laundering is blocked', () => {
  function optimizerSeed(): AxACEPlaybook {
    const playbook = createEmptyPlaybook('Laundering fixture');
    playbook.sections.Guidelines = [
      bullet({ id: 'actor-keep', content: 'ordinary actor guidance' }),
    ];
    playbook.sections['Common Pitfalls'] = [
      bullet({
        id: 'optimizer-seed',
        section: 'Common Pitfalls',
        content: 'internal diagnostic never shown to the actor',
        visibility: 'optimizer',
      }),
    ];
    return playbook;
  }

  const LEAK = 'internal diagnostic never shown to the actor';

  it('a curator ADD copying optimizer content verbatim inherits optimizer', () => {
    const playbook = optimizerSeed();
    applyCuratorOperations(playbook, [
      { type: 'ADD', section: 'Guidelines', content: LEAK },
    ]);
    const added = playbook.sections.Guidelines?.find(
      (entry) => entry.id !== 'actor-keep'
    );
    expect(added?.visibility).toBe('optimizer');
    expect(
      axRenderActorPlaybook(axProjectActorPlaybook(playbook, { now: NOW }))
    ).not.toContain(LEAK);
  });

  it('case and whitespace variants of the same content still inherit', () => {
    const playbook = optimizerSeed();
    applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Guidelines',
        content: `  ${LEAK.toUpperCase()} `,
      },
    ]);
    const added = playbook.sections.Guidelines?.find(
      (entry) => entry.id !== 'actor-keep'
    );
    expect(added?.visibility).toBe('optimizer');
  });

  it('a curator UPDATE rewriting a bullet to optimizer content inherits optimizer', () => {
    const playbook = optimizerSeed();
    applyCuratorOperations(playbook, [
      {
        type: 'UPDATE',
        section: 'Guidelines',
        bulletId: 'actor-keep',
        content: LEAK,
      },
    ]);
    expect(playbook.sections.Guidelines?.[0]?.visibility).toBe('optimizer');
  });

  it('a curator ADD superseding an optimizer bullet inherits optimizer', () => {
    const playbook = optimizerSeed();
    applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Common Pitfalls',
        content: 'a rewrite that replaces the internal diagnostic',
        supersedes: ['optimizer-seed'],
      },
    ]);
    const replacement = playbook.sections['Common Pitfalls']?.find(
      (entry) => entry.id !== 'optimizer-seed'
    );
    expect(replacement?.visibility).toBe('optimizer');
  });

  it('dedupePlaybookByContent takes the more restrictive visibility of a merged pair', () => {
    const playbook = createEmptyPlaybook('Merge fixture');
    playbook.sections.Guidelines = [
      bullet({ id: 'plain', content: 'shared text' }),
      bullet({ id: 'tiered', content: 'shared text', visibility: 'optimizer' }),
    ];
    dedupePlaybookByContent(playbook);
    expect(playbook.sections.Guidelines).toHaveLength(1);
    expect(playbook.sections.Guidelines?.[0]?.visibility).toBe('optimizer');
    expect(
      axRenderActorPlaybook(axProjectActorPlaybook(playbook, { now: NOW }))
    ).not.toContain('shared text');
  });

  it('an ordinary ADD in a playbook with an optimizer tier stays actor-visible', () => {
    // The inheritance rules must not quarantine unrelated new guidance.
    const playbook = optimizerSeed();
    applyCuratorOperations(playbook, [
      { type: 'ADD', section: 'Guidelines', content: 'unrelated new guidance' },
    ]);
    const added = playbook.sections.Guidelines?.find(
      (entry) => entry.content === 'unrelated new guidance'
    );
    expect(added).not.toHaveProperty('visibility');
    expect(
      axRenderActorPlaybook(axProjectActorPlaybook(playbook, { now: NOW }))
    ).toContain('unrelated new guidance');
  });
});

describe('visibility mutation rules', () => {
  it('a curator operation downgrades a bullet to optimizer', () => {
    const playbook = legacyPlaybook();
    applyCuratorOperations(playbook, [
      {
        type: 'UPDATE',
        section: 'Guidelines',
        bulletId: 'legacy-0',
        visibility: 'optimizer',
      },
    ]);
    expect(playbook.sections.Guidelines?.[0]?.visibility).toBe('optimizer');
  });

  it('an UPDATE with no visibility does not clear an existing optimizer tier', () => {
    const playbook = legacyPlaybook();
    playbook.sections.Guidelines![0]!.visibility = 'optimizer';
    applyCuratorOperations(playbook, [
      {
        type: 'UPDATE',
        section: 'Guidelines',
        bulletId: 'legacy-0',
        content: 'revised text',
      },
    ]);
    expect(playbook.sections.Guidelines?.[0]?.visibility).toBe('optimizer');
  });

  it('assertCuratorOperation throws on visibility actor arriving as parsed JSON', () => {
    // `ace.ts` casts parsed curator JSON; TypeScript is not a runtime gate.
    const forged = JSON.parse(
      '{"type":"UPDATE","section":"Guidelines","bulletId":"legacy-0","visibility":"actor"}'
    ) as AxACECuratorOperation;
    expect(() => applyCuratorOperations(legacyPlaybook(), [forged])).toThrow(
      TypeError
    );
    const nonsense = JSON.parse(
      '{"type":"ADD","section":"Guidelines","content":"x","visibility":"OPTIMIZER"}'
    ) as AxACECuratorOperation;
    expect(() => applyCuratorOperations(legacyPlaybook(), [nonsense])).toThrow(
      TypeError
    );
  });

  it('host evidence may promote a bullet to actor', () => {
    const playbook = legacyPlaybook();
    playbook.sections.Guidelines![0]!.visibility = 'optimizer';
    applyCuratorOperations(
      playbook,
      [{ type: 'UPDATE', section: 'Guidelines', bulletId: 'legacy-0' }],
      { hostEvidence: { source: 'manual', visibility: 'actor' } }
    );
    expect(playbook.sections.Guidelines?.[0]?.visibility).toBe('actor');
  });

  it('host evidence carrying a malformed visibility is rejected', () => {
    expect(() =>
      applyCuratorOperations(
        legacyPlaybook(),
        [{ type: 'UPDATE', section: 'Guidelines', bulletId: 'legacy-0' }],
        { hostEvidence: { visibility: 'hidden' } as never }
      )
    ).toThrow(TypeError);
  });

  it('assertPlaybookMutable throws on a malformed bullet visibility', () => {
    for (const value of ['Actor', 0, {}, null, '']) {
      const playbook = legacyPlaybook();
      (playbook.sections.Guidelines![0] as Record<string, unknown>).visibility =
        value;
      expect(() => applyCuratorOperations(playbook, [])).toThrow(TypeError);
    }
  });

  it('defaultBulletVisibility stamps the tier on bullets the engine writes', () => {
    const ace = new AxACE(
      { studentAI: {} as AxAIService, teacherAI: {} as AxAIService },
      { defaultBulletVisibility: 'optimizer' }
    );
    const created = ace.recordEvidence([], { source: 'manual' });
    expect(created).toEqual([]);

    const playbook = legacyPlaybook();
    applyCuratorOperations(
      playbook,
      [{ type: 'ADD', section: 'Guidelines', content: 'new guidance' }],
      { hostEvidence: { source: 'manual', visibility: 'optimizer' } }
    );
    const added = playbook.sections.Guidelines?.find(
      (entry) => entry.content === 'new guidance'
    );
    expect(added?.visibility).toBe('optimizer');
  });

  it('a playbook that never uses the tier keeps no visibility field at all', () => {
    const playbook = legacyPlaybook();
    applyCuratorOperations(playbook, [
      { type: 'ADD', section: 'Guidelines', content: 'plain guidance' },
    ]);
    for (const entry of Object.values(playbook.sections).flat()) {
      expect(entry).not.toHaveProperty('visibility');
    }
  });
});
