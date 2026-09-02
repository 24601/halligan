import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type AxEventEffect,
  type AxEventStore,
  AxInMemoryEventStore,
  AxInMemoryTrajectoryRollupStore,
  AxInMemoryTrajectoryStore,
  AxManualEventClock,
  type AxMindChatMessage,
  type AxMindChatTransport,
  type AxMindEffectLedger,
  type AxMindSendReceipt,
  type AxProgrammable,
  AxSignature,
  type AxTrajectoryAppendReceipt,
  type AxTrajectoryAppendRequest,
  AxTrajectoryCursorError,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  axBuildTrajectoryRollups,
  axDefaultMindPacerConfig,
  axDeterministicTrajectorySummarizer,
  axEventId,
  axInitialMindPacerState,
  axMindChat,
  axMindChatIdempotencyKey,
  axMindChatOperation,
  axMindPaceStepData,
  axMindPaceStepType,
  axMindReconcileChatSends,
  axMindStaticArtifacts,
  axNextMindPace,
  axRecoverMindPacerState,
  mind,
} from '../src/ax/index.js';

export const AX_MIND_DURABILITY_HONESTY =
  'This is a deterministic zero-cost mechanism evaluation with fault injection. It is bounded machinery evidence -- pacing, liveness, idempotency, projection shape and size, store conformance, and crash classification. It is not a held-out model comparison. It says nothing about whether the mind thinks well, chooses good routes, or writes useful memories, and no claim of that kind is made.';

export const AX_MIND_DURABILITY_BASELINES =
  'The same matrix with the watchdog disabled, and the naive "reply if the last message in the log is theirs" guard in place of axResolveMindReplyState.';

const TRAJECTORY = 'traj-durability';
const SELF = 'mind';
const MESSAGES = 20;
const RESPONDERS = 3;
const WATCHDOG_MS = 300_000;

export type AxMindCrashRow =
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8'
  | 'C9'
  | 'C10'
  | 'C11'
  | 'C12'
  | 'C13'
  | 'C14';

export interface AxMindDurabilityRow {
  readonly row: AxMindCrashRow;
  readonly killPoint: string;
  readonly stepsAppended: number;
  readonly stepsLost: number;
  readonly duplicateSends: number;
  readonly effectsDispatched: number;
  readonly effectsParked: number;
  readonly effectsSettled: number;
  /** Recovery latency expressed in watchdog windows; 0 means no wait. */
  readonly recoveryWatchdogWindows: number;
  /** send() calls the transport actually received in this row. */
  readonly transportCalls: number;
  readonly mindAlive: boolean;
  readonly note: string;
}

export interface AxMindDurabilityReport {
  readonly command: string;
  readonly honesty: string;
  readonly baseline: string;
  readonly budget: Readonly<{
    providerCalls: number;
    tokens: number;
    usd: number;
  }>;
  readonly rows: readonly AxMindDurabilityRow[];
  /** The headline: three responders, twenty messages, faults throughout. */
  readonly concurrency: Readonly<{
    responders: number;
    inboundMessages: number;
    /** send() calls the transport actually received: exactly one per message. */
    transportSends: number;
    /** Outbound message steps in the log, once every send was confirmed. */
    messagesSent: number;
    /**
     * Sends that LEFT but whose call threw. The effect stays `dispatched` for
     * a resolver and is never re-dispatched blind (C8), so these are missing
     * from the log until a resolver settles them.
     */
    unconfirmedSends: number;
    /** After a resolver settled the unconfirmed effects and reconcile ran. */
    messagesAfterResolver: number;
    /** Reported BESIDE the send count: zero duplicates is also satisfiable by never replying. */
    declinesRecorded: number;
    duplicateSends: number;
    transportFailures: number;
  }>;
  /** The declared guard baseline, run over the same interleaving. */
  readonly naiveGuardBaseline: Readonly<{
    messagesSent: number;
    duplicateSends: number;
  }>;
  /** The declared liveness baseline: the same broken chain, no watchdog. */
  readonly watchdogBaseline: Readonly<{
    withWatchdogWakes: number;
    withoutWatchdogWakes: number;
  }>;
}

/**
 * A host adapter satisfying `AxMindEffectLedger` over the REAL
 * `AxInMemoryEventStore` effect state machine, including its fencing. This is
 * the seam RFC 6.6 C10 needs and `AxMindOptions.effectLedger` names:
 * `AxEventContext.listEffects()` reports the current delivery's effects only,
 * so recovering the sends of deliveries that are already gone has to come
 * from somewhere else. `crash()` abandons the current delivery and claims a
 * new one, exactly as a restarted process would.
 */
class HostEffectLedger implements AxMindEffectLedger {
  private deliveryIds: string[] = [];
  private deliveryId = '';
  private fencingToken = 0;
  private runId = axEventId('run');

  constructor(
    private readonly store: AxEventStore & {
      declareEffect: NonNullable<AxEventStore['declareEffect']>;
      transitionEffect: NonNullable<AxEventStore['transitionEffect']>;
      listEffects: NonNullable<AxEventStore['listEffects']>;
    },
    private readonly clock: AxManualEventClock
  ) {}

