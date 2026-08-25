/**
 * Bounded acceptance evaluation for react(). The default run uses scripted
 * providers: its results are mechanism evidence, NOT model-quality evidence.
 *
 *   npm run eval:react
 *   npm run eval:react -- --live=openai|gemini|anthropic [--json]
 *
 * Live mode is opt-in, requires the provider credential, runs four fixed
 * read-only tasks in prompt and auto mode, and allows at most four iterations.
 */
import {
  type AxAIAnthropicModel,
  type AxAIGoogleGeminiModel,
  type AxAIOpenAIModel,
  type AxAIService,
  type AxAIServiceOptions,
  type AxChatRequest,
  type AxChatResponse,
  type AxFunction,
  AxMockAIService,
  type AxReactHistory,
  type AxReactTerminationReason,
  ai,
  axReactSerializeHistory,
  react,
} from '@ax-llm/ax';

type Mode = 'native' | 'prompt' | 'auto';
type Call = { name: string; args?: Record<string, unknown> };
type Metric = {
  lane: string;
  scenario: string;
  expectedCompleted: boolean;
  completed: boolean;
  outcomeCorrect: boolean;
  exactToolCalls: boolean;
  historyIdsValid: boolean;
  resultPairsOrdered: boolean;
  terminationCorrect: boolean;
  modelTurns: number;
  forcedSubmit: boolean;
  resumeDeterministic: boolean | null;
  elapsedMs: number;
  promptCharacters: number;
  toolErrors: number;
  failure: string | null;
};

const argv = process.argv.slice(2);
const liveArg = argv.find((arg) => arg.startsWith('--live='));
const jsonOnly = argv.includes('--json');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: npm run eval:react -- [--json] [--live=PROVIDER]

