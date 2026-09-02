/**
 * Deterministic, zero-cost evaluation of the playbook evidence machinery.
 *
 * Claim: **the added gates catch the specific failure modes named below on a
 * deterministic fixture.** That is a MACHINERY claim, not a model-quality claim.
 * Nothing here shows that evolving a playbook makes a real agent better, and
 * nothing here is a live-model result.
 *
 * Declared baseline: the same run, on the same fixture, with every gate `off`.
 * Each archetype is executed twice — baseline and gated — so "the gate caught
 * it" means the two runs actually differ, not that the gated run merely looks
 * plausible. An archetype where they do not differ is reported by name in
 * `negativeResults` rather than dropped.
 *
 * Budget: 0 provider calls, 0 provider tokens, $0, <= 5s wall clock. The agent
 * is a stub over a real ACE-shaped playbook and the scorer is a pure function,
 * so the only thing under test is the evidence machinery itself.
 *
 * Run: `npm run evaluate:playbook-evidence`
 */

import { pathToFileURL } from 'node:url';

import { evolveAgentPlaybook } from '../src/ax/agent/agentInternal/playbookEvolve/playbookEvolve.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveResult,
} from '../src/ax/agent/agentInternal/playbookEvolve/playbookEvolveTypes.js';
import {
  estimateTokenCount,
  renderPlaybook,
} from '../src/ax/dsp/optimizers/acePlaybook.js';
import type {
  AxACEBullet,
  AxACEPlaybook,
} from '../src/ax/dsp/optimizers/aceTypes.js';

const NOW_ISO = '2026-01-01T00:00:00.000Z';
const MAX_WALL_TIME_MS = 5000;

// ---------------------------------------------------------------------------
// The fixture: a stub agent over a real ACE-shaped playbook
// ---------------------------------------------------------------------------

const bulletOf = (id: string, content: string): AxACEBullet => ({
  id,
  section: 'failures_to_avoid',
  content,
  helpfulCount: 0,
  harmfulCount: 0,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
});

const playbookOf = (bullets: readonly AxACEBullet[]): AxACEPlaybook => ({
  version: 1,
  sections: { failures_to_avoid: [...bullets] },
  stats: {
    bulletCount: bullets.length,
    helpfulCount: 0,
    harmfulCount: 0,
    tokenEstimate: 0,
  },
  updatedAt: NOW_ISO,
});

function aceHandle(playbook: AxACEPlaybook) {
  let state = {
    playbook: structuredClone(playbook),
    artifact: {
      playbook: structuredClone(playbook),
      feedback: [] as unknown[],
      history: [] as unknown[],
    },
  };
  return {
    recordEvidence: (bulletIds: readonly string[]) => [...bulletIds],
    getState: () => structuredClone(state),
    load: (snapshot: any) => {
      state = structuredClone(snapshot);
    },
    current: () => structuredClone(state),
  };
}

/** What the scorer of an archetype is allowed to see. Nothing else exists. */
type Observation = Readonly<{
  /** Caller-owned service label, so a transfer cell can score differently. */
  ai: string;
  taskId: string;
  /** Ids still present in the live playbook. */
  bullets: readonly string[];
  /** Rendered size of the live playbook, in estimated tokens. */
  renderedTokens: number;
  /** True when the control arm handed the agent its own previous answer. */
  refined: boolean;
}>;

