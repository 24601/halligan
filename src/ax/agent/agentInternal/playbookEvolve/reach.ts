/**
 * Reach instrumentation for `agent.playbook().evolve()`.
 *
 * The question decision 3 asks is "was the candidate bullet actually reached at
 * the deciding step of the episode?", and ONLY a host probe can answer it. Ax's
 * two free bases are counterfactuals and are labelled as such:
 *
 *  - `applicability_counterfactual` reads 1.0 unconditionally for exactly the
 *    bullets this gate exists to interrogate, because `isBulletApplicable`
 *    short-circuits to `true` when a bullet has no `evidence.applicability` and
 *    evolve-curated bullets never carry one. It also asks what WOULD have been
 *    applicable under render conditions the evaluation never applied.
 *  - `rendered_only` is evidence of length, not of use.
 *
 * So `gateEligible` is true only for `host_probe`. Accepting a weaker basis
 * would mean the gate that exists to refute "the prompt just got longer" is
 * satisfied by the prompt getting longer.
 */

import { isBulletApplicable } from '../../../dsp/optimizers/acePlaybook.js';
import type { AxACEBullet } from '../../../dsp/optimizers/aceTypes.js';
import type {
  AxAgentEvalPrediction,
  AxAgentEvalTask,
} from '../agentOptimizeTypes.js';
import type {
  AxAgentPlaybookEvidenceWarning,
  AxAgentPlaybookReachBasis,
  AxAgentPlaybookReachProbe,
  AxAgentPlaybookReachReport,
  AxAgentPlaybookReachSplit,
  AxAgentPlaybookSplitName,
} from './playbookEvidenceTypes.js';

export const DEFAULT_REACH_PROBE_BUDGET_MS = 1_000;

type SplitKey = string;

type SplitState = {
  split: AxAgentPlaybookSplitName;
  sliceName?: string;
  tasks: Set<unknown>;
  reachedTasks: Set<unknown>;
  invocations: number;
  episodes: number;
  unmeasured: boolean;
};

export type AxReachCollector = {
  observe: (args: {
    task: Readonly<AxAgentEvalTask<any>>;
    prediction?: Readonly<AxAgentEvalPrediction<any>>;
    split: AxAgentPlaybookSplitName;
    sliceName?: string;
  }) => void;
  report: (args?: {
    /** Candidate delta, used only to decide which honesty warning to emit. */
    delta?: number;
  }) => Readonly<{
    report: AxAgentPlaybookReachReport;
    warnings: readonly AxAgentPlaybookEvidenceWarning[];
  }>;
};

const COUNTERFACTUAL_REASON =
  'reach basis is counterfactual: isBulletApplicable returns true for a bullet with no applicability tokens (evolve-curated bullets carry none), and the evaluation renders the playbook once per apply with no per-task conditions, so this asks what would have applied under conditions the run never rendered';

