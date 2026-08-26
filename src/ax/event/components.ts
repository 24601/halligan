export type AxEventComponentState =
  | 'defined'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'failed'
  | 'disposed';

export type AxEventComponentDisposer = () => void | Promise<void>;

export interface AxEventComponentAcquisition<T> {
  value: T;
  dispose: AxEventComponentDisposer;
}

export interface AxEventComponentActivationContext {
  readonly id: string;
  readonly version: string;
  readonly signal: AbortSignal;
  dependency<T = unknown>(id: string): T;
  addDisposer(label: string, disposer: AxEventComponentDisposer): void;
  acquire<T>(
    label: string,
    setup: (
      signal: AbortSignal
    ) =>
      | AxEventComponentAcquisition<T>
      | Promise<AxEventComponentAcquisition<T>>
  ): Promise<T>;
}

export interface AxEventComponentDefinition<T = unknown> {
  id: string;
  version: string;
  dependencies?: readonly string[];
  activate(context: AxEventComponentActivationContext): T | Promise<T>;
}

export type AxEventComponentDiagnosticCode =
  | 'missing-disposer'
  | 'late-disposer'
  | 'disposer-failed'
  | 'disposer-timeout'
  | 'replacement-failed'
  | 'replacement-cleanup-failed';

export interface AxEventComponentDiagnostic {
  code: AxEventComponentDiagnosticCode;
  componentId: string;
  phase: 'activate' | 'deactivate' | 'dispose' | 'replace';
  message: string;
  effect?: string;
  at: number;
  error?: unknown;
}

export interface AxEventComponentEffectInspection {
  label: string;
  state: 'registered' | 'disposing' | 'disposed' | 'failed';
  error?: unknown;
}

export interface AxEventComponentInspection {
  id: string;
  version: string;
  dependencies: readonly string[];
  state: AxEventComponentState;
  effects: readonly Readonly<AxEventComponentEffectInspection>[];
  diagnostics: readonly Readonly<AxEventComponentDiagnostic>[];
  lastError?: unknown;
}

export interface AxEventComponentTransitionOptions {
  signal?: AbortSignal;
  /** Maximum total time spent awaiting cleanup started by this transition. */
  timeoutMs?: number;
}

export interface AxEventComponentManagerOptions {
  onDiagnostic?: (
    diagnostic: Readonly<AxEventComponentDiagnostic>,
    component: Readonly<AxEventComponentInspection>
  ) => void | Promise<void>;
}

export class AxEventComponentLeakError extends Error {
  constructor(
    readonly componentId: string,
    readonly effect: string,
    message: string
  ) {
    super(message);
    this.name = 'AxEventComponentLeakError';
  }
}

export class AxEventComponentTransitionError extends Error {
  constructor(
    readonly componentId: string,
    readonly phase: 'activate' | 'deactivate' | 'dispose' | 'replace',
    message: string,
    readonly rollbackErrors: readonly unknown[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AxEventComponentTransitionError';
  }
}

class AxEventComponentDisposerTimeoutError extends Error {
  constructor(componentId: string, effect: string) {
    super(`Disposer ${effect} timed out for event component ${componentId}`);
    this.name = 'AxEventComponentDisposerTimeoutError';
  }
}

function transitionDeadline(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Event component cleanup timeout must be non-negative');
  }
  return Date.now() + timeoutMs;
}

async function settleDisposer(
  disposer: AxEventComponentDisposer,
  deadline: number | undefined,
  componentId: string,
  effect: string
): Promise<unknown | undefined> {
  const operation = Promise.resolve().then(disposer);
  if (deadline === undefined) {
    try {
      await operation;
      return undefined;
    } catch (error) {
      return error;
    }
  }
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    operation.then(
      () => ({ settled: true as const }),
      (error: unknown) => ({ settled: true as const, error })
    ),
    new Promise<{ settled: false }>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), remaining);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.settled) return 'error' in outcome ? outcome.error : undefined;
  void operation.catch(() => undefined);
  return new AxEventComponentDisposerTimeoutError(componentId, effect);
}

