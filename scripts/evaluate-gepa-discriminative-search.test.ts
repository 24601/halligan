import { describe, expect, it } from 'vitest';
import { evaluateGepaDiscriminativeSearch } from './evaluate-gepa-discriminative-search.js';

describe('GEPA discriminative search evaluation', () => {
  it('reports concentration, divergence and the unsupported cost claim without model calls', async () => {
    const result = await evaluateGepaDiscriminativeSearch();

    // What the mechanism demonstrably does: concentrate the draw on the one
    // task that separates candidates. Asserted on the rows actually drawn, so a
    // sampler that computes inclusion probabilities and then ignores them fails
    // here (verified by injecting exactly that mutation).
    expect(result.concentration.concentrationFactor).toBeGreaterThan(1.25);
    expect(result.concentration.medianAlternatingDrawShare).toBeGreaterThan(
      result.concentration.uniformAlternatingDrawShare
    );

    // The sampler is not inert: on a fixture with a single discriminating task
    // the two strategies provably select different configurations. Without this
    // control, agreement elsewhere would also be achieved by a sampler that
    // ignores the statistics entirely.
    expect(result.negativeControl.divergentSeeds).toBeGreaterThan(0);

    // The exploration floor is mandatory and non-optional.
    expect(result.explorationFloorHonoured).toBe(true);

    // The option's mere presence changes nothing on the uniform path. This is
    // an implicit-vs-explicit comparison WITHIN this build; the comparison
    // against `origin/main` is `test:gepa-upstream-compatibility`.
    expect(result.uniformOptionPresenceChangesNothing).toBe(true);
    expect(result.uniformRandDrawCount).toBe(
      result.explicitUniformRandDrawCount
    );

    // THE NEGATIVE, ASSERTED AS A NEGATIVE. The RFC's cost-at-parity claim does
    // not reproduce on this fixture: the median call ratio sits at or above
    // parity. This assertion exists so that a future change which actually
    // makes the claim true fails here and forces the claim, the honesty note
    // and this test to be rewritten together, rather than letting a stale
    // "unsupported" note survive a real improvement.
    expect(result.fixture1.costClaimSupported).toBe(false);
    expect(result.fixture1.medianCallRatio).toBeGreaterThan(0.9);
    expect(result.fixture1.seedsComparedOnCost).toBeGreaterThan(0);
    expect(
      result.fixture1.seedsWhereDiscriminativeCostMore.length
    ).toBeGreaterThan(0);

    // THE SECOND NEGATIVE, ALSO ASSERTED AS A NEGATIVE. The cost measurement
    // cannot see the axis a variance-weighted design is for — the estimator's
    // variance, i.e. how often the gate decides correctly at a fixed batch
    // size — so the gate error rate against the full-population decision is
    // measured directly, for both strategies, at the same batch size and the
    // same seeds.
    //
    // It does not help either. On fixture 1 the discriminative gate's error
    // rate is HIGHER, and on both fixtures a larger share of the proposals
    // that really were improvements is thrown away. The raw error rate falls
    // on the negative control only because that run produced fewer true
    // improvements to miss, which is exactly why the normalized number is
    // reported beside it. These assertions pin the measured direction: a
    // change that actually makes the mechanism work fails here and forces the
    // claim and the honesty note to be rewritten with it.
    for (const fixture of [
      result.gateQuality.fixture1,
      result.gateQuality.negativeControl,
    ]) {
      expect(fixture.uniform.decisions).toBeGreaterThan(0);
      expect(fixture.discriminative.decisions).toBeGreaterThan(0);
      expect(fixture.uniform.decisions).toBe(fixture.discriminative.decisions);
      expect(fixture.uniform.trulyBetterProposals).toBeGreaterThan(0);
      expect(fixture.discriminative.trulyBetterProposals).toBeGreaterThan(0);
      expect(
        fixture.discriminative.falseRejectRateAmongTrulyBetter
      ).toBeGreaterThan(fixture.uniform.falseRejectRateAmongTrulyBetter);
    }
    expect(result.gateQuality.fixture1.errorRateDelta).toBeGreaterThan(0);

    expect(result.budget).toMatchObject({
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: 10_000,
    });
    expect(result.budget.elapsedWallTimeMs).toBeLessThanOrEqual(
      result.budget.maxWallTimeMs
    );
  }, 60_000);
});
