// Mechanism-only example: no provider, no API key, no network.
//
// Every learned artifact halligan produces is a distillation of a trajectory
// that ran under a specific authority. This shows that authority being recorded
// at distillation time and re-checked at retrieval time, on both paths that
// gate on it: host-owned executable skill artifacts, and the static skill
// catalog.

import {
  type AxAgentCatalogSkill,
  type AxExecutableSkillArtifact,
  type AxSkillAuthoritySnapshot,
  axExtractSkillProvenance,
  axRecheckSkillProvenance,
  axSelectCatalogSkills,
  axSelectExecutableSkills,
  axSkillPreconditionExecutableDefaults,
} from '@ax-llm/ax';

const NOW = '2026-01-01T00:00:00.000Z';
const LEASE_EPOCH = 4;

/** Deterministically derived from the effect ledger and the receipts. No LLM. */
const provenance = axExtractSkillProvenance({
  effects: [
    {
      id: 'effect-1',
      deliveryId: 'delivery-1',
      runId: 'run-1',
      identityScope: 'tenant-a',
      operation: 'files.read',
      idempotencyKey: 'key-1',
      replaySafety: 'idempotent',
      requestDigest: 'sha256:0f2a',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 1,
      dispatchCount: 1,
      version: 1,
    },
  ],
  receipts: [
    {
      version: 1,
      receiptId: 'receipt-1',
      requestId: 'request-1',
      decision: 'allow',
      operation: 'files.read',
      resource: { type: 'file', id: 'report.csv' },
      principalId: 'principal:alice',
      actor: { id: 'agent:reporter', kind: 'agent' },
      grantIds: ['grant:files.read'],
      leaseEpoch: LEASE_EPOCH,
      authorizedAt: 2,
    },
  ],
  environment: { sandbox: 'true' },
  leaseEpoch: LEASE_EPOCH,
  capturedAt: NOW,
});

console.log('provenance digest:', provenance.digest);
console.log('host grants recorded:', provenance.hostGrants);

// 1. Executable skill artifacts. The default for something that executes is to
//    PARK, not to downgrade: an executable artifact has no advisory mode.
const artifact = (id: string): AxExecutableSkillArtifact => ({
  id,
  version: '1',
  name: `Artifact ${id}`,
  description: 'Reads a report file',
  functionRef: 'functions/read-report/1',
  verification: { mode: 'receiptless' },
  authorityProvenance: provenance,
});

const held: AxSkillAuthoritySnapshot = {
  grantIds: ['grant:files.read'],
  leaseEpoch: LEASE_EPOCH,
};
const revoked: AxSkillAuthoritySnapshot = {
  grantIds: [],
  leaseEpoch: LEASE_EPOCH,
};

const selectFor = (snapshot: AxSkillAuthoritySnapshot) =>
  axSelectExecutableSkills(
    [artifact('read-report')],
    {
      admittedArtifacts: [{ id: 'read-report', version: '1' }],
      principal: 'principal:alice',
      audience: 'agent:reporter',
      now: NOW,
      authoritySnapshot: snapshot,
      resolveFunction: () => ({
        name: 'readReport',
        description: 'Read the report',
        parameters: { type: 'object', properties: {} },
        func: async () => ({ rows: 3 }),
      }),
    },
    { topK: 1 }
  );

const stillHeld = selectFor(held);
const noLongerHeld = selectFor(revoked);

console.log(
  'executable, grant still held ->',
  stillHeld.artifacts.length,
  'selected;',
  stillHeld.inspection[0]?.provenance?.outcome
);
console.log(
  'executable, grant revoked ->',
  noLongerHeld.artifacts.length,
  'selected;',
  noLongerHeld.inspection[0]?.provenance?.outcome,
  JSON.stringify(noLongerHeld.inspection[0]?.provenance?.failures)
);

// The check carries failure KINDS and COUNTS only — never an id or a value.
console.log(
  'executable defaults, direct check ->',
  JSON.stringify(
    axRecheckSkillProvenance(
      provenance,
      revoked,
      axSkillPreconditionExecutableDefaults,
      NOW
    )
  )
);

// 2. The catalog path. Guidance defaults to DOWNGRADE: it is rendered with a
//    deterministic, value-free advisory instead of vanishing, because the
//    failure being defended against is silent reuse, not reuse.
const catalog: AxAgentCatalogSkill[] = [
  {
    id: 'report-runbook',
    name: 'Report runbook',
    description: 'How to assemble the weekly report',
    content: 'Read report.csv, group by region, then summarize.',
    tier: 'kernel',
    tokenEstimate: 20,
    authorityProvenance: provenance,
  },
  {
    id: 'glossary',
    name: 'Glossary',
    description: 'Terms used across reports',
    content: 'ARR, churn, expansion.',
    tier: 'kernel',
    tokenEstimate: 20,
  },
  {
    id: 'zz-appendix',
    name: 'Appendix',
    description: 'Rarely needed, and last by id',
    content: 'Historical definitions.',
    tier: 'kernel',
    tokenEstimate: 20,
  },
  {
    id: 'shell-tricks',
    name: 'Shell tricks',
    description: 'Requires jq, which this host does not have',
    content: 'Pipe the CSV through jq.',
    requires: { bins: ['jq'] },
  },
];

const selection = axSelectCatalogSkills(catalog, {
  environment: { bins: ['rg'], os: 'darwin' },
  kernelTokenBudget: 40,
  authority: revoked,
  now: NOW,
});

console.log(
  'kernel:',
  selection.kernel.map((skill) => ({ id: skill.id, advisory: skill.advisory }))
);
console.log(
  'index:',
  selection.index.map((entry) => entry.id)
);
console.log('hidden (ineligible, with the diagnosis):', selection.hidden);
console.log('overflow (demoted by the token budget):', selection.overflow);
console.log(
  'decisions:',
  selection.decisions.map((decision) => ({
    id: decision.id,
    outcome: decision.check.outcome,
  }))
);
