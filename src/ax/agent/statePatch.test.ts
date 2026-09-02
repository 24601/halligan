import { describe, expect, it } from 'vitest';
import {
  type AxStatePatch,
  axApplyStatePatch,
  axValidateStatePatch,
} from './statePatch.js';

/** A document with the shapes the goal ledger actually uses. */
const makeDocument = () => ({
  schemaVersion: 1,
  goals: {
    a: { id: 'a', status: 'pending', evidence: [] as unknown[] },
    b: { id: 'b', status: 'pending', evidence: [{ ref: 'r1' }] },
  },
  facts: { orderId: '42', itemsPacked: 0 },
  parked: [] as unknown[],
});

function expectValid(document: unknown): AxStatePatch {
  const validation = axValidateStatePatch(document);
  if (validation.status !== 'valid') {
    throw new Error(
      `expected a valid patch, got ${validation.code}: ${validation.detail}`
    );
  }
  return validation.patch;
}

describe('axValidateStatePatch', () => {
  it('rejects a non-array patch document', () => {
    // The document arrives from an untrusted model output field, so a wrong
    // shape must be data, never a throw.
    const validation = axValidateStatePatch({
      op: 'add',
      path: '/x',
      value: 1,
    });
    expect(validation).toEqual({
      status: 'invalid',
      index: -1,
      code: 'not_an_array',
      detail: expect.stringContaining('must be an array'),
    });
  });

  it('rejects a non-object op', () => {
    const validation = axValidateStatePatch([['add', '/x', 1]]);
    expect(validation.status).toBe('invalid');
    expect(validation).toMatchObject({ index: 0, code: 'not_an_object' });
  });

  it('rejects move and copy ops as unknown_op', () => {
    // The excluded ops are excluded by data, not by omission from a switch.
    for (const op of ['move', 'copy']) {
      const validation = axValidateStatePatch([
        { op, from: '/goals/a', path: '/goals/c' },
      ]);
      expect(validation).toMatchObject({
        status: 'invalid',
        index: 0,
        code: 'unknown_op',
      });
    }
  });

  it('rejects a missing or non-string path', () => {
    expect(axValidateStatePatch([{ op: 'remove' }])).toMatchObject({
      code: 'missing_path',
    });
    expect(axValidateStatePatch([{ op: 'remove', path: 3 }])).toMatchObject({
      code: 'missing_path',
    });
  });

  it('rejects pointers containing __proto__, constructor, or prototype', () => {
    for (const path of [
      '/__proto__/polluted',
      '/goals/constructor',
      '/goals/a/prototype/x',
    ]) {
      expect(
        axValidateStatePatch([{ op: 'add', path, value: 1 }])
      ).toMatchObject({ status: 'invalid', code: 'malformed_pointer' });
    }
  });

  it('rejects a pointer that does not start with a slash', () => {
    expect(
      axValidateStatePatch([{ op: 'add', path: 'goals/a', value: 1 }])
    ).toMatchObject({ code: 'malformed_pointer' });
  });

  it('rejects the - append token for remove, replace and test', () => {
    // RFC 6902 permits `-` only for `add`.
    for (const op of ['remove', 'replace', 'test']) {
      expect(
        axValidateStatePatch([
          { op, path: '/goals/a/evidence/-', value: { ref: 'r1' } },
        ])
      ).toMatchObject({
        status: 'invalid',
        index: 0,
        code: 'append_token_not_allowed',
      });
    }
    expect(
      axValidateStatePatch([
        { op: 'add', path: '/goals/a/evidence/-', value: { ref: 'r1' } },
      ]).status
    ).toBe('valid');
  });

  it('rejects add, replace and test without a value', () => {
    for (const op of ['add', 'replace', 'test']) {
      expect(axValidateStatePatch([{ op, path: '/facts/x' }])).toMatchObject({
        code: 'missing_value',
      });
    }
    // `remove` legitimately has no value.
    expect(
      axValidateStatePatch([{ op: 'remove', path: '/facts/x' }]).status
    ).toBe('valid');
  });

  it('rejects a patch above maxOps and above maxSerializedBytes', () => {
    const many = Array.from({ length: 65 }, () => ({
      op: 'add',
      path: '/facts/x',
      value: 1,
    }));
    expect(axValidateStatePatch(many)).toMatchObject({
      code: 'patch_too_large',
      index: -1,
    });

    const fat = [{ op: 'add', path: '/facts/x', value: 'y'.repeat(20_000) }];
    expect(axValidateStatePatch(fat)).toMatchObject({
      code: 'patch_too_large',
    });

    // The limits are configurable, and both bounds are actually consulted.
    expect(
      axValidateStatePatch(fat, { maxSerializedBytes: 40_000 }).status
    ).toBe('valid');
    expect(axValidateStatePatch(many, { maxOps: 100 }).status).toBe('valid');
  });
});

