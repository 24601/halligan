import { AxEventComponentManager } from '../src/ax/event/components.js';

type FaultResult = {
  manual: Record<string, boolean | number>;
  managed: Record<string, boolean | number>;
};

const iterations = parseIterations(process.argv.slice(2));
const representative = {
  activationFailure: await activationFailure(),
  replacementFailure: await replacementFailure(),
  dependencyCycle: await dependencyCycle(),
  abort: await abortDuringActivation(),
  concurrentTransitions: await concurrentTransitions(),
  disposalError: await disposalError(),
  unmanagedEffect: await unmanagedEffect(),
};

const results = {
  kind: 'deterministic lifecycle fault/stress evaluation',
  iterations,
  ...representative,
  faultStress: await faultStress(iterations),
  transitionTiming: await transitionTiming(iterations),
  nonGuarantees: [
    'Unregistered effects are invisible and cannot be reversed or diagnosed.',
    'Disposers are compensating cleanup, not rollback of arbitrary external I/O.',
    'Abort is cooperative; activation code that ignores its signal can delay the serialized transition queue.',
    'Replacement is atomic only for the manager-visible binding; candidate setup effects must be staged by the host when external visibility matters.',
    'Timing is descriptive process-local overhead, not a stable performance threshold.',
  ],
};

assertManagedResults(results);
console.log(JSON.stringify(results, null, 2));

async function activationFailure(): Promise<FaultResult> {
  let manualResources = 0;
  const manualOrder: string[] = [];
  try {
    manualResources++;
    const first = () => {
      manualResources--;
      manualOrder.push('first');
    };
    manualResources++;
    const second = () => {
      manualResources--;
      manualOrder.push('second');
    };
    void first;
    void second;
    throw new Error('activation fault');
  } catch {
    // The manual baseline forgot transaction rollback.
  }

  let managedResources = 0;
  const managedOrder: string[] = [];
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'activation-fault',
    version: '1',
    activate: (context) => {
      managedResources++;
      context.addDisposer('first', () => {
        managedResources--;
        managedOrder.push('first');
      });
      managedResources++;
      context.addDisposer('second', () => {
        managedResources--;
        managedOrder.push('second');
      });
      throw new Error('activation fault');
    },
  });
  await manager.activate().catch(() => undefined);

  return {
    manual: {
      leakedResources: manualResources,
      reverseRollback: manualOrder.join(',') === 'second,first',
    },
    managed: {
      leakedResources: managedResources,
      reverseRollback: managedOrder.join(',') === 'second,first',
    },
  };
}

async function replacementFailure(): Promise<FaultResult> {
  let manualResources = 2;
  let manualProvider: string | undefined = 'v1';
  let manualConsumer: string | undefined = 'v1';
  manualResources -= 2;
  manualProvider = undefined;
  manualConsumer = undefined;
  try {
    manualResources += 2;
    throw new Error('candidate fault');
  } catch {
    // The manual baseline removed the old graph before proving the new graph.
  }

  let managedResources = 0;
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'replaceable',
    version: '1',
    activate: (context) => {
      managedResources++;
      context.addDisposer('v1', () => {
        managedResources--;
      });
      return 'v1';
    },
  });
  await manager.define({
    id: 'replacement-consumer',
    version: '1',
    dependencies: ['replaceable'],
    activate: (context) => {
      const provider = context.dependency<string>('replaceable');
      managedResources++;
      context.addDisposer(`consumer-${provider}`, () => {
        managedResources--;
      });
      if (provider === 'v2') throw new Error('dependent candidate fault');
      return provider;
    },
  });
  await manager.activate();
  await manager
    .replace({
      id: 'replaceable',
      version: '2',
      activate: (context) => {
        managedResources++;
        context.addDisposer('v2', () => {
          managedResources--;
        });
        return 'v2';
      },
    })
    .catch(() => undefined);
  const managedProvider = manager.get<string>('replaceable');
  const managedConsumer = manager.get<string>('replacement-consumer');
  const managedLeak = managedResources - 2;
  await manager.dispose();

  return {
    manual: {
      leakedResources: manualResources,
      priorStateRestored: manualProvider === 'v1' && manualConsumer === 'v1',
    },
    managed: {
      leakedResources: managedLeak,
      priorStateRestored: managedProvider === 'v1' && managedConsumer === 'v1',
    },
  };
}

async function dependencyCycle(): Promise<FaultResult> {
  let manualActivations = 0;
  const manualVisit = (id: 'a' | 'b', depth: number): void => {
    if (depth > 1) throw new Error('manual recursion guard');
    manualActivations++;
    manualVisit(id === 'a' ? 'b' : 'a', depth + 1);
  };
  try {
    manualVisit('a', 0);
  } catch {
    // An ad-hoc depth guard observed the cycle only after work began.
  }

  let managedActivations = 0;
  let rejected = false;
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'a',
    version: '1',
    dependencies: ['b'],
    activate: () => {
      managedActivations++;
    },
  });
  await manager
    .define({
      id: 'b',
      version: '1',
      dependencies: ['a'],
      activate: () => {
        managedActivations++;
      },
    })
    .catch(() => {
      rejected = true;
    });

  return {
    manual: {
      activationsBeforeRejection: manualActivations,
      rejectedBeforeActivation: false,
    },
    managed: {
      activationsBeforeRejection: managedActivations,
      rejectedBeforeActivation: rejected,
    },
  };
}

