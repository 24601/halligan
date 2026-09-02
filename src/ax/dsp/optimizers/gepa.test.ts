import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import {
  axDeserializeOptimizedProgram,
  axSerializeOptimizedProgram,
} from '../optimizer.js';
import { ax } from '../template.js';
import { AxGEPA } from './gepa.js';
import { axHarnessRecipe } from './harnessRecipe.js';
import {
  AX_REJECTED_LEDGER_REF_MAX_DIGESTS,
  AxInMemoryRejectedCandidateLedger,
  axRejectedCandidatePrior,
} from './rejectedCandidateLedger.js';
import type { AxTrajectoryTerminationClassifier } from './trajectoryTermination.js';

const createSingleRootProgram = (
  baseInstruction: string,
  forwardImpl: (instruction: string, example: any) => Promise<any> | any
) => {
  let id = 'root';
  let instruction = baseInstruction;

  const program = {
    getId: () => id,
    setId: (nextId: string) => {
      id = nextId;
    },
    getInstruction: () => instruction,
    setInstruction: (nextInstruction: string) => {
      instruction = nextInstruction;
    },
    getSignature: () => ({
      getDescription: () => baseInstruction,
      toString: () => `"${baseInstruction}" question:string -> answer:string`,
    }),
    namedProgramInstances: () => [{ id, program }],
    getOptimizableComponents: () => [
      {
        key: `${id}::instruction`,
        kind: 'instruction',
        current: instruction,
      },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      const k = `${id}::instruction`;
      if (typeof updates[k] === 'string') instruction = updates[k]!;
    },
    forward: async (_ai: AxAIService, example: any) =>
      await forwardImpl(instruction, example),
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };

  return program;
};

const createInstructionNode = (id: string, description: string) => {
  let nodeId = id;
  let instruction = '';
  const node = {
    getId: () => nodeId,
    setId: (nextId: string) => {
      nodeId = nextId;
    },
    getInstruction: () => instruction,
    setInstruction: (nextInstruction: string) => {
      instruction = nextInstruction;
    },
    getSignature: () => ({
      getDescription: () => description,
      toString: () => `"${description}" input:string -> output:string`,
    }),
    getOptimizableComponents: () => [
      {
        key: `${nodeId}::instruction`,
        kind: 'instruction',
        current: instruction,
      },
    ],
    applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
      const k = `${nodeId}::instruction`;
      if (typeof updates[k] === 'string') instruction = updates[k]!;
    },
    getTraces: () => [],
    setDemos: () => {},
    applyOptimization: () => {},
    getUsage: () => [],
    resetUsage: () => {},
  };

  return node;
};

