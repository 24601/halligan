/**
 * The agent-side learning surface: recorded runs, receipts, and report ingress.
 *
 * Recording lives HERE, in an explicit `a.learn().run(...)` call, and not in
 * `forwardPipeline`. The pipeline returns from inside a `try` whose `finally`
 * calls `runtimeScope.finish(runtimeError)`, so an `await store.append(...)`
 * on that path would report a successful agent run as errored to every
 * consumer of that scope. Wrapping `forward()` from outside the runtime scope
 * keeps a bookkeeping failure a bookkeeping failure. It also means a bare
 * `forward()` records nothing, which is stated rather than implied.
 *
 * The other decision worth naming: `onInteraction` is AWAITED before `run()`
 * resolves. That is a deliberate departure from `onUsedMemories` /
 * `onUsedSkills`, which are fire-and-forget with a swallowed rejection. A
 * caller that gets a receipt is entitled to know its own bookkeeping ran.
 */

import type { AxAIService } from '../../ai/types.js';
import type { AxGenIn, AxGenOut, AxProgramUsage } from '../../dsp/types.js';
import type { AxEventClock } from '../../event/types.js';
import { AxSystemEventClock } from '../../event/types.js';
import { axCurrentHarnessInstallation } from '../../learn/apply.js';
import {
  axCreateLearningInteractionRecord,
  axCreateLearningReportRecord,
  axLearningReceiptFrom,
} from '../../learn/records.js';
import type { AxLearningSurface } from '../../learn/releases.js';
import type { AxReportSchema } from '../../learn/reportSchema.js';
import {
  type AxHarnessInstallTarget,
  type AxLearningAppendResult,
  type AxLearningArtifactRef,
  type AxLearningReceipt,
  type AxLearningReportInput,
  AxLearningReportValidationError,
  type AxLearningStore,
  AxLearningSuppressedError,
  type AxLearningTreeDelivery,
} from '../../learn/types.js';
import { randomUUID } from '../../util/crypto.js';

import type { AxAgentForwardOptions } from './agentOptimizeTypes.js';
import type { AxAgentMemoryResult } from './memoriesTypes.js';

/** Opt-in learning configuration, set once on `AxAgentOptions.learning`. */
export interface AxLearningAgentConfig {
  /** The isolated workload. Records, engine state and the chain share it. */
  readonly scenario: string;
  readonly store: AxLearningStore;
  /**
   * REQUIRED. The loop has no meaning without a release chain: a record that
   * cannot name what produced it is not provenance. What is optional is the
   * ref itself, which is absent when no tree is installed.
   */
  readonly surface: AxLearningSurface;
  readonly tags?: Readonly<Record<string, string>>;
  readonly reportSchema?: AxReportSchema;
  /** Record a run that threw as an interaction with `failure`. Default false. */
  readonly recordFailures?: boolean;
  //
  // There is deliberately no `sampleFields` / `maxSampleBytes` here.
  //
  // Those are the projection and byte cap applied when records are turned into
  // a training BATCH, and the agent never builds one: the engine is a pure
  // reducer the host constructs and drives (`axCreateLearningEngineState`,
  // §4.5). Declaring them on this config would ship a containment control that
  // does nothing — a host narrowing `sampleFields` to keep `output` out of a
  // proposer prompt would get no withholding at all, because the engine it
  // separately builds keeps its own wider default. Configure them where they
  // are read:
  //
  //   axCreateLearningEngineState({
  //     scenario, processor,
  //     sampleFields: ['input', 'failure'],
  //     maxSampleBytes: 16_384,
  //     maxParkedReports: 10_000,
  //   })
  //
  /**
   * Fired once per recorded run and AWAITED before `run()` resolves. A throw
   * rejects `run()` after the record is already durable, and is routed to
   * `onRecordError` when one is supplied.
   */
  readonly onInteraction?: (
    receipt: Readonly<AxLearningReceipt>
  ) => void | Promise<void>;
  readonly idFactory?: () => string;
  readonly clock?: AxEventClock;
  /**
   * Called when appending a record fails. Default: rethrow. Recording is not a
   * best-effort side channel — a caller that gets no receipt cannot report,
   * so silence would corrupt the loop.
   */
  readonly onRecordError?: (error: unknown) => void;
}

