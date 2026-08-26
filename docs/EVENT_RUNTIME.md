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
- `resume` atomically and exclusively admits the continuation that owns a
  correlation key to the fenced delivery, then snapshots the same binding on
  the run before invocation. Retries, delivery redrive, sink redrive, and
  recovery use only that immutable continuation/target/instance binding;
  correlation-key reuse cannot retarget persisted work.

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
but never parsed as policy, detector reason codes remain only on the detection,
and detectors cannot select dedupe keys. Proposal `reasonCodes` contain only
boundary-owned policy classifications. Invalid detector output, including a
non-string reason or standing-grant reference, becomes an explicit `uncertain`
record with a fail-closed fallback. Explicit no-demand and stale evidence prefer
`ignore`; low-confidence or conflicting evidence prefers `annotate`. None
disappears silently.
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
custom observation mapper cannot remove that authority scope. Host observations
and detector outputs are schema-snapshotted into detached plain records with one
read per declared field; validation, byte limits, freezing, and retention all
use that same snapshot. Throwing detector getters become explicit uncertainty,
while throwing host getters reject before detector invocation. Detector ID,
version, and callback are likewise captured once at boundary construction;
default boundary identity, callback binding, and retained detector metadata use
only that frozen descriptor.

Observation validation and size failures reject explicitly before detector
invocation; rejected host input is not retained. A detection's `confidence` is
its estimated demand probability, not authority or an action score. Host
disposition allowlists must contain `ignore` or `annotate`, and every fallback
stays within that allowlist.

Observation, provenance, and expiry times must be non-negative safe integer
timestamps. Evidence beyond the configured future-skew allowance (five minutes
by default) is ignored. Detector and grant callbacks are abortable and bounded
to 30 seconds by default; configured timeouts cannot exceed the portable timer
maximum of 2,147,483,647 milliseconds. A timeout is retained as fail-closed
uncertainty, including when a callback's abort listener rejects first; caller or
runtime cancellation rejects the observation and is never converted into
successful evidence. Timeout or cancellation does not release the
underlying callback reservation: an abort-ignoring promise remains charged
against both `maxInFlight` and `maxInFlightBytes` until it actually settles.
Reservations count the serialized observation and scope retained by detector
callbacks, plus the grant reference for grant callbacks. Capacity exhaustion
rejects new work. Hosts that must recover that capacity need an actually
terminable worker or process boundary.

Recorded detector latency is always finite and nonnegative. Clock reversal,
overflow, or a duration above `Number.MAX_SAFE_INTEGER` milliseconds is clamped
to zero or that maximum, with `metrics.detectorLatencyCapped: true`; hosts must
not interpret a capped sample as an exact duration. Timestamp window arithmetic
uses safe-integer differences and rejects invalid host/store clocks.

`AxInMemoryDemandStore` retains cursor-addressable records, supports snapshots
for tests and process-managed restoration, and atomically deduplicates appended
proposals in one process. A boundary also single-flights concurrent callbacks
for the same scoped key. Each waiter owns its cancellation independently; work
is aborted only when no waiters remain. Pending work is bounded to 1,000 keys
and 64 MiB by default. Separate processes or boundary instances still need a
host reservation protocol if callback-level exactly-once behavior is required.
Restored seed records are ordered by numeric cursor before pagination, and
duplicate seed cursors or dedupe keys are rejected.

Every `AxDemandStore.append` receives the boundary's internal abort signal and
must check it atomically immediately before committing a new record. If the
signal is already aborted, append must reject without retaining the record.
This store contract prevents cancellation during an asynchronous durable append
from becoming historical evidence; a post-append boundary check cannot undo an
external commit.

`maxInFlight` and `maxInFlightBytes` are applied as separate per-class ceilings:
once to transient keyed work and once to unsettled detector/grant callback
reservations shared together. They are not one aggregate pool, avoiding double
charging while a callback belongs to live keyed work; worst-case combined
accounted evidence is therefore twice the configured byte ceiling.

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

