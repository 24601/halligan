// index.test-d.ts — compile-time tests for the public API surface, enforced by
// `npm run test:type-tests` (tsc -p tsconfig.typetests.json). Agent typing is
// covered separately in agent/agent.test-d.ts.

// === Typesafe Signature Tests ===
import { AxSignature } from './dsp/sig.js';
import type { AxExamples } from './dsp/types.js';
import {
  type AxAgentFunction,
  type AxAIOpenAIChatRequest,
  type AxAIOpenAIConfig,
  type AxAIOpenAIResponsesConfig,
  type AxAIOpenAIResponsesRequest,
  type AxAIService,
  type AxCapabilityGrant,
  type AxCodeRuntime,
  AxDemandBoundary,
  type AxDemandDetector,
  type AxDemandStore,
  type AxEventComponentDefinition,
  type AxEventComponentInspection,
  type AxEvidenceObservation,
  type AxEvidenceRequirement,
  type AxExecutableSkillArtifact,
  type AxExecutableSkillSelection,
  type AxFunction,
  type AxFunctionHandler,
  type AxGuardEvaluation,
  type AxGuardFailureCode,
  type AxGuardOp,
  type AxHarnessEntry,
  type AxHarnessEvolveOptions,
  type AxHarnessGateDecision,
  type AxHarnessInstallTarget,
  type AxHarnessTree,
  AxInMemoryDemandStore,
  AxJSRuntime,
  type AxJSRuntimeSpeculationEvent,
  type AxLearningReceipt,
  type AxLearningRecord,
  type AxLearningStore,
  type AxLearningSurface,
  type AxMetricFn,
  type AxMetricResult,
  type AxMultiMetricFn,
  type AxParetoResult,
  type AxProgrammable,
  type AxProgramSource,
  ax,
  axAdmitHarnessTree,
  axApplyHarnessTree,
  axAssertPersistableValue,
  axCollectGrantRequirements,
  axCreateLearningEngineState,
  axCurrentHarnessInstallation,
  axDemandEventObserver,
  axEvaluateGuards,
  axEventComponentManager,
  axExecutableSkillRef,
  axHarnessContentId,
  axHarnessEvolve,
  axInMemoryLearningStore,
  axInspectHarnessTree,
  axIsEvidenceRequirement,
  axIsGuardPredicateFailure,
  axLearningEngineIngest,
  axLearningSurface,
  axNormalizeHarnessFailureCause,
  axProgramSourceRuntimeProtocol,
  axRenderHarnessTree,
  axReportSchema,
  axScoreWindowProcessor,
  axSelectExecutableSkills,
  f,
  flow,
  fn,
  optimize,
  programSource,
  react,
  runAxLearningStoreConformance,
} from './index.js';
import type { Equal, Expect, Flatten } from './util/typetest.js';

// === AxJSRuntime speculation public surface ===
const speculationEvents: AxJSRuntimeSpeculationEvent[] = [];
new AxJSRuntime({
  speculation: {
    callables: {
      'tools.lookup': { purity: 'pure', deterministic: true },
      llmQuery: { purity: 'pure', deterministic: false },
    },
    maxConcurrency: 4,
    maxCallsPerExecution: 16,
    onEvent: (event) => speculationEvents.push(event),
  },
});
new AxJSRuntime({
  speculation: {
    callables: {
      // @ts-expect-error speculation requires an explicit pure attestation
      'tools.write': { purity: 'impure', deterministic: true },
    },
  },
});

const componentManager = axEventComponentManager();
const componentDefinition = {
  id: 'typed-listener',
  version: '1',
  activate: async (context) =>
    context.acquire('listener', async (signal) => ({
      value: { signal, close: () => undefined },
      dispose: () => undefined,
    })),
} satisfies AxEventComponentDefinition<{
  signal: AbortSignal;
  close(): void;
}>;
void componentManager.define(componentDefinition);
const componentInspection: Readonly<AxEventComponentInspection> | undefined =
  componentManager.inspect('typed-listener');
void componentInspection;

// Extract (and flatten) the inferred field objects from an AxSignature so they
// can be compared against plain object literals with Equal.
type SigIn<S> = S extends AxSignature<infer I, any> ? Flatten<I> : never;
type SigOut<S> = S extends AxSignature<any, infer O> ? Flatten<O> : never;

// Test basic signature type inference
const basicSig = AxSignature.create('question: string -> answer: string');
type _basicIn = Expect<Equal<SigIn<typeof basicSig>, { question: string }>>;
type _basicOut = Expect<Equal<SigOut<typeof basicSig>, { answer: string }>>;

// Test signature with optional fields and arrays
const complexSig = AxSignature.create(
  'userInput: string, context?: string[] -> responseText: string, citations: number[]'
);
type _complexIn = Expect<
  Equal<SigIn<typeof complexSig>, { userInput: string; context?: string[] }>
>;
type _complexOut = Expect<
  Equal<
    SigOut<typeof complexSig>,
    { responseText: string; citations: number[] }
  >
>;

// Test signature with multiple types
const multiTypeSig = AxSignature.create(
  'title: string, count: number, isActive: boolean -> analysisResult: string, score: number'
);
type _multiTypeIn = Expect<
  Equal<
    SigIn<typeof multiTypeSig>,
    { title: string; count: number; isActive: boolean }
  >
>;
type _multiTypeOut = Expect<
  Equal<SigOut<typeof multiTypeSig>, { analysisResult: string; score: number }>
>;

// Test signature with missing types (should default to string)
const missingTypesSig = AxSignature.create(
  'question, animalImage: image -> answer'
);
type _missingTypesIn = Expect<
  Equal<
    SigIn<typeof missingTypesSig>,
    { question: string; animalImage: { mimeType: string; data: string } }
  >
>;
type _missingTypesOut = Expect<
  Equal<SigOut<typeof missingTypesSig>, { answer: string }>
>;

// Signatures that fail to parse keep the permissive fallback shape at the
// type level (runtime create() still throws on them)
const invalidSig = AxSignature.create('invalid format without arrow');
type _invalidIn = Expect<Equal<SigIn<typeof invalidSig>, Record<string, any>>>;
type _invalidOut = Expect<
  Equal<SigOut<typeof invalidSig>, Record<string, any>>
>;
const emptySig = AxSignature.create('');
type _emptyIn = Expect<Equal<SigIn<typeof emptySig>, Record<string, any>>>;

