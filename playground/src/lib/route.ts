import { computed, ref } from 'vue';
import { parseSeed } from './seeds.js';

/**
 * Query-parameter routing (`?d=D1&seed=7`), not history paths: GitHub Pages
 * serves no SPA fallback, so a deep link to a path would 404 while a deep link
 * to a query never can. The seed lives in the URL because a figure a reader
 * cannot reproduce is not evidence.
 */
export interface PryRoute {
  readonly demo: string | null;
  readonly seed: number;
  /**
   * `?run=off` starts the transports paused. It exists so a pinned screenshot
   * is a screenshot of a known state rather than of whatever frame the
   * scheduler happened to be on, and it is a real control, not a test hook:
   * a reader who wants to step the mind by hand uses the same link.
   */
  readonly autorun: boolean;
}

const state = ref<PryRoute>(read());

function read(): PryRoute {
  const params = new URLSearchParams(window.location.search);
  const demo = params.get('d');
  return {
    demo: demo && /^D\d{1,2}$/.test(demo) ? demo : null,
    seed: parseSeed(params.get('seed')),
    autorun: params.get('run') !== 'off',
  };
}

function write(next: PryRoute, replace: boolean): void {
  const params = new URLSearchParams(window.location.search);
  if (next.demo) params.set('d', next.demo);
  else params.delete('d');
  params.set('seed', String(next.seed));
  if (!next.autorun) params.set('run', 'off');
  else params.delete('run');
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  state.value = next;
}

window.addEventListener('popstate', () => {
  state.value = read();
});

export const route = computed(() => state.value);

export function openDemo(demo: string | null): void {
  write({ demo, seed: state.value.seed, autorun: state.value.autorun }, false);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

export function setSeed(seed: number): void {
  write({ demo: state.value.demo, seed, autorun: state.value.autorun }, true);
}
