<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import MagnitudeGrid from '../../viz/MagnitudeGrid.vue';
import { useCrosshair } from '../../viz/useCrosshair.js';
import type { Checkpoint } from './archive.js';

/**
 * The time-warp scrubber. Every value it prints was computed at that instant
 * by the real functions while the life was being lived: the pacer level by the
 * pacer, the budget by `axTrajectoryContextBudget`, the projection by
 * `axProjectTrajectory`, the sealed blocks by `axBuildTrajectoryRollups`.
 * Scrubbing SNAPS to the nearest recorded checkpoint; the readout says which.
 */
const props = defineProps<{
  checkpoints: readonly Checkpoint[];
  progress: number;
  target: number;
  seeding: boolean;
}>();

const at = ref(0);
const touched = ref(false);

// Land on the newest checkpoint, not the empty first one: the interesting
// state is the life that was lived, and scrubbing BACK is the gesture.
watch(
  () => props.checkpoints.length,
  (length) => {
    if (!touched.value) at.value = Math.max(0, length - 1);
  }
);
const index = computed(() =>
  Math.min(Math.max(0, at.value), Math.max(0, props.checkpoints.length - 1))
);
const point = computed<Checkpoint | undefined>(
  () => props.checkpoints[index.value]
);

const hours = (ms: number): string => {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round(h / 24)} d`;
};

/** Spontaneous wakes still inside the pacer's own rolling hour, normalized by
 * the fuse ceiling. A bounded magnitude series -- data, not decoration. */
const bands = computed(() => {
  const values = props.checkpoints.map((cp) => cp.wakesInWindow);
  const peak = Math.max(1, ...values);
  const window = values.slice(Math.max(0, index.value - 23), index.value + 1);
  return window.map((value) => value / peak);
});

const { onPointerMove, onPointerLeave } = useCrosshair({
  figure: 'TIMEWARP',
  format: (fx) => {
    const i = Math.round(fx * Math.max(0, props.checkpoints.length - 1));
    const cp = props.checkpoints[i];
    return {
      x: cp ? `T+${hours(cp.simMs)}` : 'T+0',
      y: cp ? `STEP_${String(cp.stepCount).padStart(4, '0')}` : 'STEP_0000',
    };
  },
});
</script>

<template>
  <section class="warp pry-component" aria-label="Time warp">
    <header class="warp__head">
      <span class="eyebrow">Time warp</span>
      <span class="warp__state t-caption">
        <template v-if="seeding">
          seeding a life &mdash; {{ progress }}/{{ target }} steps
        </template>
        <template v-else>
          {{ checkpoints.length }} checkpoints over
          {{ hours(checkpoints[checkpoints.length - 1]?.simMs ?? 0) }} of simulated life
        </template>
      </span>
    </header>

    <div class="warp__scrub" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
      <label class="visually-hidden" for="warp-range">Scrub the pre-seeded life</label>
      <input
        id="warp-range"
        v-model.number="at"
        type="range"
        min="0"
        :max="Math.max(0, checkpoints.length - 1)"
        step="1"
        :disabled="checkpoints.length < 2"
        @input="touched = true"
      />
    </div>

    <dl class="warp__read">
      <div class="warp__cell">
        <dt class="t-label">Step</dt>
        <dd class="t-mono">{{ point?.stepCount ?? 0 }}</dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Elapsed</dt>
        <dd class="t-mono">{{ hours(point?.simMs ?? 0) }}</dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Rung</dt>
        <dd class="t-mono">{{ point?.level ?? 0 }} · dwell {{ point?.ticks ?? 0 }}</dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Budget</dt>
        <dd class="t-mono">{{ point?.budgetTokens ?? 0 }} tok</dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Verbatim</dt>
        <dd class="t-mono">
          {{ point?.recentCount ?? 0 }} · R {{ point?.recentSize ?? 0 }}
        </dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Rendered</dt>
        <dd class="t-mono">{{ point?.estimatedTokens ?? 0 }} tok</dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Sealed</dt>
        <dd class="t-mono">{{ point?.blocks ?? 0 }} blocks · idx {{ point?.sealedIndex ?? 0 }}</dd>
      </div>
      <div class="warp__cell">
        <dt class="t-label">Wakes/hour window</dt>
        <dd class="t-mono">{{ point?.wakesInWindow ?? 0 }}</dd>
      </div>
    </dl>

    <div class="warp__path">
      <span class="t-label warp__path-label">Projection descent at this instant</span>
      <span v-if="(point?.sections.length ?? 0) === 0" class="t-caption warp__path-empty">
        every filtered step is still verbatim — nothing has been summarised yet
      </span>
      <span v-else class="warp__path-blocks">
        <span
          v-for="section in point?.sections ?? []"
          :key="`${section.tier}-${section.start}`"
          class="warp__path-block t-mono"
          :style="{ flexGrow: section.end - section.start }"
        >
          T{{ section.tier }} {{ section.start }}–{{ section.end }}
        </span>
        <span class="warp__path-raw t-mono">raw {{ point?.recentCount ?? 0 }}</span>
      </span>
    </div>

    <div class="warp__meter">
      <MagnitudeGrid :bands="bands" :rows="9" size="sm" label="spontaneous wakes inside the pacer's rolling hour" />
      <span class="t-micro warp__meter-label">
        spontaneous wakes in the pacer's own rolling hour, last 24 checkpoints
      </span>
    </div>
  </section>
</template>

<style scoped>
.warp {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}

.warp__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-12);
}

.warp__state {
  color: var(--ink-receded-plus);
}

.warp__scrub {
  padding-block: var(--space-4);
}

.warp__read {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-12);
  margin: 0;
  padding-top: var(--space-8);
  border-top: 1px solid var(--hairline);
}

.warp__cell dt {
  margin: 0;
  color: var(--ink-receded-plus);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.warp__cell dd {
  margin: 0;
  color: var(--ink-full);
  font-size: var(--text-body-size);
}

.warp__path {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.warp__path-label,
.warp__path-empty {
  color: var(--ink-receded-plus);
}

.warp__path-blocks {
  display: flex;
  gap: 2px;
  min-height: 22px;
}

.warp__path-block,
.warp__path-raw {
  display: grid;
  place-items: center;
  padding-inline: 4px;
  border: 1px solid var(--ink-full);
  font-size: var(--text-micro-size);
  white-space: nowrap;
  overflow: hidden;
}

.warp__path-raw {
  border-left-width: 2px;
  flex: 0 0 auto;
}

.warp__meter {
  display: flex;
  align-items: center;
  gap: var(--space-12);
}

.warp__meter-label {
  color: var(--ink-receded);
}
</style>
