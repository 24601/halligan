/**
 * Runnable evaluation for the learning surface (Track B1).
 *
 * Three claim classes, all deterministic and all free: fault recovery, the
 * promotion-policy comparison, and infrastructure overhead. Writes
 * `artifacts/learning-surface-eval.json` as the PR's evidence artifact. Zero
 * API keys, zero cost, zero network.
 *
 * MECHANISM EVIDENCE, NOT MODEL QUALITY. The provider is a deterministic stub,
 * the metric is a fixed score series, the task sets are fixed, and the proposer
 * is a deterministic host callback. Nothing emitted here is an independent
 * held-out set or a live-model improvement claim.
 *
 * Paired with `scripts/eval-learning-surface.test.ts`, which is wired into the
 * root `npm test` chain so this evidence cannot silently rot.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AxAgentLearning } from '../src/ax/agent/agentInternal/agentLearning.js';
import type { AxAgentEvalTask } from '../src/ax/agent/agentInternal/agentOptimizeTypes.js';
import type { AxAIService } from '../src/ax/ai/types.js';
import { AxManualEventClock } from '../src/ax/event/types.js';
import { axEventCanonicalJson } from '../src/ax/event/util.js';
import {
  axApplyHarnessTree,
  axCurrentHarnessInstallation,
} from '../src/ax/learn/apply.js';
import {
  type AxHarnessEvolveAgent,
  axHarnessEvolve,
} from '../src/ax/learn/evolve.js';
import { AxInMemoryLearningStore } from '../src/ax/learn/memoryStore.js';
import {
  type AxLearningEngineState,
  axCreateLearningEngineState,
  axLearningEngineIngest,
  axScoreWindowProcessor,
} from '../src/ax/learn/processor.js';
import {
  type AxLearningSurface,
  axLearningSurface,
} from '../src/ax/learn/releases.js';
import type {
  AxHarnessEntry,
  AxHarnessInstallTarget,
  AxHarnessMutation,
  AxHarnessTree,
  AxLearningRecord,
  AxLearningStore,
} from '../src/ax/learn/types.js';

export const AX_LEARNING_SURFACE_EVAL_ARTIFACT =
  'artifacts/learning-surface-eval.json';

const NOW = 1_000;
const ISO = new Date(NOW).toISOString();

// ---------------------------------------------------------------------------
// Deterministic scaffolding
// ---------------------------------------------------------------------------

/**
 * xorshift32 — a seeded PRNG so an "ordering" is reproducible from its seed.
 *
 * The warm-up is load-bearing, not decoration. Started from 1..20 the raw
 * generator's first few outputs are strongly correlated, so a boundary that
 * drew one or two numbers per ordering collapsed twenty "seeded orderings"
 * into one or two distinct configurations while reporting twenty. The rows now
 * carry `distinctConfigurations` so that can never go unnoticed again.
 */
function seeded(seed: number): () => number {
  let state = seed | 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = 0; i < 16; i += 1) next();
  return () => next() / 0xff_ff_ff_ff;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const instruction = (id: string, text: string): AxHarnessEntry => ({
  id,
  kind: 'instruction',
  config: { text },
});

const SEED_TREE: AxHarnessTree = [instruction('tone', 'Answer briefly.')];
/** Distinct losing-writer payloads, so a seeded race is not one race twenty times. */
const CONTESTED_TREES: readonly AxHarnessTree[] = [
  [instruction('tone', 'Answer in exactly one sentence.')],
  [instruction('tone', 'Answer with a bulleted list.')],
  [instruction('tone', 'Answer, then name your uncertainty.')],
];

const CANDIDATE_MUTATION: AxHarnessMutation = {
  op: 'update',
  id: 'tone',
  options: { config: { text: 'Answer in exactly one sentence.' } },
};

/**
 * The smallest thing that is still the real recording path: a host object that
 * satisfies the install port and answers a forward, so the surface under test
 * is the learning code and not the agent pipeline.
 */
class StubAgent implements AxHarnessInstallTarget {
  readonly instructionSlots = new Map<string, string>();
  readonly skillSlots = new Map<string, unknown>();
  forwardCalls = 0;
  evaluationCalls = 0;
  /** Set by the evolve harness driver to score by installed side. */
  onEvaluation?: () => void;

  setActorInstructionSlot(slot: string, text?: string): void {
    if (text === undefined) this.instructionSlots.delete(slot);
    else this.instructionSlots.set(slot, text);
  }

