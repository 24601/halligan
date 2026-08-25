import type { AxAIService, AxFunction } from '../ai/types.js';
import type { AxAgentUsage, AxProgramUsage } from '../dsp/types.js';
import { randomUUID } from '../util/crypto.js';
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
  /** Exact admission budget across initial tasks and later messages. */
  maxSubcalls: number;
}

export interface AxAgentSessionRootRecord {
  id: string;
  capability: string;
  authorizedChildren: string[];
  status: 'active' | 'cancelled' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  limits: AxAgentSessionLimits;
  admittedChildren: number;
  admittedSubcalls: number;
  descendantUsage: AxAgentSessionUsage;
  budgetExceeded?: 'tokens' | 'subcalls';
}

export interface AxAgentSessionRegistrySnapshot {
  version: 1;
  revision: number;
  root: AxAgentSessionRootRecord;
  sessions: Record<string, AxAgentSessionRecord>;
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
  for (const [name, value] of Object.entries(limits)) {
    validatePositiveLimit(name as keyof AxAgentSessionLimits, value);
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
    out.promptTokens += entry.tokens?.promptTokens ?? 0;
    out.completionTokens += entry.tokens?.completionTokens ?? 0;
    out.totalTokens += entry.tokens?.totalTokens ?? 0;
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
          .catch(() => {
            // Recovery reconciles unfinished registry claims; keep pumping.
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

type LiveAgent = {
  agent: AxRetainedAgent;
  registration: AxAgentSessionRegistration;
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
  private readonly controllers = new Map<string, AbortController>();
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
    const detach = this.scheduler.attach((job) => this.dispatch(job));
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
      authorizedChildren: [...new Set(options.authorizedChildren)],
      status: 'active',
      createdAt: now,
      updatedAt: now,
      limits: resolveLimits(this.limits, options.limits),
      admittedChildren: 0,
      admittedSubcalls: 0,
      descendantUsage: emptyUsage(),
    };
    const saved = await this.store.save(
      { version: 1, revision: 0, root, sessions: {} },
      undefined
    );
    const client = this.clientFor(saved.root.id, saved.root.capability);
    if (options.abortSignal) {
      const cancel = () => {
        void client.cancel().catch(() => {
          // A host that was already closed owns no further cancellation work.
        });
      };
      if (options.abortSignal.aborted) await client.cancel();
      else
        options.abortSignal.addEventListener('abort', cancel, { once: true });
    }
    return client;
  }

  async restoreRoot(rootId: string): Promise<AxAgentSessionClient> {
    const snapshot = await this.requireRoot(rootId);
    return this.clientFor(snapshot.root.id, snapshot.root.capability);
  }

  async snapshot(rootId: string): Promise<AxAgentSessionRegistrySnapshot> {
    return cloneStructured(await this.requireRoot(rootId));
  }

  async restore(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>
  ): Promise<AxAgentSessionClient> {
    this.assertOpen();
    if (snapshot.version !== 1) {
      throw new Error(
        `Unsupported retained agent session snapshot version "${String(snapshot.version)}"`
      );
    }
    const restored: AxAgentSessionRegistrySnapshot = cloneStructured(snapshot);
    restored.revision = 0;
    this.interruptRunning(restored);
    const saved = await this.store.save(restored, undefined);
    await this.scheduleReady(saved.root.id);
    return this.clientFor(saved.root.id, saved.root.capability);
  }

  /**
   * Reconcile durable state after a worker/process crash. Running messages are
   * fenced as outcome_unknown and are never replayed; pending messages resume.
   */
  async recover(rootId?: string): Promise<void> {
    this.assertOpen();
    const roots = rootId ? [rootId] : await this.store.listRoots();
    for (const id of roots) {
      const interrupted = await this.mutate(id, (snapshot) => {
        const records: AxAgentSessionRecord[] = [];
        this.interruptRunning(snapshot, records);
        return records;
      });
      for (const record of interrupted) {
        await this.emit('interrupted', record);
      }
      await this.scheduleReady(id);
    }
  }

  async close(options: Readonly<{ abort?: boolean }> = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachScheduler?.();
    if (options.abort) {
      for (const controller of this.controllers.values()) {
        controller.abort('Retained agent session host closed');
      }
      for (const sessionId of this.liveAgents.keys()) {
        this.stopLiveAgent(sessionId);
      }
    }
    await this.scheduler.close?.();
  }

  private clientFor(sessionId: string, capability: string) {
    return new AxAgentSessionClient(this, sessionId, capability);
  }

  async spawn(
    parentId: string,
    parentCapability: string,
    registrationKey: string,
    input: unknown
  ): Promise<AxAgentSessionHandle> {
    this.assertOpen();
    const clonedInput = cloneStructured(input);
    const id = `child-${randomUUID()}`;
    const capability = randomUUID();
    const now = this.now();
    const handle = await this.mutateBySession(
      parentId,
      parentCapability,
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
          capability,
        };
        const message = this.createMessage('follow-up', clonedInput, now);
        snapshot.sessions[id] = {
          handle: childHandle,
          depth,
          authorizedChildren: [...(registration.authorizedChildren ?? [])],
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          mailbox: [message],
          usage: emptyUsage(),
          descendantUsage: emptyUsage(),
        };
        snapshot.root.admittedChildren++;
        return childHandle;
      }
    );
    const record = (await this.requireRoot(handle.rootId)).sessions[handle.id]!;
    await this.enqueueSafely(record, record.mailbox[0]!);
    await this.emit('queued', record, record.mailbox[0]?.id);
    return cloneStructured(handle);
  }

