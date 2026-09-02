/**
 * Call-time skill injection — opt-in, per qualified callable.
 *
 * When the actor drafts a call to a bound callable the harness does NOT
 * execute it. It returns a frozen `not executed` marker, loads the binding's
 * skill through the ordinary loaded-skills channel, appends harness-authored
 * guidance to the trusted guidance log, and lets the model re-draft with the
 * procedure in front of it. Every unbound callable keeps today's function-call
 * contract byte for byte; with `callTimeSkills` unset nothing in this file is
 * constructed at all.
 *
 * Three properties are load-bearing and are each tested:
 *
 * 1. **The interception happens before the authority boundary.** A call that
 *    did not happen must not request an authorization decision, must not fire
 *    `onFunctionCall`, must not reach `functionCallRecorder`, and — decisively
 *    — must not mint a working-state tool receipt. A skill injection can never
 *    support a goal completion.
 * 2. **A bound callable gets no speculation adapter at all.**
 *    `runLogicalCall` is not the only way into a wrapped function: for an
 *    `external` callable the JS runtime may hold a speculation adapter whose
 *    `launch` closure calls `authorizeCall` and the function DIRECTLY, and
 *    whose commit path reaches `observeResult`. Guarding only the logical path
 *    would leave that second entry point open, so the adapter is not installed
 *    for a bound callable and there is no second path left to guard. The guard
 *    lives at the installation site, inside this repo, and is therefore
 *    fail-closed regardless of what the host runtime allowlisted.
 * 3. **It is a nudge, not a gate.** Each binding carries a per-run injection
 *    budget (default 1). Once the budget is spent the tool executes normally,
 *    so an unhelpful skill can never trap the actor in a re-draft loop.
 * 4. **A bound catalog id is not a bypass of the catalog gates.** A binding is
 *    static host config; `requires` eligibility and the retrieval-time
 *    authority re-check are not. The run-start open resolves a catalog id
 *    through the same admission verdict `discover({ skills })`, the
 *    `### Available Skills` index, the relevance hint and the kernel tier use,
 *    and refuses the RUN when the gates hid the bound skill — a binding must
 *    never be the one path that renders a hidden body into a prompt.
 */

import type {
  AxAgentCatalogSkill,
  AxAgentSkillResult,
} from './agentInternal/skillsTypes.js';
import type { AxAgentSkillEnvironment } from './skillCatalog.js';
import { axCheckSkillRequirements } from './skillCatalog.js';
import type { AxWorkingStateDocument } from './workingState.js';
import { AxWorkingStateSchemaError } from './workingState.js';

/** Injections allowed for one callable in one run when the host names none. */
const DEFAULT_MAX_INJECTIONS = 1;

/**
 * Ceiling on a host-configured `maxInjections`. Every injection appends a
 * pending record, ingests a skill body and appends a guidance entry, and the
 * guidance log is not trimmed — a mechanism whose entire safety argument is
 * "budgeted" must bound its own budget rather than trust the number it was
 * handed. Well above any plausible `maxTurns`, so it never binds in practice.
 */
const MAX_MAX_INJECTIONS = 100;

/** The error subsystem stem, so a call-time misconfiguration names itself. */
const CONFIG_SUBSYSTEM = 'Call-time skill';

const configError = (detail: string): AxWorkingStateSchemaError =>
  new AxWorkingStateSchemaError(detail, CONFIG_SUBSYSTEM);

/**
 * Opt-in binding of one exact callable to one skill. Absent from the agent's
 * options ⇒ today's function-call contract, unchanged.
 */
