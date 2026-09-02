import type {
  AxSkillAuthoritySnapshot,
  AxSkillPreconditionCheck,
  AxSkillPreconditionPolicy,
} from '../authority/skillProvenance.js';
import {
  axRecheckSkillProvenance,
  axSkillPreconditionGuidanceDefaults,
} from '../authority/skillProvenance.js';
import type { AxAgentCatalogSkill } from './agentInternal/skillsTypes.js';
import type {
  AxAgentSkillCostProfile,
  AxAgentSkillRankingWeights,
} from './skillCost.js';
import { axSkillValueScore } from './skillCost.js';

/** `'kernel'` is always loaded within the token budget. Default `'indexed'`. */
export type AxAgentSkillTier = 'kernel' | 'indexed';

/** Host-declared eligibility facts. Ax never probes the environment. */
export type AxAgentSkillRequirements = Readonly<{
  env?: readonly string[];
  bins?: readonly string[];
  /** At least one must be present. */
  anyBins?: readonly string[];
  os?: readonly string[];
  capabilities?: readonly string[];
}>;

/**
 * The host's declaration of what this process actually has. `src/ax` is
 * browser-compatible and never reads `process.env` or `os`.
 */
export type AxAgentSkillEnvironment = Readonly<{
  env?: readonly string[];
  bins?: readonly string[];
  os?: string;
  capabilities?: readonly string[];
}>;

export type AxAgentSkillRequirementFailure = Readonly<{
  field: 'env' | 'bins' | 'anyBins' | 'os' | 'capabilities';
  /** The exact declared tokens that were not satisfied, sorted. */
  missing: readonly string[];
}>;

export type AxAgentSkillEligibility = Readonly<{
  eligible: boolean;
  unmet: readonly AxAgentSkillRequirementFailure[];
}>;

/** Kernel token ceiling when the caller names none. */
export const AX_DEFAULT_KERNEL_TOKEN_BUDGET = 8000;

function sortedMissing(
  required: readonly string[] | undefined,
  available: ReadonlySet<string>
): readonly string[] {
  if (!required?.length) return [];
  return [...new Set(required.filter((token) => !available.has(token)))].sort();
}

/**
 * The `skills check <name>` diagnosis, as a pure function. An empty `requires`
 * object is eligible: an absent declaration must never become an accidental
 * deny.
 */
export function axCheckSkillRequirements(
  requires: Readonly<AxAgentSkillRequirements> | undefined,
  environment: Readonly<AxAgentSkillEnvironment> | undefined
): AxAgentSkillEligibility {
  if (!requires) {
    return Object.freeze({ eligible: true, unmet: Object.freeze([]) });
  }
  const env = new Set(environment?.env ?? []);
  const bins = new Set(environment?.bins ?? []);
  const capabilities = new Set(environment?.capabilities ?? []);
  const unmet: AxAgentSkillRequirementFailure[] = [];

  const push = (
    field: AxAgentSkillRequirementFailure['field'],
    missing: readonly string[]
  ): void => {
    if (missing.length > 0) {
      unmet.push(Object.freeze({ field, missing: Object.freeze(missing) }));
    }
  };

  push('env', sortedMissing(requires.env, env));
  push('bins', sortedMissing(requires.bins, bins));
  if (requires.anyBins?.length) {
    const satisfied = requires.anyBins.some((bin) => bins.has(bin));
    if (!satisfied) {
      push('anyBins', [...new Set(requires.anyBins)].sort());
    }
  }
  if (requires.os?.length) {
    // Exact and case-sensitive: normalization is the host's job, and guessing
    // at it here is the first crack in "Ax does not author policy".
    const current = environment?.os;
    if (!current || !requires.os.includes(current)) {
      push('os', [...new Set(requires.os)].sort());
    }
  }
  push('capabilities', sortedMissing(requires.capabilities, capabilities));

  return Object.freeze({
    eligible: unmet.length === 0,
    unmet: Object.freeze(unmet),
  });
}

