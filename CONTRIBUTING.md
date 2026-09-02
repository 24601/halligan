# Contributing to Halligan

Halligan accepts contributions. It is a fork of [Ax](https://github.com/ax-llm/ax)
that adds bounded harness adaptation, so the first question on any change is
whether it belongs here or upstream. The rest of this document answers that,
then covers setup, the evidence rule, the copy rule, and what a pull request
needs.

## Where does your change belong?

| If your change touches | It belongs to |
| --- | --- |
| `src/ax/trajectory` (see `docs/TRAJECTORY.md`) | Halligan |
| `src/ax/mind` (see `docs/MIND.md`) | Halligan |
| `src/ax/learn` (see `docs/LEARNING_SURFACE.md`) | Halligan |
| Playbook evolve evidence discipline and GEPA evidence manifests (`docs/GEPA_EVIDENCE.md`) | Halligan |
| Skill provenance and host authority guards (`docs/SKILL_PROVENANCE.md`, `docs/HOST_AUTHORITY.md`) | Halligan |
| Verifier-gated working state (`docs/AGENT_WORKING_STATE.md`) | Halligan |
| Maintainer skills under `tools/*/skills` | Halligan |
| The Pry playground under `playground/` | Halligan |
| This repository's own README preface, governance files, and CI | Halligan |
| `src/ax/ai` providers and deployment profiles | Upstream Ax |
| `src/ax/dsp` signatures, generation, optimizers | Upstream Ax |
| `src/ax/agent`, `src/ax/flow`, `src/ax/mcp` | Upstream Ax |
| The AxIR toolchain under `tools/axir` and `ir/` | Upstream Ax |
| Generated packages under `packages/*` | Upstream Ax |

Portable Ax behavior should go to [ax-llm/ax](https://github.com/ax-llm/ax)
first. Halligan resynchronizes with upstream regularly and picks such changes up
on the next sync, which keeps the fork small and keeps the fix in front of every
Ax user rather than only ours.

Two exceptions. If upstream is slow and the bug is hurting Halligan users, open
the PR here and we will carry a downstream fix; we will also offer that fix
upstream and drop our copy when it lands. A fix that only makes sense given
something Halligan added, such as an authority check or an evidence guard
absent upstream, belongs here even when it sits in a file shared with Ax.

If you are not sure, open the issue or PR here and we will route it.

## Setup

Node.js 20 or newer. Install from the repository root, never inside a workspace
folder:

```bash
npm ci
```

The checks a PR is expected to pass:

```bash
npm run test --workspace=@ax-llm/ax
npm run test:format
npm run test:lint
npm run test:spelling
npm run test:copy-tells
```

`npm run test` at the root runs the full suite including the Halligan evaluation
scripts and the AxIR checks. It is slow; run it before asking for review on a
behavioral change.

`src/ax/index.ts` is generated. If you change exports, update the source export
and run `npm run build:index --workspace=@ax-llm/ax` rather than editing the
index by hand.

### The AxIR backlog rule

External contributors submit handwritten TypeScript only. Do not commit AxIR or
generated-language changes. When a PR changes portable behavior under
`src/ax/ai/`, `src/ax/dsp/`, `src/ax/agent/`, `src/ax/flow/`, or `src/ax/mcp/`,
CI asks for either AxIR and conformance updates or a backlog entry. Unless you
are already working in `ir/` or `tools/axir/`, take the backlog path:

```bash
npm run axir:backlog -- add --title "..." --surface axai --impact "..." --paths <exact-ts-files> --pr <pull-request-number>
npm run axir:backlog:validate
```

Commit only the resulting `ir/axir-backlog.json` and `docs/AXIR_BACKLOG.md`
alongside the TypeScript change.

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
outcome evaluation as not applicable. Say why rather than inventing one.
Applicable static checks still run.

## Copy rule

Prose in this repository has a house style and CI enforces part of it. Run it
before asking for review:

```bash
npm run test:copy-tells
```

The rule in full lives in
[`tools/copy/skills/anti-tell-copy/SKILL.md`](tools/copy/skills/anti-tell-copy/SKILL.md),
and the checker in `scripts/copy-tells-check.mjs` is the enforced subset. The
short version: no em dashes or en dashes anywhere, including commit messages and
PR bodies; no filler adjectives, padded verbs, three-item flourishes, false
contrasts, emoji headings, or paragraphs assembled out of bold-label bullets.
Write the specific thing you mean.

The checker covers `README.md`, `docs/`, `src/ax/skills/`, the playground, the
copy skills, and the root governance files. Some existing files carry deferred
findings owned by a later rewrite pass; do not add new ones.

## Pull requests

Fill in `.github/PULL_REQUEST_TEMPLATE.md`. It asks for the kind of change, the
current and new behavior, the exact test commands you ran with their results,
the evaluation, and the AxIR backlog entry when one applies.

Keep a PR to one coherent change. A refactor and a behavior change in the same
diff are hard to review and harder to revert.

Do not hand-edit generated files. Regenerate them:

```bash
npm run website:prepare       # website markdown mirrors
npm run axir:backlog:render   # docs/AXIR_BACKLOG.md
npm run build:index --workspace=@ax-llm/ax
```

## Licensing and sign-off

Halligan is licensed under Apache-2.0. There is no CLA. Under section 5 of the
license, a contribution you intentionally submit for inclusion in the work is
accepted under the terms of Apache-2.0 unless you say otherwise in writing, so
opening a pull request is enough. Do not add code you do not have the right to
contribute, and note the origin and license of anything you copy in from
elsewhere.

## AI-assisted contributions

Model-assisted work is welcome; most of this repository was written that way.
The condition is that you are accountable for the diff. Read every line you
submit, be able to explain why it is correct, and describe the evaluation
honestly, including what you did not run and what the result does not show. A PR
whose author cannot answer questions about its own code will be closed.