type ManagedEffect = {
  label: string;
  dispose: AxEventComponentDisposer;
  state: AxEventComponentEffectInspection['state'];
  error: unknown | undefined;
};

type ComponentRecord = {
  definition: Readonly<AxEventComponentDefinition>;
  state: AxEventComponentState;
  effects: ManagedEffect[];
  diagnostics: AxEventComponentDiagnostic[];
  value: unknown | undefined;
  context: AxManagedEventComponentContext | undefined;
  scope: AbortController | undefined;
  lastError: unknown | undefined;
};

class AxManagedEventComponentContext
  implements AxEventComponentActivationContext
{
  private registrationOpen = true;
  private closed = false;
  private readonly transitionAbort?: () => void;

  constructor(
    private readonly record: ComponentRecord,
    private readonly scope: AbortController,
    private readonly transitionSignal: AbortSignal | undefined,
    private readonly cleanupDeadline: number | undefined,
    private readonly resolveDependency: <T>(id: string) => T,
    private readonly reportDiagnostic: (
      diagnostic: AxEventComponentDiagnostic
    ) => void
  ) {
    if (transitionSignal) {
      this.transitionAbort = () => scope.abort(transitionSignal.reason);
      if (transitionSignal.aborted) {
        this.transitionAbort();
      } else {
        transitionSignal.addEventListener('abort', this.transitionAbort, {
          once: true,
        });
      }
    }
  }

  get id(): string {
    return this.record.definition.id;
  }

  get version(): string {
    return this.record.definition.version;
  }

  get signal(): AbortSignal {
    return this.scope.signal;
  }

  dependency<T = unknown>(id: string): T {
    if (this.closed) {
      throw new Error(`Event component ${this.id} is inactive`);
    }
    if (!this.record.definition.dependencies?.includes(id)) {
      throw new Error(
        `Event component ${this.id} did not declare dependency ${id}`
      );
    }
    return this.resolveDependency<T>(id);
  }

  addDisposer(label: string, disposer: AxEventComponentDisposer): void {
    validateEffect(label, disposer);
    if (!this.registrationOpen) {
      const error = new AxEventComponentLeakError(
        this.id,
        label,
        `Event component ${this.id} registered disposer ${label} after activation completed`
      );
      this.reportDiagnostic({
        code: 'late-disposer',
        componentId: this.id,
        phase: 'activate',
        effect: label,
        message: error.message,
        at: Date.now(),
        error,
      });
      throw error;
    }
    this.record.effects.push({
      label,
      dispose: once(disposer),
      state: 'registered',
      error: undefined,
    });
  }

  async acquire<T>(
    label: string,
    setup: (
      signal: AbortSignal
    ) =>
      | AxEventComponentAcquisition<T>
      | Promise<AxEventComponentAcquisition<T>>
  ): Promise<T> {
    if (!this.registrationOpen) {
      throw new AxEventComponentLeakError(
        this.id,
        label,
        `Event component ${this.id} attempted acquisition ${label} after activation completed`
      );
    }
    validateEffect(label, () => undefined);
    const acquired = await setup(this.signal);
    if (!acquired || typeof acquired.dispose !== 'function') {
      const error = new AxEventComponentLeakError(
        this.id,
        label,
        `Event component ${this.id} acquisition ${label} did not return a disposer`
      );
      this.reportDiagnostic({
        code: 'missing-disposer',
        componentId: this.id,
        phase: 'activate',
        effect: label,
        message: error.message,
        at: Date.now(),
        error,
      });
      throw error;
    }
    if (!this.registrationOpen || this.signal.aborted) {
      const error = new AxEventComponentLeakError(
        this.id,
        label,
        `Event component ${this.id} acquisition ${label} completed after activation closed or aborted`
      );
      this.reportDiagnostic({
        code: 'late-disposer',
        componentId: this.id,
        phase: 'activate',
        effect: label,
        message: error.message,
        at: Date.now(),
        error,
      });
      const disposeError = await settleDisposer(
        acquired.dispose,
        this.cleanupDeadline,
        this.id,
        label
      );
      if (disposeError) {
        this.reportDiagnostic({
          code:
            disposeError instanceof AxEventComponentDisposerTimeoutError
              ? 'disposer-timeout'
              : 'disposer-failed',
          componentId: this.id,
          phase: 'activate',
          effect: label,
          message: `Late disposer ${label} for event component ${this.id} failed`,
          at: Date.now(),
          error: disposeError,
        });
      }
      throw error;
    }
    try {
      this.addDisposer(label, acquired.dispose);
    } catch (error) {
      const disposeError = await settleDisposer(
        acquired.dispose,
        this.cleanupDeadline,
        this.id,
        label
      );
      if (disposeError) {
        this.reportDiagnostic({
          code:
            disposeError instanceof AxEventComponentDisposerTimeoutError
              ? 'disposer-timeout'
              : 'disposer-failed',
          componentId: this.id,
          phase: 'activate',
          effect: label,
          message: `Disposer ${label} for event component ${this.id} failed after registration`,
          at: Date.now(),
          error: disposeError,
        });
      }
      throw error;
    }
    throwIfAborted(this.signal);
    return acquired.value;
  }

  completeActivation(): void {
    this.registrationOpen = false;
    this.detachTransitionAbort();
  }

  beginCleanup(reason: string): void {
    this.registrationOpen = false;
    this.detachTransitionAbort();
    if (!this.scope.signal.aborted) this.scope.abort(reason);
  }

  close(): void {
    this.closed = true;
  }

  private detachTransitionAbort(): void {
    if (this.transitionAbort) {
      this.transitionSignal?.removeEventListener('abort', this.transitionAbort);
    }
  }
}

