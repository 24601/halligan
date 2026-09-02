/**
 * Loop-level call-time skill injection: the dispatch-site interception, the
 * five negative guarantees it has to hold (no execution, no authorization, no
 * `onFunctionCall`, no recorder record, no receipt), the speculation-adapter
 * interlock, and the delivery of the skill and the guidance.
 *
 * Every scenario drives a real `agent(...)` over a scripted mock model and an
 * EVALUATING code runtime, so `await inventory.adjustStock(...)` genuinely
 * reaches `wrapFunction`. A stub that matched the call string could not tell a
 * call that was refused from one that never happened, which is the distinction
 * this whole mechanism rests on.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AxAIService } from '../ai/types.js';
import { axExtractSkillProvenance } from '../authority/skillProvenance.js';
import type {
  AxAuthorityContext,
  AxAuthorizationReceipt,
  AxCapabilityGrant,
} from '../authority/types.js';
import { getJSRuntimeHostFunctionSpeculationAdapter } from '../funcs/jsRuntimeHostFunction.js';
import { wrapFunction } from './agentInternal/runtimeGlobals.js';
import type { AxAgentCatalogSkill } from './agentInternal/skillsTypes.js';
import {
  type AxWorkingStateScript,
  axCreateScriptedMock,
} from './benchmarks/workingStateHarness.js';
import { axIsCallTimeSkillNotExecuted } from './callTimeSkills.js';
import type { AxAgentFunction } from './index.js';
import { agent } from './index.js';
import type { AxCodeRuntime, AxCodeSession } from './rlm.js';
import {
  type AxWorkingStateConfig,
  AxWorkingStateSchemaError,
  type AxWorkingStateTraceStep,
} from './workingState.js';

const ADJUST = 'inventory.adjustStock';
const PICK = 'inventory.pick';
const STATE_SIGNATURE = 'orderId:string, itemsPacked:number, shipped:boolean';

const FINAL = 'await final("done", {"answer":"ok"})';
const DISTILL = 'await final("distilled", {"evidence":"summary"})';

const SKILL_BODY =
  '# Adjusting stock\n\nReserve the line before adjusting it, then adjust once.';

const catalog: readonly AxAgentCatalogSkill[] = [
  {
    id: 'stock-adjustment',
    name: 'Stock adjustment',
    description: 'How to adjust stock safely',
    content: SKILL_BODY,
  },
];

/** The bound, state-changing tool. Its body records that it really ran. */
function makeAdjustFn(): {
  fn: AxAgentFunction;
  calls: { sku: string }[];
} {
  const calls: { sku: string }[] = [];
  return {
    calls,
    fn: {
      name: 'adjustStock',
      description: 'Adjust stock for a sku',
      namespace: 'inventory',
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string', description: 'sku' } },
        required: ['sku'],
      },
      func: async (args) => {
        calls.push(args as { sku: string });
        return { adjusted: true };
      },
    },
  };
}

/** An UNBOUND tool in the same run, so every negative has a positive control. */
function makePickFn(): { fn: AxAgentFunction; calls: { order: string }[] } {
  const calls: { order: string }[] = [];
  return {
    calls,
    fn: {
      name: 'pick',
      description: 'Pick a line on an order',
      namespace: 'inventory',
      parameters: {
        type: 'object',
        properties: { order: { type: 'string', description: 'order id' } },
        required: ['order'],
      },
      func: async (args) => {
        calls.push(args as { order: string });
        return { picked: 3 };
      },
    },
  };
}

/**
 * An evaluating runtime that captures the tool globals it was handed and —
 * under `speculate` — drives the JS runtime's SPECULATION path for any
 * callable that carries an adapter: `launch()` early, `commit()` at the
 * logical call. That is the second entry point into a wrapped function, and it
 * bypasses `runLogicalCall` entirely.
 *
 * The stages share one session here, and the EXECUTOR's real callables arrive
 * through `patchGlobals` rather than through `createSession` (the distiller's
 * are throwing stubs). Both paths therefore go through the same wrapping, or
 * the speculation arm would silently test nothing.
 */
