# Runtime capabilities and conformance

Ax exposes an additive capability boundary for custom `AxCodeRuntime` and
`AxCodeSession` implementations. It uses the existing AxIR
`RuntimeCapabilities` vocabulary. It does not add an interpreter, sandbox, or
certification system.

## Declaration

A runtime may expose an `AxRuntimeCapabilities` declaration with:

- `inspect`, `snapshot`, `patch`, and `abort`
- actor-code `language`
- protocol `name` and `version`
- `persistence.session` and `persistence.restart`
- resource declarations for timeout, timeout enforcement, and memory
- ambient `authority` for host access, modules, and network: `denied`,
  `allowlist`, `unrestricted`, or `unknown`

These values are self-declared, untrusted metadata. They can support routing and
detect contradictions when compared with observations, but they do not prove
that a runtime enforces isolation or resource bounds. Adapter owners still own
interpreter choice, process/container policy, permissions, cancellation,
filesystem/network/module controls, package loading, and cleanup.

`AxJSRuntime` declares its effective constructor configuration. Its default
JavaScript execution behavior is otherwise unchanged.

## Selection

`axSelectCodeRuntime(candidates)` preserves existing blind behavior and selects
the first candidate, including a legacy runtime with no declaration.

Pass requirements to opt into capability-aware selection:

```ts
const { runtime } = axSelectCodeRuntime(candidates, {
  inspect: true,
  snapshot: true,
  abort: true,
  language: ['JavaScript', 'Python'],
  protocol: { name: 'ax-code-runtime', version: '1' },
  persistence: { session: true },
  resources: { maxTimeoutMs: 1_000, timeoutEnforcement: 'hard' },
  authority: { host: 'denied', modules: 'allowlist', network: 'denied' },
});
```

Once requirements are supplied, missing or malformed declarations fail closed.
Candidates are considered in caller order; rejected candidates and exact
reasons are returned before the first match. No match throws. The selector does
not execute a candidate or silently fall back to a runtime that misses a
requirement.

## Conformance observations

Adapter conformance harnesses can pass deterministic observations to
`axEvaluateRuntimeConformance(...)`. The report separates:

- `falseConfidence`: a claimed capability, bound, protocol, persistence mode,
  or authority denial was not observed
- `failures`: malformed envelopes, protocol mismatches, or cleanup were not
  rejected/observed as required
- `isolationProven: false`: always explicit, because declarations and bounded
  probes cannot establish isolation

Truthfully declaring an unsupported optional capability as `false` is
conformant. Conformance does not require every backend to support inspect,
snapshot, abort, or restart persistence.

## Deterministic evaluation

Run the zero-network, zero-provider-cost fixture:

```bash
node --import=tsx src/ax/agent/benchmarks/runtimeCapabilities.eval.ts
```

Bounds: 8 fixed selection tasks, 16 candidates total, 8 requirement-aware
selection calls, one synthetic incorrect-declaration report, zero runtime executions,
zero network calls, and zero provider calls. The output compares blind and
requirement-aware correct selection/rejection, counts detected false-confidence
claims, reports serialized declaration/operation overhead, and explicitly
reports that isolation was not proven.

The TypeScript integration suites separately exercise the real default
`AxJSRuntime` inspect/snapshot/patch/abort/session persistence, timeout,
host/module/network denial, worker restart, malformed worker messages, cleanup,
and fallback paths. AxIR protocol fixtures cover malformed envelopes, response
and session mismatches, unsupported inspect, timeout, EOF/nonzero exits, and
round trips for generated process adapters.
