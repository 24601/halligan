import type { AxCodeRuntime } from './rlm.js';

/** Canonical AxIR runtime protocol identifier used by in-process Ax runtimes. */
export const axCodeRuntimeProtocol = 'ax-code-runtime';
export const axCodeRuntimeProtocolVersion = '1';

export type AxRuntimeAuthority =
  | 'denied'
  | 'allowlist'
  | 'unrestricted'
  | 'unknown';

export type AxRuntimeTimeoutEnforcement = 'none' | 'cooperative' | 'hard';

/**
 * A runtime's self-declared capabilities, using the AxIR RuntimeCapabilities
 * vocabulary. This metadata is untrusted and is never proof of isolation,
 * enforcement, or certification.
 */
export interface RuntimeCapabilities {
  inspect: boolean;
  snapshot: boolean;
  patch: boolean;
  abort: boolean;
  language: string;
  protocol: Readonly<{
    name: string;
    version: string;
  }>;
  persistence: Readonly<{
    session: boolean;
    restart: boolean;
  }>;
  resources: Readonly<{
    timeoutMs?: number;
    timeoutEnforcement: AxRuntimeTimeoutEnforcement;
    memoryMb?: number;
  }>;
  authority: Readonly<{
    host: AxRuntimeAuthority;
    modules: AxRuntimeAuthority;
    network: AxRuntimeAuthority;
  }>;
}

/** Public Ax-prefixed alias for the canonical AxIR RuntimeCapabilities record. */
export type AxRuntimeCapabilities = RuntimeCapabilities;

export type AxRuntimeCapabilityRequirements = Readonly<{
  inspect?: true;
  snapshot?: true;
  patch?: true;
  abort?: true;
  language?: string | readonly string[];
  protocol?: Readonly<{ name: string; version: string }>;
  persistence?: Readonly<{ session?: true; restart?: true }>;
  resources?: Readonly<{
    maxTimeoutMs?: number;
    timeoutEnforcement?: Exclude<AxRuntimeTimeoutEnforcement, 'none'>;
    maxMemoryMb?: number;
  }>;
  /** Maximum ambient authority acceptable to the caller. */
  authority?: Readonly<{
    host?: Exclude<AxRuntimeAuthority, 'unknown'>;
    modules?: Exclude<AxRuntimeAuthority, 'unknown'>;
    network?: Exclude<AxRuntimeAuthority, 'unknown'>;
  }>;
}>;

export type AxRuntimeSelection = Readonly<{
  runtime: AxCodeRuntime;
  index: number;
  requirementAware: boolean;
  rejected: readonly Readonly<{ index: number; reasons: readonly string[] }>[];
}>;

const authorityRank: Record<AxRuntimeAuthority, number> = {
  denied: 0,
  allowlist: 1,
  unrestricted: 2,
  unknown: 3,
};

const timeoutEnforcements = new Set<AxRuntimeTimeoutEnforcement>([
  'none',
  'cooperative',
  'hard',
]);
const authorities = new Set<AxRuntimeAuthority>([
  'denied',
  'allowlist',
  'unrestricted',
  'unknown',
]);

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Partial<RuntimeCapabilities>;
  return (
    typeof c.inspect === 'boolean' &&
    typeof c.snapshot === 'boolean' &&
    typeof c.patch === 'boolean' &&
    typeof c.abort === 'boolean' &&
    typeof c.language === 'string' &&
    c.language.trim().length > 0 &&
    typeof c.protocol?.name === 'string' &&
    c.protocol.name.length > 0 &&
    typeof c.protocol.version === 'string' &&
    c.protocol.version.length > 0 &&
    typeof c.persistence?.session === 'boolean' &&
    typeof c.persistence.restart === 'boolean' &&
    !!c.resources &&
    timeoutEnforcements.has(c.resources.timeoutEnforcement) &&
    (c.resources.timeoutMs === undefined ||
      isFinitePositive(c.resources.timeoutMs)) &&
    (c.resources.memoryMb === undefined ||
      isFinitePositive(c.resources.memoryMb)) &&
    !!c.authority &&
    authorities.has(c.authority.host) &&
    authorities.has(c.authority.modules) &&
    authorities.has(c.authority.network)
  );
}

