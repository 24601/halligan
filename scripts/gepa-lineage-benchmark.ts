import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { AxAIService } from '../src/ax/ai/types.js';
import { AxGEPA } from '../src/ax/dsp/optimizers/gepa.js';
import type {
  AxGEPACandidateLineageManifest,
  AxGEPACandidateLineageOptions,
} from '../src/ax/dsp/optimizers/gepaLineage.js';

type ScenarioResult = {
  manifest?: AxGEPACandidateLineageManifest;
  callbackManifest?: AxGEPACandidateLineageManifest;
  selection: string;
};

const invariant = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`GEPA lineage benchmark failed: ${message}`);
};

const makeMergeProgram = () => {
  let values = {
    a: 'base-private-a "quoted" 雪\nline',
    b: 'base-private-b \\ escaped',
  };
  return {
    getId: () => 'root',
    setId: () => {},
    getSignature: () => ({ getDescription: () => '', toString: () => '' }),
    getOptimizableComponents: () => [
      { key: 'a', kind: 'instruction', current: values.a },
      { key: 'b', kind: 'instruction', current: values.b },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      values = { ...values, ...updates };
    },
    forward: async (_ai: AxAIService, example: { side: number }) => {
      const a = values.a === 'A';
      const b = values.b === 'B';
      const score =
        example.side === 0 ? (a ? 1 : b ? 0.3 : 0.6) : b ? 1 : a ? 0.3 : 0.6;
      return { score };
    },
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };
};

async function runMergeScenario(
  candidateLineage?: boolean | AxGEPACandidateLineageOptions,
  captureLog = true
): Promise<ScenarioResult> {
  let callbackManifest: AxGEPACandidateLineageManifest | undefined;
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 5,
    minibatch: false,
    earlyStoppingTrials: 10,
    minImprovementThreshold: 0,
    seed: 3,
    mergeMax: 5,
    debugOptimizer: captureLog,
    optimizerLogger: (event: any) => {
      if (event.name === 'OptimizationComplete') {
        callbackManifest = event.value.bestConfiguration.candidateLineage;
      }
    },
  } as any);
  (optimizer as any).reflectTargetInstruction = async (componentId: string) =>
    componentId === 'a' ? 'A' : 'B';
  const result = await optimizer.compile(
    makeMergeProgram() as any,
    [{ side: 0 }, { side: 1 }],
    async ({ prediction }) => (prediction as { score: number }).score,
    {
      maxMetricCalls: 200,
      skipPerfectScore: false,
      ...(candidateLineage === undefined ? {} : { candidateLineage }),
    }
  );
  return {
    manifest: result.optimizedProgram?.candidateLineage,
    callbackManifest,
    selection: JSON.stringify({
      bestScore: result.bestScore,
      componentMap: result.optimizedProgram?.componentMap,
      paretoFront: result.paretoFront.map((point) => point.configuration),
    }),
  };
}

async function runManyRecordScenario(): Promise<AxGEPACandidateLineageManifest> {
  let instruction = 'seed "quoted" 雪\nline \\ slash';
  const program = {
    ...makeMergeProgram(),
    getOptimizableComponents: () => [
      { key: 'instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      instruction = updates.instruction ?? instruction;
    },
    forward: async () => ({ score: 0 }),
  };
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 80,
    minibatch: false,
    earlyStoppingTrials: 100,
  });
  (optimizer as any).reflectTargetInstruction = async () =>
    'proposal "quoted" 雪\nline \\ slash';
  const result = await optimizer.compile(
    program as any,
    [{ side: 0 }, { side: 1 }],
    async () => 0,
    {
      maxMetricCalls: 400,
      skipPerfectScore: false,
      candidateLineage: {
        maxArtifactBytes: 4096,
        includeComponentValues: true,
        maxComponentValueChars: 1000,
      },
    }
  );
  if (!result.optimizedProgram?.candidateLineage) {
    throw new Error('GEPA lineage benchmark failed: missing candidate lineage');
  }
  return result.optimizedProgram.candidateLineage;
}

async function runBudgetAbortScenario(): Promise<AxGEPACandidateLineageManifest> {
  let instruction = 'private-seed';
  const program = {
    ...makeMergeProgram(),
    getOptimizableComponents: () => [
      { key: 'instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      instruction = updates.instruction ?? instruction;
    },
    forward: async () => ({ score: instruction === 'better' ? 1 : 0 }),
  };
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 1,
    minibatch: false,
    minImprovementThreshold: 0,
  });
  (optimizer as any).reflectTargetInstruction = async () => 'better';
  const result = await optimizer.compile(
    program as any,
    [{ side: 0 }, { side: 1 }],
    async ({ prediction }) => (prediction as { score: number }).score,
    {
      maxMetricCalls: 6,
      skipPerfectScore: false,
      candidateLineage: true,
    }
  );
  if (!result.optimizedProgram?.candidateLineage) {
    throw new Error('GEPA lineage benchmark failed: missing candidate lineage');
  }
  return result.optimizedProgram.candidateLineage;
}

