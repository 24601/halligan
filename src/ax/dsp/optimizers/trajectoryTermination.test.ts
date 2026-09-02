import { describe, expect, it } from 'vitest';

import type {
  AxTrajectoryTermination,
  AxTrajectoryTerminationClassifier,
  AxTrajectoryTerminationInput,
} from './trajectoryTermination.js';
import {
  axClassifyTrajectory,
  axDefaultTrajectoryTermination,
  axExceedsRunDiscardCeiling,
  axMergeTrajectoryAdmission,
  axPairedAdmittedIndices,
  axResolveTrajectoryAdmissionOptions,
  axSummarizeTrajectoryAdmission,
} from './trajectoryTermination.js';

const row = (
  overrides: Partial<AxTrajectoryTerminationInput> = {}
): AxTrajectoryTerminationInput => ({
  phase: 'child minibatch',
  exampleIndex: 0,
  nonReclassifiable: false,
  ...overrides,
});

/** A host classifier that calls every failure an environment failure. */
const alwaysEnvironment: AxTrajectoryTerminationClassifier = (input) =>
  input.error === undefined
    ? { kind: 'completed' }
    : { kind: 'environment_failure', cause: 'rate_limit' };

const terminations = (
  admitted: number,
  discarded: number,
  cause: 'rate_limit' | 'timeout' = 'rate_limit'
): AxTrajectoryTermination[] => [
  ...Array.from({ length: admitted }, () => ({ kind: 'completed' }) as const),
  ...Array.from(
    { length: discarded },
    () => ({ kind: 'environment_failure', cause }) as const
  ),
];

describe('axDefaultTrajectoryTermination', () => {
  it('classifies every failure as a policy failure', () => {
    // This is today's behaviour verbatim: a failed rollout scores zero and the
    // zero counts against the candidate. Anything else here would make the
    // opt-in path change legacy scoring.
    expect(axDefaultTrajectoryTermination(row())).toEqual({
      kind: 'completed',
    });
    expect(
      axDefaultTrajectoryTermination(
        row({ error: 'Rate limit exceeded', failureKind: 'runtime' })
      )
    ).toEqual({ kind: 'policy_failure' });
    expect(
      axDefaultTrajectoryTermination(
        row({ error: 'adapter blew up', failureKind: 'adapter' })
      )
    ).toEqual({ kind: 'policy_failure' });
    // The default must never be able to remove a row from the denominator.
    for (const input of [
      row(),
      row({ error: 'boom' }),
      row({ failureKind: 'validator' }),
      row({ error: '429', candidateKinds: ['program-source'] }),
    ]) {
      expect(axDefaultTrajectoryTermination(input).kind).not.toBe(
        'environment_failure'
      );
    }
  });
});

