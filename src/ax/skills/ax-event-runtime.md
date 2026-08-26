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
- The in-memory store is volatile and single-process.
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
