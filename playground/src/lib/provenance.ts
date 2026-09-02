import { ref } from 'vue';

/**
 * Build facts, injected by Vite at build time (`define` in vite.config.ts).
 * Nothing here is typed by hand: the SHA comes from git, the version from
 * `src/ax/package.json`, the time from the build.
 */
export const provenance = Object.freeze({
  commit: __PRY_COMMIT__,
  shortCommit: __PRY_COMMIT__.slice(0, 7),
  builtAt: __PRY_BUILD_TIME__,
  axVersion: __PRY_AX_VERSION__,
  repo: '24601/halligan',
  upstream: 'ax-llm/ax',
});

export const sourceUrl = (path: string): string =>
  `https://github.com/${provenance.repo}/blob/${
    provenance.commit === 'unknown' ? 'main' : provenance.commit
  }/${path}`;

/**
 * WebGPU presence is a FACT reported in the footer, established by an actual
 * adapter request. Never a UA string.
 */
export type GpuState = 'probing' | 'present' | 'absent' | 'unsupported';

export const gpuState = ref<GpuState>('probing');
export const gpuAdapterName = ref<string>('');

export async function probeGpu(): Promise<void> {
  const gpu = (
    navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
  ).gpu;
  if (!gpu) {
    gpuState.value = 'unsupported';
    return;
  }
  try {
    const adapter = (await gpu.requestAdapter()) as {
      info?: { vendor?: string; architecture?: string };
    } | null;
    if (!adapter) {
      gpuState.value = 'absent';
      return;
    }
    gpuState.value = 'present';
    const info = adapter.info;
    gpuAdapterName.value = [info?.vendor, info?.architecture]
      .filter((part): part is string => Boolean(part))
      .join(' ');
  } catch {
    gpuState.value = 'absent';
  }
}
