import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type AxEventContext,
  type AxEventEffectResolution,
  type AxEventEffectStatus,
  type AxEventEffectStore,
  AxEventRuntime,
  AxManualEventClock,
  type AxProgrammable,
  AxSignature,
  eventRoute,
  eventTarget,
} from '../src/ax/index.js';
import {
  AX_SQLITE_EVENT_STANDARD_RETENTION,
  AxSQLiteEventStore,
} from '../src/tools/event/sqlite.js';

type FaultBoundary =
  | 'before-intent'
  | 'intent'
  | 'dispatched'
  | 'settled-success'
  | 'settled-failure'
  | 'parked';

type Classification =
  | 'no-record'
  | 'not-dispatched'
  | 'indeterminate'
  | 'completed'
  | 'parked';

interface ScenarioResult {
  boundary: FaultBoundary;
  replaySafety: 'idempotent' | 'unknown';
  expectedClassification: Classification;
  classification: Classification;
  recoveredDeliveryStatus: string;
  recoveryDispatches: number;
  effectRecords: number;
  lostRecords: number;
  duplicateRecords: number;
}

interface ResolverResult {
  resolution: AxEventEffectResolution['status'];
  recoveredDeliveryStatus: string;
  effectStatus: AxEventEffectStatus;
  recoveryDispatches: number;
}

export interface AxEventEffectFaultEvaluation {
  schemaVersion: 1;
  claims: {
    scope: 'durability-classification-and-recovery';
    exactlyOnce: false;
    modelQuality: false;
  };
  stateBoundaries: ScenarioResult[];
  resolverOutcomes: ResolverResult[];
  legacyComparison: {
    idempotentTarget: {
      recoveredStatus: string;
      recoveryDispatches: number;
      duplicateEffectRisk: boolean;
      effectClassification: 'unavailable';
    };
    unknownTarget: {
      recoveredStatus: string;
      recoveryDispatches: number;
      duplicateEffectRisk: boolean;
      effectClassification: 'unavailable';
    };
  };
  concurrency: {
    claimWinners: number;
    effectRecords: number;
    duplicateRecords: number;
    staleRevisionRejected: boolean;
    expiredFenceRejected: boolean;
    staleFenceRejected: boolean;
  };
  overhead: {
    iterations: number;
    baselineMeanLatencyMs: number;
    effectSandwichMeanLatencyMs: number;
    incrementalMeanLatencyMs: number;
    baselineStorageBytes: number;
    effectStorageBytes: number;
    incrementalStorageBytesPerEffect: number;
  };
}

const scriptPath = fileURLToPath(import.meta.url);
const CRASH_EXIT_CODE = 86;

function enqueueRequest(
  eventId: string,
  now: number,
  retrySafety: 'idempotent' | 'unknown' = 'idempotent'
) {
  return {
    ingress: {
      event: {
        specversion: '1.0' as const,
        id: eventId,
        source: 'fault-eval://effects',
        type: 'effect.requested',
      },
      identity: { tenantId: 'fault-eval' },
      trust: 'authenticated' as const,
    },
    deliveries: [
      {
        routeId: 'effect-route',
        action: 'wake' as const,
        targetId: 'effect-target',
        instanceKey: eventId,
        sizeBytes: 128,
        retrySafety,
        ordering: 'strict' as const,
      },
    ],
    acceptedAt: now,
    publishTimeoutMs: 5_000,
  };
}

