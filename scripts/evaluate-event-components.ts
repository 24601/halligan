import { AxEventComponentManager } from '../src/ax/event/components.js';
import { AxEventRuntime } from '../src/ax/event/runtime.js';

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
  kind: 'deterministic lifecycle mechanism demonstration and adversarial boundary matrix',
  iterations,
  interpretation:
    'The manual baseline is intentionally unmanaged and not semantics-equivalent; its purpose is to expose the mechanism each registered manager case adds, not to claim superiority over correct handwritten transactions.',
  ...representative,
  adversarialBoundaries: await adversarialBoundaryMatrix(),
  mechanismRepetitions: await mechanismRepetitions(iterations),
  transitionTiming: await transitionTiming(iterations),
  nonGuarantees: [
    'Unregistered effects are invisible and cannot be reversed or diagnosed.',
    'Disposers are compensating cleanup, not rollback of arbitrary external I/O.',
    'Abort is cooperative; activation code that ignores its signal can delay the serialized transition queue.',
    'Replacement is atomic only for the manager-visible binding; candidate setup effects must be staged by the host when external visibility matters.',
    'Repeated deterministic cases are not schedule exploration, fuzzing, or model checking.',
    'Timing compares a minimal manual call pair with a full manager define/activate/deactivate cycle; it is descriptive overhead, not a semantics-equivalent benchmark or stable performance threshold.',
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

async function adversarialBoundaryMatrix() {
  return {
    runtimeStartCloseOverlap: await runtimeStartCloseOverlapBoundary(),
    lateTeardownRegistration: await lateTeardownRegistrationBoundary(),
    uncertainEffectOwnership: await uncertainEffectOwnershipBoundary(),
    inactiveReplacement: await inactiveReplacementBoundary(),
    partialDisposal: await partialDisposalBoundary(),
    dependencySnapshot: await dependencySnapshotBoundary(),
    abortBoundaries: await abortBoundaryMatrix(),
    sourceHandleAndFailureBoundaries: await sourceHandleAndFailureBoundaries(),
  };
}

async function runtimeStartCloseOverlapBoundary() {
  const startupGate = deferred();
  const firstStarted = deferred();
  const lifecycle: string[] = [];
  let liveSources = 0;
  const runtime = new AxEventRuntime({
    routes: [],
    sources: [
      {
        id: 'boundary-first',
        start: async ({ signal }) => {
          lifecycle.push('first:start');
          firstStarted.resolve();
          await startupGate.promise;
          liveSources++;
          return {
            close: () => {
              if (!signal.aborted)
                throw new Error('source signal was not aborted');
              liveSources--;
              lifecycle.push('first:close');
            },
          };
        },
      },
      {
        id: 'boundary-second',
        start: () => {
          liveSources++;
          lifecycle.push('second:start');
          return {
            close: () => {
              liveSources--;
              lifecycle.push('second:close');
            },
          };
        },
      },
    ],
  });
  const starting = runtime.start();
  await firstStarted.promise;
  const closing = runtime.close({ drain: false });
  startupGate.resolve();
  const [startResult, closeResult] = await Promise.allSettled([
    starting,
    closing,
  ]);
  return {
    startRejected: startResult.status === 'rejected',
    closeFulfilled: closeResult.status === 'fulfilled',
    noLaterSourceStarted: !lifecycle.includes('second:start'),
    lateHandleClosed: lifecycle.join(',') === 'first:start,first:close',
    liveSources,
  };
}

async function lateTeardownRegistrationBoundary() {
  let activations = 0;
  let teardownOpen = false;
  let queuedActivationOverlapped = false;
  let lateDisposerInvocations = 0;
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'boundary-late-registration',
    version: '1',
    activate: (context) => {
      activations++;
      queuedActivationOverlapped ||= teardownOpen;
      context.addDisposer('registered', () => {
        teardownOpen = true;
        try {
          context.addDisposer('late', async () => {
            lateDisposerInvocations++;
          });
        } finally {
          teardownOpen = false;
        }
      });
    },
  });
  await manager.activate();
  const [deactivation, reactivation] = await Promise.allSettled([
    manager.deactivate(),
    manager.activate(),
  ]);
  return {
    deactivationRejected: deactivation.status === 'rejected',
    queuedActivationRejected: reactivation.status === 'rejected',
    activationCount: activations,
    queuedActivationOverlapped,
    lateDisposerInvocations,
    lateRegistrationDiagnosed:
      manager
        .inspect('boundary-late-registration')
        ?.diagnostics.some(({ code }) => code === 'late-disposer') ?? false,
  };
}

