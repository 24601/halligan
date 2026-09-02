---
name: ax-playbook
description: This skill helps an LLM generate correct playbook code using @ax-llm/ax. Use when the user asks about playbook(), AxPlaybook, context playbooks, evolving context, ACE / Agentic Context Engineering, agent.playbook(), or growing/applying task knowledge offline and online with evolve() and update().
version: "24.0.17"
---

# Playbook Codegen Rules (@ax-llm/ax)

Use this skill to generate context-playbook code. A playbook grows an evolving body of task knowledge and renders it into a program's context. The evolution engine (ACE — Agentic Context Engineering) is hidden behind `playbook(...)`, exactly as `optimize(...)` hides its optimizer. Prefer the `playbook(...)` concept; only reach for `AxACE` directly when the user explicitly wants the low-level engine.

## Use These Defaults

- Create with `playbook(program, { studentAI, teacherAI? })`; it returns an `AxPlaybook` handle.
- Grow offline with `await pb.evolve(examples, metric)` — returns `{ bestScore, playbook }`.
- Grow online with `await pb.update({ example, prediction, feedback })` — no metric needed.
- Apply with `pb.applyTo(program)` (defaults to the bound program).
- Persist with `pb.toJSON()` and restore with `playbook(program, opts).load(snapshot)`.
- Inspect with `pb.render()` (markdown) and `pb.getState()` (`{ playbook, artifact }`).
- Scope retrieval with `pb.render({ conditions })` / `pb.applyTo(program, { conditions })`; entries with unmet applicability, expiry, deprecation, or supersession are excluded by default, and sections with no visible bullets are omitted. `{ includeInactive: true }` is inspection-only on `render()` and is ignored by executable `applyTo()` calls.
- For agents use `agent.playbook({ target: 'actor' | 'responder' })`; default target is `'actor'`.
- Use a cheaper `studentAI` to run the program and an optional stronger `teacherAI` to reflect/curate.
- Prefer `ai()`, `ax()`, and `agent()` for new code.

## Critical Rules

- `playbook(...)` binds to an `AxGen` program; `evolve`/`update` need that program's signature.
- `evolve()` returns only `{ bestScore, playbook }`. There is no Pareto front and no `optimizedProgram` — that is `optimize(...)`'s shape, not a playbook's.
- `update({ example, prediction, feedback })` requires the full `{ example, prediction }`; `example` must match the program's input fields (plus any expected output). Do not pass bare input fields at the top level.
- `update()` works without a prior `evolve()`/`load()` — the handle hydrates lazily on first use.
- `applyTo()` injects a `## Context Playbook` block into the program description; calling it repeatedly recomposes from the original base (no stacking).
- Keep the offline `metric` deterministic and cheap, like a GEPA metric.
- A playbook is plain JSON. Persist `pb.toJSON()` and `load(...)` it into a fresh program for production.
- Legacy snapshots and plain bullets load unchanged. Evidence fields are optional; loading does not invent provenance or verifier receipts.
- Curators may propose confidence, inert applicability condition tokens, lifecycle state, and supersession links. Curator JSON cannot set provenance, evidence counts, or verification receipts; those fields come from trusted host/evaluator APIs. This is an authority boundary, not cryptographic authenticity: callers that supply `initialPlaybook`, call `load()`, or call `recordEvidence()` are trusted and can provide arbitrary persisted values.
- The playbook engine, construction-time agent attachment, failure harvesting,
  and verified agent evolution are available in TypeScript and the generated
  Python, Java, C++, Go, and Rust packages. Use each package's native casing and
  callback types. Evidence metadata, condition-aware rendering, and host receipt
  APIs are TypeScript-first pending the AxIR backlog item.

## Offline Pattern (evolve)

```typescript
import { type AxMetricFn, ai, ax, playbook } from '@ax-llm/ax';

const program = ax('review:string -> sentiment:class "positive, negative"');
const studentAI = ai({ name: 'openai', apiKey: process.env.OPENAI_APIKEY! });
const metric: AxMetricFn = ({ prediction, example }) =>
  (prediction as any).sentiment === (example as any).sentiment ? 1 : 0;

const pb = playbook(program, { studentAI, maxEpochs: 2 });
const { bestScore } = await pb.evolve(train, metric);
pb.applyTo(program);
```

## Online Pattern (update)

```typescript
// After a real run, feed the outcome back so the playbook keeps learning.
await pb.update({
  example: { review: 'Five stars, would buy again.' },
  prediction: { sentiment: 'negative' },
  feedback: 'WRONG: enthusiastic praise is positive.',
  evidence: {
    sourceRunId: 'support-run-42',
    feedbackIds: ['feedback-107'],
    confidence: 0.8,
  },
});
pb.applyTo(program);
```

## Evidence-aware guidance

New bullets may carry optional typed audit metadata without changing the legacy
playbook shape:

