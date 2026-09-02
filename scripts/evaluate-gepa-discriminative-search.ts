import { pathToFileURL } from 'node:url';
import type { AxAIService } from '../src/ax/ai/types.js';
import { AxGEPA } from '../src/ax/dsp/optimizers/gepa.js';

/**
 * Deterministic, zero-cost evaluation of GEPA's opt-in discriminative
 * minibatch sampler.
 *
 * CLAIM (cost, not quality): on a validation set where most tasks carry no
 * information about which candidate is better, `minibatchStrategy:
 * 'discriminative'` reaches the same selected configuration as
 * `'uniform'` at a lower metric-call count.
 *
 * DECLARED BASELINE: `minibatchStrategy: 'uniform'` on the identical fixture,
 * identical seed, identical budget cap and identical program.
 *
 * NO OUTCOME-QUALITY IMPROVEMENT IS CLAIMED. Selecting the same configuration
 * for fewer calls is a search-efficiency result, not evidence that the
 * resulting program is better at anything.
 *
 * There is no AI service, no provider, no network: `forward` is a table lookup.
 */

type Strategy = 'uniform' | 'discriminative';

// Fixed, not configurable: an evaluation whose fixture can be dialled from the
// environment is an evaluation whose result can be dialled from the environment.
const FIXTURE1_TRIALS = 40;
const FIXTURE1_BATCH = 4;
const FIXTURE1_VALIDATION = 16;
const F1_PASS = 18;
const F1_FAIL = 18;
const F1_SPLIT = 24;
const F1_TOTAL = F1_PASS + F1_FAIL + F1_SPLIT;
const FIXTURE2_TRIALS = 8;
const FIXTURE2_BATCH = 4;
const FIXTURE2_VALIDATION = 12;

/**
 * Eight optimizable components, not three.
 *
 * The sampler's claim is about a difficulty structure that PERSISTS across
 * rounds. A one- or three-component fixture is solved in a handful of rounds,
 * before a cold statistics table has learned anything, so it cannot separate
 * the two strategies no matter how the numbers are chosen. With eight
 * components the informative tasks stay informative until their own component
 * is improved, which is exactly the regime the design targets.
 */
const COMPONENT_IDS = [
  'root::instruction',
  'root::description',
  'root::fn-desc:f1',
  'root::fn-desc:f2',
  'root::fn-desc:f3',
  'root::fn-desc:f4',
  'root::fn-desc:f5',
  'root::fn-desc:f6',
] as const;

const COMPONENT_KINDS: readonly string[] = [
  'instruction',
  'description',
  'fn-desc',
  'fn-desc',
  'fn-desc',
  'fn-desc',
  'fn-desc',
  'fn-desc',
];

type TaskKind =
  | 'always_pass'
  | 'always_fail'
  | 'discriminating'
  | 'alternating';

/**
 * Fixture 1 — 60 tasks: 24 always pass, 18 always fail, 18 discriminate.
 *
 * The 42 non-discriminating tasks are where a uniform draw spends most of its
 * budget: an always-passing task cannot separate two candidates, and neither
 * can an always-failing one. A variance-weighted design is supposed to notice
 * that; the exploration floor is what stops it from concluding the
 * always-failing tasks are permanently useless.
 */
type Task = Readonly<{ kind: TaskKind; owner?: string }>;

