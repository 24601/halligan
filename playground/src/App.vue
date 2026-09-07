<script setup lang="ts">
import { Moon, Search, Sun } from '@lucide/vue';
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import { asyncView, demoById, demos, demosInBand } from './lib/demos.js';
import { gpuState, probeGpu } from './lib/provenance.js';
import { openDemo, route, setSeed } from './lib/route.js';
import {
  applyTheme,
  hudCoords,
  inspector,
  noteVisit,
  resolvedTheme,
  theme,
  toggleInspector,
  trail,
} from './lib/ui.js';
import DemoCard from './viz/DemoCard.vue';
import EvidenceBand from './viz/EvidenceBand.vue';
import InspectorDrawer from './viz/InspectorDrawer.vue';
import Provenance from './viz/Provenance.vue';
import PryFinder from './viz/PryFinder.vue';

const Hero = defineAsyncComponent(() => import('./demos/D1Mind/D1Hero.vue'));

const current = computed(() => demoById(route.value.demo));
const view = computed(() => (current.value ? asyncView(current.value) : null));
const finder = ref<InstanceType<typeof PryFinder> | null>(null);

const pinned = demosInBand('pinned');
const needsModel = demosInBand('needs-model');
const covered = computed(() => demos.filter((d) => d.status === 'live').length);

function open(id: string): void {
  noteVisit(id);
  openDemo(id);
}

function cycleTheme(): void {
  applyTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
}

watch(
  () => route.value.demo,
  (id) => {
    document.title = id
      ? `Pry · ${demoById(id)?.name ?? id}`
      : 'Pry — the halligan playground';
  },
  { immediate: true }
);

onMounted(() => {
  applyTheme(theme.value);
  void probeGpu();
});
</script>

<template>
  <a class="skip" href="#main">Skip to the mind</a>

  <header class="shell__top pry-component">
    <div class="stage shell__top-inner">
      <button type="button" class="wordmark" @click="openDemo(null)">
        <span class="wordmark__name">PRY</span>
        <span class="wordmark__sub t-mono">halligan</span>
      </button>

      <div class="hud" role="status" aria-live="off">
        <span v-if="hudCoords" class="hud__coords t-mono">
          {{ hudCoords.figure }} &nbsp; X {{ hudCoords.x }} &nbsp; Y {{ hudCoords.y }}
        </span>
        <span v-else class="hud__coords hud__coords--idle t-mono">
          &mdash;&nbsp;&nbsp;hover a figure
        </span>
        <span class="hud__chip t-mono">
          GPU {{ gpuState === 'present' ? 'OK' : gpuState === 'probing' ? '···' : 'OFF' }}
        </span>
        <button
          type="button"
          class="hud__btn"
          data-tooltip="Find (Cmd K)"
          aria-label="Find a demo"
          @click="finder?.openModal()"
        >
          <Search :size="16" :stroke-width="1.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="hud__btn"
          data-tooltip="Evidence drawer (I)"
          :aria-pressed="inspector"
          aria-label="Toggle the evidence drawer"
          @click="toggleInspector()"
        >
          <span class="t-mono hud__i">I</span>
        </button>
        <button
          type="button"
          class="hud__btn"
          :data-tooltip="`Switch to ${resolvedTheme() === 'dark' ? 'light' : 'dark'}`"
          :aria-label="`Switch to ${resolvedTheme() === 'dark' ? 'light' : 'dark'} theme`"
          @click="cycleTheme"
        >
          <component
            :is="resolvedTheme() === 'dark' ? Sun : Moon"
            :size="16"
            :stroke-width="1.5"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  </header>

  <main id="main" class="shell__main">
    <template v-if="current && view">
      <div class="demo-slot">
        <component
          :is="view"
          :seed="route.seed"
          :autorun="route.autorun"
          @update:seed="setSeed"
        />
      </div>
    </template>

    <template v-else>
      <div class="hero-slot">
        <Hero
          :seed="route.seed"
          :autorun="route.autorun"
          @open="open('D1')"
          @update:seed="setSeed"
        />
      </div>

      <div class="stage shell__bands">
        <EvidenceBand
          label="Pinned"
          :count="pinned.length"
          note="the four demos that are the argument"
        >
          <div class="cards">
            <DemoCard v-for="demo in pinned" :key="demo.id" :demo="demo" @open="open" />
          </div>
        </EvidenceBand>

        <EvidenceBand
          label="Needs a model"
          :count="needsModel.length"
          note="live only once you attach an endpoint or download a model"
        >
          <div class="cards">
            <DemoCard v-for="demo in needsModel" :key="demo.id" :demo="demo" @open="open" />
          </div>
        </EvidenceBand>

        <EvidenceBand
          label="What's changed"
          :count="0"
          empty="No changelog yet — the deploy workflow will write public/changelog.json (L6)."
        />

        <EvidenceBand
          label="What's inside"
          :count="demos.length"
          :note="`${covered} of ${demos.length} live`"
        >
          <ul class="inside">
            <li v-for="demo in demos" :key="demo.id" class="inside__row">
              <span class="inside__id t-mono">{{ demo.id }}</span>
              <button
                v-if="demo.status === 'live'"
                type="button"
                class="inside__name"
                @click="open(demo.id)"
              >
                {{ demo.name }}
              </button>
              <span v-else class="inside__name inside__name--planned">{{ demo.name }}</span>
              <span class="inside__kicker t-caption">{{ demo.kicker }}</span>
              <span class="inside__symbols t-mono">{{ demo.symbols.length }} symbols</span>
              <span class="inside__state t-caption">
                <span aria-hidden="true">{{ demo.status === 'live' ? '■' : '□' }}</span>
                {{ demo.status === 'live' ? 'live' : `planned · ${demo.lane}` }}
              </span>
            </li>
          </ul>
        </EvidenceBand>
      </div>
    </template>
  </main>

  <footer class="shell__bottom pry-component">
    <div class="stage shell__bottom-inner">
      <PryFinder ref="finder" @open="open" />
      <div class="shell__anchors">
        <Provenance />
        <nav v-if="trail.length > 0" class="trail" aria-label="Recently opened">
          <span class="trail__label t-micro">recent</span>
          <button
            v-for="id in trail"
            :key="id"
            type="button"
            class="trail__item t-mono"
            @click="open(id)"
          >
            {{ id }} {{ demoById(id)?.name }}
          </button>
        </nav>
      </div>
    </div>
  </footer>

  <InspectorDrawer />
