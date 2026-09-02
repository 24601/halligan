/**
 * The repo's JSON-persistability check, shared by every subsystem that has to
 * store caller-supplied values and must fail loudly rather than let a
 * canonical encoder silently coerce them.
 *
 * `JSON.stringify` is not a validator: it flattens a `Map`/`Set` to `{}`, runs
 * a `Date` through `toJSON`, turns a non-finite number into `null`, and throws
 * on a cycle at an arbitrary later point. This walks the value first and
 * reports the JSON path of the offending node — never the value itself, so an
 * error message can be logged without leaking content.
 */

/** The set of prototypes a persistable object may have. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(
  value: unknown,
  path: string,
  label: string,
  seen: Set<object>
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} at ${path} must be a finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} at ${path} is not persistable`);
  }
  if (seen.has(value)) throw new Error(`${label} at ${path} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walk(item, `${path}[${index}]`, label, seen)
    );
  } else {
    if (!isPlainObject(value)) {
      throw new Error(`${label} at ${path} must be a plain object`);
    }
    for (const [key, item] of Object.entries(value)) {
      walk(item, `${path}.${key}`, label, seen);
    }
  }
  seen.delete(value);
}

/**
 * Throw unless `value` is a JSON-persistable tree: finite numbers, strings,
 * booleans, `null`, arrays, and plain objects only — no cycles, no class
 * instances, no `Map`/`Set`/`Date`, no functions or symbols.
 *
 * `path` is the JSON path of `value` inside the record being validated and is
 * prefixed onto every message. `options.label` names the kind of value for the
 * message (default `'Value'`); callers with an established error wording pass
 * their own so their messages stay stable.
 */
export function axAssertPersistableValue(
  value: unknown,
  path: string,
  options?: Readonly<{ label?: string }>
): void {
  walk(value, path, options?.label ?? 'Value', new Set<object>());
}
