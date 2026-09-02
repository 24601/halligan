import { describe, expect, it, vi } from 'vitest';

import type { AxTaskInclusion, AxTaskStat } from './taskDiscrimination.js';
import {
  axComputeInclusionProbabilities,
  axCreateTaskStatTable,
  axIpwPairedDifference,
  axIpwScore,
  axIsTaskDiscriminationError,
  axResolveTaskDiscriminationOptions,
  axSampleByInclusion,
} from './taskDiscrimination.js';

const options = axResolveTaskDiscriminationOptions();

const stats = (
  history: ReadonlyArray<readonly [successes: number, trials: number]>
): AxTaskStat[] =>
  history.map(([successes, trials], index) => ({
    index,
    successes,
    trials,
    lastSeenIteration: trials === 0 ? -1 : 1,
  }));

/** Deterministic xorshift, so a "seeded sweep" is reproducible in CI. */
const seeded = (seed: number) => {
  let state = seed || 123456789;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
};

/**
 * Enumerate EVERY Madow systematic sample exactly.
 *
 * The sample is a deterministic function of the single uniform draw `u`, and it
 * changes only when `u` crosses the fractional part of a cumulative inclusion
 * total. Partitioning [0,1) at those breakpoints and taking one midpoint per
 * cell therefore enumerates the whole sampling design with exact
 * probabilities — no Monte Carlo, no tolerance for sampling noise. That is what
 * lets the tests below assert design-unbiased weighting as an equality rather
 * than as
 * "close enough over N draws".
 */
const enumerateDesign = (
  inclusions: readonly AxTaskInclusion[],
  batchSize: number
): ReadonlyArray<{ probability: number; sample: readonly number[] }> => {
  const ordered = [...inclusions].sort((a, b) => a.index - b.index);
  const cuts = new Set<number>([0, 1]);
  let running = 0;
  for (const inclusion of ordered) {
    running += inclusion.probability;
    const fractional = running - Math.floor(running);
    if (fractional > 0 && fractional < 1) cuts.add(fractional);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const cells: { probability: number; sample: readonly number[] }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const low = points[i]!;
    const high = points[i + 1]!;
    const width = high - low;
    if (width <= 0) continue;
    const midpoint = (low + high) / 2;
    cells.push({
      probability: width,
      sample: axSampleByInclusion(inclusions, batchSize, () => midpoint),
    });
  }
  return cells;
};

describe('axResolveTaskDiscriminationOptions', () => {
  it('applies the documented defaults', () => {
    expect(options).toEqual({
      successThreshold: 0.5,
      explorationFloor: 0.2,
      maxReportedTasks: 200,
      maxInclusionSnapshots: 20,
    });
  });

  it('never lets the exploration floor reach zero', () => {
    // A floor of zero would let the selector starve always-failed tasks
    // completely, which makes a capability that only shows on currently
    // impossible tasks structurally invisible. The clamp is the guarantee.
    expect(
      axResolveTaskDiscriminationOptions({ explorationFloor: 0 })
        .explorationFloor
    ).toBe(0.05);
    expect(
      axResolveTaskDiscriminationOptions({ explorationFloor: -5 })
        .explorationFloor
    ).toBe(0.05);
    expect(
      axResolveTaskDiscriminationOptions({ explorationFloor: 9 })
        .explorationFloor
    ).toBe(1);
    expect(
      axResolveTaskDiscriminationOptions({ explorationFloor: Number.NaN })
        .explorationFloor
    ).toBe(0.2);
  });

  it('clamps the reporting bounds to whole numbers', () => {
    const resolved = axResolveTaskDiscriminationOptions({
      maxReportedTasks: 10_000.7,
      maxInclusionSnapshots: -4,
    });
    expect(resolved.maxReportedTasks).toBe(1000);
    expect(resolved.maxInclusionSnapshots).toBe(0);
  });
});