```typescript
type AxACEBullet = {
  // existing id/section/content/count/timestamp fields...
  revision?: number;
  lineage?: { previousRevision?: number; supersedes?: string[] };
  evidence?: {
    confidence?: number;       // 0..1
    evidenceCount?: number;
    applicability?: {
      allOf?: string[];        // every condition must be supplied at render time
      anyOf?: string[];        // at least one must be supplied
      noneOf?: string[];       // none may be supplied
    };
    provenance?: Array<{
      source: 'compile' | 'online' | 'agent-evolve' | 'manual';
      sourceRunId?: string;
      feedbackIds?: string[];
    }>;
    verification?: Array<{
      verifierId: string;
      testId?: string;
      result: 'passed' | 'failed' | 'unknown';
      timestamp?: string;
      summary?: string;        // trimmed to 500 chars on trusted updates
    }>;
    lifecycle?: {
      status?: 'active' | 'deprecated' | 'superseded';
      expiresAt?: string;
      supersededBy?: string;
      reason?: string;
    };
  };
};
```

Applicability is declarative and non-executable. The caller chooses and supplies
condition tokens; Ax does not infer them from user text. Guidance with explicit
preconditions is withheld when no matching conditions are supplied. Expired,
deprecated, and superseded guidance is also withheld by default, while
`getState()` preserves it and its delta `changes` for audit and exact snapshot
rollback.

```typescript
pb.applyTo(program, {
  conditions: ['tenant:paid', 'region:us'],
  now: '2026-08-01T00:00:00.000Z', // optional deterministic expiry clock
});

// Agent handles target their configured live stage directly.
apb.applyTo({ conditions: ['tenant:paid', 'region:us'] });

// Inspection can include valid expired/deprecated/superseded entries. Malformed
// records are always withheld and executable ACE stages never use this bypass.
const auditMarkdown = pb.render({ includeInactive: true });

// Trusted host/evaluator authority: no curator/model call or cryptographic proof.
pb.recordEvidence(['guidel-1234'], {
  source: 'manual',
  feedbackIds: ['eval-case-9'],
  verification: [
    { verifierId: 'policy-suite', testId: 'case-9', result: 'passed' },
  ],
});
```

Do not store raw examples, private traces, or verifier transcripts in bullet
metadata. Use stable IDs and short summaries. The existing ACE feedback artifact
retains only the data it already intentionally stores.

### Deterministic held-out retrieval fixture

`aceEvidenceEval.test.ts` compares the same seven guidance bullets as legacy
plain bullets and as evidence-aware bullets across three held-out condition
sets. The fixture covers applicable and inapplicable rules, an expired rule, a
deprecated contradiction, and a superseded rule. It is a deterministic
retrieval test, not a live-model answer-quality claim.

| Measure | Legacy/plain | Evidence-aware |
|---|---:|---:|
| Exact expected retrievals | 0 / 3 | 3 / 3 |
| False application rate | 100% | 0% |
| Rendered prompt characters (3 tasks) | 1,080 | 409 |
| Durable artifact bytes | 1,533 | 1,920 |

The same fixture checks byte-identical rendering for a no-metadata/no-benefit
case and exact snapshot rollback. Run it with:

```bash
npx vitest run src/ax/dsp/optimizers/aceEvidenceEval.test.ts
```

Metadata helps only when the host provides accurate conditions and lifecycle or
verification evidence. It cannot prove that guidance content is semantically
correct, authenticate caller-supplied snapshots/receipts, detect missing
preconditions, or replace representative held-out/live evaluation. Malformed
persisted applicability/lifecycle metadata is preserved for exact rollback but
the affected bullet fails closed during normal and inspection rendering.
`evidenceCount` is an additive update/receipt observation count, not a deduped or
authoritative count of independent evidence; one verified evolution can add an
update observation and a later verifier-receipt observation. The durable JSON
grows, even though filtered prompts can shrink.

## Optimizer-only guidance and asymmetric rollback

A bullet can be tiered. `visibility: 'optimizer'` keeps it as diagnostic evidence
for the reflector and curator and out of every actor prompt. Absent means
`'actor'`, so every existing playbook renders byte-identically.

```ts
const pb = playbook(program, { studentAI: ai });

// The actor path. `render()` already routes through the projection.
const markdown = pb.render({ now: new Date().toISOString() });

// The projected view, with its retrieval-time decisions.
const view = pb.renderForActor({
  authority: { grantIds: currentGrantIds, leaseEpoch: 4 },
});
```

- `renderPlaybook` is **unchanged** and stays the FULL renderer the reflector and
  curator use. Filtering there would blind both stages.
- `axProjectActorPlaybook` drops optimizer-tier bullets, applies the lifecycle
  and applicability gates, and applies the precondition re-check when `authority`
  is supplied. `axRenderActorPlaybook` is the only actor-facing renderer and
  throws for any view it did not produce — the view's `kind` field is a label a
  caller can forge, and a JSON round-trip drops the brand.
- The curator may only **downgrade**. `visibility` on a curator operation is
  typed `'optimizer'` and is runtime-checked, because parsed curator JSON reaches
  the apply path through a cast. Promotion to `'actor'` is expressible only
  through host evidence. An `ADD`/`UPDATE` with no `visibility` never clears an
  existing `'optimizer'`.
