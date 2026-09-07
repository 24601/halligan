<script setup lang="ts">
import { computed } from 'vue';
import type { DemoEntry } from '../lib/demos.js';

/**
 * Reimplementation of the modyl-live `DoorCard`: the ONE bordered surface in
 * the house. 1px hairline, --radius-card, --ground going to --surface-1 on
 * hover, a 2px ink-edged "sliver" preview, name at heading-20/700, headline at
 * body/400. Depth is a surface step plus a hairline; --shadow stays none.
 *
 * State is carried by glyph + word, never colour alone.
 */
const props = defineProps<{ demo: DemoEntry }>();
const emit = defineEmits<{ open: [id: string] }>();

const base = import.meta.env.BASE_URL;
const sliverSrc = computed(() => `${base}${props.demo.sliver}`);
const live = computed(() => props.demo.status === 'live');
</script>

<template>
  <component
    :is="live ? 'button' : 'div'"
    class="card pry-component"
    :class="{ 'card--planned': !live }"
    :type="live ? 'button' : undefined"
    @click="live && emit('open', demo.id)"
  >
    <span class="card__sliver">
      <img :src="sliverSrc" alt="" width="240" height="120" loading="lazy" />
    </span>
    <span class="card__body">
      <span class="card__id t-mono">{{ demo.id }}</span>
      <span class="card__name t-h20">{{ demo.name }}</span>
      <span class="card__kicker t-caption">{{ demo.kicker }}</span>
      <span class="card__headline t-body">{{ demo.headline }}</span>
    </span>
    <span class="card__foot">
      <span class="card__state">
        <span class="card__glyph" aria-hidden="true">{{ live ? '■' : '□' }}</span>
        <span>{{ live ? 'Live' : `Planned · ${demo.lane}` }}</span>
      </span>
      <span class="card__runs t-caption">{{ demo.runsWhere }}</span>
    </span>
  </component>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
  width: 100%;
  padding: var(--space-16);
  text-align: left;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  background: var(--ground);
  box-shadow: var(--shadow);
  transition: background-color var(--dur-micro) var(--ease-snap),
    border-color var(--dur-micro) var(--ease-snap);
}

button.card:hover {
  background: var(--surface-1);
  border-color: var(--hairline-strong);
}

.card--planned {
  cursor: default;
}

.card__sliver {
  display: block;
  overflow: hidden;
  border-left: 2px solid var(--ink-full);
  background: var(--surface-1);
  border-radius: 2px;
}

.card__sliver img {
  display: block;
  width: 100%;
  height: 96px;
  object-fit: cover;
  object-position: top left;
}

.card--planned .card__sliver {
  border-left-color: var(--ink-ghost);
  background-image: var(--hatch);
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.card__id {
  color: var(--ink-receded);
  font-size: var(--text-caption-size);
  letter-spacing: 0.08em;
}

.card__name {
  font-weight: 700;
  color: var(--ink-full);
}

.card__kicker {
  color: var(--ink-receded-plus);
}

.card__headline {
  color: var(--ink-read);
  max-width: 46ch;
}

.card__foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-12);
  margin-top: auto;
  padding-top: var(--space-12);
  border-top: 1px solid var(--hairline);
  font-size: var(--text-caption-size);
  color: var(--ink-receded-plus);
}

.card__state {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ink-micro);
}

.card__glyph {
  color: var(--accent);
}

.card--planned .card__glyph {
  color: var(--ink-receded);
}

.card__runs {
  text-align: right;
}
</style>
