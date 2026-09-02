import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  perturbFixture,
  repoRoot,
  sampleFixtures,
} from './axir-perturb-check.mjs';

// The suites conformanceSuitePaths() hands the five generated targets. Read
// from the Go source so the harness cannot silently drift from the allow-list
// the targets actually run.
function registeredCrossTargetSuites() {
  const source = readFileSync(
    path.join(repoRoot, 'tools', 'axir', 'internal', 'axir', 'verify.go'),
    'utf8'
  );
  const body = source.match(
    /func conformanceSuitePaths\([^)]*\)[^{]*\{\s*return \[\]string\{([\s\S]*?)\}/
  );
  if (!body) {
    throw new Error('could not locate conformanceSuitePaths in verify.go');
  }
  return new Set(
    [...body[1].matchAll(/filepath\.Join\(root,\s*"([^"]+)"\)/g)].map(
      (match) => match[1]
    )
  );
}

describe('perturbFixture', () => {
  it('mutates the first expected_* leaf by type', () => {
    const fixture = {
      name: 'x',
      expected_output: { answer: 'paris' },
      expected_request_count: 2,
    };
    const hit = perturbFixture(fixture);
    expect(hit.key).toBe('expected_output');
    expect(fixture.expected_output.__perturbed__).toBe(true);
    expect(fixture.expected_request_count).toBe(2);
  });

  it('mutates strings, numbers, booleans, and arrays distinctly', () => {
    for (const [value, check] of [
      ['ok', (v) => v === 'ok__PERTURBED__'],
      [3, (v) => v === 4],
      [true, (v) => v === false],
      [['a'], (v) => v.length === 2 && v[1] === '__PERTURBED__'],
    ]) {
      const fixture = { expected_thing: value };
      const hit = perturbFixture(fixture);
      expect(hit.key).toBe('expected_thing');
      expect(check(fixture.expected_thing)).toBe(true);
    }
  });

  it('finds nested expectations and reports none when absent', () => {
    const nested = { steps: [{ expected_code: 'final()' }] };
    expect(perturbFixture(nested).key).toBe('expected_code');
    expect(perturbFixture({ name: 'no-expectations' })).toBeNull();
  });
});

describe('sampleFixtures', () => {
  it('samples one fixture per suite deterministically', () => {
    const sample = sampleFixtures();
    expect(sample.length).toBeGreaterThanOrEqual(10);
    const suites = sample.map(({ suite }) => suite);
    expect(new Set(suites).size).toBe(suites.length);
    expect(sample.every(({ file }) => file.endsWith('.json'))).toBe(true);
  });

  it('samples only suites the generated targets are registered to run', () => {
    const registered = registeredCrossTargetSuites();
    expect(registered.size).toBeGreaterThan(0);
    const unregistered = sampleFixtures()
      .map(({ suite }) => suite)
      .filter((suite) => !registered.has(suite));
    // A new ir/conformance/<suite>/ directory whose fixture kind no generated
    // runner implements aborts the perturb self-test with an unknown-fixture
    // -kind error. Register the suite in conformanceSuitePaths once every
    // target handles it, or list it in TS_ONLY_SUITES until then.
    expect(unregistered).toEqual([]);
  });
});
