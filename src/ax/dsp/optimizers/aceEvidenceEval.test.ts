import { describe, expect, it } from 'vitest';

import {
  applyCuratorOperations,
  clonePlaybook,
  createEmptyPlaybook,
  renderPlaybook,
} from './acePlaybook.js';
import type { AxACEBullet, AxACEPlaybook } from './aceTypes.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function bullet(
  id: string,
  content: string,
  evidence?: AxACEBullet['evidence']
): AxACEBullet {
  return {
    id,
    section: 'Guidance',
    content,
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(evidence ? { evidence } : {}),
  };
}

function evidenceFixture(): AxACEPlaybook {
  const playbook = createEmptyPlaybook();
  playbook.updatedAt = timestamp;
  playbook.sections.Guidance = [
    bullet('validate', 'Validate the schema before applying changes.'),
    bullet('paid', 'Offer the premium recovery path.', {
      applicability: { allOf: ['tenant:paid'] },
    }),
    bullet('free', 'Offer the free self-service documentation.', {
      applicability: { allOf: ['tenant:free'] },
    }),
    bullet('stale', 'Use the retired v1 endpoint.', {
      lifecycle: { expiresAt: '2026-02-01T00:00:00.000Z' },
    }),
    bullet('contradiction', 'Skip schema validation for speed.', {
      lifecycle: { status: 'deprecated', reason: 'contradicts validation' },
    }),
    bullet('route-v1', 'Route US traffic through v1.', {
      lifecycle: { status: 'superseded', supersededBy: 'route-v2' },
    }),
    bullet('route-v2', 'Route US traffic through v2.', {
      applicability: { allOf: ['region:us'] },
    }),
  ];
  return playbook;
}

function renderedIds(markdown: string): string[] {
  return [...markdown.matchAll(/^- \[([^\]]+)\]/gm)]
    .map((match) => match[1]!)
    .sort();
}

describe('ACE evidence-aware retrieval held-out fixture', () => {
  it('reduces false application without changing plain-bullet behavior', () => {
    const evidenceAware = evidenceFixture();
    const legacy = clonePlaybook(evidenceAware);
    for (const entry of legacy.sections.Guidance) {
      delete entry.evidence;
    }

    const heldOut = [
      {
        conditions: ['tenant:paid', 'region:us'],
        expected: ['paid', 'route-v2', 'validate'],
      },
      {
        conditions: ['tenant:free', 'region:eu'],
        expected: ['free', 'validate'],
      },
      { conditions: [] as string[], expected: ['validate'] },
    ];

    let legacyFalseApplications = 0;
    let awareFalseApplications = 0;
    let possibleFalseApplications = 0;
    let legacyExact = 0;
    let awareExact = 0;
    let legacyPromptChars = 0;
    let awarePromptChars = 0;

    for (const task of heldOut) {
      const legacyRendered = renderPlaybook(legacy, {
        conditions: task.conditions,
        now: '2026-08-01T00:00:00.000Z',
      });
      const awareRendered = renderPlaybook(evidenceAware, {
        conditions: task.conditions,
        now: '2026-08-01T00:00:00.000Z',
      });
      const legacyIds = renderedIds(legacyRendered);
      const awareIds = renderedIds(awareRendered);
      const expected = [...task.expected].sort();
      const forbidden = evidenceAware.sections.Guidance.filter(
        (entry) => !expected.includes(entry.id)
      ).map((entry) => entry.id);

      legacyFalseApplications += legacyIds.filter((id) =>
        forbidden.includes(id)
      ).length;
      awareFalseApplications += awareIds.filter((id) =>
        forbidden.includes(id)
      ).length;
      possibleFalseApplications += forbidden.length;
      legacyExact += Number(
        JSON.stringify(legacyIds) === JSON.stringify(expected)
      );
      awareExact += Number(
        JSON.stringify(awareIds) === JSON.stringify(expected)
      );
      legacyPromptChars += legacyRendered.length;
      awarePromptChars += awareRendered.length;
    }

    // Deterministic retrieval outcome on three held-out condition sets.
    expect({ legacyExact, awareExact }).toEqual({
      legacyExact: 0,
      awareExact: 3,
    });
    expect({
      legacyFalseApplicationRate:
        legacyFalseApplications / possibleFalseApplications,
      awareFalseApplicationRate:
        awareFalseApplications / possibleFalseApplications,
    }).toEqual({ legacyFalseApplicationRate: 1, awareFalseApplicationRate: 0 });
    expect({ legacyPromptChars, awarePromptChars }).toEqual({
      legacyPromptChars: 1080,
      awarePromptChars: 409,
    });

    // Metadata costs durable JSON bytes, but is not rendered into the prompt.
    expect({
      legacyArtifactBytes: JSON.stringify(legacy).length,
      awareArtifactBytes: JSON.stringify(evidenceAware).length,
    }).toEqual({ legacyArtifactBytes: 1533, awareArtifactBytes: 1920 });

    // Negative/no-benefit case: a plain active playbook renders byte-for-byte
    // identically under the new retrieval path.
    const plain = createEmptyPlaybook();
    plain.sections.Guidance = [bullet('plain', 'Use the stable rule.')];
    expect(renderPlaybook(plain, { conditions: ['irrelevant'] })).toBe(
      renderPlaybook(plain)
    );

    // Exact rollback: the pre-change snapshot is sufficient to restore every
    // metadata field and byte of deterministic JSON.
    const before = clonePlaybook(evidenceAware);
    applyCuratorOperations(evidenceAware, [
      {
        type: 'UPDATE',
        section: 'Guidance',
        bulletId: 'validate',
        evidence: { lifecycle: { status: 'deprecated' } },
      },
    ]);
    expect(JSON.stringify(evidenceAware)).not.toBe(JSON.stringify(before));
    const rolledBack = clonePlaybook(before);
    expect(JSON.stringify(rolledBack)).toBe(JSON.stringify(before));
  });
});
