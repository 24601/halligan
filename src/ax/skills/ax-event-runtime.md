---
name: ax-event-runtime
description: Use AxEventRuntime to ingest events, explicitly wake or resume AxGen, AxAgent, and AxFlow, persist state and results, and route outputs safely.
---

# Ax Event Runtime

Use this skill when an Ax program should react to notifications, webhooks,
timers, queues, task completion, or application events.

## Host-owned authority

`AxEventRuntimeOptions.authority` optionally resolves host-verified authority
for each delivery. When configured, Ax authorizes exact route/target/sink
operations, binds tenant scope to verified ingress identity, and propagates the
context into target programs and their tools. Authority-looking event data is
ignored. Sink dead-letter redrive resolves authority again and requires a
current `event.sink.write` receipt. Resolver waits are abortable and bounded;
rejection or cancellation cannot leak `activeRuns` or wedge `close()`. The
callback is absent by default, preserving existing behavior. See
`docs/HOST_AUTHORITY.md` for grants, receipts, attenuation, and limitations.

## Mental Model

```text
source -> inbox -> route -> target -> stored run -> sink
```

Sources never call an Ax program directly. A route must explicitly choose
`observe`, `invalidate`, `wake`, or `resume`. Only the last two invoke a model.

`AxInteractionTimeline` is a separate, opt-in record for bounded temporal
projection of crossmodal interaction observations. It does not enqueue events,
wake programs, estimate clock offset, or establish semantic alignment. See
`docs/INTERACTION_TIMELINE.md` when an application needs that lower-level
timeline contract before deciding whether to publish anything to this runtime.

## Minimal Pattern

```ts
const source = new AxPushEventSource('application');
const target = eventTarget('triage')
  .program(triageAgent)
  .ai(llm)
  .input((input) => input.field('incident', eventPath.data()))
  .sink({ id: 'result', write: saveResult })
  .build();

const events = eventRuntime({
  sources: [source],
  routes: [
    eventRoute('incident-created')
      .types('incident.created')
      .wake(target)
      .build(),
  ],
});

await events.start();
await source.publish({ event, identity, trust: 'authenticated' });
```

## Rules

- Supply identity from authenticated adapter state, never from event data.
- Treat events without verified identity as anonymous and untrusted.
- Map event data into signature inputs; do not synthesize a user message.
- Use `eventPath.data('field')` and other segment-safe selectors. Do not use
  dotted JSONPath strings or repurpose `s()` as a mapping language.
- Use `.project(path)` only for same-name signature projection. Explicit
  `.field()` mappings override projection; missing or invalid signature inputs
  dead-letter before model invocation.
- Use `eventInput().project(...).field(...)` when a declarative mapping should
  be callback-free and reusable, then pass that plan to `.input()`,
  `.wakeInput()`, or `.resumeInput()`.
- Callback `mapInput` is an escape hatch, not a validation bypass: its result is
  normalized to the program signature and mapper failures dead-letter before
  invocation.
- Use `.wakeInput()` and `.resumeInput()` when the two actions need different
  contracts. Neither action silently uses the other action's mapping.
- Use `observe` for progress/logs and `invalidate` for catalog changes.
- For proactive demand evidence, connect `AxDemandBoundary` through
  `axDemandEventObserver(...)` on an `observe` route. Treat every disposition,
  including `act`, as an advisory proposal. Host authorization and effect
  settlement remain separate and mandatory.
- Keep detector free text and reason codes non-authoritative. Proposal reason
  codes are boundary-owned policy classifications. Retain explicit `no_demand`
  and `uncertain` records; downgrade stale, conflicting, low-confidence,
  malformed, or revoked-grant evidence instead of silently dropping it.
- Detector confidence estimates demand probability; it is not authority. Require
  `ignore` or `annotate` in host disposition allowlists so fallback remains
  fail-closed.
- Callbacks receive deeply frozen copies while a separate canonical clone is
  retained. Route, instance, principal, and boundary scope wraps every local
  dedupe key even when a custom mapper supplies the observation.
- Host observations and detector outputs are read once into plain snapshots;
  validation, byte measurement, and retention use the same frozen values.
- Detector ID, version, and callback are captured once at construction and bind
  boundary identity, callback `this`, and retained detector metadata.
- Keep callbacks within the configured timeout and propagate runtime
  cancellation as cancellation, not successful uncertainty. One boundary
  single-flights a scoped key with per-waiter cancellation and bounded pending
  keys/bytes; distributed hosts need reservations for callback-level
  exactly-once behavior.
- Bind stateful host methods before passing them as standing-grant callbacks;
  the boundary snapshots and invokes the callback without using itself as the
  receiver. Policy disposition arrays are copied at construction.
