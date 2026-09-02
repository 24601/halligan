/**
 * Bounded proposal application for `agent.playbook().evolve()`.
 *
 * One surface: a curated playbook update. Rollback restores the pre-apply
 * snapshot via `load()`. (Verified learning produces only playbook bullets;
 * the standing-instruction surface lives on `agent.setInstruction()` /
 * `addActorInstruction()`, not here.)
 */

import type { AxPlaybookSnapshot } from '../../../dsp/playbook.js';
import { axPlaybookFailureSection } from '../failureReport.js';
import type {
  AxAgentPlaybookEviction,
  AxAgentPlaybookPruneProposal,
} from './playbookEvidenceTypes.js';
import type {
  AxAgentPlaybookEvolveProposal,
  AxAgentPlaybookWeakness,
} from './playbookEvolveTypes.js';

export type AxAppliedProposal = {
  proposal: AxAgentPlaybookEvolveProposal;
  bulletIds: readonly string[];
  rollback: () => void;
};

const RESTORATION_FAILURE = Symbol.for(
  '@ax-llm/ax/agent-playbook-restoration-failure'
);

/** The playbook text currently applied to the agent, fed to the miner. */
export function currentPlaybookText(agent: any): string | undefined {
  const rendered = agent.getPlaybook?.()?.render?.();
  return typeof rendered === 'string' && rendered.trim().length > 0
    ? rendered
    : undefined;
}

export function buildProposal(
  weakness: AxAgentPlaybookWeakness
): AxAgentPlaybookEvolveProposal {
  const quotes = weakness.evidenceQuotes
    .slice(0, 3)
    .map((quote) => `- ${quote}`)
    .join('\n');
  return {
    weaknessId: weakness.id,
    clusterSignature: weakness.clusterSignature,
    feedback: `A recurring agent weakness was diagnosed from real failed runs.

Weakness: ${weakness.description}
Root cause: ${weakness.rootCause}
Error signature: [${weakness.clusterSignature}]
Grounding excerpts:
${quotes}

Curate ONE durable rule into the playbook (suggested section: "${axPlaybookFailureSection}"): ${weakness.proposedGuidance}
UPDATE an existing bullet if one already covers this failure mode.`,
  };
}

/**
 * Apply a proposal to the live playbook and return its exact rollback. The
 * weakness signature is recorded on the update event so the run-end dedupe
 * ledger (`collectCoveredFailureSignatures`) stays coherent with
 * evolve()-curated lessons.
 */
export async function applyProposal(args: {
  proposal: AxAgentPlaybookEvolveProposal;
  playbookHandle: any;
}): Promise<AxAppliedProposal> {
  const { proposal, playbookHandle: handle } = args;
  if (!handle) {
    throw new Error(
      'AxAgent.playbook().evolve(): no playbook handle available.'
    );
  }
  const snapshot = handle.getState();
  try {
    await handle.update({
      example: {
        task: 'playbook.evolve(): repair a diagnosed agent weakness',
        failureSignatures: [proposal.clusterSignature],
      },
      prediction: {},
      feedback: proposal.feedback,
      evidence: {
        source: 'agent-evolve',
        sourceRunId: proposal.clusterSignature,
        feedbackIds: [proposal.weaknessId],
      },
    });
    const updated = handle.getState();
    const bulletIds: string[] = updated.artifact.history
      .slice(snapshot.artifact.history.length)
      .flatMap(
        (entry: { updatedBulletIds?: string[] }): string[] =>
          entry.updatedBulletIds ?? []
      );
    return {
      proposal,
      bulletIds: [...new Set(bulletIds)].sort(),
      rollback: () => {
        handle.load(snapshot);
      },
    };
  } catch (applicationError) {
    try {
      handle.load(snapshot);
    } catch (rollbackError) {
      const restorationError = new AggregateError(
        [applicationError, rollbackError],
        'AxAgent.playbook().evolve(): proposal update failed and exact rollback also failed.'
      );
      Object.defineProperty(restorationError, RESTORATION_FAILURE, {
        value: true,
      });
      throw restorationError;
    }
    throw applicationError;
  }
}

/**
 * The legacy `AxAgentPlaybookEvolveProposal` fields for a prune outcome.
 *
 * `AxAgentPlaybookEvolveOutcome.proposal` keeps its exact shape for BOTH kinds,
 * so every field a pre-evidence consumer reads is populated with something
 * meaningful and the truth lives in the new `kind` / `prune` fields. Turning
 * `proposal` into a discriminated union would have been cleaner and is rejected
 * because it breaks `outcome.proposal.feedback` at the type level for every
 * existing caller.
 */
export function buildPruneRationaleText(
  prune: Readonly<AxAgentPlaybookPruneProposal>
): AxAgentPlaybookEvolveProposal {
  const saved = prune.renderedTokensBefore - prune.renderedTokensAfter;
  return {
    weaknessId: prune.pruneId,
    clusterSignature: `prune:${prune.operation}`,
    feedback: `A playbook removal was proposed from leave-one-out held-out evidence.

Operation: ${prune.operation.toUpperCase()}
Trigger: ${prune.trigger}
Bullets: ${prune.bulletIds.join(', ')}
Rationale: ${prune.reason}
Rendered tokens: ${prune.renderedTokensBefore} -> ${prune.renderedTokensAfter} (${saved} freed)
Judged by: maxCurrentLoss ${prune.appliedThresholds.maxCurrentLoss}, maxHeldOutLoss ${prune.appliedThresholds.maxHeldOutLoss}, minTokenReduction ${prune.appliedThresholds.minTokenReduction}`,
  };
}

/**
 * Bullets the ACE curator evicted while applying a CURATE proposal, recovered
 * from the artifact-history delta the apply path already reads.
 *
 * This is the silent-loss channel: `pruneSectionForAddition` evicts the
 * lowest-ranked unprotected bullet on section overflow with no receipt and no
 * gate, so an accepted ADD can delete an existing bullet today. The eviction is
 * detected structurally, by the `autoPruned` marker ACE stamps on the synthetic
 * REMOVE it records — not by diffing bullet sets, which cannot tell an eviction
 * apart from a curator-requested removal.
 */
export function collectEvictions(args: {
  before: Readonly<AxPlaybookSnapshot>;
  after: Readonly<AxPlaybookSnapshot>;
  weaknessId: string;
}): readonly AxAgentPlaybookEviction[] {
  const priorLength = args.before.artifact?.history?.length ?? 0;
  const added = (args.after.artifact?.history ?? []).slice(priorLength);
  const evictions: AxAgentPlaybookEviction[] = [];
  const seen = new Set<string>();
  for (const entry of added) {
    for (const operation of entry?.operations ?? []) {
      if (operation?.type !== 'REMOVE') continue;
      if ((operation.metadata as { autoPruned?: unknown })?.autoPruned !== true)
        continue;
      const bulletId = operation.bulletId;
      if (typeof bulletId !== 'string' || seen.has(bulletId)) continue;
      seen.add(bulletId);
      evictions.push({
        bulletId,
        section: operation.section,
        weaknessId: args.weaknessId,
        cause: 'section_overflow',
      });
    }
  }
  return evictions;
}