// === Advisory demand boundary type tests ===
const demandDetector: AxDemandDetector = {
  id: 'typed-detector',
  version: '1',
  detect: (observation) => ({
    outcome: observation.type === 'request' ? 'demand' : 'no_demand',
    confidence: 0.8,
    requestedDisposition: 'notify',
    reasonCode: 'typed_fixture',
    evidence: observation.provenance,
  }),
};
const demandStore: AxDemandStore = new AxInMemoryDemandStore();
const demandBoundary = new AxDemandBoundary({
  id: 'typed-boundary',
  detector: demandDetector,
  store: demandStore,
  validateStandingGrant: ({ reference, scope, signal }) => {
    void reference;
    void scope.principalScope;
    void signal;
    return 'unknown';
  },
});
const demandObserver: ReturnType<typeof axDemandEventObserver> =
  axDemandEventObserver(demandBoundary);
void demandObserver;

// @ts-expect-error detector is a required host-owned boundary
new AxDemandBoundary({});

// Test type-safe field addition methods
const testSig = AxSignature.create('userInput: string -> responseText: string');

// Test appendInputField type inference. Field-addition methods thread
// `isOptional` through to the type level — the added field is optional in the
// inferred inputs, matching the runtime field.
const withAppendedInput = testSig.appendInputField('contextInfo', {
  type: 'string',
  description: 'Context',
  isOptional: true,
});
type _appendedInputIn = Expect<
  Equal<
    SigIn<typeof withAppendedInput>,
    { userInput: string; contextInfo?: string }
  >
>;
type _appendedInputOut = Expect<
  Equal<SigOut<typeof withAppendedInput>, { responseText: string }>
>;

// Test prependInputField type inference
const withPrependedInput = testSig.prependInputField(
  'sessionId',
  f.string('Session ID')
);
type _prependedInputIn = Expect<
  Equal<
    SigIn<typeof withPrependedInput>,
    { sessionId: string; userInput: string }
  >
>;

// Test appendOutputField type inference
const withAppendedOutput = testSig.appendOutputField(
  'confidence',
  f.number('Confidence score')
);
type _appendedOutputOut = Expect<
  Equal<
    SigOut<typeof withAppendedOutput>,
    { responseText: string; confidence: number }
  >
>;

// Test prependOutputField type inference. Class options survive the
// field-addition methods at the type level — the field is typed as the
// literal union, whether built with f.class() or a plain config object.
const withPrependedOutput = testSig.prependOutputField(
  'category',
  f.class(['urgent', 'normal', 'low'], 'Priority')
);
type _prependedOutputOut = Expect<
  Equal<
    SigOut<typeof withPrependedOutput>,
    { category: 'urgent' | 'normal' | 'low'; responseText: string }
  >
>;

// Config-object class options are inferred as tuples (const type param), and
// an optional class field composes both fixes: optional literal union.
const withClassConfig = testSig
  .appendOutputField('priority', {
    type: 'class',
    options: ['high', 'low'],
  })
  .appendOutputField('mood', f.class(['calm', 'tense'], 'Mood').optional());
type _classConfigOut = Expect<
  Equal<
    SigOut<typeof withClassConfig>,
    {
      responseText: string;
      priority: 'high' | 'low';
      mood?: 'calm' | 'tense';
    }
  >
>;

// Test chaining type inference
const chainedSig = testSig
  .appendInputField('metadata', {
    type: 'json',
    description: 'Metadata',
    isOptional: true,
  })
  .prependOutputField('status', f.class(['success', 'error'], 'Status'))
  .appendOutputField('timestamp', f.datetime('Timestamp'));

type _chainedIn = Expect<
  Equal<SigIn<typeof chainedSig>, { userInput: string; metadata?: any }>
>;
type _chainedOut = Expect<
  Equal<
    SigOut<typeof chainedSig>,
    {
      status: 'success' | 'error';
      responseText: string;
      timestamp: Date;
    }
  >
>;

// Test array type inference
const arraySig = testSig
  .appendInputField('tags', {
    type: 'string',
    description: 'Tag names',
    isArray: true,
  })
  .appendOutputField('suggestions', {
    type: 'string',
    description: 'Suggestions',
    isArray: true,
  });

type _arrayIn = Expect<
  Equal<SigIn<typeof arraySig>, { userInput: string; tags: string[] }>
>;
type _arrayOut = Expect<
  Equal<
    SigOut<typeof arraySig>,
    { responseText: string; suggestions: string[] }
  >
>;

// === Fluent API Builder Type Tests ===
// Fields built via f() are readonly in the inferred signature types.
const fluentSig = f()
  .input('query', f.string('Query to the vector database'))
  .output('context', f.string('Context retrieved from the vector database'))
  .build();

type _fluentIn = Expect<
  Equal<SigIn<typeof fluentSig>, { readonly query: string }>
>;
type _fluentOut = Expect<
  Equal<SigOut<typeof fluentSig>, { readonly context: string }>
>;

// Test fluent API with complex types
const complexFluentSig = f()
  .input('userInput', f.string('User input'))
  .input('metadata', f.json('Optional metadata').optional())
  .input('tags', f.string('Tag list').array())
  .output('responseText', f.string('Response text'))
  .output('confidence', f.number('Confidence score'))
  .output('categories', f.string('Categories').array())
  .build();

type _complexFluentIn = Expect<
  Equal<
    SigIn<typeof complexFluentSig>,
    {
      readonly userInput: string;
      readonly metadata?: any;
      readonly tags: string[];
    }
  >
>;
type _complexFluentOut = Expect<
  Equal<
    SigOut<typeof complexFluentSig>,
    {
      readonly responseText: string;
      readonly confidence: number;
      readonly categories: string[];
    }
  >
>;

// Test fluent API with chained modifiers and internal exclusion
const fluentChained = f()
  .input('optionalList', f.string('Optional list').optional().array())
  .input('requiredList', f.string('Required list').array())
  .output('publicValue', f.number('Public value'))
  .output('internalValue', f.string('Internal value').internal())
  .build();

type _fluentChainedIn = Expect<
  Equal<
    SigIn<typeof fluentChained>,
    { readonly optionalList?: string[]; readonly requiredList: string[] }
  >
>;
type _fluentChainedOut = Expect<
  Equal<SigOut<typeof fluentChained>, { readonly publicValue: number }>