- Timed-out or cancelled callback promises retain count and evidence-byte
  reservations until they settle. Transient keyed work and unsettled callbacks
  use separate per-class `maxInFlight`/`maxInFlightBytes` ceilings. Use a
  terminable worker/process boundary if capacity must be recoverable from an
  abort-ignoring callback.
- Observe options and scope fields are captured once. Provenance polarity is
  limited to `supports`, `contradicts`, or `neutral`.
- Detector latency metrics are finite and nonnegative. Extreme or reversing
  clocks clamp to the safe-integer range and set `detectorLatencyCapped`; do not
  treat capped samples as exact durations.
- Use a host `AxDemandStore` for durable/distributed cursor and dedupe
  guarantees. `AxInMemoryDemandStore` is volatile; its snapshots are suitable
  for deterministic restart tests, not a durable service. Seed cursors are
  numerically ordered for pagination; seed cursors and dedupe keys must be
  unique. Custom stores must atomically check the signal passed to `append`
  immediately before commit and retain no new record when it is aborted.
- Bound retention explicitly. In-memory defaults are 10,000 records, 64 MiB,
  1,000 scopes, 1,000 records per scope, and seven days; eviction removes the
  corresponding dedupe key.
- Treat dedupe keys as immutable observation identities. Proposal expiry does
  not reopen an event key; duplicate receipts are historical, and a new
  observation needs a new host key.
- Minimize and redact observations before detection, lower the 1 MiB
  observation and 64 KiB detection defaults when practical, and enforce host
  privacy/retention policy on the backlog.
- Use `resume` only with an owned continuation correlation key. The store
  atomically admits it to one fenced delivery, then snapshots the same binding
  on the run before invocation. Retry, delivery/sink redrive, and recovery use
  that immutable continuation, target, and instance rather than looking up a
  reused key. Successful terminalization atomically saves the delivery and
  consumes/de-keys its admitted continuation; split completion is forbidden.
  Stores without both atomic boundaries and malformed legacy bindings fail
  closed.
- Use `createProgram(instance)` for stateful multi-tenant Agents.
- Declare `retrySafety: 'idempotent'` only when stable delivery keys protect
  every possible side effect.
- Declare `retrySafety: 'effect-aware'` only when every external effect is
  wrapped by the ledger; this keeps existing unknown and idempotent target
  policies unchanged while applying per-effect recovery to that target. Runtime
  startup rejects this mode when the store does not implement the effect ledger.
- For effect-level recovery, application/tool code must call
  `eventContext.declareEffect(...)` before I/O, call
  `markEffectDispatched(effect.id, effect.version)` immediately before crossing
  the dispatch boundary, and call `settleEffect(...)` with the returned version
  only after a conclusive receipt.
- A thrown transport call is not proof of effect failure. Leave it dispatched
  so recovery classifies it as indeterminate.
- Set effect `replaySafety: 'idempotent'` only when the external provider
  enforces the stable key. Otherwise unresolved dispatch parks even when the
  target itself is retryable.
- A store fence cannot stop a network call already allowed to leave the process.
  Pass `eventContext.fencingToken` to domain systems that enforce fences; without
  that, provider idempotency, or a definitive resolver, park the outcome.
- Use `effectResolver` for an authoritative domain lookup. Return
  `succeeded`, `failed`, `not_dispatched`, `indeterminate`, or `parked`; resolver
  errors, the bounded `effectResolverTimeoutMs` timeout, and non-idempotent
  indeterminate outcomes fail closed to parked. Resolver timeout/shutdown wins
  even if host code ignores its abort signal. Resolvers are read-only; Ax ignores
  a late result but cannot terminate JavaScript that ignores abort.
- Treat effect metadata as the redacted request descriptor. Ax persists a
  canonical request digest and rejects the same operation/key when that
  descriptor or replay safety changes; include every non-secret parameter that
  must be bound to reuse.
- Redact effect metadata/receipts before persistence. The runtime bounds them
  but cannot detect secrets or intercept arbitrary I/O.
- Only `succeeded` and `failed` effects are receipt-complete. `intent`,
  `dispatched`, and `parked` block successful completion. The ledger and
  exclusive admission are additive to host authority, verifier transitions,
  and component lifecycle ownership; unknown target recovery remains
  `outcome_unknown`.
- Persist outputs before final sink delivery; redrive sink failures separately.
- For bounded autonomous attempts, attach a host-owned `.verifier(...)`. Its
  callback runs only after output persistence; failed evidence is bounded and
  resumed through an owned continuation, while pass alone releases final sinks.
