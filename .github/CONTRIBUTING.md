# Contributing to Halligan

Halligan is a focused downstream fork and does not accept external pull
requests. Please propose generally useful Ax changes to the
[upstream repository](https://github.com/ax-llm/ax).

## Tests and evaluation

Every behavioral feature or change must include all applicable static, type,
unit, and integration tests, plus a meaningful and truthful evaluation suited
to the claim:

- Claimed outcome improvement: a held-out hill-climbing comparison against a
  declared baseline.
- Latency or cost: a reproducible benchmark against a declared baseline.
- Recovery or durability: fault injection covering the claimed failure mode.
- Infrastructure: audit-fidelity and overhead checks.

For each evaluation, declare the baseline and bound calls, tokens, wall-clock
time, and cost. Preserve and report negative or regression results. Include the
exact commands and artifacts needed to reproduce the result, where the change
helps and does not help, and its limitations and safety assumptions. Do not
hard-code outcomes, mutate an evaluator or hidden test, or make claims beyond
the evidence.

Paid provider calls are not required in CI. Deterministic, zero-cost mechanism
evaluations are valid when they support the stated claim; bounded live
evaluations may be run optionally. Keep the claim scoped honestly to the
evidence actually collected.

Documentation-only, typo-only, and mechanical metadata changes may mark an
outcome evaluation as not applicable, but must explain why instead of inventing
one. Applicable static checks still run.
