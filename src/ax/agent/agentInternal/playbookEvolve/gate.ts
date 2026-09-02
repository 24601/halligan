/**
 * The shared promotion gate for verified playbook / harness learning.
 *
 * Extracted verbatim from `playbookEvolve.ts` so `agent.playbook().evolve()`
 * and the `src/ax/learn/` harness evolution step decide acceptance with one
 * piece of code instead of two that drift. The retention *computation*
 * (sequence counter, anchors, digests, receipt assembly) deliberately stays in
 * `playbookEvolve.ts`: it closes over a mutable counter and seven anchor
 * locals, and only the decision and its human-readable reason are shared.
 *
 * Internal: reached through `evolve()` / `axHarnessEvolve`, never directly.
 */

import type { AxAgentEvalBatchResult } from './evalHarness.js';

/**
 * The completeness signals the gate reads off a batch result. Structural so a
 * caller may pass an `AxAgentEvalBatchResult` of any IN/OUT instantiation.
 */
export type AxAgentPromotionGateBatch = Readonly<
  Pick<AxAgentEvalBatchResult, 'complete' | 'exhausted' | 'mean'>
>;

export type AxAgentPromotionGateInput = Readonly<{
  /** Baseline held-in mean the candidate must beat. */
  heldIn: number;
  /** Re-evaluated held-in batch for the candidate. */
  revalTrain: AxAgentPromotionGateBatch;
  /** Baseline held-out mean. Absent ⇒ `heldOutOk` is vacuously true. */
  heldOut?: number;
  /** Re-evaluated held-out mean. Absent ⇒ `heldOutOk` is vacuously true. */
  revalHeldOut?: number;
  /** Re-evaluated held-out batch, when one ran. */
  revalHeldOutBatch?: AxAgentPromotionGateBatch;
  epsilon: number;
  currentGainThreshold: number;
  requireHeldOut: boolean;
  /** True when the caller ran a retention policy. Shapes `revalComplete` and the reason wording. */
  hasRetentionPolicy: boolean;
  /** Computed by the caller from its own anchors. `true` when no policy ran. */
  retentionOk: boolean;
  /** `true` when no policy ran; otherwise every retention slice batch completed. */
  retentionBatchesComplete: boolean;
  /**
   * The measured historical losses, used only for the retention-failure reason
   * string. The caller computes them alongside its receipt.
   */
  retentionLoss?: Readonly<{ worst: number; mean: number }>;
}>;

export type AxAgentPromotionGateVerdict = Readonly<{
  accept: boolean;
  reason: string;
  revalComplete: boolean;
  gainOk: boolean;
  heldOutOk: boolean;
  retentionOk: boolean;
  currentGain: number;
}>;

/**
 * Decide whether a re-evaluated candidate may be promoted, and say why in one
 * sentence a human can act on.
 *
 * The rule is unchanged from `evolve()`: a comparison against a baseline is
 * only meaningful when the re-evaluation actually ran to completion, so an
 * exhausted or errored batch refuses the accept before gain or held-out are
 * even consulted.
 */
export function evaluateAgentPromotionGate(
  input: Readonly<AxAgentPromotionGateInput>
): AxAgentPromotionGateVerdict {
  const {
    heldIn,
    revalTrain,
    heldOut,
    revalHeldOut,
    revalHeldOutBatch,
    epsilon,
    currentGainThreshold,
    requireHeldOut,
    hasRetentionPolicy,
    retentionOk,
    retentionBatchesComplete,
    retentionLoss,
  } = input;

  // A re-eval that exhausted mid-way produced a subset mean — comparing it
  // to the full-set baseline is apples-to-oranges, so refuse the accept.
  const revalComplete = hasRetentionPolicy
    ? revalTrain.complete &&
      (revalHeldOutBatch?.complete ?? true) &&
      retentionBatchesComplete
    : requireHeldOut
      ? revalTrain.complete && revalHeldOutBatch?.complete === true
      : !revalTrain.exhausted && !revalHeldOutBatch?.exhausted;
  const currentGain = revalTrain.mean - heldIn;
  const gainOk = revalComplete && currentGain >= currentGainThreshold;
  const heldOutOk =
    revalHeldOut === undefined ||
    heldOut === undefined ||
    revalHeldOut - heldOut >= -epsilon;
  const accept = revalComplete && gainOk && heldOutOk && retentionOk;

  const reason =
    requireHeldOut && !revalTrain.complete
      ? 'held-in evaluation incomplete or errored'
      : requireHeldOut && revalHeldOutBatch?.complete !== true
        ? 'held-out evaluation incomplete or errored'
        : !revalComplete
          ? 'metric_budget exhausted during re-evaluation'
          : accept
            ? hasRetentionPolicy
              ? 'current task improved, historical retention thresholds satisfied'
              : heldOut === undefined
                ? 'held-in improved (no held-out set provided — consider one)'
                : 'held-in improved, held-out non-regressing'
            : !gainOk
              ? hasRetentionPolicy
                ? `current-task gain ${currentGain.toFixed(3)} below ${currentGainThreshold}`
                : `held-in gain ${currentGain.toFixed(3)} below ${currentGainThreshold}`
              : !heldOutOk
                ? `held-out regressed ${((revalHeldOut ?? 0) - (heldOut ?? 0)).toFixed(3)}`
                : `historical loss exceeded retention threshold (worst ${retentionLoss?.worst.toFixed(3)}, mean ${retentionLoss?.mean.toFixed(3)})`;

  return {
    accept,
    reason,
    revalComplete,
    gainOk,
    heldOutOk,
    retentionOk,
    currentGain,
  };
}
