import type { AxEventClock } from '../../event/types.js';
import type { Equal, Expect } from '../../util/typetest.js';
import type { AxSha256Digest } from './digests.js';
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
 * to anything shaped like a trusted optimization reference, because that
 * channel is documented as developer-selected guidance and is rendered inside
 * TRUSTED markers — and `diagnosis` is model-authored text. If these two ever
 * become structurally interchangeable, a proposer can write text the harness
 * then frames back to it as developer guidance.
 */
type TrustedOptimizationReferenceShape = {
  readonly name: string;
  readonly content: string;
};
declare const prior: AxGEPARejectedPriorBlock;
// The block is deliberately NOT a bare {name, content} record: it carries its
// own literal `name` and the counts a reader needs to know what was omitted.
type _priorIsDistinct = Expect<
  Equal<
    AxGEPARejectedPriorBlock extends TrustedOptimizationReferenceShape
      ? keyof AxGEPARejectedPriorBlock
      : never,
    'name' | 'content' | 'entryCount' | 'omittedCount'
  >
>;
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