describe('AxGEPA Optimizer', () => {
  describe('discovery', () => {
    it('exposes the program’s description and instruction as components', () => {
      const program = ax(
        '"This is my custom task description" question:string -> answer:string'
      );
      const components = program.getOptimizableComponents();
      const byKind = (kind: string) =>
        components.find((c) => c.kind === kind)?.current;
      expect(byKind('description')).toBe('This is my custom task description');
      expect(byKind('instruction') ?? '').toBe('');
    });

    it('reflects setInstruction in the instruction component', () => {
      const program = ax('question:string -> answer:string');
      program.setInstruction('My explicitly set custom instruction');
      const components = program.getOptimizableComponents();
      expect(components.find((c) => c.kind === 'instruction')?.current).toBe(
        'My explicitly set custom instruction'
      );
    });
  });

  describe('compile', () => {
    it('supports scalar metric functions by normalizing them to score vectors', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });
      const program = createSingleRootProgram(
        'task',
        async (_instruction, ex) => ({
          answer: ex.answer,
        })
      );

      const result = await optimizer.compile(
        program as any,
        [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
        ],
        async ({ prediction, example }) =>
          prediction.answer === example.answer ? 1 : 0,
        { maxMetricCalls: 2 }
      );

      expect(result.bestScore).toBe(1);
      expect(result.paretoFront[0]?.scores).toEqual({ score: 1 });
      expect(result.optimizedProgram?.componentMap).toEqual({
        'root::instruction': 'task',
      });
    });

    it('uses structured scalar acceptance while retaining named Pareto objectives', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });
      const program = createSingleRootProgram('task', async () => ({
        answer: 'a',
      }));

      const result = await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async () => ({
          score: 0.9,
          feedback: 'This feedback is evaluation-time data only.',
          scores: { accuracy: 1, brevity: 0 },
        }),
        { maxMetricCalls: 2 }
      );

      // bestScore follows the existing Pareto-vector averaging convention;
      // the explicit 0.9 scalar is used for rollout acceptance decisions.
      expect(result.bestScore).toBe(0.5);
      expect(result.paretoFront[0]?.scores).toEqual({
        accuracy: 1,
        brevity: 0,
      });
      expect(JSON.stringify(result.optimizedProgram)).not.toContain(
        'evaluation-time data only'
      );
      expect(JSON.parse(JSON.stringify(result.optimizedProgram))).toMatchObject(
        {
          bestScore: 0.5,
          componentMap: { 'root::instruction': 'task' },
        }
      );
    });

    it('skips reflection when the explicit structured scalar is already perfect', async () => {
      let reflections = 0;
      const optimizer = new AxGEPA({
        studentAI: {
          chat: async () => {
            reflections += 1;
            throw new Error('teacher should not run');
          },
        } as any,
        teacherAI: {
          chat: async () => {
            reflections += 1;
            throw new Error('teacher should not run');
          },
        } as any,
        numTrials: 1,
      });
      const program = createSingleRootProgram('task', async () => ({
        answer: 'a',
      }));

      const result = await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async () => ({
          score: 0.4,
          feedback: 'wrong format',
          scores: { accuracy: 1, brevity: 1 },
        }),
        {
          maxMetricCalls: 8,
          skipPerfectScore: true,
          perfectScore: 0.4,
          gepaAdapter: {
            evaluate: async (batch: readonly unknown[]) => ({
              outputs: batch.map(() => ({ answer: 'a' })),
              scores: batch.map(() => 0.4),
              scoreVectors: batch.map(() => ({ accuracy: 1, brevity: 1 })),
              feedback: batch.map(() => 'wrong format'),
            }),
            make_reflective_dataset: () => ({}),
          },
        }
      );

      expect(result.bestScore).toBe(1);
      expect(reflections).toBe(0);
    });

    it('carries evaluated metric feedback into component reflection tuples', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatchSize: 1,
        seed: 1,
      });
      const program = createSingleRootProgram('task', async () => ({
        answer: 'a',
      }));
      let reflectedTuples: any[] = [];
      (optimizer as any).reflectTargetInstruction = async (...args: any[]) => {
        reflectedTuples = args[8];
        return args[1];
      };

      await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ example }) => ({
          score: 0.4,
          feedback: `Use evidence for ${example.question}.`,
        }),
        { maxMetricCalls: 10, skipPerfectScore: false }
      );

      expect(reflectedTuples).toMatchObject([
        {
          input: { question: expect.any(String) },
          score: 0.4,
          feedback: expect.stringMatching(/^Use evidence for q[12]\.$/),
        },
      ]);
    });

    it('treats forward failures as zero-score rows instead of aborting the optimization', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });
      const program = createSingleRootProgram(
        'task',
        async (_instruction, ex) => {
          if (ex.question === 'q1') {
            throw new Error('model repeated itself until token exhaustion');
          }

          return {
            answer: ex.answer,
          };
        }
      );

      const result = await optimizer.compile(
        program as any,
        [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
        ],
        async ({ prediction, example }) =>
          (prediction as any).answer === example.answer ? 1 : 0,
        { maxMetricCalls: 2 }
      );

      expect(result.bestScore).toBe(0.5);
      expect(result.paretoFront[0]?.scores).toEqual({ score: 0.5 });
      expect(result.optimizedProgram?.componentMap).toEqual({
        'root::instruction': 'task',
      });
    });

    it('bootstraps successful traces into demos and saves them on the optimized artifact', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });

      let id = 'root';
      let instruction = 'task';
      let latestTraces: Array<{ trace: any; programId: string }> = [];
      let appliedDemos: any[] = [];
      const program = {
        getId: () => id,
        setId: (nextId: string) => {
          id = nextId;
        },
        getSignature: () => ({
          getDescription: () => 'task',
          toString: () => '"task" question:string -> answer:string',
        }),
        getOptimizableComponents: () => [
          {
            key: `${id}::instruction`,
            kind: 'instruction',
            current: instruction,
          },
        ],
        applyOptimizedComponents: (
          updates: Readonly<Record<string, string>>
        ) => {
          const key = `${id}::instruction`;
          if (typeof updates[key] === 'string') instruction = updates[key]!;
        },
        forward: async (_ai: AxAIService, example: any) => {
          latestTraces = [
            {
              programId: 'root',
              trace: {
                question: example.question,
                answer: example.answer,
              },
            },
          ];
          return { answer: example.answer };
        },
        getTraces: () => latestTraces,
        setDemos: (demos: any[]) => {
          appliedDemos = demos;
        },
        applyOptimization: () => {},
        getUsage: () => [],
        resetUsage: () => {},
      };

      const result = await optimizer.compile(
        program as any,
        [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
        ],
        async ({ prediction, example }) =>
          (prediction as any).answer === (example as any).answer ? 1 : 0,
        {
          bootstrap: true,
          maxMetricCalls: 2,
        }
      );

      expect(appliedDemos).toHaveLength(1);
      expect(appliedDemos[0]).toEqual({
        programId: 'root',
        traces: [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
        ],
      });
      expect(result.optimizedProgram?.demos).toEqual(appliedDemos);
    });

    it('throws before spending calls when maxMetricCalls cannot cover the initial Pareto set', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });
      const program = createSingleRootProgram(
        'task',
        async (_instruction, ex) => ({
          answer: ex.answer,
        })
      );

      await expect(
        optimizer.compile(
          program as any,
          [
            { question: 'q1', answer: 'a1' },
            { question: 'q2', answer: 'a2' },
          ],
          async ({ prediction, example }) =>
            prediction.answer === example.answer ? 1 : 0,
          { maxMetricCalls: 1 }
        )
      ).rejects.toThrow(/need at least 2 metric calls/);
    });

    it('applies minImprovementThreshold to acceptance decisions', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: false,
        earlyStoppingTrials: 5,
        minImprovementThreshold: 0.5,
      });
      const program = createSingleRootProgram('task', async (instruction) => ({
        score: instruction === 'better' ? 0.1 : 0,
      }));
      (optimizer as any).reflectTargetInstruction = async () => 'better';

      const result = await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        { maxMetricCalls: 20, candidateLineage: true }
      );

      expect(result.bestScore).toBe(0);
      expect(result.optimizedProgram?.componentMap).toEqual({
        'root::instruction': 'task',
      });
      const records = result.optimizedProgram?.candidateLineage?.records ?? [];
      expect(
        records.map(({ id, parentIds, strategy, decision }) => ({
          id,
          parentIds,
          strategy,
          decision,
        }))
      ).toEqual([
        {
          id: 'c0',
          parentIds: [],
          strategy: 'seed',
          decision: 'accepted',
        },
        {
          id: 'c1',
          parentIds: ['c0'],
          strategy: 'reflective_mutation',
          decision: 'rejected',
        },
      ]);
      expect(records[1]?.reason).toBe('insufficient_minibatch_improvement');
    });

    it('records the explicit structured scalar that drives acceptance', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: false,
        mergeMax: 0,
        minImprovementThreshold: 0,
      });
      const program = createSingleRootProgram('task', async (instruction) => ({
        score: instruction === 'better' ? 0.9 : 0.1,
      }));
      (optimizer as any).reflectTargetInstruction = async () => 'better';

      const result = await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => ({
          score: prediction.score,
          scores: { quality: 0 },
        }),
        {
          maxMetricCalls: 20,
          skipPerfectScore: false,
          candidateLineage: true,
        }
      );

      expect(result.optimizedProgram?.componentMap).toEqual({
        'root::instruction': 'better',
      });
      const records = result.optimizedProgram?.candidateLineage?.records ?? [];
      expect(records).toHaveLength(2);
      expect(records[0]?.evaluations).toEqual([
        expect.objectContaining({
          objectives: { quality: 0 },
          scalarScore: 0.1,
        }),
      ]);
      expect(records[1]).toMatchObject({
        decision: 'accepted',
        reason: 'improved_minibatch_score',
      });
      expect(records[1]?.evaluations).not.toHaveLength(0);
      for (const evaluation of records[1]?.evaluations ?? []) {
        expect(evaluation).toMatchObject({
          objectives: { quality: 0 },
          scalarScore: 0.9,
        });
      }
    });

    it('preserves legacy events and checkpoints when lineage is omitted or false', async () => {
      const run = async (candidateLineage?: boolean) => {
        let instruction = 'base';
        const events: any[] = [];
        const checkpoints: any[] = [];
        const program = {
          ...createSingleRootProgram('base', async () => ({ score: 0 })),
          getOptimizableComponents: () => [
            { key: 'instruction', kind: 'instruction', current: instruction },
          ],
          applyOptimizedComponents: (
            updates: Readonly<Record<string, string>>
          ) => {
            instruction = updates.instruction ?? instruction;
          },
          forward: async () => ({ score: instruction === 'better' ? 1 : 0 }),
        };
        const optimizer = new AxGEPA({
          studentAI: {} as AxAIService,
          teacherAI: {} as AxAIService,
          numTrials: 1,
          minibatch: false,
          mergeMax: 0,
          checkpointInterval: 1,
          checkpointSave: async (checkpoint) => {
            checkpoints.push(checkpoint);
            return `checkpoint-${checkpoints.length}`;
          },
          debugOptimizer: true,
          optimizerLogger: (event) => events.push(event),
        });
        (optimizer as any).reflectTargetInstruction = async () => 'better';
        const compileOptions = {
          maxMetricCalls: 20,
          skipPerfectScore: false,
          ...(candidateLineage === undefined ? {} : { candidateLineage }),
        };
        const result = await optimizer.compile(
          program as any,
          [{ question: 'q1' }, { question: 'q2' }],
          async ({ prediction }) => prediction.score,
          compileOptions
        );
        return { events, checkpoints, result };
      };

      const expectedConfiguration = {
        instructionLen: 6,
        target: 'instruction',
        parent: 0,
        totalRounds: 1,
      };
      for (const mode of [undefined, false] as const) {
        const { events, checkpoints, result } = await run(mode);
        expect(events).toEqual([
          {
            name: 'OptimizationStart',
            value: {
              optimizerType: 'GEPA',
              exampleCount: 2,
              validationCount: 2,
              config: {
                numTrials: 1,
                minibatch: false,
                mergeMax: 0,
                tunableCount: 1,
              },
            },
          },
          {
            name: 'RoundProgress',
            value: {
              round: 1,
              totalRounds: 0,
              currentScore: 2,
              bestScore: 2,
              configuration: expectedConfiguration,
            },
          },
        ]);
        expect(checkpoints).toHaveLength(1);
        const {
          timestamp: _timestamp,
          stats: _stats,
          ...stableCheckpoint
        } = checkpoints[0];
        expect(stableCheckpoint).toEqual({
          version: '1.0.0',
          optimizerType: 'GEPA',
          optimizerConfig: {
            strategy: 'reflective_mutation',
            paretoSetSize: 2,
            tunableCount: 1,
          },
          currentRound: 1,
          totalRounds: 0,
          bestScore: 2,
          bestConfiguration: { instructionLen: 4, idx: 0 },
          scoreHistory: [2],
          configurationHistory: [expectedConfiguration],
          optimizerState: {
            maxMetricCalls: 20,
            skipPerfectScore: false,
            ...(mode === false ? { candidateLineage: false } : {}),
            maxIterations: 1,
          },
          examples: [],
        });
        expect(result.optimizedProgram?.candidateLineage).toBeUndefined();
      }

      const optedIn = await run(true);
      expect(optedIn.events.map((event) => event.name)).toEqual([
        'OptimizationStart',
        'RoundProgress',
        'OptimizationComplete',
      ]);
      expect(optedIn.events[1].value).toMatchObject({
        totalRounds: 0,
        configuration: {
          ...expectedConfiguration,
          candidateId: 'c1',
          parentIds: ['c0'],
          strategy: 'reflective_mutation',
          decision: 'accepted',
        },
      });
      expect(optedIn.checkpoints).toHaveLength(2);
      expect(optedIn.checkpoints[0]).toMatchObject({
        bestConfiguration: { instructionLen: 4, idx: 0, candidateId: 'c0' },
        configurationHistory: [
          {
            ...expectedConfiguration,
            candidateId: 'c1',
            parentIds: ['c0'],
            strategy: 'reflective_mutation',
            decision: 'accepted',
          },
        ],
        optimizerState: {
          maxMetricCalls: 20,
          skipPerfectScore: false,
          maxIterations: 1,
          candidateLineage: { checkpointSemantics: 'snapshot_only' },
        },
      });
    });

    it('does not read candidate-lineage, abort, trajectory-termination, sampler, harness, mutation or ledger accessors at the opt-in boundary', async () => {
      let reads = 0;
      const inheritedOptions = Object.create({
        get candidateLineage() {
          reads += 1;
          throw new Error('inherited candidateLineage was read');
        },
        get abortSignal() {
          reads += 1;
          throw new Error('inherited abortSignal was read');
        },
        get trajectoryTermination() {
          reads += 1;
          throw new Error('inherited trajectoryTermination was read');
        },
        get minibatchStrategy() {
          reads += 1;
          throw new Error('inherited minibatchStrategy was read');
        },
        get taskDiscrimination() {
          reads += 1;
          throw new Error('inherited taskDiscrimination was read');
        },
        get harnessRecipe() {
          reads += 1;
          throw new Error('inherited harnessRecipe was read');
        },
        get mutationAnnotation() {
          reads += 1;
          throw new Error('inherited mutationAnnotation was read');
        },
        get rejectedCandidateLedger() {
          reads += 1;
          throw new Error('inherited rejectedCandidateLedger was read');
        },
      });
      Object.defineProperty(inheritedOptions, 'maxMetricCalls', {
        enumerable: true,
        value: 2,
      });
      const accessorOptions = {};
      Object.defineProperties(accessorOptions, {
        candidateLineage: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('candidateLineage accessor was read');
          },
        },
        abortSignal: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('abortSignal accessor was read');
          },
        },
        trajectoryTermination: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('trajectoryTermination accessor was read');
          },
        },
        minibatchStrategy: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('minibatchStrategy accessor was read');
          },
        },
        taskDiscrimination: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('taskDiscrimination accessor was read');
          },
        },
        harnessRecipe: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('harnessRecipe accessor was read');
          },
        },
        mutationAnnotation: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('mutationAnnotation accessor was read');
          },
        },
        rejectedCandidateLedger: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error('rejectedCandidateLedger accessor was read');
          },
        },
        maxMetricCalls: { enumerable: true, value: 2 },
      });

      for (const compileOptions of [inheritedOptions, accessorOptions]) {
        const optimizer = new AxGEPA({
          studentAI: {} as AxAIService,
          teacherAI: {} as AxAIService,
          numTrials: 0,
        });
        const result = await optimizer.compile(
          createSingleRootProgram('task', async () => ({ score: 0 })) as any,
          [{ question: 'q1' }, { question: 'q2' }],
          async ({ prediction }) => prediction.score,
          compileOptions
        );
        expect(result.optimizedProgram?.candidateLineage).toBeUndefined();
      }
      expect(reads).toBe(0);
    });

    it('normalizes a throwing own-option descriptor trap before candidate evaluation', async () => {
      let descriptorCalls = 0;
      let forwardCalls = 0;
      const compileOptions = new Proxy(
        { maxMetricCalls: 2, candidateLineage: false },
        {
          getOwnPropertyDescriptor() {
            descriptorCalls += 1;
            throw new Error('untrusted descriptor trap');
          },
        }
      );
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });

      await expect(
        optimizer.compile(
          createSingleRootProgram('task', async () => {
            forwardCalls += 1;
            return { score: 0 };
          }) as any,
          [{ question: 'q1' }, { question: 'q2' }],
          async ({ prediction }) => prediction.score,
          compileOptions
        )
      ).rejects.toThrow(
        'AxGEPA: throwing getOwnPropertyDescriptor while inspecting own candidateLineage is unsupported'
      );
      expect(descriptorCalls).toBe(1);
      expect(forwardCalls).toBe(0);
    });

    it('does not claim non-invocation for a stateful non-throwing Proxy trap', async () => {
      let descriptorCalls = 0;
      const target = { maxMetricCalls: 2, candidateLineage: false };
      const compileOptions = new Proxy(target, {
        getOwnPropertyDescriptor(object, key) {
          descriptorCalls += 1;
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
      });
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });
      const result = await optimizer.compile(
        createSingleRootProgram('task', async () => ({ score: 0 })) as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        compileOptions
      );

      // One own-descriptor read per opt-in option reached on the default path:
      // candidateLineage, abortSignal, trajectoryTermination, harnessRecipe,
      // mutationAnnotation, rejectedCandidateLedger, minibatchStrategy and
      // taskDiscrimination. The last
      // is read even on the uniform path so that supplying it without the
      // strategy that consumes it can be REPORTED rather than silently
      // ignored; reading an own data property is not observable in any
      // artifact, event or draw sequence. This count is the tripwire that a
      // new option was added without being routed through `ownDataOption`.
      expect(descriptorCalls).toBe(8);
      expect(result.optimizedProgram?.candidateLineage).toBeUndefined();
    });

    it('records budget-aborted candidates and saves lineage in artifacts and checkpoints', async () => {
      const checkpoints: any[] = [];
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: false,
        minImprovementThreshold: 0,
        checkpointSave: async (checkpoint) => {
          checkpoints.push(checkpoint);
          return `checkpoint-${checkpoints.length}`;
        },
      });
      (optimizer as any).reflectTargetInstruction = async () => 'better';
      const program = createSingleRootProgram(
        'private base prompt',
        async (instruction) => ({ score: instruction === 'better' ? 1 : 0 })
      );

      const result = await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 6,
          skipPerfectScore: false,
          saveCheckpointOnComplete: true,
          candidateLineage: true,
        }
      );

      const manifest = result.optimizedProgram?.candidateLineage;
      expect(manifest?.stoppedReason).toBe('budget_exhausted');
      expect(manifest?.checkpointSemantics).toBe('snapshot_only');
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest?.records)).toBe(true);
      expect(manifest?.records[1]).toMatchObject({
        id: 'c1',
        parentIds: ['c0'],
        decision: 'aborted',
        reason: 'validation_budget_exhausted',
        disposition: 'aborted',
      });
      expect(manifest?.records[1]?.failures).toContainEqual({ kind: 'budget' });
      expect(JSON.stringify(manifest)).not.toContain('private base prompt');

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].optimizerState.candidateLineage).toEqual(manifest);

      const serialized = axSerializeOptimizedProgram(result.optimizedProgram!);
      const restored = axDeserializeOptimizedProgram(serialized);
      expect(restored.candidateLineage).toEqual(manifest);
      expect(JSON.stringify(restored.candidateLineage)).toBe(
        JSON.stringify(manifest)
      );
      expect(
        axDeserializeOptimizedProgram({
          ...serialized,
          candidateLineage: undefined,
        }).candidateLineage
      ).toBeUndefined();
    });

    it('marks periodic checkpoint lineage as snapshot-only and in progress', async () => {
      const checkpoints: any[] = [];
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: false,
        checkpointInterval: 1,
        checkpointSave: async (checkpoint) => {
          checkpoints.push(checkpoint);
          return `checkpoint-${checkpoints.length}`;
        },
      });
      (optimizer as any).reflectTargetInstruction = async () => 'unchanged';

      await optimizer.compile(
        createSingleRootProgram('task', async () => ({ score: 0 })) as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 20,
          skipPerfectScore: false,
          candidateLineage: true,
        }
      );

      expect(checkpoints[0].optimizerState.candidateLineage).toMatchObject({
        stoppedReason: 'in_progress',
        checkpointSemantics: 'snapshot_only',
        termination: { phase: 'checkpoint_snapshot', round: 1 },
      });
      expect(checkpoints.at(-1).optimizerState.candidateLineage).toMatchObject({
        stoppedReason: 'completed',
        checkpointSemantics: 'snapshot_only',
      });
    });

    it('bounds retained records without dangling retained parents', async () => {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 3,
        minibatch: false,
        earlyStoppingTrials: 10,
      });
      (optimizer as any).reflectTargetInstruction = async () => 'unchanged';
      const result = await optimizer.compile(
        createSingleRootProgram('task', async () => ({ score: 0 })) as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 20,
          skipPerfectScore: false,
          candidateLineage: { maxRecords: 2 },
        }
      );
      const manifest = result.optimizedProgram?.candidateLineage!;
      expect(manifest.records).toHaveLength(2);
      expect(manifest.omittedRecordCount).toBe(2);
      const retained = new Set(manifest.records.map((record) => record.id));
      for (const record of manifest.records) {
        for (const parentId of record.parentIds) {
          expect(retained.has(parentId)).toBe(true);
        }
      }
    });

    it('drops middle lineage records before newest or selected when byte-capped', async () => {
      let instruction = 'seed-value';
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 8,
        minibatch: false,
        earlyStoppingTrials: 20,
      });
      (optimizer as any).reflectTargetInstruction = async () => {
        instruction = `${instruction}-next`;
        return instruction;
      };
      const result = await optimizer.compile(
        createSingleRootProgram('task', async () => ({ score: 0 })) as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 40,
          skipPerfectScore: false,
          candidateLineage: {
            maxArtifactBytes: 4096,
            includeComponentValues: true,
            maxComponentValueChars: 400,
          },
        }
      );
      const manifest = result.optimizedProgram?.candidateLineage!;
      expect(manifest.omittedRecordCount).toBeGreaterThan(0);
      expect(manifest.records[0]?.id).toBe('c0');
      const last = manifest.records.at(-1);
      expect(last).toBeDefined();
      const retained = new Set(manifest.records.map((record) => record.id));
      for (const record of manifest.records) {
        for (const parentId of record.parentIds) {
          expect(retained.has(parentId)).toBe(true);
        }
      }
      if (manifest.selectedCandidateId) {
        expect(
          manifest.records.some(
            (record) => record.id === manifest.selectedCandidateId
          ) || manifest.selectedCandidateRetained === false
        ).toBe(true);
      }
    });

    it('plumbs custom proposal policies without persisting their references', async () => {
      const secretReference = 'private proposal guidance, not an artifact';
      const seen: Array<{ reference: string; currentValue: string }> = [];
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: false,
        earlyStoppingTrials: 5,
        minImprovementThreshold: 0,
        seed: 1,
      });
      const program = createSingleRootProgram('task', async (instruction) => ({
        score: instruction === 'better' ? 1 : 0,
      }));

      const result = await optimizer.compile(
        program as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 20,
          skipPerfectScore: false,
          gepaProposal: {
            references: [{ name: 'private-guide', content: secretReference }],
            additionalGuidance: 'Prefer the smallest general rule.',
            policy: ({ currentValue, references }) => {
              seen.push({
                currentValue,
                reference: references[0]?.content ?? '',
              });
              return 'better';
            },
          },
        }
      );

      expect(seen).toEqual([
        { currentValue: 'task', reference: secretReference },
      ]);
      expect(result.optimizedProgram?.componentMap).toEqual({
        'root::instruction': 'better',
      });
      const serialized = JSON.stringify(
        axSerializeOptimizedProgram(result.optimizedProgram!)
      );
      expect(serialized).not.toContain(secretReference);
      expect(serialized).not.toContain('Prefer the smallest general rule.');
    });

    it('returns the accepted evolved component when it ties the seed on the Pareto set', async () => {
      // Regression: an accepted evolution that ties the seed on validation
      // should still surface in componentMap.
      const evolved = 'evolved-and-much-longer-accepted-instruction';
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: false,
        earlyStoppingTrials: 5,
        minImprovementThreshold: 0,
        seed: 1,
      });
      (optimizer as any).reflectTargetInstruction = async () => evolved;

      const program = createSingleRootProgram(
        'task',
        async (instruction, ex) =>
          // Training accepts the evolution; validation keeps both candidates tied.
          String(ex.question).startsWith('train')
            ? { score: instruction === evolved ? 1 : 0 }
            : { score: 0.5 }
      );

      const result = await optimizer.compile(
        program as any,
        [{ question: 'train1' }, { question: 'train2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 50,
          skipPerfectScore: false,
          validationExamples: [{ question: 'v1' }, { question: 'v2' }],
        } as any
      );

      expect(result.optimizedProgram?.selectorState).toMatchObject({
        'root::instruction': { accepts: 1 },
      });
      expect(result.optimizedProgram?.componentMap).toEqual({
        'root::instruction': evolved,
      });
    });

    it('does not score feedback-only examples that are outside the training pool', async () => {
      const seenQuestions: string[] = [];
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: true,
        minibatchSize: 1,
        seed: 1,
      });
      const program = createSingleRootProgram(
        'task',
        async (_instruction, ex) => ({
          answer: ex.answer ?? 'answer',
        })
      );
      (optimizer as any).reflectTargetInstruction = async () => 'task';

      await optimizer.compile(
        program as any,
        [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
        ],
        async ({ example }) => {
          seenQuestions.push((example as any).question);
          return 0;
        },
        {
          maxMetricCalls: 20,
          feedbackExamples: [{ question: 'update', answer: 'bad' }] as any,
          feedbackNotes: ['Observed output: bad'] as any,
        } as any
      );

      expect(seenQuestions).not.toContain('update');
    });

    it('optimizes registered descendant components and returns a componentMap', async () => {
      const classifier = createInstructionNode(
        'root.classifier',
        'base-classify'
      );
      const rationale = createInstructionNode(
        'root.rationale',
        'base-rationale'
      );
      const root = {
        getId: () => 'root',
        setId: () => {},
        getSignature: () => ({
          getDescription: () => 'root flow',
          toString: () =>
            'emailText:string -> priority:string, rationale:string',
        }),
        namedProgramInstances: () => [
          { id: classifier.getId(), program: classifier },
          { id: rationale.getId(), program: rationale },
        ],
        getOptimizableComponents: () => [
          ...classifier.getOptimizableComponents(),
          ...rationale.getOptimizableComponents(),
        ],
        applyOptimizedComponents: (
          updates: Readonly<Record<string, string>>
        ) => {
          classifier.applyOptimizedComponents(updates);
          rationale.applyOptimizedComponents(updates);
        },
        forward: async () => ({
          score:
            (classifier.getInstruction() === 'better-classify' ? 1 : 0) +
            (rationale.getInstruction() === 'better-rationale' ? 1 : 0),
        }),
        getTraces: () => [],
        setDemos: () => {},
        applyOptimization: () => {},
        getUsage: () => [],
        resetUsage: () => {},
      };
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 2,
        minibatch: false,
        earlyStoppingTrials: 5,
        minImprovementThreshold: 0,
        seed: 1,
      });
      (optimizer as any).reflectTargetInstruction = async (targetId: string) =>
        targetId.includes('classifier')
          ? 'better-classify'
          : 'better-rationale';

      const result = await optimizer.compile(
        root as any,
        [{ emailText: 'a' }, { emailText: 'b' }],
        async ({ prediction }) => prediction.score,
        { maxMetricCalls: 20, skipPerfectScore: false }
      );

      expect(result.bestScore).toBe(2);
      expect(result.optimizedProgram?.componentMap).toEqual({
        'root.classifier::instruction': 'better-classify',
        'root.rationale::instruction': 'better-rationale',
      });
    });

    it('passes componentId to feedback functions during target reflection', async () => {
      const seenComponentIds: string[] = [];
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 0,
      });
      const program = createSingleRootProgram(
        'task',
        async (_instruction, ex) => ({
          answer: ex.answer ?? 'answer',
        })
      );

      await (optimizer as any).reflectTargetInstruction(
        'root.actor.root',
        'current instruction',
        program,
        () => {},
        { 'root.actor.root': 'current instruction' },
        [{ question: 'q1', answer: 'a1' }],
        async () => 0.5,
        {
          feedbackFn: ({ componentId }: { componentId?: string }) => {
            if (componentId) {
              seenComponentIds.push(componentId);
            }
            return 'Prefer direct answers when recursion is unnecessary.';
          },
        }
      );

      expect(seenComponentIds).toEqual(['root.actor.root']);
    });

    it('renders nested trace values as JSON in reflective datasets', async () => {
      let capturedPrompt = '';
      const reflectionAI = {
        chat: async (request: { chatPrompt: { content?: unknown }[] }) => {
          capturedPrompt = String(request.chatPrompt[0]?.content ?? '');
          return {
            results: [
              {
                index: 0,
                content: '```improved instruction```',
                finishReason: 'stop',
              },
            ],
          };
        },
      } as AxAIService;

      const optimizer = new AxGEPA({
        studentAI: reflectionAI,
        teacherAI: reflectionAI,
        numTrials: 0,
      });
      const program = createSingleRootProgram('task', async () => ({
        answer: 'ok',
        recursiveTrace: {
          root: {
            children: [{ taskDigest: 'branch-a' }],
          },
        },
      }));

      await (optimizer as any).reflectInstruction(
        'current instruction',
        program,
        [{ question: 'q1', extra: { nested: ['value'] } }],
        async () => ({
          score: 0.25,
          feedback: 'Metric feedback: preserve the nested evidence.',
        }),
        {
          feedbackNotes: ['Global note: keep the output concise.'],
          feedbackFn: ({ componentId }: { componentId?: string }) =>
            componentId
              ? `Explicit feedback: component=${componentId}`
              : undefined,
        }
      );

      expect(capturedPrompt).toContain('"taskDigest": "branch-a"');
      expect(capturedPrompt).toContain('"nested": [');
      expect(capturedPrompt).toContain(
        'Metric feedback: preserve the nested evidence.'
      );
      expect(capturedPrompt).toContain('Explicit feedback: component=root');
      expect(capturedPrompt).toContain('Global note: keep the output concise.');
      expect(
        capturedPrompt.indexOf('This trajectory got a score')
      ).toBeLessThan(capturedPrompt.indexOf('Metric feedback:'));
      expect(capturedPrompt.indexOf('Metric feedback:')).toBeLessThan(
        capturedPrompt.indexOf('Explicit feedback:')
      );
      expect(capturedPrompt).not.toContain('[object Object]');
    });
  });
});

