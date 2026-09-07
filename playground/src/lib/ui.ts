import { readonly, ref } from 'vue';

/* ---- theme ------------------------------------------------------------ */

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'pry.theme.v1';
const themeRef = ref<Theme>(readTheme());

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage may be denied; the system theme is a fine answer */
  }
  return 'system';
}

export function applyTheme(next: Theme): void {
  themeRef.value = next;
  const root = document.documentElement;
  if (next === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
  try {
    if (next === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage may be denied; the class on <html> is still correct */
  }
}

export const theme = readonly(themeRef);

export function resolvedTheme(): 'light' | 'dark' {
  if (themeRef.value !== 'system') return themeRef.value;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/* ---- the HUD coordinate readout --------------------------------------- */

export interface HudCoords {
  readonly figure: string;
  readonly x: string;
  readonly y: string;
}

const coordsRef = ref<HudCoords | null>(null);

export const hudCoords = readonly(coordsRef);

export function setHudCoords(next: HudCoords | null): void {
  coordsRef.value = next;
}

/* ---- the inspector / evidence drawer ---------------------------------- */

export interface InspectorSection {
  readonly title: string;
  readonly kind: 'json' | 'text' | 'links';
  readonly body: string;
  readonly links?: readonly Readonly<{ label: string; href: string }>[];
}

const inspectorOpen = ref(false);
const inspectorSections = ref<readonly InspectorSection[]>([]);
const inspectorTitle = ref('Evidence');

export const inspector = readonly(inspectorOpen);
export const inspectorHeading = readonly(inspectorTitle);
export const inspectorBody = readonly(inspectorSections);

export function publishEvidence(
  title: string,
  sections: readonly InspectorSection[]
): void {
  inspectorTitle.value = title;
  inspectorSections.value = sections;
}

export function toggleInspector(force?: boolean): void {
  inspectorOpen.value = force ?? !inspectorOpen.value;
}

/* ---- reduced motion --------------------------------------------------- */

export function prefersReducedMotion(): boolean {
  return Boolean(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/* ---- the recently-opened trail ---------------------------------------- */

const trailRef = ref<readonly string[]>([]);
export const trail = readonly(trailRef);

export function noteVisit(demoId: string): void {
  trailRef.value = [
    demoId,
    ...trailRef.value.filter((id) => id !== demoId),
  ].slice(0, 3);
}

/* ---- deferred work ---------------------------------------------------- */

/**
 * Run secondary work once the browser is idle. The hero has to be interactive
 * before the scrubber's thousand-step life is worth seeding: a page that is
 * busy computing a control nobody has touched yet is a page that feels slow.
 */
export function whenIdle(task: () => void, timeout = 2_000): void {
  const idle = (
    window as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        options?: { timeout: number }
      ) => number;
    }
  ).requestIdleCallback;
  if (idle) idle(task, { timeout });
  else window.setTimeout(task, 200);
}
