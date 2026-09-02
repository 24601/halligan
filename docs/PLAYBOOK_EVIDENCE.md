# Playbook Evidence

`agent.playbook().evolve()` grows a context artifact and gates it. This document
is the contract for the evidence that gating produces: what is measured, who
owns each input, what fails closed, what is merely reported, and — the part most
easily got wrong — which numbers are selection numbers rather than results.

Every option here is **default-off**. A call configuring none of them behaves
exactly as it did before this machinery existed, including the value of
`result.metricCallsUsed`.

## Scope and non-goals

In scope: compute accounting under one denominator; paired task-clustered
bootstrap intervals and an unchanged-artifact variance band; a matched-budget
control arm on the restored unevolved program; reach instrumentation; validity
conjuncts; host-owned trajectory-termination classification with bounded
re-draws; first-class prune proposals; promotion authority; a per-cell transfer
matrix; and a sealed test.

Not in scope, deliberately: multiplicity correction, canary or staged rollout,
online monitoring, automatic demotion, cost estimation, independent
reproduction, and any claim that evolving a harness is self-improvement.

## Migration note: three required result properties and `outcome.kind`

`AxAgentPlaybookEvolveResult` gained three **required** properties and
`AxAgentPlaybookEvolveOutcome` gained a required `kind`. Construction sites —
host test doubles, adapters, fixtures — must supply them.

- `control: AxAgentPlaybookControlArmReport` — `{ status: 'not_run', reason }`
  when no arm was configured. A run without a matched-budget comparison says so
  on the record instead of omitting the field.
- `accounting: AxAgentPlaybookComputeAccounting` — every model call the run
  made, under one defined denominator.
- `applied: 'live' | 'dry_run' | 'rolled_back'` — a three-state discriminant,
  **not** a boolean. `false` conflated "you asked for a dry run, the snapshot is
  a safe draft" with "a run-level gate rejected this artifact, the snapshot is
  poison".
- `outcome.kind: 'curate' | 'prune'` — `'curate'` for every legacy path.

For a test double, the smallest honest value of each is the visible-absence one:

```typescript
const control = { status: 'not_run', reason: 'test double' } as const;
const accounting = {
  metricCalls: 0,
  evolveOnlyMetricCalls: 0,
  modelCalls: 0,
  phases: [],
  models: [],
  tokensBasis: 'none',
  costBasis: 'unknown',
  wallClockMs: 0,
} as const;
const applied = 'dry_run' as const;
```

`playbookSnapshot` is `undefined` whenever `applied === 'rolled_back'`: the
documented `getPlaybook()?.load(...)` recovery idiom must never hand a caller an
artifact a run-level gate just rejected.

## The gate chain

Evaluated in order. Cheap and free gates run first so an expensive host call is
never spent on a candidate that cannot land. Gates 1 and 2 have two variants,
selected by `outcome.kind`.

| # | Gate | Cost | Mode source | Pass (`curate`) | Pass (`prune`) |
|---|---|---|---|---|---|
| 1 | `gain` | free | always `require` | `revalComplete && currentGain >= currentGainThreshold` | `revalComplete && -currentGain <= maxCurrentLoss` |
| 2 | `held_out` | free | `require` when a held-out set exists | `revalHeldOut - heldOut >= -epsilon` | `-(revalHeldOut - heldOut) <= maxHeldOutLoss` |
| 3 | `retention` | free | `require` when `retentionPolicy` set | worst/mean historical loss within thresholds | identical — a prune pays the full retention price |
| 4 | `validity` | free | `gates.validity` | every required predicate `pass` on **both** splits | identical |
| 5 | `interval` | free | `gates.interval` | current `direction === 'positive'` and `point > band.spread`; held-out `direction !== 'negative'` | current and held-out `direction !== 'negative'` |
| 6 | `reach` | free | `gates.reach` | `gateEligible && reachedTasks > 0`, i.e. `host_probe` only | `skipped` |
| 7 | `prune_size` | free | `skipped` for curate, always `require` for prune | — | `tokensBefore - tokensAfter >= minTokenReduction` |
| 8 | `veto` | one host call per veto | `require` when `promotionVeto` set | every veto explicitly declines | identical |
| 9 | `authority` | one `axAuthorize` call | `require` when `promotionAuthority` set | `allow` receipt whose `resource.id === nomination.resourceId` | identical |

Contract notes, not commentary:

- **Gate 6 accepts only `host_probe`.** `applicability_counterfactual` reads
  `1.0` unconditionally for evolve-curated bullets, so accepting it would mean
  the gate that exists to refute "the prompt just got longer" is satisfied by
  the prompt getting longer.
- **A prune's own thresholds are recorded** in `prune.appliedThresholds`, so the
  retention receipt's `thresholds.minCurrentGain` — which describes the
  retention *policy* — cannot be read as the rule the prune was judged by.