describe('AxGEPA trajectory admission', () => {
  /**
   * A classifier that calls every rollout failure an environment failure. It is
   * the most permissive host possible, which is exactly what makes it a useful
   * test instrument: anything Ax still refuses to discard, it refuses on its
   * own authority.
   */
  const discardEveryFailure: AxTrajectoryTerminationClassifier = (input) =>
    input.error === undefined
      ? { kind: 'completed' }
      : { kind: 'environment_failure', cause: 'transport' };

  const runOptimizer = async (args: {
    forward: (instruction: string, example: any) => any;
    examples: readonly Record<string, unknown>[];
    optimizer?: Record<string, unknown>;
    compile?: Record<string, unknown>;
  }) => {
    const events: any[] = [];
    const checkpoints: any[] = [];
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
      minibatch: false,
      minImprovementThreshold: 0,
      debugOptimizer: true,
      optimizerLogger: (event: any) => events.push(event),
      checkpointSave: async (checkpoint: any) => {
        checkpoints.push(checkpoint);
        return `cp${checkpoints.length}`;
      },
      ...args.optimizer,
    } as any);
    (optimizer as any).reflectTargetInstruction = async () => 'better';
    const program = createSingleRootProgram('base', args.forward);
    const result = await optimizer.compile(
      program as any,
      args.examples as any,
      async ({ prediction }: any) => prediction.score,
      {
        maxMetricCalls: 60,
        candidateLineage: true,
        ...args.compile,
      } as any
    );
    return { result, events, checkpoints };
  };

  const lineageRecords = (result: any) =>
    (result.optimizedProgram?.candidateLineage?.records ?? []) as any[];

  /**
   * A program whose optimizable components are exactly `kinds`. Used to pin
   * what a declared `program-source` component does to admission for the WHOLE
   * program, mutated or not.
   */
  const createProgramWithKinds = (
    kinds: readonly string[],
    forwardImpl: (example: any) => any
  ) => {
    const id = 'root';
    const values: Record<string, string> = Object.fromEntries(
      kinds.map((kind) => [`${id}::${kind}`, 'base'])
    );
    const program = {
      getId: () => id,
      setId: () => {},
      getInstruction: () => values[`${id}::instruction`] ?? 'base',
      setInstruction: (next: string) => {
        values[`${id}::instruction`] = next;
      },
      getSignature: () => ({
        getDescription: () => 'base',
        toString: () => '"base" question:string -> answer:string',
      }),
      namedProgramInstances: () => [{ id, program }],
      getOptimizableComponents: () =>
        kinds.map((kind) => ({
          key: `${id}::${kind}`,
          kind,
          current: values[`${id}::${kind}`]!,
        })),
      applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
        for (const key of Object.keys(values)) {
          if (typeof updates[key] === 'string') values[key] = updates[key]!;
        }
      },
      forward: async (_ai: AxAIService, example: any) => forwardImpl(example),
      getTraces: () => [],
      setDemos: () => {},
      applyOptimization: () => {},
      getUsage: () => [],
      resetUsage: () => {},
    };
    return program;
  };

  const runWithKinds = async (kinds: readonly string[]) => {
    const events: any[] = [];
    const logs: string[] = [];
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
      minibatch: false,
      minImprovementThreshold: 0,
      debugOptimizer: true,
      optimizerLogger: (event: any) => events.push(event),
    } as any);
    (optimizer as any).reflectTargetInstruction = async () => 'better';
    const spy = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      await optimizer.compile(
        createProgramWithKinds(kinds, () => {
          throw new Error('provider 429');
        }) as any,
        [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }] as any,
        async ({ prediction }: any) => prediction.score,
        {
          maxMetricCalls: 60,
          verbose: true,
          candidateLineage: true,
          trajectoryTermination: {
            classifier: discardEveryFailure,
            minAdmittedFraction: 0,
            maxRunDiscardRate: 1,
          },
        } as any
      );
    } finally {
      console.log = spy;
    }
    return {
      admission: events.find((e) => e.name === 'OptimizationComplete')?.value
        .admission,
      inertWarning: logs.some((line) =>
        line.includes('trajectoryTermination is inert for this program')
      ),
    };
  };

  it('admits nothing and says so when the program declares a program-source component', async () => {
    // Every candidate config is a COMPLETE map, so `affectedKinds` is the whole
    // program's kind set on every candidate — a declared program-source
    // component makes every row of the run non-reclassifiable, including the
    // seed evaluation, which mutated nothing at all. Conservative, but silent
    // is worse than refusing, so it is stated in the log too.
    const withSource = await runWithKinds(['instruction', 'program-source']);
    expect(withSource.admission.discardedRows).toBe(0);
    expect(withSource.admission.overriddenRows).toBeGreaterThan(0);
    expect(withSource.admission.overriddenRows).toBe(
      withSource.admission.evaluatedRows
    );
    expect(withSource.inertWarning).toBe(true);
  });

  it('admits the same rows when the program declares no program-source component', async () => {
    // The control that makes the test above mean something: identical fixture,
    // identical classifier, program-source component removed. Now the host's
    // environment failures stand.
    const withoutSource = await runWithKinds(['instruction', 'description']);
    expect(withoutSource.admission.overriddenRows).toBe(0);
    expect(withoutSource.admission.discardedRows).toBeGreaterThan(0);
    expect(withoutSource.admission.discardedRows).toBe(
      withoutSource.admission.evaluatedRows
    );
    expect(withoutSource.inertWarning).toBe(false);
  });

  it('reports the run discard rate without changing what avg, scalars or sum mean', async () => {
    const { result, events } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
      forward: (_instruction, example) => {
        if (example.i === 3) throw new Error('provider 429');
        return { score: 1 };
      },
      compile: { trajectoryTermination: { classifier: discardEveryFailure } },
    });

    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission).toMatchObject({
      discardedRows: expect.any(Number),
      causes: { transport: expect.any(Number) },
    });
    expect(complete.value.admission.discardedRows).toBeGreaterThan(0);
    expect(complete.value.admission.evaluatedRows).toBe(
      complete.value.admission.admittedRows +
        complete.value.admission.discardedRows
    );
    // The seed evaluation still averages the discarded zero: admission is a
    // separate report, never a recomputation of the score.
    const seed = lineageRecords(result).find((r) => r.strategy === 'seed');
    expect(seed.evaluations[0].scalarScore).toBe(0.75);
    expect(seed.evaluations[0].evaluatedExamples).toBe(4);
  });

  it('emits no admission report when the option is omitted', async () => {
    const { events } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }],
      forward: (_instruction, example) => {
        if (example.i === 1) throw new Error('provider 429');
        return { score: 1 };
      },
    });
    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission).toBeUndefined();
    expect(Object.keys(complete.value)).not.toContain('admission');
    const progress = events.find((e) => e.name === 'RoundProgress');
    expect(Object.keys(progress.value)).toEqual([
      'round',
      'totalRounds',
      'currentScore',
      'bestScore',
      'configuration',
    ]);
  });

  it('keeps skipPerfectScore reading all rows so an environment failure does not skip the round', async () => {
    const { result } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }],
      forward: (_instruction, example) => {
        if (example.i === 1) throw new Error('provider 429');
        return { score: 1 };
      },
      compile: {
        skipPerfectScore: true,
        perfectScore: 1,
        trajectoryTermination: { classifier: discardEveryFailure },
      },
    });

    // Every ADMITTED parent row scored a perfect 1. If `scalars` were narrowed
    // to admitted rows, `scalars.every(s => s >= perfect)` would be true and
    // the round would be skipped, producing no mutation candidate at all.
    expect(
      lineageRecords(result).some((r) => r.strategy === 'reflective_mutation')
    ).toBe(true);
  });

  it('aborts a candidate instead of rejecting it when too few child rows were admitted', async () => {
    const { result, events } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
      forward: (instruction) => {
        if (instruction === 'better') throw new Error('provider 429');
        return { score: 0.5 };
      },
      compile: { trajectoryTermination: { classifier: discardEveryFailure } },
    });

    const mutation = lineageRecords(result).find(
      (r) => r.strategy === 'reflective_mutation'
    );
    expect(mutation).toMatchObject({
      decision: 'aborted',
      reason: 'insufficient_admitted_rows',
      disposition: 'aborted',
    });

    // An aborted round is the common case under a flaky provider, and lineage
    // is opt-in — so if the abort path skipped the publisher, the cumulative
    // discard rate would be invisible in the event stream for exactly the
    // rounds in which it is climbing.
    const rounds = events.filter((e) => e.name === 'RoundProgress');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].value.configuration.decision).toBe('aborted');
    expect(rounds[0].value.round).toBe(1);
    expect(rounds[0].value.admission.discardedRows).toBeGreaterThan(0);

    // The per-batch verdict is not republished under its own name at run
    // level: this run HAS an inconclusive batch, but "the run is
    // inconclusive" is a different and unsupported claim.
    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission.anyBatchInconclusive).toBe(true);
    expect('inconclusive' in complete.value.admission).toBe(false);
    expect('inconclusive' in rounds[0].value.admission).toBe(false);
  });

  it('reports no inconclusive batch when every batch cleared the floor', async () => {
    const { events } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
      forward: (_instruction, example) => {
        if (example.i === 3) throw new Error('provider 429');
        return { score: 0.5 };
      },
      compile: { trajectoryTermination: { classifier: discardEveryFailure } },
    });

    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission.discardedRows).toBeGreaterThan(0);
    expect(complete.value.admission.anyBatchInconclusive).toBe(false);
  });

  it('ends the run when the host classifier throws, rather than admitting the row', async () => {
    // The classifier is called outside the per-row try/catch that turns a
    // failing rollout into a zero row, so it fails closed: a run whose
    // admission verdicts are unreliable must not silently fall back to
    // admitting everything, which is the lax direction.
    await expect(
      runOptimizer({
        examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
        forward: () => ({ score: 0.5 }),
        compile: {
          trajectoryTermination: {
            classifier: () => {
              throw new Error('host classifier is broken');
            },
          },
        },
      })
    ).rejects.toThrow('host classifier is broken');
  });

  it('ends the run and publishes no best score above the run discard ceiling', async () => {
    const { result, events, checkpoints } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }],
      forward: () => {
        throw new Error('provider 429');
      },
      compile: {
        trajectoryTermination: {
          classifier: discardEveryFailure,
          maxRunDiscardRate: 0.4,
          minRunRowsForCeiling: 4,
        },
      },
    });

    expect(result.bestScore).toBe(0);
    expect(result.optimizedProgram).toBeUndefined();
    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.bestScore).toBe(0);
    expect(complete.value.bestConfiguration).toEqual({});
    expect(complete.value.admission.discardRate).toBeGreaterThan(0.4);

    // The terminal state has to be READABLE, not merely reached. The ceiling
    // suppresses `bestCandidateIdx` by design, so a manifest that keys
    // `in_progress` on "no candidate selected" erases the only reason a reader
    // has for an empty artifact and labels the terminated run a periodic
    // snapshot.
    const finalCheckpoint = checkpoints.at(-1);
    expect(finalCheckpoint.optimizerState.final).toBe(true);
    const manifest = finalCheckpoint.optimizerState.candidateLineage;
    expect(manifest.stoppedReason).toBe('excessive_environment_failures');
    expect(manifest.termination.phase).not.toBe('checkpoint_snapshot');
    expect(manifest.selectedCandidateId).toBeUndefined();
  });

  it('reports the ceiling as terminal even when it fires on the last round', async () => {
    // The ceiling is raised inside `evalBatch`, so it can cross during a phase
    // no loop checkpoint follows. Two trials with a classifier that only starts
    // discarding once the second round's own evaluation runs: the loop then
    // ends by exhausting its trials, and only a stop reason recorded where the
    // ceiling was raised survives that path.
    let evaluatedBatches = 0;
    const { result, checkpoints } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
      optimizer: { numTrials: 2, earlyStoppingTrials: 100 },
      forward: () => ({ score: 0.5 }),
      compile: {
        trajectoryTermination: {
          classifier: () => {
            evaluatedBatches += 1;
            return evaluatedBatches > 8
              ? { kind: 'environment_failure' as const, cause: 'transport' }
              : { kind: 'completed' as const };
          },
          minAdmittedFraction: 0,
          maxRunDiscardRate: 0.3,
          minRunRowsForCeiling: 12,
        },
      },
    });

    expect(result.optimizedProgram).toBeUndefined();
    const manifest = checkpoints.at(-1).optimizerState.candidateLineage;
    expect(manifest.stoppedReason).toBe('excessive_environment_failures');
    expect(manifest.termination.phase).not.toBe('checkpoint_snapshot');
  });

  it('fires the discard ceiling only from the accumulated run, not from any one batch', async () => {
    // The whole reason the ceiling is run-level: a classifier that discards a
    // steady fraction of EVERY batch is invisible to a per-batch floor. Here
    // `minAdmittedFraction: 0` disables the per-batch floor entirely, every
    // batch is 4 rows against a `minRunRowsForCeiling` of 12, and exactly half
    // of each batch is discarded. No single batch can reach the row floor, so
    // the ceiling can only fire from the accumulated fold — an implementation
    // that keeps only the latest batch's report never fires it.
    const discardEveryOtherRow: AxTrajectoryTerminationClassifier = (input) =>
      input.exampleIndex % 2 === 1
        ? { kind: 'environment_failure', cause: 'transport' }
        : { kind: 'completed' };
    const { result, events, checkpoints } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
      optimizer: { numTrials: 4, earlyStoppingTrials: 100 },
      forward: () => ({ score: 0.5 }),
      compile: {
        trajectoryTermination: {
          classifier: discardEveryOtherRow,
          minAdmittedFraction: 0,
          maxRunDiscardRate: 0.4,
          minRunRowsForCeiling: 12,
        },
      },
    });

    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission.evaluatedRows).toBeGreaterThanOrEqual(12);
    expect(complete.value.admission.discardRate).toBeCloseTo(0.5, 10);
    expect(result.bestScore).toBe(0);
    expect(result.optimizedProgram).toBeUndefined();
    expect(
      checkpoints.at(-1).optimizerState.candidateLineage.stoppedReason
    ).toBe('excessive_environment_failures');
  });

  it('does not fire the ceiling before the run has accumulated enough rows', async () => {
    // The negative control for the test above: the same 50% steady discard
    // under a row floor no run of this length can reach must NOT end the run.
    const discardEveryOtherRow: AxTrajectoryTerminationClassifier = (input) =>
      input.exampleIndex % 2 === 1
        ? { kind: 'environment_failure', cause: 'transport' }
        : { kind: 'completed' };
    const { result, events } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
      optimizer: { numTrials: 4, earlyStoppingTrials: 100 },
      forward: () => ({ score: 0.5 }),
      compile: {
        trajectoryTermination: {
          classifier: discardEveryOtherRow,
          minAdmittedFraction: 0,
          maxRunDiscardRate: 0.4,
          minRunRowsForCeiling: 10_000,
        },
      },
    });

    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission.discardRate).toBeCloseTo(0.5, 10);
    expect(result.optimizedProgram).toBeDefined();
  });

  it('keeps running below the ceiling on the same fixture', async () => {
    const { result } = await runOptimizer({
      examples: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }],
      forward: () => {
        throw new Error('provider 429');
      },
      compile: {
        trajectoryTermination: {
          classifier: discardEveryFailure,
          maxRunDiscardRate: 1,
          minRunRowsForCeiling: 4,
          minAdmittedFraction: 0,
        },
      },
    });

    expect(result.optimizedProgram).toBeDefined();
  });

  it('refuses a host reclassification on a config-error row', async () => {
    const events: any[] = [];
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 0,
      minibatch: false,
      debugOptimizer: true,
      optimizerLogger: (event: any) => events.push(event),
    } as any);
    let forwardCalls = 0;
    const program = createSingleRootProgram('base', () => {
      forwardCalls += 1;
      return { score: 1 };
    });
    (program as any).getOptimizableComponents = () => [
      {
        key: 'root::program-source',
        kind: 'program-source',
        current: 'source',
        validate: () => 'always invalid',
      },
    ];
    (program as any).applyOptimizedComponents = () => {};

    const result = await optimizer.compile(
      program as any,
      [{ i: 0 }, { i: 1 }] as any,
      async ({ prediction }: any) => prediction?.score ?? 0,
      {
        maxMetricCalls: 20,
        candidateLineage: true,
        trajectoryTermination: {
          classifier: () => ({
            kind: 'environment_failure',
            cause: 'sandbox',
          }),
        },
      } as any
    );

    expect(forwardCalls).toBe(0);
    expect(result.optimizedProgram).toBeDefined();
    const complete = events.find((e) => e.name === 'OptimizationComplete');
    expect(complete.value.admission).toMatchObject({
      discardedRows: 0,
      overriddenRows: 2,
      admittedRows: 2,
    });
  });
});

