/**
 * The release chain: a content-addressed, append-only log of harness trees,
 * and the one surface a host pulls a tree from.
 *
 * The load-bearing split is between APPEND and PROMOTE. `publish()` appends a
 * nomination — always `current: false` — and never moves the head. `promote()`
 * is a separate compare-and-set that moves the head, and nothing inside ax
 * ever calls it. Verification nominates; a person deploys. A design in which
 * the gate moved the head itself would be an automatic, unconditional deploy
 * wearing a gate's clothes.
 *
 * Both moves are compare-and-set, so a lost race is a refusal with a named
 * operation rather than a fork. `step` is monotonic and never rewound, and a
 * rollback is an append plus a promote — it republishes an earlier release's
 * contentId under a NEW releaseId rather than rewriting history.
 */

import { type AxEventClock, AxSystemEventClock } from '../event/types.js';
import { randomUUID } from '../util/crypto.js';

import { axAdmitHarnessTree, axHarnessContentId } from './tree.js';
import {
  type AxHarnessGateDecision,
  type AxHarnessTree,
  type AxLearningRelease,
  AxLearningReleaseConflictError,
  type AxLearningStore,
  type AxLearningTreeDelivery,
} from './types.js';

export interface AxLearningSurfaceOptions {
  /** The isolated workload. The chain, the records and the engine share it. */
  readonly scenario: string;
  readonly store: AxLearningStore;
  /** Refused when `store.clock` exists and is a different instance. */
  readonly clock?: AxEventClock;
  /**
   * Seed tree published AND promoted as the `creation` release when the chain
   * is empty. Seeding is the one promotion ax performs, because a chain with
   * no head serves nothing; it is a construction-time host act, not a gate
   * outcome.
   */
  readonly seed?: AxHarnessTree;
  readonly idFactory?: () => string;
}

export interface AxLearningPublishArgs {
  readonly entries: AxHarnessTree;
  readonly gate: Readonly<AxHarnessGateDecision>;
  readonly operation?: 'evolve' | 'recovery';
}

function toDelivery(
  release: Readonly<AxLearningRelease>
): Readonly<AxLearningTreeDelivery> {
  return Object.freeze({
    releaseId: release.releaseId,
    ...(release.parentReleaseId === undefined
      ? {}
      : { parentReleaseId: release.parentReleaseId }),
    contentId: release.contentId,
    step: release.step,
    entries: release.entries,
    ...(release.gate === undefined ? {} : { gate: release.gate }),
  });
}

/**
 * A scenario's release chain, plus the in-process delivery a consumer pulls.
 *
 * Construct with `axLearningSurface(...)` or `AxLearningSurface.create(...)`;
 * both are async because seeding writes.
 */
export class AxLearningSurface {
  readonly scenario: string;

  private readonly store: AxLearningStore;
  private readonly clock: AxEventClock;
  private readonly idFactory: () => string;
  private observedHead: string | undefined;

  private constructor(options: Readonly<AxLearningSurfaceOptions>) {
    const { scenario, store } = options;
    if (typeof scenario !== 'string' || scenario.trim().length === 0) {
      throw new Error('AxLearningSurface: scenario must be a non-empty string');
    }
    // The event runtime's precedent: a store that owns a clock and a caller
    // that brought a different one would disagree about time, and silently
    // adopting one of them hides the disagreement.
    if (
      options.clock !== undefined &&
      store.clock !== undefined &&
      options.clock !== store.clock
    ) {
      throw new Error(
        'AxLearningSurface: the store owns a clock; pass that exact instance or none at all'
      );
    }
    this.scenario = scenario;
    this.store = store;
    this.clock = options.clock ?? store.clock ?? new AxSystemEventClock();
    this.idFactory = options.idFactory ?? randomUUID;
  }

  static async create(
    options: Readonly<AxLearningSurfaceOptions>,
    signal?: AbortSignal
  ): Promise<AxLearningSurface> {
    const surface = new AxLearningSurface(options);
    if (options.seed !== undefined) {
      await surface.seed(options.seed, signal);
    } else {
      await surface.currentTree(signal);
    }
    return surface;
  }

  /** The head `contentId` last observed, without IO. Feeds `artifactRef.stale`. */
  get observedHeadContentId(): string | undefined {
    return this.observedHead;
  }

