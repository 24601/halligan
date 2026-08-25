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
then call `host.recover(rootId?)`. Recovery fences messages left in `running` as
`outcome_unknown` and never automatically replays them, because a pre-crash
tool side effect may have happened. The last confirmed state remains intact;
pending messages are rescheduled. Application tools should still use stable
idempotency keys when retry is safe.

`snapshot(rootId)` / `restore(snapshot)` support explicit state transfer with
the same rule: running work becomes `outcome_unknown`, pending work can resume,
and handles keep their IDs and capabilities. Registry snapshots and handles
contain bearer capabilities; protect them as sensitive application state.
`restore()` accepts trusted host-owned snapshots only, never client-supplied
registry documents.

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
| `maxSubcalls` | 100 | Exact initial-task + later-message admissions |

Subcall, child, depth, mailbox, and concurrency limits are checked before work
runs. Token usage is attributed after each provider response, so concurrent
in-flight calls can overshoot the observed token boundary; once reached, the
host cancels pending/active work and denies new admission. Providers that do
not report tokens cannot contribute to this counter. Use provider/model output
caps as an additional hard per-call bound.

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
  the session client that owns them. Forged capabilities and cross-parent
  handles are rejected.
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
admission. It compares completion and wall-clock behavior, then exercises
follow-up reuse, snapshot restoration, descendant accounting, cancellation,
limits, crash recovery, and privilege denial. The unit suite separately runs
an ordinary `AxAgent.getFunction()` child to guard the existing synchronous
contract:

```bash
node --import=tsx src/ax/agent/benchmarks/retainedSessions.eval.ts
npx vitest run src/ax/agent/retainedSessions.test.ts
```

The delayed workload is reproducible mechanism evidence. It is not a claim
about real-model answer quality; evaluate model/provider/task combinations
separately.
