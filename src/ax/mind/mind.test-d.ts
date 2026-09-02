// mind.test-d.ts — compile-time tests for the mind surface, enforced by
// `npm run test:type-tests` (tsc -p tsconfig.typetests.json). Everything the
// runtime, the pacing, routing, source, chat, salience and skill machinery
// exposes is covered here, including what a thinker deliberately cannot see.

import type { AxAIService } from '../ai/types.js';
import type { AxProgrammable } from '../dsp/types.js';
import { validateEventTarget } from '../event/mapping.js';
import type { AxEventTarget } from '../event/types.js';
import type {
  AxMind,
  AxMindContextRequest,
  AxMindPaceDecision,
  AxMindReplyResolution,
  AxMindSubscription,
  AxMindThinker,
  AxMindWakeOutcome,
  AxTrajectoryStore,
} from '../index.js';
import {
  axDefaultMindSubscription,
  axMindStaticArtifacts,
  axNextMindPace,
  mind,
} from '../index.js';

declare const ai: AxAIService;
declare const program: AxProgrammable<{ prompt: string }, { answer: string }>;

// A thinker propagates its program's generics into the classifier it declares,
// so a thinker that returns `{ answer }` cannot classify a different shape.
const thinker: AxMindThinker<{ prompt: string }, { answer: string }> = {
  name: 'monolith',
  kind: 'monolith',
  subscription: axDefaultMindSubscription,
  ai,
  program,
  // The assembler's return type is the program's IN, so a thinker cannot hand
  // its own program a shape the signature does not accept.
  context: (request) => ({ prompt: request.projection.render }),
  classify: (result) => {
    const answer: string | undefined = result.output?.answer;
    void answer;
    // @ts-expect-error the program's output has no `missing` field
    void result.output?.missing;
    return 'visible';
  },
};

// The thinker record is the shape `validateEventTarget` demands: `ai` plus
// exactly one of program/createProgram (RFC 3.4 C4).
const asTarget: AxEventTarget<{ prompt: string }, { answer: string }> = {
  id: thinker.name,
  ai: thinker.ai,
  program: thinker.program,
  mapInput: () => ({ prompt: 'x' }),
};
void validateEventTarget(asTarget);

// The thinker record is the entire surface a program can reach: no transport
// identity and no route table, both host-owned (authority items 3 and 5). A
// runtime `Object.keys` check on a literal the test just wrote proves nothing;
// this fails to compile the moment either field is added.
// @ts-expect-error a thinker carries no transport
void thinker.transport;
// @ts-expect-error a thinker carries no route table
void thinker.routes;

// A subscription is deeply readonly: routes are fixed at construction and a
// thinker never edits its own wake policy.
// @ts-expect-error triggerSelf is readonly
thinker.subscription.triggerSelf = true;
declare const subscription: AxMindSubscription;
// @ts-expect-error the subscribed type list is readonly
subscription.types?.push('message');

// The pace decision narrows on `kind`, and only the `arm` arm carries a delay.
declare const decision: AxMindPaceDecision;
if (decision.kind === 'arm') {
  const delayMs: number = decision.delayMs;
  void delayMs;
} else {
  // @ts-expect-error `unchanged` deliberately has no delay to write anywhere
  void decision.delayMs;
}

// Every wake outcome is exhaustively switchable: a new one is a compile error
// at every call site that classifies a run.
function describeOutcome(outcome: AxMindWakeOutcome): string {
  switch (outcome) {
    case 'visible':
      return 'visible';
    case 'thought':
      return 'thought';
    case 'empty':
      return 'empty';
    case 'error':
      return 'error';
    case 'noop':
      return 'noop';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
void describeOutcome;

// The ladder is pure: state in, decision out, `now` supplied by the caller.
const next: AxMindPaceDecision = axNextMindPace(
  { level: 0, ticks: 0, spontaneousWakes: [] },
  { wakeClass: 'spontaneous', outcome: 'empty', now: 0 }
);
void next;
void axNextMindPace(
  { level: 0, ticks: 0, spontaneousWakes: [] },
  {
    // @ts-expect-error a wake class the ladder does not define is rejected
    wakeClass: 'whenever',
    outcome: 'empty',
    now: 0,
  }
);

// A reply resolution reports the fact and how it was reached, never a verdict
// about whether an answer is warranted.
declare const resolution: AxMindReplyResolution;
const state: 'answered' | 'declined' | 'claimed' | 'unanswered' =
  resolution.state;
const failedOpen: boolean = resolution.failedOpen;
const widened: boolean = resolution.widened;
void state;
void failedOpen;
void widened;

// `mind()` infers AxMind, and the options record is the whole configuration
// surface: a host supplies identity, budgets, authority and the registry, and
// a thinker never sees any of it.
declare const store: AxTrajectoryStore;
const instance: AxMind = mind({
  trajectoryId: 'traj',
  store,
  artifacts: axMindStaticArtifacts({
    revision: 'rev-1',
    persona: '',
    thinkerPrompts: {},
    goals: [],
    skills: [],
  }),
  thinkers: [thinker],
  budget: { contextWindowTokens: 8_000 },
});
void instance.health();
void instance.routes();
// @ts-expect-error a mind has no update path; the log is append-only
void instance.updateStep;
// @ts-expect-error nor a delete path
void instance.deleteStep;
// @ts-expect-error nor a way to rewrite history
void instance.rewrite;

// The context request is the entire surface a thinker program is handed.
declare const request: AxMindContextRequest;
const budgetTokens: number = request.budgetTokens;
void budgetTokens;
void request.projection.render;
void request.artifacts.persona;
// @ts-expect-error the transport's from-identity is host-owned (authority 5)
void request.transport;
// @ts-expect-error the route table is fixed at construction (authority 3)
void request.routes;
// @ts-expect-error a thinker cannot reach the mind's own close()
void request.mind;
// The signal list is readonly: a hint is not a place to write policy back.
// @ts-expect-error routing signals are readonly
request.signals.push({ code: 'share_nudge', text: 'x' });

// RFC 6.5 item 1 by CONSTRUCTION, not by convention: the trajectory handle a
// thinker is given exposes the read primitives and nothing else, so there is
// no write path to forget to forbid.
void request.store.tailBackward;
void request.store.getStep;
void request.store.getSteps;
void request.store.read;
void request.store.stats;
void request.store.getTrajectory;
// @ts-expect-error a thinker never appends; the runtime is the only writer
void request.store.append;
// @ts-expect-error nor forks
void request.store.fork;
// @ts-expect-error nor merges
void request.store.merge;
// @ts-expect-error nor creates a trajectory
void request.store.create;
// @ts-expect-error nor moves another consumer's cursor
void request.store.saveCursor;
// @ts-expect-error and the blob store's put is a write, so blobs are absent
void request.store.blobs;
// The full store is still assignable INTO the reader, which is what lets the
// runtime hand its own store over without a wrapper.
declare const fullStore: AxTrajectoryStore;
const reader: AxMindContextRequest['store'] = fullStore;
void reader;
