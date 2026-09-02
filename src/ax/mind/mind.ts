import type { AxAgentSessionHost } from '../agent/retainedSessions.js';
import type { AxAIService } from '../ai/types.js';
import type {
  AxProgramForwardOptions,
  AxProgrammable,
  AxProgramUsage,
} from '../dsp/types.js';
import { AxEventRuntime } from '../event/runtime.js';
import { AxPushEventSource } from '../event/sources.js';
import type {
  AxEventClock,
  AxEventCloseOptions,
  AxEventContext,
  AxEventDeadLetter,
  AxEventIngress,
  AxEventRoute,
  AxEventRuntimeOptions,
  AxEventSource,
  AxEventTarget,
} from '../event/types.js';
import { axEventId } from '../event/util.js';
import {
  type AxTrajectoryContextBudgetOptions,
  type AxTrajectoryProjection,
  axProjectTrajectory,
  axTrajectoryContextBudget,
} from '../trajectory/projection.js';
import { axTrajectoryTypeRegistry } from '../trajectory/registry.js';
import type {
  AxTrajectoryRollupStore,
  AxTrajectorySummarizer,
} from '../trajectory/rollups.js';
import type {
  AxTrajectoryAppendRequest,
  AxTrajectoryStep,
  AxTrajectoryStore,
  AxTrajectoryTypeRegistry,
} from '../trajectory/types.js';
import { mergeAbortSignals } from '../util/abort.js';
import { axMindChat, axMindReconcileChatSends } from './chat.js';
import {
  axMindRoutingSignals,
  axMindSyntheticTrigger,
  axMindWakeClass,
} from './context.js';
import {
  axMindHealth,
  axMindHealthReporter,
  axMindStalledThreshold,
  axMindStoreDurability,
} from './health.js';
import {
  axMindPaceStepData,
  axMindPaceStepType,
  axMindWakeOutcomeOf,
  axMindWorkProbe,
  axNextMindPace,
  axRecoverMindPacerState,
} from './pacer.js';
import {
  axMindEventRoutes,
  axMindEventSource,
  axMindEventTypes,
  axMindSubscribedStepTypes,
  axMindThinkerSubject,
} from './routes.js';
import { axMindSalienceBuffer, axRecordMindSalience } from './salience.js';
import {
  type AxMindTickDutyState,
  AxMindTickEventSource,
  AxTrajectoryEventSource,
  axMindTickDue,
} from './sources.js';
import { axMindThinkerTarget } from './step.js';
import {
  type AxMindSubRunRequest,
  type AxMindSubRunResult,
  axMindSubRun,
} from './subruns.js';
import {
  type AxMindArtifactSource,
  type AxMindArtifacts,
  AxMindBudgetExceededError,
  type AxMindChat,
  AxMindChatError,
  type AxMindChatTransport,
  AxMindConfigurationError,
  type AxMindContextRequest,
  type AxMindDiagnostic,
  type AxMindEffectLedger,
  type AxMindHealth,
  type AxMindHealthThresholds,
  AxMindLivenessError,
  type AxMindOwnershipStore,
  type AxMindPacerConfig,
  type AxMindPacerState,
  type AxMindRoutingSignal,
  type AxMindSalienceBuffer,
  type AxMindThinker,
  type AxMindThinkerBudget,
  type AxMindThinkerHealth,
  type AxMindWakeClass,
  type AxMindWakeOutcome,
  axDefaultMindPacerConfig,
  axDefaultMindThinkerBudget,
  axInitialMindPacerState,
} from './types.js';

const HOUR_MS = 3_600_000;
const DEFAULT_TICK_MS = 1_000;
const DEFAULT_WAKE_GAP_MIN_MS = 300_000;
const DEFAULT_SHARE_NUDGE_EVERY = 12;
/** The writer identity inbound conversation arrives under. */
export const axMindInboundSource = 'chat';

/**
 * Names the agent runtime already owns. A thinker called `recall` would shadow
 * the actor's own verb and make the failure look like a model mistake.
 */
export const axMindReservedNames: readonly string[] = Object.freeze([
  'askClarification',
  'discover',
  'final',
  'inputs',
  'inspectRuntime',
  'llmQuery',
  'recall',
  'reportFailure',
  'reportSuccess',
  'respond',
  'used',
]);

/**
 * `trajectoryId` is optional and always overridden: the mind writes to ITS
 * trajectory and nowhere else, so a caller cannot address another life by
 * accident, and a thinker tool does not have to know the id at all.
 */
export type AxMindAppendRequest = Readonly<
  Omit<AxTrajectoryAppendRequest, 'trajectoryId'> & { trajectoryId?: string }
>;

export interface AxMindOptions {
  readonly id?: string;
  readonly trajectoryId: string;
  readonly store: AxTrajectoryStore;
  readonly artifacts: AxMindArtifactSource;
  readonly thinkers: readonly Readonly<AxMindThinker<any, any>>[];
  readonly budget: Readonly<AxTrajectoryContextBudgetOptions>;
  readonly clock?: AxEventClock;
  readonly registry?: AxTrajectoryTypeRegistry;
  readonly rollups?: AxTrajectoryRollupStore;
  readonly summarizer?: AxTrajectorySummarizer;
  readonly transport?: AxMindChatTransport;
  readonly pacer?: Readonly<AxMindPacerConfig>;
  readonly health?: Readonly<AxMindHealthThresholds>;
  readonly ownership?: AxMindOwnershipStore;
  /** Default 300_000. Appends an in-band note about the mind's own downtime. */
  readonly wakeGapMinMs?: number;
  /** Default 180_000. Fails OPEN when unreadable. */
  readonly replyClaimTtlMs?: number;
  /** Counter-pressure against restraint ratcheting. Default 12. */
  readonly shareNudgeEvery?: number;
  readonly authority?: AxEventRuntimeOptions['authority'];
  readonly sessions?: AxAgentSessionHost;
  readonly defaultThinkerBudget?: Readonly<AxMindThinkerBudget>;
  readonly effectResolver?: AxEventRuntimeOptions['effectResolver'];
  /**
   * Crash C10 reconcile-at-start. `AxEventContext.listEffects()` reports the
   * CURRENT delivery's effects only, so recovering the sends of deliveries
   * that are already gone needs a host adapter over the effect store. Absent,
   * `reconcile()` still recomputes health and pacer state and says so.
   */
  readonly effectLedger?: AxMindEffectLedger;
  /** Grid resolution for the one always-alive tick. Default 1_000. */
  readonly tickMs?: number;
  /** Trajectory drain fallback interval. Default 1_000; `notify()` is a hint. */
  readonly sourcePollMs?: number;
  /** Poll interval while a sub-run runs. Default 25. */
  readonly subRunPollMs?: number;
  /** Escape hatch for tests. Refused by default (crash-safety). */
  readonly allowVolatileTrajectory?: boolean;
  readonly event?: Readonly<Omit<AxEventRuntimeOptions, 'routes' | 'sources'>>;
  readonly onDiagnostic?: (diagnostic: Readonly<AxMindDiagnostic>) => void;
  readonly onHealth?: (health: Readonly<AxMindHealth>) => void;
}

