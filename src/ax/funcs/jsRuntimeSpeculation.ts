import {
  getJSRuntimeHostFunctionSpeculationAdapter,
  type JSRuntimeHostFunctionSpeculationAdapter,
  type JSRuntimeHostFunctionSpeculationLaunch,
} from './jsRuntimeHostFunction.js';

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_CALLS_PER_EXECUTION = 16;
const MAX_MAX_CONCURRENCY = 32;
const MAX_MAX_CALLS_PER_EXECUTION = 256;
const MAX_SPECULATION_CODE_CHARACTERS = 100_000;
const MAX_SPECULATION_ARGUMENT_CHARACTERS = 50_000;

export type AxJSRuntimeSpeculationPolicy = Readonly<{
  /**
   * Attests that starting and abandoning the callable has no durable
   * application effects. Resource consumption is still possible. Speculation
   * is rejected unless this exact value is present.
   */
  purity: 'pure';
  /** Reuse one result for equivalent calls only when the callable is stable. */
  deterministic: boolean;
}>;

export type AxJSRuntimeSpeculationEventKind =
  | 'dispatch'
  | 'hit'
  | 'miss'
  | 'blocked'
  | 'cancelled';

export type AxJSRuntimeSpeculationEventReason =
  | 'unsupported-syntax'
  | 'unsafe-dependency'
  | 'call-limit'
  | 'code-limit'
  | 'callable-unavailable'
  | 'callable-not-cancellable'
  | 'arguments-too-large'
  | 'arguments-not-canonical'
  | 'no-match'
  | 'execution-complete'
  | 'execution-aborted'
  | 'execution-failed'
  | 'launch-invalidated';

export type AxJSRuntimeSpeculationEvent = Readonly<{
  kind: AxJSRuntimeSpeculationEventKind;
  tool?: string;
  callIndex?: number;
  deterministic?: boolean;
  reason?: AxJSRuntimeSpeculationEventReason;
}>;

export type AxJSRuntimeSpeculationOptions = Readonly<{
  /** Exact runtime paths. Presence is the per-callable opt-in. */
  callables: Readonly<Record<string, AxJSRuntimeSpeculationPolicy>>;
  /** Maximum host operations running at once per execute() (default 4, max 32). */
  maxConcurrency?: number;
  /** Maximum calls planned from one execute() input (default 16, maximum 256). */
  maxCallsPerExecution?: number;
  /** Best-effort diagnostics; callback failures never affect execution. */
  onEvent?: (event: AxJSRuntimeSpeculationEvent) => unknown;
}>;

export type NormalizedAxJSRuntimeSpeculationOptions = Readonly<{
  callables: ReadonlyMap<string, AxJSRuntimeSpeculationPolicy>;
  maxConcurrency: number;
  maxCallsPerExecution: number;
  onEvent?: AxJSRuntimeSpeculationOptions['onEvent'];
}>;

const CALLABLE_PATH_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

function validateBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return normalized;
}

export function normalizeJSRuntimeSpeculationOptions(
  options: AxJSRuntimeSpeculationOptions | undefined
): NormalizedAxJSRuntimeSpeculationOptions | undefined {
  if (!options) return undefined;
  if (
    !options.callables ||
    typeof options.callables !== 'object' ||
    Array.isArray(options.callables)
  ) {
    throw new Error('speculation.callables must be an object');
  }

  const callables = new Map<string, AxJSRuntimeSpeculationPolicy>();
  for (const [path, policy] of Object.entries(options.callables)) {
    if (!CALLABLE_PATH_PATTERN.test(path)) {
      throw new Error(
        `speculation callable path "${path}" must be a dot-qualified JavaScript identifier`
      );
    }
    if (
      !policy ||
      policy.purity !== 'pure' ||
      typeof policy.deterministic !== 'boolean'
    ) {
      throw new Error(
        `speculation callable "${path}" must explicitly set purity: 'pure' and deterministic: boolean`
      );
    }
    callables.set(path, {
      purity: 'pure',
      deterministic: policy.deterministic,
    });
  }

  if (callables.size === 0) return undefined;
  return {
    callables,
    maxConcurrency: validateBoundedInteger(
      options.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      MAX_MAX_CONCURRENCY,
      'speculation.maxConcurrency'
    ),
    maxCallsPerExecution: validateBoundedInteger(
      options.maxCallsPerExecution,
      DEFAULT_MAX_CALLS_PER_EXECUTION,
      MAX_MAX_CALLS_PER_EXECUTION,
      'speculation.maxCallsPerExecution'
    ),
    onEvent: options.onEvent,
  };
}

