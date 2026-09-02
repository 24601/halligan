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
 * Test-only helper. It lives under `benchmarks/` beside the other
 * measurement scaffolding rather than in the shipped `agentInternal/` tree,
 * and its `ax*` exports are listed in `internalExportNames` so the generated
 * barrel never carries them.
 */

import { AxMockAIService } from '../../ai/mock/api.js';
import {
  AX_HOST_SNIPPET_MARKER,
  AX_INPUTS_PATCH_GLOBAL,
} from '../agentInternal/sharedSession.js';
import type { AxCodeRuntime, AxCodeSession } from '../rlm.js';

/**
 * One scripted executor turn. A bare string is code only; the object form adds
 * the optional `skillState` output fields so a test can drive the mode's real
 * parse path rather than hand-feeding a patch to the kernel.
 */
export type AxWorkingStateScriptTurn =
  | string
  | Readonly<{ code: string; statePatch?: unknown; rationale?: string }>;

export type AxWorkingStateScript = Readonly<{
  distiller: readonly string[];
  executor: readonly AxWorkingStateScriptTurn[];
}>;

/** Render one scripted turn as the field-labelled content a provider returns. */
function renderScriptedTurn(turn: AxWorkingStateScriptTurn): string {
  if (typeof turn === 'string') return `Javascript Code: ${turn}`;
  const parts = [`Javascript Code: ${turn.code}`];
  if (turn.statePatch !== undefined) {
    parts.push(`State Patch: ${JSON.stringify(turn.statePatch)}`);
  }
  if (turn.rationale !== undefined) {
    parts.push(`Rationale: ${turn.rationale}`);
  }
  return parts.join('\n');
}

export const axWorkingStateHarnessUsage = () => ({
  ai: 'mock',
  model: 'mock',
  tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

/**
 * An evaluating stub session: the actor's code really runs.
 *
 * `usageInstructions` defaults to the empty string, which is what every
 * existing caller gets. Passing text containing `console.log` is how a test
 * turns ON the actor's incremental-console turn policy (the agent derives
 * `enforceIncrementalConsoleTurns` from these instructions), so a scripted
 * turn can be REFUSED by the policy rather than executed.
 */
export function axCreateEvaluatingRuntime(
  options?: Readonly<{ usageInstructions?: string }>
): AxCodeRuntime {
  const usageInstructions = options?.usageInstructions ?? '';
  return {
    getUsageInstructions: () => usageInstructions,
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
  /**
   * Per-turn SUM of the executor message content lengths, with no join
   * characters added. This is the number a measured-equals-sent assertion has
   * to match exactly; `executorPrompts` is for content assertions only.
   */
  executorPromptChars: number[];
} {
  let distillerIndex = 0;
  let executorIndex = 0;
  const executorPrompts: string[] = [];
  const executorPromptChars: number[] = [];
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
        const contents = chatPrompt.map((message) =>
          typeof message.content === 'string' ? message.content : ''
        );
        executorPrompts.push(contents.join('\n'));
        executorPromptChars.push(
          contents.reduce((total, content) => total + content.length, 0)
        );
        const index = Math.min(executorIndex++, script.executor.length - 1);
        content = renderScriptedTurn(script.executor[index]!);
      } else {
        content = 'Answer: done';
      }
      return {
        results: [{ index: 0, content, finishReason: 'stop' as const }],
        modelUsage: axWorkingStateHarnessUsage(),
      };
    },
  });
  return { ai, executorPrompts, executorPromptChars };
}
