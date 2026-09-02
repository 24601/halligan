import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventIngress,
  type AxEventSource,
  type AxEventSourceContext,
  type AxEventSourceHandle,
} from '../event/types.js';
import { axEventId } from '../event/util.js';
import type {
  AxTrajectoryCursor,
  AxTrajectoryStep,
  AxTrajectoryStore,
  AxTrajectoryTypeRegistry,
} from '../trajectory/types.js';
import { axIsTrajectoryCursorError } from '../trajectory/types.js';
import {
  axMindEventSource,
  axMindEventTypes,
  axMindPendingClass,
  axMindStepEventExtensions,
  axMindSubscribedStepTypes,
  axMindThinkerSubject,
} from './routes.js';
import type {
  AxMindDiagnostic,
  AxMindDiagnosticCode,
  AxMindSubscription,
} from './types.js';

const DEFAULT_BATCH = 64;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TICK_MS = 1_000;
const DEFAULT_MAX_IN_FLIGHT = 4;

export interface AxMindTrajectoryConsumer {
  readonly thinker: string;
  readonly subscription: Readonly<AxMindSubscription>;
  /** Live count of running + queued wakes; the source's admission bound. */
  inFlight(): number;
}

export interface AxTrajectoryEventSourceOptions {
  readonly id: string;
  readonly store: AxTrajectoryStore;
  readonly trajectoryId: string;
  readonly registry: AxTrajectoryTypeRegistry;
  readonly consumers: readonly Readonly<AxMindTrajectoryConsumer>[];
  readonly clock: AxEventClock;
  /** Steps per drain pass. Default 64. */
  readonly batchSize?: number;
  /** Fallback poll interval. Default 1_000. `notify()` is a latency hint only. */
  readonly pollIntervalMs?: number;
  /** The CloudEvents `source` the mind's routes match. */
  readonly eventSource?: string;
  readonly onDiagnostic?: (diagnostic: Readonly<AxMindDiagnostic>) => void;
}

interface ConsumerState {
  readonly consumer: Readonly<AxMindTrajectoryConsumer>;
  readonly consumerId: string;
  readonly types: ReadonlySet<string>;
  cursor?: Readonly<AxTrajectoryCursor>;
  loaded: boolean;
  paused: boolean;
}

type Unit = Readonly<{
  steps: readonly Readonly<AxTrajectoryStep>[];
  publish: boolean;
  coalesced?: number;
}>;

/**
 * Sleep that leaves no listener on a long-lived signal. `AxEventClock.sleep`
 * registers an abort listener it never removes on resolve, so passing a source
 * lifetime signal straight into a polling loop grows one listener per pass.
 */
