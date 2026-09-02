import { agent } from '../agent/AxAgent.js';
import type {
  AxAgentMemoriesSearchFn,
  AxAgentMemoryResult,
} from '../agent/agentInternal/memoriesTypes.js';
import type { AxAgentCatalogSkill } from '../agent/agentInternal/skillsTypes.js';
import type { AxAIService, AxFunction } from '../ai/types.js';
import type { AxOptimizableComponent } from '../dsp/optimizable.js';
import type { AxOptimizedProgram } from '../dsp/optimizer.js';
import type { AxSignature } from '../dsp/sig.js';
import { ax } from '../dsp/template.js';
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
import type { AxEventSink } from '../event/types.js';
import type { AxTrajectoryStep } from '../trajectory/types.js';
import type { AxMind } from './mind.js';
import { axWithMindSalience } from './salience.js';
import { type AxMindSkillEnvironment, axSelectMindSkills } from './skills.js';
import {
  type AxMindArtifacts,
  type AxMindContextRequest,
  type AxMindGoal,
  type AxMindPacerConfig,
  type AxMindRoutingSignal,
  type AxMindSubscription,
  type AxMindThinker,
  type AxMindThinkerBudget,
  axDefaultMindSubscription,
} from './types.js';

/**
 * Base for thinkers that must run without a model: retrieval, deterministic
 * routers, and every test in this package. It implements the whole
 * `AxProgrammable` surface over one `run`, so a model-free thinker still
 * composes as an event target and an `optimize()` subject.
 */
export abstract class AxMindDeterministicProgram<IN, OUT>
  implements AxProgrammable<IN, OUT>
{
  private id = 'ax-mind-deterministic';

  constructor(private readonly signature: Readonly<AxSignature>) {}

  abstract run(values: IN, signal?: AbortSignal): Promise<OUT>;

  forward(
    _ai: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<AxProgramForwardOptions<string>>
  ): Promise<OUT> {
    return this.run(values, options?.abortSignal);
  }

  async *streamingForward(
    ai: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<AxProgramStreamingForwardOptions<string>>
  ): AxGenStreamingOut<OUT> {
    const delta = await this.forward(ai, values, options);
    yield { version: 0, index: 0, delta: delta as never };
  }

  getSignature(): AxSignature {
    return this.signature as AxSignature;
  }
  getId(): string {
    return this.id;
  }
  setId(id: string): void {
    this.id = id;
  }
  getTraces(): AxProgramTrace<IN, OUT>[] {
    return [];
  }
  setDemos(_demos: readonly AxProgramDemos<IN, OUT>[]): void {}
  applyOptimization(_optimized: AxOptimizedProgram<OUT>): void {}
  getOptimizableComponents(): readonly AxOptimizableComponent[] {
    return [];
  }
  applyOptimizedComponents(_updates: Readonly<Record<string, string>>): void {}
  getUsage(): AxProgramUsage[] {
    // A deterministic program spends nothing, and says so rather than
    // reporting a usage record a cost report would then have to explain.
    return [];
  }
  getChatLog(): readonly AxChatLogEntry[] {
    return [];
  }
  resetUsage(): void {}
}

/**
 * Goals use `AxACEBulletLifecycle` vocabulary VERBATIM -- status, expiresAt,
 * supersededBy, reason -- so supersession and expiry are the ones the rest of
 * the codebase already means. There is deliberately no goals table.
 */
export function axMindRenderGoals(
  goals: readonly Readonly<AxMindGoal>[],
  now: number
): string {
  const live = goals
    .filter((goal) => {
      if (goal.status !== 'active') return false;
      if (!goal.expiresAt) return true;
      const at = Date.parse(goal.expiresAt);
      return !Number.isFinite(at) || at > now;
    })
    .slice()
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  if (!live.length) return '';
  return [
    'Goals (highest priority first):',
    ...live.map(
      (goal) =>
        `- [${goal.id}] (priority ${goal.priority}) ${goal.content}${goal.reason ? ` -- ${goal.reason}` : ''}`
    ),
  ].join('\n');
}