describe('axClassifyTrajectory', () => {
  it('refuses to launder a config error as an environment failure', () => {
    // A `validateConfig` failure IS the candidate's fault. Ax marks the row
    // non-reclassifiable and the host cannot clear it.
    const result = axClassifyTrajectory(
      alwaysEnvironment,
      row({
        error: 'component value failed validation',
        failureKind: 'validator',
        nonReclassifiable: true,
      })
    );
    expect(result.termination).toEqual({
      kind: 'policy_failure',
      cause: 'non_reclassifiable',
    });
    expect(result.overridden).toBe(true);
  });

  it('refuses to launder a program-source runtime error as an environment failure', () => {
    // For a program-source candidate the evolved AST IS the candidate: a budget
    // error, a worker timeout or a revoked execution epoch surfaces as a
    // `forward` throw, not as a config error. Allowing reclassification here
    // would promote a candidate on exactly the subset where its own generated
    // code happens not to crash.
    const result = axClassifyTrajectory(
      alwaysEnvironment,
      row({
        error: 'AxProgramSourceBudgetError: step budget exhausted',
        failureKind: 'runtime',
        candidateKinds: ['program-source'],
        nonReclassifiable: true,
      })
    );
    expect(result.termination).toEqual({
      kind: 'policy_failure',
      cause: 'non_reclassifiable',
    });
    expect(result.overridden).toBe(true);
  });

  it('admits a non-program-source runtime error reclassified by the host', () => {
    // The escape hatch still works where it is legitimate.
    const result = axClassifyTrajectory(
      alwaysEnvironment,
      row({
        error: '429 Too Many Requests',
        failureKind: 'runtime',
        candidateKinds: ['instruction'],
        nonReclassifiable: false,
      })
    );
    expect(result.termination).toEqual({
      kind: 'environment_failure',
      cause: 'rate_limit',
    });
    expect(result.overridden).toBe(false);
  });

  it('does not override a completed or policy-failure row', () => {
    // The override is scoped to the one transition it exists to block.
    expect(
      axClassifyTrajectory(
        () => ({ kind: 'completed' }),
        row({ nonReclassifiable: true })
      )
    ).toEqual({ termination: { kind: 'completed' }, overridden: false });
    expect(
      axClassifyTrajectory(
        () => ({ kind: 'policy_failure', cause: 'wrong answer' }),
        row({ nonReclassifiable: true })
      )
    ).toEqual({
      termination: { kind: 'policy_failure', cause: 'wrong answer' },
      overridden: false,
    });
  });

  it('normalizes an unrecognized classifier result to a policy failure', () => {
    // A JavaScript host is not bound by the TypeScript signature. "Unsure"
    // must resolve toward keeping the row, never toward discarding it.
    for (const bogus of [
      undefined,
      null,
      42,
      'environment_failure',
      {},
      { kind: 'exploded' },
    ]) {
      const { termination, overridden } = axClassifyTrajectory(
        () => bogus as unknown as AxTrajectoryTermination,
        row({ error: 'boom' })
      );
      expect(termination).toEqual({
        kind: 'policy_failure',
        cause: 'invalid_classification',
      });
      expect(overridden).toBe(false);
    }
  });

  it('narrows an unrecognized environment-failure cause instead of trusting it', () => {
    const { termination } = axClassifyTrajectory(
      () =>
        ({
          kind: 'environment_failure',
          cause: 'solar_flare',
        }) as unknown as AxTrajectoryTermination,
      row({ error: 'boom' })
    );
    expect(termination).toEqual({
      kind: 'environment_failure',
      cause: 'other',
    });
  });
});

describe('axResolveTrajectoryAdmissionOptions', () => {
  it('defaults to the conservative classifier and the stated thresholds', () => {
    const resolved = axResolveTrajectoryAdmissionOptions();
    expect(resolved.classifier).toBe(axDefaultTrajectoryTermination);
    expect(resolved.minAdmittedFraction).toBe(0.5);
    expect(resolved.maxRunDiscardRate).toBe(0.4);
    expect(resolved.minRunRowsForCeiling).toBe(50);
  });

  it('clamps every threshold into its documented range', () => {
    const low = axResolveTrajectoryAdmissionOptions({
      minAdmittedFraction: -3,
      maxRunDiscardRate: -1,
      minRunRowsForCeiling: 0,
    });
    expect(low.minAdmittedFraction).toBe(0);
    expect(low.maxRunDiscardRate).toBe(0);
    expect(low.minRunRowsForCeiling).toBe(1);
    const high = axResolveTrajectoryAdmissionOptions({
      minAdmittedFraction: 9,
      maxRunDiscardRate: 9,
      minRunRowsForCeiling: 10 ** 9,
    });
    expect(high.minAdmittedFraction).toBe(1);
    expect(high.maxRunDiscardRate).toBe(1);
    expect(high.minRunRowsForCeiling).toBe(100_000);
    const nonFinite = axResolveTrajectoryAdmissionOptions({
      minAdmittedFraction: Number.NaN,
      maxRunDiscardRate: Number.POSITIVE_INFINITY,
      minRunRowsForCeiling: Number.NaN,
    });
    // A non-finite input is not clamped, it is REJECTED back to the default:
    // Infinity clamped to 1 would silently disable the run-level ceiling.
    expect(nonFinite.minAdmittedFraction).toBe(0.5);
    expect(nonFinite.maxRunDiscardRate).toBe(0.4);
    expect(nonFinite.minRunRowsForCeiling).toBe(50);
  });
});

