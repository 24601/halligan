import { axEventCanonicalJson, axEventId } from '../event/util.js';
import type { AxTrajectoryFieldValue, AxTrajectoryStep } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Prefixed id generator shared by every trajectory store implementation. */
export function axTrajectoryId(prefix: string): string {
  return axEventId(prefix);
}

/** UTF-8 byte length, which is the only size a spill policy may reason about. */
export function axTrajectoryUtf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * A split multi-byte sequence would decode to U+FFFD and silently corrupt the
 * inline head that every non-rehydrating reader sees.
 */
export function axTrajectoryTruncateUtf8(
  value: string,
  maxBytes: number
): string {
  if (maxBytes <= 0) return '';
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  // Walk back off any continuation byte (0b10xxxxxx) so the slice ends on a
  // code-point boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * Normalize a caller timestamp. Returns undefined when the value is not a
 * finite epoch-millisecond number, so the store can fail closed rather than
 * writing NaN into the log (invariant I11).
 */
export function axNormalizeTrajectoryTimestamp(
  value: unknown
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

/**
 * Depth-first persistability check. Mirrors the event plane: finite numbers,
 * strings, booleans, null, arrays and plain objects only, and no cycles.
 * Returns the offending path, or undefined when the value is persistable.
 */
export function axTrajectoryInvalidFieldPath(
  value: unknown,
  path = 'data'
): string | undefined {
  const walk = (
    current: unknown,
    at: string,
    seen: Set<object>
  ): string | undefined => {
    if (current === null) return undefined;
    const kind = typeof current;
    if (kind === 'string' || kind === 'boolean') return undefined;
    if (kind === 'number') {
      return Number.isFinite(current as number) ? undefined : at;
    }
    if (kind !== 'object') return at;
    const object = current as object;
    if (seen.has(object)) return at;
    seen.add(object);
    if (Array.isArray(object)) {
      for (const [index, item] of object.entries()) {
        const bad = walk(item, `${at}[${index}]`, seen);
        if (bad) return bad;
      }
      seen.delete(object);
      return undefined;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return at;
    for (const [key, item] of Object.entries(object)) {
      if (item === undefined) continue;
      const bad = walk(item, `${at}.${key}`, seen);
      if (bad) return bad;
    }
    seen.delete(object);
    return undefined;
  };
  return walk(value, path, new Set<object>());
}

/** Drop undefined entries so a step's data is canonically comparable. */
export function axTrajectoryCompactData(
  data: Readonly<Record<string, AxTrajectoryFieldValue>> | undefined
): Readonly<Record<string, AxTrajectoryFieldValue>> {
  if (!data) return {};
  const out: Record<string, AxTrajectoryFieldValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Canonical bytes for one step, used to decide whether a preset stepId is an
 * identical replay (receipt.duplicate) or a genuine collision (which throws).
 * `seq` and `ts` are excluded because the store assigns them.
 */
export function axTrajectoryStepFingerprint(
  step: Readonly<
    Pick<
      AxTrajectoryStep,
      | 'stepId'
      | 'trajectoryId'
      | 'type'
      | 'runId'
      | 'triggerStep'
      | 'launchedBy'
      | 'source'
      | 'data'
    >
  >
): string {
  return axEventCanonicalJson({
    stepId: step.stepId,
    trajectoryId: step.trajectoryId,
    type: step.type,
    runId: step.runId,
    triggerStep: step.triggerStep,
    launchedBy: step.launchedBy,
    source: step.source,
    data: step.data,
  });
}

/** Approximate on-the-wire size of a step, for drain byte budgets. */
export function axTrajectoryStepBytes(
  step: Readonly<AxTrajectoryStep>
): number {
  return axTrajectoryUtf8ByteLength(axEventCanonicalJson(step));
}
