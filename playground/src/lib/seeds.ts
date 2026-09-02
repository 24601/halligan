/**
 * Determinism. `Math.random` is never called in demo code: a seed is threaded
 * explicitly so two visitors with the same seed see byte-identical figures,
 * which is also what makes the pinned Playwright screenshots possible.
 *
 * xorshift128+ (Vigna 2014), 32-bit lanes so it is exact in JS integers.
 */
export interface AxPrng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, bound). */
  int(bound: number): number;
  pick<T>(items: readonly T[]): T;
}

export function prng(seed: number): AxPrng {
  // splitmix32 to spread a small integer seed across four lanes.
  let z = seed >>> 0 || 0x9e3779b9;
  const mix = (): number => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();

  const nextUint = (): number => {
    // xoshiro128** -- same family, exact in 32-bit lanes.
    const result = (Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };

  return {
    next: () => nextUint() / 0x1_0000_0000,
    int: (bound: number) => Math.floor((nextUint() / 0x1_0000_0000) * bound),
    pick: <T>(items: readonly T[]): T => {
      const value =
        items[Math.floor((nextUint() / 0x1_0000_0000) * items.length)];
      if (value === undefined) throw new Error('prng.pick on an empty list');
      return value;
    },
  };
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

export const defaultSeed = 7;

/** The pinned wall-clock origin every manual clock starts from. */
export const epochOrigin = Date.UTC(2026, 0, 7, 9, 0, 0);

export function parseSeed(raw: string | null | undefined): number {
  if (!raw) return defaultSeed;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 && value <= 999_999
    ? value
    : defaultSeed;
}
