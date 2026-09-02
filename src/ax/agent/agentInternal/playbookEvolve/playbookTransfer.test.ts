import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import type {
  AxACEBullet,
  AxACEPlaybook,
} from '../../../dsp/optimizers/aceTypes.js';
import type { AxAgentPlaybookTransferCell } from './playbookEvidenceTypes.js';
import { axIsAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import { evolveAgentPlaybook } from './playbookEvolve.js';
import {
  DEFAULT_TRANSFER_REGRESSION_FLOOR,
  transferCellKey,
  transferComparisonMade,
  transferPassMetricCalls,
  transferReportFrom,
  transferRequiredMetricCalls,
  transferSplitsOf,
  transferVerdict,
  validateTransferOptions,
} from './transfer.js';

// --- local factories -------------------------------------------------------

const NOW_ISO = '2026-01-01T00:00:00.000Z';

const bulletOf = (id: string, content: string): AxACEBullet => ({
  id,
  section: 'failures_to_avoid',
  content,
  helpfulCount: 0,
  harmfulCount: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
});

const playbookOf = (bullets: readonly AxACEBullet[]): AxACEPlaybook => ({
  version: 1,
  sections: bullets.reduce<Record<string, AxACEBullet[]>>((acc, bullet) => {
    const section = acc[bullet.section] ?? [];
    section.push(bullet);
    acc[bullet.section] = section;
    return acc;
  }, {}),
  stats: {
    bulletCount: bullets.length,
    helpfulCount: 0,
    harmfulCount: 0,
    tokenEstimate: 0,
  },
  updatedAt: NOW_ISO,
});

function aceHandle(playbook: AxACEPlaybook) {
  let state = {
    playbook: JSON.parse(JSON.stringify(playbook)) as AxACEPlaybook,
    artifact: {
      playbook: JSON.parse(JSON.stringify(playbook)) as AxACEPlaybook,
      feedback: [] as any[],
      history: [] as any[],
    },
  };
  return {
    recordEvidence: (bulletIds: readonly string[]) => [...bulletIds],
    getState: () => JSON.parse(JSON.stringify(state)),
    load: (snapshot: any) => {
      state = JSON.parse(JSON.stringify(snapshot));
    },
    current: () => JSON.parse(JSON.stringify(state)),
  };
}

const DATASET = {
  train: [
    { input: { q: 1 }, criteria: 'c', id: 't1' },
    { input: { q: 2 }, criteria: 'c', id: 't2' },
  ],
  validation: [
    { input: { q: 3 }, criteria: 'c', id: 'v1' },
    { input: { q: 4 }, criteria: 'c', id: 'v2' },
  ],
};

const SEALED = [
  { input: { q: 5 }, criteria: 'c', id: 's1' },
  { input: { q: 6 }, criteria: 'c', id: 's2' },
];

type Observation = { ai: string; taskId: string; noise: boolean };

/**
 * A stub agent over a real ACE-shaped playbook whose score is a pure function
 * of (which service asked, which bullets survive). Removing `noise` HELPS the
 * primary and the `sonnet` target and HURTS the `nano` target — the cell
 * pattern the whole per-cell contract exists for, and one an average would
 * report as a win.
 */
function transferFixture() {
  const handle = aceHandle(
    playbookOf([
      bulletOf('noise', 'noisy guidance that misleads the primary actor'),
      bulletOf('keeper', 'load bearing guidance the actor needs'),
    ])
  );
  const observations: Observation[] = [];
  const has = (id: string): boolean =>
    Object.values(handle.current().playbook.sections).some((bullets) =>
      (bullets as AxACEBullet[]).some((bullet) => bullet.id === id)
    );
  const self = {
    init: { ai: { id: 'primary' } as any },
    getPlaybook: () => handle,
    _forwardForEvaluation: async (ai: any, task: any) => {
      const who = String(ai?.id ?? 'primary');
      const noise = has('noise');
      observations.push({ ai: who, taskId: String(task?.id ?? '?'), noise });
      return {
        completionType: 'final' as const,
        output: { ai: who, noise, keeper: has('keeper') },
        actionLog: '',
        functionCalls: [],
        toolErrors: [],
        turnCount: 1,
        usage: [
          {
            ai: who,
            model: `${who}-1`,
            tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        ],
      };
    },
  };
  const scoreOf = (who: string, noise: boolean, keeper: boolean) => {
    // primary: 0.20 with noise, 0.70 without  -> removal helps by +0.50
    // sonnet : 0.30 with noise, 0.80 without  -> cell delta +0.50
    // nano   : 0.86 with noise, 0.50 without  -> cell delta -0.36
    const table: Record<string, [number, number]> = {
      primary: [-0.5, 0.7],
      sonnet: [-0.5, 0.8],
      nano: [0.36, 0.5],
    };
    const [noiseWeight, keeperWeight] = table[who] ?? table.primary!;
    const raw = (noise ? noiseWeight! : 0) + (keeper ? keeperWeight! : 0);
    return Math.max(0, Math.min(1, raw));
  };
  const metric = async ({ prediction }: any) =>
    scoreOf(
      String(prediction.output.ai),
      Boolean(prediction.output.noise),
      Boolean(prediction.output.keeper)
    );
  const targets = [
    { id: 'sonnet', ai: { id: 'sonnet' } as any },
    { id: 'nano', ai: { id: 'nano' } as any },
  ];
  return { handle, self, metric, targets, observations, scoreOf };
}

const cellsByKey = (cells: readonly AxAgentPlaybookTransferCell[]) =>
  Object.fromEntries(
    cells.map((cell) => [transferCellKey(cell.targetId, cell.split), cell])
  );

const PRUNE = { enabled: true, operation: 'remove' } as const;

// --- option validation, before any mutation --------------------------------

describe('transfer option validation', () => {
  it('rejects duplicate or blank target ids before mutation', async () => {
    for (const targets of [
      [
        { id: 'a', ai: {} as any },
        { id: 'a', ai: {} as any },
      ],
      [{ id: '   ', ai: {} as any }],
      [{ id: 'a', ai: undefined as any }],
    ]) {
      const { handle, self, metric } = transferFixture();
      const before = JSON.stringify(handle.current());
      const error = await evolveAgentPlaybook(self as any, DATASET, {
        metric,
        scoreThreshold: 0,
        prune: PRUNE,
        transfer: { targets },
      }).catch((err) => err);
      expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
      expect(error.code).toBe('transfer_target_invalid');
      expect(error.phase).toBe('transfer');
      // Nothing ran: option validation happens before the baseline batch.
      expect(JSON.stringify(handle.current())).toBe(before);
    }
  });

  it('rejects a held-out cell with no held-out tasks, and an unknown split', () => {
    expect(() =>
      validateTransferOptions(
        { targets: [{ id: 'a', ai: {} as any }], splits: ['heldOut'] },
        false
      )
    ).toThrow(/no validation set/);
    expect(() =>
      validateTransferOptions(
        { targets: [{ id: 'a', ai: {} as any }], splits: ['train' as any] },
        true
      )
    ).toThrow(/unknown split/);
    // The default is heldOut when one exists and current when it does not, so
    // a caller who supplies no validation set still gets a measurable matrix.
    expect(
      transferSplitsOf({ targets: [{ id: 'a', ai: {} as any }] }, false)
    ).toEqual(['current']);
    expect(
      transferSplitsOf({ targets: [{ id: 'a', ai: {} as any }] }, true)
    ).toEqual(['heldOut']);
  });

  it('fails closed on an insufficient cell budget before any mutation', async () => {
    const { handle, self, metric, targets } = transferFixture();
    const before = JSON.stringify(handle.current());
    const required = transferRequiredMetricCalls({
      targetCount: 2,
      splits: ['heldOut'],
      trainCount: 2,
      heldOutCount: 2,
      runsPerTask: 1,
      maxDiscardRedraws: 0,
    });
    expect(required).toBe(8);
    const error = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets, maxMetricCalls: required - 1 },
    }).catch((err) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect(error.code).toBe('budget_insufficient');
    expect(error.message).toContain('transfer needs 8 metric calls');
    expect(JSON.stringify(handle.current())).toBe(before);
  });

  it('sizes the matrix budget for the re-draws the harness may spend', () => {
    const base = {
      targetCount: 2,
      splits: ['heldOut'] as const,
      trainCount: 2,
      heldOutCount: 2,
      runsPerTask: 1,
    };
    // A discarded attempt is re-drawn from the SAME counter, so a budget that
    // ignores `maxDiscardRedraws` truncates a pass on the first provider
    // hiccup — in exactly the configuration bounded re-draw exists to protect.
    expect(transferRequiredMetricCalls({ ...base, maxDiscardRedraws: 0 })).toBe(
      8
    );
    expect(transferRequiredMetricCalls({ ...base, maxDiscardRedraws: 1 })).toBe(
      16
    );
    expect(
      transferPassMetricCalls({
        taskCount: 2,
        runsPerTask: 1,
        maxDiscardRedraws: 1,
      })
    ).toBe(4);
    // The per-pass counter is a strict fraction of the matrix total: 2 targets
    // x 2 passes (anchor + candidate) x this.
    expect(
      transferPassMetricCalls({
        taskCount: 2,
        runsPerTask: 1,
        maxDiscardRedraws: 1,
      }) * 4
    ).toBe(transferRequiredMetricCalls({ ...base, maxDiscardRedraws: 1 }));
  });

  it('refuses a transfer gate with no targets to read', async () => {
    const { self, metric } = transferFixture();
    const error = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      gates: { transfer: 'require' },
    }).catch((err) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect(error.code).toBe('transfer_target_invalid');
  });
});

