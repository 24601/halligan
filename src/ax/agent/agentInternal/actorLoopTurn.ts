import type {
  AxChatLogEntry,
  AxGenIn,
  AxProgramForwardOptions,
  AxProgramUsage,
} from '../../dsp/types.js';
import { AxAIServiceAbortedError } from '../../util/apicall.js';
import type {
  AxAgentGuidancePayload,
  AxAgentInternalCompletionPayload,
} from '../completion.js';
import {
  computeEffectiveChatBudget,
  getActorModelConsecutiveErrorTurns,
  getActorModelMatchedNamespaces,
  selectActorModelFromPolicy,
} from '../config.js';
import {
  classifyContextPressure,
  emitContextEvent,
  renderContextPressure,
} from '../contextEvents.js';
import type { ActionLogParts } from '../contextManager.js';
import { manageContext } from '../contextManager.js';
import { normalizeActorCode } from '../optimize.js';
import {
  formatBubbledActorTurnOutput,
  validateActorTurnCodePolicy,
} from '../runtime.js';
import type { AxSkillStateRuntime } from '../skillState.js';
import { axValidateStatePatch } from '../statePatch.js';
import type {
  AxWorkingState,
  AxWorkingStateCommitContext,
  AxWorkingStateGuidanceNote,
} from '../workingState.js';
import type { ActorLoopContext } from './actorLoopContext.js';
import {
  appendDiscoveryTurnSummary,
  stripDiscoveryTurnOutput,
} from './discoveryHelpers.js';
import {
  appendGuidanceEntry,
  buildGuidanceActionLogCode,
  buildGuidanceActionLogOutput,
  renderGuidanceLog,
  snapshotChatLogMessages,
} from './guidanceHelpers.js';
import { AxAgentClarificationError } from './types.js';

const ACTOR_CODE_POLICY_GUIDANCE =
  'Your previous Javascript Code value did not satisfy the executable-code turn contract. ' +
  'On this turn, set Javascript Code to runnable JavaScript only: use console.log(...) for inspection, ' +
  'await final("...", { ... }) when complete, or await askClarification(...) when blocked. ' +
  'Do not emit plain task:/evidence: labels or prose as the Javascript Code value.';

function buildMultipleCodeBlocksPolicyViolation(
  runtimeCodeFieldTitle: string
): string {
  return `[POLICY] ${runtimeCodeFieldTitle} must contain at most one fenced code block. No code from the previous turn was executed.`;
}

function buildMultipleCodeBlocksPolicyGuidance(
  runtimeCodeFieldTitle: string
): string {
  return (
    `Your previous ${runtimeCodeFieldTitle} value contained multiple fenced code blocks, so none of them were executed. ` +
    `On this turn, put every executable statement in one ${runtimeCodeFieldTitle} value with at most one fence.`
  );
}

/**
 * Render harness-owned guidance for the trusted guidance channel. Only an enum
 * code, the op KIND, a sanitized bounded pointer, the goal id and the expected
 * callables ever appear — `guidanceLog` is the highest-authority prompt region
 * and must never launder model-authored text into it.
 */
function buildWorkingStateGuidance(
  notes: readonly AxWorkingStateGuidanceNote[]
): string | undefined {
  if (notes.length === 0) return undefined;
  const lines = notes.map((note) => {
    const goal = note.goalId ? ` for goal ${note.goalId}` : '';
    const expects =
      note.expects && note.expects.length > 0
        ? ` (expected receipts from: ${note.expects.join(', ')})`
        : '';
    return `- ${note.code}: ${note.opKind} at ${note.path}${goal}${expects}`;
  });
  return [
    'Working state did not apply part of your last proposal:',
    ...lines,
    'A goal becomes done only by citing a receipt ref from the read-only Receipt Roster in the same patch.',
  ].join('\n');
}

/**
 * Run one working-state turn: mint nothing (receipts are already drained),
 * decide whether to propose, validate the untrusted patch document, commit
 * through the kernel, and route harness guidance into the trusted channel.
 */
