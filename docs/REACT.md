# Structured ReAct

`react(...)` is a focused typed tool loop for tasks that need a few model/tool
rounds and a signature-validated final value. It complements `ax(...)`; it does
not change the existing `ax(...)` function loop and does not replace `AxAgent`,
RLM, discovery, delegation, or durable agent sessions.

```typescript
import { ai, f, fn, react } from '@ax-llm/ax';

const lookup = fn('lookup')
  .description('Look up a value by key')
  .arg('key', f.string())
  .returns(f.string())
  .handler(async ({ key }) => database.get(key) ?? 'not found')
  .build();

const answer = react('question:string -> answer:string, confidence:number', {
  functions: [lookup],
  maxIterations: 6,
});

const result = await answer.forward(llm, { question: '...' });
if (result.success) {
  console.log(result.output.answer);
} else {
  console.error(result.terminationReason, result.error, result.output);
}
```

## Terminal Contract

Ax derives a reserved `submit` tool from the signature's public output fields.
The model can finish only by calling `submit` with exactly those fields. Ax
coerces JSON-compatible primitive values where safe, parses structured JSON
fields, runs signature and Standard Schema validation, rejects unknown fields,
and returns the validated value under `result.output`.

The nested result avoids collisions when a signature contains names such as
`success`, `history`, or `terminationReason`:

```typescript
type AxReactResult<Output> =
  | {
      success: true;
      output: Output;
      terminationReason: 'submit' | 'forced_submit';
      history: AxReactHistory;
    }
  | {
      success: false;
      output: { [K in keyof Output]: Output[K] | null };
      terminationReason:
        | 'forced_submit_failed'
        | 'model_error'
        | 'protocol_error'
        | 'aborted';
      history: AxReactHistory;
      error: { code: string; message: string };
    };
```

Every runtime failure includes every declared public output key set to `null`,
a termination reason, and the last complete canonical history. Invalid caller
inputs, malformed or incompatible histories, invalid constructor configuration,
and reserved or ambiguous tool names are rejected before a run starts and
therefore throw. Per-run provider/configuration failures retain the structured
result contract.

## Native And Prompt Protocols

`functionCallMode` controls the model boundary:

- `auto` (default) uses native calls when `ai.getFeatures(model).functions` is
  true, otherwise it uses the prompt protocol.
- `native` requires provider-native function calling and fails closed when the
  selected provider/model does not advertise it; this is returned as a
  structured `protocol_error` failure.
- `prompt` uses a strict provider-neutral JSON envelope and sends no provider
  function definitions.

Native mode sends ordinary Ax `functions` and normalized assistant/function
messages. Prompt mode requires exactly:

```json
{"thought":"optional short rationale","calls":[{"name":"toolName","arguments":{}}]}
```

Prompt responses with Markdown, extra fields, or invalid JSON are protocol
failures. Prompt tool results are clearly delimited JSON observations. Prompt
mode never accepts model-supplied IDs. Native history retains a valid unique
provider call ID only for provider replay, alongside Ax's separate canonical ID.

Coverage is capability-based rather than provider-name-based. Native mode works
through Ax adapters and models that advertise function calling, including
current tool-capable OpenAI, Anthropic, and Gemini profiles. Text-only and
OpenAI-compatible models without verified function support use prompt mode.
Individual models can differ in parallel-call quality, forced-tool support,
schema fidelity, and context limits; use `native` when weakening to prompt mode
would be unacceptable.

## Execution And History

- Tool handlers are awaited. Attached MCP/UCP bindings execute through the
  run-scoped native execution context and receive the abort signal.
- Calls in one assistant turn execute concurrently up to
  `maxParallelTools` (default 4). Results are committed in call order. Batches
  above `maxToolCallsPerIteration` (default 16) execute nothing.
- `submit` must be the only call in its turn. Mixed terminal/tool batches
  execute nothing and become recoverable error observations.
- Tool arguments and declared results are schema-checked. Runtime exceptions
  become generic model-visible errors so handler details are not copied into
  prompts; invalid arguments and result shapes retain bounded corrective text.
- At normal iteration exhaustion, Ax makes exactly one additional submit-only
  attempt. A valid terminal call reports `forced_submit`; any other outcome
  reports `forced_submit_failed` with the full null output shape.

