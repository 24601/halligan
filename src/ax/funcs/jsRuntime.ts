import type { AxCodeRuntime, AxCodeSession } from '../agent/rlm.js';
import {
  type AxRuntimeAuthority,
  type AxRuntimeCapabilities,
  type AxRuntimePlatformAuthority,
  axCodeRuntimeProtocol,
  axCodeRuntimeProtocolVersion,
  axCreateRuntimeCapabilities,
  axRuntimeCapabilitiesVersion,
} from '../agent/runtimeCapabilities.js';
import type { AxFunction } from '../ai/types.js';
import {
  type AxJSRuntimeNodePermissionAllowlist,
  AxJSRuntimePermission,
  type AxJSRuntimeResourceLimits,
  computeNodePermissionExecArgv,
  computeSecurityPostureHash,
} from './jsRuntimeSecurity.js';
import {
  deserializeError,
  findReservedRuntimeNameViolation,
  normalizeCodeSessionSnapshot,
  type SerializedError,
  serializeError,
  splitGlobalsForWorker,
  validateSerializableGlobals,
} from './jsRuntimeSession.js';
import {
  type AxJSRuntimeSpeculationOptions,
  JSRuntimeSpeculationTurn,
  type NormalizedAxJSRuntimeSpeculationOptions,
  normalizeJSRuntimeSpeculationOptions,
} from './jsRuntimeSpeculation.js';
import {
  canUseWebWorker,
  createBrowserWorker,
  createNodeWorker,
  getNodeWorkerPool,
  isNodePoolDebugEnabled,
  isNodeRuntime,
  type RLMMessageEvent,
  type RLMWorker,
  resolveNodeWorkerPoolSize,
} from './jsRuntimeWorkers.js';
import { getWorkerSource } from './worker.js';

export { AxJSRuntimePermission };
export type { AxJSRuntimeNodePermissionAllowlist, AxJSRuntimeResourceLimits };
export type {
  AxJSRuntimeSpeculationEvent,
  AxJSRuntimeSpeculationEventKind,
  AxJSRuntimeSpeculationEventReason,
  AxJSRuntimeSpeculationOptions,
  AxJSRuntimeSpeculationPolicy,
} from './jsRuntimeSpeculation.js';

export type AxJSRuntimeOutputMode = 'return' | 'stdout';

const immutableRuntimeFieldNames = [
  'language',
  'capabilities',
  'createSession',
  'getUsageInstructions',
  'timeout',
  'permissions',
  'allowUnsafeNodeHostAccess',
  'nodeWorkerPoolSize',
  'debugNodeWorkerPool',
  'outputMode',
  'captureConsole',
  'blockDynamicImport',
  'allowedModules',
  'freezeIntrinsics',
  'blockShadowRealm',
  'lockWorkerIPC',
  'preventGlobalThisExtensions',
  'useNodePermissionModel',
  'nodePermissionAllowlist',
  'resourceLimits',
  'allowDenoRemoteImport',
  'speculation',
] as const;

/**
 * Browser-compatible JavaScript interpreter for RLM using Web Workers.
 * Creates persistent sessions where variables survive across `execute()` calls.
 */
export class AxJSRuntime implements AxCodeRuntime {
  readonly language = 'JavaScript';
  readonly capabilities: AxRuntimeCapabilities;
  private readonly timeout: number;
  private readonly permissions: readonly AxJSRuntimePermission[];
  private readonly allowUnsafeNodeHostAccess: boolean;
  private readonly nodeWorkerPoolSize: number;
  private readonly debugNodeWorkerPool: boolean;
  private readonly outputMode: AxJSRuntimeOutputMode;
  private readonly captureConsole: boolean;
  private readonly blockDynamicImport: boolean;
  private readonly allowedModules: readonly string[];
  private readonly freezeIntrinsics: boolean;
  private readonly blockShadowRealm: boolean;
  private readonly lockWorkerIPC: boolean;
  private readonly preventGlobalThisExtensions: boolean;
  private readonly useNodePermissionModel: boolean | 'auto';
  private readonly nodePermissionAllowlist?: AxJSRuntimeNodePermissionAllowlist;
  private readonly resourceLimits?: AxJSRuntimeResourceLimits;
  private readonly allowDenoRemoteImport: boolean;
  private readonly speculation?: NormalizedAxJSRuntimeSpeculationOptions;