/**
 * The ONLY shape the Loaded Skills renderer accepts. `purpose?: never` and
 * `authorityProvenance?: never` make any optimizer-facing skill object
 * structurally unassignable, so optimizer-only fields cannot reach the actor
 * prompt by accident, by convention, or by a host passing the wrong object.
 */
export type AxAgentActorSkillView = Readonly<{
  id: string;
  name: string;
  content: string;
  purpose?: never;
  authorityProvenance?: never;
  /**
   * Set when a precondition re-check downgraded this skill to advisory.
   * Derived at render time and never persisted.
   */
  advisory?: string;
}>;

export function axActorSkillView(
  skill: Readonly<AxAgentCatalogSkill>,
  advisory?: string
): AxAgentActorSkillView {
  return Object.freeze({
    id: skill.id,
    name: skill.name,
    content: skill.content,
    ...(advisory ? { advisory } : {}),
  });
}

export type AxAgentSkillIndexEntry = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

export type AxAgentSkillSelectionOptions = Readonly<{
  environment?: Readonly<AxAgentSkillEnvironment>;
  /** Kernel token ceiling. Default 8000. */
  kernelTokenBudget?: number;
  ranking?: Readonly<AxAgentSkillRankingWeights>;
  costProfiles?: readonly Readonly<AxAgentSkillCostProfile>[];
  authority?: Readonly<AxSkillAuthoritySnapshot>;
  precondition?: Readonly<AxSkillPreconditionPolicy>;
  /** Authoritative clock for the re-check on this path. */
  now?: string;
}>;

export type AxAgentSkillSelection = Readonly<{
  /** Always-loaded skills, within budget. */
  kernel: readonly AxAgentActorSkillView[];
  /** One-line index of everything eligible and not in the kernel, id-sorted. */
  index: readonly AxAgentSkillIndexEntry[];
  /** Ineligible skills with their diagnosis. Never rendered to the actor. */
  hidden: readonly Readonly<{
    id: string;
    unmet: readonly AxAgentSkillRequirementFailure[];
  }>[];
  /** Kernel members demoted because the token budget was exhausted. */
  overflow: readonly Readonly<{ id: string; tokenEstimate: number }>[];
  /** Retrieval-time precondition outcomes, for `onContextEvent` reporting. */
  decisions: readonly Readonly<{
    id: string;
    check: AxSkillPreconditionCheck;
  }>[];
  kernelTokensUsed: number;
}>;

/** Deterministic 4-chars-per-token estimate, matching `estimateTokenCount`. */
export function axEstimateSkillTokens(
  skill: Readonly<AxAgentCatalogSkill>
): number {
  if (
    typeof skill.tokenEstimate === 'number' &&
    Number.isFinite(skill.tokenEstimate) &&
    skill.tokenEstimate >= 0
  ) {
    return Math.ceil(skill.tokenEstimate);
  }
  const text = `${skill.name}\n${skill.description ?? ''}\n${skill.content}`;
  return Math.ceil(text.length / 4);
}

/**
 * The eligible subset, in catalog order. Consumed by the kernel, by the
 * `### Available Skills` signature index, and by `discover({ skills })`, so an
 * ineligible skill is hidden from all three rather than only from the kernel.
 *
 * `requires` gating only. The authority re-check is the orthogonal second gate
 * and lives in `axSkillRetrievalGate`, because the two answer different
 * questions and a caller must be able to see which one hid a skill.
 */
export function axEligibleCatalogSkills(
  catalog: readonly Readonly<AxAgentCatalogSkill>[],
  environment?: Readonly<AxAgentSkillEnvironment>
): readonly AxAgentCatalogSkill[] {
  return catalog.filter(
    (skill) => axCheckSkillRequirements(skill.requires, environment).eligible
  );
}

const ADMITTED_CHECK: AxSkillPreconditionCheck = Object.freeze({
  outcome: 'admit' as const,
  failures: Object.freeze([]),
});

type AxCatalogAdmission = Readonly<{
  skill: AxAgentCatalogSkill;
  eligibility: AxAgentSkillEligibility;
  check: AxSkillPreconditionCheck;
}>;