describe('axApplyStatePatch', () => {
  it('applies add/replace/remove to a deep clone and leaves the input untouched', () => {
    const base = makeDocument();
    const before = JSON.stringify(base);
    const result = axApplyStatePatch(
      base,
      expectValid([
        { op: 'add', path: '/facts/carrier', value: 'UPS' },
        { op: 'replace', path: '/facts/itemsPacked', value: 3 },
        { op: 'remove', path: '/facts/orderId' },
      ])
    );

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.value.facts).toEqual({ itemsPacked: 3, carrier: 'UPS' });
    // Purity: the caller's document is never mutated.
    expect(JSON.stringify(base)).toBe(before);
  });

  it('a passing test op is a no-op and the rest of the patch applies', () => {
    const base = makeDocument();
    const result = axApplyStatePatch(
      base,
      expectValid([
        { op: 'test', path: '/facts/itemsPacked', value: 0 },
        { op: 'replace', path: '/facts/itemsPacked', value: 7 },
      ])
    );
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.value.facts.itemsPacked).toBe(7);
  });

  it('a failing test op returns the original value untouched', () => {
    const base = makeDocument();
    const result = axApplyStatePatch(
      base,
      expectValid([
        { op: 'replace', path: '/facts/itemsPacked', value: 7 },
        { op: 'test', path: '/facts/orderId', value: '99' },
      ])
    );
    expect(result).toMatchObject({
      status: 'rejected',
      index: 1,
      code: 'test_failed',
    });
    expect(base.facts.itemsPacked).toBe(0);
  });

  it('a test against a missing path fails rather than passing vacuously', () => {
    const result = axApplyStatePatch(
      makeDocument(),
      expectValid([{ op: 'test', path: '/facts/nope', value: undefined }])
    );
    expect(result).toMatchObject({ status: 'rejected', code: 'test_failed' });
  });

  it('rejects an array index beyond length with index_out_of_range', () => {
    const result = axApplyStatePatch(
      makeDocument(),
      expectValid([
        { op: 'replace', path: '/goals/b/evidence/4', value: { ref: 'r9' } },
      ])
    );
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'index_out_of_range',
    });
  });

  it('rejects a replace at a missing object key with path_not_found', () => {
    const result = axApplyStatePatch(
      makeDocument(),
      expectValid([{ op: 'replace', path: '/facts/missing', value: 1 }])
    );
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'path_not_found',
    });
  });

  it('rejects traversal through a scalar with type_mismatch', () => {
    const result = axApplyStatePatch(
      makeDocument(),
      expectValid([{ op: 'add', path: '/facts/orderId/deep', value: 1 }])
    );
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'type_mismatch',
    });
  });

  it('applies the "-" array append token', () => {
    const result = axApplyStatePatch(
      makeDocument(),
      expectValid([
        { op: 'add', path: '/goals/a/evidence/-', value: { ref: 'r1' } },
      ])
    );
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.value.goals.a.evidence).toEqual([{ ref: 'r1' }]);
  });

  it('applying the same patch twice to the same base is byte-identical', () => {
    // Determinism is what makes the behaviour portable to the AxIR targets.
    const patch = expectValid([
      { op: 'add', path: '/goals/a/evidence/-', value: { ref: 'r1' } },
      { op: 'replace', path: '/goals/a/status', value: 'done' },
      { op: 'add', path: '/facts/carrier', value: 'UPS' },
    ]);
    const first = axApplyStatePatch(makeDocument(), patch);
    const second = axApplyStatePatch(makeDocument(), patch);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('object-keyed adds and removes do not disturb sibling keys', () => {
    // The keyed-goal ledger's core property: no index shifting can ever make
    // an op classified against one goal land on another.
    const base = makeDocument();
    const result = axApplyStatePatch(
      base,
      expectValid([
        { op: 'remove', path: '/goals/a' },
        { op: 'replace', path: '/goals/b/status', value: 'done' },
      ])
    );
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(Object.keys(result.value.goals)).toEqual(['b']);
    expect(result.value.goals.b.status).toBe('done');
    expect(result.value.goals.b.id).toBe('b');
  });

  it('refuses a prototype-polluting pointer even if validation is bypassed', () => {
    // Defence in depth: `axApplyStatePatch` is public, so a caller that skips
    // `axValidateStatePatch` still cannot reach `Object.prototype`.
    const result = axApplyStatePatch(makeDocument(), [
      { op: 'add', path: '/__proto__/polluted', value: true },
    ] as unknown as AxStatePatch);
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'type_mismatch',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces the whole document at the root pointer', () => {
    const result = axApplyStatePatch(
      makeDocument(),
      expectValid([{ op: 'replace', path: '', value: { schemaVersion: 2 } }])
    );
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.value).toEqual({ schemaVersion: 2 });
  });
});
