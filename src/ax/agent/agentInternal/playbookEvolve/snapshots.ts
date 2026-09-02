/**
 * The baseline/evolved snapshot state machine for `agent.playbook().evolve()`.
 *
 * A matched-budget control arm has to run *on the unevolved program*, but by
 * the time it runs the curate loop has already mutated the live playbook.
 * Nothing in the pre-evidence code could put it back: `AxAppliedProposal`'s
 * rollback is restore-only with no redo, and the orchestrator captured no
 * pre-run snapshot at all — `getState()` was called exactly once, at the very
 * end, and only when something was accepted. Asserting that an arm "ran against
 * the unevolved program" without this machinery would test an outcome whose
 * mechanism did not exist.
 *
 * So the run captures two states:
 *
 *   phase 0  baselineSnapshot — ALWAYS, even with zero accepts, because an arm
 *            must never have to reconstruct a state that no longer exists.
 *   phase 7  evolvedSnapshot  — after the curate loop, before any run-level
 *            phase can disturb it.
 *
 * and phase 9 brackets its work in
 * `load(baseline) … finally load(evolved)`, asserting the canonical digest on
 * both sides. The digest assertions are the point: a silent partial restore
 * would make every control-arm number meaningless while the run looked
 * perfectly healthy.
 *
 * Digests are computed HERE, at bracket time, and never on the legacy path. A
 * snapshot is a JSON round-trip of the ACE playbook (`clonePlaybook`) so
 * `canonicalDigest` cannot throw on it, but computing one on every legacy run
 * would spend work no legacy caller asked for.
 */

import type { AxPlaybookSnapshot } from '../../../dsp/playbook.js';
import { canonicalDigest } from './canonical.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';

/** The slice of a playbook handle the state machine needs. */
export type AxSnapshotHandle = {
  getState?: () => AxPlaybookSnapshot;
  load?: (snapshot: Readonly<AxPlaybookSnapshot>) => unknown;
};

/** A captured artifact state plus the digest every restore is checked against. */
export type AxSnapshotState = Readonly<{
  snapshot: AxPlaybookSnapshot;
  digest: string;
}>;

/**
 * Capture the live artifact. Defensive by construction: this runs on EVERY
 * run, including legacy ones that configured no evidence at all, so a handle
 * that cannot produce a state must not turn a working call into a throw. The
 * absence then surfaces as a control arm that reports `failed` with a reason,
 * which fails closed under a required gate.
 */
export function captureSnapshot(
  handle: AxSnapshotHandle | undefined
): AxPlaybookSnapshot | undefined {
  try {
    return handle?.getState?.();
  } catch {
    return undefined;
  }
}

/** Pair a captured snapshot with its canonical digest. */
export function snapshotStateOf(
  snapshot: Readonly<AxPlaybookSnapshot>
): AxSnapshotState {
  return {
    snapshot: snapshot as AxPlaybookSnapshot,
    digest: canonicalDigest(snapshot),
  };
}

export type AxRestoredArtifactOutcome<T> =
  | Readonly<{ status: 'ran'; value: T }>
  /**
   * The artifact could not be put into the requested state, so the body never
   * ran. The live artifact is back where it started and the run continues —
   * reach for a restore failure, not for a fabricated measurement.
   */
  | Readonly<{ status: 'restore_failed'; reason: string; cause: unknown }>;

function digestOf(handle: AxSnapshotHandle): string {
  const state = handle.getState?.();
  if (!state) {
    throw new Error('the playbook handle produced no state to digest');
  }
  return canonicalDigest(state);
}

function loadAndVerify(
  handle: AxSnapshotHandle,
  target: AxSnapshotState,
  label: string
): void {
  handle.load?.(target.snapshot);
  const observed = digestOf(handle);
  if (observed !== target.digest) {
    throw new Error(
      `the ${label} artifact digest after load is ${observed}, not the captured ${target.digest}; the restore was partial`
    );
  }
}

/**
 * `load(restoreTo)` → run → `finally load(returnTo)`, with a digest assertion
 * on both sides and ONE bounded retry of the return restore.
 *
 * Failure semantics, which are the whole reason this is a named mechanism:
 *
 *  - the restore INTO `restoreTo` throws before mutating anything → the body
 *    never runs, the live artifact is untouched, and the caller gets
 *    `restore_failed`. `load` is atomic from a caller's view (hydrate then
 *    inject), so this really does leave the evolved artifact intact.
 *  - the restore into `restoreTo` lands but its digest does not match → the
 *    artifact HAS been mutated, so the return restore runs before
 *    `restore_failed` is reported.
 *  - the return restore fails twice → `control_arm_failed`, with an
 *    `AggregateError` cause, both digests named, and `evolvedSnapshot` carried
 *    ON THE ERROR. This path leaves the agent in the baseline state while the
 *    result would have described the evolved one, which is strictly worse than
 *    the pre-evidence failure mode; the snapshot rides along so the caller can
 *    recover with a single `getPlaybook()?.load(...)`.
 */
export async function withRestoredArtifact<T>(args: {
  handle: AxSnapshotHandle;
  restoreTo: AxSnapshotState;
  returnTo: AxSnapshotState;
  run: () => Promise<T>;
}): Promise<AxRestoredArtifactOutcome<T>> {
  const { handle, restoreTo, returnTo } = args;
  let mutated = false;
  try {
    handle.load?.(restoreTo.snapshot);
    mutated = true;
    const observed = digestOf(handle);
    if (observed !== restoreTo.digest) {
      throw new Error(
        `the baseline artifact digest after load is ${observed}, not the captured ${restoreTo.digest}; the restore was partial`
      );
    }
  } catch (error) {
    if (mutated) {
      returnOrThrow(handle, restoreTo, returnTo, []);
    }
    return {
      status: 'restore_failed',
      reason: `the unevolved playbook could not be restored: ${messageOf(error)}`,
      cause: error,
    };
  }

  let value: T;
  try {
    value = await args.run();
  } catch (error) {
    returnOrThrow(handle, restoreTo, returnTo, [error]);
    throw error;
  }
  returnOrThrow(handle, restoreTo, returnTo, []);
  return { status: 'ran', value };
}

function returnOrThrow(
  handle: AxSnapshotHandle,
  restoreTo: AxSnapshotState,
  returnTo: AxSnapshotState,
  priorErrors: readonly unknown[]
): void {
  const errors: unknown[] = [...priorErrors];
  // Two attempts, not a loop: a restore that fails twice is not going to
  // succeed on a third, and retrying forever would hide an indeterminate
  // artifact behind a hang.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      loadAndVerify(handle, returnTo, 'evolved');
      return;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AxAgentPlaybookEvolveError(
    'control_arm_failed',
    'control_arm',
    `the evolved playbook could not be restored after the control arm, in two attempts. The agent is left in the BASELINE state (${restoreTo.digest}) while the run describes the EVOLVED one (${returnTo.digest}); recover with one getPlaybook()?.load(...) from the playbookSnapshot carried on this error.`,
    {
      cause: new AggregateError(
        errors,
        'AxAgent.playbook().evolve(): control-arm restore failed.'
      ),
      playbookSnapshot: returnTo.snapshot,
    }
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