/**
 * The ONE place the two catalog gates run. Every retrieval path routes through
 * it, so `discover({ skills })`, the `### Available Skills` index, the
 * relevance hint and the kernel can never disagree about whether a skill is
 * retrievable.
 */
function admitCatalogSkills(
  catalog: readonly Readonly<AxAgentCatalogSkill>[],
  options: Readonly<AxAgentSkillSelectionOptions> | undefined
): AxCatalogAdmission[] {
  const policy = options?.precondition ?? axSkillPreconditionGuidanceDefaults;
  return catalog.map((skill) => {
    const eligibility = axCheckSkillRequirements(
      skill.requires,
      options?.environment
    );
    const check =
      eligibility.eligible && options?.authority
        ? axRecheckSkillProvenance(
            skill.authorityProvenance,
            options.authority,
            policy,
            options.now
          )
        : ADMITTED_CHECK;
    return { skill, eligibility, check };
  });
}

/**
 * The retrieval-time authority re-check, in the shape every catalog path needs.
 *
 * `denied` is the fail-closed half: a skill the re-check parked or dropped is
 * removed from `discover({ skills })`, from the `### Available Skills` index and
 * from the relevance hint — not only from the kernel tier. `advisory` is the
 * downgrade half: it is derived here on every call and never serialized, so it
 * cannot arrive through `agent.setState()`.
 */
export type AxAgentSkillRetrievalGate = Readonly<{
  /** Ids the re-check parked or dropped. Never retrievable on any path. */
  denied: ReadonlySet<string>;
  /** Advisory lines for downgraded skills, keyed by id. */
  advisories: ReadonlyMap<string, string>;
  advisory: (id: string) => string | undefined;
}>;

