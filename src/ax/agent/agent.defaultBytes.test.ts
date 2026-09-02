/**
 * Default-unchanged byte-identity fixture.
 *
 * Track B5 adds opt-in working state to the actor loop. The shipped promise is
 * that an agent configured WITHOUT `workingState` / `actorMemoryMode` /
 * `callTimeSkills` produces byte-identical prompts, signatures, exported state
 * and context events. That promise is only worth anything if it is pinned
 * BEFORE the behavioural commits land, so this file is the safety net every
 * later commit is re-run against.
 *
 * Four artifacts are pinned:
 *   1. the executor actor signature's field list (names, order, cached and
 *      optional flags, and the output field set);
 *   2. the executor actor SYSTEM PROMPT bytes (SHA-256 + exact length — a
 *      digest rather than a multi-kilobyte literal, so a single changed
 *      character fails);
 *   3. the exported `AxAgentState` top-level key set;
 *   4. one full `budget_check` context-event payload.
 *
 * A change here is either a deliberate, reviewed change to the default agent —
 * in which case update the constants in the same commit and say so in the PR —
 * or a regression in the default path.
 */

import { describe, expect, it } from 'vitest';
import { AxMockAIService } from '../ai/mock/api.js';
import type { AxAIService } from '../ai/types.js';
import { axEventCanonicalDigest } from '../event/util.js';
import {
  AX_HOST_SNIPPET_MARKER,
  AX_INPUTS_PATCH_GLOBAL,
} from './agentInternal/sharedSession.js';
import type { AxAgentFunction } from './index.js';
import { agent } from './index.js';
import type { AxCodeRuntime } from './rlm.js';

const EXECUTOR_MARKER = 'You (`executor`)';
const DISTILLER_MARKER = 'You (`distiller`)';

/** Pinned executor actor signature: name, order, cached and optional flags. */
const EXPECTED_ACTOR_INPUT_FIELDS = [
  'task:cached',
  'executorRequest:cached',
  'distilledContextSummary:cached,optional',
  'contextMetadata:cached,optional',
  'loadedSkills:cached,optional',
  'summarizedActorLog:cached,optional',
  'guidanceLog:optional',
  'actionLog',
  'liveRuntimeState:optional',
  'contextPressure:optional',
] as const;

const EXPECTED_ACTOR_OUTPUT_FIELDS = ['javascriptCode'] as const;

/** Pinned executor actor system prompt bytes. */
const EXPECTED_SYSTEM_PROMPT_DIGEST =
  '05133292d274ba3b8531137c0cbe13e021ae2fbaeaf7c6a246213ba5f1e7fbc0';
const EXPECTED_SYSTEM_PROMPT_CHARS = 8_447;

/** Pinned exported-state top-level keys (sorted). */
const EXPECTED_STATE_KEYS = [
  'actionLogEntries',
  'actorModelState',
  'checkpointState',
  'mcp',
  'provenance',
  'runtimeBindings',
  'runtimeEntries',
  'version',
] as const;

/** Pinned first executor `budget_check` payload. */
const EXPECTED_FIRST_BUDGET_CHECK = {
  kind: 'budget_check',
  stage: 'executor',
  turn: 1,
  pressure: 'ok',
  mutablePromptChars: 435,
  fixedPromptChars: 8_447,
  effectiveBudgetChars: 11_494,
  targetPromptChars: 16_000,
  checkpointActive: false,
  actionLogEntryCount: 0,
  guidanceLogEntryCount: 0,
} as const;