>;

// Test fluent API boolean/number inference
const fluentPrimitives = f()
  .input('boolFlag', f.boolean('Flag'))
  .input('threshold', f.number('Threshold'))
  .output('ok', f.boolean('OK'))
  .output('count', f.number('Count'))
  .build();

type _fluentPrimitivesIn = Expect<
  Equal<
    SigIn<typeof fluentPrimitives>,
    { readonly boolFlag: boolean; readonly threshold: number }
  >
>;
type _fluentPrimitivesOut = Expect<
  Equal<
    SigOut<typeof fluentPrimitives>,
    { readonly ok: boolean; readonly count: number }
  >
>;

// Class options survive the fluent builder path as a literal union
const fluentClassSig = f()
  .input('text', f.string('Text'))
  .output(
    'sentiment',
    f.class(['positive', 'negative', 'neutral'], 'Sentiment')
  )
  .build();
type _fluentClassOut = Expect<
  Equal<
    SigOut<typeof fluentClassSig>,
    { readonly sentiment: 'positive' | 'negative' | 'neutral' }
  >
>;

// === AxGen (ax) Type Tests ===
// ax() creates generators whose forward() returns the typed outputs
const basicGenerator = ax('userInput:string -> responseText:string');
{
  type Result = Awaited<ReturnType<typeof basicGenerator.forward>>;
  const _ok: Result = { responseText: 'hi' };
  const _withThought: Result = { responseText: 'hi', thought: 'because' };
  void [_ok, _withThought];
}

// Multiline string signatures parse at the type level too. The splitter
// accepts any whitespace around `->` (lockstep with the runtime grammar), so
// the arrow may end a line — as here — or start the next one.
const complexGenerator = ax(`
  userQuery:string "User question",
  contextData:json "Background info" ->
  responseText:string "AI response",
  confidence:number "Confidence 0-1",
  categories:string[] "Response categories"
`);
{
  type Result = Awaited<ReturnType<typeof complexGenerator.forward>>;
  const _ok: Result = {
    responseText: 'r',
    confidence: 0.9,
    categories: ['a'],
  };
  // @ts-expect-error missing required output fields
  const _bad: Result = { responseText: 'r' };
  void [_ok, _bad];
}

// Optional inputs and class outputs infer union types
const optionalGenerator = ax(`
  userInput:string,
  metadata?:json
  -> responseText:string,
  sentiment:class "positive, negative, neutral"
`);
{
  type Result = Awaited<ReturnType<typeof optionalGenerator.forward>>;
  const _ok: Result = { responseText: 'r', sentiment: 'positive' };
  // @ts-expect-error sentiment must be one of the class options
  const _bad: Result = { responseText: 'r', sentiment: 'angry' };
  void [_ok, _bad];
}

// react() preserves string-signature input/output inference and discriminates
// successful structured output from complete null-shaped runtime failure.
const reactProgram = react('question:string -> answer:string, score:number');
type ReactResult = Awaited<ReturnType<typeof reactProgram.forward>>;
type _reactSuccessOutput = Expect<
  Equal<
    Flatten<Extract<ReactResult, { success: true }>['output']>,
    { answer: string; score: number }
  >
>;
type _reactFailureOutput = Expect<
  Equal<
    Flatten<Extract<ReactResult, { success: false }>['output']>,
    { answer: string | null; score: number | null }
  >
>;
const reactAI = {} as AxAIService;
void reactProgram.forward(reactAI, { question: 'typed' });
// @ts-expect-error question must be a string
void reactProgram.forward(reactAI, { question: 42 });

// === fn() Function Builder Type Tests ===
const calculatedTool = fn('calculate')
  .description('Evaluate a math expression')
  .arg('expression', f.string('Math expression'))
  .arg('precision', f.number('Optional precision').optional())
  .returns(f.number('Calculated result'))
  .handler(({ expression, precision }, extra) => {
    type _expression = Expect<Equal<typeof expression, string>>;
    type _precision = Expect<Equal<typeof precision, number | undefined>>;
    type _extra = Expect<
      Equal<typeof extra, Parameters<AxFunctionHandler>[1] | undefined>
    >;
    void extra;
    return Number(expression) + (precision ?? 0);
  })
  .build();

const _calculatedTool: AxFunction = calculatedTool;
const calculatedResult = calculatedTool.func({ expression: '2', precision: 3 });
type _calculatedResult = Expect<
  Equal<typeof calculatedResult, number | Promise<number>>
>;

const searchTool = fn('search')
  .description('Search the product catalog')
  .namespace('db')
  .arg('query', f.string('Search query'))
  .returnsField('results', f.string('Result item').array())
  .returnsField('count', f.number('Result count').optional())
  .handler(({ query }) => ({
    results: [query],
    count: 1,
  }))
  .build();

const _searchTool: AxFunction = searchTool;
const _searchResult:
  | { readonly results: string[]; readonly count?: number }
  | Promise<{ readonly results: string[]; readonly count?: number }> =
  searchTool.func({ query: 'ax' });

const agentTool = fn('lookupSchedule')
  .description('Lookup schedule data')
  .namespace('kb')
  .arg('topic', f.string('Topic'))
  .returns(f.string('Lookup result'))
  .example({
    title: 'Simple lookup',
    code: 'await kb.lookupSchedule({ topic: "alex" });',
  })
  .handler(({ topic }) => topic)
  .build();

const _agentTool: AxAgentFunction = agentTool;

// === String signature type inference parity with fluent API ===
// Internal outputs are excluded; optional and arrays respected
const parsedInternalSig = AxSignature.create(
  'userText:string -> publicOut:string, hiddenOut!:number, optionalHidden?!:string, optionalList?:string[]'
);
type _parsedInternalIn = Expect<
  Equal<SigIn<typeof parsedInternalSig>, { userText: string }>
>;
type _parsedInternalOut = Expect<
  Equal<
    SigOut<typeof parsedInternalSig>,
    { publicOut: string; optionalList?: string[] }
  >
>;

// === AxExamples utility tests ===
// AxExamples is an array of example items (outputs plus optional inputs)
type ExamplesFromString =
  AxExamples<'userInput:string -> responseText:string, score:number'>;
