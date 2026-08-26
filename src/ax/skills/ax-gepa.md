---
name: ax-gepa
description: This skill helps an LLM generate correct AxGEPA optimization code using @ax-llm/ax. Use when the user asks about AxGEPA, GEPA, Pareto optimization, multi-objective prompt tuning, reflective prompt evolution, validationExamples, maxMetricCalls, or optimizing a generator, flow, or agent tree.
version: "__VERSION__"
---

# GEPA Optimization Codegen Rules (@ax-llm/ax)

Use this skill to generate GEPA optimization code. Prefer the top-level `optimize(...)` helper for normal code, and use direct `AxGEPA` / `AxBootstrapFewShot` only when the user needs low-level optimizer control.

## Use These Defaults

- Use `optimize(program, train, metric, { studentAI, teacherAI, ... })` for normal generator and flow tuning.
- Prefer `ai()`, `ax()`, and `flow()` for new code.
- Use a strong `teacherAI` and a cheaper `studentAI`.
- Pass `validationExamples` when you have a holdout set.
- Set `maxMetricCalls` to bound optimizer cost; `optimize(...)` defaults it to `100`.
- Use scalar metrics for one objective and object metrics for Pareto optimization.
- Apply results with `program.applyOptimization(result.optimizedProgram!)`.
- For tree-wide runs, expect `optimizedProgram.componentMap`.
- Persist artifacts with `axSerializeOptimizedProgram(...)` and restore them with `axDeserializeOptimizedProgram(...)` so the same flow works in browsers and Node.
- `optimize(...)` runs `AxBootstrapFewShot -> AxGEPA` for small starter sets by default, preserving the demos in `result.optimizedProgram.demos`.

## Critical Rules

- `optimize(...)` and `AxGEPA.compile()` work for a single generator and for tree-aware roots such as flows or agents with registered optimizable descendants.
- There is no separate flow-only GEPA optimizer. Use `AxGEPA` for flows too.
- The metric may return either `number` or `Record<string, number>`.
- Keep metrics deterministic and cheap by default.
- Avoid extra LLM calls inside the metric unless the user explicitly wants judge-based evaluation.
- If the user needs LLM-as-judge scoring for a non-agent GEPA run, prefer a plain typed `AxGen` evaluator instead of writing a custom judge abstraction.
- `maxMetricCalls` must be large enough to cover the initial validation pass over `validationExamples`.
- GEPA optimizes generic string components exposed by `getOptimizableComponents()`. If a tree exposes no components, optimization will fail.
- Use held-out validation examples for selection. Do not reuse the training set as `validationExamples`.
- `result.optimizedProgram` is the easy-to-apply best candidate. `result.paretoFront` is the full trade-off set for multi-objective runs.
- Direct `AxGEPA` still has its own `bootstrap` option, but top-level `optimize(...)` composes the existing `AxBootstrapFewShot` optimizer before GEPA instead.

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
```

- Return plain numbers or plain object literals.
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
