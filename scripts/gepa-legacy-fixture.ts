import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = resolve(process.argv[2]!);
const mode = process.argv[3] as 'omitted' | 'false';
const { AxGEPA } = await import(
  pathToFileURL(resolve(checkout, 'src/ax/dsp/optimizers/gepa.ts')).href
);
const { axDeserializeOptimizedProgram, axSerializeOptimizedProgram } =
  await import(
    pathToFileURL(resolve(checkout, 'src/ax/dsp/optimizer.ts')).href
  );

// Optimization time is a public artifact field but elapsed wall time is not a
// revision-comparable value. Pin the clock so every other serialized field is
// compared without deleting or hand-normalizing artifact state.
Date.now = () => 1_000_000;

type ScenarioResult = {
  events: unknown[];
  checkpoints: unknown[];
  selection: unknown;
  artifactRoundTrip: unknown;
  randDraws: number;
};

/**
 * Run one GEPA compile and reduce it to the revision-comparable projection.
 *
 * `randDraws` is captured because the legacy-invariance claim is about the
 * shared xorshift stream, not only about the indices it happens to produce:
 * a refactor that moves a draw from one consumer to another can leave every
 * minibatch identical while silently changing parent selection or merge
 * subsampling.
 */
const runScenario = async (
  build: () => {
    program: unknown;
    optimizerArgs: Record<string, unknown>;
    examples: readonly Record<string, unknown>[];
    metric: (args: { prediction: any }) => Promise<number>;
    compileOptions: Record<string, unknown>;
    reflect: (componentId: string, current: string) => Promise<string>;
    events: unknown[];
    checkpoints: unknown[];
  }
): Promise<ScenarioResult> => {
  const scenario = build();
  const optimizer = new AxGEPA(scenario.optimizerArgs as any);
  let randDraws = 0;
  const rand = (optimizer as any).rand.bind(optimizer);
  (optimizer as any).rand = () => {
    randDraws += 1;
    return rand();
  };
  (optimizer as any).reflectTargetInstruction = async (
    componentId: string,
    current: string
  ) => scenario.reflect(componentId, current);
  const result = await optimizer.compile(
    scenario.program as any,
    scenario.examples as any,
    scenario.metric as any,
    scenario.compileOptions as any
  );
  const serializedArtifact = axSerializeOptimizedProgram(
    result.optimizedProgram!
  );
  const restoredArtifact = axDeserializeOptimizedProgram(serializedArtifact);
  const restoredSerializedArtifact =
    axSerializeOptimizedProgram(restoredArtifact);
  if (
    JSON.stringify(restoredSerializedArtifact) !==
    JSON.stringify(serializedArtifact)
  ) {
    throw new Error(
      'optimized artifact serialize/deserialize round trip changed state'
    );
  }
  const stableCheckpoints = (scenario.checkpoints as any[]).map(
    ({ timestamp: _timestamp, stats: _stats, ...checkpoint }) => checkpoint
  );
  return {
    events: scenario.events,
    checkpoints: stableCheckpoints,
    selection: {
      bestScore: result.bestScore,
      componentMap: result.optimizedProgram?.componentMap,
      candidateLineage: result.optimizedProgram?.candidateLineage,
    },
    artifactRoundTrip: {
      serializedArtifact,
      restoredSerializedArtifact,
      artifactKeys: Object.keys(result.optimizedProgram!).sort(),
      restoredArtifactKeys: Object.keys(restoredArtifact).sort(),
    },
    randDraws,
  };
};

/**
 * Scenario 1 — the original single-component, `minibatch: false`, `mergeMax: 0`
 * shape. Kept verbatim so the historical comparison surface is unchanged.
 */
