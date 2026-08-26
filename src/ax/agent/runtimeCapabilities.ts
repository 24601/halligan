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
    /**
     * Host-admitted hard upper bound on total execution-boundary memory.
     * Includes JS heaps, external/native allocations, ArrayBuffers, generated
     * code, and stacks. Omit when no such total bound is enforced.
     */
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
    /** Partial engine-area limits do not satisfy this total-memory bound. */
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
  AxRuntimeImplementation
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

function frozenNullRecord<T>(
  entries: readonly (readonly [string, unknown])[]
): T {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(record) as T;
}

function ownDataValue(value: unknown, key: string, path: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    throw new Error(`${path}.${key} must be an own data property`);
  }
  return descriptor.value;
}

type AxRuntimeImplementation = Readonly<{
  language: string | undefined;
  createSession: AxCodeRuntime['createSession'];
  getUsageInstructions: AxCodeRuntime['getUsageInstructions'];
  getPrimitiveOverrides: AxCodeRuntime['getPrimitiveOverrides'];
  formatCallable: AxCodeRuntime['formatCallable'];
}>;

function captureRuntimeImplementation(
  runtime: AxCodeRuntime
): AxRuntimeImplementation {
  const descriptors = Object.getOwnPropertyDescriptors(runtime);
  const captured = (
    key: keyof AxRuntimeImplementation,
    required = false
  ): unknown => {
    const descriptor = Object.hasOwn(descriptors, key)
      ? descriptors[key]
      : undefined;
    if (!descriptor) {
      if (required) {
        throw new Error(`runtime.${key} must be an own data property`);
      }
      return undefined;
    }
    if (!('value' in descriptor)) {
      throw new Error(`runtime.${key} must be an own data property`);
    }
    return descriptor.value;
  };
  return frozenNullRecord<AxRuntimeImplementation>([
    ['language', captured('language')],
    ['createSession', captured('createSession', true)],
    ['getUsageInstructions', captured('getUsageInstructions', true)],
    ['getPrimitiveOverrides', captured('getPrimitiveOverrides')],
    ['formatCallable', captured('formatCallable')],
  ]);
}

function frozenProtocol(value: AxRuntimeProtocol): AxRuntimeProtocol {
  return frozenNullRecord<AxRuntimeProtocol>([
    ['name', ownDataValue(value, 'name', 'protocol')],
    ['version', ownDataValue(value, 'version', 'protocol')],
  ]);
}

function frozenPlatformAuthority(
  value: AxRuntimePlatformAuthority
): AxRuntimePlatformAuthority {
  return frozenNullRecord<AxRuntimePlatformAuthority>(
    platformAuthorityKeys.map((key) => [
      key,
      ownDataValue(value, key, 'authority.platform'),
    ])
  );
}

function frozenAuthority(
  value: AxRuntimeCapabilities['authority']
): AxRuntimeCapabilities['authority'] {
  return frozenNullRecord<AxRuntimeCapabilities['authority']>([
    ['host', ownDataValue(value, 'host', 'authority')],
    ['modules', ownDataValue(value, 'modules', 'authority')],
    ['network', ownDataValue(value, 'network', 'authority')],
    [
      'platform',
      frozenPlatformAuthority(
        ownDataValue(
          value,
          'platform',
          'authority'
        ) as AxRuntimePlatformAuthority
      ),
    ],
  ]);
}

function frozenResources(
  value: AxRuntimeCapabilities['resources']
): AxRuntimeCapabilities['resources'] {
  const timeoutMs = ownDataValue(value, 'timeoutMs', 'resources');
  const memoryMb = ownDataValue(value, 'memoryMb', 'resources');
  return frozenNullRecord<AxRuntimeCapabilities['resources']>([
    ...(timeoutMs === undefined ? [] : ([['timeoutMs', timeoutMs]] as const)),
    [
      'timeoutEnforcement',
      ownDataValue(value, 'timeoutEnforcement', 'resources'),
    ],
    ...(memoryMb === undefined ? [] : ([['memoryMb', memoryMb]] as const)),
  ]);
}

