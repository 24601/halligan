import type { AxCodeRuntime } from '../rlm.js';
import {
  type AxRuntimeAdmissionReceipt,
  type AxRuntimeCapabilities,
  type AxRuntimeCapabilityObservations,
  type AxRuntimeCapabilityRequirements,
  axCodeRuntimeProtocol,
  axCodeRuntimeProtocolVersion,
  axCreateRuntimeAdmissionReceipt,
  axCreateRuntimeCapabilities,
  axReportRuntimeCapabilityContradictions,
  axRuntimeCapabilitiesVersion,
  axSelectCodeRuntime,
} from '../runtimeCapabilities.js';

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

const baseCapabilities: AxRuntimeCapabilities = axCreateRuntimeCapabilities({
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
});

type DeclaredRuntime = AxCodeRuntime & {
  id: string;
  capabilities: AxRuntimeCapabilities;
};

const runtime = (
  capabilities: AxRuntimeCapabilities,
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

const boundedCapabilities = axCreateRuntimeCapabilities({
  ...baseCapabilities,
  inspect: true,
  snapshot: true,
  abort: true,
  persistence: { session: true, restart: true },
  resources: { timeoutMs: 100, timeoutEnforcement: 'hard', memoryMb: 64 },
  authority: {
    host: 'denied',
    modules: 'denied',
    network: 'denied',
    platform: deniedPlatform,
  },
});
const bounded = runtime(boundedCapabilities, 'bounded');
const legacy = runtime(baseCapabilities, 'legacy');
const protocolV2 = runtime(
  axCreateRuntimeCapabilities({
    ...boundedCapabilities,
    protocol: { name: axCodeRuntimeProtocol, version: '2', features: [] },
  }),
  'protocol-v2'
);

const boundedAdmission = axCreateRuntimeAdmissionReceipt(bounded, {
  evaluator: 'fixed host-policy fixture',
  source: 'host-policy',
  resources: boundedCapabilities.resources,
  authority: boundedCapabilities.authority,
});

const tasks: readonly Readonly<{
  name: string;
  candidates: readonly DeclaredRuntime[];
  requirements: AxRuntimeCapabilityRequirements;
  expected: string;
  admissions?: readonly AxRuntimeAdmissionReceipt[];
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
    admissions: [boundedAdmission],
    expected: 'bounded',
  },
  {
    name: 'authority',
    candidates: [legacy, bounded],
    requirements: {
      authority: { host: 'denied', modules: 'denied', network: 'denied' },
    },
    admissions: [boundedAdmission],
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
  const aware = axSelectCodeRuntime(task.candidates, task.requirements, {
    admissions: task.admissions,
  });
  if (blind.id === task.expected) blindCorrect++;
  if ((aware.runtime as DeclaredRuntime).id === task.expected) awareCorrect++;
  rejections += aware.rejected.length;
}

const observedPlatform = Object.fromEntries(
  Object.keys(deniedPlatform).map((key) => [key, { observed: 'denied' }])
) as AxRuntimeCapabilityObservations['authority']['platform'];
const incorrectObservations: AxRuntimeCapabilityObservations = {
  provenance: { evaluator: 'fixed contradiction fixture', source: 'synthetic' },
  language: 'JavaScript',
  platform: 'node',
  inspect: false,
  snapshot: false,
  patch: true,
  abort: false,
  persistence: { session: true, restart: false },
  timeout: {
    requestedMs: 100,
    observedMs: 140,
    interrupted: false,
    enforcement: 'cooperative',
  },
  memory: { limitMb: 128, observedPeakMb: 80, terminated: false },
  authority: {
    host: 'unrestricted',
    modules: 'unrestricted',
    network: 'unrestricted',
    platform: observedPlatform,
  },
  protocol: {
    name: axCodeRuntimeProtocol,
    version: axCodeRuntimeProtocolVersion,
    malformedEnvelopeRejected: true,
    mismatchRejected: true,
  },
  cleanup: true,
};
const contradictionReport = axReportRuntimeCapabilityContradictions(
  bounded.capabilities,
  incorrectObservations
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
      contradictions: contradictionReport.contradictions.length,
      overhead: {
        declarationBytes: JSON.stringify(bounded.capabilities).length,
        admissionBytes: JSON.stringify({
          evaluator: boundedAdmission.evaluator,
          source: boundedAdmission.source,
          authority: boundedAdmission.authority,
          resources: boundedAdmission.resources,
        }).length,
        requirementChecks: tasks.length,
        runtimeExecutions: 0,
      },
      executableObservations: contradictionReport.executableObservations,
      isolationProven: contradictionReport.isolationProven,
      scope:
        'Deterministic selector/contradiction mechanics only; declarations and receipts cannot prove isolation.',
    },
    null,
    2
  )
);
