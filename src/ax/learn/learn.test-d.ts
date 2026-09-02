// learn.test-d.ts — compile-time tests for the `src/ax/learn/` type surface,
// enforced by `npm run test:type-tests` (tsc -p tsconfig.typetests.json).

import type {
  AxHarnessBulletConfig,
  AxHarnessEntry,
  AxHarnessTree,
  AxLearningDecision,
  AxLearningInteractionRecord,
  AxLearningRecord,
  AxLearningReferenceResolution,
  AxLearningReportRecord,
  AxLearningStore,
} from './index.js';
import {
  axCreateLearningEngineState,
  axInMemoryLearningStore,
  axLearningEngineIngest,
  axReportSchema,
  axScoreWindowProcessor,
} from './index.js';

// --- AxHarnessEntry narrows on `kind` ---------------------------------------

const instruction: AxHarnessEntry = {
  id: 'tone',
  kind: 'instruction',
  config: { text: 'Answer briefly.' },
};

const bullet: AxHarnessEntry = {
  id: 'refunds',
  kind: 'playbookBullet',
  disabled: true,
  config: {
    id: 'refunds-1',
    section: 'policy',
    content: 'Quote the refund window.',
    tags: ['policy'],
  },
};

const skill: AxHarnessEntry = {
  id: 'lookup',
  kind: 'skill',
  config: {
    skillId: 'order-lookup',
    name: 'Order lookup',
    description: 'Find an order by id',
    content: '# Order lookup',
  },
};

const tree: AxHarnessTree = [instruction, bullet, skill];

function entryText(entry: AxHarnessEntry): string {
  switch (entry.kind) {
    case 'instruction':
      return entry.config.text;
    case 'playbookBullet':
      return entry.config.content;
    case 'skill':
      // `name` exists only on the skill branch, so this compiles only if the
      // union really narrows.
      return `${entry.config.name}: ${entry.config.content}`;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}
void tree.map(entryText);

// A proposer-authored bullet carries content only: the counters, timestamps,
// revision, lineage and evidence are the installer's to write.
const forbiddenBullet: AxHarnessBulletConfig = {
  id: 'refunds-1',
  section: 'policy',
  content: 'Quote the refund window.',
  // @ts-expect-error helpfulCount is the installer's to write, not the proposer's
  helpfulCount: 3,
};
void forbiddenBullet;

// @ts-expect-error a harness tree is readonly
tree.push(instruction);

// --- AxLearningRecord narrows on `kind` -------------------------------------

function recordSummary(record: AxLearningRecord): string {
  if (record.kind === 'interaction') {
    const interaction: Readonly<AxLearningInteractionRecord> = record;
    return interaction.payload.programId;
  }
  const report: Readonly<AxLearningReportRecord> = record;
  return report.references.join(',');
}
void recordSummary;

function badRecord(record: AxLearningInteractionRecord): unknown {
  // @ts-expect-error an interaction record has no `references`
  return record.references;
}
void badRecord;

// --- AxLearningDecision narrows on `outcome` --------------------------------

function decisionLabel(decision: AxLearningDecision): string {
  switch (decision.outcome) {
    case 'train':
      return decision.unit.reportId;
    case 'wait':
      return decision.missing.join(',');
    case 'never':
      return decision.reason;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}
void decisionLabel;

// --- AxLearningReferenceResolution narrows on `status` ----------------------

function resolutionLabel(resolution: AxLearningReferenceResolution): number {
  switch (resolution.status) {
    case 'resolved':
      return resolution.interactions.length;
    case 'waiting':
      return resolution.missing.length;
    case 'malformed':
      return resolution.reason.length;
    default: {
      const exhaustive: never = resolution;
      return exhaustive;
    }
  }
}
void resolutionLabel;

// --- Records are readonly ---------------------------------------------------

declare const someRecord: AxLearningInteractionRecord;
// @ts-expect-error a learning record is readonly
someRecord.scenario = 'other';

// --- The port and the factories -------------------------------------------

const store: AxLearningStore = axInMemoryLearningStore({
  maxRecordsPerScenario: 10,
});
void store.capabilities.compareAndSet;

const state = axCreateLearningEngineState({
  scenario: 'support-triage',
  processor: axScoreWindowProcessor({ batchSize: 2 }),
  sampleFields: ['input', 'output'],
});
void axLearningEngineIngest(state, someRecord);

// A field's value must be an `AxReportFieldSchema`; `3` is not one. The
// `references` reservation itself is a RUNTIME check (`axReportSchema` throws),
// not a type-level one — `{ references: { type: 'string' } }` compiles.
// @ts-expect-error 3 is not an AxReportFieldSchema
void axReportSchema({ score: { type: 'number' }, references: 3 });
void axReportSchema({ score: { type: 'number', min: 0, max: 1 } });
