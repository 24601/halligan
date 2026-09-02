---
name: ax-trajectory
description: Use AxTrajectoryStore to keep an append-only agent life log with digest-verified blob spill, fork/merge, durable per-consumer cursors, a bounded filtered backward tail, and tiered-rollup context projection. Use when the user asks about AxTrajectoryStore, AxTrajectoryStep, axProjectTrajectory, rollups, drill-down, AxJSONLTrajectoryStore, or runAxTrajectoryStoreConformance.
---

# Ax Trajectory Codegen Rules

Prefer short, modern, copyable patterns. Do not write tutorial prose unless the
user explicitly asks for explanation.

A trajectory is an agent's autobiography: an append-only log of immutable
steps, plus a projection that turns an unbounded life into a bounded context
window. It is not chat history and it is not an observability trace.

## Use These Defaults

- `AxInMemoryTrajectoryStore` for tests, `AxJSONLTrajectoryStore` (from
  `@ax-llm/ax-tools`) for anything that must survive a restart.
- The shipped registry: `axTrajectoryTypeRegistry()`. Pass descriptors only to
  add your own types.
- `fanout: 10` and `budgetTokens: axTrajectoryContextBudget({ contextWindowTokens })`.
  Those are the only two knobs. Everything else is derived.
- `axDeterministicTrajectorySummarizer()` when you want tiered recall with no
  model bill; `axTrajectoryProgramSummarizer({ ai })` when you want a model.

## Non-Negotiable Rules

- **Append only.** There is no update, delete, rewrite or compact method on
  `AxTrajectoryStore`, and there will not be one.
- **Every read is bounded.** `read` needs a `limit` unless both `fromSeq` and
  `toSeq` are given; `tailBackward` has `maxScan`; `readFrom` takes a budget;
  `getSteps` accepts at most `axTrajectoryMaxStepIds` (256) ids.
- **Rehydrate every spilled field.** A step with `blobs` carries a truncated
  head, not the value. Use `axResolveTrajectoryStep` /
  `axResolveTrajectorySteps`; they verify the SHA-256 digest and throw rather
  than hand back a truncated head.
- **Group a run by `runId`, never by position.** Concurrent runs interleave.
- **Classify every new type.** An unregistered type is `unknown`: never
  wakeable, never projected, still appendable and readable.
- **Timestamps are epoch-ms numbers.** No string timestamp ever enters a step.
- **Machinery never carries `source`.** `append` throws
  `AxTrajectoryAppendError('source_on_machinery_step')` at the write boundary.

## Canonical Pattern

```ts
import {
  AxInMemoryTrajectoryRollupStore,
  AxInMemoryTrajectoryStore,
  axBuildTrajectoryRollups,
  axDeterministicTrajectorySummarizer,
  axProjectTrajectory,
  axResolveTrajectoryCitations,
  axTrajectoryContextBudget,
} from '@ax-llm/ax';

const store = new AxInMemoryTrajectoryStore();
const { trajectoryId } = await store.create({ slug: 'assistant' });

await store.append({
  trajectoryId,
  type: 'thought',
  source: 'monolith',
  data: { content: 'I should re-read the deploy runbook.' },
});

// Bounded backward read: the last 20 narrative steps, reporting how far it
// looked and whether it reached the head.
const tail = await store.tailBackward({
  trajectoryId,
  limit: 20,
  classes: ['narrative'],
});

// Tiered rollups: seal every block whose children now exist. Idempotent.
const rollups = new AxInMemoryTrajectoryRollupStore();
await axBuildTrajectoryRollups({
  trajectoryId,
  store,
  rollups,
  summarizer: axDeterministicTrajectorySummarizer(),
  maxBlocks: 8,
});

// The projection: coarse-to-fine summaries, then a verbatim recent stream.
const projection = await axProjectTrajectory({
  trajectoryId,
  store,
  rollups,
  budgetTokens: axTrajectoryContextBudget({ contextWindowTokens: 200_000 }),
});
projection.render; // the string to put in a prompt
projection.coverage.gaps; // index ranges no section accounts for

// Drill-down: a coarse entry is a pointer, not testimony.
const cited = await axResolveTrajectoryCitations(
  store,
  trajectoryId,
  projection.citableStepIds.slice(0, 5)
);
```