// --- the matrix ------------------------------------------------------------

describe('the transfer matrix', () => {
  it('stores one cell per target and split with its own interval', async () => {
    const { self, metric, targets } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets, splits: ['current', 'heldOut'] },
    });
    expect(result.transfer?.status).toBe('completed');
    const report = result.transfer!;
    if (report.status === 'not_run') throw new Error('expected a matrix');
    expect(report.cells).toHaveLength(4);
    expect(
      report.cells.map((cell) => transferCellKey(cell.targetId, cell.split))
    ).toEqual([
      'sonnet:current',
      'sonnet:heldOut',
      'nano:current',
      'nano:heldOut',
    ]);
    for (const cell of report.cells) {
      // Every cell carries its OWN interval and its OWN model identity: a
      // matrix that shared one interval across cells would report the same
      // uncertainty for a target it never measured.
      expect(cell.interval.clusters).toBe(2);
      expect(cell.interval.resamples).toBeGreaterThan(0);
      expect(cell.model).toEqual({
        ai: cell.targetId,
        model: `${cell.targetId}-1`,
      });
      expect(cell.anchor.complete).toBe(true);
      expect(cell.candidate.complete).toBe(true);
      expect(cell.delta).toBeCloseTo(cell.candidate.mean - cell.anchor.mean, 9);
    }
    const keyed = cellsByKey(report.cells);
    expect(keyed['sonnet:heldOut']!.interval.direction).toBe('positive');
    expect(keyed['nano:heldOut']!.interval.direction).toBe('negative');
  });

  it('evaluates the unevolved anchor per target before any mutation', async () => {
    const { self, metric, targets, observations, scoreOf } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
    });
    const report = result.transfer!;
    if (report.status === 'not_run') throw new Error('expected a matrix');
    const keyed = cellsByKey(report.cells);
    // The anchor is the TARGET's own reading of the unevolved artifact. If it
    // were borrowed from the primary's baseline both anchors would read 0.2.
    expect(keyed['sonnet:heldOut']!.anchor.mean).toBeCloseTo(
      scoreOf('sonnet', true, true),
      9
    );
    expect(keyed['nano:heldOut']!.anchor.mean).toBeCloseTo(
      scoreOf('nano', true, true),
      9
    );
    expect(result.baseline.heldOut).toBeCloseTo(
      scoreOf('primary', true, true),
      9
    );
    expect(keyed['sonnet:heldOut']!.anchor.mean).not.toBeCloseTo(
      result.baseline.heldOut!,
      9
    );

    // ... and it was taken while the artifact still had the bullet the prune
    // later removed, before the first evaluation of the mutated artifact.
    const targetCalls = observations.filter((o) => o.ai !== 'primary');
    const anchors = targetCalls.filter((o) => o.noise);
    const candidates = targetCalls.filter((o) => !o.noise);
    expect(anchors).toHaveLength(4);
    expect(candidates).toHaveLength(4);
    expect(targetCalls.slice(0, 4)).toEqual(anchors);
    const firstMutatedObservation = observations.findIndex((o) => !o.noise);
    const lastTargetAnchor =
      observations.length -
      1 -
      [...observations]
        .reverse()
        .findIndex((o) => o.ai !== 'primary' && o.noise);
    expect(lastTargetAnchor).toBeLessThan(firstMutatedObservation);
  });

  it('reports no average anywhere, so a losing cell cannot be hidden', async () => {
    const { self, metric, targets } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
    });
    const report = result.transfer!;
    if (report.status === 'not_run') throw new Error('expected a matrix');
    // The execution counterpart of the no-average type test: the report a
    // caller actually receives has no averaging field on it at all.
    expect(Object.keys(report).sort()).toEqual([
      'accounting',
      'cells',
      'floor',
      'regressedCells',
      'status',
    ]);
    const cellDeltas = report.cells.map((cell) => cell.delta);
    const average =
      cellDeltas.reduce((sum, delta) => sum + delta, 0) / cellDeltas.length;
    // The number the report refuses to compute IS positive here, which is
    // exactly why it must not be reported: one cell regressed.
    expect(average).toBeGreaterThan(0);
    expect(report.regressedCells).toEqual(['nano:heldOut']);
  });
});

