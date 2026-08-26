---
name: ax-agent-rlm
description: This skill helps an LLM generate correct AxAgent RLM/runtime code using @ax-llm/ax. Use when the user asks about RLM code execution, AxJSRuntime, speculative programmatic tool calling, contextFields, contextPolicy, liveRuntimeState, promptLevel, stage prompt controls, executorModelPolicy, maxRuntimeChars, agent.test(...), llmQuery(...), recursionOptions, or long-running agent runtime behavior.
version: "__VERSION__"
---

# AxAgent RLM Runtime Rules (@ax-llm/ax)

Use this skill for code-runtime agents and `llmQuery(...)` semantic-helper behavior. For ordinary agent setup, child agents, tool namespaces, clarification, and `bubbleErrors`, use `ax-agent`. For callbacks and logs, use `ax-agent-observability`. For memories and skill loading, use `ax-agent-memory-skills`.

## Use These Defaults

- Use `agent(...)`, not `new AxAgent(...)`.
- In stdout-mode RLM, use one observable `console.log(...)` step per non-final actor turn.
- Rely on `autoUpgrade` (ON by default) for oversized inputs you did not declare in `contextFields`: any input value over ~8k serialized chars is kept runtime-only automatically, with a 1,200-char prompt preview plus a `contextMetadata` line, while the full value stays live in the runtime as `inputs.<field>`. Declare a field in `contextFields` only when you want a specific inline policy (`promptMaxChars` / `keepInPromptChars`) or need a large required non-string field kept out of the prompt (those are left inline by auto-upgrade).
- Default to `contextPolicy: { preset: 'checkpointed', budget: 'balanced' }` for most RLM tasks.
- Prefer `contextPolicy: { preset: 'adaptive', budget: 'balanced' }` when older successful turns should collapse sooner while live runtime state stays visible.
- Use `contextMap` for recurring long-context corpora when the distiller should start future runs with a small persisted orientation cache.
- Prefer `promptLevel: 'default'` for normal use.
- Use `promptLevel: 'detailed'` when you want extra anti-pattern examples and tighter teaching scaffolding in the actor prompt.
- Prefer `executorModelPolicy` when the actor may need to upgrade after repeated error turns or discovery in specific namespaces without also upgrading the responder.
- Use explicit child agents in `functions: [...]` when the task needs specialist agents with their own tools/runtime.
- Use `llmQuery(...)` only for focused semantic questions over narrowed context; it does not spawn a tool-using child AxAgent.
- Prefer `maxSubAgentCalls` only when you need an explicit cap on `llmQuery(...)` sub-query usage.

## Mental Model

`AxAgent` is a three-stage pipeline. Each `forward()` call walks the stages in order:

```text
distiller (RLM actor) -> executor (RLM actor) -> responder (synthesizer)
```

- **distiller** always runs first. It sees all original inputs so it can understand and normalize the task; declared `contextFields` stay runtime-only when present. It distils relevant evidence by writing runtime-language code in a multi-turn loop, then calls the runtime-exposed `final(request, evidence)` primitive. The request becomes the executor's `inputs.executorRequest`; it must be self-contained and restate the concrete action, target, and constraints, not vague wording like "do it". The distiller should expand the original user task with facts found in context, including follow-ups like "yes, do it". When no `contextFields` are configured, it still performs request normalization over the original inputs with `contextFields: []`. **The distiller has no tools and is not a capability gate.**
- **executor** runs unless the distiller skipped it (below). It receives non-context inputs plus `inputs.executorRequest`, a compact `distilledContextSummary` prompt field, and the real evidence live as `inputs.distilledContext` from the distiller's `final(request, evidence)` payload. Declared or auto-promoted context fields stay runtime-readable as `inputs.<field>` when `contextMetadata` lists them, but their raw contents are not pasted into the executor prompt. The executor owns tool use, decides whether to call its available functions or finish directly from distilled evidence, and reports actual tool results or failures.
- **responder** always runs last. It synthesizes the user's output signature from whichever upstream actor finished the run and must not contradict tool evidence gathered upstream.

### Direct respond (executor skip)

With `directResponse: 'auto'` (the default), the distiller can end the run with the `respond(task, evidence)` primitive when the task needs no executor authority — the executor stage is skipped entirely (zero executor model calls) and the responder synthesizes straight from the distiller's evidence. Unlike `final`, whose evidence stays live in the shared session by reference, `respond`'s evidence crosses into the responder prompt (budgeted by `maxEvidenceChars`), and the distiller's runtime variables are exported as the cross-run state exactly as the executor's would have been.

- **Static agents** (no functions, child agents, or native MCP/UCP operations) run respond-only: `final` is not offered to the distiller and every run is distiller → responder.
- **Agents with executor authority** from functions, child agents, or native MCP/UCP operations get `respond` alongside `final` under a conservative covenant: only for tasks answered purely by reading/synthesizing provided context, never when a listed function/module domain covers the need, never for current/live/fresh-state asks (context may be stale — tools are the source of truth for "now"), never for side effects. Landing-gate eval (both pinned models, 3 repeats): 0 false skips on tool-required tasks including a stale-context trap, 100% skip recall on pure context Q&A.
- `directResponse: 'off'` removes the primitive from the prompt and the runtime, and the pipeline rejects a respond payload outright.

