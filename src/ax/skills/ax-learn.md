---
name: ax-learn
description: This skill helps an LLM generate correct learning-surface code using @ax-llm/ax. Use when the user asks about interaction receipts, agent.learn(), report(), AxLearningStore, harness trees, axHarnessEvolve, release chains, or self-improving agent patterns.
---

# Learning Surface Codegen Rules (@ax-llm/ax)

Prefer short, modern, copyable patterns. Do not write tutorial prose unless the
user explicitly asks for explanation.

## Use These Defaults

- `agent(sig, { ai, learning: { scenario, store, surface } })` — learning is
  opt-in. Absent, nothing records and nothing costs.
- `axInMemoryLearningStore()` for tests and local development.
  `capabilities.durability` is `'volatile'`; a durable host store is the
  caller's to supply, and it must pass `runAxLearningStoreConformance`.
- `const { output, receipt } = await a.learn().run(ai, values)` — the only path
  that records.
- `await a.learn().report({ references: [receipt.recordId], score })` — one
  report per receipt.
- `axScoreWindowProcessor()` — window `(-Infinity, 0]`, so only failures batch.
- `selection: 'axPlaybookGate'` and `gate.requireHeldOut` default **true**.
- Current models from the provider enums, never a dated preview when a stable
  newer one exists.

## Non-Negotiable Rules

- Recording happens in `a.learn().run(...)`. A bare `forward()` records
  nothing, and `streamingForward()` is not recorded at all.
- Only interaction ids are receipts, and they appear only in `references`. A
  reference naming a report record is refused.
- Unknown top-level report keys are dropped. Method data belongs under
  `feedback` or `metadata`.
- `metadata.training.eligible` is the one metadata key the framework reads, and
  only the literal `false` opts out.
- **The `artifactRef` names the tree the agent was serving.** It comes from the
  live installation, never from the store head. No installation means no ref at
  all — "this exchange is not attributable to any release" is a true statement
  and is recorded as one. When the chain has moved past what the agent serves,
  the record says `stale: true` and carries the head's `contentId` beside its
  own. When no head has ever been observed, `headContentId` is absent and
  `stale` is `false`: nothing is known to supersede the installed tree.
- A proposer's model traffic never records and never receives the served
  provider.
- **`axHarnessEvolve` nominates. `surface.promote(...)` deploys. Nothing inside
  ax calls `promote`.**
- `contentId` is a full `sha256:` content identity. `fnv1a64` retention digests
  elsewhere in the repo are checksums, not authenticity. Do not confuse the
  registers, and do not treat `contentId` as a confidentiality control.
- A published tree carries no credential and no provider binding. A pulled tree
  does not run until the consumer supplies its own `ai()`.
- A proposer cannot write bullet counters, timestamps, revision, lineage or
  evidence. Admission rejects an entry that tries.

## Canonical Pattern

```ts
import {
  agent,
  ai,
  axApplyHarnessTree,
  axHarnessEvolve,
  axInMemoryLearningStore,
  axLearningSurface,
} from '@ax-llm/ax';

const llm = ai({ name: 'openai', apiKey: process.env.OPENAI_APIKEY!, config: { model: 'gpt-5-mini' } });
const store = axInMemoryLearningStore();
const surface = await axLearningSurface({
  scenario: 'support-triage',
  store,
  seed: [{ id: 'tone', kind: 'instruction', config: { text: 'Answer in one sentence.' } }],
});

const a = agent('question:string -> answer:string', {
  ai: llm,
  playbook: { learn: false },
  learning: { scenario: 'support-triage', store, surface },
});

// Serve the promoted head.
const head = await surface.currentTree();
let installed = head && (await axApplyHarnessTree(head.entries, a, {
  releaseId: head.releaseId,
  now: new Date().toISOString(),
}));

// Record, then grade.
const { output, receipt } = await a.learn().run(llm, { question: 'refund window?' });
await a.learn().report({ references: [receipt.recordId], score: 0 });

// Grow. This NOMINATES; it does not deploy.
const step = await axHarnessEvolve({
  agent: a,
  ai: llm,
  surface,
  tasks: { train: trainTasks, validation: validationTasks },
  metric: myMetric,
  propose: ({ nodes, samples, manifest }) => [
    { op: 'create', id: 'b1', options: { kind: 'playbookBullet', config: { id: 'be-brief', section: 'General', content: 'Answer in one sentence.' } } },
  ],
});

if (step.status === 'nominated' && step.release) {
  console.log(step.decision?.reason, step.decision?.metrics.heldOut);
  // HUMAN DECISION POINT. Nothing in ax reaches this line for you.
  await surface.promote(step.release.releaseId, head!.releaseId);
  installed?.dispose();
  installed = await axApplyHarnessTree(step.release.entries, a, {
    releaseId: step.release.releaseId,
    now: new Date().toISOString(),
  });
}
```

