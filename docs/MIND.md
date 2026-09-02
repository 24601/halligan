# AxMind — the persistent-agency runtime

`src/ax/mind/` is what makes an agent persistent: thinkers that wake from
appends to a trajectory, from a paced spontaneity ladder, and from a liveness
watchdog, with ledgered outbound messages and exactly-one-reply chat semantics.
This document is the normative contract: thinkers, the dispatch decision table,
the pacing table, liveness and health, chat semantics, salience, the authority
table, the crash matrix, and the explicit non-guarantees.

See [`docs/TRAJECTORY.md`](./TRAJECTORY.md) for the log a mind lives in,
[`docs/EVENT_RUNTIME.md`](./EVENT_RUNTIME.md) for the dispatcher it runs on, and
`src/ax/skills/ax-mind.md` for the codegen rules.

## What a mind is, and is not

A mind is not a chat loop: it wakes on its own schedule, and most of its wakes
have no human in them. It is not a cron job either: engagement resets its
backoff to zero, and an error descends it immediately.

Nothing starts until `start()`. Constructing an `AxMind` starts no timer, no
source and no loop; both event sources are opt-in `AxEventSource`s owning an
injected clock, which preserves the event runtime's own guarantee that Ax
starts no timers unless a source is started.

## Thinkers

A thinker is `AxEventTarget`-shaped on purpose: it composes as a flow node, an
event target and an `optimize()` subject for free. `ai` is required, exactly
one of `program` / `createProgram` must be supplied, and a `context` assembler
builds the program's input from the projection.

| field | meaning |
|---|---|
| `subscription.types` / `.classes` | absent means every wakeable NARRATIVE type; machinery is opt-in |
| `subscription.triggerSelf` | suppression is by the step's `source` field, NOT process identity |
| `subscription.watchdogMs` | 0 disables the watchdog for this thinker, leaving it no liveness layer |
| `subscription.maxInFlight` | an admission bound: at it the cursor is HELD, nothing is dropped |
| `pacer` | opt-in scheduled spontaneity. At most one thinker may declare it |
| `budget` | per-wake wall-clock, token, sub-run and depth ceilings, never inherited |

`createProgram` receives the mind itself. That is how a thinker's tools reach a
runtime that did not exist when the thinker record was built, without a global
and without a two-step host dance.

The two shipped thinkers: `axMindMonolith` is ONE agent with the whole function
menu (`act` / `think` / `share` / `learn` / `goals` / `idle`), and
`axMindResponder` is a single generation with a chat-shaped context and an
inner-life block, cheap enough to run on every inbound message.

**A sibling thinker never wakes on another thinker's contentless step.**
Self-suppression alone is per thinker: it stops a thinker re-triggering on its
OWN writing and nothing else, so two thinkers on the default subscription used
to answer each other's `idle` steps forever — an unbounded, token-spending
ping-pong with no work in it. The route predicate now refuses that wake by the
step's WRITER IDENTITY, exactly as it refuses the self-loop, and reports it as
the `wake-suppressed-sibling` diagnostic (a suppressed wake creates no delivery
and no step, so there is nowhere else to see it).

The suppressed class is derived from the registry by
`axMindSiblingWakeSuppressed`, never listed by hand:

| registry fact | shipped types | why a sibling is not woken |
|---|---|---|
| `wakeSignal: true` | `mind-wake`, `mind-idle`, `manual-trigger` | a pure wake signal carries no payload to read |
| wakeable with no content at all | `idle` | "I did nothing" is not news for anyone else |
| `neverRetriggersSelf: true` | `error` | the registry already forbids feeding it back to its writer; feeding it to the writer's sibling is the same loop with one more actor in it |

Payload-carrying types (`message`, `action`, `observation`, `merge`, `thought`)
wake a sibling normally — that is the whole point of a second thinker. So does
an EXTERNAL writer of any of the suppressed types: suppression is by writer
identity, so a host or a person appending an `idle` still wakes everyone. A
single-thinker mind has no siblings, so its dispatch is unchanged.

`mind.test.ts` asserts both halves against a step-ceiling store — the runaway
starves the event loop synchronously, so vitest's own timeout never fires and
the bound has to live in the store the runaway writes to.