function sleepQuietly(
  clock: AxEventClock,
  ms: number,
  signal: AbortSignal,
  local: AbortController
): Promise<void> {
  const onAbort = () => local.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return clock
    .sleep(ms, local.signal)
    .catch(() => undefined)
    .finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * Publishes `ax.trajectory.step` per appended step, per consumer, from that
 * consumer's DURABLE cursor. `requiresDurable` is false on purpose: the
 * runtime flag checks the EVENT store, not this one, and AxMind checks the
 * trajectory store's durability itself.
 *
 * NOTHING IS EVER DROPPED. At a consumer's admission bound, or on
 * `AxEventBackpressureError`, the source stops advancing THAT consumer's
 * cursor and retries next pass; the append-only log is the backlog.
 */
export class AxTrajectoryEventSource implements AxEventSource {
  readonly id: string;
  readonly requiresDurable = false;

  private readonly states: readonly ConsumerState[];
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly eventSource: string;
  private waiter?: AbortController;

  constructor(
    private readonly options: Readonly<AxTrajectoryEventSourceOptions>
  ) {
    this.id = options.id;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.eventSource = options.eventSource ?? axMindEventSource(options.id);
    this.states = options.consumers.map((consumer) => ({
      consumer,
      consumerId: `${options.id}:${consumer.thinker}`,
      types: new Set(
        axMindSubscribedStepTypes(consumer.subscription, options.registry)
      ),
      loaded: false,
      paused: false,
    }));
  }

  start(context: Readonly<AxEventSourceContext>): AxEventSourceHandle {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    void this.loop(context, controller.signal).catch((error) => {
      if (!controller.signal.aborted) context.reportError(error);
    });
    return {
      close: () => {
        context.signal.removeEventListener('abort', onAbort);
        controller.abort(`Trajectory source ${this.id} closed`);
        this.waiter?.abort();
      },
    };
  }

  /** In-process hint that new steps exist. Correctness never depends on it. */
  notify(): void {
    this.waiter?.abort();
  }

  /** Drains every consumer once. Exposed so a test drives passes explicitly. */
  async drain(
    context: Readonly<AxEventSourceContext>,
    signal?: AbortSignal
  ): Promise<void> {
    for (const state of this.states) {
      if (signal?.aborted) return;
      if (state.paused) continue;
      try {
        await this.drainConsumer(state, context, signal);
      } catch (error) {
        // A cursor that no longer names a frame boundary is host business:
        // pause THIS consumer loudly rather than corrupt its position, and
        // leave every other consumer running.
        if (!axIsTrajectoryCursorError(error)) throw error;
        state.paused = true;
        this.diagnose('cursor-paused', state.consumer.thinker, error.message);
        context.reportError(error);
      }
    }
  }

  private async loop(
    context: Readonly<AxEventSourceContext>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.drain(context, signal);
      } catch (error) {
        if (!signal.aborted) context.reportError(error);
      }
      if (signal.aborted) break;
      const local = new AbortController();
      this.waiter = local;
      await sleepQuietly(
        this.options.clock,
        this.pollIntervalMs,
        signal,
        local
      );
      this.waiter = undefined;
    }
  }

  private async drainConsumer(
    state: ConsumerState,
    context: Readonly<AxEventSourceContext>,
    signal?: AbortSignal
  ): Promise<void> {
    const { store, trajectoryId } = this.options;
    if (!state.loaded) {
      const saved = await store.loadCursor(
        state.consumerId,
        trajectoryId,
        signal
      );
      if (saved) {
        state.cursor = saved;
      } else {
        // No stored cursor means a new consumer: start at the CURRENT END.
        // Silently backfilling an existing log would replay a whole life. The
        // seek is O(1) -- `stats` then a one-step read for the frame token --
        // because no read primitive here is allowed to be unbounded.
        const stats = await store.stats(trajectoryId, signal);
        const end = await store.readFrom(
          { trajectoryId, seq: (stats?.newestSeq ?? -1) + 1 },
          trajectoryId,
          { maxSteps: 1 },
          signal
        );
        state.cursor = end.cursor;
        await store.saveCursor(state.consumerId, end.cursor, signal);
      }
      state.loaded = true;
    }
    const max =
      state.consumer.subscription.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    let budget = this.batchSize;
    while (budget > 0 && !signal?.aborted) {
      if (state.consumer.inFlight() >= max) {
        this.defer(state.consumer.thinker, 'admission bound reached');
        return;
      }
      const peek = await store.readFrom(
        state.cursor,
        trajectoryId,
        { maxSteps: budget },
        signal
      );
      if (peek.steps.length === 0) return;
      const units = this.plan(peek.steps, state);
      let consumed = 0;
      let deferred = false;
      for (const unit of units) {
        if (unit.publish) {
          if (state.consumer.inFlight() >= max) {
            this.defer(state.consumer.thinker, 'admission bound reached');
            deferred = true;
            break;
          }
          const published = await this.publish(unit, state, context, signal);
          if (!published) {
            deferred = true;
            break;
          }
        }
        consumed += unit.steps.length;
      }
      if (consumed > 0) {
        const advance =
          consumed === peek.steps.length
            ? peek
            : await store.readFrom(
                state.cursor,
                trajectoryId,
                { maxSteps: consumed },
                signal
              );
        state.cursor = advance.cursor;
        await store.saveCursor(state.consumerId, advance.cursor, signal);
      }
      if (deferred) return;
      budget -= peek.steps.length;
      if (peek.caughtUp) return;
    }
  }

  /**
   * Groups a slice into commit units. A maximal run of consecutive wake-signal
   * steps of one subscribed type collapses last-wins with a visible
   * `coalesced` count; everything else is one step per unit. A unit commits
   * whole, so a deferral can never consume a superseded step whose superseder
   * was never published.
   */
  private plan(
    steps: readonly Readonly<AxTrajectoryStep>[],
    state: ConsumerState
  ): readonly Unit[] {
    const units: Unit[] = [];
    for (const step of steps) {
      const wakeable =
        this.options.registry.describe(step.type).wakeable &&
        state.types.has(step.type) &&
        step.trajectoryId === this.options.trajectoryId;
      if (!wakeable) {
        units.push({ steps: [step], publish: false });
        continue;
      }
      const previous = units.at(-1);
      const coalescing =
        axMindPendingClass(step.type, this.options.registry) === 'coalesce';
      if (
        coalescing &&
        previous?.publish &&
        previous.steps.at(-1)?.type === step.type
      ) {
        units[units.length - 1] = {
          steps: [...previous.steps, step],
          publish: true,
          coalesced: previous.steps.length + 1,
        };
        continue;
      }
      units.push({ steps: [step], publish: true });
    }
    return units;
  }

  private async publish(
    unit: Unit,
    state: ConsumerState,
    context: Readonly<AxEventSourceContext>,
    signal?: AbortSignal
  ): Promise<boolean> {
    const step = unit.steps.at(-1)!;
    const ingress: AxEventIngress = {
      event: {
        specversion: '1.0',
        id: `${step.stepId}:${state.consumer.thinker}`,
        source: this.eventSource,
        type: axMindEventTypes.step,
        subject: step.type,
        time: new Date(step.ts).toISOString(),
        data: {
          stepId: step.stepId,
          trajectoryId: step.trajectoryId,
          seq: step.seq,
          type: step.type,
          ts: step.ts,
          thinker: state.consumer.thinker,
          ...(step.source !== undefined ? { source: step.source } : {}),
          ...(step.runId !== undefined ? { runId: step.runId } : {}),
          ...(step.triggerStep !== undefined
            ? { triggerStep: step.triggerStep }
            : {}),
          ...(unit.coalesced !== undefined
            ? { coalesced: unit.coalesced }
            : {}),
        },
        extensions: axMindStepEventExtensions(step),
      },
      trust: 'trusted',
    };
    try {
      await context.publish(ingress, signal);
      if (unit.coalesced !== undefined) {
        this.diagnose(
          'wake-coalesced',
          state.consumer.thinker,
          `${unit.coalesced} ${step.type} wakes collapsed into ${step.stepId}`,
          step.stepId
        );
      }
      return true;
    } catch (error) {
      // The inbox is full. Hold the cursor rather than lose the wake: the
      // step is durable, so the next pass republishes it.
      if (!(error instanceof AxEventBackpressureError)) throw error;
      this.defer(state.consumer.thinker, error.message, step.stepId);
      return false;
    }
  }

  private defer(thinker: string, message: string, stepId?: string): void {
    this.diagnose('wake-deferred-backpressure', thinker, message, stepId);
  }

  private diagnose(
    code: AxMindDiagnosticCode,
    thinker: string,
    message: string,
    stepId?: string
  ): void {
    this.options.onDiagnostic?.({
      code,
      thinker,
      at: this.options.clock.now(),
      message,
      ...(stepId ? { stepId } : {}),
    });
  }
}

