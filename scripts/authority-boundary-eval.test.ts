import { describe, expect, it } from 'vitest';
import { runAuthorityEvaluation } from './authority-boundary-eval.js';

describe('host authority boundary evaluation', () => {
  it('denies every scoped adversarial fixture against the declared baseline', async () => {
    const report = await runAuthorityEvaluation(20);
    expect(report.baseline.adversarialAttemptsAccepted).toBe(8);
    expect(report.scoped).toMatchObject({
      adversarialAttemptsDenied: 8,
      totalAdversarialAttempts: 8,
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
        functionGlobal: 'passed',
        mcpGlobal: 'passed',
        nestedFunction: 'passed',
        sinkRedrive: 'passed',
      },
      auditRedaction: 'passed',
    });
  });
});
