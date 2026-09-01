---
name: ax-gepa
description: This skill helps an LLM generate correct AxGEPA optimization code using @ax-llm/ax. Use when the user asks about AxGEPA, GEPA, Pareto optimization, multi-objective prompt tuning, reflective prompt evolution, validationExamples, maxMetricCalls, or optimizing a generator, flow, or agent tree.
version: "24.0.17"
---

# GEPA Optimization Codegen Rules (@ax-llm/ax)

Use this skill to generate GEPA optimization code. Prefer the top-level `optimize(...)` helper for normal code, and use direct `AxGEPA` / `AxBootstrapFewShot` only when the user needs low-level optimizer control.

## Use These Defaults

- Use `optimize(program, train, metric, { studentAI, teacherAI, ... })` for normal generator and flow tuning.
- Prefer `ai()`, `ax()`, and `flow()` for new code.
- Use a strong `teacherAI` and a cheaper `studentAI`.
- Pass `validationExamples` when you have a holdout set.
- Set `maxMetricCalls` to bound optimizer cost; `optimize(...)` defaults it to `100`.
- Use scalar metrics for one objective, object metrics for legacy Pareto optimization, or `AxMetricResult` when evaluation also has textual feedback.
- Apply results with `program.applyOptimization(result.optimizedProgram!)`.
- For tree-wide runs, expect `optimizedProgram.componentMap`.
- Persist artifacts with `axSerializeOptimizedProgram(...)` and restore them with `axDeserializeOptimizedProgram(...)` so the same flow works in browsers and Node.
- Opt in with `candidateLineage: true`, then inspect `result.optimizedProgram.candidateLineage` when optimization decisions must be audited or reproduced.
- `optimize(...)` runs `AxBootstrapFewShot -> AxGEPA` for small starter sets by default, preserving the demos in `result.optimizedProgram.demos`.

## Critical Rules

- `optimize(...)` and `AxGEPA.compile()` work for a single generator and for tree-aware roots such as flows or agents with registered optimizable descendants.
- There is no separate flow-only GEPA optimizer. Use `AxGEPA` for flows too.
- The metric may return `number`, `Record<string, number>`, or a structured `AxMetricResult` with `score`, optional `feedback`, and optional named `scores`.
- Keep metrics deterministic and cheap by default.
- Avoid extra LLM calls inside the metric unless the user explicitly wants judge-based evaluation.
- If the user needs LLM-as-judge scoring for a non-agent GEPA run, prefer a plain typed `AxGen` evaluator instead of writing a custom judge abstraction.
- `maxMetricCalls` must be large enough to cover the initial validation pass over `validationExamples`.
- GEPA optimizes generic string components exposed by `getOptimizableComponents()`. If a tree exposes no components, optimization will fail.
- Use held-out validation examples for selection. Do not reuse the training set as `validationExamples`.
- `result.optimizedProgram` is the easy-to-apply best candidate. `result.paretoFront` is the full trade-off set for multi-objective runs.
- Direct `AxGEPA` still has its own `bootstrap` option, but top-level `optimize(...)` composes the existing `AxBootstrapFewShot` optimizer before GEPA instead.
- Structured metric feedback is evaluation data: it is bounded, added to reflection, and not persisted in optimized-program artifacts. Ax does not infer or autonomously rewrite evals from production data.

## Proposal Policy and Optimization References

Use `gepaProposal` when the reflection model needs trusted developer guidance or a custom way to propose component text:

```typescript
const result = await optimize(program, train, metric, {
  studentAI,
  teacherAI,
  validationExamples: validation,
  gepaProposal: {
    references: [
      {
        name: 'support-policy',
        description: 'General escalation rules',
        content: policyMarkdown,
      },
    ],
    additionalGuidance: 'Prefer short, testable rules.',
    maxExamples: 6,
    policy: async ({
      ai,
      target,
      currentValue,
      reflectiveExamples,
      references,
      additionalGuidance,
      previousValidationError,
      attempt,
    }) => {
      // Return a complete replacement, or undefined to keep currentValue.
      return proposeWithYourPolicy({
        ai,
        target,
        currentValue,
        reflectiveExamples,
        references,
        additionalGuidance,
        previousValidationError,
        attempt,
      });
    },
  },
});
```