const buildTasks = (
  counts: Readonly<Partial<Record<TaskKind, number>>>
): readonly Task[] => {
  const tasks: Task[] = [];
  const alternating = counts.alternating ?? 0;
  const total =
    (counts.always_pass ?? 0) +
    (counts.always_fail ?? 0) +
    (counts.discriminating ?? 0) +
    alternating;
  // Interleaved rather than blocked, so a sampler that simply favours low or
  // high indices scores no better than one that reads the statistics.
  let pass = counts.always_pass ?? 0;
  let fail = counts.always_fail ?? 0;
  let split = counts.discriminating ?? 0;
  let alternate = alternating;
  let splitSeen = 0;
  for (let index = 0; index < total; index++) {
    const remaining = [
      ['always_pass', pass] as const,
      ['always_fail', fail] as const,
      ['discriminating', split] as const,
      ['alternating', alternate] as const,
    ].filter(([, count]) => count > 0);
    const [kind] = remaining[index % remaining.length]!;
    if (kind === 'always_pass') {
      pass -= 1;
      tasks.push({ kind });
    } else if (kind === 'always_fail') {
      fail -= 1;
      tasks.push({ kind });
    } else if (kind === 'alternating') {
      alternate -= 1;
      tasks.push({ kind });
    } else {
      split -= 1;
      // The owning component is assigned by ORDER OF APPEARANCE among the
      // discriminating tasks, never by `index % 3`: the interleaver already
      // places the discriminating tasks on a fixed residue, so keying the owner
      // on the index would give every discriminating task the same owner and
      // make two of the three components permanently unimprovable. (Found the
      // hard way: the first version of this fixture did exactly that.)
      tasks.push({
        kind,
        owner: COMPONENT_IDS[splitSeen % COMPONENT_IDS.length]!,
      });
      splitSeen += 1;
    }
  }
  return tasks;
};

const buildProgram = (tasks: readonly Task[]) => {
  const values: Record<string, string> = Object.fromEntries(
    COMPONENT_IDS.map((id) => [id, 'base'])
  );
  const flips = new Map<number, number>();
  return {
    getId: () => 'root',
    setId: () => {},
    getInstruction: () => values['root::instruction']!,
    setInstruction: (value: string) => {
      values['root::instruction'] = value;
    },
    getSignature: () => ({
      getDescription: () => values['root::description']!,
      toString: () => '"base" question:string -> answer:string',
    }),
    namedProgramInstances: () => [],
    getOptimizableComponents: () =>
      COMPONENT_IDS.map((key, position) => ({
        key,
        kind: COMPONENT_KINDS[position]!,
        current: values[key]!,
      })),
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      for (const id of COMPONENT_IDS) {
        const next = updates[id];
        if (typeof next === 'string') values[id] = next;
      }
    },
    forward: async (_ai: AxAIService, example: Readonly<{ index: number }>) => {
      const task = tasks[example.index]!;
      if (task.kind === 'always_pass')
        return { score: 1, index: example.index };
      if (task.kind === 'always_fail')
        return { score: 0, index: example.index };
      if (task.kind === 'alternating') {
        const seen = (flips.get(example.index) ?? 0) + 1;
        flips.set(example.index, seen);
        return { score: seen % 2, index: example.index };
      }
      const owner = task.owner!;
      return {
        score: values[owner] === `better-${owner}` ? 1 : 0,
        index: example.index,
      };
    },
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
};

type RunResult = {
  readonly strategy: Strategy;
  readonly seed: number;
  readonly componentMap: Record<string, string>;
  readonly bestScore: number;
  readonly totalCalls: number;
  /** Metric calls consumed at the moment the SELECTED candidate was decided. */
  readonly callsToSelected: number;
  readonly randDraws: number;
  readonly records: readonly any[];
  readonly sampledIndices: readonly number[];
  readonly nonDiscriminativeTaskFraction?: number;
  readonly minInclusionProbability?: number;
  readonly explorationFloor?: number;
  readonly projection: string;
};