describe('AxGEPA paired admitted promotion gates', () => {
  /**
   * Gate 1 (`reflective_mutation`). The child wins comfortably on the raw
   * all-rows sum and loses on the rows BOTH evaluations admitted. Only a paired
   * denominator can tell those apart.
   */
  const parentScores = [0.1, 0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.1];
  const childScores = [0.9, 0.9, 0.4, 0.4, 0.4, 0.4, 0.4, 0.9];
  const examples = Array.from({ length: 8 }, (_, index) => ({ index }));

  const runMutationGate = async (
    trajectoryTermination?: Record<string, unknown>
  ) => {
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
      minibatch: false,
      minImprovementThreshold: 0,
      mergeMax: 0,
    } as any);
    (optimizer as any).reflectTargetInstruction = async () => 'better';
    const program = createSingleRootProgram(
      'base',
      (instruction, example: any) => ({
        score:
          instruction === 'better'
            ? childScores[example.index]!
            : parentScores[example.index]!,
        index: example.index,
      })
    );
    const result = await optimizer.compile(
      program as any,
      examples as any,
      async ({ prediction }: any) => prediction.score,
      {
        maxMetricCalls: 200,
        skipPerfectScore: false,
        candidateLineage: true,
        ...(trajectoryTermination ? { trajectoryTermination } : {}),
      } as any
    );
    const records = (result.optimizedProgram?.candidateLineage?.records ??
      []) as any[];
    return records.find((r) => r.strategy === 'reflective_mutation');
  };

  const discardBy = (
    rows: Readonly<Record<string, readonly number[]>>
  ): AxTrajectoryTerminationClassifier => {
    return (input) => {
      const index = (input.prediction as any)?.index;
      return (rows[input.phase] ?? []).includes(index)
        ? { kind: 'environment_failure', cause: 'transport' }
        : { kind: 'completed' };
    };
  };

  it('promotes the child on the raw all-rows sum when nothing is discarded', async () => {
    // The baseline the paired test is measured against: 4.7 > 2.8.
    await expect(runMutationGate()).resolves.toMatchObject({
      decision: 'accepted',
      reason: 'improved_minibatch_score',
    });
  });

  it('compares only paired admitted rows on the uniform strategy', async () => {
    const record = await runMutationGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: discardBy({
        'parent minibatch': [0, 1],
        'child minibatch': [7],
      }),
    });
    // Over the intersection {2..6}: child 2.0 <= parent 2.5.
    expect(record).toMatchObject({
      decision: 'rejected',
      reason: 'insufficient_minibatch_improvement',
    });
  });

  it('reaches the same decision when both sides discard the same rows', async () => {
    // Restoring the parent's two rows to the parent while also removing them
    // from the child leaves the intersection identical, so the decision must be
    // identical too: the gate depends on the intersection, not on which side
    // dropped what.
    const record = await runMutationGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: discardBy({
        'parent minibatch': [0, 1, 7],
        'child minibatch': [0, 1, 7],
      }),
    });
    expect(record).toMatchObject({
      decision: 'rejected',
      reason: 'insufficient_minibatch_improvement',
    });
  });

  it('aborts rather than rejecting when the parent and child share no admitted row', async () => {
    // Both sides clear `minAdmittedFraction` on their own, and their admitted
    // sets are disjoint, so there is nothing to compare. A sum of 0 against a
    // sum of 0 is not a rejection, it is no evidence, and a rejection here
    // would burn an `earlyStoppingTrials` slot on a provider outage.
    const record = await runMutationGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: discardBy({
        'parent minibatch': [0, 1, 2, 3],
        'child minibatch': [4, 5, 6, 7],
      }),
    });
    expect(record).toMatchObject({
      decision: 'aborted',
      reason: 'insufficient_admitted_rows',
      disposition: 'aborted',
    });
  });

  it('still promotes the child when the discarded rows are outside the disagreement', async () => {
    // Negative control: discarding rows the two candidates agree on must not
    // flip the decision, or the test above would prove nothing about pairing.
    const record = await runMutationGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: discardBy({
        'parent minibatch': [3],
        'child minibatch': [4],
      }),
    });
    expect(record).toMatchObject({ decision: 'accepted' });
  });
});

