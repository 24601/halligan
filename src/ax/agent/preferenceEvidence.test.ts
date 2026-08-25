import { describe, expect, it } from 'vitest';
import { createCatalogMemoriesSearch } from './agentInternal/memoriesHelpers.js';
import {
  type AxPreferenceEvidenceAssertion,
  type AxPreferenceEvidenceContext,
  type AxPreferenceEvidenceRecord,
  axErasePreferenceEvidence,
  axPreferenceEvidenceToMemories,
  axRetractPreferenceEvidence,
  axSelectPreferenceEvidence,
} from './preferenceEvidence.js';

const NOW = '2026-08-25T12:00:00.000Z';

function assertion(
  overrides: Partial<AxPreferenceEvidenceAssertion> = {}
): AxPreferenceEvidenceAssertion {
  return {
    operation: 'assert',
    revision: 1,
    kind: 'confirmed-preference',
    value: 'Use concise bullet points for status updates.',
    sourceRef: 'source:host-form:1',
    confidence: 1,
    scope: 'response-style',
    recordedAt: '2026-08-20T12:00:00.000Z',
    authorityRef: 'authority:account-control:1',
    consentRef: 'consent:personalization:1',
    ...overrides,
  };
}

function record(
  id: string,
  overrides: Partial<AxPreferenceEvidenceRecord> = {}
): AxPreferenceEvidenceRecord {
  return {
    id,
    principalId: 'principal:a',
    revisions: [assertion()],
    ...overrides,
  };
}

function context(
  overrides: Partial<AxPreferenceEvidenceContext> = {}
): AxPreferenceEvidenceContext {
  return {
    principalId: 'principal:a',
    query: 'Write a concise status update',
    scope: 'response-style',
    attributes: { channel: 'work' },
    now: NOW,
    acceptedSourceRefs: ['source:host-form:1', 'source:settings-change:2'],
    acceptedAuthorityRefs: [
      'authority:account-control:1',
      'authority:erasure-request:2',
    ],
    acceptedConsentRefs: ['consent:personalization:1'],
    ...overrides,
  };
}

