<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * Bands, not cards, are the layout unit. Reimplementation of modyl-live's
 * `WhatsChangedBand` form: a header row (label + count, both receded, weight
 * 400) over a 1px hairline, then hairline-separated rows. No container, no
 * shadow, no fill. Loading / error / empty are first-class and never a
 * shimmer.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    count?: number;
    loading?: boolean;
    error?: string | null;
    empty?: string;
    note?: string;
  }>(),
  { empty: 'Nothing here yet', error: null }
);

const headingId = useId();
const isEmpty = computed(
  () => !props.loading && !props.error && (props.count ?? 1) === 0
);

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <section
    class="band pry-component"
    :aria-labelledby="headingId"
    :aria-busy="loading ? 'true' : 'false'"
  >
    <header class="band__head">
      <h2 :id="headingId" class="band__label">{{ label }}</h2>
      <span v-if="count !== undefined" class="band__count num">{{ count }}</span>
      <span v-if="note" class="band__note">{{ note }}</span>
    </header>
    <hr class="rule" />

    <p v-if="loading" class="band__state" aria-live="polite">Updating</p>
    <div v-else-if="error" class="band__state band__state--error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="ctl" @click="emit('retry')">Retry</button>
    </div>
    <p v-else-if="isEmpty" class="band__state">{{ empty }}</p>
    <slot v-else />
  </section>
</template>

<style scoped>
.band {
  margin: 0 0 var(--space-64);
}

.band__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-12);
  padding-bottom: var(--space-8);
}

.band__label {
  margin: 0;
  font-size: var(--text-label-size);
  line-height: var(--text-label-line-height);
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-receded-plus);
}

.band__count {
  font-size: var(--text-label-size);
  font-weight: 400;
  color: var(--ink-receded-plus);
}

.band__note {
  margin-left: auto;
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}

.band__state {
  margin: 0;
  padding: var(--space-16) 0;
  color: var(--ink-receded-plus);
  font-size: var(--text-body-size);
}

.band__state--error {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  color: var(--ink-full);
}
</style>
