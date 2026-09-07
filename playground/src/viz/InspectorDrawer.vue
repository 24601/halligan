<script setup lang="ts">
import { X } from '@lucide/vue';
import { onBeforeUnmount, onMounted } from 'vue';
import {
  inspector,
  inspectorBody,
  inspectorHeading,
  toggleInspector,
} from '../lib/ui.js';

/**
 * The evidence drawer. The stage stays clean and shows relationships; the raw
 * ledger, the digests, the estimator internals and the links into
 * `src/ax/...` live one keystroke away under `I`.
 *
 * This is the honesty mechanism that replaces disclaimer paragraphs: nothing
 * is hidden, but nothing that only a reviewer needs is allowed to crowd the
 * figure a reader came for.
 */
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

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && inspector.value) {
    toggleInspector(false);
    return;
  }
  if (
    (event.key === 'i' || event.key === 'I') &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    toggleInspector();
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <aside
    v-if="inspector"
    class="drawer pry-component"
    role="dialog"
    aria-label="Evidence inspector"
  >
    <header class="drawer__head">
      <h2 class="drawer__title eyebrow">{{ inspectorHeading }}</h2>
      <button
        type="button"
        class="drawer__close"
        data-tooltip="Close (I or Esc)"
        aria-label="Close the evidence inspector"
        @click="toggleInspector(false)"
      >
        <X :size="16" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </header>
    <hr class="rule" />
    <div class="drawer__body">
      <section v-for="section in inspectorBody" :key="section.title" class="drawer__section">
        <h3 class="drawer__section-title t-label">{{ section.title }}</h3>
        <ul v-if="section.kind === 'links'" class="drawer__links">
          <li v-for="link in section.links ?? []" :key="link.href">
            <a class="t-mono drawer__link" :href="link.href" rel="noreferrer noopener" target="_blank">
              {{ link.label }}
            </a>
          </li>
        </ul>
        <pre v-else class="drawer__pre t-mono">{{ section.body }}</pre>
      </section>
      <p v-if="inspectorBody.length === 0" class="drawer__empty">
        No evidence published on this view yet.
      </p>
    </div>
  </aside>
</template>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  width: min(520px, 100vw);
  padding: var(--space-16);
  background: var(--ground);
  border-left: 1px solid var(--hairline-strong);
}

.drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-12);
  padding-bottom: var(--space-8);
}

.drawer__title {
  margin: 0;
}

.drawer__close {
  position: relative;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius-control);
  color: var(--ink-receded);
}

.drawer__close:hover,
.drawer__close:focus-visible {
  background: var(--surface-1);
  color: var(--ink-full);
}

.drawer__close::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  padding: 4px 8px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-control);
  background: var(--ground);
  font-size: var(--text-caption-size);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-micro) var(--ease-snap);
}

.drawer__close:hover::after,
.drawer__close:focus-visible::after {
  opacity: 1;
}

.drawer__body {
  flex: 1;
  overflow-y: auto;
  padding-top: var(--space-16);
}

.drawer__section {
  margin-bottom: var(--space-24);
}

.drawer__section-title {
  margin: 0 0 var(--space-8);
  color: var(--ink-receded-plus);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.drawer__pre {
  margin: 0;
  padding: var(--space-12);
  overflow-x: auto;
  background: var(--surface-1);
  border-radius: var(--radius-control);
  color: var(--ink-read);
  font-size: var(--text-caption-size);
  white-space: pre-wrap;
  word-break: break-word;
}

.drawer__links {
  margin: 0;
  padding: 0;
  list-style: none;
}

.drawer__link {
  display: block;
  padding: 4px 0;
  color: var(--ink-full);
  font-size: var(--text-caption-size);
  border-bottom: 1px solid var(--hairline);
  text-decoration: none;
}

.drawer__link:hover {
  color: var(--accent);
}

.drawer__empty {
  color: var(--ink-receded-plus);
}
</style>