async function uncertainEffectOwnershipBoundary() {
  const run = async (failureMode: 'throwing' | 'timed-out') => {
    let acquisitions = 0;
    let disposerAttempts = 0;
    let replacementActivations = 0;
    let activeReplacementSetups = 0;
    const manager = new AxEventComponentManager();
    await manager.define({
      id: `boundary-${failureMode}-ownership`,
      version: '1',
      activate: (context) =>
        context.acquire('socket', () => {
          acquisitions++;
          return {
            value: acquisitions,
            dispose: () => {
              disposerAttempts++;
              if (failureMode === 'throwing') {
                throw new Error('socket close failed');
              }
              return new Promise<void>(() => undefined);
            },
          };
        }),
    });
    await manager.activate();
    await manager
      .dispose(undefined, failureMode === 'timed-out' ? { timeoutMs: 5 } : {})
      .catch(() => undefined);
    const failedBeforeTransitions = manager.inspect()[0];
    const [activation, replacement] = await Promise.allSettled([
      manager.activate(),
      manager.replace({
        id: `boundary-${failureMode}-ownership`,
        version: '2',
        activate: () => {
          replacementActivations++;
        },
      }),
    ]);
    await manager.define({
      id: `boundary-${failureMode}-target`,
      version: '1',
      activate: () => 'v1',
    });
    await manager.activate(`boundary-${failureMode}-target`);
    const activeReplacement = await manager
      .replace({
        id: `boundary-${failureMode}-target`,
        version: '2',
        dependencies: [`boundary-${failureMode}-ownership`],
        activate: () => {
          activeReplacementSetups++;
          return 'v2';
        },
      })
      .then(
        () => 'fulfilled' as const,
        () => 'rejected' as const
      );
    const failedAfterTransitions = manager.inspect()[0];
    const targetAfterReplacement = manager.inspect(
      `boundary-${failureMode}-target`
    );
    return {
      activationRejected: activation.status === 'rejected',
      replacementRejected: replacement.status === 'rejected',
      activeDependencyReplacementRejected: activeReplacement === 'rejected',
      noSecondAcquisition: acquisitions === 1,
      disposerInvokedOnce: disposerAttempts === 1,
      replacementNotActivated: replacementActivations === 0,
      activeReplacementNotSetUp: activeReplacementSetups === 0,
      priorActiveTargetPreserved:
        targetAfterReplacement?.state === 'active' &&
        targetAfterReplacement.version === '1' &&
        targetAfterReplacement.dependencies.length === 0 &&
        manager.get(`boundary-${failureMode}-target`) === 'v1',
      failedEvidencePreserved:
        failedBeforeTransitions?.state === 'failed' &&
        failedBeforeTransitions.effects[0]?.state === 'failed' &&
        failedAfterTransitions?.state === 'failed' &&
        failedAfterTransitions.version === '1' &&
        failedAfterTransitions.effects[0]?.state === 'failed',
    };
  };

  return {
    throwing: await run('throwing'),
    timedOut: await run('timed-out'),
  };
}

async function inactiveReplacementBoundary() {
  let definedCandidateActivations = 0;
  const defined = new AxEventComponentManager();
  await defined.define({
    id: 'boundary-defined',
    version: '1',
    activate: () => 'v1',
  });
  await defined.replace({
    id: 'boundary-defined',
    version: '2',
    activate: () => {
      definedCandidateActivations++;
      return 'v2';
    },
  });

  let failedCandidateActivations = 0;
  const failed = new AxEventComponentManager();
  await failed.define({
    id: 'boundary-failed',
    version: '1',
    activate: () => {
      throw new Error('expected activation failure');
    },
  });
  await failed.activate().catch(() => undefined);
  await failed.replace({
    id: 'boundary-failed',
    version: '2',
    activate: () => {
      failedCandidateActivations++;
      return 'v2';
    },
  });

  return {
    definedCandidateActivations,
    definedReplacementState:
      defined.inspect('boundary-defined')?.state === 'defined',
    failedCandidateActivations,
    failedReplacementState:
      failed.inspect('boundary-failed')?.state === 'defined',
  };
}

