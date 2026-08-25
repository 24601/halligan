- **What kind of change does this PR introduce?** (Bug fix, feature, docs update, ...)

- **What is the current behavior?** (You can also link to an open issue here)

- **What is the new behavior (if this is a feature change)?**

- **Tests**:
  List the exact commands run and results. Behavioral features and changes require all applicable static, type, unit, and integration tests.

- **Evaluation**:
  Behavioral features and changes require a meaningful, truthful evaluation suited to the claim.
  - Claim and declared baseline:
  - Method (use a held-out hill-climbing comparison for claimed outcome improvement; a reproducible benchmark for latency/cost; fault injection for recovery/durability; or audit-fidelity and overhead checks for infrastructure):
  - Bounded budget (calls, tokens, wall-clock time, and cost):
  - Exact commands and artifacts:
  - Results, including negative or regression results:
  - Where it helps / does not help:
  - Limitations and safety assumptions:

  Do not hard-code outcomes, mutate evaluators or hidden tests, or make claims beyond the evidence. Paid provider calls are not required in CI: deterministic zero-cost mechanism evaluations are allowed, and bounded live evaluations are optional, with claims scoped to the evidence. Documentation-only, typo-only, or mechanical metadata changes may state why an outcome evaluation is not applicable rather than inventing one.

- **AxIR portable behavior check**:
  External contributors must submit handwritten TypeScript only. Do not commit AxIR or generated-language changes.
  If this changes portable TypeScript behavior, add a PR-bound entry with exact changed paths:
  `npm run axir:backlog -- add --title "..." --surface <surface> --impact "..." --paths <exact-ts-files> --pr <pull-request-number>`.
  Commit only the resulting `ir/axir-backlog.json` and `docs/AXIR_BACKLOG.md` alongside the TypeScript change.

- **Other information**:
