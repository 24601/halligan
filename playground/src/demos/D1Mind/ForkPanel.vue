<script setup lang="ts">
import { GitFork } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { AxMindPacerConfig } from '../../lib/axImport.js';
import LifeLog from './LifeLog.vue';
import { Life, type LifeSnapshot } from './mindLife.js';
import PacingLadder from './PacingLadder.vue';

/**
 * Fork from a step and run two minds side by side.
 *
 * The fork is the store's own `fork()` -- a real structural `fork` step with a
 * real parent link and a real depth -- and the child is driven by a second
 * `mind()` over the same store and the same manual clock. Poking one and not
 * the other is enough to make the two ladders separate, which is the whole
 * point: a trajectory is a life, and a fork is another one.
 */
const props = defineProps<{
  seed: number;
  capMs: number;
  contextWindowTokens: number;
  config: Readonly<AxMindPacerConfig>;
}>();

const parent = shallowRef<Life | null>(null);
const child = shallowRef<Life | null>(null);
const parentSnap = ref<LifeSnapshot | null>(null);
const childSnap = ref<LifeSnapshot | null>(null);
const forkStep = ref(6);
const busy = ref(false);
const forkedAt = ref<Readonly<{
  childTrajectoryId: string;
  forkStepId: string;
  depth: number;
}> | null>(null);

const SEEDS = [
  'the deploy finished and nobody said anything about it',
  'a webhook arrived with an empty body',
  'ci went green on the third try',
  'someone renamed the staging bucket',
  'a health check flapped twice and settled',
  'disk usage crossed sixty per cent',
  'the queue drained faster than usual',
  'the nightly backup took 41 minutes',
];

async function refresh(): Promise<void> {
  parentSnap.value = (await parent.value?.snapshot(30)) ?? null;
  childSnap.value = (await child.value?.snapshot(30)) ?? null;
}

async function fork(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await parent.value?.close();
    await child.value?.close();
    parent.value = null;
    child.value = null;
    forkedAt.value = null;

    const a = new Life({
      seed: props.seed,
      capMs: props.capMs,
      contextWindowTokens: props.contextWindowTokens,
      trajectoryId: 'pry-fork-a',
    });
    await a.start();
    for (let i = 1; i < forkStep.value; i++) {
      await a.append(
        'observation',
        SEEDS[i % SEEDS.length] ?? 'something happened'
      );
      await a.advance(45_000, 15_000);
    }
    const result = await a.store.fork({
      parentTrajectoryId: a.trajectoryId,
      slug: 'pry-fork-b',
    });
    forkedAt.value = result;

    const b = new Life({
      seed: props.seed,
      capMs: props.capMs,
      contextWindowTokens: props.contextWindowTokens,
      trajectoryId: result.childTrajectoryId,
      store: a.store,
      clock: a.clock,
      existing: true,
    });
    await b.start();
    parent.value = a;
    child.value = b;
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function advanceBoth(ms: number): Promise<void> {
  if (busy.value || !parent.value) return;
  busy.value = true;
  try {
    // One clock drives both: the fork is a second life, not a second universe.
    await parent.value.advance(ms, 30_000);
    await parent.value.seal();
    await child.value?.seal();
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function pokeChild(): Promise<void> {
  if (busy.value || !child.value) return;
  busy.value = true;
  try {
    await child.value.poke('error');
    await child.value.advance(2000, 500);
    await refresh();
  } finally {
    busy.value = false;
  }
}

const diverged = computed(
  () =>
    (parentSnap.value?.stepCount ?? 0) !== (childSnap.value?.stepCount ?? 0) ||
    (parent.value?.pacer()?.level ?? -1) !== (child.value?.pacer()?.level ?? -2)
);

onBeforeUnmount(() => {
  void parent.value?.close();
  void child.value?.close();
});
</script>

<template>
  <section class="fork pry-component" aria-label="Fork from a step">
    <div class="fork__controls">
      <label class="fork__slider">
        <span class="t-label">
          Fork after step <span class="t-mono">{{ forkStep }}</span>
        </span>
        <input v-model.number="forkStep" type="range" min="2" max="14" step="1" />
      </label>
      <button type="button" class="ctl ctl--primary" :disabled="busy" @click="fork">
        <GitFork :size="15" :stroke-width="1.5" aria-hidden="true" />
        <span>Fork</span>
      </button>
      <button type="button" class="ctl" :disabled="busy || !child" @click="pokeChild">
        Poke the fork only
      </button>
      <button type="button" class="ctl" :disabled="busy || !parent" @click="advanceBoth(600_000)">
        Advance both 10 min
      </button>
    </div>

    <p v-if="forkedAt" class="fork__receipt t-mono">
      fork step <span>{{ forkedAt.forkStepId.slice(0, 12) }}</span> · child
      <span>{{ forkedAt.childTrajectoryId }}</span> · depth {{ forkedAt.depth }}
      <span v-if="diverged" class="fork__diverged">· diverged</span>
    </p>
    <p v-else class="fork__hint t-caption">
      Fork to run two minds over one clock and one store.
    </p>

    <div v-if="parent" class="fork__pair">
      <div class="fork__side">
        <header class="fork__head">
          <h3 class="eyebrow">Parent · {{ parent.trajectoryId }}</h3>
          <span class="t-mono fork__count">{{ parentSnap?.stepCount ?? 0 }} steps</span>
        </header>
        <hr class="rule" />
        <LifeLog :steps="parentSnap?.steps ?? []" :now="parentSnap?.now ?? 0" height="180px" />
        <PacingLadder :config="config" :state="parent.pacer()" :height="180" />
      </div>
      <div class="fork__side">
        <header class="fork__head">
          <h3 class="eyebrow">Fork · {{ child?.trajectoryId }}</h3>
          <span class="t-mono fork__count">{{ childSnap?.stepCount ?? 0 }} steps</span>
        </header>
        <hr class="rule" />
        <LifeLog :steps="childSnap?.steps ?? []" :now="childSnap?.now ?? 0" height="180px" />
        <PacingLadder :config="config" :state="child?.pacer()" :height="180" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.fork {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}

.fork__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-12);
}

.fork__slider {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 220px;
}

.fork__receipt {
  margin: 0;
  font-size: var(--text-caption-size);
  color: var(--ink-micro);
}

.fork__diverged {
  color: var(--accent-warn);
  font-weight: 700;
}

.fork__hint {
  margin: 0;
  color: var(--ink-receded-plus);
}

.fork__pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--space-24);
}

.fork__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-8);
}

.fork__head h3 {
  margin: 0;
}

.fork__count {
  font-size: var(--text-caption-size);
  color: var(--ink-receded-plus);
}
</style>