type TokenKind = 'identifier' | 'string' | 'number' | 'punctuator';

type Token = Readonly<{
  kind: TokenKind;
  value: string | number;
}>;

type TokenizeResult =
  | Readonly<{ safe: true; tokens: readonly Token[] }>
  | Readonly<{ safe: false }>;

const isIdentifierStart = (char: string | undefined): boolean =>
  !!char && /[A-Za-z_$]/.test(char);

const isIdentifierPart = (char: string | undefined): boolean =>
  !!char && /[A-Za-z0-9_$]/.test(char);

function decodeEscape(
  code: string,
  index: number
): Readonly<{ value: string; next: number }> | undefined {
  const char = code[index];
  const simple: Record<string, string> = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '0': '\0',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '`': '`',
  };
  if (char !== undefined && Object.hasOwn(simple, char)) {
    return { value: simple[char]!, next: index + 1 };
  }
  if (char === 'x') {
    const hex = code.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
    return {
      value: String.fromCharCode(Number.parseInt(hex, 16)),
      next: index + 3,
    };
  }
  if (char === 'u') {
    if (code[index + 1] === '{') {
      const close = code.indexOf('}', index + 2);
      if (close === -1) return undefined;
      const hex = code.slice(index + 2, close);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return undefined;
      const point = Number.parseInt(hex, 16);
      if (point > 0x10ffff) return undefined;
      return { value: String.fromCodePoint(point), next: close + 1 };
    }
    const hex = code.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined;
    return {
      value: String.fromCharCode(Number.parseInt(hex, 16)),
      next: index + 5,
    };
  }
  if (char === '\n') return { value: '', next: index + 1 };
  if (char === '\r') {
    return {
      value: '',
      next: code[index + 1] === '\n' ? index + 2 : index + 1,
    };
  }
  if (char === undefined || /[0-9]/.test(char)) return undefined;
  return { value: char, next: index + 1 };
}

function readQuotedString(
  code: string,
  start: number,
  quote: string
): Readonly<{ value: string; next: number }> | undefined {
  let value = '';
  let index = start + 1;
  while (index < code.length) {
    const char = code[index]!;
    if (char === quote) return { value, next: index + 1 };
    if (char === '\n' || char === '\r') return undefined;
    if (quote === '`' && char === '$' && code[index + 1] === '{') {
      return undefined;
    }
    if (char !== '\\') {
      value += char;
      index++;
      continue;
    }
    const escaped = decodeEscape(code, index + 1);
    if (!escaped) return undefined;
    value += escaped.value;
    index = escaped.next;
  }
  return undefined;
}

