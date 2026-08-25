import { describe, expect, it } from 'vitest';

import type { AxCodeRuntime, AxCodeSession } from './rlm.js';
import {
  type AxIRRuntimeCapabilities,
  type AxRuntimeAdmissionEvidence,
  type AxRuntimeCapabilities,
  type AxRuntimeCapabilityObservations,
  axCodeRuntimeProtocol,
  axCodeRuntimeProtocolVersion,
  axCreateRuntimeAdmissionReceipt,
  axCreateRuntimeCapabilities,
  axExtendAxIRRuntimeCapabilities,
  axNormalizeAxIRRuntimeCapabilities,
  axReportRuntimeCapabilityContradictions,
  axRuntimeCapabilitiesToAxIR,
  axRuntimeCapabilitiesVersion,
  axRuntimeProtocolFromToken,
  axSelectCodeRuntime,
} from './runtimeCapabilities.js';

const unsupportedSession: AxCodeSession = {
  execute: async () => undefined,
  patchGlobals: async () => {},
  close: () => {},
};

const deniedPlatform = {
  filesystem: 'denied',
  childProcess: 'denied',
  storage: 'denied',
  communication: 'denied',
  timing: 'denied',
  workers: 'denied',
  codeLoading: 'denied',
  nativeAddons: 'denied',
  wasi: 'denied',
} as const;

function capabilities(
  overrides: Partial<AxRuntimeCapabilities> = {}
): AxRuntimeCapabilities {
  return axCreateRuntimeCapabilities({
    schemaVersion: axRuntimeCapabilitiesVersion,
    inspect: false,
    snapshot: false,
    patch: true,
    abort: false,
    language: 'JavaScript',
    usageInstructions: 'Use JavaScript.',
    platform: 'node',
    protocol: {
      name: axCodeRuntimeProtocol,
      version: axCodeRuntimeProtocolVersion,
      features: [],
    },
    persistence: { session: true, restart: false },
    resources: { timeoutEnforcement: 'none' },
    authority: {
      host: 'unknown',
      modules: 'unknown',
      network: 'unknown',
      platform: deniedPlatform,
    },
    ...overrides,
  });
}

function runtime(
  declaration?: AxRuntimeCapabilities,
  session: AxCodeSession = unsupportedSession
): AxCodeRuntime {
  return {
    ...(declaration ? { capabilities: declaration } : {}),
    language: declaration?.language,
    getUsageInstructions: () => '',
    createSession: () => session,
  };
}

function admissionEvidence(
  overrides: Partial<AxRuntimeAdmissionEvidence> = {}
): AxRuntimeAdmissionEvidence {
  return {
    evaluator: 'test host policy',
    source: 'host-policy',
    resources: {
      timeoutMs: 100,
      timeoutEnforcement: 'hard',
      memoryMb: 64,
    },
    authority: {
      host: 'denied',
      modules: 'denied',
      network: 'denied',
      platform: deniedPlatform,
    },
    ...overrides,
  };
}

const observedPlatform = Object.fromEntries(
  Object.keys(deniedPlatform).map((key) => [key, { observed: 'denied' }])
) as AxRuntimeCapabilityObservations['authority']['platform'];

