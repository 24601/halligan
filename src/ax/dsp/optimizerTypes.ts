import type { AxOptimizationStats } from './common_types.js';
import type { AxGEPADeployableBestChain } from './optimizers/gepaLineage.js';
import type { AxMutationDepthHistogram } from './optimizers/mutationTaxonomy.js';
import type {
  AxTaskDiscriminationSummary,
  AxTaskInclusionSnapshot,
} from './optimizers/taskDiscrimination.js';
import type { AxTrajectoryAdmissionReport } from './optimizers/trajectoryTermination.js';

/**
 * Whole-run admission accounting: the fold of every batch's report.
 *
 * `AxTrajectoryAdmissionReport.inconclusive` is a PER-BATCH verdict — "this
 * batch admitted too few rows to decide anything" — and the run-level fold of
 * it is an OR. Publishing that under the same name would tell a reader the RUN
 * was inconclusive because one batch out of forty was, so the folded value
 * travels under its own name and the per-batch name is not reused.
 */
export type AxGEPARunAdmissionReport = Omit<
  AxTrajectoryAdmissionReport,
  'inconclusive'
> & {
  /** True when AT LEAST ONE batch in the run was inconclusive. */
  readonly anyBatchInconclusive: boolean;
};

// Optimizer logging types
export type AxOptimizerLoggerData =
  | {
      name: 'OptimizationStart';
      value: {
        optimizerType: string;
        config: Record<string, unknown>;
        exampleCount: number;
        validationCount: number;
      };
    }
  | {
      name: 'RoundProgress';
      value: {
        round: number;
        totalRounds: number;
        currentScore: number;
        bestScore: number;
        configuration: Record<string, unknown>;
        /**
         * GEPA only, and only when a trajectory-termination classifier was
         * supplied. Cumulative run-level admission at the end of this round.
         */
        admission?: AxGEPARunAdmissionReport;
        /**
         * GEPA only, and only under `minibatchStrategy: 'discriminative'`.
         * The inclusion probabilities this round's minibatch was drawn from.
         */
        inclusionSnapshot?: AxTaskInclusionSnapshot;
        /**
         * GEPA only, and only under `AxCompileOptions.mutationAnnotation`.
         * RUNNING histogram over the candidates proposed so far — emitted every
         * round rather than only at completion, so a run that aborts still
         * leaves one behind.
         */
        mutationDepthHistogram?: AxMutationDepthHistogram;
      };
    }
  | {
      name: 'EarlyStopping';
      value: {
        reason: string;
        finalScore: number;
        round: number;
      };
    }
  | {
      name: 'OptimizationComplete';
      value: {
        optimizerType?: string;
        bestScore: number;
        bestConfiguration: Record<string, unknown>;
        totalCalls?: number;
        successRate?: string;
        explanation?: string;
        recommendations?: string[];
        performanceAssessment?: string;
        stats: AxOptimizationStats;
        /**
         * GEPA only, and only when a trajectory-termination classifier was
         * supplied. Whole-run admission accounting.
         */
        admission?: AxGEPARunAdmissionReport;
        /**
         * GEPA only, and only under `minibatchStrategy: 'discriminative'`.
         * Bounded run-level sampler report.
         */
        discrimination?: AxTaskDiscriminationSummary;
        /**
         * GEPA only, and only under `AxCompileOptions.mutationAnnotation`.
         * Final depth histogram over every proposed candidate.
         */
        mutationDepthHistogram?: AxMutationDepthHistogram;
        /**
         * GEPA only. The deployable candidate and its ancestry. Emitted only
         * with lineage version 2; there is no archive-best counterpart.
         */
        bestChain?: AxGEPADeployableBestChain;
      };
    }
  | {
      name: 'ConfigurationProposal';
      value: {
        type: 'instructions' | 'demos' | 'general';
        proposals: string[] | Record<string, unknown>[];
        count: number;
      };
    }
  | {
      name: 'BootstrappedDemos';
      value: {
        count: number;
        demos: unknown[];
      };
    }
  | {
      name: 'BestConfigFound';
      value: {
        config: Record<string, unknown>;
        score: number;
      };
    };

export type AxOptimizerLoggerFunction = (data: AxOptimizerLoggerData) => void;