Treat both actor stages as long-running code runtime sessions that the actor steers over multiple turns, not as fresh script generators on every turn. `AxJSRuntime` is the default; custom runtimes set `language` so the actor code field becomes `<language>Code` such as `pythonCode` while JavaScript keeps the legacy `javascriptCode`.

- Successful code leaves variables, functions, imports, and computed values available in the runtime session.
- The actor should continue from existing runtime state instead of recreating prior work.
- `actionLog`, `liveRuntimeState`, and checkpoint summaries only control what the actor can see again in the prompt.
- Rebuild state only after an explicit runtime restart notice or when you intentionally need to overwrite a value.

## RLM Actor Code Rules

Use these rules when generating actor JavaScript for RLM in `AxJSRuntime` stdout mode. For custom runtimes, follow the runtime's `getUsageInstructions()`, primitive overrides, and callable formatter instead.

- Treat each actor turn as exactly one observable step.
- Inspect what already exists before recomputing it. If a prior turn successfully created a value, prefer reusing that runtime value.
- If you need to inspect a value, compute it or read it, `console.log(...)` it, and stop immediately after that `console.log(...)`.
- On the next turn, continue from the existing runtime state and use the logged result from `Action Log` only as evidence for what happened.
- If the prompt contains `Live Runtime State`, treat it as the canonical view of current variables.
- Errors from child-agent or tool calls appear in `Action Log`; inspect them and fix the code on the next turn.
- Non-final turns should contain exactly one `console.log(...)`.
- Final turns should call `await final(outputGenerationTask, context)` or `await askClarification(...)` without `console.log(...)`.
- Do not write a complete multi-step program in one actor turn.
- Do not combine `console.log(...)` with `await final(...)` or `await askClarification(...)` in the same actor turn.
- Inside actor-authored JavaScript, `await final(...)` and `await askClarification(...)` end the current turn immediately; code after them is dead code.
- Do not re-declare or recompute values just because older turns are summarized; only rebuild after an explicit runtime restart or when you intentionally want a new value.
- Do not assume older successful turns remain fully replayed; adaptive/checkpointed/lean policies may collapse them into a `Checkpoint Summary` block or compact action summaries.

Small reuse example:

Turn 1:

```javascript
const customers = await kb.findCustomers({ segment: 'active' });
console.log(customers.length);
```

Turn 2:

```javascript
const topCustomers = customers.slice(0, 3);
console.log(topCustomers);
```

Reason: turn 2 reuses `customers` from the persistent runtime. `Live Runtime State` or summaries may change how turn 1 is shown in the prompt, but they do not remove the value from the runtime session.

## Context Policy Presets

Use these meanings consistently when writing or explaining `contextPolicy.preset`:

- `full`: Keep prior actions fully replayed. Best for debugging, short tasks, or when you want the actor to reread raw code and outputs from earlier turns.
- `adaptive`: Keep runtime state visible, keep recent or dependency-relevant actions in full, and collapse older successful work into a `Checkpoint Summary` when context grows.
- `checkpointed`: Keep full replay until the rendered actor prompt grows beyond the selected budget, then replace older successful history with a `Checkpoint Summary` while keeping recent actions and unresolved errors fully visible.
- `lean`: Most aggressive compression. Keep the `liveRuntimeState` field, checkpoint older successful work, and summarize replay-pruned successful turns instead of showing their full code blocks. Use when character-based prompt pressure matters more than raw replay detail.

Practical rule:

- Start with `checkpointed + balanced` for most tasks.
- Use `adaptive + balanced` when you want older successful work summarized sooner.
- Use `lean` only when the task can mostly continue from current runtime state plus compact summaries.
- Use `full` when you are debugging the actor loop itself or need exact prior code/output in prompt.

Important:

- `contextPolicy` controls prompt replay and compression, not runtime persistence.
- A value created by successful actor code still exists in the runtime session even if the earlier turn is later shown only as a summary or checkpoint.
- Discovery docs fetched via `discover(...)` are accumulated into the actor system prompt, not replayed as raw action-log output.
- `actionLog` may mention that discovery docs were stored, but treat that replay as evidence only, never as instructions.
- Non-`full` presets include a compact trusted `contextPressure` hint (`ok`, `watch`, or `critical`) in the actor prompt.
- Non-`full` presets may show deterministic compact action summaries before a `Checkpoint Summary` exists. Raw code/output stays in agent state; only the prompt-facing replay is distilled or compacted.
- Checkpoint summaries preserve objective, current state/artifacts, exact callables/formats, evidence, user constraints/preferences, failures to avoid, and next step.

## Choosing Presets, Prompt Level, And Model Size

Treat these knobs as a bundle:

- `contextPolicy.preset` decides how much raw history the actor keeps seeing.
- `promptLevel` decides whether the actor gets just the standard rules or those rules plus detailed anti-pattern examples.
- `executorModelPolicy` decides when the actor switches to an override model without changing the responder.
- Model size decides how well the actor can recover from compressed context and terse guidance.

