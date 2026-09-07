<script setup lang="ts">
import { Zap } from '@lucide/vue';
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { axRecoverMindPacerState } from '../../lib/axImport.js';
import { chip, unmeasuredChip } from '../../lib/chips.js';
import { demoById } from '../../lib/demos.js';
import { publishEvidence, whenIdle } from '../../lib/ui.js';
import DemoLayout from '../../viz/DemoLayout.vue';
import StageControls from '../../viz/StageControls.vue';
import { type Checkpoint, seedArchive } from './archive.js';
import Compactor from './Compactor.vue';
import ForkPanel from './ForkPanel.vue';
import MindStage from './MindStage.vue';
import { Life, THINKER } from './mindLife.js';
import TimeWarp from './TimeWarp.vue';
import { useLife } from './useLife.js';

/**
 * D1 deep view. Same running mind as the hero, plus the two things that need
 * room: the context-window compactor over a long real transcript, and a fork
 * that runs two minds side by side over one clock.
 */
const props = defineProps<{ seed: number; autorun?: boolean }>();
const emit = defineEmits<{ 'update:seed': [value: number] }>();

const demo = demoById('D1')!;
const CONTEXT_WINDOW = 32_000;
const capMs = 300_000;
const speeds = [1, 60, 300, 600] as const;

const life = useLife({
  seed: props.seed,
  capMs,
  contextWindowTokens: CONTEXT_WINDOW,
});

const config = computed(() => life.life.value?.pacerConfig);
const pokeKind = ref<'observation' | 'message' | 'error'>('observation');

const archive = shallowRef<Life | null>(null);
const checkpoints = ref<readonly Checkpoint[]>([]);
const seeding = ref(true);
const seeded = ref(0);
const TARGET = 1000;

async function buildArchive(): Promise<void> {
  seeding.value = true;
  seeded.value = 0;
  await archive.value?.close();
  archive.value = null;
  try {
    const result = await seedArchive(
      {
        seed: props.seed,
        capMs,
        contextWindowTokens: CONTEXT_WINDOW,
        targetSteps: TARGET,
      },
      (done) => {
        seeded.value = done;
      }
    );
    archive.value = result.life;
    checkpoints.value = result.checkpoints;
  } finally {
    seeding.value = false;
  }
}

const recovered = ref('not run');

async function recoverPacer(): Promise<void> {
  const current = life.life.value;
  if (!current) return;
  const state = await axRecoverMindPacerState(
    current.store,
    current.trajectoryId,
    THINKER,
    current.pacerConfig
  );
  recovered.value = JSON.stringify(state, null, 1);
}

const matches = computed(
  () =>
    recovered.value !== 'not run' &&
    JSON.parse(recovered.value).level === (life.pacer.value?.level ?? -1)
);

const chips = computed(() => [
  chip('SRC', 'DETERMINISTIC', { tone: 'machine' }),
  chip('MODEL', 'NONE'),
  chip('SEED', String(props.seed)),
  chip('CLOCK', 'MANUAL'),
  chip('STEPS', String(life.snapshot.value?.stepCount ?? 0)),
  chip('RUNG', String(life.pacer.value?.level ?? 0)),
  unmeasuredChip('COST', 'No provider is attached; no tokens were bought.'),
]);

watch(
  () => life.snapshot.value?.stepCount,
  () =>
    publishEvidence('D1 · Mind', [
      {
        title: 'Live pacer state',
        kind: 'json',
        body: JSON.stringify(life.pacer.value ?? null, null, 1),
      },
      {
        title: 'Recovered from the log (axRecoverMindPacerState)',
        kind: 'json',
        body: recovered.value,
      },
      {
        title: 'Rendered projection',
        kind: 'text',
        body: life.snapshot.value?.projection?.render ?? '',
      },
    ])
);

async function reset(): Promise<void> {
  life.pause();
  await life.build({
    seed: props.seed,
    capMs,
    contextWindowTokens: CONTEXT_WINDOW,
  });
  await buildArchive();
}

