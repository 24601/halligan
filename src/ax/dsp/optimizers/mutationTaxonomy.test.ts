import { describe, expect, it } from 'vitest';

import { formatComponentKey } from '../optimizable.js';
import type {
  AxMutationAnnotation,
  AxMutationKindPolicy,
  AxMutationSurface,
} from './mutationTaxonomy.js';
import {
  axBuildMutationDepthHistogram,
  axDefaultMutationAnnotator,
  axInferComponentClass,
  axIsMutationTaxonomyError,
  axKnownComponentKinds,
  axPatchClassOfType,
  axValidateMutationAnnotation,
} from './mutationTaxonomy.js';

const surface = (kind: string, subKey?: string): AxMutationSurface => ({
  componentId: formatComponentKey('root', kind, subKey),
  kind,
});

const annotation = (
  overrides: Partial<AxMutationAnnotation> = {}
): AxMutationAnnotation => ({
  depth: 'supervision',
  patch: { class: 'steering', type: 'prompt.rule_modify' },
  componentClasses: ['context'],
  ...overrides,
});

describe('axPatchClassOfType', () => {
  it('maps every patch type and nothing else', () => {
    // The class is DERIVED from the type. If this table and the union ever
    // disagree, a host can declare `steering` on an executable code patch.
    expect(axPatchClassOfType).toEqual({
      'prompt.rule_add': 'steering',
      'prompt.rule_modify': 'steering',
      'tool.description_fix': 'steering',
      'tool.name_fix': 'steering',
      'program.source_replace': 'capability',
    });
    // Exactly one patch type is executable on today's codebase; the capability
    // gate and the program-source gate therefore coincide, which is the honest
    // state of affairs rather than an accident.
    expect(
      Object.entries(axPatchClassOfType).filter(
        ([, value]) => value === 'capability'
      )
    ).toEqual([['program.source_replace', 'capability']]);
  });
});

describe('axInferComponentClass', () => {
  it('maps every kind this repo actually emits', () => {
    // Keys in the shape the emitters produce: `program.ts` for
    // instruction/description, `generate.ts` for the two tool-text kinds,
    // `synthesizer.ts` for actor-tpl, `programSource.ts` for program-source.
    expect(axInferComponentClass('root::instruction')).toBe('context');
    expect(axInferComponentClass('root::description')).toBe('context');
    expect(axInferComponentClass('root::fn:lookup:desc')).toBe('tools');
    expect(axInferComponentClass('root::fn:lookup:name')).toBe('tools');
    expect(axInferComponentClass('root::actor-tpl:rlm/responder.md')).toBe(
      'orchestration'
    );
    expect(axInferComponentClass('root::program-source')).toBe('runtime');
    // ...and in the `formatComponentKey` shape, where the kind is the whole
    // segment.
    for (const [kind, expected] of Object.entries(axKnownComponentKinds)) {
      expect(axInferComponentClass(formatComponentKey('root', kind))).toBe(
        expected
      );
    }
  });

  it('throws on a malformed key rather than guessing a class', () => {
    for (const key of ['instruction', '', '::instruction', 'root::']) {
      expect(() => axInferComponentClass(key)).toThrowError(
        expect.objectContaining({ code: 'unknown_component_kind' })
      );
    }
  });

  it('refuses a tool key whose trailing segment is not desc or name', () => {
    // `fn` alone cannot distinguish a tool description from a tool name, and
    // the two have different allowed patch types. Guessing is exactly what the
    // fail-closed rule forbids.
    expect(() => axInferComponentClass('root::fn:lookup')).toThrowError(
      expect.objectContaining({ code: 'unknown_component_kind' })
    );
    expect(() => axInferComponentClass('root::fn:lookup:schema')).toThrowError(
      expect.objectContaining({ code: 'unknown_component_kind' })
    );
  });

  it('throws on an unmapped component kind with no host policy', () => {
    // The validator is never a no-op. This is the test that fails for any
    // design that pattern-matches a prefix and silently accepts the rest.
    expect(() => axInferComponentClass('root::retriever-config')).toThrowError(
      expect.objectContaining({
        code: 'unknown_component_kind',
        componentKind: 'retriever-config',
      })
    );
  });

  it('accepts a host-defined kind only through an explicit hostKinds policy', () => {
    const hostKinds: Record<string, AxMutationKindPolicy> = {
      'retriever-config': {
        componentClass: 'runtime',
        allowedPatchTypes: ['prompt.rule_modify'],
      },
    };
    expect(axInferComponentClass('root::retriever-config', hostKinds)).toBe(
      'runtime'
    );
    expect(() => axInferComponentClass('root::retriever-config')).toThrow();
  });
});

