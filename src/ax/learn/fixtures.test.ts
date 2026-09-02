/**
 * Behaviour fixtures for `src/ax/learn/`, driven through the REAL exported
 * functions.
 *
 * They live here rather than under `ir/conformance/` on purpose: that
 * directory is executed by every generated target, its runners dispatch on a
 * closed `kind` and raise on an unknown one, and a novel kind would break all
 * five. These are TypeScript-only behaviour pins, and each one is written so a
 * hollow implementation cannot pass it.
 */

import { describe, expect, it } from 'vitest';
import { AxManualEventClock } from '../event/types.js';
import neverReasonsFixture from './__fixtures__/learn-eligibility-never-reasons.json' with {
  type: 'json',
};
import waitThenTrainFixture from './__fixtures__/learn-eligibility-wait-then-train.json' with {
  type: 'json',
};
import releaseChainFixture from './__fixtures__/learn-release-chain-nominate-promote-rollback.json' with {
  type: 'json',
};
import scoreWindowFixture from './__fixtures__/learn-score-window-default.json' with {
  type: 'json',
};
import credentialFixture from './__fixtures__/learn-tree-admission-credential.json' with {
  type: 'json',
};
import contentIdFixture from './__fixtures__/learn-tree-content-id.json' with {
  type: 'json',
};
import { AxInMemoryLearningStore } from './memoryStore.js';
import {
  type AxLearningEngineState,
  axCreateLearningEngineState,
  axLearningEngineIngest,
  axLearningEngineNeverReasons,
  axScoreWindowProcessor,
} from './processor.js';
import { axLearningSurface } from './releases.js';
import { axHarnessContentId, axInspectHarnessTree } from './tree.js';
import type {
  AxHarnessGateDecision,
  AxHarnessTree,
  AxLearningRecord,
} from './types.js';

const GATE: Readonly<AxHarnessGateDecision> = Object.freeze({
  outcome: 'select',
  evaluator: 'harness_task_pairs',
  evaluatorVersion: '1',
  policy: 'axPlaybookGate',
  policyVersion: '1',
  reason: 'held-in improved, held-out non-regressing',
  metrics: Object.freeze({
    candidateScores: [1],
    currentScores: [0],
    candidateScore: 1,
    currentScore: 0,
    wins: 1,
    losses: 0,
    ties: 0,
    heldIn: { before: 0, after: 1 },
    taskSetDigest: 'digest',
    failures: { new: [], persisting: [], fixed: [] },
    episodeFailures: 0,
  }),
});

describe('fixture: learn-eligibility-never-reasons', () => {
  it('names and counts every refusal', () => {
    const fixture = neverReasonsFixture;
    let state: AxLearningEngineState = axCreateLearningEngineState({
      scenario: fixture.scenario,
      processor: axScoreWindowProcessor(fixture.processor),
    });
    const seen = new Map<string, string>();
    for (const record of fixture.records as unknown as AxLearningRecord[]) {
      const step = axLearningEngineIngest(state, record);
      state = step.state;
      for (const entry of step.decisions) {
        if (entry.decision.outcome === 'never') {
          seen.set(entry.reportId, entry.decision.reason);
        }
      }
    }
    for (const [reportId, expected] of Object.entries(
      fixture.expected.decisions
    )) {
      expect(seen.get(reportId)).toBe(expected.reason);
    }
    expect(axLearningEngineNeverReasons(state)).toMatchObject(
      fixture.expected.neverReasons
    );
    expect(state.readyCount).toBe(fixture.expected.readyCount);
  });
});