Third-party text reaches a thinker QUOTED. `axMindQuote` one-lines, bounds and
fences every remote-controlled value the responder interpolates (a sender name,
a message body), because the assembled prompt is newline-framed: a body carrying
a newline and `Signals (hints about your own recent behaviour...)` would
otherwise forge the mind's own hint block. This is the salience buffer's fence
applied to the same text on the other path.

## Dispatch decision table

Evaluated in order, per drained step, per subscribed thinker. The first
`drop` or `defer` wins.

| # | Condition | Action |
|---|---|---|
| 1 | the step belongs to another trajectory | drop |
| 2 | `descriptor.wakeable === false` | drop, never published |
| 3 | the type is outside the subscription | drop |
| 4 | `step.source === thinker.name && !triggerSelf` | the route's `authorize` returns false, so no delivery is created |
| 5 | the thinker's own `error` step | dropped UNCONDITIONALLY, even under `triggerSelf` |
| 6 | `inFlight() >= maxInFlight` | **defer**: hold this consumer's cursor, diagnose, retry next pass |
| 7 | consecutive wake signals of one type | publish only the newest with `data.coalesced = n` |
| 8 | otherwise | publish -> `wake` route -> `instanceKey = thinker`, `ordering: 'strict'` |
| 9 | the step is an inbound `message` and a subscribed thinker is mid-run | additionally `salience.offer(...)`, a `feedback` step and the `salience-injected` diagnostic |
| 10 | `publish` throws `AxEventBackpressureError` | exactly row 6: cursor held, retried |

Row 4 has a sibling half: `axMindSiblingWakeSuppressed(step.type)` and a
`step.source`/`launchedBy` naming ANOTHER thinker of this mind also returns
`authorize` false, with the `wake-suppressed-sibling` diagnostic.

Nothing is ever dropped. The append-only log IS the backlog, so a deferral
costs latency and never a wake.

The published event carries step IDENTITY and CLASSIFICATION only —
`{stepId, trajectoryId, seq, type, ts, source?, runId?, triggerStep?, coalesced?}`
— never step content. That keeps every event far inside `maxEventBytes` and
leaves the store as the single place content lives.

## Pacing

`delay(0) = 0`; `delay(n >= 1) = min(baseMs * factor^(n-1), capMs)`.
Defaults: `baseMs 5_000`, `factor 2`, `capMs 300_000`, `hold 3`,
`thoughtCapMs 60_000`.

| wake class | outcome | level | ticks | decision |
|---|---|---|---|---|
| `reactive` / `bootstrap` / `manual` | any | `0` | `0` | `arm(0)` |
| `spontaneous` | `visible` | `0` | `0` | `arm(0)` |
| `spontaneous` | `thought` | `ticks+1 >= hold` -> `level+1` | `(ticks+1) mod hold` | `arm(min(delay(level'), thoughtCapMs))` |
| `spontaneous` | `empty` | `ticks+1 >= hold` -> `level+1` | `(ticks+1) mod hold` | `arm(delay(level'))` |
| `spontaneous` | `error` | `level+1` immediately, no dwell | `0` | `arm(delay(level'))` |
| `watchdog` | `visible` | `0` | `0` | `arm(0)` |
| `watchdog` | otherwise | as `spontaneous` | as `spontaneous` | as `spontaneous` |
| any | `noop` | unchanged | unchanged | **`unchanged` — leave the running timer alone** |
| any | any, at `maxWakesPerHour` | `parked: 'rate_fuse'` | unchanged | **`unchanged`** plus a `mind-error` step |

`unchanged` is the subtlest requirement in the ladder: re-arming on a no-op
silently resets the backoff on every outgoing reply.

**Cost model.** The model-independent metric is *spontaneous wakes per hour
while idle*: 12/hr at `capMs = 300_000`, 6/hr at 600 000, both measured with
the ladder fully descended. A day that starts from engagement costs more,
because the descent is real spend — `npm run mind:pacer:eval` reports the
24-hour average beside the steady rate for exactly that reason.

**The fuse** is `ceil(3_600_000/capMs * 1.5) + hold * levels` when
`maxWakesPerHour` is not stated — 39 on the shipped defaults. Deriving it from
the steady-state term alone parked a default-configured mind under eight
minutes into every quiet period, so the documented 12/hr steady state was a
state the shipped default could never occupy.

