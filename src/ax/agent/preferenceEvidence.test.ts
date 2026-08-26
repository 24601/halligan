import { describe, expect, it, vi } from 'vitest';
import { createCatalogMemoriesSearch } from './agentInternal/memoriesHelpers.js';
import {
  axPreferenceEvidenceLimits as AX_PREFERENCE_EVIDENCE_LIMITS,
  type AxPreferenceEvidenceAssertion,
  type AxPreferenceEvidenceContext,
  type AxPreferenceEvidenceReceiptPurpose,
  type AxPreferenceEvidenceReceiptRequest,
  type AxPreferenceEvidenceRecord,
  type AxPreferenceEvidenceRevision,
  axErasePreferenceEvidence,
  axPreferenceEvidenceToMemories,
  axRenewPreferenceEvidence,
  axRetractPreferenceEvidence,
  axSelectPreferenceEvidence,
} from './preferenceEvidence.js';

const NOW = '2026-08-25T12:00:00.000Z';

function assertion(
  id: string,
  overrides: Partial<AxPreferenceEvidenceAssertion> = {}
): AxPreferenceEvidenceAssertion {
  return {
    operation: 'assert',
    revision: 1,
    epoch: 1,
    eventId: `event:${id}:1`,
    kind: 'confirmed-preference',
    value: 'Use concise bullet points for status updates.',
    sourceReceiptRef: `source:${id}:1`,
    confidence: 1,
    scope: 'response-style',
    recordedAt: '2026-08-20T12:00:00.000Z',
    authorityReceiptRef: `authority:${id}:1`,
    consentReceiptRef: `consent:${id}:1`,
    ...overrides,
  };
}

function record(
  id: string,
  options: Readonly<{
    principalId?: string;
    assertion?: Partial<AxPreferenceEvidenceAssertion>;
  }> = {}
): AxPreferenceEvidenceRecord {
  return {
    id,
    principalId: options.principalId ?? 'principal:a',
    streamId: `stream:${id}`,
    streamVersion: 1,
    epoch: 1,
    revisions: [assertion(id, options.assertion)],
  };
}

function receiptFields(revision: AxPreferenceEvidenceRevision) {
  const copy = { ...revision } as Record<string, unknown>;
  delete copy.sourceReceiptRef;
  delete copy.authorityReceiptRef;
  delete copy.consentReceiptRef;
  delete copy.destructiveAuthorityReceiptRef;
  return copy;
}

function receiptKey(request: AxPreferenceEvidenceReceiptRequest): string {
  return JSON.stringify({
    principalId: request.principalId,
    recordId: request.recordId,
    streamId: request.streamId,
    streamVersion: request.streamVersion,
    epoch: request.epoch,
    revision: request.revision,
    eventId: request.eventId,
    operation: request.operation,
    purpose: request.purpose,
    payload: receiptFields(request.event),
  });
}

function receiptRefs(
  revision: AxPreferenceEvidenceRevision
): readonly [AxPreferenceEvidenceReceiptPurpose, string][] {
  const refs: [AxPreferenceEvidenceReceiptPurpose, string][] = [
    ['source', revision.sourceReceiptRef],
  ];
  if (revision.operation === 'erase') {
    refs.push([
      'destructive-lifecycle',
      revision.destructiveAuthorityReceiptRef,
    ]);
  } else if (revision.operation === 'retract') {
    refs.push(['authority', revision.authorityReceiptRef]);
  } else if (revision.operation === 'renew') {
    refs.push(['epoch-authority', revision.authorityReceiptRef]);
    refs.push(['consent', revision.consentReceiptRef]);
  } else if (revision.kind === 'confirmed-preference') {
    refs.push(['authority', revision.authorityReceiptRef as string]);
    refs.push(['consent', revision.consentReceiptRef as string]);
  }
  return refs;
}

function requestFor(
  record: AxPreferenceEvidenceRecord,
  revision: AxPreferenceEvidenceRevision,
  purpose: AxPreferenceEvidenceReceiptPurpose,
  receiptRef: string
): AxPreferenceEvidenceReceiptRequest {
  return {
    principalId: record.principalId,
    recordId: record.id,
    streamId: record.streamId,
    streamVersion: record.streamVersion,
    epoch: revision.epoch,
    revision: revision.revision,
    eventId: revision.eventId,
    operation: revision.operation,
    purpose,
    receiptRef,
    event: revision,
  };
}