- `references` are ordered, in-memory, trusted inputs to proposal generation. They are not runtime agent skills, tools, filesystem paths, or persisted optimized-program data.
- `additionalGuidance` augments the built-in proposal contract; it does not replace component constraints.
- `maxExamples` bounds the ordered reflective examples passed to each proposal. It does not change the training or held-out evaluation sets. `maxExamples: 0` keeps an empty example list; the built-in policy still calls the teacher and omits the optional `reflectiveExamples` field instead of injecting a dummy example or failing required-input rendering.
- A custom `policy` proposes text only. GEPA deterministically enforces component-owned `maxLength`, `preserve`, and `validate` before metric-based acceptance. `format` and natural-language `constraints` are proposal context, not deterministic checks unless the component's `validate` function enforces them.
- Returning `undefined` keeps the current component value. Invalid proposals are retried with `previousValidationError`; exhausted retries also keep the current value.
- The same `gepaProposal` option is available on `AxGEPA.compile(...)`, `optimize(...)`, and `agent.optimize(...)`.
- The built-in policy diagnoses failures, derives general rules, preserves successful behavior and required literals, and explicitly rejects memorizing example entities, quantities, dates, phrases, or answers.

### When References Help and Their Limits

- References help when sparse reflective examples omit a stable domain-wide definition, procedure, output convention, or safety rule that should transfer to unseen inputs.
- References add little when they repeat the current instruction or feedback, are unrelated to the selected component, or contain rules the metric cannot observe. Irrelevant or conflicting references can reduce proposal quality while increasing prompt tokens.
- Treat references as trusted prompt content. Delimiters provide structure, not isolation: stale, contaminated, or prompt-injecting content can steer the proposer. Validate provenance, select the smallest relevant material, and do not include secrets merely because references are omitted from saved optimization artifacts.
- Held-out evaluation limits example memorization only when the holdout is genuinely independent. Shared entities, leaked labels, or the same contaminated reference in both proposal and evaluation design can hide overfitting.

### Reproducible Hill-Climb Evaluation

Run the zero-cost controlled gate from the repository root:

```bash
node --import=tsx src/examples/gepa-proposal-policy-eval.ts
```

The deterministic teacher deliberately emits three candidates: a training-entity lookup, a reference-informed general rule, and a no-benefit rewrite. This validates optimizer mechanics and generalization gating, not real-model efficacy. The checked result is:

| Run | Candidate behavior | Selected held-out score | Metric calls | Selection |
| --- | --- | ---: | ---: | --- |
| Baseline GEPA | Memorized candidate scores 1.00 train / 0.25 held-out | 0.75 | 16 / 16 | Train-local candidate accepted; held-out selection keeps baseline |
| Reference-informed | General rule scores 1.00 train / 1.00 held-out | 1.00 | 16 / 16 | Candidate accepted and selected |
| Irrelevant reference | Rewrite gives no train benefit | 0.75 | 12 / 12 | Candidate rejected; baseline retained |

Measured controlled overhead: baseline and reference-informed runs each make two teacher calls, so references add no proposal calls or metric calls. The rendered reference block is 307 characters. The bounded informed proposal prompt is 3,763 characters versus 3,544 for the unbounded baseline prompt: a net 219-character increase even after `maxExamples: 1` removes three reflective examples. Character counts are a reproducible payload measure, not provider token or latency estimates.

To sample actual proposer behavior with a current inexpensive model, opt in explicitly:

```bash
OPENAI_APIKEY=... node --import=tsx src/examples/gepa-proposal-policy-eval.ts --real
```

This command is not part of the zero-cost gate and should not be run unintentionally. It is bounded to two one-trial runs, at most six `gpt-5.4-mini` teacher calls including validation retries, and 32 deterministic metric calls. Use repeated seeds and representative private holdouts before making an efficacy claim.

## Causal Candidate Evidence

Use `axAttachCausalCandidateEvidence(...)` after an independently evaluated
candidate when an optimized artifact must retain why a change was proposed,
what it was expected to change, and what actually happened. This is an
optional artifact/audit boundary; it does not alter GEPA proposal, scoring,
selection, or promotion.

