import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  axPreferenceEvidenceLimits as AX_PREFERENCE_EVIDENCE_LIMITS,
  type AxPreferenceEvidenceAssertion,
  type AxPreferenceEvidenceContext,
  type AxPreferenceEvidenceExclusion,
  type AxPreferenceEvidenceReceiptPurpose,
  type AxPreferenceEvidenceReceiptRequest,
  type AxPreferenceEvidenceRecord,
  type AxPreferenceEvidenceRevision,
  axSelectPreferenceEvidence,
} from '../src/ax/agent/preferenceEvidence.js';

type HostReceiptDescriptor = Readonly<{
  receiptRef: string;
  principalId: string;
  eventId: string;
  operationClass: string;
  epoch?: number;
}>;

type ArtifactCase = Readonly<{
  name: string;
  records: readonly AxPreferenceEvidenceRecord[];
  hostStreamRecords?: readonly AxPreferenceEvidenceRecord[];
  hostReceiptRecords?: readonly HostReceiptDescriptor[];
  query?: string;
  attributes?: Readonly<Record<string, string>>;
  expectedApplied: readonly string[];
  expectedFailure: string | null;
}>;

type LaterArtifact = Readonly<{
  schemaVersion: string;
  artifactId: string;
  authoredAt: string;
  mechanismBaselineCommit: string;
  provenance: string;
  expectationsAuthoredAt: string;
  expectationProvenance: string;
  claimScope: string;
  evaluationTime: string;
  principalId: string;
  scope: string;
  defaultQuery: string;
  defaultAttributes: Readonly<Record<string, string>>;
  policyAuthority: Readonly<{
    authorityId: string;
    decisions: Readonly<Record<string, 'allowed' | 'blocked'>>;
  }>;
  expectedFailureDefinitions: Readonly<
    Record<
      string,
      Readonly<{
        exclusions: readonly AxPreferenceEvidenceExclusion[];
        callbacks: CallbackExpectation;
      }>
    >
  >;
  cases: readonly ArtifactCase[];
}>;

type CallbackTrace = Readonly<{
  stream: number;
  receipt: number;
  destructive: number;
  policy: number;
  receiptPurposes: readonly AxPreferenceEvidenceReceiptPurpose[];
}>;

type CallbackExpectation = Readonly<{
  stream: number;
  receipt: number;
  destructive: number;
  policy: number;
  receiptPurposes: readonly AxPreferenceEvidenceReceiptPurpose[];
}>;

type EvaluationCase = Readonly<{
  name: string;
  records: readonly AxPreferenceEvidenceRecord[];
  context: AxPreferenceEvidenceContext;
  expected: readonly string[];
  expectedFailure: string | null;
  expectedExclusions: readonly AxPreferenceEvidenceExclusion[];
  expectedCallbacks: CallbackExpectation;
  trace: {
    stream: number;
    receipt: number;
    destructive: number;
    policy: number;
    receiptPurposes: AxPreferenceEvidenceReceiptPurpose[];
  };
}>;

type ArmResult = Readonly<{
  exactRetrieval: number;
  correctApplications: number;
  falsePersonalizationCases: number;
  missedPersonalizationCases: number;
}>;

const ARTIFACT_PATH = new URL(
  './fixtures/preference-evidence-later-v1.json',
  import.meta.url
);
const ARTIFACT_SHA256 =
  '613da6a2b29256575b872a367021df59b3b2e905192ea6026c4457d354e17f46';
const ARTIFACT_COMMIT = '0b304636348533e62f66ba8067f1fb6d98452081';
const MECHANISM_BASELINE_COMMIT = '8e1152f8974231ea7e81d8078acbd7e84386c438';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function loadArtifact(): Readonly<{
  artifact: LaterArtifact;
  bytes: number;
  digest: string;
}> {
  const raw = readFileSync(ARTIFACT_PATH);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== ARTIFACT_SHA256) {
    throw new Error(
      `Preference evidence artifact digest mismatch: expected ${ARTIFACT_SHA256}, received ${digest}.`
    );
  }
  const artifact = deepFreeze(
    JSON.parse(raw.toString('utf8')) as LaterArtifact
  );
  if (
    artifact.schemaVersion !== '1.1.0' ||
    artifact.artifactId !== 'preference-evidence-later-v1' ||
    artifact.mechanismBaselineCommit !== MECHANISM_BASELINE_COMMIT ||
    artifact.cases.length === 0 ||
    !Number.isFinite(Date.parse(artifact.authoredAt)) ||
    !Number.isFinite(Date.parse(artifact.expectationsAuthoredAt)) ||
    !Number.isFinite(Date.parse(artifact.evaluationTime))
  ) {
    throw new Error('Preference evidence artifact provenance is invalid.');
  }
  return deepFreeze({ artifact, bytes: raw.byteLength, digest });
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

