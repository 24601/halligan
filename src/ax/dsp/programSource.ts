import type { AxCodeRuntime, AxCodeSession } from '../agent/rlm.js';
import type { AxAIService, AxFunction } from '../ai/types.js';
import { AxJSRuntime } from '../funcs/jsRuntime.js';
import { validateStructuredOutputValues } from './extract.js';
import { AxFunctionProcessor } from './functions.js';
import { AxGen } from './generate.js';
import type { AxOptimizableComponent } from './optimizable.js';
import { AxProgram } from './program.js';
import type { AxSignatureConfig } from './sig.js';
import { AxSignature } from './sig.js';
import type { ParseSignature } from './sigtypes.js';
import type {
  AxGenIn,
  AxGenOut,
  AxGenStreamingOut,
  AxProgramForwardOptions,
  AxProgramOptions,
  AxProgramStreamingForwardOptions,
} from './types.js';
import { validateValue } from './util.js';

export const axProgramSourceVersion = 'ax-program-source/v1' as const;
export const axProgramSourceRuntimeProtocol =
  'ax-program-source-runtime/js-v1' as const;

export const axProgramSourceDefaultNodeResourceLimits = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
});

export type AxProgramSourceCapability = 'predict' | `tool:${string}`;

export type AxProgramSourceExpression =
  | Readonly<{ op: 'literal'; value: unknown }>
  | Readonly<{ op: 'ref'; path: string }>
  | Readonly<{
      op: 'object';
      entries: Readonly<Record<string, AxProgramSourceExpression>>;
    }>
  | Readonly<{
      op: 'array';
      items: readonly AxProgramSourceExpression[];
    }>
  | Readonly<{
      op: 'eq';
      left: AxProgramSourceExpression;
      right: AxProgramSourceExpression;
    }>
  | Readonly<{
      op: 'select';
      condition: AxProgramSourceExpression;
      then: AxProgramSourceExpression;
      else: AxProgramSourceExpression;
    }>
  | Readonly<{ op: 'not'; value: AxProgramSourceExpression }>
  | Readonly<{
      op: 'and' | 'or' | 'concat';
      values: readonly AxProgramSourceExpression[];
    }>;

export type AxProgramSourceStatement =
  | Readonly<{
      op: 'predict';
      as: string;
      signature: '$program' | string;
      instruction?: string;
      tools?: readonly string[];
      input: AxProgramSourceExpression;
    }>
  | Readonly<{
      op: 'tool';
      name: string;
      as: string;
      args: AxProgramSourceExpression;
    }>
  | Readonly<{
      op: 'if';
      condition: AxProgramSourceExpression;
      then: readonly AxProgramSourceStatement[];
      else?: readonly AxProgramSourceStatement[];
    }>
  | Readonly<{
      op: 'forEach';
      items: AxProgramSourceExpression;
      item: string;
      result: string;
      maxIterations: number;
      body: readonly AxProgramSourceStatement[];
      collect: AxProgramSourceExpression;
    }>
  | Readonly<{
      op: 'return';
      outputs: Readonly<Record<string, AxProgramSourceExpression>>;
    }>;

export type AxProgramSourceDocument = Readonly<{
  version: typeof axProgramSourceVersion;
  capabilities: readonly AxProgramSourceCapability[];
  steps: readonly AxProgramSourceStatement[];
}>;

export type AxProgramSourceState = Readonly<{
  version: 1;
  source: string;
}>;

export type AxProgramSourceRuntime = Readonly<{
  runtime: AxCodeRuntime;
  protocol: typeof axProgramSourceRuntimeProtocol;
}>;

export type AxProgramSourceValueLimits = Readonly<{
  /** Maximum JSON-wire bytes for any input, bridge argument/result, or output. */
  maxBytes: number;
  /** Maximum object/array nesting depth, with the root at depth zero. */
  maxDepth: number;
  /** Maximum entries in any one object or array. */
  maxWidth: number;
}>;

export type AxProgramSourceLateBridgeEvent = Readonly<{
  epoch: number;
  kind: 'predictor' | 'tool';
  name: string;
  phase: 'call' | 'completion';
  reason: string;
  elapsedMs: number;
}>;

export type AxProgramSourceOptions = AxProgramOptions &
  Readonly<{
    /** Host tools that source may name. These are the only non-LM capabilities. */
    tools?: readonly AxFunction[];
    /** Initial source. Omit to seed a single-predictor implementation. */
    source?: string;
    /** Explicit JavaScript/protocol-compatible runtime. Omit for AxJSRuntime. */
    runtime?: AxProgramSourceRuntime;
    /** Maximum bridged predictor calls per forward. Default: 16. */
    maxPredictorCalls?: number;
    /** Maximum direct and predictor-mediated tool calls per forward. Default: 32. */
    maxToolCalls?: number;
    /** Maximum executed control-flow statements/loop iterations. Default: 100. */
    maxIterations?: number;
    /** Maximum AxGen continuation steps inside one predictor call. Default: 8. */
    maxStepsPerPredictor?: number;
    /** Wall-clock authority timeout for the runtime and host bridges. */
    timeoutMs?: number;
    /** Serializable JSON graph limits applied at every runtime boundary. */
    valueLimits?: Partial<AxProgramSourceValueLimits>;
  }>;

export class AxProgramSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AxProgramSourceError';
  }
}

export class AxProgramSourceBudgetError extends AxProgramSourceError {
  constructor(message: string) {
    super(message);
    this.name = 'AxProgramSourceBudgetError';
  }
}

export class AxProgramSourceSessionExpiredError extends AxProgramSourceError {
  constructor(message: string) {
    super(message);
    this.name = 'AxProgramSourceSessionExpiredError';
  }
}

type BoundProgramSource = {
  document: AxProgramSourceDocument;
  source: string;
};