function createRuntime(
  options?: Readonly<{ speculate?: boolean; deterministic?: readonly string[] }>
): AxCodeRuntime & {
  globals: () => Record<string, unknown>;
  launched: () => readonly string[];
} {
  const captured: Record<string, unknown> = {};
  const speculate = options?.speculate === true;
  const deterministic = new Set(options?.deterministic ?? []);
  /**
   * Qualified names this harness actually drove down the speculation path.
   *
   * The POSITIVE CONTROL for the [T4] behavioural test: every end-state
   * assertion there ("the tool did not run", "only the unbound callable
   * minted") holds identically if the harness silently stopped speculating —
   * a rename in `jsRuntimeHostFunction.ts` would do it, and an earlier version
   * of this harness did exactly that and passed with the guard removed.
   * Asserting this list turns that state back into a failure.
   */
  const launched: string[] = [];

  const wrapSpeculating = (
    name: string,
    fn: (...args: unknown[]) => Promise<unknown>
  ): ((...args: unknown[]) => Promise<unknown>) => {
    return async (...args: unknown[]) => {
      const adapter = getJSRuntimeHostFunctionSpeculationAdapter(fn);
      // No adapter ⇒ the ordinary logical path. With one, the runtime launches
      // the physical call BEFORE the logical call is committed.
      if (!adapter) return fn(...args);
      launched.push(name);
      const controller = new AbortController();
      const launch = await adapter.launch(args, controller.signal);
      const committed = await adapter.commit(args, launch);
      if (deterministic.has(name)) {
        // A `deterministic: true` allowlist entry lets the runtime satisfy a
        // repeated logical call from the SAME physical launch, so
        // `functionCallRecorder` and the receipt sink fire twice for one
        // environment change (RFC §7.7).
        await adapter.commit(args, launch);
      }
      return committed;
    };
  };

  const speculateScope = (value: unknown, path: string): unknown => {
    if (typeof value === 'function') {
      return wrapSpeculating(
        path,
        value as (...a: unknown[]) => Promise<unknown>
      );
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>
      )) {
        out[key] = speculateScope(entry, path ? `${path}.${key}` : key);
      }
      return out;
    }
    return value;
  };

  const install = (
    scope: Record<string, unknown>,
    values: Record<string, unknown>
  ): void => {
    Object.assign(captured, values);
    Object.assign(
      scope,
      speculate
        ? (speculateScope(values, '') as Record<string, unknown>)
        : values
    );
  };

  return {
    globals: () => captured,
    launched: () => launched,
    getUsageInstructions: () => '',
    createSession(globals): AxCodeSession {
      const scope: Record<string, unknown> = {};
      install(scope, (globals ?? {}) as Record<string, unknown>);
      return {
        execute: async (code: string) => {
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
          install(scope, patch);
        },
        snapshotGlobals: async () => ({ bindings: {}, entries: [] }) as never,
        close: () => {},
      };
    },
  };
}

function makeAgent(
  script: AxWorkingStateScript,
  extra: Record<string, unknown>,
  runtime?: ReturnType<typeof createRuntime>
) {
  const { ai, executorPrompts } = axCreateScriptedMock(script);
  const codeRuntime = runtime ?? createRuntime();
  const adjust = makeAdjustFn();
  const pick = makePickFn();
  const built = agent('task:string -> answer:string', {
    functions: [adjust.fn, pick.fn],
    runtime: codeRuntime,
    skillsCatalog: catalog,
    maxTurns: 6,
    ...extra,
  });
  return {
    ai: ai as unknown as AxAIService,
    agent: built,
    executorPrompts,
    adjustCalls: adjust.calls,
    pickCalls: pick.calls,
    runtime: codeRuntime,
  };
}

const workingStateConfig = (
  overrides?: Partial<AxWorkingStateConfig<any>>
): AxWorkingStateConfig<any> => ({
  stateSignature: STATE_SIGNATURE,
  proposer: 'actor',
  ...overrides,
});