  async open(): Promise<void> {
    const eventId = axEventId('ledger-lease');
    await this.store.enqueue({
      ingress: {
        event: {
          specversion: '1.0',
          id: eventId,
          source: 'ax://mind/durability',
          type: 'ax.mind.wake',
        },
        trust: 'trusted',
      },
      deliveries: [
        {
          routeId: 'ledger',
          action: 'wake',
          targetId: 'ledger',
          // A distinct instance per lease: strict ordering would otherwise
          // hold the new lease behind the one the crash abandoned.
          instanceKey: `ledger-${this.deliveryIds.length}`,
          sizeBytes: 0,
        },
      ],
      acceptedAt: this.clock.now(),
    });
    const delivery = await this.store.claim(
      'ledger-worker',
      this.clock.now(),
      3_600_000
    );
    if (!delivery) throw new Error('the ledger lease could not be claimed');
    this.deliveryId = delivery.id;
    this.fencingToken = delivery.fencingToken ?? 0;
    this.deliveryIds.push(delivery.id);
    this.runId = axEventId('run');
  }

  /** Injected faults: the kill points C7 and C9 live INSIDE the ledger. */
  failDispatch = 0;
  failSettle = 0;

  /** Simulates a process death: the lease is gone, the effects are not. */
  async crash(): Promise<void> {
    await this.open();
  }

  private fence() {
    return { deliveryId: this.deliveryId, fencingToken: this.fencingToken };
  }

  async declareEffect(
    intent: Parameters<AxMindEffectLedger['declareEffect']>[0]
  ) {
    return this.store.declareEffect(
      {
        ...structuredClone(intent),
        id: axEventId('effect'),
        deliveryId: this.deliveryId,
        runId: this.runId,
        identityScope: 'durability',
        createdAt: this.clock.now(),
      },
      this.fence()
    );
  }

  async markEffectDispatched(effectId: string, expectedVersion: number) {
    if (this.failDispatch > 0) {
      this.failDispatch--;
      // C7: nothing left the process. The effect stays `intent`.
      throw new Error('the process died before the effect was dispatched');
    }
    return this.store.transitionEffect(
      effectId,
      expectedVersion,
      { type: 'dispatched', at: this.clock.now() },
      this.fence()
    );
  }

  async settleEffect(
    effectId: string,
    expectedVersion: number,
    settlement: Parameters<AxMindEffectLedger['settleEffect']>[2]
  ) {
    if (this.failSettle > 0) {
      this.failSettle--;
      // C9: the message LEFT. The effect stays `dispatched` for a resolver.
      throw new Error('the process died before the effect was settled');
    }
    return this.store.transitionEffect(
      effectId,
      expectedVersion,
      { type: 'settled', at: this.clock.now(), settlement },
      this.fence()
    );
  }

  /** ACROSS every delivery this adapter has held. That is the whole point. */
  async listEffects(): Promise<readonly Readonly<AxEventEffect>[]> {
    const all: Readonly<AxEventEffect>[] = [];
    for (const id of this.deliveryIds)
      all.push(...(await this.store.listEffects(id)));
    return all;
  }
}

export type AxMindTransportFault = 'dispatch' | 'send' | 'settle' | null;

/**
 * Fails where the crash matrix says to fail. `send` throws AFTER recording
 * that the message left, which is the whole difficulty of row C8: a thrown
 * transport call is not proof of failure.
 */
function faultingTransport(options: {
  failIn?: AxMindTransportFault;
  failures?: number;
}) {
  let remaining = options.failIn ? (options.failures ?? 1) : 0;
  const sent: Readonly<AxMindChatMessage>[] = [];
  const keys: string[] = [];
  let failures = 0;
  const transport: AxMindChatTransport = {
    id: 'faulting-transport',
    selfName: SELF,
    async send(message, context): Promise<AxMindSendReceipt> {
      if (options.failIn === 'send' && remaining > 0) {
        remaining--;
        failures++;
        // It LEFT. The throw is only the caller's uncertainty.
        sent.push(message);
        keys.push(context.idempotencyKey);
        throw new Error('the transport did not confirm');
      }
      sent.push(message);
      keys.push(context.idempotencyKey);
      return { externalId: `ext-${sent.length}`, at: 1_000 + sent.length };
    },
  };
  return {
    transport,
    sent,
    keys,
    get failures() {
      return failures;
    },
    duplicates: () => keys.length - new Set(keys).size,
  };
}

