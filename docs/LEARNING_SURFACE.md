# Learning Surface (`src/ax/learn/`)

Normative contract for the opt-in learning surface: serve → observe → grow →
nominate. Browser-safe; nothing under `src/ax/learn/` imports `node:*`.

Ax could already *decide* whether a candidate change is good —
`agent.playbook().evolve()` holds the repository's strongest promotion gate.
What it could not do was **remember what it served**, **accept late feedback
that names one served exchange**, or **record the accepted result as a
versioned artifact anybody can pull**. This surface supplies exactly those
three organs and nothing else.

## What this does NOT promise

Stated first, because everything below is easier to misread than to read.

- **No canary, no staged rollout, no online monitoring, no automatic
  demotion.** A nomination is a durable, queryable decision; it is not a
  deployment system and it does not observe production.
- **No automatic promotion.** `axHarnessEvolve` appends `current: false` and
  returns `status: 'nominated'`. `promote(...)` is a separate compare-and-set
  and **nothing inside Ax calls it**. Human release authority is the
  mechanism, not a convention.
- **`evaluatorId` is never validated.** The caller owns the task set, the
  split, the metric and the evaluator identity; Ax records what it is told.
- **Split independence is not checked semantically.** Task-id equality is the
  only contamination check. Two semantically duplicated tasks with different
  ids stay undetected.
- **`contentId` is identity, not tamper-evidence.** It is a full `sha256:` over
  the canonical admitted entry list. It answers "is my copy current"; it does
  not attest who wrote the tree.
- **The proposer and the judge are not guaranteed to be independent.** When no
  `metric` is supplied, `axHarnessEvolve` builds an LLM judge, and an LLM judge
  correlated with the proposer will happily grade the proposer's own habits as
  good. Ax refuses to arrive there silently: `teacherAI` set with no `judgeAI`
  and no `metric` throws `AxHarnessEvolveConfigError{ field: 'judgeAI' }`, and
  naming the same service for both emits a progress event saying so. What Ax
  cannot do is make an LLM judge independent. A deterministic `metric` is the
  only configuration in which the gate is a measurement rather than an opinion.
- **The credential tripwire is a heuristic.** It matches known key *names* and
  known literal *shapes*. A novel credential format under an innocuous key is
  not caught. It is not a secret scanner.
- **Ax schedules no record cleanup and exposes no delete API.**
  `markConsumed` marks; the in-memory store's `maxRecordsPerScenario` cap is
  the only thing that ever removes a record, it never removes a report or a
  live-referenced interaction, and it counts every eviction. A durable store
  owns and documents its own retention policy.
- **`axHarnessEvolve` must not run concurrently with `forward()` on the same
  agent instance.** It swaps installations per episode. No type or runtime
  check enforces this.
- **The agent's `learning: { … }` config does not configure the training
  projection.** It configures recording only. `sampleFields`, `maxSampleBytes`
  and `maxParkedReports` are options on `axCreateLearningEngineState`, because
  the engine is the thing that turns records into a batch and the agent never
  builds one. There is deliberately no agent-side alias: a projection option
  declared where nothing reads it is a containment control that does nothing.

## Records

```ts
type AxLearningRecord =
  | Readonly<AxLearningInteractionRecord>
  | Readonly<AxLearningReportRecord>;
```

An interaction carries `{ kind, id, scenario, createdAt, artifactRef?, payload }`
where `payload` is `{ signature, programId, input, output? | failure?, model?,
usage?, tags? }`. Exactly one of `output` / `failure` is present.

A report carries `{ kind, id, scenario, createdAt, references, payload }` where
`payload` is `{ score?, feedback?, metadata? }`.

Every caller-supplied value passes `axAssertPersistableValue` at construction. A
`Date`, `Map`, `Set`, class instance, non-finite number or cycle throws
`AxLearningRecordValidationError` with the JSON path **before** anything is
appended, rather than being silently coerced later.

### Provenance

| # | Invariant |
|---|---|
| I1 | `artifactRef` names what the agent was **serving** — read from the live installation, never from the store head. No installation ⇒ **no ref**. |
| I1b | A serve under a tree the chain has moved past records `stale: true` with the head's `contentId` beside its own. When no head has ever been observed, `headContentId` is absent and `stale` is `false`: nothing is *known* to supersede the installed tree. |
| I2 | `run()` does not resolve until the record is durable. No receipt without a record. |
| I2b | Recording lives outside the agent runtime scope, so a bookkeeping failure can never report a successful agent run as errored. |
| I3 | A run that throws records nothing unless `recordFailures: true`; then it records `{ name, message }` with no stack and still rethrows. |
| I3b | A bare `forward()` records nothing. `streamingForward()` is not recorded at all. |
| I4 | Only interaction ids are receipts. A reference naming a report record is refused. |
| I5 | Unknown top-level report keys are dropped. |
| I6 | `metadata.training.eligible` is the one metadata key the framework reads, and only the literal `false` opts out. |
| I7 | Recording failure is not best-effort: the default is rethrow, and `onRecordError` is an explicit opt-out. |