export interface AxMindTickDuty {
  readonly thinker: string;
  readonly kind: 'wake' | 'idle';
  readonly coalesced?: number;
}

export interface AxMindTickDutyState {
  readonly thinker: string;
  /** Armed by the pacer. Absent means no scheduled wake is pending. */
  readonly nextWakeAt?: number;
  /** Newest dispatch, append or completion this thinker saw. */
  readonly lastActivityAt: number;
  readonly running: number;
  readonly deferred: number;
  /** 0 disables the watchdog for this thinker. */
  readonly watchdogMs: number;
}

/**
 * The tick's two duties as one pure query, so liveness is a decision a test
 * can make in a single call. Running or deferred work refreshes the watchdog
 * window: a long agentic run must not end in a spurious idle wake.
 */
export function axMindTickDue(
  states: readonly Readonly<AxMindTickDutyState>[],
  now: number,
  options?: Readonly<{
    intervalMs?: number;
    pace?: boolean;
    watchdog?: boolean;
  }>
): readonly Readonly<AxMindTickDuty>[] {
  const intervalMs = Math.max(1, options?.intervalMs ?? DEFAULT_TICK_MS);
  const pace = options?.pace ?? true;
  const watchdog = options?.watchdog ?? true;
  const due: AxMindTickDuty[] = [];
  for (const state of states) {
    if (pace && state.nextWakeAt !== undefined && now >= state.nextWakeAt) {
      // A wake that fell behind by k grid slots stands for k, reported rather
      // than silently collapsed.
      const missed = Math.floor((now - state.nextWakeAt) / intervalMs);
      due.push({
        thinker: state.thinker,
        kind: 'wake',
        ...(missed > 0 ? { coalesced: missed + 1 } : {}),
      });
      continue;
    }
    if (
      watchdog &&
      state.watchdogMs > 0 &&
      state.running === 0 &&
      state.deferred === 0 &&
      now - state.lastActivityAt >= state.watchdogMs
    ) {
      due.push({ thinker: state.thinker, kind: 'idle' });
    }
  }
  return Object.freeze(due);
}

