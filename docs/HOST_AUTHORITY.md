# Host-owned identity and authority

Ax provides an optional mechanism boundary for attaching host-verified identity
and scoped capability data to agent, function, MCP/UCP, and event-runtime
execution. It is additive and off by default. If `authority` is absent, Ax runs
exactly as before and performs no authority checks.

This boundary is useful when a host already authenticates actors and owns policy
decisions, but needs one request-scoped contract to carry that decision through
Ax execution. It is not useful as a replacement for authentication, credential
custody, consent, product roles, or provider-side enforcement.

## Authority assumptions and limits

- The host is authoritative. It constructs `AxPrincipal`, `AxActor`, delegation
  claims, grants, and the `authorize(operation, context)` callback from verified
  state. Never construct them from model output, prompt text, tool arguments, or
  an unverified event payload.
- Ax validates structure, exact operation/resource/tenant/actor scope, grant
  time bounds, revocation time, lease epoch, and child attenuation before asking
  the host. The host must still check current revocation, leases, and policy.
- Ax deep-clones and freezes principal, actor, delegation, claim, grant, resource,
  and receipt data at execution boundaries. Mutating the host's source objects
  after publication cannot alter an in-flight authority snapshot.
- An allow decision is accepted only in an `AxAuthorizationReceipt` exactly
  bound to the request ID, operation, resource, principal, actor, eligible grant
  IDs, lease epoch, and time window. Function handlers receive that receipt in
  `extra.authorityReceipt`.
- Claims are opaque data. Ax validates that they are bounded to persistable
  values but does not interpret, authenticate, sign, encrypt, or prove them.
- Grants are data structures, not bearer tokens or cryptographic capabilities.
  This mechanism makes no security guarantee against a compromised host or
  process and does not make arbitrary external effects exactly once.
- Scope matching is exact. There are no wildcards, roles, policy language,
  implied operations, or resource hierarchies.
- Host authorization is bounded by `authorizeTimeoutMs` (30 seconds by default).
  Timeout or caller cancellation aborts the callback signal and fails closed;
  late callback completion is ignored.
- Redacted `onAudit` events contain operation, resource type, actor kind,
  decision, grant count, time, and result code. They intentionally omit all IDs,
  claims, arguments, receipt reasons, and resource values. Hosts that log full
  receipts must apply their own redaction.

## Configuration

```ts
import type {
  AxAuthorizationRequestContext,
  AxAuthorityContext,
} from '@ax-llm/ax';

const now = Date.now();

const authority: AxAuthorityContext = {
  principal: { id: 'subject-42', tenantId: 'tenant-a' },
  actor: { id: 'worker-7', kind: 'agent' },
  leaseEpoch: 3,
  authorizeTimeoutMs: 5_000,
  grants: [
    {
      version: 1,
      id: 'grant-9',
      principalId: 'subject-42',
      actor: { id: 'worker-7', kind: 'agent' },
      operations: ['function.call'],
      resources: [
        { type: 'function', id: 'records:lookup', tenantId: 'tenant-a' },
      ],
      expiresAt: now + 60_000,
      leaseEpoch: 3,
    },
  ],
  authorize: (operation, request: Readonly<AxAuthorizationRequestContext>) => ({
    version: 1,
    receiptId: `receipt-${request.requestId}`,
    requestId: request.requestId,
    decision: 'allow', // after the host's authoritative policy check
    operation,
    resource: request.resource,
    principalId: request.principal.id,
    actor: { id: request.actor.id, kind: request.actor.kind },
    grantIds: request.grants.map((grant) => grant.id),
    leaseEpoch: request.leaseEpoch,
    authorizedAt: request.now,
  }),
};

await program.forward(ai, input, { authority });
```

Ax derives non-model-visible bindings from the invoked function:

| Execution | Operation | Resource |
| --- | --- | --- |
| ordinary Ax function | `function.call` | `function`, component ID or function name |
| child agent function | `agent.invoke` | `agent`, stable agent component ID |
| attached MCP tool | `mcp.tool.call` | `mcp.tool`, `namespace:name` |
| attached UCP operation | `ucp.operation.call` | `ucp.operation`, `namespace:name` |
| event route/target/sink | `event.*` | exact route, target, or sink ID |

Model-callable MCP prompt, resource, task, subscription, cancellation, and
completion methods are separately authorized as `mcp.prompt.*`,
`mcp.resource.*`, `mcp.task.*`, and `mcp.completion.complete`, with exact
catalog/name/URI/task/reference resources. UCP profile and operation catalogs
use `ucp.profile.read` and `ucp.operation.list`. This includes reads: a model
cannot use prompt or resource discovery to bypass the boundary.

Direct calls to `AxMCPClient.callTool()` do not pass through program execution;
keep using `authorizeToolCall` there. The shared authority boundary applies when
MCP/UCP operations are attached to an Ax program or agent.

## Evidence guards

