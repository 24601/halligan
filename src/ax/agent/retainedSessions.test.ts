import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxAIService } from '../ai/types.js';
import type { AxAgentUsage } from '../dsp/types.js';
import { agent } from './AxAgent.js';
import type { AxAgentState } from './agentInternal/agentStateTypes.js';
import {
  AxAgentSessionAuthorizationError,
  type AxAgentSessionClient,
  type AxAgentSessionFactoryContext,
  AxAgentSessionHost,
  type AxAgentSessionJob,
  AxAgentSessionNotFoundError,
  type AxAgentSessionRegistration,
  type AxAgentSessionScheduler,
  AxAgentSessionStaleHandleError,
  type AxAgentSessionStore,
  type AxAgentSessionUsage,
  AxInMemoryAgentSessionScheduler,
  AxInMemoryAgentSessionStore,
  type AxRetainedAgent,
} from './retainedSessions.js';
import type { AxCodeRuntime } from './rlm.js';

type WorkInput = {
  value: string;
  delayMs?: number;
  tokens?: number;
  spawnNested?: boolean;
};

type WorkOutput = {
  value: string;
  count: number;
  history: string[];
  childId?: string;
};

const unusedAI = {} as AxAIService;

function state(history: readonly string[]): AxAgentState {
  return {
    version: 1,
    runtimeBindings: { history: [...history] },
    runtimeEntries: [],
    actionLogEntries: [],
    provenance: {},
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

class DeterministicAgent implements AxRetainedAgent<WorkInput, WorkOutput> {
  static active = 0;
  static maxActive = 0;
  private history: string[] = [];
  private usage: AxAgentUsage = { actor: [], responder: [] };

  constructor(private readonly context?: AxAgentSessionFactoryContext) {}

  async forward(
    _ai: Readonly<AxAIService>,
    input: WorkInput,
    options?: Readonly<{ abortSignal?: AbortSignal }>
  ): Promise<WorkOutput> {
    DeterministicAgent.active++;
    DeterministicAgent.maxActive = Math.max(
      DeterministicAgent.maxActive,
      DeterministicAgent.active
    );
    try {
      await delay(input.delayMs ?? 0, options?.abortSignal);
      this.history.push(input.value);
      this.usage = {
        actor: [
          {
            ai: 'deterministic',
            model: 'delayed-agent',
            tokens: {
              promptTokens: input.tokens ?? 2,
              completionTokens: input.tokens ?? 2,
              totalTokens: (input.tokens ?? 2) * 2,
            },
          },
        ],
        responder: [],
      };
      let childId: string | undefined;
      if (input.spawnNested) {
        childId = (
          await this.context?.session.spawn('leaf', {
            value: `${input.value}-leaf`,
            tokens: 3,
          })
        )?.id;
      }
      return {
        value: input.value,
        count: this.history.length,
        history: [...this.history],
        ...(childId ? { childId } : {}),
      };
    } finally {
      DeterministicAgent.active--;
    }
  }

  getState(): AxAgentState {
    return state(this.history);
  }

  setState(value?: AxAgentState): void {
    const history = value?.runtimeBindings.history;
    this.history = Array.isArray(history)
      ? history.filter((item): item is string => typeof item === 'string')
      : [];
  }

  getUsage(): AxAgentUsage {
    return structuredClone(this.usage);
  }

  resetUsage(): void {
    this.usage = { actor: [], responder: [] };
  }

  stop(): void {}
}

class EagerMutationAgent implements AxRetainedAgent<WorkInput, WorkOutput> {
  private history: string[] = [];

  async forward(
    _ai: Readonly<AxAIService>,
    input: WorkInput,
    options?: Readonly<{ abortSignal?: AbortSignal }>
  ): Promise<WorkOutput> {
    this.history.push(input.value);
    await delay(input.delayMs ?? 0, options?.abortSignal);
    return {
      value: input.value,
      count: this.history.length,
      history: [...this.history],
    };
  }

  getState(): AxAgentState {
    return state(this.history);
  }

  setState(value?: AxAgentState): void {
    const history = value?.runtimeBindings.history;
    this.history = Array.isArray(history)
      ? history.filter((item): item is string => typeof item === 'string')
      : [];
  }

  getUsage(): AxAgentUsage {
    return { actor: [], responder: [] };
  }

  resetUsage(): void {}

  stop(): void {}
}

class ArtifactAgent implements AxRetainedAgent<WorkInput, WorkOutput> {
  private artifact = 'empty';

  async forward(
    _ai: Readonly<AxAIService>,
    input: WorkInput
  ): Promise<WorkOutput> {
    const previous = this.artifact;
    this.artifact = input.value;
    return {
      value: input.value,
      count: 1,
      history: [previous, this.artifact],
    };
  }

  getArtifact(): string {
    return this.artifact;
  }

  setArtifact(value: unknown): void {
    this.artifact = String(value);
  }

  getState(): undefined {
    return undefined;
  }

  setState(): void {}

  getUsage(): AxAgentUsage {
    return { actor: [], responder: [] };
  }

  resetUsage(): void {}

  stop(): void {}
}

class DestructiveStopAgent implements AxRetainedAgent<WorkInput, WorkOutput> {
  private output: WorkOutput = { value: '', count: 0, history: [] };
  private retainedState = state([]);
  private artifact = { history: [] as string[] };

  async forward(
    _ai: Readonly<AxAIService>,
    input: WorkInput
  ): Promise<WorkOutput> {
    this.output = { value: input.value, count: 1, history: [input.value] };
    this.retainedState = state([input.value]);
    this.artifact = { history: [input.value] };
    return this.output;
  }

  getArtifact(): unknown {
    return this.artifact;
  }

  getState(): AxAgentState {
    return this.retainedState;
  }

  setState(value?: AxAgentState): void {
    this.retainedState = value ?? state([]);
  }

  getUsage(): AxAgentUsage {
    return { actor: [], responder: [] };
  }

  resetUsage(): void {}

  stop(): void {
    this.output.history.length = 0;
    this.output.count = 0;
    this.retainedState.runtimeBindings.history = [];
    this.artifact.history.length = 0;
  }
}

function registrations(
  contexts?: Map<string, AxAgentSessionClient>
): AxAgentSessionRegistration[] {
  return [
    {
      key: 'worker',
      create: (context) => {
        contexts?.set(context.sessionId, context.session);
        return new DeterministicAgent(context);
      },
    },
    {
      key: 'parent',
      authorizedChildren: ['leaf'],
      create: (context) => {
        contexts?.set(context.sessionId, context.session);
        return new DeterministicAgent(context);
      },
    },
    {
      key: 'leaf',
      create: (context) => {
        contexts?.set(context.sessionId, context.session);
        return new DeterministicAgent(context);
      },
    },
    {
      key: 'privileged',
      create: (context) => new DeterministicAgent(context),
    },
    {
      key: 'eager',
      create: () => new EagerMutationAgent(),
    },
    {
      key: 'artifact',
      create: () => new ArtifactAgent(),
      captureArtifacts: (retainedAgent) =>
        (retainedAgent as ArtifactAgent).getArtifact(),
      restoreArtifacts: (retainedAgent, artifact) =>
        (retainedAgent as ArtifactAgent).setArtifact(artifact),
    },
    {
      key: 'destructive-stop',
      create: () => new DestructiveStopAgent(),
      captureArtifacts: (retainedAgent) =>
        (retainedAgent as DestructiveStopAgent).getArtifact(),
    },
  ];
}

function host(
  options: Readonly<{
    contexts?: Map<string, AxAgentSessionClient>;
    store?: AxAgentSessionStore;
    scheduler?: AxAgentSessionScheduler;
    limits?: ConstructorParameters<typeof AxAgentSessionHost>[0]['limits'];
  }> = {}
) {
  return new AxAgentSessionHost({
    ai: unusedAI,
    registrations: registrations(options.contexts),
    store: options.store,
    scheduler: options.scheduler,
    limits: options.limits,
  });
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for value: ${JSON.stringify(value)}`);
    }
    await delay(5);
    value = await read();
  }
  return value;
}

async function completed(
  client: AxAgentSessionClient,
  handle: Parameters<AxAgentSessionClient['inspect']>[0]
) {
  return waitFor(
    () => client.inspect(handle),
    (view) => view.status === 'completed'
  );
}

async function refreshDirectHandle(client: AxAgentSessionClient, id: string) {
  const handle = (await client.list()).find(
    (view) => view.handle.id === id
  )?.handle;
  if (!handle) throw new Error(`Missing retained child ${id}`);
  return handle;
}

describe('retained child agent sessions', () => {
  it('admits concurrent children immediately without blocking on results', async () => {
    DeterministicAgent.active = 0;
    DeterministicAgent.maxActive = 0;
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const started = Date.now();
    const first = await root.spawn('worker', { value: 'one', delayMs: 80 });
    const second = await root.spawn('worker', { value: 'two', delayMs: 80 });

    expect(Date.now() - started).toBeLessThan(60);
    expect(first.id).not.toBe(second.id);
    await Promise.all([completed(root, first), completed(root, second)]);
    expect(DeterministicAgent.maxActive).toBe(2);
    expect(await root.result(first)).toMatchObject({ value: 'one' });
    expect(await root.result(second)).toMatchObject({ value: 'two' });
  });

  it('retains mailbox, context, results, and follow-ups after completion', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'first' });
    await completed(root, handle);

    const receipt = await root.send(handle, { value: 'second' }, 'follow-up');
    expect(receipt.delivery).toBe('ready');
    const view = await waitFor(
      () => root.inspect(handle),
      (value) => value.mailbox.length === 2 && value.status === 'completed'
    );
    expect(view.mailbox.map((message) => message.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(view.latestResult).toEqual({
      value: 'second',
      count: 2,
      history: ['first', 'second'],
    });
  });

  it('distinguishes steering from a queued follow-up', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', {
      value: 'cancel-me',
      delayMs: 150,
    });
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'running'
    );
    const followUp = await root.send(
      handle,
      { value: 'queued-follow-up' },
      'follow-up'
    );
    const steer = await root.send(handle, { value: 'steer-now' }, 'steer');

    expect(followUp.delivery).toBe('queued');
    expect(steer.delivery).toBe('interrupting');
    expect(steer.interruptAccepted).toBe(true);
    const view = await waitFor(
      () => root.inspect(handle),
      (value) =>
        value.mailbox.every(
          (message) =>
            message.status !== 'pending' && message.status !== 'running'
        )
    );
    expect(view.mailbox[0]?.status).toBe('cancelled');
    expect(view.mailbox[2]?.result).toMatchObject({
      value: 'steer-now',
      count: 1,
    });
    expect(view.mailbox[1]?.result).toMatchObject({
      value: 'queued-follow-up',
      count: 2,
    });
  });

  it('enforces child, concurrency, pending-message, and subcall bounds', async () => {
    DeterministicAgent.active = 0;
    DeterministicAgent.maxActive = 0;
    const sessions = host({
      limits: {
        maxChildren: 2,
        maxConcurrency: 1,
        maxPendingMessages: 1,
        maxSubcalls: 4,
      },
    });
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const first = await root.spawn('worker', {
      value: 'slow',
      delayMs: 100,
      tokens: 2,
    });
    const second = await root.spawn('worker', { value: 'second', tokens: 2 });
    await expect(
      root.spawn('worker', { value: 'third' })
    ).rejects.toMatchObject({ limit: 'maxChildren' });
    await waitFor(
      () => root.inspect(first),
      (view) => view.status === 'running'
    );
    await root.send(first, { value: 'one-pending' }, 'follow-up');
    await expect(
      root.send(first, { value: 'too-many' }, 'follow-up')
    ).rejects.toMatchObject({ limit: 'maxPendingMessages' });

    await completed(root, second);
    expect(DeterministicAgent.maxActive).toBe(1);
    await waitFor(
      () => root.inspect(first),
      (view) => view.mailbox.every((message) => message.status === 'completed')
    );
    await expect(
      root.send(second, { value: 'fourth-admission' }, 'follow-up')
    ).resolves.toMatchObject({ mode: 'follow-up' });
    await waitFor(
      () => root.inspect(second),
      (view) =>
        view.mailbox.length === 2 &&
        view.mailbox.every((message) => message.status === 'completed')
    );
    await expect(
      root.send(second, { value: 'subcall-exhausted' }, 'follow-up')
    ).rejects.toMatchObject({ limit: 'maxSubcalls' });
    expect((await root.inspectRoot()).budgetExceeded).toBe('subcalls');
  });

  it('stops new work after reported token usage reaches the budget', async () => {
    const sessions = host({ limits: { maxTokens: 4 } });
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'budget', tokens: 2 });
    await completed(root, handle);
    expect((await root.inspectRoot()).budgetExceeded).toBe('tokens');
    await expect(
      root.send(handle, { value: 'denied' }, 'follow-up')
    ).rejects.toMatchObject({ limit: 'maxTokens' });
  });

  it('enforces depth and explicit per-parent registration authorization', async () => {
    const contexts = new Map<string, AxAgentSessionClient>();
    const sessions = host({ contexts });
    const root = await sessions.createRoot({
      authorizedChildren: ['parent'],
      limits: { maxDepth: 1 },
    });
    await expect(
      root.spawn('privileged', { value: 'denied' })
    ).rejects.toBeInstanceOf(AxAgentSessionAuthorizationError);
    const parent = await root.spawn('parent', { value: 'parent', delayMs: 40 });
    await waitFor(
      () => root.inspect(parent),
      (view) => view.status === 'running'
    );
    const childClient = contexts.get(parent.id)!;
    await expect(
      childClient.spawn('leaf', { value: 'too-deep' })
    ).rejects.toMatchObject({ limit: 'maxDepth' });
  });

  it('attributes nested descendant usage to stable parent and root ids', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      id: 'stable-root',
      authorizedChildren: ['parent'],
    });
    const parent = await root.spawn('parent', {
      value: 'nested',
      tokens: 2,
      spawnNested: true,
    });
    const parentView = await completed(root, parent);
    expect(parentView.handle.rootId).toBe('stable-root');
    expect((parentView.latestResult as WorkOutput).childId).toBeTruthy();

    const withDescendant = await waitFor(
      () => root.inspect(parent),
      (view) => view.descendantUsage.totalTokens === 6
    );
    expect(withDescendant.usage.totalTokens).toBe(4);
    expect(withDescendant.descendantUsage.totalTokens).toBe(6);
    const rootView = await root.inspectRoot();
    expect(rootView.descendantUsage).toMatchObject({
      modelCalls: 2,
      totalTokens: 10,
    } satisfies Partial<AxAgentSessionUsage>);
  });

  it('propagates root and parent cancellation to active descendants', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['parent'],
    });
    const parent = await root.spawn('parent', {
      value: 'parent',
      spawnNested: true,
    });
    await completed(root, parent);
    const snapshot = await sessions.snapshot(parent.rootId);
    const leaf = Object.values(snapshot.sessions).find(
      (record) => record.handle.parentId === parent.id
    )!;
    await root.cancel(parent);
    const cancelled = await waitFor(
      () => sessions.snapshot(parent.rootId),
      (value) =>
        value.sessions[parent.id]?.status === 'cancelled' &&
        value.sessions[leaf.handle.id]?.status === 'cancelled'
    );
    expect(cancelled.sessions[parent.id]?.status).toBe('cancelled');
    expect(cancelled.sessions[leaf.handle.id]?.status).toBe('cancelled');
  });

  it('restores child context and mailbox from a serializable snapshot', async () => {
    const firstHost = host();
    const root = await firstHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'before' });
    await completed(root, handle);
    const snapshot = await firstHost.snapshot(handle.rootId);
    await firstHost.close();

    const secondHost = host();
    const restoredRoot = await secondHost.restore(snapshot, {
      expectedPolicyDigest: snapshot.policyDigest,
    });
    const restoredHandle = await refreshDirectHandle(restoredRoot, handle.id);
    await restoredRoot.send(restoredHandle, { value: 'after' }, 'follow-up');
    const view = await waitFor(
      () => restoredRoot.inspect(restoredHandle),
      (value) => value.mailbox.length === 2 && value.status === 'completed'
    );
    expect(view.latestResult).toMatchObject({
      count: 2,
      history: ['before', 'after'],
    });
  });

  it('captures and restores registration-owned serializable artifacts', async () => {
    const firstHost = host();
    const root = await firstHost.createRoot({
      authorizedChildren: ['artifact'],
    });
    const handle = await root.spawn('artifact', { value: 'first-artifact' });
    await completed(root, handle);
    const snapshot = await firstHost.snapshot(handle.rootId);
    expect(snapshot.sessions[handle.id]?.artifacts).toBe('first-artifact');
    await firstHost.close();

    const secondHost = host();
    const restoredRoot = await secondHost.restore(snapshot, {
      expectedPolicyDigest: snapshot.policyDigest,
    });
    const restoredHandle = await refreshDirectHandle(restoredRoot, handle.id);
    await restoredRoot.send(
      restoredHandle,
      { value: 'second-artifact' },
      'follow-up'
    );
    const restored = await waitFor(
      () => restoredRoot.inspect(restoredHandle),
      (view) => view.mailbox.length === 2 && view.status === 'completed'
    );
    expect(restored.latestResult).toMatchObject({
      history: ['first-artifact', 'second-artifact'],
    });
  });

  it('rotates restore authority while leaving a live source domain isolated', async () => {
    const sourceHost = host();
    const sourceRoot = await sourceHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const sourceHandle = await sourceRoot.spawn('worker', { value: 'source' });
    await completed(sourceRoot, sourceHandle);
    const snapshot = await sourceHost.snapshot(sourceHandle.rootId);

    const destinationHost = host();
    const destinationRoot = await destinationHost.restore(snapshot, {
      expectedPolicyDigest: snapshot.policyDigest,
    });
    const destinationHandle = await refreshDirectHandle(
      destinationRoot,
      sourceHandle.id
    );

    expect(destinationHandle.epoch).toBe(sourceHandle.epoch + 1);
    expect(destinationHandle.capability).not.toBe(sourceHandle.capability);
    await expect(destinationRoot.inspect(sourceHandle)).rejects.toBeInstanceOf(
      AxAgentSessionStaleHandleError
    );
    await expect(sourceRoot.inspect(destinationHandle)).rejects.toBeInstanceOf(
      AxAgentSessionStaleHandleError
    );
    await expect(sourceRoot.inspect(sourceHandle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(
      destinationRoot.inspect(destinationHandle)
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects snapshots whose root or child authorization was altered', async () => {
    const firstHost = host();
    const root = await firstHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'confirmed' });
    await completed(root, handle);
    const snapshot = await firstHost.snapshot(handle.rootId);

    const expandedRoot = structuredClone(snapshot);
    expandedRoot.root.authorizedChildren.push('privileged');
    await expect(
      host().restore(expandedRoot, {
        expectedPolicyDigest: snapshot.policyDigest,
      })
    ).rejects.toBeInstanceOf(AxAgentSessionAuthorizationError);

    const expandedChild = structuredClone(snapshot);
    expandedChild.sessions[handle.id]!.authorizedChildren.push('leaf');
    await expect(
      host().restore(expandedChild, {
        expectedPolicyDigest: snapshot.policyDigest,
      })
    ).rejects.toThrow(/child authorization does not match registration/);

    const swappedRegistration = structuredClone(snapshot);
    swappedRegistration.sessions[handle.id]!.handle.registrationKey =
      'privileged';
    await expect(
      host().restore(swappedRegistration, {
        expectedPolicyDigest: snapshot.policyDigest,
      })
    ).rejects.toThrow(/is not authorized by parent/);

    const nestedHost = host();
    const nestedRoot = await nestedHost.createRoot({
      authorizedChildren: ['parent'],
    });
    const parent = await nestedRoot.spawn('parent', {
      value: 'parent',
      spawnNested: true,
    });
    await completed(nestedRoot, parent);
    const nestedSnapshot = await nestedHost.snapshot(parent.rootId);
    const nestedPolicyDigest = nestedSnapshot.policyDigest;
    const leaf = Object.values(nestedSnapshot.sessions).find(
      (record) => record.handle.parentId === parent.id
    );
    expect(leaf).toBeDefined();
    nestedSnapshot.sessions[leaf!.handle.id]!.handle.registrationKey =
      'privileged';
    await expect(
      host().restore(nestedSnapshot, {
        expectedPolicyDigest: nestedPolicyDigest,
      })
    ).rejects.toThrow(/is not authorized by parent/);
  });

  it('rejects inflated, reset, ancestral, and concurrent snapshot accounting', async () => {
    const sourceHost = host();
    const sourceRoot = await sourceHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await sourceRoot.spawn('worker', {
      value: 'accounted',
      tokens: 2,
    });
    await completed(sourceRoot, handle);
    const snapshot = await sourceHost.snapshot(handle.rootId);

    const inflated = structuredClone(snapshot);
    const inflatedRecord = inflated.sessions[handle.id]!;
    const inflatedMessage = inflatedRecord.mailbox[0]!;
    for (const usage of [
      inflatedMessage.usage!,
      inflatedRecord.usage,
      inflated.root.descendantUsage,
    ]) {
      usage.promptTokens++;
      usage.totalTokens++;
    }
    await expect(
      host().restore(inflated, {
        expectedPolicyDigest: snapshot.policyDigest,
      })
    ).rejects.toThrow(/policy digest is invalid/);

    const reset = structuredClone(snapshot);
    reset.sessions[handle.id]!.usage = {
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    await expect(
      host().restore(reset, {
        expectedPolicyDigest: snapshot.policyDigest,
      })
    ).rejects.toThrow(/direct usage does not match/);

    const emptyHost = host();
    const emptyRoot = await emptyHost.createRoot({
      authorizedChildren: [],
    });
    const emptySnapshot = await emptyHost.snapshot(emptyRoot.sessionId);
    const emptyDigest = emptySnapshot.policyDigest;
    emptySnapshot.root.descendantUsage.promptTokens = 250_000;
    emptySnapshot.root.descendantUsage.totalTokens = 250_000;
    await expect(
      host().restore(emptySnapshot, {
        expectedPolicyDigest: emptyDigest,
      })
    ).rejects.toThrow(/root descendant usage does not reconcile/);

    const nestedHost = host();
    const nestedRoot = await nestedHost.createRoot({
      authorizedChildren: ['parent'],
    });
    const parent = await nestedRoot.spawn('parent', {
      value: 'parent-accounting',
      spawnNested: true,
    });
    await waitFor(
      () => nestedRoot.inspect(parent),
      (view) => view.descendantUsage.totalTokens === 6
    );
    const nestedSnapshot = await nestedHost.snapshot(parent.rootId);
    const nestedDigest = nestedSnapshot.policyDigest;
    nestedSnapshot.sessions[parent.id]!.descendantUsage = {
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    await expect(
      host().restore(nestedSnapshot, {
        expectedPolicyDigest: nestedDigest,
      })
    ).rejects.toThrow(/descendant usage does not reconcile/);

    const concurrentHost = host({ limits: { maxConcurrency: 1 } });
    const concurrentRoot = await concurrentHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const first = await concurrentRoot.spawn('worker', {
      value: 'running',
      delayMs: 100,
    });
    const second = await concurrentRoot.spawn('worker', { value: 'pending' });
    await waitFor(
      () => concurrentRoot.inspect(first),
      (view) => view.status === 'running'
    );
    const concurrentSnapshot = await concurrentHost.snapshot(first.rootId);
    const concurrentDigest = concurrentSnapshot.policyDigest;
    const secondRecord = concurrentSnapshot.sessions[second.id]!;
    const secondMessage = secondRecord.mailbox[0]!;
    secondMessage.status = 'running';
    secondMessage.startedAt = Date.now();
    secondMessage.attemptId = 'forged-attempt';
    secondMessage.tokenReservation =
      concurrentSnapshot.root.limits.maxTokensPerMessage;
    secondRecord.activeMessageId = secondMessage.id;
    secondRecord.status = 'running';
    concurrentSnapshot.root.reservedTokens +=
      concurrentSnapshot.root.limits.maxTokensPerMessage;
    await expect(
      host().restore(concurrentSnapshot, {
        expectedPolicyDigest: concurrentDigest,
      })
    ).rejects.toThrow(/concurrency/);
    await concurrentRoot.cancel();
  });

  it('preserves disposed usage and subcalls in reconciled retired ledgers', async () => {
    const contexts = new Map<string, AxAgentSessionClient>();
    const sessions = host({ contexts });
    const root = await sessions.createRoot({
      authorizedChildren: ['parent'],
    });
    const parent = await root.spawn('parent', {
      value: 'retire-tree',
      spawnNested: true,
    });
    await waitFor(
      () => root.inspect(parent),
      (view) => view.descendantUsage.totalTokens === 6
    );
    const parentSession = contexts.get(parent.id)!;
    const leaf = (await parentSession.list())[0]!.handle;
    await parentSession.dispose(leaf);
    const afterLeafDisposal = await sessions.snapshot(parent.rootId);
    expect(afterLeafDisposal.root.retiredDescendantUsage.totalTokens).toBe(0);
    expect(
      afterLeafDisposal.sessions[parent.id]!.retiredDescendantUsage.totalTokens
    ).toBe(6);

    await root.dispose(parent);
    expect(await root.inspectRoot()).toMatchObject({
      admittedSubcalls: 2,
      childCount: 0,
      descendantUsage: { modelCalls: 2, totalTokens: 10 },
      retiredDescendantUsage: { modelCalls: 2, totalTokens: 10 },
      retiredSubcalls: 2,
    });

    const snapshot = await sessions.snapshot(parent.rootId);
    const restored = await host().restore(snapshot, {
      expectedPolicyDigest: snapshot.policyDigest,
    });
    expect(await restored.inspectRoot()).toMatchObject({
      admittedSubcalls: 2,
      childCount: 0,
      descendantUsage: { modelCalls: 2, totalTokens: 10 },
      retiredDescendantUsage: { modelCalls: 2, totalTokens: 10 },
      retiredSubcalls: 2,
    });
  });

  it('discards partial live runtime mutations after cancellation', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['eager'],
    });
    const handle = await root.spawn('eager', {
      value: 'must-not-survive',
      delayMs: 100,
    });
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'running'
    );
    await root.cancel(handle);
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'cancelled'
    );

    await root.send(handle, { value: 'confirmed' }, 'follow-up');
    const resumed = await completed(root, handle);
    expect(resumed.latestResult).toMatchObject({
      count: 1,
      history: ['confirmed'],
    });
  });

  it('makes root cancellation terminal for new admissions and messages', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'completed' });
    await completed(root, handle);
    await root.cancel();

    await expect(
      root.spawn('worker', { value: 'denied' })
    ).rejects.toBeInstanceOf(AxAgentSessionAuthorizationError);
    await expect(
      root.send(handle, { value: 'denied' }, 'follow-up')
    ).rejects.toBeInstanceOf(AxAgentSessionAuthorizationError);
  });

  it('observes an already-aborted parent signal before returning the root', async () => {
    const controller = new AbortController();
    controller.abort('parent stopped');
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
      abortSignal: controller.signal,
    });

    expect((await root.inspectRoot()).status).toBe('cancelled');
    await expect(
      root.spawn('worker', { value: 'denied' })
    ).rejects.toBeInstanceOf(AxAgentSessionAuthorizationError);
  });

  it('rejects forged and disposed handles without resurrecting sessions', async () => {
    const sessions = host();
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'work' });
    await expect(
      root.inspect({ ...handle, capability: 'forged' })
    ).rejects.toBeInstanceOf(AxAgentSessionStaleHandleError);
    await expect(
      root.inspect({ ...handle, registrationKey: 'privileged' })
    ).rejects.toBeInstanceOf(AxAgentSessionStaleHandleError);
    await root.dispose(handle);
    await expect(root.inspect(handle)).rejects.toBeInstanceOf(
      AxAgentSessionNotFoundError
    );
  });

  it('registers event continuations and emits the same stable correlation', async () => {
    const events: unknown[] = [];
    const sessions = new AxAgentSessionHost({
      ai: unusedAI,
      registrations: registrations(),
      onEvent: (event) => events.push(event),
    });
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const functions = root.functions({ eventContinuations: true });
    const spawn = functions.find((fn) => fn.name === 'spawn')!;
    let registration: unknown;
    const handle = await spawn.func(
      { agent: 'worker', input: { value: 'event' } },
      {
        eventContext: {
          registerContinuation(value) {
            registration = value;
            return 'continuation';
          },
        } as never,
      }
    );
    await completed(root, handle);
    expect(registration).toEqual({
      correlation: [{ kind: 'ax-agent-session', value: handle.id }],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'completed',
        correlation: { kind: 'ax-agent-session', value: handle.id },
      })
    );
  });
});

class DurableMemoryStore
  extends AxInMemoryAgentSessionStore
  implements AxAgentSessionStore
{
  override readonly capabilities = {
    durability: 'persistent',
    coordination: 'multi-worker',
  } as const;
}

class PausingDurableStore extends DurableMemoryStore {
  private pause?: {
    committed: () => void;
    release: Promise<void>;
  };

  pauseNextSaveAfterCommit() {
    let committed!: () => void;
    let release!: () => void;
    const committedPromise = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pause = { committed, release: releasePromise };
    return { committed: committedPromise, release };
  }

  override async save(
    snapshot: Parameters<AxAgentSessionStore['save']>[0],
    expectedRevision: number | undefined
  ) {
    const saved = await super.save(snapshot, expectedRevision);
    const pause = this.pause;
    if (pause) {
      this.pause = undefined;
      pause.committed();
      await pause.release;
    }
    return saved;
  }
}

class ManualScheduler implements AxAgentSessionScheduler {
  readonly capabilities = {
    durability: 'persistent',
    coordination: 'multi-worker',
  } as const;
  private handler?: (job: Readonly<AxAgentSessionJob>) => Promise<void>;
  private readonly jobs = new Map<string, AxAgentSessionJob>();

  attach(handler: (job: Readonly<AxAgentSessionJob>) => Promise<void>) {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  async enqueue(job: Readonly<AxAgentSessionJob>): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async cancel(jobId: string): Promise<boolean> {
    return this.jobs.delete(jobId);
  }

  runOne(): Promise<void> {
    const job = this.jobs.values().next().value as
      | AxAgentSessionJob
      | undefined;
    if (!job || !this.handler) return Promise.resolve();
    this.jobs.delete(job.id);
    return this.handler(job);
  }

  async runAll(): Promise<void> {
    while (this.jobs.size > 0) await this.runOne();
  }

  queuedJobs(): AxAgentSessionJob[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  clearJobs(): void {
    this.jobs.clear();
  }
}

describe('retained session crash recovery adapters', () => {
  it('runs a queued steer before earlier pending follow-ups', async () => {
    const scheduler = new ManualScheduler();
    const sessions = host({ scheduler });
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', { value: 'initial' });
    await root.send(handle, { value: 'follow-up' }, 'follow-up');
    await root.send(handle, { value: 'steer' }, 'steer');

    await scheduler.runAll();
    const view = await completed(root, handle);
    expect(view.mailbox[2]?.result).toMatchObject({
      value: 'steer',
      count: 1,
    });
    expect(view.mailbox[0]?.result).toMatchObject({
      value: 'initial',
      count: 2,
    });
    expect(view.mailbox[1]?.result).toMatchObject({
      value: 'follow-up',
      count: 3,
    });
  });

  it('never grants a recovered epoch to a spawn paused after its admission CAS', async () => {
    const store = new PausingDurableStore();
    const firstScheduler = new ManualScheduler();
    const firstHost = host({ store, scheduler: firstScheduler });
    const root = await firstHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const pause = store.pauseNextSaveAfterCommit();
    const spawning = root.spawn('worker', {
      value: 'admitted-before-recovery',
    });
    await pause.committed;

    const secondScheduler = new ManualScheduler();
    const secondHost = host({ store, scheduler: secondScheduler });
    await secondHost.recover(root.sessionId);
    const recoveredRoot = await secondHost.restoreRoot(root.sessionId);
    expect(secondScheduler.queuedJobs()).toEqual([
      expect.objectContaining({ epoch: 2 }),
    ]);

    pause.release();
    const staleHandle = await spawning;
    expect(staleHandle.epoch).toBe(1);
    expect(firstScheduler.queuedJobs()).toEqual([
      expect.objectContaining({ epoch: 1 }),
    ]);
    expect(firstScheduler.queuedJobs()).not.toEqual([
      expect.objectContaining({ epoch: 2 }),
    ]);
    await expect(root.inspect(staleHandle)).rejects.toBeInstanceOf(
      AxAgentSessionStaleHandleError
    );
    expect(
      (await refreshDirectHandle(recoveredRoot, staleHandle.id)).epoch
    ).toBe(2);
  });

  it('rejects a same-epoch scheduler job replayed from another restore domain', async () => {
    const sourceStore = new DurableMemoryStore();
    const sourceScheduler = new ManualScheduler();
    const sourceHost = host({ store: sourceStore, scheduler: sourceScheduler });
    const sourceRoot = await sourceHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const sourceHandle = await sourceRoot.spawn('worker', {
      value: 'domain-bound-job',
    });
    const sourceSnapshot = await sourceHost.snapshot(sourceHandle.rootId);

    const destinationStore = new DurableMemoryStore();
    const destinationScheduler = new ManualScheduler();
    const destinationHost = host({
      store: destinationStore,
      scheduler: destinationScheduler,
    });
    const destinationRoot = await destinationHost.restore(sourceSnapshot, {
      expectedPolicyDigest: sourceSnapshot.policyDigest,
    });
    const destinationHandle = await refreshDirectHandle(
      destinationRoot,
      sourceHandle.id
    );
    const destinationJob = destinationScheduler.queuedJobs()[0]!;

    await sourceHost.recover(sourceHandle.rootId);
    const foreignJob = sourceScheduler
      .queuedJobs()
      .find(
        (job) =>
          job.epoch === destinationJob.epoch && job.id !== destinationJob.id
      )!;
    expect(foreignJob).toMatchObject({
      rootId: destinationJob.rootId,
      sessionId: destinationJob.sessionId,
      messageId: destinationJob.messageId,
      epoch: destinationJob.epoch,
    });

    destinationScheduler.clearJobs();
    const beforeReplay = await destinationHost.snapshot(sourceHandle.rootId);
    await destinationScheduler.enqueue(foreignJob);
    await destinationScheduler.runAll();
    const afterReplay = await destinationHost.snapshot(sourceHandle.rootId);
    expect(afterReplay.revision).toBe(beforeReplay.revision);
    expect(afterReplay.root.updatedAt).toBe(beforeReplay.root.updatedAt);
    expect(afterReplay.sessions[sourceHandle.id]?.mailbox[0]?.status).toBe(
      'pending'
    );

    await destinationScheduler.enqueue(destinationJob);
    await destinationScheduler.runAll();
    await expect(
      destinationRoot.result(destinationHandle)
    ).resolves.toMatchObject({ value: 'domain-bound-job' });
  });

  it('revokes every stale root and nested-session operation on recovery', async () => {
    const store = new DurableMemoryStore();
    const scheduler = new ManualScheduler();
    const contexts = new Map<string, AxAgentSessionClient>();
    const firstHost = host({ store, scheduler, contexts });
    const root = await firstHost.createRoot({
      authorizedChildren: ['parent'],
    });
    const parent = await root.spawn('parent', {
      value: 'uncertain-parent',
      delayMs: 100,
    });
    const inFlight = scheduler.runOne();
    await waitFor(
      () => root.inspect(parent),
      (view) => view.status === 'running'
    );
    const staleSession = contexts.get(parent.id)!;
    const leaf = await staleSession.spawn('leaf', { value: 'queued-leaf' });

    const recoveredHost = host({
      store,
      scheduler: new ManualScheduler(),
    });
    await recoveredHost.recover(parent.rootId);
    const recoveredRoot = await recoveredHost.restoreRoot(parent.rootId);
    const recoveredParent = await refreshDirectHandle(recoveredRoot, parent.id);
    const beforeStaleJob = await recoveredHost.snapshot(parent.rootId);
    await scheduler.runAll();
    const afterStaleJob = await recoveredHost.snapshot(parent.rootId);
    expect(afterStaleJob.revision).toBe(beforeStaleJob.revision);
    expect(afterStaleJob.root.updatedAt).toBe(beforeStaleJob.root.updatedAt);
    expect(afterStaleJob.sessions[leaf.id]?.mailbox[0]?.status).toBe('pending');

    await expect(root.inspect(parent)).rejects.toBeInstanceOf(
      AxAgentSessionStaleHandleError
    );
    const staleOperations = [
      () => staleSession.spawn('leaf', { value: 'stale-spawn' }),
      () => staleSession.inspect(leaf),
      () => staleSession.send(leaf, { value: 'stale-send' }, 'follow-up'),
      () => staleSession.cancel(leaf),
      () => staleSession.dispose(leaf),
      () => staleSession.cancel(),
    ];
    for (const operation of staleOperations) {
      await expect(operation()).rejects.toBeInstanceOf(
        AxAgentSessionStaleHandleError
      );
    }
    await expect(recoveredRoot.inspect(recoveredParent)).resolves.toMatchObject(
      {
        status: 'interrupted',
      }
    );
    expect((await recoveredRoot.inspectRoot()).childCount).toBe(2);
    await inFlight;
    expect(
      (await recoveredHost.snapshot(parent.rootId)).sessions[leaf.id]
        ?.mailbox[0]?.status
    ).toBe('pending');
  });

  it('does not let a same-host stale completion enqueue recovered work', async () => {
    const store = new DurableMemoryStore();
    const scheduler = new ManualScheduler();
    const sessions = host({ store, scheduler });
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', {
      value: 'uncertain',
      delayMs: 100,
    });
    const staleAttempt = scheduler.runOne();
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'running'
    );
    await root.send(handle, { value: 'pending-after-recovery' }, 'follow-up');

    await sessions.recover(root.sessionId);
    const recoveredRoot = await sessions.restoreRoot(root.sessionId);
    const recoveredHandle = await refreshDirectHandle(recoveredRoot, handle.id);
    expect(scheduler.queuedJobs()).toEqual([
      expect.objectContaining({ epoch: 2 }),
    ]);
    scheduler.clearJobs();
    const beforeStaleCompletion = await sessions.snapshot(root.sessionId);

    await staleAttempt;
    const afterStaleCompletion = await sessions.snapshot(root.sessionId);
    expect(scheduler.queuedJobs()).toEqual([]);
    expect(afterStaleCompletion.revision).toBe(beforeStaleCompletion.revision);
    expect(afterStaleCompletion.root.updatedAt).toBe(
      beforeStaleCompletion.root.updatedAt
    );
    expect(
      (await recoveredRoot.inspect(recoveredHandle)).mailbox[1]?.status
    ).toBe('pending');
  });

  it('charges outcome_unknown attempts against durable token and subcall budgets', async () => {
    const store = new DurableMemoryStore();
    const firstScheduler = new ManualScheduler();
    const firstHost = host({
      store,
      scheduler: firstScheduler,
      limits: {
        maxTokens: 8,
        maxTokensPerMessage: 4,
        maxSubcalls: 3,
      },
    });
    const root = await firstHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', {
      value: 'uncertain',
      delayMs: 100,
      tokens: 1,
    });
    const inFlight = firstScheduler.runOne();
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'running'
    );
    await root.send(
      handle,
      { value: 'durable-follow-up', tokens: 1 },
      'follow-up'
    );

    const secondScheduler = new ManualScheduler();
    const secondHost = host({
      store,
      scheduler: secondScheduler,
      limits: {
        maxTokens: 8,
        maxTokensPerMessage: 4,
        maxSubcalls: 3,
      },
    });
    await secondHost.recover(handle.rootId);
    const recoveredRoot = await secondHost.restoreRoot(handle.rootId);
    const recoveredHandle = await refreshDirectHandle(recoveredRoot, handle.id);
    expect(await recoveredRoot.inspectRoot()).toMatchObject({
      admittedSubcalls: 2,
      reservedTokens: 0,
      outcomeUnknownTokens: 4,
    });

    await secondScheduler.runAll();
    await completed(recoveredRoot, recoveredHandle);
    expect(await recoveredRoot.inspectRoot()).toMatchObject({
      admittedSubcalls: 2,
      outcomeUnknownTokens: 4,
      budgetExceeded: 'tokens',
    });
    await expect(
      recoveredRoot.send(
        recoveredHandle,
        { value: 'budget-reset-attempt' },
        'follow-up'
      )
    ).rejects.toMatchObject({ limit: 'maxTokens' });
    await inFlight;
  });

  it('fences in-flight work as outcome_unknown and resumes only pending mail', async () => {
    const store = new DurableMemoryStore();
    const firstScheduler = new ManualScheduler();
    const firstHost = host({ store, scheduler: firstScheduler });
    const root = await firstHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', {
      value: 'uncertain',
      delayMs: 120,
    });
    const inFlight = firstScheduler.runOne();
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'running'
    );
    await root.send(handle, { value: 'durable-follow-up' }, 'follow-up');
    await firstHost.close();

    const secondScheduler = new ManualScheduler();
    const secondHost = host({ store, scheduler: secondScheduler });
    await secondHost.recover(handle.rootId);
    const restoredRoot = await secondHost.restoreRoot(handle.rootId);
    const recoveredHandle = await refreshDirectHandle(restoredRoot, handle.id);
    const interrupted = await restoredRoot.inspect(recoveredHandle);
    expect(interrupted.mailbox[0]?.status).toBe('outcome_unknown');
    expect(interrupted.mailbox[1]?.status).toBe('pending');
    expect(interrupted.durability).toEqual({
      store: 'persistent',
      scheduler: 'persistent',
    });

    await secondScheduler.runAll();
    const recovered = await completed(restoredRoot, recoveredHandle);
    expect(recovered.latestResult).toMatchObject({
      value: 'durable-follow-up',
      count: 1,
    });
    await inFlight;
    expect(
      (await restoredRoot.inspect(recoveredHandle)).mailbox[0]?.status
    ).toBe('outcome_unknown');
  });

  it('does not reuse stale process-local state after multi-worker recovery', async () => {
    const store = new DurableMemoryStore();
    const firstScheduler = new ManualScheduler();
    const firstHost = host({ store, scheduler: firstScheduler });
    const root = await firstHost.createRoot({
      authorizedChildren: ['worker'],
    });
    const handle = await root.spawn('worker', {
      value: 'uncertain',
      delayMs: 100,
    });
    const staleAttempt = firstScheduler.runOne();
    await waitFor(
      () => root.inspect(handle),
      (view) => view.status === 'running'
    );
    await root.send(handle, { value: 'confirmed' }, 'follow-up');

    const secondScheduler = new ManualScheduler();
    const secondHost = host({ store, scheduler: secondScheduler });
    await secondHost.recover(handle.rootId);
    const recoveredRoot = await secondHost.restoreRoot(handle.rootId);
    const recoveredHandle = await refreshDirectHandle(recoveredRoot, handle.id);
    await secondScheduler.runAll();
    expect(
      (await completed(recoveredRoot, recoveredHandle)).latestResult
    ).toMatchObject({
      history: ['confirmed'],
    });
    await staleAttempt;

    await expect(
      root.send(handle, { value: 'stale-owner' }, 'follow-up')
    ).rejects.toBeInstanceOf(AxAgentSessionStaleHandleError);
    await recoveredRoot.send(
      recoveredHandle,
      { value: 'after-recovery' },
      'follow-up'
    );
    await secondScheduler.runAll();
    expect(
      (await completed(recoveredRoot, recoveredHandle)).latestResult
    ).toMatchObject({
      count: 2,
      history: ['confirmed', 'after-recovery'],
    });
  });

  it('detaches captured values before stopping a multi-worker attempt', async () => {
    const store = new DurableMemoryStore();
    const scheduler = new ManualScheduler();
    const sessions = host({ store, scheduler });
    const root = await sessions.createRoot({
      authorizedChildren: ['destructive-stop'],
    });
    const handle = await root.spawn('destructive-stop', {
      value: 'confirmed',
    });

    await scheduler.runAll();
    expect((await completed(root, handle)).latestResult).toMatchObject({
      count: 1,
      history: ['confirmed'],
    });
    const snapshot = await sessions.snapshot(handle.rootId);
    expect(
      snapshot.sessions[handle.id]?.state?.runtimeBindings.history
    ).toEqual(['confirmed']);
    expect(snapshot.sessions[handle.id]?.artifacts).toEqual({
      history: ['confirmed'],
    });
  });
});

describe('synchronous child compatibility', () => {
  it('does not alter retained function names or synchronous child calls', async () => {
    const scheduler = new AxInMemoryAgentSessionScheduler(1);
    expect(scheduler.capabilities).toEqual({
      durability: 'volatile',
      coordination: 'single-worker',
    });
    const sessions = host({ scheduler });
    const root = await sessions.createRoot({
      authorizedChildren: ['worker'],
    });
    expect(root.functions().map((fn) => `${fn.namespace}.${fn.name}`)).toEqual([
      'sessions.spawn',
      'sessions.inspect',
      'sessions.result',
      'sessions.send',
      'sessions.cancel',
      'sessions.dispose',
    ]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const synchronousAI = new AxMockAIService({
      features: { functions: false, streaming: false },
      chatResponse: async (request) => {
        await gate;
        const systemPrompt = String(request.chatPrompt[0]?.content ?? '');
        return {
          results: [
            {
              index: 0,
              content: systemPrompt.includes('You (`executor`)')
                ? 'Javascript Code: final("complete", {"responseText":"done"})'
                : 'Response Text: done',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: {
            ai: 'mock',
            model: 'mock',
            tokens: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          },
        };
      },
    });
    const runtime: AxCodeRuntime = {
      getUsageInstructions: () => '',
      createSession(globals) {
        return {
          execute: async (code) => {
            if (code.includes('final(')) {
              (globals?.final as (...args: unknown[]) => void)('complete', {
                responseText: 'done',
              });
            }
            return 'ok';
          },
          patchGlobals: async (patch) => {
            Object.assign(globals ?? {}, patch);
          },
          close: () => {},
        };
      },
    };
    const child = agent('requestText:string -> responseText:string', {
      contextFields: [],
      runtime,
      agentIdentity: {
        name: 'Synchronous Child',
        description: 'Existing synchronous child contract',
      },
    });
    const childFunction = child.getFunction();
    let settled = false;
    const call = childFunction
      .func({ requestText: 'wait' }, { ai: synchronousAI })
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(call).resolves.toBe('Response Text: done');
  });
});