async function runWorkingStateTurn(
  workingState: AxWorkingState<any>,
  context: AxWorkingStateCommitContext,
  proposerInput: Readonly<{ action: string; observation: string }>,
  signal: AbortSignal | undefined
): Promise<readonly AxWorkingStateGuidanceNote[]> {
  const mode = workingState.proposerMode();
  const changed =
    (context.receiptRefs?.length ?? 0) > 0 || context.isError === true;
  const shouldPropose =
    mode === 'every-turn' || (mode === 'on-change' && changed);
  if (!shouldPropose) {
    // `on-change` makes the added model cost proportional to ENVIRONMENT
    // change, not to turn count: a pure-inspection turn costs nothing extra.
    await workingState.recordNonCommit(context, 'none');
    return [];
  }

  let proposal: Awaited<ReturnType<typeof workingState.propose>>;
  try {
    proposal = await workingState.propose(
      {
        stateContract: workingState.stateContract(),
        workingState: workingState.renderWritable(),
        receiptRoster: workingState.renderReadOnly(),
        action: proposerInput.action,
        observation: proposerInput.observation,
        isError: context.isError,
        turn: context.turn,
      },
      signal
    );
  } catch {
    // A flaky proposer must never corrupt state or fail the turn.
    await workingState.recordNonCommit(context, 'proposer_error');
    return [];
  }

  const validation = axValidateStatePatch(proposal.statePatch);
  if (validation.status !== 'valid') {
    const rejected = await workingState.recordNonCommit(
      context,
      'patch_invalid'
    );
    return rejected.guidance ?? [];
  }

  const outcome = await workingState.commit(validation.patch, context, signal);
  return outcome.guidance ?? [];
}

/**
 * Run one `skillState` turn. There is no proposer: the actor emitted the patch
 * itself as a typed output field, so the turn goes straight to validation and
 * the kernel. An ABSENT patch is not an error — it means the turn proved
 * nothing, and the state is carried forward unchanged.
 */
async function runSkillStateTurn(
  runtime: AxSkillStateRuntime<any>,
  workingState: AxWorkingState<any>,
  context: AxWorkingStateCommitContext,
  output: Readonly<{ statePatch?: unknown; rationale?: unknown }>,
  signal: AbortSignal | undefined
): Promise<readonly AxWorkingStateGuidanceNote[]> {
  const document = output.statePatch;
  if (document === undefined || document === null) {
    await workingState.recordNonCommit(context, 'none');
    return [];
  }
  const rationale =
    typeof output.rationale === 'string' ? output.rationale : undefined;
  await runtime.applyPatch(document, rationale, context, signal);
  return runtime.lastGuidance();
}

/**
 * Harness-authored interlock guidance: goal ids and statuses only, never
 * model-authored prose.
 */
function buildCompletionInterlockGuidance(
  pendingGoalIds: readonly string[]
): string {
  return (
    'Working state still lists pending goals, so the run was not completed: ' +
    `${pendingGoalIds.join(', ')}. ` +
    'Either produce the tool receipt each goal expects and cite it, or mark the goal blocked with a blocker, then finish.'
  );
}

function extractRawActorCode(
  chatLog: readonly AxChatLogEntry[],
  runtimeCodeFieldTitle: string
): string | undefined {
  const messages = chatLog[chatLog.length - 1]?.messages;
  if (!messages) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant') {
      continue;
    }

    const content = message.content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/[^\n]*<\/think>/g, '')
      .trim();

    const prefix = `${runtimeCodeFieldTitle}:`;
    const prefixIndex = content.indexOf(prefix);
    if (prefixIndex >= 0) {
      return content.slice(prefixIndex + prefix.length).trim();
    }
    return content;
  }

  return undefined;
}