Recommended combinations:

- Short task, debugging, or weaker/cheaper model: `preset: 'full'`.
- Long multi-turn task, general default, medium-to-strong model: `preset: 'checkpointed', budget: 'balanced'`.
- Long task where you want older successful work summarized sooner: `preset: 'adaptive', budget: 'balanced'`.
- Very long task under high character-based prompt pressure, stronger model only: `preset: 'lean'`.
- Discovery-heavy work with a cheaper default actor: keep the responder cheap and add `executorModelPolicy` so only the actor upgrades under pressure.

Practical rule:

- The leaner the replay policy, the stronger the model should usually be.
- `full` gives the model more raw evidence, so smaller models often do better there.
- `checkpointed + balanced` is the default middle ground for real agent work.
- `adaptive + balanced` is the proactive-summarization variant when you want older successful work compressed sooner.
- `lean` should be reserved for models that can reason well from runtime state plus summaries instead of exact old code/output.
- `executorModelPolicy` is usually better than globally upgrading the whole agent when the bottleneck is actor exploration rather than responder synthesis.

## Option Layout

Use these top-level controls consistently:

- `recursionOptions.ai`: routes `llmQuery(...)` sub-query calls to a different AI service than the parent run.
- `recursionOptions.model`, `modelConfig`, and other forward options: tune the AxGen call used by `llmQuery(...)`.
- `maxSubAgentCalls`: shared `llmQuery(...)` sub-query budget across the whole run. Default is `100`.
- `maxBatchedLlmQueryConcurrency`: caps batched `llmQuery([...])` concurrency.
- `maxRuntimeChars`: runtime/output truncation ceiling for console logs, tool results, and interpreter output replay. The effective limit is computed dynamically each turn based on remaining context budget.
- `summarizerOptions`: default model/options for the internal checkpoint summarizer.
- `contextPolicy`: replay/checkpointing/compression policy.
- `contextMap`: optional persistent orientation cache injected into the distiller and updated once after each successful run. `AxAgentContextMap` evolves indefinitely by default; use `{ infiniteEvolve: false, evolveSteps: N }` on the map object for finite warmup followed by reuse.
- `contextOptions`: distiller-stage forward options.
- `autoUpgrade`: smart defaults, ON by default. Auto-enables `functionDiscovery` for large tool catalogs and keeps oversized undeclared input values runtime-only with a truncated prompt preview. Set `false` to opt out, or tune per side: `{ functionDiscovery?: boolean | { aboveFunctionDocChars }, contextFields?: boolean | { promoteAboveChars, previewChars } }`. Explicit `functionDiscovery` and declared `contextFields` always win.
- `executorOptions`: executor-stage forward options such as `description`, `model`, `modelConfig`, `thinkingTokenBudget`, and `showThoughts`.
- `executorModelPolicy`: executor-only model override rules based on consecutive error turns or discovery fetches from listed namespaces.
- `responderOptions`: responder-stage forward options.
- `judgeOptions`: built-in judge options for `agent.optimize(...)`; for tuning workflows use `ax-agent-optimize`.

Canonical shape:

```typescript
const researchAgent = agent('query:string -> answer:string', {
  contextFields: ['query'],
  runtime,
  recursionOptions: {
    model: 'gpt-5.4-mini',
  },
  maxRuntimeChars: 3000,
  summarizerOptions: {
    model: 'gpt-5.4-mini',
    modelConfig: { temperature: 0.1, maxTokens: 180 },
  },
  contextPolicy: {
    preset: 'checkpointed',
    budget: 'balanced',
  },
  contextOptions: {
    model: 'gpt-5.4-mini',
    maxTurns: 3,
  },
  executorOptions: {
    description: 'Use tools first and keep JS steps small.',
    model: 'gpt-5.4-mini',
  },
  executorModelPolicy: [
    {
      model: 'gpt-5.4',
      aboveErrorTurns: 2,
      namespaces: ['db', 'kb'],
    },
  ],
  responderOptions: {
    model: 'gpt-5.4-mini',
  },
});
```

Semantics:

- `maxRuntimeChars` sets the truncation ceiling and is separate from `contextPolicy.budget`.
- `summarizerOptions` tunes only the internal checkpoint summarizer. It does not change actor or responder model selection.
- `executorModelPolicy` only switches the actor model. It does not change `responderOptions.model`.
- `llmQuery(...)` uses `recursionOptions.ai` when set, otherwise it falls back to the parent `.forward(ai, ...)` service.
- `recursionOptions` configures the AxGen semantic sub-query used by `llmQuery(...)`; it does not create a child AxAgent and cannot give the sub-query tools.
- `executorModelPolicy` entries are ordered from weaker to stronger. If multiple rules match, the last matching entry wins.
- If one entry defines `namespaces`, any successful `discover(...)` function-definition fetch from one of those namespaces marks the rule as matched starting on the next actor turn.
- Do not add `recursionOptions` unless the user needs different model/options for `llmQuery(...)`.

## Dynamic Output Truncation