const legacy = await runScenario(() => {
  let instruction = 'base';
  const events: unknown[] = [];
  const checkpoints: unknown[] = [];
  const program = {
    getId: () => 'root',
    setId: () => {},
    getInstruction: () => instruction,
    setInstruction: (value: string) => {
      instruction = value;
    },
    getSignature: () => ({
      getDescription: () => 'base',
      toString: () => '"base" question:string -> answer:string',
    }),
    namedProgramInstances: () => [],
    getOptimizableComponents: () => [
      { key: 'instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      instruction = updates.instruction ?? instruction;
    },
    forward: async () => ({ score: instruction === 'better' ? 1 : 0 }),
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
  return {
    program,
    optimizerArgs: {
      studentAI: {},
      teacherAI: {},
      numTrials: 1,
      minibatch: false,
      mergeMax: 0,
      checkpointInterval: 1,
      checkpointSave: async (checkpoint: unknown) => {
        checkpoints.push(checkpoint);
        return `checkpoint-${checkpoints.length}`;
      },
      debugOptimizer: true,
      optimizerLogger: (event: unknown) => events.push(event),
    },
    examples: [{ question: 'q1' }, { question: 'q2' }],
    metric: async ({ prediction }: any) => prediction.score,
    compileOptions: {
      maxMetricCalls: 20,
      skipPerfectScore: false,
      ...(mode === 'false' ? { candidateLineage: false } : {}),
    },
    reflect: async () => 'better',
    events,
    checkpoints,
  };
});

/**
 * Scenario 2 — the two code paths scenario 1 cannot reach.
 *
 * `minibatch: true` makes `nextMinibatchIndices` (and therefore the epoch
 * shuffler that consumes most of the RNG stream) live, and `mergeMax: 5` —
 * GEPA's own default — makes the `system_merge` block and its second, wholly
 * independent promotion gate live. Three components with distinct kinds
 * (`instruction`, `description`, `fn-desc`) let separate rounds mutate
 * separate components, which is what produces two Pareto candidates with a
 * common ancestor and a mergeable component difference.
 */
const minibatchMerge = await runScenario(() => {
  const componentIds = [
    'root::instruction',
    'root::description',
    'root::fn-desc:answer',
  ] as const;
  const values: Record<string, string> = {
    'root::instruction': 'base',
    'root::description': 'base',
    'root::fn-desc:answer': 'base',
  };
  const events: unknown[] = [];
  const checkpoints: unknown[] = [];
  // Each component owns a disjoint slice of the example set and improving it
  // TRADES: +0.4 on its own slice, -0.05 on every other slice. The trade is
  // what keeps siblings mutually non-dominated, which is the only way the
  // Pareto front holds more than one program and the `system_merge` block gets
  // two candidates with a common ancestor to merge.
  const owner = (index: number): string => componentIds[index % 3]!;
  const scoreRow = (index: number): number => {
    const improved = componentIds.filter((id) => values[id] === `better-${id}`);
    const own = improved.includes(owner(index) as (typeof componentIds)[number])
      ? 0.4
      : 0;
    const others = improved.filter((id) => id !== owner(index)).length;
    return 0.6 + own - 0.05 * others;
  };
  const program = {
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
    getOptimizableComponents: () => [
      {
        key: 'root::instruction',
        kind: 'instruction',
        current: values['root::instruction']!,
      },
      {
        key: 'root::description',
        kind: 'description',
        current: values['root::description']!,
      },
      {
        key: 'root::fn-desc:answer',
        kind: 'fn-desc',
        current: values['root::fn-desc:answer']!,
      },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      for (const id of componentIds) {
        const next = updates[id];
        if (typeof next === 'string') values[id] = next;
      }
    },
    forward: async (_ai: unknown, example: Readonly<{ index: number }>) => ({
      score: scoreRow(example.index),
    }),
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
  return {
    program,
    optimizerArgs: {
      studentAI: {},
      teacherAI: {},
      numTrials: 6,
      minibatch: true,
      minibatchSize: 2,
      mergeMax: 5,
      checkpointInterval: 1,
      checkpointSave: async (checkpoint: unknown) => {
        checkpoints.push(checkpoint);
        return `checkpoint-${checkpoints.length}`;
      },
      debugOptimizer: true,
      optimizerLogger: (event: unknown) => events.push(event),
    },
    examples: Array.from({ length: 9 }, (_, index) => ({
      index,
      question: `q${index}`,
    })),
    metric: async ({ prediction }: any) => prediction.score,
    compileOptions: {
      maxMetricCalls: 200,
      skipPerfectScore: false,
      // Scenario 1 never turns lineage on, so the whole candidate-lineage
      // manifest — the surface a later commit versions to v2 — is invisible to
      // the gate. Scenario 2 turns it on in the `omitted` mode and off in the
      // `false` mode, keeping both modes meaningful while covering it.
      candidateLineage: mode !== 'false',
    },
    reflect: async (componentId: string) => `better-${componentId}`,
    events,
    checkpoints,
  };
});

/**
 * Scenarios 3 and 4 — the merge gate's COMPARISON, not just its code path.
 *
 * Scenario 2 makes the `system_merge` block live but only exercises its accept
 * branch, with a merge candidate that beats both parents comfortably. The gate
 * at `gepa.ts:950-957` is therefore blind to the expression itself: mutating
 * `Math.max(id1Sum, id2Sum)` to `Math.min(...)`, or `>=` to `>`, changed
 * nothing observable. That expression is exactly what a later commit rewrites,
 * so it is pinned here.
 *
 * Both scenarios use two components (A = `instruction`, B = `description`) over
 * nine examples whose rows rotate through three kinds:
 *
 *   - `a` rows, which A's improvement helps (+0.25);
 *   - `b` rows, which B's improvement helps (+0.125 — deliberately SMALLER, so
 *     the two parents' subsample sums differ and `max` is distinguishable from
 *     `min`);
 *   - `n` rows, which every improvement hurts slightly. Without them the
 *     unimproved seed is dominated the moment anything improves, GEPA's Pareto
 *     front collapses to a single lineage, and the two siblings with a common
 *     ancestor that a merge requires never both exist. Scenario 2's `-0.05`
 *     cross-slice penalty does the same job.
 *
 * `pickSome` (`gepa.ts:874-899`) takes two rows from `p1` (rows where parent i
 * wins), two from `p2` (parent j wins) and one from `p3` (ties), and all rows
 * of one kind carry the same score — so the subsample's COMPOSITION, 2 `a` +
 * 2 `b` + 1 `n`, is fixed even though which rows are drawn is not. Every score
 * is a binary-exact fraction, so these sums are exact:
 *
 *   parent {A} over the subsample: 2(0.75) + 2(0.5)   + 0.46875 = 2.96875
 *   parent {B} over the subsample: 2(0.5)  + 2(0.625) + 0.46875 = 2.71875
 *
 * Scenario 3's merge scores 2(0.6875) + 2(0.5625) + 0.4375 = **2.9375**,
 * strictly between the two, so the real `Math.max` gate REJECTS and a
 * `Math.min` gate ACCEPTS.
 *
 * Scenario 4's merge scores exactly parent {A}'s rows, so newSum ==
 * max(id1Sum, id2Sum) == **2.96875**: the real `>=` gate ACCEPTS and a `>`
 * gate REJECTS. An exact tie is the only construction that can see that
 * mutation, because `minImprovementThreshold` defaults to 0 (`gepa.ts:218`)
 * and the two operators differ nowhere else.
 *
 * Verified by injecting both mutations into `gepa.ts` and re-running
 * `npm run test:gepa-upstream-compatibility`: each exits 1 with these
 * scenarios present and passed without them.
 */
type RowKind = 'a' | 'b' | 'n';
type ImprovedKey = 'none' | 'A' | 'B' | 'AB';
type ScoreTable = Readonly<
  Record<RowKind, Readonly<Record<ImprovedKey, number>>>
>;

/** Merge scores strictly between the two parents' subsample sums. */
const BETWEEN_TABLE: ScoreTable = {
  a: { none: 0.5, A: 0.75, B: 0.5, AB: 0.6875 },
  b: { none: 0.5, A: 0.5, B: 0.625, AB: 0.5625 },
  n: { none: 0.5, A: 0.46875, B: 0.46875, AB: 0.4375 },
};

/** Merge scores exactly what the better parent scores: the `>=` boundary. */
const TIED_TABLE: ScoreTable = {
  a: { none: 0.5, A: 0.75, B: 0.5, AB: 0.75 },
  b: { none: 0.5, A: 0.5, B: 0.625, AB: 0.5 },
  n: { none: 0.5, A: 0.46875, B: 0.46875, AB: 0.46875 },
};

const buildMergeGateScenario = (table: ScoreTable) => () => {
  const componentA = 'root::instruction';
  const componentB = 'root::description';
  const componentIds = [componentA, componentB] as const;
  const values: Record<string, string> = {
    [componentA]: 'base',
    [componentB]: 'base',
  };
  const events: unknown[] = [];
  const checkpoints: unknown[] = [];
  const rowKind = (index: number): RowKind =>
    (['a', 'b', 'n'] as const)[index % 3]!;
  const improvedKey = (): ImprovedKey => {
    const a = values[componentA] === `better-${componentA}`;
    const b = values[componentB] === `better-${componentB}`;
    if (a && b) return 'AB';
    if (a) return 'A';
    if (b) return 'B';
    return 'none';
  };
  const scoreRow = (index: number): number =>
    table[rowKind(index)][improvedKey()];
  const program = {
    getId: () => 'root',
    setId: () => {},
    getInstruction: () => values[componentA]!,
    setInstruction: (value: string) => {
      values[componentA] = value;
    },
    getSignature: () => ({
      getDescription: () => values[componentB]!,
      toString: () => '"base" question:string -> answer:string',
    }),
    namedProgramInstances: () => [],
    getOptimizableComponents: () => [
      { key: componentA, kind: 'instruction', current: values[componentA]! },
      { key: componentB, kind: 'description', current: values[componentB]! },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      for (const id of componentIds) {
        const next = updates[id];
        if (typeof next === 'string') values[id] = next;
      }
    },
    forward: async (_ai: unknown, example: Readonly<{ index: number }>) => ({
      score: scoreRow(example.index),
    }),
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
  return {
    program,
    optimizerArgs: {
      studentAI: {},
      teacherAI: {},
      numTrials: 12,
      // GEPA stops after `earlyStoppingTrials` (default 5) rounds without an
      // archive improvement. These scenarios deliberately spend rounds on
      // rejected children, so the default stops the run before the two
      // siblings a merge needs both exist.
      earlyStoppingTrials: 30,
      minibatch: true,
      minibatchSize: 2,
      mergeMax: 5,
      checkpointInterval: 1,
      checkpointSave: async (checkpoint: unknown) => {
        checkpoints.push(checkpoint);
        return `checkpoint-${checkpoints.length}`;
      },
      debugOptimizer: true,
      optimizerLogger: (event: unknown) => events.push(event),
    },
    examples: Array.from({ length: 9 }, (_, index) => ({
      index,
      question: `q${index}`,
    })),
    metric: async ({ prediction }: any) => prediction.score,
    compileOptions: {
      maxMetricCalls: 200,
      skipPerfectScore: false,
      candidateLineage: mode !== 'false',
    },
    reflect: async (componentId: string) => `better-${componentId}`,
    events,
    checkpoints,
  };
};

const mergeRejected = await runScenario(buildMergeGateScenario(BETWEEN_TABLE));
const mergeTied = await runScenario(buildMergeGateScenario(TIED_TABLE));

/**
 * Scenario 5 — the reflective-mutation gate's BOUNDARY.
 *
 * Scenarios 3 and 4 pin the merge gate's comparison. The mutation gate at
 * `gepa.ts:1318-1319` is still only pinned by its code path and by the
 * `minImprovementThreshold` default, not by the operator itself: with
 * `minImprovementThreshold` at 0 (`gepa.ts:218`), `>` and `>=` differ nowhere
 * except at an exact tie, and no other scenario produces one.
 *
 * Here the proposed component text changes on every round but changes NOTHING
 * about the score, so the child's minibatch sum equals the parent's exactly
 * (2 rows x 0.5 = 1). The real `>` gate REJECTS every round; a `>=` gate would
 * accept, push a candidate, run a validation evaluation and rewrite the whole
 * lineage, selection and event projection. The component delta is non-empty, so
 * the rejection is `insufficient_minibatch_improvement` rather than
 * `no_component_change` — the score comparison is what decided it.
 */
const mutationGateTied = await runScenario(() => {
  let instruction = 'base';
  const events: unknown[] = [];
  const checkpoints: unknown[] = [];
  const program = {
    getId: () => 'root',
    setId: () => {},
    getInstruction: () => instruction,
    setInstruction: (value: string) => {
      instruction = value;
    },
    getSignature: () => ({
      getDescription: () => 'base',
      toString: () => '"base" question:string -> answer:string',
    }),
    namedProgramInstances: () => [],
    getOptimizableComponents: () => [
      { key: 'root::instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      const next = updates['root::instruction'];
      if (typeof next === 'string') instruction = next;
    },
    // Deliberately independent of `instruction`: the proposal is real, its
    // effect is exactly zero.
    forward: async () => ({ score: 0.5 }),
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
  return {
    program,
    optimizerArgs: {
      studentAI: {},
      teacherAI: {},
      numTrials: 4,
      earlyStoppingTrials: 30,
      minibatch: true,
      minibatchSize: 2,
      mergeMax: 0,
      checkpointInterval: 1,
      checkpointSave: async (checkpoint: unknown) => {
        checkpoints.push(checkpoint);
        return `checkpoint-${checkpoints.length}`;
      },
      debugOptimizer: true,
      optimizerLogger: (event: unknown) => events.push(event),
    },
    examples: Array.from({ length: 6 }, (_, index) => ({
      index,
      question: `q${index}`,
    })),
    metric: async ({ prediction }: any) => prediction.score,
    compileOptions: {
      maxMetricCalls: 200,
      skipPerfectScore: false,
      candidateLineage: mode !== 'false',
    },
    reflect: async (componentId: string) => `better-${componentId}`,
    events,
    checkpoints,
  };
});

/**
 * In-fixture coverage self-check.
 *
 * The gate only compares this fixture's output across two revisions, so it
 * cannot notice that the fixture stopped covering something — which is exactly
 * how the original `mergeMax: 0` shape stayed blind for as long as it did.
 * These assertions fail the fixture on BOTH revisions, so a lost merge branch
 * surfaces as a fixture error rather than as a false incompatibility.
 *
 * The subsample sums are pinned too: `scalarScore * evaluatedExamples` is the
 * `newSum` the gate compares, so a score-table edit that quietly moves the
 * merge candidate off the "strictly between" or "exactly equal" boundary trips
 * here instead of silently retiring the tripwire.
 */
const strategyRecords = (
  result: ScenarioResult,
  strategy: string,
  decision: string
): readonly Record<string, unknown>[] => {
  const lineage = (
    result.selection as {
      candidateLineage?: { records?: readonly Record<string, unknown>[] };
    }
  ).candidateLineage;
  return (lineage?.records ?? []).filter(
    (record) => record.strategy === strategy && record.decision === decision
  );
};

const mergeRecords = (
  result: ScenarioResult,
  decision: string
): readonly Record<string, unknown>[] =>
  strategyRecords(result, 'system_merge', decision);

const phaseSum = (record: Record<string, unknown>, phase: string): number => {
  const evaluations = record.evaluations as readonly Record<string, unknown>[];
  const evaluation = evaluations.find((entry) => entry.phase === phase);
  if (!evaluation) throw new Error(`record has no ${phase} evaluation`);
  return (
    (evaluation.scalarScore as number) *
    (evaluation.evaluatedExamples as number)
  );
};

const subsampleSum = (record: Record<string, unknown>): number =>
  phaseSum(record, 'merge_subsample');

const requireMergeCoverage = (
  label: string,
  result: ScenarioResult,
  decision: string,
  expectedSum: number
): void => {
  const records = mergeRecords(result, decision);
  if (records.length === 0) {
    throw new Error(
      `fixture coverage lost: ${label} emitted no ${decision} system_merge record; the merge gate's comparison is no longer pinned`
    );
  }
  const sums = records.map(subsampleSum);
  // Tolerance rather than `===` only because the sum makes a round trip
  // through the recorded mean; every score in the tables is binary-exact, so
  // any real drift is orders of magnitude larger than this.
  if (!sums.some((sum) => Math.abs(sum - expectedSum) < 1e-9)) {
    throw new Error(
      `fixture coverage lost: ${label} expected a ${decision} merge whose subsample sum is ${expectedSum}, saw ${JSON.stringify(sums)}`
    );
  }
};

/**
 * The mutation gate's own coverage assertion. It fails on both revisions at
 * once if the tie ever stops being a tie — a rejected record whose child
 * minibatch sum is exactly the parent's is the only shape that can distinguish
 * `>` from `>=` there.
 */
const requireMutationGateCoverage = (
  label: string,
  result: ScenarioResult,
  expectedChildSum: number
): void => {
  const rejected = strategyRecords(result, 'reflective_mutation', 'rejected');
  const tied = rejected.filter(
    (record) =>
      record.reason === 'insufficient_minibatch_improvement' &&
      Math.abs(phaseSum(record, 'child_minibatch') - expectedChildSum) < 1e-9
  );
  if (tied.length === 0) {
    throw new Error(
      `fixture coverage lost: ${label} emitted no rejected reflective_mutation record whose child minibatch sum is ${expectedChildSum}; the mutation gate's comparison is no longer pinned`
    );
  }
  const accepted = strategyRecords(result, 'reflective_mutation', 'accepted');
  if (accepted.length > 0) {
    throw new Error(
      `fixture coverage lost: ${label} accepted a reflective mutation whose score change is exactly zero`
    );
  }
};

if (mode !== 'false') {
  requireMergeCoverage('scenario 3', mergeRejected, 'rejected', 2.9375);
  requireMergeCoverage('scenario 4', mergeTied, 'accepted', 2.96875);
  requireMutationGateCoverage('scenario 5', mutationGateTied, 1);
}

process.stdout.write(
  JSON.stringify({
    legacy,
    minibatchMerge,
    mergeRejected,
    mergeTied,
    mutationGateTied,
  })
);