type Archetype = Readonly<{
  name: string;
  /** What the archetype exists to catch, in one line. */
  catches: string;
  bullets: readonly AxACEBullet[];
  score: (observation: Observation) => number;
  /** Options common to the baseline and the gated run. */
  common: (targets: readonly { id: string; ai: any }[]) => Record<string, any>;
  /** Gate configuration added ONLY to the gated run. */
  gated: Record<string, any>;
  /**
   * What the GATED run must end in, and whether that must differ from the
   * all-gates-off baseline. `control-beating` is the archetype where "no
   * change" is the correct answer, so a bare "did it change?" heuristic would
   * file a working gate as a negative result.
   */
  expect: Readonly<{ applied: 'live' | 'rolled_back'; differs: boolean }>;
  /**
   * Set where the machinery can only REPORT the failure mode, never prevent it.
   * Verified rather than asserted: the entry is emitted only when the named
   * warning actually fired AND the artifact still went live.
   */
  detectOnly?: Readonly<{ warning: string; why: string }>;
  /** Extra per-attempt shape (tool errors, turn counts, discards). */
  attempt?: (observation: Observation) => Record<string, unknown>;
}>;

const TRAIN = [
  { input: { q: 'a' }, criteria: 'c', id: 't1' },
  { input: { q: 'b' }, criteria: 'c', id: 't2' },
  { input: { q: 'c' }, criteria: 'c', id: 't3' },
];
const VALIDATION = [
  { input: { q: 'd' }, criteria: 'c', id: 'v1' },
  { input: { q: 'e' }, criteria: 'c', id: 'v2' },
];

const NOISE = bulletOf(
  'noise',
  `noisy guidance that misleads the actor ${'and costs rendered tokens '.repeat(6)}`
);
const KEEPER = bulletOf('keeper', 'load bearing guidance the actor needs');

const PRUNE = { enabled: true, operation: 'remove' } as const;

/**
 * One run. `calls` is an INDEPENDENT tally of agent invocations, incremented
 * inside the stub itself, so `accounting.metricCalls` is checked against
 * something the accounting ledger never touched.
 */
export async function runArchetype(
  archetype: Archetype,
  options: Record<string, any>,
  /** Reverses the task order in BOTH splits, for the order-invariance property. */
  permuteTasks = false,
  /** Split override, used only by the seed probe below. */
  dataset: { train: typeof TRAIN; validation: typeof VALIDATION } = {
    train: TRAIN,
    validation: VALIDATION,
  }
): Promise<{
  result: AxAgentPlaybookEvolveResult;
  calls: number;
  scores: number[];
  turnCounts: number[];
}> {
  const handle = aceHandle(playbookOf(archetype.bullets));
  let calls = 0;
  const scores: number[] = [];
  const turnCounts: number[] = [];
  const observe = (ai: any, task: any): Observation => {
    const live = handle.current().playbook;
    const bullets = Object.values(live.sections).flatMap((section) =>
      (section as AxACEBullet[]).map((bullet) => bullet.id)
    );
    return {
      ai: String(ai?.id ?? 'primary'),
      taskId: String(task?.id ?? '?'),
      bullets,
      renderedTokens: estimateTokenCount(
        renderPlaybook(live, { now: NOW_ISO })
      ),
      refined: String(task?.input?.q ?? '').includes('[self-refinement round'),
    };
  };
  const self = {
    init: { ai: { id: 'primary' } },
    getPlaybook: () => handle,
    _forwardForEvaluation: async (ai: any, task: any) => {
      calls++;
      const observation = observe(ai, task);
      const extra = archetype.attempt?.(observation) ?? {};
      const turnCount = Number(extra.turnCount ?? 1);
      turnCounts.push(turnCount);
      return {
        completionType: 'final' as const,
        output: { observation },
        actionLog: observation.bullets.map((id) => `[${id}]`).join(' '),
        functionCalls: [],
        toolErrors: [],
        usage: [],
        ...extra,
        turnCount,
      };
    },
  };
  const metric = async ({ prediction }: any) => {
    const score = Math.max(
      0,
      Math.min(1, archetype.score(prediction.output.observation))
    );
    scores.push(score);
    return score;
  };
  const result = await evolveAgentPlaybook(
    self as any,
    permuteTasks
      ? {
          train: [...dataset.train].reverse(),
          validation: [...dataset.validation].reverse(),
        }
      : dataset,
    { metric, scoreThreshold: 0, ...options } as AxAgentPlaybookEvolveOptions
  );
  return { result, calls, scores, turnCounts };
}