// --- the run-level transfer gate -------------------------------------------

describe('the run-level transfer gate', () => {
  it('rejects when any cell regresses beyond the floor even though the average is positive', async () => {
    const { handle, self, metric, targets } = transferFixture();
    const before = JSON.stringify(handle.current());
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
      gates: { transfer: 'require' },
    });
    const report = result.transfer!;
    if (report.status === 'not_run') throw new Error('expected a matrix');
    expect(report.floor).toBe(DEFAULT_TRANSFER_REGRESSION_FLOOR);
    const keyed = cellsByKey(report.cells);
    expect(keyed['sonnet:heldOut']!.delta).toBeCloseTo(0.5, 9);
    expect(keyed['sonnet:heldOut']!.regressed).toBe(false);
    expect(keyed['nano:heldOut']!.delta).toBeCloseTo(-0.36, 9);
    expect(keyed['nano:heldOut']!.regressed).toBe(true);
    expect(report.regressedCells).toEqual(['nano:heldOut']);

    // The whole accepted set is rescinded, and the I8 cascade names TRANSFER.
    expect(result.applied).toBe('rolled_back');
    expect(result.rolledBackReason).toContain('transfer gate failed');
    expect(result.rolledBackReason).toContain('nano:heldOut');
    expect(result.playbookSnapshot).toBeUndefined();
    const rescinded = result.outcomes.filter((o) => o.accepted);
    expect(rescinded.length).toBeGreaterThan(0);
    for (const outcome of rescinded) {
      expect(outcome.evidence?.decision).toBe('superseded');
      // The cascade names the gate that actually decided. A hard-coded
      // 'control_arm' would read "rolled back by the control_arm gate" on a run
      // that never configured one.
      const rollback = (outcome.evidence?.warnings ?? []).find(
        (w) => w.code === 'promotion_rolled_back'
      );
      expect(rollback?.message).toContain('by the transfer gate');
      expect(rollback?.message).not.toContain('control_arm');
    }
    // The artifact is back where it started, byte for byte.
    expect(JSON.stringify(handle.current())).toBe(before);
  });

  it('warns instead of rolling back under warn, and keeps the artifact live', async () => {
    const { handle, self, metric, targets } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
      gates: { transfer: 'warn' },
    });
    expect(result.applied).toBe('live');
    expect(result.rolledBackReason).toBeUndefined();
    const codes = (result.warnings ?? []).map((w) => w.code);
    expect(codes).toContain('transfer_cell_regressed');
    expect(codes).not.toContain('transfer_not_run');
    expect(codes).not.toContain('transfer_unmeasured');
    const warning = (result.warnings ?? []).find(
      (w) => w.code === 'transfer_cell_regressed'
    );
    expect(warning?.scope).toBe('nano:heldOut');
    expect(warning?.message).toContain('-0.360');
    // The bullet really is gone: a warn-mode gate must not quietly roll back.
    const live = handle
      .current()
      .playbook.sections.failures_to_avoid.map((b: AxACEBullet) => b.id);
    expect(live).toEqual(['keeper']);
  });

  it('reports a measured regression even with the gate off', async () => {
    const { self, metric, targets } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
    });
    expect(result.applied).toBe('live');
    expect((result.warnings ?? []).map((w) => w.code)).toContain(
      'transfer_cell_regressed'
    );
  });

  it('passes when no cell regresses beyond the floor', async () => {
    const { self, metric, targets } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      // A floor wide enough to tolerate the -0.36 cell: the SAME matrix now
      // passes, so the gate is reading the floor and not the sign.
      transfer: { targets, regressionFloor: 0.5 },
      gates: { transfer: 'require' },
    });
    expect(result.applied).toBe('live');
    const report = result.transfer!;
    if (report.status === 'not_run') throw new Error('expected a matrix');
    expect(report.regressedCells).toEqual([]);
    expect((result.warnings ?? []).map((w) => w.code)).not.toContain(
      'transfer_cell_regressed'
    );
  });

  it('fails closed on an unreadable matrix rather than passing it', () => {
    const notRun = { status: 'not_run', reason: 'no targets' } as const;
    expect(transferVerdict({ report: notRun }).passed).toBe(false);
    expect(transferComparisonMade(notRun)).toBe(false);

    const empty = transferReportFrom({
      floor: 0.02,
      cells: [],
      accounting: {} as any,
      expectedCells: 2,
    });
    expect(empty.status).toBe('partial');
    expect(transferVerdict({ report: empty }).passed).toBe(false);
    expect(transferComparisonMade(empty)).toBe(false);
    expect(transferVerdict({ report: empty }).detail).toContain(
      'no cell at all'
    );

    const score = (complete: boolean) => ({
      mean: 0.9,
      executedRuns: complete ? 2 : 1,
      discardedRuns: 0,
      expectedRuns: 2,
      complete,
    });
    const interval = (clusters: number) => ({
      point: 0.4,
      lower: 0.3,
      upper: 0.5,
      level: 0.95,
      resamples: clusters === 0 ? 0 : 1000,
      unit: 'task' as const,
      clusters,
      seed: 1,
      direction: 'positive' as const,
    });
    // A cell whose candidate pass ran out of budget has a PREFIX mean. A high
    // prefix mean must never satisfy the gate.
    const incomplete = transferReportFrom({
      floor: 0.02,
      cells: [
        {
          targetId: 'nano',
          split: 'heldOut',
          anchor: score(true),
          candidate: score(false),
          delta: 0.4,
          interval: interval(2),
          regressed: false,
        },
      ],
      accounting: {} as any,
      expectedCells: 1,
    });
    expect(incomplete.status).toBe('partial');
    expect(transferVerdict({ report: incomplete }).passed).toBe(false);
    expect(transferVerdict({ report: incomplete }).detail).toContain(
      'incomplete candidate pass'
    );

    // An unpaired cell carries an interval shaped like a real one but with no
    // clusters; that is not a comparison either.
    const unpaired = transferReportFrom({
      floor: 0.02,
      cells: [
        {
          targetId: 'nano',
          split: 'heldOut',
          anchor: score(true),
          candidate: score(true),
          delta: 0.4,
          interval: interval(0),
          regressed: false,
        },
      ],
      accounting: {} as any,
      expectedCells: 1,
    });
    expect(transferVerdict({ report: unpaired }).passed).toBe(false);
    expect(transferComparisonMade(unpaired)).toBe(false);

    // A matrix that simply LOST a cell reads clean cell by cell. Without the
    // partial-status branch it would pass a required gate on the targets that
    // survived, which is the fail-open direction.
    const missing = transferReportFrom({
      floor: 0.02,
      cells: [
        {
          targetId: 'sonnet',
          split: 'heldOut',
          anchor: score(true),
          candidate: score(true),
          delta: 0.4,
          interval: interval(2),
          regressed: false,
        },
      ],
      accounting: {} as any,
      expectedCells: 2,
    });
    expect(missing.status).toBe('partial');
    expect(transferVerdict({ report: missing }).passed).toBe(false);
    expect(transferVerdict({ report: missing }).detail).toContain(
      'at least one planned'
    );
    expect(transferComparisonMade(missing)).toBe(false);

    // ... and a complete, non-regressing matrix does pass, so the fail-closed
    // branches above are not just "everything fails".
    const good = transferReportFrom({
      floor: 0.02,
      cells: [
        {
          targetId: 'nano',
          split: 'heldOut',
          anchor: score(true),
          candidate: score(true),
          delta: 0.4,
          interval: interval(2),
          regressed: false,
        },
      ],
      accounting: {} as any,
      expectedCells: 1,
    });
    expect(good.status).toBe('completed');
    expect(transferVerdict({ report: good }).passed).toBe(true);
    expect(transferComparisonMade(good)).toBe(true);
  });
});

