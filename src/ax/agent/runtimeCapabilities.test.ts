import { describe, expect, it } from 'vitest';

import type { AxCodeRuntime, AxCodeSession } from './rlm.js';
import {
  type AxRuntimeConformanceObservations,
  axCodeRuntimeProtocol,
  axCodeRuntimeProtocolVersion,
  axEvaluateRuntimeConformance,
  axSelectCodeRuntime,
  type RuntimeCapabilities,
} from './runtimeCapabilities.js';

const unsupportedSession: AxCodeSession = {
  execute: async () => undefined,
  patchGlobals: async () => {},
  close: () => {},
};

function capabilities(
  overrides: Partial<RuntimeCapabilities> = {}
): RuntimeCapabilities {
  return {
    inspect: false,
    snapshot: false,
    patch: true,
    abort: false,
    language: 'JavaScript',
    protocol: {
      name: axCodeRuntimeProtocol,
      version: axCodeRuntimeProtocolVersion,
    },
    persistence: { session: true, restart: false },
    resources: { timeoutEnforcement: 'none' },
    authority: { host: 'unknown', modules: 'unknown', network: 'unknown' },
    ...overrides,
  };
}

function runtime(
  declaration?: RuntimeCapabilities,
  session: AxCodeSession = unsupportedSession
): AxCodeRuntime {
  return {
    ...(declaration ? { capabilities: declaration } : {}),
    language: declaration?.language,
    getUsageInstructions: () => '',
    createSession: () => session,
  };
}

function observations(
  overrides: Partial<AxRuntimeConformanceObservations> = {}
): AxRuntimeConformanceObservations {
  return {
    language: 'JavaScript',
    inspect: false,
    snapshot: false,
    patch: true,
    abort: false,
    persistence: { session: true, restart: false },
    authority: {
      hostDenied: false,
      modulesDenied: false,
      networkDenied: false,
    },
    protocol: {
      name: axCodeRuntimeProtocol,
      version: axCodeRuntimeProtocolVersion,
      malformedEnvelopeRejected: true,
      mismatchRejected: true,
    },
    cleanup: true,
    ...overrides,
  };
}

describe('axSelectCodeRuntime', () => {
  it('preserves blind first-runtime selection when requirements are omitted', () => {
    const legacy = runtime();
    const declared = runtime(capabilities({ inspect: true }));

    expect(axSelectCodeRuntime([legacy, declared])).toMatchObject({
      runtime: legacy,
      index: 0,
      requirementAware: false,
      rejected: [],
    });
  });

  it('fails closed on missing and malformed declarations', () => {
    const missing = runtime();
    const malformed = runtime();
    Object.assign(malformed, { capabilities: { inspect: true } });
    const matching = runtime(capabilities({ inspect: true }));

    const result = axSelectCodeRuntime([missing, malformed, matching], {
      inspect: true,
    });
    expect(result.index).toBe(2);
    expect(result.rejected).toEqual([
      { index: 0, reasons: ['missing or malformed capabilities declaration'] },
      { index: 1, reasons: ['missing or malformed capabilities declaration'] },
    ]);
  });

  it('selects by language, protocol, persistence, resources, and authority', () => {
    const broad = runtime(
      capabilities({
        inspect: true,
        snapshot: true,
        abort: true,
        persistence: { session: true, restart: true },
        resources: {
          timeoutMs: 1_000,
          timeoutEnforcement: 'cooperative',
          memoryMb: 256,
        },
        authority: {
          host: 'unrestricted',
          modules: 'unrestricted',
          network: 'unrestricted',
        },
      })
    );
    const bounded = runtime(
      capabilities({
        inspect: true,
        snapshot: true,
        abort: true,
        persistence: { session: true, restart: true },
        resources: {
          timeoutMs: 100,
          timeoutEnforcement: 'hard',
          memoryMb: 64,
        },
        authority: { host: 'denied', modules: 'allowlist', network: 'denied' },
      })
    );

    const result = axSelectCodeRuntime([broad, bounded], {
      inspect: true,
      snapshot: true,
      abort: true,
      language: ['JavaScript', 'Python'],
      protocol: {
        name: axCodeRuntimeProtocol,
        version: axCodeRuntimeProtocolVersion,
      },
      persistence: { session: true, restart: true },
      resources: {
        maxTimeoutMs: 100,
        timeoutEnforcement: 'hard',
        maxMemoryMb: 64,
      },
      authority: { host: 'denied', modules: 'allowlist', network: 'denied' },
    });

    expect(result.index).toBe(1);
    expect(result.rejected[0]?.reasons).toEqual(
      expect.arrayContaining([
        'requires timeout at most 100ms',
        'requires hard timeout enforcement',
        'requires memory limit at most 64MB',
        'requires host authority no broader than denied',
        'requires modules authority no broader than allowlist',
        'requires network authority no broader than denied',
      ])
    );
  });

  it('rejects unsupported requirements rather than silently falling back', () => {
    expect(() =>
      axSelectCodeRuntime([runtime(capabilities())], {
        inspect: true,
        snapshot: true,
        abort: true,
        persistence: { restart: true },
      })
    ).toThrow(/requires inspect.*requires snapshot.*requires abort.*restart/s);
  });

  it('rejects protocol mismatches', () => {
    expect(() =>
      axSelectCodeRuntime([runtime(capabilities())], {
        protocol: { name: axCodeRuntimeProtocol, version: '2' },
      })
    ).toThrow(/requires protocol ax-code-runtime\/2/);
  });

  it('rejects a language property that contradicts the declaration', () => {
    const contradictory = runtime(capabilities());
    Object.assign(contradictory, { language: 'Python' });

    expect(() => axSelectCodeRuntime([contradictory], { patch: true })).toThrow(
      /runtime language contradicts capabilities declaration/
    );
  });
});

