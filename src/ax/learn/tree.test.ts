import { describe, expect, it } from 'vitest';
import {
  axAdmitHarnessTree,
  axApplyHarnessMutations,
  axHarnessContentId,
  axInspectHarnessTree,
  axRenderHarnessTree,
} from './tree.js';
import {
  AxHarnessAdmissionError,
  type AxHarnessAdmissionReason,
  type AxHarnessEntry,
  AxHarnessMutationError,
  type AxHarnessTree,
  axIsHarnessAdmissionError,
} from './types.js';

const NOW = '2026-01-01T00:00:00.000Z';

const instruction = (id: string, text = 'Answer briefly.'): AxHarnessEntry => ({
  id,
  kind: 'instruction',
  config: { text },
});

const bullet = (
  id: string,
  overrides: Record<string, unknown> = {}
): AxHarnessEntry =>
  ({
    id,
    kind: 'playbookBullet',
    config: {
      id: `${id}-bullet`,
      section: 'General',
      content: 'Prefer the shortest correct answer.',
      ...overrides,
    },
  }) as AxHarnessEntry;

const skill = (
  id: string,
  overrides: Record<string, unknown> = {}
): AxHarnessEntry =>
  ({
    id,
    kind: 'skill',
    config: {
      skillId: `${id}-skill`,
      name: 'Rollback drill',
      content: 'Promote the previous release.',
      ...overrides,
    },
  }) as AxHarnessEntry;

/** The reason codes a single entry produced. */
function reasons(
  tree: AxHarnessTree,
  entryId: string
): readonly AxHarnessAdmissionReason[] {
  const row = axInspectHarnessTree(tree).entries.find(
    (entry) => entry.entryId === entryId
  );
  return (row?.reasons ?? []).map((r) => r.reason);
}

// ---------------------------------------------------------------------------

describe('axRenderHarnessTree', () => {
  it('is a pure function of (tree, now): two calls deep-equal and share no mutable state', () => {
    const tree = [instruction('i1'), bullet('b1'), skill('s1')];
    const a = axRenderHarnessTree(tree, { now: NOW });
    const b = axRenderHarnessTree(tree, { now: NOW });
    expect(a).toEqual(b);
    // Mutating one rendering must not be visible in the next render.
    (a.playbook.sections.General as unknown[]).push({ id: 'injected' });
    expect(axRenderHarnessTree(tree, { now: NOW })).toEqual(b);
  });

  it('produces a valid AxACEPlaybook with version, stats and updatedAt from now', () => {
    const rendered = axRenderHarnessTree([bullet('b1'), bullet('b2')], {
      now: NOW,
    });
    expect(rendered.playbook.version).toBe(1);
    expect(rendered.playbook.updatedAt).toBe(NOW);
    expect(rendered.playbook.stats.bulletCount).toBe(2);
    expect(rendered.playbook.stats.tokenEstimate).toBeGreaterThan(0);
    const first = rendered.playbook.sections.General?.[0];
    expect(first?.createdAt).toBe(NOW);
    expect(first?.updatedAt).toBe(NOW);
    // Counters are synthesized here, never carried by a proposer.
    expect(first?.helpfulCount).toBe(0);
    expect(first?.harmfulCount).toBe(0);
  });

  it('joins instruction entries in entry-id order so neither clobbers the other', () => {
    const rendered = axRenderHarnessTree(
      [instruction('zulu', 'ZULU'), instruction('alpha', 'ALPHA')],
      { now: NOW }
    );
    expect(rendered.instructions.actor).toBe('ALPHA\n\nZULU');
  });

  it('excludes a disabled entry from the rendering', () => {
    const rendered = axRenderHarnessTree(
      [{ ...instruction('i1'), disabled: true }, bullet('b1')],
      { now: NOW }
    );
    expect(rendered.instructions.actor).toBeUndefined();
    expect(rendered.playbook.stats.bulletCount).toBe(1);
  });

  it('maps a skill entry onto AxAgentCatalogSkill with skillId as the id', () => {
    const rendered = axRenderHarnessTree(
      [skill('s1', { description: 'when to roll back' })],
      { now: NOW }
    );
    expect(rendered.skills[0]).toEqual({
      id: 's1-skill',
      name: 'Rollback drill',
      description: 'when to roll back',
      content: 'Promote the previous release.',
    });
  });

  it('refuses a render with no timestamp rather than fabricating one', () => {
    expect(() => axRenderHarnessTree([bullet('b1')], { now: '' })).toThrow(
      /non-empty ISO timestamp/
    );
  });
});

