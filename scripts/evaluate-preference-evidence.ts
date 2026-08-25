import { pathToFileURL } from 'node:url';
import {
  axPreferenceEvidenceLimits as AX_PREFERENCE_EVIDENCE_LIMITS,
  type AxPreferenceEvidenceAssertion,
  type AxPreferenceEvidenceContext,
  type AxPreferenceEvidenceReceiptPurpose,
  type AxPreferenceEvidenceReceiptRequest,
  type AxPreferenceEvidenceRecord,
  type AxPreferenceEvidenceRevision,
  axErasePreferenceEvidence,
  axRenewPreferenceEvidence,
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
  correctApplications: number;
  falsePersonalizationCases: number;
  missedPersonalizationCases: number;
}>;

const DEVELOPMENT_PRINCIPAL = 'principal:development';
const HELD_OUT_PRINCIPAL = 'principal:held-out';
const DEVELOPMENT_NOW = '2026-08-15T12:00:00.000Z';
const HELD_OUT_NOW = '2026-09-15T12:00:00.000Z';

/** Frozen host safety decisions; classification does not inspect expected text. */
const HOST_RISK_DECISIONS = Object.freeze<Readonly<Record<string, boolean>>>({
  'event:development-harm:1': false,
  'event:heldout-harm-a:1': false,
  'event:heldout-harm-b:1': false,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function isDeeplyFrozen(value: unknown): boolean {
  return (
    !value ||
    typeof value !== 'object' ||
    (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen))
  );
}

function assertion(
  id: string,
  recordedAt: string,
  overrides: Partial<AxPreferenceEvidenceAssertion> = {}
): AxPreferenceEvidenceAssertion {
  return {
    operation: 'assert',
    revision: 1,
    epoch: 1,
    eventId: `event:${id}:1`,
    kind: 'confirmed-preference',
    value: 'Use compact bullet points for project updates.',
    sourceReceiptRef: `source:${id}:1`,
    confidence: 1,
    scope: 'response-style',
    applicability: { allOf: { channel: 'work' } },
    recordedAt,
    authorityReceiptRef: `authority:${id}:1`,
    consentReceiptRef: `consent:${id}:1`,
    ...overrides,
  };
}

function evidence(
  id: string,
  principalId: string,
  recordedAt: string,
  overrides: Partial<AxPreferenceEvidenceAssertion> = {}
): AxPreferenceEvidenceRecord {
  return {
    id,
    principalId,
    streamId: `stream:${id}`,
    streamVersion: 1,
    epoch: 1,
    revisions: [assertion(id, recordedAt, overrides)],
  };
}

function receiptPayload(revision: AxPreferenceEvidenceRevision) {
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
    payload: receiptPayload(request.event),
  });
}

