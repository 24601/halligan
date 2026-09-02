import type { AxEventClock } from '../../event/types.js';
import type { Equal, Expect } from '../../util/typetest.js';
import type { AxSha256Digest } from './digests.js';
import type { AxGEPAOptimizationReference } from './gepaReflection.js';
import type {
  AxGEPARejectedPriorBlock,
  AxInMemoryRejectedCandidateLedger,
  AxRejectedCandidateExpiry,
  AxRejectedCandidateLedgerEntry,
  AxRejectedCandidateLedgerRef,
  AxRejectedCandidateLedgerStore,
  axRejectedCandidateDigest,
  axRunRejectedCandidateLedgerConformance,
} from './rejectedCandidateLedger.js';

declare const store: AxRejectedCandidateLedgerStore;

// Every asynchronous boundary takes a trailing optional signal. A store that
// cannot be cancelled is a store that can hang a shutdown.
type _recordTakesSignal = Expect<
  Equal<
    Parameters<typeof store.record>,
    [entry: Readonly<AxRejectedCandidateLedgerEntry>, signal?: AbortSignal]
  >
>;
type _listTakesSignal = Expect<
  Equal<Parameters<typeof store.list>[1], AbortSignal | undefined>
>;
type _purgeTakesSignal = Expect<
  Equal<Parameters<typeof store.purgeExpired>[2], AbortSignal | undefined>
>;

// The in-memory store really implements the port, so a host swapping in a
// durable one is a drop-in replacement.
declare const memory: AxInMemoryRejectedCandidateLedger;
const _isAStore: AxRejectedCandidateLedgerStore = memory;
type _clockIsRequired = Expect<
  Equal<
    ConstructorParameters<typeof AxInMemoryRejectedCandidateLedger>[0],
    Readonly<{ clock: AxEventClock; maxEntries?: number }>
  >
>;

// The identity key is async because it is identity strength.
type _digestIsAsync = Expect<
  Equal<ReturnType<typeof axRejectedCandidateDigest>, Promise<AxSha256Digest>>
>;

// The expiry union is closed and discriminated. A fourth clause would be a
// fourth way for negative memory to outlive its stated conditions.
declare const clause: AxRejectedCandidateExpiry;
switch (clause.kind) {
  case 'model_changed':
    break;
  case 'task_set_changed':
    break;
  case 'after_ms':
    break;
  default: {
    const _exhaustive: never = clause;
    break;
  }
}
// @ts-expect-error there is no never-expires clause
const _never: AxRejectedCandidateExpiry = { kind: 'never' };
const _weakTaskSet: AxRejectedCandidateExpiry = {
  kind: 'task_set_changed',
  // @ts-expect-error a task-set clause needs an identity-strength digest
  taskSetDigest: 'sha256-64:e3b0c44298fc1c14',
};

declare const entry: AxRejectedCandidateLedgerEntry;
// @ts-expect-error a constructed entry is read-only
entry.diagnosis = 'rewritten';
// @ts-expect-error the expiry list is read-only
entry.expiresWhen.push({ kind: 'after_ms', ttlMs: 1 });

/**
 * B9's type-level guard.
 *
 * The rejected-candidate prior is its own block type. It must NOT be assignable
 * to `AxGEPAOptimizationReference`, because that channel is documented as
 * trusted developer-selected guidance, is rendered inside TRUSTED markers, and
 * `GEPA_PROPOSAL_CONTRACT` tells the model to use it "as general guidance" —
 * while `diagnosis` is model-authored text. If these two are structurally
 * interchangeable, the wiring commit can write `references: [priorBlock]` and
 * a proposer gets its own text framed back to it as developer guidance.
 *
 * The assertion below is the firewall itself, not a description of one:
 * `AxGEPARejectedPriorBlock.channel` is a required
 * `'rejected-candidate-prior'` where `AxGEPAOptimizationReference.channel` is
 * `'trusted-optimization-reference' | undefined`, which is what makes this
 * assignment fail. Deleting that member makes the `@ts-expect-error` unused and
 * this file stops compiling.
 */
declare const prior: AxGEPARejectedPriorBlock;
// @ts-expect-error the untrusted prior block is not a trusted optimization reference
const _priorIsNotATrustedReference: AxGEPAOptimizationReference = prior;
// ...and not by accident of a missing member: every member the trusted channel
// reads is present — including a plain-string `description` — so `channel` is
// doing the work.
type _priorHasName = Expect<
  Equal<'name' extends keyof AxGEPARejectedPriorBlock ? true : false, true>
>;
type _priorHasContent = Expect<
  Equal<AxGEPARejectedPriorBlock['content'], string>
>;
// `description` is now an ORDINARY string on both sides: it carries no part of
// the firewall any more, and asserting that proves `channel` alone closes the
// channel.
type _priorDescriptionIsAString = Expect<
  Equal<AxGEPARejectedPriorBlock['description'], string>
>;
type _priorChannelIsPinned = Expect<
  Equal<AxGEPARejectedPriorBlock['channel'], 'rejected-candidate-prior'>
>;
type _trustedChannelIsOptional = Expect<
  Equal<
    AxGEPAOptimizationReference['channel'],
    'trusted-optimization-reference' | undefined
  >
>;
// A plain host literal still assigns to the trusted channel, so closing it
// broke no existing caller.
const _hostReference: AxGEPAOptimizationReference = {
  name: 'style-guide',
  content: 'prefer short sentences',
  description: 'developer guidance',
};
type _priorNameIsPinned = Expect<
  Equal<AxGEPARejectedPriorBlock['name'], 'rejected-candidate-prior'>
>;
const _relabelled: AxGEPARejectedPriorBlock = {
  ...prior,
  // @ts-expect-error the block cannot be relabelled as a trusted reference
  name: 'optimization-reference',
};

declare const ref: AxRejectedCandidateLedgerRef;
// @ts-expect-error a carried ledger reference is read-only
ref.storeId = 'other';

// The conformance runner reports what it SKIPPED, so a volatile store cannot
// pass the durability obligation silently.
type _conformanceReportsSkips = Expect<
  Equal<
    Awaited<
      ReturnType<typeof axRunRejectedCandidateLedgerConformance>
    >['skipped'],
    readonly string[]
  >
>;
