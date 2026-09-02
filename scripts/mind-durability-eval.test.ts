import { beforeAll, describe, expect, it } from 'vitest';

import {
  AX_MIND_DURABILITY_BASELINES,
  AX_MIND_DURABILITY_HONESTY,
  type AxMindCrashRow,
  type AxMindDurabilityReport,
  type AxMindDurabilityRow,
  assertMindDurabilityEvaluation,
  runMindDurabilityEvaluation,
} from './mind-durability-eval.js';

let report: Readonly<AxMindDurabilityReport>;

beforeAll(async () => {
  report = await runMindDurabilityEvaluation();
}, 120_000);

const pick = (row: AxMindCrashRow): AxMindDurabilityRow =>
  report.rows.find((one) => one.row === row) as AxMindDurabilityRow;

function mutate(
  change: (report: {
    rows: AxMindDurabilityRow[];
    concurrency: AxMindDurabilityReport['concurrency'];
    naiveGuardBaseline: AxMindDurabilityReport['naiveGuardBaseline'];
    watchdogBaseline: AxMindDurabilityReport['watchdogBaseline'];
    siblingSuppression: {
      routeFixedPoint: AxMindDurabilityReport['siblingSuppression']['routeFixedPoint'];
      endToEnd: AxMindDurabilityReport['siblingSuppression']['endToEnd'];
    };
  }) => void
): Readonly<AxMindDurabilityReport> {
  const draft = {
    rows: report.rows.map((row) => ({ ...row })),
    concurrency: { ...report.concurrency },
    naiveGuardBaseline: { ...report.naiveGuardBaseline },
    watchdogBaseline: { ...report.watchdogBaseline },
    siblingSuppression: {
      routeFixedPoint: { ...report.siblingSuppression.routeFixedPoint },
      endToEnd: { ...report.siblingSuppression.endToEnd },
    },
  };
  change(draft);
  return { ...report, ...draft };
}

