# Retained Child Agent Sessions

Ax supports opt-in, host-owned asynchronous child sessions without changing the
existing synchronous child-agent function API. `AxAgentSessionHost` admits an
explicitly authorized registration, returns a stable serializable handle before
the child finishes, and retains that child's own `AxAgent` runtime state,
mailbox, results, artifacts, and usage until disposal.

This is inspired by Prime Agent's retained child-session mechanism. It reuses
AxAgent and Ax's runtime state instead of adding another agent architecture or
an unrestricted interpreter.

## Minimal setup

Registrations are factories, not singleton agents. Concurrent sessions never
share an agent instance; multi-worker attempts are also independently restored
from confirmed state.

```ts
import { AxAgentSessionHost, agent, ai } from '@ax-llm/ax';

const llm = ai({ name: 'openai', apiKey: process.env.OPENAI_APIKEY! });

const sessions = new AxAgentSessionHost({
  ai: llm,
  registrations: [
    {
      key: 'researcher.v1',
      create: ({ session }) =>
        agent('task:string -> answer:string', {
          agentIdentity: {
            name: 'Researcher',
            description: 'Investigates one bounded task',
          },
          // Optional: let this child use retained descendants authorized by
          // this registration.
          functions: session.functions(),
          contextFields: [],
        }),
      // Default is no child authorization.
      authorizedChildren: [],
    },
  ],
});

const root = await sessions.createRoot({
  id: 'job-42',
  authorizedChildren: ['researcher.v1'],
});

const handle = await root.spawn('researcher.v1', {
  task: 'Compare the two incident timelines',
});

// Admission does not wait for the answer.
const status = await root.inspect(handle);
```

To let a parent AxAgent admit children from actor code, add
`root.functions()` to the parent's ordinary `functions` list. The runtime gets
`sessions.spawn`, `sessions.inspect`, `sessions.result`, `sessions.send`,
`sessions.cancel`, and `sessions.dispose`. These use the normal hardened Ax
host-function boundary. Existing child agents in `functions: [childAgent]`
remain synchronous namespaced calls and are unchanged.

## Lifecycle and mailbox

- `spawn(key, input)` atomically reserves the tree budgets, creates the child
  registry record, queues the initial input, and returns its handle. It never
  waits for `AxAgent.forward()`.
- `inspect(handle)` returns lifecycle, complete mailbox history, latest result,
  direct usage, and descendant usage.
- `result(handle)` returns the latest completed result or throws while no result
  exists.
- `send(handle, input, 'follow-up')` queues a complete signature input behind
  active work. It can also start a new turn after completion.
- `send(handle, input, 'steer')` requests cancellation of active work, gives the
  steering message priority at the next mailbox boundary, and then runs it in
  the same retained context. The receipt reports whether the local/custom
  scheduler accepted interruption. If a remote scheduler cannot interrupt the
  active worker, steering waits for that worker to return and discards its
  result as cancelled before running the steering input.
- `cancel(handle)` propagates through that child's descendants, cancels pending
  messages, and aborts active calls without deleting retained identity/state.
  A later follow-up may resume a cancelled child from its last confirmed state.
  `root.cancel()` is terminal for the whole tree and denies new admissions and
  messages.
- `dispose(handle)` cancels and removes that child and all descendants. Old
  handles then fail as missing; capability mismatches fail as stale.

Handles contain a stable child ID plus the root ownership epoch. `recover()`
atomically advances that epoch for the whole tree, so every root client,
session client, generated function closure, and handle held by the previous
owner becomes stale. After recovery, call `restoreRoot(rootId)` and use
`root.list()` to obtain current-epoch direct-child handles. A stale worker can
no longer spawn descendants or inspect, send, cancel, or dispose existing ones.
Scheduler jobs also carry the epoch, and only the host that acquired the
current epoch may dispatch or reschedule them. Recovery also rotates root and
child bearer capabilities. Dispatch validates both the epoch and the rotated
mailbox job ID, so an equal numeric epoch from another restore domain is not
execution authority.

A follow-up/steer input is the child's complete signature input, not an
untyped chat string. A single-worker host reuses the same agent instance while
resident. Multi-worker adapters deliberately use an attempt-scoped instance
restored from confirmed `AxAgentState` and artifacts, preventing a fenced stale
worker cache from overwriting later durable state. State restoration remains
subject to Ax's existing runtime snapshot support.

Cancellation cannot roll back external tool side effects. It does discard the
cancelled turn's in-process agent instance, so a later child follow-up creates a
fresh instance from the last registry-confirmed state and artifacts instead of
reusing partially mutated live runtime state.

## State and artifacts

After every settled message, the host captures `agent.getState()`. A recreated
agent receives that state through `setState()` before running more mail. Values
that Ax marks snapshot-only remain subject to the existing Ax runtime restore
rules; retained sessions cannot make unserializable runtime objects durable.