export type AxCallTimeSkillBinding = Readonly<{
  /**
   * Exact namespaced callable, e.g. `inventory.adjustStock`. NO globs: a
   * pattern would let one binding silently capture a callable added later,
   * and interception is a change to a tool's contract.
   */
  qualifiedName: string;
  /** Skill id resolved from `skillsCatalog`, or an inline skill. */
  skill: string | AxAgentSkillResult;
  /**
   * Injections allowed for this callable in one run. Default 1, hard ceiling
   * 100. The tool executes normally on every call past the budget — the
   * interception is a one-shot nudge, never a gate.
   */
  maxInjections?: number;
  /**
   * Only intercept when this predicate over the COMMITTED working state says
   * the call is state-changing. Omitted ⇒ always intercept, up to the budget.
   *
   * Requires `workingState`: without a committed document there is nothing to
   * predicate on, and inventing an empty one would silently answer a question
   * the host asked about real state.
   */
  when?: (state: Readonly<AxWorkingStateDocument<any>>) => boolean;
}>;

/**
 * The frozen value an intercepted call returns instead of executing.
 *
 * Returned, never thrown: a thrown error is caught by the runtime and tagged
 * `'error'` on the action log, which feeds the actor's error-escalation policy.
 * An interception is not a failure and must not look like one.
 */
export type AxCallTimeSkillNotExecuted = Readonly<{
  readonly __axNotExecuted: true;
  readonly reason: 'skill_injected';
  readonly qualifiedName: string;
  readonly skillId: string;
  /** Copy of the harness-generated guidance appended to the guidance log. */
  readonly guidance: string;
}>;

/**
 * Structural guard — `instanceof` is unavailable (the marker is a plain frozen
 * object) and identity comparison breaks across two copies of the package.
 */
export const axIsCallTimeSkillNotExecuted = (
  value: unknown
): value is AxCallTimeSkillNotExecuted => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.__axNotExecuted === true &&
    record.reason === 'skill_injected' &&
    typeof record.qualifiedName === 'string' &&
    typeof record.skillId === 'string' &&
    typeof record.guidance === 'string'
  );
};

/**
 * One recorded interception, drained once per actor turn by the loop so the
 * skill is ingested and the guidance is appended with that turn's number.
 *
 * @internal
 */
export type AxCallTimeSkillInjection = Readonly<{
  qualifiedName: string;
  skillId: string;
  /** The resolved skill, ready for `ingestSkillResults`. */
  skill: AxAgentSkillResult;
  /** Harness-authored. Identical to the marker's copy. */
  guidance: string;
}>;

/**
 * The dispatch-site hook `wrapFunction` consults. Its PRESENCE is also what
 * suppresses the speculation adapter, so one value carries both halves of the
 * interlock and they cannot drift apart.
 *
 * @internal
 */
export type AxCallTimeSkillHook = () => AxCallTimeSkillNotExecuted | undefined;

type ResolvedBinding = Readonly<{
  qualifiedName: string;
  skill: AxAgentSkillResult;
  skillId: string;
  maxInjections: number;
  when?: (state: Readonly<AxWorkingStateDocument<any>>) => boolean;
}>;

/**
 * Everything the runtime needs from the agent, injected so this module has no
 * dependency on the loop.
 *
 * @internal
 */
export type AxCallTimeSkillDeps = Readonly<{
  /** Committed working state, for `when`. Absent when working state is off. */
  workingState?: () => Readonly<AxWorkingStateDocument<any>>;
  /** Resolves a catalog skill id to renderable text. */
  resolveSkill?: (id: string) => AxAgentSkillResult | undefined;
  /**
   * The run's catalog admission verdict for a bound id. Supplied only at run
   * start, where the authority snapshot and the run clock exist; the
   * constructor gate runs without it because neither does yet.
   */
  admitSkill?: (id: string) => AxCallTimeSkillAdmission;
}>;

const skillIdOf = (skill: AxAgentSkillResult): string =>
  (typeof skill.id === 'string' && skill.id.trim()) || skill.name.trim();

/**
 * Harness-authored, enum-shaped guidance. `guidanceLog` is the TRUSTED prompt
 * region while the action log is explicitly untrusted, so nothing
 * model-authored may reach it: both values interpolated here are host
 * configuration (the bound callable and its skill id).
 */
export const axCallTimeSkillGuidance = (
  qualifiedName: string,
  skillId: string
): string =>
  `[call-time skill] ${qualifiedName}(...) was NOT executed. ` +
  `The skill \`${skillId}\` is now loaded under Loaded Skills. ` +
  'Read it, then re-draft the call.';

