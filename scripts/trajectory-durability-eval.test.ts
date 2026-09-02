import { describe, expect, it } from 'vitest';

import {
  AX_TRAJECTORY_EVAL_HONESTY,
  type AxTrajectoryDurabilityReport,
  assertTrajectoryDurabilityEvaluation,
  runTrajectoryDurabilityEvaluation,
} from './trajectory-durability-eval.js';

let cached: AxTrajectoryDurabilityReport | undefined;

async function report(): Promise<AxTrajectoryDurabilityReport> {
  cached ??= await runTrajectoryDurabilityEvaluation();
  return cached;
}

function row(
  data: AxTrajectoryDurabilityReport,
  crashRow: string,
  store: 'memory' | 'jsonl'
) {
  const found = data.rows.find(
    (entry) => entry.crashRow === crashRow && entry.store === store
  );
  if (!found) throw new Error(`no row for ${crashRow}/${store}`);
  return found;
}

describe('trajectory store durability evaluation', () => {
  it('declares a zero-cost deterministic fixture with named baselines', async () => {
    const data = await report();
    expect(data.fixture).toMatchObject({
      kind: 'deterministic-fault-injection',
      providerCalls: 0,
      tokens: 0,
      usd: 0,
      independentModelHeldOut: false,
    });
    expect(data.fixture.baselines).toHaveLength(2);
    expect(data.honesty).toBe(AX_TRAJECTORY_EVAL_HONESTY);
  });

  it('reports the same conformance assertion count from both stores', async () => {
    const data = await report();
    expect(data.conformance.memoryAssertions).toBeGreaterThan(50);
    expect(data.conformance.jsonlAssertions).toBe(
      data.conformance.memoryAssertions
    );
    expect(data.conformance.identical).toBe(true);
    // The counts being equal only means something if the stores differ.
    expect(data.conformance.memoryDurability).toBe('volatile');
    expect(data.conformance.jsonlDurability).toBe('persistent');
  });

  it('loses no step and produces no dangling ref or double append on any row', async () => {
    const data = await report();
    expect(data.rows.length).toBeGreaterThanOrEqual(14);
    for (const entry of data.rows) {
      const label = `${entry.crashRow}/${entry.store}`;
      expect(entry.stepsLost, `${label} stepsLost`).toBe(0);
      expect(entry.danglingRefs, `${label} danglingRefs`).toBe(0);
      expect(entry.doubleAppends, `${label} doubleAppends`).toBe(0);
      expect(entry.classification, `${label} classification`).toBe(
        entry.expected
      );
    }
    // Every property asserted above is also asserted by the exported gate the
    // script runs, so `npm run trajectory:durability:eval` cannot print green
    // on a report this test would reject. The gate's own teeth are pinned by
    // the mutation table below.
    expect(() => assertTrajectoryDurabilityEvaluation(data)).not.toThrow();
  });

  it('baseline rows show no faults at all, so a clean row means something', async () => {
    const data = await report();
    for (const store of ['memory', 'jsonl'] as const) {
      const baseline = row(data, 'baseline-no-fault', store);
      expect(baseline.faultInjected).toBe(false);
      expect(baseline.corruptFramesDropped).toBe(0);
      expect(baseline.cursorResumption).toBe('exact');
    }
  });

  it('C1: a kill before append returns leaves nothing, and the retry commits once', async () => {
    const data = await report();
    for (const store of ['memory', 'jsonl'] as const) {
      const c1 = row(data, 'C1-before-append-returns', store);
      expect(c1.classification).toBe('rejected(blob_write_failed)');
      // Two retries with the same preset stepId; exactly one step survives.
      expect(c1.doubleAppends).toBe(0);
      expect(c1.stepsLost).toBe(0);
    }
  });

  it('C2: the blob is durable and orphaned, and no reference dangles', async () => {
    const data = await report();
    const c2 = row(data, 'C2-blob-then-crash', 'jsonl');
    // The counter-metric to "0 dangling refs": a store that wrote the step
    // line first would show 1 dangling ref and 0 orphan blobs here.
    expect(c2.orphanBlobs).toBe(1);
    expect(c2.danglingRefs).toBe(0);
  });

  it('C3: a torn frame is dropped and counted, never glued', async () => {
    const data = await report();
    for (const store of ['memory', 'jsonl'] as const) {
      const c3 = row(data, 'C3-torn-trailing-frame', store);
      // Counter-metric to "0 steps lost": an implementation that glued the
      // fragment onto the previous record would report 0 corrupt frames.
      expect(c3.corruptFramesDropped).toBeGreaterThanOrEqual(1);
      expect(c3.stepsLost).toBe(0);
    }
  });

  it('C14: an unusable cursor is rejected with its reason, never silently skewed', async () => {
    const data = await report();
    for (const store of ['memory', 'jsonl'] as const) {
      expect(row(data, 'C14-cursor-beyond-end', store).classification).toBe(
        'AxTrajectoryCursorError(beyond_end)'
      );
      expect(
        row(data, 'C14-cursor-identity-changed', store).classification
      ).toBe('AxTrajectoryCursorError(identity_changed)');
    }
    // Only a byte-offset cursor can notice a log that shrank underneath it.
    expect(row(data, 'C14-cursor-shrank', 'jsonl').classification).toBe(
      'AxTrajectoryCursorError(shrank)'
    );
  });

  it('C14: a durable cursor survives an interior drop, or fails closed', async () => {
    const data = await report();
    // The fail-open this row exists to catch: the tolerant parse renumbers
    // every record after a dropped frame, so a saved `seq` names a different
    // one and a committed step is silently never delivered.
    const recovered = row(data, 'C14-cursor-interior-frame-dropped', 'jsonl');
    expect(recovered.corruptFramesDropped).toBe(1);
    expect(recovered.cursorStepsSkipped).toBe(0);
    // Counter-metric: skipping nothing is also satisfied by delivering
    // nothing, so the resume must have handed over the undelivered records.
    expect(recovered.cursorStepsDelivered).toBe(3);

    const refused = row(data, 'C14-cursor-not-a-frame-boundary', 'jsonl');
    expect(refused.classification).toBe(
      'AxTrajectoryCursorError(not_a_frame_boundary)'
    );
    expect(refused.cursorStepsSkipped).toBe(0);
  });

  it('the shipped gate rejects every failure the report can express', async () => {
    const data = await report();
    const mutate = (
      change: (row: AxTrajectoryDurabilityReport['rows'][number]) => object,
      pick: (row: AxTrajectoryDurabilityReport['rows'][number]) => boolean
    ): AxTrajectoryDurabilityReport => ({
      ...data,
      rows: data.rows.map((entry) =>
        pick(entry) ? { ...entry, ...change(entry) } : entry
      ),
    });

    const cases: readonly [string, AxTrajectoryDurabilityReport, RegExp][] = [
      [
        'a lost committed step',
        mutate(
          () => ({ stepsLost: 1 }),
          (entry) => entry.crashRow === 'baseline-no-fault'
        ),
        /lost 1 committed steps/,
      ],
      [
        'a silently skipped step on resume',
        mutate(
          () => ({ cursorStepsSkipped: 1 }),
          (entry) => entry.crashRow === 'C14-cursor-interior-frame-dropped'
        ),
        /silently skipped 1 committed steps/,
      ],
      [
        'a resume that delivered nothing',
        mutate(
          () => ({ cursorStepsDelivered: 0 }),
          (entry) => entry.crashRow === 'C14-cursor-interior-frame-dropped'
        ),
        /without delivering any committed step/,
      ],
      [
        'C2 losing its orphan blob',
        mutate(
          () => ({ orphanBlobs: 0 }),
          (entry) => entry.crashRow === 'C2-blob-then-crash'
        ),
        /did not leave exactly one orphan blob/,
      ],
      [
        'C3 counting no torn frame',
        mutate(
          () => ({ corruptFramesDropped: 0 }),
          (entry) => entry.crashRow === 'C3-torn-trailing-frame'
        ),
        /did not count the torn frame/,
      ],
    ];
    for (const [label, broken, message] of cases) {
      expect(() => assertTrajectoryDurabilityEvaluation(broken), label).toThrow(
        message
      );
    }

    // The truncation study's two-sidedness is in the gate too.
    expect(() =>
      assertTrajectoryDurabilityEvaluation({
        ...data,
        truncation: {
          ...data.truncation,
          probes: data.truncation.probes.filter(
            (probe) => probe.atRecordBoundary
          ),
        },
      })
    ).toThrow(/cut no mid-record offset/);
    // And so is the "identical assertion count" claim's own precondition.
    expect(() =>
      assertTrajectoryDurabilityEvaluation({
        ...data,
        conformance: { ...data.conformance, jsonlDurability: 'volatile' },
      })
    ).toThrow(/same durability class/);
  });

  it('recovers exactly the complete records that survived every truncation', async () => {
    const data = await report();
    const { truncation } = data;
    expect(truncation.totalRecords).toBeGreaterThan(10);
    // Every record boundary plus three mid-record offsets.
    expect(truncation.probes.length).toBeGreaterThanOrEqual(
      truncation.totalRecords + 3
    );
    expect(truncation.gluedFramesTotal).toBe(0);
    expect(truncation.stepsLostBeyondTruncation).toBe(0);

    // Two-sided: "0 glued" would also be satisfied by a study that never cut a
    // record, so at least one mid-record probe must have dropped a fragment.
    const midRecord = truncation.probes.filter(
      (probe) => !probe.atRecordBoundary
    );
    expect(midRecord.length).toBeGreaterThanOrEqual(3);
    expect(midRecord.every((probe) => probe.corruptFramesDropped >= 1)).toBe(
      true
    );
    for (const probe of truncation.probes) {
      expect(probe.recoveredSteps, `offset ${probe.offset}`).toBe(
        probe.expectedSteps
      );
    }
  });
});
