import {
  AxTrajectoryRegistryError,
  type AxTrajectoryStepClass,
  type AxTrajectoryTypeDescriptor,
  type AxTrajectoryTypeRegistry,
} from './types.js';

/**
 * Descriptor builder. Defaults are the conservative ones: not wakeable, and
 * no writer identity. Every row below therefore states only what it grants.
 */
const d = (
  type: string,
  stepClass: AxTrajectoryStepClass,
  extra: Partial<Readonly<AxTrajectoryTypeDescriptor>> = {}
): Readonly<AxTrajectoryTypeDescriptor> =>
  Object.freeze({
    wakeable: false,
    carriesSource: false,
    ...extra,
    type,
    stepClass,
  });

const narrative = { wakeSignal: false, carriesSource: true } as const;
const wakeSignal = { wakeable: true, wakeSignal: true } as const;

/**
 * The shipped registry. Every row is pinned by `registry.test.ts`, so adding a
 * type without deciding its class, wakeability and source policy fails a test
 * rather than silently defaulting. There is deliberately no dropped-step type:
 * nothing is ever dropped, so nothing needs a name for it.
 */
export const axDefaultTrajectoryTypes: readonly Readonly<AxTrajectoryTypeDescriptor>[] =
  Object.freeze([
    d('trajectory', 'structural'),
    d('fork', 'structural'),
    d('merge', 'structural', {
      wakeable: true,
      wakeSignal: false,
      visibleWork: true,
      spillFields: ['content'],
    }),
    d('thought', 'narrative', {
      ...narrative,
      wakeable: true,
      visibleWork: false,
      spillFields: ['content'],
    }),
    d('action', 'narrative', {
      ...narrative,
      wakeable: true,
      visibleWork: true,
      spillFields: ['content'],
    }),
    d('observation', 'narrative', {
      ...narrative,
      wakeable: true,
      visibleWork: true,
      spillFields: ['content'],
    }),
    d('idle', 'narrative', {
      ...narrative,
      wakeable: true,
      visibleWork: false,
    }),
    d('message', 'narrative', {
      ...narrative,
      wakeable: true,
      conversational: true,
      visibleWork: true,
      spillFields: ['content'],
    }),
    d('error', 'narrative', {
      ...narrative,
      wakeable: true,
      neverRetriggersSelf: true,
      visibleWork: false,
      spillFields: ['content'],
    }),
    d('run', 'machinery', { spillFields: ['command'] }),
    d('run-summary', 'machinery', { spillFields: ['fullSummary'] }),
    d('runtime-output', 'machinery', { spillFields: ['stdout', 'stderr'] }),
    d('feedback', 'machinery', { spillFields: ['content'] }),
    d('reply-claim', 'machinery'),
    d('mind-wake', 'machinery', wakeSignal),
    d('mind-idle', 'machinery', wakeSignal),
    d('manual-trigger', 'machinery', wakeSignal),
    d('mind-error', 'machinery', { spillFields: ['reason'] }),
  ]);

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
