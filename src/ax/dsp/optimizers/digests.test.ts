import { describe, expect, it } from 'vitest';

import { sha256 } from '../../util/crypto.js';
import {
  axAssertDigestStrength,
  axDigestStrength,
  axFnv1a64Digest,
  axIsDigestStrengthError,
  axIsFnv1a64Digest,
  axIsSha256Digest,
  axIsSha256Digest64,
  axSha256Digest,
  axSha256Digest64Sync,
} from './digests.js';
import { fingerprintGEPAValue } from './gepaLineage.js';

/**
 * INV-L4 vector table. Captured from `fingerprintGEPAValue` BEFORE the
 * synchronous SHA-256 moved out of `gepaLineage.ts`, and independently
 * cross-checked against WebCrypto at capture time. These bytes are frozen into
 * stored optimizer artifacts, so a change here is a compatibility break, not a
 * test update.
 *
 * The 55/56/64/119-char rows straddle the SHA-256 block-padding boundaries
 * (a 55-byte message pads into one block, 56 into two), which is where a
 * padding bug hides.
 */
const FROZEN_FINGERPRINTS: ReadonlyArray<readonly [string, string]> = [
  ['', 'sha256-64:e3b0c44298fc1c14'],
  ['a', 'sha256-64:ca978112ca1bbdca'],
  ['instruction', 'sha256-64:5a92f6f089f63f0d'],
  ['x'.repeat(55), 'sha256-64:d5e285683cd4efc0'],
  ['x'.repeat(56), 'sha256-64:04c26261370ee754'],
  ['x'.repeat(64), 'sha256-64:7ce100971f64e700'],
  ['y'.repeat(119), 'sha256-64:0ee964660d4956e3'],
  [
    '{"componentId":"root::instruction","value":"base"}',
    'sha256-64:2308914e1aa6263b',
  ],
  ['café-naïve-Straße', 'sha256-64:3d14ce79253f279c'],
  [
    '\u{1D518}\u{1D52B}\u{1D526}\u{1D520}\u{1D52C}\u{1D521}\u{1D522} \u{1F732} astral',
    'sha256-64:8b45c12d65c72b35',
  ],
  ['line1\nline2\r\nline3 tail', 'sha256-64:80ede98ccd694b69'],
  ['M'.repeat(1024 * 1024), 'sha256-64:aaa3cd5353fcf55c'],
];

/**
 * Published FNV-1a 64 reference vectors (Fowler/Noll/Vo). Independent of this
 * implementation, so a rewritten hash cannot silently agree with itself.
 */
const FNV1A64_REFERENCE: ReadonlyArray<readonly [string, string]> = [
  ['', 'fnv1a64:cbf29ce484222325'],
  ['a', 'fnv1a64:af63dc4c8601ec8c'],
  ['b', 'fnv1a64:af63df4c8601f1a5'],
  ['c', 'fnv1a64:af63de4c8601eff2'],
  ['foobar', 'fnv1a64:85944171f73967e8'],
  ['chongo <Landon Curt Noll> /\\../\\', 'fnv1a64:2c8f4c9af81bcf06'],
];

