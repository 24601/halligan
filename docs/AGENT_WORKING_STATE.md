# Agent Working State

Verifier-gated typed working state for the actor loop: a compact typed state
document maintained beside the transcript, whose every mutation must be
supported by host-owned evidence before it commits.

Off by default. With no `workingState` option configured, an agent's prompts,
signatures, exported state and context events are byte-identical to an agent
built before this subsystem existed, and that identity is pinned by
`src/ax/agent/agent.defaultBytes.test.ts`.

Codegen rules live in [`src/ax/skills/ax-agent-state.md`](../src/ax/skills/ax-agent-state.md).
This document is the normative contract.

## Purpose and scope

The actor loop is transcript-shaped: `ActionLogEntry[]` accumulates code and
output per turn, and a family of hindsight heuristics decides how much history
to replay. That machinery is good at *shrinking* a transcript and structurally
incapable of *knowing what is true*. The model's belief about progress lives
only in prose it wrote itself, so it drifts and self-congratulates.

It also carries one adjacent, independently opt-in mechanism: **call-time skill
injection** (see below), which is configured through `callTimeSkills` and needs
no working state unless a binding declares a `when` predicate.

Working state adds one mechanism: a typed document behind a host-declared
signature, carrying a goal ledger keyed by stable goal id plus host-declared
facts. Each turn a proposer *proposes* the next state; a commit kernel
classifies the proposed deltas; the host checker decides support. Only
supported deltas commit. Unsupported deltas park visibly against a bounded
budget.

Non-goals: no trajectory DAG, no new interaction-timeline event kind, no
optimization of the state schema, no event-runtime coupling, no new runtime
dependency, no `node:fs`/`path`/`os` in `src/ax`.

## Ownership boundary

| Concern | Owner | Rationale |
|---|---|---|
| The receipt set | Harness | Minted at the dispatch site, only from a receipt-eligible call site, only when the call returned without throwing, only when the qualified name matches `receiptSources`. The model can neither add to it nor rename a `ref`. |
| Receipt eligibility | Harness, explicit flag, never inferred | Set at each registration site: `true` for MCP bindings, UCP bindings and user tools; `false` for agent-derived callables. `_kind: 'internal'` is stamped inside `getFunction()` itself, so every agent-derived callable carries it BY CONSTRUCTION whatever route it takes into `functions: [...]` — `functions: [child.getFunction()]` and an `AxFunctionProvider` wrapping one included. A child agent's return value is its own `final()` payload — model self-report — and promoting that to environment evidence would make the mechanism circular. |
| `llmQuery` | Never a receipt | It does not reach the function-call recorder and is never given a receipt-eligible dispatch site. Stated so a later refactor does not silently make an LLM sub-query into environment evidence. |
| Receipt `at` | Harness, at the dispatch site | Captured from the injected clock when the call returned, not at turn-hook time. |
| The checker | Host | Host-declared, deterministic limits, fail-closed. |
| The forbidden-path set | Harness, fixed | Not configurable. See the classification table. |
| Any unclassified path shape | Harness, fixed | `forbidden` by the catch-all. The table is closed, not open. |
| The receipt rule for `goal_complete` | Harness, fixed | A checker `pass` cannot commit a completion with no qualifying receipt. |
| Clock, store, park budgets, run id | Host, injected with defaults | Deterministic tests, portable semantics. |
| The patch, goal text, `blocker` prose, rationale | Model | Untrusted content. Never interpreted as instructions, never rendered into the trusted guidance channel. |
| `S`, the fact space | Host, via `stateSignature` | Ax never interprets facts; it only bounds which paths a `fact_write` may touch. |

## Config-time validation

A working-state config that cannot work fails at CONSTRUCTION, not at turn 40.
`agent(sig, { workingState })` runs `axValidateWorkingStateConfig` from the
agent's initialization, before any model call, store read or clock read:

| Condition | Detail code |
|---|---|
| `stateSignature` declares no output fields | `empty_fact_space` |
| `allowModelAuthoredGoals: true` with an empty `expectsAllowlist` | `model_goals_require_allowlist` |
| A seeded goal id fails `^[A-Za-z0-9_.:-]{1,64}$`, or disagrees with its key | `invalid_goal_id` |
| A seeded non-pending goal cites evidence with no receipts minted | `invalid_seed_evidence` |

Each throws `AxWorkingStateSchemaError`. The per-run resolution (store key,
clock, rendered contract) still happens once per `forward()`.

## Delta classification (normative)

