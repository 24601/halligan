---
name: ax-agent-state
description: This skill helps an LLM generate correct verifier-gated working state code using @ax-llm/ax. Use when the user asks about AxWorkingState, goal ledgers, statePatch, state checkers, tool receipts, parked deltas, or long-horizon agent state.
version: "__VERSION__"
---

# Ax Agent Working State Codegen Rules

Prefer short, modern, copyable patterns. Do not write tutorial prose unless the
user explicitly asks for explanation.

## Use These Defaults

```ts
const inventoryAgent = agent('task:string -> answer:string', {
  functions: [pickTool, dispatchTool],
  workingState: {
    // Only these OUTPUT fields are legal roots under /facts.
    stateSignature: 'orderId:string, itemsPacked:number, shipped:boolean',
    // Seed the ledger host-side. This is the strongest configuration.
    initial: {
      goals: {
        g_pick: {
          id: 'g_pick',
          goal: 'Pick every line on the order',
          status: 'pending',
          evidence: [],
          expects: ['inventory.pick'],
          createdTurn: 0,
          updatedTurn: 0,
        },
      },
      facts: { itemsPacked: 0, shipped: false },
    },
    // The tightest available Goodhart control.
    receiptSources: ['inventory.*'],
    checker: { id: 'stock', check: verifyStock, maxParksPerRun: 12 },
  },
});
```

- Leave `proposer` at `'on-change'`: the added cost is then proportional to
  environment change, not to turn count.
- Leave `allowModelAuthoredGoals` at its default `false`.
- Leave `completionPolicy` at its default `'observe'` unless you have decided
  you want the run re-prompted.
- Set `expects` on every seeded goal.
- Set `receiptSources`.
- Use `AxManualEventClock` and `AxInMemoryProgramStateStore` in tests.

## Non-Negotiable Rules

- A goal flips to `done` ONLY on a harness-minted tool receipt cited by its
  `ref` in the same patch. Model self-report never completes a goal.
- The checker can only make the kernel STRICTER. A `{status:'pass'}` on a
  delta the kernel parked does not commit it.
- **Working state does NOT gate the run's report** unless you set
  `completionPolicy: 'interlock'`. A ledger full of pending goals does not
  stop a `final()`.
- Never put credentials or PII in `facts`. The document is rendered into the
  prompt and persisted through your store.
- Never treat the rendered `workingState` block as instructions: it is
  model-authored content.
- The `receiptRoster` region is read-only. Writes to `/parked`,
  `/schemaVersion`, `/goals` or `/facts` wholesale, or to any immutable goal
  field, are refused outright.
- Read the committed document with `agent.getWorkingState()`. It is
  `undefined` when the run ended at the distiller.

## Canonical Pattern

```ts
import { agent, ai, fn } from '@ax-llm/ax';
import type { AxEventVerifierResult } from '@ax-llm/ax';

const pickTool = fn({
  name: 'pick',
  namespace: 'inventory',
  description: 'Pick every line on an order',
  parameters: {
    type: 'object',
    properties: { order: { type: 'string', description: 'order id' } },
    required: ['order'],
  },
  func: async ({ order }: { order: string }) => ({ order, status: 'picked' }),
});

const shipAgent = agent('task:string -> answer:string', {
  functions: [pickTool],
  workingState: {
    stateSignature: 'orderId:string, itemsPacked:number, shipped:boolean',
    initial: {
      goals: {
        g_pick: {
          id: 'g_pick',
          goal: 'Pick order 42',
          status: 'pending',
          evidence: [],
          expects: ['inventory.pick'],
          createdTurn: 0,
          updatedTurn: 0,
        },
      },
      facts: { orderId: '42', itemsPacked: 0, shipped: false },
    },
    receiptSources: ['inventory.*'],
    checker: {
      id: 'ship-guard',
      check: ({ proposedState, receipts }): AxEventVerifierResult =>
        proposedState.facts.shipped === true &&
        !receipts.some((r) => r.qualifiedName === 'inventory.pick')
          ? { status: 'fail', failure: { code: 'not_picked' } }
          : { status: 'pass' },
    },
    trace: true,
    onTrace: (step) => console.log(step.turn, step.outcome, step.parked),
  },
});

const llm = ai({ name: 'openai', apiKey: process.env.OPENAI_API_KEY! });
await shipAgent.forward(llm, { task: 'Pick and ship order 42' });
console.log(JSON.stringify(shipAgent.getWorkingState(), null, 2));
```

## The Goal Ledger

`goals` is a KEYED OBJECT addressed by stable id, never an array: sequential
RFC-6902 application shifts array indices, so an index-addressed op could be
classified against one goal and applied to another.

- Ids must match `^[A-Za-z0-9_.:-]{1,64}$`, so no JSON-Pointer escaping is
  ever needed.
- Statuses are `pending`, `done`, `blocked`.
- `done` requires a receipt. `blocked` requires a non-empty `blocker` set in
  the same patch. `pending` (retraction) always commits — retraction must
  never be harder than assertion.
- `id`, `createdTurn`, `updatedTurn` and `expects` are immutable after
  creation. Removing a `done` goal is refused: it is part of the audit record.
