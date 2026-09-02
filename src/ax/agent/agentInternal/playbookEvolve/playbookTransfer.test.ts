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
      };
    };
    const zero = await run(0);
    const one = await run(1);
    // The sealed reading moved from -0 to +0 ... and nothing else moved at all.
    expect(zero.sealedDelta).toBe(0);
    expect(one.sealedDelta).toBe(0);
    const { sealedDelta: _z, ...zeroRest } = zero;
    const { sealedDelta: _o, ...oneRest } = one;
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
