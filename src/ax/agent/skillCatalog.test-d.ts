// Compile-time contract for the actor skill view, enforced by
// `npm run test:type-tests`. The `never` fields are the structural boundary:
// an optimizer-facing skill object must not be assignable here.
import type { AxAgentActorSkillView, AxAgentCatalogSkill } from '../index.js';

// A locally-declared compiled-skill shape stands in for the deferred compiler
// types, so this test does not require shipping a public type with no writer.
type CompiledSkill = AxAgentCatalogSkill & {
  purpose: { originBulletIds: readonly string[] };
};

declare const compiled: CompiledSkill;
// @ts-expect-error `purpose?: never` makes an optimizer-facing skill unassignable
const asActor: AxAgentActorSkillView = compiled;
void asActor;

declare const withProvenance: AxAgentCatalogSkill & {
  authorityProvenance: NonNullable<AxAgentCatalogSkill['authorityProvenance']>;
};
// @ts-expect-error host-only provenance cannot reach the actor view
const provenanced: AxAgentActorSkillView = withProvenance;
void provenanced;

const plain: AxAgentActorSkillView = {
  id: 's',
  name: 'Skill',
  content: 'body',
  advisory: '> [advisory] ...',
};
void plain;