  getActorInstructionSlot(slot: string): string | undefined {
    return this.instructionSlots.get(slot);
  }

  setSkillsCatalogSlot(slot: string, skills?: unknown): void {
    if (skills === undefined) this.skillSlots.delete(slot);
    else this.skillSlots.set(slot, skills);
  }

  getSkillsCatalogSlot(slot: string): undefined {
    void slot;
    return undefined;
  }

  getPlaybook() {
    return undefined;
  }

  getSignature() {
    return { toString: () => 'query:string -> answer:string' };
  }

  getId(): string {
    return 'stub-agent';
  }

  getUsage() {
    return { actor: [], responder: [] };
  }

  async forward(
    _ai: Readonly<AxAIService>,
    values: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.forwardCalls += 1;
    return { answer: `echo:${String(values.query ?? '')}` };
  }

  async _forwardForEvaluation(
    _ai: Readonly<AxAIService>,
    task: Readonly<AxAgentEvalTask>
  ): Promise<Record<string, unknown>> {
    this.evaluationCalls += 1;
    this.onEvaluation?.();
    return {
      completionType: 'final',
      output: { answer: `echo:${String(task.id ?? '')}` },
      actionLog: [],
      guidanceLog: [],
      functionCalls: [],
    };
  }
}

const STUB_AI = {} as unknown as Readonly<AxAIService>;

function learningFor(
  agent: StubAgent,
  store: AxLearningStore,
  surface: AxLearningSurface,
  clock: AxManualEventClock,
  extra: Readonly<Record<string, unknown>> = {}
): AxAgentLearning {
  let counter = 0;
  return new AxAgentLearning(agent as never, {
    scenario: 'support',
    store,
    surface,
    clock,
    idFactory: () => {
      counter += 1;
      return `rec-${counter}`;
    },
    ...extra,
  });
}

async function freshChain(): Promise<{
  clock: AxManualEventClock;
  store: AxInMemoryLearningStore;
  surface: AxLearningSurface;
}> {
  const clock = new AxManualEventClock(NOW);
  const store = new AxInMemoryLearningStore({ clock });
  let counter = 0;
  const surface = await axLearningSurface({
    scenario: 'support',
    store,
    clock,
    seed: SEED_TREE,
    idFactory: () => {
      counter += 1;
      return `rel-${counter}`;
    },
  });
  return { clock, store, surface };
}

/** Wrap a store so exactly one operation fails, at a chosen boundary. */
function faultyStore(
  inner: AxInMemoryLearningStore,
  fault: Readonly<{
    kind: 'append-pre-commit' | 'append-post-commit' | 'chain-append-cas';
    atCall: number;
  }>
): AxLearningStore {
  let appendCalls = 0;
  let releaseCalls = 0;
  return {
    capabilities: inner.capabilities,
    clock: inner.clock,
    append: async (record, signal) => {
      appendCalls += 1;
      const shouldFail = appendCalls === fault.atCall;
      if (shouldFail && fault.kind === 'append-pre-commit') {
        throw new Error('injected fault: store died before the write');
      }
      const result = await inner.append(record, signal);
      if (shouldFail && fault.kind === 'append-post-commit') {
        // The record IS durable; the process died on the way back.
        throw new Error('injected fault: store died after the write');
      }
      return result;
    },
    get: inner.get.bind(inner),
    page: inner.page.bind(inner),
    markConsumed: inner.markConsumed.bind(inner),
    putRelease: async (release, expectedTail, signal) => {
      releaseCalls += 1;
      if (fault.kind === 'chain-append-cas' && releaseCalls === fault.atCall) {
        // A concurrent writer won the tail; our expectation is now stale.
        await inner.putRelease(
          { ...release, releaseId: `${release.releaseId}-racer` },
          expectedTail,
          signal
        );
      }
      return inner.putRelease(release, expectedTail, signal);
    },
    promoteRelease: inner.promoteRelease.bind(inner),
    head: inner.head.bind(inner),
    releases: inner.releases.bind(inner),
  };
}

// ---------------------------------------------------------------------------
// Claim 1 — recovery and durability under injected faults
// ---------------------------------------------------------------------------