describe('call-time skill injection: configuration at the agent boundary', () => {
  it('throws when a binding names a callable this agent does not register', async () => {
    // Enforced at RUN START rather than in the constructor, because MCP and
    // UCP callables only exist once an execution context does. A typo would
    // otherwise be a silent no-op for the whole run.
    const { agent: built, ai } = makeAgent(
      { distiller: [DISTILL], executor: [FINAL] },
      {
        callTimeSkills: [
          { qualifiedName: 'inventory.typo', skill: 'stock-adjustment' },
        ],
      }
    );
    await expect(
      built.forward(ai, { task: 'x' } as never)
    ).rejects.toBeInstanceOf(AxWorkingStateSchemaError);
  });

  it('throws at construction on an unresolvable skill id', () => {
    expect(() =>
      agent('task:string -> answer:string', {
        functions: [makePickFn().fn],
        skillsCatalog: catalog,
        callTimeSkills: [{ qualifiedName: PICK, skill: 'no-such-skill' }],
      })
    ).toThrow(/unknown_bound_skill/);
  });

  it('throws at construction on a when predicate with no working state', () => {
    expect(() =>
      agent('task:string -> answer:string', {
        functions: [makePickFn().fn],
        skillsCatalog: catalog,
        callTimeSkills: [
          { qualifiedName: PICK, skill: 'stock-adjustment', when: () => true },
        ],
      })
    ).toThrow(/when_requires_working_state/);
  });
});

describe('call-time skill injection: the catalog gates', () => {
  /**
   * A binding is static host config; the two catalog gates are not. A bound
   * catalog id must therefore be re-asked at run start against the run's
   * declared environment and its authority snapshot — otherwise a call-time
   * binding is the ONE path that renders a body `discover({ skills })`, the
   * `### Available Skills` index, the relevance hint and the kernel tier all
   * refuse to render.
   */
  const GATED_BODY = '# Gated procedure\n\nOnly valid where redis is present.';

  const gatedCatalog = (
    extra: Partial<AxAgentCatalogSkill>
  ): readonly AxAgentCatalogSkill[] => [
    {
      id: 'gated-skill',
      name: 'Gated skill',
      description: 'A skill the host hid behind a gate',
      content: GATED_BODY,
      ...extra,
    },
  ];

  const revokedProvenance = () =>
    axExtractSkillProvenance({
      receipts: [
        {
          version: 1,
          receiptId: 'r-1',
          requestId: 'q-1',
          decision: 'allow',
          operation: 'files.read',
          resource: { type: 'file', id: 'f-1' },
          principalId: 'p-1',
          actor: { id: 'a-1', kind: 'agent' },
          grantIds: ['grant:held'],
          leaseEpoch: 1,
          authorizedAt: 1,
        },
      ],
      leaseEpoch: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });

  it('refuses the run when the bound skill is ineligible here, and never renders it', async () => {
    const {
      agent: built,
      ai,
      executorPrompts,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {
        skillsCatalog: gatedCatalog({ requires: { bins: ['redis-cli'] } }),
        skillPolicy: { environment: { bins: [] } },
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'gated-skill' }],
      }
    );

    const error = await built
      .forward(ai, { task: 'adjust' } as never)
      .then(() => undefined)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AxWorkingStateSchemaError);
    expect((error as AxWorkingStateSchemaError).detail).toBe(
      'ineligible_bound_skill: gated-skill'
    );
    // Fail-closed AND silent about the body: the whole point of `requires` is
    // that the procedure is wrong for this host.
    expect(executorPrompts.join('\n')).not.toContain(GATED_BODY);
  });

  it('refuses the run when the retrieval re-check denied the bound skill', async () => {
    // The authority half is time- and authority-varying: an expired grant or a
    // revoked trajectory parks a skill mid-lifecycle, long after the binding
    // was written. "The host named it by id" is not an answer.
    const {
      agent: built,
      ai,
      executorPrompts,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {
        skillsCatalog: gatedCatalog({
          authorityProvenance: revokedProvenance(),
        }),
        skillPolicy: {
          authoritySnapshot: { grantIds: [], leaseEpoch: 1 },
          precondition: { grant_revoked: 'drop' as const },
          now: () => 0,
        },
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'gated-skill' }],
      }
    );

    const error = await built
      .forward(ai, { task: 'adjust' } as never)
      .then(() => undefined)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AxWorkingStateSchemaError);
    expect((error as AxWorkingStateSchemaError).detail).toBe(
      'denied_bound_skill: gated-skill'
    );
    expect(executorPrompts.join('\n')).not.toContain(GATED_BODY);
  });

  it('injects the same skill when both gates admit it', async () => {
    // The positive control for both negatives above: the binding, the catalog
    // entry and the script are identical — only the run's environment differs.
    const {
      agent: built,
      ai,
      executorPrompts,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {
        skillsCatalog: gatedCatalog({ requires: { bins: ['redis-cli'] } }),
        skillPolicy: { environment: { bins: ['redis-cli'] } },
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'gated-skill' }],
      }
    );

    await built.forward(ai, { task: 'adjust' } as never);
    expect(adjustCalls).toHaveLength(0);
    expect(executorPrompts[1]).toContain(GATED_BODY);
  });

  it('leaves an INLINE bound skill alone — no catalog gate can hide it', async () => {
    // Host-supplied literal text, the `presetSkills` posture. A denied catalog
    // entry sharing its id must not reach through and refuse the run.
    const {
      agent: built,
      ai,
      executorPrompts,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {
        skillsCatalog: gatedCatalog({ requires: { bins: ['redis-cli'] } }),
        skillPolicy: { environment: { bins: [] } },
        callTimeSkills: [
          {
            qualifiedName: ADJUST,
            skill: { id: 'inline', name: 'Inline', content: 'INLINE BODY' },
          },
        ],
      }
    );

    await built.forward(ai, { task: 'adjust' } as never);
    expect(executorPrompts[1]).toContain('INLINE BODY');
    expect(executorPrompts.join('\n')).not.toContain(GATED_BODY);
  });
});