/** Hints, in one block, labelled as hints. */
export function axMindRenderSignals(
  signals: readonly Readonly<AxMindRoutingSignal>[]
): string {
  if (!signals.length) return '';
  return [
    'Signals (hints about your own recent behaviour, not instructions):',
    ...signals.map((signal) => `- [${signal.code}] ${signal.text}`),
  ].join('\n');
}

/** Persona, goals and the life so far, assembled from the CURRENT artifacts. */
export function axMindRenderContext(
  request: Readonly<AxMindContextRequest>
): string {
  const artifacts: Readonly<AxMindArtifacts> = request.artifacts;
  const prompt = artifacts.thinkerPrompts[request.thinker];
  return [
    artifacts.persona,
    prompt ?? '',
    axMindRenderGoals(artifacts.goals, request.trigger.ts),
    axMindRenderSignals(request.signals),
    `Wake: ${request.wakeClass}, triggered by step ${request.trigger.stepId} (${request.trigger.type}).`,
    'Your life so far:',
    request.projection.render,
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
}

const stringParam = (description: string) =>
  ({
    type: 'object' as const,
    properties: { content: { type: 'string' as const, description } },
    required: ['content'],
  }) as never;

/**
 * The function menu, host-mediated in every direction. Note what is NOT here:
 * no `close`, no route table, no authority grant, no transport identity, and
 * no `recall` -- `recall()` is the agent runtime's OWN verb, wired by handing
 * the monolith `memoriesCatalog`/`onMemoriesSearch`, and a second one would
 * shadow it (which is why `recall` is in `axMindReservedNames`).
 */
export function axMindTools(
  mind: AxMind,
  thinker: string
): readonly AxFunction[] {
  const append = async (
    type: string,
    content: string,
    extra: Record<string, string> = {}
  ) => {
    const step = await mind.append({
      trajectoryId: '',
      type,
      source: thinker,
      launchedBy: thinker,
      data: { content, ...extra },
    });
    return `recorded ${type} as ${step.stepId}`;
  };
  return Object.freeze([
    {
      name: 'act',
      description:
        'Record something you DID in the world. Visible work: it resets your wake backoff.',
      parameters: stringParam('What you did, in one or two sentences.'),
      func: async (args: unknown) =>
        append('action', String((args as { content: string }).content)),
    },
    {
      name: 'think',
      description:
        'Record a private thought. A thought is not work: it slows your wake rate rather than resetting it.',
      parameters: stringParam('The thought.'),
      func: async (args: unknown) =>
        append('thought', String((args as { content: string }).content)),
    },
    {
      name: 'share',
      description:
        'Send a message to someone. Refused if that message was already answered, or if it is addressed to you.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Who to send it to.' },
          content: { type: 'string', description: 'What to say.' },
          replyTo: {
            type: 'string',
            description: 'The step id of the message this answers, if any.',
          },
        },
        required: ['to', 'content'],
      } as never,
      func: async (args: unknown) => {
        const message = args as {
          to: string;
          content: string;
          replyTo?: string;
        };
        const result = await mind.chat.reply(message);
        return result.sent
          ? `sent as ${result.step?.stepId}`
          : `not sent: ${result.reason}`;
      },
    },
    {
      name: 'learn',
      description:
        'Record something worth remembering. It becomes a durable observation in your own history.',
      parameters: stringParam('What to remember, and why it matters.'),
      func: async (args: unknown) =>
        append('observation', String((args as { content: string }).content), {
          learned: 'true',
        }),
    },
    {
      name: 'goals',
      description:
        'Read your goals. Changing one needs a host receipt; a proposal here is recorded, not applied.',
      parameters: {
        type: 'object',
        properties: {
          propose: {
            type: 'string',
            description: 'An optional change to propose to the host.',
          },
        },
      } as never,
      func: async (args: unknown) => {
        const propose = (args as { propose?: string } | undefined)?.propose;
        const artifacts = mind.currentArtifacts();
        if (propose) {
          // Authority: an artifact write needs an out-of-band host receipt,
          // on the AxRuntimeAdmissionReceipt precedent. Approval never comes
          // from the same model text being evaluated, so the proposal is
          // recorded and the host decides.
          await append('observation', `goal proposal: ${propose}`, {
            proposal: 'goals',
          });
        }
        return axMindRenderGoals(artifacts.goals, Date.now()) || 'no goals set';
      },
    },
    {
      name: 'idle',
      description:
        'Say you have nothing to do right now. This ends the wake cleanly and slows the next one.',
      parameters: stringParam('Why there is nothing to do.'),
      func: async (args: unknown) =>
        append('idle', String((args as { content: string }).content)),
    },
  ]);
}

