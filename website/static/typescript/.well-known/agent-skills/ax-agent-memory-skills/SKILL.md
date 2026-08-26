---
name: ax-agent-memory-skills
description: This skill helps an LLM generate correct AxAgent memory retrieval, context-map, and dynamic skill-loading code using @ax-llm/ax. Use when the user asks about contextMap, AxAgentContextMap, onMemoriesSearch, memoriesCatalog, recall(...), inputs.memories, onLoadedMemories, onUsedMemories, onSkillsSearch, skillsCatalog, AxAgentCatalogSkill, discover({ skills }), onLoadedSkills, onUsedSkills, preloaded skills, preloading memories at forward time, relevanceRanking hints, loaded memory/skill IDs, or carrying memories across forward() calls.
version: "24.0.8"
---

# AxAgent Memory And Skills Rules (@ax-llm/ax)

Use this skill when an agent needs a persistent context map, task-relevant memory retrieval, or skill guides loaded into the executor prompt on demand. For ordinary agent setup use `ax-agent`. For RLM runtime policy use `ax-agent-rlm`. For callbacks and telemetry use `ax-agent-observability`.

## Use These Defaults

- Use a static `skillsCatalog` / `memoriesCatalog` when the skill guides or memories fit in a plain array — Ax then backs `discover({ skills })` / `recall(...)` with a built-in deterministic local search and no host search code is needed.
- Use `onSkillsSearch` / `onMemoriesSearch` when retrieval needs a real backend (vector DB, BM25 service, KV). A host callback always takes precedence over the catalog's built-in search.
- Use `contextMap` when repeated runs inspect the same long external context and should accumulate a small orientation cache automatically.
- `recall(...)` is available to distiller and executor stages when `onMemoriesSearch` or a non-empty `memoriesCatalog` is set.
- `discover({ skills })` is available to the executor when `onSkillsSearch` or a non-empty `skillsCatalog` is set.
- With `skillsCatalog`, the executor prompt also gains a static `### Available Skills` index (id + name + description), so skill discovery is targeted instead of blind.
- Both `recall(...)` and `discover({ skills })` return `void`. The loaded content appears on the next turn.
- Use `onLoadedMemories` / `onLoadedSkills` to observe what got loaded.
- Use `onUsedMemories` / `onUsedSkills` to track what the actor says it actually relied on.
- Child agents do not inherit memory or skills search callbacks; wire them explicitly on every agent that needs the capability.

## Context Map

Use `contextMap` when repeated runs ask different questions over the same long context, document set, or repository. The map is prompt-resident orientation knowledge: structure, concepts, constants, parsing schema, reusable aggregate results, and concrete error patterns. It is not a task-specific answer cache.

   Runnable example: [`src/examples/rlm-context-map-live.ts`](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-context-map-live.ts) demonstrates a provider-backed context-map update, `onUpdate` snapshot persistence, finite evolve, and frozen map reuse.

When `contextMap` is configured:

- Ax injects the current map into the distiller prompt.
- Ax updates the map once after each successful completed `forward(...)`.
- By default the map evolves forever. For a finite warmup, create the map with `{ infiniteEvolve: false, evolveSteps: N }`; after `N` successful updates it is still injected but no longer updated.
- Failed runs, aborts, and clarification requests do not update the map.
- Use `onUpdate` to persist `result.map.snapshot()` outside the agent.

```typescript
import { agent, AxAgentContextMap } from '@ax-llm/ax';

const map = new AxAgentContextMap(savedSnapshot, {
  maxChars: 4000,
  infiniteEvolve: false,
  evolveSteps: 10,
});

const myAgent = agent('context:string, query:string -> answer:string', {
  contextFields: ['context'],
  contextMap: {
    map,
    onUpdate: ({ map }) => saveSnapshot(map.snapshot()),
  },
});
```

Types:

```typescript
type AxAgentContextMapConfig = {
  map?: AxAgentContextMap | AxAgentContextMapSnapshot | string;
  onUpdate?: (result: AxAgentContextMapUpdateResult) => void | Promise<void>;
};

type AxAgentContextMapOptions = {
  maxChars?: number;
  infiniteEvolve?: boolean;
  evolveSteps?: number;
};
```

## Memory Search

Use `onMemoriesSearch` when the agent needs to pull task-relevant context such as user preferences, prior decisions, project facts, or past conversations from an external store (vector DB, BM25, KV). The actor decides what to load, when, and how much.

When `onMemoriesSearch` is set, the distiller and executor stages gain:

1. An `inputs.memories` field. In JS this is an array of `{ id, content }` entries the actor reads directly. In the prompt, the same entries render as markdown blocks with `ID: \`...\`` lines, matching the Loaded Skills ID style. Each `content` is opaque markdown; frontmatter is not parsed.
2. A `recall(searches: string[]): void` global the actor `await`s to load more entries. Recalled entries are appended to `inputs.memories` and visible from the next turn onward. `recall()` returns nothing.

The responder stage does not receive memories.

### Enabling

```typescript
import { agent } from '@ax-llm/ax';
import type { AxAgentMemoriesSearchFn } from '@ax-llm/ax';

const onMemoriesSearch: AxAgentMemoriesSearchFn = async (
  searches,
  alreadyLoaded
) => {
  // `searches` is the full array passed to recall(...). Batch your
  // store lookup in one round-trip.
  // `alreadyLoaded` is the current inputs.memories snapshot. Filter
  // against it to skip duplicates.
  const skip = new Set(alreadyLoaded.map((m) => m.id));
  const fresh = await myVectorDB.searchBatch(searches, { topK: 3 });
  return fresh.filter((m) => !skip.has(m.id));
};

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  onMemoriesSearch,
});
```

Each memory result must be:

```typescript
type AxAgentMemoryResult = {
  id: string;
  content: string;
};
```

### Static catalog (no callback)

If the memory set fits in a plain array, skip the callback entirely: pass `memoriesCatalog` and Ax backs `recall(...)` with a built-in deterministic local search (idf-weighted token overlap over `id` + content; not regex, not embeddings). The `alreadyLoaded` contract is preserved — entries already on `inputs.memories` are excluded before ranking.

```typescript
const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  memoriesCatalog: [
    { id: 'deploy-window', content: 'Prod deploys only on Tuesday afternoons.' },
    { id: 'user-prefs', content: 'User prefers concise answers.' },
  ],
});
```

Rules:

- If both `memoriesCatalog` and `onMemoriesSearch` are set, the host callback handles all `recall(...)` searches; the catalog still powers the advisory `relevanceRanking` hint.
- Catalog content is NOT preloaded into the prompt; entries load only when recalled.
- The built-in search is lexical. For semantic retrieval over large stores, supply `onMemoriesSearch` instead.

### Preloading memories at forward time

To seed specific memories for one run (no recall round-trip), pass them as the `memories` input value. They render on `inputs.memories` from the first turn and merge with anything recalled later (deduped by `id`).

```typescript
await myAgent.forward(ai, {
  task: 'Plan the deploy',
  memories: [{ id: 'deploy-window', content: 'Prod deploys only on Tuesday afternoons.' }],
});
```

### Actor usage

```javascript
// Turn 1: kick off one batched lookup.
await recall(['user preferences', 'project constraints']);

// Turn 2+: matched entries are now visible on inputs.memories.
const prefs = inputs.memories.find((m) => m.id === 'user-prefs-v2');
```

Rules:

- Pass all memory queries in one `await recall([...])` call.
- Do not loop `recall()` calls or wrap them in `Promise.all(...)`.
- Read `inputs.memories` on the next turn to see what landed.
- `recall()` invokes `onMemoriesSearch` with `(searches, alreadyLoaded)` and returns `void`.
- Results land on `inputs.memories` for subsequent turns and render in the prompt as:

```markdown
### Memory

ID: `mem:user-prefs-v2`

...
```

- Entries are deduped by `id` (last-write-wins) and sorted by `id` for prefix-cache stability.
- Memories loaded by the distiller thread automatically to the executor. No second `recall()` is needed for those entries.
- `recall()` may be called multiple times across turns; results accumulate for that run.
- `inputs.memories` lifetime is one `.forward()` call. It resets between calls.

## Carrying Memories Across `.forward()` Calls

To preserve continuity across calls, persist memories in your store and recall them again on the next call. If you want to replay anything loaded on a prior run, observe loads with `onLoadedMemories`.

```typescript
const carried = new Map<string, string>();

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  onMemoriesSearch: async (searches) => {
    const fresh = await myVectorDB.searchBatch(searches, { topK: 3 });
    const carriedAsResults = [...carried.entries()].map(([id, content]) => ({
      id,
      content,
    }));
    return [...carriedAsResults, ...fresh];
  },
  onLoadedMemories: (results) => {
    for (const r of results) carried.set(r.id, r.content);
  },
});
```

## Host-owned preference evidence

Use `axSelectPreferenceEvidence(...)` when a host already has a bounded,
principal-scoped preference ledger and needs to decide which evidence may enter
Ax's existing memory input. This is an optional selection contract, not a user
profile, identity system, consent system, database, or autonomous learner.

The contract deliberately separates:

- `observation`: a sourced event, never applied as a preference;
- `inference`: an uncertain interpretation, returned under `informational` and
  never applied;
- `confirmed-preference`: eligible for `applied` only when the host admits its
  exact source, authority, and consent receipts.

The context `principalId` and stream checkpoint are host-owned. Ax does not
authenticate either. Receipt references are opaque lookup keys, not bearer
authority: the host callbacks must compare the detached, frozen request against
durable state and verify the complete principal, record, stream/version, epoch,
revision, event, operation, purpose, and event payload binding. A principal ID,
consent statement, or receipt reference copied from model output cannot certify
identity, provenance, authority, or consent. Never derive callback approval
from the same model text being evaluated.

```typescript
import {
  axPreferenceEvidenceToMemories,
  axSelectPreferenceEvidence,
} from '@ax-llm/ax';
import type { AxPreferenceEvidenceRecord } from '@ax-llm/ax';

const evidence: AxPreferenceEvidenceRecord[] = [
  {
    id: 'response-style',
    principalId: trustedSession.principalId,
    streamId: 'preference-stream-42',
    streamVersion: 1,
    epoch: 1,
    revisions: [
      {
        operation: 'assert',
        revision: 1,
        epoch: 1,
        eventId: 'preference-event-1',
        kind: 'confirmed-preference',
        value: 'Use concise bullet points for status updates.',
        sourceReceiptRef: 'source-receipt-1',
        confidence: 1,
        scope: 'response-style',
        applicability: { allOf: { channel: 'work' } },
        recordedAt: '2026-08-20T12:00:00.000Z',
        expiresAt: '2027-08-20T12:00:00.000Z',
        authorityReceiptRef: 'authority-receipt-1',
        consentReceiptRef: 'consent-receipt-1',
      },
    ],
  },
];

const selection = axSelectPreferenceEvidence(evidence, {
  principalId: trustedSession.principalId,
  query: 'Draft a concise project status update',
  scope: 'response-style',
  attributes: { channel: 'work' },
  now: new Date().toISOString(),
  verifyStreamState: (request) =>
    preferenceLedger.matchesCurrentSnapshot(request),
  verifyReceipt: (request) => preferenceLedger.verifyReceipt(request),
  verifyDestructiveLifecycleReceipt: (request) =>
    privacyControls.verifyDestructiveReceipt(request),
  allowApplication: (revision) => safetyPolicy.allows(revision),
});

await myAgent.forward(ai, {
  task: 'Draft the update',
  memories: axPreferenceEvidenceToMemories(selection),
});
```

