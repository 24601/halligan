/**
 * The impure half of the harness tree: installing a rendered tree onto a live
 * target, and taking it off again exactly.
 *
 * Kept apart from `axRenderHarnessTree` on purpose. Render is a pure function
 * of `(tree, now)` and is what candidate/current comparison uses; install
 * writes into a running agent and hands back a `dispose()` that restores the
 * precise prior state. Calling the writer "apply" and pretending it is pure
 * would be a lie in the type name.
 *
 * The module writes through the structural `AxHarnessInstallTarget` port, so
 * it takes no runtime dependency on `src/ax/agent/`.
 */

import type { AxAgentCatalogSkill } from '../agent/agentInternal/skillsTypes.js';
import type { AxPlaybookSnapshot } from '../dsp/playbook.js';

import { axHarnessContentId, axRenderHarnessTree } from './tree.js';
import {
  AxHarnessApplyError,
  type AxHarnessInstallation,
  type AxHarnessInstallTarget,
  type AxHarnessTree,
} from './types.js';

/**
 * The live installation per target.
 *
 * A WeakMap keyed by the target, not a field on it: the target is a host
 * object this module does not own, and "what is installed" has to be
 * single-valued for a record's `artifactRef` to be honest.
 */
const installations = new WeakMap<
  AxHarnessInstallTarget,
  Readonly<AxHarnessInstallation>
>();

export interface AxHarnessApplyOptions {
  readonly releaseId: string;
  readonly parentReleaseId?: string;
  /** ISO timestamp from the caller's injected clock. Never read from a clock here. */
  readonly now: string;
  /** Installation slot prefix. Default `learn`. */
  readonly slot?: string;
  /**
   * Required when the target learns into its playbook after every completed
   * run. Installing a tree REPLACES the playbook, so run-accumulated bullets
   * are discarded; the reset is acknowledged explicitly and counted.
   */
  readonly acknowledgeContinuousPlaybookReset?: boolean;
}

/**
 * The live installation for a target, or undefined.
 *
 * This is the ONLY source of a record's `artifactRef`. Reading a store head is
 * not serving it: an agent that was never installed, or that another process
 * moved past, must not stamp its records with a release it did not run.
 */
export const axCurrentHarnessInstallation = (
  target: AxHarnessInstallTarget
): Readonly<AxHarnessInstallation> | undefined => installations.get(target);

function countBullets(snapshot: Readonly<AxPlaybookSnapshot>): number {
  return Object.values(snapshot.playbook.sections ?? {}).reduce(
    (total, bullets) => total + bullets.length,
    0
  );
}

/**
 * Install a tree onto a target and return the handle that takes it off again.
 *
 * Fails closed before it writes anything: the tree is re-admitted, a target
 * that already carries an installation is refused (so "what is installed"
 * stays single-valued), and a continuous-learning playbook is refused without
 * an explicit acknowledgement of the reset it would cause.
 */
export const axApplyHarnessTree = async (
  tree: AxHarnessTree,
  target: AxHarnessInstallTarget,
  options: Readonly<AxHarnessApplyOptions>
): Promise<Readonly<AxHarnessInstallation>> => {
  const slotPrefix = options.slot ?? 'learn';

  if (installations.has(target)) {
    throw new AxHarnessApplyError(
      'instruction',
      'axApplyHarnessTree: this target already carries an installation; dispose it first.'
    );
  }

  // Admission and content identity run BEFORE any write: an un-admittable
  // tree must never reach a live agent, even partially.
  const contentId = await axHarnessContentId(tree);
  const rendering = axRenderHarnessTree(tree, { now: options.now });

  const needsPlaybook = Object.keys(rendering.playbook.sections).length > 0;
  const needsSkills = rendering.skills.length > 0;

  let priorPlaybook: AxPlaybookSnapshot | undefined;
  let discardedBulletCount = 0;
  if (needsPlaybook) {
    const handle = target.getPlaybook();
    if (!handle) {
      throw new AxHarnessApplyError(
        'playbookBullet',
        'axApplyHarnessTree: the tree carries playbook bullets but the target has no playbook handle.'
      );
    }
    if (
      target.hasContinuousPlaybookLearning?.() === true &&
      options.acknowledgeContinuousPlaybookReset !== true
    ) {
      throw new AxHarnessApplyError(
        'playbookBullet',
        'axApplyHarnessTree: this target learns into its playbook after every run, and installing a tree replaces it. Pass acknowledgeContinuousPlaybookReset: true to accept discarding run-accumulated bullets.'
      );
    }
    priorPlaybook = handle.getState();
    discardedBulletCount = countBullets(priorPlaybook);
  }

  // Everything written is recorded as it is written, so a failure part-way
  // through unwinds exactly as far as it got.
  const writtenInstructionSlots: { slot: string; prior?: string }[] = [];
  let wroteSkills = false;
  let priorSkills: readonly Readonly<AxAgentCatalogSkill>[] | undefined;
  let wrotePlaybook = false;

  const restore = (): void => {
    for (const written of writtenInstructionSlots) {
      target.setActorInstructionSlot(written.slot, written.prior);
    }
    writtenInstructionSlots.length = 0;
    if (wroteSkills) {
      target.setSkillsCatalogSlot(slotPrefix, priorSkills);
      wroteSkills = false;
    }
    if (wrotePlaybook && priorPlaybook) {
      target.getPlaybook()?.load(priorPlaybook);
      wrotePlaybook = false;
    }
  };

  try {
    for (const entry of tree) {
      if (entry.kind !== 'instruction' || entry.disabled === true) continue;
      const slot = `${slotPrefix}:${entry.id}`;
      // The prior value is captured so dispose restores EXACTLY, rather than
      // clearing a slot the host may have owned before the install.
      const prior = target.getActorInstructionSlot?.(slot);
      target.setActorInstructionSlot(slot, entry.config.text);
      writtenInstructionSlots.push(
        prior === undefined ? { slot } : { slot, prior }
      );
    }
  } catch (error) {
    restore();
    throw new AxHarnessApplyError(
      'instruction',
      `axApplyHarnessTree: installing instruction slots failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  if (needsPlaybook && priorPlaybook) {
    try {
      target.getPlaybook()?.load({
        playbook: rendering.playbook,
        artifact: {
          playbook: rendering.playbook,
          feedback: [],
          history: [],
        },
      });
      wrotePlaybook = true;
    } catch (error) {
      restore();
      throw new AxHarnessApplyError(
        'playbookBullet',
        `axApplyHarnessTree: installing playbook bullets failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  if (needsSkills) {
    try {
      priorSkills = target.getSkillsCatalogSlot?.(slotPrefix);
      target.setSkillsCatalogSlot(slotPrefix, rendering.skills);
      wroteSkills = true;
    } catch (error) {
      restore();
      // The setter refuses a host `onSkillsSearch` and a non-catalog agent;
      // both arrive here as the skill channel with the reason in the message.
      throw new AxHarnessApplyError(
        'skill',
        `axApplyHarnessTree: installing catalog skills failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  let disposed = false;
  const installation: Readonly<AxHarnessInstallation> = Object.freeze({
    releaseId: options.releaseId,
    ...(options.parentReleaseId === undefined
      ? {}
      : { parentReleaseId: options.parentReleaseId }),
    contentId,
    installedAt: Date.parse(options.now),
    discardedBulletCount,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      installations.delete(target);
      restore();
    },
  });
  installations.set(target, installation);
  return installation;
};
