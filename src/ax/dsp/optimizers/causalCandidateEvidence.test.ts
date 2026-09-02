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
  axCanonicalizeCausalCandidateEvidenceManifest,
  axCloneCausalCandidateEvidenceManifest,
  axCreateCausalCandidateEvidenceManifest,
  axDeriveLeaveOneOutAttribution,
  axFingerprintCausalEvidence,
  axIsCausalAttributionRequiredError,
} from './causalCandidateEvidence.js';
import type { AxGEPACandidateLineageManifest } from './gepaLineage.js';
import { AX_REJECTED_LEDGER_REF_MAX_DIGESTS } from './rejectedCandidateLedger.js';

const componentId = 'answerer::instruction';
const programSourceComponentId = 'source-program::program-source';
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

function lineage(id: string): AxGEPACandidateLineageManifest {
  return {
    version: 1,
    records: [
      {
        id,
        parentIds: [],
        round: 0,
        strategy: 'seed',
        componentDelta: [],
        omittedComponentCount: 0,
        evaluations: [],
        metricCallsAtDecision: 1,
        metricCallBudget: 10,
        decision: 'accepted',
        reason: 'seed candidate',
        disposition: 'selected',
      },
    ],
    maxRecords: 100,
    maxArtifactBytes: 4096,
    omittedRecordCount: 0,
    selectedCandidateId: id,
    selectedCandidateRetained: true,
    paretoCandidateIds: [id],
    metricCallsUsed: 1,
    metricCallBudget: 10,
    stoppedReason: 'completed',
    termination: { phase: 'complete', round: 1, metricCallsUsed: 1 },
    checkpointSemantics: 'snapshot_only',
    privacy: {
      componentValues: 'fingerprints',
      failureMessages: 'fingerprints',
    },
  };
}

function artifact(
  value = 'new',
  candidateLineage?: AxGEPACandidateLineageManifest
) {
  return new AxOptimizedProgramImpl({
    bestScore: 0.7,
    stats: {} as any,
    componentMap: { [componentId]: value },
    candidateLineage,
    optimizerType: 'test',
    optimizationTime: 1,
    totalRounds: 1,
    converged: true,
  });
}