async function abortDuringActivation(): Promise<FaultResult> {
  let manualResources = 0;
  const manualController = new AbortController();
  const manual = (async () => {
    manualResources++;
    await waitForAbort(manualController.signal);
  })().catch(() => undefined);
  manualController.abort(new Error('abort fault'));
  await manual;

  let managedResources = 0;
  const managedController = new AbortController();
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'abortable',
    version: '1',
    activate: async (context) => {
      managedResources++;
      context.addDisposer('resource', () => {
        managedResources--;
      });
      await waitForAbort(context.signal);
    },
  });
  const managed = manager
    .activate(undefined, { signal: managedController.signal })
    .catch(() => undefined);
  await Promise.resolve();
  managedController.abort(new Error('abort fault'));
  await managed;

  return {
    manual: { leakedResources: manualResources, abortObserved: true },
    managed: {
      leakedResources: managedResources,
      abortObserved: manager.inspect('abortable')?.state === 'failed',
    },
  };
}

async function concurrentTransitions(): Promise<FaultResult> {
  const manualOrder: string[] = [];
  let manualActive = false;
  let releaseManual!: () => void;
  const manualGate = new Promise<void>((resolve) => {
    releaseManual = resolve;
  });
  const manualActivation = (async () => {
    manualOrder.push('activate:start');
    await manualGate;
    manualActive = true;
    manualOrder.push('activate:end');
  })();
  const manualDeactivation = (async () => {
    manualOrder.push('deactivate');
    manualActive = false;
  })();
  releaseManual();
  await Promise.all([manualActivation, manualDeactivation]);

  const managedOrder: string[] = [];
  let releaseManaged!: () => void;
  const managedGate = new Promise<void>((resolve) => {
    releaseManaged = resolve;
  });
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'serialized',
    version: '1',
    activate: async (context) => {
      managedOrder.push('activate:start');
      await managedGate;
      context.addDisposer('component', () => managedOrder.push('deactivate'));
      managedOrder.push('activate:end');
    },
  });
  const managedActivation = manager.activate();
  const managedDeactivation = manager.deactivate();
  await Promise.resolve();
  releaseManaged();
  await Promise.all([managedActivation, managedDeactivation]);

  return {
    manual: {
      orderingCorrect:
        manualOrder.join(',') === 'activate:start,activate:end,deactivate',
      finalInactive: !manualActive,
    },
    managed: {
      orderingCorrect:
        managedOrder.join(',') === 'activate:start,activate:end,deactivate',
      finalInactive: manager.inspect('serialized')?.state === 'defined',
    },
  };
}

async function disposalError(): Promise<FaultResult> {
  let manualResources = 3;
  let manualContinued = false;
  const manualDisposers = [
    () => {
      manualResources--;
      manualContinued = true;
    },
    () => {
      throw new Error('dispose fault');
    },
    () => {
      manualResources--;
    },
  ];
  try {
    for (const dispose of [...manualDisposers].reverse()) dispose();
  } catch {
    // The manual loop stopped at the first disposer failure.
  }

  let managedResources = 0;
  let managedContinued = false;
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'fallible-cleanup',
    version: '1',
    activate: (context) => {
      managedResources++;
      context.addDisposer('continued', () => {
        managedResources--;
        managedContinued = true;
      });
      managedResources++;
      context.addDisposer('failing', () => {
        throw new Error('dispose fault');
      });
      managedResources++;
      context.addDisposer('first', () => {
        managedResources--;
      });
    },
  });
  await manager.activate();
  await manager.deactivate().catch(() => undefined);

  return {
    manual: {
      leakedResources: manualResources,
      continuedAfterError: manualContinued,
    },
    managed: {
      leakedResources: managedResources,
      continuedAfterError: managedContinued,
    },
  };
}

async function unmanagedEffect(): Promise<FaultResult> {
  let manualResources = 0;
  try {
    manualResources++;
    throw new Error('unmanaged fault');
  } catch {
    // No disposer exists.
  }

  let managedResources = 0;
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'unregistered',
    version: '1',
    activate: () => {
      managedResources++;
      throw new Error('unmanaged fault');
    },
  });
  await manager.activate().catch(() => undefined);

  return {
    manual: { leakedResources: manualResources, reversible: false },
    managed: { leakedResources: managedResources, reversible: false },
  };
}

