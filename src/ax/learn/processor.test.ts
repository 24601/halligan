import { describe, expect, it } from 'vitest';

import {
  type AxLearningDecision,
  type AxLearningEngineState,
  type AxLearningProcessor,
  type AxLearningReportContext,
  axCreateLearningEngineState,
  axLearningEligibility,
  axLearningEngineAcknowledge,
  axLearningEngineBuildBatch,
  axLearningEngineIngest,
  axLearningEngineNeverReasons,
  axLearningEngineReady,
  axScoreWindowProcessor,
} from './processor.js';
import {
  axCreateLearningInteractionRecord,
  axCreateLearningReportRecord,
} from './records.js';
import type {
  AxLearningRecord,
  AxLearningReportRecord,
  AxLearningValue,
} from './types.js';

const NOW = 1_700_000_000_000;
const SCENARIO = 'support-triage';

function interaction(
  id: string,
  override: { output?: AxLearningValue; artifactRef?: never } = {}
) {
  return axCreateLearningInteractionRecord({
    id,
    scenario: SCENARIO,
    createdAt: NOW,
    signature: 'question:string -> answer:string',
    programId: 'prog-1',
    input: { question: id },
    output: override.output ?? { answer: id },
    model: 'gpt-5.6',
    usage: { totalTokens: 42 },
    tags: { tenant: 'acme' },
  });
}

function report(
  id: string,
  references: readonly string[],
  payload: {
    score?: number;
    feedback?: string;
    metadata?: Record<string, AxLearningValue>;
  } = { score: 0 }
) {
  return axCreateLearningReportRecord({
    id,
    scenario: SCENARIO,
    createdAt: NOW,
    input: { references, ...payload },
  });
}

/** A report record built by hand, for shapes `report()` refuses at ingress. */
function rawReport(
  id: string,
  references: readonly string[],
  score: unknown
): AxLearningReportRecord {
  return {
    kind: 'report',
    id,
    scenario: SCENARIO,
    createdAt: NOW,
    references,
    payload: { score } as never,
  };
}

function engine(
  processor: AxLearningProcessor = axScoreWindowProcessor(),
  options: { sampleFields?: never; maxSampleBytes?: number } = {}
): AxLearningEngineState {
  return axCreateLearningEngineState({
    scenario: SCENARIO,
    processor,
    ...options,
  });
}

function feed(
  state: AxLearningEngineState,
  ...records: readonly AxLearningRecord[]
): { state: AxLearningEngineState; decisions: AxLearningDecision[] } {
  let current = state;
  const decisions: AxLearningDecision[] = [];
  for (const record of records) {
    const step = axLearningEngineIngest(current, record);
    current = step.state;
    decisions.push(...step.decisions.map((entry) => entry.decision));
  }
  return { state: current, decisions };
}

describe('axLearningEligibility', () => {
  function context(
    record: AxLearningReportRecord,
    resolution: AxLearningReportContext['resolution'] = {
      status: 'resolved',
      interactions: [],
    }
  ): AxLearningReportContext {
    const raw = record.payload.score;
    return {
      report: record,
      score: typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined,
      trainable:
        (
          record.payload.metadata?.training as
            | { eligible?: unknown }
            | undefined
        )?.eligible !== false,
      references: record.references,
      resolution,
    };
  }

  it('names each terminal reason', () => {
    expect(
      axLearningEligibility(context(report('r', [], { score: 0 })))
    ).toEqual({ outcome: 'never', reason: 'no-references' });
    expect(axLearningEligibility(context(report('r', ['a'], {})))).toEqual({
      outcome: 'never',
      reason: 'no-score',
    });
    // A boolean and a NaN are distinct malfunctions and get distinct names.
    expect(axLearningEligibility(context(rawReport('r', ['a'], true)))).toEqual(
      {
        outcome: 'never',
        reason: 'boolean-score',
      }
    );
    expect(
      axLearningEligibility(context(rawReport('r', ['a'], Number.NaN)))
    ).toEqual({ outcome: 'never', reason: 'non-finite-score' });
    expect(
      axLearningEligibility(
        context(
          report('r', ['a'], {
            score: 0,
            metadata: { training: { eligible: false } },
          })
        )
      )
    ).toEqual({ outcome: 'never', reason: 'training-opted-out' });
  });

  it('treats anything but the literal false as trainable', () => {
    for (const eligible of [true, 'false', 0, null]) {
      const record = report('r', ['a'], {
        score: 0,
        metadata: { training: { eligible } as never },
      });
      expect(axLearningEligibility(context(record))).toBeUndefined();
    }
  });

  it('returns malformed rather than wait for duplicate references', () => {
    // Duplicates are terminal: parking them would wait forever for an id that
    // has already arrived.
    const decision = axLearningEligibility(
      context(report('r', ['a', 'a'], { score: 0 }), {
        status: 'malformed',
        reason: 'duplicate-references',
      })
    );
    expect(decision).toEqual({
      outcome: 'never',
      reason: 'duplicate-references',
    });
  });

  it('waits with the missing ids', () => {
    expect(
      axLearningEligibility(
        context(report('r', ['a', 'b'], { score: 0 }), {
          status: 'waiting',
          missing: ['b'],
        })
      )
    ).toEqual({ outcome: 'wait', missing: ['b'] });
  });
});

