/**
 * Effect declarations for evolved candidates that can carry a tool capability.
 *
 * GEPA can replace a `program-source` component, and a program source declares
 * `AxProgramSourceCapability` values — `'predict'` and `` `tool:${string}` ``.
 * A candidate that acquires a tool capability can reach the outside world, and
 * today nothing in the promotion record says what it would do there.
 *
 * BINDING SCOPE (stated honestly): `operation` and `replaySafety` are bound to
 * `AxEventEffectIntent` (`src/ax/event/types.ts`) by compile-time equality
 * proofs in the paired `.test-d.ts`. `idempotencyKeySource` and `resolver` are
 * AX-SIDE fields with no counterpart there:
 *   - `idempotencyKeySource` describes HOW the key at
 *     `AxEventEffectIntent.idempotencyKey` (typed `string` there) is produced;
 *     the vocabularies are related, not equal.
 *   - `resolver` records whether the host has registered an
 *     `AxEventEffectResolver` for this operation, so an `'unknown'` replay
 *     safety can still settle rather than staying indeterminate forever.
 * `compensation`, `compensationOperation` and `environment` are deliberately
 * absent: the event runtime has no compensation or environment concept, so a
 * "bound vocabulary" claim over them would simply be false.
 *
 * Ax validates STRUCTURE. It does not prove a declaration is true; it refuses a
 * declaration that is internally impossible to settle.
 *
 * Pure and unwired.
 */

export interface AxCandidateEffectDeclaration {
  /** Stable domain operation name, e.g. `payments.capture`. Bound to `AxEventEffectIntent.operation`. */
  readonly operation: string;
  /** Bound to `NonNullable<AxEventEffectIntent['replaySafety']>`. */
  readonly replaySafety: 'idempotent' | 'unknown';
  /** Ax-side: how `AxEventEffectIntent.idempotencyKey` is produced. Not an event-runtime field. */
  readonly idempotencyKeySource: 'caller_supplied' | 'derived' | 'none';
  /** Ax-side: whether a host `AxEventEffectResolver` exists for this operation. */
  readonly resolver: 'host_resolver' | 'none';
}

export type AxCandidateEffectPolicy = 'off' | 'required';

const OPERATION_MAX_CHARS = 128;

const REPLAY_SAFETY: ReadonlySet<string> = new Set(['idempotent', 'unknown']);
const KEY_SOURCES: ReadonlySet<string> = new Set([
  'caller_supplied',
  'derived',
  'none',
]);
const RESOLVERS: ReadonlySet<string> = new Set(['host_resolver', 'none']);

/**
 * COVERAGE NOTE for whoever wires this in.
 *
 * Three of these codes have no executable coverage in the module that declares
 * them, because the policy that raises them lives in
 * `causalCandidateEvidence.ts`, not here:
 *
 *   - `effects_missing` — a capability-surface candidate that declared no
 *     effects at all;
 *   - `runtime_requirements_missing` — a capability candidate with no runtime
 *     requirement record;
 *   - `effects_on_steering_surface` — an effect declaration attached to a
 *     steering-only surface.
 *
 * This module validates a declaration in isolation and cannot know which
 * surface a candidate touched or whether a manifest is complete. Do not assume
 * these three rows are tested: the wiring commit owns their negative tests.
 * The other three (`effects_invalid`, `unsafe_replay_without_resolver`,
 * `idempotent_without_key`) are raised and tested here.
 */
export class AxCandidateEffectManifestError extends Error {
  readonly code:
    | 'effects_missing'
    | 'effects_invalid'
    | 'unsafe_replay_without_resolver'
    | 'idempotent_without_key'
    | 'runtime_requirements_missing'
    | 'effects_on_steering_surface';
  readonly candidateId?: string;
  readonly componentId?: string;

  constructor(
    args: Readonly<{
      code: AxCandidateEffectManifestError['code'];
      message: string;
      candidateId?: string;
      componentId?: string;
    }>
  ) {
    super(`${args.code}: ${args.message}`);
    this.name = 'AxCandidateEffectManifestError';
    this.code = args.code;
    this.candidateId = args.candidateId;
    this.componentId = args.componentId;
  }
}

const EFFECT_ERROR_CODES: ReadonlySet<string> = new Set([
  'effects_missing',
  'effects_invalid',
  'unsafe_replay_without_resolver',
  'idempotent_without_key',
  'runtime_requirements_missing',
  'effects_on_steering_surface',
]);

