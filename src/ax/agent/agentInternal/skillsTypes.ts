import type { AxAgentContextStage } from '../contextEvents.js';
import type {
  AxAgentSkillCostProfile,
  AxAgentVerificationBudget,
} from '../skillCost.js';

export type AxAgentSkillResult = {
  /** Stable identifier — dedup key, prompt label, and usage telemetry key. */
  id?: string;
  /** Human-readable title rendered in the Loaded Skills prompt section. */
  name: string;
  /** Opaque markdown body (frontmatter, if any, is not parsed). */
  content: string;
};

/**
 * A skill in a host-provided static catalog (`skillsCatalog` option). Unlike
 * `skills` (which preloads full content into the prompt), a catalog entry is
 * only loaded when matched — by the built-in local search that backs
 * `discover({ skills })` when no `onSkillsSearch` callback is provided, and by
 * the advisory relevance hint.
 */
export type AxAgentCatalogSkill = {
  /** Stable identifier — dedup key, prompt label, and usage telemetry key. */
  id: string;
  /** Human-readable title. */
  name: string;
  /** Optional short "when to use" description (high-signal for matching). */
  description?: string;
  /** Full markdown body returned when the skill is loaded. */
  content: string;
};

export type AxAgentSkillsSearchFn = (
  searches: readonly string[]
) => readonly AxAgentSkillResult[] | Promise<readonly AxAgentSkillResult[]>;

export type AxAgentUsedSkill = {
  /** Stable skill id present in the Loaded Skills prompt state. */
  id: string;
  /** Human-readable skill title. */
  name: string;
  /** Optional actor-declared explanation of how the skill influenced the run. */
  reason?: string;
  /** Actor stage that declared this skill as used. */
  stage: AxAgentContextStage;
  /**
   * Equal-split attribution across the ids declared in the same run. This is
   * attribution BY DECLARATION, not a causal measurement of what the skill
   * cost. Present only when cost accounting is enabled.
   */
  tokensAttributed?: number;
  wallMs?: number;
  verificationRounds?: number;
};

/**
 * One grouped option instead of eight loose ones on `AxAgentOptions`.
 *
 * `environment` is resolved ONCE at construction and held for the agent's
 * lifetime: the `### Available Skills` index is built at signature-build time,
 * and recomputing eligibility per run would churn the signature and therefore
 * the prompt cache. A host whose environment changed constructs a new agent.
 */
export type AxAgentSkillPolicy = Readonly<{
  costProfiles?: readonly Readonly<AxAgentSkillCostProfile>[];
  precondition?: Readonly<
    import('../../authority/skillProvenance.js').AxSkillPreconditionPolicy
  >;
  authoritySnapshot?: Readonly<
    import('../../authority/skillProvenance.js').AxSkillAuthoritySnapshot
  >;
  verificationBudget?: Readonly<AxAgentVerificationBudget>;
  /**
   * Injected clock for cost accounting and for the retrieval-time re-check on
   * this path. Defaults to the system clock.
   */
  now?: () => number;
}>;

export type AxAgentSkillCostCallback = (
  profiles: readonly Readonly<AxAgentSkillCostProfile>[]
) => void | Promise<void>;

export type AxAgentUsedSkillsCallback = (
  usedSkills: readonly AxAgentUsedSkill[]
) => void | Promise<void>;
