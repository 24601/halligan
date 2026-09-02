/**
 * `actorMemoryMode: 'skillState'` — the prompt substrate that replaces
 * action-log replay with *frozen skill spec + typed state + latest
 * observation*.
 *
 * The actor loop in `transcript` mode carries an `ActionLogEntry[]` whose
 * rendered size grows with the horizon, so cumulative prompt characters over a
 * run grow with the square of the turn count. In `skillState` mode the dynamic
 * tail is `|sigma| + |roster| + |o_t|`, and each of those is bounded by an
 * explicit cap (`maxRenderChars`, `maxRosterEntries`, `maxObservationChars`),
 * so cumulative prompt characters grow linearly.
 *
 * The mode is only safe because the state it projects into is *verified*: every
 * transition goes through the same working-state kernel and host checker as
 * `transcript` mode, and commits through `AxProgramStateStore.compareAndSet`
 * under the configured fence. A discarded transcript with an unverified state
 * projection would trade a long-context error for a silent state error; here
 * the store keeps every prior revision and the kernel refuses an unsupported
 * delta.
 *
 * Nothing in this file runs for a default agent: it is reached only when
 * `actorMemoryMode: 'skillState'` is configured, which additionally requires
 * `workingState` and `skillState.skill`.
 */

import type { AxProgramStateEnvelope } from '../event/types.js';
import { axEventCanonicalDigest } from '../event/util.js';
import type { AxAgentSkillResult } from './agentInternal/skillsTypes.js';
import type { AxExecutableSkillRef } from './executableSkills.js';
import { type AxStatePatch, axValidateStatePatch } from './statePatch.js';
import {
  type AxWorkingState,
  type AxWorkingStateCommitContext,
  type AxWorkingStateDocument,
  type AxWorkingStateGuidanceNote,
  AxWorkingStateSchemaError,
  axIsWorkingStateError,
} from './workingState.js';

const DEFAULT_OBSERVATION_WINDOW = 1;

/**
 * Why a proposed transition did not commit.
 *
 * - `schema` — the patch document is not a valid state patch. The store is
 *   never touched.
 * - `authority` — the patch addressed a harness-owned path the model may not
 *   write. The whole patch is refused, not just the offending op.
 * - `fence` — the compare-and-set lost against the stored revision (twice,
 *   after one rebase), or the configured delivery fence rejected the write.
 * - `invariant` — the kernel or the host checker refused every delta: no
 *   supporting receipt, an unknown ref, an undeclared fact path, a failed
 *   check.
 */
export type AxSkillStateRejection =
  | 'schema'
  | 'authority'
  | 'fence'
  | 'invariant';

/**
 * One recorded state transition. This is the mode's durable audit record, and
 * it holds state DELTAS — the patch that was applied and the revision it
 * produced — rather than the prose that motivated them.
 */
export type AxSkillStateTransition<S = Record<string, unknown>> = Readonly<{
  turn: number;
  /** The validated patch. Empty when the document never parsed. */
  patch: AxStatePatch;
  /**
   * SHA-256 of the model's rationale text. The text itself is discarded: it is
   * never written to the action log, never rendered into a later prompt and
   * never persisted. The digest still proves two runs reasoned identically.
   *
   * ABSENT when the actor emitted no rationale at all. An empty rationale is a
   * different event from a missing one — the model declined to explain versus
   * explained with nothing — so it digests to the SHA-256 of `""` rather than
   * collapsing onto the same value.
   */
  rationaleDigest?: string;
  action: string;
  accepted: boolean;
  rejection?: AxSkillStateRejection;
  /**
   * Always defined: the store is never absent (it defaults to
   * `AxInMemoryProgramStateStore`), so every transition has a revision.
   */
  committedRevision: number;
  /** The committed document, present only on an accepted transition. */
  state?: AxWorkingStateDocument<S>;
  at: number;
}>;

/**
 * sigma_t as stored: the program-state envelope, narrowed so `state` is the
 * working-state document rather than the base type's `unknown`.
 */
export type AxSkillStateEnvelope<S = Record<string, unknown>> = Readonly<
  Omit<AxProgramStateEnvelope, 'state'> & { state: AxWorkingStateDocument<S> }
>;

