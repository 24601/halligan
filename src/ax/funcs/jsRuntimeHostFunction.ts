/**
 * Host-only bridge used by AxJSRuntime speculative calls.
 *
 * The worker never receives this metadata. A WeakMap keeps the bridge off the
 * public function object and prevents structured-clone or global inspection
 * from exposing it.
 */

export type JSRuntimeHostFunctionSpeculationAdapter = Readonly<{
  /** Launch the real operation early without committing normal call telemetry. */
  launch: (args: readonly unknown[], signal: AbortSignal) => Promise<unknown>;
  /** Commit one logical runtime call and observe the already-started result. */
  commit: (
    args: readonly unknown[],
    result: Promise<unknown>
  ) => Promise<unknown>;
}>;

const speculationAdapters = new WeakMap<
  object,
  JSRuntimeHostFunctionSpeculationAdapter
>();

export function setJSRuntimeHostFunctionSpeculationAdapter<
  TArgs extends unknown[],
>(
  fn: (...args: TArgs) => unknown,
  adapter: JSRuntimeHostFunctionSpeculationAdapter
): void {
  speculationAdapters.set(fn, adapter);
}

export function getJSRuntimeHostFunctionSpeculationAdapter(
  fn: object
): JSRuntimeHostFunctionSpeculationAdapter | undefined {
  return speculationAdapters.get(fn);
}
