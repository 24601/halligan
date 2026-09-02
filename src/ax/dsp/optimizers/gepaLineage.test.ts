import { describe, expect, it } from 'vitest';
import {
  buildGEPACandidateComponentDelta,
  buildGEPACandidateFailure,
  buildGEPAReflectionOutcomes,
  cloneAndFreezeGEPACandidateLineageManifest,
  fingerprintGEPAValue,
  freezeGEPACandidateLineageManifest,
  resolveGEPALineageOptions,
} from './gepaLineage.js';

describe('GEPA candidate lineage payloads', () => {
  it('documents and applies exact retention clamp bounds', () => {
    expect(
      resolveGEPALineageOptions({
        maxRecords: 0,
        maxArtifactBytes: 1,
        maxComponentsPerCandidate: 0,
        maxComponentValueChars: 0,
        maxFailureMessageChars: 0,
      })
    ).toMatchObject({
      maxRecords: 1,
      maxArtifactBytes: 4096,
      maxComponentsPerCandidate: 1,
      maxComponentValueChars: 1,
      maxFailureMessageChars: 1,
    });
  });

  it('sorts, fingerprints, and bounds component deltas deterministically', () => {
    const options = resolveGEPALineageOptions({
      maxComponentsPerCandidate: 1,
    });
    const first = buildGEPACandidateComponentDelta(
      { b: 'before-b', a: 'before-a' },
      { b: 'after-b', a: 'after-a' },
      options
    );
    const second = buildGEPACandidateComponentDelta(
      { a: 'before-a', b: 'before-b' },
      { a: 'after-a', b: 'after-b' },
      options
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.delta).toEqual([
      {
        componentId: 'a',
        beforeFingerprint: fingerprintGEPAValue('before-a'),
        afterFingerprint: fingerprintGEPAValue('after-a'),
        afterLength: 7,
        afterValue: undefined,
        valueTruncated: undefined,
      },
    ]);
    expect(first.omittedComponentCount).toBe(1);
    expect(JSON.stringify(first)).not.toContain('after-a');
  });

  it('redacts values and failures by default and bounds explicit opt-in data', () => {
    const secret = 'secret-prompt-value';
    const redactedOptions = resolveGEPALineageOptions();
    const redactedDelta = buildGEPACandidateComponentDelta(
      undefined,
      { component: secret },
      redactedOptions
    );
    const redactedFailure = buildGEPACandidateFailure(
      'runtime',
      'token=super-secret',
      redactedOptions
    );
    expect(redactedFailure).toEqual({
      kind: 'runtime',
      messageFingerprint: fingerprintGEPAValue('token=super-secret'),
    });
    expect(JSON.stringify([redactedDelta, redactedFailure])).not.toContain(
      'secret'
    );

    const optedInOptions = resolveGEPALineageOptions({
      includeComponentValues: true,
      maxComponentValueChars: 6,
      includeFailureMessages: true,
      maxFailureMessageChars: 7,
    });
    const optedInDelta = buildGEPACandidateComponentDelta(
      undefined,
      { component: secret },
      optedInOptions
    );
    const optedInFailure = buildGEPACandidateFailure(
      'validator',
      'invalid secret',
      optedInOptions
    );
    expect(optedInDelta.delta[0]).toMatchObject({
      afterValue: 'secret',
      valueTruncated: true,
    });
    expect(optedInFailure).toMatchObject({
      messageFingerprint: fingerprintGEPAValue('invalid secret'),
      message: 'invalid',
      messageTruncated: true,
    });
  });

  it('uses a 64-bit SHA-256 identifier instead of FNV-1a/32', () => {
    const digest = fingerprintGEPAValue('secret-prompt-value');
    expect(digest.startsWith('sha256-64:')).toBe(true);
    expect(digest).toHaveLength('sha256-64:'.length + 16);
    expect(digest).not.toContain('fnv1a32');
    expect(fingerprintGEPAValue('secret-prompt-value')).toBe(digest);
    expect(fingerprintGEPAValue('secret-prompt-value!')).not.toBe(digest);
  });

  it('recursively freezes publications and clones serialized caller data', () => {
    const shallowFrozen = Object.freeze({
      records: [{ parentIds: [] }],
    }) as any;
    freezeGEPACandidateLineageManifest(shallowFrozen);
    expect(Object.isFrozen(shallowFrozen.records)).toBe(true);
    expect(Object.isFrozen(shallowFrozen.records[0].parentIds)).toBe(true);

    const callerData = { records: [{ id: 'c0', parentIds: [] }] } as any;
    const publication = cloneAndFreezeGEPACandidateLineageManifest(callerData);
    callerData.records[0].id = 'mutated';
    expect(publication.records[0]?.id).toBe('c0');
    expect(Object.isFrozen(publication.records[0])).toBe(true);
  });
});

