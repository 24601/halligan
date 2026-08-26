import { pathToFileURL } from 'node:url';
import {
  AxFrameSampler,
  type AxFrameSamplerDecision,
  type AxVisualObservation,
} from '../src/ax/ai/visual/index.js';

type Fixture = {
  observation: AxVisualObservation;
  materialChange: boolean;
  sceneCut: boolean;
  staleRevision: boolean;
};

type PolicyMetrics = {
  sampledFrames: number;
  sampledBytes: number;
  sampledTokens: number;
  changeRecall: number;
  changePrecision: number;
  sceneCutRecall: number;
  staleAcceptance: number;
  falseSuppressions: number;
};

const observation = (
  revision: number,
  atMs: number,
  digest: string,
  overrides: Partial<AxVisualObservation> = {}
): AxVisualObservation => ({
  sourceId: 'synthetic-source',
  streamId: 'synthetic-stream',
  frameId: `synthetic-frame-${revision}-${atMs}`,
  revision,
  freshness: {
    capturedAtMs: atMs,
    observedAtMs: atMs,
    expiresAtMs: atMs + 500,
  },
  dimensions: { width: 320, height: 180 },
  mediaType: 'image/webp',
  byteLength: 100,
  tokenEstimate: 25,
  authority: {
    authorityRef: 'synthetic-authority',
    consentRef: 'synthetic-consent',
    revision: 1,
  },
  digest: { algorithm: 'dhash-64', value: digest },
  ...overrides,
});

const fixtures = (): Fixture[] => [
  {
    observation: observation(1, 0, '0000000000000000'),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(2, 100, '0000000000000000'),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(3, 200, '0000000000000000'),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(4, 300, '0101010101010101'),
    materialChange: true,
    sceneCut: false,
    staleRevision: false,
  },
  // Out of order after revision 4.
  {
    observation: observation(3, 400, '0101010101010101'),
    materialChange: false,
    sceneCut: false,
    staleRevision: true,
  },
  // A dropped-frame gap is valid.
  {
    observation: observation(7, 500, '0101010101010101'),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(8, 600, 'f0f0f0f0f0f0f0f0'),
    materialChange: true,
    sceneCut: true,
    staleRevision: false,
  },
  {
    observation: observation(9, 700, 'malformed'),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(10, 800, '0000000000000000', {
      byteLength: 2_000,
    }),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(11, 900, 'f0f0f0f0f0f0f0f0', {
      authority: {
        authorityRef: 'synthetic-authority',
        consentRef: 'synthetic-consent',
        revision: 2,
        revoked: true,
      },
    }),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(12, 1_000, 'f0f0f0f0f0f0f0f0'),
    materialChange: false,
    sceneCut: false,
    staleRevision: false,
  },
  {
    observation: observation(13, 1_100, '0000000000000000', {
      authority: {
        authorityRef: 'replacement-authority',
        consentRef: 'replacement-consent',
        revision: 3,
      },
    }),
    materialChange: true,
    sceneCut: true,
    staleRevision: false,
  },
  {
    observation: observation(14, 1_150, 'ffffffffffffffff', {
      authority: {
        authorityRef: 'replacement-authority',
        consentRef: 'replacement-consent',
        revision: 3,
      },
    }),
    materialChange: true,
    sceneCut: true,
    staleRevision: false,
  },
];

const metrics = (
  set: readonly Fixture[],
  accepted: readonly boolean[]
): PolicyMetrics => {
  const selected = set.filter((_, index) => accepted[index]);
  const material = set.filter((item) => item.materialChange);
  const sceneCuts = set.filter((item) => item.sceneCut);
  const selectedMaterial = set.filter(
    (item, index) => item.materialChange && accepted[index]
  );
  return {
    sampledFrames: selected.length,
    sampledBytes: selected.reduce(
      (total, item) => total + item.observation.byteLength,
      0
    ),
    sampledTokens: selected.reduce(
      (total, item) => total + item.observation.tokenEstimate,
      0
    ),
    changeRecall: material.length
      ? selectedMaterial.length / material.length
      : 1,
    changePrecision: selected.length
      ? selectedMaterial.length / selected.length
      : 1,
    sceneCutRecall: sceneCuts.length
      ? set.filter((item, index) => item.sceneCut && accepted[index]).length /
        sceneCuts.length
      : 1,
    staleAcceptance: set.filter(
      (item, index) => item.staleRevision && accepted[index]
    ).length,
    falseSuppressions: set.filter(
      (item, index) => item.materialChange && !accepted[index]
    ).length,
  };
};

