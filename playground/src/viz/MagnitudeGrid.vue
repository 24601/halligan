<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { prefersReducedMotion } from '../lib/ui.js';

/**
 * Generalized from modyl-live's `AudioWaveformGrid`: the same maths (normalized
 * [0,1] per column, lit when band[x] >= |mid - y| / (mid + 1), symmetric from
 * the centre row), fed by ANY bounded magnitude series. It is the only
 * sanctioned liveness signal in Pry because it is DATA -- a quantized magnitude
 * per column -- and not a mood.
 *
 * Decay is quantized, not eased: instant peak attack, a stepped 12fps
 * step-down, the way a real LED peak meter behaves.
 */
const props = withDefaults(
  defineProps<{
    /** One magnitude in [0,1] per column, oldest first. */
    bands: readonly number[];
    rows?: number;
    size?: 'icon' | 'sm' | 'md' | 'lg';
    label?: string;
  }>(),
  { rows: 15, size: 'sm', label: 'activity' }
);

const dot = computed(
  () => ({ icon: 2, sm: 4, md: 8, lg: 12 })[props.size] ?? 4
);
const rowCount = computed(() => Math.min(31, Math.max(3, props.rows | 1)));
const mid = computed(() => (rowCount.value - 1) / 2);

/** The decayed envelope. Peak is instantaneous; release steps down 12 times a
 * second by a fixed quantum, so the meter never eases and never shimmers. */
const held = ref<number[]>([]);
const QUANTUM = 1 / 12;
let timer: ReturnType<typeof setInterval> | undefined;

function reconcile(next: readonly number[]): void {
  const out = next.map((value, index) =>
    Math.max(0, Math.min(1, Math.max(value, held.value[index] ?? 0)))
  );
  held.value = out;
}

watch(
  () => props.bands,
  (next) => reconcile(next),
  { immediate: true, deep: true }
);

if (!prefersReducedMotion()) {
  timer = setInterval(() => {
    if (held.value.length === 0) return;
    held.value = held.value.map((value, index) =>
      Math.max(props.bands[index] ?? 0, value - QUANTUM)
    );
  }, 1000 / 12);
}

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const cells = computed(() => {
  const columns = held.value;
  const rows = rowCount.value;
  const out: boolean[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < columns.length; x++) {
      const magnitude = columns[x] ?? 0;
      row.push(magnitude >= Math.abs(mid.value - y) / (mid.value + 1));
    }
    out.push(row);
  }
  return out;
});
</script>

<template>
  <div
    class="grid pry-component"
    role="img"
    :aria-label="label"
    :style="{
      gridTemplateColumns: `repeat(${held.length}, ${dot}px)`,
      gap: `${Math.max(1, Math.round(dot / 2))}px`,
    }"
  >
    <template v-for="(row, y) in cells" :key="y">
      <i
        v-for="(lit, x) in row"
        :key="`${y}-${x}`"
        aria-hidden="true"
        :class="{ lit }"
        :style="{ width: `${dot}px`, height: `${dot}px` }"
      />
    </template>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-auto-flow: row;
  color: var(--wave-stroke-live);
}

i {
  display: block;
  background: currentColor;
  opacity: 0.1;
  transition: opacity var(--dur-micro) linear;
}

i.lit {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  i {
    transition: none;
  }
}
</style>