describe('AxGEPA merge gate paired admitted rows', () => {
  /**
   * Gate 2 (`system_merge`, on by default: `mergeMax` is 5). It compares a
   * fresh subsample evaluation against CACHED per-instance scores of the two
   * parents, so its denominator has three sources, not two.
   *
   * Two components over nine examples whose rows rotate through three kinds:
   * `a` rows that A's improvement helps, `b` rows that B's helps, and `n` rows
   * that every improvement hurts slightly — the `n` rows are what keep the
   * siblings mutually non-dominated so a merge is reachable at all.
   *
   * `pickSome` draws two `a` rows, two `b` rows and one `n` row, and every row
   * of a kind carries the same score, so the subsample's composition is fixed
   * and these sums are exact:
   *
   *   merge over all 5:  2(0.53125) + 2(0.6875) + 0.46875 = 2.90625
   *   parent A over all: 2(0.75)    + 2(0.5)    + 0.46875 = 2.96875
   *   parent B over all: 2(0.5)     + 2(0.625)  + 0.46875 = 2.71875
   *   -> 2.90625 < max(...) = 2.96875, so the merge is REJECTED.
   *
   * Drop the two `a` rows from the denominator and it inverts:
   *
   *   merge over {b,b,n}: 1.375   + 0.46875 = 1.84375
   *   parent A:           1.0     + 0.46875 = 1.46875
   *   parent B:           1.25    + 0.46875 = 1.71875
   *   -> 1.84375 >= 1.71875, so the merge is ACCEPTED.
   *
   * The merge candidate is deliberately WORSE than the better parent overall
   * and better than both on the rows that survive, which is the only shape that
   * can tell an intersected denominator from a raw one.
   */
  const MERGE_TABLE = {
    a: { none: 0.5, A: 0.75, B: 0.5, AB: 0.53125 },
    b: { none: 0.5, A: 0.5, B: 0.625, AB: 0.6875 },
    n: { none: 0.5, A: 0.46875, B: 0.46875, AB: 0.46875 },
  } as const;

  const buildTwoComponentProgram = () => {
    const componentA = 'root::instruction';
    const componentB = 'root::description';
    const values: Record<string, string> = {
      [componentA]: 'base',
      [componentB]: 'base',
    };
    const rowKind = (index: number) => (['a', 'b', 'n'] as const)[index % 3]!;
    const improvedKey = () => {
      const a = values[componentA] === `better-${componentA}`;
      const b = values[componentB] === `better-${componentB}`;
      if (a && b) return 'AB' as const;
      if (a) return 'A' as const;
      if (b) return 'B' as const;
      return 'none' as const;
    };
    return {
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
        for (const id of [componentA, componentB]) {
          const next = updates[id];
          if (typeof next === 'string') values[id] = next;
        }
      },
      forward: async (_ai: AxAIService, example: any) => ({
        score: MERGE_TABLE[rowKind(example.index)][improvedKey()],
        index: example.index,
        kind: rowKind(example.index),
      }),
      getTraces: () => [],
      setDemos: () => {},
      applyOptimization: () => {},
      getUsage: () => [],
      resetUsage: () => {},
    };
  };

  const runMergeGate = async (
    trajectoryTermination?: Record<string, unknown>
  ) => {
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 12,
      earlyStoppingTrials: 30,
      minibatch: true,
      minibatchSize: 2,
      mergeMax: 5,
    } as any);
    (optimizer as any).reflectTargetInstruction = async (componentId: string) =>
      `better-${componentId}`;
    const result = await optimizer.compile(
      buildTwoComponentProgram() as any,
      Array.from({ length: 9 }, (_, index) => ({ index })) as any,
      async ({ prediction }: any) => prediction.score,
      {
        maxMetricCalls: 400,
        skipPerfectScore: false,
        candidateLineage: true,
        ...(trajectoryTermination ? { trajectoryTermination } : {}),
      } as any
    );
    return (
      (result.optimizedProgram?.candidateLineage?.records ?? []) as any[]
    ).filter((r) => r.strategy === 'system_merge');
  };

  const subsampleSum = (record: any): number => {
    const merge = record.evaluations.find(
      (evaluation: any) => evaluation.phase === 'merge_subsample'
    );
    return merge.scalarScore * merge.evaluatedExamples;
  };

  const discardKindInPhase =
    (phase: string): AxTrajectoryTerminationClassifier =>
    (input) =>
      input.phase === phase && (input.prediction as any)?.kind === 'a'
        ? { kind: 'environment_failure', cause: 'rate_limit' }
        : { kind: 'completed' };

  it('rejects the merge on the full denominator', async () => {
    const merges = await runMergeGate();
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.every((r) => r.decision === 'rejected')).toBe(true);
    expect(merges.map(subsampleSum)).toContainEqual(2.90625);
  });

  it('compares only paired admitted rows at the merge gate', async () => {
    const merges = await runMergeGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: discardKindInPhase('merge subsample'),
    });
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.some((r) => r.decision === 'accepted')).toBe(true);
  });

  it('aborts the merge rather than accepting it when the denominator is empty', async () => {
    // `newSum >= Math.max(id1Sum, id2Sum) + threshold` is 0 >= 0 + 0, which is
    // TRUE — so an empty denominator promotes a merge on no evidence at all
    // unless the gate refuses first. Reachable even though the merge
    // evaluation itself cleared its admitted floor, because the parents'
    // cached masks exclude everything it kept.
    const merges = await runMergeGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: (input) =>
        input.phase === 'validation evaluation' ||
        input.phase === 'initial Pareto evaluation'
          ? { kind: 'environment_failure', cause: 'rate_limit' }
          : { kind: 'completed' },
    });
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.every((r) => r.decision !== 'accepted')).toBe(true);
    expect(
      merges.some(
        (r) =>
          r.decision === 'aborted' && r.reason === 'insufficient_admitted_rows'
      )
    ).toBe(true);
  });

  it('honours the cached per-instance admitted mask of both parents', async () => {
    // Nothing is discarded during the merge subsample here: the rows leave the
    // denominator only because the PARENTS' cached validation evaluations
    // discarded them. Without `perInstanceAdmitted` there is no way to know
    // that, and the merge stays rejected.
    const merges = await runMergeGate({
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
      classifier: discardKindInPhase('validation evaluation'),
    });
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.some((r) => r.decision === 'accepted')).toBe(true);
  });
});

