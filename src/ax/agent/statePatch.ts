/**
 * A portable RFC 6902 subset: `add`, `remove`, `replace` and `test`.
 *
 * `move` and `copy` are deliberately excluded — their provenance is ambiguous
 * (the resulting value has two paths and no single origin), which makes them
 * impossible to classify against a delta table and impossible to gate on
 * evidence.
 *
 * The subset exists so a model can propose a bounded, inspectable mutation of
 * a typed working-state document. Every function here is pure and
 * deterministic: validation never applies, application never mutates its
 * input, and the same patch applied to the same base always produces the same
 * bytes. That determinism is what makes the behaviour re-expressible as AxIR
 * Core ops in the other target languages.
 *
 * There is no runtime dependency: the needed subset is four ops over a plain
 * object, and `src/ax` builds `platform: 'neutral'` with exactly one runtime
 * dependency. See `docs/AGENT_WORKING_STATE.md` for the build-vs-buy record.
 */

import { axEventCanonicalJson } from '../event/util.js';

/** RFC 6902 subset. `move`/`copy` are excluded: their provenance is ambiguous. */
export type AxStatePatchOp =
  | Readonly<{ op: 'add'; path: string; value: unknown }>
  | Readonly<{ op: 'remove'; path: string }>
  | Readonly<{ op: 'replace'; path: string; value: unknown }>
  /** Guard only. Never removed by parking; a failing guard rejects the whole patch. */
  | Readonly<{ op: 'test'; path: string; value: unknown }>;

export type AxStatePatch = readonly AxStatePatchOp[];

export type AxStatePatchInvalidCode =
  | 'not_an_array'
  | 'not_an_object'
  | 'unknown_op'
  | 'missing_path'
  | 'malformed_pointer'
  | 'missing_value'
  /** `remove`/`replace`/`test` addressed at the `-` append token. */
  | 'append_token_not_allowed'
  | 'patch_too_large';

export type AxStatePatchValidation =
  | Readonly<{ status: 'valid'; patch: AxStatePatch }>
  | Readonly<{
      status: 'invalid';
      /** Index of the first offending op, or -1 when the document itself is malformed. */
      index: number;
      code: AxStatePatchInvalidCode;
      detail: string;
    }>;

export type AxStatePatchApplyResult<T> =
  | Readonly<{ status: 'applied'; value: T }>
  | Readonly<{
      status: 'rejected';
      index: number;
      code:
        | 'path_not_found'
        | 'test_failed'
        | 'index_out_of_range'
        | 'type_mismatch';
      detail: string;
    }>;

const DEFAULT_MAX_OPS = 64;
const DEFAULT_MAX_SERIALIZED_BYTES = 16_384;

/** Segments that could reach `Object.prototype` through a plain property write. */
const POLLUTION_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

const KNOWN_OPS = new Set(['add', 'remove', 'replace', 'test']);

/**
 * Parse a JSON Pointer into its decoded segments. Returns `undefined` when the
 * pointer is malformed (non-empty and not `/`-prefixed) or when any segment
 * could reach the prototype chain.
 */
export function parseStatePatchPointer(
  pointer: string
): readonly string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const raw of pointer.slice(1).split('/')) {
    // RFC 6901 escaping: `~1` is `/` and `~0` is `~`, decoded in that order.
    if (/~(?![01])/.test(raw)) return undefined;
    const decoded = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (POLLUTION_SEGMENTS.has(decoded)) return undefined;
    segments.push(decoded);
  }
  return segments;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and shape-checks an untrusted patch document. Never applies it.
 * `maxOps` defaults to 64; `maxSerializedBytes` defaults to 16 KiB.
 * Rejects `-` as the final segment for every op except `add`.
 */
