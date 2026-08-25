import type { AxAIService, AxFunction } from '../../ai/types.js';
import type { AxAgentUsage } from '../../dsp/types.js';
import type { AxAgentState } from '../agentInternal/agentStateTypes.js';
import {
  AxAgentSessionAuthorizationError,
  type AxAgentSessionClient,
  type AxAgentSessionFactoryContext,
  type AxAgentSessionHandle,
  AxAgentSessionHost,
  type AxAgentSessionJob,
  AxAgentSessionLimitError,
  type AxAgentSessionRegistration,
  type AxAgentSessionScheduler,
  type AxAgentSessionStore,
  AxInMemoryAgentSessionStore,
  type AxRetainedAgent,
} from '../retainedSessions.js';

type Input = {
  value: string;
  delayMs?: number;
  tokens?: number;
  spawnLeaf?: boolean;
};

type Output = {
  value: string;
  count: number;
  history: string[];
  leafId?: string;
};

type EvaluationReport = {
  mechanism: 'deterministic-delayed-agents';
  correctness: {
    synchronous: string[];
    retained: string[];
    equal: boolean;
  };
  timingMs: {
    delayedSynchronous: number;
    delayedRetained: number;
    delayedSpeedup: number;
    tinySynchronous: number;
    tinyRetained: number;
    tinyOverhead: number;
    sequentialSynchronous: number;
    sequentialRetained: number;
    sequentialOverhead: number;
  };
  retained: {
    admissionDidNotWaitForResult: boolean;
    followUpReusedContext: boolean;
    snapshotRestoreRetainedContext: boolean;
    descendantUsageTotalTokens: number;
    cancellationObserved: boolean;
    childLimitDenied: boolean;
    crashOutcomeUnknown: boolean;
    pendingMessageRecovered: boolean;
    privilegeDenied: boolean;
  };
  interpretation: string[];
};

