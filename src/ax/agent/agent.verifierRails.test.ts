import { describe, expect, it } from 'vitest';

import { AxMockAIService } from '../ai/mock/api.js';
import {
  AX_HOST_SNIPPET_MARKER,
  AX_INPUTS_PATCH_GLOBAL,
} from './agentInternal/sharedSession.js';
import type { AxAgentContextEvent } from './contextEvents.js';
import { agent } from './index.js';
import type { AxCodeRuntime } from './rlm.js';
import type {
  AxAgentSkillCostProfile,
  AxAgentVerifierRail,
} from './skillCost.js';
import {
  AX_DEFAULT_VERIFICATION_MAX_ROUNDS,
  AX_MAX_RAIL_DIAGNOSTIC_CHARS,
  AX_MAX_RAIL_DIAGNOSTICS_PER_RUN,
} from './skillCost.js';

const SKILL = {
  id: 'release-checklist',
  name: 'Release checklist',
  content: '1. Bump version\n2. Run tests',
};

const makeModelUsage = () => ({
  ai: 'mock-ai',
  model: 'mock-model',
  tokens: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
});

/** Turn 1 calls the tool twice and declares the skill used; turn 2 finishes. */
function makeToolRuntime(toolCalls: number): AxCodeRuntime {
  return {
    getUsageInstructions: () => '',
    createSession(globals) {
      return {
        execute: async (code: string) => {
          if (code.startsWith(AX_HOST_SNIPPET_MARKER)) return 'host-snippet';
          if (globals?.final && code.includes('final(')) {
            (globals.final as (...args: unknown[]) => void)('done', {
              data: 'done',
            });
            return 'done';
          }
          if (code.includes('runTool')) {
            const utils = globals?.utils as
              | Record<string, (...args: unknown[]) => Promise<unknown>>
              | undefined;
            for (let index = 0; index < toolCalls; index++) {
              await utils?.probe?.({ index });
            }
            (
              globals?.used as
                | ((id: string, reason: string) => void)
                | undefined
            )?.(SKILL.id, 'followed the checklist');
            return 'tool ok';
          }
          return 'ok';
        },
        // REPL-faithful: the session is shared across stages, so the
        // executor's real callables arrive here. A no-op would leave the
        // distiller's throwing stubs bound for the whole run.
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
        close: () => {},
      };
    },
  } as AxCodeRuntime;
}

interface Capture {
  systems: string[];
  /** Executor USER prompts — where the rendered guidance log actually lands. */
  users: string[];
}

function makeMockAI(capture: Capture) {
  let executorTurn = 0;
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req) => {
      const system = String(req.chatPrompt[0]?.content ?? '');
      // Discriminate on the PROVIDED-fields line only: the distiller's prompt
      // also mentions `Executor Request`, because producing it is its job.
      const provided =
        system
          .split('\n')
          .find((line) =>
            line.includes('will be provided with the following fields')
          ) ?? '';
      if (provided.includes('`Executor Request`')) {
        executorTurn++;
        capture.systems.push(system);
        capture.users.push(String(req.chatPrompt[1]?.content ?? ''));
        return {
          results: [
            {
              index: 0,
              content:
                executorTurn === 1
                  ? 'Javascript Code: await runTool()'
                  : 'Javascript Code: await final("done", { data: "done" })',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: makeModelUsage(),
        };
      }
      if (provided.includes('`Loaded Skills`')) {
        return {
          results: [
            {
              index: 0,
              content: 'Javascript Code: final("forward the request", {})',
              finishReason: 'stop' as const,
            },
          ],
          modelUsage: makeModelUsage(),
        };
      }
      return {
        results: [
          { index: 0, content: 'Answer: done', finishReason: 'stop' as const },
        ],
        modelUsage: makeModelUsage(),
      };
    },
  });
}

const probeResults: unknown[] = [];
const probeTool = () => ({
  name: 'probe',
  description: 'A probe tool',
  parameters: {
    type: 'object' as const,
    properties: {
      index: { type: 'number' as const, description: 'call index' },
    },
  },
  func: async (args: Record<string, unknown>) => {
    probeResults.push(args.index);
    return { ok: true, index: args.index };
  },
});

function rail(
  id: string,
  verify: AxAgentVerifierRail['verify']
): AxAgentVerifierRail {
  return { id, stage: 'afterToolCall', verify };
}

async function run(
  options: Record<string, unknown>,
  toolCalls = 2
): Promise<Capture> {
  const capture: Capture = { systems: [], users: [] };
  const mockAI = makeMockAI(capture);
  const a = agent('query:string -> answer:string', {
    ai: mockAI,
    runtime: makeToolRuntime(toolCalls),
    functions: [probeTool()],
    skills: [SKILL],
    maxTurns: 4,
    ...options,
  } as never);
  await a.forward(mockAI, { query: 'ship it' });
  return capture;
}