Path shapes are JSON Pointers into the document. `<id>` matches
`^[A-Za-z0-9_.:-]{1,64}$`, so no goal path ever requires pointer escaping and
**no goal path is ever index-addressed**.

| Path shape | Op | Class | Kernel verdict | Condition |
|---|---|---|---|---|
| any | `test` | `guard` | `admissible` | Always. Never sent to the checker, never parked, never removed. |
| `/goals/<id>` | `add` | `goal_add` | `forbidden` | `value.status !== 'pending'` or `value.evidence` non-empty. Adding an already-`done` goal is the most attractive forgery and is refused outright. |
| `/goals/<id>` | `add` | `goal_add` | `forbidden` | `<id>` already present, or `value.id !== <id>`. |
| `/goals/<id>` | `add` | `goal_add` | `park` (`model_goals_disabled`) | `allowModelAuthoredGoals !== true` (the default). |
| `/goals/<id>` | `add` | `goal_add` | `park` (`expects_not_allowed`) | `expects` empty, or not a subset of `expectsAllowlist`. |
| `/goals/<id>` | `add` | `goal_add` | `admissible` | Otherwise. |
| `/goals/<id>` | `remove` | `goal_remove` | `forbidden` | The goal is `done` — it is part of the audit record. |
| `/goals/<id>` | `remove` | `goal_remove` | `admissible` | Otherwise. |
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `admissible` | Every cited `ref` is in the receipt set, and when `goal.expects` is non-empty at least one cited receipt's `qualifiedName` is in it. Citations may come from `evidence` already on the goal or from an `evidence_append` appearing LATER in the same patch. |
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `park` (`no_supporting_receipt`) | No ref cited at all, OR the goal is in neither the committed ledger nor an admissible `goal_add` in the same patch. |
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `park` (`unknown_receipt_ref`) | A cited ref is not in the receipt set. |
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `park` (`receipt_not_expected`) | Cited receipts exist but none matches `expects`. For a goal CREATED in the same patch, `expects` is read from that same-patch `goal_add`, so a create-and-close patch cannot escape the expectation. |
| `/goals/<id>/status` → `'blocked'` | `replace` | `goal_block` | `admissible` | The same patch sets a non-empty `/goals/<id>/blocker`. |
| `/goals/<id>/status` → `'blocked'` | `replace` | `goal_block` | `park` (`blocker_missing`) | Otherwise. |
| `/goals/<id>/status` → `'pending'` | `replace` | `goal_retract` | `admissible` | Always. Retraction must never be harder than assertion. |
| `/goals/<id>/blocker`, `/goals/<id>/goal` | `add`/`replace` | `goal_edit` | `admissible` | Value is a string of at most 512 characters. |
| `/goals/<id>/evidence/-` | `add` | `evidence_append` | `admissible` | Value is `{kind:'tool_receipt', ref}` and `ref` is in the receipt set. |
| `/goals/<id>/evidence/-` | `add` | `evidence_append` | `park` (`unknown_receipt_ref`) | Otherwise. |
| `/facts/<declared root>` plus at most `factDepthLimit` further segments | `add`/`replace`/`remove` | `fact_write` | `admissible` | The root segment is an OUTPUT field declared by `stateSignature`. |
| `/facts/<undeclared>…`, or deeper | any | `fact_write` | `park` (`undeclared_fact_path`) | Otherwise. |
| `/schemaVersion`, `/parked`, `/goals`, `/facts`, `/goals/<id>/id`, `/goals/<id>/createdTurn`, `/goals/<id>/updatedTurn`, `/goals/<id>/expects`, any `__proto__`/`constructor`/`prototype` segment | any | `reserved` | `forbidden` | Always. `/goals` and `/facts` are in the set because one wholesale `replace` would otherwise rewrite every id, `createdTurn` and `expects` in a single op no other row classifies. |
| **anything else** | any | `reserved` | `forbidden` | **Catch-all. The table is closed.** |

**Ordering rule.** Classification runs over the whole patch against the
believed document before any application, so a completion can be supported by
an evidence append that appears later in the same patch. Because goals are
keyed by id, classification and application address the same goal by
construction.

**Monotonicity rule (safety).** The checker is consulted only about ops whose
kernel verdict is `admissible` and whose class is not `guard`:

```
commit(op) ⟺ kernel(op) = admissible ∧ (class(op) = guard ∨ checker = pass)
```

A checker `pass` never promotes a park to a commit. A checker `fail` always
demotes an admissible op to a park.

## Fail-closed semantics

