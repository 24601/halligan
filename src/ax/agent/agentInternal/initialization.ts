import { AxGen } from '../../dsp/generate.js';
import type { AxTunable, AxUsable } from '../../dsp/types.js';
import { AxJSRuntime } from '../../funcs/jsRuntime.js';
import {
  axCallTimeSkillCatalogResolver,
  axValidateCallTimeSkillBindings,
} from '../callTimeSkills.js';
import {
  DEFAULT_CONTEXT_FIELD_PROMPT_MAX_CHARS,
  RELEVANCE_RANKING_DEFAULT,
  resolveAutoUpgrade,
  resolveDirectResponse,
  resolveExecutorModelPolicy,
} from '../config.js';
import { getRuntimeLanguageInfo } from '../rlm.js';
import {
  DISCOVERY_DISCOVER_NAME,
  normalizeContextFields,
  shouldEnforceIncrementalConsoleTurns,
} from '../runtime.js';
import {
  estimateInlineFunctionDocChars,
  normalizeAgentFunctionCollection,
  toCamelCase,
} from '../runtimeDiscovery.js';
import { axValidateSkillStateConfig } from '../skillState.js';
import {
  AxWorkingStateSchemaError,
  axValidateWorkingStateConfig,
} from '../workingState.js';
import { createCatalogMemoriesSearch } from './memoriesHelpers.js';
import {
  createCatalogSkillsSearch,
  createMutableSkillsPromptState,
  ingestSkillResults,
} from './skillsHelpers.js';
import { resolveStagePolicy } from './stagePolicy.js';