```typescript
import {
  axAttachCausalCandidateEvidence,
  axFingerprintCausalEvidence,
} from '@ax-llm/ax';

const [failureFingerprint, beforeFingerprint, afterFingerprint] =
  await Promise.all([
    axFingerprintCausalEvidence(redactedFailure),
    axFingerprintCausalEvidence(beforeInstruction),
    axFingerprintCausalEvidence(afterInstruction),
  ]);
const audited = axAttachCausalCandidateEvidence(result.optimizedProgram!, [
  {
    id: 'grounding-claim-1',
    sequence: 0,
    eventKind: 'candidate_decision',
    candidateId: 'c1', // may reference an optimizer/lineage ID
    evidence: [
      {
        id: 'failed-eval-17',
        kind: 'failure',
        fingerprint: failureFingerprint,
      },
    ],
    hypothesis: 'The responder instruction omits the grounding requirement.',
    affectedComponents: [
      {
        componentId: 'responder::instruction',
        surface: 'instruction',
        beforeFingerprint,
        afterFingerprint,
      },
    ],
    predictedBenefit: [
      {
        metric: 'accuracy',
        split: 'held_out',
        expectedDirection: 'increase',
        minimumExpectedDelta: 0.05,
        confidence: 0.7,
      },
    ],
    predictedRegressions: [],
    outcome: {
      heldIn: {
        metrics: [{ metric: 'accuracy', before: 0.6, after: 0.8, sampleCount: 50 }],
      },
      heldOut: {
        metrics: [{ metric: 'accuracy', before: 0.62, after: 0.7, sampleCount: 50 }],
      },
    },
    decision: { status: 'promoted', reason: 'Held-out gain met the gate.' },
  },
], {
  authority: {
    principalId: hostPrincipalId,
    evaluatorId: evaluatorVersion,
    verifierId: receiptVerifierId,
    receiptId,
    receiptVersion: '1',
  },
  // Verify that receiptId covers the canonical payload and authority above.
  // The third argument is 'issue' during attach and 'replay' during deserialize.
  verifyAuthority: verifyReceipt,
});
```

The returned artifact is new; the original is unchanged. Repeated attachment
appends records and rejects duplicate IDs or retention overflow instead of
rewriting or silently dropping prior receipts. Use
`axReplaceOptimizedProgramSnapshot(current, replacement, verifyReceipt)` for
rollback or replacement: it takes the rewindable component/demo/model snapshot
from `replacement` while carrying the current evidence history byte-for-byte.
It rejects a replacement with divergent history. Append a `settlement` event
whose `settlesRecordId` names the prior promoted decision afterward. Sequences
are zero-based and monotonic; every later record names its immediately preceding
`parentRecordId`. A candidate has one decision and a promoted decision can be
settled only once. This is one artifact history, not a runtime event journal.
Each append retains its prior authority receipt and adds a new receipt that
binds the complete prior receipt chain plus the enlarged record prefix. The
verifier supplied for append/replay must verify every authority in that chain;
an unknown prior receipt fails closed.

The manifest is recursively frozen and survives
`axSerializeOptimizedProgram(...)` /
`axDeserializeOptimizedProgram(serialized, { causalEvidenceVerifier })`.
Deserialization revalidates schema, privacy metadata, fingerprints, links, and
every manifest field against host-owned receipts. It first takes one detached
JSON snapshot, then validation, canonicalization, verification, freezing, and
return all consume only that snapshot, so verifier side effects cannot alter the
authorized return value. Evidence IDs are globally
bound to one kind and fingerprint within a manifest. Prediction metric/split
keys and outcome metric names are unique, thresholds are non-negative, and
predictions must have a matching observed metric on the same split. Both
held-in and held-out receipts are required. Optional ablation/counterfactual
receipts must name affected components, report both splits, and use exactly the
candidate outcome metric sets.

Raw examples and traces have no field in the schema. Evidence is linked by a
caller-owned ID and fingerprint. Evidence and ablation summaries are omitted by
default; `includeEvidenceSummaries: true` retains them with a configurable
character bound. Other free-text fields (including hypothesis, reason, and IDs)
are bounded but not redacted, so callers must apply host policy before attaching
them. Records, per-field items, strings, and total UTF-8 artifact bytes are
bounded. `await axFingerprintCausalEvidence(...)` produces a canonical NFC
UTF-8 SHA-256 identifier. It is not a redaction function; redact before
fingerprinting if the input itself will be logged elsewhere. SHA-256 is the only
accepted identity form; weak legacy hashes must stay separate metadata.
Malformed UTF-16 (including unpaired surrogates) is rejected before NFC/UTF-8
conversion so distinct malformed strings cannot collapse to U+FFFD.

The host/evaluator is authoritative for evidence identity, split independence,
metric correctness, contamination controls, decision policy, and attribution.
The required verifier must authenticate principal, evaluator, receipt, and
receipt-version bindings outside Ax. Ax validates structural links but does not
prove the hypothesis, infer an ablation result, establish split independence,
or prevent an authorized host from supplying misleading evidence. Keep
rejected, no-benefit, regression, and contradictory records rather than
retaining only promoted candidates.