export interface AxMindTickEventSourceOptions {
  readonly id: string;
  readonly clock: AxEventClock;
  /** Grid resolution. Default 1_000. */
  readonly intervalMs?: number;
  /** Both duties default on; either can be disabled without the other. */
  readonly pace?: boolean;
  readonly watchdog?: boolean;
  /** Pure query over mind state; the source owns no state of its own. */
  readonly due: () => readonly Readonly<AxMindTickDuty>[];
  readonly eventSource?: string;
  readonly onDiagnostic?: (diagnostic: Readonly<AxMindDiagnostic>) => void;
}

/**
 * ONE always-alive tick, two checks. A spawned per-step timer is a failure
 * mode; an always-alive loop that owns an injected clock is not. Constructing
 * this starts nothing -- ax starts no timers unless a source is started (M16).
 */
export class AxMindTickEventSource implements AxEventSource {
  readonly id: string;
  readonly requiresDurable = false;

  private readonly intervalMs: number;
  private readonly eventSource: string;

  constructor(
    private readonly options: Readonly<AxMindTickEventSourceOptions>
  ) {
    this.id = options.id;
    this.intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_TICK_MS);
    this.eventSource = options.eventSource ?? axMindEventSource(options.id);
  }

  start(context: Readonly<AxEventSourceContext>): AxEventSourceHandle {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    void this.loop(context, controller.signal).catch((error) => {
      if (!controller.signal.aborted) context.reportError(error);
    });
    return {
      close: () => {
        context.signal.removeEventListener('abort', onAbort);
        controller.abort(`Mind tick source ${this.id} closed`);
      },
    };
  }

  /** One grid pass. Exposed so a test drives ticks without a wall clock. */
  async tick(
    context: Readonly<AxEventSourceContext>,
    signal?: AbortSignal
  ): Promise<void> {
    const pace = this.options.pace ?? true;
    const watchdog = this.options.watchdog ?? true;
    for (const duty of this.options.due()) {
      if (duty.kind === 'wake' && !pace) continue;
      if (duty.kind === 'idle' && !watchdog) continue;
      const now = this.options.clock.now();
      await context.publish(
        {
          event: {
            specversion: '1.0',
            id: axEventId(`${this.id}-${duty.kind}`),
            source: this.eventSource,
            type:
              duty.kind === 'wake'
                ? axMindEventTypes.wake
                : axMindEventTypes.idle,
            subject: axMindThinkerSubject(duty.thinker),
            time: new Date(now).toISOString(),
            data: {
              thinker: duty.thinker,
              ...(duty.coalesced !== undefined
                ? { coalesced: duty.coalesced }
                : {}),
            },
            extensions: { stepsource: 'mind-tick' },
          },
          trust: 'trusted',
        },
        signal
      );
      if (duty.kind === 'idle') {
        this.options.onDiagnostic?.({
          code: 'watchdog-fired',
          thinker: duty.thinker,
          at: now,
          message: `no activity within the watchdog window; synthesized idle for ${duty.thinker}`,
        });
      }
    }
  }

  private async loop(
    context: Readonly<AxEventSourceContext>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      const local = new AbortController();
      await sleepQuietly(this.options.clock, this.intervalMs, signal, local);
      if (signal.aborted) break;
      await this.tick(context, signal);
    }
  }
}