describe('AxGEPA discriminative minibatch selection', () => {
  const buildProgram = (
    score: (index: number, instruction: string) => number
  ) => {
    let instruction = 'base';
    return {
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
      forward: async (_ai: AxAIService, example: any) => ({
        score: score(example.index, instruction),
        index: example.index,
      }),
      getTraces: () => [],
      setDemos: () => {},
      applyOptimization: () => {},
      getUsage: () => [],
      resetUsage: () => {},
    };
  };

  /**
   * 12 tasks. Task 0 is the only one that ever separates a pass from a fail:
   * it alternates on every rollout, so its smoothed pass rate sits at 0.5 and
   * its Bernoulli variance at the maximum 0.25. The other eleven always pass,
   * so their variance decays toward zero as trials accumulate and a
   * variance-weighted sampler must starve them down toward the exploration
   * floor — which it may never cross.
   */
  const buildDiscriminatingFixture = () => {
    let flips = 0;
    return buildProgram((index) => {
      if (index !== 0) return 1;
      flips += 1;
      return flips % 2;
    });
  };

  /** Every proposal is a real improvement, so every round runs a validation evaluation. */
  const buildImprovingFixture = () =>
    buildProgram((_index, instruction) =>
      instruction === 'base' ? 0.1 : Number(instruction.slice(1)) / 100
    );

  const run = async (args: {
    strategy?: 'uniform' | 'discriminative';
    numTrials?: number;
    minImprovementThreshold?: number;
    taskCount?: number;
    program?: unknown;
    minibatchSize?: number;
    reflect?: () => Promise<string>;
    trajectoryTermination?: unknown;
  }) => {
    const events: any[] = [];
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: args.numTrials ?? 8,
      earlyStoppingTrials: 100,
      minibatch: true,
      minibatchSize: args.minibatchSize ?? 2,
      mergeMax: 0,
      minImprovementThreshold: args.minImprovementThreshold ?? 0,
      debugOptimizer: true,
      optimizerLogger: (event: any) => events.push(event),
    } as any);
    (optimizer as any).reflectTargetInstruction =
      args.reflect ?? (async () => 'better');
    const result = await optimizer.compile(
      (args.program ?? buildDiscriminatingFixture()) as any,
      Array.from({ length: args.taskCount ?? 12 }, (_, index) => ({
        index,
      })) as any,
      async ({ prediction }: any) => prediction.score,
      {
        maxMetricCalls: 500,
        skipPerfectScore: false,
        candidateLineage: true,
        ...(args.strategy ? { minibatchStrategy: args.strategy } : {}),
        ...(args.trajectoryTermination
          ? { trajectoryTermination: args.trajectoryTermination }
          : {}),
      } as any
    );
    return { result, events };
  };

  it('says so when taskDiscrimination is supplied without the strategy that reads it', async () => {
    const logs: string[] = [];
    const spy = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      const optimizer = new AxGEPA({
        studentAI: {} as AxAIService,
        teacherAI: {} as AxAIService,
        numTrials: 1,
        minibatch: true,
        minibatchSize: 2,
        mergeMax: 0,
      } as any);
      (optimizer as any).reflectTargetInstruction = async () => 'better';
      await optimizer.compile(
        buildDiscriminatingFixture() as any,
        Array.from({ length: 4 }, (_, index) => ({ index })) as any,
        async ({ prediction }: any) => prediction.score,
        {
          maxMetricCalls: 100,
          verbose: true,
          taskDiscrimination: { explorationFloor: 0.3 },
        } as any
      );
    } finally {
      console.log = spy;
    }
    expect(
      logs.some((line) => line.includes('taskDiscrimination was supplied'))
    ).toBe(true);
  });

  it('draws no inclusion snapshot and reports no summary under the default strategy', async () => {
    const { events } = await run({ numTrials: 2 });
    expect(
      events
        .filter((e) => e.name === 'RoundProgress')
        .every((e) => e.value.inclusionSnapshot === undefined)
    ).toBe(true);
    expect(
      events.find((e) => e.name === 'OptimizationComplete').value.discrimination
    ).toBeUndefined();
  });

  it('concentrates the drawn minibatch on the one discriminating task', async () => {
    const { events } = await run({ strategy: 'discriminative', numTrials: 40 });
    const snapshots = events
      .filter((e) => e.name === 'RoundProgress')
      .map((e) => e.value.inclusionSnapshot);
    expect(snapshots.length).toBe(40);

    const draws = new Map<number, number>();
    for (const snapshot of snapshots) {
      for (const index of snapshot.sampledIndices) {
        draws.set(index, (draws.get(index) ?? 0) + 1);
      }
    }
    const discriminating = draws.get(0) ?? 0;
    const others = [...Array.from({ length: 11 }, (_, i) => i + 1)].map(
      (index) => draws.get(index) ?? 0
    );
    const averageOther =
      others.reduce((total, count) => total + count, 0) / others.length;
    // A sampler that computes inclusion probabilities and then ignores them
    // when drawing would leave this at parity: the assertion is on the SAMPLED
    // indices, not on the published probabilities. Under a uniform draw every
    // task's expectation is 40 * 2 / 12 = 6.67.
    expect(discriminating).toBeGreaterThan(averageOther * 2);

    // The exploration floor is mandatory and non-optional: with
    // explorationFloor 0.2, batchSize 2 and 12 tasks, no task may fall below
    // 2 * 0.2 / 12 even after 40 rounds of being useless.
    const floor = (2 * 0.2) / 12;
    for (const snapshot of snapshots) {
      for (const inclusion of snapshot.inclusions) {
        expect(inclusion.probability).toBeGreaterThanOrEqual(floor - 1e-12);
      }
    }
    // ...and every always-passing task was still drawn at least once.
    expect(others.every((count) => count > 0)).toBe(true);
  });

  it('starts statistically uniform, because a cold table has nothing to concentrate on', async () => {
    const { events } = await run({ strategy: 'discriminative', numTrials: 2 });
    const first = events.find((e) => e.name === 'RoundProgress').value
      .inclusionSnapshot;
    const probabilities = first.inclusions.map((i: any) => i.probability);
    for (const probability of probabilities) {
      expect(probability).toBeCloseTo(first.batchSize / first.taskCount, 12);
    }
  });

  it('feeds the stat table from exactly the parent and child minibatch phases', async () => {
    const rounds = 4;
    const minibatchSize = 2;
    let version = 0;
    const nextVersion = () => {
      version += 10;
      return `v${version}`;
    };
    const { events } = await run({
      strategy: 'discriminative',
      numTrials: rounds,
      minibatchSize,
      // Every proposal is accepted, so a validation evaluation over all twelve
      // tasks runs in every round alongside the seed evaluation. Neither may
      // reach the table.
      program: buildImprovingFixture(),
      reflect: async () => nextVersion(),
    });
    const summary = events.find((e) => e.name === 'OptimizationComplete').value
      .discrimination;
    const totalTrials = summary.finalStats.reduce(
      (total: number, stat: any) => total + stat.trials,
      0
    );
    // Two trials per sampled task per round, and nothing else. The seed
    // evaluation and every round's validation evaluation both run over all 12
    // tasks here, so a table fed from any other phase would overshoot this by a
    // wide margin.
    expect(totalTrials).toBe(2 * minibatchSize * rounds);
    expect(summary.iterations).toBe(rounds);
    expect(summary.strategy).toBe('discriminative');
    expect(summary.serializedBytes).toBeGreaterThan(0);
  });

  it('reports the non-discriminative task fraction over the tasks it actually sampled', async () => {
    const { events } = await run({ strategy: 'discriminative', numTrials: 12 });
    const summary = events.find((e) => e.name === 'OptimizationComplete').value
      .discrimination;
    // Eleven of the twelve tasks pass for every candidate; only task 0 splits.
    expect(summary.nonDiscriminativeTaskFraction).toBeGreaterThan(0.5);
    expect(summary.nonDiscriminativeTaskFraction).toBeLessThan(1);
  });

  it('compares a per-example mean under discriminative and a sum under uniform', async () => {
    // Every task improves by exactly +0.4, so the drawn batch cannot matter:
    // over two rows the SUM difference is 0.8 and the MEAN difference is 0.4.
    // A threshold of 0.6 sits between them, so the two estimators must disagree
    // — and only the estimator can explain the disagreement.
    let instruction = 'base';
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
      forward: async () => ({
        score: instruction === 'better' ? 0.5 : 0.1,
      }),
      getTraces: () => [],
      setDemos: () => {},
      applyOptimization: () => {},
      getUsage: () => [],
      resetUsage: () => {},
    };

    const decisionOf = async (strategy?: 'discriminative') => {
      const { result } = await run({
        strategy,
        numTrials: 1,
        minImprovementThreshold: 0.6,
        program,
      });
      instruction = 'base';
      return (
        (result.optimizedProgram?.candidateLineage?.records ?? []) as any[]
      ).find((r) => r.strategy === 'reflective_mutation')?.decision;
    };

    expect(await decisionOf()).toBe('accepted');
    expect(await decisionOf('discriminative')).toBe('rejected');
  });

  /**
   * The fourth quadrant of the promotion table: a classifier AND the
   * discriminative sampler, together. Each commit's own tests cover one row of
   * §7.3 each; this is the row where they interact, and it is also the only
   * place the stat table's "an environment failure is not evidence about task
   * difficulty either" rule is reachable, because every other sampler test
   * runs without a classifier and so has no discarded row to skip.
   *
   * Task 0 is the only task that separates the candidates. The classifier
   * discards exactly task 0.
   */
  const discriminatingTaskFixture = () =>
    buildProgram((index, instruction) =>
      index === 0 ? (instruction === 'better' ? 1 : 0) : 0.5
    );
  const discardTaskZero: AxTrajectoryTerminationClassifier = (input) =>
    input.exampleIndex === 0
      ? { kind: 'environment_failure', cause: 'transport' }
      : { kind: 'completed' };

  const runDiscriminatingFixture = (trajectoryTermination?: unknown) =>
    run({
      strategy: 'discriminative',
      numTrials: 6,
      minibatchSize: 2,
      taskCount: 4,
      program: discriminatingTaskFixture(),
      ...(trajectoryTermination ? { trajectoryTermination } : {}),
    });

  it('promotes on the discriminative gate when the only discriminating task is admitted', async () => {
    const { result } = await runDiscriminatingFixture();
    expect(
      (
        (result.optimizedProgram?.candidateLineage?.records ?? []) as any[]
      ).filter((r) => r.strategy === 'reflective_mutation')
    ).toContainEqual(expect.objectContaining({ decision: 'accepted' }));
  });

  it('refuses the same promotion once the discriminating task leaves the paired denominator', async () => {
    // Both per-batch floors are disabled so the only thing that can change the
    // decision is the paired denominator itself, not an inconclusive batch or
    // the run ceiling.
    const { result, events } = await runDiscriminatingFixture({
      classifier: discardTaskZero,
      minAdmittedFraction: 0,
      maxRunDiscardRate: 1,
    });

    // The raw batch sum still contains task 0's 1-against-0 improvement — the
    // all-rows meaning of `sum` never changes — so only the intersected
    // denominator can explain the rejection.
    const mutations = (
      (result.optimizedProgram?.candidateLineage?.records ?? []) as any[]
    ).filter((r) => r.strategy === 'reflective_mutation');
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((r) => r.decision === 'rejected')).toBe(true);

    // And the discarded rows are not evidence about task difficulty either.
    // Asserting that task 0 was actually DRAWN is what stops this from passing
    // vacuously on a sampler that simply never sampled it.
    const snapshots = events
      .filter((e) => e.name === 'RoundProgress')
      .map((e) => e.value.inclusionSnapshot)
      .filter(Boolean);
    const drawn = snapshots.flatMap((snapshot: any) => snapshot.sampledIndices);
    expect(drawn).toContain(0);
    const summary = events.find((e) => e.name === 'OptimizationComplete').value
      .discrimination;
    expect(summary.finalStats[0].trials).toBe(0);
    expect(
      summary.finalStats
        .slice(1)
        .reduce((total: number, stat: any) => total + stat.trials, 0)
    ).toBeGreaterThan(0);
  });
});

describe('AxGEPA RNG stream discipline (INV-L5)', () => {
  /**
   * `this.rand()` is a single shared xorshift stream with four consumers: the
   * epoch shuffler, parent selection, the merge subsample's unbounded
   * collision loop, and — only under `'discriminative'` — the sampler.
   *
   * Comparing the resulting minibatch indices would pass while a refactor moved
   * a draw from one consumer to another and silently changed parent selection,
   * so the COUNT is what is frozen here.
   */
  const countDraws = async (
    compileOptions: Record<string, unknown>
  ): Promise<number> => {
    let values: Record<string, string> = {};
    const componentIds = [
      'root::instruction',
      'root::description',
      'root::fn-desc:answer',
    ];
    values = Object.fromEntries(componentIds.map((id) => [id, 'base']));
    const owner = (index: number) => componentIds[index % 3]!;
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
      getOptimizableComponents: () =>
        componentIds.map((key, position) => ({
          key,
          kind: ['instruction', 'description', 'fn-desc'][position]!,
          current: values[key]!,
        })),
      applyOptimizedComponents: (updates: Readonly<Record<string, string>>) => {
        for (const id of componentIds) {
          const next = updates[id];
          if (typeof next === 'string') values[id] = next;
        }
      },
      forward: async (_ai: AxAIService, example: any) => {
        const improved = componentIds.filter(
          (id) => values[id] === `better-${id}`
        );
        const own = improved.includes(owner(example.index)) ? 0.4 : 0;
        const others = improved.filter(
          (id) => id !== owner(example.index)
        ).length;
        return { score: 0.6 + own - 0.05 * others, index: example.index };
      },
      getTraces: () => [],
      setDemos: () => {},
      applyOptimization: () => {},
      getUsage: () => [],
      resetUsage: () => {},
    };

    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 6,
      minibatch: true,
      minibatchSize: 2,
      mergeMax: 5,
    } as any);
    let draws = 0;
    const rand = (optimizer as any).rand.bind(optimizer);
    (optimizer as any).rand = () => {
      draws += 1;
      return rand();
    };
    (optimizer as any).reflectTargetInstruction = async (componentId: string) =>
      `better-${componentId}`;
    await optimizer.compile(
      program as any,
      Array.from({ length: 9 }, (_, index) => ({ index })) as any,
      async ({ prediction }: any) => prediction.score,
      { maxMetricCalls: 200, skipPerfectScore: false, ...compileOptions } as any
    );
    return draws;
  };

  it('consumes an identical rand() draw count when the strategy is omitted', async () => {
    // Frozen against origin/main. A refactor that relocates a draw fails here
    // even when every minibatch index still matches.
    expect(await countDraws({})).toBe(59);
    expect(await countDraws({ minibatchStrategy: 'uniform' })).toBe(59);
  });

  it('consumes a different, smaller draw count under discriminative', async () => {
    // Stated rather than assumed: the epoch shuffler is replaced by exactly one
    // Madow draw per minibatch, so a discriminative run is not seed-comparable
    // to a uniform one draw-for-draw. That is why the invariance gate pins the
    // uniform count and the evaluation compares outcomes, not streams.
    const discriminative = await countDraws({
      minibatchStrategy: 'discriminative',
    });
    expect(discriminative).toBeLessThan(59);
    expect(discriminative).toBeGreaterThan(0);
  });
});