function programSourceArtifact(source: string, candidateId: string) {
  return new AxOptimizedProgramImpl({
    bestScore: 0.7,
    stats: {} as any,
    componentMap: { [programSourceComponentId]: source },
    candidateLineage: lineage(candidateId),
    optimizerType: 'GEPA',
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

  it('does not accept a forged already-issued capability', () => {
    const receipt = hostReceipt('receipt-bypass');
    const forged = axSerializeOptimizedProgram(
      axAttachCausalCandidateEvidence(artifact(), [record()], receipt.options)
    ) as any;
    forged.causalCandidateEvidence.records[0].hypothesis = 'FORGED HYPOTHESIS';
    forged.causalEvidenceAlreadyIssued = true;
    let verifierCalls = 0;

    expect(() =>
      axDeserializeOptimizedProgram(forged, {
        causalEvidenceVerifier: (...args) => {
          verifierCalls += 1;
          return receipt.verify(...args);
        },
      })
    ).toThrow(/authority verification failed/);
    expect(verifierCalls).toBeGreaterThan(0);
    expect(
      () =>
        new AxOptimizedProgramImpl({
          ...forged,
          causalEvidenceVerifier: () => false,
          causalEvidenceAlreadyIssued: Symbol('forged'),
        } as any)
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

  it('preserves program-source identity through causal replay, rollback, and settlement', () => {
    const selectedSource = JSON.stringify({
      version: 'ax-program-source/v1',
      capabilities: [],
      steps: [
        {
          op: 'return',
          outputs: { answer: { op: 'literal', value: 'selected' } },
        },
      ],
    });
    const rollbackSource = JSON.stringify({
      version: 'ax-program-source/v1',
      capabilities: [],
      steps: [
        {
          op: 'return',
          outputs: { answer: { op: 'literal', value: 'rollback' } },
        },
      ],
    });
    const receipts = hostReceiptRegistry();
    const decision = record({
      candidateId: 'program-source-c1',
      affectedComponents: [
        {
          componentId: programSourceComponentId,
          surface: 'program-source',
          beforeFingerprint: digest('b'),
          afterFingerprint: digest('c'),
        },
      ],
      ablation: undefined,
    });
    const attached = axAttachCausalCandidateEvidence(
      programSourceArtifact(selectedSource, 'program-source-c1'),
      [decision],
      receipts.options('receipt-program-source-decision')
    );
    const evidenceBeforeReplay = JSON.stringify(
      attached.causalCandidateEvidence
    );

    const replayed = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(attached),
      { causalEvidenceVerifier: receipts.verify }
    );
    expect(replayed.componentMap?.[programSourceComponentId]).toBe(
      selectedSource
    );
    expect(replayed.candidateLineage?.selectedCandidateId).toBe(
      'program-source-c1'
    );
    expect(JSON.stringify(replayed.causalCandidateEvidence)).toBe(
      evidenceBeforeReplay
    );

    const rolledBack = axReplaceOptimizedProgramSnapshot(
      replayed,
      programSourceArtifact(rollbackSource, 'program-source-c1'),
      receipts.verify
    );
    expect(rolledBack.componentMap?.[programSourceComponentId]).toBe(
      rollbackSource
    );
    expect(rolledBack.candidateLineage?.selectedCandidateId).toBe(
      'program-source-c1'
    );
    expect(JSON.stringify(rolledBack.causalCandidateEvidence)).toBe(
      evidenceBeforeReplay
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
          candidateId: 'program-source-c1',
          affectedComponents: decision.affectedComponents,
          decision: { status: 'rejected', reason: 'rolled back' },
          ablation: undefined,
        }),
      ],
      receipts.options('receipt-program-source-settlement')
    );
    expect(settled.componentMap?.[programSourceComponentId]).toBe(
      rollbackSource
    );
    expect(settled.candidateLineage?.selectedCandidateId).toBe(
      'program-source-c1'
    );
    expect(settled.causalCandidateEvidence?.records[0]).toEqual(
      replayed.causalCandidateEvidence?.records[0]
    );
    expect(
      settled.causalCandidateEvidence?.records.map(
        (evidenceRecord) => evidenceRecord.candidateId
      )
    ).toEqual(['program-source-c1', 'program-source-c1']);
    expect(
      settled.causalCandidateEvidence?.receipts.map(
        (receipt) => receipt.authority.receiptId
      )
    ).toEqual([
      'receipt-program-source-decision',
      'receipt-program-source-settlement',
    ]);

    const settledReplay = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(settled),
      { causalEvidenceVerifier: receipts.verify }
    );
    expect(settledReplay.componentMap?.[programSourceComponentId]).toBe(
      rollbackSource
    );
    expect(settledReplay.candidateLineage?.selectedCandidateId).toBe(
      'program-source-c1'
    );
    expect(settledReplay.causalCandidateEvidence).toEqual(
      settled.causalCandidateEvidence
    );
    expect(JSON.stringify(attached.causalCandidateEvidence)).toBe(
      evidenceBeforeReplay
    );
  });

  it('preserves lineage and causal evidence across artifact boundaries', () => {
    const receipts = hostReceiptRegistry();
    const attached = axAttachCausalCandidateEvidence(
      artifact('candidate', lineage('candidate-lineage')),
      [record()],
      receipts.options('receipt-combined')
    );

    expect(attached.candidateLineage?.selectedCandidateId).toBe(
      'candidate-lineage'
    );
    expect(Object.isFrozen(attached.candidateLineage)).toBe(true);
    expect(Object.isFrozen(attached.causalCandidateEvidence)).toBe(true);

    const replayed = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(attached),
      { causalEvidenceVerifier: receipts.verify }
    );
    expect(replayed.candidateLineage).toEqual(attached.candidateLineage);
    expect(replayed.causalCandidateEvidence).toEqual(
      attached.causalCandidateEvidence
    );
    expect(Object.isFrozen(replayed.candidateLineage)).toBe(true);
    expect(Object.isFrozen(replayed.causalCandidateEvidence)).toBe(true);

    const replaced = axReplaceOptimizedProgramSnapshot(
      replayed,
      artifact('replacement', lineage('replacement-lineage')),
      receipts.verify
    );
    expect(replaced.componentMap).toEqual({ [componentId]: 'replacement' });
    expect(replaced.candidateLineage?.selectedCandidateId).toBe(
      'replacement-lineage'
    );
    expect(replaced.causalCandidateEvidence).toEqual(
      replayed.causalCandidateEvidence
    );
    expect(Object.isFrozen(replaced.candidateLineage)).toBe(true);
    expect(Object.isFrozen(replaced.causalCandidateEvidence)).toBe(true);
  });

  it('preserves legacy artifacts without requiring an evidence verifier', () => {
    const replayed = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(artifact())
    );
    expect(replayed.causalCandidateEvidence).toBeUndefined();
  });
});