export interface FaultRow {
  boundary: string;
  /** How many times the boundary was exercised. */
  orderings: number;
  /**
   * How many DISTINCT injected configurations those orderings covered.
   *
   * Reported beside `orderings` because a repetition count implies breadth it
   * does not have on its own: three of these boundaries used to run 20
   * byte-identical repetitions while claiming 20 seeded orderings. Every row
   * must now be > 1, and the gap between the two numbers is how many
   * repetitions are guarding nondeterminism rather than adding coverage.
   */
  distinctConfigurations: number;
  recordsLostAfterReceipt: number;
  receiptsWithoutRecord: number;
  headsMovedWithoutPromote: number;
  /**
   * Appends that should not have happened. An append the boundary EXPECTS —
   * the post-commit crash variant, whose whole point is that the row landed
   * before the process died — is subtracted, so this stays "0 means correct".
   */
  releasesAppendedAfterFault: number;
  treesLeftInstalled: number;
  faultsObserved: number;
}

const ORDERINGS = 20;

/** A fresh row, so every boundary reports the same columns. */
function faultRow(boundary: string): FaultRow {
  return {
    boundary,
    orderings: ORDERINGS,
    distinctConfigurations: 0,
    recordsLostAfterReceipt: 0,
    receiptsWithoutRecord: 0,
    headsMovedWithoutPromote: 0,
    releasesAppendedAfterFault: 0,
    treesLeftInstalled: 0,
    faultsObserved: 0,
  };
}

async function faultBoundaryAppend(
  variant: 'append-pre-commit' | 'append-post-commit'
): Promise<FaultRow> {
  const row = faultRow(variant);
  const configurations = new Set<string>();

  for (let seed = 1; seed <= ORDERINGS; seed += 1) {
    const random = seeded(seed);
    const { clock, store, surface } = await freshChain();
    const headBefore = (await surface.currentTree())?.releaseId;
    const agent = new StubAgent();
    const queries = shuffle(['a', 'b', 'c', 'd', 'e'], random);
    const failAt = 1 + Math.floor(random() * queries.length);
    configurations.add(`${queries.join('')}@${failAt}`);
    const learning = learningFor(
      agent,
      faultyStore(store, { kind: variant, atCall: failAt }),
      surface,
      clock
    );

    const receipts: string[] = [];
    for (const query of queries) {
      try {
        const { receipt } = await learning.run(STUB_AI, { query });
        receipts.push(receipt.recordId);
      } catch {
        row.faultsObserved += 1;
      }
    }

    // Every receipt handed out must name a record that is actually there.
    for (const recordId of receipts) {
      if ((await store.get('support', recordId)) === undefined) {
        row.recordsLostAfterReceipt += 1;
      }
    }
    // …and every stored interaction must correspond to a receipt the caller
    // holds, EXCEPT the post-commit variant, whose whole point is that the
    // write survived a crash on the way back. That record has no receipt, and
    // the caller correctly saw a rejection instead of a fake one.
    const page = await store.page('support', {});
    const stored = page.entries.filter(
      (entry) => entry.record.kind === 'interaction'
    );
    const expectedStored =
      variant === 'append-post-commit' ? receipts.length + 1 : receipts.length;
    if (stored.length !== expectedStored) {
      row.receiptsWithoutRecord += Math.abs(stored.length - expectedStored);
    }
    if ((await surface.currentTree())?.releaseId !== headBefore) {
      row.headsMovedWithoutPromote += 1;
    }
    if (axCurrentHarnessInstallation(agent) !== undefined) {
      row.treesLeftInstalled += 1;
    }
  }
  row.distinctConfigurations = configurations.size;
  return row;
}

async function faultBoundaryChainCas(): Promise<FaultRow> {
  const row = faultRow('chain-append-cas-lost-race');
  const configurations = new Set<string>();

  for (let seed = 1; seed <= ORDERINGS; seed += 1) {
    const random = seeded(seed);
    const clock = new AxManualEventClock(NOW);
    const inner = new AxInMemoryLearningStore({ clock });
    let counter = 0;
    // Seeded: how long the chain already is when the race happens, and which
    // tree the losing writer was carrying. A fixed `atCall: 2` against a
    // fixed one-release chain is one configuration repeated, not twenty.
    const priorPublishes = Math.floor(random() * 3);
    const contestedTree = shuffle(CONTESTED_TREES, random)[0] as AxHarnessTree;
    const store = faultyStore(inner, {
      kind: 'chain-append-cas',
      // 1 seed + `priorPublishes` uncontested appends come first.
      atCall: 2 + priorPublishes,
    });
    configurations.add(
      `${priorPublishes}@${(contestedTree[0]?.config as { text: string }).text}`
    );
    const surface = await axLearningSurface({
      scenario: 'support',
      store,
      clock,
      seed: SEED_TREE,
      idFactory: () => {
        counter += 1;
        return `rel-${counter}`;
      },
    });
    for (let prior = 0; prior < priorPublishes; prior += 1) {
      await surface.publish({
        entries: [instruction('tone', `Uncontested ${prior}.`)],
        gate: gateDecision('select', 'seeded'),
      });
    }
    const headBefore = (await surface.currentTree())?.releaseId;
    const before = (await surface.releases()).length;
    try {
      await surface.publish({
        entries: contestedTree,
        gate: gateDecision('select', 'seeded'),
      });
    } catch {
      row.faultsObserved += 1;
    }
    const chain = await surface.releases();
    // The racer's row landed; ours lost the CAS. Exactly one append, never a
    // fork, and never a second copy of our own release.
    row.releasesAppendedAfterFault += chain.length - before === 1 ? 0 : 1;
    // …and the one that landed is the racer's, not ours.
    if (chain.at(-1)?.releaseId.endsWith('-racer') !== true) {
      row.releasesAppendedAfterFault += 1;
    }
    if ((await surface.currentTree())?.releaseId !== headBefore) {
      row.headsMovedWithoutPromote += 1;
    }
  }
  row.distinctConfigurations = configurations.size;
  return row;
}

function gateDecision(outcome: 'select' | 'reject', reason: string) {
  return {
    outcome,
    evaluator: 'harness_task_pairs' as const,
    evaluatorVersion: '1',
    policy: 'axPlaybookGate' as const,
    policyVersion: '1',
    reason,
    metrics: {
      candidateScores: [1],
      currentScores: [0],
      candidateScore: 1,
      currentScore: 0,
      wins: 1,
      losses: 0,
      ties: 0,
      heldIn: { before: 0, after: 1 },
      taskSetDigest: 'seeded',
      failures: { new: [], persisting: [], fixed: [] },
      episodeFailures: 0,
    },
  };
}

async function faultBoundaryEvolveCrash(): Promise<FaultRow> {
  const row = faultRow('evolve-crash-between-decide-and-nominate');
  const configurations = new Set<string>();

  for (let seed = 1; seed <= ORDERINGS; seed += 1) {
    const random = seeded(seed);
    const { clock, store, surface } = await freshChain();
    const headBefore = (await surface.currentTree())?.releaseId;
    const agent = new StubAgent();
    const before = (await surface.releases()).length;
    // Seeded on BOTH axes the boundary name implies: whether the process dies
    // before the append or after it (the "append succeeded, then crash" half
    // was never modelled), and the order the episode sweep ran in first.
    const afterCommit = random() < 0.5;
    const train = shuffle([evalTask('t1'), evalTask('t2')], random);
    configurations.add(
      `${afterCommit ? 'post' : 'pre'}@${train.map((t) => t.id).join('')}`
    );

    const crashing = Object.create(surface) as AxLearningSurface;
    Object.defineProperty(crashing, 'publish', {
      value: async (...args: Parameters<AxLearningSurface['publish']>) => {
        if (afterCommit) {
          // The nomination IS durable; the process died on the way back.
          await surface.publish(...args);
        }
        throw new Error('injected fault: crashed between decide and nominate');
      },
    });
    try {
      await axHarnessEvolve({
        agent: agent as unknown as AxHarnessEvolveAgent,
        ai: STUB_AI,
        surface: crashing,
        tasks: { train, validation: [evalTask('v1')] },
        propose: () => [CANDIDATE_MUTATION],
        metric: () =>
          agent.instructionSlots.get('learn:tone') ===
          'Answer in exactly one sentence.'
            ? 0.9
            : 0.1,
        clock,
      });
    } catch {
      row.faultsObserved += 1;
    }

    const chain = await surface.releases();
    // A pre-commit crash appends nothing; a post-commit crash appends exactly
    // the row it committed, and that row must be a NOMINATION.
    const expectedAppends = afterCommit ? 1 : 0;
    row.releasesAppendedAfterFault += chain.length - before - expectedAppends;
    if (afterCommit && chain.at(-1)?.current !== false) {
      row.releasesAppendedAfterFault += 1;
    }
    if ((await surface.currentTree())?.releaseId !== headBefore) {
      row.headsMovedWithoutPromote += 1;
    }
    if (axCurrentHarnessInstallation(agent) !== undefined) {
      row.treesLeftInstalled += 1;
    }
    // The whole step ran under recording suppression, so a crashed evolution
    // may not have left interaction records behind either.
    const page = await store.page('support', {});
    if (page.entries.some((entry) => entry.record.kind === 'interaction')) {
      row.receiptsWithoutRecord += 1;
    }
  }
  row.distinctConfigurations = configurations.size;
  return row;
}