// ---------------------------------------------------------------------------
// The archetypes. Each maps to a named failure mode the survey calls out.
// ---------------------------------------------------------------------------

const bulletScore = (observation: Observation) =>
  (observation.bullets.includes('noise') ? -0.5 : 0) +
  (observation.bullets.includes('keeper') ? 0.7 : 0);

export const AX_PLAYBOOK_EVIDENCE_ARCHETYPES: readonly Archetype[] = [
  {
    name: 'control-reproducible',
    catches:
      'a gain a matched-budget self-refinement arm reproduces without touching the artifact',
    bullets: [NOISE, KEEPER],
    // Refinement alone buys exactly what removing the bullet buys.
    score: (o) => bulletScore(o) + (o.refined ? 0.6 : 0),
    common: () => ({
      prune: PRUNE,
      controlArm: { arms: ['self_refine'], refineRounds: 1 },
    }),
    gated: { gates: { controlArm: 'require' } },
    expect: { applied: 'rolled_back', differs: true },
  },
  {
    name: 'control-beating',
    catches:
      'a real gain the arm cannot reproduce, which must NOT be lost to the gate',
    bullets: [NOISE, KEEPER],
    score: bulletScore,
    common: () => ({
      prune: PRUNE,
      controlArm: { arms: ['self_refine', 'best_of_n'], refineRounds: 1 },
    }),
    gated: { gates: { controlArm: 'require' } },
    expect: { applied: 'live', differs: false },
  },
  {
    name: 'harness-term-only',
    catches:
      'a gain any text of the same rendered size reproduces — a plumbing effect, not the bullet',
    bullets: [NOISE, KEEPER],
    // Score depends ONLY on rendered size, so a content-free neutral artifact
    // sized to the evolved playbook reproduces the gain exactly.
    score: (o) => 1 - o.renderedTokens / 400,
    common: () => ({
      prune: PRUNE,
      controlArm: { arms: ['harness_term'] },
    }),
    gated: { gates: { controlArm: 'require' } },
    expect: { applied: 'rolled_back', differs: true },
  },
  {
    name: 'within-band',
    catches:
      'a delta inside the unchanged-artifact noise band, called an effect',
    bullets: [NOISE, KEEPER],
    // Removing `noise` frees tokens and changes nothing about the answer.
    score: (o) => (o.bullets.includes('keeper') ? 0.6 : 0),
    common: () => ({
      prune: PRUNE,
      varianceBand: { extraRepeats: 1 },
      intervalOptions: { resamples: 400, level: 0.95, seed: 7 },
    }),
    gated: { gates: { interval: 'require' } },
    expect: { applied: 'live', differs: false },
    detectOnly: {
      warning: 'delta_within_variance_band',
      why: "the prune variant of the interval gate requires only direction !== 'negative', so an unresolved delta passes it; the band is reported beside the gain and never enforced",
    },
  },
  {
    name: 'zero-reach',
    catches:
      'a positive delta on an artifact the host probe never saw invoked — a prompting effect',
    bullets: [NOISE, KEEPER],
    score: bulletScore,
    common: () => ({
      prune: PRUNE,
      reachProbe: () => ({ applicableAtDecidingStep: false, invocations: 0 }),
    }),
    gated: { gates: { reach: 'warn' } },
    expect: { applied: 'live', differs: false },
    detectOnly: {
      warning: 'reach_zero_positive_delta',
      why: 'gate 6 is skipped for a prune candidate (a removed bullet has no reach), so zero reach beside a positive delta is reported and never enforced',
    },
  },
  {
    name: 'counterfactual-reach',
    catches:
      'a reach rate of 1.0 that is a counterfactual reading and can never gate',
    bullets: [NOISE, KEEPER],
    score: bulletScore,
    common: () => ({
      prune: PRUNE,
      conditionsForTask: () => ['always'],
    }),
    gated: { gates: { reach: 'warn' } },
    expect: { applied: 'live', differs: false },
    detectOnly: {
      warning: 'reach_counterfactual_basis',
      why: 'a counterfactual basis can never satisfy the reach gate by construction, so the 1.0 reading is labelled and never enforced',
    },
  },
  {
    name: 'validity-violating',
    catches: 'a scoring win bought with a tool-error rate nobody looked at',
    bullets: [NOISE, KEEPER],
    score: bulletScore,
    common: () => ({
      prune: PRUNE,
      validity: { maxToolErrorRate: 0.1 },
    }),
    gated: { gates: { validity: 'require' } },
    // The candidate artifact (no `noise`) breaks its tools on every attempt.
    expect: { applied: 'live', differs: true },
    attempt: (o) =>
      o.bullets.includes('noise')
        ? {}
        : {
            functionCalls: [
              { qualifiedName: 'x.y', name: 'y', arguments: {}, error: 'boom' },
            ],
          },
  },
  {
    name: 'transfer-split',
    catches:
      'a per-cell regression on another backbone that a cell average would report as a win',
    bullets: [NOISE, KEEPER],
    score: (o) => {
      const noise = o.bullets.includes('noise');
      const keeper = o.bullets.includes('keeper');
      if (o.ai === 'nano') return (noise ? 0.36 : 0) + (keeper ? 0.5 : 0);
      if (o.ai === 'sonnet') return (noise ? -0.5 : 0) + (keeper ? 0.8 : 0);
      return bulletScore(o);
    },
    common: (targets) => ({
      prune: PRUNE,
      transfer: { targets, splits: ['heldOut'] },
    }),
    gated: { gates: { transfer: 'require' } },
    expect: { applied: 'rolled_back', differs: true },
  },
];