async function runNoProposalTerminationScenario(
  maxMetricCalls: number
): Promise<AxGEPACandidateLineageManifest> {
  let instruction = 'seed';
  const program = {
    ...makeMergeProgram(),
    getOptimizableComponents: () => [
      { key: 'instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      instruction = updates.instruction ?? instruction;
    },
    forward: async () => ({ score: 0 }),
  };
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 1,
    minibatch: false,
  });
  const result = await optimizer.compile(
    program as any,
    [{ side: 0 }, { side: 1 }],
    async () => 0,
    { maxMetricCalls, skipPerfectScore: false, candidateLineage: true }
  );
  if (!result.optimizedProgram?.candidateLineage) {
    throw new Error('GEPA lineage benchmark failed: missing candidate lineage');
  }
  return result.optimizedProgram.candidateLineage;
}

async function assertInitialAbortIsNarrowed(): Promise<void> {
  const controller = new AbortController();
  controller.abort('pre-seed abort');
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 0,
  });
  let message = '';
  try {
    await optimizer.compile(
      makeMergeProgram() as any,
      [{ side: 0 }, { side: 1 }],
      async () => 0,
      { maxMetricCalls: 2, abortSignal: controller.signal }
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  invariant(
    message.includes('aborted before initial evaluation'),
    'pre-seed abort contract did not fail explicitly'
  );
}

async function runAbortSignalScenario(): Promise<AxGEPACandidateLineageManifest> {
  const controller = new AbortController();
  let instruction = 'seed';
  let calls = 0;
  const program = {
    ...makeMergeProgram(),
    getOptimizableComponents: () => [
      { key: 'instruction', kind: 'instruction', current: instruction },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      instruction = updates.instruction ?? instruction;
    },
    forward: async () => {
      calls += 1;
      if (calls === 5) controller.abort('benchmark abort');
      return { score: instruction === 'better' ? 1 : 0 };
    },
  };
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 1,
    minibatch: false,
  });
  (optimizer as any).reflectTargetInstruction = async () => 'better';
  const result = await optimizer.compile(
    program as any,
    [{ side: 0 }, { side: 1 }],
    async ({ prediction }) => (prediction as { score: number }).score,
    {
      maxMetricCalls: 20,
      skipPerfectScore: false,
      abortSignal: controller.signal,
      candidateLineage: true,
    }
  );
  if (!result.optimizedProgram?.candidateLineage) {
    throw new Error('GEPA lineage benchmark failed: missing candidate lineage');
  }
  return result.optimizedProgram.candidateLineage;
}

async function runFaultScenario(): Promise<AxGEPACandidateLineageManifest> {
  const secret = 'api-key-should-not-survive';
  const program = makeMergeProgram();
  program.forward = async () => {
    throw new Error(`runtime failure ${secret}`);
  };
  const optimizer = new AxGEPA({
    studentAI: {} as AxAIService,
    teacherAI: {} as AxAIService,
    numTrials: 0,
  });
  const result = await optimizer.compile(
    program as any,
    [{ side: 0 }, { side: 1 }],
    async () => 0,
    { maxMetricCalls: 2, candidateLineage: true }
  );
  const manifest = result.optimizedProgram?.candidateLineage;
  if (!manifest) {
    throw new Error('GEPA lineage benchmark failed: missing candidate lineage');
  }
  invariant(
    !JSON.stringify(manifest).includes(secret),
    'runtime secret leaked'
  );
  return manifest;
}

async function measureBatch(
  lineage: boolean,
  iterations: number
): Promise<number> {
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    await runMergeScenario(lineage ? true : undefined, false);
  }
  return performance.now() - start;
}

async function measurePairedSample(
  iterations: number,
  sample: number
): Promise<{ baselineMs: number; lineageMs: number }> {
  const chunkSize = 10;
  invariant(
    iterations % chunkSize === 0,
    'paired timing iterations must divide evenly into chunks'
  );
  let baselineMs = 0;
  let lineageMs = 0;
  for (let chunk = 0; chunk < iterations / chunkSize; chunk++) {
    if ((sample + chunk) % 2 === 0) {
      baselineMs += await measureBatch(false, chunkSize);
      lineageMs += await measureBatch(true, chunkSize);
    } else {
      lineageMs += await measureBatch(true, chunkSize);
      baselineMs += await measureBatch(false, chunkSize);
    }
  }
  return { baselineMs, lineageMs };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const quantile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
};

