import type { AxAIService, AxFunction } from '../ai/types.js';
import type { AxAgentUsage, AxProgramUsage } from '../dsp/types.js';
import { randomUUID, sha256 } from '../util/crypto.js';
import type { AxAgentState } from './agentInternal/agentStateTypes.js';

export type AxAgentSessionMessageMode = 'steer' | 'follow-up';

export type AxAgentSessionStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AxAgentSessionMessageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export interface AxAgentSessionUsage {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AxAgentSessionHandle {
  version: 1;
  id: string;
  parentId: string;
  rootId: string;
  registrationKey: string;
  /** Root ownership lease. Recovery advances it and revokes older handles. */
  epoch: number;
  /** Bearer capability. Treat serialized handles as sensitive application data. */
  capability: string;
}

export interface AxAgentSessionMessage {
  id: string;
  jobId: string;
  mode: AxAgentSessionMessageMode;
  status: AxAgentSessionMessageStatus;
  input: unknown;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  attemptId?: string;
  cancelRequested?: boolean;
  /** Tokens charged if this running attempt becomes outcome_unknown. */
  tokenReservation?: number;
  /** Confirmed provider usage for this completed attempt. */
  usage?: AxAgentSessionUsage;
}

export interface AxAgentSessionRecord {
  handle: AxAgentSessionHandle;
  depth: number;
  authorizedChildren: string[];
  status: AxAgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  activeMessageId?: string;
  mailbox: AxAgentSessionMessage[];
  state?: AxAgentState;
  artifacts?: unknown;
  usage: AxAgentSessionUsage;
  descendantUsage: AxAgentSessionUsage;
  /** Usage from descendants removed from the live registry. */
  retiredDescendantUsage: AxAgentSessionUsage;
  lastError?: string;
}

export interface AxAgentSessionLimits {
  /** Maximum retained descendants in one root tree. */
  maxChildren: number;
  /** Root depth is zero. */
  maxDepth: number;
  /** Maximum simultaneously running messages in one root tree. */
  maxConcurrency: number;
  /** Maximum pending (not running) messages for one child. */
  maxPendingMessages: number;
  /** Maximum retained mailbox entries for one child. */
  maxRetainedMessages: number;
  /** Provider-reported token budget across the root and all descendants. */
  maxTokens: number;
  /** Conservative token charge for an outcome_unknown child message. */
  maxTokensPerMessage: number;
  /** Exact admission budget across initial tasks and later messages. */
  maxSubcalls: number;
}

export interface AxAgentSessionRootRecord {
  id: string;
  capability: string;
  /** Transactional ownership lease shared by every handle in this tree. */
  epoch: number;
  authorizedChildren: string[];
  status: 'active' | 'cancelled' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  limits: AxAgentSessionLimits;
  admittedChildren: number;
  admittedSubcalls: number;
  descendantUsage: AxAgentSessionUsage;
  /** Usage from sessions removed from the live registry. */
  retiredDescendantUsage: AxAgentSessionUsage;
  reservedTokens: number;
  outcomeUnknownTokens: number;
  /** outcome_unknown reservations removed with disposed sessions. */
  retiredOutcomeUnknownTokens: number;
  /** Admitted messages removed with disposed sessions. */
  retiredSubcalls: number;
  budgetExceeded?: 'tokens' | 'subcalls';
}

export interface AxAgentSessionRegistrySnapshot {
  version: 1;
  revision: number;
  /** SHA-256 of canonical authority, lifecycle, and accounting state. */
  policyDigest: string;
  root: AxAgentSessionRootRecord;
  sessions: Record<string, AxAgentSessionRecord>;
}

export interface AxAgentSessionRestoreOptions {
  /** Trusted canonical snapshot digest stored apart from the snapshot. */
  expectedPolicyDigest: string;
}

export interface AxAgentSessionStore {
  readonly capabilities: Readonly<{
    durability: 'volatile' | 'persistent';
    coordination: 'single-worker' | 'multi-worker';
  }>;
  load(
    rootId: string
  ): Promise<Readonly<AxAgentSessionRegistrySnapshot> | undefined>;
  /**
   * Atomically create when expectedRevision is undefined, or replace exactly
   * that revision. Throw AxAgentSessionConflictError on a CAS mismatch.
   */
  save(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    expectedRevision: number | undefined
  ): Promise<Readonly<AxAgentSessionRegistrySnapshot>>;
  delete(rootId: string): Promise<void>;
  listRoots(): Promise<readonly string[]>;
}

export interface AxAgentSessionJob {
  id: string;
  rootId: string;
  sessionId: string;
  messageId: string;
  epoch: number;
  enqueuedAt: number;
}

export interface AxAgentSessionScheduler {
  readonly capabilities: Readonly<{
    durability: 'volatile' | 'persistent';
    coordination: 'single-worker' | 'multi-worker';
  }>;
  /** Attach this host's idempotent, at-least-once-safe job dispatcher. */
  attach(
    handler: (job: Readonly<AxAgentSessionJob>) => Promise<void>
  ): undefined | (() => void);
  enqueue(job: Readonly<AxAgentSessionJob>): Promise<void>;
  /**
   * Returns true only when the scheduler accepted cancellation. An adapter
   * that terminates an active handler without letting it settle must arrange
   * recovery so its running registry claim becomes outcome_unknown.
   */
  cancel(jobId: string): Promise<boolean>;
  close?(): void | Promise<void>;
}

export interface AxRetainedAgent<IN = Record<string, unknown>, OUT = unknown> {
  forward(
    ai: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<{
      abortSignal?: AbortSignal;
      usageContext?: Readonly<{
        runId?: string;
        parentRunId?: string;
        feature?: string;
        attributes?: Record<string, string | number | boolean>;
      }>;
    }>
  ): Promise<OUT>;
  getState(): AxAgentState | undefined;
  setState(state?: AxAgentState): void;
  getUsage(): AxAgentUsage | readonly AxProgramUsage[];
  resetUsage(): void;
  stop(): void;
}

export interface AxAgentSessionFactoryContext {
  readonly session: AxAgentSessionClient;
  readonly sessionId: string;
  readonly parentId: string;
  readonly rootId: string;
  readonly depth: number;
}

export interface AxAgentSessionRegistration<IN = unknown, OUT = unknown> {
  /** Stable authorization and restoration key. */
  key: string;
  create(
    context: Readonly<AxAgentSessionFactoryContext>
  ): AxRetainedAgent<IN, OUT>;
  /** Children this registration may itself admit. Default: none. */
  authorizedChildren?: readonly string[];
  ai?: Readonly<AxAIService>;
  captureArtifacts?(
    agent: AxRetainedAgent<IN, OUT>
  ): unknown | Promise<unknown>;
  restoreArtifacts?(
    agent: AxRetainedAgent<IN, OUT>,
    artifacts: unknown
  ): void | Promise<void>;
}

export interface AxAgentSessionStatusView {
  handle: AxAgentSessionHandle;
  depth: number;
  status: AxAgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  activeMessageId?: string;
  mailbox: AxAgentSessionMessage[];
  latestResult?: unknown;
  lastError?: string;
  usage: AxAgentSessionUsage;
  descendantUsage: AxAgentSessionUsage;
  durability: {
    store: 'volatile' | 'persistent';
    scheduler: 'volatile' | 'persistent';
  };
}

export interface AxAgentSessionRootView {
  rootId: string;
  status: AxAgentSessionRootRecord['status'];
  limits: AxAgentSessionLimits;
  admittedChildren: number;
  admittedSubcalls: number;
  descendantUsage: AxAgentSessionUsage;
  retiredDescendantUsage: AxAgentSessionUsage;
  reservedTokens: number;
  outcomeUnknownTokens: number;
  retiredOutcomeUnknownTokens: number;
  retiredSubcalls: number;
  budgetExceeded?: AxAgentSessionRootRecord['budgetExceeded'];
  childCount: number;
  durability: {
    store: 'volatile' | 'persistent';
    scheduler: 'volatile' | 'persistent';
  };
}

export interface AxAgentSessionSendReceipt {
  messageId: string;
  mode: AxAgentSessionMessageMode;
  acceptedAt: number;
  delivery: 'ready' | 'queued' | 'interrupting';
  /**
   * Present when scheduler interruption was attempted before this receipt
   * returned. Event-continuation dispatch defers that attempt, so the field is
   * omitted even when delivery is interrupting.
   */
  interruptAccepted?: boolean;
}

export interface AxAgentSessionEvent {
  type:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'disposed';
  rootId: string;
  sessionId: string;
  parentId: string;
  messageId?: string;
  status: AxAgentSessionStatus;
  time: number;
  correlation: Readonly<{ kind: 'ax-agent-session'; value: string }>;
}

export interface AxAgentSessionHostOptions {
  registrations: readonly AxAgentSessionRegistration[];
  ai?: Readonly<AxAIService>;
  store?: AxAgentSessionStore;
  scheduler?: AxAgentSessionScheduler;
  limits?: Partial<AxAgentSessionLimits>;
  now?: () => number;
  onEvent?: (event: Readonly<AxAgentSessionEvent>) => void | Promise<void>;
}

export interface AxAgentSessionRootOptions {
  id?: string;
  authorizedChildren: readonly string[];
  limits?: Partial<AxAgentSessionLimits>;
  abortSignal?: AbortSignal;
}

export interface AxAgentSessionFunctionOptions {
  namespace?: string;
  /** Register an Ax event continuation for each admitted task/message. */
  eventContinuations?: boolean;
}

const DEFAULT_LIMITS: AxAgentSessionLimits = {
  maxChildren: 16,
  maxDepth: 2,
  maxConcurrency: 4,
  maxPendingMessages: 16,
  maxRetainedMessages: 128,
  maxTokens: 250_000,
  maxTokensPerMessage: 62_500,
  maxSubcalls: 100,
};

const emptyUsage = (): AxAgentSessionUsage => ({
  modelCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

function addUsage(
  target: AxAgentSessionUsage,
  delta: Readonly<AxAgentSessionUsage>
): void {
  target.modelCalls += delta.modelCalls;
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.totalTokens += delta.totalTokens;
}

function cloneStructured<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new AxAgentSessionSerializationError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

function validatePositiveLimit(
  name: keyof AxAgentSessionLimits,
  value: number
) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function resolveLimits(
  base: Readonly<AxAgentSessionLimits>,
  override?: Partial<AxAgentSessionLimits>
): AxAgentSessionLimits {
  const limits = { ...base, ...override };
  if (
    override &&
    override.maxTokensPerMessage === undefined &&
    override.maxTokens !== undefined
  ) {
    limits.maxTokensPerMessage = Math.min(
      base.maxTokensPerMessage,
      Math.max(1, Math.floor(limits.maxTokens / limits.maxConcurrency))
    );
  }
  for (const [name, value] of Object.entries(limits)) {
    validatePositiveLimit(name as keyof AxAgentSessionLimits, value);
  }
  if (limits.maxTokensPerMessage > limits.maxTokens) {
    throw new Error('maxTokensPerMessage cannot exceed maxTokens');
  }
  return limits;
}

function validateRegistrationKey(key: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) {
    throw new Error(
      `Invalid retained agent registration key "${key}"; use 1-128 letters, numbers, dot, underscore, or dash`
    );
  }
}

function canonicalKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

function equalStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertUsage(usage: Readonly<AxAgentSessionUsage>, name: string): void {
  const fields = [
    'completionTokens',
    'modelCalls',
    'promptTokens',
    'totalTokens',
  ];
  if (!equalStrings(Object.keys(usage).sort(), fields)) {
    throw new AxAgentSessionSerializationError(
      `${name} does not match the canonical usage schema`
    );
  }
  for (const [field, value] of Object.entries(usage)) {
    if (!isNonNegativeSafeInteger(value)) {
      throw new AxAgentSessionSerializationError(
        `${name}.${field} must be a non-negative safe integer`
      );
    }
  }
  if (usage.totalTokens !== usage.promptTokens + usage.completionTokens) {
    throw new AxAgentSessionSerializationError(
      `${name}.totalTokens must equal promptTokens + completionTokens`
    );
  }
}

function equalUsage(
  left: Readonly<AxAgentSessionUsage>,
  right: Readonly<AxAgentSessionUsage>
): boolean {
  return (
    left.modelCalls === right.modelCalls &&
    left.promptTokens === right.promptTokens &&
    left.completionTokens === right.completionTokens &&
    left.totalTokens === right.totalTokens
  );
}

const SNAPSHOT_IMPORT_LIMITS = {
  maxDepth: 64,
  maxValues: 100_000,
  maxBytes: 16 * 1024 * 1024,
  maxBigIntBits: 4096,
} as const;

const MAX_SNAPSHOT_BIGINT =
  (1n << BigInt(SNAPSHOT_IMPORT_LIMITS.maxBigIntBits)) - 1n;

interface TypedArrayConstructor {
  readonly prototype: ArrayBufferView;
  new (
    buffer: ArrayBuffer,
    byteOffset?: number,
    length?: number
  ): ArrayBufferView;
}

const TYPED_ARRAY_CONSTRUCTORS: readonly TypedArrayConstructor[] = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
];

const ERROR_PROTOTYPES = new Map<object, string>([
  [Error.prototype, 'Error'],
  [EvalError.prototype, 'EvalError'],
  [RangeError.prototype, 'RangeError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [TypeError.prototype, 'TypeError'],
  [URIError.prototype, 'URIError'],
]);

/**
 * Capture caller-owned restore input once into a detached graph. In particular,
 * this does not read property values after inspecting their descriptors and
 * never passes the live graph to structuredClone.
 */
function captureSnapshotImport<T>(value: T): T {
  let values = 0;
  let bytes = 0;
  const seen = new Map<object, unknown>();

  const accountBytes = (amount: number) => {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      bytes > SNAPSHOT_IMPORT_LIMITS.maxBytes - amount
    ) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxBytes ${SNAPSHOT_IMPORT_LIMITS.maxBytes}`
      );
    }
    bytes += amount;
  };

  const accountString = (text: string) => accountBytes(text.length * 2);

  const ownKeys = (record: object): readonly PropertyKey[] => {
    const keys = Reflect.ownKeys(record);
    if (keys.length > SNAPSHOT_IMPORT_LIMITS.maxValues - values) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxValues ${SNAPSHOT_IMPORT_LIMITS.maxValues}`
      );
    }
    return keys;
  };

  const descriptor = (record: object, key: PropertyKey): PropertyDescriptor => {
    const current = Reflect.getOwnPropertyDescriptor(record, key);
    if (!current) {
      throw new AxAgentSessionSerializationError(
        'snapshot changed while its own properties were captured'
      );
    }
    return current;
  };

  const assertDataDescriptor = (
    current: PropertyDescriptor,
    key: PropertyKey,
    allowNonEnumerable = false
  ): unknown => {
    if (typeof key === 'symbol') {
      throw new AxAgentSessionSerializationError(
        'snapshot import does not support symbol own keys'
      );
    }
    if (!allowNonEnumerable && !current.enumerable) {
      throw new AxAgentSessionSerializationError(
        `snapshot import does not support non-enumerable own key "${key}"`
      );
    }
    if (!('value' in current)) {
      throw new AxAgentSessionSerializationError(
        `snapshot import does not support accessor own key "${key}"`
      );
    }
    return current.value;
  };

  const captureEntries = (
    source: object,
    target: object,
    depth: number,
    keys = ownKeys(source)
  ) => {
    for (const key of keys) {
      const nested = assertDataDescriptor(descriptor(source, key), key);
      accountString(key as string);
      Object.defineProperty(target, key, {
        value: visit(nested, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  };

  const assertNoOwnKeys = (source: object, name: string) => {
    if (ownKeys(source).length !== 0) {
      throw new AxAgentSessionSerializationError(
        `snapshot import does not support custom own keys on ${name}`
      );
    }
  };

  const assertSameIntrinsicOwnKeys = (
    source: object,
    captured: object,
    name: string
  ) => {
    const sourceKeys = ownKeys(source);
    const capturedKeys = Reflect.ownKeys(captured);
    if (
      sourceKeys.length !== capturedKeys.length ||
      sourceKeys.some((key, index) => key !== capturedKeys[index])
    ) {
      throw new AxAgentSessionSerializationError(
        `snapshot import does not support custom own keys on ${name}`
      );
    }
  };

  function visit(current: unknown, depth: number): unknown {
    values++;
    if (values > SNAPSHOT_IMPORT_LIMITS.maxValues) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxValues ${SNAPSHOT_IMPORT_LIMITS.maxValues}`
      );
    }
    if (depth > SNAPSHOT_IMPORT_LIMITS.maxDepth) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxDepth ${SNAPSHOT_IMPORT_LIMITS.maxDepth}`
      );
    }

    if (typeof current === 'string') {
      accountString(current);
      return current;
    }
    if (typeof current === 'bigint') {
      if (current > MAX_SNAPSHOT_BIGINT || current < -MAX_SNAPSHOT_BIGINT) {
        throw new AxAgentSessionSerializationError(
          `snapshot import exceeds maxBigIntBits ${SNAPSHOT_IMPORT_LIMITS.maxBigIntBits}`
        );
      }
      accountString(current.toString());
      return current;
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === 'boolean' ||
      typeof current === 'number'
    ) {
      return current;
    }
    if (typeof current === 'function' || typeof current === 'symbol') {
      throw new AxAgentSessionSerializationError(
        `snapshot integrity cannot encode ${typeof current} values`
      );
    }

    const object = current as object;
    if (seen.has(object)) return seen.get(object);

    const isArray = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);

    if (
      typeof SharedArrayBuffer !== 'undefined' &&
      prototype === SharedArrayBuffer.prototype
    ) {
      throw new AxAgentSessionSerializationError(
        'snapshot integrity cannot authenticate mutable SharedArrayBuffer values'
      );
    }

    if (isArray) {
      if (prototype !== Array.prototype) {
        throw new AxAgentSessionSerializationError(
          'snapshot import only supports ordinary arrays'
        );
      }
      const keys = ownKeys(object);
      const lengthKey = keys.find((key) => key === 'length');
      if (lengthKey === undefined) {
        throw new AxAgentSessionSerializationError(
          'snapshot array is missing its intrinsic length'
        );
      }
      const length = assertDataDescriptor(
        descriptor(object, lengthKey),
        lengthKey,
        true
      );
      if (
        !Number.isSafeInteger(length) ||
        Number(length) < 0 ||
        Number(length) > 0xffff_ffff
      ) {
        throw new AxAgentSessionSerializationError(
          'snapshot array has an invalid intrinsic length'
        );
      }
      const captured: unknown[] = new Array(Number(length));
      seen.set(object, captured);
      captureEntries(
        object,
        captured,
        depth,
        keys.filter((key) => key !== 'length')
      );
      return captured;
    }

    if (prototype === Date.prototype) {
      assertNoOwnKeys(object, 'Date');
      const captured = new Date(Date.prototype.getTime.call(object));
      seen.set(object, captured);
      return captured;
    }
    if (prototype === RegExp.prototype) {
      const keys = ownKeys(object);
      if (keys.length !== 1 || keys[0] !== 'lastIndex') {
        throw new AxAgentSessionSerializationError(
          'snapshot import does not support custom own keys on RegExp'
        );
      }
      const lastIndex = assertDataDescriptor(
        descriptor(object, 'lastIndex'),
        'lastIndex',
        true
      );
      if (typeof lastIndex !== 'number') {
        throw new AxAgentSessionSerializationError(
          'snapshot RegExp has an invalid intrinsic lastIndex'
        );
      }
      const source = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        'source'
      )?.get?.call(object) as string;
      const flags = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        'flags'
      )?.get?.call(object) as string;
      accountString(source);
      accountString(flags);
      const captured = new RegExp(source, flags);
      captured.lastIndex = lastIndex;
      seen.set(object, captured);
      return captured;
    }
    if (prototype === Map.prototype) {
      assertNoOwnKeys(object, 'Map');
      const captured = new Map<unknown, unknown>();
      seen.set(object, captured);
      for (const [key, nested] of Map.prototype.entries.call(object)) {
        captured.set(visit(key, depth + 1), visit(nested, depth + 1));
      }
      return captured;
    }
    if (prototype === Set.prototype) {
      assertNoOwnKeys(object, 'Set');
      const captured = new Set<unknown>();
      seen.set(object, captured);
      for (const nested of Set.prototype.values.call(object)) {
        captured.add(visit(nested, depth + 1));
      }
      return captured;
    }
    if (prototype === ArrayBuffer.prototype) {
      assertNoOwnKeys(object, 'ArrayBuffer');
      const byteLength = Object.getOwnPropertyDescriptor(
        ArrayBuffer.prototype,
        'byteLength'
      )?.get?.call(object) as number;
      accountBytes(byteLength);
      const captured = ArrayBuffer.prototype.slice.call(object, 0);
      seen.set(object, captured);
      return captured;
    }
    if (ArrayBuffer.isView(object)) {
      const view = object as ArrayBufferView;
      if (
        typeof SharedArrayBuffer !== 'undefined' &&
        view.buffer instanceof SharedArrayBuffer
      ) {
        throw new AxAgentSessionSerializationError(
          'snapshot integrity cannot authenticate views over mutable SharedArrayBuffer values'
        );
      }
      const capturedBuffer = visit(view.buffer, depth + 1) as ArrayBuffer;
      if (prototype === DataView.prototype) {
        assertNoOwnKeys(object, 'DataView');
        const captured = new DataView(
          capturedBuffer,
          view.byteOffset,
          view.byteLength
        );
        seen.set(object, captured);
        return captured;
      }
      const viewConstructor = TYPED_ARRAY_CONSTRUCTORS.find(
        (candidate) => prototype === candidate.prototype
      );
      if (!viewConstructor) {
        throw new AxAgentSessionSerializationError(
          'snapshot import cannot capture an unsupported array-buffer view'
        );
      }
      const length = (object as ArrayBufferView & { length: number }).length;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > SNAPSHOT_IMPORT_LIMITS.maxValues - values
      ) {
        throw new AxAgentSessionSerializationError(
          `snapshot import exceeds maxValues ${SNAPSHOT_IMPORT_LIMITS.maxValues}`
        );
      }
      values += length;
      const keys = Reflect.ownKeys(object);
      if (
        keys.length !== length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new AxAgentSessionSerializationError(
          'snapshot import does not support custom own keys on typed arrays'
        );
      }
      const captured = new viewConstructor(
        capturedBuffer,
        view.byteOffset,
        length
      );
      seen.set(object, captured);
      return captured;
    }

    const isBlob =
      typeof Blob !== 'undefined' &&
      (prototype === Blob.prototype ||
        (typeof File !== 'undefined' && prototype === File.prototype));
    if (isBlob) {
      const sourceBlob = object as Blob;
      const size = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        'size'
      )?.get?.call(object) as number;
      const type = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        'type'
      )?.get?.call(object) as string;
      accountBytes(size);
      accountString(type);
      let captured: Blob;
      if (typeof File !== 'undefined' && prototype === File.prototype) {
        const name = Object.getOwnPropertyDescriptor(
          File.prototype,
          'name'
        )?.get?.call(object) as string;
        const lastModified = Object.getOwnPropertyDescriptor(
          File.prototype,
          'lastModified'
        )?.get?.call(object) as number;
        accountString(name);
        captured = new File([sourceBlob], name, { lastModified, type });
      } else {
        captured = new Blob([sourceBlob], { type });
      }
      assertSameIntrinsicOwnKeys(object, captured, captured.constructor.name);
      seen.set(object, captured);
      return captured;
    }

    const errorName = ERROR_PROTOTYPES.get(prototype);
    if (errorName) {
      const keys = ownKeys(object);
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            !['cause', 'message', 'stack'].includes(key)
        )
      ) {
        throw new AxAgentSessionSerializationError(
          'snapshot import does not support custom own keys on Error'
        );
      }
      const descriptors = new Map(
        keys.map((key) => [key, descriptor(object, key)] as const)
      );
      for (const [key, current] of descriptors) {
        if (key !== 'stack' || 'value' in current) {
          assertDataDescriptor(current, key, true);
        }
        if (current.enumerable) {
          throw new AxAgentSessionSerializationError(
            `snapshot Error has an enumerable intrinsic own key "${String(key)}"`
          );
        }
      }
      const message = descriptors.get('message')?.value;
      const stack = descriptors.get('stack')?.value;
      if (message !== undefined && typeof message !== 'string') {
        throw new AxAgentSessionSerializationError(
          'snapshot Error has a non-string message'
        );
      }
      if (stack !== undefined && typeof stack !== 'string') {
        throw new AxAgentSessionSerializationError(
          'snapshot Error has a non-string stack'
        );
      }
      accountString(errorName);
      if (message !== undefined) accountString(message);
      if (stack !== undefined) accountString(stack);
      const captured = new Error();
      Object.setPrototypeOf(captured, prototype);
      seen.set(object, captured);
      for (const key of Reflect.ownKeys(captured)) {
        Reflect.deleteProperty(captured, key);
      }
      for (const [key, current] of descriptors) {
        if (key === 'stack' && !('value' in current)) {
          Object.defineProperty(captured, key, {
            get: () => undefined,
            enumerable: false,
            configurable: true,
          });
        } else {
          Object.defineProperty(captured, key, {
            value:
              key === 'cause' ? visit(current.value, depth + 1) : current.value,
            configurable: true,
            writable: true,
          });
        }
      }
      return captured;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new AxAgentSessionSerializationError(
        'snapshot integrity cannot encode unsupported platform values'
      );
    }
    const captured = Object.create(prototype) as Record<string, unknown>;
    seen.set(object, captured);
    captureEntries(object, captured, depth);
    return captured;
  }

  try {
    return visit(value, 0) as T;
  } catch (error) {
    if (error instanceof AxAgentSessionSerializationError) throw error;
    throw new AxAgentSessionSerializationError(errorMessage(error));
  }
}