describe('the reducer: ordering', () => {
  it('trains when interaction and report both land, in either order', () => {
    const forward = feed(engine(), interaction('a'), report('r', ['a']));
    expect(forward.decisions.at(-1)?.outcome).toBe('train');

    const backward = feed(engine(), report('r', ['a']), interaction('a'));
    expect(backward.decisions.map((decision) => decision.outcome)).toEqual([
      'wait',
      'train',
    ]);
    expect(backward.state.readyCount).toBe(1);
    expect(backward.state.waitingCount).toBe(0);
  });

  it('parks a report until the LAST missing reference lands', () => {
    const processor = axScoreWindowProcessor({ batchSize: 1 });
    // A multi-reference report never trains under the default processor, so
    // use one that accepts an arity of two.
    const pairProcessor: AxLearningProcessor = {
      id: 'pair',
      batchSize: 1,
      judge(context) {
        if (context.resolution.status === 'waiting') {
          return { outcome: 'wait', missing: context.resolution.missing };
        }
        if (context.resolution.status !== 'resolved') {
          return { outcome: 'never', reason: context.resolution.reason };
        }
        return {
          outcome: 'train',
          unit: {
            reportId: context.report.id,
            samples: context.resolution.interactions.map((record) => ({
              sourceRecordId: record.id,
              payload: record.payload,
              score: context.score ?? 0,
            })),
          },
        };
      },
    };
    expect(processor.id).toBe('axScoreWindow');

    let state = engine(pairProcessor);
    let step = axLearningEngineIngest(state, report('r', ['a', 'b']));
    state = step.state;
    expect(step.decisions[0]?.decision).toEqual({
      outcome: 'wait',
      missing: ['a', 'b'],
    });

    step = axLearningEngineIngest(state, interaction('a'));
    state = step.state;
    expect(step.decisions[0]?.decision).toEqual({
      outcome: 'wait',
      missing: ['b'],
    });
    expect(state.waitingCount).toBe(1);

    step = axLearningEngineIngest(state, interaction('b'));
    expect(step.decisions[0]?.decision.outcome).toBe('train');
    expect(step.state.waitingCount).toBe(0);
    expect(step.state.readyCount).toBe(1);
  });

  it('throws when a processor waits with no missing reference', () => {
    const liar: AxLearningProcessor = {
      id: 'liar',
      batchSize: 1,
      judge: () => ({ outcome: 'wait', missing: [] }),
    };
    const state = feed(engine(liar), interaction('a')).state;
    expect(() => axLearningEngineIngest(state, report('r', ['a']))).toThrow(
      /wait with no missing reference/
    );
  });

  it('re-judges only the reports parked on the arriving id', () => {
    // The waiting index is keyed by interaction id so a backlog of unrelated
    // parked reports costs nothing. A naive full re-scan fails this.
    let judged = 0;
    const counting: AxLearningProcessor = {
      id: 'counting',
      batchSize: 1_000,
      judge(context) {
        judged++;
        if (context.resolution.status === 'waiting') {
          return { outcome: 'wait', missing: context.resolution.missing };
        }
        return {
          outcome: 'train',
          unit: { reportId: context.report.id, samples: [] },
        };
      },
    };

    let state = engine(counting);
    for (let i = 0; i < 200; i++) {
      state = axLearningEngineIngest(state, report(`r-${i}`, [`x-${i}`])).state;
    }
    expect(state.waitingCount).toBe(200);
    judged = 0;
    // One interaction arrives; exactly one parked report names it.
    const step = axLearningEngineIngest(state, interaction('x-7'));
    expect(judged).toBe(1);
    expect(step.decisions).toHaveLength(1);
    expect(step.state.waitingCount).toBe(199);
  });

  it('is pure: ingesting into a snapshot does not mutate the original', () => {
    const base = feed(engine(), interaction('a')).state;
    const snapshot = JSON.parse(
      JSON.stringify({
        readyCount: base.readyCount,
        waitingCount: base.waitingCount,
        neverReasons: base.neverReasons,
      })
    );
    const next = axLearningEngineIngest(base, report('r', ['a'])).state;
    expect(next.readyCount).toBe(1);
    expect({
      readyCount: base.readyCount,
      waitingCount: base.waitingCount,
      neverReasons: base.neverReasons,
    }).toEqual(snapshot);
    expect(base.readyCount).toBe(0);
  });
});

