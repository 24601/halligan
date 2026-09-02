import { axEventCanonicalJson } from '../../event/util.js';
import {
  type AxSha256Digest,
  axCompareCodeUnits,
  axSha256Digest,
} from './digests.js';

/**
 * Named sockets *around* a program.
 *
 * A candidate's score is only meaningful relative to the configuration it was
 * measured in. Today a GEPA artifact records neither what that configuration
 * was nor which model it was tuned against, so a candidate that was better
 * under one binding set silently keeps its promotion under another.
 *
 * Port ids are OPAQUE host strings validated for shape only. There is
 * deliberately no closed union of port names: nothing inside ax consumes a port
 * id, this module does not search, mutate, or enumerate bindings, and a fixed
 * enumeration is a vocabulary the fork would have to maintain for no runtime
 * benefit. The load-bearing half — digest + `boundModelId` + staleness — is
 * unaffected.
 *
 * DOCTRINE: this module must never describe anything INSIDE a program-source
 * AST. Free AST mutation inside, fixed named sockets around. That boundary is
 * enforced by a TYPE-LEVEL proof in `harnessRecipe.test-d.ts`, not by grepping
 * this file for imports — an import check passes on the day it is written and
 * breaks the moment the module is bundled or moved.
 */
declare const axHarnessPortBrand: unique symbol;

export type AxHarnessPortId = string & {
  readonly [axHarnessPortBrand]: 'harness-port';
};

const PORT_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const PORT_ID_MAX_CHARS = 64;
const ATOM_FIELD_MAX_CHARS = 128;
const MODEL_ID_MAX_CHARS = 128;

export class AxHarnessRecipeError extends Error {
  readonly code:
    | 'invalid_port'
    | 'duplicate_port'
    | 'empty_bindings'
    | 'invalid_atom_id'
    | 'invalid_model_id';
  readonly port?: string;

  constructor(
    args: Readonly<{
      code: AxHarnessRecipeError['code'];
      message: string;
      port?: string;
    }>
  ) {
    super(`${args.code}: ${args.message}`);
    this.name = 'AxHarnessRecipeError';
    this.code = args.code;
    this.port = args.port;
  }
}

const RECIPE_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_port',
  'duplicate_port',
  'empty_bindings',
  'invalid_atom_id',
  'invalid_model_id',
]);

/** Cross-realm structural guard. */
export function axIsHarnessRecipeError(
  error: unknown
): error is AxHarnessRecipeError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxHarnessRecipeError' &&
    typeof candidate.code === 'string' &&
    RECIPE_ERROR_CODES.has(candidate.code)
  );
}

export function axIsHarnessPortId(value: string): value is AxHarnessPortId {
  return value.length <= PORT_ID_MAX_CHARS && PORT_ID_PATTERN.test(value);
}

/** Validates shape and returns the branded id, or throws `AxHarnessRecipeError`. */
export function axHarnessPortId(value: string): AxHarnessPortId {
  if (!axIsHarnessPortId(value)) {
    throw new AxHarnessRecipeError({
      code: 'invalid_port',
      message: `port id ${JSON.stringify(value)} must be lowercase dotted (e.g. \`exec.dispatch\`) and at most ${PORT_ID_MAX_CHARS} characters`,
      port: value,
    });
  }
  return value;
}

/** A binding is data. Implementations are the host's business and are never carried here. */
export interface AxHarnessAtom {
  readonly port: AxHarnessPortId;
  readonly atomId: string;
  readonly version: string;
}

export const axHarnessRecipeVersion = 'ax-harness-recipe/v1';

export interface AxHarnessRecipe {
  readonly version: typeof axHarnessRecipeVersion;
  /** Sorted by (port, atomId). At most one atom per port. */
  readonly bindings: readonly AxHarnessAtom[];
  /** Identity-strength SHA-256 over `axEventCanonicalJson({bindings, boundModelId})`. */
  readonly digest: AxSha256Digest;
  /** Provider model id this configuration was tuned against. Host-supplied; Ax never infers it. */
  readonly boundModelId: string;
}

function requireAtomField(
  value: unknown,
  field: 'atomId' | 'version',
  port: string
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ATOM_FIELD_MAX_CHARS ||
    value.trim() !== value
  ) {
    throw new AxHarnessRecipeError({
      code: 'invalid_atom_id',
      message: `atom ${field} for port ${JSON.stringify(port)} must be a trimmed non-empty string of at most ${ATOM_FIELD_MAX_CHARS} characters`,
      port,
    });
  }
  return value;
}

/**
 * Validates, sorts, digests, and deeply freezes.
 *
 * Async because the digest is identity strength and therefore WebCrypto: a
 * recipe digest is the thing a stale-candidate refusal keys on, so it may not
 * be a 64-bit truncation.
 */