describe('verifier rails', () => {
  it('fires after every tool call and surfaces only novel diagnostics', async () => {
    const seen: string[] = [];
    const capture = await run({
      verifierRails: [
        rail('audit', (context) => {
          seen.push(context.qualifiedName);
          return [
            {
              signature: 'audit:same-fact',
              code: 'audit',
              message: 'the same fact every call',
              severity: 'info',
            },
          ];
        }),
      ],
    });
    // The rail saw both calls...
    expect(seen).toEqual(['utils.probe', 'utils.probe']);
    // ...and the repeated fact reached the NEXT executor turn's prompt exactly
    // once. Asserting on the rendered prompt, not on a callback that never
    // carried the guidance log, is what makes this test able to fail.
    const injected = capture.users.at(-1) ?? '';
    expect(injected.split('the same fact every call')).toHaveLength(2);
  });

  it('a throwing rail leaves the tool result unchanged and is disabled', async () => {
    probeResults.length = 0;
    const calls: string[] = [];
    const events: AxAgentContextEvent[] = [];
    await run({
      verifierRails: [
        rail('boom', () => {
          calls.push('boom');
          throw new Error('rail exploded');
        }),
      ],
      skillPolicy: { verificationBudget: { maxRounds: 10 } },
      onContextEvent: (event: AxAgentContextEvent) => events.push(event),
    });
    // The tool still ran, twice, and returned normally.
    expect(probeResults).toEqual([0, 1]);
    // The rail was disabled after its first failure, so it never fired again.
    expect(calls).toHaveLength(1);
    const budget = events.filter(
      (event) => event.kind === 'verification_budget'
    );
    expect(budget.length).toBeGreaterThan(0);
    const last = budget[budget.length - 1];
    if (last?.kind !== 'verification_budget') throw new Error('unreachable');
    expect(last.disabledRails).toEqual(['boom']);
  });

  it('a never-resolving rail is cut off at railTimeoutMs without failing the call', async () => {
    probeResults.length = 0;
    const started = Date.now();
    await run({
      verifierRails: [rail('hang', () => new Promise<never>(() => {}))],
      skillPolicy: {
        verificationBudget: { maxRounds: 10, railTimeoutMs: 20 },
      },
    });
    expect(probeResults).toEqual([0, 1]);
    // Bounded by the deadline, not by the rail.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops firing rails once the verification budget is exceeded', async () => {
    const fired: string[] = [];
    const events: AxAgentContextEvent[] = [];
    await run(
      {
        verifierRails: [
          rail('count', () => {
            fired.push('x');
            return [];
          }),
        ],
        skillPolicy: { verificationBudget: { maxRounds: 1 } },
        onContextEvent: (event: AxAgentContextEvent) => events.push(event),
      },
      3
    );
    // One round is the whole budget: the state is absorbing.
    expect(fired).toHaveLength(1);
    const last = events
      .filter((event) => event.kind === 'verification_budget')
      .pop();
    if (last?.kind !== 'verification_budget') throw new Error('unreachable');
    expect(last.status).toBe('exceeded');
    expect(last.rounds).toBe(1);
  });

  it('counts a declared verification tool as a round with no rails at all', async () => {
    // RFC 7.5's second half. `verificationTools` was a public option nothing
    // read, so a host that set it got silence.
    const events: AxAgentContextEvent[] = [];
    await run(
      {
        skillPolicy: {
          verificationBudget: {
            maxRounds: 4,
            verificationTools: ['utils.probe'],
          },
        },
        onContextEvent: (event: AxAgentContextEvent) => events.push(event),
      },
      3
    );
    const budget = events.filter(
      (event) => event.kind === 'verification_budget'
    );
    const last = budget[budget.length - 1];
    if (last?.kind !== 'verification_budget') throw new Error('unreachable');
    expect(last.rounds).toBe(3);
    expect(last.status).toBe('within');
  });

  it('an unlisted tool name advances nothing', async () => {
    const events: AxAgentContextEvent[] = [];
    await run(
      {
        skillPolicy: {
          verificationBudget: {
            maxRounds: 4,
            verificationTools: ['utils.somethingElse'],
          },
        },
        onContextEvent: (event: AxAgentContextEvent) => events.push(event),
      },
      3
    );
    expect(
      events.filter((event) => event.kind === 'verification_budget')
    ).toHaveLength(0);
  });

  it('applies a default ceiling when rails are configured with no budget', async () => {
    // The unbounded configuration the evaluation names as its baseline must not
    // be reachable in production: an always-on hook needs a ceiling even when
    // the host named none.
    const fired: string[] = [];
    const events: AxAgentContextEvent[] = [];
    await run(
      {
        verifierRails: [
          rail('count', () => {
            fired.push('x');
            return [];
          }),
        ],
        onContextEvent: (event: AxAgentContextEvent) => events.push(event),
      },
      40
    );
    expect(fired).toHaveLength(AX_DEFAULT_VERIFICATION_MAX_ROUNDS);
    const last = events
      .filter((event) => event.kind === 'verification_budget')
      .pop();
    if (last?.kind !== 'verification_budget') throw new Error('unreachable');
    expect(last.status).toBe('exceeded');
    expect(last.maxRounds).toBe(AX_DEFAULT_VERIFICATION_MAX_ROUNDS);
  });

  it('bounds a rail that emits a fresh novel diagnostic on every call', async () => {
    // Dedupe cannot bound a rail whose signature changes every call, and the
    // guidance log neither caps nor truncates.
    let call = 0;
    const capture = await run(
      {
        verifierRails: [
          rail('chatty', () => {
            call += 1;
            return [
              {
                signature: `chatty:${call}`,
                code: 'chatty',
                message: `novel fact ${call} ${'x'.repeat(5000)}`,
                severity: 'info' as const,
              },
            ];
          }),
        ],
        skillPolicy: { verificationBudget: { maxRounds: 200 } },
      },
      60
    );
    const injected = capture.users.at(-1) ?? '';
    const distinct = injected.split('novel fact ').length - 1;
    expect(distinct).toBeLessThanOrEqual(AX_MAX_RAIL_DIAGNOSTICS_PER_RUN);
    expect(distinct).toBeGreaterThan(0);
    // Each one is bounded too: a rail cannot grow the prompt by a novel.
    expect(injected.length).toBeLessThanOrEqual(
      AX_MAX_RAIL_DIAGNOSTICS_PER_RUN * (AX_MAX_RAIL_DIAGNOSTIC_CHARS + 200)
    );
  });

  it('leaves the executor prompt byte-identical when a budget is set', async () => {
    // The budget is counted by the runtime and is never stated in a prompt.
    const withoutBudget = await run({});
    const withBudget = await run({
      skillPolicy: { verificationBudget: { maxRounds: 2 } },
    });
    expect(withoutBudget.systems[0]).not.toBe('');
    expect(withBudget.systems[0]).toBe(withoutBudget.systems[0]);
  });
});