const unusedAI = {} as AxAIService;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`retained-session-eval: ${message}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function snapshotState(history: readonly string[]): AxAgentState {
  return {
    version: 1,
    runtimeBindings: { history: [...history] },
    runtimeEntries: [],
    actionLogEntries: [],
    provenance: {},
  };
}

class EvaluationAgent implements AxRetainedAgent<Input, Output> {
  private history: string[] = [];
  private usage: AxAgentUsage = { actor: [], responder: [] };

  constructor(private readonly context?: AxAgentSessionFactoryContext) {}

  async forward(
    _ai: Readonly<AxAIService>,
    input: Input,
    options?: Readonly<{ abortSignal?: AbortSignal }>
  ): Promise<Output> {
    await sleep(input.delayMs ?? 0, options?.abortSignal);
    this.history.push(input.value);
    const tokens = input.tokens ?? 2;
    this.usage = {
      actor: [
        {
          ai: 'deterministic',
          model: 'delayed-eval-agent',
          tokens: {
            promptTokens: tokens,
            completionTokens: tokens,
            totalTokens: tokens * 2,
          },
        },
      ],
      responder: [],
    };
    let leafId: string | undefined;
    if (input.spawnLeaf) {
      leafId = (
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
      ...(leafId ? { leafId } : {}),
    };
  }

  getState(): AxAgentState {
    return snapshotState(this.history);
  }

  setState(state?: AxAgentState): void {
    const history = state?.runtimeBindings.history;
    this.history = Array.isArray(history)
      ? history.filter((value): value is string => typeof value === 'string')
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

function registrations(): AxAgentSessionRegistration[] {
  return [
    {
      key: 'worker',
      create: (context) => new EvaluationAgent(context),
    },
    {
      key: 'parent',
      authorizedChildren: ['leaf'],
      create: (context) => new EvaluationAgent(context),
    },
    {
      key: 'leaf',
      create: (context) => new EvaluationAgent(context),
    },
    {
      key: 'privileged',
      create: (context) => new EvaluationAgent(context),
    },
  ];
}

function createHost(
  options: Readonly<{
    store?: AxAgentSessionStore;
    scheduler?: AxAgentSessionScheduler;
  }> = {}
) {
  return new AxAgentSessionHost({
    ai: unusedAI,
    registrations: registrations(),
    store: options.store,
    scheduler: options.scheduler,
  });
}

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ready(value)) {
    assert(Date.now() < deadline, `timed out: ${JSON.stringify(value)}`);
    await sleep(2);
    value = await read();
  }
  return value;
}

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function synchronousChildFunction(): AxFunction {
  const child = new EvaluationAgent();
  return {
    name: 'worker',
    namespace: 'synchronous-child',
    description: 'Deterministic synchronous child evaluation function',
    parameters: { type: 'object' },
    func: (input, options) =>
      child.forward(options?.ai ?? unusedAI, input as Input),
  };
}

async function waitForCompleted(
  root: AxAgentSessionClient,
  handle: Readonly<AxAgentSessionHandle>
) {
  return waitFor(
    () => root.inspect(handle),
    (view) => view.status === 'completed'
  );
}

async function synchronousBatch(
  inputs: readonly Input[]
): Promise<{ elapsedMs: number; outputs: Output[] }> {
  const started = performance.now();
  const outputs: Output[] = [];
  for (const input of inputs) {
    const child = synchronousChildFunction();
    outputs.push((await child.func(input, { ai: unusedAI })) as Output);
  }
  return { elapsedMs: elapsed(started), outputs };
}

async function retainedBatch(inputs: readonly Input[]): Promise<{
  elapsedMs: number;
  admissionMs: number;
  outputs: Output[];
}> {
  const sessions = createHost();
  const root = await sessions.createRoot({
    authorizedChildren: ['worker'],
  });
  const started = performance.now();
  const handles: AxAgentSessionHandle[] = [];
  for (const input of inputs) handles.push(await root.spawn('worker', input));
  const admissionMs = elapsed(started);
  await Promise.all(handles.map((handle) => waitForCompleted(root, handle)));
  const outputs = (await Promise.all(
    handles.map((handle) => root.result(handle))
  )) as Output[];
  return { elapsedMs: elapsed(started), admissionMs, outputs };
}

class DurableEvaluationStore implements AxAgentSessionStore {
  readonly capabilities = {
    durability: 'persistent',
    coordination: 'multi-worker',
  } as const;
  private readonly memory = new AxInMemoryAgentSessionStore();

  load(rootId: string) {
    return this.memory.load(rootId);
  }

  save(
    snapshot: Parameters<AxAgentSessionStore['save']>[0],
    expectedRevision: number | undefined
  ) {
    return this.memory.save(snapshot, expectedRevision);
  }

  delete(rootId: string) {
    return this.memory.delete(rootId);
  }

  listRoots() {
    return this.memory.listRoots();
  }
}

class ManualEvaluationScheduler implements AxAgentSessionScheduler {
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
}

async function runEvaluation(): Promise<EvaluationReport> {
  const delayedInputs = ['alpha', 'beta', 'gamma'].map((value) => ({
    value,
    delayMs: 60,
  }));
  const synchronous = await synchronousBatch(delayedInputs);
  const retained = await retainedBatch(delayedInputs);
  const synchronousValues = synchronous.outputs.map((output) => output.value);
  const retainedValues = retained.outputs.map((output) => output.value);
  assert(
    JSON.stringify(synchronousValues) === JSON.stringify(retainedValues),
    'retained completion results differ from synchronous results'
  );
  assert(
    retained.elapsedMs - retained.admissionMs > 30,
    'retained admission waited for delayed child completion'
  );

  const tinyInputs = ['a', 'b', 'c'].map((value) => ({ value }));
  const tinySync = await synchronousBatch(tinyInputs);
  const tinyRetained = await retainedBatch(tinyInputs);

  const sequentialInputs = ['one', 'two', 'three'].map((value) => ({
    value,
    delayMs: 15,
  }));
  const sequentialSync = await synchronousBatch(sequentialInputs);
  const sequentialHost = createHost();
  const sequentialRoot = await sequentialHost.createRoot({
    authorizedChildren: ['worker'],
    limits: { maxConcurrency: 1 },
  });
  const sequentialStarted = performance.now();
  for (const input of sequentialInputs) {
    const handle = await sequentialRoot.spawn('worker', input);
    await waitForCompleted(sequentialRoot, handle);
  }
  const sequentialRetainedMs = elapsed(sequentialStarted);

  const retainedHost = createHost();
  const root = await retainedHost.createRoot({
    authorizedChildren: ['worker', 'parent'],
  });
  const handle = await root.spawn('worker', { value: 'first' });
  await waitForCompleted(root, handle);
  await root.send(handle, { value: 'second' }, 'follow-up');
  const reused = await waitFor(
    () => root.inspect(handle),
    (view) => view.mailbox.length === 2 && view.status === 'completed'
  );
  const followUp = reused.latestResult as Output;

  const saved = await retainedHost.snapshot(handle.rootId);
  await retainedHost.close();
  const restoredHost = createHost();
  const restoredRoot = await restoredHost.restore(saved);
  await restoredRoot.send(handle, { value: 'third' }, 'follow-up');
  const restored = await waitFor(
    () => restoredRoot.inspect(handle),
    (view) => view.mailbox.length === 3 && view.status === 'completed'
  );
  const restoredOutput = restored.latestResult as Output;

  const parent = await restoredRoot.spawn('parent', {
    value: 'parent',
    tokens: 2,
    spawnLeaf: true,
  });
  await waitForCompleted(restoredRoot, parent);
  const parentWithUsage = await waitFor(
    () => restoredRoot.inspect(parent),
    (view) => view.descendantUsage.totalTokens === 6
  );

  const cancelHandle = await restoredRoot.spawn('worker', {
    value: 'cancel',
    delayMs: 100,
  });
  await waitFor(
    () => restoredRoot.inspect(cancelHandle),
    (view) => view.status === 'running'
  );
  await restoredRoot.cancel(cancelHandle);
  const cancelled = await waitFor(
    () => restoredRoot.inspect(cancelHandle),
    (view) => view.status === 'cancelled'
  );

  const limitedHost = createHost();
  const limitedRoot = await limitedHost.createRoot({
    authorizedChildren: ['worker'],
    limits: { maxChildren: 1 },
  });
  await limitedRoot.spawn('worker', { value: 'allowed', delayMs: 30 });
  let childLimitDenied = false;
  try {
    await limitedRoot.spawn('worker', { value: 'denied' });
  } catch (error) {
    childLimitDenied =
      error instanceof AxAgentSessionLimitError &&
      error.limit === 'maxChildren';
  }

  let privilegeDenied = false;
  try {
    await limitedRoot.spawn('privileged', { value: 'denied' });
  } catch (error) {
    privilegeDenied = error instanceof AxAgentSessionAuthorizationError;
  }

  const store = new DurableEvaluationStore();
  const firstScheduler = new ManualEvaluationScheduler();
  const crashHost = createHost({ store, scheduler: firstScheduler });
  const crashRoot = await crashHost.createRoot({
    authorizedChildren: ['worker'],
  });
  const crashHandle = await crashRoot.spawn('worker', {
    value: 'uncertain',
    delayMs: 80,
  });
  const inFlight = firstScheduler.runOne();
  await waitFor(
    () => crashRoot.inspect(crashHandle),
    (view) => view.status === 'running'
  );
  await crashRoot.send(crashHandle, { value: 'recover-this' }, 'follow-up');
  await crashHost.close();
  const secondScheduler = new ManualEvaluationScheduler();
  const recoveredHost = createHost({ store, scheduler: secondScheduler });
  await recoveredHost.recover(crashHandle.rootId);
  const recoveredRoot = await recoveredHost.restoreRoot(crashHandle.rootId);
  const afterCrash = await recoveredRoot.inspect(crashHandle);
  await secondScheduler.runAll();
  const afterRecovery = await waitForCompleted(recoveredRoot, crashHandle);
  await inFlight;

  const report: EvaluationReport = {
    mechanism: 'deterministic-delayed-agents',
    correctness: {
      synchronous: synchronousValues,
      retained: retainedValues,
      equal: true,
    },
    timingMs: {
      delayedSynchronous: synchronous.elapsedMs,
      delayedRetained: retained.elapsedMs,
      delayedSpeedup: Number(
        (synchronous.elapsedMs / retained.elapsedMs).toFixed(2)
      ),
      tinySynchronous: tinySync.elapsedMs,
      tinyRetained: tinyRetained.elapsedMs,
      tinyOverhead: Number(
        (tinyRetained.elapsedMs - tinySync.elapsedMs).toFixed(3)
      ),
      sequentialSynchronous: sequentialSync.elapsedMs,
      sequentialRetained: sequentialRetainedMs,
      sequentialOverhead: Number(
        (sequentialRetainedMs - sequentialSync.elapsedMs).toFixed(3)
      ),
    },
    retained: {
      admissionDidNotWaitForResult:
        retained.elapsedMs - retained.admissionMs > 30,
      followUpReusedContext:
        followUp.count === 2 && followUp.history.join(',') === 'first,second',
      snapshotRestoreRetainedContext:
        restoredOutput.count === 3 &&
        restoredOutput.history.join(',') === 'first,second,third',
      descendantUsageTotalTokens: parentWithUsage.descendantUsage.totalTokens,
      cancellationObserved: cancelled.mailbox.at(-1)?.status === 'cancelled',
      childLimitDenied,
      crashOutcomeUnknown: afterCrash.mailbox[0]?.status === 'outcome_unknown',
      pendingMessageRecovered:
        (afterRecovery.latestResult as Output).value === 'recover-this',
      privilegeDenied,
    },
    interpretation: [
      'Delayed independent work should benefit because admission overlaps child wall-clock time.',
      'Tiny work and intentionally sequential work can be slower because durable registry, scheduler, cloning, and polling overhead dominate.',
      'This deterministic workload validates mechanism semantics and accounting; it is not evidence of real-model answer quality.',
    ],
  };

  assert(report.timingMs.delayedSpeedup > 1.5, 'delayed work did not overlap');
  for (const [name, value] of Object.entries(report.retained)) {
    if (name === 'descendantUsageTotalTokens') continue;
    assert(value === true, `${name} failed`);
  }
  assert(
    report.retained.descendantUsageTotalTokens === 6,
    'descendant usage was not attributed to the parent'
  );
  return report;
}

const report = await runEvaluation();
console.log(JSON.stringify(report, null, 2));