| Condition | Behaviour |
|---|---|
| The patch document is not a valid patch | Whole patch rejected, state unchanged, trace `proposal: 'invalid'`, guidance `patch_invalid`. NOT an error turn. |
| A `test` guard fails | Whole patch rejected, guidance `guard_failed`, state unchanged. Guards are never parked and never removed, so this outcome is stable under parking. |
| A forbidden path, or a path no row classifies | Whole patch rejected, guidance `forbidden_path`. `AxWorkingStateForbiddenPathError` is recorded on `AxWorkingStateCommitOutcome.error` and as the trace step's `error`, not thrown into the actor turn — throwing would poison the error-escalation policy. |
| The checker throws | Every admissible non-guard delta parks `checker_error`. |
| The checker exceeds `timeoutMs` | Every admissible non-guard delta parks `checker_timeout`; the pending check is aborted and its listener removed. |
| The checker exceeds `maxChecksPerRun`, `maxTokens`, `maxWallTimeMs` or `maxCostUSD` | Every admissible non-guard delta parks `checker_error`. |
| `compareAndSet` rejects on a revision mismatch | Reload, re-classify the surviving ops against the reloaded document, retry ONCE. A second conflict parks `revision_conflict`; `AxWorkingStateConflictError` is recorded on the commit outcome and the trace step, not thrown. |
| The store fails for any other reason | `AxWorkingStateStoreError` is THROWN. A store that cannot be written to is not a recoverable in-run condition. |
| `maxParksPerGoal` exceeded for a goal | The goal is forced to `blocked` with a harness-authored blocker naming the park reason codes. The run continues. |
| `maxParksPerRun` exceeded | `AxWorkingStateParkBudgetError` is THROWN out of `forward()` as a typed error the host catches. No completion payload is fabricated. |

## Parks

A parked delta is **recorded, visible, not applied, retryable,
budget-bounded** — exactly the contract `AxEventEffect.status: 'parked'`
carries in the event runtime. Three channels:

1. `AxWorkingStateDocument.parked`, rendered into the read-only prompt region.
   The retained record is the op KIND and the harness-owned canonical path —
   never the model's own pointer text, never its `value`.
2. One guidance entry in the trusted guidance log, built exclusively from
   harness enum codes, the op kind, the canonical path, the goal id and the
   `expects` list. **No model-authored string ever reaches the guidance log**,
   because `guidanceLog` is the trusted instruction channel while `actionLog`
   is explicitly untrusted; rendering an attacker-controlled path or value into
   it would launder untrusted text into the highest-authority prompt region.
3. The trace record's `parked` array and the commit outcome's `parked` array.

**Deduplication caveat.** `appendGuidanceEntry` collapses a consecutive entry
with the same `triggeredBy` and identical text into the previous one. Repeated
identical parks therefore show as ONE guidance entry, not N. The per-park
record lives in channels 1 and 3.

The `parked` array keeps the most recent `maxParksPerRun` entries, oldest
evicted.

### The canonical path (why filtering is not enough)

`AxWorkingStateClassifiedOp.canonicalPath` is derived from the CLASSIFICATION,
not from the model's path string, and it is the only pointer that reaches the
guidance channel or the read-only roster. Every segment comes from a closed
vocabulary the harness owns:

| Class | Canonical path |
|---|---|
| goal-scoped | `/goals/<id>` plus one of `status`, `goal`, `blocker`, `evidence/-`; `<id>` has already passed `^[A-Za-z0-9_.:-]{1,64}$` |
| `fact_write`, admissible | `/facts/<root>`, where `<root>` is a field the HOST declared in `stateSignature` |
| `fact_write`, parked | `/facts/<undeclared>` — never the segment the model wrote |
| `guard` | `/<guard>` |
| anything else | `/<reserved>`, or `/goals/<id>/<reserved>` when the goal id is known |

A character-class filter would not do: `/facts/IGNORE.ALL-PRIOR_RULES:AND/SHIP`
is spelled entirely in pointer-legal characters, and `axValidateStatePatch`
allows 64 ops per patch, so a filter leaves a per-turn injection channel of
several kilobytes into the highest-authority prompt region. Rebuilding the
pointer closes it by construction. The typed
`AxWorkingStateForbiddenPathError` on the commit outcome still carries the RAW
pointer, because the host's audit trail is not a prompt.

## Prompt regions