async function canonicalSnapshotValue(value: unknown): Promise<unknown> {
  const seen = new Map<object, number>();
  let values = 0;
  let bytes = 0;

  const accountBytes = (amount: number) => {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      bytes > SNAPSHOT_IMPORT_LIMITS.maxBytes - amount
    ) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxBytes ${SNAPSHOT_IMPORT_LIMITS.maxBytes}`
      );
    }
    bytes += amount;
  };

  const accountString = (text: string) => accountBytes(text.length * 2);

  const entries = async (record: object, depth: number) => {
    const out: [string, unknown][] = [];
    for (const key of Object.keys(record)) {
      accountString(key);
      out.push([
        key,
        await encode((record as Record<string, unknown>)[key], depth + 1),
      ]);
    }
    return out;
  };

  const encode = async (current: unknown, depth: number): Promise<unknown> => {
    values++;
    if (values > SNAPSHOT_IMPORT_LIMITS.maxValues) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxValues ${SNAPSHOT_IMPORT_LIMITS.maxValues}`
      );
    }
    if (depth > SNAPSHOT_IMPORT_LIMITS.maxDepth) {
      throw new AxAgentSessionSerializationError(
        `snapshot import exceeds maxDepth ${SNAPSHOT_IMPORT_LIMITS.maxDepth}`
      );
    }
    if (current === null) return ['null'];
    switch (typeof current) {
      case 'undefined':
        return ['undefined'];
      case 'boolean':
        return ['boolean', current];
      case 'string':
        accountString(current);
        return ['string', current];
      case 'number':
        if (Number.isNaN(current)) return ['number', 'nan'];
        if (current === Number.POSITIVE_INFINITY)
          return ['number', 'positive-infinity'];
        if (current === Number.NEGATIVE_INFINITY)
          return ['number', 'negative-infinity'];
        if (Object.is(current, -0)) return ['number', 'negative-zero'];
        return ['number', current];
      case 'bigint':
        if (current > MAX_SNAPSHOT_BIGINT || current < -MAX_SNAPSHOT_BIGINT) {
          throw new AxAgentSessionSerializationError(
            `snapshot import exceeds maxBigIntBits ${SNAPSHOT_IMPORT_LIMITS.maxBigIntBits}`
          );
        }
        accountString(current.toString());
        return ['bigint', current.toString()];
      case 'function':
      case 'symbol':
        throw new AxAgentSessionSerializationError(
          `snapshot integrity cannot encode ${typeof current} values`
        );
    }

    const object = current as object;
    const reference = seen.get(object);
    if (reference !== undefined) return ['reference', reference];
    const id = seen.size;
    seen.set(object, id);

    if (Array.isArray(object)) {
      return ['array', id, object.length, await entries(object, depth)];
    }
    if (object instanceof Date) {
      return ['date', id, await encode(object.getTime(), depth + 1)];
    }
    if (object instanceof RegExp) {
      accountString(object.source);
      accountString(object.flags);
      return ['regexp', id, object.source, object.flags, object.lastIndex];
    }
    if (object instanceof Map) {
      const mapped: [unknown, unknown][] = [];
      for (const [key, nested] of object) {
        mapped.push([
          await encode(key, depth + 1),
          await encode(nested, depth + 1),
        ]);
      }
      return ['map', id, mapped];
    }
    if (object instanceof Set) {
      const values: unknown[] = [];
      for (const nested of object) values.push(await encode(nested, depth + 1));
      return ['set', id, values];
    }
    if (object instanceof ArrayBuffer) {
      accountBytes(object.byteLength);
      return ['array-buffer', id, object.byteLength, await sha256(object)];
    }
    if (
      typeof SharedArrayBuffer !== 'undefined' &&
      object instanceof SharedArrayBuffer
    ) {
      throw new AxAgentSessionSerializationError(
        'snapshot integrity cannot authenticate mutable SharedArrayBuffer values'
      );
    }
    if (ArrayBuffer.isView(object)) {
      const view = object as ArrayBufferView;
      if (
        typeof SharedArrayBuffer !== 'undefined' &&
        view.buffer instanceof SharedArrayBuffer
      ) {
        throw new AxAgentSessionSerializationError(
          'snapshot integrity cannot authenticate views over mutable SharedArrayBuffer values'
        );
      }
      if (!(object instanceof DataView)) {
        const length = (object as ArrayBufferView & { length: number }).length;
        if (length > SNAPSHOT_IMPORT_LIMITS.maxValues - values) {
          throw new AxAgentSessionSerializationError(
            `snapshot import exceeds maxValues ${SNAPSHOT_IMPORT_LIMITS.maxValues}`
          );
        }
        values += length;
      }
      return [
        'array-buffer-view',
        id,
        object.constructor.name,
        view.byteOffset,
        view.byteLength,
        await encode(view.buffer, depth + 1),
      ];
    }
    if (typeof Blob !== 'undefined' && object instanceof Blob) {
      const file: [string, number] | undefined =
        typeof File !== 'undefined' && object instanceof File
          ? [object.name, object.lastModified]
          : undefined;
      accountBytes(object.size);
      accountString(object.type);
      if (file) accountString(file[0]);
      return [
        'blob',
        id,
        object.type,
        file,
        object.size,
        await sha256(await object.arrayBuffer()),
      ];
    }
    if (object instanceof Error) {
      const keys = Reflect.ownKeys(object);
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            !['cause', 'message', 'stack'].includes(key)
        )
      ) {
        throw new AxAgentSessionSerializationError(
          'snapshot integrity cannot encode custom own keys on Error'
        );
      }
      for (const key of keys) accountString(key as string);
      const descriptors = new Map(
        keys.map(
          (key) =>
            [key, Reflect.getOwnPropertyDescriptor(object, key)!] as const
        )
      );
      for (const [key, current] of descriptors) {
        if (current.enumerable) {
          throw new AxAgentSessionSerializationError(
            `snapshot Error has an enumerable intrinsic own key "${String(key)}"`
          );
        }
        if (key !== 'stack' && !('value' in current)) {
          throw new AxAgentSessionSerializationError(
            `snapshot integrity cannot encode accessor own key "${String(key)}" on Error`
          );
        }
      }
      const message = descriptors.get('message')?.value;
      const stackDescriptor = descriptors.get('stack');
      const stack = stackDescriptor
        ? 'value' in stackDescriptor
          ? ['value', stackDescriptor.value]
          : ['native-accessor']
        : ['absent'];
      const cause = descriptors.get('cause')?.value;
      if (message !== undefined && typeof message !== 'string') {
        throw new AxAgentSessionSerializationError(
          'snapshot Error has a non-string message'
        );
      }
      if (stack[0] === 'value' && typeof stack[1] !== 'string') {
        throw new AxAgentSessionSerializationError(
          'snapshot Error has a non-string stack'
        );
      }
      accountString(object.name);
      if (message !== undefined) accountString(message);
      if (stack[0] === 'value') accountString(stack[1] as string);
      return [
        'error',
        id,
        object.name,
        message,
        stack,
        keys,
        await encode(cause, depth + 1),
      ];
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AxAgentSessionSerializationError(
        `snapshot integrity cannot encode ${object.constructor?.name ?? 'platform'} values`
      );
    }
    return ['object', id, prototype === null, await entries(object, depth)];
  };

  return encode(value, 0);
}

