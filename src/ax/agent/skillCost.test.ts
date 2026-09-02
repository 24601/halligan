import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  type AxAgentSkillCostProfile,
  type AxAgentVerifierRail,
  type AxAgentVerifierRailContext,
  axApplyVerificationBudget,
  axAttributeSkillCost,
  axDedupeRailDiagnostics,
  axInitialVerificationBudgetState,
  axRecordSkillLoad,
  axRunVerifierRail,
  axSkillValueScore,
  axUpdateSkillCostProfile,
} from './skillCost.js';

const NOW = '2026-01-01T00:00:00.000Z';

function profile(
  override: Partial<AxAgentSkillCostProfile> & { id: string }
): AxAgentSkillCostProfile {
  return {
    loads: 0,
    uses: 0,
    successes: 0,
    tokensTotal: 0,
    wallMsTotal: 0,
    verificationRoundsTotal: 0,
    updatedAt: NOW,
    ...override,
  };
}

function railContext(
  signal: AbortSignal
): Omit<AxAgentVerifierRailContext, 'timeoutMs'> {
  return {
    stage: 'executor',
    qualifiedName: 'tools.write',
    name: 'write',
    args: {},
    result: 'ok',
    signal,
  };
}

describe('axSkillValueScore', () => {
  it('ranks identically to similarity alone when every profile is absent', () => {
    const similarities = [0.9, 0.4, 0.7, 0.1];
    const byScore = [...similarities].sort(
      (left, right) =>
        axSkillValueScore(right, undefined) - axSkillValueScore(left, undefined)
    );
    expect(byScore).toEqual([...similarities].sort((a, b) => b - a));
  });

  it('preserves the relative order of profile-less skills in a mixed catalog', () => {
    // The trivial all-absent case cannot fail: with no profile the score is a
    // positive constant multiple of similarity. This mixed case can.
    const profiled = profile({
      id: 'profiled',
      uses: 20,
      successes: 20,
      tokensTotal: 200,
    });
    const entries = [
      { id: 'a', similarity: 0.8, profile: undefined },
      { id: 'p', similarity: 0.5, profile: profiled },
      { id: 'b', similarity: 0.6, profile: undefined },
      { id: 'c', similarity: 0.3, profile: undefined },
    ];
    const ranked = [...entries]
      .sort(
        (left, right) =>
          axSkillValueScore(right.similarity, right.profile) -
          axSkillValueScore(left.similarity, left.profile)
      )
      .map((entry) => entry.id)
      .filter((id) => id !== 'p');
    expect(ranked).toEqual(['a', 'b', 'c']);
  });

  it('scores a never-used skill at the 0.5 prior, not at 1.0', () => {
    expect(axSkillValueScore(1, undefined)).toBeCloseTo(0.5, 10);
    expect(axSkillValueScore(1, profile({ id: 'x' }))).toBeCloseTo(0.5, 10);
  });

  it('raises the score with a higher success rate at equal cost', () => {
    const good = profile({
      id: 'good',
      uses: 10,
      successes: 10,
      tokensTotal: 1000,
    });
    const bad = profile({
      id: 'bad',
      uses: 10,
      successes: 1,
      tokensTotal: 1000,
    });
    expect(axSkillValueScore(1, good)).toBeGreaterThan(
      axSkillValueScore(1, bad)
    );
  });

  it('lowers the score with a higher mean token cost at equal success', () => {
    const cheap = profile({
      id: 'cheap',
      uses: 10,
      successes: 5,
      tokensTotal: 1000,
    });
    const costly = profile({
      id: 'costly',
      uses: 10,
      successes: 5,
      tokensTotal: 100_000,
    });
    expect(axSkillValueScore(1, cheap)).toBeGreaterThan(
      axSkillValueScore(1, costly)
    );
  });

  it('cost weight 0 makes ranking cost-blind', () => {
    const cheap = profile({
      id: 'cheap',
      uses: 10,
      successes: 5,
      tokensTotal: 1000,
    });
    const costly = profile({
      id: 'costly',
      uses: 10,
      successes: 5,
      tokensTotal: 100_000,
    });
    expect(axSkillValueScore(1, cheap, { cost: 0 })).toBeCloseTo(
      axSkillValueScore(1, costly, { cost: 0 }),
      10
    );
  });

  it('never divides by zero for a profile with zero tokens and zero uses', () => {
    const score = axSkillValueScore(1, profile({ id: 'fresh' }));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });
});

describe('cost attribution', () => {
  it('splits a turn equally across declared ids', () => {
    expect(
      axAttributeSkillCost({
        declaredUsed: ['b', 'a', 'a'],
        tokens: 300,
        wallMs: 90,
        verificationRounds: 4,
        success: true,
      })
    ).toEqual([
      {
        id: 'a',
        success: true,
        tokensAttributed: 150,
        wallMs: 45,
        verificationRounds: 2,
      },
      {
        id: 'b',
        success: true,
        tokensAttributed: 150,
        wallMs: 45,
        verificationRounds: 2,
      },
    ]);
  });

  it('attributes nothing when no skill was declared used', () => {
    // Loaded is not used: a skill nobody declared accrues no cost and no use.
    expect(
      axAttributeSkillCost({ declaredUsed: [], tokens: 400, success: true })
    ).toEqual([]);
  });

  it('totals are order-independent', () => {
    const samples = [
      { id: 's', success: true, tokensAttributed: 10, wallMs: 1 },
      { id: 's', success: false, tokensAttributed: 20, wallMs: 2 },
      { id: 's', success: true, tokensAttributed: 30, wallMs: 3 },
    ];
    const fold = (order: typeof samples) =>
      order.reduce<AxAgentSkillCostProfile | undefined>(
        (acc, sample) => axUpdateSkillCostProfile(acc, sample, NOW),
        undefined
      );
    const forward = fold(samples);
    const reverse = fold([...samples].reverse());
    expect(reverse?.tokensTotal).toBe(forward?.tokensTotal);
    expect(reverse?.successes).toBe(forward?.successes);
    expect(reverse?.uses).toBe(forward?.uses);
  });

  it('increments loads without incrementing uses', () => {
    const loaded = axRecordSkillLoad(undefined, 's', NOW);
    expect(loaded).toMatchObject({ loads: 1, uses: 0, successes: 0 });
    const used = axUpdateSkillCostProfile(
      loaded,
      { id: 's', success: true },
      NOW
    );
    expect(used).toMatchObject({ loads: 1, uses: 1, successes: 1 });
  });
});