const adaptive = (set: readonly Fixture[]) => {
  const sampler = new AxFrameSampler({
    minIntervalMs: 100,
    maxIntervalMs: 10_000,
    changeThreshold: 0.125,
    sceneCutThreshold: 0.5,
    maxObservationAgeMs: 200,
    maxFutureSkewMs: 10,
    maxObservationBytes: 1_000,
    budget: {
      windowMs: 1_000,
      maxFrames: 3,
      maxBytes: 1_000,
      maxTokens: 250,
    },
  });
  const decisions = set.map((item) => sampler.observe(item.observation));
  const accepted = decisions.map((decision) => decision.action !== 'suppress');
  return {
    decisions,
    metrics: metrics(set, accepted),
  };
};

const baseline = (set: readonly Fixture[], every: number): PolicyMetrics => {
  const accepted = set.map((_, index) => index % every === 0);
  return metrics(set, accepted);
};

const latency = () => {
  const count = 10_000;
  const policy = new AxFrameSampler({
    maxIntervalMs: 1_000_000,
    budget: { windowMs: 1_000_000, maxFrames: count + 1 },
  });
  const durations: number[] = [];
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const item = observation(index + 1, index * 10, '0000000000000000');
    const before = performance.now();
    policy.observe(item);
    durations.push(performance.now() - before);
  }
  const elapsed = performance.now() - started;
  durations.sort((a, b) => a - b);

  const baselineStarted = performance.now();
  let accepted = 0;
  for (let index = 0; index < count; index++) accepted += 1;
  const baselineElapsed = performance.now() - baselineStarted;
  if (accepted !== count) throw new Error('unreachable baseline result');

  return {
    observations: count,
    meanMs: elapsed / count,
    p95Ms: durations[Math.floor(count * 0.95)]!,
    incrementalMeanMs: (elapsed - baselineElapsed) / count,
  };
};

export const runFrameSamplerEvaluation = () => {
  const set = fixtures();
  const policy = adaptive(set);
  const everyFrame = baseline(set, 1);
  const fixedRate = baseline(set, 3);
  const validityReasons = new Set<AxFrameSamplerDecision['reason']>([
    'stale_revision',
    'stale_authority',
    'stale_time',
    'future_time',
    'expired',
    'revoked',
    'oversized',
    'malformed',
    'stream_mismatch',
  ]);
  const avoided = set.filter(
    (_, index) => policy.decisions[index]?.action === 'suppress'
  );
  const invalidAvoided = avoided.filter((_, index) => {
    const originalIndex = set.indexOf(avoided[index]!);
    return validityReasons.has(policy.decisions[originalIndex]!.reason);
  });
  const summarize = (items: readonly Fixture[]) => ({
    frames: items.length,
    bytes: items.reduce(
      (total, item) => total + item.observation.byteLength,
      0
    ),
    tokens: items.reduce(
      (total, item) => total + item.observation.tokenEstimate,
      0
    ),
  });

  const noBenefitSet = Array.from(
    { length: 20 },
    (_, index): Fixture => ({
      observation: observation(index + 1, index * 100, '0000000000000000'),
      materialChange: false,
      sceneCut: false,
      staleRevision: false,
    })
  );
  const noBenefitAdaptive = adaptive(noBenefitSet).metrics;

  return {
    bounds: {
      syntheticFrames: set.length,
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      policy: {
        windowMs: 1_000,
        maxFrames: 3,
        maxBytes: 1_000,
        maxTokens: 250,
        maxObservationBytes: 1_000,
      },
    },
    adaptive: policy.metrics,
    fixedRateEveryThird: fixedRate,
    naiveEveryFrame: everyFrame,
    avoidedVersusEveryFrame: {
      frames: everyFrame.sampledFrames - policy.metrics.sampledFrames,
      bytes: everyFrame.sampledBytes - policy.metrics.sampledBytes,
      tokens: everyFrame.sampledTokens - policy.metrics.sampledTokens,
    },
    avoidedBreakdown: {
      invalidStaleOrUnauthorized: summarize(invalidAvoided),
      redundancyOrBudget: summarize(
        avoided.filter((item) => !invalidAvoided.includes(item))
      ),
    },
    reasons: policy.decisions.map(
      (decision: AxFrameSamplerDecision) => decision.reason
    ),
    noBenefitControl: {
      materialChanges: 0,
      adaptiveFrames: noBenefitAdaptive.sampledFrames,
      fixedRateFrames: baseline(noBenefitSet, 3).sampledFrames,
      everyFrameFrames: baseline(noBenefitSet, 1).sampledFrames,
      qualityClaim: 'none',
    },
    latency: latency(),
    negatives: [
      `${policy.metrics.falseSuppressions} material change suppressed under budget pressure`,
      'The unconditional every-frame baseline includes malformed, oversized, stale, and revoked observations; avoided savings are split by validity versus redundancy/budget suppression',
      'Difference hashes can collide and can miss semantic changes that preserve local luminance ordering',
      'Latency is environment-specific mechanism overhead, not a performance guarantee',
    ],
  };
};

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) console.log(JSON.stringify(runFrameSamplerEvaluation(), null, 2));