function frozenProtocols(value: unknown): readonly AxRuntimeProtocol[] {
  if (!Array.isArray(value)) {
    throw new Error('capabilities.protocol.features must be a dense array');
  }
  const length = ownDataValue(value, 'length', 'protocol.features');
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new Error('protocol.features.length must be an own array length');
  }
  const protocols: AxRuntimeProtocol[] = [];
  for (let index = 0; index < (length as number); index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('protocol.features must contain own data entries');
    }
    Object.defineProperty(protocols, index, {
      value: frozenProtocol(descriptor.value as AxRuntimeProtocol),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(protocols);
}

/** Creates a deeply immutable declaration snapshot. Freezing is not proof. */
export function axCreateRuntimeCapabilities(
  value: AxRuntimeCapabilities
): AxRuntimeCapabilities {
  const protocol = ownDataValue(value, 'protocol', 'capabilities');
  const persistence = ownDataValue(value, 'persistence', 'capabilities');
  const snapshot = frozenNullRecord<AxRuntimeCapabilities>([
    ['schemaVersion', ownDataValue(value, 'schemaVersion', 'capabilities')],
    ['inspect', ownDataValue(value, 'inspect', 'capabilities')],
    ['snapshot', ownDataValue(value, 'snapshot', 'capabilities')],
    ['patch', ownDataValue(value, 'patch', 'capabilities')],
    ['abort', ownDataValue(value, 'abort', 'capabilities')],
    ['language', ownDataValue(value, 'language', 'capabilities')],
    [
      'usageInstructions',
      ownDataValue(value, 'usageInstructions', 'capabilities'),
    ],
    ['platform', ownDataValue(value, 'platform', 'capabilities')],
    [
      'protocol',
      frozenNullRecord<AxRuntimeCapabilities['protocol']>([
        ['name', ownDataValue(protocol, 'name', 'capabilities.protocol')],
        ['version', ownDataValue(protocol, 'version', 'capabilities.protocol')],
        [
          'features',
          frozenProtocols(
            ownDataValue(protocol, 'features', 'capabilities.protocol')
          ),
        ],
      ]),
    ],
    [
      'persistence',
      frozenNullRecord<AxRuntimeCapabilities['persistence']>([
        [
          'session',
          ownDataValue(persistence, 'session', 'capabilities.persistence'),
        ],
        [
          'restart',
          ownDataValue(persistence, 'restart', 'capabilities.persistence'),
        ],
      ]),
    ],
    [
      'resources',
      frozenResources(
        ownDataValue(
          value,
          'resources',
          'capabilities'
        ) as AxRuntimeCapabilities['resources']
      ),
    ],
    [
      'authority',
      frozenAuthority(
        ownDataValue(
          value,
          'authority',
          'capabilities'
        ) as AxRuntimeCapabilities['authority']
      ),
    ],
  ]);
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
  return frozenNullRecord<AxIRRuntimeCapabilities>([
    [
      'inspect',
      ownDataValue(input, 'inspect', 'axir') ??
        ownDataValue(input, 'inspect_globals', 'axir') ??
        false,
    ],
    [
      'snapshot',
      ownDataValue(input, 'snapshot', 'axir') ??
        ownDataValue(input, 'snapshot_globals', 'axir') ??
        false,
    ],
    [
      'patch',
      ownDataValue(input, 'patch', 'axir') ??
        ownDataValue(input, 'patch_globals', 'axir') ??
        false,
    ],
    [
      'abort',
      ownDataValue(input, 'abort', 'axir') ??
        ownDataValue(defaults, 'abort', 'defaults') ??
        false,
    ],
    [
      'language',
      ownDataValue(input, 'language', 'axir') ??
        ownDataValue(defaults, 'language', 'defaults'),
    ],
    [
      'usageInstructions',
      ownDataValue(input, 'usageInstructions', 'axir') ??
        ownDataValue(input, 'usage_instructions', 'axir') ??
        ownDataValue(defaults, 'usageInstructions', 'defaults'),
    ],
  ]);
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
    const declaration = ownDataValue(runtime, 'capabilities', 'runtime') as
      | AxRuntimeCapabilities
      | undefined;
    return declaration ? axCreateRuntimeCapabilities(declaration) : null;
  } catch {
    return null;
  }
}