/**
 * Trusted, process-local lifecycle manager for host-defined event integrations.
 * Graph-changing calls are serialized; activation and cleanup are deterministic.
 */
export class AxEventComponentManager {
  private readonly records = new Map<string, ComponentRecord>();
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: Readonly<AxEventComponentManagerOptions> = {}
  ) {}

  define<T>(
    definition: Readonly<AxEventComponentDefinition<T>>
  ): Promise<void> {
    return this.enqueue(async () => {
      const normalized = normalizeDefinition(definition);
      if (this.records.has(normalized.id)) {
        throw new Error(`Duplicate event component id: ${normalized.id}`);
      }
      const record: ComponentRecord = {
        definition: normalized,
        state: 'defined',
        effects: [],
        diagnostics: [],
        value: undefined,
        context: undefined,
        scope: undefined,
        lastError: undefined,
      };
      this.assertLiveDependencies(normalized);
      this.records.set(normalized.id, record);
      try {
        this.assertAcyclic();
      } catch (error) {
        this.records.delete(normalized.id);
        throw error;
      }
    });
  }

  abortAll(reason: unknown): void {
    for (const record of this.records.values()) {
      if (record.scope && !record.scope.signal.aborted) {
        record.scope.abort(reason);
      }
    }
  }

  inspect(): readonly Readonly<AxEventComponentInspection>[];
  inspect(id: string): Readonly<AxEventComponentInspection> | undefined;
  inspect(
    id?: string
  ):
    | readonly Readonly<AxEventComponentInspection>[]
    | Readonly<AxEventComponentInspection>
    | undefined {
    if (id !== undefined) {
      const record = this.records.get(id);
      return record ? snapshot(record) : undefined;
    }
    return [...this.records.values()]
      .sort((a, b) => a.definition.id.localeCompare(b.definition.id))
      .map(snapshot);
  }

  get<T = unknown>(id: string): T {
    const record = this.records.get(id);
    if (!record || record.state !== 'active') {
      throw new Error(`Event component ${id} is not active`);
    }
    return record.value as T;
  }

  activate(
    ids?: string | readonly string[],
    options: Readonly<AxEventComponentTransitionOptions> = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      throwIfAborted(options.signal);
      const cleanupDeadline = transitionDeadline(options.timeoutMs);
      const order = this.activationOrder(this.normalizeTargets(ids, false));
      for (const record of order) {
        if (record.state !== 'active') {
          this.assertSettledForTransition(record, 'activate');
        }
      }
      const activated: ComponentRecord[] = [];
      try {
        for (const record of order) {
          throwIfAborted(options.signal);
          if (record.state === 'active') continue;
          await this.activateRecord(
            record,
            options.signal,
            undefined,
            cleanupDeadline
          );
          activated.push(record);
        }
      } catch (error) {
        const rollbackErrors = await this.rollback(
          activated,
          'activate',
          cleanupDeadline
        );
        const componentId =
          error instanceof AxEventComponentTransitionError
            ? error.componentId
            : (order.find((record) => record.state === 'failed')?.definition
                .id ?? 'component-graph');
        throw new AxEventComponentTransitionError(
          componentId,
          'activate',
          `Event component activation transaction failed at ${componentId}: ${errorMessage(error)}`,
          rollbackErrors,
          { cause: error }
        );
      }
    });
  }

  deactivate(
    ids?: string | readonly string[],
    options: Readonly<AxEventComponentTransitionOptions> = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      throwIfAborted(options.signal);
      await this.deactivateRecords(
        this.normalizeTargets(ids, true),
        'deactivate',
        transitionDeadline(options.timeoutMs)
      );
    });
  }

  dispose(
    ids?: string | readonly string[],
    options: Readonly<AxEventComponentTransitionOptions> = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      throwIfAborted(options.signal);
      const cleanupDeadline = transitionDeadline(options.timeoutMs);
      const targets = this.dependentDefinitionClosure(
        this.normalizeTargets(ids, true)
      );
      let teardownError: unknown;
      try {
        await this.deactivateRecords(targets, 'dispose', cleanupDeadline);
      } catch (error) {
        teardownError = error;
      }
      for (const id of targets) {
        const record = this.records.get(id);
        if (!record) continue;
        const failedEffects = record.effects.some(
          (effect) => effect.state === 'failed'
        );
        if (teardownError || failedEffects) {
          record.state = 'failed';
          record.lastError = teardownError ?? record.lastError;
        } else {
          record.state = 'disposed';
        }
      }
      if (teardownError) throw teardownError;
    });
  }

  replace<T>(
    definition: Readonly<AxEventComponentDefinition<T>>,
    options: Readonly<AxEventComponentTransitionOptions> = {}
  ): Promise<Readonly<AxEventComponentInspection>> {
    return this.enqueue(async () => {
      throwIfAborted(options.signal);
      const cleanupDeadline = transitionDeadline(options.timeoutMs);
      const normalized = normalizeDefinition(definition);
      const previous = this.records.get(normalized.id);
      if (!previous || previous.state === 'disposed') {
        throw new Error(
          `Cannot replace unknown or disposed event component ${normalized.id}`
        );
      }
      if (previous.definition.version === normalized.version) {
        throw new Error(
          `Replacement for event component ${normalized.id} must use a new version`
        );
      }
      if (previous.state !== 'active') {
        this.assertSettledForTransition(previous, 'replace');
      }
      this.assertLiveDependencies(normalized);
      this.assertReplacementAcyclic(normalized);

      const candidate: ComponentRecord = {
        definition: normalized,
        state: 'defined',
        effects: [],
        diagnostics: [],
        value: undefined,
        context: undefined,
        scope: undefined,
        lastError: undefined,
      };
      if (previous.state !== 'active') {
        this.records.set(normalized.id, candidate);
        return snapshot(candidate);
      }
      const previousGraph = this.activeDependentClosure([normalized.id]);
      const staged = new Map<string, ComponentRecord>([
        [normalized.id, candidate],
      ]);
      for (const previousRecord of previousGraph) {
        if (previousRecord.definition.id === normalized.id) continue;
        staged.set(previousRecord.definition.id, {
          definition: previousRecord.definition,
          state: 'defined',
          effects: [],
          diagnostics: [],
          value: undefined,
          context: undefined,
          scope: undefined,
          lastError: undefined,
        });
      }
      const externalDependencies = new Set<string>();
      for (const record of staged.values()) {
        for (const dependency of record.definition.dependencies ?? []) {
          if (!staged.has(dependency)) externalDependencies.add(dependency);
        }
      }
      const dependencyOrder = this.activationOrder([...externalDependencies]);
      for (const dependency of dependencyOrder) {
        if (dependency.state !== 'active') {
          this.assertSettledForTransition(dependency, 'replace');
        }
      }
      const stagedOrder = stagedTopologicalOrder(staged);
      const activatedDependencies: ComponentRecord[] = [];
      const activatedStaged: ComponentRecord[] = [];
      const resolveStagedDependency = <R>(id: string): R => {
        const dependency = staged.get(id);
        if (!dependency) return this.get<R>(id);
        if (dependency.state !== 'active') {
          throw new Error(`Staged event component ${id} is not active`);
        }
        return dependency.value as R;
      };
      try {
        for (const dependency of dependencyOrder) {
          throwIfAborted(options.signal);
          if (dependency.state === 'active') continue;
          await this.activateRecord(
            dependency,
            options.signal,
            undefined,
            cleanupDeadline
          );
          activatedDependencies.push(dependency);
        }
        for (const stagedRecord of stagedOrder) {
          throwIfAborted(options.signal);
          await this.activateRecord(
            stagedRecord,
            options.signal,
            resolveStagedDependency,
            cleanupDeadline
          );
          activatedStaged.push(stagedRecord);
        }
      } catch (error) {
        const rollbackErrors = await this.rollback(
          [...activatedDependencies, ...activatedStaged],
          'replace',
          cleanupDeadline
        );
        const restoration =
          previous.state === 'active'
            ? `${normalized.id}@${previous.definition.version} and its active dependents remain active`
            : `${normalized.id}@${previous.definition.version} remains unchanged`;
        const transitionError = new AxEventComponentTransitionError(
          normalized.id,
          'replace',
          `Replacement candidate ${normalized.id}@${normalized.version} failed; ${restoration}`,
          rollbackErrors,
          { cause: error }
        );
        this.addDiagnostic(previous, {
          code: 'replacement-failed',
          componentId: normalized.id,
          phase: 'replace',
          message: transitionError.message,
          at: Date.now(),
          error: transitionError,
        });
        throw transitionError;
      }

      for (const record of stagedOrder) {
        this.records.set(record.definition.id, record);
      }
      for (const previousRecord of [...previousGraph].reverse()) {
        const cleanupErrors = await this.cleanupRecord(
          previousRecord,
          'replace',
          cleanupDeadline
        );
        if (cleanupErrors.length > 0) {
          const activeRecord = staged.get(previousRecord.definition.id)!;
          this.addDiagnostic(activeRecord, {
            code: 'replacement-cleanup-failed',
            componentId: previousRecord.definition.id,
            phase: 'replace',
            message: `Replacement graph for ${normalized.id}@${normalized.version} is active, but ${cleanupErrors.length} prior disposer(s) failed for ${previousRecord.definition.id}`,
            at: Date.now(),
            error: new AggregateError(cleanupErrors),
          });
        }
      }
      return snapshot(candidate);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail.then(operation, operation);
    this.transitionTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private normalizeTargets(
    ids: string | readonly string[] | undefined,
    allowDisposed: boolean
  ): string[] {
    const targets =
      ids === undefined
        ? [...this.records.keys()]
        : typeof ids === 'string'
          ? [ids]
          : [...ids];
    const unique = [...new Set(targets)].sort();
    for (const id of unique) {
      const record = this.records.get(id);
      if (!record) throw new Error(`Unknown event component dependency: ${id}`);
      if (!allowDisposed && record.state === 'disposed') {
        throw new Error(`Event component ${id} is disposed`);
      }
    }
    return unique.filter(
      (id) => allowDisposed || this.records.get(id)?.state !== 'disposed'
    );
  }

  private activationOrder(ids: readonly string[]): ComponentRecord[] {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const order: ComponentRecord[] = [];
    const visit = (id: string, path: readonly string[]): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(
          `Event component dependency cycle: ${[...path, id].join(' -> ')}`
        );
      }
      const record = this.records.get(id);
      if (!record || record.state === 'disposed') {
        throw new Error(`Unknown event component dependency: ${id}`);
      }
      visiting.add(id);
      for (const dependency of [
        ...(record.definition.dependencies ?? []),
      ].sort()) {
        visit(dependency, [...path, id]);
      }
      visiting.delete(id);
      visited.add(id);
      order.push(record);
    };
    for (const id of [...ids].sort()) visit(id, []);
    return order;
  }

  private async activateRecord(
    record: ComponentRecord,
    transitionSignal?: AbortSignal,
    resolveDependency: <T>(id: string) => T = <T>(id: string) =>
      this.get<T>(id),
    cleanupDeadline?: number
  ): Promise<void> {
    const dependencyValues = new Map<string, unknown>();
    for (const dependency of record.definition.dependencies ?? []) {
      dependencyValues.set(dependency, resolveDependency(dependency));
    }
    record.state = 'activating';
    record.effects = [];
    record.value = undefined;
    record.lastError = undefined;
    const scope = new AbortController();
    record.scope = scope;
    const context = new AxManagedEventComponentContext(
      record,
      scope,
      transitionSignal,
      cleanupDeadline,
      <T>(id: string) => dependencyValues.get(id) as T,
      (diagnostic) => this.addDiagnostic(record, diagnostic)
    );
    record.context = context;
    try {
      throwIfAborted(context.signal);
      record.value = await record.definition.activate(context);
      throwIfAborted(context.signal);
      context.completeActivation();
      record.state = 'active';
    } catch (error) {
      const cleanupErrors = await this.cleanupRecord(
        record,
        'activate',
        cleanupDeadline
      );
      record.state = 'failed';
      record.lastError =
        cleanupErrors.length > 0
          ? new AggregateError(
              [error, ...cleanupErrors],
              `Activation and rollback failed for event component ${record.definition.id}`
            )
          : error;
      throw new AxEventComponentTransitionError(
        record.definition.id,
        'activate',
        `Failed to activate event component ${record.definition.id}@${record.definition.version}`,
        cleanupErrors,
        { cause: error }
      );
    }
  }

  private async deactivateRecords(
    targets: readonly string[],
    phase: 'deactivate' | 'dispose',
    cleanupDeadline?: number
  ): Promise<void> {
    const order = this.activeDependentClosure(targets).reverse();
    const errors: unknown[] = [];
    for (const record of order) {
      errors.push(
        ...(await this.cleanupRecord(record, phase, cleanupDeadline))
      );
    }
    if (errors.length > 0) {
      throw new AxEventComponentTransitionError(
        targets[0] ?? 'component-graph',
        phase,
        `Failed to ${phase} ${errors.length} event component effect(s)`,
        errors,
        { cause: new AggregateError(errors) }
      );
    }
  }

  private activeDependentClosure(
    targets: readonly string[]
  ): ComponentRecord[] {
    const selected = new Set(
      targets.filter((id) => this.records.get(id)?.state === 'active')
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.records.values()) {
        if (record.state !== 'active' || selected.has(record.definition.id)) {
          continue;
        }
        if (
          record.definition.dependencies?.some((dependency) =>
            selected.has(dependency)
          )
        ) {
          selected.add(record.definition.id);
          changed = true;
        }
      }
    }
    return this.activeTopologicalOrder().filter((record) =>
      selected.has(record.definition.id)
    );
  }

  private dependentDefinitionClosure(targets: readonly string[]): string[] {
    const selected = new Set(targets);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.records.values()) {
        if (
          record.state === 'disposed' ||
          selected.has(record.definition.id) ||
          !record.definition.dependencies?.some((dependency) =>
            selected.has(dependency)
          )
        ) {
          continue;
        }
        selected.add(record.definition.id);
        changed = true;
      }
    }
    return [...selected].sort();
  }

  private activeTopologicalOrder(): ComponentRecord[] {
    const activeIds = [...this.records.values()]
      .filter((record) => record.state === 'active')
      .map((record) => record.definition.id)
      .sort();
    const active = new Set(activeIds);
    const visited = new Set<string>();
    const order: ComponentRecord[] = [];
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const record = this.records.get(id);
      if (!record) return;
      for (const dependency of [
        ...(record.definition.dependencies ?? []),
      ].sort()) {
        if (active.has(dependency)) visit(dependency);
      }
      order.push(record);
    };
    for (const id of activeIds) visit(id);
    return order;
  }

  private async cleanupRecord(
    record: ComponentRecord,
    phase: AxEventComponentDiagnostic['phase'],
    cleanupDeadline?: number
  ): Promise<unknown[]> {
    record.state = 'deactivating';
    record.context?.beginCleanup(
      `Event component ${record.definition.id} ${phase}`
    );
    const errors: unknown[] = [];
    for (const effect of [...record.effects].reverse()) {
      if (effect.state !== 'registered') continue;
      effect.state = 'disposing';
      const error = await settleDisposer(
        effect.dispose,
        cleanupDeadline,
        record.definition.id,
        effect.label
      );
      if (!error) {
        effect.state = 'disposed';
      } else {
        effect.state = 'failed';
        effect.error = error;
        errors.push(error);
        this.addDiagnostic(record, {
          code:
            error instanceof AxEventComponentDisposerTimeoutError
              ? 'disposer-timeout'
              : 'disposer-failed',
          componentId: record.definition.id,
          phase,
          effect: effect.label,
          message: `Disposer ${effect.label} failed for event component ${record.definition.id}`,
          at: Date.now(),
          error,
        });
      }
    }
    record.context?.close();
    record.context = undefined;
    record.scope = undefined;
    record.value = undefined;
    record.state = errors.length > 0 ? 'failed' : 'defined';
    record.lastError =
      errors.length > 0
        ? new AggregateError(
            errors,
            `Cleanup failed for event component ${record.definition.id}`
          )
        : undefined;
    return errors;
  }

  private async rollback(
    activated: readonly ComponentRecord[],
    phase: 'activate' | 'replace',
    cleanupDeadline?: number
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const record of [...activated].reverse()) {
      errors.push(
        ...(await this.cleanupRecord(record, phase, cleanupDeadline))
      );
    }
    return errors;
  }

  private assertSettledForTransition(
    record: ComponentRecord,
    transition: 'activate' | 'replace'
  ): void {
    const unsettled = record.effects.filter(
      (effect) => effect.state !== 'disposed'
    );
    if (unsettled.length === 0) return;
    throw new Error(
      `Cannot ${transition} event component ${record.definition.id} while prior effect ownership is unsettled: ${unsettled.map((effect) => effect.label).join(', ')}`
    );
  }

  private assertLiveDependencies(
    definition: Readonly<AxEventComponentDefinition>
  ): void {
    for (const dependency of definition.dependencies ?? []) {
      const record = this.records.get(dependency);
      if (record?.state === 'disposed') {
        throw new Error(
          `Event component ${definition.id} cannot depend on disposed ${dependency}`
        );
      }
    }
  }

  private assertAcyclic(): void {
    const cycle = findCycle(
      new Map(
        [...this.records.entries()]
          .filter(([, record]) => record.state !== 'disposed')
          .map(([id, record]) => [id, record.definition])
      )
    );
    if (cycle) {
      throw new Error(
        `Event component dependency cycle: ${cycle.join(' -> ')}`
      );
    }
  }

  private assertReplacementAcyclic(
    definition: Readonly<AxEventComponentDefinition>
  ): void {
    const definitions = new Map(
      [...this.records.entries()]
        .filter(([, record]) => record.state !== 'disposed')
        .map(([id, record]) => [id, record.definition])
    );
    definitions.set(definition.id, definition);
    const cycle = findCycle(definitions);
    if (cycle) {
      throw new Error(
        `Event component dependency cycle: ${cycle.join(' -> ')}`
      );
    }
  }

  private addDiagnostic(
    record: ComponentRecord,
    diagnostic: AxEventComponentDiagnostic
  ): void {
    record.diagnostics.push(diagnostic);
    try {
      void Promise.resolve(
        this.options.onDiagnostic?.(diagnostic, snapshot(record))
      ).catch(() => undefined);
    } catch {
      // Diagnostics must not change lifecycle outcomes.
    }
  }
}