**The work probe** computes the outcome from two bounded filtered tails, never
from a parse of model output. A new visible step is `visible`, a new thought is
`thought`, neither is `empty`, and a throw is `error`. Engagement is defined by
visible effect: "nothing changed" is a thought, not work.

## Liveness and health

ONE always-alive tick with two duties. A spawned per-step timer is a failure
mode; an always-alive loop that owns an injected clock is not.

- The **pace duty** is EDGE triggered on `nextWakeAt`. A `wakeAt` the pacer
  deliberately left alone is in the past forever, and a level-triggered duty
  would republish it every grid slot.
- `dispatchedWakeAt` is stamped at DELIVERY, never at publish. A publish that
  never became a delivery stays due.
- A **parked** thinker has no pace duty at all. `parkedUntil` is the first
  moment the fuse can read differently, and the runtime arms exactly one
  re-evaluation there — never none (which would need the watchdog to un-park)
  and never one per tick (which would make the spend ceiling the highest spend
  rate the mind can reach).
- The **watchdog duty** synthesizes `ax.mind.idle` after a quiet-while-free
  window. Running or deferred work refreshes it, so a long agentic run never
  ends in a spurious wake.
- A mind runs **one event worker per thinker**, not the runtime's pool
  default. A wake is pinned to `instanceKey = thinker`, so extra workers can
  only contend for the same deliveries, and the measured consequence of that
  contention is a claim going stale mid-model-call and aborting a run that was
  doing nothing wrong.
- The step's **settle** — the work probe AFTER, the outcome step and the pace
  decision — runs once per delivery, from whichever of three places gets there
  first: the run itself, a trailing `mind-settle` sink installed after the
  thinker's own sinks, or the tick's reaper. A thinker whose effect IS a sink
  (the shipped responder replies from one) would otherwise have every answering
  wake recorded as `idle`, because sinks run after `forward` resolves.
- A delivery that terminalises with no pace decision — a dead-lettered context
  assembly, a settle that throws, a delivery abandoned between assembly and
  forward — re-arms **one** wake at the thinker's own `capMs`, and the tick's
  reaper releases its in-flight record. The arm is a runtime guarantee, so a
  throw anywhere in the orchestration degrades to a delay, never silence.
- The two typed projection failures — `AxTrajectoryRollupError('meta_conflict')`
  and `AxTrajectoryQueryError('unsupported_types')` — dead-letter the delivery
  BEFORE any model call, and the thinker still wakes again.
- A wake that fails past its attempt budget appends NOTHING -- nothing ran --
  so `deadLetters()` is the only place a host can see one.
- Every liveness bug degrades to a `<= watchdogMs` delay, never a dead mind. A
  hung step holds the watchdog off — long runs are legitimate — but is bounded
  by its own `maxWallClockMs`.

**Health is LAG**, newest appended versus newest processed, and never liveness.
`health().state` reports `stalled` while every handle in the process is alive,
which is exactly the blindness a "the loop is running" check cannot detect. The
stalled threshold is `2 * max(watchdogMs, capMs)` derived from the HOST'S real
windows, because a constant derived from the defaults would read a legitimate
quiet period as a stall. Health is derived and never persisted: a persisted
health number is a lie waiting to happen.

## Chat semantics

Exactly one reply per inbound message, or a recorded decline, through five
layers: `replyTo` stamped at the transport, the positional net, the TTL'd
claim, the recorded `decision` observation, and a reply-state check at the send
site itself.

Outbound chat is reached through `mind.chatAs(thinker)`, so a reply and a
recorded decision carry the identity of the thinker that composed them rather
than whichever thinker happened to be first in the table -- the resolution
table below reads that identity to decide whose claim a decline can cancel.
`mind.chat` is the mind-level handle, for a host that is not a thinker.

`axResolveMindReplyState` answers the FACT ("has this been answered"), never
the JUDGMENT ("does it need a reply"). The rows are a PRIORITY order:

| # | Evidence after the trigger | Result |
|---|---|---|
| 1 | an outbound `message` from us with `replyTo === trigger.stepId` | `answered` |
| 2 | a SETTLED `mind.chat.send` effect under the trigger's key | `answered` |
| 3 | our `observation` with `decision: 'replied'` | `answered` |
| 4 | our `observation` with `decision: 'no-reply'` | `declined`, sticks across redelivery |
| 5 | any outbound `message` from us to that sender after it | `answered` |
| 6 | a `reply-claim` still inside its TTL | `claimed` |
| 7 | a claim past its TTL, or with an unreadable time | ignored, `failedOpen: true` |
| 8 | none of the above | `unanswered` |

