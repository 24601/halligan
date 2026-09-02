/**
 * The per-candidate gate chain for `agent.playbook().evolve()`.
 *
 * Gates 1-7 are free, and every one of them is reported — including the ones
 * that were skipped — because the in-round reading of a REJECTED candidate is
 * the auditability precondition.
 *
 * Gates 8 and 9 are the only ones that cost anything: each is one host call.
 * They are therefore passed in as THUNKS and invoked inside the ordered loop,
 * after every free gate has been decided, so an expensive host call is never
 * spent on a candidate that cannot land. A candidate rejected by gate 1 never
 * invokes either thunk, and both gates are reported `skipped` with the reason.
 *
 * Gates 1 and 2 have two variants, selected by the candidate's `kind`. A
 * removal cannot raise the current-task mean by `minCurrentGain` (default
 * 0.05), so running a prune through the curate variant would short-circuit
 * every prune before `prune_size` was ever evaluated — i.e. the prune gate
 * would ship inert. The prune variant is a loss tolerance, not a bypass.
 */

import type {
  AxAgentPlaybookGateEntry,
  AxAgentPlaybookGateId,
  AxAgentPlaybookGateMode,
  AxAgentPlaybookGateReport,
  AxAgentPlaybookInterval,
  AxAgentPlaybookReachReport,
  AxAgentPlaybookValidityReport,
} from './playbookEvidenceTypes.js';

/** Decision order. `failedGate` is the first REQUIRED failure in this order. */
export const GATE_ORDER: readonly AxAgentPlaybookGateId[] = [
  'gain',
  'held_out',
  'retention',
  'validity',
  'interval',
  'reach',
  'prune_size',
  'veto',
  'authority',
];

export type AxGateChainInput = Readonly<{
  kind: 'curate' | 'prune';
  gain: Readonly<{
    revalComplete: boolean;
    currentGain: number;
    /** Curate: minimum gain. Prune: maximum tolerated loss. */
    threshold: number;
    incompleteFromEnvironmentFailures?: boolean;
    tasksWithNoScoredAttempt?: number;
  }>;
  heldOut?: Readonly<{
    delta: number;
    /** Curate: epsilon. Prune: maxHeldOutLoss. */
    tolerance: number;
  }>;
  retention?: Readonly<{
    ok: boolean;
    detail: string;
  }>;
  validity?: Readonly<{
    mode: AxAgentPlaybookGateMode;
    report: AxAgentPlaybookValidityReport;
  }>;
  interval?: Readonly<{
    mode: AxAgentPlaybookGateMode;
    current?: AxAgentPlaybookInterval;
    heldOut?: AxAgentPlaybookInterval;
    /** Unchanged-artifact spread. Absent means no band was configured. */
    bandSpread?: number;
  }>;
  reach?: Readonly<{
    mode: AxAgentPlaybookGateMode;
    report: AxAgentPlaybookReachReport;
  }>;
  pruneSize?: Readonly<{
    tokensBefore: number;
    tokensAfter: number;
    minTokenReduction: number;
  }>;
  /**
   * One host call. A THUNK, not a value: it is invoked only when every free
   * gate before it passed.
   */
  veto?: () => AxGateVetoOutcome | Promise<AxGateVetoOutcome>;
  /** One `axAuthorize` call. A thunk, for the same reason as `veto`. */
  authority?: () => AxGateAuthorityOutcome | Promise<AxGateAuthorityOutcome>;
}>;

export type AxGateVetoOutcome = Readonly<{
  vetoed: boolean;
  detail: string;
}>;

export type AxGateAuthorityOutcome = Readonly<{
  allowed: boolean;
  detail: string;
}>;

type GateOutcome = Readonly<{
  mode: AxAgentPlaybookGateMode;
  status: AxAgentPlaybookGateEntry['status'];
  detail: string;
  /** Name carried verbatim into `outcome.reason` when this gate decides. */
  predicate?: string;
}>;

const skipped = (detail: string): GateOutcome => ({
  mode: 'off',
  status: 'skipped',
  detail,
});

function requiredOutcome(
  passed: boolean,
  detail: string,
  predicate?: string
): GateOutcome {
  return {
    mode: 'require',
    status: passed ? 'pass' : 'fail',
    detail,
    ...(predicate ? { predicate } : {}),
  };
}

/**
 * A configurable gate's outcome. An `unmeasured` reading is NEVER a pass: under
 * `require` it fails closed, under `warn` it is surfaced as a warning.
 */
