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
- Scope retrieval with `pb.render({ conditions })` / `pb.applyTo(program, { conditions })`; entries with unmet applicability, expiry, deprecation, or supersession are excluded by default. Use `{ includeInactive: true }` only for inspection.
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
  { metric, runsPerTask: 2 }, // verify:true by default
);
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
