import type { AxFunction } from '../ai/types.js';
import type {
  AxTrajectoryStep,
  AxTrajectoryStore,
} from '../trajectory/types.js';
import type { AxMindSalienceBuffer, AxMindSalienceItem } from './types.js';

const DEFAULT_MAX_ITEMS = 32;

export interface AxMindSalienceBufferOptions {
  readonly maxItems?: number;
  /** Fired when a thinker takes an item, for the `salience-injected` audit. */
  readonly onTake?: (
    item: Readonly<AxMindSalienceItem>,
    thinker: string
  ) => void;
}

/**
 * Dedupe is GLOBAL by source step, not per thinker: the injection block runs
 * once per busy subscribed thinker, and N subscribers meant N identical
 * injections of one message. That was the triple-reply bug.
 */
export const axMindSalienceBuffer = (
  options?: Readonly<AxMindSalienceBufferOptions>
): AxMindSalienceBuffer => {
  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const offered = new Set<string>();
  const queue: Readonly<AxMindSalienceItem>[] = [];
  return {
    offer(item) {
      if (offered.has(item.sourceStepId)) return false;
      // The buffer is a mid-run convenience, not a queue of record. Refusing
      // past the bound loses nothing: the message is a durable step, and the
      // next projection includes it.
      if (queue.length >= maxItems) return false;
      offered.add(item.sourceStepId);
      queue.push(Object.freeze({ ...item }));
      return true;
    },
    take(thinker) {
      const item = queue.shift();
      if (item) options?.onTake?.(item, thinker);
      return item;
    },
    get size() {
      return queue.length;
    },
  };
};

/**
 * Fixed text. It says plainly that the tool call did not run, because the only
 * in-flight steering seam ax has ends the turn: `guideAgent` throws
 * `AxAgentProtocolCompletionSignal('guide_agent')`, so the wrapped handler
 * never executes and the actor has to make the call again.
 */
export function axMindSalienceGuidance(
  item: Readonly<AxMindSalienceItem>,
  toolName: string
): string {
  return [
    `A message arrived while you are mid-task (step ${item.sourceStepId}): ${item.text}`,
    'If a brief accurate answer is possible from what you already know, send it now and continue.',
    'If it needs the work you are doing, send one short line saying you are on it.',
    'One reply at most. If a reply already appears later in the log, ignore this.',
    'Do not abandon or restart your current task.',
    `The ${toolName} call you just made did NOT run -- make it again.`,
  ].join(' ');
}

/**
 * Wraps host functions so a pending salience item ends the turn once, BEFORE
 * the underlying handler runs. The cost is one aborted tool call; that is the
 * price of using the only seam that exists, and it is stated rather than
 * hidden. A turn that calls no host function sees nothing mid-run -- the item
 * stays in the buffer and the next step's projection carries the message.
 */
export function axWithMindSalience(
  functions: readonly AxFunction[],
  buffer: AxMindSalienceBuffer,
  thinker: string
): readonly AxFunction[] {
  return Object.freeze(
    functions.map((fn) => ({
      ...fn,
      func: (args?: unknown, extra?: Parameters<AxFunction['func']>[1]) => {
        const guide = extra?.protocol?.guideAgent;
        // Only take when there is somewhere to inject: taking without a seam
        // would consume the item and lose the injection entirely.
        if (guide) {
          const item = buffer.take(thinker);
          if (item) return guide(axMindSalienceGuidance(item, fn.name));
        }
        return fn.func(args, extra);
      },
    }))
  );
}

/**
 * The audit trail for one injection. `feedback` is a machinery type the
 * registry declares `wakeable: false`, so recording the injection can never
 * re-dispatch the very run it was injected into (M17).
 */
export async function axRecordMindSalience(
  store: AxTrajectoryStore,
  options: Readonly<{
    trajectoryId: string;
    thinker: string;
    item: Readonly<AxMindSalienceItem>;
  }>,
  signal?: AbortSignal
): Promise<Readonly<AxTrajectoryStep>> {
  const receipt = await store.append(
    {
      trajectoryId: options.trajectoryId,
      type: 'feedback',
      launchedBy: options.thinker,
      triggerStep: options.item.sourceStepId,
      data: {
        content: options.item.text,
        injectedAt: options.item.createdAt,
      },
    },
    signal
  );
  const step = await store.getStep(
    options.trajectoryId,
    receipt.stepId,
    signal
  );
  return step!;
}
