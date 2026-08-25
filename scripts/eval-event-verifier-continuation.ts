import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AxSignature } from '../src/ax/dsp/sig.js';
import type { AxProgrammable } from '../src/ax/dsp/types.js';
import { AxInMemoryEventStore } from '../src/ax/event/memoryStore.js';
import {
  AxEventRuntime,
  eventRoute,
  eventTarget,
} from '../src/ax/event/runtime.js';
import type {
  AxEventRun,
  AxEventStore,
  AxEventVerificationStatus,
  AxEventVerifierResult,
} from '../src/ax/event/types.js';
import {
  AX_SQLITE_EVENT_STANDARD_RETENTION,
  AxSQLiteEventStore,
} from '../src/tools/event/sqlite.js';

type EvaluationTask = Readonly<{
  id: string;
  outputs: readonly string[];
  verify(output: string): AxEventVerifierResult;
  truth(output: string): boolean;
  fingerprint?: (output: string) => string;
  restart?: boolean;
}>;

type TaskMetrics = {
  id: string;
  attempts: number;
  verifierCalls: number;
  promoted: boolean;
  truthPassed: boolean;
  falsePromotion: boolean;
  finalStatus: AxEventVerificationStatus;
  restarted: boolean;
};

export type EventVerifierEvaluationReport = {
  taskCount: number;
  oneShot: Readonly<{
    passRate: number;
    attempts: number;
    verifierCalls: number;
    falsePromotions: number;
    wallClockMs: number;
    tasks: readonly TaskMetrics[];
  }>;
  continuation: Readonly<{
    passRate: number;
    attempts: number;
    verifierCalls: number;
    suppressedVerifierCalls: number;
    exhaustedCorrectly: number;
    restartPassed: boolean;
    falsePromotions: number;
    wallClockMs: number;
    tasks: readonly TaskMetrics[];
  }>;
};

const tasks: readonly EvaluationTask[] = [
  {
    id: 'recoverable',
    outputs: ['bad', 'good'],
    verify: (output) =>
      output === 'good'
        ? { status: 'pass' }
        : { status: 'fail', failure: { code: 'incorrect' } },
    truth: (output) => output === 'good',
  },
  {
    id: 'no-benefit',
    outputs: ['good'],
    verify: () => ({ status: 'pass' }),
    truth: (output) => output === 'good',
  },
  {
    id: 'impossible',
    outputs: ['bad-1', 'bad-2', 'bad-3'],
    verify: () => ({
      status: 'fail',
      failure: { code: 'impossible', evidence: 'No valid solution exists' },
    }),
    truth: () => false,
  },
  {
    id: 'unchanged-state',
    outputs: ['same-bad'],
    verify: () => ({ status: 'fail', failure: { code: 'unchanged' } }),
    truth: () => false,
    fingerprint: () => 'state:unchanged',
  },
  {
    id: 'misleading-verifier',
    outputs: ['bad'],
    verify: () => ({ status: 'pass' }),
    truth: () => false,
  },
  {
    id: 'failing-verifier',
    outputs: ['good'],
    verify: () => {
      throw new Error('verifier unavailable');
    },
    truth: (output) => output === 'good',
  },
  {
    id: 'restart-recovery',
    outputs: ['bad', 'good'],
    verify: (output) =>
      output === 'good'
        ? { status: 'pass' }
        : { status: 'fail', failure: { code: 'retry_after_restart' } },
    truth: (output) => output === 'good',
    restart: true,
  },
];

