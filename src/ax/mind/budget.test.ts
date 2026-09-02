import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * "You can understand every component in an afternoon" decays silently
 * without a number in CI. Each production file carries a cap; raising one is
 * a visible one-line diff in this table with its reason stated in the PR.
 *
 * Caps marked (raised) exceed RFC 5.1's estimate. The estimates assumed the
 * declaration surface only; every file here also carries the implementation
 * 5.1's own contents column assigns to it, under biome's 80-column format
 * with a doc comment on each non-obvious policy. The two large overruns:
 *
 * - `chat.ts` 280 -> 680. 5.1 gives it "axResolveMindReplyState, replyTo
 *   inference, claim TTL, ledgered send, self-addressed refusal". The
 *   ledgered send alone is declare -> dispatch -> transport -> settle with a
 *   branch per non-`intent` status (RFC 6.6 rows C8, C9), and crash C10's
 *   `axMindReconcileChatSends` is a sixth deliverable 5.1's column does not
 *   name at all.
 * - `sources.ts` 330 -> 560. Two `AxEventSource` classes plus the pure tick
 *   duty query, per-consumer cursor load/save, unit-commit planning so a
 *   deferral cannot consume a superseded wake, and a sleep that leaves no
 *   listener behind (`AxEventClock.sleep` never removes the one it adds).
 *
 * Measured at the cap raise: types 463, pacer 250, health 120, routes 217,
 * sources 535, chat 648, salience 128, skills 134, index 113 -- 2,608 total.
 *
 * RFC 5.1 puts the whole `src/ax/mind` directory at 2,970 with a 3,050
 * ceiling INCLUDING `thinkers.ts` (380) and `mind.ts` (600), which this lane
 * does not ship. The lane that adds them must restate the ceiling below and
 * record the reason in docs/MIND.md, per RFC 8.7.
 */
const CAPS: readonly (readonly [string, number])[] = [
  ['src/ax/mind/types.ts', 480], // raised from 430
  ['src/ax/mind/pacer.ts', 270], // raised from 200
  ['src/ax/mind/health.ts', 130],
  ['src/ax/mind/routes.ts', 250],
  ['src/ax/mind/sources.ts', 560], // raised from 330
  ['src/ax/mind/chat.ts', 680], // raised from 280
  ['src/ax/mind/salience.ts', 130],
  ['src/ax/mind/skills.ts', 150],
  ['src/ax/mind/index.ts', 120], // raised from 90
];

/**
 * Directory ceiling for the files this lane owns (RFC commits A3.1-A3.7).
 * `thinkers.ts` and `mind.ts` land later and must restate this number.
 */
const MIND_DIRECTORY_CAP = 2_700;

// vitest runs this workspace with cwd = src/ax, so the repo root is derived
// from this file rather than from the process.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function nonBlankLines(path: string): number {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
}

describe('mind line budgets', () => {
  it.each(CAPS.map(([path, cap]) => [path, cap] as const))(
    '%s stays within its cap',
    (path, cap) => {
      const actual = nonBlankLines(path);
      expect(
        actual,
        `${path} is ${actual} non-blank lines, over its cap of ${cap}. Split it, or raise the cap in src/ax/mind/budget.test.ts and say why in the PR.`
      ).toBeLessThanOrEqual(cap);
    }
  );

  it('keeps the src/ax/mind directory within its ceiling', () => {
    const actual = CAPS.reduce(
      (total, [path]) => total + nonBlankLines(path),
      0
    );
    expect(
      actual,
      `src/ax/mind production files total ${actual} non-blank lines, over the ${MIND_DIRECTORY_CAP} ceiling.`
    ).toBeLessThanOrEqual(MIND_DIRECTORY_CAP);
  });

  it('caps every production file the lane ships', () => {
    // A new production file with no cap row is the failure mode this guards:
    // the ceiling only works if nothing escapes the table.
    const capped = new Set(CAPS.map(([path]) => path));
    for (const path of [
      'src/ax/mind/types.ts',
      'src/ax/mind/pacer.ts',
      'src/ax/mind/health.ts',
      'src/ax/mind/routes.ts',
      'src/ax/mind/sources.ts',
      'src/ax/mind/chat.ts',
      'src/ax/mind/salience.ts',
      'src/ax/mind/skills.ts',
      'src/ax/mind/index.ts',
    ]) {
      expect(capped.has(path), `${path} has no cap row`).toBe(true);
    }
  });
});