- **`revalComplete` is false when the evaluation was environment-incomplete**,
  and the rejection reason is then
  `evaluation incomplete due to environment failures (<n> tasks)` rather than
  the misleading budget message.
- Gates 8 and 9 are the only ones that cost a host call, so the chain is
  evaluated twice **only** when one of them is configured: once free, to build
  the nomination the veto is shown, and once with the host thunks.

With every new option absent, gates 4-9 are `skipped` and `accept` reduces to
the legacy boolean.

## Run phase order, the snapshot state machine, and the budget

| # | Phase | Cost (metric calls) | Fails closed before mutation |
|---|---|---|---|
| 0 | Validate options, compute the budget requirement, capture `baselineSnapshot` | 0 | yes |
| 1 | Baseline: current, held-out, retention anchors | `(T + V + R) x runsPerTask` | yes |
| 2 | Variance band | `extraRepeats x (T + V) x runsPerTask` | yes |
| 3 | Transfer anchors on the unevolved artifact | `\|targets\| x sum(splits) x runsPerTask` | yes |
| 4 | Mine weaknesses (proposal construction is free) | 0 metric | no |
| 5 | Curate loop: apply, evaluate, gate chain, nominate, veto, authority, accept or roll back | `(T + V + R) x runsPerTask` per candidate | n/a |
| 6 | Prune: rendered-size check, redundancy sweep, prune proposals through the prune-variant chain | `maxAblations x V x runsPerTask` plus one candidate eval per prune | n/a |
| 7 | Capture `evolvedSnapshot` | 0 | n/a |
| 8 | Transfer candidates on the final artifact | same as phase 3 | n/a |
| 9 | `load(baseline)` -> control arm + harness-term ablation -> `load(evolved)` | separate counter | n/a |
| 10 | Run-level verdict: the `transfer` and `control_arm` gates, then rollback in `require` mode | 0 | n/a |
| 11 | Sealed test: baseline artifact, then final artifact, once | `2 x \|sealed\| x runsPerTask` | n/a |
| 12 | Assemble receipts, accounting, overhead, warnings | 0 | n/a |

Phases 2, 3, 6, 8, 9 and 11 are skipped entirely when their option is absent,
and the phase-0 budget requirement then reduces to the legacy formula exactly.

The control arm must run *on the unevolved program*, but by the time it runs the
curate and prune loops have mutated the live playbook, and a proposal rollback
is restore-only with no redo. So:

```
phase 0 : baselineSnapshot = getState()          // ALWAYS, even with 0 accepts
phase 7 : evolvedSnapshot  = getState()
phase 9 : load(baselineSnapshot)
          assert canonicalDigest(getState()) === baselineDigest
          run best_of_n / self_refine / harness_term
          finally:
            load(evolvedSnapshot)                // in a `finally`, always
            assert canonicalDigest(getState()) === evolvedDigest
```

The digest assertions are the point: a silent partial restore would make every
control-arm number meaningless while the run looked perfectly healthy. A restore
into the baseline that throws leaves the evolved artifact intact and reports
`control.status = 'failed'`. A return restore that fails twice raises
`AxAgentPlaybookEvolveError('control_arm_failed', ...)` carrying
`playbookSnapshot` on the error, because that path leaves the agent in the
baseline state while the result would have described the evolved one.

Phase 11 uses the same bracket twice, so the sealed split sees the baseline
artifact and the final artifact under digest-verified restores and the live
artifact is put back either way.

## Statistical contract

- **Pairing** is by reference identity of the stored task objects across passes.
  It holds because each pass pushes the same object from the same array;
  `isolateTaskInputs` clones only what is handed to the agent and the metric. A
  "hardening" that stored a clone on the record would silently turn every
  interval into `unmeasured`.
- **Resampling unit is the task**, drawn with replacement. Repeats of one task
  are not independent samples.
- **Seed** defaults to a digest of the split's task ids, so the same split
  reproduces the same interval. `intervalOptions.seed` overrides it.
- **`unresolved`** is reported whenever the interval contains zero. It is never
  rounded to the side the point estimate fell on.
- **The variance band** is the spread of re-runs of an artifact that did not
  change: the smallest delta distinguishable from run-to-run noise. A required
  interval gate without a band is rejected at option validation rather than
  degrading to "excludes zero".
- Nothing here corrects for multiplicity. See below.

## Held-out is a selection split

`heldOut` is re-anchored to the accepted candidate after **every** accept, so
with `maxProposals` it has selected the artifact up to that many times. Every
held-out interval, the control-arm comparison, the transfer default and the
redundancy sweep's held-out delta live on that split.

Three responses, in increasing cost:

1. **Always disclose.** `evidence.heldOutContamination` is required on every
   receipt and carries `selectionComparisons` and
   `impliedFamilyWiseErrorRate = 1 - level^k`. `held_out_reused_for_selection`
   is emitted **whenever a held-out set is used at all**, not only when the
   number looks bad. `control.heldOutSelectionComparisons` restates it so an arm
   copied into a PR body carries its own contamination status.
2. **Refuse to correct silently.** No alpha-adjustment is applied. The correct
   correction depends on a stopping rule the caller owns, and a Bonferroni
   factor applied without knowing which would be a number that looks like rigour
   and is not.
3. **Offer a real sealed test.** `sealedTest` is disjoint from `train` and
   `validation` by the same semantic-id machinery, evaluated **once** in phase
   11 — after the run-level verdict — on the baseline artifact and the final
   artifact. `influencedNoDecision: true` is a literal type: there is no
   inhabitant of the report in which it influenced anything, and the gate chain
   has no branch that reads it. When the final artifact's digest equals the
   baseline's — nothing accepted, or the accepted set rolled back — the report
   is `not_run` with that reason rather than a delta that measures run-to-run
   noise.

A held-out delta from `evolve()` is a **selection** number and must not be
reported as a test number. If a PR claims an improvement, the sealed-test delta
— or an explicit statement that none was run — goes in the Evaluation section.

## Termination, discard, and re-draw

`classifyTermination` is host-owned and conservative: returning `undefined`
means `policy_failure`. A program that reliably drives a tool into a timeout
**is** worse and must not be laundered out of the denominator; Ax never infers
`environment_failure` on its own. A classifier that throws raises
`classifier_invalid` — a classifier that cannot classify returns `undefined`.

- Discarded attempts consume budget and are **never scored as zeros**.
- One attempt, one vote: a 50-turn trajectory and a 2-turn trajectory count the
  same.
- Re-draws are bounded and spend the same metric budget. Default 1 with a
  classifier, 0 without: at `runsPerTask: 1` a single 429 would otherwise reject
  every candidate with a false reason.
- A task whose every attempt was discarded does **not** abort the batch. It is
  counted in `tasksWithNoScoredAttempt` and evaluation continues.
- Supplying a classifier also changes the **mining** input, not only the
  scoring: discarded attempts produce no records, so the failure population the
  clusterer sees differs and the proposal stream itself changes.

## Reach

| Basis | Source | Gate-eligible | What it establishes |
|---|---|---|---|
| `host_probe` | `reachProbe` | yes | the bullet was invoked at the deciding step |
| `applicability_counterfactual` | `conditionsForTask` | no | the bullet *would* apply given the declared conditions |
| `rendered_only` | default | no | the bullet was in the prompt |

The documented host recipe is to scan `prediction.actionLog` for the
`[<bulletId>]` prefix `renderPlaybook` emits. A counterfactual reach of `1.0` is
the *expected* reading for evolve-curated bullets, not a good one; the receipt
labels it rather than suppressing it. A probe that throws makes the split
`unmeasured` and emits `reach_probe_failed` — the run is not aborted, because
reach is evidence, not scoring.

## Validity predicates

`final_completion_rate` (share of records ending in `final`),
`unknown_function_call_rate`, `tool_error_rate`, `mean_total_tokens`,
`mean_latency_ms`. A predicate with no data reads `unmeasured`, which is
**never** a pass and fails closed under `require`.

`unknown_function_call_rate` and `tool_error_rate` are computed in Ax against
the agent's registered function set. `classifyFunctionCall` is a host
**override**, recorded as `overriddenByHost: true`: making these host-owned
outright would be both a capability downgrade and a laundering surface, because
a classifier that returns `ok` for everything passes the gate.

## Transfer cells and the no-average rule

`AxAgentPlaybookTransferReport` has **no** mean, average, or aggregate-delta
field, and a type test bans adding one. An average is exactly what hides a
single catastrophic cell: a matrix whose cells are `+0.50` and `-0.36` averages
to a win and contains a target that got materially worse.

- One cell per `(target, split)`, each with its own anchor score, candidate
  score, delta, paired interval and model identity.
- The anchor is the **target's own** reading of the unevolved artifact, taken in
  phase 3 before any mutation. Borrowing the primary model's baseline would
  attribute the model gap to the playbook.
- `target.id` is caller-owned; Ax never derives a cell label from
  `AxAIService.getId()`.
- `regressedCells` lists `${targetId}:${split}` for every cell whose delta is
  below `-regressionFloor` (default `0.02`). A delta exactly at the floor is the
  tolerance the caller declared, not a regression.
- A required `transfer` gate fails closed on a matrix it cannot read: a planned
  cell that produced no reading, a pass that left its split incomplete (whose
  mean is only a prefix of the split), or a pair that could not be aligned task
  by task.
- `transfer_cell_regressed` is emitted whatever the gate mode is, including
  `off`. A measured regression on another backbone is a finding, not a gate
  artifact.