describe('lineage version 2 annotations', () => {
  const buildRecipe = async (boundModelId: string) =>
    await axHarnessRecipe({
      bindings: [
        { port: 'model.primary', atomId: 'atom-a', version: '1' },
        { port: 'retriever.default', atomId: 'atom-b', version: '2' },
      ],
      boundModelId,
    });

  /**
   * One accepted mutation over a two-example set. `better` scores 1 on the
   * first example and 0 on the second, `base` the reverse — so the paired
   * reflection classes are one `fixed` and one `regressed`, which is the
   * only shape that distinguishes a real classifier from one that returns a
   * constant.
   */
  const runSplitFixture = async (
    compileOptions: Record<string, unknown>,
    optimizerOverrides: Record<string, unknown> = {}
  ) => {
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
      minibatch: false,
      mergeMax: 0,
      minImprovementThreshold: -1,
      ...optimizerOverrides,
    });
    const program = createSingleRootProgram(
      'task',
      async (instruction, example) => ({
        score:
          instruction === 'better'
            ? example.question === 'q1'
              ? 1
              : 0
            : example.question === 'q1'
              ? 0
              : 1,
      })
    );
    (optimizer as any).reflectTargetInstruction = async () => 'better';
    const result = await optimizer.compile(
      program as any,
      [{ question: 'q1' }, { question: 'q2' }],
      async ({ prediction }) => prediction.score,
      { maxMetricCalls: 40, skipPerfectScore: false, ...compileOptions }
    );
    return result;
  };

  it('emits lineage version 1 with no version-2 field when the new options are omitted', async () => {
    const result = await runSplitFixture({ candidateLineage: true });
    const manifest = result.optimizedProgram?.candidateLineage;
    expect(manifest?.version).toBe(1);
    // Every version-2 manifest field is ABSENT, not undefined: `undefined`
    // would still change the serialized bytes if the key were present.
    for (const key of [
      'mutationDepthHistogram',
      'discrimination',
      'harness',
      'bestChain',
      'admission',
    ]) {
      expect(Object.hasOwn(manifest as object, key)).toBe(false);
    }
    for (const record of manifest?.records ?? []) {
      for (const key of [
        'mutation',
        'reflection',
        'causalEvidenceRecordId',
        'harness',
        'admission',
      ]) {
        expect(Object.hasOwn(record as object, key)).toBe(false);
      }
    }
  });

  it('stamps the harness digest and bound model id on every lineage record', async () => {
    const recipe = await buildRecipe('model-a');
    const result = await runSplitFixture({
      candidateLineage: true,
      harnessRecipe: { recipe },
    });
    const manifest = result.optimizedProgram?.candidateLineage;
    expect(manifest?.version).toBe(2);
    expect(manifest?.harness).toEqual({
      recipeDigest: recipe.digest,
      boundModelId: 'model-a',
    });
    const records = manifest?.records ?? [];
    expect(records.length).toBeGreaterThan(1);
    // EVERY record, not just the accepted one: a stamp that only some
    // record sites carry is worse than none, because a reader cannot tell
    // an unstamped record from a record produced under another harness.
    for (const record of records) {
      expect(record.harness).toEqual({
        recipeDigest: recipe.digest,
        boundModelId: 'model-a',
      });
      expect(record.harness?.stale).toBeUndefined();
    }
  });

  it('marks a stamp stale only when currentModelId was supplied and differs', async () => {
    const recipe = await buildRecipe('model-a');
    const stampsFor = async (currentModelId?: string) => {
      const result = await runSplitFixture({
        candidateLineage: true,
        harnessRecipe: {
          recipe,
          ...(currentModelId ? { currentModelId } : {}),
        },
      });
      return (result.optimizedProgram?.candidateLineage?.records ?? []).map(
        (record) => record.harness?.stale
      );
    };
    // Absent means NOT EVALUATED, never "fresh".
    expect(await stampsFor(undefined)).toEqual([undefined, undefined]);
    expect(await stampsFor('model-a')).toEqual([undefined, undefined]);
    expect(await stampsFor('model-b')).toEqual([true, true]);
  });

  it('classifies paired rows into the four reflection categories', async () => {
    const result = await runSplitFixture({
      candidateLineage: {
        includeReflectionOutcomes: true,
        includeReflectionIndices: true,
      },
    });
    const records = result.optimizedProgram?.candidateLineage?.records ?? [];
    const mutation = records.find(
      (record) => record.strategy === 'reflective_mutation'
    );
    // Fixed emission order with zero-count entries retained.
    expect(mutation?.reflection?.map((outcome) => outcome.category)).toEqual([
      'fixed',
      'regressed',
      'still_failing',
      'still_passing',
    ]);
    expect(
      mutation?.reflection?.map((outcome) => [outcome.category, outcome.count])
    ).toEqual([
      ['fixed', 1],
      ['regressed', 1],
      ['still_failing', 0],
      ['still_passing', 0],
    ]);
    // Indices identify WHICH example moved, not just how many.
    expect(
      mutation?.reflection?.find((outcome) => outcome.category === 'fixed')
        ?.exampleIndices
    ).toEqual([0]);
    expect(
      mutation?.reflection?.find((outcome) => outcome.category === 'regressed')
        ?.exampleIndices
    ).toEqual([1]);
    // The seed is not a paired comparison, so it carries no reflection.
    expect(
      records.find((record) => record.strategy === 'seed')?.reflection
    ).toBeUndefined();
  });

  it('omits reflection indices unless they were opted into', async () => {
    const result = await runSplitFixture({
      candidateLineage: { includeReflectionOutcomes: true },
    });
    const mutation = (
      result.optimizedProgram?.candidateLineage?.records ?? []
    ).find((record) => record.strategy === 'reflective_mutation');
    expect(mutation?.reflection).toHaveLength(4);
    for (const outcome of mutation?.reflection ?? []) {
      expect(Object.hasOwn(outcome as object, 'exampleIndices')).toBe(false);
    }
  });

  it('emits a mutation depth histogram summing to the proposed candidate count', async () => {
    const result = await runSplitFixture({
      candidateLineage: true,
      mutationAnnotation: {},
    });
    const manifest = result.optimizedProgram?.candidateLineage;
    const histogram = manifest?.mutationDepthHistogram;
    expect(histogram).toBeDefined();
    const total = Object.values(histogram ?? {}).reduce(
      (sum, count) => sum + count,
      0
    );
    const proposed = (manifest?.records ?? []).filter(
      (record) => record.strategy !== 'seed'
    ).length;
    // The SEED is deliberately not annotated — it is not a patch — so the
    // histogram counts proposed candidates only.
    expect(proposed).toBeGreaterThan(0);
    expect(total).toBe(proposed);
    expect(histogram?.supervision).toBe(proposed);
    expect(histogram?.unannotated).toBe(0);
    const mutation = (manifest?.records ?? []).find(
      (record) => record.strategy === 'reflective_mutation'
    );
    expect(mutation?.mutation).toEqual({
      depth: 'supervision',
      patch: { class: 'steering', type: 'prompt.rule_modify' },
      componentClasses: ['context'],
    });
  });

  it('emits a running mutation depth histogram on every round, not only at completion', async () => {
    const events: any[] = [];
    // The optimizer-level logger, not the compile-option one: GEPA
    // deliberately does not forward `options` into
    // `updateOptimizationProgress`, so a compile-option logger never sees
    // RoundProgress.
    await runSplitFixture(
      { candidateLineage: true, mutationAnnotation: {} },
      {
        debugOptimizer: true,
        optimizerLogger: (data: any) => events.push(data),
      }
    );
    const rounds = events.filter((event) => event.name === 'RoundProgress');
    expect(rounds.length).toBeGreaterThan(0);
    for (const round of rounds) {
      expect(round.value.mutationDepthHistogram).toBeDefined();
    }
    const complete = events.find(
      (event) => event.name === 'OptimizationComplete'
    );
    expect(complete?.value.mutationDepthHistogram).toBeDefined();
  });

  it('aborts a candidate before evaluation when a required annotation is missing', async () => {
    const calls: string[] = [];
    const result = await runSplitFixture({
      candidateLineage: true,
      mutationAnnotation: {
        policy: 'required',
        annotator: (args: any) => {
          calls.push(args.strategy);
          return undefined;
        },
      },
    });
    const records = result.optimizedProgram?.candidateLineage?.records ?? [];
    const aborted = records.find(
      (record) => record.reason === 'mutation_annotation_required'
    );
    expect(aborted).toMatchObject({
      decision: 'aborted',
      disposition: 'aborted',
    });
    expect(aborted?.failures?.[0]?.kind).toBe('validator');
    // The annotator ran for the proposed candidate and never for the seed.
    expect(calls).toEqual(['reflective_mutation']);
    // Refused BEFORE the child minibatch, so it never reached the gate: the
    // candidate has no child_minibatch evaluation recorded.
    expect(aborted?.evaluations).toEqual([]);
    // ...and the aborted candidate is not the deployed one.
    expect(result.optimizedProgram?.componentMap).toEqual({
      'root::instruction': 'task',
    });
  });

  it('records a validator failure but promotes anyway when the policy is off', async () => {
    const result = await runSplitFixture({
      candidateLineage: true,
      mutationAnnotation: {
        annotator: () =>
          ({
            depth: 'not-a-depth',
            patch: { class: 'steering', type: 'prompt.rule_modify' },
            componentClasses: ['context'],
          }) as any,
      },
    });
    const records = result.optimizedProgram?.candidateLineage?.records ?? [];
    const mutation = records.find(
      (record) => record.strategy === 'reflective_mutation'
    );
    expect(mutation?.decision).toBe('accepted');
    expect(mutation?.mutation).toBeUndefined();
    // Silence would make the option look like it validated something.
    expect(
      mutation?.failures?.some((failure) => failure.kind === 'validator')
    ).toBe(true);
    expect(
      result.optimizedProgram?.candidateLineage?.mutationDepthHistogram
        ?.unannotated
    ).toBe(1);
  });

  it('reports a deployable best chain whose ancestry ends at the selected candidate', async () => {
    const result = await runSplitFixture(
      { candidateLineage: true, mutationAnnotation: {} },
      { numTrials: 3 }
    );
    const manifest = result.optimizedProgram?.candidateLineage;
    const chain = manifest?.bestChain;
    expect(chain).toBeDefined();
    expect(chain?.candidateId).toBe(manifest?.selectedCandidateId);
    // Root-first, ending at the deployed candidate.
    expect(chain?.ancestry.at(-1)).toBe(chain?.candidateId);
    expect(chain?.ancestry[0]).toBe('c0');
    expect(new Set(chain?.ancestry).size).toBe(chain?.ancestry.length);
    // No archive-best / oracle composite is produced anywhere.
    expect(Object.hasOwn(manifest as object, 'archiveBest')).toBe(false);
  });

  it('publishes a causal-evidence cross-link id on every version-2 record', async () => {
    const result = await runSplitFixture({
      candidateLineage: true,
      mutationAnnotation: {},
    });
    const records = result.optimizedProgram?.candidateLineage?.records ?? [];
    expect(records.length).toBeGreaterThan(1);
    for (const record of records) {
      expect(record.causalEvidenceRecordId).toBe(`gepa-candidate-${record.id}`);
    }
    // Unique per candidate, so it can be a manifest record id.
    expect(
      new Set(records.map((record) => record.causalEvidenceRecordId)).size
    ).toBe(records.length);
  });
});