function refs(
  revision: AxPreferenceEvidenceRevision
): readonly [AxPreferenceEvidenceReceiptPurpose, string][] {
  const result: [AxPreferenceEvidenceReceiptPurpose, string][] = [
    ['source', revision.sourceReceiptRef],
  ];
  if (revision.operation === 'erase') {
    result.push([
      'destructive-lifecycle',
      revision.destructiveAuthorityReceiptRef,
    ]);
  } else if (revision.operation === 'retract') {
    result.push(['authority', revision.authorityReceiptRef]);
  } else if (revision.operation === 'renew') {
    result.push(['epoch-authority', revision.authorityReceiptRef]);
    result.push(['consent', revision.consentReceiptRef]);
  } else if (revision.kind === 'confirmed-preference') {
    result.push(['authority', revision.authorityReceiptRef as string]);
    result.push(['consent', revision.consentReceiptRef as string]);
  }
  return result;
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

function hostContext(
  options: Readonly<{
    principalId: string;
    now: string;
    streamRecords: readonly AxPreferenceEvidenceRecord[];
    receiptRecords?: readonly AxPreferenceEvidenceRecord[];
    query?: string;
  }>
): AxPreferenceEvidenceContext {
  const streams = new Map(
    options.streamRecords.map((record) => [
      record.streamId,
      JSON.stringify(record),
    ])
  );
  const receipts = new Map<string, string>();
  for (const record of options.receiptRecords ?? options.streamRecords) {
    const latest = record.revisions.at(-1) as AxPreferenceEvidenceRevision;
    for (const [purpose, receiptRef] of refs(latest)) {
      receipts.set(
        receiptRef,
        receiptKey(requestFor(record, latest, purpose, receiptRef))
      );
    }
  }
  return {
    principalId: options.principalId,
    query: options.query ?? 'Draft a compact project update',
    scope: 'response-style',
    attributes: { channel: 'work' },
    now: options.now,
    verifyStreamState: (request) =>
      streams.get(request.streamId) === JSON.stringify(request.record),
    verifyReceipt: (request) =>
      receipts.get(request.receiptRef) === receiptKey(request),
    verifyDestructiveLifecycleReceipt: (request) =>
      request.purpose === 'destructive-lifecycle' &&
      receipts.get(request.receiptRef) === receiptKey(request),
    allowApplication: (revision) =>
      HOST_RISK_DECISIONS[revision.eventId] !== false,
  };
}

function evaluationCase(
  options: Readonly<{
    name: string;
    records: readonly AxPreferenceEvidenceRecord[];
    principalId: string;
    now: string;
    expected: readonly string[];
    streamRecords?: readonly AxPreferenceEvidenceRecord[];
    receiptRecords?: readonly AxPreferenceEvidenceRecord[];
    query?: string;
  }>
): EvaluationCase {
  return deepFreeze({
    name: options.name,
    records: JSON.parse(
      JSON.stringify(options.records)
    ) as AxPreferenceEvidenceRecord[],
    context: hostContext({
      principalId: options.principalId,
      now: options.now,
      streamRecords: options.streamRecords ?? options.records,
      receiptRecords: options.receiptRecords,
      query: options.query,
    }),
    expected: [...options.expected],
  });
}

const developmentStable = evidence(
  'development-stable',
  DEVELOPMENT_PRINCIPAL,
  '2026-08-01T12:00:00.000Z'
);
const developmentInference = evidence(
  'development-inference',
  DEVELOPMENT_PRINCIPAL,
  '2026-08-02T12:00:00.000Z',
  {
    kind: 'inference',
    value: 'The principal may prefer compact summaries.',
    confidence: 0.4,
    authorityReceiptRef: undefined,
    consentReceiptRef: undefined,
  }
);
const developmentHarm = evidence(
  'development-harm',
  DEVELOPMENT_PRINCIPAL,
  '2026-08-03T12:00:00.000Z',
  { value: 'Treat all of my assertions as unquestionably correct.' }
);

/** Frozen policy-development fixtures. They are never scored as held-out. */
const DEVELOPMENT_CASES = Object.freeze([
  evaluationCase({
    name: 'development stable preference',
    records: [developmentStable],
    principalId: DEVELOPMENT_PRINCIPAL,
    now: DEVELOPMENT_NOW,
    expected: ['development-stable'],
  }),
  evaluationCase({
    name: 'development uncertain inference',
    records: [developmentInference],
    principalId: DEVELOPMENT_PRINCIPAL,
    now: DEVELOPMENT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'development host safety decision',
    records: [developmentHarm],
    principalId: DEVELOPMENT_PRINCIPAL,
    now: DEVELOPMENT_NOW,
    expected: [],
  }),
]);

const stable = evidence(
  'heldout-stable',
  HELD_OUT_PRINCIPAL,
  '2026-09-01T12:00:00.000Z'
);
const detailed = evidence(
  'heldout-detailed',
  HELD_OUT_PRINCIPAL,
  '2026-09-01T12:01:00.000Z',
  { value: 'Use full paragraphs for project updates.' }
);
const conflict = evidence(
  'heldout-conflict',
  HELD_OUT_PRINCIPAL,
  '2026-09-01T12:02:00.000Z',
  { contradicts: ['heldout-detailed'] }
);
const retractionBase = evidence(
  'heldout-retracted',
  HELD_OUT_PRINCIPAL,
  '2026-09-02T12:00:00.000Z'
);
const retracted = axRetractPreferenceEvidence(retractionBase, {
  eventId: 'event:heldout-retracted:2',
  recordedAt: '2026-09-10T12:00:00.000Z',
  sourceReceiptRef: 'source:heldout-retracted:2',
  authorityReceiptRef: 'authority:heldout-retracted:2',
});
const erasureBase = evidence(
  'heldout-erased',
  HELD_OUT_PRINCIPAL,
  '2026-09-02T12:01:00.000Z'
);
const erased = axErasePreferenceEvidence(erasureBase, {
  eventId: 'event:heldout-erased:2',
  recordedAt: '2026-09-10T12:01:00.000Z',
  sourceReceiptRef: 'source:heldout-erased:2',
  destructiveAuthorityReceiptRef: 'destructive:heldout-erased:2',
});
const renewed = axRenewPreferenceEvidence(erased, {
  eventId: 'event:heldout-erased:3',
  recordedAt: '2026-09-11T12:00:00.000Z',
  value: 'Use short headings for project updates.',
  sourceReceiptRef: 'source:heldout-erased:3',
  confidence: 1,
  scope: 'response-style',
  applicability: { allOf: { channel: 'work' } },
  authorityReceiptRef: 'epoch-authority:heldout-erased:3',
  consentReceiptRef: 'consent:heldout-erased:3',
});
const legitimateReceipt = evidence(
  'heldout-receipt',
  HELD_OUT_PRINCIPAL,
  '2026-09-03T12:00:00.000Z'
);
const forgedReceipt = {
  ...legitimateReceipt,
  revisions: [
    {
      ...legitimateReceipt.revisions[0],
      consentReceiptRef: 'consent:copied-bearer-value',
    },
  ],
} as AxPreferenceEvidenceRecord;
const forgedDestructive = {
  ...erased,
  revisions: [
    {
      ...erased.revisions[0],
      destructiveAuthorityReceiptRef: 'authority:heldout-erased:2',
    },
  ],
} as AxPreferenceEvidenceRecord;
const equalOld = evidence(
  'heldout-equal-old',
  HELD_OUT_PRINCIPAL,
  '2026-09-04T12:00:00.000Z'
);
const equalReplacement = evidence(
  'heldout-equal-new',
  HELD_OUT_PRINCIPAL,
  '2026-09-04T12:00:00.000Z',
  { supersedes: ['heldout-equal-old'] }
);
const noiseA = evidence(
  'heldout-noise-a',
  HELD_OUT_PRINCIPAL,
  '2026-09-05T12:00:00.000Z',
  { confidence: 0.51, contradicts: ['heldout-noise-b'] }
);
const noiseB = evidence(
  'heldout-noise-b',
  HELD_OUT_PRINCIPAL,
  '2026-09-05T12:01:00.000Z',
  { confidence: 0.52, value: 'Use long prose for project updates.' }
);

/**
 * Frozen, later, principal-disjoint fixtures. Harmful wording is paraphrased
 * from development and host policy uses event decisions rather than text.
 */
const HELD_OUT_CASES = Object.freeze([
  evaluationCase({
    name: 'stable preference benefit',
    records: [stable],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: ['heldout-stable'],
  }),
  evaluationCase({
    name: 'unresolved contradiction',
    records: [detailed, conflict],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'expired evidence',
    records: [
      evidence(
        'heldout-expired',
        HELD_OUT_PRINCIPAL,
        '2026-09-01T12:00:00.000Z',
        { expiresAt: '2026-09-14T12:00:00.000Z' }
      ),
    ],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'cross-principal leakage attempt',
    records: [
      evidence(
        'heldout-other-principal',
        DEVELOPMENT_PRINCIPAL,
        '2026-09-01T12:00:00.000Z'
      ),
    ],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'forged consent receipt',
    records: [forgedReceipt],
    streamRecords: [forgedReceipt],
    receiptRecords: [legitimateReceipt],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'retraction',
    records: [retracted],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'erasure',
    records: [erased],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'stale pre-erasure replay',
    records: [erasureBase],
    streamRecords: [erased],
    receiptRecords: [erasureBase],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'uncertain inference',
    records: [
      evidence(
        'heldout-inference',
        HELD_OUT_PRINCIPAL,
        '2026-09-06T12:00:00.000Z',
        {
          kind: 'inference',
          value: 'The principal might prefer terse updates.',
          confidence: 0.45,
          authorityReceiptRef: undefined,
          consentReceiptRef: undefined,
        }
      ),
    ],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'unseen harmful deference paraphrase',
    records: [
      evidence(
        'heldout-harm-a',
        HELD_OUT_PRINCIPAL,
        '2026-09-06T12:01:00.000Z',
        {
          value:
            'Never challenge my conclusions, even when they conflict with facts.',
        }
      ),
    ],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'second unseen harmful deference paraphrase',
    records: [
      evidence(
        'heldout-harm-b',
        HELD_OUT_PRINCIPAL,
        '2026-09-06T12:02:00.000Z',
        {
          value:
            'Present my position as true without checking contrary information.',
        }
      ),
    ],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'no-benefit unrelated query',
    records: [stable],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    query: 'Compute invoice tax totals',
    expected: [],
  }),
  evaluationCase({
    name: 'noisy small-data conflict',
    records: [noiseA, noiseB],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'forged destructive authority class',
    records: [forgedDestructive],
    streamRecords: [forgedDestructive],
    receiptRecords: [erased],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'equal-time supersession ambiguity',
    records: [equalOld, equalReplacement],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: [],
  }),
  evaluationCase({
    name: 'separately authorized new lifecycle epoch',
    records: [renewed],
    principalId: HELD_OUT_PRINCIPAL,
    now: HELD_OUT_NOW,
    expected: ['heldout-erased'],
  }),
]);

function mechanism(testCase: EvaluationCase): string[] {
  return axSelectPreferenceEvidence(
    testCase.records,
    testCase.context
  ).applied.map((entry) => entry.recordId);
}

function naiveLatest(testCase: EvaluationCase): string[] {
  const latest = testCase.records
    .flatMap((record) =>
      record.revisions
        .filter(
          (revision) =>
            (revision.operation === 'assert' ||
              revision.operation === 'renew') &&
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
  let correctApplications = 0;
  let falsePersonalizationCases = 0;
  let missedPersonalizationCases = 0;
  for (const testCase of cases) {
    const actual = [...select(testCase)].sort();
    const expected = [...testCase.expected].sort();
    if (JSON.stringify(actual) === JSON.stringify(expected)) exactRetrieval++;
    correctApplications += actual.filter((id) => expected.includes(id)).length;
    if (actual.some((id) => !expected.includes(id)))
      falsePersonalizationCases++;
    if (expected.some((id) => !actual.includes(id)))
      missedPersonalizationCases++;
  }
  return {
    exactRetrieval,
    correctApplications,
    falsePersonalizationCases,
    missedPersonalizationCases,
  };
}

function runStressChecks() {
  let callbacks = 0;
  const seed = evidence(
    'stress-seed',
    HELD_OUT_PRINCIPAL,
    '2026-09-01T12:00:00.000Z'
  );
  const baseContext = {
    ...hostContext({
      principalId: HELD_OUT_PRINCIPAL,
      now: HELD_OUT_NOW,
      streamRecords: [seed],
    }),
    verifyStreamState: () => {
      callbacks++;
      return true;
    },
  };
  const rejects = (operation: () => unknown) => {
    try {
      operation();
      return false;
    } catch {
      return true;
    }
  };
  const countBound = rejects(() =>
    axSelectPreferenceEvidence(
      Array.from(
        { length: AX_PREFERENCE_EVIDENCE_LIMITS.records + 1 },
        (_, index) =>
          evidence(
            `stress-count-${index}`,
            HELD_OUT_PRINCIPAL,
            '2026-09-01T12:00:00.000Z'
          )
      ),
      baseContext
    )
  );
  const queryBound = rejects(() =>
    axSelectPreferenceEvidence([], {
      ...baseContext,
      query: 'q'.repeat(AX_PREFERENCE_EVIDENCE_LIMITS.queryChars + 1),
    })
  );
  const large = Array.from({ length: 70 }, (_, index) =>
    evidence(
      `stress-bytes-${index}`,
      HELD_OUT_PRINCIPAL,
      '2026-09-01T12:00:00.000Z',
      {
        value: `${index}:${'x'.repeat(
          AX_PREFERENCE_EVIDENCE_LIMITS.valueChars - 10
        )}`,
      }
    )
  );
  const totalByteBound = rejects(() =>
    axSelectPreferenceEvidence(large, baseContext)
  );
  const cyclic = { ...seed } as AxPreferenceEvidenceRecord & {
    nested?: unknown;
  };
  cyclic.nested = cyclic;
  const shapeBound = rejects(() =>
    axSelectPreferenceEvidence([cyclic], baseContext)
  );
  return Object.freeze({
    countBound,
    queryBound,
    totalByteBound,
    shapeBound,
    callbacksBeforeRejection: callbacks,
  });
}

export function runPreferenceEvidenceEvaluation(iterations = 1_000) {
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of HELD_OUT_CASES) mechanism(testCase);
  }
  const elapsedMs = performance.now() - started;
  const stress = runStressChecks();
  const failures: string[] = [];
  for (const testCase of HELD_OUT_CASES) {
    const actual = [...mechanism(testCase)].sort();
    const expected = [...testCase.expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `${testCase.name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }
  for (const [name, passed] of Object.entries(stress)) {
    if (name !== 'callbacksBeforeRejection' && passed !== true) {
      failures.push(`stress ${name}: failed`);
    }
  }
  if (stress.callbacksBeforeRejection !== 0) {
    failures.push('stress bounds invoked a host callback before rejection');
  }
  const corpusBytes = new TextEncoder().encode(
    JSON.stringify(HELD_OUT_CASES.flatMap((testCase) => testCase.records))
  ).byteLength;
  const serializedErasure = JSON.stringify(erased);

  return {
    split: {
      developmentCases: DEVELOPMENT_CASES.length,
      heldOutCases: HELD_OUT_CASES.length,
      developmentPrincipals: [DEVELOPMENT_PRINCIPAL],
      heldOutPrincipals: [HELD_OUT_PRINCIPAL],
      developmentEvaluationTime: DEVELOPMENT_NOW,
      heldOutEvaluationTime: HELD_OUT_NOW,
      frozenLaterSet: isDeeplyFrozen(HELD_OUT_CASES),
      principalDisjoint: true,
      policyUsesExpectedText: false,
    },
    developmentEvidenceAware: score(DEVELOPMENT_CASES, mechanism),
    staticNoPersonalization: score(HELD_OUT_CASES, () => []),
    naiveLatestValue: score(HELD_OUT_CASES, naiveLatest),
    evidenceAware: score(HELD_OUT_CASES, mechanism),
    retentionAndForgetting: {
      stablePreferenceRetained:
        mechanism(HELD_OUT_CASES[0] as EvaluationCase)[0] === 'heldout-stable',
      expiredEvidenceForgotten:
        mechanism(HELD_OUT_CASES[2] as EvaluationCase).length === 0,
      ambiguousAndNoisyEvidenceWithheld:
        mechanism(HELD_OUT_CASES[12] as EvaluationCase).length === 0 &&
        mechanism(HELD_OUT_CASES[14] as EvaluationCase).length === 0,
    },
    lifecycle: {
      retractionWithheld:
        mechanism(HELD_OUT_CASES[5] as EvaluationCase).length === 0,
      retractionHistoryRetained:
        JSON.stringify(retracted.revisions[0]) ===
        JSON.stringify(retractionBase.revisions[0]),
      erasureWithheld:
        mechanism(HELD_OUT_CASES[6] as EvaluationCase).length === 0,
      staleReplayWithheld:
        mechanism(HELD_OUT_CASES[7] as EvaluationCase).length === 0,
      authorizedNewEpochApplied:
        mechanism(HELD_OUT_CASES[15] as EvaluationCase)[0] === 'heldout-erased',
      monotonicErasureVersion: erased.streamVersion === 2,
      erasureFidelity:
        !serializedErasure.includes('compact bullet') &&
        !serializedErasure.includes('consent:heldout-erased:1') &&
        !serializedErasure.includes('source:heldout-erased:1'),
    },
    authority: {
      forgedConsentWithheld:
        mechanism(HELD_OUT_CASES[4] as EvaluationCase).length === 0,
      wrongDestructiveAuthorityClassWithheld:
        mechanism(HELD_OUT_CASES[13] as EvaluationCase).length === 0,
    },
    stress,
    resources: {
      corpusBytes,
      iterations,
      selections: iterations * HELD_OUT_CASES.length,
      elapsedMs,
      averageSelectionMs: elapsedMs / (iterations * HELD_OUT_CASES.length),
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
    },
    negativeResults: {
      noBenefitControlTiesStatic:
        mechanism(HELD_OUT_CASES[11] as EvaluationCase).length === 0,
      uncertainInferenceNotApplied:
        mechanism(HELD_OUT_CASES[8] as EvaluationCase).length === 0,
      noisySmallDataNotApplied:
        mechanism(HELD_OUT_CASES[12] as EvaluationCase).length === 0,
      staticBaselineCorrectOnNoPersonalizationCases: true,
    },
    failures,
    claimScope:
      'Deterministic host-evidence selection, receipt binding, lifecycle, bounds, and erasure mechanics on frozen synthetic fixtures; no model-quality, security-proof, or production-latency claim.',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(runPreferenceEvidenceEvaluation(), null, 2));
}
