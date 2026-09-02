import type {
  AxEventIngress,
  AxEventRoute,
  AxEventScalar,
  AxEventTarget,
} from '../event/types.js';
import type {
  AxTrajectoryStep,
  AxTrajectoryTypeRegistry,
} from '../trajectory/types.js';
import type { AxMindSubscription, AxMindThinker } from './types.js';
import { AxMindConfigurationError } from './types.js';

/**
 * The four event types the mind publishes. A trajectory step never carries its
 * own content across the plane: the envelope holds step IDENTITY and
 * CLASSIFICATION only, which keeps every event far inside `maxEventBytes` and
 * leaves the store as the single place content lives.
 */
export const axMindEventTypes = Object.freeze({
  step: 'ax.trajectory.step',
  wake: 'ax.mind.wake',
  idle: 'ax.mind.idle',
  bootstrap: 'ax.mind.bootstrap',
} as const);

/** Every mind source publishes under one logical producer identity. */
export const axMindEventSource = (mindId: string): string =>
  `ax://mind/${mindId}`;

/** The subject a pace/idle/bootstrap event carries, so it reaches one thinker. */
export const axMindThinkerSubject = (thinker: string): string =>
  `mind:${thinker}`;

/**
 * Extension attributes are matched by EXACT EQUALITY (`axEventMatches`), which
 * is why positive selection lives here and negative suppression has to be an
 * `authorize` predicate instead.
 */
export function axMindStepEventExtensions(
  step: Readonly<AxTrajectoryStep>
): Readonly<Record<string, AxEventScalar>> {
  return Object.freeze({
    steptype: step.type,
    stepseq: step.seq,
    ...(step.source !== undefined ? { stepsource: step.source } : {}),
    ...(step.launchedBy !== undefined ? { stepthinker: step.launchedBy } : {}),
  });
}