// --- the sealed test (RFC 7.8 / 8.14b) -------------------------------------

describe('the sealed test', () => {
  it('rejects a sealedTest overlapping train or validation', async () => {
    const { handle, self, metric } = transferFixture();
    const before = JSON.stringify(handle.current());
    for (const sealed of [
      [{ input: { q: 9 }, criteria: 'c', id: 't1' }],
      [{ input: { q: 9 }, criteria: 'c', id: 'v1' }],
    ]) {
      const error = await evolveAgentPlaybook(self as any, DATASET, {
        metric,
        scoreThreshold: 0,
        prune: PRUNE,
        sealedTest: sealed,
      }).catch((err) => err);
      expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
      expect(error.code).toBe('sealed_test_invalid');
      expect(error.phase).toBe('sealed_test');
      expect(error.message).toContain('overlapping task id(s)');
      expect(JSON.stringify(handle.current())).toBe(before);
    }
    const noId = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      sealedTest: [{ input: { q: 9 }, criteria: 'c' } as any],
    }).catch((err) => err);
    expect(noId.code).toBe('sealed_test_invalid');
    expect(noId.message).toContain('no semantic task id');
  });

  it('runs exactly once, after the run-level verdict', async () => {
    const { self, metric, targets, observations } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
      gates: { transfer: 'warn' },
      sealedTest: SEALED,
    });
    expect(result.sealedTest?.status).toBe('completed');
    const report = result.sealedTest!;
    if (report.status === 'not_run') throw new Error('expected a sealed test');
    expect(report.influencedNoDecision).toBe(true);
    // 2 passes (baseline artifact, final artifact) x |sealed| x runsPerTask.
    const sealedIds = new Set(SEALED.map((task) => task.id));
    const sealedCalls = observations.filter((o) => sealedIds.has(o.taskId));
    expect(sealedCalls).toHaveLength(4);
    // Every sealed call is the LAST thing the run did: no gate, no arm and no
    // candidate evaluation could have read it.
    const firstSealed = observations.findIndex((o) => sealedIds.has(o.taskId));
    expect(
      observations.slice(firstSealed).every((o) => sealedIds.has(o.taskId))
    ).toBe(true);
    // One pass saw the baseline artifact and one saw the final one.
    expect(sealedCalls.filter((o) => o.noise)).toHaveLength(2);
    expect(sealedCalls.filter((o) => !o.noise)).toHaveLength(2);
    expect(report.baseline.mean).toBeCloseTo(0.2, 9);
    expect(report.final.mean).toBeCloseTo(0.7, 9);
    expect(report.delta).toBeCloseTo(0.5, 9);
    expect(report.interval.clusters).toBe(2);
    expect(report.accounting.metricCalls).toBe(4);
    expect((result.warnings ?? []).map((w) => w.code)).not.toContain(
      'sealed_test_not_run'
    );
    // I6: the sealed test never moves the legacy counter.
    expect(result.metricCallsUsed).toBeLessThan(
      report.accounting.metricCalls * 100
    );
  });

  it('changes no gate decision when its scores are inverted', async () => {
    const run = async (sealedScore: number) => {
      const { self, metric, targets } = transferFixture();
      const sealedIds = new Set(SEALED.map((task) => task.id));
      const wrapped = async (args: any) =>
        sealedIds.has(String(args.example?.id))
          ? sealedScore
          : await metric(args);
      const result = await evolveAgentPlaybook(self as any, DATASET, {
        metric: wrapped,
        scoreThreshold: 0,
        prune: PRUNE,
        transfer: { targets },
        gates: { transfer: 'warn' },
        sealedTest: SEALED,
      });
      return {
        applied: result.applied,
        accepted: result.outcomes.map((o) => o.accepted),
        reasons: result.outcomes.map((o) => o.reason),
        gates: result.outcomes.map((o) => o.evidence?.gates),
        regressed:
          result.transfer?.status === 'not_run'
            ? undefined
            : result.transfer?.regressedCells,
        warnings: (result.warnings ?? [])
          .map((w) => w.code)
          .filter((code) => code !== 'sealed_test_not_run')
          .sort(),
        sealedDelta:
          result.sealedTest?.status === 'completed'
            ? result.sealedTest.delta
            : undefined,
        sealedBaseline:
          result.sealedTest?.status === 'completed'
            ? result.sealedTest.baseline.mean
            : undefined,
        sealedFinal:
          result.sealedTest?.status === 'completed'
            ? result.sealedTest.final.mean
            : undefined,
      };
    };
    const zero = await run(0);
    const one = await run(1);
    // The sealed reading really did move — a stub that reported a constant
    // `delta: 0` would satisfy the deep-equal below without ever measuring
    // anything, so the moving fact is asserted first.
    expect(zero.sealedBaseline).toBeCloseTo(0, 9);
    expect(one.sealedBaseline).toBeCloseTo(1, 9);
    expect(zero.sealedFinal).toBeCloseTo(0, 9);
    expect(one.sealedFinal).toBeCloseTo(1, 9);
    // ... and the delta is 0 on both sides, so nothing else moved at all.
    expect(zero.sealedDelta).toBe(0);
    expect(one.sealedDelta).toBe(0);
    const {
      sealedDelta: _z,
      sealedBaseline: _zb,
      sealedFinal: _zf,
      ...zeroRest
    } = zero;
    const {
      sealedDelta: _o,
      sealedBaseline: _ob,
      sealedFinal: _of,
      ...oneRest
    } = one;
    expect(oneRest).toEqual(zeroRest);
    expect(zeroRest.applied).toBe('live');
    expect(zeroRest.accepted).toContain(true);
  });

  it('says so rather than measuring noise when the run changed nothing', async () => {
    const { self, metric } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      // No prune and no mining: nothing is accepted, so the final artifact IS
      // the baseline and a sealed delta would be pure run-to-run variance.
      scoreThreshold: 0,
      sealedTest: SEALED,
    });
    expect(result.outcomes.filter((o) => o.accepted)).toHaveLength(0);
    expect(result.sealedTest?.status).toBe('not_run');
    const report = result.sealedTest!;
    if (report.status !== 'not_run') throw new Error('expected not_run');
    expect(report.reason).toContain('no artifact change');
    expect((result.warnings ?? []).map((w) => w.code)).toContain(
      'sealed_test_not_run'
    );
  });

  it('refuses a delta over a split it could not finish', async () => {
    const { self, metric } = transferFixture();
    const sealedIds = new Set(SEALED.map((task) => task.id));
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      sealedTest: SEALED,
      // Every attempt at `s1` is an environment failure, so no re-draw can
      // score it and the split is never whole. Publishing `final.mean` here
      // would report a number for an artifact that was never evaluated.
      classifyTermination: ({ task }: any) =>
        String(task?.id ?? '') === 's1'
          ? { kind: 'environment_failure', cause: 'provider_rate_limit' }
          : undefined,
    });
    expect(result.sealedTest?.status).toBe('not_run');
    if (result.sealedTest?.status !== 'not_run') {
      throw new Error('expected not_run');
    }
    expect(result.sealedTest.reason).toContain('a prefix mean is not a test');
    expect(result.sealedTest.reason).toContain('discarded');
    expect((result.warnings ?? []).map((w) => w.code)).toContain(
      'sealed_test_not_run'
    );
    // Nothing anywhere on the result publishes a sealed delta.
    expect(JSON.stringify(result)).not.toContain('influencedNoDecision');
    expect(sealedIds.size).toBe(2);
  });

  it('budgets the re-draw allowance so one discard cannot starve the second pass', async () => {
    const { self, metric } = transferFixture();
    let fired = false;
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      sealedTest: SEALED,
      // Exactly ONE discarded sealed attempt. Sized at `2 x |sealed| x
      // runsPerTask` the re-draw is paid out of the FINAL pass, which then
      // executes zero runs and reports `mean: 0` as the run's result.
      classifyTermination: ({ task }: any) => {
        if (fired || String(task?.id ?? '') !== 's1') return undefined;
        fired = true;
        return { kind: 'environment_failure', cause: 'provider_rate_limit' };
      },
    });
    expect(fired).toBe(true);
    expect(result.sealedTest?.status).toBe('completed');
    const report = result.sealedTest!;
    if (report.status === 'not_run') throw new Error('expected a sealed test');
    // 2 passes x 2 sealed tasks = 4 scored attempts, PLUS the discarded one
    // the re-draw replaced. A budget of exactly 4 pays for the re-draw out of
    // the final pass, which then executes nothing at all.
    expect(report.accounting.metricCalls).toBe(5);
    expect(report.baseline.complete).toBe(true);
    expect(report.final.complete).toBe(true);
    expect(report.final.executedRuns).toBe(2);
    expect(report.baseline.mean).toBeCloseTo(0.2, 9);
    expect(report.final.mean).toBeCloseTo(0.7, 9);
    expect(report.delta).toBeCloseTo(0.5, 9);
  });

  it('names the sealed test, not the control arm, when its restore fails', async () => {
    const { handle, self, metric } = transferFixture();
    const sealedIds = new Set(SEALED.map((task) => task.id));
    let sealedStarted = false;
    const inner = self._forwardForEvaluation;
    self._forwardForEvaluation = async (ai: any, task: any) => {
      if (sealedIds.has(String(task?.id ?? ''))) sealedStarted = true;
      return await inner(ai, task);
    };
    const guarded = {
      ...handle,
      load: (snapshot: any) => {
        const bullets = Object.values(
          snapshot?.playbook?.sections ?? {}
        ).flat();
        const hasNoise = (bullets as { id: string }[]).some(
          (bullet) => bullet.id === 'noise'
        );
        // Fail only the RETURN restore of the sealed test's baseline pass:
        // the live artifact is the pruned one, which no longer has 'noise'.
        if (sealedStarted && !hasNoise) throw new Error('load exploded');
        return handle.load(snapshot);
      },
    };
    self.getPlaybook = () => guarded;
    const error = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      // NO control arm is configured at all.
      sealedTest: SEALED,
    }).catch((err) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect(error.code).toBe('sealed_test_failed');
    expect(error.phase).toBe('sealed_test');
    expect(error.message).toContain('the sealed test');
    expect(error.message).not.toContain('control arm');
    expect(error.playbookSnapshot).toBeDefined();
  });

  it('reads the baseline artifact even after a run-level rollback', async () => {
    const { handle, self, metric, targets } = transferFixture();
    const before = JSON.stringify(handle.current());
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
      gates: { transfer: 'require' },
      sealedTest: SEALED,
    });
    expect(result.applied).toBe('rolled_back');
    // The rolled-back artifact IS the baseline, so there is no artifact change
    // left to test and the report says that instead of reporting a zero.
    expect(result.sealedTest?.status).toBe('not_run');
    expect(JSON.stringify(handle.current())).toBe(before);
  });
});

