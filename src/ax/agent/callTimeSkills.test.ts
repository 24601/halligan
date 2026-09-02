/**
 * Unit-level rules for call-time skill injection: config-time validation, the
 * binding table, the per-callable injection budget, the `when` predicate, the
 * frozen not-executed marker and its cross-realm guard.
 *
 * The loop-level guarantees — no authorization, no `onFunctionCall`, no
 * recorder record, no receipt, and NO SPECULATION ADAPTER for a bound callable
 * — are driven end to end through a real `agent(...)` in
 * `agent.callTimeSkills.test.ts`, because only a real dispatch can prove a
 * call did not happen.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  AxAgentCatalogSkill,
  AxAgentSkillResult,
} from './agentInternal/skillsTypes.js';
import {
  type AxCallTimeSkillBinding,
  axCallTimeSkillCatalogAdmission,
  axCallTimeSkillRuntime,
  axIsCallTimeSkillNotExecuted,
  axValidateCallTimeSkillBindings,
} from './callTimeSkills.js';
import type { AxWorkingStateDocument } from './workingState.js';
import { AxWorkingStateSchemaError } from './workingState.js';

const ADJUST = 'inventory.adjustStock';

const inlineSkill: AxAgentSkillResult = {
  id: 'stock-adjustment',
  name: 'Stock adjustment',
  content: '# Stock adjustment\n\nReserve before adjusting.',
};

const catalog = new Map<string, AxAgentSkillResult>([
  ['stock-adjustment', inlineSkill],
]);

const resolveSkill = (id: string): AxAgentSkillResult | undefined =>
  catalog.get(id);

function document(
  facts: Record<string, unknown> = {}
): Readonly<AxWorkingStateDocument<any>> {
  return { schemaVersion: 1, goals: {}, facts, parked: [] };
}

function openRuntime(
  bindings: readonly AxCallTimeSkillBinding[],
  overrides?: Readonly<{
    workingState?: () => Readonly<AxWorkingStateDocument<any>>;
  }>
) {
  return axCallTimeSkillRuntime(bindings, {
    resolveSkill,
    ...(overrides?.workingState
      ? { workingState: overrides.workingState }
      : {}),
  });
}

/** Register the callable, then call the hook the way `wrapFunction` does. */
function draft(
  runtime: ReturnType<typeof openRuntime>,
  qualifiedName: string
): ReturnType<NonNullable<ReturnType<typeof runtime.register>>> {
  const hook = runtime.register(qualifiedName);
  return hook?.();
}

