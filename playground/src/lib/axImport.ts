/**
 * The single import surface for halligan symbols.
 *
 * Pry aliases `@ax-llm/ax` to this repository's `src/ax/index.ts` (see
 * `vite.config.ts`), so the site builds from the working tree and goes stale
 * the moment the tree changes. `@ax-llm/ax-tools` is NEVER imported: that
 * package is the node-only boundary (JSONL trajectory store, SQLite event
 * store, process-spawning fault harnesses) and its absence is enforced by the
 * `pry-no-node-specifiers` build plugin.
 *
 * Every symbol re-exported here is checked to exist in `src/ax/index.ts`.
 */

export type {
  AxMind,
  AxMindPacerConfig,
  AxMindPacerState,
  AxMindThinker,
  AxMindWakeClass,
  AxMindWakeOutcome,
  AxTrajectoryProjection,
  AxTrajectoryRollupBlock,
  AxTrajectoryRollupMeta,
  AxTrajectoryStep,
} from '@ax-llm/ax';
export {
  AxInMemoryEventStore,
  AxInMemoryTrajectoryBlobStore,
  AxInMemoryTrajectoryRollupStore,
  AxInMemoryTrajectoryStore,
  AxManualEventClock,
  AxMindDeterministicProgram,
  AxSignature,
  axBuildTrajectoryRollups,
  axDefaultMindPacerConfig,
  axDefaultMindSubscription,
  axDeterministicTrajectorySummarizer,
  axInitialMindPacerState,
  axMindPaceDelay,
  axMindPacerFuse,
  axMindPaceStepType,
  axMindStaticArtifacts,
  axNextMindPace,
  axProjectTrajectory,
  axRecoverMindPacerState,
  axTrajectoryContextBudget,
  axTrajectoryDefaultBudgetTokens,
  axTrajectoryDefaultFanout,
  axTrajectoryMinRecentSteps,
  axTrajectoryRecentSize,
  axTrajectoryTokensPerStep,
  axTrajectoryTypeRegistry,
  mind,
} from '@ax-llm/ax';

/** The exact symbols the hero exercises, for the provenance rail. */
export const heroSymbols = Object.freeze([
  'mind',
  'AxMindDeterministicProgram',
  'AxInMemoryTrajectoryStore',
  'AxInMemoryEventStore',
  'AxManualEventClock',
  'axProjectTrajectory',
  'axBuildTrajectoryRollups',
  'AxInMemoryTrajectoryRollupStore',
  'axDeterministicTrajectorySummarizer',
  'axTrajectoryContextBudget',
  'axTrajectoryRecentSize',
  'axMindPaceDelay',
  'axMindPacerFuse',
  'axRecoverMindPacerState',
]);
