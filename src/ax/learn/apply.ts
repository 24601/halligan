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
  AxHarnessRenderError,
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

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
  options: Readonly<AxHarnessApplyOptions>,
  signal?: AbortSignal
): Promise<Readonly<AxHarnessInstallation>> => {
  const slotPrefix = options.slot ?? 'learn';
  throwIfAborted(signal);

  if (installations.has(target)) {
    throw new AxHarnessApplyError(
      'instruction',
      'axApplyHarnessTree: this target already carries an installation; dispose it first.'
    );
  }

  // `now` is parsed once, here, rather than at the end: `installedAt: NaN` on
  // a frozen installation is a silently wrong provenance timestamp, and the
  // render below only checks that the string is non-empty.
  const installedAt = Date.parse(options.now);
  if (!Number.isFinite(installedAt)) {
    throw new AxHarnessRenderError(
      'now',
      'axApplyHarnessTree: `now` must be a parseable ISO timestamp string'
    );
  }

  // Admission and content identity run BEFORE any write: an un-admittable
  // tree must never reach a live agent, even partially.
  const contentId = await axHarnessContentId(tree);
  const rendering = axRenderHarnessTree(tree, { now: options.now });
  throwIfAborted(signal);

  // The playbook channel is a function of the TARGET, not of the tree.
  //
  // A tree install REPLACES the playbook — that is the documented contract,
  // and it is what makes a record's `artifactRef` honest, because an agent
  // serving release X plus run-accumulated bullets that are in no release is
  // not serving X. Gating the replacement on "the tree happens to carry a
  // bullet" left foreign bullets serving under a tree that has none, skipped
  // the continuous-learning refusal entirely for such a tree, and made
  // "remove the last harmful bullet" unmeasurable in an evolve step.
  const playbook = target.getPlaybook();
  if (
    playbook === undefined &&
    Object.keys(rendering.playbook.sections).length > 0
  ) {
    throw new AxHarnessApplyError(
      'playbookBullet',
      'axApplyHarnessTree: the tree carries playbook bullets but the target has no playbook handle.'
    );
  }

  let priorPlaybook: AxPlaybookSnapshot | undefined;
  let discardedBulletCount = 0;
  if (playbook) {
    if (
      target.hasContinuousPlaybookLearning?.() === true &&
      options.acknowledgeContinuousPlaybookReset !== true
    ) {
      throw new AxHarnessApplyError(
        'playbookBullet',
        'axApplyHarnessTree: this target learns into its playbook after every run, and installing a tree replaces it. Pass acknowledgeContinuousPlaybookReset: true to accept discarding run-accumulated bullets.'
      );
    }
    priorPlaybook = playbook.getState();
    discardedBulletCount = countBullets(priorPlaybook);
  }

  // Everything written is recorded as it is written, so a failure part-way
  // through unwinds exactly as far as it got.
  const writtenInstructionSlots: { slot: string; prior?: string }[] = [];
  let wroteSkills = false;
  let priorSkills: readonly Readonly<AxAgentCatalogSkill>[] | undefined;
  let wrotePlaybook = false;

  /**
   * Undo every write this installation made, and REPORT what could not be
   * undone rather than stopping at the first failure.
   *
   * A restore that gave up half way would leave a target serving a mixture of
   * two trees with no record of which, so each channel is attempted
   * independently and the failures are collected for the caller to raise.
   */
  const restore = (): readonly unknown[] => {
    const failures: unknown[] = [];
    for (const written of writtenInstructionSlots) {
      try {
        target.setActorInstructionSlot(written.slot, written.prior);
      } catch (error) {
        failures.push(error);
      }
    }
    writtenInstructionSlots.length = 0;
    if (wroteSkills) {
      wroteSkills = false;
      try {
        target.setSkillsCatalogSlot(slotPrefix, priorSkills);
      } catch (error) {
        failures.push(error);
      }
    }
    if (wrotePlaybook && priorPlaybook) {
      wrotePlaybook = false;
      try {
        target.getPlaybook()?.load(priorPlaybook);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };

  /** Unwind, then raise the install failure — with any restore failure attached. */
  const unwind = (error: unknown, applyError: AxHarnessApplyError): never => {
    const failures = restore();
    if (failures.length > 0) {
      throw new AggregateError(
        [applyError, ...failures],
        'axApplyHarnessTree: the install failed AND the target could not be restored'
      );
    }
    void error;
    throw applyError;
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
    unwind(
      error,
      new AxHarnessApplyError(
        'instruction',
        `axApplyHarnessTree: installing instruction slots failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      )
    );
  }

  if (playbook) {
    try {
      playbook.load({
        playbook: rendering.playbook,
        artifact: {
          playbook: rendering.playbook,
          feedback: [],
          history: [],
        },
      });
      wrotePlaybook = true;
    } catch (error) {
      unwind(
        error,
        new AxHarnessApplyError(
          'playbookBullet',
          `axApplyHarnessTree: installing playbook bullets failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      );
    }
  }

  try {
    priorSkills = target.getSkillsCatalogSlot?.(slotPrefix);
    // The slot is replaced, not merged — but a channel this install never
    // touched is left alone. Writing an empty slot unconditionally would make
    // an agent constructed with a host `onSkillsSearch` refuse an
    // instruction-only tree, which is a refusal the tree does not earn.
    if (rendering.skills.length > 0 || (priorSkills?.length ?? 0) > 0) {
      target.setSkillsCatalogSlot(slotPrefix, rendering.skills);
      wroteSkills = true;
    }
  } catch (error) {
    // The setter refuses a host `onSkillsSearch` and a non-catalog agent;
    // both arrive here as the skill channel with the reason in the message.
    unwind(
      error,
      new AxHarnessApplyError(
        'skill',
        `axApplyHarnessTree: installing catalog skills failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      )
    );
  }

  let disposed = false;
  const installation: Readonly<AxHarnessInstallation> = Object.freeze({
    releaseId: options.releaseId,
    ...(options.parentReleaseId === undefined
      ? {}
      : { parentReleaseId: options.parentReleaseId }),
    contentId,
    installedAt,
    discardedBulletCount,
    dispose: (): void => {
      if (disposed) return;
      // Marked disposed and deregistered FIRST, in a finally, so a throwing
      // setter cannot leave the target registered as serving a release it is
      // no longer serving — a record stamped from a half-restored target would
      // be worse than no ref at all. The failure is raised, never swallowed.
      disposed = true;
      let failures: readonly unknown[] = [];
      try {
        failures = restore();
      } finally {
        installations.delete(target);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'axApplyHarnessTree: dispose() could not restore the target to its pre-install state'
        );
      }
    },
  });
  installations.set(target, installation);
  return installation;
};
