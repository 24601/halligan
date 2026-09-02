import { describe, expect, it, vi } from 'vitest';
import { renderPlaybook } from '../../../dsp/optimizers/acePlaybook.js';
import type {
  AxACEBullet,
  AxACEPlaybook,
} from '../../../dsp/optimizers/aceTypes.js';
import { evaluateGateChain } from './gates.js';
import type { AxAgentPlaybookInterval } from './playbookEvidenceTypes.js';
import { axIsAgentPlaybookEvolveError } from './playbookEvidenceTypes.js';
import { evolveAgentPlaybook } from './playbookEvolve.js';
import { buildPruneRationaleText, collectEvictions } from './proposals.js';
import {
  applyPrune,
  isPrunableVerdict,
  pruneCandidateRanking,
  pruneOverflowSet,
  redundancyVerdictOf,
  renderedTokensOf,
  selectPruneProposals,
  transformPlaybookForPrune,
} from './pruning.js';

// --- local factories -------------------------------------------------------

const NOW_ISO = '2026-01-01T00:00:00.000Z';

const bulletOf = (
  id: string,
  overrides: Partial<AxACEBullet> = {}
): AxACEBullet => ({
  id,
  section: 'failures_to_avoid',
  content: `${id} guidance body that is long enough to cost tokens`,
  helpfulCount: 0,
  harmfulCount: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
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
    // Deliberately WRONG so a test can prove the recompute actually ran.
    bulletCount: 999,
    helpfulCount: 999,
    harmfulCount: 999,
    tokenEstimate: 999,
  },
  updatedAt: NOW_ISO,
});

const intervalOf = (
  lower: number,
  upper: number,
  direction: AxAgentPlaybookInterval['direction']
): AxAgentPlaybookInterval => ({
  point: (lower + upper) / 2,
  lower,
  upper,
  level: 0.95,
  resamples: 1000,
  unit: 'task',
  clusters: 3,
  seed: 7,
  direction,
});

/** An ACE-shaped handle: real snapshots, real load/rollback, spied evidence. */
function pruneHandle(playbook: AxACEPlaybook) {
  let state = {
    playbook: JSON.parse(JSON.stringify(playbook)) as AxACEPlaybook,
    artifact: {
      playbook: JSON.parse(JSON.stringify(playbook)) as AxACEPlaybook,
      feedback: [] as any[],
      history: [] as any[],
    },
  };
  const recordEvidence = vi.fn((bulletIds: readonly string[]) => {
    // Mirrors the engine: an UPDATE delta plus a history entry, and a REMOVED
    // bullet cannot be stamped at all.
    const present = bulletIds.filter((id) =>
      Object.values(state.playbook.sections).some((bullets) =>
        bullets.some((bullet) => bullet.id === id)
      )
    );
    if (present.length === 0) return [];
    state.artifact.history.push({
      source: 'agent-evolve',
      epoch: -1,
      exampleIndex: -1,
      operations: present.map((id) => ({
        type: 'UPDATE',
        section: 'failures_to_avoid',
        bulletId: id,
      })),
      updatedBulletIds: present,
    });
    return present;
  });
  return {
    recordEvidence,
    getState: () => JSON.parse(JSON.stringify(state)),
    load: (snapshot: any) => {
      state = JSON.parse(JSON.stringify(snapshot));
    },
    current: () => JSON.parse(JSON.stringify(state)),
  };
}

// --- the snapshot transform ------------------------------------------------