describe('axHarnessContentId', () => {
  it('is stable under key reordering and unstable under any value change', async () => {
    const a: AxHarnessEntry = {
      id: 'i1',
      kind: 'instruction',
      config: { text: 'A' },
    };
    const b = {
      kind: 'instruction',
      config: { text: 'A' },
      id: 'i1',
    } as unknown as AxHarnessEntry;
    expect(await axHarnessContentId([a])).toBe(await axHarnessContentId([b]));
    const changed: AxHarnessEntry = {
      id: 'i1',
      kind: 'instruction',
      config: { text: 'B' },
    };
    expect(await axHarnessContentId([a])).not.toBe(
      await axHarnessContentId([changed])
    );
  });

  it('changes when two entries swap order', async () => {
    const first = await axHarnessContentId([
      instruction('a'),
      instruction('b'),
    ]);
    const second = await axHarnessContentId([
      instruction('b'),
      instruction('a'),
    ]);
    expect(first).not.toBe(second);
  });

  it('distinguishes a toggled `disabled` flag from an absent one', async () => {
    // `axEventCanonicalJson` drops `undefined`, so this has to be asserted
    // rather than assumed.
    const plain = await axHarnessContentId([instruction('i1')]);
    const explicitFalse = await axHarnessContentId([
      { ...instruction('i1'), disabled: false },
    ]);
    const explicitTrue = await axHarnessContentId([
      { ...instruction('i1'), disabled: true },
    ]);
    expect(plain).not.toBe(explicitFalse);
    expect(explicitFalse).not.toBe(explicitTrue);
  });

  it('is a full sha256, not a truncated checksum', async () => {
    expect(await axHarnessContentId([instruction('i1')])).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
  });
});

describe('credential tripwire — rule 1 (key name)', () => {
  const KEY_FORMS = [
    'apiKey',
    'api_key',
    'api-keys',
    'API_KEY_ENV',
    'token',
    'tokens',
    'secret',
    'passwords',
    'credentials',
  ];

  it.each(KEY_FORMS)('rejects a string under `%s`', (key) => {
    // Placed under a config the kind allows, so the ONLY reason is the key.
    const tree = [
      {
        ...bullet('b1'),
        config: { ...(bullet('b1').config as object), [key]: 'x' },
      },
    ] as unknown as AxHarnessTree;
    expect(reasons(tree, 'b1')).toContain('inline-credential');
  });

  it('rejects a credential-named key nested inside an allowed value', () => {
    const tree = [
      instruction('i1'),
      {
        id: 'b1',
        kind: 'playbookBullet',
        config: {
          id: 'b',
          section: 'General',
          content: 'x',
          nested: { apiKey: 'abc' },
        },
      },
    ] as unknown as AxHarnessTree;
    expect(reasons(tree, 'b1')).toContain('inline-credential');
  });

  it('rejects a credential-named key holding an array with a string', () => {
    const tree = [
      {
        id: 's1',
        kind: 'skill',
        config: {
          skillId: 's',
          name: 'n',
          content: 'c',
          tokens: ['abc'],
        },
      },
    ] as unknown as AxHarnessTree;
    const found = axInspectHarnessTree(tree).entries[0]?.reasons ?? [];
    expect(found.map((r) => r.reason)).toContain('inline-credential');
    expect(found.find((r) => r.reason === 'inline-credential')?.path).toBe(
      'config.tokens[0]'
    );
  });

  it('accepts a credential-shaped key whose value is a number or null', () => {
    const tree = [
      {
        id: 'b1',
        kind: 'playbookBullet',
        config: { id: 'b', section: 'General', content: 'x', tokenCount: 4 },
      },
    ] as unknown as AxHarnessTree;
    // `tokenCount` does not end in a credential word and the value is a
    // number: the tripwire is about literals, not about names alone.
    expect(reasons(tree, 'b1')).not.toContain('inline-credential');
  });
});