function tokenize(code: string): TokenizeResult {
  const tokens: Token[] = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '/' && code[index + 1] === '/') {
      index += 2;
      while (index < code.length && code[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && code[index + 1] === '*') {
      const close = code.indexOf('*/', index + 2);
      if (close === -1) return { safe: false };
      index = close + 2;
      continue;
    }
    // A regular-expression literal and division are deliberately outside the
    // tokenizer's subset. Guessing which one this slash means is unsafe.
    if (char === '/') return { safe: false };

    if (char === "'" || char === '"' || char === '`') {
      const parsed = readQuotedString(code, index, char);
      if (!parsed) return { safe: false };
      tokens.push({ kind: 'string', value: parsed.value });
      index = parsed.next;
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index++;
      while (isIdentifierPart(code[index])) index++;
      tokens.push({ kind: 'identifier', value: code.slice(start, index) });
      continue;
    }

    if (/[0-9]/.test(char)) {
      const rest = code.slice(index);
      const match = rest.match(
        /^(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/
      );
      if (!match) return { safe: false };
      const raw = match[0];
      const value = Number(raw);
      if (!Number.isFinite(value)) return { safe: false };
      tokens.push({ kind: 'number', value });
      index += raw.length;
      continue;
    }

    if ('(){}[]:,.=;+-'.includes(char)) {
      tokens.push({ kind: 'punctuator', value: char });
      index++;
      continue;
    }

    // Unknown syntax disables planning for the whole cell. Real worker
    // execution remains unchanged.
    return { safe: false };
  }
  return { safe: true, tokens };
}

function splitTopLevelStatements(
  tokens: readonly Token[]
): readonly (readonly Token[])[] | undefined {
  const statements: Token[][] = [];
  let current: Token[] = [];
  const stack: string[] = [];
  const matchingOpen: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
  };

  for (const token of tokens) {
    if (token.kind === 'punctuator') {
      const value = String(token.value);
      if (value === '(' || value === '[' || value === '{') {
        stack.push(value);
      } else if (value === ')' || value === ']' || value === '}') {
        if (stack.pop() !== matchingOpen[value]) return undefined;
      } else if (value === ';' && stack.length === 0) {
        if (current.length > 0) statements.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (stack.length > 0) return undefined;
  if (current.length > 0) statements.push(current);
  return statements;
}

type Expression =
  | Readonly<{ kind: 'literal'; value: unknown }>
  | Readonly<{ kind: 'reference'; name: string }>
  | Readonly<{
      kind: 'member';
      target: Expression;
      property: string | number;
    }>
  | Readonly<{ kind: 'array'; items: readonly Expression[] }>
  | Readonly<{
      kind: 'object';
      entries: readonly Readonly<{ key: string; value: Expression }>[];
    }>
  | Readonly<{
      kind: 'add';
      left: Expression;
      right: Expression;
    }>
  | Readonly<{ kind: 'negate'; value: Expression }>;

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  public parseAll(): Expression | undefined {
    const expression = this.parseAdditive();
    return expression && this.index === this.tokens.length
      ? expression
      : undefined;
  }

  private peek(value?: string): Token | undefined {
    const token = this.tokens[this.index];
    if (value !== undefined && token?.value !== value) return undefined;
    return token;
  }

  private consume(value?: string): Token | undefined {
    const token = this.peek(value);
    if (!token) return undefined;
    this.index++;
    return token;
  }

  private parseAdditive(): Expression | undefined {
    let left = this.parseUnary();
    if (!left) return undefined;
    while (this.consume('+')) {
      const right = this.parseUnary();
      if (!right) return undefined;
      left = { kind: 'add', left, right };
    }
    return left;
  }

  private parseUnary(): Expression | undefined {
    if (this.consume('-')) {
      const value = this.parseUnary();
      return value ? { kind: 'negate', value } : undefined;
    }
    return this.parseMember();
  }

  private parseMember(): Expression | undefined {
    let target = this.parsePrimary();
    if (!target) return undefined;
    while (true) {
      if (this.consume('.')) {
        const property = this.consume();
        if (!property || property.kind !== 'identifier') return undefined;
        target = {
          kind: 'member',
          target,
          property: String(property.value),
        };
        continue;
      }
      if (this.consume('[')) {
        const property = this.consume();
        if (
          !property ||
          (property.kind !== 'string' && property.kind !== 'number') ||
          !this.consume(']')
        ) {
          return undefined;
        }
        target = {
          kind: 'member',
          target,
          property: property.value,
        };
        continue;
      }
      return target;
    }
  }

  private parsePrimary(): Expression | undefined {
    const token = this.consume();
    if (!token) return undefined;
    if (token.kind === 'string' || token.kind === 'number') {
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'identifier') {
      switch (token.value) {
        case 'true':
          return { kind: 'literal', value: true };
        case 'false':
          return { kind: 'literal', value: false };
        case 'null':
          return { kind: 'literal', value: null };
        default:
          return { kind: 'reference', name: String(token.value) };
      }
    }
    if (token.value === '(') {
      const expression = this.parseAdditive();
      return expression && this.consume(')') ? expression : undefined;
    }
    if (token.value === '[') {
      const items: Expression[] = [];
      if (this.consume(']')) return { kind: 'array', items };
      while (true) {
        const item = this.parseAdditive();
        if (!item) return undefined;
        items.push(item);
        if (this.consume(']')) return { kind: 'array', items };
        if (!this.consume(',')) return undefined;
      }
    }
    if (token.value === '{') {
      const entries: { key: string; value: Expression }[] = [];
      if (this.consume('}')) return { kind: 'object', entries };
      while (true) {
        const key = this.consume();
        if (
          !key ||
          (key.kind !== 'identifier' &&
            key.kind !== 'string' &&
            key.kind !== 'number') ||
          !this.consume(':')
        ) {
          return undefined;
        }
        const value = this.parseAdditive();
        if (!value) return undefined;
        entries.push({ key: String(key.value), value });
        if (this.consume('}')) return { kind: 'object', entries };
        if (!this.consume(',')) return undefined;
      }
    }
    return undefined;
  }
}

type PlannedCall = Readonly<{
  tool: string;
  args: readonly Expression[];
  binding?: string;
  awaited: boolean;
}>;

function parseQualifiedPath(
  tokens: readonly Token[],
  start: number
): Readonly<{ path: string; next: number }> | undefined {
  const first = tokens[start];
  if (first?.kind !== 'identifier') return undefined;
  const parts = [String(first.value)];
  let index = start + 1;
  while (
    tokens[index]?.value === '.' &&
    tokens[index + 1]?.kind === 'identifier'
  ) {
    parts.push(String(tokens[index + 1]!.value));
    index += 2;
  }
  return { path: parts.join('.'), next: index };
}

function splitCallArguments(
  tokens: readonly Token[],
  start: number
): Readonly<{ args: readonly (readonly Token[])[]; next: number }> | undefined {
  if (tokens[start]?.value !== '(') return undefined;
  const args: Token[][] = [];
  let current: Token[] = [];
  const stack: string[] = [];
  const matchingOpen: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
  };
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    const value = String(token.value);
    if (token.kind === 'punctuator') {
      if (value === '(' || value === '[' || value === '{') {
        stack.push(value);
      } else if (value === ')' || value === ']' || value === '}') {
        if (value === ')' && stack.length === 0) {
          if (current.length > 0) args.push(current);
          return { args, next: index + 1 };
        }
        if (stack.pop() !== matchingOpen[value]) return undefined;
      } else if (value === ',' && stack.length === 0) {
        if (current.length === 0) return undefined;
        args.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  return undefined;
}

function isDeclarationEquals(
  statement: readonly Token[],
  index: number
): boolean {
  const name = statement[index - 1];
  const declaration = statement[index - 2];
  return (
    name?.kind === 'identifier' &&
    (declaration?.value === 'const' ||
      declaration?.value === 'let' ||
      declaration?.value === 'var')
  );
}

function isEqualityEquals(statement: readonly Token[], index: number): boolean {
  return (
    statement[index - 1]?.value === '=' || statement[index + 1]?.value === '='
  );
}

function isUnsupportedMutation(statement: readonly Token[]): boolean {
  for (let index = 0; index < statement.length; index++) {
    const token = statement[index]!;
    if (token.kind !== 'punctuator') continue;
    const value = String(token.value);
    const next = statement[index + 1]?.value;
    if (value === '+' && next === '+') return true;
    if (value === '-' && next === '-') return true;
    if ((value === '+' || value === '-') && next === '=') return true;
    if (value !== '=') continue;
    if (isEqualityEquals(statement, index)) continue;
    if (isDeclarationEquals(statement, index)) continue;
    return true;
  }
  return false;
}

function parsePlannedCall(
  statement: readonly Token[],
  configuredTools: ReadonlySet<string>
): PlannedCall | undefined {
  let index = 0;
  let binding: string | undefined;
  const declaration = statement[index]?.value;
  if (
    declaration === 'const' ||
    declaration === 'let' ||
    declaration === 'var'
  ) {
    const name = statement[index + 1];
    if (name?.kind !== 'identifier' || statement[index + 2]?.value !== '=') {
      return undefined;
    }
    binding = String(name.value);
    index += 3;
  }

  const awaited = statement[index]?.value === 'await';
  if (awaited) index++;
  const qualified = parseQualifiedPath(statement, index);
  if (!qualified || !configuredTools.has(qualified.path)) return undefined;
  const parsedArgs = splitCallArguments(statement, qualified.next);
  if (!parsedArgs || parsedArgs.next !== statement.length) return undefined;
  const args: Expression[] = [];
  for (const argTokens of parsedArgs.args) {
    const expression = new ExpressionParser(argTokens).parseAll();
    if (!expression) return undefined;
    args.push(expression);
  }
  return { tool: qualified.path, args, binding, awaited };
}

function findConfiguredCalls(
  statement: readonly Token[],
  configuredTools: ReadonlySet<string>
): string[] {
  const found = new Set<string>();
  for (let index = 0; index < statement.length; index++) {
    const qualified = parseQualifiedPath(statement, index);
    if (
      qualified &&
      configuredTools.has(qualified.path) &&
      statement[qualified.next]?.value === '('
    ) {
      found.add(qualified.path);
    }
  }
  return [...found];
}

function hasPotentialCall(statement: readonly Token[]): boolean {
  if (statement[0]?.value === 'throw' || statement[0]?.value === 'return') {
    return false;
  }
  for (let index = 0; index < statement.length; index++) {
    const qualified = parseQualifiedPath(statement, index);
    const next = qualified ? statement[qualified.next] : undefined;
    if (next?.value === '(' || next?.kind === 'string') return true;
    if (
      (statement[index]?.value === ')' || statement[index]?.value === ']') &&
      statement[index + 1]?.value === '('
    ) {
      return true;
    }
  }
  return false;
}

class ArgumentsTooLargeError extends Error {}
class UnsafeDependencyError extends Error {}
class SpeculationUnavailableError extends Error {}

type EvaluationEnvironment = Readonly<{
  globals: Readonly<Record<string, unknown>>;
  bindings: ReadonlyMap<string, Promise<unknown>>;
}>;

const UNSAFE_PROPERTY_NAMES = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

async function evaluateExpression(
  expression: Expression,
  environment: EvaluationEnvironment
): Promise<unknown> {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'reference': {
      const binding = environment.bindings.get(expression.name);
      if (binding) return binding;
      if (Object.hasOwn(environment.globals, expression.name)) {
        const value = environment.globals[expression.name];
        if (typeof value === 'function') throw new UnsafeDependencyError();
        return value;
      }
      if (expression.name === 'undefined') return undefined;
      throw new UnsafeDependencyError();
    }
    case 'member': {
      const target = await evaluateExpression(expression.target, environment);
      const property = expression.property;
      if (UNSAFE_PROPERTY_NAMES.has(String(property))) {
        throw new UnsafeDependencyError();
      }
      if (typeof target === 'string') {
        if (property === 'length') return target.length;
        if (typeof property === 'number' && Number.isInteger(property)) {
          return target[property];
        }
        throw new UnsafeDependencyError();
      }
      if (Array.isArray(target)) {
        if (property === 'length') return target.length;
        const index =
          typeof property === 'number'
            ? property
            : Number.parseInt(property, 10);
        if (!Number.isInteger(index) || String(index) !== String(property)) {
          throw new UnsafeDependencyError();
        }
        return target[index];
      }
      if (!isPlainObject(target) || !Object.hasOwn(target, property)) {
        throw new UnsafeDependencyError();
      }
      return target[property];
    }
    case 'array':
      return Promise.all(
        expression.items.map((item) => evaluateExpression(item, environment))
      );
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of expression.entries) {
        if (UNSAFE_PROPERTY_NAMES.has(entry.key)) {
          throw new UnsafeDependencyError();
        }
        out[entry.key] = await evaluateExpression(entry.value, environment);
      }
      return out;
    }
    case 'add': {
      const [left, right] = await Promise.all([
        evaluateExpression(expression.left, environment),
        evaluateExpression(expression.right, environment),
      ]);
      if (
        (typeof left !== 'string' && typeof left !== 'number') ||
        (typeof right !== 'string' && typeof right !== 'number')
      ) {
        throw new UnsafeDependencyError();
      }
      return typeof left === 'string' || typeof right === 'string'
        ? String(left) + String(right)
        : left + right;
    }
    case 'negate': {
      const value = await evaluateExpression(expression.value, environment);
      if (typeof value !== 'number') throw new UnsafeDependencyError();
      return -value;
    }
  }
}

