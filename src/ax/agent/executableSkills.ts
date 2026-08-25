import type { AxAgentFunction } from './agentInternal/agentStateTypes.js';
import { rankDocuments } from './agentInternal/relevanceRanker.js';

const MAX_CATALOG_ENTRIES = 1000;
const MAX_LIST_ENTRIES = 128;
const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 2048;
const MAX_QUERY_CHARS = 4096;
const MAX_TOP_K = 100;

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= allowed.length && keys.every((key) => allowed.includes(key))
  );
}

export type AxExecutableSkillRef = Readonly<{ id: string; version: string }>;

export type AxExecutableSkillAuthority = Readonly<{
  issuer: string;
  audience: string;
  principal: string;
  tenant?: string;
  resource: string;
  action: string;
  delegationRef?: string;
}>;

export type AxExecutableSkillVerificationReceipt = Readonly<{
  ref: string;
  artifact: AxExecutableSkillRef;
  principal: string;
  issuer: string;
  audience: string;
  evaluation: string;
  verifiedAt: string;
  expiresAt: string;
}>;

export type AxExecutableSkillVerification =
  | Readonly<{ mode: 'receiptless' }>
  | Readonly<{
      mode: 'required';
      evaluation: string;
      receiptRefs: readonly string[];
      issuers: readonly string[];
    }>;

export type AxExecutableSkillLifecycle =
  | 'active'
  | 'inactive'
  | 'deprecated'
  | 'retired';

/** Host-owned compatibility requirements expressed as exact canonical facts. */
export type AxExecutableSkillRequirements = {
  preconditions?: readonly string[];
  tools?: readonly string[];
  /** At least one exact environment must match when specified. */
  environments?: readonly string[];
  protocols?: readonly string[];
  capabilities?: readonly string[];
  authorities?: readonly AxExecutableSkillAuthority[];
};

/** Metadata for one host-owned executable skill revision. */
export type AxExecutableSkillArtifact = {
  id: string;
  version: string;
  name: string;
  description: string;
  /** Opaque key resolved through the trusted host function registry. */
  functionRef: string;
  requirements?: AxExecutableSkillRequirements;
  /** Explicitly receiptless or bound to host-verified receipt records. */
  verification: AxExecutableSkillVerification;
  /** Informational lineage; never establishes admission or authority. */
  provenance?: Readonly<{
    source: string;
    createdAt?: string;
    createdBy?: string;
    derivedFrom?: readonly AxExecutableSkillRef[];
  }>;
  knownFailureModes?: readonly string[];
  lifecycle?: AxExecutableSkillLifecycle;
  expiresAt?: string;
  deprecatedAt?: string;
  supersededBy?: AxExecutableSkillRef;
};

/** Trusted host facts used to select and bind executable skill functions. */
export type AxExecutableSkillContext = {
  admittedArtifacts: readonly AxExecutableSkillRef[];
  principal: string;
  audience: string;
  preconditions?: readonly string[];
  tools?: readonly string[];
  environment?: string;
  protocols?: readonly string[];
  capabilities?: readonly string[];
  grantedAuthorities?: readonly AxExecutableSkillAuthority[];
  verifiedReceipts?: readonly AxExecutableSkillVerificationReceipt[];
  /** Canonical ISO timestamp, required for deterministic fail-closed checks. */
  now: string;
  /** Trusted registry lookup. Returned functions are snapshotted and frozen. */
  resolveFunction: (
    functionRef: string,
    artifact: AxExecutableSkillRef
  ) => AxAgentFunction | undefined;
};

export type AxExecutableSkillExclusionReason =
  | 'invalid_context'
  | 'invalid_options'
  | 'limit_exceeded'
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
  | 'missing_verification_receipt'
  | 'unresolved_function';

export type AxExecutableSkillInspection = {
  ref?: AxExecutableSkillRef;
  name?: string;
  eligible: boolean;
  selected: boolean;
  reasons: readonly AxExecutableSkillExclusionReason[];
  matchedVerifierReceiptRef?: string;
};

export type AxSelectedExecutableSkill = Readonly<{
  artifact: Readonly<AxExecutableSkillArtifact>;
  function: Readonly<AxAgentFunction>;
  matchedVerifierReceiptRef?: string;
}>;

