import { parseComponentKey } from '../optimizable.js';

/**
 * Mutation depth, patch taxonomy, and component classes.
 *
 * A GEPA lineage record says WHAT changed and what the score was. It does not
 * say what KIND of change it was, how hard the proposer worked, or what it
 * cost. Without that, a run's history cannot be graded: "seven accepted
 * candidates" is not a finding, and a cheap steering tweak and an executable
 * program-source replacement look identical.
 *
 * Everything here is keyed on the component KIND — the structured
 * `AxOptimizableComponent.kind` a program declares, or the kind resolved from a
 * component key by `axInferComponentClass`. Never on the free-text `surface`
 * label that causal evidence records carry: that field is unvalidated host
 * text, so a gate built on it is a gate a host bypasses by typing a different
 * word.
 *
 * Pure and unwired.
 */

export type AxMutationDepth =
  | 'schedule'
  | 'hyperparameter'
  | 'capacity'
  | 'objective'
  | 'supervision'
  | 'updateRule'
  | 'data';

/** Fixed emission order, so two histograms compare byte for byte. */
const MUTATION_DEPTHS: readonly AxMutationDepth[] = Object.freeze([
  'schedule',
  'hyperparameter',
  'capacity',
  'objective',
  'supervision',
  'updateRule',
  'data',
] as const);

export type AxPatchClass = 'capability' | 'steering';

/**
 * Only patch types GEPA can actually produce on this codebase's component
 * kinds. `tool.new`, `tool.argument_modify`, `tool.implementation_fix` and
 * every `middleware.*` value are deliberately absent: GEPA replaces component
 * STRINGS and cannot add or edit an implementation. Shipping unreachable enum
 * members would make the validator either always-throwing or vacuous.
 */
export type AxPatchType =
  // steering — textual only
  | 'prompt.rule_add'
  | 'prompt.rule_modify'
  | 'tool.description_fix'
  | 'tool.name_fix'
  // capability — executable code
  | 'program.source_replace';

/** Derived, never asserted. A declared class that contradicts this table is rejected. */
export const axPatchClassOfType: Readonly<Record<AxPatchType, AxPatchClass>> =
  Object.freeze({
    'prompt.rule_add': 'steering',
    'prompt.rule_modify': 'steering',
    'tool.description_fix': 'steering',
    'tool.name_fix': 'steering',
    'program.source_replace': 'capability',
  } as const);

export type AxComponentClass =
  | 'context'
  | 'tools'
  | 'runtime'
  | 'evaluation'
  | 'orchestration';

const COMPONENT_CLASSES: ReadonlySet<string> = new Set([
  'context',
  'tools',
  'runtime',
  'evaluation',
  'orchestration',
]);

export interface AxPatchTaxonomy {
  readonly class: AxPatchClass;
  readonly type: AxPatchType;
}

export type AxMutationEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

const MUTATION_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'max',
]);

export interface AxMutationAnnotation {
  readonly depth: AxMutationDepth;
  readonly patch: AxPatchTaxonomy;
  /** Component classes the mutation touched. Non-empty, deduplicated, sorted. */
  readonly componentClasses: readonly AxComponentClass[];
  /** Reasoning effort the proposer ran at. `undefined` when unknown — never estimated. */
  readonly effort?: AxMutationEffort;
  /**
   * Measured provider cost of producing and evaluating this candidate.
   * `undefined` when unknown — never estimated, and never defaulted to zero:
   * "free" and "unmeasured" are different claims.
   */
  readonly costUsd?: number;
}

/**
 * Host-supplied annotation policy. Called once per proposed GEPA candidate —
 * NOT once per program-source AST edit; `programSource.ts` has no annotation
 * hook, and pretending otherwise would overstate what the taxonomy covers.
 *
 * Returning `undefined` leaves the candidate unannotated (and, under a
 * `required` policy, blocks its promotion).
 */
export type AxMutationAnnotator = (
  args: Readonly<{
    componentIds: readonly string[];
    componentKinds: readonly string[];
    strategy: 'seed' | 'reflective_mutation' | 'system_merge';
    round: number;
  }>
) => AxMutationAnnotation | undefined;

/**
 * The surface a mutation touched, expressed structurally.
 *
 * `kind` is the program-declared `AxOptimizableComponent.kind` (equivalently,
 * `axInferComponentClass`'s resolution of the component key) and is the ONLY
 * gate input. `componentClass` is a carried label for readers: the validator
 * always re-derives the class from `kind`, so a mislabelled record cannot widen
 * what a patch type is allowed to touch.
 */