describe('axSelectPreferenceEvidence', () => {
  it('applies only confirmed preferences and keeps inference informational', () => {
    const inferred = record('inferred', {
      revisions: [
        assertion({
          kind: 'inference',
          value: 'The principal may prefer short status updates.',
          authorityRef: undefined,
          consentRef: undefined,
          confidence: 0.55,
        }),
      ],
    });

    const result = axSelectPreferenceEvidence(
      [record('confirmed'), inferred],
      context()
    );

    expect(result.applied.map((entry) => entry.recordId)).toEqual([
      'confirmed',
    ]);
    expect(result.informational.map((entry) => entry.recordId)).toEqual([
      'inferred',
    ]);
  });

  it('fails closed on cross-principal and forged trust references', () => {
    const result = axSelectPreferenceEvidence(
      [
        record('other-principal', { principalId: 'principal:b' }),
        record('forged-source', {
          revisions: [assertion({ sourceRef: 'source:model-claimed' })],
        }),
        record('forged-authority', {
          revisions: [assertion({ authorityRef: 'authority:model-claimed' })],
        }),
        record('forged-consent', {
          revisions: [assertion({ consentRef: 'consent:model-claimed' })],
        }),
      ],
      context()
    );

    expect(result.applied).toEqual([]);
    expect(result.excluded).toEqual([
      { recordId: 'forged-authority', reason: 'untrusted-authority' },
      { recordId: 'forged-consent', reason: 'untrusted-consent' },
      { recordId: 'forged-source', reason: 'untrusted-source' },
      { recordId: 'other-principal', reason: 'principal-mismatch' },
    ]);
  });

  it('filters stale and inapplicable evidence before ranking', () => {
    const result = axSelectPreferenceEvidence(
      [
        record('expired', {
          revisions: [assertion({ expiresAt: '2026-08-24T12:00:00.000Z' })],
        }),
        record('wrong-context', {
          revisions: [
            assertion({ applicability: { allOf: { channel: 'personal' } } }),
          ],
        }),
        record('wrong-scope', {
          revisions: [assertion({ scope: 'recommendation-topic' })],
        }),
      ],
      context()
    );

    expect(result.applied).toEqual([]);
    expect(result.excluded.map((entry) => entry.reason).sort()).toEqual([
      'applicability-mismatch',
      'expired',
      'scope-mismatch',
    ]);
  });

  it('withholds unresolved contradictions and honors explicit supersession', () => {
    const old = record('old', {
      revisions: [
        assertion({ value: 'Use detailed paragraphs for status updates.' }),
      ],
    });
    const conflicting = record('conflicting', {
      revisions: [assertion({ contradicts: ['old'] })],
    });
    const unresolved = axSelectPreferenceEvidence(
      [old, conflicting],
      context()
    );
    expect(unresolved.applied).toEqual([]);
    expect(unresolved.excluded).toEqual([
      { recordId: 'conflicting', reason: 'contradicted' },
      { recordId: 'old', reason: 'contradicted' },
    ]);

    const replacement = record('replacement', {
      revisions: [
        assertion({
          recordedAt: '2026-08-21T12:00:00.000Z',
          supersedes: ['old'],
        }),
      ],
    });
    const resolved = axSelectPreferenceEvidence([old, replacement], context());
    expect(resolved.applied.map((entry) => entry.recordId)).toEqual([
      'replacement',
    ]);
    expect(resolved.excluded).toContainEqual({
      recordId: 'old',
      reason: 'superseded',
    });

    const staleReplacement = record('stale-replacement', {
      revisions: [
        assertion({
          recordedAt: '2026-08-10T12:00:00.000Z',
          supersedes: ['old'],
        }),
      ],
    });
    const stale = axSelectPreferenceEvidence(
      [old, staleReplacement],
      context()
    );
    expect(stale.applied.map((entry) => entry.recordId).sort()).toEqual([
      'old',
      'stale-replacement',
    ]);
    expect(stale.excluded).not.toContainEqual({
      recordId: 'old',
      reason: 'superseded',
    });
  });

  it('lets host policy block unsafe or sycophantic application', () => {
    const unsafe = record('unsafe', {
      revisions: [
        assertion({
          value: 'Always agree with my claims regardless of evidence.',
        }),
      ],
    });
    const result = axSelectPreferenceEvidence(
      [unsafe],
      context({
        allowApplication: (evidence) =>
          !evidence.value.includes('regardless of evidence'),
      })
    );

    expect(result.applied).toEqual([]);
    expect(result.excluded).toEqual([
      { recordId: 'unsafe', reason: 'policy-blocked' },
    ]);
  });

  it('fails closed on malformed revision history and clock input', () => {
    const malformed = record('malformed', {
      revisions: [assertion({ revision: 2 })],
    });
    expect(axSelectPreferenceEvidence([malformed], context()).excluded).toEqual(
      [{ recordId: 'malformed', reason: 'malformed' }]
    );
    expect(() =>
      axSelectPreferenceEvidence([], context({ now: 'not-a-clock' }))
    ).toThrow(/valid host context/);
  });

  it('rejects duplicate IDs, future revisions, and forged lifecycle authority', () => {
    const forgedRetraction = axRetractPreferenceEvidence(record('retracted'), {
      recordedAt: NOW,
      sourceRef: 'source:model-claimed',
      authorityRef: 'authority:model-claimed',
    });
    const forgedErasure = axErasePreferenceEvidence(record('erased'), {
      recordedAt: NOW,
      authorityRef: 'authority:model-claimed',
    });
    const result = axSelectPreferenceEvidence(
      [
        record('duplicate'),
        record('duplicate'),
        record('future', {
          revisions: [assertion({ recordedAt: '2026-08-26T12:00:00.000Z' })],
        }),
        forgedRetraction,
        forgedErasure,
        axRetractPreferenceEvidence(record('future-retraction'), {
          recordedAt: '2026-08-26T12:00:00.000Z',
          sourceRef: 'source:settings-change:2',
          authorityRef: 'authority:account-control:1',
        }),
        axErasePreferenceEvidence(record('future-erasure'), {
          recordedAt: '2026-08-26T12:00:00.000Z',
          authorityRef: 'authority:erasure-request:2',
        }),
      ],
      context()
    );

    expect(result.applied).toEqual([]);
    expect(result.excluded).toEqual([
      { recordId: 'duplicate', reason: 'malformed' },
      { recordId: 'duplicate', reason: 'malformed' },
      { recordId: 'erased', reason: 'untrusted-authority' },
      { recordId: 'future', reason: 'future' },
      { recordId: 'future-erasure', reason: 'future' },
      { recordId: 'future-retraction', reason: 'future' },
      { recordId: 'retracted', reason: 'untrusted-source' },
    ]);
  });
});