async function partialDisposalBoundary() {
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'boundary-provider',
    version: '1',
    activate: (context) => context.addDisposer('provider', () => undefined),
  });
  await manager.define({
    id: 'boundary-child',
    version: '1',
    dependencies: ['boundary-provider'],
    activate: (context) => context.addDisposer('child', () => undefined),
  });
  await manager.define({
    id: 'boundary-inactive-grandchild',
    version: '1',
    dependencies: ['boundary-child'],
    activate: () => undefined,
  });
  await manager.activate('boundary-child');
  await manager.dispose('boundary-provider');
  let reactivationRejected = false;
  await manager.activate('boundary-child').catch(() => {
    reactivationRejected = true;
  });
  return {
    providerDisposed:
      manager.inspect('boundary-provider')?.state === 'disposed',
    activeChildDisposed:
      manager.inspect('boundary-child')?.state === 'disposed',
    inactiveGrandchildDisposed:
      manager.inspect('boundary-inactive-grandchild')?.state === 'disposed',
    reactivationRejected,
  };
}

async function dependencySnapshotBoundary() {
  const cleanupSnapshots: string[] = [];
  const manager = new AxEventComponentManager();
  await manager.define({
    id: 'boundary-snapshot-provider',
    version: '1',
    activate: () => 'v1',
  });
  await manager.define({
    id: 'boundary-snapshot-consumer',
    version: '1',
    dependencies: ['boundary-snapshot-provider'],
    activate: (context) => {
      const provider = context.dependency<string>('boundary-snapshot-provider');
      context.addDisposer('consumer', () => {
        cleanupSnapshots.push(
          context.dependency<string>('boundary-snapshot-provider')
        );
      });
      return provider;
    },
  });
  await manager.activate();
  await manager.replace({
    id: 'boundary-snapshot-provider',
    version: '2',
    activate: () => 'v2',
  });
  const newProvider = manager.get<string>('boundary-snapshot-provider');
  const newConsumer = manager.get<string>('boundary-snapshot-consumer');
  await manager.dispose();
  return {
    retiredCleanupSawPriorDependency: cleanupSnapshots[0] === 'v1',
    stagedConsumerSawCandidate: newProvider === 'v2' && newConsumer === 'v2',
  };
}

async function abortBoundaryMatrix() {
  let preActivationCalls = 0;
  const before = new AxEventComponentManager();
  await before.define({
    id: 'abort-before',
    version: '1',
    activate: () => {
      preActivationCalls++;
    },
  });
  const beforeController = new AbortController();
  beforeController.abort(new Error('before activation'));
  await before
    .activate(undefined, { signal: beforeController.signal })
    .catch(() => undefined);

  let duringResources = 0;
  const duringStarted = deferred();
  const during = new AxEventComponentManager();
  await during.define({
    id: 'abort-during',
    version: '1',
    activate: async (context) => {
      duringResources++;
      context.addDisposer('during', () => {
        duringResources--;
      });
      duringStarted.resolve();
      await waitForAbort(context.signal);
    },
  });
  const duringController = new AbortController();
  const duringActivation = during
    .activate(undefined, { signal: duringController.signal })
    .catch(() => undefined);
  await duringStarted.promise;
  duringController.abort(new Error('during activation'));
  await duringActivation;

  let acquiredResources = 0;
  const acquired = deferred();
  const releaseAfterAcquire = deferred();
  const afterAcquire = new AxEventComponentManager();
  await afterAcquire.define({
    id: 'abort-after-acquire',
    version: '1',
    activate: async (context) => {
      await context.acquire('after-acquire', () => {
        acquiredResources++;
        return {
          value: undefined,
          dispose: () => {
            acquiredResources--;
          },
        };
      });
      acquired.resolve();
      await releaseAfterAcquire.promise;
    },
  });
  const afterAcquireController = new AbortController();
  const afterAcquireActivation = afterAcquire
    .activate(undefined, { signal: afterAcquireController.signal })
    .catch(() => undefined);
  await acquired.promise;
  afterAcquireController.abort(new Error('after acquisition'));
  releaseAfterAcquire.resolve();
  await afterAcquireActivation;

  let committedSignal: AbortSignal | undefined;
  const afterCommit = new AxEventComponentManager();
  await afterCommit.define({
    id: 'abort-after-commit',
    version: '1',
    activate: (context) => {
      committedSignal = context.signal;
      context.addDisposer('committed', () => undefined);
    },
  });
  const afterCommitController = new AbortController();
  await afterCommit.activate(undefined, {
    signal: afterCommitController.signal,
  });
  afterCommitController.abort(new Error('after commit'));
  const activeAfterTransitionAbort =
    afterCommit.inspect('abort-after-commit')?.state === 'active' &&
    committedSignal?.aborted === false;
  await afterCommit.deactivate();

  return {
    beforeActivationSkipped:
      preActivationCalls === 0 &&
      before.inspect('abort-before')?.state === 'defined',
    duringActivationRolledBack:
      duringResources === 0 &&
      during.inspect('abort-during')?.state === 'failed',
    afterAcquireRolledBack:
      acquiredResources === 0 &&
      afterAcquire.inspect('abort-after-acquire')?.state === 'failed',
    activeAfterTransitionAbort,
    lifetimeAbortedOnDeactivate: committedSignal?.aborted === true,
  };
}