describe('call-time skill injection: the intercepted call', () => {
  it('an unbound callable executes normally and mints a receipt', async () => {
    // The positive control for every negative below: with no binding for
    // `inventory.pick`, today's function-call contract is untouched.
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.pick({order:"42"})', FINAL],
      },
      {
        workingState: workingStateConfig(),
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
      }
    );

    await built.forward(ai, { task: 'pack' } as never);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.qualifiedName).toBe(PICK);
  });

  it('a bound callable returns the not-executed marker and does not run', async () => {
    const {
      agent: built,
      ai,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'console.log(JSON.stringify(await inventory.adjustStock({sku:"a1"})))',
          FINAL,
        ],
      },
      { callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }] }
    );

    await built.forward(ai, { task: 'adjust a1' } as never);

    // The tool body never ran.
    expect(adjustCalls).toHaveLength(0);
    const log = built
      .getState()
      ?.actionLogEntries?.find((entry) => entry.code.includes('adjustStock'));
    expect(log).toBeDefined();
    const marker = JSON.parse(log?.output ?? '{}');
    expect(axIsCallTimeSkillNotExecuted(marker)).toBe(true);
    expect(marker.qualifiedName).toBe(ADJUST);
    expect(marker.skillId).toBe('stock-adjustment');
    // Returned, not thrown: an interception is not a failure and must not be
    // tagged as an error turn, which would feed the escalation policy.
    expect(log?.tags ?? []).not.toContain('error');
  });

  it('an intercepted call requests no authorization while an unbound one does', async () => {
    const authorize = vi.fn(
      (
        operation: string,
        context: {
          requestId: string;
          principal: { id: string };
          actor: { id: string; kind: string };
          resource: { type: string; id: string };
          grants: readonly { id: string }[];
          leaseEpoch: number;
          now: number;
        }
      ): AxAuthorizationReceipt =>
        ({
          version: 1,
          receiptId: `r-${context.requestId}`,
          requestId: context.requestId,
          decision: 'allow',
          operation,
          resource: context.resource,
          principalId: context.principal.id,
          actor: { id: context.actor.id, kind: context.actor.kind },
          grantIds: context.grants.map((grant) => grant.id),
          leaseEpoch: context.leaseEpoch,
          authorizedAt: context.now,
        }) as AxAuthorizationReceipt
    );
    const grant: AxCapabilityGrant = {
      version: 1,
      id: 'g1',
      principalId: 'p1',
      operations: ['function.call'],
      resources: [
        { type: 'function', id: ADJUST },
        { type: 'function', id: PICK },
      ],
      leaseEpoch: 1,
    };
    const authority: AxAuthorityContext = {
      principal: { id: 'p1' },
      actor: { id: 'a1', kind: 'agent' },
      grants: [grant],
      leaseEpoch: 1,
      authorize: authorize as never,
    };

    const {
      agent: built,
      ai,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'await inventory.adjustStock({sku:"a1"}); await inventory.pick({order:"42"})',
          FINAL,
        ],
      },
      { callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }] }
    );

    await built.forward(ai, { task: 'adjust' } as never, { authority });

    expect(adjustCalls).toHaveLength(0);
    // The interception happens BEFORE the authority boundary, so no
    // authorization decision is requested for a call that did not happen —
    // and the unbound callable in the same turn still requests one.
    const authorized = authorize.mock.calls.map(
      ([, context]) => (context as { resource: { id: string } }).resource.id
    );
    expect(authorized).toEqual([PICK]);
  });

  it('an intercepted call fires no onFunctionCall', async () => {
    const onFunctionCall = vi.fn(async () => {});
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'await inventory.adjustStock({sku:"a1"}); await inventory.pick({order:"42"})',
          FINAL,
        ],
      },
      {
        onFunctionCall,
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
      }
    );

    await built.forward(ai, { task: 'adjust' } as never);

    const observed = onFunctionCall.mock.calls.map(
      ([call]) => (call as { qualifiedName: string }).qualifiedName
    );
    expect(observed).not.toContain(ADJUST);
    expect(observed).toContain(PICK);
  });

  it('an intercepted call mints no receipt', async () => {
    // A skill injection can never support a goal completion: the receipt is
    // the ONLY thing that flips a goal to done.
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {
        workingState: workingStateConfig(),
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
      }
    );

    await built.forward(ai, { task: 'adjust' } as never);
    expect(built.getState()?.workingState?.receipts ?? []).toHaveLength(0);
  });

  it('the second call to the same callable executes (maxInjections 1)', async () => {
    // One nudge, then normal operation. Without the budget the model can loop
    // forever re-drafting the same call.
    const {
      agent: built,
      ai,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'await inventory.adjustStock({sku:"a1"})',
          'await inventory.adjustStock({sku:"a1"})',
          FINAL,
        ],
      },
      { callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }] }
    );

    await built.forward(ai, { task: 'adjust' } as never);
    expect(adjustCalls).toEqual([{ sku: 'a1' }]);
  });

  it('when(state) false falls through to normal execution', async () => {
    const when = vi.fn(
      (state: { facts: Record<string, unknown> }) =>
        state.facts.shipped !== true
    );
    const {
      agent: built,
      ai,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {
        workingState: workingStateConfig({
          initial: { facts: { shipped: true } as never },
        }),
        callTimeSkills: [
          {
            qualifiedName: ADJUST,
            skill: 'stock-adjustment',
            when: when as never,
          },
        ],
      }
    );

    await built.forward(ai, { task: 'adjust' } as never);
    expect(when).toHaveBeenCalled();
    expect(adjustCalls).toEqual([{ sku: 'a1' }]);
  });
});