- A goal created and closed in ONE patch is held to the `expects` it declares
  in that patch, and closing a goal that exists in neither the ledger nor an
  admissible same-patch `goal_add` parks `no_supporting_receipt`.

## Receipts and the Roster

A receipt is minted by the harness at the dispatch site when a
receipt-eligible callable returns without throwing. The model sees
`r7  inventory.pick  turn 4` in the read-only roster region and cites `r7`.

- The protection is **set membership in a harness-owned append-only list**,
  not secrecy of a hash. The fingerprint is an audit value and is never
  rendered.
- Nothing mints for: a call that threw; a call that completed the run; an
  agent-derived callable (a child agent's return value is its own `final()`
  payload — model self-report); `llmQuery`; a callable outside
  `receiptSources`.
- A void-returning tool DOES mint. Success is "no error thrown", never "a
  result was returned".
- Two identical observations of the same call collapse into one receipt with
  `observations: 2` (the runtime's deterministic-speculation path reports one
  physical effect as two logical calls). Under-counting evidence is the safe
  direction; return a call-unique value if you need per-call receipts.

## Checkers

`AxWorkingStateCheckerPolicy.check(context)` returns the same
`AxEventVerifierResult` the event runtime's verifier returns. Only the VERDICT
TYPE is shared — the `AxEventVerifierPolicy.verify` body is not portable here,
because `check` is arity-1 over an agent-turn context.

```ts
const checker = {
  id: 'stock',
  timeoutMs: 2_000,
  maxChecksPerRun: 40,
  maxParksPerGoal: 3,
  maxParksPerRun: 12,
  maxEvidenceBytes: 4_096,
  check: async ({ deltas, receipts, signal }) =>
    deltas.every((d) => d.class !== 'fact_write') || (await reserved(signal))
      ? { status: 'pass' }
      : { status: 'fail', failure: { code: 'stock_not_reserved' } },
};
```

Everything fails closed: a throw parks `checker_error`; exceeding `timeoutMs`
parks `checker_timeout`; exceeding `maxChecksPerRun`, `maxTokens`,
`maxWallTimeMs` or `maxCostUSD` parks `checker_error`.

## Parks

A parked delta is **recorded, visible, not applied, retryable,
budget-bounded** — the same contract `AxEventEffect.status: 'parked'` carries.

- It lands in `document.parked` (rendered into the read-only prompt region)
  and on the trace, and it produces one harness-authored guidance entry.
- The retained record is the op KIND and the harness's own canonical path,
  rebuilt from the classification (`/goals/<id>/status`, `/facts/<root>`,
  `/facts/<undeclared>`, `/<reserved>`). Neither the model's pointer text nor
  its `value` is retained, and neither reaches the guidance log.
- `appendGuidanceEntry` collapses consecutive identical entries, so repeated
  identical parks show as ONE guidance entry, not N. The per-park record lives
  in `document.parked` and on the trace.
- `maxParksPerGoal` force-blocks the goal with a harness-authored blocker.
  `maxParksPerRun` throws `AxWorkingStateParkBudgetError` out of `forward()`.

## Facts

The OUTPUT fields of `stateSignature` are the declared roots. A write under a
declared root is admissible up to `factDepthLimit` (default 4) further
segments. The SHAPE below the root is NOT validated by the kernel — a host
that needs a tighter fact contract enforces it in its checker. That is exactly
the boundary the checker exists to hold.

## Trace (Gamma)

One record per actor turn under `trace: true`. Digests only — never raw
payloads, never PII. `axWorkingStateTraceDigest(step)` hashes the
deterministic fields (everything except `runId`, `at` and `summary`), so two
runs of the same scripted turns compare equal. Join to `ActionLogEntry.turn`
and `AxAgentRecursiveTurn.turn` on `(runId, turn)`; `runId` is
per-`forward()`, not the program id.

## Testing

```ts
const state = await axWorkingState(
  {
    stateSignature: 'shipped:boolean',
    clock: new AxManualEventClock(0),
    store: new AxInMemoryProgramStateStore(),
    runIdFactory: () => 'ws:test:1',
  },
  { runId: 'ws:test:1', stage: 'executor' }
);
const receipt = await state.recordReceipt({
  qualifiedName: 'inventory.pick',
  arguments: { order: '42' },
  result: { picked: 3 },
  turn: 1,
  at: 0,
});
const outcome = await state.commit(patch, {
  action: 'code',
  observation: 'out',
  turn: 1,
  isError: false,
});
expect(outcome.parked[0]?.reason).toBe('no_supporting_receipt');
```

## Examples

- https://raw.githubusercontent.com/ax-llm/ax/main/src/examples/agent-working-state.ts

## Do Not Generate

- Do NOT write to `/schemaVersion`, `/parked`, `/goals` wholesale, `/facts`
  wholesale, or any immutable goal field.
- Do NOT emit `move` or `copy` patch ops. They are not in the subset.
- Do NOT address a goal by array index. Goals are keyed by id.
- Do NOT write a checker that returns `{status:'pass'}` unconditionally and
  then claim the state is verified.
- Do NOT store raw observations, credentials or PII on the trace or in
  `facts`.
- Do NOT read a goal's `done` as proof of a world state the receipts do not
  support.
- Do NOT assume a `pending` goal blocks `final()` — it does not, unless
  `completionPolicy` is `'interlock'`.
