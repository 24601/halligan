/**
 * Deterministic, offline benchmark for verifier-gated working state.
 *
 * Domain: a warehouse order pipeline (`received → picked → packed → shipped`)
 * over K orders, driven by a scripted `AxMockAIService` and a stub
 * `AxCodeRuntime`. Zero API keys, zero cost, fully deterministic.
 *
 * READ THIS BEFORE QUOTING ANY NUMBER FROM HERE. This is MECHANISM evidence,
 * not model quality. The AI is a deterministic mock; the scenario is a state
 * machine, which is close to a best case for state-as-substrate; nothing here
 * is a held-out improvement claim or an independent evaluation. The proposer
 * is a deterministic host callback, so the arms make the SAME number of model
 * calls — a host using the built-in model-backed proposer pays one extra model
 * call per changed turn, which this benchmark does not and cannot measure.
 *
 * The one thing the harness is careful about: the scripted model decides what
 * to do by READING ITS PROMPT, never by asking which arm is running. A probe
 * turn is answered directly when the prompt already carries the answer, and
 * costs a state-recovery turn when it does not. That is what makes the
 * recovery-step column a measurement rather than an assumption.
 *
 * Internal benchmark helper — NOT exported from `src/ax/index.ts`.
 */

import { AxMockAIService } from '../../ai/mock/api.js';
import type { AxAIService } from '../../ai/types.js';
import { AxInMemoryProgramStateStore } from '../../event/memoryStore.js';
import { AxManualEventClock } from '../../event/types.js';
import {
  axCreateEvaluatingRuntime,
  axWorkingStateHarnessUsage,
} from '../agentInternal/workingStateHarness.js';
import type { AxAgentFunction } from '../index.js';
import { agent } from '../index.js';
import {
  type AxWorkingStateConfig,
  type AxWorkingStateGoal,
  type AxWorkingStateProposer,
  type AxWorkingStateTraceStep,
  axWorkingStateTraceDigest,
} from '../workingState.js';
import {
  type AxWorkingStateArm,
  type AxWorkingStateBenchRow,
  AxWorkingStatePromptMeter,
} from './workingStateMetrics.js';

/** Horizons the runnable evaluation sweeps. */
export const AX_WORKING_STATE_HORIZONS: readonly number[] = [10, 25, 50, 100];

/**
 * Horizons the in-suite vitest benchmark sweeps. Deliberately shorter than
 * the eval script's: this file runs inside `npm run test
 * --workspace=@ax-llm/ax` beside every other unit test, and a long sweep there
 * starves wall-clock-sensitive neighbors. The runnable evaluation
 * (`npm run agent:workingstate:eval`, guarded by
 * `scripts/eval-working-state.test.ts` in the root chain) sweeps the full set
 * out to horizon 100 in its own process.
 */
export const AX_WORKING_STATE_BENCH_HORIZONS: readonly number[] = [10, 25, 60];

/** The largest horizon the in-suite benchmark measures. */
export const AX_WORKING_STATE_BENCH_MAX_HORIZON = 60;

/** One probe every PROBE_PERIOD work turns. */
const PROBE_PERIOD = 5;
/** The turn index whose proposal is a receipt-free completion claim. */
const FALSE_COMPLETION_STEP = 2;

const DISTILLER_MARKER = 'You (`distiller`)';
const EXECUTOR_MARKER = 'You (`executor`)';

type Step =
  | Readonly<{ kind: 'pick'; order: number }>
  | Readonly<{ kind: 'probe'; order: number }>
  | Readonly<{ kind: 'final' }>;

function buildPlan(horizon: number): readonly Step[] {
  const steps: Step[] = [];
  let order = 0;
  for (let index = 0; index < horizon - 1; index++) {
    if (index > 0 && index % PROBE_PERIOD === PROBE_PERIOD - 1) {
      // Probe an order the run picked several turns ago.
      steps.push({ kind: 'probe', order: Math.max(0, order - 2) });
    } else {
      steps.push({ kind: 'pick', order });
      order += 1;
    }
  }
  steps.push({ kind: 'final' });
  return steps;
}

