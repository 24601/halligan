<script setup lang="ts">
import { Zap } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  axMindPaceDelay,
  axMindPacerFuse,
  axRecoverMindPacerState,
  axTrajectoryContextBudget,
  axTrajectoryRecentSize,
} from '../../lib/axImport.js';
import { chip, unmeasuredChip } from '../../lib/chips.js';
import { sourceUrl } from '../../lib/provenance.js';
import { publishEvidence, whenIdle } from '../../lib/ui.js';
import StageControls from '../../viz/StageControls.vue';
import TelemetryChips from '../../viz/TelemetryChips.vue';
import { type Checkpoint, seedArchive } from './archive.js';
import MindStage from './MindStage.vue';
import { Life, THINKER } from './mindLife.js';
import TimeWarp from './TimeWarp.vue';
import { useLife } from './useLife.js';

/**
 * The hero. A persistent mind with nothing attached, waking itself, descending
 * its own backoff ladder and writing its autobiography while you watch. Zero
 * model calls: the thinker is an `AxMindDeterministicProgram`, so the routes,
 * the dispatcher, the pacing ladder and the reply guard all run for real.
 */
const props = defineProps<{ seed: number; autorun?: boolean }>();
const emit = defineEmits<{ open: []; 'update:seed': [value: number] }>();

const CONTEXT_WINDOW = 32_000;
const capMs = ref(300_000);
const pendingCap = ref(300_000);

const life = useLife({
  seed: props.seed,
  capMs: capMs.value,
  contextWindowTokens: CONTEXT_WINDOW,
});

const config = computed(() => life.life.value?.pacerConfig);
const recentSize = computed(() => life.life.value?.recentSize ?? 0);
const fanout = computed(() => life.life.value?.fanout ?? 10);

/* ---- the steady-state figure, read from the pacer's own formula ---------- */

const topLevel = computed(() => {
  const current = config.value;
  if (!current) return 1;
  let level = 1;
  while (level < 24 && axMindPaceDelay(level, current) < current.capMs)
    level += 1;
  return level;
});

const steadyDelayMs = computed(() =>
  config.value ? axMindPaceDelay(topLevel.value, config.value) : 0
);
const steadyWakesPerHour = computed(() =>
  steadyDelayMs.value > 0 ? 3_600_000 / steadyDelayMs.value : 0
);
const fuse = computed(() => (config.value ? axMindPacerFuse(config.value) : 0));
const observedWakes = computed(
  () => life.pacer.value?.spontaneousWakes.length ?? 0
);

const simHours = computed(() => life.simMs.value / 3_600_000);

/* ---- the archive the scrubber travels over ------------------------------ */

const checkpoints = ref<readonly Checkpoint[]>([]);
const seeding = ref(true);
const seeded = ref(0);
const TARGET = 1000;
let archiveLife: Life | null = null;

async function buildArchive(): Promise<void> {
  seeding.value = true;
  seeded.value = 0;
  checkpoints.value = [];
  await archiveLife?.close();
  archiveLife = null;
  try {
    const result = await seedArchive(
      {
        seed: props.seed,
        capMs: capMs.value,
        contextWindowTokens: CONTEXT_WINDOW,
        targetSteps: TARGET,
      },
      (done) => {
        seeded.value = done;
      }
    );
    archiveLife = result.life;
    checkpoints.value = result.checkpoints;
  } finally {
    seeding.value = false;
  }
}

/* ---- transport ---------------------------------------------------------- */

const speeds = [1, 60, 300, 600] as const;

async function rebuild(): Promise<void> {
  life.pause();
  await life.build({
    seed: props.seed,
    capMs: capMs.value,
    contextWindowTokens: CONTEXT_WINDOW,
  });
}

async function reset(): Promise<void> {
  await rebuild();
  await buildArchive();
}

function commitCap(): void {
  if (pendingCap.value === capMs.value) return;
  capMs.value = pendingCap.value;
  void rebuild();
}

watch(
  () => props.seed,
  () => void reset()
);

/* ---- poke --------------------------------------------------------------- */

const pokeKind = ref<'observation' | 'message' | 'error'>('observation');
const poking = ref(false);

async function poke(): Promise<void> {
  if (poking.value) return;
  poking.value = true;
  try {
    await life.poke(pokeKind.value);
  } finally {
    poking.value = false;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    element.isContentEditable
  );
}

function onKey(event: KeyboardEvent): void {
  if (event.code !== 'Space' || isTypingTarget(event.target)) return;
  event.preventDefault();
  void poke();
}

/* ---- chips and evidence -------------------------------------------------- */

const chips = computed(() => [
  chip('SRC', 'DETERMINISTIC', { tone: 'machine' }),
  chip('MODEL', 'NONE'),
  chip('SEED', String(props.seed)),
  chip('CLOCK', 'MANUAL'),
  chip('STEPS', String(life.snapshot.value?.stepCount ?? 0)),
  unmeasuredChip(
    'COST',
    'No provider is attached, so no tokens were bought. Missing, not zero.'
  ),
]);