async function sourceHandleAndFailureBoundaries() {
  let undefinedStarts = 0;
  const undefinedHandle = new AxEventRuntime({
    routes: [],
    sources: [
      {
        id: 'undefined-handle',
        start: () => {
          undefinedStarts++;
        },
      },
    ],
  });
  await undefinedHandle.start();
  await undefinedHandle.close({ drain: false });

  let startupResources = 0;
  const startupFailure = new AxEventRuntime({
    routes: [],
    sources: [
      {
        id: 'startup-first',
        start: () => {
          startupResources++;
          return { close: () => startupResources-- };
        },
      },
      {
        id: 'startup-failure',
        start: () => {
          throw new Error('expected startup failure');
        },
      },
    ],
  });
  let startupRejected = false;
  await startupFailure.start().catch(() => {
    startupRejected = true;
  });

  let cleanupResources = 0;
  let cleanupContinued = false;
  const cleanupFailure = new AxEventRuntime({
    routes: [],
    sources: [
      {
        id: 'cleanup-continued',
        start: () => {
          cleanupResources++;
          return {
            close: () => {
              cleanupResources--;
              cleanupContinued = true;
            },
          };
        },
      },
      {
        id: 'cleanup-failure',
        start: () => {
          cleanupResources++;
          return {
            close: () => {
              throw new Error('expected cleanup failure');
            },
          };
        },
      },
    ],
  });
  await cleanupFailure.start();
  await cleanupFailure.close({ drain: false });

  const malformedHandle = new AxEventRuntime({
    routes: [],
    sources: [
      {
        id: 'malformed-handle',
        start: () => ({ close: undefined }) as any,
      },
    ],
  });
  await malformedHandle.start();
  const malformedClose = await Promise.allSettled([
    malformedHandle.close({ drain: false }),
  ]);

  return {
    undefinedHandleAccepted: undefinedStarts === 1,
    startupFailureRejected: startupRejected,
    startupRollbackClosedPrior: startupResources === 0,
    cleanupContinuedAfterFailure: cleanupContinued,
    failedDisposerResourceRemains: cleanupResources === 1,
    malformedHandleCloseContained: malformedClose[0]?.status === 'fulfilled',
    malformedHandleReversible: false,
  };
}

async function mechanismRepetitions(count: number): Promise<{
  runsPerCase: number;
  totalRuns: number;
  managerInvariantFailures: number;
  unmanagedExpectedOutcomes: number;
  totalMs: number;
  meanCaseMs: number;
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
  let managerInvariantFailures = 0;
  let unmanagedExpectedOutcomes = 0;
  const startedAt = performance.now();
  for (let iteration = 0; iteration < count; iteration++) {
    for (const [name, scenario] of scenarios) {
      const result = await scenario();
      if (!managedFaultPassed(name, result)) managerInvariantFailures++;
      if (unmanagedExpectedOutcome(name, result)) unmanagedExpectedOutcomes++;
    }
  }
  const totalMs = performance.now() - startedAt;
  const totalRuns = count * scenarios.length;
  return {
    runsPerCase: count,
    totalRuns,
    managerInvariantFailures,
    unmanagedExpectedOutcomes,
    totalMs: round(totalMs),
    meanCaseMs: round(totalMs / totalRuns),
  };
}

