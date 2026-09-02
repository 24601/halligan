import type { AxOptimizationStats } from './common_types.js';
import type { AxTrajectoryAdmissionReport } from './optimizers/trajectoryTermination.js';

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
        admission?: AxTrajectoryAdmissionReport;
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
        admission?: AxTrajectoryAdmissionReport;
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