/** Fails an append at a chosen point, so a step can be lost on purpose. */
class FaultInjectingTrajectoryStore implements AxTrajectoryStore {
  failAppends = 0;
  constructor(private readonly inner: AxTrajectoryStore) {}
  get capabilities() {
    return this.inner.capabilities;
  }
  get clock() {
    return this.inner.clock;
  }
  get blobs() {
    return this.inner.blobs;
  }
  async append(
    request: Readonly<AxTrajectoryAppendRequest>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryAppendReceipt>> {
    if (this.failAppends > 0) {
      this.failAppends--;
      throw new Error('the append never returned');
    }
    return this.inner.append(request, signal);
  }
  create: AxTrajectoryStore['create'] = (...args) => this.inner.create(...args);
  getTrajectory: AxTrajectoryStore['getTrajectory'] = (...args) =>
    this.inner.getTrajectory(...args);
  read: AxTrajectoryStore['read'] = (...args) => this.inner.read(...args);
  tailBackward: AxTrajectoryStore['tailBackward'] = (...args) =>
    this.inner.tailBackward(...args);
  getStep: AxTrajectoryStore['getStep'] = (...args) =>
    this.inner.getStep(...args);
  getSteps: AxTrajectoryStore['getSteps'] = (...args) =>
    this.inner.getSteps(...args);
  readFrom: AxTrajectoryStore['readFrom'] = (...args) =>
    this.inner.readFrom(...args);
  stats: AxTrajectoryStore['stats'] = (...args) => this.inner.stats(...args);
  fork: AxTrajectoryStore['fork'] = (...args) => this.inner.fork(...args);
  merge: AxTrajectoryStore['merge'] = (...args) => this.inner.merge(...args);
  loadCursor: AxTrajectoryStore['loadCursor'] = (...args) =>
    this.inner.loadCursor(...args);
  saveCursor: AxTrajectoryStore['saveCursor'] = (...args) =>
    this.inner.saveCursor(...args);
}

interface Bed {
  readonly clock: AxManualEventClock;
  readonly store: AxTrajectoryStore;
  readonly faulting: FaultInjectingTrajectoryStore;
  readonly events: AxInMemoryEventStore;
  readonly ledger: HostEffectLedger;
}

async function bed(): Promise<Bed> {
  const clock = new AxManualEventClock(1_000);
  const inner = new AxInMemoryTrajectoryStore({ clock });
  await inner.create({ trajectoryId: TRAJECTORY });
  const faulting = new FaultInjectingTrajectoryStore(inner);
  const events = new AxInMemoryEventStore({ clock });
  const ledger = new HostEffectLedger(events as never, clock);
  await ledger.open();
  return { clock, store: faulting, faulting, events, ledger };
}

async function inbound(
  store: AxTrajectoryStore,
  from: string,
  content: string
): Promise<Readonly<AxTrajectoryStep>> {
  const receipt = await store.append({
    trajectoryId: TRAJECTORY,
    type: 'message',
    source: 'chat',
    data: { from, to: SELF, content },
  });
  return (await store.getStep(TRAJECTORY, receipt.stepId))!;
}

async function outboundSteps(
  store: AxTrajectoryStore
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const tail = await store.tailBackward({
    trajectoryId: TRAJECTORY,
    limit: 500,
    maxScan: 5_000,
    types: ['message'],
  });
  return tail.steps.filter((step) => step.data.from === SELF);
}

async function stepCount(store: AxTrajectoryStore): Promise<number> {
  return (await store.stats(TRAJECTORY))?.stepCount ?? 0;
}

function effectCounts(effects: readonly Readonly<AxEventEffect>[]) {
  return {
    effectsDispatched: effects.filter((one) => one.status === 'dispatched')
      .length,
    effectsParked: effects.filter((one) => one.status === 'parked').length,
    effectsSettled: effects.filter((one) => one.status === 'succeeded').length,
  };
}

/**
 * Liveness MEASURED, never asserted. Every row reported `mindAlive: true` as a
 * literal, which made the paired assertion "row X left the mind dead"
 * unfalsifiable for the rows that never built one. This starts a REAL `AxMind`
 * over the row's own post-crash store and reports whether a thinker step
 * actually ran BEYOND the bootstrap wake, plus how many watchdog windows it
 * took. Nothing here is arithmetic: a store the crash left unusable produces a
 * mind that never wakes, and this returns `false`.
 */
async function measureAliveAfter(
  it: Bed
): Promise<Readonly<{ alive: boolean; watchdogWindows: number }>> {
  const wakes: string[] = [];
  const startedAt = it.clock.now();
  let firstWakeAt: number | undefined;
  const instance = mind({
    id: 'durability-liveness',
    trajectoryId: TRAJECTORY,
    store: it.store,
    clock: it.clock,
    artifacts: axMindStaticArtifacts({
      revision: 'durability',
      persona: 'a mind checking whether it is still alive',
      thinkerPrompts: {},
      goals: [],
      skills: [],
    }),
    thinkers: [
      {
        name: 'liveness',
        kind: 'monolith',
        subscription: {
          triggerSelf: false,
          watchdogMs: WATCHDOG_MS,
          maxInFlight: 4,
        },
        ai: {} as never,
        program: livenessProgram((type) => {
          wakes.push(type);
          if (type !== 'ax.mind.bootstrap' && firstWakeAt === undefined) {
            firstWakeAt = it.clock.now();
          }
        }),
        context: (request) => ({ context: request.projection.render }),
      },
    ],
    budget: { contextWindowTokens: 8_000 },
    allowVolatileTrajectory: true,
    tickMs: 1_000,
    sourcePollMs: 1_000,
  });
  await instance.start();
  // Two watchdog windows of event time, in grid-sized steps.
  for (let round = 0; round < 120 && firstWakeAt === undefined; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    it.clock.advanceBy(WATCHDOG_MS / 12);
  }
  await instance.close({ drain: false, timeoutMs: 200 });
  return Object.freeze({
    alive: firstWakeAt !== undefined,
    watchdogWindows:
      firstWakeAt === undefined
        ? 0
        : Math.ceil((firstWakeAt - startedAt) / WATCHDOG_MS),
  });
}

/** A model-free program that records the event type each wake arrived on. */
function livenessProgram(onWake: (eventType: string) => void) {
  const signature = new AxSignature('context:string -> reply?:string');
  return {
    getId: () => 'liveness-probe',
    setId: () => undefined,
    getSignature: () => signature,
    getTraces: () => [],
    setDemos: () => undefined,
    applyOptimization: () => undefined,
    getOptimizableComponents: () => [],
    applyOptimizedComponents: () => undefined,
    getUsage: () => [],
    getChatLog: () => [],
    resetUsage: () => undefined,
    forward: async (_ai: unknown, _values: unknown, options: any) => {
      onWake(String(options?.eventContext?.ingress?.event?.type ?? 'unknown'));
      return { reply: 'ok' };
    },
    streamingForward: async function* () {},
  } as unknown as AxProgrammable<any, any>;
}

/** One measurement, two reported fields, so neither can drift from the other. */
function aliveFields(
  measured: Readonly<{ alive: boolean; watchdogWindows: number }>
): Readonly<{ mindAlive: boolean; recoveryWatchdogWindows: number }> {
  return Object.freeze({
    mindAlive: measured.alive,
    recoveryWatchdogWindows: measured.watchdogWindows,
  });
}

const chatFor = (
  it: Bed,
  sender: string,
  responders: readonly string[],
  transport: AxMindChatTransport
) =>
  axMindChat({
    trajectoryId: TRAJECTORY,
    store: it.store,
    clock: it.clock,
    sender,
    selfSources: [...responders, 'mind'],
    transport,
    effects: () => it.ledger,
  });

/** C4: after append, before the source publishes. */
async function rowC4(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const trigger = await inbound(it.store, 'ada', 'are you there');
  const before = await stepCount(it.store);
  // The publish never happened. The consumer cursor never advanced, so the
  // next drain republishes from exactly where it stopped.
  const consumerId = 'durability:responder';
  const first = await it.store.readFrom(undefined, TRAJECTORY, { maxSteps: 1 });
  await it.store.saveCursor(consumerId, first.cursor, undefined);
  const resumed = await it.store.readFrom(
    await it.store.loadCursor(consumerId, TRAJECTORY),
    TRAJECTORY,
    { maxSteps: 64 }
  );
  const delivered = resumed.steps.map((step) => step.stepId);
  return {
    row: 'C4',
    killPoint: 'after append, before the source publishes',
    stepsAppended: before,
    stepsLost: delivered.includes(trigger.stepId) ? 0 : 1,
    duplicateSends: 0,
    ...effectCounts(await it.ledger.listEffects()),
    ...aliveFields(await measureAliveAfter(it)),
    transportCalls: 0,
    note: 'the per-consumer durable cursor republished the step; publish is at-least-once and the event store dedupes by scoped identity',
  };
}

/** C5: after publish, before the delivery claim. */
async function rowC5(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const trigger = await inbound(it.store, 'ada', 'still here?');
  await it.events.enqueue({
    ingress: {
      event: {
        specversion: '1.0',
        id: `${trigger.stepId}:responder`,
        source: 'ax://mind/durability',
        type: 'ax.trajectory.step',
        subject: 'message',
      },
      trust: 'trusted',
    },
    deliveries: [
      {
        routeId: 'wake',
        action: 'wake',
        targetId: 'responder',
        instanceKey: 'responder',
        sizeBytes: 0,
      },
    ],
    acceptedAt: it.clock.now(),
  });
  // The process died before claiming. A restarted worker claims normally.
  const claimed = await it.events.claim(
    'worker-restarted',
    it.clock.now(),
    30_000
  );
  return {
    row: 'C5',
    killPoint: 'after publish, before the delivery claim',
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: 0,
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: 0,
    transportCalls: 0,
    mindAlive: claimed !== undefined,
    note: 'the queued delivery survived; a restarted worker claimed it with a fresh fencing token',
  };
}

/** C6: during a thinker step, after the claim. */
async function rowC6(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const trigger = await inbound(it.store, 'ada', 'mid-run crash');
  const fault = faultingTransport({});
  const chat = chatFor(it, 'responder-a', ['responder-a'], fault.transport);
  await chat.claim(trigger.stepId);
  // The lease expires with the claim still standing. The claim is a TTL'd
  // step, so a takeover is not blocked forever by a composer that died.
  it.clock.advanceBy(200_000);
  const state = await chat.replyState(trigger.stepId);
  const takeover = chatFor(
    it,
    'responder-b',
    ['responder-a', 'responder-b'],
    fault.transport
  );
  const sent = await takeover.reply({
    to: 'ada',
    content: 'taking over',
    replyTo: trigger.stepId,
  });
  return {
    row: 'C6',
    killPoint: 'during a thinker step, after the claim',
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: fault.duplicates(),
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: 1,
    transportCalls: fault.sent.length,
    mindAlive: sent.sent && state.state === 'unanswered',
    note: 'the stale claim failed OPEN so the takeover could answer; a retry is safer than a dropped message',
  };
}

/** C7-C9: the three transport kill points, each with its own verdict. */
async function transportRow(
  row: 'C7' | 'C8' | 'C9',
  failIn: AxMindTransportFault,
  killPoint: string,
  note: string
): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const trigger = await inbound(it.store, 'ada', `crash at ${row}`);
  const fault = faultingTransport({ failIn, failures: 1 });
  // Each kill point is injected in the LAYER it names: C7 and C9 die inside
  // the ledger, C8 inside the transport call.
  if (failIn === 'dispatch') it.ledger.failDispatch = 1;
  if (failIn === 'settle') it.ledger.failSettle = 1;
  const chat = chatFor(it, 'responder-a', ['responder-a'], fault.transport);
  let indeterminate = false;
  try {
    await chat.reply({
      to: 'ada',
      content: 'first try',
      replyTo: trigger.stepId,
    });
  } catch {
    indeterminate = true;
  }
  // The process comes back and tries again with the same trigger. The key is
  // byte-identical, so nothing is re-dispatched blind.
  let secondAttemptSent = false;
  try {
    const again = await chat.reply({
      to: 'ada',
      content: 'first try',
      replyTo: trigger.stepId,
    });
    secondAttemptSent = again.sent;
  } catch {
    secondAttemptSent = false;
  }
  const effects = await it.ledger.listEffects();
  return {
    row,
    killPoint,
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: fault.duplicates(),
    ...effectCounts(effects),
    ...aliveFields(await measureAliveAfter(it)),
    transportCalls: fault.sent.length,
    note: `${note} (indeterminate=${indeterminate}, secondAttemptSent=${secondAttemptSent}, effects=${effects.map((one) => one.status).join('/')})`,
  };
}