A grant may carry `requirements`: contingencies its authority depends on. Ax
evaluates them against host-supplied `AxEvidenceObservation` facts **after** a
grant has matched and **before** the host authorizer is called. A guard denial
therefore costs zero host calls and produces exactly one audit event.

**The operators are mechanism the
host authors policy with. Ax does not compile, infer, or extend policy, and
will not grow a policy language. Adding a seventh operator requires a named
host requirement recorded in this document.** There are no wildcards, roles,
implied operations, resource hierarchies, or composition — the same rule this
document already states for scope matching.

Guards never substitute for the host receipt. They gate *whether the host is
asked*; only a matching `AxAuthorizationReceipt` is an allow.

### The six operators

| `match.op` | Passes when |
| --- | --- |
| `eq` | the observation value canonically equals `value` |
| `ne` | the observation value canonically differs from `value` |
| `in` | the observation value canonically equals some member of `values` |
| `notIn` | the observation value equals no member of `values` |
| `contains` | the value is a string containing `value`, or an array with a canonically equal element. No coercion: any other value type fails |
| `fresh` | the single resolved observation is within `maxAgeMs`. Requires `maxAgeMs` |

Canonical comparison sorts object keys, so key order is never a difference.

### Resolution order

Exactly one observation must survive, and the first narrowing that empties the
candidate set names the failure:

| Condition | `AxGuardFailure.code` |
| --- | --- |
| unknown `op`, `fresh` without `maxAgeMs`, or empty `trustedSources` | `malformed_requirement` |
| no observation of the requirement's `kind` | `missing_observation` |
| none of them from an exact member of `trustedSources` | `untrusted_source` |
| none of those taken under the current lease epoch | `lease_epoch_mismatch` |
| more than one survives | `ambiguous_observation` |
| the survivor is older than `maxAgeMs`, or the clock is not finite | `stale` |
| the operator predicate rejects it | `predicate_failed` |

`maxAgeMs` is evaluated as a passing condition, not a negated failing one, so a
missing, `NaN`, or infinite clock denies every requirement that reads it rather
than silently disabling freshness. `axAuthorize` additionally rejects a
non-finite `now()` outright, since the same clock decides grant expiry.

Lease-epoch binding is unconditional and is not an operator: an observation
taken under a prior epoch never satisfies any requirement. Ambiguity is a deny —
Ax never picks the freshest, the first, or the "best" of several candidate
observations. Absent evidence is never treated as satisfied.

A malformed requirement normally cannot reach evaluation: `captureRequirements`
runs inside `captureGrant`, so `axValidateCapabilityGrant` throws on an unknown
operator, on `fresh` without `maxAgeMs`, on an empty `trustedSources`, and on
more than 32 requirements per grant. The evaluator's `malformed_requirement`
code exists for a host calling `axEvaluateGuards` directly.

### The union-of-grants semantic

`axCollectGrantRequirements` returns the deduped union of requirements across
**all** matching grants, in grant order and then within-grant order. A
requirement declared on one grant therefore also constrains a sibling grant that
matched the same operation and resource and declared nothing. This is coherent
with receipt binding, which already demands the receipt echo every eligible
grant ID, and it is the fail-closed direction. Requirements are deduped by a
canonical key over the kind, the trusted-source set, `maxAgeMs`, and the match,
in which `in` / `notIn` members compare as a set rather than a sequence.

### Denial and audit

A guard denial throws `AxAuthorizationDeniedError` with code
`guard_predicate_failed` and emits one audit event with the same code plus
`failedPredicateKind`. That field is the one deliberate, bounded exception to
redaction-by-construction: it is exactly `"<op>:<kind>"` of the first failed
requirement — host-authored labels only. It never carries an observation value,
a source ID, a claim, a resource ID, or a receipt reason.

`AxGuardFailure.op` is one of the six operators or the literal `'unknown'`: a
requirement naming an operator outside the six is normalized rather than echoed,
so both the failure union and the audit label stay a closed vocabulary a
consumer can switch on. The `kind` half is host-authored and is truncated so the
whole label stays within 240 characters.

Guards are **not** re-evaluated after the host returns its receipt. The receipt
is the authority and is already bound to the request context that carried this
evidence; re-evaluating would open a time-of-check window on the host's own
decision without adding a guarantee.

### Supplying evidence

`AxAuthorityContext.evidence` is a host-owned array, deep-cloned and frozen by
`axSnapshotAuthority` like every other host datum. It is never sourced from
model output, prompt text, tool arguments, or an event payload. A structurally
invalid observation throws at snapshot time rather than being silently ignored.

Both dimensions of guard evaluation are bounded so a host cannot accidentally
put unbounded work on the per-tool-call path: **32 requirements per grant** and
**64 observations per authority**. Exceeding either throws from
`axSnapshotAuthority` / `axValidateCapabilityGrant`; an `observeEvidence`
supplier that returns more than 64 observations is treated like a supplier that
threw, so its request denies fail-closed rather than paying the cost.

