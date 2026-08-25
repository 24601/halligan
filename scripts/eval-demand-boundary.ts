import {
  AxDemandBoundary,
  type AxDemandDetection,
  type AxDemandDisposition,
  type AxDemandObservation,
} from '../src/ax/event/demand.js';

type Fixture = Readonly<{
  id: string;
  demand: boolean;
  explicit: boolean;
  ageMs?: number;
  grant?: 'valid' | 'revoked';
  detection: Readonly<AxDemandDetection>;
}>;

const now = Date.parse('2026-08-25T12:00:00.000Z');
const support = (reference: string, polarity: 'supports' | 'contradicts') => ({
  source: 'synthetic-evaluation',
  reference,
  observedAt: now,
  polarity,
});

function detected(
  confidence: number,
  requestedDisposition: AxDemandDisposition,
  overrides: Partial<AxDemandDetection> = {}
): AxDemandDetection {
  return {
    outcome: 'demand',
    confidence,
    requestedDisposition,
    reasonCode: 'synthetic_rule',
    evidence: [support('support', 'supports')],
    calibration: {
      method: 'temporal-held-out',
      version: 'fixed-v1',
      expectedCalibrationError: 0.1,
      sampleSize: 20,
    },
    ...overrides,
  };
}

const positive: readonly Fixture[] = [
  {
    id: 'explicit-demand',
    demand: true,
    explicit: true,
    detection: detected(0.96, 'notify'),
  },
  {
    id: 'underspecified-demand',
    demand: true,
    explicit: false,
    detection: detected(0.82, 'notify'),
  },
  {
    id: 'proposal-demand',
    demand: true,
    explicit: false,
    detection: detected(0.91, 'propose'),
  },
  {
    id: 'granted-demand',
    demand: true,
    explicit: true,
    grant: 'valid',
    detection: detected(0.99, 'act', { standingGrantRef: 'grant-valid' }),
  },
  {
    id: 'low-confidence-demand',
    demand: true,
    explicit: false,
    detection: detected(0.6, 'notify'),
  },
  {
    id: 'conflicting-demand',
    demand: true,
    explicit: false,
    detection: detected(0.95, 'notify', {
      evidence: [
        support('support', 'supports'),
        support('conflict', 'contradicts'),
      ],
    }),
  },
  {
    id: 'uncertain-demand',
    demand: true,
    explicit: false,
    detection: detected(0.8, 'notify', { outcome: 'uncertain' }),
  },
  {
    id: 'revoked-demand',
    demand: true,
    explicit: false,
    grant: 'revoked',
    detection: detected(0.99, 'act', { standingGrantRef: 'grant-revoked' }),
  },
];

const specialNegative: readonly Fixture[] = [
  {
    id: 'misleading-detector',
    demand: false,
    explicit: false,
    detection: detected(0.93, 'notify'),
  },
  {
    id: 'stale-signal',
    demand: false,
    explicit: false,
    ageMs: 8 * 86_400_000,
    detection: detected(0.95, 'notify'),
  },
  {
    id: 'explicit-no-demand',
    demand: false,
    explicit: false,
    detection: detected(0.97, 'notify', { outcome: 'no_demand' }),
  },
  {
    id: 'conflicting-negative',
    demand: false,
    explicit: false,
    detection: detected(0.89, 'notify', {
      evidence: [
        support('support', 'supports'),
        support('conflict', 'contradicts'),
      ],
    }),
  },
  {
    id: 'harmful-malformed-detector',
    demand: false,
    explicit: false,
    detection: detected(7, 'act'),
  },
  {
    id: 'no-benefit-negative',
    demand: false,
    explicit: false,
    detection: detected(0.1, 'ignore', { outcome: 'no_demand' }),
  },
];

const routineNegative: readonly Fixture[] = Array.from(
  { length: 26 },
  (_, index) => ({
    id: `routine-negative-${index + 1}`,
    demand: false,
    explicit: false,
    detection: detected(0.05 + (index % 5) * 0.08, 'ignore', {
      outcome: index % 3 === 0 ? 'uncertain' : 'no_demand',
    }),
  })
);

export const demandHeldOutFixtures: readonly Fixture[] = [
  ...positive,
  ...specialNegative,
  ...routineNegative,
];

type Counts = Readonly<{
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  falseFire: number;
  falseSuppression: number;
}>;

function counts(predictions: readonly boolean[]): Counts {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const [index, predicted] of predictions.entries()) {
    const actual = demandHeldOutFixtures[index]!.demand;
    if (predicted && actual) tp++;
    else if (predicted) fp++;
    else if (actual) fn++;
    else tn++;
  }
  return {
    tp,
    fp,
    tn,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    falseFire: fp,
    falseSuppression: fn,
  };
}