| Region | Field | Cached | Contents | Model may patch |
|---|---|---|---|---|
| State contract | `stateContract` | yes — constant for the run | Declared fact fields with types; the goal statuses; the legal path shapes | no |
| Writable state | `workingState` | no | Goals (id, text, status, evidence refs, blocker, expects) and facts, bounded by `maxRenderChars`, ordered by `createdTurn` then id | **yes** |
| Read-only harness region | `receiptRoster` | no | The receipt roster (`ref`, `qualifiedName`, `turn`, newest first, bounded by `maxRosterEntries`) and the parked ledger | no |

The roster line format is exactly `r7  inventory.pick  turn 4`. The
fingerprint is NOT rendered: it is an audit value, and the citable handle is
the `ref`. The protection is **set membership in a harness-owned append-only
list**, not secrecy of a hash — the actor authors the arguments and holds the
result, so it sees every input to the digest.

`renderWritable()` drops goal text before it drops goals: it re-renders every
goal as id + status when the full rendering exceeds `maxRenderChars`. That
compact form is itself truncated at the limit, so the guarantee is "text is
sacrificed before goals are", not an absolute one — size `maxRenderChars` for
the goal count you expect (roughly 24 chars per goal in the compact form).

## The `skillState` memory mode

`actorMemoryMode: 'skillState'` replaces action-log replay with *frozen skill
spec + typed state + latest observation*. It is opt-in, requires BOTH
`workingState` and `skillState`, and is refused at `agent(...)` construction
otherwise (`skillstate_requires_working_state`, `skillstate_requires_skill`,
`unresolvable_skill_spec`).

| Prompt region | `transcript` (default) | `skillState` |
|---|---|---|
| Stable system prompt | role/stage rules, primitives, module list, callable signatures, output contract | unchanged, plus `skillSpec` and `stateContract` in the cached field set |
| Cached working inputs | task inputs, `contextMetadata`, `contextMap`, `memories`, `executorRequest`, `distilledContextSummary`, `discoveredToolDocs`, `loadedSkills`, `summarizedActorLog` | the same **minus `summarizedActorLog`** |
| Dynamic turn tail | `guidanceLog`, `actionLog`, `liveRuntimeState`, `contextPressure` | `guidanceLog`, `workingState`, `receiptRoster`, `latestObservation`, `liveRuntimeState`, `contextPressure`. **No `actionLog`.** |
| Actor outputs | `javascriptCode` | `javascriptCode`, `statePatch` (`f.json().optional()`), `rationale` (`f.string().optional()`) |

Both new outputs are **optional**, and that is load-bearing. The actor stage is
a transport-shaped program; a required second output would turn a turn with
nothing to record into a parse failure, therefore an error turn, therefore a
possible executor-model escalation. An absent `statePatch` means the trace
records `proposal: 'none'` and `outcome: 'unchanged'`.

The action log is not merely omitted from the prompt: it is never rendered, and
checkpoint summarization is skipped entirely, because the actor signature
declares no `summarizedActorLog`. A checkpoint would otherwise be rendered,
summarized **by a model call**, and then dropped. That is the difference
between removing the transcript and hiding it.

`rationale` is read, hashed with `axEventCanonicalDigest`, stored as
`AxSkillStateTransition.rationaleDigest`, and dropped. It is never written to
the action log, never rendered into a later prompt and never persisted, so two
runs can be proved to have reasoned identically without retaining what they
said. An ABSENT rationale produces no `rationaleDigest` at all: "declined to
explain" and "explained with an empty string" are different events, and the
audit record keeps them distinguishable.

A refused turn is observed too. The code-policy branch (a non-final turn with
no `console.log`, or multiple fenced code blocks) never executes the actor's
code, and in this mode the observation window is the ONLY history, so the
refusal itself is recorded as the latest observation rather than left visible
only through the guidance entry.

Only ACCEPTED transitions enter `transitions()`; every attempt is reported
through `AxSkillStateConfig.onTransition` (fail-soft, like `onTrace`). The
rejection vocabulary is:

| `rejection` | Cause | Store touched |
|---|---|---|
| `schema` | the patch document is not a valid state patch | **no** |
| `authority` | the patch addressed a harness-owned path; the whole patch is refused | no |
| `fence` | the compare-and-set lost twice (once after the bounded rebase), or the delivery fence rejected the write | attempted |
| `invariant` | the kernel or the host checker refused every delta | attempted |

`committedRevision` is non-optional in every configuration, because the store
is never absent: it defaults to `AxInMemoryProgramStateStore`. The rejection is
decided by the error's typed `code` through `axIsWorkingStateError`, not by
`instanceof`, so two copies of the package in one process cannot downgrade an
`authority` or `fence` rejection to "nothing was refused".

