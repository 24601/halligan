<script setup lang="ts">
import { ref } from 'vue';
import type { Chip } from '../lib/chips.js';
import type { DemoEntry } from '../lib/demos.js';
import { sourceUrl } from '../lib/provenance.js';
import TelemetryChips from './TelemetryChips.vue';

/**
 * Every deep demo has exactly three zones:
 *   1. the live stage      -- the figure, full width, nothing else;
 *   2. the manipulation deck -- controls only, no prose;
 *   3. the systems ledger  -- raw payloads and symbols, collapsed to two lines.
 * Progressive disclosure by construction, so a reader never has to scroll past
 * documentation to reach a control.
 */
defineProps<{ demo: DemoEntry; chips: readonly Chip[] }>();
const ledgerOpen = ref(false);
</script>

<template>
  <article class="demo pry-component">
    <header class="demo__head">
      <p class="demo__kicker eyebrow">{{ demo.id }} · {{ demo.kicker }}</p>
      <h1 class="demo__name t-h28">{{ demo.name }}</h1>
      <TelemetryChips :chips="chips" />
    </header>

    <section class="demo__stage" aria-label="Live stage">
      <slot name="stage" />
    </section>

    <section class="demo__deck" aria-label="Controls">
      <slot name="deck" />
    </section>

    <section class="demo__ledger" aria-label="Systems ledger">
      <button
        type="button"
        class="demo__ledger-toggle"
        :aria-expanded="ledgerOpen"
        @click="ledgerOpen = !ledgerOpen"
      >
        <span class="eyebrow">Systems ledger</span>
        <span class="t-caption demo__ledger-hint">
          {{ ledgerOpen ? 'Collapse' : `${demo.symbols.length} symbols · runs in ${demo.runsWhere}` }}
        </span>
      </button>
      <hr class="rule" />
      <div v-show="ledgerOpen" class="demo__ledger-body">
        <dl class="demo__facts">
          <dt class="t-label">Runs where</dt>
          <dd class="t-body">{{ demo.runsWhere }}</dd>
          <dt class="t-label">Real vs simulated</dt>
          <dd class="t-body">{{ demo.real }}</dd>
          <dt class="t-label">Halligan symbols</dt>
          <dd>
            <ul class="demo__symbols">
              <li v-for="symbol in demo.symbols" :key="symbol" class="t-mono">{{ symbol }}</li>
            </ul>
          </dd>
          <dt class="t-label">Docs</dt>
          <dd>
            <ul class="demo__symbols">
              <li v-for="doc in demo.docs" :key="doc">
                <a class="t-mono demo__doc" :href="sourceUrl(doc)" target="_blank" rel="noreferrer noopener">
                  {{ doc }}
                </a>
              </li>
            </ul>
          </dd>
        </dl>
        <slot name="ledger" />
      </div>
    </section>
  </article>
</template>

<style scoped>
.demo {
  display: flex;
  flex-direction: column;
  gap: var(--space-32);
  padding-block: var(--space-32) var(--space-64);
}

.demo__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}

.demo__kicker {
  margin: 0;
}

.demo__name {
  margin: 0;
  font-weight: 700;
  color: var(--ink-full);
}

.demo__ledger-toggle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-12);
  width: 100%;
  padding: var(--space-8) 0;
  text-align: left;
}

.demo__ledger-hint {
  color: var(--ink-receded-plus);
}

.demo__ledger-body {
  padding-top: var(--space-16);
}

.demo__facts {
  display: grid;
  grid-template-columns: minmax(0, 14ch) minmax(0, 1fr);
  gap: var(--space-8) var(--space-24);
  margin: 0;
}

.demo__facts dt {
  color: var(--ink-receded-plus);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.demo__facts dd {
  margin: 0;
  color: var(--ink-read);
}

.demo__symbols {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4) var(--space-12);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-caption-size);
  color: var(--ink-micro);
}

.demo__doc {
  color: var(--ink-micro);
  text-decoration: none;
  border-bottom: 1px solid var(--hairline-strong);
}

.demo__doc:hover {
  color: var(--accent);
}
</style>