describe('fixture: learn-eligibility-wait-then-train', () => {
  it('parks a report that arrives first, then trains when the reference lands', () => {
    const fixture = waitThenTrainFixture;
    let state: AxLearningEngineState = axCreateLearningEngineState({
      scenario: fixture.scenario,
      processor: axScoreWindowProcessor(fixture.processor),
      sampleFields: fixture.sampleFields as unknown as readonly (
        | 'input'
        | 'output'
      )[],
    });
    const outcomes: { reportId: string; outcome: string }[] = [];
    let trainedUnit: unknown;
    for (const record of fixture.records as unknown as AxLearningRecord[]) {
      const step = axLearningEngineIngest(state, record);
      state = step.state;
      for (const entry of step.decisions) {
        outcomes.push({
          reportId: entry.reportId,
          outcome: entry.decision.outcome,
        });
        if (entry.decision.outcome === 'wait') {
          expect(entry.decision.missing).toEqual(
            fixture.expected.decisions[0]?.missing
          );
        }
        if (entry.decision.outcome === 'train') {
          trainedUnit = entry.decision.unit;
        }
      }
    }
    expect(outcomes).toEqual(
      fixture.expected.decisions.map((d) => ({
        reportId: d.reportId,
        outcome: d.outcome,
      }))
    );
    expect(trainedUnit).toMatchObject(fixture.expected.unit);
    // `model`, `usage` and host `tags` are withheld from the sample unless the
    // caller asked for them.
    const sample = (trainedUnit as { samples: { payload: object }[] })
      .samples[0];
    expect(Object.keys(sample?.payload ?? {}).sort()).toEqual([
      'input',
      'output',
    ]);
    expect(state.readyCount).toBe(fixture.expected.readyCount);
  });
});

describe('fixture: learn-score-window-default', () => {
  it('batches only the failures the default window admits', () => {
    const fixture = scoreWindowFixture;
    let state: AxLearningEngineState = axCreateLearningEngineState({
      scenario: fixture.scenario,
      processor: axScoreWindowProcessor(fixture.processor),
    });
    const trained: string[] = [];
    const never = new Map<string, string>();
    for (const row of fixture.scores) {
      const interaction: AxLearningRecord = {
        kind: 'interaction',
        id: `i-${row.id}`,
        scenario: fixture.scenario,
        createdAt: 1_000,
        payload: {
          signature: 'query:string -> answer:string',
          programId: 'root',
          input: { query: row.id },
          output: { answer: row.id },
        },
      };
      const report: AxLearningRecord = {
        kind: 'report',
        id: `r-${row.id}`,
        scenario: fixture.scenario,
        createdAt: 1_001,
        references: [`i-${row.id}`],
        payload: { score: row.score },
      };
      for (const record of [interaction, report]) {
        const step = axLearningEngineIngest(state, record);
        state = step.state;
        for (const entry of step.decisions) {
          if (entry.decision.outcome === 'train') trained.push(row.id);
          if (entry.decision.outcome === 'never')
            never.set(row.id, entry.decision.reason);
        }
      }
    }
    expect(trained).toEqual(fixture.expected.trained);
    for (const [id, reason] of Object.entries(fixture.expected.never)) {
      expect(never.get(id)).toBe(reason);
    }
    expect(state.readyCount).toBe(fixture.expected.readyCount);
  });
});

describe('fixture: learn-tree-admission-credential', () => {
  it.each(credentialFixture.entries.map((row) => [row.case, row] as const))(
    'admits or refuses "%s" exactly as the fixture says',
    (_name, row) => {
      const report = axInspectHarnessTree([
        row.entry,
      ] as unknown as AxHarnessTree);
      const inspection = report.entries[0];
      expect(inspection?.admitted).toBe(row.expected.admitted);
      for (const expected of row.expected.reasons) {
        const found = inspection?.reasons.filter(
          (reason) => reason.path === expected.path
        );
        expect(found?.length ?? 0).toBeGreaterThan(0);
        if (expected.reason !== 'forbidden-or-unknown') {
          expect(found?.map((r) => r.reason)).toContain(expected.reason);
        }
      }
      // A denial never carries the value, only the path.
      const serialized = JSON.stringify(inspection);
      expect(serialized).not.toContain('sk-abcdefghij0123456789');
      expect(serialized).not.toContain('ghp_abcdefghij0123456789abcd');
    }
  );

  it('reports the whole tree as not ok while every clean entry still passes', () => {
    const report = axInspectHarnessTree(
      credentialFixture.entries.map(
        (row) => row.entry
      ) as unknown as AxHarnessTree
    );
    expect(report.ok).toBe(credentialFixture.expectedReportOk);
    const cleanIds = credentialFixture.entries
      .filter((row) => row.expected.admitted)
      .map((row) => row.entry.id);
    expect(report.admitted.map((entry) => entry.id)).toEqual(cleanIds);
  });
});