`AxSkillStateStep.state` is the STORED envelope, and its `revision` always
equals the kernel's `currentRevision()` — including after the bounded rebase a
losing compare-and-set performs — so a host can use it as the expected revision
for its own `compareAndSet`. It is not the same view as the kernel's
`current()`: a parks-only turn appends to the model-visible parked ledger
without a store write, so `current().parked` can carry entries
`step().state.state.parked` does not.

### Measured equals sent

The budget meter measures the SAME value record the turn sends. `buildActorPromptValues`
builds it once, `measureActorPromptChars` takes it, and the turn sends it —
rather than two call sites agreeing to re-derive the same thing. Two fields are
structurally outside the measured window and are documented here rather than
papered over:

- `contextPressure` is DERIVED from the measurement, so counting it would move
  the budget it reacts to;
- the over-budget `inspectRuntime` hint is appended after the measurement for
  the same reason.

With `contextPolicy: { preset: 'full' }` neither is rendered, and
`budget_check.mutablePromptChars + fixedPromptChars` equals the summed length
of the message contents actually sent, EXACTLY, in both substrates. That
equality is asserted in `agent.skillState.test.ts` and was verified falsifiable
by dropping one region from the measured record.

### What `skillState` does not fix

The mode trades a long-context error for a state-projection error. Two things
keep that honest: every transition passes the same verifier gate as the
transcript path, and the store is never absent, so prior revisions are
recoverable. With only the default in-memory store, though, the discard **is**
irreversible once the process exits — supply a durable `store` if that matters.

The dynamic tail is bounded by `maxRenderChars`, `maxRosterEntries` and
`maxObservationChars`, so it does not grow with the TURN count. It does grow
with the size of the goal ledger, which is a task-size term the mode neither
removes nor claims to.

The transcript leaves the PROMPT, not the process. `actionLogEntries` still
grows for the whole run, `manageContext` still walks every entry each turn, and
each entry's `output` and `chatLogMessages` stay resident — so the loop's
per-turn context bookkeeping is still quadratic in the turn count even though
the prompt is not. A host that enables `tombstoning` will additionally pay for
MODEL-BACKED tombstones over text this mode never renders; leave it off under
`skillState` unless a transcript consumer needs them.

`onTransition` is awaited with no timeout and no abort signal, exactly like
`onTrace` and `onFunctionCall`. A throwing sink is fail-soft; a sink that never
settles stalls the turn, so a sink that can block should bound itself.

## What the gate does NOT gate

`completionPolicy` defaults to `'observe'`: working state does **not** gate the
run's report. A ledger with pending goals does not stop a `final()`. The
benchmark asserts only the park, never a claim about the run's answer.

`completionPolicy: 'interlock'` converts a `final` payload raised while goals
are pending into a `guide_agent` payload through the actor loop's existing
guidance handling — no completion shape is invented — bounded by
`maxCompletionInterlocks` (default 2). After the budget is exhausted the
`final` stands and the trace records `exhausted`, so an over-strict checker
cannot produce an infinite re-drafting loop.

## Stage scoping and the run id

`AxAgentStagePolicy.maintainsWorkingState` is `false` for the distiller and
`true` for the executor. The justification is already in the policy table: the
distiller's callables are throwing stubs (`executesTools: false`), so it can
mint no receipt and can support no `done`; a ledger it maintained would be
evidence-free by construction. Both stages would otherwise resolve the same
store key and conflict.

The pipeline mints ONE run id per `forward()` (shape `ws:<programId>:<n>`),
which is what the default store key `ax.workingState:<runId>` is built from —
so two runs never conflict. `runIdFactory` overrides it for deterministic
tests. `getWorkingState()` returns `undefined` after a direct-respond run that
ended at the distiller.

## The trace (Gamma)

One record per actor turn under `trace: true`. Bounded and fingerprinted like
causal candidate evidence: digests only, never raw payloads, never PII.

`axWorkingStateTraceDigest(step)` hashes every deterministic field — that is,
everything except `runId`, `at` and `summary`, which are not reproducible by
construction — so two runs of the same scripted turns compare equal **under an
injected clock**. `believedStateDigest` and `committedStateDigest` hash the
document, and a parked delta records its `parkedAt` from the clock; under the
default `AxSystemEventClock` two runs that park anything therefore differ.
Pass an `AxManualEventClock` (or any host clock) when you need to compare
digests across runs.