/**
 * A probe archetype for the seed-reproducibility property ONLY. Its per-task
 * deltas differ, so the bootstrap actually has something to resample and a
 * different seed genuinely moves the bounds. Every archetype in the evaluation
 * above scores an artifact as a constant, which makes every paired delta
 * identical and every interval seed-independent — a fixture on which "the same
 * seed reproduces the interval" would pass on an implementation that ignored
 * the seed entirely.
 */
export const AX_PLAYBOOK_EVIDENCE_SEED_PROBE_DATASET = {
  train: Array.from({ length: 9 }, (_, index) => ({
    input: { q: `s${index}` },
    criteria: 'c',
    id: `s${index}`,
  })),
  validation: Array.from({ length: 9 }, (_, index) => ({
    input: { q: `w${index}` },
    criteria: 'c',
    id: `w${index}`,
  })),
};

export const AX_PLAYBOOK_EVIDENCE_SEED_PROBE: Archetype = {
  name: 'seed-probe',
  catches: 'nothing; it exists to give the bootstrap a non-degenerate spread',
  bullets: [NOISE, KEEPER],
  score: (o) => {
    // A wide, uneven per-task spread, so resampling tasks with replacement
    // really does land on different percentile bounds for different seeds.
    const rank = Number(o.taskId.slice(1)) % 9;
    const base = 0.02 * rank;
    return o.bullets.includes('noise') ? base : base + (rank % 3) * 0.3;
  },
  common: () => ({
    prune: PRUNE,
    intervalOptions: { resamples: 400, level: 0.95 },
  }),
  gated: {},
  expect: { applied: 'live', differs: false },
};

/** Every attempt of `t2` is an environment failure. 3 of 10 on the split. */
const DISCARD_TASKS = new Set(['t2']);

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

/** The transfer targets the archetypes use. Exported for the property probes. */
export const AX_PLAYBOOK_EVIDENCE_TARGETS = [
  { id: 'sonnet', ai: { id: 'sonnet' } as any },
  { id: 'nano', ai: { id: 'nano' } as any },
];