const MAX_SOURCE_LENGTH = 50_000;
const MAX_SOURCE_STATEMENTS = 128;
const MAX_SOURCE_NESTING = 8;
const MAX_LATE_BRIDGE_EVENTS = 128;
const DEFAULT_VALUE_LIMITS: AxProgramSourceValueLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 24,
  maxWidth: 4_096,
});
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const RESERVED_VARIABLES = new Set(['inputs']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const jsonStringByteLength = (value: string): number => {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      bytes += 2;
    } else if (unit <= 0x1f) {
      bytes += 6;
    } else if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const snapshotSerializableValue = <T>(
  value: T,
  limits: Readonly<AxProgramSourceValueLimits>,
  label: string
): T => {
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const consume = (amount: number) => {
    bytes += amount;
    if (bytes > limits.maxBytes) {
      throw new AxProgramSourceBudgetError(
        `${label} exceeds serialized value byte limit: ${limits.maxBytes}`
      );
    }
  };
  const visit = (current: unknown, depth: number, path: string): unknown => {
    if (depth > limits.maxDepth) {
      throw new AxProgramSourceBudgetError(
        `${label} exceeds value depth limit: ${limits.maxDepth} at ${path}`
      );
    }
    if (current === null) {
      consume(4);
      return null;
    }
    switch (typeof current) {
      case 'string':
        consume(jsonStringByteLength(current));
        return current;
      case 'number':
        if (!Number.isFinite(current)) {
          throw new AxProgramSourceError(
            `${label} is not JSON-serializable: non-finite number at ${path}`
          );
        }
        consume(Object.is(current, -0) ? 1 : String(current).length);
        return current;
      case 'boolean':
        consume(current ? 4 : 5);
        return current;
      case 'object':
        break;
      default:
        throw new AxProgramSourceError(
          `${label} is not JSON-serializable: ${typeof current} at ${path}`
        );
    }

    if (ancestors.has(current)) {
      throw new AxProgramSourceError(
        `${label} is not JSON-serializable: cyclic value at ${path}`
      );
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => typeof key !== 'string')) {
          throw new AxProgramSourceError(
            `${label} is not JSON-serializable: symbol key at ${path}`
          );
        }
        const descriptors = new Map<string, PropertyDescriptor>();
        for (const key of keys as string[]) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor) {
            throw new AxProgramSourceError(
              `${label} is not JSON-serializable: unstable array property '${key}' at ${path}`
            );
          }
          descriptors.set(key, descriptor);
        }
        const lengthDescriptor = descriptors.get('length');
        const length =
          lengthDescriptor && 'value' in lengthDescriptor
            ? lengthDescriptor.value
            : undefined;
        if (
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0
        ) {
          throw new AxProgramSourceError(
            `${label} is not JSON-serializable: invalid array length at ${path}`
          );
        }
        if (length > limits.maxWidth) {
          throw new AxProgramSourceBudgetError(
            `${label} exceeds value width limit: ${limits.maxWidth} at ${path}`
          );
        }
        const itemKeys = (keys as string[]).filter((key) => key !== 'length');
        const extraKeys = itemKeys.filter(
          (key) => !/^0$|^[1-9][0-9]*$/.test(key) || Number(key) >= length
        );
        if (extraKeys.length > 0) {
          throw new AxProgramSourceError(
            `${label} is not JSON-serializable: array property '${extraKeys[0]}' at ${path}`
          );
        }
        consume(2 + Math.max(0, length - 1));
        const snapshot: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors.get(String(index));
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !('value' in descriptor)
          ) {
            throw new AxProgramSourceError(
              `${label} is not JSON-serializable: sparse or accessor array value at ${path}[${index}]`
            );
          }
          snapshot.push(
            visit(descriptor.value, depth + 1, `${path}[${index}]`)
          );
        }
        return snapshot;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new AxProgramSourceError(
          `${label} is not JSON-serializable: non-plain object at ${path}`
        );
      }
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== 'string')) {
        throw new AxProgramSourceError(
          `${label} is not JSON-serializable: symbol key at ${path}`
        );
      }
      if (keys.length > limits.maxWidth) {
        throw new AxProgramSourceBudgetError(
          `${label} exceeds value width limit: ${limits.maxWidth} at ${path}`
        );
      }
      consume(2 + Math.max(0, keys.length - 1));
      const snapshot: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
          throw new AxProgramSourceError(
            `${label} contains unsafe object key '${key}' at ${path}`
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new AxProgramSourceError(
            `${label} is not JSON-serializable: non-data property '${key}' at ${path}`
          );
        }
        consume(jsonStringByteLength(key) + 1);
        snapshot[key] = visit(descriptor.value, depth + 1, `${path}.${key}`);
      }
      return snapshot;
    } finally {
      ancestors.delete(current);
    }
  };

  try {
    return visit(value, 0, '$') as T;
  } catch (error) {
    if (error instanceof AxProgramSourceError) throw error;
    throw new AxProgramSourceError(
      `${label} could not be inspected as a serializable value`,
      { cause: error }
    );
  }
};

const captureFunction = (
  value: Readonly<AxFunction>,
  expectedName: string,
  label: string
): Readonly<{
  metadata: Omit<AxFunction, 'func'>;
  handler: AxFunction['func'];
}> => {
  const metadata: Record<string, unknown> = {};
  let handler: unknown;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new AxProgramSourceError(`${label} contains a symbol property`);
    }
    for (const key of keys as string[]) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
        throw new AxProgramSourceError(
          `${label} contains unsafe metadata key '${key}'`
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        throw new AxProgramSourceError(
          `${label} property '${key}' could not be inspected`
        );
      }
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new AxProgramSourceError(
          `${label} property '${key}' must be an enumerable data property`
        );
      }
      if (key === 'func') handler = descriptor.value;
      else metadata[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof AxProgramSourceError) throw error;
    throw new AxProgramSourceError(`${label} could not be inspected`, {
      cause: error,
    });
  }
  const name = metadata.name;
  const description = metadata.description;
  if (name !== expectedName || typeof description !== 'string') {
    throw new AxProgramSourceError(`${label} metadata is invalid`);
  }
  if (typeof handler !== 'function') {
    throw new AxProgramSourceError(
      `${label} property 'func' must be a function`
    );
  }
  return {
    metadata: metadata as Omit<AxFunction, 'func'>,
    handler: handler as AxFunction['func'],
  };
};

function fail(path: string, message: string): never {
  throw new AxProgramSourceError(
    `Invalid program source at ${path}: ${message}`
  );
}

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  path: string
): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(path, `unexpected field '${key}'`);
  }
  for (const key of required) {
    if (!(key in value)) fail(path, `missing field '${key}'`);
  }
};

const validateIdentifier = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail(path, 'must be an identifier');
  }
  if (RESERVED_VARIABLES.has(value) || FORBIDDEN_PATH_SEGMENTS.has(value)) {
    fail(path, `'${value}' is reserved`);
  }
  return value;
};

const validateReferencePath = (
  value: unknown,
  knownVariables: ReadonlySet<string>,
  inputNames: ReadonlySet<string>,
  path: string
): void => {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'must be a non-empty dotted path');
  }
  const segments = value.split('.');
  if (!knownVariables.has(segments[0]!)) {
    fail(path, `unknown root '${segments[0]}'`);
  }
  if (
    segments[0] === 'inputs' &&
    segments.length > 1 &&
    !inputNames.has(segments[1]!)
  ) {
    fail(path, `unknown input field '${segments[1]}'`);
  }
  for (const segment of segments) {
    if (!IDENTIFIER.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      fail(path, `unsafe path segment '${segment}'`);
    }
  }
};

