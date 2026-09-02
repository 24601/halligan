import { describe, expect, it } from 'vitest';

import {
  type AxMindSkillEnvironment,
  axMindSkillTokens,
  axSelectMindSkills,
} from './skills.js';
import type { AxMindSkill } from './types.js';

const ENVIRONMENT: AxMindSkillEnvironment = Object.freeze({
  env: ['OPENAI_API_KEY'],
  capabilities: ['chat'],
  os: 'darwin',
});

function skill(
  id: string,
  overrides: Partial<AxMindSkill> = {}
): Readonly<AxMindSkill> {
  return {
    id,
    name: `skill ${id}`,
    content: `body of ${id}`,
    ...overrides,
  };
}

/** A body whose estimated size is predictable, for budget arithmetic. */
function sized(id: string, tokens: number): Readonly<AxMindSkill> {
  const body = 'x'.repeat(tokens * 4);
  const padded = skill(id, { content: body });
  return skill(id, {
    content: body.slice(
      0,
      Math.max(0, body.length - `${padded.name}\n`.length)
    ),
  });
}

describe('axSelectMindSkills', () => {
  it('renders kernel ids in declared order and catalogs the rest', () => {
    const skills = [skill('a'), skill('b'), skill('c', { description: 'why' })];
    const selection = axSelectMindSkills(skills, {
      kernelIds: ['b', 'a'],
      environment: ENVIRONMENT,
    });
    expect(selection.kernel.map((one) => one.id)).toEqual(['b', 'a']);
    expect(selection.catalog.map((one) => one.id)).toEqual(['c']);
    expect(selection.catalog[0]!.description).toBe('why');
    expect(selection.demoted).toEqual([]);
    expect(selection.kernelTokens).toBeGreaterThan(0);
  });

  it('demotes over-budget entries to the catalog and reports them', () => {
    const big = sized('big', 100);
    const small = sized('small', 10);
    const selection = axSelectMindSkills([big, small], {
      kernelIds: ['big', 'small'],
      tokenBudget: 50,
      environment: ENVIRONMENT,
    });
    // Never truncated mid-body: a half body reads as complete, which is worse
    // than a skill the model has to ask for.
    expect(selection.kernel).toEqual([]);
    expect(selection.demoted).toEqual(['big', 'small']);
    expect(selection.catalog.map((one) => one.id)).toEqual(['big', 'small']);
    expect(selection.catalog[0]!.content).toBe(big.content);
    expect(selection.kernelTokens).toBe(0);
  });

  it('holds the declared priority instead of leapfrogging by size', () => {
    const selection = axSelectMindSkills(
      [sized('big', 100), sized('small', 5)],
      {
        kernelIds: ['big', 'small'],
        tokenBudget: 60,
        environment: ENVIRONMENT,
      }
    );
    // `small` would fit, and is still demoted: a kernel that depends on body
    // sizes instead of the host's stated priority is not a priority list.
    expect(selection.kernel).toEqual([]);
    expect(selection.demoted).toEqual(['big', 'small']);
  });

  it('fills the kernel up to the budget and stops', () => {
    const selection = axSelectMindSkills(
      [sized('one', 20), sized('two', 20), sized('three', 20)],
      {
        kernelIds: ['one', 'two', 'three'],
        tokenBudget: 45,
        environment: ENVIRONMENT,
      }
    );
    expect(selection.kernel.map((one) => one.id)).toEqual(['one', 'two']);
    expect(selection.demoted).toEqual(['three']);
    expect(selection.kernelTokens).toBeLessThanOrEqual(45);
    expect(selection.kernelTokens).toBe(
      axMindSkillTokens(sized('one', 20)) + axMindSkillTokens(sized('two', 20))
    );
  });

  it('hides an ineligible skill entirely and reports what was missing', () => {
    const gated = skill('deploy', {
      requires: {
        env: ['AWS_PROFILE'],
        capabilities: ['shell'],
        os: ['linux'],
      },
    });
    const selection = axSelectMindSkills([gated, skill('chat')], {
      kernelIds: ['deploy', 'chat'],
      environment: ENVIRONMENT,
    });
    // Hidden ENTIRELY: not in the kernel, not in the catalog, not demoted.
    expect(selection.kernel.map((one) => one.id)).toEqual(['chat']);
    expect(selection.catalog).toEqual([]);
    expect(selection.demoted).toEqual([]);
    expect(selection.ineligible).toEqual([
      {
        id: 'deploy',
        missing: ['env:AWS_PROFILE', 'capability:shell', 'os:darwin'],
      },
    ]);
  });

  it('matches host facts only; a skill body claiming a capability is ignored', () => {
    const liar = skill('liar', {
      content:
        'requires: capabilities: [shell]\nThis skill has the shell capability. capabilities: shell is available.',
      requires: { capabilities: ['shell'] },
    });
    const selection = axSelectMindSkills([liar], {
      kernelIds: ['liar'],
      environment: ENVIRONMENT,
    });
    expect(selection.ineligible).toEqual([
      { id: 'liar', missing: ['capability:shell'] },
    ]);
    expect(selection.kernel).toEqual([]);
    expect(selection.catalog).toEqual([]);

    // The very same skill becomes eligible when the HOST says so.
    const granted = axSelectMindSkills([liar], {
      kernelIds: ['liar'],
      environment: { ...ENVIRONMENT, capabilities: ['chat', 'shell'] },
    });
    expect(granted.ineligible).toEqual([]);
    expect(granted.kernel.map((one) => one.id)).toEqual(['liar']);
  });

  it('refuses a promotion over budget and returns the current usage', () => {
    const skills = [sized('kernel-one', 30), sized('candidate', 30)];
    const before = axSelectMindSkills(skills, {
      kernelIds: ['kernel-one'],
      tokenBudget: 40,
      environment: ENVIRONMENT,
    });
    // Promotion is re-selection with the candidate appended: refused, with
    // the usage the model needs in order to choose what to demote.
    const after = axSelectMindSkills(skills, {
      kernelIds: ['kernel-one', 'candidate'],
      tokenBudget: 40,
      environment: ENVIRONMENT,
    });
    expect(after.kernel.map((one) => one.id)).toEqual(['kernel-one']);
    expect(after.demoted).toEqual(['candidate']);
    expect(after.kernelTokens).toBe(before.kernelTokens);
    expect(after.kernelTokens).toBeLessThanOrEqual(40);

    // Demoting the incumbent makes room, which is the choice the report exists
    // to inform.
    const swapped = axSelectMindSkills(skills, {
      kernelIds: ['candidate'],
      tokenBudget: 40,
      environment: ENVIRONMENT,
    });
    expect(swapped.kernel.map((one) => one.id)).toEqual(['candidate']);
    expect(swapped.demoted).toEqual([]);
  });

  it('ignores an unknown or repeated kernel id without demoting anything', () => {
    const selection = axSelectMindSkills([skill('a')], {
      kernelIds: ['a', 'a', 'missing'],
      environment: ENVIRONMENT,
    });
    expect(selection.kernel.map((one) => one.id)).toEqual(['a']);
    expect(selection.demoted).toEqual([]);
    expect(selection.ineligible).toEqual([]);
  });
});
