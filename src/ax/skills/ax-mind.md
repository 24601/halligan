---
name: ax-mind
description: Use mind() to run a persistent agent whose thinkers wake from trajectory appends, a paced spontaneity ladder, and a liveness watchdog, with ledgered outbound messages and exactly-one-reply chat semantics. Use when the user asks about mind(), AxMind, AxMindThinker, thinkers, persistent agency, spontaneous wakes, salience injection, or an always-on agent.
---

# Ax Mind Codegen Rules

Prefer short, modern, copyable patterns. Do not write tutorial prose unless the
user explicitly asks for explanation.

A mind is a persistent agent: thinkers that wake from appends to a trajectory,
from a paced spontaneity ladder, and from a liveness watchdog. It is not a chat
loop and it is not a cron job.

## Use These Defaults

- `mind({ trajectoryId, store, artifacts, thinkers, budget })`. Nothing starts
  until `await mind.start()`.
- `AxJSONLTrajectoryStore` (from `@ax-llm/ax-tools`) for anything that must
  survive a restart. `AxInMemoryTrajectoryStore` is refused unless you pass
  `allowVolatileTrajectory: true`.
- `axMindMonolith({ ai })` plus `axMindResponder({ ai })`. One monolith with
  the whole function menu, one cheap responder per inbound message.
- `axMindStaticArtifacts({ revision, persona, thinkerPrompts, goals, skills })`
  until you have a host that can issue write receipts.
- The shipped pacer: `capMs: 300_000` (12 spontaneous wakes/hour at rest) and
  `watchdogMs: 300_000`. Those are the only two knobs; everything else is
  derived.

## Non-Negotiable Rules

- The HOST owns identity, authority, budgets, the route table, the registry,
  the watchdog window and the transport's `selfName`. None of them is reachable
  from a thinker program.
- A thinker never edits the log. `AxMind.append` is the only write path, and
  there is no update, delete, rewrite or compact method anywhere.
- Every outbound message is a DECLARED EFFECT before any I/O:
  `declareEffect` -> `markEffectDispatched` -> transport -> `settleEffect`.
- A thinker is an `AxProgrammable`, never a callback. That is what makes it
  compose as a flow node, an event target and an `optimize()` subject.
- Never start a timer outside an `AxEventSource`. Constructing an `AxMind`
  starts nothing.
- Never reply without the guard. `chat.reply()` refuses unless the reply state
  is `unanswered`.
- No unbounded reads, and no second queue. The append-only log IS the backlog.
- There is no `pending` knob: the class is derived from the registry by
  `axMindPendingClass`.

## Canonical Pattern

```ts
import {
  AxAIOpenAIModel,
  ai,
  axMindMonolith,
  axMindResponder,
  axMindStaticArtifacts,
  mind,
} from '@ax-llm/ax';
import { AxJSONLTrajectoryStore } from '@ax-llm/ax-tools';

const llm = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

const store = new AxJSONLTrajectoryStore({ directory: './life' });
await store.create({ trajectoryId: 'ada' });

const instance = mind({
  trajectoryId: 'ada',
  store,
  artifacts: axMindStaticArtifacts({
    revision: 'rev-1',
    persona: 'You are Ada. You keep your own notes and you say what you think.',
    thinkerPrompts: {},
    goals: [{ id: 'g1', content: 'Answer Basit well', priority: 5, status: 'active' }],
    skills: [],
  }),
  thinkers: [
    axMindMonolith({ ai: llm, pacer: { baseMs: 5_000, factor: 2, capMs: 300_000, hold: 3, thoughtCapMs: 60_000 } }),
    axMindResponder({ ai: llm }),
  ],
  budget: { contextWindowTokens: 200_000 },
  transport,          // host-owned outbound delivery
  effectLedger,       // host adapter for crash-C10 reconcile-at-start
});

await instance.start();
await instance.receive({ from: 'basit', to: 'ada', content: 'how did today go?' });
await instance.waitForIdle();
await instance.close();
```

## Thinkers And Subscriptions