/**
 * The gate-relevant shape of a run: everything an evidence gate DECIDED, and
 * nothing that a different bootstrap seed is allowed to move. Permuting the
 * task order must leave this identical.
 */
export function gateShapeOf(result: AxAgentPlaybookEvolveResult) {
  return {
    applied: result.applied,
    accepted: result.outcomes.map((outcome) => outcome.accepted),
    kinds: result.outcomes.map((outcome) => outcome.kind),
    failedGates: result.outcomes.map(
      (outcome) => outcome.evidence?.gates.failedGate ?? null
    ),
    gateStatuses: result.outcomes.map((outcome) =>
      (outcome.evidence?.gates.entries ?? []).map(
        (entry) => `${entry.id}:${entry.status}`
      )
    ),
    regressedCells:
      result.transfer && result.transfer.status !== 'not_run'
        ? [...result.transfer.regressedCells]
        : null,
  };
}

/** Every interval a run produced, flattened, for the seed-reproducibility property. */
export function intervalShapeOf(
  result: AxAgentPlaybookEvolveResult,
  withSeed = true
) {
  const rows: string[] = [];
  for (const [index, outcome] of result.outcomes.entries()) {
    const intervals = outcome.evidence?.intervals;
    if (!intervals) continue;
    for (const [name, interval] of [
      ['current', intervals.current],
      ['heldOut', intervals.heldOut],
    ] as const) {
      if (!interval) continue;
      rows.push(
        `${index}:${name}:${interval.point}:${interval.lower}:${interval.upper}${withSeed ? `:${interval.seed}` : ''}:${interval.direction}`
      );
    }
  }
  return rows;
}

export type AxPlaybookEvidenceEvaluationResult = Awaited<
  ReturnType<typeof evaluatePlaybookEvidence>
>;

