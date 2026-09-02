import type { Equal, Expect } from '../../util/typetest.js';
import type {
  AxIpwEstimate,
  AxMinibatchStrategy,
  AxResolvedTaskDiscriminationOptions,
  AxTaskInclusion,
  AxTaskInclusionSnapshot,
  AxTaskStat,
  AxTaskStatPhase,
  AxTaskStatTable,
  axComputeInclusionProbabilities,
  axIpwPairedDifference,
  axSampleByInclusion,
} from './taskDiscrimination.js';

// The strategy union is closed. A third value would need its own estimator —
// the sampler and the estimator are one decision — so adding one must be a
// compile error rather than a silent fall-through to the sum comparison.
type _strategyIsClosed = Expect<
  Equal<AxMinibatchStrategy, 'uniform' | 'discriminative'>
>;
// @ts-expect-error there is no third minibatch strategy
const _adaptive: AxMinibatchStrategy = 'adaptive';

// Only the two paired phases feed the stat table. A merge subsample or a Pareto
// evaluation is not a candidate trial on that task.
type _phasesAreClosed = Expect<
  Equal<AxTaskStatPhase, 'parent_minibatch' | 'child_minibatch'>
>;
// @ts-expect-error the merge subsample never feeds the stat table
const _mergePhase: AxTaskStatPhase = 'merge_subsample';

declare const inclusion: AxTaskInclusion;
// @ts-expect-error inclusion rows are read-only once computed
inclusion.probability = 1;

declare const stat: AxTaskStat;
// @ts-expect-error task history is read-only
stat.trials = 0;

type _samplerReturnsReadonly = Expect<
  Equal<ReturnType<typeof axSampleByInclusion>, readonly number[]>
>;
type _inclusionsAreReadonly = Expect<
  Equal<
    ReturnType<typeof axComputeInclusionProbabilities>,
    readonly AxTaskInclusion[]
  >
>;

// The resolved options are total: every knob has a value by the time anything
// downstream reads one, so no consumer re-derives a default.
type _resolvedIsTotal = Expect<
  Equal<
    AxResolvedTaskDiscriminationOptions,
    {
      readonly successThreshold: number;
      readonly explorationFloor: number;
      readonly maxReportedTasks: number;
      readonly maxInclusionSnapshots: number;
    }
  >
>;

// `record` takes no options argument: the resolved options are captured once at
// construction so a run cannot change what "solved" means halfway through.
declare const table: AxTaskStatTable;
type _recordSignature = Expect<
  Equal<
    Parameters<typeof table.record>,
    [index: number, scalar: number, iteration: number]
  >
>;

// The estimate reports its own precision alongside the number. `stderr` is an
// approximation (Madow drives some joint inclusion probabilities to zero) and
// is reported, never gated on — there is deliberately no `significant` flag or
// confidence interval on this type to gate against.
type _estimateShape = Expect<
  Equal<
    keyof AxIpwEstimate,
    'estimate' | 'stderr' | 'effectiveSampleSize' | 'rowCount'
  >
>;
type _pairedReturnsAnEstimate = Expect<
  Equal<ReturnType<typeof axIpwPairedDifference>, AxIpwEstimate>
>;

declare const snapshot: AxTaskInclusionSnapshot;
// @ts-expect-error a published snapshot is read-only
snapshot.batchSize = 1;
// @ts-expect-error the sampled index list is read-only
snapshot.sampledIndices.push(0);