Observe options, the scope container, and each scope field are captured once,
preventing getter-backed options from combining unrelated route, instance, or
principal values. Provenance polarity accepts only `supports`, `contradicts`,
or `neutral`; malformed host polarity rejects before detection, while malformed
detector polarity becomes explicit invalid-detector uncertainty.

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
callbacks with zero capped latency samples, 10,146 observation bytes, and
13,523 detection bytes. The command also reports monotonic detector and
end-to-end evaluation latency for that run; latency is not asserted as a
fixed-clock zero. No provider or effect callback is configured by this fixture.
These values characterize the mechanism fixture, not model quality or
performance limits.

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
continuations are dead-lettered rather than converted into fresh work. Resume
admission is one fenced store transaction: one continuation can bind to only
one delivery, and the immutable snapshot is retained when that delivery is
redriven. Successful resume terminalization is also one fenced transaction: the
delivery cannot become `succeeded` or `waiting_event` unless its admitted
continuation is completed and de-keyed in the same commit. A store that does
not implement `admitContinuation(...)` and
`saveDeliveryAndCompleteContinuation(...)` fails resume closed while preserving
source compatibility for existing `AxEventStore` implementations. Legacy or
malformed resume records without matching delivery and run bindings also fail
closed rather than looking up a replacement.

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
verification status and reason. Abort remains `cancelled`. An accepted
`cancelRun` during an in-flight V2 transition rejects the store handoff after
commitment awaits and does not install or run the child. If a caller-supplied
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
full-record journals to commitments and securely deletes the old rows. A
durable cleanup-pending marker is committed with that migration; every later
startup checkpoints and truncates the WAL before clearing the marker, so a
crash between migration commit and cleanup cannot strand legacy payload frames.
These verifier journal and cleanup-marker semantics are SQLite event schema v4;
later event-family schema lines must migrate from verifier-v4 rather than
reusing its version numbers or replacing its capability marker.
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

The ledger and exclusive resume admission are additive to the host authority
boundary, verifier transitions, and trusted component lifecycle; they do not
replace or weaken any of them. Only `succeeded` and `failed` effects are
receipt-complete. `intent`, `dispatched`, and `parked` remain unresolved and
block successful run/delivery completion, including after a verifier pass or
sink recovery. Unknown non-effect-aware target recovery remains
`outcome_unknown`.

## Cancellation and Shutdown

`cancelRun(runId)` aborts the active program and its nested calls. `close()`
stops sources, drains by default, then aborts remaining workers. The close
`timeoutMs` is one overall return deadline for source close, optional drain,
worker settlement, and store close. Concurrent/repeated calls join the same
shutdown. The return deadline uses a host-native timer independent of an
injected replay/manual event clock. Ax retains active stream iterators,
best-effort requests `return()` after abort, ignores synchronous or asynchronous
iterator cancellation failures, and suppresses chunks that arrive after the
abort signal. Runtime-owned persistence, sink dispatch, effect calls, and
continuation registration recheck abort/revocation after host awaits; claim
heartbeats stop with the active run or runtime abort. In-flight claim renewals
receive the composed abort signal, are tracked within the close deadline, and
built-in stores recheck that signal and their closed epoch immediately before
mutation. In-flight publishes are likewise tracked, recheck shutdown after
each asynchronous route/authorization/instance callback, and pass the composed
signal to an abort-aware enqueue boundary. They cannot enqueue through a
built-in store after close revokes it. This bounds when `close()` returns only:
Ax cannot terminate non-cooperative JavaScript, revoke capabilities it already
captured, or prevent its later host side effects.
Sources, iterators, tools, and stores must cooperate with abort or use a
host-owned revocation/epoch check before external writes. Timed-out work and
store close may continue after the returned promise settles. Once workers
settle or their share of the overall deadline expires, Ax independently starts
best-effort store close; a permanently hung worker cannot prevent that attempt,
and store-close rejection is observed and suppressed.
Caller-owned protocol clients remain caller-owned. Background source failures
are supervised through `onSourceError`; they are never thrown from an
unobserved callback.

## Trusted Live Components

