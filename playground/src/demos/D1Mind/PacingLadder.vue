<script setup lang="ts">
import { computed } from 'vue';
import type {
  AxMindPacerConfig,
  AxMindPacerState,
} from '../../lib/axImport.js';
import { axMindPaceDelay } from '../../lib/axImport.js';
import { useCrosshair } from '../../viz/useCrosshair.js';

/**
 * The pacing ladder, drawn from the shipped formula and nothing else:
 * `delay(0) = 0; delay(n >= 1) = min(baseMs * factor^(n-1), capMs)`, plotted on
 * a log axis. The travelling mark is the pacer's own `level`; the dwell trail
 * is its own `ticks` against `hold`.
 *
 * Under `prefers-reduced-motion` nothing animates and nothing is lost: every
 * rung prints its level number and its delay, and the current rung carries a
 * filled glyph and the word "current".
 */
const props = defineProps<{
  config: Readonly<AxMindPacerConfig>;
  state: Readonly<AxMindPacerState> | undefined;
  height?: number;
}>();

const H = computed(() => props.height ?? 300);
const PAD = 18;

const maxLevel = computed(() => {
  let level = 1;
  while (
    level < 24 &&
    axMindPaceDelay(level, props.config) < props.config.capMs
  ) {
    level += 1;
  }
  return level;
});

const rungs = computed(() =>
  Array.from({ length: maxLevel.value + 1 }, (_, level) => {
    const delayMs = axMindPaceDelay(level, props.config);
    return { level, delayMs, y: yFor(delayMs, level) };
  })
);

function yFor(delayMs: number, level: number): number {
  const top = PAD;
  const bottom = H.value - PAD;
  if (level === 0) return top;
  const lo = Math.log(props.config.baseMs);
  const hi = Math.log(props.config.capMs);
  const t = hi === lo ? 1 : (Math.log(delayMs) - lo) / (hi - lo);
  // rung 0 sits on its own line above the log axis: delay 0 has no logarithm,
  // and pretending otherwise would be a drawn lie.
  return top + 26 + t * (bottom - top - 26);
}

const current = computed(() => props.state?.level ?? 0);
const currentY = computed(
  () => rungs.value[Math.min(current.value, rungs.value.length - 1)]?.y ?? PAD
);

const label = (ms: number): string => {
  if (ms === 0) return '0';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.round(ms / 6000) / 10}m`;
};

const { onPointerMove, onPointerLeave } = useCrosshair({
  figure: 'LADDER',
  format: (_fx, fy) => {
    const y = fy * H.value;
    const nearest = rungs.value.reduce((best, rung) =>
      Math.abs(rung.y - y) < Math.abs(best.y - y) ? rung : best
    );
    return {
      x: `${label(nearest.delayMs).padStart(6, ' ')}`,
      y: `RUNG_${String(nearest.level).padStart(2, '0')}`,
    };
  },
});

const dwell = computed(() => {
  const hold = Math.max(1, props.config.hold);
  const ticks = Math.min(props.state?.ticks ?? 0, hold);
  return Array.from({ length: hold }, (_, index) => index < ticks);
});
</script>

<template>
  <figure class="ladder pry-component" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
    <svg
      :viewBox="`0 0 220 ${H}`"
      :height="H"
      width="100%"
      role="img"
      aria-labelledby="ladder-title ladder-desc"
      preserveAspectRatio="xMidYMid meet"
    >
      <title id="ladder-title">Pacing ladder</title>
      <desc id="ladder-desc">
        Rung {{ current }} of {{ maxLevel }}. Next spontaneous wake in
        {{ label(rungs[Math.min(current, rungs.length - 1)]?.delayMs ?? 0) }}.
      </desc>

      <line
        x1="34"
        :y1="PAD"
        x2="34"
        :y2="H - PAD"
        stroke="var(--hairline-strong)"
        stroke-width="1"
      />

      <g v-for="rung in rungs" :key="rung.level">
        <line
          x1="34"
          :y1="rung.y"
          :x2="rung.level === current ? 150 : 96"
          :y2="rung.y"
          :stroke="rung.level === current ? 'var(--ink-full)' : 'var(--hairline-strong)'"
          :stroke-width="rung.level === current ? 2 : 1"
        />
        <text
          x="28"
          :y="rung.y + 3.5"
          text-anchor="end"
          class="ladder__level"
          :class="{ 'is-current': rung.level === current }"
        >
          {{ rung.level }}
        </text>
        <text x="156" :y="rung.y + 3.5" class="ladder__delay">
          {{ label(rung.delayMs) }}
        </text>
      </g>

      <rect
        :x="30"
        :y="currentY - 4"
        width="8"
        height="8"
        fill="var(--ink-full)"
        class="ladder__mark"
      />
    </svg>

    <figcaption class="ladder__foot">
      <span class="ladder__now t-mono">
        <span aria-hidden="true">■</span> rung {{ current }} ·
        {{ current > maxLevel ? 'at cap' : 'current' }}
      </span>
      <span
        class="ladder__dwell"
        role="img"
        :aria-label="`dwell ${state?.ticks ?? 0} of ${config.hold}`">
        <i v-for="(filled, index) in dwell" :key="index" :class="{ filled }" />
      </span>
      <span class="ladder__hold t-caption">
        dwell {{ state?.ticks ?? 0 }}/{{ config.hold }}
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.ladder {
  margin: 0;
}

.ladder__level {
  font-family: var(--font-mono);
  font-size: 9.5px;
  fill: var(--ink-receded);
}

.ladder__level.is-current {
  fill: var(--ink-full);
  font-weight: 700;
}

.ladder__delay {
  font-family: var(--font-mono);
  font-size: 9.5px;
  fill: var(--ink-receded);
}

.ladder__mark {
  transition: y 150ms cubic-bezier(0, 0, 0.2, 1);
}

@media (prefers-reduced-motion: reduce) {
  .ladder__mark {
    transition: none;
  }
}

.ladder__foot {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding-top: var(--space-8);
  border-top: 1px solid var(--hairline);
  font-size: var(--text-caption-size);
  color: var(--ink-micro);
}

.ladder__dwell {
  display: inline-flex;
  gap: 3px;
}

.ladder__dwell i {
  width: var(--grid-cell);
  height: var(--grid-cell);
  background: currentColor;
  opacity: 0.1;
}

.ladder__dwell i.filled {
  opacity: 1;
}

.ladder__hold {
  color: var(--ink-receded-plus);
}
</style>