export interface AxMutationSurface {
  readonly componentId: string;
  readonly kind: string;
  /** Advisory label carried into records. Never read by `axValidateMutationAnnotation`. */
  readonly componentClass?: AxComponentClass;
  /** Declared `AxProgramSourceCapability[]` for a `program-source` surface. */
  readonly toolCapabilities?: readonly string[];
}

/**
 * Kinds this repo actually emits, and the component class each maps to.
 * `instruction`/`description` come from `program.ts`, `fn-desc`/`fn-name` from
 * `generate.ts`, `actor-tpl` and `program-source` from `programSource.ts`.
 */
export const axKnownComponentKinds: Readonly<Record<string, AxComponentClass>> =
  Object.freeze({
    instruction: 'context',
    description: 'context',
    'fn-desc': 'tools',
    'fn-name': 'tools',
    'actor-tpl': 'orchestration',
    'program-source': 'runtime',
  } as const);

/**
 * Host extension for user-defined kinds. `AxOptimizableComponent.kind` is
 * explicitly free-form ("or any user-defined kind"), so a closed table would be
 * wrong for hosts and a permissive default would make the validator vacuous.
 * A host kind is admissible only when it names its allowed patch types.
 */
export interface AxMutationKindPolicy {
  readonly componentClass: AxComponentClass;
  readonly allowedPatchTypes: readonly AxPatchType[];
}

/** Which kinds each patch type may legitimately touch. */
const ALLOWED_KINDS_BY_PATCH_TYPE: Readonly<
  Record<AxPatchType, readonly string[]>
> = Object.freeze({
  'prompt.rule_add': Object.freeze(['instruction', 'description', 'actor-tpl']),
  'prompt.rule_modify': Object.freeze([
    'instruction',
    'description',
    'actor-tpl',
  ]),
  'tool.description_fix': Object.freeze(['fn-desc']),
  'tool.name_fix': Object.freeze(['fn-name']),
  'program.source_replace': Object.freeze(['program-source']),
});

/** The patch type the default annotator uses for each known kind. */
const DEFAULT_PATCH_TYPE_BY_KIND: Readonly<Record<string, AxPatchType>> =
  Object.freeze({
    instruction: 'prompt.rule_modify',
    description: 'prompt.rule_modify',
    'actor-tpl': 'prompt.rule_modify',
    'fn-desc': 'tool.description_fix',
    'fn-name': 'tool.name_fix',
    'program-source': 'program.source_replace',
  });

export class AxMutationTaxonomyError extends Error {
  readonly code:
    | 'patch_class_mismatch'
    | 'surface_incompatible'
    | 'unknown_component_kind'
    | 'empty_component_classes'
    | 'unknown_depth'
    | 'unknown_effort'
    | 'negative_cost';
  readonly patchType?: AxPatchType;
  readonly componentId?: string;
  readonly componentKind?: string;

  constructor(
    args: Readonly<{
      code: AxMutationTaxonomyError['code'];
      message: string;
      patchType?: AxPatchType;
      componentId?: string;
      componentKind?: string;
    }>
  ) {
    super(`${args.code}: ${args.message}`);
    this.name = 'AxMutationTaxonomyError';
    this.code = args.code;
    this.patchType = args.patchType;
    this.componentId = args.componentId;
    this.componentKind = args.componentKind;
  }
}

const TAXONOMY_ERROR_CODES: ReadonlySet<string> = new Set([
  'patch_class_mismatch',
  'surface_incompatible',
  'unknown_component_kind',
  'empty_component_classes',
  'negative_cost',
]);

/** Cross-realm structural guard. */
export function axIsMutationTaxonomyError(
  error: unknown
): error is AxMutationTaxonomyError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AxMutationTaxonomyError' &&
    typeof candidate.code === 'string' &&
    TAXONOMY_ERROR_CODES.has(candidate.code)
  );
}

/**
 * Resolve the declared component kind from a component key.
 *
 * The key's kind segment is the kind for `instruction`, `description`,
 * `actor-tpl` and `program-source`. It is LOSSY for the two tool-text kinds:
 * `generate.ts` emits `${id}::fn:${fnId}:desc` and `${id}::fn:${fnId}:name`,
 * whose kind segment is just `fn`, while the component itself declares
 * `fn-desc` / `fn-name`. Reading that trailing segment is reading the emitted
 * key grammar, not guessing — and `fn` with any other shape still fails closed,
 * because a patch type that may touch a tool description must not be able to
 * touch a tool name.
 */
function componentKindFromKey(componentKey: string): string | undefined {
  const parsed = parseComponentKey(componentKey);
  if (!parsed) return undefined;
  if (parsed.kind !== 'fn') return parsed.kind;
  if (parsed.subKey?.endsWith(':desc')) return 'fn-desc';
  if (parsed.subKey?.endsWith(':name')) return 'fn-name';
  return undefined;
}