function descriptorPurpose(operationClass: string) {
  if (operationClass === 'provenance') return 'source';
  if (operationClass === 'fresh-consent') return 'consent';
  if (operationClass === 'renew') return 'epoch-authority';
  if (operationClass === 'erase') return 'destructive-lifecycle';
  return operationClass;
}

function descriptorAllows(
  descriptor: HostReceiptDescriptor,
  request: AxPreferenceEvidenceReceiptRequest
): boolean {
  return (
    descriptor.principalId === request.principalId &&
    descriptor.eventId === request.eventId &&
    descriptorPurpose(descriptor.operationClass) === request.purpose &&
    (descriptor.epoch === undefined || descriptor.epoch === request.epoch)
  );
}

function hostContext(
  artifact: LaterArtifact,
  testCase: ArtifactCase,
  trace: EvaluationCase['trace']
): AxPreferenceEvidenceContext {
  const streams = new Map(
    (testCase.hostStreamRecords ?? testCase.records).map((record) => [
      record.streamId,
      JSON.stringify(record),
    ])
  );
  const derivedReceipts = new Map<string, string>();
  for (const record of testCase.records) {
    const latest = record.revisions.at(-1) as AxPreferenceEvidenceRevision;
    for (const [purpose, receiptRef] of refs(latest)) {
      derivedReceipts.set(
        receiptRef,
        receiptKey(requestFor(record, latest, purpose, receiptRef))
      );
    }
  }
  const descriptors = new Map(
    (testCase.hostReceiptRecords ?? []).map((entry) => [
      entry.receiptRef,
      entry,
    ])
  );
  const verifyReceipt = (request: AxPreferenceEvidenceReceiptRequest) => {
    trace.receipt++;
    trace.receiptPurposes.push(request.purpose);
    const descriptor = descriptors.get(request.receiptRef);
    return descriptor
      ? descriptorAllows(descriptor, request)
      : derivedReceipts.get(request.receiptRef) === receiptKey(request);
  };
  return {
    principalId: artifact.principalId,
    query: testCase.query ?? artifact.defaultQuery,
    scope: artifact.scope,
    attributes: testCase.attributes ?? artifact.defaultAttributes,
    now: artifact.evaluationTime,
    verifyStreamState: (request) => {
      trace.stream++;
      return streams.get(request.streamId) === JSON.stringify(request.record);
    },
    verifyReceipt,
    verifyDestructiveLifecycleReceipt: (request) => {
      trace.destructive++;
      return (
        request.purpose === 'destructive-lifecycle' && verifyReceipt(request)
      );
    },
    allowApplication: (revision) => {
      trace.policy++;
      return artifact.policyAuthority.decisions[revision.eventId] === 'allowed';
    },
  };
}

function buildCases(artifact: LaterArtifact): readonly EvaluationCase[] {
  return artifact.cases.map((testCase) => {
    const trace = {
      stream: 0,
      receipt: 0,
      destructive: 0,
      policy: 0,
      receiptPurposes: [] as AxPreferenceEvidenceReceiptPurpose[],
    };
    const failure = testCase.expectedFailure
      ? artifact.expectedFailureDefinitions[testCase.expectedFailure]
      : {
          exclusions: [],
          callbacks: {
            stream: 0,
            receipt: 0,
            destructive: 0,
            policy: 0,
            receiptPurposes: [],
          },
        };
    if (!failure) {
      throw new Error(`Missing expectation for case: ${testCase.name}`);
    }
    return {
      name: testCase.name,
      records: testCase.records,
      context: hostContext(artifact, testCase, trace),
      expected: testCase.expectedApplied,
      expectedFailure: testCase.expectedFailure,
      expectedExclusions: failure.exclusions,
      expectedCallbacks: failure.callbacks,
      trace,
    };
  });
}

function select(testCase: EvaluationCase) {
  return axSelectPreferenceEvidence(testCase.records, testCase.context);
}

function mechanism(testCase: EvaluationCase): string[] {
  return select(testCase).applied.map((entry) => entry.recordId);
}

