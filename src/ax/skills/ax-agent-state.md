---
name: ax-agent-state
description: This skill helps an LLM generate correct verifier-gated working state, skillState memory-mode and call-time skill injection code using @ax-llm/ax. Use when the user asks about AxWorkingState, goal ledgers, actorMemoryMode, statePatch, state checkers, tool receipts, parked deltas, callTimeSkills, or long-horizon agent state.
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
- `actorMemoryMode: 'skillState'` requires BOTH `workingState` and
  `skillState`. It discards the transcript: anything the run needs later must
  be written into the state document.
- Call-time skill injection is opt-in per EXACT callable and budgeted. An
  intercepted call does not execute, requests no authorization, fires no
  `onFunctionCall`, records no function call and mints NO receipt — so it can
  never support a goal completion.

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

## skillState Memory Mode

`actorMemoryMode: 'skillState'` replaces action-log replay with *frozen skill
spec + typed state + latest observation*. Opt in only when progress really is
a discrete, tool-evidenced state machine.

```ts
const agentWithSkillState = agent('task:string -> answer:string', {
  functions: [pick],
  actorMemoryMode: 'skillState',
  // BOTH are required; `agent(...)` throws at construction otherwise.
  workingState: { stateSignature: 'orders:json', initial: { goals } },
  skillState: {
    skill: { id: 'pick-flow', name: 'Picking', content: PROCEDURE_MARKDOWN },
    observationWindow: 1,
    onTransition: (transition) => audit.push(transition),
  },
});
```

- The actor gains two OPTIONAL outputs, `statePatch` and `rationale`. Emit
  `statePatch: []` when the turn proved nothing; omitting it entirely is also
  valid and records `proposal: 'none'`.
- The prompt carries no action log at all. Anything needed on a later turn
  must be written into the working state by a patch.
- `rationale` is hashed into `AxSkillStateTransition.rationaleDigest` and the
  TEXT IS DISCARDED. Never rely on seeing it again. An ABSENT rationale leaves
  `rationaleDigest` undefined; an empty one still digests.
- Only ACCEPTED transitions enter `transitions()`. Use `onTransition` to
  observe refusals; it is fail-soft, like `onTrace`.
- Rejections are `schema` (unparseable — the store is never touched),
  `authority` (a harness-owned path), `fence` (the compare-and-set lost) and
  `invariant` (the kernel or checker refused every delta).
  `committedRevision` is always defined.
- Pass a ref (`{id, version}`) as `skill` only with `resolveSkill`; a ref
  carries no body text.
- Supply a durable `store` if the discarded transcript must be recoverable
  after the process exits. The default in-memory store makes the discard
  irreversible.
- The transcript leaves the PROMPT, not the process: the loop still keeps and
  walks every action-log entry, so per-turn context bookkeeping stays quadratic
  in the turn count. Leave `tombstoning` off under `skillState` — it spends
  model calls summarizing text this mode never renders.
- `onTransition` is awaited with no timeout: a sink that can block should bound
  itself.

## Call-Time Skill Injection

Bind one exact callable to one skill. When the actor drafts a call to it, the
harness does not execute it: it returns a frozen not-executed marker, loads the
skill through the ordinary Loaded Skills channel, appends harness guidance to
the trusted guidance log, and the model re-drafts on the next turn.

```ts
const shipper = agent('task:string -> answer:string', {
  functions: [adjustTool, pickTool],
  skillsCatalog: [
    { id: 'stock-adjustment', name: 'Stock adjustment', content: guide },
  ],
  workingState: { stateSignature: 'orderId:string, shipped:boolean' },
  callTimeSkills: [
    {
      // EXACT namespaced callable. No globs.
      qualifiedName: 'inventory.adjustStock',
      // A catalog id, or an inline { name, content } skill.
      skill: 'stock-adjustment',
      // Injections allowed for this callable in one run. Default 1.
      maxInjections: 1,
      // Optional: only intercept when the committed state says the call is
      // state-changing. Requires `workingState`.
      when: (state) => state.facts.shipped !== true,
    },
  ],
});
```

- **A nudge, not a gate.** Past `maxInjections` the tool executes normally. The
  budget is what stops an unhelpful skill trapping the actor in a re-draft
  loop.
- **Nothing observable happens for an intercepted call.** No authorization
  request, no `onFunctionCall`, no recorder record, no receipt. Read the marker
  with `axIsCallTimeSkillNotExecuted(value)`; it carries `qualifiedName`,
  `skillId` and the guidance copy.
- **A bound callable gets no runtime speculation adapter.** That is what stops
  the JS runtime's speculation path executing the call behind the
  interception's back, and it is why binding a callable changes how it is
  dispatched even on turns that are not intercepted.
- The guidance is harness-authored and names only the callable and the skill
  id. Model text never reaches the guidance log.
- **A bound catalog id still goes through both catalog gates.** At run start the
  id is re-asked against `skillPolicy.environment` (`requires`) and the
  retrieval-time authority re-check. If either hid the skill the RUN is refused
  (`ineligible_bound_skill`, `denied_bound_skill`) — a binding never renders a
  body `discover({ skills })` would not. An inline skill is not gated.
- A `when` predicate that throws falls through to the normal call path; it never
  becomes an error turn, and it never spends budget.
- Gamma records the intercepted turn with `action.executed: false` — the turn's
  weakest guarantee. A mixed turn is `{ executed: false, calls: [<the real
  one>] }`; `action.calls` stays exact. `onLoadedSkills` fires for an injected
  skill.
- A binding naming a callable the run does not register throws
  `unknown_bound_callable` at run start; an unresolvable skill id, a glob, a
  duplicate binding, `maxInjections < 1` and a `when` without `workingState`
  all throw at construction.

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
- Do NOT set `actorMemoryMode: 'skillState'` without BOTH `workingState` and
  `skillState.skill`; construction throws.
- Do NOT make `statePatch` or `rationale` required outputs, and do NOT expect
  the rationale text to survive the turn.
- Do NOT bind a callable with a glob, bind the same callable twice, or expect
  an intercepted call to appear in `onFunctionCall`, the recorder or the
  receipt roster.
- Do NOT treat call-time skill injection as an authorization or safety gate.
  It is one budgeted nudge; past the budget the tool runs.
- Do NOT expect a binding to be a way around the skills catalog gates, and do
  NOT set `maxInjections` above 100; both refuse.
- Do NOT reach for `skillState` on a short run, or on a task whose progress no
  tool receipt witnesses: it removes the transcript, so anything not written
  into the state is gone.