function canonicalPolicy(snapshot: Readonly<AxAgentSessionRegistrySnapshot>) {
  const authenticated = { ...snapshot } as Record<string, unknown>;
  delete authenticated.revision;
  delete authenticated.policyDigest;
  return authenticated;
}

async function digestPolicy(
  snapshot: Readonly<AxAgentSessionRegistrySnapshot>
): Promise<string> {
  const canonical = canonicalPolicy(snapshot);
  return sha256(JSON.stringify(await canonicalSnapshotValue(canonical)));
}

function timingSafeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === 'AbortError' || /abort/i.test(error.message)))
  );
}

function usageEntries(
  usage: AxAgentUsage | readonly AxProgramUsage[]
): readonly AxProgramUsage[] {
  return 'actor' in usage ? [...usage.actor, ...usage.responder] : usage;
}

function normalizeUsage(
  usage: AxAgentUsage | readonly AxProgramUsage[]
): AxAgentSessionUsage {
  const out = emptyUsage();
  for (const entry of usageEntries(usage)) {
    out.modelCalls++;
    const promptTokens = entry.tokens?.promptTokens ?? 0;
    const completionTokens = entry.tokens?.completionTokens ?? 0;
    out.promptTokens += promptTokens;
    out.completionTokens += completionTokens;
    out.totalTokens += promptTokens + completionTokens;
  }
  return out;
}

function latestCompletedMessage(
  record: Readonly<AxAgentSessionRecord>
): AxAgentSessionMessage | undefined {
  for (let index = record.mailbox.length - 1; index >= 0; index--) {
    const message = record.mailbox[index];
    if (message?.status === 'completed') return message;
  }
  return undefined;
}

function handleFor(record: Readonly<AxAgentSessionRecord>) {
  return cloneStructured(record.handle);
}

export class AxAgentSessionConflictError extends Error {
  constructor(message = 'Retained agent session registry revision conflict') {
    super(message);
    this.name = 'AxAgentSessionConflictError';
  }
}