export const axValidateStatePatch = (
  document: unknown,
  limits?: Readonly<{ maxOps?: number; maxSerializedBytes?: number }>
): AxStatePatchValidation => {
  const maxOps = limits?.maxOps ?? DEFAULT_MAX_OPS;
  const maxSerializedBytes =
    limits?.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;

  if (!Array.isArray(document)) {
    return {
      status: 'invalid',
      index: -1,
      code: 'not_an_array',
      detail: `patch document must be an array, received ${
        document === null ? 'null' : typeof document
      }`,
    };
  }

  if (document.length > maxOps) {
    return {
      status: 'invalid',
      index: -1,
      code: 'patch_too_large',
      detail: `patch has ${document.length} ops, limit is ${maxOps}`,
    };
  }

  // Serialized size is checked before any per-op work so an adversarial
  // document cannot make validation expensive.
  let serializedBytes: number;
  try {
    serializedBytes = axEventCanonicalJson(document).length;
  } catch {
    return {
      status: 'invalid',
      index: -1,
      code: 'not_an_array',
      detail: 'patch document is not serializable',
    };
  }
  if (serializedBytes > maxSerializedBytes) {
    return {
      status: 'invalid',
      index: -1,
      code: 'patch_too_large',
      detail: `patch serializes to ${serializedBytes} bytes, limit is ${maxSerializedBytes}`,
    };
  }

  for (let index = 0; index < document.length; index++) {
    const candidate = document[index];
    if (!isPlainRecord(candidate)) {
      return {
        status: 'invalid',
        index,
        code: 'not_an_object',
        detail: 'each patch op must be a plain object',
      };
    }
    const op = candidate.op;
    if (typeof op !== 'string' || !KNOWN_OPS.has(op)) {
      return {
        status: 'invalid',
        index,
        code: 'unknown_op',
        detail: `unsupported op ${JSON.stringify(op)}; only add, remove, replace and test are accepted`,
      };
    }
    const path = candidate.path;
    if (typeof path !== 'string') {
      return {
        status: 'invalid',
        index,
        code: 'missing_path',
        detail: 'op.path must be a string JSON Pointer',
      };
    }
    const segments = parseStatePatchPointer(path);
    if (!segments) {
      return {
        status: 'invalid',
        index,
        code: 'malformed_pointer',
        detail: `path ${JSON.stringify(path)} is not a safe JSON Pointer`,
      };
    }
    if (op !== 'add' && segments[segments.length - 1] === '-') {
      return {
        status: 'invalid',
        index,
        code: 'append_token_not_allowed',
        detail: `the - append token is only valid for add, not ${op}`,
      };
    }
    if (op !== 'remove' && !('value' in candidate)) {
      return {
        status: 'invalid',
        index,
        code: 'missing_value',
        detail: `${op} requires a value`,
      };
    }
  }

  return { status: 'valid', patch: document as AxStatePatch };
};

type Rejection = Readonly<{
  code:
    | 'path_not_found'
    | 'test_failed'
    | 'index_out_of_range'
    | 'type_mismatch';
  detail: string;
}>;

/** Resolve the container that holds `segments[last]`, or a rejection. */
function resolveParent(
  root: unknown,
  segments: readonly string[]
): { parent: unknown } | Rejection {
  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) {
        return {
          code: 'type_mismatch',
          detail: `array segment ${segment} is not an index`,
        };
      }
      if (index >= current.length) {
        return {
          code: 'index_out_of_range',
          detail: `array index ${index} is beyond length ${current.length}`,
        };
      }
      current = current[index];
      continue;
    }
    if (isPlainRecord(current)) {
      if (!Object.hasOwn(current, segment)) {
        return { code: 'path_not_found', detail: `missing segment ${segment}` };
      }
      current = current[segment];
      continue;
    }
    return {
      code: 'type_mismatch',
      detail: `cannot traverse segment ${segment} of a non-container`,
    };
  }
  return { parent: current };
}

function isRejection(value: unknown): value is Rejection {
  return isPlainRecord(value) && typeof value.code === 'string';
}

