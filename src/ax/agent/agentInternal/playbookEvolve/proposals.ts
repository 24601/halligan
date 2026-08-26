/**
 * Bounded proposal application for `agent.playbook().evolve()`.
 *
 * One surface: a curated playbook update. Rollback restores the pre-apply
 * snapshot via `load()`. (Verified learning produces only playbook bullets;
 * the standing-instruction surface lives on `agent.setInstruction()` /
 * `addActorInstruction()`, not here.)
 */

import { axPlaybookFailureSection } from '../failureReport.js';
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