/** The `(P, sigma_t, o_t)` triple the actor prompt is built from. */
export type AxSkillStateStep<S = Record<string, unknown>> = Readonly<{
  /** The frozen versioned procedure the actor is executing. */
  skill: AxAgentSkillResult;
  /**
   * sigma_t as STORED, including the fence-bearing revision: `state.revision`
   * always equals the kernel's `currentRevision()`, so a host can use it as
   * the expected revision for its own `compareAndSet`.
   *
   * Stored is not the same as believed. A parks-only turn appends to the
   * model-visible parked ledger without a store write, so the kernel's
   * `current()` can carry parked entries this envelope's `state.parked` does
   * not. Read `state` for the fence; read the kernel for what the model sees.
   */
  state: AxSkillStateEnvelope<S>;
  /** o_t, truncated to `maxObservationChars`. */
  observation: string;
}>;

export interface AxSkillStateConfig<S = Record<string, unknown>> {
  /**
   * Frozen skill spec `P`, rendered into the cached prompt prefix.
   *
   * `AxAgentSkillResult` is the only repo type carrying skill BODY TEXT
   * (`content: string`). `AxExecutableSkillRef` is `{id, version}` and cannot
   * render a spec on its own, so a ref REQUIRES `resolveSkill`.
   */
  skill: AxAgentSkillResult | AxExecutableSkillRef;
  /**
   * Required when `skill` is a ref: resolves it to renderable text. Absent
   * with a ref ⇒ `AxWorkingStateSchemaError` at construction.
   */
  resolveSkill?: (ref: AxExecutableSkillRef) => Promise<AxAgentSkillResult>;
  /** Number of prior observations kept in the prompt. Default 1. */
  observationWindow?: number;
  /**
   * Observability sink for every attempted transition, accepted or not. Called
   * once per `applyPatch`. Fail-soft like `AxWorkingStateConfig.onTrace`: a
   * throwing sink never fails the turn.
   *
   * AWAITED, and — like `onTrace` and `onFunctionCall` — with no timeout and
   * no abort signal, so a sink that never settles stalls the turn. Bounding
   * every host observability sink is one change to that shared contract, not a
   * private rule for this one; until then, a sink that can block should do its
   * own bounding.
   */
  onTransition?: (
    transition: Readonly<AxSkillStateTransition<S>>
  ) => void | Promise<void>;
}

type ObservationEntry = Readonly<{ turn: number; text: string }>;

/** A ref carries `{id, version}` and no body; a result carries `content`. */
function isSkillRef(
  skill: AxAgentSkillResult | AxExecutableSkillRef
): skill is AxExecutableSkillRef {
  return (
    typeof (skill as { version?: unknown }).version === 'string' &&
    typeof (skill as { content?: unknown }).content !== 'string'
  );
}

/**
 * The §6.5 config-time rules for this mode, split out so `AxAgent`'s
 * initialization can run them EAGERLY.
 *
 * @internal
 */
export function axValidateSkillStateConfig<S>(
  config: Readonly<AxSkillStateConfig<S>>
): void {
  // A host can reach `axSkillStateRuntime` directly, so the absent-config case
  // is a typed error rather than a raw `TypeError` off a property read.
  if (!config || typeof config !== 'object') {
    throw new AxWorkingStateSchemaError('skillstate_requires_skill');
  }
  if (!config.skill || typeof config.skill !== 'object') {
    throw new AxWorkingStateSchemaError('skillstate_requires_skill');
  }
  if (isSkillRef(config.skill) && typeof config.resolveSkill !== 'function') {
    throw new AxWorkingStateSchemaError('unresolvable_skill_spec');
  }
  if (
    config.observationWindow !== undefined &&
    (!Number.isInteger(config.observationWindow) ||
      config.observationWindow < 1)
  ) {
    throw new AxWorkingStateSchemaError(
      `invalid_observation_window: ${String(config.observationWindow)}`
    );
  }
}

/** Render the frozen spec. Constant for the run, so it rides the cached prefix. */
function renderSkillSpec(skill: AxAgentSkillResult): string {
  const heading = skill.id ? `${skill.name} (${skill.id})` : skill.name;
  return `# Procedure: ${heading}\n\n${skill.content}`;
}