describe('verification budget', () => {
  it('reaches exceeded at maxRounds and stays exceeded', () => {
    let state = axInitialVerificationBudgetState();
    const budget = { maxRounds: 3 };
    state = axApplyVerificationBudget(state, budget);
    expect(state).toMatchObject({ rounds: 1, status: 'within' });
    state = axApplyVerificationBudget(state, budget);
    expect(state).toMatchObject({ rounds: 2, status: 'within' });
    state = axApplyVerificationBudget(state, budget);
    expect(state).toMatchObject({ rounds: 3, status: 'exceeded' });
    // Absorbing: further events change nothing at all.
    const after = axApplyVerificationBudget(state, budget);
    expect(after).toBe(state);
  });

  it('exceeds immediately for a zero budget', () => {
    const state = axApplyVerificationBudget(
      axInitialVerificationBudgetState(),
      { maxRounds: 0 }
    );
    expect(state.status).toBe('exceeded');
  });
});

describe('rail diagnostics', () => {
  it('injects only novel signatures', () => {
    const { novel, suppressed } = axDedupeRailDiagnostics(new Set(['seen']), [
      { signature: 'seen', code: 'c', message: 'm', severity: 'warn' },
      { signature: 'fresh', code: 'c', message: 'm', severity: 'warn' },
      { signature: 'fresh', code: 'c', message: 'm', severity: 'warn' },
    ]);
    expect(novel.map((entry) => entry.signature)).toEqual(['fresh']);
    expect(suppressed).toHaveLength(2);
  });

  it('suppresses a recurrence across turns', () => {
    const seen = new Set<string>();
    const produced = [
      { signature: 'same', code: 'c', message: 'm', severity: 'info' as const },
    ];
    const first = axDedupeRailDiagnostics(seen, produced);
    for (const entry of first.novel) seen.add(entry.signature);
    const second = axDedupeRailDiagnostics(seen, produced);
    expect(first.novel).toHaveLength(1);
    expect(second.novel).toHaveLength(0);
  });
});

describe('rail containment', () => {
  function rail(
    id: string,
    verify: AxAgentVerifierRail['verify']
  ): AxAgentVerifierRail {
    return { id, stage: 'afterToolCall', verify };
  }

  it('returns a healthy rail diagnostics without disabling it', async () => {
    const outcome = await axRunVerifierRail(
      rail('ok', () => [
        { signature: 's', code: 'c', message: 'm', severity: 'info' },
      ]),
      railContext(new AbortController().signal),
      50
    );
    expect(outcome.disable).toBe(false);
    expect(outcome.diagnostics).toHaveLength(1);
  });

  it('contains a rail that throws and disables it', async () => {
    const outcome = await axRunVerifierRail(
      rail('boom', () => {
        throw new Error('rail exploded');
      }),
      railContext(new AbortController().signal),
      50
    );
    expect(outcome.disable).toBe(true);
    expect(outcome.diagnostics[0]?.code).toBe('rail_error');
    expect(outcome.diagnostics[0]?.signature).toBe('rail_error:boom');
  });

  it('contains a rail that rejects and disables it', async () => {
    const outcome = await axRunVerifierRail(
      rail('reject', async () => {
        throw new Error('async failure');
      }),
      railContext(new AbortController().signal),
      50
    );
    expect(outcome.disable).toBe(true);
    expect(outcome.diagnostics[0]?.code).toBe('rail_error');
  });

  it('cuts off a rail that never resolves at the deadline', async () => {
    const verify = vi.fn(() => new Promise<never>(() => {}));
    const started = Date.now();
    const outcome = await axRunVerifierRail(
      rail('hang', verify as AxAgentVerifierRail['verify']),
      railContext(new AbortController().signal),
      30
    );
    // The deadline, not the await, is what bounds it.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.disable).toBe(true);
    expect(outcome.diagnostics[0]?.code).toBe('rail_timeout');
  });

  it('cuts off a rail when the run aborts', async () => {
    const controller = new AbortController();
    const promise = axRunVerifierRail(
      rail('hang', () => new Promise<never>(() => {})),
      railContext(controller.signal),
      60_000
    );
    controller.abort();
    const outcome = await promise;
    expect(outcome.disable).toBe(true);
    expect(outcome.diagnostics[0]?.code).toBe('rail_timeout');
  });

  it('leaves no abort listener behind after any settle path', async () => {
    // Mirrors the store's listener-leak contract: a long-lived wait must not
    // accumulate listeners on a shared signal.
    const controller = new AbortController();
    for (let index = 0; index < 25; index++) {
      await axRunVerifierRail(
        rail(`ok-${index}`, () => []),
        railContext(controller.signal),
        50
      );
      await axRunVerifierRail(
        rail(`hang-${index}`, () => new Promise<never>(() => {})),
        railContext(controller.signal),
        1
      );
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    await axRunVerifierRail(
      rail('after-abort', () => []),
      railContext(controller.signal),
      50
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
