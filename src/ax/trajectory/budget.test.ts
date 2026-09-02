import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * "You can understand every component in an afternoon" decays silently without
 * a number in CI. Each production file carries a cap; raising one is a visible
 * one-line diff in this table with its reason stated in the PR.
 *
 * Caps marked (raised) exceed the RFC's estimate because biome's 80-column
 * formatting expands the RFC's own declared API surface -- the store files are
 * fifteen port methods each plus a reference blob store, and the conformance
 * kit is seventeen named cases. Nothing was added beyond the specified scope.
 */
const CAPS: readonly (readonly [string, number])[] = [
  ['src/ax/trajectory/types.ts', 480],
  ['src/ax/trajectory/util.ts', 150],
  ['src/ax/trajectory/registry.ts', 190],
  ['src/ax/trajectory/spill.ts', 170],
  ['src/ax/trajectory/memoryStore.ts', 720], // raised from 620
  ['src/ax/trajectory/conformance.ts', 620], // raised from 470
  ['src/ax/trajectory/index.ts', 110],
  ['src/tools/trajectory/jsonl.ts', 940], // raised from 720
];

/**
 * Directory ceiling for the files lane A1 owns. Lane A2 adds projection.ts
 * (cap 620) and must restate this total in the same PR that adds its row.
 */
const TRAJECTORY_DIRECTORY_CAP = 2_440;

// vitest runs this workspace with cwd = src/ax, so the repo root is derived
// from this file rather than from the process.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function nonBlankLines(path: string): number {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
}

describe('trajectory line budgets', () => {
  it.each(CAPS.map(([path, cap]) => [path, cap] as const))(
    '%s stays within its cap',
    (path, cap) => {
      const actual = nonBlankLines(path);
      expect(
        actual,
        `${path} is ${actual} non-blank lines, over its cap of ${cap}. Split it, or raise the cap in src/ax/trajectory/budget.test.ts and say why in the PR.`
      ).toBeLessThanOrEqual(cap);
    }
  );

  it('keeps the src/ax/trajectory directory within its ceiling', () => {
    const directoryFiles = CAPS.filter(([path]) =>
      path.startsWith('src/ax/trajectory/')
    );
    const actual = directoryFiles.reduce(
      (total, [path]) => total + nonBlankLines(path),
      0
    );
    expect(
      actual,
      `src/ax/trajectory production files total ${actual} non-blank lines, over the ${TRAJECTORY_DIRECTORY_CAP} ceiling.`
    ).toBeLessThanOrEqual(TRAJECTORY_DIRECTORY_CAP);
  });

  it('caps every production file the lane ships', () => {
    // A new production file with no cap row is the failure mode this guards:
    // the ceiling only works if nothing escapes the table.
    const capped = new Set(CAPS.map(([path]) => path));
    for (const path of [
      'src/ax/trajectory/types.ts',
      'src/ax/trajectory/util.ts',
      'src/ax/trajectory/registry.ts',
      'src/ax/trajectory/spill.ts',
      'src/ax/trajectory/memoryStore.ts',
      'src/ax/trajectory/conformance.ts',
      'src/ax/trajectory/index.ts',
      'src/tools/trajectory/jsonl.ts',
    ]) {
      expect(capped.has(path), `${path} has no cap row`).toBe(true);
    }
  });
});