/** C10: settled effect, no message step. The log converges to the ledger. */
async function rowC10(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const trigger = await inbound(it.store, 'ada', 'converge to the ledger');
  const key = await axMindChatIdempotencyKey({
    identityScope: TRAJECTORY,
    to: 'ada',
    replyTo: trigger.stepId,
  });
  const declared = await it.ledger.declareEffect({
    operation: axMindChatOperation,
    idempotencyKey: key,
    replaySafety: 'unknown',
    metadata: {
      to: 'ada',
      trajectoryId: TRAJECTORY,
      content: 'the reply that never landed in the log',
      replyTo: trigger.stepId,
    },
  });
  const dispatched = await it.ledger.markEffectDispatched(
    declared.id,
    declared.version
  );
  await it.ledger.settleEffect(dispatched.id, dispatched.version, {
    status: 'succeeded',
    receipt: { at: it.clock.now(), externalId: 'ext-lost' },
  });
  // The process died here. A restart claims a NEW delivery, which is why the
  // adapter's listEffects has to span deliveries at all.
  await it.ledger.crash();
  const before = (await outboundSteps(it.store)).length;
  const options = {
    trajectoryId: TRAJECTORY,
    store: it.store,
    clock: it.clock,
    sender: 'responder-a',
    selfSources: ['responder-a', 'mind'],
    transport: faultingTransport({}).transport,
    effects: () => it.ledger as AxMindEffectLedger,
  };
  const appended = await axMindReconcileChatSends(options);
  const after = await outboundSteps(it.store);
  // Reconciling twice must not append twice.
  const again = await axMindReconcileChatSends(options);
  const chat = chatFor(it, 'responder-a', ['responder-a'], options.transport);
  const state = await chat.replyState(trigger.stepId);
  return {
    row: 'C10',
    killPoint: 'after settleEffect, before the outbound message step',
    stepsAppended: await stepCount(it.store),
    stepsLost: after.length === before + 1 ? 0 : 1,
    duplicateSends: again.length,
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: 0,
    transportCalls: 0,
    mindAlive: appended.length === 1 && state.state === 'answered',
    note: 'reconcile appended the missing message step from the settled effect, and a second reconcile appended nothing',
  };
}

