# Ax Event Runtime

`AxEventRuntime` connects external events to Ax programs without coupling the
program to a transport or invoking a model inside a notification callback.

```text
source -> inbox -> route policy -> AxGen / AxAgent / AxFlow -> stored run -> sink
```

The runtime is opt-in. Constructing an Ax program does not start listeners,
timers, or background model calls. Events start a program only through an
explicit `wake` or `resume` route.

## Quick Start

```ts
import {
  AxPushEventSource,
  eventRoute,
  eventRuntime,
  eventTarget,
  eventPath,
} from '@ax-llm/ax';

const source = new AxPushEventSource('orders');
const target = eventTarget('order-agent')
  .program(orderAgent)
  .ai(llm)
  .input((input) =>
    input
      .project(eventPath.data())
      .field('orderId', eventPath.data('orderId'))
  )
  .sink({
    id: 'results',
    write: (result, { run }) => saveResult(run.id, result),
  })
  .retrySafety('idempotent')
  .build();

const runtime = eventRuntime({
  sources: [source],
  routes: [
    eventRoute('new-order')
      .types('commerce.order.created')
      .authenticated()
      .instanceKey(eventPath.subject())
      .wake(target)
      .build(),
  ],
});

await runtime.start();
await source.publish({
  event: {
    specversion: '1.0',
    id: 'evt-42',
    source: 'https://orders.example',
    type: 'commerce.order.created',
    data: { orderId: 'ord-42' },
  },
  identity: { tenantId: 'acme' },
  trust: 'authenticated',
});
await runtime.waitForIdle();
await runtime.close();
```

## Envelope, Identity, and Trust

`AxEventEnvelope` follows the CloudEvents 1.0 field model. Event `data` must be
persistable: finite JSON values, arrays, and plain objects. Functions, class
instances, cyclic objects, sockets, clients, and credentials are rejected.

Identity and trust are not read from event data. The source adapter supplies
`AxEventIdentity` and `AxEventTrust` after authenticating the caller. An event
without that mapping is anonymous and untrusted. Dedupe and continuation keys
include the verified identity scope, preventing one tenant from consuming
another tenant's notification.

## Route Actions

- `observe` records or forwards telemetry without calling a model.
- `invalidate` refreshes a declared catalog or cache without calling a model.
- `wake` starts a target with inputs produced by its typed input plan.
- `resume` finds the continuation that owns a correlation key and restores its
  target instance.

Matching an event is never enough to invoke an LLM. The route action remains
the authorization boundary.

Event data is not injected as a synthetic user message. Declarative mappings
and callback `mapInput` both select and validate the fields accepted by the
program signature. The immutable
`eventContext` remains available to nested programs and tool handlers for
identity, trust, causation, cancellation, and idempotency.

## Advisory Demand Detection

`AxDemandBoundary` is an optional provider-neutral boundary for turning an
observation into retained detector evidence and a host-reviewable disposition
proposal. Connect it through an `observe` route with
`axDemandEventObserver(boundary)`: the event runtime still owns ingress,
dedupe, debounce, and scheduling, while the boundary records `demand`,
`no_demand`, or `uncertain` plus confidence, calibration, provenance, expiry,
and one of `ignore`, `annotate`, `notify`, `propose`, or `act`.

Every disposition is advisory, including `act`. The proposal is always marked
`authority: 'advisory'` and `requiresHostReview: true`. The boundary has no
target, tool, sink, notification, or effect callback, so it cannot perform or
authorize an action. A host must re-check current authorization and settle any
effect at its own boundary. A standing-grant reference is opaque; the optional
validator only records whether that reference was valid when the proposal was
created. Revocation after creation is therefore another reason the host must
authorize again at review time.

Detector output is untrusted structured evidence. Free-text reasons are stored
but never parsed as policy, and detectors cannot select dedupe keys. Invalid
detector output becomes an explicit `uncertain` record with a fail-closed
fallback. Explicit no-demand and stale evidence prefer `ignore`; low-confidence
or conflicting evidence prefers `annotate`. None disappears silently.
Observations default to 1 MiB and detections to 64 KiB; hosts can lower both
limits. Map only consented, necessary fields, redact before this boundary, and
set an application retention policy: cursor retention is not permission to
collect or keep unrelated personal data.