watch(
  () => props.seed,
  () => void reset()
);

onMounted(async () => {
  await life.build({
    seed: props.seed,
    capMs,
    contextWindowTokens: CONTEXT_WINDOW,
  });
  if (props.autorun !== false) life.play();
  whenIdle(() => void buildArchive());
});

onBeforeUnmount(() => {
  void archive.value?.close();
});
</script>

<template>
  <div class="stage">
    <DemoLayout :demo="demo" :chips="chips">
      <template #stage>
        <MindStage
          v-if="config"
          :snapshot="life.snapshot.value"
          :pacer="life.pacer.value"
          :config="config"
          :fanout="life.life.value?.fanout ?? 10"
          :recent-size="life.life.value?.recentSize ?? 0"
          log-height="300px"
        />
      </template>

      <template #deck>
        <div class="deck">
          <div class="deck__row">
            <button
              type="button"
              class="ctl ctl--primary"
              :disabled="life.busy.value"
              @click="life.poke(pokeKind)"
            >
              <Zap :size="16" :stroke-width="1.5" aria-hidden="true" />
              <span>Poke the mind</span>
            </button>
            <select v-model="pokeKind" class="deck__select t-mono" aria-label="What to inject">
              <option value="observation">synthetic observation</option>
              <option value="message">a message</option>
              <option value="error">a tool error</option>
            </select>
            <StageControls
              :running="life.running.value"
              :seed="seed"
              :speed="life.speed.value"
              :speeds="speeds"
              :busy="life.busy.value"
              @toggle="life.running.value ? life.pause() : life.play()"
              @step="life.stepOnce()"
              @reset="reset"
              @update:seed="emit('update:seed', $event)"
              @update:speed="life.speed.value = $event"
            />
          </div>

          <div class="deck__block">
            <h2 class="eyebrow">Context window compactor</h2>
            <hr class="rule" />
            <Compactor :life="archive" :ready="!seeding" />
          </div>

          <div class="deck__block">
            <h2 class="eyebrow">Fork from a step</h2>
            <hr class="rule" />
            <ForkPanel
              v-if="config"
              :seed="seed"
              :cap-ms="capMs"
              :context-window-tokens="CONTEXT_WINDOW"
              :config="config"
            />
          </div>

          <div class="deck__block">
            <TimeWarp
              :checkpoints="checkpoints"
              :progress="seeded"
              :target="TARGET"
              :seeding="seeding"
            />
          </div>
        </div>
      </template>

      <template #ledger>
        <div class="ledger">
          <button type="button" class="ctl" @click="recoverPacer">
            Recover the pacer from the log alone
          </button>
          <p class="ledger__note t-caption">
            <span v-if="recovered === 'not run'">
              `axRecoverMindPacerState` reads only `mind-wake` records out of the store.
            </span>
            <span v-else-if="matches">
              recovered level matches the live pacer: the log is the authority, the
              in-memory state is a cache
            </span>
            <span v-else>
              recovered level differs from the live pacer — the mind moved between the
              two reads
            </span>
          </p>
          <pre v-if="recovered !== 'not run'" class="ledger__pre t-mono">{{ recovered }}</pre>
        </div>
      </template>
    </DemoLayout>
  </div>
</template>

<style scoped>
.deck {
  display: flex;
  flex-direction: column;
  gap: var(--space-32);
}

.deck__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12);
}

.deck__select {
  padding: 6px 10px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-full);
  font-size: var(--text-caption-size);
}

.deck__block h2 {
  margin: 0 0 var(--space-8);
}

.deck__block hr {
  margin-bottom: var(--space-16);
}

.ledger {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-8);
}

.ledger__note {
  margin: 0;
  color: var(--ink-receded-plus);
}

.ledger__pre {
  width: 100%;
  margin: 0;
  padding: var(--space-12);
  overflow-x: auto;
  background: var(--surface-1);
  border-radius: var(--radius-control);
  color: var(--ink-read);
  font-size: var(--text-caption-size);
}
</style>