export type AxSelectExecutableSkillsOptions = {
  query?: string;
  /** Maximum selected artifacts. Integer from 0 through 100; default 3. */
  topK?: number;
};

export type AxExecutableSkillSelection = {
  artifacts: AxSelectedExecutableSkill[];
  inspection: AxExecutableSkillInspection[];
};

const isBoundedString = (
  value: unknown,
  maxChars = MAX_ID_CHARS
): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxChars &&
  value === value.trim() &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

function isCanonicalDate(value: unknown): value is string {
  if (!isBoundedString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isStringList(value: unknown, maxChars = MAX_ID_CHARS): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_LIST_ENTRIES &&
      value.every((entry) => isBoundedString(entry, maxChars)) &&
      new Set(value).size === value.length)
  );
}

function isRef(value: unknown): value is AxExecutableSkillRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return (
    hasOnlyKeys(ref, ['id', 'version']) &&
    isBoundedString(ref.id) &&
    isBoundedString(ref.version)
  );
}

function refKey(ref: AxExecutableSkillRef): string {
  return JSON.stringify([ref.id, ref.version]);
}

function isAuthority(value: unknown): value is AxExecutableSkillAuthority {
  if (!value || typeof value !== 'object') return false;
  const authority = value as Record<string, unknown>;
  return (
    hasOnlyKeys(authority, [
      'issuer',
      'audience',
      'principal',
      'tenant',
      'resource',
      'action',
      'delegationRef',
    ]) &&
    isBoundedString(authority.issuer) &&
    isBoundedString(authority.audience) &&
    isBoundedString(authority.principal) &&
    (authority.tenant === undefined || isBoundedString(authority.tenant)) &&
    isBoundedString(authority.resource) &&
    isBoundedString(authority.action) &&
    (authority.delegationRef === undefined ||
      isBoundedString(authority.delegationRef))
  );
}

function authorityKey(authority: AxExecutableSkillAuthority): string {
  return JSON.stringify([
    authority.issuer,
    authority.audience,
    authority.principal,
    authority.tenant ?? null,
    authority.resource,
    authority.action,
    authority.delegationRef ?? null,
  ]);
}

function isAuthorityList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_LIST_ENTRIES &&
      value.every(isAuthority) &&
      new Set(value.map(authorityKey)).size === value.length)
  );
}

function isVerification(
  value: unknown
): value is AxExecutableSkillVerification {
  if (!value || typeof value !== 'object') return false;
  const verification = value as Record<string, unknown>;
  if (verification.mode === 'receiptless')
    return hasOnlyKeys(verification, ['mode']);
  return (
    hasOnlyKeys(verification, [
      'mode',
      'evaluation',
      'receiptRefs',
      'issuers',
    ]) &&
    verification.mode === 'required' &&
    isBoundedString(verification.evaluation) &&
    isStringList(verification.receiptRefs) &&
    Array.isArray(verification.receiptRefs) &&
    verification.receiptRefs.length > 0 &&
    isStringList(verification.issuers) &&
    Array.isArray(verification.issuers) &&
    verification.issuers.length > 0
  );
}

function isReceipt(
  value: unknown
): value is AxExecutableSkillVerificationReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return (
    hasOnlyKeys(receipt, [
      'ref',
      'artifact',
      'principal',
      'issuer',
      'audience',
      'evaluation',
      'verifiedAt',
      'expiresAt',
    ]) &&
    isBoundedString(receipt.ref) &&
    isRef(receipt.artifact) &&
    isBoundedString(receipt.principal) &&
    isBoundedString(receipt.issuer) &&
    isBoundedString(receipt.audience) &&
    isBoundedString(receipt.evaluation) &&
    isCanonicalDate(receipt.verifiedAt) &&
    isCanonicalDate(receipt.expiresAt) &&
    Date.parse(receipt.verifiedAt) < Date.parse(receipt.expiresAt)
  );
}