## The evolution-scope litmus

Two categories, and only one of them is versioned.

- **Versioned artifact** — this surface owns it: agent instruction text,
  playbook bullets, skill definitions. Anything that answers *"which version
  produced this response?"*.
- **Run state** — the caller owns it and it is never committed: session memory,
  `contextMap` entries, one conversation's history, tool scratch state, **and
  the bullets the construction-time `playbook` option accumulates at runtime**.

The litmus is the direction of data flow: **code whose input is a request and
whose output is the next request is the harness; code whose input is the record
store and whose output is a nomination on the release chain is this surface** —
even when it calls an LLM, because it never answers a user request.

Corollary: *learned state is runtime output, never committed into the evolved
artifact.* A tree install therefore **replaces** the playbook. On an agent with
continuous playbook learning, `axApplyHarnessTree` refuses without
`acknowledgeContinuousPlaybookReset: true`, and reports `discardedBulletCount`
so the reset is counted rather than silent.

## Records and receipts

`AxLearningInteractionRecord` carries `{ kind, id, scenario, createdAt,
artifactRef?, payload }`. `payload` is `{ signature, programId, input, output? |
failure?, model?, usage?, tags? }`.

- `run()` does not resolve until the record is durable. There is no receipt
  without a record.
- A run that throws records nothing unless `recordFailures: true`; then it
  records `failure: { name, message }` with no stack, and still rethrows.
- An append failure rethrows by default. `onRecordError` is an explicit opt-out
  the caller writes; even then `run()` rejects rather than handing back a
  receipt with nothing behind it.
- `onInteraction` is awaited before `run()` resolves — deliberately unlike the
  fire-and-forget `onUsedMemories` / `onUsedSkills`.
- An absent `artifactRef` means no tree was installed. `stale: true` means the
  agent served something the chain has moved past. Neither is an error; both
  are facts a consumer needs.

## Reports and axReportSchema

`axReportSchema(fields)` is a **floor, not a ceiling**: declared fields are
validated, undeclared `feedback`/`metadata` keys pass through untouched.
`score` is the only name that means a top-level field; every other name means
`metadata.<name>`. `references`, `feedback`, `metadata` and `id` are reserved
and throw at schema construction.

Validation runs at ingress, in `report()`. A schema-invalid report never becomes
a record and therefore never reaches the reducer.

## Eligibility: train, wait, never

`axLearningEligibility` plus the processor decide `train` / `wait` / `never`.
Every `never` is named and counted forever, because a silently dropped report is
the failure mode that makes a learning loop look healthy while learning nothing.

| Reason | When |
|---|---|
| `no-references` | the report grades nothing |
| `no-score` | no score at all |
| `non-finite-score` | `NaN` / `±Infinity` |
| `boolean-score` | a boolean is not a score |
| `training-opted-out` | `metadata.training.eligible === false` |
| `duplicate-references` | the same receipt twice |
| `multi-reference` | processor arity rule |
| `score-outside-window` | outside `[minScore, maxScore]` |
| `already-trained-source` | the exchange already trained |
| `report-already-seen` | the same report id twice |
| `slot-occupied` / `group-discarded` | processor grouping rules |
| `parked-evicted` | the parked-report cap dropped it |

`wait` happens exactly when a referenced interaction has not arrived yet, and
carries the missing ids. Late and out-of-order feedback is a legal ordering.

## Harness trees

Three kinds, and only three: `instruction`, `playbookBullet`, `skill`. There is
no `demo` and no `config` kind.

`axRenderHarnessTree(tree, { now })` is pure. `axApplyHarnessTree(tree, target,
opts)` is the installer and returns an exact `dispose()`. `now` is not part of
`contentId`, which digests the admitted entry list in tree order.

`axInspectHarnessTree` returns a per-entry verdict; `axAdmitHarnessTree` is the
throwing wrapper carrying the first denial plus the full report. Admission runs
at seed, on every proposal, and whenever persisted state loads.

A proposer-authored bullet is `{ id, section, content, tags? }` and nothing
else. `helpfulCount`, `harmfulCount`, `createdAt`, `updatedAt`, `revision`,
`lineage` and `evidence` are **rejected, not stripped**: bullet evidence sits
behind Ax's evaluator boundary, and stripping would teach a proposer that
writing them is harmless.