async function faultBoundaryAbortMidEvaluation(): Promise<FaultRow> {
  const row = faultRow('abort-mid-evaluation');
  const configurations = new Set<string>();

  for (let seed = 1; seed <= ORDERINGS; seed += 1) {
    const random = seeded(seed);
    const { clock, surface } = await freshChain();
    const headBefore = (await surface.currentTree())?.releaseId;
    const agent = new StubAgent();
    const before = (await surface.releases()).length;
    const controller = new AbortController();
    // Three tasks x two sides = six episodes, so the abort point sweeps the
    // WHOLE sweep rather than its first four episodes, and the task order is
    // seeded too.
    const train = shuffle([evalTask('t1'), evalTask('t2')], random);
    const episodes = (train.length + 1) * 2;
    const abortAfter = 1 + Math.floor(random() * episodes);
    configurations.add(`${abortAfter}@${train.map((t) => t.id).join('')}`);
    agent.onEvaluation = () => {
      if (agent.evaluationCalls >= abortAfter) controller.abort();
    };
    try {
      await axHarnessEvolve({
        agent: agent as unknown as AxHarnessEvolveAgent,
        ai: STUB_AI,
        surface,
        tasks: { train, validation: [evalTask('v1')] },
        propose: () => [CANDIDATE_MUTATION],
        metric: () => 0.5,
        clock,
        abortSignal: controller.signal,
      });
    } catch {
      row.faultsObserved += 1;
    }
    if (axCurrentHarnessInstallation(agent) !== undefined) {
      row.treesLeftInstalled += 1;
    }
    if (agent.instructionSlots.size !== 0) {
      row.treesLeftInstalled += 1;
    }
    row.releasesAppendedAfterFault +=
      (await surface.releases()).length - before;
    if ((await surface.currentTree())?.releaseId !== headBefore) {
      row.headsMovedWithoutPromote += 1;
    }
  }
  row.distinctConfigurations = configurations.size;
  return row;
}

function evalTask(id: string): AxAgentEvalTask<{ query: string }> {
  return { id, input: { query: id }, criteria: 'answers the question' };
}

// ---------------------------------------------------------------------------
// Claim 2 — promotion-policy comparison on the six fixed candidates
// ---------------------------------------------------------------------------

type ScoreSeries = readonly number[];

export interface CandidateScenario {
  readonly name: string;
  readonly train: { baseline: ScoreSeries; candidate: ScoreSeries };
  readonly heldOut: { baseline: ScoreSeries; candidate: ScoreSeries };
  readonly runsPerTask?: number;
  /** True when the candidate genuinely helps on the held-out split. */
  readonly helpful: boolean;
}

/**
 * The same six candidate shapes the playbook promotion-policy benchmark uses,
 * so the two numbers are directly comparable.
 */
export const CANDIDATES: readonly CandidateScenario[] = [
  {
    name: 'overfit',
    train: { baseline: [0.2], candidate: [0.9] },
    heldOut: { baseline: [0.8], candidate: [0.1] },
    helpful: false,
  },
  {
    name: 'generalizing',
    train: { baseline: [0.2], candidate: [0.9] },
    heldOut: { baseline: [0.4], candidate: [0.8] },
    helpful: true,
  },
  {
    name: 'no-benefit',
    train: { baseline: [0.4], candidate: [0.4] },
    heldOut: { baseline: [0.4], candidate: [0.4] },
    helpful: false,
  },
  {
    name: 'harmful',
    train: { baseline: [0.6], candidate: [0.2] },
    heldOut: { baseline: [0.6], candidate: [0.2] },
    helpful: false,
  },
  {
    name: 'small-noisy-overfit',
    train: { baseline: [0.1, 0.5, 0.3], candidate: [0.7, 0.9, 0.8] },
    heldOut: { baseline: [0.6, 0.8, 0.7], candidate: [0.2, 0.4, 0.3] },
    runsPerTask: 3,
    helpful: false,
  },
  {
    name: 'small-noisy-generalizing',
    train: { baseline: [0.1, 0.9, 0.2], candidate: [0.5, 0.9, 0.7] },
    heldOut: { baseline: [0.3, 0.5, 0.4], candidate: [0.4, 0.7, 0.6] },
    runsPerTask: 3,
    helpful: true,
  },
  // ADDED beyond the repository's six. The six shapes above never exercise the
  // strict gate's honest cost — none of them helps held-out while improving
  // held-in by less than the 0.05 gain threshold — so the "what does strictness
  // cost" line would read `none` and mean nothing. This one does: it is a real
  // improvement the default gate refuses.
  {
    name: 'small-gain-generalizing',
    train: { baseline: [0.5], candidate: [0.52] },
    heldOut: { baseline: [0.4], candidate: [0.7] },
    helpful: true,
  },
];