/**
 * Resolve a `skillsCatalog` id to renderable text. Shared by the agent's
 * construction-time gate and the per-run open so both answer the same
 * question against the same catalog shape.
 *
 * @internal
 */
export const axCallTimeSkillCatalogResolver =
  (catalog: readonly AxAgentCatalogSkill[] | undefined) =>
  (id: string): AxAgentSkillResult | undefined => {
    const found = catalog?.find((entry) => entry?.id === id);
    if (!found) return undefined;
    return { id: found.id, name: found.name, content: found.content };
  };

/**
 * Why a bound catalog id may not be injectable. Only `'admit'` may reach a
 * prompt.
 *
 * @internal
 */
export type AxCallTimeSkillAdmission = 'admit' | 'ineligible' | 'denied';

/**
 * The run-start admission verdict for a bound catalog id, over the SAME two
 * catalog gates every other retrieval path runs.
 *
 * A binding is static host config; the gates are not. `requires` gating is
 * resolved against the run's declared environment, and the authority re-check
 * that produces `denied` is time- and authority-varying — an expired grant or
 * a revoked trajectory parks a skill mid-lifecycle. "The host named it by id"
 * is therefore not an answer: `discover({ skills })`, the `### Available
 * Skills` index, the relevance hint and the kernel tier all refuse a skill
 * these gates hid, and a call-time binding must not be the one path that
 * renders its body anyway.
 *
 * An id absent from the catalog is admitted: an inline skill is host-supplied
 * literal text with nothing to be eligible for, exactly as `presetSkills` is.
 *
 * @internal
 */
export const axCallTimeSkillCatalogAdmission =
  (
    catalog: readonly AxAgentCatalogSkill[] | undefined,
    gates: Readonly<{
      environment?: Readonly<AxAgentSkillEnvironment>;
      denied?: ReadonlySet<string>;
    }>
  ) =>
  (id: string): AxCallTimeSkillAdmission => {
    const found = catalog?.find((entry) => entry?.id === id);
    if (!found) return 'admit';
    if (!axCheckSkillRequirements(found.requires, gates.environment).eligible) {
      return 'ineligible';
    }
    if (gates.denied?.has(id)) return 'denied';
    return 'admit';
  };

const isSkillResult = (value: unknown): value is AxAgentSkillResult => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    record.name.trim().length > 0 &&
    typeof record.content === 'string' &&
    record.content.length > 0
  );
};

/**
 * The §6.5 config-time rules for call-time skill injection, split out so the
 * agent constructor can run them EAGERLY and so the per-run open can re-run
 * them against the run's effective skills catalog.
 *
 * `unknown_bound_callable` is NOT checked here: MCP and UCP callables only
 * exist once the run's execution context does, so a constructor-time check
 * would reject every legitimate `mcp.*` / `ucp.*` binding. It is enforced at
 * run start instead, by `finishRegistration()`.
 *
 * @internal
 */