describe('the reducer: never reasons', () => {
  it('counts every distinct reason, and repeats increment the same counter', () => {
    let state = engine();
    state = feed(state, report('r1', [], { score: 0 })).state;
    state = feed(state, report('r2', [], { score: 0 })).state;
    state = feed(state, report('r3', ['a'], {})).state;
    state = feed(state, rawReport('r4', ['a'], Number.POSITIVE_INFINITY)).state;
    state = feed(state, rawReport('r5', ['a'], false)).state;
    state = feed(
      state,
      report('r6', ['a'], {
        score: 0,
        metadata: { training: { eligible: false } },
      })
    ).state;
    state = feed(state, report('r7', ['a', 'a'], { score: 0 })).state;
    state = feed(state, report('r8', ['a', 'b'], { score: 0 })).state;
    state = feed(state, interaction('a')).state;
    state = feed(state, report('r9', ['a'], { score: 5 })).state;

    expect(axLearningEngineNeverReasons(state)).toEqual({
      'no-references': 2,
      'no-score': 1,
      'non-finite-score': 1,
      'boolean-score': 1,
      'training-opted-out': 1,
      'duplicate-references': 1,
      'multi-reference': 1,
      'score-outside-window': 1,
    });
    // Nothing terminal is left parked or ready.
    expect(state.waitingCount).toBe(0);
    expect(state.readyCount).toBe(0);
  });

  it('ingesting the same report twice is a no-op with a counted reason', () => {
    const first = feed(engine(), interaction('a'), report('r', ['a']));
    expect(first.state.readyCount).toBe(1);
    const second = axLearningEngineIngest(first.state, report('r', ['a']));
    expect(second.decisions).toEqual([]);
    expect(second.state.readyCount).toBe(1);
    expect(second.state.neverReasons['report-already-seen']).toBe(1);
  });

  it('an acknowledged batch refuses to train its sources again', () => {
    const start = feed(engine(), interaction('a'), report('r1', ['a'])).state;
    const built = axLearningEngineBuildBatch(start, 1);
    const acknowledged = axLearningEngineAcknowledge(
      built.state,
      built.batch.batchId
    );
    expect(acknowledged.consumedIds).toEqual(['a', 'r1']);

    // A new report naming the same exchange is terminal, whatever order the
    // records replay in.
    const replay = feed(acknowledged.state, report('r2', ['a']));
    expect(replay.decisions[0]).toEqual({
      outcome: 'never',
      reason: 'already-trained-source',
    });
    const replayReversed = feed(
      acknowledged.state,
      report('r3', ['a', 'b']),
      interaction('b')
    );
    expect(replayReversed.decisions[0]).toEqual({
      outcome: 'never',
      reason: 'already-trained-source',
    });
  });

  it('refuses a second ready unit for an occupied slot', () => {
    const slotted: AxLearningProcessor = {
      id: 'slotted',
      batchSize: 10,
      judge: (context) => ({
        outcome: 'train',
        unit: {
          reportId: context.report.id,
          samples: [],
          slot: 'headline',
        },
      }),
    };
    const state = feed(
      engine(slotted),
      interaction('a'),
      interaction('b'),
      report('r1', ['a']),
      report('r2', ['b'])
    );
    expect(state.decisions.at(-1)).toEqual({
      outcome: 'never',
      reason: 'slot-occupied',
    });
    expect(state.state.readyCount).toBe(1);
    expect(state.state.neverReasons['slot-occupied']).toBe(1);
  });

  it('keeps a slot occupied while its batch is un-acknowledged', () => {
    const slotted: AxLearningProcessor = {
      id: 'slotted',
      batchSize: 1,
      judge: (context) => ({
        outcome: 'train',
        unit: { reportId: context.report.id, samples: [], slot: 'headline' },
      }),
    };
    let state = feed(
      engine(slotted),
      interaction('a'),
      report('r1', ['a'])
    ).state;
    state = axLearningEngineBuildBatch(state, 1).state;
    // The unit left readyUnits but has not been acknowledged, so the slot is
    // still taken.
    const blocked = feed(state, interaction('b'), report('r2', ['b']));
    expect(blocked.decisions.at(-1)).toEqual({
      outcome: 'never',
      reason: 'slot-occupied',
    });
  });
});

