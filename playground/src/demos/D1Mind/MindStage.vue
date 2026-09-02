<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  AxMindPacerConfig,
  AxMindPacerState,
} from '../../lib/axImport.js';
import LifeLog from './LifeLog.vue';
import type { LifeSnapshot } from './mindLife.js';
import PacingLadder from './PacingLadder.vue';
import RollupPyramid from './RollupPyramid.vue';
import { useNarrow } from './useNarrow.js';

/**
 * The hero's three linked figures: the life log, the rollup pyramid it feeds,
 * and the ladder the mind descends when nobody is talking to it. Under 768px
 * they collapse into a tabbed switcher rather than a three-column squeeze.
 */
const props = defineProps<{
  snapshot: LifeSnapshot | null;
  pacer: Readonly<AxMindPacerState> | undefined;
  config: Readonly<AxMindPacerConfig>;
  fanout: number;
  recentSize: number;
  logHeight?: string;
}>();

const narrow = useNarrow();
const tab = ref<'log' | 'ladder'>('log');
const machinery = ref(false);

const showLog = computed(() => !narrow.value || tab.value === 'log');
const showLadder = computed(() => !narrow.value || tab.value === 'ladder');

const sealedIndex = computed(
  () =>
    props.snapshot?.blocks.reduce(
      (max, block) => Math.max(max, block.end),
      0
    ) ?? 0
);
const descent = computed(() => props.snapshot?.projection?.life ?? []);
const verbatim = computed(() => props.snapshot?.projection?.recent.length ?? 0);
const rendered = computed(
  () => props.snapshot?.projection?.estimatedTokens ?? 0
);
</script>

<template>
  <div class="mstage pry-component">
    <div v-if="narrow" class="mstage__tabs" role="tablist" aria-label="Hero figures">
      <button
        type="button"
        class="ctl"
        role="tab"
        :aria-selected="tab === 'log'"
        :class="{ 'is-on': tab === 'log' }"
        @click="tab = 'log'"
      >
        Life log
      </button>
      <button
        type="button"
        class="ctl"
        role="tab"
        :aria-selected="tab === 'ladder'"
        :class="{ 'is-on': tab === 'ladder' }"
        @click="tab = 'ladder'"
      >
        Pacing ladder
      </button>
    </div>

    <div class="mstage__grid" :class="{ 'is-narrow': narrow }">
      <section v-show="showLog" class="mstage__col mstage__col--log" aria-label="Life log">
        <header class="mstage__head">
          <h2 class="eyebrow">Life log</h2>
          <span class="mstage__count t-mono">{{ snapshot?.stepCount ?? 0 }} steps</span>
          <button
            type="button"
            class="mstage__toggle t-caption"
            :aria-pressed="machinery"
            @click="machinery = !machinery"
          >
            {{ machinery ? 'narrative + machinery' : 'narrative only' }}
          </button>
        </header>
        <hr class="rule" />
        <LifeLog
          :steps="snapshot?.steps ?? []"
          :now="snapshot?.now ?? 0"
          :machinery="machinery"
          :height="logHeight ?? '320px'"
        />
      </section>

      <section v-show="showLog" class="mstage__col mstage__col--pyr" aria-label="Rollup pyramid">
        <header class="mstage__head">
          <h2 class="eyebrow">Rollup pyramid</h2>
          <span class="mstage__count t-mono">{{ snapshot?.blocks.length ?? 0 }} sealed</span>
        </header>
        <hr class="rule" />
        <RollupPyramid
          :blocks="snapshot?.blocks ?? []"
          :on-path="snapshot?.onPath ?? new Set()"
          :recent-count="verbatim"
          :sealed-index="sealedIndex"
          :fanout="fanout"
        />
        <dl class="mstage__facts">
          <div>
            <dt class="t-label">Verbatim tail</dt>
            <dd class="t-mono">{{ verbatim }} steps · R {{ recentSize }}</dd>
          </div>
          <div>
            <dt class="t-label">Rendered</dt>
            <dd class="t-mono">{{ rendered }} tok</dd>
          </div>
          <div>
            <dt class="t-label">Summarised</dt>
            <dd class="t-mono">{{ descent.filter((s) => s.kind === 'summary').length }} sections</dd>
          </div>
        </dl>
      </section>

      <section v-show="showLadder" class="mstage__col mstage__col--ladder" aria-label="Pacing ladder">
        <header class="mstage__head">
          <h2 class="eyebrow">Pacing ladder</h2>
          <span class="mstage__count t-mono">rung {{ pacer?.level ?? 0 }}</span>
        </header>
        <hr class="rule" />
        <PacingLadder :config="config" :state="pacer" :height="300" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.mstage__tabs {
  display: flex;
  gap: var(--space-8);
  padding-bottom: var(--space-12);
}

.mstage__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) 220px;
  gap: var(--space-24);
}

.mstage__grid > .mstage__col + .mstage__col {
  padding-left: var(--space-24);
  border-left: 1px solid var(--hairline);
}

.mstage__grid.is-narrow > .mstage__col + .mstage__col {
  padding-left: 0;
  border-left: none;
  padding-top: var(--space-16);
  border-top: 1px solid var(--hairline);
}

.mstage__grid.is-narrow {
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-24);
}

@media (max-width: 1100px) {
  .mstage__grid {
    grid-template-columns: minmax(0, 1fr) 200px;
  }

  .mstage__col--pyr {
    grid-column: 1 / -1;
    order: 3;
    padding-left: 0;
    border-left: none;
    padding-top: var(--space-16);
    border-top: 1px solid var(--hairline);
  }
}

.mstage__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-12);
  padding-bottom: var(--space-8);
}

.mstage__head h2 {
  margin: 0;
}

.mstage__count {
  font-size: var(--text-caption-size);
  color: var(--ink-receded-plus);
}

.mstage__toggle {
  margin-left: auto;
  color: var(--ink-receded);
  border-bottom: 1px solid var(--hairline-strong);
}

.mstage__toggle:hover,
.mstage__toggle:focus-visible {
  color: var(--ink-full);
}

.mstage__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-16);
  margin: var(--space-12) 0 0;
  padding-top: var(--space-8);
  border-top: 1px solid var(--hairline);
}

.mstage__facts dt {
  margin: 0;
  color: var(--ink-receded-plus);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.mstage__facts dd {
  margin: 0;
  font-size: var(--text-caption-size);
  color: var(--ink-full);
}
</style>
