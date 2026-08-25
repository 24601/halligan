# Experimental Program-Source Optimization

`programSource(...)` is Ax's experimental program-as-code optimization surface.
It keeps a signature fixed while exposing the program's complete implementation
and control flow as one validated `program-source` component. GEPA can therefore
replace a one-predictor seed with a bounded composition of predictors, explicit
tools, branches, list maps, and typed output assembly.

This is not a Python Flex port and does not accept JavaScript modules. Optimizer
output is a strict JSON control-flow AST, `ax-program-source/v1`. Ax parses it as
inert data and runs a fixed Ax-owned interpreter in a fresh runtime session.
The feature is opt-in through a new program subtype; existing `ax(...)`, flow,
agent, and ordinary GEPA behavior is unchanged.

## Public API

```ts
import { optimize, programSource } from '@ax-llm/ax';

const program = programSource(
  'ticketText:string -> priority:class "urgent, normal", rationale:string',
  {
    tools: [classifyUrgency],
    maxPredictorCalls: 4,
    maxToolCalls: 2,
    maxIterations: 48,
    maxStepsPerPredictor: 6,
    timeoutMs: 10_000,
  }
);

const result = await optimize(program, train, metric, {
  studentAI,
  teacherAI,
  validationExamples: heldOut,
  numTrials: 8,
  maxMetricCalls: 80,
  bootstrap: false,
});

program.applyOptimization(result.optimizedProgram!);
```

The program exposes:

- `getProgramSource()` and transactional `setProgramSource(source)`
- `getCapabilities()` for the capabilities declared by the bound source
- `dumpState()` and `loadState(state)` for versioned source state
- normal Ax program APIs, including `forward`, `streamingForward`, component
  discovery, optimization application, usage, traces, and artifacts

`tools` is the host allowlist. The default seed performs one `$program`
prediction and exposes every constructor tool to that predictor. `source` can
replace the seed at construction. A custom `runtime` is a trusted dependency;
the default is a locked-down `AxJSRuntime` worker.

## Source Contract

Every source is one complete JSON document:

```json
{
  "version": "ax-program-source/v1",
  "capabilities": ["tool:classify_urgency"],
  "steps": [
    {
      "op": "tool",
      "name": "classify_urgency",
      "as": "priority",
      "args": {
        "op": "object",
        "entries": {
          "ticketText": { "op": "ref", "path": "inputs.ticketText" }
        }
      }
    },
    {
      "op": "return",
      "outputs": {
        "priority": { "op": "ref", "path": "priority" },
        "rationale": {
          "op": "literal",
          "value": "Applied the explicit urgency classifier."
        }
      }
    }
  ]
}
```

Statements are `predict`, `tool`, `if`, `forEach`, and final top-level
`return`. Expressions are `literal`, `ref`, `object`, `array`, `eq`, `select`,
`not`, `and`, `or`, and `concat`.

A `predict` statement uses either the immutable outer signature (`$program`) or
another valid Ax string signature. It can add a local instruction and expose a
subset of allowed tools. It cannot select a model or AI service. Every used
predictor or tool must also appear in the document's explicit capability list.

Binding enforces exact AST fields, known variables and tools, safe reference
paths, required output names, source/statement/nesting limits, and local loop
limits. Runtime output is then checked against the immutable outer signature:
unknown fields are rejected, required fields must exist, and every value must
match its Ax type and constraints.

## GEPA And Artifacts

The component key is `<program-id>::program-source`. Its current value is the
complete bound source. Its proposal context includes the task description,
immutable outer signature, tool schemas, host-allowed capabilities, grammar,
and all per-example budgets. GEPA proposes a whole replacement document and
runs the component validator before evaluation.

Parse and bind errors are candidate failures. During direct GEPA evaluation,
they produce aligned zero-score rows instead of aborting the optimizer or
scoring stale source. Runtime, tool, predictor, output, and budget errors are
also aligned to the example that failed.

Config-error alignment is enabled only when the discovered component tree
contains `kind: "program-source"`. Ordinary GEPA trees retain their existing
config-error behavior. This keeps the feature additive at Ax's upstream generic
component boundary instead of redefining instruction/component semantics.

