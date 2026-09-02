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
 */

import type {
  AxAgentCatalogSkill,
  AxAgentSkillResult,
} from './agentInternal/skillsTypes.js';
import type { AxWorkingStateDocument } from './workingState.js';
import { AxWorkingStateSchemaError } from './workingState.js';

/** Injections allowed for one callable in one run when the host names none. */
const DEFAULT_MAX_INJECTIONS = 1;

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
   * Injections allowed for this callable in one run. Default 1. The tool
   * executes normally on every call past the budget — the interception is a
   * one-shot nudge, never a gate.
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
    throw new AxWorkingStateSchemaError('call_time_skills_not_an_array');
  }
  const seen = new Set<string>();
  for (const binding of bindings as readonly AxCallTimeSkillBinding[]) {
    if (!binding || typeof binding !== 'object') {
      throw new AxWorkingStateSchemaError('invalid_call_time_skill_binding');
    }
    const name = binding.qualifiedName;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new AxWorkingStateSchemaError('invalid_bound_callable');
    }
    if (name.includes('*')) {
      // A glob would let one binding capture a callable registered later, and
      // interception changes a tool's contract. Exact names only.
      throw new AxWorkingStateSchemaError(`bound_callable_glob: ${name}`);
    }
    if (seen.has(name)) {
      throw new AxWorkingStateSchemaError(`duplicate_bound_callable: ${name}`);
    }
    seen.add(name);
    if (
      binding.maxInjections !== undefined &&
      (!Number.isInteger(binding.maxInjections) || binding.maxInjections < 1)
    ) {
      throw new AxWorkingStateSchemaError(
        `invalid_max_injections: ${String(binding.maxInjections)}`
      );
    }
    if (binding.when !== undefined) {
      if (typeof binding.when !== 'function') {
        throw new AxWorkingStateSchemaError(`invalid_when_predicate: ${name}`);
      }
      if (!context.hasWorkingState) {
        throw new AxWorkingStateSchemaError(
          `when_requires_working_state: ${name}`
        );
      }
    }
    if (typeof binding.skill === 'string') {
      const id = binding.skill.trim();
      if (!id) {
        throw new AxWorkingStateSchemaError(`unknown_bound_skill: ${name}`);
      }
      const resolved = context.resolveSkill?.(id);
      if (!isSkillResult(resolved)) {
        throw new AxWorkingStateSchemaError(`unknown_bound_skill: ${id}`);
      }
      continue;
    }
    if (!isSkillResult(binding.skill)) {
      throw new AxWorkingStateSchemaError(`unresolvable_skill_spec: ${name}`);
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
   * Every bound qualified name. A name in this set gets NO speculation
   * adapter, so the runtime's speculation path cannot bypass the
   * interception.
   */
  public bound(): ReadonlySet<string> {
    return new Set(this.bindings.keys());
  }

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
        throw new AxWorkingStateSchemaError(`unknown_bound_callable: ${name}`);
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
      const state = this.deps.workingState?.();
      // `when` without working state is refused at construction; falling
      // through here rather than inventing an empty document keeps the
      // unreachable case on the "behaves exactly as an unbound callable" side.
      if (!state) return undefined;
      if (!binding.when(state)) return undefined;
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