describe('axScoreWindowProcessor', () => {
  it('keeps only failures by default', () => {
    const failing = feed(
      engine(),
      interaction('a'),
      report('r1', ['a'], { score: 0 })
    );
    expect(failing.decisions.at(-1)?.outcome).toBe('train');

    const passing = feed(
      engine(),
      interaction('a'),
      report('r1', ['a'], { score: 1 })
    );
    expect(passing.decisions.at(-1)).toEqual({
      outcome: 'never',
      reason: 'score-outside-window',
    });
  });

  it('maxScore Infinity makes the whole stream batch', () => {
    const processor = axScoreWindowProcessor({
      maxScore: Number.POSITIVE_INFINITY,
      batchSize: 3,
    });
    const state = feed(
      engine(processor),
      interaction('a'),
      interaction('b'),
      report('r1', ['a'], { score: 1 }),
      report('r2', ['b'], { score: 999 })
    );
    expect(state.state.readyCount).toBe(2);
  });

  it('multi-reference reports never batch, whatever the score', () => {
    for (const score of [0, -5, 1_000]) {
      const state = feed(
        engine(),
        interaction('a'),
        interaction('b'),
        report(`r-${score}`, ['a', 'b'], { score })
      );
      expect(state.decisions.at(-1)).toEqual({
        outcome: 'never',
        reason: 'multi-reference',
      });
    }
  });

  it('refuses a nonsensical configuration', () => {
    expect(() => axScoreWindowProcessor({ batchSize: 0 })).toThrow(
      /positive safe integer/
    );
    expect(() => axScoreWindowProcessor({ minScore: 1, maxScore: 0 })).toThrow(
      /minScore must not exceed maxScore/
    );
  });
});

