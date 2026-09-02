import { describe, expect, it } from 'vitest';
import {
  AX_PLAYBOOK_EVIDENCE_ARCHETYPES,
  AX_PLAYBOOK_EVIDENCE_SEED_PROBE,
  AX_PLAYBOOK_EVIDENCE_SEED_PROBE_DATASET,
  AX_PLAYBOOK_EVIDENCE_TARGETS,
  evaluatePlaybookEvidence,
  gateShapeOf,
  intervalShapeOf,
  runArchetype,
} from './evaluate-playbook-evidence.js';

describe('playbook evidence evaluation', () => {
  it('catches each named failure mode without a model call', async () => {
    const result = await evaluatePlaybookEvidence();

    // Control arm: the arm catches a gain it can reproduce, keeps one it
    // cannot, and attributes a plumbing-only gain to the neutral artifact.
    expect(result.controlArm.falseImprovementCaught).toEqual({
      caught: 1,
      total: 1,
    });
    expect(result.controlArm.trueImprovementRetained).toEqual({
      retained: 1,
      total: 1,
    });
    expect(result.controlArm.harnessTermAttributed).toEqual({
      caught: 1,
      total: 1,
    });

    // Intervals: a within-band delta reads unresolved, and the counter-metric
    // — unchanged-artifact comparisons called positive — is zero.
    expect(result.interval.unresolvedReported).toEqual({
      reported: 1,
      total: 1,
    });
    expect(result.interval.falsePositiveRate).toBe(0);
    expect(result.interval.comparisons).toBeGreaterThan(0);

    // Reach: zero reach beside a positive delta is a hard warning, and a
    // counterfactual basis is labelled AND gate-ineligible.
    expect(result.reach.zeroReachWarnings).toBe(1);
    expect(result.reach.counterfactualLabelled).toEqual({
      labelled: 1,
      total: 1,
    });

    // Validity: the rejection names the exact failing predicate.
    expect(result.validity.predicateNamed).toEqual({ named: 1, total: 1 });

    // Transfer: one regressing cell caught and rolled back, while the average
    // the report refuses to compute WOULD have passed the same floor.
    expect(result.transfer.regressingCellCaught).toBe(1);
    expect(result.transfer.rolledBack).toBe(true);
    expect(result.transfer.averageWouldHavePassed).toBe(true);

    // Termination: discards leave the denominator and never score as zeros,
    // and a 50-turn trajectory weighs the same as a 2-turn one.
    expect(result.termination.discardRate).toBeCloseTo(1 / 3, 9);
    expect(result.termination.equalWeightHolds).toBe(true);

    // E1: the accounted total equals an independent agent-invocation tally.
    expect(result.accounting.metricCallsAccounted).toBe(
      result.accounting.total
    );
    expect(result.accounting.total).toBe(
      AX_PLAYBOOK_EVIDENCE_ARCHETYPES.length
    );

    // Every archetype met its declared expectation, so nothing here is a
    // failed gate dressed as a pass.
    for (const row of result.archetypes) {
      expect(`${row.name}:${row.met}`).toBe(`${row.name}:true`);
    }

    // NEGATIVE RESULTS, asserted rather than narrated: three archetypes are
    // detect-only. The machinery reports them and the artifact still goes live.
    expect(result.negativeResults).toHaveLength(3);
    expect(result.negativeResults.join('\n')).toContain(
      "within-band: 'delta_within_variance_band' fired and the artifact still went live"
    );
    expect(result.negativeResults.join('\n')).toContain(
      "zero-reach: 'reach_zero_positive_delta' fired and the artifact still went live"
    );
    expect(result.negativeResults.join('\n')).toContain(
      "counterfactual-reach: 'reach_counterfactual_basis' fired and the artifact still went live"
    );

    expect(result.budget).toMatchObject({
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: 5000,
    });
    expect(result.budget.elapsedWallTimeMs).toBeLessThanOrEqual(
      result.budget.maxWallTimeMs
    );
  });

  // --- property 1: order invariance ----------------------------------------
  //
  // Hard-coded fixtures with hard-coded targets are passable by a special-cased
  // implementation. Permuting the task order in every split changes the default
  // bootstrap seed (it is a digest of the task ids IN ORDER) and therefore the
  // intervals, but it must change no gate decision at all.
  it.each(
    AX_PLAYBOOK_EVIDENCE_ARCHETYPES.map((archetype) => [
      archetype.name,
      archetype,
    ])
  )(
    'order invariance: %s decides the same gates under a permuted task order',
    async (_name, archetype: any) => {
      const options = {
        ...archetype.common(AX_PLAYBOOK_EVIDENCE_TARGETS),
        ...archetype.gated,
      };
      const inOrder = await runArchetype(archetype, options, false);
      const permuted = await runArchetype(archetype, options, true);
      expect(gateShapeOf(permuted.result)).toEqual(gateShapeOf(inOrder.result));
      // ... and the permutation really was applied, so this is not two
      // identical runs agreeing with themselves.
      expect(
        permuted.result.records.map((record: any) => record.task.id)
      ).not.toEqual(
        inOrder.result.records.map((record: any) => record.task.id)
      );
    }
  );

  // --- property 2: seed reproducibility -------------------------------------
  it('seed reproducibility: the same seed reproduces every interval exactly', async () => {
    const archetype = AX_PLAYBOOK_EVIDENCE_SEED_PROBE;
    const optionsFor = (seed: number) => ({
      ...archetype.common(AX_PLAYBOOK_EVIDENCE_TARGETS),
      intervalOptions: { resamples: 400, level: 0.95, seed },
    });
    const run = (seed: number) =>
      runArchetype(
        archetype,
        optionsFor(seed),
        false,
        AX_PLAYBOOK_EVIDENCE_SEED_PROBE_DATASET
      );
    const first = await run(4242);
    const second = await run(4242);
    const firstIntervals = intervalShapeOf(first.result);
    expect(firstIntervals.length).toBeGreaterThan(0);
    // `toEqual` on the flattened rows is exact-value equality, not closeness.
    expect(intervalShapeOf(second.result)).toEqual(firstIntervals);
    for (const row of firstIntervals) expect(row).toContain(':4242:');

    // A DIFFERENT seed moves the BOUNDS, not merely the recorded seed field.
    // Without this the property above would also pass on an implementation
    // that ignored the seed and returned a constant interval.
    const other = await run(99);
    expect(intervalShapeOf(other.result, false)).not.toEqual(
      intervalShapeOf(first.result, false)
    );
    // ... but the gate decisions are unchanged by the seed.
    expect(gateShapeOf(other.result)).toEqual(gateShapeOf(first.result));
  });
});
