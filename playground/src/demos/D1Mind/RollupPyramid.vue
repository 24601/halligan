<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { AxTrajectoryRollupBlock } from '../../lib/axImport.js';
import { prefersReducedMotion } from '../../lib/ui.js';
import { useCrosshair } from '../../viz/useCrosshair.js';
import { blockKey } from './mindLife.js';

/**
 * The tiered rollup pyramid, read out of `AxInMemoryTrajectoryRollupStore`.
 * A block at tier k covers `fanout^k` filtered steps; width is proportional to
 * the steps it covers. The projection's chosen descent is drawn as the blocks
 * it actually selected -- everything else is `--surface-2`, so the reader sees
 * that most of the pyramid is NOT rendered into the context.
 *
 * When a raw window seals, the new block performs a FLIP from the raw band it
 * came from: 150ms, zero overshoot. That is a committed state change and
 * continuity across a layout change -- two of the four sanctioned reasons for
 * anything to move.
 */
const props = defineProps<{
  blocks: readonly Readonly<AxTrajectoryRollupBlock>[];
  onPath: ReadonlySet<string>;
  recentCount: number;
  sealedIndex: number;
  fanout: number;
  height?: string;
}>();

const tiers = computed(() => {
  const map = new Map<number, Readonly<AxTrajectoryRollupBlock>[]>();
  for (const block of props.blocks) {
    const list = map.get(block.tier) ?? [];
    list.push(block);
    map.set(block.tier, list);
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([tier, list]) => ({
      tier,
      blocks: [...list].sort((a, b) => a.start - b.start),
    }));
});

const covered = computed(() => Math.max(1, props.sealedIndex));
const raw = ref<HTMLElement | null>(null);
const known = new Set<string>();
const root = ref<HTMLElement | null>(null);

/** FLIP: first rect is the raw band the steps came from, last is the block. */
async function sealIn(keys: readonly string[]): Promise<void> {
  if (prefersReducedMotion()) return;
  const source = raw.value?.getBoundingClientRect();
  const container = root.value;
  if (!source || !container) return;
  await nextTick();
  for (const key of keys) {
    const element = container.querySelector<HTMLElement>(
      `[data-block="${key}"]`
    );
    if (!element) continue;
    const target = element.getBoundingClientRect();
    if (target.width === 0) continue;
    const dx =
      source.left + source.width / 2 - (target.left + target.width / 2);
    const dy = source.top - target.top;
    const sx = Math.max(0.05, source.width / target.width);
    element.style.transition = 'none';
    element.style.transformOrigin = 'center';
    element.style.transform = `translate(${dx}px, ${dy}px) scaleX(${sx})`;
    element.style.opacity = '0.35';
    void element.offsetWidth;
    element.style.transition =
      'transform 150ms cubic-bezier(0,0,0.2,1), opacity 150ms cubic-bezier(0,0,0.2,1)';
    element.style.transform = '';
    element.style.opacity = '';
  }
}

watch(
  () => props.blocks.map(blockKey).join('|'),
  () => {
    const fresh = props.blocks.map(blockKey).filter((key) => !known.has(key));
    for (const key of props.blocks.map(blockKey)) known.add(key);
    if (fresh.length > 0 && known.size > fresh.length) void sealIn(fresh);
  },
  { immediate: true }
);

const { onPointerMove, onPointerLeave } = useCrosshair({
  figure: 'ROLLUP',
  format: (fx) => ({
    x: `IDX_${Math.round(fx * covered.value)
      .toString()
      .padStart(4, '0')}`,
    y: 'TIER',
  }),
});

const describe = (block: Readonly<AxTrajectoryRollupBlock>): string =>
  `tier ${block.tier}, steps ${block.start}-${block.end}, ${block.n} covered${
    props.onPath.has(blockKey(block)) ? ', on the projection path' : ''
  }: ${block.summary}`;
</script>

<template>
  <figure
    ref="root"
    class="pyr pry-component"
    :style="{ minHeight: height }"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <figcaption class="visually-hidden">
      Tiered rollup pyramid: {{ blocks.length }} sealed blocks over
      {{ sealedIndex }} filtered steps, {{ onPath.size }} of them on the current
      projection path.
    </figcaption>

    <div v-if="tiers.length === 0" class="pyr__pending t-caption">
      No block sealed yet — a tier-1 block seals every {{ fanout }} narrative steps.
    </div>

    <div v-for="row in tiers" :key="row.tier" class="pyr__tier">
      <span class="pyr__tier-label t-mono">T{{ row.tier }}</span>
      <div class="pyr__row">
        <span
          v-for="block in row.blocks"
          :key="blockKey(block)"
          :data-block="blockKey(block)"
          class="pyr__block"
          :class="{ 'is-path': onPath.has(blockKey(block)) }"
          :style="{ flexGrow: block.n }"
          :title="describe(block)"
        >
          <span class="pyr__block-n t-mono">{{ block.n }}</span>
        </span>
      </div>
    </div>

    <div class="pyr__tier">
      <span class="pyr__tier-label t-mono">RAW</span>
      <div class="pyr__row">
        <span ref="raw" class="pyr__raw">
          <span class="pyr__block-n t-mono">{{ recentCount }} verbatim</span>
        </span>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.pyr {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
}

.pyr__pending {
  color: var(--ink-receded-plus);
  padding-block: var(--space-8);
}

.pyr__tier {
  display: grid;
  grid-template-columns: 3.5ch minmax(0, 1fr);
  align-items: center;
  gap: var(--space-8);
}

.pyr__tier-label {
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}

.pyr__row {
  display: flex;
  gap: 2px;
  min-height: 26px;
}

.pyr__block {
  display: grid;
  place-items: center;
  min-width: 8px;
  border: 1px solid var(--hairline-strong);
  background: var(--surface-2);
  /* An off-path block is receded, not illegible: --surface-2 is a step up
   * from the ground, so its text needs class-A ink to stay above 4.5:1. */
  color: var(--ink-micro);
  overflow: hidden;
}

/* On-path blocks are the ones the projection actually renders. The difference
 * is a border weight and a fill step, not a hue: it survives grayscale. */
.pyr__block.is-path {
  border-color: var(--ink-full);
  border-width: 1px;
  background: var(--ground);
  color: var(--ink-full);
  box-shadow: inset 0 0 0 1px var(--ink-full);
}

.pyr__block-n {
  font-size: var(--text-micro-size);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.pyr__raw {
  display: grid;
  place-items: center;
  flex: 1;
  min-height: 26px;
  border: 1px solid var(--ink-full);
  border-left-width: 2px;
  background: var(--ground);
  color: var(--ink-full);
}
</style>
