/**
 * `AxAgentPlaybook` — the agent-facing playbook handle returned by
 * `agent.playbook()` / `agent.getPlaybook()`.
 *
 * It is one thing (the agent's learned playbook) that grows three ways:
 *  - continuously, from each run (the `playbook` construction config);
 *  - on demand from one interaction, via {@link update} (trust);
 *  - from a task set, via {@link evolve} (verified by default, or trust-batch).
 *
 * The generic program-level `AxPlaybook` (from the `playbook(program, …)`
 * factory) is unchanged; this wraps one bound to an agent stage and adds the
 * agent-level `evolve(dataset, options)`. The shared handle methods delegate
 * to the inner `AxPlaybook`.
 */

import type { AxACEPlaybookRenderOptions } from '../../dsp/optimizers/acePlaybook.js';
import type { AxACEHostEvidence } from '../../dsp/optimizers/aceTypes.js';
import type { AxPlaybook, AxPlaybookSnapshot } from '../../dsp/playbook.js';
import type { AxGenIn, AxGenOut } from '../../dsp/types.js';
import type { AxAgentEvalDataset } from './agentOptimizeTypes.js';
import { evolveAgentPlaybook } from './playbookEvolve/playbookEvolve.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveResult,
} from './playbookEvolve/playbookEvolveTypes.js';

export class AxAgentPlaybook<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> {
  constructor(
    /** The owning agent coordinator (used by `evolve`). */
    private readonly agent: unknown,
    /** The inner stage-bound playbook the handle methods delegate to. */
    private readonly handle: AxPlaybook<IN, OUT>
  ) {}

  /**
   * Grow the playbook from a task set. `verify` (default) keeps only bullets
   * that provably help — re-scoring train + held-out after each candidate and
   * rolling back regressions. `verify: false` applies mined lessons without
   * the gate (trust-batch). `requireHeldOut` enables fail-closed production
   * promotion and cannot be combined with `verify: false`. Produces only
   * playbook bullets. Must not run concurrently with `forward()` on the same
   * agent instance.
   */
  public evolve(
    dataset: Readonly<AxAgentEvalDataset<IN>>,
    options?: Readonly<AxAgentPlaybookEvolveOptions<IN>>
  ): Promise<AxAgentPlaybookEvolveResult<OUT>> {
    return evolveAgentPlaybook<IN, OUT>(this.agent, dataset, options);
  }

  /** Refine the playbook from a single live interaction (trust). */
  public update(
    args: Readonly<{
      example: unknown;
      prediction: unknown;
      feedback?: string;
      evidence?: AxACEHostEvidence;
    }>
  ): Promise<void> {
    return this.handle.update(args as never);
  }

  /** The current playbook rendered as a markdown block. */
  public render(options?: Readonly<AxACEPlaybookRenderOptions>): string {
    return this.handle.render(options);
  }

  /** Re-apply the playbook to the live agent stage with retrieval conditions. */
  public applyTo(options?: Readonly<AxACEPlaybookRenderOptions>): void {
    this.handle.applyTo(undefined, options);
  }

  /** Attach trusted host/evaluator evidence without invoking the LM. */
  public recordEvidence(
    bulletIds: readonly string[],
    evidence: Readonly<AxACEHostEvidence>
  ): readonly string[] {
    return this.handle.recordEvidence(bulletIds, evidence);
  }

  /** A serializable snapshot of the current playbook and its history. */
  public getState(): AxPlaybookSnapshot {
    return this.handle.getState();
  }

  /** Alias of {@link getState} so `JSON.stringify(handle)` yields a snapshot. */
  public toJSON(): AxPlaybookSnapshot {
    return this.handle.toJSON();
  }

  /** Restore a snapshot and render it into the live stage. */
  public load(snapshot: Readonly<AxPlaybookSnapshot>): this {
    this.handle.load(snapshot);
    return this;
  }

  /** Clear the playbook back to its initial state. */
  public reset(): void {
    this.handle.reset();
  }

  /** Set the evolution intensity preset. */
  public configureAuto(level: 'light' | 'medium' | 'heavy'): void {
    this.handle.configureAuto(level);
  }

  /** The inner program-level playbook handle (for advanced use). */
  public get inner(): AxPlaybook<IN, OUT> {
    return this.handle;
  }
}