describe('call-time skill injection at the dispatch site (wrapFunction)', () => {
  /**
   * `wrapFunction` is where the interception physically lives, so the four
   * observability contracts are asserted against it directly: the loop-level
   * tests above cannot see `functionCallRecorder` or the receipt sink, because
   * neither is carried on the serialized agent state.
   */
  function wrap(options: Readonly<{ bound: boolean }>) {
    const func = vi.fn(async () => ({ adjusted: true }));
    const recorder = vi.fn();
    const onFunctionCall = vi.fn(async () => {});
    const sink = vi.fn();
    const marker = Object.freeze({
      __axNotExecuted: true as const,
      reason: 'skill_injected' as const,
      qualifiedName: ADJUST,
      skillId: 'stock-adjustment',
      guidance: 'g',
    });
    const wrapped = wrapFunction(
      {
        name: 'adjustStock',
        description: 'Adjust stock',
        parameters: {
          type: 'object',
          properties: { sku: { type: 'string', description: 'sku' } },
          required: ['sku'],
        },
        func,
      },
      undefined,
      undefined,
      undefined,
      ADJUST,
      recorder,
      'external',
      onFunctionCall,
      undefined,
      undefined,
      undefined,
      { eligible: true, sink, now: () => 1_700_000_000_000 },
      undefined,
      options.bound ? () => marker : undefined
    );
    return { wrapped, func, recorder, onFunctionCall, sink, marker };
  }

  it('returns the marker and reaches neither observer nor the receipt sink', async () => {
    const bound = wrap({ bound: true });
    const result = await bound.wrapped({ sku: 'a1' });

    expect(result).toBe(bound.marker);
    expect(bound.func).not.toHaveBeenCalled();
    // The recorder is the raw material for receipts and for the evaluation
    // record; a call that did not happen must not appear in it.
    expect(bound.recorder).not.toHaveBeenCalled();
    expect(bound.onFunctionCall).not.toHaveBeenCalled();
    expect(bound.sink).not.toHaveBeenCalled();
    expect(
      getJSRuntimeHostFunctionSpeculationAdapter(bound.wrapped)
    ).toBeUndefined();
  });

  it('an unbound callable still executes, records, observes and mints', async () => {
    // The positive control: every negative above is about the binding, not
    // about the fixture being inert.
    const unbound = wrap({ bound: false });
    await unbound.wrapped({ sku: 'a1' });

    expect(unbound.func).toHaveBeenCalledTimes(1);
    expect(unbound.recorder).toHaveBeenCalledTimes(1);
    expect(unbound.onFunctionCall).toHaveBeenCalledTimes(1);
    expect(unbound.sink).toHaveBeenCalledTimes(1);
    expect(
      getJSRuntimeHostFunctionSpeculationAdapter(unbound.wrapped)
    ).toBeDefined();
  });
});