**Placement.** The record lives in `src/ax/agent/workingState.ts`, beside the
only thing that can produce it. It is deliberately NOT an `AxInteractionEvent`
(that union is a closed set of interaction observations under a public
versioned schema, with a projection budget tuned for media frames, and a Gamma
step is not an interaction observation), and deliberately NOT an
`AxAgentRecursiveTraceNode` (its unit is an agent invocation node with
children and usage, with no fields for a proposal or a verdict, and the
optimize judge already reads it).

**Join key.** `turn` is the same 1-based counter as `ActionLogEntry.turn` and
`AxAgentRecursiveTurn.turn`, and `runId` is per-`forward()`. A future producer
of `AxAgentRecursiveTraceNode` joins on `(runId, turn)` with no schema change
on either side.

## Call-time skill injection

Opt-in per exact qualified callable, through `AxAgentOptions.callTimeSkills`.
When the actor drafts a call to a bound callable the harness does **not**
execute it: it returns a frozen not-executed marker, loads the binding's skill
through the existing loaded-skills channel, appends harness-authored guidance
to the trusted guidance log, and lets the model re-draft on the next turn.
Independent of working state except for the optional `when` predicate.

```ts
callTimeSkills: [
  { qualifiedName: 'inventory.adjustStock', skill: 'stock-adjustment' },
];
```

### The two hooks

**Hook 1 — the logical path.** `runLogicalCall` (`runtimeGlobals.ts`) consults
the binding **before** `authorizeCall`, before `onFunctionCall` and before
`observeResult`. An intercepted call therefore:

| Contract | Intercepted | Unbound |
|---|---|---|
| the function body runs | no | yes |
| an authorization decision is requested | **no** | yes |
| `onFunctionCall` fires | no | yes |
| `functionCallRecorder` records | no | yes |
| a working-state receipt is minted | **no** | yes when eligible |

The last row is the load-bearing one: a skill injection can never support a
goal completion, because a receipt is the only thing that flips a goal to
`done`.

The marker is **returned, not thrown**. A thrown error is caught by the runtime
and tagged `'error'` on the action log, which feeds `noteActorTurnErrorState`
and can escalate the executor model. An interception is not a failure and must
not look like one.

**Hook 2 — the speculation path.** `runLogicalCall` is not the only way into a
wrapped function. For a `kind === 'external'` callable,
`setJSRuntimeHostFunctionSpeculationAdapter` installs a `launch` closure that
calls `authorizeCall` and the function **directly**, and `commitSpeculativeCall`
then reaches `observeResult`. On any callable the host placed in the runtime's
speculation allowlist, a binding hooked only at `runLogicalCall` would not
prevent execution, *would* request authorization, *would* fire
`onFunctionCall`, and *would* mint a receipt.

The fix is one guard at the **installation** site: a bound callable gets **no
speculation adapter at all**, so there is no second entry point to guard. This
is preferred over a construction-time refusal against the runtime's frozen
speculation table, which `src/` exposes no accessor for — a refusal built on a
table this repo cannot read would be unimplementable today and would silently
no-op if the accessor changed shape. A construction-time diagnostic may be
added later as a *secondary* signal.

Binding a callable therefore changes how it is dispatched even on turns that
are not intercepted: it loses speculation for the whole run. That is the
deliberate cost of having exactly one entry point.

### Budgets, predicates and validation

`maxInjections` (default 1) bounds injections per callable per run. Past the
budget the tool executes normally — the interception is a one-shot nudge, never
a gate — so an unhelpful skill cannot trap the actor in a re-draft loop. A
`when` predicate that returns `false` falls through **without** spending
budget, so an early "not yet" does not disable the binding for the rest of the
run.

A `when` predicate that **throws** — or a working-state read that does — falls
through to the normal call path and the callable behaves exactly as an unbound
one. `intercept()` runs synchronously inside the actor's `await tool(...)`, so a
propagated throw would become an `isError` turn and escalate the executor model;
and since the budget is charged after the predicate, every re-draft would throw
again with nothing bounding it. A predicate result that is not exactly `true`
(an accidental `async when` returns an always-truthy Promise) does not
intercept.

Refused at construction: a glob in `qualifiedName`, two bindings for one
callable, `maxInjections` below 1, non-integer or above 100, a skill id that
does not resolve against the effective `skillsCatalog`, an inline skill with no
body text, and a `when` predicate with no `workingState` to read.

Refused at **run start**, not at construction:

- a binding naming a callable this run does not register
  (`unknown_bound_callable`). MCP and UCP callables only exist once the run's
  execution context does, so a constructor-time check would reject every
  legitimate `mcp.*` binding. Every registration site — executing or stubbed —
  registers its name, so the check sees the full surface;