describe('AxTaskStatTable', () => {
  it('applies the success threshold and counts every admitted trial', () => {
    const table = axCreateTaskStatTable(4, options);
    table.record(0, 1, 1);
    table.record(0, 0.2, 2);
    table.record(1, 0.5, 2);
    const rows = table.stats();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      index: 0,
      successes: 1,
      trials: 2,
      lastSeenIteration: 2,
    });
    // The threshold is inclusive: exactly 0.5 is solved.
    expect(rows[1]).toEqual({
      index: 1,
      successes: 1,
      trials: 1,
      lastSeenIteration: 2,
    });
    // Never-sampled tasks are still present, with no history and no
    // last-seen iteration, so the population size is never inferred from
    // whatever happened to be drawn.
    expect(rows[3]).toEqual({
      index: 3,
      successes: 0,
      trials: 0,
      lastSeenIteration: -1,
    });
  });

  it('captures resolved options once at construction', () => {
    // `record` takes no options argument, and the threshold is copied rather
    // than held by reference: a table whose threshold changes mid-run would
    // mean two different things in one history.
    const mutable = { ...axResolveTaskDiscriminationOptions() };
    const table = axCreateTaskStatTable(2, mutable);
    mutable.successThreshold = 0.99;
    table.record(0, 0.6, 1);
    expect(table.stats()[0]!.successes).toBe(1);
  });

  it('rejects an out-of-range index or a non-finite scalar', () => {
    const table = axCreateTaskStatTable(3, options);
    for (const [index, scalar] of [
      [3, 1],
      [-1, 1],
      [1.5, 1],
      [0, Number.NaN],
    ] as const) {
      expect(() => table.record(index, scalar, 1)).toThrowError(
        expect.objectContaining({ code: 'unknown_task_index' })
      );
    }
    expect(() => axCreateTaskStatTable(0, options)).toThrowError(
      expect.objectContaining({ code: 'unknown_task_index' })
    );
  });

  it('clears every counter on reset', () => {
    const table = axCreateTaskStatTable(2, options);
    table.record(0, 1, 5);
    table.reset();
    expect(table.stats()).toEqual([
      { index: 0, successes: 0, trials: 0, lastSeenIteration: -1 },
      { index: 1, successes: 0, trials: 0, lastSeenIteration: -1 },
    ]);
  });
});

