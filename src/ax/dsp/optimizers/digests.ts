import { sha256 } from '../../util/crypto.js';

/**
 * Branded digest strengths for optimizer evidence.
 *
 * A digest string in an artifact says nothing about what it may be used for.
 * A 64-bit truncation is fine as a change-correlation fingerprint and is not
 * tamper evidence; a non-cryptographic checksum is neither. These brands make
 * the distinction a compile-time fact and `axAssertDigestStrength` makes it a
 * runtime one.
 *
 * Canonical JSON is deliberately NOT redeclared here: import
 * `axEventCanonicalJson` from `../../event/util.js` instead. Two canonical
 * serializers kept in agreement by a shared fixture is exactly the failure
 * mode the reuse rule exists to prevent.
 */
declare const axDigestBrand: unique symbol;

/**
 * Non-cryptographic checksum. Never tamper-evidence. Prefix `fnv1a64:`.
 *
 * Brands are a COMPILE-TIME convention. They do not survive `JSON.parse`; every
 * deserialization path in this subsystem casts. A branded field read off a
 * stored artifact has NOT been validated — call the matching `axIs*Digest`
 * guard first.
 */
export type AxFnv1a64Digest = string & { readonly [axDigestBrand]: 'fnv1a64' };

/** SHA-256 truncated to 64 bits. Correlation only, never identity. Prefix `sha256-64:`. */
export type AxSha256Digest64 = string & {
  readonly [axDigestBrand]: 'sha256-64';
};

/** Full SHA-256 from WebCrypto. The only accepted identity form. Prefix `sha256:`. */
export type AxSha256Digest = string & { readonly [axDigestBrand]: 'sha256' };

export type AxDigestStrength = 'checksum' | 'correlation' | 'identity';

/**
 * Total order over UTF-16 code units — the ONLY ordering allowed to decide the
 * byte sequence that goes into an identity digest.
 *
 * `String.prototype.localeCompare` resolves collation from the host process's
 * default locale (Node derives it from `LC_ALL`/`LANG` through ICU), so a
 * digest whose array members were locale-sorted is a function of the input AND
 * the environment: under `da-DK` "aal" sorts after "abc", and even under
 * `en-US` ICU root collation puts "exec.aB" before "exec.ab" where code-unit
 * order is the reverse. Two hosts then compute two different identities for the
 * same value, which silently breaks digest equality, ledger idempotency, and
 * every artifact that has already frozen one of the two.
 *
 * This is the same order `axEventCanonicalJson` (`../../event/util.ts`) uses
 * for object keys — a bare `.sort()`, i.e. code-unit — so array order and key
 * order inside one canonical document agree.
 */
export function axCompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const FNV1A64_PATTERN = /^fnv1a64:[0-9a-f]{16}$/;
const SHA256_64_PATTERN = /^sha256-64:[0-9a-f]{16}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const STRENGTH_ORDER: Readonly<Record<AxDigestStrength, number>> = {
  checksum: 0,
  correlation: 1,
  identity: 2,
};

export class AxDigestStrengthError extends Error {
  readonly code = 'digest_strength_insufficient';
  readonly field: string;
  readonly observed: AxDigestStrength | 'unknown';
  readonly required: AxDigestStrength;

  constructor(
    args: Readonly<{
      field: string;
      observed: AxDigestStrength | 'unknown';
      required: AxDigestStrength;
    }>
  ) {
    super(
      `digest_strength_insufficient: ${args.field} is ${args.observed} strength but ${args.required} is required`
    );
    this.name = 'AxDigestStrengthError';
    this.field = args.field;
    this.observed = args.observed;
    this.required = args.required;
  }
}

/**
 * Cross-realm structural guard. `instanceof` breaks when this module is loaded
 * through a second copy of the package, so hosts key on the discriminant.
 */
export function axIsDigestStrengthError(
  error: unknown
): error is AxDigestStrengthError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; required?: unknown };
  return (
    candidate.code === 'digest_strength_insufficient' &&
    (candidate.required === 'checksum' ||
      candidate.required === 'correlation' ||
      candidate.required === 'identity')
  );
}