export class AxAgentSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Retained agent session "${id}" was not found`);
    this.name = 'AxAgentSessionNotFoundError';
  }
}

export class AxAgentSessionStaleHandleError extends Error {
  constructor(id: string) {
    super(`Retained agent session handle for "${id}" is stale or unauthorized`);
    this.name = 'AxAgentSessionStaleHandleError';
  }
}

export class AxAgentSessionAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AxAgentSessionAuthorizationError';
  }
}

export class AxAgentSessionLimitError extends Error {
  constructor(
    readonly limit: keyof AxAgentSessionLimits,
    message: string
  ) {
    super(message);
    this.name = 'AxAgentSessionLimitError';
  }
}

export class AxAgentSessionSerializationError extends Error {
  constructor(message: string) {
    super(`Retained agent session value is not serializable: ${message}`);
    this.name = 'AxAgentSessionSerializationError';
  }
}

export class AxAgentSessionResultNotReadyError extends Error {
  constructor(id: string) {
    super(`Retained agent session "${id}" has no completed result`);
    this.name = 'AxAgentSessionResultNotReadyError';
  }
}

export class AxInMemoryAgentSessionStore implements AxAgentSessionStore {
  readonly capabilities = {
    durability: 'volatile',
    coordination: 'single-worker',
  } as const;

  private readonly roots = new Map<string, AxAgentSessionRegistrySnapshot>();

  async load(
    rootId: string
  ): Promise<Readonly<AxAgentSessionRegistrySnapshot> | undefined> {
    const snapshot = this.roots.get(rootId);
    return snapshot ? cloneStructured(snapshot) : undefined;
  }

  async save(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    expectedRevision: number | undefined
  ): Promise<Readonly<AxAgentSessionRegistrySnapshot>> {
    const current = this.roots.get(snapshot.root.id);
    if (current?.revision !== expectedRevision) {
      throw new AxAgentSessionConflictError();
    }
    const next = cloneStructured({
      ...snapshot,
      revision: (current?.revision ?? 0) + 1,
    });
    this.roots.set(snapshot.root.id, next);
    return cloneStructured(next);
  }

  async delete(rootId: string): Promise<void> {
    this.roots.delete(rootId);
  }

  async listRoots(): Promise<readonly string[]> {
    return [...this.roots.keys()].sort();
  }
}

export class AxInMemoryAgentSessionScheduler
  implements AxAgentSessionScheduler
{
  readonly capabilities = {
    durability: 'volatile',
    coordination: 'single-worker',
  } as const;

  private handler?: (job: Readonly<AxAgentSessionJob>) => Promise<void>;
  private readonly queue: AxAgentSessionJob[] = [];
  private readonly queuedIds = new Set<string>();
  private running = 0;
  private closed = false;

  constructor(private readonly maxConcurrency = 64) {
    validatePositiveLimit('maxConcurrency', maxConcurrency);
  }

  attach(
    handler: (job: Readonly<AxAgentSessionJob>) => Promise<void>
  ): () => void {
    if (this.handler) {
      throw new Error('AxInMemoryAgentSessionScheduler already has a handler');
    }
    this.handler = handler;
    this.pump();
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  async enqueue(job: Readonly<AxAgentSessionJob>): Promise<void> {
    if (this.closed)
      throw new Error('Retained agent session scheduler is closed');
    if (this.queuedIds.has(job.id)) return;
    this.queuedIds.add(job.id);
    this.queue.push(cloneStructured(job));
    this.pump();
  }

  async cancel(jobId: string): Promise<boolean> {
    const index = this.queue.findIndex((job) => job.id === jobId);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.queuedIds.delete(jobId);
    return true;
  }

  close(): void {
    this.closed = true;
    this.handler = undefined;
  }

  private pump(): void {
    while (
      !this.closed &&
      this.handler &&
      this.running < this.maxConcurrency &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift()!;
      this.queuedIds.delete(job.id);
      const handler = this.handler;
      this.running++;
      queueMicrotask(() => {
        void handler(job)
          .catch((error) => {
            // Surface post-claim failures so recovery can fence the attempt.
            void error;
          })
          .finally(() => {
            this.running--;
            this.pump();
          });
      });
    }
  }
}

type RegistryMutation<T> = (snapshot: AxAgentSessionRegistrySnapshot) => T;
const SKIP_MUTATION = Symbol('skip-retained-session-mutation');

type LiveAgent = {
  agent: AxRetainedAgent;
  registration: AxAgentSessionRegistration;
};

type ActiveAttempt = {
  controller: AbortController;
  rootId: string;
  settled: Promise<void>;
  settle: () => void;
};

export class AxAgentSessionHost {
  private readonly registrations = new Map<
    string,
    AxAgentSessionRegistration
  >();
  private readonly ai?: Readonly<AxAIService>;
  private readonly store: AxAgentSessionStore;
  private readonly scheduler: AxAgentSessionScheduler;
  private readonly limits: AxAgentSessionLimits;
  private readonly now: () => number;
  private readonly onEvent?: AxAgentSessionHostOptions['onEvent'];
  private readonly liveAgents = new Map<string, LiveAgent>();
  private readonly activeAttempts = new Map<string, ActiveAttempt>();
  private readonly rootAbortListeners = new Map<
    string,
    { signal: AbortSignal; listener: () => void }
  >();
  private readonly rootDrains = new Map<string, Promise<void>>();
  private readonly recoveryJobs = new Set<string>();
  private readonly publishingEvents = new Map<string, number>();
  private readonly ownedEpochs = new Map<string, number>();
  private detachScheduler?: () => void;
  private closed = false;

  constructor(options: Readonly<AxAgentSessionHostOptions>) {
    for (const registration of options.registrations) {
      validateRegistrationKey(registration.key);
      if (this.registrations.has(registration.key)) {
        throw new Error(
          `Duplicate retained agent registration key "${registration.key}"`
        );
      }
      this.registrations.set(registration.key, registration);
    }
    for (const registration of options.registrations) {
      for (const key of registration.authorizedChildren ?? []) {
        if (!this.registrations.has(key)) {
          throw new Error(
            `Retained agent registration "${registration.key}" authorizes unknown child "${key}"`
          );
        }
      }
    }
    this.ai = options.ai;
    this.store = options.store ?? new AxInMemoryAgentSessionStore();
    this.scheduler = options.scheduler ?? new AxInMemoryAgentSessionScheduler();
    this.limits = resolveLimits(DEFAULT_LIMITS, options.limits);
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    const detach = this.scheduler.attach(async (job) => {
      try {
        await this.dispatch(job);
      } catch {
        await this.reconcileDispatchFailure(job);
      }
    });
    if (typeof detach === 'function') this.detachScheduler = detach;
  }

  static continuationKey(
    handleOrId: Readonly<AxAgentSessionHandle> | string
  ): Readonly<{ kind: 'ax-agent-session'; value: string }> {
    return {
      kind: 'ax-agent-session',
      value: typeof handleOrId === 'string' ? handleOrId : handleOrId.id,
    };
  }

  async createRoot(
    options: Readonly<AxAgentSessionRootOptions>
  ): Promise<AxAgentSessionClient> {
    this.assertOpen();
    const id = options.id ?? `root-${randomUUID()}`;
    for (const key of options.authorizedChildren) {
      if (!this.registrations.has(key)) {
        throw new AxAgentSessionAuthorizationError(
          `Root authorizes unknown retained agent registration "${key}"`
        );
      }
    }
    const now = this.now();
    const root: AxAgentSessionRootRecord = {
      id,
      capability: randomUUID(),
      epoch: 1,
      authorizedChildren: canonicalKeys(options.authorizedChildren),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      limits: resolveLimits(this.limits, options.limits),
      admittedChildren: 0,
      admittedSubcalls: 0,
      descendantUsage: emptyUsage(),
      retiredDescendantUsage: emptyUsage(),
      reservedTokens: 0,
      outcomeUnknownTokens: 0,
      retiredOutcomeUnknownTokens: 0,
      retiredSubcalls: 0,
    };
    const initial: AxAgentSessionRegistrySnapshot = {
      version: 1,
      revision: 0,
      policyDigest: '',
      root,
      sessions: {},
    };
    initial.policyDigest = await digestPolicy(initial);
    const saved = await this.store.save(initial, undefined);
    this.ownedEpochs.set(saved.root.id, saved.root.epoch);
    const client = this.clientFor(
      saved.root.id,
      saved.root.capability,
      saved.root.epoch
    );
    if (options.abortSignal) {
      const signal = options.abortSignal;
      const listener = () => {
        this.rootAbortListeners.delete(saved.root.id);
        void this.cancelRoot(saved.root.id).catch(() => {
          // A host that was already closed owns no further cancellation work.
        });
      };
      this.rootAbortListeners.set(saved.root.id, { signal, listener });
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) {
        signal.removeEventListener('abort', listener);
        this.rootAbortListeners.delete(saved.root.id);
        await this.cancelRoot(saved.root.id);
      }
    }
    return client;
  }

  async restoreRoot(rootId: string): Promise<AxAgentSessionClient> {
    const snapshot = await this.requireRoot(rootId);
    return this.clientFor(
      snapshot.root.id,
      snapshot.root.capability,
      snapshot.root.epoch
    );
  }

  async snapshot(rootId: string): Promise<AxAgentSessionRegistrySnapshot> {
    return cloneStructured(await this.requireRoot(rootId));
  }

  async restore(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    options: Readonly<AxAgentSessionRestoreOptions>
  ): Promise<AxAgentSessionClient> {
    this.assertOpen();
    const restored = captureSnapshotImport(
      snapshot
    ) as AxAgentSessionRegistrySnapshot;
    await this.validateSnapshot(restored, options.expectedPolicyDigest);
    restored.revision = 0;
    this.interruptRunning(restored);
    this.rotateExecutionAuthority(restored);
    this.reconcileBudget(restored);
    restored.policyDigest = await digestPolicy(restored);
    await this.validateSnapshot(restored);
    const saved = await this.store.save(restored, undefined);
    this.ownedEpochs.set(saved.root.id, saved.root.epoch);
    await this.scheduleReady(saved.root.id, saved.root.epoch);
    return this.clientFor(
      saved.root.id,
      saved.root.capability,
      saved.root.epoch
    );
  }

  /**
   * Reconcile durable state after a worker/process crash. Running messages are
   * fenced as outcome_unknown and are never replayed; pending messages resume.
   */
  async recover(rootId?: string): Promise<void> {
    this.assertOpen();
    const roots = rootId ? [rootId] : await this.store.listRoots();
    for (const id of roots) {
      if ((this.publishingEvents.get(id) ?? 0) > 0) {
        throw new Error(
          'Retained agent session recovery cannot run from its own lifecycle event callback'
        );
      }
      const outcome = await this.mutate(id, (snapshot) => {
        const records: AxAgentSessionRecord[] = [];
        this.interruptRunning(snapshot, records);
        this.rotateExecutionAuthority(snapshot);
        return {
          interrupted: records,
          sessionIds: Object.keys(snapshot.sessions),
          epoch: snapshot.root.epoch,
        };
      });
      this.ownedEpochs.set(id, outcome.epoch);
      const drain = this.beginRootDrain(id);
      for (const sessionId of outcome.sessionIds) {
        this.stopLiveAgent(sessionId);
      }
      await drain;
      for (const record of outcome.interrupted) {
        await this.emit('interrupted', record);
      }
      if (!(await this.scheduleReady(id, outcome.epoch))) {
        throw new Error(
          'Retained agent recovery could not schedule current-epoch pending work'
        );
      }
    }
  }

  async close(options: Readonly<{ abort?: boolean }> = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachScheduler?.();
    for (const { signal, listener } of this.rootAbortListeners.values()) {
      signal.removeEventListener('abort', listener);
    }
    this.rootAbortListeners.clear();
    if (options.abort) {
      for (const attempt of this.activeAttempts.values()) {
        attempt.controller.abort('Retained agent session host closed');
      }
      for (const sessionId of this.liveAgents.keys()) {
        this.stopLiveAgent(sessionId);
      }
    }
    await this.scheduler.close?.();
  }

  private clientFor(sessionId: string, capability: string, epoch: number) {
    return new AxAgentSessionClient(this, sessionId, capability, epoch);
  }

  async spawn(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    registrationKey: string,
    input: unknown
  ): Promise<AxAgentSessionHandle> {
    return this.spawnAdmitted(
      parentId,
      parentCapability,
      parentEpoch,
      registrationKey,
      input
    );
  }

  private async spawnAdmitted(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    registrationKey: string,
    input: unknown,
    onAdmitted?: (
      handle: Readonly<AxAgentSessionHandle>,
      schedule: () => Promise<void>
    ) => 'deferred' | undefined
  ): Promise<AxAgentSessionHandle> {
    this.assertOpen();
    const clonedInput = cloneStructured(input);
    const id = `child-${randomUUID()}`;
    const capability = randomUUID();
    const now = this.now();
    const admitted = await this.mutateBySession(
      parentId,
      parentCapability,
      parentEpoch,
      (snapshot, parent) => {
        const allowed = parent.authorizedChildren;
        const parentRecord = snapshot.sessions[parentId];
        if (
          snapshot.root.status === 'cancelled' ||
          parentRecord?.status === 'cancelling' ||
          parentRecord?.status === 'cancelled'
        ) {
          throw new AxAgentSessionAuthorizationError(
            `Retained session "${parentId}" is cancelled and cannot admit children`
          );
        }
        if (!allowed.includes(registrationKey)) {
          throw new AxAgentSessionAuthorizationError(
            `Session "${parentId}" is not authorized to admit retained agent "${registrationKey}"`
          );
        }
        if (!this.registrations.has(registrationKey)) {
          throw new AxAgentSessionAuthorizationError(
            `Retained agent registration "${registrationKey}" is unavailable`
          );
        }
        const depth = parent.depth + 1;
        if (depth > snapshot.root.limits.maxDepth) {
          throw new AxAgentSessionLimitError(
            'maxDepth',
            `Retained agent depth ${depth} exceeds maxDepth ${snapshot.root.limits.maxDepth}`
          );
        }
        if (
          snapshot.root.admittedChildren >= snapshot.root.limits.maxChildren
        ) {
          throw new AxAgentSessionLimitError(
            'maxChildren',
            `Retained child count reached maxChildren ${snapshot.root.limits.maxChildren}`
          );
        }
        this.reserveSubcall(snapshot);
        const registration = this.registrations.get(registrationKey)!;
        const childHandle: AxAgentSessionHandle = {
          version: 1,
          id,
          parentId,
          rootId: snapshot.root.id,
          registrationKey,
          epoch: snapshot.root.epoch,
          capability,
        };
        const message = this.createMessage('follow-up', clonedInput, now);
        const record: AxAgentSessionRecord = {
          handle: childHandle,
          depth,
          authorizedChildren: canonicalKeys(
            registration.authorizedChildren ?? []
          ),
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          mailbox: [message],
          usage: emptyUsage(),
          descendantUsage: emptyUsage(),
          retiredDescendantUsage: emptyUsage(),
        };
        snapshot.sessions[id] = record;
        snapshot.root.admittedChildren++;
        return {
          handle: cloneStructured(childHandle),
          record: cloneStructured(record),
          message: cloneStructured(message),
        };
      }
    );
    const schedule = async () => {
      await this.enqueueSafely(admitted.record, admitted.message);
      await this.emit('queued', admitted.record, admitted.message.id);
    };
    if (onAdmitted?.(admitted.handle, schedule) !== 'deferred') {
      await schedule();
    }
    return cloneStructured(admitted.handle);
  }

  async inspect(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    handle: Readonly<AxAgentSessionHandle>
  ): Promise<AxAgentSessionStatusView> {
    const record = await this.authorizedRecord(
      parentId,
      parentCapability,
      parentEpoch,
      handle
    );
    return this.view(record);
  }

  async result(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    handle: Readonly<AxAgentSessionHandle>
  ): Promise<unknown> {
    const record = await this.authorizedRecord(
      parentId,
      parentCapability,
      parentEpoch,
      handle
    );
    const message = latestCompletedMessage(record);
    if (!message) {
      throw new AxAgentSessionResultNotReadyError(handle.id);
    }
    return cloneStructured(message.result);
  }

  async send(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    handle: Readonly<AxAgentSessionHandle>,
    input: unknown,
    mode: AxAgentSessionMessageMode
  ): Promise<AxAgentSessionSendReceipt> {
    return this.sendAdmitted(
      parentId,
      parentCapability,
      parentEpoch,
      handle,
      input,
      mode
    );
  }

  private async sendAdmitted(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    handle: Readonly<AxAgentSessionHandle>,
    input: unknown,
    mode: AxAgentSessionMessageMode,
    onAdmitted?: (schedule: () => Promise<void>) => 'deferred' | undefined
  ): Promise<AxAgentSessionSendReceipt> {
    this.assertOpen();
    if (mode !== 'steer' && mode !== 'follow-up') {
      throw new Error('Retained agent message mode must be steer or follow-up');
    }
    const clonedInput = cloneStructured(input);
    const now = this.now();
    const result = await this.mutate(handle.rootId, (snapshot) => {
      this.assertParent(snapshot, parentId, parentCapability, parentEpoch);
      if (snapshot.root.status === 'cancelled') {
        throw new AxAgentSessionAuthorizationError(
          `Retained root "${snapshot.root.id}" is cancelled and cannot accept messages`
        );
      }
      const record = this.assertHandle(snapshot, parentId, handle);
      const pending = record.mailbox.filter(
        (message) => message.status === 'pending'
      ).length;
      if (pending >= snapshot.root.limits.maxPendingMessages) {
        throw new AxAgentSessionLimitError(
          'maxPendingMessages',
          `Session "${record.handle.id}" reached maxPendingMessages ${snapshot.root.limits.maxPendingMessages}`
        );
      }
      if (record.mailbox.length >= snapshot.root.limits.maxRetainedMessages) {
        throw new AxAgentSessionLimitError(
          'maxRetainedMessages',
          `Session "${record.handle.id}" reached maxRetainedMessages ${snapshot.root.limits.maxRetainedMessages}`
        );
      }
      this.reserveSubcall(snapshot);
      const message = this.createMessage(mode, clonedInput, now);
      record.mailbox.push(message);
      const active = record.activeMessageId
        ? record.mailbox.find((item) => item.id === record.activeMessageId)
        : undefined;
      if (mode === 'steer' && active?.status === 'running') {
        active.cancelRequested = true;
        record.status = 'cancelling';
      } else if (!active) {
        record.status = 'queued';
      }
      record.updatedAt = now;
      return {
        record: cloneStructured(record),
        receipt: {
          messageId: message.id,
          mode,
          acceptedAt: now,
          delivery:
            mode === 'steer' && active
              ? ('interrupting' as const)
              : active
                ? ('queued' as const)
                : ('ready' as const),
        },
        activeJobId: mode === 'steer' ? active?.jobId : undefined,
        hasActiveMessage: Boolean(active),
      };
    });

    let interruptAccepted: boolean | undefined;
    const schedule = async () => {
      if (result.activeJobId) {
        interruptAccepted = await this.cancelScheduledJob(
          result.activeJobId,
          'Retained child steered by parent'
        );
      }
      if (!result.hasActiveMessage) {
        await this.scheduleReady(handle.rootId, parentEpoch);
      }
      await this.emit('queued', result.record, result.receipt.messageId);
    };
    if (onAdmitted?.(schedule) !== 'deferred') await schedule();
    return {
      ...result.receipt,
      ...(interruptAccepted !== undefined ? { interruptAccepted } : {}),
    };
  }

  async cancel(
    sessionId: string,
    capability: string,
    epoch: number,
    handle?: Readonly<AxAgentSessionHandle>
  ): Promise<void> {
    this.assertOpen();
    const root = await this.rootForSession(sessionId);
    if (!handle && sessionId === root.root.id) {
      const outcome = await this.mutateOptional(root.root.id, (snapshot) => {
        this.assertParent(snapshot, sessionId, capability, epoch);
        if (snapshot.root.status === 'cancelled') return SKIP_MUTATION;
        return {
          ...this.cancelInSnapshot(snapshot, snapshot.root.id),
          rootCancelled: true as const,
        };
      });
      this.detachRootAbortListener(root.root.id);
      if (outcome) await this.finishCancellation(outcome);
      return;
    }
    const outcome = await this.mutate(root.root.id, (snapshot) => {
      this.assertParent(snapshot, sessionId, capability, epoch);
      const targetId = handle
        ? this.assertHandle(snapshot, sessionId, handle).handle.id
        : sessionId;
      return {
        ...this.cancelInSnapshot(snapshot, targetId),
        rootCancelled: targetId === snapshot.root.id,
      };
    });
    await this.finishCancellation(outcome);
  }

  private async cancelRoot(rootId: string): Promise<void> {
    this.assertOpen();
    const outcome = await this.mutateOptional(rootId, (snapshot) =>
      snapshot.root.status === 'cancelled'
        ? SKIP_MUTATION
        : this.cancelInSnapshot(snapshot, snapshot.root.id)
    );
    this.detachRootAbortListener(rootId);
    if (outcome) await this.finishCancellation(outcome);
  }

  private async finishCancellation(
    outcome: Readonly<{
      jobs: readonly string[];
      affected: readonly AxAgentSessionRecord[];
    }>
  ): Promise<void> {
    for (const job of outcome.jobs) {
      await this.cancelScheduledJob(job, 'Retained agent session cancelled');
    }
    for (const record of outcome.affected) await this.emit('cancelled', record);
  }

  async dispose(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    handle: Readonly<AxAgentSessionHandle>
  ): Promise<void> {
    this.assertOpen();
    const outcome = await this.mutate(handle.rootId, (snapshot) => {
      const jobs: string[] = [];
      const records: AxAgentSessionRecord[] = [];
      this.assertParent(snapshot, parentId, parentCapability, parentEpoch);
      const target = this.assertHandle(snapshot, parentId, handle);
      const ids = this.descendants(snapshot, target.handle.id, true);
      const retiredUsage = cloneStructured(target.usage);
      addUsage(retiredUsage, target.descendantUsage);
      if (target.handle.parentId === snapshot.root.id) {
        addUsage(snapshot.root.retiredDescendantUsage, retiredUsage);
      } else {
        addUsage(
          snapshot.sessions[target.handle.parentId]!.retiredDescendantUsage,
          retiredUsage
        );
      }
      for (const id of ids) {
        const record = snapshot.sessions[id];
        if (!record) continue;
        records.push(cloneStructured(record));
        jobs.push(...record.mailbox.map((message) => message.jobId));
        snapshot.root.retiredSubcalls += record.mailbox.length;
        for (const message of record.mailbox) {
          if (message.status === 'running' && message.tokenReservation) {
            snapshot.root.reservedTokens -= message.tokenReservation;
            snapshot.root.outcomeUnknownTokens += message.tokenReservation;
            snapshot.root.retiredOutcomeUnknownTokens +=
              message.tokenReservation;
          } else if (
            message.status === 'outcome_unknown' &&
            message.tokenReservation
          ) {
            snapshot.root.retiredOutcomeUnknownTokens +=
              message.tokenReservation;
          }
        }
        delete snapshot.sessions[id];
        snapshot.root.admittedChildren--;
      }
      return { jobs, records };
    });
    for (const job of outcome.jobs) {
      await this.cancelScheduledJob(job, 'Retained agent session disposed');
    }
    for (const record of outcome.records) {
      this.stopLiveAgent(record.handle.id);
      await this.emit('disposed', record);
    }
  }

  async list(
    parentId: string,
    parentCapability: string,
    parentEpoch: number
  ): Promise<AxAgentSessionStatusView[]> {
    const snapshot = await this.rootForSession(parentId);
    this.assertParent(snapshot, parentId, parentCapability, parentEpoch);
    return Object.values(snapshot.sessions)
      .filter((record) => record.handle.parentId === parentId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.view(record));
  }

  async inspectRoot(
    sessionId: string,
    capability: string,
    epoch: number
  ): Promise<AxAgentSessionRootView> {
    const snapshot = await this.rootForSession(sessionId);
    this.assertParent(snapshot, sessionId, capability, epoch);
    return {
      rootId: snapshot.root.id,
      status: snapshot.root.status,
      limits: cloneStructured(snapshot.root.limits),
      admittedChildren: snapshot.root.admittedChildren,
      admittedSubcalls: snapshot.root.admittedSubcalls,
      descendantUsage: cloneStructured(snapshot.root.descendantUsage),
      retiredDescendantUsage: cloneStructured(
        snapshot.root.retiredDescendantUsage
      ),
      reservedTokens: snapshot.root.reservedTokens,
      outcomeUnknownTokens: snapshot.root.outcomeUnknownTokens,
      retiredOutcomeUnknownTokens: snapshot.root.retiredOutcomeUnknownTokens,
      retiredSubcalls: snapshot.root.retiredSubcalls,
      ...(snapshot.root.budgetExceeded
        ? { budgetExceeded: snapshot.root.budgetExceeded }
        : {}),
      childCount: Object.keys(snapshot.sessions).length,
      durability: this.durability(),
    };
  }

  functions(
    sessionId: string,
    capability: string,
    epoch: number,
    options: Readonly<AxAgentSessionFunctionOptions> = {}
  ): AxFunction[] {
    const client = this.clientFor(sessionId, capability, epoch);
    const namespace = options.namespace ?? 'sessions';
    const objectSchema = { type: 'object' } as const;
    const handleSchema = {
      type: 'object',
      description: 'Serializable retained child session handle',
    } as const;
    const registerContinuation = (
      extra: Parameters<AxFunction['func']>[1],
      handle: Readonly<AxAgentSessionHandle>,
      schedule: () => Promise<void>
    ) => {
      if (!options.eventContinuations || !extra?.eventContext) return;
      extra.eventContext.registerContinuation({
        correlation: [AxAgentSessionHost.continuationKey(handle)],
      });
      extra.eventContext.afterContinuationsRegistered(schedule);
      return 'deferred' as const;
    };
    return [
      {
        name: 'spawn',
        namespace,
        description:
          'Admit an authorized retained child agent and return its stable handle immediately without waiting for completion.',
        parameters: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              description: 'Authorized stable registration key',
            },
            input: {
              ...objectSchema,
              description: 'Complete signature input for the child agent',
            },
          },
          required: ['agent', 'input'],
          additionalProperties: false,
        },
        returns: handleSchema,
        func: async (args, extra) => {
          return this.spawnAdmitted(
            sessionId,
            capability,
            epoch,
            args.agent,
            args.input,
            (handle, schedule) => registerContinuation(extra, handle, schedule)
          );
        },
      },
      {
        name: 'inspect',
        namespace,
        description:
          'Inspect lifecycle, mailbox, results, usage, and descendant usage for a retained direct child.',
        parameters: {
          type: 'object',
          properties: { handle: handleSchema },
          required: ['handle'],
          additionalProperties: false,
        },
        returns: objectSchema,
        func: (args) => client.inspect(args.handle),
      },
      {
        name: 'result',
        namespace,
        description: 'Return the latest completed result for a retained child.',
        parameters: {
          type: 'object',
          properties: { handle: handleSchema },
          required: ['handle'],
          additionalProperties: false,
        },
        func: (args) => client.result(args.handle),
      },
      {
        name: 'send',
        namespace,
        description:
          'Send another complete signature input to retained context. steer aborts current work before this message; follow-up queues behind it.',
        parameters: {
          type: 'object',
          properties: {
            handle: handleSchema,
            mode: {
              type: 'string',
              enum: ['steer', 'follow-up'],
              description: 'Explicit mailbox delivery policy',
            },
            input: {
              ...objectSchema,
              description: 'Complete signature input for the child agent',
            },
          },
          required: ['handle', 'mode', 'input'],
          additionalProperties: false,
        },
        returns: objectSchema,
        func: async (args, extra) => {
          return this.sendAdmitted(
            sessionId,
            capability,
            epoch,
            args.handle,
            args.input,
            args.mode,
            (schedule) => registerContinuation(extra, args.handle, schedule)
          );
        },
      },
      {
        name: 'cancel',
        namespace,
        description:
          'Cancel active and queued work for a retained direct child and all of its descendants without deleting retained state.',
        parameters: {
          type: 'object',
          properties: { handle: handleSchema },
          required: ['handle'],
          additionalProperties: false,
        },
        func: (args) => client.cancel(args.handle),
      },
      {
        name: 'dispose',
        namespace,
        description:
          'Cancel and permanently remove a retained direct child and all descendants from the host registry.',
        parameters: {
          type: 'object',
          properties: { handle: handleSchema },
          required: ['handle'],
          additionalProperties: false,
        },
        func: (args) => client.dispose(args.handle),
      },
    ];
  }

  private async dispatch(job: Readonly<AxAgentSessionJob>): Promise<void> {
    if (this.closed) return;
    if (this.ownedEpochs.get(job.rootId) !== job.epoch) {
      if (this.recoveryJobs.has(job.id)) await this.resumeRecoveryJob(job);
      return;
    }
    await this.rootDrains.get(job.rootId);
    if (this.closed) return;
    if (this.ownedEpochs.get(job.rootId) !== job.epoch) return;
    if (this.activeAttempts.has(job.id)) return;
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const attempt = { controller, rootId: job.rootId, settled, settle };
    this.activeAttempts.set(job.id, attempt);
    try {
      await this.dispatchControlled(job, controller);
    } finally {
      if (this.activeAttempts.get(job.id) === attempt) {
        this.activeAttempts.delete(job.id);
      }
      settle();
    }
  }

  private async dispatchControlled(
    job: Readonly<AxAgentSessionJob>,
    controller: AbortController
  ): Promise<void> {
    const attemptId = randomUUID();
    const recoveryJob = this.recoveryJobs.has(job.id);
    const claimed = await this.mutateAtEpoch(
      job.rootId,
      job.epoch,
      (snapshot) => {
        const record = snapshot.sessions[job.sessionId];
        const message = record?.mailbox.find(
          (item) => item.id === job.messageId
        );
        if (!record || !message) {
          return SKIP_MUTATION;
        }
        if (
          message.status === 'running' &&
          message.jobId === job.id &&
          recoveryJob
        ) {
          return { orphaned: true as const };
        }
        if (message.status !== 'pending') return SKIP_MUTATION;
        if (message.jobId !== job.id) return SKIP_MUTATION;
        if (record.activeMessageId) return SKIP_MUTATION;
        if (this.nextPending(record)?.id !== message.id) return SKIP_MUTATION;
        const running = Object.values(snapshot.sessions).filter(
          (item) => item.activeMessageId
        ).length;
        if (running >= snapshot.root.limits.maxConcurrency)
          return SKIP_MUTATION;
        const tokenReservation = snapshot.root.limits.maxTokensPerMessage;
        if (
          this.committedTokens(snapshot) + tokenReservation >
          snapshot.root.limits.maxTokens
        ) {
          return SKIP_MUTATION;
        }
        message.status = 'running';
        message.startedAt = this.now();
        message.attemptId = attemptId;
        message.tokenReservation = tokenReservation;
        snapshot.root.reservedTokens += tokenReservation;
        record.activeMessageId = message.id;
        record.status = 'running';
        record.updatedAt = this.now();
        delete record.lastError;
        return {
          orphaned: false as const,
          record: cloneStructured(record),
          message: cloneStructured(message),
        };
      }
    );
    if (!claimed) return;
    if (claimed.orphaned) {
      this.recoveryJobs.delete(job.id);
      throw new Error(
        'Retained agent dispatch found an orphaned durable claim'
      );
    }
    await this.emit('running', claimed.record, claimed.message.id);

    let live: LiveAgent | undefined;
    let result: unknown;
    let failure: unknown;
    let usage = emptyUsage();
    let nextState: AxAgentState | undefined;
    let nextArtifacts: unknown;
    let snapshotErrorMessage: string | undefined;
    try {
      if (controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      live = await this.liveAgent(claimed.record);
      if (controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      live.agent.resetUsage();
      const ai = live.registration.ai ?? this.ai;
      if (!ai) {
        throw new Error(
          `No AI service configured for retained agent "${claimed.record.handle.registrationKey}"`
        );
      }
      result = cloneStructured(
        await live.agent.forward(
          ai,
          claimed.message.input as Record<string, unknown>,
          {
            abortSignal: controller.signal,
            usageContext: {
              runId: claimed.message.id,
              parentRunId: claimed.record.handle.parentId,
              feature: 'retained-child-session',
              attributes: {
                rootId: claimed.record.handle.rootId,
                sessionId: claimed.record.handle.id,
                depth: claimed.record.depth,
              },
            },
          }
        )
      );
      try {
        const capturedState = live.agent.getState();
        nextState =
          capturedState === undefined
            ? undefined
            : cloneStructured(capturedState);
        if (live.registration.captureArtifacts) {
          const capturedArtifacts = await live.registration.captureArtifacts(
            live.agent
          );
          nextArtifacts =
            capturedArtifacts === undefined
              ? undefined
              : cloneStructured(capturedArtifacts);
        }
      } catch (snapshotError) {
        // A successful forward still owns the turn; record snapshot failure
        // without converting the result into a failed message.
        snapshotErrorMessage = errorMessage(snapshotError);
      }
    } catch (error) {
      failure = error;
      if (live && !isAbortError(error, controller.signal)) {
        try {
          const capturedState = live.agent.getState();
          nextState =
            capturedState === undefined
              ? undefined
              : cloneStructured(capturedState);
          if (live.registration.captureArtifacts) {
            const capturedArtifacts = await live.registration.captureArtifacts(
              live.agent
            );
            nextArtifacts =
              capturedArtifacts === undefined
                ? undefined
                : cloneStructured(capturedArtifacts);
          }
        } catch {
          // The original execution error owns the terminal status.
        }
      }
    } finally {
      if (live) {
        usage = normalizeUsage(live.agent.getUsage());
        if (!this.usesLiveAgentCache()) this.stopAgent(live.agent);
      }
    }

    const completion = await this.mutateAtEpoch(
      job.rootId,
      job.epoch,
      (snapshot) => {
        const cancelJobs: string[] = [];
        const record = snapshot.sessions[job.sessionId];
        const message = record?.mailbox.find(
          (item) => item.id === job.messageId
        );
        if (
          !record ||
          !message ||
          message.status !== 'running' ||
          message.attemptId !== attemptId
        ) {
          return SKIP_MUTATION;
        }
        const cancelled = message.cancelRequested || controller.signal.aborted;
        message.completedAt = this.now();
        delete message.attemptId;
        delete record.activeMessageId;
        snapshot.root.reservedTokens -= message.tokenReservation ?? 0;
        delete message.tokenReservation;
        message.usage = cloneStructured(usage);
        addUsage(record.usage, usage);
        addUsage(snapshot.root.descendantUsage, usage);
        let ancestorId = record.handle.parentId;
        while (ancestorId !== snapshot.root.id) {
          const ancestor = snapshot.sessions[ancestorId];
          if (!ancestor) break;
          addUsage(ancestor.descendantUsage, usage);
          ancestorId = ancestor.handle.parentId;
        }

        let terminalType: AxAgentSessionEvent['type'];
        if (cancelled) {
          message.status = 'cancelled';
          record.status = record.mailbox.some(
            (item) => item.status === 'pending'
          )
            ? 'queued'
            : 'cancelled';
          terminalType = 'cancelled';
        } else if (failure) {
          message.status = 'failed';
          message.error = errorMessage(failure);
          record.status = 'failed';
          record.lastError = message.error;
          if (nextState !== undefined)
            record.state = cloneStructured(nextState);
          if (nextArtifacts !== undefined)
            record.artifacts = cloneStructured(nextArtifacts);
          terminalType = 'failed';
        } else {
          message.status = 'completed';
          message.result = cloneStructured(result);
          record.status = 'completed';
          if (snapshotErrorMessage) record.lastError = snapshotErrorMessage;
          else delete record.lastError;
          if (nextState !== undefined)
            record.state = cloneStructured(nextState);
          if (nextArtifacts !== undefined)
            record.artifacts = cloneStructured(nextArtifacts);
          terminalType = 'completed';
        }
        record.updatedAt = this.now();
        if (
          this.durableTokens(snapshot) +
            snapshot.root.limits.maxTokensPerMessage >
          snapshot.root.limits.maxTokens
        ) {
          snapshot.root.budgetExceeded = 'tokens';
          for (const candidate of Object.values(snapshot.sessions)) {
            for (const queued of candidate.mailbox) {
              if (queued.status === 'pending') {
                queued.status = 'cancelled';
                queued.completedAt = this.now();
                cancelJobs.push(queued.jobId);
              } else if (
                queued.status === 'running' &&
                queued.id !== message.id
              ) {
                queued.cancelRequested = true;
                cancelJobs.push(queued.jobId);
                candidate.status = 'cancelling';
              }
            }
            if (
              !candidate.activeMessageId &&
              candidate.status === 'queued' &&
              !candidate.mailbox.some((item) => item.status === 'pending')
            ) {
              candidate.status = 'cancelled';
              candidate.updatedAt = this.now();
            }
          }
        }
        return {
          terminal: {
            type: terminalType,
            record: cloneStructured(record),
          },
          cancelJobs,
          rollback: cancelled,
        };
      }
    );

    if (completion?.rollback || snapshotErrorMessage) {
      const current = this.liveAgents.get(job.sessionId);
      if (current && current === live) {
        this.stopLiveAgent(job.sessionId);
      }
    }
    if (completion?.terminal) {
      await this.emit(
        completion.terminal.type,
        completion.terminal.record,
        job.messageId
      );
    }
    for (const cancelJob of completion?.cancelJobs ?? []) {
      await this.cancelScheduledJob(
        cancelJob,
        'Retained agent root token budget exhausted'
      );
    }
    if (completion && !this.closed) {
      await this.scheduleReady(job.rootId, job.epoch);
    }
  }

  private async reconcileDispatchFailure(
    job: Readonly<AxAgentSessionJob>
  ): Promise<void> {
    let retry = false;
    if (this.recoveryJobs.has(job.id)) {
      try {
        if (await this.resumeRecoveryJob(job)) return;
      } catch {
        retry = true;
      }
    }
    if (retry) {
      if (!this.closed) await this.scheduler.enqueue(job);
      return;
    }
    try {
      const snapshot = await this.requireRoot(job.rootId);
      if (snapshot.root.epoch !== job.epoch) return;
      const message = snapshot.sessions[job.sessionId]?.mailbox.find(
        (item) => item.id === job.messageId
      );
      if (!message || message.jobId !== job.id) return;
      if (message.status === 'running') {
        try {
          await this.recover(job.rootId);
          return;
        } catch {
          this.recoveryJobs.add(job.id);
          try {
            if (await this.resumeRecoveryJob(job)) return;
          } catch {
            // The marked job remains the retry intent until authority read-back
            // and current-epoch scheduling both succeed.
          }
          retry = true;
        }
      } else if (message.status === 'pending') {
        retry = true;
      }
    } catch {
      retry = true;
    }
    if (retry && !this.closed) await this.scheduler.enqueue(job);
  }

  private async liveAgent(record: Readonly<AxAgentSessionRecord>) {
    const cache = this.usesLiveAgentCache();
    const existing = cache ? this.liveAgents.get(record.handle.id) : undefined;
    if (existing) return existing;
    const registration = this.registrations.get(record.handle.registrationKey);
    if (!registration) {
      throw new AxAgentSessionAuthorizationError(
        `Retained agent registration "${record.handle.registrationKey}" is not configured on this host`
      );
    }
    const client = this.clientFor(
      record.handle.id,
      record.handle.capability,
      record.handle.epoch
    );
    const agent = registration.create({
      session: client,
      sessionId: record.handle.id,
      parentId: record.handle.parentId,
      rootId: record.handle.rootId,
      depth: record.depth,
    });
    try {
      if (record.state !== undefined) agent.setState(record.state);
      if (record.artifacts !== undefined && registration.restoreArtifacts) {
        await registration.restoreArtifacts(
          agent,
          cloneStructured(record.artifacts)
        );
      }
    } catch (error) {
      this.stopAgent(agent);
      throw error;
    }
    const live = { agent, registration };
    if (cache) this.liveAgents.set(record.handle.id, live);
    return live;
  }

  private usesLiveAgentCache(): boolean {
    return (
      this.store.capabilities.coordination === 'single-worker' &&
      this.scheduler.capabilities.coordination === 'single-worker'
    );
  }

  private async scheduleReady(
    rootId: string,
    expectedEpoch: number
  ): Promise<boolean> {
    if (this.closed) return true;
    if (this.ownedEpochs.get(rootId) !== expectedEpoch) return true;
    const snapshot = await this.requireRoot(rootId);
    return this.scheduleReadySnapshot(snapshot, expectedEpoch);
  }

  private async scheduleReadySnapshot(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    expectedEpoch: number
  ): Promise<boolean> {
    const rootId = snapshot.root.id;
    if (this.closed) return true;
    if (this.ownedEpochs.get(rootId) !== expectedEpoch) return true;
    if (snapshot.root.epoch !== expectedEpoch) return true;
    if (snapshot.root.budgetExceeded === 'tokens') return true;
    const running = Object.values(snapshot.sessions).filter(
      (record) => record.activeMessageId
    ).length;
    let capacity = Math.max(0, snapshot.root.limits.maxConcurrency - running);
    let scheduled = true;
    const records = Object.values(snapshot.sessions).sort(
      (left, right) => left.createdAt - right.createdAt
    );
    for (const record of records) {
      if (capacity <= 0) break;
      if (record.activeMessageId) continue;
      const message = this.nextPending(record);
      if (!message) continue;
      if (await this.enqueueSafely(record, message)) capacity--;
      else scheduled = false;
    }
    return scheduled;
  }

  private async resumeRecoveryJob(
    job: Readonly<AxAgentSessionJob>
  ): Promise<boolean> {
    const snapshot = await this.requireRoot(job.rootId);
    if (snapshot.root.epoch === job.epoch) return false;
    this.ownedEpochs.set(job.rootId, snapshot.root.epoch);
    await this.rootDrains.get(job.rootId);
    if (!(await this.scheduleReadySnapshot(snapshot, snapshot.root.epoch))) {
      throw new Error(
        'Retained agent recovery retry could not schedule current-epoch pending work'
      );
    }
    this.recoveryJobs.delete(job.id);
    return true;
  }

  private nextPending(
    record: Readonly<AxAgentSessionRecord>
  ): AxAgentSessionMessage | undefined {
    return (
      record.mailbox.find(
        (message) => message.status === 'pending' && message.mode === 'steer'
      ) ?? record.mailbox.find((message) => message.status === 'pending')
    );
  }

  private enqueue(
    record: Readonly<AxAgentSessionRecord>,
    message: Readonly<AxAgentSessionMessage>
  ) {
    return this.scheduler.enqueue({
      id: message.jobId,
      rootId: record.handle.rootId,
      sessionId: record.handle.id,
      messageId: message.id,
      epoch: record.handle.epoch,
      enqueuedAt: this.now(),
    });
  }

  private async enqueueSafely(
    record: Readonly<AxAgentSessionRecord>,
    message: Readonly<AxAgentSessionMessage>
  ): Promise<boolean> {
    try {
      await this.enqueue(record, message);
      return true;
    } catch (error) {
      await this.mutateAtEpoch(
        record.handle.rootId,
        record.handle.epoch,
        (snapshot) => {
          const current = snapshot.sessions[record.handle.id];
          const queued = current?.mailbox.find(
            (item) => item.id === message.id
          );
          if (
            current &&
            queued?.status === 'pending' &&
            queued.jobId === message.jobId
          ) {
            current.lastError = `Scheduler enqueue failed: ${errorMessage(error)}`;
            current.updatedAt = this.now();
            return true;
          }
          return SKIP_MUTATION;
        }
      );
      return false;
    }
  }

  private cancelInSnapshot(
    snapshot: AxAgentSessionRegistrySnapshot,
    targetId: string
  ): { jobs: string[]; affected: AxAgentSessionRecord[] } {
    const jobs: string[] = [];
    const affected: AxAgentSessionRecord[] = [];
    const ids = this.descendants(snapshot, targetId, true);
    if (targetId === snapshot.root.id) snapshot.root.status = 'cancelled';
    for (const id of ids) {
      const record = snapshot.sessions[id];
      if (!record) continue;
      for (const message of record.mailbox) {
        if (message.status === 'pending') {
          message.status = 'cancelled';
          message.completedAt = this.now();
          jobs.push(message.jobId);
        } else if (message.status === 'running') {
          message.cancelRequested = true;
          jobs.push(message.jobId);
        }
      }
      record.status = record.activeMessageId ? 'cancelling' : 'cancelled';
      record.updatedAt = this.now();
      if (!record.activeMessageId) affected.push(cloneStructured(record));
    }
    return { jobs, affected };
  }

  private beginRootDrain(rootId: string): Promise<void> {
    const attempts = [...this.activeAttempts.values()].filter(
      (attempt) => attempt.rootId === rootId
    );
    for (const attempt of attempts) {
      attempt.controller.abort('Retained agent session authority recovered');
    }
    const drain = Promise.all(attempts.map((attempt) => attempt.settled)).then(
      () => undefined
    );
    this.rootDrains.set(rootId, drain);
    void drain.finally(() => {
      if (this.rootDrains.get(rootId) === drain) this.rootDrains.delete(rootId);
    });
    return drain;
  }

  private detachRootAbortListener(rootId: string): void {
    const binding = this.rootAbortListeners.get(rootId);
    if (!binding) return;
    binding.signal.removeEventListener('abort', binding.listener);
    this.rootAbortListeners.delete(rootId);
  }

  private async cancelScheduledJob(
    jobId: string,
    reason: string
  ): Promise<boolean> {
    let accepted = false;
    const attempt = this.activeAttempts.get(jobId);
    if (attempt) {
      attempt.controller.abort(reason);
      accepted = true;
    }
    try {
      return (await this.scheduler.cancel(jobId)) || accepted;
    } catch {
      return accepted;
    }
  }

  private stopLiveAgent(sessionId: string): void {
    const live = this.liveAgents.get(sessionId);
    if (!live) return;
    this.liveAgents.delete(sessionId);
    this.stopAgent(live.agent);
  }

  private stopAgent(agent: AxRetainedAgent): void {
    try {
      agent.stop();
    } catch {
      // Registry lifecycle must not depend on best-effort runtime cleanup.
    }
  }

  private createMessage(
    mode: AxAgentSessionMessageMode,
    input: unknown,
    createdAt: number
  ): AxAgentSessionMessage {
    const id = `message-${randomUUID()}`;
    return {
      id,
      jobId: `job-${id}`,
      mode,
      status: 'pending',
      input,
      createdAt,
    };
  }

  private reserveSubcall(snapshot: AxAgentSessionRegistrySnapshot): void {
    if (
      snapshot.root.budgetExceeded === 'tokens' &&
      this.durableTokens(snapshot) + snapshot.root.limits.maxTokensPerMessage >
        snapshot.root.limits.maxTokens
    ) {
      throw new AxAgentSessionLimitError(
        'maxTokens',
        `Retained root token usage reached maxTokens ${snapshot.root.limits.maxTokens}`
      );
    }
    if (snapshot.root.admittedSubcalls >= snapshot.root.limits.maxSubcalls) {
      throw new AxAgentSessionLimitError(
        'maxSubcalls',
        `Retained root admission count reached maxSubcalls ${snapshot.root.limits.maxSubcalls}`
      );
    }
    snapshot.root.admittedSubcalls++;
    if (snapshot.root.admittedSubcalls === snapshot.root.limits.maxSubcalls) {
      snapshot.root.budgetExceeded = 'subcalls';
    }
  }

  private rotateExecutionAuthority(
    snapshot: AxAgentSessionRegistrySnapshot
  ): void {
    snapshot.root.epoch++;
    snapshot.root.capability = randomUUID();
    for (const record of Object.values(snapshot.sessions)) {
      record.handle.epoch = snapshot.root.epoch;
      record.handle.capability = randomUUID();
      for (const message of record.mailbox) {
        if (message.status === 'pending') {
          message.jobId = `job-${message.id}-epoch-${snapshot.root.epoch}-${randomUUID()}`;
        }
      }
    }
  }

  private interruptRunning(
    snapshot: AxAgentSessionRegistrySnapshot,
    interrupted: AxAgentSessionRecord[] = []
  ): void {
    let found = false;
    for (const record of Object.values(snapshot.sessions)) {
      let recordInterrupted = false;
      for (const message of record.mailbox) {
        if (message.status !== 'running') continue;
        const tokenReservation = message.tokenReservation ?? 0;
        snapshot.root.reservedTokens -= tokenReservation;
        snapshot.root.outcomeUnknownTokens += tokenReservation;
        message.status = 'outcome_unknown';
        message.completedAt = this.now();
        message.error =
          'Worker stopped before completion could be durably confirmed; the message was not replayed.';
        delete message.attemptId;
        delete message.cancelRequested;
        recordInterrupted = true;
        found = true;
      }
      if (recordInterrupted) {
        delete record.activeMessageId;
        record.status = 'interrupted';
        record.lastError =
          'A running message has outcome_unknown after crash recovery.';
        record.updatedAt = this.now();
        interrupted.push(cloneStructured(record));
      }
    }
    if (found && snapshot.root.status !== 'cancelled') {
      snapshot.root.status = 'interrupted';
      if (
        this.committedTokens(snapshot) +
          snapshot.root.limits.maxTokensPerMessage >
        snapshot.root.limits.maxTokens
      ) {
        snapshot.root.budgetExceeded = 'tokens';
        for (const record of Object.values(snapshot.sessions)) {
          for (const message of record.mailbox) {
            if (message.status === 'pending') {
              message.status = 'cancelled';
              message.completedAt = this.now();
            }
          }
          if (
            !record.activeMessageId &&
            record.status === 'queued' &&
            !record.mailbox.some((message) => message.status === 'pending')
          ) {
            record.status = 'cancelled';
          }
        }
      }
    }
  }

  private durableTokens(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>
  ): number {
    return (
      snapshot.root.descendantUsage.totalTokens +
      snapshot.root.outcomeUnknownTokens
    );
  }

  private committedTokens(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>
  ): number {
    return this.durableTokens(snapshot) + snapshot.root.reservedTokens;
  }

  private expectedBudgetExceeded(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>
  ): AxAgentSessionRootRecord['budgetExceeded'] {
    if (
      this.durableTokens(snapshot) + snapshot.root.limits.maxTokensPerMessage >
      snapshot.root.limits.maxTokens
    ) {
      return 'tokens';
    }
    if (snapshot.root.admittedSubcalls >= snapshot.root.limits.maxSubcalls) {
      return 'subcalls';
    }
    return undefined;
  }

  private reconcileBudget(snapshot: AxAgentSessionRegistrySnapshot): void {
    const exceeded = this.expectedBudgetExceeded(snapshot);
    if (exceeded) snapshot.root.budgetExceeded = exceeded;
    else delete snapshot.root.budgetExceeded;
  }

  private descendants(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    parentId: string,
    includeParent: boolean
  ): string[] {
    const ids = includeParent && snapshot.sessions[parentId] ? [parentId] : [];
    for (const record of Object.values(snapshot.sessions)) {
      if (record.handle.parentId === parentId) {
        ids.push(...this.descendants(snapshot, record.handle.id, true));
      }
    }
    return ids;
  }

  private async authorizedRecord(
    parentId: string,
    parentCapability: string,
    parentEpoch: number,
    handle: Readonly<AxAgentSessionHandle>
  ) {
    const snapshot = await this.requireRoot(handle.rootId);
    this.assertParent(snapshot, parentId, parentCapability, parentEpoch);
    return cloneStructured(this.assertHandle(snapshot, parentId, handle));
  }

  private assertHandle(
    snapshot: AxAgentSessionRegistrySnapshot,
    parentId: string,
    handle: Readonly<AxAgentSessionHandle>
  ): AxAgentSessionRecord {
    const record = snapshot.sessions[handle.id];
    if (!record) throw new AxAgentSessionNotFoundError(handle.id);
    if (
      handle.version !== 1 ||
      record.handle.id !== handle.id ||
      record.handle.parentId !== parentId ||
      handle.parentId !== parentId ||
      record.handle.rootId !== snapshot.root.id ||
      handle.rootId !== snapshot.root.id ||
      record.handle.registrationKey !== handle.registrationKey ||
      handle.epoch !== snapshot.root.epoch ||
      record.handle.epoch !== snapshot.root.epoch ||
      !timingSafeEqual(handle.capability, record.handle.capability)
    ) {
      throw new AxAgentSessionStaleHandleError(handle.id);
    }
    return record;
  }

  private assertParent(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    sessionId: string,
    capability: string,
    epoch: number
  ): { depth: number; authorizedChildren: readonly string[] } {
    if (sessionId === snapshot.root.id) {
      if (
        epoch !== snapshot.root.epoch ||
        !timingSafeEqual(capability, snapshot.root.capability)
      ) {
        throw new AxAgentSessionStaleHandleError(sessionId);
      }
      return {
        depth: 0,
        authorizedChildren: snapshot.root.authorizedChildren,
      };
    }
    const record = snapshot.sessions[sessionId];
    if (!record) throw new AxAgentSessionNotFoundError(sessionId);
    if (
      epoch !== snapshot.root.epoch ||
      record.handle.epoch !== snapshot.root.epoch ||
      !timingSafeEqual(capability, record.handle.capability)
    ) {
      throw new AxAgentSessionStaleHandleError(sessionId);
    }
    return {
      depth: record.depth,
      authorizedChildren: record.authorizedChildren,
    };
  }

  private async mutateBySession<T>(
    sessionId: string,
    capability: string,
    epoch: number,
    mutation: (
      snapshot: AxAgentSessionRegistrySnapshot,
      parent: { depth: number; authorizedChildren: readonly string[] }
    ) => T
  ): Promise<T> {
    const root = await this.rootForSession(sessionId);
    return this.mutate(root.root.id, (snapshot) =>
      mutation(
        snapshot,
        this.assertParent(snapshot, sessionId, capability, epoch)
      )
    );
  }

  private async rootForSession(
    sessionId: string
  ): Promise<AxAgentSessionRegistrySnapshot> {
    const direct = await this.store.load(sessionId);
    if (direct) {
      await this.validateSnapshot(direct);
      return cloneStructured(direct);
    }
    for (const rootId of await this.store.listRoots()) {
      const snapshot = await this.store.load(rootId);
      if (snapshot?.sessions[sessionId]) {
        await this.validateSnapshot(snapshot);
        return cloneStructured(snapshot);
      }
    }
    throw new AxAgentSessionNotFoundError(sessionId);
  }

  private async requireRoot(
    rootId: string
  ): Promise<AxAgentSessionRegistrySnapshot> {
    const snapshot = await this.store.load(rootId);
    if (!snapshot) throw new AxAgentSessionNotFoundError(rootId);
    await this.validateSnapshot(snapshot);
    return cloneStructured(snapshot);
  }

  private async validateSnapshot(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    expectedPolicyDigest?: string
  ): Promise<void> {
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !snapshot.root ||
      typeof snapshot.root !== 'object' ||
      !snapshot.sessions ||
      typeof snapshot.sessions !== 'object' ||
      Array.isArray(snapshot.sessions)
    ) {
      throw new AxAgentSessionSerializationError(
        'snapshot root and session registry are required'
      );
    }
    if (snapshot.version !== 1) {
      throw new AxAgentSessionSerializationError(
        `unsupported snapshot version "${String(snapshot.version)}"`
      );
    }
    if (!isNonNegativeSafeInteger(snapshot.revision)) {
      throw new AxAgentSessionSerializationError(
        'revision must be a non-negative safe integer'
      );
    }
    if (!/^[a-f0-9]{64}$/.test(snapshot.policyDigest)) {
      throw new AxAgentSessionSerializationError(
        'policyDigest must be a SHA-256 hex digest'
      );
    }
    if (
      expectedPolicyDigest !== undefined &&
      !timingSafeEqual(snapshot.policyDigest, expectedPolicyDigest)
    ) {
      throw new AxAgentSessionAuthorizationError(
        'Retained agent snapshot does not match the trusted policy digest'
      );
    }

    const root = snapshot.root;
    if (
      !root ||
      typeof root.id !== 'string' ||
      root.id.length === 0 ||
      typeof root.capability !== 'string' ||
      root.capability.length === 0 ||
      !Number.isSafeInteger(root.epoch) ||
      root.epoch < 1 ||
      !Array.isArray(root.authorizedChildren) ||
      !root.limits ||
      typeof root.limits !== 'object' ||
      Array.isArray(root.limits) ||
      !root.descendantUsage ||
      typeof root.descendantUsage !== 'object' ||
      !root.retiredDescendantUsage ||
      typeof root.retiredDescendantUsage !== 'object'
    ) {
      throw new AxAgentSessionSerializationError(
        'root identity, capability, and epoch are required'
      );
    }
    if (!['active', 'cancelled', 'interrupted'].includes(root.status)) {
      throw new AxAgentSessionSerializationError('invalid root status');
    }
    if (
      root.budgetExceeded !== undefined &&
      root.budgetExceeded !== 'tokens' &&
      root.budgetExceeded !== 'subcalls'
    ) {
      throw new AxAgentSessionSerializationError('invalid root budget status');
    }
    const rootKeys = canonicalKeys(root.authorizedChildren);
    if (!equalStrings(root.authorizedChildren, rootKeys)) {
      throw new AxAgentSessionAuthorizationError(
        'Root child authorization must be canonical and duplicate-free'
      );
    }
    for (const key of rootKeys) {
      if (!this.registrations.has(key)) {
        throw new AxAgentSessionAuthorizationError(
          `Root snapshot authorizes unavailable retained agent "${key}"`
        );
      }
    }
    const limitKeys = Object.keys(DEFAULT_LIMITS).sort();
    if (!equalStrings(Object.keys(root.limits).sort(), limitKeys)) {
      throw new AxAgentSessionSerializationError(
        'snapshot limits do not match the canonical limit schema'
      );
    }
    resolveLimits(root.limits);
    if (
      !isNonNegativeSafeInteger(root.admittedChildren) ||
      !isNonNegativeSafeInteger(root.admittedSubcalls) ||
      !isNonNegativeSafeInteger(root.reservedTokens) ||
      !isNonNegativeSafeInteger(root.outcomeUnknownTokens) ||
      !isNonNegativeSafeInteger(root.retiredOutcomeUnknownTokens) ||
      !isNonNegativeSafeInteger(root.retiredSubcalls)
    ) {
      throw new AxAgentSessionSerializationError(
        'root counters must be non-negative safe integers'
      );
    }
    assertUsage(root.descendantUsage, 'root.descendantUsage');
    assertUsage(root.retiredDescendantUsage, 'root.retiredDescendantUsage');

    const sessionIds = Object.keys(snapshot.sessions);
    if (
      root.admittedChildren !== sessionIds.length ||
      sessionIds.length > root.limits.maxChildren
    ) {
      throw new AxAgentSessionSerializationError(
        'admittedChildren must equal the bounded session topology'
      );
    }
    const messageIds = new Set<string>();
    const jobIds = new Set<string>();
    let retainedMessages = 0;
    let reservedTokens = 0;
    let retainedOutcomeUnknownTokens = 0;
    let runningMessageCount = 0;
    for (const id of sessionIds) {
      const record = snapshot.sessions[id]!;
      if (
        !record ||
        typeof record !== 'object' ||
        !record.handle ||
        typeof record.handle !== 'object' ||
        !Array.isArray(record.authorizedChildren) ||
        !Array.isArray(record.mailbox) ||
        !record.usage ||
        typeof record.usage !== 'object' ||
        !record.descendantUsage ||
        typeof record.descendantUsage !== 'object' ||
        !record.retiredDescendantUsage ||
        typeof record.retiredDescendantUsage !== 'object'
      ) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" is not a complete registry record`
        );
      }
      const handle = record.handle;
      const registration = this.registrations.get(handle.registrationKey);
      if (
        handle.version !== 1 ||
        handle.id !== id ||
        handle.rootId !== root.id ||
        handle.epoch !== root.epoch ||
        typeof handle.capability !== 'string' ||
        handle.capability.length === 0 ||
        !registration
      ) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" has a non-canonical handle`
        );
      }
      const parentDepth =
        handle.parentId === root.id
          ? 0
          : snapshot.sessions[handle.parentId]?.depth;
      const parentAuthorization =
        handle.parentId === root.id
          ? root.authorizedChildren
          : snapshot.sessions[handle.parentId]?.authorizedChildren;
      if (
        parentDepth === undefined ||
        record.depth !== parentDepth + 1 ||
        record.depth > root.limits.maxDepth
      ) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" has an invalid parent/depth chain`
        );
      }
      if (!parentAuthorization?.includes(handle.registrationKey)) {
        throw new AxAgentSessionAuthorizationError(
          `Session "${id}" registration "${handle.registrationKey}" is not authorized by parent "${handle.parentId}"`
        );
      }
      const expectedChildren = canonicalKeys(
        registration.authorizedChildren ?? []
      );
      if (!equalStrings(record.authorizedChildren, expectedChildren)) {
        throw new AxAgentSessionAuthorizationError(
          `Session "${id}" child authorization does not match registration "${registration.key}"`
        );
      }
      if (
        ![
          'queued',
          'running',
          'cancelling',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
        ].includes(record.status)
      ) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" has an invalid status`
        );
      }
      if (
        record.mailbox.length > root.limits.maxRetainedMessages ||
        record.mailbox.filter((message) => message.status === 'pending')
          .length > root.limits.maxPendingMessages
      ) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" mailbox exceeds policy limits`
        );
      }
      assertUsage(record.usage, `sessions.${id}.usage`);
      assertUsage(record.descendantUsage, `sessions.${id}.descendantUsage`);
      assertUsage(
        record.retiredDescendantUsage,
        `sessions.${id}.retiredDescendantUsage`
      );
      const runningMessages = record.mailbox.filter(
        (message) => message.status === 'running'
      );
      runningMessageCount += runningMessages.length;
      if (
        runningMessages.length > 1 ||
        (record.activeMessageId ?? undefined) !==
          (runningMessages[0]?.id ?? undefined) ||
        runningMessages.length > 0 !==
          (record.status === 'running' || record.status === 'cancelling')
      ) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" active-message state is inconsistent`
        );
      }
      retainedMessages += record.mailbox.length;
      const directUsage = emptyUsage();
      for (const message of record.mailbox) {
        if (
          !message ||
          typeof message !== 'object' ||
          typeof message.id !== 'string' ||
          message.id.length === 0 ||
          messageIds.has(message.id) ||
          typeof message.jobId !== 'string' ||
          message.jobId.length === 0 ||
          jobIds.has(message.jobId) ||
          !['steer', 'follow-up'].includes(message.mode) ||
          ![
            'pending',
            'running',
            'completed',
            'failed',
            'cancelled',
            'outcome_unknown',
          ].includes(message.status)
        ) {
          throw new AxAgentSessionSerializationError(
            `session "${id}" contains a non-canonical mailbox entry`
          );
        }
        messageIds.add(message.id);
        jobIds.add(message.jobId);
        const confirmedUsage =
          message.status === 'completed' ||
          message.status === 'failed' ||
          (message.status === 'cancelled' && message.startedAt !== undefined);
        if (message.usage !== undefined) {
          assertUsage(
            message.usage,
            `sessions.${id}.mailbox.${message.id}.usage`
          );
          if (!confirmedUsage) {
            throw new AxAgentSessionSerializationError(
              `message "${message.id}" has usage without a confirmed attempt`
            );
          }
          addUsage(directUsage, message.usage);
        } else if (confirmedUsage) {
          throw new AxAgentSessionSerializationError(
            `message "${message.id}" lacks confirmed attempt usage`
          );
        }
        if (message.tokenReservation !== undefined) {
          if (message.tokenReservation !== root.limits.maxTokensPerMessage) {
            throw new AxAgentSessionSerializationError(
              `message "${message.id}" has an invalid token reservation`
            );
          }
          if (message.status === 'running') {
            reservedTokens += message.tokenReservation;
          } else if (message.status === 'outcome_unknown') {
            retainedOutcomeUnknownTokens += message.tokenReservation;
          } else {
            throw new AxAgentSessionSerializationError(
              `message "${message.id}" has a reservation outside a running or outcome_unknown attempt`
            );
          }
        } else if (
          message.status === 'running' ||
          message.status === 'outcome_unknown'
        ) {
          throw new AxAgentSessionSerializationError(
            `message "${message.id}" lacks its token reservation`
          );
        }
      }
      if (!equalUsage(record.usage, directUsage)) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" direct usage does not match its mailbox attempts`
        );
      }
    }
    if (
      root.admittedSubcalls !== retainedMessages + root.retiredSubcalls ||
      root.admittedSubcalls > root.limits.maxSubcalls ||
      root.reservedTokens !== reservedTokens ||
      root.outcomeUnknownTokens !==
        retainedOutcomeUnknownTokens + root.retiredOutcomeUnknownTokens ||
      runningMessageCount > root.limits.maxConcurrency
    ) {
      throw new AxAgentSessionSerializationError(
        'root admission, concurrency, or uncertain-token accounting is inconsistent'
      );
    }
    for (const id of sessionIds) {
      const record = snapshot.sessions[id]!;
      const expectedDescendantUsage = cloneStructured(
        record.retiredDescendantUsage
      );
      for (const child of Object.values(snapshot.sessions)) {
        if (child.handle.parentId !== id) continue;
        addUsage(expectedDescendantUsage, child.usage);
        addUsage(expectedDescendantUsage, child.descendantUsage);
      }
      if (!equalUsage(record.descendantUsage, expectedDescendantUsage)) {
        throw new AxAgentSessionSerializationError(
          `session "${id}" descendant usage does not reconcile with its topology`
        );
      }
    }
    const expectedRootUsage = cloneStructured(root.retiredDescendantUsage);
    for (const record of Object.values(snapshot.sessions)) {
      if (record.handle.parentId !== root.id) continue;
      addUsage(expectedRootUsage, record.usage);
      addUsage(expectedRootUsage, record.descendantUsage);
    }
    if (!equalUsage(root.descendantUsage, expectedRootUsage)) {
      throw new AxAgentSessionSerializationError(
        'root descendant usage does not reconcile with its topology'
      );
    }
    if (root.budgetExceeded !== this.expectedBudgetExceeded(snapshot)) {
      throw new AxAgentSessionSerializationError(
        'root budget status does not reconcile with accounting'
      );
    }
    const computedDigest = await digestPolicy(snapshot);
    if (!timingSafeEqual(snapshot.policyDigest, computedDigest)) {
      throw new AxAgentSessionAuthorizationError(
        'Retained agent snapshot policy digest is invalid'
      );
    }
  }

  private async mutate<T>(
    rootId: string,
    mutation: RegistryMutation<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await this.requireRoot(rootId);
      const next = cloneStructured(current);
      const result = mutation(next);
      this.reconcileBudget(next);
      next.root.updatedAt = this.now();
      next.policyDigest = await digestPolicy(next);
      await this.validateSnapshot(next);
      try {
        await this.store.save(next, current.revision);
        return result;
      } catch (error) {
        if (!(error instanceof AxAgentSessionConflictError)) throw error;
      }
    }
    throw new AxAgentSessionConflictError(
      `Retained agent session registry "${rootId}" remained contended`
    );
  }

  private async mutateOptional<T>(
    rootId: string,
    mutation: (
      snapshot: AxAgentSessionRegistrySnapshot
    ) => T | typeof SKIP_MUTATION
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await this.requireRoot(rootId);
      const next = cloneStructured(current);
      const result = mutation(next);
      if (result === SKIP_MUTATION) return undefined;
      this.reconcileBudget(next);
      next.root.updatedAt = this.now();
      next.policyDigest = await digestPolicy(next);
      await this.validateSnapshot(next);
      try {
        await this.store.save(next, current.revision);
        return result;
      } catch (error) {
        if (!(error instanceof AxAgentSessionConflictError)) throw error;
      }
    }
    throw new AxAgentSessionConflictError(
      `Retained agent session registry "${rootId}" remained contended`
    );
  }

  private async mutateAtEpoch<T>(
    rootId: string,
    expectedEpoch: number,
    mutation: (
      snapshot: AxAgentSessionRegistrySnapshot
    ) => T | typeof SKIP_MUTATION
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await this.requireRoot(rootId);
      if (current.root.epoch !== expectedEpoch) return undefined;
      const next = cloneStructured(current);
      const result = mutation(next);
      if (result === SKIP_MUTATION) return undefined;
      this.reconcileBudget(next);
      next.root.updatedAt = this.now();
      next.policyDigest = await digestPolicy(next);
      await this.validateSnapshot(next);
      try {
        await this.store.save(next, current.revision);
        return result;
      } catch (error) {
        if (!(error instanceof AxAgentSessionConflictError)) throw error;
      }
    }
    throw new AxAgentSessionConflictError(
      `Retained agent session registry "${rootId}" remained contended at epoch ${expectedEpoch}`
    );
  }

  private view(
    record: Readonly<AxAgentSessionRecord>
  ): AxAgentSessionStatusView {
    const latestResult = latestCompletedMessage(record)?.result;
    return {
      handle: handleFor(record),
      depth: record.depth,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.activeMessageId
        ? { activeMessageId: record.activeMessageId }
        : {}),
      mailbox: cloneStructured(record.mailbox),
      ...(latestResult !== undefined
        ? { latestResult: cloneStructured(latestResult) }
        : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
      usage: cloneStructured(record.usage),
      descendantUsage: cloneStructured(record.descendantUsage),
      durability: this.durability(),
    };
  }

  private durability() {
    return {
      store: this.store.capabilities.durability,
      scheduler: this.scheduler.capabilities.durability,
    } as const;
  }

  private async emit(
    type: AxAgentSessionEvent['type'],
    record: Readonly<AxAgentSessionRecord>,
    messageId?: string
  ): Promise<void> {
    if (!this.onEvent) return;
    const rootId = record.handle.rootId;
    this.publishingEvents.set(
      rootId,
      (this.publishingEvents.get(rootId) ?? 0) + 1
    );
    try {
      await this.onEvent({
        type,
        rootId,
        sessionId: record.handle.id,
        parentId: record.handle.parentId,
        ...(messageId ? { messageId } : {}),
        status: record.status,
        time: this.now(),
        correlation: AxAgentSessionHost.continuationKey(record.handle),
      });
    } catch {
      // Observability/event publication must not corrupt lifecycle state.
    } finally {
      const remaining = (this.publishingEvents.get(rootId) ?? 1) - 1;
      if (remaining > 0) this.publishingEvents.set(rootId, remaining);
      else this.publishingEvents.delete(rootId);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Retained agent session host is closed');
  }
}

