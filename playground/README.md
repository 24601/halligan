# Pry — the halligan playground

`@ax-llm/ax-playground` (private, never published). A single page where every
panel is a live halligan subsystem executing in the reader's own tab against a
deterministic seed. The numbers on screen are read out of the real objects; none
of them is typed into a fixture.

Deployed to <https://24601.github.io/halligan/> by
`.github/workflows/playground.yml`.

## Running it

Installs happen from the repository root, per `AGENTS.md`:

```bash
npm install --workspace=@ax-llm/ax-playground        # from the repo root
npm run dev       --workspace=@ax-llm/ax-playground  # http://localhost:5273
npm run build     --workspace=@ax-llm/ax-playground
npm run typecheck --workspace=@ax-llm/ax-playground
npm run e2e       --workspace=@ax-llm/ax-playground  # needs `npm run e2e:install` once
```

## Rules this package lives by

- **It imports the working tree, not a package.** `vite.config.ts` aliases
  `@ax-llm/ax` to `../src/ax/index.ts`, so the site builds from this fork and
  goes stale the moment the fork changes.
- **`@ax-llm/ax-tools` is never imported.** That package is the node-only
  boundary; the `pry-no-node-specifiers` build plugin fails the build if a
  `node:` specifier reaches the emitted bundle, and the deploy workflow greps
  `dist/assets` for one as a second, independent check.
- **Credentials, when a later lane adds them, live in `localStorage` only** and
  are sent to exactly one configured origin. Nothing is ever committed.
- **Every figure carries its provenance.** Telemetry chips over the stage, an
  evidence drawer (`I`) under it, and an unmeasured value renders as an
  em-dash — never `$0.00`, never red.
- **Determinism.** `Math.random` is not called in demo code; a seed is threaded
  explicitly and lives in the URL, and clocks are `AxManualEventClock`.

## Coexisting with the Hugo site

`website/` belongs to upstream `ax-llm/ax` and deploys `axllm.dev`. Pry must
never claim that name, favicon or wordmark, and:

1. **`ci.yml` is never edited by playground work.** Pry's gates live in
   `playground.yml`.
2. **Nothing here writes into `website/`.**
3. `playground.yml` takes `concurrency: { group: pages }`, so if upstream's Hugo
   deploy is ever merged down, the two queue against the same `github-pages`
   environment rather than racing — and the conflict is visible immediately.

## Lane map

| Lane | Owns |
|---|---|
| L1 | scaffold, design system, deploy workflow, D1 Mind + hero (this PR) |
| L2 | D2 Effects |
| L3 | D3 Evolve, D4 GEPA |
| L4 | D7 Execution console |
| L5 | D5 Working state, D6 Provenance, D9 Reactive cells |
| L6 | `coverage.json` gate, changelog, the weekly refresh routine |

The seams a later lane plugs into: `src/lib/demos.ts` (typed registry, one entry
per demo, lazy `view`), `src/viz/DemoLayout.vue` (the three zones: stage, deck,
ledger), `src/lib/chips.ts` (the telemetry-chip API), `src/lib/ui.ts`
(`publishEvidence` for the drawer, the HUD coordinate readout, theme), and
`e2e/contract.ts` (the shared assertions every demo spec runs).