async function prepareFaultChild(
  filename: string,
  boundary: FaultBoundary,
  replaySafety: 'idempotent' | 'unknown',
  targetRetrySafety: 'idempotent' | 'effect-aware' | 'unknown'
): Promise<never> {
  const clock = new AxManualEventClock(0);
  const store = new AxSQLiteEventStore({
    filename,
    clock,
    retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
  });
  const receipt = await store.enqueue(
    enqueueRequest('crash-event', clock.now(), targetRetrySafety)
  );
  const delivery = await store.claim('crashing-worker', clock.now(), 100);
  if (!delivery) throw new Error('fault child could not claim delivery');
  const runId = 'crashed-run';
  await store.saveDelivery({
    ...delivery,
    status: 'running',
    runId,
    attempt: 1,
    invocationStarted: true,
  });
  await store.saveRun({
    id: runId,
    deliveryId: delivery.id,
    routeId: delivery.routeId,
    targetId: delivery.targetId,
    instanceKey: delivery.instanceKey,
    claimedBy: delivery.claimedBy,
    status: 'running',
    attempt: 1,
    startedAt: clock.now(),
    fencingToken: delivery.fencingToken,
  });
  if (boundary !== 'before-intent') {
    let effect = await store.declareEffect(
      {
        id: 'crashed-effect',
        deliveryId: delivery.id,
        runId,
        identityScope: delivery.identityScope,
        operation: 'fault-eval.dispatch',
        idempotencyKey: 'stable-effect-key',
        replaySafety,
        metadata: { secret: 'redacted', boundary },
        createdAt: clock.now(),
      },
      { deliveryId: delivery.id, fencingToken: delivery.fencingToken! }
    );
    if (boundary !== 'intent') {
      effect = await store.transitionEffect(
        effect.id,
        effect.version,
        { type: 'dispatched', at: clock.now() },
        { deliveryId: delivery.id, fencingToken: delivery.fencingToken! }
      );
    }
    if (boundary === 'settled-success' || boundary === 'settled-failure') {
      await store.transitionEffect(
        effect.id,
        effect.version,
        {
          type: 'settled',
          at: clock.now(),
          settlement:
            boundary === 'settled-success'
              ? { status: 'succeeded', receipt: { providerId: 'completed' } }
              : { status: 'failed', error: 'provider rejected request' },
        },
        { deliveryId: delivery.id, fencingToken: delivery.fencingToken! }
      );
    } else if (boundary === 'parked') {
      await store.transitionEffect(
        effect.id,
        effect.version,
        { type: 'parked', at: clock.now(), reason: 'manual review required' },
        { deliveryId: delivery.id, fencingToken: delivery.fencingToken! }
      );
    }
  }
  writeFileSync(
    `${filename}.delivery.json`,
    JSON.stringify({ deliveryId: receipt.deliveryIds[0] })
  );
  // Deliberately skip store.close(): process death is the injected fault.
  process.exit(CRASH_EXIT_CODE);
}

function spawnFault(
  filename: string,
  boundary: FaultBoundary,
  replaySafety: 'idempotent' | 'unknown',
  targetRetrySafety: 'idempotent' | 'effect-aware' | 'unknown' = 'effect-aware'
): string {
  const child = spawnSync(
    process.execPath,
    [
      '--import=tsx',
      scriptPath,
      '--fault-child',
      filename,
      boundary,
      replaySafety,
      targetRetrySafety,
    ],
    { encoding: 'utf8' }
  );
  if (child.status !== CRASH_EXIT_CODE) {
    throw new Error(
      `fault child failed (${String(child.status)}): ${child.stderr || child.stdout}`
    );
  }
  return (
    JSON.parse(readFileSync(`${filename}.delivery.json`, 'utf8')) as {
      deliveryId: string;
    }
  ).deliveryId;
}

function classify(status: AxEventEffectStatus | undefined): Classification {
  if (status === undefined) return 'no-record';
  if (status === 'intent') return 'not-dispatched';
  if (status === 'dispatched') return 'indeterminate';
  if (status === 'succeeded' || status === 'failed') return 'completed';
  return 'parked';
}

function program(
  forward: (context: Readonly<AxEventContext>) => unknown | Promise<unknown>
): AxProgrammable<any, any> {
  const signature = new AxSignature('eventId?:string -> handled:boolean');
  return {
    getId: () => 'fault-eval-program',
    getSignature: () => signature,
    forward: async (_ai: unknown, _input: unknown, options: any) =>
      forward(options.eventContext),
    streamingForward: async function* () {},
  } as unknown as AxProgrammable<any, any>;
}