Registrations can additionally define `captureArtifacts(agent)` and
`restoreArtifacts(agent, value)`. Both values and results must pass
`structuredClone`. Use those hooks for serializable registration-owned artifact
metadata. External files/object blobs still belong in an application-owned
artifact store; persist references, not credentials or open handles.

## Store and scheduler adapters

The default `AxInMemoryAgentSessionStore` and
`AxInMemoryAgentSessionScheduler` are volatile and single-process. They provide
concurrent admission and retained state only while that host process lives.
They do not claim browser tabs or a library process are durable workers.

Production durability requires both adapters:

- `AxAgentSessionStore` atomically compare-and-sets one bounded root-tree
  snapshot. This is the authority for topology, capabilities, mailbox, state,
  usage, and budgets.
- `AxAgentSessionScheduler` enqueues serializable jobs and attaches a worker
  dispatcher. A multi-worker implementation must make `cancel(jobId)` reach an
  active worker when it reports successful cancellation. If it kills a handler
  without allowing the handler to settle, it must trigger recovery so the
  registry fences that running attempt as `outcome_unknown`.

Registry admission remains authoritative if scheduler enqueue fails: the API
still returns the handle, the message remains `queued`, and `inspect()` exposes
the scheduling error. A durable adapter can retry enqueue or a restarted host
can call `recover()`. With the volatile defaults, there is no restart recovery;
the queued work is lost when the process is lost.

On process restart, configure the same stable registration keys and factories,
then call `host.recover(rootId?)`. In one registry CAS, recovery advances the
ownership epoch and fences messages left in `running` as `outcome_unknown`.
Those messages are never automatically replayed because a pre-crash tool side
effect may have happened. The last confirmed state remains intact; pending
messages are rescheduled when their remaining conservative token budget allows.
Application tools should still use stable idempotency keys when retry is safe.

`snapshot(rootId)` / `restore(snapshot, { expectedPolicyDigest })` support
explicit state transfer with the same uncertainty rule. Store the expected
digest separately in trusted host metadata; do not read it from the candidate
snapshot at restore time. Restore first captures the candidate once into a
detached graph, then the expected SHA-256 digest authenticates that canonical
captured state except the store-derived revision and the digest field itself.
This includes enumerable string data keys and their observable order,
root/child authority, lifecycle timestamps and diagnostics, complete mailbox
inputs/results, retained agent state/artifacts, and accounting state.
Ordinary objects and arrays accept enumerable string data keys only (apart from
the intrinsic array `length`); non-enumerable keys, symbol keys, and accessors
are rejected rather than silently discarded. Supported intrinsic structured
values accept only their type-defined own keys and reject custom ones.
Enumerable data-descriptor flags are normalized like `structuredClone`;
caller-defined property getters/setters are never invoked. As the one intrinsic
exception, any lazy `Error.stack` accessor is treated only as a marker: its
getter is discarded and replaced with an inert host-owned marker accessor
without invoking or trusting the source getter.
It otherwise preserves structured-clone identity and common structured values
rather than relying on lossy JSON conversion. Restore then reconciles
direct usage from per-attempt usage, descendant usage through the tree,
retired/disposed ledgers, reservations, outcome-unknown charges, subcalls,
mailbox counts, concurrency, and budget status before accepting the snapshot.

Snapshot import and canonicalization have fixed, non-configurable safety caps:
depth 64, 100,000 visited values/edges or typed-array elements, 16 MiB of
aggregate strings, property keys, blobs, and buffers (strings count as two
bytes per code unit), and 4,096 bits per bigint. Binary content is hashed
directly rather than expanded to hex. Restore does not preflight and then clone
the caller's live graph: one synchronous, descriptor-based capture enforces the
caps while constructing detached trusted data, and only that graph reaches
digest and semantic validation. A changing accessor therefore cannot return a
small preflight value and a large clone value, and a nested Proxy's property
descriptor values are not re-read. Proxy reflection traps are executable host
code and cannot be resource-sandboxed by this browser-compatible library;
snapshots remain host-owned inputs and must never be client- or network-supplied
objects.

Restore is an ownership transfer, not a clone of live authority. It always
advances the destination epoch, rotates root and child bearer capabilities,
and rotates pending job IDs. Stable root/child/message IDs remain usable for
correlation, but source handles are invalid in the destination and destination
handles are invalid in a still-live source. Refresh destination handles with
`restoredRoot.list()`. Registry snapshots and handles contain bearer
capabilities; protect them as sensitive application state. Never accept
client-supplied registry documents.

## Limits and accounting

Defaults are deliberately bounded per root tree:

| Limit | Default | Behavior |
|---|---:|---|
| `maxChildren` | 16 | Current retained descendants |
| `maxDepth` | 2 | Root is depth 0 |
| `maxConcurrency` | 4 | CAS-fenced running messages |
| `maxPendingMessages` | 16 | Pending messages per child |
| `maxRetainedMessages` | 128 | Total mailbox entries per child |
| `maxTokens` | 250,000 | Provider-reported root descendant tokens |
| `maxTokensPerMessage` | 62,500 | Conservative running-attempt reservation |
| `maxSubcalls` | 100 | Exact initial-task + later-message admissions |

Subcall, child, depth, mailbox, and concurrency limits are checked before work
runs. Every message reserves `maxTokensPerMessage` in the registry before its
agent runs. Confirmed completion replaces that reservation with reported usage;
recovery converts an ambiguous reservation to durable `outcomeUnknownTokens`.
Subcalls are durably charged at admission, so neither counter resets after a
crash. New work requires room for another full reservation.

Confirmed per-message usage is retained so each session's direct usage can be
recomputed; retained totals are normalized as prompt plus completion tokens.
Derived root/ancestor usage, active reservations, uncertain-token charges,
subcall totals, concurrency, and budget state must reconcile exactly.
When sessions are disposed, host-owned retired ledgers preserve their usage,
subcalls, and uncertain charges without retaining their runtime or mailbox.

Configure `maxTokensPerMessage` at or above the worst-case child turn implied
by model output and agent/tool-loop caps. Provider-reported usage can still
exceed the reservation, and providers that report no tokens cannot be measured;
the host charges the reservation on ambiguity but cannot enforce an internal
provider cap. `inspectRoot()` exposes known descendant usage, active
`reservedTokens`, cumulative `outcomeUnknownTokens`, and retired usage/subcall/
uncertain-token ledgers separately.

Each record exposes `usage` for its own model calls and `descendantUsage` for
all nested children. The root's `descendantUsage` is the tree total. Stable
root, parent, child, and message IDs are also placed in AI usage context.

## Security boundary

- A root explicitly authorizes stable registration keys. A registration
  separately authorizes which keys its children may admit; the default is
  none.
- A child is built only by its registration factory. It receives only the
  tools, MCP/UCP clients, runtime permissions, AI service, and artifact hooks
  that factory configures. Parent tools are not implicitly inherited.
- Handles are bearer capabilities and can operate only on direct children of
  the session client that owns them. Every handle field is checked against the
  canonical registry record; forged metadata, capabilities, cross-parent
  handles, pre-recovery epochs, and pre-restore capabilities are rejected.
- Generated `sessions.*` functions close over the owning session client. The
  model cannot select another root or escalate by supplying a parent ID.
- Treat stored inputs, outputs, and artifacts as untrusted data when rendering
  them elsewhere. The host does not turn child output into instructions.

## Event runtime integration

`root.functions({ eventContinuations: true })` registers an owned continuation
with correlation `{ kind: 'ax-agent-session', value: handle.id }` whenever
actor code spawns or sends mail. `AxAgentSessionHost.continuationKey(handle)`
returns the same key. Publish terminal `onEvent` notifications through an
application-owned event source with that correlation and route them to
`resume`; the event runtime remains the owner of continuation persistence,
identity scope, and target state.

The session host does not couple itself to a daemon or silently create an event
runtime.

## When retained async children help or hurt

Use retained asynchronous children when tasks are independent enough to
overlap, need isolated long-lived runtime context, will receive later guidance,
or must complete after the parent turn ends. Prefer existing synchronous child
functions when the answer is needed immediately, work is tiny, steps are
strictly sequential, or a durable host is unavailable. Registry CAS, scheduler,
structured cloning, and result inspection are real overhead; concurrency is
not a free speedup.

This API is additive and opt-in. There is no migration for existing child
agents: `functions: [childAgent]` continues to await the ordinary namespaced
child function and return its result. Adopt retained sessions only by creating
a host/root and adding `root.functions()` as a separate function collection.

The deterministic end-to-end workload runs the same child implementation
through a synchronous namespaced function boundary and through retained
admission. Delayed and tiny comparisons use equal concurrency on both sides;
their delta is retained registry/scheduler overhead, not a concurrency speedup.
A separate fresh-session versus same-handle follow-up timing reports retention
amortization without assuming it is positive. The workload also exercises
follow-up context, snapshot policy, descendant accounting, cancellation,
limits, crash recovery, stale-authority denial, ambiguous token charging, and
privilege denial. It also verifies that restore rotates destination authority
while a source remains live. The unit suite separately runs an ordinary
`AxAgent.getFunction()` child to guard the existing synchronous contract:

```bash
node --import=tsx src/ax/agent/benchmarks/retainedSessions.eval.ts
npx vitest run src/ax/agent/retainedSessions.test.ts
```

The delayed workload is reproducible mechanism evidence. It is not a claim
about real-model answer quality; evaluate model/provider/task combinations
separately.
