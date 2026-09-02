import { describe, expect, it } from 'vitest';
import {
  axAdvanceHarnessFailureManifest,
  axHarnessFailureFingerprint,
  axNormalizeHarnessFailureCause,
} from './manifest.js';
import type { AxHarnessFailureObservation } from './types.js';

const observation = (
  overrides: Partial<AxHarnessFailureObservation> = {}
): AxHarnessFailureObservation => ({
  taskId: 't1',
  stage: 'run',
  cause: 'boom',
  ...overrides,
});

describe('axNormalizeHarnessFailureCause', () => {
  const CASES: readonly [string, string, string][] = [
    [
      'absolute posix path',
      'ENOENT open /Users/someone/repo/src/file.ts',
      'ENOENT open <path>',
    ],
    [
      'windows path',
      'cannot read C:\\Users\\someone\\repo\\file.ts',
      'cannot read <path>',
    ],
    ['digit runs', 'timed out after 30000 ms', 'timed out after <n> ms'],
    [
      'long identifier run',
      'request 0123456789abcdef0123 failed',
      'request <id> failed',
    ],
    ['whitespace', 'a\n\n   b\t c', 'a b c'],
  ];

  it.each(CASES)('normalizes %s', (_name, input, expected) => {
    expect(axNormalizeHarnessFailureCause(input)).toBe(expected);
  });

  it('keeps a 40-char hex token out of the persisted cause', () => {
    const token = '0123456789abcdef0123456789abcdef01234567';
    const normalized = axNormalizeHarnessFailureCause(
      `auth failed with token ${token}`
    );
    expect(normalized).not.toContain(token);
    expect(normalized).toBe('auth failed with token <id>');
  });

  it('truncates to 200 characters', () => {
    expect(
      axNormalizeHarnessFailureCause('x'.repeat(500)).length
    ).toBeLessThanOrEqual(200);
  });
});

describe('axHarnessFailureFingerprint', () => {
  it('is 16 hex characters and stable', async () => {
    const first = await axHarnessFailureFingerprint(observation());
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await axHarnessFailureFingerprint(observation())).toBe(first);
  });

  it('gives one fingerprint to the same cause under different absolute paths', async () => {
    const a = await axHarnessFailureFingerprint(
      observation({ cause: 'ENOENT /Users/alice/repo/a.ts' })
    );
    const b = await axHarnessFailureFingerprint(
      observation({ cause: 'ENOENT /home/bob/other/b.ts' })
    );
    expect(a).toBe(b);
  });

  it('separates different tasks and different stages', async () => {
    const base = await axHarnessFailureFingerprint(observation());
    expect(
      await axHarnessFailureFingerprint(observation({ taskId: 't2' }))
    ).not.toBe(base);
    expect(
      await axHarnessFailureFingerprint(observation({ stage: 'metric' }))
    ).not.toBe(base);
  });
});

describe('axAdvanceHarnessFailureManifest', () => {
  it('classifies new / persisting / fixed across three steps', async () => {
    const first = await axAdvanceHarnessFailureManifest(
      undefined,
      [observation({ cause: 'A fails' }), observation({ cause: 'B fails' })],
      1
    );
    expect(first.new).toHaveLength(2);
    expect(first.persisting).toEqual([]);
    expect(first.fixed).toEqual([]);
    expect(first.manifest.step).toBe(1);
    expect(first.manifest.entries.every((e) => e.firstSeenStep === 1)).toBe(
      true
    );

    const second = await axAdvanceHarnessFailureManifest(
      first.manifest,
      [observation({ cause: 'A fails' }), observation({ cause: 'C fails' })],
      2
    );
    expect(second.persisting).toHaveLength(1);
    expect(second.new).toHaveLength(1);
    expect(second.fixed).toHaveLength(1);
    const persisted = second.manifest.entries.find(
      (e) => e.fingerprint === second.persisting[0]
    );
    expect(persisted?.firstSeenStep).toBe(1);
    expect(persisted?.lastSeenStep).toBe(2);
    expect(persisted?.count).toBe(2);
    // A fixed fingerprint leaves the manifest, which describes what is broken
    // NOW.
    expect(second.manifest.entries).toHaveLength(2);

    const third = await axAdvanceHarnessFailureManifest(second.manifest, [], 3);
    expect(third.fixed).toHaveLength(2);
    expect(third.manifest.entries).toEqual([]);
    expect(third.manifest.step).toBe(3);
  });

  it('counts repeats within a single step', async () => {
    const advanced = await axAdvanceHarnessFailureManifest(
      undefined,
      [
        observation({ cause: 'flaky' }),
        observation({ cause: 'flaky' }),
        observation({ cause: 'flaky' }),
      ],
      1
    );
    expect(advanced.manifest.entries).toHaveLength(1);
    expect(advanced.manifest.entries[0]?.count).toBe(3);
    expect(advanced.new).toHaveLength(1);
  });

  it('emits entries in a deterministic order', async () => {
    const observations = [
      observation({ taskId: 'z' }),
      observation({ taskId: 'a' }),
      observation({ taskId: 'm' }),
    ];
    const forward = await axAdvanceHarnessFailureManifest(
      undefined,
      observations,
      1
    );
    const reversed = await axAdvanceHarnessFailureManifest(
      undefined,
      [...observations].reverse(),
      1
    );
    expect(forward.manifest.entries.map((e) => e.fingerprint)).toEqual(
      reversed.manifest.entries.map((e) => e.fingerprint)
    );
  });

  it('stores only normalized causes', async () => {
    const advanced = await axAdvanceHarnessFailureManifest(
      undefined,
      [observation({ cause: 'failed at /a/b/c.ts after 500ms' })],
      1
    );
    expect(advanced.manifest.entries[0]?.cause).toBe(
      'failed at <path> after <n>ms'
    );
  });
});