const _examplesFromString: ExamplesFromString = [
  { responseText: 'ok', score: 1 },
  { responseText: 'ok', score: 1, userInput: 'x' },
];
// @ts-expect-error required output fields must be present in every example
const _examplesMissingOutput: ExamplesFromString = [{ score: 1 }];
void [_examplesFromString, _examplesMissingOutput];

const sigFromBuilder = f()
  .input('ctx', f.string('Context').optional())
  .input('flag', f.boolean('Flag'))
  .output('out', f.string('Out'))
  .build();
type ExamplesFromBuilder = AxExamples<typeof sigFromBuilder>;
const _examplesFromBuilder: ExamplesFromBuilder = [
  { out: 'v', flag: true },
  { out: 'v', flag: true, ctx: 'c' },
];
void _examplesFromBuilder;

const gen = ax('userInput:string -> responseText:string, count:number');
type ExamplesFromGen = AxExamples<typeof gen>;
const _examplesFromGen: ExamplesFromGen = [
  { responseText: 'a', count: 1, userInput: 'x' },
  { responseText: 'b', count: 2 },
];
void _examplesFromGen;

// === AxFlow (flow) Type Tests ===
// The state lambdas below are the compile-time assertions: they fail when the
// evolving state type stops carrying the declared fields. Result typing of
// returns() is covered in flow/flow.test-d.ts.
const basicFlow = flow<{ userInput: string }>().map((state) => ({
  processedInput: state.userInput.toUpperCase(),
  inputLength: state.userInput.length,
}));
void basicFlow.forward;

// Test flow() with node execution creates working workflow
const nodeFlow = flow<{ documentText: string }>()
  .node('summarizer', 'content:string -> summary:string, wordCount:number')
  .execute('summarizer', (state) => ({ content: state.documentText }))
  .map((state) => ({
    originalText: state.documentText,
    summaryResult: (state.summarizerResult?.summary as string) || '',
    wordCount: (state.summarizerResult?.wordCount as number) || 0,
  }));
void nodeFlow.forward;

// Test flow() with complex multi-node workflow
const complexFlow = flow<{ userQuery: string }>()
  .node('searcher', 'query:string -> results:string[], count:number')
  .node('analyzer', 'data:string[] -> hasResults:boolean')
  .execute('searcher', (state) => ({ query: state.userQuery }))
  .execute('analyzer', (state) => ({
    data: (state.searcherResult?.results as string[]) || [],
  }))
  .map((state) => ({
    originalQuery: state.userQuery,
    searchResults: (state.searcherResult?.results as string[]) || [],
    totalResults: (state.searcherResult?.count as number) || 0,
    hasResults: (state.analyzerResult?.hasResults as boolean) || false,
  }));
void complexFlow.forward;

// === optimize() Type Tests ===
const optimizeAI = {} as AxAIService;
const _optimizedGen: Promise<AxParetoResult<any>> = optimize(
  basicGenerator,
  [{ userInput: 'hello' }],
  ({ prediction }) => ((prediction as any).responseText ? 1 : 0),
  {
    studentAI: optimizeAI,
    maxMetricCalls: 2,
  }
);
const _optimizedFlow: Promise<AxParetoResult<any>> = optimize(
  nodeFlow,
  [{ documentText: 'hello' }],
  ({ prediction }) => ((prediction as any).summaryResult ? 1 : 0),
  {
    studentAI: optimizeAI,
    maxMetricCalls: 2,
    bootstrap: false,
  }
);
const programmable = basicGenerator as AxProgrammable<
  { userInput: string },
  { responseText: string }
>;
const _optimizedProgrammable: Promise<
  AxParetoResult<{ responseText: string }>
> = optimize(programmable, [{ userInput: 'hello' }], () => 1, {
  studentAI: optimizeAI,
  maxMetricCalls: 2,
  bootstrap: { maxDemos: 1, qualityThreshold: 0.5 },
});
const qualitativeResult: AxMetricResult<'accuracy' | 'brevity'> = {
  score: 0.8,
  feedback: 'Ground the answer in the provided evidence.',
  scores: { accuracy: 1, brevity: 0.5 },
};
const qualitativeMetric: AxMetricFn<any, 'accuracy' | 'brevity'> = () =>
  qualitativeResult;
const legacyScalarMetric: AxMetricFn = () => 1;
const legacyMultiMetric: AxMultiMetricFn = () => ({
  accuracy: 1,
  brevity: 0.5,
});
void qualitativeMetric;
void legacyScalarMetric;
void legacyMultiMetric;

const invalidQualitativeResult: AxMetricResult<'accuracy'> = {
  score: 1,
  // @ts-expect-error named objectives are constrained by AxMetricResult's generic
  scores: { brevity: 1 },
};
void invalidQualitativeResult;

// Test flow() with optional fields
const optionalFlow = flow<{
  requiredField: string;
  optionalField?: string;
}>().map((state) => ({
  processedRequired: state.requiredField.trim(),
  processedOptional: state.optionalField?.trim(),
  hasOptional: !!state.optionalField,
}));
void optionalFlow.forward;

// Test flow() with array handling
const arrayFlow = flow<{ items: string[] }>().map((state) => ({
  originalItems: state.items,
  itemCount: state.items.length,
  firstItem: state.items[0] || '',
  uppercaseItems: state.items.map((item) => item.toUpperCase()),
}));
void arrayFlow.forward;

// === OpenAI reasoning effort surfaces ===
// `max` exists only on the Responses API. Chat Completions answers a chat
// request carrying it with a 400, so the chat types must not offer it while the
// Responses ones must.
const chatReqTopEffort: AxAIOpenAIChatRequest<string>['reasoning_effort'] =
  'xhigh';
void chatReqTopEffort;

// @ts-expect-error `max` is Responses-only; Chat Completions rejects it
const chatReqMaxEffort: AxAIOpenAIChatRequest<string>['reasoning_effort'] =
  'max';
void chatReqMaxEffort;

// @ts-expect-error same for the config that feeds the chat request
const chatConfigMaxEffort: AxAIOpenAIConfig<string, string>['reasoningEffort'] =
  'max';
void chatConfigMaxEffort;

const responsesReqMaxEffort: NonNullable<
  AxAIOpenAIResponsesRequest<string>['reasoning']
>['effort'] = 'max';
void responsesReqMaxEffort;

const responsesConfigMaxEffort: AxAIOpenAIResponsesConfig<
  string,
  string
