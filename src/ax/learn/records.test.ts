import { describe, expect, it } from 'vitest';

import { axEventCanonicalJson } from '../event/util.js';

import {
  axCreateLearningInteractionRecord,
  axCreateLearningReportRecord,
  axLearningFailureFrom,
  axLearningReceiptFrom,
  axLearningRecordContent,
} from './records.js';
import type { AxLearningArtifactRef } from './types.js';
import { AxLearningRecordValidationError } from './types.js';

const NOW = 1_700_000_000_000;
const SCENARIO = 'support-triage';

const INSTALLED: AxLearningArtifactRef = {
  releaseId: 'rel-installed',
  contentId: 'sha256:aaaa',
  parentReleaseId: 'rel-parent',
  headContentId: 'sha256:bbbb',
  stale: true,
};

function interaction(override: Record<string, unknown> = {}) {
  return axCreateLearningInteractionRecord({
    id: 'rec-1',
    scenario: SCENARIO,
    createdAt: NOW,
    signature: 'question:string -> answer:string',
    programId: 'prog-1',
    input: { question: 'why' },
    output: { answer: 'because' },
    ...override,
  });
}

describe('axCreateLearningInteractionRecord', () => {
  it('stamps the artifactRef it was given, verbatim', () => {
    // The ref names what the agent was SERVING. The caller reads it off the
    // live installation, so the constructor must not normalize or invent it.
    const record = interaction({ artifactRef: INSTALLED });
    expect(record.artifactRef).toEqual(INSTALLED);
    expect(record.artifactRef?.stale).toBe(true);
  });

  it('omits artifactRef entirely when no tree is installed', () => {
    const record = interaction();
    expect(record.artifactRef).toBeUndefined();
    expect(Object.hasOwn(record, 'artifactRef')).toBe(false);
  });

  it('carries a failure without an output and never a stack', () => {
    const boom = new TypeError('provider exploded');
    const record = interaction({ output: undefined, failure: boom });
    expect(record.payload.failure).toEqual({
      name: 'TypeError',
      message: 'provider exploded',
    });
    expect(Object.hasOwn(record.payload, 'output')).toBe(false);
    expect(JSON.stringify(record)).not.toContain('stack');
    expect(JSON.stringify(record)).not.toContain('records.test.ts');
  });

  it('refuses a record that claims both an output and a failure', () => {
    expect(() => interaction({ failure: new Error('x') })).toThrow(
      AxLearningRecordValidationError
    );
    // Neither is not an observation of anything either.
    expect(() => interaction({ output: undefined })).toThrow(
      /either output or failure/
    );
  });

  it('withholds model, usage and tags unless supplied', () => {
    const bare = interaction();
    expect(Object.keys(bare.payload).sort()).toEqual([
      'input',
      'output',
      'programId',
      'signature',
    ]);
    const rich = interaction({
      model: 'gpt-5.6',
      usage: { promptTokens: 10, totalTokens: 12 },
      tags: { tenant: 'acme' },
    });
    expect(rich.payload.model).toBe('gpt-5.6');
    expect(rich.payload.usage).toEqual({ promptTokens: 10, totalTokens: 12 });
    expect(rich.payload.tags).toEqual({ tenant: 'acme' });
  });

  it('rejects a Date, a Map and a cyclic object with the JSON path', () => {
    // axEventCanonicalJson would silently coerce all three; a record has to
    // fail loudly at construction instead.
    expect(() => interaction({ output: { at: new Date(0) } })).toThrow(
      /payload\.output\.at/
    );
    expect(() => interaction({ input: { m: new Map() } })).toThrow(
      /payload\.input\.m/
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let caught: unknown;
    try {
      interaction({ output: cyclic });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxLearningRecordValidationError);
    expect((caught as AxLearningRecordValidationError).path).toBe(
      'payload.output'
    );
    expect((caught as AxLearningRecordValidationError).code).toBe(
      'learning_record_invalid'
    );
  });

  it('rejects a non-finite usage count and an empty identity', () => {
    expect(() => interaction({ usage: { totalTokens: Number.NaN } })).toThrow(
      /payload\.usage\.totalTokens/
    );
    expect(() => interaction({ id: '' })).toThrow(/id must be a non-empty/);
    expect(() => interaction({ scenario: '  ' })).toThrow(/scenario/);
    expect(() => interaction({ createdAt: Number.POSITIVE_INFINITY })).toThrow(
      /createdAt/
    );
  });

  it('rejects an artifactRef missing its content identity', () => {
    expect(() =>
      interaction({
        artifactRef: { releaseId: 'rel-1', contentId: '', stale: false },
      })
    ).toThrow(/artifactRef\.contentId/);
  });
});

describe('axCreateLearningReportRecord', () => {
  function report(input: Record<string, unknown>) {
    return axCreateLearningReportRecord({
      id: 'report-1',
      scenario: SCENARIO,
      createdAt: NOW,
      input: input as never,
    });
  }

  it('drops unknown top-level report keys', () => {
    // Method data belongs under feedback/metadata where a processor finds it.
    const record = report({
      references: ['rec-1'],
      score: 1,
      rubric: 'strict',
      evaluatorId: 'human-42',
    });
    expect(Object.keys(record.payload)).toEqual(['score']);
    expect(JSON.stringify(record)).not.toContain('rubric');
    expect(JSON.stringify(record)).not.toContain('human-42');
  });

  it('rejects a boolean score at construction', () => {
    // reef's rule, kept: a bool is not a score, and accepting one would
    // silently rank `true` above `false`.
    expect(() => report({ references: ['rec-1'], score: true })).toThrow(
      /a boolean is not a score/
    );
  });

  it('rejects a non-finite score and a non-array references field', () => {
    expect(() => report({ references: ['rec-1'], score: Number.NaN })).toThrow(
      /score must be a finite number/
    );
    expect(() => report({ references: 'rec-1' })).toThrow(
      /references must be an array/
    );
    expect(() => report({ references: [''] })).toThrow(/references\[0\]/);
  });

  it('keeps an empty reference list so the reducer can name the reason', () => {
    // `no-references` is a counted never-reason, so the record must be
    // constructible; refusing it here would hide the malformed feedback.
    const record = report({ references: [], score: 1 });
    expect(record.references).toEqual([]);
  });

  it('rejects non-persistable feedback and metadata', () => {
    expect(() =>
      report({ references: ['rec-1'], feedback: { when: new Date(0) } })
    ).toThrow(/payload\.feedback\.when/);
    expect(() =>
      report({ references: ['rec-1'], metadata: { n: Number.NaN } })
    ).toThrow(/payload\.metadata\.n/);
  });
});

describe('axLearningRecordContent', () => {
  it('excludes createdAt so a retried append is not a conflict', () => {
    const early = interaction({ createdAt: NOW });
    const late = interaction({ createdAt: NOW + 5_000 });
    expect(axLearningRecordContent(early)).toBe(axLearningRecordContent(late));
    expect(axLearningRecordContent(early)).not.toContain('createdAt');
  });

  it('separates records that differ anywhere else', () => {
    const base = interaction();
    const other = interaction({ output: { answer: 'different' } });
    expect(axLearningRecordContent(base)).not.toBe(
      axLearningRecordContent(other)
    );
  });

  it('is key-order independent', () => {
    const a = axCreateLearningReportRecord({
      id: 'r',
      scenario: SCENARIO,
      createdAt: NOW,
      input: { references: ['rec-1'], score: 1, metadata: { a: 1, b: 2 } },
    });
    const b = axCreateLearningReportRecord({
      id: 'r',
      scenario: SCENARIO,
      createdAt: NOW + 1,
      input: { references: ['rec-1'], metadata: { b: 2, a: 1 }, score: 1 },
    });
    expect(axLearningRecordContent(a)).toBe(axLearningRecordContent(b));
    expect(axLearningRecordContent(a)).toBe(
      axEventCanonicalJson({
        id: 'r',
        kind: 'report',
        payload: { metadata: { a: 1, b: 2 }, score: 1 },
        references: ['rec-1'],
        scenario: SCENARIO,
      })
    );
  });
});

describe('axLearningReceiptFrom', () => {
  it('reports duplicate only for a deduped append', () => {
    const record = interaction({ artifactRef: INSTALLED });
    const inserted = axLearningReceiptFrom(
      { record, inserted: true, sequence: 1 },
      'volatile'
    );
    expect(inserted).toEqual({
      recordId: 'rec-1',
      scenario: SCENARIO,
      artifactRef: INSTALLED,
      recordedAt: NOW,
      durability: 'volatile',
      duplicate: false,
    });

    const deduped = axLearningReceiptFrom(
      { record, inserted: false, reason: 'duplicate' },
      'persistent'
    );
    expect(deduped.duplicate).toBe(true);
    expect(deduped.durability).toBe('persistent');
  });

  it('does not claim duplicate for an accepted-and-ignored report', () => {
    const record = axCreateLearningReportRecord({
      id: 'report-1',
      scenario: SCENARIO,
      createdAt: NOW,
      input: { references: ['rec-1'], score: 0 },
    });
    const receipt = axLearningReceiptFrom(
      { record, inserted: false, reason: 'references-consumed' },
      'volatile'
    );
    expect(receipt.duplicate).toBe(false);
    expect(receipt.artifactRef).toBeUndefined();
  });
});

describe('axLearningFailureFrom', () => {
  it('normalizes a non-Error throw without inventing a name', () => {
    expect(axLearningFailureFrom('nope')).toEqual({
      name: 'Error',
      message: 'nope',
    });
    const named = new RangeError('out of range');
    expect(axLearningFailureFrom(named)).toEqual({
      name: 'RangeError',
      message: 'out of range',
    });
  });
});

describe('artifactRef staleness', () => {
  it('refuses an artifactRef whose stale flag contradicts the observed head', () => {
    expect(() =>
      interaction({
        artifactRef: {
          releaseId: 'rel-1',
          contentId: 'sha256:aaaa',
          headContentId: 'sha256:bbbb',
          stale: false,
        },
      })
    ).toThrow(/stale must be true/);
    expect(() =>
      interaction({
        artifactRef: {
          releaseId: 'rel-1',
          contentId: 'sha256:aaaa',
          headContentId: 'sha256:aaaa',
          stale: true,
        },
      })
    ).toThrow(/stale must be false/);
  });

  it('accepts a ref whose stale flag matches, and one with no observed head', () => {
    expect(
      interaction({
        artifactRef: {
          releaseId: 'rel-1',
          contentId: 'sha256:aaaa',
          headContentId: 'sha256:aaaa',
          stale: false,
        },
      }).artifactRef?.stale
    ).toBe(false);
    // No head observed: nothing to derive from, so the producer's claim stands.
    expect(
      interaction({
        artifactRef: {
          releaseId: 'rel-1',
          contentId: 'sha256:aaaa',
          stale: false,
        },
      }).artifactRef?.headContentId
    ).toBeUndefined();
  });

  it('refuses an empty observed head', () => {
    expect(() =>
      interaction({
        artifactRef: {
          releaseId: 'rel-1',
          contentId: 'sha256:aaaa',
          headContentId: '   ',
          stale: true,
        },
      })
    ).toThrow(/artifactRef\.headContentId/);
  });
});
