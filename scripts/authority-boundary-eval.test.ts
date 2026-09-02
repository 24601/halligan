import { describe, expect, it } from 'vitest';
import { runAuthorityEvaluation } from './authority-boundary-eval.js';

describe('host authority boundary evaluation', () => {
  it('denies every scoped adversarial fixture against the declared baseline', async () => {
    const report = await runAuthorityEvaluation(20);
    expect(report.baseline.adversarialAttemptsAccepted).toBe(15);
    expect(report.scoped).toMatchObject({
      adversarialAttemptsDenied: 15,
      totalAdversarialAttempts: 15,
    });
    expect(report).toMatchObject({
      receiptBinding: 'passed',
      attenuation: 'passed',
      cancellation: 'passed',
      malformedClaims: 'passed',
      forgedModelClaims: 'passed',
      immutableSnapshots: 'passed',
      authorizerTimeout: 'passed',
      modelCallablePaths: {
        productionFunction: 'passed',
        productionMCP: 'passed',
        productionUCP: 'passed',
        nativeDSP: 'passed',
        sinkRedrive: 'passed',
      },
      auditRedaction: 'passed',
      evidenceGuards: 'passed',
    });
    // The guard cost is reported beside the like-for-like path it is additive
    // to, not beside the cheaper re-snapshotting loop.
    expect(report.overhead.guardBaselineMeanMs).toBeGreaterThan(0);
    expect(report.overhead.guardedMeanMs).toBeGreaterThan(0);
    expect(Number.isFinite(report.overhead.guardIncrementalMeanMs)).toBe(true);
  });
});