/** The subset of the agent this module drives. */
interface LearningAgentHost<IN extends AxGenIn, OUT extends AxGenOut> {
  forward(
    ai: Readonly<AxAIService>,
    values: IN & { memories?: readonly AxAgentMemoryResult[] },
    options?: Readonly<AxAgentForwardOptions<Readonly<AxAIService>>>
  ): Promise<OUT>;
  getSignature(): { toString(): string };
  getId(): string;
  getUsage(): { actor: AxProgramUsage[]; responder: AxProgramUsage[] };
}

function sumTokens(entries: readonly AxProgramUsage[]): Readonly<{
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}> {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  for (const entry of entries) {
    prompt += entry.tokens?.promptTokens ?? 0;
    completion += entry.tokens?.completionTokens ?? 0;
    total += entry.tokens?.totalTokens ?? 0;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
  };
}

/**
 * The agent's learning handle. One per agent, memoized by the coordinator.
 */
export class AxAgentLearning<
  IN extends AxGenIn = AxGenIn,
  OUT extends AxGenOut = AxGenOut,
> {
  readonly scenario: string;

  private readonly agent: LearningAgentHost<IN, OUT>;
  private readonly config: Readonly<AxLearningAgentConfig>;
  private readonly clock: AxEventClock;
  private readonly idFactory: () => string;
  private suspendDepth = 0;
  private suppressed = 0;

  constructor(
    agent: LearningAgentHost<IN, OUT>,
    config: Readonly<AxLearningAgentConfig>
  ) {
    if (
      typeof config.scenario !== 'string' ||
      config.scenario.trim().length === 0
    ) {
      throw new Error(
        'AxAgentLearning: learning.scenario must be a non-empty string'
      );
    }
    if (
      config.clock !== undefined &&
      config.store.clock !== undefined &&
      config.clock !== config.store.clock
    ) {
      throw new Error(
        'AxAgentLearning: the store owns a clock; pass that exact instance or none at all'
      );
    }
    this.agent = agent;
    this.config = config;
    this.scenario = config.scenario;
    this.clock = config.clock ?? config.store.clock ?? new AxSystemEventClock();
    this.idFactory = config.idFactory ?? randomUUID;
  }

  /** How many recorded runs suppression has refused since construction. */
  get suppressedRecords(): number {
    return this.suppressed;
  }

  /**
   * Suspend recording for the duration of a verification step. Refcounted, so
   * nested suspensions compose; the returned release is idempotent.
   */
  suspendRecording(): () => void {
    this.suspendDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspendDepth = Math.max(0, this.suspendDepth - 1);
    };
  }

  /** The promoted head of this scenario's release chain. */
  currentTree(
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningTreeDelivery> | undefined> {
    return this.config.surface.currentTree(signal);
  }

  /**
   * `forward()` plus its receipt, recorded from OUTSIDE the agent runtime
   * scope. The record is durable before this resolves.
   *
   * `values` keeps `forward()`'s memories augmentation, so `run()` is a
   * drop-in replacement.
   */
  async run<T extends Readonly<AxAIService>>(
    ai: T,
    values: IN & { memories?: readonly AxAgentMemoryResult[] },
    options?: Readonly<AxAgentForwardOptions<T>>
  ): Promise<Readonly<{ output: OUT; receipt: Readonly<AxLearningReceipt> }>> {
    if (this.suspendDepth > 0) {
      // Refused BEFORE the forward: a receipt without a record is forbidden,
      // and a caller must never be handed a fake one.
      this.suppressed += 1;
      throw new AxLearningSuppressedError(this.scenario);
    }

    // The ref names what the agent is SERVING, read before the run. Reading a
    // store head is not serving it.
    const artifactRef = this.artifactRef();
    const usageBefore = this.agent.getUsage();
    const actorSeen = usageBefore.actor.length;
    const responderSeen = usageBefore.responder.length;

    let output: OUT;
    try {
      output = await this.agent.forward(
        ai,
        values,
        options as Readonly<AxAgentForwardOptions<Readonly<AxAIService>>>
      );
    } catch (error) {
      if (this.config.recordFailures === true) {
        await this.append({
          artifactRef,
          failure: error,
          input: values,
          usageFrom: { actorSeen, responderSeen },
        });
      }
      throw error;
    }

    const receipt = await this.append({
      artifactRef,
      output,
      input: values,
      usageFrom: { actorSeen, responderSeen },
    });

    if (receipt !== undefined && this.config.onInteraction) {
      try {
        await this.config.onInteraction(receipt);
      } catch (error) {
        if (this.config.onRecordError) this.config.onRecordError(error);
        else throw error;
      }
    }

    if (receipt === undefined) {
      throw new Error(
        'AxAgentLearning.run(): the record could not be appended and no receipt exists'
      );
    }
    return Object.freeze({ output, receipt });
  }

  /**
   * Append a report that grades one or more receipts.
   *
   * Only interaction ids are receipts: a reference naming a report record is
   * refused, because a grade on a grade has no exchange behind it.
   */
  async report(
    input: Readonly<AxLearningReportInput>,
    signal?: AbortSignal
  ): Promise<Readonly<AxLearningAppendResult>> {
    const validated = this.config.reportSchema
      ? this.config.reportSchema.validate(input)
      : input;

    for (const reference of validated.references) {
      const referenced = await this.config.store.get(
        this.scenario,
        reference,
        signal
      );
      if (referenced?.kind === 'report') {
        throw new AxLearningReportValidationError(
          'references',
          `AxAgentLearning.report(): ${reference} names a report record; only interaction ids are receipts`
        );
      }
    }

    const record = axCreateLearningReportRecord({
      id: validated.id ?? this.idFactory(),
      scenario: this.scenario,
      createdAt: this.clock.now(),
      input: validated,
    });
    return this.config.store.append(record, signal);
  }

  /**
   * The ref for the tree the agent is serving right now.
   *
   * Absent when nothing is installed: "this exchange is not attributable to
   * any release" is a true statement, and fabricating one from the store head
   * would launder an identity the agent never ran.
   */
  private artifactRef(): Readonly<AxLearningArtifactRef> | undefined {
    const installation = axCurrentHarnessInstallation(
      this.agent as unknown as AxHarnessInstallTarget
    );
    if (installation === undefined) return undefined;
    const headContentId = this.config.surface.observedHeadContentId;
    // With no observed head there is nothing to compare against. `stale: false`
    // is the honest reading — the agent is serving what it was installed with
    // and nothing is KNOWN to supersede it — and `headContentId` stays absent
    // so a consumer can tell "not stale" from "never checked".
    return Object.freeze({
      releaseId: installation.releaseId,
      ...(installation.parentReleaseId === undefined
        ? {}
        : { parentReleaseId: installation.parentReleaseId }),
      contentId: installation.contentId,
      ...(headContentId === undefined ? {} : { headContentId }),
      stale:
        headContentId !== undefined && installation.contentId !== headContentId,
    });
  }

  private async append(args: {
    artifactRef?: Readonly<AxLearningArtifactRef>;
    input: unknown;
    output?: unknown;
    failure?: unknown;
    usageFrom: { actorSeen: number; responderSeen: number };
  }): Promise<Readonly<AxLearningReceipt> | undefined> {
    const usage = this.agent.getUsage();
    const fresh = [
      ...usage.actor.slice(args.usageFrom.actorSeen),
      ...usage.responder.slice(args.usageFrom.responderSeen),
    ];
    const model = fresh.at(-1)?.model;
    const { memories: _memories, ...input } = (args.input ?? {}) as Record<
      string,
      unknown
    >;

    try {
      const record = axCreateLearningInteractionRecord({
        id: this.idFactory(),
        scenario: this.scenario,
        createdAt: this.clock.now(),
        ...(args.artifactRef === undefined
          ? {}
          : { artifactRef: args.artifactRef }),
        signature: this.agent.getSignature().toString(),
        programId: this.agent.getId(),
        input: input as never,
        ...(args.failure === undefined
          ? { output: args.output as never }
          : { failure: args.failure }),
        ...(model === undefined ? {} : { model }),
        ...(fresh.length === 0 ? {} : { usage: sumTokens(fresh) }),
        ...(this.config.tags === undefined ? {} : { tags: this.config.tags }),
      });
      const result = await this.config.store.append(record);
      return axLearningReceiptFrom(
        result,
        this.config.store.capabilities.durability
      );
    } catch (error) {
      if (this.config.onRecordError) {
        this.config.onRecordError(error);
        return undefined;
      }
      throw error;
    }
  }
}
