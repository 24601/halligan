import type { AxAIService } from '../ai/types.js';
import { ax } from '../dsp/template.js';
import {
  type AxTrajectoryProjectionOptions,
  axTrajectoryDefaultFanout,
  axTrajectoryScanPageSteps,
  checkMeta,
  endSeqOf,
  narrativeTypes,
  type ScanCursor,
  scanForward,
  seqAtIndex,
  stepText,
} from './projection.js';
import { axTrajectoryTypeRegistry } from './registry.js';
import { axResolveTrajectorySteps } from './spill.js';
import { AxTrajectoryRollupError } from './types.js';
import { axTrajectoryTruncateUtf8, positiveOr } from './util.js';

/** Derived: bytes kept from one block summary. */
export const axTrajectoryMaxSummaryBytes = 600;
/** Derived: themes kept per block. Together they may not outweigh the summary. */
export const axTrajectoryMaxThemes = 5;

export interface AxTrajectoryRollupBlock {
  readonly tier: number;
  /** Absolute filtered-step index range, half-open. NEVER shifts. Keys the block. */
  readonly start: number;
  readonly end: number;
  readonly n: number;
  /** First person. This is the agent's own memory of its life. */
  readonly summary: string;
  readonly themes: readonly string[];
  /** Cited raw step ids -- the index back to the source of truth. */
  readonly stepIds: readonly string[];
  /** A cache that cannot say what produced it is a guess, not a cache. */
  readonly summarizerId: string;
  readonly promptVersion: string;
  readonly createdAt: number;
}

export interface AxTrajectoryRollupMeta {
  readonly version: number;
  readonly fanout: number;
  /** Forward-only enablement marker, SNAPPED DOWN to a fanout boundary. */
  readonly startIndex: number;
  readonly types: readonly string[];
  /**
   * Checkpoint (not in the RFC): the filtered index tier 1 is sealed up to,
   * and the raw `seq` immediately after it. Forward-only. A cache that cannot
   * say where it stopped forces an O(N) rescan on every wake, which is the
   * cost the projection exists to remove.
   */
  readonly sealedIndex: number;
  readonly sealedSeq: number;
  /**
   * Per-tier settled frontier: `frontier[k - 2]` is the filtered index above
   * which tier `k` still has blocks to consider. Without it every build
   * re-probes every coarse block ever sealed, which is O(N / F^2) store reads
   * on a wakeup that should cost O(maxBlocks).
   */
  readonly frontier?: readonly number[];
}

