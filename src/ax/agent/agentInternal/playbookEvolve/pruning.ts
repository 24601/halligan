/**
 * REMOVE / DEPRECATE proposals for `agent.playbook().evolve()`.
 *
 * A removal is a mutation, and this subsystem gates mutations. Until now the
 * only mutation with a receipt was an ADD: a bullet could be deleted by the
 * curator, by a lifecycle write, by a supersede, or — with no model involvement
 * and no receipt at all — by section-overflow eviction on the *add* path. This
 * module makes a deliberate removal a first-class candidate that pays the same
 * price as an addition: the same re-evaluation, the same retention receipt, the
 * same gate chain, plus a leave-one-out held-out reading and a rendered-size
 * reduction it must actually deliver.
 *
 * Three things here are deliberately NOT reuse:
 *
 *  1. `applyPrune` is a new mutation primitive. `applyProposal` applies through
 *     the ACE *curator* (`handle.update(...)`), which is an LLM round-trip that
 *     cannot express "delete bullet X". A prune transforms a snapshot and loads
 *     it, which means the validation, the stats recompute and the artifact
 *     history append that the curate path gets for free have to be done here
 *     explicitly. Each one is replaced below, and the omission of the dedupe
 *     pass is deliberate and stated.
 *  2. The gate chain runs in its PRUNE VARIANT (`gates.ts`). A removal cannot
 *     raise the current-task mean by `minCurrentGain`, so the curate variant
 *     would short-circuit every prune before `prune_size` was ever read — i.e.
 *     the whole mechanism would ship inert.
 *  3. Without a variance band the only bullets this sweep will propose are ones
 *     whose removal *measurably helps*. An interval that contains zero is
 *     "unresolved", not "redundant": with no noise floor to compare against,
 *     calling an unresolved reading redundant would be the exact over-claim this
 *     RFC exists to remove. Configure `varianceBand` to make `redundant`
 *     reachable.
 */

import {
  clonePlaybook,
  estimateTokenCount,
  isBulletApplicable,
  recomputePlaybookStats,
  renderPlaybook,
} from '../../../dsp/optimizers/acePlaybook.js';
import type {
  AxACEBullet,
  AxACECuratorOperation,
  AxACEOptimizationArtifact,
  AxACEPlaybook,
} from '../../../dsp/optimizers/aceTypes.js';
import type { AxPlaybookSnapshot } from '../../../dsp/playbook.js';
import type {
  AxAgentPlaybookInterval,
  AxAgentPlaybookPruneOperation,
  AxAgentPlaybookPruneProposal,
  AxAgentPlaybookPruneTrigger,
  AxAgentPlaybookRedundancyEntry,
} from './playbookEvidenceTypes.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import type { AxAgentPlaybookEvolveProposal } from './playbookEvolveTypes.js';
import type { AxAppliedProposal } from './proposals.js';

/** Leave-one-out ablations per run. Each one costs a held-out evaluation. */
export const PRUNE_DEFAULT_MAX_ABLATIONS = 8;
/** A prune that frees fewer rendered tokens than this is not worth the risk. */
export const PRUNE_DEFAULT_MIN_TOKEN_REDUCTION = 1;
/** "Do not get worse" — a prune's null hypothesis, not "gain five points". */
export const PRUNE_DEFAULT_MAX_CURRENT_LOSS = 0;
/**
 * `deprecate` is the default because it is reversible and auditable: the bullet
 * stays in the snapshot with `lifecycle.status`, and `isBulletApplicable` drops
 * it from every render anyway, so the rendered-token reduction is identical to
 * a delete. A caller that wants the bytes gone asks for `'remove'`.
 */
export const PRUNE_DEFAULT_OPERATION: AxAgentPlaybookPruneOperation =
  'deprecate';

/**
 * A prune's history entry does not come from a compile epoch: there is no
 * training loop, no epoch counter and no example index behind it. `-1` is the
 * artifact history's "not from a compile pass" sentinel, named here so a future
 * consumer does arithmetic on the number only after reading what it means.
 */
