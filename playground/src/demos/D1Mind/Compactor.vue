<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  type AxTrajectoryProjection,
  axTrajectoryContextBudget,
  axTrajectoryDefaultBudgetTokens,
  axTrajectoryRecentSize,
  axTrajectoryTokensPerStep,
} from '../../lib/axImport.js';
import { useCrosshair } from '../../viz/useCrosshair.js';
import type { Life } from './mindLife.js';

/**
 * The context-window compactor. Slide a context limit from 2k to 128k tokens
 * over a long real transcript and watch what the tiered rollup projection keeps
 * VERBATIM against what it hands over as a summary.
 *
 * The lesson is in the formula, not in the picture:
 * `budget = min(fraction * window, maxTokens)`. A bigger window is not
 * permission to spend it, so past the default 4,000-token cap the slider stops
 * buying anything -- which is exactly what the shipped code does, and why the
 * cap has its own switch here rather than being quietly lifted.
 */
const props = defineProps<{ life: Life | null; ready: boolean }>();

const WINDOWS = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000];
const at = ref(4);
const liftCap = ref(false);
const projection = ref<Readonly<AxTrajectoryProjection> | null>(null);
const pending = ref(false);

/**
 * A projection over a thousand-step log is the most expensive read on this
 * page, so it does not run until the reader has actually scrolled the
 * compactor into view. Computing a control nobody is looking at is how a page
 * that is doing real work ends up feeling slow.
 */
const root = ref<HTMLElement | null>(null);
const visible = ref(false);
let observer: IntersectionObserver | undefined;

onMounted(() => {
  const element = root.value;
  if (!element || typeof IntersectionObserver === 'undefined') {
    visible.value = true;
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) visible.value = true;
    },
    { rootMargin: '200px' }
  );
  observer.observe(element);
});

onBeforeUnmount(() => observer?.disconnect());

const windowTokens = computed(() => WINDOWS[at.value] ?? 32_000);
const budget = computed(() =>
  axTrajectoryContextBudget({
    contextWindowTokens: windowTokens.value,
    ...(liftCap.value ? { maxTokens: windowTokens.value } : {}),
  })
);
const recentSize = computed(() => axTrajectoryRecentSize(budget.value));
const capBinds = computed(
  () =>
    !liftCap.value && 0.6 * windowTokens.value > axTrajectoryDefaultBudgetTokens
);

async function recompute(): Promise<void> {
  const life = props.life;
  if (!life || !props.ready || !visible.value) return;
  pending.value = true;
  try {
    projection.value = await life.project(budget.value);
  } finally {
    pending.value = false;
  }
}

watch(
  [budget, () => props.ready, () => props.life, visible],
  () => void recompute(),
  { immediate: true }
);

const summarised = computed(
  () =>
    projection.value?.life.filter((section) => section.kind === 'summary') ?? []
);
const verbatim = computed(() => projection.value?.recent.length ?? 0);
const coveredBySummary = computed(() =>
  summarised.value.reduce(
    (total, section) =>
      section.kind === 'summary'
        ? total + (section.block.end - section.block.start)
        : total,
    0
  )
);

const { onPointerMove, onPointerLeave } = useCrosshair({
  figure: 'COMPACTOR',
  format: (fx) => {
    const i = Math.min(
      WINDOWS.length - 1,
      Math.round(fx * (WINDOWS.length - 1))
    );
    return {
      x: `${(WINDOWS[i] ?? 0) / 1000}k_WINDOW`,
      y: `${budget.value}_TOK`,
    };
  },
});
</script>