export function createReachCollector(args: {
  probe?: AxAgentPlaybookReachProbe<any, any>;
  conditionsForTask?: (
    task: Readonly<AxAgentEvalTask<any>>
  ) => readonly string[];
  /** Bullets the current proposal added or changed. */
  candidateBullets?: readonly Readonly<AxACEBullet>[];
  candidateBulletIds: readonly string[];
  renderedBulletIds: readonly string[];
  now: () => number;
  probeBudgetMs?: number;
  /** ISO instant handed to ACE, derived from the injected clock. */
  nowIso: string;
}): AxReachCollector {
  const basis: AxAgentPlaybookReachBasis = args.probe
    ? 'host_probe'
    : args.conditionsForTask
      ? 'applicability_counterfactual'
      : 'rendered_only';
  const splits = new Map<SplitKey, SplitState>();
  const candidateIds = new Set(args.candidateBulletIds);
  const renderedCandidate = args.renderedBulletIds.some((id) =>
    candidateIds.has(id)
  );
  const probeBudgetMs = args.probeBudgetMs ?? DEFAULT_REACH_PROBE_BUDGET_MS;
  let probeSpentMs = 0;
  let probeDisabled = false;
  let probeFault: string | undefined;

  const stateOf = (
    split: AxAgentPlaybookSplitName,
    sliceName?: string
  ): SplitState => {
    const key = `${split}#${sliceName ?? ''}`;
    const existing = splits.get(key);
    if (existing) return existing;
    const created: SplitState = {
      split,
      ...(sliceName ? { sliceName } : {}),
      tasks: new Set(),
      reachedTasks: new Set(),
      invocations: 0,
      episodes: 0,
      unmeasured: false,
    };
    splits.set(key, created);
    return created;
  };

  return {
    observe(observed) {
      const state = stateOf(observed.split, observed.sliceName);
      state.tasks.add(observed.task);
      state.episodes++;
      if (candidateIds.size === 0) return;

      if (basis === 'host_probe') {
        if (probeDisabled) {
          state.unmeasured = true;
          return;
        }
        const startedAt = args.now();
        let result: ReturnType<AxAgentPlaybookReachProbe> | undefined;
        try {
          result = args.probe!({
            candidateBulletIds: args.candidateBulletIds,
            renderedBulletIds: args.renderedBulletIds,
            task: observed.task,
            ...(observed.prediction ? { prediction: observed.prediction } : {}),
            split: observed.split,
            ...(observed.sliceName ? { sliceName: observed.sliceName } : {}),
          });
        } catch (err) {
          // Reach is evidence, not scoring: a faulty probe marks the split
          // unmeasured and the run continues.
          probeDisabled = true;
          probeFault = err instanceof Error ? err.message : String(err);
          state.unmeasured = true;
          return;
        }
        probeSpentMs += args.now() - startedAt;
        if (probeSpentMs > probeBudgetMs) {
          probeDisabled = true;
          probeFault = `reach probe exceeded its ${probeBudgetMs}ms cumulative budget`;
        }
        if (result === undefined) return;
        if (
          typeof result !== 'object' ||
          typeof result.applicableAtDecidingStep !== 'boolean' ||
          !Number.isSafeInteger(result.invocations) ||
          result.invocations < 0
        ) {
          probeDisabled = true;
          probeFault =
            'reach probe returned a malformed observation (invocations must be a non-negative safe integer)';
          state.unmeasured = true;
          return;
        }
        if (result.applicableAtDecidingStep) {
          state.reachedTasks.add(observed.task);
        }
        state.invocations += result.invocations;
        return;
      }

      if (basis === 'applicability_counterfactual') {
        const conditions = args.conditionsForTask!(observed.task);
        const applicable = (args.candidateBullets ?? []).some((bullet) =>
          isBulletApplicable(bullet, {
            conditions,
            // The ISO instant ACE evaluates lifecycle expiry against must come
            // from the injected clock, or "reproducible from the receipt" is
            // false.
            now: args.nowIso,
          })
        );
        if (applicable) state.reachedTasks.add(observed.task);
        return;
      }

      if (renderedCandidate) state.reachedTasks.add(observed.task);
    },

    report(reportArgs) {
      const gateEligible = basis === 'host_probe' && !probeDisabled;
      const counterfactual = basis !== 'host_probe';
      const splitReports: AxAgentPlaybookReachSplit[] = [];
      for (const state of splits.values()) {
        const taskCount = state.tasks.size;
        const reachedTasks = state.unmeasured ? 0 : state.reachedTasks.size;
        splitReports.push({
          split: state.split,
          ...(state.sliceName ? { sliceName: state.sliceName } : {}),
          basis,
          counterfactual,
          taskCount,
          reachedTasks,
          reachRate: taskCount > 0 ? reachedTasks / taskCount : 0,
          ...(basis === 'host_probe' && !state.unmeasured && state.episodes > 0
            ? { invocationsPerEpisode: state.invocations / state.episodes }
            : {}),
        });
      }

      const warnings: AxAgentPlaybookEvidenceWarning[] = [];
      if (probeFault) {
        warnings.push({
          code: 'reach_probe_failed',
          message: `${probeFault}; the affected splits report reach as unmeasured and the reach gate fails closed`,
        });
      }
      if (basis === 'applicability_counterfactual') {
        warnings.push({
          code: 'reach_counterfactual_basis',
          message: COUNTERFACTUAL_REASON,
        });
      }
      const delta = reportArgs?.delta;
      for (const split of splitReports) {
        if (basis === 'rendered_only' && (delta ?? 0) > 0) {
          warnings.push({
            code: 'reach_unmeasured',
            message:
              'a positive delta was measured on a rendered-only reach basis: the bullet was present in the prompt, which is not evidence it was used',
            scope: split.split,
          });
        }
        if (
          basis === 'host_probe' &&
          !probeDisabled &&
          split.reachedTasks === 0 &&
          (delta ?? 0) > 0
        ) {
          warnings.push({
            code: 'reach_zero_positive_delta',
            message:
              'the candidate bullet was never reached at a deciding step yet the score improved: this is a prompting or format effect, not the artifact',
            scope: split.split,
          });
        }
      }

      return {
        report: {
          basis,
          counterfactual,
          gateEligible,
          splits: splitReports,
        },
        warnings,
      };
    },
  };
}