function validateExpression(
  value: unknown,
  knownVariables: ReadonlySet<string>,
  inputNames: ReadonlySet<string>,
  path: string,
  depth: number
): asserts value is AxProgramSourceExpression {
  if (depth > MAX_SOURCE_NESTING) fail(path, 'nesting limit exceeded');
  if (!isRecord(value) || typeof value.op !== 'string') {
    fail(path, 'must be a tagged expression object');
  }

  switch (value.op) {
    case 'literal':
      exactKeys(value, ['op', 'value'], ['op', 'value'], path);
      return;
    case 'ref':
      exactKeys(value, ['op', 'path'], ['op', 'path'], path);
      validateReferencePath(
        value.path,
        knownVariables,
        inputNames,
        `${path}.path`
      );
      return;
    case 'object': {
      exactKeys(value, ['op', 'entries'], ['op', 'entries'], path);
      if (!isRecord(value.entries))
        fail(`${path}.entries`, 'must be an object');
      for (const [key, expression] of Object.entries(value.entries)) {
        if (!IDENTIFIER.test(key) || FORBIDDEN_PATH_SEGMENTS.has(key)) {
          fail(`${path}.entries`, `unsafe key '${key}'`);
        }
        validateExpression(
          expression,
          knownVariables,
          inputNames,
          `${path}.entries.${key}`,
          depth + 1
        );
      }
      return;
    }
    case 'array':
      exactKeys(value, ['op', 'items'], ['op', 'items'], path);
      if (!Array.isArray(value.items))
        fail(`${path}.items`, 'must be an array');
      for (const [index, expression] of value.items.entries()) {
        validateExpression(
          expression,
          knownVariables,
          inputNames,
          `${path}.items[${index}]`,
          depth + 1
        );
      }
      return;
    case 'eq':
      exactKeys(value, ['op', 'left', 'right'], ['op', 'left', 'right'], path);
      validateExpression(
        value.left,
        knownVariables,
        inputNames,
        `${path}.left`,
        depth + 1
      );
      validateExpression(
        value.right,
        knownVariables,
        inputNames,
        `${path}.right`,
        depth + 1
      );
      return;
    case 'select':
      exactKeys(
        value,
        ['op', 'condition', 'then', 'else'],
        ['op', 'condition', 'then', 'else'],
        path
      );
      validateExpression(
        value.condition,
        knownVariables,
        inputNames,
        `${path}.condition`,
        depth + 1
      );
      validateExpression(
        value.then,
        knownVariables,
        inputNames,
        `${path}.then`,
        depth + 1
      );
      validateExpression(
        value.else,
        knownVariables,
        inputNames,
        `${path}.else`,
        depth + 1
      );
      return;
    case 'not':
      exactKeys(value, ['op', 'value'], ['op', 'value'], path);
      validateExpression(
        value.value,
        knownVariables,
        inputNames,
        `${path}.value`,
        depth + 1
      );
      return;
    case 'and':
    case 'or':
    case 'concat':
      exactKeys(value, ['op', 'values'], ['op', 'values'], path);
      if (!Array.isArray(value.values) || value.values.length === 0) {
        fail(`${path}.values`, 'must be a non-empty array');
      }
      for (const [index, expression] of value.values.entries()) {
        validateExpression(
          expression,
          knownVariables,
          inputNames,
          `${path}.values[${index}]`,
          depth + 1
        );
      }
      return;
    default:
      fail(`${path}.op`, `unsupported expression '${String(value.op)}'`);
  }
}

type BindContext = {
  capabilities: ReadonlySet<string>;
  tools: ReadonlyMap<string, AxFunction>;
  signature: Readonly<AxSignature>;
  inputNames: ReadonlySet<string>;
  maxIterations: number;
  statementCount: number;
};

