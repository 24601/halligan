import { onBeforeUnmount, ref } from 'vue';
import { setHudCoords } from '../lib/ui.js';

/**
 * The precision coordinate readout. Hovering or scrubbing an interactive
 * figure publishes a monospace coordinate pair into the HUD, which is what
 * turns the page from a website into a test bench. Purely ambient: nothing
 * depends on it, and it is cleared on leave.
 */
export interface CrosshairOptions {
  readonly figure: string;
  /** Maps a normalized [0,1] pair to the two readout strings. */
  readonly format: (
    fx: number,
    fy: number
  ) => Readonly<{ x: string; y: string }>;
}

export function useCrosshair(options: CrosshairOptions) {
  const at = ref<{ x: number; y: number } | null>(null);

  function onPointerMove(event: PointerEvent | MouseEvent): void {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const box = target.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const fy = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    at.value = { x: event.clientX - box.left, y: event.clientY - box.top };
    const { x, y } = options.format(fx, fy);
    setHudCoords({ figure: options.figure, x, y });
  }

  function onPointerLeave(): void {
    at.value = null;
    setHudCoords(null);
  }

  onBeforeUnmount(() => setHudCoords(null));

  return { at, onPointerMove, onPointerLeave };
}