export function evaluatePreferenceEvidenceExpectation(
  actual: Readonly<{
    applied: readonly string[];
    exclusions: readonly AxPreferenceEvidenceExclusion[];
    callbacks: CallbackTrace;
  }>,
  expected: Readonly<{
    applied: readonly string[];
    exclusions: readonly AxPreferenceEvidenceExclusion[];
    callbacks?: CallbackExpectation;
  }>
): Readonly<{
  applied: boolean;
  exclusions: boolean;
  callbacks: boolean;
  passed: boolean;
}> {
  const same = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const applied = same(
    [...actual.applied].sort(),
    [...expected.applied].sort()
  );
  const exclusions = same(actual.exclusions, expected.exclusions);
  const callbacks = expected.callbacks
    ? same(actual.callbacks, expected.callbacks)
    : true;
  return {
    applied,
    exclusions,
    callbacks,
    passed: applied && exclusions && callbacks,
  };
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
  let correctApplications = 0;
  let falsePersonalizationCases = 0;
  let missedPersonalizationCases = 0;
  for (const testCase of cases) {
    const actual = [...select(testCase)].sort();
    const expected = [...testCase.expected].sort();
    if (JSON.stringify(actual) === JSON.stringify(expected)) exactRetrieval++;
    correctApplications += actual.filter((id) => expected.includes(id)).length;
    if (actual.some((id) => !expected.includes(id))) {
      falsePersonalizationCases++;
    }
    if (expected.some((id) => !actual.includes(id))) {
      missedPersonalizationCases++;
    }
  }
  return {
    exactRetrieval,
    correctApplications,
    falsePersonalizationCases,
    missedPersonalizationCases,
  };
}

function assertion(
  id: string,
  value = 'Use compact bullet points for project updates.'
): AxPreferenceEvidenceAssertion {
  return {
    operation: 'assert',
    revision: 1,
    epoch: 1,
    eventId: `event:${id}:1`,
    kind: 'confirmed-preference',
    value,
    sourceReceiptRef: `source:${id}:1`,
    confidence: 1,
    scope: 'response-style',
    recordedAt: '2031-04-01T12:00:00.000Z',
    authorityReceiptRef: `authority:${id}:1`,
    consentReceiptRef: `consent:${id}:1`,
  };
}

function evidence(id: string, value?: string): AxPreferenceEvidenceRecord {
  return {
    id,
    principalId: 'principal-stress',
    streamId: `stream:${id}`,
    streamVersion: 1,
    epoch: 1,
    revisions: [assertion(id, value)],
  };
}