export function initializeAgentInternal(
  self: any,
  init: any,
  options: any
): void {
  const s = self as any;
  const { ai, judgeAI, agentIdentity, signature } = init;

  // Resolve the stage's behavioral policy once; every stage-conditional in
  // the agent internals reads named capabilities from this object.
  s.stagePolicy = resolveStagePolicy(options.stageVariant);

  // §6.5: a working-state config that cannot work must fail HERE, not at the
  // first `forward()` forty turns into a run. The per-run resolution still
  // happens once per `forward()`; this is only the config-time gate.
  if (options.workingState) {
    axValidateWorkingStateConfig(options.workingState);
  }
  if (options.actorMemoryMode === 'skillState') {
    // The mode's prompt IS the state document plus the frozen spec. Without
    // either one there is nothing to build a prompt from, and guessing a
    // substitute would be worse than failing.
    if (!options.workingState) {
      throw new AxWorkingStateSchemaError('skillstate_requires_working_state');
    }
    if (!options.skillState) {
      throw new AxWorkingStateSchemaError('skillstate_requires_skill');
    }
    axValidateSkillStateConfig(options.skillState);
  }

  const {
    debug,
    contextFields = [],
    runtime,
    maxSubAgentCalls,
    maxBatchedLlmQueryConcurrency,
    maxTurns,
    maxRuntimeChars,
    maxEvidenceChars,
    contextPolicy,
    summarizerOptions,
    actorTurnCallback,
    agentStatusCallback,
    mode,
    executorModelPolicy,
    recursionOptions,
    executorOptions,
    responderOptions,
    judgeOptions,
    inputUpdateCallback,
    bubbleErrors,
    onFunctionCall,
    onContextEvent,
    contextMapText,
  } = options;

  s.ai = ai;
  s.judgeAI = judgeAI;
  s.agentIdentity = agentIdentity ? { ...agentIdentity } : undefined;
  s.autoUpgrade = resolveAutoUpgrade(options.autoUpgrade);
  s.functionDiscoveryEnabled = options.functionDiscovery ?? false;
  // Advisory relevance ranker. Each domain lights up only when its
  // prerequisite is met: modules need discovery; skills/memories need their
  // catalogs (later phases OR into `relevanceHintsEnabled`).
  const relevanceRankingOpt = options.relevanceRanking;
  const relevanceRankingChoice =
    relevanceRankingOpt === undefined
      ? RELEVANCE_RANKING_DEFAULT
      : relevanceRankingOpt !== false;
  s._relevanceRankingChoice = relevanceRankingChoice;
  s.relevanceRankingOptions =
    typeof relevanceRankingOpt === 'object' && relevanceRankingOpt !== null
      ? relevanceRankingOpt
      : {};
  s.moduleHintEnabled = s.functionDiscoveryEnabled && relevanceRankingChoice;
  // Skills: a static catalog backs discover({skills}) with a built-in local
  // search when the host provides no callback; the host callback always wins.
  const skillsCatalog = Array.isArray(options.skillsCatalog)
    ? options.skillsCatalog.slice()
    : undefined;
  // The construction-time inputs are kept separately from the effective
  // catalog so a managed slot (`setSkillsCatalogSlot`) can be added and
  // removed without ever losing what the host originally supplied, and so the
  // slot setter can refuse an agent whose search callback is the host's.
  s.skillsCatalogBase = skillsCatalog;
  s.hostSkillsSearch = options.onSkillsSearch;
  // Resolved ONCE and held for the agent's lifetime: the Available Skills index
  // is built at signature-build time, and recomputing eligibility per run would
  // churn the signature and therefore the prompt cache. A host whose
  // environment changed constructs a new agent.
  s.skillEnvironment = options.skillPolicy?.environment;
  rebuildSkillsSearch(s);
  // Call-time skill bindings are validated HERE, after the effective skills
  // catalog exists, so an unresolvable skill id or a `when` predicate with no
  // working state to read fails at construction.
  //
  // `unknown_bound_callable` is deliberately NOT checked here: MCP and UCP
  // callables only exist once a run's execution context does, so a
  // constructor-time check would reject every legitimate `mcp.*` binding. It
  // is enforced at run start instead, once the full callable surface is
  // registered.
  if (options.callTimeSkills !== undefined) {
    axValidateCallTimeSkillBindings(options.callTimeSkills, {
      hasWorkingState: options.workingState !== undefined,
      resolveSkill: axCallTimeSkillCatalogResolver(s.skillsCatalog),
    });
  }
  s.onLoadedSkills = options.onLoadedSkills;
  s.onUsedSkills = options.onUsedSkills;
  // Memories: a static catalog backs recall(...) with a built-in local search
  // when the host provides no callback; the host callback always wins.
  const memoriesCatalog = Array.isArray(options.memoriesCatalog)
    ? options.memoriesCatalog.slice()
    : undefined;
  s.memoriesCatalog = memoriesCatalog;
  s.onMemoriesSearch =
    options.onMemoriesSearch ??
    (memoriesCatalog && memoriesCatalog.length > 0
      ? createCatalogMemoriesSearch(memoriesCatalog)
      : undefined);
  s.onLoadedMemories = options.onLoadedMemories;
  s.onUsedMemories = options.onUsedMemories;
  s.memoryUsageTrackingEnabled =
    typeof s.onMemoriesSearch === 'function' &&
    typeof options.onUsedMemories === 'function';
  s.memoriesHintEnabled =
    relevanceRankingChoice &&
    Array.isArray(memoriesCatalog) &&
    memoriesCatalog.length > 0;
  s.relevanceHintsEnabled =
    s.moduleHintEnabled || s.skillsHintEnabled || s.memoriesHintEnabled;
  s.skillPolicy = options.skillPolicy;
  s.verifierRails = Array.isArray(options.verifierRails)
    ? options.verifierRails.slice()
    : undefined;
  s.onSkillCost = options.onSkillCost;
  // `onSkillCost` alone must enable tracking: without it `noteUsed`'s skills
  // branch returns early, every profile stays empty, and cost-aware ranking is
  // silently inert.
  s.skillUsageTrackingEnabled =
    typeof options.onUsedSkills === 'function' ||
    typeof options.onSkillCost === 'function';
  s.usageTrackingEnabled =
    s.memoryUsageTrackingEnabled || s.skillUsageTrackingEnabled;
  s.currentSkillsPromptState = createMutableSkillsPromptState();
  s.presetSkills = Array.isArray(options.skills)
    ? options.skills.slice()
    : undefined;
  if (s.presetSkills && s.presetSkills.length > 0) {
    ingestSkillResults(s.currentSkillsPromptState, s.presetSkills);
  }
  s.debug = debug;
  s.options = options;
  s.contextMapText =
    typeof contextMapText === 'string' && contextMapText.trim()
      ? contextMapText
      : undefined;
  s.runtime = runtime ?? new AxJSRuntime();
  const runtimeLanguageInfo = getRuntimeLanguageInfo(s.runtime);
  s.runtimeLanguageName = runtimeLanguageInfo.languageName;
  s.runtimeCodeFieldName = runtimeLanguageInfo.codeFieldName;
  s.runtimeCodeFieldTitle = runtimeLanguageInfo.codeFieldTitle;
  s.runtimeCodeFenceLanguage = runtimeLanguageInfo.codeFenceLanguage;
  s.isJavaScriptRuntime = runtimeLanguageInfo.isJavaScript;
  s.runtimeUsageInstructions = s.runtime.getUsageInstructions();
  s.enforceIncrementalConsoleTurns = shouldEnforceIncrementalConsoleTurns(
    s.runtimeUsageInstructions,
    { isJavaScriptRuntime: s.isJavaScriptRuntime }
  );

  const reservedAgentFunctionNamespaces = s._reservedAgentFunctionNamespaces();
  const localAgentFnBundle = normalizeAgentFunctionCollection(
    options.functions,
    reservedAgentFunctionNamespaces
  );
  s.agentFunctions = localAgentFnBundle.functions;
  s.agents = localAgentFnBundle.agents;
  s._mergeAgentFunctionModuleMetadata(localAgentFnBundle.moduleMetadata);

  // Direct-respond resolution. Static = the agent has no executor-only
  // authority (no user functions, no child agents; discovery modules derive
  // from the function set, so zero functions ⇒ zero modules) — the distiller
  // runs respond-only and the executor skip is deterministic. Both stage
  // instances see the same shared `functions` option, so they always agree.
  s.directRespondEnabled =
    resolveDirectResponse(options.directResponse) !== 'off';
  s.directRespondStatic =
    localAgentFnBundle.functions.length === 0 &&
    localAgentFnBundle.agents.length === 0;

  // Auto-upgrade: enable discovery for large tool catalogs unless the caller
  // decided explicitly. Deterministic from the shared function set, so the
  // distiller and executor stages always agree. Skipped when a `discover`
  // namespace exists — auto must never turn a working construction into a
  // reserved-namespace validation error.
  if (
    options.functionDiscovery === undefined &&
    s.autoUpgrade.functionDiscovery.enabled &&
    !s.agentFunctions.some(
      (fn: { namespace?: string }) =>
        (fn.namespace ?? 'utils') === DISCOVERY_DISCOVER_NAME
    ) &&
    estimateInlineFunctionDocChars(s.agentFunctions) >
      s.autoUpgrade.functionDiscovery.aboveFunctionDocChars
  ) {
    s.functionDiscoveryEnabled = true;
    // Hint flags were derived above from the pre-decision discovery flag.
    s.moduleHintEnabled = relevanceRankingChoice;
    s.relevanceHintsEnabled =
      s.moduleHintEnabled || s.skillsHintEnabled || s.memoriesHintEnabled;
  }

  // Create the base program (used for signature/schema access).
  // `description` is stripped because AxAgent owns the per-stage prompts;
  // letting it through would stamp the signature and trip the validator.
  const {
    functions: _fn,
    functionDiscovery: _fd,
    autoUpgrade: _au,
    directResponse: _drs,
    relevanceRanking: _rr,
    skills: _sk,
    skillsCatalog: _skc,
    memoriesCatalog: _mc,
    onSkillsSearch: _oss,
    onLoadedSkills: _ols,
    onUsedSkills: _ous,
    skillPolicy: _sp,
    verifierRails: _vr,
    onSkillCost: _osc,
    onMemoriesSearch: _oms,
    onLoadedMemories: _olm,
    onUsedMemories: _oum,
    judgeOptions: _jo,
    inputUpdateCallback: _iuc,
    executorModelPolicy: _amp,
    maxRuntimeChars: _mrc,
    maxEvidenceChars: _mec,
    summarizerOptions: _so,
    actorTurnCallback: _atc,
    onFunctionCall: _ofc,
    onContextEvent: _oce,
    contextMap: _cm,
    contextMapText: _cmt,
    description: _desc,
    mem: _mem,
    ...genOptions
  } = options as typeof options & { description?: string };
  s.program = new AxGen(signature, genOptions);
  const inputFields = s.program.getSignature().getInputFields();

  const normalizedContext = normalizeContextFields(
    contextFields,
    inputFields,
    DEFAULT_CONTEXT_FIELD_PROMPT_MAX_CHARS
  );
  s.contextPromptConfigByField = normalizedContext.promptConfigByField;

  s.rlmConfig = {
    contextFields: normalizedContext.contextFieldNames,
    promptLevel: options.promptLevel,
    runtime: s.runtime,
    maxSubAgentCalls,
    maxBatchedLlmQueryConcurrency,
    maxTurns,
    maxRuntimeChars,
    maxEvidenceChars,
    contextPolicy,
    summarizerOptions,
    actorTurnCallback,
    onContextEvent,
    agentStatusCallback,
    mode,
  };
  s.recursionForwardOptions = recursionOptions;
  s.bubbleErrors = bubbleErrors;

  const { description: executorDescription, ...executorForwardOptions } =
    executorOptions ?? {};
  // The responder description and forward options now belong to the
  // pipeline's Synthesizer stages — the actor agent itself is responder-free.
  void responderOptions;

  s.executorDescription = executorDescription;
  s.executorModelPolicy = resolveExecutorModelPolicy(executorModelPolicy);
  s.executorForwardOptions = executorForwardOptions;

  s.judgeOptions = judgeOptions ? { ...judgeOptions } : undefined;
  s.inputUpdateCallback = inputUpdateCallback;
  s.agentStatusCallback = agentStatusCallback;
  s.onFunctionCall = onFunctionCall;
  s.onContextEvent = onContextEvent;

  // Register child agents (those that arrived via `options.functions`) as
  // DSPy sub-programs so optimizer reach-through is preserved. Stages that
  // don't own child agents (the distiller) still receive the function set
  // for catalogs/discovery but must not duplicate optimizer ownership.
  if (s.stagePolicy.ownsChildAgents) {
    for (const agent of (s.agents ?? []) as readonly {
      getFunction: () => { name: string };
    }[]) {
      const childName = agent.getFunction().name;
      s.program.register(
        agent as unknown as Readonly<AxTunable<any, any> & AxUsable>,
        childName
      );
    }
  } else {
    s.agents = undefined;
  }

  // Only set up function metadata when agentIdentity is provided
  if (agentIdentity) {
    s.func = {
      name: toCamelCase(agentIdentity.name),
      componentId: `agent:${agentIdentity.namespace ? `${agentIdentity.namespace}:` : ''}${toCamelCase(agentIdentity.name)}`,
      description: agentIdentity.description,
      parameters: s._buildFuncParameters(),
      func: async () => {
        throw new Error('Use getFunction() to get a callable wrapper');
      },
    };
  }

  // ----- Split architecture setup -----

  const allAgentFns = [...s.agentFunctions];

  for (const fn of allAgentFns) {
    if (!fn.parameters) {
      throw new Error(
        `Agent function "${fn.name}" must define parameters schema for agent runtime usage.`
      );
    }
    if (fn.examples) {
      for (const [index, example] of fn.examples.entries()) {
        if (!example.code.trim()) {
          throw new Error(
            `Agent function "${fn.name}" example at index ${index} must define non-empty code`
          );
        }
      }
    }
  }

  s._validateConfiguredSignature(s.program.getSignature());
  s._validateAgentFunctionNamespaces(allAgentFns);

  // Build the Actor program from the current signature and config. The
  // Synthesizer (responder) is owned by the pipeline, not by this agent.
  s._buildSplitPrograms();

  // Register the Actor with a DSPy-compatible name so optimizers can discover
  // it via getTraces() and so setDemos()/applyOptimization() propagate.
  s.program.register(
    s.actorProgram as unknown as Readonly<AxTunable<any, any> & AxUsable>,
    'actor'
  );
}