describe('axEvaluateRuntimeConformance', () => {
  it('accepts truthful unsupported capabilities without treating absence as failure', () => {
    const report = axEvaluateRuntimeConformance(capabilities(), observations());
    expect(report).toEqual({
      conformant: true,
      falseConfidence: [],
      failures: [],
      isolationProven: false,
    });
  });

  it('reports false confidence for incorrect declarations and resource overshoot', () => {
    const report = axEvaluateRuntimeConformance(
      capabilities({
        inspect: true,
        snapshot: true,
        abort: true,
        persistence: { session: true, restart: true },
        resources: { timeoutMs: 50, timeoutEnforcement: 'hard' },
        authority: { host: 'denied', modules: 'denied', network: 'denied' },
      }),
      observations({
        patch: false,
        persistence: { session: false, restart: false },
        timeout: { requestedMs: 50, observedMs: 80, interrupted: false },
      })
    );

    expect(report.conformant).toBe(false);
    expect(report.isolationProven).toBe(false);
    expect(report.falseConfidence).toEqual([
      'inspect was declared but not observed',
      'snapshot was declared but not observed',
      'patch was declared but not observed',
      'abort was declared but not observed',
      'session persistence was declared but not observed',
      'restart persistence was declared but not observed',
      'host denial was declared but not observed',
      'modules denial was declared but not observed',
      'network denial was declared but not observed',
      'declared timeout bound was not observed',
    ]);
  });

  it('reports malformed envelopes, protocol mismatch, and cleanup failures', () => {
    const report = axEvaluateRuntimeConformance(
      capabilities(),
      observations({
        protocol: {
          name: axCodeRuntimeProtocol,
          version: '2',
          malformedEnvelopeRejected: false,
          mismatchRejected: false,
        },
        cleanup: false,
      })
    );

    expect(report.falseConfidence).toContain(
      'declared protocol did not match the observed protocol'
    );
    expect(report.failures).toEqual([
      'malformed protocol envelope was not rejected',
      'protocol mismatch was not rejected',
      'runtime cleanup was not observed',
    ]);
  });

  it('reports an observed language mismatch', () => {
    const report = axEvaluateRuntimeConformance(
      capabilities(),
      observations({ language: 'Python' })
    );

    expect(report.falseConfidence).toEqual([
      'declared language did not match the observed language',
    ]);
  });
});
