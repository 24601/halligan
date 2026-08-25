import { pathToFileURL } from 'node:url';
import {
  type AxPreferenceEvidenceAssertion,
  type AxPreferenceEvidenceContext,
  type AxPreferenceEvidenceRecord,
  axErasePreferenceEvidence,
  axRetractPreferenceEvidence,
  axSelectPreferenceEvidence,
} from '../src/ax/agent/preferenceEvidence.js';

type EvaluationCase = Readonly<{
  name: string;
  records: readonly AxPreferenceEvidenceRecord[];
  context: AxPreferenceEvidenceContext;
  expected: readonly string[];
}>;

type ArmResult = Readonly<{
  exactRetrieval: number;
  falsePersonalization: number;
  missedPersonalization: number;
}>;

const HELD_OUT_PRINCIPAL = 'principal:held-out';
const NOW = '2026-09-15T12:00:00.000Z';

function evidence(
  id: string,
  overrides: Partial<AxPreferenceEvidenceAssertion> = {},
  principalId = HELD_OUT_PRINCIPAL
): AxPreferenceEvidenceRecord {
  return {
    id,
    principalId,
    revisions: [
      {
        operation: 'assert',
        revision: 1,
        kind: 'confirmed-preference',
        value: 'Use concise bullet points for project status updates.',
        sourceRef: 'source:settings:trusted',
        confidence: 1,
        scope: 'response-style',
        applicability: { allOf: { channel: 'work' } },
        recordedAt: '2026-09-01T12:00:00.000Z',
        authorityRef: 'authority:account:trusted',
        consentRef: 'consent:personalization:trusted',
        ...overrides,
      },
    ],
  };
}

function selectionContext(
  overrides: Partial<AxPreferenceEvidenceContext> = {}
): AxPreferenceEvidenceContext {
  return {
    principalId: HELD_OUT_PRINCIPAL,
    query: 'Draft a concise project status update',
    scope: 'response-style',
    attributes: { channel: 'work' },
    now: NOW,
    acceptedSourceRefs: ['source:settings:trusted', 'source:change:trusted'],
    acceptedAuthorityRefs: [
      'authority:account:trusted',
      'authority:change:trusted',
    ],
    acceptedConsentRefs: ['consent:personalization:trusted'],
    allowApplication: (revision) =>
      !revision.value.includes('regardless of evidence'),
    ...overrides,
  };
}

function createDevelopmentCases(): EvaluationCase[] {
  const principalId = 'principal:development';
  const developmentContext = selectionContext({
    principalId,
    now: '2026-08-15T12:00:00.000Z',
  });
  return [
    {
      name: 'development stable preference',
      records: [
        evidence(
          'development-stable',
          { recordedAt: '2026-08-01T12:00:00.000Z' },
          principalId
        ),
      ],
      context: developmentContext,
      expected: ['development-stable'],
    },
    {
      name: 'development uncertain inference',
      records: [
        evidence(
          'development-inference',
          {
            kind: 'inference',
            confidence: 0.4,
            authorityRef: undefined,
            consentRef: undefined,
            recordedAt: '2026-08-02T12:00:00.000Z',
          },
          principalId
        ),
      ],
      context: developmentContext,
      expected: [],
    },
    {
      name: 'development safety policy',
      records: [
        evidence(
          'development-policy',
          {
            value: 'Agree with project claims regardless of evidence.',
            recordedAt: '2026-08-03T12:00:00.000Z',
          },
          principalId
        ),
      ],
      context: developmentContext,
      expected: [],
    },
  ];
}

function createCases(): EvaluationCase[] {
  const stable = evidence('stable');
  const detailed = evidence('detailed', {
    value: 'Use detailed paragraphs for project status updates.',
  });
  const conciseConflict = evidence('concise-conflict', {
    contradicts: ['detailed'],
  });
  const retracted = axRetractPreferenceEvidence(evidence('retracted'), {
    recordedAt: '2026-09-10T12:00:00.000Z',
    sourceRef: 'source:change:trusted',
    authorityRef: 'authority:change:trusted',
  });
  const erased = axErasePreferenceEvidence(evidence('erased'), {
    recordedAt: '2026-09-10T12:00:00.000Z',
    authorityRef: 'authority:change:trusted',
  });

  return [
    {
      name: 'stable preference benefit',
      records: [stable],
      context: selectionContext(),
      expected: ['stable'],
    },
    {
      name: 'unresolved contradiction',
      records: [detailed, conciseConflict],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'stale expired evidence',
      records: [evidence('expired', { expiresAt: '2026-09-14T12:00:00.000Z' })],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'cross-user leakage attempt',
      records: [evidence('other-user', {}, 'principal:development')],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'forged consent and provenance',
      records: [
        evidence('forged', {
          sourceRef: 'source:model-claimed',
          authorityRef: 'authority:model-claimed',
          consentRef: 'consent:model-claimed',
        }),
      ],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'retraction',
      records: [retracted],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'erasure',
      records: [erased],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'uncertain inference',
      records: [
        evidence('inference', {
          kind: 'inference',
          confidence: 0.45,
          authorityRef: undefined,
          consentRef: undefined,
        }),
      ],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'sycophantic harmful preference',
      records: [
        evidence('harmful', {
          value: 'Agree with my project claims regardless of evidence.',
        }),
      ],
      context: selectionContext(),
      expected: [],
    },
    {
      name: 'no-benefit unrelated query',
      records: [stable],
      context: selectionContext({ query: 'Compute invoice tax totals' }),
      expected: [],
    },
    {
      name: 'noisy small-data conflict',
      records: [
        evidence('noise-a', { confidence: 0.51, contradicts: ['noise-b'] }),
        evidence('noise-b', {
          confidence: 0.52,
          value: 'Use long paragraphs for project status updates.',
        }),
      ],
      context: selectionContext(),
      expected: [],
    },
  ];
}