const recovered = ref<string>('not run');

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
  publishEvidence('D1 · Mind', evidence(recovered.value));
}

function evidence(recoveredText: string) {
  const snapshot = life.snapshot.value;
  return [
    {
      title: 'Pacer state (live, from the running mind)',
      kind: 'json' as const,
      body: JSON.stringify(life.pacer.value ?? null, null, 1),
    },
    {
      title:
        'Pacer state recovered from the log alone (axRecoverMindPacerState)',
      kind: 'json' as const,
      body: recoveredText,
    },
    {
      title: 'Pacer config in force',
      kind: 'json' as const,
      body: JSON.stringify(config.value ?? null, null, 1),
    },
    {
      title: 'Projection coverage',
      kind: 'json' as const,
      body: JSON.stringify(
        {
          estimatedTokens: snapshot?.projection?.estimatedTokens,
          recent: snapshot?.projection?.recent.length,
          recentSize: recentSize.value,
          budgetTokens: axTrajectoryContextBudget({
            contextWindowTokens: CONTEXT_WINDOW,
          }),
          derivedRecentSize: axTrajectoryRecentSize(
            axTrajectoryContextBudget({ contextWindowTokens: CONTEXT_WINDOW })
          ),
          coverage: snapshot?.projection?.coverage,
          life: snapshot?.projection?.life.map((section) =>
            section.kind === 'summary'
              ? {
                  kind: 'summary',
                  tier: section.block.tier,
                  start: section.block.start,
                  end: section.block.end,
                  summarizerId: section.block.summarizerId,
                }
              : section
          ),
        },
        null,
        1
      ),
    },
    {
      title: 'Sealed rollup blocks',
      kind: 'json' as const,
      body: JSON.stringify(
        (snapshot?.blocks ?? []).map((block) => ({
          tier: block.tier,
          start: block.start,
          end: block.end,
          n: block.n,
          summarizerId: block.summarizerId,
          promptVersion: block.promptVersion,
          themes: block.themes,
          summary: block.summary,
        })),
        null,
        1
      ),
    },
    {
      title: 'Source',
      kind: 'links' as const,
      body: '',
      links: [
        {
          label: 'src/ax/mind/pacer.ts',
          href: sourceUrl('src/ax/mind/pacer.ts'),
        },
        {
          label: 'src/ax/trajectory/projection.ts',
          href: sourceUrl('src/ax/trajectory/projection.ts'),
        },
        {
          label: 'src/ax/trajectory/rollups.ts',
          href: sourceUrl('src/ax/trajectory/rollups.ts'),
        },
        {
          label: 'src/examples/mind-persistent-agent.ts',
          href: sourceUrl('src/examples/mind-persistent-agent.ts'),
        },
        {
          label: 'playground/src/demos/D1Mind',
          href: sourceUrl('playground/src/demos/D1Mind'),
        },
      ],
    },
  ];
}

watch(
  () => life.snapshot.value?.stepCount,
  () => publishEvidence('D1 · Mind', evidence(recovered.value))
);

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await rebuild();
  if (props.autorun !== false) life.play();
  whenIdle(() => void buildArchive());
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  void archiveLife?.close();
});

const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
</script>