const pickFn: AxAgentFunction = {
  name: 'pick',
  description: 'Pick every line on an order',
  namespace: 'inventory',
  parameters: {
    type: 'object',
    properties: { order: { type: 'string', description: 'order id' } },
    required: ['order'],
  },
  func: async (args) => ({
    order: (args as { order: string }).order,
    status: 'picked',
  }),
};

function seedGoals(orderCount: number): Record<string, AxWorkingStateGoal> {
  const goals: Record<string, AxWorkingStateGoal> = {};
  for (let index = 0; index < orderCount; index++) {
    goals[`g_o${index}`] = {
      id: `g_o${index}`,
      goal: `Pick order o${index}`,
      status: 'pending',
      evidence: [],
      expects: ['inventory.pick'],
      createdTurn: 0,
      updatedTurn: 0,
    };
  }
  // One goal no tool in this scenario can ever satisfy. It is what the
  // scripted false completion claims, and what keeps the interlock arm with
  // something genuinely pending at the end of the run.
  goals.g_audit = {
    id: 'g_audit',
    goal: 'Audit the warehouse count',
    status: 'pending',
    evidence: [],
    expects: ['inventory.audit'],
    createdTurn: 0,
    updatedTurn: 0,
  };
  return goals;
}

/**
 * The deterministic host proposer. It reads the receipt roster and the turn's
 * observation and proposes exactly what the environment proved — plus, on one
 * scripted turn, a receipt-free completion claim, so the gate has something
 * real to refuse.
 */