## Store port

`AxLearningStore` is a port a host may implement. Its capability descriptor is
`{ durability, coordination, compareAndSet, conformance? }`, and a surface
refuses `publish`, `promote` and `rollback` against a store whose
`compareAndSet` is false.

| # | Invariant |
|---|---|
| I9 | A consumed id re-appended is a silent no-op with `reason: 'duplicate'`. |
| I10 | A report whose references are all consumed is accepted and ignored: `inserted: false`, `reason: 'references-consumed'`, and the SUBMITTED record comes back. |
| I11 | Same id + canonically identical content (excluding `createdAt`) dedupes. Same id + different content raises `AxLearningRecordConflictError`. |
| I12 | There is no delete path. See "What this does not promise". |
| I13 | `sequence` is monotonic per scenario and never reused. |
| I14 | `page` is a pure cursor. The store keeps no per-consumer state. |
| I15 | Every async method takes a trailing `signal?: AbortSignal` and removes its abort listener on settle. |

A host implementation must pass `runAxLearningStoreConformance(createStore, {
clock })`. Its cross-instance compare-and-set assertions are reported in
`skipped` for a single-writer store rather than silently passing.

## Eligibility

`train` / `wait` / `never`, with named and permanently counted `never` reasons.
`wait` happens exactly when a referenced interaction has not arrived, and
carries the missing ids; a `wait` with no missing reference is a programming
error and throws. Late and out-of-order feedback is a legal ordering, not a
fault.

Schema validation happens at ingress, in `report()`. A schema-invalid report
never becomes a record and therefore never reaches the reducer — which is why
`'schema-invalid'` is not a never-reason.

## Harness tree admission

Three kinds: `instruction`, `playbookBullet`, `skill`. `axInspectHarnessTree`
returns a verdict for **every** entry; `axAdmitHarnessTree` throws on the first
denial while attaching the full report. Admission runs at seed, on every
proposal, and whenever persisted state loads.

