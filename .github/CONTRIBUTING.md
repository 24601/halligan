# Contributing to Ax

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

## External pull requests

Pull requests authored by anyone other than a GitHub organization `OWNER`,
`MEMBER`, or explicitly allowlisted maintainer identity are limited to
handwritten TypeScript. Allowed file extensions are `.ts`, `.tsx`, `.mts`, and
`.cts`.

Do not run AxIR generation or commit changes to AxIR, generated TypeScript,
Python, Java, C++, Go, Rust, generated examples, generated website files,
configuration, lock files, or documentation. If a non-TypeScript change is
useful, describe it in the pull request so a maintainer can recreate it on a
member-owned branch.

Portable TypeScript changes under `src/ax/ai/`, `src/ax/dsp/`,
`src/ax/agent/`, `src/ax/flow/`, `src/ax/mcp/`, or `src/ax/mem/` must add a new
open AxIR backlog entry tied to the pull request. List exact changed files, not
a parent directory:

```bash
npm run axir:backlog -- add \
  --title "Describe the portable behavior" \
  --surface <surface> \
  --impact "Describe how generated languages can drift" \
  --paths <exact-ts-files> \
  --pr <pull-request-number>
```

Commit both `ir/axir-backlog.json` and the rendered
`docs/AXIR_BACKLOG.md`. Existing backlog entries and non-portable exemptions
are maintainer-owned and must not be changed. The `axir-no-impact` escape hatch
does not apply to external pull requests.

The `External Contribution Policy` status runs automatically. If it fails,
remove the listed files or update the backlog entry; the policy comment and
status will refresh on the next push.