A thinker is `AxEventTarget`-shaped: `ai` plus exactly one of
`program` / `createProgram`, plus a `context` assembler.

```ts
const auxiliary: AxMindThinker = {
  name: 'librarian',
  kind: 'auxiliary',
  subscription: { triggerSelf: false, watchdogMs: 300_000, maxInFlight: 4 },
  ai: llm,
  createProgram: async ({ mind, thinker }) => buildProgram(mind, thinker),
  context: (request) => ({ mindContext: request.projection.render }),
};
```

- `request.store` is an `AxTrajectoryReader`, not the full store: the read
  primitives only. A thinker reads the trajectory; the runtime writes it, so
  `append` / `fork` / `merge` / `saveCursor` do not compile from a thinker.
- `subscription.types` absent means every wakeable NARRATIVE type. Machinery is
  opt-in, so a thinker is never woken by the mind's own bookkeeping by default.
- `triggerSelf` is decided by the STEP'S `source` FIELD, not by process
  identity. An external writer of the same type still wakes a
  `triggerSelf: false` thinker.
- A thinker never re-triggers on its own `error` step, even under
  `triggerSelf: true`.
- `maxInFlight` is an admission bound, not a drop: at the bound the source
  stops advancing THAT consumer's cursor and retries on the next pass.
- Scheduled spontaneity is opt-in: only a thinker that declares `pacer` gets a
  timer. At most one thinker may declare it.
- `createProgram` receives the mind itself, which is how a thinker's tools
  reach a runtime that did not exist when the thinker record was built.
- A thinker never wakes on a SIBLING thinker's contentless step either. The
  suppressed class is derived from the registry by `axMindSiblingWakeSuppressed`
  — `wakeSignal` types (`mind-wake`, `mind-idle`, `manual-trigger`), a wakeable
  type carrying no content (`idle`), and `neverRetriggersSelf` types (`error`).
  Payload types (`message`, `action`, `observation`, `merge`, `thought`) wake a
  sibling normally, and so does an EXTERNAL writer of a suppressed type.
  Without this, two thinkers on the default subscription answer each other's
  `idle` steps forever. The refusal is reported as `wake-suppressed-sibling`.

## Pacing

`delay(0) = 0`; `delay(n >= 1) = min(baseMs * factor^(n-1), capMs)`.

| wake class | outcome | level | ticks | decision |
|---|---|---|---|---|
| `reactive` / `bootstrap` / `manual` | any | `0` | `0` | `arm(0)` |
| `spontaneous` | `visible` | `0` | `0` | `arm(0)` |
| `spontaneous` | `thought` | `ticks+1 >= hold` -> `level+1` | `(ticks+1) mod hold` | `arm(min(delay, thoughtCapMs))` |
| `spontaneous` | `empty` | `ticks+1 >= hold` -> `level+1` | `(ticks+1) mod hold` | `arm(delay(level'))` |
| `spontaneous` | `error` | `level+1` immediately, no dwell | `0` | `arm(delay(level'))` |
| `watchdog` | `visible` | `0` | `0` | `arm(0)` |
| `watchdog` | otherwise | as `spontaneous` | as `spontaneous` | as `spontaneous` |
| any | `noop` | unchanged | unchanged | **`unchanged` -- leave the running timer alone** |
| any | any, over `maxWakesPerHour` | `parked: 'rate_fuse'` | unchanged | **`unchanged`** + a `mind-error` step |

The cost curve, measured: **12 spontaneous wakes/hour at `capMs: 300_000`, 6 at
600 000**, both at rest with the ladder fully descended. A day that starts from
engagement costs more, because the descent is real spend.

The outcome is a WORK PROBE over two bounded tails, never a parse of model
output: a new visible step is `visible`, a new thought is `thought`, neither is
`empty`, a throw is `error`. Engagement is defined by visible effect.

## Liveness And Health

- ONE always-alive tick with two duties: the paced wake and the watchdog. A
  spawned per-step timer is a failure mode; an always-alive loop that owns an
  injected clock is not.
