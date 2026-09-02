/**
 * Validity conjuncts for `agent.playbook().evolve()`.
 *
 * The accept decision compares mean scores. A candidate can raise the mean
 * while stalling more episodes, calling functions that do not exist, or driving
 * more tool errors — the harness's `passed` flag ANDs completion into the score
 * threshold and therefore HIDES exactly that. These predicates are evaluated
 * independently, on both splits, and ANDed into the gate.
 *
 * Two rules the implementation must keep:
 *  - `tool_error_rate` is a RATE. `prediction.toolErrors` is derived from
 *    `prediction.functionCalls` by the eval pipeline, so summing both counts
 *    every failing call twice and produces values above 1.0. Each failing call
 *    is counted once; a prediction-level entry with no matching call is counted
 *    once and widens the denominator too.
 *  - `unknown_function_call_rate` and `tool_error_rate` are computed IN AX.
 *    `classifyFunctionCall` is an override, not the source: a host classifier
 *    that returns 'ok' for everything would otherwise be a laundering surface.
 *    When it changes a computed value the predicate records
 *    `overriddenByHost: true`, so the substitution is visible on the receipt.
 *  - A predicate Ax cannot observe is `unmeasured`, never `pass`. Under a
 *    `require` gate that fails closed.
 */

import type { AxAgentEvalFunctionCall } from '../agentOptimizeTypes.js';
import type {
  AxAgentPlaybookSplitName,
  AxAgentPlaybookValidityOptions,
  AxAgentPlaybookValidityPredicate,
  AxAgentPlaybookValidityPredicateId,
  AxAgentPlaybookValidityReport,
} from './playbookEvidenceTypes.js';
import type { AxAgentPlaybookEvolveRunRecord } from './playbookEvolveTypes.js';
import { isAssertionAttempt } from './termination.js';

export const DEFAULT_MIN_FINAL_COMPLETION_RATE = 0.9;
export const DEFAULT_MIN_ASSERTION_PASS_RATE = 1;
export const DEFAULT_MAX_UNKNOWN_FUNCTION_CALL_RATE = 0;

/** Declaration order. `failed` names the FIRST failing predicate in this order. */
const PREDICATE_ORDER: readonly AxAgentPlaybookValidityPredicateId[] = [
  'final_completion_rate',
  'assertion_pass_rate',
  'unknown_function_call_rate',
  'tool_error_rate',
  'token_ceiling',
  'latency_ceiling',
];

export type AxValiditySplitInput = Readonly<{
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  records: readonly AxAgentPlaybookEvolveRunRecord<any, any>[];
}>;

export function validityPredicateName(
  id: AxAgentPlaybookValidityPredicateId,
  split: AxAgentPlaybookSplitName,
  sliceName?: string
): string {
  return `validity:${id}@${split}${sliceName ? `#${sliceName}` : ''}`;
}

/**
 * Structural, defensive read of the agent's registered function set. Returns
 * `undefined` when it cannot be determined — which makes
 * `unknown_function_call_rate` `unmeasured` rather than silently passing every
 * call as known.
 */
export function registeredFunctionNames(
  agent: unknown
): ReadonlySet<string> | undefined {
  const functions = (agent as { options?: { functions?: unknown } })?.options
    ?.functions;
  if (!Array.isArray(functions) || functions.length === 0) return undefined;
  const names = new Set<string>();
  for (const entry of functions) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; namespace?: unknown };
    if (typeof record.name !== 'string' || record.name.length === 0) continue;
    names.add(record.name);
    if (typeof record.namespace === 'string' && record.namespace.length > 0) {
      names.add(`${record.namespace}.${record.name}`);
    }
  }
  return names.size > 0 ? names : undefined;
}

type Counters = {
  attempts: number;
  assertionFailures: number;
  attemptsWithIdentity: number;
  predictions: number;
  finalPredictions: number;
  calls: number;
  unknownCalls: number;
  toolErrors: number;
  /** Prediction-level tool errors with no matching function call. */
  unmatchedToolErrors: number;
  overriddenUnknown: boolean;
  overriddenToolError: boolean;
  tokenAttempts: number;
  tokenTotal: number;
  latencyAttempts: number;
  latencyTotal: number;
};

