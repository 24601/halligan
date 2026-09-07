<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Reimplementation of the modyl-live `FriendlyTime` contract: relative label by
 * default, absolute on hover / focus-visible / press-lock, a visually hidden
 * `<time datetime>` for semantics, tabular numerals, `cursor: help`, Esc
 * unlocks. Pry ALWAYS passes `now` from the demo's own manual clock, which is
 * what keeps a seeded demo reproducible.
 */
const props = withDefaults(
  defineProps<{
    ts: number;
    /** Controlled clock. When absent the component runs a 60s wall clock. */
    now?: number;
    timeZone?: string;
  }>(),
  { timeZone: 'UTC' }
);

const wall = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  if (props.now === undefined) {
    timer = setInterval(() => {
      wall.value = Date.now();
    }, 60_000);
  }
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const reference = computed(() => props.now ?? wall.value);
const locked = ref(false);
const hovered = ref(false);
const focused = ref(false);
const absolute = computed(() => locked.value || hovered.value || focused.value);

const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

const relativeLabel = computed(() => {
  const delta = props.ts - reference.value;
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (Math.abs(delta) >= ms)
      return format.format(Math.round(delta / ms), unit);
  }
  return format.format(0, 'second');
});

// `timeZoneName` cannot be combined with `dateStyle`/`timeStyle` -- the
// combination throws -- so the components are spelled out.
const absoluteLabel = computed(() =>
  new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: props.timeZone,
    timeZoneName: 'short',
  }).format(new Date(props.ts))
);

const iso = computed(() => new Date(props.ts).toISOString());

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && locked.value) {
    locked.value = false;
    event.stopPropagation();
  }
}
</script>

<template>
  <button
    type="button"
    class="friendly pry-component t-caption"
    :aria-pressed="locked"
    @click="locked = !locked"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focus="focused = true"
    @blur="focused = false"
    @keydown="onKeydown"
  >
    <time class="visually-hidden" :datetime="iso">{{ absoluteLabel }}</time>
    <span aria-hidden="true">{{ absolute ? absoluteLabel : relativeLabel }}</span>
  </button>
</template>

<style scoped>
.friendly {
  padding: 0;
  color: var(--ink-receded-plus);
  cursor: help;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.friendly:hover,
.friendly:focus-visible {
  color: var(--ink-read);
}
</style>