function runStressChecks() {
  let callbacks = 0;
  const seed = evidence('stress-seed');
  const baseContext: AxPreferenceEvidenceContext = {
    principalId: seed.principalId,
    query: 'Draft a compact project update',
    scope: 'response-style',
    now: '2031-04-18T12:00:00.000Z',
    verifyStreamState: () => {
      callbacks++;
      return true;
    },
    verifyReceipt: () => true,
    verifyDestructiveLifecycleReceipt: () => true,
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
        (_, index) => evidence(`stress-count-${index}`)
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
      `${index}:${'x'.repeat(AX_PREFERENCE_EVIDENCE_LIMITS.valueChars - 10)}`
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

function namedCase(cases: readonly EvaluationCase[], name: string) {
  return cases.find((entry) => entry.name === name) as EvaluationCase;
}

export function runPreferenceEvidenceEvaluation(iterations = 1_000) {
  const loaded = loadArtifact();
  const benchmarkCases = buildCases(loaded.artifact);
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of benchmarkCases) mechanism(testCase);
  }
  const elapsedMs = performance.now() - started;
  const cases = buildCases(loaded.artifact);
  const stress = runStressChecks();
  const caseResults = cases.map((testCase) => {
    const selection = select(testCase);
    const actual = selection.applied.map((entry) => entry.recordId).sort();
    const expected = [...testCase.expected].sort();
    const actualCallbacks = deepFreeze({
      ...testCase.trace,
      receiptPurposes: [...testCase.trace.receiptPurposes],
    });
    const expectation = evaluatePreferenceEvidenceExpectation(
      {
        applied: actual,
        exclusions: selection.excluded,
        callbacks: actualCallbacks,
      },
      {
        applied: expected,
        exclusions: testCase.expectedExclusions,
        callbacks: testCase.expectedFailure
          ? testCase.expectedCallbacks
          : undefined,
      }
    );
    return {
      name: testCase.name,
      expectedApplied: expected,
      actualApplied: actual,
      expectedFailure: testCase.expectedFailure,
      expectedExclusions: testCase.expectedExclusions,
      actualExclusions: selection.excluded,
      expectedCallbacks: testCase.expectedFailure
        ? testCase.expectedCallbacks
        : null,
      actualCallbacks,
      checks: expectation,
      passed: expectation.passed,
    };
  });
  const failures = caseResults
    .filter((result) => !result.passed)
    .map(
      (result) =>
        `${result.name}: expected ${JSON.stringify({ applied: result.expectedApplied, exclusions: result.expectedExclusions, callbacks: result.expectedCallbacks })}, got ${JSON.stringify({ applied: result.actualApplied, exclusions: result.actualExclusions, callbacks: result.actualCallbacks })}`
    );
  for (const [name, passed] of Object.entries(stress)) {
    if (name !== 'callbacksBeforeRejection' && passed !== true) {
      failures.push(`stress ${name}: failed`);
    }
  }
  if (stress.callbacksBeforeRejection !== 0) {
    failures.push('stress bounds invoked a host callback before rejection');
  }
  const stable = namedCase(cases, 'stable useful preference applies');
  const expired = namedCase(cases, 'expired evidence is unavailable');
  const retracted = namedCase(
    cases,
    'authorized retraction removes prior assertion'
  );
  const erased = namedCase(cases, 'erased snapshot exposes tombstone only');
  const replay = namedCase(
    cases,
    'stale pre erasure replay loses to host tombstone'
  );
  const renewal = namedCase(
    cases,
    'authorized post erasure renewal with fresh consent applies'
  );
  const forged = namedCase(
    cases,
    'copied consent and provenance receipt is rejected against host snapshot'
  );
  const wrongDestructive = namedCase(
    cases,
    'wrong destructive authority operation class cannot erase'
  );
  const unrelated = namedCase(
    cases,
    'unrelated query has no benefit from otherwise valid evidence'
  );
  const uncertain = namedCase(
    cases,
    'uncertain inference remains below application threshold'
  );
  const noisy = namedCase(
    cases,
    'noisy weak contradiction does not displace stronger evidence'
  );
  const erasedRecord = erased.records[0] as AxPreferenceEvidenceRecord;
  const resultFor = (name: string) =>
    caseResults.find(
      (entry) => entry.name === name
    ) as (typeof caseResults)[number];

  return {
    artifact: {
      id: loaded.artifact.artifactId,
      path: 'scripts/fixtures/preference-evidence-later-v1.json',
      commit: ARTIFACT_COMMIT,
      sha256: loaded.digest,
      digestVerifiedBeforeParse: true,
      bytes: loaded.bytes,
      authoredAt: loaded.artifact.authoredAt,
      mechanismBaselineCommit: loaded.artifact.mechanismBaselineCommit,
      provenance: loaded.artifact.provenance,
      expectationsAuthoredAt: loaded.artifact.expectationsAuthoredAt,
      expectationProvenance: loaded.artifact.expectationProvenance,
      policyAuthority: loaded.artifact.policyAuthority.authorityId,
      cases: cases.length,
    },
    staticNoPersonalization: score(cases, () => []),
    naiveLatestValue: score(cases, naiveLatest),
    evidenceAware: score(cases, mechanism),
    caseResults,
    reasonCoverage: {
      exactCases: caseResults.filter(({ passed }) => passed).length,
      wrongReasonCases: caseResults.filter(
        ({ checks }) =>
          checks.applied && (!checks.exclusions || !checks.callbacks)
      ).length,
      uncheckedAppliedOnlyCases: caseResults.filter(
        ({ expectedFailure, checks }) => !expectedFailure && !checks.applied
      ).length,
    },
    retentionAndForgetting: {
      stablePreferenceRetained:
        resultFor(stable.name).passed && mechanism(stable)[0] === 'rec-stable',
      expiredEvidenceForgotten:
        resultFor(expired.name).passed && mechanism(expired).length === 0,
    },
    lifecycle: {
      retractionWithheld:
        resultFor(retracted.name).passed && mechanism(retracted).length === 0,
      retractionHistoryRetained:
        (retracted.records[0]?.revisions.length ?? 0) === 2,
      erasureWithheld:
        resultFor(erased.name).passed && mechanism(erased).length === 0,
      staleReplayWithheld:
        resultFor(replay.name).passed && mechanism(replay).length === 0,
      authorizedNewEpochApplied:
        resultFor(renewal.name).passed && mechanism(renewal)[0] === 'rec-renew',
      monotonicErasureVersion: erasedRecord.streamVersion === 2,
      erasureFidelity:
        erasedRecord.revisions.length === 1 &&
        erasedRecord.revisions[0]?.operation === 'erase',
    },
    authority: {
      forgedConsentWithheld:
        resultFor(forged.name).passed && mechanism(forged).length === 0,
      wrongDestructiveAuthorityClassWithheld:
        resultFor(wrongDestructive.name).passed &&
        mechanism(wrongDestructive).length === 0,
    },
    stress,
    resources: {
      artifactBytes: loaded.bytes,
      iterations,
      selections: iterations * cases.length,
      elapsedMs,
      averageSelectionMs: elapsedMs / (iterations * cases.length),
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
    },
    negativeResults: {
      noBenefitControlTiesStatic: mechanism(unrelated).length === 0,
      uncertainInferenceNotApplied: mechanism(uncertain).length === 0,
      noisySmallDataFailurePreserved: !caseResults.find(
        (entry) => entry.name === noisy.name
      )?.passed,
    },
    failures,
    claimScope:
      'Deterministic adversarial mechanism coverage from a separately authored, digest-frozen post-baseline synthetic artifact; no independent personalization-accuracy, model-quality, security-proof, or production-latency claim.',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(runPreferenceEvidenceEvaluation(), null, 2));
}