const PRUNE_HISTORY_EPOCH = -1;
const PRUNE_HISTORY_EXAMPLE_INDEX = -1;

const pruneFailure = (message: string, cause?: unknown): never => {
  throw new AxAgentPlaybookEvolveError(
    'prune_apply_failed',
    'candidate_eval',
    message,
    cause === undefined ? undefined : { cause }
  );
};

/** Rendered size of a playbook, measured the way ACE measures it. */
export function renderedTokensOf(
  playbook: Readonly<AxACEPlaybook>,
  nowIso: string
): number {
  return estimateTokenCount(renderPlaybook(playbook, { now: nowIso }));
}

export type AxPruneBulletRef = Readonly<{
  bullet: AxACEBullet;
  section: string;
}>;

/**
 * Bullets the current render actually emits, ranked least-valuable first:
 * `(helpfulCount asc, harmfulCount desc, updatedAt asc)`.
 *
 * Restricted to *rendered* bullets on purpose. A bullet that is already
 * deprecated, expired or inapplicable costs zero rendered tokens, so proposing
 * its removal would spend a held-out evaluation to free nothing — and would
 * make the `prune_size` gate reject it anyway.
 */
export function pruneCandidateRanking(
  playbook: Readonly<AxACEPlaybook>,
  nowIso: string
): readonly AxPruneBulletRef[] {
  const refs: AxPruneBulletRef[] = [];
  for (const [section, bullets] of Object.entries(playbook.sections ?? {})) {
    for (const bullet of bullets ?? []) {
      if (!isBulletApplicable(bullet, { now: nowIso })) continue;
      refs.push({ bullet, section });
    }
  }
  return refs.sort((a, b) => {
    const helpful = (a.bullet.helpfulCount ?? 0) - (b.bullet.helpfulCount ?? 0);
    if (helpful !== 0) return helpful;
    const harmful = (b.bullet.harmfulCount ?? 0) - (a.bullet.harmfulCount ?? 0);
    if (harmful !== 0) return harmful;
    const aAt = Date.parse(a.bullet.updatedAt ?? a.bullet.createdAt ?? '');
    const bAt = Date.parse(b.bullet.updatedAt ?? b.bullet.createdAt ?? '');
    const aTime = Number.isFinite(aAt) ? aAt : Number.POSITIVE_INFINITY;
    const bTime = Number.isFinite(bAt) ? bAt : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.bullet.id.localeCompare(b.bullet.id);
  });
}

export type AxPruneChange = Readonly<{
  bulletId: string;
  section: string;
  before: AxACEBullet;
  after?: AxACEBullet;
}>;

export type AxPruneTransform = Readonly<{
  playbook: AxACEPlaybook;
  changes: readonly AxPruneChange[];
}>;

/**
 * The transform itself: clone, delete or deprecate, validate, recompute stats.
 *
 * VALIDATION IS THE POINT. This bypasses `applyCuratorOperations`, so nothing
 * else checks that the ids existed, that they were unique, or that the surviving
 * bullets are still structurally sound. `isBulletApplicable(bullet, {
 * includeInactive: true })` is exactly the structural predicate — id/section/
 * content strings plus structurally valid evidence — with the lifecycle and
 * applicability filters short-circuited, so a deprecated bullet still has to
 * pass it.
 *
 * The content dedupe pass is NOT run, deliberately: removing bullets and setting
 * a lifecycle status cannot create a duplicate, so running it would be work with
 * no reachable effect.
 */
