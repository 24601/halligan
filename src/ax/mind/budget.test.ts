import { readdirSync, readFileSync } from 'node:fs';
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
 * The runtime lane (A3.8-A3.9) adds `mind.ts`, `thinkers.ts` and three files
 * RFC 5.1 does not name, and restates the ceiling here as RFC 8.7 requires.
 * The reasons are recorded in docs/MIND.md, section "Line budgets":
 *
 * - `types.ts` 480 -> 600. The runtime commit adds the context-request record
 *   (`AxMindContextRequest`/`AxMindContextAssembler`), the whole artifact
 *   source with its change and receipt records, and the in-memory ownership
 *   store -- all of them RFC 4.9/4.10 declarations the pacing lane deferred
 *   because it had no consumer for them.
 * - `mind.ts` 600 -> 1_300. RFC 5.1 gives this file five deliverables at once
 *   ("AxMind + mind() + step orchestration + subRun + reconcile") and none of
 *   the surface they need: the options record is 90 lines on its own, the
 *   start sequence is RFC 7.10's seven steps with five typed refusals, and
 *   the context assembly carries the dead-letter path M19 depends on. Three
 *   pieces that genuinely stand alone were extracted rather than capped here:
 *   `context.ts`, `step.ts` and `subruns.ts`.
 * - `context.ts` (new, 160): the pure wake classification, the synthetic
 *   trigger and the routing-signal table. Pure functions with their own test
 *   file, so the hint policy is reviewable without the runtime.
 * - `step.ts` (new, 160): a thinker rendered as an `AxEventTarget`, plus the
 *   delegating `AxProgrammable` wrapper that brackets one run. This is the
 *   seam RFC 3.4 C4 is about, and it belongs on its own page.
 * - `subruns.ts` (new, 140): fork -> run -> merge, with the depth and spend
 *   caps and the always-merge-back guarantee (I10).
 * - `thinkers.ts` 380 -> 560: RFC 4.15 assigns it `axMindMonolith`,
 *   `axMindResponder`, `AxMindDeterministicProgram` and goal rendering; the
 *   monolith's function menu (`axMindTools`, RFC 6.5's whole model-owned
 *   list) and the prompt assembly both land here too.
 * Measured at this raise: types 571, pacer 284, health 138, routes 222,
 * sources 594, chat 768, salience 163, skills 134, context 138, step 137,
 * subruns 121, thinkers 469, mind 1_255, index 168.
 */
const CAPS: readonly (readonly [string, number])[] = [
  ['src/ax/mind/types.ts', 600], // raised from 430, then 480
  ['src/ax/mind/pacer.ts', 300], // raised from 200, then 270
  ['src/ax/mind/health.ts', 150], // raised from 130
  ['src/ax/mind/routes.ts', 250],
  ['src/ax/mind/sources.ts', 610], // raised from 330, then 560
  ['src/ax/mind/chat.ts', 800], // raised from 280, then 680
  ['src/ax/mind/salience.ts', 180], // raised from 130
  ['src/ax/mind/skills.ts', 150],
  ['src/ax/mind/context.ts', 160], // new: not in RFC 5.1
  ['src/ax/mind/step.ts', 160], // new: not in RFC 5.1
  ['src/ax/mind/subruns.ts', 140], // new: not in RFC 5.1
  ['src/ax/mind/thinkers.ts', 560], // raised from 380
  ['src/ax/mind/mind.ts', 1_300], // raised from 600
  ['src/ax/mind/index.ts', 175], // raised from 90, then 120, then 130
];

/**
 * Directory ceiling for the whole subsystem. RFC 5.1 estimated 2,970 against
 * a 3,050 ceiling; the measured total with every file the RFC assigns to this
 * directory is higher for the per-file reasons above. Raising it again needs
 * the same treatment: a reason per file, here and in docs/MIND.md.
 */
const MIND_DIRECTORY_CAP = 5_335;

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
    // Read from disk rather than listed by hand: a new production file with
    // no cap row is exactly the escape the ceiling cannot survive.
    const shipped = readdirSync(join(REPO_ROOT, 'src/ax/mind'))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .map((name) => `src/ax/mind/${name}`)
      .sort();
    expect(shipped.length).toBeGreaterThan(10);
    for (const path of shipped) {
      expect(capped.has(path), `${path} has no cap row`).toBe(true);
    }
    // And no cap row names a file that is gone.
    for (const [path] of CAPS) {
      expect(shipped, `${path} has a cap row but no file`).toContain(path);
    }
  });
});