>['reasoningEffort'] = 'max';
void responsesConfigMaxEffort;

// === Experimental program-source factory ===
const sourceProgram: AxProgramSource<
  { userQuestion: string; contextItems?: string[] },
  { finalAnswer: string; confidence: number }
> = programSource(
  'userQuestion:string, contextItems?:string[] -> finalAnswer:string, confidence:number'
);
sourceProgram.forward(optimizeAI, { userQuestion: 'hello' }).then((output) => {
  const answer: string = output.finalAnswer;
  const confidence: number = output.confidence;
  void answer;
  void confidence;
});
// @ts-expect-error missing required input
void sourceProgram.forward(optimizeAI, {});

declare const customCodeRuntime: AxCodeRuntime;
programSource('question:string -> answer:string', {
  runtime: {
    runtime: customCodeRuntime,
    protocol: axProgramSourceRuntimeProtocol,
  },
  valueLimits: { maxBytes: 65_536, maxDepth: 12, maxWidth: 256 },
});
// @ts-expect-error custom runtimes require an explicit compatibility wrapper
programSource('question:string -> answer:string', {
  runtime: customCodeRuntime,
});

// === Host-owned executable skill selection ===
const executableSkill: AxExecutableSkillArtifact = {
  id: 'report-export',
  version: '2',
  name: 'Report export',
  description: 'Export an authorized report',
  functionRef: 'functions/report-export/2',
  verification: { mode: 'receiptless' },
  requirements: { capabilities: ['report.read'] },
};
const executableSkillSelection: AxExecutableSkillSelection =
  axSelectExecutableSkills(
    [executableSkill],
    {
      admittedArtifacts: [axExecutableSkillRef(executableSkill)],
      principal: 'principal:reporter',
      audience: 'agent:reporting',
      capabilities: ['report.read'],
      now: '2026-08-25T00:00:00.000Z',
      resolveFunction: () => ({
        name: 'export_report',
        description: 'Export report',
        func: () => 'report',
      }),
    },
    { query: 'export report', topK: 1 }
  );
const selectedExecutableFunction: AxAgentFunction | undefined =
  executableSkillSelection.artifacts[0]?.function;
void selectedExecutableFunction;

// @ts-expect-error trusted principal, clock, admission, and resolver are mandatory
axSelectExecutableSkills([executableSkill], { capabilities: ['report.read'] });

// === Trajectory surface (src/ax/trajectory) ===
// Proves the generated barrel really exports the append-only step log, its
// store port, the reference implementation and the normative conformance kit.
import {
  AxInMemoryTrajectoryStore,
  AxTrajectoryAppendError,
  type AxTrajectoryAppendReceipt,
  type AxTrajectoryProjection,
  type AxTrajectoryStep,
  type AxTrajectoryStore,
  type AxTrajectoryStoreConformanceReport,
  type AxTrajectoryTailResult,
  axProjectTrajectory,
  axResolveTrajectoryStep,
  axTrajectoryContextBudget,
  axTrajectoryTypeRegistry,
  runAxTrajectoryStoreConformance,
} from './index.js';

const trajectoryStore: AxTrajectoryStore = new AxInMemoryTrajectoryStore();
void trajectoryStore;
void axTrajectoryTypeRegistry();
void runAxTrajectoryStoreConformance;
void axResolveTrajectoryStep;
void AxTrajectoryAppendError;
void axProjectTrajectory;
const trajectoryBudget: number = axTrajectoryContextBudget({
  contextWindowTokens: 500_000,
});
void trajectoryBudget;

declare const trajectoryReceipt: AxTrajectoryAppendReceipt;
declare const trajectoryStep: AxTrajectoryStep;
declare const trajectoryTail: AxTrajectoryTailResult;
declare const trajectoryConformance: AxTrajectoryStoreConformanceReport;
declare const trajectoryProjection: AxTrajectoryProjection;
const trajectoryRender: string = trajectoryProjection.render;
void trajectoryRender;
const trajectorySeq: number = trajectoryReceipt.seq;
const trajectoryType: string = trajectoryStep.type;
const trajectoryExhausted: boolean = trajectoryTail.exhausted;
const trajectoryAssertions: number = trajectoryConformance.assertions;
void trajectorySeq;
void trajectoryType;
void trajectoryExhausted;
void trajectoryAssertions;

// === Mind surface (src/ax/mind) ===
// Proves the generated barrel really exports the pacing ladder, the wake
// routing, both event sources, lag health, ledgered chat and the skill tier.
// `AxMind` and `mind()` land with the runtime commit.
import {
  AxMindChatError,
  type AxMindDiagnostic,
  type AxMindHealth,
  type AxMindPaceDecision,
  type AxMindReplyResolution,
  type AxMindSkillSelection,
  type AxMindThinker,
  AxMindTickEventSource,
  AxTrajectoryEventSource,
  axDefaultMindPacerConfig,
  axMindChatIdempotencyKey,
  axMindEventRoutes,
  axMindHealthState,
  axMindSalienceBuffer,
  axNextMindPace,
  axRecoverMindPacerState,
  axResolveMindReplyState,
  axSelectMindSkills,
  axWithMindSalience,
} from './index.js';

void axNextMindPace;
void axRecoverMindPacerState;
void axResolveMindReplyState;
void axMindChatIdempotencyKey;
void axSelectMindSkills;
void axWithMindSalience;
void axMindEventRoutes;
void axMindHealthState;
void axMindSalienceBuffer;
void AxMindChatError;
void AxTrajectoryEventSource;
void AxMindTickEventSource;

const mindCapMs: number = axDefaultMindPacerConfig.capMs;
declare const mindThinker: AxMindThinker;
declare const mindDecision: AxMindPaceDecision;
declare const mindHealth: AxMindHealth;
declare const mindReply: AxMindReplyResolution;
declare const mindSkills: AxMindSkillSelection;
declare const mindDiagnostic: AxMindDiagnostic;
const mindThinkerName: string = mindThinker.name;
const mindDecisionKind: 'arm' | 'unchanged' = mindDecision.kind;
const mindLagSteps: number = mindHealth.lagSteps;
const mindFailedOpen: boolean = mindReply.failedOpen;
const mindKernelTokens: number = mindSkills.kernelTokens;
const mindDiagnosticAt: number = mindDiagnostic.at;
void mindCapMs;
void mindThinkerName;
void mindDecisionKind;
void mindLagSteps;
void mindFailedOpen;
void mindKernelTokens;
void mindDiagnosticAt;