export function axValidateCallTimeSkillBindings(
  bindings: unknown,
  context: Readonly<{
    hasWorkingState: boolean;
    resolveSkill?: (id: string) => AxAgentSkillResult | undefined;
  }>
): void {
  if (!Array.isArray(bindings)) {
    throw configError('call_time_skills_not_an_array');
  }
  const seen = new Set<string>();
  for (const binding of bindings as readonly AxCallTimeSkillBinding[]) {
    if (!binding || typeof binding !== 'object') {
      throw configError('invalid_call_time_skill_binding');
    }
    const name = binding.qualifiedName;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw configError('invalid_bound_callable');
    }
    if (name.includes('*')) {
      // A glob would let one binding capture a callable registered later, and
      // interception changes a tool's contract. Exact names only.
      throw configError(`bound_callable_glob: ${name}`);
    }
    if (seen.has(name)) {
      throw configError(`duplicate_bound_callable: ${name}`);
    }
    seen.add(name);
    if (
      binding.maxInjections !== undefined &&
      (!Number.isInteger(binding.maxInjections) ||
        binding.maxInjections < 1 ||
        binding.maxInjections > MAX_MAX_INJECTIONS)
    ) {
      throw configError(
        `invalid_max_injections: ${String(binding.maxInjections)}`
      );
    }
    if (binding.when !== undefined) {
      if (typeof binding.when !== 'function') {
        throw configError(`invalid_when_predicate: ${name}`);
      }
      if (!context.hasWorkingState) {
        throw configError(`when_requires_working_state: ${name}`);
      }
    }
    if (typeof binding.skill === 'string') {
      const id = binding.skill.trim();
      if (!id) {
        throw configError(`unknown_bound_skill: ${name}`);
      }
      const resolved = context.resolveSkill?.(id);
      if (!isSkillResult(resolved)) {
        throw configError(`unknown_bound_skill: ${id}`);
      }
      continue;
    }
    if (!isSkillResult(binding.skill)) {
      throw configError(`unresolvable_skill_spec: ${name}`);
    }
  }
}

/**
 * Per-`forward()` binding table, injection budget and interception ledger.
 *
 * Hosts do not build one: it is constructed by the actor loop from
 * `AxAgentOptions.callTimeSkills`.
 */
export class AxCallTimeSkillRuntime {
  private readonly bindings: ReadonlyMap<string, ResolvedBinding>;
  private readonly deps: AxCallTimeSkillDeps;
  private readonly counts = new Map<string, number>();
  private readonly registered = new Set<string>();
  private readonly pending: AxCallTimeSkillInjection[] = [];
  private total = 0;

  private constructor(
    bindings: ReadonlyMap<string, ResolvedBinding>,
    deps: AxCallTimeSkillDeps
  ) {
    this.bindings = bindings;
    this.deps = deps;
  }

  /** @internal Constructed by `axCallTimeSkillRuntime`. */
  static open(
    bindings: readonly AxCallTimeSkillBinding[],
    deps: AxCallTimeSkillDeps
  ): AxCallTimeSkillRuntime {
    axValidateCallTimeSkillBindings(bindings, {
      hasWorkingState: deps.workingState !== undefined,
      ...(deps.resolveSkill ? { resolveSkill: deps.resolveSkill } : {}),
    });
    const resolved = new Map<string, ResolvedBinding>();
    for (const binding of bindings) {
      // `axValidateCallTimeSkillBindings` already refused an id that does not
      // resolve and an inline skill with no content, so both branches are
      // total here.
      const skill =
        typeof binding.skill === 'string'
          ? (deps.resolveSkill!(binding.skill.trim()) as AxAgentSkillResult)
          : binding.skill;
      if (typeof binding.skill === 'string' && deps.admitSkill) {
        // Fail-closed and LOUD. Silently dropping the skill while still
        // intercepting would leave the actor blocked on a call it may not make
        // with no procedure to read, which is worse than either alternative;
        // silently executing would make the two catalog gates advisory.
        const admission = deps.admitSkill(binding.skill.trim());
        if (admission === 'ineligible') {
          throw configError(`ineligible_bound_skill: ${binding.skill.trim()}`);
        }
        if (admission === 'denied') {
          throw configError(`denied_bound_skill: ${binding.skill.trim()}`);
        }
      }
      resolved.set(binding.qualifiedName, {
        qualifiedName: binding.qualifiedName,
        skill,
        skillId: skillIdOf(skill),
        maxInjections: binding.maxInjections ?? DEFAULT_MAX_INJECTIONS,
        ...(binding.when ? { when: binding.when } : {}),
      });
    }
    return new AxCallTimeSkillRuntime(resolved, deps);
  }

  /**
   * Every bound qualified name — an inspection view for tests and for a host
   * auditing what a run intercepted.
   *
   * NOT the speculation exclusion: that is driven per registration site by
   * `register()` returning a hook, and `wrapFunction` installing no adapter
   * when it did. Two mechanisms answering the same question could drift; one
   * value carries both halves, and this accessor reads it rather than deciding
   * anything.
   */
  public bound(): ReadonlySet<string> {
    return new Set(this.bindings.keys());
  }

