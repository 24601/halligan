import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import {
  axDeserializeOptimizedProgram,
  axSerializeOptimizedProgram,
} from '../optimizer.js';
import { ax } from '../template.js';
import { AxGEPA } from './gepa.js';
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

    it('does not read candidate-lineage, abort or trajectory-termination accessors at the opt-in boundary', async () => {
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

      // One own-descriptor read per opt-in option: candidateLineage,
      // abortSignal, trajectoryTermination. This count is the tripwire that a
      // new option was added without being routed through `ownDataOption`.
      expect(descriptorCalls).toBe(3);
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
    const optimizer = new AxGEPA({
      studentAI: {} as AxAIService,
      teacherAI: {} as AxAIService,
      numTrials: 1,
      minibatch: false,
      minImprovementThreshold: 0,
      debugOptimizer: true,
      optimizerLogger: (event: any) => events.push(event),
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
    return { result, events };
  };

  const lineageRecords = (result: any) =>
    (result.optimizedProgram?.candidateLineage?.records ?? []) as any[];

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
    const { result } = await runOptimizer({
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
  });

  it('ends the run and publishes no best score above the run discard ceiling', async () => {
    const { result, events } = await runOptimizer({
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
