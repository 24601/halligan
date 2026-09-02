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
| Receipt eligibility | Harness, explicit flag, never inferred | Set at each registration site: `true` for MCP bindings, UCP bindings and user tools; `false` for agent-derived callables (`_kind: 'internal'`, which every child agent normalizes to). A child agent's return value is its own `final()` payload — model self-report — and promoting that to environment evidence would make the mechanism circular. |
| `llmQuery` | Never a receipt | It does not reach the function-call recorder and is never given a receipt-eligible dispatch site. Stated so a later refactor does not silently make an LLM sub-query into environment evidence. |
| Receipt `at` | Harness, at the dispatch site | Captured from the injected clock when the call returned, not at turn-hook time. |
| The checker | Host | Host-declared, deterministic limits, fail-closed. |
| The forbidden-path set | Harness, fixed | Not configurable. See the classification table. |
| Any unclassified path shape | Harness, fixed | `forbidden` by the catch-all. The table is closed, not open. |
| The receipt rule for `goal_complete` | Harness, fixed | A checker `pass` cannot commit a completion with no qualifying receipt. |
| Clock, store, park budgets, run id | Host, injected with defaults | Deterministic tests, portable semantics. |
| The patch, goal text, `blocker` prose, rationale | Model | Untrusted content. Never interpreted as instructions, never rendered into the trusted guidance channel. |
| `S`, the fact space | Host, via `stateSignature` | Ax never interprets facts; it only bounds which paths a `fact_write` may touch. |

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
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `park` (`no_supporting_receipt`) | No ref cited at all. |
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `park` (`unknown_receipt_ref`) | A cited ref is not in the receipt set. |
| `/goals/<id>/status` → `'done'` | `replace` | `goal_complete` | `park` (`receipt_not_expected`) | Cited receipts exist but none matches `expects`. |
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
| A forbidden path, or a path no row classifies | Whole patch rejected, guidance `forbidden_path`. The error is recorded, not thrown into the actor turn — throwing would poison the error-escalation policy. |
| The checker throws | Every admissible non-guard delta parks `checker_error`. |
| The checker exceeds `timeoutMs` | Every admissible non-guard delta parks `checker_timeout`; the pending check is aborted and its listener removed. |
| The checker exceeds `maxChecksPerRun`, `maxTokens`, `maxWallTimeMs` or `maxCostUSD` | Every admissible non-guard delta parks `checker_error`. |
| `compareAndSet` rejects on a revision mismatch | Reload, re-classify the surviving ops against the reloaded document, retry ONCE. A second conflict parks `revision_conflict`; `AxWorkingStateConflictError` is recorded, not thrown. |
| The store fails for any other reason | `AxWorkingStateStoreError` is THROWN. A store that cannot be written to is not a recoverable in-run condition. |
| `maxParksPerGoal` exceeded for a goal | The goal is forced to `blocked` with a harness-authored blocker naming the park reason codes. The run continues. |
| `maxParksPerRun` exceeded | `AxWorkingStateParkBudgetError` is THROWN out of `forward()` as a typed error the host catches. No completion payload is fabricated. |

## Parks

A parked delta is **recorded, visible, not applied, retryable,
budget-bounded** — exactly the contract `AxEventEffect.status: 'parked'`
carries in the event runtime. Three channels:

1. `AxWorkingStateDocument.parked`, rendered into the read-only prompt region.
   The retained record is the op KIND and a sanitized bounded path — never the
   model's `value`.
2. One guidance entry in the trusted guidance log, built exclusively from
   harness enum codes, the op kind, a sanitized pointer of at most 128
   characters, the goal id and the `expects` list. **No model-authored string
   ever reaches the guidance log**, because `guidanceLog` is the trusted
   instruction channel while `actionLog` is explicitly untrusted; rendering an
   attacker-controlled path or value into it would launder untrusted text into
   the highest-authority prompt region.
3. The trace record's `parked` array and the commit outcome's `parked` array.

**Deduplication caveat.** `appendGuidanceEntry` collapses a consecutive entry
with the same `triggeredBy` and identical text into the previous one. Repeated
identical parks therefore show as ONE guidance entry, not N. The per-park
record lives in channels 1 and 3.

The `parked` array keeps the most recent `maxParksPerRun` entries, oldest
evicted.

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

`renderWritable()` always shows every goal's id and status even when it must
truncate goal text, so truncation can never hide a goal.

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
construction — so two runs of the same scripted turns compare equal.

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

## Build versus buy: the RFC-6902 subset

`src/ax/agent/statePatch.ts` implements `add`/`remove`/`replace`/`test` in
about 250 lines rather than adding `fast-json-patch` or `rfc6902`.

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
zero-cost sweep over four horizons and two arms.

This is **mechanism evidence, not model quality**. The AI is a deterministic
mock; the scenario is a warehouse state machine, which is close to a best case
for state-as-substrate; the proposer is a deterministic host callback, so the
built-in model-backed proposer's cost is not measured. Accuracy is asserted
only as NOT WORSE. And PR 1 **adds** prompt characters rather than removing
them: the state document and the receipt roster ride beside the action log.
Removing the action-log growth term is the `skillState` memory mode, which is
a separate change.

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
  a broad `expectsAllowlist` can still be farmed inside that allowlist.
