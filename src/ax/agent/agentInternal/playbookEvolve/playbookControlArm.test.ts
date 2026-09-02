import { describe, expect, it } from 'vitest';
import { emptyAccounting } from './accounting.js';
import { canonicalDigest } from './canonical.js';
import {
  controlArmVerdict,
  neutralArtifactFor,
  refinementTaskOf,
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
  return {
    loads,
    getState: () => structuredClone(state) as any,
    load: (snapshot: any) => {
      loads.push(structuredClone(snapshot));
      if (failLoads > 0) {
        failLoads--;
        throw new Error('load exploded');
      }
      const corrupted = partialLoad;
      partialLoad = undefined;
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
  const completed = (advantage: number, direction: any) =>
    ({
      status: 'completed',
      matchedBudget: emptyAccounting(),
      budgetBasis: 'evolve_total',
      arms: [],
      best: { kind: 'best_of_n', split: 'heldOut', mean: 0.5 },
      evolvedAdvantage: advantage,
      interval: interval(direction),
      heldOutSelectionComparisons: 1,
      accounting: emptyAccounting(),
    }) as any;

  it('fails closed on an arm that did not run or failed', () => {
    // A required gate reading an absent arm must not pass: that is exactly the
    // silent-absence failure the control arm exists to remove.
    expect(
      controlArmVerdict({
        mode: 'require',
        margin: 0,
        report: { status: 'not_run', reason: 'not configured' },
      }).passed
    ).toBe(false);
    expect(
      controlArmVerdict({
        mode: 'require',
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
        mode: 'require',
        margin: 0.05,
        report: completed(0.2, 'positive'),
      }).passed
    ).toBe(true);
    expect(
      controlArmVerdict({
        mode: 'require',
        margin: 0.05,
        report: completed(0.01, 'positive'),
      }).passed
    ).toBe(false);
    // An interval that excludes zero on the WRONG side is a loss, whatever the
    // point estimate says.
    expect(
      controlArmVerdict({
        mode: 'require',
        margin: 0,
        report: completed(0.2, 'negative'),
      }).passed
    ).toBe(false);
    expect(
      controlArmVerdict({
        mode: 'require',
        margin: 0,
        report: completed(0.2, 'unresolved'),
      }).passed
    ).toBe(true);
  });

  it('names the best arm and the margin in the detail', () => {
    const detail = controlArmVerdict({
      mode: 'require',
      margin: 0.05,
      report: completed(0.01, 'positive'),
    }).detail;
    expect(detail).toContain('best_of_n');
    expect(detail).toContain('0.05');
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