/** C11: answered, decision unrecorded. */
async function rowC11(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const trigger = await inbound(it.store, 'ada', 'answered but unrecorded');
  const fault = faultingTransport({});
  const chat = chatFor(it, 'responder-a', ['responder-a'], fault.transport);
  await chat.reply({ to: 'ada', content: 'answered', replyTo: trigger.stepId });
  // No `recordDecision` call at all: the observation is a convenience, never
  // load-bearing. The `replyTo` fact alone decides.
  const state = await chat.replyState(trigger.stepId);
  return {
    row: 'C11',
    killPoint: 'after the outbound step, before the decision observation',
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: fault.duplicates(),
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: 0,
    transportCalls: fault.sent.length,
    mindAlive: state.state === 'answered',
    note: 'answered-ness came from the replyTo fact with no decision observation present',
  };
}

/** C12: between the run outcome and arming the pacer. */
async function rowC12(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const config = axDefaultMindPacerConfig;
  let state = axInitialMindPacerState;
  let now = it.clock.now();
  // Four spontaneous empty wakes, each recorded in the log as it happens.
  for (let wake = 0; wake < 4; wake++) {
    const decision = axNextMindPace(
      state,
      { wakeClass: 'spontaneous', outcome: 'empty', now },
      config
    );
    state = decision.state;
    await it.store.append({
      trajectoryId: TRAJECTORY,
      type: axMindPaceStepType,
      launchedBy: 'monolith',
      ts: now,
      data: axMindPaceStepData({
        wakeClass: 'spontaneous',
        outcome: 'empty',
        decision,
      }),
    });
    now += decision.kind === 'arm' ? Math.max(decision.delayMs, 1_000) : 1_000;
    it.clock.set(now);
  }
  // The process dies with no in-memory pacer state at all.
  const recovered = await axRecoverMindPacerState(
    it.store,
    TRAJECTORY,
    'monolith',
    config
  );
  const matches =
    recovered.level === state.level &&
    recovered.ticks === state.ticks &&
    recovered.wakeAt === state.wakeAt;
  return {
    row: 'C12',
    killPoint: 'between the run outcome and arming the pacer',
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: 0,
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: matches ? 0 : 1,
    transportCalls: 0,
    mindAlive: matches && recovered.level > 0,
    note: `pacer state rebuilt from the trajectory alone: level ${recovered.level}, ticks ${recovered.ticks} -- there is no second authority`,
  };
}

