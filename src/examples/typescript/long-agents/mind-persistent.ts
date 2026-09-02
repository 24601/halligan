// ax-example:start
// title: TypeScript Persistent Mind (Thinkers, Pacing, Ledgered Chat)
// group: long-agents
// description: Runs an always-on mind over a durable trajectory: a monolith thinker that wakes from appends and from its own spontaneity ladder, a responder that answers inbound messages exactly once through a ledgered transport, and a liveness watchdog that revives a broken trigger chain.
// provider: openai
// env: OPENAI_API_KEY, OPENAI_APIKEY
// level: advanced
// order: 40
// ax-example:end
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AxAIOpenAIModel,
  type AxMindChatMessage,
  type AxMindChatTransport,
  type AxMindEffectLedger,
  type AxMindSendReceipt,
  ai,
  axMindMonolith,
  axMindResponder,
  axMindStaticArtifacts,
  mind,
} from '@ax-llm/ax';
import { AxJSONLTrajectoryStore } from '@ax-llm/ax-tools/trajectory/jsonl.js';

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY;
if (!apiKey) {
  throw new Error(
    'Set OPENAI_API_KEY (or OPENAI_APIKEY) before running this example.'
  );
}

const llm = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

/**
 * The host owns outbound delivery AND the mind's from-identity. This one
 * prints; a real one posts to Slack, SMTP or a webhook. It must be idempotent
 * on `idempotencyKey`, because the ledger keys every send by it.
 */
const delivered = new Map<string, Readonly<AxMindChatMessage>>();
const transport: AxMindChatTransport = {
  id: 'stdout',
  selfName: 'ada',
  async send(message, context): Promise<AxMindSendReceipt> {
    if (!delivered.has(context.idempotencyKey)) {
      delivered.set(context.idempotencyKey, message);
      console.log(`ada -> ${message.to}: ${message.content}`);
    }
    return { externalId: context.idempotencyKey, at: Date.now() };
  },
};

/**
 * Crash C10 needs a ledger that spans deliveries: AxEventContext.listEffects()
 * reports the CURRENT delivery only. A real host backs this with its event
 * store; this example keeps it in memory, which is honest about what a
 * process restart would lose.
 */
const effects = new Map<string, any>();
const effectLedger: AxMindEffectLedger = {
  async declareEffect(intent) {
    const existing = [...effects.values()].find(
      (one) => one.idempotencyKey === intent.idempotencyKey
    );
    if (existing) return existing;
    const effect = {
      ...intent,
      id: `effect-${effects.size + 1}`,
      deliveryId: 'host',
      runId: 'host',
      identityScope: 'ada',
      requestDigest: intent.idempotencyKey,
      status: 'intent' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dispatchCount: 0,
      version: 1,
    };
    effects.set(effect.id, effect);
    return effect;
  },
  async markEffectDispatched(effectId) {
    const effect = { ...effects.get(effectId), status: 'dispatched' };
    effect.version += 1;
    effects.set(effectId, effect);
    return effect;
  },
  async settleEffect(effectId, _version, settlement) {
    const effect = { ...effects.get(effectId), status: settlement.status };
    effect.version += 1;
    effects.set(effectId, effect);
    return effect;
  },
  async listEffects() {
    return [...effects.values()];
  },
};

const store = new AxJSONLTrajectoryStore({
  directory: mkdtempSync(join(tmpdir(), 'ax-mind-live-')),
});
await store.create({ trajectoryId: 'ada' });

const ada = mind({
  id: 'ada',
  trajectoryId: 'ada',
  store,
  artifacts: axMindStaticArtifacts({
    revision: 'rev-1',
    persona:
      'You are Ada. You keep your own notes, you say what you actually think, and you never pad an answer.',
    thinkerPrompts: {
      monolith:
        'When you wake with nothing new to do, say so with idle() rather than inventing work.',
    },
    goals: [
      {
        id: 'g1',
        content: 'Answer Basit quickly and honestly',
        priority: 9,
        status: 'active',
      },
    ],
    skills: [],
  }),
  thinkers: [
    axMindMonolith({
      ai: llm,
      maxTurns: 2,
      pacer: {
        baseMs: 5_000,
        factor: 2,
        capMs: 300_000,
        hold: 3,
        thoughtCapMs: 60_000,
      },
    }),
    axMindResponder({ ai: llm }),
  ],
  budget: { contextWindowTokens: 200_000 },
  transport,
  effectLedger,
  onDiagnostic: (diagnostic) =>
    console.log(`[${diagnostic.code}] ${diagnostic.message}`),
});

await ada.start();
await ada.receive({
  from: 'basit',
  to: 'ada',
  content: 'the deploy finished. anything you want to flag before I sign off?',
});

// A paced mind never goes idle -- that is the whole point -- so `waitForIdle`
// is NOT its shutdown path. A real host keeps the process alive; this example
// gives the thinkers a window and then closes. A full agent turn with tools
// can outlast it, in which case the run is aborted at close and lands in
// `deadLetters()` as `outcome_unknown` -- which is the honest classification,
// not a bug: nothing is re-dispatched on the strength of a guess.
await new Promise((resolve) => setTimeout(resolve, 60_000));

const health = ada.health();
const tail = await store.tailBackward({
  trajectoryId: 'ada',
  limit: 40,
  maxScan: 400,
});
console.log(
  JSON.stringify(
    {
      health: {
        state: health.state,
        lagSteps: health.lagSteps,
        durability: health.durability,
      },
      pacer: ada.getPacerState('monolith'),
      delivered: delivered.size,
      // A dead-lettered wake appends nothing, so this is the only place a
      // host can see one.
      deadLetters: (await ada.deadLetters()).map((one) => one.reason),
      life: tail.steps.map((step) => ({
        seq: step.seq,
        type: step.type,
        source: step.source,
        content:
          typeof step.data.content === 'string'
            ? step.data.content.slice(0, 90)
            : undefined,
      })),
    },
    null,
    2
  )
);

await ada.close({ drain: true, timeoutMs: 10_000 });
await store.close?.();