function modalOutcome(args: {
  mode: AxAgentPlaybookGateMode;
  measurable: boolean;
  passed: boolean;
  detail: string;
  predicate?: string;
}): GateOutcome {
  if (args.mode === 'off') return skipped(args.detail);
  const status: AxAgentPlaybookGateEntry['status'] = !args.measurable
    ? 'unmeasured'
    : args.passed
      ? 'pass'
      : args.mode === 'warn'
        ? 'warn'
        : 'fail';
  return {
    mode: args.mode,
    status,
    detail: args.detail,
    ...(args.predicate ? { predicate: args.predicate } : {}),
  };
}

function gainGate(input: AxGateChainInput): GateOutcome {
  const { revalComplete, currentGain, threshold } = input.gain;
  if (!revalComplete) {
    return requiredOutcome(
      false,
      input.gain.incompleteFromEnvironmentFailures
        ? `evaluation incomplete due to environment failures (${input.gain.tasksWithNoScoredAttempt ?? 0} tasks)`
        : 'evaluation incomplete'
    );
  }
  if (input.kind === 'prune') {
    // A prune's null hypothesis is "do not get worse", not "gain 5 points".
    const loss = -currentGain;
    return requiredOutcome(
      loss <= threshold,
      `prune current-task loss ${loss.toFixed(3)} vs tolerance ${threshold}`
    );
  }
  return requiredOutcome(
    currentGain >= threshold,
    `current-task gain ${currentGain.toFixed(3)} vs threshold ${threshold}`
  );
}

function heldOutGate(input: AxGateChainInput): GateOutcome {
  if (!input.heldOut) return skipped('no held-out set configured');
  const { delta, tolerance } = input.heldOut;
  if (input.kind === 'prune') {
    return requiredOutcome(
      -delta <= tolerance,
      `prune held-out loss ${(-delta).toFixed(3)} vs tolerance ${tolerance}`
    );
  }
  return requiredOutcome(
    delta >= -tolerance,
    `held-out delta ${delta.toFixed(3)} vs epsilon ${tolerance}`
  );
}

function intervalGate(input: AxGateChainInput): GateOutcome {
  const config = input.interval;
  if (!config || config.mode === 'off') {
    return skipped('interval gate off');
  }
  const current = config.current;
  if (!current) {
    return modalOutcome({
      mode: config.mode,
      measurable: false,
      passed: false,
      detail:
        'interval unmeasured: the paired records could not be aligned or the split ran out of budget',
      predicate: 'interval@current',
    });
  }
  const heldOutOk =
    config.heldOut === undefined || config.heldOut.direction !== 'negative';
  if (input.kind === 'prune') {
    // A prune must not be shown to LOSE; it is not required to be shown to win.
    const ok = current.direction !== 'negative' && heldOutOk;
    return modalOutcome({
      mode: config.mode,
      measurable: true,
      passed: ok,
      detail: `prune interval current ${current.direction}, held-out ${config.heldOut?.direction ?? 'n/a'}`,
      predicate: 'interval@current',
    });
  }
  const beatsBand =
    config.bandSpread === undefined
      ? true
      : Math.abs(current.point) > config.bandSpread;
  const ok = current.direction === 'positive' && beatsBand && heldOutOk;
  const bandDetail =
    config.bandSpread === undefined
      ? 'no variance band configured, so the check is "excludes zero" only'
      : `point ${current.point.toFixed(3)} vs band spread ${config.bandSpread.toFixed(3)}`;
  return modalOutcome({
    mode: config.mode,
    measurable: true,
    passed: ok,
    detail: `interval current ${current.direction} [${current.lower.toFixed(3)}, ${current.upper.toFixed(3)}]; ${bandDetail}; held-out ${config.heldOut?.direction ?? 'n/a'}`,
    predicate: 'interval@current',
  });
}

function reachGate(input: AxGateChainInput): GateOutcome {
  const config = input.reach;
  if (!config || config.mode === 'off') return skipped('reach gate off');
  if (input.kind === 'prune') {
    return skipped('a removed bullet has no reach to measure');
  }
  if (!config.report.gateEligible) {
    // The two free bases are counterfactual, so they can only ever read
    // `unmeasured` here. There is no configuration in which a rendered-or-
    // applicable count satisfies this gate.
    return modalOutcome({
      mode: config.mode,
      measurable: false,
      passed: false,
      detail: `reach basis '${config.report.basis}' is counterfactual and cannot satisfy the reach gate`,
      predicate: `reach:${config.report.basis}`,
    });
  }
  const reached = config.report.splits.reduce(
    (sum, split) => sum + split.reachedTasks,
    0
  );
  return modalOutcome({
    mode: config.mode,
    measurable: true,
    passed: reached > 0,
    detail: `host-probed reach on ${reached} task(s)`,
    predicate: 'reach:host_probe',
  });
}