describe('rejected-candidate ledger wiring', () => {
  const makeClock = () => {
    let now = 1_000;
    return {
      now: () => now,
      advanceBy: (ms: number) => {
        now += ms;
      },
    };
  };

  /**
   * Two rounds where the proposal is always WORSE than the parent, so both are
   * rejected at gate 1 and both must reach the ledger.
   */
  const runRejecting = async (
    ledger: Record<string, unknown> | undefined,
    overrides: Record<string, unknown> = {}
  ) => {
    const priorSeenPerRound: unknown[][] = [];
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 2,
      minibatch: false,
      mergeMax: 0,
      earlyStoppingTrials: 10,
      minImprovementThreshold: 0,
      ...overrides,
    });
    const program = createSingleRootProgram('task', async (instruction) => ({
      score: instruction === 'task' ? 1 : 0,
    }));
    (optimizer as any).reflectTargetInstruction = async (
      ...args: unknown[]
    ) => {
      priorSeenPerRound.push((args[11] as unknown[]) ?? []);
      return 'worse';
    };
    const result = await optimizer.compile(
      program as any,
      [{ question: 'q1' }, { question: 'q2' }],
      async ({ prediction }) => prediction.score,
      {
        maxMetricCalls: 60,
        skipPerfectScore: false,
        candidateLineage: true,
        ...(ledger ? { rejectedCandidateLedger: ledger } : {}),
      }
    );
    return { result, priorSeenPerRound };
  };

  it('records a rejection and offers it back as an untrusted prior next round', async () => {
    const clock = makeClock();
    const store = new AxInMemoryRejectedCandidateLedger({ clock });
    const { result, priorSeenPerRound } = await runRejecting({
      store,
      storeId: 'test-store',
      clock,
      expiresWhen: [{ kind: 'after_ms', ttlMs: 60_000 }],
    });

    // Round 1 saw nothing; round 2 saw round 1's rejection.
    expect(priorSeenPerRound).toHaveLength(2);
    expect(priorSeenPerRound[0]).toEqual([]);
    expect(priorSeenPerRound[1]).toHaveLength(1);
    const offered = priorSeenPerRound[1]![0] as any;
    expect(offered.implicatedSurfaces).toEqual(['root::instruction']);
    expect(offered.gateReading).toMatchObject({
      gate: 'reflective_mutation',
      estimator: 'sum',
    });
    // The diagnosis quotes the model's own proposed text back — which is
    // exactly why it is untrusted and never enters the reference channel.
    expect(offered.diagnosis).toContain('insufficient_minibatch_improvement');
    expect(offered.diagnosis).toContain('root::instruction="worse"');

    // The artifact carries POINTERS only.
    const ref = (result.optimizedProgram as any)?.rejectedCandidateLedgerRef;
    expect(ref?.storeId).toBe('test-store');
    expect(ref?.entryDigests).toHaveLength(1);
    expect(ref?.entryDigests[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref?.omittedDigestCount).toBe(0);
    // Both rounds proposed the same value, so both rejections supersede onto
    // one entry rather than accumulating duplicates.
    const stored = await store.list({ now: clock.now() });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.candidateDigest).toBe(ref?.entryDigests[0]);
  });

  it('drops an entry from the prior once its ttl has elapsed', async () => {
    const clock = makeClock();
    const store = new AxInMemoryRejectedCandidateLedger({ clock });
    await runRejecting({
      store,
      storeId: 'test-store',
      clock,
      expiresWhen: [{ kind: 'after_ms', ttlMs: 60_000 }],
    });
    expect(await store.list({ now: clock.now() })).toHaveLength(1);
    clock.advanceBy(60_000);
    // Fail-open: negative memory that outlives its stated conditions is a
    // capability ceiling, so the entry leaves the query result.
    expect(await store.list({ now: clock.now() })).toHaveLength(0);
  });

  it('continues the run and records a runtime failure when the store throws', async () => {
    const clock = makeClock();
    const throwing = {
      capabilities: {
        durability: 'volatile',
        rollbackSurvival: 'unknown',
      } as const,
      record: async () => {
        throw new Error('ledger offline');
      },
      list: async () => {
        throw new Error('ledger offline');
      },
      purgeExpired: async () => 0,
    };
    const { result } = await runRejecting({
      store: throwing,
      storeId: 'broken',
      clock,
      expiresWhen: [{ kind: 'after_ms', ttlMs: 60_000 }],
    });

    // The run completed and still selected an artifact.
    expect(result.optimizedProgram?.componentMap).toEqual({
      'root::instruction': 'task',
    });
    const records = result.optimizedProgram?.candidateLineage?.records ?? [];
    const rejected = records.filter((record) => record.decision === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(
      rejected.some((record) =>
        record.failures?.some(
          (failure) =>
            failure.kind === 'runtime' &&
            failure.messageFingerprint !== undefined
        )
      )
    ).toBe(true);
    // No ref: nothing was durably recorded, and claiming otherwise on the
    // artifact would be a pointer into an empty store.
    expect(
      (result.optimizedProgram as any)?.rejectedCandidateLedgerRef
    ).toBeUndefined();
  });

  it('refuses an expiry with no ttl before any metric call', async () => {
    const clock = makeClock();
    const store = new AxInMemoryRejectedCandidateLedger({ clock });
    let forwardCalls = 0;
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
    });
    await expect(
      optimizer.compile(
        createSingleRootProgram('task', async () => {
          forwardCalls += 1;
          return { score: 0 };
        }) as any,
        [{ question: 'q1' }, { question: 'q2' }],
        async ({ prediction }) => prediction.score,
        {
          maxMetricCalls: 20,
          rejectedCandidateLedger: {
            store,
            storeId: 'test-store',
            clock,
            expiresWhen: [{ kind: 'model_changed', boundModelId: 'model-a' }],
          },
        }
      )
    ).rejects.toThrow('expiry_requires_ttl');
    // Refused BEFORE anything ran: permanent negative memory is a caller bug,
    // not a degraded store, so it fails loudly and for free.
    expect(forwardCalls).toBe(0);
  });

  /**
   * One round whose CHILD rollouts all fail, so the batch is aborted for
   * `insufficient_admitted_rows` before any comparison is computed.
   */
  const runAborting = async (ledger: Record<string, unknown>) => {
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
      minibatch: false,
      mergeMax: 0,
      minImprovementThreshold: 0,
    } as any);
    (optimizer as any).reflectTargetInstruction = async () => 'worse';
    const program = createSingleRootProgram(
      'task',
      async (instruction: string) => {
        if (instruction === 'worse') throw new Error('provider 429');
        return { score: 0.5 };
      }
    );
    const classifier: AxTrajectoryTerminationClassifier = (input) =>
      input.error === undefined
        ? { kind: 'completed' }
        : { kind: 'environment_failure', cause: 'transport' };
    return await optimizer.compile(
      program as any,
      [{ question: 'q1' }, { question: 'q2' }, { question: 'q3' }] as any,
      async ({ prediction }: any) => prediction.score,
      {
        maxMetricCalls: 60,
        skipPerfectScore: false,
        candidateLineage: true,
        trajectoryTermination: { classifier },
        rejectedCandidateLedger: ledger,
      } as any
    );
  };

  it('records no score pair and no observed delta for a candidate aborted before the comparison', async () => {
    const clock = makeClock();
    const store = new AxInMemoryRejectedCandidateLedger({ clock });
    const result = await runAborting({
      store,
      storeId: 'test-store',
      clock,
      expiresWhen: [{ kind: 'after_ms', ttlMs: 60_000 }],
    });
    const records = result.optimizedProgram?.candidateLineage?.records ?? [];
    expect(
      records.some(
        (record: any) =>
          record.decision === 'aborted' &&
          record.reason === 'insufficient_admitted_rows'
      )
    ).toBe(true);

    const [aborted] = await store.list({ now: clock.now() });
    expect(aborted).toBeDefined();
    // The abort produced NO comparable numbers. A `parentScore: 0,
    // childScore: 0` pair would record a measured delta of zero for an
    // evaluation that never ran, and a later reader could not tell that from a
    // real tie (§12/M1).
    expect(Object.hasOwn(aborted!.gateReading, 'parentScore')).toBe(false);
    expect(Object.hasOwn(aborted!.gateReading, 'childScore')).toBe(false);
    expect(aborted!.observedDeltas).toEqual([]);
    expect(aborted!.gateReading.admittedRows).toBe(0);
    // ...and the rendered prior says so rather than printing a hole.
    const prior = axRejectedCandidatePrior([aborted!]);
    expect(prior?.content).toContain('comparison: none');
    expect(prior?.content).not.toContain('parent: undefined');

    // CONTROL: a candidate that was actually COMPARED and lost carries both
    // scores and one observed delta, so the absence above is a claim about
    // this entry, not a field the writer never fills.
    const rejectedClock = makeClock();
    const rejectedStore = new AxInMemoryRejectedCandidateLedger({
      clock: rejectedClock,
    });
    await runRejecting({
      store: rejectedStore,
      storeId: 'test-store',
      clock: rejectedClock,
      expiresWhen: [{ kind: 'after_ms', ttlMs: 60_000 }],
    });
    const [compared] = await rejectedStore.list({ now: rejectedClock.now() });
    expect(typeof compared?.gateReading.parentScore).toBe('number');
    expect(typeof compared?.gateReading.childScore).toBe('number');
    expect(compared?.observedDeltas).toEqual([
      { metric: 'scalar', split: 'held_in', delta: -2 },
    ]);
  });

  it('keeps the most recent digests when the artifact ref hits its cap', async () => {
    // The cap is a MEMORY bound, and `normalizeRef` keeps the tail. A clamp
    // that dropped the newest digests would pin a run's first attempts and
    // omit everything it learned afterwards (§12/M2).
    const clock = makeClock();
    const store = new AxInMemoryRejectedCandidateLedger({ clock });
    const seen: string[] = [];
    const recordingStore = {
      capabilities: store.capabilities,
      record: async (entry: any, signal?: AbortSignal) => {
        seen.push(entry.candidateDigest);
        return await store.record(entry, signal);
      },
      list: store.list.bind(store),
      purgeExpired: store.purgeExpired.bind(store),
    };
    const rounds = AX_REJECTED_LEDGER_REF_MAX_DIGESTS + 3;
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: rounds,
      minibatch: false,
      mergeMax: 0,
      earlyStoppingTrials: rounds + 1,
      minImprovementThreshold: 0,
    } as any);
    let proposal = 0;
    (optimizer as any).reflectTargetInstruction = async () => {
      proposal += 1;
      return `worse-${proposal}`;
    };
    const program = createSingleRootProgram('task', async (instruction) => ({
      score: instruction === 'task' ? 1 : 0,
    }));
    const result = await optimizer.compile(
      program as any,
      [{ question: 'q1' }, { question: 'q2' }] as any,
      async ({ prediction }: any) => prediction.score,
      {
        maxMetricCalls: 4 * rounds + 8,
        skipPerfectScore: false,
        rejectedCandidateLedger: {
          store: recordingStore,
          storeId: 'test-store',
          clock,
          expiresWhen: [{ kind: 'after_ms', ttlMs: 600_000 }],
        },
      } as any
    );
    expect(seen.length).toBeGreaterThan(AX_REJECTED_LEDGER_REF_MAX_DIGESTS);
    const ref = (result.optimizedProgram as any)?.rejectedCandidateLedgerRef;
    expect(ref.entryDigests).toHaveLength(AX_REJECTED_LEDGER_REF_MAX_DIGESTS);
    expect(ref.omittedDigestCount).toBe(
      seen.length - AX_REJECTED_LEDGER_REF_MAX_DIGESTS
    );
    // The retained set is the TAIL of the write order, not its head.
    expect([...ref.entryDigests]).toEqual(
      seen.slice(seen.length - AX_REJECTED_LEDGER_REF_MAX_DIGESTS)
    );
    expect(ref.entryDigests).not.toContain(seen[0]);
    expect(ref.entryDigests).toContain(seen[seen.length - 1]);
  });

  it('writes no ledger ref and offers no prior when the option is omitted', async () => {
    const { result, priorSeenPerRound } = await runRejecting(undefined);
    expect(priorSeenPerRound.every((prior) => prior.length === 0)).toBe(true);
    expect(
      (result.optimizedProgram as any)?.rejectedCandidateLedgerRef
    ).toBeUndefined();
    expect(
      Object.hasOwn(
        result.optimizedProgram as object,
        'rejectedCandidateLedgerRef'
      )
    ).toBe(false);
  });
});
