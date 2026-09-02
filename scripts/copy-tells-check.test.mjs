import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_COUNT_FLOOR, run } from './copy-tells-check.mjs';

const roots = [];

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop(), { recursive: true, force: true });
});

/** Build a fixture repo. `docs` maps doc name to content; padding fills to the floor. */
function fixture({
  readme = 'Plain readme copy.\n',
  docs = {},
  skills = {},
  pad = true,
}) {
  const root = mkdtempSync(join(tmpdir(), 'copy-tells-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'src/ax/skills'), { recursive: true });
  writeFileSync(join(root, 'README.md'), readme);
  for (const [name, body] of Object.entries(docs))
    writeFileSync(join(root, 'docs', name), body);
  for (const [name, body] of Object.entries(skills))
    writeFileSync(join(root, 'src/ax/skills', name), body);
  if (pad) {
    const have = 1 + Object.keys(docs).length + Object.keys(skills).length;
    for (let i = have; i < FILE_COUNT_FLOOR + 1; i += 1)
      writeFileSync(
        join(root, 'docs', `pad-${i}.md`),
        'The reducer rejects the patch.\n'
      );
  }
  return root;
}

const emptyAllow = { files: {}, deferred: {} };

describe('copy-tells-check', () => {
  it('fails a fixture carrying tells and names each one', () => {
    const root = fixture({
      docs: {
        'DIRTY.md': [
          '# 🚀 Getting Started',
          '',
          "Let's dive into the crucial details.",
          '',
          'This is not a cache, it is a guess.',
          '',
          'The store is robust and seamlessly scales.',
          '',
          'The reducer rejects it — the store is never touched.',
          '',
          'In conclusion, the gate holds.',
          '',
          '## Key takeaways',
          '',
          'The range is 1–10 items.',
          '',
        ].join('\n'),
      },
    });
    const result = run({ root, allowlist: emptyAllow });

    expect(result.ok).toBe(false);
    const rules = new Set(result.findings.map((f) => f.rule));
    expect(rules).toContain('vocab');
    expect(rules).toContain('dash-em-en');
    expect(rules).toContain('struct-lets-dive');
    expect(rules).toContain('struct-in-conclusion');
    expect(rules).toContain('struct-key-takeaways');
    expect(rules).toContain('struct-not-x-its-y');
    expect(rules).toContain('format-emoji-heading');

    const words = result.findings
      .filter((f) => f.rule === 'vocab')
      .map((f) => f.detail);
    expect(words).toEqual(
      expect.arrayContaining(['crucial', 'robust', 'seamlessly'])
    );
  });

  it('treats an em dash and an en dash as errors with no threshold', () => {
    const root = fixture({
      docs: { 'DASH.md': 'One dash — here.\nA range of 2–4 items.\n' },
    });
    const result = run({ root, allowlist: emptyAllow });
    const dashes = result.findings.filter((f) => f.rule === 'dash-em-en');
    expect(dashes).toHaveLength(2);
    expect(dashes.every((f) => f.severity === 'error')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('cannot silence a dash with the allowlist or with an inline escape', () => {
    const root = fixture({
      docs: {
        'DASH.md': '<!-- tells: allow dash-em-en -->\nStill a dash — here.\n',
      },
    });
    const allowlist = {
      files: { 'docs/DASH.md': { 'dash-em-en': 'we would like this to pass' } },
      deferred: {},
    };
    const result = run({ root, allowlist });
    expect(
      result.findings.some(
        (f) => f.rule === 'dash-em-en' && f.severity === 'error'
      )
    ).toBe(true);
    expect(result.configErrors.join(' ')).toMatch(/dashes have no allowlist/);
    expect(result.ok).toBe(false);
  });

  it('passes a clean fixture', () => {
    const root = fixture({
      readme: '# Ax\n\nThe reducer rejects the patch and records the reason.\n',
      docs: {
        'CLEAN.md':
          '# Store\n\nSpill is size-based: any field at or above `spillBytes`.\n',
      },
      skills: {
        'ax-clean.md': '# Clean\n\nThe cursor throws on a torn frame.\n',
      },
    });
    const result = run({ root, allowlist: emptyAllow });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('exempts the repo contract words and the motto sense of leverage', () => {
    const root = fixture({
      docs: {
        'CONTRACT.md': [
          'The harness owns the path, and harnesses are host-supplied.',
          '',
          'You get more leverage with the wedge on a halligan.',
          '',
          'The bar gives mechanical leverage against the jamb.',
          '',
        ].join('\n'),
      },
    });
    const result = run({ root, allowlist: emptyAllow });
    expect(result.findings).toEqual([]);
  });

  it('still flags leverage used as a verb', () => {
    const root = fixture({
      docs: { 'VERB.md': 'Hosts leverage the store to cache results.\n' },
    });
    const result = run({ root, allowlist: emptyAllow });
    expect(result.findings.map((f) => f.detail)).toContain('leverage');
  });

  it('honours an inline escape for the single following line only', () => {
    const root = fixture({
      docs: {
        'ESCAPE.md': [
          '<!-- tells: allow robust -->',
          'The robust set is a defined term here.',
          'A second robust line is not covered.',
          '',
        ].join('\n'),
      },
    });
    const result = run({ root, allowlist: emptyAllow });
    const lines = result.findings
      .filter((f) => f.rule === 'vocab')
      .map((f) => f.line);
    expect(lines).toEqual([3]);
  });

  it('downgrades an allowlisted rule and rejects an empty reason', () => {
    const root = fixture({ docs: { 'ALLOW.md': 'A crucial detail.\n' } });
    const allowed = run({
      root,
      allowlist: {
        files: {
          'docs/ALLOW.md': { vocab: 'quoting an external spec verbatim' },
        },
        deferred: {},
      },
    });
    expect(allowed.findings.every((f) => f.severity === 'allowed')).toBe(true);
    expect(allowed.ok).toBe(true);

    const empty = run({
      root,
      allowlist: { files: { 'docs/ALLOW.md': { vocab: '   ' } }, deferred: {} },
    });
    expect(empty.ok).toBe(false);
    expect(empty.configErrors.join(' ')).toMatch(/empty reason/);
  });

  it('marks a deferred file without failing, and requires a reason for it', () => {
    const root = fixture({
      docs: { 'LATER.md': 'A crucial detail — restated.\n' },
    });
    const deferred = run({
      root,
      allowlist: {
        files: {},
        deferred: { 'docs/LATER.md': 'another lane owns this file this week' },
      },
    });
    expect(deferred.ok).toBe(true);
    expect(deferred.perFile['docs/LATER.md'].deferred).toBeGreaterThan(0);
    expect(deferred.perFile['docs/LATER.md'].error).toBe(0);

    const noReason = run({
      root,
      allowlist: { files: {}, deferred: { 'docs/LATER.md': '' } },
    });
    expect(noReason.ok).toBe(false);
    expect(noReason.configErrors.join(' ')).toMatch(/empty reason/);
  });

  it('reports the inspected file count and fails below the floor', () => {
    const clean = fixture({
      docs: { 'CLEAN.md': 'The reducer rejects the patch.\n' },
    });
    const ok = run({ root: clean, allowlist: emptyAllow });
    expect(ok.inspectedFiles).toBe(FILE_COUNT_FLOOR + 1);
    expect(ok.floor).toBe(FILE_COUNT_FLOOR);
    expect(ok.ceilingNotice).toBe(2000);

    const thin = fixture({ docs: { 'ONE.md': 'Short.\n' }, pad: false });
    const result = run({ root: thin, allowlist: emptyAllow });
    expect(result.inspectedFiles).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.configErrors.join(' ')).toMatch(/below the floor/);
  });

  it('reads prose only: fenced code and inline code are not scanned', () => {
    const root = fixture({
      docs: {
        'CODE.md': [
          '```ts',
          "const crucial = '—'",
          '```',
          '',
          'See `robust — mode`.',
          '',
        ].join('\n'),
      },
    });
    const result = run({ root, allowlist: emptyAllow });
    expect(result.findings).toEqual([]);
  });

  it('warns on three consecutive bolded-lead bullets', () => {
    const root = fixture({
      docs: {
        'TRIAD.md': [
          '- **One** first.',
          '- **Two** second.',
          '- **Three** third.',
          '',
        ].join('\n'),
      },
    });
    const result = run({ root, allowlist: emptyAllow });
    const triad = result.findings.filter(
      (f) => f.rule === 'struct-bolded-lead-triad'
    );
    expect(triad).toHaveLength(1);
    expect(triad[0].severity).toBe('warning');
    expect(result.ok).toBe(true);
  });
});
