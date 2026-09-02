import { prng } from '../../lib/seeds.js';
import { Life, type LifeOptions } from './mindLife.js';

/**
 * The pre-seeded life the time-warp scrubber travels over.
 *
 * It is not a fixture. The mind runs for real the whole way: every host step is
 * real ingress, every wake is a real wake, every `mind-wake` record is written
 * by the pacer, and every checkpoint is computed at that instant by
 * `axProjectTrajectory`, `axBuildTrajectoryRollups` and the pacer itself. The
 * scrubber then SNAPS to the nearest checkpoint, which is why the readout says
 * so rather than pretending to be continuous.
 *
 * The input schedule is bursty on purpose: engagement resets the ladder to rung
 * 0, so a life with no quiet stretches would have no ladder to show.
 */
export interface Checkpoint {
  readonly stepCount: number;
  readonly simMs: number;
  readonly nowMs: number;
  readonly level: number;
  readonly ticks: number;
  readonly wakesInWindow: number;
  readonly budgetTokens: number;
  readonly recentSize: number;
  readonly recentCount: number;
  readonly estimatedTokens: number;
  readonly sections: readonly Readonly<{
    tier: number;
    start: number;
    end: number;
  }>[];
  readonly gaps: number;
  readonly sealedIndex: number;
  readonly blocks: number;
  readonly newest: string;
}

export interface ArchiveResult {
  readonly life: Life;
  readonly checkpoints: readonly Checkpoint[];
}

const OBSERVATIONS = [
  'ci went green on the third try',
  'a webhook arrived with an empty body',
  'the nightly backup took 41 minutes',
  'someone renamed the staging bucket',
  'a dependency published a patch release',
  'the queue drained faster than usual',
  'a health check flapped twice and settled',
  'disk usage crossed sixty per cent',
];

const MESSAGES = [
  'is anything broken right now?',
  'can you summarise the last hour?',
  'what changed since yesterday?',
  'did the deploy actually land?',
];

const ERRORS = [
  'tool call failed: connect ECONNREFUSED 127.0.0.1:11434',
  'tool call failed: 429 rate limited, retry after 30s',
  'tool call failed: schema mismatch on field `total`',
];

export async function seedArchive(
  options: LifeOptions & { targetSteps?: number },
  onProgress?: (done: number, target: number) => void
): Promise<ArchiveResult> {
  const target = options.targetSteps ?? 1000;
  const life = new Life({ ...options, trajectoryId: 'pry-archive' });
  await life.start();
  const random = prng(options.seed ^ 0x5eed);
  const checkpoints: Checkpoint[] = [];
  const origin = life.clock.now();

  const yieldToBrowser = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const capture = async (): Promise<void> => {
    // A projection over a growing log is the longest single task here, so it
    // gets a macrotask boundary on either side: seeding must never hold the
    // main thread away from the hero.
    await yieldToBrowser();
    const snapshot = await life.snapshot(4);
    const pacer = life.pacer();
    const projection = snapshot.projection;
    const meta = await life.rollups.loadMeta(life.trajectoryId);
    checkpoints.push({
      stepCount: snapshot.stepCount,
      simMs: life.clock.now() - origin,
      nowMs: life.clock.now(),
      level: pacer?.level ?? 0,
      ticks: pacer?.ticks ?? 0,
      wakesInWindow: pacer?.spontaneousWakes.length ?? 0,
      budgetTokens: life.budgetTokens,
      recentSize: life.recentSize,
      recentCount: projection?.recent.length ?? 0,
      estimatedTokens: projection?.estimatedTokens ?? 0,
      sections: (projection?.life ?? [])
        .filter(
          (section): section is Extract<typeof section, { kind: 'summary' }> =>
            section.kind === 'summary'
        )
        .map((section) => ({
          tier: section.block.tier,
          start: section.block.start,
          end: section.block.end,
        })),
      gaps: (projection?.life ?? []).filter((section) => section.kind === 'gap')
        .length,
      sealedIndex: meta?.sealedIndex ?? 0,
      blocks: snapshot.blocks.length,
      newest: String(snapshot.steps.at(-1)?.data.content ?? ''),
    });
    await yieldToBrowser();
  };

  await capture();

  let guard = 0;
  while (
    checkpoints[checkpoints.length - 1]!.stepCount < target &&
    guard < 400
  ) {
    guard += 1;
    // A burst: two to five host inputs a minute or two apart. Engagement, so
    // the ladder snaps back to rung 0 each time.
    const burst = 2 + random.int(4);
    for (let i = 0; i < burst; i++) {
      const roll = random.next();
      const type =
        roll < 0.6 ? 'observation' : roll < 0.9 ? 'message' : 'error';
      const content =
        type === 'observation'
          ? random.pick(OBSERVATIONS)
          : type === 'message'
            ? random.pick(MESSAGES)
            : random.pick(ERRORS);
      await life.append(type, content);
      await life.advance(30_000 + random.int(90_000), 10_000);
    }
    // A quiet stretch: nothing arrives, so the pacer descends its own ladder.
    // Small chunks on purpose: each chunk is one macrotask, so seeding stays
    // a stream of short tasks rather than a few long ones that would block the
    // hero the reader is actually looking at.
    await life.advance(600_000 + random.int(1_800_000), 20_000);
    await life.seal();
    await capture();
    onProgress?.(
      Math.min(target, checkpoints[checkpoints.length - 1]!.stepCount),
      target
    );
  }

  await life.seal();
  await capture();
  return { life, checkpoints };
}
