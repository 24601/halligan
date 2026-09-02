# Ax Architecture

Ax is a TypeScript-first framework for building typed AI programs, agents,
flows, and optimizers. The same runtime semantics are also compiled through
AxIR into language-agnostic Python, Java, C++, Go, and Rust libraries.

For compiler and IR details, see [`docs/COMPILER.md`](./COMPILER.md). For
audio and realtime usage, see [`docs/AUDIO.md`](./AUDIO.md). For reward-scored
candidate selection and feedback rounds, see [`docs/REFINE.md`](./REFINE.md).
For the append-only agent life log and its context projection, see
[`docs/TRAJECTORY.md`](./TRAJECTORY.md). For the persistent-agency runtime that
lives in one, see [`docs/MIND.md`](./MIND.md).

## System Shape

Ax has nine main runtime surfaces:

1. **AxAI**: provider clients, model catalog metadata, chat, streaming,
   embeddings, transcribe/speak, audio/realtime operations, routing, and
   balancing.
2. **AxGen**: signature-driven structured generation, prompts, tools, retries,
   schema validation, assertions, `bestOfN(...)`, `refine(...)`,
   streaming assertions,
   examples/demos, memory, usage, traces, and streaming folds.
3. **AxAgent**: a staged agent pipeline with actor runtime sessions,
   discovery/recall/used protocols, child delegation, context budgets,
   checkpoint summaries, action logs, state export/restore, and runtime
   profiles.
4. **AxFlow**: an Ax program graph with child program calls, dependency
   planning, auto-parallel grouping, branch/while/feedback control flow,
   caching, merge semantics, and `.returns()` output projection.
5. **AxOptimize**: optimizable component inventory, evaluator rollouts,
   serialized artifacts, and optimizer engines including GEPA.
6. **AxEventRuntime**: a protocol-neutral durable-inbox and explicit-route layer
   for observing, invalidating, waking, and resuming Ax programs.
7. **AxTrajectory**: an append-only agent life log with declared step
   classification, digest-verified blob spill, bounded filtered reads, durable
   per-consumer cursors, a fork/merge DAG, and a tiered-rollup context
   projection with drill-down.
8. **AxMind**: a persistent-agency runtime over AxEventRuntime — thinkers that
   wake from trajectory appends, a deterministic spontaneity backoff ladder with
   an absolute rate fuse, a synthetic-idle liveness watchdog, lag-based health,
   and ledgered outbound messages with exactly-one-reply chat semantics.
9. **AxLearn**: an opt-in learning surface — addressable interaction records and
   receipts, late out-of-order feedback with a pure eligibility reducer, a
   diffable harness tree with a fail-closed admission gate, and a
   content-addressed release chain whose head only a human moves.
10. **AxIR generated libraries**: Python, Java, C++, Go, and Rust packages emitted
    from the shared portable semantics.

These surfaces are connected by the shared Ax program contract: `forward`,
inputs, outputs, examples, demos, traces, usage, chat logs, optimizer
components, and evaluation hooks.

## TypeScript Runtime

The TypeScript package `@ax-llm/ax` is the reference implementation and the
primary public API. New code should use the factory-style surface:

```ts
import { agent, ai, ax, bestOfN, flow, fn, refine, s } from '@ax-llm/ax';
```

The core TypeScript modules are:

- `src/ax/ai/`: provider implementations and model metadata
- `src/ax/dsp/`: signatures, generation, validation, tools, prompts,
  assertions, streaming assertions, `bestOfN(...)`, `refine(...)`, and optimizers such as GEPA
- `src/ax/agent/`: AxAgent pipeline, runtime/session policy, context budget,
  checkpointing, discovery, memory, delegation, and state
- `src/ax/flow/`: AxFlow graph API, step model, executor, and planner
- `src/ax/event/`: event envelopes, stores, sources, routes, continuations,
  targets, sink delivery, and protocol adapters
- `src/ax/learn/`: learning records, the store port, the report schema and
  eligibility reducer, harness trees with their admission gate and installer,
  the release chain, and `axHarnessEvolve`
- `src/ax/funcs/`: JavaScript runtime, security policy helpers, sessions, and
  worker integration
- `src/ax/trace/`: OpenTelemetry integration and portable trace data

TypeScript is not transpiled to other languages. AxIR extracts conformance from
the TypeScript behavior and compiles shared Ax semantics into native target
libraries.