// === Host-owned evidence guards ===
// RFC §8.8: the guard surface is reachable, and correctly shaped, from the
// generated public barrel rather than only from the subsystem module.
const guardObservation: AxEvidenceObservation = {
  version: 1,
  kind: 'session.mfa',
  sourceId: 'idp-a',
  observedAt: 10_000,
  value: 'strong',
  leaseEpoch: 3,
};
const guardRequirement: AxEvidenceRequirement = {
  kind: 'session.mfa',
  trustedSources: ['idp-a'],
  maxAgeMs: 60_000,
  match: { op: 'fresh' },
};
const guardedGrant: AxCapabilityGrant = {
  version: 1,
  id: 'grant-guarded',
  principalId: 'subject-42',
  operations: ['document.read'],
  resources: [{ type: 'document', id: 'doc-1' }],
  leaseEpoch: 3,
  requirements: [guardRequirement],
};
const guardEvaluation: Readonly<AxGuardEvaluation> = axEvaluateGuards({
  operation: 'document.read',
  resource: { type: 'document', id: 'doc-1' },
  requirements: axCollectGrantRequirements([guardedGrant]),
  evidence: [guardObservation],
  leaseEpoch: 3,
  now: 10_000,
});
const guardFailureCode: AxGuardFailureCode | undefined =
  guardEvaluation.failures[0]?.code;
void guardFailureCode;
void axIsEvidenceRequirement(guardRequirement);
void axIsGuardPredicateFailure(new Error('denied'));

// @ts-expect-error `sameAs` was cut from the algebra and must stay unusable.
const cutOperator: AxGuardOp = 'sameAs';
void cutOperator;

// @ts-expect-error a guard failure has no value channel.
void guardEvaluation.failures[0]?.value;

// === Track B3 optimizer evidence modules ===
// These import from './index.js' on purpose: the point is to prove the
// GENERATED public barrel actually re-exports them, not merely that the modules
// compile. A symbol that silently fails `hasValidPrefix` would break here.
import {
  type AxCandidateEffectDeclaration,
  type AxHarnessRecipe,
  AxInMemoryRejectedCandidateLedger,
  AxManualEventClock,
  type AxMutationAnnotation,
  type AxRejectedCandidateLedgerEntry,
  type AxSha256Digest,
  type AxTaskInclusion,
  type AxTrajectoryTermination,
  axComputeInclusionProbabilities,
  axHarnessRecipe,
  axRunRejectedCandidateLedgerConformance,
  axValidateCandidateEffectDeclaration,
} from './index.js';

declare const b3Digest: AxSha256Digest;

const b3Recipe: Promise<AxHarnessRecipe> = axHarnessRecipe({
  bindings: [
    { port: 'exec.dispatch', atomId: 'worker-pool', version: '1.0.0' },
  ],
  boundModelId: 'gpt-5',
});
void b3Recipe;

const b3Inclusions: readonly AxTaskInclusion[] =
  axComputeInclusionProbabilities(
    [{ index: 0, successes: 1, trials: 2, lastSeenIteration: 0 }],
    1,
    {
      successThreshold: 0.5,
      explorationFloor: 0.2,
      maxReportedTasks: 200,
      maxInclusionSnapshots: 20,
    }
  );
void b3Inclusions;

const b3Termination: AxTrajectoryTermination = {
  kind: 'environment_failure',
  cause: 'rate_limit',
};
void b3Termination;

const b3Mutation: AxMutationAnnotation = {
  depth: 'supervision',
  patch: { class: 'steering', type: 'prompt.rule_modify' },
  componentClasses: ['context'],
};
void b3Mutation;

const b3Effect: AxCandidateEffectDeclaration =
  axValidateCandidateEffectDeclaration(
    {
      operation: 'payments.capture',
      replaySafety: 'idempotent',
      idempotencyKeySource: 'derived',
      resolver: 'host_resolver',
    },
    'effects[0]'
  );
void b3Effect;

declare const b3Entry: AxRejectedCandidateLedgerEntry;
void b3Entry.candidateDigest;
void b3Digest;

const b3Clock = new AxManualEventClock(0);
void axRunRejectedCandidateLedgerConformance(
  () => new AxInMemoryRejectedCandidateLedger({ clock: b3Clock }),
  { clock: b3Clock }
);

// === Playbook evidence surface (Track B2) ===
// These types are the contract a host reads off a completed evolve() run, so
// they must be reachable from the package root, not only from the internal
// module they are declared in.
import {
  type AxAgentPlaybookAttemptRecord,
  type AxAgentPlaybookComputeAccounting,
  type AxAgentPlaybookControlArmReport,
  type AxAgentPlaybookEvidenceReceipt,
  type AxAgentPlaybookEvidenceWarning,
  AxAgentPlaybookEvolveError,
  type AxAgentPlaybookInterval,
  type AxAgentPlaybookReachProbe,
  type AxAgentPlaybookTransferReport,
  type AxAgentPlaybookValidityReport,
  type AxAgentTrajectoryClassifier,
  type AxAgentTrajectoryTermination,
  axClassifyAxServiceTermination,
  axIsAgentPlaybookEvolveError,
} from './index.js';

const playbookClassifier: AxAgentTrajectoryClassifier = ({ errorName }) =>
  errorName === 'AxAIServiceTimeoutError'
    ? { kind: 'environment_failure', cause: 'timeout' }
    : undefined;
void playbookClassifier;
void axClassifyAxServiceTermination;

const playbookProbe: AxAgentPlaybookReachProbe = ({ candidateBulletIds }) => ({
  applicableAtDecidingStep: candidateBulletIds.length > 0,
  invocations: 0,
});
void playbookProbe;

declare const playbookReceipt: AxAgentPlaybookEvidenceReceipt;
const playbookInterval: AxAgentPlaybookInterval =
  playbookReceipt.intervals.current;
const playbookValidity: AxAgentPlaybookValidityReport =
  playbookReceipt.validity;
const playbookAccounting: AxAgentPlaybookComputeAccounting =
  playbookReceipt.accounting;
const playbookWarnings: readonly AxAgentPlaybookEvidenceWarning[] =
  playbookReceipt.warnings;
