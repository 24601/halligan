/* eslint import/order: 0 sort-imports: 0 */
// Auto-generated index file - Do not edit

import {
  AxAgentContextMap,
  type AxAgentContextMapConfig,
  type AxAgentContextMapOperation,
  type AxAgentContextMapOptions,
  type AxAgentContextMapSnapshot,
  type AxAgentContextMapUpdateResult,
} from './agent/AxAgent.js';
import type {
  AxAgentAutoPromotionRecord,
  AxAgentExecutorResultPayload,
  AxAgentFunctionCall,
  AxAgentFunctionCallRecorder,
  AxAgentGuidanceState,
  AxAgentOnFunctionCall,
  AxAgentOptimizationTargetDescriptor,
  AxAgentRuntimeCompletionState,
  AxAgentRuntimeExecutionContext,
  AxAgentRuntimeInputState,
  AxDiscoveryTurnSummary,
  AxLlmQueryBudgetState,
  AxLlmQueryPromptMode,
  AxResolvedContextPolicy,
  AxResolvedExecutorModelPolicy,
  AxResolvedExecutorModelPolicyEntry,
  AxStageDefinitionBuildOptions,
} from './agent/agentInternal/agentInternalTypes.js';
import type {
  AxAgentDemos,
  AxAgentEvalDataset,
  AxAgentEvalFunctionCall,
  AxAgentEvalPrediction,
  AxAgentEvalTask,
  AxAgentForwardOptions,
  AxAgentJudgeEvalInput,
  AxAgentJudgeEvalOutput,
  AxAgentJudgeInput,
  AxAgentJudgeOptions,
  AxAgentJudgeOutput,
  AxAgentOptimizeOptions,
  AxAgentOptimizeResult,
  AxAgentOptimizeTarget,
  AxAgentOptions,
  AxAgentPlaybookOptions,
  AxAgentRecursionOptions,
  AxAgentStreamingForwardOptions,
  AxStageOptions,
} from './agent/agentInternal/agentOptimizeTypes.js';
import { AxAgentPlaybook } from './agent/agentInternal/agentPlaybook.js';
import {
  type AxAgentActorTurnCallback,
  type AxAgentActorTurnCallbackArgs,
  type AxAgentClarification,
  type AxAgentClarificationChoice,
  AxAgentClarificationError,
  type AxAgentClarificationKind,
  type AxAgentDiscoveryPromptState,
  type AxAgentFunction,
  type AxAgentFunctionCollection,
  type AxAgentFunctionExample,
  type AxAgentFunctionGroup,
  type AxAgentFunctionModuleMeta,
  type AxAgentGuidanceLogEntry,
  type AxAgentIdentity,
  type AxAgentInputUpdateCallback,
  type AxAgentic,
  type AxAgentSkillsPromptState,
  type AxAgentState,
  type AxAgentStateActionLogEntry,
  type AxAgentStateCheckpointState,
  type AxAgentStateExecutorModelState,
  type AxAgentStateRuntimeEntry,
  type AxAgentStructuredClarification,
  type AxAgentTestCompletionPayload,
  type AxAgentTestResult,
  type AxAnyAgentic,
  type AxContextFieldInput,
  type AxContextFieldPromptConfig,
  type AxExecutorModelPolicy,
  type AxExecutorModelPolicyEntry,
  type AxFunctionProvider,
} from './agent/agentInternal/agentStateTypes.js';
import {
  AxAgent,
  type AxAgentConfig,
  agent,
} from './agent/agentInternal/coordinator.js';
import {
  type AxAgentFailureReport,
  type AxAgentFailureSignal,
  type AxAgentFailureSignalKind,
  axPlaybookFailureSection,
} from './agent/agentInternal/failureReport.js';
import type { AxAgentMemoryEntry } from './agent/agentInternal/memoriesHelpers.js';
import type {
  AxAgentMemoriesSearchFn,
  AxAgentMemoryResult,
  AxAgentUsedMemoriesCallback,
  AxAgentUsedMemory,
} from './agent/agentInternal/memoriesTypes.js';
import type {
  AxAgentEvalBatchResult,
  AxAgentEvalBudget,
} from './agent/agentInternal/playbookEvolve/evalHarness.js';
import type { AxAgentFailureCluster } from './agent/agentInternal/playbookEvolve/failureClusters.js';
import type {
  AxGateAuthorityOutcome,
  AxGateVetoOutcome,
} from './agent/agentInternal/playbookEvolve/gates.js';
import {
  type AxAgentEnvironmentFailureCause,
  type AxAgentPlaybookAttemptRecord,
  type AxAgentPlaybookComputeAccounting,
  type AxAgentPlaybookComputePhase,
  type AxAgentPlaybookComputePhaseName,
  type AxAgentPlaybookControlArmKind,
  type AxAgentPlaybookControlArmOptions,
  type AxAgentPlaybookControlArmReport,
  type AxAgentPlaybookControlArmResult,
  type AxAgentPlaybookCostFn,
  type AxAgentPlaybookEviction,
  type AxAgentPlaybookEvidenceGates,
  type AxAgentPlaybookEvidenceReceipt,
  type AxAgentPlaybookEvidenceWarning,
  type AxAgentPlaybookEvidenceWarningCode,
  AxAgentPlaybookEvolveError,
  type AxAgentPlaybookEvolveErrorCode,
  type AxAgentPlaybookGateEntry,
  type AxAgentPlaybookGateId,
  type AxAgentPlaybookGateMode,
  type AxAgentPlaybookGateReport,
  type AxAgentPlaybookInterval,
  type AxAgentPlaybookIntervalOptions,
  type AxAgentPlaybookModelIdentity,
  type AxAgentPlaybookNomination,
  type AxAgentPlaybookOverheadMeasure,
  type AxAgentPlaybookOverheadReport,
  type AxAgentPlaybookOverheadSplit,
  type AxAgentPlaybookPromotionAuthority,
  type AxAgentPlaybookPromotionDenialCode,
  type AxAgentPlaybookPromotionRecord,
  type AxAgentPlaybookPromotionVeto,
  type AxAgentPlaybookPruneOperation,
  type AxAgentPlaybookPruneOptions,
  type AxAgentPlaybookPruneProposal,
  type AxAgentPlaybookPruneTrigger,
  type AxAgentPlaybookReachBasis,
  type AxAgentPlaybookReachObservation,
  type AxAgentPlaybookReachProbe,
  type AxAgentPlaybookReachReport,
  type AxAgentPlaybookReachSplit,
  type AxAgentPlaybookRedundancyEntry,
  type AxAgentPlaybookRedundancyReport,
  type AxAgentPlaybookSealedTestReport,
  type AxAgentPlaybookSplitName,
  type AxAgentPlaybookSplitScore,
  type AxAgentPlaybookTerminationReport,
  type AxAgentPlaybookTerminationSplit,
  type AxAgentPlaybookTokensBasis,
  type AxAgentPlaybookTransferCell,
  type AxAgentPlaybookTransferOptions,
  type AxAgentPlaybookTransferReport,
  type AxAgentPlaybookTransferTarget,
  type AxAgentPlaybookUsageTap,
  type AxAgentPlaybookValidityOptions,
  type AxAgentPlaybookValidityPredicate,
  type AxAgentPlaybookValidityPredicateId,
  type AxAgentPlaybookValidityReport,
  type AxAgentPlaybookVarianceBand,
  type AxAgentPlaybookVarianceBandOptions,
  type AxAgentPlaybookVarianceBandReport,
  type AxAgentPlaybookVetoResult,
  type AxAgentTrajectoryClassifier,
  type AxAgentTrajectoryTermination,
  type AxAgentTrajectoryTerminationKind,
  axIsAgentPlaybookEvolveError,
} from './agent/agentInternal/playbookEvolve/playbookEvidenceTypes.js';
import type {
  AxAgentPlaybookEvolveOptions,
  AxAgentPlaybookEvolveOutcome,
  AxAgentPlaybookEvolveProgressEvent,
  AxAgentPlaybookEvolveProposal,
  AxAgentPlaybookEvolveResult,
  AxAgentPlaybookEvolveRunRecord,
  AxAgentPlaybookRetentionAnchor,
  AxAgentPlaybookRetentionPolicy,
  AxAgentPlaybookRetentionReceipt,
  AxAgentPlaybookRetentionSlice,
  AxAgentPlaybookWeakness,
} from './agent/agentInternal/playbookEvolve/playbookEvolveTypes.js';
import { axClassifyAxServiceTermination } from './agent/agentInternal/playbookEvolve/termination.js';
import type {
  AxModuleRankInput,
  AxRankableDocument,
  AxRankableField,
  AxRankDocumentsOptions,
  AxRankedDocument,
  AxRankedModule,
  AxRankModulesOptions,
  AxRelevanceHints,
} from './agent/agentInternal/relevanceRanker.js';
import {
  AxAgentSharedRuntimeSession,
  type AxEvidenceDescriptor,
  type AxSharedSessionPhase,
} from './agent/agentInternal/sharedSession.js';
import type {
  AxAgentCatalogSkill,
  AxAgentSkillResult,
  AxAgentSkillsSearchFn,
  AxAgentUsedSkill,
  AxAgentUsedSkillsCallback,
} from './agent/agentInternal/skillsTypes.js';
import type {
  AxAgentStagePolicy,
  AxAgentStageVariant,
} from './agent/agentInternal/stagePolicy.js';
import type {
  AxAgentContextEvent,
  AxAgentContextPressure,
  AxAgentContextStage,
  AxAgentOnContextEvent,
} from './agent/agentInternal/types.js';
import type {
  AxAgentRecursiveExpensiveNode,
  AxAgentRecursiveFunctionCall,
  AxAgentRecursiveNodeRole,
  AxAgentRecursiveStats,
  AxAgentRecursiveTargetId,
  AxAgentRecursiveTraceNode,
  AxAgentRecursiveTurn,
  AxAgentRecursiveUsage,
} from './agent/agentRecursiveOptimize.js';
import {
  AxContextMetricsCollector,
  type AxContextMetricsRow,
  type AxContextMetricsSummary,
  type AxContextTurnSample,
} from './agent/benchmarks/contextMetrics.js';
import type { AxContextScenario } from './agent/benchmarks/contextScenarios.js';
import {
  type AxAgentGuidancePayload,
  AxAgentProtocolCompletionSignal,
} from './agent/completion.js';
import type {
  AxAgentAutoUpgrade,
  AxAgentCitations,
  AxAgentCitationsOutput,
  AxAgentDirectResponse,
  AxResolvedAutoUpgrade,
  AxResolvedCitations,
} from './agent/config.js';
import {
  type AxExecutableSkillArtifact,
  type AxExecutableSkillAuthority,
  type AxExecutableSkillContext,
  type AxExecutableSkillExclusionReason,
  type AxExecutableSkillInspection,
  type AxExecutableSkillLifecycle,
  type AxExecutableSkillRef,
  type AxExecutableSkillRequirements,
  type AxExecutableSkillSelection,
  type AxExecutableSkillVerification,
  type AxExecutableSkillVerificationReceipt,
  type AxSelectExecutableSkillsOptions,
  type AxSelectedExecutableSkill,
  axExecutableSkillRef,
  axSelectExecutableSkills,
} from './agent/executableSkills.js';
import type { AxAgentMetricsInstruments } from './agent/metrics.js';
import type {
  AxAgentPlaybookConfig,
  AxAgentPlaybookLearnOptions,
  AxAgentPlaybookSkipReason,
  AxAgentPlaybookUpdateResult,
  AxAgentPlaybookUpdateStatus,
  AxResolvedAgentPlaybookConfig,
  AxResolvedAgentPlaybookLearn,
} from './agent/playbookConfig.js';
import {
  type AxPreferenceApplicability,
  type AxPreferenceEvidenceAssertion,
  type AxPreferenceEvidenceClaim,
  type AxPreferenceEvidenceContext,
  type AxPreferenceEvidenceErasure,
  type AxPreferenceEvidenceExclusion,
  type AxPreferenceEvidenceExclusionReason,
  type AxPreferenceEvidenceKind,
  type AxPreferenceEvidenceOperation,
  type AxPreferenceEvidenceReceiptPurpose,
  type AxPreferenceEvidenceReceiptRequest,
  type AxPreferenceEvidenceRecord,
  type AxPreferenceEvidenceRenewal,
  type AxPreferenceEvidenceRetraction,
  type AxPreferenceEvidenceRevision,
  type AxPreferenceEvidenceSelection,
  type AxPreferenceEvidenceStreamBinding,
  type AxPreferenceEvidenceStreamRequest,
  type AxSelectedPreferenceEvidence,
  axErasePreferenceEvidence,
  axPreferenceEvidenceLimits,
  axPreferenceEvidenceToMemories,
  axRenewPreferenceEvidence,
  axRetractPreferenceEvidence,
  axSelectPreferenceEvidence,
} from './agent/preferenceEvidence.js';
import {
  AxAgentSessionAuthorizationError,
  AxAgentSessionClient,
  AxAgentSessionConflictError,
  type AxAgentSessionEvent,
  type AxAgentSessionFactoryContext,
  type AxAgentSessionFunctionOptions,
  type AxAgentSessionHandle,
  AxAgentSessionHost,
  type AxAgentSessionHostOptions,
  type AxAgentSessionJob,
  AxAgentSessionLimitError,
  type AxAgentSessionLimits,
  type AxAgentSessionMessage,
  type AxAgentSessionMessageMode,
  type AxAgentSessionMessageStatus,
  AxAgentSessionNotFoundError,
  type AxAgentSessionRecord,
  type AxAgentSessionRegistration,
  type AxAgentSessionRegistrySnapshot,
  type AxAgentSessionRestoreOptions,
  AxAgentSessionResultNotReadyError,
  type AxAgentSessionRootOptions,
  type AxAgentSessionRootRecord,
  type AxAgentSessionRootView,
  type AxAgentSessionScheduler,
  type AxAgentSessionSendReceipt,
  AxAgentSessionSerializationError,
  AxAgentSessionStaleHandleError,
  type AxAgentSessionStatus,
  type AxAgentSessionStatusView,
  type AxAgentSessionStore,
  type AxAgentSessionUsage,
  AxInMemoryAgentSessionScheduler,
  AxInMemoryAgentSessionStore,
  type AxRetainedAgent,
} from './agent/retainedSessions.js';
import {
  type AxCodeRuntime,
  type AxCodeSession,
  type AxCodeSessionSnapshot,
  type AxCodeSessionSnapshotEntry,
  type AxContextPolicyBudget,
  type AxContextPolicyConfig,
  type AxContextPolicyPreset,
  type AxRLMConfig,
  type AxRuntimeCallableFormatArgs,
  type AxRuntimeLanguageInfo,
  type AxRuntimePrimitiveOverrideMap,
  axBuildDistillerDefinition,
  axBuildExecutorDefinition,
  axBuildResponderDefinition,
} from './agent/rlm.js';
import {
  type AxIRRuntimeCapabilities,
  type AxIRRuntimeCapabilitiesInput,
  type AxRuntimeAdmissionEvidence,
  type AxRuntimeAdmissionReceipt,
  type AxRuntimeAuthority,
  type AxRuntimeCapabilities,
  type AxRuntimeCapabilitiesV1,
  type AxRuntimeCapabilityContradictionReport,
  type AxRuntimeCapabilityExtensions,
  type AxRuntimeCapabilityObservations,
  type AxRuntimeCapabilityRequirements,
  type AxRuntimePlatform,
  type AxRuntimePlatformAuthority,
  type AxRuntimeProtocol,
  type AxRuntimeSelection,
  type AxRuntimeTimeoutEnforcement,
  axCodeRuntimeProtocol,
  axCodeRuntimeProtocolVersion,
  axCreateRuntimeAdmissionReceipt,
  axCreateRuntimeCapabilities,
  axExtendAxIRRuntimeCapabilities,
  axNormalizeAxIRRuntimeCapabilities,
  axReportRuntimeCapabilityContradictions,
  axRuntimeCapabilitiesToAxIR,
  axRuntimeCapabilitiesVersion,
  axRuntimeCapabilityRequirementsVersion,
  axRuntimeProtocolFromToken,
  axSelectCodeRuntime,
} from './agent/runtimeCapabilities.js';
import {
  type AxRuntimePrimitive,
  type AxRuntimePrimitiveExample,
  type AxRuntimePrimitiveSignature,
  type AxRuntimePrimitiveStage,
  axRuntimePrimitives,
} from './agent/runtimePrimitives.js';
import {
  type AxStatePatch,
  type AxStatePatchApplyResult,
  type AxStatePatchInvalidCode,
  type AxStatePatchOp,
  type AxStatePatchValidation,
  axApplyStatePatch,
  axValidateStatePatch,
} from './agent/statePatch.js';
import type {
  AxSynthesizerInit,
  AxSynthesizerOptions,
  AxSynthesizerRole,
} from './agent/synthesizer.js';
import {
  type AxAgentStateWorkingState,
  AxWorkingState,
  type AxWorkingStateCheckContext,
  type AxWorkingStateChecker,
  type AxWorkingStateCheckerPolicy,
  type AxWorkingStateClassifiedOp,
  type AxWorkingStateCommitContext,
  type AxWorkingStateCommitOutcome,
  type AxWorkingStateConfig,
  AxWorkingStateConflictError,
  type AxWorkingStateDeltaClass,
  type AxWorkingStateDocument,
  AxWorkingStateError,
  type AxWorkingStateEvidenceRef,
  AxWorkingStateForbiddenPathError,
  type AxWorkingStateGoal,
  type AxWorkingStateGoalStatus,
  type AxWorkingStateGuidanceNote,
  AxWorkingStateParkBudgetError,
  type AxWorkingStateParkedDelta,
  type AxWorkingStateParkReason,
  type AxWorkingStateProposal,
  type AxWorkingStateProposer,
  type AxWorkingStateProposerInput,
  type AxWorkingStateProposerMode,
  type AxWorkingStateReceipt,
  AxWorkingStateSchemaError,
  AxWorkingStateStoreError,
  type AxWorkingStateTraceSink,
  type AxWorkingStateTraceStep,
  axIsWorkingStateError,
  axWorkingState,
  axWorkingStateFingerprint,
  axWorkingStateReceiptFingerprint,
  axWorkingStateTraceDigest,
} from './agent/workingState.js';
import {
  AxAIAnthropic,
  type AxAIAnthropicArgs,
  axAIAnthropicDefaultConfig,
  axAIAnthropicVertexDefaultConfig,
} from './ai/anthropic/api.js';
import { axModelInfoAnthropic } from './ai/anthropic/info.js';
import {
  type AxAIAnthropicChatError,
  type AxAIAnthropicChatRequest,
  type AxAIAnthropicChatRequestCacheParam,
  type AxAIAnthropicChatResponse,
  type AxAIAnthropicChatResponseDelta,
  type AxAIAnthropicConfig,
  type AxAIAnthropicContentBlockDeltaEvent,
  type AxAIAnthropicContentBlockStartEvent,
  type AxAIAnthropicContentBlockStopEvent,
  type AxAIAnthropicEffortLevel,
  type AxAIAnthropicEffortLevelMapping,
  type AxAIAnthropicErrorEvent,
  type AxAIAnthropicFunctionTool,
  type AxAIAnthropicMessageDeltaEvent,
  type AxAIAnthropicMessageStartEvent,
  type AxAIAnthropicMessageStopEvent,
  AxAIAnthropicModel,
  type AxAIAnthropicOutputConfig,
  type AxAIAnthropicPingEvent,
  type AxAIAnthropicRequestTool,
  type AxAIAnthropicStopDetails,
  type AxAIAnthropicTaskBudget,
  type AxAIAnthropicThinkingConfig,
  type AxAIAnthropicThinkingTokenBudgetLevels,
  type AxAIAnthropicThinkingWire,
  AxAIAnthropicVertexModel,
  type AxAIAnthropicWebSearchTool,
} from './ai/anthropic/types.js';
import {
  axAudioInputFilename,
  axAudioInputToBlob,
  axFetchJsonSpeech,
  axFetchMultipartTranscription,
  axNormalizeTranscriptionResponse,
} from './ai/audio/api.js';
import {
  axGoogleGeminiLiveAudioDefaults,
  axIsAudioOutputEnabled,
  axMergeChatAudioConfig,
  axOpenAIChatAudioDefaults,
} from './ai/audio/defaults.js';
import type {
  AxAudioFormat,
  AxAudioInput,
  AxChatAudioConfig,
  AxChatAudioOutput,
  AxSpeechConfig,
  AxSpeechRequest,
  AxSpeechResponse,
  AxTranscriptionRequest,
  AxTranscriptionResponse,
  AxTranscriptionSegment,
} from './ai/audio/types.js';
import {
  axAudioFormatFromMimeType,
  axAudioMimeType,
  axConcatBase64,
} from './ai/audio/util.js';
import { AxBalancer, type AxBalancerOptions } from './ai/balance.js';
import {
  type AxBalancerAdaptiveStrategy,
  type AxBalancerCandidateScore,
  type AxBalancerCostContext,
  type AxBalancerExpectedTokens,
  type AxBalancerFailureReason,
  type AxBalancerRouteStats,
  type AxBalancerRoutingContext,
  type AxBalancerRoutingEvent,
  type AxBalancerStatsKey,
  type AxBalancerStatsObservation,
  type AxBalancerStatsStore,
  AxInMemoryBalancerStatsStore,
  axUpdateBalancerRouteStats,
} from './ai/balance_adaptive.js';
import {
  type AxAIFeatures,
  AxBaseAI,
  type AxBaseAIArgs,
  axBaseAIDefaultConfig,
  axBaseAIDefaultCreativeConfig,
} from './ai/base.js';
import {
  axAnalyzeRequestRequirements,
  axGetCompatibilityReport,
  axGetFormatCompatibility,
  axGetProvidersWithMediaSupport,
  axScoreProvidersForRequest,
  axSelectOptimalProvider,
  axValidateProviderCapabilities,
} from './ai/capabilities.js';
import {
  type AxAIModelCatalogAudioSupport,
  type AxAIModelCatalogFilter,
  type AxAIModelCatalogModel,
  type AxAIModelCatalogModelCapabilities,
  type AxAIModelCatalogModelType,
  type AxAIModelCatalogOptions,
  type AxAIModelCatalogProvider,
  type AxAIModelCatalogProviderCapabilities,
  type AxAIModelCatalogProviderName,
  type AxAIModelCatalogThinkingLevel,
  axGetSupportedAIModels,
} from './ai/catalog.js';
import { axModelInfoCohere } from './ai/cohere/info.js';
import { AxAICohereEmbedModel, AxAICohereModel } from './ai/cohere/types.js';
import { axModelInfoDeepSeek } from './ai/deepseek/info.js';
import { AxAIDeepSeekModel } from './ai/deepseek/types.js';
import {
  AxAIGoogleGemini,
  type AxAIGoogleGeminiArgs,
  type AxAIGoogleGeminiOptionsTools,
  axAIGoogleGeminiDefaultConfig,
  axAIGoogleGeminiDefaultCreativeConfig,
  axAIGoogleGeminiLiveAudioDefaultConfig,
} from './ai/google-gemini/api.js';
import { axModelInfoGoogleGemini } from './ai/google-gemini/info.js';
import {
  axCreateGeminiLiveAudioApi,
  axIsGeminiLiveAudioModel,
  axMapGeminiLiveAudioPart,
  axResolveGeminiLiveAudioConfig,
  axShouldUseGeminiLiveAudio,
  axValidateGeminiLiveAudioInput,
} from './ai/google-gemini/live_audio.js';
import {
  type AxAIGoogleGeminiBatchEmbedRequest,
  type AxAIGoogleGeminiBatchEmbedResponse,
  type AxAIGoogleGeminiCacheCreateRequest,
  type AxAIGoogleGeminiCacheResponse,
  type AxAIGoogleGeminiCacheUpdateRequest,
  type AxAIGoogleGeminiChatRequest,
  type AxAIGoogleGeminiChatResponse,
  type AxAIGoogleGeminiChatResponseDelta,
  type AxAIGoogleGeminiConfig,
  type AxAIGoogleGeminiContent,
  type AxAIGoogleGeminiContentPart,
  AxAIGoogleGeminiEmbedModel,
  AxAIGoogleGeminiEmbedTypes,
  type AxAIGoogleGeminiGenerationConfig,
  AxAIGoogleGeminiModel,
  type AxAIGoogleGeminiRetrievalConfig,
  AxAIGoogleGeminiSafetyCategory,
  type AxAIGoogleGeminiSafetySettings,
  AxAIGoogleGeminiSafetyThreshold,
  type AxAIGoogleGeminiThinkingConfig,
  type AxAIGoogleGeminiThinkingLevel,
  type AxAIGoogleGeminiThinkingLevelMapping,
  type AxAIGoogleGeminiThinkingTokenBudgetLevels,
  type AxAIGoogleGeminiTool,
  type AxAIGoogleGeminiToolConfig,
  type AxAIGoogleGeminiToolFunctionDeclaration,
  type AxAIGoogleGeminiToolGoogleMaps,
  type AxAIGoogleGeminiToolGoogleSearchRetrieval,
  type AxAIGoogleVertexBatchEmbedRequest,
  type AxAIGoogleVertexBatchEmbedResponse,
} from './ai/google-gemini/types.js';
import type { AxAIMetricsInstruments } from './ai/metrics.js';
import { axModelInfoMistral } from './ai/mistral/info.js';
import {
  AxAIMistralEmbedModels,
  AxAIMistralModel,
} from './ai/mistral/types.js';
import { AxMockAIService, type AxMockAIServiceConfig } from './ai/mock/api.js';
import { AxMultiServiceRouter } from './ai/multiservice.js';
import {
  AxAIOpenAI,
  type AxAIOpenAIArgs,
  AxAIOpenAIBase,
  type AxAIOpenAIBaseArgs,
  type AxOpenAIReasoningContentMode,
  axAIOpenAIAudioDefaultConfig,
  axAIOpenAIBestConfig,
  axAIOpenAICreativeConfig,
  axAIOpenAIDefaultConfig,
  axAIOpenAIFastConfig,
  axAIOpenAIRealtimeDefaultConfig,
  axAIOpenAIRealtimeTranscriptionDefaultConfig,
} from './ai/openai/api.js';
import {
  axApplyOpenAIChatAudioRequest,
  axIsOpenAIChatAudioModel,
  axMapOpenAIChatAudioDelta,
  axMapOpenAIChatAudioResponse,
  axMapOpenAIInputAudioPart,
  axResolveOpenAIChatAudioConfig,
} from './ai/openai/audio.js';
import {
  type AxAIOpenAIAnnotation,
  type AxAIOpenAIChatContentPart,
  type AxAIOpenAIChatRequest,
  type AxAIOpenAIChatResponse,
  type AxAIOpenAIChatResponseDelta,
  type AxAIOpenAIConfig,
  AxAIOpenAIEmbedModel,
  type AxAIOpenAIEmbedRequest,
  type AxAIOpenAIEmbedResponse,
  type AxAIOpenAILogprob,
  AxAIOpenAIModel,
  type AxAIOpenAIPromptCacheBreakpoint,
  type AxAIOpenAIResponseDelta,
  type AxAIOpenAIUrlCitation,
  type AxAIOpenAIUsage,
} from './ai/openai/chat_types.js';
import {
  axModelInfoOpenAI,
  axModelInfoOpenAIResponses,
} from './ai/openai/info.js';
import {
  axCreateOpenAIRealtimeApi,
  axIsOpenAIRealtimeModel,
  axIsOpenAIRealtimeTranscriptionModel,
  axResolveOpenAIRealtimeAudioConfig,
  axShouldUseOpenAIRealtime,
} from './ai/openai/realtime.js';
import {
  AxAIOpenAIResponses,
  type AxAIOpenAIResponsesArgs,
  AxAIOpenAIResponsesBase,
  axAIOpenAIResponsesBestConfig,
  axAIOpenAIResponsesCreativeConfig,
  axAIOpenAIResponsesDefaultConfig,
} from './ai/openai/responses_api_base.js';
import {
  type AxAIOpenAIResponsesCodeInterpreterToolCall,
  type AxAIOpenAIResponsesComputerToolCall,
  type AxAIOpenAIResponsesConfig,
  type AxAIOpenAIResponsesContentPartAddedEvent,
  type AxAIOpenAIResponsesContentPartDoneEvent,
  type AxAIOpenAIResponsesDefineFunctionTool,
  type AxAIOpenAIResponsesErrorEvent,
  type AxAIOpenAIResponsesFileSearchCallCompletedEvent,
  type AxAIOpenAIResponsesFileSearchCallInProgressEvent,
  type AxAIOpenAIResponsesFileSearchCallSearchingEvent,
  type AxAIOpenAIResponsesFileSearchToolCall,
  type AxAIOpenAIResponsesFunctionCallArgumentsDeltaEvent,
  type AxAIOpenAIResponsesFunctionCallArgumentsDoneEvent,
  type AxAIOpenAIResponsesFunctionCallItem,
  type AxAIOpenAIResponsesImageGenerationCallCompletedEvent,
  type AxAIOpenAIResponsesImageGenerationCallGeneratingEvent,
  type AxAIOpenAIResponsesImageGenerationCallInProgressEvent,
  type AxAIOpenAIResponsesImageGenerationCallPartialImageEvent,
  type AxAIOpenAIResponsesImageGenerationToolCall,
  type AxAIOpenAIResponsesInputAudioContentPart,
  type AxAIOpenAIResponsesInputContentPart,
  type AxAIOpenAIResponsesInputFileContentPart,
  type AxAIOpenAIResponsesInputFunctionCallItem,
  type AxAIOpenAIResponsesInputFunctionCallOutputItem,
  type AxAIOpenAIResponsesInputImageUrlContentPart,
  type AxAIOpenAIResponsesInputItem,
  type AxAIOpenAIResponsesInputMessageItem,
  type AxAIOpenAIResponsesInputReasoningItem,
  type AxAIOpenAIResponsesInputTextContentPart,
  type AxAIOpenAIResponsesLocalShellToolCall,
  type AxAIOpenAIResponsesMCPCallArgumentsDeltaEvent,
  type AxAIOpenAIResponsesMCPCallArgumentsDoneEvent,
  type AxAIOpenAIResponsesMCPCallCompletedEvent,
  type AxAIOpenAIResponsesMCPCallFailedEvent,
  type AxAIOpenAIResponsesMCPCallInProgressEvent,
  type AxAIOpenAIResponsesMCPListToolsCompletedEvent,
  type AxAIOpenAIResponsesMCPListToolsFailedEvent,
  type AxAIOpenAIResponsesMCPListToolsInProgressEvent,
  type AxAIOpenAIResponsesMCPToolCall,
  AxAIOpenAIResponsesModel,
  type AxAIOpenAIResponsesOutputItem,
  type AxAIOpenAIResponsesOutputItemAddedEvent,
  type AxAIOpenAIResponsesOutputItemDoneEvent,
  type AxAIOpenAIResponsesOutputMessageItem,
  type AxAIOpenAIResponsesOutputRefusalContentPart,
  type AxAIOpenAIResponsesOutputTextAnnotationAddedEvent,
  type AxAIOpenAIResponsesOutputTextContentPart,
  type AxAIOpenAIResponsesOutputTextDeltaEvent,
  type AxAIOpenAIResponsesOutputTextDoneEvent,
  type AxAIOpenAIResponsesReasoningDeltaEvent,
  type AxAIOpenAIResponsesReasoningDoneEvent,
  type AxAIOpenAIResponsesReasoningItem,
  type AxAIOpenAIResponsesReasoningSummaryDeltaEvent,
  type AxAIOpenAIResponsesReasoningSummaryDoneEvent,
  type AxAIOpenAIResponsesReasoningSummaryPart,
  type AxAIOpenAIResponsesReasoningSummaryPartAddedEvent,
  type AxAIOpenAIResponsesReasoningSummaryPartDoneEvent,
  type AxAIOpenAIResponsesReasoningSummaryTextDeltaEvent,
  type AxAIOpenAIResponsesReasoningSummaryTextDoneEvent,
  type AxAIOpenAIResponsesReasoningTextDeltaEvent,
  type AxAIOpenAIResponsesReasoningTextDoneEvent,
  type AxAIOpenAIResponsesRefusalDeltaEvent,
  type AxAIOpenAIResponsesRefusalDoneEvent,
  type AxAIOpenAIResponsesRequest,
  type AxAIOpenAIResponsesResponse,
  type AxAIOpenAIResponsesResponseCompletedEvent,
  type AxAIOpenAIResponsesResponseCreatedEvent,
  type AxAIOpenAIResponsesResponseFailedEvent,
  type AxAIOpenAIResponsesResponseIncompleteEvent,
  type AxAIOpenAIResponsesResponseInProgressEvent,
  type AxAIOpenAIResponsesResponseQueuedEvent,
  type AxAIOpenAIResponsesStreamEvent,
  type AxAIOpenAIResponsesStreamEventBase,
  type AxAIOpenAIResponsesToolCall,
  type AxAIOpenAIResponsesToolCallBase,
  type AxAIOpenAIResponsesToolChoice,
  type AxAIOpenAIResponsesToolDefinition,
  type AxAIOpenAIResponsesWebSearchCallCompletedEvent,
  type AxAIOpenAIResponsesWebSearchCallInProgressEvent,
  type AxAIOpenAIResponsesWebSearchCallSearchingEvent,
  type AxAIOpenAIResponsesWebSearchToolCall,
} from './ai/openai/responses_types.js';
import { axNormalizeOpenAIUsage } from './ai/openai/usage.js';
import {
  axAnalyzeChatPromptRequirements,
  axProcessContentForProvider,
} from './ai/processor.js';
import type { AxPromptMetrics } from './ai/promptMetrics.js';
import {
  axAIProviderAliases,
  axAIProviderProfileIds,
  axAIProviderProfiles,
} from './ai/provider_profiles.generated.js';
import {
  type AxAIDeploymentProfileArgs,
  type AxAIDeploymentProfileId,
  AxAIOpenAIProfile,
  type AxAIOpenAIProfileArgs,
  AxAIOpenAIResponsesProfile,
  type AxAIProfileArgs,
  type AxAIProfileAuthentication,
  type AxAIProfileCapabilities,
  type AxAIProfileEndpoint,
  type AxAIProfileId,
  type AxAIProfileModelRule,
  type AxAIProfileOperation,
  type AxAIProfileRequestRules,
  type AxAIProfileSummary,
  type AxAIProfileTransport,
  axAIProfiles,
  axGetAIProfile,
  axResolveAIProfileFeatures,
  axResolveAIProfileId,
} from './ai/provider_profiles.js';
import { axModelInfoReka } from './ai/reka/info.js';
import { AxAIRekaModel } from './ai/reka/types.js';
import {
  type AxContentProcessingServices,
  type AxMultiProviderConfig,
  AxProviderRouter,
  type AxRoutingResult,
} from './ai/router.js';
import {
  type AxServiceTierMap,
  axNormalizeAppliedServiceTier,
  axNormalizeRequestedServiceTier,
  axResolveServiceTier,
} from './ai/service_tier.js';
import type {
  AxAgentCompletionProtocol,
  AxAICredentialProvider,
  AxAICredentialRequest,
  AxAIInputModelList,
  AxAIModelList,
  AxAIModelListBase,
  AxAIService,
  AxAIServiceImpl,
  AxAIServiceMetrics,
  AxAIServiceOptions,
  AxAppliedServiceTier,
  AxChatRequest,
  AxChatResponse,
  AxChatResponseResult,
  AxCitation,
  AxContextCacheInfo,
  AxContextCacheOperation,
  AxContextCacheOptions,
  AxContextCacheRegistry,
  AxContextCacheRegistryEntry,
  AxDebugChatResponseUsage,
  AxEmbedRequest,
  AxEmbedResponse,
  AxFunction,
  AxFunctionHandler,
  AxFunctionJSONSchema,
  AxFunctionResult,
  AxFunctionResultContent,
  AxLoggerData,
  AxLoggerFunction,
  AxModelConfig,
  AxModelInfo,
  AxModelInfoWithProvider,
  AxModelUsage,
  AxProviderMetadata,
  AxRateLimiterFunction,
  AxRateLimitInfo,
  AxRuntimeHooks,
  AxServiceTier,
  AxServiceTierPricing,
  AxStructuredOutputMode,
  AxStructuredOutputRung,
  AxThoughtBlockItem,
  AxTokenUsage,
  AxUsageContext,
  AxUsageEvent,
  AxUsageObserver,
} from './ai/types.js';
import { axEmitUsageEvent, axMergeUsageContexts } from './ai/usage.js';
import {
  axValidateChatRequestMessage,
  axValidateChatResponseResult,
} from './ai/validate.js';
import {
  AxFrameSampler,
  axFrameSampler,
  axVisualPerceptualDigest,
} from './ai/visual/sampler.js';
import type {
  AxFrameSamplerBudget,
  AxFrameSamplerDecision,
  AxFrameSamplerOptions,
  AxFrameSamplerReason,
  AxVisualAuthority,
  AxVisualChangeDigest,
  AxVisualObservation,
  AxVisualPerceptualInput,
} from './ai/visual/types.js';
import {
  AxAIWebLLM,
  type AxAIWebLLMArgs,
  axAIWebLLMCreativeConfig,
  axAIWebLLMDefaultConfig,
} from './ai/webllm/api.js';
import { axModelInfoWebLLM } from './ai/webllm/info.js';
import {
  type AxAIWebLLMChatRequest,
  type AxAIWebLLMChatResponse,
  type AxAIWebLLMChatResponseDelta,
  type AxAIWebLLMConfig,
  type AxAIWebLLMEmbedModel,
  type AxAIWebLLMEmbedRequest,
  type AxAIWebLLMEmbedResponse,
  type AxAIWebLLMEngine,
  AxAIWebLLMModel,
  type AxAIWebLLMModelId,
} from './ai/webllm/types.js';
import {
  AxAI,
  type AxAIArgs,
  type AxAIEmbedModels,
  type AxAIModels,
  ai,
} from './ai/wrap.js';
import {
  axAIGrokBestConfig,
  axAIGrokDefaultConfig,
  axAIGrokVoiceDefaultConfig,
  axCreateGrokRealtimeApi,
  axIsGrokVoiceModel,
  axResolveGrokRealtimeAudioConfig,
  axShouldUseGrokRealtime,
} from './ai/x-grok/api.js';
import { axModelInfoGrok } from './ai/x-grok/info.js';
import { AxAIGrokEmbedModels, AxAIGrokModel } from './ai/x-grok/types.js';
import {
  AxAuthorizationDeniedError,
  axAttenuateAuthority,
  axAuthorityClaim,
  axAuthorize,
  axFunctionAuthorityTarget,
  axSnapshotAuthority,
  axValidateCapabilityGrant,
} from './authority/authority.js';
import {
  axCollectGrantRequirements,
  axEvaluateGuards,
  axIsEvidenceRequirement,
  axIsGuardPredicateFailure,
} from './authority/evidence.js';
import {
  type AxSkillAuthoritySnapshot,
  type AxSkillPreconditionCheck,
  type AxSkillPreconditionFailure,
  type AxSkillPreconditionFailureKind,
  type AxSkillPreconditionOutcome,
  type AxSkillPreconditionPolicy,
  type AxSkillProvenance,
  type AxSkillProvenanceAuthorization,
  type AxSkillProvenanceEffectRef,
  type AxSkillProvenanceSource,
  type AxSkillVerifierDecision,
  type AxSkillVerifierVerdict,
  axExtractSkillProvenance,
  axIsSkillAuthoritySnapshot,
  axIsSkillPreconditionPolicy,
  axIsSkillProvenance,
  axRecheckSkillProvenance,
  axSkillAdvisoryAnnotation,
  axSkillPreconditionExecutableDefaults,
  axSkillPreconditionGuidanceDefaults,
  axSkillProvenanceDigest,
} from './authority/skillProvenance.js';
import type {
  AxActor,
  AxAuthorityClaim,
  AxAuthorityContext,
  AxAuthorityDelegationOptions,
  AxAuthorityInheritance,
  AxAuthorityValue,
  AxAuthorizationAuditEvent,
  AxAuthorizationReceipt,
  AxAuthorizationRequestContext,
  AxAuthorizer,
  AxCapabilityGrant,
  AxDelegationClaims,
  AxEvidenceMatch,
  AxEvidenceObservation,
  AxEvidenceRequirement,
  AxGuardEvaluation,
  AxGuardEvaluationContext,
  AxGuardFailure,
  AxGuardFailureCode,
  AxGuardOp,
  AxPrincipal,
  AxResourceScope,
} from './authority/types.js';
import {
  type AxAssertion,
  AxAssertionError,
  type AxStreamingAssertion,
  AxStreamingAssertionError,
} from './dsp/asserts.js';
import type {
  AxCheckpointLoadFn,
  AxCheckpointSaveFn,
  AxCompileOptions,
  AxCostTracker,
  AxCostTrackerOptions,
  AxGEPABootstrapOptions,
  AxMetricFn,
  AxMetricFnArgs,
  AxMetricResult,
  AxMultiMetricFn,
  AxOptimizationCheckpoint,
  AxOptimizationProgress,
  AxOptimizationStats,
  AxOptimizerArgs,
  AxTypedExample,
} from './dsp/common_types.js';
import type { AxDateRange } from './dsp/datetime.js';
import { AxEvalUtil } from './dsp/eval.js';
import { type AxEvaluateArgs, AxTestPrompt } from './dsp/evaluate.js';
import type {
  AxFieldProcessor,
  AxFieldProcessorProcess,
  AxStreamingFieldProcessorProcess,
} from './dsp/fieldProcessor.js';
import {
  type AxChatResponseFunctionCall,
  AxFunctionError,
  AxFunctionProcessor,
  type AxInputFunctionType,
  AxStopFunctionCallException,
} from './dsp/functions.js';
import {
  AxGen,
  AxGenerateError,
  type AxGenerateErrorDetails,
  type AxGenerateResult,
  type AxStreamingEvent,
} from './dsp/generate.js';
import { type AxFunctionResultFormatter, axGlobals } from './dsp/globals.js';
import type {
  AxJudgeForwardOptions,
  AxJudgeOptions,
} from './dsp/judgeTypes.js';
import {
  axCreateDefaultColorLogger,
  axCreateDefaultTextLogger,
} from './dsp/loggers.js';
import {
  type AxErrorCategory,
  type AxGenMetricsInstruments,
  type AxMetricsConfig,
  axCheckMetricsHealth,
  axDefaultMetricsConfig,
  axGetMetricsConfig,
  axUpdateMetricsConfig,
} from './dsp/metrics.js';
import {
  type AxOptimizableComponent,
  type AxOptimizableValidator,
  axOptimizableValidators,
} from './dsp/optimizable.js';
import { type AxOptimizeOptions, optimize } from './dsp/optimize.js';
import {
  AxBaseOptimizer,
  type AxBootstrapOptimizerOptions,
  AxDefaultCostTracker,
  type AxOptimizedProgram,
  AxOptimizedProgramImpl,
  type AxOptimizer,
  type AxOptimizerMetricsConfig,
  type AxOptimizerMetricsInstruments,
  type AxOptimizerResult,
  type AxParetoResult,
  type AxSerializedOptimizedProgram,
  axAttachCausalCandidateEvidence,
  axDefaultOptimizerMetricsConfig,
  axDeserializeOptimizedProgram,
  axGetOptimizerMetricsConfig,
  axReplaceOptimizedProgramSnapshot,
  axSerializeOptimizedProgram,
  axUpdateOptimizerMetricsConfig,
} from './dsp/optimizer.js';
import {
  axCreateDefaultOptimizerColorLogger,
  axCreateDefaultOptimizerTextLogger,
  axDefaultOptimizerLogger,
} from './dsp/optimizerLogging.js';
import {
  AxACE,
  AxACEOptimizedProgram,
  type AxACEResult,
} from './dsp/optimizers/ace.js';
import {
  type AxACEBulletChange,
  type AxACEPlaybookRenderOptions,
  axProjectActorPlaybook,
  axRedactPlaybookForModel,
  axRenderActorPlaybook,
} from './dsp/optimizers/acePlaybook.js';
import type {
  AxACEActorPlaybookView,
  AxACEApplicability,
  AxACEBullet,
  AxACEBulletEvidence,
  AxACEBulletLifecycle,
  AxACEBulletVisibility,
  AxACECuratorOperation,
  AxACECuratorOperationType,
  AxACECuratorOutput,
  AxACEFeedbackEvent,
  AxACEGeneratorOutput,
  AxACEHostEvidence,
  AxACEOptimizationArtifact,
  AxACEOptions,
  AxACEPlaybook,
  AxACEPreconditionDecision,
  AxACEProvenance,
  AxACEReflectionOutput,
  AxACEVerificationResult,
} from './dsp/optimizers/aceTypes.js';
import type { AxRolloutTrace } from './dsp/optimizers/axGenAdapter.js';
import { AxBootstrapFewShot } from './dsp/optimizers/bootstrapFewshot.js';
import {
  type AxCandidateEffectDeclaration,
  AxCandidateEffectManifestError,
  type AxCandidateEffectPolicy,
  axDeclaresToolCapability,
  axIsCandidateEffectManifestError,
  axValidateCandidateEffectDeclaration,
} from './dsp/optimizers/candidateEffectManifest.js';
import {
  type AxCausalAffectedComponent,
  type AxCausalCandidateAblation,
  type AxCausalCandidateEvidenceManifest,
  type AxCausalCandidateEvidenceOptions,
  type AxCausalCandidateEvidenceRecord,
  type AxCausalCandidateSplitOutcome,
  type AxCausalEvidenceAuthority,
  type AxCausalEvidenceAuthorityVerifier,
  type AxCausalEvidenceKind,
  type AxCausalEvidenceReceipt,
  type AxCausalEvidenceReference,
  type AxCausalMetricOutcome,
  type AxCausalMetricPrediction,
  axCanonicalizeCausalCandidateEvidenceManifest,
  axCloneCausalCandidateEvidenceManifest,
  axCreateCausalCandidateEvidenceManifest,
  axFingerprintCausalEvidence,
} from './dsp/optimizers/causalCandidateEvidence.js';
import {
  type AxDigestStrength,
  AxDigestStrengthError,
  type AxFnv1a64Digest,
  type AxSha256Digest,
  type AxSha256Digest64,
  axAssertDigestStrength,
  axCompareCodeUnits,
  axDigestStrength,
  axFnv1a64Digest,
  axIsDigestStrengthError,
  axIsFnv1a64Digest,
  axIsSha256Digest,
  axIsSha256Digest64,
  axSha256Digest,
  axSha256Digest64Sync,
} from './dsp/optimizers/digests.js';
import {
  AxGEPA,
  type AxGEPAOptimizationReport,
} from './dsp/optimizers/gepa.js';
import type {
  AxGEPAAdapter,
  AxGEPAEvaluationBatch,
} from './dsp/optimizers/gepaAdapter.js';
import type { AxGEPAComponentTarget } from './dsp/optimizers/gepaComponents.js';
import type {
  AxGEPABatchEvaluation,
  AxGEPABatchRow,
  AxGEPAEvaluationState,
} from './dsp/optimizers/gepaEvaluation.js';
import type {
  AxGEPACandidateComponentDelta,
  AxGEPACandidateDecision,
  AxGEPACandidateDisposition,
  AxGEPACandidateEvaluation,
  AxGEPACandidateFailure,
  AxGEPACandidateLineageManifest,
  AxGEPACandidateLineageOptions,
  AxGEPACandidateLineageRecord,
  AxGEPACandidateStrategy,
  AxGEPAResolvedLineageOptions,
} from './dsp/optimizers/gepaLineage.js';
import type {
  AxGEPAOptimizationReference,
  AxGEPAProposalOptions,
  AxGEPAProposalPolicy,
  AxGEPAProposalPolicyArgs,
  AxGEPAReflectiveTuple,
  AxGEPATraceSummary,
  AxGEPATraceSummaryCall,
} from './dsp/optimizers/gepaReflection.js';
import {
  type AxGEPAComponentBanditState,
  AxGEPAComponentSelector,
} from './dsp/optimizers/gepaSelection.js';
import {
  AxCandidateStaleError,
  type AxHarnessAtom,
  type AxHarnessPortId,
  type AxHarnessRecipe,
  AxHarnessRecipeError,
  type AxHarnessStamp,
  axAssertHarnessStampFresh,
  axHarnessPortId,
  axHarnessRecipe,
  axHarnessRecipeVersion,
  axHarnessStamp,
  axIsCandidateStaleError,
  axIsHarnessPortId,
  axIsHarnessRecipeError,
  axIsHarnessStampStale,
} from './dsp/optimizers/harnessRecipe.js';
import {
  type AxComponentClass,
  type AxMutationAnnotation,
  type AxMutationAnnotator,
  type AxMutationDepth,
  type AxMutationDepthHistogram,
  type AxMutationEffort,
  type AxMutationKindPolicy,
  type AxMutationSurface,
  AxMutationTaxonomyError,
  type AxPatchClass,
  type AxPatchTaxonomy,
  type AxPatchType,
  axBuildMutationDepthHistogram,
  axDefaultMutationAnnotator,
  axInferComponentClass,
  axIsMutationTaxonomyError,
  axKnownComponentKinds,
  axPatchClassOfType,
  axValidateMutationAnnotation,
} from './dsp/optimizers/mutationTaxonomy.js';
import {
  type AxGEPARejectedPriorBlock,
  AxInMemoryRejectedCandidateLedger,
  type AxRejectedCandidateDelta,
  type AxRejectedCandidateExpiry,
  type AxRejectedCandidateExpiryContext,
  type AxRejectedCandidateGateReading,
  type AxRejectedCandidateLedgerCapabilities,
  type AxRejectedCandidateLedgerEntry,
  AxRejectedCandidateLedgerError,
  type AxRejectedCandidateLedgerQuery,
  type AxRejectedCandidateLedgerRef,
  type AxRejectedCandidateLedgerStore,
  axIsRejectedCandidateExpired,
  axIsRejectedCandidateLedgerError,
  axMergeRejectedCandidateLedgerRefs,
  axRejectedCandidateDigest,
  axRejectedCandidateLedgerEntry,
  axRejectedCandidatePrior,
  axRunRejectedCandidateLedgerConformance,
} from './dsp/optimizers/rejectedCandidateLedger.js';
import {
  type AxIpwEstimate,
  type AxMinibatchStrategy,
  type AxResolvedTaskDiscriminationOptions,
  AxTaskDiscriminationError,
  type AxTaskDiscriminationOptions,
  type AxTaskDiscriminationSummary,
  type AxTaskInclusion,
  type AxTaskInclusionSnapshot,
  type AxTaskStat,
  type AxTaskStatPhase,
  AxTaskStatTable,
  axComputeInclusionProbabilities,
  axCreateTaskStatTable,
  axIpwPairedDifference,
  axIpwScore,
  axIsTaskDiscriminationError,
  axResolveTaskDiscriminationOptions,
  axSampleByInclusion,
} from './dsp/optimizers/taskDiscrimination.js';
import {
  type AxEnvironmentFailureCause,
  type AxResolvedTrajectoryAdmissionOptions,
  type AxTrajectoryAdmissionOptions,
  type AxTrajectoryAdmissionReport,
  type AxTrajectoryTermination,
  type AxTrajectoryTerminationClassifier,
  type AxTrajectoryTerminationInput,
  axClassifyTrajectory,
  axDefaultTrajectoryTermination,
  axExceedsRunDiscardCeiling,
  axMergeTrajectoryAdmission,
  axPairedAdmittedIndices,
  axResolveTrajectoryAdmissionOptions,
  axSummarizeTrajectoryAdmission,
} from './dsp/optimizers/trajectoryTermination.js';
import type {
  AxOptimizerLoggerData,
  AxOptimizerLoggerFunction,
} from './dsp/optimizerTypes.js';
import {
  AxPlaybook,
  type AxPlaybookEvolveOptions,
  type AxPlaybookEvolveResult,
  type AxPlaybookOptions,
  type AxPlaybookSnapshot,
  playbook,
} from './dsp/playbook.js';
import { AxProgram } from './dsp/program.js';
import {
  AxProgramSource,
  AxProgramSourceBudgetError,
  type AxProgramSourceCapability,
  type AxProgramSourceDocument,
  AxProgramSourceError,
  type AxProgramSourceExpression,
  type AxProgramSourceLateBridgeEvent,
  type AxProgramSourceOptions,
  type AxProgramSourceRuntime,
  AxProgramSourceSessionExpiredError,
  type AxProgramSourceState,
  type AxProgramSourceStatement,
  type AxProgramSourceValueLimits,
  axProgramSourceDefaultNodeResourceLimits,
  axProgramSourceRuntimeProtocol,
  axProgramSourceVersion,
  programSource,
} from './dsp/programSource.js';
import {
  type AxFieldTemplateFn,
  AxPromptTemplate,
  type AxPromptTemplateOptions,
  type AxRenderedPrompt,
} from './dsp/prompt.js';
import {
  AxReact,
  type AxReactAssistantEvent,
  type AxReactCall,
  type AxReactEvent,
  type AxReactFailure,
  type AxReactForwardOptions,
  type AxReactHistory,
  type AxReactOptions,
  type AxReactResult,
  type AxReactSuccess,
  type AxReactTerminationReason,
  type AxReactToolEvent,
  axReactCanonicalJSON,
  axReactSerializeHistory,
  react,
} from './dsp/react.js';
import {
  type AxAttempt,
  AxBestOfN,
  type AxBestOfNOptions,
  AxRefine,
  AxRefineError,
  type AxRefineOptions,
  type AxRefineStrategy,
  type AxRewardFn,
  type AxRewardFnArgs,
  bestOfN,
  refine,
} from './dsp/refine.js';
import type { AxSamplePickerOptions } from './dsp/samples.js';
import {
  type AxDateRangeValue,
  type AxField,
  type AxFieldType,
  type AxFluentFieldInfo,
  AxFluentFieldType,
  type AxIField,
  AxSignature,
  AxSignatureBuilder,
  type AxSignatureConfig,
  type AxSignatureInput,
  f,
  fn,
} from './dsp/sig.js';
import type { AxFieldOptions } from './dsp/standardSchema.js';
import { AxStringUtil } from './dsp/strutil.js';
import {
  AxSynth,
  type AxSynthExample,
  type AxSynthOptions,
  type AxSynthResult,
} from './dsp/synth.js';
import { ax, s } from './dsp/template.js';
import type {
  AxAgentUsage,
  AxAIServiceActionOptions,
  AxAIServiceModelType,
  AxChatLogEntry,
  AxChatLogMessage,
  AxExample,
  AxExamples,
  AxFieldValue,
  AxForwardable,
  AxFunctionCallRecord,
  AxFunctionCallTrace,
  AxGenDeltaOut,
  AxGenIn,
  AxGenInput,
  AxGenOut,
  AxGenOutput,
  AxGenStreamingOut,
  AxNamedProgramInstance,
  AxProgramDemos,
  AxProgramExamples,
  AxProgramForwardOptions,
  AxProgramForwardOptionsWithModels,
  AxProgrammable,
  AxProgramOptions,
  AxProgramStreamingForwardOptions,
  AxProgramStreamingForwardOptionsWithModels,
  AxProgramTrace,
  AxProgramUsage,
  AxResultPickerFunction,
  AxResultPickerFunctionFieldResults,
  AxResultPickerFunctionFunctionResults,
  AxSelfTuningConfig,
  AxSetExamplesOptions,
  AxStepContext,
  AxStepHooks,
  AxStepUsage,
  AxTunable,
  AxUsable,
} from './dsp/types.js';
import {
  type AxEventComponentAcquisition,
  type AxEventComponentActivationContext,
  type AxEventComponentDefinition,
  type AxEventComponentDiagnostic,
  type AxEventComponentDiagnosticCode,
  type AxEventComponentDisposer,
  type AxEventComponentEffectInspection,
  type AxEventComponentInspection,
  AxEventComponentLeakError,
  AxEventComponentManager,
  type AxEventComponentManagerOptions,
  type AxEventComponentState,
  AxEventComponentTransitionError,
  type AxEventComponentTransitionOptions,
  axEventComponentManager,
} from './event/components.js';
import {
  type AxEventStoreConformanceFactory,
  type AxEventStoreConformanceFactoryOptions,
  type AxEventStoreConformanceInstance,
  type AxEventStoreConformanceReport,
  runAxEventStoreConformance,
} from './event/conformance.js';
import {
  type AxDemandAppendResult,
  AxDemandBoundary,
  type AxDemandBoundaryOptions,
  type AxDemandCalibration,
  type AxDemandDetection,
  type AxDemandDetector,
  type AxDemandDisposition,
  type AxDemandGrantState,
  type AxDemandGrantValidationContext,
  type AxDemandObservation,
  type AxDemandOutcome,
  type AxDemandPolicy,
  type AxDemandProposal,
  type AxDemandProvenance,
  type AxDemandReceipt,
  type AxDemandRecord,
  type AxDemandScope,
  type AxDemandStore,
  AxInMemoryDemandStore,
  type AxInMemoryDemandStoreOptions,
  axDemandEventObserver,
} from './event/demand.js';
import {
  AxEventRouteBuilder,
  AxEventTargetBuilder,
  eventInput,
  eventPath,
} from './event/mapping.js';
import {
  type AxMCPDefaultEventRoutesOptions,
  AxMCPEventSource,
  type AxMCPEventSourceIdentity,
  type AxMCPEventSourceOptions,
  type AxMCPResourceSubscriptionPolicy,
  axMCPEventRoutes,
} from './event/mcpSource.js';
import {
  AxInMemoryEventStore,
  type AxInMemoryEventStoreOptions,
  AxInMemoryProgramStateStore,
} from './event/memoryStore.js';
import {
  AxEventRuntime,
  eventRoute,
  eventRuntime,
  eventTarget,
} from './event/runtime.js';
import {
  AxPushEventSource,
  AxTimerEventSource,
  type AxTimerEventSourceOptions,
} from './event/sources.js';
import {
  type AxAudioFrameInteractionEvent,
  type AxControlInteractionEvent,
  type AxGeneratedMediaInteractionEvent,
  type AxInteractionEvent,
  AxInteractionTimeline,
  type AxInteractionTimelineAppendResult,
  AxInteractionTimelineDefaults,
  type AxInteractionTimelineOptions,
  type AxInteractionTimelineProjection,
  type AxInteractionTimelineProjectionOptions,
  type AxInteractionTimelineResolvedOptions,
  AxInteractionTimelineSchema,
  type AxInteractionTimelineSnapshot,
  type AxInteractionTimelineStreamState,
  AxInteractionTimelineVersion,
  type AxMediaTimeRange,
  type AxSessionTimeRange,
  type AxTemporalClassification,
  type AxTemporalEnvelope,
  AxTemporalEnvelopeSchema,
  AxTemporalValidationError,
  type AxTextInteractionEvent,
  type AxToolActivityInteractionEvent,
  type AxTranscriptInteractionEvent,
  type AxVisualObservationInteractionEvent,
} from './event/timeline.js';
import {
  AxEventBackpressureError,
  type AxEventClock,
  type AxEventCloseOptions,
  type AxEventContext,
  type AxEventContinuation,
  type AxEventContinuationEnqueueRequest,
  AxEventContinuationNotFoundError,
  type AxEventContinuationPlan,
  type AxEventContinuationRegistration,
  type AxEventCorrelationKey,
  type AxEventDeadLetter,
  type AxEventDelivery,
  type AxEventDeliveryStatus,
  type AxEventEffect,
  type AxEventEffectCreateRequest,
  type AxEventEffectFence,
  type AxEventEffectIntent,
  type AxEventEffectResolution,
  type AxEventEffectResolver,
  type AxEventEffectResolverContext,
  type AxEventEffectSettlement,
  type AxEventEffectStatus,
  type AxEventEffectStore,
  type AxEventEffectTransition,
  type AxEventEnqueueRequest,
  type AxEventEnvelope,
  type AxEventIdentity,
  type AxEventIngress,
  type AxEventInheritance,
  type AxEventInputBuilder,
  type AxEventInputDefinition,
  AxEventInputError,
  type AxEventInputFieldMapping,
  type AxEventInputPlan,
  type AxEventInvalidator,
  type AxEventMatcher,
  AxEventOutcomeUnknownError,
  AxEventOutputPersistenceError,
  type AxEventPath,
  type AxEventPathRoot,
  type AxEventPathSegment,
  type AxEventPayloadStageRequest,
  type AxEventPayloadStore,
  type AxEventProgramStateAdapter,
  type AxEventPublishReceipt,
  type AxEventRoute,
  type AxEventRouteAction,
  type AxEventRun,
  type AxEventRunStatus,
  type AxEventRuntimeOptions,
  type AxEventScalar,
  type AxEventSink,
  type AxEventSinkAttempt,
  type AxEventSinkContext,
  type AxEventSource,
  type AxEventSourceContext,
  type AxEventSourceHandle,
  type AxEventStagedPayloadStore,
  type AxEventStore,
  type AxEventStoreCapabilities,
  type AxEventTarget,
  type AxEventTargetInputContext,
  type AxEventTrust,
  type AxEventValue,
  type AxEventVerificationResult,
  type AxEventVerificationStatus,
  type AxEventVerificationUsage,
  type AxEventVerifierContext,
  type AxEventVerifierPolicy,
  type AxEventVerifierResult,
  type AxEventVerifierTransitionRecord,
  type AxEventVerifierTransitionRequest,
  AxManualEventClock,
  type AxProgramStateEnvelope,
  type AxProgramStateStore,
  AxSystemEventClock,
  axIsEventOutputPersistenceError,
} from './event/types.js';
import {
  AxUCPWebhookEventSource,
  type AxUCPWebhookEventSourceOptions,
} from './event/ucpSource.js';
import {
  axApplyEventEffectTransition,
  axEventCanonicalDigest,
  axEventCanonicalJson,
  axEventContinuationFingerprint,
  axEventEffectRequestDigest,
  axEventEffectRequestFingerprint,
  axEventErrorMessage,
  axEventId,
  axEventIdentityScope,
  axEventIngressFingerprint,
  axEventMatches,
  axEventScopedCorrelationKey,
  axEventScopedDedupeKey,
  axEventSizeBytes,
  axValidateEventEffectCreateRequest,
  axValidateEventEnvelope,
} from './event/util.js';
import type { AxFlowStateDependencyAnalysis } from './flow/dependencyAnalyzer.js';
import { AxFlow, flow } from './flow/flow.js';
import {
  type AxFlowBranchEvaluationData,
  type AxFlowCompleteData,
  type AxFlowErrorData,
  type AxFlowLogData,
  type AxFlowLoggerData,
  type AxFlowLoggerFunction,
  type AxFlowParallelGroupCompleteData,
  type AxFlowParallelGroupStartData,
  type AxFlowStartData,
  type AxFlowStepCompleteData,
  type AxFlowStepStartData,
  axCreateFlowColorLogger,
  axCreateFlowTextLogger,
  axDefaultFlowLogger,
} from './flow/logger.js';
import {
  type AxFlowMermaidBindings,
  AxFlowMermaidError,
  type AxFlowMermaidNodeBinding,
  type AxFlowMermaidRenderOptions,
} from './flow/mermaid.js';
import type { AxFlowMetricsInstruments } from './flow/metrics.js';
import type {
  AxFlowable,
  AxFlowDynamicContext,
  AxFlowExecutionPlan,
  AxFlowExecutionPlanGroup,
  AxFlowExecutionPlanStep,
  AxFlowForwardOptions,
  AxFlowOptions,
  AxFlowState,
  AxFlowTypedParallelBranch,
  AxFlowTypedSubContext,
} from './flow/types.js';
import { type AxDockerContainer, AxDockerSession } from './funcs/docker.js';
import { AxEmbeddingAdapter } from './funcs/embed.js';
import {
  AxJSRuntime,
  type AxJSRuntimeNodePermissionAllowlist,
  type AxJSRuntimeOutputMode,
  AxJSRuntimePermission,
  type AxJSRuntimeResourceLimits,
  type AxJSRuntimeSpeculationEvent,
  type AxJSRuntimeSpeculationEventKind,
  type AxJSRuntimeSpeculationEventReason,
  type AxJSRuntimeSpeculationOptions,
  type AxJSRuntimeSpeculationPolicy,
  axCreateJSRuntime,
} from './funcs/jsRuntime.js';
import {
  type AxWorkerRuntimeConfig,
  axWorkerRuntime,
} from './funcs/worker.runtime.js';
import {
  type AxLearningStoreConformanceFactory,
  type AxLearningStoreConformanceFactoryOptions,
  type AxLearningStoreConformanceReport,
  runAxLearningStoreConformance,
} from './learn/conformance.js';
import {
  AxInMemoryLearningStore,
  type AxInMemoryLearningStoreOptions,
  axInMemoryLearningStore,
} from './learn/memoryStore.js';
import {
  type AxLearningBatch,
  type AxLearningDecision,
  type AxLearningEngineDecisionEntry,
  type AxLearningEngineOptions,
  type AxLearningEngineState,
  type AxLearningEngineStep,
  type AxLearningNeverReason,
  type AxLearningProcessor,
  type AxLearningReferenceResolution,
  type AxLearningReportContext,
  type AxLearningTrainingSample,
  type AxLearningTrainingUnit,
  type AxScoreWindowProcessorOptions,
  axCreateLearningEngineState,
  axLearningEligibility,
  axLearningEngineAcknowledge,
  axLearningEngineBuildBatch,
  axLearningEngineIngest,
  axLearningEngineNeverReasons,
  axLearningEngineReady,
  axScoreWindowProcessor,
} from './learn/processor.js';
import {
  type AxLearningInteractionInput,
  type AxLearningReportRecordInput,
  axCreateLearningInteractionRecord,
  axCreateLearningReportRecord,
  axLearningFailureFrom,
  axLearningReceiptFrom,
  axLearningRecordContent,
} from './learn/records.js';
import {
  type AxReportFieldSchema,
  type AxReportFieldType,
  type AxReportSchema,
  axReportSchema,
} from './learn/reportSchema.js';
import {
  type AxHarnessBulletConfig,
  type AxHarnessEntry,
  type AxHarnessEntryKind,
  type AxHarnessGateDecision,
  type AxHarnessGateMetrics,
  type AxHarnessTree,
  type AxLearningAppendResult,
  type AxLearningArtifactRef,
  type AxLearningInteractionPayload,
  type AxLearningInteractionRecord,
  type AxLearningReceipt,
  type AxLearningRecord,
  AxLearningRecordConflictError,
  type AxLearningRecordId,
  AxLearningRecordValidationError,
  type AxLearningRelease,
  AxLearningReleaseConflictError,
  type AxLearningReportInput,
  type AxLearningReportPayload,
  type AxLearningReportRecord,
  AxLearningReportValidationError,
  type AxLearningScalar,
  type AxLearningStore,
  type AxLearningStoreCapabilities,
  type AxLearningStorePage,
  type AxLearningStorePageEntry,
  type AxLearningTreeDelivery,
  type AxLearningValue,
  axIsLearningRecordConflictError,
  axIsLearningReleaseConflictError,
} from './learn/types.js';
import {
  AxMCPAppBridge,
  type AxMCPAppBridgeOptions,
  type AxMCPAppContextUpdate,
  type AxMCPAppDisplayMode,
  type AxMCPAppPermissions,
  type AxMCPAppResource,
  type AxMCPAppResourceCSP,
  type AxMCPAppResourceMeta,
  type AxMCPAppToolMeta,
  type AxMCPAppVisibility,
  axMCPAppToolMeta,
  axMCPToolVisibleTo,
} from './mcp/apps.js';
import {
  type AxMCPAuthentication,
  type AxMCPAuthenticationRequest,
  type AxMCPAuthenticationResult,
  type AxMCPAuthenticationStrategy,
  axApplyMCPAuthentication,
  axMCPAPIKeyAuthentication,
  axMCPBasicAuthentication,
  axMCPBearerAuthentication,
  axMCPHMACAuthentication,
} from './mcp/authentication.js';
import {
  type AxMCPChatOptions,
  type AxMCPChatResult,
  axMCPChat,
} from './mcp/chat.js';
import {
  type AxMCPCacheInfo,
  type AxMCPCatalogCacheName,
  type AxMCPCatalogSnapshot,
  AxMCPClient,
  type AxMCPClientEvent,
  type AxMCPClientListeningOptions,
  type AxMCPClientOptions,
  type AxMCPEraStore,
  type AxMCPFunctionOverride,
} from './mcp/client.js';
import { AxMCPHTTPStatusError, AxMCPProtocolError } from './mcp/errors.js';
import {
  type AxMCPContextRequest,
  type AxMCPContinuationState,
  AxMCPExecutionContext,
  type AxMCPInheritance,
  type AxMCPResolvedContext,
  type AxMCPTaskSnapshot,
  axMCPChildExecutionOptions,
  axResolveMCPExecutionContext,
} from './mcp/execution.js';
import type {
  AxMCPExtensionCapability,
  AxMCPOfficialExtension,
} from './mcp/extensions.js';
import {
  type AxMCPRequestMetaOptions,
  axMCPBuildRequestMeta,
  axMCPServerInfoFromMeta,
} from './mcp/meta.js';
import {
  type AxMCPInputRequestHandlers,
  axMCPFulfillInputRequests,
} from './mcp/mrtr.js';
import {
  type AxMCPDPoPOptions,
  AxMCPDPoPProofFactory,
  type AxMCPDPoPProofRequest,
} from './mcp/oauth/dpop.js';
import {
  AxMCPOAuthJWTVerifier,
  type AxMCPVerifiedJWT,
} from './mcp/oauth/jwt.js';
import type {
  AxMCPEnterpriseAuthorizationContext,
  AxMCPEnterpriseIdentityAssertionType,
  AxMCPEnterpriseManagedAuthorizationOptions,
  AxMCPMTLSOptions,
  AxMCPOAuthClientRegistration,
  AxMCPOAuthJWTValidationOptions,
  AxMCPOAuthOptions,
  AxMCPOAuthTokenEndpointAuthMethod,
  AxMCPOAuthTokenIntrospection,
  AxMCPTokenSet,
} from './mcp/oauth/types.js';
import type {
  AxMCPEra,
  AxMCPListeningHandle,
  AxMCPListeningOptions,
  AxMCPRequestOptions,
  AxMCPTransport,
  AxMCPTransportLifecycleState,
} from './mcp/transport.js';
import {
  AxMCPStreamableHTTPTransport,
  AxMCPStreambleHTTPTransport,
} from './mcp/transports/httpStreamTransport.js';
import type { AxMCPStreamableHTTPTransportOptions } from './mcp/transports/options.js';
import {
  AxMCPRecordingTransport,
  AxMCPReplayTransport,
  type AxMCPTransportRecordingEntry,
} from './mcp/transports/recordingTransport.js';
import { AxMCPHTTPSSETransport } from './mcp/transports/sseTransport.js';
import {
  type AxMCPWebSocketLike,
  AxMCPWebSocketTransport,
  type AxMCPWebSocketTransportOptions,
} from './mcp/transports/webSocketTransport.js';
import {
  type AxMCPAnnotations,
  type AxMCPAudioContent,
  type AxMCPBaseAnnotated,
  type AxMCPBatchRequest,
  type AxMCPBatchResponse,
  type AxMCPBlobResourceContents,
  type AxMCPCacheableResult,
  type AxMCPClientCapabilities,
  type AxMCPCompletionArgument,
  type AxMCPCompletionReference,
  type AxMCPCompletionRequest,
  type AxMCPCompletionResult,
  type AxMCPContent,
  type AxMCPCreateTaskResult,
  type AxMCPDiscoverResult,
  type AxMCPElicitationAction,
  type AxMCPElicitationCreateParams,
  type AxMCPElicitationCreateResult,
  type AxMCPEmbeddedResource,
  type AxMCPFunctionDescription,
  type AxMCPIcon,
  type AxMCPImageContent,
  type AxMCPImplementationInfo,
  type AxMCPInitializeParams,
  type AxMCPInitializeResult,
  type AxMCPInputRequest,
  type AxMCPInputRequiredResult,
  type AxMCPInputResponse,
  type AxMCPInputResponseRequestParams,
  type AxMCPJSONRPCErrorResponse,
  type AxMCPJSONRPCMessage,
  type AxMCPJSONRPCNotification,
  type AxMCPJSONRPCRequest,
  type AxMCPJSONRPCResponse,
  type AxMCPJSONRPCSuccessResponse,
  type AxMCPJSONSchema,
  type AxMCPLegacyCreateTaskResult,
  type AxMCPListRootsResult,
  type AxMCPLoggingLevel,
  type AxMCPMeta,
  type AxMCPPaginatedRequest,
  type AxMCPProgressNotificationParams,
  type AxMCPPrompt,
  type AxMCPPromptArgument,
  type AxMCPPromptGetResult,
  type AxMCPPromptMessage,
  type AxMCPPromptsListResult,
  type AxMCPProtocolVersion,
  type AxMCPResource,
  type AxMCPResourceLink,
  type AxMCPResourceReadResult,
  type AxMCPResourcesListResult,
  type AxMCPResourceTemplate,
  type AxMCPResourceTemplatesListResult,
  type AxMCPResultType,
  type AxMCPRoot,
  type AxMCPSamplingCreateMessageParams,
  type AxMCPSamplingCreateMessageResult,
  type AxMCPSamplingMessage,
  type AxMCPSamplingToolChoice,
  type AxMCPServerCapabilities,
  type AxMCPSubscriptionFilter,
  type AxMCPSubscriptionsAcknowledgedParams,
  type AxMCPSubscriptionsListenParams,
  type AxMCPTask,
  type AxMCPTaskMetadata,
  type AxMCPTaskResult,
  type AxMCPTaskStatus,
  type AxMCPTasksListResult,
  type AxMCPTextContent,
  type AxMCPTextResourceContents,
  type AxMCPTool,
  type AxMCPToolAnnotations,
  type AxMCPToolCallOutcome,
  type AxMCPToolCallParams,
  type AxMCPToolCallResult,
  type AxMCPToolsListResult,
  axMCPToolInputSchemaToFunctionSchema,
} from './mcp/types.js';
import {
  axMCPDecodeHeaderValue,
  axMCPEncodeHeaderValue,
  axMCPIsPlainHeaderValue,
} from './mcp/util/headerValue.js';
import {
  type AxMCPParamHeaderBinding,
  AxMCPParamHeaderSchemaError,
  axMCPBuildParamHeaders,
  axMCPParamHeaderBindings,
} from './mcp/util/paramHeaders.js';
import type {
  AxMCPFetchOptions,
  AxMCPSSRFProtectionContext,
  AxMCPSSRFProtectionOptions,
} from './mcp/util/ssrf.js';
import { AxMemory } from './mem/memory.js';
import type {
  AxAIMemory,
  AxMemoryData,
  AxMemoryMessageValue,
} from './mem/types.js';
import {
  type AxMindChatOptions,
  type AxMindReplyStateOptions,
  axMindChat,
  axMindChatIdempotencyKey,
  axMindChatOperation,
  axMindInferReplyTo,
  axMindReconcileChatSends,
  axResolveMindReplyState,
} from './mind/chat.js';
import {
  type AxMindHealthInput,
  axMindHealth,
  axMindHealthReporter,
  axMindHealthState,
  axMindStalledThreshold,
  axMindStoreDurability,
} from './mind/health.js';
import {
  axMindPaceDelay,
  axMindPacerFuse,
  axMindPaceStepData,
  axMindPaceStepType,
  axMindVisibleStepTypes,
  axMindWakeOutcomeOf,
  axMindWorkProbe,
  axNextMindPace,
  axRecoverMindPacerState,
} from './mind/pacer.js';
import {
  type AxMindEventRoutesOptions,
  type AxMindWakeRouteOptions,
  axMindEventRoutes,
  axMindEventSource,
  axMindEventTypes,
  axMindPendingClass,
  axMindStepEventExtensions,
  axMindSubscribedStepTypes,
  axMindThinkerSubject,
  axMindWakeRoute,
} from './mind/routes.js';
import {
  type AxMindSalienceBufferOptions,
  axMindSalienceBuffer,
  axMindSalienceGuidance,
  axMindSalienceTextBytes,
  axRecordMindSalience,
  axWithMindSalience,
} from './mind/salience.js';
import {
  type AxMindSkillEnvironment,
  type AxMindSkillSelection,
  type AxSelectMindSkillsOptions,
  axDefaultMindKernelTokenBudget,
  axMindSkillTokens,
  axSelectMindSkills,
} from './mind/skills.js';
import {
  type AxMindTickDuty,
  type AxMindTickDutyState,
  AxMindTickEventSource,
  type AxMindTickEventSourceOptions,
  type AxMindTrajectoryConsumer,
  AxTrajectoryEventSource,
  type AxTrajectoryEventSourceOptions,
  axMindTickDue,
} from './mind/sources.js';
import {
  type AxMindArtifacts,
  AxMindBudgetExceededError,
  type AxMindChat,
  AxMindChatError,
  type AxMindChatMessage,
  type AxMindChatTransport,
  AxMindConfigurationError,
  type AxMindDiagnostic,
  type AxMindDiagnosticCode,
  type AxMindEffectLedger,
  type AxMindGoal,
  type AxMindHealth,
  type AxMindHealthState,
  type AxMindHealthThresholds,
  AxMindLivenessError,
  type AxMindOwnershipStore,
  type AxMindPaceDecision,
  type AxMindPacerConfig,
  type AxMindPacerState,
  type AxMindReplyDecision,
  type AxMindReplyResolution,
  type AxMindReplyState,
  type AxMindRoutingSignal,
  type AxMindSalienceBuffer,
  type AxMindSalienceItem,
  type AxMindSendReceipt,
  type AxMindSkill,
  type AxMindStepResult,
  type AxMindSubscription,
  type AxMindThinker,
  type AxMindThinkerBudget,
  type AxMindThinkerHealth,
  type AxMindThinkerKind,
  type AxMindWakeClass,
  type AxMindWakeOutcome,
  type AxMindWorkProbe,
  axDefaultMindPacerConfig,
  axDefaultMindSubscription,
  axDefaultMindThinkerBudget,
  axInitialMindPacerState,
  axIsMindBudgetExceededError,
  axIsMindChatError,
  axIsMindConfigurationError,
} from './mind/types.js';
import { axSpanAttributes, axSpanEvents } from './trace/trace.js';
import {
  type AxTrajectoryStoreConformanceFactory,
  type AxTrajectoryStoreConformanceFactoryOptions,
  type AxTrajectoryStoreConformanceInstance,
  type AxTrajectoryStoreConformanceReport,
  runAxTrajectoryStoreConformance,
} from './trajectory/conformance.js';
import {
  AxTrajectoryLog,
  type AxTrajectoryLogEntry,
  type AxTrajectoryLogOptions,
  type AxTrajectoryPreparedStep,
  type AxTrajectorySpilledStep,
  type AxTrajectorySpillStepOptions,
  axFreezeTrajectoryStep,
  axPrepareTrajectoryStep,
  axSpillTrajectoryStep,
} from './trajectory/log.js';
import {
  AxInMemoryTrajectoryBlobStore,
  AxInMemoryTrajectoryStore,
  type AxInMemoryTrajectoryStoreOptions,
} from './trajectory/memoryStore.js';
import {
  type AxTrajectoryContextBudgetOptions,
  type AxTrajectoryProjection,
  type AxTrajectoryProjectionOptions,
  type AxTrajectoryProjectionSection,
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
} from './trajectory/projection.js';
import {
  type AxTrajectoryTypeRegistryOptions,
  axDefaultTrajectoryTypes,
  axTrajectoryTypeRegistry,
  axTrajectoryUnknownDescriptor,
} from './trajectory/registry.js';
import {
  type AxDeterministicTrajectorySummarizerOptions,
  AxInMemoryTrajectoryRollupStore,
  type AxTrajectoryBuildRollupsOptions,
  type AxTrajectoryBuildRollupsResult,
  type AxTrajectoryProgramSummarizerOptions,
  type AxTrajectoryRollupBlock,
  type AxTrajectoryRollupMeta,
  type AxTrajectoryRollupStore,
  type AxTrajectorySummarizer,
  type AxTrajectorySummarizerRequest,
  type AxTrajectorySummarizerResult,
  axBuildTrajectoryRollups,
  axDeterministicTrajectorySummarizer,
  axTrajectoryMaxSummaryBytes,
  axTrajectoryMaxThemes,
  axTrajectoryProgramSummarizer,
  axTrajectoryRollupSignature,
} from './trajectory/rollups.js';
import {
  type AxTrajectoryResolveOptions,
  type AxTrajectorySpillPolicy,
  type AxTrajectorySpillRequest,
  type AxTrajectorySpillResult,
  axDefaultTrajectorySpillPolicy,
  axResolveTrajectoryStep,
  axResolveTrajectorySteps,
  axSpillTrajectoryFields,
  axTrajectoryInlineBytes,
} from './trajectory/spill.js';
import {
  AxTrajectoryAppendError,
  type AxTrajectoryAppendReceipt,
  type AxTrajectoryAppendRequest,
  AxTrajectoryBlobError,
  type AxTrajectoryBlobPutRequest,
  type AxTrajectoryBlobRef,
  type AxTrajectoryBlobStore,
  type AxTrajectoryCreateRequest,
  type AxTrajectoryCursor,
  AxTrajectoryCursorError,
  type AxTrajectoryDrainBudget,
  type AxTrajectoryDrainResult,
  type AxTrajectoryFieldValue,
  AxTrajectoryForkError,
  type AxTrajectoryForkRequest,
  type AxTrajectoryForkResult,
  type AxTrajectoryHeader,
  type AxTrajectoryMergeRequest,
  AxTrajectoryQueryError,
  type AxTrajectoryReadQuery,
  AxTrajectoryRegistryError,
  AxTrajectoryRollupError,
  type AxTrajectoryStats,
  type AxTrajectoryStep,
  type AxTrajectoryStepClass,
  type AxTrajectoryStore,
  type AxTrajectoryStoreCapabilities,
  type AxTrajectoryTailQuery,
  type AxTrajectoryTailResult,
  type AxTrajectoryTypeDescriptor,
  type AxTrajectoryTypeRegistry,
  axIsTrajectoryAppendError,
  axIsTrajectoryBlobError,
  axIsTrajectoryCursorError,
  axIsTrajectoryQueryError,
  axTrajectoryMaxStepIds,
} from './trajectory/types.js';
import {
  axNormalizeTrajectoryTimestamp,
  axTrajectoryCompactData,
  axTrajectoryId,
  axTrajectoryInvalidFieldPath,
  axTrajectoryStepBytes,
  axTrajectoryStepFingerprint,
  axTrajectoryTruncateUtf8,
  axTrajectoryUtf8ByteLength,
} from './trajectory/util.js';
import { AxUCPClient } from './ucp/client.js';
import {
  AxUCPSchemaValidationError,
  type AxUCPSchemaValidationOptions,
  AxUCPSchemaValidator,
} from './ucp/schema.js';
import {
  AxUCPHTTPMessageSignatureError,
  type AxUCPHTTPMessageSignatureErrorCode,
  type AxUCPHTTPMessageSignatureOptions,
  type AxUCPHTTPMessageVerificationOptions,
  AxUCPHTTPMessageVerifier,
  axSignUCPRequest,
} from './ucp/signing.js';
import type {
  AxUCPAttribution,
  AxUCPBuyerContext,
  AxUCPCallOptions,
  AxUCPCartInput,
  AxUCPCatalogLookupRequest,
  AxUCPCatalogSearchRequest,
  AxUCPCheckoutCompletion,
  AxUCPCheckoutInput,
  AxUCPClientOptions,
  AxUCPDiscounts,
  AxUCPFulfillment,
  AxUCPIdentityLinkingConfig,
  AxUCPMessage,
  AxUCPNegotiatedProfile,
  AxUCPOperation,
  AxUCPOrderEvent,
  AxUCPOutcome,
  AxUCPPayment,
  AxUCPPaymentHandler,
  AxUCPProductRequest,
  AxUCPProfile,
  AxUCPProfileBody,
  AxUCPResponseMetadata,
  AxUCPService,
  AxUCPTransportKind,
  AxUCPValue,
  AxUCPVersionedDeclaration,
} from './ucp/types.js';
import {
  AxAIRefusalError,
  AxAIServiceAbortedError,
  AxAIServiceAuthenticationError,
  AxAIServiceError,
  AxAIServiceNetworkError,
  AxAIServiceResponseError,
  AxAIServiceStatusError,
  AxAIServiceStreamTerminatedError,
  AxAIServiceTimeoutError,
  type AxAPI,
  type AxAPIConfig,
  type AxAPIResponseMetadata,
  AxContentProcessingError,
  AxMediaNotSupportedError,
  AxTokenLimitError,
} from './util/apicall.js';
import { axAssertPersistableValue } from './util/persistable.js';
import {
  AxRateLimiterTokenUsage,
  type AxRateLimiterTokenUsageOptions,
} from './util/rate-limit.js';
import {
  type AxRuntimeHookFrame,
  type AxRuntimeHookFramedOptions,
  axFailOpenSpan,
  axGetRuntimeHookFrame,
  axRuntimeHookFrame,
  axStartActiveSpanFailOpen,
  axStartSpanFailOpen,
} from './util/telemetry.js';

