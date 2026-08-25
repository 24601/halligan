import { describe, expect, it } from 'vitest';
import {
  buildGEPACandidateComponentDelta,
  buildGEPACandidateFailure,
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
      message: 'invalid',
      messageTruncated: true,
    });
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
