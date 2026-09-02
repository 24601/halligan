import { describe, expect, it } from 'vitest';
import { evaluateGepaEvidenceManifests } from './evaluate-gepa-evidence-manifests.js';

describe('GEPA evidence manifest evaluation', () => {
  it('proves durability, refusal completeness, honest attribution and a replayable artifact without model calls', async () => {
    const result = await evaluateGepaEvidenceManifests();

    // ---- Claim 1: durability and asymmetric rollback ----------------------
    expect(result.ledgerSurvivedRollback).toBe(true);
    // Named for what it measures: a serialize/drop/replay store rebuild in
    // this process, which stands in for a restart and is not one.
    expect(result.ledgerSurvivedStoreRebuild).toBe(true);
    // THE BASELINE, asserted: with the mechanism off, the rollback retains
    // nothing. Without this, "survived" is a claim about a value that was
    // never at risk.
    expect(result.baselineRetainsNothingWithoutLedger).toBe(true);
    // The ledger's mergeability did not loosen the causal history's refusal.
    expect(result.divergentHistoryStillRefused).toBe(true);
    // ...and durability is bounded: permanent negative memory is structurally
    // impossible, so an entry past its TTL is gone.
    expect(result.entriesAfterTtl).toBe(0);

    // ---- Claim 2: refusal completeness, with controls ---------------------
    expect(result.refusals).toEqual({
      attribution_required: 'attribution_required',
      attribution_required_control: 'accepted',
      ablation_and_disclaimer: 'ablation_and_disclaimer',
      leave_one_out_partial_coverage: 'attribution_required',
      leave_one_out_unaffected: 'leave_one_out_unaffected',
      leave_one_out_duplicate: 'leave_one_out_duplicate',
      leave_one_out_uncharged: 'leave_one_out_uncharged',
      leave_one_out_control: 'accepted',
      effects_missing: 'effects_missing',
      effects_missing_control: 'accepted',
      effects_missing_unannotated: 'effects_missing',
      effects_missing_relabelled: 'effects_missing',
      effects_missing_unannotated_control: 'accepted',
      caller_policy_floor_effects: 'effects_missing',
      effects_on_steering_surface: 'effects_on_steering_surface',
      runtime_requirements_missing: 'runtime_requirements_missing',
      unsafe_replay_without_resolver: 'unsafe_replay_without_resolver',
      idempotent_without_key: 'idempotent_without_key',
      effects_control: 'accepted',
      new_writer_v3: 'new_writer_v3',
      receipt_covers_policy: 'receipt_verification_failed',
      caller_policy_floor: 'attribution_required',
      ledger_expiry_requires_ttl: 'expiry_requires_ttl',
      ledger_empty_expiry: 'empty_expiry',
    });
    // A gate that refuses everything is not a gate. Exactly the five control
    // cases are accepted, and every other row refuses with its own code.
    const accepted = Object.entries(result.refusals).filter(
      ([, code]) => code === 'accepted'
    );
    expect(accepted.map(([name]) => name)).toEqual([
      'attribution_required_control',
      'leave_one_out_control',
      'effects_missing_control',
      'effects_missing_unannotated_control',
      'effects_control',
    ]);
    expect(
      Object.values(result.refusals).some((code) =>
        code.startsWith('unmatched:')
      )
    ).toBe(false);

    // ---- Claim 3: attribution is never manufactured -----------------------
    expect(result.attributionSupportingRows).toEqual([
      'loo-a',
      'loo-b',
      'loo-c',
    ]);
    // THE NEGATIVE. On a fixture where removing any single component changes
    // nothing measurable, EVERY row comes back inconclusive. A pipeline that
    // manufactured support would report 'supports' here, and this assertion is
    // what makes the positive case above mean something.
    expect(result.attributionInconclusiveRetained).toEqual([
      'loo-a',
      'loo-b',
      'loo-c',
    ]);
    expect(result.attributionDerivedColumn).toEqual([
      'inconclusive',
      'inconclusive',
      'inconclusive',
    ]);

    // ---- Claim 4: admission at three severities ---------------------------
    // Exact, not approximate: the injected failures are deterministic.
    expect(result.admission.light.discardRate).toBeCloseTo(0.1, 10);
    expect(result.admission.light.anyBatchInconclusive).toBe(false);
    expect(result.admission.moderate.discardRate).toBeCloseTo(0.3, 10);
    // `avg`/`scalars`/`sum` keep their ALL-ROWS meaning: every evaluation
    // still reports all ten examples even though three of ten were discarded
    // from the promotion comparison.
    expect(
      result.admission.moderate.allRowsEvaluationCounts.every(
        (count) => count === 10
      )
    ).toBe(true);
    expect(result.admission.moderate.admittedRows).toBeLessThan(
      result.admission.moderate.evaluatedRows
    );
    // Below the per-batch floor: the round is SKIPPED rather than a candidate
    // being recorded as rejected on evidence that was never there, so the seed
    // is the only record.
    expect(result.admission.heavy.discardRate).toBeCloseTo(0.5, 10);
    expect(result.admission.heavy.anyBatchInconclusive).toBe(true);
    expect(result.admission.heavy.recordedCandidates).toBe(1);
    // The run-level ceiling catches what a per-batch floor structurally
    // cannot: a steady discard rate that clears the floor forever.
    expect(result.admission.ceiling.stoppedReason).toBe(
      'excessive_environment_failures'
    );
    expect(result.admission.ceiling.bestScore).toBe(0);
    expect(result.admission.ceiling.artifactPublished).toBe(false);
    // ...and the run still leaves its evidence behind, on the checkpoint.
    expect(result.admission.ceiling.manifestStillEmitted).toBe(true);

    // ---- Claim 5: the instrumented artifact still replays ------------------
    expect(result.legacyManifestVersion).toBe(3);
    expect(result.instrumentedManifestVersion).toBe(4);
    expect(result.instrumentedArtifactBytes).toBeLessThan(256 * 1024);
    expect(result.instrumentedArtifactBytes).toBeLessThan(
      result.maxArtifactBytes
    );
    // The failure mode is not size, it is unreplayability.
    expect(result.instrumentedArtifactRevalidates).toBe(true);
    // Instrumentation costs bytes, and the eval says how many rather than
    // implying it is free.
    expect(result.instrumentedArtifactBytes).toBeGreaterThan(
      result.legacyArtifactBytes
    );

    // ---- Budget -----------------------------------------------------------
    // Zero calls is DERIVED from two measurements, not asserted against
    // itself. The optimizers really did reach for the AI service they were
    // handed (so the counter is live, and a wrapper that saw nothing would
    // prove nothing), and every one of those reads resolved to `undefined`, so
    // there was no provider function to invoke.
    expect(result.budget.providerSurfaceReads).toBeGreaterThan(0);
    expect(result.budget.providerResolvedCallable).toBe(false);
    expect(result.budget.providerCalls).toBe(0);
    expect(result.budget.providerTokens).toBe(0);
    expect(result.budget.costUsd).toBe(0);
    expect(result.budget.elapsedWallTimeMs).toBeLessThanOrEqual(
      result.budget.maxWallTimeMs
    );
    // The honesty clause travels with the numbers.
    expect(result.honesty).toContain('no outcome-quality improvement');
  });
});