const runOnce = async (args: {
  tasks: readonly Task[];
  strategy: Strategy;
  seed: number;
  explicitStrategyOption: boolean;
  numTrials: number;
  minibatchSize: number;
  maxMetricCalls: number;
  validationCount: number;
}): Promise<RunResult> => {
  const events: any[] = [];
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: args.numTrials,
    earlyStoppingTrials: 1000,
    minibatch: true,
    minibatchSize: args.minibatchSize,
    mergeMax: 0,
    seed: args.seed,
    debugOptimizer: true,
    optimizerLogger: (event: unknown) => events.push(event),
  } as any);
  let randDraws = 0;
  const rand = (optimizer as any).rand.bind(optimizer);
  (optimizer as any).rand = () => {
    randDraws += 1;
    return rand();
  };
  (optimizer as any).reflectTargetInstruction = async (componentId: string) =>
    `better-${componentId}`;

  const result = await optimizer.compile(
    buildProgram(args.tasks) as any,
    args.tasks.map((_, index) => ({ index })) as any,
    (async ({ prediction }: any) => prediction.score) as any,
    {
      maxMetricCalls: args.maxMetricCalls,
      skipPerfectScore: false,
      candidateLineage: true,
      // The validation set and the feedback set are decoupled on purpose. The
      // sampler only changes which MINIBATCH rows are drawn; a validation
      // evaluation over every task on every accepted round would swamp that
      // difference in the total and measure the archive step instead.
      validationExamples: args.tasks
        .slice(0, args.validationCount)
        .map((_, index) => ({ index })),
      feedbackExamples: args.tasks.map((_, index) => ({ index })),
      ...(args.explicitStrategyOption
        ? { minibatchStrategy: args.strategy }
        : {}),
    } as any
  );

  const lineage = result.optimizedProgram?.candidateLineage;
  const selectedId = lineage?.selectedCandidateId;
  const selectedRecord = (lineage?.records ?? []).find(
    (record: any) => record.id === selectedId
  );
  const complete = events.find(
    (event) => event.name === 'OptimizationComplete'
  );
  const snapshots = events
    .filter((event) => event.name === 'RoundProgress')
    .map((event) => event.value.inclusionSnapshot)
    .filter(Boolean);
  const minInclusionProbability = snapshots.length
    ? Math.min(
        ...snapshots.flatMap((snapshot: any) =>
          snapshot.inclusions.map((inclusion: any) => inclusion.probability)
        )
      )
    : undefined;

  return {
    strategy: args.strategy,
    seed: args.seed,
    componentMap: { ...(result.optimizedProgram?.componentMap ?? {}) },
    bestScore: result.bestScore,
    totalCalls: result.stats.totalCalls,
    callsToSelected:
      (selectedRecord?.metricCallsAtDecision as number | undefined) ??
      result.stats.totalCalls,
    randDraws,
    records: (lineage?.records ?? []) as readonly any[],
    sampledIndices: snapshots.flatMap(
      (snapshot: any) => snapshot.sampledIndices as readonly number[]
    ),
    nonDiscriminativeTaskFraction:
      complete?.value.discrimination?.nonDiscriminativeTaskFraction,
    minInclusionProbability,
    explorationFloor: snapshots.length
      ? (args.minibatchSize * 0.2) / args.tasks.length
      : undefined,
    // Everything a revision comparison would look at, for the "the option's
    // mere presence changes nothing" check.
    projection: JSON.stringify({
      events,
      componentMap: result.optimizedProgram?.componentMap,
      lineage,
      bestScore: result.bestScore,
    }),
  };
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const sameConfiguration = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean => JSON.stringify(left) === JSON.stringify(right);