describe('the reducer: batching', () => {
  it('is not ready until batchSize units are ready', () => {
    const processor = axScoreWindowProcessor({ batchSize: 2 });
    let state = engine(processor);
    expect(axLearningEngineReady(state)).toBe(false);
    state = feed(state, interaction('a'), report('r1', ['a'])).state;
    expect(axLearningEngineReady(state)).toBe(false);
    state = feed(state, interaction('b'), report('r2', ['b'])).state;
    expect(axLearningEngineReady(state)).toBe(true);
  });

  it('hands out the same batch until acknowledged', () => {
    const state = feed(engine(), interaction('a'), report('r1', ['a'])).state;
    const first = axLearningEngineBuildBatch(state, 1);
    const second = axLearningEngineBuildBatch(first.state, 2);
    expect(second.batch).toBe(first.batch);
    expect(second.batch.batchNumber).toBe(1);
    expect(second.state).toBe(first.state);
    expect(axLearningEngineReady(first.state)).toBe(true);

    const acknowledged = axLearningEngineAcknowledge(
      first.state,
      first.batch.batchId
    );
    expect(acknowledged.state.pendingBatchId).toBeUndefined();
    expect(axLearningEngineReady(acknowledged.state)).toBe(false);
    expect(() =>
      axLearningEngineAcknowledge(acknowledged.state, first.batch.batchId)
    ).toThrow(/no pending batch/);
  });

  it('projects payloads through sampleFields, withholding model, usage and tags', () => {
    const state = feed(engine(), interaction('a'), report('r1', ['a'])).state;
    const { batch } = axLearningEngineBuildBatch(state, 1);
    const sample = batch.samples[0];
    expect(sample?.payload).toEqual({
      input: { question: 'a' },
      output: { answer: 'a' },
    });
    // Withheld by default: these reach a model prompt if they are projected.
    expect(JSON.stringify(batch)).not.toContain('acme');
    expect(JSON.stringify(batch)).not.toContain('gpt-5.6');
    expect(sample?.score).toBe(0);
    expect(sample?.sourceRecordId).toBe('a');
  });

  it('projects the fields it was asked for, and only those', () => {
    const state = axCreateLearningEngineState({
      scenario: SCENARIO,
      processor: axScoreWindowProcessor(),
      sampleFields: ['input', 'model'],
    });
    const fed = feed(state, interaction('a'), report('r1', ['a'])).state;
    const { batch } = axLearningEngineBuildBatch(fed, 1);
    expect(batch.samples[0]?.payload).toEqual({
      input: { question: 'a' },
      model: 'gpt-5.6',
    });
  });

  it('drops oldest units over maxSampleBytes and reports droppedSamples', () => {
    const processor = axScoreWindowProcessor({ batchSize: 4 });
    const state = axCreateLearningEngineState({
      scenario: SCENARIO,
      processor,
      maxSampleBytes: 200,
    });
    let current = state;
    for (const id of ['a', 'b', 'c', 'd']) {
      current = feed(
        current,
        axCreateLearningInteractionRecord({
          id,
          scenario: SCENARIO,
          createdAt: NOW,
          signature: 'q:string -> a:string',
          programId: 'p',
          input: { question: id.repeat(40) },
          output: { answer: id.repeat(40) },
        }),
        report(`r-${id}`, [id])
      ).state;
    }
    const built = axLearningEngineBuildBatch(current, 1);
    expect(built.batch.droppedSamples).toBeGreaterThan(0);
    expect(built.batch.samples.length).toBeLessThan(4);
    // Newest survive; the oldest are deferred, not lost.
    expect(built.batch.samples.at(-1)?.sourceRecordId).toBe('d');
    expect(built.state.readyCount).toBe(built.batch.droppedSamples);
  });

  it('keeps at least one unit even when it alone exceeds the cap', () => {
    const state = axCreateLearningEngineState({
      scenario: SCENARIO,
      processor: axScoreWindowProcessor(),
      maxSampleBytes: 1,
    });
    const fed = feed(state, interaction('a'), report('r1', ['a'])).state;
    const built = axLearningEngineBuildBatch(fed, 1);
    expect(built.batch.samples).toHaveLength(1);
    expect(built.batch.droppedSamples).toBe(0);
  });

  it('batches a group whole or not at all, and discards one that never fits', () => {
    const grouped: AxLearningProcessor = {
      id: 'grouped',
      batchSize: 2,
      judge: (context) => ({
        outcome: 'train',
        unit: {
          reportId: context.report.id,
          samples: [],
          groupKey: context.report.payload.feedback as string,
        },
      }),
    };
    let state = engine(grouped);
    // Group "big" has three members and can never fit a batch of two.
    for (const id of ['a', 'b', 'c']) {
      state = feed(
        state,
        interaction(id),
        report(`r-${id}`, [id], { score: 0, feedback: 'big' })
      ).state;
    }
    // Group "pair" has two and fits exactly.
    for (const id of ['d', 'e']) {
      state = feed(
        state,
        interaction(id),
        report(`r-${id}`, [id], { score: 0, feedback: 'pair' })
      ).state;
    }
    const built = axLearningEngineBuildBatch(state, 1);
    expect(built.batch.units.map((unit) => unit.reportId)).toEqual([
      'r-d',
      'r-e',
    ]);
    expect(built.state.neverReasons['group-discarded']).toBe(3);
  });

  it('rejects a bad batch number', () => {
    const state = feed(engine(), interaction('a'), report('r1', ['a'])).state;
    expect(() => axLearningEngineBuildBatch(state, 0)).toThrow(
      /positive safe integer/
    );
  });

  it('names a batch stably from scenario, processor and number', () => {
    const state = feed(engine(), interaction('a'), report('r1', ['a'])).state;
    const { batch } = axLearningEngineBuildBatch(state, 7);
    expect(batch.batchId).toBe(`${SCENARIO}:axScoreWindow:7`);
    expect(batch.processorId).toBe('axScoreWindow');
    expect(batch.scenario).toBe(SCENARIO);
  });
});