async function recover(
  filename: string,
  deliveryId: string,
  replaySafety: 'idempotent' | 'unknown',
  options: {
    targetRetrySafety?: 'idempotent' | 'effect-aware' | 'unknown';
    resolver?: () => AxEventEffectResolution;
    useLedger?: boolean;
  } = {}
): Promise<{
  classification: Classification;
  status: string;
  dispatches: number;
  effects: Awaited<ReturnType<AxEventEffectStore['listEffects']>>;
}> {
  const clock = new AxManualEventClock(101);
  const store = new AxSQLiteEventStore({
    filename,
    clock,
    retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
  });
  const before = await store.listEffects(deliveryId);
  let dispatches = 0;
  const target = eventTarget({
    id: 'effect-target',
    ai: {} as never,
    program: program(async (context) => {
      if (options.useLedger === false) {
        dispatches++;
        return { handled: true };
      }
      let effect = (await context.listEffects())[0];
      if (!effect) {
        effect = await context.declareEffect({
          operation: 'fault-eval.dispatch',
          idempotencyKey: 'stable-effect-key',
          replaySafety,
          metadata: { secret: 'redacted', boundary: 'recovery' },
        });
      }
      if (effect.status === 'succeeded' || effect.status === 'failed') {
        return { handled: true };
      }
      effect = await context.markEffectDispatched(effect.id, effect.version);
      dispatches++;
      await context.settleEffect(effect.id, effect.version, {
        status: 'succeeded',
        receipt: { providerId: 'recovered' },
      });
      return { handled: true };
    }),
    mapInput: () => ({}),
    retrySafety: options.targetRetrySafety ?? 'effect-aware',
  });
  const runtime = new AxEventRuntime({
    store,
    programStateStore: store,
    coordination: 'multi-worker',
    workerConcurrency: 1,
    leaseMs: 100,
    heartbeatMs: 25,
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxAttempts: 2,
    ...(options.resolver ? { effectResolver: options.resolver } : {}),
    routes: [
      eventRoute({
        id: 'effect-route',
        match: { types: ['effect.requested'] },
        action: 'wake',
        target,
      }),
    ],
  });
  await runtime.start();
  for (let index = 0; index < 1_000; index++) {
    const status = (await store.getDelivery(deliveryId))?.status;
    if (status !== 'queued' && status !== 'claimed' && status !== 'running') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const status = (await store.getDelivery(deliveryId))?.status ?? 'missing';
  const effects = await store.listEffects(deliveryId);
  await runtime.close({ drain: false });
  return {
    classification: classify(before[0]?.status),
    status,
    dispatches,
    effects,
  };
}

async function runBoundaryScenarios(
  directory: string
): Promise<ScenarioResult[]> {
  const scenarios: Array<{
    boundary: FaultBoundary;
    replaySafety: 'idempotent' | 'unknown';
    expected: Classification;
  }> = [
    {
      boundary: 'before-intent',
      replaySafety: 'unknown',
      expected: 'no-record',
    },
    { boundary: 'intent', replaySafety: 'unknown', expected: 'not-dispatched' },
    {
      boundary: 'dispatched',
      replaySafety: 'idempotent',
      expected: 'indeterminate',
    },
    {
      boundary: 'dispatched',
      replaySafety: 'unknown',
      expected: 'indeterminate',
    },
    {
      boundary: 'settled-success',
      replaySafety: 'unknown',
      expected: 'completed',
    },
    {
      boundary: 'settled-failure',
      replaySafety: 'unknown',
      expected: 'completed',
    },
    { boundary: 'parked', replaySafety: 'unknown', expected: 'parked' },
  ];
  const rows: ScenarioResult[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const filename = join(directory, `boundary-${index}.sqlite`);
    const deliveryId = spawnFault(
      filename,
      scenario.boundary,
      scenario.replaySafety
    );
    const recovered = await recover(
      filename,
      deliveryId,
      scenario.replaySafety
    );
    const expectedRecords = 1;
    rows.push({
      boundary: scenario.boundary,
      replaySafety: scenario.replaySafety,
      expectedClassification: scenario.expected,
      classification: recovered.classification,
      recoveredDeliveryStatus: recovered.status,
      recoveryDispatches: recovered.dispatches,
      effectRecords: recovered.effects.length,
      lostRecords: Math.max(0, expectedRecords - recovered.effects.length),
      duplicateRecords: Math.max(0, recovered.effects.length - expectedRecords),
    });
  }
  return rows;
}

async function runResolverScenarios(
  directory: string
): Promise<ResolverResult[]> {
  const resolutions: AxEventEffectResolution[] = [
    { status: 'succeeded', receipt: { providerId: 'resolved' } },
    { status: 'failed', error: 'provider rejected request' },
    { status: 'not_dispatched' },
    { status: 'indeterminate' },
    { status: 'parked', reason: 'operator review required' },
  ];
  const rows: ResolverResult[] = [];
  for (const [index, resolution] of resolutions.entries()) {
    const filename = join(directory, `resolver-${index}.sqlite`);
    const deliveryId = spawnFault(filename, 'dispatched', 'unknown');
    const recovered = await recover(filename, deliveryId, 'unknown', {
      resolver: () => resolution,
    });
    rows.push({
      resolution: resolution.status,
      recoveredDeliveryStatus: recovered.status,
      effectStatus: recovered.effects[0]!.status,
      recoveryDispatches: recovered.dispatches,
    });
  }
  return rows;
}

async function runLegacyComparison(directory: string) {
  const idempotentFile = join(directory, 'legacy-idempotent.sqlite');
  const idempotentDelivery = spawnFault(
    idempotentFile,
    'before-intent',
    'unknown',
    'idempotent'
  );
  const idempotent = await recover(
    idempotentFile,
    idempotentDelivery,
    'unknown',
    { targetRetrySafety: 'idempotent', useLedger: false }
  );

  const unknownFile = join(directory, 'legacy-unknown.sqlite');
  const unknownDelivery = spawnFault(
    unknownFile,
    'before-intent',
    'unknown',
    'unknown'
  );
  const unknown = await recover(unknownFile, unknownDelivery, 'unknown', {
    targetRetrySafety: 'unknown',
    useLedger: false,
  });
  return {
    idempotentTarget: {
      recoveredStatus: idempotent.status,
      recoveryDispatches: idempotent.dispatches,
      duplicateEffectRisk: idempotent.dispatches > 0,
      effectClassification: 'unavailable' as const,
    },
    unknownTarget: {
      recoveredStatus: unknown.status,
      recoveryDispatches: unknown.dispatches,
      duplicateEffectRisk: false,
      effectClassification: 'unavailable' as const,
    },
  };
}

async function runConcurrency(directory: string) {
  const filename = join(directory, 'concurrency.sqlite');
  const clock = new AxManualEventClock(0);
  const first = new AxSQLiteEventStore({
    filename,
    clock,
    retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
  });
  const second = new AxSQLiteEventStore({
    filename,
    clock,
    retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
  });
  const receipt = await first.enqueue(
    enqueueRequest('concurrent', clock.now())
  );
  const claims = await Promise.all([
    first.claim('worker-a', clock.now(), 100),
    second.claim('worker-b', clock.now(), 100),
  ]);
  const winners = claims.filter((claim) => claim !== undefined);
  const winner = winners[0]!;
  const fence = {
    deliveryId: winner.id,
    fencingToken: winner.fencingToken!,
  };
  const request = {
    id: 'concurrent-effect-a',
    deliveryId: winner.id,
    runId: 'concurrent-run',
    identityScope: winner.identityScope,
    operation: 'concurrent.effect',
    idempotencyKey: 'concurrent-key',
    replaySafety: 'idempotent' as const,
    createdAt: clock.now(),
  };
  const [effect] = await Promise.all([
    first.declareEffect(request, fence),
    second.declareEffect({ ...request, id: 'concurrent-effect-b' }, fence),
  ]);
  const dispatched = await first.transitionEffect(
    effect.id,
    effect.version,
    { type: 'dispatched', at: clock.now() },
    fence
  );
  let staleRevisionRejected = false;
  try {
    await second.transitionEffect(
      effect.id,
      effect.version,
      { type: 'dispatched', at: clock.now() },
      fence
    );
  } catch {
    staleRevisionRejected = true;
  }
  clock.advanceBy(101);
  let expiredFenceRejected = false;
  try {
    await first.transitionEffect(
      effect.id,
      dispatched.version,
      { type: 'dispatched', at: clock.now() },
      fence
    );
  } catch {
    expiredFenceRejected = true;
  }
  const takeover = await second.claim('worker-c', clock.now(), 100);
  let staleFenceRejected = false;
  try {
    await first.transitionEffect(
      effect.id,
      dispatched.version,
      { type: 'dispatched', at: clock.now() },
      fence
    );
  } catch {
    staleFenceRejected = true;
  }
  const effects = await second.listEffects(receipt.deliveryIds[0]!);
  await Promise.all([first.close(), second.close()]);
  return {
    claimWinners: winners.length,
    effectRecords: effects.length,
    duplicateRecords: Math.max(0, effects.length - 1),
    staleRevisionRejected,
    expiredFenceRejected,
    staleFenceRejected:
      staleFenceRejected &&
      (takeover?.fencingToken ?? 0) > (winner.fencingToken ?? 0),
  };
}

async function benchmarkStore(
  filename: string,
  iterations: number,
  withEffects: boolean
): Promise<{ meanLatencyMs: number; storageBytes: number }> {
  const clock = new AxManualEventClock(1_000);
  const store = new AxSQLiteEventStore({
    filename,
    clock,
    retention: AX_SQLITE_EVENT_STANDARD_RETENTION,
  });
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const receipt = await store.enqueue(
      enqueueRequest(`overhead-${index}`, clock.now())
    );
    const delivery = await store.claim(`worker-${index}`, clock.now(), 100);
    if (!delivery || delivery.id !== receipt.deliveryIds[0]) {
      throw new Error('overhead evaluation claim mismatch');
    }
    if (withEffects) {
      const fence = {
        deliveryId: delivery.id,
        fencingToken: delivery.fencingToken!,
      };
      let effect = await store.declareEffect(
        {
          id: `effect-${index}`,
          deliveryId: delivery.id,
          runId: `run-${index}`,
          identityScope: delivery.identityScope,
          operation: 'overhead.effect',
          idempotencyKey: `key-${index}`,
          replaySafety: 'idempotent',
          metadata: { redacted: true },
          createdAt: clock.now(),
        },
        fence
      );
      effect = await store.transitionEffect(
        effect.id,
        effect.version,
        { type: 'dispatched', at: clock.now() },
        fence
      );
      await store.transitionEffect(
        effect.id,
        effect.version,
        {
          type: 'settled',
          at: clock.now(),
          settlement: { status: 'succeeded', receipt: { id: index } },
        },
        fence
      );
    }
    await store.saveDelivery({ ...delivery, status: 'succeeded' });
  }
  const elapsed = performance.now() - start;
  await store.close();
  return {
    meanLatencyMs: elapsed / iterations,
    storageBytes: statSync(filename).size,
  };
}

