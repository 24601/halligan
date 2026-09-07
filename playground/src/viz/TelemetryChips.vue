<script setup lang="ts">
import type { Chip } from '../lib/chips.js';

defineProps<{ chips: readonly Chip[]; align?: 'start' | 'end' }>();
</script>

<template>
  <ul
    class="chips pry-component"
    :style="{ justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }"
  >
    <li
      v-for="item in chips"
      :key="item.key"
      class="chip"
      :class="[`chip--${item.tone ?? 'neutral'}`, { 'chip--unmeasured': item.unmeasured }]"
      :title="item.title"
    >
      <span class="chip__key">{{ item.key }}</span>
      <span class="chip__value">{{ item.value }}</span>
      <span v-if="item.title" class="visually-hidden">{{ item.title }}</span>
    </li>
  </ul>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid var(--hairline-strong);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: var(--text-caption-size);
  line-height: 1.45;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
  color: var(--ink-micro);
  white-space: nowrap;
}

.chip__key {
  color: var(--ink-receded);
}

.chip__key::after {
  content: ":";
  color: var(--ink-receded);
}

.chip__value {
  color: var(--ink-full);
  font-weight: 400;
}

/* Colour never carries meaning alone: each tone also changes the left edge
 * weight, which survives a grayscale screenshot. */
.chip--machine {
  border-left: 2px solid var(--accent-info);
}

.chip--ok {
  border-left: 2px solid var(--accent);
}

.chip--warn {
  border-left: 2px solid var(--accent-warn);
  background-image: var(--hatch);
  background-size: 100% 100%;
}

.chip--danger {
  border-left: 2px solid var(--accent-danger);
}

.chip--unmeasured .chip__value {
  color: var(--ink-receded-plus);
  cursor: help;
}
</style>
