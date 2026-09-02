import type {
  AxSkillPreconditionCheck,
  AxSkillProvenance,
} from '../../authority/skillProvenance.js';
import type { AxExample } from '../common_types.js';

/**
 * `'actor'` guidance may enter the actor prompt. `'optimizer'` guidance is
 * diagnostic evidence for the reflector and curator and is structurally omitted
 * from every actor render path. Absent means `'actor'`, so legacy playbooks
 * render byte-identically.
 *
 * SCOPE, stated as a non-guarantee: this tier gates ARTIFACTS, not TEXT. The
 * curator is deliberately shown optimizer-tier content and can emit a new
 * bullet paraphrasing it. Verbatim copy, supersede-swap, and merge-survivor
 * promotion are blocked; paraphrase cannot be. Do not describe this tier as
 * information-flow control.
 */
export type AxACEBulletVisibility = 'actor' | 'optimizer';

export type AxACEApplicability = {
  /** Conditions that must all be present before this guidance is rendered. */
  allOf?: string[];
  /** At least one of these conditions must be present before rendering. */
  anyOf?: string[];
  /** Conditions that make this guidance inapplicable. */
  noneOf?: string[];
};

export type AxACEProvenance = {
  source: 'compile' | 'online' | 'agent-evolve' | 'manual';
  sourceRunId?: string;
  feedbackIds?: string[];
};

export type AxACEVerificationResult = {
  verifierId: string;
  testId?: string;
  result: 'passed' | 'failed' | 'unknown';
  timestamp?: string;
  /** Host/evaluator summary, trimmed to 500 characters on trusted updates. */
  summary?: string;
};

export type AxACEBulletLifecycle = {
  status?: 'active' | 'deprecated' | 'superseded';
  expiresAt?: string;
  supersededBy?: string;
  reason?: string;
};

/** Auditable, non-executable procedural-memory metadata. */
export type AxACEBulletEvidence = {
  confidence?: number;
  evidenceCount?: number;
  applicability?: AxACEApplicability;
  provenance?: AxACEProvenance[];
  verification?: AxACEVerificationResult[];
  lifecycle?: AxACEBulletLifecycle;
  /**
   * Host-written. The authority facts this bullet's source trajectory used.
   * HOST-ONLY: `axRedactPlaybookForModel` strips this before any model-facing
   * serialization. It carries grant ids, receipt ids and request digests, and
   * must never reach a provider.
   */
  authorityProvenance?: AxSkillProvenance;
};

/**
 * Evidence supplied by a trusted host/evaluator caller. This is an authority
 * boundary, not a cryptographic attestation.
 */
export type AxACEHostEvidence = {
  source?: AxACEProvenance['source'];
  sourceRunId?: string;
  feedbackIds?: readonly string[];
  evidenceCount?: number;
  confidence?: number;
  verification?: readonly AxACEVerificationResult[];
  /**
   * Host-only promotion path. The curator can never set this to `'actor'`:
   * `AxACECuratorOperation.visibility` is typed `'optimizer'` and
   * runtime-checked. Applied to both created and updated bullets.
   */
  visibility?: AxACEBulletVisibility;
  /** Host-written authority facts for the bullets this operation writes. */
  authorityProvenance?: AxSkillProvenance;
};

/**
 * Individual playbook bullet with metadata used for incremental updates.
 * Mirrors the structure described in the ACE paper (Section 3.1).
 */
export interface AxACEBullet extends Record<string, unknown> {
  id: string;
  section: string;
  content: string;
  helpfulCount: number;
  harmfulCount: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Starts at 1 for evidence-aware bullets and increments on every update. */
  revision?: number;
  /** Prior revision and explicit bullet supersession links. */
  lineage?: {
    previousRevision?: number;
    supersedes?: string[];
  };
  evidence?: AxACEBulletEvidence;
  /**
   * Absent means actor-visible. Validated on every mutation: a value that is
   * not exactly `'actor'` or `'optimizer'` throws, so a malformed tier fails
   * closed rather than defaulting to actor-visible.
   */
  visibility?: AxACEBulletVisibility;
}

/**
 * Aggregated ACE playbook structure grouped by sections.
 */
export interface AxACEPlaybook {
  version: number;
  sections: Record<string, AxACEBullet[]>;
  stats: {
    bulletCount: number;
    helpfulCount: number;
    harmfulCount: number;
    tokenEstimate: number;
  };
  updatedAt: string;
  description?: string;
}

/**
 * Generator output format (Appendix B of the paper) distilled to core fields.
 */