function readPointer(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (isPlainRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function pointerExists(root: unknown, segments: readonly string[]): boolean {
  if (segments.length === 0) return true;
  const resolved = resolveParent(root, segments);
  if (isRejection(resolved)) return false;
  const parent = (resolved as { parent: unknown }).parent;
  const last = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    const index = Number(last);
    return Number.isInteger(index) && index >= 0 && index < parent.length;
  }
  return isPlainRecord(parent) && Object.hasOwn(parent, last);
}

function applyOp(
  root: unknown,
  op: AxStatePatchOp
): { root: unknown } | Rejection {
  const segments = parseStatePatchPointer(op.path);
  if (!segments) {
    return { code: 'type_mismatch', detail: `unparsable pointer ${op.path}` };
  }

  if (segments.length === 0) {
    // Whole-document ops. `remove` at the root has no meaning here.
    switch (op.op) {
      case 'test':
        return axEventCanonicalJson(root) === axEventCanonicalJson(op.value)
          ? { root }
          : { code: 'test_failed', detail: 'root document did not match' };
      case 'add':
      case 'replace':
        return { root: structuredClone(op.value) };
      case 'remove':
        return {
          code: 'type_mismatch',
          detail: 'cannot remove the root document',
        };
    }
  }

  const resolved = resolveParent(root, segments);
  if (isRejection(resolved)) return resolved;
  const parent = (resolved as { parent: unknown }).parent;
  const last = segments[segments.length - 1]!;

  if (op.op === 'test') {
    if (!pointerExists(root, segments)) {
      return {
        code: 'test_failed',
        detail: `guard path ${op.path} does not exist`,
      };
    }
    const actual = readPointer(root, segments);
    return axEventCanonicalJson(actual) === axEventCanonicalJson(op.value)
      ? { root }
      : { code: 'test_failed', detail: `guard at ${op.path} did not match` };
  }

  if (Array.isArray(parent)) {
    if (last === '-') {
      if (op.op !== 'add') {
        return { code: 'type_mismatch', detail: 'append token requires add' };
      }
      parent.push(structuredClone((op as { value: unknown }).value));
      return { root };
    }
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0) {
      return {
        code: 'type_mismatch',
        detail: `array segment ${last} is not an index`,
      };
    }
    const upperBound = op.op === 'add' ? parent.length : parent.length - 1;
    if (index > upperBound) {
      return {
        code: 'index_out_of_range',
        detail: `array index ${index} is beyond length ${parent.length}`,
      };
    }
    if (op.op === 'add') {
      parent.splice(
        index,
        0,
        structuredClone((op as { value: unknown }).value)
      );
    } else if (op.op === 'remove') {
      parent.splice(index, 1);
    } else {
      parent[index] = structuredClone((op as { value: unknown }).value);
    }
    return { root };
  }

  if (!isPlainRecord(parent)) {
    return {
      code: 'type_mismatch',
      detail: `cannot address ${last} on a non-container`,
    };
  }

  if (last === '-') {
    return { code: 'type_mismatch', detail: 'append token requires an array' };
  }

  if (op.op === 'remove' || op.op === 'replace') {
    if (!Object.hasOwn(parent, last)) {
      return { code: 'path_not_found', detail: `missing key ${last}` };
    }
  }

  if (op.op === 'remove') {
    delete parent[last];
  } else {
    parent[last] = structuredClone((op as { value: unknown }).value);
  }
  return { root };
}

/**
 * Applies a validated patch to a deep clone of `value`. All-or-nothing: on any
 * failing op the input is returned untouched and the result is `rejected`.
 * Pure, deterministic, structuredClone-based — no prototype writes, no
 * `__proto__` or `constructor` segments (they are rejected as
 * `malformed_pointer` upstream, and refused again here).
 */
export const axApplyStatePatch = <T>(
  value: Readonly<T>,
  patch: AxStatePatch
): AxStatePatchApplyResult<T> => {
  let draft: unknown = structuredClone(value) as unknown;
  for (let index = 0; index < patch.length; index++) {
    const outcome = applyOp(draft, patch[index]!);
    if (isRejection(outcome)) {
      return {
        status: 'rejected',
        index,
        code: outcome.code,
        detail: outcome.detail,
      };
    }
    draft = (outcome as { root: unknown }).root;
  }
  return { status: 'applied', value: draft as T };
};