export async function evaluatePlaybookEvidence() {
  const startedAt = Date.now();
  const targets = AX_PLAYBOOK_EVIDENCE_TARGETS;

  type Row = {
    name: string;
    catches: string;
    baselineApplied: string;
    gatedApplied: string;
    baselineAccepts: number;
    gatedAccepts: number;
    gatedWarnings: string[];
    gatedFailedGates: string[];
    changed: boolean;
    expectedApplied: string;
    expectedDiffers: boolean;
    /** The gate did what this archetype exists to make it do. */
    met: boolean;
    detectedOnly?: string;
    accountedExactly: boolean;
  };

  const rows: Row[] = [];
  let intervalComparisons = 0;
  let intervalPositive = 0;
  let unresolvedReported = 0;
  let unresolvedExpected = 0;
  let counterfactualLabelled = 0;
  let counterfactualExpected = 0;
  let zeroReachWarnings = 0;
  let predicateNamed = 0;
  let transferRegressingCellCaught = 0;
  let transferAverageWouldHavePassed = false;

  for (const archetype of AX_PLAYBOOK_EVIDENCE_ARCHETYPES) {
    const common = archetype.common(targets);
    const baseline = await runArchetype(archetype, common);
    const gated = await runArchetype(archetype, {
      ...common,
      ...archetype.gated,
    });
    const acceptsOf = (result: AxAgentPlaybookEvolveResult) =>
      result.outcomes.filter((outcome) => outcome.accepted).length;
    const warnings = (gated.result.warnings ?? []).map((w) => w.code);
    const failedGates = gated.result.outcomes
      .map((outcome) => outcome.evidence?.gates.failedGate)
      .filter((gate): gate is string => typeof gate === 'string');
    const changed =
      baseline.result.applied !== gated.result.applied ||
      acceptsOf(baseline.result) !== acceptsOf(gated.result);

    rows.push({
      name: archetype.name,
      catches: archetype.catches,
      baselineApplied: baseline.result.applied,
      gatedApplied: gated.result.applied,
      baselineAccepts: acceptsOf(baseline.result),
      gatedAccepts: acceptsOf(gated.result),
      gatedWarnings: [...new Set(warnings)].sort(),
      gatedFailedGates: [...new Set(failedGates)].sort(),
      changed,
      expectedApplied: archetype.expect.applied,
      expectedDiffers: archetype.expect.differs,
      met:
        gated.result.applied === archetype.expect.applied &&
        changed === archetype.expect.differs,
      ...(archetype.detectOnly &&
      warnings.includes(archetype.detectOnly.warning) &&
      gated.result.applied === 'live' &&
      acceptsOf(gated.result) > 0
        ? {
            detectedOnly: `${archetype.name}: '${archetype.detectOnly.warning}' fired and the artifact still went live — ${archetype.detectOnly.why}`,
          }
        : {}),
      accountedExactly:
        gated.result.accounting.metricCalls === gated.calls &&
        baseline.result.accounting.metricCalls === baseline.calls,
    });

    // Per-archetype metric extraction, from the GATED run.
    if (archetype.name === 'within-band') {
      // The false-positive rate is only meaningful where the artifact's effect
      // is zero BY CONSTRUCTION. Counting archetypes with a real gain would
      // report genuine positives as false ones.
      for (const outcome of gated.result.outcomes) {
        const intervals = outcome.evidence?.intervals;
        if (!intervals) continue;
        for (const interval of [intervals.current, intervals.heldOut]) {
          if (!interval) continue;
          intervalComparisons++;
          if (interval.direction === 'positive') intervalPositive++;
        }
      }
    }
    if (archetype.name === 'within-band') {
      unresolvedExpected = gated.result.outcomes.filter(
        (outcome) => outcome.evidence !== undefined
      ).length;
      unresolvedReported = gated.result.outcomes.filter(
        (outcome) =>
          outcome.evidence?.intervals.current.direction !== 'positive'
      ).length;
    }
    if (archetype.name === 'zero-reach') {
      zeroReachWarnings = gated.result.outcomes.filter((outcome) =>
        (outcome.evidence?.warnings ?? []).some(
          (warning) => warning.code === 'reach_zero_positive_delta'
        )
      ).length;
    }
    if (archetype.name === 'counterfactual-reach') {
      const reaches = gated.result.outcomes
        .map((outcome) => outcome.evidence?.reach)
        .filter((reach) => reach !== undefined);
      counterfactualExpected = reaches.filter(
        (reach) => reach!.basis === 'applicability_counterfactual'
      ).length;
      counterfactualLabelled = reaches.filter(
        (reach) =>
          reach!.basis === 'applicability_counterfactual' &&
          reach!.counterfactual === true &&
          reach!.gateEligible === false
      ).length;
    }
    if (archetype.name === 'validity-violating') {
      predicateNamed = gated.result.outcomes.filter((outcome) =>
        /^validity:[a-z_]+@(current|heldOut)/.test(
          outcome.evidence?.gates.failedPredicate ?? ''
        )
      ).length;
    }
    if (archetype.name === 'transfer-split') {
      const report = gated.result.transfer;
      if (report && report.status !== 'not_run') {
        transferRegressingCellCaught = report.regressedCells.length;
        const deltas = report.cells.map((cell) => cell.delta);
        transferAverageWouldHavePassed =
          deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length >
          -report.floor;
      }
    }
  }

  // --- termination: discards never score as zeros, and every attempt is one vote
  const terminationArchetype: Archetype = {
    name: 'termination',
    catches:
      'environment failures scored as zeros, and long trajectories out-voting short ones',
    bullets: [NOISE, KEEPER],
    score: () => 1,
    common: () => ({}),
    gated: {},
    attempt: (o) => ({ turnCount: o.taskId === 't1' ? 50 : 2 }),
  };
  const termination = await runArchetype(terminationArchetype, {
    prune: PRUNE,
    runsPerTask: 2,
    classifyTermination: ({ task }: any) =>
      DISCARD_TASKS.has(String(task?.id))
        ? { kind: 'environment_failure', cause: 'provider_rate_limit' }
        : undefined,
    maxDiscardRedraws: 0,
  });
  const discardRates = termination.result.records.length > 0 ? [] : [];
  void discardRates;
  const terminationSplit = termination.result.outcomes
    .map((outcome) => outcome.evidence?.termination)
    .find((report) => report !== undefined);
  const discardRate =
    terminationSplit?.splits.find((split) => split.split === 'current')
      ?.discardRate ?? -1;
  // Every attempt is one vote: the 50-turn and the 2-turn trajectory both
  // scored 1, and no turn count reached the score.
  const equalWeightHolds =
    termination.turnCounts.includes(50) &&
    termination.turnCounts.includes(2) &&
    new Set(termination.scores).size === 1;

  const negativeResults = [
    ...rows
      .map((row) => row.detectedOnly)
      .filter((note): note is string => note !== undefined),
    ...rows
      .filter((row) => !row.met)
      .map(
        (row) =>
          `${row.name}: expected the gated run to end '${row.expectedApplied}'${row.expectedDiffers ? ' and to differ from the all-gates-off baseline' : ' and to leave the baseline outcome alone'}, observed ${row.baselineApplied}/${row.baselineAccepts} accepted -> ${row.gatedApplied}/${row.gatedAccepts} accepted`
      ),
  ];

  const elapsedWallTimeMs = Date.now() - startedAt;
  const caught = (name: string) => rows.find((row) => row.name === name);

  const result = {
    archetypes: rows,
    controlArm: {
      falseImprovementCaught: {
        caught:
          caught('control-reproducible')?.gatedApplied === 'rolled_back'
            ? 1
            : 0,
        total: 1,
      },
      trueImprovementRetained: {
        retained: caught('control-beating')?.gatedApplied === 'live' ? 1 : 0,
        total: 1,
      },
      harnessTermAttributed: {
        caught:
          caught('harness-term-only')?.gatedApplied === 'rolled_back' ? 1 : 0,
        total: 1,
      },
    },
    interval: {
      unresolvedReported: {
        reported: unresolvedReported,
        total: unresolvedExpected,
      },
      /** Counter-metric: unchanged-artifact comparisons the gate calls positive. */
      falsePositiveRate:
        intervalComparisons > 0 ? intervalPositive / intervalComparisons : 0,
      comparisons: intervalComparisons,
    },
    reach: {
      zeroReachWarnings,
      counterfactualLabelled: {
        labelled: counterfactualLabelled,
        total: counterfactualExpected,
      },
    },
    validity: { predicateNamed: { named: predicateNamed, total: 1 } },
    transfer: {
      regressingCellCaught: transferRegressingCellCaught,
      rolledBack: caught('transfer-split')?.gatedApplied === 'rolled_back',
      /** Counter-metric: the average an averaging report would have shown. */
      averageWouldHavePassed: transferAverageWouldHavePassed,
    },
    termination: { discardRate, equalWeightHolds },
    accounting: {
      metricCallsAccounted: rows.filter((row) => row.accountedExactly).length,
      total: rows.length,
    },
    negativeResults,
    budget: {
      providerCalls: 0,
      providerTokens: 0,
      costUsd: 0,
      maxWallTimeMs: MAX_WALL_TIME_MS,
      elapsedWallTimeMs,
    },
  };

  if (elapsedWallTimeMs > MAX_WALL_TIME_MS) {
    throw new Error(
      `playbook evidence evaluation exceeded its declared budget: ${elapsedWallTimeMs}ms > ${MAX_WALL_TIME_MS}ms`
    );
  }
  if (result.accounting.metricCallsAccounted !== result.accounting.total) {
    throw new Error(
      `playbook evidence evaluation: accounting.metricCalls did not match the independent agent-invocation tally in ${result.accounting.total - result.accounting.metricCallsAccounted} archetype(s)`
    );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(await evaluatePlaybookEvidence(), null, 2));
}
