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

Direct calls to `AxMCPClient.callTool()` do not pass through program execution;
keep using `authorizeToolCall` there. The shared authority boundary applies when
MCP/UCP operations are attached to an Ax program or agent.

## Events and sessions

`AxEventRuntimeOptions.authority` accepts a context or a resolver called for
each delivery. The runtime ignores authority-looking event data. It binds event
operations to the verified ingress tenant and passes the resolved context into
the target program, live agent runtime, MCP/UCP tools, and sinks.

Nested agent calls inherit the same authority by default. Set
`authorityInheritance: 'none'` to propagate a fail-closed zero-grant context, or
provide explicit child principal, actor, delegation, and grants. Ax calls
`axAttenuateAuthority` and rejects a child grant unless it references a parent
grant and is a subset of its operations, resources, expiry/revocation bounds,
and lease epoch. Cancellation is checked before and after host authorization.

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
claims, forged model claims, exact receipt binding, audit redaction, and local
callback overhead. Timing is an environment-specific observation, not a gate.
The result demonstrates these mechanism checks only; it is not a security proof
or an evaluation of host authentication and policy correctness.
