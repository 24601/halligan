import { describe, expect, it } from 'vitest';

import { axReportSchema } from './reportSchema.js';
import type { AxLearningReportInput } from './types.js';
import { AxLearningReportValidationError } from './types.js';

function input(
  override: Partial<AxLearningReportInput> = {}
): AxLearningReportInput {
  return { references: ['rec-1'], score: 1, ...override };
}

describe('axReportSchema construction', () => {
  it('refuses a reserved top-level report key', () => {
    // These are already top-level keys of a report input, so declaring one
    // would make "score means top-level, everything else means metadata"
    // ambiguous.
    for (const name of ['references', 'feedback', 'metadata', 'id']) {
      expect(() => axReportSchema({ [name]: { type: 'string' } })).toThrow(
        new RegExp(`"${name}" is a reserved top-level report key`)
      );
    }
  });

  it('refuses an unknown type and a misapplied constraint', () => {
    expect(() =>
      axReportSchema({ score: { type: 'decimal' as never } })
    ).toThrow(/unknown type/);
    expect(() => axReportSchema({ label: { type: 'string', min: 1 } })).toThrow(
      /min\/max on a non-numeric type/
    );
    expect(() =>
      axReportSchema({ score: { type: 'number', maxLength: 3 } })
    ).toThrow(/maxLength on a non-string type/);
    expect(() =>
      axReportSchema({ score: { type: 'number', min: 5, max: 1 } })
    ).toThrow(/min above max/);
    expect(() =>
      axReportSchema({ label: { type: 'string', maxLength: 0 } })
    ).toThrow(/positive integer maxLength/);
  });

  it('exposes the declared fields', () => {
    const schema = axReportSchema({
      score: { type: 'number', required: true },
    });
    expect(schema.fields).toEqual({
      score: { type: 'number', required: true },
    });
  });
});

describe('axReportSchema.validate', () => {
  it('reads score from the top level and every other field from metadata', () => {
    const schema = axReportSchema({
      score: { type: 'number', min: 0, max: 1 },
      rubric: { type: 'string', maxLength: 8 },
    });

    expect(() =>
      schema.validate(input({ score: 0.5, metadata: { rubric: 'strict' } }))
    ).not.toThrow();

    // `rubric` at the top level is not the declared field: it lives in
    // metadata, so a top-level one is simply undeclared (and dropped later).
    expect(() =>
      schema.validate(input({ metadata: { rubric: 'far-too-long-for-eight' } }))
    ).toThrow(/field "rubric" must be at most 8 characters/);
  });

  it('passes undeclared feedback and metadata through untouched', () => {
    const schema = axReportSchema({ score: { type: 'number' } });
    const submitted = input({
      feedback: 'the answer skipped the refund policy',
      metadata: { evaluatorId: 'human-42', nested: { depth: 2 } },
    });
    expect(schema.validate(submitted)).toBe(submitted);
  });

  it('names the field that broke', () => {
    const schema = axReportSchema({ latencyMs: { type: 'integer', min: 0 } });
    let caught: unknown;
    try {
      schema.validate(input({ metadata: { latencyMs: 12.5 } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxLearningReportValidationError);
    expect((caught as AxLearningReportValidationError).field).toBe('latencyMs');
    expect((caught as AxLearningReportValidationError).code).toBe(
      'learning_report_invalid'
    );
  });

  it('throws for a missing required field and accepts a missing optional one', () => {
    const required = axReportSchema({
      score: { type: 'number', required: true },
    });
    expect(() => required.validate(input({ score: undefined }))).toThrow(
      /field "score" is required/
    );

    const optional = axReportSchema({ note: { type: 'string' } });
    expect(() => optional.validate(input())).not.toThrow();
  });

  it('rejects NaN, Infinity and boolean for a number field', () => {
    const schema = axReportSchema({ score: { type: 'number' } });
    expect(() => schema.validate(input({ score: Number.NaN }))).toThrow(
      /must be finite/
    );
    expect(() =>
      schema.validate(input({ score: Number.POSITIVE_INFINITY }))
    ).toThrow(/must be finite/);
    expect(() => schema.validate(input({ score: true as never }))).toThrow(
      /a boolean is not one/
    );
  });

  it('admits a non-finite number only when finite is explicitly disabled', () => {
    const schema = axReportSchema({ score: { type: 'number', finite: false } });
    expect(() =>
      schema.validate(input({ score: Number.POSITIVE_INFINITY }))
    ).not.toThrow();
  });

  it('checks range, integrality, booleans and string maps', () => {
    const schema = axReportSchema({
      score: { type: 'number', min: 0, max: 1 },
      attempts: { type: 'integer' },
      escalated: { type: 'boolean' },
      labels: { type: 'stringMap' },
    });
    expect(() => schema.validate(input({ score: 1.5 }))).toThrow(/at most 1/);
    expect(() => schema.validate(input({ score: -0.5 }))).toThrow(/at least 0/);
    expect(() =>
      schema.validate(input({ metadata: { attempts: 'two' } }))
    ).toThrow(/must be a number/);
    expect(() =>
      schema.validate(input({ metadata: { escalated: 'yes' } }))
    ).toThrow(/must be a boolean/);
    expect(() =>
      schema.validate(input({ metadata: { labels: { a: 1 } } }))
    ).toThrow(/must be a map of strings/);
    expect(() =>
      schema.validate(input({ metadata: { labels: ['a'] } }))
    ).toThrow(/must be a map of strings/);
    expect(() =>
      schema.validate(
        input({
          score: 0.25,
          metadata: {
            attempts: 3,
            escalated: true,
            labels: { queue: 'billing' },
          },
        })
      )
    ).not.toThrow();
  });
});

describe('axReportSchema prototype safety', () => {
  it('treats a declared field inherited from the prototype as absent', () => {
    const schema = axReportSchema({
      constructor: { type: 'string', required: true },
    });
    // `metadata.constructor` exists on Object.prototype and is a function: a
    // bare read would hand it to the validator as a present value.
    expect(() =>
      schema.validate({ references: ['rec-1'], metadata: {} })
    ).toThrow(/field "constructor" is required/);
  });
});