const range = (values: readonly number[]): readonly [number, number] => [
  Math.min(...values),
  Math.max(...values),
];

export async function runGEPALineageBenchmark(): Promise<{
  baselineMode: 'candidateLineage_omitted';
  candidates: number;
  artifactBytes: number;
  truncatedArtifactBytes: number;
  baselineMs: number;
  lineageMs: number;
  overheadMs: number;
  overheadRatio: number;
  overheadPerRunMs: number;
  cold: {
    iterations: number;
    baselineMs: number;
    lineageMs: number;
  };
  warm: {
    iterationsPerSample: number;
    samples: number;
    baselineRangeMs: readonly [number, number];
    lineageRangeMs: readonly [number, number];
    gateQuantile: 'p75_paired';
    gateOverheadRatio: number;
    gateOverheadPerRunMs: number;
  };
}> {
  const coldIterations = 10;
  const coldBaselineMs = await measureBatch(false, coldIterations);
  const coldLineageMs = await measureBatch(true, coldIterations);
  const expectedGraph = [
    ['c0', [], 'seed', 'accepted', 'archived'],
    ['c1', ['c0'], 'reflective_mutation', 'accepted', 'archived'],
    ['c2', ['c0'], 'reflective_mutation', 'accepted', 'archived'],
    ['c3', ['c1', 'c2'], 'system_merge', 'accepted', 'selected'],
    ['c4', ['c3'], 'reflective_mutation', 'rejected', 'rejected'],
    ['c5', ['c3'], 'reflective_mutation', 'rejected', 'rejected'],
  ];
  const full = await runMergeScenario(true);
  const manifest = full.manifest!;
  const actualGraph = manifest.records.map((record) => [
    record.id,
    [...record.parentIds],
    record.strategy,
    record.decision,
    record.disposition,
  ]);
  invariant(
    JSON.stringify(actualGraph) === JSON.stringify(expectedGraph),
    `decision graph mismatch: ${JSON.stringify(actualGraph)}`
  );

  invariant(
    JSON.stringify(full.callbackManifest) === JSON.stringify(manifest),
    'OptimizationComplete callback and artifact manifests differ'
  );
  invariant(Object.isFrozen(manifest), 'manifest is mutable at runtime');
  invariant(
    Object.isFrozen(manifest.records),
    'record list is mutable at runtime'
  );
  invariant(
    manifest.records.every(
      (record) => Object.isFrozen(record) && Object.isFrozen(record.parentIds)
    ),
    'published records are not recursively frozen'
  );
  const ids = new Set(manifest.records.map((record) => record.id));
  invariant(
    manifest.records.every((record) =>
      record.parentIds.every((parentId) => ids.has(parentId))
    ),
    'artifact contains a dangling parent'
  );

  const rerun = await runMergeScenario(true);
  invariant(
    JSON.stringify(rerun.manifest) === JSON.stringify(manifest),
    'same-seed rerun serialization is nondeterministic'
  );
  const omitted = await runMergeScenario(undefined, false);
  const disabled = await runMergeScenario(false, false);
  invariant(
    omitted.manifest === undefined && omitted.callbackManifest === undefined,
    'lineage was not default-off'
  );
  invariant(
    disabled.manifest === undefined && disabled.callbackManifest === undefined,
    'candidateLineage=false published lineage'
  );
  invariant(
    omitted.selection === full.selection &&
      disabled.selection === full.selection,
    'enabling lineage changed candidate selection'
  );
  invariant(
    !JSON.stringify(manifest).includes('private'),
    'component value leaked with default privacy settings'
  );

  const truncated = await runMergeScenario({ maxRecords: 3 });
  invariant(
    truncated.manifest!.records.length === 3,
    'retention limit ignored'
  );
  invariant(
    truncated.manifest!.omittedRecordCount === 3,
    'retention omission count is incorrect'
  );
  invariant(
    truncated.manifest!.selectedCandidateRetained === false &&
      !truncated.manifest!.paretoCandidateIds.includes(
        truncated.manifest!.selectedCandidateId!
      ),
    'omitted selected candidate was not marked consistently'
  );
  const byteBounded = await runManyRecordScenario();
  const byteBoundedSize = new TextEncoder().encode(
    JSON.stringify(byteBounded)
  ).byteLength;
  invariant(byteBoundedSize <= 4096, 'configured artifact byte bound exceeded');
  invariant(
    byteBounded.omittedRecordCount > 0 &&
      JSON.stringify(byteBounded).includes('雪'),
    'Unicode/escaping stress case did not exercise final-byte truncation'
  );

  const aborted = await runBudgetAbortScenario();
  invariant(
    aborted.stoppedReason === 'budget_exhausted' &&
      aborted.records.some((record) => record.decision === 'aborted'),
    'budget-aborted candidate was not retained'
  );
  const loopBoundaryBudget = await runNoProposalTerminationScenario(2);
  invariant(
    loopBoundaryBudget.termination.phase === 'loop_boundary' &&
      loopBoundaryBudget.records.length === 1,
    'loop-boundary budget termination was not represented'
  );
  const parentBudget = await runNoProposalTerminationScenario(3);
  invariant(
    parentBudget.termination.phase === 'parent_minibatch' &&
      parentBudget.records.length === 1,
    'parent-evaluation budget termination was not represented'
  );
  await assertInitialAbortIsNarrowed();
  const signalAborted = await runAbortSignalScenario();
  invariant(
    signalAborted.stoppedReason === 'aborted' &&
      signalAborted.records.some(
        (record) =>
          record.reason === 'abort_signal' &&
          record.failures?.some((failure) => failure.kind === 'abort')
      ),
    'abort-signal candidate was not retained'
  );
  const faulted = await runFaultScenario();
  invariant(
    faulted.records.some((record) =>
      record.failures?.some((failure) => failure.kind === 'runtime')
    ),
    'runtime failure was not fingerprinted'
  );

  const artifactBytes = new TextEncoder().encode(
    JSON.stringify(manifest)
  ).byteLength;
  const truncatedArtifactBytes = new TextEncoder().encode(
    JSON.stringify(truncated.manifest)
  ).byteLength;
  invariant(
    artifactBytes <= 20_000,
    `artifact ${artifactBytes} B exceeds 20 KB`
  );
  invariant(
    truncatedArtifactBytes < artifactBytes,
    'retention truncation did not reduce artifact size'
  );

  // Ten-run chunks amortize timer noise while interleaving modes closely enough
  // that scheduler/JIT drift cannot consistently favor the tiny baseline. The
  // order flips for every chunk and sample; p75 prevents one unusually fast
  // pair from hiding a regression.
  const enforceTimingGate =
    process.env.AX_GEPA_LINEAGE_TIMING === '1' ||
    process.env.AX_PRINT_METRICS === '1';
  const iterations = enforceTimingGate ? 500 : 20;
  const sampleCount = enforceTimingGate ? 9 : 1;
  if (enforceTimingGate) {
    await measureBatch(false, 50);
    await measureBatch(true, 50);
  }
  const baselineSamples: number[] = [];
  const lineageSamples: number[] = [];
  const overheadRatios: number[] = [];
  const overheadPerRunSamples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const { baselineMs: baselineSample, lineageMs: lineageSample } =
      await measurePairedSample(iterations, sample);
    baselineSamples.push(baselineSample);
    lineageSamples.push(lineageSample);
    overheadRatios.push(
      lineageSample / Math.max(baselineSample, Number.EPSILON)
    );
    overheadPerRunSamples.push((lineageSample - baselineSample) / iterations);
  }
  const baselineMs = median(baselineSamples);
  const lineageMs = median(lineageSamples);
  const overheadMs = lineageMs - baselineMs;
  const overheadRatio = lineageMs / Math.max(baselineMs, 0.001);
  const overheadPerRunMs = overheadMs / iterations;
  const gateOverheadRatio = quantile(overheadRatios, 0.75);
  const gateOverheadPerRunMs = quantile(overheadPerRunSamples, 0.75);
  if (enforceTimingGate) {
    invariant(
      gateOverheadRatio <= 3.5 && gateOverheadPerRunMs <= 0.5,
      `p75 paired runtime overhead ${gateOverheadPerRunMs.toFixed(3)} ms/run (${gateOverheadRatio.toFixed(2)}x) exceeds threshold`
    );
  }

  return {
    baselineMode: 'candidateLineage_omitted',
    candidates: manifest.records.length,
    artifactBytes,
    truncatedArtifactBytes,
    baselineMs,
    lineageMs,
    overheadMs,
    overheadRatio,
    overheadPerRunMs,
    cold: {
      iterations: coldIterations,
      baselineMs: coldBaselineMs,
      lineageMs: coldLineageMs,
    },
    warm: {
      iterationsPerSample: iterations,
      samples: sampleCount,
      baselineRangeMs: range(baselineSamples),
      lineageRangeMs: range(lineageSamples),
      gateQuantile: 'p75_paired',
      gateOverheadRatio,
      gateOverheadPerRunMs,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await runGEPALineageBenchmark();
  console.log(JSON.stringify(result, null, 2));
}
