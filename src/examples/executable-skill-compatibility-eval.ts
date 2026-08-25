import {
  type AxExecutableSkillArtifact,
  type AxExecutableSkillAuthority,
  type AxExecutableSkillContext,
  axSelectExecutableSkills,
} from '@ax-llm/ax';

const noop = () => undefined;
const principal = 'principal:eval';
const audience = 'agent:eval';
const functionRegistry = new Map<string, () => undefined>();
const tokenAuthority: AxExecutableSkillAuthority = {
  issuer: 'auth.eval',
  audience,
  principal,
  resource: 'token:production',
  action: 'rotate',
};
const emailAuthority: AxExecutableSkillAuthority = {
  issuer: 'auth.eval',
  audience,
  principal,
  resource: 'mailbox:eval',
  action: 'send',
};

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
  functionRef: `functions/${id}/${version}`,
  verification: { mode: 'receiptless' },
  provenance: { source: 'controlled-eval-fixture' },
  ...overrides,
});

const catalog: readonly unknown[] = [
  skill('send-email-legacy', '1', 'Send an email message with SMTP', {
    requirements: {
      tools: ['smtp.send@1'],
      environments: ['mail-host@1'],
      capabilities: ['network'],
      authorities: [emailAuthority],
    },
    verification: {
      mode: 'required',
      evaluation: 'mail-compatibility-v1',
      receiptRefs: ['receipt:mail:v1'],
      issuers: ['eval.example'],
    },
    knownFailureModes: ['Uses the retired SMTP v1 envelope'],
  }),
  skill('send-email', '2', 'Send an email message with SMTP', {
    requirements: {
      tools: ['smtp.send@2'],
      environments: ['mail-host@2'],
      protocols: ['smtp-envelope@2'],
      capabilities: ['network'],
      authorities: [emailAuthority],
    },
    verification: {
      mode: 'required',
      evaluation: 'mail-compatibility-v2',
      receiptRefs: ['receipt:mail:v2'],
      issuers: ['eval.example'],
    },
  }),
  skill('send-email-forged', '99', 'Send an email message with SMTP fastest', {
    provenance: { source: 'model-claimed-trusted-registry' },
    verification: {
      mode: 'required',
      evaluation: 'model-self-certified',
      receiptRefs: ['model://self-certified'],
      issuers: ['model.example'],
    },
  }),
  skill('export-report', '1', 'Export a report as CSV', {
    requirements: { capabilities: ['report.read'] },
  }),
  skill('rotate-token', '1', 'Rotate an API token', {
    requirements: { authorities: [tokenAuthority] },
  }),
  skill('old-calendar', '1', 'Create a calendar event', {
    lifecycle: 'deprecated',
  }),
  skill('temporary-upload', '1', 'Upload a temporary file', {
    expiresAt: '2026-08-24T00:00:00.000Z',
  }),
  skill('superseded-search', '1', 'Search the documentation', {
    supersededBy: { id: 'search-docs', version: '2' },
  }),
  {
    id: 'legacy-upload',
    version: '1',
    name: 'legacy upload',
    description: 'Upload a legacy file',
    function: noop,
  },
];

for (const entry of catalog) {
  if (
    entry &&
    typeof entry === 'object' &&
    typeof (entry as AxExecutableSkillArtifact).functionRef === 'string'
  ) {
    functionRegistry.set(
      (entry as AxExecutableSkillArtifact).functionRef,
      noop
    );
  }
}

type Case = {
  name: string;
  query: string;
  expected?: string;
  context: AxExecutableSkillContext;
};

const base = {
  admittedArtifacts: [
    { id: 'send-email-legacy', version: '1' },
    { id: 'send-email', version: '2' },
    { id: 'export-report', version: '1' },
    { id: 'rotate-token', version: '1' },
    { id: 'old-calendar', version: '1' },
    { id: 'temporary-upload', version: '1' },
    { id: 'superseded-search', version: '1' },
  ],
  principal,
  audience,
  now: '2026-08-25T00:00:00.000Z',
  resolveFunction: (ref: string) => {
    const handler = functionRegistry.get(ref);
    return handler
      ? { name: ref.replaceAll('/', '_'), description: ref, func: handler }
      : undefined;
  },
} as const;

const cases: Case[] = [
  {
    name: 'tool/environment/protocol change',
    query: 'send email message smtp',
    expected: 'send-email@2',
    context: {
      ...base,
      tools: ['smtp.send@2'],
      environment: 'mail-host@2',
      protocols: ['smtp-envelope@2'],
      capabilities: ['network'],
      grantedAuthorities: [emailAuthority],
      verifiedReceipts: [
        {
          ref: 'receipt:mail:v2',
          artifact: { id: 'send-email', version: '2' },
          principal,
          issuer: 'eval.example',
          audience,
          evaluation: 'mail-compatibility-v2',
          verifiedAt: '2026-08-24T00:00:00.000Z',
          expiresAt: '2026-08-26T00:00:00.000Z',
        },
      ],
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
  {
    name: 'forged model trust metadata exclusion',
    query: 'send email fastest',
    context: base,
  },
  {
    name: 'forged verifier receipt exclusion',
    query: 'send email message smtp',
    context: {
      ...base,
      tools: ['smtp.send@2'],
      environment: 'mail-host@2',
      protocols: ['smtp-envelope@2'],
      capabilities: ['network'],
      grantedAuthorities: [emailAuthority],
      verifiedReceipts: [
        {
          ref: 'receipt:mail:v2',
          artifact: { id: 'send-email', version: '2' },
          principal,
          issuer: 'model.example',
          audience,
          evaluation: 'model-self-certified',
          verifiedAt: '2026-08-24T00:00:00.000Z',
          expiresAt: '2026-08-26T00:00:00.000Z',
        },
      ],
    },
  },
  {
    name: 'malformed legacy artifact exclusion',
    query: 'upload legacy file',
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
        artifactLabel(left.entry).localeCompare(artifactLabel(right.entry))
    )[0]?.entry;
}

const artifactLabel = (
  entry: Pick<AxExecutableSkillArtifact, 'id' | 'version'>
) => `${entry.id}@${entry.version}`;

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
  const naiveId = naive ? artifactLabel(naive) : undefined;
  const awareId = aware.artifacts[0]
    ? artifactLabel(aware.artifacts[0].artifact)
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
