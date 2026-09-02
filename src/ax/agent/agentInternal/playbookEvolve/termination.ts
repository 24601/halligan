/**
 * Trajectory termination classification and per-attempt evidence records for
 * `agent.playbook().evolve()`.
 *
 * Three rules this module exists to enforce:
 *  1. Ax never infers an environment failure. The default classifier calls
 *     everything that is not a clean final completion a `policy_failure`,
 *     because a program that reliably drives a tool into a timeout IS worse and
 *     must not be laundered out of the score denominator.
 *  2. Error identity is read STRUCTURALLY (`error.name`, a bounded
 *     `error.cause` walk, `error.code`), never with `instanceof` — the same
 *     cross-realm rule the event runtime's guards follow.
 *  3. One attempt is one vote. Call, turn and token counts are recorded on the
 *     attempt record and never weight a score.
 */

import type { AxProgramUsage } from '../../../dsp/types.js';
import type { AxAgentEvalPrediction } from '../agentOptimizeTypes.js';
import type {
  AxAgentEnvironmentFailureCause,
  AxAgentPlaybookAttemptRecord,
  AxAgentPlaybookModelIdentity,
  AxAgentPlaybookSplitName,
  AxAgentPlaybookTerminationReport,
  AxAgentPlaybookTerminationSplit,
  AxAgentTrajectoryClassifier,
  AxAgentTrajectoryTermination,
} from './playbookEvidenceTypes.js';
import { AxAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';

const MAX_IDENTITY_LENGTH = 200;
/** How deep the `cause` chain is walked for an error name. Bounded on purpose. */
const MAX_CAUSE_DEPTH = 3;

const COMPLETED: AxAgentTrajectoryTermination = Object.freeze({
  kind: 'completed' as const,
});
const POLICY_FAILURE: AxAgentTrajectoryTermination = Object.freeze({
  kind: 'policy_failure' as const,
});

function truncate(value: string): string {
  return value.length > MAX_IDENTITY_LENGTH
    ? value.slice(0, MAX_IDENTITY_LENGTH)
    : value;
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0
    ? truncate(value)
    : undefined;
}

/** Structural error identity. No `instanceof`; the cause walk is depth-bounded. */
export type AxErrorIdentity = {
  errorName?: string;
  errorCauseName?: string;
  errorCode?: string;
};

export function extractErrorIdentity(error: unknown): AxErrorIdentity {
  if (!error || typeof error !== 'object') return {};
  const identity: AxErrorIdentity = {};
  const name = readString(error, 'name');
  if (name !== undefined) identity.errorName = name;
  const code = readString(error, 'code');
  if (code !== undefined) identity.errorCode = code;

  // The generate path wraps non-validation errors in AxGenerateError with the
  // original as `cause`, so the assertion identity can be one or more levels
  // down. Stop at MAX_CAUSE_DEPTH: a self-referential cause must not hang.
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!cause || typeof cause !== 'object') break;
    const causeName = readString(cause, 'name');
    if (causeName !== undefined) {
      identity.errorCauseName = causeName;
      break;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return identity;
}

/** Names that identify an assertion failure, on either the error or its cause. */
export const AX_ASSERTION_ERROR_NAMES: readonly string[] = [
  'AxAssertionError',
  'AxStreamingAssertionError',
];

export function isAssertionAttempt(
  attempt: Readonly<
    Pick<AxAgentPlaybookAttemptRecord, 'errorName' | 'errorCauseName'>
  >
): boolean {
  return (
    (attempt.errorName !== undefined &&
      AX_ASSERTION_ERROR_NAMES.includes(attempt.errorName)) ||
    (attempt.errorCauseName !== undefined &&
      AX_ASSERTION_ERROR_NAMES.includes(attempt.errorCauseName))
  );
}

/**
 * Ax's default, deliberately conservative classification: only a prediction
 * that reached `completionType: 'final'` with no error counts as completed.
 * Everything else — a throw, an `askClarification`, a non-finite metric — is a
 * policy failure and stays in the denominator.
 */
export function defaultTerminationOf(args: {
  prediction?: Readonly<AxAgentEvalPrediction<any>>;
  error?: unknown;
  validScore: boolean;
}): AxAgentTrajectoryTermination {
  if (
    args.error === undefined &&
    args.validScore &&
    args.prediction?.completionType === 'final'
  ) {
    return COMPLETED;
  }
  return POLICY_FAILURE;
}

const ENVIRONMENT_CAUSE_BY_ERROR_NAME: Readonly<
  Record<string, AxAgentEnvironmentFailureCause>
> = Object.freeze({
  AxAIServiceTimeoutError: 'timeout',
  AxAIServiceNetworkError: 'network',
});

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Opt-in classifier mapping Ax's OWN typed transport errors to environment
 * failures. Structural (by `name` and a numeric `status`), so it works across
 * package realms. Not the default: a caller that wants provider hiccups out of
 * the denominator has to say so.
 */
export const axClassifyAxServiceTermination: AxAgentTrajectoryClassifier = (
  args
) => {
  const names = [args.errorName, args.errorCauseName].filter(
    (name): name is string => typeof name === 'string'
  );
  for (const name of names) {
    const cause = ENVIRONMENT_CAUSE_BY_ERROR_NAME[name];
    if (cause) return { kind: 'environment_failure', cause };
    if (name === 'AxAIServiceStatusError') {
      const status =
        statusOf(args.error) ??
        statusOf((args.error as { cause?: unknown })?.cause);
      if (status === 429) {
        return { kind: 'environment_failure', cause: 'provider_rate_limit' };
      }
      if (status !== undefined && status >= 500) {
        return { kind: 'environment_failure', cause: 'provider_unavailable' };
      }
    }
  }
  return undefined;
};

/** Sum of `AxTokenUsage.totalTokens`. `undefined` when nothing reported usage. */
export function totalTokensOf(
  usage: readonly AxProgramUsage[] | undefined
): number | undefined {
  if (!usage?.length) return undefined;
  let total = 0;
  let observed = false;
  for (const entry of usage) {
    const tokens = entry?.tokens?.totalTokens;
    if (typeof tokens === 'number' && Number.isFinite(tokens)) {
      total += tokens;
      observed = true;
    }
  }
  return observed ? total : undefined;
}

export function modelIdentityOf(
  usage: readonly AxProgramUsage[] | undefined
): AxAgentPlaybookModelIdentity | undefined {
  const first = usage?.find(
    (entry) => typeof entry?.ai === 'string' && typeof entry?.model === 'string'
  );
  return first ? { ai: first.ai, model: first.model } : undefined;
}

/**
 * Run the host classifier, defaulting to `policy_failure` when it returns
 * `undefined`. A classifier that throws is a configuration bug, not a verdict:
 * it decides the score denominator, so it fails the run closed.
 */
export function classifyAttempt(args: {
  classifier?: AxAgentTrajectoryClassifier<any, any>;
  classifierArgs: Parameters<AxAgentTrajectoryClassifier<any, any>>[0];
  fallback: AxAgentTrajectoryTermination;
}): AxAgentTrajectoryTermination {
  if (!args.classifier) return args.fallback;
  let verdict: AxAgentTrajectoryTermination | undefined;
  try {
    verdict = args.classifier(args.classifierArgs);
  } catch (err) {
    throw new AxAgentPlaybookEvolveError(
      'classifier_invalid',
      'candidate_eval',
      'classifyTermination threw; a classifier that cannot classify must return undefined.',
      { cause: err }
    );
  }
  if (verdict === undefined) return args.fallback;
  if (
    verdict.kind !== 'completed' &&
    verdict.kind !== 'policy_failure' &&
    verdict.kind !== 'environment_failure'
  ) {
    throw new AxAgentPlaybookEvolveError(
      'classifier_invalid',
      'candidate_eval',
      `classifyTermination returned an unknown termination kind ${JSON.stringify((verdict as { kind?: unknown }).kind)}.`
    );
  }
  return verdict;
}

/** Per-split counters the harness accumulates while it runs. */
export type AxAgentPlaybookTerminationTally = {
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  completed: number;
  policyFailures: number;
  environmentFailures: number;
  redraws: number;
  tasksWithNoScoredAttempt: number;
  expectedRuns: number;
  causes: Map<AxAgentEnvironmentFailureCause, number>;
};

export function createTerminationTally(
  split: AxAgentPlaybookSplitName,
  expectedRuns: number,
  sliceName?: string
): AxAgentPlaybookTerminationTally {
  return {
    split,
    ...(sliceName ? { sliceName } : {}),
    completed: 0,
    policyFailures: 0,
    environmentFailures: 0,
    redraws: 0,
    tasksWithNoScoredAttempt: 0,
    expectedRuns,
    causes: new Map(),
  };
}

export function tallyTermination(
  tally: AxAgentPlaybookTerminationTally,
  termination: AxAgentTrajectoryTermination
): void {
  if (termination.kind === 'completed') {
    tally.completed++;
    return;
  }
  if (termination.kind === 'policy_failure') {
    tally.policyFailures++;
    return;
  }
  tally.environmentFailures++;
  tally.causes.set(
    termination.cause,
    (tally.causes.get(termination.cause) ?? 0) + 1
  );
}

export function terminationSplitOf(
  tally: Readonly<AxAgentPlaybookTerminationTally>
): AxAgentPlaybookTerminationSplit {
  return {
    split: tally.split,
    ...(tally.sliceName ? { sliceName: tally.sliceName } : {}),
    completed: tally.completed,
    policyFailures: tally.policyFailures,
    environmentFailures: tally.environmentFailures,
    discardRate:
      tally.expectedRuns > 0
        ? tally.environmentFailures / tally.expectedRuns
        : 0,
    redraws: tally.redraws,
    tasksWithNoScoredAttempt: tally.tasksWithNoScoredAttempt,
    causes: [...tally.causes.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([cause, count]) => ({ cause, count })),
  };
}

export function terminationReportOf(
  splits: readonly AxAgentPlaybookTerminationSplit[]
): AxAgentPlaybookTerminationReport {
  return {
    splits,
    worstDiscardRate: splits.reduce(
      (worst, split) => Math.max(worst, split.discardRate),
      0
    ),
    incompleteFromEnvironmentFailures: splits.some(
      (split) => split.tasksWithNoScoredAttempt > 0
    ),
  };
}