describe('buildGEPAReflectionOutcomes', () => {
  const row = (index: number, scalar: number, admitted = true) => ({
    index,
    scalar,
    admitted,
  });
  const options = {
    successThreshold: 1,
    includeIndices: true,
    maxIndices: 20,
  };

  it('classifies each paired row into exactly one category', () => {
    const outcomes = buildGEPAReflectionOutcomes(
      [row(0, 0), row(1, 1), row(2, 0), row(3, 1)],
      [row(0, 1), row(1, 0), row(2, 0), row(3, 1)],
      options
    );
    expect(
      outcomes.map((outcome) => [outcome.category, outcome.count])
    ).toEqual([
      ['fixed', 1],
      ['regressed', 1],
      ['still_failing', 1],
      ['still_passing', 1],
    ]);
    expect(outcomes.map((outcome) => outcome.exampleIndices)).toEqual([
      [0],
      [1],
      [2],
      [3],
    ]);
  });

  it('pairs by feedback-set index, not by array position', () => {
    // Child rows arrive in a different order and with a different length.
    const outcomes = buildGEPAReflectionOutcomes(
      [row(7, 0), row(3, 1)],
      [row(3, 0), row(7, 1)],
      options
    );
    expect(
      outcomes
        .filter((outcome) => outcome.count > 0)
        .map((o) => [o.category, o.exampleIndices])
    ).toEqual([
      ['fixed', [7]],
      ['regressed', [3]],
    ]);
  });

  it('excludes a row either side discarded, so the counts sum to the paired admitted rows', () => {
    const outcomes = buildGEPAReflectionOutcomes(
      [row(0, 0), row(1, 0, false), row(2, 0)],
      [row(0, 1), row(1, 1), row(2, 1, false)],
      options
    );
    const total = outcomes.reduce((sum, outcome) => sum + outcome.count, 0);
    // Row 1 was discarded by the parent and row 2 by the child; only row 0 is
    // paired-and-admitted, so a classifier that ignored `admitted` would
    // report 3 here.
    expect(total).toBe(1);
    expect(
      outcomes.find((outcome) => outcome.category === 'fixed')?.exampleIndices
    ).toEqual([0]);
  });

  it('excludes a row the other side never evaluated', () => {
    const outcomes = buildGEPAReflectionOutcomes(
      [row(0, 0), row(9, 0)],
      [row(0, 1)],
      options
    );
    expect(outcomes.reduce((sum, outcome) => sum + outcome.count, 0)).toBe(1);
  });

  it('retains zero-count categories in a fixed order and clamps indices', () => {
    const outcomes = buildGEPAReflectionOutcomes(
      Array.from({ length: 5 }, (_, index) => row(index, 0)),
      Array.from({ length: 5 }, (_, index) => row(index, 1)),
      { successThreshold: 1, includeIndices: true, maxIndices: 2 }
    );
    expect(outcomes.map((outcome) => outcome.category)).toEqual([
      'fixed',
      'regressed',
      'still_failing',
      'still_passing',
    ]);
    expect(outcomes[0]?.count).toBe(5);
    // The count is the truth; the indices are a bounded sample of it.
    expect(outcomes[0]?.exampleIndices).toEqual([0, 1]);
    expect(outcomes[3]?.count).toBe(0);
  });

  it('omits indices entirely when they were not opted into', () => {
    const outcomes = buildGEPAReflectionOutcomes([row(0, 0)], [row(0, 1)], {
      successThreshold: 1,
      includeIndices: false,
      maxIndices: 20,
    });
    for (const outcome of outcomes) {
      expect(Object.hasOwn(outcome, 'exampleIndices')).toBe(false);
    }
  });

  it('treats the threshold as inclusive', () => {
    const outcomes = buildGEPAReflectionOutcomes([row(0, 0.5)], [row(0, 0.5)], {
      successThreshold: 0.5,
      includeIndices: false,
      maxIndices: 20,
    });
    expect(
      outcomes.find((outcome) => outcome.category === 'still_passing')?.count
    ).toBe(1);
  });
});
