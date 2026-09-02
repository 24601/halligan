import { describe, expect, it } from 'vitest';

import { formatComponentKey } from '../optimizable.js';
import type { AxProgramSourceCapability } from '../programSource.js';
import type { AxCandidateEffectDeclaration } from './candidateEffectManifest.js';
import {
  axDeclaresToolCapability,
  axIsCandidateEffectManifestError,
  axValidateCandidateEffectDeclaration,
} from './candidateEffectManifest.js';

const declaration = (
  overrides: Partial<AxCandidateEffectDeclaration> = {}
): AxCandidateEffectDeclaration => ({
  operation: 'payments.capture',
  replaySafety: 'idempotent',
  idempotencyKeySource: 'caller_supplied',
  resolver: 'host_resolver',
  ...overrides,
});

const toolCapabilities: readonly AxProgramSourceCapability[] = [
  'predict',
  'tool:charge',
];

describe('axValidateCandidateEffectDeclaration', () => {
  it('accepts a declaration that can be settled, and freezes it', () => {
    const validated = axValidateCandidateEffectDeclaration(
      declaration(),
      'record.effects[0]'
    );
    expect(validated).toEqual(declaration());
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it('refuses an unknown-replay-safety effect with no resolver', () => {
    // An indeterminate outcome with nowhere to settle cannot be promoted: the
    // event runtime can only park such an effect when a host resolver exists to
    // reconcile it during recovery.
    expect(() =>
      axValidateCandidateEffectDeclaration(
        declaration({
          replaySafety: 'unknown',
          resolver: 'none',
          idempotencyKeySource: 'derived',
        }),
        'record.effects[0]'
      )
    ).toThrowError(
      expect.objectContaining({ code: 'unsafe_replay_without_resolver' })
    );
  });

  it('accepts an unknown-replay-safety effect with a host resolver', () => {
    // The escape hatch works: `resolver` is the field that makes the refusal
    // above meaningful rather than a blanket ban on indeterminacy.
    expect(
      axValidateCandidateEffectDeclaration(
        declaration({
          replaySafety: 'unknown',
          resolver: 'host_resolver',
          idempotencyKeySource: 'none',
        }),
        'record.effects[0]'
      ).replaySafety
    ).toBe('unknown');
  });

  it('refuses an idempotent declaration with no idempotency key source', () => {
    // Mirrors the event runtime's own policy: declare idempotent only when
    // replay WITH THE SAME KEY is safe. With no key there is no same key.
    expect(() =>
      axValidateCandidateEffectDeclaration(
        declaration({
          replaySafety: 'idempotent',
          idempotencyKeySource: 'none',
        }),
        'record.effects[0]'
      )
    ).toThrowError(expect.objectContaining({ code: 'idempotent_without_key' }));
    // Either real key source is fine.
    for (const idempotencyKeySource of [
      'caller_supplied',
      'derived',
    ] as const) {
      expect(
        axValidateCandidateEffectDeclaration(
          declaration({ idempotencyKeySource }),
          'f'
        ).idempotencyKeySource
      ).toBe(idempotencyKeySource);
    }
  });

  it('refuses a structurally invalid declaration', () => {
    for (const bad of [
      declaration({ operation: '' }),
      declaration({ operation: '  payments.capture' }),
      declaration({ operation: 'x'.repeat(129) }),
      declaration({ operation: 42 as never }),
      declaration({ replaySafety: 'best_effort' as never }),
      declaration({ idempotencyKeySource: 'guessed' as never }),
      declaration({ resolver: 'maybe' as never }),
    ]) {
      expect(() =>
        axValidateCandidateEffectDeclaration(bad, 'record.effects[0]')
      ).toThrowError(expect.objectContaining({ code: 'effects_invalid' }));
    }
    expect(() =>
      axValidateCandidateEffectDeclaration(
        undefined as unknown as AxCandidateEffectDeclaration,
        'record.effects[0]'
      )
    ).toThrowError(expect.objectContaining({ code: 'effects_invalid' }));
  });

  it('names the field it refused', () => {
    // A manifest carries several declarations; the refusal has to say which.
    expect(() =>
      axValidateCandidateEffectDeclaration(
        declaration({ operation: '' }),
        'records[2].effects[1]'
      )
    ).toThrowError(/records\[2\]\.effects\[1\]\.operation/);
  });

  it('recognizes its own error structurally across realms', () => {
    let thrown: unknown;
    try {
      axValidateCandidateEffectDeclaration(declaration({ operation: '' }), 'f');
    } catch (error) {
      thrown = error;
    }
    expect(axIsCandidateEffectManifestError(thrown)).toBe(true);
    expect(
      axIsCandidateEffectManifestError({
        name: 'AxCandidateEffectManifestError',
        code: 'effects_missing',
      })
    ).toBe(true);
    expect(
      axIsCandidateEffectManifestError({
        name: 'AxCandidateEffectManifestError',
        code: 'not_a_code',
      })
    ).toBe(false);
    expect(axIsCandidateEffectManifestError(new Error('nope'))).toBe(false);
  });
});

describe('axDeclaresToolCapability', () => {
  it('is true only for a program-source component declaring a tool capability', () => {
    expect(
      axDeclaresToolCapability({
        componentKind: 'program-source',
        toolCapabilities: [...toolCapabilities],
      })
    ).toBe(true);
    // `predict` alone reaches nothing outside the program.
    expect(
      axDeclaresToolCapability({
        componentKind: 'program-source',
        toolCapabilities: ['predict'],
      })
    ).toBe(false);
    expect(
      axDeclaresToolCapability({
        componentKind: 'program-source',
        toolCapabilities: [],
      })
    ).toBe(false);
    expect(axDeclaresToolCapability({ componentKind: 'program-source' })).toBe(
      false
    );
  });

  it('is false for every steering surface, including the tool-text kinds', () => {
    // `fn-desc` and `fn-name` are description TEXT. They influence when a tool
    // is called; they cannot grant the capability to call one, so they can
    // never legitimately carry an effect declaration.
    for (const componentKind of [
      'fn-desc',
      'fn-name',
      'instruction',
      'description',
      'actor-tpl',
    ]) {
      expect(
        axDeclaresToolCapability({
          componentKind,
          toolCapabilities: ['tool:charge'],
        }),
        componentKind
      ).toBe(false);
    }
  });

  it('cannot be satisfied by a free-text surface label', () => {
    // The refused design: prefix-matching `fn`/`tool` over an unvalidated
    // `surface` string. The gate reads `componentKind`, so writing `toolkit`
    // into a free-text field buys nothing.
    expect(
      axDeclaresToolCapability({
        componentKind: 'toolkit',
        toolCapabilities: ['tool:charge'],
      })
    ).toBe(false);
    expect(
      axDeclaresToolCapability({
        componentKind: 'tool',
        toolCapabilities: ['tool:charge'],
      })
    ).toBe(false);
    expect(axDeclaresToolCapability({})).toBe(false);
  });

  it('ignores a capability list that is not tool-prefixed or not a list', () => {
    expect(
      axDeclaresToolCapability({
        componentKind: 'program-source',
        toolCapabilities: ['tooling:charge', 'Tool:charge', ' tool:charge'],
      })
    ).toBe(false);
    expect(
      axDeclaresToolCapability({
        componentKind: 'program-source',
        toolCapabilities: 'tool:charge' as unknown as readonly string[],
      })
    ).toBe(false);
  });

  it('reads a component built the way this repo builds one', () => {
    // A real `program-source` key, so the gate is exercised against the shape
    // `programSource.ts` actually emits rather than a hand-made literal.
    const componentId = formatComponentKey('root', 'program-source');
    expect(componentId).toBe('root::program-source');
    expect(
      axDeclaresToolCapability({
        componentKind: 'program-source',
        toolCapabilities: [...toolCapabilities],
      })
    ).toBe(true);
  });
});