describe('axValidateMutationAnnotation', () => {
  it('derives patch class from patch type and rejects a contradicting declaration', () => {
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          depth: 'updateRule',
          patch: { class: 'steering', type: 'program.source_replace' },
          componentClasses: ['runtime'],
        }),
        [surface('program-source')]
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'patch_class_mismatch',
        patchType: 'program.source_replace',
      })
    );
    // The reverse is refused too: a text patch cannot be declared executable.
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          patch: { class: 'capability', type: 'prompt.rule_modify' },
        }),
        [surface('instruction')]
      )
    ).toThrowError(expect.objectContaining({ code: 'patch_class_mismatch' }));
  });

  it('rejects a depth or effort outside the closed vocabulary', () => {
    // `depth` is the one field Ax cannot re-derive from the surfaces, so an
    // unchecked value validates and then lands silently in the histogram's
    // `unannotated` bucket — the candidate is promoted while its annotation
    // says nothing. `effort` is host-asserted for the same reason.
    expect(() =>
      axValidateMutationAnnotation(annotation({ depth: 'vibes' as never }), [
        surface('instruction'),
      ])
    ).toThrowError(
      expect.objectContaining({
        name: 'AxMutationTaxonomyError',
        code: 'unknown_depth',
      })
    );
    expect(() =>
      axValidateMutationAnnotation(annotation({ effort: 'extreme' as never }), [
        surface('instruction'),
      ])
    ).toThrowError(
      expect.objectContaining({
        name: 'AxMutationTaxonomyError',
        code: 'unknown_effort',
      })
    );
    // An absent effort is still legal: unknown is not the same claim as wrong.
    expect(
      axValidateMutationAnnotation(annotation({ effort: undefined }), [
        surface('instruction'),
      ]).effort
    ).toBeUndefined();
    expect(
      axValidateMutationAnnotation(annotation({ effort: 'high' }), [
        surface('instruction'),
      ]).effort
    ).toBe('high');
  });

  it('rejects a patch type GEPA cannot produce', () => {
    // `tool.new`, `tool.implementation_fix` and every `middleware.*` value are
    // deliberately absent from the union: GEPA replaces component STRINGS.
    for (const type of [
      'tool.new',
      'tool.argument_modify',
      'tool.implementation_fix',
      'middleware.insert',
    ]) {
      expect(() =>
        axValidateMutationAnnotation(
          annotation({
            patch: { class: 'capability', type: type as never },
            componentClasses: ['tools'],
          }),
          [surface('fn-desc')]
        )
      ).toThrowError(expect.objectContaining({ code: 'patch_class_mismatch' }));
    }
  });

  it('rejects a program.source_replace touching a non-source kind', () => {
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          depth: 'updateRule',
          patch: { class: 'capability', type: 'program.source_replace' },
          componentClasses: ['context'],
        }),
        [surface('instruction')]
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'surface_incompatible',
        componentKind: 'instruction',
      })
    );
  });

  it('rejects a prompt.rule_add touching an fn-desc kind', () => {
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          patch: { class: 'steering', type: 'prompt.rule_add' },
          componentClasses: ['tools'],
        }),
        [surface('fn-desc')]
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'surface_incompatible',
        componentKind: 'fn-desc',
      })
    );
  });

  it('rejects tool.description_fix on an fn-name kind and vice versa', () => {
    // The two tool-text kinds are distinguished, not conflated: renaming a tool
    // changes how the model addresses it, which is not the same edit as
    // rewriting when to call it.
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          patch: { class: 'steering', type: 'tool.description_fix' },
          componentClasses: ['tools'],
        }),
        [surface('fn-name')]
      )
    ).toThrowError(expect.objectContaining({ code: 'surface_incompatible' }));
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          patch: { class: 'steering', type: 'tool.name_fix' },
          componentClasses: ['tools'],
        }),
        [surface('fn-desc')]
      )
    ).toThrowError(expect.objectContaining({ code: 'surface_incompatible' }));
  });

  it('accepts each patch type on a kind it may legitimately touch', () => {
    const cases: ReadonlyArray<
      readonly [AxMutationAnnotation['patch']['type'], string, string]
    > = [
      ['prompt.rule_add', 'instruction', 'context'],
      ['prompt.rule_modify', 'description', 'context'],
      ['prompt.rule_modify', 'actor-tpl', 'orchestration'],
      ['tool.description_fix', 'fn-desc', 'tools'],
      ['tool.name_fix', 'fn-name', 'tools'],
      ['program.source_replace', 'program-source', 'runtime'],
    ];
    for (const [type, kind, componentClass] of cases) {
      const validated = axValidateMutationAnnotation(
        annotation({
          depth:
            type === 'program.source_replace' ? 'updateRule' : 'supervision',
          patch: { class: axPatchClassOfType[type], type },
          componentClasses: [componentClass as never],
        }),
        [surface(kind)]
      );
      expect(validated.patch).toEqual({
        class: axPatchClassOfType[type],
        type,
      });
      expect(validated.componentClasses).toEqual([componentClass]);
    }
  });

  it('throws on an unmapped component kind with no host policy', () => {
    expect(() =>
      axValidateMutationAnnotation(annotation(), [
        { componentId: 'root::retriever-config', kind: 'retriever-config' },
      ])
    ).toThrowError(
      expect.objectContaining({
        code: 'unknown_component_kind',
        componentKind: 'retriever-config',
      })
    );
  });

  it('accepts a host kind only when its policy names the patch type', () => {
    const hostKinds: Record<string, AxMutationKindPolicy> = {
      'retriever-config': {
        componentClass: 'runtime',
        allowedPatchTypes: ['prompt.rule_modify'],
      },
    };
    const touched: AxMutationSurface = {
      componentId: 'root::retriever-config',
      kind: 'retriever-config',
    };
    expect(
      axValidateMutationAnnotation(
        annotation({ componentClasses: ['runtime'] }),
        [touched],
        hostKinds
      ).componentClasses
    ).toEqual(['runtime']);
    // Declared kind, undeclared patch type: still refused.
    expect(() =>
      axValidateMutationAnnotation(
        annotation({
          patch: { class: 'steering', type: 'prompt.rule_add' },
          componentClasses: ['runtime'],
        }),
        [touched],
        hostKinds
      )
    ).toThrowError(expect.objectContaining({ code: 'surface_incompatible' }));
  });

  it('refuses an annotation that names no surface', () => {
    expect(() => axValidateMutationAnnotation(annotation(), [])).toThrowError(
      expect.objectContaining({ code: 'surface_incompatible' })
    );
  });

  it('requires the declared component classes to match the classes touched', () => {
    // Claiming a class you did not touch, or omitting one you did, are both
    // false records.
    expect(() =>
      axValidateMutationAnnotation(
        annotation({ componentClasses: ['context', 'evaluation'] }),
        [surface('instruction')]
      )
    ).toThrowError(
      expect.objectContaining({ code: 'empty_component_classes' })
    );
    expect(() =>
      axValidateMutationAnnotation(
        annotation({ componentClasses: ['context'] }),
        [surface('instruction'), surface('actor-tpl')]
      )
    ).toThrowError(
      expect.objectContaining({ code: 'empty_component_classes' })
    );
    expect(() =>
      axValidateMutationAnnotation(annotation({ componentClasses: [] }), [
        surface('instruction'),
      ])
    ).toThrowError(
      expect.objectContaining({ code: 'empty_component_classes' })
    );
  });

  it('normalizes the component classes it returns', () => {
    const validated = axValidateMutationAnnotation(
      annotation({
        componentClasses: ['orchestration', 'context', 'context'],
      }),
      [surface('actor-tpl'), surface('instruction'), surface('description')]
    );
    expect(validated.componentClasses).toEqual(['context', 'orchestration']);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.componentClasses)).toBe(true);
  });

  it('ignores an advisory surface component class', () => {
    // `AxMutationSurface.componentClass` is a carried label. If the validator
    // read it, a mislabelled surface would widen what a patch type may touch.
    const validated = axValidateMutationAnnotation(
      annotation({ componentClasses: ['context'] }),
      [{ ...surface('instruction'), componentClass: 'evaluation' }]
    );
    expect(validated.componentClasses).toEqual(['context']);
  });

  it('records an unknown cost as undefined rather than zero', () => {
    const unknownCost = axValidateMutationAnnotation(annotation(), [
      surface('instruction'),
    ]);
    expect('costUsd' in unknownCost).toBe(false);
    const measured = axValidateMutationAnnotation(
      annotation({ costUsd: 0.0143 }),
      [surface('instruction')]
    );
    expect(measured.costUsd).toBe(0.0143);
    // Zero is a measurement, not a placeholder, and must round-trip as one.
    expect(
      axValidateMutationAnnotation(annotation({ costUsd: 0 }), [
        surface('instruction'),
      ]).costUsd
    ).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        axValidateMutationAnnotation(annotation({ costUsd: bad }), [
          surface('instruction'),
        ])
      ).toThrowError(expect.objectContaining({ code: 'negative_cost' }));
    }
  });

  it('distinguishes an unknown effort from a declared effort', () => {
    expect(
      'effort' in
        axValidateMutationAnnotation(annotation(), [surface('instruction')])
    ).toBe(false);
    expect(
      axValidateMutationAnnotation(annotation({ effort: 'medium' }), [
        surface('instruction'),
      ]).effort
    ).toBe('medium');
  });

  it('recognizes its own error structurally across realms', () => {
    let thrown: unknown;
    try {
      axValidateMutationAnnotation(annotation(), []);
    } catch (error) {
      thrown = error;
    }
    expect(axIsMutationTaxonomyError(thrown)).toBe(true);
    expect(
      axIsMutationTaxonomyError({
        name: 'AxMutationTaxonomyError',
        code: 'negative_cost',
      })
    ).toBe(true);
    expect(
      axIsMutationTaxonomyError({
        name: 'AxMutationTaxonomyError',
        code: 'not_a_real_code',
      })
    ).toBe(false);
    expect(axIsMutationTaxonomyError(new Error('nope'))).toBe(false);
  });
});