export function transformPlaybookForPrune(args: {
  playbook: Readonly<AxACEPlaybook>;
  bulletIds: readonly string[];
  operation: AxAgentPlaybookPruneOperation;
  reason: string;
  nowIso: string;
}): AxPruneTransform {
  const { operation, reason, nowIso } = args;
  if (args.bulletIds.length === 0) {
    pruneFailure('a prune proposal named no bullets.');
  }
  const seen = new Set<string>();
  for (const id of args.bulletIds) {
    if (typeof id !== 'string' || id.length === 0) {
      pruneFailure('a prune proposal named a non-string bullet id.');
    }
    if (seen.has(id)) {
      pruneFailure(`prune proposal names bullet '${id}' more than once.`);
    }
    seen.add(id);
  }
  const next = clonePlaybook(args.playbook);
  const changes: AxPruneChange[] = [];
  const remaining = new Set(seen);
  for (const [section, bullets] of Object.entries(next.sections ?? {})) {
    if (!Array.isArray(bullets)) continue;
    for (let index = bullets.length - 1; index >= 0; index--) {
      const bullet = bullets[index]!;
      if (!remaining.has(bullet.id)) continue;
      remaining.delete(bullet.id);
      const before = structuredClone(bullet);
      if (operation === 'remove') {
        bullets.splice(index, 1);
        changes.push({ bulletId: bullet.id, section, before });
        continue;
      }
      bullet.evidence = {
        ...(bullet.evidence ?? {}),
        lifecycle: {
          ...(bullet.evidence?.lifecycle ?? {}),
          status: 'deprecated',
          reason,
        },
      };
      bullet.updatedAt = nowIso;
      changes.push({
        bulletId: bullet.id,
        section,
        before,
        after: structuredClone(bullet),
      });
    }
  }
  if (remaining.size > 0) {
    pruneFailure(
      `prune proposal names bullet id(s) that are not in the playbook: ${[...remaining].sort().join(', ')}.`
    );
  }
  for (const bullets of Object.values(next.sections ?? {})) {
    for (const bullet of bullets ?? []) {
      if (!isBulletApplicable(bullet, { includeInactive: true })) {
        pruneFailure(
          `the pruned playbook failed structural validation at bullet '${String(bullet?.id)}'; the transform was not applied.`
        );
      }
    }
  }
  recomputePlaybookStats(next);
  return { playbook: next, changes: changes.reverse() };
}

/**
 * Verdict for one leave-one-out reading.
 *
 * `bandSpread` is the unchanged-artifact noise floor. Without one it is zero, so
 * an interval that contains zero reads `unresolved` rather than `redundant` and
 * the bullet is never proposed. That is the conservative direction: "we could
 * not tell" must not be reported as "it does nothing".
 */
export function redundancyVerdictOf(args: {
  heldOutDelta: number;
  interval: Readonly<AxAgentPlaybookInterval>;
  bandSpread?: number;
}): AxAgentPlaybookRedundancyEntry['verdict'] {
  const band = args.bandSpread ?? 0;
  if (args.interval.direction === 'negative') return 'load_bearing';
  if (args.interval.direction === 'positive') return 'harmful';
  return Math.abs(args.heldOutDelta) <= band ? 'redundant' : 'unresolved';
}

/** A bullet whose removal was shown to help, or shown to cost nothing. */
export function isPrunableVerdict(
  verdict: AxAgentPlaybookRedundancyEntry['verdict']
): boolean {
  return verdict === 'redundant' || verdict === 'harmful';
}

export type AxPruneThresholds = Readonly<{
  maxCurrentLoss: number;
  maxHeldOutLoss: number;
  minTokenReduction: number;
}>;

/**
 * The overflow set: the smallest prefix of the prunable readings, in ranking
 * order, whose removal actually brings the render back under the ceiling.
 *
 * THE PREFIX IS THE POINT. A size budget asks for the bytes back, not for every
 * bullet the sweep was able to call redundant. Proposing all of them would spend
 * capability the budget never asked for — a playbook 20 tokens over its ceiling
 * with three prunable bullets worth 300 would lose all three. `entries` arrive
 * in the sweep's ranking order (`helpfulCount asc, harmfulCount desc, updatedAt
 * asc`), so walking that order removes the least valuable bullet first and stops
 * the moment the ceiling is met.
 *
 * Measured against the REAL render after each addition rather than against a sum
 * of per-bullet estimates: `renderPlaybook` emits section headers and per-bullet
 * prefixes, so removing the last bullet of a section frees more than the bullet
 * costs, and a sum would systematically under-remove.
 *
 * Returns every prunable id when no prefix reaches the ceiling — the budget then
 * cannot be met, and holding bullets back would free less than the caller asked
 * for while still paying the whole risk.
 */