describe('axCreateLearningEngineState', () => {
  it('refuses an empty scenario and a nonsensical byte cap', () => {
    expect(() =>
      axCreateLearningEngineState({
        scenario: '',
        processor: axScoreWindowProcessor(),
      })
    ).toThrow(/non-empty string/);
    expect(() =>
      axCreateLearningEngineState({
        scenario: SCENARIO,
        processor: axScoreWindowProcessor(),
        maxSampleBytes: 0,
      })
    ).toThrow(/positive safe integer/);
  });
});

describe('batch capacity and emptiness', () => {
  const grouped = (batchSize: number): AxLearningProcessor => ({
    id: 'grouped',
    batchSize,
    judge: (context) => ({
      outcome: 'train',
      unit: {
        reportId: context.report.id,
        samples: [],
        ...(context.report.payload.feedback === undefined
          ? {}
          : { groupKey: context.report.payload.feedback as string }),
      },
    }),
  });

  function ready(
    processor: AxLearningProcessor,
    arrivals: readonly (readonly [string, string | undefined])[]
  ): AxLearningEngineState {
    let state = axCreateLearningEngineState({ scenario: SCENARIO, processor });
    for (const [id, group] of arrivals) {
      state = feed(
        state,
        interaction(id),
        report(`r-${id}`, [id], {
          score: 0,
          ...(group === undefined ? {} : { feedback: group }),
        })
      ).state;
    }
    return state;
  }

  it('never exceeds batchSize when singletons interleave with an admitted group', () => {
    // A group reserves capacity for ALL of its members when its first member is
    // admitted. Singletons that ignore that reservation let the group's later
    // members — which push unconditionally — carry the batch past batchSize.
    const state = ready(grouped(3), [
      ['g1', 'pair'],
      ['x1', undefined],
      ['x2', undefined],
      ['g2', 'pair'],
    ]);
    const built = axLearningEngineBuildBatch(state, 1);
    expect(built.batch.units).toHaveLength(3);
    expect(built.batch.units.map((unit) => unit.reportId)).toEqual([
      'r-g1',
      'r-x1',
      'r-g2',
    ]);
    // The singleton the reservation displaced is queued for the next batch,
    // never dropped.
    expect(built.state.readyCount).toBe(1);
  });

  it('defers a group that does not fit the capacity singletons already took', () => {
    const state = ready(grouped(3), [
      ['x1', undefined],
      ['x2', undefined],
      ['g1', 'pair'],
      ['g2', 'pair'],
    ]);
    const built = axLearningEngineBuildBatch(state, 1);
    expect(built.batch.units.map((unit) => unit.reportId)).toEqual([
      'r-x1',
      'r-x2',
    ]);
    expect(built.state.readyCount).toBe(2);
    expect(built.state.neverReasons['group-discarded']).toBeUndefined();
  });

  it('refuses to build when nothing is ready', () => {
    expect(() => axLearningEngineBuildBatch(engine(), 1)).toThrow(
      /no ready units/
    );
  });

  it('leaves no empty batch pending when every ready unit is discarded', () => {
    const state = ready(grouped(2), [
      ['a', 'big'],
      ['b', 'big'],
      ['c', 'big'],
    ]);
    const built = axLearningEngineBuildBatch(state, 1);
    expect(built.batch.units).toHaveLength(0);
    expect(built.state.pendingBatchId).toBeUndefined();
    expect(axLearningEngineReady(built.state)).toBe(false);
    expect(built.state.readyCount).toBe(0);
    expect(built.state.neverReasons['group-discarded']).toBe(3);
  });
});