describe('credential tripwire — rule 2 (value shape), across every kind', () => {
  const LITERALS: readonly [string, string][] = [
    ['openai', 'sk-abcdefghij0123456789'],
    ['github', 'ghp_abcdefghij0123456789abcd'],
    ['slack', 'xoxb-1234567890-abcdefghij'],
    ['aws', 'AKIA0123456789ABCDEF'],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'],
    ['hex-near-token', 'token 0123456789abcdef0123456789abcdef01234567'],
  ];

  it.each(LITERALS)(
    'rejects a %s literal in instruction free text',
    (_name, literal) => {
      const tree = [instruction('i1', `Use ${literal} to call the API.`)];
      expect(reasons(tree, 'i1')).toContain('credential-shaped-literal');
    }
  );

  it.each(LITERALS)(
    'rejects a %s literal in playbookBullet content',
    (_name, literal) => {
      const tree = [bullet('b1', { content: `Remember ${literal}` })];
      expect(reasons(tree, 'b1')).toContain('credential-shaped-literal');
    }
  );

  it.each(LITERALS)(
    'rejects a %s literal in skill content',
    (_name, literal) => {
      const tree = [skill('s1', { content: `Run with ${literal}` })];
      expect(reasons(tree, 's1')).toContain('credential-shaped-literal');
    }
  );

  it.each(LITERALS)(
    'rejects a %s literal in playbookBullet tags',
    (_name, literal) => {
      const tree = [bullet('b1', { tags: [literal] })];
      expect(reasons(tree, 'b1')).toContain('credential-shaped-literal');
    }
  );

  it('leaves ordinary long prose alone', () => {
    const tree = [
      instruction(
        'i1',
        'Answer using the shortest correct sentence you can write, and cite the source document whenever one is available.'
      ),
    ];
    expect(reasons(tree, 'i1')).toEqual([]);
  });

  it('carries the path and never the value in the error', () => {
    const secret = 'sk-abcdefghij0123456789';
    try {
      axAdmitHarnessTree([instruction('i1', `key ${secret}`)]);
      throw new Error('expected a denial');
    } catch (error) {
      expect(axIsHarnessAdmissionError(error)).toBe(true);
      const denial = error as AxHarnessAdmissionError;
      expect(denial.path).toBe('config.text');
      expect(denial.message).not.toContain(secret);
      expect(JSON.stringify(denial.report)).not.toContain(secret);
    }
  });
});

describe('bullet authority allow-list', () => {
  const FORBIDDEN: readonly [string, unknown][] = [
    ['helpfulCount', 3],
    ['harmfulCount', 1],
    ['createdAt', '2020-01-01T00:00:00.000Z'],
    ['updatedAt', '2020-01-01T00:00:00.000Z'],
    ['revision', 7],
    ['lineage', { supersedes: ['x'] }],
    ['evidence', { confidence: 1 }],
  ];

  it.each(FORBIDDEN)(
    'rejects a proposer-authored bullet carrying `%s`',
    (field, value) => {
      const tree = [bullet('b1', { [field as string]: value })];
      const found = axInspectHarnessTree(tree).entries[0]?.reasons ?? [];
      expect(found.map((r) => r.reason)).toContain('forbidden-bullet-field');
      // Rejected, never silently stripped.
      expect(axInspectHarnessTree(tree).ok).toBe(false);
      expect(
        found.find((r) => r.reason === 'forbidden-bullet-field')?.path
      ).toBe(`config.${field}`);
    }
  );
});

