import { onBeforeUnmount, ref, shallowRef } from 'vue';
import type { AxMindPacerState } from '../../lib/axImport.js';
import {
  Life,
  type LifeOptions,
  type LifeSnapshot,
  type SealEvent,
} from './mindLife.js';

/**
 * Owns one running `Life` and the transport that drives it. Time only moves
 * because this loop moves it: the mind's sources are asleep until the manual
 * clock advances, so `speed` is an exact multiplier on SIMULATED time and
 * never a lie about the rate.
 */
export function useLife(initial: LifeOptions) {
  const life = shallowRef<Life | null>(null);
  const snapshot = ref<LifeSnapshot | null>(null);
  const pacer = ref<Readonly<AxMindPacerState> | undefined>();
  const sealed = ref<readonly SealEvent[]>([]);
  const running = ref(false);
  const busy = ref(false);
  const simMs = ref(0);
  const speed = ref(60);
  const error = ref<string | null>(null);

  let raf = 0;
  let last = 0;
  let inFlight = false;
  let lastRefresh = 0;
  let lastCount = -1;
  let origin = 0;

  /**
   * Sealing and projecting are the expensive reads, and neither can change
   * while the step count is unchanged. So the loop asks the store how many
   * steps it holds -- an O(1) read -- and only re-projects when that moved.
   * The pacer and the clock are cheap and refresh every pass.
   */
  async function refresh(force = false): Promise<void> {
    const current = life.value;
    if (!current) return;
    const now = performance.now();
    if (!force && now - lastRefresh < 200) return;
    lastRefresh = now;
    pacer.value = current.pacer();
    simMs.value = current.clock.now() - origin;
    const stats = await current.store.stats(current.trajectoryId);
    const count = stats?.stepCount ?? 0;
    if (!force && count === lastCount) return;
    lastCount = count;
    const events = await current.seal();
    if (events.length > 0) sealed.value = events;
    snapshot.value = await current.snapshot();
  }

  async function build(options: LifeOptions): Promise<void> {
    busy.value = true;
    error.value = null;
    try {
      await life.value?.close();
      const next = new Life(options);
      await next.start();
      life.value = next;
      origin = next.clock.now();
      lastCount = -1;
      sealed.value = [];
      await refresh(true);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy.value = false;
    }
  }

  async function frame(ts: number): Promise<void> {
    if (!running.value) return;
    const dt = last === 0 ? 16 : Math.min(ts - last, 120);
    last = ts;
    if (!inFlight) {
      inFlight = true;
      try {
        await life.value?.advance(dt * speed.value, 1000);
        await refresh();
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause);
        running.value = false;
      } finally {
        inFlight = false;
      }
    }
    raf = requestAnimationFrame((next) => void frame(next));
  }

  function play(): void {
    if (running.value || !life.value) return;
    running.value = true;
    last = 0;
    raf = requestAnimationFrame((ts) => void frame(ts));
  }

  function pause(): void {
    running.value = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  async function stepOnce(ms = 60_000): Promise<void> {
    if (busy.value || !life.value) return;
    busy.value = true;
    try {
      await life.value.advance(ms, 1000);
      await refresh(true);
    } finally {
      busy.value = false;
    }
  }

  async function poke(
    kind: 'observation' | 'message' | 'error'
  ): Promise<void> {
    const current = life.value;
    if (!current) return;
    await current.poke(kind);
    // Let the dispatcher deliver: the append itself is only the ingress.
    await current.advance(1500, 500);
    await refresh(true);
  }

  onBeforeUnmount(() => {
    pause();
    void life.value?.close();
  });

  return {
    life,
    snapshot,
    pacer,
    sealed,
    running,
    busy,
    simMs,
    speed,
    error,
    build,
    play,
    pause,
    stepOnce,
    poke,
    refresh,
    initial,
  };
}