describe('mind durability evaluation', () => {
  it('spends nothing and states what it is not', () => {
    expect(report.budget).toMatchObject({
      providerCalls: 0,
      tokens: 0,
      usd: 0,
    });
    expect(report.honesty).toBe(AX_MIND_DURABILITY_HONESTY);
    expect(report.honesty).toContain('not a held-out model comparison');
    expect(report.baseline).toBe(AX_MIND_DURABILITY_BASELINES);
  });

  it('bounds a two-thinker mind and still wakes both from outside', () => {
    const sibling = report.siblingSuppression;
    // The metric: the shipped predicate reaches a fixed point at zero
    // admitted wakes, while the same predicate with no siblings named runs
    // straight into its ceiling.
    expect(sibling.routeFixedPoint.withRuleQuiesced).toBe(true);
    expect(sibling.routeFixedPoint.withRuleAdmittedWakes).toBe(0);
    expect(sibling.routeFixedPoint.withoutRuleQuiesced).toBe(false);
    expect(sibling.routeFixedPoint.withoutRuleAdmittedWakes).toBe(
      sibling.routeFixedPoint.ceiling
    );
    expect(sibling.endToEnd.ceilingHit).toBe(false);
    expect(sibling.endToEnd.siblingWakesSuppressed).toBeGreaterThan(0);
    // The counter-metric, reported beside the metric.
    expect(sibling.endToEnd.thinkersWokenByExternalStep).toBe(
      sibling.endToEnd.thinkers
    );
  });

  it('covers every crash row from C4 to C14', () => {
    expect(report.rows.map((row) => row.row)).toEqual([
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'C9',
      'C10',
      'C11',
      'C12',
      'C13',
      'C14',
    ]);
    for (const row of report.rows) {
      expect(row.killPoint.length).toBeGreaterThan(10);
      expect(row.note.length).toBeGreaterThan(10);
    }
  });

  it('passes its own shipped gate', () => {
    expect(() => assertMindDurabilityEvaluation(report)).not.toThrow();
  });

  it('loses no committed step and sends nothing twice, on every row', () => {
    for (const row of report.rows) {
      expect(row.stepsLost).toBe(0);
      expect(row.duplicateSends).toBe(0);
      expect(row.mindAlive).toBe(true);
    }
  });

  it('classifies the three transport kill points differently', () => {
    // C7 died before anything left, so the retry sends exactly once.
    expect(pick('C7').transportCalls).toBe(1);
    expect(pick('C7').effectsSettled).toBe(1);
    expect(pick('C7').effectsDispatched).toBe(0);
    // C8 and C9 both left an unconfirmed send behind. Neither is retried.
    for (const row of ['C8', 'C9'] as const) {
      expect(pick(row).transportCalls).toBe(1);
      expect(pick(row).effectsDispatched).toBeGreaterThan(0);
      expect(pick(row).effectsSettled).toBe(0);
    }
  });

  it('converges the log to the ledger on C10 and never twice', () => {
    expect(pick('C10').effectsSettled).toBe(1);
    expect(pick('C10').duplicateSends).toBe(0);
    expect(pick('C10').note).toContain('a second reconcile appended nothing');
  });

  it('rebuilds pacer state from the trajectory alone on C12', () => {
    expect(pick('C12').mindAlive).toBe(true);
    expect(pick('C12').note).toMatch(/level [1-9]/);
    expect(pick('C12').note).toContain('no second authority');
  });

  it('fails closed and loudly on an unusable cursor', () => {
    expect(pick('C14').note).toContain('identity_changed');
    expect(pick('C14').note).toContain('left the other draining');
  });

  it('sends exactly one message per inbound, with declines beside it', () => {
    const run = report.concurrency;
    expect(run.responders).toBe(3);
    expect(run.inboundMessages).toBe(20);
    expect(run.transportSends).toBe(20);
    expect(run.duplicateSends).toBe(0);
    // The counter-metric: zero duplicates is also satisfiable by never
    // replying, so the losers' recorded declines are reported beside it.
    expect(run.declinesRecorded).toBeGreaterThan(0);
    expect(run.transportFailures).toBeGreaterThan(0);
  });

  it('states the negative: an unconfirmed send is missing until a resolver settles it', () => {
    const run = report.concurrency;
    expect(run.messagesSent).toBeLessThan(run.inboundMessages);
    expect(run.unconfirmedSends).toBe(run.transportFailures);
    expect(run.messagesSent + run.unconfirmedSends).toBe(run.inboundMessages);
    // Sends are not exactly-once. What IS guaranteed is that nothing is
    // re-dispatched blind, and that a resolver closes the gap.
    expect(run.messagesAfterResolver).toBe(run.inboundMessages);
  });

  it('shows both declared baselines are actually worse', () => {
    expect(report.naiveGuardBaseline.duplicateSends).toBeGreaterThan(0);
    expect(report.watchdogBaseline.withoutWatchdogWakes).toBe(0);
    expect(report.watchdogBaseline.withWatchdogWakes).toBeGreaterThan(0);
    // MEASURED, not arithmetic: an hour of event time at a 300_000 ms window
    // cannot produce more wakes than it has windows, and a hand-written
    // `Math.floor(3_600_000 / WATCHDOG_MS)` could never come in under it.
    expect(report.watchdogBaseline.withWatchdogWakes).toBeLessThanOrEqual(
      Math.ceil(3_600_000 / 300_000) * 2
    );
  });

  it('measures liveness per row rather than asserting it', () => {
    // The paired claim "row X left the mind dead" is only falsifiable if
    // `mindAlive` comes from a mind that actually ran. A literal would make
    // every row identical here; a measurement does not.
    expect(report.rows.every((row) => row.mindAlive)).toBe(true);
    const windows = new Set(
      report.rows.map((row) => row.recoveryWatchdogWindows)
    );
    expect(windows.size).toBeGreaterThan(1);
    expect(report.rows.some((row) => row.recoveryWatchdogWindows > 0)).toBe(
      true
    );
  });

  it.each([
    [
      'a lost step',
      (draft: { rows: AxMindDurabilityRow[] }) => {
        Object.assign(draft.rows[0]!, { stepsLost: 1 });
      },
    ],
    [
      'a duplicate send',
      (draft: { rows: AxMindDurabilityRow[] }) => {
        Object.assign(draft.rows[4]!, { duplicateSends: 1 });
      },
    ],
    [
      'a dead mind',
      (draft: { rows: AxMindDurabilityRow[] }) => {
        Object.assign(draft.rows[2]!, { mindAlive: false });
      },
    ],
    [
      'an indeterminate send that was retried blind',
      (draft: { rows: AxMindDurabilityRow[] }) => {
        const row = draft.rows.find((one) => one.row === 'C8')!;
        Object.assign(row, { transportCalls: 2 });
      },
    ],
    [
      'an indeterminate send that was silently settled',
      (draft: { rows: AxMindDurabilityRow[] }) => {
        const row = draft.rows.find((one) => one.row === 'C8')!;
        Object.assign(row, { effectsDispatched: 0, effectsParked: 0 });
      },
    ],
    [
      'a message count that does not match the inbound count',
      (draft: { concurrency: AxMindDurabilityReport['concurrency'] }) => {
        Object.assign(draft.concurrency, { transportSends: 19 });
      },
    ],
    [
      'a run with no recorded declines',
      (draft: { concurrency: AxMindDurabilityReport['concurrency'] }) => {
        Object.assign(draft.concurrency, { declinesRecorded: 0 });
      },
    ],
    [
      'a resolver that did not converge the log',
      (draft: { concurrency: AxMindDurabilityReport['concurrency'] }) => {
        Object.assign(draft.concurrency, { messagesAfterResolver: 15 });
      },
    ],
    [
      'a naive baseline that produced no duplicates',
      (draft: {
        naiveGuardBaseline: AxMindDurabilityReport['naiveGuardBaseline'];
      }) => {
        Object.assign(draft.naiveGuardBaseline, { duplicateSends: 0 });
      },
    ],
    [
      'a no-watchdog baseline that recovered on its own',
      (draft: {
        watchdogBaseline: AxMindDurabilityReport['watchdogBaseline'];
      }) => {
        Object.assign(draft.watchdogBaseline, { withoutWatchdogWakes: 3 });
      },
    ],
    [
      'a two-thinker mind that never quiesced',
      (draft: {
        siblingSuppression: { routeFixedPoint: Record<string, unknown> };
      }) => {
        Object.assign(draft.siblingSuppression.routeFixedPoint, {
          withRuleQuiesced: false,
        });
      },
    ],
    [
      'a sibling baseline that was never a runaway',
      (draft: {
        siblingSuppression: { routeFixedPoint: Record<string, unknown> };
      }) => {
        Object.assign(draft.siblingSuppression.routeFixedPoint, {
          withoutRuleQuiesced: true,
        });
      },
    ],
    [
      'a two-thinker mind that passed its append ceiling',
      (draft: {
        siblingSuppression: { endToEnd: Record<string, unknown> };
      }) => {
        Object.assign(draft.siblingSuppression.endToEnd, { ceilingHit: true });
      },
    ],
    [
      'a bound bought by deafness: the external step woke only one thinker',
      (draft: {
        siblingSuppression: { endToEnd: Record<string, unknown> };
      }) => {
        Object.assign(draft.siblingSuppression.endToEnd, {
          thinkersWokenByExternalStep: 1,
        });
      },
    ],
    [
      'a bound with no suppression behind it',
      (draft: {
        siblingSuppression: { endToEnd: Record<string, unknown> };
      }) => {
        Object.assign(draft.siblingSuppression.endToEnd, {
          siblingWakesSuppressed: 0,
        });
      },
    ],
  ])('the gate rejects %s', (_name, change) => {
    expect(() =>
      assertMindDurabilityEvaluation(mutate(change as never))
    ).toThrow(/mind durability evaluation failed/);
  });
});
