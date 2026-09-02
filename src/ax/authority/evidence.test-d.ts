import {
  type AxCapabilityGrant,
  type AxEvidenceMatch,
  type AxEvidenceObservation,
  type AxEvidenceRequirement,
  type AxGuardEvaluation,
  type AxGuardFailure,
  axCollectGrantRequirements,
  axEvaluateGuards,
  axIsEvidenceRequirement,
  axIsGuardPredicateFailure,
} from '../index.js';

const observation: AxEvidenceObservation = {
  version: 1,
  kind: 'session.mfa',
  sourceId: 'idp-a',
  observedAt: 10_000,
  value: 'strong',
  leaseEpoch: 3,
};

// The match union narrows on `op`.
const equals: AxEvidenceMatch = { op: 'eq', value: 'strong' };
const oneOf: AxEvidenceMatch = { op: 'in', values: ['strong', 'hardware'] };
const substring: AxEvidenceMatch = { op: 'contains', value: 'stro' };
const fresh: AxEvidenceMatch = { op: 'fresh' };
void [equals, oneOf, substring, fresh];

// @ts-expect-error `fresh` carries no value; freshness is `maxAgeMs`.
const freshWithValue: AxEvidenceMatch = { op: 'fresh', value: 1 };
void freshWithValue;

// @ts-expect-error `in` takes `values`, never a single `value`.
const inWithValue: AxEvidenceMatch = { op: 'in', value: 1 };
void inWithValue;

// @ts-expect-error `sameAs` was cut from the algebra and must stay uncallable.
const sameAs: AxEvidenceMatch = { op: 'sameAs', kind: 'session.mfa' };
void sameAs;

// @ts-expect-error `contains` compares against a string needle only.
const containsNumber: AxEvidenceMatch = { op: 'contains', value: 1 };
void containsNumber;

const requirement: AxEvidenceRequirement = {
  kind: 'session.mfa',
  trustedSources: ['idp-a'],
  maxAgeMs: 60_000,
  match: fresh,
};

const grant: AxCapabilityGrant = {
  version: 1,
  id: 'grant',
  principalId: 'subject',
  operations: ['document.read'],
  resources: [{ type: 'document', id: 'doc-1' }],
  leaseEpoch: 3,
  requirements: [requirement],
};

const collected: readonly Readonly<AxEvidenceRequirement>[] =
  axCollectGrantRequirements([grant]);

const evaluation: Readonly<AxGuardEvaluation> = axEvaluateGuards({
  operation: 'document.read',
  resource: { type: 'document', id: 'doc-1' },
  requirements: collected,
  evidence: [observation],
  leaseEpoch: 3,
  now: 10_000,
});
void evaluation.allow;

const failure: Readonly<AxGuardFailure> | undefined = evaluation.failures[0];
void failure;

// A failure carries op, kind, and code only — there is no value channel.
// @ts-expect-error
void failure?.value;

void axIsEvidenceRequirement(requirement);
void axIsGuardPredicateFailure(new Error('denied'));
