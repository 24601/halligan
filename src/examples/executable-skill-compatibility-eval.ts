import {
  type AxExecutableSkillArtifact,
  type AxExecutableSkillContext,
  axExecutableSkillRef,
  axSelectExecutableSkills,
} from '@ax-llm/ax';

const noop = () => undefined;

const skill = (
  id: string,
  version: string,
  description: string,
  overrides: Partial<AxExecutableSkillArtifact> = {}
): AxExecutableSkillArtifact => ({
  id,
  version,
  name: id.replaceAll('-', ' '),
  description,
  function: { name: id.replaceAll('-', '_'), description, func: noop },
  provenance: { source: 'controlled-eval-fixture' },
  ...overrides,
});

const catalog: readonly unknown[] = [
  skill('send-email-legacy', '1', 'Send an email message with SMTP', {
    requirements: {
      tools: ['smtp.send@1'],
      environments: ['mail-host@1'],
      capabilities: ['network'],
      authorities: ['email.send'],
    },
    verifierReceiptRefs: ['eval://mail/v1'],
    knownFailureModes: ['Uses the retired SMTP v1 envelope'],
  }),
  skill('send-email', '2', 'Send an email message with SMTP', {
    requirements: {
      tools: ['smtp.send@2'],
      environments: ['mail-host@2'],
      protocols: ['smtp-envelope@2'],
      capabilities: ['network'],
      authorities: ['email.send'],
    },
    verifierReceiptRefs: ['eval://mail/v2'],
  }),
  skill('send-email-forged', '99', 'Send an email message with SMTP fastest', {
    provenance: { source: 'model-claimed-trusted-registry' },
    verifierReceiptRefs: ['model://self-certified'],
  }),
  skill('export-report', '1', 'Export a report as CSV', {
    requirements: { capabilities: ['report.read'] },
  }),
  skill('rotate-token', '1', 'Rotate an API token', {
    requirements: { authorities: ['token.rotate'] },
  }),
  skill('old-calendar', '1', 'Create a calendar event', {
    lifecycle: 'deprecated',
  }),
  skill('temporary-upload', '1', 'Upload a temporary file', {
    expiresAt: '2026-08-24T00:00:00Z',
  }),
  skill('superseded-search', '1', 'Search the documentation', {
    supersededBy: 'search-docs@2',
  }),
  { name: 'legacy prompt guide', content: 'not an executable artifact' },
];

type Case = {
  name: string;
  query: string;
  expected?: string;
  context: AxExecutableSkillContext;
};

const base = {
  admittedArtifacts: [
    'send-email-legacy@1',
    'send-email@2',
    'export-report@1',
    'rotate-token@1',
    'old-calendar@1',
    'temporary-upload@1',
    'superseded-search@1',
  ],
  now: '2026-08-25T00:00:00Z',
} as const;

const cases: Case[] = [
  {
    name: 'held-out tool/environment/protocol change',
    query: 'send email message smtp',
    expected: 'send-email@2',
    context: {
      ...base,
      tools: ['smtp.send@2'],
      environment: 'mail-host@2',
      protocols: ['smtp-envelope@2'],
      capabilities: ['network'],
      authorities: ['email.send'],
      acceptedVerifierReceiptRefs: ['eval://mail/v2'],
    },
  },
  {
    name: 'no-benefit unchanged context',
    query: 'export report csv',
    expected: 'export-report@1',
    context: { ...base, capabilities: ['report.read'] },
  },
  {
    name: 'missing capability',
    query: 'export report csv',
    context: base,
  },
  {
    name: 'missing authority',
    query: 'rotate api token',
    context: base,
  },
  {
    name: 'deprecated exclusion',
    query: 'create calendar event',
    context: base,
  },
  {
    name: 'expiry exclusion',
    query: 'upload temporary file',
    context: base,
  },
  {
    name: 'superseded exclusion',
    query: 'search documentation',
    context: base,
  },
];

const terms = (value: string) =>
  new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);

function naiveRetrieve(query: string): AxExecutableSkillArtifact | undefined {
  const queryTerms = terms(query);
  return catalog
    .filter(
      (entry): entry is AxExecutableSkillArtifact =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as AxExecutableSkillArtifact).id === 'string'
    )
    .map((entry) => ({
      entry,
      score: [...queryTerms].filter((term) =>
        terms(`${entry.id} ${entry.name} ${entry.description}`).has(term)
      ).length,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        axExecutableSkillRef(left.entry).localeCompare(
          axExecutableSkillRef(right.entry)
        )
    )[0]?.entry;
}

const startedAt = performance.now();
let naiveLatencyMs = 0;
let awareLatencyMs = 0;
let naiveCorrect = 0;
let awareCorrect = 0;
let naiveFalseApplications = 0;
let awareFalseApplications = 0;
const results = cases.map((testCase) => {
  const naiveStartedAt = performance.now();
  const naive = naiveRetrieve(testCase.query);
  naiveLatencyMs += performance.now() - naiveStartedAt;
  const awareStartedAt = performance.now();
  const aware = axSelectExecutableSkills(catalog, testCase.context, {
    query: testCase.query,
    topK: 1,
  });
  awareLatencyMs += performance.now() - awareStartedAt;
  const naiveId = naive ? axExecutableSkillRef(naive) : undefined;
  const awareId = aware.artifacts[0]
    ? axExecutableSkillRef(aware.artifacts[0])
    : undefined;
  const expected = testCase.expected;
  if (naiveId === expected) naiveCorrect++;
  if (awareId === expected) awareCorrect++;
  if (naiveId !== undefined && naiveId !== expected) naiveFalseApplications++;
  if (awareId !== undefined && awareId !== expected) awareFalseApplications++;
  return { name: testCase.name, expected, naive: naiveId, aware: awareId };
});
const latencyMs = performance.now() - startedAt;

const metrics = {
  cases: cases.length,
  naiveCorrect,
  awareCorrect,
  naiveFalseApplications,
  awareFalseApplications,
  noBenefitPreserved:
    results.find((result) => result.name === 'no-benefit unchanged context')
      ?.naive === 'export-report@1' &&
    results.find((result) => result.name === 'no-benefit unchanged context')
      ?.aware === 'export-report@1',
  malformedInspected: axSelectExecutableSkills(catalog, base).inspection.some(
    (entry) => entry.reasons.includes('malformed')
  ),
  artifactBytes: Buffer.byteLength(
    JSON.stringify(catalog, (_key, value) =>
      typeof value === 'function' ? '[host function]' : value
    )
  ),
  selectionContextBytes: Buffer.byteLength(JSON.stringify(cases)),
  promptBytes: 0,
  naiveLatencyMs: Number(naiveLatencyMs.toFixed(3)),
  compatibilityAwareLatencyMs: Number(awareLatencyMs.toFixed(3)),
  totalLatencyMs: Number(latencyMs.toFixed(3)),
};

if (
  awareCorrect !== cases.length ||
  awareFalseApplications !== 0 ||
  !metrics.noBenefitPreserved ||
  !metrics.malformedInspected
) {
  throw new Error(
    `compatibility evaluation failed: ${JSON.stringify(metrics)}`
  );
}

console.log(JSON.stringify({ metrics, results }, null, 2));
