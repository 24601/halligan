import { describe, expect, it } from 'vitest';
import type { AxAIService } from '../../ai/types.js';
import {
  axDeserializeOptimizedProgram,
  axSerializeOptimizedProgram,
} from '../optimizer.js';
import { ax } from '../template.js';
import { AxGEPA } from './gepa.js';

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
      toString: () => `\"${baseInstruction}\" question:string -> answer:string`,
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
      toString: () => `\"${description}\" input:string -> output:string`,
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

    it('does not read candidate-lineage or abort accessors at the opt-in boundary', async () => {
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

      expect(descriptorCalls).toBe(2);
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
      if (manifest.selectedCandidateId) {
        expect(
          manifest.records.some(
            (record) => record.id === manifest.selectedCandidateId
          ) || manifest.selectedCandidateRetained === false
        ).toBe(true);
      }
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
        async () => 0.25,
        {
          feedbackFn: ({ componentId }: { componentId?: string }) =>
            componentId ? `component=${componentId}` : undefined,
        }
      );

      expect(capturedPrompt).toContain('"taskDigest": "branch-a"');
      expect(capturedPrompt).toContain('"nested": [');
      expect(capturedPrompt).toContain('component=root');
      expect(capturedPrompt).not.toContain('[object Object]');
    });
  });
});