describe('optimizer digests', () => {
  it('preserves fingerprintGEPAValue bytes across the sha256BytesSync move', () => {
    for (const [input, expected] of FROZEN_FINGERPRINTS) {
      expect(axSha256Digest64Sync(input)).toBe(expected);
      // The lineage entry point must still emit the same bytes: it is what
      // wrote every fingerprint already sitting in a stored artifact.
      expect(fingerprintGEPAValue(input)).toBe(expected);
    }
  });

  it('agrees with WebCrypto on the truncated correlation digest', async () => {
    // The reuse claim ("this is SHA-256, just truncated") is executable rather
    // than asserted: the hand-rolled sync implementation is compared against
    // the platform digest on every frozen vector, 1 MiB included.
    for (const [input] of FROZEN_FINGERPRINTS) {
      expect(axSha256Digest64Sync(input)).toBe(
        `sha256-64:${(await sha256(input)).slice(0, 16)}`
      );
    }
  });

  it('agrees with WebCrypto on the identity digest', async () => {
    for (const [input] of FROZEN_FINGERPRINTS) {
      expect(await axSha256Digest(input)).toBe(`sha256:${await sha256(input)}`);
    }
  });

  it('matches the published fnv1a64 reference vectors', () => {
    for (const [input, expected] of FNV1A64_REFERENCE) {
      expect(axFnv1a64Digest(input)).toBe(expected);
    }
  });

  it('reproduces the playbookEvolve retention-digest construction', () => {
    // `playbookEvolve.canonicalDigest` is FNV-1a 64 over its canonical
    // serialization, and a plain string serializes as `string:<JSON>`. Hashing
    // that exact framing here is what lets a reader correlate a retention
    // digest with an optimizer-side checksum without unifying the two
    // vocabularies. Both hash UTF-16 code units, not UTF-8 bytes.
    expect(axFnv1a64Digest('string:"abc"')).toBe('fnv1a64:021007b8671db112');
  });

  it('separates the three digest strengths by prefix', () => {
    expect(axDigestStrength('fnv1a64:cbf29ce484222325')).toBe('checksum');
    expect(axDigestStrength('sha256-64:e3b0c44298fc1c14')).toBe('correlation');
    expect(axDigestStrength(`sha256:${'a'.repeat(64)}`)).toBe('identity');
    // An unprefixed hex string is not a digest this subsystem will accept, no
    // matter how long it is.
    expect(axDigestStrength('a'.repeat(64))).toBeUndefined();
    expect(axDigestStrength('sha256:')).toBeUndefined();
    // Wrong width for the prefix must not pass as the stronger form.
    expect(axDigestStrength('sha256:e3b0c44298fc1c14')).toBeUndefined();
    expect(axDigestStrength('sha256-64:e3b0c44298fc1c1')).toBeUndefined();
    // Uppercase hex is a different byte string; the guards are exact.
    expect(axDigestStrength('sha256-64:E3B0C44298FC1C14')).toBeUndefined();
  });

  it('guards each digest form structurally', () => {
    const checksum = 'fnv1a64:cbf29ce484222325';
    const correlation = 'sha256-64:e3b0c44298fc1c14';
    const identity = `sha256:${'0'.repeat(64)}`;
    expect(axIsFnv1a64Digest(checksum)).toBe(true);
    expect(axIsFnv1a64Digest(correlation)).toBe(false);
    expect(axIsSha256Digest64(correlation)).toBe(true);
    expect(axIsSha256Digest64(identity)).toBe(false);
    expect(axIsSha256Digest(identity)).toBe(true);
    // `sha256-64:` must never satisfy the identity guard: that confusion is the
    // whole reason the brands exist.
    expect(axIsSha256Digest(correlation)).toBe(false);
  });

  it('refuses a truncated digest where identity is required', () => {
    expect(() =>
      axAssertDigestStrength(
        'sha256-64:e3b0c44298fc1c14',
        'identity',
        'harness.recipeDigest'
      )
    ).toThrowError(
      expect.objectContaining({
        name: 'AxDigestStrengthError',
        code: 'digest_strength_insufficient',
        field: 'harness.recipeDigest',
        observed: 'correlation',
        required: 'identity',
      })
    );
    expect(() =>
      axAssertDigestStrength(
        'fnv1a64:cbf29ce484222325',
        'correlation',
        'delta.afterFingerprint'
      )
    ).toThrowError(
      expect.objectContaining({ observed: 'checksum', required: 'correlation' })
    );
    expect(() =>
      axAssertDigestStrength('not-a-digest', 'checksum', 'entry.digest')
    ).toThrowError(expect.objectContaining({ observed: 'unknown' }));
  });

  it('accepts a digest at or above the required strength', () => {
    expect(() =>
      axAssertDigestStrength(`sha256:${'0'.repeat(64)}`, 'correlation', 'field')
    ).not.toThrow();
    expect(() =>
      axAssertDigestStrength(
        'sha256-64:e3b0c44298fc1c14',
        'correlation',
        'field'
      )
    ).not.toThrow();
    expect(() =>
      axAssertDigestStrength('fnv1a64:cbf29ce484222325', 'checksum', 'field')
    ).not.toThrow();
  });

  it('recognizes its own error structurally across realms', () => {
    let thrown: unknown;
    try {
      axAssertDigestStrength('fnv1a64:cbf29ce484222325', 'identity', 'field');
    } catch (error) {
      thrown = error;
    }
    expect(axIsDigestStrengthError(thrown)).toBe(true);
    // A store loaded through a second copy of the package throws an object that
    // fails `instanceof`; the guard must still recognize it.
    expect(
      axIsDigestStrengthError({
        code: 'digest_strength_insufficient',
        required: 'identity',
      })
    ).toBe(true);
    expect(axIsDigestStrengthError(new Error('nope'))).toBe(false);
    expect(
      axIsDigestStrengthError({ code: 'digest_strength_insufficient' })
    ).toBe(false);
    expect(axIsDigestStrengthError(undefined)).toBe(false);
  });

  it('does not export a synchronous identity digest', async () => {
    // Guards the build-vs-buy decision against being quietly reversed: nothing
    // here may hand back a `sha256:` value without awaiting WebCrypto.
    const module: Record<string, unknown> = await import('./digests.js');
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'function') continue;
      let produced: unknown;
      try {
        produced = (value as (input: string) => unknown)('probe');
      } catch {
        continue;
      }
      if (typeof produced === 'string') {
        expect(
          axDigestStrength(produced),
          `${name} returned an identity digest synchronously`
        ).not.toBe('identity');
      }
    }
    // ...and the async one still does.
    expect(axDigestStrength(await axSha256Digest('probe'))).toBe('identity');
  });
});