void playbookInterval;
void playbookValidity;
void playbookAccounting;
void playbookWarnings;

declare const playbookTransfer: AxAgentPlaybookTransferReport;
declare const playbookControl: AxAgentPlaybookControlArmReport;
declare const playbookAttempt: AxAgentPlaybookAttemptRecord;
declare const playbookTermination: AxAgentTrajectoryTermination;
void playbookTransfer;
void playbookControl;
void playbookAttempt;
void playbookTermination;

const playbookEvolveError = new AxAgentPlaybookEvolveError(
  'evidence_incomplete',
  'candidate_eval',
  'not enough evidence'
);
const isPlaybookEvolveError: boolean =
  axIsAgentPlaybookEvolveError(playbookEvolveError);
void isPlaybookEvolveError;
// === Learning surface public API ===
const learningStore: AxLearningStore = axInMemoryLearningStore({
  maxRecordsPerScenario: 100,
});
void learningStore.capabilities.compareAndSet;
void runAxLearningStoreConformance;

const learningEngine = axCreateLearningEngineState({
  scenario: 'support-triage',
  processor: axScoreWindowProcessor({ batchSize: 2, maxScore: 0 }),
  sampleFields: ['input', 'output', 'failure'],
});
declare const someLearningRecord: AxLearningRecord;
void axLearningEngineIngest(learningEngine, someLearningRecord);

declare const someReceipt: AxLearningReceipt;
void someReceipt.artifactRef?.contentId;

const harnessTree: AxHarnessTree = [
  { id: 'tone', kind: 'instruction', config: { text: 'Answer briefly.' } },
];
const harnessEntry: AxHarnessEntry | undefined = harnessTree[0];
void harnessEntry;

declare const harnessGate: AxHarnessGateDecision;
void harnessGate.metrics.taskSetDigest;

void axReportSchema({ score: { type: 'number', min: 0, max: 1 } });
void axAssertPersistableValue({ ok: true }, 'payload');

// Harness tree, installer, release chain and evolve must all be reachable from
// the generated barrel — this file is the proof that they are exported, not
// merely written.
void axInspectHarnessTree(harnessTree);
void axAdmitHarnessTree(harnessTree);
void axRenderHarnessTree(harnessTree, { now: '2026-01-01T00:00:00.000Z' });
void axHarnessContentId(harnessTree);
declare const harnessInstallTarget: AxHarnessInstallTarget;
void axApplyHarnessTree(harnessTree, harnessInstallTarget, {
  releaseId: 'rel-1',
  now: '2026-01-01T00:00:00.000Z',
});
void axCurrentHarnessInstallation(harnessInstallTarget);
void axNormalizeHarnessFailureCause('boom');
declare const learningSurface: AxLearningSurface;
void learningSurface.observedHeadContentId;
void axLearningSurface;
declare const harnessEvolveOptions: AxHarnessEvolveOptions;
void axHarnessEvolve(harnessEvolveOptions);

// --- Verifier-gated working state ------------------------------------------
// Every symbol below must be reachable from the generated barrel; the
// benchmark scaffolding must NOT be.

import {
  type AxStatePatchOp,
  type AxWorkingStateCheckerPolicy,
  type AxWorkingStateDocument,
  type AxWorkingStateTraceStep,
  axIsWorkingStateError,
  axWorkingState,
} from './index.js';

type WorkingStateFacts = { shipped: boolean };

const workingStateDocument: AxWorkingStateDocument<WorkingStateFacts> = {
  schemaVersion: 1,
  goals: {
    g_ship: {
      id: 'g_ship',
      goal: 'Ship order 42',
      status: 'pending',
      evidence: [],
      expects: ['shipping.dispatch'],
      createdTurn: 0,
      updatedTurn: 0,
    },
  },
  facts: { shipped: false },
  parked: [],
};
const shippedFact: boolean = workingStateDocument.facts.shipped;
void shippedFact;

const workingStateChecker: AxWorkingStateCheckerPolicy<WorkingStateFacts> = {
  id: 'ship-guard',
  check: ({ proposedState }) =>
    proposedState.facts.shipped
      ? { status: 'pass' }
      : { status: 'fail', failure: { code: 'not_shipped' } },
};
void workingStateChecker;

const removeStatePatchOp: AxStatePatchOp = {
  op: 'remove',
  path: '/goals/g_ship',
};
void removeStatePatchOp;

declare const workingStateTraceStep: AxWorkingStateTraceStep;
const workingStateTurn: number = workingStateTraceStep.turn;
void workingStateTurn;

void axWorkingState<WorkingStateFacts>(
  { stateSignature: 'shipped:boolean' },
  { runId: 'ws:x:1', stage: 'executor' }
);
void axIsWorkingStateError(new Error('x'));

// --- skillState memory mode -------------------------------------------------

import type { AxSkillStateRejection, AxSkillStateTransition } from './index.js';

declare const skillStateTransition: AxSkillStateTransition<WorkingStateFacts>;
// `committedRevision` is NON-OPTIONAL: the store is never absent.
const skillStateRevision: number = skillStateTransition.committedRevision;
void skillStateRevision;
const skillStateFacts: boolean | undefined =
  skillStateTransition.state?.facts.shipped;
void skillStateFacts;
const skillStateRejection: AxSkillStateRejection = 'fence';
void skillStateRejection;

// --- Call-time skill injection ---------------------------------------------

import {
  type AxCallTimeSkillBinding,
  type AxCallTimeSkillNotExecuted,
  axIsCallTimeSkillNotExecuted,
} from './index.js';

const callTimeSkillBinding: AxCallTimeSkillBinding = {
  qualifiedName: 'inventory.adjustStock',
  skill: 'stock-adjustment',
  maxInjections: 1,
  when: (state) => state.facts !== undefined,
};
void callTimeSkillBinding;

declare const callTimeMarker: AxCallTimeSkillNotExecuted;
const callTimeSkillId: string = callTimeMarker.skillId;
void callTimeSkillId;
void axIsCallTimeSkillNotExecuted(callTimeMarker);

// Benchmark scaffolding and harness plumbing must stay internal: these names
// are listed in `internalExportNames`, so the generated barrel does not carry
// them. A `keyof typeof import(...)` test cannot express this — a type-only
// export never appears in a module's `keyof`, so that form passes whatever the
// barrel exports. The assertion here is the resolution failure itself: if the
// barrel ever exported one of these names, its `@ts-expect-error` would have
// nothing to suppress and this file would stop compiling.
type BenchRowIsNotPublic =
  // @ts-expect-error the package root must not export the benchmark row type
  import('./index.js').AxWorkingStateBenchRow;