- A write that copies optimizer-tier content verbatim, or supersedes an
  optimizer-tier bullet, inherits the tier; a merged duplicate pair takes the more
  restrictive one.

> The tier gates ARTIFACTS, not TEXT. Verbatim copy, supersede-swap and
> merge-survivor promotion are blocked; paraphrase is not, and no exact-content
> rule can block it. Do not describe this tier as information-flow control.

Host-only `evidence.authorityProvenance` is stripped by
`axRedactPlaybookForModel` before the reflector or curator payload is serialized,
so grant ids, receipt ids, and request digests never reach a provider.

### `rejected-retained` and `retainRejectedMutation`

`AxACEVerificationResult.result` gains `'rejected-retained'`: the proposed
mutation failed its gate and the artifact reverted, but the evidence is committed
so the next proposer round does not re-propose it.

```ts
const ids = ace.retainRejectedMutation({
  operations: rejectedOperations,
  verifierId: 'held-out',
  testId: 'split-3',
  now: '2026-01-01T00:00:00.000Z', // required, and threaded into the apply path
  summary: 'score regressed on the held-out split',
});
```

Operations are applied with `visibility: 'optimizer'` forced and the result
attached; bullets that already existed keep their prior content and tier, so only
their evidence moved. The entry is sticky — the verification dedupe key includes
`result`, and a retained rejection is never replaced by another result.

### Version compatibility

`AxACEPlaybook.version` is stamped `2` on the first write that creates a tiered
bullet, and `AX_ACE_MAX_SUPPORTED_PLAYBOOK_VERSION` (currently `2`) is the read
gate that refuses anything above it. It is a module constant, not a package
export — the generated barrel carries `ax`/`Ax`-prefixed names only, so compare
against the literal or use the exported
`axPlaybookRequiresVisibilitySupport(playbook)`. Two residuals stand, deliberately:

- an ax older than this release does not read `playbook.version` at all, so it
  renders optimizer-tier bullets into the actor prompt. A version-2 playbook must
  not be loaded by an older ax;
- an older ax encountering `'rejected-retained'` hard-fails the optimizer run
  rather than dropping a bullet.

Full contract: `docs/SKILL_PROVENANCE.md`.

## Persist And Restore

```typescript
const snapshot = pb.toJSON(); // { playbook, artifact } — plain JSON
// later, in another process / a production program instance:
playbook(prodProgram, { studentAI }).load(snapshot).applyTo(prodProgram);
```

## Agents

`a.playbook({ target })` returns an agent-aware `AxAgentPlaybook` (the stage `AxPlaybook` handle plus an agent-level `evolve`). The one playbook the agent renders into its prompt grows three ways:

- Continuous (trust): the construction-time `playbook` option (see `ax-agent`) harvests each run's failures automatically — no dataset.
- On-demand (trust): `apb.update({ example, prediction, feedback })`.
- Batch verified (proof): `apb.evolve(dataset, options)` runs the full agent over a task set, mines failure clusters, and proposes one playbook bullet per weakness; with `verify` (default on) it keeps a bullet only if held-in improves AND the `validation` held-out set does not regress, else exact rollback. `verify: false` = trust-batch. Bullets-only.
- Accepted verified proposals receive an `agent.playbook.evolve` receipt from the trusted evaluator boundary. Rejected proposals restore the exact pre-proposal snapshot, including evidence metadata.

```typescript
const a = agent('ticket:string -> reply:string', { ai });
const apb = a.playbook({ target: 'actor' }); // agent-aware handle; 'actor' (default) or 'responder'
await apb.update({ example, prediction, feedback }); // online: injected into the live stage prompt
const result = await apb.evolve(
  { train, validation }, // AxAgentEvalDataset
  {
    metric,
    runsPerTask: 2,
    requireHeldOut: true, // production promotion: fail closed
  },
);
```

### Optional historical retention gate

Use `retentionPolicy` when a verified playbook proposal must improve the
current task set while staying within explicit loss limits on caller-owned,
frozen historical slices:

```typescript
const result = await apb.evolve(
  { train: currentTasks, validation: currentHoldout },
  {
    metric,
    retentionPolicy: {
      evaluatorId: 'support-quality-v3',
      slices: [
        { name: 'refunds', version: '2026-07', tasks: refundAnchors },
        { name: 'routing', version: '3', tasks: routingAnchors },
      ],
      minCurrentGain: 0.05, // plasticity
      maxWorstHistoricalLoss: 0.02, // per-slice stability
      maxMeanHistoricalLoss: 0.01, // aggregate stability
    },
  },
);
```

Ax scores each slice before any proposal and keeps those scores fixed as the
run's anchors. Ax structured-clones and recursively freezes the policy plus
current, held-out, and slice tasks before the first evaluation, so later caller
or metric mutation cannot change the corpus or thresholds. Each fully
evaluated proposal gets `outcome.retention` with its current-task gain, every
named/versioned anchor and candidate score, per-slice loss, expected/executed
run counts, evidence completeness, worst/mean historical loss, thresholds,
and the final gate decision. Rejected proposals use the existing exact
snapshot rollback. The result also exposes `retentionAnchors`.