export function axSkillRetrievalGate(
  catalog: readonly Readonly<AxAgentCatalogSkill>[],
  options?: Readonly<AxAgentSkillSelectionOptions>
): AxAgentSkillRetrievalGate {
  const denied = new Set<string>();
  const advisories = new Map<string, string>();
  for (const { skill, eligibility, check } of admitCatalogSkills(
    catalog,
    options
  )) {
    // `requires` gating is a separate gate with its own diagnosis; this one
    // reports only what the authority re-check decided.
    if (!eligibility.eligible) {
      continue;
    }
    if (check.outcome === 'park' || check.outcome === 'drop') {
      denied.add(skill.id);
    } else if (check.advisory) {
      advisories.set(skill.id, check.advisory);
    }
  }
  return Object.freeze({
    denied: denied as ReadonlySet<string>,
    advisories: advisories as ReadonlyMap<string, string>,
    advisory: (id: string) => advisories.get(id),
  });
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function axSelectCatalogSkills(
  catalog: readonly Readonly<AxAgentCatalogSkill>[],
  options?: Readonly<AxAgentSkillSelectionOptions>
): AxAgentSkillSelection {
  const budget = Math.max(
    0,
    options?.kernelTokenBudget ?? AX_DEFAULT_KERNEL_TOKEN_BUDGET
  );
  const profiles = new Map(
    (options?.costProfiles ?? []).map((profile) => [profile.id, profile])
  );
  const hidden: {
    id: string;
    unmet: readonly AxAgentSkillRequirementFailure[];
  }[] = [];
  const decisions: { id: string; check: AxSkillPreconditionCheck }[] = [];
  const admitted: {
    skill: AxAgentCatalogSkill;
    advisory?: string;
  }[] = [];

  for (const { skill, eligibility, check } of admitCatalogSkills(
    catalog,
    options
  )) {
    if (!eligibility.eligible) {
      hidden.push({ id: skill.id, unmet: eligibility.unmet });
      continue;
    }
    if (check.outcome !== 'admit') {
      decisions.push({ id: skill.id, check });
    }
    if (check.outcome === 'admit') {
      admitted.push({ skill });
    } else if (check.outcome === 'downgrade') {
      admitted.push({
        skill,
        ...(check.advisory ? { advisory: check.advisory } : {}),
      });
    }
  }

  // Kernel ordering holds similarity at 1: there is no query, so the order is
  // purely value over cost, and ties break on id for prefix-cache stability.
  const kernelPool = admitted
    .filter((entry) => entry.skill.tier === 'kernel')
    .sort((left, right) => {
      const delta =
        axSkillValueScore(1, profiles.get(right.skill.id), options?.ranking) -
        axSkillValueScore(1, profiles.get(left.skill.id), options?.ranking);
      return delta !== 0 ? delta : compareIds(left.skill.id, right.skill.id);
    });

  const kernel: AxAgentActorSkillView[] = [];
  const overflow: { id: string; tokenEstimate: number }[] = [];
  const kernelIds = new Set<string>();
  let kernelTokensUsed = 0;
  for (const entry of kernelPool) {
    const tokenEstimate = axEstimateSkillTokens(entry.skill);
    if (kernelTokensUsed + tokenEstimate <= budget) {
      kernel.push(axActorSkillView(entry.skill, entry.advisory));
      kernelIds.add(entry.skill.id);
      kernelTokensUsed += tokenEstimate;
    } else {
      overflow.push({ id: entry.skill.id, tokenEstimate });
    }
  }
  kernel.sort((left, right) => compareIds(left.id, right.id));

  const index = admitted
    .filter((entry) => !kernelIds.has(entry.skill.id))
    .map((entry) =>
      Object.freeze({
        id: entry.skill.id,
        name: entry.skill.name,
        ...(entry.skill.description
          ? { description: entry.skill.description }
          : {}),
      })
    )
    .sort((left, right) => compareIds(left.id, right.id));

  return Object.freeze({
    kernel: Object.freeze(kernel),
    index: Object.freeze(index),
    hidden: Object.freeze(hidden.map((entry) => Object.freeze(entry))),
    overflow: Object.freeze(overflow.map((entry) => Object.freeze(entry))),
    decisions: Object.freeze(decisions.map((entry) => Object.freeze(entry))),
    kernelTokensUsed,
  });
}

/** Pure `skills promote`. Total, not throwing: an over-budget promotion is refused. */
export function axPromoteSkill(
  catalog: readonly Readonly<AxAgentCatalogSkill>[],
  id: string,
  options?: Readonly<{ kernelTokenBudget?: number }>
): Readonly<{
  catalog: readonly AxAgentCatalogSkill[];
  kernelTokensUsed: number;
  kernelTokenBudget: number;
  accepted: boolean;
}> {
  const kernelTokenBudget = Math.max(
    0,
    options?.kernelTokenBudget ?? AX_DEFAULT_KERNEL_TOKEN_BUDGET
  );
  const target = catalog.find((skill) => skill.id === id);
  const currentKernel = catalog.filter(
    (skill) => skill.tier === 'kernel' && skill.id !== id
  );
  const used = currentKernel.reduce(
    (total, skill) => total + axEstimateSkillTokens(skill),
    0
  );
  if (!target || target.tier === 'kernel') {
    return Object.freeze({
      catalog: catalog.map((skill) => ({ ...skill })),
      kernelTokensUsed: used + (target ? axEstimateSkillTokens(target) : 0),
      kernelTokenBudget,
      accepted: Boolean(target),
    });
  }
  const cost = axEstimateSkillTokens(target);
  if (used + cost > kernelTokenBudget) {
    return Object.freeze({
      catalog: catalog.map((skill) => ({ ...skill })),
      kernelTokensUsed: used,
      kernelTokenBudget,
      accepted: false,
    });
  }
  return Object.freeze({
    catalog: catalog.map((skill) =>
      skill.id === id ? { ...skill, tier: 'kernel' as const } : { ...skill }
    ),
    kernelTokensUsed: used + cost,
    kernelTokenBudget,
    accepted: true,
  });
}

/** Pure `skills demote`. Idempotent for a skill that is already indexed. */
export function axDemoteSkill(
  catalog: readonly Readonly<AxAgentCatalogSkill>[],
  id: string
): readonly AxAgentCatalogSkill[] {
  return catalog.map((skill) =>
    skill.id === id ? { ...skill, tier: 'indexed' as const } : { ...skill }
  );
}
