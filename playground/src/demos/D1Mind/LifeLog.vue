<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { AxTrajectoryStep } from '../../lib/axImport.js';
import FriendlyTime from '../../viz/FriendlyTime.vue';
import { THINKER } from './mindLife.js';

/**
 * The life log: a hairline-separated stream of real trajectory steps. One row
 * per step, `[mono type] [700 content] [FriendlyTime]`, with a filled teal
 * square when the step was authored by a thinker rather than the host --
 * `--accent-info` is the machine-presence role, and the square is its
 * mandatory non-colour twin.
 */
const props = withDefaults(
  defineProps<{
    steps: readonly Readonly<AxTrajectoryStep>[];
    now: number;
    machinery?: boolean;
    height?: string;
  }>(),
  { machinery: false, height: '340px' }
);

const narrative = new Set([
  'thought',
  'action',
  'observation',
  'idle',
  'message',
  'error',
]);

const rows = computed(() => {
  const list = props.steps.filter((step) =>
    props.machinery ? true : narrative.has(step.type)
  );
  return [...list].sort((a, b) => a.seq - b.seq);
});

const scroller = ref<HTMLElement | null>(null);
const pinned = ref(true);

function onScroll(): void {
  const element = scroller.value;
  if (!element) return;
  pinned.value =
    element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

watch(
  () => rows.value.at(-1)?.stepId,
  async () => {
    if (!pinned.value) return;
    await nextTick();
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  }
);

/**
 * A step either carries an authored string or it does not. When it does, that
 * string is shown at weight 700 because somebody -- host or thinker -- wrote
 * it. When it does not, the row renders the step's own fields in mono and
 * receded ink: derived, not authored. Inventing a sentence for a step that
 * never had one would be the exact dishonesty this site argues against.
 */
const authoredText = (step: Readonly<AxTrajectoryStep>): string | null => {
  const value = step.data.content;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const derivedText = (step: Readonly<AxTrajectoryStep>): string => {
  const parts = Object.entries(step.data)
    .filter(([key]) => key !== 'content')
    .slice(0, 3)
    .map(([key, item]) => `${key}=${String(item)}`);
  return parts.join('  ') || step.type;
};

const authored = (step: Readonly<AxTrajectoryStep>): boolean =>
  step.source !== undefined && step.source !== 'host';
</script>

<template>
  <div class="log pry-component">
    <div
      ref="scroller"
      class="log__scroll"
      :style="{ height }"
      tabindex="0"
      role="log"
      aria-label="Life log"
      @scroll="onScroll"
    >
      <p v-if="rows.length === 0" class="log__empty">No steps yet.</p>
      <ol class="log__list">
        <li v-for="step in rows" :key="step.stepId" class="log__row">
          <span class="log__mark" :class="{ 'log__mark--machine': authored(step) }" aria-hidden="true">
            {{ authored(step) ? '■' : '' }}
          </span>
          <span class="log__seq t-mono">{{ step.seq }}</span>
          <span class="log__type t-mono">{{ step.type }}</span>
          <span v-if="authoredText(step)" class="log__content">
            {{ authoredText(step) }}
          </span>
          <span v-else class="log__content log__content--derived t-mono">
            {{ derivedText(step) }}
          </span>
          <FriendlyTime class="log__time" :ts="step.ts" :now="now" />
          <span v-if="authored(step)" class="visually-hidden">
            written by the {{ step.source === THINKER ? 'thinker' : step.source }}
          </span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.log__scroll {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.log__scroll:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.log__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.log__row {
  display: grid;
  grid-template-columns: 12px 4.5ch 11ch minmax(0, 1fr) max-content;
  align-items: baseline;
  gap: var(--space-8);
  padding: 6px 0;
  border-bottom: 1px solid var(--hairline);
}

.log__mark {
  color: var(--accent-info);
  font-size: 9px;
  line-height: 1;
}

.log__seq {
  color: var(--ink-receded);
  font-size: var(--text-caption-size);
  text-align: right;
}

.log__type {
  color: var(--ink-receded-plus);
  font-size: var(--text-caption-size);
  overflow: hidden;
  text-overflow: ellipsis;
}

.log__content--derived {
  font-weight: 400;
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}

.log__content {
  font-weight: 700;
  color: var(--ink-full);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log__empty {
  margin: 0;
  padding: var(--space-16) 0;
  color: var(--ink-receded-plus);
}

@media (max-width: 767px) {
  .log__row {
    grid-template-columns: 12px 4.5ch minmax(0, 1fr);
    row-gap: 2px;
  }

  .log__type {
    grid-column: 2 / 4;
  }

  .log__content {
    grid-column: 1 / 4;
    white-space: normal;
  }

  .log__time {
    grid-column: 1 / 4;
    text-align: left;
  }
}
</style>
