import { describe, expect, it } from 'vitest';

import {
  canonicalFixtureBytes,
  runSkillProvenanceEvaluation,
} from './evaluate-skill-provenance.js';

/**
 * Re-runs the evaluation in-process and asserts every metric the report marks
 * as asserted, plus the pinned fixture digest — so the evidence cannot rot
 * silently while the script keeps printing numbers.
 */
describe('skill provenance evaluation', () => {
  it('holds every asserted metric and the pinned fixture digest', async () => {
    const report = (await runSkillProvenanceEvaluation()) as Record<
      string,
      any
    >;

    expect(report.fixtureDigest).toBe('fnv1a64:8175f8fd49774454');
    expect(report.budget).toEqual({
      providerCalls: 0,
      tokens: 0,
      usd: 0,
      network: 'none',
    });
    expect(report.honesty).toContain('paraphrases optimizer-tier content');

    // The digest covers the fixture BYTES. A digest over `{artifacts: 24,
    // queries: 40, ...}` would let every record be rewritten without moving
    // the pin, so assert the serialization actually carries them.
    const bytes = canonicalFixtureBytes();
    expect(bytes).toContain('optimizer only text 0');
    expect(bytes).toContain('guidance from an authorized trajectory');
    expect(bytes).toContain('receipt-23');
    expect(bytes).toContain('sha256:digest-23');
    expect(bytes).toContain('skill-correct-39');
    expect(bytes.length).toBeGreaterThan(100_000);

    // C1 — the re-check detects authority drift the baseline cannot see.
    expect(report.c1RetrievalRecheck).toMatchObject({
      detected: 168,
      total: 168,
      falseParks: 0,
      controls: 24,
    });
    expect(report.c1RetrievalRecheck.baseline).toMatchObject({
      detected: 0,
      admittedDriftedArtifacts: 168,
    });
    expect(report.c1RetrievalRecheck.perArtifactMeanMs).toBeLessThan(2);

    // C2 — artifact-level, and honest about what it does not cover.
    expect(report.c2OptimizerOnlyVisibility).toMatchObject({
      actorPaths: 4,
      leakedOptimizerContents: 0,
      optimizerVisibleIds: '8/8',
      leakedProvenanceIdentifiers: 0,
      launderingBlocked: '2/2',
      legacyByteIdentical: true,
    });
    expect(report.c2OptimizerOnlyVisibility.paraphraseBlocked).toContain(
      'known non-guarantee'
    );

    // C3 — the negative result is part of the evidence, not a footnote.
    expect(report.c3ValueAwareRanking.profilelessOrderPreserved).toBe('20/20');
    expect(report.c3ValueAwareRanking.valueTop3AttributedTokens).toBeLessThan(
      report.c3ValueAwareRanking.similarityTop3AttributedTokens
    );
    expect(
      report.c3ValueAwareRanking.adverseQueriesWhereCostDemotedTheCorrectSkill
    ).toBe(4);
    expect(report.c3ValueAwareRanking.top1Delta).toBe(-4);

    // C4 — bounded, contained, and absorbing under fault injection.
    expect(report.c4VerificationBudgetAndRails).toMatchObject({
      toolCalls: 50,
      roundsObserved: 5,
      status: 'exceeded',
      disabledRails: ['thrower', 'hanger'],
    });
    expect(report.c4VerificationBudgetAndRails.railWallMs).toBeLessThan(10_000);
    expect(
      report.c4VerificationBudgetAndRails.baseline.reachableWithoutABudget
    ).toBe(false);
  });
});