- Verifier targets are non-streaming and require a store advertising the fenced,
  atomic `axevent-verifier-transition-v2` handoff. The transition replaces the
  parent with its child for capacity accounting and carries chain state through
  the owned continuation. Its immutable operation journal stores only SHA-256
  commitments to the canonical request and deterministic child plus a minimal
  receipt; it never duplicates payloads or verifier state. Confirmation
  requires the complete fenced request. SQLite commitments outlive payload
  retention, and V2 migration securely removes legacy full journal rows. A
  durable cleanup marker makes later startups finish WAL checkpoint/truncation
  after a migration-time crash. These semantics are SQLite event schema v4;
  subsequent migrations must build from verifier-v4 without reusing its schema
  versions or capability marker. This does not make arbitrary external I/O
  exactly once.
- Set explicit verifier run/token/wall-time/cost limits. Exhaustion, verifier
  error/timeout, and unchanged fingerprints fail closed; abort stays cancelled.
  Accepted `cancelRun` during an in-flight V2 transition rejects the store
  handoff after commitment awaits and does not install or run the child.
- Host `usage`, `fingerprint`, and `verify` callbacks share timeout and abort
  handling. Outputless clarification waits bypass verification.
- Compute verifier fingerprints from all relevant deterministic host state.
  An unchanged post-failure fingerprint suppresses the repeated verifier call
  and loop. The target never receives the verifier callback itself.
- Use `debounceMs` and `coalesce: 'latest'` only when replacing intermediate
  events is part of the route's declared policy.
- Observe source failures with `onSourceError`.
- `close({ timeoutMs })` uses one overall deadline for source close, drain,
  workers, and store settlement; concurrent calls join one shutdown. Its native
  timer is independent of `AxManualEventClock`. Ax best-effort requests
  `return()` on active streams, swallows sync/async cancellation failures, and
  suppresses post-abort chunks. This is return-bounded only: non-cooperative
  host work may continue and perform later side effects; use cooperative abort
  or a host revocation check before writes. Ax revokes its own persistence,
  sinks, effect context calls, continuation registration, and claim heartbeat
  after abort/store shutdown. In-flight publishes recheck the composed shutdown
  signal after async route callbacks and before abort-aware enqueue. In-flight
  renewals are deadline-tracked and built-in stores recheck abort plus their
  closed epoch at the mutation boundary. After worker settlement or deadline,
  Ax independently attempts best-effort store close and suppresses its
  rejection; a permanently hung worker cannot prevent the attempt.
- The in-memory store is volatile and single-process.
  Waiting runtimes schedule claimed/running lease expiry and reclaim with a new
  safe fencing token instead of wedging expired work. Pass the same clock
  instance to runtime and store; the runtime adopts an exposed store clock when
  omitted and rejects different explicit clocks so lease authority stays in one
  time domain.
- For cooperating Node processes on one local disk, use
  `AxSQLiteEventStore` from `@ax-llm/ax-tools/event/sqlite` with explicit
  retention and `coordination: 'multi-worker'`. Never recommend SQLite on a
  network filesystem.
- Close the runtime and caller-owned protocol clients explicitly.
- Fan out to several Agents with several matching routes, not a multi-target
  route. This preserves independent authorization, ordering, retries, and runs.

## Trusted Live Components

Use `axEventComponentManager()` only for trusted, host-defined process-local
event integrations that need dependency-aware live activation and deterministic
cleanup. Definitions declare stable `id`, `version`, `dependencies`, and an
`activate(context)` callback. Acquire resources with
`context.acquire(label, setup)`, where setup returns `{ value, dispose }`, or
register an existing inverse with `context.addDisposer(label, dispose)` before
activation completes.

The manager serializes all graph transitions, activates dependencies first,
deactivates dependents first, rolls failed activation back in reverse order,
stages and atomically switches the active transitive dependent closure during
replacement, restores the complete prior graph on staged failure, and exposes
state, effects, diagnostics, and errors through `inspect()`. Repeated lifecycle
calls are idempotent. Inactive replacement stays inactive until explicit
activation. Disposal permanently includes the complete transitive dependent
definition closure. Abort is cooperative and detached after activation commits;
teardown invokes all registered cleanup in reverse order. `timeoutMs` bounds the
total cleanup wait; timeout records `disposer-timeout`, leaves state failed and
uncertain, and continues later cleanup. Late disposer registration is diagnosed
and rejected without invoking an untracked callback. Failed or otherwise
unsettled effect ownership fences both activation and replacement before new
setup runs, including non-active external dependencies introduced by active
replacement. A failed activation is retryable only when rollback terminally
disposed every registered effect.

