import type { AxCodeRuntime } from '../rlm.js';
import {
  type AxRuntimeCapabilityRequirements,
  type AxRuntimeConformanceObservations,
  axCodeRuntimeProtocol,
  axCodeRuntimeProtocolVersion,
  axEvaluateRuntimeConformance,
  axSelectCodeRuntime,
  type RuntimeCapabilities,
} from '../runtimeCapabilities.js';

const baseCapabilities: RuntimeCapabilities = {
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
};

type DeclaredRuntime = AxCodeRuntime & {
  id: string;
  capabilities: RuntimeCapabilities;
};

const runtime = (
  capabilities: RuntimeCapabilities,
  id: string
): DeclaredRuntime => ({
  id,
  capabilities,
  language: capabilities.language,
  getUsageInstructions: () => '',
  createSession: () => ({
    execute: async () => undefined,
    patchGlobals: async () => {},
    close: () => {},
  }),
});

const bounded = runtime(
  {
    ...baseCapabilities,
    inspect: true,
    snapshot: true,
    abort: true,
    persistence: { session: true, restart: true },
    resources: {
      timeoutMs: 100,
      timeoutEnforcement: 'hard',
      memoryMb: 64,
    },
    authority: { host: 'denied', modules: 'denied', network: 'denied' },
  },
  'bounded'
);
const legacy = runtime(baseCapabilities, 'legacy');
const protocolV2 = runtime(
  {
    ...bounded.capabilities,
    protocol: { name: axCodeRuntimeProtocol, version: '2' },
  },
  'protocol-v2'
);

const tasks: readonly Readonly<{
  name: string;
  candidates: readonly DeclaredRuntime[];
  requirements: AxRuntimeCapabilityRequirements;
  expected: string;
}>[] = [
  {
    name: 'inspect',
    candidates: [legacy, bounded],
    requirements: { inspect: true },
    expected: 'bounded',
  },
  {
    name: 'snapshot',
    candidates: [legacy, bounded],
    requirements: { snapshot: true },
    expected: 'bounded',
  },
  {
    name: 'abort',
    candidates: [legacy, bounded],
    requirements: { abort: true },
    expected: 'bounded',
  },
  {
    name: 'restart',
    candidates: [legacy, bounded],
    requirements: { persistence: { restart: true } },
    expected: 'bounded',
  },
  {
    name: 'resources',
    candidates: [legacy, bounded],
    requirements: {
      resources: {
        maxTimeoutMs: 100,
        timeoutEnforcement: 'hard',
        maxMemoryMb: 64,
      },
    },
    expected: 'bounded',
  },
  {
    name: 'authority',
    candidates: [legacy, bounded],
    requirements: {
      authority: { host: 'denied', modules: 'denied', network: 'denied' },
    },
    expected: 'bounded',
  },
  {
    name: 'protocol',
    candidates: [protocolV2, bounded],
    requirements: {
      protocol: {
        name: axCodeRuntimeProtocol,
        version: axCodeRuntimeProtocolVersion,
      },
    },
    expected: 'bounded',
  },
  {
    name: 'fallback-control',
    candidates: [bounded, legacy],
    requirements: { patch: true },
    expected: 'bounded',
  },
];

let blindCorrect = 0;
let awareCorrect = 0;
let rejections = 0;
for (const task of tasks) {
  const blind = axSelectCodeRuntime(task.candidates).runtime as DeclaredRuntime;
  const aware = axSelectCodeRuntime(task.candidates, task.requirements);
  if (blind.id === task.expected) blindCorrect++;
  if ((aware.runtime as DeclaredRuntime).id === task.expected) {
    awareCorrect++;
  }
  rejections += aware.rejected.length;
}

const incorrectDeclarationObservations: AxRuntimeConformanceObservations = {
  language: 'JavaScript',
  inspect: false,
  snapshot: false,
  patch: true,
  abort: false,
  persistence: { session: true, restart: false },
  timeout: { requestedMs: 100, observedMs: 140, interrupted: false },
  authority: { hostDenied: false, modulesDenied: false, networkDenied: false },
  protocol: {
    name: axCodeRuntimeProtocol,
    version: axCodeRuntimeProtocolVersion,
    malformedEnvelopeRejected: true,
    mismatchRejected: true,
  },
  cleanup: true,
};
const falseConfidence = axEvaluateRuntimeConformance(
  bounded.capabilities,
  incorrectDeclarationObservations
);

console.log(
  JSON.stringify(
    {
      fixedTasks: tasks.length,
      blind: { correctSelection: blindCorrect, rejected: 0 },
      requirementAware: {
        correctSelection: awareCorrect,
        rejected: rejections,
      },
      falseConfidence: falseConfidence.falseConfidence.length,
      overhead: {
        declarationBytes: JSON.stringify(bounded.capabilities).length,
        requirementChecks: tasks.length,
        runtimeExecutions: 0,
      },
      isolationProven: falseConfidence.isolationProven,
      scope:
        'Deterministic selector/conformance mechanics only; declarations cannot prove isolation.',
    },
    null,
    2
  )
);
