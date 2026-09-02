import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertAlignedReleaseVersions,
  normalizeAddedChangelogSection,
  normalizeChangelogDashes,
  parseReleaseArguments,
  parseRemoteTagTarget,
  publishFetchArguments,
  releaseBranchName,
  releaseVersionFromSubject,
  resolveReleaseVersion,
  selectReleaseCommit,
} from './release.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

describe('protected-main release workflow', () => {
  it.each([
    ['24.0.5', 'patch', '24.0.6'],
    ['24.0.5', 'minor', '24.1.0'],
    ['24.0.5', 'major', '25.0.0'],
    ['24.0.5', '24.2.3', '24.2.3'],
  ])('resolves %s with %s to %s', (current, increment, expected) => {
    expect(resolveReleaseVersion(current, increment)).toBe(expected);
  });

  it.each(['24.0.5', '23.9.9', 'next', '24.0.6-rc.1'])(
    'rejects non-increasing or unsupported release target %s',
    (target) => {
      expect(() => resolveReleaseVersion('24.0.5', target)).toThrow();
    }
  );

  it('requires every publishable package to share one version', () => {
    expect(assertAlignedReleaseVersions({ root: '24.0.6', ax: '24.0.6' })).toBe(
      '24.0.6'
    );
    expect(() =>
      assertAlignedReleaseVersions({ root: '24.0.6', ax: '24.0.5' })
    ).toThrow(/not aligned/);
  });

  it('uses a version-specific protected release branch', () => {
    expect(releaseBranchName('24.0.6')).toBe('codex/release-24-0-6');
  });

  it.each([
    ['chore: release v24.0.11', '24.0.11'],
    ['chore: release v24.0.11 (#614)', '24.0.11'],
    ['fix: release v24.0.11', null],
    ['chore: release v24.0.11 unexpectedly', null],
    ['chore: release v24.0.11-rc.1', null],
  ])('extracts a release version from %j', (subject, expected) => {
    expect(releaseVersionFromSubject(subject)).toBe(expected);
  });

  it('resolves a missed historical release commit unambiguously', () => {
    expect(
      selectReleaseCommit('24.0.9', [
        { sha: 'newer', subject: 'chore: release v24.0.10 (#613)' },
        { sha: 'release', subject: 'chore: release v24.0.9 (#611)' },
        { sha: 'feature', subject: 'feat: something else' },
      ])
    ).toBe('release');
    expect(() => selectReleaseCommit('24.0.8', [])).toThrow(/not present/);
    expect(() =>
      selectReleaseCommit('24.0.9', [
        { sha: 'one', subject: 'chore: release v24.0.9 (#611)' },
        { sha: 'two', subject: 'chore: release v24.0.9' },
      ])
    ).toThrow(/multiple commits/);
  });

  it('resolves annotated and lightweight remote tags to their release commit', () => {
    expect(
      parseRemoteTagTarget(
        [
          'tag-object refs/tags/24.0.6',
          'release-commit refs/tags/24.0.6^{}',
        ].join('\n'),
        '24.0.6'
      )
    ).toBe('release-commit');
    expect(
      parseRemoteTagTarget('release-commit refs/tags/24.0.6', '24.0.6')
    ).toBe('release-commit');
    expect(parseRemoteTagTarget('', '24.0.6')).toBeNull();
  });

  it('parses only the guarded release phases', () => {
    expect(parseReleaseArguments(['prepare', 'minor'])).toEqual({
      mode: 'prepare',
      value: 'minor',
    });
    expect(parseReleaseArguments(['publish', '24.0.6'])).toEqual({
      mode: 'publish',
      value: '24.0.6',
    });
    expect(parseReleaseArguments(['publish-merged', 'a'.repeat(40)])).toEqual({
      mode: 'publish-merged',
      value: 'a'.repeat(40),
    });
    expect(() => parseReleaseArguments(['publish-merged'])).toThrow(
      /requires a SHA/
    );
    expect(() => parseReleaseArguments(['ship'])).toThrow(/Usage/);
  });

  it('does not fetch unrelated historical tags before publishing', () => {
    expect(publishFetchArguments()).toEqual([
      'fetch',
      '--prune',
      'origin',
      'main',
    ]);
    expect(publishFetchArguments()).not.toContain('--tags');
  });

  it('cannot tag, push main, or publish from release-it directly', () => {
    const config = JSON.parse(
      readFileSync(path.join(repoRoot, '.release-it.json'), 'utf8')
    );
    expect(config.git).toMatchObject({
      push: false,
      requireBranch: 'codex/release-*',
      requireUpstream: false,
      tag: false,
    });
    expect(config.github.release).toBe(false);
  });

  it('routes maintainer commands through the guarded workflow', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    );
    expect(manifest.scripts.release).toBe('node scripts/release.mjs prepare');
    expect(manifest.scripts['release:publish']).toBe(
      'node scripts/release.mjs publish'
    );
  });

  it('publishes merged release commits after successful main CI', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release-publish.yml'),
      'utf8'
    );
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain("workflows: ['Build and Test']");
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'success'"
    );
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain('actions: write');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain(
      'node scripts/release.mjs publish-merged "$RELEASE_SHA"'
    );
  });
});