describe('axSummarizeTrajectoryAdmission', () => {
  const options = axResolveTrajectoryAdmissionOptions();

  it('discards only environment failures', () => {
    const report = axSummarizeTrajectoryAdmission(
      [
        { kind: 'completed' },
        { kind: 'policy_failure', cause: 'wrong answer' },
        { kind: 'environment_failure', cause: 'rate_limit' },
        { kind: 'environment_failure', cause: 'timeout' },
        { kind: 'completed' },
      ],
      0,
      options
    );
    // A policy failure is the candidate's own result and stays in the
    // denominator, scored zero exactly as it is today.
    expect(report.evaluatedRows).toBe(5);
    expect(report.admittedRows).toBe(3);
    expect(report.discardedRows).toBe(2);
    expect(report.discardRate).toBeCloseTo(0.4, 12);
    expect(report.inconclusive).toBe(false);
  });

  it('counts causes without retaining messages', () => {
    const report = axSummarizeTrajectoryAdmission(
      [
        { kind: 'environment_failure', cause: 'rate_limit' },
        { kind: 'environment_failure', cause: 'rate_limit' },
        { kind: 'environment_failure', cause: 'sandbox' },
        { kind: 'completed' },
        { kind: 'completed' },
        { kind: 'completed' },
        { kind: 'completed' },
        { kind: 'completed' },
        { kind: 'completed' },
        { kind: 'completed' },
      ],
      0,
      options
    );
    expect(report.causes).toEqual({ rate_limit: 2, sandbox: 1 });
    // The report travels into artifacts and logger events; provider error text
    // must not ride along.
    expect(JSON.stringify(report)).not.toMatch(/limit exceeded|Error|message/i);
  });

  it('refuses to decide a candidate on a mostly discarded batch', () => {
    const report = axSummarizeTrajectoryAdmission(
      terminations(4, 6),
      0,
      options
    );
    expect(report.admittedRows).toBe(4);
    expect(report.inconclusive).toBe(true);
    // Exactly at the floor is conclusive; the floor is a minimum, not a strict
    // inequality.
    expect(
      axSummarizeTrajectoryAdmission(terminations(5, 5), 0, options)
        .inconclusive
    ).toBe(false);
  });

  it('is inconclusive when nothing was admitted at all', () => {
    const permissive = axResolveTrajectoryAdmissionOptions({
      minAdmittedFraction: 0,
    });
    // Even with the floor at zero, a batch with no admitted row carries no
    // evidence and must not accept or reject a candidate.
    expect(
      axSummarizeTrajectoryAdmission(terminations(0, 4), 0, permissive)
        .inconclusive
    ).toBe(true);
    expect(axSummarizeTrajectoryAdmission([], 0, permissive).inconclusive).toBe(
      true
    );
  });

  it('records overridden rows separately from discarded rows', () => {
    const report = axSummarizeTrajectoryAdmission(
      [
        { kind: 'policy_failure', cause: 'non_reclassifiable' },
        { kind: 'completed' },
        { kind: 'completed' },
      ],
      1,
      options
    );
    // An overridden row was NOT discarded: it stayed in the denominator, which
    // is the entire point of the override.
    expect(report.overriddenRows).toBe(1);
    expect(report.discardedRows).toBe(0);
    expect(report.admittedRows).toBe(3);
  });
});

describe('axMergeTrajectoryAdmission', () => {
  const options = axResolveTrajectoryAdmissionOptions();
  const a = axSummarizeTrajectoryAdmission(terminations(8, 2), 1, options);
  const b = axSummarizeTrajectoryAdmission(
    terminations(6, 4, 'timeout'),
    0,
    options
  );
  const c = axSummarizeTrajectoryAdmission(terminations(3, 7), 2, options);

  it('adds counts and re-derives the rate from the totals', () => {
    const merged = axMergeTrajectoryAdmission(a, b);
    expect(merged.evaluatedRows).toBe(20);
    expect(merged.admittedRows).toBe(14);
    expect(merged.discardedRows).toBe(6);
    expect(merged.discardRate).toBeCloseTo(0.3, 12);
    expect(merged.causes).toEqual({ rate_limit: 2, timeout: 4 });
    expect(merged.overriddenRows).toBe(1);
  });

  it('is associative on every field', () => {
    // Run-level aggregation folds batches as they arrive; the fold order must
    // not change the reported rate.
    const left = axMergeTrajectoryAdmission(
      axMergeTrajectoryAdmission(a, b),
      c
    );
    const right = axMergeTrajectoryAdmission(
      a,
      axMergeTrajectoryAdmission(b, c)
    );
    expect(left).toEqual(right);
    expect(left.discardRate).toBeCloseTo(13 / 30, 12);
  });

  it('ors the inconclusive flag', () => {
    expect(a.inconclusive).toBe(false);
    expect(c.inconclusive).toBe(true);
    expect(axMergeTrajectoryAdmission(a, c).inconclusive).toBe(true);
    expect(axMergeTrajectoryAdmission(a, b).inconclusive).toBe(false);
  });
});