No --live flag: free deterministic scripted evaluation (default).
PROVIDER: openai, gemini, or anthropic. Live execution never happens unless
--live is explicitly supplied. It requires OPENAI_APIKEY, GOOGLE_APIKEY, or
ANTHROPIC_APIKEY respectively and runs exactly 4 safe local read-only tasks ×
2 modes with maxIterations=4. No secret values are read or printed otherwise.`);
  process.exit(0);
}

const nativeTurn = (calls: Call[]): AxChatResponse => ({
  results: [
    {
      index: 0,
      functionCalls: calls.map((call, index) => ({
        id: `script-${index}`,
        type: 'function' as const,
        function: { name: call.name, params: call.args ?? {} },
      })),
    },
  ],
});
const promptTurn = (calls: Call[]): AxChatResponse => ({
  results: [
    {
      index: 0,
      content: JSON.stringify({
        calls: calls.map((call) => ({
          name: call.name,
          arguments: call.args ?? {},
        })),
      }),
    },
  ],
});

const schema = {
  type: 'object' as const,
  properties: { value: { type: 'number' as const, description: 'Value' } },
  required: ['value'],
  additionalProperties: false,
};
const makeTools = (observed: string[], delayMs = 0): AxFunction[] =>
  ['lookup', 'decoy', 'explode', 'slow'].map((name) => ({
    name,
    description:
      name === 'decoy' ? 'Plausible but wrong lookup' : `Read-only ${name}`,
    parameters: schema,
    func: async ({ value }: { value: number }) => {
      observed.push(`${name}:${value}`);
      if (name === 'explode') throw new Error('expected recoverable failure');
      if (name === 'slow')
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { value };
    },
  }));

type Scenario = {
  name: string;
  calls: Call[][];
  expected: string[];
  expectedCompleted?: boolean;
  expectedTermination?: AxReactTerminationReason;
  maxIterations?: number;
  delayMs?: number;
};
const scenarios: Scenario[] = [
  {
    name: 'native-capable-tools',
    calls: [
      [{ name: 'lookup', args: { value: 7 } }],
      [{ name: 'submit', args: { answer: 'seven' } }],
    ],
    expected: ['lookup:7'],
  },
  {
    name: 'misleading-decoy',
    calls: [
      [{ name: 'lookup', args: { value: 2 } }],
      [{ name: 'submit', args: { answer: 'correct' } }],
    ],
    expected: ['lookup:2'],
  },
  {
    name: 'recoverable-tool-error',
    calls: [
      [{ name: 'explode', args: { value: 1 } }],
      [{ name: 'lookup', args: { value: 3 } }],
      [{ name: 'submit', args: { answer: 'recovered' } }],
    ],
    expected: ['explode:1', 'lookup:3'],
  },
  {
    name: 'forced-submit',
    calls: [
      [{ name: 'lookup', args: { value: 4 } }],
      [{ name: 'submit', args: { answer: 'forced' } }],
    ],
    expected: ['lookup:4'],
    maxIterations: 1,
    expectedTermination: 'forced_submit',
  },
  {
    name: 'bounded-parallel-async',
    calls: [
      [
        { name: 'slow', args: { value: 1 } },
        { name: 'slow', args: { value: 2 } },
        { name: 'slow', args: { value: 3 } },
      ],
      [{ name: 'submit', args: { answer: 'parallel' } }],
    ],
    expected: ['slow:1', 'slow:2', 'slow:3'],
    delayMs: 30,
  },
  {
    name: 'direct-submit-no-benefit',
    calls: [[{ name: 'submit', args: { answer: 'direct' } }]],
    expected: [],
  },
  {
    name: 'invalid-forced-submit-failure-contract',
    calls: [[], [{ name: 'submit', args: { wrongField: 'invalid' } }]],
    expected: [],
    expectedCompleted: false,
    expectedTermination: 'forced_submit_failed',
    maxIterations: 1,
  },
];

function promptSize(request: Readonly<AxChatRequest<unknown>>): number {
  return JSON.stringify(request.chatPrompt).length;
}

function historyProtocolEvidence(history: AxReactHistory): {
  idsValid: boolean;
  pairsOrdered: boolean;
} {
  const canonicalIds = new Set<string>();
  const replayIds = new Set<string>();
  let idsValid = true;
  let pairsOrdered = true;
  for (let index = 0; index < history.events.length; ) {
    const assistant = history.events[index];
    if (assistant?.role !== 'assistant') {
      pairsOrdered = false;
      break;
    }
    for (const [callIndex, call] of assistant.calls.entries()) {
      const replayId = call.providerId ?? call.id;
      if (
        !/^axr_[a-f0-9]{32}$/.test(call.id) ||
        canonicalIds.has(call.id) ||
        replayIds.has(replayId)
      ) {
        idsValid = false;
      }
      canonicalIds.add(call.id);
      replayIds.add(replayId);
      const result = history.events[index + callIndex + 1];
      if (
        result?.role !== 'tool' ||
        result.id !== call.id ||
        result.name !== call.name
      ) {
        pairsOrdered = false;
      }
    }
    index += 1 + assistant.calls.length;
  }
  return { idsValid, pairsOrdered };
}

async function runScripted(
  scenario: Scenario,
  lane: string,
  mode: Mode,
  functions = true
): Promise<Metric> {
  const observed: string[] = [];
  let turn = 0;
  let promptCharacters = 0;
  const ai = new AxMockAIService<string>({
    features: { functions },
    chatResponse: async (request) => {
      promptCharacters += promptSize(request);
      const calls = scenario.calls[turn++] ?? [];
      return mode === 'prompt' || !functions
        ? promptTurn(calls)
        : nativeTurn(calls);
    },
  });
  const start = performance.now();
  const result = await react('question:string -> answer:string', {
    functions: makeTools(observed, scenario.delayMs),
    maxIterations: scenario.maxIterations ?? 4,
    maxParallelTools: 2,
  }).forward(ai, { question: scenario.name }, { functionCallMode: mode });
  const expectedCompleted = scenario.expectedCompleted ?? true;
  const expectedTermination =
    scenario.expectedTermination ??
    (expectedCompleted ? 'submit' : 'forced_submit_failed');
  const protocol = historyProtocolEvidence(result.history);
  return {
    lane,
    scenario: scenario.name,
    expectedCompleted,
    completed: result.success,
    outcomeCorrect: result.success === expectedCompleted,
    exactToolCalls:
      JSON.stringify(observed) === JSON.stringify(scenario.expected),
    historyIdsValid: protocol.idsValid,
    resultPairsOrdered: protocol.pairsOrdered,
    terminationCorrect: result.terminationReason === expectedTermination,
    modelTurns: turn,
    forcedSubmit: result.terminationReason === 'forced_submit',
    resumeDeterministic: null,
    elapsedMs: Math.round(performance.now() - start),
    promptCharacters,
    toolErrors: result.history.events.filter(
      (event) => event.role === 'tool' && event.isError
    ).length,
    failure: result.success
      ? null
      : `${result.error.code}: ${result.error.message}`,
  };
}

async function runResume(
  lane: string,
  mode: 'native' | 'prompt'
): Promise<Metric> {
  const observed: string[] = [];
  let firstTurns = 0;
  let chars = 0;
  const response = (calls: Call[]) =>
    mode === 'native' ? nativeTurn(calls) : promptTurn(calls);
  const firstAI = new AxMockAIService<string>({
    features: { functions: true },
    chatResponse: async (request) => {
      chars += promptSize(request);
      firstTurns++;
      return firstTurns === 1
        ? response([{ name: 'lookup', args: { value: 9 } }])
        : { results: [{ index: 0, content: 'invalid forced response' }] };
    },
  });
  const program = react('question:string -> answer:string', {
    functions: makeTools(observed),
    maxIterations: 1,
  });
  const first = await program.forward(
    firstAI,
    { question: 'resume-history-continuity' },
    { functionCallMode: mode }
  );
  const snapshot = axReactSerializeHistory(first.history);
  const persisted = JSON.parse(snapshot) as AxReactHistory;
  let resumeTurns = 0;
  const resumeAI = new AxMockAIService<string>({
    features: { functions: true },
    chatResponse: async (request) => {
      chars += promptSize(request);
      resumeTurns++;
      return response([{ name: 'submit', args: { answer: 'resumed' } }]);
    },
  });
  const resumed = await program.forward(
    resumeAI,
    { question: 'resume-history-continuity' },
    { functionCallMode: mode, history: persisted }
  );
  const protocol = historyProtocolEvidence(resumed.history);
  return {
    lane,
    scenario: 'resume-history-continuity',
    expectedCompleted: true,
    completed: resumed.success,
    outcomeCorrect: resumed.success,
    exactToolCalls: JSON.stringify(observed) === JSON.stringify(['lookup:9']),
    historyIdsValid: protocol.idsValid,
    resultPairsOrdered: protocol.pairsOrdered,
    terminationCorrect: resumed.terminationReason === 'submit',
    modelTurns: firstTurns + resumeTurns,
    forcedSubmit: false,
    resumeDeterministic:
      axReactSerializeHistory(first.history) === snapshot &&
      resumed.history.events.length > first.history.events.length,
    elapsedMs: 0,
    promptCharacters: chars,
    toolErrors: resumed.history.events.filter(
      (event) => event.role === 'tool' && event.isError
    ).length,
    failure: resumed.success
      ? null
      : `${resumed.error.code}: ${resumed.error.message}`,
  };
}

function print(metrics: Metric[], heading: string): void {
  const aggregate = [...new Set(metrics.map((metric) => metric.lane))].map(
    (lane) => {
      const rows = metrics.filter((metric) => metric.lane === lane);
      return {
        lane,
        tasks: rows.length,
        completionRate:
          rows.filter((row) => row.completed).length / rows.length,
        expectedOutcomeRate:
          rows.filter((row) => row.outcomeCorrect).length / rows.length,
        exactToolCallRate:
          rows.filter((row) => row.exactToolCalls).length / rows.length,
        validHistoryIdRate:
          rows.filter((row) => row.historyIdsValid).length / rows.length,
        orderedResultPairRate:
          rows.filter((row) => row.resultPairsOrdered).length / rows.length,
        correctTerminationRate:
          rows.filter((row) => row.terminationCorrect).length / rows.length,
        modelTurns: rows.reduce((sum, row) => sum + row.modelTurns, 0),
        forcedSubmits: rows.filter((row) => row.forcedSubmit).length,
        resumeDeterministic: rows
          .filter((row) => row.resumeDeterministic !== null)
          .every((row) => row.resumeDeterministic),
        elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
        promptCharacters: rows.reduce(
          (sum, row) => sum + row.promptCharacters,
          0
        ),
        toolErrors: rows.reduce((sum, row) => sum + row.toolErrors, 0),
        failures: rows.filter((row) => row.failure).length,
      };
    }
  );
  if (!jsonOnly) {
    console.log(`\n${heading}`);
    console.table(metrics);
    console.table(aggregate);
  }
  console.log(
    JSON.stringify({ evidence: heading, metrics, aggregate }, null, 2)
  );
}

async function deterministic(): Promise<void> {
  const metrics: Metric[] = [];
  for (const scenario of scenarios) {
    metrics.push(await runScripted(scenario, 'native', 'native'));
    metrics.push(await runScripted(scenario, 'prompt-fallback', 'prompt'));
  }
  metrics.push(await runResume('native', 'native'));
  metrics.push(await runResume('prompt-fallback', 'prompt'));
  metrics.push(
    await runScripted(
      {
        name: 'text-only-auto-fallback',
        calls: [[{ name: 'submit', args: { answer: 'fallback' } }]],
        expected: [],
      },
      'text-only-auto→prompt',
      'auto',
      false
    )
  );
  print(
    metrics,
    'DETERMINISTIC MECHANISM EVIDENCE — NOT MODEL-QUALITY EVIDENCE'
  );
  const forcedSubmitCorrect = metrics
    .filter((metric) => metric.scenario === 'forced-submit')
    .every((metric) => metric.forcedSubmit);
  const resumeCorrect = metrics
    .filter((metric) => metric.scenario === 'resume-history-continuity')
    .every((metric) => metric.resumeDeterministic === true);
  if (
    metrics.some(
      (metric) =>
        !metric.outcomeCorrect ||
        !metric.exactToolCalls ||
        !metric.historyIdsValid ||
        !metric.resultPairsOrdered ||
        !metric.terminationCorrect
    ) ||
    !forcedSubmitCorrect ||
    !resumeCorrect
  )
    process.exitCode = 1;
}

const liveTasks = [
  {
    question: 'Look up value 2 and answer with the returned value.',
    expected: ['lookup:2'],
  },
  {
    question: 'Look up value 7 and answer with the returned value.',
    expected: ['lookup:7'],
  },
  { question: 'Answer directly: what is 2 + 2?', expected: [] },
  {
    question: 'Look up value 11 and report it concisely.',
    expected: ['lookup:11'],
  },
];

async function live(provider: string): Promise<void> {
  const configs = {
    openai: {
      key: 'OPENAI_APIKEY',
      model: 'gpt-5.4-mini',
      make: (apiKey: string) =>
        ai({
          name: 'openai',
          apiKey,
          config: { model: 'gpt-5.4-mini' as AxAIOpenAIModel },
        }),
    },
    gemini: {
      key: 'GOOGLE_APIKEY',
      model: 'gemini-3.7-flash',
      make: (apiKey: string) =>
        ai({
          name: 'google-gemini',
          apiKey,
          config: { model: 'gemini-3.7-flash' as AxAIGoogleGeminiModel },
        }),
    },
    anthropic: {
      key: 'ANTHROPIC_APIKEY',
      model: 'claude-sonnet-5',
      make: (apiKey: string) =>
        ai({
          name: 'anthropic',
          apiKey,
          config: { model: 'claude-sonnet-5' as AxAIAnthropicModel },
        }),
    },
  } as const;
  if (!(provider in configs))
    throw new Error(`Unknown live provider: ${provider}`);
  const config = configs[provider as keyof typeof configs];
  const apiKey = process.env[config.key];
  if (!apiKey) throw new Error(`Live mode requires ${config.key}`);
  const service = config.make(apiKey) as AxAIService;
  const nativeAvailable = service.getFeatures().functions;
  const metrics: Metric[] = [];
  for (const mode of ['prompt', 'auto'] as const) {
    for (const [index, task] of liveTasks.entries()) {
      const observed: string[] = [];
      let turns = 0;
      let chars = 0;
      const counting = new Proxy(service, {
        get(target, property, receiver) {
          if (property !== 'chat')
            return Reflect.get(target, property, receiver);
          return async (
            request: Readonly<AxChatRequest<unknown>>,
            options?: Readonly<AxAIServiceOptions>
          ) => {
            turns++;
            chars += promptSize(request);
            return await target.chat(request, options);
          };
        },
      });
      const start = performance.now();
      const result = await react('question:string -> answer:string', {
        functions: makeTools(observed),
        maxIterations: 4,
      }).forward(
        counting,
        { question: task.question },
        { functionCallMode: mode }
      );
      const protocol = historyProtocolEvidence(result.history);
      metrics.push({
        lane:
          mode === 'prompt'
            ? `${provider}/${config.model}/prompt`
            : `${provider}/${config.model}/auto(${nativeAvailable ? 'native-capable' : 'prompt-fallback'})`,
        scenario: `live-${index + 1}`,
        expectedCompleted: true,
        completed: result.success,
        outcomeCorrect: result.success,
        exactToolCalls:
          JSON.stringify(observed) === JSON.stringify(task.expected),
        historyIdsValid: protocol.idsValid,
        resultPairsOrdered: protocol.pairsOrdered,
        terminationCorrect:
          result.success &&
          (result.terminationReason === 'submit' ||
            result.terminationReason === 'forced_submit'),
        modelTurns: turns,
        forcedSubmit: result.terminationReason === 'forced_submit',
        resumeDeterministic: null,
        elapsedMs: Math.round(performance.now() - start),
        promptCharacters: chars,
        toolErrors: result.history.events.filter(
          (event) => event.role === 'tool' && event.isError
        ).length,
        failure: result.success
          ? null
          : `${result.error.code}: ${result.error.message}`,
      });
    }
  }
  print(metrics, 'OPTIONAL LIVE MODEL-QUALITY EVIDENCE');
}

if (liveArg) await live(liveArg.slice('--live='.length));
else await deterministic();
