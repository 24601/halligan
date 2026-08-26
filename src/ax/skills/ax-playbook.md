---
name: ax-playbook
description: This skill helps an LLM generate correct playbook code using @ax-llm/ax. Use when the user asks about playbook(), AxPlaybook, context playbooks, evolving context, ACE / Agentic Context Engineering, agent.playbook(), or growing/applying task knowledge offline and online with evolve() and update().
version: "__VERSION__"
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
- The playbook engine, construction-time agent attachment, failure harvesting,
  and verified agent evolution are available in TypeScript and the generated
  Python, Java, C++, Go, and Rust packages. Use each package's native casing and
  callback types.

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
});
pb.applyTo(program);
```

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

## Playbook vs optimize()

- `playbook(...)` — accumulate reusable, evolving task knowledge; the only path that also learns online via `update(...)`.
- `optimize(...)` / `agent.optimize(...)` — tune instruction text and few-shot demos offline to a best/Pareto result.
- They are complementary; a project can use both.

## Troubleshooting

- "Cannot convert undefined or null to object" from `update()` → you passed input fields at the top level; wrap them in `example: { ... }`.
- Empty playbook after `evolve()` → the model already scored well, so nothing was curated; use harder/ambiguous examples or a weaker `studentAI` to surface lessons.
- Playbook not affecting an agent's behavior → ensure `apply` is not `false` and you used `agent.playbook(...)` (not a bare `playbook()` on an internal program).

## See Also

- `ax-gepa` - `optimize(...)` and `AxGEPA` for instruction/demo tuning.
- `ax-agent-context` - choosing between contextMap, contextPolicy, `agent.playbook(...)`, and recall.
- `ax-agent-optimize` - `agent.optimize(...)` GEPA tuning for agents.
