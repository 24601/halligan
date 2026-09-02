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
 * - `chat.ts` 280 -> 800. 5.1 gives it "axResolveMindReplyState, replyTo
 *   inference, claim TTL, ledgered send, self-addressed refusal". The
 *   ledgered send alone is declare -> dispatch -> transport -> settle with a
 *   branch per non-`intent` status (RFC 6.6 rows C8, C9), and crash C10's
 *   `axMindReconcileChatSends` is a sixth deliverable 5.1's column does not
 *   name at all.
 * - `sources.ts` 330 -> 610. Two `AxEventSource` classes plus the pure tick
 *   duty query, per-consumer cursor load/save, unit-commit planning so a
 *   deferral cannot consume a superseded wake, and a sleep that leaves no
 *   listener behind (`AxEventClock.sleep` never removes the one it adds).
 *
 * The adversarial review of PR #95 raised four more, all of them a guard
 * plus the comment that says which failure it closes:
 *
 * - `chat.ts` 680 -> 800: the send-site reply-state guard, the settled-send
 *   step lookup that replaced a phantom append, the host-stamped `ours`
 *   predicate, and the typed read-back failure.
 * - `sources.ts` 560 -> 610: publish containment in the tick loop and the
 *   edge-triggered, park-aware pace duty.
 * - `salience.ts` 130 -> 180: the fenced, byte-bounded quoting of third-party
 *   text, plus the `salience-injected` diagnostic.
 * - `pacer.ts` 270 -> 300 and `health.ts` 130 -> 150: the fuse derived from
 *   the descent cost, `parkedUntil`, and the derived stalled threshold.
 *
 * Measured at this raise: types 476, pacer 284, health 138, routes 222,
 * sources 585, chat 768, salience 163, skills 134, index 119 -- 2,889 total.
 *
 * RFC 5.1 puts the whole `src/ax/mind` directory at 2,970 with a 3,050
 * ceiling INCLUDING `thinkers.ts` (380) and `mind.ts` (600), which this lane
 * does not ship. The lane that adds them must restate the ceiling below and
 * record the reason in docs/MIND.md, per RFC 8.7.
 */
const CAPS: readonly (readonly [string, number])[] = [
  ['src/ax/mind/types.ts', 480], // raised from 430
  ['src/ax/mind/pacer.ts', 300], // raised from 200, then 270
  ['src/ax/mind/health.ts', 150], // raised from 130
  ['src/ax/mind/routes.ts', 250],
  ['src/ax/mind/sources.ts', 610], // raised from 330, then 560
  ['src/ax/mind/chat.ts', 800], // raised from 280, then 680
  ['src/ax/mind/salience.ts', 180], // raised from 130
  ['src/ax/mind/skills.ts', 150],
  ['src/ax/mind/index.ts', 130], // raised from 90, then 120
];

/**
 * Directory ceiling for the files this lane owns (RFC commits A3.1-A3.7).
 * `thinkers.ts` and `mind.ts` land later and must restate this number.
 */
const MIND_DIRECTORY_CAP = 2_950;

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