export class AxAgentSessionClient {
  constructor(
    private readonly host: AxAgentSessionHost,
    readonly sessionId: string,
    private readonly capability: string,
    readonly epoch: number
  ) {}

  spawn(registrationKey: string, input: unknown) {
    return this.host.spawn(
      this.sessionId,
      this.capability,
      this.epoch,
      registrationKey,
      input
    );
  }

  inspect(handle: Readonly<AxAgentSessionHandle>) {
    return this.host.inspect(
      this.sessionId,
      this.capability,
      this.epoch,
      handle
    );
  }

  result(handle: Readonly<AxAgentSessionHandle>) {
    return this.host.result(
      this.sessionId,
      this.capability,
      this.epoch,
      handle
    );
  }

  send(
    handle: Readonly<AxAgentSessionHandle>,
    input: unknown,
    mode: AxAgentSessionMessageMode
  ) {
    return this.host.send(
      this.sessionId,
      this.capability,
      this.epoch,
      handle,
      input,
      mode
    );
  }

  cancel(handle?: Readonly<AxAgentSessionHandle>) {
    return this.host.cancel(
      this.sessionId,
      this.capability,
      this.epoch,
      handle
    );
  }

  dispose(handle: Readonly<AxAgentSessionHandle>) {
    return this.host.dispose(
      this.sessionId,
      this.capability,
      this.epoch,
      handle
    );
  }

  list() {
    return this.host.list(this.sessionId, this.capability, this.epoch);
  }

  inspectRoot() {
    return this.host.inspectRoot(this.sessionId, this.capability, this.epoch);
  }

  functions(options?: Readonly<AxAgentSessionFunctionOptions>) {
    return this.host.functions(
      this.sessionId,
      this.capability,
      this.epoch,
      options
    );
  }
}