function countSplit(
  input: AxValiditySplitInput,
  options: Readonly<AxAgentPlaybookValidityOptions> | undefined,
  registered: ReadonlySet<string> | undefined
): Counters {
  const counters: Counters = {
    attempts: 0,
    assertionFailures: 0,
    attemptsWithIdentity: 0,
    predictions: 0,
    finalPredictions: 0,
    calls: 0,
    unknownCalls: 0,
    toolErrors: 0,
    unmatchedToolErrors: 0,
    overriddenUnknown: false,
    overriddenToolError: false,
    tokenAttempts: 0,
    tokenTotal: 0,
    latencyAttempts: 0,
    latencyTotal: 0,
  };
  for (const record of input.records) {
    // `pipelineForwardForEvaluation` derives `prediction.toolErrors` from this
    // record's own function calls as `${qualifiedName}: ${error}`. Seeding the
    // set from EVERY errored call (not only the ones the verdict counted) keeps
    // a host classifier's `'ok'` override authoritative instead of letting the
    // derived string reinstate the failure it suppressed.
    const derivedToolErrors = new Set<string>();
    for (const call of record.prediction?.functionCalls ?? []) {
      if (!call?.error) continue;
      derivedToolErrors.add(
        `${call.qualifiedName}: ${call.error ?? 'unknown error'}`
      );
    }
    counters.predictions++;
    if (record.prediction?.completionType === 'final') {
      counters.finalPredictions++;
    }
    for (const attempt of record.attempts ?? []) {
      if (attempt.termination.kind === 'environment_failure') continue;
      counters.attempts++;
      counters.attemptsWithIdentity++;
      if (isAssertionAttempt(attempt)) counters.assertionFailures++;
      if (attempt.totalTokens !== undefined) {
        counters.tokenAttempts++;
        counters.tokenTotal += attempt.totalTokens;
      }
      counters.latencyAttempts++;
      counters.latencyTotal += attempt.latencyMs;
    }
    for (const call of record.prediction?.functionCalls ?? []) {
      counters.calls++;
      const computed = classifyCall(call, registered);
      const hostVerdict = options?.classifyFunctionCall?.(call);
      const verdict = hostVerdict ?? computed;
      if (hostVerdict !== undefined && hostVerdict !== computed) {
        if (
          computed === 'unknown_function' ||
          hostVerdict === 'unknown_function'
        ) {
          counters.overriddenUnknown = true;
        }
        if (computed === 'tool_error' || hostVerdict === 'tool_error') {
          counters.overriddenToolError = true;
        }
      }
      if (verdict === 'unknown_function') counters.unknownCalls++;
      if (verdict === 'tool_error') counters.toolErrors++;
    }
    // A prediction-level tool error with no corresponding function call cannot
    // arise from the ax pipeline today, but a host-built prediction may carry
    // one. Counted once, structurally de-duplicated against the calls above,
    // and it widens the denominator so the result stays a rate.
    const countedToolErrors = new Set<string>();
    for (const entry of record.prediction?.toolErrors ?? []) {
      if (typeof entry !== 'string') continue;
      if (derivedToolErrors.has(entry)) continue;
      if (countedToolErrors.has(entry)) continue;
      countedToolErrors.add(entry);
      counters.toolErrors++;
      counters.unmatchedToolErrors++;
    }
  }
  return counters;
}

function classifyCall(
  call: Readonly<AxAgentEvalFunctionCall>,
  registered: ReadonlySet<string> | undefined
): 'ok' | 'unknown_function' | 'tool_error' {
  if (typeof call.error === 'string' && call.error.length > 0) {
    return 'tool_error';
  }
  if (registered && !registered.has(call.qualifiedName)) {
    return 'unknown_function';
  }
  return 'ok';
}

function predicate(args: {
  id: AxAgentPlaybookValidityPredicateId;
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  observed?: number;
  threshold: number;
  /** 'min' passes at or above the threshold; 'max' passes at or below it. */
  direction: 'min' | 'max';
  overriddenByHost?: boolean;
}): AxAgentPlaybookValidityPredicate {
  const measurable = args.observed !== undefined;
  const passes =
    measurable &&
    (args.direction === 'min'
      ? args.observed! >= args.threshold
      : args.observed! <= args.threshold);
  return {
    id: args.id,
    split: args.split,
    ...(args.sliceName ? { sliceName: args.sliceName } : {}),
    status: measurable ? (passes ? 'pass' : 'fail') : 'unmeasured',
    ...(measurable ? { observed: args.observed } : {}),
    threshold: args.threshold,
    ...(args.overriddenByHost ? { overriddenByHost: true } : {}),
    name: validityPredicateName(args.id, args.split, args.sliceName),
  };
}