function capabilityRejectionReasons(
  runtime: AxCodeRuntime,
  requirements: AxRuntimeCapabilityRequirements
): string[] {
  const value = runtime.capabilities;
  if (!isRuntimeCapabilities(value)) {
    return ['missing or malformed capabilities declaration'];
  }
  const capabilities = value;
  const reasons: string[] = [];

  if ((runtime.language ?? 'JavaScript') !== capabilities.language) {
    reasons.push('runtime language contradicts capabilities declaration');
  }

  for (const key of ['inspect', 'snapshot', 'patch', 'abort'] as const) {
    if (requirements[key] && capabilities[key] !== true) {
      reasons.push(`requires ${key}`);
    }
  }

  if (requirements.language) {
    const accepted = Array.isArray(requirements.language)
      ? requirements.language
      : [requirements.language];
    if (
      typeof capabilities.language !== 'string' ||
      !accepted.includes(capabilities.language)
    ) {
      reasons.push(`requires language ${accepted.join(' or ')}`);
    }
  }

  if (
    requirements.protocol &&
    (capabilities.protocol?.name !== requirements.protocol.name ||
      capabilities.protocol?.version !== requirements.protocol.version)
  ) {
    reasons.push(
      `requires protocol ${requirements.protocol.name}/${requirements.protocol.version}`
    );
  }

  for (const key of ['session', 'restart'] as const) {
    if (
      requirements.persistence?.[key] &&
      capabilities.persistence?.[key] !== true
    ) {
      reasons.push(`requires ${key} persistence`);
    }
  }

  const resources = capabilities.resources;
  if (requirements.resources?.maxTimeoutMs !== undefined) {
    if (
      typeof resources?.timeoutMs !== 'number' ||
      resources.timeoutMs > requirements.resources.maxTimeoutMs
    ) {
      reasons.push(
        `requires timeout at most ${requirements.resources.maxTimeoutMs}ms`
      );
    }
  }
  if (requirements.resources?.maxMemoryMb !== undefined) {
    if (
      typeof resources?.memoryMb !== 'number' ||
      resources.memoryMb > requirements.resources.maxMemoryMb
    ) {
      reasons.push(
        `requires memory limit at most ${requirements.resources.maxMemoryMb}MB`
      );
    }
  }
  if (requirements.resources?.timeoutEnforcement) {
    const required = requirements.resources.timeoutEnforcement;
    const actual = resources?.timeoutEnforcement;
    const rank: Record<AxRuntimeTimeoutEnforcement, number> = {
      none: 0,
      cooperative: 1,
      hard: 2,
    };
    if (!actual || rank[actual] < rank[required]) {
      reasons.push(`requires ${required} timeout enforcement`);
    }
  }

  for (const key of ['host', 'modules', 'network'] as const) {
    const maximum = requirements.authority?.[key];
    const actual = capabilities.authority?.[key];
    if (
      maximum &&
      (!actual || authorityRank[actual] > authorityRank[maximum])
    ) {
      reasons.push(`requires ${key} authority no broader than ${maximum}`);
    }
  }

  return reasons;
}

/**
 * Selects the first declared match. With no requirements this preserves blind,
 * first-runtime selection. Explicit requirements fail closed; declarations
 * remain untrusted metadata and callers should separately verify adapters.
 */
