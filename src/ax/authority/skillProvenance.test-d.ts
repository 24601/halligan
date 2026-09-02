// Compile-time contract for the skill-provenance surface, enforced by
// `npm run test:type-tests`.
import type {
  AxSkillPreconditionFailureKind,
  AxSkillPreconditionPolicy,
  AxSkillProvenance,
} from '../index.js';

declare const provenance: AxSkillProvenance;

// Every field is readonly by construction.
// @ts-expect-error provenance facts are frozen at the type level
provenance.leaseEpoch = 2;
// @ts-expect-error the effect list is readonly
provenance.effects.push({
  effectId: 'e',
  operation: 'o',
  requestDigest: 'd',
  status: 'succeeded',
  replaySafety: 'unknown',
});

// The policy record covers every failure kind and nothing else.
const complete: AxSkillPreconditionPolicy = {
  effect_unsettled: 'downgrade',
  environment_drift: 'park',
  grant_revoked: 'drop',
  lease_epoch_changed: 'downgrade',
  malformed_provenance: 'park',
  provenance_truncated: 'downgrade',
  verifier_decision_changed: 'drop',
  verifier_decision_missing: 'park',
};
void complete;

// `'admit'` is not expressible: a policy can only tighten.
// @ts-expect-error admit is not a policy outcome
const admitting: AxSkillPreconditionPolicy = { grant_revoked: 'admit' };
void admitting;

// @ts-expect-error unknown failure kinds are not policy keys
const unknownKind: AxSkillPreconditionPolicy = { not_a_kind: 'drop' };
void unknownKind;

const kind: AxSkillPreconditionFailureKind = 'grant_revoked';
void kind;