describe('call-time skill injection: the speculation interlock', () => {
  it('installs no speculation adapter for a bound callable', async () => {
    // `runLogicalCall` is not the only way in. Guarding the INSTALLATION site
    // means a bound callable has no second entry point at all.
    const runtime = createRuntime();
    const { agent: built, ai } = makeAgent(
      { distiller: [DISTILL], executor: [FINAL] },
      {
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
      },
      runtime
    );

    await built.forward(ai, { task: 'x' } as never);

    const inventory = runtime.globals().inventory as Record<string, unknown>;
    expect(typeof inventory?.adjustStock).toBe('function');
    expect(
      getJSRuntimeHostFunctionSpeculationAdapter(
        inventory.adjustStock as object
      )
    ).toBeUndefined();
    // The unbound external callable in the SAME run still gets one, so the
    // assertion above is about the binding and not about the fixture.
    expect(
      getJSRuntimeHostFunctionSpeculationAdapter(inventory.pick as object)
    ).toBeDefined();
  });

  it('a bound callable in a speculation-driving runtime still does not execute', async () => {
    // The behaviour-level form of the same guard: this runtime WOULD launch and
    // commit the physical call if an adapter existed, bypassing the logical
    // path where the interception lives.
    const runtime = createRuntime({ speculate: true });
    const {
      agent: built,
      ai,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'console.log(JSON.stringify(await inventory.adjustStock({sku:"a1"})))',
          'await inventory.pick({order:"42"})',
          FINAL,
        ],
      },
      {
        workingState: workingStateConfig(),
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
      },
      runtime
    );

    await built.forward(ai, { task: 'adjust' } as never);

    expect(adjustCalls).toHaveLength(0);
    // The POSITIVE CONTROL for the premise the negative rests on: the harness
    // really did launch and commit through the adapter for the unbound
    // callable in the same run. Without this the whole test passes when the
    // harness quietly stops speculating, which is exactly the state an earlier
    // version of it was in.
    expect(runtime.launched()).toContain(PICK);
    expect(runtime.launched()).not.toContain(ADJUST);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    expect(receipts.map((receipt) => receipt.qualifiedName)).toEqual([PICK]);
  });

  it('collapses a deterministic speculation replay into one receipt', async () => {
    // §7.7's other speculation fact: a `deterministic: true` allowlist entry
    // lets the runtime satisfy a repeated logical call from one physical
    // launch, so the recorder and the receipt sink fire TWICE for one
    // environment change. Under-counting evidence is the safe direction, so
    // the fingerprint dedupe collapses them rather than minting two receipts a
    // goal could be completed against.
    const runtime = createRuntime({ speculate: true, deterministic: [PICK] });
    const {
      agent: built,
      ai,
      pickCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.pick({order:"42"})', FINAL],
      },
      { workingState: workingStateConfig() },
      runtime
    );

    await built.forward(ai, { task: 'pick' } as never);

    expect(runtime.launched()).toContain(PICK);
    // One physical effect...
    expect(pickCalls).toHaveLength(1);
    const receipts = built.getState()?.workingState?.receipts ?? [];
    // ...reported as two logical calls, collapsed into one receipt. The
    // counter-metric is `observations`: the dedupe must not silently discard
    // the second observation, or a real repeat would be invisible too.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.qualifiedName).toBe(PICK);
    expect(receipts[0]?.observations).toBe(2);
  });
});

