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
- Use scalar metrics for one objective, object metrics for legacy Pareto optimization, or `AxMetricResult` when evaluation also has textual feedback.
- Apply results with `program.applyOptimization(result.optimizedProgram!)`.
- For tree-wide runs, expect `optimizedProgram.componentMap`.
- Persist artifacts with `axSerializeOptimizedProgram(...)` and restore them with `axDeserializeOptimizedProgram(...)` so the same flow works in browsers and Node.
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
