import type { AxEventClock, AxEventEffect } from '../event/types.js';
import { axEventCanonicalDigest, axEventId } from '../event/util.js';
import type {
  AxTrajectoryFieldValue,
  AxTrajectoryStep,
  AxTrajectoryStore,
} from '../trajectory/types.js';
import { axTrajectoryTruncateUtf8 } from '../trajectory/util.js';
import {
  type AxMindChat,
  AxMindChatError,
  type AxMindChatMessage,
  type AxMindChatTransport,
  AxMindConfigurationError,
  type AxMindDiagnostic,
  type AxMindEffectLedger,
  type AxMindReplyDecision,
  type AxMindReplyResolution,
} from './types.js';

/** The ledger operation every outbound message is declared under. */
export const axMindChatOperation = 'mind.chat.send';
const DEFAULT_CLAIM_TTL_MS = 180_000;
const DEFAULT_TAIL = 64;
const METADATA_CONTENT_BYTES = 8_000;
const REPLY_TYPES = ['message', 'observation', 'reply-claim'] as const;

function text(value: AxTrajectoryFieldValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Disjunctive, NOT conjunctive: `replyTo ?? claimId`. A per-attempt claimId
 * inside a key that also carries replyTo makes the key per-attempt and
 * destroys the cross-attempt dedupe the whole design depends on. `fallback`
 * covers the unsolicited case, where neither exists.
 */
export const axMindChatIdempotencyKey = async (
  input: Readonly<{
    identityScope: string;
    to: string;
    replyTo?: string;
    claimId?: string;
    fallback?: string;
  }>
): Promise<string> => {
  const discriminator = input.replyTo ?? input.claimId ?? input.fallback ?? '';
  const digest = await axEventCanonicalDigest(
    `${input.identityScope} ${input.to} ${discriminator}`
  );
  return `ax.mind.chat:${digest}`;
};

export interface AxMindReplyStateOptions {
  readonly triggerStepId: string;
  readonly triggerSeq: number;
  readonly triggerFrom: string;
  readonly selfName: string;
  /**
   * REQUIRED, and the unforgeable half of "did we already answer this".
   * `data.from` on an inbound step is written from the remote party's
   * identity, so a correspondent who can make it equal `selfName` could
   * otherwise mark their own message answered and silence the mind forever.
   * A step is ours only when the HOST-STAMPED writer identity says so; the
   * mind runtime passes every thinker name, never just the asking one.
   */
  readonly selfSources: readonly string[];
  readonly now: number;
  readonly claimTtlMs?: number;
  /** Settled send keys, so the log converges to the ledger (crash C10). */
  readonly settledSendKeys?: readonly string[];
  readonly triggerKey?: string;
  /**
   * The asking thinker. Its OWN live claim is not evidence that someone else
   * is composing, so it never blocks the claimant's own reply.
   */
  readonly owner?: string;
  /** Echoed: the caller knows whether it had to widen its read. */
  readonly widened?: boolean;
}

/**
 * FACT ("has this been answered") is machinery; JUDGMENT ("does it need a
 * reply") is the model. This computes the fact only, from steps plus the
 * effect ledger, and the rows are a PRIORITY order, not a scan order.
 */
export function axResolveMindReplyState(
  steps: readonly Readonly<AxTrajectoryStep>[],
  options: Readonly<AxMindReplyStateOptions>
): Readonly<AxMindReplyResolution> {
  const ttl = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const after = steps.filter((step) => step.seq > options.triggerSeq);
  const ours = (step: Readonly<AxTrajectoryStep>) =>
    step.source !== undefined &&
    options.selfSources.includes(step.source) &&
    text(step.data.from) === options.selfName;
  const decision = (value: AxMindReplyDecision) =>
    after.find(
      (step) =>
        step.type === 'observation' &&
        step.triggerStep === options.triggerStepId &&
        step.data.decision === value
    );
  const widened = options.widened ?? false;
  const resolved = (
    state: AxMindReplyResolution['state'],
    evidence?: Readonly<AxTrajectoryStep>,
    failedOpen = false
  ): Readonly<AxMindReplyResolution> =>
    Object.freeze({
      state,
      ...(evidence ? { evidenceStepId: evidence.stepId } : {}),
      failedOpen,
      widened,
    });

  const stamped = after.find(
    (step) =>
      step.type === 'message' &&
      ours(step) &&
      text(step.data.replyTo) === options.triggerStepId
  );
  if (stamped) return resolved('answered', stamped);
  if (
    options.triggerKey &&
    options.settledSendKeys?.includes(options.triggerKey)
  ) {
    // The ledger settled a send under this trigger's key. The message step may
    // not exist yet (crash C10) and answered-ness must not wait for it.
    return resolved('answered');
  }
  const replied = decision('replied');
  if (replied) return resolved('answered', replied);
  const declined = decision('no-reply');
  // A recorded decline STICKS across redelivery: the mind does not re-compose
  // an answer it already decided not to send.
  if (declined) return resolved('declined', declined);
  const positional = after.find(
    (step) =>
      step.type === 'message' &&
      ours(step) &&
      text(step.data.to) === options.triggerFrom
  );
  if (positional) return resolved('answered', positional);

  let failedOpen = false;
  const live: Readonly<AxTrajectoryStep>[] = [];
  for (const step of after) {
    if (step.type !== 'reply-claim') continue;
    if (step.triggerStep !== options.triggerStepId) continue;
    const expiresAt = step.data.expiresAt;
    const at =
      typeof expiresAt === 'number' && Number.isFinite(expiresAt)
        ? expiresAt
        : Number.isFinite(step.ts)
          ? step.ts + ttl
          : Number.NaN;
    // A claim whose time is unreadable, or older than its TTL, is STALE. A
    // retry is safer than a dropped message; treating it as handled is how
    // messages went missing forever.
    if (Number.isFinite(at) && at > options.now) {
      live.push(step);
      continue;
    }
    failedOpen = true;
  }
  // The log arbitrates: the OLDEST live claim owns the reply. A loser's claim
  // is inert -- it is immutable and cannot be retracted, so a rule that let
  // any live claim block would deadlock the winner behind the loser.
  const winner = live[0];
  const ownWinner =
    options.owner !== undefined && winner?.launchedBy === options.owner;
  if (winner && !ownWinner) return resolved('claimed', winner);
  return resolved('unanswered', winner, failedOpen);
}

/**
 * Inference never fabricates an antecedent: the newest inbound message from
 * this recipient that no outgoing message already answers. A reply that
 * answers nothing stays unstamped.
 */
export function axMindInferReplyTo(
  steps: readonly Readonly<AxTrajectoryStep>[],
  options: Readonly<{
    to: string;
    selfName: string;
    /** As in `AxMindReplyStateOptions`: outbound-ness is host-stamped. */
    selfSources: readonly string[];
  }>
): string | undefined {
  const ours = (step: Readonly<AxTrajectoryStep>) =>
    step.source !== undefined &&
    options.selfSources.includes(step.source) &&
    text(step.data.from) === options.selfName;
  const answered = new Set(
    steps
      .filter((step) => step.type === 'message' && ours(step))
      .map((step) => text(step.data.replyTo))
      .filter((value): value is string => Boolean(value))
  );
  const inbound = steps.filter(
    (step) =>
      step.type === 'message' &&
      // A step this mind wrote is never its own antecedent, whatever `from`
      // claims: inference must not be steerable by message content either.
      !ours(step) &&
      text(step.data.from) === options.to &&
      text(step.data.to) === options.selfName &&
      !answered.has(step.stepId)
  );
  return inbound.at(-1)?.stepId;
}

export interface AxMindChatOptions {
  readonly trajectoryId: string;
  readonly store: AxTrajectoryStore;
  readonly clock: AxEventClock;
  /** Writer identity for outbound steps: the thinker that composed them. */
  readonly sender: string;
  /**
   * EVERY writer identity this mind stamps on its own steps, so the positional
   * net still sees a sibling thinker's reply. Defaults to `[sender]`; the
   * runtime that owns the thinker table passes them all.
   */
  readonly selfSources?: readonly string[];
  readonly transport?: AxMindChatTransport;
  /** The delivery's effect ledger, reached through `extra.eventContext`. */
  readonly effects?: () => AxMindEffectLedger | undefined;
  /** Defaults to the trajectory id. Part of every idempotency key. */
  readonly identityScope?: string;
  /** Default 180_000. Fails OPEN when unreadable. */
  readonly claimTtlMs?: number;
  /** Steps read backwards when resolving reply state. Default 64. */
  readonly tailLimit?: number;
  readonly onDiagnostic?: (diagnostic: Readonly<AxMindDiagnostic>) => void;
}

function settledSendKeys(
  effects: readonly Readonly<AxEventEffect>[]
): readonly string[] {
  return effects
    .filter(
      (effect) =>
        effect.operation === axMindChatOperation &&
        effect.status === 'succeeded'
    )
    .map((effect) => effect.idempotencyKey);
}

/**
 * Exactly one reply per inbound message, or a recorded decline (M12), through
 * five layers: `replyTo` stamped at the transport, the positional net, the
 * TTL'd claim, the recorded decision, and the ledger idempotency key at the
 * send site. The claim fails OPEN; every other layer fails closed.
 */
export const axMindChat = (
  options: Readonly<AxMindChatOptions>
): AxMindChat => {
  const {
    store,
    trajectoryId,
    clock,
    sender,
    transport,
    tailLimit = DEFAULT_TAIL,
    claimTtlMs = DEFAULT_CLAIM_TTL_MS,
  } = options;
  const identityScope = options.identityScope ?? trajectoryId;
  const selfName = transport?.selfName ?? sender;
  const selfSources = options.selfSources ?? [sender];

  const diagnose = (
    code: AxMindDiagnostic['code'],
    message: string,
    stepId?: string
  ): void =>
    options.onDiagnostic?.({
      code,
      thinker: sender,
      at: clock.now(),
      message,
      ...(stepId ? { stepId } : {}),
    });

  const ledger = (): AxMindEffectLedger => {
    const found = options.effects?.();
    if (!found) {
      // M15: an outbound send is a declared effect BEFORE any I/O. Without a
      // ledger there is no crash classification, so the send is refused
      // rather than performed blind.
      throw new AxMindConfigurationError(
        'AxMindChat requires an effect ledger to send; reach it through extra.eventContext',
        'effect_store_required'
      );
    }
    return found;
  };

  const window = async (
    triggerSeq: number,
    signal?: AbortSignal
  ): Promise<{
    steps: readonly Readonly<AxTrajectoryStep>[];
    widened: boolean;
  }> => {
    const tail = await store.tailBackward(
      { trajectoryId, limit: tailLimit, types: [...REPLY_TYPES] },
      signal
    );
    const oldest = tail.steps[0]?.seq;
    if (tail.exhausted || oldest === undefined || oldest <= triggerSeq) {
      return { steps: tail.steps, widened: false };
    }
    // A window that misses the trigger could report an answered message as
    // unanswered and reply twice. That is the one case worth a wider read.
    const stats = await store.stats(trajectoryId, signal);
    const steps = await store.read(
      {
        trajectoryId,
        fromSeq: triggerSeq,
        toSeq: stats?.newestSeq ?? triggerSeq,
        limit: tailLimit * 16,
        types: [...REPLY_TYPES],
      },
      signal
    );
    return { steps, widened: true };
  };

  const trigger = async (
    triggerStepId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>> => {
    const step = await store.getStep(trajectoryId, triggerStepId, signal);
    if (!step) {
      // Reporting 'unanswered' for a step this log cannot see would authorize
      // a reply to a message that does not exist here.
      throw new AxMindChatError(
        `AxMindChat cannot resolve reply state: ${triggerStepId} is not a step in ${trajectoryId}`,
        'unknown_trigger',
        triggerStepId
      );
    }
    return step;
  };

  const replyState = async (
    triggerStepId: string,
    signal?: AbortSignal
  ): Promise<Readonly<AxMindReplyResolution>> => {
    const step = await trigger(triggerStepId, signal);
    const scan = await window(step.seq, signal);
    const from = text(step.data.from) ?? step.source ?? '';
    const keys = settledSendKeys(
      await (options.effects?.()?.listEffects() ?? [])
    );
    const triggerKey = keys.length
      ? await axMindChatIdempotencyKey({
          identityScope,
          to: from,
          replyTo: triggerStepId,
        })
      : undefined;
    const resolution = axResolveMindReplyState(scan.steps, {
      triggerStepId,
      triggerSeq: step.seq,
      triggerFrom: from,
      selfName,
      selfSources,
      now: clock.now(),
      claimTtlMs,
      settledSendKeys: keys,
      ...(triggerKey ? { triggerKey } : {}),
      owner: sender,
      widened: scan.widened,
    });
    if (resolution.failedOpen) {
      diagnose(
        'reply-claim-stale',
        `a reply claim for ${triggerStepId} was unreadable or expired and was ignored`,
        triggerStepId
      );
    }
    return resolution;
  };

  const appendMessage = async (
    message: Readonly<AxMindChatMessage>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>> => {
    const receipt = await store.append(
      {
        trajectoryId,
        type: 'message',
        source: sender,
        ...(message.replyTo ? { triggerStep: message.replyTo } : {}),
        data: {
          from: selfName,
          to: message.to,
          content: message.content,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        },
      },
      signal
    );
    const step = await store.getStep(trajectoryId, receipt.stepId, signal);
    return step!;
  };

  const send = async (
    message: Readonly<AxMindChatMessage>,
    signal?: AbortSignal
  ): Promise<Readonly<AxTrajectoryStep>> => {
    if (!transport) {
      throw new AxMindChatError(
        'AxMindChat has no transport; the host owns outbound delivery',
        'no_transport'
      );
    }
    if (!message.content.trim()) {
      throw new AxMindChatError(
        'AxMindChat refuses an empty message',
        'empty_content'
      );
    }
    if (message.to === selfName) {
      // Refused at the transport AND explained IN BAND: the mind is told which
      // tool it should have reached for, in its own log.
      await store.append(
        {
          trajectoryId,
          type: 'observation',
          source: sender,
          data: {
            content: `refused a message addressed to ${selfName}, which is this mind's own identity. To think, append a thought; to record something for later, use memory. A message is for someone else.`,
            refused: 'self_addressed',
          },
        },
        signal
      );
      throw new AxMindChatError(
        `AxMindChat refuses a message addressed to ${selfName}`,
        'self_addressed'
      );
    }
    const effects = ledger();
    const content = axTrajectoryTruncateUtf8(
      message.content,
      METADATA_CONTENT_BYTES
    );
    const idempotencyKey = await axMindChatIdempotencyKey({
      identityScope,
      to: message.to,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      fallback: await axEventCanonicalDigest(message.content),
    });
    const declared = await effects.declareEffect({
      operation: axMindChatOperation,
      idempotencyKey,
      // The host transport declares its own idempotency; without that claim an
      // unknown-safety effect fails closed on recovery rather than replaying.
      replaySafety: 'unknown',
      metadata: {
        to: message.to,
        trajectoryId,
        content,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      },
    });
    if (declared.status === 'succeeded') {
      // Key reuse returned the original record: this exact message already
      // left the process. Converge the log instead of sending twice.
      const [reconciled] = await axMindReconcileChatSends({
        ...options,
        effects: () => effects,
      });
      if (reconciled) return reconciled;
      return appendMessage(message, signal);
    }
    if (declared.status !== 'intent') {
      diagnose(
        'reply-duplicate-suppressed',
        `an earlier attempt left ${idempotencyKey} ${declared.status}; a resolver must classify it before another send`
      );
      throw new AxMindChatError(
        `AxMindChat will not re-dispatch ${idempotencyKey}: a previous attempt is ${declared.status}`,
        'send_indeterminate'
      );
    }
    const dispatched = await effects.markEffectDispatched(
      declared.id,
      declared.version
    );
    let receipt: Awaited<ReturnType<AxMindChatTransport['send']>>;
    try {
      receipt = await transport.send(message, {
        idempotencyKey,
        effectId: dispatched.id,
        signal: signal ?? new AbortController().signal,
      });
    } catch (error) {
      // A thrown transport call is NOT proof of failure. The effect stays
      // `dispatched` for a resolver to classify or park; nothing is settled
      // and nothing is re-sent on the strength of a guess.
      throw new AxMindChatError(
        `AxMindChat could not confirm the send of ${idempotencyKey}`,
        'send_indeterminate',
        undefined,
        { cause: error }
      );
    }
    await effects.settleEffect(dispatched.id, dispatched.version, {
      status: 'succeeded',
      receipt: {
        at: receipt.at,
        ...(receipt.externalId ? { externalId: receipt.externalId } : {}),
      },
    });
    return appendMessage(message, signal);
  };

  return {
    send,
    replyState,

    async reply(message, signal) {
      const scan = await store.tailBackward(
        { trajectoryId, limit: tailLimit, types: ['message'] },
        signal
      );
      const replyTo =
        message.replyTo ??
        axMindInferReplyTo(scan.steps, {
          to: message.to,
          selfName,
          selfSources,
        });
      if (!replyTo) {
        // Answering nothing: send it unstamped rather than invent an
        // antecedent for it.
        return Object.freeze({ sent: true, step: await send(message, signal) });
      }
      const state = await replyState(replyTo, signal);
      if (state.state !== 'unanswered') {
        diagnose(
          'reply-duplicate-suppressed',
          `refused a second reply to ${replyTo}: already ${state.state}`,
          state.evidenceStepId
        );
        return Object.freeze({
          sent: false,
          reason:
            state.state === 'claimed'
              ? ('claimed' as const)
              : state.state === 'declined'
                ? ('declined' as const)
                : ('already_answered' as const),
        });
      }
      return Object.freeze({
        sent: true,
        step: await send({ ...message, replyTo }, signal),
      });
    },

    async claim(triggerStepId, signal) {
      const state = await replyState(triggerStepId, signal);
      if (state.state !== 'unanswered') {
        throw new AxMindChatError(
          `AxMindChat will not claim ${triggerStepId}: already ${state.state}`,
          state.state === 'claimed' ? 'claimed' : 'already_answered',
          state.evidenceStepId
        );
      }
      const claimId = axEventId('reply-claim');
      const expiresAt = clock.now() + claimTtlMs;
      const receipt = await store.append(
        {
          trajectoryId,
          type: 'reply-claim',
          triggerStep: triggerStepId,
          launchedBy: sender,
          data: { claimId, expiresAt },
        },
        signal
      );
      // The log arbitrates the race: whoever appended the OLDEST live claim
      // owns the reply, so two composers cannot both believe they won.
      const claims = await store.tailBackward(
        { trajectoryId, limit: tailLimit, types: ['reply-claim'] },
        signal
      );
      const live = claims.steps.filter(
        (step) =>
          step.triggerStep === triggerStepId &&
          typeof step.data.expiresAt === 'number' &&
          step.data.expiresAt > clock.now()
      );
      const winner = live[0];
      if (winner && winner.stepId !== receipt.stepId) {
        throw new AxMindChatError(
          `AxMindChat lost the claim race for ${triggerStepId}`,
          'claimed',
          winner.stepId
        );
      }
      return Object.freeze({ claimId, expiresAt });
    },

    async recordDecision(decision, triggerStepId, note, signal) {
      const receipt = await store.append(
        {
          trajectoryId,
          type: 'observation',
          source: sender,
          triggerStep: triggerStepId,
          data: {
            decision,
            content: note ?? `recorded reply decision ${decision}`,
            ...(note ? { note } : {}),
          },
        },
        signal
      );
      const step = await store.getStep(trajectoryId, receipt.stepId, signal);
      return step!;
    },
  };
};

/**
 * Crash C10: a send that settled but whose message step never landed. The log
 * converges to the LEDGER, never the other way round -- the ledger is the only
 * record that proves the message actually left.
 */
export async function axMindReconcileChatSends(
  options: Readonly<AxMindChatOptions>,
  signal?: AbortSignal
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const effects = options.effects?.();
  if (!effects) return [];
  const selfName = options.transport?.selfName ?? options.sender;
  const selfSources = options.selfSources ?? [options.sender];
  const tail = await options.store.tailBackward(
    {
      trajectoryId: options.trajectoryId,
      limit: (options.tailLimit ?? DEFAULT_TAIL) * 4,
      types: ['message'],
    },
    signal
  );
  const appended: Readonly<AxTrajectoryStep>[] = [];
  for (const effect of await effects.listEffects()) {
    if (effect.operation !== axMindChatOperation) continue;
    if (effect.status !== 'succeeded') continue;
    const to = text(effect.metadata?.to as AxTrajectoryFieldValue | undefined);
    const replyTo = text(
      effect.metadata?.replyTo as AxTrajectoryFieldValue | undefined
    );
    const content =
      text(effect.metadata?.content as AxTrajectoryFieldValue | undefined) ??
      '';
    if (!to) continue;
    const present = tail.steps.some(
      (step) =>
        step.source !== undefined &&
        selfSources.includes(step.source) &&
        text(step.data.from) === selfName &&
        text(step.data.to) === to &&
        (replyTo
          ? text(step.data.replyTo) === replyTo
          : text(step.data.content) === content)
    );
    if (present) continue;
    const receipt = await options.store.append(
      {
        trajectoryId: options.trajectoryId,
        type: 'message',
        source: options.sender,
        ...(replyTo ? { triggerStep: replyTo } : {}),
        data: {
          from: selfName,
          to,
          content,
          reconciled: effect.id,
          ...(replyTo ? { replyTo } : {}),
        },
      },
      signal
    );
    options.onDiagnostic?.({
      code: 'effect-step-reconciled',
      thinker: options.sender,
      at: options.clock.now(),
      stepId: receipt.stepId,
      message: `appended the message step for settled effect ${effect.id}`,
    });
    const step = await options.store.getStep(
      options.trajectoryId,
      receipt.stepId,
      signal
    );
    if (step) appended.push(step);
  }
  return Object.freeze(appended);
}