<template>
  <section ref="root" class="comp pry-component" aria-label="Context window compactor">
    <div class="comp__controls" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
      <label class="comp__slider">
        <span class="t-label">
          Context window
          <span class="t-mono comp__value">{{ windowTokens.toLocaleString() }} tokens</span>
        </span>
        <input v-model.number="at" type="range" min="0" :max="WINDOWS.length - 1" step="1" />
      </label>
      <button
        type="button"
        class="ctl"
        :aria-pressed="liftCap"
        :class="{ 'is-on': liftCap }"
        @click="liftCap = !liftCap"
      >
        {{ liftCap ? 'maxTokens = window' : `maxTokens = ${axTrajectoryDefaultBudgetTokens}` }}
      </button>
    </div>

    <p class="comp__formula t-mono">
      budget = min(0.6 &times; {{ windowTokens.toLocaleString() }},
      {{ (liftCap ? windowTokens : axTrajectoryDefaultBudgetTokens).toLocaleString() }})
      = <strong>{{ budget.toLocaleString() }}</strong> tok &nbsp;·&nbsp; R = max(20,
      floor(0.4 &times; {{ budget.toLocaleString() }} / {{ axTrajectoryTokensPerStep }})) =
      <strong>{{ recentSize }}</strong> steps
    </p>
    <p v-if="capBinds" class="comp__warn t-caption">
      the cap is binding: the window is bigger, the budget is not
    </p>

    <div class="comp__bar" role="img" :aria-label="`${coveredBySummary} steps summarised, ${verbatim} kept verbatim`">
      <span
        v-for="section in summarised"
        :key="section.kind === 'summary' ? `${section.block.tier}-${section.block.start}` : 'x'"
        class="comp__seg comp__seg--sum"
        :style="{
          flexGrow:
            section.kind === 'summary' ? section.block.end - section.block.start : 1,
        }"
      >
        <span class="t-micro">
          T{{ section.kind === 'summary' ? section.block.tier : 0 }}
        </span>
      </span>
      <span class="comp__seg comp__seg--raw" :style="{ flexGrow: Math.max(1, verbatim) }">
        <span class="t-micro">{{ verbatim }} verbatim</span>
      </span>
    </div>

    <dl class="comp__facts">
      <div>
        <dt class="t-label">Summarised</dt>
        <dd class="t-mono">{{ coveredBySummary }} steps in {{ summarised.length }} sections</dd>
      </div>
      <div>
        <dt class="t-label">Verbatim</dt>
        <dd class="t-mono">{{ verbatim }} steps · R {{ recentSize }}</dd>
      </div>
      <div>
        <dt class="t-label">Rendered</dt>
        <dd class="t-mono">{{ projection?.estimatedTokens ?? 0 }} tok</dd>
      </div>
      <div>
        <dt class="t-label">Gaps</dt>
        <dd class="t-mono">
          {{ projection?.coverage.gaps.length ?? 0 }}
        </dd>
      </div>
    </dl>

    <p class="comp__pending t-caption" aria-live="polite">
      <template v-if="!ready">seeding the transcript this slider runs over&hellip;</template>
      <template v-else-if="pending">re-projecting&hellip;</template>
      <template v-else>&nbsp;</template>
    </p>

    <details class="comp__render">
      <summary class="t-label">What the mind would actually be handed</summary>
      <pre class="t-mono comp__pre">{{ projection?.render ?? '' }}</pre>
    </details>
  </section>
</template>

<style scoped>
.comp {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}

.comp__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-16);
}

.comp__slider {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 280px;
  flex: 1;
}

.comp__value {
  margin-left: var(--space-8);
  color: var(--ink-full);
}

.comp__formula {
  margin: 0;
  font-size: var(--text-caption-size);
  color: var(--ink-micro);
}

.comp__formula strong {
  color: var(--ink-full);
}

.comp__warn {
  margin: 0;
  padding-left: var(--space-8);
  border-left: 2px solid var(--accent-warn);
  color: var(--ink-micro);
}

.comp__bar {
  display: flex;
  gap: 2px;
  min-height: 30px;
}

.comp__seg {
  display: grid;
  place-items: center;
  min-width: 10px;
  overflow: hidden;
  border: 1px solid var(--hairline-strong);
  color: var(--ink-receded);
  white-space: nowrap;
}

.comp__seg--sum {
  background: var(--surface-2);
}

.comp__seg--raw {
  border-color: var(--ink-full);
  border-left-width: 2px;
  background: var(--ground);
  color: var(--ink-full);
}

.comp__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-12);
  margin: 0;
}

.comp__facts dt {
  margin: 0;
  color: var(--ink-receded-plus);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.comp__facts dd {
  margin: 0;
  font-size: var(--text-caption-size);
  color: var(--ink-full);
}

.comp__pending {
  margin: 0;
  color: var(--ink-receded-plus);
}

.comp__render summary {
  cursor: pointer;
  color: var(--ink-receded-plus);
}

.comp__pre {
  max-height: 260px;
  overflow: auto;
  margin: var(--space-8) 0 0;
  padding: var(--space-12);
  background: var(--surface-1);
  border-radius: var(--radius-control);
  color: var(--ink-read);
  font-size: var(--text-caption-size);
  white-space: pre-wrap;
}
</style>