describe('per-skill cost accounting', () => {
  it('onSkillCost alone enables usage tracking and produces profiles', async () => {
    const received: (readonly AxAgentSkillCostProfile[])[] = [];
    let clock = 1_000;
    await run({
      // Deliberately no onUsedSkills: without widening the tracking flag every
      // profile would stay empty and cost-aware ranking would be silently inert.
      onSkillCost: (profiles: readonly AxAgentSkillCostProfile[]) => {
        received.push(profiles);
      },
      skillPolicy: {
        now: () => {
          clock += 500;
          return clock;
        },
      },
    });
    const profiles = received.at(-1) ?? [];
    const entry = profiles.find((profile) => profile.id === SKILL.id);
    expect(entry).toBeDefined();
    expect(entry?.uses).toBe(1);
    expect(entry?.loads).toBeGreaterThanOrEqual(1);
    expect(entry?.tokensAttributed).toBeUndefined();
    expect(entry?.tokensTotal).toBeGreaterThan(0);
    expect(entry?.updatedAt).toBe(new Date(clock).toISOString());
  });

  it('stamps attributed cost onto the declared used skills', async () => {
    const used: { id: string; tokensAttributed?: number; wallMs?: number }[] =
      [];
    await run({
      onSkillCost: () => {},
      onUsedSkills: (
        skills: readonly {
          id: string;
          tokensAttributed?: number;
          wallMs?: number;
        }[]
      ) => {
        used.push(...skills);
      },
      skillPolicy: { now: () => 5_000 },
    });
    const entry = used.find((skill) => skill.id === SKILL.id);
    expect(entry?.tokensAttributed).toBeGreaterThan(0);
    expect(entry?.wallMs).toBe(0);
  });

  it('produces no profiles at all without onSkillCost', async () => {
    // `onUsedSkills` alone must not start cost accounting: the used-skill
    // records stay free of attributed cost and no profile is ever built.
    const used: { id: string; tokensAttributed?: number; wallMs?: number }[] =
      [];
    await run({
      onUsedSkills: (
        skills: readonly {
          id: string;
          tokensAttributed?: number;
          wallMs?: number;
        }[]
      ) => {
        used.push(...skills);
      },
    });
    const entry = used.find((skill) => skill.id === SKILL.id);
    expect(entry).toBeDefined();
    expect(entry?.tokensAttributed).toBeUndefined();
    expect(entry?.wallMs).toBeUndefined();
  });
});
