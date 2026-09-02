import type { Equal, Expect } from '../../util/typetest.js';
import type {
  AxComponentClass,
  AxMutationAnnotation,
  AxMutationAnnotator,
  AxMutationDepth,
  AxMutationDepthHistogram,
  AxPatchClass,
  AxPatchType,
  axPatchClassOfType,
} from './mutationTaxonomy.js';

// The patch vocabulary is closed to what GEPA can actually produce. `tool.new`
// and the `middleware.*` family are unreachable on this codebase — GEPA
// replaces component strings and cannot add or edit an implementation — so
// shipping them would make the validator either always-throwing or vacuous.
// @ts-expect-error GEPA cannot add a tool
const _toolNew: AxPatchType = 'tool.new';
// @ts-expect-error GEPA cannot edit a tool implementation
const _toolImpl: AxPatchType = 'tool.implementation_fix';
// @ts-expect-error there is no middleware surface to patch
const _middleware: AxPatchType = 'middleware.insert';

type _patchTypesAreClosed = Expect<
  Equal<
    AxPatchType,
    | 'prompt.rule_add'
    | 'prompt.rule_modify'
    | 'tool.description_fix'
    | 'tool.name_fix'
    | 'program.source_replace'
  >
>;

// The class table is total over the union: every patch type has a derived
// class, so `class` can never be an unchecked assertion.
type _classTableIsExhaustive = Expect<
  Equal<keyof typeof axPatchClassOfType, AxPatchType>
>;
type _classTableValues = Expect<
  Equal<(typeof axPatchClassOfType)[AxPatchType], AxPatchClass>
>;

type _depthsAreClosed = Expect<
  Equal<
    AxMutationDepth,
    | 'schedule'
    | 'hyperparameter'
    | 'capacity'
    | 'objective'
    | 'supervision'
    | 'updateRule'
    | 'data'
  >
>;

// The histogram carries every depth plus the unannotated bucket, and nothing
// else: a reader must never meet a key with no definition.
type _histogramKeys = Expect<
  Equal<keyof AxMutationDepthHistogram, AxMutationDepth | 'unannotated'>
>;

declare const componentClass: AxComponentClass;
// @ts-expect-error the component-class vocabulary is closed
const _unknownClass: AxComponentClass = 'middleware';
const _knownClass: string = componentClass;

// An annotator may decline. `undefined` is a first-class outcome, not an error
// path, because "we do not know what kind of change this was" is a truthful
// answer that a required policy can then refuse to promote.
declare const annotator: AxMutationAnnotator;
type _annotatorMayDecline = Expect<
  Equal<ReturnType<typeof annotator>, AxMutationAnnotation | undefined>
>;

declare const declared: AxMutationAnnotation;
// @ts-expect-error a validated annotation is read-only
declared.depth = 'data';
// @ts-expect-error the touched-class list is read-only
declared.componentClasses.push('tools');

// Cost and effort are optional and may be explicitly absent: "unmeasured" and
// "zero" are different claims and the type must be able to say both.
const _absentCost: AxMutationAnnotation = {
  depth: 'supervision',
  patch: { class: 'steering', type: 'prompt.rule_modify' },
  componentClasses: ['context'],
};
const _measuredCost: AxMutationAnnotation = { ..._absentCost, costUsd: 0 };
// @ts-expect-error effort is a closed reasoning-effort vocabulary
const _badEffort: AxMutationAnnotation = { ..._absentCost, effort: 'extreme' };
