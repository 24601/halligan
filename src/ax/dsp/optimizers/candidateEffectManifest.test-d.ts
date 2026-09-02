import type { AxEventEffectIntent } from '../../event/types.js';
import type { Equal, Expect } from '../../util/typetest.js';
import type {
  AxCandidateEffectDeclaration,
  AxCandidateEffectPolicy,
} from './candidateEffectManifest.js';

/**
 * BOUND VOCABULARY — the two fields that really are the event runtime's.
 *
 * If `AxEventEffectIntent` ever renames or re-types these, this file stops
 * compiling, which is the point: a candidate's effect declaration must speak the
 * same language as the runtime that would carry it out.
 */
type _operation = Expect<
  Equal<
    AxCandidateEffectDeclaration['operation'],
    AxEventEffectIntent['operation']
  >
>;
type _replaySafety = Expect<
  Equal<
    AxCandidateEffectDeclaration['replaySafety'],
    NonNullable<AxEventEffectIntent['replaySafety']>
  >
>;

/**
 * AX-SIDE fields, asserted to have NO event-runtime counterpart, so nobody
 * later mistakes them for bound vocabulary.
 *
 * `idempotencyKeySource` describes how the runtime's `idempotencyKey` (a plain
 * `string` there) is produced; `resolver` records whether a host
 * `AxEventEffectResolver` exists. Both point AT runtime concepts without being
 * runtime fields.
 */
type _keySourceIsNotBound = Expect<
  Equal<
    'idempotencyKeySource' extends keyof AxEventEffectIntent ? true : false,
    false
  >
>;
type _resolverIsNotBound = Expect<
  Equal<'resolver' extends keyof AxEventEffectIntent ? true : false, false>
>;

/**
 * Fields the previous design carried and this one does not. The event runtime
 * has no compensation and no environment concept, so declaring them would be a
 * vocabulary claim with nothing behind it.
 */
type _noCompensation = Expect<
  Equal<
    'compensation' extends keyof AxCandidateEffectDeclaration ? true : false,
    false
  >
>;
type _noEnvironment = Expect<
  Equal<
    'environment' extends keyof AxCandidateEffectDeclaration ? true : false,
    false
  >
>;

type _declarationShape = Expect<
  Equal<
    keyof AxCandidateEffectDeclaration,
    'operation' | 'replaySafety' | 'idempotencyKeySource' | 'resolver'
  >
>;

declare const effect: AxCandidateEffectDeclaration;
// @ts-expect-error a validated declaration is read-only
effect.operation = 'payments.refund';
// @ts-expect-error there is no third replay-safety value
const _bestEffort: AxCandidateEffectDeclaration['replaySafety'] = 'best_effort';
// @ts-expect-error the key-source vocabulary is closed
const _guessed: AxCandidateEffectDeclaration['idempotencyKeySource'] =
  'guessed';

// The policy is a two-state switch; `'off'` is the default everywhere, so the
// legacy path cannot be changed by adding an intermediate mode here.
type _policyIsClosed = Expect<
  Equal<AxCandidateEffectPolicy, 'off' | 'required'>
>;
// @ts-expect-error there is no advisory policy
const _warn: AxCandidateEffectPolicy = 'warn';
