# AxTrajectory: the append-only agent life log

`src/ax/trajectory/` is the record of what an agent did, and the projection
that turns an unbounded life into a bounded context window. This document is
the normative contract: the step model, the registry, spill and rehydration,
the five read primitives and their bounds, cursors, fork/merge, the projection
algorithm, the store capability matrix, and the conformance case list.

The Node-only file-backed implementation lives in
`src/tools/trajectory/jsonl.ts` and ships from `@ax-llm/ax-tools`.

See also [`docs/EVENT_RUNTIME.md`](./EVENT_RUNTIME.md) for the transport a
trajectory's appends are published through, and `src/ax/skills/ax-trajectory.md`
for the codegen rules.

## Why this is not `AxInteractionTimeline`

`AxInteractionTimeline` is a causal DAG of crossmodal observations with
retention eviction; it answers "what led to this". `AxMemory` is per-program
chat history for one `forward()`. Neither is an autobiography:

- both are allowed to **forget**, and a life log that prunes is not a life log;
- neither has a durable per-consumer cursor, so nothing can ask "how far behind
  am I" across a restart;
- neither has size-based blob spill with a digest-verified read side, so a
  19k-step run with a 312 MB output field is unreadable;
- neither has a fork/merge DAG, so a sub-run is invisible in its parent's life.

Do not re-litigate this by adding retention to the trajectory. A store that
prunes must declare it, and `AxMind.start()` refuses a volatile store unless
the host explicitly allows one.

## The step

```ts
interface AxTrajectoryStep {
  readonly stepId: string;
  readonly trajectoryId: string;
  readonly seq: number;        // dense, gap-free, per trajectory
  readonly type: string;
  readonly ts: number;         // epoch ms, normalized at the boundary
  readonly runId?: string;     // the run header step's id. NEVER file position
  readonly triggerStep?: string;
  readonly launchedBy?: string; // the thinker's name; NOT `source`
  readonly source?: string;     // writer identity, narrative steps only
  readonly data: Readonly<Record<string, AxTrajectoryFieldValue>>;
  readonly blobs?: readonly Readonly<AxTrajectoryBlobRef>[];
}
```

`AxTrajectoryFieldValue` is an alias of `AxEventValue`, deliberately: every
step crosses the event plane as `AxEventEnvelope.data`, so a second recursive
JSON type would be an alias whose conversion can only be the identity.

Steps are deep-frozen at the one point they are built, and the file store
freezes each frame it parses off disk. Immutability is a runtime property, not
a TypeScript one.

## Invariants

| # | Invariant | Enforcement |
|---|---|---|
| I1 | A step, once appended, is never modified or deleted. | No update/delete on the port; deep freeze; conformance **C-IMM**. |
| I2 | Blobs are durably written **before** the referencing step. | Append ordering in both stores; **C-ORDER** injects a failing blob store and asserts no step became visible. |
| I3 | An append is atomic against concurrent appends and readers. | Single-writer queue; one `\n`-terminated buffer per step; **C-ATOM**. |
| I4 | `seq` is dense, gap-free and monotonic per trajectory. | Assigned inside the append critical section. |
| I5 | Readers tolerate unknown step types and render them inert. | `axTrajectoryUnknownDescriptor`; `onUnknownStepType` fires once per distinct type. |
| I6 | Narrative-vs-machinery is a declared registry property. | `stepClass`, pinned row by row; the projection filters through the registry, so a caller asking for a machinery type by name still gets none. |
| I7 | A consumer reading a possibly-large field **must** rehydrate. | `blobs` is a required signal; `axResolveTrajectoryStep` verifies the digest; the projection resolves before rendering and a lint-shaped test holds it there. |
| I8 | `runId` groups a run; file position never does. | Grouping helpers key on `runId` only. |
| I9 | Every cross-trajectory link is `(trajectoryId, stepId)` in both directions. | `fork()` pre-generates the fork step id. |
| I10 | A sub-run always merges something back, success or failure. | `merge()` requires `outcome`. |
| I11 | Timestamps are epoch-ms numbers normalized at the boundary. | `ts: number`. |
| I12 | No read primitive is unbounded. | `read` requires `limit` unless both bounds are given; `tailBackward` has `maxScan`; `readFrom` has a budget; `getSteps` caps at 256 ids. **C-BOUND**. |
| I13 | Machinery can never masquerade as a thinker. | `append` throws `source_on_machinery_step` at the write boundary. |