## AI Providers

All providers implement the `AxAIService` contract. Ax normalizes:

- chat and streaming chat
- embeddings
- tool/function calls and JSON schema output
- usage and cost metadata
- provider errors and retryable status
- batch audio APIs: `ai.transcribe(...)` and `ai.speak(...)`
- conversational audio/realtime `.chat()` operations

Provider mapping is descriptor-backed in AxIR. OpenAI-compatible providers,
OpenAI Responses, Gemini, Anthropic, Azure OpenAI, DeepSeek, Mistral, Reka,
Cohere, and Grok share Core request/response normalization. Grok Voice and
Gemini Live use reusable realtime-audio grammar profiles. Targets still own
real HTTP, SSE, WebSocket, auth, retry, and binary media transport.

## Signatures And AxGen

Signatures describe program inputs and outputs:

```ts
const classify = ax('question:string -> answer:string, confidence:number');
```

The signature system supports scalar, JSON, class, date/time, media, and code
fields. Audio inputs are media inputs; top-level audio outputs are scripted
speech artifacts synthesized through `ai.speak(...)` after structured output
selection.

AxGen turns a signature into a typed program. It owns prompt assembly,
examples/demos, tool calls, retries, output parsing, streaming fold semantics,
field processors, validation, memory/chat-log ordering, usage, and traces.

Validation, selection, and streaming safety are separate mechanisms:

- Schema validation retries with parser/constraint feedback.
- `addAssert(...)` checks whole-output hard invariants after validation and
  processors, then retries with correction feedback when it fails.
- `bestOfN(...)` scores complete candidates and returns the highest-reward
  prediction or first threshold hit.
- `refine(...)` runs complete-output feedback rounds and can apply temporary
  reward-derived advice to instruction components.
- `addStreamingAssert(...)` aborts unsafe partial streaming output for the
  current attempt with `AxStreamingAssertionError`, then uses the assertion
  message as correction feedback when retries remain.

## AxAgent

AxAgent builds higher-level programs on top of AxGen. It shapes task inputs,
executes model-written actor code through an `AxCodeRuntime` session, handles
protocol calls such as `final(...)`, `askClarification(...)`, `discover(...)`,
`recall(...)`, `used(...)`, and `guideAgent(...)`, then returns typed outputs.

The agent runtime is a host boundary. Ax owns the portable envelopes, reserved
names, restart policy, action-log records, trace events, state shape, context
budget, checkpoint/tombstone summaries, and model-visible prompt placement.
The host owns the actual interpreter, sandboxing, filesystem/network policy,
native cancellation, and callback bodies.

TypeScript ships `AxJSRuntime` as the canonical JavaScript actor runtime.
Generated AxIR libraries also include optional runtime profiles:

- QuickJS for JavaScript actor code in Java/C++/Rust, with Python driving a
  QuickJS protocol server
- goja for Go-native JavaScript actor code through the generated
  `runtime/goja` package
- Pyodide for Python actor code
- Rust keeps `ProcessCodeRuntime` for the shared JSONL process protocol and
  adds embedded QuickJS behind the `runtime-quickjs` Cargo feature.

Those profiles are supportable adapters, not a replacement for the TypeScript
runtime.

`AxJSRuntime` is defense-in-depth for LLM-authored code, not a container or VM
boundary. Host callbacks and granted runtime permissions remain the authority
boundary; keep durable secrets and privileged effects in host-side functions.

An opt-in verifier-gated working state can be maintained beside the transcript
on the executor stage: a goal ledger keyed by stable id whose transitions
commit only on host-checker support and harness-minted tool receipts. It is off
by default and adds nothing to the prompt when unconfigured. On top of it,
`actorMemoryMode: 'skillState'` swaps the actor's prompt substrate from
action-log replay to *frozen skill spec + typed state + latest observation*,
with the actor emitting a typed state patch of its own. The normative
contract for both is
[`docs/AGENT_WORKING_STATE.md`](./AGENT_WORKING_STATE.md).

Learned artifacts — ACE bullets, executable skill artifacts, and catalog skills
— can carry the authority facts of the trajectory they were distilled from and
have them re-checked against current host authority at retrieval time. The same
contract covers the optimizer-only visibility tier for ACE guidance and
per-skill cost accounting; see
[`docs/SKILL_PROVENANCE.md`](./SKILL_PROVENANCE.md).