describe('fixture: learn-tree-content-id', () => {
  it('holds identity under key permutation and breaks it on every real change', async () => {
    const fixture = contentIdFixture;
    const base = await axHarnessContentId(
      fixture.base as unknown as AxHarnessTree
    );
    expect(base).toMatch(new RegExp(fixture.expected.format));
    // The GOLDEN digest, not only the relations. A change to
    // `axEventCanonicalJson` that invalidated every `contentId` already
    // written onto a release chain keeps every same/different relation
    // intact, and would pass a fixture that only pinned those.
    expect(base).toBe(fixture.expected.baseContentId);
    for (const variant of fixture.variants) {
      const contentId = await axHarnessContentId(
        variant.tree as unknown as AxHarnessTree
      );
      if (variant.sameAsBase) {
        expect(contentId, variant.case).toBe(base);
      } else {
        expect(contentId, variant.case).not.toBe(base);
      }
    }
    // …and the four differing variants differ from each OTHER too, so the
    // digest is not merely "not the base".
    const distinct = new Set<string>();
    for (const variant of fixture.variants.filter((v) => !v.sameAsBase)) {
      distinct.add(
        await axHarnessContentId(variant.tree as unknown as AxHarnessTree)
      );
    }
    expect(distinct.size).toBe(
      fixture.variants.filter((v) => !v.sameAsBase).length
    );
  });
});

describe('fixture: learn-release-chain-nominate-promote-rollback', () => {
  it('walks creation, nomination, promotion and rollback exactly as pinned', async () => {
    const fixture = releaseChainFixture;
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryLearningStore({ clock });
    let counter = 0;
    const surface = await axLearningSurface({
      scenario: fixture.scenario,
      store,
      clock,
      seed: fixture.seed as unknown as AxHarnessTree,
      idFactory: () => {
        counter += 1;
        return `rel-${counter}`;
      },
    });

    const byReleaseId = new Map<string, string>();
    for (const step of fixture.steps) {
      if (step.op === 'seed') {
        const head = await surface.currentTree();
        expect(head?.releaseId).toBe(step.expected.releaseId);
        expect(head?.step).toBe(step.expected.step);
        byReleaseId.set(head?.releaseId ?? '', head?.contentId ?? '');
      } else if (step.op === 'publish') {
        const release = await surface.publish({
          entries: fixture.candidate as unknown as AxHarnessTree,
          gate: GATE,
        });
        expect(release.releaseId).toBe(step.expected.releaseId);
        expect(release.step).toBe(step.expected.step);
        expect(release.operation).toBe(step.expected.operation);
        expect(release.current).toBe(step.expected.current);
        expect(release.parentReleaseId).toBe(step.expected.parentReleaseId);
        byReleaseId.set(release.releaseId, release.contentId);
        // The nomination did not move the head.
        expect((await surface.currentTree())?.releaseId).toBe(
          step.expected.headReleaseId
        );
      } else if (step.op === 'promote') {
        const promoted = await surface.promote(
          step.releaseId as string,
          step.expectedHeadReleaseId as string
        );
        expect(promoted.releaseId).toBe(step.expected.releaseId);
        expect(promoted.current).toBe(step.expected.current);
        expect((await surface.currentTree())?.releaseId).toBe(
          step.expected.headReleaseId
        );
      } else {
        const rolled = await surface.rollback(
          step.releaseId as string,
          step.expectedHeadReleaseId as string
        );
        expect(rolled.releaseId).toBe(step.expected.releaseId);
        expect(rolled.step).toBe(step.expected.step);
        expect(rolled.operation).toBe(step.expected.operation);
        expect(rolled.rollbackTargetReleaseId).toBe(
          step.expected.rollbackTargetReleaseId
        );
        // Equal contentId means equal entry list: that is what makes a
        // rollback honest rather than a rewrite.
        expect(rolled.contentId).toBe(
          byReleaseId.get(step.expected.contentIdEqualsReleaseId as string)
        );
        expect((await surface.currentTree())?.releaseId).toBe(
          step.expected.headReleaseId
        );
      }
    }

    const chain = await surface.releases();
    expect(chain.map((release) => release.step)).toEqual(
      fixture.expectedChainSteps
    );
    expect(chain.filter((release) => release.current)).toHaveLength(
      fixture.expectedCurrentCount
    );
  });
});