- a binding naming a catalog skill the run's two catalog gates hid
  (`ineligible_bound_skill`, `denied_bound_skill`). See below.

Every call-time configuration failure is an `AxWorkingStateSchemaError` whose
`subsystem` is `'Call-time skill'` and whose `detail` is the `<key>: <value>`
pair above.

### A binding does not bypass the catalog gates

A binding is static host configuration; the two catalog gates are not.
`requires` eligibility is resolved against the run's declared
`skillPolicy.environment`, and the retrieval-time authority re-check
(`axSkillRetrievalGate`) is time- and authority-varying — an expired grant or a
revoked trajectory parks a skill mid-lifecycle, long after the binding was
written.

So a bound **catalog id** is re-asked at run start through the same admission
verdict `discover({ skills })`, the `### Available Skills` index, the relevance
hint and the kernel tier use, and the run is **refused** when either gate hid
it. Refusing is deliberate over the two alternatives: silently dropping the
skill while still intercepting would leave the actor blocked on a call it may
not make with no procedure to read, and silently executing would make both
gates advisory. "The host named it by id" is not an answer — that is exactly
the argument the gates exist to overrule.

An **inline** skill is not gated: it is host-supplied literal text with nothing
to be eligible for and no provenance to re-check, the same posture as
`presetSkills`.

### Delivery and the trace

The skill is ingested with `ingestSkillResults` into the ordinary loaded-skills
prompt state; there is no parallel prompt section. The guidance entry is
harness-authored and names only the callable and the skill id, because
`guidanceLog` is the *trusted* prompt region and the action log is the
untrusted one. Both take effect on the next turn's prompt, which is the
re-draft point.

`onLoadedSkills` fires for an injected skill, fire-and-forget, exactly as it
does on the ordinary load path: a host auditing which skill bodies reached the
model must see call-time injections too.

Gamma records the intercepted turn with `action.executed: false`. That flag
reports the turn's **weakest** guarantee — at least one drafted call did not
run — so a mixed turn is `{ executed: false, calls: ['inventory.pick'] }`.
`action.calls` stays the exact record: forcing it empty would hide a real call
made alongside an intercepted one.

## Build versus buy: the RFC-6902 subset

`src/ax/agent/statePatch.ts` implements `add`/`remove`/`replace`/`test` in one
dependency-free module rather than adding `fast-json-patch` or `rfc6902`.

- `src/ax/package.json` has exactly one runtime dependency
  (`@opentelemetry/api`) and builds `platform: 'neutral'`. Adding a second
  would be a visible break with that posture.
- The behaviour must be re-expressible as AxIR Core ops in five target
  languages, so the semantics have to be owned here anyway.
- `move` and `copy` are deliberately excluded: their provenance is ambiguous
  (the resulting value has two paths and no single origin), which makes them
  unclassifiable against an evidence gate. A library would ship them.
- Exit path: if the subset ever needs to grow into full RFC 6902 with
  patch generation and diffing, `axValidateStatePatch` / `axApplyStatePatch`
  are the only two call sites and can be re-pointed at a library behind them.

## Relationship to the event runtime

Shared: `AxEventVerifierResult` is imported verbatim as the checker's verdict
type — one verdict vocabulary across the repo — and the parked vocabulary
(`op`, `reason`, `parkedAt`, `attempt`) is copied from the effect ledger so
"parked" means the same thing in both. `AxProgramStateStore`,
`AxProgramStateEnvelope`, `AxEventClock` and `axEventCanonicalDigest` are
reused as-is.

Not shared: `AxEventVerifierPolicy.verify` is arity-2 over a durable
`AxEventRun` an agent turn does not have, so `AxWorkingStateCheckerPolicy.check`
is arity-1 over an agent-turn context. Every LIMIT field is mirrored; the
verify BODY is not portable, and this document does not claim it is.

`AxWorkingState` runs inside one `forward()`. It may be persisted through an
injected `AxProgramStateStore`, but it does not require an `AxEventRuntime`,
does not publish events, and never wakes anything.

## Evaluation and its honest limits

`scripts/eval-working-state.ts` (`npm run agent:workingstate:eval`) and
`src/ax/agent/benchmarks/working-state.test.ts` run the same deterministic,
zero-cost sweep over four horizons and three arms: `baseline` (transcript, no
working state), `working-state` (transcript WITH the state document beside it)
and `skill-state` (`actorMemoryMode: 'skillState'`).

At horizon 100 (eval script, zero API calls):