Deterministic zero-cost mechanism evaluation:

```bash
npm run evaluate:causal-candidate-evidence
```

The fixed three-case fixture includes helpful, no-benefit, and misleading
hypotheses. It measures causal audit completeness (legacy artifact `0`, attached
manifest `1`), held-out threshold attainment (`1/3`) and confidence-vs-threshold
Brier score (`0.4467`), derived ablation-attribution consistency (`3/3`), exact
serialization/replay, exact rollback-history preservation, settlement append,
default evidence-summary omission, SHA-256 separation of a known FNV collision,
rejection of malformed UTF-16, forged manifest counts, and invalid chronology,
post-verification mutation isolation, and prior receipt preservation. The command
also reports artifact bytes (`201` baseline, `6,421` attached; `6,220` bytes
overhead in the fixture). It makes zero provider calls, uses zero provider
tokens, costs `$0`, and has a 1,000 ms wall-time gate. These are deterministic
mechanism/self-consistency measurements, not independent causal proof,
population calibration, or evidence that the candidate or model quality
improves in production.

## Experimental Program-Source Optimization

Use `programSource(signature, options)` when the complete implementation and
control flow should be one GEPA component instead of only tuning instruction
strings. It exposes `<program-id>::program-source` while preserving ordinary
instruction, description, tool, primitive, and descendant components.

```typescript
import { optimize, programSource } from '@ax-llm/ax';

const program = programSource(
  'ticketText:string -> priority:class "urgent, normal", rationale:string',
  {
    tools: [classifyUrgency],
    maxPredictorCalls: 4,
    maxToolCalls: 2,
    maxIterations: 48,
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

Critical rules:

- The source format is the strict `ax-program-source/v1` JSON AST, not
  JavaScript, TypeScript, or Python.
- The seed is one `$program` predictor plus a typed return.
- Allowed statements are `predict`, `tool`, `if`, `forEach`, and final
  top-level `return`. Allowed expressions are `literal`, `ref`, `object`,
  `array`, `eq`, `select`, `not`, `and`, `or`, and `concat`.
- Every used predictor/tool capability must be declared in source and allowed
  by the host constructor. Source cannot select models or acquire new tools.
- Candidate constraints include the task, immutable signature, tool schemas,
  complete grammar, and predictor/tool/iteration/continuation budgets.
- Parse/bind errors reject the candidate. Runtime and strict typed-output
  errors become aligned per-example zero scores during direct GEPA evaluation.
  Only program-source validation errors receive config-error alignment;
  ordinary component apply failures still propagate in mixed trees.
- Declared input data properties, immutable predictor request snapshots
  (metadata, input, and selected host tool descriptions/schemas), tool
  arguments/results, and outputs must fit configurable JSON byte/depth/width
  limits before host dispatch. Undeclared caller properties are excluded;
  accessors and unstable Proxy inspection fail closed. Original runtime/tool
  objects are not reread after capture. Static source limits are cumulative;
  tighter bridge limits win. The default Node worker also has heap/stack
  ceilings.
- Timeout, abort, and close revoke the execution epoch. Late bridge completions
  are rejected and recorded, but an already-dispatched external tool/provider
  effect remains host-owned and cannot be undone by worker termination.
- Custom runtimes require JavaScript plus the explicit
  `ax-program-source-runtime/js-v1` protocol declaration. This is a compatibility
  assertion, not proof of isolation, authority, persistence, or resource policy;
  use the default runtime for the documented worker policy.
- Save source state with `dumpState()` / `loadState()`, or preserve it inside a
  normal serialized optimized artifact's `componentMap`.
- Causal evidence attachment treats the program-source value as an opaque
  `componentMap` string. Use the exact `<program-id>::program-source` component
  ID and the optimizer candidate/lineage ID in the host-authored evidence
  record. Serialization and replay preserve both; snapshot replacement swaps
  the rewindable source string while retaining verified evidence history, and a
  later settlement appends to that history without rewriting the prior record
  or candidate identity.
- Do not add host `eval`, `Function`, imports, filesystem, process, network, or
  ambient globals to make a proposal work. Narrow the AST or use an explicit
  host tool instead.

Good fits are typed LM decomposition, bounded predictor/tool routing,
deterministic branches, field assembly, and bounded list mapping. Unsupported
cases include arbitrary computation/modules, recursion/unbounded loops,
dynamic capabilities/models, persistent mutable source state, nested returns,
and intermediate token streaming.

The checked-in hill climb is deterministic zero-cost mechanism evidence: a
train memorizer is rejected on validation data, a general tool source is
promoted, a frozen final test is reported only after selection, and a redundant
source is rejected against a perfect seed. Run:

```bash
node --import=tsx src/examples/program-source-evaluation.ts
npx vitest run src/ax/dsp/programSource.test.ts src/ax/dsp/programSourceEvaluation.test.ts src/ax/dsp/optimizers/gepaEvaluation.test.ts
```

The optional paid smoke is bounded to one trial/eight metric calls and requires
explicit acknowledgement:

```bash
OPENAI_APIKEY=... node --import=tsx src/examples/program-source-evaluation.ts --paid --ack-paid-calls
```

See `docs/PROGRAM_SOURCE.md` for the complete grammar, security boundary,
supported task classes, exact evidence report, and limitations.

## Metric Selection

Choose the evaluation path deliberately:

- Prefer a deterministic metric when correctness can be read directly from `prediction` and `example`.
- Prefer a deterministic metric when cost, latency, recursion depth, or tool count matters.
- Use a plain typed `AxGen` evaluator only when the task is genuinely qualitative and hard to score exactly.
- For `agent.optimize(...)`, prefer the built-in judge path instead of manually wrapping a judge metric. Normal agent users usually do not need to set `target` or `metric` at all.

Rule of thumb:

- `optimize(...)` on `AxGen` or flow: use a metric first, optionally a plain typed `AxGen` evaluator if needed.
- `agent.optimize(...)`: use custom `metric` for crisp scoring, otherwise let the built-in judge handle scoring. Add `judgeAI` plus `judgeOptions` only when you want a stronger or separate judge model.

## Canonical Scalar Pattern

```typescript
import { ai, ax, optimize, AxAIOpenAIModel } from '@ax-llm/ax';