describe('generated changelog dash normalisation', () => {
  const EM = String.fromCharCode(0x2014);
  const EN = String.fromCharCode(0x2013);

  it('rewrites an em dash from a commit subject as a colon', () => {
    expect(normalizeChangelogDashes(`* fix ${EM} drop the retry loop`)).toBe(
      '* fix: drop the retry loop'
    );
  });

  it('rewrites a trailing em dash without leaving a trailing space', () => {
    expect(normalizeChangelogDashes(`* fix ${EM}\nnext\n`)).toBe(
      '* fix:\nnext\n'
    );
  });

  it('keeps an unspaced en dash range as a hyphen', () => {
    expect(normalizeChangelogDashes(`* covers steps 1${EN}10`)).toBe(
      '* covers steps 1-10'
    );
  });

  it('rewrites a spaced en dash as a comma', () => {
    expect(normalizeChangelogDashes(`* fix ${EN} the reducer`)).toBe(
      '* fix, the reducer'
    );
  });

  it('leaves dash-free text byte-identical', () => {
    const text = '## [1.2.3] (2026-01-01)\n\n* fix: a thing\n';
    expect(normalizeChangelogDashes(text)).toBe(text);
  });

  it('normalises only the newly prepended section', () => {
    const history = `## [1.0.0]\n\n* old ${EM} entry\n`;
    const added = `## [1.1.0]\n\n* new ${EM} entry\n\n`;
    expect(normalizeAddedChangelogSection(history, added + history)).toBe(
      `## [1.1.0]\n\n* new: entry\n\n${history}`
    );
  });

  it('normalises the whole file when there is no prior content', () => {
    expect(normalizeAddedChangelogSection('', `* new ${EM} entry\n`)).toBe(
      '* new: entry\n'
    );
  });

  it('normalises the whole file when the generator rewrote history', () => {
    expect(
      normalizeAddedChangelogSection(
        `* old ${EM} entry\n`,
        `* rebuilt ${EM} file\n`
      )
    ).toBe('* rebuilt: file\n');
  });

  it('is applied by prepare before the prepared release is verified', () => {
    const source = readFileSync(
      path.join(repoRoot, 'scripts', 'release.mjs'),
      'utf8'
    );
    const normalizeAt = source.indexOf('normalizeAddedChangelogSection(');
    const verifyAt = source.indexOf('verifyPreparedRelease(version, branch);');
    expect(normalizeAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(normalizeAt);
    expect(source).toContain("run('git', ['commit', '--amend', '--no-edit']);");
  });
});