describe('axExceedsRunDiscardCeiling', () => {
  it('catches a classifier that discards just under the per-batch floor forever', () => {
    // 49% discarded every batch: the per-batch floor of 0.5 never fires, so
    // without a run-level ceiling such a run completes with a respectable
    // score built on half the evidence.
    const options = axResolveTrajectoryAdmissionOptions({
      minAdmittedFraction: 0.5,
      maxRunDiscardRate: 0.4,
      minRunRowsForCeiling: 50,
    });
    let run = axSummarizeTrajectoryAdmission(terminations(51, 49), 0, options);
    expect(run.inconclusive).toBe(false);
    expect(axExceedsRunDiscardCeiling(run, options)).toBe(true);

    // ...and it cannot fire before the minimum row count, no matter how bad
    // the rate looks on a tiny sample.
    const tiny = axSummarizeTrajectoryAdmission(terminations(1, 9), 0, options);
    expect(tiny.discardRate).toBeCloseTo(0.9, 12);
    expect(axExceedsRunDiscardCeiling(tiny, options)).toBe(false);

    // A healthy run stays under the ceiling.
    run = axSummarizeTrajectoryAdmission(terminations(80, 20), 0, options);
    expect(axExceedsRunDiscardCeiling(run, options)).toBe(false);
  });

  it('treats the ceiling as a strict excess', () => {
    const options = axResolveTrajectoryAdmissionOptions({
      maxRunDiscardRate: 0.4,
      minRunRowsForCeiling: 10,
    });
    const exactly = axSummarizeTrajectoryAdmission(
      terminations(60, 40),
      0,
      options
    );
    expect(exactly.discardRate).toBeCloseTo(0.4, 12);
    expect(axExceedsRunDiscardCeiling(exactly, options)).toBe(false);
  });
});

describe('axPairedAdmittedIndices', () => {
  it('returns the intersection in left order', () => {
    expect(axPairedAdmittedIndices([5, 1, 3, 9], [9, 3, 7])).toEqual([3, 9]);
  });

  it('handles identical, disjoint and empty sets', () => {
    expect(axPairedAdmittedIndices([1, 2, 3], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(axPairedAdmittedIndices([1, 2], [3, 4])).toEqual([]);
    expect(axPairedAdmittedIndices([], [1, 2])).toEqual([]);
    expect(axPairedAdmittedIndices([1, 2], [])).toEqual([]);
  });

  it('deduplicates a repeated left index', () => {
    // A duplicated index would be double-counted in a paired sum, quietly
    // reweighting one example.
    expect(axPairedAdmittedIndices([2, 2, 4, 4, 2], [2, 4])).toEqual([2, 4]);
  });

  it('gives both sides the same denominator when they discard different rows', () => {
    // The B1 shape in miniature: the parent lost rows 0 and 1, the child lost
    // row 7. Only the six rows both sides kept may decide the promotion.
    const parentAdmitted = [2, 3, 4, 5, 6, 7, 8, 9];
    const childAdmitted = [0, 1, 2, 3, 4, 5, 6, 8, 9];
    const paired = axPairedAdmittedIndices(parentAdmitted, childAdmitted);
    expect(paired).toEqual([2, 3, 4, 5, 6, 8, 9]);
    expect(axPairedAdmittedIndices(childAdmitted, parentAdmitted)).toEqual([
      2, 3, 4, 5, 6, 8, 9,
    ]);
  });

  it('returns a frozen array', () => {
    const paired = axPairedAdmittedIndices([1, 2], [2]);
    expect(Object.isFrozen(paired)).toBe(true);
  });
});
