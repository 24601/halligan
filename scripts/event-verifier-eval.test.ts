import { describe, expect, it } from 'vitest';
import { runEventVerifierEvaluation } from './eval-event-verifier-continuation.js';

describe('event verifier continuation evaluation', () => {
  it('improves recoverable outcomes without hiding hard failures', async () => {
    const report = await runEventVerifierEvaluation();
    expect(report.taskCount).toBe(7);
    expect(report.oneShot.passRate).toBe(1 / 7);
    expect(report.continuation.passRate).toBe(3 / 7);
    expect(report.continuation.attempts).toBeGreaterThan(
      report.oneShot.attempts
    );
    expect(report.continuation.verifierCalls).toBeGreaterThan(
      report.oneShot.verifierCalls
    );
    expect(report.continuation.suppressedVerifierCalls).toBe(1);
    expect(report.continuation.exhaustedCorrectly).toBe(3);
    expect(report.continuation.restartPassed).toBe(true);
    expect(report.oneShot.falsePromotions).toBe(1);
    expect(report.continuation.falsePromotions).toBe(1);
    expect(report.continuation.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});
