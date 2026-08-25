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

## Verifier-Gated Continuation

Attach a host-owned verifier when a target may make bounded attempts toward a
deterministically checkable result. The target receives failure evidence only
through continuation metadata; it never receives or mutates the verifier.

```ts
const target = eventTarget('repair')
  .program(repairAgent)
  .ai(llm)
  .input(mapInitialOrVerificationFeedback)
  .retrySafety('idempotent')
  .verifier({
    id: 'test-suite-v1',
    maxRuns: 4,
    maxTokens: 40_000,
    maxWallTimeMs: 10 * 60_000,
    maxCostUSD: 2,
    timeoutMs: 30_000,
    maxEvidenceBytes: 4_096,
    backoffMs: (attempt) => 1_000 * 2 ** (attempt - 1),
    fingerprint: (output) => output.workspaceTreeHash,
    usage: () => readHostRecordedUsage(),
    verify: (_output, { signal }) => runHostTestSuite({ signal }),
  })
  .build();
```

After each target attempt, the runtime persists output before calling
`verify`. A pass records `verification.status: 'pass'`, releases final sinks,
and completes. A failure bounds every persisted verifier field and its typed
JSON evidence, persists it on the run, then uses the store's fenced V2 verifier
transition to atomically terminalize the parent, establish an identity-scoped
continuation, consume the prior continuation when present, and enqueue the
resume delivery. The evidence is exposed at
`continuation.metadata.verification.failure` to the target's resume mapping.
The existing store, worker, retry, cancellation, and ordering machinery owns
the next attempt; no scheduler daemon is created.

Limits are fail-closed. `maxRuns` permits that many verifier calls; token, cost,
and wall-time limits stop before another verifier call once host-reported usage
reaches the bound. Exhaustion, unchanged state, verifier error, and timeout end
with run/delivery status `verification_failed` plus the precise typed
verification status and reason. Abort remains `cancelled`. If a caller-supplied
fingerprint equals the fingerprint of the previous failure, the target's new
output is persisted but the repeated verifier call and further loop are
suppressed. Final sinks run only after a pass.

Use deterministic fingerprints over all state relevant to the verifier. The
`usage`, `fingerprint`, and `verify` callbacks execute in the host under the
same timeout and abort semantics; core never runs shell commands. Verifier
targets use non-streaming execution so no chunk or final sink is observable
before a pass. Outputless clarification waits are not verified. Autonomous
targets should be idempotent; otherwise lease recovery stops at
`outcome_unknown` rather than guessing whether arbitrary external side effects
occurred. Stores must advertise `axevent-verifier-transition-v2`; the runtime
startup-gates verifier routes rather than silently using process-local policy
state. The transition is fence-checked, idempotent, capacity-aware, and atomic
for the parent run/delivery, continuation ownership, child delivery, and old
continuation consumption. Each operation has a deterministic child ID and an
immutable store journal containing SHA-256 commitments to the canonical full
request and deterministic child projection plus the minimal receipt. The
journal never duplicates run output, event payload, identity, continuation
metadata, or verifier evidence. Conflicting reuse is rejected; a committed
operation is confirmed after lost acknowledgements instead of regressing its
parent to `outcome_unknown`. Confirmation requires the complete expected
request, including its parent fence, and returns only the minimal receipt;
operation IDs alone cannot retrieve run or output data. SQLite retains these
compact commitments for the database lifetime while ordinary payload pruning
removes the underlying sensitive data. Schema migration rewrites legacy V2
full-record journals to commitments and securely deletes the old rows.
These guarantees do not make arbitrary target or sink I/O exactly once.

### Deterministic Evaluation

Run the checked-in one-shot versus bounded-continuation hill-climbing suite:

```bash
node --import=tsx scripts/eval-event-verifier-continuation.ts
npx vitest run scripts/event-verifier-eval.test.ts
```

The seven fixed tasks cover recoverable work, an already-correct/no-benefit
case, an impossible task, unchanged state, a misleading verifier, a failing
verifier, and SQLite close/reopen restart recovery. The deterministic outcome
counts are:

| Metric | One shot | Bounded continuation |
| --- | ---: | ---: |
| Ground-truth pass rate | 1/7 (14.3%) | 3/7 (42.9%) |
| Target attempts | 7 | 12 |
| Verifier calls | 7 | 11 |
| Suppressed verifier calls | 0 | 1 |
| Correct hard-stop cases | 3/3 | 3/3 |
| Restart recovery | not exercised | passed |
| False promotions from misleading verifier | 1 | 1 |

The command also reports measured wall-clock time for that invocation; it is
diagnostic rather than a fixed assertion. Continuation helps only when later
attempts can use bounded failure evidence to change a failing result. It adds
attempt, verifier, persistence, and latency overhead to recoverable failures,
and no quality benefit to already-correct work. Impossible work exhausts its
budget, unchanged work suppresses a redundant verifier call, verifier failure
stops closed, and an incorrect verifier can still promote an incorrect result.
The independent ground-truth predicate keeps that false promotion visible; the
evaluation does not relabel it as success.

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
