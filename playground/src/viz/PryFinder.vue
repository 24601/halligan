<script setup lang="ts">
import { CornerDownLeft, Search } from '@lucide/vue';
import MiniSearch from 'minisearch';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { type DemoEntry, demos } from '../lib/demos.js';

/**
 * Pry's single command bar. Reimplementation of the modyl-live `HallwayFinder`
 * form: a bottom-anchored growing textarea with a hairline-strong underline
 * that promotes to ink on :focus-within, auto-resize then internal scroll,
 * Enter submits, a 3rem trailing button with a tooltip on hover AND keyboard
 * focus.
 *
 * Matching is MiniSearch (8 KB, ~0.1 ms) rather than an embedding model: a
 * 23 MB download to rank nine demos would be spending the reader's bandwidth
 * on our own vanity.
 *
 * Cmd/Ctrl+K and "/" open the same finder as a centred modal, because a
 * bottom-only bar is unreachable halfway down a long page.
 */
const emit = defineEmits<{ open: [id: string] }>();

const query = ref('');
const modal = ref(false);
const activeIndex = ref(0);
const field = ref<HTMLTextAreaElement | null>(null);
const modalField = ref<HTMLTextAreaElement | null>(null);

const index = new MiniSearch<DemoEntry & { text: string }>({
  fields: ['name', 'kicker', 'headline', 'text'],
  storeFields: ['id'],
  idField: 'id',
  searchOptions: { prefix: true, fuzzy: 0.25, boost: { name: 3, kicker: 2 } },
});

index.addAll(
  demos.map((demo) => ({
    ...demo,
    text: [...demo.keywords, ...demo.symbols, ...demo.docs].join(' '),
  }))
);

const results = computed<readonly DemoEntry[]>(() => {
  const text = query.value.trim();
  if (text.length === 0) return demos.slice(0, 5);
  const hits = index.search(text);
  const found = hits
    .map((hit) => demos.find((demo) => demo.id === String(hit.id)))
    .filter((demo): demo is DemoEntry => Boolean(demo));
  return found.slice(0, 6);
});

watch(results, () => {
  activeIndex.value = 0;
});