`AxEventComponentManager` is an opt-in, process-local lifecycle boundary for
trusted host-defined event integrations such as listeners, adapters, and source
registrations. `AxEventRuntime` uses it internally to own source handles, but
caller-created protocol clients remain caller-owned.

```ts
const components = axEventComponentManager();

await components.define({
  id: 'catalog',
  version: '1',
  activate: () => ({ revision: 1 }),
});

await components.define({
  id: 'listener',
  version: '1',
  dependencies: ['catalog'],
  activate: async (context) => {
    const catalog = context.dependency<{ revision: number }>('catalog');
    return context.acquire('listener-handle', async (signal) => {
      const handle = await startListener({ catalog, signal });
      return { value: handle, dispose: () => handle.close() };
    });
  },
});

await components.activate('listener');
console.log(components.inspect());
await components.deactivate('catalog'); // listener first, then catalog
await components.dispose();
```

Definitions have stable IDs, explicit versions, and declared dependencies.
Activation walks dependencies before dependents. Deactivation walks active
dependents before dependencies. Within one component, disposers run once in
reverse registration order; cleanup continues after a disposer error and
records the error in `inspect()`. Missing dependencies and cycles fail before
activation code runs. Disposing a component permanently disposes its complete
transitive dependent definition closure, including inactive dependents, so it
cannot leave a defined component with a permanently disposed dependency.

```text
defined / failed (cleanup settled) -> activating -> active -> deactivating -> defined
                                           |                              |
                                           +-- rollback -> failed        +-- dispose -> disposed
failed (effect ownership unsettled) -> inspect only; activate/replace are fenced
```

All graph-changing calls share one serialized transition queue, so conflicting
calls have a bounded concurrency of one. Repeated activate, deactivate, and
dispose calls are idempotent. During activation, a transition `AbortSignal`
forwards abort into the component lifetime controller. The listener is detached
when activation commits, so a later transition abort does not terminate an
active component; deactivation or disposal does. Teardown that has begun runs to
each registered disposer once in reverse order. Pass `timeoutMs` to a lifecycle
transition to bound the total cleanup wait. A timed-out disposer is left
`failed`, emits a `disposer-timeout` diagnostic, and does not block later
cleanup; because its external outcome is unknown, the manager does not report
that component as disposed. A component with any failed or otherwise unsettled
effect cannot be activated or replaced: both transitions preserve the failed
inspection evidence and reject before candidate setup can acquire another
resource. Replacement applies the same preflight to every non-active external
dependency in its staged graph before any dependency or candidate setup runs. A
failed activation remains retryable only when rollback settled and all
registered effects are terminally disposed.

`replace()` stages a new-version candidate and every active transitive dependent
while the prior graph remains live. Staged dependency lookup prefers the staged
graph, and each activation context retains that dependency snapshot through its
cleanup. Failure anywhere in that closure rolls back the staged graph and leaves
every prior binding untouched. Success switches the closure's manager bindings
synchronously, then retires the prior graph dependents-first against the prior
dependency snapshot. Prior cleanup failures become diagnostics on the
corresponding active component rather than pretending the switch can be undone
after retirement began.

Replacement does not implicitly activate an inactive component. Replacing a
`defined` component swaps its definition and leaves it `defined`; replacing a
`failed` component installs a fresh `defined` version only when every prior
effect is terminally disposed. Call `activate()` explicitly afterward. A
`failed` component with unsettled effect ownership and a `disposed` component
cannot be replaced.

Use `context.acquire(label, setup)` for resources: setup must return both the
value and its disposer. A missing disposer fails activation with an
`AxEventComponentLeakError` diagnostic. `addDisposer()` supports effects that
are already represented by a cleanup callback, but the host is responsible for
registering it before activation completes. Registration attempted after that
boundary is diagnosed and rejected; its callback is not invoked asynchronously.

`AxEventRuntime.close()` synchronously fences further source startup and aborts
an in-flight source activation before waiting for source cleanup. If a source
ignores abort and returns a handle later, the activation transaction closes that
handle before startup rejects; later configured sources are not started. The
close timeout is one bound across component cleanup, workers, active verifier
and authority callbacks, and redrives. Throwing or non-settling source disposers
cannot prevent the store close boundary, but timed-out external cleanup remains
uncertain rather than being reported as successful.