describe('causal candidate evidence version 4', () => {
  const metric = (before: number, after: number, sampleCount = 10) => ({
    metrics: [{ metric: 'accuracy', before, after, sampleCount }],
  });

  const multiComponentRecord = (
    overrides: Partial<AxCausalCandidateEvidenceRecord> = {}
  ): AxCausalCandidateEvidenceRecord => ({
    ...record(),
    affectedComponents: ['loo-a', 'loo-b', 'loo-c'].map((id, index) => ({
      componentId: id,
      surface: 'instruction',
      beforeFingerprint: digest('b'),
      afterFingerprint: digest(String(index)),
    })),
    ablation: undefined,
    ...overrides,
  });

  const leaveOneOut = (
    attribution: 'supports' | 'contradicts' | 'inconclusive',
    ids: readonly string[] = ['loo-a', 'loo-b', 'loo-c']
  ) => ({
    kind: 'ablation' as const,
    removedComponentIds: [...ids],
    heldIn: metric(0.8, 0.5),
    heldOut: metric(0.7, 0.5),
    attribution,
    metricCalls: 12,
    leaveOneOut: {
      rows: ids.map((id) => ({
        removedComponentId: id,
        heldIn: metric(0.8, 0.5),
        heldOut: metric(0.7, 0.5),
        attribution,
      })),
      metricCalls: 12,
    },
  });

  it('emits version 4 whenever any new record field is present, with no policy', () => {
    const { options } = hostReceipt('receipt-v4-field');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        record({
          mutation: {
            depth: 'supervision',
            patch: { class: 'steering', type: 'prompt.rule_modify' },
            componentClasses: ['context'],
          },
        }),
      ],
      options
    );
    expect(manifest.version).toBe(4);
    // No policy was requested, so none is declared — the version bump comes
    // from the record field alone.
    expect(manifest.policy).toBeUndefined();
  });

  it('keeps a legacy record at version 3 and re-serializes it byte for byte', () => {
    const { options, verify } = hostReceipt('receipt-v3-roundtrip');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [record()],
      options
    );
    expect(manifest.version).toBe(3);
    const before = JSON.stringify(manifest);
    const cloned = axCloneCausalCandidateEvidenceManifest(manifest, verify);
    expect(JSON.stringify(cloned)).toBe(before);
    // None of the version-4 keys leaked into the SERIALIZED record. They are
    // emitted as `undefined` alongside the legacy optional fields — the same
    // shape `parentRecordId` has always had — and `JSON.stringify` drops
    // them, which is exactly what INV-L2 asserts.
    const serialized = JSON.parse(before).records[0];
    for (const key of [
      'attribution',
      'mutation',
      'cost',
      'harness',
      'discrimination',
      'admission',
      'effects',
      'runtimeRequirements',
    ]) {
      expect(Object.hasOwn(serialized, key)).toBe(false);
    }
  });

  it('rejects a manifest that calls itself version 3 while carrying version 4 record fields', () => {
    const { options, verify } = hostReceipt('receipt-newwriter-v3');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        record({
          cost: { metricCalls: 20, proposerCalls: 2 },
        }),
      ],
      options
    );
    expect(manifest.version).toBe(4);
    // Hand-construct the failure the version rule exists to prevent.
    const forged = JSON.parse(JSON.stringify(manifest));
    forged.version = 3;
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(forged, verify)
    ).toThrow('cannot carry version 4 record fields');
  });

  it('covers the manifest policy with the receipt chain', () => {
    const { options, verify } = hostReceipt('receipt-policy-cover');
    const manifest = axCreateCausalCandidateEvidenceManifest([record()], {
      ...options,
      attributionPolicy: 'required',
      effectPolicy: 'required',
    });
    expect(manifest.version).toBe(4);
    expect(manifest.policy).toEqual({
      attribution: 'required',
      effects: 'required',
    });
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, verify)
    ).not.toThrow();

    // Flip the policy after issue. `version` is covered and always was; if
    // `policy` were not, this would still verify.
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.policy.attribution = 'off';
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(tampered, verify)
    ).toThrow('authority verification failed');
  });

  it('keeps version 3 canonical receipt bytes unchanged', () => {
    const { options, verify } = hostReceipt('receipt-v3-bytes');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [record()],
      options
    );
    const canonical = axCanonicalizeCausalCandidateEvidenceManifest(manifest);
    // The version guard means a version-3 payload has exactly the ten legacy
    // keys, in order, with no `policy` member.
    expect(Object.keys(JSON.parse(canonical))).toEqual([
      'version',
      'records',
      'recordCount',
      'totalRecordCount',
      'omittedRecordCount',
      'maxRecords',
      'maxArtifactBytes',
      'privacy',
      'authority',
      'priorReceipts',
    ]);
    expect(canonical).not.toContain('"policy"');
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, verify)
    ).not.toThrow();
  });

  it('enforces a caller-supplied policy floor on replay', () => {
    const { options, verify } = hostReceipt('receipt-floor');
    // The artifact declares nothing and self-validates.
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        multiComponentRecord({
          cost: { metricCalls: 4 },
        }),
      ],
      options
    );
    expect(manifest.policy).toBeUndefined();
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, verify)
    ).not.toThrow();
    // ...and the caller's floor still bites.
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, verify, {
        requirePolicyAtLeast: { attribution: 'required', effects: 'off' },
      })
    ).toThrow('attribution_required');
  });

  it('requires attribution for a promoted multi-component candidate', () => {
    const { options } = hostReceipt('receipt-attr-required');
    let thrown: unknown;
    try {
      axCreateCausalCandidateEvidenceManifest([multiComponentRecord()], {
        ...options,
        attributionPolicy: 'required',
      });
    } catch (error) {
      thrown = error;
    }
    expect(axIsCausalAttributionRequiredError(thrown)).toBe(true);
    expect((thrown as any).componentCount).toBe(3);
    // A single-component promotion needs none.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest([record()], {
        ...hostReceipt('receipt-attr-single').options,
        attributionPolicy: 'required',
      })
    ).not.toThrow();
    // Neither does a REJECTION across three components.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            decision: { status: 'rejected', reason: 'no gain' },
          }),
        ],
        {
          ...hostReceipt('receipt-attr-rejected').options,
          attributionPolicy: 'required',
        }
      )
    ).not.toThrow();
  });

  it('accepts an explicit inconclusive attribution instead of an ablation', () => {
    const { options } = hostReceipt('receipt-attr-inconclusive');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        multiComponentRecord({
          attribution: {
            status: 'inconclusive',
            reason:
              'The three components could not be separated on this split.',
          },
        }),
      ],
      { ...options, attributionPolicy: 'required' }
    );
    expect(manifest.records[0]?.attribution?.status).toBe('inconclusive');
  });

  it('refuses a record that both claims an ablation and disclaims attribution', () => {
    const { options } = hostReceipt('receipt-attr-both');
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: leaveOneOut('supports'),
            attribution: { status: 'inconclusive', reason: 'cannot separate' },
          }),
        ],
        { ...options, attributionPolicy: 'required' }
      )
    ).toThrow('cannot both claim an ablation and disclaim attribution');
  });

  it('requires the leave-one-out matrix to cover exactly the affected components', () => {
    // Missing row.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: leaveOneOut('supports', ['loo-a', 'loo-b']),
          }),
        ],
        {
          ...hostReceipt('receipt-loo-missing').options,
          attributionPolicy: 'required',
        }
      )
    ).toThrow('attribution_required');
    // Extra row naming a component the candidate never touched.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: leaveOneOut('supports', [
              'loo-a',
              'loo-b',
              'loo-c',
              'loo-d',
            ]),
          }),
        ],
        {
          ...hostReceipt('receipt-loo-extra').options,
          attributionPolicy: 'required',
        }
      )
    ).toThrow('is not affected by the candidate');
    // Exact coverage is accepted.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [multiComponentRecord({ ablation: leaveOneOut('supports') })],
        {
          ...hostReceipt('receipt-loo-exact').options,
          attributionPolicy: 'required',
        }
      )
    ).not.toThrow();
  });

  it('applies the ablation link invariants to every leave-one-out row', () => {
    // A duplicate removed component.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: leaveOneOut('supports', ['loo-a', 'loo-a', 'loo-c']),
          }),
        ],
        hostReceipt('receipt-loo-dup').options
      )
    ).toThrow('must remove distinct components');
    // A row whose metric set differs from the candidate outcome.
    const mismatched = leaveOneOut('supports');
    const rows = [...mismatched.leaveOneOut.rows];
    rows[1] = {
      ...rows[1]!,
      heldOut: {
        metrics: [{ metric: 'latency', before: 1, after: 2, sampleCount: 3 }],
      },
    };
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: {
              ...mismatched,
              leaveOneOut: { ...mismatched.leaveOneOut, rows },
            },
          }),
        ],
        hostReceipt('receipt-loo-metrics').options
      )
    ).toThrow('leave-one-out metrics for loo-b must match candidate outcomes');
  });

  it('charges leave-one-out metric calls to the record', () => {
    // `ablation.metricCalls` is a HOST SELF-REPORT: Ax ships no ablation
    // runner, so it validates the shape and cannot cross-check the number.
    const withoutCharge = leaveOneOut('supports');
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: { ...withoutCharge, metricCalls: undefined },
          }),
        ],
        hostReceipt('receipt-loo-uncharged').options
      )
    ).toThrow('charge its leave-one-out metric calls');
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          multiComponentRecord({
            ablation: {
              ...withoutCharge,
              leaveOneOut: { ...withoutCharge.leaveOneOut, metricCalls: 0 },
            },
          }),
        ],
        hostReceipt('receipt-loo-zero').options
      )
    ).toThrow('must be a positive integer');
  });

  it('derives a leave-one-out attribution column from the observed outcomes', () => {
    // Removing the component destroyed the gain -> it was carrying it.
    expect(
      axDeriveLeaveOneOutAttribution(metric(0.5, 0.9), metric(0.5, 0.5))
    ).toBe('supports');
    // Removing it helped -> the claim is contradicted.
    expect(
      axDeriveLeaveOneOutAttribution(metric(0.5, 0.6), metric(0.5, 0.9))
    ).toBe('contradicts');
    // Indistinguishable -> inconclusive, which is a first-class answer.
    expect(
      axDeriveLeaveOneOutAttribution(metric(0.5, 0.9), metric(0.5, 0.9))
    ).toBe('inconclusive');
    expect(
      axDeriveLeaveOneOutAttribution({ metrics: [] }, metric(0.5, 0.9))
    ).toBe('inconclusive');
  });

  const toolComponent = {
    componentId: programSourceComponentId,
    surface: 'evolved program source',
    beforeFingerprint: digest('b'),
    afterFingerprint: digest('c'),
    componentKind: 'program-source',
    componentClass: 'runtime' as const,
    toolCapabilities: ['predict', 'tool:charge'],
  };

  const capabilityRecord = (
    overrides: Partial<AxCausalCandidateEvidenceRecord> = {}
  ): AxCausalCandidateEvidenceRecord => ({
    ...record(),
    affectedComponents: [toolComponent],
    ablation: undefined,
    mutation: {
      depth: 'updateRule',
      patch: { class: 'capability', type: 'program.source_replace' },
      componentClasses: ['runtime'],
    },
    runtimeRequirements: { inspect: true, abort: true },
    ...overrides,
  });

  it('refuses promotion of a program-source tool-capability patch with no effect declaration', () => {
    expect(() =>
      axCreateCausalCandidateEvidenceManifest([capabilityRecord()], {
        ...hostReceipt('receipt-effects-missing').options,
        effectPolicy: 'required',
      })
    ).toThrow('effects_missing');
    // The same candidate WITHOUT a declared tool capability is accepted: the
    // gate keys on the declaration, never on the free-text surface.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            affectedComponents: [
              { ...toolComponent, toolCapabilities: ['predict'] },
            ],
          }),
        ],
        {
          ...hostReceipt('receipt-effects-no-tool').options,
          effectPolicy: 'required',
        }
      )
    ).not.toThrow();
    // And a REJECTED capability patch needs none.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            decision: { status: 'rejected', reason: 'no gain' },
          }),
        ],
        {
          ...hostReceipt('receipt-effects-rejected').options,
          effectPolicy: 'required',
        }
      )
    ).not.toThrow();
  });

  it('cannot be exempted from the effect gate by dropping or relabelling the mutation annotation', () => {
    // §12/B1. `mutation` is OPTIONAL and is authored by the same host as the
    // rest of the record, so a gate keyed on it is a gate its author switches
    // off. Both routes below produced an ACCEPTED version-4 manifest before
    // the gate moved onto `affectedComponents`.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [capabilityRecord({ mutation: undefined })],
        {
          ...hostReceipt('receipt-effects-no-mutation').options,
          effectPolicy: 'required',
        }
      )
    ).toThrow('effects_missing');
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            mutation: {
              depth: 'supervision',
              patch: { class: 'steering', type: 'prompt.rule_modify' },
              componentClasses: ['context'],
            },
          }),
        ],
        {
          ...hostReceipt('receipt-effects-relabelled').options,
          effectPolicy: 'required',
        }
      )
    ).toThrow('effects_missing');
    // Same two routes against the RUNTIME requirement, which keyed on
    // `mutation.patch.type === 'program.source_replace'`.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            mutation: undefined,
            runtimeRequirements: undefined,
            effects: [
              {
                operation: 'payments.capture',
                replaySafety: 'idempotent',
                idempotencyKeySource: 'derived',
                resolver: 'host_resolver',
              },
            ],
          }),
        ],
        {
          ...hostReceipt('receipt-runtime-no-mutation').options,
          effectPolicy: 'required',
        }
      )
    ).toThrow('runtime_requirements_missing');
    // CONTROL: the identical unannotated record that DOES declare its effects
    // and its runtime requirements is accepted, so the gate is not refusing
    // every unannotated record.
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            mutation: undefined,
            effects: [
              {
                operation: 'payments.capture',
                replaySafety: 'idempotent',
                idempotencyKeySource: 'derived',
                resolver: 'host_resolver',
              },
            ],
          }),
        ],
        {
          ...hostReceipt('receipt-effects-no-mutation-ok').options,
          effectPolicy: 'required',
        }
      )
    ).not.toThrow();
  });

  it("binds a reader's effects floor to an artifact that declares no policy", () => {
    // §12/B1's reader-side half: the manifest is WRITTEN with the effect
    // policy off (so it is accepted) and READ BACK under a caller floor of
    // `effects: 'required'`. The floor must bind on the way in.
    const receipt = hostReceipt('receipt-effects-floor');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [capabilityRecord({ mutation: undefined })],
      receipt.options
    );
    expect(manifest.policy?.effects ?? 'off').toBe('off');
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, receipt.verify, {
        requirePolicyAtLeast: { attribution: 'off', effects: 'required' },
      })
    ).toThrow('effects_missing');
    // CONTROL: the same manifest read back at its own declared floor clones.
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, receipt.verify, {
        requirePolicyAtLeast: { attribution: 'off', effects: 'off' },
      })
    ).not.toThrow();
  });

  it('accepts a capability promotion that declares its effects', () => {
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        capabilityRecord({
          effects: [
            {
              operation: 'payments.capture',
              replaySafety: 'idempotent',
              idempotencyKeySource: 'derived',
              resolver: 'host_resolver',
            },
          ],
        }),
      ],
      {
        ...hostReceipt('receipt-effects-ok').options,
        effectPolicy: 'required',
      }
    );
    expect(manifest.records[0]?.effects).toHaveLength(1);
    expect(manifest.version).toBe(4);
  });

  it('refuses an effect declaration on a steering surface', () => {
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          record({
            mutation: {
              depth: 'supervision',
              patch: { class: 'steering', type: 'tool.description_fix' },
              componentClasses: ['tools'],
            },
            effects: [
              {
                operation: 'payments.capture',
                replaySafety: 'idempotent',
                idempotencyKeySource: 'derived',
                resolver: 'host_resolver',
              },
            ],
          }),
        ],
        {
          ...hostReceipt('receipt-effects-steering').options,
          effectPolicy: 'required',
        }
      )
    ).toThrow('effects_on_steering_surface');
  });

  it('refuses a promoted program.source_replace candidate with no runtime requirements', () => {
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            runtimeRequirements: undefined,
            effects: [
              {
                operation: 'payments.capture',
                replaySafety: 'idempotent',
                idempotencyKeySource: 'derived',
                resolver: 'host_resolver',
              },
            ],
          }),
        ],
        {
          ...hostReceipt('receipt-runtime-missing').options,
          effectPolicy: 'required',
        }
      )
    ).toThrow('runtime_requirements_missing');
  });

  it('refuses an unsettleable or unkeyed effect declaration', () => {
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            effects: [
              {
                operation: 'payments.capture',
                replaySafety: 'unknown',
                idempotencyKeySource: 'derived',
                resolver: 'none',
              },
            ],
          }),
        ],
        hostReceipt('receipt-effects-unsettleable').options
      )
    ).toThrow('unsafe_replay_without_resolver');
    expect(() =>
      axCreateCausalCandidateEvidenceManifest(
        [
          capabilityRecord({
            effects: [
              {
                operation: 'payments.capture',
                replaySafety: 'idempotent',
                idempotencyKeySource: 'none',
                resolver: 'host_resolver',
              },
            ],
          }),
        ],
        hostReceipt('receipt-effects-unkeyed').options
      )
    ).toThrow('idempotent_without_key');
  });

  it('fills sampleCount from the admitted count, not the set length', () => {
    const { options } = hostReceipt('receipt-samplecount');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        record({
          outcome: {
            heldIn: metric(0.5, 0.8, 7),
            heldOut: metric(0.5, 0.7, 7),
          },
          ablation: undefined,
          admission: {
            evaluatedRows: 10,
            admittedRows: 7,
            discardedRows: 3,
            discardRate: 0.3,
            causes: { rate_limit: 3 },
            overriddenRows: 0,
            inconclusive: false,
          },
        }),
      ],
      options
    );
    const stored = manifest.records[0]!;
    expect(stored.admission?.admittedRows).toBe(7);
    expect(stored.admission?.evaluatedRows).toBe(10);
    // The outcome's denominator is the ADMITTED count. A record whose
    // sampleCount was the set length would claim evidence from rows that
    // never produced a score.
    expect(stored.outcome.heldIn.metrics[0]?.sampleCount).toBe(
      stored.admission?.admittedRows
    );
  });

  it('carries every new record field through the receipt chain and refuses a post-issue edit', () => {
    const { options, verify } = hostReceipt('receipt-v4-full');
    const manifest = axCreateCausalCandidateEvidenceManifest(
      [
        capabilityRecord({
          effects: [
            {
              operation: 'payments.capture',
              replaySafety: 'idempotent',
              idempotencyKeySource: 'derived',
              resolver: 'host_resolver',
            },
          ],
          cost: {
            metricCalls: 40,
            proposerCalls: 3,
            effort: 'high',
            costUsd: 0.12,
            wallMs: 900,
          },
          harness: {
            recipeDigest: digest('e') as any,
            boundModelId: 'model-a',
          },
          discrimination: {
            strategy: 'discriminative',
            estimator: 'ipw_hajek',
            gate: 'reflective_mutation',
            estimate: 0.2,
            stderr: 0.05,
            effectiveSampleSize: 6.5,
            pairedRowCount: 8,
          },
          admission: {
            evaluatedRows: 10,
            admittedRows: 8,
            discardedRows: 2,
            discardRate: 0.2,
            causes: { timeout: 2 },
            overriddenRows: 1,
            inconclusive: false,
          },
        }),
      ],
      { ...options, effectPolicy: 'required' }
    );
    expect(manifest.version).toBe(4);
    expect(() =>
      axCloneCausalCandidateEvidenceManifest(manifest, verify)
    ).not.toThrow();

    for (const mutate of [
      (m: any) => {
        m.records[0].cost.costUsd = 0;
      },
      (m: any) => {
        m.records[0].discrimination.estimator = 'sum';
      },
      (m: any) => {
        m.records[0].harness.boundModelId = 'model-b';
      },
      (m: any) => {
        m.records[0].admission.discardedRows = 0;
      },
      (m: any) => {
        m.records[0].effects[0].operation = 'payments.refund';
      },
      (m: any) => {
        m.records[0].runtimeRequirements.abort = undefined;
      },
    ]) {
      const tampered = JSON.parse(JSON.stringify(manifest));
      mutate(tampered);
      expect(() =>
        axCloneCausalCandidateEvidenceManifest(tampered, verify)
      ).toThrow();
    }
  });

  it('unions the rejected-candidate ledger ref across an artifact rollback while still refusing a divergent history', () => {
    const { options, verify } = hostReceipt('receipt-rollback');
    const seed = axAttachCausalCandidateEvidence(
      new AxOptimizedProgramImpl({
        bestScore: 0.5,
        stats: {} as any,
        optimizerType: 'GEPA',
        optimizationTime: 1,
        totalRounds: 1,
        converged: true,
      }),
      [record()],
      options
    );
    const current = new AxOptimizedProgramImpl({
      ...axSerializeOptimizedProgram(seed),
      causalCandidateEvidence: seed.causalCandidateEvidence,
      causalEvidenceVerifier: verify,
      rejectedCandidateLedgerRef: {
        storeId: 'store-1',
        entryDigests: [digest('1'), digest('2')] as any,
        omittedDigestCount: 0,
      },
    });
    const replacement = new AxOptimizedProgramImpl({
      ...axSerializeOptimizedProgram(seed),
      causalCandidateEvidence: seed.causalCandidateEvidence,
      causalEvidenceVerifier: verify,
      bestScore: 0.1,
      rejectedCandidateLedgerRef: {
        storeId: 'store-1',
        entryDigests: [digest('2'), digest('3')] as any,
        omittedDigestCount: 1,
      },
    });

    const rolledBack = axReplaceOptimizedProgramSnapshot(
      current,
      replacement,
      verify
    );
    // ASYMMETRIC: the score rewound, the ledger pointers did not.
    expect(rolledBack.bestScore).toBe(0.1);
    expect(rolledBack.rejectedCandidateLedgerRef?.entryDigests).toEqual([
      digest('1'),
      digest('2'),
      digest('3'),
    ]);
    expect(rolledBack.rejectedCandidateLedgerRef?.omittedDigestCount).toBe(1);

    // ...and the causal history's refusal is untouched.
    const divergent = axAttachCausalCandidateEvidence(
      new AxOptimizedProgramImpl({
        bestScore: 0.5,
        stats: {} as any,
        optimizerType: 'GEPA',
        optimizationTime: 1,
        totalRounds: 1,
        converged: true,
      }),
      [record({ hypothesis: 'A different claim entirely.' })],
      hostReceipt('receipt-rollback-divergent').options
    );
    expect(() =>
      axReplaceOptimizedProgramSnapshot(current, divergent, verify)
    ).toThrow('divergent causal evidence history');
  });

  it('holds a deserialized ledger ref to the same bounds as one GEPA wrote', () => {
    // §12/M3. `axDeserializeOptimizedProgram` reaches this constructor with
    // whatever the JSON said. A plain assignment carried arbitrary strings,
    // unbounded length and a mutable array into the artifact — every bound the
    // ref has was enforced only on the union and GEPA write paths.
    const oversized = Array.from(
      { length: AX_REJECTED_LEDGER_REF_MAX_DIGESTS + 44 },
      (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`
    );
    const program = new AxOptimizedProgramImpl({
      bestScore: 0.5,
      stats: {} as any,
      optimizerType: 'GEPA',
      optimizationTime: 1,
      totalRounds: 1,
      converged: true,
      rejectedCandidateLedgerRef: {
        storeId: 'store-1',
        entryDigests: [...oversized, ...oversized.slice(0, 3)] as any,
        omittedDigestCount: 0,
      },
    });
    const ref = program.rejectedCandidateLedgerRef!;
    // Deduplicated, clamped to the cap, oldest dropped, and counted.
    expect(ref.entryDigests).toHaveLength(AX_REJECTED_LEDGER_REF_MAX_DIGESTS);
    expect(ref.omittedDigestCount).toBe(44);
    expect(ref.entryDigests).not.toContain(oversized[0]);
    expect(ref.entryDigests).toContain(oversized[oversized.length - 1]);
    expect(Object.isFrozen(ref.entryDigests)).toBe(true);
    // A member that is not an identity digest can never resolve in the store,
    // so it is refused rather than silently carried.
    expect(
      () =>
        new AxOptimizedProgramImpl({
          bestScore: 0.5,
          stats: {} as any,
          optimizerType: 'GEPA',
          optimizationTime: 1,
          totalRounds: 1,
          converged: true,
          rejectedCandidateLedgerRef: {
            storeId: 'store-1',
            entryDigests: ['fnv1a64:cbf29ce484222325'] as any,
            omittedDigestCount: 0,
          },
        })
    ).toThrow('invalid_digest');
    // CONTROL: a well-formed ref survives a serialize/deserialize round trip
    // unchanged, so the bounds above refuse bad input rather than every input.
    const roundTripped = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(
        new AxOptimizedProgramImpl({
          bestScore: 0.5,
          stats: {} as any,
          optimizerType: 'GEPA',
          optimizationTime: 1,
          totalRounds: 1,
          converged: true,
          rejectedCandidateLedgerRef: {
            storeId: 'store-1',
            entryDigests: [digest('1'), digest('2')] as any,
            omittedDigestCount: 2,
          },
        })
      )
    );
    expect(roundTripped.rejectedCandidateLedgerRef).toEqual({
      storeId: 'store-1',
      entryDigests: [digest('1'), digest('2')],
      omittedDigestCount: 2,
    });
  });

  it('refuses a ledger-ref union across different stores', () => {
    const { options, verify } = hostReceipt('receipt-store-mismatch');
    const seed = axAttachCausalCandidateEvidence(
      new AxOptimizedProgramImpl({
        bestScore: 0.5,
        stats: {} as any,
        optimizerType: 'GEPA',
        optimizationTime: 1,
        totalRounds: 1,
        converged: true,
      }),
      [record()],
      options
    );
    const withRef = (storeId: string) =>
      new AxOptimizedProgramImpl({
        ...axSerializeOptimizedProgram(seed),
        causalCandidateEvidence: seed.causalCandidateEvidence,
        causalEvidenceVerifier: verify,
        rejectedCandidateLedgerRef: {
          storeId,
          entryDigests: [digest('1')] as any,
          omittedDigestCount: 0,
        },
      });
    expect(() =>
      axReplaceOptimizedProgramSnapshot(
        withRef('store-1'),
        withRef('store-2'),
        verify
      )
    ).toThrow('store_id_mismatch');
  });
});