function grow(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 194)}px`;
}

function submit(): void {
  const target = results.value[activeIndex.value] ?? results.value[0];
  if (!target || target.status !== 'live') return;
  emit('open', target.id);
  modal.value = false;
  query.value = '';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex.value = Math.min(
      activeIndex.value + 1,
      results.value.length - 1
    );
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    return;
  }
  if (event.key === 'Escape' && modal.value) {
    modal.value = false;
  }
}

async function openModal(): Promise<void> {
  modal.value = true;
  await nextTick();
  modalField.value?.focus();
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable
  );
}

function onGlobalKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    void openModal();
    return;
  }
  if (event.key === '/' && !isTypingTarget(event.target) && !modal.value) {
    event.preventDefault();
    void openModal();
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));

defineExpose({ openModal });
</script>

<template>
  <div class="finder pry-component">
    <label class="finder__bar">
      <span class="visually-hidden">Find a demo, a symbol, or a document</span>
      <textarea
        ref="field"
        v-model="query"
        class="finder__field"
        rows="1"
        spellcheck="false"
        placeholder="Find a subsystem, a symbol, a doc&hellip;"
        @input="grow(field)"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="finder__go"
        data-tooltip="Open the top match (Enter)"
        aria-label="Open the top match"
        @click="submit"
      >
        <CornerDownLeft :size="18" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </label>
    <ul v-if="query.trim().length > 0" class="finder__results">
      <li v-for="(item, i) in results" :key="item.id">
        <button
          type="button"
          class="finder__result"
          :class="{ 'is-active': i === activeIndex }"
          :disabled="item.status !== 'live'"
          @click="emit('open', item.id)"
        >
          <span class="t-mono finder__result-id">{{ item.id }}</span>
          <span class="finder__result-name">{{ item.name }}</span>
          <span class="finder__result-kicker t-caption">{{ item.kicker }}</span>
          <span v-if="item.status !== 'live'" class="finder__result-state t-caption">
            planned · {{ item.lane }}
          </span>
        </button>
      </li>
    </ul>
  </div>

  <div
    v-if="modal"
    class="scrim pry-component"
    role="dialog"
    aria-modal="true"
    aria-label="Find"
    @click.self="modal = false"
  >
    <div class="palette">
      <div class="palette__bar">
        <Search :size="16" :stroke-width="1.5" aria-hidden="true" />
        <textarea
          ref="modalField"
          v-model="query"
          class="palette__field"
          rows="1"
          spellcheck="false"
          placeholder="Find a subsystem, a symbol, a doc&hellip;"
          @keydown="onKeydown"
        />
        <kbd class="palette__kbd t-mono">esc</kbd>
      </div>
      <hr class="rule" />
      <ul class="palette__results">
        <li v-for="(item, i) in results" :key="item.id">
          <button
            type="button"
            class="finder__result"
            :class="{ 'is-active': i === activeIndex }"
            :disabled="item.status !== 'live'"
            @click="emit('open', item.id); modal = false"
          >
            <span class="t-mono finder__result-id">{{ item.id }}</span>
            <span class="finder__result-name">{{ item.name }}</span>
            <span class="finder__result-kicker t-caption">{{ item.kicker }}</span>
            <span v-if="item.status !== 'live'" class="finder__result-state t-caption">
              planned · {{ item.lane }}
            </span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.finder__bar {
  display: flex;
  align-items: flex-end;
  gap: var(--space-12);
  border-bottom: 1px solid var(--hairline-strong);
  transition: border-color var(--dur-micro) var(--ease-snap);
}

.finder__bar:focus-within {
  border-bottom-color: var(--ink-full);
}

.finder__field {
  flex: 1;
  min-height: 3.75rem;
  max-height: 12.125rem;
  padding: 1rem 0;
  resize: none;
  overflow-y: auto;
  font-size: 1.25rem;
  letter-spacing: -0.015em;
  line-height: 1.45;
  color: var(--ink-full);
}

.finder__field::placeholder {
  color: var(--ink-receded);
}

.finder__go {
  position: relative;
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: 0.5rem;
  border-radius: var(--radius-control);
  color: var(--ink-receded);
}

.finder__go:hover,
.finder__go:focus-visible {
  background: var(--surface-1);
  color: var(--ink-full);
}

.finder__go::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
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

.finder__go:hover::after,
.finder__go:focus-visible::after {
  opacity: 1;
}

.finder__results,
.palette__results {
  margin: 0;
  padding: 0;
  list-style: none;
}

.finder__result {
  display: grid;
  grid-template-columns: 3.5ch minmax(0, max-content) minmax(0, 1fr) max-content;
  align-items: baseline;
  gap: var(--space-12);
  width: 100%;
  padding: 10px var(--space-8);
  text-align: left;
  border-bottom: 1px solid var(--hairline);
  color: var(--ink-full);
}

.finder__result:hover:not(:disabled),
.finder__result.is-active:not(:disabled) {
  background: var(--surface-1);
}

.finder__result:disabled {
  color: var(--ink-receded);
  cursor: not-allowed;
}

.finder__result-id {
  color: var(--ink-receded);
  font-size: var(--text-caption-size);
}

.finder__result-name {
  font-weight: 700;
}

.finder__result-kicker,
.finder__result-state {
  color: var(--ink-receded-plus);
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: start center;
  padding-top: 12vh;
  background: var(--scrim);
}

.palette {
  width: min(680px, calc(100vw - 2 * var(--gutter)));
  padding: var(--space-8) var(--space-16) var(--space-16);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-surface);
  background: var(--ground);
}

.palette__bar {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  color: var(--ink-receded);
}

.palette__field {
  flex: 1;
  min-height: 2.5rem;
  padding: 0.5rem 0;
  resize: none;
  font-size: 1.125rem;
  color: var(--ink-full);
}

.palette__kbd {
  padding: 2px 6px;
  border: 1px solid var(--hairline);
  border-radius: 4px;
  font-size: var(--text-caption-size);
  color: var(--ink-receded);
}
</style>