const student = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

const teacher = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54 },
});

const classifier = ax(
  'emailText:string -> priority:class "high, normal, low", rationale:string'
);

const train = [
  { emailText: 'URGENT: Server down!', priority: 'high' },
  { emailText: 'Weekly newsletter', priority: 'low' },
];

const validation = [
  { emailText: 'Invoice overdue', priority: 'high' },
  { emailText: 'Lunch plans?', priority: 'low' },
];

const metric = ({ prediction, example }: { prediction: any; example: any }) =>
  prediction?.priority === example?.priority ? 1 : 0;

const result = await optimize(classifier, train, metric, {
  studentAI: student,
  teacherAI: teacher,
  numTrials: 12,
  minibatch: true,
  minibatchSize: 4,
  earlyStoppingTrials: 4,
  sampleCount: 1,
  validationExamples: validation,
  maxMetricCalls: 120,
});

classifier.applyOptimization(result.optimizedProgram!);
console.log(result.bestScore);
```

## Canonical Pareto Pattern

```typescript
import { ai, flow, optimize, AxAIOpenAIModel } from '@ax-llm/ax';

const student = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

const teacher = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54 },
});

const wf = flow<{ emailText: string }>()
  .n('classifier', 'emailText:string -> priority:class "high, normal, low"')
  .n(
    'rationale',
    'emailText:string, priority:string -> rationale:string "One concise sentence"'
  )
  .e('classifier', (state) => ({ emailText: state.emailText }))
  .e('rationale', (state) => ({
    emailText: state.emailText,
    priority: state.classifierResult.priority,
  }))
  .r((state) => ({
    priority: state.classifierResult.priority,
    rationale: state.rationaleResult.rationale,
  }));

const train = [
  { emailText: 'URGENT: Server down!', priority: 'high' },
  { emailText: 'Weekly newsletter', priority: 'low' },
];

const validation = [
  { emailText: 'Invoice overdue', priority: 'high' },
  { emailText: 'Lunch plans?', priority: 'low' },
];

const metric = ({ prediction, example }: { prediction: any; example: any }) => {
  const accuracy = prediction?.priority === example?.priority ? 1 : 0;
  const rationale = typeof prediction?.rationale === 'string'
    ? prediction.rationale
    : '';
  const brevity = rationale.length <= 40 ? 1 : rationale.length <= 80 ? 0.5 : 0.1;
  return { accuracy, brevity };
};

