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
protected by the stable delivery idempotency key. Set
`retrySafety: 'effect-aware'` only when every external effect is explicitly
wrapped by the ledger below; recovery then applies each effect's own replay
safety instead of treating the whole invocation as unknown.

### Explicit effect ledger

Target-level retry safety remains the compatibility boundary for code that does
not opt in. For an external operation that needs finer crash classification,
application or tool code must explicitly place the operation inside the effect
sandwich exposed by `AxEventContext`:

```ts
let effect = await eventContext.declareEffect({
  operation: 'payments.capture',
  idempotencyKey: `capture:${paymentId}`,
  replaySafety: 'idempotent', // only if the provider honors this key
  metadata: { paymentId }, // bounded, persistable, and already redacted
});

if (effect.status === 'succeeded') return effect.receipt;
if (effect.status === 'failed') throw new Error(effect.error);
if (effect.status === 'parked') throw new Error(effect.parkedReason);

// Persist this immediately before crossing the external dispatch boundary.
effect = await eventContext.markEffectDispatched(effect.id, effect.version);
const receipt = await payments.capture(paymentId, {
  idempotencyKey: effect.idempotencyKey,
  signal: eventContext.abortSignal,
});
await eventContext.settleEffect(effect.id, effect.version, {
  status: 'succeeded',
  receipt: { providerId: receipt.id },
});
```

Do not settle a failed effect merely because a transport call threw. Record
`failed` only when the provider or a domain resolver proves that the operation
failed. A timeout after dispatch is indeterminate and should remain
`dispatched`. The restart classifications below are valid only when every
external call follows this ordering; Ax cannot detect omitted or misordered
wrapper calls.

`metadata` is also the bounded, redacted request descriptor bound to this
effect identity. Ax hashes canonical bytes for `(operation, idempotencyKey,
replaySafety, metadata)` and persists the digest with the intent. Reusing the
same effect identity with a changed descriptor fails closed; object key order
does not change the digest. Include every non-secret request field whose change
must invalidate key reuse. The digest does not make omitted parameters safe and
does not make it acceptable to persist credentials.

The persisted state machine is:

| Status                 | Classification after restart                              | Automatic recovery                                                                                       |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| no record              | crash before durable intent; Ax cannot classify an effect | target-level policy only                                                                                 |
| `intent`               | not dispatched                                            | target may resume; duplicate declarations return the original record                                     |
| `dispatched`           | indeterminate                                             | replay only when both target policy and effect `replaySafety` allow it, or a resolver reconciles it      |
| `succeeded` / `failed` | completed settlement                                      | target may resume and inspect the receipt without redispatching                                          |
| `parked`               | unresolved and blocked                                    | no automatic dispatch; redrive requires a resolver that returns a conclusive outcome or `not_dispatched` |

Normal transitions are `intent -> dispatched -> succeeded|failed`. Direct
`intent -> succeeded|failed` is only for a durable host-local outcome with no
external dispatch. Recovery may move `dispatched|parked -> intent` only after a
resolver returns `not_dispatched`, or settle/park it. Terminal settlement is
immutable; conflicting duplicate settlements fail closed. Dispatch and
settlement compare the caller's observed effect version, so only one same-claim
caller obtains a given transition; identical repeated settlement is accepted.
Each transition also validates the current, unexpired delivery fencing token.
SQLite performs each intent or transition in one local transaction; this does
not make the database transaction atomic with the external service.

Intent identity is unique within one delivery by `(operation,
idempotencyKey)`. Event redelivery already maps to that stable delivery. The
idempotency key is evidence only when the external provider actually enforces
it; naming a key does not make an effect idempotent.

A store fence stops stale database mutation, not a network call already allowed
to leave the process. Pass `eventContext.fencingToken` as a provider/domain
fence when the external system supports it, alongside the stable idempotency
key. Without provider enforcement or a definitive status resolver, a crash in
that gap remains indeterminate and must park.

`eventContext.listEffects()` and `runtime.getEffects(deliveryId)` inspect the
ledger. Recovery inspects unresolved records before target invocation. An
effect resolver can query an authoritative domain system:

```ts
const runtime = eventRuntime({
  routes,
  effectResolverTimeoutMs: 10_000,
  effectResolver: async (effect, { abortSignal }) => {
    const payment = await payments.lookup(effect.idempotencyKey, {
      signal: abortSignal,
    });
    if (payment?.captured) {
      return {
        status: 'succeeded',
        receipt: { providerId: payment.id },
      };
    }
    if (payment === null) return { status: 'not_dispatched' };
    return { status: 'indeterminate' };
  },
});
```

Resolvers may return `succeeded`, `failed`, `not_dispatched`, `indeterminate`,
or `parked`. Resolver errors and timeouts park the effect. Resolver execution
defaults to a 30-second bound; `effectResolverTimeoutMs` configures it. Timeout
and runtime shutdown abort the resolver signal and win the runtime's internal
race even when host resolver code ignores abort, so a hung resolver cannot
indefinitely block recovery or `close({ drain: false })`. An indeterminate
effect with unknown replay safety also parks; an explicitly idempotent one may
replay with the same key. Cancellation parks dispatched, non-idempotent effects
while leaving not-dispatched intent inspectable. Existing unknown target
recovery still records `outcome_unknown`; its dispatched effect records are
parked as additional evidence.