## The step-type registry

Classification is a **declared property**, never an allowlist by omission. The
shipped table is in `src/ax/skills/ax-trajectory.md` and pinned row by row in
`registry.ts`'s test. An unregistered type resolves to `unknown`: never
wakeable, never projected, still appendable and still readable, with
`onUnknownStepType` firing once per distinct type so the open world is visible
rather than silent.

`siblingInert` is declared the same way: it marks a wakeable type that carries
nothing a SIBLING writer's reader has to act on (`idle` alone, of the shipped
rows), and `src/ax/mind` refuses that wake rather than inferring the class from
`spillFields`, `visibleWork` or `conversational`, which are a storage, a pacing
and a UI concern that would sweep a host's short-payload type in silently.

Two edits are refused with `AxTrajectoryRegistryError`: setting
`carriesSource` on a machinery type (`protected_flag`), and clearing
`neverRetriggersSelf` on a type that ships with it.

## Spill and rehydration

Spill is generic and size-based: any string field at or above `spillBytes`
(default 4096), not an allowlist of the two fields someone remembered. The
step keeps a UTF-8-safe inline head that never splits a code point, plus a ref
carrying the **full** byte count and the SHA-256 digest.

The read side is the load-bearing half. `axResolveTrajectorySteps` runs a
pre-pass keyed on **ref and digest** (two refs sharing a ref string with
different digests are different content commitments), fetches each distinct
commitment once, verifies the digest, and throws
`AxTrajectoryBlobError('digest_mismatch' | 'missing')` rather than returning a
truncated head. Resolved refs are dropped from `blobs`, so a second resolve is
a no-op rather than a second fetch.

## Read primitives and their bounds

| primitive | bound | reports |
|---|---|---|
| `read` | `limit`, or both `fromSeq` and `toSeq` | n/a |
| `tailBackward` | `maxScan`, default `max(200, 20 * limit)` | `scanned` **and** `exhausted`, so "no more matches" is distinguishable from "budget spent" |
| `getStep` / `getSteps` | 256 ids | n/a |
| `readFrom` | `{ maxSteps, maxBytes }` | `caughtUp`, `corrupt` |
| `stats` | O(1) | `newestByClass` |

## Cursors

Cursors are per consumer and durable. `seq` is the portable position; a
`token` is a store-private fast path, and **when a token is present it decides
where the drain resumes**. `seq` alone cannot survive a tolerant parse that
dropped an interior frame, which silently skipped a committed step before this
was fixed. Validation order is `identity_changed` → `not_a_frame_boundary` →
token identity → `shrank` → `beyond_end`. An unusable cursor throws; it never
silently skips.

## Fork and merge

`fork()` pre-generates the child's fork step id and writes parent→child and
child→parent before either is observable, so neither side ever needs a search.
`merge()` requires an `outcome`, so a failed sub-run still leaves a mark.

## Projection

```
N     = filtered step count (narrative types only)
budget= min(fraction * contextWindowTokens, maxTokens)     # 0.6, 4000
R     = max(20, floor(0.4 * budget / tokensPerStep))       # raw tail size
M     = rollup meta startIndex, snapped DOWN to an F multiple
cut0  = floor((N - R) / F) * F
decompose [0, cut0) positionally in base F
emit tiers descending, blocks ascending within a tier      # == chronological
emit filtered steps [cut0, N) verbatim
```

`contextWindowTokens` is host-supplied and is never inferred from a model
name. A bigger window is not permission to spend it.

Per segment:

| state | action |
|---|---|
| segment entirely `< M` | **prune before descent**, otherwise the descent forks once per node over the whole empty tree on every call |
| descent budget spent | emit `{ kind: 'gap' }`, reason `missing`, without probing further |
| block exists at tier `k` | emit `{ kind: 'summary', block }`, only when its `tier`, `start` *and* `end` all match the segment |
| block missing at tier `k > 1` | **descend into the `F` children at tier `k-1`** and apply this table to each |
| block missing at tier 1 | emit `{ kind: 'gap' }`, reason `pre-enable` below `M`, else `missing` |

Two bugs are fixed by construction rather than by care:

- **Emit order.** A naive reverse of a flat segment list flips block order
  *within* a tier, scrambling chronology under an "oldest first" header. The
  positional decomposition is generated in ascending start order, which for a
  prefix decomposition *is* tiers-descending / blocks-ascending.
- **Straddle descent.** A missing *coarse* block is expected when it straddles
  the forward-only enablement marker: its oldest children are pre-enable, so
  tier `k` never seals even though every finer block after the marker exists.
  Skipping the segment silently drops every built summary the moment `cut0`
  crosses an `F^k` boundary.

`startIndex` is the filtered-step count at first use, **snapped down** to an
`F` boundary; an unsnapped marker leaves the straddling block permanently
unbuildable, which is a coverage hole exactly at the enable point. Backfill
below it is an explicit `backfill: true` offline call.

Rollup blocks are sealed and immutable (a second `putBlock` on a key throws
`AxTrajectoryRollupError('block_already_sealed')`), and each is stamped with
`(summarizerId, promptVersion)`, because a cache that cannot say what produced
it is a guess, not a cache. A summarizer error skips that block, counts it,
and never fails the build; the sealing checkpoint does not advance past it, so
it is retried on the next build.

**Fails open, deliberately.** With no rollup store, or with every block
deleted, `axProjectTrajectory` degrades to the raw tail plus drill-down and
reports the rest in `coverage.gaps`. Recency plus fetch-by-id is the
load-bearing core; tiers are an optimization.

**Degrading cleanly is not the same as degrading cheaply.** A missing coarse
block forks into `F` children, so an empty or not-yet-sealed subtree costs
`O(N / F)` store round-trips, measured at 1,104 `getBlock` calls to emit a
single gap section over a 10k-step log, and ~111,000 at a million steps, paid
on *every* wake and over whatever port the host backs rollups with.
`axTrajectoryDescentBudget(cut0, F) = F² · (ceil(log_F cut0) + 1)` bounds the
nodes one assembly may visit; beyond it the remainder is reported as a
`missing` gap rather than probed. A healthy pyramid costs one probe per
emitted section and never reaches the budget. The projection evaluation
reports `degradedRollupReads` beside `degradedRecentSteps` and gates it.

The budget is deliberately *not* a prune at `sealedIndex`: a block whose
summarizer throws leaves the checkpoint parked below blocks that did seal in
the same call, and pruning there would report a whole life as `missing` for as
long as one poisoned block keeps failing.

**Bounded writes.** `maxBlocks` (default 8) bounds summarizer *attempts* per
build, not successes: a summarizer that is failing never increments `sealed`,
so a guard on successes is a no-op exactly when a provider is down. One wake
would then make one provider request per `F` steps for the whole log.
Summaries and themes are clipped at seal time
(`axTrajectoryMaxSummaryBytes`, `axTrajectoryMaxThemes`), because a summarizer
whose output grows with its input keeps the staircase logarithmic in
*sections* while its rendered size tracks the log.

**The rendered frames are structural.** `render` is newline-delimited, and its
headers and `[seq type]` frames are the only thing separating a summary from
verbatim testimony. Every interpolated value (a block summary, a theme, and
each field of a step body) is one-lined (a real newline becomes the two
characters `\n`) before it is written, so neither model output nor a
user-authored step can open a section or a frame of its own.