describe('axComputeInclusionProbabilities', () => {
  it('produces exactly uniform probabilities with no recorded trials', () => {
    // Cold start: every p̂ is exactly 0.5 under Laplace smoothing, so every
    // Bernoulli variance is 0.25 and the distribution is provably uniform. The
    // first minibatch under this strategy is statistically identical to a
    // uniform draw — the "no behaviour change on iteration 0" guarantee.
    const population = 12;
    const batchSize = 4;
    const inclusions = axComputeInclusionProbabilities(
      stats(Array.from({ length: population }, () => [0, 0] as const)),
      batchSize,
      options
    );
    for (const inclusion of inclusions) {
      expect(inclusion.probability).toBeCloseTo(batchSize / population, 12);
    }
  });

  it('concentrates mass on maximum-variance tasks', () => {
    // Half the tasks are solved every time, half are solved half the time. Only
    // the second half can distinguish two candidates.
    const inclusions = axComputeInclusionProbabilities(
      stats([
        [10, 10],
        [10, 10],
        [10, 10],
        [5, 10],
        [5, 10],
        [5, 10],
      ]),
      2,
      options
    );
    const solved = inclusions.slice(0, 3).map((i) => i.probability);
    const discriminating = inclusions.slice(3).map((i) => i.probability);
    for (const d of discriminating) {
      for (const s of solved) expect(d).toBeGreaterThan(s);
    }
    // ...and the concentration is real, not cosmetic.
    expect(discriminating[0]! / solved[0]!).toBeGreaterThan(2);
  });

  it('never drops an always-failed task below the exploration floor', () => {
    // One task nobody has ever solved, among many that discriminate. The
    // reserve keeps it visible: `π ≥ ε · m / N` is the arithmetic guarantee of
    // step 4, and it is not an option that can be set to zero.
    const population = 20;
    const batchSize = 5;
    const history: [number, number][] = [[0, 50]];
    for (let i = 1; i < population; i++) history.push([25, 50]);
    const inclusions = axComputeInclusionProbabilities(
      stats(history),
      batchSize,
      options
    );
    const floor = (options.explorationFloor * batchSize) / population;
    expect(inclusions[0]!.probability).toBeGreaterThanOrEqual(floor - 1e-12);
    // The always-failed task is genuinely down-weighted (it is not
    // discriminating) but is still reachable.
    expect(inclusions[0]!.probability).toBeLessThan(inclusions[1]!.probability);
  });

  it('water-fills probabilities above one', () => {
    // m = 9 of N = 10 with one dominant task: the naive proportional allocation
    // would hand that task a probability above 1, which is not a probability.
    const history: [number, number][] = [[50, 100]];
    for (let i = 1; i < 10; i++) history.push([100, 100]);
    const inclusions = axComputeInclusionProbabilities(
      stats(history),
      9,
      options
    );
    let total = 0;
    for (const inclusion of inclusions) {
      expect(inclusion.probability).toBeGreaterThan(0);
      expect(inclusion.probability).toBeLessThanOrEqual(1);
      total += inclusion.probability;
    }
    expect(total).toBeCloseTo(9, 9);
    // The dominant task saturates at exactly 1 rather than overflowing.
    expect(inclusions[0]!.probability).toBe(1);
  });

  it('assigns every task probability one when the batch is the population', () => {
    const inclusions = axComputeInclusionProbabilities(
      stats([
        [0, 10],
        [5, 10],
        [10, 10],
      ]),
      3,
      options
    );
    expect(inclusions.map((i) => i.probability)).toEqual([1, 1, 1]);
  });

  it('sums inclusion probabilities to the batch size', () => {
    // Property sweep over 200 seeded random histories: the sum is the batch
    // size and every probability is a probability. This is the invariant Madow
    // sampling depends on.
    for (let seed = 1; seed <= 200; seed++) {
      const rand = seeded(seed * 7919);
      const population = 2 + Math.floor(rand() * 30);
      const batchSize = 1 + Math.floor(rand() * population);
      const history: [number, number][] = [];
      for (let i = 0; i < population; i++) {
        const trials = Math.floor(rand() * 40);
        history.push([Math.floor(rand() * (trials + 1)), trials]);
      }
      const inclusions = axComputeInclusionProbabilities(
        stats(history),
        batchSize,
        options
      );
      let total = 0;
      for (const inclusion of inclusions) {
        expect(inclusion.probability).toBeGreaterThan(0);
        expect(inclusion.probability).toBeLessThanOrEqual(1);
        total += inclusion.probability;
      }
      expect(Math.abs(total - batchSize)).toBeLessThan(1e-9);
    }
  });

  it('carries each task history through onto its inclusion', () => {
    const inclusions = axComputeInclusionProbabilities(
      stats([
        [1, 4],
        [3, 4],
      ]),
      1,
      options
    );
    expect(inclusions.map((i) => [i.index, i.successes, i.trials])).toEqual([
      [0, 1, 4],
      [1, 3, 4],
    ]);
  });

  it('throws when the batch exceeds the population', () => {
    expect(() =>
      axComputeInclusionProbabilities(stats([[0, 0]]), 2, options)
    ).toThrowError(
      expect.objectContaining({ code: 'batch_size_exceeds_population' })
    );
  });

  it('throws on a non-positive batch size and an impossible history', () => {
    expect(() =>
      axComputeInclusionProbabilities(stats([[0, 0]]), 0, options)
    ).toThrowError(expect.objectContaining({ code: 'non_finite_probability' }));
    expect(() =>
      axComputeInclusionProbabilities(
        [{ index: 0, successes: 5, trials: 2, lastSeenIteration: 0 }],
        1,
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'non_finite_probability' }));
  });

  it('throws on a duplicated or out-of-range task index', () => {
    expect(() =>
      axComputeInclusionProbabilities(
        [
          { index: 0, successes: 0, trials: 0, lastSeenIteration: 0 },
          { index: 0, successes: 0, trials: 0, lastSeenIteration: 0 },
        ],
        1,
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'unknown_task_index' }));
    expect(() =>
      axComputeInclusionProbabilities(
        [{ index: 7, successes: 0, trials: 0, lastSeenIteration: 0 }],
        1,
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'unknown_task_index' }));
  });
});