const validateStatementList = (
  value: unknown,
  knownVariables: Set<string>,
  path: string,
  depth: number,
  context: BindContext,
  allowReturn: boolean
): Set<string> => {
  if (depth > MAX_SOURCE_NESTING) fail(path, 'nesting limit exceeded');
  if (!Array.isArray(value)) fail(path, 'must be an array');

  const known = new Set(knownVariables);
  for (const [index, rawStatement] of value.entries()) {
    const statementPath = `${path}[${index}]`;
    if (!isRecord(rawStatement) || typeof rawStatement.op !== 'string') {
      fail(statementPath, 'must be a tagged statement object');
    }
    context.statementCount += 1;
    if (context.statementCount > MAX_SOURCE_STATEMENTS) {
      fail(path, `may contain at most ${MAX_SOURCE_STATEMENTS} statements`);
    }

    switch (rawStatement.op) {
      case 'predict': {
        exactKeys(
          rawStatement,
          ['op', 'as', 'signature', 'instruction', 'tools', 'input'],
          ['op', 'as', 'signature', 'input'],
          statementPath
        );
        if (!context.capabilities.has('predict')) {
          fail(statementPath, "requires declared capability 'predict'");
        }
        const variable = validateIdentifier(
          rawStatement.as,
          `${statementPath}.as`
        );
        if (
          rawStatement.signature !== '$program' &&
          (typeof rawStatement.signature !== 'string' ||
            rawStatement.signature.trim().length === 0)
        ) {
          fail(
            `${statementPath}.signature`,
            "must be '$program' or a non-empty Ax signature"
          );
        }
        if (rawStatement.signature !== '$program') {
          try {
            AxSignature.create(rawStatement.signature as string).validate();
          } catch (error) {
            throw new AxProgramSourceError(
              `Invalid program source at ${statementPath}.signature: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error }
            );
          }
        }
        if (
          rawStatement.instruction !== undefined &&
          typeof rawStatement.instruction !== 'string'
        ) {
          fail(`${statementPath}.instruction`, 'must be a string');
        }
        if (
          rawStatement.tools !== undefined &&
          !Array.isArray(rawStatement.tools)
        ) {
          fail(`${statementPath}.tools`, 'must be an array');
        }
        const predictorTools = rawStatement.tools ?? [];
        const seenTools = new Set<string>();
        for (const [toolIndex, toolName] of predictorTools.entries()) {
          if (typeof toolName !== 'string' || !context.tools.has(toolName)) {
            fail(
              `${statementPath}.tools[${toolIndex}]`,
              `unknown tool '${String(toolName)}'`
            );
          }
          if (seenTools.has(toolName)) {
            fail(`${statementPath}.tools`, `duplicate tool '${toolName}'`);
          }
          seenTools.add(toolName);
          if (!context.capabilities.has(`tool:${toolName}`)) {
            fail(
              statementPath,
              `requires declared capability 'tool:${toolName}'`
            );
          }
        }
        validateExpression(
          rawStatement.input,
          known,
          context.inputNames,
          `${statementPath}.input`,
          depth + 1
        );
        known.add(variable);
        break;
      }
      case 'tool': {
        exactKeys(
          rawStatement,
          ['op', 'name', 'as', 'args'],
          ['op', 'name', 'as', 'args'],
          statementPath
        );
        if (
          typeof rawStatement.name !== 'string' ||
          !context.tools.has(rawStatement.name)
        ) {
          fail(
            `${statementPath}.name`,
            `unknown tool '${String(rawStatement.name)}'`
          );
        }
        if (!context.capabilities.has(`tool:${rawStatement.name}`)) {
          fail(
            statementPath,
            `requires declared capability 'tool:${rawStatement.name}'`
          );
        }
        const variable = validateIdentifier(
          rawStatement.as,
          `${statementPath}.as`
        );
        validateExpression(
          rawStatement.args,
          known,
          context.inputNames,
          `${statementPath}.args`,
          depth + 1
        );
        known.add(variable);
        break;
      }
      case 'if': {
        exactKeys(
          rawStatement,
          ['op', 'condition', 'then', 'else'],
          ['op', 'condition', 'then'],
          statementPath
        );
        validateExpression(
          rawStatement.condition,
          known,
          context.inputNames,
          `${statementPath}.condition`,
          depth + 1
        );
        const thenKnown = validateStatementList(
          rawStatement.then,
          new Set(known),
          `${statementPath}.then`,
          depth + 1,
          context,
          false
        );
        const elseKnown = rawStatement.else
          ? validateStatementList(
              rawStatement.else,
              new Set(known),
              `${statementPath}.else`,
              depth + 1,
              context,
              false
            )
          : new Set(known);
        for (const variable of thenKnown) {
          if (elseKnown.has(variable)) known.add(variable);
        }
        break;
      }
      case 'forEach': {
        exactKeys(
          rawStatement,
          ['op', 'items', 'item', 'result', 'maxIterations', 'body', 'collect'],
          ['op', 'items', 'item', 'result', 'maxIterations', 'body', 'collect'],
          statementPath
        );
        validateExpression(
          rawStatement.items,
          known,
          context.inputNames,
          `${statementPath}.items`,
          depth + 1
        );
        const item = validateIdentifier(
          rawStatement.item,
          `${statementPath}.item`
        );
        const result = validateIdentifier(
          rawStatement.result,
          `${statementPath}.result`
        );
        if (
          !Number.isInteger(rawStatement.maxIterations) ||
          (rawStatement.maxIterations as number) < 1 ||
          (rawStatement.maxIterations as number) > context.maxIterations
        ) {
          fail(
            `${statementPath}.maxIterations`,
            `must be an integer between 1 and ${context.maxIterations}`
          );
        }
        const bodyKnown = validateStatementList(
          rawStatement.body,
          new Set([...known, item]),
          `${statementPath}.body`,
          depth + 1,
          context,
          false
        );
        validateExpression(
          rawStatement.collect,
          bodyKnown,
          context.inputNames,
          `${statementPath}.collect`,
          depth + 1
        );
        known.add(result);
        break;
      }
      case 'return': {
        if (!allowReturn) {
          fail(
            statementPath,
            'return is allowed only as the final top-level step'
          );
        }
        if (index !== value.length - 1) {
          fail(statementPath, 'return must be the final step');
        }
        exactKeys(
          rawStatement,
          ['op', 'outputs'],
          ['op', 'outputs'],
          statementPath
        );
        if (!isRecord(rawStatement.outputs)) {
          fail(`${statementPath}.outputs`, 'must be an object');
        }
        const outputFields = context.signature.getOutputFields();
        const outputNames = new Set(outputFields.map((field) => field.name));
        for (const [name, expression] of Object.entries(rawStatement.outputs)) {
          if (!outputNames.has(name)) {
            fail(`${statementPath}.outputs`, `unknown output '${name}'`);
          }
          validateExpression(
            expression,
            known,
            context.inputNames,
            `${statementPath}.outputs.${name}`,
            depth + 1
          );
        }
        for (const field of outputFields) {
          if (
            !field.isInternal &&
            !field.isOptional &&
            !Object.hasOwn(rawStatement.outputs, field.name)
          ) {
            fail(
              `${statementPath}.outputs`,
              `missing required output '${field.name}'`
            );
          }
        }
        break;
      }
      default:
        fail(
          `${statementPath}.op`,
          `unsupported statement '${String(rawStatement.op)}'`
        );
    }
  }
  return known;
};

const bindProgramSource = (
  source: string,
  options: Readonly<{
    allowedCapabilities: ReadonlySet<string>;
    tools: ReadonlyMap<string, AxFunction>;
    signature: Readonly<AxSignature>;
    maxIterations: number;
  }>
): BoundProgramSource => {
  const trimmed = source.trim();
  if (trimmed.length === 0)
    throw new AxProgramSourceError('Program source is empty');
  if (trimmed.length > MAX_SOURCE_LENGTH) {
    throw new AxProgramSourceError(
      `Program source exceeds ${MAX_SOURCE_LENGTH} characters`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AxProgramSourceError(
      `Invalid program source JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  if (!isRecord(parsed)) fail('$', 'must be an object');
  exactKeys(
    parsed,
    ['version', 'capabilities', 'steps'],
    ['version', 'capabilities', 'steps'],
    '$'
  );
  if (parsed.version !== axProgramSourceVersion) {
    fail('$.version', `must be '${axProgramSourceVersion}'`);
  }
  if (!Array.isArray(parsed.capabilities)) {
    fail('$.capabilities', 'must be an array');
  }
  const capabilities = new Set<string>();
  parsed.capabilities.forEach((capability, index) => {
    if (
      typeof capability !== 'string' ||
      !options.allowedCapabilities.has(capability)
    ) {
      fail(
        `$.capabilities[${index}]`,
        `capability '${String(capability)}' is not allowed by the host`
      );
    }
    if (capabilities.has(capability)) {
      fail('$.capabilities', `duplicate capability '${capability}'`);
    }
    capabilities.add(capability);
  });
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    fail('$.steps', 'must be a non-empty array');
  }
  if (
    (parsed.steps.at(-1) as Record<string, unknown> | undefined)?.op !==
    'return'
  ) {
    fail('$.steps', 'must end with a return step');
  }

  validateStatementList(
    parsed.steps,
    new Set(['inputs']),
    '$.steps',
    0,
    {
      capabilities,
      tools: options.tools,
      signature: options.signature,
      inputNames: new Set(
        options.signature.getInputFields().map((field) => field.name)
      ),
      maxIterations: options.maxIterations,
      statementCount: 0,
    },
    true
  );

  return {
    document: parsed as AxProgramSourceDocument,
    source: trimmed,
  };
};

const ref = (path: string): AxProgramSourceExpression => ({ op: 'ref', path });

const seedProgramSource = (
  signature: Readonly<AxSignature>,
  tools: readonly AxFunction[]
): string => {
  const outputs = Object.fromEntries(
    signature
      .getOutputFields()
      .filter((field) => !field.isInternal)
      .map((field) => [field.name, ref(`result.${field.name}`)])
  );
  const document: AxProgramSourceDocument = {
    version: axProgramSourceVersion,
    capabilities: [
      'predict',
      ...tools.map((tool) => `tool:${tool.name}` as const),
    ],
    steps: [
      {
        op: 'predict',
        as: 'result',
        signature: '$program',
        tools: tools.map((tool) => tool.name),
        input: ref('inputs'),
      },
      { op: 'return', outputs },
    ],
  };
  return JSON.stringify(document, null, 2);
};

const PROGRAM_SOURCE_RUNTIME = `
const __axReadPath = (path, env) => {
  const segments = path.split('.');
  let value = env[segments[0]];
  for (let index = 1; index < segments.length; index += 1) {
    if (value === null || value === undefined || typeof value !== 'object') {
      throw new Error('Program source reference is missing: ' + path);
    }
    const segment = segments[index];
    if (!Object.prototype.hasOwnProperty.call(value, segment)) {
      throw new Error('Program source reference is missing: ' + path);
    }
    value = value[segment];
  }
  return value;
};

const __axEvalExpression = async (expression, state) => {
  switch (expression.op) {
    case 'literal': return expression.value;
    case 'ref': return __axReadPath(expression.path, state.env);
    case 'object': {
      const output = Object.create(null);
      for (const [key, value] of Object.entries(expression.entries)) {
        output[key] = await __axEvalExpression(value, state);
      }
      return output;
    }
    case 'array': return await Promise.all(
      expression.items.map((value) => __axEvalExpression(value, state))
    );
    case 'eq': return (
      await __axEvalExpression(expression.left, state)
    ) === (
      await __axEvalExpression(expression.right, state)
    );
    case 'select': return await __axEvalExpression(
      await __axEvalExpression(expression.condition, state)
        ? expression.then
        : expression.else,
      state
    );
    case 'not': return !await __axEvalExpression(expression.value, state);
    case 'and': {
      for (const value of expression.values) {
        if (!await __axEvalExpression(value, state)) return false;
      }
      return true;
    }
    case 'or': {
      for (const value of expression.values) {
        if (await __axEvalExpression(value, state)) return true;
      }
      return false;
    }
    case 'concat': {
      const values = [];
      for (const value of expression.values) {
        values.push(String(await __axEvalExpression(value, state)));
      }
      return values.join('');
    }
    default: throw new Error('Unsupported bound expression: ' + expression.op);
  }
};

const __axTick = (state) => {
  state.iterations += 1;
  if (state.iterations > __axProgramSourceMaxIterations) {
    throw new Error(
      'Program source iteration budget exceeded: ' + __axProgramSourceMaxIterations
    );
  }
};

const __axRunSteps = async (steps, state) => {
  for (const statement of steps) {
    __axTick(state);
    switch (statement.op) {
      case 'predict': {
        const input = await __axEvalExpression(statement.input, state);
        const spec = {
          signature: statement.signature,
          tools: statement.tools || [],
        };
        if (statement.instruction !== undefined) {
          spec.instruction = statement.instruction;
        }
        state.env[statement.as] = await __axProgramSourcePredict(spec, input);
        break;
      }
      case 'tool': {
        const args = await __axEvalExpression(statement.args, state);
        state.env[statement.as] = await __axProgramSourceTool(
          statement.name,
          args
        );
        break;
      }
      case 'if': {
        const condition = await __axEvalExpression(statement.condition, state);
        await __axRunSteps(condition ? statement.then : (statement.else || []), state);
        break;
      }
      case 'forEach': {
        const items = await __axEvalExpression(statement.items, state);
        if (!Array.isArray(items)) {
          throw new Error('Program source forEach items must evaluate to an array');
        }
        if (items.length > statement.maxIterations) {
          throw new Error(
            'Program source loop exceeded local iteration limit: ' +
            statement.maxIterations
          );
        }
        const hadItem = Object.prototype.hasOwnProperty.call(state.env, statement.item);
        const previousItem = state.env[statement.item];
        const collected = [];
        try {
          for (const item of items) {
            __axTick(state);
            state.env[statement.item] = item;
            await __axRunSteps(statement.body, state);
            collected.push(await __axEvalExpression(statement.collect, state));
          }
        } finally {
          if (hadItem) state.env[statement.item] = previousItem;
          else delete state.env[statement.item];
        }
        state.env[statement.result] = collected;
        break;
      }
      case 'return': {
        const output = Object.create(null);
        for (const [key, value] of Object.entries(statement.outputs)) {
          output[key] = await __axEvalExpression(value, state);
        }
        state.output = output;
        return;
      }
      default: throw new Error('Unsupported bound statement: ' + statement.op);
    }
  }
};

const __axProgramSourceState = {
  env: { inputs: __axProgramSourceInputs },
  iterations: 0,
  output: undefined,
};
await __axRunSteps(__axProgramSourceDocument.steps, __axProgramSourceState);
if (__axProgramSourceState.output === undefined) {
  throw new Error('Program source completed without returning outputs');
}
return __axProgramSourceState.output;
`;

const validateBudget = (
  name: string,
  value: number,
  minimum: number
): number => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new AxProgramSourceError(
      `${name} must be an integer greater than or equal to ${minimum}`
    );
  }
  return value;
};

/**
 * Experimental signature-defined program whose complete implementation is a
 * GEPA-optimizable JSON control-flow document with explicit capabilities.
 *
 * Optimizer-authored source is parsed as data and never passed to eval,
 * Function, imports, or a host JavaScript realm. A fixed Ax-owned interpreter
 * asks the configured AxCodeRuntime to create one session per forward call.
 * Custom runtimes are trusted and own their actual isolation behavior.
 */
export class AxProgramSource<
  IN extends AxGenIn,
  OUT extends AxGenOut,
> extends AxProgram<IN, OUT> {
  private readonly tools: ReadonlyMap<string, AxFunction>;
  private readonly allowedCapabilities: ReadonlySet<string>;
  private readonly runtime: AxCodeRuntime;
  private readonly maxPredictorCalls: number;
  private readonly maxToolCalls: number;
  private readonly maxIterations: number;
  private readonly maxStepsPerPredictor: number;
  private readonly timeoutMs: number;
  private readonly valueLimits: AxProgramSourceValueLimits;
  private nextSessionEpoch = 0;
  private readonly lateBridgeEvents: AxProgramSourceLateBridgeEvent[] = [];
  private boundSource: BoundProgramSource;

  constructor(
    signature:
      | string
      | Readonly<AxSignatureConfig>
      | Readonly<AxSignature<IN, OUT>>,
    options?: Readonly<AxProgramSourceOptions>
  ) {
    super(signature, options);
    const tools = options?.tools ?? [];
    const toolMap = new Map<string, AxFunction>();
    for (const tool of tools) {
      if (!tool.name || toolMap.has(tool.name)) {
        throw new AxProgramSourceError(
          `Program source tools must have distinct non-empty names: '${tool.name}'`
        );
      }
      toolMap.set(tool.name, tool);
    }
    this.tools = toolMap;
    this.allowedCapabilities = new Set([
      'predict',
      ...tools.map((tool) => `tool:${tool.name}`),
    ]);
    this.maxPredictorCalls = validateBudget(
      'maxPredictorCalls',
      options?.maxPredictorCalls ?? 16,
      0
    );
    this.maxToolCalls = validateBudget(
      'maxToolCalls',
      options?.maxToolCalls ?? 32,
      0
    );
    this.maxIterations = validateBudget(
      'maxIterations',
      options?.maxIterations ?? 100,
      1
    );
    this.maxStepsPerPredictor = validateBudget(
      'maxStepsPerPredictor',
      options?.maxStepsPerPredictor ?? 8,
      1
    );
    this.timeoutMs = validateBudget(
      'timeoutMs',
      options?.timeoutMs ?? 30_000,
      1
    );
    this.valueLimits = Object.freeze({
      maxBytes: validateBudget(
        'valueLimits.maxBytes',
        options?.valueLimits?.maxBytes ?? DEFAULT_VALUE_LIMITS.maxBytes,
        1
      ),
      maxDepth: validateBudget(
        'valueLimits.maxDepth',
        options?.valueLimits?.maxDepth ?? DEFAULT_VALUE_LIMITS.maxDepth,
        0
      ),
      maxWidth: validateBudget(
        'valueLimits.maxWidth',
        options?.valueLimits?.maxWidth ?? DEFAULT_VALUE_LIMITS.maxWidth,
        1
      ),
    });
    if (options?.runtime) {
      if (options.runtime.protocol !== axProgramSourceRuntimeProtocol) {
        throw new AxProgramSourceError(
          `Custom runtime protocol must be '${axProgramSourceRuntimeProtocol}'`
        );
      }
      if (options.runtime.runtime.language !== 'JavaScript') {
        throw new AxProgramSourceError(
          "Custom program-source runtime language must be 'JavaScript'"
        );
      }
      this.runtime = options.runtime.runtime;
    } else {
      this.runtime = new AxJSRuntime({
        timeout: this.timeoutMs,
        permissions: [],
        outputMode: 'return',
        captureConsole: false,
        allowUnsafeNodeHostAccess: false,
        blockDynamicImport: true,
        allowedModules: [],
        freezeIntrinsics: true,
        blockShadowRealm: true,
        lockWorkerIPC: true,
        useNodePermissionModel: 'auto',
        resourceLimits: axProgramSourceDefaultNodeResourceLimits,
        allowDenoRemoteImport: false,
      });
    }
    this.boundSource = this.bind(
      options?.source ?? seedProgramSource(this.signature, tools)
    );
  }

  public getProgramSource(): string {
    return this.boundSource.source;
  }

  public setProgramSource(source: string): void {
    const next = this.bind(source);
    this.boundSource = next;
  }

  public getCapabilities(): readonly AxProgramSourceCapability[] {
    return [...this.boundSource.document.capabilities];
  }

  public getLateBridgeEvents(): readonly AxProgramSourceLateBridgeEvent[] {
    return this.lateBridgeEvents.map((event) => ({ ...event }));
  }

  public dumpState(): AxProgramSourceState {
    return { version: 1, source: this.boundSource.source };
  }

  public loadState(state: Readonly<AxProgramSourceState>): void {
    if (state?.version !== 1 || typeof state.source !== 'string') {
      throw new AxProgramSourceError('Invalid AxProgramSource state');
    }
    this.setProgramSource(state.source);
  }

  private bind(source: string): BoundProgramSource {
    return bindProgramSource(source, {
      allowedCapabilities: this.allowedCapabilities,
      tools: this.tools,
      signature: this.signature,
      maxIterations: this.maxIterations,
    });
  }

  private validateSourceCandidate = (source: string): true | string => {
    try {
      this.bind(source);
      return true;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  private sourceConstraints(): string {
    const toolCatalog = [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      returns: tool.returns,
    }));
    return [
      'Return one complete JSON document, without markdown fences.',
      `Document version must be ${JSON.stringify(axProgramSourceVersion)}.`,
      `Outer task: ${this.signature.getDescription() || '(no separate description)'}`,
      `Outer signature (immutable): ${this.signature.toString()}`,
      `Host-allowed capabilities: ${JSON.stringify([...this.allowedCapabilities])}. The document must explicitly list every capability it uses.`,
      `Available tools: ${JSON.stringify(toolCatalog)}. No other tools exist.`,
      'Allowed statements: predict, tool, if, forEach, return.',
      'Allowed expressions: literal, ref, object, array, eq, select, not, and, or, concat.',
      "Use signature '$program' to call the immutable outer signature, or a valid Ax string signature for a subtask predictor.",
      'A predict statement may expose only explicitly listed tools. Predictors cannot select models or host services.',
      'The final top-level statement must return every required outer output and no undeclared outputs.',
      `Every forEach must declare maxIterations no greater than ${this.maxIterations}.`,
      `Runtime budgets per example: ${this.maxPredictorCalls} predictor calls, ${this.maxToolCalls} tool calls, ${this.maxIterations} executed statements/loop iterations, ${this.maxStepsPerPredictor} continuation steps per predictor.`,
      `Every input, immutable predictor request snapshot (metadata, input, and selected host tool descriptions/schemas), tool argument/result, and output is limited to ${this.valueLimits.maxBytes} serialized JSON bytes, depth ${this.valueLimits.maxDepth}, and width ${this.valueLimits.maxWidth}.`,
      'Source is a data-only control-flow AST. JavaScript, eval, Function, imports, filesystem, process, network, ambient globals, mutable cross-call state, and dynamic capability construction are unsupported.',
      'Do not hard-code train examples or expected answers. Prefer deterministic control flow only when it generalizes from the declared inputs.',
    ].join('\n');
  }

  protected override localOptimizableComponents(): readonly AxOptimizableComponent[] {
    return [
      ...super.localOptimizableComponents(),
      {
        key: `${this.getId()}::program-source`,
        kind: 'program-source',
        current: this.boundSource.source,
        description:
          'Complete implementation and control flow for this signature-defined program. Propose a whole replacement document, including internal predictor instructions and tool wiring.',
        constraints: this.sourceConstraints(),
        maxLength: MAX_SOURCE_LENGTH,
        format: axProgramSourceVersion,
        validate: this.validateSourceCandidate,
      },
    ];
  }

  protected override applyLocalOptimizedComponents(
    updates: Readonly<Record<string, string>>
  ): void {
    const source = updates[`${this.getId()}::program-source`];
    const nextSource =
      typeof source === 'string' && source !== this.boundSource.source
        ? this.bind(source)
        : undefined;
    super.applyLocalOptimizedComponents(updates);
    if (nextSource) this.boundSource = nextSource;
  }

  public async forward(
    ai: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<AxProgramForwardOptions<any>>
  ): Promise<OUT> {
    if (options?.abortSignal?.aborted) {
      throw new AxProgramSourceError(
        `Aborted: ${options.abortSignal.reason ?? 'execution aborted'}`
      );
    }
    const capturedInputs: Record<string, unknown> = {};
    try {
      for (const field of this.signature.getInputFields()) {
        const descriptor = Object.getOwnPropertyDescriptor(values, field.name);
        if (!descriptor) continue;
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new AxProgramSourceError(
            `Program source input field '${field.name}' must be an enumerable data property`
          );
        }
        if (descriptor.value !== undefined) {
          capturedInputs[field.name] = descriptor.value;
        }
      }
    } catch (error) {
      if (error instanceof AxProgramSourceError) throw error;
      throw new AxProgramSourceError(
        'Program source input could not be inspected',
        { cause: error }
      );
    }
    const snapshotInputs = snapshotSerializableValue(
      capturedInputs,
      this.valueLimits,
      'Program source input'
    );
    for (const field of this.signature.getInputFields()) {
      const value = snapshotInputs[field.name];
      if (value === undefined || value === null) {
        if (!field.isOptional) {
          throw new AxProgramSourceError(
            `Missing required input field '${field.name}'`
          );
        }
        continue;
      }
      validateValue(field, value as never);
    }

    const epoch = ++this.nextSessionEpoch;
    const authorityStartedAt = Date.now();
    const authorityAbort = new AbortController();
    let authorityActive = true;
    let authorityReason = 'session active';
    let rejectExpiration: ((error: Error) => void) | undefined;
    const expiredError = () =>
      new AxProgramSourceSessionExpiredError(
        `Program source session ${epoch} expired: ${authorityReason}`
      );
    const recordLateBridge = (
      kind: AxProgramSourceLateBridgeEvent['kind'],
      name: string,
      phase: AxProgramSourceLateBridgeEvent['phase']
    ) => {
      if (this.lateBridgeEvents.length >= MAX_LATE_BRIDGE_EVENTS) return;
      this.lateBridgeEvents.push({
        epoch,
        kind,
        name,
        phase,
        reason: authorityReason,
        elapsedMs: Date.now() - authorityStartedAt,
      });
    };
    const assertAuthority = (
      kind: AxProgramSourceLateBridgeEvent['kind'],
      name: string,
      phase: AxProgramSourceLateBridgeEvent['phase']
    ) => {
      if (authorityActive) return;
      recordLateBridge(kind, name, phase);
      throw expiredError();
    };
    const revokeAuthority = (reason: string) => {
      if (!authorityActive) return;
      authorityActive = false;
      authorityReason = reason;
      const error = expiredError();
      rejectExpiration?.(error);
      authorityAbort.abort(error);
    };
    let predictorCalls = 0;
    let toolCalls = 0;
    const callTool = async (
      name: string,
      args: unknown,
      emitTrace: boolean,
      capturedTool?: Readonly<AxFunction>
    ): Promise<unknown> => {
      assertAuthority('tool', name, 'call');
      const normalizedArgs = snapshotSerializableValue(
        args ?? {},
        this.valueLimits,
        `Program source tool '${name}' arguments`
      );
      toolCalls += 1;
      if (toolCalls > this.maxToolCalls) {
        throw new AxProgramSourceBudgetError(
          `Program source tool-call budget exceeded: ${this.maxToolCalls}`
        );
      }
      const tool = capturedTool ?? this.tools.get(name);
      if (!tool) {
        throw new AxProgramSourceError(`Tool '${name}' is not available`);
      }
      const startedAt = Date.now();
      try {
        const processor = new AxFunctionProcessor([tool]);
        const result = await processor.executeWithDetails(
          {
            id: `program-source-${toolCalls}`,
            name,
            args: JSON.stringify(normalizedArgs),
          },
          { ...options, ai, abortSignal: authorityAbort.signal }
        );
        assertAuthority('tool', name, 'completion');
        const capturedResult = snapshotSerializableValue(
          result.rawResult,
          this.valueLimits,
          `Program source tool '${name}' result`
        );
        if (emitTrace) {
          try {
            await options?.onFunctionCall?.({
              fn: name,
              componentId: tool.componentId ?? name,
              args: normalizedArgs,
              result: capturedResult,
              ok: true,
              ms: Date.now() - startedAt,
            });
          } catch {}
          assertAuthority('tool', name, 'completion');
        }
        return capturedResult;
      } catch (error) {
        if (!authorityActive) {
          if (!(error instanceof AxProgramSourceSessionExpiredError)) {
            recordLateBridge('tool', name, 'completion');
          }
          throw expiredError();
        }
        if (emitTrace) {
          try {
            await options?.onFunctionCall?.({
              fn: name,
              componentId: tool.componentId ?? name,
              args: normalizedArgs,
              result: error instanceof Error ? error.message : String(error),
              ok: false,
              ms: Date.now() - startedAt,
            });
          } catch {}
        }
        throw error;
      }
    };

    type PredictorSpec = Readonly<{
      signature: '$program' | string;
      instruction?: string;
      tools: readonly string[];
    }>;
    type PredictorRequest = Readonly<{ spec: PredictorSpec; input: unknown }>;

    const predict = async (
      spec: PredictorSpec,
      input: unknown
    ): Promise<unknown> => {
      assertAuthority('predictor', '<request>', 'call');
      const initialRequest = snapshotSerializableValue(
        { spec, input },
        this.valueLimits,
        'Program source predictor request'
      ) as PredictorRequest;
      if (
        !isRecord(initialRequest.spec) ||
        (initialRequest.spec.signature !== '$program' &&
          typeof initialRequest.spec.signature !== 'string') ||
        (initialRequest.spec.instruction !== undefined &&
          typeof initialRequest.spec.instruction !== 'string') ||
        !Array.isArray(initialRequest.spec.tools) ||
        initialRequest.spec.tools.some((name) => typeof name !== 'string')
      ) {
        throw new AxProgramSourceError(
          'Program source predictor request metadata is invalid'
        );
      }
      if (!isRecord(initialRequest.input)) {
        throw new AxProgramSourceError(
          'Program source predictor input must evaluate to an object'
        );
      }

      const capturedFunctions = initialRequest.spec.tools.map((name) => {
        const tool = this.tools.get(name);
        if (!tool)
          throw new AxProgramSourceError(`Tool '${name}' is not available`);
        return captureFunction(
          tool,
          name,
          `Program source predictor tool '${name}'`
        );
      });
      const capturedEnvelope = snapshotSerializableValue(
        {
          request: initialRequest,
          selectedTools: capturedFunctions.map(({ metadata }) => metadata),
        },
        this.valueLimits,
        'Program source predictor request with selected tool schemas'
      );
      const capturedRequest = capturedEnvelope.request as PredictorRequest;
      const predictorName =
        capturedRequest.spec.signature === '$program'
          ? '$program'
          : capturedRequest.spec.signature;
      predictorCalls += 1;
      if (predictorCalls > this.maxPredictorCalls) {
        throw new AxProgramSourceBudgetError(
          `Program source predictor-call budget exceeded: ${this.maxPredictorCalls}`
        );
      }
      const predictorTools = capturedEnvelope.selectedTools.map(
        (metadata, index) => {
          const name = capturedRequest.spec.tools[index]!;
          const executableTool = {
            ...metadata,
            func: capturedFunctions[index]!.handler,
          } as AxFunction;
          return {
            ...metadata,
            func: async (args?: unknown, _options?: unknown) =>
              await callTool(name, args, false, executableTool),
          } as AxFunction;
        }
      );
      const predictor = new AxGen<any, any>(
        capturedRequest.spec.signature === '$program'
          ? this.signature
          : capturedRequest.spec.signature
      );
      if (capturedRequest.spec.instruction) {
        predictor.setInstruction(capturedRequest.spec.instruction);
      }
      try {
        const result = await predictor.forward(ai, capturedRequest.input, {
          ...options,
          functions: predictorTools,
          abortSignal: authorityAbort.signal,
          maxSteps: Math.min(
            options?.maxSteps ?? this.maxStepsPerPredictor,
            this.maxStepsPerPredictor
          ),
          stream: false,
        });
        assertAuthority('predictor', predictorName, 'completion');
        return snapshotSerializableValue(
          result,
          this.valueLimits,
          `Program source predictor '${predictorName}' result`
        );
      } catch (error) {
        if (!authorityActive) {
          if (!(error instanceof AxProgramSourceSessionExpiredError)) {
            recordLateBridge('predictor', predictorName, 'completion');
          }
          throw expiredError();
        }
        throw error;
      } finally {
        this.usage.push(...predictor.getUsage());
      }
    };

    let session: AxCodeSession | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onExternalAbort = () =>
      revokeAuthority(
        `aborted: ${options?.abortSignal?.reason ?? 'execution aborted'}`
      );
    try {
      session = this.runtime.createSession(
        {
          __axProgramSourceDocument: this.boundSource.document,
          __axProgramSourceInputs: snapshotInputs,
          __axProgramSourceMaxIterations: this.maxIterations,
          __axProgramSourcePredict: predict,
          __axProgramSourceTool: (name: string, args: unknown) =>
            callTool(name, args, true),
        },
        { shouldBubbleError: () => true }
      );
      const expiration = new Promise<never>((_resolve, reject) => {
        rejectExpiration = reject;
      });
      timeout = setTimeout(
        () => revokeAuthority(`timed out after ${this.timeoutMs}ms`),
        this.timeoutMs
      );
      options?.abortSignal?.addEventListener('abort', onExternalAbort, {
        once: true,
      });
      if (options?.abortSignal?.aborted) onExternalAbort();
      const execution = session.execute(PROGRAM_SOURCE_RUNTIME, {
        signal: authorityAbort.signal,
      });
      const rawOutput = await Promise.race([execution, expiration]);
      if (!authorityActive) throw expiredError();
      const capturedOutput = snapshotSerializableValue(
        rawOutput,
        this.valueLimits,
        'Program source output'
      );
      if (!isRecord(capturedOutput)) {
        throw new AxProgramSourceError(
          'Program source must return an output object'
        );
      }
      const output: Record<string, unknown> = { ...capturedOutput };
      validateStructuredOutputValues(this.signature, output, {
        rejectUnknownFields: true,
      });
      for (const field of this.signature.getOutputFields()) {
        if (field.isInternal) continue;
        const value = output[field.name];
        if (value === undefined || value === null) continue;
        validateValue(field, value as never);
      }
      this.trace = { ...snapshotInputs, ...output } as OUT;
      return output as OUT;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      options?.abortSignal?.removeEventListener('abort', onExternalAbort);
      revokeAuthority('session closed');
      session?.close();
    }
  }

  public async *streamingForward(
    ai: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<AxProgramStreamingForwardOptions<any>>
  ): AxGenStreamingOut<OUT> {
    const output = await this.forward(ai, values, options);
    yield { version: 0, index: 0, delta: output, partial: output };
  }
}

export function programSource<const T extends string>(
  signature: T,
  options?: Readonly<AxProgramSourceOptions>
): AxProgramSource<ParseSignature<T>['inputs'], ParseSignature<T>['outputs']>;
export function programSource<IN extends AxGenIn, OUT extends AxGenOut>(
  signature: Readonly<AxSignature<IN, OUT>>,
  options?: Readonly<AxProgramSourceOptions>
): AxProgramSource<IN, OUT>;
export function programSource(
  signature: string | Readonly<AxSignatureConfig> | Readonly<AxSignature>,
  options?: Readonly<AxProgramSourceOptions>
): AxProgramSource<AxGenIn, AxGenOut> {
  return new AxProgramSource(signature, options);
}