export function evaluateValidity(args: {
  inputs: readonly AxValiditySplitInput[];
  options?: Readonly<AxAgentPlaybookValidityOptions>;
  registered?: ReadonlySet<string>;
}): AxAgentPlaybookValidityReport {
  const options = args.options;
  const predicates: AxAgentPlaybookValidityPredicate[] = [];
  const configured = new Set<AxAgentPlaybookValidityPredicateId>([
    'final_completion_rate',
    'assertion_pass_rate',
    'unknown_function_call_rate',
  ]);
  if (options?.maxToolErrorRate !== undefined)
    configured.add('tool_error_rate');
  if (options?.maxMeanTotalTokens !== undefined)
    configured.add('token_ceiling');
  if (options?.maxMeanLatencyMs !== undefined)
    configured.add('latency_ceiling');

  for (const input of args.inputs) {
    const counters = countSplit(input, options, args.registered);
    const scope = {
      split: input.split,
      ...(input.sliceName ? { sliceName: input.sliceName } : {}),
    } as const;

    predicates.push(
      predicate({
        ...scope,
        // Per RECORD, not per attempt: `completionType` lives on
        // `AxAgentEvalPrediction` and an attempt record carries no such field,
        // so at `runsPerTask > 1` this reads the surviving prediction for each
        // task. Named `final_completion_rate` for exactly what it measures.
        id: 'final_completion_rate',
        ...(counters.predictions > 0
          ? { observed: counters.finalPredictions / counters.predictions }
          : {}),
        threshold:
          options?.minFinalCompletionRate ?? DEFAULT_MIN_FINAL_COMPLETION_RATE,
        direction: 'min',
      })
    );
    predicates.push(
      predicate({
        ...scope,
        id: 'assertion_pass_rate',
        // Needs attempt records: without them there is no structural error
        // identity to read, so the predicate is unmeasured rather than 1.0.
        ...(counters.attemptsWithIdentity > 0
          ? {
              observed:
                1 - counters.assertionFailures / counters.attemptsWithIdentity,
            }
          : {}),
        threshold:
          options?.minAssertionPassRate ?? DEFAULT_MIN_ASSERTION_PASS_RATE,
        direction: 'min',
      })
    );
    predicates.push(
      predicate({
        ...scope,
        id: 'unknown_function_call_rate',
        // Unmeasured when the registered function set could not be resolved
        // AND no host classifier supplied a verdict — never assumed clean.
        ...(counters.calls > 0 &&
        (args.registered !== undefined ||
          options?.classifyFunctionCall !== undefined)
          ? { observed: counters.unknownCalls / counters.calls }
          : counters.calls === 0
            ? { observed: 0 }
            : {}),
        threshold:
          options?.maxUnknownFunctionCallRate ??
          DEFAULT_MAX_UNKNOWN_FUNCTION_CALL_RATE,
        direction: 'max',
        ...(counters.overriddenUnknown ? { overriddenByHost: true } : {}),
      })
    );
    if (configured.has('tool_error_rate')) {
      predicates.push(
        predicate({
          ...scope,
          id: 'tool_error_rate',
          // Denominator: every observed call plus every prediction-level tool
          // error that had no call of its own. Each failing call is in the
          // numerator exactly once, so the value is a rate in [0, 1] rather
          // than the unbounded double count a naive sum produces.
          ...(counters.calls + counters.unmatchedToolErrors > 0
            ? {
                observed:
                  counters.toolErrors /
                  (counters.calls + counters.unmatchedToolErrors),
              }
            : { observed: 0 }),
          threshold: options!.maxToolErrorRate!,
          direction: 'max',
          ...(counters.overriddenToolError ? { overriddenByHost: true } : {}),
        })
      );
    }
    if (configured.has('token_ceiling')) {
      predicates.push(
        predicate({
          ...scope,
          id: 'token_ceiling',
          ...(counters.tokenAttempts > 0
            ? { observed: counters.tokenTotal / counters.tokenAttempts }
            : {}),
          threshold: options!.maxMeanTotalTokens!,
          direction: 'max',
        })
      );
    }
    if (configured.has('latency_ceiling')) {
      predicates.push(
        predicate({
          ...scope,
          id: 'latency_ceiling',
          ...(counters.latencyAttempts > 0
            ? { observed: counters.latencyTotal / counters.latencyAttempts }
            : {}),
          threshold: options!.maxMeanLatencyMs!,
          direction: 'max',
        })
      );
    }
  }

  // The gate requires every measurable configured predicate unless the caller
  // narrowed the set explicitly.
  const required =
    options?.required ?? PREDICATE_ORDER.filter((id) => configured.has(id));
  const requiredSet = new Set(required);
  const ordered = PREDICATE_ORDER.flatMap((id) =>
    predicates.filter((entry) => entry.id === id)
  );
  const failed = ordered.find(
    (entry) => requiredSet.has(entry.id) && entry.status !== 'pass'
  );
  return {
    predicates: ordered,
    required,
    ...(failed ? { failed: failed.name } : {}),
  };
}