async function evaluateTask(
  task: EvaluationTask,
  maxRuns: number,
  allowRestart: boolean
): Promise<TaskMetrics> {
  const durableRestart = allowRestart && Boolean(task.restart);
  const directory = durableRestart
    ? mkdtempSync(join(tmpdir(), 'ax-verifier-eval-'))
    : undefined;
  const filename = directory ? join(directory, 'event.sqlite') : undefined;
  let store: AxEventStore = filename
    ? new AxSQLiteEventStore({
        filename,
        retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
      })
    : new AxInMemoryEventStore();
  let attempts = 0;
  let verifierCalls = 0;
  let latestOutput = '';
  let promoted = false;
  let finalRunId = '';

  const createRuntime = () => {
    const signature = new AxSignature('goal:string -> answer:string');
    const program = {
      getId: () => `eval-${task.id}`,
      getSignature: () => signature,
      forward: async (_ai, _input, options) => {
        latestOutput =
          task.outputs[Math.min(attempts, task.outputs.length - 1)]!;
        attempts++;
        finalRunId = options?.eventContext?.runId ?? finalRunId;
        return { answer: latestOutput };
      },
      streamingForward: async function* () {},
    } as AxProgrammable<any, { answer: string }>;
    const target = eventTarget({
      id: `eval-${task.id}`,
      ai: {} as any,
      program,
      mapInput: () => ({ goal: task.id }),
      retrySafety: 'idempotent',
      verifier: {
        id: `host-${task.id}`,
        maxRuns,
        backoffMs: allowRestart && task.restart ? 25 : 0,
        fingerprint: task.fingerprint
          ? (output) => task.fingerprint!(output.answer)
          : undefined,
        verify: (output, context) => {
          verifierCalls++;
          finalRunId = context.run.id;
          return task.verify(output.answer);
        },
      },
      sinks: [
        {
          id: 'promotion',
          write: (_output, context) => {
            promoted = true;
            finalRunId = context.run.id;
          },
        },
      ],
    });
    return new AxEventRuntime({
      store,
      workerConcurrency: 1,
      routes: [
        eventRoute({
          id: `route-${task.id}`,
          match: { types: ['evaluation.task'] },
          action: 'wake',
          target,
        }),
      ],
    });
  };

  let runtime = createRuntime();
  await runtime.start();
  await runtime.publish({
    event: {
      specversion: '1.0',
      id: `event-${task.id}`,
      source: 'eval://host',
      type: 'evaluation.task',
      data: { task: task.id },
    },
  });
  if (allowRestart && task.restart) {
    while (verifierCalls < 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.close({ drain: false });
    store = new AxSQLiteEventStore({
      filename: filename!,
      retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtime = createRuntime();
    await runtime.start();
  }
  await runtime.waitForIdle();

  const finalRun: Readonly<AxEventRun> | undefined = finalRunId
    ? await runtime.getRun(finalRunId)
    : undefined;
  const finalStatus = finalRun?.verification?.status ?? 'error';
  const truthPassed = promoted && task.truth(latestOutput);
  await runtime.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  return {
    id: task.id,
    attempts,
    verifierCalls,
    promoted,
    truthPassed,
    falsePromotion: promoted && !task.truth(latestOutput),
    finalStatus,
    restarted: allowRestart && Boolean(task.restart),
  };
}

function summarize(tasks: readonly TaskMetrics[], wallClockMs: number) {
  return {
    passRate: tasks.filter((task) => task.truthPassed).length / tasks.length,
    attempts: tasks.reduce((sum, task) => sum + task.attempts, 0),
    verifierCalls: tasks.reduce((sum, task) => sum + task.verifierCalls, 0),
    falsePromotions: tasks.filter((task) => task.falsePromotion).length,
    wallClockMs: Number(wallClockMs.toFixed(2)),
    tasks,
  };
}

export async function runEventVerifierEvaluation(): Promise<EventVerifierEvaluationReport> {
  const oneShotStarted = performance.now();
  const oneShotTasks = [];
  for (const task of tasks) {
    oneShotTasks.push(await evaluateTask(task, 1, false));
  }
  const oneShot = summarize(oneShotTasks, performance.now() - oneShotStarted);

  const continuationStarted = performance.now();
  const continuationTasks = [];
  for (const task of tasks) {
    continuationTasks.push(await evaluateTask(task, 3, true));
  }
  const continuationBase = summarize(
    continuationTasks,
    performance.now() - continuationStarted
  );
  const unchanged = continuationTasks.find(
    (task) => task.id === 'unchanged-state'
  )!;
  return {
    taskCount: tasks.length,
    oneShot,
    continuation: {
      ...continuationBase,
      suppressedVerifierCalls: unchanged.attempts - unchanged.verifierCalls,
      exhaustedCorrectly: continuationTasks.filter(
        (task) =>
          (task.id === 'impossible' && task.finalStatus === 'exhausted') ||
          (task.id === 'unchanged-state' &&
            task.finalStatus === 'unchanged_state') ||
          (task.id === 'failing-verifier' && task.finalStatus === 'error')
      ).length,
      restartPassed:
        continuationTasks.find((task) => task.id === 'restart-recovery')
          ?.truthPassed ?? false,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(await runEventVerifierEvaluation(), null, 2));
}