describe('sampleFields withholding on the decision path', () => {
  it('projects the decision unit, not only the built batch', () => {
    const state = axCreateLearningEngineState({
      scenario: SCENARIO,
      processor: axScoreWindowProcessor(),
      sampleFields: ['input'],
    });
    const withInteraction = axLearningEngineIngest(
      state,
      interaction('a')
    ).state;
    const step = axLearningEngineIngest(withInteraction, report('r1', ['a']));
    const decision = step.decisions[0]?.decision;
    expect(decision?.outcome).toBe('train');
    const unit = decision?.outcome === 'train' ? decision.unit : undefined;
    expect(unit?.samples[0]?.payload).toEqual({ input: { question: 'a' } });
    // The per-decision signal is the only per-report signal a host gets. A host
    // tag and the model identity must not reach it either.
    expect(JSON.stringify(decision)).not.toContain('acme');
    expect(JSON.stringify(decision)).not.toContain('gpt-5.6');
    // And the batch hands out exactly the unit the decision announced.
    const { batch } = axLearningEngineBuildBatch(step.state, 1);
    expect(batch.units[0]).toEqual(unit);
  });
});

describe('the parked bound', () => {
  it('evicts the oldest parked report with a named, counted decision', () => {
    const state = feed(
      axCreateLearningEngineState({
        scenario: SCENARIO,
        processor: axScoreWindowProcessor(),
        maxParkedReports: 2,
      }),
      report('r1', ['missing-1']),
      report('r2', ['missing-2'])
    ).state;
    expect(state.waitingCount).toBe(2);

    const step = axLearningEngineIngest(state, report('r3', ['missing-3']));
    expect(step.state.waitingCount).toBe(2);
    expect(step.state.neverReasons['parked-evicted']).toBe(1);
    expect(
      step.decisions.map((entry) => [entry.reportId, entry.decision.outcome])
    ).toEqual([
      ['r3', 'wait'],
      ['r1', 'never'],
    ]);
    const evicted = step.decisions[1]?.decision;
    expect(evicted?.outcome === 'never' ? evicted.reason : undefined).toBe(
      'parked-evicted'
    );

    // The evicted report leaves the waiting index too: its interaction arriving
    // later must not resurrect a report already reported as never.
    const after = axLearningEngineIngest(step.state, interaction('missing-1'));
    expect(after.decisions).toHaveLength(0);
    expect(after.state.waitingCount).toBe(2);
    expect(after.state.readyCount).toBe(0);
  });

  it('never evicts the report it has just accepted', () => {
    const state = axCreateLearningEngineState({
      scenario: SCENARIO,
      processor: axScoreWindowProcessor(),
      maxParkedReports: 1,
    });
    const step = feed(
      state,
      report('r1', ['missing-1']),
      report('r2', ['missing-2'])
    );
    expect(step.state.waitingCount).toBe(1);
    expect(step.state.neverReasons['parked-evicted']).toBe(1);
    // r2 is the survivor: the newest arrival stays parked and the oldest goes.
    const resolved = axLearningEngineIngest(
      step.state,
      interaction('missing-2')
    );
    expect(resolved.decisions[0]?.decision.outcome).toBe('train');
  });

  it('refuses a nonsensical parked bound', () => {
    expect(() =>
      axCreateLearningEngineState({
        scenario: SCENARIO,
        processor: axScoreWindowProcessor(),
        maxParkedReports: 0,
      })
    ).toThrow(/positive safe integer/);
  });
});