/** C13: during rollup sealing. */
async function rowC13(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  const rollups = new AxInMemoryTrajectoryRollupStore();
  const summarizer = axDeterministicTrajectorySummarizer();
  // Enablement is FORWARD ONLY, so the marker is planted before the log
  // grows: a build over an already-long log seals nothing on purpose.
  await axBuildTrajectoryRollups({
    trajectoryId: TRAJECTORY,
    store: it.store,
    rollups,
    summarizer,
  });
  for (let index = 0; index < 40; index++) {
    await it.store.append({
      trajectoryId: TRAJECTORY,
      type: 'observation',
      source: 'host',
      data: { content: `note ${index}` },
    });
  }
  const first = await axBuildTrajectoryRollups({
    trajectoryId: TRAJECTORY,
    store: it.store,
    rollups,
    summarizer,
    maxBlocks: 2,
  });
  // The process died with some blocks sealed. The frontier recomputes, and a
  // sealed block is immutable: putBlock on an existing key throws.
  const second = await axBuildTrajectoryRollups({
    trajectoryId: TRAJECTORY,
    store: it.store,
    rollups,
    summarizer,
    maxBlocks: 8,
  });
  let resealRefused = false;
  const block = await rollups.getBlock(TRAJECTORY, 1, 0);
  if (block) {
    try {
      await rollups.putBlock(TRAJECTORY, block);
    } catch {
      resealRefused = true;
    }
  }
  return {
    row: 'C13',
    killPoint: 'during rollup sealing',
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: 0,
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: 0,
    transportCalls: 0,
    mindAlive: resealRefused && first.sealed > 0 && second.sealed > 0,
    note: `sealed ${first.sealed} then ${second.sealed} blocks after the kill; re-sealing an existing key was refused`,
  };
}

/** C14: cursor unusable. Fails closed, loudly, for one consumer only. */
async function rowC14(): Promise<AxMindDurabilityRow> {
  const it = await bed();
  await inbound(it.store, 'ada', 'before the identity change');
  const drained = await it.store.readFrom(undefined, TRAJECTORY, {
    maxSteps: 64,
  });
  let raised: unknown;
  try {
    await it.store.readFrom(
      { ...drained.cursor, trajectoryId: 'a-different-life' },
      TRAJECTORY,
      { maxSteps: 8 }
    );
  } catch (error) {
    raised = error;
  }
  // The OTHER consumer keeps running: a paused cursor is one consumer's
  // problem, not the mind's.
  const other = await it.store.readFrom(undefined, TRAJECTORY, {
    maxSteps: 64,
  });
  const cursorError = raised instanceof AxTrajectoryCursorError;
  return {
    row: 'C14',
    killPoint: 'cursor beyond end, identity changed, or the store shrank',
    stepsAppended: await stepCount(it.store),
    stepsLost: 0,
    duplicateSends: 0,
    ...effectCounts(await it.ledger.listEffects()),
    recoveryWatchdogWindows: 0,
    transportCalls: 0,
    mindAlive: cursorError && other.steps.length > 0,
    note: `AxTrajectoryCursorError(${cursorError ? (raised as AxTrajectoryCursorError).reason : 'none'}) paused that consumer and left the other draining`,
  };
}

/**
 * The headline scenario: three responders race on twenty inbound messages
 * while the transport fails every fourth send. Exactly twenty messages must
 * leave, with the recorded declines reported BESIDE that number -- zero
 * duplicates is also satisfiable by never replying at all.
 */
async function concurrency(): Promise<AxMindDurabilityReport['concurrency']> {
  const it = await bed();
  const responders = ['responder-a', 'responder-b', 'responder-c'].slice(
    0,
    RESPONDERS
  );
  const fault = faultingTransport({ failIn: 'send', failures: 5 });
  const chats = responders.map((name) =>
    chatFor(it, name, responders, fault.transport)
  );
  let declines = 0;
  for (let index = 0; index < MESSAGES; index++) {
    const trigger = await inbound(it.store, 'ada', `question ${index}`);
    // Every responder wakes on the same message and races for it.
    for (const chat of chats) {
      try {
        const claimed = await chat
          .claim(trigger.stepId)
          .then(() => true)
          .catch(() => false);
        if (!claimed) continue;
        const result = await chat.reply({
          to: 'ada',
          content: `answer ${index}`,
          replyTo: trigger.stepId,
        });
        if (!result.sent) declines++;
      } catch {
        // An indeterminate send is not a licence to try again with a fresh
        // key: the next responder's reply-state check is what decides.
        declines++;
      }
    }
    // Every message that did not leave gets one recovery pass, which is what
    // a real mind's next wake would do.
    const state = await chats[0]!.replyState(trigger.stepId);
    if (state.state === 'unanswered') {
      await chats[0]!
        .reply({
          to: 'ada',
          content: `answer ${index}`,
          replyTo: trigger.stepId,
        })
        .catch(() => undefined);
    }
  }
  const outbound = await outboundSteps(it.store);
  // What a resolver does on recovery: confirm with the provider, settle the
  // effect, and let the log converge to the ledger (C9 -> C10). Nothing here
  // re-sends; the messages already left.
  let unconfirmed = 0;
  for (const effect of await it.ledger.listEffects()) {
    if (effect.operation !== axMindChatOperation) continue;
    if (effect.status !== 'dispatched') continue;
    unconfirmed++;
    await it.ledger.settleEffect(effect.id, effect.version, {
      status: 'succeeded',
      receipt: { at: it.clock.now(), externalId: `resolved-${effect.id}` },
    });
  }
  await axMindReconcileChatSends({
    trajectoryId: TRAJECTORY,
    store: it.store,
    clock: it.clock,
    sender: responders[0]!,
    selfSources: [...responders, 'mind'],
    transport: fault.transport,
    effects: () => it.ledger as AxMindEffectLedger,
  });
  const settled = await outboundSteps(it.store);
  return {
    responders: responders.length,
    inboundMessages: MESSAGES,
    transportSends: fault.sent.length,
    messagesSent: outbound.length,
    unconfirmedSends: unconfirmed,
    messagesAfterResolver: settled.length,
    declinesRecorded: declines,
    duplicateSends: fault.duplicates(),
    transportFailures: fault.failures,
  };
}