## AxFlow

AxFlow is an Ax program graph, not a generic workflow engine. Flow nodes call
AxGen, AxAgent, or nested AxFlow programs through the shared program boundary.

The current Flow runtime uses a compact step model, shared executor, and
planner. Known non-conflicting execute/derive steps may be grouped; map,
returns, control flow, explicit parallel/merge, unknown reads, and unsafe state
effects are planning barriers. Branch, while, feedback, node extension helpers,
streaming cache short-circuit, stop/abort checkpoints, and merge errors are
part of the portable graph semantics.

## AxEventRuntime

AxEventRuntime connects supervised sources to an inbox, selects an explicit
route action, invokes an AxGen, AxAgent, or AxFlow target when authorized,
persists the result, and then dispatches sinks. Protocol callbacks only publish
events; they never invoke models directly. Event payloads remain untrusted data
until a target's signature-aware input plan selects them. `eventPath` uses
segment-safe descriptors for envelope data, extensions, verified identity,
trust, correlation, and continuation metadata. Mapping and signature failures
dead-letter before invocation begins. Fan-out is represented as multiple
matching routes so each target retains independent authorization, ordering,
retry, cancellation, and run state.

Application and tool code can opt individual external operations into the
host-owned effect ledger through the propagated `AxEventContext`. Intent is
persisted before dispatch, optional dispatch state distinguishes an unresolved
boundary, and success/failure settlement stores a bounded receipt. Canonical
request digests reject changed request descriptors under a reused effect key.
Recovery for an explicitly `effect-aware` target reuses settled outcomes,
permits explicitly idempotent replay with the same domain key, accepts bounded
authoritative resolver results, and parks indeterminate non-idempotent effects.
Ax does not intercept arbitrary I/O or claim exactly-once side effects.

The in-memory store is volatile and single-worker. Crash-safe, cooperating
multi-process execution requires the conforming SQLite store from the Node-only
tools entry point. AxIR specifies deterministic routing, input mapping, retry
classification, continuation matching, output-before-sink ordering, and adapter
normalization. Generated-language runtimes dispatch inline without hidden
worker threads; their hosts own timers, listener supervision, and other
asynchronous loops. See
[`docs/EVENT_RUNTIME.md`](./EVENT_RUNTIME.md).

## Learning Surface

`src/ax/learn/` is opt-in and browser-safe. An agent configured with `learning`
gains `agent.learn().run(...)`, which wraps `forward()` from outside the runtime
scope and returns `{ output, receipt }`; the receipt makes one exchange
addressable so late feedback can name it. Records are stamped with the content
identity of the tree the agent was ACTUALLY serving, never with the store head.

An `AxHarnessTree` is a flat, diffable list over three primitives that already
exist — an actor instruction, a playbook bullet, a catalog skill — behind an
admission gate that fails closed on credential-shaped content and on any
attempt by a proposer to author bullet evidence, counters, or lineage.

`axHarnessEvolve` reuses the same promotion gate `agent.playbook().evolve()`
uses and **nominates**: it appends a release with `current: false`. A separate
compare-and-set `promote(...)` moves the head, and nothing inside Ax calls it.
There is no canary, no staged rollout, no online monitoring, and no automatic
demotion. See [`docs/LEARNING_SURFACE.md`](./LEARNING_SURFACE.md).

TypeScript also exposes `AxEventComponentManager` at this boundary for trusted
process-local listener and adapter lifecycle. It owns dependency ordering,
serialized transitions, scoped disposers, activation rollback, and
manager-visible hot replacement; it is not a durable plugin loader or a claim
that unmanaged external I/O is reversible. `AxEventRuntime` uses the same
substrate for source handles without taking ownership of caller-created
protocol clients. Generated-language parity is tracked in the AxIR backlog.

MCP resource events use the same generic ingress. The endpoint initializes one
live client catalog; `inspectCatalog()` exposes a cloned view, and a managed
subscription policy selects only concrete resource URIs. AxIR owns deterministic
selection diffing and subscription ownership transitions, while transports own
wire requests and reconnect supervision. Catalog discovery, subscription, and
model wake remain separate boundaries. See
[`docs/MCP_SUBSCRIPTIONS.md`](./MCP_SUBSCRIPTIONS.md).

## Optimization And GEPA