type CanonicalizationBudget = { remaining: number };

function consumeCanonicalizationBudget(
  budget: CanonicalizationBudget,
  characters: number
): void {
  budget.remaining -= characters;
  if (budget.remaining < 0) throw new ArgumentsTooLargeError();
}

function canonicalize(
  value: unknown,
  seen = new Set<object>(),
  budget: CanonicalizationBudget = {
    remaining: MAX_SPECULATION_ARGUMENT_CHARACTERS,
  }
): string {
  if (value === null) {
    consumeCanonicalizationBudget(budget, 'null'.length);
    return 'null';
  }
  switch (typeof value) {
    case 'undefined':
      consumeCanonicalizationBudget(budget, 'undefined'.length);
      return 'undefined';
    case 'boolean':
      consumeCanonicalizationBudget(
        budget,
        value ? 'boolean:true'.length : 'boolean:false'.length
      );
      return value ? 'boolean:true' : 'boolean:false';
    case 'string': {
      if (value.length > budget.remaining) throw new ArgumentsTooLargeError();
      const canonical = `string:${JSON.stringify(value)}`;
      consumeCanonicalizationBudget(budget, canonical.length);
      return canonical;
    }
    case 'number':
      if (!Number.isFinite(value)) throw new UnsafeDependencyError();
      {
        const canonical = `number:${Object.is(value, -0) ? '-0' : String(value)}`;
        consumeCanonicalizationBudget(budget, canonical.length);
        return canonical;
      }
    case 'object': {
      if (seen.has(value)) throw new UnsafeDependencyError();
      seen.add(value);
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length > 0
        ) {
          throw new UnsafeDependencyError();
        }
        for (const property of Object.getOwnPropertyNames(value)) {
          if (property === 'length') continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, property);
          const index = Number(property);
          if (
            !descriptor?.enumerable ||
            !('value' in descriptor) ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== property
          ) {
            throw new UnsafeDependencyError();
          }
        }
        consumeCanonicalizationBudget(budget, 'array:[]'.length);
        const items: string[] = [];
        for (let index = 0; index < value.length; index++) {
          if (items.length > 0) consumeCanonicalizationBudget(budget, 1);
          if (!Object.hasOwn(value, index)) {
            consumeCanonicalizationBudget(budget, 'hole'.length);
            items.push('hole');
            continue;
          }
          items.push(canonicalize(value[index], seen, budget));
        }
        return `array:[${items.join(',')}]`;
      }
      if (
        !isPlainObject(value) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        throw new UnsafeDependencyError();
      }
      consumeCanonicalizationBudget(budget, 'object:{}'.length);
      const entries: string[] = [];
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new UnsafeDependencyError();
        }
        if (key.length > budget.remaining) {
          throw new ArgumentsTooLargeError();
        }
        const canonicalKey = JSON.stringify(key);
        consumeCanonicalizationBudget(
          budget,
          canonicalKey.length + (entries.length > 0 ? 2 : 1)
        );
        entries.push(
          `${canonicalKey}:${canonicalize(value[key], seen, budget)}`
        );
      }
      return `object:{${entries.join(',')}}`;
    }
    default:
      throw new UnsafeDependencyError();
  }
}