function buildProposer(): AxWorkingStateProposer {
  let calls = 0;
  return async (input) => {
    calls += 1;
    if (calls === FALSE_COMPLETION_STEP) {
      // A completion claim with no receipt cited at all: the kernel must park
      // it regardless of what any checker says.
      return {
        statePatch: [
          { op: 'replace', path: '/goals/g_audit/status', value: 'done' },
        ],
      };
    }
    const observed = /"order":"(o\d+)","status":"picked"/.exec(
      input.observation
    );
    if (!observed) return { statePatch: [] };
    const orderId = observed[1]!;
    const goalId = `g_${orderId}`;
    const ref = /^(r\d+)\s+inventory\.pick\s/m.exec(input.receiptRoster)?.[1];
    const refs = input.receiptRoster
      .split('\n')
      .map((line) => /^(r\d+)\s+inventory\.pick\s+turn (\d+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    const newest = refs[0]?.[1] ?? ref;
    if (!newest) return { statePatch: [] };
    return {
      statePatch: [
        { op: 'add', path: `/facts/orders/${orderId}`, value: 'picked' },
        {
          op: 'add',
          path: `/goals/${goalId}/evidence/-`,
          value: { kind: 'tool_receipt', ref: newest },
        },
        { op: 'replace', path: `/goals/${goalId}/status`, value: 'done' },
      ],
      rationale: `receipt ${newest} proves ${orderId} was picked`,
    };
  };
}

type MockOutcome = {
  ai: AxAIService;
  modelCalls: () => number;
  stateRecoverySteps: () => number;
  probesAnswered: () => number;
  probesCorrect: () => number;
  sentPromptChars: () => readonly number[];
};

/**
 * The scripted model. On a probe turn it looks for the answer IN ITS PROMPT:
 * a rendered fact wins immediately; otherwise it spends one recovery turn
 * re-reading the action log, and answers from whatever survived compaction.
 */
function buildScenarioMock(plan: readonly Step[]): MockOutcome {
  let executorStep = 0;
  let modelCalls = 0;
  let recoverySteps = 0;
  let probesAnswered = 0;
  let probesCorrect = 0;
  let recovering: number | undefined;
  const sentPromptChars: number[] = [];

  const ai = new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      modelCalls += 1;
      const chatPrompt = req.chatPrompt as readonly {
        role: string;
        content?: unknown;
      }[];
      const rendered = chatPrompt
        .map((message) =>
          typeof message.content === 'string' ? message.content : ''
        )
        .join('');
      const systemPrompt =
        typeof chatPrompt[0]?.content === 'string' ? chatPrompt[0].content : '';

      if (systemPrompt.includes(DISTILLER_MARKER)) {
        return {
          results: [
            {
              index: 0,
              content:
                'Javascript Code: await final("distilled", {"evidence":"orders"})',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: axWorkingStateHarnessUsage(),
        };
      }
      if (!systemPrompt.includes(EXECUTOR_MARKER)) {
        return {
          results: [
            {
              index: 0,
              content: 'Answer: done',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: axWorkingStateHarnessUsage(),
        };
      }

      sentPromptChars.push(rendered.length);
      const step = plan[Math.min(executorStep, plan.length - 1)]!;
      let code: string;

      if (step.kind === 'pick') {
        executorStep += 1;
        // Logged, so the pick result is genuinely in the observation (and
        // therefore in the action log the baseline has to fall back on).
        code = `console.log(JSON.stringify(await inventory.pick({order:"o${step.order}"})))`;
      } else if (step.kind === 'final') {
        executorStep += 1;
        code = 'await final("done", {"answer":"all orders handled"})';
      } else {
        const orderId = `o${step.order}`;
        const factHit = rendered.includes(`"${orderId}":"picked"`);
        if (factHit) {
          // The state document already carries the answer: no recovery needed.
          executorStep += 1;
          probesAnswered += 1;
          probesCorrect += 1;
          recovering = undefined;
          code = `console.log("status of ${orderId} is picked")`;
        } else if (recovering !== step.order) {
          // One turn spent re-deriving what the run already knew.
          recovering = step.order;
          recoverySteps += 1;
          code = `console.log("re-reading the action log for ${orderId}")`;
        } else {
          executorStep += 1;
          probesAnswered += 1;
          // Whatever survived trajectory compaction is all there is to go on.
          const logHit = rendered.includes(
            `"order":"${orderId}","status":"picked"`
          );
          if (logHit) probesCorrect += 1;
          recovering = undefined;
          code = `console.log("status of ${orderId} is ${
            logHit ? 'picked' : 'unknown'
          }")`;
        }
      }

      return {
        results: [
          {
            index: 0,
            content: `Javascript Code: ${code}`,
            finishReason: 'stop' as const,
          },
        ],
        modelUsage: axWorkingStateHarnessUsage(),
      };
    },
  });

  return {
    ai: ai as unknown as AxAIService,
    modelCalls: () => modelCalls,
    stateRecoverySteps: () => recoverySteps,
    probesAnswered: () => probesAnswered,
    probesCorrect: () => probesCorrect,
    sentPromptChars: () => sentPromptChars,
  };
}

export type AxWorkingStateScenarioResult = Readonly<{
  row: AxWorkingStateBenchRow;
  traceDigests: readonly string[];
  /** For the measured-equals-sent assertion: one turn's three numbers. */
  promptCheck?: Readonly<{
    measuredMutableChars: number;
    measuredFixedChars: number;
    sentTotalChars: number;
  }>;
  interlocksConverted: number;
  goalStatuses: Readonly<Record<string, string>>;
}>;

/** Run one horizon under one arm. Deterministic and zero-cost. */
export async function runWorkingStateScenario(
  horizon: number,
  arm: AxWorkingStateArm,
  options?: Readonly<{ completionPolicy?: 'observe' | 'interlock' }>
): Promise<AxWorkingStateScenarioResult> {
  const plan = buildPlan(horizon);
  const orderCount = plan.filter((step) => step.kind === 'pick').length;
  const mock = buildScenarioMock(plan);
  const meter = new AxWorkingStatePromptMeter();
  const traces: AxWorkingStateTraceStep[] = [];
  let interlocksConverted = 0;

  const workingState: AxWorkingStateConfig<{ orders: Record<string, string> }> =
    {
      stateSignature: 'orders:json',
      clock: new AxManualEventClock(1_000),
      store: new AxInMemoryProgramStateStore(),
      runIdFactory: () => 'ws:bench:1',
      initial: { goals: seedGoals(orderCount), facts: { orders: {} } },
      proposer: 'on-change',
      proposeWith: buildProposer(),
      receiptSources: ['inventory.pick'],
      maxRenderChars: 6_000,
      ...(options?.completionPolicy
        ? { completionPolicy: options.completionPolicy }
        : {}),
      checker: { id: 'bench-noop', check: () => ({ status: 'pass' }) },
      trace: true,
      onTrace: (step) => {
        traces.push(step);
        if (step.completionInterlock === 'converted') interlocksConverted += 1;
      },
    };

  const built = agent('task:string -> answer:string', {
    functions: [pickFn],
    runtime: axCreateEvaluatingRuntime(),
    // Recovery turns and interlock re-prompts both cost extra turns.
    maxTurns: horizon * 2 + 8,
    contextPolicy: { preset: 'adaptive', budget: 'compact' },
    onContextEvent: meter.onEvent,
    ...(arm === 'working-state' ? { workingState } : {}),
  });

  await built.forward(mock.ai, {
    task: `Pick every order from o0 to o${Math.max(0, orderCount - 1)} and report progress.`,
  } as never);

  const usage = built.getUsage();
  const cumulativeTokens = [...usage.actor, ...usage.responder].reduce(
    (total, entry) => total + (entry.tokens?.totalTokens ?? 0),
    0
  );
  const document = built.getWorkingState();
  const goalStatuses: Record<string, string> = {};
  for (const [id, goal] of Object.entries(document?.goals ?? {})) {
    goalStatuses[id] = goal.status;
  }
  const falseCompletionsParked = traces.reduce(
    (total, step) =>
      total +
      step.parked.filter((reason) => reason === 'no_supporting_receipt').length,
    0
  );
  const probes = mock.probesAnswered();

  // Measured-equals-sent: compare one turn's budget_check against the prompt
  // the mock actually received for that same turn.
  const checkIndex = Math.min(1, meter.samples() - 1);
  const measuredMutableChars = meter.mutableAt(checkIndex);
  const measuredTotalChars = meter.totalAt(checkIndex);
  const sentTotalChars = mock.sentPromptChars()[checkIndex];

  return {
    row: {
      horizon,
      arm,
      turns: meter.samples(),
      modelCalls: mock.modelCalls(),
      cumulativeTokens,
      peakPromptChars: meter.peak(),
      meanPromptCharsPerTurn: meter.mean(),
      stateRecoverySteps: mock.stateRecoverySteps(),
      goalsCompleted: Object.values(goalStatuses).filter(
        (status) => status === 'done'
      ).length,
      falseCompletionsParked,
      accuracy: probes === 0 ? 1 : mock.probesCorrect() / probes,
    },
    traceDigests: await Promise.all(traces.map(axWorkingStateTraceDigest)),
    ...(measuredMutableChars !== undefined &&
    measuredTotalChars !== undefined &&
    sentTotalChars !== undefined
      ? {
          promptCheck: {
            measuredMutableChars,
            measuredFixedChars: measuredTotalChars - measuredMutableChars,
            sentTotalChars,
          },
        }
      : {}),
    interlocksConverted,
    goalStatuses,
  };
}

/** Run every horizon under both arms. */
export async function runWorkingStateSweep(
  horizons: readonly number[] = AX_WORKING_STATE_HORIZONS
): Promise<readonly AxWorkingStateScenarioResult[]> {
  const results: AxWorkingStateScenarioResult[] = [];
  for (const horizon of horizons) {
    for (const arm of ['baseline', 'working-state'] as const) {
      results.push(await runWorkingStateScenario(horizon, arm));
    }
  }
  return results;
}