function extension(
  ingress: Readonly<AxEventIngress>,
  name: string
): string | undefined {
  const value = ingress.event.extensions?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Derived, not configured: a pure wake signal coalesces last-wins, and
 * everything that carries a distinct payload queues. A host that wants
 * different behaviour edits the registry entry -- the same fact stated once.
 */
export function axMindPendingClass(
  stepType: string,
  registry: AxTrajectoryTypeRegistry
): 'queue' | 'coalesce' {
  return registry.describe(stepType).wakeSignal === true ? 'coalesce' : 'queue';
}

/**
 * The step types one subscription actually wakes on. An absent `types` and an
 * absent `classes` mean every wakeable NARRATIVE type: machinery is opt-in, so
 * a thinker is never woken by the mind's own bookkeeping by default.
 */
export function axMindSubscribedStepTypes(
  subscription: Readonly<AxMindSubscription>,
  registry: AxTrajectoryTypeRegistry
): readonly string[] {
  const selected = new Set<string>();
  if (subscription.types) {
    for (const type of subscription.types) {
      if (registry.describe(type).wakeable) selected.add(type);
    }
  }
  if (subscription.classes) {
    const classes = new Set(subscription.classes);
    for (const descriptor of registry.types) {
      if (descriptor.wakeable && classes.has(descriptor.stepClass)) {
        selected.add(descriptor.type);
      }
    }
  }
  if (!subscription.types && !subscription.classes) {
    for (const descriptor of registry.types) {
      if (descriptor.wakeable && descriptor.stepClass === 'narrative') {
        selected.add(descriptor.type);
      }
    }
  }
  return Object.freeze([...selected].sort());
}

export interface AxMindWakeRouteOptions {
  readonly registry: AxTrajectoryTypeRegistry;
  /** The CloudEvents `source` every mind source publishes under. */
  readonly sourceId: string;
  /** Tick resolution; the debounce window a coalescing route uses. */
  readonly tickMs: number;
  /**
   * Which pending class this route carries. Derived per step type by
   * `axMindPendingClass`, so a thinker subscribed to both classes needs one
   * route each -- `axMindEventRoutes` builds both.
   */
  readonly pending?: 'queue' | 'coalesce';
  readonly routeId?: string;
}

/**
 * Self-trigger suppression is BY THE STEP'S WRITER IDENTITY, not by process
 * identity. `routeMatches` creates no delivery at all when `authorize` returns
 * false, so a suppressed step never reaches a model -- and an external writer
 * of the very same type (`source: 'chat'`) still wakes the thinker.
 */
function suppression(
  thinker: Readonly<AxMindThinker>,
  registry: AxTrajectoryTypeRegistry
): (ingress: Readonly<AxEventIngress>) => boolean {
  return (ingress) => {
    const source = extension(ingress, 'stepsource');
    const launchedBy = extension(ingress, 'stepthinker');
    const mine = source === thinker.name || launchedBy === thinker.name;
    if (!mine) return true;
    const type = extension(ingress, 'steptype') ?? ingress.event.subject ?? '';
    // M3: a thinker never re-triggers on its own error step, even under
    // triggerSelf. The registry owns that flag and the builder cannot override
    // it, which is what stops the error loop.
    if (registry.describe(type).neverRetriggersSelf === true) return false;
    return thinker.subscription.triggerSelf;
  };
}

/**
 * One thinker's wake route: subject matcher from the subscription, suppression
 * as an `authorize` predicate, `instanceKey = thinker` so one run happens at a
 * time, and the pending class derived from the registry.
 */
export function axMindWakeRoute(
  thinker: Readonly<AxMindThinker>,
  target: AxEventTarget<any, any>,
  options: Readonly<AxMindWakeRouteOptions>
): AxEventRoute {
  const pending = options.pending ?? 'queue';
  const subscribed = axMindSubscribedStepTypes(
    thinker.subscription,
    options.registry
  ).filter((type) => axMindPendingClass(type, options.registry) === pending);
  const coalescing = pending === 'coalesce';
  const subjects = coalescing
    ? [...subscribed, axMindThinkerSubject(thinker.name)]
    : subscribed;
  const types = coalescing
    ? [
        axMindEventTypes.step,
        axMindEventTypes.wake,
        axMindEventTypes.idle,
        axMindEventTypes.bootstrap,
      ]
    : [axMindEventTypes.step];
  return {
    id:
      options.routeId ??
      `mind.wake.${thinker.name}${coalescing ? '.signals' : ''}`,
    match: {
      sources: [options.sourceId],
      types,
      subjects,
    },
    action: 'wake',
    target,
    instanceKey: () => thinker.name,
    authorize: suppression(thinker, options.registry),
    ordering: 'strict',
    // validateEventRoute rejects `coalesce` without `debounceMs`, so the
    // builder always sets both -- never one without the other.
    ...(coalescing
      ? { debounceMs: Math.max(1, options.tickMs), coalesce: 'latest' as const }
      : {}),
  };
}

export interface AxMindEventRoutesOptions {
  readonly mindId: string;
  readonly thinkers: readonly Readonly<AxMindThinker>[];
  readonly targets: Readonly<Record<string, AxEventTarget<any, any>>>;
  readonly registry: AxTrajectoryTypeRegistry;
  readonly sourceId: string;
  readonly tickMs: number;
}

/** The mind's complete, inspectable route table. */
export function axMindEventRoutes(
  options: Readonly<AxMindEventRoutesOptions>
): readonly AxEventRoute[] {
  const routes: AxEventRoute[] = [];
  for (const thinker of options.thinkers) {
    const target = options.targets[thinker.name];
    if (!target) {
      // A configuration failure carries a `reason` from the closed union
      // (RFC 7.10 step 1); dropping to an untyped throw would make it
      // unclassifiable at the host boundary.
      throw new AxMindConfigurationError(
        `AxMind thinker ${thinker.name} has no event target; a wake route without a target cannot start`,
        'missing_target'
      );
    }
    for (const pending of ['queue', 'coalesce'] as const) {
      const route = axMindWakeRoute(thinker, target, {
        registry: options.registry,
        sourceId: options.sourceId,
        tickMs: options.tickMs,
        pending,
        routeId: `${options.mindId}.wake.${thinker.name}${
          pending === 'coalesce' ? '.signals' : ''
        }`,
      });
      const matcher = route.match as { subjects?: readonly string[] };
      // A route with no subject can never match; emitting it would put an
      // inert row in a table an operator reads to understand the mind.
      if (matcher.subjects?.length) routes.push(route);
    }
  }
  return Object.freeze(routes);
}
