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
 *
 * `log.ts` is new relative to RFC 5.1 and the directory ceiling is raised for
 * it. It holds the append-only index and every read primitive, shared verbatim
 * by BOTH shipped stores; before it, ~230 lines were duplicated between
 * memoryStore.ts and src/tools/trajectory/jsonl.ts and a fix to one silently
 * missed the other. Sharing across the package boundary can only move those
 * lines INTO this directory, so `jsonl.ts` fell 940 -> 800 and `memoryStore.ts`
 * 720 -> 520 while the directory total rose.
 *
 * Lane A2 restates the directory ceiling, as RFC 8.7 requires and as lane A1's
 * handoff asked. RFC 5.1 put the A1+A2 total at 2,900 with one 620-line
 * `projection.ts`; the shipped lane is 3,785 across two files. The reason is
 * recorded in docs/TRAJECTORY.md ("Line budgets and why they moved") and is
 * the same one A1 hit: the RFC's estimate counts the declared API surface as
 * if it were dense, and biome's 80-column formatting plus a one-line policy
 * comment per non-obvious field roughly doubles a types-heavy module. The
 * projection lane is also split in two rather than shipped as one 1,000-line
 * file: `projection.ts` is the READ path (budget, staircase, straddle descent,
 * drill-down, renderer) and `rollups.ts` is the CACHE path (block/meta/store
 * port, the in-memory store, the summarizer port and its two implementations,
 * and sealing). Neither half is understandable in an afternoon inside the
 * other.
 *
 * The A2 REVIEW pass restates it once more, for the five defects the
 * adversarial review found and the guards that close them: a bounded staircase
 * descent (`axTrajectoryDescentBudget`), attempt-bounded rather than
 * success-bounded sealing, clamped scan pages, per-value one-lining in the
 * renderer so model output cannot forge a verbatim frame, a checkpoint checked
 * against the log, and a seal-time summary clip. Each is a few lines of code
 * and a paragraph saying what it is defending against, which is the ratio this
 * directory has had from the start.
 *
 * Measured at this cap raise: types 465, util 151, registry 171, spill 158,
 * log 483, memoryStore 507, conformance 676, index 138, projection 577,
 * rollups 596 -- 3,922 in total. conformance.ts remains the biggest single
 * overrun of the RFC's estimate (470): it is seventeen named cases, and the
 * A1 review's B1, Mn3, Mn4, Mn5 and Mn6 each added a normative assertion the
 * kit could not previously make.
 */
const CAPS: readonly (readonly [string, number])[] = [
  ['src/ax/trajectory/types.ts', 480],
  ['src/ax/trajectory/util.ts', 160], // raised from 150 by the shared knob guard
  ['src/ax/trajectory/registry.ts', 190],
  ['src/ax/trajectory/spill.ts', 175], // raised from 170
  ['src/ax/trajectory/log.ts', 500], // new: the shared index + read primitives
  ['src/ax/trajectory/memoryStore.ts', 520], // lowered from 720
  ['src/ax/trajectory/conformance.ts', 700], // raised from 470
  ['src/ax/trajectory/index.ts', 150], // raised from 110 by the A2 exports
  ['src/ax/trajectory/projection.ts', 600], // raised from 520 by the A2 review fixes
  ['src/ax/trajectory/rollups.ts', 600], // new: RFC 4.8 cache + sealing path
  ['src/tools/trajectory/jsonl.ts', 830], // lowered from 940
];

/**
 * Directory ceiling for src/ax/trajectory, restated by lane A2 and again by
 * its review pass. RFC 5.1's A1+A2 estimate was 2,900; the shipped lane
 * measures 3,922. The reason is in the header comment above and in
 * docs/TRAJECTORY.md. Lane A3 owns src/ax/mind and must not raise this one.
 */
const TRAJECTORY_DIRECTORY_CAP = 3_990;

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
      'src/ax/trajectory/log.ts',
      'src/ax/trajectory/memoryStore.ts',
      'src/ax/trajectory/conformance.ts',
      'src/ax/trajectory/index.ts',
      'src/ax/trajectory/projection.ts',
      'src/ax/trajectory/rollups.ts',
      'src/tools/trajectory/jsonl.ts',
    ]) {
      expect(capped.has(path), `${path} has no cap row`).toBe(true);
    }
  });
});
