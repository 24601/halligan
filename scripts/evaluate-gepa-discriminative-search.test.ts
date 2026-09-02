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

    // The option's mere presence changes nothing on the uniform path.
    expect(result.uniformIsBitIdenticalToBaseline).toBe(true);
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

    expect(result.budget).toMatchObject({
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: 30_000,
    });
    expect(result.budget.elapsedWallTimeMs).toBeLessThanOrEqual(
      result.budget.maxWallTimeMs
    );
  }, 60_000);
});
