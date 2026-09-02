import { describe, expect, it } from 'vitest';

import { axAssertPersistableValue } from './persistable.js';

describe('axAssertPersistableValue', () => {
  it('accepts the JSON scalar and container set', () => {
    expect(() =>
      axAssertPersistableValue(
        {
          text: 'ok',
          flag: false,
          nothing: null,
          count: 0,
          nested: [{ deep: [1, 'two', true, null] }],
          empty: {},
        },
        'payload'
      )
    ).not.toThrow();
  });

  it('rejects a non-finite number and names its path', () => {
    expect(() =>
      axAssertPersistableValue({ metrics: { score: Number.NaN } }, 'payload')
    ).toThrow('Value at payload.metrics.score must be a finite number');
    expect(() =>
      axAssertPersistableValue([Number.POSITIVE_INFINITY], 'payload')
    ).toThrow('Value at payload[0] must be a finite number');
  });

  it('rejects a class instance, a Date, a Map and a Set as non-plain objects', () => {
    class Holder {
      value = 1;
    }
    for (const value of [new Holder(), new Date(0), new Map(), new Set()]) {
      expect(() => axAssertPersistableValue({ value }, 'payload')).toThrow(
        'Value at payload.value must be a plain object'
      );
    }
  });

  it('rejects a function and a symbol as not persistable', () => {
    expect(() => axAssertPersistableValue({ run: () => 1 }, 'payload')).toThrow(
      'Value at payload.run is not persistable'
    );
    expect(() =>
      axAssertPersistableValue({ tag: Symbol('x') }, 'payload')
    ).toThrow('Value at payload.tag is not persistable');
    // `undefined` is not a JSON value: JSON.stringify would drop the key
    // silently, so it has to be rejected rather than coerced.
    expect(() =>
      axAssertPersistableValue({ missing: undefined }, 'payload')
    ).toThrow('Value at payload.missing is not persistable');
  });

  it('detects a cycle at the path where it closes', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => axAssertPersistableValue(cyclic, 'payload')).toThrow(
      'Value at payload.self is cyclic'
    );
  });

  it('allows the same object to appear twice on disjoint branches', () => {
    // A repeated (non-cyclic) reference is perfectly serializable; only a
    // reference back into an ancestor is a cycle, so `seen` must be unwound.
    const shared = { id: 'shared' };
    expect(() =>
      axAssertPersistableValue({ a: shared, b: shared }, 'payload')
    ).not.toThrow();
  });

  it('uses the caller-supplied label so existing wordings stay stable', () => {
    expect(() =>
      axAssertPersistableValue({ n: Number.NaN }, 'data', {
        label: 'Event value',
      })
    ).toThrow('Event value at data.n must be a finite number');
  });
});