Resolvers are trusted, read-only reconciliation code. JavaScript cannot
terminate a resolver promise that ignores abort: Ax parks the effect and ignores
the late result, but the host code may continue running. Do not dispatch an
external effect from a resolver, and honor its abort signal to release resources.

Metadata is limited to 16 KiB and receipts to 64 KiB; persisted effect text is
limited to 4 KiB per field. Limits reduce accidental payload growth, not secret
exposure. The host must redact metadata and receipts before passing them to Ax.
Ax cannot intercept arbitrary network, filesystem, SDK, or tool I/O, and it
does not claim exactly-once side effects.

The store contract is additive: `AxEventEffectStore` extends `AxEventStore`, so
existing third-party stores and targets continue to run without ledger behavior.
Effect context calls, `effect-aware` targets, and `effectResolver` fail closed
until the configured store advertises and implements `effectLedger`. Built-in
memory and SQLite stores do.

## Cancellation and Shutdown

`cancelRun(runId)` aborts the active program and its nested calls. `close()`
stops sources, drains by default, then aborts remaining workers. The close
`timeoutMs` also bounds source-handle shutdown when host code ignores its abort
signal; Ax ignores a late close result but cannot terminate that JavaScript.
Caller-owned protocol clients remain caller-owned. Background source failures
are supervised through `onSourceError`; they are never thrown from an
unobserved callback.

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
fencing tokens, state compare-and-set, and output persistence before sinks.
Delivery and run writes require the exact current owner/token, an active
claimed/running status, and an unexpired lease in the write transaction. Runs
that offload payloads revalidate those conditions after the awaited payload
write and before the run-row transaction. A stale writer is rejected, but its
returned payload reference is retained: `AxEventPayloadStore` may deduplicate
different keys to one reference, so deleting without a conditional ownership
API could delete a winner's committed payload. Hosts may garbage-collect only
references they can prove are unreferenced. Fencing tokens fail closed before
leaving JavaScript's safe-integer range; the delivery identity must be rotated
instead of wrapping or reusing a token. Its claim is limited to cooperating
Node processes sharing one local SQLite file; do not deploy it on a network
filesystem. `runAxEventStoreConformance(...)` is the normative kit for other
stores.

Retention is required. The standard preset keeps event/result payloads and
completed continuations for seven days and run metadata/dead letters for 30
days. Settled effects default to 30 days; unresolved intent, dispatched, and
parked effects prevent their owning delivery from being pruned. Configured
settled-effect retention is raised to the delivery redrive horizon when needed.
Schema v1 databases migrate in place to schema v4 with an empty effect ledger.
Schema v2 databases backfill request digests and canonical ingress fingerprints
from ingress retained independently in the dedupe row, falling back to a
surviving delivery. If neither exists, migration writes a non-null unverifiable
tombstone. Because equality is then unknowable, every replay for that identity
fails closed without creating a delivery until normal dedupe retention removes
the row; it does not bind an arbitrary first replay. Schema v3 fingerprints
remain authoritative, while schema v4 retains ingress independently for
zero-route records. A duplicate scoped event id with a changed envelope is
otherwise rejected while its dedupe record is retained. Legacy retention
objects default effect retention to run-metadata retention. Inline payloads
default to 16 MiB. Larger outputs require an `AxEventPayloadStore`; otherwise
the run records `output_persistence_failed`, does not dispatch sinks, and never
repeats the completed model call.

### Fault-injection evaluation

Run the checked-in SQLite fault evaluation and its assertions from the
repository root:

```bash
npm run event:effects:eval
npx vitest run scripts/event-effects-fault-eval.test.ts
npx vitest run src/ax/event/effects.test.ts src/ax/event/runtime.test.ts src/tools/event/sqlite.test.ts
```

The evaluation kills child processes without closing their SQLite handles at
every durable boundary (before intent, intent, dispatched, settled success,
settled failure, and parked), then restarts the store/runtime after lease
expiry. It covers idempotent replay, non-idempotent parking, all resolver
outcomes, two-store claim contention, duplicate intent insertion, stale fences,
legacy target-only retry behavior, lost/duplicate records, and schema/store
restart. It also prints measured mean latency and SQLite storage deltas for 200
baseline deliveries versus 200 effect sandwiches.

The focused adversarial command additionally covers changed-request reuse,
canonical key reordering, resolver timeout and shutdown when the resolver
ignores abort, a source handle that ignores shutdown, current-owner checks,
lease expiry without takeover, a content-addressed payload collision during
takeover, zero-route migration/replay, and fencing-token exhaustion.

One orb run measured 0.452 ms baseline versus 1.137 ms with intent, dispatch,
and settlement writes (+0.685 ms mean), and approximately 737 bytes per settled
effect. These are environment-specific observations, not performance gates.
The evaluation establishes durability classification and recovery behavior
only. It does not simulate disk corruption or power-loss filesystem behavior,
verify an external provider's idempotency implementation, prove exactly-once
effects, or evaluate model quality.

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