export function pruneOverflowSet(args: {
  entries: readonly AxAgentPlaybookRedundancyEntry[];
  playbook: Readonly<AxACEPlaybook>;
  operation: AxAgentPlaybookPruneOperation;
  maxRenderedTokens: number;
  nowIso: string;
}): ReadonlySet<string> {
  const prunable = args.entries
    .filter((entry) => isPrunableVerdict(entry.verdict))
    .map((entry) => entry.bulletId);
  const accumulated: string[] = [];
  for (const bulletId of prunable) {
    accumulated.push(bulletId);
    const projected = renderedTokensOf(
      transformPlaybookForPrune({
        playbook: args.playbook,
        bulletIds: accumulated,
        operation: args.operation,
        reason: 'rendered-size overflow projection',
        nowIso: args.nowIso,
      }).playbook,
      args.nowIso
    );
    if (projected <= args.maxRenderedTokens) break;
  }
  return new Set(accumulated);
}

/**
 * One proposal per operation, over every prunable bullet, ordered by descending
 * rendered size so the largest saving is named first in the rationale.
 *
 * A `load_bearing` or `unresolved` bullet is never proposed — that filter is the
 * whole leave-one-out gate, and a caller cannot turn it off.
 */
export function selectPruneProposals(args: {
  entries: readonly AxAgentPlaybookRedundancyEntry[];
  playbook: Readonly<AxACEPlaybook>;
  operation: AxAgentPlaybookPruneOperation;
  trigger: AxAgentPlaybookPruneTrigger;
  thresholds: AxPruneThresholds;
  nowIso: string;
  /** Restricts the proposal to the overflow set when the size budget fired. */
  restrictTo?: ReadonlySet<string>;
}): readonly AxAgentPlaybookPruneProposal[] {
  const prunable = args.entries
    .filter((entry) => isPrunableVerdict(entry.verdict))
    .filter((entry) => !args.restrictTo || args.restrictTo.has(entry.bulletId))
    .sort((a, b) => b.renderedTokens - a.renderedTokens);
  if (prunable.length === 0) return [];
  const bulletIds = prunable.map((entry) => entry.bulletId);
  const renderedTokensBefore = renderedTokensOf(args.playbook, args.nowIso);
  const renderedTokensAfter = renderedTokensOf(
    transformPlaybookForPrune({
      playbook: args.playbook,
      bulletIds,
      operation: args.operation,
      reason: 'rendered-size projection',
      nowIso: args.nowIso,
    }).playbook,
    args.nowIso
  );
  const reason = `${args.operation} ${bulletIds.length} bullet(s) with no measured held-out cost (${prunable
    .map(
      (entry) =>
        `${entry.bulletId}: ${entry.verdict} ${entry.heldOutDelta.toFixed(3)}`
    )
    .join('; ')})`;
  return [
    {
      pruneId: `prune-${args.operation}-${bulletIds.join('_')}`,
      operation: args.operation,
      bulletIds,
      trigger: args.trigger,
      reason,
      renderedTokensBefore,
      renderedTokensAfter,
      // The retention receipt's `thresholds.minCurrentGain` describes the
      // retention POLICY. These are the thresholds this prune was actually
      // judged by, so a reader of the outcome cannot confuse the two.
      appliedThresholds: {
        maxCurrentLoss: args.thresholds.maxCurrentLoss,
        maxHeldOutLoss: args.thresholds.maxHeldOutLoss,
        minTokenReduction: args.thresholds.minTokenReduction,
      },
    },
  ];
}

