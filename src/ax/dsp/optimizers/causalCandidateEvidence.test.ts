import { describe, expect, it } from 'vitest';
import {
  AxOptimizedProgramImpl,
  axAttachCausalCandidateEvidence,
  axDeserializeOptimizedProgram,
  axReplaceOptimizedProgramSnapshot,
  axSerializeOptimizedProgram,
} from '../optimizer.js';
import type {
  AxCausalCandidateEvidenceOptions,
  AxCausalCandidateEvidenceRecord,
  AxCausalEvidenceAuthorityVerifier,
} from './causalCandidateEvidence.js';
import {
  axCreateCausalCandidateEvidenceManifest,
  axFingerprintCausalEvidence,
} from './causalCandidateEvidence.js';

const componentId = 'answerer::instruction';
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function hostReceipt(receiptId: string): {
  options: AxCausalCandidateEvidenceOptions;
  verify: AxCausalEvidenceAuthorityVerifier;
} {
  const registry = hostReceiptRegistry();
  return { options: registry.options(receiptId), verify: registry.verify };
}

function hostReceiptRegistry(): {
  options: (receiptId: string) => AxCausalCandidateEvidenceOptions;
  verify: AxCausalEvidenceAuthorityVerifier;
} {
  const boundPayloads = new Map<string, string>();
  const verify: AxCausalEvidenceAuthorityVerifier = (
    payload,
    authority,
    purpose
  ) => {
    if (
      authority.principalId !== 'host:test' ||
      authority.evaluatorId !== 'eval:test' ||
      authority.verifierId !== 'verifier:test' ||
      authority.receiptVersion !== '1'
    ) {
      return false;
    }
    const boundPayload = boundPayloads.get(authority.receiptId);
    if (boundPayload === undefined) {
      if (purpose === 'replay') return false;
      boundPayloads.set(authority.receiptId, payload);
      return true;
    }
    return boundPayload === payload;
  };
  return {
    options: (receiptId) => ({
      authority: {
        principalId: 'host:test',
        evaluatorId: 'eval:test',
        verifierId: 'verifier:test',
        receiptId,
        receiptVersion: '1',
      },
      verifyAuthority: verify,
    }),
    verify,
  };
}

function record(
  overrides: Partial<AxCausalCandidateEvidenceRecord> = {}
): AxCausalCandidateEvidenceRecord {
  const metric = (before: number, after: number) => ({
    metrics: [{ metric: 'accuracy', before, after, sampleCount: 10 }],
  });
  return {
    id: 'claim-1',
    sequence: 0,
    eventKind: 'candidate_decision',
    candidateId: 'c1',
    evidence: [
      {
        id: 'trace-1',
        kind: 'trace',
        fingerprint: digest('a'),
        summary: 'contains raw-looking detail that is omitted by default',
      },
    ],
    hypothesis: 'The instruction misses the required grounding rule.',
    affectedComponents: [
      {
        componentId,
        surface: 'instruction',
        beforeFingerprint: digest('b'),
        afterFingerprint: digest('c'),
      },
    ],
    predictedBenefit: [
      {
        metric: 'accuracy',
        split: 'held_out',
        expectedDirection: 'increase',
        minimumExpectedDelta: 0.1,
        confidence: 0.8,
      },
    ],
    predictedRegressions: [],
    outcome: { heldIn: metric(0.5, 0.8), heldOut: metric(0.5, 0.7) },
    decision: { status: 'promoted', reason: 'Held-out gain was positive.' },
    ablation: {
      kind: 'ablation',
      removedComponentIds: [componentId],
      heldIn: metric(0.8, 0.5),
      heldOut: metric(0.7, 0.5),
      attribution: 'supports',
      summary: 'Removing the instruction removed the measured gain.',
    },
    ...overrides,
  };
}