describe('structural admission rules', () => {
  it('rejects the SECOND entry that reuses an id', () => {
    const report = axInspectHarnessTree([instruction('i1'), instruction('i1')]);
    expect(report.entries[0]?.admitted).toBe(true);
    expect(report.entries[1]?.reasons.map((r) => r.reason)).toContain(
      'duplicate-entry-id'
    );
    expect(report.ok).toBe(false);
  });

  it('rejects an entry id containing `:` because slot names are built from it', () => {
    expect(reasons([instruction('learn:x')], 'learn:x')).toContain(
      'invalid-entry-id'
    );
  });

  it('rejects an unknown kind', () => {
    const tree = [
      { id: 'x', kind: 'demo', config: {} },
    ] as unknown as AxHarnessTree;
    expect(reasons(tree, 'x')).toContain('unknown-kind');
  });

  it('rejects an unknown config key on every kind', () => {
    expect(
      reasons([instruction('i1'), bullet('b1', { extra: 1 })], 'b1')
    ).toContain('unknown-config-key');
    expect(
      reasons(
        [
          {
            id: 'i2',
            kind: 'instruction',
            config: { text: 'x', extra: 1 },
          } as unknown as AxHarnessEntry,
        ],
        'i2'
      )
    ).toContain('unknown-config-key');
    expect(reasons([skill('s1', { extra: 1 })], 's1')).toContain(
      'unknown-config-key'
    );
  });

  it('rejects empty text after trim', () => {
    expect(reasons([instruction('i1', '   ')], 'i1')).toContain('empty-text');
    expect(reasons([skill('s1', { content: '' })], 's1')).toContain(
      'empty-text'
    );
  });

  it('applies the path-segment rule to skillId and bullet id, not to the human name', () => {
    expect(reasons([skill('s1', { skillId: 'bad id' })], 's1')).toContain(
      'invalid-name-segment'
    );
    expect(reasons([bullet('b1', { id: '-leading' })], 'b1')).toContain(
      'invalid-name-segment'
    );
    // The human title is free text and is NOT segment-constrained.
    expect(
      reasons([skill('s2', { name: 'Roll back a bad release!' })], 's2')
    ).toEqual([]);
  });

  it('rejects two skills rendering onto the same skillId', () => {
    const tree = [
      skill('s1', { skillId: 'shared' }),
      skill('s2', { skillId: 'shared' }),
    ];
    expect(reasons(tree, 's2')).toContain('duplicate-render-target');
    // …and the first one still passes, so the report is per-entry.
    expect(reasons(tree, 's1')).toEqual([]);
  });

  it('rejects an oversized entry', () => {
    const huge = 'x'.repeat(70 * 1024);
    expect(reasons([instruction('i1', huge)], 'i1')).toContain(
      'oversized-entry'
    );
  });

  it('returns a verdict for EVERY entry, including ones after the first denial', () => {
    const report = axInspectHarnessTree([
      instruction('bad', '  '),
      instruction('good'),
      bullet('alsoBad', { section: '' }),
    ]);
    expect(report.entries.map((e) => e.entryId)).toEqual([
      'bad',
      'good',
      'alsoBad',
    ]);
    expect(report.entries.map((e) => e.admitted)).toEqual([false, true, false]);
    expect(report.admitted.map((e) => e.id)).toEqual(['good']);
    expect(report.ok).toBe(false);
  });

  it('validates a disabled entry and carries it into the tree', () => {
    const disabled = { ...instruction('i1', '  '), disabled: true };
    expect(reasons([disabled], 'i1')).toContain('empty-text');
    const good = { ...instruction('i2'), disabled: true };
    expect(axAdmitHarnessTree([good])).toHaveLength(1);
  });

  it('axAdmitHarnessTree throws with the first denial and the full report', () => {
    try {
      axAdmitHarnessTree([instruction('bad', ''), instruction('good')]);
      throw new Error('expected a denial');
    } catch (error) {
      const denial = error as AxHarnessAdmissionError;
      expect(denial.code).toBe('harness_admission_denied');
      expect(denial.entryId).toBe('bad');
      expect(denial.reason).toBe('empty-text');
      expect(denial.report.entries).toHaveLength(2);
      expect(denial.report.entries[1]?.admitted).toBe(true);
    }
  });
});