describe('call-time skill binding validation', () => {
  it('accepts an exact binding against a catalog id', () => {
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
        { hasWorkingState: false, resolveSkill }
      )
    ).not.toThrow();
  });

  it('rejects a glob so a later callable cannot be silently captured', () => {
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: 'inventory.*', skill: inlineSkill }],
        { hasWorkingState: false }
      )
    ).toThrow(/bound_callable_glob/);
  });

  it('rejects two bindings for the same callable', () => {
    expect(() =>
      axValidateCallTimeSkillBindings(
        [
          { qualifiedName: ADJUST, skill: inlineSkill },
          { qualifiedName: ADJUST, skill: inlineSkill },
        ],
        { hasWorkingState: false }
      )
    ).toThrow(/duplicate_bound_callable/);
  });

  it('rejects a skill id that resolves to nothing', () => {
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: ADJUST, skill: 'no-such-skill' }],
        { hasWorkingState: false, resolveSkill }
      )
    ).toThrow(/unknown_bound_skill/);
  });

  it('rejects an inline skill carrying no body text', () => {
    // `AxAgentSkillResult.content` is the only field that can render a
    // procedure; a name alone injects nothing the model can read.
    expect(() =>
      axValidateCallTimeSkillBindings(
        [
          {
            qualifiedName: ADJUST,
            skill: { name: 'Stock adjustment', content: '' },
          },
        ],
        { hasWorkingState: false }
      )
    ).toThrow(/unresolvable_skill_spec/);
  });

  it('rejects maxInjections below one and non-integers', () => {
    for (const value of [0, -1, 1.5]) {
      expect(() =>
        axValidateCallTimeSkillBindings(
          [
            {
              qualifiedName: ADJUST,
              skill: inlineSkill,
              maxInjections: value,
            },
          ],
          { hasWorkingState: false }
        )
      ).toThrow(/invalid_max_injections/);
    }
  });

  it('rejects a maxInjections above the hard ceiling', () => {
    // Every injection appends a pending record, ingests a body and appends an
    // untrimmed guidance entry. A mechanism whose safety argument is "budgeted"
    // may not accept an unbounded budget from config.
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: ADJUST, skill: inlineSkill, maxInjections: 101 }],
        { hasWorkingState: false }
      )
    ).toThrow(/invalid_max_injections: 101/);
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: ADJUST, skill: inlineSkill, maxInjections: 100 }],
        { hasWorkingState: false }
      )
    ).not.toThrow();
  });

  it('rejects a when predicate with no working state configured', () => {
    // The predicate reads the COMMITTED document; inventing an empty one would
    // answer the host's question about real state with a fabrication.
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: ADJUST, skill: inlineSkill, when: () => true }],
        { hasWorkingState: false }
      )
    ).toThrow(/when_requires_working_state/);
    expect(() =>
      axValidateCallTimeSkillBindings(
        [{ qualifiedName: ADJUST, skill: inlineSkill, when: () => true }],
        { hasWorkingState: true }
      )
    ).not.toThrow();
  });

  it('throws AxWorkingStateSchemaError, not a bare Error', () => {
    let caught: unknown;
    try {
      axValidateCallTimeSkillBindings([{ qualifiedName: '', skill: 'x' }], {
        hasWorkingState: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxWorkingStateSchemaError);
    expect((caught as AxWorkingStateSchemaError).code).toBe(
      'working_state_schema_invalid'
    );
    // The message names the option the host actually set. Call-time bindings
    // need no working state unless a `when` predicate is declared, so
    // "Working state configuration is invalid" would send a host to the wrong
    // option entirely.
    expect((caught as AxWorkingStateSchemaError).subsystem).toBe(
      'Call-time skill'
    );
    expect((caught as Error).message).toContain(
      'Call-time skill configuration is invalid'
    );
    expect((caught as Error).message).not.toContain('Working state');
  });
});