`evaluatorId` is a required caller-managed metric/judge configuration identity.
Receipts include it with canonical current/held-out/slice corpus digests, a
policy digest, and deterministic evaluation sequence numbers. Digests cover
the cloned task fields—including weights—and thresholds. Canonical values are
type-tagged: object keys are sorted, dates use ISO timestamps, Map entries and
Set elements are sorted by their complete canonical encoding, and typed arrays
include their view type and bytes. Arrays encode length and every enumerable
own key, preserving holes and extra properties. Structurally equal Map keys or
Set elements retain multiplicity, so ordering cannot merge distinct evidence.
Digests use `fnv1a64`, a deterministic non-cryptographic identity/checksum, not
proof of authenticity; retain the referenced evaluator and corpus versions
externally.
Sequence numbers cover baseline and candidate current-task, held-out, and
historical-slice evaluations plus the final decision. Receipts and anchors are
recursively frozen at runtime.

`minCurrentGain` replaces `minHeldInGain` for this optional gate and compares
each proposal with the last accepted current-task score; fixed historical
anchors prevent sequentially accepted losses from resetting. The existing
validation-set `epsilon` gate still applies independently.

Retention is optional and default-off. It requires verified evolution, adds
one baseline and one candidate evaluation per anchor task (times
`runsPerTask`), and fails before mutation when the metric budget cannot
establish complete anchors. Invalid weights, evaluator errors, and non-finite
scores fail closed; abort is checked after every candidate-evaluation
AI/metric await and again before acceptance, so an interrupted candidate
evaluation rolls back.
`runsPerTask` is capped at 100 and `maxMetricCalls` at 1,000,000; both must be
positive safe integers. It does
not change the metric or judge, expose anchor examples to weakness mining,
generate candidates, auto-deploy, or promote outside this `evolve` call. Slice
names, versions, task collection, semantic train/validation disjointness, and
evaluator validity remain caller authority; use frozen, separately collected
data and audit overlap before the run. A finite anchor set can detect measured
regressions only—it is not proof against catastrophic forgetting or live-model
drift.

This narrow boundary applies to agent playbook bullets. It does not claim to
govern GEPA prompt/program components, routing/tool policies, or interface
configuration. Use it where a representative historical corpus and stable,
finite metric exist; do not use it as a substitute for independent holdouts,
online monitoring, or human release authority. The retention option is
TypeScript-only until the linked AxIR backlog work reaches generated packages.

Deterministic zero-cost mechanism evaluation (mock AI, fixed metric and task
sets; no live-model efficacy claim):

```bash
AX_PRINT_METRICS=1 npx vitest run src/ax/agent/agentInternal/playbookEvolve/playbookEvolve.test.ts
```

The agent-level `evolve(dataset, options)` is distinct from the program-level `pb.evolve(examples, metric)` above: it takes an `AxAgentEvalDataset` plus options, runs the whole pipeline, and returns baseline/final held-in & held-out with per-bullet outcomes (no `{ bestScore }`). For full-pipeline tuning of agent instructions and demos (not the playbook) use `agent.optimize(...)` (GEPA).

The default remains permissive for compatibility: verified proposals may be
accepted on held-in gain when `validation` is absent. For production promotion,
set `requireHeldOut: true`. This requires verification, a non-empty held-out
set, semantic IDs for every task, disjoint train/validation IDs, enough metric
budget for a complete baseline plus candidate evaluation, and complete finite
scores from both splits. When tasks use `weight`, strict mode requires finite,
non-negative weights and a positive finite total weight in each split; the
weighted mean must also be finite. Missing or indeterminate evidence fails
before mutation or rejects the candidate with exact rollback. `verify: false`
is an error under this policy. Identity defaults to `task.id`; use
`taskId: (task) => task.input.caseId` when identity lives in typed input or
metadata. Ax deliberately does not treat object references or serialized
objects as proof of semantic independence. IDs are non-empty strings under the
public contract; runtime numeric and other non-string values are rejected with
the semantic-ID error rather than coerced.

### Strict promotion evaluation and trade-off

Ax includes a deterministic offline hill-climbing sweep over six fixed
candidate types: overfit, generalizing, no-benefit, harmful, small/noisy
overfit, and small/noisy generalizing. It invokes the real evolve gate and
rollback path with an external fixed scorer. On that synthetic set:

- permissive held-in-only promotion accepted 2 of 3 held-out-regressing
  candidates (66.7% false-promotion rate); strict promotion accepted 0 of 3;
- permissive accepted held-out changes were `[-0.700, +0.400, -0.400,
  +0.167]` (mean `-0.133`); strict accepted changes were `[+0.400, +0.167]`
  (mean `+0.283`) with no accepted regression;
- insufficient budget was rejected in both modes (strictly before any metric
  call), strict overlap/contamination detection caught 1 of 1 known overlap,
  and every rejected candidate restored the exact prior state;
