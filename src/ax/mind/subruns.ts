import type {
  AxAgentSessionHost,
  AxAgentSessionLimits,
} from '../agent/retainedSessions.js';
import type { AxEventClock } from '../event/types.js';
import type { AxTrajectoryStore } from '../trajectory/types.js';
import {
  AxMindBudgetExceededError,
  type AxMindThinkerBudget,
} from './types.js';

const DEFAULT_POLL_MS = 25;
/**
 * A poll ceiling, because an injected clock never advances on its own: without
 * it a child that never terminates would spin this loop for the process
 * lifetime instead of failing with a budget a host can read.
 */
export const axMindMaxSubRunPolls = 10_000;

export interface AxMindSubRunRequest<OUT> {
  readonly registrationKey: string;
  readonly input: unknown;
  readonly slug?: string;
  readonly limits?: Partial<AxAgentSessionLimits>;
  readonly summarize?: (output: OUT) => string;
}

export interface AxMindSubRunResult<OUT> {
  readonly childTrajectoryId: string;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly output?: OUT;
  readonly mergeStepId: string;
}

export interface AxMindSubRunOptions<OUT> {
  readonly store: AxTrajectoryStore;
  readonly trajectoryId: string;
  readonly clock: AxEventClock;
  readonly budget: Readonly<AxMindThinkerBudget>;
  /** Sub-runs already admitted for the thinker whose step is running. */
  readonly spent: number;
  readonly sessions?: AxAgentSessionHost;
  readonly pollMs?: number;
  readonly request: Readonly<AxMindSubRunRequest<OUT>>;
}

/**
 * Fork a child trajectory, run it under the tree budget, and ALWAYS merge
 * something back -- success, failure or cancellation (I10). A sub-run that
 * merges nothing is invisible in the parent's life, which is how a whole
 * branch of work disappears from a mind's own history.
 */
export async function axMindSubRun<OUT>(
  options: Readonly<AxMindSubRunOptions<OUT>>,
  signal?: AbortSignal
): Promise<Readonly<AxMindSubRunResult<OUT>>> {
  const { store, trajectoryId, budget, request } = options;
  if (options.spent >= budget.maxSubRuns) {
    throw new AxMindBudgetExceededError('subRuns', budget.maxSubRuns);
  }
  const header = await store.getTrajectory(trajectoryId, signal);
  if ((header?.depth ?? 0) >= budget.maxDepth) {
    throw new AxMindBudgetExceededError('depth', budget.maxDepth);
  }
  const fork = await store.fork(
    {
      parentTrajectoryId: trajectoryId,
      maxDepth: budget.maxDepth,
      ...(request.slug ? { slug: request.slug } : {}),
    },
    signal
  );
  let outcome: AxMindSubRunResult<OUT>['outcome'] = 'failed';
  let output: OUT | undefined;
  let content = '(no sub-run host configured)';
  try {
    if (!options.sessions) throw new Error('no AxAgentSessionHost configured');
    output = await runChild(options, signal);
    outcome = 'succeeded';
    content = request.summarize
      ? request.summarize(output)
      : JSON.stringify(output);
  } catch (error) {
    outcome = signal?.aborted ? 'cancelled' : 'failed';
    content = `(${outcome}: ${String(error)})`;
  }
  const merge = await store.merge(
    {
      parentTrajectoryId: trajectoryId,
      childTrajectoryId: fork.childTrajectoryId,
      content,
      outcome,
    },
    signal
  );
  return Object.freeze({
    childTrajectoryId: fork.childTrajectoryId,
    outcome,
    ...(output !== undefined ? { output } : {}),
    mergeStepId: merge.stepId,
  });
}

async function runChild<OUT>(
  options: Readonly<AxMindSubRunOptions<OUT>>,
  signal?: AbortSignal
): Promise<OUT> {
  const { request } = options;
  const root = await options.sessions!.createRoot({
    authorizedChildren: [request.registrationKey],
    ...(request.limits ? { limits: request.limits } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  });
  const handle = await root.spawn(request.registrationKey, request.input);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  for (let poll = 0; poll < axMindMaxSubRunPolls; poll++) {
    const view = await root.inspect(handle);
    if (view.status === 'completed') {
      return (await root.result(handle)) as OUT;
    }
    if (view.status === 'failed' || view.status === 'cancelled') {
      throw new Error(view.lastError ?? `sub-run ${view.status}`);
    }
    await options.clock.sleep(pollMs, signal);
  }
  throw new AxMindBudgetExceededError('wallClock', axMindMaxSubRunPolls);
}
