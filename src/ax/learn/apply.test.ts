import { describe, expect, it } from 'vitest';
import type { AxAgentCatalogSkill } from '../agent/agentInternal/skillsTypes.js';
import { agent } from '../agent/index.js';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxPlaybookSnapshot } from '../dsp/playbook.js';
import { axApplyHarnessTree, axCurrentHarnessInstallation } from './apply.js';
import {
  AxHarnessApplyError,
  type AxHarnessEntry,
  type AxHarnessInstallTarget,
  type AxHarnessTree,
  axIsHarnessApplyError,
} from './types.js';

const NOW = '2026-01-01T00:00:00.000Z';

const instruction = (id: string, text = 'Answer briefly.'): AxHarnessEntry => ({
  id,
  kind: 'instruction',
  config: { text },
});

const bullet = (id: string): AxHarnessEntry => ({
  id,
  kind: 'playbookBullet',
  config: { id: `${id}-bullet`, section: 'General', content: 'Be brief.' },
});

const skill = (id: string): AxHarnessEntry => ({
  id,
  kind: 'skill',
  config: {
    skillId: `${id}-skill`,
    name: 'Rollback drill',
    content: 'Promote the previous release.',
  },
});

function emptySnapshot(): AxPlaybookSnapshot {
  const playbook = {
    version: 1,
    sections: {},
    stats: {
      bulletCount: 0,
      helpfulCount: 0,
      harmfulCount: 0,
      tokenEstimate: 0,
    },
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  return { playbook, artifact: { playbook, feedback: [], history: [] } };
}

/** A prior snapshot holding bullets this module did not write. */
function snapshotWithHostBullet(): AxPlaybookSnapshot {
  const playbook = {
    version: 3,
    sections: {
      General: [
        {
          id: 'host-bullet',
          section: 'General',
          content: 'HOST OWNED',
          helpfulCount: 7,
          harmfulCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
    stats: {
      bulletCount: 1,
      helpfulCount: 7,
      harmfulCount: 0,
      tokenEstimate: 2,
    },
    updatedAt: NOW,
  };
  return { playbook, artifact: { playbook, feedback: [], history: [] } };
}

/**
 * A fake target that records every write, so `dispose()` can be checked
 * against the exact prior state rather than against a plausible one.
 */
class FakeTarget implements AxHarnessInstallTarget {
  readonly instructionSlots = new Map<string, string>();
  readonly skillSlots = new Map<string, readonly AxAgentCatalogSkill[]>();
  snapshot: AxPlaybookSnapshot = emptySnapshot();
  loads = 0;
  continuous = false;
  playbookHandle:
    | {
        getState(): AxPlaybookSnapshot;
        load(s: Readonly<AxPlaybookSnapshot>): unknown;
      }
    | undefined;
  skillsThrows?: string;

  constructor(options: Readonly<{ withPlaybook?: boolean }> = {}) {
    if (options.withPlaybook !== false) {
      this.playbookHandle = {
        getState: () => this.snapshot,
        load: (s) => {
          this.loads += 1;
          this.snapshot = s as AxPlaybookSnapshot;
          return this;
        },
      };
    }
  }

  setActorInstructionSlot(slot: string, text?: string): void {
    if (text === undefined) this.instructionSlots.delete(slot);
    else this.instructionSlots.set(slot, text);
  }

  getActorInstructionSlot(slot: string): string | undefined {
    return this.instructionSlots.get(slot);
  }

  setSkillsCatalogSlot(
    slot: string,
    skills?: readonly Readonly<AxAgentCatalogSkill>[]
  ): void {
    if (this.skillsThrows) throw new Error(this.skillsThrows);
    if (skills === undefined) this.skillSlots.delete(slot);
    else this.skillSlots.set(slot, [...skills]);
  }

  getSkillsCatalogSlot(
    slot: string
  ): readonly Readonly<AxAgentCatalogSkill>[] | undefined {
    return this.skillSlots.get(slot);
  }

  getPlaybook() {
    return this.playbookHandle;
  }

  getSignature() {
    return { toString: () => 'query:string -> answer:string' };
  }

  hasContinuousPlaybookLearning(): boolean {
    return this.continuous;
  }
}

const TREE: AxHarnessTree = [instruction('i1'), bullet('b1'), skill('s1')];

async function install(
  target: AxHarnessInstallTarget,
  tree: AxHarnessTree = TREE,
  overrides: Record<string, unknown> = {}
) {
  return axApplyHarnessTree(tree, target, {
    releaseId: 'rel-1',
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('axApplyHarnessTree', () => {
  it('writes each channel and reports the installation', async () => {
    const target = new FakeTarget();
    const installation = await install(target);
    expect(target.instructionSlots.get('learn:i1')).toBe('Answer briefly.');
    expect(target.skillSlots.get('learn')?.[0]?.id).toBe('s1-skill');
    expect(target.snapshot.playbook.stats.bulletCount).toBe(1);
    expect(installation.releaseId).toBe('rel-1');
    expect(installation.contentId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(installation.installedAt).toBe(Date.parse(NOW));
  });

  it('installing the same tree twice is idempotent through the slot channel', async () => {
    const target = new FakeTarget();
    const first = await install(target);
    first.dispose();
    await install(target);
    // A slot replaces; an addendum would have stacked.
    expect([...target.instructionSlots.values()]).toEqual(['Answer briefly.']);
  });

  it('dispose restores the exact prior slots, playbook snapshot and catalog', async () => {
    const target = new FakeTarget();
    target.setActorInstructionSlot('learn:i1', 'HOST OWNED');
    target.setSkillsCatalogSlot('learn', [
      { id: 'host', name: 'Host skill', content: 'host body' },
    ]);
    const priorSnapshot = target.snapshot;
    const priorSlots = new Map(target.instructionSlots);
    const priorSkills = new Map(target.skillSlots);

    const installation = await install(target);
    expect(target.instructionSlots.get('learn:i1')).toBe('Answer briefly.');
    installation.dispose();

    expect(target.instructionSlots).toEqual(priorSlots);
    expect(target.skillSlots).toEqual(priorSkills);
    expect(target.snapshot).toBe(priorSnapshot);
  });

  it('dispose is idempotent', async () => {
    const target = new FakeTarget();
    const installation = await install(target);
    installation.dispose();
    const loads = target.loads;
    installation.dispose();
    expect(target.loads).toBe(loads);
  });

  it('axCurrentHarnessInstallation returns the live installation and undefined after dispose', async () => {
    const target = new FakeTarget();
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
    const installation = await install(target);
    expect(axCurrentHarnessInstallation(target)).toBe(installation);
    installation.dispose();
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
  });

  it('a second install without disposing throws and changes nothing', async () => {
    const target = new FakeTarget();
    await install(target);
    const before = new Map(target.instructionSlots);
    await expect(
      install(target, [instruction('other', 'OTHER')])
    ).rejects.toThrow(/already carries an installation/);
    expect(target.instructionSlots).toEqual(before);
  });

  it('refuses an un-admittable tree before writing anything', async () => {
    const target = new FakeTarget();
    await expect(
      install(target, [instruction('i1', 'sk-abcdefghij0123456789')])
    ).rejects.toThrow(/denied admission/);
    expect(target.instructionSlots.size).toBe(0);
    expect(target.loads).toBe(0);
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
  });

  it('refuses playbook bullets on a target with no playbook handle', async () => {
    const target = new FakeTarget({ withPlaybook: false });
    await expect(install(target, [bullet('b1')])).rejects.toThrow(
      AxHarnessApplyError
    );
    try {
      await install(target, [bullet('b1')]);
    } catch (error) {
      expect(axIsHarnessApplyError(error)).toBe(true);
      expect((error as AxHarnessApplyError).channel).toBe('playbookBullet');
    }
  });

  it('refuses a continuous-learning playbook without an acknowledgement', async () => {
    const target = new FakeTarget();
    target.continuous = true;
    await expect(install(target, [bullet('b1')])).rejects.toThrow(
      /acknowledgeContinuousPlaybookReset/
    );
    expect(target.loads).toBe(0);
  });

  it('refuses a continuous-learning playbook for a tree with no bullets too', async () => {
    // The refusal follows the RESET, and the reset happens on every install.
    // Gating it on the tree carrying a bullet let the exact case the guard
    // exists for — a continuous learner losing its run-accumulated bullets —
    // through without an acknowledgement.
    const target = new FakeTarget();
    target.continuous = true;
    target.snapshot = snapshotWithHostBullet();
    await expect(install(target, [instruction('i1')])).rejects.toThrow(
      /acknowledgeContinuousPlaybookReset/
    );
    expect(target.loads).toBe(0);
    expect(target.instructionSlots.size).toBe(0);
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
  });

  it('reports discardedBulletCount when the acknowledged reset drops run-accumulated bullets', async () => {
    const target = new FakeTarget();
    target.continuous = true;
    // Two bullets the agent learned at runtime; the install replaces them.
    target.snapshot = {
      playbook: {
        version: 3,
        sections: {
          Learned: [
            {
              id: 'r1',
              section: 'Learned',
              content: 'a',
              helpfulCount: 2,
              harmfulCount: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: 'r2',
              section: 'Learned',
              content: 'b',
              helpfulCount: 1,
              harmfulCount: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
        stats: {
          bulletCount: 2,
          helpfulCount: 3,
          harmfulCount: 0,
          tokenEstimate: 2,
        },
        updatedAt: NOW,
      },
      artifact: {
        playbook: emptySnapshot().playbook,
        feedback: [],
        history: [],
      },
    };
    const installation = await install(target, [bullet('b1')], {
      acknowledgeContinuousPlaybookReset: true,
    });
    expect(installation.discardedBulletCount).toBe(2);
    expect(target.snapshot.playbook.sections.Learned).toBeUndefined();
  });

  it('replaces the playbook even when the tree carries NO bullets', async () => {
    // The install is a function of the TARGET, not of the tree. A tree with no
    // bullets is a tree that says "serve no bullets"; leaving the host's
    // bullets in place would make the agent serve release X plus content that
    // is in no release, and every record stamped with X would be a lie.
    const target = new FakeTarget();
    target.snapshot = snapshotWithHostBullet();
    const installation = await install(target, [instruction('i1')]);

    expect(target.loads).toBe(1);
    expect(target.snapshot.playbook.sections).toEqual({});
    expect(installation.discardedBulletCount).toBe(1);

    // …and the host's bullet comes back exactly on dispose.
    installation.dispose();
    expect(target.snapshot.playbook.sections.General?.[0]?.content).toBe(
      'HOST OWNED'
    );
  });

  it('reports zero discardedBulletCount when the prior playbook was empty', async () => {
    const target = new FakeTarget();
    const installation = await install(target, [instruction('i1')]);
    expect(installation.discardedBulletCount).toBe(0);
    // The load still happened — an empty rendering is a valid playbook, and
    // the channel is written so the replacement contract holds for every tree.
    expect(target.loads).toBe(1);
  });

  it('installs on a target with no playbook handle when the tree has no bullets', async () => {
    const target = new FakeTarget({ withPlaybook: false });
    const installation = await install(target, [instruction('i1')]);
    expect(target.instructionSlots.get('learn:i1')).toBe('Answer briefly.');
    expect(installation.discardedBulletCount).toBe(0);
  });

  it('clears a skills slot the tree does not fill, and restores it on dispose', async () => {
    const target = new FakeTarget();
    target.skillSlots.set('learn', [
      {
        id: 'host-skill',
        name: 'Host owned',
        content: 'host content',
      } as AxAgentCatalogSkill,
    ]);
    const installation = await install(target, [instruction('i1')]);
    expect(target.skillSlots.get('learn')).toEqual([]);
    installation.dispose();
    expect(target.skillSlots.get('learn')?.[0]?.id).toBe('host-skill');
  });

  it('leaves the skills channel untouched when nothing is in the slot', async () => {
    // An agent constructed with a host `onSkillsSearch` refuses the setter
    // outright; an instruction-only tree must not inherit that refusal.
    const target = new FakeTarget();
    target.skillsThrows =
      'AxAgent.setSkillsCatalogSlot(): this agent was constructed with a host onSkillsSearch';
    const installation = await install(target, [instruction('i1')]);
    expect(installation.contentId.startsWith('sha256:')).toBe(true);
    expect(target.skillSlots.size).toBe(0);
  });

  it('wraps a refusing skills slot as AxHarnessApplyError and unwinds the earlier channels', async () => {
    const target = new FakeTarget();
    target.skillsThrows =
      'AxAgent.setSkillsCatalogSlot(): this agent was constructed with a host onSkillsSearch';
    const priorSnapshot = target.snapshot;
    try {
      await install(target);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(axIsHarnessApplyError(error)).toBe(true);
      expect((error as AxHarnessApplyError).channel).toBe('skill');
      expect((error as AxHarnessApplyError).message).toContain(
        'host onSkillsSearch'
      );
    }
    // Everything written before the refusal is unwound.
    expect(target.instructionSlots.size).toBe(0);
    expect(target.snapshot).toBe(priorSnapshot);
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
  });

  it('installs nothing for a fully disabled tree but still registers the installation', async () => {
    const target = new FakeTarget();
    const installation = await install(target, [
      { ...instruction('i1'), disabled: true },
    ]);
    expect(target.instructionSlots.size).toBe(0);
    expect(axCurrentHarnessInstallation(target)).toBe(installation);
  });

  it('raises an AggregateError when dispose cannot restore, and deregisters anyway', async () => {
    // R6's promise. A restore that failed silently would leave an agent
    // serving a trial tree while `axCurrentHarnessInstallation` claimed
    // otherwise; a restore that stopped at the first failure would leave a
    // mixture of two trees with no record of which.
    const target = new FakeTarget();
    const installation = await install(target, [
      instruction('i1'),
      skill('s1'),
    ]);
    target.skillsThrows = 'the catalog is gone';
    let raised: unknown;
    try {
      installation.dispose();
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors).toHaveLength(1);
    // The instruction channel was still restored, and the target is no longer
    // registered as serving anything.
    expect(target.instructionSlots.size).toBe(0);
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
  });

  it('refuses a `now` that does not parse, before writing anything', async () => {
    // `installedAt: NaN` on a frozen installation is a silently wrong
    // provenance timestamp; the render check only sees a non-empty string.
    const target = new FakeTarget();
    await expect(
      install(target, [instruction('i1')], { now: 'yesterday' })
    ).rejects.toThrow(/Date\.parse accepts/);
    expect(target.instructionSlots.size).toBe(0);
    expect(axCurrentHarnessInstallation(target)).toBeUndefined();
  });

  it('honours the trailing abort signal before it writes', async () => {
    const target = new FakeTarget();
    const controller = new AbortController();
    controller.abort();
    await expect(
      axApplyHarnessTree(
        [instruction('i1')],
        target,
        { releaseId: 'rel-1', now: NOW },
        controller.signal
      )
    ).rejects.toThrow();
    expect(target.instructionSlots.size).toBe(0);
  });

  it('honours a custom slot prefix', async () => {
    const target = new FakeTarget();
    await install(target, TREE, { slot: 'trial' });
    expect(target.instructionSlots.has('trial:i1')).toBe(true);
    expect(target.skillSlots.has('trial')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A real AxAgent must satisfy the structural port, or the port is fiction.
// ---------------------------------------------------------------------------

describe('axApplyHarnessTree against a real agent', () => {
  // The annotation is the point: if AxAgent stops satisfying the structural
  // port, this file stops compiling under `npm run test:type-check`.
  const makeAgent = (
    options: Readonly<Record<string, unknown>> = {}
  ): AxHarnessInstallTarget =>
    agent('query:string -> answer:string', {
      ai: new AxMockAIService({
        features: { functions: false, streaming: false },
        chatResponse: async () => ({
          results: [
            { index: 0, content: 'Answer: ok', finishReason: 'stop' as const },
          ],
          modelUsage: {
            ai: 'mock-ai',
            model: 'mock-model',
            tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        }),
      }),
      ...options,
    });

  it('installs instruction slots and restores them exactly', async () => {
    const target = makeAgent();
    const installation = await axApplyHarnessTree([instruction('i1')], target, {
      releaseId: 'rel-1',
      now: NOW,
    });
    expect(target.getActorInstructionSlot?.('learn:i1')).toBe(
      'Answer briefly.'
    );
    installation.dispose();
    expect(target.getActorInstructionSlot?.('learn:i1')).toBeUndefined();
  });

  it('refuses a skill entry on an agent constructed with a host onSkillsSearch', async () => {
    const target = makeAgent({
      skillsCatalog: [{ id: 'base', name: 'Base', content: 'base body' }],
      onSkillsSearch: async () => [],
    });
    try {
      await axApplyHarnessTree([skill('s1')], target, {
        releaseId: 'rel-1',
        now: NOW,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(axIsHarnessApplyError(error)).toBe(true);
      expect((error as AxHarnessApplyError).channel).toBe('skill');
    }
  });

  it('refuses a skill entry on an agent with no skills catalog', async () => {
    const target = makeAgent();
    try {
      await axApplyHarnessTree([skill('s1')], target, {
        releaseId: 'rel-1',
        now: NOW,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(axIsHarnessApplyError(error)).toBe(true);
      expect((error as AxHarnessApplyError).channel).toBe('skill');
    }
  });

  it('an accepted skill slot recomputes the hint flags, and dispose puts them back', async () => {
    const target = makeAgent({
      skillsCatalog: [{ id: 'base', name: 'Base', content: 'base body' }],
      relevanceRanking: true,
    });
    const stage = (target as unknown as { executor: Record<string, unknown> })
      .executor;
    const installation = await axApplyHarnessTree([skill('s1')], target, {
      releaseId: 'rel-1',
      now: NOW,
    });
    expect(stage.skillsHintEnabled).toBe(true);
    expect(stage.relevanceHintsEnabled).toBe(true);
    expect(
      (stage.skillsCatalog as readonly { id: string }[]).map((s) => s.id)
    ).toEqual(['base', 's1-skill']);
    installation.dispose();
    expect(
      (stage.skillsCatalog as readonly { id: string }[]).map((s) => s.id)
    ).toEqual(['base']);
  });

  it('refuses a continuous-learning agent without an acknowledgement', async () => {
    const target = makeAgent({ playbook: { learn: true } });
    await expect(
      axApplyHarnessTree([bullet('b1')], target, {
        releaseId: 'rel-1',
        now: NOW,
      })
    ).rejects.toThrow(/acknowledgeContinuousPlaybookReset/);
  });
});