  async inspect(
    parentId: string,
    parentCapability: string,
    handle: Readonly<AxAgentSessionHandle>
  ): Promise<AxAgentSessionStatusView> {
    const record = await this.authorizedRecord(
      parentId,
      parentCapability,
      handle
    );
    return this.view(record);
  }

  async result(
    parentId: string,
    parentCapability: string,
    handle: Readonly<AxAgentSessionHandle>
  ): Promise<unknown> {
    const record = await this.authorizedRecord(
      parentId,
      parentCapability,
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
    handle: Readonly<AxAgentSessionHandle>,
    input: unknown,
    mode: AxAgentSessionMessageMode
  ): Promise<AxAgentSessionSendReceipt> {
    this.assertOpen();
    if (mode !== 'steer' && mode !== 'follow-up') {
      throw new Error('Retained agent message mode must be steer or follow-up');
    }
    const clonedInput = cloneStructured(input);
    const now = this.now();
    const result = await this.mutate(handle.rootId, (snapshot) => {
      this.assertParent(snapshot, parentId, parentCapability);
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
    if (result.activeJobId) {
      interruptAccepted = await this.cancelScheduledJob(
        result.activeJobId,
        'Retained child steered by parent'
      );
    }
    if (!result.hasActiveMessage) await this.scheduleReady(handle.rootId);
    await this.emit('queued', result.record, result.receipt.messageId);
    return {
      ...result.receipt,
      ...(result.activeJobId ? { interruptAccepted } : {}),
    };
  }

  async cancel(
    sessionId: string,
    capability: string,
    handle?: Readonly<AxAgentSessionHandle>
  ): Promise<void> {
    this.assertOpen();
    const root = await this.rootForSession(sessionId);
    const outcome = await this.mutate(root.root.id, (snapshot) => {
      const jobs: string[] = [];
      const affected: AxAgentSessionRecord[] = [];
      this.assertParent(snapshot, sessionId, capability);
      const targetId = handle
        ? this.assertHandle(snapshot, sessionId, handle).handle.id
        : sessionId;
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
    });
    for (const job of outcome.jobs) {
      await this.cancelScheduledJob(job, 'Retained agent session cancelled');
    }
    for (const record of outcome.affected) await this.emit('cancelled', record);
  }

  async dispose(
    parentId: string,
    parentCapability: string,
    handle: Readonly<AxAgentSessionHandle>
  ): Promise<void> {
    this.assertOpen();
    const outcome = await this.mutate(handle.rootId, (snapshot) => {
      const jobs: string[] = [];
      const records: AxAgentSessionRecord[] = [];
      this.assertParent(snapshot, parentId, parentCapability);
      const target = this.assertHandle(snapshot, parentId, handle);
      const ids = this.descendants(snapshot, target.handle.id, true);
      for (const id of ids) {
        const record = snapshot.sessions[id];
        if (!record) continue;
        records.push(cloneStructured(record));
        jobs.push(...record.mailbox.map((message) => message.jobId));
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
    parentCapability: string
  ): Promise<AxAgentSessionStatusView[]> {
    const snapshot = await this.rootForSession(parentId);
    this.assertParent(snapshot, parentId, parentCapability);
    return Object.values(snapshot.sessions)
      .filter((record) => record.handle.parentId === parentId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.view(record));
  }

  async inspectRoot(
    sessionId: string,
    capability: string
  ): Promise<AxAgentSessionRootView> {
    const snapshot = await this.rootForSession(sessionId);
    this.assertParent(snapshot, sessionId, capability);
    return {
      rootId: snapshot.root.id,
      status: snapshot.root.status,
      limits: cloneStructured(snapshot.root.limits),
      admittedChildren: snapshot.root.admittedChildren,
      admittedSubcalls: snapshot.root.admittedSubcalls,
      descendantUsage: cloneStructured(snapshot.root.descendantUsage),
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
    options: Readonly<AxAgentSessionFunctionOptions> = {}
  ): AxFunction[] {
    const client = this.clientFor(sessionId, capability);
    const namespace = options.namespace ?? 'sessions';
    const objectSchema = { type: 'object' } as const;
    const handleSchema = {
      type: 'object',
      description: 'Serializable retained child session handle',
    } as const;
    const registerContinuation = (
      extra: Parameters<AxFunction['func']>[1],
      handle: Readonly<AxAgentSessionHandle>
    ) => {
      if (!options.eventContinuations || !extra?.eventContext) return;
      extra.eventContext.registerContinuation({
        correlation: [AxAgentSessionHost.continuationKey(handle)],
      });
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
          const handle = await client.spawn(args.agent, args.input);
          registerContinuation(extra, handle);
          return handle;
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
          const receipt = await client.send(args.handle, args.input, args.mode);
          registerContinuation(extra, args.handle);
          return receipt;
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
    const attemptId = randomUUID();
    const claimed = await this.mutate(job.rootId, (snapshot) => {
      const record = snapshot.sessions[job.sessionId];
      const message = record?.mailbox.find((item) => item.id === job.messageId);
      if (!record || !message || message.status !== 'pending') return undefined;
      if (record.activeMessageId) return undefined;
      if (this.nextPending(record)?.id !== message.id) return undefined;
      const running = Object.values(snapshot.sessions).filter(
        (item) => item.activeMessageId
      ).length;
      if (running >= snapshot.root.limits.maxConcurrency) return undefined;
      message.status = 'running';
      message.startedAt = this.now();
      message.attemptId = attemptId;
      record.activeMessageId = message.id;
      record.status = 'running';
      record.updatedAt = this.now();
      delete record.lastError;
      return {
        record: cloneStructured(record),
        message: cloneStructured(message),
      };
    });
    if (!claimed) return;
    await this.emit('running', claimed.record, claimed.message.id);

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    let live: LiveAgent | undefined;
    let result: unknown;
    let failure: unknown;
    let usage = emptyUsage();
    let nextState: AxAgentState | undefined;
    let nextArtifacts: unknown;
    try {
      live = await this.liveAgent(claimed.record);
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
      this.controllers.delete(job.id);
    }

    const completion = await this.mutate(job.rootId, (snapshot) => {
      const cancelJobs: string[] = [];
      const record = snapshot.sessions[job.sessionId];
      const message = record?.mailbox.find((item) => item.id === job.messageId);
      if (
        !record ||
        !message ||
        message.status !== 'running' ||
        message.attemptId !== attemptId
      ) {
        return { terminal: undefined, cancelJobs, rollback: false };
      }
      const cancelled = message.cancelRequested || controller.signal.aborted;
      message.completedAt = this.now();
      delete message.attemptId;
      delete record.activeMessageId;
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
        record.status = record.mailbox.some((item) => item.status === 'pending')
          ? 'queued'
          : 'cancelled';
        terminalType = 'cancelled';
      } else if (failure) {
        message.status = 'failed';
        message.error = errorMessage(failure);
        record.status = 'failed';
        record.lastError = message.error;
        if (nextState !== undefined) record.state = cloneStructured(nextState);
        if (nextArtifacts !== undefined)
          record.artifacts = cloneStructured(nextArtifacts);
        terminalType = 'failed';
      } else {
        message.status = 'completed';
        message.result = cloneStructured(result);
        record.status = 'completed';
        delete record.lastError;
        if (nextState !== undefined) record.state = cloneStructured(nextState);
        if (nextArtifacts !== undefined)
          record.artifacts = cloneStructured(nextArtifacts);
        terminalType = 'completed';
      }
      record.updatedAt = this.now();
      if (
        snapshot.root.descendantUsage.totalTokens >=
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
    });

    if (completion.rollback) {
      const current = this.liveAgents.get(job.sessionId);
      if (current && current === live) {
        this.stopLiveAgent(job.sessionId);
      }
    }
    if (completion.terminal) {
      await this.emit(
        completion.terminal.type,
        completion.terminal.record,
        job.messageId
      );
    }
    for (const cancelJob of completion.cancelJobs) {
      await this.cancelScheduledJob(
        cancelJob,
        'Retained agent root token budget exhausted'
      );
    }
    if (!this.closed) await this.scheduleReady(job.rootId);
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
    const client = this.clientFor(record.handle.id, record.handle.capability);
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

  private async scheduleReady(rootId: string): Promise<void> {
    if (this.closed) return;
    const snapshot = await this.requireRoot(rootId);
    if (snapshot.root.budgetExceeded === 'tokens') return;
    const running = Object.values(snapshot.sessions).filter(
      (record) => record.activeMessageId
    ).length;
    let capacity = Math.max(0, snapshot.root.limits.maxConcurrency - running);
    const records = Object.values(snapshot.sessions).sort(
      (left, right) => left.createdAt - right.createdAt
    );
    for (const record of records) {
      if (capacity <= 0) break;
      if (record.activeMessageId) continue;
      const message = this.nextPending(record);
      if (!message) continue;
      if (await this.enqueueSafely(record, message)) capacity--;
    }
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
      await this.mutate(record.handle.rootId, (snapshot) => {
        const current = snapshot.sessions[record.handle.id];
        const queued = current?.mailbox.find((item) => item.id === message.id);
        if (current && queued?.status === 'pending') {
          current.lastError = `Scheduler enqueue failed: ${errorMessage(error)}`;
          current.updatedAt = this.now();
        }
      });
      return false;
    }
  }

  private async cancelScheduledJob(
    jobId: string,
    reason: string
  ): Promise<boolean> {
    let accepted = false;
    const controller = this.controllers.get(jobId);
    if (controller) {
      controller.abort(reason);
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
    if (snapshot.root.budgetExceeded === 'tokens') {
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

  private interruptRunning(
    snapshot: AxAgentSessionRegistrySnapshot,
    interrupted: AxAgentSessionRecord[] = []
  ): void {
    let found = false;
    for (const record of Object.values(snapshot.sessions)) {
      let recordInterrupted = false;
      for (const message of record.mailbox) {
        if (message.status !== 'running') continue;
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
    if (found) snapshot.root.status = 'interrupted';
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
    handle: Readonly<AxAgentSessionHandle>
  ) {
    const snapshot = await this.requireRoot(handle.rootId);
    this.assertParent(snapshot, parentId, parentCapability);
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
      record.handle.parentId !== parentId ||
      handle.parentId !== parentId ||
      handle.rootId !== snapshot.root.id ||
      !timingSafeEqual(handle.capability, record.handle.capability)
    ) {
      throw new AxAgentSessionStaleHandleError(handle.id);
    }
    return record;
  }

  private assertParent(
    snapshot: Readonly<AxAgentSessionRegistrySnapshot>,
    sessionId: string,
    capability: string
  ): { depth: number; authorizedChildren: readonly string[] } {
    if (sessionId === snapshot.root.id) {
      if (!timingSafeEqual(capability, snapshot.root.capability)) {
        throw new AxAgentSessionStaleHandleError(sessionId);
      }
      return {
        depth: 0,
        authorizedChildren: snapshot.root.authorizedChildren,
      };
    }
    const record = snapshot.sessions[sessionId];
    if (!record) throw new AxAgentSessionNotFoundError(sessionId);
    if (!timingSafeEqual(capability, record.handle.capability)) {
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
    mutation: (
      snapshot: AxAgentSessionRegistrySnapshot,
      parent: { depth: number; authorizedChildren: readonly string[] }
    ) => T
  ): Promise<T> {
    const root = await this.rootForSession(sessionId);
    return this.mutate(root.root.id, (snapshot) =>
      mutation(snapshot, this.assertParent(snapshot, sessionId, capability))
    );
  }

  private async rootForSession(
    sessionId: string
  ): Promise<AxAgentSessionRegistrySnapshot> {
    const direct = await this.store.load(sessionId);
    if (direct) return cloneStructured(direct);
    for (const rootId of await this.store.listRoots()) {
      const snapshot = await this.store.load(rootId);
      if (snapshot?.sessions[sessionId]) return cloneStructured(snapshot);
    }
    throw new AxAgentSessionNotFoundError(sessionId);
  }

  private async requireRoot(
    rootId: string
  ): Promise<AxAgentSessionRegistrySnapshot> {
    const snapshot = await this.store.load(rootId);
    if (!snapshot) throw new AxAgentSessionNotFoundError(rootId);
    return cloneStructured(snapshot);
  }

  private async mutate<T>(
    rootId: string,
    mutation: RegistryMutation<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await this.requireRoot(rootId);
      const next = cloneStructured(current);
      const result = mutation(next);
      next.root.updatedAt = this.now();
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
    try {
      await this.onEvent({
        type,
        rootId: record.handle.rootId,
        sessionId: record.handle.id,
        parentId: record.handle.parentId,
        ...(messageId ? { messageId } : {}),
        status: record.status,
        time: this.now(),
        correlation: AxAgentSessionHost.continuationKey(record.handle),
      });
    } catch {
      // Observability/event publication must not corrupt lifecycle state.
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
    private readonly capability: string
  ) {}

  spawn(registrationKey: string, input: unknown) {
    return this.host.spawn(
      this.sessionId,
      this.capability,
      registrationKey,
      input
    );
  }

  inspect(handle: Readonly<AxAgentSessionHandle>) {
    return this.host.inspect(this.sessionId, this.capability, handle);
  }

  result(handle: Readonly<AxAgentSessionHandle>) {
    return this.host.result(this.sessionId, this.capability, handle);
  }

  send(
    handle: Readonly<AxAgentSessionHandle>,
    input: unknown,
    mode: AxAgentSessionMessageMode
  ) {
    return this.host.send(this.sessionId, this.capability, handle, input, mode);
  }

  cancel(handle?: Readonly<AxAgentSessionHandle>) {
    return this.host.cancel(this.sessionId, this.capability, handle);
  }

  dispose(handle: Readonly<AxAgentSessionHandle>) {
    return this.host.dispose(this.sessionId, this.capability, handle);
  }

  list() {
    return this.host.list(this.sessionId, this.capability);
  }

  inspectRoot() {
    return this.host.inspectRoot(this.sessionId, this.capability);
  }

  functions(options?: Readonly<AxAgentSessionFunctionOptions>) {
    return this.host.functions(this.sessionId, this.capability, options);
  }
}
