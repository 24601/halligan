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
  { metric, runsPerTask: 2 }, // verify:true by default
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
run's anchors. Each fully evaluated proposal gets `outcome.retention` with its
current-task gain, every named/versioned anchor and candidate score, per-slice
loss, expected/executed run counts, evidence completeness, worst/mean
historical loss, thresholds, and the final gate decision. Rejected proposals
use the existing exact snapshot rollback. The result also exposes
`retentionAnchors`. `minCurrentGain` replaces `minHeldInGain` for this optional
gate and compares each proposal with the last accepted current-task score;
fixed historical anchors prevent sequentially accepted losses from resetting.
The existing validation-set `epsilon` gate still applies independently.

Retention is optional and default-off. It requires verified evolution, adds
one baseline and one candidate evaluation per anchor task (times
`runsPerTask`), and fails before mutation when the metric budget cannot
establish complete anchors. Invalid weights, evaluator errors, and non-finite
scores fail closed; an interrupted candidate evaluation rolls back. It does
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
restores the exact prior snapshot. Scoring is host-shaped: TypeScript uses its
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