describe('axSampleByInclusion', () => {
  const inclusions = axComputeInclusionProbabilities(
    stats([
      [10, 10],
      [10, 10],
      [5, 10],
      [5, 10],
      [0, 10],
      [1, 10],
      [9, 10],
      [4, 10],
    ]),
    3,
    options
  );

  it('draws exactly batchSize distinct indices from one random value', () => {
    const rand = vi.fn(() => 0.375);
    const drawn = axSampleByInclusion(inclusions, 3, rand);
    // Exactly one draw: the shared xorshift stream is a fixed resource, and a
    // sampler with a variable draw count would make a seeded run
    // stop reproducing.
    expect(rand).toHaveBeenCalledTimes(1);
    expect(drawn).toHaveLength(3);
    expect(new Set(drawn).size).toBe(3);
    expect([...drawn].sort((a, b) => a - b)).toEqual(
      drawn.slice().sort((a, b) => a - b)
    );
  });

  it('reproduces the same sample for the same random value', () => {
    expect(axSampleByInclusion(inclusions, 3, () => 0.11)).toEqual(
      axSampleByInclusion(inclusions, 3, () => 0.11)
    );
    // ...and a different draw generally lands somewhere else.
    const samples = new Set(
      [0.05, 0.3, 0.55, 0.8, 0.99].map((u) =>
        axSampleByInclusion(inclusions, 3, () => u).join(',')
      )
    );
    expect(samples.size).toBeGreaterThan(1);
  });

  it('realizes each first-order inclusion probability exactly', () => {
    // THE defining property of Madow systematic πps: P(i ∈ S) = π_i. Checked by
    // enumerating the whole design rather than by sampling, so this is an
    // equality within floating-point slack, not a statistical claim.
    const design = enumerateDesign(inclusions, 3);
    const realized = new Map<number, number>();
    for (const cell of design) {
      for (const index of cell.sample) {
        realized.set(index, (realized.get(index) ?? 0) + cell.probability);
      }
    }
    for (const inclusion of inclusions) {
      expect(realized.get(inclusion.index) ?? 0).toBeCloseTo(
        inclusion.probability,
        10
      );
    }
    // Every cell is a valid fixed-size sample.
    for (const cell of design) {
      expect(new Set(cell.sample).size).toBe(3);
    }
    expect(design.reduce((sum, cell) => sum + cell.probability, 0)).toBeCloseTo(
      1,
      12
    );
  });

  it('rejects a random source outside [0, 1) and an invalid inclusion set', () => {
    for (const bad of [1, -0.1, Number.NaN]) {
      expect(() => axSampleByInclusion(inclusions, 3, () => bad)).toThrowError(
        expect.objectContaining({ code: 'non_finite_probability' })
      );
    }
    // Probabilities that do not sum to the batch size are not a sampling design
    // and must not be silently normalized.
    expect(() => axSampleByInclusion(inclusions, 2, () => 0.5)).toThrowError(
      expect.objectContaining({ code: 'inclusion_sum_mismatch' })
    );
    expect(() =>
      axSampleByInclusion(
        [
          { index: 0, probability: 1.5, successes: 0, trials: 0 },
          { index: 1, probability: -0.5, successes: 0, trials: 0 },
        ],
        1,
        () => 0.5
      )
    ).toThrowError(expect.objectContaining({ code: 'non_finite_probability' }));
  });

  it('throws when the batch exceeds the inclusion set', () => {
    expect(() => axSampleByInclusion(inclusions, 99, () => 0.5)).toThrowError(
      expect.objectContaining({ code: 'batch_size_exceeds_population' })
    );
  });
});

