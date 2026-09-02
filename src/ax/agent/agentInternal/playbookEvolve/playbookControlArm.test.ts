import { describe, expect, it } from 'vitest';
import { emptyAccounting } from './accounting.js';
import { canonicalDigest } from './canonical.js';
import {
  bestControlArmOf,
  controlArmComparisonMade,
  controlArmVerdict,
  neutralArtifactFor,
  refinementTaskOf,
  runControlArms,
  SELF_REFINE_INSTRUCTION,
  scoresByTaskIndex,
  weightedMeanOfScores,
} from './controlArm.js';
import {
  buildEvidenceReceipt,
  evidenceReceiptDigest,
  rescindPromotion,
  supersedeEvidenceReceipt,
} from './evidenceReceipt.js';
import type { AxAgentPlaybookControlArmKind } from './playbookEvidenceTypes.js';
import { axIsAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import {
  captureSnapshot,
  snapshotStateOf,
  withRestoredArtifact,
} from './snapshots.js';

// ---------------------------------------------------------------------------
// The baseline/evolved snapshot state machine (RFC 7.1, phases 0 / 7 / 9)
// ---------------------------------------------------------------------------

type FakeState = {
  playbook: { bullets: string[] };
  artifact: { epoch: number };
};

function fakeHandle(initial: FakeState) {
  let state: FakeState = structuredClone(initial);
  const loads: FakeState[] = [];
  let failLoads = 0;
  /** Restores are silently partial: `load` writes something else entirely. */
  let partialLoad: FakeState | undefined;
  let partialLoadsLeft = 0;
  return {
    loads,
    getState: () => structuredClone(state) as any,
    load: (snapshot: any) => {
      loads.push(structuredClone(snapshot));
      if (failLoads > 0) {
        failLoads--;
        throw new Error('load exploded');
      }
      const corrupted = partialLoadsLeft > 0 ? partialLoad : undefined;
      if (partialLoadsLeft > 0) partialLoadsLeft--;
      state = structuredClone(corrupted ?? snapshot);
    },
    mutate: (next: FakeState) => {
      state = structuredClone(next);
    },
    failNextLoads: (count: number) => {
      failLoads = count;
    },
    /** The NEXT load lands somewhere else entirely: a silent partial restore. */
    corruptNextLoad: (next: FakeState) => {
      partialLoad = next;
      partialLoadsLeft = 1;
    },
    /** The next `count` loads all land somewhere else. */
    corruptNextLoads: (count: number, next: FakeState) => {
      partialLoad = next;
      partialLoadsLeft = count;
    },
    current: () => structuredClone(state),
  };
}

const BASELINE: FakeState = {
  playbook: { bullets: [] },
  artifact: { epoch: 0 },
};
const EVOLVED: FakeState = {
  playbook: { bullets: ['b1'] },
  artifact: { epoch: 1 },
};

describe('playbook evolve snapshot state machine', () => {
  it('captures a state without throwing when the handle cannot produce one', () => {
    expect(captureSnapshot(undefined)).toBeUndefined();
    expect(
      captureSnapshot({
        getState: () => {
          throw new Error('no state');
        },
      })
    ).toBeUndefined();
    const handle = fakeHandle(BASELINE);
    expect(captureSnapshot(handle)).toEqual(BASELINE);
  });

  it('runs the body on the restored baseline and returns to the evolved state', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);
    expect(baseline.digest).not.toBe(evolved.digest);

    let observedInsideBody: string | undefined;
    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        observedInsideBody = canonicalDigest(handle.getState());
        return 'arm-ran';
      },
    });

    expect(observedInsideBody).toBe(baseline.digest);
    expect(outcome.status).toBe('ran');
    expect(outcome.status === 'ran' && outcome.value).toBe('arm-ran');
    // The SEQUENCE matters: asserting only "the body saw the baseline" would
    // pass on an implementation that never puts the evolved state back.
    expect(handle.loads).toEqual([BASELINE, EVOLVED]);
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('returns to the evolved state even when the body throws', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    await expect(
      withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          throw new Error('arm blew up');
        },
      })
    ).rejects.toThrow('arm blew up');
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('leaves the evolved artifact intact and skips the body when the baseline restore throws', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    handle.failNextLoads(1);
    let bodyRan = false;
    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        bodyRan = true;
      },
    });

    expect(bodyRan).toBe(false);
    expect(outcome.status).toBe('restore_failed');
    expect(outcome.status === 'restore_failed' && outcome.reason).toContain(
      'load exploded'
    );
    // `load` is atomic from the caller's view, so the run continues with the
    // evolved artifact still live.
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('treats a digest mismatch as a restore failure and still returns to the evolved state', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    // A silent partial restore is the failure the digest assertion exists for:
    // every arm number would be meaningless while the run looked healthy.
    handle.corruptNextLoad({
      playbook: { bullets: ['leftover'] },
      artifact: { epoch: 9 },
    });
    let bodyRan = false;
    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        bodyRan = true;
      },
    });

    expect(bodyRan).toBe(false);
    expect(outcome.status).toBe('restore_failed');
    expect(outcome.status === 'restore_failed' && outcome.reason).toContain(
      'the restore was partial'
    );
    // The artifact WAS mutated by the partial load, so the return restore runs
    // before the failure is reported — leaving the evolved artifact live.
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('retries the evolved restore once before giving up', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        handle.failNextLoads(1);
        return 'ok';
      },
    });

    expect(outcome.status).toBe('ran');
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
    // baseline restore + failed evolved restore + successful retry
    expect(handle.loads).toHaveLength(3);
  });

  it('throws control_arm_failed naming both digests and carrying the evolved snapshot when the restore fails twice', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    let thrown: unknown;
    try {
      await withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          handle.failNextLoads(2);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(axIsAgentPlaybookEvolveError(thrown)).toBe(true);
    const error = thrown as any;
    expect(error.code).toBe('control_arm_failed');
    expect(error.phase).toBe('control_arm');
    expect(error.message).toContain('AxAgent.playbook().evolve(): ');
    // Both digests are named because the agent is left in an indeterminate
    // state relative to what the run reports.
    expect(error.message).toContain(baseline.digest);
    expect(error.message).toContain(evolved.digest);
    // A thrown run has no result, so the recovery snapshot rides on the error.
    expect(error.playbookSnapshot).toEqual(EVOLVED);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect((error.cause as AggregateError).errors).toHaveLength(2);
  });

  it('retries when the RETURN restore lands somewhere else and verifies the evolved digest', async () => {
    // The evolved-side assertion is the one that matters most: a silent partial
    // restore here leaves the live agent holding something other than what the
    // run reports, and the run then says `applied: 'live'` over it. An
    // implementation that digests the TARGET instead of the handle would see no
    // mismatch at all and stop after a single load.
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    const outcome = await withRestoredArtifact({
      handle,
      restoreTo: baseline,
      returnTo: evolved,
      run: async () => {
        handle.corruptNextLoad({
          playbook: { bullets: ['b1', 'stowaway'] },
          artifact: { epoch: 1 },
        });
        return 'ok';
      },
    });

    expect(outcome.status).toBe('ran');
    // baseline restore + the partial evolved restore + the verified retry.
    expect(handle.loads).toHaveLength(3);
    expect(handle.loads[2]).toEqual(EVOLVED);
    expect(canonicalDigest(handle.current())).toBe(evolved.digest);
  });

  it('throws control_arm_failed when the RETURN restore is partial twice', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);
    const stowaway: FakeState = {
      playbook: { bullets: ['b1', 'stowaway'] },
      artifact: { epoch: 1 },
    };

    let thrown: unknown;
    try {
      await withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          handle.corruptNextLoads(2, stowaway);
        },
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as any;
    expect(axIsAgentPlaybookEvolveError(thrown)).toBe(true);
    expect(error.code).toBe('control_arm_failed');
    expect(error.message).toContain(baseline.digest);
    expect(error.message).toContain(evolved.digest);
    // The recovery snapshot rides on the error: the live artifact is neither
    // the baseline nor the evolved state the result would have described.
    expect(error.playbookSnapshot).toEqual(EVOLVED);
    expect((error.cause as AggregateError).errors).toHaveLength(2);
    for (const cause of (error.cause as AggregateError).errors) {
      expect((cause as Error).message).toContain('the restore was partial');
      expect((cause as Error).message).toContain('evolved');
    }
    expect(canonicalDigest(handle.current())).not.toBe(evolved.digest);
  });

  it('aggregates the body failure with the restore failures', async () => {
    const handle = fakeHandle(BASELINE);
    const baseline = snapshotStateOf(captureSnapshot(handle)!);
    handle.mutate(EVOLVED);
    const evolved = snapshotStateOf(captureSnapshot(handle)!);

    let thrown: unknown;
    try {
      await withRestoredArtifact({
        handle,
        restoreTo: baseline,
        returnTo: evolved,
        run: async () => {
          handle.failNextLoads(2);
          throw new Error('arm blew up');
        },
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as any;
    expect(error.code).toBe('control_arm_failed');
    expect((error.cause as AggregateError).errors).toHaveLength(3);
    expect(
      ((error.cause as AggregateError).errors[0] as Error).message
    ).toContain('arm blew up');
  });
});

// ---------------------------------------------------------------------------
// Neutral artifact, refinement derivation, alignment (RFC 4.3, 7.6)
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-01-01T00:00:00.000Z';

describe('neutralArtifactFor', () => {
  it.each([80, 200, 640, 1_500])(
    'renders within 5%% of a %i-token target',
    (target) => {
      const neutral = neutralArtifactFor({
        targetTokens: target,
        nowIso: NOW_ISO,
      });
      // The SIZE match is what makes the ablation an ablation: an artifact that
      // is merely "some other text" confounds content with length, which is the
      // confound this arm exists to remove.
      expect(neutral.withinTolerance).toBe(true);
      expect(Math.abs(neutral.renderedTokens - target)).toBeLessThanOrEqual(
        Math.max(1, target * 0.05)
      );
    }
  );

  it('is content-free and deterministic', () => {
    const a = neutralArtifactFor({ targetTokens: 300, nowIso: NOW_ISO });
    const b = neutralArtifactFor({ targetTokens: 300, nowIso: NOW_ISO });
    expect(a.digest).toBe(b.digest);
    expect(a.text).toBe(b.text);
    // No task guidance of any kind: a gain it reproduces belongs to the slot.
    expect(a.text).toContain('intentionally free of task guidance');
    expect(a.text.toLowerCase()).not.toContain('answer');
  });

  it('uses caller text verbatim and reports whether it matched the target', () => {
    const neutral = neutralArtifactFor({
      targetTokens: 400,
      nowIso: NOW_ISO,
      text: 'short',
    });
    expect(neutral.text).toBe('short');
    // A caller who names the artifact owns its size; the receipt records the
    // mismatch rather than silently padding over it.
    expect(neutral.withinTolerance).toBe(false);
    expect(neutral.renderedTokens).toBeLessThan(400);
  });
});

describe('refinementTaskOf', () => {
  const task = {
    input: { question: 'what is 2+2?', attempts: 1 },
    criteria: 'correct',
    id: 't1',
    weight: 2,
  };

  it('appends the previous answer and the fixed critique to a string input field', () => {
    const refined = refinementTaskOf({
      task,
      previousAnswer: { answer: 'five' },
      round: 2,
    });
    expect(refined).toBeDefined();
    const question = (refined as any).input.question as string;
    // A NEW key would be silently dropped by the signature renderer, so the
    // "refinement" would never reach the model at all.
    expect(question.startsWith('what is 2+2?')).toBe(true);
    expect(question).toContain('self-refinement round 2');
    expect(question).toContain('five');
    expect(question).toContain(SELF_REFINE_INSTRUCTION);
    // Everything else about the task is preserved, so weights and ids still
    // line up with the split.
    expect((refined as any).input.attempts).toBe(1);
    expect(refined?.weight).toBe(2);
    expect(refined?.id).toBe('t1');
  });

  it('carries the critique on the FIRST string field and leaves the rest alone', () => {
    // The rule is positional, not heuristic: a signature's first declared input
    // is the one a caller writes the question into, and a heuristic that picked
    // a different field on a different task shape would make the arm impossible
    // to reproduce.
    const refined = refinementTaskOf({
      task: {
        input: { context: 'ctx', question: 'q1', k: 3, notes: 'n' },
        criteria: 'c',
        id: 't',
      } as any,
      previousAnswer: 'prev',
      round: 2,
    })!;
    expect((refined.input as any).context).toContain('ctx');
    expect((refined.input as any).context).toContain(SELF_REFINE_INSTRUCTION);
    expect((refined.input as any).question).toBe('q1');
    expect((refined.input as any).notes).toBe('n');
    expect((refined.input as any).k).toBe(3);
  });

  it('returns undefined when no input field can carry a critique', () => {
    expect(
      refinementTaskOf({
        task: { input: { count: 3 }, criteria: 'c' },
        previousAnswer: 'x',
        round: 1,
      })
    ).toBeUndefined();
    expect(
      refinementTaskOf({
        task: { input: 'plain' as any, criteria: 'c' },
        previousAnswer: 'x',
        round: 1,
      })
    ).toBeUndefined();
  });
});

describe('scoresByTaskIndex / weightedMeanOfScores', () => {
  const tasks = [
    { input: { q: 'a' }, criteria: 'c', id: 'a', weight: 3 },
    { input: { q: 'b' }, criteria: 'c', id: 'b', weight: 1 },
    { input: { q: 'c' }, criteria: 'c', id: 'c' },
  ];

  it('aligns records to split positions and leaves unscored tasks undefined', () => {
    const batch = {
      records: [
        { task: tasks[2], score: 0.5, passed: false },
        { task: tasks[0], score: 1, passed: true },
      ],
    } as any;
    expect(scoresByTaskIndex(batch, tasks as any)).toEqual([1, undefined, 0.5]);
  });

  it('weights the mean by task weight and never averages over a prefix', () => {
    // 3*1 + 1*0 + 1*0.5 over weight 5.
    expect(weightedMeanOfScores([1, 0, 0.5], tasks as any)).toBeCloseTo(
      0.7,
      10
    );
    // An unscored task leaves the denominator entirely rather than scoring 0.
    expect(weightedMeanOfScores([1, undefined, undefined], tasks as any)).toBe(
      1
    );
    expect(
      weightedMeanOfScores([undefined, undefined, undefined], tasks as any)
    ).toBe(0);
  });
});

describe('controlArmVerdict', () => {
  const interval = (direction: 'positive' | 'negative' | 'unresolved') => ({
    point: 0.1,
    lower: -0.1,
    upper: 0.3,
    level: 0.95,
    resamples: 200,
    unit: 'task' as const,
    clusters: 3,
    seed: 1,
    direction,
  });
  const arm = (overrides: Record<string, unknown> = {}) =>
    ({
      kind: 'best_of_n',
      n: 2,
      selector: 'metric',
      heldOut: {
        mean: 0.5,
        executedRuns: 3,
        discardedRuns: 0,
        expectedRuns: 3,
        complete: true,
        ...((overrides.heldOut as object) ?? {}),
      },
      accounting: emptyAccounting(),
    }) as any;
  const completed = (
    advantage: number,
    direction: any,
    overrides: Record<string, unknown> = {}
  ) =>
    ({
      status: 'completed',
      matchedBudget: emptyAccounting(),
      budgetBasis: 'evolve_total',
      arms: [arm(overrides)],
      best: { kind: 'best_of_n', split: 'heldOut', mean: 0.5 },
      evolvedAdvantage: advantage,
      interval: {
        ...interval(direction),
        ...((overrides.interval as object) ?? {}),
      },
      heldOutSelectionComparisons: 1,
      accounting: emptyAccounting(),
    }) as any;

  it('fails closed on an arm that did not run or failed', () => {
    // A required gate reading an absent arm must not pass: that is exactly the
    // silent-absence failure the control arm exists to remove.
    expect(
      controlArmVerdict({
        margin: 0,
        report: { status: 'not_run', reason: 'not configured' },
      }).passed
    ).toBe(false);
    expect(
      controlArmVerdict({
        margin: 0,
        report: {
          status: 'failed',
          reason: 'threw',
          accounting: emptyAccounting(),
        },
      }).passed
    ).toBe(false);
  });

  it('requires both the margin and a non-negative interval', () => {
    expect(
      controlArmVerdict({
        margin: 0.05,
        report: completed(0.2, 'positive'),
      }).passed
    ).toBe(true);
    expect(
      controlArmVerdict({
        margin: 0.05,
        report: completed(0.01, 'positive'),
      }).passed
    ).toBe(false);
    // An interval that excludes zero on the WRONG side is a loss, whatever the
    // point estimate says.
    expect(
      controlArmVerdict({
        margin: 0,
        report: completed(0.2, 'negative'),
      }).passed
    ).toBe(false);
    expect(
      controlArmVerdict({
        margin: 0,
        report: completed(0.2, 'unresolved'),
      }).passed
    ).toBe(true);
  });

  it('fails closed on a report whose best arm measured nothing', () => {
    // The failure this branch exists for: `weightedMeanOfScores` of nothing is
    // 0, so an arm that scored no task reports the WORST possible mean and the
    // run claims its whole held-out score as an advantage. Fail-open in the
    // direction that favours the evolved artifact is worse than no gate.
    const noArmResult = controlArmVerdict({
      margin: 0.1,
      report: {
        ...completed(1, 'unresolved'),
        arms: [],
      } as any,
    });
    expect(noArmResult.passed).toBe(false);
    expect(noArmResult.detail).toContain('carries no result for it');

    const incomplete = controlArmVerdict({
      margin: 0.1,
      report: completed(1, 'unresolved', {
        heldOut: { complete: false, executedRuns: 0, expectedRuns: 3 },
      }),
    });
    expect(incomplete.passed).toBe(false);
    expect(incomplete.detail).toContain('incomplete');
    expect(incomplete.detail).toContain('0/3');
  });

  it('fails closed when the advantage carries no computed interval', () => {
    // A fabricated zero-width interval is shaped exactly like a real paired
    // bootstrap, and `direction: 'unresolved'` satisfies `!== 'negative'`.
    const fabricated = controlArmVerdict({
      margin: 0.1,
      report: completed(1, 'unresolved', {
        interval: { clusters: 0, resamples: 0, lower: 1, upper: 1, point: 1 },
      }),
    });
    expect(fabricated.passed).toBe(false);
    expect(fabricated.detail).toContain('could not be computed');
    // Resamples alone is enough: an interval nobody resampled is not one.
    expect(
      controlArmVerdict({
        margin: 0.1,
        report: completed(1, 'unresolved', {
          interval: { resamples: 0 },
        }),
      }).passed
    ).toBe(false);
  });

  it('separates "no comparison" from "the arm was not beaten"', () => {
    // The warning code is picked from this, so a run whose arm THREW is never
    // reported under a code asserting that a comparison happened.
    expect(
      controlArmComparisonMade({ status: 'not_run', reason: 'x' } as any)
    ).toBe(false);
    expect(
      controlArmComparisonMade({
        status: 'failed',
        reason: 'threw',
        accounting: emptyAccounting(),
      } as any)
    ).toBe(false);
    expect(
      controlArmComparisonMade(
        completed(1, 'unresolved', { interval: { clusters: 0 } })
      )
    ).toBe(false);
    expect(controlArmComparisonMade(completed(0.2, 'positive'))).toBe(true);
  });

  it('names the best arm and the margin in the detail', () => {
    const detail = controlArmVerdict({
      margin: 0.05,
      report: completed(0.01, 'positive'),
    }).detail;
    expect(detail).toContain('best_of_n');
    expect(detail).toContain('0.05');
  });
});

// ---------------------------------------------------------------------------
// runControlArms — the module's core loop (RFC 4.3, 7.6, 8.6)
// ---------------------------------------------------------------------------

const ARM_TASKS = [
  { input: { question: 'q1' }, criteria: 'c', id: 't1' },
  { input: { question: 'q2' }, criteria: 'c', id: 't2' },
];

type ArmPass = readonly (number | undefined)[];

/**
 * A scripted `AxControlArmEvaluate`: no agent, no model, no metric. Every pass
 * returns exactly the per-task scores the test dictates, so the SELECTION rule
 * (max across best-of-N samples, last round for self-refinement) is observable
 * on its own rather than only through a fixture where every sample ties.
 */
function scriptedArms(args: {
  arms: AxAgentPlaybookControlArmKind[];
  passes: readonly ArmPass[];
  matched: number;
  tasks?: readonly any[];
  runsPerTask?: number;
  options?: Record<string, unknown>;
  evolvedRenderedTokens?: number;
  abortSignal?: AbortSignal;
  onPass?: (index: number) => void;
}) {
  const tasks = (args.tasks ?? ARM_TASKS) as any[];
  const runsPerTask = args.runsPerTask ?? 1;
  const calls: { phase: string; tasks: any[]; spent: number }[] = [];
  const artifactLoads: string[] = [];
  let pass = 0;
  let clock = 0;
  const evaluate = async (evalArgs: any) => {
    const scores = args.passes[pass] ?? [];
    args.onPass?.(pass);
    pass++;
    const cost = evalArgs.tasks.length * runsPerTask;
    evalArgs.budget.remaining -= cost;
    calls.push({
      phase: evalArgs.phase,
      tasks: [...evalArgs.tasks],
      spent: cost,
    });
    const records = evalArgs.tasks.flatMap((task: any, index: number) => {
      const score = scores[index];
      return score === undefined
        ? []
        : [
            {
              task,
              score,
              passed: score >= 1,
              prediction: { output: { answer: `answer-${index}-p${pass}` } },
            },
          ];
    });
    return {
      records,
      mean: 0,
      exhausted: false,
      executedRuns: cost,
      discardedRuns: cost - records.length,
      expectedRuns: cost,
      validEvidence: true,
      complete: records.length === evalArgs.tasks.length,
      durationMs: 1,
      usage: [],
    } as any;
  };
  const ctx = {
    arms: args.arms,
    tasks,
    runsPerTask,
    matched: args.matched,
    options: (args.options ?? {}) as any,
    evolvedRenderedTokens: args.evolvedRenderedTokens ?? 120,
    nowIso: NOW_ISO,
    now: () => {
      clock += 5;
      return clock;
    },
    usesBuiltInJudge: false,
    evaluate,
    loadNeutralArtifact: () => artifactLoads.push('neutral'),
    restoreUnevolvedArtifact: () => artifactLoads.push('baseline'),
    progress: () => {},
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  } as any;
  return { ctx, calls, artifactLoads };
}

describe('runControlArms', () => {
  it('selects the per-task MAXIMUM across best-of-N samples', async () => {
    // Oracle-strong selection (§4.3): the scoring metric picks the sample, so
    // the control is stronger than anything deployable and the evolved
    // artifact's claim gets harder. A `min` or last-write-wins implementation
    // is indistinguishable in any fixture where every sample ties.
    const { ctx, calls } = scriptedArms({
      arms: ['best_of_n'],
      matched: 6,
      passes: [
        [0.1, 0.9],
        [0.8, 0.2],
        [0.4, 0.5],
      ],
    });
    const { runs, skipped } = await runControlArms(ctx);
    expect(skipped).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(runs[0]!.scores).toEqual([0.8, 0.9]);
    expect(runs[0]!.result.heldOut.mean).toBeCloseTo(0.85, 10);
    expect(runs[0]!.result.heldOut.complete).toBe(true);
    expect(runs[0]!.result.n).toBe(3);
  });

  it('keeps the LAST refinement round, not the best one', async () => {
    // A self-refinement arm reports the final answer, however it moved. Taking
    // the max here would silently turn it into a second best-of-N.
    const { ctx, calls } = scriptedArms({
      arms: ['self_refine'],
      matched: 6,
      passes: [
        [0.9, 0.9],
        [0.5, 0.5],
        [0.2, 0.7],
      ],
    });
    const { runs, skipped } = await runControlArms(ctx);
    expect(skipped).toEqual([]);
    expect(runs[0]!.scores).toEqual([0.2, 0.7]);
    // Two rounds re-invoked the program on top of the initial sample.
    expect(runs[0]!.result.n).toBe(2);
    expect(calls).toHaveLength(3);
    // The agent sees its own previous answer plus the fixed critique; the
    // metric keeps scoring the original example.
    const roundOne = calls[1]!.tasks[0]!.input.question as string;
    expect(roundOne).toContain('q1');
    expect(roundOne).toContain('answer-0-p1');
    expect(roundOne).toContain(SELF_REFINE_INSTRUCTION);
    expect(calls[2]!.tasks[0]!.input.question).toContain('answer-0-p2');
  });

  it('stops drawing samples when the arm budget cannot cover another pass', async () => {
    // The reported `n` must be what the arm DREW. Reporting the planned figure
    // overstates the control the evolved artifact was compared against, which
    // biases the comparison towards accepting the artifact.
    const { ctx, calls } = scriptedArms({
      arms: ['best_of_n'],
      matched: 5,
      options: { bestOfN: 4 },
      passes: [
        [0.3, 0.3],
        [0.4, 0.4],
        [0.9, 0.9],
      ],
    });
    const { runs } = await runControlArms(ctx);
    // armBudget 5, one pass over the 2-task split costs 2: two passes fit.
    expect(calls).toHaveLength(2);
    expect(runs[0]!.result.n).toBe(2);
    expect(runs[0]!.result.accounting.metricCalls).toBe(4);
    expect(runs[0]!.scores).toEqual([0.4, 0.4]);
  });

  it('reports zero refinement rounds rather than the round it could not afford', async () => {
    const { ctx, calls } = scriptedArms({
      arms: ['self_refine'],
      matched: 3,
      passes: [[0.6, 0.6]],
    });
    const { runs } = await runControlArms(ctx);
    // armBudget 3 covers the initial 2-call pass, leaving 1 — not a round.
    expect(calls).toHaveLength(1);
    expect(runs[0]!.result.n).toBe(0);
    expect(runs[0]!.scores).toEqual([0.6, 0.6]);
  });

  it('reports an arm that scored nothing as skipped, never as a mean of zero', async () => {
    // The fail-open this branch removes: a weighted mean over no scored task is
    // 0, the WORST possible score, so an arm wiped out by a provider outage
    // would be reported as a control the evolved artifact beat by its entire
    // held-out mean — and a required gate would pass on it.
    const { ctx } = scriptedArms({
      arms: ['best_of_n', 'harness_term'],
      matched: 8,
      passes: [
        [undefined, undefined],
        [undefined, undefined],
        [0.4, 0.4],
      ],
    });
    const { runs, skipped } = await runControlArms(ctx);
    expect(runs.map((run) => run.result.kind)).toEqual(['harness_term']);
    expect(skipped).toEqual([
      {
        kind: 'best_of_n',
        reason: expect.stringContaining('measured nothing'),
      },
    ]);
  });

  it('drives the verdict off a best_of_n winner', async () => {
    // Every integration fixture in this repo has `harness_term` winning, so the
    // non-plumbing branch of the comparison needs its own test.
    const { ctx } = scriptedArms({
      arms: ['best_of_n', 'harness_term'],
      matched: 8,
      passes: [
        [0.9, 0.7],
        [0.6, 0.9],
        [0.2, 0.2],
      ],
    });
    const { runs } = await runControlArms(ctx);
    const best = bestControlArmOf(runs);
    expect(best.result.kind).toBe('best_of_n');
    expect(best.result.heldOut.mean).toBeCloseTo(0.9, 10);
    // The evolved artifact scored 0.95 on the same split: a +0.05 advantage
    // that does not clear a 0.1 margin, so the run is rejected.
    const report = {
      status: 'completed',
      matchedBudget: emptyAccounting(),
      budgetBasis: 'evolve_total',
      arms: runs.map((run) => run.result),
      best: {
        kind: best.result.kind,
        split: 'heldOut',
        mean: best.result.heldOut.mean,
      },
      evolvedAdvantage: 0.05,
      interval: {
        point: 0.05,
        lower: -0.02,
        upper: 0.12,
        level: 0.95,
        resamples: 200,
        unit: 'task',
        clusters: 2,
        seed: 7,
        direction: 'unresolved',
      },
      heldOutSelectionComparisons: 1,
      accounting: emptyAccounting(),
    } as any;
    const verdict = controlArmVerdict({ margin: 0.1, report });
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain("best arm 'best_of_n'");
    expect(controlArmVerdict({ margin: 0.04, report }).passed).toBe(true);
  });

  it('puts the unevolved artifact back after the neutral one, always', async () => {
    const { ctx, artifactLoads } = scriptedArms({
      arms: ['harness_term'],
      matched: 4,
      passes: [[0.3, 0.4]],
    });
    const { runs } = await runControlArms(ctx);
    expect(artifactLoads).toEqual(['neutral', 'baseline']);
    expect(runs[0]!.result.n).toBe(1);
    expect(runs[0]!.result.neutralArtifactTokens).toBeGreaterThan(0);
    expect(runs[0]!.result.neutralArtifactDigest).toBeDefined();
  });

  it('skips an arm the matched budget cannot cover and names the shortfall', async () => {
    const { ctx, calls } = scriptedArms({
      arms: ['best_of_n', 'self_refine'],
      matched: 3,
      passes: [[0.5, 0.5]],
    });
    const { runs, skipped } = await runControlArms(ctx);
    // floor(3/2) = 1 call per arm; one pass over the 2-task split costs 2.
    expect(runs).toEqual([]);
    expect(calls).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toContain('matched budget');
  });

  it('checks the abort signal between samples, not only between arms', async () => {
    const controller = new AbortController();
    const { ctx, calls } = scriptedArms({
      arms: ['best_of_n'],
      matched: 8,
      abortSignal: controller.signal,
      passes: [
        [0.3, 0.3],
        [0.4, 0.4],
        [0.5, 0.5],
        [0.6, 0.6],
      ],
      onPass: (index) => {
        if (index === 0) controller.abort();
      },
    });
    await expect(runControlArms(ctx)).rejects.toThrow('aborted');
    // One pass completed before the abort landed; the second never started.
    expect(calls).toHaveLength(1);
  });

  it('reports the arm as unable to run when no task can carry a critique', async () => {
    const { ctx } = scriptedArms({
      arms: ['self_refine'],
      matched: 6,
      tasks: [
        { input: { count: 1 }, criteria: 'c', id: 'n1' },
        { input: { count: 2 }, criteria: 'c', id: 'n2' },
      ],
      passes: [[0.5, 0.5]],
    });
    const { runs, skipped } = await runControlArms(ctx);
    expect(runs).toEqual([]);
    expect(skipped[0]!.reason).toContain('string input field');
  });
});

// ---------------------------------------------------------------------------
// The I8 status cascade (RFC 4.9, 6)
// ---------------------------------------------------------------------------

describe('run-level rollback status cascade', () => {
  const nomination = {
    candidateDigest: 'fnv1a64:0000000000000001',
    splitDigests: { current: 'c', slices: [] },
    splitDigestBasis: 'task_ids' as const,
    promotionDigest: 'fnv1a64:0000000000000002',
    resourceId: 'playbook-1',
    gatesPassed: [],
    gatesFailed: [],
    nominated: true,
  };
  const receipt = () =>
    buildEvidenceReceipt({
      kind: 'curate',
      nomination,
      intervals: {
        current: {
          point: 0.2,
          lower: 0.1,
          upper: 0.3,
          level: 0.95,
          resamples: 200,
          unit: 'task',
          clusters: 2,
          seed: 1,
          direction: 'positive',
        },
      },
      reach: {
        basis: 'rendered_only',
        counterfactual: true,
        gateEligible: false,
        splits: [],
      },
      validity: { predicates: [], required: [] },
      termination: {
        splits: [],
        worstDiscardRate: 0,
        incompleteFromEnvironmentFailures: false,
      },
      gates: { entries: [] },
      promotion: {
        status: 'promoted',
        nomination,
        receipt: { receiptId: 'r1' } as any,
        vetoes: [],
      },
      accounting: emptyAccounting(),
      selectionComparisons: 1,
      level: 0.95,
      warnings: [],
      decision: 'accepted',
    });

  it('rescinds a live promotion and keeps its receipt', () => {
    const rescinded = rescindPromotion(
      {
        status: 'promoted',
        nomination,
        receipt: { receiptId: 'r1' } as any,
        vetoes: [],
      },
      { gate: 'control_arm', reason: 'the arm reproduced the gain' }
    );
    expect(rescinded.status).toBe('promoted_then_rolled_back');
    // Ax cannot revoke a receipt — axAuthorize exposes no revoke path — so the
    // honest report is "issued, then superseded".
    expect((rescinded as any).receipt.receiptId).toBe('r1');
    expect((rescinded as any).rolledBackByGate).toBe('control_arm');
    expect((rescinded as any).rolledBackReason).toContain('reproduced');
  });

  it.each([['not_required'], ['not_nominated']])(
    'leaves a %s promotion untouched',
    (status) => {
      // A candidate that was never promoted has nothing to rescind; inventing a
      // rollback status for it would report a promotion that never happened.
      const promotion = { status, nomination } as any;
      expect(
        rescindPromotion(promotion, { gate: 'control_arm', reason: 'x' })
      ).toBe(promotion);
    }
  );

  it('supersedes an accepted receipt, rescinds its promotion, and re-digests', () => {
    const accepted = receipt();
    const superseded = supersedeEvidenceReceipt(accepted, {
      gate: 'control_arm',
      reason: 'best_of_n reproduced the gain',
    });
    expect(accepted.decision).toBe('accepted');
    expect(superseded.decision).toBe('superseded');
    expect(superseded.promotion.status).toBe('promoted_then_rolled_back');
    expect(
      superseded.warnings.some((w) => w.code === 'promotion_rolled_back')
    ).toBe(true);
    // The digest covers the decision, so a superseded receipt can never be
    // mistaken for the accepted one it replaced.
    expect(superseded.digest).not.toBe(accepted.digest);
    expect(evidenceReceiptDigest(superseded)).toBe(superseded.digest);
    expect(Object.isFrozen(superseded)).toBe(true);
    // The original is untouched: receipts are frozen, so this rebuilds.
    expect(accepted.promotion.status).toBe('promoted');
  });
});