function validityGate(input: AxGateChainInput): GateOutcome {
  const config = input.validity;
  if (!config || config.mode === 'off') return skipped('validity gate off');
  const failed = config.report.failed;
  const failing = config.report.predicates.find(
    (predicate) => predicate.name === failed
  );
  if (!failed) {
    return modalOutcome({
      mode: config.mode,
      measurable: true,
      passed: true,
      detail: `${config.report.required.length} required predicate(s) passed`,
    });
  }
  const unmeasured = failing?.status === 'unmeasured';
  return modalOutcome({
    mode: config.mode,
    measurable: !unmeasured,
    passed: false,
    detail: unmeasured
      ? `${failed} unmeasured`
      : `${failed} ${failing?.observed?.toFixed(3)} vs ${failing?.threshold}`,
    predicate: failed,
  });
}

function pruneSizeGate(input: AxGateChainInput): GateOutcome {
  if (input.kind !== 'prune') return skipped('prune_size applies to prunes');
  if (!input.pruneSize) {
    return requiredOutcome(
      false,
      'prune_size unmeasured: no rendered-size reading'
    );
  }
  const reduction = input.pruneSize.tokensBefore - input.pruneSize.tokensAfter;
  return requiredOutcome(
    reduction >= input.pruneSize.minTokenReduction,
    `rendered-token reduction ${reduction} vs minimum ${input.pruneSize.minTokenReduction}`
  );
}

/** Gates 8 and 9 cost a host call; every earlier gate is free. */
const HOST_CALL_GATES: ReadonlySet<AxAgentPlaybookGateId> =
  new Set<AxAgentPlaybookGateId>(['veto', 'authority']);

export async function evaluateGateChain(
  input: AxGateChainInput
): Promise<AxAgentPlaybookGateReport> {
  // The free gates. Computing all of them costs nothing and their readings are
  // the audit trail for a rejected candidate, so none of them is elided.
  const outcomes = new Map<AxAgentPlaybookGateId, GateOutcome>();
  outcomes.set('gain', gainGate(input));
  outcomes.set('held_out', heldOutGate(input));
  outcomes.set(
    'retention',
    input.retention
      ? requiredOutcome(input.retention.ok, input.retention.detail)
      : skipped('no retention policy configured')
  );
  outcomes.set('validity', validityGate(input));
  outcomes.set('interval', intervalGate(input));
  outcomes.set('reach', reachGate(input));
  outcomes.set('prune_size', pruneSizeGate(input));

  const entries: AxAgentPlaybookGateEntry[] = [];
  let failedGate: AxAgentPlaybookGateId | undefined;
  let failedPredicate: string | undefined;
  for (const id of GATE_ORDER) {
    let outcome = outcomes.get(id);
    if (!outcome && HOST_CALL_GATES.has(id)) {
      // THE short-circuit: a candidate that has already lost never pays for a
      // host call.
      outcome =
        failedGate !== undefined
          ? skipped(
              `not evaluated: the ${failedGate} gate already rejected this candidate`
            )
          : id === 'veto'
            ? await vetoGate(input)
            : await authorityGate(input);
    }
    const resolved = outcome!;
    entries.push({
      id,
      mode: resolved.mode,
      status: resolved.status,
      detail: resolved.detail,
    });
    const decided =
      resolved.mode === 'require' &&
      (resolved.status === 'fail' || resolved.status === 'unmeasured');
    if (decided && failedGate === undefined) {
      failedGate = id;
      failedPredicate = resolved.predicate ?? resolved.detail;
    }
  }
  return {
    entries,
    ...(failedGate ? { failedGate } : {}),
    ...(failedPredicate ? { failedPredicate } : {}),
  };
}

async function vetoGate(input: AxGateChainInput): Promise<GateOutcome> {
  if (!input.veto) return skipped('no promotion veto configured');
  const result = await input.veto();
  return requiredOutcome(!result.vetoed, result.detail);
}

async function authorityGate(input: AxGateChainInput): Promise<GateOutcome> {
  if (!input.authority) return skipped('no promotion authority configured');
  const result = await input.authority();
  return requiredOutcome(result.allowed, result.detail);
}

/** True when no required gate failed. */
export function gateChainAccepts(
  report: Readonly<AxAgentPlaybookGateReport>
): boolean {
  return report.failedGate === undefined;
}