function isRequirements(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const requirements = value as Record<string, unknown>;
  return (
    hasOnlyKeys(requirements, [
      'preconditions',
      'tools',
      'environments',
      'protocols',
      'capabilities',
      'authorities',
    ]) &&
    isStringList(requirements.preconditions) &&
    isStringList(requirements.tools) &&
    isStringList(requirements.environments) &&
    isStringList(requirements.protocols) &&
    isStringList(requirements.capabilities) &&
    isAuthorityList(requirements.authorities)
  );
}

function isValidArtifact(value: unknown): value is AxExecutableSkillArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Record<string, unknown>;
  const provenance = artifact.provenance as Record<string, unknown> | undefined;
  const lifecycle = artifact.lifecycle;
  if (
    !hasOnlyKeys(artifact, [
      'id',
      'version',
      'name',
      'description',
      'functionRef',
      'requirements',
      'verification',
      'provenance',
      'knownFailureModes',
      'lifecycle',
      'expiresAt',
      'deprecatedAt',
      'supersededBy',
    ]) ||
    !isBoundedString(artifact.id) ||
    !isBoundedString(artifact.version) ||
    !isBoundedString(artifact.name) ||
    !isBoundedString(artifact.description, MAX_TEXT_CHARS) ||
    !isBoundedString(artifact.functionRef) ||
    !isRequirements(artifact.requirements) ||
    !isVerification(artifact.verification) ||
    (lifecycle !== undefined &&
      lifecycle !== 'active' &&
      lifecycle !== 'inactive' &&
      lifecycle !== 'deprecated' &&
      lifecycle !== 'retired') ||
    !isStringList(artifact.knownFailureModes, MAX_TEXT_CHARS) ||
    (artifact.expiresAt !== undefined &&
      !isCanonicalDate(artifact.expiresAt)) ||
    (artifact.deprecatedAt !== undefined &&
      !isCanonicalDate(artifact.deprecatedAt)) ||
    (artifact.supersededBy !== undefined && !isRef(artifact.supersededBy)) ||
    (provenance !== undefined &&
      (!hasOnlyKeys(provenance, [
        'source',
        'createdAt',
        'createdBy',
        'derivedFrom',
      ]) ||
        !isBoundedString(provenance.source) ||
        (provenance.createdAt !== undefined &&
          !isCanonicalDate(provenance.createdAt)) ||
        (provenance.createdBy !== undefined &&
          !isBoundedString(provenance.createdBy)) ||
        (provenance.derivedFrom !== undefined &&
          (!Array.isArray(provenance.derivedFrom) ||
            provenance.derivedFrom.length > MAX_LIST_ENTRIES ||
            !provenance.derivedFrom.every(isRef) ||
            new Set(provenance.derivedFrom.map(refKey)).size !==
              provenance.derivedFrom.length))))
  )
    return false;

  const self = refKey({ id: artifact.id, version: artifact.version });
  if (artifact.supersededBy && refKey(artifact.supersededBy) === self)
    return false;
  if (
    artifact.deprecatedAt &&
    artifact.expiresAt &&
    Date.parse(artifact.deprecatedAt) > Date.parse(artifact.expiresAt)
  )
    return false;
  const createdAt = provenance?.createdAt;
  if (typeof createdAt === 'string') {
    if (
      artifact.deprecatedAt &&
      Date.parse(createdAt) > Date.parse(artifact.deprecatedAt)
    )
      return false;
    if (
      artifact.expiresAt &&
      Date.parse(createdAt) > Date.parse(artifact.expiresAt)
    )
      return false;
  }
  return true;
}

function isValidContext(value: unknown): value is AxExecutableSkillContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return (
    hasOnlyKeys(context, [
      'admittedArtifacts',
      'principal',
      'audience',
      'preconditions',
      'tools',
      'environment',
      'protocols',
      'capabilities',
      'grantedAuthorities',
      'verifiedReceipts',
      'now',
      'resolveFunction',
    ]) &&
    Array.isArray(context.admittedArtifacts) &&
    context.admittedArtifacts.length <= MAX_LIST_ENTRIES &&
    context.admittedArtifacts.every(isRef) &&
    new Set(context.admittedArtifacts.map(refKey)).size ===
      context.admittedArtifacts.length &&
    isBoundedString(context.principal) &&
    isBoundedString(context.audience) &&
    isStringList(context.preconditions) &&
    isStringList(context.tools) &&
    (context.environment === undefined ||
      isBoundedString(context.environment)) &&
    isStringList(context.protocols) &&
    isStringList(context.capabilities) &&
    isAuthorityList(context.grantedAuthorities) &&
    (context.verifiedReceipts === undefined ||
      (Array.isArray(context.verifiedReceipts) &&
        context.verifiedReceipts.length <= MAX_LIST_ENTRIES &&
        context.verifiedReceipts.every(isReceipt) &&
        new Set(
          context.verifiedReceipts.map(
            (receipt) => (receipt as AxExecutableSkillVerificationReceipt).ref
          )
        ).size === context.verifiedReceipts.length)) &&
    isCanonicalDate(context.now) &&
    typeof context.resolveFunction === 'function'
  );
}