export async function axHarnessRecipe(
  input: Readonly<{
    bindings: readonly Readonly<{
      port: string;
      atomId: string;
      version: string;
    }>[];
    boundModelId: string;
  }>
): Promise<AxHarnessRecipe> {
  if (
    typeof input.boundModelId !== 'string' ||
    input.boundModelId.length === 0 ||
    input.boundModelId.length > MODEL_ID_MAX_CHARS ||
    input.boundModelId.trim() !== input.boundModelId
  ) {
    throw new AxHarnessRecipeError({
      code: 'invalid_model_id',
      message: `boundModelId must be a trimmed non-empty string of at most ${MODEL_ID_MAX_CHARS} characters`,
    });
  }
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw new AxHarnessRecipeError({
      code: 'empty_bindings',
      message: 'a harness recipe must bind at least one port',
    });
  }

  const seen = new Set<string>();
  const bindings: AxHarnessAtom[] = [];
  for (const binding of input.bindings) {
    const port = axHarnessPortId(binding.port);
    if (seen.has(port)) {
      throw new AxHarnessRecipeError({
        code: 'duplicate_port',
        message: `port ${JSON.stringify(port)} is bound more than once; a recipe binds at most one atom per port`,
        port,
      });
    }
    seen.add(port);
    bindings.push(
      Object.freeze({
        port,
        atomId: requireAtomField(binding.atomId, 'atomId', port),
        version: requireAtomField(binding.version, 'version', port),
      })
    );
  }
  // Sorting before digesting is what makes the digest independent of the order
  // a host happened to list its sockets in. The comparison is by UTF-16 code
  // unit and NEVER `localeCompare`: `bindings` is an array, so its order is
  // part of the canonical JSON and therefore part of the digest, and a
  // locale-sensitive comparison would make the identity depend on the host's
  // `LANG`. See `axCompareCodeUnits`.
  bindings.sort((left, right) =>
    left.port === right.port
      ? axCompareCodeUnits(left.atomId, right.atomId)
      : axCompareCodeUnits(left.port, right.port)
  );

  // `boundModelId` is INSIDE the digest: the same binding set tuned against a
  // different model is a different configuration, and must not share an
  // identity with it.
  const digest = await axSha256Digest(
    axEventCanonicalJson({ bindings, boundModelId: input.boundModelId })
  );

  return Object.freeze({
    version: axHarnessRecipeVersion,
    bindings: Object.freeze(bindings),
    digest,
    boundModelId: input.boundModelId,
  });
}

/** The compact stamp carried inside lineage and evidence manifests. */
export interface AxHarnessStamp {
  readonly recipeDigest: AxSha256Digest;
  readonly boundModelId: string;
  /**
   * Set during the run when a `currentModelId` was supplied and differs from
   * `boundModelId`. ABSENT MEANS "not evaluated", never "fresh" — a host that
   * never told Ax which model it was running gets no staleness claim.
   */
  readonly stale?: true;
}

export function axHarnessStamp(
  recipe: Readonly<AxHarnessRecipe>,
  currentModelId?: string
): AxHarnessStamp {
  const stale =
    currentModelId !== undefined && currentModelId !== recipe.boundModelId;
  return Object.freeze({
    recipeDigest: recipe.digest,
    boundModelId: recipe.boundModelId,
    ...(stale ? { stale: true as const } : {}),
  });
}

/** True when the stamp's `boundModelId` differs from the model id supplied by the host. */
export function axIsHarnessStampStale(
  stamp: Readonly<AxHarnessStamp>,
  currentModelId: string
): boolean {
  return stamp.boundModelId !== currentModelId;
}

export class AxCandidateStaleError extends Error {
  readonly code = 'bound_model_changed';
  readonly boundModelId: string;
  readonly observedModelId: string;

  constructor(
    args: Readonly<{ boundModelId: string; observedModelId: string }>
  ) {
    super(
      `bound_model_changed: candidate was tuned against ${JSON.stringify(args.boundModelId)} but the run is using ${JSON.stringify(args.observedModelId)}`
    );
    this.name = 'AxCandidateStaleError';
    this.boundModelId = args.boundModelId;
    this.observedModelId = args.observedModelId;
  }
}

/** Cross-realm structural guard. */
export function axIsCandidateStaleError(
  error: unknown
): error is AxCandidateStaleError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxCandidateStaleError' &&
    candidate.code === 'bound_model_changed'
  );
}

/**
 * Fail-closed variant for hosts that must refuse a stale candidate.
 * Ax itself never refuses on staleness — it records it and leaves the decision
 * where the authority is.
 */
export function axAssertHarnessStampFresh(
  stamp: Readonly<AxHarnessStamp>,
  currentModelId: string
): void {
  if (axIsHarnessStampStale(stamp, currentModelId)) {
    throw new AxCandidateStaleError({
      boundModelId: stamp.boundModelId,
      observedModelId: currentModelId,
    });
  }
}