Runtime close fences source startup before aborting in-flight activation. A
source handle returned after that abort is closed transactionally, and no later
configured source starts. Runtime close applies one deadline across component
cleanup, workers, authority/verifier callbacks, and redrives, so a throwing or
hanging source disposer cannot block the store-close boundary.

Do not describe this as reversal of arbitrary I/O. Unregistered effects and
failed disposers can leak, candidate setup is not externally isolated, and the
manager does not load or execute model-generated code, persist definitions,
watch files, auto-deploy mutations, or own caller-created protocol clients.

Run the fault-mechanism demonstration and adversarial boundary matrix with:

```bash
node --import=tsx scripts/evaluate-event-components.ts --iterations=200
```

The manual examples intentionally lack transaction machinery and are not a
semantics-equivalent benchmark. Repetitions check deterministic stability, not
schedule exploration; the separate matrix covers startup/close overlap, late
registration, replacement states, partial disposal, dependency snapshots,
abort boundaries, source handles, and startup/cleanup failures.

## Continuation Pattern

```ts
eventContext.registerContinuation({
  correlation: [{ kind: 'task', value: taskId }],
  expiresAt,
});
```

Route progress to `observe`. Route `input_required`, completed, failed, or
cancelled task events to `resume` when the owning program must run again.

### Retained child session continuations

When an event-driven AxAgent can admit retained children, expose
`root.functions({ eventContinuations: true })`. Its `sessions.spawn` and
`sessions.send` functions register a continuation owned by the current event
target under:

```ts
AxAgentSessionHost.continuationKey(handle)
// { kind: 'ax-agent-session', value: handle.id }
```

Publish terminal host `onEvent` notifications through an application-owned
event source with that correlation, then route completed/failed/cancelled/
interrupted events to `resume`. Do not store the continuation in the child
registry as a second authority: AxEventRuntime owns continuation identity
scope, persistence, expiry, and target restoration; the session host owns the
child lifecycle and mailbox. The in-memory adapters on either side remain
volatile.

The retained session functions defer scheduler dispatch until AxEventRuntime
has persisted the staged continuation. This is required even when the retained
scheduler dispatches inline: registering the callback before scheduling is not
enough because `registerContinuation(...)` is staged until the parent target
returns.

Recovery advances the retained tree's ownership epoch. Event handlers must
restore the root and refresh the correlated child's handle before operating on
it; a continuation may keep the stable child ID for correlation, but not an old
epoch-bearing capability handle.

Explicit snapshot restore likewise rotates destination epoch/capabilities and
pending job IDs; dispatch checks both epoch and job ID. Correlation IDs remain
stable, but source handles/jobs do not carry authority into the destination.

## Effect Pattern

```ts
let effect = await eventContext.declareEffect({
  operation: 'messages.send',
  idempotencyKey: `message:${messageId}`,
  replaySafety: 'idempotent',
  metadata: { messageId },
});

if (effect.status === 'succeeded') return effect.receipt;
if (effect.status === 'failed' || effect.status === 'parked') throw new Error();

effect = await eventContext.markEffectDispatched(effect.id, effect.version);
const receipt = await sendMessage(message, effect.idempotencyKey);
await eventContext.settleEffect(effect.id, effect.version, {
  status: 'succeeded',
  receipt: { providerId: receipt.id },
});
```

`intent` means not dispatched, `dispatched` means indeterminate without a
settlement, `succeeded|failed` means completed, and `parked` blocks automatic
dispatch. Duplicate `(delivery, operation, idempotencyKey)` intent returns the
original record. Fenced store transitions reject stale workers. This is a
durability classification protocol, not exactly-once execution. Effect versions
also reject concurrent mutation from a stale same-claim caller.