Runtime output truncation is budget-proportional and type-aware:

- Early turns with little action-log pressure use the full `maxRuntimeChars` ceiling.
- As the action log fills toward `targetPromptChars`, the limit decays linearly down to 15% of the ceiling, hard-floored at 400 chars.
- Large arrays keep the first 3 and last 2 items, with the middle replaced by `... [N hidden items]`.
- Deep objects replace nested values beyond depth 3 with `[Object]` or `[Array(N)]`.
- Error stack traces keep the first 3 and last 1 stack frames.
- Simple values use standard `JSON.stringify` passthrough.

Users do not need to configure this behavior. `maxRuntimeChars` sets the upper bound; the dynamic system only reduces it.

## Stage Prompt Controls

The pipeline has three peer stage-config bags: `contextOptions` (distiller), `executorOptions` (executor), and `responderOptions` (responder). Each accepts the same shape: `description`, `model`, `modelConfig`, `excludeFields`, plus other forward options.

Key fields:

- `contextOptions.description`: append extra distiller-specific instructions.
- `executorOptions.description`: append extra executor-specific instructions; this is the typical place for tool-use guidance.
- `responderOptions.description`: append extra responder-specific instructions.
- `contextOptions.model` / `executorOptions.model` / `responderOptions.model`: split model choice across stages.
- `contextOptions.ai` / `executorOptions.ai` / `responderOptions.ai`: override the AI service for a specific stage.
- `executorModelPolicy`: auto-switch only the executor when the run is on a consecutive error streak or discovery fetches land in specific namespaces.

Good split-model pattern:

```typescript
const researchAgent = agent('query:string -> answer:string', {
  contextFields: ['query'],
  runtime,
  contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
  executorOptions: {
    model: 'gpt-5.4',
  },
  responderOptions: {
    model: 'gpt-5.4-mini',
  },
});
```

Model guidance:

- Put the stronger model on the actor when the task depends on multi-turn exploration, discovery, runtime state reuse, or compressed replay.
- Put the stronger model on the responder only when the hard part is final synthesis/formatting rather than exploration.
- For cost-sensitive setups, a common pattern is stronger actor plus cheaper responder.
- Prefer `executorModelPolicy` over globally upgrading the whole agent when the actor only needs help after context grows or the run starts thrashing.

Prompt/cache shape:

- Actor turns are compact observable turns, not replayed chat transcripts.
- Stable system prompt: role/stage rules, primitive descriptions, static module list, always-included callable signatures, output contract, and field definitions.
- Cached working inputs: task inputs, inline context, `contextMetadata`, `contextMap`, `memories`, `executorRequest`, `distilledContextSummary`, `discoveredToolDocs`, `loadedSkills`, and `summarizedActorLog`.
- Dynamic turn tail: `guidanceLog`, `actionLog`, `liveRuntimeState`, and `contextPressure`.
- Prefer one compact inspection per non-final turn. Never combine inspection output with `final(...)` or `askClarification(...)`.

Invalid actor turn:

```javascript
await discover(['kb.findSnippets']);
const snippets = await kb.findSnippets({ topic: 'severity' });
await final("Summarize severity findings", { snippets });
```

Reason: this mixes observation and follow-up work in one turn. `discover(...)` returns `void`; read the next prompt's "Discovered Tool Docs" section before calling the function.

## AxJSRuntime Security

Default `new AxJSRuntime()` is hardened: no network, no filesystem, no child process, dynamic `import()` blocked, intrinsics frozen, `ShadowRealm` locked to `undefined`, worker IPC locked in browser/Deno/Bun, Bun workers use `smol: true`, and on Node 20+ the OS Permission Model auto-engages where available.

Threat model: this is defense-in-depth for LLM-authored code, not a container or VM boundary. Host callbacks and granted runtime permissions remain the authority boundary; keep durable secrets and privileged effects in host-side functions.

Permission enum (`AxJSRuntimePermission`):
`NETWORK`, `STORAGE`, `CODE_LOADING`, `COMMUNICATION`, `TIMING`, `WORKERS`, `FILESYSTEM`, `CHILD_PROCESS`.

Options quick reference:

- `permissions?: readonly AxJSRuntimePermission[]`: default `[]`; opt in capabilities.
- `blockDynamicImport?: boolean`: default `true`.
- `allowedModules?: readonly string[]`: default `[]`; narrow dynamic-import allowlist gate. Allowlisted specifiers are attempted, but full Node module namespace passthrough depends on Node vm semantics.
- `freezeIntrinsics?: boolean`: default `true`.
- `blockShadowRealm?: boolean`: default `true`.
- `lockWorkerIPC?: boolean`: default `true`.
- `preventGlobalThisExtensions?: boolean`: default `false`; opt-in and breaks top-level persistence.
- `useNodePermissionModel?: boolean | 'auto'`: default `'auto'`.
- `nodePermissionAllowlist?: { fsRead?; fsWrite?; childProcess?; addons?; wasi? }`.
- `resourceLimits?: { maxOldGenerationSizeMb?; maxYoungGenerationSizeMb?; codeRangeSizeMb?; stackSizeMb? }`.
- `allowDenoRemoteImport?: boolean`: default `false`.
- `allowUnsafeNodeHostAccess?: boolean`: default `false`.