/**
 * The declared guard baseline: "reply if the last message in the log is
 * theirs". It is what a mind without axResolveMindReplyState does, and it
 * must actually produce duplicates or the comparison means nothing.
 */
async function naiveGuardBaseline(): Promise<
  AxMindDurabilityReport['naiveGuardBaseline']
> {
  const it = await bed();
  const sent: string[] = [];
  for (let index = 0; index < 4; index++) {
    const trigger = await inbound(it.store, 'ada', `question ${index}`);
    for (const responder of ['responder-a', 'responder-b', 'responder-c']) {
      const tail = await it.store.tailBackward({
        trajectoryId: TRAJECTORY,
        limit: 1,
        types: ['message'],
      });
      const last = tail.steps.at(-1);
      // The whole guard: is the newest message theirs?
      if (last && last.data.from === 'ada') {
        sent.push(`${trigger.stepId}:${responder}`);
      }
    }
  }
  const keys = sent.map((one) => one.split(':')[0]!);
  return {
    messagesSent: sent.length,
    duplicateSends: keys.length - new Set(keys).size,
  };
}

/**
 * The declared liveness baseline, MEASURED: one REAL mind over one hour of
 * event time with the watchdog on, and the same mind with it off. This used to
 * be `Math.floor(3_600_000 / WATCHDOG_MS)` versus `0` -- arithmetic restating
 * the constants, which is exactly the kind of number a baseline must not be.
 */
async function watchdogBaseline(): Promise<
  AxMindDurabilityReport['watchdogBaseline']
> {
  const measure = async (watchdogMs: number): Promise<number> => {
    const it = await bed();
    let wakes = 0;
    const instance = mind({
      id: `durability-watchdog-${watchdogMs}`,
      trajectoryId: TRAJECTORY,
      store: it.store,
      clock: it.clock,
      artifacts: axMindStaticArtifacts({
        revision: 'durability',
        persona: 'a mind with nothing to react to',
        thinkerPrompts: {},
        goals: [],
        skills: [],
      }),
      thinkers: [
        {
          name: 'liveness',
          kind: 'monolith',
          subscription: { triggerSelf: false, watchdogMs, maxInFlight: 4 },
          ai: {} as never,
          // A trigger that never became an event is C1: nothing arms a wake,
          // so the watchdog duty is the only thing that can revive the mind.
          program: livenessProgram((type) => {
            if (type !== 'ax.mind.bootstrap') wakes++;
          }),
          context: (request) => ({ context: request.projection.render }),
        },
      ],
      budget: { contextWindowTokens: 8_000 },
      allowVolatileTrajectory: true,
      tickMs: 1_000,
      sourcePollMs: 1_000,
    });
    await instance.start();
    const rounds = 240;
    for (let round = 0; round < rounds; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      it.clock.advanceBy(3_600_000 / rounds);
    }
    await instance.close({ drain: false, timeoutMs: 200 });
    return wakes;
  };
  return {
    withWatchdogWakes: await measure(WATCHDOG_MS),
    withoutWatchdogWakes: await measure(0),
  };
}

export async function runMindDurabilityEvaluation(): Promise<
  Readonly<AxMindDurabilityReport>
> {
  const rows = [
    await rowC4(),
    await rowC5(),
    await rowC6(),
    await transportRow(
      'C7',
      'dispatch',
      'after declareEffect, before markEffectDispatched',
      'nothing left the process, so a retry is safe'
    ),
    await transportRow(
      'C8',
      'send',
      'after markEffectDispatched, before the transport returned',
      'the effect stayed dispatched for a resolver; a thrown call is not proof of failure'
    ),
    await transportRow(
      'C9',
      'settle',
      'after the transport returned, before settleEffect',
      'the idempotency key is identical, so a second declare returned the original record'
    ),
    await rowC10(),
    await rowC11(),
    await rowC12(),
    await rowC13(),
    await rowC14(),
  ];
  return Object.freeze({
    command: 'npm run mind:durability:eval',
    honesty: AX_MIND_DURABILITY_HONESTY,
    baseline: AX_MIND_DURABILITY_BASELINES,
    budget: { providerCalls: 0, tokens: 0, usd: 0 },
    rows: Object.freeze(rows),
    concurrency: await concurrency(),
    naiveGuardBaseline: await naiveGuardBaseline(),
    watchdogBaseline: await watchdogBaseline(),
  });
}