describe('the catalog admission gate for a bound skill id', () => {
  const gatedCatalog: readonly AxAgentCatalogSkill[] = [
    {
      id: 'stock-adjustment',
      name: 'Stock adjustment',
      content: inlineSkill.content,
      requires: { bins: ['redis-cli'] },
    },
    { id: 'open-skill', name: 'Open', content: 'body' },
  ];

  it('reports ineligible, denied and admit for the same catalog', () => {
    const withBin = axCallTimeSkillCatalogAdmission(gatedCatalog, {
      environment: { bins: ['redis-cli'] },
    });
    const withoutBin = axCallTimeSkillCatalogAdmission(gatedCatalog, {
      environment: { bins: [] },
    });
    // `requires` is resolved against the RUN's environment, not the binding.
    expect(withoutBin('stock-adjustment')).toBe('ineligible');
    expect(withBin('stock-adjustment')).toBe('admit');
    // The authority half is orthogonal and time-varying: an eligible skill the
    // retrieval re-check parked is still not injectable.
    expect(
      axCallTimeSkillCatalogAdmission(gatedCatalog, {
        environment: { bins: ['redis-cli'] },
        denied: new Set(['stock-adjustment']),
      })('stock-adjustment')
    ).toBe('denied');
    // An id absent from the catalog is host-supplied literal text with nothing
    // to be eligible for — the `presetSkills` posture, not a hole.
    expect(withoutBin('not-in-catalog')).toBe('admit');
  });

  it('refuses the run when a bound id is ineligible or denied', () => {
    const open = (admit: ReturnType<typeof axCallTimeSkillCatalogAdmission>) =>
      axCallTimeSkillRuntime(
        [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
        { resolveSkill, admitSkill: admit }
      );
    expect(() =>
      open(
        axCallTimeSkillCatalogAdmission(gatedCatalog, {
          environment: { bins: [] },
        })
      )
    ).toThrow(/ineligible_bound_skill: stock-adjustment/);
    expect(() =>
      open(
        axCallTimeSkillCatalogAdmission(gatedCatalog, {
          environment: { bins: ['redis-cli'] },
          denied: new Set(['stock-adjustment']),
        })
      )
    ).toThrow(/denied_bound_skill: stock-adjustment/);
    // The positive control: the same binding opens when both gates admit.
    expect(() =>
      open(
        axCallTimeSkillCatalogAdmission(gatedCatalog, {
          environment: { bins: ['redis-cli'] },
        })
      )
    ).not.toThrow();
  });

  it('does not gate an inline skill, which no catalog gate can hide', () => {
    expect(() =>
      axCallTimeSkillRuntime([{ qualifiedName: ADJUST, skill: inlineSkill }], {
        resolveSkill,
        admitSkill: () => 'denied',
      })
    ).not.toThrow();
  });
});

describe('the binding table and the injection budget', () => {
  it('intercepts a bound callable and returns the frozen marker', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: 'stock-adjustment' },
    ]);
    const marker = draft(runtime, ADJUST);

    expect(axIsCallTimeSkillNotExecuted(marker)).toBe(true);
    expect(marker).toMatchObject({
      __axNotExecuted: true,
      reason: 'skill_injected',
      qualifiedName: ADJUST,
      skillId: 'stock-adjustment',
    });
    expect(Object.isFrozen(marker)).toBe(true);
    // The guidance is harness-authored: it names the callable and the skill id
    // and nothing else, because the guidance log is the TRUSTED prompt region.
    expect(marker?.guidance).toContain(ADJUST);
    expect(marker?.guidance).toContain('stock-adjustment');
  });

  it('returns undefined for an unbound callable', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: 'stock-adjustment' },
    ]);
    expect(draft(runtime, 'inventory.pick')).toBeUndefined();
    expect(runtime.injections()).toBe(0);
    expect(runtime.drain()).toEqual([]);
  });

  it('spends the budget once and then lets the tool execute', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: 'stock-adjustment' },
    ]);
    expect(draft(runtime, ADJUST)).toBeDefined();
    // Default maxInjections is 1: one nudge, then normal operation. Without
    // this bound the model can loop forever re-drafting the same call.
    expect(draft(runtime, ADJUST)).toBeUndefined();
    expect(draft(runtime, ADJUST)).toBeUndefined();
    expect(runtime.injections(ADJUST)).toBe(1);
  });

  it('honours a larger per-callable budget and keeps budgets independent', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: inlineSkill, maxInjections: 2 },
      { qualifiedName: 'inventory.ship', skill: inlineSkill },
    ]);
    expect(draft(runtime, ADJUST)).toBeDefined();
    expect(draft(runtime, ADJUST)).toBeDefined();
    expect(draft(runtime, ADJUST)).toBeUndefined();
    // A separate callable has its own budget and is untouched by the first.
    expect(draft(runtime, 'inventory.ship')).toBeDefined();
    expect(runtime.injections()).toBe(3);
  });

  it('falls through when the when predicate says the call is not state-changing', () => {
    const when = vi.fn(
      (state: Readonly<AxWorkingStateDocument<any>>) =>
        (state.facts as { shipped?: boolean }).shipped !== true
    );
    let shipped = true;
    const runtime = openRuntime(
      [{ qualifiedName: ADJUST, skill: inlineSkill, when }],
      { workingState: () => document({ shipped }) }
    );

    expect(draft(runtime, ADJUST)).toBeUndefined();
    expect(when).toHaveBeenCalledTimes(1);
    // A predicate that says no must not spend the budget, or a single early
    // "no" would disable the binding for the rest of the run.
    expect(runtime.injections(ADJUST)).toBe(0);

    shipped = false;
    expect(draft(runtime, ADJUST)).toBeDefined();
    expect(runtime.injections(ADJUST)).toBe(1);
  });

  it('falls through when the when predicate throws, without spending budget', () => {
    // `intercept()` runs synchronously inside the actor's `await tool(...)`, so
    // a propagated throw would become an `isError` turn, escalate the executor
    // model, AND — because the budget is spent after the predicate — repeat on
    // every re-draft with no bound at all.
    const when = vi.fn((): boolean => {
      throw new Error('host predicate exploded');
    });
    const runtime = openRuntime(
      [{ qualifiedName: ADJUST, skill: inlineSkill, when }],
      { workingState: () => document({}) }
    );

    expect(() => draft(runtime, ADJUST)).not.toThrow();
    expect(draft(runtime, ADJUST)).toBeUndefined();
    expect(when).toHaveBeenCalledTimes(2);
    expect(runtime.injections(ADJUST)).toBe(0);
    expect(runtime.drain()).toEqual([]);
  });

  it('falls through when the working-state read itself throws', () => {
    const runtime = openRuntime(
      [{ qualifiedName: ADJUST, skill: inlineSkill, when: () => true }],
      {
        workingState: () => {
          throw new Error('store unavailable');
        },
      }
    );
    expect(draft(runtime, ADJUST)).toBeUndefined();
    expect(runtime.injections(ADJUST)).toBe(0);
  });

  it('treats a non-boolean truthy predicate result as no interception', () => {
    // `=== true` rather than truthiness: a predicate returning a Promise (an
    // accidental `async when`) is always truthy and would intercept forever.
    const runtime = openRuntime(
      [
        {
          qualifiedName: ADJUST,
          skill: inlineSkill,
          when: (() => Promise.resolve(true)) as never,
        },
      ],
      { workingState: () => document({}) }
    );
    expect(draft(runtime, ADJUST)).toBeUndefined();
    expect(runtime.injections(ADJUST)).toBe(0);
  });

  it('drains one injection record per interception and then nothing', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: 'stock-adjustment', maxInjections: 2 },
    ]);
    draft(runtime, ADJUST);
    draft(runtime, ADJUST);

    const drained = runtime.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]).toMatchObject({
      qualifiedName: ADJUST,
      skillId: 'stock-adjustment',
    });
    // The record carries the resolved skill so the loop can ingest it through
    // the ordinary loaded-skills channel rather than a parallel prompt section.
    expect(drained[0]?.skill.content).toContain('Reserve before adjusting');
    expect(runtime.drain()).toEqual([]);
  });

  it('exposes exactly the bound names as an inspection view', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: inlineSkill },
      { qualifiedName: 'inventory.ship', skill: inlineSkill },
    ]);
    expect([...runtime.bound()].sort()).toEqual([ADJUST, 'inventory.ship']);
    expect(runtime.isBound(ADJUST)).toBe(true);
    expect(runtime.isBound('inventory.pick')).toBe(false);
  });

  it('refuses a binding that named no registered callable', () => {
    const runtime = openRuntime([
      { qualifiedName: 'inventory.typo', skill: inlineSkill },
    ]);
    runtime.register('inventory.pick');
    expect(() => runtime.finishRegistration()).toThrow(
      /unknown_bound_callable: inventory\.typo/
    );
  });

  it('accepts registration in any order and refuses only the unmatched name', () => {
    const runtime = openRuntime([
      { qualifiedName: ADJUST, skill: inlineSkill },
    ]);
    runtime.register('inventory.pick');
    runtime.register(ADJUST);
    expect(() => runtime.finishRegistration()).not.toThrow();
  });

  it('derives the skill id from the name when the skill carries none', () => {
    const runtime = openRuntime([
      {
        qualifiedName: ADJUST,
        skill: { name: 'Stock adjustment', content: 'body' },
      },
    ]);
    expect(draft(runtime, ADJUST)?.skillId).toBe('Stock adjustment');
  });
});