describe('axIpwScore', () => {
  it('reduces to the arithmetic mean under uniform inclusion', () => {
    // Uniform π means every weight is equal, so the Hájek ratio collapses to
    // the plain mean: the estimator adds nothing when the draw was uniform,
    // which is why the legacy path is unaffected.
    const inclusions = axComputeInclusionProbabilities(
      stats(Array.from({ length: 8 }, () => [0, 0] as const)),
      4,
      options
    );
    const values = [0.1, 0.9, 0.4, 0.6];
    const rows = values.map((value, position) => ({
      index: position,
      value,
    }));
    const estimate = axIpwScore(rows, inclusions);
    expect(estimate.estimate).toBeCloseTo(0.5, 12);
    expect(estimate.rowCount).toBe(4);
    expect(estimate.effectiveSampleSize).toBeCloseTo(4, 12);
  });

  it('recovers the population total exactly under the sampling design', () => {
    // Horvitz-Thompson: E[Σ_{i∈S} y_i / π_i] = Σ_i y_i, exactly, because the
    // sampler realizes each π_i exactly. Computed over the enumerated design,
    // so this is an identity check on the weighting, not a Monte Carlo one.
    const inclusions = axComputeInclusionProbabilities(
      stats([
        [10, 10],
        [8, 10],
        [5, 10],
        [5, 10],
        [2, 10],
        [0, 10],
      ]),
      3,
      options
    );
    const values = [0.9, 0.2, 0.5, 0.7, 0.1, 0.4];
    const byIndex = new Map(
      inclusions.map((inclusion) => [inclusion.index, inclusion.probability])
    );
    let expectedTotal = 0;
    for (const cell of enumerateDesign(inclusions, 3)) {
      let total = 0;
      for (const index of cell.sample) {
        total += values[index]! / byIndex.get(index)!;
      }
      expectedTotal += cell.probability * total;
    }
    expect(expectedTotal).toBeCloseTo(
      values.reduce((sum, value) => sum + value, 0),
      9
    );
  });

  it('corrects the difficulty bias a raw sample mean carries', () => {
    // Under a discriminative draw the raw per-row mean is a π-weighted mean, so
    // it is systematically pulled toward whatever the sampler favours. The
    // inverse-probability estimate is not. Both expectations are computed over
    // the enumerated design.
    const inclusions = axComputeInclusionProbabilities(
      stats([
        [10, 10],
        [10, 10],
        [10, 10],
        [5, 10],
        [5, 10],
        [0, 10],
      ]),
      2,
      options
    );
    // Value is correlated with difficulty, which is exactly when the bias bites.
    const values = [1, 1, 1, 0.5, 0.5, 0];
    const trueMean =
      values.reduce((sum, value) => sum + value, 0) / values.length;
    let rawMeanExpectation = 0;
    let hajekExpectation = 0;
    for (const cell of enumerateDesign(inclusions, 2)) {
      const rows = cell.sample.map((index) => ({
        index,
        value: values[index]!,
      }));
      const raw = rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
      rawMeanExpectation += cell.probability * raw;
      hajekExpectation +=
        cell.probability * axIpwScore(rows, inclusions).estimate;
    }
    expect(Math.abs(rawMeanExpectation - trueMean)).toBeGreaterThan(0.05);
    expect(Math.abs(hajekExpectation - trueMean)).toBeLessThan(
      Math.abs(rawMeanExpectation - trueMean) / 2
    );
  });

  it('reports a smaller effective sample as inclusion probabilities skew', () => {
    // Skewing the weights concentrates the estimate on fewer effective
    // observations. ESS is the number that says so, and it has to move or the
    // field is decoration.
    const rows = [
      { index: 0, value: 0 },
      { index: 1, value: 1 },
      { index: 2, value: 0 },
      { index: 3, value: 1 },
    ];
    const even: AxTaskInclusion[] = rows.map((row) => ({
      index: row.index,
      probability: 0.5,
      successes: 0,
      trials: 0,
    }));
    const skewed: AxTaskInclusion[] = [
      { index: 0, probability: 0.95, successes: 0, trials: 0 },
      { index: 1, probability: 0.05, successes: 0, trials: 0 },
      { index: 2, probability: 0.95, successes: 0, trials: 0 },
      { index: 3, probability: 0.05, successes: 0, trials: 0 },
    ];
    expect(axIpwScore(rows, even).effectiveSampleSize).toBeCloseTo(4, 12);
    expect(axIpwScore(rows, skewed).effectiveSampleSize).toBeLessThan(2.5);
    // The skewed draw also pulls the estimate toward the heavily up-weighted
    // rows, which is the whole point of inverse-probability weighting.
    expect(axIpwScore(rows, skewed).estimate).toBeCloseTo(0.95, 10);
  });

  it('reports a larger stderr when the sampled values disagree more', () => {
    // The reported spread must track the disagreement among observations at a
    // fixed design, or it says nothing about how much the estimate is worth.
    const inclusions: AxTaskInclusion[] = [0, 1, 2, 3].map((index) => ({
      index,
      probability: 0.5,
      successes: 0,
      trials: 0,
    }));
    const tight = axIpwScore(
      [
        { index: 0, value: 0.45 },
        { index: 1, value: 0.55 },
        { index: 2, value: 0.45 },
        { index: 3, value: 0.55 },
      ],
      inclusions
    );
    const wide = axIpwScore(
      [
        { index: 0, value: 0 },
        { index: 1, value: 1 },
        { index: 2, value: 0 },
        { index: 3, value: 1 },
      ],
      inclusions
    );
    expect(tight.estimate).toBeCloseTo(wide.estimate, 12);
    expect(wide.stderr).toBeGreaterThan(tight.stderr);
  });

  it('is invariant to a uniform rescaling of the inclusion probabilities', () => {
    // Hájek is a RATIO estimator: multiplying every weight by a constant leaves
    // both the estimate and the linearized standard error untouched. A
    // implementation that accidentally used Horvitz-Thompson totals here would
    // fail this.
    const rows = [
      { index: 0, value: 0.2 },
      { index: 1, value: 0.9 },
      { index: 2, value: 0.4 },
    ];
    const base: AxTaskInclusion[] = [0.4, 0.8, 0.6].map(
      (probability, index) => ({
        index,
        probability,
        successes: 0,
        trials: 0,
      })
    );
    const halved: AxTaskInclusion[] = base.map((inclusion) => ({
      ...inclusion,
      probability: inclusion.probability / 2,
    }));
    const a = axIpwScore(rows, base);
    const b = axIpwScore(rows, halved);
    expect(b.estimate).toBeCloseTo(a.estimate, 12);
    expect(b.stderr).toBeCloseTo(a.stderr, 12);
    expect(b.effectiveSampleSize).toBeCloseTo(a.effectiveSampleSize, 12);
  });

  it('reports a zero stderr when every weighted value agrees', () => {
    const inclusions: AxTaskInclusion[] = [
      { index: 0, probability: 0.4, successes: 0, trials: 0 },
      { index: 1, probability: 0.6, successes: 0, trials: 0 },
    ];
    const estimate = axIpwScore(
      [
        { index: 0, value: 0.25 },
        { index: 1, value: 0.25 },
      ],
      inclusions
    );
    expect(estimate.estimate).toBeCloseTo(0.25, 12);
    expect(estimate.stderr).toBe(0);
  });

  it('returns a zero estimate for an empty row set', () => {
    // Under both promotion gates a zero difference fails the `> threshold`
    // test, so "nothing was admitted" resolves toward NOT promoting.
    const estimate = axIpwScore([], []);
    expect(estimate).toEqual({
      estimate: 0,
      stderr: 0,
      effectiveSampleSize: 0,
      rowCount: 0,
    });
  });

  it('throws for a row with no inclusion probability', () => {
    expect(() =>
      axIpwScore(
        [{ index: 4, value: 1 }],
        [{ index: 0, probability: 1, successes: 0, trials: 0 }]
      )
    ).toThrowError(expect.objectContaining({ code: 'unknown_task_index' }));
  });
});