/**
 * Component class for a component key.
 *
 * Throws `unknown_component_kind` for a malformed key or an unmapped kind. It
 * is never a no-op: an unmapped kind means the caller has a surface this
 * taxonomy has never seen, and guessing a class for it is how a validator
 * becomes decorative.
 */
export function axInferComponentClass(
  componentKey: string,
  hostKinds?: Readonly<Record<string, AxMutationKindPolicy>>
): AxComponentClass {
  const kind = componentKindFromKey(componentKey);
  if (kind === undefined) {
    throw new AxMutationTaxonomyError({
      code: 'unknown_component_kind',
      message: `component key ${JSON.stringify(componentKey)} does not resolve to a component kind`,
      componentId: componentKey,
    });
  }
  return componentClassOfKind(kind, componentKey, hostKinds);
}

function componentClassOfKind(
  kind: string,
  componentId: string,
  hostKinds?: Readonly<Record<string, AxMutationKindPolicy>>
): AxComponentClass {
  const known = axKnownComponentKinds[kind];
  if (known) return known;
  const host = hostKinds?.[kind];
  if (host) return host.componentClass;
  throw new AxMutationTaxonomyError({
    code: 'unknown_component_kind',
    message: `component kind ${JSON.stringify(kind)} is not a known kind and no host policy declares it`,
    componentId,
    componentKind: kind,
  });
}

/**
 * Default annotator: `depth: 'updateRule'` for `program-source`,
 * `'supervision'` for the text kinds.
 *
 * Returns `undefined` — leaving the candidate honestly unannotated — when the
 * touched kinds map to more than one patch family or include a kind it does not
 * know. One annotation carries one patch type; inventing one that covers a
 * mixed group would be a false claim, and estimating effort or cost is not
 * something Ax is in a position to do.
 */
export const axDefaultMutationAnnotator: AxMutationAnnotator = (args) => {
  if (args.componentKinds.length === 0) return undefined;
  const patchTypes = new Set<AxPatchType>();
  const classes = new Set<AxComponentClass>();
  for (const kind of args.componentKinds) {
    const patchType = DEFAULT_PATCH_TYPE_BY_KIND[kind];
    const componentClass = axKnownComponentKinds[kind];
    if (!patchType || !componentClass) return undefined;
    patchTypes.add(patchType);
    classes.add(componentClass);
  }
  if (patchTypes.size !== 1) return undefined;
  const type = [...patchTypes][0]!;
  return Object.freeze({
    depth: type === 'program.source_replace' ? 'updateRule' : 'supervision',
    patch: Object.freeze({ class: axPatchClassOfType[type], type }),
    componentClasses: Object.freeze([...classes].sort()),
  });
};

/**
 * Validates a declared annotation against the surfaces it actually touched,
 * keyed on COMPONENT KIND. Fails closed on an unmapped kind.
 *
 * | patch type             | allowed kinds                       |
 * |------------------------|-------------------------------------|
 * | prompt.rule_add        | instruction, description, actor-tpl |
 * | prompt.rule_modify     | instruction, description, actor-tpl |
 * | tool.description_fix   | fn-desc                             |
 * | tool.name_fix          | fn-name                             |
 * | program.source_replace | program-source                      |
 *
 * The declared `componentClasses` must equal the set derived from the touched
 * kinds: a record may not claim a class it did not touch, and may not omit one
 * it did. Returns the normalized (deduplicated, sorted, frozen) annotation.
 */