- with equal-size train and held-out sets, strict mode used 2× metric calls
  (4 vs 2 normally, 12 vs 6 with three repeated runs). In general its
  evaluation-call multiplier is `(train + validation) / train`.

Run the evaluation from the repository root:

```bash
AX_PRINT_METRICS=1 npx vitest run src/ax/agent/benchmarks/playbook-promotion-policy.test.ts
```

These are deterministic synthetic policy checks, not a claim about production
model quality or statistical power. Use strict mode when promoted playbooks are
persistent, shared, or costly to regress and a representative held-out set can
be afforded. The permissive default remains useful for exploration, low-impact
local learning, or when no credible held-out corpus exists; strict mode cannot
make an unrepresentative or tiny validation set representative.

Identity checking detects only equality under `task.id` or the caller's
`taskId` selector. Semantically duplicated tasks with different IDs remain
undetected, while reused IDs for genuinely independent cases are conservatively
rejected. Choose IDs from the data-generation lineage (not array position), and
keep the scorer, metric budget, and split construction under host control; a
proposal can edit only its candidate playbook bullet.

Generated packages expose that same agent-bound loop with language-shaped APIs:

| Language | Agent-bound evolve call |
|---|---|
| Python | `agent.playbook().evolve(dataset, options)` |
| Java | `agent.playbook(null).evolve(dataset, options)` |
| C++ | `agent.get_playbook()->evolve(dataset, options)` |
| Go | `agent.GetPlaybook().EvolveAgent(ctx, dataset, options)` |
| Rust | `playbook.evolve_agent(&mut agent, client, dataset, options)` |

All five generated packages thread structured `failureSignals` through agent
evaluation predictions. The default verify gate accepts a proposed bullet only
when held-in score improves and held-out score stays within `epsilon`; rejection
restores the exact prior snapshot. Each outcome reports both `status`
(`accepted` or `rejected`) and a stable human-readable `reason`. Scoring is host-shaped: TypeScript uses its
metric, Python/Java/Go can accept a metric callback, and all generated ports can
use task `score`/`scores` values plus the agent evaluation result.

## Playbook evidence discipline

Everything in this section is **default-off**. A call with none of these options
behaves exactly as it did before them.

### What halligan claims, and what it does not

halligan implements **bounded harness adaptation** (A/P/M/E in the survey's
vocabulary) — it proposes, gates, and retains context artifacts under explicit
thresholds. It is **not** recursive self-improvement: it does not modify its own
optimizer, its own evaluator, or its own gate, and `agentRecursiveOptimize` is
recursive decomposition, not RSI.

Benchmark score increases do not show that retained harness knowledge is more
efficient or transferable than spending the same compute directly on candidate
solutions.

### Evidence requirements for any PR claiming improvement (R1-R12)

A PR whose description contains a performance claim — "improves", "beats",
"+N points", "learns", "self-improves" — supplies all twelve, or restates the
claim as machinery evidence only.

| # | Requirement | What supplies it |
|---|---|---|
| R1 | Pre-register every mutable and immutable surface, in the body, before the numbers | the PR body |
| R2 | Pin model id, provider settings including reasoning effort, commit, lockfile, dataset digest, judge model and prompt version | `accounting.models`, `nomination.judgeModel`, `nomination.splitDigests` |
| R3 | train / validation / **sealed** test, disjoint by semantic id, sealed touched once and never selecting an iteration | `requireHeldOut` + `taskId` + `sealedTest` |
| R4 | Matched-budget best-of-N and self-refinement arms. A gain over one-shot inference is not a result | `controlArm` |
| R5 | Count all compute: proposer, judge, failed candidates, replay, mining, ablation; tokens and wall time, not only metric calls | `accounting` |
| R6 | `runsPerTask >= 2` on small sets, paired task-clustered bootstrap CI, an unchanged-artifact re-run band; no effect claimed when the interval contains zero | `varianceBand` + `intervalOptions` |
| R7 | Five axes: correctness, safety, cost, latency, maintainability | `validity` + `accounting` + `overhead` |
| R8 | Transfer to held-out tasks plus a held-out model or later model version, reported **per cell** | `transfer` |
| R9 | Causal rollback: ablate accepted components, report the leave-one-out matrix, record `inconclusive` honestly | `prune` -> `redundancy` |
| R10 | Lineage: candidate lineage, traces and **rejected** attempts with their in-round gate readings | `outcomes[].evidence` |
| R11 | Human review where executable scores miss quality, especially maintainability and security | outside the library |
| R12 | State what is missing. Independent reproduction and longitudinal evidence do not exist | the PR body |

Three refusals that are not negotiable:

- **Zero accepted candidates is a valid machinery result and an invalid capability result.**
- **Best-observed across iterations is not a deployment number.** Report the run you would deploy.
- **A relative gain is reported next to its absolute base.** "+132%" off 0.03 is not a result.

### Matched-budget control arm

```typescript
const result = await agent.playbook().evolve(
  { train, validation },
  {
    metric,
    requireHeldOut: true,
    runsPerTask: 2,
    controlArm: { arms: ['best_of_n', 'self_refine', 'harness_term'] },
    gates: { controlArm: 'require', controlArmMargin: 0 },
  }
);
result.control;          // required; { status: 'not_run', reason } when unconfigured
result.applied;          // 'live' | 'dry_run' | 'rolled_back'
```