export interface AxTrajectoryRollupStore {
  loadMeta(
    trajectoryId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryRollupMeta> | undefined>;
  saveMeta(
    trajectoryId: string,
    meta: Readonly<AxTrajectoryRollupMeta>,
    signal?: AbortSignal
  ): Promise<void>;
  getBlock(
    trajectoryId: string,
    tier: number,
    start: number,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryRollupBlock> | undefined>;
  /**
   * Sealed blocks are immutable; a second put on one key throws
   * AxTrajectoryRollupError('block_already_sealed').
   */
  putBlock(
    trajectoryId: string,
    block: Readonly<AxTrajectoryRollupBlock>,
    signal?: AbortSignal
  ): Promise<void>;
}

export class AxInMemoryTrajectoryRollupStore
  implements AxTrajectoryRollupStore
{
  private readonly metas = new Map<string, Readonly<AxTrajectoryRollupMeta>>();
  private readonly blocks = new Map<
    string,
    Readonly<AxTrajectoryRollupBlock>
  >();

  // Length-prefixed so no two (trajectoryId, tier, start) triples can collide
  // through a separator that appears in an id.
  private key(trajectoryId: string, tier: number, start: number): string {
    return `${trajectoryId.length}:${trajectoryId}/${tier}/${start}`;
  }

  async loadMeta(trajectoryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.metas.get(trajectoryId);
  }

  async saveMeta(
    trajectoryId: string,
    meta: Readonly<AxTrajectoryRollupMeta>,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    this.metas.set(
      trajectoryId,
      Object.freeze({ ...meta, types: Object.freeze([...meta.types]) })
    );
  }

  async getBlock(
    trajectoryId: string,
    tier: number,
    start: number,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    return this.blocks.get(this.key(trajectoryId, tier, start));
  }

  async putBlock(
    trajectoryId: string,
    block: Readonly<AxTrajectoryRollupBlock>,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const key = this.key(trajectoryId, block.tier, block.start);
    if (this.blocks.has(key)) {
      throw new AxTrajectoryRollupError(
        `rollup block tier ${block.tier} [${block.start}, ${block.end}) is already sealed`,
        'block_already_sealed'
      );
    }
    this.blocks.set(
      key,
      Object.freeze({
        ...block,
        themes: Object.freeze([...block.themes]),
        stepIds: Object.freeze([...block.stepIds]),
      })
    );
  }

  /** Drops every sealed block, keeping meta. Proves tiers are an optimization. */
  deleteBlocks(): number {
    const dropped = this.blocks.size;
    this.blocks.clear();
    return dropped;
  }
}

export interface AxTrajectorySummarizerRequest {
  readonly tier: number;
  readonly start: number;
  readonly end: number;
  /** Raw steps at tier 1; child block summaries above. Never re-summarized raw. */
  readonly inputs: readonly Readonly<{ id: string; text: string }>[];
  readonly signal?: AbortSignal;
}

export interface AxTrajectorySummarizerResult {
  readonly summary: string;
  readonly themes?: readonly string[];
  readonly stepIds?: readonly string[];
}

export type AxTrajectorySummarizer = Readonly<{
  id: string;
  promptVersion: string;
  summarize(
    request: Readonly<AxTrajectorySummarizerRequest>
  ): Promise<Readonly<AxTrajectorySummarizerResult>>;
}>;

/** The rollup program's signature. One generation, no tools, no loop. */
export const axTrajectoryRollupSignature =
  'trajectoryTier:number "1 summarizes raw steps; above that, child summaries", trajectorySpan:string "the absolute filtered-step range", trajectoryEntries:string[] "oldest first" -> lifeSummary:string "first person, past tense, one paragraph", lifeThemes:string[] "two to five short noun phrases", citedStepIds:string[] "ids from the entries that carry the summary"';

export interface AxTrajectoryProgramSummarizerOptions {
  readonly ai: AxAIService;
  /** Stamped on every block. Defaults to the model name the service reports. */
  readonly id?: string;
  /** Bump when the signature or its instructions change. Default '1'. */
  readonly promptVersion?: string;
  readonly signature?: string;
  /** Truncates one entry so a pathological step cannot blow the request. */
  readonly maxEntryChars?: number;
}

/**
 * The summarizer is an ax program behind a signature, not a prompt string
 * pasted into the projection: it is optimizable, swappable and inspectable
 * like every other program in the library.
 */
export function axTrajectoryProgramSummarizer(
  options: Readonly<AxTrajectoryProgramSummarizerOptions>
): AxTrajectorySummarizer {
  const program = ax(options.signature ?? axTrajectoryRollupSignature);
  const maxEntryChars = positiveOr(options.maxEntryChars ?? 4_000, 4_000);
  return Object.freeze({
    id: options.id ?? options.ai.getName(),
    promptVersion: options.promptVersion ?? '1',
    async summarize(request: Readonly<AxTrajectorySummarizerRequest>) {
      const result = await program.forward(
        options.ai,
        {
          trajectoryTier: request.tier,
          trajectorySpan: `[${request.start}, ${request.end})`,
          trajectoryEntries: request.inputs.map(
            (input) => `${input.id}: ${input.text.slice(0, maxEntryChars)}`
          ),
        },
        request.signal ? { abortSignal: request.signal } : undefined
      );
      return {
        summary: String(result.lifeSummary ?? ''),
        themes: Array.isArray(result.lifeThemes)
          ? result.lifeThemes.map(String)
          : [],
        stepIds: Array.isArray(result.citedStepIds)
          ? result.citedStepIds.map(String)
          : undefined,
      };
    },
  });
}

export interface AxDeterministicTrajectorySummarizerOptions {
  readonly id?: string;
  readonly promptVersion?: string;
  /** Entries quoted in the summary head and tail. Default 1 each. */
  readonly quoted?: number;
  /**
   * Characters kept per quoted entry. Default 60. A summarizer whose output
   * grows with its input is not summarizing: without this the stub's tier-k
   * summary embeds its children's text and the staircase stops being
   * logarithmic in RENDERED SIZE while still being logarithmic in sections.
   */
  readonly quoteChars?: number;
}

/**
 * A summarizer with no provider behind it. It is what the evaluation and the
 * tests run on, and it is shipped rather than hidden in a test file because a
 * host that wants tiered recall without a model bill can use it directly.
 */
export function axDeterministicTrajectorySummarizer(
  options?: Readonly<AxDeterministicTrajectorySummarizerOptions>
): AxTrajectorySummarizer {
  const quoted = Math.max(1, Math.floor(options?.quoted ?? 1));
  const quoteChars = Math.max(8, Math.floor(options?.quoteChars ?? 60));
  const clip = (text: string): string => text.slice(0, quoteChars);
  return Object.freeze({
    id: options?.id ?? 'deterministic',
    promptVersion: options?.promptVersion ?? '1',
    async summarize(request: Readonly<AxTrajectorySummarizerRequest>) {
      request.signal?.throwIfAborted();
      const texts = request.inputs.map((input) => input.text);
      const head = texts.slice(0, quoted).map(clip).join(' | ');
      const tail = texts.slice(-quoted).map(clip).join(' | ');
      const themes = [
        ...new Set(texts.map((text) => text.split(/[\s:]+/)[0] ?? '')),
      ]
        .filter((theme) => theme.length > 0)
        .sort()
        .slice(0, 5);
      return {
        summary: `steps ${request.start}-${request.end}: ${head}${
          texts.length > quoted ? ` ... ${tail}` : ''
        } (${texts.length} entries)`,
        themes,
        stepIds: request.inputs.map((input) => input.id),
      };
    },
  });
}

export interface AxTrajectoryBuildRollupsOptions
  extends AxTrajectoryProjectionOptions {
  readonly rollups: AxTrajectoryRollupStore;
  readonly summarizer: AxTrajectorySummarizer;
  /**
   * Max summarizer ATTEMPTS per call -- sealed plus failed -- so one wakeup
   * cannot stall. Default 8. Bounding successes alone would let a summarizer
   * that is failing (a provider outage, say) drain the whole log at one
   * provider request per `fanout` steps.
   */
  readonly maxBlocks?: number;
  /** Derived escape hatch: bytes kept from one summary. Default 600. */
  readonly maxSummaryBytes?: number;
  /** Explicit offline backfill below startIndex. Default false. */
  readonly backfill?: boolean;
}

export interface AxTrajectoryBuildRollupsResult {
  readonly sealed: number;
  /** Blocks that already existed. Idempotent per summarizer. */
  readonly skipped: number;
  /** Blocks whose summarizer threw. Counted, never fatal (RFC 6.4). */
  readonly failed: number;
  readonly tiersTouched: readonly number[];
}

async function sealBlock(
  options: Readonly<AxTrajectoryBuildRollupsOptions>,
  tier: number,
  start: number,
  end: number,
  inputs: readonly Readonly<{ id: string; text: string }>[],
  allowedIds: ReadonlySet<string>
): Promise<boolean> {
  // A summarizer whose output does not shrink is not summarizing, and a
  // provider-backed one cannot be trusted to self-limit: without a seal-time
  // clip the staircase stays logarithmic in SECTIONS while its rendered size
  // grows with the log, which is the number the budget is spent in.
  const maxSummaryBytes = positiveOr(
    options.maxSummaryBytes ?? axTrajectoryMaxSummaryBytes,
    axTrajectoryMaxSummaryBytes
  );
  const maxThemeBytes = Math.max(
    16,
    Math.floor(maxSummaryBytes / axTrajectoryMaxThemes)
  );
  const result = await options.summarizer.summarize({
    tier,
    start,
    end,
    inputs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  // A summarizer that cites an id outside its own block would fake coverage a
  // drill-down cannot honour, so cited ids are filtered against the block.
  const cited = (result.stepIds ?? inputs.map((input) => input.id)).filter(
    (stepId) => allowedIds.has(stepId)
  );
  await options.rollups.putBlock(
    options.trajectoryId,
    {
      tier,
      start,
      end,
      n: end - start,
      summary: axTrajectoryTruncateUtf8(result.summary, maxSummaryBytes),
      themes: (result.themes ?? [])
        .slice(0, axTrajectoryMaxThemes)
        .map((theme) => axTrajectoryTruncateUtf8(theme, maxThemeBytes)),
      stepIds: cited.length > 0 ? cited : [...allowedIds],
      summarizerId: options.summarizer.id,
      promptVersion: options.summarizer.promptVersion,
      createdAt: options.store.clock.now(),
    },
    options.signal
  );
  return true;
}

/** Seals every block whose fanout children now exist. Idempotent per summarizer. */
export async function axBuildTrajectoryRollups(
  options: Readonly<AxTrajectoryBuildRollupsOptions>
): Promise<Readonly<AxTrajectoryBuildRollupsResult>> {
  const registry = options.registry ?? axTrajectoryTypeRegistry();
  const types = narrativeTypes(registry, options.types);
  const fanout = Math.max(
    2,
    Math.floor(positiveOr(options.fanout ?? axTrajectoryDefaultFanout, 10))
  );
  const maxBlocks = Math.max(1, Math.floor(options.maxBlocks ?? 8));
  const endSeq = await endSeqOf(options);
  let meta = await options.rollups.loadMeta(
    options.trajectoryId,
    options.signal
  );
  if (meta) {
    checkMeta(meta, fanout, types, endSeq);
  } else {
    // Forward-only enablement, SNAPPED DOWN to a fanout boundary: an unsnapped
    // marker leaves the straddling block permanently unbuildable, which is a
    // coverage hole exactly at the enable point.
    let startIndex = 0;
    let at: ScanCursor = { index: 0, seq: 0 };
    if (!options.backfill) {
      const now = await scanForward(options, types, at, endSeq);
      startIndex = Math.floor(now.index / fanout) * fanout;
      at =
        startIndex === now.index
          ? now
          : await seqAtIndex(options, types, endSeq, startIndex);
    }
    meta = {
      version: 1,
      fanout,
      startIndex,
      types,
      sealedIndex: startIndex,
      sealedSeq: at.seq,
    };
    await options.rollups.saveMeta(options.trajectoryId, meta, options.signal);
  }

  const tiersTouched = new Set<number>();
  let sealed = 0;
  let skipped = 0;
  let failed = 0;
  // `maxBlocks` bounds summarizer ATTEMPTS. Counting only successes makes
  // every guard below a no-op the moment the summarizer starts failing, and
  // the call then drains the whole log at one provider request per block.
  const attempted = () => sealed + failed;
  let cursor: ScanCursor = { index: meta.sealedIndex, seq: meta.sealedSeq };
  let checkpoint: ScanCursor = cursor;
  let stalled = false;
  let pending: Readonly<{ id: string; text: string; seq: number }>[] = [];
  let pendingStart = cursor.index;

  const flush = async (): Promise<void> => {
    const start = pendingStart;
    const end = start + fanout;
    const batch = pending.slice(0, fanout);
    pending = pending.slice(fanout);
    pendingStart = end;
    tiersTouched.add(1);
    const existing = await options.rollups.getBlock(
      options.trajectoryId,
      1,
      start,
      options.signal
    );
    if (existing) {
      skipped += 1;
    } else {
      try {
        await sealBlock(
          options,
          1,
          start,
          end,
          batch,
          new Set(batch.map((input) => input.id))
        );
        sealed += 1;
      } catch {
        // RFC 6.4: skipped, counted, retried next build. Never fatal to a wake.
        failed += 1;
        stalled = true;
      }
    }
    // The checkpoint advances to the raw seq AFTER this block's last step, not
    // to the page end: a page holds more filtered steps than one block, and a
    // page-end checkpoint would skip every step the block did not consume.
    if (!stalled) {
      checkpoint = {
        index: end,
        seq: (batch[batch.length - 1]?.seq ?? -1) + 1,
      };
    }
  };

  // Clamped, not just floored: a page of 0 -- which every value in (0, 1)
  // floors to -- never advances the cursor and spins the loop forever.
  const page = Math.max(
    1,
    Math.floor(
      positiveOr(options.scanPageSteps ?? axTrajectoryScanPageSteps, 512)
    )
  );
  while (cursor.seq < endSeq && attempted() < maxBlocks) {
    options.signal?.throwIfAborted();
    const to = Math.min(endSeq, cursor.seq + page);
    const steps = await options.store.read(
      {
        trajectoryId: options.trajectoryId,
        fromSeq: cursor.seq,
        toSeq: to,
        types,
      },
      options.signal
    );
    const resolved = await axResolveTrajectorySteps(
      steps,
      options.store.blobs,
      {
        signal: options.signal,
      }
    );
    for (const step of resolved) {
      pending.push({
        id: step.stepId,
        text: `${step.type}: ${stepText(step)}`,
        seq: step.seq,
      });
    }
    cursor = { index: cursor.index + resolved.length, seq: to };
    while (pending.length >= fanout && attempted() < maxBlocks) await flush();
  }

  const sealedIndex = Math.max(meta.sealedIndex, checkpoint.index);
  const sealedSeq = Math.max(meta.sealedSeq, checkpoint.seq);
  const frontier = [...(meta.frontier ?? [])];
  await sealHigherTiers(
    options,
    fanout,
    meta.startIndex,
    frontier,
    sealedIndex,
    tiersTouched,
    (delta) => {
      sealed += delta.sealed;
      skipped += delta.skipped;
      failed += delta.failed;
    },
    () => attempted() < maxBlocks
  );
  if (
    sealedIndex !== meta.sealedIndex ||
    sealedSeq !== meta.sealedSeq ||
    frontier.join() !== (meta.frontier ?? []).join()
  ) {
    await options.rollups.saveMeta(
      options.trajectoryId,
      { ...meta, sealedIndex, sealedSeq, frontier },
      options.signal
    );
  }
  return Object.freeze({
    sealed,
    skipped,
    failed,
    tiersTouched: Object.freeze([...tiersTouched].sort((a, b) => a - b)),
  });
}

async function sealHigherTiers(
  options: Readonly<AxTrajectoryBuildRollupsOptions>,
  fanout: number,
  startIndex: number,
  frontier: number[],
  sealedIndex: number,
  tiersTouched: Set<number>,
  add: (delta: { sealed: number; skipped: number; failed: number }) => void,
  hasBudget: () => boolean
): Promise<void> {
  for (let tier = 2; fanout ** tier <= sealedIndex; tier += 1) {
    const size = fanout ** tier;
    const childSize = fanout ** (tier - 1);
    const slot = tier - 2;
    const floorIndex = options.backfill
      ? 0
      : Math.floor(startIndex / size) * size;
    let start =
      Math.floor(Math.max(frontier[slot] ?? 0, floorIndex) / size) * size;
    let advancing = true;
    for (; start + size <= sealedIndex; start += size) {
      if (!hasBudget()) return;
      options.signal?.throwIfAborted();
      tiersTouched.add(tier);
      if (!options.backfill && start + size <= startIndex) {
        // Permanently unsealable: its children are all pre-enable.
        if (advancing) frontier[slot] = start + size;
        continue;
      }
      if (
        await options.rollups.getBlock(
          options.trajectoryId,
          tier,
          start,
          options.signal
        )
      ) {
        add({ sealed: 0, skipped: 1, failed: 0 });
        if (advancing) frontier[slot] = start + size;
        continue;
      }
      const children: Readonly<AxTrajectoryRollupBlock>[] = [];
      for (let index = 0; index < fanout; index += 1) {
        const child = await options.rollups.getBlock(
          options.trajectoryId,
          tier - 1,
          start + index * childSize,
          options.signal
        );
        if (!child) break;
        children.push(child);
      }
      // A straddling coarse block simply is not sealable yet; that is the case
      // straddle descent exists to read, not an error. Tier k-1 is built in
      // order, so nothing above this start is sealable either.
      if (children.length < fanout) return;
      try {
        await sealBlock(
          options,
          tier,
          start,
          start + size,
          children.map((child) => ({
            id: child.stepIds[0] ?? `${child.tier}:${child.start}`,
            text: child.summary,
          })),
          new Set(children.map((child) => child.stepIds[0]).filter(isString))
        );
        add({ sealed: 1, skipped: 0, failed: 0 });
        if (advancing) frontier[slot] = start + size;
      } catch (error) {
        if (error instanceof AxTrajectoryRollupError) {
          add({ sealed: 0, skipped: 1, failed: 0 });
          if (advancing) frontier[slot] = start + size;
          continue;
        }
        // RFC 6.4: counted and retried next build, never fatal to a wake.
        add({ sealed: 0, skipped: 0, failed: 1 });
        advancing = false;
      }
    }
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