### Credential tripwire, and its honest limits

Two rules, over **every field of every kind** including model-authored free
text, because a tree persists verbatim into every release, every gate decision
and every delivered copy:

1. a key whose **name** ends in a credential word (`apiKey`, `api_key`,
   `API_KEY_ENV`, `token`, `secrets`, `passwords`, `credentials`, …) holding a
   string, or an array containing one;
2. a **value** matching a known credential literal — `sk-…`, `ghp_…`,
   `xox?-…`, `AKIA…`, a PEM private-key header, a JWT, or a 40-plus-character
   opaque run within 32 characters of a credential word.

Errors and inspection rows carry the JSON **path**, never the value.

This is a tripwire, not a secret scanner. Rule 1 matches key names; rule 2
matches known shapes. A novel credential format under an innocuous key is not
caught. Do not describe it as a guarantee.

## Evolving and the gate

`axHarnessEvolve` reuses the promotion gate `agent.playbook().evolve()` uses:
held-in gain at or above `minHeldInGain` (0.05) **and** held-out within
`epsilon` (0.01). There is no retention-anchor option here — that receipt's
digests cannot be produced outside `playbookEvolve.ts`.

`gate.requireHeldOut` defaults **true**, unlike `evolve()`. A flat task array
throws `AxHarnessEvolveConfigError` before any model call. Setting it `false`
runs held-in-only, omits the held-out metrics, and says so in `gate.reason` —
that is the same permissive regime this repository measures at a **66.7%
false-promotion rate** on six fixed candidates
(`src/ax/agent/benchmarks/playbook-promotion-policy.test.ts`).

`selection: 'scoreComparison'` (`wins > losses`) exists for reef parity only and
is structurally weaker: it requires no gain threshold and no held-out
non-regression. `scripts/eval-learning-surface.ts` measures both on fixed
candidates; read its output rather than assuming a gap.

Episodes are **interleaved** and alternate first position, so provider drift
hits both sides equally. Model cost is unchanged (`2 × tasks × runsPerTask`);
the added cost is one install swap per episode — three setter calls and one
`AxPlaybook.load`, in process, no IO. On an agent with a very large catalog the
catalog rebuild is the dominant term.

A crashed episode scores `null`, ranks below every real score, and is stored as
`null` so "could not run" stays distinguishable from "scored zero". Both sides
crashing is a tie and nominates nothing.

`axHarnessEvolve` must not run concurrently with `forward()` on the same agent
instance — it swaps installations per episode, and no type or runtime check
enforces the rule.

## Release chain, nomination, and delivery

- `publish()` appends with `current: false` by compare-and-set on the tail. It
  never moves the head.
- `promote(releaseId, expectedHead)` moves the head by a separate
  compare-and-set. This is the human decision point.
- `rollback(releaseId, expectedHead)` republishes an old `contentId` under a
  **new** `releaseId` and promotes it. `step` never rewinds.
- The gate decision travels with the release whether or not it is promoted, so
  `releases()` is a decision log over numbers.
- Delivery is a pull: `currentTree()` returns plain JSON a host may serve over
  any transport it likes. Ax ships no HTTP surface.

## Testing

```bash
npx vitest run src/ax/learn src/ax/agent/agentInternal/agentLearning.test.ts
npm run test --workspace=@ax-llm/ax
npm run learn:eval
npm run test:learning-eval
```

`npm run learn:eval` is a deterministic mechanism evaluation with a stub
provider, fixed metrics and fixed task sets. It is not an independent model
held-out set and not a live-model improvement claim.

## Examples

- https://raw.githubusercontent.com/ax-llm/ax/main/src/examples/learning-surface.ts

## Do Not Generate

- No HTTP routes, install scripts, or sidecar machinery. Delivery is in-process.
- No second canonicalizer and no second digest register — reuse
  `axEventCanonicalJson` / `axEventCanonicalDigest`.
- No `Date.now()` in library code. Every timestamp comes from an injected clock.
- Do not look for `sampleFields` / `maxSampleBytes` on the agent's `learning`
  config. The sample projection and the byte cap are options on
  `axCreateLearningEngineState`, where the batch is actually built.
- No `node:` imports under `src/ax/learn`.
- Do not expect a bare `forward()` or `streamingForward()` to record.
- Do not treat `contentId` as a confidentiality control.
- Do not call `promote()` from automation without a human decision point.
- Do not claim canary, staged rollout, online monitoring, or automatic
  demotion. **None exist.**