Program-source components coexist with ordinary instruction, description,
tool, primitive, and descendant components in the same component map. Source
is bound before other components in a mixed update, so malformed source cannot
partially mutate the rest of that update. Normal optimized artifacts preserve
the source string in `componentMap`; use `axSerializeOptimizedProgram(...)` and
`axDeserializeOptimizedProgram(...)` for browser-safe artifact storage.

## Security Model

- Candidate text is parsed as JSON data. It is never passed to host `eval`,
  `Function`, dynamic import, or a JavaScript module loader.
- The only bridges installed in a fresh worker session are `predict` and the
  exact host tools named by the validated source.
- The default runtime has no allowed modules or runtime permissions and blocks
  dynamic imports, remote imports, ShadowRealm, unsafe Node host access, and
  worker IPC.
- Source cannot access filesystem, process, network, environment variables,
  imports, ambient globals, or mutable cross-call state.
- Predictor, tool-call, executed-statement/loop, continuation-step, source-size,
  nesting, and wall-clock limits are enforced.
- Inputs, source, and outputs cross the runtime's structured-clone boundary.
  `src/ax` keeps browser-safe imports; no Node filesystem/process module is
  introduced by this feature.

Explicit capabilities are authority: the configured AI service can make its
normal provider calls, and a supplied tool can do anything its host handler is
written to do. Do not supply broad or unsafe tools to untrusted optimized
source. A custom runtime is likewise trusted. The safety claim is that source
cannot acquire authority beyond those explicit bridges, not that arbitrary
host tools become safe.

`programSource(...)` does not select or certify custom execution backends.
Supplying `runtime` injects an existing `AxCodeRuntime` directly; Ax does not
currently negotiate machine-readable authority, persistence, isolation,
resource-limit, or protocol-conformance claims for that interface. A reusable
backend capability and conformance contract belongs to the shared RLM/runtime
subsystem, not this experimental source grammar. Use the configured default
when this feature's documented worker boundary is required.

## Supported And Unsupported Tasks

Good fits:

- typed language-model tasks that benefit from multi-step decomposition
- bounded routing among predictors and explicit tools
- deterministic branching and typed field assembly
- bounded mapping over input lists
- replacing an unnecessary predictor with a cheaper explicit tool path

Not supported in `v1`:

- arbitrary JavaScript/Python, modules, imports, closures, or user-defined code
- arithmetic or general computation beyond the listed expression primitives
- recursion, `while`, unbounded loops, or nested/early returns
- dynamic model, provider, signature, tool, or capability construction
- persistent mutable source state or ambient I/O
- execution-backend discovery, capability negotiation, or conformance testing
- source-defined streaming of intermediate tokens (the program emits one final
  typed delta through `streamingForward`)
- values that cannot cross the selected runtime's structured-clone boundary

Use a normal Ax program, flow, agent, or a carefully designed explicit tool when
the task needs those capabilities. Do not weaken the runtime boundary by
accepting arbitrary source modules.

## Bounded Evaluation Evidence

The checked-in deterministic suite is mechanism evidence, not model-quality
evidence. It uses fixed four-example train and two-example held-out urgency sets:

- seed: train `0.5`, held-out `0.5`
- invalid JSON: rejected before evaluation
- train memorizer: train `1.0`, held-out `0.0`, rejected and rolled back
- general explicit-tool source: train `1.0`, held-out `1.0`, promoted
- negative control: a redundant two-predictor source ties a perfect seed and is
  rejected as adding no value

The suite reports per-candidate runtime, zero-dollar cost, source bytes,
statement count, final source complexity, and total runtime. Hard bounds are 30
metric calls, 12 predictor calls, 8 tool calls, and 10 seconds; the expected
mechanism run uses 22, 12, and 6 calls respectively.

Run the zero-cost evidence and focused tests from the repository root:

```bash
node --import=tsx src/examples/program-source-evaluation.ts
npx vitest run src/ax/dsp/programSource.test.ts src/ax/dsp/programSourceEvaluation.test.ts src/ax/dsp/optimizers/gepaEvaluation.test.ts
```

An optional real-model smoke path is capped at one GEPA trial and eight metric
calls. It is opt-in and incurs OpenAI charges; it is not part of deterministic
CI and was not run for this feature:

```bash
OPENAI_APIKEY=... node --import=tsx src/examples/program-source-evaluation.ts --paid --ack-paid-calls
```

The public provider-backed example is:

```bash
npm run example -- typescript src/examples/typescript/optimization/program-source.ts
```
