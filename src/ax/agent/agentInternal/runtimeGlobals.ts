import type {
  AxAgentCompletionProtocol,
  AxAIService,
  AxFunction,
  AxFunctionJSONSchema,
} from '../../ai/types.js';
import {
  axAuthorize,
  axFunctionAuthorityTarget,
  axSnapshotAuthority,
} from '../../authority/authority.js';
import type {
  AxAuthorityContext,
  AxAuthorityInheritance,
} from '../../authority/types.js';
import {
  type JSRuntimeHostFunctionSpeculationLaunch,
  setJSRuntimeHostFunctionSpeculationAdapter,
} from '../../funcs/jsRuntimeHostFunction.js';
import { mergeAbortSignals } from '../../util/abort.js';
import { AxAgentProtocolCompletionSignal } from '../completion.js';
import { serializeForEval } from '../optimize.js';
import { DISCOVERY_DISCOVER_NAME, MEMORIES_LOAD_NAME } from '../runtime.js';
import {
  type DiscoveryCallableMeta,
  normalizeAndSortDiscoveryFunctionIdentifiers,
  normalizeDiscoveryStringInput,
  renderDiscoveryFunctionDefinitionsMarkdown,
  renderDiscoveryModuleListMarkdown,
  resolveDiscoveryCallableNamespaces,
  sortDiscoveryModules,
} from '../runtimeDiscovery.js';
import { normalizeMemoriesInput } from './memoriesHelpers.js';
import type { AxAgentMemoryResult } from './memoriesTypes.js';
import type { AxAgentSkillResult } from './skillsTypes.js';
import type {
  AxAgentFunction,
  AxAgentFunctionCallRecorder,
  AxAgentFunctionModuleMeta,
  AxAgentOnFunctionCall,
} from './types.js';

type NormalizedDiscoverRequest = {
  tools: string[];
  skills: string[];
};

function normalizeOptionalStringInput(
  value: unknown,
  fieldName: string,
  functionName: string
): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(
        `[POLICY] ${functionName}(...) ${fieldName} entries must be non-empty strings.`
      );
    }
    return [trimmed];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `[POLICY] ${functionName}(...) ${fieldName} must be a string or string[].`
    );
  }
  if (value.length === 0) {
    throw new Error(
      `[POLICY] ${functionName}(...) ${fieldName} requires at least one entry.`
    );
  }
  const normalized = value.map((item) => {
    if (typeof item !== 'string') {
      throw new Error(
        `[POLICY] ${functionName}(...) ${fieldName} entries must be strings.`
      );
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(
        `[POLICY] ${functionName}(...) ${fieldName} entries must be non-empty strings.`
      );
    }
    return trimmed;
  });
  return [...new Set(normalized)];
}

function normalizeDiscoverInput(
  input: unknown,
  options: Readonly<{ toolsEnabled: boolean; skillsEnabled: boolean }>
): NormalizedDiscoverRequest {
  if (typeof input === 'string' || Array.isArray(input)) {
    if (!options.toolsEnabled) {
      throw new Error(
        '[POLICY] discover(string|string[]) requires function discovery to be enabled. Use discover({ skills: ... }) for skills.'
      );
    }
    return {
      tools: normalizeDiscoveryStringInput(input, 'items'),
      skills: [],
    };
  }

  if (!input || typeof input !== 'object') {
    throw new Error(
      '[POLICY] discover(...) expects a string, string[], or { tools?, skills? }.'
    );
  }

  const record = input as Record<string, unknown>;
  const hasTools = record.tools !== undefined;
  const hasSkills = record.skills !== undefined;
  if (!hasTools && !hasSkills) {
    throw new Error(
      '[POLICY] discover(...) requires at least one of tools or skills.'
    );
  }
  if (hasTools && !options.toolsEnabled) {
    throw new Error(
      '[POLICY] discover({ tools }) requires function discovery to be enabled.'
    );
  }
  if (hasSkills && !options.skillsEnabled) {
    throw new Error(
      '[POLICY] discover({ skills }) requires onSkillsSearch to be configured.'
    );
  }

  return {
    tools: hasTools
      ? normalizeOptionalStringInput(record.tools, 'tools', 'discover')
      : [],
    skills: hasSkills
      ? normalizeOptionalStringInput(record.skills, 'skills', 'discover')
      : [],
  };
}