- The arm runs on the **restored unevolved** program at the evolution run's own accounted budget, from a separate counter, so it can never starve the search.
- `harness_term` is a content-free neutral artifact of the same rendered size. It is the only arm that separates "this bullet helped" from "any text in that slot helped". Excluding it emits `harness_term_not_run`.
- `selector: 'metric'` picks the best arm sample **using the metric itself**, which is oracle-strong: it biases against the evolved artifact and can cause false rejects. That direction is deliberate.
- `gates.controlArm: 'require'` is a **run-level** gate: on failure the whole accepted set is rolled back, `applied` becomes `'rolled_back'`, and `playbookSnapshot` is `undefined` because that artifact is poison, not a draft.
- `warn` mode still says something: `control_arm_not_beaten` when a comparison happened and was lost, `control_arm_unmeasured` when there was no comparison to lose.

### Intervals and the unchanged-artifact band

```typescript
{
  varianceBand: { extraRepeats: 1 },
  intervalOptions: { resamples: 10_000, level: 0.95, seed: 7 },
  gates: { interval: 'require' },
}
```

- Resampling draws **tasks** with replacement, not attempts: repeats of one task are not independent samples.
- `direction: 'unresolved'` whenever the interval contains zero. It is never rounded to the side the point estimate fell on.
- `interval_unresolved` covers **both** unresolved cases: an interval that was computed and contains zero, and one that could not be computed at all because no task could be paired between the two passes (the control arm and the sealed test both emit it, `scope` naming which). The report still carries an `interval` field, reading `clusters: 0, resamples: 0`, so an uncomputed comparison never sits on a receipt shaped exactly like a real paired bootstrap.
- The band is the smallest delta distinguishable from run-to-run noise on an artifact that did not change. A point delta inside it emits `delta_within_variance_band`.
- `gates.interval: 'require'` without a `varianceBand` is **rejected at option validation**: a required gate must not silently degrade to "excludes zero".
- On a 12-task split, tight thresholds produce **both** false accepts and false rejects. Widen the split before tightening the gate.

### Reach

Three bases, and only one can gate:

| Basis | Set by | Gate-eligible |
|---|---|---|
| `host_probe` | `reachProbe` | yes |
| `applicability_counterfactual` | `conditionsForTask` | **no** |
| `rendered_only` | default | **no** |

- Host recipe: scan `prediction.actionLog` for the `[<bulletId>]` prefix `renderPlaybook` emits, and return the invocation count.
- An `applicability_counterfactual` reach of `1.0` is the **expected** reading for evolve-curated bullets, not a good one — the receipt labels it (`reach_counterfactual_basis`) rather than suppressing it.
- Reach `0` under `host_probe` with a positive delta emits `reach_zero_positive_delta`: that is a prompting or format effect, not the artifact.
- A probe that throws makes the split `unmeasured` and emits `reach_probe_failed`. The run continues — reach is evidence, not scoring.

### Validity conjuncts

```typescript
{
  validity: {
    minFinalCompletionRate: 0.9,   // share of attempts ending in `final`, per record
    maxUnknownFunctionCallRate: 0.02,
    maxToolErrorRate: 0.1,
    maxMeanTotalTokens: 4000,
    maxMeanLatencyMs: 20_000,
  },
  gates: { validity: 'require' },
}
```

- Every required predicate must pass on **both** splits.
- `unmeasured` is never a pass. Under `require` it fails the candidate with `validity:<id>@<split> unmeasured`.
- `unknown_function_call_rate` and `tool_error_rate` are computed **in Ax** against the agent's registered function set. `classifyFunctionCall` is a host **override**, recorded as `overriddenByHost: true` — not the only source, because a classifier that returns `ok` for everything would launder the gate.

### Transfer cells

```typescript
{
  transfer: {
    targets: [
      { id: 'nano', ai: nanoService },
      { id: 'sonnet', ai: sonnetService },
    ],
    splits: ['heldOut'],
    regressionFloor: 0.02,
  },
  gates: { transfer: 'require' },
}
```