// Value exports
export { AxACE };
export { AxACEOptimizedProgram };
export { AxAI };
export { AxAIAnthropic };
export { AxAIAnthropicModel };
export { AxAIAnthropicVertexModel };
export { AxAICohereEmbedModel };
export { AxAICohereModel };
export { AxAIDeepSeekModel };
export { AxAIGoogleGemini };
export { AxAIGoogleGeminiEmbedModel };
export { AxAIGoogleGeminiEmbedTypes };
export { AxAIGoogleGeminiModel };
export { AxAIGoogleGeminiSafetyCategory };
export { AxAIGoogleGeminiSafetyThreshold };
export { AxAIGrokEmbedModels };
export { AxAIGrokModel };
export { AxAIMistralEmbedModels };
export { AxAIMistralModel };
export { AxAIOpenAI };
export { AxAIOpenAIBase };
export { AxAIOpenAIEmbedModel };
export { AxAIOpenAIModel };
export { AxAIOpenAIProfile };
export { AxAIOpenAIResponses };
export { AxAIOpenAIResponsesBase };
export { AxAIOpenAIResponsesModel };
export { AxAIOpenAIResponsesProfile };
export { AxAIRefusalError };
export { AxAIRekaModel };
export { AxAIServiceAbortedError };
export { AxAIServiceAuthenticationError };
export { AxAIServiceError };
export { AxAIServiceNetworkError };
export { AxAIServiceResponseError };
export { AxAIServiceStatusError };
export { AxAIServiceStreamTerminatedError };
export { AxAIServiceTimeoutError };
export { AxAIWebLLM };
export { AxAIWebLLMModel };
export { AxAgent };
export { AxAgentClarificationError };
export { AxAgentContextMap };
export { AxAgentPlaybook };
export { AxAgentPlaybookEvolveError };
export { AxAgentProtocolCompletionSignal };
export { AxAgentSessionAuthorizationError };
export { AxAgentSessionClient };
export { AxAgentSessionConflictError };
export { AxAgentSessionHost };
export { AxAgentSessionLimitError };
export { AxAgentSessionNotFoundError };
export { AxAgentSessionResultNotReadyError };
export { AxAgentSessionSerializationError };
export { AxAgentSessionStaleHandleError };
export { AxAgentSharedRuntimeSession };
export { AxAssertionError };
export { AxAuthorizationDeniedError };
export { AxBalancer };
export { AxBaseAI };
export { AxBaseOptimizer };
export { AxBestOfN };
export { AxBootstrapFewShot };
export { AxCandidateEffectManifestError };
export { AxCandidateStaleError };
export { AxContentProcessingError };
export { AxContextMetricsCollector };
export { AxDefaultCostTracker };
export { AxDemandBoundary };
export { AxDigestStrengthError };
export { AxDockerSession };
export { AxEmbeddingAdapter };
export { AxEvalUtil };
export { AxEventBackpressureError };
export { AxEventComponentLeakError };
export { AxEventComponentManager };
export { AxEventComponentTransitionError };
export { AxEventContinuationNotFoundError };
export { AxEventInputError };
export { AxEventOutcomeUnknownError };
export { AxEventOutputPersistenceError };
export { AxEventRouteBuilder };
export { AxEventRuntime };
export { AxEventTargetBuilder };
export { AxFlow };
export { AxFlowMermaidError };
export { AxFluentFieldType };
export { AxFrameSampler };
export { AxFunctionError };
export { AxFunctionProcessor };
export { AxGEPA };
export { AxGEPAComponentSelector };
export { AxGen };
export { AxGenerateError };
export { AxHarnessRecipeError };
export { AxInMemoryAgentSessionScheduler };
export { AxInMemoryAgentSessionStore };
export { AxInMemoryBalancerStatsStore };
export { AxInMemoryDemandStore };
export { AxInMemoryEventStore };
export { AxInMemoryLearningStore };
export { AxInMemoryProgramStateStore };
export { AxInMemoryRejectedCandidateLedger };
export { AxInMemoryTrajectoryBlobStore };
export { AxInMemoryTrajectoryRollupStore };
export { AxInMemoryTrajectoryStore };
export { AxInteractionTimeline };
export { AxInteractionTimelineDefaults };
export { AxInteractionTimelineSchema };
export { AxInteractionTimelineVersion };
export { AxJSRuntime };
export { AxJSRuntimePermission };
export { AxLearningRecordConflictError };
export { AxLearningRecordValidationError };
export { AxLearningReleaseConflictError };
export { AxLearningReportValidationError };
export { AxMCPAppBridge };
export { AxMCPClient };
export { AxMCPDPoPProofFactory };
export { AxMCPEventSource };
export { AxMCPExecutionContext };
export { AxMCPHTTPSSETransport };
export { AxMCPHTTPStatusError };
export { AxMCPOAuthJWTVerifier };
export { AxMCPParamHeaderSchemaError };
export { AxMCPProtocolError };
export { AxMCPRecordingTransport };
export { AxMCPReplayTransport };
export { AxMCPStreamableHTTPTransport };
export { AxMCPStreambleHTTPTransport };
export { AxMCPWebSocketTransport };
export { AxManualEventClock };
export { AxMediaNotSupportedError };
export { AxMemory };
export { AxMindBudgetExceededError };
export { AxMindChatError };
export { AxMindConfigurationError };
export { AxMindLivenessError };
export { AxMindTickEventSource };
export { AxMockAIService };
export { AxMultiServiceRouter };
export { AxMutationTaxonomyError };
export { AxOptimizedProgramImpl };
export { AxPlaybook };
export { AxProgram };
export { AxProgramSource };
export { AxProgramSourceBudgetError };
export { AxProgramSourceError };
export { AxProgramSourceSessionExpiredError };
export { AxPromptTemplate };
export { AxProviderRouter };
export { AxPushEventSource };
export { AxRateLimiterTokenUsage };
export { AxReact };
export { AxRefine };
export { AxRefineError };
export { AxRejectedCandidateLedgerError };
export { AxSignature };
export { AxSignatureBuilder };
export { AxStopFunctionCallException };
export { AxStreamingAssertionError };
export { AxStringUtil };
export { AxSynth };
export { AxSystemEventClock };
export { AxTaskDiscriminationError };
export { AxTaskStatTable };
export { AxTemporalEnvelopeSchema };
export { AxTemporalValidationError };
export { AxTestPrompt };
export { AxTimerEventSource };
export { AxTokenLimitError };
export { AxTrajectoryAppendError };
export { AxTrajectoryBlobError };
export { AxTrajectoryCursorError };
export { AxTrajectoryEventSource };
export { AxTrajectoryForkError };
export { AxTrajectoryLog };
export { AxTrajectoryQueryError };
export { AxTrajectoryRegistryError };
export { AxTrajectoryRollupError };
export { AxUCPClient };
export { AxUCPHTTPMessageSignatureError };
export { AxUCPHTTPMessageVerifier };
export { AxUCPSchemaValidationError };
export { AxUCPSchemaValidator };
export { AxUCPWebhookEventSource };
export { AxWorkingState };
export { AxWorkingStateConflictError };
export { AxWorkingStateError };
export { AxWorkingStateForbiddenPathError };
export { AxWorkingStateParkBudgetError };
export { AxWorkingStateSchemaError };
export { AxWorkingStateStoreError };
export { agent };
export { ai };
export { ax };
export { axAIAnthropicDefaultConfig };
export { axAIAnthropicVertexDefaultConfig };
export { axAIGoogleGeminiDefaultConfig };
export { axAIGoogleGeminiDefaultCreativeConfig };
export { axAIGoogleGeminiLiveAudioDefaultConfig };
export { axAIGrokBestConfig };
export { axAIGrokDefaultConfig };
export { axAIGrokVoiceDefaultConfig };
export { axAIOpenAIAudioDefaultConfig };
export { axAIOpenAIBestConfig };
export { axAIOpenAICreativeConfig };
export { axAIOpenAIDefaultConfig };
export { axAIOpenAIFastConfig };
export { axAIOpenAIRealtimeDefaultConfig };
export { axAIOpenAIRealtimeTranscriptionDefaultConfig };
export { axAIOpenAIResponsesBestConfig };
export { axAIOpenAIResponsesCreativeConfig };
export { axAIOpenAIResponsesDefaultConfig };
export { axAIProfiles };
export { axAIProviderAliases };
export { axAIProviderProfileIds };
export { axAIProviderProfiles };
export { axAIWebLLMCreativeConfig };
export { axAIWebLLMDefaultConfig };
export { axAnalyzeChatPromptRequirements };
export { axAnalyzeRequestRequirements };
export { axApplyEventEffectTransition };
export { axApplyMCPAuthentication };
export { axApplyOpenAIChatAudioRequest };
export { axApplyStatePatch };
export { axAssertDigestStrength };
export { axAssertHarnessStampFresh };
export { axAssertPersistableValue };
export { axAttachCausalCandidateEvidence };
export { axAttenuateAuthority };
export { axAudioFormatFromMimeType };
export { axAudioInputFilename };
export { axAudioInputToBlob };
export { axAudioMimeType };
export { axAuthorityClaim };
export { axAuthorize };
export { axBaseAIDefaultConfig };
export { axBaseAIDefaultCreativeConfig };
export { axBuildDistillerDefinition };
export { axBuildExecutorDefinition };
export { axBuildMutationDepthHistogram };
export { axBuildResponderDefinition };
export { axBuildTrajectoryRollups };
export { axCanonicalizeCausalCandidateEvidenceManifest };
export { axCheckMetricsHealth };
export { axClassifyAxServiceTermination };
export { axClassifyTrajectory };
export { axCloneCausalCandidateEvidenceManifest };
export { axCodeRuntimeProtocol };
export { axCodeRuntimeProtocolVersion };
export { axCollectGrantRequirements };
export { axCompareCodeUnits };
export { axComputeInclusionProbabilities };
export { axConcatBase64 };
export { axCreateCausalCandidateEvidenceManifest };
export { axCreateDefaultColorLogger };
export { axCreateDefaultOptimizerColorLogger };
export { axCreateDefaultOptimizerTextLogger };
export { axCreateDefaultTextLogger };
export { axCreateFlowColorLogger };
export { axCreateFlowTextLogger };
export { axCreateGeminiLiveAudioApi };
export { axCreateGrokRealtimeApi };
export { axCreateJSRuntime };
export { axCreateLearningEngineState };
export { axCreateLearningInteractionRecord };
export { axCreateLearningReportRecord };
export { axCreateOpenAIRealtimeApi };
export { axCreateRuntimeAdmissionReceipt };
export { axCreateRuntimeCapabilities };
export { axCreateTaskStatTable };
export { axDeclaresToolCapability };
export { axDefaultFlowLogger };
export { axDefaultMetricsConfig };
export { axDefaultMindKernelTokenBudget };
export { axDefaultMindPacerConfig };
export { axDefaultMindSubscription };
export { axDefaultMindThinkerBudget };
export { axDefaultMutationAnnotator };
export { axDefaultOptimizerLogger };
export { axDefaultOptimizerMetricsConfig };
export { axDefaultTrajectorySpillPolicy };
export { axDefaultTrajectoryTermination };
export { axDefaultTrajectoryTypes };
export { axDemandEventObserver };
export { axDeserializeOptimizedProgram };
export { axDeterministicTrajectorySummarizer };
export { axDigestStrength };
export { axEmitUsageEvent };
export { axErasePreferenceEvidence };
export { axEvaluateGuards };
export { axEventCanonicalDigest };
export { axEventCanonicalJson };
export { axEventComponentManager };
export { axEventContinuationFingerprint };
export { axEventEffectRequestDigest };
export { axEventEffectRequestFingerprint };
export { axEventErrorMessage };
export { axEventId };
export { axEventIdentityScope };
export { axEventIngressFingerprint };
export { axEventMatches };
export { axEventScopedCorrelationKey };
export { axEventScopedDedupeKey };
export { axEventSizeBytes };
export { axExceedsRunDiscardCeiling };
export { axExecutableSkillRef };
export { axExtendAxIRRuntimeCapabilities };
export { axExtractSkillProvenance };
export { axFailOpenSpan };
export { axFetchJsonSpeech };
export { axFetchMultipartTranscription };
export { axFingerprintCausalEvidence };
export { axFnv1a64Digest };
export { axFrameSampler };
export { axFreezeTrajectoryStep };
export { axFunctionAuthorityTarget };
export { axGetAIProfile };
export { axGetCompatibilityReport };
export { axGetFormatCompatibility };
export { axGetMetricsConfig };
export { axGetOptimizerMetricsConfig };
export { axGetProvidersWithMediaSupport };
export { axGetRuntimeHookFrame };
export { axGetSupportedAIModels };
export { axGlobals };
export { axGoogleGeminiLiveAudioDefaults };
export { axHarnessPortId };
export { axHarnessRecipe };
export { axHarnessRecipeVersion };
export { axHarnessStamp };
export { axInMemoryLearningStore };
export { axInferComponentClass };
export { axInitialMindPacerState };
export { axIpwPairedDifference };
export { axIpwScore };
export { axIsAgentPlaybookEvolveError };
export { axIsAudioOutputEnabled };
export { axIsCandidateEffectManifestError };
export { axIsCandidateStaleError };
export { axIsDigestStrengthError };
export { axIsEventOutputPersistenceError };
export { axIsEvidenceRequirement };
export { axIsFnv1a64Digest };
export { axIsGeminiLiveAudioModel };
export { axIsGrokVoiceModel };
export { axIsGuardPredicateFailure };
export { axIsHarnessPortId };
export { axIsHarnessRecipeError };
export { axIsHarnessStampStale };
export { axIsLearningRecordConflictError };
export { axIsLearningReleaseConflictError };
export { axIsMindBudgetExceededError };
export { axIsMindChatError };
export { axIsMindConfigurationError };
export { axIsMutationTaxonomyError };
export { axIsOpenAIChatAudioModel };
export { axIsOpenAIRealtimeModel };
export { axIsOpenAIRealtimeTranscriptionModel };
export { axIsRejectedCandidateExpired };
export { axIsRejectedCandidateLedgerError };
export { axIsSha256Digest };
export { axIsSha256Digest64 };
export { axIsSkillAuthoritySnapshot };
export { axIsSkillPreconditionPolicy };
export { axIsSkillProvenance };
export { axIsTaskDiscriminationError };
export { axIsTrajectoryAppendError };
export { axIsTrajectoryBlobError };
export { axIsTrajectoryCursorError };
export { axIsTrajectoryQueryError };
export { axIsWorkingStateError };
export { axKnownComponentKinds };
export { axLearningEligibility };
export { axLearningEngineAcknowledge };
export { axLearningEngineBuildBatch };
export { axLearningEngineIngest };
export { axLearningEngineNeverReasons };
export { axLearningEngineReady };
export { axLearningFailureFrom };
export { axLearningReceiptFrom };
export { axLearningRecordContent };
export { axMCPAPIKeyAuthentication };
export { axMCPAppToolMeta };
export { axMCPBasicAuthentication };
export { axMCPBearerAuthentication };
export { axMCPBuildParamHeaders };
export { axMCPBuildRequestMeta };
export { axMCPChat };
export { axMCPChildExecutionOptions };
export { axMCPDecodeHeaderValue };
export { axMCPEncodeHeaderValue };
export { axMCPEventRoutes };
export { axMCPFulfillInputRequests };
export { axMCPHMACAuthentication };
export { axMCPIsPlainHeaderValue };
export { axMCPParamHeaderBindings };
export { axMCPServerInfoFromMeta };
export { axMCPToolInputSchemaToFunctionSchema };
export { axMCPToolVisibleTo };
export { axMapGeminiLiveAudioPart };
export { axMapOpenAIChatAudioDelta };
export { axMapOpenAIChatAudioResponse };
export { axMapOpenAIInputAudioPart };
export { axMergeChatAudioConfig };
export { axMergeRejectedCandidateLedgerRefs };
export { axMergeTrajectoryAdmission };
export { axMergeUsageContexts };
export { axMindChat };
export { axMindChatIdempotencyKey };
export { axMindChatOperation };
export { axMindEventRoutes };
export { axMindEventSource };
export { axMindEventTypes };
export { axMindHealth };
export { axMindHealthReporter };
export { axMindHealthState };
export { axMindInferReplyTo };
export { axMindPaceDelay };
export { axMindPaceStepData };
export { axMindPaceStepType };
export { axMindPacerFuse };
export { axMindPendingClass };
export { axMindReconcileChatSends };
export { axMindSalienceBuffer };
export { axMindSalienceGuidance };
export { axMindSalienceTextBytes };
export { axMindSkillTokens };
export { axMindStalledThreshold };
export { axMindStepEventExtensions };
export { axMindStoreDurability };
export { axMindSubscribedStepTypes };
export { axMindThinkerSubject };
export { axMindTickDue };
export { axMindVisibleStepTypes };
export { axMindWakeOutcomeOf };
export { axMindWakeRoute };
export { axMindWorkProbe };
export { axModelInfoAnthropic };
export { axModelInfoCohere };
export { axModelInfoDeepSeek };
export { axModelInfoGoogleGemini };
export { axModelInfoGrok };
export { axModelInfoMistral };
export { axModelInfoOpenAI };
export { axModelInfoOpenAIResponses };
export { axModelInfoReka };
export { axModelInfoWebLLM };
export { axNextMindPace };
export { axNormalizeAppliedServiceTier };
export { axNormalizeAxIRRuntimeCapabilities };
export { axNormalizeOpenAIUsage };
export { axNormalizeRequestedServiceTier };
export { axNormalizeTrajectoryTimestamp };
export { axNormalizeTranscriptionResponse };
export { axOpenAIChatAudioDefaults };
export { axOptimizableValidators };
export { axPairedAdmittedIndices };
export { axPatchClassOfType };
export { axPlaybookFailureSection };
export { axPreferenceEvidenceLimits };
export { axPreferenceEvidenceToMemories };
export { axPrepareTrajectoryStep };
export { axProcessContentForProvider };
export { axProgramSourceDefaultNodeResourceLimits };
export { axProgramSourceRuntimeProtocol };
export { axProgramSourceVersion };
export { axProjectActorPlaybook };
export { axProjectTrajectory };
export { axReactCanonicalJSON };
export { axReactSerializeHistory };
export { axRecheckSkillProvenance };
export { axRecordMindSalience };
export { axRecoverMindPacerState };
export { axRedactPlaybookForModel };
export { axRejectedCandidateDigest };
export { axRejectedCandidateLedgerEntry };
export { axRejectedCandidatePrior };
export { axRenderActorPlaybook };
export { axRenderTrajectoryProjection };
export { axRenewPreferenceEvidence };
export { axReplaceOptimizedProgramSnapshot };
export { axReportRuntimeCapabilityContradictions };
export { axReportSchema };
export { axResolveAIProfileFeatures };
export { axResolveAIProfileId };
export { axResolveGeminiLiveAudioConfig };
export { axResolveGrokRealtimeAudioConfig };
export { axResolveMCPExecutionContext };
export { axResolveMindReplyState };
export { axResolveOpenAIChatAudioConfig };
export { axResolveOpenAIRealtimeAudioConfig };
export { axResolveServiceTier };
export { axResolveTaskDiscriminationOptions };
export { axResolveTrajectoryAdmissionOptions };
export { axResolveTrajectoryCitations };
export { axResolveTrajectoryStep };
export { axResolveTrajectorySteps };
export { axRetractPreferenceEvidence };
export { axRunRejectedCandidateLedgerConformance };
export { axRuntimeCapabilitiesToAxIR };
export { axRuntimeCapabilitiesVersion };
export { axRuntimeCapabilityRequirementsVersion };
export { axRuntimeHookFrame };
export { axRuntimePrimitives };
export { axRuntimeProtocolFromToken };
export { axSampleByInclusion };
export { axScoreProvidersForRequest };
export { axScoreWindowProcessor };
export { axSelectCodeRuntime };
export { axSelectExecutableSkills };
export { axSelectMindSkills };
export { axSelectOptimalProvider };
export { axSelectPreferenceEvidence };
export { axSerializeOptimizedProgram };
export { axSha256Digest };
export { axSha256Digest64Sync };
export { axShouldUseGeminiLiveAudio };
export { axShouldUseGrokRealtime };
export { axShouldUseOpenAIRealtime };
export { axSignUCPRequest };
export { axSkillAdvisoryAnnotation };
export { axSkillPreconditionExecutableDefaults };
export { axSkillPreconditionGuidanceDefaults };
export { axSkillProvenanceDigest };
export { axSnapshotAuthority };
export { axSpanAttributes };
export { axSpanEvents };
export { axSpillTrajectoryFields };
export { axSpillTrajectoryStep };
export { axStartActiveSpanFailOpen };
export { axStartSpanFailOpen };
export { axSummarizeTrajectoryAdmission };
export { axTrajectoryCompactData };
export { axTrajectoryContextBudget };
export { axTrajectoryDefaultBudgetTokens };
export { axTrajectoryDefaultFanout };
export { axTrajectoryDescentBudget };
export { axTrajectoryId };
export { axTrajectoryInlineBytes };
export { axTrajectoryInvalidFieldPath };
export { axTrajectoryMaxStepIds };
export { axTrajectoryMaxSummaryBytes };
export { axTrajectoryMaxThemes };
export { axTrajectoryMinRecentSteps };
export { axTrajectoryProgramSummarizer };
export { axTrajectoryRecentSize };
export { axTrajectoryRollupSignature };
export { axTrajectoryScanPageSteps };
export { axTrajectoryStepBytes };
export { axTrajectoryStepFingerprint };
export { axTrajectoryTokensPerStep };
export { axTrajectoryTruncateUtf8 };
export { axTrajectoryTypeRegistry };
export { axTrajectoryUnknownDescriptor };
export { axTrajectoryUtf8ByteLength };
export { axUpdateBalancerRouteStats };
export { axUpdateMetricsConfig };
export { axUpdateOptimizerMetricsConfig };
export { axValidateCandidateEffectDeclaration };
export { axValidateCapabilityGrant };
export { axValidateChatRequestMessage };
export { axValidateChatResponseResult };
export { axValidateEventEffectCreateRequest };
export { axValidateEventEnvelope };
export { axValidateGeminiLiveAudioInput };
export { axValidateMutationAnnotation };
export { axValidateProviderCapabilities };
export { axValidateStatePatch };
export { axVisualPerceptualDigest };
export { axWithMindSalience };
export { axWorkerRuntime };
export { axWorkingState };
export { axWorkingStateFingerprint };
export { axWorkingStateReceiptFingerprint };
export { axWorkingStateTraceDigest };
export { bestOfN };
export { eventInput };
export { eventPath };
export { eventRoute };
export { eventRuntime };
export { eventTarget };
export { f };
export { flow };
export { fn };
export { optimize };
export { playbook };
export { programSource };
export { react };
export { refine };
export { runAxEventStoreConformance };
export { runAxLearningStoreConformance };
export { runAxTrajectoryStoreConformance };
export { s };