export function wrapFunction(
  fn: AxFunction | AxAgentFunction,
  abortSignal?: AbortSignal,
  ai?: AxAIService,
  protocolForTrigger?: (triggeredBy?: string) => AxAgentCompletionProtocol,
  qualifiedName?: string,
  functionCallRecorder?: AxAgentFunctionCallRecorder,
  kind: 'internal' | 'external' = 'external',
  onFunctionCall?: AxAgentOnFunctionCall,
  eventContext?: import('../../event/types.js').AxEventContext,
  authority?: AxAuthorityContext,
  authorityInheritance?: AxAuthorityInheritance
): (...args: unknown[]) => Promise<unknown> {
  const normalizedQualifiedName = qualifiedName ?? fn.name;

  const normalizeCallArgs = (
    args: readonly unknown[]
  ): Record<string, unknown> => {
    let callArgs: Record<string, unknown>;

    if (
      args.length === 1 &&
      typeof args[0] === 'object' &&
      args[0] !== null &&
      !Array.isArray(args[0])
    ) {
      callArgs = args[0] as Record<string, unknown>;
    } else {
      const paramNames = fn.parameters?.properties
        ? Object.keys(fn.parameters.properties)
        : [];
      callArgs = {};
      paramNames.forEach((name, i) => {
        if (i < args.length) {
          callArgs[name] = args[i];
        }
      });
    }
    return callArgs;
  };

  const observeCall = async (callArgs: Record<string, unknown>) => {
    if (onFunctionCall) {
      try {
        await onFunctionCall({
          name: fn.name,
          qualifiedName: normalizedQualifiedName,
          args: callArgs,
          kind,
        });
      } catch {}
    }
  };

  const observeResult = async (
    callArgs: Record<string, unknown>,
    result: Promise<unknown>,
    serializedArguments?: Promise<unknown>
  ): Promise<unknown> => {
    const getSerializedArguments = async (): Promise<
      ReturnType<typeof serializeForEval>
    > => {
      if (!serializedArguments) return serializeForEval(callArgs);
      return structuredClone(await serializedArguments) as ReturnType<
        typeof serializeForEval
      >;
    };
    try {
      const value = await result;
      if (functionCallRecorder) {
        functionCallRecorder({
          qualifiedName: normalizedQualifiedName,
          name: fn.name,
          arguments: await getSerializedArguments(),
          result: serializeForEval(value),
        });
      }
      return value;
    } catch (err) {
      if (err instanceof AxAgentProtocolCompletionSignal) {
        if (functionCallRecorder) {
          functionCallRecorder({
            qualifiedName: normalizedQualifiedName,
            name: fn.name,
            arguments: await getSerializedArguments(),
          });
        }
        throw err;
      }
      if (functionCallRecorder) {
        functionCallRecorder({
          qualifiedName: normalizedQualifiedName,
          name: fn.name,
          arguments: await getSerializedArguments(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  };

  const authorizeCall = async (invocationSignal: AbortSignal | undefined) => {
    if (!authority) return undefined;
    const invocationAuthority = axSnapshotAuthority(authority);
    const target = axFunctionAuthorityTarget(
      fn as AxFunction,
      invocationAuthority,
      normalizedQualifiedName
    );
    const receipt = await axAuthorize(
      invocationAuthority,
      target.operation,
      target.resource,
      invocationSignal
    );
    return { authority: invocationAuthority, receipt: receipt!, target };
  };

  const launchFunction = (
    callArgs: Record<string, unknown>,
    invocationSignal: AbortSignal | undefined,
    includeCompletionProtocol: boolean,
    authorization: Awaited<ReturnType<typeof authorizeCall>>
  ): Promise<unknown> => {
    try {
      return Promise.resolve(
        fn.func(callArgs, {
          abortSignal: invocationSignal,
          ai,
          protocol: includeCompletionProtocol
            ? protocolForTrigger?.(normalizedQualifiedName)
            : undefined,
          eventContext,
          authority: authorization?.authority,
          authorityInheritance,
          authorityReceipt: authorization?.receipt,
        })
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const runLogicalCall = async (
    callArgs: Record<string, unknown>,
    invocationSignal: AbortSignal | undefined
  ): Promise<unknown> => {
    const authorization = await authorizeCall(invocationSignal);
    if (onFunctionCall) await observeCall(callArgs);
    return observeResult(
      callArgs,
      launchFunction(callArgs, invocationSignal, true, authorization)
    );
  };

  const wrapped = (...args: unknown[]): Promise<unknown> =>
    runLogicalCall(normalizeCallArgs(args), abortSignal);

  const cloneArguments = (args: readonly unknown[]): readonly unknown[] =>
    structuredClone(args) as readonly unknown[];

  const commitSpeculativeCall = async (
    args: readonly unknown[],
    speculative: JSRuntimeHostFunctionSpeculationLaunch
  ): Promise<unknown> => {
    if (speculative.authorizationDenied) return speculative.result;

    let observerArgs = args;
    try {
      if (speculative.argumentsBefore) {
        observerArgs = cloneArguments(speculative.argumentsBefore);
      }
    } catch {}

    if (onFunctionCall) await observeCall(normalizeCallArgs(observerArgs));
    return observeResult(
      normalizeCallArgs(args),
      speculative.result,
      speculative.serializedArgumentsAfter
    );
  };

  // Child agents are intentionally excluded: their nested tools and budgets
  // do not have a proven pure-call contract. External AxFunction/MCP/UCP
  // callables still require an exact AxJSRuntime speculation allowlist entry.
  if (kind === 'external') {
    setJSRuntimeHostFunctionSpeculationAdapter(wrapped, {
      launch: async (args, signal) => {
        const callArgs = normalizeCallArgs(args);
        const invocationSignal = mergeAbortSignals(abortSignal, signal);
        try {
          const authorization = await authorizeCall(invocationSignal);
          const argumentsBefore = cloneArguments([callArgs]);
          const result = launchFunction(
            callArgs,
            invocationSignal,
            false,
            authorization
          );
          const serializedArgumentsAfter = result.then(
            () => serializeForEval(callArgs),
            () => serializeForEval(callArgs)
          );
          void serializedArgumentsAfter.catch(() => {});
          return {
            result,
            argumentsBefore,
            serializedArgumentsAfter,
            signal: invocationSignal,
          };
        } catch (error) {
          const result = Promise.reject(error);
          void result.catch(() => {});
          return {
            result,
            authorizationDenied: true,
            signal: invocationSignal,
          };
        }
      },
      commit: (args, speculative) => commitSpeculativeCall(args, speculative),
    });
  }

  return wrapped;
}

/**
 * Wraps agent functions under namespaced globals and child agents under
 * a configurable `<module>.*` namespace for the runtime session.
 */
export function buildRuntimeGlobals(
  self: any,
  abortSignal?: AbortSignal,
  ai?: AxAIService,
  protocolForTrigger?: (triggeredBy?: string) => AxAgentCompletionProtocol,
  functionCallRecorder?: AxAgentFunctionCallRecorder,
  onDiscoveredNamespaces?: (namespaces: readonly string[]) => void,
  onDiscoveredModules?: (
    modules: readonly string[],
    docs: Readonly<Record<string, string>>
  ) => void,
  onDiscoveredFunctions?: (
    qualifiedNames: readonly string[],
    docs: Readonly<Record<string, string>>
  ) => void,
  onLoadedSkills?: (results: readonly AxAgentSkillResult[]) => void,
  onLoadedMemories?: (results: readonly AxAgentMemoryResult[]) => void,
  onUsed?: (id: unknown, reason?: unknown) => void,
  onFunctionCall?: AxAgentOnFunctionCall,
  /**
   * Returns the snapshot of memories already loaded for the current run.
   * Forwarded to `onMemoriesSearch` so the callback can skip re-fetching
   * entries the actor already has in scope.
   */
  getCurrentMemories?: () => readonly AxAgentMemoryResult[]
): Record<string, unknown> {
  const fireInternal = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<void> => {
    if (!onFunctionCall) return;
    try {
      await onFunctionCall({
        name,
        qualifiedName: name,
        args,
        kind: 'internal',
      });
    } catch {}
  };
  const s = self as any;
  const globals: Record<string, unknown> = {};
  const callableLookup = new Map<string, DiscoveryCallableMeta>();
  const moduleLookup = new Map<string, string[]>();
  const moduleMetaLookup = new Map<string, AxAgentFunctionModuleMeta>();
  for (const [namespace, meta] of s.agentFunctionModuleMetadata) {
    moduleMetaLookup.set(namespace, meta);
  }
  const registerCallable = (
    meta: DiscoveryCallableMeta,
    qualifiedName: string
  ) => {
    callableLookup.set(qualifiedName, meta);
    if (!moduleLookup.has(meta.module)) {
      moduleLookup.set(meta.module, []);
    }
    moduleLookup.get(meta.module)?.push(qualifiedName);
  };

  // Stages that don't execute tools (the distiller) see the full tool
  // surface (catalogs, discovery docs, schemas — the extraction guide) but
  // their callables are throwing stubs whose error text redirects the actor
  // to extract inputs and forward them via final(request, evidence).
  const executesTools = s.stagePolicy?.executesTools !== false;
  const buildStageToolStub =
    (qualifiedName: string) =>
    async (..._args: unknown[]): Promise<never> => {
      throw new Error(
        `[POLICY] ${qualifiedName}(...) executes in the executor stage — this context stage cannot run tools. ` +
          'Extract the exact inputs it will need (ids, paths, records) and forward them in final(request, evidence).'
      );
    };
  const eventContext = s._activeEventContext as
    | import('../../event/types.js').AxEventContext
    | undefined;
  const authority = s._activeAuthority
    ? axSnapshotAuthority(s._activeAuthority as AxAuthorityContext)
    : undefined;
  const authorityInheritance = s._activeAuthorityInheritance as
    | AxAuthorityInheritance
    | undefined;

  // Agent functions under namespace.* (e.g. utils.myFn, custom.otherFn).
  // Agent-derived entries carry `_kind: 'internal'` so that `onFunctionCall`
  // observers can still distinguish them from user-registered tools; everything
  // else lands under the same flow.
  for (const agentFn of s.agentFunctions) {
    const ns = agentFn.namespace ?? 'utils';
    if (!globals[ns] || typeof globals[ns] !== 'object') {
      globals[ns] = {};
    }
    const qualifiedName = `${ns}.${agentFn.name}`;
    (globals[ns] as Record<string, unknown>)[agentFn.name] = executesTools
      ? wrapFunction(
          agentFn,
          abortSignal,
          ai,
          protocolForTrigger,
          qualifiedName,
          functionCallRecorder,
          agentFn._kind ?? 'external',
          onFunctionCall,
          eventContext,
          authority,
          authorityInheritance
        )
      : buildStageToolStub(qualifiedName);
    if (agentFn._alwaysInclude !== true) {
      registerCallable(
        {
          module: ns,
          name: agentFn.name,
          description: agentFn.description,
          parameters: agentFn.parameters,
          returns: agentFn.returns,
          examples: agentFn.examples,
        },
        qualifiedName
      );
    }
  }

  const mcpExecutionContext = s._activeMCPExecutionContext as
    | import('../../mcp/execution.js').AxMCPExecutionContext
    | undefined;
  if (mcpExecutionContext) {
    const mcpRoot: Record<string, unknown> = {};
    globals.mcp = mcpRoot;
    for (const client of mcpExecutionContext.clients) {
      const namespace = client.getNamespace();
      const tools: Record<string, unknown> = {};
      for (const binding of mcpExecutionContext
        .getToolBindings()
        .filter((candidate) => candidate.namespace === namespace)) {
        const qualifiedName = `mcp.${namespace}.tools.${binding.name}`;
        tools[binding.name] = executesTools
          ? wrapFunction(
              binding,
              abortSignal,
              ai,
              protocolForTrigger,
              qualifiedName,
              functionCallRecorder,
              'external',
              onFunctionCall,
              eventContext,
              authority,
              authorityInheritance
            )
          : buildStageToolStub(qualifiedName);
        registerCallable(
          {
            module: `mcp.${namespace}`,
            name: binding.name,
            description: binding.description,
            parameters: binding.parameters,
            returns: binding.returns,
          },
          qualifiedName
        );
      }
      const executeOrStub = <T extends (...args: any[]) => Promise<unknown>>(
        qualifiedName: string,
        fn: T
      ): T | ReturnType<typeof buildStageToolStub> =>
        executesTools ? fn : buildStageToolStub(qualifiedName);
      const call = <T>(
        qualifiedName: string,
        operation: string,
        type: string,
        id: string,
        fn: () => T
      ): T | Promise<T> => {
        if (!authority) return fn();
        if (!executesTools) return buildStageToolStub(qualifiedName)() as never;
        return axAuthorize(
          authority,
          operation,
          {
            type,
            id,
            ...(authority.principal.tenantId
              ? { tenantId: authority.principal.tenantId }
              : {}),
          },
          abortSignal
        ).then(fn);
      };
      mcpRoot[namespace] = {
        tools,
        prompts: {
          list: () =>
            call(
              `mcp.${namespace}.prompts.list`,
              'mcp.prompt.list',
              'mcp.prompt.catalog',
              namespace,
              () => client.getPrompts()
            ),
          get: executeOrStub(
            `mcp.${namespace}.prompts.get`,
            (name: string, args?: Record<string, string>) =>
              call(
                `mcp.${namespace}.prompts.get`,
                'mcp.prompt.get',
                'mcp.prompt',
                `${namespace}:${name}`,
                () => client.getPrompt(name, args)
              )
          ),
        },
        resources: {
          list: () =>
            call(
              `mcp.${namespace}.resources.list`,
              'mcp.resource.list',
              'mcp.resource.catalog',
              namespace,
              () => client.getResources()
            ),
          templates: () =>
            call(
              `mcp.${namespace}.resources.templates`,
              'mcp.resource.templates',
              'mcp.resource.catalog',
              namespace,
              () => client.getResourceTemplates()
            ),
          read: executeOrStub(
            `mcp.${namespace}.resources.read`,
            (uri: string) =>
              call(
                `mcp.${namespace}.resources.read`,
                'mcp.resource.read',
                'mcp.resource',
                `${namespace}:${uri}`,
                () => client.readResource(uri)
              )
          ),
          subscribe: executeOrStub(
            `mcp.${namespace}.resources.subscribe`,
            (uri: string) =>
              call(
                `mcp.${namespace}.resources.subscribe`,
                'mcp.resource.subscribe',
                'mcp.resource',
                `${namespace}:${uri}`,
                () => client.subscribeResource(uri)
              )
          ),
          unsubscribe: executeOrStub(
            `mcp.${namespace}.resources.unsubscribe`,
            (uri: string) =>
              call(
                `mcp.${namespace}.resources.unsubscribe`,
                'mcp.resource.unsubscribe',
                'mcp.resource',
                `${namespace}:${uri}`,
                () => client.unsubscribeResource(uri)
              )
          ),
        },
        tasks: {
          list: executeOrStub(
            `mcp.${namespace}.tasks.list`,
            (cursor?: string) =>
              call(
                `mcp.${namespace}.tasks.list`,
                'mcp.task.list',
                'mcp.task.catalog',
                namespace,
                () => client.listTasks(cursor)
              )
          ),
          get: executeOrStub(`mcp.${namespace}.tasks.get`, (taskId: string) =>
            call(
              `mcp.${namespace}.tasks.get`,
              'mcp.task.get',
              'mcp.task',
              `${namespace}:${taskId}`,
              () => client.getTask(taskId)
            )
          ),
          result: executeOrStub(
            `mcp.${namespace}.tasks.result`,
            (taskId: string) =>
              call(
                `mcp.${namespace}.tasks.result`,
                'mcp.task.result',
                'mcp.task',
                `${namespace}:${taskId}`,
                () => client.getTaskResult(taskId)
              )
          ),
          cancel: executeOrStub(
            `mcp.${namespace}.tasks.cancel`,
            (taskId: string) =>
              call(
                `mcp.${namespace}.tasks.cancel`,
                'mcp.task.cancel',
                'mcp.task',
                `${namespace}:${taskId}`,
                () => client.cancelTask(taskId)
              )
          ),
        },
        complete: executeOrStub(
          `mcp.${namespace}.complete`,
          (...args: Parameters<typeof client.complete>) => {
            const ref = args[0];
            const id = `${namespace}:${ref.type}:${ref.type === 'ref/prompt' ? ref.name : ref.uri}`;
            return call(
              `mcp.${namespace}.complete`,
              'mcp.completion.complete',
              'mcp.completion',
              id,
              () => client.complete(...args)
            );
          }
        ),
      };
    }

    const ucpRoot: Record<string, unknown> = {};
    globals.ucp = ucpRoot;
    for (const client of mcpExecutionContext.ucpClients) {
      const namespace = client.getNamespace();
      const operations: Record<string, unknown> = {};
      for (const binding of client.getOperationBindings()) {
        const qualifiedName = `ucp.${namespace}.${binding.name}`;
        operations[binding.name] = executesTools
          ? wrapFunction(
              binding,
              abortSignal,
              ai,
              protocolForTrigger,
              qualifiedName,
              functionCallRecorder,
              'external',
              onFunctionCall,
              eventContext,
              authority,
              authorityInheritance
            )
          : buildStageToolStub(qualifiedName);
        registerCallable(
          {
            module: `ucp.${namespace}`,
            name: binding.name,
            description: binding.description,
            parameters: binding.parameters,
            returns: binding.returns,
          },
          qualifiedName
        );
      }
      ucpRoot[namespace] = {
        ...operations,
        profile: () => {
          if (!authority) return client.getProfile();
          if (!executesTools) {
            return buildStageToolStub(`ucp.${namespace}.profile`)();
          }
          return axAuthorize(
            authority,
            'ucp.profile.read',
            {
              type: 'ucp.catalog',
              id: namespace,
              ...(authority.principal.tenantId
                ? { tenantId: authority.principal.tenantId }
                : {}),
            },
            abortSignal
          ).then(() => client.getProfile());
        },
        operations: () => {
          if (!authority) return client.getOperationNames();
          if (!executesTools) {
            return buildStageToolStub(`ucp.${namespace}.operations`)();
          }
          return axAuthorize(
            authority,
            'ucp.operation.list',
            {
              type: 'ucp.catalog',
              id: namespace,
              ...(authority.principal.tenantId
                ? { tenantId: authority.principal.tenantId }
                : {}),
            },
            abortSignal
          ).then(() => client.getOperationNames());
        },
      };
    }
  }

  if (s.functionDiscoveryEnabled || typeof s.onSkillsSearch === 'function') {
    globals[DISCOVERY_DISCOVER_NAME] = async (
      input: unknown
    ): Promise<void> => {
      await fireInternal(DISCOVERY_DISCOVER_NAME, { request: input });
      const { tools, skills } = normalizeDiscoverInput(input, {
        toolsEnabled: Boolean(s.functionDiscoveryEnabled),
        skillsEnabled: typeof s.onSkillsSearch === 'function',
      });

      if (tools.length > 0) {
        const modules = sortDiscoveryModules(
          tools.filter((item) => {
            const meta = moduleMetaLookup.get(item);
            return moduleLookup.has(item) || meta?.alwaysInclude === true;
          })
        );
        const functionItems = tools.filter((item) => !modules.includes(item));

        if (modules.length > 0) {
          const docs = Object.fromEntries(
            modules.map((module) => [
              module,
              renderDiscoveryModuleListMarkdown(
                [module],
                moduleLookup,
                moduleMetaLookup
              ),
            ])
          );
          onDiscoveredModules?.(modules, docs);
        }

        if (functionItems.length > 0) {
          const items =
            normalizeAndSortDiscoveryFunctionIdentifiers(functionItems);
          const matchedNamespaces = resolveDiscoveryCallableNamespaces(
            items,
            callableLookup
          );
          if (matchedNamespaces.length > 0) {
            onDiscoveredNamespaces?.(matchedNamespaces);
          }
          const docs = Object.fromEntries(
            items.map((qualifiedName) => [
              qualifiedName,
              renderDiscoveryFunctionDefinitionsMarkdown(
                [qualifiedName],
                callableLookup
              ),
            ])
          );
          onDiscoveredFunctions?.(items, docs);
        }
      }

      if (skills.length > 0) {
        const results = await s.onSkillsSearch(skills);
        if (!Array.isArray(results) || results.length === 0) return;
        const matched = results as readonly AxAgentSkillResult[];
        onLoadedSkills?.(matched);
      }
    };
  }

  if (typeof s.onMemoriesSearch === 'function') {
    globals[MEMORIES_LOAD_NAME] = async (input: unknown): Promise<void> => {
      await fireInternal(MEMORIES_LOAD_NAME, { searches: input });
      const searches = normalizeMemoriesInput(input);
      if (searches.length === 0) return;
      const alreadyLoaded = getCurrentMemories?.() ?? [];
      const results = await s.onMemoriesSearch(searches, alreadyLoaded);
      if (!Array.isArray(results) || results.length === 0) return;
      const matched = results as readonly AxAgentMemoryResult[];
      onLoadedMemories?.(matched);
    };
  }

  if (s.usageTrackingEnabled === true) {
    globals.used = async (id: unknown, reason?: unknown): Promise<void> => {
      await fireInternal('used', { id, reason });
      onUsed?.(id, reason);
    };
  }

  return globals;
}

export function buildFuncParameters(self: any): AxFunctionJSONSchema {
  const s = self as any;
  return s.program.getSignature().toInputJSONSchema();
}