export function axEventComponentManager(
  options: Readonly<AxEventComponentManagerOptions> = {}
): AxEventComponentManager {
  return new AxEventComponentManager(options);
}

function normalizeDefinition<T>(
  definition: Readonly<AxEventComponentDefinition<T>>
): Readonly<AxEventComponentDefinition> {
  const id = definition.id.trim();
  const version = definition.version.trim();
  if (!id) throw new Error('Event component id must be non-empty');
  if (!version) {
    throw new Error(`Event component ${id} version must be non-empty`);
  }
  if (typeof definition.activate !== 'function') {
    throw new Error(`Event component ${id} requires an activate function`);
  }
  const sourceDependencies = (definition.dependencies ?? []).map((dependency) =>
    dependency.trim()
  );
  const dependencies = [...new Set(sourceDependencies)];
  if (dependencies.some((dependency) => !dependency)) {
    throw new Error(`Event component ${id} dependencies must be non-empty`);
  }
  if (dependencies.length !== sourceDependencies.length) {
    throw new Error(`Event component ${id} has duplicate dependencies`);
  }
  return Object.freeze({
    id,
    version,
    dependencies: Object.freeze(dependencies),
    activate: definition.activate as AxEventComponentDefinition['activate'],
  });
}

function findCycle(
  definitions: ReadonlyMap<string, Readonly<AxEventComponentDefinition>>
): string[] | undefined {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visited.has(id)) return undefined;
    const cycleStart = path.indexOf(id);
    if (visiting.has(id)) return [...path.slice(cycleStart), id];
    const definition = definitions.get(id);
    if (!definition) return undefined;
    visiting.add(id);
    path.push(id);
    for (const dependency of [...(definition.dependencies ?? [])].sort()) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of [...definitions.keys()].sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function stagedTopologicalOrder(
  records: ReadonlyMap<string, ComponentRecord>
): ComponentRecord[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: ComponentRecord[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Event component dependency cycle at ${id}`);
    }
    const record = records.get(id);
    if (!record) return;
    visiting.add(id);
    for (const dependency of [
      ...(record.definition.dependencies ?? []),
    ].sort()) {
      if (records.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(record);
  };
  for (const id of [...records.keys()].sort()) visit(id);
  return order;
}

function snapshot(
  record: ComponentRecord
): Readonly<AxEventComponentInspection> {
  return Object.freeze({
    id: record.definition.id,
    version: record.definition.version,
    dependencies: Object.freeze([...(record.definition.dependencies ?? [])]),
    state: record.state,
    effects: Object.freeze(
      record.effects.map((effect) =>
        Object.freeze({
          label: effect.label,
          state: effect.state,
          ...(effect.error !== undefined ? { error: effect.error } : {}),
        })
      )
    ),
    diagnostics: Object.freeze(
      record.diagnostics.map((value) => ({ ...value }))
    ),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
  });
}

function validateEffect(
  label: string,
  disposer: AxEventComponentDisposer
): void {
  if (!label.trim())
    throw new Error('Event component effect label is required');
  if (typeof disposer !== 'function') {
    throw new Error(`Event component effect ${label} requires a disposer`);
  }
}

function once(disposer: AxEventComponentDisposer): AxEventComponentDisposer {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= Promise.resolve().then(disposer);
    return promise;
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.cause === undefined
      ? error.message
      : `${error.message}: ${errorMessage(error.cause)}`;
  }
  return String(error);
}
