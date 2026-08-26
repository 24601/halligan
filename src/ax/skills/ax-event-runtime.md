---
name: ax-event-runtime
description: Use AxEventRuntime to ingest events, explicitly wake or resume AxGen, AxAgent, and AxFlow, persist state and results, and route outputs safely.
---

# Ax Event Runtime

Use this skill when an Ax program should react to notifications, webhooks,
timers, queues, task completion, or application events.

## Mental Model

```text
source -> inbox -> route -> target -> stored run -> sink
```

Sources never call an Ax program directly. A route must explicitly choose
`observe`, `invalidate`, `wake`, or `resume`. Only the last two invoke a model.

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
- Use `resume` only with an owned continuation correlation key.
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
- Persist outputs before final sink delivery; redrive sink failures separately.
- Use `debounceMs` and `coalesce: 'latest'` only when replacing intermediate
  events is part of the route's declared policy.
- Observe source failures with `onSourceError`.
- `close({ timeoutMs })` uses one overall deadline for source close, drain,
  workers, and store settlement; concurrent calls join one shutdown. Its native
  timer is independent of `AxManualEventClock`. Ax best-effort requests
  `return()` on active streams, swallows sync/async cancellation failures, and
  suppresses post-abort chunks. This is return-bounded only: non-cooperative
  host work may continue and perform later side effects; use cooperative abort
  or a host revocation check before writes.
- The in-memory store is volatile and single-process.
  Waiting runtimes schedule claimed/running lease expiry and reclaim with a new
  safe fencing token instead of wedging expired work.
- For cooperating Node processes on one local disk, use
  `AxSQLiteEventStore` from `@ax-llm/ax-tools/event/sqlite` with explicit
  retention and `coordination: 'multi-worker'`. Never recommend SQLite on a
  network filesystem.
- Close the runtime and caller-owned protocol clients explicitly.
- Fan out to several Agents with several matching routes, not a multi-target
  route. This preserves independent authorization, ordering, retries, and runs.

## Continuation Pattern

```ts
eventContext.registerContinuation({
  correlation: [{ kind: 'task', value: taskId }],
  expiresAt,
});
```

Route progress to `observe`. Route `input_required`, completed, failed, or
cancelled task events to `resume` when the owning program must run again.

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
live. Recovery atomically binds the persisted succeeded
run to the delivery, then takeover resumes final sinks only; target invocation
is never repeated, and resume-route sinks retain the admitted continuation.
Live commit acknowledgement requires the current unexpired
owner/token. Failed reconciliation quarantines that delivery without stopping
unrelated claims. Legacy `put/delete` stores are never uploaded to
because they cannot safely reclaim a stale shared reference. Staging failure is
typed `AxEventOutputPersistenceError` and never repeats the completed target
call; runtime classification uses its `code`/`phase` discriminants across
package realms, not `instanceof`. This is bounded recovery across two stores,
not an atomic cross-store commit. Fencing fails closed at the JavaScript
safe-integer limit rather than wrapping.

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

Persistent store implementations must pass
`runAxEventStoreConformance(createStore, { clock })`. A store must not advertise
multi-worker capability without the conformance marker checked by runtime
startup.

Run `npm run event:effects:eval` for the reproducible SQLite process-crash,
restart, resolver, stale-fence, concurrency, legacy-comparison, latency, and
storage evaluation. Run
`npx vitest run scripts/event-effects-fault-eval.test.ts` for its assertions.