describe('call-time skill injection: delivery', () => {
  it('ingests the skill into the loaded-skills prompt region', async () => {
    const {
      agent: built,
      ai,
      executorPrompts,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      { callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }] }
    );

    await built.forward(ai, { task: 'adjust' } as never);

    // Delivered through the EXISTING loaded-skills channel — no parallel
    // prompt section — and visible on the re-draft turn, not the drafting one.
    expect(executorPrompts[0]).not.toContain(SKILL_BODY);
    expect(executorPrompts[1]).toContain(SKILL_BODY);
  });

  it('appends a trusted guidance entry naming the callable and the skill', async () => {
    const {
      agent: built,
      ai,
      executorPrompts,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      { callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }] }
    );

    await built.forward(ai, { task: 'adjust' } as never);

    const guidance = built.getState()?.guidanceLogEntries ?? [];
    const entry = guidance.find(
      (item) => item.triggeredBy === 'call-time skill'
    );
    expect(entry).toBeDefined();
    expect(entry?.guidance).toContain(ADJUST);
    expect(entry?.guidance).toContain('stock-adjustment');
    // The guidance log is the TRUSTED prompt region: it carries harness text
    // and host configuration only, never the model's own arguments.
    expect(entry?.guidance).not.toContain('a1');
    expect(executorPrompts[1]).toContain('call-time skill');
  });

  it('records action.executed false on the intercepted turn', async () => {
    const steps: AxWorkingStateTraceStep[] = [];
    const { agent: built, ai } = makeAgent(
      {
        distiller: [DISTILL],
        executor: [
          'await inventory.adjustStock({sku:"a1"})',
          'await inventory.pick({order:"42"})',
          FINAL,
        ],
      },
      {
        workingState: workingStateConfig({
          trace: true,
          onTrace: (step: AxWorkingStateTraceStep) => {
            steps.push(step);
          },
        }),
        callTimeSkills: [{ qualifiedName: ADJUST, skill: 'stock-adjustment' }],
      }
    );

    await built.forward(ai, { task: 'adjust' } as never);

    // Gamma tells the truth about what ran.
    expect(steps[0]?.action.executed).toBe(false);
    expect(steps[0]?.action.calls).toEqual([]);
    expect(steps[1]?.action.executed).toBe(true);
    expect(steps[1]?.action.calls).toEqual([PICK]);
  });
});

describe('call-time skill injection: the unconfigured default', () => {
  it('leaves every callable executing and speculating exactly as today', async () => {
    const runtime = createRuntime();
    const {
      agent: built,
      ai,
      adjustCalls,
    } = makeAgent(
      {
        distiller: [DISTILL],
        executor: ['await inventory.adjustStock({sku:"a1"})', FINAL],
      },
      {},
      runtime
    );

    await built.forward(ai, { task: 'adjust' } as never);

    expect(adjustCalls).toEqual([{ sku: 'a1' }]);
    const inventory = runtime.globals().inventory as Record<string, unknown>;
    expect(
      getJSRuntimeHostFunctionSpeculationAdapter(
        inventory.adjustStock as object
      )
    ).toBeDefined();
  });
});
