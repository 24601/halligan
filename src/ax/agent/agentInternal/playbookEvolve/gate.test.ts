import { describe, expect, it } from 'vitest';

import type {
  AxAgentPromotionGateBatch,
  AxAgentPromotionGateInput,
} from './gate.js';
import { evaluateAgentPromotionGate } from './gate.js';

const EPSILON = 0.01;
const GAIN_THRESHOLD = 0.05;

/** A batch that ran to completion with the given mean. */
function batch(
  mean: number,
  override: Partial<AxAgentPromotionGateBatch> = {}
): AxAgentPromotionGateBatch {
  return { mean, complete: true, exhausted: false, ...override };
}

function input(
  override: Partial<AxAgentPromotionGateInput> = {}
): AxAgentPromotionGateInput {
  return {
    heldIn: 0.5,
    revalTrain: batch(0.7),
    epsilon: EPSILON,
    currentGainThreshold: GAIN_THRESHOLD,
    requireHeldOut: false,
    hasRetentionPolicy: false,
    retentionOk: true,
    retentionBatchesComplete: true,
    ...override,
  };
}

describe('evaluateAgentPromotionGate', () => {
  it('accepts a completed re-eval that clears the gain threshold', () => {
    const verdict = evaluateAgentPromotionGate(input());
    expect(verdict.accept).toBe(true);
    expect(verdict.currentGain).toBeCloseTo(0.2, 10);
    expect(verdict.reason).toBe(
      'held-in improved (no held-out set provided — consider one)'
    );
  });

  it('rejects a gain below the threshold and names the measured gain', () => {
    const verdict = evaluateAgentPromotionGate(
      input({ revalTrain: batch(0.52) })
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.gainOk).toBe(false);
    expect(verdict.reason).toBe('held-in gain 0.020 below 0.05');
  });

  it('rejects a held-out regression beyond epsilon', () => {
    const verdict = evaluateAgentPromotionGate(
      input({
        heldOut: 0.8,
        revalHeldOut: 0.6,
        revalHeldOutBatch: batch(0.6),
      })
    );
    expect(verdict.heldOutOk).toBe(false);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe('held-out regressed -0.200');
  });

  it('tolerates a held-out drop within epsilon', () => {
    const verdict = evaluateAgentPromotionGate(
      input({
        heldOut: 0.8,
        revalHeldOut: 0.795,
        revalHeldOutBatch: batch(0.795),
      })
    );
    expect(verdict.heldOutOk).toBe(true);
    expect(verdict.accept).toBe(true);
    expect(verdict.reason).toBe('held-in improved, held-out non-regressing');
  });

  it('is vacuously held-out-ok when no held-out split ran', () => {
    // This is the permissive regime the docs warn about: with no validation
    // split the headline "held-out within epsilon" claim is not being made.
    const verdict = evaluateAgentPromotionGate(input({ heldOut: 0.9 }));
    expect(verdict.heldOutOk).toBe(true);
    expect(verdict.accept).toBe(true);
  });

  it('refuses an exhausted re-eval before gain is consulted', () => {
    const verdict = evaluateAgentPromotionGate(
      input({ revalTrain: batch(0.99, { complete: false, exhausted: true }) })
    );
    expect(verdict.revalComplete).toBe(false);
    expect(verdict.gainOk).toBe(false);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe('metric_budget exhausted during re-evaluation');
  });

  it('names the incomplete side when requireHeldOut is set', () => {
    const heldInIncomplete = evaluateAgentPromotionGate(
      input({
        requireHeldOut: true,
        revalTrain: batch(0.7, { complete: false }),
        revalHeldOutBatch: batch(0.7),
        heldOut: 0.5,
        revalHeldOut: 0.7,
      })
    );
    expect(heldInIncomplete.reason).toBe(
      'held-in evaluation incomplete or errored'
    );

    const heldOutMissing = evaluateAgentPromotionGate(
      input({ requireHeldOut: true })
    );
    expect(heldOutMissing.accept).toBe(false);
    expect(heldOutMissing.reason).toBe(
      'held-out evaluation incomplete or errored'
    );
  });

  it('requires every retention slice batch to be complete', () => {
    const verdict = evaluateAgentPromotionGate(
      input({ hasRetentionPolicy: true, retentionBatchesComplete: false })
    );
    expect(verdict.revalComplete).toBe(false);
    expect(verdict.accept).toBe(false);
  });

  it('reports the measured historical loss when retention fails', () => {
    const verdict = evaluateAgentPromotionGate(
      input({
        hasRetentionPolicy: true,
        retentionOk: false,
        retentionLoss: { worst: 0.25, mean: 0.125 },
      })
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe(
      'historical loss exceeded retention threshold (worst 0.250, mean 0.125)'
    );
  });

  it('uses the retention wording for an accepted retention run', () => {
    const verdict = evaluateAgentPromotionGate(
      input({ hasRetentionPolicy: true })
    );
    expect(verdict.accept).toBe(true);
    expect(verdict.reason).toBe(
      'current task improved, historical retention thresholds satisfied'
    );
    expect(verdict.reason).not.toContain('current-task gain');
  });

  it('uses current-task wording for a retention gain shortfall', () => {
    const verdict = evaluateAgentPromotionGate(
      input({ hasRetentionPolicy: true, revalTrain: batch(0.5) })
    );
    expect(verdict.reason).toBe('current-task gain 0.000 below 0.05');
  });
});
