import { describe, expect, it } from 'vitest';

import {
  applyCuratorOperations,
  createEmptyPlaybook,
  createExecutablePlaybookView,
  dedupePlaybookByContent,
  generateBulletId,
  renderPlaybook,
} from './acePlaybook.js';
import type { AxACECuratorOperation } from './aceTypes.js';

function makePlaybookWithSection(
  section: string,
  bullets: Array<{
    id?: string;
    content: string;
    helpfulCount?: number;
    harmfulCount?: number;
  }>
) {
  const playbook = createEmptyPlaybook();
  playbook.sections[section] = bullets.map((entry) => ({
    id: entry.id ?? generateBulletId(section),
    section,
    content: entry.content,
    helpfulCount: entry.helpfulCount ?? 0,
    harmfulCount: entry.harmfulCount ?? 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  return playbook;
}

describe('applyCuratorOperations', () => {
  it('updates existing bullets and protects them from pruning', () => {
    const playbook = makePlaybookWithSection('Guidelines', [
      { id: 'guidel-1', content: 'Old content', helpfulCount: 3 },
      { id: 'guidel-2', content: 'Another bullet', helpfulCount: 1 },
    ]);

    const operations: AxACECuratorOperation[] = [
      {
        type: 'UPDATE',
        section: 'Guidelines',
        bulletId: 'guidel-1',
        content: 'Refined guidance',
      },
      {
        type: 'ADD',
        section: 'Guidelines',
        content: 'Fresh insight',
      },
    ];

    const result = applyCuratorOperations(playbook, operations, {
      maxSectionSize: 3,
      enableAutoPrune: true,
      protectedBulletIds: new Set(['guidel-1']),
    });

    expect(result.autoRemoved).toHaveLength(0);
    expect(result.updatedBulletIds).toEqual(
      expect.arrayContaining(['guidel-1'])
    );

    const updated = playbook.sections.Guidelines.find(
      (bullet) => bullet.id === 'guidel-1'
    );
    expect(updated?.content).toBe('Refined guidance');
  });

  it('auto prunes the least helpful bullet when section is full', () => {
    const playbook = makePlaybookWithSection('Response Strategies', [
      { id: 'resp-1', content: 'Useful', helpfulCount: 4 },
      { id: 'resp-2', content: 'Mediocre', helpfulCount: 1 },
    ]);

    const operations: AxACECuratorOperation[] = [
      {
        type: 'ADD',
        section: 'Response Strategies',
        content: 'Brand new tactic',
      },
    ];

    const result = applyCuratorOperations(playbook, operations, {
      maxSectionSize: 2,
      enableAutoPrune: true,
    });

    expect(result.autoRemoved).toHaveLength(1);
    expect(result.autoRemoved[0]).toMatchObject({
      type: 'REMOVE',
      section: 'Response Strategies',
    });

    const ids = playbook.sections['Response Strategies'].map(
      (bullet) => bullet.id
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain(result.updatedBulletIds.at(-1));
    expect(ids).not.toContain('resp-2');
  });

  it('skips additions when capacity reached and auto prune disabled', () => {
    const playbook = makePlaybookWithSection('Common Pitfalls', [
      { id: 'pit-1', content: 'Watch out for bias' },
      { id: 'pit-2', content: 'Avoid scope creep' },
    ]);

    const operations: AxACECuratorOperation[] = [
      {
        type: 'ADD',
        section: 'Common Pitfalls',
        content: 'New pitfall',
      },
    ];

    const result = applyCuratorOperations(playbook, operations, {
      maxSectionSize: 2,
      enableAutoPrune: false,
    });

    expect(result.updatedBulletIds).toHaveLength(0);
    expect(result.autoRemoved).toHaveLength(0);
    expect(playbook.sections['Common Pitfalls']).toHaveLength(2);
  });

  it('skips empty additions when called directly', () => {
    const playbook = createEmptyPlaybook();

    const result = applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Guidelines',
        content: '   ',
      },
    ]);

    expect(result.updatedBulletIds).toHaveLength(0);
    expect(result.autoRemoved).toHaveLength(0);
    expect(playbook.stats.bulletCount).toBe(0);
    expect(playbook.sections.Guidelines).toEqual([]);
  });

  it('records add/update/remove lineage with before and after snapshots', () => {
    const playbook = createEmptyPlaybook();
    const added = applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'guide-1',
        content: 'Validate first',
      },
    ]);
    expect(added.changes[0]).toMatchObject({
      bulletId: 'guide-1',
      after: { revision: 1, content: 'Validate first' },
    });

    const updated = applyCuratorOperations(playbook, [
      {
        type: 'UPDATE',
        section: 'Guidelines',
        bulletId: 'guide-1',
        content: 'Validate before applying',
      },
    ]);
    expect(updated.changes[0]).toMatchObject({
      before: { revision: 1, content: 'Validate first' },
      after: {
        revision: 2,
        lineage: { previousRevision: 1 },
        content: 'Validate before applying',
      },
    });

    const removed = applyCuratorOperations(playbook, [
      {
        type: 'REMOVE',
        section: 'Guidelines',
        bulletId: 'guide-1',
      },
    ]);
    expect(removed.changes).toMatchObject([
      { bulletId: 'guide-1', before: { revision: 2 } },
    ]);
    expect(playbook.sections.Guidelines).toEqual([]);
  });

  it('keeps provenance and verifier receipts host-owned', () => {
    const playbook = createEmptyPlaybook();
    applyCuratorOperations(
      playbook,
      [
        {
          type: 'ADD',
          section: 'Guidelines',
          bulletId: 'guide-1',
          content: 'Use the scoped policy',
          evidence: {
            confidence: 3,
            applicability: { allOf: ['tenant:paid'] },
            // Deliberately simulate forged model JSON outside the public type.
            provenance: [{ source: 'manual', feedbackIds: ['forged'] }],
            evidenceCount: 999,
            verification: [{ verifierId: 'forged', result: 'passed' }],
          } as any,
        },
      ],
      {
        hostEvidence: {
          source: 'online',
          sourceRunId: 'run-7',
          feedbackIds: ['fb-2', 'fb-1'],
          evidenceCount: 2,
          confidence: 0.8,
          verification: [
            {
              verifierId: 'policy-eval',
              testId: 'case-2',
              result: 'passed',
              summary: `  ${'x'.repeat(600)}  `,
            },
          ],
        },
      }
    );

    expect(playbook.sections.Guidelines[0]?.evidence).toEqual({
      confidence: 0.8,
      evidenceCount: 2,
      applicability: { allOf: ['tenant:paid'] },
      provenance: [
        {
          source: 'online',
          sourceRunId: 'run-7',
          feedbackIds: ['fb-1', 'fb-2'],
        },
      ],
      verification: [
        {
          verifierId: 'policy-eval',
          testId: 'case-2',
          result: 'passed',
          summary: 'x'.repeat(500),
        },
      ],
    });
  });

  it('filters by applicability, expiry, deprecation, and supersession', () => {
    const playbook = createEmptyPlaybook();
    applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'public',
        content: 'Always visible',
      },
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'paid',
        content: 'Paid tenants only',
        evidence: { applicability: { allOf: ['tenant:paid'] } },
      },
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'expired',
        content: 'Old temporary rule',
        evidence: { lifecycle: { expiresAt: '2026-01-01T00:00:00.000Z' } },
      },
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'deprecated',
        content: 'Deprecated rule',
        evidence: { lifecycle: { status: 'deprecated' } },
      },
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'replacement',
        content: 'Replacement rule',
        supersedes: ['public'],
      },
    ]);

    const active = renderPlaybook(playbook, {
      conditions: ['tenant:paid'],
      now: '2026-08-01T00:00:00.000Z',
    });
    expect(active).toContain('Paid tenants only');
    expect(active).toContain('Replacement rule');
    expect(active).not.toContain('Always visible');
    expect(active).not.toContain('Old temporary rule');
    expect(active).not.toContain('Deprecated rule');

    const inspection = renderPlaybook(playbook, { includeInactive: true });
    expect(inspection).toContain('Always visible');
    expect(inspection).toContain('Old temporary rule');
    expect(inspection).toContain('Deprecated rule');
    expect(
      playbook.sections.Guidelines.find((bullet) => bullet.id === 'public')
        ?.evidence?.lifecycle
    ).toMatchObject({ status: 'superseded', supersededBy: 'replacement' });
  });

  it('fails closed for expiring guidance when the render clock is invalid', () => {
    const playbook = createEmptyPlaybook();
    applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'expiring',
        content: 'Temporary future rule',
        evidence: { lifecycle: { expiresAt: '2099-01-01T00:00:00.000Z' } },
      },
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'plain',
        content: 'Non-expiring rule',
      },
    ]);

    const rendered = renderPlaybook(playbook, { now: 'not-a-date' });
    expect(rendered).not.toContain('Temporary future rule');
    expect(rendered).toContain('Non-expiring rule');
  });

  it('keeps inspection permissive only after structural validation', () => {
    const playbook = makePlaybookWithSection('Guidelines', [
      { id: 'malformed', content: 'Malformed scoped rule' },
      { id: 'expired', content: 'Expired rule' },
      { id: 'active', content: 'Active rule' },
    ]);
    (playbook.sections.Guidelines[0] as any).evidence = {
      applicability: { allOf: 'tenant:paid' },
    };
    playbook.sections.Guidelines[1]!.evidence = {
      lifecycle: { expiresAt: '2026-01-01T00:00:00.000Z' },
    };

    const inspection = renderPlaybook(playbook, {
      includeInactive: true,
      now: '2026-08-01T00:00:00.000Z',
    });
    expect(inspection).not.toContain('Malformed scoped rule');
    expect(inspection).toContain('Expired rule');

    const executable = createExecutablePlaybookView(
      playbook,
      '2026-08-01T00:00:00.000Z'
    );
    const prompt = renderPlaybook(executable, { includeInapplicable: true });
    expect(prompt).toBe(
      '## Context Playbook\n\n### Guidelines\n- [active] Active rule'
    );
    expect(executable.sections.Guidelines.map((bullet) => bullet.id)).toEqual([
      'active',
    ]);
  });

  it('preserves the exact live state when loaded evidence is malformed', () => {
    const playbook = makePlaybookWithSection('Guidelines', [
      { id: 'guide-1', content: 'Original guidance' },
    ]);
    (playbook.sections.Guidelines[0] as any).evidence = {
      applicability: { allOf: 'tenant:paid' },
    };
    const before = JSON.stringify(playbook);

    expect(() =>
      applyCuratorOperations(playbook, [
        {
          type: 'UPDATE',
          section: 'Guidelines',
          bulletId: 'guide-1',
          content: 'Mutated guidance',
        },
      ])
    ).toThrow(/bullet.*malformed/);
    expect(JSON.stringify(playbook)).toBe(before);
    expect(playbook.sections.Guidelines[0]?.content).toBe('Original guidance');
    expect(playbook.sections.Guidelines[0]).not.toHaveProperty('revision');
  });

  it('keeps an exact-content superseding replacement live and referentially intact', () => {
    const playbook = makePlaybookWithSection('Guidelines', [
      { id: 'old', content: 'Validate before applying.' },
    ]);
    const result = applyCuratorOperations(playbook, [
      {
        type: 'ADD',
        section: 'Guidelines',
        bulletId: 'new',
        content: 'Validate before applying.',
        supersedes: ['old'],
      },
    ]);
    dedupePlaybookByContent(playbook, 0.95, result.updatedBulletIds);

    expect(result.updatedBulletIds).toEqual(['new']);
    expect(playbook.sections.Guidelines.map((bullet) => bullet.id)).toEqual([
      'old',
      'new',
    ]);
    expect(renderPlaybook(playbook)).toContain('[new]');
    expect(renderPlaybook(playbook)).not.toContain('[old]');
    expect(
      playbook.sections.Guidelines.find((bullet) => bullet.id === 'old')
        ?.evidence?.lifecycle
    ).toEqual({ status: 'superseded', supersededBy: 'new' });
    expect(
      playbook.sections.Guidelines.find((bullet) => bullet.id === 'new')
        ?.lineage
    ).toEqual({ supersedes: ['old'] });
    const ids = new Set(
      playbook.sections.Guidelines.map((bullet) => bullet.id)
    );
    for (const bullet of playbook.sections.Guidelines) {
      const supersededBy = bullet.evidence?.lifecycle?.supersededBy;
      expect(supersededBy === undefined || ids.has(supersededBy)).toBe(true);
      for (const id of bullet.lineage?.supersedes ?? []) {
        expect(ids.has(id)).toBe(true);
      }
    }
  });

  it('serializes normalized evidence deterministically', () => {
    const playbook = createEmptyPlaybook();
    applyCuratorOperations(
      playbook,
      [
        {
          type: 'ADD',
          section: 'Guidelines',
          bulletId: 'guide-1',
          content: 'Stable order',
          evidence: { applicability: { allOf: ['z', 'a', 'z'] } },
          supersedes: ['old-z', 'old-a', 'old-z'],
        },
      ],
      { hostEvidence: { feedbackIds: ['z', 'a', 'z'] } }
    );

    const first = JSON.stringify(playbook);
    const second = JSON.stringify(JSON.parse(first));
    expect(second).toBe(first);
    expect(playbook.sections.Guidelines[0]).toMatchObject({
      lineage: { supersedes: ['old-a', 'old-z'] },
      evidence: {
        applicability: { allOf: ['a', 'z'] },
        provenance: [{ feedbackIds: ['a', 'z'] }],
      },
    });
  });
});