export function axSelectCodeRuntime(
  runtimes: readonly AxCodeRuntime[],
  requirements?: AxRuntimeCapabilityRequirements
): AxRuntimeSelection {
  if (runtimes.length === 0) {
    throw new Error('No AxCodeRuntime candidates were provided');
  }
  if (!requirements) {
    return {
      runtime: runtimes[0]!,
      index: 0,
      requirementAware: false,
      rejected: [],
    };
  }

  const rejected: { index: number; reasons: string[] }[] = [];
  for (const [index, runtime] of runtimes.entries()) {
    const reasons = capabilityRejectionReasons(runtime, requirements);
    if (reasons.length === 0) {
      return {
        runtime,
        index,
        requirementAware: true,
        rejected,
      };
    }
    rejected.push({ index, reasons });
  }

  throw new Error(
    `No AxCodeRuntime satisfies the requested capabilities: ${rejected
      .map(({ index, reasons }) => `#${index} ${reasons.join(', ')}`)
      .join('; ')}`
  );
}

export type AxRuntimeConformanceObservations = Readonly<{
  language: string;
  inspect: boolean;
  snapshot: boolean;
  patch: boolean;
  abort: boolean;
  persistence: Readonly<{ session: boolean; restart: boolean }>;
  timeout?: Readonly<{
    requestedMs: number;
    observedMs: number;
    interrupted: boolean;
  }>;
  authority: Readonly<{
    hostDenied: boolean;
    modulesDenied: boolean;
    networkDenied: boolean;
  }>;
  protocol: Readonly<{
    name: string;
    version: string;
    malformedEnvelopeRejected: boolean;
    mismatchRejected: boolean;
  }>;
  cleanup: boolean;
}>;

export type AxRuntimeConformanceReport = Readonly<{
  conformant: boolean;
  falseConfidence: readonly string[];
  failures: readonly string[];
  isolationProven: false;
}>;

/**
 * Compares adapter-produced observations with an untrusted declaration. This
 * detects deterministic contradictions; it cannot prove sandbox isolation.
 */
export function axEvaluateRuntimeConformance(
  capabilities: RuntimeCapabilities,
  observations: AxRuntimeConformanceObservations
): AxRuntimeConformanceReport {
  const falseConfidence: string[] = [];
  const failures: string[] = [];

  if (capabilities.language !== observations.language) {
    falseConfidence.push(
      'declared language did not match the observed language'
    );
  }

  for (const key of ['inspect', 'snapshot', 'patch', 'abort'] as const) {
    if (capabilities[key] && !observations[key]) {
      falseConfidence.push(`${key} was declared but not observed`);
    }
  }
  for (const key of ['session', 'restart'] as const) {
    if (capabilities.persistence[key] && !observations.persistence[key]) {
      falseConfidence.push(`${key} persistence was declared but not observed`);
    }
  }

  const deniedChecks = {
    host: observations.authority.hostDenied,
    modules: observations.authority.modulesDenied,
    network: observations.authority.networkDenied,
  };
  for (const key of ['host', 'modules', 'network'] as const) {
    if (capabilities.authority[key] === 'denied' && !deniedChecks[key]) {
      falseConfidence.push(`${key} denial was declared but not observed`);
    }
  }

  if (capabilities.resources.timeoutMs !== undefined) {
    const timeout = observations.timeout;
    if (
      !timeout ||
      !timeout.interrupted ||
      timeout.observedMs > capabilities.resources.timeoutMs
    ) {
      falseConfidence.push('declared timeout bound was not observed');
    }
  }

  if (
    observations.protocol.name !== capabilities.protocol.name ||
    observations.protocol.version !== capabilities.protocol.version
  ) {
    falseConfidence.push(
      'declared protocol did not match the observed protocol'
    );
  }
  if (!observations.protocol.malformedEnvelopeRejected) {
    failures.push('malformed protocol envelope was not rejected');
  }
  if (!observations.protocol.mismatchRejected) {
    failures.push('protocol mismatch was not rejected');
  }
  if (!observations.cleanup) {
    failures.push('runtime cleanup was not observed');
  }

  return {
    conformant: falseConfidence.length === 0 && failures.length === 0,
    falseConfidence,
    failures,
    isolationProven: false,
  };
}