async function runOverhead(directory: string) {
  const iterations = 200;
  const baseline = await benchmarkStore(
    join(directory, 'overhead-baseline.sqlite'),
    iterations,
    false
  );
  const effects = await benchmarkStore(
    join(directory, 'overhead-effects.sqlite'),
    iterations,
    true
  );
  return {
    iterations,
    baselineMeanLatencyMs: baseline.meanLatencyMs,
    effectSandwichMeanLatencyMs: effects.meanLatencyMs,
    incrementalMeanLatencyMs: effects.meanLatencyMs - baseline.meanLatencyMs,
    baselineStorageBytes: baseline.storageBytes,
    effectStorageBytes: effects.storageBytes,
    incrementalStorageBytesPerEffect:
      (effects.storageBytes - baseline.storageBytes) / iterations,
  };
}

export async function runAxEventEffectFaultEvaluation(): Promise<AxEventEffectFaultEvaluation> {
  const directory = mkdtempSync(join(tmpdir(), 'ax-event-effects-eval-'));
  try {
    return {
      schemaVersion: 1,
      claims: {
        scope: 'durability-classification-and-recovery',
        exactlyOnce: false,
        modelQuality: false,
      },
      stateBoundaries: await runBoundaryScenarios(directory),
      resolverOutcomes: await runResolverScenarios(directory),
      legacyComparison: await runLegacyComparison(directory),
      concurrency: await runConcurrency(directory),
      overhead: await runOverhead(directory),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertEvaluation(result: AxEventEffectFaultEvaluation): void {
  for (const scenario of result.stateBoundaries) {
    if (scenario.classification !== scenario.expectedClassification) {
      throw new Error(
        `classification mismatch at ${scenario.boundary}: ${scenario.classification}`
      );
    }
    if (scenario.lostRecords !== 0 || scenario.duplicateRecords !== 0) {
      throw new Error(`effect record corruption at ${scenario.boundary}`);
    }
  }
  if (
    result.concurrency.claimWinners !== 1 ||
    result.concurrency.duplicateRecords !== 0 ||
    !result.concurrency.staleRevisionRejected ||
    !result.concurrency.expiredFenceRejected ||
    !result.concurrency.staleFenceRejected
  ) {
    throw new Error('concurrency/fencing evaluation failed');
  }
  if (!result.legacyComparison.idempotentTarget.duplicateEffectRisk) {
    throw new Error(
      'legacy comparison did not reproduce duplicate-effect risk'
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain && process.argv[2] === '--fault-child') {
  const [, , , filename, boundary, replaySafety, targetRetrySafety] =
    process.argv;
  await prepareFaultChild(
    filename!,
    boundary as FaultBoundary,
    replaySafety as 'idempotent' | 'unknown',
    targetRetrySafety as 'idempotent' | 'effect-aware' | 'unknown'
  );
} else if (isMain) {
  const result = await runAxEventEffectFaultEvaluation();
  assertEvaluation(result);
  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'npm run event:effects:eval',
        ...result,
      },
      null,
      2
    )}\n`
  );
}