const result = await optimize(wf, train, metric, {
  studentAI: student,
  teacherAI: teacher,
  numTrials: 16,
  minibatch: true,
  minibatchSize: 6,
  earlyStoppingTrials: 5,
  sampleCount: 1,
  validationExamples: validation,
  maxMetricCalls: 240,
});

for (const point of result.paretoFront) {
  console.log(point.scores, point.configuration);
}

wf.applyOptimization(result.optimizedProgram!);
console.log(result.optimizedProgram?.componentMap);
```

## Metric Patterns

```typescript
import type { AxMetricResult } from '@ax-llm/ax';

// Scalar objective
const scalarMetric = ({ prediction, example }) =>
  prediction.answer === example.answer ? 1 : 0;

// Multi-objective
const multiMetric = ({ prediction, example }) => ({
  accuracy: prediction.answer === example.answer ? 1 : 0,
  brevity:
    typeof prediction?.reasoning === 'string' &&
    prediction.reasoning.length < 120
      ? 1
      : 0.2,
});

// Scalar acceptance + qualitative reflection + named Pareto objectives
const qualitativeMetric = ({ prediction, example }): AxMetricResult<
  'accuracy' | 'brevity'
> => {
  const correct = prediction.answer === example.answer;
  return {
    score: correct ? 1 : 0,
    feedback: correct
      ? 'The answer matches the reference.'
      : `Expected ${example.answer}; ground the answer in the supplied context.`,
    scores: {
      accuracy: correct ? 1 : 0,
      brevity: prediction.answer.length < 120 ? 1 : 0.25,
    },
  };
};
```

- `AxMetricResult.score` controls scalar candidate acceptance, perfect-score checks, and bootstrap thresholds. Named `scores` feed the existing objective vectors and Pareto frontier; they are not averaged back into scalar acceptance. `result.bestScore` keeps Ax's existing convention of scalarizing the selected Pareto score vector.
- If structured `scores` is absent or has no finite values, GEPA uses `{ score }` as the score vector.
- `feedback` is optional. Whitespace-only or non-string feedback is ignored; accepted text is trimmed, stripped of unsafe control characters, and capped at 4,000 characters. No hidden model call is made.
- Metric feedback remains aligned with each example's prediction, score vector, scalar, and captured trace. Rollout failures retain an aligned zero-score row without metric feedback.
- `feedbackNotes`, per-example metric `feedback`, and `feedbackFn` are additive. Global notes are rendered first; within each example, the numeric score context is followed by metric feedback and then `feedbackFn` text.
- Return plain numbers or plain object literals; use `AxMetricResult` only when its explicit scalar/feedback distinction is useful.
- Keep objective names stable across calls.
- Prefer normalized scores such as `0..1` so trade-offs are easy to reason about.

## Result Handling

```typescript
const { optimizedProgram, paretoFront } = result;

program.applyOptimization(optimizedProgram!);

// Save for later
const saved = JSON.stringify(optimizedProgram);

// Load later and re-apply
const loaded = JSON.parse(saved);
program.applyOptimization(loaded);
```

- Single-target runs usually populate both `optimizedProgram.instruction` and `optimizedProgram.componentMap`.
- Tree-wide runs rely on `componentMap`, keyed by full component key.
- Pareto points expose candidate configs under `point.configuration.componentMap`.

## Candidate Lineage and Decision Audit

GEPA artifacts can include a versioned `optimizedProgram.candidateLineage`
manifest. Lineage is default-off: omitted or `false` preserves legacy artifacts,
logger events, progress history, and checkpoint behavior. Set it to `true` for
defaults or pass an options object to enable and configure it. Only an own data
property opts in; inherited properties and accessors are ignored at this
boundary rather than invoked. Compile options are supported as ordinary
objects, not JavaScript `Proxy` objects. Reflection on a `Proxy` necessarily can
invoke its meta-object traps. GEPA normalizes a throwing
`getOwnPropertyDescriptor` while inspecting the own `candidateLineage` or
`abortSignal` property before candidate evaluation. Arbitrary Proxy traps are
unsupported: other stateful or throwing traps can run or fail later, including
after candidate evaluation has started.
It records every retained seed, reflective mutation, and system merge with a
stable run-local ID, parent IDs, round and strategy, component delta
fingerprints, evaluation objectives and metric-call context, final decision and
reason, Pareto/archive disposition, and fingerprinted validator/runtime failures
when available. Rejected and budget-aborted proposals are retained; this does
not change candidate selection or claim to improve model quality. It improves
auditability and reproducibility of the optimization search.

The default manifest is privacy-minimizing and bounded:

- component values (including prompts) and failure messages are identified
  with a SHA-256 digest truncated to 64 bits (`sha256-64:<hex>`), not stored.
  That identifier is collision-resistant enough for lineage correlation and is
  not a confidentiality control; raw values remain omitted unless explicitly
  opted in;
- examples, traces, predictions, references, demos, and credentials are never
  copied into lineage records;
- at most 1,000 records and 64 changed components per record are retained;
- final UTF-8 serialized size is capped at 1 MB by default. Byte-bound
  trimming keeps the seed, the newest retained record, and the selected
  candidate when possible, dropping middle history first;
- once `maxRecords` is reached, later records are counted in
  `omittedRecordCount` rather than retained, preserving parent integrity among
  retained records.

Configure or disable it per compile:

```typescript
const result = await optimize(program, train, metric, {
  studentAI,
  teacherAI,
  maxMetricCalls: 120,
  candidateLineage: {
    maxRecords: 500,
    maxArtifactBytes: 500_000,
    maxComponentsPerCandidate: 32,
    // Explicit privacy opt-ins; leave false for production defaults.
    includeComponentValues: false,
    includeFailureMessages: false,
  },
});