## Pruning, and the mutation primitive

A removal is a mutation and pays an addition's price: the same re-evaluation,
the same retention receipt, the same gate chain — in its loss-tolerance variant,
because a removal cannot raise the current-task mean by `minHeldInGain`.

The prune applies through a snapshot transform that validates its own output
(section membership, id uniqueness, recomputed stats), stamps history and
evidence on the bullets it touched, and rolls back exactly on failure. A size
budget removes the **smallest prefix of the prunable ranking that reaches the
ceiling**, not every prunable bullet.

## Promotion authority

- The **grant** says "this principal may promote into this playbook". It binds
  to a stable caller-supplied `resourceId`, matched by exact identity **before**
  the host authorizer runs, so Ax never derives one: a derived id is one the
  host could not have pre-granted.
- The **veto** is the only channel that sees the candidate. Reject-only,
  conjunctive, fail-closed: a veto that throws, times out, or returns anything
  that is not `false` / `{ vetoed: false }` — `undefined` included — is a veto.
- `promotionDigest` is **receipt metadata, not consent**. It identifies what was
  promoted; it authorizes nothing.
- All five denial codes are recorded, not thrown, including `cancelled`.
- A promoted candidate rescinded by a run-level gate moves five things together:
  `promotion.status = 'promoted_then_rolled_back'`,
  `evidence.decision = 'superseded'`, `applied = 'rolled_back'`,
  `playbookSnapshot = undefined`, and the `promotion_rolled_back` warning naming
  the gate that decided.

Hosts supplying any of the four callbacks run
`runAxAgentPlaybookEvidenceConformance` first. It makes **real** host calls —
two veto invocations and one genuine `axAuthorize` against the caller's live
`AxAuthorityContext` — so `axPlaybookEvidenceConformanceOperation` on
`axPlaybookEvidenceConformanceResource` must be pre-granted, or the kit's own
request is denied and it asserts nothing.

## Accounting, cost, and overhead

One denominator: `accounting.metricCalls` is the honest run total over every
phase, including the control arm, the band, transfer cells, ablations and the
sealed test. `accounting.evolveOnlyMetricCalls` and the legacy
`result.metricCallsUsed` cover the pre-evidence phases only, so a caller reading
the legacy number sees exactly what it saw before.

Cost is caller-owned through `costFor`. Ax has no provider cost field and never
estimates one: with no hook, `costUsd` is `undefined`, `costBasis` is
`'unknown'`, and `cost_unknown` is emitted **when a candidate was accepted** —
restricting it to accepts is deliberate, because a warning that fires on every
run is one a reviewer learns to skip.

Token totals come from `AxTokenUsage.totalTokens` only. A phase whose calls are
structurally unobservable (`mining`, `judge`) reads `tokensBasis:
'unobservable'` and can be filled by a caller-owned `usageTap`; a phase that
simply reported nothing reads `'unreported'`. Ax never wraps a caller's
`AxAIService` to obtain usage — ownership stays with the caller.

`result.overhead` reports the accepted artifact's turn, call and token cost
against the anchor it was actually compared with, per split, through the same
paired-bootstrap machinery. `overhead_exceeds_gain` fires when the relative
overhead exceeds `overheadWarnRatio`.

## Explicit non-guarantees

- No canary, no staged rollout, no online monitoring, no automatic demotion.
- No independent reproduction and no longitudinal evidence exists for anything
  here. A PR must not imply otherwise.
- `fnv1a64` is a change detector, not authenticity, and `promotionDigest` is not
  host consent.
- A finite anchor set detects **measured** regressions only. Retention proves
  nothing about the tasks it does not contain.
- An oracle-strong control arm (`selector: 'metric'`) can cause false rejects.
  That direction is deliberate.
- **The prune gate is not a complete removal control.** The ACE curator can
  still remove a bullet inside an ordinary curate proposal via `REMOVE`,
  `evidence.lifecycle.status`, or `supersedes`, and section-overflow eviction is
  reported (`curate_eviction`) but not gated.
- `heldOut` is a selection split and no multiplicity correction is applied.
- Transfer measures the targets the caller supplied. It says nothing about a
  backbone that was not in the matrix.
- Everything here is bounded harness adaptation. It is not recursive
  self-improvement: `evolve()` does not modify its own optimizer, its own
  evaluator, or its own gate.

## Evaluation

The deterministic, model-free evidence evaluation:

```bash
npm run evaluate:playbook-evidence
npx vitest run scripts/evaluate-playbook-evidence.test.ts
```

Zero provider calls, zero tokens, `$0`. It runs the real `evolveAgentPlaybook`
against a mock service and a fixed deterministic scorer over five archetypes
that each map to a named failure mode, and reports the archetypes where the
mechanism did **not** help by name.