/** Per-thinker mutable state. Derived, never a second authority. */
interface ThinkerRuntime {
  readonly thinker: Readonly<AxMindThinker<any, any>>;
  readonly target: AxEventTarget<any, any>;
  pacer: Readonly<AxMindPacerState>;
  nextWakeAt?: number;
  dispatchedWakeAt?: number;
  lastActivityAt: number;
  lastWakeAt?: number;
  running: number;
  deferred: number;
  consecutiveErrors: number;
  lastOutcome?: AxMindWakeOutcome;
  wakesSinceShare: number;
  subRuns: number;
}

/** One in-flight step, keyed by delivery: the delivery IS the program counter. */
interface PendingStep {
  readonly runtime: ThinkerRuntime;
  readonly wakeClass: AxMindWakeClass;
  readonly trigger: Readonly<AxTrajectoryStep>;
  readonly before: Awaited<ReturnType<typeof axMindWorkProbe>>;
  readonly budget: Readonly<AxMindThinkerBudget>;
  readonly startedAt: number;
  /** The run's result, held until the settle runs -- possibly in a sink. */
  output?: unknown;
  error?: unknown;
  /** Set the moment a settle is committed to, so it can never run twice. */
  settled?: boolean;
}

function usageTokens(usage: unknown): number {
  if (Array.isArray(usage)) {
    return (usage as readonly AxProgramUsage[]).reduce(
      (total, one) => total + (one.tokens?.totalTokens ?? 0),
      0
    );
  }
  const total = (usage as { totalTokens?: unknown } | undefined)?.totalTokens;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/**
 * The persistent-agency runtime. Constructing it validates configuration and
 * starts NOTHING: no timer, no source, no loop (M16). `start()` is the only
 * thing that makes a mind alive, and it is the host that calls it.
 */
export class AxMind {
  /** The mid-run injection buffer. A thinker reaches it through its tools. */
  readonly salience: AxMindSalienceBuffer;

  private readonly id: string;
  private readonly clock: AxEventClock;
  private readonly registry: AxTrajectoryTypeRegistry;
  private readonly thinkers = new Map<string, ThinkerRuntime>();
  private readonly pending = new Map<string, PendingStep>();
  private readonly chats = new Map<string, AxMindChat>();
  private readonly routeTable: readonly AxEventRoute[];
  private readonly trajectorySource: AxTrajectoryEventSource;
  private readonly tickSource: AxMindTickEventSource;
  private readonly bootstrapSource: AxPushEventSource;
  private readonly runtime: AxEventRuntime;
  private readonly pacerConfig: Readonly<AxMindPacerConfig>;
  private readonly thresholds: Readonly<AxMindHealthThresholds>;
  private readonly reportHealth: (health: Readonly<AxMindHealth>) => void;
  private readonly budgetTokens: number;
  private artifacts: Readonly<AxMindArtifacts>;
  private started = false;
  private closed = false;
  /**
   * Aborted by `close()`, and the ONLY signal a settle takes. The probe read
   * and the outcome/pace appends a closing mind is still holding stop at the
   * store boundary instead of racing the shutdown; a cancelled or claim-lapsed
   * delivery still records its outcome, because losing the run is not a reason
   * to lose the audit trail of it.
   */
  private readonly lifetime = new AbortController();
  private toolDepth = 0;
  private ownershipRevision?: number;
  /**
   * Per-INSTANCE lease identity. `close()` releases it by handing the record
   * back with an empty owner; a durable ownership store that outlives a crash
   * therefore needs a host-side lease TTL, and this class says so rather than
   * pretending the record expires on its own.
   */
  private readonly ownerId = axEventId('mind-owner');
  private lastDispatchAt?: number;
  private lastErrorAt?: number;
  private lastError?: string;
  private wakeGapSignal?: Readonly<AxMindRoutingSignal>;
  /**
   * The newest step the mind knows about. `append` is the ONLY write path, so
   * this is exact for a single-owner mind and re-grounded from `stats()` by
   * `reconcile()` for everything a previous process wrote.
   */
  private newestStep: Readonly<{ seq: number; ts: number }> = {
    seq: -1,
    ts: 0,
  };

  private constructor(private readonly options: Readonly<AxMindOptions>) {
    this.id = options.id ?? `mind-${options.trajectoryId}`;
    this.clock = options.clock ?? options.store.clock;
    this.registry = options.registry ?? axTrajectoryTypeRegistry();
    this.pacerConfig = options.pacer ?? axDefaultMindPacerConfig;
    this.budgetTokens = axTrajectoryContextBudget(options.budget);
    this.artifacts = {
      revision: 'unloaded',
      persona: '',
      thinkerPrompts: {},
      goals: [],
      skills: [],
    };
    this.salience = axMindSalienceBuffer();
    const targets: Record<string, AxEventTarget<any, any>> = {};
    for (const thinker of options.thinkers) {
      const runtime: ThinkerRuntime = {
        thinker,
        target: undefined as unknown as AxEventTarget<any, any>,
        pacer: axInitialMindPacerState,
        lastActivityAt: this.clock.now(),
        running: 0,
        deferred: 0,
        consecutiveErrors: 0,
        wakesSinceShare: 0,
        subRuns: 0,
      };
      const target = axMindThinkerTarget(thinker, {
        run: (one, inner, ai, values, forwardOptions) =>
          this.runThinkerStep(one, inner, ai, values, forwardOptions),
        assemble: (_one, ingress, eventContext) =>
          this.assembleContext(runtime, ingress, eventContext),
        settle: (deliveryId) => this.settleDelivery(deliveryId),
        mind: () => this,
      });
      (runtime as { target: AxEventTarget<any, any> }).target = target;
      targets[thinker.name] = target;
      this.thinkers.set(thinker.name, runtime);
    }
    const tickMs = Math.max(1, options.tickMs ?? DEFAULT_TICK_MS);
    this.routeTable = axMindEventRoutes({
      mindId: this.id,
      thinkers: options.thinkers,
      targets,
      registry: this.registry,
      sourceId: axMindEventSource(this.id),
      tickMs,
      now: () => this.clock.now(),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
    this.trajectorySource = new AxTrajectoryEventSource({
      id: `${this.id}.trajectory`,
      store: options.store,
      trajectoryId: options.trajectoryId,
      registry: this.registry,
      clock: this.clock,
      eventSource: axMindEventSource(this.id),
      ...(options.sourcePollMs !== undefined
        ? { pollIntervalMs: options.sourcePollMs }
        : {}),
      consumers: options.thinkers.map((thinker) => ({
        thinker: thinker.name,
        subscription: thinker.subscription,
        inFlight: () => {
          const state = this.thinkers.get(thinker.name);
          return (state?.running ?? 0) + (state?.deferred ?? 0);
        },
      })),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
    this.tickSource = new AxMindTickEventSource({
      id: `${this.id}.tick`,
      clock: this.clock,
      intervalMs: tickMs,
      eventSource: axMindEventSource(this.id),
      due: () => {
        // M7 layer (b) lives on the one always-alive tick: a delivery that
        // terminalised without a settle is found here, not by the code path
        // that failed.
        this.reapAbandonedSteps();
        return axMindTickDue(this.dueDuties(), this.clock.now(), {
          intervalMs: tickMs,
        });
      },
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
    this.bootstrapSource = new AxPushEventSource(`${this.id}.bootstrap`);
    this.runtime = new AxEventRuntime({
      // One worker per thinker, not the runtime's pool default. A thinker's
      // wake is pinned to `instanceKey = thinker`, so a mind can never have
      // more than one run per thinker in flight; a larger pool adds workers
      // that can only contend for the same deliveries, and a MEASURED
      // consequence of that contention is a claim going stale mid-model-call
      // and aborting a run that was doing nothing wrong. Thinker steps are
      // long by design, which is what makes this the wrong pool to inherit.
      workerConcurrency: Math.max(1, options.thinkers.length),
      ...(options.event ?? {}),
      id: this.id,
      clock: this.clock,
      routes: this.routeTable,
      sources: [this.trajectorySource, this.tickSource, this.bootstrapSource],
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.effectResolver
        ? { effectResolver: options.effectResolver }
        : {}),
    });
    this.thresholds = {
      ...(options.health ?? {}),
      stalledMs:
        options.health?.stalledMs ??
        axMindStalledThreshold({
          watchdogMs: Math.max(
            0,
            ...options.thinkers.map((one) => one.subscription.watchdogMs)
          ),
          capMs: this.pacerConfig.capMs,
        }),
    };
    this.reportHealth = axMindHealthReporter(options.onHealth);
  }

  /** Validates configuration. Starts no timer, no source, no loop. */
  static create(options: Readonly<AxMindOptions>): AxMind {
    const seen = new Set<string>();
    let pacers = 0;
    for (const thinker of options.thinkers) {
      if (seen.has(thinker.name)) {
        throw new AxMindConfigurationError(
          `AxMind has two thinkers named ${thinker.name}; a wake route cannot address either`,
          'duplicate_thinker'
        );
      }
      seen.add(thinker.name);
      if (axMindReservedNames.includes(thinker.name)) {
        throw new AxMindConfigurationError(
          `AxMind thinker ${thinker.name} uses a name the agent runtime already owns (${axMindReservedNames.join(', ')})`,
          'reserved_namespace'
        );
      }
      if (thinker.pacer) pacers++;
    }
    if (pacers > 1) {
      throw new AxMindConfigurationError(
        `AxMind has ${pacers} thinkers configured with a pacer; scheduled spontaneity has exactly one owner`,
        'multiple_pacers'
      );
    }
    if (!options.thinkers.length) {
      throw new AxMindConfigurationError(
        'AxMind requires at least one thinker; a mind with no thinker can never wake',
        'duplicate_thinker'
      );
    }
    const clock = options.clock ?? options.store.clock;
    if (clock !== options.store.clock) {
      // Mirrors the event runtime's own refusal: two clocks means two
      // opinions about when a wake is due, and the pacing table is a
      // function of `now`.
      throw new AxMindConfigurationError(
        'AxMind and its trajectory store must share one AxEventClock instance',
        'clock_mismatch'
      );
    }
    return new AxMind(options);
  }

  /** Starts the runtime and the mind's sources; appends the wake-gap note. */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.started) return;
    const { store, trajectoryId } = this.options;
    const header = await store.getTrajectory(trajectoryId, signal);
    if (!header) {
      throw new AxMindConfigurationError(
        `AxMind cannot start on ${trajectoryId}: no such trajectory in the store`,
        'unknown_trajectory'
      );
    }
    if (!store.capabilities.appendAtomicity) {
      throw new AxMindConfigurationError(
        `AxMind refuses a trajectory store without append atomicity: seq would not be dense and a wake could name a step that never became visible`,
        'append_atomicity_required'
      );
    }
    if (
      store.capabilities.durability === 'volatile' &&
      !this.options.allowVolatileTrajectory
    ) {
      // Names the TRAJECTORY store, not the event store: the mind's own life
      // is the thing that would be lost, and the two are separately graded.
      throw new AxMindConfigurationError(
        `AxMind refuses a volatile TRAJECTORY store (${trajectoryId}): a restart would lose the log the pacer, the reply guard and the projection are all recovered from. Pass allowVolatileTrajectory to accept that.`,
        'volatile_trajectory_store'
      );
    }
    const effectAware = this.options.thinkers.some(
      (thinker) => thinker.retrySafety === 'effect-aware'
    );
    if (effectAware && !this.options.effectLedger) {
      throw new AxMindConfigurationError(
        'AxMind has an effect-aware thinker but no effect ledger; a dispatched effect could not be classified on recovery',
        'effect_store_required'
      );
    }
    if (this.options.ownership) {
      // A second owner on one trajectory would silently DOUBLE the wake rate,
      // which is the failure this guard exists to make loud. The lease is
      // held by the instance, not by the mind id, so two AxMind objects over
      // one trajectory cannot both believe they won.
      const current = await this.options.ownership.load(this.id, signal);
      if (current?.ownerId && current.ownerId !== this.ownerId) {
        throw new AxMindLivenessError(
          `AxMind ${this.id} is already owned by ${current.ownerId}; a second owner on one trajectory would double the wake rate`,
          'source_failed'
        );
      }
      const next = await this.options.ownership.compareAndSet(
        this.id,
        current?.revision,
        this.ownerId,
        signal
      );
      this.ownershipRevision = next.revision;
    }
    this.artifacts = await this.options.artifacts.load(signal);
    await this.noteWakeGap(signal);
    await this.reconcile(signal);
    await this.runtime.start();
    this.started = true;
    // Bootstrap goes through the DISPATCHER, never a direct call: a step
    // spawned outside dispatcher supervision is unsupervised and slips past
    // every guard the route table exists to apply.
    for (const name of this.thinkers.keys()) {
      await this.bootstrapSource.publish(
        {
          event: {
            specversion: '1.0',
            id: axEventId(`${this.id}-bootstrap`),
            source: axMindEventSource(this.id),
            type: axMindEventTypes.bootstrap,
            subject: axMindThinkerSubject(name),
            time: new Date(this.clock.now()).toISOString(),
            data: { thinker: name },
            extensions: { stepsource: 'mind-boot' },
          },
          trust: 'trusted',
        },
        signal
      );
    }
  }

  /**
   * The mind is told about its own downtime, IN BAND. A gap the mind cannot
   * see is a gap it reasons as if it had been awake through.
   */
  private async noteWakeGap(signal?: AbortSignal): Promise<void> {
    const minMs = this.options.wakeGapMinMs ?? DEFAULT_WAKE_GAP_MIN_MS;
    const stats = await this.options.store.stats(
      this.options.trajectoryId,
      signal
    );
    if (!stats) return;
    const gap = this.clock.now() - stats.newestTs;
    if (gap <= minMs) return;
    const hours = Math.floor(gap / HOUR_MS);
    const minutes = Math.floor((gap % HOUR_MS) / 60_000);
    const text = `${hours}h ${minutes}m passed since the previous step; this mind was not running in between.`;
    await this.options.store.append(
      {
        trajectoryId: this.options.trajectoryId,
        type: 'observation',
        source: 'system',
        data: { content: text, wakeGapMs: gap },
      },
      signal
    );
    this.wakeGapSignal = Object.freeze({ code: 'wake_gap', text });
    this.diagnose('wake-gap-noted', text);
  }

  /**
   * Outbound chat AS one thinker. The writer identity on a reply and on a
   * recorded decision is the thinker that composed it, never whichever
   * thinker happened to be first in the table -- `axResolveMindReplyState`
   * reads that identity to decide whose claim a decline can cancel.
   */
  chatAs(thinker: string): AxMindChat {
    const found = this.chats.get(thinker);
    if (found) return found;
    // EVERY thinker name, never just one: an outbound reply written by a
    // sibling must still satisfy the positional net, and `data.from` on an
    // inbound step is remote-controlled so it cannot decide outbound-ness.
    const chat = axMindChat({
      trajectoryId: this.options.trajectoryId,
      store: this.options.store,
      clock: this.clock,
      sender: thinker,
      selfSources: [...this.thinkers.keys(), 'mind'],
      ...(this.options.transport ? { transport: this.options.transport } : {}),
      ...(this.options.replyClaimTtlMs !== undefined
        ? { claimTtlMs: this.options.replyClaimTtlMs }
        : {}),
      effects: () => this.options.effectLedger,
      ...(this.options.onDiagnostic
        ? { onDiagnostic: this.options.onDiagnostic }
        : {}),
    });
    this.chats.set(thinker, chat);
    return chat;
  }

  /** The mind's own outbound handle, for a host that is not a thinker. */
  get chat(): AxMindChat {
    return this.chatAs('mind');
  }

  /** The artifacts in force right now. Re-read only by reloadArtifacts(). */
  currentArtifacts(): Readonly<AxMindArtifacts> {
    return this.artifacts;
  }

  /** Host ingress and the ONLY write path. */
  async append(
    request: Readonly<AxMindAppendRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>> {
    const descriptor = this.registry.describe(request.type);
    if (!this.registry.has(request.type)) {
      this.diagnose(
        'unknown-step-type',
        `appended an unregistered step type ${request.type}; it is inert: excluded from the projection and unable to wake a thinker`
      );
    }
    const receipt = await this.options.store.append(
      {
        ...request,
        trajectoryId: this.options.trajectoryId,
        // The host is a writer like any other, and a machinery type carries
        // no writer at all -- the store fails closed on that.
        ...(descriptor.carriesSource && request.source === undefined
          ? { source: 'host' }
          : {}),
      },
      signal
    );
    this.newestStep = { seq: receipt.seq, ts: receipt.ts };
    const step = await this.requireStep(receipt.stepId, signal);
    await this.offerSalience(step, signal);
    this.trajectorySource.notify();
    return step;
  }

  /** Inbound chat. Refuses self-addressed traffic and explains in band. */
  async receive(
    message: Readonly<{
      from: string;
      to: string;
      content: string;
      replyTo?: string;
    }>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>> {
    const selfName = this.options.transport?.selfName;
    if (selfName !== undefined && message.from === selfName) {
      const explanation = `refused an inbound message claiming to come from ${selfName}, which is this mind's own identity. Inbound traffic carries the sender's identity; the mind's own words are appended as its own steps.`;
      await this.options.store.append(
        {
          trajectoryId: this.options.trajectoryId,
          type: 'observation',
          source: 'system',
          data: { content: explanation, refused: 'self_addressed' },
        },
        signal
      );
      // M13 names ONE error for self-addressed traffic in both directions:
      // a host guarding inbound with `axIsMindChatError` has to see the same
      // shape the send half throws, and `source_failed` says a source failed,
      // which is not what happened.
      throw new AxMindChatError(explanation, 'self_addressed');
    }
    return this.append(
      {
        trajectoryId: this.options.trajectoryId,
        type: 'message',
        source: 'chat',
        ...(message.replyTo ? { triggerStep: message.replyTo } : {}),
        data: {
          from: message.from,
          to: message.to,
          content: message.content,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        },
      },
      signal
    );
  }

  /**
   * Row 9 of the dispatch table: an inbound message that arrives while a
   * subscribed thinker is mid-run is offered once, GLOBALLY -- N subscribers
   * used to mean N identical injections of one message.
   */
  private async offerSalience(
    step: Readonly<AxTrajectoryStep>,
    signal?: AbortSignal
  ): Promise<void> {
    if (step.type !== 'message') return;
    const busy = [...this.thinkers.values()].find(
      (runtime) =>
        runtime.running > 0 &&
        axMindSubscribedStepTypes(
          runtime.thinker.subscription,
          this.registry
        ).includes(step.type)
    );
    if (!busy) return;
    const content = step.data.content;
    const offered = this.salience.offer({
      sourceStepId: step.stepId,
      text: typeof content === 'string' ? content : '',
      createdAt: step.ts,
    });
    if (!offered) return;
    await axRecordMindSalience(
      this.options.store,
      {
        trajectoryId: this.options.trajectoryId,
        thinker: busy.thinker.name,
        item: {
          sourceStepId: step.stepId,
          text: typeof content === 'string' ? content : '',
          createdAt: step.ts,
        },
        ...(this.options.onDiagnostic
          ? { onDiagnostic: this.options.onDiagnostic }
          : {}),
      },
      signal
    );
  }

  private async assembleContext(
    runtime: ThinkerRuntime,
    ingress: Readonly<AxEventIngress>,
    eventContext: Readonly<AxEventContext>
  ): Promise<unknown> {
    const wakeClass = axMindWakeClass(ingress);
    const data = (ingress.event.data ?? {}) as Record<string, unknown>;
    const stepId = typeof data.stepId === 'string' ? data.stepId : undefined;
    const trigger =
      (stepId
        ? await this.options.store.getStep(
            this.options.trajectoryId,
            stepId,
            eventContext.abortSignal
          )
        : undefined) ??
      axMindSyntheticTrigger(ingress, {
        trajectoryId: this.options.trajectoryId,
        wakeClass,
        now: this.clock.now(),
      });
    // Stamped AT DELIVERY, never at publish: a publish that never became a
    // delivery must stay due, and a wake the pacer deliberately left alone
    // must not re-fire every grid slot.
    if (wakeClass === 'spontaneous') {
      runtime.dispatchedWakeAt = runtime.nextWakeAt;
    }
    runtime.lastActivityAt = this.clock.now();
    runtime.lastWakeAt = this.clock.now();
    this.lastDispatchAt = this.clock.now();
    let projection: Readonly<AxTrajectoryProjection>;
    try {
      projection = await axProjectTrajectory({
        trajectoryId: this.options.trajectoryId,
        store: this.options.store,
        registry: this.registry,
        budgetTokens: this.budgetTokens,
        ...(this.options.rollups ? { rollups: this.options.rollups } : {}),
        ...(eventContext.abortSignal
          ? { signal: eventContext.abortSignal }
          : {}),
      });
    } catch (error) {
      // A typed projection failure -- `AxTrajectoryRollupError('meta_conflict')`
      // from a sealed block whose meta disagrees, or
      // `AxTrajectoryQueryError('unsupported_types')` from a `types` request no
      // narrative type survives -- dead-letters HERE, before any token is
      // spent. `dispatchedWakeAt` was already stamped above, so without the
      // re-arm the pace duty would stay suppressed for the wake that died.
      this.diagnose(
        'context-assembly-failed',
        `${runtime.thinker.name} could not assemble context: ${String(error)}`,
        runtime.thinker.name,
        trigger.stepId
      );
      this.armLivenessFallback(
        runtime,
        `context assembly failed for ${trigger.stepId}`
      );
      throw error;
    }
    const request: AxMindContextRequest = {
      mindId: this.id,
      thinker: runtime.thinker.name,
      trajectoryId: this.options.trajectoryId,
      wakeClass,
      trigger,
      store: this.options.store,
      projection,
      artifacts: this.artifacts,
      signals: this.buildSignals(runtime, projection),
      budgetTokens: this.budgetTokens,
      signal: eventContext.abortSignal,
      eventContext,
    };
    const budget =
      runtime.thinker.budget ??
      this.options.defaultThinkerBudget ??
      axDefaultMindThinkerBudget;
    const before = await axMindWorkProbe(
      this.options.store,
      this.options.trajectoryId,
      this.registry,
      eventContext.abortSignal
    );
    this.pending.set(eventContext.deliveryId, {
      runtime,
      wakeClass,
      trigger,
      before,
      budget,
      startedAt: this.clock.now(),
    });
    try {
      return await runtime.thinker.context(request);
    } catch (error) {
      this.pending.delete(eventContext.deliveryId);
      this.diagnose(
        'context-assembly-failed',
        `${runtime.thinker.name}'s context assembler threw: ${String(error)}`,
        runtime.thinker.name,
        trigger.stepId
      );
      this.armLivenessFallback(
        runtime,
        `context assembler threw for ${trigger.stepId}`
      );
      throw error;
    }
  }

  private buildSignals(
    runtime: ThinkerRuntime,
    projection: Readonly<AxTrajectoryProjection>
  ): readonly Readonly<AxMindRoutingSignal>[] {
    const health = this.health();
    const signals = axMindRoutingSignals({
      projection,
      wakesSinceShare: runtime.wakesSinceShare,
      shareNudgeEvery:
        this.options.shareNudgeEvery ?? DEFAULT_SHARE_NUDGE_EVERY,
      health: health.state,
      lagSteps: health.lagSteps,
      inboundSource: axMindInboundSource,
      ...(this.wakeGapSignal ? { wakeGap: this.wakeGapSignal } : {}),
    });
    // The downtime note is a ONE-TIME signal: repeating it every wake would
    // teach the mind that the gap is still happening.
    this.wakeGapSignal = undefined;
    return signals;
  }

  /** Fork a child trajectory, run under the tree budget, ALWAYS merge back. */
  async subRun<OUT>(
    request: Readonly<AxMindSubRunRequest<OUT>>,
    signal?: AbortSignal
  ): Promise<Readonly<AxMindSubRunResult<OUT>>> {
    const runtime = this.resolveSubRunOwner(request.thinker);
    const budget =
      runtime?.thinker.budget ??
      this.options.defaultThinkerBudget ??
      axDefaultMindThinkerBudget;
    const result = await axMindSubRun(
      {
        store: this.options.store,
        trajectoryId: this.options.trajectoryId,
        clock: this.clock,
        budget,
        spent: runtime?.subRuns ?? 0,
        ...(this.options.sessions ? { sessions: this.options.sessions } : {}),
        ...(this.options.subRunPollMs !== undefined
          ? { pollMs: this.options.subRunPollMs }
          : {}),
        request,
      },
      signal
    );
    if (runtime) runtime.subRuns++;
    // A sub-run writes a fork step AND a merge step into this trajectory, so
    // the count is re-grounded from the store rather than guessed at.
    const stats = await this.options.store.stats(
      this.options.trajectoryId,
      signal
    );
    if (stats) this.newestStep = { seq: stats.newestSeq, ts: stats.newestTs };
    this.trajectorySource.notify();
    return result;
  }

  /**
   * One thinker step, end to end. The arm is a RUNTIME guarantee, not a code
   * path: every exit that skips the settle below -- a dead-lettered assembly, a
   * missing delivery record, a settle that throws, a sink that never ran --
   * re-arms one wake through `armLivenessFallback`, and the tick's reaper is
   * the backstop for the paths that cannot report themselves at all (M7).
   */
  async runThinkerStep(
    thinker: Readonly<AxMindThinker<any, any>>,
    inner: AxProgrammable<any, any>,
    ai: Readonly<AxAIService>,
    values: unknown,
    options?: Readonly<AxProgramForwardOptions<string>>
  ): Promise<unknown> {
    const eventContext = (
      options as { eventContext?: Readonly<AxEventContext> } | undefined
    )?.eventContext;
    const deliveryId = eventContext?.deliveryId;
    const step = deliveryId ? this.pending.get(deliveryId) : undefined;
    if (!step || !deliveryId) {
      // Without the delivery record there is no probe, no budget and no pace
      // decision: running the program anyway would spend tokens outside every
      // guard this class exists to apply.
      const orphan = this.thinkers.get(thinker.name);
      if (orphan) {
        this.armLivenessFallback(
          orphan,
          'a wake arrived with no in-flight record'
        );
      }
      throw new AxMindLivenessError(
        `AxMind has no in-flight record for ${thinker.name}; a thinker program runs only through the dispatcher`,
        'source_failed'
      );
    }
    const runtime = step.runtime;
    runtime.running++;
    const deadline = new AbortController();
    const timer = this.clock
      .sleep(step.budget.maxWallClockMs, deadline.signal)
      .then(() => {
        deadline.abort(
          new AxMindBudgetExceededError('wallClock', step.budget.maxWallClockMs)
        );
      })
      .catch(() => undefined);
    const signal = mergeAbortSignals(options?.abortSignal, deadline.signal);
    // `AxProgram.getUsage()` ACCUMULATES until `resetUsage()`, and the runtime
    // resolves one program per `instanceKey` and reuses it for the mind's whole
    // life. Comparing the raw total against a PER-STEP cap turns the ceiling
    // into a lifetime total: a thinker spending 4k a wake under the shipped
    // 120k cap starts erroring around wake 30 and never recovers. The delta is
    // this step's spend, which is what M10 says is capped (B1).
    const spentBefore = usageTokens(inner.getUsage());
    let output: unknown;
    let error: unknown;
    try {
      output = await inner.forward(ai, values, {
        ...(options ?? {}),
        ...(signal ? { abortSignal: signal } : {}),
      } as Readonly<AxProgramForwardOptions<string>>);
      const tokens = usageTokens(inner.getUsage()) - spentBefore;
      if (tokens > step.budget.maxTokens) {
        throw new AxMindBudgetExceededError('tokens', step.budget.maxTokens);
      }
    } catch (thrown) {
      error = deadline.signal.aborted
        ? new AxMindBudgetExceededError('wallClock', step.budget.maxWallClockMs)
        : thrown;
    } finally {
      deadline.abort();
      await timer;
      runtime.running--;
    }
    step.output = output;
    step.error = error;
    // A thinker's sinks run AFTER `forward` resolves and only when the run
    // produced an output (`AxEventRuntime.dispatchFinalSinks`). This mirrors
    // that condition exactly, so the mind never waits for a sink pass the
    // runtime will not make; the trailing `mind-settle` sink closes the step
    // once the thinker's own sinks have had their turn.
    if (error === undefined && output !== undefined && thinker.sinks?.length) {
      return output;
    }
    // The settle takes NEITHER the step deadline (aborted in the `finally`
    // above) NOR the delivery's own signal: the runtime aborts a delivery on a
    // cancelled run and on a lapsed claim heartbeat while the mind is still
    // open, and settling under it would drop the outcome step, the pace step
    // and the ladder's arm for exactly the wakes worth recording.
    await this.settleDelivery(deliveryId);
    if (error !== undefined) throw error;
    return output;
  }

  /**
   * Closes one delivery exactly once. Reached from the run, from the trailing
   * `mind-settle` sink, and from the tick's reaper, so the identity of the
   * caller cannot decide whether the ladder advances.
   */
  private async settleDelivery(deliveryId: string): Promise<void> {
    const step = this.pending.get(deliveryId);
    if (!step || step.settled) return;
    step.settled = true;
    this.pending.delete(deliveryId);
    if (this.closed) return;
    try {
      // The MIND's lifetime signal, and nothing else. It is the one condition
      // under which the appends below must not land.
      await this.settleStep(
        step,
        step.output,
        step.error,
        this.lifetime.signal
      );
    } catch (thrown) {
      // The settle is the arming path, so it has to survive its own failure:
      // an append that throws here would otherwise end the ladder silently.
      this.armLivenessFallback(
        step.runtime,
        `settling ${deliveryId} failed: ${String(thrown)}`
      );
    }
  }

  /**
   * M7 layer (b). A delivery that terminalised without a settle recorded no
   * arm, and `dispatchedWakeAt` was stamped at delivery, so the pace duty would
   * stay suppressed forever. One wake is re-armed a bounded delay out -- the
   * thinker's own slowest scheduled cadence, never the stale `wakeAt` -- so a
   * projection that keeps throwing retries on a grid instead of hot-looping.
   */
  private armLivenessFallback(runtime: ThinkerRuntime, reason: string): void {
    const config = runtime.thinker.pacer ?? this.pacerConfig;
    runtime.nextWakeAt = this.clock.now() + Math.max(1, config.capMs);
    runtime.dispatchedWakeAt = undefined;
    this.diagnose(
      'liveness-fallback-armed',
      `${runtime.thinker.name}: ${reason}; one wake re-armed in ${config.capMs}ms`,
      runtime.thinker.name
    );
  }

  /**
   * A delivery whose settle never ran -- an abort between `forward` and the
   * sinks, a lost lease, a `createProgram` throw -- would hold a `PendingStep`
   * (a whole step plus both probe results) forever AND leave the pace duty
   * suppressed. Both are bounded HERE, on the one always-alive tick: a step
   * cannot legitimately outlive its own deadline, and the doubling is slack for
   * the settle's own IO.
   */
  private reapAbandonedSteps(): void {
    const now = this.clock.now();
    for (const [deliveryId, step] of [...this.pending]) {
      if (step.settled) continue;
      if (now - step.startedAt < step.budget.maxWallClockMs * 2) continue;
      step.error ??= new AxMindLivenessError(
        `AxMind never settled delivery ${deliveryId} for ${step.runtime.thinker.name}; the wake terminalised with no pace decision`,
        'source_failed'
      );
      // Armed HERE and not only inside the settle: a mind that is closing
      // appends nothing, and the record still has to be released.
      this.armLivenessFallback(
        step.runtime,
        `delivery ${deliveryId} outlived its own deadline without settling`
      );
      void this.settleDelivery(deliveryId).catch(() => undefined);
    }
  }

  /**
   * The thinker whose step is running owns the spend. "Whichever thinker is
   * running, in insertion order" charges a responder's sub-run to the
   * monolith's cap and then refuses the monolith's own sub-runs with a spend it
   * never made, so an ambiguous caller is refused instead of guessed at (M5).
   */
  private resolveSubRunOwner(name?: string): ThinkerRuntime | undefined {
    if (name !== undefined) {
      const named = this.thinkers.get(name);
      if (!named) {
        throw new AxMindConfigurationError(
          `AxMind has no thinker named ${name}; a sub-run charges the budget of a thinker in the table`,
          'unknown_thinker'
        );
      }
      return named;
    }
    const running = [...this.thinkers.values()].filter(
      (one) => one.running > 0
    );
    if (running.length > 1) {
      throw new AxMindConfigurationError(
        `AxMind has ${running.length} thinker steps in flight; a sub-run must name the thinker whose budget it spends`,
        'ambiguous_subrun'
      );
    }
    // None running is legitimate: a host sub-run outside a step charges the
    // mind's default budget, and says so by finding no owner.
    return running[0];
  }

  /**
   * The probe, the outcome step and the pace decision. Split out so the arming
   * path is one function a reviewer can read against the ladder table.
   */
  private async settleStep(
    step: PendingStep,
    output: unknown,
    error: unknown,
    signal?: AbortSignal
  ): Promise<AxMindWakeOutcome> {
    const runtime = step.runtime;
    const { thinker } = runtime;
    const after = await axMindWorkProbe(
      this.options.store,
      this.options.trajectoryId,
      this.registry,
      signal
    );
    const result = {
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      before: step.before,
      after,
    };
    const outcome = thinker.classify
      ? await thinker.classify(result)
      : axMindWakeOutcomeOf(result);
    if (outcome === 'error') {
      // A crash is a DISTINCT STATE from calm resting, in the log and in the
      // policy. Recording it as `idle` is how a broken mind reads as healthy.
      runtime.consecutiveErrors++;
      this.lastErrorAt = this.clock.now();
      this.lastError = String(error);
      await this.appendInternal(
        {
          type: 'error',
          source: thinker.name,
          launchedBy: thinker.name,
          triggerStep: step.trigger.stepId,
          data: {
            reason: 'run-failed',
            content: String(error),
            revision: this.artifacts.revision,
          },
        },
        signal
      );
    } else {
      runtime.consecutiveErrors = 0;
      if (outcome === 'empty') {
        await this.appendInternal(
          {
            type: 'idle',
            source: thinker.name,
            launchedBy: thinker.name,
            triggerStep: step.trigger.stepId,
            data: {
              wakeClass: step.wakeClass,
              revision: this.artifacts.revision,
            },
          },
          signal
        );
      }
    }
    runtime.wakesSinceShare =
      outcome === 'visible' ? 0 : runtime.wakesSinceShare + 1;
    runtime.lastOutcome = outcome;
    runtime.lastActivityAt = this.clock.now();
    const decision = axNextMindPace(
      runtime.pacer,
      { wakeClass: step.wakeClass, outcome, now: this.clock.now() },
      thinker.pacer ?? this.pacerConfig
    );
    runtime.pacer = decision.state;
    // `unchanged` means LEAVE THE RUNNING TIMER ALONE. Re-arming on a no-op
    // silently resets the backoff on every outgoing reply.
    if (decision.kind === 'arm') runtime.nextWakeAt = decision.state.wakeAt;
    await this.appendInternal(
      {
        type: axMindPaceStepType,
        launchedBy: thinker.name,
        triggerStep: step.trigger.stepId,
        data: axMindPaceStepData({
          wakeClass: step.wakeClass,
          outcome,
          decision,
        }),
      },
      signal
    );
    if (decision.state.parked === 'rate_fuse') {
      await this.appendInternal(
        {
          type: 'mind-error',
          launchedBy: thinker.name,
          data: {
            reason: `spontaneity parked by the rate fuse until ${decision.state.parkedUntil}`,
            parkedUntil: decision.state.parkedUntil ?? 0,
          },
        },
        signal
      );
      this.diagnose(
        'pacer-rate-fuse',
        `${thinker.name} exceeded its spontaneous wake ceiling; reactive wakes continue and spontaneity resumes once the trailing hour drains`,
        thinker.name
      );
    }
    this.reportHealth(this.health());
    this.trajectorySource.notify();
    return outcome;
  }

  private async appendInternal(
    request: Omit<AxTrajectoryAppendRequest, 'trajectoryId'>,
    signal?: AbortSignal
  ): Promise<void> {
    const receipt = await this.options.store.append(
      { ...request, trajectoryId: this.options.trajectoryId },
      signal
    );
    this.newestStep = { seq: receipt.seq, ts: receipt.ts };
  }

  /**
   * The tick's view of mind state. The fuse's one re-evaluation is armed HERE:
   * a parked thinker has no pace duty at all, so without this the only
   * un-parker would be the watchdog, and a thinker with `watchdogMs: 0` would
   * have no liveness layer left.
   */
  private dueDuties(): readonly Readonly<AxMindTickDutyState>[] {
    const now = this.clock.now();
    const states: AxMindTickDutyState[] = [];
    for (const runtime of this.thinkers.values()) {
      const parkedUntil = runtime.pacer.parkedUntil;
      if (
        runtime.pacer.parked === 'rate_fuse' &&
        parkedUntil !== undefined &&
        now >= parkedUntil
      ) {
        const kept = runtime.pacer.spontaneousWakes.filter(
          (at) => at > now - HOUR_MS
        );
        const { parked: _parked, parkedUntil: _until, ...rest } = runtime.pacer;
        runtime.pacer = Object.freeze({
          ...rest,
          spontaneousWakes: Object.freeze(kept),
        });
        // Clearing `parked` alone changes NOTHING: the fuse's decision is
        // `unchanged`, so the kept `wakeAt` is still the one this thinker was
        // already dispatched for, and the pace duty is edge-triggered on that
        // pair. Unstamping is what makes the one re-evaluation actually due;
        // without it a `watchdogMs: 0` thinker is silent forever (M1).
        runtime.nextWakeAt = runtime.pacer.wakeAt ?? now;
        runtime.dispatchedWakeAt = undefined;
      }
      states.push({
        thinker: runtime.thinker.name,
        // Scheduled spontaneity is OPT-IN per thinker (`pacer`). The ladder
        // still runs for every thinker -- the pace record is how C12 recovers
        // -- but a thinker that did not ask for spontaneity never gets a
        // timer, so a responder does not wake itself between messages.
        ...(runtime.thinker.pacer && runtime.nextWakeAt !== undefined
          ? { nextWakeAt: runtime.nextWakeAt }
          : {}),
        ...(runtime.dispatchedWakeAt !== undefined
          ? { dispatchedWakeAt: runtime.dispatchedWakeAt }
          : {}),
        ...(runtime.pacer.parked ? { parked: runtime.pacer.parked } : {}),
        lastActivityAt: runtime.lastActivityAt,
        running: runtime.running,
        deferred: runtime.deferred,
        watchdogMs: runtime.thinker.subscription.watchdogMs,
      });
    }
    return Object.freeze(states);
  }

  health(): Readonly<AxMindHealth> {
    const thinkers: Readonly<AxMindThinkerHealth>[] = [
      ...this.thinkers.values(),
    ].map((runtime) =>
      Object.freeze({
        thinker: runtime.thinker.name,
        running: runtime.running,
        deferred: runtime.deferred,
        newestProcessedSeq:
          this.trajectorySource.cursorSeq(runtime.thinker.name) ?? -1,
        ...(runtime.lastWakeAt !== undefined
          ? { lastWakeAt: runtime.lastWakeAt }
          : {}),
        ...(runtime.nextWakeAt !== undefined
          ? { nextWakeAt: runtime.nextWakeAt }
          : {}),
        pacer: runtime.pacer,
        consecutiveErrors: runtime.consecutiveErrors,
        ...(runtime.lastOutcome ? { lastOutcome: runtime.lastOutcome } : {}),
      })
    );
    return axMindHealth(
      {
        newestStepSeq: this.newestStep.seq,
        newestStepAt: this.newestStep.ts,
        now: this.clock.now(),
        thinkers,
        durability: axMindStoreDurability(this.options.store),
        ...(this.lastDispatchAt !== undefined
          ? { lastDispatchAt: this.lastDispatchAt }
          : {}),
        ...(this.lastErrorAt !== undefined
          ? { lastErrorAt: this.lastErrorAt }
          : {}),
        ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      },
      this.thresholds
    );
  }

  /**
   * The mind's own clock. Model-facing code renders expiry against it rather
   * than `Date.now()`: a mind under an injected clock must not read one time
   * in the ladder and another in the prompt.
   */
  now(): number {
    return this.clock.now();
  }

  getPacerState(thinker: string): Readonly<AxMindPacerState> | undefined {
    return this.thinkers.get(thinker)?.pacer;
  }

  /**
   * Recomputes health and pacer state FROM THE TRAJECTORY, and converges the
   * log to the effect ledger (crash C10). There is no second authority for
   * pacing state: a crash loop cannot restore full-speed spontaneous waking.
   */
  async reconcile(signal?: AbortSignal): Promise<Readonly<AxMindHealth>> {
    for (const runtime of this.thinkers.values()) {
      runtime.pacer = await axRecoverMindPacerState(
        this.options.store,
        this.options.trajectoryId,
        runtime.thinker.name,
        runtime.thinker.pacer ?? this.pacerConfig,
        signal
      );
      if (runtime.pacer.wakeAt !== undefined) {
        runtime.nextWakeAt = runtime.pacer.wakeAt;
        // Deliberately NOT stamped as dispatched: a wake armed before the
        // crash and never delivered must still fire.
        runtime.dispatchedWakeAt = undefined;
      }
    }
    if (this.options.effectLedger) {
      await axMindReconcileChatSends(
        {
          trajectoryId: this.options.trajectoryId,
          store: this.options.store,
          clock: this.clock,
          // The FALLBACK only. Each settled effect carries the thinker that
          // composed it, so a rebuilt message step is attributed to its own
          // writer; this identity is used only for an effect written before
          // that was recorded, or naming a thinker this mind does not have.
          sender: this.options.thinkers[0]?.name ?? 'mind',
          selfSources: [...this.thinkers.keys(), 'mind'],
          ...(this.options.transport
            ? { transport: this.options.transport }
            : {}),
          effects: () => this.options.effectLedger,
          ...(this.options.onDiagnostic
            ? { onDiagnostic: this.options.onDiagnostic }
            : {}),
        },
        signal
      );
    }
    const stats = await this.options.store.stats(
      this.options.trajectoryId,
      signal
    );
    if (stats) this.newestStep = { seq: stats.newestSeq, ts: stats.newestTs };
    const health = this.health();
    this.reportHealth(health);
    return health;
  }

  /** Re-reads artifacts. Prompts/persona/goals/skills only; routes never. */
  async reloadArtifacts(
    signal?: AbortSignal
  ): Promise<Readonly<AxMindArtifacts>> {
    this.artifacts = await this.options.artifacts.load(signal);
    return this.artifacts;
  }

  /**
   * Deliveries that failed past their attempt budget. A dead-lettered wake is
   * invisible in the trajectory by design -- nothing ran, so nothing was
   * appended -- which makes this the only place a host can see one.
   */
  deadLetters(): Promise<readonly Readonly<AxEventDeadLetter>[]> {
    return this.runtime.listDeadLetters();
  }

  /** Inspectable, for hosts and for tests. */
  routes(): readonly AxEventRoute[] {
    return this.routeTable;
  }

  sources(): readonly AxEventSource[] {
    return Object.freeze([
      this.trajectorySource,
      this.tickSource,
      this.bootstrapSource,
    ]);
  }

  waitForIdle(timeoutMs?: number): Promise<void> {
    return this.runtime.waitForIdle(timeoutMs);
  }

  /**
   * Runs one thinker TOOL call. Model-directed code reaches the mind only
   * through a tool, so this is the boundary `close_from_inside` is decided
   * on: precise about the call it must refuse, and silent about a host that
   * happens to be closing while a step runs.
   *
   * A step counter cannot do this job. A PACED mind is never idle by
   * construction -- the tick source keeps arming wakes -- so refusing every
   * close while a step ran would make a persistent mind unclosable, which is
   * a worse failure than the one M14 is guarding against.
   */
  async runThinkerTool<T>(call: () => Promise<T>): Promise<T> {
    this.toolDepth++;
    try {
      return await call();
    } finally {
      this.toolDepth--;
    }
  }

  /**
   * Refused from inside a thinker's own tool call. `close()` is not a tool and
   * never will be, and this is the second layer under that: the mind does not
   * restart itself (M14 item 10). A host close stops the sources first and
   * then drains with its own deadline.
   */
  async close(options?: Readonly<AxEventCloseOptions>): Promise<void> {
    if (this.toolDepth > 0) {
      const explanation = `AxMind.close() was called from inside a thinker's own tool call. A mind does not restart itself; the host owns the restart path.`;
      await this.appendInternal({
        type: 'mind-error',
        data: { reason: explanation, refused: 'close_from_inside' },
      }).catch(() => undefined);
      throw new AxMindLivenessError(explanation, 'close_from_inside');
    }
    if (this.closed) return;
    this.closed = true;
    // Aborted BEFORE the runtime drains: a settle already inside a store read
    // stops there rather than appending into a mind that is going away.
    // `closing`, NOT `close_from_inside`: a host shutting the mind down and a
    // thinker trying to close its own mind are different events, and a host
    // that inspects `reason` on an aborted store call has to tell them apart.
    this.lifetime.abort(
      new AxMindLivenessError(`AxMind ${this.id} is closing`, 'closing')
    );
    await this.runtime.close(options ?? { drain: true });
    // Nothing can settle after this, so the records are released rather than
    // held for the lifetime of the object.
    this.pending.clear();
    if (this.options.ownership && this.ownershipRevision !== undefined) {
      await this.options.ownership.compareAndSet(
        this.id,
        this.ownershipRevision,
        ''
      );
      this.ownershipRevision = undefined;
    }
  }

  private async requireStep(
    stepId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>> {
    const step = await this.options.store.getStep(
      this.options.trajectoryId,
      stepId,
      signal
    );
    if (!step) {
      throw new AxMindLivenessError(
        `AxMind appended ${stepId} but the store cannot read it back`,
        'source_failed'
      );
    }
    return step;
  }

  private diagnose(
    code: AxMindDiagnostic['code'],
    message: string,
    thinker?: string,
    stepId?: string
  ): void {
    this.options.onDiagnostic?.({
      code,
      at: this.clock.now(),
      message,
      ...(thinker ? { thinker } : {}),
      ...(stepId ? { stepId } : {}),
    });
  }
}

/**
 * The factory. `mind` is a bare lowercase name, allow-listed in
 * `scripts/generateIndex.ts` beside `agent()` and `flow()`.
 */
export const mind = (options: Readonly<AxMindOptions>): AxMind =>
  AxMind.create(options);