Detector and standing-grant callbacks receive separate deeply frozen copies;
the store receives a different canonical clone, so callback mutation cannot
rewrite retained identity, evidence, or provenance. Grant validation receives
a structured context containing its opaque reference, observation, boundary
scope, and abort signal. The scope always binds boundary ID, route ID, instance
key, and principal identity around the host's local observation/dedupe key. A
custom observation mapper cannot remove that authority scope.

Observation validation and size failures reject explicitly before detector
invocation; rejected host input is not retained. A detection's `confidence` is
its estimated demand probability, not authority or an action score. Host
disposition allowlists must contain `ignore` or `annotate`, and every fallback
stays within that allowlist.

Observation, provenance, and expiry times must be non-negative safe integer
timestamps. Evidence beyond the configured future-skew allowance (five minutes
by default) is ignored. Detector and grant callbacks are abortable and bounded
to 30 seconds by default. A timeout is retained as fail-closed uncertainty;
caller or runtime cancellation rejects the observation and is never converted
into successful evidence.

`AxInMemoryDemandStore` retains cursor-addressable records, supports snapshots
for tests and process-managed restoration, and atomically deduplicates appended
proposals in one process. A boundary also single-flights concurrent callbacks
for the same scoped key. Each waiter owns its cancellation independently; work
is aborted only when no waiters remain. Pending work is bounded to 1,000 keys
and 64 MiB by default. Separate processes or boundary instances still need a
host reservation protocol if callback-level exactly-once behavior is required.

The in-memory defaults retain at most 10,000 records, 64 MiB, 1,000 scopes,
1,000 records per scope, and seven days. Oldest records/scopes are evicted when
a bound is crossed; retention eviction also removes their dedupe keys, so a
later replay can be evaluated again. Scope components default to a combined 16
KiB bound. Production hosts should supply an `AxDemandStore` with explicit
atomic dedupe, persistence, and retention. The detector itself remains
host-supplied; Ax does not start a classifier, timer, notification system, or
generic agent loop.

Dedupe keys identify immutable observations. Replaying a key returns the
original retained record even after its proposal expires; a genuinely new
observation needs a new host-selected key. Expiry prevents a proposal from
remaining current, not an event from remaining deduplicated. Duplicate receipts
are explicitly `historical: true`; hosts must never treat a prior grant state as
current authority.

Run the deterministic mechanism evaluation with:

```bash
npm run event:demand:eval
npx vitest run scripts/eval-demand-boundary.test.ts
```

The fixed ID-addressed fixture contains 40 synthetic observations (8 demand, 32
no-demand) and reports confusion counts, precision/recall, Brier score, ECE,
false fires, retained-but-not-fired demand, measured callback counts/latency,
and bytes against reactive and naive confidence-threshold baselines. Fixtures,
labels, and outputs are checked in together: this characterizes policy
mechanics and is explicitly **not** an independent model held-out evaluation or
an improvement claim. The deliberately misleading well-formed detector remains
a false fire, while conservative handling reduces recall.

The checked-in fixed result is:

| Policy | TP | FP | TN | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Reactive explicit-request baseline | 2 | 0 | 32 | 6 | 1.000 | 0.250 |
| Naive confidence ≥ 0.75 | 7 | 5 | 27 | 1 | 0.583 | 0.875 |
| Advisory boundary | 4 | 1 | 31 | 4 | 0.800 | 0.500 |

False fire and false suppression are FP and FN respectively. Detector
calibration over the 39 structurally valid detector scores is Brier 0.132826
and 5-bucket ECE 0.230; the deliberately malformed score is excluded. The
boundary retained all 40 records, measured 40 detector and two grant-validator
callbacks, 10,146 observation bytes, and 13,523 detection bytes. The command
also reports monotonic detector and end-to-end evaluation latency for that run;
latency is not asserted as a fixed-clock zero. No provider or effect callback is
configured by this fixture. These values characterize the mechanism fixture,
not model quality or performance limits.

## Signature-Aware Input Mapping

The program signature is the destination contract. `eventPath` describes
segment-safe sources; it is not a dotted JSONPath string and `s()` remains only
the signature builder.