/**
 * Recompute everything derived from the skills catalog: the merged catalog,
 * the search callback that backs `discover({ skills })`, and the two advisory
 * hint flags.
 *
 * Called once at construction and again by `setSkillsCatalogSlot(...)`. The
 * hint flags are part of the derivation on purpose: `skillsHintEnabled` gates
 * whether the catalog is ranked into the Likely Relevant section at all
 * (`actorLoop.ts`), so a slot that injected skills without recomputing it
 * would install skills the actor is never hinted about.
 */
export function rebuildSkillsSearch(self: any): void {
  const s = self as any;
  const base: readonly any[] = Array.isArray(s.skillsCatalogBase)
    ? s.skillsCatalogBase
    : [];
  const slots: Map<string, readonly any[]> | undefined = s.skillsCatalogSlots;
  // Slot order is the slot NAME, not insertion order: the effective catalog
  // has to be a pure function of the installed slots so two hosts that install
  // the same tree get the same prompt.
  const slotted =
    slots === undefined
      ? []
      : [...slots.keys()].sort().flatMap((slot) => slots.get(slot) ?? []);
  const merged = [...base, ...slotted];
  s.skillsCatalog = Array.isArray(s.skillsCatalogBase) ? merged : undefined;
  s.onSkillsSearch =
    s.hostSkillsSearch ??
    (merged.length > 0
      ? createCatalogSkillsSearch(
          merged,
          s.skillEnvironment,
          // Read per search, not captured: the run's authority re-check is
          // computed in `actorLoop` and a skill it parked or dropped must not
          // come back through `discover({ skills })`.
          () => s._skillRetrievalGate
        )
      : undefined);
  s.skillsHintEnabled = Boolean(s._relevanceRankingChoice) && merged.length > 0;
  s.relevanceHintsEnabled =
    s.moduleHintEnabled || s.skillsHintEnabled || s.memoriesHintEnabled;
}
