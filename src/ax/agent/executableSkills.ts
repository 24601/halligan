import type { AxAgentFunction } from './agentInternal/agentStateTypes.js';
import { rankDocuments } from './agentInternal/relevanceRanker.js';

export type AxExecutableSkillLifecycle =
  | 'active'
  | 'inactive'
  | 'deprecated'
  | 'retired';

/** Host-owned compatibility requirements expressed as exact, canonical IDs. */
export type AxExecutableSkillRequirements = {
  /** Preconditions the host has established for this invocation context. */
  preconditions?: readonly string[];
  /** Required tool IDs, including a version in the ID when compatibility needs it. */
  tools?: readonly string[];
  /** Compatible environment IDs. At least one must match when specified. */
  environments?: readonly string[];
  /** Required protocol IDs, including a version in the ID when compatibility needs it. */
  protocols?: readonly string[];
  /** Required host capabilities. */
  capabilities?: readonly string[];
  /** Required host-granted authorities. */
  authorities?: readonly string[];
};

/**
 * Metadata for a host-owned executable skill. The function remains an ordinary
 * AxAgentFunction: this contract neither loads code nor changes its execution.
 */
export type AxExecutableSkillArtifact = {
  /** Stable identity within the host's artifact store. */
  id: string;
  /** Immutable revision identifier. Ax treats versions as opaque strings. */
  version: string;
  name: string;
  description: string;
  function: AxAgentFunction;
  requirements?: AxExecutableSkillRequirements;
  /** Host-verifiable receipt references required for selection. */
  verifierReceiptRefs?: readonly string[];
  /** Informational lineage; never used to establish admission or authority. */
  provenance?: Readonly<{
    source: string;
    createdAt?: string;
    createdBy?: string;
    derivedFrom?: readonly string[];
  }>;
  knownFailureModes?: readonly string[];
  lifecycle?: AxExecutableSkillLifecycle;
  expiresAt?: string;
  deprecatedAt?: string;
  /** Artifact reference (`id@version`) that replaces this revision. */
  supersededBy?: string;
};

/** Host-owned facts used to admit and compatibility-check executable skills. */
export type AxExecutableSkillContext = {
  /** Exact artifact references (`id@version`) admitted by trusted host policy. */
  admittedArtifacts: readonly string[];
  preconditions?: readonly string[];
  tools?: readonly string[];
  environment?: string;
  protocols?: readonly string[];
  capabilities?: readonly string[];
  authorities?: readonly string[];
  acceptedVerifierReceiptRefs?: readonly string[];
  /** ISO timestamp used for deterministic expiry/deprecation checks. */
  now?: string;
};

export type AxExecutableSkillExclusionReason =
  | 'malformed'
  | 'duplicate_ref'
  | 'not_admitted'
  | 'inactive'
  | 'deprecated'
  | 'retired'
  | 'expired'
  | 'superseded'
  | 'missing_precondition'
  | 'missing_tool'
  | 'incompatible_environment'
  | 'missing_protocol'
  | 'missing_capability'
  | 'missing_authority'
  | 'unaccepted_verifier_receipt';

export type AxExecutableSkillInspection = {
  ref?: string;
  id?: string;
  version?: string;
  name?: string;
  eligible: boolean;
  selected: boolean;
  reasons: readonly AxExecutableSkillExclusionReason[];
};

export type AxSelectExecutableSkillsOptions = {
  /** Optional lexical task query. Omit to return every eligible artifact. */
  query?: string;
  /** Maximum selected artifacts after compatibility filtering. Default 3. */
  topK?: number;
};

export type AxExecutableSkillSelection = {
  artifacts: AxExecutableSkillArtifact[];
  inspection: AxExecutableSkillInspection[];
};

type ValidArtifact = AxExecutableSkillArtifact & {
  id: string;
  version: string;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function hasStringArray(value: unknown): value is readonly string[] {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => isNonEmptyString(entry)))
  );
}

function isValidArtifact(value: unknown): value is ValidArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Record<string, unknown>;
  const fn = artifact.function as Record<string, unknown> | undefined;
  const requirements = artifact.requirements as
    | Record<string, unknown>
    | undefined;
  const provenance = artifact.provenance as Record<string, unknown> | undefined;
  const lifecycle = artifact.lifecycle;
  return (
    isNonEmptyString(artifact.id) &&
    isNonEmptyString(artifact.version) &&
    isNonEmptyString(artifact.name) &&
    isNonEmptyString(artifact.description) &&
    !!fn &&
    isNonEmptyString(fn.name) &&
    typeof fn.func === 'function' &&
    (lifecycle === undefined ||
      lifecycle === 'active' ||
      lifecycle === 'inactive' ||
      lifecycle === 'deprecated' ||
      lifecycle === 'retired') &&
    hasStringArray(artifact.verifierReceiptRefs) &&
    hasStringArray(artifact.knownFailureModes) &&
    (artifact.expiresAt === undefined ||
      isNonEmptyString(artifact.expiresAt)) &&
    (artifact.deprecatedAt === undefined ||
      isNonEmptyString(artifact.deprecatedAt)) &&
    (artifact.supersededBy === undefined ||
      isNonEmptyString(artifact.supersededBy)) &&
    (!requirements ||
      (hasStringArray(requirements.preconditions) &&
        hasStringArray(requirements.tools) &&
        hasStringArray(requirements.environments) &&
        hasStringArray(requirements.protocols) &&
        hasStringArray(requirements.capabilities) &&
        hasStringArray(requirements.authorities))) &&
    (!provenance || isNonEmptyString(provenance.source))
  );
}