const makeModelUsage = () => ({
  ai: 'mock',
  model: 'mock',
  tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const getSystemPrompt = (
  chatPrompt: readonly { role: string; content?: unknown }[]
): string => {
  const first = chatPrompt[0];
  return typeof first?.content === 'string' ? first.content : '';
};

/** Stub runtime: routes `final(...)` to the completion binding, echoes logs. */
const makeRuntime = (): AxCodeRuntime => ({
  getUsageInstructions: () => '',
  createSession(globals) {
    return {
      execute: async (code: string) => {
        if (code.startsWith(AX_HOST_SNIPPET_MARKER)) return 'host-snippet';
        if (globals?.final && code.includes('final(')) {
          const match = code.match(/final\("([^"]*)"(?:,\s*(\{[^}]*\}))?\)/);
          if (match) {
            const extra = match[2] ? JSON.parse(match[2]) : {};
            (globals.final as (...args: unknown[]) => void)(match[1]!, extra);
          }
          return 'submitted';
        }
        return 'executed';
      },
      patchGlobals: async (patch: Record<string, unknown>) => {
        const { [AX_INPUTS_PATCH_GLOBAL]: staged, ...rest } = patch;
        Object.assign(globals ?? {}, rest);
        if (globals && staged && typeof staged === 'object') {
          globals.inputs = Object.assign(
            (globals.inputs as Record<string, unknown>) ?? {},
            staged
          );
        }
      },
      // State export requires a globals snapshot; a stable empty snapshot
      // keeps the exported state key set deterministic.
      snapshotGlobals: async () => ({}),
      close: () => {},
    };
  },
});

const stubFn: AxAgentFunction = {
  name: 'lookup',
  description: 'Look something up',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string', description: 'query' } },
    required: ['q'],
  },
  func: async () => 'result',
};

type FieldLike = {
  name: string;
  isOptional?: boolean;
  isCached?: boolean;
};

function describeFields(fields: readonly FieldLike[]): string[] {
  return fields.map((field) => {
    const flags: string[] = [];
    if (field.isCached) flags.push('cached');
    if (field.isOptional) flags.push('optional');
    return flags.length > 0 ? `${field.name}:${flags.join(',')}` : field.name;
  });
}

/**
 * Run one default-configured agent to completion against a scripted mock and
 * collect the four pinned artifacts.
 */
async function captureDefaultAgentArtifacts(): Promise<{
  inputFields: string[];
  outputFields: string[];
  systemPrompt: string;
  stateKeys: string[];
  firstExecutorBudgetCheck: Record<string, unknown> | undefined;
}> {
  let executorSystemPrompt = '';
  const contextEvents: Record<string, unknown>[] = [];

  const mockAI = new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      const systemPrompt = getSystemPrompt(
        req.chatPrompt as readonly { role: string; content?: unknown }[]
      );
      let content: string;
      if (systemPrompt.includes(DISTILLER_MARKER)) {
        content = 'Javascript Code: final("distilled", {"evidence":"summary"})';
      } else if (systemPrompt.includes(EXECUTOR_MARKER)) {
        if (!executorSystemPrompt) executorSystemPrompt = systemPrompt;
        content = 'Javascript Code: final("done", {"answer":"ok"})';
      } else {
        content = 'Answer: done';
      }
      return {
        results: [{ index: 0, content, finishReason: 'stop' as const }],
        modelUsage: makeModelUsage(),
      };
    },
  });

  const defaultAgent = agent('task:string -> answer:string', {
    functions: [stubFn],
    runtime: makeRuntime(),
    maxTurns: 4,
    onContextEvent: (event) => {
      contextEvents.push(event as unknown as Record<string, unknown>);
    },
  });

  await defaultAgent.forward(
    mockAI as unknown as AxAIService,
    {
      task: 'pin the default bytes',
    } as never
  );

  const actorSignature = (
    defaultAgent as unknown as { executor: { actorProgram: any } }
  ).executor.actorProgram.getSignature();

  const state = defaultAgent.getState();

  const firstExecutorBudgetCheck = contextEvents.find(
    (event) => event.kind === 'budget_check' && event.stage === 'executor'
  );

  return {
    inputFields: describeFields(
      actorSignature.getInputFields() as readonly FieldLike[]
    ),
    outputFields: describeFields(
      actorSignature.getOutputFields() as readonly FieldLike[]
    ),
    systemPrompt: executorSystemPrompt,
    stateKeys: state ? Object.keys(state).sort() : [],
    firstExecutorBudgetCheck,
  };
}

describe('default agent byte identity', () => {
  it('pins the executor actor signature field list', async () => {
    const captured = await captureDefaultAgentArtifacts();

    expect(captured.inputFields).toEqual([...EXPECTED_ACTOR_INPUT_FIELDS]);
    expect(captured.outputFields).toEqual([...EXPECTED_ACTOR_OUTPUT_FIELDS]);
  });

  it('pins the executor actor system prompt bytes', async () => {
    const captured = await captureDefaultAgentArtifacts();

    // A digest plus the exact length: a single changed character fails, and
    // the fixture stays readable.
    expect(captured.systemPrompt.length).toBe(EXPECTED_SYSTEM_PROMPT_CHARS);
    await expect(axEventCanonicalDigest(captured.systemPrompt)).resolves.toBe(
      EXPECTED_SYSTEM_PROMPT_DIGEST
    );
  });

  it('pins the exported agent state key set', async () => {
    const captured = await captureDefaultAgentArtifacts();

    expect(captured.stateKeys).toEqual([...EXPECTED_STATE_KEYS]);
  });

  it('pins the first executor budget_check payload', async () => {
    const captured = await captureDefaultAgentArtifacts();

    // Whole-payload identity: a new field, a renamed field or a changed
    // character count all fail here.
    expect(captured.firstExecutorBudgetCheck).toEqual({
      ...EXPECTED_FIRST_BUDGET_CHECK,
    });
  });
});
