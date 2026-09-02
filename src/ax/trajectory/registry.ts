import {
  AxTrajectoryRegistryError,
  type AxTrajectoryTypeDescriptor,
  type AxTrajectoryTypeRegistry,
} from './types.js';

/**
 * The shipped registry. Every row is pinned by `registry.test.ts`, so adding a
 * type without deciding its class, wakeability and source policy fails a test
 * rather than silently defaulting.
 */
export const axDefaultTrajectoryTypes: readonly Readonly<AxTrajectoryTypeDescriptor>[] =
  Object.freeze([
    {
      type: 'trajectory',
      stepClass: 'structural',
      wakeable: false,
      carriesSource: false,
    },
    {
      type: 'fork',
      stepClass: 'structural',
      wakeable: false,
      carriesSource: false,
    },
    {
      type: 'merge',
      stepClass: 'structural',
      wakeable: true,
      wakeSignal: false,
      carriesSource: false,
      visibleWork: true,
      spillFields: ['content'],
    },
    {
      type: 'thought',
      stepClass: 'narrative',
      wakeable: true,
      wakeSignal: false,
      carriesSource: true,
      visibleWork: false,
      spillFields: ['content'],
    },
    {
      type: 'action',
      stepClass: 'narrative',
      wakeable: true,
      wakeSignal: false,
      carriesSource: true,
      visibleWork: true,
      spillFields: ['content'],
    },
    {
      type: 'observation',
      stepClass: 'narrative',
      wakeable: true,
      wakeSignal: false,
      carriesSource: true,
      visibleWork: true,
      spillFields: ['content'],
    },
    {
      type: 'idle',
      stepClass: 'narrative',
      wakeable: true,
      wakeSignal: false,
      carriesSource: true,
      visibleWork: false,
    },
    {
      type: 'message',
      stepClass: 'narrative',
      conversational: true,
      wakeable: true,
      wakeSignal: false,
      carriesSource: true,
      visibleWork: true,
      spillFields: ['content'],
    },
    {
      type: 'error',
      stepClass: 'narrative',
      wakeable: true,
      wakeSignal: false,
      carriesSource: true,
      neverRetriggersSelf: true,
      visibleWork: false,
      spillFields: ['content'],
    },
    {
      type: 'run',
      stepClass: 'machinery',
      wakeable: false,
      carriesSource: false,
      spillFields: ['command'],
    },
    {
      type: 'run-summary',
      stepClass: 'machinery',
      wakeable: false,
      carriesSource: false,
      spillFields: ['fullSummary'],
    },
    {
      type: 'runtime-output',
      stepClass: 'machinery',
      wakeable: false,
      carriesSource: false,
      spillFields: ['stdout', 'stderr'],
    },
    {
      type: 'feedback',
      stepClass: 'machinery',
      wakeable: false,
      carriesSource: false,
      spillFields: ['content'],
    },
    {
      type: 'reply-claim',
      stepClass: 'machinery',
      wakeable: false,
      carriesSource: false,
    },
    {
      type: 'mind-wake',
      stepClass: 'machinery',
      wakeable: true,
      wakeSignal: true,
      carriesSource: false,
    },
    {
      type: 'mind-idle',
      stepClass: 'machinery',
      wakeable: true,
      wakeSignal: true,
      carriesSource: false,
    },
    {
      type: 'manual-trigger',
      stepClass: 'machinery',
      wakeable: true,
      wakeSignal: true,
      carriesSource: false,
    },
    {
      type: 'mind-error',
      stepClass: 'machinery',
      wakeable: false,
      carriesSource: false,
      spillFields: ['reason'],
    },
  ] as const satisfies readonly AxTrajectoryTypeDescriptor[]);

/**
 * Open world: an unregistered type resolves to this. Conservative where it
 * matters — never wakes a thinker, never enters a projection — and permissive
 * on `carriesSource`, because rejecting a host's own narrative type at the
 * write boundary would close the open world instead of guarding it (I13 is
 * about registered machinery types masquerading as thinkers).
 */
export const axTrajectoryUnknownDescriptor: Readonly<AxTrajectoryTypeDescriptor> =
  Object.freeze({
    type: '*',
    stepClass: 'unknown',
    wakeable: false,
    carriesSource: true,
  });

export interface AxTrajectoryTypeRegistryOptions {
  /** Fires once per distinct unregistered type seen. Default: none. */
  readonly onUnknownStepType?: (type: string) => void;
}

function validate(
  entry: Readonly<AxTrajectoryTypeDescriptor>,
  shipped: Readonly<AxTrajectoryTypeDescriptor> | undefined
): void {
  if (typeof entry.type !== 'string' || entry.type.length === 0) {
    throw new AxTrajectoryRegistryError(
      'a trajectory type descriptor requires a non-empty type',
      'invalid_descriptor',
      String(entry.type)
    );
  }
  if (entry.stepClass === 'machinery' && entry.carriesSource) {
    throw new AxTrajectoryRegistryError(
      `machinery step type "${entry.type}" cannot set carriesSource; machinery must never masquerade as a thinker`,
      'protected_flag',
      entry.type
    );
  }
  if (shipped?.neverRetriggersSelf && entry.neverRetriggersSelf === false) {
    throw new AxTrajectoryRegistryError(
      `step type "${entry.type}" cannot clear neverRetriggersSelf`,
      'protected_flag',
      entry.type
    );
  }
}

/**
 * Merge host descriptors over the defaults. Redefining a shipped type's
 * `stepClass` is allowed; clearing `neverRetriggersSelf` on a protected type,
 * or setting `carriesSource` on a machinery type, is rejected.
 */
export const axTrajectoryTypeRegistry = (
  entries?: readonly Readonly<AxTrajectoryTypeDescriptor>[],
  options?: Readonly<AxTrajectoryTypeRegistryOptions>
): AxTrajectoryTypeRegistry => {
  const shipped = new Map(axDefaultTrajectoryTypes.map((d) => [d.type, d]));
  const merged = new Map(shipped);
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    if (seen.has(entry.type)) {
      throw new AxTrajectoryRegistryError(
        `duplicate trajectory type "${entry.type}" in the host registry`,
        'duplicate_type',
        entry.type
      );
    }
    seen.add(entry.type);
    validate(entry, shipped.get(entry.type));
    merged.set(entry.type, Object.freeze({ ...entry }));
  }
  const types = Object.freeze([...merged.values()]);
  const reported = new Set<string>();
  return {
    describe(type: string): Readonly<AxTrajectoryTypeDescriptor> {
      const found = merged.get(type);
      if (found) return found;
      if (!reported.has(type)) {
        reported.add(type);
        options?.onUnknownStepType?.(type);
      }
      return Object.freeze({ ...axTrajectoryUnknownDescriptor, type });
    },
    has: (type: string): boolean => merged.has(type),
    types,
  };
};