Programs expose optimizable components and can evaluate candidate component
maps without leaking state between rollouts. Optimizer artifacts are serialized
and validated before mutation, so optimized programs can be exported, loaded,
and applied later.

Multiple optimization strategies serve different needs:

- `optimize(...)`: normal helper that composes BootstrapFewShot -> GEPA
- `AxBootstrapFewShot`: few-shot demo selection
- `bestOfN(...)`: reward-scored complete-candidate selection
- `refine(...)`: reward-scored feedback rounds
- `AxGEPA`: multi-objective Pareto optimization

GEPA is one shipped optimizer engine. Top-level `optimize(...)` seeds GEPA with
`AxBootstrapFewShot` demos first, then runs GEPA with internal bootstrap
disabled and returns an artifact for the caller to apply. Metrics may return a
number, a named score vector, or an `AxMetricResult` containing an explicit
scalar score, bounded textual feedback, and named objective scores. The explicit
score controls scalar acceptance while named scores feed Pareto selection;
feedback stays aligned with evaluation rows and traces for reflection and is not
persisted in optimized artifacts. GEPA runs through the existing
`OptimizerEngine.optimize(request, evaluator)` boundary and owns reflection,
selection, Pareto acceptance, bootstrapping, selector state, metric budgets, and
descendant component optimization. The optimizer contract itself remains
engine-agnostic.

TypeScript also has an experimental `programSource(...)` root. It exposes a
complete implementation as one generic `program-source` component, but accepts
only the validated `ax-program-source/v1` JSON control-flow grammar. Candidate
source remains inert data; a fixed interpreter executes it in the default
locked-down worker runtime. Execution epochs revoke late bridge results after
timeout/abort, plain JSON values are byte/depth/width bounded, and the default
Node worker has heap/stack ceilings. Custom runtimes require explicit JavaScript
and protocol compatibility declarations but remain trusted adapters. See
[`docs/PROGRAM_SOURCE.md`](./PROGRAM_SOURCE.md) for the grammar, security model,
budgets, evaluation evidence, and unsupported cases.

Optimization runs can also emit versioned evidence manifests: a candidate
lineage record of what the search tried, a host-authored causal-claim manifest
under an authority receipt, and a rejected-candidate ledger that artifact
rollback cannot erase. See
[`docs/GEPA_EVIDENCE.md`](./GEPA_EVIDENCE.md) for the record schemas, the
fail-closed rules, the host-versus-Ax authority split, the two promotion gates
and their estimators, the artifact byte budget, and the explicit
non-guarantees. It is an artifact/audit contract, not a runtime surface.

## AxIR Generated Libraries

AxIR makes Ax portable without freezing the TypeScript implementation into a
source-to-source transpiler. The compiler emits:

- Python package `axllm`
- Java package `dev.axllm.ax`
- C++ namespace `axllm` and CMake target `axllm::axllm`
- Go module `github.com/ax-llm/ax/packages/go` and package `axllm`
- Rust crate `axllm`

Generated libraries include package metadata, examples, capability manifests,
and conformance runners. They preserve Core-owned Ax semantics while using each
target's native naming, exceptions, callbacks, package layout, and build tools.
See [`docs/RELEASE.md`](./RELEASE.md) for publishable package names and release
smoke checks.

This is the language-agnostic contract: Ax behavior is specified once, verified
by fixtures, and emitted into idiomatic libraries for each target.

## Observability And Safety

Ax records usage, traces, chat logs, retries, tool calls, agent actions, flow
node events, and optimizer evidence in portable shapes. OpenTelemetry is
available in the TypeScript runtime, while generated targets expose the same
semantic trace/log data through their native APIs.

Security-sensitive behavior is deliberately host-owned. API keys, network
transport, runtime sandboxing, package loading, filesystem access, native
process control, and hard cancellation stay outside Core. AxIR defines the
envelopes and state/log/trace semantics that host code must preserve.

## Contributing

When changing Ax behavior:

1. Update TypeScript behavior and focused tests.
2. Add TS-derived AxIR fixtures if the behavior is portable.
3. Encode language-agnostic semantics in Core helpers or descriptors.
4. Keep generated target templates limited to idiomatic wrappers and host
   integration.
5. Update the relevant docs in `docs/` and skills in `src/ax/skills/` when the
   public behavior changes.

Do not edit generated docs under `website/.generated/`, and do not hand-edit
generated AxIR target output.