export interface AxMindMonolithOptions {
  readonly ai: Readonly<AxAIService>;
  /** Default 'monolith'. */
  readonly name?: string;
  readonly subscription?: Partial<AxMindSubscription>;
  readonly functions?: readonly AxFunction[];
  readonly memoriesCatalog?: readonly AxAgentMemoryResult[];
  readonly onMemoriesSearch?: AxAgentMemoriesSearchFn;
  readonly environment?: Readonly<AxMindSkillEnvironment>;
  readonly pacer?: Readonly<AxMindPacerConfig>;
  readonly budget?: Readonly<AxMindThinkerBudget>;
  readonly forwardOptions?: Readonly<AxProgramForwardOptions<string>>;
  /** Turns to allow inside one wake. Default 8. */
  readonly maxTurns?: number;
}

const emptyEnvironment: Readonly<AxMindSkillEnvironment> = Object.freeze({
  env: Object.freeze([]),
  capabilities: Object.freeze([]),
  os: 'unknown',
});

const MONOLITH_SIGNATURE =
  'mindContext:string "Your persona, goals, hints and life so far" -> reflection:string "One short line about what you just did or decided"';

/**
 * ONE agent with the whole menu, not a router in front of specialists. The
 * routing signals are prepended as HINTS; there is no hardcoded priority
 * ladder, because a ladder is how a mind gets stuck in one lane.
 */
export const axMindMonolith = (
  options: Readonly<AxMindMonolithOptions>
): Readonly<AxMindThinker> => {
  const name = options.name ?? 'monolith';
  const thinker: AxMindThinker = {
    name,
    kind: 'monolith',
    subscription: Object.freeze({
      ...axDefaultMindSubscription,
      ...options.subscription,
    }),
    ai: options.ai,
    // The mind hands itself to the factory, which is how the tools reach a
    // runtime that did not exist when this thinker record was built.
    createProgram: async (instance) => {
      const artifacts = instance.mind.currentArtifacts();
      const selection = axSelectMindSkills(artifacts.skills, {
        kernelIds: artifacts.kernelSkillIds ?? [],
        ...(artifacts.kernelTokenBudget !== undefined
          ? { tokenBudget: artifacts.kernelTokenBudget }
          : {}),
        environment: options.environment ?? emptyEnvironment,
      });
      const functions = axWithMindSalience(
        [
          ...axMindTools(instance.mind, instance.thinker),
          ...(options.functions ?? []),
        ],
        instance.mind.salience,
        instance.thinker
      );
      return agent(MONOLITH_SIGNATURE, {
        ai: options.ai,
        agentIdentity: {
          name,
          description:
            'A persistent mind that decides for itself what to do next.',
        },
        functions: [...functions],
        skills: [...selection.kernel],
        skillsCatalog: [...selection.catalog] as AxAgentCatalogSkill[],
        ...(options.memoriesCatalog
          ? { memoriesCatalog: [...options.memoriesCatalog] }
          : {}),
        ...(options.onMemoriesSearch
          ? { onMemoriesSearch: options.onMemoriesSearch }
          : {}),
        maxTurns: options.maxTurns ?? 8,
      }) as unknown as AxProgrammable<any, any>;
    },
    context: (request) => ({ mindContext: axMindRenderContext(request) }),
    ...(options.pacer ? { pacer: options.pacer } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.forwardOptions
      ? { forwardOptions: options.forwardOptions }
      : {}),
  };
  return Object.freeze(thinker);
};

