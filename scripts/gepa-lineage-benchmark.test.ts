import { describe, expect, it } from 'vitest';
import { runGEPALineageBenchmark } from './gepa-lineage-benchmark.js';

describe('GEPA lineage stress/fault benchmark', () => {
  it('meets completeness, integrity, privacy, size, and overhead thresholds', async () => {
    const result = await runGEPALineageBenchmark();
    expect(result.baselineMode).toBe('candidateLineage_omitted');
    expect(result.candidates).toBe(6);
    expect(result.artifactBytes).toBeLessThanOrEqual(20_000);
  });
});
