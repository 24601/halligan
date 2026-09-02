import type { Equal, Expect } from '../../util/typetest.js';
import type {
  AxEnvironmentFailureCause,
  AxResolvedTrajectoryAdmissionOptions,
  AxTrajectoryAdmissionReport,
  AxTrajectoryTermination,
  AxTrajectoryTerminationClassifier,
  AxTrajectoryTerminationInput,
  axPairedAdmittedIndices,
} from './trajectoryTermination.js';

declare const termination: AxTrajectoryTermination;

// The union is closed and discriminated: exhausting the three kinds must leave
// `never`, so a fourth outcome cannot be smuggled in without every consumer
// failing to compile.
switch (termination.kind) {
  case 'completed':
    break;
  case 'policy_failure':
    break;
  case 'environment_failure': {
    const _cause: AxEnvironmentFailureCause = termination.cause;
    break;
  }
  default: {
    const _exhaustive: never = termination;
    break;
  }
}

// An environment failure MUST name a cause: an unattributed discard is not
// reviewable evidence.
// @ts-expect-error environment failures require a cause
const _uncaused: AxTrajectoryTermination = { kind: 'environment_failure' };
const _badCause: AxTrajectoryTermination = {
  kind: 'environment_failure',
  // @ts-expect-error the cause vocabulary is closed
  cause: 'solar_flare',
};

// `nonReclassifiable` is required, not optional. Ax must decide it at every
// call site rather than defaulting it, because the default would be the
// permissive one.
// @ts-expect-error nonReclassifiable is required on every classifier input
const _input: AxTrajectoryTerminationInput = { phase: 'p', exampleIndex: 0 };

declare const classifier: AxTrajectoryTerminationClassifier;
type _classifierIsSync = Expect<
  Equal<ReturnType<typeof classifier>, AxTrajectoryTermination>
>;

// The resolved options carry a classifier, so nothing downstream has to keep
// re-deriving the default.
type _resolvedIsTotal = Expect<
  Equal<
    AxResolvedTrajectoryAdmissionOptions,
    {
      readonly classifier: AxTrajectoryTerminationClassifier;
      readonly minAdmittedFraction: number;
      readonly maxRunDiscardRate: number;
      readonly minRunRowsForCeiling: number;
    }
  >
>;

declare const report: AxTrajectoryAdmissionReport;
// @ts-expect-error admission reports are read-only once summarized
report.admittedRows = 0;

type _pairedIsReadonly = Expect<
  Equal<ReturnType<typeof axPairedAdmittedIndices>, readonly number[]>
>;