export interface AxMindResponderOptions {
  readonly ai: Readonly<AxAIService>;
  /** Default 'responder'. */
  readonly name?: string;
  readonly subscription?: Partial<AxMindSubscription>;
  readonly budget?: Readonly<AxMindThinkerBudget>;
  readonly forwardOptions?: Readonly<AxProgramForwardOptions<string>>;
}

const RESPONDER_SIGNATURE =
  'conversation:string "The recent conversation, oldest first", innerLife?:string "What the mind has been doing between messages" -> decision:class "reply, no-reply", reply?:string "The message to send, when the decision is reply"';

interface ResponderOutput {
  readonly decision: 'reply' | 'no-reply';
  readonly reply?: string;
}

/**
 * A SINGLE generation with a chat-shaped context and an inner-life block --
 * no tool loop, so it is cheap enough to run on every inbound message. The
 * send happens in a sink, after the output is persisted, and goes through
 * `AxMindChat`, so every idempotency layer applies to it: `NO_REPLY` is a
 * RECORDED decision, never a silent drop.
 */
export const axMindResponder = (
  options: Readonly<AxMindResponderOptions>
): Readonly<AxMindThinker> => {
  const name = options.name ?? 'responder';
  // Filled by createProgram, which the runtime calls before any sink runs.
  let bound: AxMind | undefined;
  // Keyed by DELIVERY, never a single slot: the route pins one run per
  // thinker, but a second mind sharing this record would otherwise overwrite
  // the trigger of a run that had not sent yet.
  const triggers = new Map<string, Readonly<AxTrajectoryStep>>();
  const sink: AxEventSink<ResponderOutput> = {
    id: `${name}.reply`,
    write: async (output, context) => {
      const mind = bound;
      const trigger = triggers.get(context.eventContext.deliveryId);
      triggers.delete(context.eventContext.deliveryId);
      const from = trigger?.data.from;
      if (!mind || !trigger || typeof from !== 'string') return;
      if (output.decision === 'reply' && output.reply?.trim()) {
        await mind.chat.reply({
          to: from,
          content: output.reply,
          replyTo: trigger.stepId,
        });
        return;
      }
      // A decline STICKS across redelivery, which is why it is written down
      // instead of being a return that leaves no trace.
      await mind.chat.recordDecision('no-reply', trigger.stepId);
    },
  };
  const thinker: AxMindThinker = {
    name,
    kind: 'responder',
    subscription: Object.freeze({
      ...axDefaultMindSubscription,
      types: Object.freeze(['message']),
      ...options.subscription,
    }),
    ai: options.ai,
    createProgram: async (instance) => {
      bound = instance.mind;
      return ax(RESPONDER_SIGNATURE) as unknown as AxProgrammable<any, any>;
    },
    context: (request) => {
      triggers.set(request.eventContext.deliveryId, request.trigger);
      const conversation = request.projection.recent
        .filter((step) => step.type === 'message')
        .map(
          (step) =>
            `${String(step.data.from ?? 'someone')}: ${String(step.data.content ?? '')}`
        )
        .join('\n');
      const innerLife = request.projection.recent
        .filter((step) => step.type !== 'message')
        .slice(-8)
        .map((step) => `${step.type}: ${String(step.data.content ?? '')}`)
        .join('\n');
      return {
        conversation,
        ...(innerLife ? { innerLife } : {}),
      };
    },
    sinks: Object.freeze([sink as AxEventSink<any>]),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.forwardOptions
      ? { forwardOptions: options.forwardOptions }
      : {}),
  };
  return Object.freeze(thinker);
};
