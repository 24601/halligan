import type { AxAIService, AxLoggerFunction } from '../ai/types.js';
import type { AxGEPAAdapter } from './optimizers/gepaAdapter.js';
import type { AxGEPACandidateLineageOptions } from './optimizers/gepaLineage.js';
import type { AxGEPAProposalOptions } from './optimizers/gepaReflection.js';
import type {
  AxMinibatchStrategy,
  AxTaskDiscriminationOptions,
} from './optimizers/taskDiscrimination.js';
import type { AxTrajectoryAdmissionOptions } from './optimizers/trajectoryTermination.js';
import type { AxOptimizerLoggerData } from './optimizerTypes.js';
import type { AxFieldValue, AxResultPickerFunction } from './types.js';

export type AxExample = Record<string, AxFieldValue>;

export type AxTypedExample<IN = any> = IN & {
  [key: string]: AxFieldValue;
};

/**
 * A metric result with an explicit scalar used for acceptance decisions and
 * optional qualitative feedback/objectives for consumers that support them.
 * GEPA uses all fields; other metric consumers may use only the scalar score.
 */
export interface AxMetricResult<Objective extends string = string> {
  score: number;
  feedback?: string;
  scores?: Partial<Record<Objective, number>>;
}

export type AxMetricFn<T = any, Objective extends string = string> = (
  arg0: Readonly<{ prediction: T; example: AxExample }>
) =>
  | number
  | AxMetricResult<Objective>
  | Promise<number | AxMetricResult<Objective>>;
export type AxMetricFnArgs = Parameters<AxMetricFn>[0];

export type AxMultiMetricFn<T = any, Objective extends string = string> = (
  arg0: Readonly<{ prediction: T; example: AxExample }>
) =>
  | Record<string, number>
  | AxMetricResult<Objective>
  | Promise<Record<string, number> | AxMetricResult<Objective>>;

export interface AxOptimizationProgress {
  round: number;
  totalRounds: number;
  currentScore: number;
  bestScore: number;
  tokensUsed: number;
  timeElapsed: number;
  successfulExamples: number;
  totalExamples: number;
  currentConfiguration?: Record<string, unknown>;
  bestConfiguration?: Record<string, unknown>;
  convergenceInfo?: {
    improvement: number;
    stagnationRounds: number;
    isConverging: boolean;
  };
}

export interface AxCostTracker {
  trackTokens(count: number, model: string): void;
  getCurrentCost(): number;
  getTokenUsage(): Record<string, number>;
  getTotalTokens(): number;
  isLimitReached(): boolean;
  reset(): void;
}

export interface AxCostTrackerOptions {
  costPerModel?: Record<string, number>;
  maxCost?: number;
  maxTokens?: number;
}

export interface AxOptimizationCheckpoint {
  version: string;
  timestamp: number;
  optimizerType: string;
  optimizerConfig: Record<string, unknown>;
  currentRound: number;
  totalRounds: number;
  bestScore: number;
  bestConfiguration?: Record<string, unknown>;
  scoreHistory: number[];
  configurationHistory: Record<string, unknown>[];
  stats: AxOptimizationStats;
  optimizerState: Record<string, unknown>;
  examples: readonly AxExample[];
}

export interface AxGEPABootstrapOptions {
  scoreThreshold?: number;
  maxBootstrapDemos?: number;
  maxBootstrapMetricCalls?: number;
}

export type AxCheckpointSaveFn = (
  checkpoint: Readonly<AxOptimizationCheckpoint>
) => Promise<string>;
export type AxCheckpointLoadFn = (
  checkpointId: string
) => Promise<AxOptimizationCheckpoint | null>;

export interface AxOptimizationStats {
  totalCalls: number;
  successfulDemos: number;
  estimatedTokenUsage: number;
  earlyStopped: boolean;
  earlyStopping?: {
    bestScoreRound: number;
    patienceExhausted: boolean;
    reason: string;
  };
  bestScore: number;
  bestConfiguration?: Record<string, unknown>;
  resourceUsage: {
    totalTokens: number;
    totalTime: number;
    avgLatencyPerEval: number;
    peakMemoryUsage?: number;
    costByModel: Record<string, number>;
  };
  convergenceInfo: {
    converged: boolean;
    finalImprovement: number;
    stagnationRounds: number;
    convergenceThreshold: number;
  };
  evaluationBreakdown?: {
    trainingScore: number;
    validationScore: number;
    crossValidationScores?: number[];
    standardDeviation?: number;
  };
}