function chain(length: number): AxCausalCandidateEvidenceRecord[] {
  return Array.from({ length }, (_, index) =>
    record({
      id: `claim-${index}`,
      sequence: index,
      parentRecordId: index ? `claim-${index - 1}` : undefined,
      candidateId: `c${index}`,
      evidence: [
        {
          id: `trace-${index}`,
          kind: 'trace',
          fingerprint: digest((index % 10).toString()),
        },
      ],
    })
  );
}

function artifact(value = 'new') {
  return new AxOptimizedProgramImpl({
    bestScore: 0.7,
    stats: {} as any,
    componentMap: { [componentId]: value },
    optimizerType: 'test',
    optimizationTime: 1,
    totalRounds: 1,
    converged: true,
  });
}

describe('causal candidate evidence', () => {
  it('omits evidence summaries by default and precisely describes free text', () => {
    const receipt = hostReceipt('receipt-redaction');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [record()],
      receipt.options
    );

    expect(manifest.records[0]?.evidence[0]?.summary).toBeUndefined();
    expect(manifest.records[0]?.ablation?.summary).toBeUndefined();
    expect(manifest.privacy).toMatchObject({
      evidencePayloads: 'not_in_schema',
      freeText: 'bounded_not_redacted',
      evidenceSummaries: 'omitted',
    });
    expect(Object.isFrozen(manifest.records[0]?.outcome.heldOut.metrics)).toBe(
      true
    );
  });

  it('fails closed instead of dropping newest records on overflow', () => {
    const receipt = hostReceipt('receipt-bounds');
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(chain(8), {
        ...receipt.options,
        includeEvidenceSummaries: true,
        maxSummaryChars: 16,
        maxRecords: 1,
      })
    ).toThrow(/exceeds maxRecords/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(chain(8), {
        ...receipt.options,
        includeEvidenceSummaries: true,
        maxSummaryChars: 16,
        maxArtifactBytes: 2800,
      })
    ).toThrow(/exceeds maxArtifactBytes/);
  });

  it('rejects minted-receipt forgery on replay', () => {
    const registry = hostReceiptRegistry();
    const attached = axAttachCausalCandidateEvidence(
      artifact(),
      [record()],
      registry.options('receipt-replay-known')
    );
    const forged = JSON.parse(
      JSON.stringify(axSerializeOptimizedProgram(attached))
    );
    forged.causalCandidateEvidence.records[0].hypothesis = 'FORGED HYPOTHESIS';
    forged.causalCandidateEvidence.receipts[0].authority.receiptId =
      'receipt-forged-mint';
    expect(() =>
      axDeserializeOptimizedProgram(forged, {
        causalEvidenceVerifier: registry.verify,
      })
    ).toThrow(/authority verification failed/);
  });

  it('rejects an unknown inherited receipt while appending', () => {
    const attacker = hostReceiptRegistry();
    const forgedPrior = Object.assign(artifact(), {
      causalCandidateEvidence: axCreateCausalCandidateEvidenceManifest(
        [record()],
        attacker.options('receipt-forged-prior')
      ),
    });
    const host = hostReceiptRegistry();

    expect(() =>
      axAttachCausalCandidateEvidence(
        forgedPrior,
        [
          record({
            id: 'claim-2',
            sequence: 1,
            parentRecordId: 'claim-1',
            candidateId: 'c2',
            evidence: [
              { id: 'trace-2', kind: 'trace', fingerprint: digest('d') },
            ],
          }),
        ],
        host.options('receipt-legit-new')
      )
    ).toThrow(/authority verification failed/);
  });

  it('uses canonical UTF-8 SHA-256 rather than collision-prone FNV identity', async () => {
    const left = 'trace-1mf0zaf-23065';
    const right = 'trace-v4wu3d-67395';
    const [leftDigest, rightDigest, composed, decomposed] = await Promise.all([
      axFingerprintCausalEvidence(left),
      axFingerprintCausalEvidence(right),
      axFingerprintCausalEvidence('é'),
      axFingerprintCausalEvidence('e\u0301'),
    ]);

    expect(leftDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(leftDigest).not.toBe(rightDigest);
    expect(composed).toBe(decomposed);
    await expect(
      axFingerprintCausalEvidence(String.fromCharCode(0xd800))
    ).rejects.toThrow(/well-formed UTF-16/);
    await expect(
      axFingerprintCausalEvidence(String.fromCharCode(0xd801))
    ).rejects.toThrow(/well-formed UTF-16/);
  });

  it('rejects invalid thresholds, duplicate metrics, and incomparable ablations', () => {
    const options = hostReceipt('receipt-invalid-metrics').options;
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          record({
            predictedBenefit: [
              {
                metric: 'accuracy',
                split: 'held_out',
                expectedDirection: 'increase',
                minimumExpectedDelta: -0.1,
              },
            ],
          }),
        ],
        options
      )
    ).toThrow(/non-negative/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          record({
            outcome: {
              heldIn: record().outcome.heldIn,
              heldOut: {
                metrics: [
                  {
                    metric: 'accuracy',
                    before: 0.5,
                    after: 0.7,
                    sampleCount: 10,
                  },
                  {
                    metric: 'accuracy',
                    before: 0.5,
                    after: 0.8,
                    sampleCount: 10,
                  },
                ],
              },
            },
          }),
        ],
        options
      )
    ).toThrow(/unique metric names/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          record({
            ablation: {
              ...record().ablation!,
              heldOut: {
                metrics: [
                  { metric: 'other', before: 0.7, after: 0.5, sampleCount: 10 },
                ],
              },
            },
          }),
        ],
        options
      )
    ).toThrow(/ablation metrics must match/);
  });

  it('enforces chronology, settlement targets, and global evidence bindings', () => {
    const options = hostReceipt('receipt-chronology').options;
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [record(), record({ id: 'claim-2', sequence: 2, candidateId: 'c2' })],
        options
      )
    ).toThrow(/sequence must equal 1/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          record(),
          record({
            id: 'settlement-1',
            sequence: 1,
            parentRecordId: 'claim-1',
            eventKind: 'settlement',
            candidateId: 'unrelated',
            settlesRecordId: 'claim-1',
            decision: { status: 'rejected', reason: 'rollback' },
          }),
        ],
        options
      )
    ).toThrow(/same candidate/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          record(),
          record({
            id: 'claim-2',
            sequence: 1,
            parentRecordId: 'claim-1',
            candidateId: 'c2',
            evidence: [
              { id: 'trace-1', kind: 'trace', fingerprint: digest('d') },
            ],
          }),
        ],
        options
      )
    ).toThrow(/conflicts with a prior fingerprint/);
  });

  it('attaches, replays with host verification, and rejects exact-field forgery', () => {
    const receipt = hostReceipt('receipt-replay');
    const attached = axAttachCausalCandidateEvidence(
      artifact(),
      [record()],
      receipt.options
    );
    const serialized = axSerializeOptimizedProgram(attached);
    const replayed = axDeserializeOptimizedProgram(serialized, {
      causalEvidenceVerifier: receipt.verify,
    });

    expect(replayed.causalCandidateEvidence).toEqual(
      attached.causalCandidateEvidence
    );
    const forged = JSON.parse(JSON.stringify(serialized));
    forged.causalCandidateEvidence.omittedRecordCount = 1;
    expect(() =>
      axDeserializeOptimizedProgram(forged, {
        causalEvidenceVerifier: receipt.verify,
      })
    ).toThrow(/metadata/);
    forged.causalCandidateEvidence.totalRecordCount = 2;
    expect(() =>
      axDeserializeOptimizedProgram(forged, {
        causalEvidenceVerifier: receipt.verify,
      })
    ).toThrow(/receipt does not cover|unauthorized/);
    const extraField = JSON.parse(JSON.stringify(serialized));
    extraField.causalCandidateEvidence.unsigned = 'forged';
    expect(() =>
      axDeserializeOptimizedProgram(extraField, {
        causalEvidenceVerifier: receipt.verify,
      })
    ).toThrow(/metadata/);
    expect(() => axDeserializeOptimizedProgram(serialized)).toThrow(
      /verifier is required/
    );
  });

  it('verifies and returns one detached snapshot despite verifier mutation', () => {
    const receipt = hostReceipt('receipt-mutation-isolation');
    const serialized = axSerializeOptimizedProgram(
      axAttachCausalCandidateEvidence(artifact(), [record()], receipt.options)
    ) as any;
    const original = serialized.causalCandidateEvidence.records[0].hypothesis;
    const mutatingVerifier: AxCausalEvidenceAuthorityVerifier = (
      payload,
      authority,
      purpose
    ) => {
      const verified = receipt.verify(payload, authority, purpose);
      serialized.causalCandidateEvidence.records[0].hypothesis =
        'FORGED AFTER VERIFY';
      return verified;
    };

    const replayed = axDeserializeOptimizedProgram(serialized, {
      causalEvidenceVerifier: mutatingVerifier,
    });
    expect(serialized.causalCandidateEvidence.records[0].hypothesis).toBe(
      'FORGED AFTER VERIFY'
    );
    expect(replayed.causalCandidateEvidence?.records[0]?.hypothesis).toBe(
      original
    );
  });

  it('preserves exact history through rollback then appends a valid settlement', () => {
    const receipts = hostReceiptRegistry();
    const promoted = axAttachCausalCandidateEvidence(
      artifact('candidate'),
      [record()],
      receipts.options('receipt-first')
    );
    const historyBeforeRollback = JSON.stringify(
      promoted.causalCandidateEvidence?.records
    );
    const rolledBack = axReplaceOptimizedProgramSnapshot(
      promoted,
      artifact('old'),
      receipts.verify
    );
    const settled = axAttachCausalCandidateEvidence(
      rolledBack,
      [
        record({
          id: 'settlement-1',
          sequence: 1,
          eventKind: 'settlement',
          parentRecordId: 'claim-1',
          settlesRecordId: 'claim-1',
          decision: { status: 'rejected', reason: 'rolled back' },
        }),
      ],
      receipts.options('receipt-settlement')
    );

    expect(rolledBack.componentMap).toEqual(artifact('old').componentMap);
    expect(JSON.stringify(rolledBack.causalCandidateEvidence?.records)).toBe(
      historyBeforeRollback
    );
    expect(settled.causalCandidateEvidence?.records.slice(0, 1)).toEqual(
      promoted.causalCandidateEvidence?.records
    );
    expect(settled.causalCandidateEvidence?.records[1]).toMatchObject({
      eventKind: 'settlement',
      settlesRecordId: 'claim-1',
    });
    expect(
      settled.causalCandidateEvidence?.receipts.map(
        (receipt) => receipt.authority.receiptId
      )
    ).toEqual(['receipt-first', 'receipt-settlement']);
    const replayed = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(settled),
      { causalEvidenceVerifier: receipts.verify }
    );
    expect(replayed.causalCandidateEvidence?.receipts).toEqual(
      settled.causalCandidateEvidence?.receipts
    );
    const forgedPriorBatch = axSerializeOptimizedProgram(settled) as any;
    forgedPriorBatch.causalCandidateEvidence.records[0].hypothesis =
      'forged prior batch';
    expect(() =>
      axDeserializeOptimizedProgram(forgedPriorBatch, {
        causalEvidenceVerifier: receipts.verify,
      })
    ).toThrow(/authority verification failed/);
  });

  it('preserves legacy artifacts without requiring an evidence verifier', () => {
    const replayed = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(artifact())
    );
    expect(replayed.causalCandidateEvidence).toBeUndefined();
  });
});