| Rule | Reason code |
|---|---|
| ids unique, non-empty, no `:` (the installer builds slot names from them) | `duplicate-entry-id` / `invalid-entry-id` |
| `kind` is one of the three | `unknown-kind` |
| `config` carries exactly the declared keys for its kind | `unknown-config-key` |
| `instruction.text`, `skill.content`, `playbookBullet.content`, `playbookBullet.section`, `skill.name` non-empty after trim | `empty-text` |
| `skill.skillId` and `playbookBullet.id` match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` — the rule lands on the **id**, the dedup key, not on the human title | `invalid-name-segment` |
| a bullet carrying `helpfulCount`, `harmfulCount`, `createdAt`, `updatedAt`, `revision`, `lineage` or `evidence` — **rejected, never stripped** | `forbidden-bullet-field` |
| every `config` value JSON-persistable | `non-json-config` |
| credential tripwire rule 1: a key whose NAME ends in a credential word holding a string, or an array containing one — anywhere in any entry | `inline-credential` |
| credential tripwire rule 2: a VALUE matching a known credential literal — anywhere in any entry, including model-authored free text | `credential-shaped-literal` |
| two entries rendering onto one target | `duplicate-render-target` |
| entry > 64 KiB, or tree > 1 MiB, canonical JSON | `oversized-entry` / `oversized-tree` |

Errors and inspection rows carry the **path**, never the value. A `disabled`
entry is excluded from render but still validated and still persisted.

## Installation

`axRenderHarnessTree(tree, { now })` is pure — `AxACEPlaybook` cannot be
produced without a timestamp, so the caller supplies one from its injected
clock. `now` is not part of `contentId`.

`axApplyHarnessTree(tree, target, options, signal?)` writes through the
structural `AxHarnessInstallTarget` port and returns an exact, idempotent
`dispose()`. It refuses a target that already carries an installation, so "what
is installed" stays single-valued — which is what makes a record's
`artifactRef` honest.

**The install is a function of the target, not of the tree.** Whenever the
target has a playbook handle, the install replaces the playbook — including
with the empty rendering of a tree that carries no bullets, because a tree with
no bullets is a tree that says "serve no bullets". Leaving prior bullets in
place would make the agent serve release X plus content that is in no release,
and every record stamped with X would be a lie. The same rule applies to the
skills slot, except that a slot this installer never had anything in is left
alone, so an instruction-only tree does not inherit the setter's refusal of a
host `onSkillsSearch`.

A target with continuous playbook learning is refused unless
`acknowledgeContinuousPlaybookReset: true` — on **every** install, not only on
one carrying bullets, because the reset is what the guard exists for. The
resulting `discardedBulletCount` is reported, never silent.

`dispose()` attempts every channel and raises an `AggregateError` listing what
it could not put back, and deregisters the installation either way: a target in
an unknown state must not keep claiming to serve a release.

## Release chain

| # | Invariant |
|---|---|
| I16 | Appends move only by compare-and-set on the tail; the head moves only by compare-and-set on the head. A stale expectation throws `AxLearningReleaseConflictError` with its `operation` and changes nothing. |
| I16b | `publish()` **never** sets `current: true`. The only ways a release becomes current are `promote()`, `rollback()`, and the `creation` seed. |
| I17 | `step` is monotonic and never rewound, including by rollback. |
| I18 | Rollback does not rewrite history: it republishes an earlier release's `contentId` under a **new** `releaseId` with `operation: 'rollback'` and `rollbackTargetReleaseId`, then promotes it. Only `restorable` rows qualify. |
| I19 | Equal `contentId` ⇒ equal admitted entry list. |
| I20 | The gate decision travels with the release, promoted or not. `releases()` is a decision log over numbers. |
| I21 | A published tree carries no credential and no provider binding. A pulled tree does not run until the consumer supplies its own `ai()`. |
| I22 | A rejected candidate appends nothing, and every installation the step made is disposed to the exact pre-step state. |
| I23 | `axHarnessEvolve` leaves the agent exactly as it found it. It never leaves the candidate installed, even when the candidate wins. |

Seeding is the one promotion Ax performs, and only when the chain is empty: a
chain with no head serves nothing, and a seed is a construction-time host act
rather than a gate outcome.

## Authority split

| Concern | Owner |
|---|---|
| Guidance content, mutation choice | Proposer / model |
| `score`, task set, split construction, `evaluatorId` | Caller (host). Ax never validates `evaluatorId`. |
| Gate decision, gate metrics, nomination | Ax's evaluator boundary |
| `contentId`, `releaseId`, `step`, `parentReleaseId` | Ax. A proposer cannot set them. |
| Bullet counters, timestamps, revision, lineage, evidence | Ax's installer. A proposer cannot set them. |
| Tags, correlation, scenario identity | Host. Never sourced from model output. |
| **Head promotion (which release is served)** | **The host, through `surface.promote(...)`.** Nothing in Ax calls it. |
| Deployment / production rollout | **Nobody in Ax.** Human release authority. |

## Model-traffic suppression

Three independent mechanisms, because one of them is a policy and the model is
the adversary:

1. **Structural.** Evaluation runs `forwardPipelineForEvaluation`, a separate
   walk that never enters `forwardPipeline` — and recording is not in
   `forwardPipeline` at all, but in `AxAgentLearning.run()`, which evaluation
   never calls.
2. **Refcounted suppression.** `axHarnessEvolve` holds
   `suspendRecording()` for the whole step. A stray host `run()` appends
   nothing, increments `suppressedRecords`, and throws
   `AxLearningSuppressedError` **before** issuing the forward. The count is
   returned on the result.
3. **Binding.** The proposer receives a teacher and whatever the host names —
   never the served provider, and never the agent, store or surface. Its calls
   are bounded by `maxProposerCalls` and `proposeTimeoutMs`.

A host that calls `report()` from inside its own `propose` callback can still
poison the stream. That is documented, not prevented.

## Durability ordering, and the event-runtime seam

The ordering to preserve: **make the record durable before the processor sees
it; make the nomination durable before marking any source record consumed; make
every derived store recomputable from that one durable point.**
`AxLearningStore` is that point.

The event-runtime seam is specified here and **not built**:

| Mechanism | Seam |
|---|---|
| a report ingress route | an `observe` route whose target appends the report record. **Requires moving `axReportSchema` validation into the reducer**, since that path bypasses `report()` — which is exactly why `'schema-invalid'` is not a never-reason today. |
| a background trainer | a batch-triggered event target with `retrySafety: 'effect-aware'` |
| a commit log | the effect ledger's `intent → dispatched → succeeded \| failed \| parked` |
| compaction after commit | `markConsumed` after the nomination append succeeds. There is no compaction. |

## Evidence

`npm run learn:eval` writes `artifacts/learning-surface-eval.json`;
`npm run test:learning-eval` asserts its invariants and is wired into the root
`npm test` chain. It is a deterministic mechanism evaluation with a stub
provider, fixed metrics and fixed task sets — not an independent model held-out
set and not a live-model improvement claim.