function cloneCanonicalGraph(value: unknown): unknown {
  // Worker callbacks observe a fresh structured clone for every invocation.
  // Validate and clone here so separate speculative launches cannot share
  // mutable host references, and planning cannot observe graph details the
  // worker transport would expose differently. Environments without
  // structuredClone fail closed.
  canonicalize(value);
  if (typeof structuredClone !== 'function') {
    throw new UnsafeDependencyError();
  }
  try {
    return structuredClone(value);
  } catch {
    throw new UnsafeDependencyError();
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new SpeculationUnavailableError();
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const resume = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(resume);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new SpeculationUnavailableError());
      };
      this.waiters.push(resume);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  public async run<T>(
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal.aborted) throw new SpeculationUnavailableError();
      return await operation();
    } finally {
      this.release();
    }
  }
}

type SpeculationEntry = {
  index: number;
  tool: string;
  ref: string;
  deterministic: boolean;
  adapter: JSRuntimeHostFunctionSpeculationAdapter;
  controller: AbortController;
  keyReady: Promise<string | undefined>;
  launchReady: Promise<JSRuntimeHostFunctionSpeculationLaunch>;
  result: Promise<unknown>;
  claimed: boolean;
  reserving: boolean;
  dispatched: boolean;
  cancelled: boolean;
};

