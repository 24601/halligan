# AxAgent TypeScript-only conformance

Fixtures here pin **core-owned TypeScript behaviour that has not been ported to
AxIR yet**. They are deliberately NOT in `ir/conformance/axagent/`, which every
generated language package enumerates and executes: a fixture for an unported
behaviour placed there would either fail every target (an unknown fixture kind)
or, worse, be reshaped until a target could "pass" it without implementing the
behaviour. Both outcomes are the fabrication the AxIR gates exist to prevent.

The pattern mirrors `ir/conformance/axagent-real/`: a directory outside the
target-enumerated suite list, executed by one dedicated runner.

| Fixture | Runner | Backlog entry |
|---|---|---|
| `working-state-commit.json` | `scripts/working-state-conformance.test.ts` (root `npm test` chain, as `test:workingstate-conformance`) | `axir-2026-09-02-verifier-gated-typed-working-state-for-the-actor-loop` |

When a behaviour here is migrated into AxIR, move its fixture into the
target-executed suite in the same change that makes every target able to pass
it, and close the backlog entry.
