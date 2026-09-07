import type { Component } from 'vue';
import { defineAsyncComponent } from 'vue';

/**
 * The demo registry. This is the seam every later lane plugs into: add an
 * entry, point `view` at your own directory, and the catalogue, the finder,
 * the router and the provenance rail all pick it up. Nothing else in the shell
 * knows a demo exists.
 *
 * `status: 'planned'` is an honest state, not a placeholder: the card says
 * which lane owns it and what it will show, and it is not clickable into an
 * empty room.
 */
export type DemoBand = 'pinned' | 'needs-model' | 'inside';
export type DemoStatus = 'live' | 'planned';

export interface DemoEntry {
  readonly id: string;
  readonly name: string;
  readonly kicker: string;
  readonly headline: string;
  readonly band: DemoBand;
  readonly status: DemoStatus;
  readonly lane: string;
  /** Where it executes, in the reader's own words. */
  readonly runsWhere: string;
  /** What is real and what is simulated. Rendered verbatim on the rail. */
  readonly real: string;
  readonly symbols: readonly string[];
  readonly docs: readonly string[];
  readonly seed: number;
  readonly sliver: string;
  readonly keywords: readonly string[];
  readonly view?: () => Promise<Component>;
}

export const demos: readonly DemoEntry[] = Object.freeze([
  {
    id: 'D1',
    name: 'Mind',
    kicker: 'the autobiography and the ladder',
    headline:
      'A persistent mind with no provider attached: life log, tiered rollups, bounded projection, and the pacing ladder it descends on its own.',
    band: 'pinned',
    status: 'live',
    lane: 'L1',
    runsWhere: 'your tab, no network, no model',
    real: 'every figure is read from the running store, projection and pacer',
    symbols: [
      'mind',
      'AxMindDeterministicProgram',
      'AxInMemoryTrajectoryStore',
      'AxInMemoryEventStore',
      'AxManualEventClock',
      'axProjectTrajectory',
      'axBuildTrajectoryRollups',
      'AxInMemoryTrajectoryRollupStore',
      'axTrajectoryContextBudget',
      'axTrajectoryRecentSize',
      'axMindPaceDelay',
      'axMindPacerFuse',
      'axRecoverMindPacerState',
    ],
    docs: ['docs/MIND.md', 'docs/TRAJECTORY.md', 'src/ax/skills/ax-mind.md'],
    seed: 7,
    sliver: 'slivers/d1.svg',
    keywords: [
      'mind',
      'trajectory',
      'rollup',
      'pyramid',
      'pacer',
      'ladder',
      'backoff',
      'projection',
      'context',
      'budget',
      'compactor',
      'fork',
      'wake',
      'life log',
    ],
    view: () =>
      import('../demos/D1Mind/D1Mind.vue').then((m) => m.default as Component),
  },
  {
    id: 'D2',
    name: 'Effects',
    kicker: 'the crash matrix, replayed',
    headline:
      'The event runtime delivery ledger and the fourteen-row crash matrix, executed against a real store rather than described.',
    band: 'pinned',
    status: 'planned',
    lane: 'L2',
    runsWhere: 'your tab',
    real: 'C4-C14 execute live; C1-C3 and C14 replay recorded CI evidence',
    symbols: [
      'AxEventRuntime',
      'AxInMemoryEventStore',
      'declareEffect',
      'settleEffect',
    ],
    docs: ['docs/EVENT_RUNTIME.md', 'docs/MIND.md'],
    seed: 7,
    sliver: 'slivers/d2.svg',
    keywords: [
      'effects',
      'crash',
      'matrix',
      'ledger',
      'event',
      'runtime',
      'replay',
    ],
  },
  {
    id: 'D3',
    name: 'Evolve',
    kicker: 'the learn chain, end to end',
    headline:
      'Serve, observe, grow, nominate: the release chain, its refusals, and a promotion you perform yourself as the host.',
    band: 'pinned',
    status: 'planned',
    lane: 'L3',
    runsWhere: 'your tab',
    real: 'the promotion receipt is minted by the real authority path',
    symbols: ['axLearningSurface', 'axHarnessEvolve', 'axApplyHarnessTree'],
    docs: ['docs/LEARNING_SURFACE.md'],
    seed: 7,
    sliver: 'slivers/d3.svg',
    keywords: [
      'evolve',
      'learn',
      'records',
      'release',
      'promote',
      'authority',
      'sankey',
    ],
  },
  {
    id: 'D4',
    name: 'GEPA',
    kicker: 'lineage, and the two gates',
    headline:
      'The candidate lineage DAG, the discriminative minibatch, the two promotion gates and the fail-closed refusals behind them.',
    band: 'pinned',
    status: 'planned',
    lane: 'L3',
    runsWhere: 'your tab, WebGPU for the DAG',
    real: 'a seeded search over AxMockAIService; every estimate is computed',
    symbols: ['AxGEPA', 'AxMockAIService', 'AxManualEventClock'],
    docs: ['docs/GEPA_EVIDENCE.md'],
    seed: 7,
    sliver: 'slivers/d4.svg',
    keywords: [
      'gepa',
      'lineage',
      'dag',
      'pareto',
      'minibatch',
      'madow',
      'gate',
    ],
  },
  {
    id: 'D5',
    name: 'Working state',
    kicker: 'the transcript is not the state',
    headline:
      'Verifier-gated working state, delta classification, parks, and the measured-equals-sent property on one two-track ribbon.',
    band: 'inside',
    status: 'planned',
    lane: 'L5',
    runsWhere: 'your tab',
    real: 'deltas run through the shipped verifier',
    symbols: ['workingStateMetrics', 'workingStateScenarios'],
    docs: ['docs/AGENT_WORKING_STATE.md'],
    seed: 7,
    sliver: 'slivers/d5.svg',
    keywords: [
      'working state',
      'delta',
      'park',
      'verifier',
      'skillState',
      'transcript',
    ],
  },
  {
    id: 'D6',
    name: 'Provenance',
    kicker: 'an artifact that outlived its permissions',
    headline:
      'Skill provenance, visibility tiers, and the retrieval-time re-check that makes all four retrieval paths fail together.',
    band: 'inside',
    status: 'planned',
    lane: 'L5',
    runsWhere: 'your tab',
    real: 'digests are recomputed live; nothing is a fixture',
    symbols: ['axExtractSkillProvenance', 'axSkillRetrievalGate'],
    docs: ['docs/SKILL_PROVENANCE.md', 'docs/HOST_AUTHORITY.md'],
    seed: 7,
    sliver: 'slivers/d6.svg',
    keywords: ['provenance', 'authority', 'revoke', 'digest', 'skills', 'gate'],
  },
  {
    id: 'D7',
    name: 'Execution console',
    kicker: 'talk to it',
    headline:
      'One agent turn with tools, through whichever backend you pick: in-browser WebGPU, your own endpoint, or a deterministic mock.',
    band: 'needs-model',
    status: 'planned',
    lane: 'L4',
    runsWhere: 'your GPU, your endpoint, or a deterministic mock',
    real: 'one ai({ apiURL }) call site serves all three backends',
    symbols: ['ai', 'agent', 'ax', 'fn'],
    docs: ['docs/AGENTS.md'],
    seed: 7,
    sliver: 'slivers/d7.svg',
    keywords: [
      'console',
      'chat',
      'tools',
      'webllm',
      'endpoint',
      'ollama',
      'vllm',
    ],
  },
  {
    id: 'D9',
    name: 'Reactive cells',
    kicker: 'the same contracts, editable',
    headline:
      'Native TypeScript reactive cells over the real library, with JupyterLite as a secondary opt-in tab.',
    band: 'inside',
    status: 'planned',
    lane: 'L5',
    runsWhere: 'your tab; the Python tab downloads Pyodide on request',
    real: 'the TypeScript cells run this repository, not a port',
    symbols: ['ax', 's', 'agent'],
    docs: ['docs/README.md'],
    seed: 7,
    sliver: 'slivers/d9.svg',
    keywords: [
      'notebook',
      'cells',
      'reactive',
      'python',
      'jupyterlite',
      'pyodide',
    ],
  },
]);

export const demoById = (id: string | null): DemoEntry | undefined =>
  id ? demos.find((demo) => demo.id === id) : undefined;

export const demosInBand = (band: DemoBand): readonly DemoEntry[] =>
  demos.filter((demo) => demo.band === band);

export const asyncView = (entry: DemoEntry): Component | null =>
  entry.view ? defineAsyncComponent(entry.view) : null;