  constructor(
    options?: Readonly<{
      timeout?: number;
      permissions?: readonly AxJSRuntimePermission[];
      outputMode?: AxJSRuntimeOutputMode;
      captureConsole?: boolean;
      /**
       * Warning: enables direct access to Node host globals (e.g. process/require)
       * from model-generated code in Node worker runtime.
       *
       * Defaults to false for safer behavior.
       */
      allowUnsafeNodeHostAccess?: boolean;
      /**
       * Node-only: prewarm pool size for worker_threads.
       * Defaults to an adaptive value based on availableParallelism() when available.
       */
      nodeWorkerPoolSize?: number;
      /**
       * Node-only: prints resolved worker pool size to console.debug.
       * Can also be enabled via AX_RLM_DEBUG_NODE_POOL=1.
       */
      debugNodeWorkerPool?: boolean;
      /**
       * Block dynamic `import()` at execute time (language-level block on Node
       * via `node:vm` rejector; Deno relies on permission model).
       *
       * Default: true.
       */
      blockDynamicImport?: boolean;
      /**
       * Module specifier allowlist when `blockDynamicImport` is true. This is
       * a narrow dynamic-import gate: allowlisted specifiers are attempted, but
       * full Node module namespace passthrough depends on Node vm semantics.
       * Default: [].
       */
      allowedModules?: readonly string[];
      /**
       * Freeze Object.prototype / Array.prototype / Function.prototype and
       * other intrinsics to prevent prototype pollution.
       *
       * Default: true.
       */
      freezeIntrinsics?: boolean;
      /**
       * Lock `globalThis.ShadowRealm` to undefined. Default: true.
       */
      blockShadowRealm?: boolean;
      /**
       * Lock `self.postMessage` / `self.onmessage` in browser/Deno workers
       * to prevent host-function privilege escalation. Default: true.
       */
      lockWorkerIPC?: boolean;
      /**
       * Call `Object.preventExtensions(globalThis)` in the worker. Breaks
       * top-level `var/let/const` persistence — opt-in only. Default: false.
       */
      preventGlobalThisExtensions?: boolean;
      /**
       * Node-only: engage the Node Permission Model at worker spawn for
       * kernel-enforced defense-in-depth on top of the language-level
       * lockdown. Emits `--permission` on Node ≥ 23.5 (stable flag) or
       * `--experimental-permission` on Node 20–23.4 (same runtime
       * enforcement, pre-stabilization flag name).
       *
       * - 'auto' (default): engage unconditionally on any supported Node.
       *   With no FILESYSTEM/CHILD_PROCESS permission granted, fs and
       *   child_process are blocked at the OS level. Silently skips on
       *   Node < 20, Deno, and browsers (language-level defenses still
       *   apply).
       * - true: engage unconditionally; hard-fail on Node < 20.
       * - false: never engage.
       */
      useNodePermissionModel?: boolean | 'auto';
      /**
       * Fine-grained Node Permission Model allowlist (e.g. fs-read paths).
       */
      nodePermissionAllowlist?: AxJSRuntimeNodePermissionAllowlist;
      /**
       * Node-only: V8 engine-area limits passed to `worker_threads.Worker`.
       * These are not a total Worker memory/RSS bound and are intentionally
       * not published as `capabilities.resources.memoryMb`.
       */
      resourceLimits?: AxJSRuntimeResourceLimits;
      /**
       * Deno-only: allow remote module imports (`await import('https://...')`).
       * Default: false — sets `import: false` in the Deno permission set when
       * NETWORK is granted, so data-plane fetch works but remote module
       * loading is blocked at the runtime level.
       */
      allowDenoRemoteImport?: boolean;
      /**
       * Opt-in speculative programmatic tool calling for exact runtime paths.
       * Only explicitly pure callables are eligible; unsupported code falls
       * back to ordinary worker execution.
       */
      speculation?: AxJSRuntimeSpeculationOptions;
    }>
  ) {
    Object.defineProperties(this, {
      createSession: {
        value: axJSRuntimeCreateSession.bind(this),
        enumerable: true,
        writable: false,
        configurable: false,
      },
      getUsageInstructions: {
        value: axJSRuntimeGetUsageInstructions.bind(this),
        enumerable: true,
        writable: false,
        configurable: false,
      },
    });
    this.timeout = options?.timeout ?? 900_000;
    this.permissions = Object.freeze([...(options?.permissions ?? [])]);
    this.allowUnsafeNodeHostAccess =
      options?.allowUnsafeNodeHostAccess ?? false;
    this.outputMode = options?.outputMode ?? 'stdout';
    this.captureConsole =
      options?.captureConsole ?? this.outputMode === 'stdout';
    this.nodeWorkerPoolSize = resolveNodeWorkerPoolSize(
      options?.nodeWorkerPoolSize
    );
    this.debugNodeWorkerPool = isNodePoolDebugEnabled(options);
    this.blockDynamicImport = options?.blockDynamicImport ?? true;
    this.allowedModules = Object.freeze([...(options?.allowedModules ?? [])]);
    this.freezeIntrinsics = options?.freezeIntrinsics ?? true;
    this.blockShadowRealm = options?.blockShadowRealm ?? true;
    this.lockWorkerIPC = options?.lockWorkerIPC ?? true;
    this.preventGlobalThisExtensions =
      options?.preventGlobalThisExtensions ?? false;
    this.useNodePermissionModel = options?.useNodePermissionModel ?? 'auto';
    const nodePermissionAllowlist = options?.nodePermissionAllowlist;
    const fsRead = nodePermissionAllowlist?.fsRead;
    const fsWrite = nodePermissionAllowlist?.fsWrite;
    const childProcess = nodePermissionAllowlist?.childProcess;
    const addons = nodePermissionAllowlist?.addons;
    const wasi = nodePermissionAllowlist?.wasi;
    this.nodePermissionAllowlist = nodePermissionAllowlist
      ? Object.freeze({
          ...(fsRead === undefined
            ? {}
            : { fsRead: Object.freeze([...fsRead]) }),
          ...(fsWrite === undefined
            ? {}
            : { fsWrite: Object.freeze([...fsWrite]) }),
          ...(childProcess === undefined ? {} : { childProcess }),
          ...(addons === undefined ? {} : { addons }),
          ...(wasi === undefined ? {} : { wasi }),
        })
      : undefined;
    const resourceLimits = options?.resourceLimits;
    const maxOldGenerationSizeMb = resourceLimits?.maxOldGenerationSizeMb;
    const maxYoungGenerationSizeMb = resourceLimits?.maxYoungGenerationSizeMb;
    const codeRangeSizeMb = resourceLimits?.codeRangeSizeMb;
    const stackSizeMb = resourceLimits?.stackSizeMb;
    this.resourceLimits = resourceLimits
      ? Object.freeze({
          ...(maxOldGenerationSizeMb === undefined
            ? {}
            : { maxOldGenerationSizeMb }),
          ...(maxYoungGenerationSizeMb === undefined
            ? {}
            : { maxYoungGenerationSizeMb }),
          ...(codeRangeSizeMb === undefined ? {} : { codeRangeSizeMb }),
          ...(stackSizeMb === undefined ? {} : { stackSizeMb }),
        })
      : undefined;
    this.allowDenoRemoteImport = options?.allowDenoRemoteImport ?? false;
    this.speculation = normalizeJSRuntimeSpeculationOptions(
      options?.speculation
    );
    const granted = new Set(this.permissions);
    const permissionAuthority = (permission: AxJSRuntimePermission) =>
      granted.has(permission) ? 'unrestricted' : 'denied';
    const workersUnrestricted = granted.has(AxJSRuntimePermission.WORKERS);
    const filesystemAuthority: AxRuntimeAuthority =
      this.allowUnsafeNodeHostAccess ||
      granted.has(AxJSRuntimePermission.FILESYSTEM)
        ? 'unrestricted'
        : (this.nodePermissionAllowlist?.fsRead?.length ?? 0) > 0 ||
            (this.nodePermissionAllowlist?.fsWrite?.length ?? 0) > 0
          ? 'allowlist'
          : 'denied';
    const platformAuthority: AxRuntimePlatformAuthority = {
      filesystem: filesystemAuthority,
      childProcess:
        this.allowUnsafeNodeHostAccess ||
        granted.has(AxJSRuntimePermission.CHILD_PROCESS) ||
        this.nodePermissionAllowlist?.childProcess
          ? 'unrestricted'
          : 'denied',
      storage:
        this.allowUnsafeNodeHostAccess || workersUnrestricted
          ? 'unrestricted'
          : permissionAuthority(AxJSRuntimePermission.STORAGE),
      communication:
        this.allowUnsafeNodeHostAccess || workersUnrestricted
          ? 'unrestricted'
          : permissionAuthority(AxJSRuntimePermission.COMMUNICATION),
      timing:
        this.allowUnsafeNodeHostAccess || workersUnrestricted
          ? 'unrestricted'
          : permissionAuthority(AxJSRuntimePermission.TIMING),
      workers:
        this.allowUnsafeNodeHostAccess || workersUnrestricted
          ? 'unrestricted'
          : 'denied',
      codeLoading:
        this.allowUnsafeNodeHostAccess ||
        workersUnrestricted ||
        granted.has(AxJSRuntimePermission.CODE_LOADING) ||
        !this.blockDynamicImport ||
        (this.allowDenoRemoteImport &&
          granted.has(AxJSRuntimePermission.NETWORK))
          ? 'unrestricted'
          : this.allowedModules.length > 0
            ? 'allowlist'
            : 'denied',
      nativeAddons:
        this.allowUnsafeNodeHostAccess || this.nodePermissionAllowlist?.addons
          ? 'unrestricted'
          : 'denied',
      wasi:
        this.allowUnsafeNodeHostAccess || this.nodePermissionAllowlist?.wasi
          ? 'unrestricted'
          : 'denied',
    };
    const maxAuthority = (
      values: readonly AxRuntimeAuthority[]
    ): AxRuntimeAuthority => {
      if (values.includes('unknown')) return 'unknown';
      if (values.includes('unrestricted')) return 'unrestricted';
      if (values.includes('allowlist')) return 'allowlist';
      return 'denied';
    };
    const modules = maxAuthority([
      this.allowUnsafeNodeHostAccess ? 'unrestricted' : 'denied',
      platformAuthority.workers,
      platformAuthority.codeLoading,
      platformAuthority.nativeAddons,
      platformAuthority.wasi,
    ]);
    const network = maxAuthority([
      this.allowUnsafeNodeHostAccess ? 'unrestricted' : 'denied',
      platformAuthority.workers,
      platformAuthority.codeLoading,
      permissionAuthority(AxJSRuntimePermission.NETWORK),
    ]);
    const host = maxAuthority([
      this.allowUnsafeNodeHostAccess ? 'unrestricted' : 'denied',
      modules,
      network,
      ...Object.values(platformAuthority),
    ]);
    const platform = (globalThis as { Deno?: { version?: { deno?: string } } })
      .Deno?.version?.deno
      ? 'deno'
      : isNodeRuntime()
        ? 'node'
        : canUseWebWorker()
          ? 'browser'
          : 'unknown';
    this.capabilities = axCreateRuntimeCapabilities({
      schemaVersion: axRuntimeCapabilitiesVersion,
      inspect: true,
      snapshot: true,
      patch: true,
      abort: true,
      language: this.language,
      usageInstructions: this.getUsageInstructions(),
      platform,
      protocol: {
        name: axCodeRuntimeProtocol,
        version: axCodeRuntimeProtocolVersion,
        features: [],
      },
      persistence: { session: true, restart: false },
      resources: {
        // Worker resourceLimits cover selected V8 areas only; external data,
        // ArrayBuffers, native allocations, and total RSS remain unbounded.
        timeoutMs: this.timeout,
        timeoutEnforcement: 'hard',
      },
      authority: {
        host,
        modules,
        network,
        platform: platformAuthority,
      },
    });
    for (const key of immutableRuntimeFieldNames) {
      const descriptor = Object.getOwnPropertyDescriptor(this, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`AxJSRuntime.${key} must be an own data property`);
      }
      Object.defineProperty(this, key, {
        ...descriptor,
        writable: false,
        configurable: false,
      });
    }
  }

  public getUsageInstructions(): string {
    const outputLines =
      this.outputMode === 'stdout'
        ? [
            'Use `console.log(...)` output is captured as the execution result so use it to inspect intermediate values between steps instead of `return`.',
          ]
        : [
            'Use `return` or a trailing expression to produce the execution result.',
          ];

    return [
      "Don't wrap async code in (async()=>{ ... })() — the runtime automatically handles async execution.",
      'State is session-scoped: all top-level declarations (`var`, `let`, `const`) persist across calls.',
      'Bare assignment (e.g. `x = 1`) also persists via `globalThis`.',
      ...outputLines,
    ]
      .map((v) => `- ${v}`)
      .join('\n');
  }

  /**
   * Creates a persistent execution session.
   *
   * Message flow:
   * 1) Main thread sends `init` with globals, function proxies, permissions.
   * 2) Main thread sends `execute` with correlation ID and code.
   * 3) Worker returns `result` or requests host callbacks via `fn-call`.
   * 4) Host responds to callback requests with `fn-result`.
   *
   * Session closes on:
   * - explicit close(),
   * - timeout,
   * - abort signal,
   * - worker error.
   */
  createSession(
    globals?: Record<string, unknown>,
    options?: { shouldBubbleError?: (err: unknown) => boolean }
  ): AxCodeSession {
    const source = getWorkerSource();
    // Computed up front so any Node-version/permission-model misconfigurations
    // throw at session creation, not on first execute.
    const nodeExecArgv = isNodeRuntime()
      ? computeNodePermissionExecArgv({
          mode: this.useNodePermissionModel,
          permissions: this.permissions,
          nodePermissionAllowlist: this.nodePermissionAllowlist,
        })
      : undefined;
    const securityPostureHash = computeSecurityPostureHash({
      permissions: this.permissions,
      allowUnsafeNodeHostAccess: this.allowUnsafeNodeHostAccess,
      blockDynamicImport: this.blockDynamicImport,
      allowedModules: this.allowedModules,
      freezeIntrinsics: this.freezeIntrinsics,
      blockShadowRealm: this.blockShadowRealm,
      lockWorkerIPC: this.lockWorkerIPC,
      preventGlobalThisExtensions: this.preventGlobalThisExtensions,
    });
    const nodeWorkerPool = isNodeRuntime()
      ? getNodeWorkerPool(
          source,
          this.nodeWorkerPoolSize,
          securityPostureHash,
          nodeExecArgv,
          this.resourceLimits
        )
      : null;
    if (nodeWorkerPool && this.debugNodeWorkerPool) {
      console.debug(
        `[AxJSRuntime] Node worker pool size: ${this.nodeWorkerPoolSize}`
      );
    }
    nodeWorkerPool?.warm();

    let worker: RLMWorker | null = null;
    let workerRuntime: 'browser' | 'node' | null = null;
    let workerReady: Promise<void> | null = null;
    let isClosed = false;

    const timeout = this.timeout;
    const speculationOptions = this.speculation;
    let nextFnRefId = 0;
    const shouldBubbleError = options?.shouldBubbleError;
    let bubbleError: unknown = null;

    // Convert nested function values into worker-callable references.
    const { serializableGlobals, fnMap, fnPathToRef } = splitGlobalsForWorker(
      globals,
      {
        nextFnId: () => ++nextFnRefId,
      }
    );
    const refToFnPath = new Map<string, string>();
    for (const [path, ref] of fnPathToRef) {
      refToFnPath.set(ref, path);
    }
    validateSerializableGlobals(serializableGlobals);
    let activeSpeculationTurn: JSRuntimeSpeculationTurn | null = null;

    // Pending worker requests keyed by correlation ID.
    const pendingRequests = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const inFlightHostCalls = new Set<Promise<unknown>>();
    let nextId = 0;
    type QueuedSessionOperation = {
      started: boolean;
      settled: boolean;
      signal?: AbortSignal;
      onAbort?: () => void;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      operation: () => Promise<unknown>;
    };
    const queuedOperations: QueuedSessionOperation[] = [];
    let activeQueuedOperation: Promise<void> | null = null;

    /** Dispatches worker messages for execution and host-function bridging. */
    const handleWorkerMessage = (e: RLMMessageEvent) => {
      const msg = e.data;

      if (
        !msg ||
        typeof msg !== 'object' ||
        !('type' in msg) ||
        (msg as { type?: unknown }).type === undefined
      ) {
        return;
      }

      const typedMsg = msg as {
        type: string;
        id?: number;
        name?: string;
        args?: unknown[];
        value?: unknown;
        error?: string | SerializedError;
      };

      if (typedMsg.type === 'result') {
        if (typeof typedMsg.id !== 'number') {
          return;
        }

        const pending = pendingRequests.get(typedMsg.id);
        if (pending) {
          pendingRequests.delete(typedMsg.id);
          if (typedMsg.error !== undefined) {
            if (bubbleError) {
              const original = bubbleError as Error;
              bubbleError = null;
              pending.reject(original);
            } else {
              pending.reject(deserializeError(typedMsg.error));
            }
          } else {
            pending.resolve(typedMsg.value);
          }
        }
        return;
      }

      if (typedMsg.type === 'fn-call') {
        if (
          typeof typedMsg.id !== 'number' ||
          typeof typedMsg.name !== 'string'
        ) {
          return;
        }

        const fn = fnMap.get(typedMsg.name);
        if (!fn) {
          worker?.postMessage({
            type: 'fn-result',
            id: typedMsg.id,
            error: `Function "${typedMsg.name}" not found`,
          });
          return;
        }
        const hostCall = Promise.resolve()
          .then(async () => {
            const args = typedMsg.args ?? [];
            if (activeSpeculationTurn) {
              const claim = await activeSpeculationTurn.claim(
                typedMsg.name!,
                args
              );
              if (claim.hit) return claim.value;
            }
            return fn(...args);
          })
          .then((value) => {
            try {
              worker?.postMessage({
                type: 'fn-result',
                id: typedMsg.id,
                value,
              });
            } catch {
              // Non-cloneable value (e.g. contains a Promise); fall back to string.
              worker?.postMessage({
                type: 'fn-result',
                id: typedMsg.id,
                value: String(value),
              });
            }
          })
          .catch((err: Error) => {
            if (shouldBubbleError?.(err)) {
              bubbleError = err;
            }
            worker?.postMessage({
              type: 'fn-result',
              id: typedMsg.id,
              error: serializeError(err) as SerializedError,
            });
          })
          .finally(() => {
            inFlightHostCalls.delete(hostCall);
          });
        inFlightHostCalls.add(hostCall);
      }
    };

    /** Terminates the current worker, allowing a new one to be created on next execute(). */
    const resetWorker = () => {
      if (worker) {
        if (workerRuntime === 'node' && nodeWorkerPool) {
          nodeWorkerPool.release(worker);
        } else {
          worker.terminate();
        }
        worker = null;
        workerRuntime = null;
      }
      workerReady = null;
    };

    /** Permanently closes the session and rejects all pending executions. */
    const cleanup = () => {
      isClosed = true;
      activeSpeculationTurn?.finish('execution-aborted');
      activeSpeculationTurn = null;
      resetWorker();
      for (const operation of queuedOperations) {
        if (!operation.started && !operation.settled) {
          operation.settled = true;
          if (operation.signal && operation.onAbort) {
            operation.signal.removeEventListener('abort', operation.onAbort);
          }
          operation.reject(new Error('Worker terminated'));
        }
      }
      queuedOperations.length = 0;
      for (const pending of pendingRequests.values()) {
        pending.reject(new Error('Worker terminated'));
      }
      pendingRequests.clear();
    };

    /** Fails all pending executions when the worker errors unexpectedly. */
    const handleWorkerError = (error: Error) => {
      resetWorker();
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    };

    const postInitMessage = (targetWorker: RLMWorker) => {
      targetWorker.postMessage({
        type: 'init',
        globals: serializableGlobals,
        fnNames: [...fnMap.keys()],
        permissions: [...this.permissions],
        allowUnsafeNodeHostAccess: this.allowUnsafeNodeHostAccess,
        outputMode: this.outputMode,
        captureConsole: this.captureConsole,
        blockDynamicImport: this.blockDynamicImport,
        blockShadowRealm: this.blockShadowRealm,
        freezeIntrinsics: this.freezeIntrinsics,
        lockWorkerIPC: this.lockWorkerIPC,
        preventGlobalThisExtensions: this.preventGlobalThisExtensions,
        allowedModules: [...this.allowedModules],
      });
    };

    if (canUseWebWorker()) {
      worker = createBrowserWorker(
        source,
        this.permissions,
        this.allowDenoRemoteImport
      );
      workerRuntime = 'browser';
      worker.onmessage = handleWorkerMessage;
      worker.onerror = handleWorkerError;
      try {
        postInitMessage(worker);
      } catch (error) {
        cleanup();
        throw error;
      }
    }

    /** Lazily creates/initializes worker in the current runtime. */
    const ensureWorker = async (): Promise<void> => {
      if (worker) {
        return;
      }
      if (isClosed) {
        throw new Error('Session is closed');
      }
      if (canUseWebWorker()) {
        worker = createBrowserWorker(
          source,
          this.permissions,
          this.allowDenoRemoteImport
        );
        workerRuntime = 'browser';
        worker.onmessage = handleWorkerMessage;
        worker.onerror = handleWorkerError;
        try {
          postInitMessage(worker);
        } catch (error) {
          cleanup();
          throw error;
        }
        return;
      }
      if (!isNodeRuntime()) {
        throw new Error(
          'No worker runtime available: Web Worker is unavailable in this environment'
        );
      }
      if (!workerReady) {
        workerReady = (
          nodeWorkerPool
            ? nodeWorkerPool.acquire()
            : createNodeWorker(source, nodeExecArgv, this.resourceLimits)
        ).then((created) => {
          if (isClosed) {
            if (nodeWorkerPool) {
              nodeWorkerPool.release(created);
            } else {
              created.terminate();
            }
            throw new Error('Session is closed');
          }

          worker = created;
          workerRuntime = 'node';
          worker.onmessage = handleWorkerMessage;
          worker.onerror = handleWorkerError;
          try {
            postInitMessage(worker);
          } catch (error) {
            if (nodeWorkerPool) {
              nodeWorkerPool.release(created);
            } else {
              created.terminate();
            }
            worker = null;
            workerRuntime = null;
            throw error;
          }
        });
      }
      await workerReady;
    };

    const dispatchWorkerRequest = (
      payload: Record<string, unknown>,
      options: Readonly<{
        signal?: AbortSignal;
        timeoutMessage: string;
      }>
    ): Promise<unknown> => {
      if (isClosed) {
        return Promise.reject(new Error('Session is closed'));
      }

      const signal = options.signal;
      if (signal?.aborted) {
        return Promise.reject(
          new Error(`Aborted: ${signal.reason ?? 'execution aborted'}`)
        );
      }

      const id = ++nextId;

      return new Promise<unknown>((resolve, reject) => {
        const originalResolve = resolve;
        const originalReject = reject;
        let timer: ReturnType<typeof setTimeout> | undefined;

        let onCleanup = () => {};
        pendingRequests.set(id, {
          resolve: (value: unknown) => {
            if (timer) {
              clearTimeout(timer);
            }
            onCleanup();
            originalResolve(value);
          },
          reject: (error: Error) => {
            if (timer) {
              clearTimeout(timer);
            }
            onCleanup();
            originalReject(error);
          },
        });

        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            pendingRequests.delete(id);
            cleanup();
            originalReject(
              new Error(`Aborted: ${signal.reason ?? 'execution aborted'}`)
            );
          };
          signal.addEventListener('abort', onAbort, { once: true });
          onCleanup = () => {
            signal.removeEventListener('abort', onAbort);
          };
        }

        void ensureWorker()
          .then(() => {
            if (!worker) {
              throw new Error('Worker unavailable');
            }
            timer = setTimeout(() => {
              pendingRequests.delete(id);
              resetWorker();
              for (const pending of pendingRequests.values()) {
                pending.reject(new Error('Worker terminated'));
              }
              pendingRequests.clear();
              reject(new Error(options.timeoutMessage));
            }, timeout);
            worker.postMessage({ ...payload, id });
          })
          .catch((error: Error) => {
            const pending = pendingRequests.get(id);
            if (!pending) {
              return;
            }
            pendingRequests.delete(id);
            clearTimeout(timer);
            onCleanup();
            originalReject(error);
          });
      });
    };

    const enqueueSessionRequest = <T>(
      signal: AbortSignal | undefined,
      operation: () => Promise<T>
    ): Promise<T> => {
      if (isClosed) {
        return Promise.reject(new Error('Session is closed'));
      }
      if (signal?.aborted) {
        return Promise.reject(
          new Error(`Aborted: ${signal.reason ?? 'execution aborted'}`)
        );
      }

      return new Promise<T>((resolve, reject) => {
        const queuedOperation: QueuedSessionOperation = {
          started: false,
          settled: false,
          signal,
          resolve: resolve as (value: unknown) => void,
          reject,
          operation: operation as () => Promise<unknown>,
        };

        if (signal) {
          const onAbort = () => {
            if (queuedOperation.settled) {
              return;
            }
            queuedOperation.settled = true;
            const index = queuedOperations.indexOf(queuedOperation);
            if (index !== -1) {
              queuedOperations.splice(index, 1);
            }
            signal.removeEventListener('abort', onAbort);
            reject(
              new Error(`Aborted: ${signal.reason ?? 'execution aborted'}`)
            );
          };
          queuedOperation.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }

        queuedOperations.push(queuedOperation);

        const processNextQueuedOperation = () => {
          if (activeQueuedOperation) {
            return;
          }

          const nextOperation = queuedOperations.find(
            (queued) => !queued.started && !queued.settled
          );
          if (!nextOperation) {
            return;
          }

          const finish = () => {
            activeQueuedOperation = null;
            processNextQueuedOperation();
          };

          activeQueuedOperation = (async () => {
            if (nextOperation.settled) {
              return;
            }
            if (isClosed) {
              nextOperation.settled = true;
              if (nextOperation.signal && nextOperation.onAbort) {
                nextOperation.signal.removeEventListener(
                  'abort',
                  nextOperation.onAbort
                );
              }
              nextOperation.reject(new Error('Worker terminated'));
              return;
            }
            if (nextOperation.signal?.aborted) {
              nextOperation.settled = true;
              if (nextOperation.onAbort) {
                nextOperation.signal.removeEventListener(
                  'abort',
                  nextOperation.onAbort
                );
              }
              nextOperation.reject(
                new Error(
                  `Aborted: ${nextOperation.signal.reason ?? 'execution aborted'}`
                )
              );
              return;
            }

            nextOperation.started = true;

            try {
              const value = await nextOperation.operation();
              if (nextOperation.settled) {
                return;
              }
              nextOperation.settled = true;
              if (nextOperation.signal && nextOperation.onAbort) {
                nextOperation.signal.removeEventListener(
                  'abort',
                  nextOperation.onAbort
                );
              }
              nextOperation.resolve(value);
            } catch (error) {
              if (nextOperation.settled) {
                return;
              }
              nextOperation.settled = true;
              if (nextOperation.signal && nextOperation.onAbort) {
                nextOperation.signal.removeEventListener(
                  'abort',
                  nextOperation.onAbort
                );
              }
              nextOperation.reject(error as Error);
            } finally {
              const index = queuedOperations.indexOf(nextOperation);
              if (index !== -1) {
                queuedOperations.splice(index, 1);
              }
              finish();
            }
          })().catch(() => {
            finish();
          });
        };

        processNextQueuedOperation();
      });
    };

    return {
      execute(
        code: string,
        options?: {
          signal?: AbortSignal;
          reservedNames?: readonly string[];
        }
      ) {
        if (isClosed) {
          return Promise.reject(new Error('Session is closed'));
        }

        // Block "use strict" directive — it breaks the runtime sandbox
        if (/['"]use strict['"]/.test(code)) {
          return Promise.resolve(
            '[ERROR] "use strict" is not allowed in the runtime session. Remove it and try again.'
          );
        }

        // Block assignment/redeclaration of reserved runtime names.
        const reserved = options?.reservedNames;
        if (reserved) {
          const violation = findReservedRuntimeNameViolation(code, reserved);
          if (violation) {
            return Promise.resolve(
              `[ERROR] Cannot assign to, redeclare, or shadow reserved runtime variable '${violation}'. ` +
                `Use a different local variable name (for example: \`ctx\`) or access the original via \`inputs.${violation}\`.`
            );
          }
        }

        if (!speculationOptions) {
          return enqueueSessionRequest(options?.signal, () =>
            dispatchWorkerRequest(
              { type: 'execute', code },
              {
                signal: options?.signal,
                timeoutMessage: 'Execution timed out',
              }
            )
          );
        }

        return enqueueSessionRequest(options?.signal, async () => {
          const speculationTurn = new JSRuntimeSpeculationTurn(
            speculationOptions,
            fnMap,
            fnPathToRef,
            refToFnPath
          );
          activeSpeculationTurn = speculationTurn;
          speculationTurn.plan(code, serializableGlobals);
          let completed = false;
          try {
            const value = await dispatchWorkerRequest(
              { type: 'execute', code },
              {
                signal: options?.signal,
                timeoutMessage: 'Execution timed out',
              }
            );
            if (inFlightHostCalls.size > 0) {
              await Promise.allSettled([...inFlightHostCalls]);
            }
            completed = true;
            return value;
          } finally {
            if (activeSpeculationTurn === speculationTurn) {
              activeSpeculationTurn = null;
            }
            speculationTurn.finish(
              completed
                ? 'execution-complete'
                : options?.signal?.aborted
                  ? 'execution-aborted'
                  : 'execution-failed'
            );
          }
        });
      },

      inspectGlobals(options?: {
        signal?: AbortSignal;
        reservedNames?: readonly string[];
      }) {
        if (isClosed) {
          return Promise.reject(new Error('Session is closed'));
        }

        return enqueueSessionRequest(options?.signal, () =>
          dispatchWorkerRequest(
            {
              type: 'inspect-globals',
              reservedNames: options?.reservedNames,
            },
            {
              signal: options?.signal,
              timeoutMessage: 'Global inspection timed out',
            }
          ).then((value) =>
            typeof value === 'string'
              ? value
              : value === undefined
                ? ''
                : JSON.stringify(value)
          )
        );
      },

      snapshotGlobals(options?: {
        signal?: AbortSignal;
        reservedNames?: readonly string[];
      }) {
        if (isClosed) {
          return Promise.reject(new Error('Session is closed'));
        }

        return enqueueSessionRequest(options?.signal, () =>
          dispatchWorkerRequest(
            {
              type: 'snapshot-globals',
              reservedNames: options?.reservedNames,
            },
            {
              signal: options?.signal,
              timeoutMessage: 'Global snapshot timed out',
            }
          ).then(normalizeCodeSessionSnapshot)
        );
      },

      async patchGlobals(
        globals: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ) {
        if (!globals || typeof globals !== 'object' || Array.isArray(globals)) {
          throw new Error('patchGlobals expects an object');
        }

        const {
          serializableGlobals: serializablePatch,
          fnMap: patchFnMap,
          fnPathToRef: patchFnPathToRef,
        } = splitGlobalsForWorker(globals, {
          nextFnId: () => ++nextFnRefId,
        });
        validateSerializableGlobals(serializablePatch);

        if (Object.keys(serializablePatch).length === 0) {
          return;
        }

        await enqueueSessionRequest(options?.signal, () =>
          dispatchWorkerRequest(
            { type: 'update-globals', globals: serializablePatch },
            {
              signal: options?.signal,
              timeoutMessage: 'Global patch timed out',
            }
          )
        );

        for (const [key, value] of Object.entries(serializablePatch)) {
          serializableGlobals[key] = value;
        }
        const patchedRoots = Object.keys(serializablePatch);
        for (const [path, ref] of [...fnPathToRef]) {
          if (
            patchedRoots.some(
              (key) => path === key || path.startsWith(`${key}.`)
            )
          ) {
            fnPathToRef.delete(path);
            refToFnPath.delete(ref);
          }
        }
        for (const [key, fn] of patchFnMap.entries()) {
          fnMap.set(key, fn);
        }
        for (const [path, ref] of patchFnPathToRef) {
          fnPathToRef.set(path, ref);
          refToFnPath.set(ref, path);
        }
      },

      close() {
        cleanup();
      },
    };
  }

  public toFunction(): AxFunction {
    return {
      name: 'javascriptInterpreter',
      description:
        'Execute JavaScript code in a persistent session and return output.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute.',
          },
        },
        required: ['code'],
      },
      func: async ({ code }: Readonly<{ code: string }>, options) => {
        const session = this.createSession();
        try {
          return await session.execute(code, { signal: options?.abortSignal });
        } finally {
          session.close();
        }
      },
    };
  }
}

