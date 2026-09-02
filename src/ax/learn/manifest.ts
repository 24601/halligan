/**
 * The failure manifest: what broke last step, what is still broken, and what
 * got fixed — the one piece of state a proposer is given about its own
 * previous attempts.
 *
 * Causes are normalized before they are fingerprinted or stored. That is not
 * only about grouping: rule 2 replaces every 16-character-or-longer identifier
 * run, which is what keeps key material and tokens out of a manifest that
 * travels into a model prompt and, through the gate metrics, onto the release
 * chain.
 */

import { axEventCanonicalDigest } from '../event/util.js';
import type {
  AxHarnessFailureAdvance,
  AxHarnessFailureEntry,
  AxHarnessFailureManifest,
  AxHarnessFailureObservation,
} from './types.js';

const MAX_CAUSE_CHARS = 200;

/**
 * Normalize a failure cause so two runs of the same fault share one identity.
 *
 * Applied in order: absolute-looking paths, long identifier runs, digit runs,
 * whitespace. The identifier rule is deliberately broad — a 40-character hex
 * token and a UUID both collapse to `<id>` — because a persisted cause is
 * read by a model and stored on a release.
 */
export const axNormalizeHarnessFailureCause = (cause: string): string => {
  const text = typeof cause === 'string' ? cause : String(cause);
  return text
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.\-@]+[\\/])+[\w.\-@]*/g, '<path>')
    .replace(/[A-Za-z0-9_-]{16,}/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CAUSE_CHARS);
};

/** The stable identity of one normalized failure. */
export const axHarnessFailureFingerprint = async (
  observation: Readonly<AxHarnessFailureObservation>
): Promise<string> => {
  const digest = await axEventCanonicalDigest([
    observation.taskId,
    observation.stage,
    axNormalizeHarnessFailureCause(observation.cause),
  ]);
  return digest.slice(0, 16);
};

/**
 * Fold this step's observations into the manifest and classify the change.
 *
 * A fingerprint absent from the manifest is `new`, present in both is
 * `persisting`, and present before but not now is `fixed`. Fixed entries drop
 * out of the manifest: it describes the CURRENT failure set, and a recurrence
 * after a genuine fix is honestly new information for the proposer.
 *
 * Every observation passed in is folded in as given. Filtering to one `side`
 * is the caller's job and has to happen before the call, because a manifest
 * is a statement about a single tree.
 */
export const axAdvanceHarnessFailureManifest = async (
  manifest: Readonly<AxHarnessFailureManifest> | undefined,
  observations: readonly Readonly<AxHarnessFailureObservation>[],
  step: number
): Promise<Readonly<AxHarnessFailureAdvance>> => {
  const previous = new Map(
    (manifest?.entries ?? []).map((entry) => [entry.fingerprint, entry])
  );

  const current = new Map<string, AxHarnessFailureEntry>();
  for (const observation of observations) {
    const fingerprint = await axHarnessFailureFingerprint(observation);
    const cause = axNormalizeHarnessFailureCause(observation.cause);
    const prior = previous.get(fingerprint);
    const running = current.get(fingerprint);
    current.set(fingerprint, {
      fingerprint,
      taskId: observation.taskId,
      stage: observation.stage,
      cause,
      firstSeenStep: prior?.firstSeenStep ?? running?.firstSeenStep ?? step,
      lastSeenStep: step,
      count: (running?.count ?? prior?.count ?? 0) + 1,
    });
  }

  const isNew: string[] = [];
  const persisting: string[] = [];
  for (const fingerprint of current.keys()) {
    if (previous.has(fingerprint)) persisting.push(fingerprint);
    else isNew.push(fingerprint);
  }
  const fixed = [...previous.keys()].filter(
    (fingerprint) => !current.has(fingerprint)
  );

  return Object.freeze({
    manifest: Object.freeze({
      step,
      entries: Object.freeze(
        [...current.values()]
          .map((entry) => Object.freeze(entry))
          .sort((a, b) =>
            a.fingerprint < b.fingerprint
              ? -1
              : a.fingerprint > b.fingerprint
                ? 1
                : 0
          )
      ),
    }),
    new: Object.freeze(isNew.sort()),
    persisting: Object.freeze(persisting.sort()),
    fixed: Object.freeze(fixed.sort()),
  });
};