**The checkpoint is checked against the log.** A rollup meta sealed past the
end of the trajectory it is loaded for (a fork, a restore from backup, or a
rebuilt log under a reused id) throws
`AxTrajectoryRollupError('meta_conflict')` in both the projection and the
build. Trusting it makes the projection report a life that was never lived,
because `N` comes straight from `sealedIndex` when the scan has nothing to do.

**`signal` is honoured between store round-trips**, not inside them: a caller
cannot rely on abort to escape a scan over a synchronous store, so every knob
that sizes a scan page is clamped to at least one step.

**Drill-down.** Coarse entries are pointers, not testimony.
`axResolveTrajectoryCitations` batches within the 256-id ceiling and
rehydrates spilled fields. A summarizer that cites an id outside its own
block's index range has that citation dropped when the block is sealed, so
coverage cannot be claimed by a summarizer that read nothing.

### Deviations from RFC §4.8, recorded

1. **`axTrajectoryContextBudget({ contextWindowTokens: 8_000 })` is `4000`,
   not `4800`.** The RFC lists `500_000 -> 4000` and `8_000 -> 4800` under one
   `min(fraction * window, maxTokens)` rule with `maxTokens` defaulting to
   4000; the two cannot both hold. The cap row is the one the RFC's prose is
   about ("a bigger window is not permission to spend it"), so the cap wins.
   The fraction still governs a window under the cap
   (`4_000 -> 2400`), and `4800` is reachable with an explicit
   `maxTokens: 8_000`.
2. **`AxTrajectoryRollupMeta` carries a checkpoint** (`sealedIndex`,
   `sealedSeq`, `frontier`). Without it every build and every projection
   rescans the whole log to find `N`, which is the cost the projection exists
   to remove. All three are forward-only.
3. **`axBuildTrajectoryRollups` reports `failed` beside `skipped`.** Folding a
   summarizer error into "already sealed" would make the evaluation blind to
   the difference.
4. **Two files, not one.** RFC §5.1 budgets one 620-line `projection.ts`. The
   lane ships `projection.ts` (the read path: budget, staircase, straddle
   descent, drill-down, renderer) and `rollups.ts` (the cache path: the
   block/meta/store port, the in-memory store, the summarizer port and its two
   implementations, and sealing).
5. **Four bounds the RFC does not name**: the descent budget, attempt-bounded
   `maxBlocks`, the seal-time summary/theme clip, and the clamped scan page.
   Each closes an unbounded path the RFC's own invariants ("one wakeup cannot
   stall", "coarse entries are pointers") assume is already closed.
6. **`AxTrajectoryQueryError` gains an `unsupported_types` reason.** A `types`
   request that no narrative type survives resolves to `[]`, which every store
   matcher reads as "matches nothing"; returning an empty projection silently
   is indistinguishable from an empty log.

### Line budgets and why they moved

`src/ax/trajectory/budget.test.ts` caps every production file and the
directory total, so raising a cap is a visible one-line diff. RFC §5.1
estimated 2,190 lines for lane A1 and 620 for lane A2, a 2,900 total. The
shipped directory is **3,927**, and the ceiling is restated to 3,990.

Four things account for the difference, none of them added scope:

- **`log.ts` (A1)** is not in the RFC. It holds the append-only index and every
  read primitive, shared verbatim by both shipped stores; before it, ~230 lines
  were duplicated and a fix to one store silently missed the other. Sharing
  across the package boundary can only move those lines *into*
  `src/ax/trajectory/`, so `jsonl.ts` fell from 940 to 830 and
  `memoryStore.ts` from 720 to 520 while this directory's total rose.
- **The estimate counts the declared API surface as if it were dense.** Biome's
  80-column formatting plus the house rule of a one-line policy comment on
  every non-obvious field roughly doubles a types-heavy module.
  `conformance.ts` is the largest single overrun: seventeen named cases, five
  of which gained a normative assertion during A1's adversarial review.
- **The projection is split in two** (deviation 4 above). Neither half is
  understandable in an afternoon inside the other.