Recipes:

```typescript
new AxJSRuntime();

new AxJSRuntime({ permissions: [AxJSRuntimePermission.NETWORK] });

new AxJSRuntime({
  permissions: [AxJSRuntimePermission.FILESYSTEM],
  allowedModules: ['node:fs', 'node:fs/promises', 'node:path'],
  useNodePermissionModel: 'auto',
  nodePermissionAllowlist: {
    fsRead: ['/app/data'],
    fsWrite: ['/app/data'],
  },
});
```

Rules for the LLM author:

- Default to `new AxJSRuntime()` with no options unless the user asked for a specific capability.
- When the user asks for `fetch`, add `permissions: [AxJSRuntimePermission.NETWORK]`.
- When the user asks for filesystem access, prefer host-side tool functions. If direct runtime filesystem access is required, add `permissions: [AxJSRuntimePermission.FILESYSTEM]`, scope with `nodePermissionAllowlist` when the user names a directory, and treat `allowedModules` as an import allowlist gate rather than a portability guarantee.
- Do not disable `freezeIntrinsics`, `blockShadowRealm`, or `lockWorkerIPC` unless the user explicitly asks.
- Treat `allowUnsafeNodeHostAccess: true` as a red flag; only use it when the user is authoring trusted code in their own process.
- `preventGlobalThisExtensions: true` breaks top-level `var`/`let`/`const` persistence across turns; never set it for stdout-mode RLM where persistence is load-bearing.
- On Deno, `blockDynamicImport` is a no-op; the defense is the worker permission sandbox. Pass `allowDenoRemoteImport: true` only if remote module loading is genuinely required.

## Speculative Programmatic Tool Calling