describe('axIpwPairedDifference', () => {
  const inclusions = axComputeInclusionProbabilities(
    stats([
      [10, 10],
      [8, 10],
      [5, 10],
      [5, 10],
      [2, 10],
      [0, 10],
    ]),
    3,
    options
  );

  it('computes a paired difference immune to batch difficulty', () => {
    // Parent and child differ by the same margin everywhere. A per-example mean
    // difference must then be that margin on an easy draw and on a hard one
    // alike — which is precisely what a raw batch SUM fails to be, since it
    // scales with the batch and with whatever the draw happened to contain.
    const parentValues = [0.9, 0.7, 0.5, 0.5, 0.2, 0.0];
    const margin = 0.08;
    const design = enumerateDesign(inclusions, 3);
    const estimates = new Set<number>();
    for (const cell of design) {
      const parent = cell.sample.map((index) => ({
        index,
        value: parentValues[index]!,
      }));
      const child = cell.sample.map((index) => ({
        index,
        value: parentValues[index]! + margin,
      }));
      const paired = axIpwPairedDifference(parent, child, inclusions);
      expect(paired.estimate).toBeCloseTo(margin, 12);
      expect(paired.rowCount).toBe(3);
      estimates.add(Number(paired.estimate.toFixed(12)));
    }
    expect(estimates.size).toBe(1);
    // The raw sums the legacy gate compares are NOT stable across those same
    // draws, which is why the estimator ships with the sampler.
    const sums = new Set(
      design.map((cell) =>
        Number(
          cell.sample
            .reduce((sum, index) => sum + parentValues[index]!, 0)
            .toFixed(12)
        )
      )
    );
    expect(sums.size).toBeGreaterThan(1);
  });

  it('weights a varying difference by inverse inclusion probability', () => {
    // Closed form on a two-task design: with π = (0.4, 0.6) and differences
    // (1, 0), Hájek is (1/0.4 · 1 + 1/0.6 · 0) / (1/0.4 + 1/0.6) = 0.6.
    const twoTask: AxTaskInclusion[] = [
      { index: 0, probability: 0.4, successes: 0, trials: 0 },
      { index: 1, probability: 0.6, successes: 0, trials: 0 },
    ];
    const paired = axIpwPairedDifference(
      [
        { index: 0, value: 0 },
        { index: 1, value: 0 },
      ],
      [
        { index: 0, value: 1 },
        { index: 1, value: 0 },
      ],
      twoTask
    );
    expect(paired.estimate).toBeCloseTo(0.6, 12);
    expect(paired.effectiveSampleSize).toBeCloseTo(
      (2.5 + 5 / 3) ** 2 / (2.5 ** 2 + (5 / 3) ** 2),
      12
    );
  });

  it('refuses an unpaired parent/child index set', () => {
    // Pairing is never inferred: inferring it is exactly how two different
    // denominators end up being compared.
    expect(() =>
      axIpwPairedDifference(
        [{ index: 0, value: 1 }],
        [
          { index: 0, value: 1 },
          { index: 1, value: 1 },
        ],
        inclusions
      )
    ).toThrowError(expect.objectContaining({ code: 'paired_index_mismatch' }));
    expect(() =>
      axIpwPairedDifference(
        [{ index: 0, value: 1 }],
        [{ index: 1, value: 1 }],
        inclusions
      )
    ).toThrowError(expect.objectContaining({ code: 'paired_index_mismatch' }));
    expect(() =>
      axIpwPairedDifference(
        [
          { index: 0, value: 1 },
          { index: 0, value: 1 },
        ],
        [
          { index: 0, value: 1 },
          { index: 1, value: 1 },
        ],
        inclusions
      )
    ).toThrowError(expect.objectContaining({ code: 'paired_index_mismatch' }));
  });

  it('returns a zero estimate for an empty pair', () => {
    expect(axIpwPairedDifference([], [], inclusions).estimate).toBe(0);
  });

  it('recognizes its own error structurally across realms', () => {
    let thrown: unknown;
    try {
      axIpwPairedDifference([{ index: 0, value: 1 }], [], inclusions);
    } catch (error) {
      thrown = error;
    }
    expect(axIsTaskDiscriminationError(thrown)).toBe(true);
    expect(
      axIsTaskDiscriminationError({
        name: 'AxTaskDiscriminationError',
        code: 'unknown_task_index',
      })
    ).toBe(true);
    expect(
      axIsTaskDiscriminationError({
        name: 'AxTaskDiscriminationError',
        code: 'made_up',
      })
    ).toBe(false);
    expect(axIsTaskDiscriminationError(new Error('nope'))).toBe(false);
  });
});