describe('axIsCallTimeSkillNotExecuted', () => {
  it('identifies a structurally equal marker from another realm', () => {
    // `instanceof` is unavailable (the marker is a plain object) and identity
    // breaks across two copies of the package, so the guard is structural.
    const foreign = JSON.parse(
      JSON.stringify({
        __axNotExecuted: true,
        reason: 'skill_injected',
        qualifiedName: ADJUST,
        skillId: 'stock-adjustment',
        guidance: 'g',
      })
    );
    expect(axIsCallTimeSkillNotExecuted(foreign)).toBe(true);
  });

  it('rejects near misses, primitives and partial shapes', () => {
    expect(axIsCallTimeSkillNotExecuted(undefined)).toBe(false);
    expect(axIsCallTimeSkillNotExecuted(null)).toBe(false);
    expect(axIsCallTimeSkillNotExecuted('skill_injected')).toBe(false);
    expect(axIsCallTimeSkillNotExecuted({ __axNotExecuted: true })).toBe(false);
    expect(
      axIsCallTimeSkillNotExecuted({
        __axNotExecuted: true,
        reason: 'something_else',
        qualifiedName: ADJUST,
        skillId: 'x',
        guidance: 'g',
      })
    ).toBe(false);
    expect(
      axIsCallTimeSkillNotExecuted({
        __axNotExecuted: 'true',
        reason: 'skill_injected',
        qualifiedName: ADJUST,
        skillId: 'x',
        guidance: 'g',
      })
    ).toBe(false);
  });
});