## Step Types And Classification

`stepClass` is a declared registry property, not an allowlist by omission.
Only `narrative` steps reach a projection.

| type | class | wakeable | carries `source` | spill fields |
|---|---|---|---|---|
| `trajectory` | structural | no | no | — |
| `fork` | structural | no | no | — |
| `merge` | structural | yes | no | `content` |
| `thought` | narrative | yes | yes | `content` |
| `action` | narrative | yes | yes | `content` |
| `observation` | narrative | yes | yes | `content` |
| `idle` | narrative | yes | yes | — |
| `message` | narrative | yes | yes | `content` |
| `error` | narrative | yes | yes | `content` |
| `run` | machinery | no | no | `command` |
| `run-summary` | machinery | no | no | `fullSummary` |
| `runtime-output` | machinery | no | no | `stdout`, `stderr` |
| `feedback` | machinery | no | no | `content` |
| `reply-claim` | machinery | no | no | — |
| `mind-wake` | machinery | yes (signal) | no | — |
| `mind-idle` | machinery | yes (signal) | no | — |
| `manual-trigger` | machinery | yes (signal) | no | — |
| `mind-error` | machinery | no | no | `reason` |

Add your own:

```ts
const registry = axTrajectoryTypeRegistry([
  { type: 'journal', stepClass: 'narrative', wakeable: true, carriesSource: true },
]);
```

A machinery descriptor may not set `carriesSource`, and a protected type's
`neverRetriggersSelf` may not be cleared; both throw
`AxTrajectoryRegistryError`.

## Blob Spill And The Read-Side Resolver

Spill is generic and size-based: **any** string field at or above
`spillBytes` (default 4096) moves to the blob store, leaving a UTF-8-safe
inline head and a `AxTrajectoryBlobRef` with the full byte count and the
SHA-256 digest.

```ts
const [step] = await store.getSteps(trajectoryId, [stepId]);
const full = await axResolveTrajectoryStep(step, store.blobs);
full.data.content; // the whole value, digest-verified
```

Reading `step.data.content` without resolving silently gives you a head. That
is the 312 MB / 19k-step failure this subsystem exists to prevent.

## Cursors

Cursors are per consumer and durable, so a slow reader never costs another
reader its position.

```ts
const cursor = await store.loadCursor('mind', trajectoryId);
const drain = await store.readFrom(cursor, trajectoryId, { maxSteps: 32 });
await store.saveCursor('mind', drain.cursor);
drain.corrupt; // frames the tolerant parser skipped on THIS drain
```

When a cursor carries a `token`, the token decides where the drain resumes;
`seq` alone cannot survive a tolerant parse that dropped an interior frame.
An unusable cursor throws `AxTrajectoryCursorError` with a `reason` of
`identity_changed`, `not_a_frame_boundary`, `shrank` or `beyond_end` — it
never silently skips a committed step.

## Fork And Merge

```ts
const { childTrajectoryId, forkStepId } = await store.fork({
  parentTrajectoryId: trajectoryId,
  slug: 'sub-run',
});
await store.merge({
  parentTrajectoryId: trajectoryId,
  childTrajectoryId,
  content: 'found the stale lockfile',
  outcome: 'succeeded',
});
```

Both directions are written before either is observable, so neither side ever
needs a search. A sub-run always merges something back — `'(max turns
reached)'` on failure — or it is invisible in the parent's life.

## Projection And Budget

```
budget = min(fraction * contextWindowTokens, maxTokens)   // 0.6, 4000
R      = max(20, floor(0.4 * budget / tokensPerStep))     // the raw tail
cut0   = floor((N - R) / F) * F                           // snapped to F
```

`contextWindowTokens` is host-supplied and is **never** inferred from a model
name. A bigger window is not permission to spend it:
`axTrajectoryContextBudget({ contextWindowTokens: 500_000 })` is `4000`.

