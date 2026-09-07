<script setup lang="ts">
import { computed } from 'vue';
import {
  gpuAdapterName,
  gpuState,
  provenance,
  sourceUrl,
} from '../lib/provenance.js';

/**
 * The provenance anchor. Bottom-left of the four-anchor shell: the exact build
 * SHA, the build time, the ax version, and the GPU adapter as a FACT
 * established by an actual `requestAdapter()`, never a UA string.
 */
const gpuLabel = computed(() => {
  switch (gpuState.value) {
    case 'present':
      return gpuAdapterName.value
        ? `adapter present · ${gpuAdapterName.value}`
        : 'adapter present';
    case 'absent':
      return 'adapter absent';
    case 'unsupported':
      return 'navigator.gpu absent';
    default:
      return 'probing';
  }
});

const builtLabel = computed(() =>
  provenance.builtAt === 'unknown'
    ? 'unknown'
    : new Date(provenance.builtAt).toISOString().replace('T', ' ').slice(0, 19)
);
</script>

<template>
  <div class="prov pry-component t-micro">
    <a
      class="prov__item"
      :href="sourceUrl('playground/src')"
      target="_blank"
      rel="noreferrer noopener"
    >
      <span class="prov__key">build</span>
      <span class="prov__value t-mono">{{ provenance.shortCommit }}</span>
    </a>
    <span class="prov__item">
      <span class="prov__key">at</span>
      <span class="prov__value t-mono">{{ builtLabel }}Z</span>
    </span>
    <span class="prov__item">
      <span class="prov__key">ax</span>
      <span class="prov__value t-mono">{{ provenance.axVersion }}</span>
    </span>
    <span class="prov__item">
      <span class="prov__key">gpu</span>
      <span class="prov__value t-mono">{{ gpuLabel }}</span>
    </span>
    <span class="prov__note">
      halligan is a fork of
      <a href="https://github.com/ax-llm/ax" target="_blank" rel="noreferrer noopener">ax-llm/ax</a>.
      Not axllm.dev.
    </span>
  </div>
</template>

<style scoped>
.prov {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-4) var(--space-16);
  color: var(--ink-receded);
}

.prov__item {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  color: inherit;
  text-decoration: none;
}

a.prov__item:hover,
a.prov__item:focus-visible {
  color: var(--ink-read);
}

.prov__key {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.prov__value {
  font-size: var(--text-micro-size);
  color: var(--ink-receded);
}

.prov__note a {
  color: inherit;
}

.prov:hover,
.prov:focus-within {
  color: var(--ink-read);
}
</style>
