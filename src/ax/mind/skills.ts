import type {
  AxAgentCatalogSkill,
  AxAgentSkillResult,
} from '../agent/agentInternal/skillsTypes.js';
import { axTrajectoryUtf8ByteLength } from '../trajectory/util.js';
import type { AxMindSkill } from './types.js';

/** Default kernel budget, in the same estimated tokens as the selection. */
export const axDefaultMindKernelTokenBudget = 8_000;

export interface AxMindSkillEnvironment {
  readonly env: readonly string[];
  readonly capabilities: readonly string[];
  readonly os: string;
}

export interface AxMindSkillSelection {
  /** Rendered into the agent's always-present `skills` array. */
  readonly kernel: readonly Readonly<AxAgentSkillResult>[];
  /** Handed to the agent as `skillsCatalog`; loaded on demand. */
  readonly catalog: readonly Readonly<AxAgentCatalogSkill>[];
  /** Requirements unmet: hidden entirely, and reported. */
  readonly ineligible: readonly Readonly<{
    id: string;
    missing: readonly string[];
  }>[];
  /** Over budget: DEMOTED to the catalog, never truncated mid-body. */
  readonly demoted: readonly string[];
  readonly kernelTokens: number;
}

/**
 * One estimator for the whole selection, so the budget a host sets and the
 * usage it is told about are the same number. Four bytes per token is the
 * house heuristic; it is deliberately not a tokenizer.
 */
export function axMindSkillTokens(skill: Readonly<AxMindSkill>): number {
  return Math.ceil(
    axTrajectoryUtf8ByteLength(`${skill.name}\n${skill.content}`) / 4
  );
}

/**
 * Requirements are matched against HOST FACTS ONLY. A skill body that claims
 * a capability can never satisfy one -- model text is not evidence about the
 * machine it is running on.
 */
function unmet(
  skill: Readonly<AxMindSkill>,
  environment: Readonly<AxMindSkillEnvironment>
): readonly string[] {
  const missing: string[] = [];
  for (const name of skill.requires?.env ?? []) {
    if (!environment.env.includes(name)) missing.push(`env:${name}`);
  }
  for (const name of skill.requires?.capabilities ?? []) {
    if (!environment.capabilities.includes(name)) {
      missing.push(`capability:${name}`);
    }
  }
  const os = skill.requires?.os;
  if (os?.length && !os.includes(environment.os)) {
    missing.push(`os:${environment.os}`);
  }
  return missing;
}

export interface AxSelectMindSkillsOptions {
  readonly kernelIds: readonly string[];
  readonly tokenBudget?: number;
  readonly environment: Readonly<AxMindSkillEnvironment>;
}

/**
 * The kernel/catalog two-tier selector over `skillsCatalog`. Everything it
 * cannot fit is DEMOTED whole to the catalog and reported: a skill truncated
 * mid-body is worse than one the model has to ask for, because a half body
 * reads as complete.
 *
 * Priority is the `kernelIds` order the host declared. Once an entry does not
 * fit, every lower-priority entry is demoted too -- letting a small
 * low-priority skill leapfrog a large high-priority one would make the kernel
 * depend on body sizes instead of on the host's stated priority.
 */
export function axSelectMindSkills(
  skills: readonly Readonly<AxMindSkill>[],
  options: Readonly<AxSelectMindSkillsOptions>
): Readonly<AxMindSkillSelection> {
  const tokenBudget = options.tokenBudget ?? axDefaultMindKernelTokenBudget;
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const ineligible: Array<{ id: string; missing: readonly string[] }> = [];
  const eligible: Readonly<AxMindSkill>[] = [];
  for (const skill of skills) {
    const missing = unmet(skill, options.environment);
    if (missing.length) {
      ineligible.push(Object.freeze({ id: skill.id, missing }));
      continue;
    }
    eligible.push(skill);
  }
  const eligibleIds = new Set(eligible.map((skill) => skill.id));

  const kernel: Readonly<AxAgentSkillResult>[] = [];
  const demoted: string[] = [];
  const promoted = new Set<string>();
  let kernelTokens = 0;
  let full = false;
  for (const id of options.kernelIds) {
    const skill = byId.get(id);
    // An unknown id is not a demotion and not an eligibility failure: there is
    // nothing to demote. It is simply absent from both tiers.
    if (!skill || !eligibleIds.has(id) || promoted.has(id)) continue;
    const tokens = axMindSkillTokens(skill);
    if (full || kernelTokens + tokens > tokenBudget) {
      full = true;
      demoted.push(id);
      continue;
    }
    kernelTokens += tokens;
    promoted.add(id);
    kernel.push(
      Object.freeze({ id: skill.id, name: skill.name, content: skill.content })
    );
  }

  const catalog = eligible
    .filter((skill) => !promoted.has(skill.id))
    .map((skill) =>
      Object.freeze({
        id: skill.id,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        content: skill.content,
      })
    );
  return Object.freeze({
    kernel: Object.freeze(kernel),
    catalog: Object.freeze(catalog),
    ineligible: Object.freeze(ineligible),
    demoted: Object.freeze(demoted),
    kernelTokens,
  });
}