/**
 * Drives one `skillState` turn: build the bounded prompt, read the actor's
 * typed `statePatch`, validate it through the working-state kernel and host
 * checker, and commit it through `AxProgramStateStore.compareAndSet` under the
 * configured fence.
 */
export class AxSkillStateRuntime<S = Record<string, unknown>> {
  private readonly workingState: AxWorkingState<S>;
  private readonly skill: AxAgentSkillResult;
  private readonly skillSpecText: string;
  private readonly observationWindow: number;
  private readonly observations: ObservationEntry[] = [];
  private readonly transitionLog: AxSkillStateTransition<S>[] = [];
  private readonly onTransition?: AxSkillStateConfig<S>['onTransition'];
  private lastGuidanceNotes: readonly AxWorkingStateGuidanceNote[] = [];

  private constructor(args: {
    workingState: AxWorkingState<S>;
    skill: AxAgentSkillResult;
    observationWindow: number;
    onTransition?: AxSkillStateConfig<S>['onTransition'];
  }) {
    this.workingState = args.workingState;
    this.skill = args.skill;
    this.skillSpecText = renderSkillSpec(args.skill);
    this.observationWindow = args.observationWindow;
    this.onTransition = args.onTransition;
  }

  /** @internal Constructed by `axSkillStateRuntime`. */
  static async open<S>(
    config: Readonly<AxSkillStateConfig<S>>,
    workingState: AxWorkingState<S>
  ): Promise<AxSkillStateRuntime<S>> {
    axValidateSkillStateConfig(config);
    const skill = isSkillRef(config.skill)
      ? // `axValidateSkillStateConfig` already refused a ref without a
        // resolver, so this call is total.
        await config.resolveSkill!(config.skill)
      : config.skill;
    if (typeof skill?.content !== 'string' || skill.content.length === 0) {
      throw new AxWorkingStateSchemaError(
        'unresolvable_skill_spec: resolveSkill returned no skill content'
      );
    }
    return new AxSkillStateRuntime<S>({
      workingState,
      skill,
      observationWindow: config.observationWindow ?? DEFAULT_OBSERVATION_WINDOW,
      ...(config.onTransition ? { onTransition: config.onTransition } : {}),
    });
  }

  /** The frozen spec text rendered into the cached prompt prefix. */
  public skillSpec(): string {
    return this.skillSpecText;
  }

  /** Record one turn's runtime output. Bounded by `observationWindow`. */
  public observe(observation: string, turn: number): void {
    const limit = this.workingState.maxObservationChars();
    const text =
      observation.length > limit ? observation.slice(0, limit) : observation;
    this.observations.push({ turn, text });
    while (this.observations.length > this.observationWindow) {
      this.observations.shift();
    }
  }

  /** The `(P, sigma_t, o_t)` triple, with sigma_t as it is stored. */
  public step(): Readonly<AxSkillStateStep<S>> {
    return {
      skill: this.skill,
      state: this.workingState.envelope() as AxSkillStateEnvelope<S>,
      observation: this.observations[this.observations.length - 1]?.text ?? '',
    };
  }

  /**
   * The bounded prompt payload. `receiptRoster` is the read-only harness
   * region; `workingState` is the model-writable one.
   */
  public renderPrompt(): Readonly<{
    skillSpec: string;
    stateContract: string;
    workingState: string;
    receiptRoster: string;
    latestObservation: string;
  }> {
    return {
      skillSpec: this.skillSpecText,
      stateContract: this.workingState.stateContract(),
      workingState: this.workingState.renderWritable(),
      receiptRoster: this.workingState.renderReadOnly(),
      latestObservation: this.renderObservations(),
    };
  }

  /** The observation window, oldest first. `(no observation yet)` on turn 1. */
  public renderObservations(): string {
    if (this.observations.length === 0) return '(no observation yet)';
    return this.observations
      .map((entry) => `[turn ${entry.turn}] ${entry.text}`)
      .join('\n\n');
  }

