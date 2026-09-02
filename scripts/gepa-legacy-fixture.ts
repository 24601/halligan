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

process.stdout.write(JSON.stringify({ legacy, minibatchMerge }));