// Type exports
export type { AxACEActorPlaybookView };
export type { AxACEApplicability };
export type { AxACEBullet };
export type { AxACEBulletChange };
export type { AxACEBulletEvidence };
export type { AxACEBulletLifecycle };
export type { AxACEBulletVisibility };
export type { AxACECuratorOperation };
export type { AxACECuratorOperationType };
export type { AxACECuratorOutput };
export type { AxACEFeedbackEvent };
export type { AxACEGeneratorOutput };
export type { AxACEHostEvidence };
export type { AxACEOptimizationArtifact };
export type { AxACEOptions };
export type { AxACEPlaybook };
export type { AxACEPlaybookRenderOptions };
export type { AxACEPreconditionDecision };
export type { AxACEProvenance };
export type { AxACEReflectionOutput };
export type { AxACEResult };
export type { AxACEVerificationResult };
export type { AxAIAnthropicArgs };
export type { AxAIAnthropicChatError };
export type { AxAIAnthropicChatRequest };
export type { AxAIAnthropicChatRequestCacheParam };
export type { AxAIAnthropicChatResponse };
export type { AxAIAnthropicChatResponseDelta };
export type { AxAIAnthropicConfig };
export type { AxAIAnthropicContentBlockDeltaEvent };
export type { AxAIAnthropicContentBlockStartEvent };
export type { AxAIAnthropicContentBlockStopEvent };
export type { AxAIAnthropicEffortLevel };
export type { AxAIAnthropicEffortLevelMapping };
export type { AxAIAnthropicErrorEvent };
export type { AxAIAnthropicFunctionTool };
export type { AxAIAnthropicMessageDeltaEvent };
export type { AxAIAnthropicMessageStartEvent };
export type { AxAIAnthropicMessageStopEvent };
export type { AxAIAnthropicOutputConfig };
export type { AxAIAnthropicPingEvent };
export type { AxAIAnthropicRequestTool };
export type { AxAIAnthropicStopDetails };
export type { AxAIAnthropicTaskBudget };
export type { AxAIAnthropicThinkingConfig };
export type { AxAIAnthropicThinkingTokenBudgetLevels };
export type { AxAIAnthropicThinkingWire };
export type { AxAIAnthropicWebSearchTool };
export type { AxAIArgs };
export type { AxAICredentialProvider };
export type { AxAICredentialRequest };
export type { AxAIDeploymentProfileArgs };
export type { AxAIDeploymentProfileId };
export type { AxAIEmbedModels };
export type { AxAIFeatures };
export type { AxAIGoogleGeminiArgs };
export type { AxAIGoogleGeminiBatchEmbedRequest };
export type { AxAIGoogleGeminiBatchEmbedResponse };
export type { AxAIGoogleGeminiCacheCreateRequest };
export type { AxAIGoogleGeminiCacheResponse };
export type { AxAIGoogleGeminiCacheUpdateRequest };
export type { AxAIGoogleGeminiChatRequest };
export type { AxAIGoogleGeminiChatResponse };
export type { AxAIGoogleGeminiChatResponseDelta };
export type { AxAIGoogleGeminiConfig };
export type { AxAIGoogleGeminiContent };
export type { AxAIGoogleGeminiContentPart };
export type { AxAIGoogleGeminiGenerationConfig };
export type { AxAIGoogleGeminiOptionsTools };
export type { AxAIGoogleGeminiRetrievalConfig };
export type { AxAIGoogleGeminiSafetySettings };
export type { AxAIGoogleGeminiThinkingConfig };
export type { AxAIGoogleGeminiThinkingLevel };
export type { AxAIGoogleGeminiThinkingLevelMapping };
export type { AxAIGoogleGeminiThinkingTokenBudgetLevels };
export type { AxAIGoogleGeminiTool };
export type { AxAIGoogleGeminiToolConfig };
export type { AxAIGoogleGeminiToolFunctionDeclaration };
export type { AxAIGoogleGeminiToolGoogleMaps };
export type { AxAIGoogleGeminiToolGoogleSearchRetrieval };
export type { AxAIGoogleVertexBatchEmbedRequest };
export type { AxAIGoogleVertexBatchEmbedResponse };
export type { AxAIInputModelList };
export type { AxAIMemory };
export type { AxAIMetricsInstruments };
export type { AxAIModelCatalogAudioSupport };
export type { AxAIModelCatalogFilter };
export type { AxAIModelCatalogModel };
export type { AxAIModelCatalogModelCapabilities };
export type { AxAIModelCatalogModelType };
export type { AxAIModelCatalogOptions };
export type { AxAIModelCatalogProvider };
export type { AxAIModelCatalogProviderCapabilities };
export type { AxAIModelCatalogProviderName };
export type { AxAIModelCatalogThinkingLevel };
export type { AxAIModelList };
export type { AxAIModelListBase };
export type { AxAIModels };
export type { AxAIOpenAIAnnotation };
export type { AxAIOpenAIArgs };
export type { AxAIOpenAIBaseArgs };
export type { AxAIOpenAIChatContentPart };
export type { AxAIOpenAIChatRequest };
export type { AxAIOpenAIChatResponse };
export type { AxAIOpenAIChatResponseDelta };
export type { AxAIOpenAIConfig };
export type { AxAIOpenAIEmbedRequest };
export type { AxAIOpenAIEmbedResponse };
export type { AxAIOpenAILogprob };
export type { AxAIOpenAIProfileArgs };
export type { AxAIOpenAIPromptCacheBreakpoint };
export type { AxAIOpenAIResponseDelta };
export type { AxAIOpenAIResponsesArgs };
export type { AxAIOpenAIResponsesCodeInterpreterToolCall };
export type { AxAIOpenAIResponsesComputerToolCall };
export type { AxAIOpenAIResponsesConfig };
export type { AxAIOpenAIResponsesContentPartAddedEvent };
export type { AxAIOpenAIResponsesContentPartDoneEvent };
export type { AxAIOpenAIResponsesDefineFunctionTool };
export type { AxAIOpenAIResponsesErrorEvent };
export type { AxAIOpenAIResponsesFileSearchCallCompletedEvent };
export type { AxAIOpenAIResponsesFileSearchCallInProgressEvent };
export type { AxAIOpenAIResponsesFileSearchCallSearchingEvent };
export type { AxAIOpenAIResponsesFileSearchToolCall };
export type { AxAIOpenAIResponsesFunctionCallArgumentsDeltaEvent };
export type { AxAIOpenAIResponsesFunctionCallArgumentsDoneEvent };
export type { AxAIOpenAIResponsesFunctionCallItem };
export type { AxAIOpenAIResponsesImageGenerationCallCompletedEvent };
export type { AxAIOpenAIResponsesImageGenerationCallGeneratingEvent };
export type { AxAIOpenAIResponsesImageGenerationCallInProgressEvent };
export type { AxAIOpenAIResponsesImageGenerationCallPartialImageEvent };
export type { AxAIOpenAIResponsesImageGenerationToolCall };
export type { AxAIOpenAIResponsesInputAudioContentPart };
export type { AxAIOpenAIResponsesInputContentPart };
export type { AxAIOpenAIResponsesInputFileContentPart };
export type { AxAIOpenAIResponsesInputFunctionCallItem };
export type { AxAIOpenAIResponsesInputFunctionCallOutputItem };
export type { AxAIOpenAIResponsesInputImageUrlContentPart };
export type { AxAIOpenAIResponsesInputItem };
export type { AxAIOpenAIResponsesInputMessageItem };
export type { AxAIOpenAIResponsesInputReasoningItem };
export type { AxAIOpenAIResponsesInputTextContentPart };
export type { AxAIOpenAIResponsesLocalShellToolCall };
export type { AxAIOpenAIResponsesMCPCallArgumentsDeltaEvent };
export type { AxAIOpenAIResponsesMCPCallArgumentsDoneEvent };
export type { AxAIOpenAIResponsesMCPCallCompletedEvent };
export type { AxAIOpenAIResponsesMCPCallFailedEvent };
export type { AxAIOpenAIResponsesMCPCallInProgressEvent };
export type { AxAIOpenAIResponsesMCPListToolsCompletedEvent };
export type { AxAIOpenAIResponsesMCPListToolsFailedEvent };
export type { AxAIOpenAIResponsesMCPListToolsInProgressEvent };
export type { AxAIOpenAIResponsesMCPToolCall };
export type { AxAIOpenAIResponsesOutputItem };
export type { AxAIOpenAIResponsesOutputItemAddedEvent };
export type { AxAIOpenAIResponsesOutputItemDoneEvent };
export type { AxAIOpenAIResponsesOutputMessageItem };
export type { AxAIOpenAIResponsesOutputRefusalContentPart };
export type { AxAIOpenAIResponsesOutputTextAnnotationAddedEvent };
export type { AxAIOpenAIResponsesOutputTextContentPart };
export type { AxAIOpenAIResponsesOutputTextDeltaEvent };
export type { AxAIOpenAIResponsesOutputTextDoneEvent };
export type { AxAIOpenAIResponsesReasoningDeltaEvent };
export type { AxAIOpenAIResponsesReasoningDoneEvent };
export type { AxAIOpenAIResponsesReasoningItem };
export type { AxAIOpenAIResponsesReasoningSummaryDeltaEvent };
export type { AxAIOpenAIResponsesReasoningSummaryDoneEvent };
export type { AxAIOpenAIResponsesReasoningSummaryPart };
export type { AxAIOpenAIResponsesReasoningSummaryPartAddedEvent };
export type { AxAIOpenAIResponsesReasoningSummaryPartDoneEvent };
export type { AxAIOpenAIResponsesReasoningSummaryTextDeltaEvent };
export type { AxAIOpenAIResponsesReasoningSummaryTextDoneEvent };
export type { AxAIOpenAIResponsesReasoningTextDeltaEvent };
export type { AxAIOpenAIResponsesReasoningTextDoneEvent };
export type { AxAIOpenAIResponsesRefusalDeltaEvent };
export type { AxAIOpenAIResponsesRefusalDoneEvent };
export type { AxAIOpenAIResponsesRequest };
export type { AxAIOpenAIResponsesResponse };
export type { AxAIOpenAIResponsesResponseCompletedEvent };
export type { AxAIOpenAIResponsesResponseCreatedEvent };
export type { AxAIOpenAIResponsesResponseFailedEvent };
export type { AxAIOpenAIResponsesResponseInProgressEvent };
export type { AxAIOpenAIResponsesResponseIncompleteEvent };
export type { AxAIOpenAIResponsesResponseQueuedEvent };
export type { AxAIOpenAIResponsesStreamEvent };
export type { AxAIOpenAIResponsesStreamEventBase };
export type { AxAIOpenAIResponsesToolCall };
export type { AxAIOpenAIResponsesToolCallBase };
export type { AxAIOpenAIResponsesToolChoice };
export type { AxAIOpenAIResponsesToolDefinition };
export type { AxAIOpenAIResponsesWebSearchCallCompletedEvent };
export type { AxAIOpenAIResponsesWebSearchCallInProgressEvent };
export type { AxAIOpenAIResponsesWebSearchCallSearchingEvent };
export type { AxAIOpenAIResponsesWebSearchToolCall };
export type { AxAIOpenAIUrlCitation };
export type { AxAIOpenAIUsage };
export type { AxAIProfileArgs };
export type { AxAIProfileAuthentication };
export type { AxAIProfileCapabilities };
export type { AxAIProfileEndpoint };
export type { AxAIProfileId };
export type { AxAIProfileModelRule };
export type { AxAIProfileOperation };
export type { AxAIProfileRequestRules };
export type { AxAIProfileSummary };
export type { AxAIProfileTransport };
export type { AxAIService };
export type { AxAIServiceActionOptions };
export type { AxAIServiceImpl };
export type { AxAIServiceMetrics };
export type { AxAIServiceModelType };
export type { AxAIServiceOptions };
export type { AxAIWebLLMArgs };
export type { AxAIWebLLMChatRequest };
export type { AxAIWebLLMChatResponse };
export type { AxAIWebLLMChatResponseDelta };
export type { AxAIWebLLMConfig };
export type { AxAIWebLLMEmbedModel };
export type { AxAIWebLLMEmbedRequest };
export type { AxAIWebLLMEmbedResponse };
export type { AxAIWebLLMEngine };
export type { AxAIWebLLMModelId };
export type { AxAPI };
export type { AxAPIConfig };
export type { AxAPIResponseMetadata };
export type { AxActor };
export type { AxAgentActorTurnCallback };
export type { AxAgentActorTurnCallbackArgs };
export type { AxAgentAutoPromotionRecord };
export type { AxAgentAutoUpgrade };
export type { AxAgentCatalogSkill };
export type { AxAgentCitations };
export type { AxAgentCitationsOutput };
export type { AxAgentClarification };
export type { AxAgentClarificationChoice };
export type { AxAgentClarificationKind };
export type { AxAgentCompletionProtocol };
export type { AxAgentConfig };
export type { AxAgentContextEvent };
export type { AxAgentContextMapConfig };
export type { AxAgentContextMapOperation };
export type { AxAgentContextMapOptions };
export type { AxAgentContextMapSnapshot };
export type { AxAgentContextMapUpdateResult };
export type { AxAgentContextPressure };
export type { AxAgentContextStage };
export type { AxAgentDemos };
export type { AxAgentDirectResponse };
export type { AxAgentDiscoveryPromptState };
export type { AxAgentEnvironmentFailureCause };
export type { AxAgentEvalBatchResult };
export type { AxAgentEvalBudget };
export type { AxAgentEvalDataset };
export type { AxAgentEvalFunctionCall };
export type { AxAgentEvalPrediction };
export type { AxAgentEvalTask };
export type { AxAgentExecutorResultPayload };
export type { AxAgentFailureCluster };
export type { AxAgentFailureReport };
export type { AxAgentFailureSignal };
export type { AxAgentFailureSignalKind };
export type { AxAgentForwardOptions };
export type { AxAgentFunction };
export type { AxAgentFunctionCall };
export type { AxAgentFunctionCallRecorder };
export type { AxAgentFunctionCollection };
export type { AxAgentFunctionExample };
export type { AxAgentFunctionGroup };
export type { AxAgentFunctionModuleMeta };
export type { AxAgentGuidanceLogEntry };
export type { AxAgentGuidancePayload };
export type { AxAgentGuidanceState };
export type { AxAgentIdentity };
export type { AxAgentInputUpdateCallback };
export type { AxAgentJudgeEvalInput };
export type { AxAgentJudgeEvalOutput };
export type { AxAgentJudgeInput };
export type { AxAgentJudgeOptions };
export type { AxAgentJudgeOutput };
export type { AxAgentMemoriesSearchFn };
export type { AxAgentMemoryEntry };
export type { AxAgentMemoryResult };
export type { AxAgentMetricsInstruments };
export type { AxAgentOnContextEvent };
export type { AxAgentOnFunctionCall };
export type { AxAgentOptimizationTargetDescriptor };
export type { AxAgentOptimizeOptions };
export type { AxAgentOptimizeResult };
export type { AxAgentOptimizeTarget };
export type { AxAgentOptions };
export type { AxAgentPlaybookAttemptRecord };
export type { AxAgentPlaybookComputeAccounting };
export type { AxAgentPlaybookComputePhase };
export type { AxAgentPlaybookComputePhaseName };
export type { AxAgentPlaybookConfig };
export type { AxAgentPlaybookControlArmKind };
export type { AxAgentPlaybookControlArmOptions };
export type { AxAgentPlaybookControlArmReport };
export type { AxAgentPlaybookControlArmResult };
export type { AxAgentPlaybookCostFn };
export type { AxAgentPlaybookEviction };
export type { AxAgentPlaybookEvidenceGates };
export type { AxAgentPlaybookEvidenceReceipt };
export type { AxAgentPlaybookEvidenceWarning };
export type { AxAgentPlaybookEvidenceWarningCode };
export type { AxAgentPlaybookEvolveErrorCode };
export type { AxAgentPlaybookEvolveOptions };
export type { AxAgentPlaybookEvolveOutcome };
export type { AxAgentPlaybookEvolveProgressEvent };
export type { AxAgentPlaybookEvolveProposal };
export type { AxAgentPlaybookEvolveResult };
export type { AxAgentPlaybookEvolveRunRecord };
export type { AxAgentPlaybookGateEntry };
export type { AxAgentPlaybookGateId };
export type { AxAgentPlaybookGateMode };
export type { AxAgentPlaybookGateReport };
export type { AxAgentPlaybookInterval };
export type { AxAgentPlaybookIntervalOptions };
export type { AxAgentPlaybookLearnOptions };
export type { AxAgentPlaybookModelIdentity };
export type { AxAgentPlaybookNomination };
export type { AxAgentPlaybookOptions };
export type { AxAgentPlaybookOverheadMeasure };
export type { AxAgentPlaybookOverheadReport };
export type { AxAgentPlaybookOverheadSplit };
export type { AxAgentPlaybookPromotionAuthority };
export type { AxAgentPlaybookPromotionDenialCode };
export type { AxAgentPlaybookPromotionRecord };
export type { AxAgentPlaybookPromotionVeto };
export type { AxAgentPlaybookPruneOperation };
export type { AxAgentPlaybookPruneOptions };
export type { AxAgentPlaybookPruneProposal };
export type { AxAgentPlaybookPruneTrigger };
export type { AxAgentPlaybookReachBasis };
export type { AxAgentPlaybookReachObservation };
export type { AxAgentPlaybookReachProbe };
export type { AxAgentPlaybookReachReport };
export type { AxAgentPlaybookReachSplit };
export type { AxAgentPlaybookRedundancyEntry };
export type { AxAgentPlaybookRedundancyReport };
export type { AxAgentPlaybookRetentionAnchor };
export type { AxAgentPlaybookRetentionPolicy };
export type { AxAgentPlaybookRetentionReceipt };
export type { AxAgentPlaybookRetentionSlice };
export type { AxAgentPlaybookSealedTestReport };
export type { AxAgentPlaybookSkipReason };
export type { AxAgentPlaybookSplitName };
export type { AxAgentPlaybookSplitScore };
export type { AxAgentPlaybookTerminationReport };
export type { AxAgentPlaybookTerminationSplit };
export type { AxAgentPlaybookTokensBasis };
export type { AxAgentPlaybookTransferCell };
export type { AxAgentPlaybookTransferOptions };
export type { AxAgentPlaybookTransferReport };
export type { AxAgentPlaybookTransferTarget };
export type { AxAgentPlaybookUpdateResult };
export type { AxAgentPlaybookUpdateStatus };
export type { AxAgentPlaybookUsageTap };
export type { AxAgentPlaybookValidityOptions };
export type { AxAgentPlaybookValidityPredicate };
export type { AxAgentPlaybookValidityPredicateId };
export type { AxAgentPlaybookValidityReport };
export type { AxAgentPlaybookVarianceBand };
export type { AxAgentPlaybookVarianceBandOptions };
export type { AxAgentPlaybookVarianceBandReport };
export type { AxAgentPlaybookVetoResult };
export type { AxAgentPlaybookWeakness };
export type { AxAgentRecursionOptions };
export type { AxAgentRecursiveExpensiveNode };
export type { AxAgentRecursiveFunctionCall };
export type { AxAgentRecursiveNodeRole };
export type { AxAgentRecursiveStats };
export type { AxAgentRecursiveTargetId };
export type { AxAgentRecursiveTraceNode };
export type { AxAgentRecursiveTurn };
export type { AxAgentRecursiveUsage };
export type { AxAgentRuntimeCompletionState };
export type { AxAgentRuntimeExecutionContext };
export type { AxAgentRuntimeInputState };
export type { AxAgentSessionEvent };
export type { AxAgentSessionFactoryContext };
export type { AxAgentSessionFunctionOptions };
export type { AxAgentSessionHandle };
export type { AxAgentSessionHostOptions };
export type { AxAgentSessionJob };
export type { AxAgentSessionLimits };
export type { AxAgentSessionMessage };
export type { AxAgentSessionMessageMode };
export type { AxAgentSessionMessageStatus };
export type { AxAgentSessionRecord };
export type { AxAgentSessionRegistration };
export type { AxAgentSessionRegistrySnapshot };
export type { AxAgentSessionRestoreOptions };
export type { AxAgentSessionRootOptions };
export type { AxAgentSessionRootRecord };
export type { AxAgentSessionRootView };
export type { AxAgentSessionScheduler };
export type { AxAgentSessionSendReceipt };
export type { AxAgentSessionStatus };
export type { AxAgentSessionStatusView };
export type { AxAgentSessionStore };
export type { AxAgentSessionUsage };
export type { AxAgentSkillResult };
export type { AxAgentSkillsPromptState };
export type { AxAgentSkillsSearchFn };
export type { AxAgentStagePolicy };
export type { AxAgentStageVariant };
export type { AxAgentState };
export type { AxAgentStateActionLogEntry };
export type { AxAgentStateCheckpointState };
export type { AxAgentStateExecutorModelState };
export type { AxAgentStateRuntimeEntry };
export type { AxAgentStateWorkingState };
export type { AxAgentStreamingForwardOptions };
export type { AxAgentStructuredClarification };
export type { AxAgentTestCompletionPayload };
export type { AxAgentTestResult };
export type { AxAgentTrajectoryClassifier };
export type { AxAgentTrajectoryTermination };
export type { AxAgentTrajectoryTerminationKind };
export type { AxAgentUsage };
export type { AxAgentUsedMemoriesCallback };
export type { AxAgentUsedMemory };
export type { AxAgentUsedSkill };
export type { AxAgentUsedSkillsCallback };
export type { AxAgentic };
export type { AxAnyAgentic };
export type { AxAppliedServiceTier };
export type { AxAssertion };
export type { AxAttempt };
export type { AxAudioFormat };
export type { AxAudioFrameInteractionEvent };
export type { AxAudioInput };
export type { AxAuthorityClaim };
export type { AxAuthorityContext };
export type { AxAuthorityDelegationOptions };
export type { AxAuthorityInheritance };
export type { AxAuthorityValue };
export type { AxAuthorizationAuditEvent };
export type { AxAuthorizationReceipt };
export type { AxAuthorizationRequestContext };
export type { AxAuthorizer };
export type { AxBalancerAdaptiveStrategy };
export type { AxBalancerCandidateScore };
export type { AxBalancerCostContext };
export type { AxBalancerExpectedTokens };
export type { AxBalancerFailureReason };
export type { AxBalancerOptions };
export type { AxBalancerRouteStats };
export type { AxBalancerRoutingContext };
export type { AxBalancerRoutingEvent };
export type { AxBalancerStatsKey };
export type { AxBalancerStatsObservation };
export type { AxBalancerStatsStore };
export type { AxBaseAIArgs };
export type { AxBestOfNOptions };
export type { AxBootstrapOptimizerOptions };
export type { AxCandidateEffectDeclaration };
export type { AxCandidateEffectPolicy };
export type { AxCapabilityGrant };
export type { AxCausalAffectedComponent };
export type { AxCausalCandidateAblation };
export type { AxCausalCandidateEvidenceManifest };
export type { AxCausalCandidateEvidenceOptions };
export type { AxCausalCandidateEvidenceRecord };
export type { AxCausalCandidateSplitOutcome };
export type { AxCausalEvidenceAuthority };
export type { AxCausalEvidenceAuthorityVerifier };
export type { AxCausalEvidenceKind };
export type { AxCausalEvidenceReceipt };
export type { AxCausalEvidenceReference };
export type { AxCausalMetricOutcome };
export type { AxCausalMetricPrediction };
export type { AxChatAudioConfig };
export type { AxChatAudioOutput };
export type { AxChatLogEntry };
export type { AxChatLogMessage };
export type { AxChatRequest };
export type { AxChatResponse };
export type { AxChatResponseFunctionCall };
export type { AxChatResponseResult };
export type { AxCheckpointLoadFn };
export type { AxCheckpointSaveFn };
export type { AxCitation };
export type { AxCodeRuntime };
export type { AxCodeSession };
export type { AxCodeSessionSnapshot };
export type { AxCodeSessionSnapshotEntry };
export type { AxCompileOptions };
export type { AxComponentClass };
export type { AxContentProcessingServices };
export type { AxContextCacheInfo };
export type { AxContextCacheOperation };
export type { AxContextCacheOptions };
export type { AxContextCacheRegistry };
export type { AxContextCacheRegistryEntry };
export type { AxContextFieldInput };
export type { AxContextFieldPromptConfig };
export type { AxContextMetricsRow };
export type { AxContextMetricsSummary };
export type { AxContextPolicyBudget };
export type { AxContextPolicyConfig };
export type { AxContextPolicyPreset };
export type { AxContextScenario };
export type { AxContextTurnSample };
export type { AxControlInteractionEvent };
export type { AxCostTracker };
export type { AxCostTrackerOptions };
export type { AxDateRange };
export type { AxDateRangeValue };
export type { AxDebugChatResponseUsage };
export type { AxDelegationClaims };
export type { AxDemandAppendResult };
export type { AxDemandBoundaryOptions };
export type { AxDemandCalibration };
export type { AxDemandDetection };
export type { AxDemandDetector };
export type { AxDemandDisposition };
export type { AxDemandGrantState };
export type { AxDemandGrantValidationContext };
export type { AxDemandObservation };
export type { AxDemandOutcome };
export type { AxDemandPolicy };
export type { AxDemandProposal };
export type { AxDemandProvenance };
export type { AxDemandReceipt };
export type { AxDemandRecord };
export type { AxDemandScope };
export type { AxDemandStore };
export type { AxDeterministicTrajectorySummarizerOptions };
export type { AxDigestStrength };
export type { AxDiscoveryTurnSummary };
export type { AxDockerContainer };
export type { AxEmbedRequest };
export type { AxEmbedResponse };
export type { AxEnvironmentFailureCause };
export type { AxErrorCategory };
export type { AxEvaluateArgs };
export type { AxEventClock };
export type { AxEventCloseOptions };
export type { AxEventComponentAcquisition };
export type { AxEventComponentActivationContext };
export type { AxEventComponentDefinition };
export type { AxEventComponentDiagnostic };
export type { AxEventComponentDiagnosticCode };
export type { AxEventComponentDisposer };
export type { AxEventComponentEffectInspection };
export type { AxEventComponentInspection };
export type { AxEventComponentManagerOptions };
export type { AxEventComponentState };
export type { AxEventComponentTransitionOptions };
export type { AxEventContext };
export type { AxEventContinuation };
export type { AxEventContinuationEnqueueRequest };
export type { AxEventContinuationPlan };
export type { AxEventContinuationRegistration };
export type { AxEventCorrelationKey };
export type { AxEventDeadLetter };
export type { AxEventDelivery };
export type { AxEventDeliveryStatus };
export type { AxEventEffect };
export type { AxEventEffectCreateRequest };
export type { AxEventEffectFence };
export type { AxEventEffectIntent };
export type { AxEventEffectResolution };
export type { AxEventEffectResolver };
export type { AxEventEffectResolverContext };
export type { AxEventEffectSettlement };
export type { AxEventEffectStatus };
export type { AxEventEffectStore };
export type { AxEventEffectTransition };
export type { AxEventEnqueueRequest };
export type { AxEventEnvelope };
export type { AxEventIdentity };
export type { AxEventIngress };
export type { AxEventInheritance };
export type { AxEventInputBuilder };
export type { AxEventInputDefinition };
export type { AxEventInputFieldMapping };
export type { AxEventInputPlan };
export type { AxEventInvalidator };
export type { AxEventMatcher };
export type { AxEventPath };
export type { AxEventPathRoot };
export type { AxEventPathSegment };
export type { AxEventPayloadStageRequest };
export type { AxEventPayloadStore };
export type { AxEventProgramStateAdapter };
export type { AxEventPublishReceipt };
export type { AxEventRoute };
export type { AxEventRouteAction };
export type { AxEventRun };
export type { AxEventRunStatus };
export type { AxEventRuntimeOptions };
export type { AxEventScalar };
export type { AxEventSink };
export type { AxEventSinkAttempt };
export type { AxEventSinkContext };
export type { AxEventSource };
export type { AxEventSourceContext };
export type { AxEventSourceHandle };
export type { AxEventStagedPayloadStore };
export type { AxEventStore };
export type { AxEventStoreCapabilities };
export type { AxEventStoreConformanceFactory };
export type { AxEventStoreConformanceFactoryOptions };
export type { AxEventStoreConformanceInstance };
export type { AxEventStoreConformanceReport };
export type { AxEventTarget };
export type { AxEventTargetInputContext };
export type { AxEventTrust };
export type { AxEventValue };
export type { AxEventVerificationResult };
export type { AxEventVerificationStatus };
export type { AxEventVerificationUsage };
export type { AxEventVerifierContext };
export type { AxEventVerifierPolicy };
export type { AxEventVerifierResult };
export type { AxEventVerifierTransitionRecord };
export type { AxEventVerifierTransitionRequest };
export type { AxEvidenceDescriptor };
export type { AxEvidenceMatch };
export type { AxEvidenceObservation };
export type { AxEvidenceRequirement };
export type { AxExample };
export type { AxExamples };
export type { AxExecutableSkillArtifact };
export type { AxExecutableSkillAuthority };
export type { AxExecutableSkillContext };
export type { AxExecutableSkillExclusionReason };
export type { AxExecutableSkillInspection };
export type { AxExecutableSkillLifecycle };
export type { AxExecutableSkillRef };
export type { AxExecutableSkillRequirements };
export type { AxExecutableSkillSelection };
export type { AxExecutableSkillVerification };
export type { AxExecutableSkillVerificationReceipt };
export type { AxExecutorModelPolicy };
export type { AxExecutorModelPolicyEntry };
export type { AxField };
export type { AxFieldOptions };
export type { AxFieldProcessor };
export type { AxFieldProcessorProcess };
export type { AxFieldTemplateFn };
export type { AxFieldType };
export type { AxFieldValue };
export type { AxFlowBranchEvaluationData };
export type { AxFlowCompleteData };
export type { AxFlowDynamicContext };
export type { AxFlowErrorData };
export type { AxFlowExecutionPlan };
export type { AxFlowExecutionPlanGroup };
export type { AxFlowExecutionPlanStep };
export type { AxFlowForwardOptions };
export type { AxFlowLogData };
export type { AxFlowLoggerData };
export type { AxFlowLoggerFunction };
export type { AxFlowMermaidBindings };
export type { AxFlowMermaidNodeBinding };
export type { AxFlowMermaidRenderOptions };
export type { AxFlowMetricsInstruments };
export type { AxFlowOptions };
export type { AxFlowParallelGroupCompleteData };
export type { AxFlowParallelGroupStartData };
export type { AxFlowStartData };
export type { AxFlowState };
export type { AxFlowStateDependencyAnalysis };
export type { AxFlowStepCompleteData };
export type { AxFlowStepStartData };
export type { AxFlowTypedParallelBranch };
export type { AxFlowTypedSubContext };
export type { AxFlowable };
export type { AxFluentFieldInfo };
export type { AxFnv1a64Digest };
export type { AxForwardable };
export type { AxFrameSamplerBudget };
export type { AxFrameSamplerDecision };
export type { AxFrameSamplerOptions };
export type { AxFrameSamplerReason };
export type { AxFunction };
export type { AxFunctionCallRecord };
export type { AxFunctionCallTrace };
export type { AxFunctionHandler };
export type { AxFunctionJSONSchema };
export type { AxFunctionProvider };
export type { AxFunctionResult };
export type { AxFunctionResultContent };
export type { AxFunctionResultFormatter };
export type { AxGEPAAdapter };
export type { AxGEPABatchEvaluation };
export type { AxGEPABatchRow };
export type { AxGEPABootstrapOptions };
export type { AxGEPACandidateComponentDelta };
export type { AxGEPACandidateDecision };
export type { AxGEPACandidateDisposition };
export type { AxGEPACandidateEvaluation };
export type { AxGEPACandidateFailure };
export type { AxGEPACandidateLineageManifest };
export type { AxGEPACandidateLineageOptions };
export type { AxGEPACandidateLineageRecord };
export type { AxGEPACandidateStrategy };
export type { AxGEPAComponentBanditState };
export type { AxGEPAComponentTarget };
export type { AxGEPAEvaluationBatch };
export type { AxGEPAEvaluationState };
export type { AxGEPAOptimizationReference };
export type { AxGEPAOptimizationReport };
export type { AxGEPAProposalOptions };
export type { AxGEPAProposalPolicy };
export type { AxGEPAProposalPolicyArgs };
export type { AxGEPAReflectiveTuple };
export type { AxGEPARejectedPriorBlock };
export type { AxGEPAResolvedLineageOptions };
export type { AxGEPATraceSummary };
export type { AxGEPATraceSummaryCall };
export type { AxGateAuthorityOutcome };
export type { AxGateVetoOutcome };
export type { AxGenDeltaOut };
export type { AxGenIn };
export type { AxGenInput };
export type { AxGenMetricsInstruments };
export type { AxGenOut };
export type { AxGenOutput };
export type { AxGenStreamingOut };
export type { AxGenerateErrorDetails };
export type { AxGenerateResult };
export type { AxGeneratedMediaInteractionEvent };
export type { AxGuardEvaluation };
export type { AxGuardEvaluationContext };
export type { AxGuardFailure };
export type { AxGuardFailureCode };
export type { AxGuardOp };
export type { AxHarnessAtom };
export type { AxHarnessBulletConfig };
export type { AxHarnessEntry };
export type { AxHarnessEntryKind };
export type { AxHarnessGateDecision };
export type { AxHarnessGateMetrics };
export type { AxHarnessPortId };
export type { AxHarnessRecipe };
export type { AxHarnessStamp };
export type { AxHarnessTree };
export type { AxIField };
export type { AxIRRuntimeCapabilities };
export type { AxIRRuntimeCapabilitiesInput };
export type { AxInMemoryDemandStoreOptions };
export type { AxInMemoryEventStoreOptions };
export type { AxInMemoryLearningStoreOptions };
export type { AxInMemoryTrajectoryStoreOptions };
export type { AxInputFunctionType };
export type { AxInteractionEvent };
export type { AxInteractionTimelineAppendResult };
export type { AxInteractionTimelineOptions };
export type { AxInteractionTimelineProjection };
export type { AxInteractionTimelineProjectionOptions };
export type { AxInteractionTimelineResolvedOptions };
export type { AxInteractionTimelineSnapshot };
export type { AxInteractionTimelineStreamState };
export type { AxIpwEstimate };
export type { AxJSRuntimeNodePermissionAllowlist };
export type { AxJSRuntimeOutputMode };
export type { AxJSRuntimeResourceLimits };
export type { AxJSRuntimeSpeculationEvent };
export type { AxJSRuntimeSpeculationEventKind };
export type { AxJSRuntimeSpeculationEventReason };
export type { AxJSRuntimeSpeculationOptions };
export type { AxJSRuntimeSpeculationPolicy };
export type { AxJudgeForwardOptions };
export type { AxJudgeOptions };
export type { AxLearningAppendResult };
export type { AxLearningArtifactRef };
export type { AxLearningBatch };
export type { AxLearningDecision };
export type { AxLearningEngineDecisionEntry };
export type { AxLearningEngineOptions };
export type { AxLearningEngineState };
export type { AxLearningEngineStep };
export type { AxLearningInteractionInput };
export type { AxLearningInteractionPayload };
export type { AxLearningInteractionRecord };
export type { AxLearningNeverReason };
export type { AxLearningProcessor };
export type { AxLearningReceipt };
export type { AxLearningRecord };
export type { AxLearningRecordId };
export type { AxLearningReferenceResolution };
export type { AxLearningRelease };
export type { AxLearningReportContext };
export type { AxLearningReportInput };
export type { AxLearningReportPayload };
export type { AxLearningReportRecord };
export type { AxLearningReportRecordInput };
export type { AxLearningScalar };
export type { AxLearningStore };
export type { AxLearningStoreCapabilities };
export type { AxLearningStoreConformanceFactory };
export type { AxLearningStoreConformanceFactoryOptions };
export type { AxLearningStoreConformanceReport };
export type { AxLearningStorePage };
export type { AxLearningStorePageEntry };
export type { AxLearningTrainingSample };
export type { AxLearningTrainingUnit };
export type { AxLearningTreeDelivery };
export type { AxLearningValue };
export type { AxLlmQueryBudgetState };
export type { AxLlmQueryPromptMode };
export type { AxLoggerData };
export type { AxLoggerFunction };
export type { AxMCPAnnotations };
export type { AxMCPAppBridgeOptions };
export type { AxMCPAppContextUpdate };
export type { AxMCPAppDisplayMode };
export type { AxMCPAppPermissions };
export type { AxMCPAppResource };
export type { AxMCPAppResourceCSP };
export type { AxMCPAppResourceMeta };
export type { AxMCPAppToolMeta };
export type { AxMCPAppVisibility };
export type { AxMCPAudioContent };
export type { AxMCPAuthentication };
export type { AxMCPAuthenticationRequest };
export type { AxMCPAuthenticationResult };
export type { AxMCPAuthenticationStrategy };
export type { AxMCPBaseAnnotated };
export type { AxMCPBatchRequest };
export type { AxMCPBatchResponse };
export type { AxMCPBlobResourceContents };
export type { AxMCPCacheInfo };
export type { AxMCPCacheableResult };
export type { AxMCPCatalogCacheName };
export type { AxMCPCatalogSnapshot };
export type { AxMCPChatOptions };
export type { AxMCPChatResult };
export type { AxMCPClientCapabilities };
export type { AxMCPClientEvent };
export type { AxMCPClientListeningOptions };
export type { AxMCPClientOptions };
export type { AxMCPCompletionArgument };
export type { AxMCPCompletionReference };
export type { AxMCPCompletionRequest };
export type { AxMCPCompletionResult };
export type { AxMCPContent };
export type { AxMCPContextRequest };
export type { AxMCPContinuationState };
export type { AxMCPCreateTaskResult };
export type { AxMCPDPoPOptions };
export type { AxMCPDPoPProofRequest };
export type { AxMCPDefaultEventRoutesOptions };
export type { AxMCPDiscoverResult };
export type { AxMCPElicitationAction };
export type { AxMCPElicitationCreateParams };
export type { AxMCPElicitationCreateResult };
export type { AxMCPEmbeddedResource };
export type { AxMCPEnterpriseAuthorizationContext };
export type { AxMCPEnterpriseIdentityAssertionType };
export type { AxMCPEnterpriseManagedAuthorizationOptions };
export type { AxMCPEra };
export type { AxMCPEraStore };
export type { AxMCPEventSourceIdentity };
export type { AxMCPEventSourceOptions };
export type { AxMCPExtensionCapability };
export type { AxMCPFetchOptions };
export type { AxMCPFunctionDescription };
export type { AxMCPFunctionOverride };
export type { AxMCPIcon };
export type { AxMCPImageContent };
export type { AxMCPImplementationInfo };
export type { AxMCPInheritance };
export type { AxMCPInitializeParams };
export type { AxMCPInitializeResult };
export type { AxMCPInputRequest };
export type { AxMCPInputRequestHandlers };
export type { AxMCPInputRequiredResult };
export type { AxMCPInputResponse };
export type { AxMCPInputResponseRequestParams };
export type { AxMCPJSONRPCErrorResponse };
export type { AxMCPJSONRPCMessage };
export type { AxMCPJSONRPCNotification };
export type { AxMCPJSONRPCRequest };
export type { AxMCPJSONRPCResponse };
export type { AxMCPJSONRPCSuccessResponse };
export type { AxMCPJSONSchema };
export type { AxMCPLegacyCreateTaskResult };
export type { AxMCPListRootsResult };
export type { AxMCPListeningHandle };
export type { AxMCPListeningOptions };
export type { AxMCPLoggingLevel };
export type { AxMCPMTLSOptions };
export type { AxMCPMeta };
export type { AxMCPOAuthClientRegistration };
export type { AxMCPOAuthJWTValidationOptions };
export type { AxMCPOAuthOptions };
export type { AxMCPOAuthTokenEndpointAuthMethod };
export type { AxMCPOAuthTokenIntrospection };
export type { AxMCPOfficialExtension };
export type { AxMCPPaginatedRequest };
export type { AxMCPParamHeaderBinding };
export type { AxMCPProgressNotificationParams };
export type { AxMCPPrompt };
export type { AxMCPPromptArgument };
export type { AxMCPPromptGetResult };
export type { AxMCPPromptMessage };
export type { AxMCPPromptsListResult };
export type { AxMCPProtocolVersion };
export type { AxMCPRequestMetaOptions };
export type { AxMCPRequestOptions };
export type { AxMCPResolvedContext };
export type { AxMCPResource };
export type { AxMCPResourceLink };
export type { AxMCPResourceReadResult };
export type { AxMCPResourceSubscriptionPolicy };
export type { AxMCPResourceTemplate };
export type { AxMCPResourceTemplatesListResult };
export type { AxMCPResourcesListResult };
export type { AxMCPResultType };
export type { AxMCPRoot };
export type { AxMCPSSRFProtectionContext };
export type { AxMCPSSRFProtectionOptions };
export type { AxMCPSamplingCreateMessageParams };
export type { AxMCPSamplingCreateMessageResult };
export type { AxMCPSamplingMessage };
export type { AxMCPSamplingToolChoice };
export type { AxMCPServerCapabilities };
export type { AxMCPStreamableHTTPTransportOptions };
export type { AxMCPSubscriptionFilter };
export type { AxMCPSubscriptionsAcknowledgedParams };
export type { AxMCPSubscriptionsListenParams };
export type { AxMCPTask };
export type { AxMCPTaskMetadata };
export type { AxMCPTaskResult };
export type { AxMCPTaskSnapshot };
export type { AxMCPTaskStatus };
export type { AxMCPTasksListResult };
export type { AxMCPTextContent };
export type { AxMCPTextResourceContents };
export type { AxMCPTokenSet };
export type { AxMCPTool };
export type { AxMCPToolAnnotations };
export type { AxMCPToolCallOutcome };
export type { AxMCPToolCallParams };
export type { AxMCPToolCallResult };
export type { AxMCPToolsListResult };
export type { AxMCPTransport };
export type { AxMCPTransportLifecycleState };
export type { AxMCPTransportRecordingEntry };
export type { AxMCPVerifiedJWT };
export type { AxMCPWebSocketLike };
export type { AxMCPWebSocketTransportOptions };
export type { AxMediaTimeRange };
export type { AxMemoryData };
export type { AxMemoryMessageValue };
export type { AxMetricFn };
export type { AxMetricFnArgs };
export type { AxMetricResult };
export type { AxMetricsConfig };
export type { AxMindArtifacts };
export type { AxMindChat };
export type { AxMindChatMessage };
export type { AxMindChatOptions };
export type { AxMindChatTransport };
export type { AxMindDiagnostic };
export type { AxMindDiagnosticCode };
export type { AxMindEffectLedger };
export type { AxMindEventRoutesOptions };
export type { AxMindGoal };
export type { AxMindHealth };
export type { AxMindHealthInput };
export type { AxMindHealthState };
export type { AxMindHealthThresholds };
export type { AxMindOwnershipStore };
export type { AxMindPaceDecision };
export type { AxMindPacerConfig };
export type { AxMindPacerState };
export type { AxMindReplyDecision };
export type { AxMindReplyResolution };
export type { AxMindReplyState };
export type { AxMindReplyStateOptions };
export type { AxMindRoutingSignal };
export type { AxMindSalienceBuffer };
export type { AxMindSalienceBufferOptions };
export type { AxMindSalienceItem };
export type { AxMindSendReceipt };
export type { AxMindSkill };
export type { AxMindSkillEnvironment };
export type { AxMindSkillSelection };
export type { AxMindStepResult };
export type { AxMindSubscription };
export type { AxMindThinker };
export type { AxMindThinkerBudget };
export type { AxMindThinkerHealth };
export type { AxMindThinkerKind };
export type { AxMindTickDuty };
export type { AxMindTickDutyState };
export type { AxMindTickEventSourceOptions };
export type { AxMindTrajectoryConsumer };
export type { AxMindWakeClass };
export type { AxMindWakeOutcome };
export type { AxMindWakeRouteOptions };
export type { AxMindWorkProbe };
export type { AxMinibatchStrategy };
export type { AxMockAIServiceConfig };
export type { AxModelConfig };
export type { AxModelInfo };
export type { AxModelInfoWithProvider };
export type { AxModelUsage };
export type { AxModuleRankInput };
export type { AxMultiMetricFn };
export type { AxMultiProviderConfig };
export type { AxMutationAnnotation };
export type { AxMutationAnnotator };
export type { AxMutationDepth };
export type { AxMutationDepthHistogram };
export type { AxMutationEffort };
export type { AxMutationKindPolicy };
export type { AxMutationSurface };
export type { AxNamedProgramInstance };
export type { AxOpenAIReasoningContentMode };
export type { AxOptimizableComponent };
export type { AxOptimizableValidator };
export type { AxOptimizationCheckpoint };
export type { AxOptimizationProgress };
export type { AxOptimizationStats };
export type { AxOptimizeOptions };
export type { AxOptimizedProgram };
export type { AxOptimizer };
export type { AxOptimizerArgs };
export type { AxOptimizerLoggerData };
export type { AxOptimizerLoggerFunction };
export type { AxOptimizerMetricsConfig };
export type { AxOptimizerMetricsInstruments };
export type { AxOptimizerResult };
export type { AxParetoResult };
export type { AxPatchClass };
export type { AxPatchTaxonomy };
export type { AxPatchType };
export type { AxPlaybookEvolveOptions };
export type { AxPlaybookEvolveResult };
export type { AxPlaybookOptions };
export type { AxPlaybookSnapshot };
export type { AxPreferenceApplicability };
export type { AxPreferenceEvidenceAssertion };
export type { AxPreferenceEvidenceClaim };
export type { AxPreferenceEvidenceContext };
export type { AxPreferenceEvidenceErasure };
export type { AxPreferenceEvidenceExclusion };
export type { AxPreferenceEvidenceExclusionReason };
export type { AxPreferenceEvidenceKind };
export type { AxPreferenceEvidenceOperation };
export type { AxPreferenceEvidenceReceiptPurpose };
export type { AxPreferenceEvidenceReceiptRequest };
export type { AxPreferenceEvidenceRecord };
export type { AxPreferenceEvidenceRenewal };
export type { AxPreferenceEvidenceRetraction };
export type { AxPreferenceEvidenceRevision };
export type { AxPreferenceEvidenceSelection };
export type { AxPreferenceEvidenceStreamBinding };
export type { AxPreferenceEvidenceStreamRequest };
export type { AxPrincipal };
export type { AxProgramDemos };
export type { AxProgramExamples };
export type { AxProgramForwardOptions };
export type { AxProgramForwardOptionsWithModels };
export type { AxProgramOptions };
export type { AxProgramSourceCapability };
export type { AxProgramSourceDocument };
export type { AxProgramSourceExpression };
export type { AxProgramSourceLateBridgeEvent };
export type { AxProgramSourceOptions };
export type { AxProgramSourceRuntime };
export type { AxProgramSourceState };
export type { AxProgramSourceStatement };
export type { AxProgramSourceValueLimits };
export type { AxProgramStateEnvelope };
export type { AxProgramStateStore };
export type { AxProgramStreamingForwardOptions };
export type { AxProgramStreamingForwardOptionsWithModels };
export type { AxProgramTrace };
export type { AxProgramUsage };
export type { AxProgrammable };
export type { AxPromptMetrics };
export type { AxPromptTemplateOptions };
export type { AxProviderMetadata };
export type { AxRLMConfig };
export type { AxRankDocumentsOptions };
export type { AxRankModulesOptions };
export type { AxRankableDocument };
export type { AxRankableField };
export type { AxRankedDocument };
export type { AxRankedModule };
export type { AxRateLimitInfo };
export type { AxRateLimiterFunction };
export type { AxRateLimiterTokenUsageOptions };
export type { AxReactAssistantEvent };
export type { AxReactCall };
export type { AxReactEvent };
export type { AxReactFailure };
export type { AxReactForwardOptions };
export type { AxReactHistory };
export type { AxReactOptions };
export type { AxReactResult };
export type { AxReactSuccess };
export type { AxReactTerminationReason };
export type { AxReactToolEvent };
export type { AxRefineOptions };
export type { AxRefineStrategy };
export type { AxRejectedCandidateDelta };
export type { AxRejectedCandidateExpiry };
export type { AxRejectedCandidateExpiryContext };
export type { AxRejectedCandidateGateReading };
export type { AxRejectedCandidateLedgerCapabilities };
export type { AxRejectedCandidateLedgerEntry };
export type { AxRejectedCandidateLedgerQuery };
export type { AxRejectedCandidateLedgerRef };
export type { AxRejectedCandidateLedgerStore };
export type { AxRelevanceHints };
export type { AxRenderedPrompt };
export type { AxReportFieldSchema };
export type { AxReportFieldType };
export type { AxReportSchema };
export type { AxResolvedAgentPlaybookConfig };
export type { AxResolvedAgentPlaybookLearn };
export type { AxResolvedAutoUpgrade };
export type { AxResolvedCitations };
export type { AxResolvedContextPolicy };
export type { AxResolvedExecutorModelPolicy };
export type { AxResolvedExecutorModelPolicyEntry };
export type { AxResolvedTaskDiscriminationOptions };
export type { AxResolvedTrajectoryAdmissionOptions };
export type { AxResourceScope };
export type { AxResultPickerFunction };
export type { AxResultPickerFunctionFieldResults };
export type { AxResultPickerFunctionFunctionResults };
export type { AxRetainedAgent };
export type { AxRewardFn };
export type { AxRewardFnArgs };
export type { AxRolloutTrace };
export type { AxRoutingResult };
export type { AxRuntimeAdmissionEvidence };
export type { AxRuntimeAdmissionReceipt };
export type { AxRuntimeAuthority };
export type { AxRuntimeCallableFormatArgs };
export type { AxRuntimeCapabilities };
export type { AxRuntimeCapabilitiesV1 };
export type { AxRuntimeCapabilityContradictionReport };
export type { AxRuntimeCapabilityExtensions };
export type { AxRuntimeCapabilityObservations };
export type { AxRuntimeCapabilityRequirements };
export type { AxRuntimeHookFrame };
export type { AxRuntimeHookFramedOptions };
export type { AxRuntimeHooks };
export type { AxRuntimeLanguageInfo };
export type { AxRuntimePlatform };
export type { AxRuntimePlatformAuthority };
export type { AxRuntimePrimitive };
export type { AxRuntimePrimitiveExample };
export type { AxRuntimePrimitiveOverrideMap };
export type { AxRuntimePrimitiveSignature };
export type { AxRuntimePrimitiveStage };
export type { AxRuntimeProtocol };
export type { AxRuntimeSelection };
export type { AxRuntimeTimeoutEnforcement };
export type { AxSamplePickerOptions };
export type { AxScoreWindowProcessorOptions };
export type { AxSelectExecutableSkillsOptions };
export type { AxSelectMindSkillsOptions };
export type { AxSelectedExecutableSkill };
export type { AxSelectedPreferenceEvidence };
export type { AxSelfTuningConfig };
export type { AxSerializedOptimizedProgram };
export type { AxServiceTier };
export type { AxServiceTierMap };
export type { AxServiceTierPricing };
export type { AxSessionTimeRange };
export type { AxSetExamplesOptions };
export type { AxSha256Digest };
export type { AxSha256Digest64 };
export type { AxSharedSessionPhase };
export type { AxSignatureConfig };
export type { AxSignatureInput };
export type { AxSkillAuthoritySnapshot };
export type { AxSkillPreconditionCheck };
export type { AxSkillPreconditionFailure };
export type { AxSkillPreconditionFailureKind };
export type { AxSkillPreconditionOutcome };
export type { AxSkillPreconditionPolicy };
export type { AxSkillProvenance };
export type { AxSkillProvenanceAuthorization };
export type { AxSkillProvenanceEffectRef };
export type { AxSkillProvenanceSource };
export type { AxSkillVerifierDecision };
export type { AxSkillVerifierVerdict };
export type { AxSpeechConfig };
export type { AxSpeechRequest };
export type { AxSpeechResponse };
export type { AxStageDefinitionBuildOptions };
export type { AxStageOptions };
export type { AxStatePatch };
export type { AxStatePatchApplyResult };
export type { AxStatePatchInvalidCode };
export type { AxStatePatchOp };
export type { AxStatePatchValidation };
export type { AxStepContext };
export type { AxStepHooks };
export type { AxStepUsage };
export type { AxStreamingAssertion };
export type { AxStreamingEvent };
export type { AxStreamingFieldProcessorProcess };
export type { AxStructuredOutputMode };
export type { AxStructuredOutputRung };
export type { AxSynthExample };
export type { AxSynthOptions };
export type { AxSynthResult };
export type { AxSynthesizerInit };
export type { AxSynthesizerOptions };
export type { AxSynthesizerRole };
export type { AxTaskDiscriminationOptions };
export type { AxTaskDiscriminationSummary };
export type { AxTaskInclusion };
export type { AxTaskInclusionSnapshot };
export type { AxTaskStat };
export type { AxTaskStatPhase };
export type { AxTemporalClassification };
export type { AxTemporalEnvelope };
export type { AxTextInteractionEvent };
export type { AxThoughtBlockItem };
export type { AxTimerEventSourceOptions };
export type { AxTokenUsage };
export type { AxToolActivityInteractionEvent };
export type { AxTrajectoryAdmissionOptions };
export type { AxTrajectoryAdmissionReport };
export type { AxTrajectoryAppendReceipt };
export type { AxTrajectoryAppendRequest };
export type { AxTrajectoryBlobPutRequest };
export type { AxTrajectoryBlobRef };
export type { AxTrajectoryBlobStore };
export type { AxTrajectoryBuildRollupsOptions };
export type { AxTrajectoryBuildRollupsResult };
export type { AxTrajectoryContextBudgetOptions };
export type { AxTrajectoryCreateRequest };
export type { AxTrajectoryCursor };
export type { AxTrajectoryDrainBudget };
export type { AxTrajectoryDrainResult };
export type { AxTrajectoryEventSourceOptions };
export type { AxTrajectoryFieldValue };
export type { AxTrajectoryForkRequest };
export type { AxTrajectoryForkResult };
export type { AxTrajectoryHeader };
export type { AxTrajectoryLogEntry };
export type { AxTrajectoryLogOptions };
export type { AxTrajectoryMergeRequest };
export type { AxTrajectoryPreparedStep };
export type { AxTrajectoryProgramSummarizerOptions };
export type { AxTrajectoryProjection };
export type { AxTrajectoryProjectionOptions };
export type { AxTrajectoryProjectionSection };
export type { AxTrajectoryReadQuery };
export type { AxTrajectoryResolveOptions };
export type { AxTrajectoryRollupBlock };
export type { AxTrajectoryRollupMeta };
export type { AxTrajectoryRollupStore };
export type { AxTrajectorySpillPolicy };
export type { AxTrajectorySpillRequest };
export type { AxTrajectorySpillResult };
export type { AxTrajectorySpillStepOptions };
export type { AxTrajectorySpilledStep };
export type { AxTrajectoryStats };
export type { AxTrajectoryStep };
export type { AxTrajectoryStepClass };
export type { AxTrajectoryStore };
export type { AxTrajectoryStoreCapabilities };
export type { AxTrajectoryStoreConformanceFactory };
export type { AxTrajectoryStoreConformanceFactoryOptions };
export type { AxTrajectoryStoreConformanceInstance };
export type { AxTrajectoryStoreConformanceReport };
export type { AxTrajectorySummarizer };
export type { AxTrajectorySummarizerRequest };
export type { AxTrajectorySummarizerResult };
export type { AxTrajectoryTailQuery };
export type { AxTrajectoryTailResult };
export type { AxTrajectoryTermination };
export type { AxTrajectoryTerminationClassifier };
export type { AxTrajectoryTerminationInput };
export type { AxTrajectoryTypeDescriptor };
export type { AxTrajectoryTypeRegistry };
export type { AxTrajectoryTypeRegistryOptions };
export type { AxTranscriptInteractionEvent };
export type { AxTranscriptionRequest };
export type { AxTranscriptionResponse };
export type { AxTranscriptionSegment };
export type { AxTunable };
export type { AxTypedExample };
export type { AxUCPAttribution };
export type { AxUCPBuyerContext };
export type { AxUCPCallOptions };
export type { AxUCPCartInput };
export type { AxUCPCatalogLookupRequest };
export type { AxUCPCatalogSearchRequest };
export type { AxUCPCheckoutCompletion };
export type { AxUCPCheckoutInput };
export type { AxUCPClientOptions };
export type { AxUCPDiscounts };
export type { AxUCPFulfillment };
export type { AxUCPHTTPMessageSignatureErrorCode };
export type { AxUCPHTTPMessageSignatureOptions };
export type { AxUCPHTTPMessageVerificationOptions };
export type { AxUCPIdentityLinkingConfig };
export type { AxUCPMessage };
export type { AxUCPNegotiatedProfile };
export type { AxUCPOperation };
export type { AxUCPOrderEvent };
export type { AxUCPOutcome };
export type { AxUCPPayment };
export type { AxUCPPaymentHandler };
export type { AxUCPProductRequest };
export type { AxUCPProfile };
export type { AxUCPProfileBody };
export type { AxUCPResponseMetadata };
export type { AxUCPSchemaValidationOptions };
export type { AxUCPService };
export type { AxUCPTransportKind };
export type { AxUCPValue };
export type { AxUCPVersionedDeclaration };
export type { AxUCPWebhookEventSourceOptions };
export type { AxUsable };
export type { AxUsageContext };
export type { AxUsageEvent };
export type { AxUsageObserver };
export type { AxVisualAuthority };
export type { AxVisualChangeDigest };
export type { AxVisualObservation };
export type { AxVisualObservationInteractionEvent };
export type { AxVisualPerceptualInput };
export type { AxWorkerRuntimeConfig };
export type { AxWorkingStateCheckContext };
export type { AxWorkingStateChecker };
export type { AxWorkingStateCheckerPolicy };
export type { AxWorkingStateClassifiedOp };
export type { AxWorkingStateCommitContext };
export type { AxWorkingStateCommitOutcome };
export type { AxWorkingStateConfig };
export type { AxWorkingStateDeltaClass };
export type { AxWorkingStateDocument };
export type { AxWorkingStateEvidenceRef };
export type { AxWorkingStateGoal };
export type { AxWorkingStateGoalStatus };
export type { AxWorkingStateGuidanceNote };
export type { AxWorkingStateParkReason };
export type { AxWorkingStateParkedDelta };
export type { AxWorkingStateProposal };
export type { AxWorkingStateProposer };
export type { AxWorkingStateProposerInput };
export type { AxWorkingStateProposerMode };
export type { AxWorkingStateReceipt };
export type { AxWorkingStateTraceSink };
export type { AxWorkingStateTraceStep };