const axJSRuntimeCreateSession = AxJSRuntime.prototype.createSession;
const axJSRuntimeGetUsageInstructions =
  AxJSRuntime.prototype.getUsageInstructions;

/**
 * Factory function for creating an AxJSRuntime.
 */
export function axCreateJSRuntime(
  options?: Readonly<{
    timeout?: number;
    permissions?: readonly AxJSRuntimePermission[];
    outputMode?: AxJSRuntimeOutputMode;
    captureConsole?: boolean;
    allowUnsafeNodeHostAccess?: boolean;
    nodeWorkerPoolSize?: number;
    debugNodeWorkerPool?: boolean;
    blockDynamicImport?: boolean;
    allowedModules?: readonly string[];
    freezeIntrinsics?: boolean;
    blockShadowRealm?: boolean;
    lockWorkerIPC?: boolean;
    preventGlobalThisExtensions?: boolean;
    useNodePermissionModel?: boolean | 'auto';
    nodePermissionAllowlist?: AxJSRuntimeNodePermissionAllowlist;
    resourceLimits?: AxJSRuntimeResourceLimits;
    allowDenoRemoteImport?: boolean;
    speculation?: AxJSRuntimeSpeculationOptions;
  }>
): AxJSRuntime {
  return new AxJSRuntime(options);
}