const benchRowIsNotPublic: BenchRowIsNotPublic | undefined = undefined;
void benchRowIsNotPublic;

type PromptGrowthIsNotPublic =
  // @ts-expect-error the package root must not export the benchmark slope helper
  typeof import('./index.js').axWorkingStatePromptGrowth;
const promptGrowthIsNotPublic: PromptGrowthIsNotPublic | undefined = undefined;
void promptGrowthIsNotPublic;

type ScriptTurnIsNotPublic =
  // @ts-expect-error the package root must not export the scripted-mock turn type
  import('./index.js').AxWorkingStateScriptTurn;
const scriptTurnIsNotPublic: ScriptTurnIsNotPublic | undefined = undefined;
void scriptTurnIsNotPublic;

type ReceiptBindingIsNotPublic =
  // @ts-expect-error the package root must not export the receipt sink contract
  import('./index.js').AxAgentToolReceiptBinding;
const receiptBindingIsNotPublic: ReceiptBindingIsNotPublic | undefined =
  undefined;
void receiptBindingIsNotPublic;

type CallTimeRuntimeIsNotPublic =
  // @ts-expect-error the package root must not export the per-run binding table
  import('./index.js').AxCallTimeSkillRuntime;
const callTimeRuntimeIsNotPublic: CallTimeRuntimeIsNotPublic | undefined =
  undefined;
void callTimeRuntimeIsNotPublic;

type CallTimeHookIsNotPublic =
  // @ts-expect-error the package root must not export the dispatch-site hook
  import('./index.js').AxCallTimeSkillHook;
const callTimeHookIsNotPublic: CallTimeHookIsNotPublic | undefined = undefined;
void callTimeHookIsNotPublic;

// === Track B4 skill provenance, visibility tiers, and skill cost ===
// Same reason as Track B3 above: importing from './index.js' proves the
// GENERATED barrel re-exports these, not merely that the modules compile.
import {
  type AxACEBulletVisibility,
  type AxAgentCatalogSkill,
  type AxAgentSkillCostProfile,
  type AxAgentSkillRetrievalGate,
  type AxAgentVerificationBudget,
  type AxAgentVerifierRail,
  type AxSkillPreconditionCheck,
  type AxSkillProvenance,
  axCheckSkillRequirements,
  axExtractSkillProvenance,
  axProjectActorPlaybook,
  axRecheckSkillProvenance,
  axRedactPlaybookForModel,
  axSelectCatalogSkills,
  axSkillRetrievalGate,
  axSkillValueScore,
} from './index.js';

const skillProvenance: AxSkillProvenance = axExtractSkillProvenance({
  receipts: [
    {
      version: 1,
      receiptId: 'receipt-1',
      requestId: 'request-1',
      decision: 'allow',
      operation: 'document.read',
      resource: { type: 'document', id: 'doc-1' },
      principalId: 'principal-1',
      actor: { id: 'actor-1', kind: 'agent' },
      grantIds: ['grant-1'],
      leaseEpoch: 3,
      authorizedAt: 10,
    },
  ],
  leaseEpoch: 3,
  capturedAt: '2026-01-01T00:00:00.000Z',
});
const skillPreconditionCheck: AxSkillPreconditionCheck =
  axRecheckSkillProvenance(
    skillProvenance,
    { grantIds: ['grant-1'], leaseEpoch: 3 },
    { grant_revoked: 'drop' },
    '2026-01-01T00:00:00.000Z'
  );
void skillPreconditionCheck.outcome;

const catalogSkill: AxAgentCatalogSkill = {
  id: 'release-checklist',
  name: 'Release checklist',
  content: '1. Bump version',
  tier: 'kernel',
  requires: { bins: ['jq'], anyBins: ['gh', 'hub'], os: ['darwin'] },
  authorityProvenance: skillProvenance,
};
void axCheckSkillRequirements(catalogSkill.requires, { bins: ['jq'] });
const catalogSelection = axSelectCatalogSkills([catalogSkill], {
  environment: { bins: ['jq'] },
  authority: { grantIds: ['grant-1'], leaseEpoch: 3 },
  now: '2026-01-01T00:00:00.000Z',
});
void catalogSelection.kernel.length;
// The actor view is structurally sealed against optimizer-only fields: a
// catalog skill carrying provenance is unassignable to it, so an optimizer
// object cannot reach the Loaded Skills renderer by convention or by accident.
// @ts-expect-error a catalog skill carries authorityProvenance
const sealedActorView: import('./agent/skillCatalog.js').AxAgentActorSkillView =
  catalogSkill;
void sealedActorView;

const skillRetrievalGate: AxAgentSkillRetrievalGate = axSkillRetrievalGate(
  [catalogSkill],
  { authority: { grantIds: [], leaseEpoch: 3 } }
);
void skillRetrievalGate.denied.has('release-checklist');
void skillRetrievalGate.advisory('release-checklist');

const skillCostProfile: AxAgentSkillCostProfile = {
  id: 'release-checklist',
  loads: 2,
  uses: 1,
  successes: 1,
  tokensTotal: 900,
  wallMsTotal: 40,
  verificationRoundsTotal: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
void axSkillValueScore(0.8, skillCostProfile);

const verificationBudget: AxAgentVerificationBudget = {
  maxRounds: 4,
  verificationTools: ['utils.typecheck'],
  railTimeoutMs: 2000,
};
void verificationBudget;
const verifierRail: AxAgentVerifierRail = {
  id: 'typecheck',
  stage: 'afterToolCall',
  verify: () => [],
};
void verifierRail;

const optimizerTier: AxACEBulletVisibility = 'optimizer';
void optimizerTier;
// @ts-expect-error the tier is a closed union, not an arbitrary label
const forgedTier: AxACEBulletVisibility = 'host-only';
void forgedTier;

declare const b4Playbook: import('./dsp/optimizers/aceTypes.js').AxACEPlaybook;
void axProjectActorPlaybook(b4Playbook, { now: '2026-01-01T00:00:00.000Z' });
void axRedactPlaybookForModel(b4Playbook);
