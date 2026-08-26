/**
 * `agent.playbook().evolve()` orchestrator — verified (or trust-batch)
 * playbook learning from a task set:
 *
 *   baseline batch eval → deterministic failure clustering → per-cluster
 *   grounded weakness mining → bounded playbook proposal → (verify) sequential
 *   accept gate.
 *
 * With `verify` (default) a proposal is kept only when the held-in (train)
 * score improves by at least `minHeldInGain` AND the held-out (validation)
 * score does not drop by more than `epsilon`; rejected proposals roll back
 * exactly, and accepted scores become the next proposal's baseline. With
 * `verify: false` the mined lessons are applied without the gate (trust-batch).
 * `requireHeldOut` adds a fail-closed production promotion policy on top.
 */

import type { AxGenIn, AxGenOut } from '../../../dsp/types.js';
import { normalizeAgentEvalDataset } from '../../optimize.js';
import type {
  AxAgentEvalDataset,
  AxAgentEvalTask,
  AxAgentJudgeOptions,
} from '../agentOptimizeTypes.js';
import { createAgentOptimizeMetric } from '../optimizer.js';
import type {
  AxAgentEvalBatchResult,
  AxAgentEvalBudget,
} from './evalHarness.js';
import { runAgentEvalBatch } from './evalHarness.js';
import { clusterFailures } from './failureClusters.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveOutcome,
  AxAgentPlaybookEvolveResult,
  AxAgentPlaybookRetentionAnchor,
  AxAgentPlaybookRetentionReceipt,
  AxAgentPlaybookWeakness,
} from './playbookEvolveTypes.js';
import type { AxAppliedProposal } from './proposals.js';
import {
  applyProposal,
  buildProposal,
  currentPlaybookText,
} from './proposals.js';
import { mineWeakness } from './weaknessMiner.js';

const DEFAULT_MAX_PROPOSALS = 4;
const DEFAULT_EPSILON = 0.01;
const DEFAULT_MIN_HELD_IN_GAIN = 0.05;
const DEFAULT_SCORE_THRESHOLD = 0.7;
const MAX_RUNS_PER_TASK = 100;
const MAX_METRIC_CALLS = 1_000_000;
const RESTORATION_FAILURE = Symbol.for(
  '@ax-llm/ax/agent-playbook-restoration-failure'
);