  /**
   * Validate and commit one actor-emitted patch.
   *
   * A malformed document is rejected as `schema` WITHOUT touching the store; a
   * forbidden path is `authority`; a lost compare-and-set is `fence`; and a
   * kernel or checker refusal is `invariant`. Only an accepted transition is
   * retained by `transitions()` — the record holds deltas, not attempts.
   */
  public async applyPatch(
    document: unknown,
    rationale: string | undefined,
    context: AxWorkingStateCommitContext,
    signal?: AbortSignal
  ): Promise<AxSkillStateTransition<S>> {
    // ABSENT rationale and EMPTY rationale are different events, so an absent
    // one produces no digest field at all rather than the digest of `''`.
    const rationaleDigest =
      rationale === undefined
        ? undefined
        : await axEventCanonicalDigest(rationale);
    const validation = axValidateStatePatch(document);
    if (validation.status !== 'valid') {
      // The store is not reached at all: a document that never parsed is not a
      // proposal the kernel can classify.
      const outcome = await this.workingState.recordNonCommit(
        { ...context, proposal: 'invalid' },
        'patch_invalid'
      );
      this.lastGuidanceNotes = outcome.guidance ?? [];
      return await this.record({
        turn: context.turn,
        patch: [],
        ...(rationaleDigest === undefined ? {} : { rationaleDigest }),
        action: context.action,
        accepted: false,
        rejection: 'schema',
        committedRevision: this.workingState.currentRevision(),
      });
    }

    const outcome = await this.workingState.commit(
      validation.patch,
      context,
      signal
    );
    this.lastGuidanceNotes = outcome.guidance ?? [];
    const accepted =
      outcome.outcome === 'committed' ||
      outcome.outcome === 'partially_committed';
    const rejection = accepted
      ? undefined
      : rejectionFor(outcome.error, outcome.parked.length);

    return await this.record({
      turn: context.turn,
      patch: validation.patch,
      ...(rationaleDigest === undefined ? {} : { rationaleDigest }),
      action: context.action,
      accepted,
      ...(rejection ? { rejection } : {}),
      committedRevision: outcome.revision,
      ...(accepted ? { state: outcome.state } : {}),
    });
  }

  /**
   * Harness guidance from the most recent `applyPatch`. Enum codes, op kinds
   * and canonical harness pointers only — never model-authored text.
   */
  public lastGuidance(): readonly AxWorkingStateGuidanceNote[] {
    return this.lastGuidanceNotes;
  }

  /** Accepted transitions, oldest first. A copy. */
  public transitions(): readonly AxSkillStateTransition<S>[] {
    return this.transitionLog.slice();
  }

  private async record(
    transition: Omit<AxSkillStateTransition<S>, 'at'>
  ): Promise<AxSkillStateTransition<S>> {
    const full: AxSkillStateTransition<S> = {
      ...transition,
      at: this.workingState.now(),
    };
    // Only accepted transitions enter the ledger: a refused attempt changed no
    // state, so recording it as a transition would put attempts-as-deltas into
    // the audit record. Refusals are already visible on the Gamma trace, in the
    // parked ledger, on the returned value and through `onTransition`.
    if (full.accepted) {
      this.transitionLog.push(full);
    }
    if (this.onTransition) {
      try {
        await this.onTransition(full);
      } catch {
        // Observability is fail-soft, like `onFunctionCall` and `onTrace`.
      }
    }
    return full;
  }
}

/**
 * Map a non-accepting commit outcome onto the rejection vocabulary. An empty
 * or fully no-op patch produces NO rejection: nothing was refused.
 */
function rejectionFor(
  error: unknown,
  parkedCount: number
): AxSkillStateRejection | undefined {
  // Discriminated by the typed `code`, not by `instanceof`: two copies of the
  // package in one process would make the constructor check fail and silently
  // downgrade an `authority` or `fence` rejection to `undefined`, which is the
  // one value that means "nothing was refused".
  if (axIsWorkingStateError(error)) {
    if (error.code === 'working_state_forbidden_path') return 'authority';
    if (error.code === 'state_revision_conflict') return 'fence';
  }
  if (parkedCount > 0) return 'invariant';
  return undefined;
}

/**
 * Open a skillState runtime over an already-open working state. Resolves the
 * frozen skill spec once, at construction, so the cached prompt prefix is
 * constant for the run.
 */
export const axSkillStateRuntime = async <S = Record<string, unknown>>(
  config: Readonly<AxSkillStateConfig<S>>,
  workingState: AxWorkingState<S>
): Promise<AxSkillStateRuntime<S>> =>
  AxSkillStateRuntime.open<S>(config, workingState);