function fail(message: string): never {
  throw new Error(`mind durability evaluation failed: ${message}`);
}

/** The shipped gate. */
export function assertMindDurabilityEvaluation(
  report: Readonly<AxMindDurabilityReport>
): void {
  if (report.budget.providerCalls !== 0 || report.budget.tokens !== 0) {
    fail('this evaluation must spend nothing');
  }
  const expected: readonly AxMindCrashRow[] = [
    'C4',
    'C5',
    'C6',
    'C7',
    'C8',
    'C9',
    'C10',
    'C11',
    'C12',
    'C13',
    'C14',
  ];
  const seen = report.rows.map((row) => row.row);
  for (const row of expected) {
    if (!seen.includes(row)) fail(`crash row ${row} is missing`);
  }
  for (const row of report.rows) {
    if (row.stepsLost !== 0) {
      fail(`row ${row.row} lost ${row.stepsLost} committed steps`);
    }
    if (row.duplicateSends !== 0) {
      fail(`row ${row.row} sent ${row.duplicateSends} duplicate messages`);
    }
    if (!row.mindAlive) fail(`row ${row.row} left the mind dead`);
    if (!row.note.trim()) fail(`row ${row.row} has no recorded verdict`);
  }
  // C7: the kill landed before anything left, so a retry is SAFE and the
  // message goes out exactly once.
  const c7 = report.rows.find((row) => row.row === 'C7');
  if (!c7 || c7.transportCalls !== 1 || c7.effectsSettled !== 1) {
    fail(
      `C7 made ${c7?.transportCalls} transport calls and settled ${c7?.effectsSettled} effects; nothing had left, so the retry must send exactly once`
    );
  }
  // C8's whole point: a thrown transport call leaves the effect DISPATCHED
  // for a resolver, and nothing is re-sent on the strength of a guess.
  const c8 = report.rows.find((row) => row.row === 'C8');
  if (!c8 || c8.effectsDispatched + c8.effectsParked === 0) {
    fail('C8 settled or discarded an indeterminate send instead of holding it');
  }
  if (!c8 || c8.transportCalls !== 1) {
    fail(
      `C8 called the transport ${c8?.transportCalls} times; an unconfirmed send must never be retried blind`
    );
  }
  // C9: the message left and the settle died. Same verdict, different layer.
  const c9 = report.rows.find((row) => row.row === 'C9');
  if (!c9 || c9.transportCalls !== 1) {
    fail(
      `C9 called the transport ${c9?.transportCalls} times; the send had already left`
    );
  }
  if (!c9 || c9.effectsDispatched === 0) {
    fail('C9 did not leave the effect dispatched for a resolver');
  }
  const c10 = report.rows.find((row) => row.row === 'C10');
  if (!c10 || c10.effectsSettled === 0) {
    fail('C10 did not converge the log to a settled effect');
  }
  // The headline, two-sided: exactly the expected message count, with the
  // declines reported beside it. Zero duplicates is also satisfiable by
  // never replying, so the send count carries a floor as well as a ceiling.
  const run = report.concurrency;
  if (run.transportSends !== run.inboundMessages) {
    fail(
      `the transport received ${run.transportSends} sends for ${run.inboundMessages} inbound messages; exactly one send per message is the contract`
    );
  }
  // The NEGATIVE, asserted rather than buried: a send whose call threw is
  // missing from the log until a resolver settles it. Sends are not
  // exactly-once, and this row is where that shows.
  if (run.messagesSent + run.unconfirmedSends !== run.inboundMessages) {
    fail(
      `${run.messagesSent} confirmed plus ${run.unconfirmedSends} unconfirmed does not account for ${run.inboundMessages} messages`
    );
  }
  if (run.unconfirmedSends !== run.transportFailures) {
    fail(
      `${run.transportFailures} transport calls threw but ${run.unconfirmedSends} effects were left for a resolver; an indeterminate send must never be re-dispatched blind`
    );
  }
  // And the close: a resolver settling those effects converges the log.
  if (run.messagesAfterResolver !== run.inboundMessages) {
    fail(
      `after the resolver settled every unconfirmed send the log holds ${run.messagesAfterResolver} outbound messages, not ${run.inboundMessages}`
    );
  }
  if (run.duplicateSends !== 0) {
    fail(`the concurrent run produced ${run.duplicateSends} duplicate sends`);
  }
  if (run.declinesRecorded <= 0) {
    fail(
      'no declines were recorded: with three responders racing, the losers must record a decline rather than vanish'
    );
  }
  if (run.transportFailures <= 0) {
    fail('the transport never failed, so the fault injection proved nothing');
  }
  if (run.responders < 3) fail('the headline scenario needs three responders');
  // The baselines must actually be worse, or the comparison means nothing.
  if (report.naiveGuardBaseline.duplicateSends <= 0) {
    fail(
      'the naive last-message guard produced no duplicates, so it is not the baseline it claims to be'
    );
  }
  if (report.watchdogBaseline.withoutWatchdogWakes !== 0) {
    fail('the no-watchdog baseline recovered on its own, which it cannot');
  }
  if (report.watchdogBaseline.withWatchdogWakes <= 0) {
    fail('the watchdog baseline never wakes');
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const report = await runMindDurabilityEvaluation();
  assertMindDurabilityEvaluation(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