function positiveSafeInteger(
  value: number,
  name: 'runsPerTask' | 'maxMetricCalls',
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `AxAgent.playbook().evolve(): ${name} must be a positive safe integer at most ${maximum}.`
    );
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) {
      deepFreeze(child, seen);
    }
    // JavaScript rejects Object.freeze() for non-empty typed arrays. The
    // structured clone still isolates this snapshot from caller mutation.
    if (!ArrayBuffer.isView(value)) Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T, label: string): Readonly<T> {
  try {
    return deepFreeze(structuredClone(value));
  } catch (err) {
    throw new Error(
      `AxAgent.playbook().evolve(): ${label} must be structured-cloneable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function canonicalSerialize(
  value: unknown,
  seen = new WeakSet<object>()
): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention digest values must be finite.'
      );
    }
    return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention digest values must not contain cycles.'
      );
    }
    seen.add(value);
    const serialized = `array:length:${value.length}:{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSerialize(
            (value as unknown as Record<string, unknown>)[key],
            seen
          )}`
      )
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention digest values must not contain cycles.'
      );
    }
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) {
        throw new Error(
          'AxAgent.playbook().evolve(): retention digest Date values must be valid.'
        );
      }
      return `date:${value.toISOString()}`;
    }
    seen.add(value);
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(
          ([key, entryValue]) =>
            `entry:[${canonicalSerialize(key, seen)},${canonicalSerialize(entryValue, seen)}]`
        )
        .sort();
      seen.delete(value);
      return `map:[${entries.join(',')}]`;
    }
    if (value instanceof Set) {
      const entries = [...value].map((item) => canonicalSerialize(item, seen));
      entries.sort();
      seen.delete(value);
      return `set:[${entries.join(',')}]`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength
      );
      const serialized = [...bytes]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      seen.delete(value);
      return `view:${value.constructor.name}:${serialized}`;
    }
    if (value instanceof ArrayBuffer) {
      const serialized = [...new Uint8Array(value)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      seen.delete(value);
      return `arraybuffer:${serialized}`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(value);
      throw new Error(
        'AxAgent.playbook().evolve(): unsupported retention digest object value.'
      );
    }
    const record = value as Record<string, unknown>;
    const serialized = `object:{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSerialize(record[key], seen)}`
      )
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  throw new Error(
    `AxAgent.playbook().evolve(): unsupported retention digest value type ${typeof value}.`
  );
}

function canonicalDigest(value: unknown): string {
  const input = canonicalSerialize(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function atMostWithFloatingPointTolerance(value: number, limit: number) {
  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(limit)) * 4;
  return value <= limit + tolerance;
}

function retentionEvidenceError(
  label: string,
  result: AxAgentEvalBatchResult
): Error {
  return new Error(
    `AxAgent.playbook().evolve(): ${label} requires complete, finite evaluator evidence.`,
    result.failure === undefined ? undefined : { cause: result.failure }
  );
}

function validateRetentionWeights(
  tasks: readonly { weight?: number }[],
  label: string
): void {
  let total = 0;
  for (const task of tasks) {
    const weight = task.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `AxAgent.playbook().evolve(): ${label} task weights must be finite and non-negative.`
      );
    }
    total += weight;
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `AxAgent.playbook().evolve(): ${label} must have positive finite total weight.`
    );
  }
}

function validateRetentionPolicy(
  policy: NonNullable<AxAgentPlaybookEvolveOptions['retentionPolicy']>,
  verify: boolean,
  currentTasks: readonly { weight?: number }[],
  heldOutTasks?: readonly { weight?: number }[]
): void {
  if (!verify) {
    throw new Error(
      'AxAgent.playbook().evolve(): retentionPolicy requires verify: true.'
    );
  }
  if (policy.slices.length === 0) {
    throw new Error(
      'AxAgent.playbook().evolve(): retentionPolicy requires at least one slice.'
    );
  }
  if (!policy.evaluatorId.trim() || policy.evaluatorId.length > 200) {
    throw new Error(
      'AxAgent.playbook().evolve(): retentionPolicy.evaluatorId must be 1-200 characters.'
    );
  }
  const thresholds = [
    ['minCurrentGain', policy.minCurrentGain],
    ['maxWorstHistoricalLoss', policy.maxWorstHistoricalLoss],
    ['maxMeanHistoricalLoss', policy.maxMeanHistoricalLoss],
  ] as const;
  for (const [name, value] of thresholds) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `AxAgent.playbook().evolve(): retentionPolicy.${name} must be finite and non-negative.`
      );
    }
  }
  validateRetentionWeights(currentTasks, 'retention current-task set');
  if (heldOutTasks?.length) {
    validateRetentionWeights(heldOutTasks, 'retention held-out set');
  }
  const identities = new Set<string>();
  for (const slice of policy.slices) {
    if (!slice.name.trim() || !slice.version.trim()) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention slice name and version must be non-empty.'
      );
    }
    if (slice.tasks.length === 0) {
      throw new Error(
        `AxAgent.playbook().evolve(): retention slice ${slice.name}@${slice.version} has no tasks.`
      );
    }
    validateRetentionWeights(
      slice.tasks,
      `retention slice ${slice.name}@${slice.version}`
    );
    const identity = JSON.stringify([slice.name, slice.version]);
    if (identities.has(identity)) {
      throw new Error(
        `AxAgent.playbook().evolve(): duplicate retention slice ${slice.name}@${slice.version}.`
      );
    }
    identities.add(identity);
  }
}

function assertRequiredHeldOut<IN extends AxGenIn>(args: {
  train: readonly AxAgentEvalTask<IN>[];
  validation?: readonly AxAgentEvalTask<IN>[];
  taskId?: (task: Readonly<AxAgentEvalTask<IN>>) => string | undefined;
}): void {
  if (!args.validation?.length) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut requires a non-empty validation set.'
    );
  }
  const idOf = args.taskId ?? ((task: AxAgentEvalTask<IN>) => task.id);
  const ids = (split: 'train' | 'validation', tasks: typeof args.train) =>
    tasks.map((task, index) => {
      const raw = idOf(task);
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id) {
        throw new Error(
          `AxAgent.playbook().evolve(): requireHeldOut cannot prove disjointness: ${split}[${index}] has no semantic task id; set task.id or provide taskId.`
        );
      }
      return id;
    });
  const trainIds = new Set(ids('train', args.train));
  const overlaps = [
    ...new Set(
      ids('validation', args.validation).filter((id) => trainIds.has(id))
    ),
  ];
  if (overlaps.length > 0) {
    throw new Error(
      `AxAgent.playbook().evolve(): requireHeldOut requires disjoint train and validation sets; overlapping task id(s): ${overlaps.join(', ')}.`
    );
  }
}

export async function evolveAgentPlaybook<
  IN extends AxGenIn,
  OUT extends AxGenOut,
>(
  self: any,
  dataset: Readonly<AxAgentEvalDataset<IN>>,
  options?: Readonly<AxAgentPlaybookEvolveOptions<IN>>
): Promise<AxAgentPlaybookEvolveResult<OUT>> {
  const s = self as any;
  const normalized = normalizeAgentEvalDataset(dataset);
  if (normalized.train.length === 0) {
    throw new Error(
      'AxAgent.playbook().evolve(): at least one training task is required.'
    );
  }
  const requireHeldOut = options?.requireHeldOut === true;
  if (requireHeldOut && options?.verify === false) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut cannot be combined with verify: false.'
    );
  }
  if (requireHeldOut) {
    assertRequiredHeldOut({
      train: normalized.train,
      validation: normalized.validation,
      ...(options?.taskId ? { taskId: options.taskId } : {}),
    });
  }

  const studentAI = options?.studentAI ?? s.init?.ai ?? s.ai;
  if (!studentAI) {
    throw new Error(
      'AxAgent.playbook().evolve(): studentAI is required when the agent has no default ai.'
    );
  }
  const agentJudgeAI = s.init?.judgeAI ?? s.judgeAI;
  const teacherAI = options?.teacherAI ?? agentJudgeAI ?? studentAI;
  const judgeAI =
    options?.judgeAI ?? agentJudgeAI ?? options?.teacherAI ?? studentAI;
  const judgeOptions: AxAgentJudgeOptions = {
    ...(s.judgeOptions ?? {}),
    ...(options?.judgeOptions ?? {}),
  };
  const metric =
    options?.metric ?? createAgentOptimizeMetric(self, judgeAI, judgeOptions);

  const verify = options?.verify !== false;
  const retentionPolicy = options?.retentionPolicy
    ? cloneAndFreeze(options.retentionPolicy, 'retentionPolicy')
    : undefined;
  const trainTasks = retentionPolicy
    ? cloneAndFreeze(normalized.train, 'retention current-task set')
    : normalized.train;
  const validationTasks = retentionPolicy
    ? normalized.validation
      ? cloneAndFreeze(normalized.validation, 'retention held-out set')
      : undefined
    : normalized.validation;
  if (retentionPolicy) {
    validateRetentionPolicy(
      retentionPolicy,
      verify,
      trainTasks,
      validationTasks
    );
  }
  const maxProposals = Math.max(
    1,
    Math.floor(options?.maxProposals ?? DEFAULT_MAX_PROPOSALS)
  );
  const runsPerTask = positiveSafeInteger(
    options?.runsPerTask ?? 1,
    'runsPerTask',
    MAX_RUNS_PER_TASK
  );
  const retentionTaskCount =
    retentionPolicy?.slices.reduce(
      (sum, slice) => sum + slice.tasks.length,
      0
    ) ?? 0;
  const datasetSize =
    (trainTasks.length + (validationTasks?.length ?? 0) + retentionTaskCount) *
    runsPerTask;
  const maxMetricCalls = positiveSafeInteger(
    options?.maxMetricCalls ??
      Math.min(
        MAX_METRIC_CALLS,
        Math.max(100, (maxProposals + 1) * datasetSize)
      ),
    'maxMetricCalls',
    MAX_METRIC_CALLS
  );
  if (
    requireHeldOut &&
    (!Number.isFinite(runsPerTask) || !Number.isFinite(maxMetricCalls))
  ) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut requires finite runsPerTask and maxMetricCalls.'
    );
  }
  if (requireHeldOut && maxMetricCalls < datasetSize * 2) {
    throw new Error(
      `AxAgent.playbook().evolve(): requireHeldOut needs at least ${datasetSize * 2} metric calls for one complete baseline + candidate evaluation; maxMetricCalls is ${maxMetricCalls}.`
    );
  }
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const minHeldInGain = options?.minHeldInGain ?? DEFAULT_MIN_HELD_IN_GAIN;
  const currentGainThreshold = retentionPolicy?.minCurrentGain ?? minHeldInGain;
  const scoreThreshold = options?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const currentTaskSetDigest = retentionPolicy
    ? canonicalDigest(trainTasks)
    : undefined;
  const heldOutTaskSetDigest =
    retentionPolicy && validationTasks?.length
      ? canonicalDigest(validationTasks)
      : undefined;
  const sliceTaskSetDigests =
    retentionPolicy?.slices.map((slice) => canonicalDigest(slice.tasks)) ?? [];
  const retentionPolicyDigest = retentionPolicy
    ? canonicalDigest({
        schema: 'ax-agent-playbook-retention-v1',
        evaluatorId: retentionPolicy.evaluatorId,
        currentTaskSetDigest,
        heldOutTaskSetDigest,
        thresholds: {
          minCurrentGain: retentionPolicy.minCurrentGain,
          maxWorstHistoricalLoss: retentionPolicy.maxWorstHistoricalLoss,
          maxMeanHistoricalLoss: retentionPolicy.maxMeanHistoricalLoss,
          heldOutEpsilon: epsilon,
        },
        slices: retentionPolicy.slices.map((slice, index) => ({
          name: slice.name,
          version: slice.version,
          taskSetDigest: sliceTaskSetDigests[index],
        })),
      })
    : undefined;
  let retentionSequence = 0;
  if (
    requireHeldOut &&
    (!Number.isFinite(epsilon) ||
      epsilon < 0 ||
      !Number.isFinite(minHeldInGain) ||
      minHeldInGain < 0)
  ) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut requires finite, non-negative epsilon and minHeldInGain.'
    );
  }
  const budget: AxAgentEvalBudget = { remaining: maxMetricCalls };
  const usedCalls = () => maxMetricCalls - budget.remaining;

  const baselineRequiredCalls =
    (trainTasks.length + (validationTasks?.length ?? 0) + retentionTaskCount) *
    runsPerTask;
  if (retentionPolicy && maxMetricCalls < baselineRequiredCalls) {
    throw new Error(
      `AxAgent.playbook().evolve(): maxMetricCalls ${maxMetricCalls} cannot establish complete retention anchors (requires ${baselineRequiredCalls}).`
    );
  }

  const progress = (
    phase: 'baseline' | 'mining' | 'proposal' | 'validation' | 'done',
    message: string
  ) => {
    options?.onProgress?.({ phase, message, metricCallsUsed: usedCalls() });
    if (options?.verbose) {
      console.log(`[playbook.evolve] ${phase}: ${message}`);
    }
  };

  const batchArgs = {
    agent: s,
    ai: studentAI,
    metric,
    scoreThreshold,
    budget,
    runsPerTask,
    ...(retentionPolicy ? { isolateTaskInputs: true } : {}),
    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };

  // The playbook handle to curate into. The caller (agent.playbook().evolve)
  // ensures one exists; fall back to attaching one so a bare call still works.
  const playbookHandle =
    s.getPlaybook?.() ??
    (() => {
      const handle = s._buildStagePlaybook({
        target: 'actor',
        studentAI,
        teacherAI,
        maxReflectorRounds: 1,
      });
      s.playbookHandle = handle;
      return handle;
    })();

  // ---- Baseline ----
  progress('baseline', `evaluating ${trainTasks.length} train tasks`);
  const baselineTrain = await runAgentEvalBatch<IN, OUT>({
    ...batchArgs,
    tasks: trainTasks,
  });
  if (retentionPolicy && !baselineTrain.complete) {
    throw retentionEvidenceError(
      'retention current-task anchor',
      baselineTrain
    );
  }
  let currentTaskAnchorSequence = retentionPolicy
    ? ++retentionSequence
    : undefined;
  let currentTaskAnchorEvidence = retentionPolicy
    ? {
        executedRuns: baselineTrain.executedRuns,
        expectedRuns: baselineTrain.expectedRuns,
        complete: true as const,
      }
    : undefined;
  if (requireHeldOut && !baselineTrain.complete) {
    throw new Error(
      'AxAgent.playbook().evolve(): requireHeldOut held-in baseline evaluation was incomplete or errored.'
    );
  }
  let heldIn = baselineTrain.mean;
  let heldOut: number | undefined;
  let baselineHeldOutBatch: AxAgentEvalBatchResult<IN, OUT> | undefined;
  let heldOutAnchorSequence: number | undefined;
  let heldOutAnchorEvidence:
    | {
        executedRuns: number;
        expectedRuns: number;
        complete: true;
      }
    | undefined;
  if (validationTasks?.length) {
    progress(
      'baseline',
      `evaluating ${validationTasks.length} validation tasks`
    );
    baselineHeldOutBatch = await runAgentEvalBatch<IN, OUT>({
      ...batchArgs,
      tasks: validationTasks,
    });
    if (retentionPolicy && !baselineHeldOutBatch.complete) {
      throw retentionEvidenceError(
        'retention held-out anchor',
        baselineHeldOutBatch
      );
    }
    heldOut = baselineHeldOutBatch.mean;
    if (retentionPolicy) {
      heldOutAnchorSequence = ++retentionSequence;
      heldOutAnchorEvidence = {
        executedRuns: baselineHeldOutBatch.executedRuns,
        expectedRuns: baselineHeldOutBatch.expectedRuns,
        complete: true,
      };
    }
    if (requireHeldOut && !baselineHeldOutBatch.complete) {
      throw new Error(
        'AxAgent.playbook().evolve(): requireHeldOut held-out baseline evaluation was incomplete or errored.'
      );
    }
  }
  const baseline = {
    heldIn,
    ...(heldOut !== undefined ? { heldOut } : {}),
  };
  const retentionAnchors: AxAgentPlaybookRetentionAnchor[] = [];
  if (retentionPolicy) {
    for (const [index, slice] of retentionPolicy.slices.entries()) {
      progress(
        'baseline',
        `evaluating retention slice ${slice.name}@${slice.version} (${slice.tasks.length} tasks)`
      );
      const result = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks: slice.tasks,
      });
      if (!result.complete) {
        throw retentionEvidenceError(
          `retention slice ${slice.name}@${slice.version}`,
          result
        );
      }
      retentionAnchors.push(
        deepFreeze({
          name: slice.name,
          version: slice.version,
          taskCount: slice.tasks.length,
          taskSetDigest: sliceTaskSetDigests[index]!,
          policyDigest: retentionPolicyDigest!,
          evaluatorId: retentionPolicy.evaluatorId,
          sequence: ++retentionSequence,
          score: result.mean,
          evidence: {
            executedRuns: result.executedRuns,
            expectedRuns: result.expectedRuns,
            complete: true as const,
          },
        })
      );
    }
  }

  // ---- Mine weaknesses from failure clusters ----
  const clusters = clusterFailures(
    baselineTrain.records,
    scoreThreshold,
    maxProposals
  );
  progress(
    'mining',
    `${clusters.length} failure cluster(s) from ${baselineTrain.records.length} records`
  );

  const weaknesses: AxAgentPlaybookWeakness[] = [];
  for (const [index, cluster] of clusters.entries()) {
    if (options?.abortSignal?.aborted) {
      throw new Error('AxAgent.playbook().evolve(): aborted');
    }
    try {
      const weakness = await mineWeakness({
        ai: teacherAI,
        cluster,
        currentPlaybook: currentPlaybookText(s),
        index,
      });
      if (weakness) {
        weaknesses.push(weakness);
        progress('mining', `${weakness.id} [${weakness.clusterSignature}]`);
      } else {
        progress(
          'mining',
          `cluster [${cluster.signature}] discarded (no grounded evidence)`
        );
      }
    } catch (err) {
      progress(
        'mining',
        `cluster [${cluster.signature}] miner failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- Sequential propose -> (verify) accept/reject ----
  const outcomes: AxAgentPlaybookEvolveOutcome[] = [];
  const accepted: AxAppliedProposal[] = [];
  const rollbackAccepted = (): unknown[] => {
    const errors: unknown[] = [];
    for (const applied of [...accepted].reverse()) {
      try {
        applied.rollback();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };
  let inFlight: AxAppliedProposal | undefined;

  try {
    for (const weakness of weaknesses) {
      if (options?.abortSignal?.aborted) {
        throw new Error('AxAgent.playbook().evolve(): aborted');
      }
      const proposal = buildProposal(weakness);
      const requiredCalls =
        (trainTasks.length +
          (validationTasks?.length ?? 0) +
          retentionTaskCount) *
        runsPerTask;
      if (verify && budget.remaining < requiredCalls) {
        outcomes.push({
          proposal,
          status: 'rejected',
          accepted: false,
          reason: 'metric_budget exhausted before validation',
          heldIn: { before: heldIn, after: heldIn },
        });
        progress('validation', `${weakness.id}: budget exhausted, skipped`);
        continue;
      }

      progress('proposal', `${weakness.id}: applying playbook proposal`);
      let applied: AxAppliedProposal;
      try {
        applied = await applyProposal({ proposal, playbookHandle });
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          RESTORATION_FAILURE in err &&
          (err as Record<symbol, unknown>)[RESTORATION_FAILURE] === true
        ) {
          throw err;
        }
        outcomes.push({
          proposal,
          status: 'rejected',
          accepted: false,
          reason: `apply failed: ${err instanceof Error ? err.message : String(err)}`,
          heldIn: { before: heldIn, after: heldIn },
        });
        continue;
      }
      inFlight = applied;

      // Trust-batch: keep the lesson without a gate.
      if (!verify) {
        accepted.push(applied);
        inFlight = undefined;
        outcomes.push({
          proposal,
          status: 'accepted',
          accepted: true,
          reason: 'applied without verification (verify: false)',
          heldIn: { before: heldIn, after: heldIn },
        });
        progress('validation', `${weakness.id}: applied (trust-batch)`);
        continue;
      }

      const revalTrain = await runAgentEvalBatch<IN, OUT>({
        ...batchArgs,
        tasks: trainTasks,
      });
      const candidateCurrentSequence = retentionPolicy
        ? ++retentionSequence
        : undefined;
      let revalHeldOut: number | undefined;
      let revalHeldOutBatch: AxAgentEvalBatchResult<IN, OUT> | undefined;
      let candidateHeldOutSequence: number | undefined;
      if (validationTasks?.length) {
        revalHeldOutBatch = await runAgentEvalBatch<IN, OUT>({
          ...batchArgs,
          tasks: validationTasks,
        });
        revalHeldOut = revalHeldOutBatch.mean;
        if (retentionPolicy) {
          candidateHeldOutSequence = ++retentionSequence;
        }
      }
      const candidateRetentionBatches: {
        batch: AxAgentEvalBatchResult<IN, OUT>;
        sequence: number;
      }[] = [];
      if (retentionPolicy) {
        for (const slice of retentionPolicy.slices) {
          const batch = await runAgentEvalBatch<IN, OUT>({
            ...batchArgs,
            tasks: slice.tasks,
          });
          candidateRetentionBatches.push({
            batch,
            sequence: ++retentionSequence,
          });
        }
      }

      // A re-eval that exhausted mid-way produced a subset mean — comparing it
      // to the full-set baseline is apples-to-oranges, so refuse the accept.
      // Retention additionally rejects any evaluator error/non-finite score.
      if (retentionPolicy) {
        const failedResult = !revalTrain.validEvidence
          ? revalTrain
          : revalHeldOutBatch && !revalHeldOutBatch.validEvidence
            ? revalHeldOutBatch
            : candidateRetentionBatches.find(
                ({ batch }) => !batch.validEvidence
              )?.batch;
        if (failedResult) {
          throw retentionEvidenceError(
            'candidate retention evaluation',
            failedResult
          );
        }
      }
      const revalComplete = retentionPolicy
        ? revalTrain.complete &&
          (revalHeldOutBatch?.complete ?? true) &&
          candidateRetentionBatches.every(({ batch }) => batch.complete)
        : requireHeldOut
          ? revalTrain.complete && revalHeldOutBatch?.complete === true
          : !revalTrain.exhausted && !revalHeldOutBatch?.exhausted;
      const currentGain = revalTrain.mean - heldIn;
      const gainOk = revalComplete && currentGain >= currentGainThreshold;
      const heldOutOk =
        revalHeldOut === undefined ||
        heldOut === undefined ||
        revalHeldOut - heldOut >= -epsilon;
      let retentionReceipt: AxAgentPlaybookRetentionReceipt | undefined;
      let retentionOk = true;
      if (retentionPolicy && revalComplete) {
        const slices = retentionAnchors.map((anchor, index) => {
          const candidate = candidateRetentionBatches[index]!;
          return {
            name: anchor.name,
            version: anchor.version,
            taskCount: anchor.taskCount,
            taskSetDigest: anchor.taskSetDigest,
            anchorSequence: anchor.sequence,
            candidateSequence: candidate.sequence,
            anchorScore: anchor.score,
            candidateScore: candidate.batch.mean,
            historicalLoss: anchor.score - candidate.batch.mean,
            anchorEvidence: anchor.evidence,
            candidateEvidence: {
              executedRuns: candidate.batch.executedRuns,
              expectedRuns: candidate.batch.expectedRuns,
              complete: true as const,
            },
          };
        });
        const losses = slices.map((slice) => slice.historicalLoss);
        const worstHistoricalLoss = Math.max(...losses);
        const meanHistoricalLoss =
          losses.reduce((sum, loss) => sum + loss, 0) / losses.length;
        retentionOk =
          atMostWithFloatingPointTolerance(
            worstHistoricalLoss,
            retentionPolicy.maxWorstHistoricalLoss
          ) &&
          atMostWithFloatingPointTolerance(
            meanHistoricalLoss,
            retentionPolicy.maxMeanHistoricalLoss
          );
        const accepted = gainOk && heldOutOk && retentionOk;
        retentionReceipt = deepFreeze({
          policy: {
            digest: retentionPolicyDigest!,
            evaluatorId: retentionPolicy.evaluatorId,
            currentTaskSetDigest: currentTaskSetDigest!,
            ...(heldOutTaskSetDigest ? { heldOutTaskSetDigest } : {}),
          },
          sequence: ++retentionSequence,
          currentTask: {
            before: heldIn,
            after: revalTrain.mean,
            gain: currentGain,
            taskSetDigest: currentTaskSetDigest!,
            anchorSequence: currentTaskAnchorSequence!,
            candidateSequence: candidateCurrentSequence!,
            anchorEvidence: currentTaskAnchorEvidence!,
            candidateEvidence: {
              executedRuns: revalTrain.executedRuns,
              expectedRuns: revalTrain.expectedRuns,
              complete: true,
            },
          },
          ...(heldOutTaskSetDigest && baselineHeldOutBatch && revalHeldOutBatch
            ? {
                heldOut: {
                  taskSetDigest: heldOutTaskSetDigest,
                  anchorSequence: heldOutAnchorSequence!,
                  candidateSequence: candidateHeldOutSequence!,
                  anchorEvidence: heldOutAnchorEvidence!,
                  candidateEvidence: {
                    executedRuns: revalHeldOutBatch.executedRuns,
                    expectedRuns: revalHeldOutBatch.expectedRuns,
                    complete: true as const,
                  },
                },
              }
            : {}),
          slices,
          worstHistoricalLoss,
          meanHistoricalLoss,
          thresholds: {
            minCurrentGain: retentionPolicy.minCurrentGain,
            maxWorstHistoricalLoss: retentionPolicy.maxWorstHistoricalLoss,
            maxMeanHistoricalLoss: retentionPolicy.maxMeanHistoricalLoss,
          },
          accepted,
        });
      }
      const accept = revalComplete && gainOk && heldOutOk && retentionOk;

      outcomes.push({
        proposal,
        status: accept ? 'accepted' : 'rejected',
        accepted: accept,
        reason:
          requireHeldOut && !revalTrain.complete
            ? 'held-in evaluation incomplete or errored'
            : requireHeldOut && revalHeldOutBatch?.complete !== true
              ? 'held-out evaluation incomplete or errored'
              : !revalComplete
                ? 'metric_budget exhausted during re-evaluation'
                : accept
                  ? retentionPolicy
                    ? 'current task improved, historical retention thresholds satisfied'
                    : heldOut === undefined
                      ? 'held-in improved (no held-out set provided — consider one)'
                      : 'held-in improved, held-out non-regressing'
                  : !gainOk
                    ? retentionPolicy
                      ? `current-task gain ${currentGain.toFixed(3)} below ${currentGainThreshold}`
                      : `held-in gain ${currentGain.toFixed(3)} below ${currentGainThreshold}`
                    : !heldOutOk
                      ? `held-out regressed ${((revalHeldOut ?? 0) - (heldOut ?? 0)).toFixed(3)}`
                      : `historical loss exceeded retention threshold (worst ${retentionReceipt?.worstHistoricalLoss.toFixed(3)}, mean ${retentionReceipt?.meanHistoricalLoss.toFixed(3)})`,
        heldIn: { before: heldIn, after: revalTrain.mean },
        ...(revalHeldOut !== undefined && heldOut !== undefined
          ? { heldOut: { before: heldOut, after: revalHeldOut } }
          : {}),
        ...(retentionReceipt ? { retention: retentionReceipt } : {}),
      });

      if (options?.abortSignal?.aborted) {
        throw new Error('AxAgent.playbook().evolve(): aborted');
      }
      if (accept) {
        playbookHandle?.recordEvidence?.(applied.bulletIds, {
          source: 'agent-evolve',
          sourceRunId: proposal.clusterSignature,
          feedbackIds: [proposal.weaknessId],
          verification: [
            {
              verifierId: 'agent.playbook.evolve',
              testId: proposal.weaknessId,
              result: 'passed',
              summary: `held-in ${heldIn.toFixed(3)} -> ${revalTrain.mean.toFixed(3)}${
                heldOut !== undefined && revalHeldOut !== undefined
                  ? `; held-out ${heldOut.toFixed(3)} -> ${revalHeldOut.toFixed(3)}`
                  : ''
              }`,
            },
          ],
        });
        accepted.push(applied);
        inFlight = undefined;
        heldIn = revalTrain.mean;
        if (retentionPolicy) {
          currentTaskAnchorSequence = candidateCurrentSequence;
          currentTaskAnchorEvidence = {
            executedRuns: revalTrain.executedRuns,
            expectedRuns: revalTrain.expectedRuns,
            complete: true,
          };
        }
        if (revalHeldOut !== undefined) {
          heldOut = revalHeldOut;
          if (retentionPolicy) {
            heldOutAnchorSequence = candidateHeldOutSequence;
            heldOutAnchorEvidence = {
              executedRuns: revalHeldOutBatch!.executedRuns,
              expectedRuns: revalHeldOutBatch!.expectedRuns,
              complete: true,
            };
          }
        }
        progress('validation', `${weakness.id}: ACCEPTED`);
      } else {
        inFlight = undefined;
        applied.rollback();
        progress('validation', `${weakness.id}: rejected, rolled back`);
      }
    }
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    if (inFlight) {
      const applied = inFlight;
      inFlight = undefined;
      try {
        applied.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (options?.apply === false) {
      rollbackErrors.push(...rollbackAccepted());
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [err, ...rollbackErrors],
        'AxAgent.playbook().evolve(): candidate evaluation failed and exact rollback also failed.'
      );
    }
    throw err;
  }

  // ---- Finalize ----
  const playbookSnapshot =
    accepted.length > 0 ? playbookHandle?.getState() : undefined;

  if (options?.apply === false) {
    const rollbackErrors = rollbackAccepted();
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        'AxAgent.playbook().evolve(): exact dry-run rollback failed.'
      );
    }
  }

  progress(
    'done',
    `${accepted.length}/${outcomes.length} proposals accepted; held-in ${baseline.heldIn.toFixed(3)} -> ${heldIn.toFixed(3)}`
  );

  return {
    baseline,
    final: { heldIn, ...(heldOut !== undefined ? { heldOut } : {}) },
    ...(retentionAnchors.length > 0
      ? { retentionAnchors: deepFreeze(retentionAnchors) }
      : {}),
    weaknesses,
    outcomes,
    recommendations: weaknesses.flatMap((w) => w.configRecommendations),
    ...(playbookSnapshot ? { playbookSnapshot } : {}),
    metricCallsUsed: usedCalls(),
    records: baselineTrain.records,
  };
}