- **Never emit an average.** `AxAgentPlaybookTransferReport` has no mean field and a type test bans adding one. Averages hide catastrophic cells: a matrix whose cells are `+0.50` and `-0.36` averages to a win and contains a target that got materially worse.
- One cell per `(target, split)`, each with its own anchor, candidate, delta, interval and model identity. `regressedCells` lists `${targetId}:${split}` for every cell past the floor.
- The anchor is the **target's own** reading of the unevolved artifact, taken before any mutation. Borrowing the primary model's baseline would attribute the model gap to the playbook.
- `target.id` is caller-owned. Ax never derives a cell label from the service. `target.evaluatorId` is **caller-side metadata only**: it is validated as a string and Ax never reads it — it appears on no cell, no receipt and no accounting row. Use it to tag your own records; do not expect it back.
- Largest budget multiplier in the API: `|targets| x sum(splits) x runsPerTask x (1 + maxDiscardRedraws) x 2`, failing closed before mutation when `transfer.maxMetricCalls` cannot pay for it. Each `(target, split)` pass draws from **its own** sub-budget, so one target's re-draws can never truncate another's pass and be reported as that target regressing.
- Fails closed on a matrix it cannot read: a missing cell, an incomplete pass, or a pair it could not align. A pass that ran out of its own budget says so, and names the budget rather than the target.
- When the run produced no artifact change the matrix is `not_run` with that reason: the candidate pass would score the same artifact the anchors already scored and charge the caller's own services to measure run-to-run noise.
- A non-`off` gate that fails without rolling anything back — a dry run, or a run that accepted nothing — still says so, on the same warning, with the reason nothing was rolled back. A failing gate is never indistinguishable from `gates.transfer: 'off'`.
- After a run-level rollback `result.transfer` is returned **unchanged**, describing the artifact that was withdrawn. It is a record of what was measured, not of what is live; `applied`, `playbookSnapshot` and every receipt are the fields that moved.

### Trajectory termination

```typescript
{ classifyTermination, runsPerTask: 2, maxDiscardRedraws: 1 }
```

- Host-owned and conservative: returning `undefined` means `policy_failure`. A program that reliably drives a tool into a timeout **is** worse and must not be laundered out of the denominator. Ax never infers `environment_failure` on its own.
- Discarded attempts consume budget and are **never scored as zeros**; they are reported in `termination` and in `discardedRuns`.
- One attempt, one vote: a 50-turn trajectory and a 2-turn trajectory count the same.
- Bounded re-draws happen within the same metric budget. Default 1 with a classifier, 0 without.
- Set `runsPerTask >= 2` whenever `classifyTermination` is supplied: at 1 there is no redundancy at all.
- A classifier that throws raises `classifier_invalid`. A classifier that cannot classify returns `undefined`.

### Pruning and deprecation

```typescript
{ prune: { enabled: true, operation: 'remove', minTokenReduction: 20 } }
```

- A removal is a mutation and pays the same price as an addition: the same re-evaluation, the same retention receipt, the same gate chain — in its **loss-tolerance** variant, because a removal cannot raise the current-task mean by `minHeldInGain`.
- Gated by a leave-one-out held-out sweep (`result.redundancy`) plus a rendered-size reduction the prune must actually deliver.
- **No silent truncation.** Over `maxRenderedTokens` with `onOverflow: 'warn'` you get `rendered_size_over_budget`, not a shorter playbook.
- Residual, stated plainly: the curator can still remove bullets on the **curate** path via `REMOVE`, `evidence.lifecycle.status` or `supersedes`, so the prune gate is not a complete removal control. Section-overflow eviction is reported (`curate_eviction`, `outcome.evictions`) but not gated.

### Promotion authority

```typescript
{
  promotionAuthority: { authority, resourceId: 'playbook:support-agent' },
  promotionVeto: async (nomination) => nomination.gatesFailed.length > 0,
}
```

- The **grant** says "this principal may promote into this playbook" and binds to a stable `resourceId` the host can pre-grant. `AxResourceScope` is matched by exact identity **before** the host authorizer runs, so Ax never derives the id.
- The **veto** is the only channel that sees the candidate. Reject-only, conjunctive, fail-closed: anything that is not `false` / `{ vetoed: false }` — `undefined` included — is a veto.
- `promotionDigest` is **receipt metadata, not consent**. It identifies what was promoted; it authorizes nothing.
- No `promotionAuthority` configured stays permissive but is never silent: `promotion_without_receipt`.
- A promoted candidate rescinded by a run-level gate moves all five together: `promotion.status = 'promoted_then_rolled_back'`, `evidence.decision = 'superseded'`, `applied = 'rolled_back'`, `playbookSnapshot = undefined`, plus `promotion_rolled_back`.
- `onProgress` emits a `'promotion'` phase per nomination carrying the decision: the status, plus the denial code and reason, the blocking veto ids, or the granted receipt id. A promotion that was denied is visible while the run is still going, not only afterwards on the result.
- Hosts supplying a veto or an authority run `runAxAgentPlaybookEvidenceConformance` first. It makes **real** host calls — two veto invocations and one genuine `axAuthorize` against the live `AxAuthorityContext` — so pre-grant `axPlaybookEvidenceConformanceOperation` on `axPlaybookEvidenceConformanceResource` before calling it, or the kit's own request is denied and it asserts nothing.

### Held-out is a selection split

`heldOut` is re-anchored to the accepted candidate after **every** accept, so
with `maxProposals` it has selected the artifact up to that many times.

- A held-out delta from `evolve()` is a **selection** number. Do not report it as a test number.
- `evidence.heldOutContamination` carries `selectionComparisons` (the accept count before that reading) and `impliedFamilyWiseErrorRate = 1 - level^k`. `held_out_reused_for_selection` fires **whenever a held-out set is used at all**, not only when the number looks bad.
- No alpha-adjustment is applied. The correct correction depends on a stopping rule the caller owns; a Bonferroni factor applied without knowing which would look like rigour and would not be.
- `sealedTest` is how you get a test number:

```typescript
{ sealedTest }   // disjoint from train and validation by semantic id
result.sealedTest;   // { status: 'completed', baseline, final, delta, interval, influencedNoDecision: true }
```

  Evaluated **once**, after the run-level verdict, on the baseline artifact and
  the final artifact. `influencedNoDecision` is a literal `true`: there is no
  inhabitant of the report in which it influenced anything, and no gate reads
  it. When the run produced no artifact change it reports `not_run` with the
  reason rather than reporting run-to-run noise, and when either pass could not
  finish the whole split — budget exhausted, or every attempt at a task
  discarded — it reports `not_run` too: a prefix mean is not a test number, and
  a pass that scored nothing has a mean of `0` that would otherwise publish as
  the run's delta. Either way `sealed_test_not_run` fires and no delta exists.
  A restore that fails around phase 11 throws `sealed_test_failed` in phase
  `sealed_test`, never the control arm's error.

- The `held_out_reused_for_selection` warning and its family-wise error rate go in the PR's Evaluation section verbatim, alongside the sealed-test delta — or an explicit statement that no sealed test was run.

## Playbook vs optimize()

- `playbook(...)` — accumulate reusable, evolving task knowledge; the only path that also learns online via `update(...)`.
- `optimize(...)` / `agent.optimize(...)` — tune instruction text and few-shot demos offline to a best/Pareto result.
- They are complementary; a project can use both.

## Troubleshooting

- "Cannot convert undefined or null to object" from `update()` → you passed input fields at the top level; wrap them in `example: { ... }`.
- Empty playbook after `evolve()` → the model already scored well, so nothing was curated; use harder/ambiguous examples or a weaker `studentAI` to surface lessons.
- Playbook not affecting an agent's behavior → ensure `apply` is not `false` and you used `agent.playbook(...)` (not a bare `playbook()` on an internal program).

## Testing

```bash
# Unit + type + lint + format + index, in the ax workspace
npm run test --workspace=@ax-llm/ax

# Focused runs while iterating
npx vitest run src/ax/agent/agentInternal/playbookEvolve/
npx tsc -p src/ax/tsconfig.typetests.json --noEmit

# Regenerate and review the public barrel (never hand-edit src/ax/index.ts)
npm run build:index --workspace=@ax-llm/ax

# The deterministic zero-cost evidence evaluation and its paired assertions
npm run evaluate:playbook-evidence
npx vitest run scripts/evaluate-playbook-evidence.test.ts

# Gates
npm run axir:backlog:validate
npm run test:evaluation-policy
```

A host supplying any of `classifyTermination`, `reachProbe`, `promotionVeto` or
`promotionAuthority` runs the conformance kit against its own callbacks first:

```typescript
import { runAxAgentPlaybookEvidenceConformance } from '@ax-llm/ax';

const report = await runAxAgentPlaybookEvidenceConformance({
  authority,                 // the live AxAuthorityContext
  promotionVeto,
  classifyTermination,
});
if (!report.passed) throw new Error(report.failures.join('; '));
```

It makes **real** host calls. Pre-grant `axPlaybookEvidenceConformanceOperation`
on `axPlaybookEvidenceConformanceResource` or the kit's own authorization
request is denied and the echo assertion is never made.

## Examples

- `src/examples/agent-playbook-evidence.ts` — the full evidence surface on one
  run: control arm, band, intervals, validity, reach, transfer, sealed test.

```bash
npm run tsx src/examples/agent-playbook-evidence.ts
```

## Do Not Generate

- Do **not** report a transfer average, a mean cell delta, or "transfer looks fine overall". Report the cells.
- Do **not** report a gain without its matched-budget arm **or** without its `overhead` block.
- Do **not** report a held-out delta as a test result. It is a selection number.
- Do **not** call an interval that contains zero an effect. It is `unresolved`.
- Do **not** describe `evolve()` as self-improving, recursively self-improving, or RSI. It is bounded harness adaptation.
- Do **not** estimate `costUsd`. Ax has no provider cost field; supply `costFor` or leave the basis `unknown`.
- Do **not** treat `applicability_counterfactual` or `rendered_only` reach as evidence, and do not configure them expecting the reach gate to pass.
- Do **not** bind `promotionAuthority.resourceId` to a per-candidate value. A derived id is one no host could have pre-granted.
- Do **not** hand-write `AxAgentPlaybookEvolveResult` doubles without `control`, `accounting` and `applied` — they are required, and `applied` is a three-state discriminant, not a boolean.
- Do **not** read `sealedTest` before the run finishes or feed it into a threshold. Nothing in the gate chain may consume it.

## See Also

- `ax-gepa` - `optimize(...)` and `AxGEPA` for instruction/demo tuning.
- `ax-agent-context` - choosing between contextMap, contextPolicy, `agent.playbook(...)`, and recall.
- `ax-agent-optimize` - `agent.optimize(...)` GEPA tuning for agents.