- **A2's adversarial review** added six guards (deviations 5 and 6 above) and
  their regression tests. Each is a few lines of code and a paragraph saying
  what it defends against, which is the ratio this directory has had from the
  start: 3,785 → 3,927.
- **`AxTrajectoryReader` (Track A follow-up)** raises `types.ts` from 480 to
  490 and nothing else. It is the read-only view `AxMindContextRequest` hands a
  thinker: `capabilities`, `clock`, `getTrajectory`, `read`, `tailBackward`,
  `getStep`, `getSteps`, `stats`, so "a thinker reads the trajectory and never
  writes it" holds by construction. `append`, `create`, `fork`, `merge`,
  `saveCursor` and `blobs` (whose `put` is a write) are simply not on the type.
  An `AxTrajectoryStore` is structurally assignable to it, so the runtime hands
  its own store over with no wrapper. The DIRECTORY ceiling stays at 3,990.

## Store capability matrix

| capability | in-memory | JSONL |
|---|---|---|
| `durability` | `volatile` | `persistent` |
| `coordination` | `single-writer` | `single-writer` |
| `appendAtomicity` | true | true |
| `blobs` | true | true |
| `cursorTokens` | true | true |
| `consumerCursors` | true | true |

`conformance.multiWriter` is reserved and nothing sets it in v1.

## Crash behaviour

| row | behaviour |
|---|---|
| C1 kill before `append()` returns | The step is either fully visible or not visible at all. Never partial. |
| C2 kill after the blob is durable, before the step line | Orphan blob, **never a dangling reference**. A host GC sweeps unreferenced blobs older than the head step's `ts`. |
| C3 power loss mid-line | The torn trailing frame is dropped and counted in `DrainResult.corrupt`. Deliberately **dropped, never glued**: the next append writes a leading newline so a fragment stays its own frame. |
| C14 unusable durable cursor | Rejected loudly with a typed `reason`, or resumed at the right record via the token. Never a silent skip. |

The containing directory is **not** fsynced after a create or a rename, so
against a real power cut a just-created blob or cursor file can be absent even
though its data was flushed. That degrades to C2 or to a cursor that reads as
absent, never to a dangling reference.

## Conformance

`runAxTrajectoryStoreConformance` is the normative kit a host store must pass.
It returns an `assertions` count: a store that "passes" with 12 assertions is
not a store that passes with 81. Both shipped stores report the same count.

Cases: C-APPEND, C-SEQ, C-ATOM, C-IMM, C-ORDER, C-BLOB, C-BOUND, C-TAIL,
C-DRAIN, C-CURSOR, C-CORRUPT, C-FORK, C-MERGE, C-STATS, C-CAP, C-REOPEN,
C-UNKNOWN.

The kit is proved non-hollow by running it against five deliberately broken
stores in `conformance.test.ts`, each asserted to fail on the right case id.

## Evaluations

Both are deterministic and make zero provider calls.

```bash
npm run trajectory:durability:eval     # crash matrix + byte-level truncation
npm run trajectory:projection:eval     # coverage, size, chronology, drill-down
```

The projection evaluation reports coverage **beside** the drill-down
resolution rate, the count of citations falling outside their block, and the
store round-trips a fully degraded projection spends
(`degradedRollupReads`, gated against `descentBudget`); it carries a
`hollow-blocks` control row whose blocks never read the log: that row still
scores coverage 1.0, and only the paired metrics catch it. `providerCalls` is
an instrumented count of outbound fetches made while the rows were measured,
not a literal. Below `R` the
projection is pure overhead: at 10 filtered steps it renders *more* characters
than a raw replay, because the headers cost more than the log does. That is
reported rather than hidden.

> This is a deterministic zero-cost mechanism evaluation with fault injection.
> It is bounded machinery evidence -- projection shape and size, coverage,
> chronology, and drill-down resolution. It is not a held-out model
> comparison. It says nothing about whether the mind thinks well, chooses good
> routes, or writes useful memories, and no claim of that kind is made.