export async function evaluateGepaDiscriminativeSearch() {
  const startedAt = Date.now();
  const seeds = Array.from({ length: 20 }, (_, index) => index + 1);

  // Fixture 1 — the cost claim.
  const fixture1 = buildTasks({
    always_pass: F1_PASS,
    always_fail: F1_FAIL,
    discriminating: F1_SPLIT,
  });
  const fixture1Runs: {
    seed: number;
    uniform: RunResult;
    discriminative: RunResult;
  }[] = [];
  for (const seed of seeds) {
    const uniform = await runOnce({
      tasks: fixture1,
      strategy: 'uniform',
      seed,
      explicitStrategyOption: false,
      numTrials: FIXTURE1_TRIALS,
      minibatchSize: FIXTURE1_BATCH,
      maxMetricCalls: 8000,
      validationCount: FIXTURE1_VALIDATION,
    });
    const discriminative = await runOnce({
      tasks: fixture1,
      strategy: 'discriminative',
      seed,
      explicitStrategyOption: true,
      numTrials: FIXTURE1_TRIALS,
      minibatchSize: FIXTURE1_BATCH,
      maxMetricCalls: 8000,
      validationCount: FIXTURE1_VALIDATION,
    });
    fixture1Runs.push({ seed, uniform, discriminative });
  }

  /**
   * The cost axis is METRIC CALLS TO REACH THE UNIFORM RUN'S FINAL SELECTED
   * QUALITY, measured identically for both strategies.
   *
   * Two weaker definitions were tried first and are recorded here because they
   * are the ones a reader would reach for:
   *
   *  - "calls at which each run's OWN selected candidate was decided" rewards a
   *    run that gives up early, because a run that stops improving decides its
   *    best candidate sooner and therefore looks cheaper;
   *  - "calls to a fixed target CONFIGURATION" only compares the handful of
   *    seeds where both strategies saturate, and saturation is precisely the
   *    regime where a variance-weighted sampler has nothing left to concentrate
   *    on, so it measures the sampler where it is designed not to help.
   *
   * Reaching a stated quality for fewer calls is the claim; the target is the
   * BASELINE's own final quality, so the baseline can never be disadvantaged by
   * the choice of target.
   */
  const callsToReachScore = (
    run: RunResult,
    targetScore: number
  ): number | undefined => {
    for (const record of run.records) {
      if (record.decision !== 'accepted') continue;
      const evaluation = (record.evaluations ?? []).find(
        (entry: any) =>
          entry.phase === 'validation' || entry.phase === 'initial_pareto'
      );
      if (
        evaluation &&
        (evaluation.scalarScore as number) >= targetScore - 1e-12
      ) {
        return record.metricCallsAtDecision as number;
      }
    }
    return undefined;
  };

  const paired = fixture1Runs.map((run) => {
    const targetScore = run.uniform.bestScore;
    return {
      seed: run.seed,
      targetScore,
      uniformCalls: callsToReachScore(run.uniform, targetScore),
      discriminativeCalls: callsToReachScore(run.discriminative, targetScore),
      finalScoreDelta: run.discriminative.bestScore - run.uniform.bestScore,
    };
  });
  const comparable = paired.filter(
    (entry) =>
      entry.uniformCalls !== undefined &&
      entry.discriminativeCalls !== undefined
  );
  const callRatios = comparable.map(
    (entry) => entry.discriminativeCalls! / entry.uniformCalls!
  );
  const agreementFlags = fixture1Runs.map((run) =>
    sameConfiguration(run.uniform.componentMap, run.discriminative.componentMap)
  );
  const seedsWhereDiscriminativeCostMore = comparable
    .filter((entry) => entry.discriminativeCalls! > entry.uniformCalls!)
    .map((entry) => entry.seed);
  const seedsWhereSelectionDiffered = fixture1Runs
    .filter((_, index) => !agreementFlags[index])
    .map((run) => run.seed);
  const seedsWhereDiscriminativeNeverMatched = paired
    .filter((entry) => entry.discriminativeCalls === undefined)
    .map((entry) => entry.seed);

  // The option's mere presence must change nothing on the uniform path.
  const implicitUniform = await runOnce({
    tasks: fixture1,
    strategy: 'uniform',
    seed: 7,
    explicitStrategyOption: false,
    numTrials: FIXTURE1_TRIALS,
    minibatchSize: FIXTURE1_BATCH,
    maxMetricCalls: 8000,
    validationCount: FIXTURE1_VALIDATION,
  });
  const explicitUniform = await runOnce({
    tasks: fixture1,
    strategy: 'uniform',
    seed: 7,
    explicitStrategyOption: true,
    numTrials: FIXTURE1_TRIALS,
    minibatchSize: FIXTURE1_BATCH,
    maxMetricCalls: 8000,
    validationCount: FIXTURE1_VALIDATION,
  });

  // Fixture 2 — the NEGATIVE CONTROL. One discriminating task among 59
  // non-discriminating ones. Selection agreement on fixture 1 is also achieved
  // by a sampler that ignores the statistics entirely, so without a fixture on
  // which the two strategies provably diverge, agreement proves nothing about
  // the concentration being real.
  const fixture2 = buildTasks({
    always_pass: 30,
    always_fail: 29,
    discriminating: 1,
  });
  const fixture2Runs: {
    seed: number;
    uniform: RunResult;
    discriminative: RunResult;
  }[] = [];
  for (const seed of seeds) {
    const uniform = await runOnce({
      tasks: fixture2,
      strategy: 'uniform',
      seed,
      explicitStrategyOption: false,
      numTrials: FIXTURE2_TRIALS,
      minibatchSize: FIXTURE2_BATCH,
      maxMetricCalls: 4000,
      validationCount: FIXTURE2_VALIDATION,
    });
    const discriminative = await runOnce({
      tasks: fixture2,
      strategy: 'discriminative',
      seed,
      explicitStrategyOption: true,
      numTrials: FIXTURE2_TRIALS,
      minibatchSize: FIXTURE2_BATCH,
      maxMetricCalls: 4000,
      validationCount: FIXTURE2_VALIDATION,
    });
    fixture2Runs.push({ seed, uniform, discriminative });
  }
  const negativeControlDivergence = fixture2Runs.filter(
    (run) =>
      !sameConfiguration(
        run.uniform.componentMap,
        run.discriminative.componentMap
      )
  ).length;

  /**
   * What the mechanism demonstrably DOES do: concentrate the draw.
   *
   * A uniform epoch-shuffled draw sees each task equally, so its expected share
   * of informative rows is exactly `discriminating / total`. Anything above
   * that is concentration the sampler produced, measured on the rows it
   * actually drew rather than on the probabilities it published.
   */
  const uniformInformativeShare = F1_SPLIT / F1_TOTAL;
  const informativeDrawShares = fixture1Runs.map((run) => {
    const drawn = run.discriminative.sampledIndices;
    if (drawn.length === 0) return 0;
    const informative = drawn.filter(
      (index) => fixture1[index]!.kind === 'discriminating'
    ).length;
    return informative / drawn.length;
  });
  const medianInformativeDrawShare = median(informativeDrawShares);

  /**
   * Fixture 3 — MECHANISM CHECK, separated from the cost measurement on
   * purpose.
   *
   * Fixture 1's informative tasks are informative only in the rounds that
   * mutate their own component, one in eight, so their observed pass rate looks
   * like an always-failing task's for most of the run and the sampler has
   * almost nothing to key on. That is a real property of the design and is why
   * fixture 1's concentration is negligible — but it means fixture 1 cannot
   * tell "the sampler is broken" from "the sampler had nothing to see".
   *
   * Here six tasks alternate pass/fail on every rollout, so their smoothed pass
   * rate sits at 0.5 and their Bernoulli variance at the maximum, while the
   * other 54 always pass or always fail. This is the regime the design is FOR,
   * and the concentration it produces is what is asserted.
   */
  const fixture3 = buildTasks({
    always_pass: 6,
    always_fail: 5,
    alternating: 1,
  });
  const fixture3Runs: RunResult[] = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    fixture3Runs.push(
      await runOnce({
        tasks: fixture3,
        strategy: 'discriminative',
        seed,
        explicitStrategyOption: true,
        numTrials: 40,
        minibatchSize: 2,
        maxMetricCalls: 8000,
        validationCount: 12,
      })
    );
  }
  const uniformAlternatingShare = 1 / fixture3.length;
  const alternatingDrawShares = fixture3Runs.map((run) => {
    const drawn = run.sampledIndices;
    if (drawn.length === 0) return 0;
    return (
      drawn.filter((index) => fixture3[index]!.kind === 'alternating').length /
      drawn.length
    );
  });
  const medianAlternatingDrawShare = median(alternatingDrawShares);

  const explorationFloorHonoured = [...fixture1Runs, ...fixture2Runs].every(
    (run) =>
      run.discriminative.minInclusionProbability !== undefined &&
      run.discriminative.explorationFloor !== undefined &&
      run.discriminative.minInclusionProbability >=
        run.discriminative.explorationFloor - 1e-12
  );

  const elapsedWallTimeMs = Date.now() - startedAt;
  const result = {
    claim:
      'discriminative minibatch selection reaches the same selected configuration as uniform selection at a lower metric-call count on a fixture where most validation tasks carry no signal',
    declaredBaseline:
      "minibatchStrategy: 'uniform' on the identical fixture, identical seed, identical budget cap",
    honesty:
      'This is a cost claim, not a quality claim. No outcome-quality improvement is claimed, and no independent reproduction exists.',
    costClaimNotSupported:
      'MEASURED NEGATIVE: on this fixture the discriminative sampler does NOT reach the baseline quality for fewer metric calls. The median call ratio sits at parity and the sampler fails to match the baseline quality at all on a substantial share of seeds. The mechanism does concentrate the draw (see fixture1.medianInformativeDrawShare against fixture1.uniformInformativeDrawShare), but the concentration does not convert into a cheaper promotion decision, because the Horvitz-Thompson weighting the estimator applies to stay design-unbiased divides each row by its own inclusion probability and therefore DOWN-weights exactly the rows the sampler up-sampled. Sampling and estimation cancel by construction. The pairing is deliberate and the alternative (concentrating the draw and then comparing a raw sum) is a biased gate, which is worse; but the search-efficiency claim in the RFC is not supported by this evaluation and is reported as unsupported rather than tuned into passing.',
    seeds: seeds.length,
    fixture1: {
      taskCounts: {
        always_pass: F1_PASS,
        always_fail: F1_FAIL,
        discriminating: F1_SPLIT,
      },
      selectionAgreement:
        agreementFlags.filter(Boolean).length / agreementFlags.length,
      seedsComparedOnCost: comparable.length,
      seedsWhereDiscriminativeNeverMatched,
      seedsWhereDiscriminativeScoredHigher: paired
        .filter((entry) => entry.finalScoreDelta > 1e-12)
        .map((entry) => entry.seed),
      seedsWhereDiscriminativeScoredLower: paired
        .filter((entry) => entry.finalScoreDelta < -1e-12)
        .map((entry) => entry.seed),
      medianCallRatio: median(callRatios),
      meanCallRatio:
        callRatios.reduce((total, ratio) => total + ratio, 0) /
        callRatios.length,
      minCallRatio: Math.min(...callRatios),
      maxCallRatio: Math.max(...callRatios),
      seedsWhereDiscriminativeCostMore,
      seedsWhereSelectionDiffered,
      medianUniformCallsToTarget: median(
        comparable.map((entry) => entry.uniformCalls!)
      ),
      medianDiscriminativeCallsToTarget: median(
        comparable.map((entry) => entry.discriminativeCalls!)
      ),
      medianNonDiscriminativeTaskFraction: median(
        fixture1Runs.map(
          (run) => run.discriminative.nonDiscriminativeTaskFraction ?? 0
        )
      ),
      uniformInformativeDrawShare: uniformInformativeShare,
      medianInformativeDrawShare,
      /**
       * REPORTED, NOT ASSERTED, and it is FALSE as measured. See the
       * `costClaimNotSupported` note below.
       */
      costClaimSupported: median(callRatios) < 1,
      medianFinalScoreDelta: median(
        paired.map((entry) => entry.finalScoreDelta)
      ),
    },
    negativeControl: {
      taskCounts: { always_pass: 30, always_fail: 29, discriminating: 1 },
      divergentSeeds: negativeControlDivergence,
      divergenceRate: negativeControlDivergence / seeds.length,
    },
    concentration: {
      description:
        'one maximum-variance task among eleven that carry no signal; five seeds, 40 rounds each',
      uniformAlternatingDrawShare: uniformAlternatingShare,
      medianAlternatingDrawShare,
      concentrationFactor: medianAlternatingDrawShare / uniformAlternatingShare,
    },
    explorationFloorHonoured,
    uniformIsBitIdenticalToBaseline:
      implicitUniform.projection === explicitUniform.projection,
    uniformRandDrawCount: implicitUniform.randDraws,
    explicitUniformRandDrawCount: explicitUniform.randDraws,
    budget: {
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: 30_000,
      elapsedWallTimeMs,
    },
  };

  // Only invariants that MUST hold are enforced here. The call ratio is
  // reported, never gated on: an evaluation that fails when its own claim is
  // not reproduced is an evaluation that will be tuned until it passes.
  if (
    result.fixture1.seedsComparedOnCost < 1 ||
    result.concentration.concentrationFactor < 1.25 ||
    result.negativeControl.divergentSeeds <= 0 ||
    !result.explorationFloorHonoured ||
    !result.uniformIsBitIdenticalToBaseline ||
    result.uniformRandDrawCount !== result.explicitUniformRandDrawCount ||
    elapsedWallTimeMs > result.budget.maxWallTimeMs
  ) {
    throw new Error(
      `GEPA discriminative search evaluation failed: ${JSON.stringify(result)}`
    );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    JSON.stringify(await evaluateGepaDiscriminativeSearch(), null, 2)
  );
}
