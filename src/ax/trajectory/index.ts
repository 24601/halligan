export type { AxTrajectoryTypeRegistryOptions } from './registry.js';
export {
  axDefaultTrajectoryTypes,
  axTrajectoryTypeRegistry,
  axTrajectoryUnknownDescriptor,
} from './registry.js';
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