<template>
  <section class="hero pry-component" aria-label="A mind, waking itself">
    <div class="stage hero__inner">
      <p class="hero__kicker eyebrow">No provider attached</p>
      <h1 class="hero__title">A mind, waking itself.</h1>
      <p class="hero__lede t-lede">
        The thinker is an <code class="t-mono">AxMindDeterministicProgram</code>, so the
        routes, the dispatcher, the pacing ladder and the reply guard all run for real
        in your tab with zero model calls. Everything below is read out of the running
        store, projection and pacer.
      </p>
      <TelemetryChips :chips="chips" />

      <p v-if="life.error.value" class="hero__error" role="alert">
        {{ life.error.value }}
      </p>

      <MindStage
        v-if="config"
        class="hero__figs"
        :snapshot="life.snapshot.value"
        :pacer="life.pacer.value"
        :config="config"
        :fanout="fanout"
        :recent-size="recentSize"
      />

      <div class="hero__deck">
        <div class="hero__poke">
          <button
            type="button"
            class="ctl ctl--primary hero__poke-btn"
            :disabled="poking || life.busy.value"
            @click="poke"
          >
            <Zap :size="16" :stroke-width="1.5" aria-hidden="true" />
            <span>Poke the mind</span>
            <kbd class="hero__kbd t-mono">space</kbd>
          </button>
          <label class="hero__poke-kind">
            <span class="visually-hidden">What to inject</span>
            <select v-model="pokeKind" class="hero__select t-mono">
              <option value="observation">synthetic observation</option>
              <option value="message">a message</option>
              <option value="error">a tool error</option>
            </select>
          </label>
          <span class="t-caption hero__poke-note">
            appended through the real ingress; the ladder snaps to rung 0 because a
            reactive wake is engagement
          </span>
        </div>

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

      <div class="hero__rate">
        <div class="hero__rate-figure">
          <p class="t-bignum hero__bignum">{{ fmt.format(steadyWakesPerHour) }}</p>
          <p class="hero__rate-label t-label">spontaneous wakes per hour, steady state</p>
          <p class="t-qualifier">
            computed from the pacer formula at the current capMs, not measured over a
            real hour
          </p>
        </div>
        <div class="hero__rate-controls">
          <label class="hero__slider">
            <span class="t-label">
              capMs
              <span class="t-mono hero__slider-value">{{ capMs.toLocaleString() }} ms</span>
            </span>
            <input
              v-model.number="pendingCap"
              type="range"
              min="60000"
              max="900000"
              step="30000"
              @change="commitCap"
            />
            <span class="t-caption hero__slider-note">
              committing a new cap restarts the mind: a pacer config is fixed when the
              mind is constructed
            </span>
          </label>
          <dl class="hero__rate-facts">
            <div>
              <dt class="t-label">Observed this run</dt>
              <dd class="t-mono">
                {{ observedWakes }} wakes in the pacer's rolling hour
              </dd>
            </div>
            <div>
              <dt class="t-label">Rate fuse</dt>
              <dd class="t-mono">{{ fuse }} wakes/hour ceiling</dd>
            </div>
            <div>
              <dt class="t-label">Simulated</dt>
              <dd class="t-mono">{{ fmt.format(simHours) }} h at {{ life.speed.value }}&times;</dd>
            </div>
          </dl>
        </div>
      </div>

      <TimeWarp
        class="hero__warp"
        :checkpoints="checkpoints"
        :progress="seeded"
        :target="TARGET"
        :seeding="seeding"
      />

      <div class="hero__more">
        <button type="button" class="ctl" @click="emit('open')">
          Open the deep view
        </button>
        <button type="button" class="ctl" @click="recoverPacer">
          Recover the pacer from the log
        </button>
        <span class="t-caption hero__more-note">
          press <kbd class="t-mono">I</kbd> for the evidence drawer
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  padding-block: var(--space-48) var(--space-64);
  border-bottom: 1px solid var(--hairline);
}

.hero__inner {
  display: flex;
  flex-direction: column;
  gap: var(--space-24);
}

.hero__kicker {
  margin: 0;
  color: var(--ink-full);
}

.hero__title {
  margin: 0;
  font-size: clamp(34px, 6.4vw, var(--text-title-size));
  line-height: var(--text-title-line-height);
  font-weight: 700;
  letter-spacing: var(--text-title-tracking);
  color: var(--ink-full);
}

.hero__lede {
  margin: 0;
  max-width: var(--measure);
  color: var(--ink-read);
  font-weight: 400;
}

.hero__lede code {
  font-size: 0.95em;
  color: var(--ink-full);
}

.hero__error {
  margin: 0;
  padding: var(--space-8) var(--space-12);
  border-left: 2px solid var(--accent-danger);
  color: var(--ink-full);
}

.hero__figs {
  padding: var(--space-16);
  border: 1px solid var(--hairline);
  background-position: -1px -1px;
}

.hero__deck {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
  padding-top: var(--space-16);
  border-top: 1px solid var(--hairline);
}

.hero__poke {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-8);
}

.hero__poke-btn {
  padding: 8px 14px;
}

.hero__kbd {
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: var(--text-micro-size);
  opacity: 0.7;
}

.hero__select {
  padding: 6px 10px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-full);
  font-size: var(--text-caption-size);
}

.hero__poke-note {
  max-width: 40ch;
  color: var(--ink-receded-plus);
}

.hero__rate {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: var(--space-32);
  align-items: end;
  padding-top: var(--space-16);
  border-top: 1px solid var(--hairline);
}

.hero__bignum {
  margin: 0;
  font-size: clamp(56px, 10vw, var(--text-bignum-size));
  color: var(--ink-full);
}

.hero__rate-label {
  margin: var(--space-4) 0 0;
  color: var(--ink-receded-plus);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.hero__rate-controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-24);
  align-items: flex-end;
}

.hero__slider {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 260px;
  flex: 1;
}

.hero__slider-value {
  margin-left: var(--space-8);
  color: var(--ink-full);
}

.hero__slider-note,
.hero__more-note {
  color: var(--ink-receded-plus);
}

.hero__rate-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-16);
  margin: 0;
}

.hero__rate-facts dt {
  margin: 0;
  color: var(--ink-receded-plus);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.hero__rate-facts dd {
  margin: 0;
  font-size: var(--text-caption-size);
  color: var(--ink-full);
}

.hero__warp {
  padding-top: var(--space-16);
  border-top: 1px solid var(--hairline);
}

.hero__more {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12);
}

.hero__more kbd {
  padding: 1px 5px;
  border: 1px solid var(--hairline-strong);
  border-radius: 3px;
}

@media (max-width: 900px) {
  .hero__rate {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-16);
  }
}
</style>