  /** @see bound — inspection only, never the dispatch decision. */
  public isBound(qualifiedName: string): boolean {
    return this.bindings.has(qualifiedName);
  }

  /**
   * Called at EVERY registration site, bound or not, so that a binding naming
   * a callable that does not exist can be refused by `finishRegistration()`.
   * Returns the dispatch-site hook for a bound callable, `undefined` for an
   * unbound one.
   */
  public register(qualifiedName: string): AxCallTimeSkillHook | undefined {
    this.registered.add(qualifiedName);
    if (!this.bindings.has(qualifiedName)) return undefined;
    return () => this.intercept(qualifiedName);
  }

  /**
   * Refuse a binding that named no registered callable. Runs at run start,
   * once the full callable surface exists — a typo would otherwise be a
   * silent no-op for the whole run.
   */
  public finishRegistration(): void {
    for (const name of this.bindings.keys()) {
      if (!this.registered.has(name)) {
        throw configError(`unknown_bound_callable: ${name}`);
      }
    }
  }

  /**
   * The dispatch-site decision. Returns the frozen marker to hand back to the
   * actor's code, or `undefined` to fall through to the normal call path.
   */
  private intercept(
    qualifiedName: string
  ): AxCallTimeSkillNotExecuted | undefined {
    const binding = this.bindings.get(qualifiedName);
    if (!binding) return undefined;
    const used = this.counts.get(qualifiedName) ?? 0;
    // Budget spent: the tool executes. One nudge, then normal operation.
    if (used >= binding.maxInjections) return undefined;
    if (binding.when) {
      let allow: boolean;
      try {
        const state = this.deps.workingState?.();
        // `when` without working state is refused at construction; falling
        // through here rather than inventing an empty document keeps the
        // unreachable case on the "behaves exactly as an unbound callable"
        // side.
        if (!state) return undefined;
        allow = binding.when(state) === true;
      } catch {
        // A host predicate that throws is a HOST bug, not a tool failure.
        // `intercept()` runs synchronously inside the actor's `await
        // tool(...)`, so a propagated throw becomes an `isError` turn tagged
        // `'error'`, feeds `noteActorTurnErrorState` and escalates the
        // executor model — the exact outcome "return, don't throw" exists to
        // prevent. Worse, the budget is spent AFTER this point, so an
        // escalating turn would repeat unboundedly. Fall through to the normal
        // call path: the callable behaves exactly as an unbound one.
        return undefined;
      }
      if (!allow) return undefined;
    }
    this.counts.set(qualifiedName, used + 1);
    this.total += 1;
    const guidance = axCallTimeSkillGuidance(qualifiedName, binding.skillId);
    this.pending.push({
      qualifiedName,
      skillId: binding.skillId,
      skill: binding.skill,
      guidance,
    });
    return Object.freeze({
      __axNotExecuted: true,
      reason: 'skill_injected',
      qualifiedName,
      skillId: binding.skillId,
      guidance,
    } as const);
  }

  /**
   * Interceptions recorded since the last drain, in order. The loop drains
   * once per turn so the skill is ingested and the guidance is appended with
   * that turn's number.
   */
  public drain(): readonly AxCallTimeSkillInjection[] {
    if (this.pending.length === 0) return [];
    return this.pending.splice(0, this.pending.length);
  }

  /** Interceptions so far this run, in total or for one callable. */
  public injections(qualifiedName?: string): number {
    if (qualifiedName === undefined) return this.total;
    return this.counts.get(qualifiedName) ?? 0;
  }
}

/**
 * Open the per-`forward()` call-time skill table. Validates the bindings and
 * resolves every skill id against the run's effective catalog.
 */
export const axCallTimeSkillRuntime = (
  bindings: readonly AxCallTimeSkillBinding[],
  deps: Readonly<AxCallTimeSkillDeps>
): AxCallTimeSkillRuntime => AxCallTimeSkillRuntime.open(bindings, deps);
