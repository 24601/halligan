import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AxManualEventClock } from '../event/types.js';
import { AxInMemoryTrajectoryStore } from './memoryStore.js';
import { axTrajectoryTypeRegistry } from './registry.js';
import type { AxTrajectoryTypeDescriptor } from './types.js';

/**
 * The axmind conformance fixtures are TypeScript-consumed in v1:
 * `conformanceSuitePaths` in tools/axir/internal/axir/verify.go is a hardcoded
 * directory list that does not include `axmind`, so the five generated targets
 * do not read them. Registering the suite is filed in the AxIR backlog. This
 * file is what actually runs them, so shipping them is not a claim of coverage
 * nobody exercises.
 */
// vitest runs this workspace with cwd = src/ax, so the fixtures are located
// from this file rather than from the process.
const FIXTURES = fileURLToPath(
  new URL('../../../ir/conformance/axmind/', import.meta.url)
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

interface ClassificationFixture {
  readonly name: string;
  readonly kind: string;
  readonly operation: string;
  readonly cases: readonly {
    readonly type: string;
    readonly expected: Partial<AxTrajectoryTypeDescriptor>;
  }[];
}

interface TailFixture {
  readonly name: string;
  readonly log: {
    readonly headerType: string;
    readonly machineryType: string;
    readonly narrativeType: string;
    readonly narrativeEvery: number;
    readonly steps: number;
  };
  readonly cases: readonly {
    readonly name: string;
    readonly query: {
      readonly limit: number;
      readonly types: readonly string[];
      readonly maxScan: number;
    };
    readonly expected: {
      readonly matched: number;
      readonly scanned?: number;
      readonly exhausted: boolean;
    };
  }[];
}

describe('ir/conformance/axmind/trajectory-step-classification.json', () => {
  const data = fixture<ClassificationFixture>(
    'trajectory-step-classification.json'
  );

  it('describes the trajectory step-classification behaviour', () => {
    expect(data.kind).toBe('trajectory');
    expect(data.operation).toBe('step_classification');
    expect(data.cases.length).toBeGreaterThan(5);
  });

  it.each(data.cases.map((entry) => [entry.type, entry] as const))(
    'classifies %s as the fixture declares',
    (_type, entry) => {
      const descriptor = axTrajectoryTypeRegistry().describe(entry.type);
      for (const [field, value] of Object.entries(entry.expected)) {
        expect(
          descriptor[field as keyof AxTrajectoryTypeDescriptor],
          `${entry.type}.${field}`
        ).toEqual(value);
      }
    }
  );
});

describe('ir/conformance/axmind/trajectory-tail-budget.json', () => {
  const data = fixture<TailFixture>('trajectory-tail-budget.json');

  it.each(data.cases.map((entry) => [entry.name, entry] as const))(
    'tail budget: %s',
    async (_name, entry) => {
      const clock = new AxManualEventClock(1_000);
      const store = new AxInMemoryTrajectoryStore({ clock });
      const { trajectoryId } = await store.create({});
      for (let index = 0; index < data.log.steps; index++) {
        const narrative = index % data.log.narrativeEvery === 0;
        await store.append({
          trajectoryId,
          type: narrative ? data.log.narrativeType : data.log.machineryType,
          ...(narrative ? { source: 'human' } : {}),
          data: { index },
        });
      }

      const result = await store.tailBackward({
        trajectoryId,
        limit: entry.query.limit,
        types: entry.query.types,
        maxScan: entry.query.maxScan,
      });

      expect(result.steps).toHaveLength(entry.expected.matched);
      expect(result.exhausted).toBe(entry.expected.exhausted);
      if (entry.expected.scanned !== undefined) {
        expect(result.scanned).toBe(entry.expected.scanned);
      }
      expect(result.scanned).toBeLessThanOrEqual(entry.query.maxScan);
    }
  );

  it('reports the header step as structural, not narrative', async () => {
    const clock = new AxManualEventClock(1_000);
    const store = new AxInMemoryTrajectoryStore({ clock });
    const { trajectoryId } = await store.create({});
    const structural = await store.read({
      trajectoryId,
      classes: ['structural'],
      limit: 5,
    });
    expect(structural.map((step) => step.type)).toEqual([data.log.headerType]);
  });
});
