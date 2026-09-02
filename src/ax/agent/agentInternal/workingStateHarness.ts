/**
 * Shared offline harness for the working-state loop tests.
 *
 * Unlike the regex-matching stubs used elsewhere in `benchmarks/`, this
 * session actually EVALUATES the actor's code against the real runtime
 * globals, so `await utils.lookup(...)` genuinely reaches `wrapFunction`,
 * genuinely fires `functionCallRecorder`, and genuinely mints (or refuses to
 * mint) a receipt. A stub that pattern-matched the call string could not
 * distinguish a real dispatch from a fabricated one, which is exactly the
 * distinction the receipt gate exists to make.
 *
 * Test-only helper — not exported from `src/ax/index.ts`.
 */

import { AxMockAIService } from '../../ai/mock/api.js';
import type { AxCodeRuntime, AxCodeSession } from '../rlm.js';
import {
  AX_HOST_SNIPPET_MARKER,
  AX_INPUTS_PATCH_GLOBAL,
} from './sharedSession.js';

export type AxWorkingStateScript = Readonly<{
  distiller: readonly string[];
  executor: readonly string[];
}>;

export const axWorkingStateHarnessUsage = () => ({
  ai: 'mock',
  model: 'mock',
  tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

/** An evaluating stub session: the actor's code really runs. */
export function axCreateEvaluatingRuntime(): AxCodeRuntime {
  return {
    getUsageInstructions: () => '',
    createSession(globals): AxCodeSession {
      const scope: Record<string, unknown> = globals ?? {};
      return {
        execute: async (code: string) => {
          if (code.startsWith(AX_HOST_SNIPPET_MARKER)) return 'host-snippet';
          const logs: string[] = [];
          const sandboxConsole = {
            log: (...parts: unknown[]) => {
              logs.push(
                parts
                  .map((part) =>
                    typeof part === 'string' ? part : JSON.stringify(part)
                  )
                  .join(' ')
              );
            },
          };
          const names = Object.keys(scope);
          const body = `return (async () => {\n${code}\n})();`;
          // A test-only sandbox. The actor's code must really execute for the
          // receipt gate to be exercised rather than simulated.
          const factory = new Function('console', ...names, body) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const returned = await factory(
            sandboxConsole,
            ...names.map((name) => scope[name])
          );
          if (logs.length > 0) return logs.join('\n');
          return typeof returned === 'string' ? returned : 'executed';
        },
        patchGlobals: async (patch: Record<string, unknown>) => {
          const { [AX_INPUTS_PATCH_GLOBAL]: staged, ...rest } = patch;
          Object.assign(scope, rest);
          if (staged && typeof staged === 'object') {
            scope.inputs = Object.assign(
              (scope.inputs as Record<string, unknown>) ?? {},
              staged
            );
          }
        },
        snapshotGlobals: async () => ({ bindings: {}, entries: [] }) as never,
        close: () => {},
      };
    },
  };
}

const DISTILLER_MARKER = 'You (`distiller`)';
const EXECUTOR_MARKER = 'You (`executor`)';

function systemPromptOf(
  chatPrompt: readonly { role: string; content?: unknown }[]
): string {
  const first = chatPrompt[0];
  return typeof first?.content === 'string' ? first.content : '';
}

/**
 * A mock AI that replays one scripted code payload per actor turn and records
 * every executor prompt it was given (so a test can assert what the model
 * could actually see).
 */
export function axCreateScriptedMock(script: AxWorkingStateScript): {
  ai: AxMockAIService<unknown>;
  executorPrompts: string[];
} {
  let distillerIndex = 0;
  let executorIndex = 0;
  const executorPrompts: string[] = [];
  const ai = new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      const chatPrompt = req.chatPrompt as readonly {
        role: string;
        content?: unknown;
      }[];
      const systemPrompt = systemPromptOf(chatPrompt);
      let content: string;
      if (systemPrompt.includes(DISTILLER_MARKER)) {
        const index = Math.min(distillerIndex++, script.distiller.length - 1);
        content = `Javascript Code: ${script.distiller[index]}`;
      } else if (systemPrompt.includes(EXECUTOR_MARKER)) {
        executorPrompts.push(
          chatPrompt
            .map((message) =>
              typeof message.content === 'string' ? message.content : ''
            )
            .join('\n')
        );
        const index = Math.min(executorIndex++, script.executor.length - 1);
        content = `Javascript Code: ${script.executor[index]}`;
      } else {
        content = 'Answer: done';
      }
      return {
        results: [{ index: 0, content, finishReason: 'stop' as const }],
        modelUsage: axWorkingStateHarnessUsage(),
      };
    },
  });
  return { ai, executorPrompts };
}
