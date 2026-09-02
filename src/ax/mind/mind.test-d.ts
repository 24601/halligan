// mind.test-d.ts — compile-time tests for the mind surface, enforced by
// `npm run test:type-tests` (tsc -p tsconfig.typetests.json). `mind()` and
// `AxMind` land with the runtime commit; everything the pacing, routing,
// source, chat, salience and skill machinery exposes is covered here.

import type { AxAIService } from '../ai/types.js';
import type { AxProgrammable } from '../dsp/types.js';
import { validateEventTarget } from '../event/mapping.js';
import type { AxEventTarget } from '../event/types.js';
import type {
  AxMindPaceDecision,
  AxMindReplyResolution,
  AxMindSubscription,
  AxMindThinker,
  AxMindWakeOutcome,
} from '../index.js';
import { axDefaultMindSubscription, axNextMindPace } from '../index.js';

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