The SQLite store also binds retained event dedupe identities to canonical
envelopes, requires the current owner/token and an unexpired active lease for
delivery/run writes, and revalidates after awaited payload staging. Oversized
outputs require `AxEventStagedPayloadStore` plus explicit count, byte, payload,
TTL, and timeout limits. Host-assigned stage IDs make abort ownership-specific
even when content references are shared; restart reconciles `commit_pending`
before claims and run reads. Every unresolved stage state blocks claim;
staging/abort expiry marks its fenced delivery terminal before owned cleanup.
Malformed recovery rows are isolated so unrelated work and worker loops remain
live. Recovery atomically binds the persisted nonterminal `finalizing` run to
the delivery, then takeover resumes final sinks only; target invocation is never
repeated, and the run becomes `succeeded` only after sink effects are
receipt-complete. Resume admission is an exclusive fenced store transaction,
persisted on both delivery and run before invocation. Competing deliveries
cannot fire one continuation twice; delivery and sink redrive retain and
validate the original continuation/target/instance even after correlation
reuse, and sink redrive reacquires a delivery fence before exposing effects.
Terminal resume success atomically consumes/de-keys that admission with the
delivery update; rollback leaves the `finalizing` run for completion-only
recovery and never target replay. Legacy or malformed mismatched bindings fail
closed; legacy wake recovery keeps its configured-target fallback. A
never-invoked legacy resume delivery performs its first atomic admission under
the combined migration.
Live commit acknowledgement requires the current unexpired
owner/token. Failed reconciliation quarantines that delivery without stopping
unrelated claims. Legacy `put/delete` stores are never uploaded to
because they cannot safely reclaim a stale shared reference. Staging failure is
typed `AxEventOutputPersistenceError` and never repeats the completed target
call; runtime classification uses its `code`/`phase` discriminants across
package realms, not `instanceof`. This is bounded recovery across two stores,
not an atomic cross-store commit. Fencing fails closed at the JavaScript
safe-integer limit rather than wrapping.

Combined SQLite schema v7 migration classifies the actual verifier and effect
lineages under one immediate transaction, preserves their rows, installs the
complete journal/metadata, effect/fingerprint, payload-stage, and admission
schema, validates the result, and only then records version 7. Demand-boundary
records and temporal interaction timelines are not persisted by the SQLite
event store.

## MCP Adapter

Use `ax-mcp` for client construction, transports, authentication, catalogs,
subscriptions, tasks, and MCP-specific security policy. This skill owns the
generic inbox, routing, continuation, store, and sink behavior.

Use `client.inspectCatalog()` to discover server-owned tools, prompts, concrete
resources, and URI templates from only the endpoint. Then use
`AxMCPEventSource({ client, resourceSubscriptions, identity, trust })` with an
explicit none/all/URI/selector policy. Omitted policy subscribes to no
resources. Templates are never expanded automatically. Managed sources diff
catalog changes, restore current logical ownership on reconnect, and release
only their own subscriptions on close. Identity must come from the
application's authenticated client or token mapping; a bare MCP session is
anonymous. Add `...axMCPEventRoutes({ client })` for catalog invalidation,
progress/log observation, and task resume. Resource notifications never get an
implicit wake route. See `docs/MCP_SUBSCRIPTIONS.md`.

## UCP Adapter

Use `AxUCPWebhookEventSource({ client, identity })` inside an application-owned
HTTP handler, then call `source.ingest(request)`. Verification of the signer
profile, RFC 9421 signature, digest, freshness window, key rotation, and replay
key completes before enqueue. Resolve tenant/account identity from application
state after verification; do not copy identity from the business payload.

Generated Python, Java, C++, Go, and Rust packages expose the same Core-owned
single-worker event state machine plus functioning inline lifecycle dispatch,
continuations, state restoration, cancellation, persisted outputs, isolated
sink redrive, signature-aware path/input/target/route builders, and host-owned
source, sink, clock, and store boundaries. Generated targets use the host
signature plus a typed invocation callback when no common object-safe program
interface exists. Do not claim persistent multi-worker support from
`axevent.single-worker` alone.

Generated runtimes do not create worker threads. `publish()` drains work due at
`clock.now()`. Hosts use `nextDueAt()` to schedule `runDue()` for debounce,
retry, and continuation expiry; `redrive()` is due immediately. Manual clocks
make these transitions deterministic. Generated in-memory stores enforce
10,000 pending deliveries, 64 MiB queued data, 1 MiB per envelope, and a
five-second publication wait.

## Testing

Use `AxManualEventClock`, `AxInMemoryEventStore`, deterministic event IDs, and
an output-capturing sink. Assert that unmatched or observe-only events never
invoke the program, tenant scopes do not collide, outputs exist before sinks,
and uncertain side effects become `outcome_unknown`.

For advisory demand policy, run `npm run event:demand:eval`. Its deterministic
mechanism fixture compares reactive and naive-threshold baselines and reports
fixed confusion counts, calibration, false fires/suppression, measured callback
counts/latency/bytes, and negative results. It is not an independent model
held-out set or an improvement claim.

Persistent store implementations must pass
`runAxEventStoreConformance(createStore, { clock })`. A store must not advertise
multi-worker capability without the conformance marker checked by runtime
startup.

Run `npm run event:effects:eval` for the reproducible SQLite process-crash,
restart, resolver, stale-fence, concurrency, legacy-comparison, latency, and
storage evaluation. Run
`npx vitest run scripts/event-effects-fault-eval.test.ts` for its assertions.