function context(
  admittedRecords: readonly AxPreferenceEvidenceRecord[],
  overrides: Partial<AxPreferenceEvidenceContext> = {}
): AxPreferenceEvidenceContext {
  const streams = new Map(
    admittedRecords.map((entry) => [entry.streamId, JSON.stringify(entry)])
  );
  const receipts = new Map<string, string>();
  for (const entry of admittedRecords) {
    const latest = entry.revisions.at(-1) as AxPreferenceEvidenceRevision;
    for (const [purpose, receiptRef] of receiptRefs(latest)) {
      receipts.set(
        receiptRef,
        receiptKey(requestFor(entry, latest, purpose, receiptRef))
      );
    }
  }
  return {
    principalId: 'principal:a',
    query: 'Write a concise status update',
    scope: 'response-style',
    attributes: { channel: 'work' },
    now: NOW,
    verifyStreamState: (request) =>
      streams.get(request.streamId) === JSON.stringify(request.record),
    verifyReceipt: (request) =>
      receipts.get(request.receiptRef) === receiptKey(request),
    verifyDestructiveLifecycleReceipt: (request) =>
      receipts.get(request.receiptRef) === receiptKey(request),
    ...overrides,
  };
}

function retract(
  input: AxPreferenceEvidenceRecord,
  recordedAt = '2026-08-21T12:00:00.000Z'
): AxPreferenceEvidenceRecord {
  const version = input.streamVersion + 1;
  return axRetractPreferenceEvidence(input, {
    eventId: `event:${input.id}:${version}`,
    recordedAt,
    sourceReceiptRef: `source:${input.id}:${version}`,
    authorityReceiptRef: `authority:${input.id}:${version}`,
  });
}

function erase(
  input: AxPreferenceEvidenceRecord,
  recordedAt = '2026-08-21T12:00:00.000Z'
): AxPreferenceEvidenceRecord {
  const version = input.streamVersion + 1;
  return axErasePreferenceEvidence(input, {
    eventId: `event:${input.id}:${version}`,
    recordedAt,
    sourceReceiptRef: `source:${input.id}:${version}`,
    destructiveAuthorityReceiptRef: `destructive:${input.id}:${version}`,
  });
}

function renew(
  input: AxPreferenceEvidenceRecord,
  recordedAt = '2026-08-22T12:00:00.000Z'
): AxPreferenceEvidenceRecord {
  const version = input.streamVersion + 1;
  return axRenewPreferenceEvidence(input, {
    eventId: `event:${input.id}:${version}`,
    recordedAt,
    value: 'Use short headings in status updates.',
    sourceReceiptRef: `source:${input.id}:${version}`,
    confidence: 1,
    scope: 'response-style',
    authorityReceiptRef: `epoch-authority:${input.id}:${version}`,
    consentReceiptRef: `consent:${input.id}:${version}`,
  });
}