```ts
const target = eventTarget('inventory-agent')
  .program(program)
  .ai(llm)
  .wakeInput((input) =>
    input
      .project(eventPath.data())
      .field('url', eventPath.data('uri'))
      .field('revision', eventPath.data('revision'))
  )
  .resumeInput((input) =>
    input
      .field('url', eventPath.continuation('url'))
      .field('revision', eventPath.data('revision'))
  )
  .waitFor('inventory.revision', eventPath.data('revision'), {
    metadata: { url: eventPath.data('uri') },
  })
  .build();
```

For a callback-free mapping that can be reused or assembled separately from
the target chain, build the plan explicitly and pass it to `.wakeInput()`:

```ts
const wakeInput = eventInput<{
  url: string;
  revision: number;
}>()
  .project(eventPath.data())
  .field('url', eventPath.data('uri'));

const target = eventTarget('inventory-agent')
  .program(program)
  .ai(llm)
  .wakeInput(wakeInput)
  .build();
```

`.project(path)` copies only same-named fields declared by the signature;
unknown event fields are ignored. Explicit `.field()` mappings override the
projection. Required fields, field types, unsafe path segments, duplicate
destinations, and factory signature mismatches fail as non-retryable
`event_input_invalid` deliveries before invocation starts. Callback `mapInput`
results pass through the same signature normalization: undeclared fields are
discarded and mapper failures are non-retryable. A common `.input()`
may serve both actions; action-specific mappings win, and wake never falls back
to `resumeInput` or resume to `wakeInput`.

`createProgram` takes a declared signature before its factory so every created
program can be checked against the mapping contract. Object-form targets and
callback `mapInput` remain compatibility escape hatches, but callback mapping
and declarative mapping cannot be combined.

One route owns one target. To wake several Agents from one event, add several
matching routes. Each route then keeps independent authorization, instance
ordering, retry, cancellation, and run records.

## State and Instances

Targets created with a single `program` object are limited to one logical
instance key. Stateful multi-tenant Agents must use `createProgram(instance)`
so concurrent identities never share mutable Agent state.

Program state is stored in `AxProgramStateEnvelope` with schema, program, and
revision versions. When a target changes either version it must provide
`migrateState`; otherwise the delivery is dead-lettered with
`state_migration_required`.

AxAgent `getState()` / `setState()` are detected automatically. Clarification
creates a `waiting_event` continuation instead of losing the Agent trajectory.

## Continuations

Code running under an event target can register durable correlation intent:

```ts
context.eventContext.registerContinuation({
  correlation: [{ kind: 'payment', value: paymentId }],
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
});
```

Correlation ownership is unique within one identity scope. Progress events can
use `observe`; terminal events use `resume`. Missing, ambiguous, or expired
continuations are dead-lettered rather than converted into fresh work.

## Delivery and Side Effects

The built-in `AxInMemoryEventStore` is volatile and single-process. It retries
during the process lifetime but cannot recover events after a crash. Its
defaults are 10,000 pending deliveries, 64 MiB queued data, 1 MiB per event,
and a five-second publish wait. Capacity exhaustion throws
`AxEventBackpressureError`; events are never silently dropped.

Ordering is strict for one target instance. Different routes are unordered,
especially during retry. Set `ordering: 'relaxed'` only when concurrent work is
safe. `debounceMs` delays a route; adding `coalesce: 'latest'` explicitly
replaces an older queued delivery for the same route and instance. Final output
is stored before final sink dispatch. Sink failure has its own dead letter and
does not repeat the model call.

Targets default to unknown side-effect safety. If a program may have performed
a side effect and then fails, the runtime records `outcome_unknown` rather than
blindly replaying it. Set `retrySafety: 'idempotent'` only when every effect is
protected by the stable delivery idempotency key.

## Cancellation and Shutdown

`cancelRun(runId)` aborts the active program and its nested calls. `close()`
stops sources, drains by default, then aborts remaining workers. Caller-owned
protocol clients remain caller-owned. Background source failures are supervised
through `onSourceError`; they are never thrown from an unobserved callback.

## Deterministic Tests

Pass `AxManualEventClock` to the runtime and in-memory store. Retry delay,
debounce, continuation expiry, and backpressure then advance only when the test
calls `advanceBy`, avoiding wall-clock flakes.

Persistent and multi-worker guarantees are capability-gated. The Node-only
`AxSQLiteEventStore` is the first conforming implementation:

```ts
import {
  AX_SQLITE_EVENT_STANDARD_RETENTION,
  AxSQLiteEventStore,
} from '@ax-llm/ax-tools/event/sqlite';

const store = new AxSQLiteEventStore({
  filename: './events.sqlite',
  retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
});
const runtime = eventRuntime({
  store,
  programStateStore: store,
  coordination: 'multi-worker',
  routes,
});
```

It uses WAL transactions, busy timeouts, leases, monotonically increasing
fencing tokens, state compare-and-set, and output persistence before sinks. Its
claim is limited to cooperating Node processes sharing one local SQLite file;
do not deploy it on a network filesystem. `runAxEventStoreConformance(...)` is
the normative kit for other stores.

Retention is required. The standard preset keeps event/result payloads and
completed continuations for seven days and run metadata/dead letters for 30
days. Inline payloads default to 16 MiB. Larger outputs require an
`AxEventPayloadStore`; otherwise the run records `output_persistence_failed`,
does not dispatch sinks, and never repeats the completed model call.

## MCP Adapter

`AxMCPEventSource` converts client notifications into generic envelopes. It
preserves existing client callbacks, supervises Streamable HTTP listening, and
restores logical subscriptions after safe session recovery. Supply verified
identity from the application's token mapping; MCP sessions alone are
anonymous. `axMCPEventRoutes({ client })` provides observe/invalidate/task
resume defaults, while resource changes require an explicit wake route.

Users do not need to know resource URIs before connecting. Call
`client.inspectCatalog()` or give the source an explicit
`resourceSubscriptions` policy (`'none'`, `'all'`, concrete URI array, or a
metadata selector). Managed sources reconcile catalog additions/removals and
share URI ownership safely with manual subscriptions. URI templates are
discoverable but never expanded automatically. See
[MCP Catalog Discovery And Resource Subscriptions](./MCP_SUBSCRIPTIONS.md).

Local Streamable HTTP examples set `AX_MCP_ENDPOINT` and explicitly enable
loopback HTTP in their transport SSRF policy; remote endpoints retain secure
HTTPS defaults. Close the source/runtime before closing the caller-owned MCP
client so unsubscribe and cancellation messages can still be sent.

## UCP Webhook Adapter

`AxUCPWebhookEventSource` is request ingestion, not an HTTP server. Mount its
`ingest(request)` method in the application's framework. It delegates profile,
signature, digest, freshness, key-rotation, and replay verification to the
configured `AxUCPClient` before enqueueing an event. Only then does the
application-supplied resolver attach tenant/account identity. Unmapped events
remain anonymous and untrusted.

The adapter advertises `requiresDurable`, so a volatile runtime must opt in with
`allowVolatile: true`; otherwise startup refuses a configuration that could
acknowledge a webhook before durable acceptance.

## Generated Languages

AxIR owns the deterministic event state machine used by TypeScript, Python,
Java, C++, Go, and Rust: route selection, trust gates, input mapping, retry
classification, continuation matching, and MCP event normalization. Generated
hosts expose source, sink, clock, store, target, and runtime lifecycle
boundaries. Their volatile inline dispatcher implements start, publish, close,
cancellation, run inspection, continuations, state restoration, dead letters,
sink-only redrive, and output-before-sink ordering without a hidden worker
thread. `publish()` atomically enqueues and drains deliveries due at the
injected clock's current time. Debounced work and delayed retries remain
queued; the host schedules `runDue()` using `nextDueAt()`. `redrive()` makes the
delivery due at the current clock and drains it immediately.

System and manually advanced clocks provide `now()` and cancellable `sleep()`.
Generated in-memory stores enforce the same 10,000-delivery, 64 MiB queue,
1 MiB envelope, and five-second publication limits as TypeScript. Strict
target/instance ordering, latest-value coalescing, retry delay, and continuation
expiry all use the injected clock. Each host also exposes idiomatic
segment-safe path, input-plan, target, and route builders. Generated targets
accept the host `AxSignature` plus a typed invocation callback (and program
adapters where the host has an object-safe program surface); mapped values are
validated before that callback runs. Host timers and asynchronous
supervision remain native to each ecosystem. The `axevent.single-worker`
capability is emitted only after all generated lifecycle conformance runners
pass; multi-worker capability is advertised only when that language has a
persistent store passing its store conformance runner.