async function faultStress(count: number): Promise<{
  runsPerScenario: number;
  totalRuns: number;
  managedInvariantFailures: number;
  manualFaultsObserved: number;
  totalMs: number;
  meanScenarioMs: number;
}> {
  const scenarios = [
    ['activationFailure', activationFailure],
    ['replacementFailure', replacementFailure],
    ['dependencyCycle', dependencyCycle],
    ['abort', abortDuringActivation],
    ['concurrentTransitions', concurrentTransitions],
    ['disposalError', disposalError],
    ['unmanagedEffect', unmanagedEffect],
  ] as const;
  let managedInvariantFailures = 0;
  let manualFaultsObserved = 0;
  const startedAt = performance.now();
  for (let iteration = 0; iteration < count; iteration++) {
    for (const [name, scenario] of scenarios) {
      const result = await scenario();
      if (!managedFaultPassed(name, result)) managedInvariantFailures++;
      if (manualFaultObserved(name, result)) manualFaultsObserved++;
    }
  }
  const totalMs = performance.now() - startedAt;
  const totalRuns = count * scenarios.length;
  return {
    runsPerScenario: count,
    totalRuns,
    managedInvariantFailures,
    manualFaultsObserved,
    totalMs: round(totalMs),
    meanScenarioMs: round(totalMs / totalRuns),
  };
}

async function transitionTiming(count: number): Promise<{
  manual: { meanMs: number; p95Ms: number };
  managed: { meanMs: number; p95Ms: number };
  meanOverheadMs: number;
  overheadRatio: number;
}> {
  const manual: number[] = [];
  const managed: number[] = [];
  for (let index = 0; index < count; index++) {
    let dispose = () => undefined;
    let start = performance.now();
    dispose = () => undefined;
    dispose();
    manual.push(performance.now() - start);

    const manager = new AxEventComponentManager();
    start = performance.now();
    await manager.define({
      id: `timed-${index}`,
      version: '1',
      activate: (context) => context.addDisposer('timed', () => undefined),
    });
    await manager.activate();
    await manager.deactivate();
    managed.push(performance.now() - start);
  }
  const manualMean = mean(manual);
  const managedMean = mean(managed);
  return {
    manual: {
      meanMs: round(manualMean),
      p95Ms: round(percentile(manual, 0.95)),
    },
    managed: {
      meanMs: round(managedMean),
      p95Ms: round(percentile(managed, 0.95)),
    },
    meanOverheadMs: round(managedMean - manualMean),
    overheadRatio: round(managedMean / Math.max(manualMean, 0.000_001)),
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

function parseIterations(args: readonly string[]): number {
  const raw = args
    .find((arg) => arg.startsWith('--iterations='))
    ?.split('=')[1];
  const parsed = raw === undefined ? 200 : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error('--iterations must be an integer from 1 through 10000');
  }
  return parsed;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * value))
  ]!;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function managedFaultPassed(name: string, result: FaultResult): boolean {
  switch (name) {
    case 'activationFailure':
      return (
        result.managed.leakedResources === 0 &&
        result.managed.reverseRollback === true
      );
    case 'replacementFailure':
      return (
        result.managed.leakedResources === 0 &&
        result.managed.priorStateRestored === true
      );
    case 'dependencyCycle':
      return (
        result.managed.activationsBeforeRejection === 0 &&
        result.managed.rejectedBeforeActivation === true
      );
    case 'abort':
      return (
        result.managed.leakedResources === 0 &&
        result.managed.abortObserved === true
      );
    case 'concurrentTransitions':
      return (
        result.managed.orderingCorrect === true &&
        result.managed.finalInactive === true
      );
    case 'disposalError':
      return (
        result.managed.leakedResources === 1 &&
        result.managed.continuedAfterError === true
      );
    case 'unmanagedEffect':
      return (
        result.managed.leakedResources === 1 &&
        result.managed.reversible === false
      );
    default:
      return false;
  }
}

function manualFaultObserved(name: string, result: FaultResult): boolean {
  if (name === 'unmanagedEffect') {
    return (
      result.manual.leakedResources === 1 && result.manual.reversible === false
    );
  }
  return Object.values(result.manual).some(
    (value) => value === false || (typeof value === 'number' && value > 0)
  );
}

function assertManagedResults(result: typeof results): void {
  const failures = [
    result.activationFailure.managed.leakedResources !== 0,
    result.activationFailure.managed.reverseRollback !== true,
    result.replacementFailure.managed.leakedResources !== 0,
    result.replacementFailure.managed.priorStateRestored !== true,
    result.dependencyCycle.managed.activationsBeforeRejection !== 0,
    result.dependencyCycle.managed.rejectedBeforeActivation !== true,
    result.abort.managed.leakedResources !== 0,
    result.concurrentTransitions.managed.orderingCorrect !== true,
    result.concurrentTransitions.managed.finalInactive !== true,
    result.disposalError.managed.continuedAfterError !== true,
    result.unmanagedEffect.managed.leakedResources !== 1,
    result.faultStress.managedInvariantFailures !== 0,
  ];
  if (failures.some(Boolean)) {
    throw new Error('Managed lifecycle evaluation invariant failed');
  }
}