`result.history` is a serializable provider-neutral transcript. It stores
assistant calls and matching tool results as atomic ordered groups. Call IDs use
a fresh Ax UUID for every call, while valid unique native provider IDs are kept
separately so native assistant/tool replay preserves the provider protocol.
Duplicate, empty, or oversized provider IDs fall back to the Ax ID. The
transcript also keeps its own namespace and allocation counter. Forked or
sequential resumed runs therefore do not collide even when provider IDs repeat.
Arguments, results, inputs, and `axReactSerializeHistory(...)` use recursive
key-sorted canonical JSON. The history header binds replay to hashes of the
signature, canonical executable tool catalog (names, schemas, protocol
metadata, and the reserved `submit`), host authority/version, and replay mode.
Native replay additionally binds the provider name and selected model so
provider-specific call IDs are not replayed into a different native protocol.

Pass a prior history to resume:

```typescript
const resumed = await answer.forward(llm, input, {
  history: previous.history,
});
```

The signature, canonical input, current executable catalog, authority, and
replay protocol must match. By default authority is scoped to one `AxReact`
instance. To persist history across process restarts or recreate the module,
provide a stable, non-secret host authority/version:

```typescript
const answer = react('question:string -> answer:string', {
  functions: [lookup],
  historyAuthority: 'support-assistant:tenant-a:tools-v3',
});
```

Change that value whenever tool implementation semantics, credentials,
permissions, tenant scope, or host-provided context authority changes. Matching
the value is an authorization decision by the host; it is not a credential or
an integrity signature. A per-run `historyAuthority` forward option overrides
the module default; use it on both the initial and resumed calls when one module
serves multiple authorization scopes. Ax clones caller-owned history before
appending. It retains the full canonical transcript for persistence while
replaying only bounded recent context. Compaction drops only complete
assistant/result groups, never an orphan call or result. Tune
`maxPromptHistoryGroups`, `maxPromptHistoryCharacters`, and
`maxPromptValueCharacters` for the selected model.

The system and canonical input are stable cache checkpoints. When history is
replayed, Ax also marks the end of the newest complete retained group as the
moving cache checkpoint, allowing providers with explicit prefix caching to
reuse prior assistant/tool turns.

Use `abortSignal` for one run or `program.stop()` for all active runs. An abort
during tool execution does not commit a partial call/result group.

## Security Notes

- Tool results are untrusted model input. Authorize tools in handlers; a schema
  is validation, not an authorization boundary.
- `submit` and all provider-normalized tool names are reserved/collision
  checked. Terminal arguments reject call markers, thoughts, IDs, and other
  undeclared metadata.
- The stored transcript is complete and may contain application data even when
  replay values are truncated. Protect it according to the sensitivity of tool
  inputs and results.
- History validation rejects malformed structure and incompatible execution
  scope; it does not authenticate semantic content. Canonical edits to prior
  assistant text, arguments, results, or errors remain structurally valid and
  are replayed as untrusted evidence. The caller owns storage integrity and
  must verify its own MAC/signature before passing history when tampering is in
  scope.
- Keep effects idempotent when a caller may retry a failed or aborted run. Ax
  guarantees transcript atomicity, not rollback of external side effects.

## Evaluation

Run the free deterministic protocol/task suite:

```bash
npm run eval:react
```

It compares native and prompt lanes on protocol completion, task-specific final
output correctness, exact tool calls, canonical and replay ID uniqueness,
call/result ordering, termination reasons, model turns, forced submit, resume
determinism, bounded async latency, recoverable errors, final failures, and
serialized prompt size. Cases include a text-only provider, misleading tools,
handler failure/recovery, parallel async calls, and a direct-submit case where
tools provide no benefit.

The scripted provider results are reproducible mechanism evidence, **not**
evidence that one protocol improves real-model quality. The optional live lane
reports bounded, task-specific output checks rather than a general quality
score. To run it (four read-only tasks, four normal iterations each), explicitly
select one provider and supply its credential:

```bash
OPENAI_APIKEY=... npm run eval:react -- --live=openai
GOOGLE_APIKEY=... npm run eval:react -- --live=gemini
ANTHROPIC_APIKEY=... npm run eval:react -- --live=anthropic
```

The repository does not run paid lanes automatically. Native mode is most
useful when the selected model reliably emits typed calls, especially when the
prompt fallback's repeated tool catalog materially increases context. It may
provide no completion or turn benefit for direct-submit tasks, and a weak
native implementation can underperform a strong text-only model. Treat live
results as model/profile-specific measurements.
