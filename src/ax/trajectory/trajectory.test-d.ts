// trajectory.test-d.ts — compile-time tests for the trajectory surface,
// enforced by `npm run test:type-tests` (tsc -p tsconfig.typetests.json).

import type { AxEventValue } from '../index.js';
import {
  AxInMemoryTrajectoryStore,
  type AxTrajectoryCursor,
  type AxTrajectoryFieldValue,
  type AxTrajectoryProjectionSection,
  type AxTrajectoryReadQuery,
  type AxTrajectoryRollupBlock,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTypeDescriptor,
} from '../index.js';

declare const step: AxTrajectoryStep;

// A step is deeply readonly: it is the autobiography, never a draft (I1).
// @ts-expect-error stepId is readonly
step.stepId = 'rewritten';
// @ts-expect-error seq is assigned by the store and never edited
step.seq = 0;
// @ts-expect-error data is a Readonly record
step.data.content = 'rewritten';
// @ts-expect-error the blob ref list is readonly
step.blobs?.push({
  field: 'content',
  ref: 'r',
  bytes: 1,
  digest: 'd',
  inlineBytes: 1,
  truncated: true,
});

// §3.3: the trajectory reuses the event plane's value type, so the two are
// mutually assignable and no conversion can ever be anything but the identity.
declare const fieldValue: AxTrajectoryFieldValue;
declare const eventValue: AxEventValue;
const asEvent: AxEventValue = fieldValue;
const asField: AxTrajectoryFieldValue = eventValue;
void asEvent;
void asField;

// `limit` is required on the backward tail: an unbounded backward scan is the
// bug the primitive exists to prevent (I12).
const tailQuery: AxTrajectoryTailQuery = { trajectoryId: 't', limit: 10 };
void tailQuery;
// @ts-expect-error limit is required
const unboundedTail: AxTrajectoryTailQuery = { trajectoryId: 't' };
void unboundedTail;

// A read query's bounds are optional at the type level and enforced at runtime,
// because "limit OR (fromSeq AND toSeq)" is not expressible as one shape.
const readQuery: AxTrajectoryReadQuery = { trajectoryId: 't', limit: 5 };
void readQuery;

// A cursor is portable by `seq`; the token is a store-private fast path.
const cursor: AxTrajectoryCursor = { trajectoryId: 't', seq: 4 };
void cursor;

// The reference store satisfies the port structurally.
const port: AxTrajectoryStore = new AxInMemoryTrajectoryStore();
void port;

// The port has no mutation surface at all.
// @ts-expect-error there is no update method on an append-only log
void port.update;
// @ts-expect-error there is no delete method on an append-only log
void port.deleteStep;

// A machinery descriptor still has to state its source policy explicitly.
const descriptor: AxTrajectoryTypeDescriptor = {
  type: 'host.machine',
  stepClass: 'machinery',
  wakeable: false,
  carriesSource: false,
};
void descriptor;
// @ts-expect-error carriesSource is not optional
const partial: AxTrajectoryTypeDescriptor = {
  type: 'host.machine',
  stepClass: 'machinery',
  wakeable: false,
};
void partial;

// A projection section narrows on `kind`: a caller can never read `block` off
// a gap, which is what makes "the summary is missing" impossible to ignore.
declare const section: AxTrajectoryProjectionSection;
if (section.kind === 'summary') {
  const block: AxTrajectoryRollupBlock = section.block;
  const tier: number = block.tier;
  void tier;
  // @ts-expect-error a summary section has no gap reason
  void section.reason;
} else {
  const reason: 'pre-enable' | 'missing' = section.reason;
  void reason;
  // @ts-expect-error a gap section has no block
  void section.block;
}

// A sealed block is immutable: it is a cache entry with provenance, and a
// caller that could edit `summary` could rewrite the agent's own memory.
declare const sealed: AxTrajectoryRollupBlock;
// @ts-expect-error summary is readonly
sealed.summary = 'rewritten';
// @ts-expect-error the cited id list is readonly
sealed.stepIds.push('x');
// @ts-expect-error provenance is readonly
sealed.summarizerId = 'someone-else';