describe('axSelectPreferenceEvidence', () => {
  it('applies only confirmed preferences and adapts only issued selections', async () => {
    const confirmed = record('confirmed');
    const inferred = record('inferred', {
      assertion: {
        kind: 'inference',
        value: 'The principal may prefer short status updates.',
        authorityReceiptRef: undefined,
        consentReceiptRef: undefined,
        confidence: 0.55,
      },
    });
    const result = axSelectPreferenceEvidence(
      [confirmed, inferred],
      context([confirmed, inferred])
    );

    expect(result.applied.map((entry) => entry.recordId)).toEqual([
      'confirmed',
    ]);
    expect(result.informational.map((entry) => entry.recordId)).toEqual([
      'inferred',
    ]);
    const memories = axPreferenceEvidenceToMemories(result);
    expect(Object.isFrozen(memories)).toBe(true);
    expect(Object.isFrozen(memories[0])).toBe(true);
    const search = createCatalogMemoriesSearch(memories);
    expect(await search(['concise status'], [])).toMatchObject([
      { id: 'preference:confirmed@1.1' },
    ]);
    expect(() => axPreferenceEvidenceToMemories({ ...result })).toThrow(
      /issued/
    );
  });

  it('binds receipts to principal, record, event, operation, revision, epoch, and payload', () => {
    const admitted = record('admitted');
    const forged = record('forged', {
      assertion: {
        sourceReceiptRef: 'source:admitted:1',
        authorityReceiptRef: 'authority:admitted:1',
        consentReceiptRef: 'consent:admitted:1',
      },
    });
    const altered = {
      ...admitted,
      revisions: [
        {
          ...admitted.revisions[0],
          value: 'Use an attacker-selected style.',
        },
      ],
    } as AxPreferenceEvidenceRecord;

    expect(
      axSelectPreferenceEvidence([forged], context([admitted])).excluded
    ).toEqual([{ recordId: 'forged', reason: 'stale-stream' }]);
    expect(
      axSelectPreferenceEvidence([forged], {
        ...context([admitted]),
        verifyStreamState: () => true,
      }).excluded
    ).toEqual([{ recordId: 'forged', reason: 'unverified-source' }]);
    expect(
      axSelectPreferenceEvidence([altered], context([admitted])).excluded
    ).toEqual([{ recordId: 'admitted', reason: 'stale-stream' }]);

    const sourceForged = record('admitted', {
      assertion: { sourceReceiptRef: 'source:other-event:1' },
    });
    expect(
      axSelectPreferenceEvidence([sourceForged], {
        ...context([admitted]),
        verifyStreamState: () => true,
      }).excluded
    ).toEqual([{ recordId: 'admitted', reason: 'unverified-source' }]);
  });

  it('keeps destructive lifecycle authority separate from ordinary authority', () => {
    const original = record('erase-authority');
    const erased = erase(original);
    const ordinaryVerifier = context([erased]).verifyReceipt;
    const result = axSelectPreferenceEvidence(
      [erased],
      context([erased], {
        verifyDestructiveLifecycleReceipt: (request) =>
          ordinaryVerifier({
            ...request,
            purpose: 'authority',
            receiptRef: 'authority:erase-authority:2',
          }),
      })
    );
    expect(result.excluded).toEqual([
      {
        recordId: 'erase-authority',
        reason: 'unverified-destructive-lifecycle',
      },
    ]);
  });

  it('makes retraction and erasure monotonic and rejects replay or same-epoch resurrection', () => {
    const original = record('lifecycle');
    const retracted = retract(original);
    const erased = erase(original);
    expect(retracted.streamVersion).toBe(2);
    expect(erased.streamVersion).toBe(2);
    expect(erased.revisions).toHaveLength(1);
    expect(erased.revisions[0]).toMatchObject({
      operation: 'erase',
      revision: 2,
      epoch: 1,
    });
    expect(JSON.stringify(erased)).not.toContain(original.revisions[0]?.value);
    expect(JSON.stringify(erased)).not.toContain('consent:lifecycle:1');

    const widenedEvent = {
      ...original.revisions[0],
      eventId: 'event:lifecycle:widened-erase',
      recordedAt: '2026-08-21T12:00:00.000Z',
      sourceReceiptRef: 'source:lifecycle:widened-erase',
      destructiveAuthorityReceiptRef: 'destructive:lifecycle:widened-erase',
      secretPayload: 'ERASED SECRET',
    };
    const contentFree = axErasePreferenceEvidence(original, widenedEvent);
    expect(contentFree.revisions[0]).toEqual({
      operation: 'erase',
      revision: 2,
      epoch: 1,
      eventId: 'event:lifecycle:widened-erase',
      recordedAt: '2026-08-21T12:00:00.000Z',
      sourceReceiptRef: 'source:lifecycle:widened-erase',
      destructiveAuthorityReceiptRef: 'destructive:lifecycle:widened-erase',
    });
    expect(JSON.stringify(contentFree)).not.toContain('ERASED SECRET');
    expect(JSON.stringify(contentFree)).not.toContain(
      original.revisions[0]?.value
    );

    expect(
      axSelectPreferenceEvidence([original], context([erased])).excluded
    ).toEqual([{ recordId: 'lifecycle', reason: 'stale-stream' }]);

    const resurrected = {
      ...retracted,
      streamVersion: 3,
      revisions: [
        ...retracted.revisions,
        assertion('lifecycle', {
          revision: 3,
          eventId: 'event:lifecycle:3',
          recordedAt: '2026-08-22T12:00:00.000Z',
        }),
      ],
    } as AxPreferenceEvidenceRecord;
    expect(
      axSelectPreferenceEvidence([resurrected], context([resurrected])).excluded
    ).toEqual([{ recordId: 'lifecycle', reason: 'malformed' }]);
  });

  it('requires an explicit separately authorized epoch renewal', () => {
    const terminal = erase(record('renewed'));
    const renewed = renew(terminal);
    expect(renewed).toMatchObject({ streamVersion: 3, epoch: 2 });
    expect(
      axSelectPreferenceEvidence([renewed], context([renewed])).applied.map(
        (entry) => entry.recordId
      )
    ).toEqual(['renewed']);

    const forgedEpoch = {
      ...renewed,
      revisions: [
        renewed.revisions[0],
        {
          ...renewed.revisions[1],
          authorityReceiptRef: 'authority:renewed:1',
        },
      ],
    } as AxPreferenceEvidenceRecord;
    expect(
      axSelectPreferenceEvidence([forgedEpoch], {
        ...context([renewed]),
        verifyStreamState: () => true,
      }).excluded
    ).toEqual([{ recordId: 'renewed', reason: 'unverified-authority' }]);
    expect(() => renew(terminal, terminal.revisions[0]?.recordedAt)).toThrow(
      /strict chronology/
    );
  });

  it('fails closed on equal timestamps within and across supersession streams', () => {
    const sameTime = record('same-time');
    const malformed = {
      ...sameTime,
      streamVersion: 2,
      revisions: [
        ...sameTime.revisions,
        assertion('same-time', {
          revision: 2,
          eventId: 'event:same-time:2',
          recordedAt: sameTime.revisions[0]?.recordedAt,
        }),
      ],
    } as AxPreferenceEvidenceRecord;
    expect(
      axSelectPreferenceEvidence([malformed], context([malformed])).excluded
    ).toEqual([{ recordId: 'same-time', reason: 'malformed' }]);

    const old = record('old');
    const replacement = record('replacement', {
      assertion: { supersedes: ['old'] },
    });
    const result = axSelectPreferenceEvidence(
      [old, replacement],
      context([old, replacement])
    );
    expect(result.applied).toEqual([]);
    expect(result.excluded).toEqual([
      { recordId: 'old', reason: 'ambiguous-chronology' },
      { recordId: 'replacement', reason: 'ambiguous-chronology' },
    ]);
  });

  it('withholds contradictions, expired evidence, and cross-principal records', () => {
    const old = record('old');
    const conflict = record('conflict', {
      assertion: { contradicts: ['old'] },
    });
    const expired = record('expired', {
      assertion: { expiresAt: '2026-08-24T12:00:00.000Z' },
    });
    const other = record('other', { principalId: 'principal:b' });
    const result = axSelectPreferenceEvidence(
      [old, conflict, expired, other],
      context([old, conflict, expired, other])
    );
    expect(result.applied).toEqual([]);
    expect(result.excluded).toEqual([
      { recordId: 'conflict', reason: 'contradicted' },
      { recordId: 'expired', reason: 'expired' },
      { recordId: 'old', reason: 'contradicted' },
      { recordId: 'other', reason: 'principal-mismatch' },
    ]);
  });

  it('publishes detached frozen callback and selection objects', () => {
    const mutable = record('immutable') as {
      revisions: AxPreferenceEvidenceRevision[];
    } & AxPreferenceEvidenceRecord;
    const verifyReceipt = context([mutable]).verifyReceipt;
    let callbackRevision: AxPreferenceEvidenceRevision | undefined;
    const result = axSelectPreferenceEvidence(
      [mutable],
      context([mutable], {
        verifyReceipt: (request) => {
          expect(Object.isFrozen(request)).toBe(true);
          expect(Object.isFrozen(request.event)).toBe(true);
          callbackRevision = request.event;
          expect(() => {
            (request.event as { eventId: string }).eventId = 'mutated';
          }).toThrow();
          return verifyReceipt(request);
        },
        allowApplication: (revision) => {
          expect(Object.isFrozen(revision)).toBe(true);
          return true;
        },
      })
    );
    mutable.revisions[0] = assertion('immutable', {
      value: 'Mutated after selection.',
    });
    expect(callbackRevision?.value).toContain('concise');
    expect(result.applied[0]?.revision.value).toContain('concise');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.applied)).toBe(true);
    expect(Object.isFrozen(result.applied[0]?.revision)).toBe(true);
  });

  it('fails closed before callbacks when count, query, and shape limits are exceeded', () => {
    const verifyStreamState = vi.fn(() => true);
    const base = record('bounded');
    const boundedContext = context([base], { verifyStreamState });
    expect(() =>
      axSelectPreferenceEvidence(
        Array.from(
          { length: AX_PREFERENCE_EVIDENCE_LIMITS.records + 1 },
          (_, index) => record(`record-${index}`)
        ),
        boundedContext
      )
    ).toThrow(/record count limit/);
    expect(() =>
      axSelectPreferenceEvidence([], {
        ...boundedContext,
        query: 'q'.repeat(AX_PREFERENCE_EVIDENCE_LIMITS.queryChars + 1),
      })
    ).toThrow(/bounded host context/);
    const cyclic = record('cyclic') as AxPreferenceEvidenceRecord & {
      nested?: unknown;
    };
    cyclic.nested = cyclic;
    expect(() => axSelectPreferenceEvidence([cyclic], boundedContext)).toThrow(
      /cycles/
    );
    let nested: Record<string, unknown> = {};
    const deep = nested;
    for (
      let depth = 0;
      depth <= AX_PREFERENCE_EVIDENCE_LIMITS.objectDepth;
      depth++
    ) {
      nested.child = {};
      nested = nested.child as Record<string, unknown>;
    }
    expect(() =>
      axSelectPreferenceEvidence(
        [{ ...base, nested: deep } as AxPreferenceEvidenceRecord],
        boundedContext
      )
    ).toThrow(/object depth limit/);
    const wide = Object.fromEntries(
      Array.from(
        { length: AX_PREFERENCE_EVIDENCE_LIMITS.objectWidth + 1 },
        (_, index) => [`field-${index}`, index]
      )
    );
    expect(() =>
      axSelectPreferenceEvidence(
        [{ ...base, wide } as AxPreferenceEvidenceRecord],
        boundedContext
      )
    ).toThrow(/object width limit/);
    expect(verifyStreamState).not.toHaveBeenCalled();
  });

  it('excludes null records and revisions as malformed without denying valid records', () => {
    const valid = record('valid-beside-null');
    const withNullRecord = axSelectPreferenceEvidence(
      [valid, null] as unknown as readonly AxPreferenceEvidenceRecord[],
      context([valid])
    );
    expect(withNullRecord.applied.map((entry) => entry.recordId)).toEqual([
      'valid-beside-null',
    ]);
    expect(withNullRecord.excluded).toEqual([
      { recordId: '<unknown>', reason: 'malformed' },
    ]);

    const nullRevision = {
      ...record('null-revision'),
      revisions: [null],
    } as unknown as AxPreferenceEvidenceRecord;
    expect(
      axSelectPreferenceEvidence([nullRevision], context([])).excluded
    ).toEqual([{ recordId: 'null-revision', reason: 'malformed' }]);
  });

  it('keeps a stronger confirmed preference over a later weak self-contradicting inference', () => {
    const strong = record('noisy', {
      assertion: {
        value: 'Keep planning responses concise.',
        confidence: 0.99,
        contradicts: ['noisy'],
      },
    });
    const noisy = {
      ...strong,
      streamVersion: 2,
      revisions: [
        strong.revisions[0],
        assertion('noisy', {
          revision: 2,
          eventId: 'event:noisy:2',
          recordedAt: '2026-08-21T12:00:00.000Z',
          kind: 'inference',
          value: 'Possibly add extensive background.',
          confidence: 0.22,
          contradicts: ['noisy'],
          authorityReceiptRef: undefined,
          consentReceiptRef: undefined,
        }),
      ],
    } as AxPreferenceEvidenceRecord;
    const result = axSelectPreferenceEvidence(
      [noisy],
      context([noisy], {
        verifyReceipt: () => true,
        allowApplication: () => true,
      })
    );
    expect(result.applied).toMatchObject([
      {
        recordId: 'noisy',
        revision: {
          revision: 1,
          kind: 'confirmed-preference',
          confidence: 0.99,
        },
      },
    ]);
    expect(result.excluded).toEqual([]);
  });

  it('enforces value, applicability, relation, revision, byte, and attribute limits', () => {
    const base = record('limits');
    const tooLong = record('long', {
      assertion: {
        value: 'x'.repeat(AX_PREFERENCE_EVIDENCE_LIMITS.valueChars + 1),
      },
    });
    expect(
      axSelectPreferenceEvidence([tooLong], context([tooLong])).excluded
    ).toEqual([{ recordId: 'long', reason: 'malformed' }]);

    const applicability = Object.fromEntries(
      Array.from(
        { length: AX_PREFERENCE_EVIDENCE_LIMITS.applicabilityEntries + 1 },
        (_, index) => [`key-${index}`, 'value']
      )
    );
    const tooApplicable = record('applicability', {
      assertion: { applicability: { allOf: applicability } },
    });
    expect(
      axSelectPreferenceEvidence([tooApplicable], context([tooApplicable]))
        .excluded
    ).toEqual([{ recordId: 'applicability', reason: 'malformed' }]);

    const tooRelated = record('relations', {
      assertion: {
        supersedes: Array.from(
          { length: AX_PREFERENCE_EVIDENCE_LIMITS.relationRefs + 1 },
          (_, index) => `old-${index}`
        ),
      },
    });
    expect(
      axSelectPreferenceEvidence([tooRelated], context([tooRelated])).excluded
    ).toEqual([{ recordId: 'relations', reason: 'malformed' }]);

    const revisions = Array.from(
      { length: AX_PREFERENCE_EVIDENCE_LIMITS.revisionsPerRecord + 1 },
      (_, index) =>
        assertion('revisions', {
          revision: index + 1,
          eventId: `event:revisions:${index + 1}`,
          recordedAt: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000
          ).toISOString(),
        })
    );
    const tooManyRevisions = {
      ...base,
      id: 'revisions',
      streamId: 'stream:revisions',
      streamVersion: revisions.length,
      revisions,
    };
    expect(() =>
      axSelectPreferenceEvidence(
        [tooManyRevisions],
        context([tooManyRevisions])
      )
    ).toThrow(/array width limit/);

    const largeHistoryRevisions = Array.from(
      { length: AX_PREFERENCE_EVIDENCE_LIMITS.revisionsPerRecord },
      (_, index) =>
        assertion('large-history', {
          revision: index + 1,
          eventId: `event:large-history:${index + 1}`,
          value: `${index}:${'x'.repeat(300)}`,
          recordedAt: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000
          ).toISOString(),
        })
    );
    const largeHistory = {
      ...base,
      id: 'large-history',
      streamId: 'stream:large-history',
      streamVersion: largeHistoryRevisions.length,
      revisions: largeHistoryRevisions,
    };
    expect(() =>
      axSelectPreferenceEvidence([largeHistory], context([largeHistory]))
    ).toThrow(/per-record byte limit/);

    const large = Array.from({ length: 70 }, (_, index) =>
      record(`large-${index}`, {
        assertion: {
          value: `${index}:${'x'.repeat(
            AX_PREFERENCE_EVIDENCE_LIMITS.valueChars - 10
          )}`,
        },
      })
    );
    expect(() => axSelectPreferenceEvidence(large, context(large))).toThrow(
      /total byte limit/
    );

    const attributes = Object.fromEntries(
      Array.from(
        { length: AX_PREFERENCE_EVIDENCE_LIMITS.attributes + 1 },
        (_, index) => [`attribute-${index}`, 'value']
      )
    );
    expect(() =>
      axSelectPreferenceEvidence([], context([], { attributes }))
    ).toThrow(/attribute limits/);
  });
});
