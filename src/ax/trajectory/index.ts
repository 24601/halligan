export type {
  AxTrajectoryStoreConformanceFactory,
  AxTrajectoryStoreConformanceFactoryOptions,
  AxTrajectoryStoreConformanceInstance,
  AxTrajectoryStoreConformanceReport,
} from './conformance.js';
export { runAxTrajectoryStoreConformance } from './conformance.js';
// Shared by BOTH shipped stores. `src/tools` consumes the package root, so
// the log index and the write-boundary helpers have to be reachable from it:
// the alternative is the ~230 duplicated lines this replaced, where a fix
// applied to one store silently missed the other.
export type {
  AxTrajectoryLogEntry,
  AxTrajectoryLogOptions,
  AxTrajectoryPreparedStep,
  AxTrajectorySpilledStep,
  AxTrajectorySpillStepOptions,
} from './log.js';
export {
  AxTrajectoryLog,
  axFreezeTrajectoryStep,
  axPrepareTrajectoryStep,
  axSpillTrajectoryStep,
} from './log.js';
export type { AxInMemoryTrajectoryStoreOptions } from './memoryStore.js';
export {
  AxInMemoryTrajectoryBlobStore,
  AxInMemoryTrajectoryStore,
} from './memoryStore.js';
export type {
  AxTrajectoryContextBudgetOptions,
  AxTrajectoryProjection,
  AxTrajectoryProjectionOptions,
  AxTrajectoryProjectionSection,
} from './projection.js';
export {
  axProjectTrajectory,
  axRenderTrajectoryProjection,
  axResolveTrajectoryCitations,
  axTrajectoryContextBudget,
  axTrajectoryDefaultBudgetTokens,
  axTrajectoryDefaultFanout,
  axTrajectoryDescentBudget,
  axTrajectoryMinRecentSteps,
  axTrajectoryRecentSize,
  axTrajectoryScanPageSteps,
  axTrajectoryTokensPerStep,
} from './projection.js';
export type { AxTrajectoryTypeRegistryOptions } from './registry.js';
export {
  axDefaultTrajectoryTypes,
  axTrajectoryTypeRegistry,
  axTrajectoryUnknownDescriptor,
} from './registry.js';
export type {
  AxDeterministicTrajectorySummarizerOptions,
  AxTrajectoryBuildRollupsOptions,
  AxTrajectoryBuildRollupsResult,
  AxTrajectoryProgramSummarizerOptions,
  AxTrajectoryRollupBlock,
  AxTrajectoryRollupMeta,
  AxTrajectoryRollupStore,
  AxTrajectorySummarizer,
  AxTrajectorySummarizerRequest,
  AxTrajectorySummarizerResult,
} from './rollups.js';
export {
  AxInMemoryTrajectoryRollupStore,
  axBuildTrajectoryRollups,
  axDeterministicTrajectorySummarizer,
  axTrajectoryMaxSummaryBytes,
  axTrajectoryMaxThemes,
  axTrajectoryProgramSummarizer,
  axTrajectoryRollupSignature,
} from './rollups.js';
export type {
  AxTrajectoryResolveOptions,
  AxTrajectorySpillPolicy,
  AxTrajectorySpillRequest,
  AxTrajectorySpillResult,
} from './spill.js';
export {
  axDefaultTrajectorySpillPolicy,
  axResolveTrajectoryStep,
  axResolveTrajectorySteps,
  axSpillTrajectoryFields,
  axTrajectoryInlineBytes,
} from './spill.js';
export type {
  AxTrajectoryAppendReceipt,
  AxTrajectoryAppendRequest,
  AxTrajectoryBlobPutRequest,
  AxTrajectoryBlobRef,
  AxTrajectoryBlobStore,
  AxTrajectoryCreateRequest,
  AxTrajectoryCursor,
  AxTrajectoryDrainBudget,
  AxTrajectoryDrainResult,
  AxTrajectoryFieldValue,
  AxTrajectoryForkRequest,
  AxTrajectoryForkResult,
  AxTrajectoryHeader,
  AxTrajectoryMergeRequest,
  AxTrajectoryReader,
  AxTrajectoryReadQuery,
  AxTrajectoryStats,
  AxTrajectoryStep,
  AxTrajectoryStepClass,
  AxTrajectoryStore,
  AxTrajectoryStoreCapabilities,
  AxTrajectoryTailQuery,
  AxTrajectoryTailResult,
  AxTrajectoryTypeDescriptor,
  AxTrajectoryTypeRegistry,
} from './types.js';
export {
  AxTrajectoryAppendError,
  AxTrajectoryBlobError,
  AxTrajectoryCursorError,
  AxTrajectoryForkError,
  AxTrajectoryQueryError,
  AxTrajectoryRegistryError,
  AxTrajectoryRollupError,
  axIsTrajectoryAppendError,
  axIsTrajectoryBlobError,
  axIsTrajectoryCursorError,
  axIsTrajectoryQueryError,
  axTrajectoryMaxStepIds,
} from './types.js';
export {
  axNormalizeTrajectoryTimestamp,
  axTrajectoryCompactData,
  axTrajectoryId,
  axTrajectoryInvalidFieldPath,
  axTrajectoryStepBytes,
  axTrajectoryStepFingerprint,
  axTrajectoryTruncateUtf8,
  axTrajectoryUtf8ByteLength,
} from './util.js';