### Explicit non-guarantees

- This API accepts already-authorized host callbacks. It does not load, persist,
  watch, deploy, sandbox, or execute model-generated component code.
- Disposers are compensating cleanup, not proof that arbitrary network writes,
  messages, external transactions, or other unmanaged I/O were reversed.
- Unregistered effects are invisible. The manager cannot diagnose or clean up
  a resource that the host acquires without `acquire()` or `addDisposer()`.
- Replacement is atomic only for the manager-visible binding. Candidate setup
  effects that must remain externally invisible need host-provided staging.
- Abort is cooperative. Activation code that ignores its signal can delay the
  serialized transition queue until the caller's close/cleanup deadline. A
  timed-out callback may still settle later in its host environment.
- Component definitions and state are process-local and intentionally not a
  durable desired-state or auto-deployment system.

### Fault mechanism and boundary evaluation

Run the deterministic, model-free evaluator:

```bash
node --import=tsx scripts/evaluate-event-components.ts --iterations=200
```

The seven manual cases intentionally omit transaction machinery and are not a
semantics-equivalent handwritten implementation. They demonstrate which narrow
mechanism each managed case adds; repeating them 200 times checks deterministic
stability, not schedule exploration, fuzzing, or model checking.

A separate adversarial boundary matrix asserts source `start()`/`close()`
overlap, late teardown registration followed by queued activation, inactive
replacement, partial dependency disposal, dependency snapshots, abort before/
during/after acquisition and after commit, undefined and malformed source
handles, startup rollback, and cleanup failure continuation. The command fails
if any exact boundary invariant regresses. It also prints resource leaks,
restoration and ordering outcomes, and descriptive timing. The timing comparison
is deliberately asymmetric—a minimal unmanaged disposer call versus full
manager define/activate/deactivate—and is neither a semantics-equivalent
benchmark nor a CI threshold or model-quality claim. The unmanaged-effect result
reports one leak for both implementations; the disposer-error result reports the
resource whose own disposer failed while verifying that later cleanup ran.

## Deterministic Tests

Pass the same `AxManualEventClock` instance to the runtime and store. A runtime
adopts an exposed store clock when its own clock is omitted and rejects
different explicit runtime/store clocks so lease issuance and validation cannot
use different time domains. Retry delay, debounce, continuation expiry, and
backpressure then advance only when the test calls `advanceBy`, avoiding
wall-clock flakes.

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
that offload payloads use `AxEventStagedPayloadStore`, not legacy
`AxEventPayloadStore.put`. The host reserves a unique stage ID before upload,
revalidates ownership after staging, journals `commit_pending` with the run,
then idempotently commits that stage. Restart reconciles the journal before a
claim or run read. Every unresolved staging, commit, or abort record excludes
its delivery from claim. Expired staging/abort ownership atomically marks the
fenced delivery `output_persistence_failed` before cleanup, so a
completed target is never replayed. Malformed rows are quarantined per delivery
without blocking unrelated claims, reads, close, or the supervised worker loop.
A successful recovery atomically commits the stage and binds
the existing nonterminal `finalizing` run to its delivery; lease takeover then
dispatches only final sinks from that persisted output and never invokes the
target again. The run becomes `succeeded` only after every sink-created effect
is receipt-complete (`succeeded` or `failed`); `intent`, `dispatched`, and
`parked` block successful completion. A
resume route atomically binds the active continuation to its fenced delivery
and persists the same snapshot on the run before invocation. Competing workers
cannot admit the same one-shot continuation. Delivery redrive retains the
delivery binding even though it starts a new run; sink redrive validates both
persisted copies, queues completion-only recovery under a fresh fence, and
reconstructs context from the original target, instance, and continuation.
Terminal resume success and consumption/de-keying of that admission are one
fenced SQLite transaction (or one indivisible in-memory mutation). A failure
rolls the whole boundary back; the persisted `finalizing` run remains eligible
only for sink/completion recovery, not target replay. An expired original plus
a replacement under the same correlation key does not retarget output or
consume the replacement. Legacy or
malformed resume records without matching delivery/run admission snapshots
fail closed instead of performing a fresh lookup; legacy wake runs retain their
configured-target fallback.
A live provider-commit acknowledgement must still hold the exact active,
unexpired owner/token. Stale acknowledgements and every failure after staging
begins use structural output-persistence phases. Failed provider reconciliation
leaves `commit_pending` quarantined from claim while unrelated deliveries keep
running; expiry fails closed. `abort(stageId)` releases only that writer's
ownership, so a stale writer cannot delete a winner even when both stages
resolve to the same content-addressed reference. Provider implementations must
enforce idempotent stage/commit/abort, automatic expiry, and the rule that abort
stays safe after an uncertain commit; an aborted stage must never be
resurrected by late host code. Fencing tokens fail closed before
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
Committed payload ownership is released by stage ID when result retention
expires. Combined schema v7 migration uses one immediate transaction to inspect
the actual core, verifier journal/metadata, effect ledger/fingerprint,
payload-stage, and exclusive-admission shapes; migrate every recognized lineage;
assert the complete schema and normalized data; and set `user_version=7`.
`user_version` is otherwise only a future-version guard and diagnostic. The
post-commit verifier WAL cleanup handshake remains intact. The SQLite event store
does not persist advisory demand-boundary records or temporal interaction
timelines.