function demandProbability(fixture: Fixture): number | undefined {
  const { confidence } = fixture.detection;
  if (confidence < 0 || confidence > 1) return undefined;
  return confidence;
}

function calibration(): Readonly<{
  brier: number;
  ece: number;
  examples: number;
}> {
  const valid = demandHeldOutFixtures.flatMap((fixture) => {
    const probability = demandProbability(fixture);
    return probability === undefined
      ? []
      : [{ probability, actual: fixture.demand ? 1 : 0 }];
  });
  const brier =
    valid.reduce(
      (sum, value) => sum + (value.probability - value.actual) ** 2,
      0
    ) / valid.length;
  let weightedError = 0;
  for (let lower = 0; lower < 1; lower += 0.2) {
    const bucket = valid.filter(
      (value) =>
        value.probability >= lower &&
        (lower >= 0.8
          ? value.probability <= 1
          : value.probability < lower + 0.2)
    );
    if (!bucket.length) continue;
    const averageConfidence =
      bucket.reduce((sum, value) => sum + value.probability, 0) / bucket.length;
    const frequency =
      bucket.reduce((sum, value) => sum + value.actual, 0) / bucket.length;
    weightedError +=
      (bucket.length / valid.length) * Math.abs(averageConfidence - frequency);
  }
  return { brier, ece: weightedError, examples: valid.length };
}

export async function runDemandBoundaryEvaluation() {
  const detectorCalls = { value: 0 };
  const byId = new Map(
    demandHeldOutFixtures.map((fixture) => [fixture.id, fixture])
  );
  const boundary = new AxDemandBoundary({
    detector: {
      id: 'deterministic-synthetic-detector',
      version: 'held-out-v1',
      detect: (observation) => {
        detectorCalls.value++;
        return byId.get(observation.id)!.detection;
      },
    },
    now: () => now,
    policy: { maxObservationAgeMs: 7 * 86_400_000 },
    validateStandingGrant: (reference) =>
      reference === 'grant-valid' ? 'valid' : 'revoked',
  });

  const proposals = [];
  for (const fixture of demandHeldOutFixtures) {
    const observation: AxDemandObservation = {
      id: fixture.id,
      source: 'app://synthetic-held-out',
      type: 'synthetic.observation',
      observedAt: now - (fixture.ageMs ?? 0),
      provenance: [support(fixture.id, 'supports')],
    };
    proposals.push((await boundary.observe(observation)).record.proposal);
  }
  const fire = (disposition: AxDemandDisposition) =>
    disposition === 'notify' ||
    disposition === 'propose' ||
    disposition === 'act';
  const records = (await boundary.list({ limit: 100 })).records;
  return {
    split: {
      policyDeclaredBefore: '2026-08-24T00:00:00.000Z',
      heldOutStartsAt: '2026-08-25T00:00:00.000Z',
      reusedForTuning: false,
      examples: demandHeldOutFixtures.length,
      positives: demandHeldOutFixtures.filter((fixture) => fixture.demand)
        .length,
      negatives: demandHeldOutFixtures.filter((fixture) => !fixture.demand)
        .length,
    },
    reactive: counts(demandHeldOutFixtures.map((fixture) => fixture.explicit)),
    naiveThreshold: counts(
      demandHeldOutFixtures.map(
        (fixture) => fixture.detection.confidence >= 0.75
      )
    ),
    boundary: counts(proposals.map((proposal) => fire(proposal.disposition))),
    calibration: calibration(),
    overhead: {
      detectorCalls: detectorCalls.value,
      detectorLatencyMs: records.reduce(
        (sum, record) => sum + record.metrics.detectorLatencyMs,
        0
      ),
      observationBytes: records.reduce(
        (sum, record) => sum + record.metrics.observationBytes,
        0
      ),
      detectionBytes: records.reduce(
        (sum, record) => sum + record.metrics.detectionBytes,
        0
      ),
      retainedRecords: records.length,
      paidCalls: 0,
      externalEffects: 0,
    },
    negativeResults: [
      'The misleading well-formed detector output remains a false fire.',
      'Low-confidence, conflicting, uncertain, and revoked true demand is retained but not fired, reducing recall.',
      'The in-memory store is volatile unless the host snapshots it or supplies a durable AxDemandStore.',
    ],
  } as const;
}

if (process.argv[1]?.endsWith('eval-demand-boundary.ts')) {
  console.log(JSON.stringify(await runDemandBoundaryEvaluation(), null, 2));
}