  /** The promoted head, or `undefined` when nothing has been promoted. */
  async currentTree(
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningTreeDelivery> | undefined> {
    const head = await this.store.head(this.scenario, signal);
    this.observedHead = head?.contentId;
    return head === undefined ? undefined : toDelivery(head);
  }

  /** Oldest first, promoted or not. Every row carries the gate that nominated it. */
  releases(
    signal?: AbortSignal
  ): Promise<readonly Readonly<AxLearningRelease>[]> {
    return this.store.releases(this.scenario, signal);
  }

  /**
   * Append a NOMINATION. Always `current: false`; never moves the head.
   *
   * The gate decision travels with the release, so `releases()` is a decision
   * log over numbers — including nominations nobody promoted.
   */
  async publish(
    args: Readonly<AxLearningPublishArgs>,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>> {
    this.requireCompareAndSet('publish');
    const entries = axAdmitHarnessTree(args.entries);
    const contentId = await axHarnessContentId(entries);
    const chain = await this.store.releases(this.scenario, signal);
    const tail = chain.at(-1);
    return this.store.putRelease(
      Object.freeze({
        releaseId: this.idFactory(),
        scenario: this.scenario,
        ...(tail === undefined ? {} : { parentReleaseId: tail.releaseId }),
        contentId,
        step: (tail?.step ?? 0) + 1,
        operation: args.operation ?? 'evolve',
        current: false,
        restorable: true,
        recordedAt: this.clock.now(),
        entries,
        gate: args.gate,
      }),
      tail?.releaseId ?? null,
      signal
    );
  }

  /**
   * Move the head by compare-and-set. The host's decision.
   *
   * Nothing inside ax calls this. `axHarnessEvolve` nominates and stops.
   */
  async promote(
    releaseId: string,
    expectedHeadReleaseId: string | null,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>> {
    this.requireCompareAndSet('promote');
    const promoted = await this.store.promoteRelease(
      this.scenario,
      releaseId,
      expectedHeadReleaseId,
      signal
    );
    this.observedHead = promoted.contentId;
    return promoted;
  }

  /**
   * Operator recovery: republish an earlier release's contentId under a NEW
   * releaseId and promote it, in that order.
   *
   * The one method that both appends and promotes, because a rollback that
   * does not move the head is not a rollback. History is never rewritten and
   * `step` is never rewound — the rollback is the newest row on the chain.
   */
  async rollback(
    releaseId: string,
    expectedHeadReleaseId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningRelease>> {
    this.requireCompareAndSet('rollback');
    const chain = await this.store.releases(this.scenario, signal);
    const target = chain.find((release) => release.releaseId === releaseId);
    if (target === undefined) {
      throw new AxLearningReleaseConflictError(
        this.scenario,
        'append',
        releaseId,
        chain.at(-1)?.releaseId ?? null
      );
    }
    if (target.restorable !== true) {
      throw new Error(
        `AxLearningSurface: release ${releaseId} is not restorable`
      );
    }
    const tail = chain.at(-1);
    const appended = await this.store.putRelease(
      Object.freeze({
        releaseId: this.idFactory(),
        scenario: this.scenario,
        ...(tail === undefined ? {} : { parentReleaseId: tail.releaseId }),
        contentId: target.contentId,
        step: (tail?.step ?? 0) + 1,
        operation: 'rollback' as const,
        current: false,
        restorable: true,
        recordedAt: this.clock.now(),
        entries: target.entries,
        ...(target.gate === undefined ? {} : { gate: target.gate }),
        rollbackTargetReleaseId: target.releaseId,
      }),
      tail?.releaseId ?? null,
      signal
    );
    return this.promote(appended.releaseId, expectedHeadReleaseId, signal);
  }

  /**
   * Publish and promote the `creation` release when the chain is empty.
   *
   * The only promotion ax performs. A chain with no head serves nothing, and
   * a seed is a construction-time host act rather than a gate outcome.
   */
  private async seed(
    entries: AxHarnessTree,
    signal?: AbortSignal
  ): Promise<void> {
    this.requireCompareAndSet('seed');
    const chain = await this.store.releases(this.scenario, signal);
    if (chain.length > 0) {
      await this.currentTree(signal);
      return;
    }
    const admitted = axAdmitHarnessTree(entries);
    const contentId = await axHarnessContentId(admitted);
    const created = await this.store.putRelease(
      Object.freeze({
        releaseId: this.idFactory(),
        scenario: this.scenario,
        contentId,
        step: 1,
        operation: 'creation' as const,
        current: false,
        restorable: true,
        recordedAt: this.clock.now(),
        entries: admitted,
      }),
      null,
      signal
    );
    await this.promote(created.releaseId, null, signal);
  }

  private requireCompareAndSet(operation: string): void {
    if (this.store.capabilities.compareAndSet !== true) {
      throw new Error(
        `AxLearningSurface: ${operation} requires a store with compareAndSet capability`
      );
    }
  }
}

/** Factory form. Async because seeding writes. */
export const axLearningSurface = (
  options: Readonly<AxLearningSurfaceOptions>,
  signal?: AbortSignal
): Promise<AxLearningSurface> => AxLearningSurface.create(options, signal);