| arm | mean mutable prompt chars/turn | model calls | peak prompt chars | recovery turns |
|---|---|---|---|---|
| `baseline` | 11341 | 191 | 32562 | 19 |
| `working-state` | 17650 | 198 | 37970 | 0 |
| `skill-state` | 7589 | 102 | 18098 | 0 |

Mutable-tail growth from horizon 50 to 100: `baseline` 2.50x,
`working-state` 1.77x, `skill-state` 1.44x.

This is **mechanism evidence, not model quality**. The AI is a deterministic
mock; the scenario is a warehouse state machine, which is close to a best case
for state-as-substrate; the proposer is a deterministic host callback, so the
built-in model-backed proposer's cost is not measured. Accuracy is asserted
only as NOT WORSE.

Two costs are reported rather than hidden. Working state **alone** adds prompt
characters: the state document and the receipt roster ride beside the action
log, and only `skillState` removes the action-log growth term. And the
`skill-state` arm still grows (1.44x), because the scenario seeds one goal per
order — the goal ledger is a task-size term the mode does not remove. With a
fixed goal set the per-turn characters are flat, which is what the unit-scale
assertion in `agent.skillState.test.ts` measures.

`cumulativeTokens` counts only the actor and responder usage the mock reports;
it does not count the checkpoint-summarizer calls the transcript arms make.
`modelCalls` is therefore the honest cost proxy, and it is the column the
`skill-state` arm is compared on.

## AxIR status

Working state is **not ported to AxIR**. It is recorded in the backlog as
`axir-2026-09-02-verifier-gated-typed-working-state-for-the-actor-loop`.

Its kernel is pinned by `scripts/fixtures/working-state-commit.json`, executed
against the real kernel by `scripts/working-state-conformance.test.ts` in the
root `npm test` chain. The `skillState` transition semantics are pinned the
same way by `scripts/fixtures/skill-state-transition.json` and
`scripts/skill-state-conformance.test.ts`.

That fixture deliberately does **not** live under `ir/conformance/`. Every
directory there is enumerated by machinery that assumes the generated language
packages can execute it — `conformanceSuitePaths` runs the listed suites
against every target, and the perturbation gate samples every subdirectory —
so a fixture for an unported behaviour placed there either fails all five
targets or invites reshaping it until a target can "pass" without implementing
the behaviour. When working state is migrated into AxIR, the fixture moves
into the target-executed suite in the same change that makes every target able
to pass it.

## Known gaps

- **Receipt laundering.** Nothing forbids two goals that both name the same
  callable citing the same receipt. A per-goal receipt-consumption rule was
  considered and rejected as premature — it breaks legitimate cases such as
  one batch call completing three picks. A host wanting single-use receipts
  enforces it in its checker, which has the full receipt set in its context.
- **Checker as rubber stamp.** A host that writes `check: () => ({status:'pass'})`
  disables the fact-space gate. The kernel rules still hold regardless, which
  is exactly why they are kernel rules.
- **Model-authored goals.** A host that enables `allowModelAuthoredGoals` with
  a broad `expectsAllowlist` can still be farmed inside that allowlist. A goal
  created and closed in ONE patch is held to the `expects` it declares in that
  same patch, and a completion of a goal the kernel never admitted parks — but
  neither rule can make a permissive allowlist strict.
- **Receipt ledger growth.** `receipts()` grows with each distinct eligible
  dispatch for the life of the run and `snapshot()` serialises all of it into
  `AxAgentState`. Only the rendered ROSTER is bounded (`maxRosterEntries`).
  The ledger is bounded in practice by the run's own call budget; a host that
  needs a hard cap serialises its own trimmed state.
- **Call-time injection costs a bound callable its speculation.** The adapter
  is not installed for a bound name, so binding a hot tool that the host had
  allowlisted for speculation removes that optimisation for the whole run. This
  is deliberate — it is what leaves exactly one entry point to guard — but it is
  a real cost, and it is why binding is per exact name rather than per
  namespace.
- **Call-time injection is not an authorization or safety gate.** It is one
  budgeted nudge: past `maxInjections` the tool executes. Anything that must
  not run belongs in the authority layer, not here.
- **Per-run harness state is held per agent INSTANCE, not per `forward()`.**
  The working-state receipt sink and the call-time binding table are both
  rebuilt at the start of each run and stored on the instance, so two
  overlapping `forward()` calls on ONE agent share the injection ledger and the
  observation buffer, or clobber them mid-flight. Concurrent runs need separate
  agent instances.