function missingAny(
  required: readonly string[] | undefined,
  available: ReadonlySet<string>
): boolean {
  return required?.some((item) => !available.has(item)) ?? false;
}

function parseDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Stable reference used by host admission, receipts, and supersession links. */
export function axExecutableSkillRef(
  artifact: Pick<AxExecutableSkillArtifact, 'id' | 'version'>
): string {
  return `${artifact.id}@${artifact.version}`;
}

/**
 * Select host-admitted executable skills after lifecycle and exact-ID
 * compatibility checks. Malformed values fail closed and remain inspectable.
 */
export function axSelectExecutableSkills(
  catalog: readonly unknown[],
  context: AxExecutableSkillContext,
  options: AxSelectExecutableSkillsOptions = {}
): AxExecutableSkillSelection {
  const admitted = new Set(context.admittedArtifacts);
  const preconditions = new Set(context.preconditions ?? []);
  const tools = new Set(context.tools ?? []);
  const protocols = new Set(context.protocols ?? []);
  const capabilities = new Set(context.capabilities ?? []);
  const authorities = new Set(context.authorities ?? []);
  const receipts = new Set(context.acceptedVerifierReceiptRefs ?? []);
  const now = parseDate(context.now) ?? Date.now();
  const refCounts = new Map<string, number>();

  for (const value of catalog) {
    if (!isValidArtifact(value)) continue;
    const ref = axExecutableSkillRef(value);
    refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
  }

  const valid: Array<{
    artifact: ValidArtifact;
    inspection: AxExecutableSkillInspection;
  }> = [];
  const inspection: AxExecutableSkillInspection[] = [];

  for (const value of catalog) {
    if (!isValidArtifact(value)) {
      inspection.push({
        eligible: false,
        selected: false,
        reasons: ['malformed'],
      });
      continue;
    }
    const ref = axExecutableSkillRef(value);
    const requirements = value.requirements;
    const reasons: AxExecutableSkillExclusionReason[] = [];
    const expiresAt = parseDate(value.expiresAt);
    const deprecatedAt = parseDate(value.deprecatedAt);

    if ((refCounts.get(ref) ?? 0) > 1) reasons.push('duplicate_ref');
    if (!admitted.has(ref)) reasons.push('not_admitted');
    if (value.lifecycle === 'inactive') reasons.push('inactive');
    if (value.lifecycle === 'deprecated') reasons.push('deprecated');
    if (value.lifecycle === 'retired') reasons.push('retired');
    if (value.expiresAt !== undefined && expiresAt === undefined)
      reasons.push('malformed');
    else if (expiresAt !== undefined && expiresAt <= now)
      reasons.push('expired');
    if (value.deprecatedAt !== undefined && deprecatedAt === undefined)
      reasons.push('malformed');
    else if (deprecatedAt !== undefined && deprecatedAt <= now)
      reasons.push('deprecated');
    if (value.supersededBy) reasons.push('superseded');
    if (missingAny(requirements?.preconditions, preconditions))
      reasons.push('missing_precondition');
    if (missingAny(requirements?.tools, tools)) reasons.push('missing_tool');
    if (
      requirements?.environments?.length &&
      (!context.environment ||
        !requirements.environments.includes(context.environment))
    )
      reasons.push('incompatible_environment');
    if (missingAny(requirements?.protocols, protocols))
      reasons.push('missing_protocol');
    if (missingAny(requirements?.capabilities, capabilities))
      reasons.push('missing_capability');
    if (missingAny(requirements?.authorities, authorities))
      reasons.push('missing_authority');
    if (missingAny(value.verifierReceiptRefs, receipts))
      reasons.push('unaccepted_verifier_receipt');

    const entry: AxExecutableSkillInspection = {
      ref,
      id: value.id,
      version: value.version,
      name: value.name,
      eligible: reasons.length === 0,
      selected: false,
      reasons: [...new Set(reasons)],
    };
    inspection.push(entry);
    valid.push({ artifact: value, inspection: entry });
  }

  const candidates = valid.filter((entry) => entry.inspection.eligible);
  const query = options.query?.trim();
  const ranked = query
    ? rankDocuments(
        query,
        candidates.map(({ artifact }) => ({
          id: axExecutableSkillRef(artifact),
          fields: [
            { text: artifact.id, identifier: true },
            { text: artifact.name, weight: 2 },
            { text: artifact.description, weight: 2 },
          ],
        })),
        {
          topK: options.topK ?? 3,
          minScore: 0,
          marginRatio: 0,
          minDocs: 1,
        }
      ).map((entry) => entry.id)
    : candidates
        .map(({ artifact }) => axExecutableSkillRef(artifact))
        .sort()
        .slice(0, options.topK ?? candidates.length);
  const selectedRefs = new Set(ranked);
  const artifacts = candidates
    .filter(({ artifact }) => selectedRefs.has(axExecutableSkillRef(artifact)))
    .sort(
      (left, right) =>
        ranked.indexOf(axExecutableSkillRef(left.artifact)) -
        ranked.indexOf(axExecutableSkillRef(right.artifact))
    )
    .map(({ artifact, inspection: entry }) => {
      entry.selected = true;
      return artifact;
    });

  return { artifacts, inspection };
}