describe('prune snapshot transform', () => {
  it('removes a bullet, recomputes stats, and leaves the source untouched', () => {
    const source = playbookOf([bulletOf('b1'), bulletOf('b2')]);
    const before = JSON.stringify(source);
    const { playbook, changes } = transformPlaybookForPrune({
      playbook: source,
      bulletIds: ['b1'],
      operation: 'remove',
      reason: 'redundant',
      nowIso: NOW_ISO,
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(
      playbook.sections.failures_to_avoid?.map((bullet) => bullet.id)
    ).toEqual(['b2']);
    // The stats were seeded at 999: an implementation that skips the recompute
    // that `applyCuratorOperations` would have done for it fails right here.
    expect(playbook.stats.bulletCount).toBe(1);
    expect(playbook.stats.tokenEstimate).toBeLessThan(999);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.bulletId).toBe('b1');
    expect(changes[0]?.after).toBeUndefined();
  });

  it('deprecate keeps the bullet in the snapshot and drops it from the render', () => {
    const source = playbookOf([bulletOf('b1'), bulletOf('b2')]);
    const { playbook, changes } = transformPlaybookForPrune({
      playbook: source,
      bulletIds: ['b1'],
      operation: 'deprecate',
      reason: 'redundant under leave-one-out',
      nowIso: NOW_ISO,
    });
    const kept = playbook.sections.failures_to_avoid?.find(
      (bullet) => bullet.id === 'b1'
    );
    expect(kept).toBeDefined();
    expect(kept?.evidence?.lifecycle).toEqual({
      status: 'deprecated',
      reason: 'redundant under leave-one-out',
    });
    expect(kept?.updatedAt).toBe(NOW_ISO);
    // Reversibility is the point of `deprecate`: the record survives, the
    // render does not.
    expect(renderPlaybook(playbook, { now: NOW_ISO })).not.toContain('[b1]');
    expect(renderPlaybook(playbook, { now: NOW_ISO })).toContain('[b2]');
    expect(changes[0]?.after?.evidence?.lifecycle?.status).toBe('deprecated');
  });

  it('refuses an unknown id, a duplicate id, and an empty proposal', () => {
    const source = playbookOf([bulletOf('b1')]);
    for (const [ids, pattern] of [
      [['nope'], /not in the playbook/],
      [['b1', 'b1'], /more than once/],
      [[], /named no bullets/],
    ] as const) {
      try {
        transformPlaybookForPrune({
          playbook: source,
          bulletIds: ids,
          operation: 'remove',
          reason: 'r',
          nowIso: NOW_ISO,
        });
        expect.unreachable('the transform should have refused');
      } catch (error) {
        expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
        expect((error as { code: string }).code).toBe('prune_apply_failed');
        expect((error as Error).message).toMatch(pattern);
      }
    }
  });

  it('refuses a transform that would leave a structurally invalid bullet', () => {
    // The curate path gets this validation from `applyCuratorOperations`; the
    // snapshot transform has to replace it explicitly, and this is the test
    // that proves the replacement exists.
    const broken = bulletOf('b2');
    (broken as unknown as { evidence: unknown }).evidence = {
      confidence: 'high',
    };
    const source = playbookOf([bulletOf('b1'), broken]);
    expect(() =>
      transformPlaybookForPrune({
        playbook: source,
        bulletIds: ['b1'],
        operation: 'remove',
        reason: 'r',
        nowIso: NOW_ISO,
      })
    ).toThrow(/failed structural validation at bullet 'b2'/);
  });
});

// --- ranking and the injected clock ---------------------------------------

describe('prune candidate ranking', () => {
  it('ranks least-valuable first and skips bullets the render already drops', () => {
    const ranking = pruneCandidateRanking(
      playbookOf([
        bulletOf('useful', { helpfulCount: 5 }),
        bulletOf('harmful', { helpfulCount: 0, harmfulCount: 3 }),
        bulletOf('idle', {
          helpfulCount: 0,
          harmfulCount: 0,
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
        bulletOf('gone', {
          evidence: { lifecycle: { status: 'deprecated' } },
        }),
      ]),
      NOW_ISO
    );
    expect(ranking.map((ref) => ref.bullet.id)).toEqual([
      'harmful',
      'idle',
      'useful',
    ]);
    // An already-deprecated bullet costs zero rendered tokens, so proposing it
    // would spend a held-out evaluation to free nothing.
    expect(ranking.map((ref) => ref.bullet.id)).not.toContain('gone');
  });

  it('evaluates lifecycle expiry against the injected clock, not Date.now', () => {
    const playbook = playbookOf([
      bulletOf('expiring', {
        evidence: { lifecycle: { expiresAt: '2026-06-01T00:00:00.000Z' } },
      }),
      bulletOf('permanent'),
    ]);
    const beforeExpiry = pruneCandidateRanking(
      playbook,
      '2026-01-01T00:00:00.000Z'
    );
    expect(beforeExpiry.map((ref) => ref.bullet.id)).toContain('expiring');
    const afterExpiry = pruneCandidateRanking(
      playbook,
      '2027-01-01T00:00:00.000Z'
    );
    expect(afterExpiry.map((ref) => ref.bullet.id)).toEqual(['permanent']);
    // And the same clock decides the rendered size the budget is measured
    // against, so a frozen clock produces a reproducible reading.
    expect(renderedTokensOf(playbook, '2027-01-01T00:00:00.000Z')).toBeLessThan(
      renderedTokensOf(playbook, '2026-01-01T00:00:00.000Z')
    );
  });
});

// --- verdicts and proposal selection ---------------------------------------

describe('leave-one-out verdicts', () => {
  it('never calls an unresolved reading redundant without a variance band', () => {
    // Without a noise floor there is nothing to compare a null result against,
    // so "we could not tell" must not be reported as "it does nothing".
    expect(
      redundancyVerdictOf({
        heldOutDelta: 0.04,
        interval: intervalOf(-0.1, 0.2, 'unresolved'),
      })
    ).toBe('unresolved');
    expect(
      redundancyVerdictOf({
        heldOutDelta: 0.04,
        interval: intervalOf(-0.1, 0.2, 'unresolved'),
        bandSpread: 0.05,
      })
    ).toBe('redundant');
    expect(
      redundancyVerdictOf({
        heldOutDelta: -0.3,
        interval: intervalOf(-0.4, -0.2, 'negative'),
      })
    ).toBe('load_bearing');
    expect(
      redundancyVerdictOf({
        heldOutDelta: 0.3,
        interval: intervalOf(0.2, 0.4, 'positive'),
      })
    ).toBe('harmful');
    expect(isPrunableVerdict('load_bearing')).toBe(false);
    expect(isPrunableVerdict('unresolved')).toBe(false);
    expect(isPrunableVerdict('redundant')).toBe(true);
    expect(isPrunableVerdict('harmful')).toBe(true);
  });
});

describe('prune proposal selection', () => {
  const playbook = playbookOf([
    bulletOf('small', { content: 'short' }),
    bulletOf('big', { content: 'a much longer bullet body '.repeat(6) }),
    bulletOf('keeper'),
  ]);
  const entries = [
    {
      bulletId: 'keeper',
      section: 'failures_to_avoid',
      heldOutDelta: -0.4,
      interval: intervalOf(-0.5, -0.3, 'negative'),
      verdict: 'load_bearing' as const,
      renderedTokens: 40,
    },
    {
      bulletId: 'small',
      section: 'failures_to_avoid',
      heldOutDelta: 0.2,
      interval: intervalOf(0.1, 0.3, 'positive'),
      verdict: 'harmful' as const,
      renderedTokens: 2,
    },
    {
      bulletId: 'big',
      section: 'failures_to_avoid',
      heldOutDelta: 0.0,
      interval: intervalOf(-0.1, 0.1, 'unresolved'),
      verdict: 'redundant' as const,
      renderedTokens: 40,
    },
  ];
  const thresholds = {
    maxCurrentLoss: 0,
    maxHeldOutLoss: 0.01,
    minTokenReduction: 1,
  };

  it('never proposes a load-bearing bullet and orders by rendered size', () => {
    const [proposal] = selectPruneProposals({
      entries,
      playbook,
      operation: 'remove',
      trigger: 'redundancy_sweep',
      thresholds,
      nowIso: NOW_ISO,
    });
    expect(proposal).toBeDefined();
    expect(proposal!.bulletIds).toEqual(['big', 'small']);
    expect(proposal!.bulletIds).not.toContain('keeper');
    expect(proposal!.renderedTokensAfter).toBeLessThan(
      proposal!.renderedTokensBefore
    );
    expect(proposal!.trigger).toBe('redundancy_sweep');
  });

  it('records the thresholds it was judged by, not the retention policy', () => {
    const [proposal] = selectPruneProposals({
      entries,
      playbook,
      operation: 'deprecate',
      trigger: 'rendered_size_budget',
      thresholds: {
        maxCurrentLoss: 0.02,
        maxHeldOutLoss: 0.03,
        minTokenReduction: 4,
      },
      nowIso: NOW_ISO,
    });
    // The retention receipt's `thresholds.minCurrentGain` describes the POLICY.
    // These describe the rule this prune was actually judged by, so the two can
    // never be confused on the outcome.
    expect(proposal!.appliedThresholds).toEqual({
      maxCurrentLoss: 0.02,
      maxHeldOutLoss: 0.03,
      minTokenReduction: 4,
    });
  });

  it('restricts to the overflow set when the size budget triggered it', () => {
    const proposals = selectPruneProposals({
      entries,
      playbook,
      operation: 'remove',
      trigger: 'rendered_size_budget',
      thresholds,
      nowIso: NOW_ISO,
      restrictTo: new Set(['small']),
    });
    expect(proposals[0]?.bulletIds).toEqual(['small']);
  });

  describe('the overflow set', () => {
    const withoutIds = (bulletIds: readonly string[]): number =>
      renderedTokensOf(
        transformPlaybookForPrune({
          playbook,
          bulletIds,
          operation: 'remove',
          reason: 'measurement',
          nowIso: NOW_ISO,
        }).playbook,
        NOW_ISO
      );

    it('stops at the smallest prefix that reaches the ceiling', () => {
      // `entries` are in ranking order, so the prunable prefix is
      // [small, big]. A ceiling that removing `small` alone already satisfies
      // must not cost `big` as well.
      const ceiling = withoutIds(['small']);
      expect(ceiling).toBeLessThan(renderedTokensOf(playbook, NOW_ISO));
      const overflow = pruneOverflowSet({
        entries,
        playbook,
        operation: 'remove',
        maxRenderedTokens: ceiling,
        nowIso: NOW_ISO,
      });
      expect([...overflow]).toEqual(['small']);
      // The counter-assertion: `big` really was prunable and really is bigger.
      expect(overflow.has('big')).toBe(false);
      expect(withoutIds(['big'])).toBeLessThan(ceiling);
    });

    it('takes every prunable bullet when no prefix reaches the ceiling', () => {
      const overflow = pruneOverflowSet({
        entries,
        playbook,
        operation: 'remove',
        maxRenderedTokens: 0,
        nowIso: NOW_ISO,
      });
      expect([...overflow].sort()).toEqual(['big', 'small']);
      // Never the load-bearing one, whatever the ceiling asks for.
      expect(overflow.has('keeper')).toBe(false);
    });

    it('never names a bullet the sweep did not call prunable', () => {
      const overflow = pruneOverflowSet({
        entries: entries.filter((entry) => entry.verdict === 'load_bearing'),
        playbook,
        operation: 'remove',
        maxRenderedTokens: 0,
        nowIso: NOW_ISO,
      });
      expect(overflow.size).toBe(0);
    });
  });

  it('proposes nothing when every reading is load-bearing or unresolved', () => {
    expect(
      selectPruneProposals({
        entries: entries.filter((entry) => entry.verdict === 'load_bearing'),
        playbook,
        operation: 'remove',
        trigger: 'redundancy_sweep',
        thresholds,
        nowIso: NOW_ISO,
      })
    ).toEqual([]);
  });
});

// --- the mutation primitive ------------------------------------------------

describe('applyPrune', () => {
  const proposalOf = (operation: 'remove' | 'deprecate') => ({
    pruneId: `prune-${operation}-b1`,
    operation,
    bulletIds: ['b1'] as const,
    trigger: 'redundancy_sweep' as const,
    reason: 'no measured held-out cost',
    renderedTokensBefore: 40,
    renderedTokensAfter: 20,
    appliedThresholds: {
      maxCurrentLoss: 0,
      maxHeldOutLoss: 0.01,
      minTokenReduction: 1,
    },
  });

  it('appends an artifact-history entry with updatedBulletIds and sets bulletIds', () => {
    const handle = pruneHandle(playbookOf([bulletOf('b1'), bulletOf('b2')]));
    const prune = proposalOf('remove');
    const applied = applyPrune({
      handle,
      proposal: prune,
      legacyProposal: buildPruneRationaleText(prune),
      nowIso: NOW_ISO,
    });
    // A bare `load()` appends no history entry, so the curate path's derived
    // `bulletIds` would be empty and the accept path would stamp nothing.
    expect(applied.bulletIds).toEqual(['b1']);
    const history = handle.current().artifact.history;
    const pruneEntry = history.at(-1);
    expect(pruneEntry.updatedBulletIds).toEqual(['b1']);
    expect(pruneEntry.source).toBe('agent-evolve');
    expect(pruneEntry.operations[0]).toMatchObject({
      type: 'REMOVE',
      bulletId: 'b1',
      metadata: { axPrune: 'remove', axPruneId: prune.pruneId },
    });
    expect(pruneEntry.changes[0].before.id).toBe('b1');
    expect(
      handle
        .current()
        .playbook.sections.failures_to_avoid.map(
          (bullet: AxACEBullet) => bullet.id
        )
    ).toEqual(['b2']);
  });

  it('stamps evidence BEFORE the transform so a removal has a bullet to stamp', () => {
    const handle = pruneHandle(playbookOf([bulletOf('b1'), bulletOf('b2')]));
    const prune = proposalOf('remove');
    applyPrune({
      handle,
      proposal: prune,
      legacyProposal: buildPruneRationaleText(prune),
      nowIso: NOW_ISO,
    });
    expect(handle.recordEvidence).toHaveBeenCalledWith(
      ['b1'],
      expect.objectContaining({
        source: 'agent-evolve',
        sourceRunId: prune.pruneId,
      })
    );
    // The stamp landed while the bullet still existed, so it survives in the
    // artifact history the transform was built from.
    const history = handle.current().artifact.history;
    expect(
      history.some((entry: any) => entry.operations[0].type === 'UPDATE')
    ).toBe(true);
    // A stamp written after the transform would have found nothing: the mock
    // engine, like the real one, refuses to stamp a vanished bullet.
    handle.recordEvidence.mockClear();
    expect(handle.recordEvidence(['b1'])).toEqual([]);
  });

  it('rolls back to the exact pre-apply snapshot, evidence included', () => {
    const handle = pruneHandle(playbookOf([bulletOf('b1'), bulletOf('b2')]));
    const before = JSON.stringify(handle.current());
    const prune = proposalOf('deprecate');
    const applied = applyPrune({
      handle,
      proposal: prune,
      legacyProposal: buildPruneRationaleText(prune),
      nowIso: NOW_ISO,
    });
    expect(JSON.stringify(handle.current())).not.toBe(before);
    applied.rollback();
    expect(JSON.stringify(handle.current())).toBe(before);
  });

  it('rolls back and rethrows when the transform refuses', () => {
    const handle = pruneHandle(playbookOf([bulletOf('b1')]));
    const before = JSON.stringify(handle.current());
    const prune = { ...proposalOf('remove'), bulletIds: ['ghost'] as const };
    expect(() =>
      applyPrune({
        handle,
        proposal: prune,
        legacyProposal: buildPruneRationaleText(prune),
        nowIso: NOW_ISO,
      })
    ).toThrow(/not in the playbook/);
    expect(JSON.stringify(handle.current())).toBe(before);
  });

  it('refuses a handle that cannot transform a snapshot', () => {
    const prune = proposalOf('remove');
    expect(() =>
      applyPrune({
        handle: { getState: () => ({ playbook: {} }) },
        proposal: prune,
        legacyProposal: buildPruneRationaleText(prune),
        nowIso: NOW_ISO,
      })
    ).toThrow(/no playbook handle capable of a snapshot transform/);
  });
});

// --- the legacy proposal shape ---------------------------------------------

describe('prune legacy proposal fields', () => {
  it('populates every field a pre-evidence consumer reads', () => {
    const proposal = buildPruneRationaleText({
      pruneId: 'prune-remove-b1_b2',
      operation: 'remove',
      bulletIds: ['b1', 'b2'],
      trigger: 'rendered_size_budget',
      reason: 'no measured held-out cost',
      renderedTokensBefore: 90,
      renderedTokensAfter: 40,
      appliedThresholds: {
        maxCurrentLoss: 0,
        maxHeldOutLoss: 0.01,
        minTokenReduction: 1,
      },
    });
    expect(proposal.weaknessId).toBe('prune-remove-b1_b2');
    expect(proposal.clusterSignature).toBe('prune:remove');
    expect(proposal.feedback).toContain('REMOVE');
    expect(proposal.feedback).toContain('b1, b2');
    expect(proposal.feedback).toContain('90 -> 40 (50 freed)');
    expect(proposal.feedback).toContain('maxCurrentLoss 0');
  });
});

// --- the eviction channel --------------------------------------------------

describe('curate-path eviction instrumentation', () => {
  const snapshotWith = (history: unknown[]) =>
    ({ playbook: playbookOf([]), artifact: { history } }) as any;

  it('records a section-overflow eviction and ignores an ordinary removal', () => {
    const before = snapshotWith([]);
    const after = snapshotWith([
      {
        operations: [
          {
            type: 'REMOVE',
            section: 'failures_to_avoid',
            bulletId: 'evicted',
            metadata: { autoPruned: true, removedAt: NOW_ISO },
          },
          {
            type: 'REMOVE',
            section: 'failures_to_avoid',
            bulletId: 'curator-asked',
          },
          { type: 'ADD', section: 'failures_to_avoid', bulletId: 'new' },
        ],
      },
    ]);
    expect(collectEvictions({ before, after, weaknessId: 'w1' })).toEqual([
      {
        bulletId: 'evicted',
        section: 'failures_to_avoid',
        weaknessId: 'w1',
        cause: 'section_overflow',
      },
    ]);
  });

  it('reads only the entries this application added', () => {
    const priorEntry = {
      operations: [
        {
          type: 'REMOVE',
          section: 's',
          bulletId: 'old',
          metadata: { autoPruned: true },
        },
      ],
    };
    expect(
      collectEvictions({
        before: snapshotWith([priorEntry]),
        after: snapshotWith([priorEntry]),
        weaknessId: 'w1',
      })
    ).toEqual([]);
  });
});

// --- the prune variant of the gate chain -----------------------------------

describe('prune gate variant', () => {
  const pruneInput = (overrides: Record<string, unknown> = {}) =>
    ({
      kind: 'prune' as const,
      gain: {
        revalComplete: true,
        currentGain: 0,
        threshold: 0,
      },
      heldOut: { delta: 0, tolerance: 0.01 },
      pruneSize: {
        tokensBefore: 40,
        tokensAfter: 20,
        minTokenReduction: 1,
      },
      ...overrides,
    }) as any;

  it('lets a zero-gain prune reach gate 7 instead of dying at gate 1', async () => {
    const report = await evaluateGateChain(pruneInput());
    const gain = report.entries.find((entry) => entry.id === 'gain');
    const size = report.entries.find((entry) => entry.id === 'prune_size');
    // A curate-variant implementation compares 0 against `minCurrentGain`
    // (0.05 by default) and rejects here, which is what made revision 1's
    // pruning decision inert.
    expect(gain?.status).toBe('pass');
    expect(size?.status).toBe('pass');
    expect(report.failedGate).toBeUndefined();
  });

  it('is a real threshold, not a bypass', async () => {
    const report = await evaluateGateChain(
      pruneInput({
        gain: { revalComplete: true, currentGain: -0.2, threshold: 0 },
      })
    );
    expect(report.failedGate).toBe('gain');
    expect(
      report.entries.find((entry) => entry.id === 'gain')?.detail
    ).toContain('prune current-task loss 0.200');
  });

  it('rejects a prune that frees nothing', async () => {
    const report = await evaluateGateChain(
      pruneInput({
        pruneSize: { tokensBefore: 40, tokensAfter: 40, minTokenReduction: 1 },
      })
    );
    expect(report.failedGate).toBe('prune_size');
  });

  it('skips reach for a prune: a removed bullet has none', async () => {
    const report = await evaluateGateChain(
      pruneInput({
        reach: {
          mode: 'require',
          report: {
            basis: 'host_probe',
            counterfactual: false,
            gateEligible: true,
            splits: [],
          },
        },
      })
    );
    expect(report.entries.find((entry) => entry.id === 'reach')?.status).toBe(
      'skipped'
    );
  });
});

// --- the prune phase, end to end ------------------------------------------

/**
 * A stub agent over a real ACE-shaped playbook. The score is a pure function of
 * which bullets survive, so the leave-one-out sweep reads a real signal:
 * `noise` costs 0.5 (removal HELPS) and `keeper` earns 0.7 (removal HURTS).
 */
function pruneFixture(options?: { extraBullets?: readonly AxACEBullet[] }) {
  const handle = pruneHandle(
    playbookOf([
      bulletOf('noise', { content: 'noisy guidance that misleads the actor' }),
      bulletOf('keeper', { content: 'load bearing guidance the actor needs' }),
      ...(options?.extraBullets ?? []),
    ])
  );
  const has = (id: string): boolean =>
    Object.values(handle.current().playbook.sections).some((bullets) =>
      (bullets as AxACEBullet[]).some((bullet) => bullet.id === id)
    );
  const self = {
    init: { ai: {} as any },
    getPlaybook: () => handle,
    _forwardForEvaluation: async () => ({
      completionType: 'final' as const,
      output: { noise: has('noise'), keeper: has('keeper') },
      actionLog: '',
      functionCalls: [],
      toolErrors: [],
      turnCount: 1,
      usage: [],
    }),
  };
  const metric = async ({ prediction, example }: any) => {
    // A retention slice is a HISTORICAL corpus: `noise` is what makes those
    // tasks pass, so removing it is a real capability loss there even while the
    // current corpus improves. That is the whole point of a retention gate.
    if (typeof example?.id === 'string' && example.id.startsWith('legacy')) {
      return prediction.output.noise ? 1 : 0;
    }
    const raw =
      (prediction.output.noise ? -0.5 : 0) +
      (prediction.output.keeper ? 0.7 : 0);
    return Math.max(0, Math.min(1, raw));
  };
  return { handle, self, metric };
}

/**
 * Two bullets whose removal HELPS, of very different rendered size, plus one
 * that is load-bearing. `bulk` outranks `chaff` in the sweep (higher
 * `harmfulCount`), so a ceiling that removing `bulk` alone already satisfies
 * must cost `chaff` nothing — even though `chaff` is prunable too.
 */
function overflowFixture() {
  const handle = pruneHandle(
    playbookOf([
      bulletOf('bulk', {
        harmfulCount: 5,
        content: `bulk guidance that misleads the actor ${'and costs many rendered tokens '.repeat(12)}`,
      }),
      bulletOf('chaff', { harmfulCount: 1, content: 'chaff misleads too' }),
      bulletOf('keeper', { content: 'load bearing guidance the actor needs' }),
    ])
  );
  const has = (id: string): boolean =>
    Object.values(handle.current().playbook.sections).some((bullets) =>
      (bullets as AxACEBullet[]).some((bullet) => bullet.id === id)
    );
  const self = {
    init: { ai: {} as any },
    getPlaybook: () => handle,
    _forwardForEvaluation: async () => ({
      completionType: 'final' as const,
      output: { bulk: has('bulk'), chaff: has('chaff'), keeper: has('keeper') },
      actionLog: '',
      functionCalls: [],
      toolErrors: [],
      turnCount: 1,
      usage: [],
    }),
  };
  const metric = async ({ prediction }: any) => {
    const raw =
      (prediction.output.bulk ? -0.4 : 0) +
      (prediction.output.chaff ? -0.3 : 0) +
      (prediction.output.keeper ? 0.9 : 0);
    return Math.max(0, Math.min(1, raw));
  };
  return { handle, self, metric };
}

const PRUNE_DATASET = {
  train: [
    { input: { q: 1 }, criteria: 'c', id: 't1' },
    { input: { q: 2 }, criteria: 'c', id: 't2' },
  ],
  validation: [
    { input: { q: 3 }, criteria: 'c', id: 'v1' },
    { input: { q: 4 }, criteria: 'c', id: 'v2' },
  ],
};

describe('the prune phase', () => {
  it('proposes only the bullet whose removal was shown to help, and applies it', async () => {
    const { handle, self, metric } = pruneFixture();
    const result = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      // No failure clusters, so nothing is mined and the prune phase is the
      // only mutation under test.
      scoreThreshold: 0,
      prune: { enabled: true, operation: 'remove' },
    });

    expect(result.redundancy?.status).toBe('completed');
    const entries =
      result.redundancy?.status === 'completed'
        ? result.redundancy.entries
        : [];
    expect(
      Object.fromEntries(
        entries.map((entry) => [entry.bulletId, entry.verdict])
      )
    ).toEqual({ noise: 'harmful', keeper: 'load_bearing' });

    const prune = result.outcomes.filter((outcome) => outcome.kind === 'prune');
    expect(prune).toHaveLength(1);
    expect(prune[0]?.accepted).toBe(true);
    expect(prune[0]?.prune?.bulletIds).toEqual(['noise']);
    expect(prune[0]?.prune?.trigger).toBe('redundancy_sweep');
    // The bullet the sweep called load-bearing is never proposed.
    expect(prune[0]?.prune?.bulletIds).not.toContain('keeper');
    expect(prune[0]?.proposal.clusterSignature).toBe('prune:remove');
    expect(prune[0]?.reason).toMatch(/freed \d+ rendered token/);
    expect(prune[0]?.evidence?.kind).toBe('prune');
    expect(prune[0]?.evidence?.decision).toBe('accepted');

    // The accepted removal is live and its stamp went to a NON-EMPTY id list.
    const live = handle
      .current()
      .playbook.sections.failures_to_avoid.map(
        (bullet: AxACEBullet) => bullet.id
      );
    expect(live).toEqual(['keeper']);
    const stamped = handle.recordEvidence.mock.calls.filter(
      ([ids]) => Array.isArray(ids) && ids.includes('noise')
    );
    expect(stamped.length).toBeGreaterThan(0);
    for (const [ids] of stamped) {
      expect((ids as string[]).length).toBeGreaterThan(0);
    }
    expect(result.final.heldIn).toBeGreaterThan(result.baseline.heldIn);
  });

  it('rejects and rolls back exactly when a prune loses a retention slice', async () => {
    const { handle, self, metric } = pruneFixture();
    const before = JSON.stringify(handle.current());
    const result = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      scoreThreshold: 0,
      prune: { enabled: true, operation: 'remove' },
      retentionPolicy: {
        evaluatorId: 'eval-1',
        minCurrentGain: 0.05,
        // Zero tolerance: the slice below LOSES when `noise` goes away, so the
        // prune pays the full retention price and fails it.
        maxWorstHistoricalLoss: 0,
        maxMeanHistoricalLoss: 0,
        slices: [
          {
            name: 'legacy',
            version: '2026-01',
            tasks: [{ input: { q: 9 }, criteria: 'c', id: 'legacy-1' }],
          },
        ],
      },
    });
    const prune = result.outcomes.find((outcome) => outcome.kind === 'prune');
    expect(prune).toBeDefined();
    // A prune pays the SAME retention receipt a curation does.
    expect(prune?.retention).toBeDefined();
    expect(prune?.retention?.policy.evaluatorId).toBe('eval-1');
    expect(prune?.retention?.thresholds.minCurrentGain).toBe(0.05);
    // ... and the prune records the thresholds it was actually judged by, so
    // the policy's 0.05 cannot be mistaken for the rule that decided it.
    expect(prune?.prune?.appliedThresholds.maxCurrentLoss).toBe(0);
    expect(prune?.accepted).toBe(false);
    expect(prune?.reason).toContain('retention gate failed');
    expect(JSON.stringify(handle.current())).toBe(before);
  });

  it('reports a rendered-size overflow and never truncates', async () => {
    const { handle, self, metric } = pruneFixture();
    const before = JSON.stringify(handle.current());
    const result = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      scoreThreshold: 0,
      prune: { enabled: true, maxRenderedTokens: 1, onOverflow: 'warn' },
    });
    const warning = result.warnings?.find(
      (entry) => entry.code === 'rendered_size_over_budget'
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('renderPlaybook emits every applicable');
    // `warn` records the overflow and changes nothing.
    expect(result.outcomes.some((outcome) => outcome.kind === 'prune')).toBe(
      false
    );
    expect(JSON.stringify(handle.current())).toBe(before);
  });

  it('emits prune proposals when the rendered playbook exceeds the budget', async () => {
    const { self, metric } = pruneFixture();
    const result = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      scoreThreshold: 0,
      prune: {
        enabled: true,
        operation: 'deprecate',
        maxRenderedTokens: 1,
        onOverflow: 'propose',
      },
    });
    expect(
      result.warnings?.some(
        (entry) => entry.code === 'rendered_size_over_budget'
      )
    ).toBe(true);
    const prune = result.outcomes.find((outcome) => outcome.kind === 'prune');
    expect(prune?.prune?.trigger).toBe('rendered_size_budget');
    expect(prune?.prune?.operation).toBe('deprecate');
    expect(prune?.accepted).toBe(true);
  });

  it('refuses to sweep without a validation set', async () => {
    const { self, metric } = pruneFixture();
    await expect(
      evolveAgentPlaybook(
        self as any,
        { train: PRUNE_DATASET.train },
        { metric, scoreThreshold: 0, prune: { enabled: true } }
      )
    ).rejects.toThrow(/measures selection, not redundancy/);
  });

  it('restricts a size-budget prune to the bullets the ceiling needs', async () => {
    const { handle, self, metric } = overflowFixture();
    const before = handle.current().playbook;
    const full = renderedTokensOf(before, NOW_ISO);
    // The exact ceiling removing `bulk` alone reaches. `chaff` is prunable and
    // freeing it too would be capability the budget never asked for.
    const ceiling = renderedTokensOf(
      transformPlaybookForPrune({
        playbook: before,
        bulletIds: ['bulk'],
        operation: 'remove',
        reason: 'measurement',
        nowIso: NOW_ISO,
      }).playbook,
      NOW_ISO
    );
    expect(ceiling).toBeLessThan(full);

    const result = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      scoreThreshold: 0,
      maxMetricCalls: 40,
      prune: {
        enabled: true,
        operation: 'remove',
        maxRenderedTokens: ceiling,
        onOverflow: 'propose',
      },
    });

    // Both noisy bullets really were prunable — that is what makes the
    // restriction observable rather than vacuous.
    const entries =
      result.redundancy?.status === 'completed' ||
      result.redundancy?.status === 'partial'
        ? result.redundancy.entries
        : [];
    expect(
      Object.fromEntries(
        entries.map((entry) => [entry.bulletId, entry.verdict])
      )
    ).toEqual({ bulk: 'harmful', chaff: 'harmful', keeper: 'load_bearing' });

    const prune = result.outcomes.filter((outcome) => outcome.kind === 'prune');
    expect(prune).toHaveLength(1);
    expect(prune[0]?.prune?.trigger).toBe('rendered_size_budget');
    expect(prune[0]?.prune?.bulletIds).toEqual(['bulk']);
    expect(prune[0]?.prune?.bulletIds).not.toContain('chaff');
    expect(prune[0]?.accepted).toBe(true);

    // The bullet outside the overflow set is still live.
    const live = handle
      .current()
      .playbook.sections.failures_to_avoid.map(
        (bullet: AxACEBullet) => bullet.id
      );
    expect(live.sort()).toEqual(['chaff', 'keeper']);

    // The disclosure is settled, not stale: it reports the render AFTER the
    // prune it triggered.
    const warning = result.warnings?.find(
      (entry) => entry.code === 'rendered_size_over_budget'
    );
    expect(warning?.message).toContain('within the ceiling');
    expect(warning?.message).not.toContain('still over the ceiling');
  });

  it('fails closed, named, when an ablation cannot be undone', async () => {
    const { handle, self, metric } = pruneFixture();
    let ablatedOnce = false;
    let restoreAttempts = 0;
    const bulletCount = (snapshot: any): number =>
      Object.values(snapshot.playbook.sections).reduce(
        (total: number, bullets: any) => total + bullets.length,
        0
      );
    const brittle = {
      ...handle,
      load: (snapshot: any) => {
        if (bulletCount(snapshot) < 2) {
          ablatedOnce = true;
          handle.load(snapshot);
          return;
        }
        if (ablatedOnce) {
          restoreAttempts++;
          throw new Error('the ACE handle refused the restore');
        }
        handle.load(snapshot);
      },
    };
    (self as any).getPlaybook = () => brittle;

    const error = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      scoreThreshold: 0,
      prune: { enabled: true, operation: 'remove' },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    // A raw ACE `load` error escaping from a `finally` would leave the caller
    // with no code, no phase and no idea which bullet is missing.
    expect(axIsAgentPlaybookEvolveError(error)).toBe(true);
    expect((error as any).code).toBe('prune_apply_failed');
    expect((error as any).phase).toBe('redundancy_ablation');
    expect((error as Error).message).toContain(
      'could not be undone after two attempts'
    );
    // The message names the bullet whose absence the live artifact now carries.
    expect((error as Error).message).toMatch(/ablation of bullet '\w+'/);
    expect((error as Error).message).toContain('indeterminate');
    expect((error as any).cause).toBeInstanceOf(AggregateError);
    // One bounded RETRY, exactly as the control-arm restore gets: two attempts,
    // never one and never a loop.
    expect(restoreAttempts).toBe(2);
  });

  it('is inert when prune is not enabled', async () => {
    const { handle, self, metric } = pruneFixture();
    const before = JSON.stringify(handle.current());
    const result = await evolveAgentPlaybook(self as any, PRUNE_DATASET, {
      metric,
      scoreThreshold: 0,
    });
    expect(result.redundancy).toBeUndefined();
    expect(result.outcomes.some((outcome) => outcome.kind === 'prune')).toBe(
      false
    );
    expect(JSON.stringify(handle.current())).toBe(before);
  });
});