- "From us" is the HOST-STAMPED writer identity (`selfSources`), never
  `data.from`, which the remote party controls. A correspondent who could make
  `data.from` equal the mind's own name would otherwise be able to mark their
  own message answered and silence the mind forever.
- The runtime passes EVERY thinker name as `selfSources`, so a sibling
  thinker's outbound reply still satisfies the positional net.
- The claim fails OPEN. An unreadable or expired claim counts as stale, because
  a retry is safer than a dropped message.
- Two mirrored exceptions keep the concurrent case correct: a LOSER's claim is
  inert (it cannot be retracted, so a rule that let any live claim block would
  deadlock the winner behind the loser), and a decline recorded by ANOTHER
  thinker cannot cancel the reply of the thinker holding the winning claim.
- The idempotency key is
  `'ax.mind.chat:' + sha256(identityScope + ' ' + to + ' ' + (replyTo ?? claimId))`.
  The disjunction is load-bearing: a per-attempt `claimId` inside a key that
  also carries `replyTo` makes the key per-attempt and destroys the
  cross-attempt dedupe the whole design depends on.

## Salience injection

An inbound message that arrives while a subscribed thinker is mid-run is
offered once, GLOBALLY by source step — the block runs once per busy subscribed
thinker, and N subscribers meant N identical injections of one message.

Two costs, stated rather than hidden:

- The wrapped tool call **does not execute**. `guideAgent` throws
  `AxAgentProtocolCompletionSignal`, so the turn ends with the guidance
  appended for the next iteration and the actor has to make that call again.
  The price is one aborted tool call; that is the cost of using the only
  in-flight steering seam ax has.
- A turn that calls **no** host function never sees mid-run salience. Coverage
  is best-effort mid-run and guaranteed at the next step, because the item
  stays in the buffer and the next projection includes the message. The
  alternative — interrupting a running actor — is worse, and ax deliberately
  has no such seam.

Third-party text is fenced and byte-bounded inside the guidance: it lands in a
channel whose other sentences are imperatives to the actor, so it is labelled
as data and clipped, and the `feedback` step recording the injection is
`wakeable: false` so it can never re-dispatch the run it was injected into.

## Authority

**Host-owned — unreachable from any thinker program, by construction:**

1. Trajectory contents. There is no update, delete, rewrite or compact method
   on the store or on `AxMind`; `append` stamps the writer itself.
2. The step-type registry, including `stepClass`, `wakeable`, `carriesSource`
   and `neverRetriggersSelf`.
3. The route table and subscriptions. Routes are fixed at runtime
   construction; `reloadArtifacts()` explicitly does not touch them.
4. Authority grants. Identity comes from the authenticating source, and
   authority-looking step data is ignored.
5. The transport's `selfName` and the transport itself.
6. The effect ledger. The mind declares and settles effects; terminal
   settlement is immutable.
7. Budgets: `AxMindThinkerBudget`, `AxAgentSessionLimits`, `kernelTokenBudget`.
8. The pacer config, the rate fuse, and the watchdog window.
9. Rollup provenance stamps and the artifact `revision`.
10. Its own restart. `AxMind.close()` is not a tool, and it is refused while a
    thinker step is running.

**Model-owned — genuine self-authorship, all of it host-mediated:** what to do
next (the function menu, with routing signals as HINTS and no hardcoded
priority ladder — that is how you get stuck loops); its memories, through
`memoriesCatalog` / `onMemoriesSearch`; its goals and values as `AxMindGoal`
records using `AxACEBulletLifecycle` vocabulary verbatim, written only through
`AxMindArtifactSource.write` with an out-of-band receipt; which skills are in
its kernel; whether to reply, with `NO_REPLY` recorded rather than dropped; and
its own prompt artifacts, again only through a receipted write.

Approval never derives from the same model text being evaluated. That is the
`AxRuntimeAdmissionReceipt` precedent, and it is why the `goals` tool records a
proposal instead of applying one.

## Crash matrix