const meanOf = (series: ScoreSeries): number =>
  series.reduce((sum, value) => sum + value, 0) / series.length;

export interface PolicyRow {
  scenario: string;
  policy: 'axPlaybookGate' | 'scoreComparison';
  accepted: boolean;
  reason: string;
  heldOutDelta: number;
  helpful: boolean;
}

async function runPolicy(
  scenario: CandidateScenario,
  policy: 'axPlaybookGate' | 'scoreComparison'
): Promise<PolicyRow> {
  const { clock, surface } = await freshChain();
  const agent = new StubAgent();
  const runs = scenario.runsPerTask ?? 1;
  const counters = { train: 0, validation: 0 };

  const result = await axHarnessEvolve({
    agent: agent as unknown as AxHarnessEvolveAgent,
    ai: STUB_AI,
    surface,
    tasks: { train: [evalTask('t1')], validation: [evalTask('v1')] },
    propose: () => [CANDIDATE_MUTATION],
    selection: policy,
    gate: { runsPerTask: runs },
    clock,
    metric: ({ example }) => {
      const id = (example as { id?: string }).id ?? '';
      const isCandidate =
        agent.instructionSlots.get('learn:tone') ===
        'Answer in exactly one sentence.';
      const split = id === 't1' ? 'train' : 'heldOut';
      const key = split === 'train' ? 'train' : 'validation';
      const index = counters[key] % runs;
      counters[key] += 1;
      const series = isCandidate
        ? scenario[split].candidate
        : scenario[split].baseline;
      return series[index] ?? (series[0] as number);
    },
  });

  return {
    scenario: scenario.name,
    policy,
    accepted: result.status === 'nominated',
    reason: result.decision?.reason ?? result.reason ?? 'no decision',
    heldOutDelta:
      meanOf(scenario.heldOut.candidate) - meanOf(scenario.heldOut.baseline),
    helpful: scenario.helpful,
  };
}

// ---------------------------------------------------------------------------
// Claim 3 — infrastructure overhead
// ---------------------------------------------------------------------------

const OVERHEAD_RUNS = 1_000;

export interface OverheadReport {
  runs: number;
  msPerRunWithoutLearning: number;
  msPerRunWithLearning: number;
  addedMsPerRun: number;
  bytesPerRecord: number;
  engineIngest: readonly {
    parkedReports: number;
    decisionsPerInteractionIngest: number;
    msPerIngest: number;
  }[];
}

async function measureOverhead(): Promise<OverheadReport> {
  const bare = new StubAgent();
  const bareStart = performance.now();
  for (let i = 0; i < OVERHEAD_RUNS; i += 1) {
    await bare.forward(STUB_AI, { query: `q${i}` });
  }
  const bareMs = performance.now() - bareStart;

  const { clock, store, surface } = await freshChain();
  const agent = new StubAgent();
  const installation = await axApplyHarnessTree(SEED_TREE, agent, {
    releaseId: 'rel-1',
    now: ISO,
  });
  const learning = learningFor(agent, store, surface, clock);
  const learnStart = performance.now();
  for (let i = 0; i < OVERHEAD_RUNS; i += 1) {
    await learning.run(STUB_AI, { query: `q${i}` });
  }
  const learnMs = performance.now() - learnStart;
  installation.dispose();

  const page = await store.page('support', {});
  const totalBytes = page.entries.reduce(
    (sum, entry) =>
      sum + new TextEncoder().encode(axEventCanonicalJson(entry.record)).length,
    0
  );

  const engineIngest = [0, 100, 1_000].map((parked) => measureIngest(parked));

  return {
    runs: OVERHEAD_RUNS,
    msPerRunWithoutLearning: bareMs / OVERHEAD_RUNS,
    msPerRunWithLearning: learnMs / OVERHEAD_RUNS,
    addedMsPerRun: (learnMs - bareMs) / OVERHEAD_RUNS,
    bytesPerRecord: Math.round(totalBytes / Math.max(1, page.entries.length)),
    engineIngest,
  };
}

/**
 * Ingest cost as an OPERATION count, not only a clock reading.
 *
 * The bound the design claims is `O(waiting[id] + 1)`: an arriving interaction
 * re-judges exactly the reports parked on ITS id. `decisionsPerInteractionIngest`
 * is that quantity, and it must not move as unrelated parked reports pile up.
 */
function measureIngest(parkedReports: number): {
  parkedReports: number;
  decisionsPerInteractionIngest: number;
  msPerIngest: number;
} {
  let state: AxLearningEngineState = axCreateLearningEngineState({
    scenario: 'support',
    processor: axScoreWindowProcessor({ batchSize: 1_000_000 }),
    maxParkedReports: 100_000,
  });
  for (let i = 0; i < parkedReports; i += 1) {
    state = axLearningEngineIngest(state, {
      kind: 'report',
      id: `parked-${i}`,
      scenario: 'support',
      createdAt: NOW,
      references: [`never-arrives-${i}`],
      payload: { score: 0 },
    } as AxLearningRecord).state;
  }
  // One report waiting on the id we are about to deliver.
  state = axLearningEngineIngest(state, {
    kind: 'report',
    id: 'target-report',
    scenario: 'support',
    createdAt: NOW,
    references: ['target'],
    payload: { score: 0 },
  } as AxLearningRecord).state;

  const interaction: AxLearningRecord = {
    kind: 'interaction',
    id: 'target',
    scenario: 'support',
    createdAt: NOW,
    payload: {
      signature: 'query:string -> answer:string',
      programId: 'stub-agent',
      input: { query: 'x' },
      output: { answer: 'y' },
    },
  };
  const start = performance.now();
  const step = axLearningEngineIngest(state, interaction);
  const ms = performance.now() - start;
  return {
    parkedReports,
    decisionsPerInteractionIngest: step.decisions.length,
    msPerIngest: ms,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export async function runLearningSurfaceEvaluation() {
  const faults: FaultRow[] = [
    await faultBoundaryAppend('append-pre-commit'),
    await faultBoundaryAppend('append-post-commit'),
    await faultBoundaryChainCas(),
    await faultBoundaryEvolveCrash(),
    await faultBoundaryAbortMidEvaluation(),
  ];

  const policyRows: PolicyRow[] = [];
  for (const scenario of CANDIDATES) {
    policyRows.push(await runPolicy(scenario, 'scoreComparison'));
    policyRows.push(await runPolicy(scenario, 'axPlaybookGate'));
  }

  const overhead = await measureOverhead();

  const falsePromotions = (policy: PolicyRow['policy']): number =>
    policyRows.filter(
      (row) => row.policy === policy && row.accepted && !row.helpful
    ).length;
  const missedHelpful = (policy: PolicyRow['policy']): string[] =>
    policyRows
      .filter((row) => row.policy === policy && !row.accepted && row.helpful)
      .map((row) => row.scenario);
  const acceptanceVector = (policy: PolicyRow['policy']) =>
    Object.fromEntries(
      policyRows
        .filter((row) => row.policy === policy)
        .map((row) => [row.scenario, row.accepted])
    );

  return {
    kind: 'deterministic-mechanism-characterization' as const,
    independentModelHeldOut: false,
    claim:
      'A receipt is never issued without a durable record; a head moves only through an explicit promote; a nomination is appended at most once under an injected crash; and no trial tree survives an aborted evolution step.',
    baseline:
      "The same code paths with no fault injected, and — for the policy comparison — reef's wins > losses rule (scoreComparison), which this repository had never measured before.",
    budget: {
      providerCalls: 0,
      faultBoundaries: faults.length,
      seededOrderingsPerBoundary: ORDERINGS,
      mockRuns: OVERHEAD_RUNS,
    },
    method:
      "Each fault boundary is exercised `orderings` times from a xorshift32 seed, and each row reports `distinctConfigurations` — how many distinct injected configurations those runs actually covered. Repetitions beyond that count guard nondeterminism; they do not add coverage. The seeded axes are: append — query order and which call faults; chain CAS — chain length at the race and the losing writer's payload; evolve crash — whether the process dies before or after the append, and the episode order; abort — which of the six episodes the caller aborts on, and the episode order.",
    faultInjection: faults,
    promotionPolicy: {
      scenarios: CANDIDATES.map((candidate) => candidate.name),
      rows: policyRows,
      acceptanceVector: {
        scoreComparison: acceptanceVector('scoreComparison'),
        axPlaybookGate: acceptanceVector('axPlaybookGate'),
      },
      falsePromotions: {
        scoreComparison: falsePromotions('scoreComparison'),
        axPlaybookGate: falsePromotions('axPlaybookGate'),
      },
      // The honest cost, reported beside the metric it pays for.
      helpfulCandidatesRejected: {
        scoreComparison: missedHelpful('scoreComparison'),
        axPlaybookGate: missedHelpful('axPlaybookGate'),
      },
      acceptedHeldOutDeltas: {
        scoreComparison: policyRows
          .filter((row) => row.policy === 'scoreComparison' && row.accepted)
          .map((row) => row.heldOutDelta),
        axPlaybookGate: policyRows
          .filter((row) => row.policy === 'axPlaybookGate' && row.accepted)
          .map((row) => row.heldOutDelta),
      },
    },
    overhead,
    limitations: [
      'Deterministic mechanism evaluation with a stub provider, fixed metrics and fixed task sets. Not an independent model held-out set and not a live-model improvement claim.',
      'The overhead arm measures the RECORDING path against a bare forward on the same stub host, so it isolates the learning surface rather than the agent pipeline. It is not a measurement of end-to-end agent latency.',
      'The credential tripwire is not exercised here; it is pinned by the admission fixtures instead. It matches known key names and known literal shapes, and a novel credential format under an innocuous key is not caught.',
      "The six candidate shapes are the repository's existing promotion-policy fixtures, not a sample of real proposals.",
    ],
  };
}

export type AxLearningSurfaceEvalReport = Awaited<
  ReturnType<typeof runLearningSurfaceEvaluation>
>;

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${resolve(process.argv[1])}`;

if (invokedDirectly) {
  const report = await runLearningSurfaceEvaluation();
  console.log('fault boundaries');
  for (const row of report.faultInjection) {
    console.log(
      `  ${row.boundary.padEnd(40)} faults=${row.faultsObserved}/${row.orderings} configs=${row.distinctConfigurations} lost=${row.recordsLostAfterReceipt} receiptsWithoutRecord=${row.receiptsWithoutRecord} headsMoved=${row.headsMovedWithoutPromote} treesLeft=${row.treesLeftInstalled} unexpectedAppends=${row.releasesAppendedAfterFault}`
    );
  }
  console.log('\npromotion policy (accepted?)');
  for (const scenario of report.promotionPolicy.scenarios) {
    const parity = report.promotionPolicy.acceptanceVector.scoreComparison[
      scenario
    ]
      ? 'accept'
      : 'reject';
    const gate = report.promotionPolicy.acceptanceVector.axPlaybookGate[
      scenario
    ]
      ? 'accept'
      : 'reject';
    console.log(
      `  ${scenario.padEnd(26)} scoreComparison=${parity.padEnd(6)} axPlaybookGate=${gate}`
    );
  }
  console.log(
    `\nfalse promotions: scoreComparison=${report.promotionPolicy.falsePromotions.scoreComparison} axPlaybookGate=${report.promotionPolicy.falsePromotions.axPlaybookGate}`
  );
  console.log(
    `helpful candidates axPlaybookGate rejected: ${
      report.promotionPolicy.helpfulCandidatesRejected.axPlaybookGate.join(
        ', '
      ) || 'none'
    }`
  );
  console.log(
    `\noverhead: +${report.overhead.addedMsPerRun.toFixed(3)} ms/run, ${report.overhead.bytesPerRecord} bytes/record`
  );
  for (const row of report.overhead.engineIngest) {
    console.log(
      `  parked=${String(row.parkedReports).padStart(5)} decisions/ingest=${row.decisionsPerInteractionIngest}`
    );
  }
  const outPath = resolve(process.cwd(), AX_LEARNING_SURFACE_EVAL_ARTIFACT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${AX_LEARNING_SURFACE_EVAL_ARTIFACT}`);
}