const manifest = result.optimizedProgram?.candidateLineage;
```

Omit `candidateLineage` or set it to `false` to disable all lineage collection
and publication work. Opted-in values and messages remain bounded by
`maxComponentValueChars` and `maxFailureMessageChars`. Finite numeric limits are
clamped as follows: records 1–10,000; final artifact bytes 4,096–10,000,000;
components per record 1–1,024; component value characters 1–10,000; failure
message characters 1–2,000.
Published manifests and their nested records are cloned and recursively frozen.
The final manifest is available in both the artifact and the existing
`OptimizationComplete.bestConfiguration.candidateLineage` logger callback; these
are byte-for-byte equivalent after JSON serialization. This does not add a new
logger event variant, so exhaustive consumers of `AxOptimizerLoggerData` remain
source-compatible. GEPA emits that completion callback and a final checkpoint
only when lineage is explicitly enabled; disabled runs retain legacy event and
checkpoint count, order, payloads, and timing. Opted-in `RoundProgress` and
periodic checkpoints retain all legacy fields and add candidate metadata. The
executable differential check runs the same omitted/`false` fixture against the
PR checkout and its `origin/main` merge base, including logger events,
checkpoint payloads/history, selection, the complete serialized optimized
artifact, and its public serialize → deserialize → reserialize round trip.

Lineage also appears in checkpoint `optimizerState` as a **snapshot only** with
`checkpointSemantics: 'snapshot_only'` and `stoppedReason: 'in_progress'`.
`AxGEPA` does not reconstruct candidates, archive state, counters, or RNG state
from that snapshot, so this feature does not provide checkpoint resume. Older
artifacts and checkpoints without the optional field continue to load unchanged.

`termination` records where a completed run stopped, including loop-boundary and
parent-evaluation budget/abort paths that occur before a proposal exists. Such
paths do not synthesize fake candidate records. An abort already active before
the seed evaluation rejects compilation and therefore produces no artifact.
`AxCompileOptions.abortSignal` is GEPA-scoped; other optimizers do not implement
or promise this cancellation behavior.
When byte/record retention omits the selected candidate, the manifest keeps its
ID and sets `selectedCandidateRetained: false`; retained Pareto IDs only name
retained records.

The reproducible stress/fault benchmark checks exact agreement between the final
logger callback and artifact across accepted, rejected, merged, runtime-faulted,
abort-signal, and budget-exhausted candidates. It also checks loop-boundary and
parent-evaluation termination, parent integrity, deterministic same-seed rerun
serialization, runtime freezing, default redaction, exact final UTF-8 byte
truncation with Unicode/escaping and 81 generated decisions, and selected-record
omission. Its no-selection-change claim is scoped to the deterministic synthetic
fixture. Because its no-op baseline intentionally magnifies fixed serialization
cost, it compares enabled lineage to the default omitted, legacy-compatible
path. It reports an initial 10-run cold pair, then warms each mode for 50 runs
and measures nine paired samples of 500 runs. Each sample alternates mode order
in ten-run chunks so scheduler/JIT drift does not consistently favor the tiny
baseline while timer overhead remains amortized. Always-on CI runs the completeness, integrity, privacy, and size
invariants only. The p75 paired runtime overhead gate (at most 3.5× its
paired baseline and at most 0.5 ms per fixture run) is opt-in via
`AX_GEPA_LINEAGE_TIMING=1` or `AX_PRINT_METRICS=1` so shared CI cannot flake
on wall-time jitter. Output includes the cold pair and full warm
baseline/lineage ranges so variance remains visible:

```bash
npm run benchmark:gepa-lineage
npx vitest run scripts/gepa-lineage-benchmark.test.ts
npm run test:gepa-upstream-compatibility
```

Set `GEPA_COMPAT_BASE=<commit-or-ref>` to compare another authoritative base.

## Useful Options

```typescript
const optimizer = new AxGEPA({
  studentAI,
  teacherAI,
  numTrials: 20,
  minibatch: true,
  minibatchSize: 5,
  minibatchFullEvalSteps: 5,
  earlyStoppingTrials: 5,
  minImprovementThreshold: 0,
  sampleCount: 1,
  seed: 42,
  verbose: true,
});
```

- `numTrials`: number of reflection/evolution rounds.
- `minibatch`: reduce per-round evaluation cost.
- `minibatchSize`: examples per minibatch.
- `earlyStoppingTrials`: stop after repeated non-improvement.
- `minImprovementThreshold`: reject tiny gains below this threshold.
- `seed`: stabilize sampling during demos and tests.

## Budgeting and Validation

- Always create distinct `train` and `validationExamples` arrays.
- Size `maxMetricCalls` for at least one full validation pass plus several rounds.
- If the user wants a strict budget, say so explicitly and set `maxMetricCalls`.
- For expensive trees, start with `auto: 'light'` or fewer `numTrials`, then scale up.
- GEPA selects among exposed components using measured accept/reject history, not LLM-generated numeric scores. The LLM proposes component text; metrics decide whether to keep it.
- Function/tool trace reflection is keyed by stable component IDs where available, so function renames do not break saved candidate maps.

## Qualitative Feedback Evaluation

Run the deterministic end-to-end comparison with:

```bash
npx vitest run src/ax/dsp/optimizers/gepaQualitativeEvaluation.test.ts
```

The test holds train and held-out examples constant between a numeric-only metric and a structured metric. A deterministic zero-cost proposer reads only the reflective training rows: useful feedback changes the proposal and raises held-out accuracy from `0.5` to `1.0`; empty feedback matches the numeric baseline; misleading feedback proposes a worse rule that metric acceptance rejects; and an already-perfect program skips reflection. It also asserts the optimizer stays within `maxMetricCalls` and that held-out questions never enter the reflective dataset. This is reproducible evidence for the feedback transport/selection mechanism, not evidence that an arbitrary real teacher model will improve quality.

An optional paid smoke comparison uses `gpt-5.4-mini`, one trial per arm, at most 8 optimizer metric rollouts per arm, four final held-out rollouts, and at most four reflection calls across both arms (at most 24 model calls total):

```bash
AX_RUN_LIVE_QUALITATIVE_GEPA_EVAL=1 npm run tsx src/examples/gepa-qualitative-feedback-live-eval.ts
```

Do not run it in normal CI. The explicit environment gate prevents accidental paid execution. Qualitative feedback helps only when it contains generalizable information the proposer can act on and the scored train/held-out gate rewards the resulting behavior. Empty feedback supplies no proposal signal; misleading feedback can waste proposal budget; sparse or contaminated evals can select non-generalizing changes; and named objectives still require stable, meaningful scales.

## Troubleshooting

- Error about `maxMetricCalls` being too small: increase it until the initial validation pass fits.
- Empty or poor Pareto front: verify the metric returns numbers for every example.
- No tree optimization effect: ensure child programs are registered under the root and expose optimizable components.
- Saved optimization applies only partly: use `program.applyOptimization(...)`, not just `setInstruction(...)`, so `componentMap` reaches the full tree.
- Agent target seems too broad: when using `agent.optimize(...)`, set `target: 'actor'`, `'responder'`, `'all'`, or explicit program IDs. The wrapper filters GEPA components to the selected target.

## Good Example Targets

- `/Users/vr/src/ax/src/examples/optimize.ts`
- `/Users/vr/src/ax/src/examples/gepa.ts`
- `/Users/vr/src/ax/src/examples/gepa-flow.ts`
- `/Users/vr/src/ax/src/examples/gepa-train-inference.ts`
- `/Users/vr/src/ax/src/examples/gepa-quality-vs-speed-optimization.ts`
- `/Users/vr/src/ax/src/examples/axagent-gepa-optimization.ts`