function containsMultipleFencedCodeBlocks(code: string): boolean {
  let insideFence = false;
  let blockCount = 0;

  for (const line of code.split(/\r?\n/)) {
    // Match the same triple-backtick opener shape accepted by
    // normalizeActorCode, including prose before the first fence.
    const fence = line.match(/```([A-Za-z0-9_-]+)?[ \t]*$/);
    if (!fence) {
      continue;
    }

    const hasLanguage = fence[1] !== undefined;
    if (insideFence && !hasLanguage) {
      insideFence = false;
      continue;
    }

    blockCount++;
    if (blockCount > 1) {
      return true;
    }
    insideFence = true;
  }

  return false;
}

export async function runActorTurn<_IN extends AxGenIn>(
  ctx: ActorLoopContext,
  turn: number,
  _options: Readonly<AxProgramForwardOptions<string>> | undefined,
  _effectiveAbortSignal: AbortSignal | undefined,
  applyInputUpdateCallback: () => Promise<void>,
  _maxTurns: number
): Promise<{ shouldBreak: boolean; shouldContinue: boolean }> {
  const {
    s,
    ai,
    rlm,
    runtimeContext,
    inputState,
    completionState,
    guidanceState,
    actionLogEntries,
    actorMergedOptions,
    summaryForwardOptions,
    functionCallRecords,
    explicitActorDebugHideSystemPrompt,
    contextStage,
    contextThreshold,
    mutableState,
    workingState,
    workingStateObservations,
    skillState,
    helpers,
  } = ctx;

  const {
    refreshActorInstruction,
    buildActorPromptValues,
    measureActorPromptChars,
    renderActionLogParts,
    renderActionLogPartsWithReplayMode,
    resetActorModelErrorState,
    noteActorTurnErrorState,
    syncDiscoveredActorModelNamespaces,
    refreshCheckpointSummary,
  } = helpers;

  const actorInstruction = refreshActorInstruction();
  await applyInputUpdateCallback();
  inputState.recomputeTurnInputs(true);
  for (const promotion of inputState.drainAutoPromotionEvents()) {
    await emitContextEvent(s.onContextEvent, {
      kind: 'field_auto_promoted',
      stage: contextStage,
      turn: turn + 1,
      ...promotion,
    });
  }
  if (await refreshCheckpointSummary(actionLogEntries.length)) {
    resetActorModelErrorState();
  }

  // Refresh the working-state prompt regions BEFORE the prompt is measured or
  // sent, so the measured characters are the sent characters by construction.
  if (workingState) {
    s._workingStatePromptValues = {
      stateContract: workingState.stateContract(),
      workingState: workingState.renderWritable(),
      receiptRoster: workingState.renderReadOnly(),
    };
  }
  if (skillState) {
    // The two fields the substrate ADDS. `renderPrompt()` would re-run the
    // three working-state renders the block above just did and throw them
    // away, so the per-turn accessors are used instead.
    s._skillStatePromptValues = {
      skillSpec: skillState.skillSpec(),
      latestObservation: skillState.renderObservations(),
    };
  }

  // In `skillState` mode the action log is not rendered AT ALL: the cost the
  // mode exists to remove is the rendering and compaction of a growing
  // transcript, so skipping only the prompt field would keep paying it.
  let actionLogParts: ActionLogParts = skillState
    ? { summary: '', history: '', compactions: [] }
    : renderActionLogParts();
  let summarizedActorLogText = actionLogParts.summary || undefined;
  let actionLogText = actionLogParts.history || '(no actions yet)';
  const guidanceLogText = renderGuidanceLog(guidanceState.entries);
  // Build the value record ONCE and measure that exact record, so the measured
  // characters are the sent characters by construction. `contextPressure` is
  // the one field that cannot be inside the measurement: it is derived from it.
  let promptValues = buildActorPromptValues(
    actionLogText,
    guidanceLogText,
    mutableState.runtimeStateSummary,
    summarizedActorLogText
  );
  let inspectMetrics = await measureActorPromptChars(promptValues);
  let inspectFixedOverhead =
    inspectMetrics.systemPromptCharacters +
    inspectMetrics.exampleChatContextCharacters;
  let effectiveBudgetChars = computeEffectiveChatBudget(
    runtimeContext.effectiveContextConfig.targetPromptChars,
    inspectFixedOverhead
  );
  const checkpointActive = Boolean(mutableState.checkpointState);
  let pressure = classifyContextPressure({
    mutablePromptChars: inspectMetrics.mutableChatContextCharacters,
    effectiveBudgetChars,
    checkpointActive,
  });
  const pressureHygieneMode =
    runtimeContext.effectiveContextConfig.contextHygiene?.pressureMode;
  const defaultHygieneMode =
    runtimeContext.effectiveContextConfig.contextHygiene?.defaultMode ?? 'none';
  if (
    !skillState &&
    pressure !== 'ok' &&
    pressureHygieneMode &&
    pressureHygieneMode !== defaultHygieneMode
  ) {
    const cps = mutableState.checkpointState;
    const pressureParts = renderActionLogPartsWithReplayMode(
      runtimeContext.effectiveContextConfig.actionReplay,
      cps?.summary,
      cps?.turns,
      pressureHygieneMode
    );
    const pressureActionLogText = pressureParts.history || '(no actions yet)';
    const pressureSummarizedActorLogText = pressureParts.summary || undefined;
    const pressureValues = buildActorPromptValues(
      pressureActionLogText,
      guidanceLogText,
      mutableState.runtimeStateSummary,
      pressureSummarizedActorLogText
    );
    const pressureMetrics = await measureActorPromptChars(pressureValues);
    if (
      pressureMetrics.mutableChatContextCharacters <
      inspectMetrics.mutableChatContextCharacters
    ) {
      actionLogParts = pressureParts;
      actionLogText = pressureActionLogText;
      summarizedActorLogText = pressureSummarizedActorLogText;
      promptValues = pressureValues;
      inspectMetrics = pressureMetrics;
      inspectFixedOverhead =
        inspectMetrics.systemPromptCharacters +
        inspectMetrics.exampleChatContextCharacters;
      effectiveBudgetChars = computeEffectiveChatBudget(
        runtimeContext.effectiveContextConfig.targetPromptChars,
        inspectFixedOverhead
      );
      pressure = classifyContextPressure({
        mutablePromptChars: inspectMetrics.mutableChatContextCharacters,
        effectiveBudgetChars,
        checkpointActive,
      });
    }
  }
  const contextPressureText =
    runtimeContext.effectiveContextConfig.preset !== 'full'
      ? renderContextPressure(pressure)
      : undefined;
  for (const compaction of actionLogParts.compactions) {
    await emitContextEvent(s.onContextEvent, {
      kind: 'action_compacted',
      stage: contextStage,
      turn: compaction.turn,
      mode: compaction.mode,
      reason: compaction.reason,
      originalChars: compaction.originalChars,
      renderedChars: compaction.renderedChars,
    });
  }
  await emitContextEvent(s.onContextEvent, {
    kind: 'budget_check',
    stage: contextStage,
    turn: turn + 1,
    pressure,
    mutablePromptChars: inspectMetrics.mutableChatContextCharacters,
    fixedPromptChars: inspectFixedOverhead,
    effectiveBudgetChars,
    targetPromptChars: runtimeContext.effectiveContextConfig.targetPromptChars,
    checkpointActive,
    actionLogEntryCount: actionLogEntries.length,
    guidanceLogEntryCount: guidanceState.entries.length,
  });
  if (
    contextThreshold &&
    inspectMetrics.mutableChatContextCharacters >
      computeEffectiveChatBudget(contextThreshold, inspectFixedOverhead)
  ) {
    actionLogText +=
      '\n\n[HINT: Actor prompt is large. Call `const state = await inspectRuntime()` for a compact snapshot of current variables instead of re-reading old outputs.]';
    // Deliberately AFTER the measurement: the hint exists because the prompt is
    // already over budget, so counting it would move the budget it reacts to.
    if ('actionLog' in promptValues) {
      promptValues = { ...promptValues, actionLog: actionLogText };
    }
  }

  let actorCallOptions = actorMergedOptions;
  if (s.executorModelPolicy) {
    syncDiscoveredActorModelNamespaces();
    const selectedModel = selectActorModelFromPolicy(
      s.executorModelPolicy,
      getActorModelConsecutiveErrorTurns(mutableState.actorModelState),
      getActorModelMatchedNamespaces(mutableState.actorModelState)
    );
    actorCallOptions =
      selectedModel !== undefined
        ? {
            ...actorMergedOptions,
            model: selectedModel,
          }
        : actorMergedOptions;
  }

  const debugHideSystemPrompt =
    explicitActorDebugHideSystemPrompt ??
    (turn > 0 &&
      actorInstruction === mutableState.lastDebugLoggedActorInstruction);
  actorCallOptions = {
    ...actorCallOptions,
    debugHideSystemPrompt,
  };

  const usageBefore = s.actorProgram.getUsage()?.length ?? 0;
  const actorTurnCallback = rlm.actorTurnCallback;

  const executorResult = await s.actorProgram.forward(
    ai,
    contextPressureText
      ? { ...promptValues, contextPressure: contextPressureText }
      : promptValues,
    actorCallOptions
  );
  if (!debugHideSystemPrompt) {
    mutableState.lastDebugLoggedActorInstruction = actorInstruction;
  }

  // Capture per-turn metadata for the callback.
  const turnUsage = actorTurnCallback
    ? (s.actorProgram.getUsage()?.slice(usageBefore) as
        | AxProgramUsage[]
        | undefined)
    : undefined;
  const turnModel =
    actorCallOptions.model !== undefined
      ? String(actorCallOptions.model)
      : undefined;
  const actorChatLog = s.actorProgram.getChatLog();
  const turnChatLogMessages = actorTurnCallback
    ? snapshotChatLogMessages(actorChatLog)
    : undefined;

  if (turn === 0) {
    mutableState.restoreNotice = undefined;
  }

  const runtimeCodeFieldName = s.runtimeCodeFieldName ?? 'javascriptCode';
  const runtimeCodeFieldTitle = s.runtimeCodeFieldTitle ?? 'Javascript Code';
  let code = executorResult[runtimeCodeFieldName] as string | undefined;
  const trimmedCode = code?.trim();
  // Code-field parsing extracts the first Markdown fence, so inspect the raw
  // response before a later block can disappear from the actor turn.
  const rawResponseCode = extractRawActorCode(
    actorChatLog,
    runtimeCodeFieldTitle
  )?.trim();
  const codeBeforeNormalization = rawResponseCode ?? trimmedCode;
  const hasMultipleFencedCodeBlocks =
    typeof codeBeforeNormalization === 'string' &&
    containsMultipleFencedCodeBlocks(codeBeforeNormalization);
  if (hasMultipleFencedCodeBlocks) {
    code = codeBeforeNormalization;
  } else {
    if (!code || !trimmedCode) {
      return { shouldBreak: true, shouldContinue: false };
    }
    code = normalizeActorCode(trimmedCode);
  }
  executorResult[runtimeCodeFieldName] = code;

  completionState.payload = undefined;
  const functionCallStartIndex = functionCallRecords?.length ?? 0;

  if (hasMultipleFencedCodeBlocks || s.enforceIncrementalConsoleTurns) {
    const policyResult = hasMultipleFencedCodeBlocks
      ? {
          violation: buildMultipleCodeBlocksPolicyViolation(
            runtimeCodeFieldTitle
          ),
        }
      : validateActorTurnCodePolicy(code);

    // Auto-split: discovery mixed with other code — run discovery first,
    // then proceed to execute the full code block (discovery calls are
    // idempotent so re-running is safe).
    if (policyResult?.autoSplitDiscoveryCode) {
      await runtimeContext.executeActorCode(
        policyResult.autoSplitDiscoveryCode
      );
    }

    if (policyResult?.violation) {
      const policyViolation = policyResult.violation;
      const entryTurn = actionLogEntries.length + 1;
      appendGuidanceEntry(guidanceState.entries, {
        turn: entryTurn,
        guidance: hasMultipleFencedCodeBlocks
          ? buildMultipleCodeBlocksPolicyGuidance(runtimeCodeFieldTitle)
          : ACTOR_CODE_POLICY_GUIDANCE,
        triggeredBy: 'runtime policy',
      });
      actionLogEntries.push({
        turn: entryTurn,
        code,
        output: policyViolation,
        tags: ['error'],
        ...(() => {
          const calls =
            functionCallRecords?.slice(functionCallStartIndex) ?? [];
          return calls.length > 0 ? { _functionCalls: calls } : {};
        })(),
      });
      // This branch returns before the normal `skillState?.observe(...)` at
      // the end of the turn. In `skillState` mode the observation is the ONLY
      // history the actor sees, so without this the refused turn would be
      // invisible to it and the same code could be re-emitted forever.
      skillState?.observe(policyViolation, entryTurn);

      if (actorTurnCallback) {
        await actorTurnCallback({
          stage: contextStage,
          turn: entryTurn,
          actionLogEntryCount: actionLogEntries.length,
          guidanceLogEntryCount: guidanceState.entries.length,
          executorResult: executorResult as Record<string, unknown>,
          code,
          result: undefined,
          output: policyViolation,
          isError: true,
          thought:
            typeof executorResult.thought === 'string'
              ? executorResult.thought
              : undefined,
          usage: turnUsage,
          model: turnModel,
          chatLogMessages: turnChatLogMessages,
        });
      }

      await manageContext(
        actionLogEntries,
        actionLogEntries.length - 1,
        runtimeContext.effectiveContextConfig,
        ai,
        summaryForwardOptions,
        { stage: contextStage, onContextEvent: s.onContextEvent }
      );
      noteActorTurnErrorState(true);
      if (await refreshCheckpointSummary(entryTurn)) {
        resetActorModelErrorState();
      }
      return { shouldBreak: false, shouldContinue: true };
    }
  }

  if (s.inputUpdateCallback) {
    await runtimeContext.syncRuntimeInputsToSession();
  }
  let result: unknown;
  let output: string;
  let isError: boolean;

  try {
    const executionResult = await runtimeContext.executeActorCode(code);
    result = executionResult.result;
    output = executionResult.output;
    isError = executionResult.isError;
  } catch (err) {
    if (
      err instanceof AxAgentClarificationError ||
      err instanceof AxAIServiceAbortedError ||
      s.shouldBubbleUserError(err)
    ) {
      const bubbledError = err instanceof Error ? err : new Error(String(err));
      if (actorTurnCallback) {
        await actorTurnCallback({
          stage: contextStage,
          turn: actionLogEntries.length + 1,
          actionLogEntryCount: actionLogEntries.length,
          guidanceLogEntryCount: guidanceState.entries.length,
          executorResult: executorResult as Record<string, unknown>,
          code,
          result: undefined,
          output: formatBubbledActorTurnOutput(
            bubbledError,
            runtimeContext.effectiveContextConfig.maxRuntimeChars
          ),
          isError:
            err instanceof AxAIServiceAbortedError ||
            s.shouldBubbleUserError(err),
          thought:
            typeof executorResult.thought === 'string'
              ? executorResult.thought
              : undefined,
          usage: turnUsage,
          model: turnModel,
          chatLogMessages: turnChatLogMessages,
        });
      }
    }
    throw err;
  }

  const completionPayload = completionState.payload as
    | AxAgentInternalCompletionPayload
    | undefined;
  const guidancePayload =
    completionPayload?.type === 'guide_agent'
      ? (completionPayload as AxAgentGuidancePayload)
      : undefined;
  if (guidancePayload) {
    const nextTurn = actionLogEntries.length + 1;
    appendGuidanceEntry(guidanceState.entries, {
      turn: nextTurn,
      guidance: guidancePayload.guidance,
      ...(guidancePayload.triggeredBy
        ? { triggeredBy: guidancePayload.triggeredBy }
        : {}),
    });
    result = undefined;
    output = buildGuidanceActionLogOutput(guidancePayload);
    isError = false;
  }

  const discoveryTurnArtifacts = runtimeContext.consumeDiscoveryTurnArtifacts();
  if (!isError) {
    output = stripDiscoveryTurnOutput(output, discoveryTurnArtifacts.texts);
    output = appendDiscoveryTurnSummary(output, discoveryTurnArtifacts.summary);
  }

  const entryTurn = actionLogEntries.length + 1;
  const actionLogCode = guidancePayload
    ? buildGuidanceActionLogCode(guidancePayload)
    : code;
  actionLogEntries.push({
    turn: entryTurn,
    code: actionLogCode,
    output,
    tags: isError ? ['error'] : [],
    ...(() => {
      const calls = functionCallRecords?.slice(functionCallStartIndex) ?? [];
      return calls.length > 0 ? { _functionCalls: calls } : {};
    })(),
  });

  // Working state, when configured, mints this turn's receipts from the
  // dispatches the harness observed. Nothing here can run for a default agent:
  // `workingState` is undefined and the observation buffer does not exist.
  const mintedReceiptRefs: string[] = [];
  if (workingState && workingStateObservations) {
    const observed = workingStateObservations.splice(
      0,
      workingStateObservations.length
    );
    for (const observation of observed) {
      const receipt = await workingState.recordReceipt({
        qualifiedName: observation.qualifiedName,
        arguments: observation.arguments,
        result: observation.result,
        turn: entryTurn,
        at: observation.at,
      });
      if (!mintedReceiptRefs.includes(receipt.ref)) {
        mintedReceiptRefs.push(receipt.ref);
      }
    }

    const turnCalls = [
      ...new Set(
        (functionCallRecords?.slice(functionCallStartIndex) ?? []).map(
          (record) => record.qualifiedName
        )
      ),
    ];
    // The completion interlock, when enabled, is resolved AFTER this turn's
    // commit so it decides against the committed ledger: a patch in this same
    // turn may have just completed the last pending goal.
    let interlockDecision: 'converted' | 'exhausted' | undefined;
    let interlockGoals: readonly string[] = [];
    const resolveCompletionInterlock = ():
      | 'converted'
      | 'exhausted'
      | undefined => {
      if (workingState.completionPolicy() !== 'interlock') return undefined;
      const payload = completionState.payload as
        | AxAgentInternalCompletionPayload
        | undefined;
      if (!payload || payload.type !== 'final') return undefined;
      const pending = workingState.pendingGoalIds();
      if (pending.length === 0) return undefined;
      interlockGoals = pending;
      interlockDecision = workingState.consumeCompletionInterlock();
      return interlockDecision;
    };

    const commitContext: AxWorkingStateCommitContext = {
      action: actionLogCode,
      observation: output,
      turn: entryTurn,
      isError,
      receiptRefs: mintedReceiptRefs,
      calls: turnCalls,
      selectedSkills: (mutableState.usedSkills ?? []).map(
        (used: { id: string }) => used.id
      ),
      resolveCompletionInterlock,
    };
    // The observation is recorded BEFORE the patch is applied so a rejected
    // patch still leaves the model looking at what actually happened.
    skillState?.observe(output, entryTurn);
    const guidanceNotes = skillState
      ? await runSkillStateTurn(
          skillState,
          workingState,
          commitContext,
          executorResult as Readonly<{
            statePatch?: unknown;
            rationale?: unknown;
          }>,
          _effectiveAbortSignal
        )
      : await runWorkingStateTurn(
          workingState,
          commitContext,
          { action: actionLogCode, observation: output },
          _effectiveAbortSignal
        );
    const guidanceText = buildWorkingStateGuidance(guidanceNotes);
    if (guidanceText) {
      appendGuidanceEntry(guidanceState.entries, {
        turn: entryTurn,
        guidance: guidanceText,
        triggeredBy: 'working state',
      });
    }

    if (interlockDecision === 'converted') {
      // Reuse the loop's existing `guide_agent` handling rather than
      // inventing a completion shape: append the harness guidance, replace
      // the payload, and let the tail branch below continue the loop. The
      // guidance names goal ids and statuses only, never model prose.
      appendGuidanceEntry(guidanceState.entries, {
        turn: entryTurn,
        guidance: buildCompletionInterlockGuidance(interlockGoals),
        triggeredBy: 'working-state',
      });
      completionState.payload = {
        type: 'guide_agent',
        triggeredBy: 'working-state',
        guidance: buildCompletionInterlockGuidance(interlockGoals),
      } as AxAgentGuidancePayload;
    }
  }

  if (actorTurnCallback) {
    await actorTurnCallback({
      stage: contextStage,
      turn: entryTurn,
      actionLogEntryCount: actionLogEntries.length,
      guidanceLogEntryCount: guidanceState.entries.length,
      executorResult: executorResult as Record<string, unknown>,
      code,
      result,
      output,
      isError,
      thought:
        typeof executorResult.thought === 'string'
          ? executorResult.thought
          : undefined,
      usage: turnUsage,
      model: turnModel,
      chatLogMessages: turnChatLogMessages,
    });
  }

  await manageContext(
    actionLogEntries,
    actionLogEntries.length - 1,
    runtimeContext.effectiveContextConfig,
    ai,
    summaryForwardOptions,
    { stage: contextStage, onContextEvent: s.onContextEvent }
  );
  if (!isError) {
    mutableState.runtimeStateSummary =
      await runtimeContext.captureRuntimeStateSummary();
  }
  noteActorTurnErrorState(isError);
  if (await refreshCheckpointSummary(entryTurn)) {
    resetActorModelErrorState();
  }

  if (completionState.payload && 'guidance' in completionState.payload) {
    completionState.payload = undefined;
    return { shouldBreak: false, shouldContinue: true };
  }

  if (completionState.payload) {
    return { shouldBreak: true, shouldContinue: false };
  }

  return { shouldBreak: false, shouldContinue: false };
}
