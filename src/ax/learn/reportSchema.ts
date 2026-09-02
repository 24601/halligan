/**
 * Floor-not-ceiling validation for report ingress.
 *
 * A schema declares the fields a host insists on and says nothing about the
 * rest: undeclared `feedback` and `metadata` keys pass through untouched, so a
 * caller can enrich a report without editing a schema. This is the in-process
 * equivalent of rejecting a malformed POST at the door — a report that cannot
 * be interpreted must fail where the caller can still fix it, not silently
 * become a record nobody can grade.
 *
 * `score` is the only name that addresses a top-level report field; every other
 * declared name addresses `metadata.<name>`.
 */

import {
  type AxLearningReportInput,
  AxLearningReportValidationError,
} from './types.js';

export type AxReportFieldType =
  | 'number'
  | 'integer'
  | 'string'
  | 'boolean'
  | 'stringMap';

export interface AxReportFieldSchema {
  readonly type: AxReportFieldType;
  readonly required?: boolean;
  /** number/integer only. Default true — non-finite is rejected. */
  readonly finite?: boolean;
  readonly min?: number;
  readonly max?: number;
  /** string only. */
  readonly maxLength?: number;
}

export interface AxReportSchema {
  /**
   * `score` is the only field that means a TOP-LEVEL field; every other name
   * means `metadata.<name>`. `references`, `feedback`, `metadata` and `id` are
   * RESERVED and throw at schema construction — they are top-level report-input
   * keys, so declaring one would be ambiguous.
   */
  readonly fields: Readonly<Record<string, Readonly<AxReportFieldSchema>>>;
  /** Validates declared fields, passes undeclared feedback/metadata through untouched. */
  validate(
    input: Readonly<AxLearningReportInput>
  ): Readonly<AxLearningReportInput>;
}

const FIELD_TYPES: readonly AxReportFieldType[] = [
  'number',
  'integer',
  'string',
  'boolean',
  'stringMap',
];

/** Top-level report-input keys a declared field may never shadow. */
const RESERVED_FIELD_NAMES: readonly string[] = [
  'references',
  'feedback',
  'metadata',
  'id',
];

function fail(field: string, message: string): never {
  throw new AxLearningReportValidationError(
    field,
    `AxReportSchema: ${message}`
  );
}

function assertFieldSchema(
  name: string,
  schema: Readonly<AxReportFieldSchema>
): void {
  if (name.length === 0) {
    throw new Error('AxReportSchema: a field name must be non-empty');
  }
  if (RESERVED_FIELD_NAMES.includes(name)) {
    throw new Error(
      `AxReportSchema: "${name}" is a reserved top-level report key and cannot be declared as a field`
    );
  }
  if (!FIELD_TYPES.includes(schema.type)) {
    throw new Error(
      `AxReportSchema: field "${name}" has unknown type "${String(schema.type)}"`
    );
  }
  const numeric = schema.type === 'number' || schema.type === 'integer';
  if (!numeric && (schema.min !== undefined || schema.max !== undefined)) {
    throw new Error(
      `AxReportSchema: field "${name}" declares min/max on a non-numeric type`
    );
  }
  if (schema.type !== 'string' && schema.maxLength !== undefined) {
    throw new Error(
      `AxReportSchema: field "${name}" declares maxLength on a non-string type`
    );
  }
  if (
    schema.min !== undefined &&
    schema.max !== undefined &&
    schema.min > schema.max
  ) {
    throw new Error(`AxReportSchema: field "${name}" has min above max`);
  }
  if (
    schema.maxLength !== undefined &&
    (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1)
  ) {
    throw new Error(
      `AxReportSchema: field "${name}" needs a positive integer maxLength`
    );
  }
}

function validateValue(
  name: string,
  schema: Readonly<AxReportFieldSchema>,
  value: unknown
): void {
  switch (schema.type) {
    case 'number':
    case 'integer': {
      // A boolean is not a number. JavaScript would happily compare it, which
      // is exactly why it has to be refused by name.
      if (typeof value === 'boolean') {
        fail(name, `field "${name}" must be a number; a boolean is not one`);
      }
      if (typeof value !== 'number') {
        fail(name, `field "${name}" must be a number`);
      }
      if ((schema.finite ?? true) && !Number.isFinite(value)) {
        fail(name, `field "${name}" must be finite`);
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        fail(name, `field "${name}" must be an integer`);
      }
      if (schema.min !== undefined && value < schema.min) {
        fail(name, `field "${name}" must be at least ${schema.min}`);
      }
      if (schema.max !== undefined && value > schema.max) {
        fail(name, `field "${name}" must be at most ${schema.max}`);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        fail(name, `field "${name}" must be a string`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        fail(
          name,
          `field "${name}" must be at most ${schema.maxLength} characters`
        );
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail(name, `field "${name}" must be a boolean`);
      }
      return;
    }
    case 'stringMap': {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.values(value).some((entry) => typeof entry !== 'string')
      ) {
        fail(name, `field "${name}" must be a map of strings`);
      }
      return;
    }
    default: {
      fail(name, `field "${name}" has unknown type`);
    }
  }
}

/**
 * Build a report schema.
 *
 * Construction is where a bad schema is caught: an unknown type, a reserved
 * name, or a constraint that cannot apply to its type throws here rather than
 * at the first report that happens to exercise it.
 */
export const axReportSchema = (
  fields: Readonly<Record<string, Readonly<AxReportFieldSchema>>>
): AxReportSchema => {
  for (const [name, schema] of Object.entries(fields)) {
    assertFieldSchema(name, schema);
  }
  const frozen = Object.freeze({ ...fields });
  return Object.freeze({
    fields: frozen,
    validate(
      input: Readonly<AxLearningReportInput>
    ): Readonly<AxLearningReportInput> {
      for (const [name, schema] of Object.entries(frozen)) {
        const value = name === 'score' ? input.score : input.metadata?.[name];
        if (value === undefined) {
          if (schema.required) {
            fail(name, `field "${name}" is required`);
          }
          continue;
        }
        validateValue(name, schema, value);
      }
      // Floor, not ceiling: whatever was not declared is handed on untouched.
      return input;
    },
  });
};
