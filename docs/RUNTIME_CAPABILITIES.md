# Runtime capabilities, admission, and contradiction reports

Ax exposes an additive capability boundary for custom `AxCodeRuntime` and
`AxCodeSession` implementations. It does not add an interpreter, sandbox, or
certification system.

## Versioned AxIR superset

Generated AxIR runtimes currently diverge: Python/Java/C++ process adapters use
`inspect`, `snapshot`, `patch`, `abort`, `language`, and usage instructions;
Rust currently uses `inspect_globals`, `snapshot_globals`, and `patch_globals`;
Go uses a map. `AxIRRuntimeCapabilities` is the portable interchange projection
of that existing vocabulary, not an alias for every generated target record.

`AxRuntimeCapabilitiesV1` is explicitly versioned as
`ax-runtime-capabilities/v1` and extends—not aliases—the AxIR record with:

- Node/browser/Deno/unknown platform
- base and feature protocols
- session and restart persistence
- timeout enforcement and optional timeout/memory bounds
- aggregate host, module, and network authority
- filesystem, child-process, storage, communication, timing, worker,
  code-loading, native-addon, and WASI authority dimensions

Use `axExtendAxIRRuntimeCapabilities(...)` and
`axRuntimeCapabilitiesToAxIR(...)` at generated-adapter boundaries. This is a
migration path, not a claim that the generated records already implement the
v1 extensions. `axNormalizeAxIRRuntimeCapabilities(...)` explicitly converts
current snake-case and Rust `*_globals` records with caller-supplied language
and usage-instruction defaults.

Create declarations with `axCreateRuntimeCapabilities(...)`. It validates and
deeply freezes a copy. Selection also snapshots custom declarations. A frozen
declaration is still untrusted metadata and is not security evidence.

## Selection and host admission

`axSelectCodeRuntime(candidates)` preserves existing blind behavior and selects
the first candidate, including legacy runtimes without declarations.

Passing requirements opts into fail-closed matching. Invalid requirements,
including unknown top-level or nested fields and resource bounds that are not
positive safe integers, throw before candidates are considered. Unknown fields
are never interpreted as satisfied. Missing, malformed, contradictory, and
insufficient declarations are rejected.

At selector ingress, requirements are accepted only as plain objects and dense
arrays with enumerable own-data properties: accessors, symbols, hidden fields,
cycles, exotic objects, and proxies are rejected. The selector then creates one
deeply frozen plain snapshot and uses only that snapshot for schema validation,
admission gating, and matching. This prevents a getter or proxy from changing a
security requirement between those steps; it does not treat freezing as
security proof.

Inspect/snapshot/patch/abort, language, platform, protocol, and persistence may
be matched against the immutable declaration snapshot. Authority and resource
requirements are different: the selector refuses to satisfy them from a
runtime's self-assertion. The host must create an
`AxRuntimeAdmissionReceipt` with `axCreateRuntimeAdmissionReceipt(...)` and
explicitly pass it to selection:

```ts
const admission = axCreateRuntimeAdmissionReceipt(runtime, {
  evaluator: 'deployment policy v3',
  source: 'host-policy',
  resources: admittedResources,
  authority: admittedAuthority,
});

const { runtime: selected } = axSelectCodeRuntime(
  candidates,
  {
    schemaVersion: 'ax-runtime-requirements/v1',
    protocol: { name: 'ax-code-runtime', version: '1' },
    resources: { maxTimeoutMs: 1_000, timeoutEnforcement: 'hard' },
    authority: {
      host: 'denied',
      network: 'denied',
      platform: { filesystem: 'denied', childProcess: 'denied' },
    },
  },
  { admissions: [admission] }
);
```

Authority/resource requirements must specify the exact
`ax-runtime-requirements/v1` schema. Receipts are bound to a runtime identity
and its captured method identities, deeply snapshot admitted values, and must
be supplied out-of-band by the selecting host. Changing the candidate's
language or executable methods after admission invalidates the receipt before
selection. Security-aware selection returns the receipt's frozen executable
facade, whose methods are bound to the admitted implementation, rather than the
mutable candidate object. A runtime cannot make its declaration count as a
receipt.

The facade prevents method replacement from changing the selected executable;
it cannot generically freeze or attest implementation-private mutable state.
The receipt records what the host admitted; it does not prove that the
evaluator or policy is correct, and it never proves isolation.

## Protocol layers

The base session protocol is `ax-code-runtime/1`. Feature protocols use the
same `{ name, version }` representation in `protocol.features`. For example,
`axRuntimeProtocolFromToken('ax-program-source-runtime/js-v1')` produces the
feature requirement `{ name: 'ax-program-source-runtime', version: 'js-v1' }`.
The selector matches base and feature protocols through one compatibility
path. A feature protocol says that an adapter understands that bridge; it does
not replace the base session protocol or certify adapter policy. The generic
`AxJSRuntime` declares only the base protocol; a feature-owning adapter must add
the feature after verifying its bridge contract.

## Contradiction reports

`axReportRuntimeCapabilityContradictions(...)` compares a declaration with
provenanced caller observations. It reports:

- claims that observations contradict
- capabilities observed but not declared
- malformed-envelope, protocol-mismatch, cleanup, and insufficient-probe
  failures
- whether observations came from an executable adapter rather than synthetic
  or host-only data
- `isolationProven: false`, always

Checks cover operation support, persistence/restart, platform, authority
breadth and allowlist boundaries, timeout bound and enforcement, memory
overshoot, protocol, and cleanup. These are bounded contradiction checks. Even
executable probes cannot establish complete isolation.

Adapter owners still own interpreter choice, process/container policy,
permissions, cancellation, filesystem/network/module controls, package
loading, and cleanup. `AxJSRuntime` declares its effective options
conservatively; enabling a host-sensitive permission broadens aggregate host
authority even when a platform separately enforces that permission.

## Deterministic evaluation

Run the zero-network, zero-provider-cost fixture:

```bash
node --import=tsx src/ax/agent/benchmarks/runtimeCapabilities.eval.ts
```

Bounds: 8 fixed selection tasks, 16 candidates, 8 requirement-aware calls, one
synthetic incorrect-declaration report, zero runtime executions, zero network
calls, and zero provider calls. Output compares blind and requirement-aware
selection, rejection, contradiction detection, declaration/receipt overhead,
observation provenance, and the explicit inability to prove isolation.

Current fixed result: blind selection is correct for 1/8 tasks;
requirement-aware selection is correct for 8/8 with 7 rejected candidates; the
misdeclared backend produces 10 contradictions. Serialized overhead is 638
declaration bytes plus 407 admission-receipt bytes, with 8 requirement checks
and no runtime execution. The synthetic report records
`executableObservations: false` and `isolationProven: false`.
