import type {
  ActionLogEntry,
  CheckpointSummaryState,
} from '../contextManager.js';
import type { AxWorkingState } from '../workingState.js';
import type { buildActorLoopSetup } from './actorLoopSetup.js';
import type { AxAgentToolReceiptObservation } from './runtimeGlobals.js';
import type {
  AxAgentContextStage,
  AxAgentEvalFunctionCall,
  AxAgentGuidanceState,
  AxAgentRuntimeCompletionState,
  AxAgentStateExecutorModelState,
  AxAgentUsedMemory,
  AxAgentUsedSkill,
} from './types.js';

export interface MutableActorLoopState {
  checkpointState: CheckpointSummaryState | undefined;
  actorModelState: AxAgentStateExecutorModelState | undefined;
  restoreNotice: string | undefined;
  runtimeStateSummary: string | undefined;
  lastDebugLoggedActorInstruction: string | undefined;
  actorFieldValues: Record<string, unknown>;
  usedMemories: AxAgentUsedMemory[];
  usedSkills: AxAgentUsedSkill[];
}

export interface ActorLoopContext {
  s: any;
  ai: any;
  rlm: any;
  runtimeContext: any;
  inputState: any;
  completionState: AxAgentRuntimeCompletionState;
  guidanceState: AxAgentGuidanceState;
  actionLogEntries: ActionLogEntry[];
  actorMergedOptions: any;
  summaryForwardOptions: any;
  functionCallRecords?: AxAgentEvalFunctionCall[];
  explicitActorDebugHideSystemPrompt: boolean | undefined;
  contextStage: AxAgentContextStage;
  contextThreshold: any;
  delegatedContextSummary: any;
  /**
   * Verifier-gated working state for this run. Present only when the agent
   * configured `workingState` AND this stage's policy maintains it.
   */
  workingState?: AxWorkingState<any>;
  /**
   * Successful, receipt-eligible dispatches observed since the last drain.
   * Filled at the dispatch site (`wrapFunction`) and drained once per turn.
   */
  workingStateObservations?: AxAgentToolReceiptObservation[];
  mutableState: MutableActorLoopState;
  helpers: ReturnType<typeof buildActorLoopSetup>;
}
