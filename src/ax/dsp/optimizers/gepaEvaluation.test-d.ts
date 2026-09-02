import type { Equal, Expect } from '../../util/typetest.js';
import type { AxGEPARunAdmissionReport } from '../optimizerTypes.js';
import type { AxGEPATerminationArgs } from './gepaEvaluation.js';
import type {
  AxResolvedTrajectoryAdmissionOptions,
  AxTrajectoryAdmissionReport,
} from './trajectoryTermination.js';

// `AxGEPATerminationArgs` is a `Required<>`-derived intersection, so an
// accidental widening of any resolved admission option — a number becoming
// `number | undefined`, say — would be invisible at every call site. Pin the
// exact shape.
type _ArgsIsResolvedPlusKinds = Expect<
  Equal<
    AxGEPATerminationArgs,
    AxResolvedTrajectoryAdmissionOptions & {
      readonly affectedKinds: readonly string[];
    }
  >
>;

declare const args: AxGEPATerminationArgs;
type _FloorIsRequiredNumber = Expect<
  Equal<(typeof args)['minAdmittedFraction'], number>
>;
type _CeilingIsRequiredNumber = Expect<
  Equal<(typeof args)['maxRunDiscardRate'], number>
>;
type _RowFloorIsRequiredNumber = Expect<
  Equal<(typeof args)['minRunRowsForCeiling'], number>
>;

// `affectedKinds` is read-only and free-form: component kinds are host-
// extensible (`optimizable.ts` documents `kind` as free text), so narrowing it
// to a closed union here would silently exclude a host's own kind.
type _KindsAreReadonlyStrings = Expect<
  Equal<(typeof args)['affectedKinds'], readonly string[]>
>;

// The run-level report must NOT carry the per-batch verdict under its own
// name. Folding `inconclusive` with OR and republishing it as `inconclusive`
// would tell a reader the run was inconclusive because one batch was.
declare const runReport: AxGEPARunAdmissionReport;
type _RunReportDropsPerBatchVerdict = Expect<
  Equal<'inconclusive' extends keyof typeof runReport ? true : false, false>
>;
type _RunReportNamesTheFold = Expect<
  Equal<(typeof runReport)['anyBatchInconclusive'], boolean>
>;
type _RunReportKeepsTheCounts = Expect<
  Equal<
    (typeof runReport)['discardRate'],
    AxTrajectoryAdmissionReport['discardRate']
  >
>;