/** Strength of a prefixed digest, or `undefined` when the prefix is unrecognized. */
export function axDigestStrength(value: string): AxDigestStrength | undefined {
  if (SHA256_PATTERN.test(value)) return 'identity';
  if (SHA256_64_PATTERN.test(value)) return 'correlation';
  if (FNV1A64_PATTERN.test(value)) return 'checksum';
  return undefined;
}

export function axIsFnv1a64Digest(value: string): value is AxFnv1a64Digest {
  return FNV1A64_PATTERN.test(value);
}

export function axIsSha256Digest64(value: string): value is AxSha256Digest64 {
  return SHA256_64_PATTERN.test(value);
}

export function axIsSha256Digest(value: string): value is AxSha256Digest {
  return SHA256_PATTERN.test(value);
}

/**
 * Assert a digest meets a minimum strength before it is used.
 * `identity` > `correlation` > `checksum`.
 */
export function axAssertDigestStrength(
  value: string,
  minimum: AxDigestStrength,
  field: string
): void {
  const observed = axDigestStrength(value);
  if (observed === undefined) {
    throw new AxDigestStrengthError({
      field,
      observed: 'unknown',
      required: minimum,
    });
  }
  if (STRENGTH_ORDER[observed] < STRENGTH_ORDER[minimum]) {
    throw new AxDigestStrengthError({ field, observed, required: minimum });
  }
}

/**
 * Identity digest. Async because it delegates to WebCrypto
 * (`src/ax/util/crypto.ts`). Returns `sha256:<64 hex>`.
 *
 * There is deliberately NO synchronous identity digest. The repo's only sync
 * SHA-256 (`sha256BytesSync`, moved here from `gepaLineage.ts`) writes just the
 * low 32 bits of the FIPS-180-4 length field, so it is correct only below
 * 512 MiB of input. That is fine for a 64-bit correlation fingerprint and not
 * fine for identity.
 */
export async function axSha256Digest(value: string): Promise<AxSha256Digest> {
  return `sha256:${await sha256(value)}` as AxSha256Digest;
}

/**
 * Correlation digest: SHA-256 truncated to 64 bits, computed synchronously.
 * Returns `sha256-64:<16 hex>`. Byte-identical to what `fingerprintGEPAValue`
 * emitted before this helper was extracted.
 *
 * Synchronous because `buildLineageManifest` is synchronous. Not valid above
 * 512 MiB of input (see `axSha256Digest`).
 */
export function axSha256Digest64Sync(value: string): AxSha256Digest64 {
  return `sha256-64:${syncSha25664Hex(value)}` as AxSha256Digest64;
}

/**
 * FNV-1a 64 over UTF-16 code units. Returns `fnv1a64:<16 hex>`.
 * Matches `agentInternal/playbookEvolve/playbookEvolve.ts` byte for byte, so
 * the two evidence registers can be correlated without unifying them.
 */
export function axFnv1a64Digest(value: string): AxFnv1a64Digest {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}` as AxFnv1a64Digest;
}

function syncSha25664Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hashed = sha256BytesSync(bytes);
  return Array.from(hashed.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hand-rolled synchronous SHA-256, moved verbatim from `gepaLineage.ts`.
 *
 * Build-vs-buy: WebCrypto (`util/crypto.ts`) is the adopted implementation for
 * every identity digest and is async; a third-party sync SHA-256 would be a new
 * runtime dependency in `src/ax`, which the package forbids. This copy is kept
 * only because its output is already frozen into stored artifacts and
 * `buildLineageManifest` is synchronous — and only at correlation strength,
 * because it writes just the low 32 bits of the length field and therefore
 * diverges from FIPS-180-4 above 512 MiB of input. If `buildLineageManifest`
 * ever becomes async, delete this and derive the fingerprint from
 * `axSha256Digest`.
 */
function sha256BytesSync(message: Uint8Array): Uint8Array {
  const K = sha256K;
  const bitLen = message.length * 8;
  const withPad = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  withPad.set(message);
  withPad[message.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotRight(w[i - 15]!, 7) ^ rotRight(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 =
        rotRight(w[i - 2]!, 17) ^ rotRight(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotRight(e, 6) ^ rotRight(e, 11) ^ rotRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotRight(a, 2) ^ rotRight(a, 13) ^ rotRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  outView.setUint32(20, h5);
  outView.setUint32(24, h6);
  outView.setUint32(28, h7);
  return out;
}

const rotRight = (value: number, bits: number): number =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0;

const sha256K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
