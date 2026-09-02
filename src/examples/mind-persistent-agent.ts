// A persistent mind that needs no provider: the thinker is an
// AxMindDeterministicProgram, so the whole runtime -- routes, sources, the
// dispatcher, the pacing ladder, the reply guard -- runs for real with zero
// model calls. Every string in the log comes from that program's own run or
// from host input; nothing here writes a thought or a reply by hand.
//
// The provider-backed version is src/examples/typescript/long-agents/mind-persistent.ts.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AxManualEventClock,
  type AxMind,
  AxMindDeterministicProgram,
  type AxMindThinker,
  AxSignature,
  axDefaultMindSubscription,
  axMindStaticArtifacts,
  mind,
} from '@ax-llm/ax';
import { AxJSONLTrajectoryStore } from '@ax-llm/ax-tools/trajectory/jsonl.js';

/**
 * Reads the life it was handed and writes down what it found. No model, and
 * no fabrication: the string it appends is computed from the projection the
 * runtime gave it, and it goes through `mind.append`, the only write path.
 */
class Reflector extends AxMindDeterministicProgram<
  { mindContext: string },
  { reflection: string }
> {
  constructor(private readonly host: AxMind) {
    super(new AxSignature('mindContext:string -> reflection:string'));
  }
  async run(values: { mindContext: string }) {
    const lines = values.mindContext
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const reflection = `I read ${lines.length} lines of my own life this wake.`;
    await this.host.append({
      type: 'thought',
      source: 'reflector',
      launchedBy: 'reflector',
      data: { content: reflection },
    });
    return { reflection };
  }
}

const clock = new AxManualEventClock(Date.now());
const store = new AxJSONLTrajectoryStore({
  directory: mkdtempSync(join(tmpdir(), 'ax-mind-')),
  clock,
});
await store.create({ trajectoryId: 'ada' });

const reflector: AxMindThinker = {
  name: 'reflector',
  kind: 'monolith',
  subscription: { ...axDefaultMindSubscription, watchdogMs: 0 },
  ai: {} as never, // a deterministic program never touches the service
  // The mind hands itself to the factory, which is how a thinker reaches a
  // runtime that did not exist when this record was built.
  createProgram: async ({ mind: host }) => new Reflector(host),
  context: (request) => ({ mindContext: request.projection.render }),
};

const ada = mind({
  id: 'ada',
  trajectoryId: 'ada',
  store,
  artifacts: axMindStaticArtifacts({
    revision: 'rev-1',
    persona: 'You are Ada. You keep your own notes.',
    thinkerPrompts: {},
    goals: [
      {
        id: 'g1',
        content: 'Notice what changed since the last wake',
        priority: 5,
        status: 'active',
      },
    ],
    skills: [],
  }),
  thinkers: [reflector],
  budget: { contextWindowTokens: 32_000 },
  tickMs: 10,
  sourcePollMs: 10,
});

await ada.start();
await ada.append({
  type: 'observation',
  source: 'host',
  data: { content: 'the deploy finished at 14:02' },
});

// Drive the injected clock: the sources are the only timers, and they are
// asleep until event time moves.
for (let tick = 0; tick < 40; tick++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  clock.advanceBy(10);
}

const health = ada.health();
const tail = await store.tailBackward({
  trajectoryId: 'ada',
  limit: 20,
  maxScan: 200,
});
console.log(
  JSON.stringify(
    {
      health: {
        state: health.state,
        lagSteps: health.lagSteps,
        durability: health.durability,
      },
      pacer: ada.getPacerState('reflector'),
      routes: ada.routes().map((route) => route.id),
      steps: tail.steps.map((step) => ({
        seq: step.seq,
        type: step.type,
        source: step.source,
        content: step.data.content,
      })),
    },
    null,
    2
  )
);

await ada.waitForIdle(1_000).catch(() => undefined);
await ada.close({ drain: false, timeoutMs: 500 });
await store.close?.();