function captureRequirementDataTree(
  value: unknown,
  path: string,
  seen: WeakSet<object>
): unknown {
  if (value === null || typeof value !== 'object') {
    if (['function', 'symbol', 'bigint'].includes(typeof value)) {
      throw new Error(`${path} has an unsupported value`);
    }
    return value;
  }
  if (seen.has(value)) {
    throw new Error(`${path} must not contain cycles or repeated references`);
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
  const captured: unknown[] | Record<string, unknown> = isArray
    ? []
    : Object.create(null);
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
    Object.defineProperty(captured, key, {
      value: captureRequirementDataTree(
        descriptor.value,
        `${path}.${key}`,
        seen
      ),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  if (isArray) {
    const length = descriptors.length?.value;
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(descriptors, index)) {
        throw new Error(`${path} must not contain sparse entries`);
      }
    }
  }
  return Object.freeze(captured);
}

function requirementValues<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function requirementValuesContain<T>(
  values: readonly T[],
  expected: T
): boolean {
  for (let index = 0; index < values.length; index++) {
    if (values[index] === expected) return true;
  }
  return false;
}

function renderRequirementValues(values: readonly string[]): string {
  let rendered = '';
  for (let index = 0; index < values.length; index++) {
    rendered += `${index === 0 ? '' : ' or '}${values[index]}`;
  }
  return rendered;
}

function snapshotRequirements(
  requirements: AxRuntimeCapabilityRequirements
): AxRuntimeCapabilityRequirements {
  try {
    // Capture each own descriptor value directly into the canonical tree. Proxy
    // reflection can be effectful, but the source graph is never reread.
    return captureRequirementDataTree(
      requirements,
      'requirements',
      new WeakSet()
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
    const values = requirementValues(value);
    let invalid = values.length === 0;
    for (let index = 0; index < values.length; index++) {
      const item = values[index];
      if (typeof item !== 'string' || item.trim().length === 0) {
        invalid = true;
        break;
      }
    }
    if (invalid) {
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
    const requested = requirementValues(requirements.platform);
    let invalid = requested.length === 0;
    for (let index = 0; index < requested.length; index++) {
      if (!platforms.has(requested[index]!)) {
        invalid = true;
        break;
      }
    }
    if (invalid) {
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

function snapshotAdmissionEvidence(
  evidence: AxRuntimeAdmissionEvidence
): AxRuntimeAdmissionEvidence {
  const snapshot = frozenNullRecord<AxRuntimeAdmissionEvidence>([
    ['evaluator', ownDataValue(evidence, 'evaluator', 'admission')],
    ['source', ownDataValue(evidence, 'source', 'admission')],
    [
      'authority',
      frozenAuthority(
        ownDataValue(
          evidence,
          'authority',
          'admission'
        ) as AxRuntimeCapabilities['authority']
      ),
    ],
    [
      'resources',
      frozenResources(
        ownDataValue(
          evidence,
          'resources',
          'admission'
        ) as AxRuntimeCapabilities['resources']
      ),
    ],
  ]);
  validateAdmissionEvidence(snapshot);
  return snapshot;
}

/**
 * Host admission boundary for security-sensitive matching. The runtime cannot
 * self-attach a valid receipt; the host must mint and pass it to selection.
 */
export function axCreateRuntimeAdmissionReceipt(
  runtime: AxCodeRuntime,
  evidence: AxRuntimeAdmissionEvidence
): AxRuntimeAdmissionReceipt {
  const evidenceSnapshot = snapshotAdmissionEvidence(evidence);
  const implementation = captureRuntimeImplementation(runtime);
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
  const executable = frozenNullRecord<AxCodeRuntime>([
    ...(implementation.language === undefined
      ? []
      : ([['language', implementation.language]] as const)),
    ['createSession', implementation.createSession.bind(runtime)],
    ['getUsageInstructions', implementation.getUsageInstructions.bind(runtime)],
    ...(implementation.getPrimitiveOverrides
      ? ([
          [
            'getPrimitiveOverrides',
            implementation.getPrimitiveOverrides.bind(runtime),
          ],
        ] as const)
      : []),
    ...(implementation.formatCallable
      ? ([
          ['formatCallable', implementation.formatCallable.bind(runtime)],
        ] as const)
      : []),
  ]);
  const receipt = frozenNullRecord<AxRuntimeAdmissionReceipt>([
    ['runtime', runtime],
    ['executable', executable],
    ['evaluator', evidenceSnapshot.evaluator],
    ['source', evidenceSnapshot.source],
    ['authority', evidenceSnapshot.authority],
    ['resources', evidenceSnapshot.resources],
  ]);
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
    const current = captureRuntimeImplementation(runtime);
    const stale =
      !implementation ||
      current.language !== implementation.language ||
      current.createSession !== implementation.createSession ||
      current.getUsageInstructions !== implementation.getUsageInstructions ||
      current.getPrimitiveOverrides !== implementation.getPrimitiveOverrides ||
      current.formatCallable !== implementation.formatCallable;
    return stale ? { stale: true } : { receipt, stale: false };
  } catch {
    return { stale: true };
  }
}

function supportsProtocol(
  capabilities: AxRuntimeCapabilities,
  required: AxRuntimeProtocol
): boolean {
  if (
    capabilities.protocol.name === required.name &&
    capabilities.protocol.version === required.version
  ) {
    return true;
  }
  for (let index = 0; index < capabilities.protocol.features.length; index++) {
    const protocol = capabilities.protocol.features[index];
    if (
      protocol?.name === required.name &&
      protocol.version === required.version
    ) {
      return true;
    }
  }
  return false;
}

function capabilityRejectionReasons(
  runtimeLanguage: unknown,
  capabilities: AxRuntimeCapabilities,
  requirements: AxRuntimeCapabilityRequirements,
  admission: AxRuntimeAdmissionReceipt | undefined,
  staleAdmission: boolean
): string[] {
  const reasons: string[] = [];
  if ((runtimeLanguage ?? 'JavaScript') !== capabilities.language) {
    reasons.push('runtime language contradicts capabilities declaration');
  }
  for (const key of ['inspect', 'snapshot', 'patch', 'abort'] as const) {
    if (requirements[key] && !capabilities[key])
      reasons.push(`requires ${key}`);
  }
  if (requirements.language) {
    const accepted = requirementValues(requirements.language);
    if (!requirementValuesContain(accepted, capabilities.language)) {
      reasons.push(`requires language ${renderRequirementValues(accepted)}`);
    }
  }
  if (requirements.platform) {
    const accepted = requirementValues(requirements.platform);
    if (!requirementValuesContain(accepted, capabilities.platform)) {
      reasons.push(`requires platform ${renderRequirementValues(accepted)}`);
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
    let runtimeLanguage: unknown;
    try {
      runtimeLanguage = admission.receipt
        ? admittedImplementations.get(admission.receipt)?.language
        : ownDataValue(runtime, 'language', 'runtime');
    } catch {
      rejected.push({
        index,
        reasons: ['malformed runtime language metadata'],
      });
      continue;
    }
    const reasons = capabilityRejectionReasons(
      runtimeLanguage,
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
  const declaredTimeoutMs = capabilities.resources.timeoutMs;
  const declaredTimeoutEnforcement = capabilities.resources.timeoutEnforcement;
  if (
    declaredTimeoutMs !== undefined ||
    declaredTimeoutEnforcement !== 'none'
  ) {
    const timeout = observations.timeout;
    if (!timeout) {
      if (declaredTimeoutMs !== undefined) {
        contradictions.push('declared timeout bound was not observed');
      }
      if (declaredTimeoutEnforcement !== 'none') {
        contradictions.push('declared timeout enforcement was not observed');
      }
    } else {
      const validTimes =
        isFinitePositive(timeout.requestedMs) &&
        isFinitePositive(timeout.observedMs);
      const validEnforcement = timeoutEnforcements.has(timeout.enforcement);
      if (
        !validTimes ||
        typeof timeout.interrupted !== 'boolean' ||
        !validEnforcement
      ) {
        failures.push('timeout observation is malformed');
      }
      if (
        declaredTimeoutMs !== undefined &&
        validTimes &&
        timeout.requestedMs < declaredTimeoutMs
      ) {
        failures.push('timeout probe ended before the declared bound');
      }
      if (
        declaredTimeoutMs !== undefined &&
        (!validTimes ||
          !timeout.interrupted ||
          timeout.observedMs > declaredTimeoutMs)
      ) {
        contradictions.push('declared timeout bound was not observed');
      }
      if (
        declaredTimeoutEnforcement !== 'none' &&
        (!validEnforcement ||
          !timeout.interrupted ||
          timeoutRank[timeout.enforcement] <
            timeoutRank[declaredTimeoutEnforcement])
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
      memory.observedPeakMb >= 0 &&
      typeof memory.terminated === 'boolean';
    if (memory && !validMemory) {
      failures.push('memory observation is malformed');
    }
    if (
      validMemory &&
      !memory.terminated &&
      memory.observedPeakMb <= capabilities.resources.memoryMb
    ) {
      failures.push('memory probe ended before the declared bound');
    }
    if (
      !validMemory ||
      !memory.terminated ||
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