Selection validates strictly increasing timestamps and versions, principal
scope, exact host stream state, receipt bindings, scope/applicability, expiry,
terminal lifecycle state, contradiction, supersession, confidence, and host
policy before using Ax's existing deterministic lexical ranker. Equal-time or
older supersession and unresolved contradictions fail closed. Within a single
stream's current epoch, a uniquely stronger claim resolves a self-contradiction
by authority kind (`confirmed-preference` over `observation` over `inference`),
then confidence; an equal-strength or otherwise unresolved conflict still fails
closed. This prevents a weak later inference from silently displacing a
stronger confirmed preference.
Stream-state verification binds the selected claim to the current durable
snapshot and its current `streamVersion`. Receipt verification instead binds
each event to the immutable `streamVersion` that emitted it (equal to that
event's `revision`), so later revisions cannot rewrite historical source,
authority, or consent receipts.
Only `applied` confirmed preferences convert to memory; observations and
inferences remain available for host inspection under `informational`.
Convert the returned selection directly; the memory adapter rejects copied or
deserialized selection objects. Callback inputs and returned selections are
detached and deeply frozen. Persist records and host checkpoints, not the
transient selection.

Use `axRetractPreferenceEvidence(...)` to append a reversible retraction while
retaining revision history. Use `axErasePreferenceEvidence(...)` to advance the
same stream monotonically and replace prior revisions with a content-free
tombstone; revision numbers do not reset. Retraction and erasure are terminal
within an epoch, and replayed older snapshots fail when
`verifyStreamState(...)` checks the host's current checkpoint. The only reopen
path is `axRenewPreferenceEvidence(...)`, which advances to a new epoch and
requires a separately verified epoch-authority receipt plus fresh consent.
Persist the new stream checkpoint before making it selectable. Erasure uses a
separate `verifyDestructiveLifecycleReceipt(...)`; ordinary application
authority cannot authorize deletion. The host remains responsible for
replacing/deleting durable copies, indexes, backups, caches, and derived data.

Selection has fixed fail-closed limits: 256 records, 64 revisions per record,
262,144 total bytes, 16,384 bytes per record, 4,000 value characters, 2,000
query characters, 256 scope/ID characters, 512 receipt-reference characters,
32 context attributes, 16 applicability entries, 32 relation references,
object depth 8, object/array width 64, and `topK` 20. Corpus and structural
limits are checked before host callbacks or ranking. The values are exported as
`axPreferenceEvidenceLimits`. Count, query, and total-byte overflow reject the
batch. Structural and per-record byte violations exclude only the malformed
record and do not consume the valid corpus's total-byte budget.

All verification and policy callbacks are synchronous and invoked inline.
Selector limits bound Ax-owned validation and ranking work, but do not bound
trusted-host callback latency. Hosts must keep callbacks bounded and
non-blocking, avoid reentrancy and lock cycles, and prefetch/cache authority
state or complete asynchronous verification before selection when external I/O
is required.

This mechanism is useful for small, auditable preference catalogs where the
host already owns identity, authority, privacy, retention, and safety policy.
Do not use it as a universal memory store, an authorization decision, or a
basis for medical, psychological, protected-trait, or other sensitive
inference. It does not verify that a reference is authentic, discover consent,
resolve semantic contradictions, sanitize preference text, or prove that
personalization helps model output. Callback correctness, atomic checkpoint
updates, receipt storage, privacy enforcement, identity binding, and input
contamination controls remain host responsibilities. `allowApplication` must
enforce product and safety rules independently of expected output text; user
preference never overrides truthfulness or safety.

### Deterministic mechanism evaluation

Run:

```bash
npm run evaluate:preference-evidence
```

The final corpus, expected outcomes, and event-bound host policy live in the
separately authored post-baseline artifact
`scripts/fixtures/preference-evidence-later-v1.json`. The artifact was committed
at `0f70af1aa9723c7059c0850b034918ba733ee958` after mechanism baseline
`8e1152f8974231ea7e81d8078acbd7e84386c438`; its frozen SHA-256 is
`756d76538ab5733c86894b8aecb62af7218563f301a80c599970c1d5922daa9f`.
The evaluator checks that digest before parsing and records the provenance in
its output. Artifact-owned expectations include exact exclusions and callback
counts/purposes for successful and rejected cases, so a callback regression or
an empty applied set rejected for the wrong reason fails.
Cases cover stable benefit, contradiction, expiry, cross-principal leakage,
forged consent/provenance and destructive authority, retraction, erasure and
stale replay, explicit epoch renewal, uncertain inference, unseen
harmful/sycophantic paraphrases, equal-time ambiguity, no-benefit, and noisy
small-data. Separate stress probes exercise count, query, total-byte, and
single and repeated cyclic-shape isolation before callbacks.

On the 17-case artifact, static/no personalization scores 14/17 exact with
three missed-personalization cases; naive latest-value scores 16/17 with two
correct applications, zero false-personalization cases, and one missed case.
Evidence-aware selection scores 17/17 with three correct applications, zero
false-personalization cases, and zero missed cases. All 17 exact applied-ID,
exclusion-reason, and callback checks pass, including unresolved observation
contradiction, an explicitly configured `minConfidence: 0.5` uncertain
inference rejection, equal-time observation supersession, and preservation of
a stronger confirmed preference over a weak later inference. Retention/expiry,
retraction/erasure, stale replay, renewal, authority, and stress checks also
pass. The artifact is 28,572 UTF-8 bytes. The evaluator reports measured
latency and every exclusion/callback check, exits nonzero on any failure, and
does not suppress or golden known failures.

The default bound is 17 cases × 1,000 iterations = 17,000 local selections,
five one-shot stress probes, zero provider calls/tokens, and $0 provider cost.
Latency is descriptive and machine-dependent. This is deterministic
adversarial mechanism regression coverage, not independent held-out
personalization accuracy. It makes no model-quality, security-proof,
semantic-retrieval, authority-authenticity, privacy-system, or
production-latency claim. The small synthetic set is useful for regression
detection, not statistical generalization; contamination control and genuine
independent evaluation remain host responsibilities.

## Skills Search

Use `onSkillsSearch` when the agent needs to load skill guides such as usage instructions, operational guides, or domain conventions into the executor's system prompt on demand. The actor decides which skills to fetch and when, so you do not pre-render every skill into every prompt.

When `onSkillsSearch` is set, the distiller and executor stages gain:

1. A "Loaded Skills" section in the system prompt that renders matched skill bodies with stable `ID:` values sorted by `id`.
2. A `discover({ skills })` path the actor `await`s to load more skills. Loaded entries appear in the next turn's prompt. `discover(...)` returns nothing.

Skills the distiller loads carry over to the executor automatically. The responder does not see skills.

### Enabling

```typescript
import { agent } from '@ax-llm/ax';
import type { AxAgentSkillsSearchFn } from '@ax-llm/ax';

// Each result is { id?: string; name: string; content: string }.
// If id is omitted, Ax falls back to name.
const onSkillsSearch: AxAgentSkillsSearchFn = async (searches) => {
  return mySkillStore.resolveBatch(searches, {
    // Recommended backend order: exact id, exact name, then broader search.
    // This lets the actor pass one simple string and keeps lookup policy host-side.
    strategy: ['id', 'name', 'search'],
    topK: 2,
  });
};

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  onSkillsSearch,
});
```

Each skill result is:

```typescript
type AxAgentSkillResult = {
  id?: string;
  name: string;
  content: string;
};
```

### Static catalog (no callback)

If the skill set fits in a plain array, skip the callback entirely: pass `skillsCatalog` and Ax backs `discover({ skills })` with a built-in deterministic local search (idf-weighted token overlap over `id` + `name`×2 + `description`×2 + the first 600 chars of `content`; not regex, not embeddings). The executor prompt also gains a static, cache-stable `### Available Skills` index (id + name + description, sorted by id), so the actor searches by known ids instead of guessing.

```typescript
import type { AxAgentCatalogSkill } from '@ax-llm/ax';

const catalog: AxAgentCatalogSkill[] = [
  {
    id: 'release-checklist',
    name: 'Release checklist',
    description: 'Steps for shipping a package release safely', // high-signal for matching
    content: '1. Bump version\n2. Run tests\n3. Tag and publish',
  },
];

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  skillsCatalog: catalog,
});
```

```typescript
type AxAgentCatalogSkill = {
  id: string;
  name: string;
  description?: string;
  content: string;
};
```

Rules:

- If both `skillsCatalog` and `onSkillsSearch` are set, the host callback handles all `discover({ skills })` searches; the catalog still powers the `### Available Skills` index and the advisory `relevanceRanking` hint.
- Catalog content is NOT preloaded into the prompt (unlike `skills`); entries load only when matched. Use `skills` for guides that must always be in context, `skillsCatalog` for a larger set loaded on demand.
- The built-in search is lexical. For semantic retrieval over large stores, supply `onSkillsSearch` instead.

### Actor usage

```javascript
// Pass all skill queries in one call.
await discover({ skills: ['release-checklist', 'incident-response'] });

// Next turn: loaded skill bodies render under the "Loaded Skills"
// system-prompt section.
```

Rules:

- `discover({ skills })` invokes `onSkillsSearch` with the raw search strings and returns `void`.
- Resolve each raw string backend-side: prefer an exact `id` match, then an exact `name` match, then fuzzy/full-text search. The actor should not have to choose `id:` vs `name:` syntax.
- Matched skills land under "Loaded Skills" for the next turn.
- Entries are deduped by `id` (last-write-wins) and sorted by `id` for prefix-cache stability.
- If a skill result omits `id`, its trimmed `name` is used as the id for backwards compatibility.
- Skills persist on the agent's `currentSkillsPromptState` across `.forward()` calls, unlike memories.
- Use `agent.getState()` / `setState(...)` to serialize/restore loaded skills.
- `discover({ skills })` may be called multiple times across turns. Within one turn, batch all skill queries in a single call.
- Child agents do not inherit `onSkillsSearch`; wire it explicitly per agent.

## Preloading Skills

If the caller already knows which skills are relevant, pass them up front instead of round-tripping through `discover({ skills })`.

- Init-time: `skills` on `AxAgentOptions` seeds the executor prompt at agent creation. They survive `setState(...)` resets.
- Forward-time: `skills` on `forward(ai, values, { skills })` merge in at the start of that call. Distiller and responder ignore forward-time skills.

Both accept the same shape `onSkillsSearch` returns: `readonly AxAgentSkillResult[]`. Forward-time skills override init-time skills by `id`. `onLoadedSkills` is not fired for preset skills; that callback is for runtime `discover({ skills })` analytics.

```typescript
const releaseAgent = agent('task:string -> answer:string', {
  contextFields: [],
  skills: [
    {
      id: 'release-checklist',
      name: 'release-checklist',
      content: '...',
    },
  ],
});

await releaseAgent.forward(
  ai,
  { task: 'Prepare release notes' },
  {
    skills: [
      {
        id: 'incident-response',
        name: 'incident-response',
        content: '...',
      },
    ],
  }
);
```

You can use `skills` without setting `onSkillsSearch` at all. That is useful for static guides where the actor never needs to fetch more.

## Host-Owned Executable Skill Artifacts

`skills`, `skillsCatalog`, and `onSkillsSearch` load opaque Markdown guidance;
they are not executable-skill registries. When a host has already built an
`AxAgentFunction` and needs a compatibility/retirement gate before registering
it, wrap it in `AxExecutableSkillArtifact` and call
`axSelectExecutableSkills(...)`:

```typescript
import {
  agent,
  axExecutableSkillRef,
  axSelectExecutableSkills,
  type AxExecutableSkillArtifact,
} from '@ax-llm/ax';

const artifacts: AxExecutableSkillArtifact[] = [
  {
    id: 'browser-checkout',
    version: '2',
    name: 'Browser checkout',
    description: 'Complete checkout in the current web store',
    functionRef: 'functions/browser-checkout/2',
    requirements: {
      preconditions: ['authenticated'],
      tools: ['browser.navigate@2'],
      environments: ['web-store@2026-08'],
      protocols: ['commerce@1'],
      capabilities: ['browser'],
      authorities: [
        {
          issuer: 'auth.example',
          audience: 'agent:checkout',
          principal: 'user:123',
          tenant: 'shop:7',
          resource: 'order:456',
          action: 'purchase',
          delegationRef: 'delegation:9',
        },
      ],
    },
    verification: {
      mode: 'required',
      evaluation: 'checkout-compatibility-v2',
      receiptRefs: ['receipt:checkout:2'],
      issuers: ['eval.example'],
    },
    provenance: { source: 'host-registry' },
    knownFailureModes: ['Does not handle split shipment'],
  },
];

const trustedFunctionRegistry = new Map([
  ['functions/browser-checkout/2', checkoutFunction],
]);
const verificationNow = new Date();
const receiptExpiresAt = new Date(
  verificationNow.getTime() + 30 * 24 * 60 * 60 * 1000
);

const selection = axSelectExecutableSkills(
  artifacts,
  {
    // Admission and accepted receipts are host-owned facts. Artifact metadata
    // cannot add itself to either list.
    admittedArtifacts: artifacts.map(axExecutableSkillRef),
    principal: 'user:123',
    audience: 'agent:checkout',
    preconditions: ['authenticated'],
    tools: ['browser.navigate@2'],
    environment: 'web-store@2026-08',
    protocols: ['commerce@1'],
    capabilities: ['browser'],
    grantedAuthorities: [
      {
        issuer: 'auth.example',
        audience: 'agent:checkout',
        principal: 'user:123',
        tenant: 'shop:7',
        resource: 'order:456',
        action: 'purchase',
        delegationRef: 'delegation:9',
      },
    ],
    verifiedReceipts: [
      {
        ref: 'receipt:checkout:2',
        artifact: { id: 'browser-checkout', version: '2' },
        principal: 'user:123',
        issuer: 'eval.example',
        audience: 'agent:checkout',
        evaluation: 'checkout-compatibility-v2',
        verifiedAt: verificationNow.toISOString(),
        expiresAt: receiptExpiresAt.toISOString(),
      },
    ],
    now: verificationNow.toISOString(),
    resolveFunction: (functionRef) => trustedFunctionRegistry.get(functionRef),
  },
  { query: 'complete checkout', topK: 1 }
);

const assistant = agent('task:string -> answer:string', {
  contextFields: [],
  functions: selection.artifacts.map((artifact) => artifact.function),
});

// Inactive/incompatible/malformed entries never enter `artifacts`; inspect
// their exact exclusion reasons without exposing their functions to the agent.
console.log(selection.inspection);
```

Requirements use exact host-canonicalized IDs. Include versions in tool,
environment, and protocol IDs when compatibility depends on a version; Ax does
not guess semver compatibility. Artifact admission and supersession use
structured `{ id, version }` references, so delimiters inside either field cannot
alias another revision. Every requirement is all-of except `environments`, where
any listed environment may match. Authorities are exact structured grants bound
to issuer, audience, principal, tenant, resource, action, and optional delegation.
`expiresAt`,
`deprecatedAt`, `lifecycle`, and `supersededBy` exclude revisions by default.
Malformed chronology, self-supersession, duplicate references, invalid clocks,
oversized inputs, and invalid `topK` fail closed but remain inspectable.
Limits are 1,000 catalog entries, 128 entries per list, 256 UTF-16 code units
per identifier, 2,048 per description or failure-mode string, 4,096 per query,
and integer `topK` from 0 through 100. Unknown record fields are rejected rather
than retained as unbounded extension metadata.

`verification` is mandatory and explicit. Use `{ mode: 'receiptless' }` only
when host policy permits an admitted artifact without evaluation evidence. In
`required` mode, at least one host-supplied receipt must match an allowed receipt
reference and issuer and be bound to the artifact revision, principal, audience,
evaluation, verification time, and unexpired lifetime.

This is only a selection and audit boundary. It does not load files, install
packages, execute artifact code during selection, sandbox functions, authenticate
receipt contents, or provide security isolation. The host must validate artifact
and receipt sources, admit structured revisions, supply current principal,
authority, capability, and receipt facts, and retain evaluation records outside
Ax. `resolveFunction` is the trusted registry boundary; selected metadata and
function schemas are copied and frozen, and the selected handler is bound to the
resolved handler value so later registry-object mutation cannot swap it.
Catalog, artifact, context, and option facts are detached and frozen before
validation in one shared ingress session and then never reread from caller
objects. Ingress and registry metadata must use own data properties; accessors
are rejected without invocation, so one context, option, catalog, or registry
getter cannot rewrite a fact that has not yet been detached. Supported metadata
is limited to finite JSON-like primitives, dense arrays, and plain or
null-prototype records. Arrays reject accessors, sparse entries, and keys outside
their declared length; snapshots and selector result arrays define own entries
without inherited assignment. Detached records and selected functions are
normalized to a null prototype so inherited or later-added `Object.prototype`
values cannot establish authority or alter function metadata. Callables, symbols,
bigints, custom-prototype objects such as `Date`, and cyclic values fail closed.
The trusted context resolver is the ingress exception. A selected function must
be a plain or null-prototype record with an own data-property `func` whose value
is callable and an own valid `name`. Its metadata is copied from own data
properties without executing accessors or rereading `func`; the whole selected
batch returns no artifacts if any selected root fails snapshot.
Inherited handlers, class instances, callable aliases, missing function names,
and accessor handlers or metadata fail closed; descriptions remain optional.
JavaScript proxies cannot be identified portably in the same realm and are
outside this boundary; hosts must not pass proxy-backed ingress or registry
records.
Select immediately before registration/invocation and select again whenever host
principal, authority, capability, receipt, or compatibility facts change.
`provenance` is informational and must never be populated from model output as
proof of trust. Legacy prompt skills are unchanged; rollback is removing the
selector and passing ordinary functions directly.

The deterministic zero-cost evaluation is:

```bash
node --import=tsx src/examples/executable-skill-compatibility-eval.ts
```

It compares naive lexical retrieval with compatibility-aware retrieval over a
controlled mechanism fixture containing task/tool/environment/protocol changes,
missing capability/authority,
unaccepted and forged receipt metadata, malformed legacy input, expiry,
deprecation, supersession, and a no-benefit control. It reports exact retrieval,
false application, serialized artifact/context bytes, prompt bytes (zero), and
wall-clock selector latency. The task variants are deterministic test cases, not
a statistically independent benchmark split. This fixture measures selector
mechanics only,
not model answer quality, function safety, verifier correctness, or real-world
latency.

## Advisory Relevance Hints (`relevanceRanking`)

`relevanceRanking` is ON by default — leave it unset; set `relevanceRanking: false` to opt out. The default was flipped after its A/B gate passed (substance-judged, 49 runs per variant per model: small-model first-lookup precision 24%→90% and answer accuracy 14%→29%; frontier-model control accuracy 63%→88% with fewer turns). The generated language ports implement the same advisory hint contract through AxIR Core.

When enabled, a deterministic local ranker scores the agent's discoverable capabilities against the task once per `forward(...)` and injects a short advisory `### Likely Relevant` shortlist into the executor turn — modules (needs `functionDiscovery`), catalog skills (needs `skillsCatalog`), and catalog memories (needs `memoriesCatalog`). The hint is non-authoritative: the full lists still apply and the actor may `discover`/`recall` anything else.

```typescript
const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  functionDiscovery: true,
  skillsCatalog: catalog,
  relevanceRanking: true, // or { topK: 3, minScore: 0.08 }
});
```

Rules:

- Default is ON across TypeScript and generated language ports; domains still self-gate on their prerequisites (`functionDiscovery` for modules, catalogs for skills/memories), so agents without those see no change. Everything else in this skill (catalog search, the Available Skills index) is independent of the flag.
- The shortlist rides a dynamic, non-cached prompt field; the cached system prompt stays byte-stable across tasks.
- On low confidence the ranker emits nothing rather than guessing.
- Memory hint entries include an ~80-char content snippet; very short memories may be usable from the hint alone without a `recall(...)` (such use is not visible to `onUsedMemories`).
- Observe outcomes via the `relevance_ranking` context event (see `ax-agent-observability`).

## Loaded And Used Tracking

`onLoadedMemories` reports what `recall(...)` loaded. `onLoadedSkills` reports what `discover({ skills })` loaded. To track what the actor says it actually relied on, use `onUsedMemories` / `onUsedSkills`.

```typescript
const used: AxAgentUsedMemory[] = [];

await myAgent.forward(
  ai,
  { task: 'Make a personal plan' },
  {
    onUsedMemories: (items) => used.push(...items),
  }
);

used; // [{ id, reason, stage }]
```

Rules:

- The actor can only report memory IDs already present in `inputs.memories`.
- The actor can only report skill IDs already present in Loaded Skills.
- Unknown values are dropped.
- When tracking is enabled, the actor sees `await used(id, reason?)`; this is the actor-side declaration mechanism.
- `used(...)` resolves against loaded memory IDs and loaded skill IDs.
- If memory IDs and skill IDs can collide, namespace them in your application, for example `mem:abc` and `skill:planning`.
- Python, Go, and Java accept these observers directly in their agent option maps. C++ wraps them with `register_agent_observer(...)`; Rust wraps them with `agent_observer(...)`. The returned marker can be used in constructor or forward option maps, and observer failures are ignored in every language.

Types:

```typescript
onMemoriesSearch?: AxAgentMemoriesSearchFn;
onLoadedMemories?: (
  results: readonly AxAgentMemoryResult[]
) => void | Promise<void>;
onUsedMemories?: (
  usedMemories: readonly AxAgentUsedMemory[]
) => void | Promise<void>;

onSkillsSearch?: AxAgentSkillsSearchFn;
onLoadedSkills?: (
  results: readonly AxAgentSkillResult[]
) => void | Promise<void>;
onUsedSkills?: (
  usedSkills: readonly AxAgentUsedSkill[]
) => void | Promise<void>;

contextMap?: AxAgentContextMapConfig;
skills?: readonly AxAgentSkillResult[];
skillsCatalog?: readonly AxAgentCatalogSkill[];
memoriesCatalog?: readonly AxAgentMemoryResult[];
relevanceRanking?: boolean | { topK?: number; minScore?: number };
```

## Persisting Agent State Across Languages

TypeScript uses `getState()` / `setState()` for the actor runtime snapshot. The generated packages keep their legacy `GetState` / `SetState` (or language-shaped equivalents) as bare-runtime compatibility methods. Use `ExportRuntimeState` / `RestoreRuntimeState` in generated packages when you need the complete portable agent snapshot, including loaded skills and constructor-preset reapplication after restore. Do not interchange the two snapshot shapes.

## Examples

Fetch this for full working code:

- [RLM Memories and Skills](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-memories-and-skills.ts) - `onMemoriesSearch` + `recall()` and `onSkillsSearch` + `discover({ skills })` with load observability and actual usage tracking via `onUsedMemories` / `onUsedSkills`
- [Skills + Memory Ops Assistant](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/skills-and-memory-assistant.ts) - an on-call assistant that recalls past decisions from a memory store and loads the right runbook skill on demand (also ported to Python, Go, Rust, Java, and C++ under `src/examples/<lang>/long-agents/`). All six languages support the native `onMemoriesSearch` / `onSkillsSearch` host callbacks, passed in the agent options at construction (Go/Java use native function values, Rust a `agent_with_search_callbacks` constructor, C++ a `register_*_search` helper); a static `memory_search_results` / `skill_search_results` config is also available.

## Do Not Generate

- Do not assign the result of `await recall(...)` or `await discover(...)`; both return `void`.
- Do not call `recall()` from the responder stage.
- Do not call `discover({ skills })` from the responder stage.
- Do not loop `recall()` calls or wrap them in `Promise.all(...)`.
- Do not loop `discover()` calls or wrap them in `Promise.all(...)`.
- Do not assume child agents inherit `onMemoriesSearch` or `onSkillsSearch`.
- Do not pass `onMemoriesSearch` results via shared fields as a workaround; use `recall(...)`.
- Do not assume `inputs.memories` persists across `.forward()` calls.
- Do not use `onLoadedMemories` / `onLoadedSkills` as proof that the actor relied on an item; use `onUsedMemories` / `onUsedSkills` for actual-use tracking.
- Do not write an `onSkillsSearch` / `onMemoriesSearch` callback that just scans a static array; pass the array as `skillsCatalog` / `memoriesCatalog` instead.
- Do not rely on the built-in catalog search for semantic matching over large stores; it is lexical token overlap — supply a host callback for embeddings/vector search.
- Do not confuse `skills` (always preloaded into the prompt) with `skillsCatalog` (searchable, loaded on demand).
