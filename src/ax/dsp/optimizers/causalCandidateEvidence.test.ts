import { describe, expect, it } from 'vitest';
import {
  AxOptimizedProgramImpl,
  axAttachCausalCandidateEvidence,
  axDeserializeOptimizedProgram,
  axReplaceOptimizedProgramSnapshot,
  axSerializeOptimizedProgram,
} from '../optimizer.js';
import type { AxCausalCandidateEvidenceRecord } from './causalCandidateEvidence.js';
import {
  axCreateCausalCandidateEvidenceManifest,
  axFingerprintCausalEvidence,
} from './causalCandidateEvidence.js';

const componentId = 'answerer::instruction';

function record(
  overrides: Partial<AxCausalCandidateEvidenceRecord> = {}
): AxCausalCandidateEvidenceRecord {
  const metric = (before: number, after: number) => ({
    metrics: [{ metric: 'accuracy', before, after, sampleCount: 10 }],
  });
  return {
    id: 'claim-1',
    candidateId: 'c1',
    evidence: [
      {
        id: 'trace-1',
        kind: 'trace',
        fingerprint: axFingerprintCausalEvidence('private raw trace'),
        summary: 'contains raw-looking detail that is omitted by default',
      },
    ],
    hypothesis: 'The instruction misses the required grounding rule.',
    affectedComponents: [
      {
        componentId,
        surface: 'instruction',
        beforeFingerprint: axFingerprintCausalEvidence('old'),
        afterFingerprint: axFingerprintCausalEvidence('new'),
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
  it('omits raw evidence summaries by default and recursively freezes links', () => {
    const manifest = axCreateCausalCandidateEvidenceManifest([record()]);

    expect(manifest.records[0]?.evidence[0]?.summary).toBeUndefined();
    expect(manifest.records[0]?.ablation?.summary).toBeUndefined();
    expect(manifest.privacy).toMatchObject({
      rawEvidenceRetained: false,
      evidenceSummaries: 'omitted',
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.records[0]?.outcome.heldOut.metrics)).toBe(
      true
    );
  });

  it('bounds explicitly retained summaries and total UTF-8 size', () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      record({ id: `claim-${index}` })
    );
    const manifest = axCreateCausalCandidateEvidenceManifest(records, {
      includeEvidenceSummaries: true,
      maxSummaryChars: 16,
      maxArtifactBytes: 2600,
    });

    expect(manifest.records[0]?.evidence[0]?.summary).toHaveLength(16);
    expect(manifest.omittedRecordCount).toBeGreaterThan(0);
    expect(
      new TextEncoder().encode(JSON.stringify(manifest)).byteLength
    ).toBeLessThanOrEqual(2600);
  });

  it('rejects broken causal links and incomplete held-out receipts', () => {
    expect(() =>
      axCreateCausalCandidateEvidenceManifest([
        record({
          predictedBenefit: [
            {
              metric: 'latency',
              split: 'held_out',
              expectedDirection: 'decrease',
            },
          ],
        }),
      ])
    ).toThrow(/has no matching outcome/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest([
        record({
          outcome: { heldIn: { metrics: [] }, heldOut: { metrics: [] } },
        }),
      ])
    ).toThrow(/must not be empty/);
    expect(() =>
      axCreateCausalCandidateEvidenceManifest([
        record({
          evidence: [
            {
              id: 'trace-raw',
              kind: 'trace',
              fingerprint: 'raw trace text must not fit here',
            },
          ],
        }),
      ])
    ).toThrow(/supported digest fingerprint/);
  });

  it('retains predicted regressions when the same split has an outcome', () => {
    const withLatency = record({
      predictedRegressions: [
        {
          metric: 'latency_ms',
          split: 'held_out',
          expectedDirection: 'increase',
          confidence: 0.4,
        },
      ],
      outcome: {
        heldIn: {
          metrics: [
            { metric: 'accuracy', before: 0.5, after: 0.8, sampleCount: 10 },
          ],
        },
        heldOut: {
          metrics: [
            { metric: 'accuracy', before: 0.5, after: 0.7, sampleCount: 10 },
            {
              metric: 'latency_ms',
              before: 100,
              after: 104,
              sampleCount: 10,
            },
          ],
        },
      },
    });

    expect(
      axCreateCausalCandidateEvidenceManifest([withLatency]).records[0]
        ?.predictedRegressions
    ).toEqual(withLatency.predictedRegressions);
  });

  it('attaches immutably and survives serialization/replay', () => {
    const base = artifact();
    const attached = axAttachCausalCandidateEvidence(base, [record()]);
    const serialized = axSerializeOptimizedProgram(attached);
    const replayed = axDeserializeOptimizedProgram(serialized);

    expect(base.causalCandidateEvidence).toBeUndefined();
    expect(replayed.causalCandidateEvidence).toEqual(
      attached.causalCandidateEvidence
    );
    expect(Object.isFrozen(replayed.causalCandidateEvidence?.records[0])).toBe(
      true
    );
    expect(replayed.componentMap).toEqual(base.componentMap);
  });

  it('separates rewindable snapshots from append-only evidence history', () => {
    const original = artifact('old');
    const candidate = artifact('candidate');
    const promoted = axAttachCausalCandidateEvidence(candidate, [record()]);
    const evaluated = axAttachCausalCandidateEvidence(promoted, [
      record({
        id: 'claim-rejected',
        candidateId: 'c2',
        decision: { status: 'rejected', reason: 'Held-out score regressed.' },
      }),
    ]);
    const historyBeforeRollback = JSON.stringify(
      evaluated.causalCandidateEvidence?.records
    );

    const rolledBack = axReplaceOptimizedProgramSnapshot(evaluated, original);
    const settled = axAttachCausalCandidateEvidence(rolledBack, [
      record({
        id: 'claim-rollback-settlement',
        candidateId: 'c1',
        decision: {
          status: 'rejected',
          reason: 'Candidate was rolled back after regression.',
        },
      }),
    ]);

    expect(rolledBack.componentMap).toEqual(original.componentMap);
    expect(JSON.stringify(rolledBack.causalCandidateEvidence?.records)).toBe(
      historyBeforeRollback
    );
    expect(settled.causalCandidateEvidence?.records.slice(0, 2)).toEqual(
      evaluated.causalCandidateEvidence?.records
    );
    expect(
      settled.causalCandidateEvidence?.records.map((item) => item.id)
    ).toEqual(['claim-1', 'claim-rejected', 'claim-rollback-settlement']);
  });

  it('rejects forged privacy metadata during deserialization', () => {
    const serialized = axSerializeOptimizedProgram(
      axAttachCausalCandidateEvidence(artifact(), [record()])
    ) as any;
    serialized.causalCandidateEvidence.privacy.rawEvidenceRetained = true;
    serialized.causalCandidateEvidence.records[0].evidence[0].fingerprint =
      'raw trace content';

    expect(() => axDeserializeOptimizedProgram(serialized)).toThrow(
      /invalid causal candidate evidence manifest metadata/
    );
  });

  it('preserves legacy artifacts without adding evidence', () => {
    const replayed = axDeserializeOptimizedProgram(
      axSerializeOptimizedProgram(artifact())
    );
    expect(replayed.causalCandidateEvidence).toBeUndefined();
  });
});
