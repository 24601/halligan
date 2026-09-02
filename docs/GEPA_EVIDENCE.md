# GEPA Evidence Manifests

Normative contract for the evidence a GEPA optimization run leaves behind: what
each record is allowed to claim, what Ax refuses, who owns which decision, and
what none of it proves.

This is an **artifact and audit contract**, not a new runtime surface. It adds no
"System Shape" entry to [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## The four evidence senses, and where these manifests sit

| Sense | Question | Where it lives |
|---|---|---|
| Search history | *What did the optimizer try, and what happened?* | `AxGEPACandidateLineageManifest` (`optimizedProgram.candidateLineage`) |
| Causal claim | *What does the host believe caused the improvement, and on what receipt?* | `AxCausalCandidateEvidenceManifest` (`optimizedProgram.causalCandidateEvidence`) |
| Negative memory | *What was tried and rejected, under what conditions?* | `AxRejectedCandidateLedgerStore` (host-owned, outside the artifact) |
| Run accounting | *How much of the evidence actually ran?* | `AxTrajectoryAdmissionReport` / `AxGEPARunAdmissionReport` |

The first two are versioned artifacts. The third is a host store the artifact
only *points* at. The fourth travels on both, and on `RoundProgress` and
`OptimizationComplete`.

## Record schema at version 4

`AxCausalCandidateEvidenceManifest.version` is `3 | 4`. A manifest is emitted at
version 4 whenever **any** version-4 feature is used — a declared `policy`, or
any of the eight new record fields, or the leave-one-out matrix, or the three
structural fields on an affected component. It is **not** gated on `policy`
alone.

| Field | Owner | Notes |
|---|---|---|
| `attribution` | host | `{ status: 'inconclusive', reason }`. Mutually exclusive with `ablation`. |
| `mutation` | host annotator, validated by Ax | Depth, patch taxonomy, component classes, effort, cost. |
| `cost` | host | `costUsd: undefined` means unmeasured, never free. |
| `harness` | host | Recipe digest + `boundModelId` + `stale?`. |
| `discrimination` | Ax | `{ strategy, estimator, gate, estimate, stderr?, effectiveSampleSize?, pairedRowCount }`. |
| `admission` | Ax, from a host classifier | Per-batch admission accounting. |
| `effects` | host | Effect declarations, validated structurally. |
| `runtimeRequirements` | host | `AxRuntimeCapabilityRequirements`, carried by top-level whitelist. |

`AxCausalAffectedComponent` additionally gains `componentClass?`,
`componentKind?` and `toolCapabilities?`. `beforeFingerprint` and
`afterFingerprint` keep type `string` deliberately: `requiredFingerprint`
already enforces `/^sha256:[0-9a-f]{64}$/` at runtime, and rebranding a public
field would break every host that builds a record from a literal.

### Forward incompatibility (INV-L2b)

**No version-4 manifest is readable by an older `@ax-llm/ax` build.** That
build's `axCloneCausalCandidateEvidenceManifest` pins `version !== 3` and an
exact eight-key top level. This is inherent to the existing validator and is
accepted rather than worked around. A host that must read a run's evidence with
an older build should leave `attributionPolicy` and `effectPolicy` off and carry
no version-4 record fields; such a run still emits version 3, byte for byte as
before.

## Fail-closed rules

| Condition | Result |
|---|---|
| `attributionPolicy: 'required'`, promoted, >1 affected component, no covering leave-one-out matrix and no explicit inconclusive attribution | `AxCausalAttributionRequiredError` (`attribution_required`) |
| A record that both claims an ablation and disclaims attribution | throws |
| A leave-one-out row naming an unaffected component | throws |
| A duplicate `removedComponentId` across rows | throws |
| A leave-one-out row whose metric set differs from the candidate outcome | throws |
| A leave-one-out matrix with no `ablation.metricCalls` | throws |
| `effectPolicy: 'required'`, promoted, `mutation.patch.class === 'capability'`, an affected component declaring a `tool:*` capability, `effects` absent or empty | `effects_missing` |
| `effects` present on a promoted steering patch | `effects_on_steering_surface` |
| `replaySafety: 'unknown'` with `resolver: 'none'` | `unsafe_replay_without_resolver` |
| `replaySafety: 'idempotent'` with `idempotencyKeySource: 'none'` | `idempotent_without_key` |
| `effectPolicy: 'required'`, promoted `program.source_replace`, no `runtimeRequirements` | `runtime_requirements_missing` |
| A version-3 manifest carrying version-4 record fields | throws |
| A version-3 manifest declaring a `policy` | throws |
| `requirePolicyAtLeast` stricter than the records satisfy | throws |
| A ledger entry with an empty `expiresWhen` | `empty_expiry` |
| A ledger entry with no `after_ms` clause | `expiry_requires_ttl` |
| A ledger ref member that is not an identity `sha256:` digest | `invalid_digest` |
| A ledger-ref union across different `storeId`s | `store_id_mismatch` |
| A batch whose admitted fraction is below `minAdmittedFraction` | evaluation is `inconclusive`; the candidate is `aborted`, never accepted and never rejected |
| A run whose cumulative discard rate exceeds `maxRunDiscardRate` | run ends `excessive_environment_failures`; **no `bestScore` and no artifact are published** |
| A `configError` row, or any row of a program declaring a `program-source` component, classified `environment_failure` by the host | overridden to `policy_failure`; `admission.overriddenRows` incremented |

Every row above is exercised by `npm run evaluate:gepa-manifests`, together with
control rows that must be **accepted** — a refusal that fires on everything is
not a gate.

## Authority

| Concern | Owner |
|---|---|
| Trajectory termination classification | **Host**, except the non-reclassifiable rows Ax enforces |
| `boundModelId`, `currentModelId`, port names, binding identity | **Host.** Ax never reads a provider model name |
| `costUsd`, `effort`, `ablation.metricCalls` | **Host self-report.** Ax validates shape and cannot cross-check |
| `mutationDepth`, patch type, host component kinds | **Host annotator**, validated by Ax against the touched component *kinds*; the class is derived from the type, never accepted as an assertion |
| `diagnosis` in a ledger entry | **UNTRUSTED.** Model-influenced in the GEPA path. Ax bounds it, JSON-quotes it, renders it inside untrusted markers, and never interprets it |
| Whether a hypothesis is true; split independence; metric validity | **Host / evaluator** |
| Ledger durability and rollback survival | **Host store.** The in-memory store self-declares `volatile` / `unknown` |
| Replay-time policy floor | **Caller** of `axCloneCausalCandidateEvidenceManifest`, not the artifact |
| Inclusion probabilities, IPW arithmetic, digests, structural validation, denominator equality, version discipline | **Ax** |
| Promotion decision | **Ax's two gates**, computed from host-owned inputs |
| Release authority | **Nobody, inside Ax.** Promotion is an offline decision; nothing here observes a deployed artifact |

## The two promotion gates and their estimators

GEPA has **two** independent promotion gates, and both are covered by admission:

| Gate | Comparison | Estimator |
|---|---|---|
| Reflective mutation | Parent and child minibatch evaluations, intersected to their paired admitted indices | `'sum'`, or `'ipw_hajek'` under `minibatchStrategy: 'discriminative'` |
| `system_merge` | A fresh merge-subsample evaluation against both parents' cached per-instance scores, intersected across all three | Always `'sum'` |

The merge subsample is a score-disagreement *stratified* draw over Pareto-set
indices, not a difficulty-weighted draw over the feedback set, and it consumes a
variable number of `rand()` values. It has no inclusion probabilities, so **no
IPW estimate of it exists**, and every merge record says `estimator: 'sum'` so
no reader can mistake which instrument decided.

**The Madow standard error is reported and never gated on.** Under systematic
πps sampling some joint inclusion probabilities are zero, so
`AxIpwEstimate.stderr` is an approximation. No promotion gate is built on it.

## Artifact byte budget

Instrumentation that cannot be re-validated is worse than no instrumentation:
`axCloneCausalCandidateEvidenceManifest` re-checks the serialized byte length
against `maxArtifactBytes` (256 KiB default) and throws on excess, so an
over-instrumented run produces an artifact that **cannot be replayed**.

| Surface | Bound |
|---|---|
| Per-record `discrimination.inclusions` | **Cut.** Up to 20,000 four-field objects against a 256 KiB cap |
| `AxTaskDiscriminationSummary.snapshots` | `maxInclusionSnapshots` default 20, clamped [0, 200]; each snapshot's `inclusions` clamped to `maxReportedTasks` (default 200) |
| `AxRejectedCandidateLedgerRef.entryDigests` | 256, oldest dropped, `omittedDigestCount` raised |
| `diagnosis` / `implicatedSurfaces` / `predictedDeltas` / `observedDeltas` | 1000 chars / 32 / 32 / 32 |
| Lineage records / components per record / artifact bytes | 1,000 / 64 / 1 MB, all clamped and configurable |

`npm run evaluate:gepa-manifests` measures the fully instrumented manifest and
asserts it re-validates, not merely that it is small.

## The rejected-candidate ledger port

`AxRejectedCandidateLedgerStore` is a host-implementable port. A durable
implementation belongs outside any artifact rollback boundary.

- `record(entry, signal?)` — idempotent by `candidateDigest`; a later entry
  supersedes an earlier one.
- `list(query, signal?)` — expiry is evaluated **at query time** against the
  caller's context and `now`.
- `purgeExpired(now, context, signal?)` — returns the number removed.
- `close?()` — idempotent.

`axRunRejectedCandidateLedgerConformance(factory, { clock })` is the executable
contract a host store runs to earn `capabilities.conformance`. It asserts
supersede-by-digest, expiry at both query and purge time against an injected
clock, the fail-open unknown-context rule, the mandatory TTL, filtering, limits,
an exact purge count, an idempotent close, and abort propagation with no
listener leak. A durable store must additionally survive a close/reopen cycle
with every unexpired entry intact; that check is skipped, with its reason
reported, for a store declaring `durability: 'volatile'`.

*Naming note.* The kit is `axRunRejectedCandidateLedgerConformance`, not
`runAxRejectedCandidateLedgerConformance`: the `ax*` prefix keeps it inside the
public-barrel generator's existing rules, where the older
`runAxEventStoreConformance` needed a generator edit to be exported at all.

### Expiry, and why it fails open

Clauses are OR-ed. `after_ms` fires on elapsed time; `model_changed` and
`task_set_changed` fire when the reader's context **differs OR is missing**.

A clause whose context field is absent FIRES because the context is supplied by
the *reader* of `list()`, not the writer of the entry: without that rule an entry
written with only a `model_changed` clause and read with an empty context would
be permanent. The mandatory `after_ms` clause closes the same hole from the
other side. Negative memory that outlives its stated conditions is a capability
ceiling, so "unknown" resolves toward forgetting.

### Asymmetric rollback

`axReplaceOptimizedProgramSnapshot` unions **only** `rejectedCandidateLedgerRef`.
The causal evidence history keeps its existing refusal — it throws on a
divergent history — because its records carry a strict sequence and a strict
parent chain and its receipts a strictly increasing count, so two chains cannot
be unioned and still verify. Removing the refusal would delete the one control
that stops a rollback substituting a fabricated evidence history.

The ledger ref can merge precisely because it is a pointer set into a store the
artifact cannot rewrite.

## Non-guarantees

Ax validates **structure**. It does not:

- prove a hypothesis, or that a candidate caused an improvement;
- infer an attribution, or fill one in when the host supplies none;
- establish split independence, or that held-in and held-out are disjoint;
- verify a cost, an effort level, or a wall-clock number;
- count an ablation's metric calls, or check them against any counter it owns;
- evaluate whether a metric measures what its name says;
- observe a deployed artifact, run a canary, or demote anything;
- prevent an authorized host from supplying misleading evidence.

Nothing here is a confidentiality control. `sha256-64:` fingerprints are
collision-resistant enough for correlation and are not tamper-evidence; identity
digests (`sha256:`) come from WebCrypto and are what the ledger and the harness
recipe key on.