describe('preference evidence lifecycle and memory integration', () => {
  it('retains revision history for retraction and withholds the record', () => {
    const original = record('style');
    const retracted = axRetractPreferenceEvidence(original, {
      recordedAt: NOW,
      sourceRef: 'source:settings-change:2',
      authorityRef: 'authority:account-control:1',
    });

    expect(retracted.revisions).toHaveLength(2);
    expect(retracted.revisions[0]).toEqual(original.revisions[0]);
    expect(axSelectPreferenceEvidence([retracted], context()).excluded).toEqual(
      [{ recordId: 'style', reason: 'retracted' }]
    );
    expect(() =>
      axRetractPreferenceEvidence(original, {
        recordedAt: '2026-08-19T12:00:00.000Z',
        sourceRef: 'source:settings-change:2',
        authorityRef: 'authority:account-control:1',
      })
    ).toThrow(/malformed preference evidence/);
  });

  it('erases prior content and sensitive references exactly', () => {
    const erased = axErasePreferenceEvidence(record('style'), {
      recordedAt: NOW,
      authorityRef: 'authority:erasure-request:2',
    });
    const serialized = JSON.stringify(erased);

    expect(erased.revisions).toEqual([
      {
        operation: 'erase',
        revision: 1,
        recordedAt: NOW,
        authorityRef: 'authority:erasure-request:2',
      },
    ]);
    expect(serialized).not.toContain('concise');
    expect(serialized).not.toContain('source:host-form:1');
    expect(serialized).not.toContain('consent:personalization:1');
    expect(axSelectPreferenceEvidence([erased], context()).excluded).toEqual([
      { recordId: 'style', reason: 'erased' },
    ]);
    expect(() =>
      axErasePreferenceEvidence(record('style'), {
        recordedAt: '2026-08-19T12:00:00.000Z',
        authorityRef: 'authority:erasure-request:2',
      })
    ).toThrow(/malformed preference evidence/);
  });

  it('adapts confirmed selections to the existing memory retrieval contract', async () => {
    const selection = axSelectPreferenceEvidence([record('style')], context());
    const memories = axPreferenceEvidenceToMemories(selection);
    const search = createCatalogMemoriesSearch(memories);

    expect(memories).toEqual([
      {
        id: 'preference:style@1',
        content:
          'Host-confirmed preference evidence.\nScope: response-style\nPreference: Use concise bullet points for status updates.',
      },
    ]);
    expect(await search(['concise status'], [])).toEqual(memories);
    const mutableSelection = selection as {
      applied: Array<(typeof selection.applied)[number]>;
    };
    mutableSelection.applied[0] = {
      ...(selection.applied[0] as (typeof selection.applied)[number]),
      revision: assertion({ value: 'Forged preference text.' }),
    };
    expect(axPreferenceEvidenceToMemories(selection)).toEqual(memories);
    expect(() =>
      axPreferenceEvidenceToMemories({
        applied: selection.applied,
        informational: [],
        excluded: [],
      })
    ).toThrow(/issued by axSelectPreferenceEvidence/);
  });
});