| # | Kill point | Recovery | Verdict |
|---|---|---|---|
| C1 | before `append` returns | the step never existed; if it was a wake trigger the chain is broken | **the watchdog covers it**: `<= watchdogMs` delay, never a dead mind |
| C2 | after the blob write, before the step line | a host GC sweeps unreferenced blobs | harmless; a dangling ref is impossible |
| C3 | mid-`append` (torn line) | tolerant parse drops the partial frame and counts it | fails closed on the frame, open on the log; never glued |
| C4 | after append, before the source publishes | the per-consumer durable cursor republishes | at-least-once publish, exactly-once dispatch by the event store's dedupe |
| C5 | after publish, before the claim | a restarted worker claims normally | clean |
| C6 | during a thinker step, after the claim | the lease expires; a worker takes over with a higher fencing token; the stale reply-claim fails open | O3 |
| C7 | after `declareEffect`, before `markEffectDispatched` | nothing left the process, so a retry is safe | clean, one send |
| C8 | after `markEffectDispatched`, before the transport returned | the effect stays `dispatched` for a resolver | **fails closed**: a thrown call is not proof of failure |
| C9 | after the transport returned, before `settleEffect` | the same key returns the original record, so a second declare cannot re-dispatch | **fails closed on double-send** |
| C10 | after `settleEffect`, before the message step | `reconcile()` replays settled sends with no matching step | **the log converges to the ledger** |
| C11 | after the outbound step, before the decision observation | answered-ness comes from the `replyTo` fact alone | clean; the observation is a convenience |
| C12 | between the run outcome and arming the pacer | `axRecoverMindPacerState` rebuilds level and ticks from the log | **recoverable from the autobiography** |
| C13 | during rollup sealing | sealed blocks are immutable and index-keyed; the frontier recomputes | idempotent per summarizer |
| C14 | cursor beyond end / identity changed / store shrank | `AxTrajectoryCursorError` pauses THAT consumer and reports | **fails closed, loudly** |

Rows C1–C3 and C14 are proved by `npm run trajectory:durability:eval`; rows
C4–C14 by `npm run mind:durability:eval`.

## What this does NOT promise

- **Sends are not exactly-once.** A transport call that throws leaves the
  effect `dispatched`; it is never re-dispatched blind, and the message is
  missing from the log until a resolver settles it. The durability evaluation
  reports that gap as a number rather than hiding it.
- **A hung step holds the watchdog off.** Long runs are legitimate; the step's
  own `maxWallClockMs` is what bounds it.
- **Salience is invisible to a turn that calls no host function**, and costs
  one aborted tool call when it does fire.
- **One timeline means no walls between people.** Assume anything told to the
  mind is shared with everyone who talks to it.
- **The mind never fully sleeps.** The idle wake rate is bounded by `capMs` and
  never reaches zero: a mind that never wakes scores perfectly on cost and has
  stopped existing.
- **`close()` is refused from inside a thinker's own tool call, and nowhere
  else.** `close()` is not a tool and never will be; `runThinkerTool` is the
  second layer under that. A step counter cannot do this job: a paced mind is
  never idle by construction, so `waitForIdle()` is NOT its shutdown path and
  refusing every close while a step ran would make a persistent mind
  unclosable.
- **A sink's work IS counted, one layer later.** The mind installs a trailing
  `mind-settle` sink after the thinker's own sinks, so a reply written from a
  sink moves the work probe of the wake that produced it. The runtime dispatches
  final sinks only when the run produced an output, so a run that threw settles
  inline instead, and the tick's reaper settles anything neither path reached.
  What is still true: a sink that fails is dead-lettered by the runtime and the
  mind continues to the next sink.
- **The ownership lease has no TTL.** `AxInMemoryMindOwnershipStore` is
  process-local, and `close()` releases the lease; a durable ownership store
  that outlives a crash needs a host-side lease expiry.

## Evaluations

```bash
npm run mind:pacer:eval        # pacing, against AxTimerEventSource at intervalMs = capMs
npm run mind:durability:eval   # crash rows C4-C14, with fault injection
```

> This is a deterministic zero-cost mechanism evaluation with fault injection.
> It is bounded machinery evidence — pacing, liveness, idempotency, projection
> shape and size, store conformance, and crash classification. It is not a
> held-out model comparison. It says nothing about whether the mind thinks
> well, chooses good routes, or writes useful memories, and no claim of that
> kind is made.