The existing migration line backfills request digests and canonical ingress
fingerprints from ingress retained independently in the dedupe row, falling
back to a surviving delivery. If neither exists, migration writes a non-null
unverifiable tombstone. Because equality is then unknowable, every replay for
that identity fails closed without creating a delivery until normal dedupe
retention removes the row; it does not bind an arbitrary first replay. Expired zero-route rows
are removed before migration rather than rematerialized; dedupe retention is a
privacy/replay horizon, so the same scoped event identity is accepted as new
after that horizon. Existing canonical fingerprints remain authoritative, and
ingress is retained independently for zero-route records. Legacy run snapshots
are backfilled only when they identify one unambiguous delivery; missing, malformed, or
multiply used legacy bindings after a prior run are marked to fail closed. A
never-invoked legacy resume delivery has no outcome to preserve and performs its
first atomic admission under the combined migration. A
duplicate scoped event id with a changed envelope is
otherwise rejected while its dedupe record is retained. Legacy retention
objects default effect retention to run-metadata retention. Inline payloads
default to 16 MiB. Larger outputs require an `AxEventStagedPayloadStore` and an
explicit `payloadStaging` policy with positive `maxOutstandingCount`,
`maxOutstandingBytes`, `maxPayloadBytes`, `stageTtlMs`, and
`persistenceTimeoutMs`. The stage TTL must exceed two persistence timeouts, and
the current claim lease must cover both operations. Missing capability,
exhausted capacity, insufficient lease budget, timeout, or provider rejection
fails before sink dispatch as typed `AxEventOutputPersistenceError`; the
runtime recognizes its stable `code` and `phase` discriminants across package
copies/JavaScript realms rather than relying on `instanceof`. The completed
model call is never repeated. SQLite bounds outstanding uncommitted
objects to the configured count, bytes, and TTL. Cross-system SQLite/payload
commit is not atomic: between the run-row transaction and provider commit the
journal is `commit_pending`; recovery retries it, and expiry fails closed as
`output_persistence_failed` rather than replaying the target. Until provider
commit is acknowledged, the delivery is excluded from claim; after recovery it
resumes from the persisted `finalizing` run in sink-only mode.

The volatile in-memory store also schedules expired claimed/running leases as
future work. A runtime already waiting before lease expiry wakes at that lease
deadline, advances the safe fencing token, and applies the same recovery policy
as a direct claim.

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
takeover, ownership-isolated stage abort, rejected and non-cooperative payload
staging, store-restart commit reconciliation, zero-route migration/replay and
expiry, in-memory/SQLite negative and stale fence parity, and fencing-token
exhaustion.

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