describe('axApplyHarnessMutations', () => {
  const base: AxHarnessTree = [instruction('i1'), bullet('b1')];

  it('creates, updates and removes', () => {
    const created = axApplyHarnessMutations(base, [
      {
        op: 'create',
        id: 's1',
        options: {
          kind: 'skill',
          config: { skillId: 'new-skill', name: 'New', content: 'body' },
        },
      },
    ]);
    expect(created.map((e) => e.id)).toEqual(['i1', 'b1', 's1']);

    const updated = axApplyHarnessMutations(base, [
      { op: 'update', id: 'i1', options: { config: { text: 'CHANGED' } } },
    ]);
    expect(
      (updated.find((e) => e.id === 'i1')?.config as { text: string }).text
    ).toBe('CHANGED');

    const removed = axApplyHarnessMutations(base, [{ op: 'remove', id: 'b1' }]);
    expect(removed.map((e) => e.id)).toEqual(['i1']);
  });

  it('merges config one level so a proposer can edit one bullet field', () => {
    const updated = axApplyHarnessMutations(base, [
      { op: 'update', id: 'b1', options: { config: { content: 'NEW BODY' } } },
    ]);
    const config = updated.find((e) => e.id === 'b1')?.config as {
      id: string;
      section: string;
      content: string;
    };
    expect(config).toEqual({
      id: 'b1-bullet',
      section: 'General',
      content: 'NEW BODY',
    });
  });

  it('deletes a key when the update value is null', () => {
    const withTags = axApplyHarnessMutations(base, [
      { op: 'update', id: 'b1', options: { config: { tags: ['x'] } } },
    ]);
    const cleared = axApplyHarnessMutations(withTags, [
      { op: 'update', id: 'b1', options: { config: { tags: null } } },
    ]);
    expect(
      (cleared.find((e) => e.id === 'b1')?.config as { tags?: string[] }).tags
    ).toBeUndefined();
  });

  it('applies atomically: one invalid op leaves the tree unchanged', () => {
    expect(() =>
      axApplyHarnessMutations(base, [
        { op: 'update', id: 'i1', options: { config: { text: 'ONE' } } },
        { op: 'remove', id: 'missing' },
      ])
    ).toThrow(AxHarnessMutationError);
    // The input is untouched — the function is pure, so "atomic" means the
    // caller still holds exactly what it passed in.
    expect(
      (base.find((e) => e.id === 'i1')?.config as { text: string }).text
    ).toBe('Answer briefly.');
  });

  it('refuses to rename an entry', () => {
    expect(() =>
      axApplyHarnessMutations(base, [
        { op: 'update', id: 'i1', options: { id: 'i2' } },
      ])
    ).toThrow(/may not rename/);
  });

  it('re-admits the result, so a proposal cannot smuggle a credential in', () => {
    expect(() =>
      axApplyHarnessMutations(base, [
        {
          op: 'update',
          id: 'i1',
          options: { config: { text: 'use sk-abcdefghij0123456789' } },
        },
      ])
    ).toThrow(AxHarnessAdmissionError);
  });

  it('re-admits the result, so a proposal cannot smuggle bullet evidence in', () => {
    expect(() =>
      axApplyHarnessMutations(base, [
        {
          op: 'update',
          id: 'b1',
          options: { config: { helpfulCount: 99 } },
        },
      ])
    ).toThrow(AxHarnessAdmissionError);
  });

  it('keeps the mutation id when a JS caller smuggles one into create options', () => {
    // The type forbids `id` in the options; a plain JS caller can still pass
    // one, and an entry addressed by a different id than the mutation that
    // created it would be unreachable by every later mutation.
    const created = axApplyHarnessMutations(base, [
      {
        op: 'create',
        id: 's1',
        options: {
          id: 'somethingElse',
          kind: 'skill',
          config: { skillId: 'new-skill', name: 'New', content: 'body' },
        },
      } as unknown as AxHarnessMutation,
    ]);
    expect(created.map((e) => e.id)).toEqual(['i1', 'b1', 's1']);
  });

  it('refuses a create on an existing id and a remove of a missing id', () => {
    expect(() =>
      axApplyHarnessMutations(base, [
        {
          op: 'create',
          id: 'i1',
          options: { kind: 'instruction', config: { text: 'x' } },
        },
      ])
    ).toThrow(/already exists/);
    expect(() =>
      axApplyHarnessMutations(base, [{ op: 'remove', id: 'nope' }])
    ).toThrow(/does not exist/);
  });
});