</template>

<style scoped>
.skip {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 100;
  padding: var(--space-8) var(--space-12);
  background: var(--ground);
  color: var(--ink-full);
  border: 1px solid var(--ink-full);
}

.skip:focus {
  left: var(--space-8);
  top: var(--space-8);
}

.shell__top {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--ground);
  border-bottom: 1px solid var(--hairline);
}

.shell__top-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
  padding-block: var(--space-8);
}

.wordmark {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-8);
  padding: 0;
}

.wordmark__name {
  font-size: var(--text-heading-20-size);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ink-full);
}

.wordmark__sub {
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}

.hud {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}

.hud__coords {
  font-size: var(--text-caption-size);
  color: var(--ink-micro);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.hud__coords--idle {
  color: var(--ink-receded);
}

.hud__chip {
  padding: 2px 7px;
  border: 1px solid var(--hairline-strong);
  border-radius: 3px;
  font-size: var(--text-caption-size);
  letter-spacing: 0.06em;
  color: var(--ink-receded);
}

.hud__btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius-control);
  color: var(--ink-receded);
}

.hud__btn:hover,
.hud__btn:focus-visible {
  background: var(--surface-1);
  color: var(--ink-full);
}

.hud__btn[aria-pressed="true"] {
  color: var(--ink-full);
  border: 1px solid var(--ink-full);
}

.hud__i {
  font-size: var(--text-caption-size);
  font-weight: 700;
}

.hud__btn::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  padding: 4px 8px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-full);
  font-size: var(--text-caption-size);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-micro) var(--ease-snap);
}

.hud__btn:hover::after,
.hud__btn:focus-visible::after {
  opacity: 1;
}

/* The hero arrives as its own chunk. Reserving its height means the bands
 * below never get pushed down when it lands: a layout shift on first paint is
 * the cheapest kind of broken. */
.hero-slot {
  min-height: 1040px;
}

.demo-slot {
  min-height: 1400px;
}

@media (max-width: 900px) {
  .hero-slot {
    min-height: 1600px;
  }
}

.shell__bands {
  padding-block: var(--space-64) var(--space-32);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-16);
  padding-top: var(--space-16);
}

.inside {
  margin: 0;
  padding: 0;
  list-style: none;
}

.inside__row {
  display: grid;
  grid-template-columns: 4ch minmax(0, 12ch) minmax(0, 1fr) max-content max-content;
  align-items: baseline;
  gap: var(--space-12);
  padding: 10px 0;
  border-bottom: 1px solid var(--hairline);
}

.inside__id {
  color: var(--ink-receded);
  font-size: var(--text-caption-size);
}

.inside__name {
  padding: 0;
  font-weight: 700;
  color: var(--ink-full);
  text-align: left;
}

button.inside__name:hover,
button.inside__name:focus-visible {
  color: var(--accent);
}

.inside__name--planned {
  color: var(--ink-receded);
}

.inside__kicker,
.inside__state {
  color: var(--ink-receded-plus);
}

.inside__symbols {
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}

.shell__bottom {
  background: var(--ground);
  border-top: 1px solid var(--hairline);
}

.shell__bottom-inner {
  padding-block: var(--space-24) var(--space-32);
}

.shell__anchors {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-12);
  padding-top: var(--space-8);
}

.trail {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
}

.trail__label {
  color: var(--ink-receded);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.trail__item {
  padding: 0;
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}

.trail__item:hover,
.trail__item:focus-visible {
  color: var(--ink-full);
}

@media (max-width: 767px) {
  .hud__coords {
    display: none;
  }

  .inside__row {
    grid-template-columns: 4ch minmax(0, 1fr) max-content;
  }

  .inside__kicker,
  .inside__symbols {
    display: none;
  }
}
</style>