export interface AxACEGeneratorOutput extends Record<string, unknown> {
  reasoning: string;
  answer: unknown;
  bulletIds: string[];
  trajectory?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reflection payload, mapping to the Reflector JSON schema in the paper.
 */
export interface AxACEReflectionOutput extends Record<string, unknown> {
  reasoning: string;
  errorIdentification: string;
  rootCauseAnalysis: string;
  correctApproach: string;
  keyInsight: string;
  bulletTags: { id: string; tag: 'helpful' | 'harmful' | 'neutral' }[];
  metadata?: Record<string, unknown>;
}

/**
 * Curator operations emitted as deltas (Section 3.1).
 */
export type AxACECuratorOperationType = 'ADD' | 'UPDATE' | 'REMOVE';

export interface AxACECuratorOperation {
  type: AxACECuratorOperationType;
  section: string;
  bulletId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  /**
   * Model-editable guidance metadata. Provenance, evidence counts, and
   * verification receipts are ignored here and supplied by the host.
   */
  evidence?: Pick<
    AxACEBulletEvidence,
    'confidence' | 'applicability' | 'lifecycle'
  >;
  /** Existing bullets made obsolete by this ADD/UPDATE. */
  supersedes?: string[];
  /**
   * Model-requestable downgrade only. The literal type makes promotion to
   * `'actor'` unexpressible in TypeScript, and `assertCuratorOperation`
   * enforces the same for parsed LLM JSON, which is a cast, not a parse.
   */
  visibility?: 'optimizer';
}

export interface AxACECuratorOutput extends Record<string, unknown> {
  reasoning: string;
  operations: AxACECuratorOperation[];
  metadata?: Record<string, unknown>;
}

/**
 * Runtime feedback captured after each generator rollout for online updates.
 */
export interface AxACEFeedbackEvent {
  /** Host-generated identifier used by bullet provenance. */
  id?: string;
  sourceRunId?: string;
  example: AxExample;
  prediction: unknown;
  score: number;
  generatorOutput: AxACEGeneratorOutput;
  reflection?: AxACEReflectionOutput;
  curator?: AxACECuratorOutput;
  timestamp: string;
}

/**
 * Configuration options specific to ACE inside Ax.
 */
export interface AxACEOptions {
  /**
   * Maximum number of epochs for offline adaptation.
   */
  maxEpochs?: number;
  /**
   * Maximum reflector refinement rounds (paper uses up to 5).
   */
  maxReflectorRounds?: number;
  /**
   * Maximum bullets allowed in any section before triggering pruning.
   */
  maxSectionSize?: number;
  /**
   * Reserved threshold value; current dedupe uses normalized exact-content match.
   */
  similarityThreshold?: number;
  /**
   * Whether to automatically create sections when curator emits new ones.
   */
  allowDynamicSections?: boolean;
  /**
   * Initial playbook supplied by the caller.
   */
  initialPlaybook?: AxACEPlaybook;
  /**
   * Maximum serialized characters per field stored in ACE trajectories.
   */
  maxSerializedFieldChars?: number;
  /** Optional host run identifier attached to compile-generated provenance. */
  sourceRunId?: string;
  /**
   * Stamped onto every bullet this engine writes, created or updated. Leave
   * unset for legacy behaviour: no `visibility` field is written at all.
   */
  defaultBulletVisibility?: AxACEBulletVisibility;
}

/** One retrieval-time precondition decision recorded by the actor projection. */
export type AxACEPreconditionDecision = Readonly<{
  bulletId: string;
  section: string;
  check: AxSkillPreconditionCheck;
}>;

/**
 * A playbook that has been projected for the actor.
 *
 * The `kind` field is a LABEL, not the enforcement — it is a public string
 * literal and any caller can write it. The enforcement is a module-private
 * brand registered by `axProjectActorPlaybook` and checked by
 * `axRenderActorPlaybook`, exactly as authority snapshots are branded. An
 * unbranded view — including one a host deserialized from JSON — throws.
 */
export type AxACEActorPlaybookView = Readonly<{
  readonly kind: 'ax-ace-actor-playbook-view';
  readonly playbook: AxACEPlaybook;
  readonly decisions: readonly AxACEPreconditionDecision[];
}>;

/**
 * Serialized artifact saved after optimization for future reuse.
 */
export interface AxACEOptimizationArtifact {
  playbook: AxACEPlaybook;
  feedback: AxACEFeedbackEvent[];
  history: {
    source?: AxACEProvenance['source'];
    epoch: number;
    exampleIndex: number;
    operations: AxACECuratorOperation[];
    /**
     * Ids of the bullets this delta created or updated. ADD operations get
     * their ids assigned at apply time, so the operations alone cannot be
     * mapped back to surviving bullets — this field can.
     */
    updatedBulletIds?: string[];
    /** Before/after snapshots make revision history independently auditable. */
    changes?: {
      bulletId: string;
      before?: AxACEBullet;
      after?: AxACEBullet;
    }[];
  }[];
}