export type AxOptimizerArgs = {
  studentAI: AxAIService;
  teacherAI?: AxAIService;
  numCandidates?: number;
  initTemperature?: number;
  numTrials?: number;
  minibatch?: boolean;
  minibatchSize?: number;
  minibatchFullEvalSteps?: number;
  programAwareProposer?: boolean;
  dataAwareProposer?: boolean;
  viewDataBatchSize?: number;
  tipAwareProposer?: boolean;
  fewshotAwareProposer?: boolean;
  earlyStoppingTrials?: number;
  minImprovementThreshold?: number;
  sampleCount?: number;
  // Optional: custom picker used when sampleCount > 1
  resultPicker?: AxResultPickerFunction<any>;
  optimizeTopP?: boolean;
  minSuccessRate?: number;
  targetScore?: number;
  onProgress?: (progress: Readonly<AxOptimizationProgress>) => void;
  onEarlyStop?: (reason: string, stats: Readonly<AxOptimizationStats>) => void;
  costTracker?: AxCostTracker;
  checkpointSave?: AxCheckpointSaveFn;
  checkpointLoad?: AxCheckpointLoadFn;
  checkpointInterval?: number;
  resumeFromCheckpoint?: string;
  logger?: AxLoggerFunction;
  verbose?: boolean;
  seed?: number;
  debugOptimizer?: boolean;
  optimizerLogger?: (data: AxOptimizerLoggerData) => void;
};

export interface AxCompileOptions {
  maxIterations?: number;
  earlyStoppingPatience?: number;
  verbose?: boolean;
  maxDemos?: number;
  auto?: 'light' | 'medium' | 'heavy';
  overrideTargetScore?: number;
  overrideCostTracker?: AxCostTracker;
  overrideTeacherAI?: AxAIService;
  overrideOnProgress?: (progress: Readonly<AxOptimizationProgress>) => void;
  overrideOnEarlyStop?: (
    reason: string,
    stats: Readonly<AxOptimizationStats>
  ) => void;
  overrideCheckpointSave?: AxCheckpointSaveFn;
  overrideCheckpointLoad?: AxCheckpointLoadFn;
  overrideCheckpointInterval?: number;
  saveCheckpointOnComplete?: boolean;
  // GEPA core options
  gepaAdapter?: AxGEPAAdapter<any, any, any>;
  gepaProposal?: AxGEPAProposalOptions;
  bootstrap?: boolean | AxGEPABootstrapOptions;
  validationExamples?: readonly AxTypedExample<any>[];
  feedbackExamples?: readonly AxTypedExample<any>[];
  feedbackFn?: (
    args: Readonly<{
      prediction: unknown;
      example: AxExample;
      componentId?: string;
    }>
  ) => string | string[] | undefined;
  /** Global evaluator notes added before per-example metric and feedbackFn text. */
  feedbackNotes?: readonly string[];
  skipPerfectScore?: boolean;
  perfectScore?: number;
  maxMetricCalls?: number;
  /**
   * GEPA only: stop between candidate batch evaluations. Cancellation is
   * not a shared optimizer contract and is not currently propagated into
   * bootstrap or teacher-reflection program calls.
   */
  abortSignal?: AbortSignal;
  /** Opt in to GEPA candidate lineage with defaults or retention/privacy controls. */
  candidateLineage?: boolean | AxGEPACandidateLineageOptions;
  /**
   * GEPA only. Omit to keep today's "every failure is a policy failure"
   * scoring, byte for byte.
   *
   * Supplying this object turns on host-owned trajectory termination
   * classification: rows a host classifies as `environment_failure` leave the
   * promotion comparison (they are still scored into `avg`/`scalars`/`sum`,
   * whose meaning never changes) and the run reports its discard rate. Ax
   * never infers an environment failure, and it overrides one on rows whose
   * candidate carries a `program-source` component or whose config failed to
   * validate — so a program declaring a `program-source` component admits
   * nothing at all, and GEPA logs one line saying so.
   *
   * The classifier fails closed: unlike `metricFn`, a classifier that throws
   * is not scored as a zero row, it ends the run.
   */
  trajectoryTermination?: AxTrajectoryAdmissionOptions;
  /**
   * GEPA only. Default `'uniform'`: byte-identical legacy behaviour, including
   * the `rand()` draw sequence.
   *
   * `'discriminative'` replaces the epoch-shuffled uniform minibatch with a
   * Beta(1,1)-smoothed Bernoulli-variance πps draw that concentrates the budget
   * on tasks that actually separate candidates, keeps a mandatory exploration
   * floor over the rest, and promotes on a Hájek/IPW paired difference instead
   * of a raw sum. It consumes a DIFFERENT number of `rand()` draws, so a
   * discriminative run is not seed-comparable to a uniform one draw-for-draw.
   */
  minibatchStrategy?: AxMinibatchStrategy;
  /** GEPA only. Ignored unless `minibatchStrategy === 'discriminative'`. */
  taskDiscrimination?: AxTaskDiscriminationOptions;
  /**
   * Custom labels to include in OpenTelemetry metrics.
   * These labels are merged with axGlobals.customLabels and AI service customLabels.
   */
  customLabels?: Record<string, string>;
}