/** Cross-realm structural guard. */
export function axIsCandidateEffectManifestError(
  error: unknown
): error is AxCandidateEffectManifestError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxCandidateEffectManifestError' &&
    typeof candidate.code === 'string' &&
    EFFECT_ERROR_CODES.has(candidate.code)
  );
}

/**
 * Structural validation only.
 *
 * Two refusals carry the weight, and both are about a declaration that cannot
 * be settled rather than about a declaration Ax disbelieves:
 *
 * - `unknown` replay safety with no resolver means an indeterminate outcome has
 *   nowhere to go: the event runtime can park such an effect only when a host
 *   `AxEventEffectResolver` exists to reconcile it during recovery.
 * - `idempotent` with no idempotency key source contradicts the event runtime's
 *   own policy — "declare idempotent only when replay with the same key is
 *   safe". Without a key there is no "same key".
 */
export function axValidateCandidateEffectDeclaration(
  declaration: Readonly<AxCandidateEffectDeclaration>,
  field: string
): AxCandidateEffectDeclaration {
  if (!declaration || typeof declaration !== 'object') {
    throw new AxCandidateEffectManifestError({
      code: 'effects_invalid',
      message: `${field} must be an effect declaration record`,
    });
  }
  const { operation, replaySafety, idempotencyKeySource, resolver } =
    declaration;
  if (
    typeof operation !== 'string' ||
    operation.length === 0 ||
    operation.length > OPERATION_MAX_CHARS ||
    operation.trim() !== operation
  ) {
    throw new AxCandidateEffectManifestError({
      code: 'effects_invalid',
      message: `${field}.operation must be a trimmed non-empty name of at most ${OPERATION_MAX_CHARS} characters`,
    });
  }
  if (!REPLAY_SAFETY.has(replaySafety)) {
    throw new AxCandidateEffectManifestError({
      code: 'effects_invalid',
      message: `${field}.replaySafety must be 'idempotent' or 'unknown', received ${JSON.stringify(replaySafety)}`,
    });
  }
  if (!KEY_SOURCES.has(idempotencyKeySource)) {
    throw new AxCandidateEffectManifestError({
      code: 'effects_invalid',
      message: `${field}.idempotencyKeySource must be 'caller_supplied', 'derived' or 'none', received ${JSON.stringify(idempotencyKeySource)}`,
    });
  }
  if (!RESOLVERS.has(resolver)) {
    throw new AxCandidateEffectManifestError({
      code: 'effects_invalid',
      message: `${field}.resolver must be 'host_resolver' or 'none', received ${JSON.stringify(resolver)}`,
    });
  }
  if (replaySafety === 'unknown' && resolver === 'none') {
    throw new AxCandidateEffectManifestError({
      code: 'unsafe_replay_without_resolver',
      message: `${field} declares an indeterminate replay outcome with no host resolver to settle it`,
    });
  }
  if (replaySafety === 'idempotent' && idempotencyKeySource === 'none') {
    throw new AxCandidateEffectManifestError({
      code: 'idempotent_without_key',
      message: `${field} declares idempotent replay but names no idempotency key source; replay-with-the-same-key needs a key`,
    });
  }
  return Object.freeze({
    operation,
    replaySafety,
    idempotencyKeySource,
    resolver,
  });
}

/**
 * The capability-surface test, done STRUCTURALLY.
 *
 * The tempting alternative is to prefix-match `fn`/`tool` over an evidence
 * record's `surface` field. That field is validated only as non-empty text, so
 * such a gate is one a host bypasses by typing a different word — and it
 * matches no component kind this repo actually emits (`description`,
 * `instruction`, `fn-desc`, `fn-name`, `actor-tpl`, `program-source`).
 *
 * The real capability surface is `program-source`, whose AST declares
 * `AxProgramSourceCapability` values, and whose tool members are literally
 * `tool:<name>`. `fn-desc`/`fn-name` are description TEXT: structurally
 * steering, and they can never legitimately carry an effect declaration.
 */
export function axDeclaresToolCapability(
  component: Readonly<{
    componentKind?: string;
    toolCapabilities?: readonly string[];
  }>
): boolean {
  if (component.componentKind !== 'program-source') return false;
  const capabilities = component.toolCapabilities;
  if (!Array.isArray(capabilities)) return false;
  return capabilities.some(
    // A bare `'tool:'` names no tool, so it cannot be evidence that the
    // component reaches one; requiring a non-empty name keeps the
    // capability-surface test from being satisfiable by an empty declaration.
    (capability) =>
      typeof capability === 'string' &&
      capability.startsWith('tool:') &&
      capability.length > 'tool:'.length
  );
}