function pruneOperationsFor(
  proposal: Readonly<AxAgentPlaybookPruneProposal>,
  changes: readonly AxPruneChange[]
): AxACECuratorOperation[] {
  return changes.map((change) => ({
    type: proposal.operation === 'remove' ? 'REMOVE' : 'UPDATE',
    section: change.section,
    bulletId: change.bulletId,
    metadata: {
      axPrune: proposal.operation,
      axPruneId: proposal.pruneId,
      axPruneTrigger: proposal.trigger,
    },
  }));
}

/**
 * Apply a prune and return its exact rollback.
 *
 * THE HISTORY APPEND IS LOAD-BEARING, not bookkeeping. On the curate path
 * `AxAppliedProposal.bulletIds` is derived from the artifact-history delta; a
 * prune applied by a bare `load()` appends no entry, so the derived list would
 * be empty and the accept path's `recordEvidence(applied.bulletIds, …)` would
 * stamp nothing — leaving an accepted removal with no verification receipt
 * anywhere, which is precisely the audit gap this gate exists to close. The
 * entry is appended with `updatedBulletIds` AND the ids are set explicitly on
 * the returned value, so neither derivation can regress silently.
 *
 * The pre-transform evidence stamp exists for the same reason in the other
 * direction: for `operation: 'remove'` the bullets do not exist after the
 * transform, so a stamp written afterwards has nowhere to land. It is written
 * before the transform, on the live pre-transform state, and is therefore
 * captured into the snapshot the transform is built from. A rejected prune
 * rolls the whole thing back, stamp included.
 */
export function applyPrune(args: {
  handle: any;
  proposal: AxAgentPlaybookPruneProposal;
  legacyProposal: AxAgentPlaybookEvolveProposal;
  nowIso: string;
}): AxAppliedProposal {
  const { handle, proposal, nowIso } = args;
  if (!handle?.getState || !handle?.load) {
    pruneFailure(
      'no playbook handle capable of a snapshot transform is available.'
    );
  }
  const snapshot = handle.getState() as AxPlaybookSnapshot;
  if (!snapshot?.playbook) {
    pruneFailure('the playbook handle produced no state to prune.');
  }
  const rollback = () => {
    handle.load(snapshot);
  };
  try {
    // Written BEFORE the transform so a removal's stamp has a bullet to land
    // on. Harmless for `deprecate`, where the accept path stamps again on the
    // surviving bullet.
    handle.recordEvidence?.(proposal.bulletIds, {
      source: 'agent-evolve',
      sourceRunId: proposal.pruneId,
      feedbackIds: [proposal.pruneId],
    });
    const stamped = handle.getState() as AxPlaybookSnapshot;
    const transform = transformPlaybookForPrune({
      playbook: stamped.playbook,
      bulletIds: proposal.bulletIds,
      operation: proposal.operation,
      reason: proposal.reason,
      nowIso,
    });
    const artifact: AxACEOptimizationArtifact = {
      ...stamped.artifact,
      history: [
        ...(stamped.artifact?.history ?? []),
        {
          source: 'agent-evolve',
          epoch: PRUNE_HISTORY_EPOCH,
          exampleIndex: PRUNE_HISTORY_EXAMPLE_INDEX,
          operations: pruneOperationsFor(proposal, transform.changes),
          updatedBulletIds: [...proposal.bulletIds],
          changes: transform.changes.map((change) => ({
            bulletId: change.bulletId,
            before: change.before,
            ...(change.after ? { after: change.after } : {}),
          })),
        },
      ],
    };
    handle.load({ playbook: transform.playbook, artifact });
    return {
      proposal: args.legacyProposal,
      bulletIds: [...proposal.bulletIds],
      rollback,
    };
  } catch (applicationError) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new AxAgentPlaybookEvolveError(
        'prune_apply_failed',
        'candidate_eval',
        'prune application failed and exact rollback also failed.',
        {
          cause: new AggregateError(
            [applicationError, rollbackError],
            'AxAgent.playbook().evolve(): prune application failed and exact rollback also failed.'
          ),
        }
      );
    }
    throw applicationError;
  }
}
