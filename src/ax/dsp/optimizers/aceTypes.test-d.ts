// Compile-time contract for the ACE visibility tier, enforced by
// `npm run test:type-tests`.
import type {
  AxACEActorPlaybookView,
  AxACEBullet,
  AxACECuratorOperation,
  AxACEHostEvidence,
  AxACEPlaybook,
} from '../../index.js';
import { axRenderActorPlaybook } from './acePlaybook.js';

// The curator may downgrade and nothing else. Promotion is host-owned.
const downgrade: AxACECuratorOperation = {
  type: 'UPDATE',
  section: 'Guidelines',
  bulletId: 'b-1',
  visibility: 'optimizer',
};
void downgrade;

const promote: AxACECuratorOperation = {
  type: 'ADD',
  section: 'Guidelines',
  // @ts-expect-error the curator cannot promote a bullet to the actor tier
  visibility: 'actor',
};
void promote;

// The host promotion path accepts either tier.
const hostPromotion: AxACEHostEvidence = { visibility: 'actor' };
void hostPromotion;

// A bullet's tier is a closed union, absent meaning actor-visible.
const tiered: AxACEBullet = {
  id: 'b-1',
  section: 'Guidelines',
  content: 'text',
  helpfulCount: 0,
  harmfulCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  visibility: 'optimizer',
};
void tiered;

declare const raw: AxACEPlaybook;
// @ts-expect-error the actor renderer takes a projected view, never a playbook
void axRenderActorPlaybook(raw);

declare const view: AxACEActorPlaybookView;
void axRenderActorPlaybook(view);