`AxJSRuntime` has an opt-in speculative programmatic tool calling (sPTC) mode, adapted from [Alex Zhang's design](https://alexzhang13.github.io/blog/2026/spec-ptc/) and [reference implementation](https://github.com/alexzhang13/spec-ptc). It conservatively reads the complete code string passed to `execute()` before normal worker execution and starts independent, explicitly authorized host calls early. This can overlap calls that ordinary JavaScript would await serially. It does not overlap tool execution with model-token streaming and does not change worker sandboxing.

Configure exact runtime paths on the runtime; do not put speculative authority in model-visible function metadata:

```typescript
import {
  AxJSRuntime,
  agent,
  f,
  fn,
  type AxJSRuntimeSpeculationEvent,
} from '@ax-llm/ax';

const events: AxJSRuntimeSpeculationEvent[] = [];
const runtime = new AxJSRuntime({
  speculation: {
    callables: {
      'catalog.lookup': { purity: 'pure', deterministic: true },
      llmQuery: { purity: 'pure', deterministic: false },
    },
    maxConcurrency: 4,
    maxCallsPerExecution: 16,
    onEvent: (event) => events.push(event),
  },
});

const lookup = fn('lookup')
  .namespace('catalog')
  .description('Read one immutable catalog record')
  .arg('id', f.string('Catalog id'))
  .handler(async ({ id }, extra) => {
    return readImmutableCatalog(id, { signal: extra?.abortSignal });
  })
  .build();

const assistant = agent('query:string -> answer:string', {
  runtime,
  functions: [lookup],
  contextFields: [],
});
```

Eligibility is fail-closed:

- A path is eligible only when `callables` contains that exact dot-qualified path and the policy explicitly says `purity: 'pure'` plus `deterministic: boolean`. There are no wildcards or default eligibility.
- Planning is not a sandbox and the allowlist does not make a callable safe. Unlike the reference design's shadow-REPL/deepcopy approach, Ax does not execute generated source in a second host REPL. Unsafe syntax, open or unresolved dependencies, and non-cancellable host functions are blocked or missed rather than made safe.
- `purity: 'pure'` is the application's attestation that starting and abandoning the call is safe: no writes, messages, transactions, or other durable application effects before claim. The speculative AxFunction adapter supplies an isolated completion protocol whose effects queue during launch and replay only after the real call claims the launch; status methods replay in awaited order. The handler must honor `abortSignal` and tolerate cancellation.
- Speculation can still consume CPU, network quota, rate limits, or provider tokens. In particular, authorizing `llmQuery` can bill an unclaimed sub-query and consumes the normal Ax sub-query budget. Only opt in when that bounded waste is acceptable.
- Set `deterministic: true` only when equivalent structural arguments always produce an equivalent result. Equivalent duplicates share one physical result but retain two logical calls and observations. With `false`, matching keys include program occurrence: repeated calls remain distinct and claim their independently launched results FIFO.
- AxAgent external functions and its `llmQuery` binding provide the cancellable host adapter. Exact MCP/UCP paths can qualify only when the application makes the same purity attestation. Child agents are intentionally ineligible because their nested tools and budgets are not proven pure. A raw function injected directly into `createSession()` has no speculative adapter and falls back normally.
- Each physical launch receives its own validated structured clone of the complete argument graph, matching the worker callback boundary. Mutable host references are never shared between speculative occurrences; graphs with observable shared references fail closed.
- When an Ax host authority context is active, Ax deeply captures and freezes the original principal, actor, delegation, grants, lease epoch, and exact operation/resource tuple before authorization. The speculative physical call receives that same immutable snapshot and its bound receipt. A denial is claimed with zero physical function work and, matching normal authorization order, no logical call observer or recorder. Host-side mutation during `authorize` cannot retarget the request. Authority changes made after the execution snapshot are intentionally visible only to a later execution, matching ordinary Ax authority semantics rather than invalidating one in-flight snapshot.

The conservative planner supports only top-level direct calls to configured exact paths, optionally assigned to a simple `const`, `let`, or `var`. Arguments may use strings, finite numbers, booleans, `null`, `undefined`, arrays, plain objects, safe plain-object/array/string member reads, unary `-`, addition/string concatenation with `+`, serializable initial host globals, and results from a prior **awaited** planned call. A dependent launch waits for its predecessor future and uses a validated structured clone of the worker-visible result. Separate multiple top-level statements with semicolons.

Everything else keeps ordinary runtime behavior. Unsupported examples include control flow and loops containing calls, functions/classes, aliases or other indirect calls, computed tool paths, nested calls, destructuring, spread, interpolated templates, regex/division syntax, method calls/transforms, semicolonless multi-statement cells, and dependencies on an unapproved call or a variable created only inside an earlier worker cell. The planner never uses host `eval` or `Function`; unsafe or incomplete parsing simply misses, and the hardened worker executes the original code.

Operational semantics:

- Each `execute()` defaults to at most 4 concurrent speculative host operations and 16 planned calls; configurable hard maxima are 32 and 256. Code over 100,000 characters and canonical arguments over 50,000 characters are not planned.
- Each `execute()` gets an isolated, bounded match store that is discarded at completion rather than retained as a cache. Results are never matched across cells, so a previous failed or completed execution cannot create a stale hit.
- Real worker execution claims by exact callable reference, canonical arguments, and nondeterministic occurrence. A hit adopts the already-started promise without retrying; a miss invokes the ordinary host function once. Its normal function-call observer and recorder commit exactly once at the real worker call. The adapter keeps independent pre-call and post-settlement argument snapshots so observers see ordinary pre-call values while the recorder sees tool-local mutations exactly as it does without speculation. Unclaimed work is cancelled and never committed as a logical function call.
- Planning never writes worker globals or evaluates generated source on the host. If the worker rejects incomplete or erroneous code, no partial planner state is committed to the persistent runtime session; only explicitly pure speculative requests may have been started and are then cancelled.
- Execution completion cancels unclaimed work; execution failure or abort, including closing a session while it executes, cancels all calls active in that execution. A successfully claimed but deliberately unawaited call retains ordinary JavaScript semantics and may outlive the cell. Rejections are always observed. A non-cooperative pure handler may continue consuming resources after cancellation, which is why eligibility remains an application responsibility.
- `onEvent` receives best-effort `dispatch`, `hit`, `miss`, `blocked`, and `cancelled` diagnostics with bounded reason codes, including launch invalidation misses. Callback errors are ignored; diagnostics are not an authorization mechanism.

### Offline evaluation

The zero-cost fixture compares enabled and disabled execution, checks result/tool-call equivalence, and covers hit, miss, unsafe, duplicate, failure, and cancellation behavior:

```bash
AX_PRINT_METRICS=1 ./node_modules/.bin/vitest run src/ax/funcs/benchmarks/jsRuntimeSpeculation.test.ts
```

One five-repetition median run in the Ax development orb produced:

| workload | disabled median | enabled median | disabled / enabled |
|---|---:|---:|---:|
| three independent 40 ms calls | 123.3 ms | 41.6 ms | 2.97x |
| two dependent 30 ms calls | 62.6 ms | 61.3 ms | 1.02x |
| twenty zero-delay alias misses | 27.5 ms | 28.0 ms | 0.98x |

The independent workload demonstrates latency overlap. The dependent chain shows essentially no speedup, and the parser-miss workload records small negative overhead. Accounting in the same run was: deterministic duplicates 2 physical / 2 logical when disabled versus 1 / 2 enabled; nondeterministic duplicates 2 / 2 in both modes; an unapproved side effect 2 / 2 in both modes and executed its write once; claimed failure 1 / 1 in both modes; claimed cancellation 1 / 1 and aborted; and an unreached pure call after `throw` launched 1 physical / 0 logical call versus 0 / 0 disabled, then aborted it. The source article separately reports only five author runs and roughly 1.0–1.2x on specific OOLONG/RLM/8xH100 setups; Ax does not generalize that evidence. These controlled fixtures do not establish model-quality improvement, cost reduction, or universal latency speedup.

## Custom Code Runtimes

Implement `AxCodeRuntime` when the actor should write a language other than JavaScript.

- Set `language` to the model-facing language name. JavaScript aliases (`JavaScript`, `js`, `ecmascript`) keep `javascriptCode`; other values derive lower-camel code fields such as `pythonCode` or `cSharpCode`.
- Keep execution inside `createSession(globals, options)`. AxAgent passes `inputs`, `llmQuery`, `final`, `askClarification`, progress callbacks, memory/discovery primitives, and namespaced tools as host globals; the runtime decides how those globals appear in the target language.
- Put language syntax, output behavior, persistence semantics, and completion-call examples in `getUsageInstructions()`.
- Use `getPrimitiveOverrides()` to describe language-native calls for built-in primitives, and `formatCallable()` to describe language-native calls for tools and child agents.
- Implement `inspectGlobals()` on sessions when `contextPolicy` should show live runtime state for non-JavaScript runtimes; otherwise AxAgent will not run JavaScript fallback inspection snippets.

## RLM Test Harness

Use `agent.test(code, contextFieldValues?, options?)` when the user wants to validate runtime snippets against the actual AxAgent runtime environment without running the full actor/responder loop. With `AxJSRuntime`, those snippets are JavaScript.

```typescript
import { AxJSRuntime, agent, f, fn } from '@ax-llm/ax';

const runtime = new AxJSRuntime();

const tools = [
  fn('sum')
    .description('Return the sum of the provided numeric values')
    .namespace('math')
    .arg('values', f.number('Value to add').array())
    .returns(f.number('Sum of all values'))
    .handler(async ({ values }) =>
      values.reduce((total, value) => total + value, 0)
    )
    .build(),
];

const toolHarness = agent('query:string -> answer:string', {
  contextFields: [],
  runtime,
  functions: tools,
  contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
});

const toolOutput = await toolHarness.test(
  'console.log(await math.sum({ values: [3, 5, 8] }))'
);

console.log(toolOutput);
```

Rules:

- `test(...)` creates a fresh runtime session per call.
- Context-field snippets run in the context/distiller runtime and expose `inputs` plus non-colliding top-level aliases for configured `contextFields`.
- Tool snippets should use an agent with no `contextFields`, or test the executor stage directly, so namespaced functions, child agents, and `llmQuery(...)` are in scope.
- In `AxJSRuntime`, do not rely on calling `inspectRuntime()` from inside `test(...)` snippets yet; prefer checking runtime globals directly inside the snippet.
- It returns the formatted runtime output string.
- It throws on runtime failures instead of returning LLM-style error strings.
- Do not call `final(...)` or `askClarification(...)` inside `test(...)` snippets.
- Pass only `contextFields` values to `test(...)`; it is not a general way to inject arbitrary non-context inputs.
- If the snippet uses `llmQuery(...)`, provide an AI service through the agent config or `options.ai`.

## `llmQuery(...)` Rules

Available forms:

- `await llmQuery(query, context?)`
- `await llmQuery({ query, context? })`
- `await llmQuery([{ query, context }, ...])`

Rules:

- `llmQuery(...)` forwards only the explicit `context` argument.
- Parent inputs, runtime variables, tool results, and discovered docs are not automatically available to `llmQuery(...)`; include any needed facts in `context`.
- `llmQuery(...)` is a direct semantic helper backed by an AxGen sub-query. It does not create a child AxAgent, does not run an actor runtime session, and does not have access to tools or discovery.
- Use batched `llmQuery([...])` only for independent semantic questions. Use serial calls when later work depends on earlier results.
- Pass compact named object context instead of huge raw parent payloads.
- Do not assume anything other than the returned string comes back from `llmQuery(...)`.
- `maxSubAgentCalls` is a shared budget for `llmQuery(...)` sub-queries across the top-level run.
- Single-call `llmQuery(...)` may return `[ERROR] ...` on non-abort failures.
- Batched `llmQuery([...])` returns per-item `[ERROR] ...`.
- If a result starts with `[ERROR]`, inspect or branch on it instead of assuming success.

### Retained AxAgent delegation is different

`AxAgentSessionHost` is the opt-in path for a real retained AxAgent child. Add
an owning session client's generated functions to `functions`; executor code
can then admit work without blocking:

```javascript
const handle = await sessions.spawn({
  agent: 'researcher.v1',
  input: { task: 'Inspect the incident evidence' },
});
console.log(handle);
```

On later turns, inspect the handle or send complete child-signature inputs:

```javascript
await sessions.send({
  handle,
  mode: 'follow-up',
  input: { task: 'Now compare it with the remediation log' },
});
```

Use `mode: 'steer'` only when current child work should be cancelled and the
new input should run first. `follow-up` never interrupts. Child runtime state
is captured through the existing AxAgent state format; values Ax cannot
serialize do not become durable merely because the session is retained.
Recovery advances a root-wide lease epoch: restore the root and refresh handles
before sending more mail; executor closures from the previous owner are stale.
Ambiguous running work keeps its pre-dispatch token reservation charged.
Explicit snapshot restore also rotates destination authority, and its
separately trusted digest covers canonical policy, lifecycle diagnostics,
mailbox payloads, retained state/artifacts, enumerable string data keys/key
order, and accounting aggregates. Ordinary objects/arrays reject
non-enumerable or symbol keys and accessors (apart from intrinsic array
`length`); intrinsic values reject custom own keys. One bounded
descriptor-based capture creates detached trusted data without invoking caller
getters or cloning the live graph; import is capped at depth 64, 100,000
visited values/typed-array elements, 16 MiB aggregate string/binary data, and
4,096-bit bigints. Proxy reflection traps remain executable host code, so
restore accepts host-owned snapshots only. A lazy `Error.stack` accessor is
discarded without invocation and replaced by an inert marker; it is not durable
stack text.

This mechanism does not expose a second interpreter, inherit parent tools, or
change `llmQuery(...)` budgets. The host independently bounds child count,
depth, concurrency, pending/retained mail, tokens, and admitted subcalls. See
`docs/RETAINED_CHILD_SESSIONS.md`.

Minimal example:

```javascript
const summary = await llmQuery('Summarize this incident', inputs.context);
if (summary.startsWith('[ERROR]')) {
  console.log(summary);
} else {
  console.log(summary);
}
```

Parallel semantic review example:

```javascript
const narrowedIncidents = incidents.map((incident) => ({
  id: incident.id,
  timeline: incident.timeline,
  notes: incident.notes.slice(0, 1200),
}));

const [severityReview, followupReview] = await llmQuery([
  {
    query:
      'Use discovery and available tools to review severity policy alignment. Return compact findings.',
    context: {
      incidents: narrowedIncidents,
      rubric: 'severity-policy',
    },
  },
  {
    query:
      'Use discovery and available tools to review postmortem and follow-up obligations. Return compact findings.',
    context: {
      incidents: narrowedIncidents,
      rubric: 'postmortem-followup',
    },
  },
]);

const merged = await llmQuery(
  'Merge these delegated reviews into one manager-ready summary with next steps.',
  {
    severityReview,
    followupReview,
    audience: inputs.audience,
  }
);
```

Delegation decision guide:

- **JS-only**: deterministic logic such as filter, sort, count, regex, or date math -> do it inline.
- **Single-shot semantic**: needs LLM reasoning but no tools or multi-step exploration -> single `llmQuery(...)` with narrow context.
- **Specialist/tool delegation**: needs its own tools, discovery, runtime, or reusable role -> create a child `agent(...)` and pass it in `functions: [...]`.
- **Retained concurrent specialist**: work should outlive the current actor turn, retain isolated state, or accept later steering/follow-up -> use an explicitly authorized `AxAgentSessionHost` registration.
- **Parallel semantic fan-out**: two or more independent semantic-only subtasks -> batched `llmQuery([...])`.

Context handling:

- Always narrow with JS before delegating. Never pass raw `inputs.*`.
- Name context keys semantically, e.g. `{ emails: filtered, rubric: 'classify-urgency' }`.
- Estimate total sub-query calls before fanning out. `maxSubAgentCalls` is shared across the run.

Patterns:

- Fan-Out / Fan-In: JS narrows into categories -> `llmQuery([...])` fans out per category -> JS or one more `llmQuery(...)` merges semantic results.
- Pipeline: serial `llmQuery(...)` calls where each depends on the prior result.
- Specialist tool use: call child agents or tools via their namespaced function globals, e.g. `await team.writer({ draft })`.

## Examples

Fetch these for full working code:

- [RLM](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm.ts) - RLM basic
- [RLM Long Task](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-long-task.ts) - RLM context policy
- [RLM Discovery](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-discovery.ts) - discovery mode, grouped tools, child agents as functions, and semantic `llmQuery(...)`
- [RLM Adaptive Replay](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-adaptive-replay.ts) - adaptive replay

Flagship real-world long-agents (also ported to Python, Go, Rust, Java, and C++ under `src/examples/<lang>/long-agents/`; run with `npm run example -- <lang> <path>`):

- [Incident Log Forensics](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/incident-log-forensics.ts) - large-context log forensics over `contextFields` (Gemini)
- [Codebase Peek Map](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/codebase-peek-map.ts) - Peek-paper context-map orientation over a large repo snapshot
- [Data Analyst with Tools](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/data-analyst-with-tools.ts) - large data dictionary in `contextFields` + typed warehouse tools the model queries instead of inlining
- [Smart Defaults Agent](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/smart-defaults-agent.ts) - oversized undeclared context auto-promoted runtime-only, with relevance hints and runtime tools
- [Self-Improving Lab](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/self-improving-lab.ts) - many-tool agent that runs experiments, grades them with an independent verifier, and distills verified rules into memory

## Do Not Generate

- Do not write a full multi-step RLM actor program in one turn.
- Do not combine `console.log(...)` with `final(...)`.
- Do not assume old successful turns stay fully replayed under adaptive/checkpointed/lean policies.
- Do not rebuild runtime state just because a prior turn was summarized.
- Do not describe `llmQuery(...)` as spawning a tool-using child AxAgent.
- Do not assume parent inputs are available to `llmQuery(...)` unless passed in `context`.
- Do not ignore `[ERROR] ...` results from `llmQuery(...)`.
- Do not grant `AxJSRuntime` permissions unless the user asked for the capability.