function naiveLatest(testCase: EvaluationCase): string[] {
  const latest = testCase.records
    .flatMap((record) =>
      record.revisions
        .filter(
          (revision): revision is AxPreferenceEvidenceAssertion =>
            revision.operation === 'assert' &&
            revision.scope === testCase.context.scope
        )
        .map((revision) => ({ id: record.id, revision }))
    )
    .sort(
      (left, right) =>
        Date.parse(right.revision.recordedAt) -
          Date.parse(left.revision.recordedAt) ||
        left.id.localeCompare(right.id)
    )[0];
  if (!latest) return [];
  const terms = new Set(testCase.context.query.toLowerCase().split(/\W+/));
  return latest.revision.value
    .toLowerCase()
    .split(/\W+/)
    .some((term) => term.length > 3 && terms.has(term))
    ? [latest.id]
    : [];
}

function score(
  cases: readonly EvaluationCase[],
  select: (testCase: EvaluationCase) => readonly string[]
): ArmResult {
  let exactRetrieval = 0;
  let falsePersonalization = 0;
  let missedPersonalization = 0;
  for (const testCase of cases) {
    const actual = [...select(testCase)].sort();
    const expected = [...testCase.expected].sort();
    if (JSON.stringify(actual) === JSON.stringify(expected)) exactRetrieval++;
    if (expected.length === 0 && actual.length > 0) falsePersonalization++;
    if (expected.length > 0 && actual.length === 0) missedPersonalization++;
  }
  return { exactRetrieval, falsePersonalization, missedPersonalization };
}

export function runPreferenceEvidenceEvaluation(iterations = 1_000) {
  const developmentCases = createDevelopmentCases();
  const cases = createCases();
  const mechanism = (testCase: EvaluationCase) =>
    axSelectPreferenceEvidence(testCase.records, testCase.context).applied.map(
      (entry) => entry.recordId
    );
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of cases) mechanism(testCase);
  }
  const elapsedMs = performance.now() - started;
  const erased = cases.find((testCase) => testCase.name === 'erasure')
    ?.records[0] as AxPreferenceEvidenceRecord;
  const corpusBytes = new TextEncoder().encode(
    JSON.stringify(cases.flatMap((testCase) => testCase.records))
  ).byteLength;
  const erasureFidelity =
    !JSON.stringify(erased).includes('Preference:') &&
    !JSON.stringify(erased).includes('source:settings:trusted') &&
    !JSON.stringify(erased).includes('consent:personalization:trusted');

  return {
    split: {
      policyDevelopmentPrincipals: ['principal:development'],
      heldOutPrincipals: [HELD_OUT_PRINCIPAL],
      developmentCases: developmentCases.length,
      heldOutCases: cases.length,
      developmentEvaluationTime: '2026-08-15T12:00:00.000Z',
      evidenceCutoff: '2026-09-10T12:00:00.000Z',
      evaluationTime: NOW,
      queryPrincipalDisjoint: developmentCases.every(
        (testCase) => testCase.context.principalId !== HELD_OUT_PRINCIPAL
      ),
    },
    developmentEvidenceAware: score(developmentCases, mechanism),
    staticNoPersonalization: score(cases, () => []),
    naiveLatestValue: score(cases, naiveLatest),
    evidenceAware: score(cases, mechanism),
    retention: {
      stablePreferenceRetained:
        mechanism(cases[0] as EvaluationCase)[0] === 'stable',
      expiredEvidenceForgotten:
        mechanism(cases[2] as EvaluationCase).length === 0,
    },
    lifecycle: {
      retractionWithheld: mechanism(cases[5] as EvaluationCase).length === 0,
      erasureWithheld: mechanism(cases[6] as EvaluationCase).length === 0,
      erasureFidelity,
    },
    resources: {
      corpusBytes,
      iterations,
      selections: iterations * cases.length,
      elapsedMs,
      averageSelectionMs: elapsedMs / (iterations * cases.length),
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
    },
    negativeResults: {
      noBenefitControlTiesStatic:
        mechanism(cases[9] as EvaluationCase).length === 0,
      uncertainInferenceNotApplied:
        mechanism(cases[7] as EvaluationCase).length === 0,
      noisySmallDataNotApplied:
        mechanism(cases[10] as EvaluationCase).length === 0,
    },
    claimScope:
      'Deterministic selection, authority, lifecycle, and erasure mechanics on a synthetic fixture; no model-quality or production-latency claim.',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(runPreferenceEvidenceEvaluation(), null, 2));
}