export type JSRuntimeSpeculationClaim =
  | Readonly<{ hit: false }>
  | Readonly<{ hit: true; value: Promise<unknown> }>;

export class JSRuntimeSpeculationTurn {
  private readonly entries: SpeculationEntry[] = [];
  private readonly semaphore: Semaphore;
  private readonly deterministicLaunches = new Map<
    string,
    Promise<JSRuntimeHostFunctionSpeculationLaunch>
  >();
  private finished = false;

  constructor(
    private readonly options: NormalizedAxJSRuntimeSpeculationOptions,
    private readonly fnMap: ReadonlyMap<
      string,
      (...args: unknown[]) => unknown
    >,
    private readonly fnPathToRef: ReadonlyMap<string, string>,
    private readonly refToFnPath: ReadonlyMap<string, string>
  ) {
    this.semaphore = new Semaphore(options.maxConcurrency);
  }

  private emit(event: AxJSRuntimeSpeculationEvent): void {
    const handler = this.options.onEvent;
    if (!handler) return;
    try {
      void Promise.resolve(handler(event)).catch(() => {});
    } catch {}
  }

  public plan(code: string, globals: Readonly<Record<string, unknown>>): void {
    if (code.length > MAX_SPECULATION_CODE_CHARACTERS) {
      this.emit({ kind: 'blocked', reason: 'code-limit' });
      return;
    }
    const tokenized = tokenize(code);
    if (!tokenized.safe) {
      this.emit({ kind: 'blocked', reason: 'unsupported-syntax' });
      return;
    }
    const statements = splitTopLevelStatements(tokenized.tokens);
    if (!statements) {
      this.emit({ kind: 'blocked', reason: 'unsupported-syntax' });
      return;
    }

    const configuredTools = new Set(this.options.callables.keys());
    const bindings = new Map<string, Promise<unknown>>();
    let callLimitReported = false;
    let unsafeCallBarrier = false;

    for (const statement of statements) {
      if (isUnsupportedMutation(statement)) {
        this.emit({ kind: 'blocked', reason: 'unsafe-dependency' });
        return;
      }
      let parsed: PlannedCall | undefined;
      try {
        parsed = parsePlannedCall(statement, configuredTools);
      } catch {
        this.emit({ kind: 'blocked', reason: 'unsupported-syntax' });
        if (hasPotentialCall(statement)) unsafeCallBarrier = true;
        continue;
      }
      if (!parsed) {
        for (const tool of findConfiguredCalls(statement, configuredTools)) {
          this.emit({
            kind: 'blocked',
            tool,
            reason: 'unsupported-syntax',
          });
        }
        if (hasPotentialCall(statement)) unsafeCallBarrier = true;
        continue;
      }
      const policy = this.options.callables.get(parsed.tool)!;
      if (unsafeCallBarrier) {
        this.emit({
          kind: 'blocked',
          tool: parsed.tool,
          callIndex: this.entries.length,
          deterministic: policy.deterministic,
          reason: 'unsafe-dependency',
        });
        continue;
      }
      if (this.entries.length >= this.options.maxCallsPerExecution) {
        if (!callLimitReported) {
          callLimitReported = true;
          this.emit({
            kind: 'blocked',
            tool: parsed.tool,
            reason: 'call-limit',
          });
        }
        continue;
      }

      const ref = this.fnPathToRef.get(parsed.tool);
      if (!ref) {
        this.emit({
          kind: 'blocked',
          tool: parsed.tool,
          reason: 'callable-unavailable',
        });
        continue;
      }
      const fn = this.fnMap.get(ref);
      if (!fn) {
        this.emit({
          kind: 'blocked',
          tool: parsed.tool,
          reason: 'callable-unavailable',
        });
        continue;
      }
      const adapter = getJSRuntimeHostFunctionSpeculationAdapter(fn);
      if (!adapter) {
        this.emit({
          kind: 'blocked',
          tool: parsed.tool,
          reason: 'callable-not-cancellable',
        });
        continue;
      }

      const index = this.entries.length;
      const controller = new AbortController();
      const environment = { globals, bindings };
      const argsReady = Promise.all(
        parsed.args.map((expression) =>
          evaluateExpression(expression, environment)
        )
      ).then((args) => cloneCanonicalGraph(args) as unknown[]);
      let blockedReported = false;
      const keyReady = argsReady
        .then((args) => {
          const key = canonicalize(args);
          if (key.length > MAX_SPECULATION_ARGUMENT_CHARACTERS) {
            this.emit({
              kind: 'blocked',
              tool: parsed.tool,
              callIndex: index,
              deterministic: policy.deterministic,
              reason: 'arguments-too-large',
            });
            blockedReported = true;
            return undefined;
          }
          return key;
        })
        .catch((error) => {
          if (!blockedReported) {
            this.emit({
              kind: 'blocked',
              tool: parsed.tool,
              callIndex: index,
              deterministic: policy.deterministic,
              reason:
                error instanceof ArgumentsTooLargeError
                  ? 'arguments-too-large'
                  : 'unsafe-dependency',
            });
          }
          return undefined;
        });

      const entry = {} as SpeculationEntry;
      const launchReady = (async () => {
        const key = await keyReady;
        if (key === undefined || controller.signal.aborted) {
          throw new SpeculationUnavailableError();
        }
        const args = await argsReady;
        const launch = () => {
          let settled = false;
          let resolveLaunch!: (
            value: JSRuntimeHostFunctionSpeculationLaunch
          ) => void;
          const ready = new Promise<JSRuntimeHostFunctionSpeculationLaunch>(
            (resolve) => {
              resolveLaunch = resolve;
            }
          );
          const settle = (value: JSRuntimeHostFunctionSpeculationLaunch) => {
            if (settled) return;
            settled = true;
            resolveLaunch(value);
          };
          const failedLaunch = (
            error: unknown
          ): JSRuntimeHostFunctionSpeculationLaunch => {
            const result = Promise.reject(error);
            void result.catch(() => {});
            return {
              result,
              canClaim: () => false,
              invalidReason: 'launch-invalidated',
            };
          };
          const slot = this.semaphore.run(controller.signal, async () => {
            entry.dispatched = true;
            this.emit({
              kind: 'dispatch',
              tool: parsed.tool,
              callIndex: index,
              deterministic: policy.deterministic,
            });
            try {
              const launched = await adapter.launch(args, controller.signal);
              settle(launched);
              return await launched.result;
            } catch (error) {
              const failed = failedLaunch(error);
              settle(failed);
              return failed.result;
            }
          });
          void slot.catch((error) => settle(failedLaunch(error)));
          return ready;
        };
        if (!policy.deterministic) return launch();

        const deterministicKey = `${ref}\n${key}`;
        const existing = this.deterministicLaunches.get(deterministicKey);
        if (existing) return existing;
        const sharedLaunch = launch();
        this.deterministicLaunches.set(deterministicKey, sharedLaunch);
        return sharedLaunch;
      })();
      const result = launchReady.then((launch) => launch.result);
      Object.assign(entry, {
        index,
        tool: parsed.tool,
        ref,
        deterministic: policy.deterministic,
        adapter,
        controller,
        keyReady,
        launchReady,
        result,
        claimed: false,
        reserving: false,
        dispatched: false,
        cancelled: false,
      } satisfies SpeculationEntry);
      this.entries.push(entry);
      // Every speculative rejection is observed immediately. A real claim
      // still receives the same rejection through adapter.commit().
      void result.catch(() => {});

      if (parsed.binding && parsed.awaited) {
        const dependency = result.then(cloneCanonicalGraph);
        // A declaration does not guarantee that a later planned call consumes
        // its binding. Observe clone/rejection failures without changing what
        // an actual dependent plan would await.
        void dependency.catch(() => {});
        bindings.set(parsed.binding, dependency);
      }
    }
  }