// --- budget, gate observability and abort (review B1/M1/M2/M5, minor 7) -----

describe('the transfer matrix under re-draws, dry runs and abort', () => {
  it('gives every cell its own budget, so one target cannot starve another', async () => {
    const { self, metric, targets } = transferFixture();
    let fired = false;
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
      gates: { transfer: 'warn' },
      // One discard, in the FIRST target's anchor pass. With one flat
      // matrix-wide counter its re-draw is spent out of the LAST target's
      // pass, which then reads as an incomplete cell and fails a required
      // gate naming a target that was merely starved.
      classifyTermination: ({ prediction }: any) => {
        if (fired || String(prediction?.output?.ai ?? '') !== 'sonnet') {
          return undefined;
        }
        fired = true;
        return { kind: 'environment_failure', cause: 'provider_rate_limit' };
      },
    });
    expect(fired).toBe(true);
    const report = result.transfer;
    if (!report || report.status === 'not_run') {
      throw new Error(`expected a matrix, got ${report?.status}`);
    }
    expect(report.status).toBe('completed');
    const cells = cellsByKey(report.cells);
    expect(Object.keys(cells).sort()).toEqual([
      'nano:heldOut',
      'sonnet:heldOut',
    ]);
    for (const cell of report.cells) {
      expect(cell.anchor.complete).toBe(true);
      expect(cell.candidate.complete).toBe(true);
      expect(cell.anchor.truncatedAtTaskIndex).toBeUndefined();
      expect(cell.candidate.truncatedAtTaskIndex).toBeUndefined();
    }
    // 2 targets x 2 passes x 2 held-out tasks = 8 scored attempts, PLUS the
    // discarded one the re-draw replaced. On one flat counter that ninth call
    // is taken out of the last cell, which then reads as incomplete.
    expect(report.accounting.metricCalls).toBe(9);
    const codes = (result.warnings ?? []).map((w) => w.code);
    expect(codes).not.toContain('transfer_unmeasured');
  });

  it('names budget exhaustion as exhaustion rather than blaming the target', () => {
    const short = transferReportFrom({
      floor: DEFAULT_TRANSFER_REGRESSION_FLOOR,
      cells: [
        {
          targetId: 'nano',
          split: 'heldOut',
          anchor: {
            mean: 0.5,
            executedRuns: 2,
            discardedRuns: 0,
            expectedRuns: 2,
            complete: true,
          },
          candidate: {
            mean: 0.9,
            executedRuns: 1,
            discardedRuns: 0,
            expectedRuns: 2,
            complete: false,
            truncatedAtTaskIndex: 1,
          },
          delta: 0.4,
          interval: {
            point: 0.4,
            lower: 0.4,
            upper: 0.4,
            level: 0.95,
            resamples: 0,
            unit: 'task',
            clusters: 1,
            seed: 1,
            direction: 'unresolved',
          },
          regressed: false,
        },
      ],
      accounting: {} as any,
      expectedCells: 1,
    });
    const verdict = transferVerdict({ report: short });
    // A prefix mean of 0.9 would otherwise read as a large WIN for this target.
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain('ran out of its own metric budget');
    expect(verdict.detail).toContain('transfer.maxMetricCalls');
    expect(transferComparisonMade(short)).toBe(false);
  });

  it('reports a failing required gate on a dry run instead of going silent', async () => {
    const { self, metric, targets } = transferFixture();
    const gated = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      apply: false,
      transfer: { targets },
      gates: { transfer: 'require' },
    });
    // Nothing was applied, so nothing is rolled back — but the gate is not
    // allowed to be invisible.
    expect(gated.applied).toBe('dry_run');
    const warning = (gated.warnings ?? []).find(
      (w) => w.code === 'transfer_cell_regressed'
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("The 'require' transfer gate failed");
    expect(warning?.message).toContain('dry run');
    // ... and it is distinguishable from having no gate at all.
    const { self: s2, metric: m2, targets: t2 } = transferFixture();
    const off = await evolveAgentPlaybook(s2 as any, DATASET, {
      metric: m2,
      scoreThreshold: 0,
      prune: PRUNE,
      apply: false,
      transfer: { targets: t2 },
    });
    const offWarning = (off.warnings ?? []).find(
      (w) => w.code === 'transfer_cell_regressed'
    );
    expect(offWarning?.message).not.toContain('transfer gate failed');
    expect(offWarning?.message).not.toContain('dry run');
    expect(warning?.message).not.toBe(offWarning?.message);
  });

  it('says nothing changed rather than paying to measure noise', async () => {
    const { self, metric, targets, observations } = transferFixture();
    const result = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      // No prune and no accepted proposal: the final artifact IS the baseline.
      scoreThreshold: 0,
      transfer: { targets },
      gates: { transfer: 'warn' },
    });
    expect(result.outcomes.filter((o) => o.accepted)).toHaveLength(0);
    expect(result.transfer?.status).toBe('not_run');
    if (result.transfer?.status !== 'not_run')
      throw new Error('expected not_run');
    expect(result.transfer.reason).toContain('no artifact change');
    // The anchor pass ran (phase 3, before any mutation) and the candidate
    // pass did NOT: the caller's own services are never charged to measure
    // run-to-run noise.
    const targetCalls = observations.filter((o) => o.ai !== 'primary');
    expect(targetCalls).toHaveLength(4);
    expect(targetCalls.every((o) => o.noise)).toBe(true);
  });

  it('rethrows an abort from the anchor pass, the candidate pass and the sealed test', async () => {
    for (const [marker, phase] of [
      ['anchor pass', 'transfer'],
      ['candidate pass', 'transfer'],
      ['sealed task(s)', 'sealed_test'],
    ] as const) {
      const { self, metric, targets } = transferFixture();
      const controller = new AbortController();
      await expect(
        evolveAgentPlaybook(self as any, DATASET, {
          metric,
          scoreThreshold: 0,
          prune: PRUNE,
          transfer: { targets },
          gates: { transfer: 'warn' },
          sealedTest: SEALED,
          abortSignal: controller.signal,
          onProgress: (event: any) => {
            if (
              event.phase === phase &&
              String(event.message).includes(marker)
            ) {
              controller.abort();
            }
          },
        })
      ).rejects.toThrow('aborted');
      // An abort is never laundered into a soft `not_run` reason string.
      expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
    }
  });

  it('surfaces a typed evidence error from a transfer pass under its own code', async () => {
    const { self, metric, targets } = transferFixture();
    const error = await evolveAgentPlaybook(self as any, DATASET, {
      metric,
      scoreThreshold: 0,
      prune: PRUNE,
      transfer: { targets },
      // Throws only on a TARGET's attempt, so the throw happens inside the
      // transfer anchor pass. Folded into a `not_run` reason string its `code`
      // and `phase` are gone and a fail-closed throw reads as a soft warning.
      classifyTermination: ({ prediction }: any) => {
        if (String(prediction?.output?.ai ?? 'primary') !== 'primary') {
          throw new Error('classifier blew up on a target');
        }
        return undefined;
      },
    }).catch((err) => err);
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect(error.code).toBe('classifier_invalid');
  });
});