`AxAuthorityContext.observeEvidence` is a synchronous, side-effect-free supplier
called once per `axAuthorize` call, mirroring the existing `now?: () => number`
idiom. When present its result replaces `evidence` for that request. This is
what makes `maxAgeMs` usable in a long-lived context: the snapshot is cached, so
a frozen `evidence` array only ever ages within a run, while a supplier
re-reads the host's current facts. A supplier that throws — or returns a
malformed observation — yields no evidence, so every declared requirement fails
closed with `missing_observation`.

Ax always passes `evidence` and `requirements` (possibly empty) into
`AxAuthorizationRequestContext`, so the host authorizer sees exactly what Ax
evaluated.

### Attenuation

`axAttenuateAuthority` forwards the parent's `evidence` and `observeEvidence` to
the child; without that, guards and delegation would be mutually exclusive.

Contingency may only tighten, and the rule is checked twice because the union
semantic above means a grant's contingency is not only its own:

1. **Per lineage.** A child grant must carry every requirement its parent grant
   declared, compared by the same canonical key, and may add more. Dropping or
   relaxing one is rejected as an expansion of parent authority.
2. **Per operation and resource.** For every operation and resource a child
   grant names, the union of the child's matching requirements must cover the
   union the parent would have enforced for that same pair. Without this a
   child delegating only an *unannotated sibling* of a guarded grant would
   inherit no contingency at all and would out-authorize its own delegator.
   The parent side of this comparison ignores `issuedAt` / `expiresAt` /
   `revokedAt`, because attenuation has no clock and counting a possibly
   inactive grant can only demand more of the child.

Rule 2 is a union, not a blanket per-grant demand: an unannotated child grant is
legal when a sibling child grant matching the same operation and resource
carries the requirement, because that is exactly what `axAuthorize` evaluates.

### No behaviour change without requirements

When no grant declares `requirements`, no guard is evaluated, the audit
sequence and deny codes are byte-identical to before, and the only difference in
the host request context is two additional empty optional arrays.

## Events and sessions

`AxEventRuntimeOptions.authority` accepts a context or a resolver called for
each delivery. The runtime ignores authority-looking event data. It binds event
operations to the verified ingress tenant and passes the resolved context into
the target program, live agent runtime, MCP/UCP tools, and sinks.
Resolver callbacks are raced against the run abort signal and a 30s timeout.
Late rejection after cancel/timeout is observed and swallowed. Failure cannot
leave a ghost `activeRuns` entry or prevent `close({drain:false})`.
Sink dead-letter redrive calls the resolver again and requires a current
`event.sink.write` receipt; a receipt from the original delivery is never reused.

Nested agent calls inherit the same authority by default. Set
`authorityInheritance: 'none'` to propagate a fail-closed zero-grant context, or
provide explicit child principal, actor, delegation, and grants. Ax calls
`axAttenuateAuthority` and rejects a child grant unless it references a parent
grant and is a subset of its operations, resources, expiry/revocation bounds,
and lease epoch. Explicit delegation options are consumed at that boundary;
deeper calls inherit the resulting child unless the host supplies a new
child-relative attenuation. Cancellation is checked before and after host
authorization.

Long-lived or durable session hosts should persist only their own serializable
principal/grant references and reconstruct the authoritative callback in the
host process. Do not serialize callback closures or treat a retained session
handle as an authority grant. Recheck lease epoch and revocation on every
operation receipt.

## Migration

1. Keep existing APIs unchanged and add `authority` only to runs that need it.
2. Give stable host-defined functions a `componentId`; otherwise scope to their
   current function name. MCP/UCP and child agents already have stable bindings.
3. Declare exact grants for every invoked function and event target/sink. A run
   with an authority context fails closed when no grant matches.
4. Reuse existing direct MCP policy hooks outside Ax program execution. Do not
   count those callbacks as scoped receipt enforcement.
5. Add explicit attenuated child authority before changing nested actors. Same-
   actor nested programs may retain `all` while migrating.

## Deterministic evaluation

The evaluation uses synthetic fixtures and makes no model or network calls:

```bash
npm run authority:eval
npx vitest run scripts/authority-boundary-eval.test.ts
```

It declares an **unscoped operation callback** as the baseline and compares it
against exact scoped grants. It covers confused-deputy operation/resource
attempts, stale/revoked/expired grants, tenant and human-vs-agent mismatch,
delegation attenuation and no expansion, child cancellation, malformed legacy
claims, getter-backed authority/function-target/child-option capture, nested
mutation, ignored abort, two-level attenuation, and forged model claims through
production model request/response
dispatch for ordinary functions and attached MCP/UCP operations, native DSP,
and redrive paths. It also covers exact receipt binding, audit redaction, and
local callback overhead. Timing is an environment-specific observation, not a gate.
The result demonstrates these mechanism checks only; it is not a security proof
or an evaluation of host authentication and policy correctness.
