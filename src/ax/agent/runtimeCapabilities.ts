import type { AxCodeRuntime } from './rlm.js';

export const axCodeRuntimeProtocol = 'ax-code-runtime';
export const axCodeRuntimeProtocolVersion = '1';
export const axRuntimeCapabilitiesVersion = 'ax-runtime-capabilities/v1';
export const axRuntimeCapabilityRequirementsVersion =
  'ax-runtime-requirements/v1';

export type AxRuntimeAuthority =
  | 'denied'
  | 'allowlist'
  | 'unrestricted'
  | 'unknown';
export type AxRuntimePlatform = 'node' | 'browser' | 'deno' | 'unknown';
export type AxRuntimeTimeoutEnforcement = 'none' | 'cooperative' | 'hard';

export type AxRuntimeProtocol = Readonly<{
  name: string;
  version: string;
}>;

/** Portable interchange projection of the existing AxIR runtime vocabulary. */
export interface AxIRRuntimeCapabilities {
  inspect: boolean;
  snapshot: boolean;
  patch: boolean;
  abort: boolean;
  language: string;
  usageInstructions: string;
}

/** Target-native generated records currently use these legacy field names. */
export type AxIRRuntimeCapabilitiesInput = Partial<AxIRRuntimeCapabilities> &
  Readonly<{
    inspect_globals?: boolean;
    snapshot_globals?: boolean;
    patch_globals?: boolean;
    usage_instructions?: string;
  }>;

export type AxRuntimePlatformAuthority = Readonly<{
  filesystem: AxRuntimeAuthority;
  childProcess: AxRuntimeAuthority;
  storage: AxRuntimeAuthority;
  communication: AxRuntimeAuthority;
  timing: AxRuntimeAuthority;
  workers: AxRuntimeAuthority;
  codeLoading: AxRuntimeAuthority;
  nativeAddons: AxRuntimeAuthority;
  wasi: AxRuntimeAuthority;
}>;

/**
 * Versioned Ax-specific superset of the generated AxIR RuntimeCapabilities
 * record. It is self-declared, untrusted metadata, not an attestation.
 */
export interface AxRuntimeCapabilitiesV1 extends AxIRRuntimeCapabilities {
  schemaVersion: typeof axRuntimeCapabilitiesVersion;
  platform: AxRuntimePlatform;
  protocol: Readonly<{
    name: string;
    version: string;
    features: readonly AxRuntimeProtocol[];
  }>;
  persistence: Readonly<{ session: boolean; restart: boolean }>;
  resources: Readonly<{
    timeoutMs?: number;
    timeoutEnforcement: AxRuntimeTimeoutEnforcement;
    memoryMb?: number;
  }>;
  authority: Readonly<{
    /** Conservative aggregate of every host/platform authority dimension. */
    host: AxRuntimeAuthority;
    modules: AxRuntimeAuthority;
    network: AxRuntimeAuthority;
    platform: AxRuntimePlatformAuthority;
  }>;
}

export type AxRuntimeCapabilities = AxRuntimeCapabilitiesV1;

export type AxRuntimeCapabilityExtensions = Omit<
  AxRuntimeCapabilitiesV1,
  keyof AxIRRuntimeCapabilities | 'schemaVersion'
>;

export type AxRuntimeCapabilityRequirements = Readonly<{
  schemaVersion?: typeof axRuntimeCapabilityRequirementsVersion;
  inspect?: true;
  snapshot?: true;
  patch?: true;
  abort?: true;
  language?: string | readonly string[];
  platform?: AxRuntimePlatform | readonly AxRuntimePlatform[];
  /** Matches either the base protocol or one declared feature protocol. */
  protocol?: AxRuntimeProtocol;
  persistence?: Readonly<{ session?: true; restart?: true }>;
  resources?: Readonly<{
    maxTimeoutMs?: number;
    timeoutEnforcement?: Exclude<AxRuntimeTimeoutEnforcement, 'none'>;
    maxMemoryMb?: number;
  }>;
  /** Maximum host-admitted authority acceptable to the caller. */
  authority?: Readonly<{
    host?: Exclude<AxRuntimeAuthority, 'unknown'>;
    modules?: Exclude<AxRuntimeAuthority, 'unknown'>;
    network?: Exclude<AxRuntimeAuthority, 'unknown'>;
    platform?: Partial<
      Record<
        keyof AxRuntimePlatformAuthority,
        Exclude<AxRuntimeAuthority, 'unknown'>
      >
    >;
  }>;
}>;

