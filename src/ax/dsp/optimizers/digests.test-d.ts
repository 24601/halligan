import type { Equal, Expect } from '../../util/typetest.js';
import type {
  AxDigestStrength,
  AxFnv1a64Digest,
  AxSha256Digest,
  AxSha256Digest64,
} from './digests.js';
import {
  axAssertDigestStrength,
  type axFnv1a64Digest,
  axIsSha256Digest,
  type axSha256Digest,
  type axSha256Digest64Sync,
} from './digests.js';

declare const checksum: AxFnv1a64Digest;
declare const correlation: AxSha256Digest64;
declare const identity: AxSha256Digest;
declare const plain: string;

// Every brand widens to string, so a branded digest can still be serialized,
// concatenated, and compared like any other string.
const _asString: string = identity;

// The three brands are mutually non-assignable in all six directions. This is
// the whole mechanism: a correlation fingerprint must not reach a parameter
// that promises identity strength.
// @ts-expect-error checksum is not a correlation digest
const _a: AxSha256Digest64 = checksum;
// @ts-expect-error checksum is not an identity digest
const _b: AxSha256Digest = checksum;
// @ts-expect-error correlation is not a checksum
const _c: AxFnv1a64Digest = correlation;
// @ts-expect-error correlation is not an identity digest
const _d: AxSha256Digest = correlation;
// @ts-expect-error identity is not a checksum
const _e: AxFnv1a64Digest = identity;
// @ts-expect-error identity is not a correlation digest
const _f: AxSha256Digest64 = identity;

// A plain string is not assignable to any brand: a digest must come from a
// producer or a guard, never from a cast at the call site.
// @ts-expect-error unvalidated string is not a checksum
const _g: AxFnv1a64Digest = plain;
// @ts-expect-error unvalidated string is not a correlation digest
const _h: AxSha256Digest64 = plain;
// @ts-expect-error unvalidated string is not an identity digest
const _i: AxSha256Digest = plain;

// Brands are erased by serialization. A value read back off `JSON.parse` is a
// plain `string` and has NOT been validated; the guard is what re-establishes
// the brand.
declare const stored: { digest: string };
// @ts-expect-error a deserialized field is not branded until it is guarded
const _j: AxSha256Digest = stored.digest;
if (axIsSha256Digest(stored.digest)) {
  const _guarded: AxSha256Digest = stored.digest;
}

type _identityIsAsync = Expect<
  Equal<ReturnType<typeof axSha256Digest>, Promise<AxSha256Digest>>
>;
type _correlationIsSync = Expect<
  Equal<ReturnType<typeof axSha256Digest64Sync>, AxSha256Digest64>
>;
type _checksumIsSync = Expect<
  Equal<ReturnType<typeof axFnv1a64Digest>, AxFnv1a64Digest>
>;
type _assertReturnsVoid = Expect<
  Equal<ReturnType<typeof axAssertDigestStrength>, void>
>;
type _strengthIsClosed = Expect<
  Equal<AxDigestStrength, 'checksum' | 'correlation' | 'identity'>
>;

// @ts-expect-error the strength ladder is closed; there is no fourth rung
axAssertDigestStrength(plain, 'tamper-evident', 'field');