describe('axDefaultMutationAnnotator', () => {
  const call = (componentKinds: readonly string[]) =>
    axDefaultMutationAnnotator({
      componentIds: componentKinds.map((kind) =>
        formatComponentKey('root', kind)
      ),
      componentKinds,
      strategy: 'reflective_mutation',
      round: 1,
    });

  it('labels text kinds supervision and program-source updateRule', () => {
    expect(call(['instruction'])).toEqual({
      depth: 'supervision',
      patch: { class: 'steering', type: 'prompt.rule_modify' },
      componentClasses: ['context'],
    });
    expect(call(['program-source'])).toEqual({
      depth: 'updateRule',
      patch: { class: 'capability', type: 'program.source_replace' },
      componentClasses: ['runtime'],
    });
    expect(call(['fn-desc'])?.patch.type).toBe('tool.description_fix');
    expect(call(['fn-name'])?.patch.type).toBe('tool.name_fix');
  });

  it('produces an annotation its own validator accepts', () => {
    // A default that cannot pass validation would make `policy: 'required'`
    // unusable without a host annotator.
    for (const kind of Object.keys(axKnownComponentKinds)) {
      const produced = call([kind]);
      expect(produced).toBeDefined();
      expect(() =>
        axValidateMutationAnnotation(produced!, [surface(kind)])
      ).not.toThrow();
    }
  });

  it('leaves a mixed-family group unannotated rather than mislabelling it', () => {
    // One annotation carries one patch type. Inventing one that spans a prompt
    // edit and a tool rename would be a false claim, and `undefined` is the
    // honest outcome the `required` policy then refuses to promote.
    expect(call(['instruction', 'fn-desc'])).toBeUndefined();
    expect(call(['fn-desc', 'fn-name'])).toBeUndefined();
    expect(call(['instruction', 'program-source'])).toBeUndefined();
    // Same family, several components: one honest annotation covers them.
    expect(call(['instruction', 'description', 'actor-tpl'])).toEqual({
      depth: 'supervision',
      patch: { class: 'steering', type: 'prompt.rule_modify' },
      componentClasses: ['context', 'orchestration'],
    });
  });

  it('leaves an unknown kind and an empty group unannotated', () => {
    expect(call(['retriever-config'])).toBeUndefined();
    expect(call([])).toBeUndefined();
  });

  it('never estimates effort or cost', () => {
    const produced = call(['instruction'])!;
    expect('effort' in produced).toBe(false);
    expect('costUsd' in produced).toBe(false);
  });
});