function observations(
  overrides: Partial<AxRuntimeCapabilityObservations> = {}
): AxRuntimeCapabilityObservations {
  return {
    provenance: {
      evaluator: 'deterministic adapter',
      source: 'adapter-execution',
    },
    language: 'JavaScript',
    platform: 'node',
    inspect: false,
    snapshot: false,
    patch: true,
    abort: false,
    persistence: { session: true, restart: false },
    authority: {
      host: 'unknown',
      modules: 'unknown',
      network: 'unknown',
      platform: observedPlatform,
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

describe('AxIR capability conversion', () => {
  it('uses an explicit versioned superset and lossless base conversion', () => {
    const axir: AxIRRuntimeCapabilities = {
      inspect: true,
      snapshot: false,
      patch: true,
      abort: false,
      language: 'Python',
      usageInstructions: 'Use Python.',
    };
    const extended = axExtendAxIRRuntimeCapabilities(axir, {
      platform: 'unknown',
      protocol: { name: 'process-runtime', version: '1', features: [] },
      persistence: { session: true, restart: true },
      resources: { timeoutEnforcement: 'cooperative' },
      authority: {
        host: 'unknown',
        modules: 'unknown',
        network: 'unknown',
        platform: deniedPlatform,
      },
    });

    expect(extended.schemaVersion).toBe('ax-runtime-capabilities/v1');
    expect(axRuntimeCapabilitiesToAxIR(extended)).toEqual(axir);
    expect(Object.isFrozen(extended)).toBe(true);
    expect(Object.isFrozen(extended.authority.platform)).toBe(true);
  });

  it('normalizes feature protocol tokens onto the shared protocol path', () => {
    expect(
      axRuntimeProtocolFromToken('ax-program-source-runtime/js-v1')
    ).toEqual({
      name: 'ax-program-source-runtime',
      version: 'js-v1',
    });
  });

  it('normalizes divergent generated and Rust field names explicitly', () => {
    expect(
      axNormalizeAxIRRuntimeCapabilities(
        {
          inspect_globals: true,
          snapshot_globals: false,
          patch_globals: true,
          usage_instructions: 'Rust adapter instructions.',
        },
        { language: 'JavaScript', usageInstructions: '' }
      )
    ).toEqual({
      inspect: true,
      snapshot: false,
      patch: true,
      abort: false,
      language: 'JavaScript',
      usageInstructions: 'Rust adapter instructions.',
    });
  });
});

describe('axSelectCodeRuntime', () => {
  it('preserves blind first-runtime selection when requirements are omitted', () => {
    const legacy = runtime();
    expect(
      axSelectCodeRuntime([legacy, runtime(capabilities())])
    ).toMatchObject({
      runtime: legacy,
      index: 0,
      requirementAware: false,
      rejected: [],
    });
  });

  it('does not read declarations during blind selection', () => {
    const legacy = runtime();
    Object.defineProperty(legacy, 'capabilities', {
      get: () => {
        throw new Error('declaration must not be read');
      },
    });

    expect(axSelectCodeRuntime([legacy]).runtime).toBe(legacy);
  });

  it('fails closed on missing and malformed declarations', () => {
    const malformed = runtime();
    Object.assign(malformed, { capabilities: { inspect: true } });
    const matching = runtime(capabilities({ inspect: true }));
    expect(
      axSelectCodeRuntime([runtime(), malformed, matching], { inspect: true })
    ).toMatchObject({ index: 2 });
  });

  it('rejects unsupported operations and restart without fallback', () => {
    expect(() =>
      axSelectCodeRuntime([runtime(capabilities())], {
        inspect: true,
        snapshot: true,
        abort: true,
        persistence: { restart: true },
      })
    ).toThrow(/requires inspect.*requires snapshot.*requires abort.*restart/s);
  });

  it('rejects declarations whose host aggregate is narrower than platform authority', () => {
    const contradictory = structuredClone(
      capabilities({
        authority: {
          host: 'denied',
          modules: 'denied',
          network: 'denied',
          platform: deniedPlatform,
        },
      })
    );
    contradictory.authority.platform.filesystem = 'unrestricted';

    expect(() =>
      axSelectCodeRuntime([runtime(contradictory)], { patch: true })
    ).toThrow(/missing or malformed capabilities declaration/);
  });

  it('requires a host-minted receipt for authority and resource requirements', () => {
    const candidate = runtime(
      capabilities({
        authority: admissionEvidence().authority,
        resources: admissionEvidence().resources,
      })
    );
    const requirements = {
      resources: { maxTimeoutMs: 100, timeoutEnforcement: 'hard' as const },
      authority: { host: 'denied' as const, network: 'denied' as const },
    };
    expect(() => axSelectCodeRuntime([candidate], requirements)).toThrow(
      /trusted host admission receipt/
    );

    const admission = axCreateRuntimeAdmissionReceipt(
      candidate,
      admissionEvidence()
    );
    expect(
      axSelectCodeRuntime([candidate], requirements, {
        admissions: [admission],
      })
    ).toMatchObject({ index: 0, admission });
  });

  it('does not accept spoofed or mutable declarations as admission evidence', () => {
    const declaration = structuredClone(
      capabilities({
        authority: {
          ...admissionEvidence().authority,
          host: 'unrestricted',
          network: 'unrestricted',
        },
      })
    );
    const candidate = runtime(declaration);
    const admission = axCreateRuntimeAdmissionReceipt(
      candidate,
      admissionEvidence({
        authority: {
          ...admissionEvidence().authority,
          host: 'unrestricted',
          network: 'unrestricted',
        },
      })
    );
    declaration.authority.network = 'denied';
    declaration.authority.host = 'denied';
    const spoof = { ...admission, authority: admissionEvidence().authority };
    const requirements = {
      authority: { host: 'denied' as const, network: 'denied' as const },
    };

    expect(() =>
      axSelectCodeRuntime([candidate], requirements, {
        admissions: [spoof as typeof admission],
      })
    ).toThrow(/trusted host admission receipt/);
    expect(() =>
      axSelectCodeRuntime([candidate], requirements, {
        admissions: [admission],
      })
    ).toThrow(/host authority.*network authority/s);
  });

  it('returns a deeply frozen declaration snapshot', () => {
    const declaration = structuredClone(capabilities({ inspect: true }));
    const selected = axSelectCodeRuntime([runtime(declaration)], {
      inspect: true,
    });
    expect(Object.isFrozen(selected.capabilities)).toBe(true);
    expect(Object.isFrozen(selected.capabilities?.authority.platform)).toBe(
      true
    );
    declaration.inspect = false;
    expect(selected.capabilities?.inspect).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 1.5, 0, -1])(
    'rejects invalid resource requirement %s',
    (value) => {
      expect(() =>
        axSelectCodeRuntime([runtime(capabilities())], {
          resources: { maxTimeoutMs: value },
        })
      ).toThrow(/Invalid runtime capability requirements/);
    }
  );

  it('matches base and feature protocols through one path', () => {
    const candidate = runtime(
      capabilities({
        protocol: {
          name: axCodeRuntimeProtocol,
          version: axCodeRuntimeProtocolVersion,
          features: [
            axRuntimeProtocolFromToken('ax-program-source-runtime/js-v1'),
          ],
        },
      })
    );
    expect(
      axSelectCodeRuntime([candidate], {
        protocol: axRuntimeProtocolFromToken('ax-program-source-runtime/js-v1'),
      }).index
    ).toBe(0);
  });
});

describe('axReportRuntimeCapabilityContradictions', () => {
  it('accepts truthful unsupported capabilities without claiming proof', () => {
    expect(
      axReportRuntimeCapabilityContradictions(capabilities(), observations())
    ).toEqual({
      consistent: true,
      contradictions: [],
      unexpectedCapabilities: [],
      failures: [],
      executableObservations: true,
      isolationProven: false,
    });
  });

  it('reports incorrect claims, overshoot, allowlist, provenance, and unexpected support', () => {
    const report = axReportRuntimeCapabilityContradictions(
      capabilities({
        inspect: true,
        snapshot: true,
        abort: true,
        persistence: { session: true, restart: true },
        resources: {
          timeoutMs: 50,
          timeoutEnforcement: 'hard',
          memoryMb: 32,
        },
        authority: {
          host: 'allowlist',
          modules: 'allowlist',
          network: 'denied',
          platform: { ...deniedPlatform, filesystem: 'allowlist' },
        },
      }),
      observations({
        provenance: { evaluator: '', source: 'synthetic' },
        inspect: false,
        snapshot: false,
        patch: false,
        abort: false,
        persistence: { session: false, restart: false },
        timeout: {
          requestedMs: 40,
          observedMs: 80,
          interrupted: false,
          enforcement: 'cooperative',
        },
        memory: { limitMb: 64, observedPeakMb: 48, terminated: false },
        authority: {
          host: 'unrestricted',
          modules: 'unrestricted',
          network: 'unrestricted',
          platform: {
            ...observedPlatform,
            filesystem: {
              observed: 'unrestricted',
              outsideAllowlistDenied: false,
            },
          },
        },
      })
    );

    expect(report.consistent).toBe(false);
    expect(report.executableObservations).toBe(false);
    expect(report.contradictions).toEqual(
      expect.arrayContaining([
        'inspect was declared but not observed',
        'host authority was broader than declared',
        'filesystem allowlist boundary was not observed',
        'declared timeout bound was not observed',
        'declared timeout enforcement was not observed',
        'declared memory bound was not observed',
      ])
    );
    expect(report.failures).toContain(
      'observation evaluator provenance is missing'
    );
    expect(report.failures).toContain(
      'timeout probe ended before the declared bound'
    );
    expect(report.isolationProven).toBe(false);
  });

  it('reports malformed envelopes, protocol mismatch, cleanup, and undeclared support', () => {
    const report = axReportRuntimeCapabilityContradictions(
      capabilities({ patch: false }),
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
    expect(report.unexpectedCapabilities).toContain(
      'patch was observed but not declared'
    );
    expect(report.contradictions).toContain(
      'declared protocol did not match the observed protocol'
    );
    expect(report.failures).toEqual([
      'malformed protocol envelope was not rejected',
      'protocol mismatch was not rejected',
      'runtime cleanup was not observed',
    ]);
  });

  it('rejects non-finite resource observations as malformed evidence', () => {
    const report = axReportRuntimeCapabilityContradictions(
      capabilities({
        resources: {
          timeoutMs: 50,
          timeoutEnforcement: 'hard',
          memoryMb: 32,
        },
      }),
      observations({
        timeout: {
          requestedMs: Number.NaN,
          observedMs: Number.NaN,
          interrupted: true,
          enforcement: 'hard',
        },
        memory: {
          limitMb: Number.NaN,
          observedPeakMb: Number.NaN,
          terminated: true,
        },
      })
    );

    expect(report.failures).toEqual([
      'timeout observation is malformed',
      'memory observation is malformed',
    ]);
    expect(report.contradictions).toEqual([
      'declared timeout bound was not observed',
      'declared memory bound was not observed',
    ]);
  });
});
