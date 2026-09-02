import type { AxAIService } from '../ai/types.js';
import type { AxOptimizableComponent } from '../dsp/optimizable.js';
import type { AxOptimizedProgram } from '../dsp/optimizer.js';
import type {
  AxChatLogEntry,
  AxGenStreamingOut,
  AxProgramDemos,
  AxProgramForwardOptions,
  AxProgrammable,
  AxProgramStreamingForwardOptions,
  AxProgramTrace,
  AxProgramUsage,
} from '../dsp/types.js';
import type {
  AxEventContext,
  AxEventIngress,
  AxEventTarget,
} from '../event/types.js';
import type { AxMind } from './mind.js';
import type { AxMindThinker } from './types.js';

/** Runs one thinker step around the thinker's own program. */
export type AxMindStepRunner = (
  thinker: Readonly<AxMindThinker<any, any>>,
  inner: AxProgrammable<any, any>,
  ai: Readonly<AxAIService>,
  values: unknown,
  options?: Readonly<AxProgramForwardOptions<string>>
) => Promise<unknown>;

/** Builds IN from the wake. Throwing here dead-letters before any model call. */
export type AxMindStepAssembler = (
  thinker: Readonly<AxMindThinker<any, any>>,
  ingress: Readonly<AxEventIngress>,
  eventContext: Readonly<AxEventContext>
) => Promise<unknown>;

/**
 * The orchestration wrapper the runtime actually invokes. Every member
 * delegates to the thinker's own program, so `optimize()`, GEPA and the state
 * adapters keep working on the real subject; only `forward` is intercepted,
 * because that is where the work probe, the budget and the pace decision have
 * to bracket the run.
 */
export class AxMindStepProgram implements AxProgrammable<any, any> {
  constructor(
    private readonly run: AxMindStepRunner,
    private readonly thinker: Readonly<AxMindThinker<any, any>>,
    private readonly inner: AxProgrammable<any, any>
  ) {}

  forward(
    ai: Readonly<AxAIService>,
    values: any,
    options?: Readonly<AxProgramForwardOptions<string>>
  ): Promise<any> {
    return this.run(this.thinker, this.inner, ai, values, options);
  }

  /**
   * Deliberately NOT bracketed. A streaming forward has no single completion
   * point the probe and the pace decision can hang off, and pretending it did
   * would arm a wake from a half-finished run; the mind never selects
   * `execution: 'streaming'` for a thinker target.
   */
  streamingForward(
    ai: Readonly<AxAIService>,
    values: any,
    options?: Readonly<AxProgramStreamingForwardOptions<string>>
  ): AxGenStreamingOut<any> {
    return this.inner.streamingForward(ai, values, options);
  }

  getSignature() {
    return this.inner.getSignature();
  }
  getId(): string {
    return this.inner.getId();
  }
  setId(id: string): void {
    this.inner.setId(id);
  }
  getTraces(): AxProgramTrace<any, any>[] {
    return this.inner.getTraces();
  }
  setDemos(demos: readonly AxProgramDemos<any, any>[]): void {
    this.inner.setDemos(demos);
  }
  applyOptimization(optimized: AxOptimizedProgram<any>): void {
    this.inner.applyOptimization(optimized);
  }
  getOptimizableComponents(): readonly AxOptimizableComponent[] {
    return this.inner.getOptimizableComponents();
  }
  applyOptimizedComponents(updates: Readonly<Record<string, string>>): void {
    this.inner.applyOptimizedComponents(updates);
  }
  getUsage(): AxProgramUsage[] {
    return this.inner.getUsage() as AxProgramUsage[];
  }
  getChatLog(): readonly AxChatLogEntry[] {
    return this.inner.getChatLog();
  }
  resetUsage(): void {
    this.inner.resetUsage();
  }
}

/**
 * A thinker rendered as an `AxEventTarget`, which is what makes it compose as
 * a flow node, an event target and an `optimize()` subject for free. The
 * assembler lands in `mapInput` position on purpose: the runtime wraps a throw
 * there as `AxEventInputError` and dead-letters the delivery BEFORE the
 * program is resolved, so a broken projection never spends a token (M19).
 */
export function axMindThinkerTarget(
  thinker: Readonly<AxMindThinker<any, any>>,
  hooks: Readonly<{
    run: AxMindStepRunner;
    assemble: AxMindStepAssembler;
    mind: () => AxMind;
  }>
): AxEventTarget<any, any> {
  const wrap = (inner: AxProgrammable<any, any>) =>
    new AxMindStepProgram(hooks.run, thinker, inner);
  return {
    id: thinker.name,
    ai: thinker.ai,
    ...(thinker.program ? { program: wrap(thinker.program) } : {}),
    ...(thinker.createProgram
      ? {
          createProgram: async (instance: Readonly<{ instanceKey: string }>) =>
            wrap(
              await thinker.createProgram!({
                thinker: thinker.name,
                instanceKey: instance.instanceKey,
                mind: hooks.mind(),
              })
            ),
        }
      : {}),
    mapInput: (ingress, context) =>
      hooks.assemble(thinker, ingress, context.eventContext),
    ...(thinker.forwardOptions
      ? { forwardOptions: thinker.forwardOptions }
      : {}),
    ...(thinker.sinks ? { sinks: [...thinker.sinks] } : {}),
    ...(thinker.retrySafety ? { retrySafety: thinker.retrySafety } : {}),
  };
}