Where the pacing helps: engagement is answered in 0 ms where a timer at
`intervalMs = capMs` cannot react sooner than its own interval, and the fuse is
an absolute spend ceiling a timer has no way to express. Where it does not: a
permanently idle mind at `cap = intervalMs` costs slightly MORE than that timer
over a day, because the descent from cold is real spend. The gate refuses any
row that claims otherwise.

## Line budgets

`src/ax/mind/budget.test.ts` asserts a non-blank line cap per production file
and a ceiling for the directory. RFC 5.1 estimated 2,970 lines against a 3,050
ceiling; the shipped total is higher, and each raise has a reason:

| file | cap | reason |
|---|---|---|
| `types.ts` | 615 | the context-request record, the whole artifact source with its change and receipt records, and the in-memory ownership store — RFC 4.9/4.10 declarations the pacing lane deferred for want of a consumer; then the `wake-suppressed-sibling` diagnostic code and the loop its absence hides |
| `pacer.ts` | 300 | the fuse derived from the descent cost, plus `parkedUntil` |
| `health.ts` | 150 | the derived stalled threshold |
| `routes.ts` | 320 | the `wake-suppressed-self` diagnostic (a suppressed wake creates no delivery and no step, so nothing else can see the decision), then `axMindSiblingWakeSuppressed` and the sibling branch of the route predicate that close the unbounded two-thinker `idle` runaway |
| `sources.ts` | 610 | two `AxEventSource`s, the pure duty query, per-consumer cursor load/save, unit-commit planning, and a sleep that leaves no listener behind |
| `chat.ts` | 800 | the ledgered send is declare → dispatch → transport → settle with a branch per non-`intent` status, plus `axMindReconcileChatSends` |
| `salience.ts` | 180 | the fenced, byte-bounded quoting of third-party text |
| `skills.ts` | 150 | as estimated |
| `context.ts` | 160 | new: the pure wake classification, synthetic trigger and routing-signal table, extracted so the hint policy is reviewable without the runtime |
| `step.ts` | 180 | new: a thinker rendered as an `AxEventTarget`, the delegating `AxProgrammable` wrapper that brackets one run, and the trailing `mind-settle` sink |
| `subruns.ts` | 150 | new: fork → run → merge with the depth and spend caps, plus the bound on an unsummarized merge content |
| `thinkers.ts` | 560 | the monolith, the responder, `AxMindDeterministicProgram`, the function menu and the prompt assembly |
| `mind.ts` | 1_450 | RFC 5.1 gives this file five deliverables at once and none of the surface they need: the options record is 90 lines, the start sequence is seven steps with five typed refusals, and the context assembly carries the dead-letter path M19 depends on. The review raise adds the idempotent delivery-keyed settle, the liveness-fallback arm (M7 layer (b)), the tick's reaper and the named sub-run owner |
| `index.ts` | 175 | the barrel grew with the runtime |

The DIRECTORY ceiling is **5,650** non-blank production lines against RFC 5.1's
3,050. That is a real miss against RFC 11's definition of done, stated here
rather than left to be discovered: the estimate costed the declaration surface
and the shipped files carry the implementation too, at 80 columns with a doc
comment on each non-obvious policy. Raising either again needs the same
treatment: a reason per file, here and in the cap table.

## Conformance fixtures

`ir/conformance/axmind/{pacing-ladder,reply-resolution,projection-staircase,dispatch-decisions}.json`
are **TypeScript-consumed in v1**. `conformanceSuitePaths`
(`tools/axir/internal/axir/verify.go`) enumerates a hardcoded list of
directories that does not include `axmind`, so the five generated targets do
not read them; `src/ax/mind/fixtures.test.ts` is what runs them.

`ir/conformance/axevent/mind-wake-source-routing.json` IS portable, and pins
only what the Core IR matcher can express. `event_route_commands`
(`ir/axcore/event.axir`) matches on `sources` and `types` alone — there is no
subject matching, no extension matching and no `authorize` predicate in the
portable layer — so the mind's self-suppression is pinned in TypeScript by
`src/ax/mind/routes.test.ts` instead. A fixture claiming to cover it would be a
fixture nothing runs. Both gaps are filed in the AxIR backlog.
