<script setup lang="ts">
import { Pause, Play, RotateCcw, SkipForward } from '@lucide/vue';
import { computed } from 'vue';

/**
 * Reimplementation of the house `RoomControlBar` idiom as a transport: one
 * bar, text-weight, no container. Pry's demos are transports, so run / step /
 * reset / seed / speed is the whole surface.
 *
 * `speed` multiplies SIMULATED time on the manual clock, never wall time: an
 * hour of idle mind can play in eight seconds without lying about the rate.
 */
const props = defineProps<{
  running: boolean;
  seed: number;
  speed: number;
  speeds: readonly number[];
  busy?: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  step: [];
  reset: [];
  'update:seed': [value: number];
  'update:speed': [value: number];
}>();

const seedText = computed(() => String(props.seed));

function onSeedInput(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.replace(/[^0-9]/g, '');
  const value = Number.parseInt(raw === '' ? '0' : raw, 10);
  emit('update:seed', Number.isFinite(value) ? Math.min(value, 999_999) : 0);
}
</script>

<template>
  <div class="transport pry-component" role="group" aria-label="Stage transport">
    <button
      type="button"
      class="ctl ctl--primary"
      :disabled="busy"
      :aria-pressed="running"
      @click="emit('toggle')"
    >
      <component
        :is="running ? Pause : Play"
        :size="15"
        :stroke-width="1.5"
        aria-hidden="true"
      />
      <span>{{ running ? 'Pause' : 'Run' }}</span>
    </button>

    <button type="button" class="ctl" :disabled="busy || running" @click="emit('step')">
      <SkipForward :size="15" :stroke-width="1.5" aria-hidden="true" />
      <span>Step</span>
    </button>

    <button type="button" class="ctl" :disabled="busy" @click="emit('reset')">
      <RotateCcw :size="15" :stroke-width="1.5" aria-hidden="true" />
      <span>Reset</span>
    </button>

    <label class="field">
      <span class="field__label">Seed</span>
      <input
        class="field__input t-mono"
        inputmode="numeric"
        pattern="[0-9]*"
        maxlength="6"
        :value="seedText"
        :disabled="busy"
        @input="onSeedInput"
      />
    </label>

    <label class="field">
      <span class="field__label">Speed</span>
      <select
        class="field__input t-mono"
        :value="speed"
        :disabled="busy"
        @change="emit('update:speed', Number((($event.target) as HTMLSelectElement).value))"
      >
        <option v-for="option in speeds" :key="option" :value="option">
          {{ option }}&times;
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-8);
}

.field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-8);
  padding-left: var(--space-8);
}

.field__label {
  font-size: var(--text-label-size);
  font-weight: 500;
  color: var(--ink-receded-plus);
}

.field__input {
  width: 6.5ch;
  padding: 5px 8px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-full);
  font-size: var(--text-caption-size);
}

select.field__input {
  width: auto;
  min-width: 7ch;
}
</style>