export function axValidateMutationAnnotation(
  annotation: Readonly<AxMutationAnnotation>,
  surfaces: readonly Readonly<AxMutationSurface>[],
  hostKinds?: Readonly<Record<string, AxMutationKindPolicy>>
): AxMutationAnnotation {
  const type = annotation.patch?.type;
  const derivedClass = type
    ? axPatchClassOfType[type as AxPatchType]
    : undefined;
  if (!derivedClass || annotation.patch.class !== derivedClass) {
    throw new AxMutationTaxonomyError({
      code: 'patch_class_mismatch',
      message: derivedClass
        ? `patch type ${JSON.stringify(type)} is ${derivedClass}, not ${JSON.stringify(annotation.patch.class)}`
        : `patch type ${JSON.stringify(type)} is not a patch type GEPA can produce`,
      patchType: type,
    });
  }

  if (surfaces.length === 0) {
    throw new AxMutationTaxonomyError({
      code: 'surface_incompatible',
      message: 'an annotation must name at least one surface it touched',
      patchType: type,
    });
  }

  const allowed = ALLOWED_KINDS_BY_PATCH_TYPE[type];
  const touchedClasses = new Set<AxComponentClass>();
  for (const surface of surfaces) {
    const componentClass = componentClassOfKind(
      surface.kind,
      surface.componentId,
      hostKinds
    );
    const hostPolicy = hostKinds?.[surface.kind];
    const permitted = axKnownComponentKinds[surface.kind]
      ? allowed.includes(surface.kind)
      : (hostPolicy?.allowedPatchTypes.includes(type) ?? false);
    if (!permitted) {
      throw new AxMutationTaxonomyError({
        code: 'surface_incompatible',
        message: `patch type ${JSON.stringify(type)} cannot touch a ${JSON.stringify(surface.kind)} component`,
        patchType: type,
        componentId: surface.componentId,
        componentKind: surface.kind,
      });
    }
    touchedClasses.add(componentClass);
  }

  const declared = [...new Set(annotation.componentClasses ?? [])].sort();
  if (declared.length === 0) {
    throw new AxMutationTaxonomyError({
      code: 'empty_component_classes',
      message: 'an annotation must declare the component classes it touched',
      patchType: type,
    });
  }
  for (const componentClass of declared) {
    if (!COMPONENT_CLASSES.has(componentClass)) {
      throw new AxMutationTaxonomyError({
        code: 'empty_component_classes',
        message: `component class ${JSON.stringify(componentClass)} is not a known class`,
        patchType: type,
      });
    }
  }
  const touched = [...touchedClasses].sort();
  if (declared.join(' ') !== touched.join(' ')) {
    throw new AxMutationTaxonomyError({
      code: 'empty_component_classes',
      message: `declared component classes [${declared.join(', ')}] do not match the classes actually touched [${touched.join(', ')}]`,
      patchType: type,
    });
  }

  // `depth` is the one field Ax cannot re-derive from the component surfaces,
  // so an unchecked value passes validation and then silently lands in the
  // histogram's `unannotated` bucket — a hole in §6.2's "an invalid annotation
  // aborts the candidate". Every other host assertion in this function is
  // either re-derived or rejected; these two now are too.
  if (!MUTATION_DEPTHS.includes(annotation.depth)) {
    throw new AxMutationTaxonomyError({
      code: 'unknown_depth',
      message: `depth ${JSON.stringify(annotation.depth)} is not one of ${MUTATION_DEPTHS.join(', ')}`,
      patchType: type,
    });
  }
  if (
    annotation.effort !== undefined &&
    !MUTATION_EFFORTS.has(annotation.effort)
  ) {
    throw new AxMutationTaxonomyError({
      code: 'unknown_effort',
      message: `effort ${JSON.stringify(annotation.effort)} is not one of ${[...MUTATION_EFFORTS].join(', ')}`,
      patchType: type,
    });
  }

  if (annotation.costUsd !== undefined) {
    if (!Number.isFinite(annotation.costUsd) || annotation.costUsd < 0) {
      throw new AxMutationTaxonomyError({
        code: 'negative_cost',
        message: `costUsd must be a finite non-negative number, received ${String(annotation.costUsd)}`,
        patchType: type,
      });
    }
  }

  return Object.freeze({
    depth: annotation.depth,
    patch: Object.freeze({ class: derivedClass, type }),
    componentClasses: Object.freeze(touched),
    ...(annotation.effort === undefined ? {} : { effort: annotation.effort }),
    ...(annotation.costUsd === undefined
      ? {}
      : { costUsd: annotation.costUsd }),
  });
}

export type AxMutationDepthHistogram = Readonly<
  Record<AxMutationDepth, number> & { readonly unannotated: number }
>;

/**
 * Counts each depth plus the candidates nobody annotated. `unannotated` is a
 * first-class bucket rather than a silent omission: a run where the annotator
 * kept returning `undefined` must look different from a run with no mutations.
 * Key order is fixed so two histograms serialize comparably.
 */
export function axBuildMutationDepthHistogram(
  annotations: readonly (AxMutationAnnotation | undefined)[]
): AxMutationDepthHistogram {
  const counts = new Map<string, number>();
  for (const depth of MUTATION_DEPTHS) counts.set(depth, 0);
  counts.set('unannotated', 0);
  for (const annotation of annotations) {
    const key =
      annotation && counts.has(annotation.depth)
        ? annotation.depth
        : 'unannotated';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const histogram: Record<string, number> = {};
  for (const depth of MUTATION_DEPTHS) histogram[depth] = counts.get(depth)!;
  histogram.unannotated = counts.get('unannotated')!;
  return Object.freeze(histogram) as AxMutationDepthHistogram;
}