describe('axBuildMutationDepthHistogram', () => {
  it('counts unannotated candidates in their own bucket', () => {
    const histogram = axBuildMutationDepthHistogram([
      annotation(),
      annotation(),
      annotation({ depth: 'updateRule' }),
      annotation({ depth: 'data' }),
      undefined,
      undefined,
      undefined,
    ]);
    expect(histogram).toEqual({
      schedule: 0,
      hyperparameter: 0,
      capacity: 0,
      objective: 0,
      supervision: 2,
      updateRule: 1,
      data: 1,
      unannotated: 3,
    });
    const total = Object.values(histogram).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(7);
  });

  it('keeps histogram keys in a stable order', () => {
    // Two runs that annotated the same candidates in a different order must
    // produce byte-identical histograms, or the artifact changes for no reason.
    const a = axBuildMutationDepthHistogram([
      annotation({ depth: 'data' }),
      undefined,
      annotation({ depth: 'schedule' }),
    ]);
    const b = axBuildMutationDepthHistogram([
      annotation({ depth: 'schedule' }),
      annotation({ depth: 'data' }),
      undefined,
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual([
      'schedule',
      'hyperparameter',
      'capacity',
      'objective',
      'supervision',
      'updateRule',
      'data',
      'unannotated',
    ]);
  });

  it('counts an annotation carrying an unrecognized depth as unannotated', () => {
    // A histogram must never grow a key a reader has no definition for.
    const histogram = axBuildMutationDepthHistogram([
      { ...annotation(), depth: 'vibes' as never },
    ]);
    expect(histogram.unannotated).toBe(1);
    expect(Object.keys(histogram)).toHaveLength(8);
  });

  it('returns an all-zero histogram for an empty run', () => {
    const histogram = axBuildMutationDepthHistogram([]);
    expect(Object.values(histogram).reduce((sum, n) => sum + n, 0)).toBe(0);
  });
});
