/**
 * Canonicalization primitives shared by `agent.playbook().evolve()` and its
 * evidence modules.
 *
 * Pure move out of `playbookEvolve.ts` so the evidence modules can freeze,
 * serialize and digest without importing the orchestrator (which would be a
 * cycle). Behaviour is byte-identical to the pre-move implementation: the
 * error messages keep the `AxAgent.playbook().evolve(): ` prefix and the same
 * `retention digest` wording, because they are pinned by existing tests and by
 * the retention receipts already in the wild.
 */

export function deepFreeze<T>(
  value: T,
  seen = new WeakSet<object>()
): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) {
      deepFreeze(child, seen);
    }
    // JavaScript rejects Object.freeze() for non-empty typed arrays. The
    // structured clone still isolates this snapshot from caller mutation.
    if (!ArrayBuffer.isView(value)) Object.freeze(value);
  }
  return value;
}

export function cloneAndFreeze<T>(value: T, label: string): Readonly<T> {
  try {
    return deepFreeze(structuredClone(value));
  } catch (err) {
    throw new Error(
      `AxAgent.playbook().evolve(): ${label} must be structured-cloneable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function canonicalSerialize(
  value: unknown,
  seen = new WeakSet<object>()
): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention digest values must be finite.'
      );
    }
    return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention digest values must not contain cycles.'
      );
    }
    seen.add(value);
    const serialized = `array:length:${value.length}:{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSerialize(
            (value as unknown as Record<string, unknown>)[key],
            seen
          )}`
      )
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(
        'AxAgent.playbook().evolve(): retention digest values must not contain cycles.'
      );
    }
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) {
        throw new Error(
          'AxAgent.playbook().evolve(): retention digest Date values must be valid.'
        );
      }
      return `date:${value.toISOString()}`;
    }
    seen.add(value);
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(
          ([key, entryValue]) =>
            `entry:[${canonicalSerialize(key, seen)},${canonicalSerialize(entryValue, seen)}]`
        )
        .sort();
      seen.delete(value);
      return `map:[${entries.join(',')}]`;
    }
    if (value instanceof Set) {
      const entries = [...value].map((item) => canonicalSerialize(item, seen));
      entries.sort();
      seen.delete(value);
      return `set:[${entries.join(',')}]`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength
      );
      const serialized = [...bytes]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      seen.delete(value);
      return `view:${value.constructor.name}:${serialized}`;
    }
    if (value instanceof ArrayBuffer) {
      const serialized = [...new Uint8Array(value)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      seen.delete(value);
      return `arraybuffer:${serialized}`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(value);
      throw new Error(
        'AxAgent.playbook().evolve(): unsupported retention digest object value.'
      );
    }
    const record = value as Record<string, unknown>;
    const serialized = `object:{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSerialize(record[key], seen)}`
      )
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  throw new Error(
    `AxAgent.playbook().evolve(): unsupported retention digest value type ${typeof value}.`
  );
}

export function canonicalDigest(value: unknown): string {
  const input = canonicalSerialize(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function atMostWithFloatingPointTolerance(
  value: number,
  limit: number
): boolean {
  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(limit)) * 4;
  return value <= limit + tolerance;
}