- Every liveness bug degrades to a `<= watchdogMs` delay, never a dead mind. A
  thinker with `watchdogMs: 0` has no liveness layer at all.
- Health is LAG -- newest appended versus newest processed -- and never
  liveness. `health().state` reports `stalled` while every handle is alive,
  which is exactly the blindness a "the loop is running" check cannot detect.
- `health().durability` reports the durability the mind ACTUALLY got, per
  store, rather than the one you hoped for.
- `reconcile()` recomputes health, rebuilds each thinker's pacer state from the
  trajectory, and converges the log to the effect ledger.
- Work a thinker does in its own SINK counts: the mind installs a trailing
  `mind-settle` sink after the thinker's sinks, so the wake that sent a reply
  is `visible`, not `idle`.
- A delivery that terminalises with no pace decision -- a dead-lettered context
  assembly (`AxTrajectoryRollupError('meta_conflict')`,
  `AxTrajectoryQueryError('unsupported_types')`), a settle that threw, a
  delivery abandoned before `forward` -- re-arms ONE wake at that thinker's
  `capMs`. The arm is a runtime guarantee, not a code path.

## Chat Semantics

`axResolveMindReplyState` answers the FACT ("has this been answered"), never
the JUDGMENT ("does it need a reply"). The rows are a priority order:

| # | Evidence after the trigger | Result |
|---|---|---|
| 1 | an outbound `message` from us with `replyTo === trigger.stepId` | `answered` |
| 2 | a SETTLED `mind.chat.send` effect under the trigger's key | `answered` |
| 3 | our `observation` with `decision: 'replied'` | `answered` |
| 4 | our `observation` with `decision: 'no-reply'` | `declined`, and it sticks |
| 5 | any outbound `message` from us to that sender after it | `answered` |
| 6 | a `reply-claim` for it still inside its TTL | `claimed` |
| 7 | a claim past its TTL, or with an unreadable time | ignored, `failedOpen: true` |
| 8 | none of the above | `unanswered` |

- "From us" is the HOST-STAMPED writer identity (`selfSources`), never
  `data.from`, which the remote party controls.
- The idempotency key is
  `'ax.mind.chat:' + sha256(identityScope + ' ' + to + ' ' + (replyTo ?? claimId))`.
  The disjunction is load-bearing: a per-attempt `claimId` inside a key that
  also carries `replyTo` destroys the cross-attempt dedupe.
- The claim fails OPEN. A retry is safer than a dropped message.
- Self-addressed traffic is refused in BOTH directions with one error:
  `AxMindChatError('self_addressed')` from `receive()` and from the send tool
  alike, plus an explaining `observation` in the log. A host can guard the
  whole boundary with `axIsMindChatError`.
- Third-party text reaches a thinker QUOTED: `axMindQuote` one-lines, bounds
  and fences a sender name and a message body, so a body carrying a fake
  `Signals (...)` header cannot forge the mind's own hint block.
- **Sends are NOT exactly-once.** A transport call that throws leaves the
  effect `dispatched` for a resolver; it is never re-dispatched blind, and the
  message is missing from the log until a resolver settles it.

## Salience Injection

An inbound message that arrives while a thinker is mid-run is offered once,
GLOBALLY by source step, and reaches the running turn through `guideAgent`.

Two costs, stated rather than hidden:

- The wrapped tool call **does not execute**. `guideAgent` throws
  `AxAgentProtocolCompletionSignal`, so the turn ends with the guidance
  appended and the actor has to make that call again. The price is one aborted
  tool call.
- A turn that calls **no** host function never sees mid-run salience. Coverage
  is best-effort mid-run and guaranteed at the next step, because the item
  stays in the buffer and the next projection includes the message.

## Skills Kernel

`axSelectMindSkills(skills, { kernelIds, tokenBudget, environment })` returns
two tiers plus what it hid and why.

- Over budget a skill is DEMOTED whole to the catalog, never truncated
  mid-body: a half body reads as complete.
- Priority is the host's `kernelIds` order. Once an entry does not fit, every
  lower-priority entry is demoted too.
