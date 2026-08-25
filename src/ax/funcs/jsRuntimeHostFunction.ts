/**
 * Host-only bridge used by AxJSRuntime speculative calls.
 *
 * The worker never receives this metadata. A WeakMap keeps the bridge off the
 * public function object and prevents structured-clone or global inspection
 * from exposing it.
 */

export type JSRuntimeHostFunctionSpeculationLaunch = Readonly<{
  /** The authorized physical operation. Rejections are observed by the turn. */
  result: Promise<unknown>;
  /** Exact authorization denied before physical or logical call effects. */
  authorizationDenied?: boolean;
  /** Revalidate host authority or other launch-time preconditions at claim. */
  canClaim?: () => boolean;
  /** Internal diagnostic when canClaim() fails. */
  invalidReason?: 'authority-invalidated' | 'launch-invalidated';
  /** Execution-scoped cancellation used if claim must fall back normally. */
  signal?: AbortSignal;
}>;

export type JSRuntimeHostFunctionSpeculationAdapter = Readonly<{
  /** Authorize and launch early without committing normal call telemetry. */
  launch: (
    args: readonly unknown[],
    signal: AbortSignal
  ) =>
    | JSRuntimeHostFunctionSpeculationLaunch
    | Promise<JSRuntimeHostFunctionSpeculationLaunch>;
  /** Commit one logical runtime call and observe the authorized launch. */
  commit: (
    args: readonly unknown[],
    launch: JSRuntimeHostFunctionSpeculationLaunch
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