function isValidOptions(
  value: unknown
): value is AxSelectExecutableSkillsOptions {
  if (!value || typeof value !== 'object') return false;
  const options = value as Record<string, unknown>;
  return (
    hasOnlyKeys(options, ['query', 'topK']) &&
    (options.query === undefined ||
      isBoundedString(options.query, MAX_QUERY_CHARS)) &&
    (options.topK === undefined ||
      (Number.isInteger(options.topK) &&
        (options.topK as number) >= 0 &&
        (options.topK as number) <= MAX_TOP_K))
  );
}

function missingAny(
  required: readonly string[] | undefined,
  available: ReadonlySet<string>
): boolean {
  return required?.some((item) => !available.has(item)) ?? false;
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze)) as T;
  }
  if (value && typeof value === 'object') {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)])
    );
    return Object.freeze(copy) as T;
  }
  return value;
}

function snapshotFunction(fn: AxAgentFunction): Readonly<AxAgentFunction> {
  const handler = fn.func;
  return Object.freeze({
    ...cloneAndFreeze({ ...fn, func: undefined }),
    func: (args, extra) => handler(args, extra),
  }) as Readonly<AxAgentFunction>;
}

function uniqueSearchTerms(value: string): string {
  return [
    ...new Set(
      value
        .normalize('NFKD')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ),
  ].join(' ');
}

function matchingReceipt(
  artifact: AxExecutableSkillArtifact,
  context: AxExecutableSkillContext,
  now: number
): AxExecutableSkillVerificationReceipt | undefined {
  if (artifact.verification.mode === 'receiptless') return undefined;
  const verification = artifact.verification;
  const receiptRefs = new Set(verification.receiptRefs);
  const issuers = new Set(verification.issuers);
  const artifactKey = refKey(artifact);
  return context.verifiedReceipts?.find(
    (receipt) =>
      receiptRefs.has(receipt.ref) &&
      refKey(receipt.artifact) === artifactKey &&
      receipt.principal === context.principal &&
      receipt.audience === context.audience &&
      receipt.evaluation === verification.evaluation &&
      issuers.has(receipt.issuer) &&
      Date.parse(receipt.verifiedAt) <= now &&
      Date.parse(receipt.expiresAt) > now
  );
}

/** Return an immutable structured artifact identity with no delimiter aliases. */
export function axExecutableSkillRef(
  artifact: Pick<AxExecutableSkillArtifact, 'id' | 'version'>
): AxExecutableSkillRef {
  return Object.freeze({ id: artifact.id, version: artifact.version });
}

/**
 * Select host-admitted skill metadata, then resolve and snapshot functions from
 * the trusted host registry. Invalid inputs fail closed and remain inspectable.
 */
