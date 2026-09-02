# Security Policy

Halligan is a fork of [Ax](https://github.com/ax-llm/ax). Where a report goes
depends on whether the flaw is in code Halligan added or in Ax code we carry
unchanged. If you are not sure, report it to us and we will route it.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest published release | Yes |
| Anything older | No |

We do not backport fixes to earlier releases. Upgrade to the latest release or
to `main`.

## Reporting a vulnerability

Report privately through GitHub, not in a public issue:

https://github.com/24601/halligan/security/advisories/new

Private vulnerability reporting is enabled on this repository. Include the
affected version or commit, what an attacker gains, and the smallest
reproduction you have. A failing test or a trace is worth more than a
description.

### Reporting to us

Report to Halligan if the flaw is in a subsystem Halligan added:

- `src/ax/trajectory`, the append-only trajectory and its projection
- `src/ax/mind`, the persistent-agency runtime and its message ledger
- `src/ax/learn`, the learning surface, its receipts, and the release chain
- Playbook evolve evidence discipline and the GEPA evidence manifests
- Skill provenance and the host authority guards
- Verifier-gated agent working state
- The maintainer skills under `tools/*/skills`
- The Pry playground under `playground/` and its deployment

Also report to us anything in Halligan's own published packages once they
exist: npm `halligan`, PyPI `halligan-ax`, crates.io `halligan`, and Maven
`io.github.24601:halligan`.

### Reporting upstream

If the flaw is in Ax code that Halligan carries unchanged, including the
provider layer under `src/ax/ai`, `src/ax/dsp`, `src/ax/agent`, `src/ax/flow`,
`src/ax/mcp`, the AxIR toolchain, and the generated packages under `packages/*`,
report it to the Ax project through their security page:

https://github.com/ax-llm/ax/security

Upstream has no `SECURITY.md` at the time of writing, so the GitHub security
page is the reporting channel. You may report an upstream flaw to us as well,
privately, and we will ship a downstream mitigation while upstream works on the
real fix. Please do not open a public issue in either repository first.

## In scope

- Bypassing a host authority boundary described in `docs/HOST_AUTHORITY.md`
- Forging a receipt, a learning-surface release-chain entry, or a GEPA evidence
  manifest so it verifies when it should not
- Defeating an evidence guard so a working-state mutation or a playbook
  promotion commits without the evidence it requires
- Admitting a skill that provenance checks should have rejected, or escalating
  a skill's visibility tier
- Evading a credential tripwire, or getting a secret into a trajectory, a mind
  message, or a learning artifact where it should not appear
- Prompt-injection paths that reach host authority, meaning untrusted model or
  tool input that causes a privileged host effect without the host deciding
- Vulnerable dependencies pinned in our lockfile, with a description of how the
  vulnerable path is actually reached

## Out of scope

- Model output quality, hallucination, jailbreaks that produce bad text without
  crossing an authority boundary
- Provider outages, provider rate limits, and provider-side bugs
- Anything that requires an already compromised host, a malicious operator, or
  a local attacker who can edit the code or the environment
- `AxJSRuntime` sandbox escapes at the level described in
  [`docs/SECURITY.md`](docs/SECURITY.md): that runtime is defense in depth for
  model-authored code, not a container or VM boundary, and host callbacks plus
  granted permissions remain the authority boundary
- Missing hardening with no demonstrated impact, and automated scanner output
  without a reachable path

## What to expect

Halligan is maintained by one person, so this is what is honestly promised
rather than a service level agreement. We aim to acknowledge a report within a
few business days. We will tell you whether we consider it in scope, and if it
is, what we plan to do and roughly when. We prefer coordinated disclosure and
will agree a date with you rather than sitting on a report indefinitely. We
will credit you in the advisory if you want credit, under whatever name you
give us.

There is no bug bounty and no payment.