async function transitionTiming(count: number): Promise<{
  comparison: string;
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
    comparison:
      'Minimal unmanaged disposer assignment/invocation versus manager define/activate/deactivate; not semantics-equivalent.',
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

function unmanagedExpectedOutcome(name: string, result: FaultResult): boolean {
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
  const boundaries = result.adversarialBoundaries;
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
    result.mechanismRepetitions.managerInvariantFailures !== 0,
    boundaries.runtimeStartCloseOverlap.startRejected !== true,
    boundaries.runtimeStartCloseOverlap.closeFulfilled !== true,
    boundaries.runtimeStartCloseOverlap.noLaterSourceStarted !== true,
    boundaries.runtimeStartCloseOverlap.lateHandleClosed !== true,
    boundaries.runtimeStartCloseOverlap.liveSources !== 0,
    boundaries.lateTeardownRegistration.deactivationRejected !== true,
    boundaries.lateTeardownRegistration.queuedActivationRejected !== true,
    boundaries.lateTeardownRegistration.activationCount !== 1,
    boundaries.lateTeardownRegistration.queuedActivationOverlapped !== false,
    boundaries.lateTeardownRegistration.lateDisposerInvocations !== 0,
    boundaries.lateTeardownRegistration.lateRegistrationDiagnosed !== true,
    ...Object.values(boundaries.uncertainEffectOwnership).flatMap((value) => [
      value.activationRejected !== true,
      value.replacementRejected !== true,
      value.activeDependencyReplacementRejected !== true,
      value.noSecondAcquisition !== true,
      value.disposerInvokedOnce !== true,
      value.replacementNotActivated !== true,
      value.activeReplacementNotSetUp !== true,
      value.priorActiveTargetPreserved !== true,
      value.failedEvidencePreserved !== true,
    ]),
    boundaries.inactiveReplacement.definedCandidateActivations !== 0,
    boundaries.inactiveReplacement.definedReplacementState !== true,
    boundaries.inactiveReplacement.failedCandidateActivations !== 0,
    boundaries.inactiveReplacement.failedReplacementState !== true,
    boundaries.partialDisposal.providerDisposed !== true,
    boundaries.partialDisposal.activeChildDisposed !== true,
    boundaries.partialDisposal.inactiveGrandchildDisposed !== true,
    boundaries.partialDisposal.reactivationRejected !== true,
    boundaries.dependencySnapshot.retiredCleanupSawPriorDependency !== true,
    boundaries.dependencySnapshot.stagedConsumerSawCandidate !== true,
    boundaries.abortBoundaries.beforeActivationSkipped !== true,
    boundaries.abortBoundaries.duringActivationRolledBack !== true,
    boundaries.abortBoundaries.afterAcquireRolledBack !== true,
    boundaries.abortBoundaries.activeAfterTransitionAbort !== true,
    boundaries.abortBoundaries.lifetimeAbortedOnDeactivate !== true,
    boundaries.sourceHandleAndFailureBoundaries.undefinedHandleAccepted !==
      true,
    boundaries.sourceHandleAndFailureBoundaries.startupFailureRejected !== true,
    boundaries.sourceHandleAndFailureBoundaries.startupRollbackClosedPrior !==
      true,
    boundaries.sourceHandleAndFailureBoundaries.cleanupContinuedAfterFailure !==
      true,
    boundaries.sourceHandleAndFailureBoundaries
      .failedDisposerResourceRemains !== true,
    boundaries.sourceHandleAndFailureBoundaries
      .malformedHandleCloseContained !== true,
    boundaries.sourceHandleAndFailureBoundaries.malformedHandleReversible !==
      false,
  ];
  if (failures.some(Boolean)) {
    throw new Error('Managed lifecycle evaluation invariant failed');
  }
}