The `life` array is coarse-to-fine, oldest first, and is contiguous: a missing
coarse block descends into its `fanout` children rather than being skipped, so
a block that straddles the point where rollups were switched on still prints
every finer summary that exists. Only a tier-1 miss becomes a
`{ kind: 'gap' }` section, and every gap is also reported in
`coverage.gaps`.

Rollups are an optimization, not a dependency: with no rollup store, or with
every block deleted, `axProjectTrajectory` still returns the raw tail and
reports the rest as a gap — for a bounded number of store round-trips
(`axTrajectoryDescentBudget`), after which the remainder is reported as one
`missing` gap instead of being probed node by node.

Three bounds are load-bearing and easy to miss:

- `maxBlocks` (default 8) bounds summarizer **attempts** per build, not
  successes, so a failing provider cannot turn one wake into one request per
  `fanout` steps for the whole log.
- Summaries and themes are clipped at seal time
  (`axTrajectoryMaxSummaryBytes`, `axTrajectoryMaxThemes`).
- `render` is newline-delimited and every interpolated value is one-lined, so
  a summary or a step body cannot forge a section header or a verbatim
  `[seq type]` frame.

A rollup meta sealed past the end of the log it is loaded for throws
`AxTrajectoryRollupError('meta_conflict')` rather than reporting a life that
was never lived.

A mind's context assembler is the primary consumer of this API — see
`ax-mind.md`, which links back here.

## Node-Only JSONL Store

```ts
import { AxJSONLTrajectoryStore } from '@ax-llm/ax-tools/trajectory';

const store = new AxJSONLTrajectoryStore({ root: './trajectories' });
```

One `steps.jsonl` per trajectory, one `\n`-terminated line per step,
content-addressed blobs flushed before the referencing line, byte-offset
cursor tokens, and a tolerant parser that drops a torn trailing frame, counts
it, and never glues it onto the next record. It declares
`durability: 'persistent'`.

Any host store must pass the normative kit:

```ts
const report = await runAxTrajectoryStoreConformance({
  create: async () => ({ store: new MyStore() }),
});
report.assertions; // a store that "passes" with 12 assertions is not passing
```

## Testing

- Inject `AxManualEventClock`; never let a store read the wall clock.
- Run `runAxTrajectoryStoreConformance` against your store and against a
  deliberately broken one, and assert the broken one fails on the right case
  id. A kit nothing fails is a kit nothing proves.
- Assert `tail.scanned` and `tail.exhausted`, not just `tail.steps.length`:
  "no more matches" and "budget spent" are different answers.
- For a projection, assert coverage **and** that every cited id resolves and
  falls inside its block's index range. Coverage alone is satisfiable by a
  summarizer that read nothing.

## Evaluation

`npm run trajectory:durability:eval` and `npm run trajectory:projection:eval`
are deterministic and make zero provider calls.

> This is a deterministic zero-cost mechanism evaluation with fault injection.
> It is bounded machinery evidence -- projection shape and size, coverage,
> chronology, and drill-down resolution. It is not a held-out model
> comparison. It says nothing about whether the mind thinks well, chooses good
> routes, or writes useful memories, and no claim of that kind is made.

## Examples

- `docs/TRAJECTORY.md` — the normative contract, the crash behaviour, and the
  full conformance case list.

## Do Not Generate

- No unbounded read. `store.read({ trajectoryId })` with neither `limit` nor a
  full range throws `AxTrajectoryQueryError('unbounded_read')`.
- No update, delete, rewrite or compaction of a step.
- No grouping a run by file position or by `seq` ranges — use `runId`.
- No string timestamps.
- No reading a field named in `spillFields` without resolving it first.
- No second recursive value type: step fields are `AxTrajectoryFieldValue`,
  which is `AxEventValue`.
- No inferring `contextWindowTokens` from a model name.
- No hand-built rollup blocks: seal through `axBuildTrajectoryRollups` so the
  provenance stamp and the citation range check actually run.
