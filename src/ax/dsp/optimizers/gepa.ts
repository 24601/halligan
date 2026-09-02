import type { AxAIService } from '../../ai/types.js';
import type {
  AxCompileOptions,
  AxExample,
  AxMetricFn,
  AxMultiMetricFn,
  AxOptimizerArgs,
  AxTypedExample,
} from '../common_types.js';
import type { AxGen } from '../generate.js';
import {
  AxBaseOptimizer,
  AxOptimizedProgramImpl,
  type AxParetoResult,
} from '../optimizer.js';
import { ax } from '../template.js';
import type { AxGenOut, AxProgrammable } from '../types.js';
import type { AxGEPAAdapter } from './gepaAdapter.js';
import {
  bootstrapGEPADemos,
  resolveBootstrapOptions,
} from './gepaBootstrap.js';
import {
  applyGEPAComponentConfig,
  getGEPAOptimizationTargets,
} from './gepaComponents.js';
import { getGEPAUpdateGroup } from './gepaDependencies.js';
import {
  type AxGEPABatchEvaluation,
  type AxGEPAEvaluationState,
  evaluateGEPABatch,
  normalizeGEPAMetricFeedback,
  normalizeGEPAMetricResult,
  normalizeGEPAScores,
  scalarizeGEPAScores,
} from './gepaEvaluation.js';
import {
  type AxGEPACandidateEvaluation,
  type AxGEPACandidateFailure,
  type AxGEPACandidateLineageManifest,
  type AxGEPACandidateLineageOptions,
  type AxGEPACandidateLineageRecord,
  buildGEPACandidateComponentDelta,
  buildGEPACandidateFailure,
  freezeGEPACandidateLineageManifest,
  resolveGEPALineageOptions,
} from './gepaLineage.js';
import {
  proposeGEPAComponentValue,
  renderReflectiveValue,
  validateGEPAComponentValue,
} from './gepaReflection.js';
import { AxGEPAComponentSelector } from './gepaSelection.js';
import {
  average,
  buildParetoFront,
  hypervolume2D,
  removeDominatedProgramsByInstanceFronts,
  selectProgramCandidateFromInstanceFronts,
} from './paretoUtils.js';
import {
  type AxMinibatchStrategy,
  type AxTaskDiscriminationOptions,
  type AxTaskDiscriminationSummary,
  type AxTaskInclusion,
  type AxTaskInclusionSnapshot,
  type AxTaskStatTable,
  axComputeInclusionProbabilities,
  axCreateTaskStatTable,
  axIpwPairedDifference,
  axResolveTaskDiscriminationOptions,
  axSampleByInclusion,
} from './taskDiscrimination.js';
import {
  type AxTrajectoryAdmissionOptions,
  type AxTrajectoryAdmissionReport,
  axExceedsRunDiscardCeiling,
  axMergeTrajectoryAdmission,
  axPairedAdmittedIndices,
  axResolveTrajectoryAdmissionOptions,
} from './trajectoryTermination.js';

/** Structured optimization report */
export interface AxGEPAOptimizationReport {
  summary: string;
  bestSolution: {
    overallScore: number;
    objectives: Record<string, { value: number; percentage: number }>;
  };
  paretoFrontier: {
    solutionCount: number;
    objectiveSpaceCoverage: number;
    hypervolume: number;
    tradeoffs?: Array<Record<string, number>>;
  };
  statistics: {
    totalEvaluations: number;
    candidatesExplored: number;
    converged: boolean;
  };
  recommendations: {
    status: 'good' | 'limited' | 'single';
    suggestions: string[];
  };
}

/** Helper to display optimization report in a nice format */
export function displayGEPAReport(report: AxGEPAOptimizationReport): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🎉 ${report.summary}`);
  console.log(`${'═'.repeat(60)}\n`);

  console.log('📊 Best Solution Found:');
  console.log(
    `   Overall Score: ${report.bestSolution.overallScore.toFixed(3)}`
  );
  console.log('   Individual Objectives:');
  for (const [key, obj] of Object.entries(report.bestSolution.objectives)) {
    const bar = '█'.repeat(Math.round(obj.value * 20));
    console.log(
      `   • ${key}: ${obj.value.toFixed(3)} (${obj.percentage.toFixed(1)}%) ${bar}`
    );
  }
  console.log();

  console.log('🎯 Pareto Frontier:');
  console.log(
    `   • Found ${report.paretoFrontier.solutionCount} optimal trade-off${report.paretoFrontier.solutionCount === 1 ? '' : 's'}`
  );
  console.log(
    `   • Objective space coverage: ${report.paretoFrontier.objectiveSpaceCoverage.toFixed(1)}%`
  );
  console.log(
    `     (Hypervolume: ${report.paretoFrontier.hypervolume.toFixed(3)})`
  );

  if (
    report.paretoFrontier.tradeoffs &&
    report.paretoFrontier.tradeoffs.length > 0
  ) {
    console.log('\n   Trade-off points discovered:');
    for (let i = 0; i < report.paretoFrontier.tradeoffs.length; i++) {
      const tradeoff = report.paretoFrontier.tradeoffs[i]!;
      const objectives = Object.entries(tradeoff)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(', ');
      console.log(`   ${i + 1}. ${objectives}`);
    }
  }
  console.log();

  console.log('📈 Optimization Statistics:');
  console.log(`   • Total evaluations: ${report.statistics.totalEvaluations}`);
  console.log(
    `   • Candidates explored: ${report.statistics.candidatesExplored}`
  );
  console.log(`   • Converged: ${report.statistics.converged ? '✅' : '❌'}`);
  console.log();

  console.log('💡 Recommendations:');
  const statusEmoji = report.recommendations.status === 'good' ? '✅' : '⚠️';
  console.log(`   ${statusEmoji} Status: ${report.recommendations.status}`);
  for (const suggestion of report.recommendations.suggestions) {
    console.log(`   • ${suggestion}`);
  }

  console.log(`\n${'═'.repeat(60)}\n`);
}

/**
 * Internal target descriptor used by AxGEPA: each "target" is one optimizable
 * component (a string-valued artifact identified by a globally unique key) plus
 * the metadata needed by the reflection LLM to mutate it intelligently.
 */
/** Single-module GEPA (reflective prompt evolution with Pareto sampling) */
export class AxGEPA extends AxBaseOptimizer {
  // Core knobs
  private numTrials: number;
  private minibatch: boolean;
  private minibatchSize: number;
  private earlyStoppingTrials: number;
  private minImprovementThreshold: number;
  private sampleCount: number;
  private paretoSetSize: number;

  // GEPA+ enhancements
  private crossoverEvery: number;
  private tieEpsilon: number;
  private feedbackMemorySize: number;
  private feedbackMemory: string[] = [];
  private mergeMax: number;
  private mergesUsed = 0;
  private mergesDue = 0;
  private totalMergesTested = 0;
  private lastIterFoundNewProgram = false;
  private mergeAttemptKeys = new Set<string>();
  private mergeCompositionKeys = new Set<string>();

  // GEPA reflection prompt template (aligned with reference implementation)
  private static readonly REFLECTION_PROMPT_TEMPLATE =
    `I provided an assistant with the following instructions to perform a task for me:
\`\`\`
<curr_instructions>
\`\`\`

The following are examples of different task inputs provided to the assistant along with the assistant's response for each of them, and some feedback on how the assistant's response could be better:
\`\`\`
<inputs_outputs_feedback>
\`\`\`

Your task is to write a new instruction for the assistant. Read the inputs carefully and identify the input format and infer detailed task description about the task I wish to solve with the assistant. Read all the assistant responses and the corresponding feedback. Identify all niche and domain specific factual information about the task and include it in the instruction, as a lot of it may not be available to the assistant in the future. The assistant may have utilized a generalizable strategy to solve the task, if so, include that in the instruction as well. Provide the new instructions within \`\`\` blocks.`;

  private rngState: number = 123456789;
  private samplerState: {
    epoch: number;
    shuffled: number[];
    freq: Map<number, number>;
  } = {
    epoch: -1,
    shuffled: [],
    freq: new Map(),
  };

  // Local histories for result object
  private localScoreHistory: number[] = [];
  private localConfigurationHistory: Record<string, unknown>[] = [];

  constructor(args: Readonly<AxOptimizerArgs>) {
    super(args);

    const seedRaw = (args as any)?.seed;
    const seedNum = Number.isFinite(seedRaw) ? Math.floor(Number(seedRaw)) : 0;
    this.rngState = seedNum && seedNum !== 0 ? seedNum : 123456789;

    this.numTrials = args.numTrials ?? 30;
    this.minibatch = args.minibatch ?? true;
    this.minibatchSize = args.minibatchSize ?? 20;
    this.earlyStoppingTrials = args.earlyStoppingTrials ?? 5;
    this.minImprovementThreshold = args.minImprovementThreshold ?? 0.0;
    this.sampleCount = args.sampleCount ?? 1;
    // How many validation instances to track for Pareto set (cap cost)
    const argPareto = (args as any)?.paretoSetSize as number | undefined;
    this.paretoSetSize =
      argPareto && argPareto > 0
        ? Math.min(1000, Math.max(5, Math.floor(argPareto)))
        : Math.max(10, Math.min(200, this.minibatchSize * 3));

    // GEPA+ defaults
    const argCrossoverEvery = (args as any)?.crossoverEvery as
      | number
      | undefined;
    this.crossoverEvery = Math.max(
      0,
      Math.floor(
        argCrossoverEvery ?? Math.max(3, Math.floor(this.numTrials / 4))
      )
    );
    const argTieEps = (args as any)?.tieEpsilon as number | undefined;
    this.tieEpsilon = Number.isFinite(argTieEps!) ? (argTieEps as number) : 0;
    const argFbMem = (args as any)?.feedbackMemorySize as number | undefined;
    this.feedbackMemorySize = Math.max(0, Math.floor(argFbMem ?? 4));
    // Default mergeMax to 5 (aligned with reference DSPy GEPA: use_merge=True, max_merge_invocations=5)
    const argMergeMax = (args as any)?.mergeMax as number | undefined;
    this.mergeMax = Math.max(0, Math.floor(argMergeMax ?? 5));
    this.mergesUsed = 0;

    // Hook convergence threshold to base stats
    this.stats.convergenceInfo.convergenceThreshold =
      this.minImprovementThreshold;
  }

  public override reset(): void {
    super.reset();
    this.stats.convergenceInfo.convergenceThreshold =
      this.minImprovementThreshold;
    this.localScoreHistory = [];
    this.localConfigurationHistory = [];
    this.feedbackMemory = [];
    this.mergesUsed = 0;
    this.mergesDue = 0;
    this.totalMergesTested = 0;
    this.lastIterFoundNewProgram = false;
    this.mergeAttemptKeys.clear();
    this.mergeCompositionKeys.clear();
    this.samplerState.epoch = -1;
    this.samplerState.shuffled = [];
    this.samplerState.freq.clear();
  }

  /**
   * Multi-objective GEPA: reflective evolution with Pareto frontier
   */
  public async compile<IN, OUT extends AxGenOut>(
    program: Readonly<AxProgrammable<IN, OUT>>,
    examples: readonly AxTypedExample<IN>[],
    metricFn: AxMetricFn | AxMultiMetricFn,
    options?: AxCompileOptions
  ): Promise<AxParetoResult<OUT>> {
    const _startTime = Date.now();
    this.validateExamples(examples);
    if (options?.auto) this.configureAuto(options.auto);

    const rolloutBudgetParetoRaw = (options as any)?.maxMetricCalls as number;
    if (
      !Number.isFinite(rolloutBudgetParetoRaw) ||
      rolloutBudgetParetoRaw <= 0
    ) {
      throw new Error(
        'AxGEPA: options.maxMetricCalls must be set to a positive integer'
      );
    }
    const rolloutBudgetPareto = Math.floor(rolloutBudgetParetoRaw);

    const validationExamples = (options as any)?.validationExamples as
      | readonly AxTypedExample<IN>[]
      | undefined;
    const feedbackExamples = (options as any)?.feedbackExamples as
      | readonly AxTypedExample<IN>[]
      | undefined;

    const paretoSet = (
      validationExamples && validationExamples.length > 0
        ? validationExamples
        : examples
    ).slice(0, this.paretoSetSize);

    const exampleKey = (example: Readonly<Record<string, unknown>>): string => {
      const ordered = Object.keys(example)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = example[key];
          return acc;
        }, {});
      return JSON.stringify(ordered);
    };

    const scoredExampleKeys = new Set(
      examples.map((example) =>
        exampleKey(example as unknown as Record<string, unknown>)
      )
    );

    const feedbackSet =
      feedbackExamples && feedbackExamples.length > 0
        ? feedbackExamples.filter((example) =>
            scoredExampleKeys.has(
              exampleKey(example as unknown as Record<string, unknown>)
            )
          )
        : examples;
    const effectiveFeedbackSet =
      feedbackSet.length > 0 ? feedbackSet : examples;
    const targets = getGEPAOptimizationTargets(program);
    if (targets.length === 0) {
      throw new Error(
        'AxGEPA: program exposes no optimizable components (implement getOptimizableComponents on AxProgram subclasses)'
      );
    }
    const componentSelector = new AxGEPAComponentSelector(targets);
    const alignedTargets = targets.filter(
      (target) => target.kind === 'program-source'
    );
    const validateConfig =
      alignedTargets.length > 0
        ? (cfg: Readonly<Record<string, string>>): void => {
            for (const target of alignedTargets) {
              const value = cfg[target.id];
              if (typeof value !== 'string' || !target.validate) continue;
              const result = target.validate(value);
              if (result !== true) throw new Error(result);
            }
          }
        : undefined;

    const applyConfig = (cfg: Readonly<Record<string, string>>): void => {
      applyGEPAComponentConfig(program, cfg);
    };

    const scalarize = (v: Readonly<Record<string, number>>): number => {
      return scalarizeGEPAScores(v, options as any);
    };

    const optLogger = this.getOptimizerLogger(options);
    const ownDataOption = <T>(key: string): T | undefined => {
      try {
        if (!options) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        return descriptor && 'value' in descriptor
          ? (descriptor.value as T)
          : undefined;
      } catch {
        throw new TypeError(
          `AxGEPA: throwing getOwnPropertyDescriptor while inspecting own ${key} is unsupported`
        );
      }
    };
    const lineageInput = ownDataOption<boolean | AxGEPACandidateLineageOptions>(
      'candidateLineage'
    );
    const gepaAbortSignal = ownDataOption<AbortSignal>('abortSignal');
    const trajectoryTerminationInput =
      ownDataOption<AxTrajectoryAdmissionOptions>('trajectoryTermination');
    const admissionOptions =
      typeof trajectoryTerminationInput === 'object' &&
      trajectoryTerminationInput !== null
        ? axResolveTrajectoryAdmissionOptions(trajectoryTerminationInput)
        : undefined;
    /**
     * Component kinds the evaluated config actually carries. Derived from the
     * program's declared components, never from a free-text label, because
     * `program-source` membership decides which rows a host may not relabel.
     *
     * CANDIDATE-INDEPENDENT BY CONSTRUCTION: every candidate `cfg` is a
     * complete config map (the seed spread with one component overridden), so
     * this is the whole program's kind set on every candidate, not the set the
     * candidate changed. A program that declares a `program-source` component
     * therefore makes EVERY row of the run non-reclassifiable. That is
     * deliberate rather than incidental — see the `verboseLog` below — because
     * the alternative launders the R4 hole: an instruction-only candidate that
     * drives the shared evolved AST into budget errors or bad tool calls would
     * have exactly those rows dropped from its own denominator.
     */
    const kindsForCfg = (
      cfg: Readonly<Record<string, string>>
    ): readonly string[] => {
      const kinds = new Set<string>();
      for (const target of targets) {
        if (typeof cfg[target.id] === 'string') kinds.add(target.kind);
      }
      return [...kinds];
    };
    const minibatchStrategy =
      ownDataOption<AxMinibatchStrategy>('minibatchStrategy') ?? 'uniform';
    const discriminationOptions =
      minibatchStrategy === 'discriminative'
        ? axResolveTaskDiscriminationOptions(
            ownDataOption<AxTaskDiscriminationOptions>('taskDiscrimination')
          )
        : undefined;
    // The sampler only replaces the MINIBATCH draw, so it is inert when GEPA is
    // evaluating the whole feedback set every round.
    const discriminativeEnabled =
      discriminationOptions !== undefined &&
      this.minibatch &&
      effectiveFeedbackSet.length >= 1;
    const statTable: AxTaskStatTable | undefined = discriminativeEnabled
      ? axCreateTaskStatTable(
          effectiveFeedbackSet.length,
          discriminationOptions!
        )
      : undefined;
    const discriminativeBatchSize = Math.max(
      1,
      Math.min(this.minibatchSize, effectiveFeedbackSet.length)
    );
    const inclusionSnapshots: AxTaskInclusionSnapshot[] = [];
    let omittedInclusionSnapshots = 0;
    let discriminativeIterations = 0;
    let announcedEstimator = false;
    let runAdmission: AxTrajectoryAdmissionReport | undefined;
    let admissionCeilingFired = false;
    /**
     * Per-row admitted mask for a completed evaluation, positionally parallel
     * to `AxGEPABatchEvaluation.scalars`. `undefined` when no classifier ran,
     * which is what keeps every legacy comparison character-identical.
     */
    const admittedMask = (
      evaluation: Readonly<AxGEPABatchEvaluation>
    ): readonly boolean[] | undefined => {
      if (!evaluation.admittedIndices) return undefined;
      const admitted = new Set(evaluation.admittedIndices);
      return evaluation.scalars.map((_, index) => admitted.has(index));
    };
    const sumOverIndices = (
      indices: readonly number[],
      scalars: readonly number[]
    ): number =>
      indices.reduce((total, index) => total + (scalars[index] ?? 0), 0);

    /**
     * One discriminative minibatch draw.
     *
     * Exactly one `this.rand()` value is consumed, by `axSampleByInclusion`'s
     * Madow systematic pass — the epoch shuffler is not run at all on this
     * path. The stream therefore differs from a uniform run of the same seed by
     * construction, which is why the strategy is opt-in and why INV-L5 asserts
     * the draw COUNT on the uniform path rather than the resulting indices.
     */
    const drawDiscriminativeIndices = (
      iteration: number
    ): Readonly<{
      indices: readonly number[];
      inclusions: readonly AxTaskInclusion[];
      snapshot: AxTaskInclusionSnapshot;
    }> => {
      const inclusions = axComputeInclusionProbabilities(
        statTable!.stats(),
        discriminativeBatchSize,
        discriminationOptions!
      );
      const indices = axSampleByInclusion(
        inclusions,
        discriminativeBatchSize,
        () => this.rand()
      );
      discriminativeIterations += 1;
      // Index-ascending truncation, not top-probability: a stable slice keeps
      // successive snapshots comparable to one another, and the run-level bound
      // exists to stop an artifact growing past the size at which it can be
      // re-validated.
      const reported = inclusions.slice(
        0,
        discriminationOptions!.maxReportedTasks
      );
      const snapshot: AxTaskInclusionSnapshot = Object.freeze({
        iteration,
        strategy: 'discriminative' as const,
        batchSize: discriminativeBatchSize,
        taskCount: inclusions.length,
        inclusions: reported,
        omittedTaskCount: inclusions.length - reported.length,
        sampledIndices: indices,
      });
      if (
        inclusionSnapshots.length < discriminationOptions!.maxInclusionSnapshots
      ) {
        inclusionSnapshots.push(snapshot);
      } else {
        omittedInclusionSnapshots += 1;
      }
      return { indices, inclusions, snapshot };
    };

    /**
     * Feed the per-task table from ONE evaluation.
     *
     * Called only from the parent and child minibatch sites: those two are the
     * phases that produce a paired comparison on the feedback set. A merge
     * subsample, a merge validation, the seed evaluation and the Pareto
     * evaluations are keyed to a different set and must never advance a trial
     * count. Discarded rows are skipped — an environment failure is not
     * evidence about task difficulty either.
     */
    const recordTaskStats = (
      evaluation: Readonly<AxGEPABatchEvaluation>,
      iteration: number
    ): void => {
      if (!statTable || !evaluation.exampleIndices) return;
      const admitted = evaluation.admittedIndices
        ? new Set(evaluation.admittedIndices)
        : undefined;
      for (const [rowIndex, scalar] of evaluation.scalars.entries()) {
        if (admitted && !admitted.has(rowIndex)) continue;
        const taskIndex = evaluation.exampleIndices[rowIndex];
        if (taskIndex === undefined) continue;
        statTable.record(taskIndex, scalar, iteration);
      }
    };

    const buildDiscriminationSummary = ():
      | AxTaskDiscriminationSummary
      | undefined => {
      if (!statTable || !discriminationOptions) return undefined;
      const finalStats = statTable
        .stats()
        .slice(0, discriminationOptions.maxReportedTasks);
      const sampled = statTable.stats().filter((stat) => stat.trials > 0);
      const nonDiscriminative = sampled.filter(
        (stat) => stat.successes === 0 || stat.successes === stat.trials
      ).length;
      const rest = {
        strategy: 'discriminative' as const,
        iterations: discriminativeIterations,
        snapshots: inclusionSnapshots,
        omittedSnapshotCount: omittedInclusionSnapshots,
        // Denominator is the tasks that were actually sampled: a task with no
        // recorded trial is not evidence that the sampler had nothing to
        // concentrate on.
        nonDiscriminativeTaskFraction:
          sampled.length === 0 ? 0 : nonDiscriminative / sampled.length,
        finalStats,
      };
      return Object.freeze({
        ...rest,
        // Measured over the summary WITHOUT this field, so the number does not
        // depend on its own width.
        serializedBytes: new TextEncoder().encode(JSON.stringify(rest))
          .byteLength,
      });
    };
    const lineageEnabled =
      lineageInput === true ||
      (typeof lineageInput === 'object' && lineageInput !== null);
    const lineageOptions = lineageEnabled
      ? resolveGEPALineageOptions(
          lineageInput === true ? undefined : lineageInput
        )
      : undefined;
    const lineageRecords: AxGEPACandidateLineageRecord[] = [];
    let omittedLineageRecords = 0;
    let lineageRetentionExhausted = false;
    let nextCandidateId = 0;
    let stoppedReason: AxGEPACandidateLineageManifest['stoppedReason'] =
      'completed';
    let terminationPhase = 'num_trials_exhausted';
    let terminationRound = this.numTrials;
    /**
     * Record why the run stopped, ONCE.
     *
     * `'excessive_environment_failures'` is terminal: the run has already been
     * declared unpublishable, and the loop can still walk through an
     * early-stopping check or a budget-exhausted candidate on its way out. A
     * later reason would overwrite the only signal a reader has that the
     * classifier — not the search — ended the run.
     */
    const markRunStopped = (
      reason: AxGEPACandidateLineageManifest['stoppedReason'],
      phase: string,
      round: number
    ): void => {
      if (stoppedReason === 'excessive_environment_failures') return;
      stoppedReason = reason;
      terminationPhase = phase;
      terminationRound = round;
    };
    /**
     * Trial the loop is currently inside, 1-based; 0 before the loop starts.
     * `this.currentRound` is only advanced once a candidate reaches a decision,
     * so it cannot name the round an evaluation-time failure happened in.
     */
    let currentTrialRound = 0;

    const candidateEvaluation = lineageEnabled
      ? (
          phase: string,
          evaluation: Readonly<AxGEPABatchEvaluation>,
          metricCallsBefore: number
        ): AxGEPACandidateEvaluation => ({
          phase,
          objectives: Object.fromEntries(
            Object.entries(evaluation.avg).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          ),
          scalarScore: average(evaluation.scalars),
          metricCallsBefore,
          metricCallsAfter: evaluationState.totalCalls,
          metricCallBudget: rolloutBudgetPareto,
          evaluatedExamples: evaluation.scalars.length,
        })
      : undefined;

    const evaluationFailures = lineageEnabled
      ? (
          evaluation: Readonly<AxGEPABatchEvaluation> | undefined
        ): AxGEPACandidateFailure[] =>
          (evaluation?.failures ?? []).map((failure) =>
            buildGEPACandidateFailure(
              failure.kind,
              failure.message,
              lineageOptions!
            )
          )
      : undefined;

    const recordCandidate = lineageEnabled
      ? (buildRecord: () => AxGEPACandidateLineageRecord): void => {
          const record = buildRecord();
          if (
            !lineageRetentionExhausted &&
            lineageRecords.length < lineageOptions!.maxRecords
          ) {
            lineageRecords.push(record);
          } else {
            lineageRetentionExhausted = true;
            omittedLineageRecords += 1;
          }
        }
      : undefined;
    const verboseLog =
      ((options as any)?.verbose ?? this.verbose)
        ? (msg: string) => console.log(`[GEPA] ${msg}`)
        : (_msg: string) => {};

    // Stated rather than silently ignored: an option that does nothing is worse
    // than an option that refuses, and these are the two shapes where the
    // sampler is reachable in the type system but inert at runtime.
    if (discriminationOptions && !this.minibatch) {
      verboseLog(
        "minibatchStrategy: 'discriminative' was requested but minibatch is off, so every round already evaluates the whole feedback set and there is nothing to sample; the strategy is inert and no discrimination summary is emitted"
      );
    }
    if (
      admissionOptions &&
      targets.some((target) => target.kind === 'program-source')
    ) {
      verboseLog(
        'trajectoryTermination is inert for this program: it declares a program-source component, so every candidate carries that kind and Ax overrides every host environment_failure to policy_failure. No row of this run can be discarded; the overrides are counted in admission.overriddenRows'
      );
    }
    if (
      discriminativeEnabled &&
      this.minibatchSize > effectiveFeedbackSet.length
    ) {
      verboseLog(
        `minibatchSize ${this.minibatchSize} exceeds the ${effectiveFeedbackSet.length}-task feedback set; the discriminative sampler draws DISTINCT tasks, so it uses ${effectiveFeedbackSet.length} where the uniform sampler pads with repeats`
      );
    }

    const gepaAdapter = (options as any)?.gepaAdapter as
      | AxGEPAAdapter
      | undefined;

    const evaluationState: AxGEPAEvaluationState = {
      totalCalls: this.stats.totalCalls,
      observedScoreKeys: new Set<string>(),
    };
    const stoppedCandidate = lineageEnabled
      ? (budgetReason: string, phase: string, round: number) => {
          const aborted = evaluationState.stopReason === 'aborted';
          markRunStopped(
            aborted ? 'aborted' : 'budget_exhausted',
            phase,
            round
          );
          return {
            reason: aborted ? 'abort_signal' : budgetReason,
            failure: buildGEPACandidateFailure(
              aborted ? 'abort' : 'budget',
              undefined,
              lineageOptions!
            ),
          } as const;
        }
      : undefined;
    let bootstrapMetricCalls = 0;

    const evalBatch = async (
      cfg: Readonly<Record<string, string>>,
      set: readonly AxTypedExample<IN>[],
      _phase: string,
      throwIfInsufficient = false,
      captureTraces = false,
      extra?: Readonly<{ exampleIndices?: readonly number[] }>
    ): Promise<AxGEPABatchEvaluation | undefined> => {
      const result = await evaluateGEPABatch({
        program,
        ai: this.studentAI,
        metricFn,
        adapter: gepaAdapter,
        cfg,
        set,
        phase: _phase,
        sampleCount: this.sampleCount,
        maxMetricCalls: rolloutBudgetPareto,
        state: evaluationState,
        applyConfig,
        validateConfig,
        scalarize,
        verboseLog,
        throwIfInsufficient,
        captureTraces,
        captureFailures: lineageEnabled,
        abortSignal: gepaAbortSignal,
        ...(admissionOptions
          ? {
              termination: {
                ...admissionOptions,
                affectedKinds: kindsForCfg(cfg),
              },
            }
          : {}),
        ...(extra?.exampleIndices
          ? { exampleIndices: extra.exampleIndices }
          : {}),
      });
      this.stats.totalCalls = bootstrapMetricCalls + evaluationState.totalCalls;
      // A per-batch admitted floor alone cannot catch a classifier that
      // discards just under the floor on every batch forever, so the run-level
      // discard rate is accumulated here, at the single point every evaluation
      // passes through.
      if (result?.admission && admissionOptions) {
        runAdmission = runAdmission
          ? axMergeTrajectoryAdmission(runAdmission, result.admission)
          : result.admission;
        if (
          !admissionCeilingFired &&
          axExceedsRunDiscardCeiling(runAdmission, admissionOptions)
        ) {
          admissionCeilingFired = true;
          // Set here, at the one point the ceiling can be raised, rather than
          // at the loop checkpoints that react to it: the ceiling can also
          // cross during a final validation evaluation or after an
          // early-stopping break, and those paths leave the loop without
          // passing another checkpoint.
          markRunStopped(
            'excessive_environment_failures',
            _phase.toLowerCase().replace(/\s+/g, '_'),
            currentTrialRound
          );
          verboseLog(
            `Run discard rate ${runAdmission.discardRate.toFixed(3)} exceeds maxRunDiscardRate ${admissionOptions.maxRunDiscardRate}; ending the run without publishing a best score`
          );
        }
      }
      return result;
    };

    const baseCfg: Record<string, string> = {};
    for (const target of targets) {
      baseCfg[target.id] = target.current;
    }

    const bootstrapOptions = resolveBootstrapOptions(
      (options as any)?.bootstrap,
      examples.length
    );
    let bootstrappedDemos: any[] = [];
    if (bootstrapOptions) {
      const bootstrapResult = await bootstrapGEPADemos({
        program,
        ai: this.studentAI,
        examples,
        metricFn,
        cfg: baseCfg,
        applyConfig,
        options: bootstrapOptions,
        state: evaluationState,
        sampleCount: this.sampleCount,
      });
      bootstrappedDemos = bootstrapResult.demos;
      bootstrapMetricCalls = bootstrapResult.metricCalls;
      this.stats.totalCalls = bootstrapMetricCalls;
      if (bootstrappedDemos.length > 0) {
        program.setDemos(bootstrappedDemos);
      }
    }

    const baseEvalCallsBefore = evaluationState.totalCalls;
    const baseEval = await evalBatch(
      baseCfg,
      paretoSet,
      'initial Pareto evaluation',
      true
    );
    if (!baseEval) {
      throw new Error('AxGEPA: optimization aborted before initial evaluation');
    }
    const candidates: {
      id?: string;
      cfg: Record<string, string>;
      parent?: number;
      scores: Record<string, number>;
    }[] = [
      {
        id: lineageEnabled ? `c${nextCandidateId++}` : undefined,
        cfg: { ...baseCfg },
        parent: undefined,
        scores: baseEval.avg,
      },
    ];

    const perInstanceScores: number[][] = [baseEval.scalars];
    /**
     * Kept in lockstep with `perInstanceScores`. The merge gate compares a
     * fresh subsample evaluation against these CACHED per-instance scores, so
     * without a matching admitted mask the two sides of that comparison can sit
     * on different denominators.
     */
    const perInstanceAdmitted: (readonly boolean[] | undefined)[] = [
      admittedMask(baseEval),
    ];

    optLogger?.({
      name: 'OptimizationStart',
      value: {
        optimizerType: 'GEPA',
        exampleCount: examples.length,
        validationCount: paretoSet.length,
        config: {
          numTrials: this.numTrials,
          minibatch: this.minibatch,
          mergeMax: this.mergeMax,
          tunableCount: targets.length,
        },
      },
    });

    recordCandidate?.(() => {
      const seedDelta = buildGEPACandidateComponentDelta(
        undefined,
        baseCfg,
        lineageOptions!
      );
      const failures = evaluationFailures!(baseEval);
      return {
        id: candidates[0]!.id!,
        parentIds: [],
        round: 0,
        strategy: 'seed',
        componentDelta: seedDelta.delta,
        omittedComponentCount: seedDelta.omittedComponentCount,
        evaluations: [
          candidateEvaluation!('initial_pareto', baseEval, baseEvalCallsBefore),
        ],
        metricCallsAtDecision: this.stats.totalCalls,
        metricCallBudget: rolloutBudgetPareto,
        decision: 'accepted',
        reason: 'initial_candidate',
        disposition: 'archived',
        failures: failures.length ? failures : undefined,
      };
    });

    verboseLog(
      `Starting GEPA optimization: ${examples.length} train, ${paretoSet.length} validation, maxCalls=${rolloutBudgetPareto}`
    );

    let stagnation = 0;
    const triedMerges = new Set<string>();

    // Initialize Pareto archive (indices into candidates)
    let archive = buildParetoFront(
      candidates.map((c, idx) => ({ idx, scores: c.scores })),
      this.tieEpsilon
    ).map((p) => p.idx);

    const buildLineageManifest = (
      selectedCandidateIdx?: number,
      extra?: Readonly<{ terminal?: boolean }>
    ): AxGEPACandidateLineageManifest | undefined => {
      if (!lineageEnabled) return undefined;
      const selectedCandidateId =
        selectedCandidateIdx === undefined
          ? undefined
          : candidates[selectedCandidateIdx]?.id;
      const fullParetoIds = new Set(archive.map((idx) => candidates[idx]!.id!));
      let records = lineageRecords.map((record) => ({
        ...record,
        disposition:
          record.decision === 'rejected'
            ? ('rejected' as const)
            : record.decision === 'aborted'
              ? ('aborted' as const)
              : record.id === selectedCandidateId
                ? ('selected' as const)
                : fullParetoIds.has(record.id)
                  ? ('pareto' as const)
                  : ('archived' as const),
        dispositionReason:
          record.decision === 'rejected'
            ? record.reason
            : record.decision === 'aborted'
              ? record.reason
              : record.id === selectedCandidateId
                ? 'selected_by_scalarized_frontier_score'
                : fullParetoIds.has(record.id)
                  ? 'retained_on_pareto_frontier'
                  : 'not_on_final_pareto_frontier',
      }));
      let omittedRecordCount = omittedLineageRecords;
      /**
       * "No candidate selected" and "the run terminated without publishing
       * one" are different states and only the first is `in_progress`. The run
       * discard ceiling produces the second: it suppresses `bestCandidateIdx`
       * BY DESIGN, so keying the manifest on a missing selection alone would
       * erase the one reason a reader needs — and would label a terminated run
       * a periodic snapshot.
       */
      const inProgress =
        selectedCandidateIdx === undefined && extra?.terminal !== true;
      const makeManifest = (): AxGEPACandidateLineageManifest => {
        const retainedIds = new Set(records.map((record) => record.id));
        return {
          version: 1,
          records,
          maxRecords: lineageOptions!.maxRecords,
          maxArtifactBytes: lineageOptions!.maxArtifactBytes,
          omittedRecordCount,
          selectedCandidateId,
          selectedCandidateRetained:
            selectedCandidateId !== undefined &&
            retainedIds.has(selectedCandidateId),
          paretoCandidateIds: [...fullParetoIds].filter((id) =>
            retainedIds.has(id)
          ),
          metricCallsUsed: this.stats.totalCalls,
          metricCallBudget: rolloutBudgetPareto,
          stoppedReason: inProgress ? 'in_progress' : stoppedReason,
          termination: {
            phase: inProgress ? 'checkpoint_snapshot' : terminationPhase,
            round: inProgress ? this.currentRound : terminationRound,
            metricCallsUsed: this.stats.totalCalls,
          },
          checkpointSemantics: 'snapshot_only',
          privacy: {
            componentValues: lineageOptions!.includeComponentValues
              ? 'bounded_values'
              : 'fingerprints',
            failureMessages: lineageOptions!.includeFailureMessages
              ? 'bounded_messages'
              : 'fingerprints',
          },
        };
      };
      let manifest = makeManifest();
      const encoder = new TextEncoder();
      let serialized = JSON.stringify(manifest);
      let serializedBytes = encoder.encode(serialized).byteLength;
      while (
        serializedBytes > lineageOptions!.maxArtifactBytes &&
        records.length > 0
      ) {
        const dropIndex = chooseByteBoundDropIndex(
          records,
          selectedCandidateId
        );
        records = records.filter((_, index) => index !== dropIndex);
        omittedRecordCount += 1;
        manifest = makeManifest();
        serialized = JSON.stringify(manifest);
        serializedBytes = encoder.encode(serialized).byteLength;
      }
      if (serializedBytes > lineageOptions!.maxArtifactBytes) {
        throw new Error(
          `AxGEPA: candidate lineage metadata exceeds maxArtifactBytes=${lineageOptions!.maxArtifactBytes}`
        );
      }
      return freezeGEPACandidateLineageManifest(manifest);
    };

    let _prevHypervolume: number | undefined;

    for (let t = 0; t < this.numTrials; t++) {
      currentTrialRound = t + 1;
      // `markRunStopped` already recorded the phase the ceiling fired in, which
      // is more informative than this checkpoint; the checkpoint only breaks.
      if (admissionCeilingFired) break;
      if (gepaAbortSignal?.aborted) {
        markRunStopped('aborted', 'loop_boundary', t);
        break;
      }
      if (
        rolloutBudgetPareto !== undefined &&
        this.stats.totalCalls >= Math.max(1, Math.floor(rolloutBudgetPareto))
      ) {
        markRunStopped('budget_exhausted', 'loop_boundary', t);
        break;
      }
      // Parent selection via per-instance fronts (frequency sampling)
      const nInst = perInstanceScores[0]?.length ?? 0;
      const instanceFronts: Array<Set<number>> = [];
      for (let i = 0; i < nInst; i++) {
        let best = Number.NEGATIVE_INFINITY;
        const front = new Set<number>();
        for (let k = 0; k < perInstanceScores.length; k++) {
          const v = perInstanceScores[k]![i]!;
          if (v > best + this.tieEpsilon) {
            best = v;
            front.clear();
            front.add(k);
          } else if (Math.abs(v - best) <= this.tieEpsilon) {
            front.add(k);
          }
        }
        instanceFronts.push(front);
      }
      const perProgScores = perInstanceScores.map((arr) => average(arr));

      // Scheduled merge attempt before reflective mutation.
      if (
        this.mergeMax > 0 &&
        this.mergesDue > 0 &&
        this.lastIterFoundNewProgram
      ) {
        const ancestors = (idx: number): number[] => {
          const path: number[] = [];
          let cur: number | undefined = idx;
          while (cur !== undefined) {
            path.push(cur);
            cur = candidates[cur]?.parent;
          }
          return path;
        };
        const rngPick = <T>(arr: readonly T[]): T | undefined =>
          arr.length ? arr[Math.floor(this.rand() * arr.length)]! : undefined;
        // Merge candidates = union of reduced instance fronts
        const reducedFronts = removeDominatedProgramsByInstanceFronts(
          instanceFronts,
          perProgScores
        );
        const mergeCandidatesSet = new Set<number>();
        for (const f of reducedFronts)
          for (const p of f) mergeCandidatesSet.add(p);
        const mergeCandidates = Array.from(mergeCandidatesSet);

        let picked: { i: number; j: number; a: number } | undefined;
        for (let attempts = 0; attempts < 10 && !picked; attempts++) {
          if (mergeCandidates.length < 2) break;
          let i = rngPick(mergeCandidates)!;
          let j = rngPick(mergeCandidates)!;
          if (i === j) continue;
          if (j < i) [i, j] = [j, i];
          const Ai = new Set(ancestors(i));
          const Aj = new Set(ancestors(j));
          if (Ai.has(j) || Aj.has(i)) continue;
          const commons = [...Ai].filter((x) => Aj.has(x));
          if (commons.length === 0) continue;

          const desirables: number[] = [];
          for (const ancestor of commons) {
            const cfgA = candidates[ancestor]!.cfg;
            const cfgI = candidates[i]!.cfg;
            const cfgJ = candidates[j]!.cfg;
            let ok = false;
            const allKeys = new Set([
              ...Object.keys(cfgA),
              ...Object.keys(cfgI),
              ...Object.keys(cfgJ),
            ]);
            for (const key of allKeys) {
              const pa = cfgA[key];
              const pi = cfgI[key];
              const pj = cfgJ[key];
              if ((pi === pa && pj !== pi) || (pj === pa && pi !== pj)) {
                ok = true;
                break;
              }
            }
            if (ok) desirables.push(ancestor);
          }
          if (desirables.length === 0) continue;

          const weights = desirables.map((ancestor) =>
            Math.max(1e-9, perProgScores[ancestor]!)
          );
          let r = this.rand() * weights.reduce((s, w) => s + w, 0);
          let a = desirables[desirables.length - 1]!;
          for (let idx = 0; idx < desirables.length; idx++) {
            if (r < weights[idx]!) {
              a = desirables[idx]!;
              break;
            }
            r -= weights[idx]!;
          }
          picked = { i, j, a };
        }

        // Clear scheduling flag before reflective attempt (parity)
        this.lastIterFoundNewProgram = false;

        if (picked) {
          let mergeAccepted = false;
          const { i, j, a } = picked;
          // Ancestor guard + desirability filter for single-component merge
          const Sa = perProgScores[a]!;
          const Si = perProgScores[i]!;
          const Sj = perProgScores[j]!;
          if (Sa > Math.min(Si, Sj)) continue;
          const triKey = `${i}|${j}|${a}`;
          if (this.mergeAttemptKeys.has(triKey)) continue;
          this.mergeAttemptKeys.add(triKey);
          if (triedMerges.has(triKey)) continue;

          const { cfg: mergedCfg, descSig } = this.systemAwareMergeWithSig(
            candidates,
            i,
            j,
            (ia, ib) => (perProgScores[ia]! >= perProgScores[ib]! ? ia : ib)
          );
          const mergeCandidateId = lineageEnabled
            ? `c${nextCandidateId++}`
            : undefined;
          const mergeEvaluations: AxGEPACandidateEvaluation[] | undefined =
            lineageEnabled ? [] : undefined;
          const mergeFailures: AxGEPACandidateFailure[] | undefined =
            lineageEnabled ? [] : undefined;
          const compKey = `${Math.min(i, j)}|${Math.max(i, j)}|${descSig}`;
          if (this.mergeCompositionKeys.has(compKey)) continue;
          this.mergeCompositionKeys.add(compKey);

          const s1 = perInstanceScores[i]!;
          const s2 = perInstanceScores[j]!;
          const allIdx = Array.from({ length: s1.length }, (_, z) => z);
          const p1 = allIdx.filter((z) => (s1[z] ?? 0) > (s2[z] ?? 0));
          const p2 = allIdx.filter((z) => (s2[z] ?? 0) > (s1[z] ?? 0));
          const p3 = allIdx.filter((z) => !(p1.includes(z) || p2.includes(z)));
          const K = 5;
          const nEach = Math.ceil(K / 3);
          const pickSome = (arr: number[], k: number): number[] => {
            if (k <= 0 || arr.length === 0) return [];
            if (arr.length <= k) return [...arr];
            const out: number[] = [];
            const used = new Set<number>();
            while (out.length < k) {
              const idx = Math.floor(this.rand() * arr.length);
              if (!used.has(idx)) {
                used.add(idx);
                out.push(arr[idx]!);
              }
            }
            return out;
          };
          const chosen: number[] = [];
          chosen.push(...pickSome(p1, Math.min(nEach, p1.length)));
          chosen.push(...pickSome(p2, Math.min(nEach, p2.length)));
          const rem = K - chosen.length;
          chosen.push(...pickSome(p3, Math.max(0, rem)));
          const remaining = K - chosen.length;
          if (remaining > 0) {
            const unused = allIdx.filter((z) => !chosen.includes(z));
            chosen.push(
              ...pickSome(unused, Math.min(remaining, unused.length))
            );
          }
          const idxs = chosen.slice(0, Math.min(K, allIdx.length));
          const subsample = idxs.map((z) => paretoSet[z]!);
          const mergeEvalCallsBefore = evaluationState.totalCalls;
          const mergeEval = await evalBatch(
            mergedCfg,
            subsample as readonly AxTypedExample<IN>[],
            'merge subsample'
          );
          if (!mergeEval) {
            if (lineageEnabled) {
              const stopped = stoppedCandidate!(
                'metric_call_budget_exhausted',
                'merge_subsample',
                t + 1
              );
              recordCandidate?.(() => {
                const delta = buildGEPACandidateComponentDelta(
                  candidates[a]!.cfg,
                  mergedCfg,
                  lineageOptions!
                );
                return {
                  id: mergeCandidateId!,
                  parentIds: [candidates[i]!.id!, candidates[j]!.id!],
                  commonAncestorId: candidates[a]!.id!,
                  round: t + 1,
                  strategy: 'system_merge',
                  componentDelta: delta.delta,
                  omittedComponentCount: delta.omittedComponentCount,
                  evaluations: mergeEvaluations!,
                  metricCallsAtDecision: this.stats.totalCalls,
                  metricCallBudget: rolloutBudgetPareto,
                  decision: 'aborted',
                  reason: stopped.reason,
                  disposition: 'aborted',
                  failures: [stopped.failure],
                };
              });
            }
            break;
          }
          mergeEvaluations?.push(
            candidateEvaluation!(
              'merge_subsample',
              mergeEval,
              mergeEvalCallsBefore
            )
          );
          mergeFailures?.push(...evaluationFailures!(mergeEval));

          if (mergeEval.admission?.inconclusive) {
            verboseLog(
              `Iteration ${t + 1}: merge subsample inconclusive (${mergeEval.admission.admittedRows}/${mergeEval.admission.evaluatedRows} rows admitted); aborting the merge candidate`
            );
            recordCandidate?.(() => {
              const delta = buildGEPACandidateComponentDelta(
                candidates[a]!.cfg,
                mergedCfg,
                lineageOptions!
              );
              return {
                id: mergeCandidateId!,
                parentIds: [candidates[i]!.id!, candidates[j]!.id!],
                commonAncestorId: candidates[a]!.id!,
                round: t + 1,
                strategy: 'system_merge',
                componentDelta: delta.delta,
                omittedComponentCount: delta.omittedComponentCount,
                evaluations: mergeEvaluations!,
                metricCallsAtDecision: this.stats.totalCalls,
                metricCallBudget: rolloutBudgetPareto,
                decision: 'aborted',
                reason: 'insufficient_admitted_rows',
                disposition: 'aborted',
                failures: mergeFailures!.length ? mergeFailures : undefined,
              };
            });
            continue;
          }

          // GATE 2 (system merge). Its denominator is the subsample positions
          // admitted by the fresh merge evaluation AND by both parents' cached
          // validation evaluations. Without the intersection, dropping k rows
          // from one side lowers only that side's raw total and the merge is
          // decided by whichever evaluation a flaky provider hit hardest.
          // With no classifier every mask is absent, `mergeComparisonPositions`
          // is `0..idxs.length-1` in order, and all three sums reduce in the
          // same order from the same seed as before — character-identical.
          const mergeComparisonPositions: readonly number[] =
            mergeEval.admittedIndices === undefined
              ? idxs.map((_, position) => position)
              : (() => {
                  const positionByIndex = new Map(
                    idxs.map((z, position) => [z, position] as const)
                  );
                  const admittedParetoIndices = (
                    mask: readonly boolean[] | undefined
                  ): readonly number[] =>
                    mask ? idxs.filter((z) => mask[z] === true) : idxs;
                  return axPairedAdmittedIndices(
                    axPairedAdmittedIndices(
                      mergeEval.admittedIndices.map(
                        (position) => idxs[position]!
                      ),
                      admittedParetoIndices(perInstanceAdmitted[i])
                    ),
                    admittedParetoIndices(perInstanceAdmitted[j])
                  ).map((z) => positionByIndex.get(z)!);
                })();
          // Fail closed. `newSum >= Math.max(0, 0) + 0` is TRUE, so an empty
          // denominator would promote a merge on no evidence at all — and an
          // empty intersection is reachable even when the merge evaluation
          // itself cleared `minAdmittedFraction`, because the two parents'
          // cached masks can exclude everything it kept.
          if (
            mergeEval.admittedIndices !== undefined &&
            mergeComparisonPositions.length === 0
          ) {
            verboseLog(
              `Iteration ${t + 1}: merge subsample shares no admitted row with both parents; aborting the merge candidate`
            );
            recordCandidate?.(() => {
              const delta = buildGEPACandidateComponentDelta(
                candidates[a]!.cfg,
                mergedCfg,
                lineageOptions!
              );
              return {
                id: mergeCandidateId!,
                parentIds: [candidates[i]!.id!, candidates[j]!.id!],
                commonAncestorId: candidates[a]!.id!,
                round: t + 1,
                strategy: 'system_merge',
                componentDelta: delta.delta,
                omittedComponentCount: delta.omittedComponentCount,
                evaluations: mergeEvaluations!,
                metricCallsAtDecision: this.stats.totalCalls,
                metricCallBudget: rolloutBudgetPareto,
                decision: 'aborted',
                reason: 'insufficient_admitted_rows',
                disposition: 'aborted',
                failures: mergeFailures!.length ? mergeFailures : undefined,
              };
            });
            continue;
          }
          const newSum = mergeComparisonPositions.reduce(
            (sum, position) => sum + (mergeEval.scalars[position] ?? 0),
            0
          );
          const id1Sum = mergeComparisonPositions.reduce(
            (sum, position) => sum + (s1[idxs[position]!] ?? 0),
            0
          );
          const id2Sum = mergeComparisonPositions.reduce(
            (sum, position) => sum + (s2[idxs[position]!] ?? 0),
            0
          );

          if (
            newSum >=
            Math.max(id1Sum, id2Sum) + this.minImprovementThreshold
          ) {
            verboseLog(
              `Iteration ${t + 1}: Merge accepted (programs ${i} + ${j} via ancestor ${a})`
            );
            const childEvalCallsBefore = evaluationState.totalCalls;
            const childEval = await evalBatch(
              mergedCfg,
              paretoSet,
              'merge validation'
            );
            if (!childEval) {
              if (lineageEnabled) {
                const stopped = stoppedCandidate!(
                  'validation_budget_exhausted',
                  'merge_validation',
                  t + 1
                );
                recordCandidate?.(() => {
                  const delta = buildGEPACandidateComponentDelta(
                    candidates[a]!.cfg,
                    mergedCfg,
                    lineageOptions!
                  );
                  return {
                    id: mergeCandidateId!,
                    parentIds: [candidates[i]!.id!, candidates[j]!.id!],
                    commonAncestorId: candidates[a]!.id!,
                    round: t + 1,
                    strategy: 'system_merge',
                    componentDelta: delta.delta,
                    omittedComponentCount: delta.omittedComponentCount,
                    evaluations: mergeEvaluations!,
                    metricCallsAtDecision: this.stats.totalCalls,
                    metricCallBudget: rolloutBudgetPareto,
                    decision: 'aborted',
                    reason: stopped.reason,
                    disposition: 'aborted',
                    failures: [...mergeFailures!, stopped.failure],
                  };
                });
              }
              break;
            }
            mergeEvaluations?.push(
              candidateEvaluation!(
                'merge_validation',
                childEval,
                childEvalCallsBefore
              )
            );
            mergeFailures?.push(...evaluationFailures!(childEval));
            candidates.push({
              id: mergeCandidateId,
              cfg: { ...mergedCfg },
              parent: a,
              scores: childEval.avg,
            });
            perInstanceScores.push(childEval.scalars);
            perInstanceAdmitted.push(admittedMask(childEval));
            const beforeSize = archive.length;
            const hvBefore =
              hypervolume2D(archive.map((idx) => candidates[idx]!.scores)) ?? 0;
            archive = buildParetoFront(
              candidates.map((c, idx) => ({ idx, scores: c.scores })),
              this.tieEpsilon
            ).map((p) => p.idx);
            const hvAfter =
              hypervolume2D(archive.map((idx) => candidates[idx]!.scores)) ?? 0;
            if (archive.length > beforeSize || hvAfter > hvBefore + 1e-6) {
              stagnation = 0;
            }
            this.mergesDue -= 1;
            this.totalMergesTested += 1;
            triedMerges.add(triKey);
            mergeAccepted = true;
            recordCandidate?.(() => {
              const delta = buildGEPACandidateComponentDelta(
                candidates[a]!.cfg,
                mergedCfg,
                lineageOptions!
              );
              return {
                id: mergeCandidateId!,
                parentIds: [candidates[i]!.id!, candidates[j]!.id!],
                commonAncestorId: candidates[a]!.id!,
                round: t + 1,
                strategy: 'system_merge',
                componentDelta: delta.delta,
                omittedComponentCount: delta.omittedComponentCount,
                evaluations: mergeEvaluations!,
                metricCallsAtDecision: this.stats.totalCalls,
                metricCallBudget: rolloutBudgetPareto,
                decision: 'accepted',
                reason: 'improved_over_both_parents',
                disposition: 'archived',
                failures: mergeFailures!.length ? mergeFailures : undefined,
              };
            });
          }
          if (mergeAccepted) {
            continue;
          }
          recordCandidate?.(() => {
            const delta = buildGEPACandidateComponentDelta(
              candidates[a]!.cfg,
              mergedCfg,
              lineageOptions!
            );
            return {
              id: mergeCandidateId!,
              parentIds: [candidates[i]!.id!, candidates[j]!.id!],
              commonAncestorId: candidates[a]!.id!,
              round: t + 1,
              strategy: 'system_merge',
              componentDelta: delta.delta,
              omittedComponentCount: delta.omittedComponentCount,
              evaluations: mergeEvaluations!,
              metricCallsAtDecision: this.stats.totalCalls,
              metricCallBudget: rolloutBudgetPareto,
              decision: 'rejected',
              reason: 'insufficient_subsample_improvement',
              disposition: 'rejected',
              failures: mergeFailures!.length ? mergeFailures : undefined,
            };
          });
        }
      }

      const parentIdx = selectProgramCandidateFromInstanceFronts(
        instanceFronts,
        perProgScores,
        () => this.rand()
      );

      this.lastIterFoundNewProgram = false;

      const draw = discriminativeEnabled
        ? drawDiscriminativeIndices(t)
        : undefined;
      const miniIndices: readonly number[] = this.minibatch
        ? (draw?.indices ??
          this.nextMinibatchIndices(effectiveFeedbackSet.length, t))
        : effectiveFeedbackSet.map((_, index) => index);
      const mini = this.minibatch
        ? miniIndices.map((z: number) => effectiveFeedbackSet[z]!)
        : effectiveFeedbackSet;
      // The feedback-set indices are threaded only on the discriminative path:
      // the stat table is the only consumer, and the uniform path must not gain
      // a field it never had.
      const miniEvalExtra = discriminativeEnabled
        ? { exampleIndices: miniIndices }
        : undefined;

      const parentMiniEval = await evalBatch(
        candidates[parentIdx]!.cfg,
        mini as readonly AxTypedExample<IN>[],
        'parent minibatch',
        false,
        true,
        miniEvalExtra
      );
      if (!parentMiniEval) {
        if (lineageEnabled) {
          stoppedCandidate!(
            'metric_call_budget_exhausted',
            'parent_minibatch',
            t + 1
          );
        }
        break;
      }
      recordTaskStats(parentMiniEval, t);
      if (admissionCeilingFired) break;
      // Too few admitted rows means the batch cannot decide anything. No
      // candidate has been proposed yet at this point, so the round is skipped
      // rather than a candidate being recorded as rejected on evidence that
      // was never there.
      if (parentMiniEval.admission?.inconclusive) {
        verboseLog(
          `Iteration ${t + 1}: parent minibatch inconclusive (${parentMiniEval.admission.admittedRows}/${parentMiniEval.admission.evaluatedRows} rows admitted); skipping the round`
        );
        continue;
      }

      if ((options as any)?.skipPerfectScore ?? true) {
        const perfect = Number((options as any)?.perfectScore ?? 1);
        if (
          parentMiniEval.scalars.length > 0 &&
          parentMiniEval.scalars.every((score) => score >= perfect)
        ) {
          continue;
        }
      }

      const proposedCfg: Record<string, string> = {
        ...candidates[parentIdx]!.cfg,
      };
      const mutationCandidateId = lineageEnabled
        ? `c${nextCandidateId++}`
        : undefined;
      const mutationEvaluations: AxGEPACandidateEvaluation[] | undefined =
        lineageEnabled ? [] : undefined;
      const mutationFailures: AxGEPACandidateFailure[] | undefined =
        lineageEnabled ? [] : undefined;
      const strategy: 'reflective_mutation' | 'system_merge' =
        'reflective_mutation';
      const target = componentSelector.pick(t, () => this.rand());
      const targetGroup = getGEPAUpdateGroup(target, targets);
      for (const groupTarget of targetGroup) {
        componentSelector.recordProposal(groupTarget.id);
      }
      const adapter = gepaAdapter;

      const parentTuples = parentMiniEval.rows.map((row) => ({
        input: row.input,
        prediction: row.prediction,
        score: row.scalar,
        feedback: row.feedback,
      }));

      const parentEvaluationForAdapter = {
        outputs: parentMiniEval.rows.map((row) => row.prediction),
        scores: parentMiniEval.scalars,
        scoreVectors: parentMiniEval.rows.map((row) => row.scores),
        feedback: parentMiniEval.rows.map((row) => row.feedback),
        trajectories: parentMiniEval.trajectories,
      };

      const defaultReflectiveDataset = Object.fromEntries(
        targetGroup.map((groupTarget) => {
          const rows = (parentMiniEval.trajectories ?? [])
            .map((trace: any, index) => ({
              score: parentMiniEval.scalars[index] ?? 0,
              feedback: parentMiniEval.rows[index]?.feedback,
              calls: Array.isArray(trace?.calls) ? trace.calls : [],
              output: trace?.output,
              error: trace?.error,
            }))
            .filter((trace) => {
              if (!groupTarget.traceId) return true;
              return (
                trace.score === 0 ||
                trace.calls.some(
                  (call: any) => call?.componentId === groupTarget.traceId
                )
              );
            });
          return [groupTarget.id, rows];
        })
      );

      let reflectiveDataset = defaultReflectiveDataset;
      if (adapter) {
        try {
          reflectiveDataset = adapter.make_reflective_dataset(
            { ...candidates[parentIdx]!.cfg },
            parentEvaluationForAdapter as any,
            targetGroup.map((groupTarget) => groupTarget.id)
          );
          const proposedMap = (await adapter.propose_new_texts?.(
            { ...candidates[parentIdx]!.cfg },
            reflectiveDataset,
            targetGroup.map((groupTarget) => groupTarget.id)
          )) as Record<string, string> | undefined;
          if (proposedMap) {
            for (const groupTarget of targetGroup) {
              const raw = proposedMap[groupTarget.id];
              if (typeof raw !== 'string') continue;
              const proposed = raw.trim();
              if (
                proposed &&
                validateGEPAComponentValue(groupTarget, proposed) === true
              ) {
                proposedCfg[groupTarget.id] = proposed;
              }
            }
          }
        } catch (error) {
          if (lineageEnabled) {
            mutationFailures!.push(
              buildGEPACandidateFailure(
                'adapter',
                error instanceof Error ? error.message : String(error),
                lineageOptions!
              )
            );
          }
        }
      }

      for (const groupTarget of targetGroup) {
        if (
          proposedCfg[groupTarget.id] !==
          candidates[parentIdx]!.cfg[groupTarget.id]
        ) {
          continue;
        }
        const currentValue = candidates[parentIdx]!.cfg[groupTarget.id]!;
        proposedCfg[groupTarget.id] = await this.reflectTargetInstruction(
          groupTarget.id,
          currentValue,
          program,
          applyConfig,
          { ...candidates[parentIdx]!.cfg },
          mini,
          async ({ prediction, example }) =>
            scalarize(
              await normalizeGEPAScores(
                metricFn,
                prediction,
                example as AxExample
              )
            ),
          options,
          parentTuples,
          {
            kind: groupTarget.kind,
            description: groupTarget.description,
            constraints: groupTarget.constraints,
            traceDataset: reflectiveDataset[groupTarget.id],
            validate: groupTarget.validate,
            preserve: groupTarget.preserve,
            maxLength: groupTarget.maxLength,
            format: groupTarget.format,
          },
          lineageEnabled
            ? (failure) => {
                mutationFailures!.push(
                  buildGEPACandidateFailure(
                    failure.kind,
                    failure.message,
                    lineageOptions!
                  )
                );
              }
            : undefined
        );
      }

      const childMiniEvalCallsBefore = evaluationState.totalCalls;
      const childMiniEval = await evalBatch(
        proposedCfg,
        mini as readonly AxTypedExample<IN>[],
        'child minibatch',
        false,
        false,
        miniEvalExtra
      );
      if (!childMiniEval) {
        if (lineageEnabled) {
          const stopped = stoppedCandidate!(
            'metric_call_budget_exhausted',
            'child_minibatch',
            t + 1
          );
          recordCandidate?.(() => {
            const delta = buildGEPACandidateComponentDelta(
              candidates[parentIdx]!.cfg,
              proposedCfg,
              lineageOptions!
            );
            return {
              id: mutationCandidateId!,
              parentIds: [candidates[parentIdx]!.id!],
              round: t + 1,
              strategy,
              componentDelta: delta.delta,
              omittedComponentCount: delta.omittedComponentCount,
              evaluations: mutationEvaluations!,
              metricCallsAtDecision: this.stats.totalCalls,
              metricCallBudget: rolloutBudgetPareto,
              decision: 'aborted',
              reason: stopped.reason,
              disposition: 'aborted',
              failures: [...mutationFailures!, stopped.failure],
            };
          });
        }
        break;
      }
      recordTaskStats(childMiniEval, t);
      mutationEvaluations?.push(
        candidateEvaluation!(
          'child_minibatch',
          childMiniEval,
          childMiniEvalCallsBefore
        )
      );
      mutationFailures?.push(...evaluationFailures!(childMiniEval));

      // GATE 1 (reflective mutation). Parent and child are two separate
      // evaluations of the same minibatch, so they can discard different rows.
      // `sum` is a raw total: comparing each side's own admitted total means
      // dropping k rows from the parent lowers the parent's number while
      // leaving the child's untouched, and the child gets promoted for it.
      // Intersecting first gives both sides the same denominator by
      // construction. With no classifier both `admittedIndices` are absent and
      // the comparison below is the untouched
      // `childMiniEval.sum > parentMiniEval.sum + t`.
      const pairedMinibatchIndices =
        parentMiniEval.admittedIndices && childMiniEval.admittedIndices
          ? axPairedAdmittedIndices(
              parentMiniEval.admittedIndices,
              childMiniEval.admittedIndices
            )
          : undefined;
      // Never accepted, never rejected: an inconclusive batch is not evidence
      // either way, and treating it as a rejection would let a flaky provider
      // exhaust `earlyStoppingTrials`.
      //
      // An EMPTY intersection is the same situation and is checked separately,
      // because both sides can clear `minAdmittedFraction` individually and
      // still share no row — disjoint discards leave nothing to compare, and a
      // comparison of 0 against 0 is not a rejection, it is no evidence.
      if (
        childMiniEval.admission?.inconclusive ||
        pairedMinibatchIndices?.length === 0
      ) {
        verboseLog(
          `Iteration ${t + 1}: child minibatch inconclusive (${childMiniEval.admission?.admittedRows ?? 0}/${childMiniEval.admission?.evaluatedRows ?? 0} rows admitted, ${pairedMinibatchIndices?.length ?? 0} paired with the parent); aborting the candidate`
        );
        recordCandidate?.(() => {
          const delta = buildGEPACandidateComponentDelta(
            candidates[parentIdx]!.cfg,
            proposedCfg,
            lineageOptions!
          );
          return {
            id: mutationCandidateId!,
            parentIds: [candidates[parentIdx]!.id!],
            round: t + 1,
            strategy,
            componentDelta: delta.delta,
            omittedComponentCount: delta.omittedComponentCount,
            evaluations: mutationEvaluations!,
            metricCallsAtDecision: this.stats.totalCalls,
            metricCallBudget: rolloutBudgetPareto,
            decision: 'aborted',
            reason: 'insufficient_admitted_rows',
            disposition: 'aborted',
            failures: mutationFailures!.length ? mutationFailures : undefined,
          };
        });
        if (admissionCeilingFired) break;
        continue;
      }
      if (admissionCeilingFired) break;

      const parentComparisonSum = pairedMinibatchIndices
        ? sumOverIndices(pairedMinibatchIndices, parentMiniEval.scalars)
        : parentMiniEval.sum;
      const childComparisonSum = pairedMinibatchIndices
        ? sumOverIndices(pairedMinibatchIndices, childMiniEval.scalars)
        : childMiniEval.sum;
      const pairedComparisonRowIndices: readonly number[] =
        pairedMinibatchIndices ?? miniIndices.map((_, rowIndex) => rowIndex);
      /**
       * Under `'discriminative'` the batch is a πps sample, so a raw sum is a
       * biased estimate of the population difference: the easy tasks are
       * deliberately under-drawn. The Hájek/IPW paired difference weights each
       * row by `1/π` and is compared on a PER-EXAMPLE MEAN scale, not a sum.
       * With the
       * default `minImprovementThreshold` of 0 both scales mean "child beat
       * parent", so the default degrades gracefully; a caller who set a
       * non-zero sum-scale threshold must divide it by the batch size.
       */
      const ipwEstimate =
        draw && pairedComparisonRowIndices.length > 0
          ? axIpwPairedDifference(
              pairedComparisonRowIndices.map((rowIndex) => ({
                index: miniIndices[rowIndex]!,
                value: parentMiniEval.scalars[rowIndex] ?? 0,
              })),
              pairedComparisonRowIndices.map((rowIndex) => ({
                index: miniIndices[rowIndex]!,
                value: childMiniEval.scalars[rowIndex] ?? 0,
              })),
              draw.inclusions
            )
          : undefined;
      if (draw && !announcedEstimator) {
        announcedEstimator = true;
        verboseLog(
          `Discriminative minibatch active: gate=reflective_mutation estimator=ipw_hajek scale=per_example_mean; minImprovementThreshold=${this.minImprovementThreshold} is compared against a mean difference, not a sum`
        );
      }
      const accepted = ipwEstimate
        ? ipwEstimate.estimate > this.minImprovementThreshold
        : childComparisonSum >
          parentComparisonSum + this.minImprovementThreshold;

      this.currentRound = t + 1;
      const serializableCompileOptions = (() => {
        const { abortSignal: _abortSignal, ...rest } = (options ??
          {}) as AxCompileOptions & {
          abortSignal?: AbortSignal;
        };
        return rest;
      })();
      const publishDecision = async (
        decision: 'accepted' | 'rejected' | 'aborted'
      ) => {
        const progressConfiguration = {
          instructionLen: targetGroup
            .map((groupTarget) => proposedCfg[groupTarget.id]?.length ?? 0)
            .reduce((sum, length) => sum + length, 0),
          target: targetGroup.map((groupTarget) => groupTarget.id).join(','),
          parent: parentIdx,
          totalRounds: this.numTrials,
          ...(lineageEnabled
            ? {
                candidateId: mutationCandidateId,
                parentIds: [candidates[parentIdx]!.id!],
                strategy,
                decision,
              }
            : {}),
        };
        const checkpointLineage =
          lineageEnabled && this.shouldSaveCheckpoint(this.currentRound)
            ? buildLineageManifest()
            : undefined;
        await this.updateOptimizationProgress(
          this.currentRound,
          childMiniEval.sum,
          progressConfiguration,
          'GEPA',
          {
            strategy,
            paretoSetSize: paretoSet.length,
            tunableCount: targets.length,
          },
          childMiniEval.sum,
          {
            instructionLen: targetGroup
              .map(
                (groupTarget) =>
                  candidates[parentIdx]!.cfg[groupTarget.id]?.length ?? 0
              )
              .reduce((sum, length) => sum + length, 0),
            idx: parentIdx,
            ...(lineageEnabled
              ? { candidateId: candidates[parentIdx]!.id! }
              : {}),
          },
          {
            ...serializableCompileOptions,
            maxIterations: this.numTrials,
            ...(checkpointLineage
              ? { candidateLineage: checkpointLineage }
              : {}),
          },
          // `options` is deliberately not forwarded here: `totalRounds` on the
          // emitted RoundProgress has always been `options?.maxIterations ?? 0`
          // with no options, and changing it would break INV-L1.
          undefined,
          runAdmission || draw
            ? {
                ...(draw ? { inclusionSnapshot: draw.snapshot } : {}),
                ...(runAdmission ? { admission: runAdmission } : {}),
              }
            : undefined
        );
      };

      if (!accepted) {
        for (const groupTarget of targetGroup) {
          componentSelector.recordResult(groupTarget.id, false, t);
        }
        verboseLog(
          `Iteration ${t + 1}: Rejected (child=${childComparisonSum.toFixed(3)} <= parent=${parentComparisonSum.toFixed(3)})`
        );
        recordCandidate?.(() => {
          const delta = buildGEPACandidateComponentDelta(
            candidates[parentIdx]!.cfg,
            proposedCfg,
            lineageOptions!
          );
          return {
            id: mutationCandidateId!,
            parentIds: [candidates[parentIdx]!.id!],
            round: t + 1,
            strategy,
            componentDelta: delta.delta,
            omittedComponentCount: delta.omittedComponentCount,
            evaluations: mutationEvaluations!,
            metricCallsAtDecision: this.stats.totalCalls,
            metricCallBudget: rolloutBudgetPareto,
            decision: 'rejected',
            reason:
              delta.delta.length === 0
                ? 'no_component_change'
                : 'insufficient_minibatch_improvement',
            disposition: 'rejected',
            failures: mutationFailures!.length ? mutationFailures : undefined,
          };
        });
        await publishDecision('rejected');
        if (++stagnation >= this.earlyStoppingTrials) {
          markRunStopped('early_stopping', 'early_stopping', t + 1);
          verboseLog(
            `Early stopping: ${stagnation} iterations without improvement`
          );
          break;
        }
        continue;
      }

      verboseLog(
        `Iteration ${t + 1}: Accepted (child=${childComparisonSum.toFixed(3)} > parent=${parentComparisonSum.toFixed(3)})`
      );
      for (const groupTarget of targetGroup) {
        componentSelector.recordResult(groupTarget.id, true, t);
      }

      // Full evaluation on validation set (vector) and archive update
      const childEvalCallsBefore = evaluationState.totalCalls;
      const childEval = await evalBatch(
        proposedCfg,
        paretoSet,
        'validation evaluation'
      );
      if (!childEval) {
        if (lineageEnabled) {
          const stopped = stoppedCandidate!(
            'validation_budget_exhausted',
            'validation',
            t + 1
          );
          recordCandidate?.(() => {
            const delta = buildGEPACandidateComponentDelta(
              candidates[parentIdx]!.cfg,
              proposedCfg,
              lineageOptions!
            );
            return {
              id: mutationCandidateId!,
              parentIds: [candidates[parentIdx]!.id!],
              round: t + 1,
              strategy,
              componentDelta: delta.delta,
              omittedComponentCount: delta.omittedComponentCount,
              evaluations: mutationEvaluations!,
              metricCallsAtDecision: this.stats.totalCalls,
              metricCallBudget: rolloutBudgetPareto,
              decision: 'aborted',
              reason: stopped.reason,
              disposition: 'aborted',
              failures: [...mutationFailures!, stopped.failure],
            };
          });
          await publishDecision('aborted');
        }
        break;
      }
      mutationEvaluations?.push(
        candidateEvaluation!('validation', childEval, childEvalCallsBefore)
      );
      mutationFailures?.push(...evaluationFailures!(childEval));
      candidates.push({
        id: mutationCandidateId,
        cfg: { ...proposedCfg },
        parent: parentIdx,
        scores: childEval.avg,
      });
      perInstanceScores.push(childEval.scalars);
      perInstanceAdmitted.push(admittedMask(childEval));

      const beforeSize = archive.length;
      const hvBefore =
        hypervolume2D(archive.map((idx) => candidates[idx]!.scores)) ?? 0;
      archive = buildParetoFront(
        candidates.map((c, idx) => ({ idx, scores: c.scores })),
        this.tieEpsilon
      ).map((p) => p.idx);
      const hvAfter =
        hypervolume2D(archive.map((idx) => candidates[idx]!.scores)) ?? 0;

      recordCandidate?.(() => {
        const delta = buildGEPACandidateComponentDelta(
          candidates[parentIdx]!.cfg,
          proposedCfg,
          lineageOptions!
        );
        return {
          id: mutationCandidateId!,
          parentIds: [candidates[parentIdx]!.id!],
          round: t + 1,
          strategy,
          componentDelta: delta.delta,
          omittedComponentCount: delta.omittedComponentCount,
          evaluations: mutationEvaluations!,
          metricCallsAtDecision: this.stats.totalCalls,
          metricCallBudget: rolloutBudgetPareto,
          decision: 'accepted',
          reason: 'improved_minibatch_score',
          disposition: 'archived',
          failures: mutationFailures!.length ? mutationFailures : undefined,
        };
      });
      await publishDecision('accepted');

      // Reset stagnation if archive improved (hypervolume or size)
      if (archive.length > beforeSize || hvAfter > hvBefore + 1e-6) {
        stagnation = 0;
        verboseLog(
          `Iteration ${t + 1}: Archive improved (size=${archive.length}, hv=${hvAfter.toFixed(4)})`
        );
      } else {
        stagnation++;
        verboseLog(
          `Iteration ${t + 1}: Archive unchanged (stagnation=${stagnation}/${this.earlyStoppingTrials})`
        );
        if (stagnation >= this.earlyStoppingTrials) {
          markRunStopped('early_stopping', 'early_stopping', t + 1);
          verboseLog(
            `Early stopping: ${stagnation} iterations without archive improvement`
          );
          break;
        }
      }
      // Schedule merge attempt for next iteration (aligned with reference behavior)
      this.lastIterFoundNewProgram = true;
      if (this.mergeMax > 0 && this.totalMergesTested < this.mergeMax) {
        this.mergesDue += 1;
      }
    }

    // Build Pareto frontier of candidate average vectors
    const pareto = buildParetoFront(
      candidates.map((c, idx) => ({
        idx,
        scores: c.scores,
      })),
      this.tieEpsilon
    );

    // Pick bestScore as max scalarized score on frontier.
    // When the run-level discard ceiling fired, the scores on the frontier were
    // computed over a denominator a host classifier removed most of, so NO best
    // score and no optimized artifact are published — a number here would be a
    // claim the evidence cannot support.
    const bestScore =
      pareto.length > 0 && !admissionCeilingFired
        ? Math.max(...pareto.map((p) => scalarize(p.scores)))
        : 0;

    // On score ties, prefer the later accepted candidate over the seed.
    let bestCandidateIdx: number | undefined;
    if (pareto.length > 0 && !admissionCeilingFired) {
      const first = pareto[0]!;
      let maxS = scalarize(first.scores);
      bestCandidateIdx = first.idx;

      for (let i = 1; i < pareto.length; i++) {
        const p = pareto[i]!;
        const s = scalarize(p.scores);
        if (s > maxS || (s === maxS && p.idx > bestCandidateIdx)) {
          maxS = s;
          bestCandidateIdx = p.idx;
        }
      }
    }

    // Compute hypervolume (2D only)
    const hv = hypervolume2D(pareto.map((p) => p.scores));

    this.stats.convergenceInfo.converged = true;

    // Record metrics for monitoring
    const customLabels = this.getMergedCustomLabels(options);
    this.recordParetoMetrics(
      pareto.length,
      candidates.length,
      'GEPA',
      hv,
      customLabels
    );

    const candidateLineage = buildLineageManifest(bestCandidateIdx, {
      terminal: admissionCeilingFired,
    });
    const discriminationSummary = buildDiscriminationSummary();

    // Build a unified optimized program (mirrors MiPRO) for the selected best candidate
    const optimizationTime = Date.now() - _startTime;
    const optimizedProgram =
      typeof bestCandidateIdx === 'number'
        ? new AxOptimizedProgramImpl<OUT>({
            bestScore,
            stats: this.stats,
            componentMap: { ...candidates[bestCandidateIdx]!.cfg },
            selectorState: componentSelector.snapshot(),
            candidateLineage,
            demos: bootstrappedDemos,
            examples: examples as unknown as any[],
            modelConfig: undefined,
            optimizerType: 'GEPA',
            optimizationTime,
            totalRounds: this.numTrials,
            converged: this.stats.convergenceInfo.converged,
          })
        : undefined;

    if (lineageEnabled) {
      await this.saveFinalCheckpoint(
        'GEPA',
        {
          numTrials: this.numTrials,
          paretoSetSize: paretoSet.length,
          tunableCount: targets.length,
        },
        bestScore,
        bestCandidateIdx === undefined
          ? undefined
          : { candidateId: candidates[bestCandidateIdx]!.id! },
        {
          ...(() => {
            const { abortSignal: _abortSignal, ...rest } = (options ??
              {}) as AxCompileOptions & {
              abortSignal?: AbortSignal;
            };
            return rest;
          })(),
          maxIterations: this.numTrials,
          candidateLineage,
        },
        options
      );

      optLogger?.({
        name: 'OptimizationComplete',
        value: {
          optimizerType: 'GEPA',
          bestScore,
          bestConfiguration:
            bestCandidateIdx === undefined
              ? {}
              : {
                  candidateId: candidates[bestCandidateIdx]!.id!,
                  candidateLineage:
                    optimizedProgram?.candidateLineage ?? candidateLineage,
                },
          totalCalls: this.stats.totalCalls,
          stats: this.stats,
          ...(runAdmission ? { admission: runAdmission } : {}),
          ...(discriminationSummary
            ? { discrimination: discriminationSummary }
            : {}),
        },
      });
    }

    // Generate optimization insights report
    const report = this.generateOptimizationReport(
      pareto,
      hv,
      bestScore,
      candidates.length
    );

    return {
      demos: bootstrappedDemos,
      stats: this.stats,
      bestScore,
      paretoFront: pareto.map((p) => ({
        demos: bootstrappedDemos,
        scores: p.scores,
        configuration: {
          candidate: p.idx,
          componentMap: { ...candidates[p.idx]!.cfg },
        },
        dominatedSolutions: p.dominated,
      })),
      paretoFrontSize: pareto.length,
      hypervolume: hv,
      finalConfiguration: {
        strategy: 'gepa',
        candidates: candidates.length,
        tunables: targets.length,
        bootstrappedDemos: bootstrappedDemos.length,
      },
      // Extra field (not part of AxParetoResult): unified optimized program for easy save/apply
      optimizedProgram,
      // Structured optimization report
      report,
    } as AxParetoResult<OUT> & { report: AxGEPAOptimizationReport };
  }

  /** Lightweight auto presets */
  public configureAuto(level: 'light' | 'medium' | 'heavy'): void {
    switch (level) {
      case 'light':
        this.numTrials = 10;
        this.minibatch = true;
        this.minibatchSize = 15;
        break;
      case 'medium':
        this.numTrials = 20;
        this.minibatch = true;
        this.minibatchSize = 25;
        break;
      case 'heavy':
        this.numTrials = 35;
        this.minibatch = true;
        this.minibatchSize = 35;
        break;
    }
  }

  // --- Helpers ---

  private async evaluateOnSet<IN, OUT extends AxGenOut>(
    program: Readonly<AxGen<IN, OUT>>,
    instruction: string,
    set: readonly AxTypedExample<IN>[],
    metricFn: AxMetricFn
  ): Promise<number[]> {
    const out: number[] = [];
    for (const ex of set) {
      const s = await this.evaluateOne(program, instruction, ex, metricFn);
      out.push(s);
    }
    return out;
  }

  private async evaluateAvg<IN, OUT extends AxGenOut>(
    program: Readonly<AxGen<IN, OUT>>,
    instruction: string,
    set: readonly AxTypedExample<IN>[],
    metricFn: AxMetricFn
  ): Promise<number> {
    const arr = await this.evaluateOnSet(program, instruction, set, metricFn);
    return arr.length > 0 ? average(arr) : 0;
  }

  private async evaluateOne<IN, OUT extends AxGenOut>(
    program: Readonly<AxGen<IN, OUT>>,
    instruction: string,
    example: Readonly<AxTypedExample<IN>>,
    metricFn: AxMetricFn
  ): Promise<number> {
    try {
      // Apply instruction (best-effort) before calling forward
      (program as any).setInstruction?.(instruction);

      const prediction = await program.forward(
        this.studentAI,
        example as IN,
        {
          sampleCount: this.sampleCount,
          // Use the base default majority-picker from MiPRO if available via AxBaseOptimizer
          // leave undefined to use program/model defaults when sampleCount===1
        } as any
      );

      this.stats.totalCalls += 1;
      const metricResult = await normalizeGEPAMetricResult(
        metricFn,
        prediction,
        example as AxExample
      );
      const score =
        metricResult.scalar ?? scalarizeGEPAScores(metricResult.scores);
      if (Number.isFinite(score)) {
        const threshold =
          typeof this.targetScore === 'number' ? this.targetScore : 0.5;
        if (score >= threshold) this.stats.successfulDemos += 1;
        return score;
      }
      return 0;
    } catch (err) {
      const logger = this.getLogger();
      logger?.({ name: 'Notification', id: 'gepa_eval', value: String(err) });
      return 0;
    }
  }

  private async reflectTargetInstruction<IN, OUT extends AxGenOut>(
    targetId: string,
    currentInstruction: string,
    program: Readonly<AxProgrammable<IN, OUT>>,
    applyConfig: (cfg: Readonly<Record<string, string>>) => void,
    cfg: Record<string, string>,
    minibatch: readonly AxTypedExample<IN>[],
    metricFn: AxMetricFn,
    options?: AxCompileOptions,
    preEvaluatedTuples?: Array<{
      input: AxExample;
      prediction: unknown;
      score: number;
      feedback?: string;
    }>,
    targetMeta?: Readonly<{
      kind: string;
      description?: string;
      constraints?: string;
      preserve?: readonly string[];
      maxLength?: number;
      format?: string;
      validate?: (value: string) => true | string;
      traceDataset?: readonly unknown[];
    }>,
    onFailure?: (
      failure: Readonly<{
        kind: 'runtime' | 'validator';
        message: string;
      }>
    ) => void
  ): Promise<string> {
    const tuples: Array<{
      input: AxExample;
      prediction: unknown;
      score: number;
      feedback?: string;
    }> = preEvaluatedTuples ? [...preEvaluatedTuples] : [];

    if (tuples.length === 0) {
      for (const ex of minibatch) {
        try {
          cfg[targetId] = currentInstruction;
          applyConfig(cfg);
          const pred = await program.forward(
            this.studentAI,
            ex as IN,
            {
              sampleCount: this.sampleCount,
            } as any
          );
          this.stats.totalCalls += 1;
          const metricResult = await normalizeGEPAMetricResult(
            metricFn,
            pred,
            ex as AxExample
          );
          tuples.push({
            input: ex as AxExample,
            prediction: pred,
            score:
              metricResult.scalar ?? scalarizeGEPAScores(metricResult.scores),
            feedback: metricResult.feedback,
          });
        } catch {
          tuples.push({ input: ex as AxExample, prediction: {}, score: 0 });
        }
      }
    }

    const aiToUse: AxAIService =
      options?.overrideTeacherAI ?? this.teacherAI ?? this.studentAI;
    const critic = ax(
      `targetId:string "Target program ID", minibatch:json "Array of {input,prediction,score}", evalFeedback?:string[] "Evaluator feedback when available" -> feedbackSummary:string "Concise program-focused feedback"`
    );

    const feedbackNotes = (
      ((options as any)?.feedbackNotes as string[] | undefined) ?? []
    )
      .map(normalizeGEPAMetricFeedback)
      .filter((note): note is string => note !== undefined);
    const external: string[] = [...feedbackNotes];
    const feedbackFn = (options as any)?.feedbackFn as
      | ((
          arg: Readonly<{
            prediction: any;
            example: AxExample;
            componentId?: string;
          }>
        ) => string | string[] | undefined)
      | undefined;
    if (typeof feedbackFn === 'function') {
      for (const tuple of tuples) {
        const fb = feedbackFn({
          prediction: tuple.prediction,
          example: tuple.input,
          componentId: targetId,
        });
        const values = Array.isArray(fb) ? fb : [fb];
        for (const value of values) {
          const normalized = normalizeGEPAMetricFeedback(value);
          if (normalized) external.push(normalized);
        }
      }
    }

    let feedbackSummary = '';
    try {
      const out = (await critic.forward(aiToUse, {
        targetId,
        minibatch: tuples,
        evalFeedback: external,
      } as any)) as any;
      feedbackSummary =
        (out?.feedbackSummary as string | undefined)?.trim() || '';
    } catch {}

    const proposed = await proposeGEPAComponentValue({
      ai: aiToUse,
      target: {
        id: targetId,
        kind: targetMeta?.kind ?? 'component',
        current: currentInstruction,
        description: targetMeta?.description,
        constraints: targetMeta?.constraints,
        preserve: targetMeta?.preserve,
        maxLength: targetMeta?.maxLength,
        format: targetMeta?.format,
        validate: targetMeta?.validate,
      },
      currentValue: currentInstruction,
      tuples,
      feedbackSummary,
      traceDataset: targetMeta?.traceDataset,
      maxAttempts: 2,
      onFailure,
      proposal: options?.gepaProposal,
    });

    return proposed ?? currentInstruction;
  }

  private async reflectInstruction<IN, OUT extends AxGenOut>(
    currentInstruction: string,
    program: Readonly<AxGen<IN, OUT>>,
    minibatch: readonly AxTypedExample<IN>[],
    metricFn: AxMetricFn,
    options?: AxCompileOptions,
    // Optional: pre-evaluated tuples to avoid duplicate evaluation
    preEvaluatedTuples?: Array<{
      input: AxExample;
      prediction: unknown;
      score: number;
      feedback?: string;
    }>
  ): Promise<string> {
    // Collect quick feedback tuples from minibatch (or use pre-evaluated)
    const tuples: Array<{
      input: AxExample;
      prediction: unknown;
      score: number;
      feedback?: string;
    }> = preEvaluatedTuples ?? [];

    if (tuples.length === 0) {
      for (const ex of minibatch) {
        try {
          (program as any).setInstruction?.(currentInstruction);
          const pred = await program.forward(
            this.studentAI,
            ex as IN,
            {
              sampleCount: this.sampleCount,
            } as any
          );
          this.stats.totalCalls += 1;
          const metricResult = await normalizeGEPAMetricResult(
            metricFn,
            pred,
            ex as AxExample
          );
          tuples.push({
            input: ex as AxExample,
            prediction: pred,
            score:
              metricResult.scalar ?? scalarizeGEPAScores(metricResult.scores),
            feedback: metricResult.feedback,
          });
        } catch {
          tuples.push({ input: ex as AxExample, prediction: {}, score: 0 });
        }
      }
    }

    const aiToUse: AxAIService =
      (options as any)?.overrideTeacherAI ?? this.teacherAI ?? this.studentAI;
    const componentId =
      typeof (program as any)?.getId === 'function'
        ? ((program as any).getId() as string | undefined)
        : undefined;

    // Optional: external feedback function
    const feedbackFn:
      | ((
          arg: Readonly<{
            prediction: any;
            example: AxExample;
            componentId?: string;
          }>
        ) => string | string[] | undefined)
      | undefined = (options as any)?.feedbackFn;
    const feedbackNotes = (
      ((options as any)?.feedbackNotes as string[] | undefined) ?? []
    )
      .map(normalizeGEPAMetricFeedback)
      .filter((note): note is string => note !== undefined);

    // Build reflective dataset in GEPA format (aligned with reference)
    const formatReflectiveDataset = (): string => {
      const examples: string[] = [];
      for (let i = 0; i < tuples.length; i++) {
        const t = tuples[i]!;
        let exampleStr = `# Example ${i + 1}\n`;
        exampleStr += `## Inputs\n`;
        if (typeof t.input === 'object' && t.input !== null) {
          for (const [k, v] of Object.entries(t.input)) {
            exampleStr += `### ${k}\n${renderReflectiveValue(v)}\n\n`;
          }
        } else {
          exampleStr += `${renderReflectiveValue(t.input)}\n\n`;
        }
        exampleStr += `## Generated Outputs\n`;
        if (typeof t.prediction === 'object' && t.prediction !== null) {
          for (const [k, v] of Object.entries(t.prediction)) {
            exampleStr += `### ${k}\n${renderReflectiveValue(v)}\n\n`;
          }
        } else {
          exampleStr += `${renderReflectiveValue(t.prediction)}\n\n`;
        }
        exampleStr += `## Feedback\n`;
        // Get feedback from feedbackFn if available
        const feedback = [
          `This trajectory got a score of ${t.score.toFixed(3)}.`,
          t.feedback,
        ].filter((value): value is string => Boolean(value));
        if (typeof feedbackFn === 'function') {
          try {
            const customFb = feedbackFn({
              prediction: t.prediction,
              example: t.input,
              componentId,
            });
            const values = Array.isArray(customFb) ? customFb : [customFb];
            for (const value of values) {
              const normalized = normalizeGEPAMetricFeedback(value);
              if (normalized) feedback.push(normalized);
            }
          } catch {}
        }
        exampleStr += `${feedback.join('\n')}\n`;
        examples.push(exampleStr);
      }
      const extraNotes = feedbackNotes.map(
        (note, index) => `# Additional Feedback ${index + 1}\n${note}`
      );
      return [...extraNotes, ...examples].join('\n\n');
    };

    // Use the GEPA-style reflection prompt (aligned with reference)
    const prompt = AxGEPA.REFLECTION_PROMPT_TEMPLATE.replace(
      '<curr_instructions>',
      currentInstruction
    ).replace('<inputs_outputs_feedback>', formatReflectiveDataset());

    try {
      // Direct LLM call for reflection (more aligned with reference approach)
      const response = await aiToUse.chat(
        {
          chatPrompt: [{ role: 'user', content: prompt }],
          model: (options as any)?.reflectionModel,
        },
        { stream: false }
      );
      // Handle both streaming and non-streaming responses
      if (typeof (response as any).getReader === 'function') {
        throw new Error('Streaming response not expected for reflection');
      }
      const typedResponse =
        response as import('../../ai/types.js').AxChatResponse;
      const content = typedResponse.results?.[0]?.content;
      if (typeof content === 'string') {
        // Extract instruction from backticks (aligned with reference extractor)
        const extracted = this.extractInstructionFromBackticks(content);
        if (extracted && extracted.length > 16) {
          // Maintain feedback memory for cross-iteration learning
          const feedbackSummary = `Iteration feedback: ${tuples.map((t) => `score=${t.score.toFixed(2)}`).join(', ')}`;
          this.feedbackMemory.unshift(feedbackSummary);
          if (this.feedbackMemory.length > this.feedbackMemorySize) {
            this.feedbackMemory.pop();
          }
          return extracted;
        }
      }
    } catch {}

    // Fallback to signature-based approach
    const refl = ax(
      `currentInstruction:string "Current instruction", feedbackSummary?:string "Summarized feedback", recentFeedback?:string[] "Past feedback memory", minibatch:json "Array of {input,prediction,score}" -> newInstruction:string "Improved instruction within 1-6 sentences."`
    );

    try {
      const out = (await refl.forward(aiToUse, {
        currentInstruction,
        feedbackSummary: this.feedbackMemory[0] || '',
        recentFeedback: this.feedbackMemory,
        minibatch: tuples,
      } as any)) as any;
      const instr = (out?.newInstruction as string | undefined)?.trim();
      if (instr && instr.length > 16) return instr;
    } catch {}

    // Final fallback: tweak the instruction minimally
    return `${currentInstruction.trim()} Focus on step-by-step evidence-based reasoning. Avoid hallucinations.`.slice(
      0,
      2000
    );
  }

  /**
   * Extract instruction text from LLM output enclosed in backticks (aligned with reference)
   */
  private extractInstructionFromBackticks(lmOut: string): string {
    const start = lmOut.indexOf('```') + 3;
    const end = lmOut.lastIndexOf('```');

    // Handle if the first and last backticks are the same or overlap
    if (start >= end) {
      const stripped = lmOut.trim();
      if (stripped.startsWith('```')) {
        // Remove opening ``` and optional language specifier
        const match = stripped.match(/^```\S*\n?/);
        if (match) {
          return stripped.slice(match[0].length).trim();
        }
      } else if (stripped.endsWith('```')) {
        // Remove closing ```
        return stripped.slice(0, -3).trim();
      }
      return stripped;
    }

    // Extract content between backticks
    let content = lmOut.slice(start, end);
    // Skip optional language specifier (e.g., ```markdown\n)
    const langMatch = content.match(/^\S*\n/);
    if (langMatch) {
      content = content.slice(langMatch[0].length);
    }
    return content.trim();
  }

  private updateSamplerShuffled(trainSize: number): void {
    const ids = Array.from({ length: trainSize }, (_, i) => i);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    for (const i of ids)
      this.samplerState.freq.set(i, (this.samplerState.freq.get(i) ?? 0) + 1);
    const mb = this.minibatchSize;
    const mod = trainSize % mb;
    const numToPad = mod === 0 ? 0 : mb - mod;
    const candidates = Array.from({ length: trainSize }, (_, i) => i).sort(
      (a, b) =>
        (this.samplerState.freq.get(a) ?? 0) -
        (this.samplerState.freq.get(b) ?? 0)
    );
    const padded = [...ids];
    for (let k = 0; k < numToPad; k++) {
      const id = candidates[k % candidates.length]!;
      padded.push(id);
      this.samplerState.freq.set(id, (this.samplerState.freq.get(id) ?? 0) + 1);
    }
    this.samplerState.shuffled = padded;
    this.samplerState.epoch += 1;
  }

  private nextMinibatchIndices(trainSize: number, iteration: number): number[] {
    if (this.samplerState.epoch === -1) {
      this.samplerState.epoch = 0;
      this.updateSamplerShuffled(trainSize);
    }
    const mb = this.minibatchSize;
    const blocksPerEpoch = Math.max(
      1,
      Math.floor(this.samplerState.shuffled.length / mb)
    );
    const currEpoch = Math.floor(iteration / blocksPerEpoch);
    while (currEpoch >= this.samplerState.epoch)
      this.updateSamplerShuffled(trainSize);
    const base = (iteration * mb) % this.samplerState.shuffled.length;
    return this.samplerState.shuffled.slice(base, base + mb);
  }

  private rand(): number {
    this.rngState ^= this.rngState << 13;
    this.rngState ^= this.rngState >>> 17;
    this.rngState ^= this.rngState << 5;
    return ((this.rngState >>> 0) as number) / 4294967296;
  }

  private systemAwareMergeWithSig(
    candidates: ReadonlyArray<{ cfg: Record<string, string>; parent?: number }>,
    i: number,
    j: number,
    pickBetter: (idxA: number, idxB: number) => number
  ): { cfg: Record<string, string>; descSig: string } {
    const ancestors = (idx: number): number[] => {
      const path: number[] = [];
      let cur: number | undefined = idx;
      while (cur !== undefined) {
        path.push(cur);
        cur = candidates[cur]?.parent;
      }
      return path;
    };
    const Ai = ancestors(i);
    const Aj = ancestors(j);
    const common = Ai.find((x) => Aj.includes(x));
    const a = common ?? i;

    const cfgA = candidates[a]!.cfg;
    const cfgI = candidates[i]!.cfg;
    const cfgJ = candidates[j]!.cfg;

    const merged: Record<string, string> = {};
    const picks: ('i' | 'j')[] = [];
    const allKeys = Array.from(
      new Set([
        ...Object.keys(cfgA),
        ...Object.keys(cfgI),
        ...Object.keys(cfgJ),
      ])
    ).sort();
    for (const key of allKeys) {
      const pa = cfgA[key];
      const pi = cfgI[key];
      const pj = cfgJ[key];
      if (pi === pa && pj !== pi) {
        merged[key] = pj!;
        picks.push('j');
      } else if (pj === pa && pi !== pj) {
        merged[key] = pi!;
        picks.push('i');
      } else if (pi !== pj && pi !== pa && pj !== pa) {
        const pick = pickBetter(i, j);
        merged[key] = pick === i ? pi! : pj!;
        picks.push(pick === i ? 'i' : 'j');
      } else {
        merged[key] = pi ?? pj ?? pa!;
        picks.push('i');
      }
    }
    return { cfg: merged, descSig: picks.join('|') };
  }

  private generateOptimizationReport(
    paretoFront: Array<{ scores: Record<string, number>; dominated: number }>,
    hypervolume: number | undefined,
    bestScore: number | undefined,
    candidateCount: number
  ): AxGEPAOptimizationReport {
    // Build best solution data
    const best =
      paretoFront.length > 0
        ? paretoFront.reduce((prev, curr) => {
            const prevSum = Object.values(prev.scores).reduce(
              (a, b) => a + b,
              0
            );
            const currSum = Object.values(curr.scores).reduce(
              (a, b) => a + b,
              0
            );
            return currSum > prevSum ? curr : prev;
          })
        : undefined;

    const objectives: Record<string, { value: number; percentage: number }> =
      {};
    if (best) {
      for (const [key, value] of Object.entries(best.scores)) {
        objectives[key] = {
          value,
          percentage: value * 100,
        };
      }
    }

    // Build tradeoffs list
    const tradeoffs: Array<Record<string, number>> = [];
    if (paretoFront.length > 1) {
      const sorted = [...paretoFront]
        .sort((a, b) => b.dominated - a.dominated)
        .slice(0, 3);
      for (const p of sorted) {
        tradeoffs.push({ ...p.scores });
      }
    }

    // Build recommendations
    let status: 'good' | 'limited' | 'single' = 'good';
    const suggestions: string[] = [];

    if (paretoFront.length === 1) {
      status = 'single';
      suggestions.push('Increase numTrials (current seems low)');
      suggestions.push('Add more training examples');
      suggestions.push('Adjust earlyStoppingTrials');
    } else if (paretoFront.length < 3) {
      status = 'limited';
      suggestions.push('More optimization trials');
      suggestions.push('Larger validation set');
    } else {
      status = 'good';
      const objs = Object.keys(paretoFront[0]?.scores || {});
      for (const obj of objs) {
        suggestions.push(`High ${obj}: Choose solution with best ${obj} score`);
      }
      suggestions.push('Balanced: Use provided bestScore (average)');
    }

    if (this.stats.totalCalls < 50) {
      suggestions.push(
        'Quick run detected - use numTrials: 30+ for production'
      );
      suggestions.push('Provide 50+ training examples');
      suggestions.push('Use 20+ validation examples');
    }

    return {
      summary: 'GEPA Multi-Objective Optimization Complete',
      bestSolution: {
        overallScore: bestScore ?? 0,
        objectives,
      },
      paretoFrontier: {
        solutionCount: paretoFront.length,
        objectiveSpaceCoverage: (hypervolume ?? 0) * 100,
        hypervolume: hypervolume ?? 0,
        tradeoffs: tradeoffs.length > 0 ? tradeoffs : undefined,
      },
      statistics: {
        totalEvaluations: this.stats.totalCalls,
        candidatesExplored: candidateCount,
        converged: this.stats.convergenceInfo?.converged ?? false,
      },
      recommendations: {
        status,
        suggestions,
      },
    };
  }

  private async mergeInstructions(
    instructionA: string,
    instructionB: string,
    options?: AxCompileOptions
  ): Promise<string> {
    const aiToUse: AxAIService =
      (options as any)?.overrideTeacherAI ?? this.teacherAI ?? this.studentAI;

    // Merge via meta-prompt
    const merger = ax(
      `instructionA:string "Parent A instruction",
       instructionB:string "Parent B instruction",
       recentFeedback?:string[] "Past feedback memory"
       -> mergedInstruction:string "Merged instruction (1-6 sentences) combining strengths, fixing weaknesses"`
    );

    try {
      const out = (await merger.forward(aiToUse, {
        instructionA,
        instructionB,
        recentFeedback: this.feedbackMemory,
      } as any)) as any;
      const instr = (out?.mergedInstruction as string | undefined)?.trim();
      if (instr && instr.length > 16) return instr;
    } catch {}

    // Fallback: prefer the longer instruction (richer constraints)
    return (
      instructionA.length >= instructionB.length ? instructionA : instructionB
    ).slice(0, 2000);
  }
}

function chooseByteBoundDropIndex(
  records: readonly { id: string; parentIds: readonly string[] }[],
  selectedCandidateId: string | undefined
): number {
  if (records.length <= 1) return 0;
  const lastIndex = records.length - 1;
  const retainedParentIds = new Set(
    records.flatMap((record) => record.parentIds)
  );
  const isLeaf = (index: number): boolean =>
    !retainedParentIds.has(records[index]!.id);
  for (let index = lastIndex - 1; index >= 1; index--) {
    if (isLeaf(index) && records[index]!.id !== selectedCandidateId)
      return index;
  }
  if (isLeaf(lastIndex) && records[lastIndex]!.id !== selectedCandidateId) {
    return lastIndex;
  }
  for (let index = lastIndex; index >= 0; index--) {
    if (isLeaf(index)) return index;
  }
  return lastIndex;
}