export type AxRuntimeAdmissionEvidence = Readonly<{
  evaluator: string;
  source: 'adapter-execution' | 'external-attestation' | 'host-policy';
  authority: AxRuntimeCapabilities['authority'];
  resources: AxRuntimeCapabilities['resources'];
}>;

export type AxRuntimeAdmissionReceipt = Readonly<{
  /** Original candidate identity used only for receipt matching. */
  runtime: AxCodeRuntime;
  /** Frozen facade over the implementation admitted by the host. */
  executable: AxCodeRuntime;
  evaluator: string;
  source: AxRuntimeAdmissionEvidence['source'];
  authority: AxRuntimeCapabilities['authority'];
  resources: AxRuntimeCapabilities['resources'];
}>;

export type AxRuntimeSelection = Readonly<{
  runtime: AxCodeRuntime;
  capabilities?: AxRuntimeCapabilities;
  admission?: AxRuntimeAdmissionReceipt;
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
const timeoutRank: Record<AxRuntimeTimeoutEnforcement, number> = {
  none: 0,
  cooperative: 1,
  hard: 2,
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
const platforms = new Set<AxRuntimePlatform>([
  'node',
  'browser',
  'deno',
  'unknown',
]);
const platformAuthorityKeys: readonly (keyof AxRuntimePlatformAuthority)[] = [
  'filesystem',
  'childProcess',
  'storage',
  'communication',
  'timing',
  'workers',
  'codeLoading',
  'nativeAddons',
  'wasi',
];
const requirementObjectKeys: Readonly<Record<string, readonly string[]>> = {
  requirements: [
    'schemaVersion',
    'inspect',
    'snapshot',
    'patch',
    'abort',
    'language',
    'platform',
    'protocol',
    'persistence',
    'resources',
    'authority',
  ],
  'requirements.protocol': ['name', 'version'],
  'requirements.persistence': ['session', 'restart'],
  'requirements.resources': [
    'maxTimeoutMs',
    'timeoutEnforcement',
    'maxMemoryMb',
  ],
  'requirements.authority': ['host', 'modules', 'network', 'platform'],
  'requirements.authority.platform': platformAuthorityKeys,
};
const requirementArrayPaths = new Set([
  'requirements.language',
  'requirements.platform',
]);
const admissionReceipts = new WeakSet<object>();
const admittedImplementations = new WeakMap<
  AxRuntimeAdmissionReceipt,
  Readonly<{
    language: string | undefined;
    createSession: AxCodeRuntime['createSession'];
    getUsageInstructions: AxCodeRuntime['getUsageInstructions'];
    getPrimitiveOverrides: AxCodeRuntime['getPrimitiveOverrides'];
    formatCallable: AxCodeRuntime['formatCallable'];
  }>
>();
const admissionSources = new Set<AxRuntimeAdmissionEvidence['source']>([
  'adapter-execution',
  'external-attestation',
  'host-policy',
]);

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveRequirementBound(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function frozenProtocol(value: AxRuntimeProtocol): AxRuntimeProtocol {
  return Object.freeze({ name: value.name, version: value.version });
}

function frozenPlatformAuthority(
  value: AxRuntimePlatformAuthority
): AxRuntimePlatformAuthority {
  return Object.freeze(
    Object.fromEntries(platformAuthorityKeys.map((key) => [key, value[key]]))
  ) as AxRuntimePlatformAuthority;
}

function frozenAuthority(
  value: AxRuntimeCapabilities['authority']
): AxRuntimeCapabilities['authority'] {
  return Object.freeze({
    host: value.host,
    modules: value.modules,
    network: value.network,
    platform: frozenPlatformAuthority(value.platform),
  });
}

function frozenResources(
  value: AxRuntimeCapabilities['resources']
): AxRuntimeCapabilities['resources'] {
  return Object.freeze({
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    timeoutEnforcement: value.timeoutEnforcement,
    ...(value.memoryMb === undefined ? {} : { memoryMb: value.memoryMb }),
  });
}

/** Creates a deeply immutable declaration snapshot. Freezing is not proof. */
export function axCreateRuntimeCapabilities(
  value: AxRuntimeCapabilities
): AxRuntimeCapabilities {
  const snapshot = Object.freeze({
    schemaVersion: value.schemaVersion,
    inspect: value.inspect,
    snapshot: value.snapshot,
    patch: value.patch,
    abort: value.abort,
    language: value.language,
    usageInstructions: value.usageInstructions,
    platform: value.platform,
    protocol: Object.freeze({
      name: value.protocol.name,
      version: value.protocol.version,
      features: Object.freeze(value.protocol.features.map(frozenProtocol)),
    }),
    persistence: Object.freeze({
      session: value.persistence.session,
      restart: value.persistence.restart,
    }),
    resources: frozenResources(value.resources),
    authority: frozenAuthority(value.authority),
  });
  if (!isRuntimeCapabilities(snapshot)) {
    throw new Error('Invalid Ax runtime capabilities declaration');
  }
  return snapshot;
}

/** Explicit migration path from the generated AxIR record to the v1 superset. */
export function axExtendAxIRRuntimeCapabilities(
  axir: AxIRRuntimeCapabilities,
  extensions: AxRuntimeCapabilityExtensions
): AxRuntimeCapabilities {
  return axCreateRuntimeCapabilities({
    ...axir,
    ...extensions,
    schemaVersion: axRuntimeCapabilitiesVersion,
  });
}

/**
 * Normalizes current generated target records, including Rust's `*_globals`
 * fields and snake-case process-adapter records, before extending them.
 */
export function axNormalizeAxIRRuntimeCapabilities(
  input: AxIRRuntimeCapabilitiesInput,
  defaults: Readonly<{
    language: string;
    usageInstructions: string;
    abort?: boolean;
  }>
): Readonly<AxIRRuntimeCapabilities> {
  return Object.freeze({
    inspect: input.inspect ?? input.inspect_globals ?? false,
    snapshot: input.snapshot ?? input.snapshot_globals ?? false,
    patch: input.patch ?? input.patch_globals ?? false,
    abort: input.abort ?? defaults.abort ?? false,
    language: input.language ?? defaults.language,
    usageInstructions:
      input.usageInstructions ??
      input.usage_instructions ??
      defaults.usageInstructions,
  });
}

/** Drops v1 extension fields for generated AxIR adapters. */
export function axRuntimeCapabilitiesToAxIR(
  capabilities: AxRuntimeCapabilities
): Readonly<AxIRRuntimeCapabilities> {
  return Object.freeze({
    inspect: capabilities.inspect,
    snapshot: capabilities.snapshot,
    patch: capabilities.patch,
    abort: capabilities.abort,
    language: capabilities.language,
    usageInstructions: capabilities.usageInstructions,
  });
}

/** Converts a `name/version` token such as the program-source feature token. */
export function axRuntimeProtocolFromToken(token: string): AxRuntimeProtocol {
  const separator = token.lastIndexOf('/');
  if (separator <= 0 || separator === token.length - 1) {
    throw new Error(`Invalid runtime protocol token: ${token}`);
  }
  return frozenProtocol({
    name: token.slice(0, separator),
    version: token.slice(separator + 1),
  });
}

function isProtocol(value: unknown): value is AxRuntimeProtocol {
  if (!value || typeof value !== 'object') return false;
  const protocol = value as Partial<AxRuntimeProtocol>;
  return (
    typeof protocol.name === 'string' &&
    protocol.name.trim().length > 0 &&
    typeof protocol.version === 'string' &&
    protocol.version.trim().length > 0
  );
}

function isPlatformAuthority(
  value: unknown
): value is AxRuntimePlatformAuthority {
  if (!value || typeof value !== 'object') return false;
  const authority = value as Partial<AxRuntimePlatformAuthority>;
  return platformAuthorityKeys.every((key) => authorities.has(authority[key]!));
}

function isRuntimeCapabilities(value: unknown): value is AxRuntimeCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Partial<AxRuntimeCapabilities>;
  const structurallyValid =
    c.schemaVersion === axRuntimeCapabilitiesVersion &&
    typeof c.inspect === 'boolean' &&
    typeof c.snapshot === 'boolean' &&
    typeof c.patch === 'boolean' &&
    typeof c.abort === 'boolean' &&
    typeof c.language === 'string' &&
    c.language.trim().length > 0 &&
    typeof c.usageInstructions === 'string' &&
    platforms.has(c.platform!) &&
    isProtocol(c.protocol) &&
    Array.isArray(c.protocol.features) &&
    c.protocol.features.every(isProtocol) &&
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
    authorities.has(c.authority.network) &&
    isPlatformAuthority(c.authority.platform);
  if (!structurallyValid) return false;

  const authority = c.authority!;
  const hostDimensions = [
    authority.modules,
    authority.network,
    ...platformAuthorityKeys.map((key) => authority.platform[key]),
  ];
  return (
    hostDimensions.every(
      (dimension) => authorityRank[authority.host] >= authorityRank[dimension]
    ) &&
    authorityRank[authority.modules] >=
      authorityRank[authority.platform.codeLoading] &&
    authorityRank[authority.modules] >=
      authorityRank[authority.platform.workers] &&
    authorityRank[authority.modules] >=
      authorityRank[authority.platform.nativeAddons] &&
    authorityRank[authority.modules] >=
      authorityRank[authority.platform.wasi] &&
    authorityRank[authority.network] >=
      authorityRank[authority.platform.workers] &&
    authorityRank[authority.network] >=
      authorityRank[authority.platform.codeLoading]
  );
}

function snapshotDeclaration(
  runtime: AxCodeRuntime
): AxRuntimeCapabilities | null {
  try {
    return isRuntimeCapabilities(runtime.capabilities)
      ? axCreateRuntimeCapabilities(runtime.capabilities)
      : null;
  } catch {
    return null;
  }
}

function assertRequirementDataTree(
  value: unknown,
  path: string,
  seen: WeakSet<object>
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) {
    throw new Error(`${path} must not contain cycles`);
  }
  seen.add(value);
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error(`${path} must contain only plain objects and arrays`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowedKeys = isArray ? undefined : requirementObjectKeys[path];
  if (!isArray && !allowedKeys) {
    throw new Error(`${path} has an unsupported object value`);
  }
  if (isArray && !requirementArrayPaths.has(path)) {
    throw new Error(`${path} has an unsupported array value`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error(`${path} contains unsupported symbol fields`);
    }
    if (isArray && key === 'length') continue;
    if (
      (isArray && !/^(0|[1-9]\d*)$/.test(key)) ||
      (!isArray && !allowedKeys?.includes(key))
    ) {
      throw new Error(`${path} contains unsupported field ${key}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`${path}.${key} must be an own data property`);
    }
    if (!descriptor.enumerable) {
      throw new Error(`${path}.${key} must be enumerable`);
    }
    assertRequirementDataTree(descriptor.value, `${path}.${key}`, seen);
  }
  if (isArray) {
    const length = descriptors.length?.value;
    for (let index = 0; index < length; index++) {
      if (!descriptors[index]) {
        throw new Error(`${path} must not contain sparse entries`);
      }
    }
  }
  seen.delete(value);
}

function freezeRequirementTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeRequirementTree));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          freezeRequirementTree(child),
        ])
      )
    );
  }
  return value;
}

function snapshotRequirements(
  requirements: AxRuntimeCapabilityRequirements
): AxRuntimeCapabilityRequirements {
  try {
    // Accessors are rejected before structuredClone can invoke them. The clone
    // also rejects Proxy exotic objects, functions, and other non-data input.
    assertRequirementDataTree(requirements, 'requirements', new WeakSet());
    return freezeRequirementTree(
      structuredClone(requirements)
    ) as AxRuntimeCapabilityRequirements;
  } catch (error) {
    throw new Error(
      `Invalid runtime capability requirements: unable to create an immutable data snapshot${
        error instanceof Error ? `: ${error.message}` : ''
      }`,
      { cause: error }
    );
  }
}

function validateRequirements(
  requirements: AxRuntimeCapabilityRequirements
): void {
  const errors: string[] = [];
  if (
    !requirements ||
    typeof requirements !== 'object' ||
    Array.isArray(requirements)
  ) {
    throw new Error('Invalid runtime capability requirements: expected object');
  }
  const rejectUnknownKeys = (
    value: unknown,
    allowed: readonly string[],
    path: string
  ) => {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key)) {
        errors.push(`${path} contains unsupported field ${String(key)}`);
      }
    }
  };
  rejectUnknownKeys(
    requirements,
    [
      'schemaVersion',
      'inspect',
      'snapshot',
      'patch',
      'abort',
      'language',
      'platform',
      'protocol',
      'persistence',
      'resources',
      'authority',
    ],
    'requirements'
  );
  rejectUnknownKeys(requirements.protocol, ['name', 'version'], 'protocol');
  rejectUnknownKeys(
    requirements.persistence,
    ['session', 'restart'],
    'persistence'
  );
  rejectUnknownKeys(
    requirements.resources,
    ['maxTimeoutMs', 'timeoutEnforcement', 'maxMemoryMb'],
    'resources'
  );
  rejectUnknownKeys(
    requirements.authority,
    ['host', 'modules', 'network', 'platform'],
    'authority'
  );
  rejectUnknownKeys(
    requirements.authority?.platform,
    platformAuthorityKeys,
    'authority.platform'
  );
  const needsAdmission = !!requirements.resources || !!requirements.authority;
  if (
    needsAdmission &&
    requirements.schemaVersion !== axRuntimeCapabilityRequirementsVersion
  ) {
    errors.push(
      `security requirements require schemaVersion ${axRuntimeCapabilityRequirementsVersion}`
    );
  } else if (
    requirements.schemaVersion !== undefined &&
    requirements.schemaVersion !== axRuntimeCapabilityRequirementsVersion
  ) {
    errors.push(
      `unsupported requirements schemaVersion ${requirements.schemaVersion}`
    );
  }
  const validateStrings = (value: string | readonly string[], name: string) => {
    const values = Array.isArray(value) ? value : [value];
    if (
      values.length === 0 ||
      values.some(
        (item) => typeof item !== 'string' || item.trim().length === 0
      )
    ) {
      errors.push(`${name} must contain non-empty values`);
    }
  };
  for (const key of ['inspect', 'snapshot', 'patch', 'abort'] as const) {
    if (requirements[key] !== undefined && requirements[key] !== true) {
      errors.push(`${key} requirement must be true when present`);
    }
  }
  for (const key of ['session', 'restart'] as const) {
    if (
      requirements.persistence?.[key] !== undefined &&
      requirements.persistence[key] !== true
    ) {
      errors.push(`${key} persistence requirement must be true when present`);
    }
  }
  if (requirements.language !== undefined)
    validateStrings(requirements.language, 'language');
  if (requirements.platform !== undefined) {
    const requested = Array.isArray(requirements.platform)
      ? requirements.platform
      : [requirements.platform];
    if (
      requested.length === 0 ||
      requested.some((item) => !platforms.has(item))
    ) {
      errors.push('platform must contain supported values');
    }
  }
  if (requirements.protocol && !isProtocol(requirements.protocol)) {
    errors.push('protocol must have a non-empty name and version');
  }
  for (const [name, value] of [
    ['maxTimeoutMs', requirements.resources?.maxTimeoutMs],
    ['maxMemoryMb', requirements.resources?.maxMemoryMb],
  ] as const) {
    if (value !== undefined && !isPositiveRequirementBound(value)) {
      errors.push(`${name} must be a positive safe integer`);
    }
  }
  if (
    requirements.resources?.timeoutEnforcement !== undefined &&
    !['cooperative', 'hard'].includes(requirements.resources.timeoutEnforcement)
  ) {
    errors.push('timeoutEnforcement must be cooperative or hard');
  }
  for (const [name, value] of Object.entries({
    host: requirements.authority?.host,
    modules: requirements.authority?.modules,
    network: requirements.authority?.network,
    ...requirements.authority?.platform,
  })) {
    if (
      value !== undefined &&
      (!authorities.has(value) || (value as unknown) === 'unknown')
    ) {
      errors.push(`${name} authority requirement is invalid`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Invalid runtime capability requirements: ${errors.join('; ')}`
    );
  }
}

function validateAdmissionEvidence(evidence: AxRuntimeAdmissionEvidence): void {
  if (
    typeof evidence.evaluator !== 'string' ||
    evidence.evaluator.trim().length === 0
  ) {
    throw new Error('Runtime admission evaluator must be non-empty');
  }
  if (!admissionSources.has(evidence.source)) {
    throw new Error('Runtime admission source is invalid');
  }
  if (
    !isRuntimeCapabilities({
      schemaVersion: axRuntimeCapabilitiesVersion,
      inspect: false,
      snapshot: false,
      patch: false,
      abort: false,
      language: 'admission',
      usageInstructions: '',
      platform: 'unknown',
      protocol: { name: 'admission', version: '1', features: [] },
      persistence: { session: false, restart: false },
      resources: evidence.resources,
      authority: evidence.authority,
    })
  ) {
    throw new Error('Runtime admission authority or resources are malformed');
  }
}

/**
 * Host admission boundary for security-sensitive matching. The runtime cannot
 * self-attach a valid receipt; the host must mint and pass it to selection.
 */
export function axCreateRuntimeAdmissionReceipt(
  runtime: AxCodeRuntime,
  evidence: AxRuntimeAdmissionEvidence
): AxRuntimeAdmissionReceipt {
  validateAdmissionEvidence(evidence);
  const implementation = Object.freeze({
    language: runtime.language,
    createSession: runtime.createSession,
    getUsageInstructions: runtime.getUsageInstructions,
    getPrimitiveOverrides: runtime.getPrimitiveOverrides,
    formatCallable: runtime.formatCallable,
  });
  if (
    typeof implementation.createSession !== 'function' ||
    typeof implementation.getUsageInstructions !== 'function' ||
    (implementation.getPrimitiveOverrides !== undefined &&
      typeof implementation.getPrimitiveOverrides !== 'function') ||
    (implementation.formatCallable !== undefined &&
      typeof implementation.formatCallable !== 'function')
  ) {
    throw new Error('Runtime admission implementation is malformed');
  }
  const executable: AxCodeRuntime = Object.freeze({
    ...(implementation.language === undefined
      ? {}
      : { language: implementation.language }),
    createSession: implementation.createSession.bind(runtime),
    getUsageInstructions: implementation.getUsageInstructions.bind(runtime),
    ...(implementation.getPrimitiveOverrides
      ? {
          getPrimitiveOverrides:
            implementation.getPrimitiveOverrides.bind(runtime),
        }
      : {}),
    ...(implementation.formatCallable
      ? { formatCallable: implementation.formatCallable.bind(runtime) }
      : {}),
  });
  const receipt = Object.freeze({
    runtime,
    executable,
    evaluator: evidence.evaluator,
    source: evidence.source,
    authority: frozenAuthority(evidence.authority),
    resources: frozenResources(evidence.resources),
  });
  admissionReceipts.add(receipt);
  admittedImplementations.set(receipt, implementation);
  return receipt;
}

function resolveAdmission(
  runtime: AxCodeRuntime,
  receipts: readonly AxRuntimeAdmissionReceipt[] | undefined
): Readonly<{
  receipt?: AxRuntimeAdmissionReceipt;
  stale: boolean;
}> {
  const receipt = receipts?.find(
    (candidate) =>
      admissionReceipts.has(candidate) && candidate.runtime === runtime
  );
  if (!receipt) return { stale: false };
  const implementation = admittedImplementations.get(receipt);
  try {
    const stale =
      !implementation ||
      runtime.language !== implementation.language ||
      runtime.createSession !== implementation.createSession ||
      runtime.getUsageInstructions !== implementation.getUsageInstructions ||
      runtime.getPrimitiveOverrides !== implementation.getPrimitiveOverrides ||
      runtime.formatCallable !== implementation.formatCallable;
    return stale ? { stale: true } : { receipt, stale: false };
  } catch {
    return { stale: true };
  }
}

function supportsProtocol(
  capabilities: AxRuntimeCapabilities,
  required: AxRuntimeProtocol
): boolean {
  return [capabilities.protocol, ...capabilities.protocol.features].some(
    (protocol) =>
      protocol.name === required.name && protocol.version === required.version
  );
}

function capabilityRejectionReasons(
  runtime: AxCodeRuntime,
  capabilities: AxRuntimeCapabilities,
  requirements: AxRuntimeCapabilityRequirements,
  admission: AxRuntimeAdmissionReceipt | undefined,
  staleAdmission: boolean
): string[] {
  const reasons: string[] = [];
  if ((runtime.language ?? 'JavaScript') !== capabilities.language) {
    reasons.push('runtime language contradicts capabilities declaration');
  }
  for (const key of ['inspect', 'snapshot', 'patch', 'abort'] as const) {
    if (requirements[key] && !capabilities[key])
      reasons.push(`requires ${key}`);
  }
  if (requirements.language) {
    const accepted = Array.isArray(requirements.language)
      ? requirements.language
      : [requirements.language];
    if (!accepted.includes(capabilities.language)) {
      reasons.push(`requires language ${accepted.join(' or ')}`);
    }
  }
  if (requirements.platform) {
    const accepted = Array.isArray(requirements.platform)
      ? requirements.platform
      : [requirements.platform];
    if (!accepted.includes(capabilities.platform)) {
      reasons.push(`requires platform ${accepted.join(' or ')}`);
    }
  }
  if (
    requirements.protocol &&
    !supportsProtocol(capabilities, requirements.protocol)
  ) {
    reasons.push(
      `requires protocol ${requirements.protocol.name}/${requirements.protocol.version}`
    );
  }
  for (const key of ['session', 'restart'] as const) {
    if (requirements.persistence?.[key] && !capabilities.persistence[key]) {
      reasons.push(`requires ${key} persistence`);
    }
  }

  const needsAdmission = !!requirements.resources || !!requirements.authority;
  if (needsAdmission && staleAdmission) {
    reasons.push('host admission no longer matches runtime implementation');
    return reasons;
  }
  if (needsAdmission && !admission) {
    reasons.push(
      'security requirements require a trusted host admission receipt'
    );
    return reasons;
  }
  if (!admission) return reasons;

  const resources = admission.resources;
  if (
    requirements.resources?.maxTimeoutMs !== undefined &&
    (resources.timeoutMs === undefined ||
      resources.timeoutMs > requirements.resources.maxTimeoutMs)
  ) {
    reasons.push(
      `requires timeout at most ${requirements.resources.maxTimeoutMs}ms`
    );
  }
  if (
    requirements.resources?.maxMemoryMb !== undefined &&
    (resources.memoryMb === undefined ||
      resources.memoryMb > requirements.resources.maxMemoryMb)
  ) {
    reasons.push(
      `requires memory limit at most ${requirements.resources.maxMemoryMb}MB`
    );
  }
  if (
    requirements.resources?.timeoutEnforcement &&
    timeoutRank[resources.timeoutEnforcement] <
      timeoutRank[requirements.resources.timeoutEnforcement]
  ) {
    reasons.push(
      `requires ${requirements.resources.timeoutEnforcement} timeout enforcement`
    );
  }
  for (const key of ['host', 'modules', 'network'] as const) {
    const maximum = requirements.authority?.[key];
    if (
      maximum &&
      authorityRank[admission.authority[key]] > authorityRank[maximum]
    ) {
      reasons.push(`requires ${key} authority no broader than ${maximum}`);
    }
  }
  for (const key of platformAuthorityKeys) {
    const maximum = requirements.authority?.platform?.[key];
    if (
      maximum &&
      authorityRank[admission.authority.platform[key]] > authorityRank[maximum]
    ) {
      reasons.push(`requires ${key} authority no broader than ${maximum}`);
    }
  }
  return reasons;
}

/**
 * Selects the first declared match. Security requirements additionally require
 * a host-minted receipt and return its frozen executable facade; declarations
 * alone are never authority/resource proof.
 */
export function axSelectCodeRuntime(
  runtimes: readonly AxCodeRuntime[],
  requirements?: AxRuntimeCapabilityRequirements,
  options?: Readonly<{ admissions?: readonly AxRuntimeAdmissionReceipt[] }>
): AxRuntimeSelection {
  if (runtimes.length === 0)
    throw new Error('No AxCodeRuntime candidates were provided');
  if (!requirements) {
    return {
      runtime: runtimes[0]!,
      index: 0,
      requirementAware: false,
      rejected: [],
    };
  }
  const requirementSnapshot = snapshotRequirements(requirements);
  validateRequirements(requirementSnapshot);
  const needsAdmission =
    !!requirementSnapshot.resources || !!requirementSnapshot.authority;
  const rejected: { index: number; reasons: string[] }[] = [];
  for (const [index, runtime] of runtimes.entries()) {
    const capabilities = snapshotDeclaration(runtime);
    if (!capabilities) {
      rejected.push({
        index,
        reasons: ['missing or malformed capabilities declaration'],
      });
      continue;
    }
    const admission = needsAdmission
      ? resolveAdmission(runtime, options?.admissions)
      : { stale: false };
    const reasons = capabilityRejectionReasons(
      runtime,
      capabilities,
      requirementSnapshot,
      admission.receipt,
      admission.stale
    );
    if (reasons.length === 0) {
      return {
        runtime: admission.receipt?.executable ?? runtime,
        capabilities,
        ...(admission.receipt ? { admission: admission.receipt } : {}),
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

export type AxRuntimeCapabilityObservations = Readonly<{
  provenance: Readonly<{
    evaluator: string;
    source: 'adapter-execution' | 'host-observation' | 'synthetic';
  }>;
  language: string;
  platform: AxRuntimePlatform;
  inspect: boolean;
  snapshot: boolean;
  patch: boolean;
  abort: boolean;
  persistence: Readonly<{ session: boolean; restart: boolean }>;
  timeout?: Readonly<{
    requestedMs: number;
    observedMs: number;
    interrupted: boolean;
    enforcement: AxRuntimeTimeoutEnforcement;
  }>;
  memory?: Readonly<{
    limitMb: number;
    observedPeakMb: number;
    terminated: boolean;
  }>;
  authority: Readonly<{
    host: AxRuntimeAuthority;
    modules: AxRuntimeAuthority;
    network: AxRuntimeAuthority;
    platform: Readonly<
      Record<
        keyof AxRuntimePlatformAuthority,
        Readonly<{
          observed: AxRuntimeAuthority;
          outsideAllowlistDenied?: boolean;
        }>
      >
    >;
  }>;
  protocol: Readonly<{
    name: string;
    version: string;
    malformedEnvelopeRejected: boolean;
    mismatchRejected: boolean;
  }>;
  cleanup: boolean;
}>;

export type AxRuntimeCapabilityContradictionReport = Readonly<{
  consistent: boolean;
  contradictions: readonly string[];
  unexpectedCapabilities: readonly string[];
  failures: readonly string[];
  executableObservations: boolean;
  isolationProven: false;
}>;

/** Reports bounded contradictions; even executable probes cannot prove isolation. */
export function axReportRuntimeCapabilityContradictions(
  capabilities: AxRuntimeCapabilities,
  observations: AxRuntimeCapabilityObservations
): AxRuntimeCapabilityContradictionReport {
  const contradictions: string[] = [];
  const unexpectedCapabilities: string[] = [];
  const failures: string[] = [];
  if (observations.provenance.evaluator.trim().length === 0) {
    failures.push('observation evaluator provenance is missing');
  }
  if (capabilities.language !== observations.language) {
    contradictions.push(
      'declared language did not match the observed language'
    );
  }
  if (capabilities.platform !== observations.platform) {
    contradictions.push(
      'declared platform did not match the observed platform'
    );
  }
  for (const key of ['inspect', 'snapshot', 'patch', 'abort'] as const) {
    if (capabilities[key] && !observations[key]) {
      contradictions.push(`${key} was declared but not observed`);
    } else if (!capabilities[key] && observations[key]) {
      unexpectedCapabilities.push(`${key} was observed but not declared`);
    }
  }
  for (const key of ['session', 'restart'] as const) {
    if (capabilities.persistence[key] && !observations.persistence[key]) {
      contradictions.push(`${key} persistence was declared but not observed`);
    } else if (
      !capabilities.persistence[key] &&
      observations.persistence[key]
    ) {
      unexpectedCapabilities.push(
        `${key} persistence was observed but not declared`
      );
    }
  }
  for (const key of ['host', 'modules', 'network'] as const) {
    if (
      authorityRank[observations.authority[key]] >
      authorityRank[capabilities.authority[key]]
    ) {
      contradictions.push(`${key} authority was broader than declared`);
    }
  }
  for (const key of platformAuthorityKeys) {
    const declared = capabilities.authority.platform[key];
    const observed = observations.authority.platform[key];
    if (authorityRank[observed.observed] > authorityRank[declared]) {
      contradictions.push(`${key} authority was broader than declared`);
    }
    if (declared === 'allowlist' && observed.outsideAllowlistDenied !== true) {
      contradictions.push(`${key} allowlist boundary was not observed`);
    }
  }
  if (capabilities.resources.timeoutMs !== undefined) {
    const timeout = observations.timeout;
    if (!timeout) {
      contradictions.push('declared timeout bound was not observed');
    } else {
      const validTimes =
        isFinitePositive(timeout.requestedMs) &&
        isFinitePositive(timeout.observedMs);
      if (!validTimes || !timeoutEnforcements.has(timeout.enforcement)) {
        failures.push('timeout observation is malformed');
      }
      if (
        validTimes &&
        timeout.requestedMs < capabilities.resources.timeoutMs
      ) {
        failures.push('timeout probe ended before the declared bound');
      }
      if (
        !validTimes ||
        !timeout.interrupted ||
        timeout.observedMs > capabilities.resources.timeoutMs
      ) {
        contradictions.push('declared timeout bound was not observed');
      }
      if (
        timeoutRank[timeout.enforcement] <
        timeoutRank[capabilities.resources.timeoutEnforcement]
      ) {
        contradictions.push('declared timeout enforcement was not observed');
      }
    }
  }
  if (capabilities.resources.memoryMb !== undefined) {
    const memory = observations.memory;
    const validMemory =
      !!memory &&
      isFinitePositive(memory.limitMb) &&
      typeof memory.observedPeakMb === 'number' &&
      Number.isFinite(memory.observedPeakMb) &&
      memory.observedPeakMb >= 0;
    if (memory && !validMemory) {
      failures.push('memory observation is malformed');
    }
    if (
      !validMemory ||
      memory.limitMb > capabilities.resources.memoryMb ||
      memory.observedPeakMb > capabilities.resources.memoryMb
    ) {
      contradictions.push('declared memory bound was not observed');
    }
  }
  if (
    observations.protocol.name !== capabilities.protocol.name ||
    observations.protocol.version !== capabilities.protocol.version
  ) {
    contradictions.push(
      'declared protocol did not match the observed protocol'
    );
  }
  if (!observations.protocol.malformedEnvelopeRejected) {
    failures.push('malformed protocol envelope was not rejected');
  }
  if (!observations.protocol.mismatchRejected) {
    failures.push('protocol mismatch was not rejected');
  }
  if (!observations.cleanup) failures.push('runtime cleanup was not observed');
  return {
    consistent:
      contradictions.length === 0 &&
      unexpectedCapabilities.length === 0 &&
      failures.length === 0,
    contradictions,
    unexpectedCapabilities,
    failures,
    executableObservations:
      observations.provenance.source === 'adapter-execution',
    isolationProven: false,
  };
}