export function axSelectExecutableSkills(
  catalog: readonly unknown[],
  context: AxExecutableSkillContext,
  options: AxSelectExecutableSkillsOptions = {}
): AxExecutableSkillSelection {
  if (!Array.isArray(catalog) || catalog.length > MAX_CATALOG_ENTRIES) {
    return {
      artifacts: [],
      inspection: [
        {
          eligible: false,
          selected: false,
          reasons: ['limit_exceeded'],
        },
      ],
    };
  }
  if (!isValidContext(context)) {
    return {
      artifacts: [],
      inspection: [
        {
          eligible: false,
          selected: false,
          reasons: ['invalid_context'],
        },
      ],
    };
  }
  if (!isValidOptions(options)) {
    return {
      artifacts: [],
      inspection: [
        {
          eligible: false,
          selected: false,
          reasons: ['invalid_options'],
        },
      ],
    };
  }

  const admitted = new Set(context.admittedArtifacts.map(refKey));
  const preconditions = new Set(context.preconditions ?? []);
  const tools = new Set(context.tools ?? []);
  const protocols = new Set(context.protocols ?? []);
  const capabilities = new Set(context.capabilities ?? []);
  const authorities = new Set(
    (context.grantedAuthorities ?? []).map(authorityKey)
  );
  const now = Date.parse(context.now);
  const refCounts = new Map<string, number>();
  for (const value of catalog) {
    if (!isValidArtifact(value)) continue;
    const key = refKey(value);
    refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
  }

  const valid: Array<{
    artifact: AxExecutableSkillArtifact;
    inspection: AxExecutableSkillInspection;
    receipt?: AxExecutableSkillVerificationReceipt;
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
    const key = refKey(ref);
    const requirements = value.requirements;
    const reasons: AxExecutableSkillExclusionReason[] = [];
    const receipt = matchingReceipt(value, context, now);

    if ((refCounts.get(key) ?? 0) > 1) reasons.push('duplicate_ref');
    if (!admitted.has(key)) reasons.push('not_admitted');
    if (value.lifecycle === 'inactive') reasons.push('inactive');
    if (value.lifecycle === 'deprecated') reasons.push('deprecated');
    if (value.lifecycle === 'retired') reasons.push('retired');
    if (value.expiresAt && Date.parse(value.expiresAt) <= now)
      reasons.push('expired');
    if (value.deprecatedAt && Date.parse(value.deprecatedAt) <= now)
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
    if (
      requirements?.authorities?.some(
        (authority) =>
          authority.principal !== context.principal ||
          authority.audience !== context.audience ||
          !authorities.has(authorityKey(authority))
      )
    )
      reasons.push('missing_authority');
    if (value.verification.mode === 'required' && !receipt)
      reasons.push('missing_verification_receipt');

    const entry: AxExecutableSkillInspection = {
      ref,
      name: value.name,
      eligible: reasons.length === 0,
      selected: false,
      reasons: [...new Set(reasons)],
      ...(receipt ? { matchedVerifierReceiptRef: receipt.ref } : {}),
    };
    inspection.push(entry);
    valid.push({ artifact: value, inspection: entry, receipt });
  }

  const candidates = valid.filter((entry) => entry.inspection.eligible);
  const query = options.query;
  const ranked = query
    ? rankDocuments(
        query,
        candidates.map(({ artifact }) => ({
          id: refKey(artifact),
          fields: [
            { text: artifact.id, identifier: true },
            { text: uniqueSearchTerms(artifact.name), weight: 2 },
            { text: uniqueSearchTerms(artifact.description), weight: 2 },
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
        .map(({ artifact }) => refKey(artifact))
        .sort()
        .slice(0, options.topK ?? candidates.length);
  const selectedKeys = new Set(ranked);
  const artifacts: AxSelectedExecutableSkill[] = [];

  for (const candidate of candidates.sort(
    (left, right) =>
      ranked.indexOf(refKey(left.artifact)) -
      ranked.indexOf(refKey(right.artifact))
  )) {
    if (!selectedKeys.has(refKey(candidate.artifact))) continue;
    const artifactSnapshot = cloneAndFreeze(candidate.artifact);
    let resolved: AxAgentFunction | undefined;
    try {
      resolved = context.resolveFunction(
        artifactSnapshot.functionRef,
        axExecutableSkillRef(artifactSnapshot)
      );
    } catch {
      resolved = undefined;
    }
    if (!resolved || typeof resolved.func !== 'function') {
      candidate.inspection.eligible = false;
      candidate.inspection.reasons = ['unresolved_function'];
      continue;
    }
    candidate.inspection.selected = true;
    artifacts.push(
      Object.freeze({
        artifact: artifactSnapshot,
        function: snapshotFunction(resolved),
        ...(candidate.receipt
          ? { matchedVerifierReceiptRef: candidate.receipt.ref }
          : {}),
      })
    );
  }

  return { artifacts, inspection };
}