- `requires` is matched against HOST FACTS only. A skill body that claims a
  capability can never satisfy one.

## Budgets

Every thinker step has explicit ceilings, never inherited from a total:

```ts
budget: { maxWallClockMs: 600_000, maxTokens: 120_000, maxSubRuns: 8, maxDepth: 2 }
```

`maxTokens` is the DELTA one step spends, measured across that step's own
`forward`; `AxProgram.getUsage()` accumulates for the life of the program, so
comparing the raw total to a per-step cap would brick a thinker after
`maxTokens / spend-per-wake` wakes.

Exceeding one raises `AxMindBudgetExceededError`, appends an `error` step, and
descends the ladder. `subRun()` is capped by `maxSubRuns` and `maxDepth` and
ALWAYS merges something back, success or failure. Pass `thinker` on the sub-run
request whenever more than one thinker step can be in flight: the mind refuses
to guess whose cap to spend rather than charge the wrong one.

## Authority Boundary

**Host-owned, unreachable from any thinker program:** the trajectory's
contents; the step-type registry; the route table and subscriptions; authority
grants; the transport's `selfName`; the effect ledger; every budget; the pacer
config, rate fuse and watchdog window; rollup provenance stamps and the artifact
`revision`; and the mind's own restart -- `AxMind.close()` is not a tool.

**Model-owned, all of it host-mediated:** what to do next (the function menu
`act` / `think` / `share` / `learn` / `goals` / `idle`, with routing signals as
hints and no priority ladder); its memories, through `memoriesCatalog` /
`onMemoriesSearch`; its goals and values, through `AxMindArtifactSource.write`
with an out-of-band receipt; which skills are in its kernel; whether to reply,
with `NO_REPLY` recorded rather than dropped; and its own prompt artifacts,
again only through a receipted write.

There is deliberately no `recall` tool: `recall()` is the agent runtime's own
verb, and a second one would shadow it.

## Crash Matrix

Rows C1-C14 and their verdicts are in `docs/MIND.md`. The short version: a kill
at any enumerated point loses no committed step and sends no duplicate message;
C1 (a trigger that never became a step) relies on the watchdog; C8 and C9 leave
an unconfirmed send for a resolver rather than guessing.

## Testing

- `AxManualEventClock` everywhere. The mind and its trajectory store must share
  ONE clock instance or `start()` refuses with `clock_mismatch`.
- Model-free thinkers: extend `AxMindDeterministicProgram` and run the real
  dispatcher with no AI call.
- Assert negatives: zero model calls when the context assembler throws, zero
  duplicate sends under fault injection, and the deferred step delivered on the
  next pass.

```bash
npx vitest run src/ax/mind
npm run mind:pacer:eval
npm run mind:durability:eval
```

## Evaluation

> This is a deterministic zero-cost mechanism evaluation with fault injection.
> It is bounded machinery evidence -- pacing, liveness, idempotency, projection
> shape and size, store conformance, and crash classification. It is not a
> held-out model comparison. It says nothing about whether the mind thinks
> well, chooses good routes, or writes useful memories, and no claim of that
> kind is made.

## Examples

- https://raw.githubusercontent.com/ax-llm/ax/main/src/examples/mind-persistent-agent.ts
- https://raw.githubusercontent.com/ax-llm/ax/main/src/examples/typescript/long-agents/mind-persistent.ts

See `ax-trajectory.md` for the append-only log and the projection a mind's
context assembler reads.

## Do Not Generate

- No self-restart. `close()` from inside a thinker run is refused.
- No self-granted authority, and no identity read from step data.
- No timer outside an `AxEventSource`, and no `setInterval` anywhere.
- No reply without `chat.reply()`'s guard, and no second reply after a decline.
- No unbounded read. Every read primitive takes a bound and reports it.
- No second queue: a deferral holds a cursor, it does not enqueue.
- No `pending` knob, and no hardcoded priority ladder over the routing signals.
- No walls between people: one mind has one timeline, so assume anything told
  to it is shared with everyone who talks to it.