  public async claim(
    ref: string,
    args: readonly unknown[]
  ): Promise<JSRuntimeSpeculationClaim> {
    const tool = this.refToFnPath.get(ref);
    const policy = tool ? this.options.callables.get(tool) : undefined;
    if (!tool || !policy) return { hit: false };

    let actualKey: string;
    try {
      actualKey = canonicalize(args);
      if (actualKey.length > MAX_SPECULATION_ARGUMENT_CHARACTERS) {
        this.emit({
          kind: 'miss',
          tool,
          deterministic: policy.deterministic,
          reason: 'arguments-too-large',
        });
        return { hit: false };
      }
    } catch (error) {
      this.emit({
        kind: 'miss',
        tool,
        deterministic: policy.deterministic,
        reason:
          error instanceof ArgumentsTooLargeError
            ? 'arguments-too-large'
            : 'arguments-not-canonical',
      });
      return { hit: false };
    }

    // Program order matters for nondeterministic duplicate calls. Await key
    // readiness one candidate at a time so a later dependent call cannot
    // deadlock an earlier claim.
    for (const entry of this.entries) {
      if (entry.ref !== ref || entry.cancelled) continue;
      if (!entry.deterministic && (entry.claimed || entry.reserving)) {
        continue;
      }
      // Reserve before the first await so overlapping claims cannot share one
      // nondeterministic launch. Deterministic entries remain shareable.
      if (!entry.deterministic) entry.reserving = true;
      const key = await entry.keyReady;
      if (entry.cancelled) {
        if (!entry.deterministic) entry.reserving = false;
        continue;
      }
      if (key !== actualKey) {
        if (!entry.deterministic) entry.reserving = false;
        continue;
      }
      const launch = await entry.launchReady;
      if (entry.cancelled) {
        if (!entry.deterministic) entry.reserving = false;
        continue;
      }
      let canClaim = true;
      try {
        canClaim = launch.canClaim?.() ?? true;
      } catch {
        canClaim = false;
      }
      if (!canClaim) {
        entry.reserving = false;
        entry.cancelled = true;
        entry.controller.abort('speculative authority invalidated');
        this.emit({
          kind: 'miss',
          tool,
          callIndex: entry.index,
          deterministic: entry.deterministic,
          reason: launch.invalidReason ?? 'launch-invalidated',
        });
        return { hit: false };
      }
      entry.claimed = true;
      entry.reserving = false;
      launch.retain?.();
      this.emit({
        kind: 'hit',
        tool,
        callIndex: entry.index,
        deterministic: entry.deterministic,
      });
      return {
        hit: true,
        value: entry.adapter.commit(args, launch),
      };
    }

    this.emit({
      kind: 'miss',
      tool,
      deterministic: policy.deterministic,
      reason: 'no-match',
    });
    return { hit: false };
  }

  public finish(
    reason: 'execution-complete' | 'execution-aborted' | 'execution-failed'
  ): void {
    if (this.finished) return;
    this.finished = true;
    const cancelClaimed = reason !== 'execution-complete';
    for (const entry of this.entries) {
      if (entry.cancelled || (!cancelClaimed && entry.claimed)) continue;
      entry.cancelled = true;
      entry.controller.abort(
        cancelClaimed ? reason : 'speculation not claimed'
      );
      this.emit({
        kind: 'cancelled',
        tool: entry.tool,
        callIndex: entry.index,
        deterministic: entry.deterministic,
        reason,
      });
    }
  }
}
