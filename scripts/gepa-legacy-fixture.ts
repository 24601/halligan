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

let instruction = 'base';
const events: unknown[] = [];
const checkpoints: any[] = [];
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
const optimizer = new AxGEPA({
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
} as any);
(optimizer as any).reflectTargetInstruction = async () => 'better';
const compileOptions: Record<string, unknown> = {
  maxMetricCalls: 20,
  skipPerfectScore: false,
  ...(mode === 'false' ? { candidateLineage: false } : {}),
};
const result = await optimizer.compile(
  program as any,
  [{ question: 'q1' }, { question: 'q2' }],
  async ({ prediction }: any) => prediction.score,
  compileOptions as any
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
const stableCheckpoints = checkpoints.map(
  ({ timestamp: _timestamp, stats: _stats, ...checkpoint }) => checkpoint
);
process.stdout.write(
  JSON.stringify({
    events,
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
  })
);
