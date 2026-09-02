/**
 * Executable consumer for `ir/conformance/axagent/playbook-evidence-gate.json`.
 *
 * The fixture is a TS-derived contract: the generated targets do not implement
 * the playbook evidence gate chain yet (that is what the AxIR backlog entry
 * records), so this is where its assertions actually run — against the real
 * `evaluateGateChain` and the real `runAgentEvalBatch`, not a re-implementation.
 *
 * Each contract is chosen so a stub cannot satisfy it:
 *  - a curate-threshold implementation rejects the zero-gain prune;
 *  - a `break`-based batch loop returns a shorter record list;
 *  - a budget-shaped rejection string fails the environment-incomplete case.
 *
 * Lives under `scripts/` rather than `src/ax/` because it reads a file, and
 * `src/ax` must stay free of node builtins.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runAgentEvalBatch } from '../src/ax/agent/agentInternal/playbookEvolve/evalHarness.js';
import {
  evaluateGateChain,
  GATE_ORDER,
  gateChainAccepts,
} from '../src/ax/agent/agentInternal/playbookEvolve/gates.js';
import type { AxAgentTrajectoryClassifier } from '../src/ax/agent/agentInternal/playbookEvolve/playbookEvidenceTypes.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const fixture = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'ir/conformance/axagent/playbook-evidence-gate.json'),
    'utf8'
  )
) as any;

/** A stub agent that always produces a clean final prediction. */
const scriptedAgent = () => ({
  _forwardForEvaluation: async () => ({
    completionType: 'final' as const,
    output: { answer: 'ok' },
    actionLog: '',
    functionCalls: [],
    toolErrors: [],
    turnCount: 1,
  }),
});

const tasksOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    input: { q: index },
    criteria: 'c',
    id: `t${index + 1}`,
  }));

const discardClassifier = (
  discards: readonly string[]
): AxAgentTrajectoryClassifier => {
  const set = new Set(discards);
  return (args) =>
    set.has(`${args.task.id}:${args.attempt}:${args.redraw}`)
      ? { kind: 'environment_failure', cause: 'provider_rate_limit' }
      : undefined;
};

/**
 * Expand a fixture gate-chain case into the real chain input. The two
 * host-call gates are THUNKS in the real input; the fixture declares their
 * result and the counter records whether the chain actually invoked them, so a
 * case can assert that a rejected candidate never paid for one.
 */
function chainInputOf(spec: any, invoked?: string[]) {
  return {
    kind: spec.kind,
    gain: spec.gain,
    ...(spec.veto
      ? {
          veto: async () => {
            invoked?.push('veto');
            return { vetoed: spec.veto.vetoed, detail: spec.veto.detail };
          },
        }
      : {}),
    ...(spec.authority
      ? {
          authority: async () => {
            invoked?.push('authority');
            return {
              allowed: spec.authority.allowed,
              detail: spec.authority.detail,
            };
          },
        }
      : {}),
    ...(spec.heldOut ? { heldOut: spec.heldOut } : {}),
    ...(spec.pruneSize ? { pruneSize: spec.pruneSize } : {}),
    ...(spec.reach
      ? {
          reach: {
            mode: spec.reach.mode,
            report: {
              basis: spec.reach.basis,
              counterfactual: spec.reach.basis !== 'host_probe',
              gateEligible: spec.reach.gateEligible,
              splits: [
                {
                  split: 'current' as const,
                  basis: spec.reach.basis,
                  counterfactual: spec.reach.basis !== 'host_probe',
                  taskCount: spec.reach.taskCount,
                  reachedTasks: spec.reach.reachedTasks,
                  reachRate: spec.reach.reachRate,
                },
              ],
            },
          },
        }
      : {}),
  } as any;
}

describe('ir/conformance/axagent/playbook-evidence-gate', () => {
  it('pins the gate decision order the fixture declares', () => {
    expect([...GATE_ORDER]).toEqual(fixture.gate_order);
  });

  it.each(fixture.cases.map((entry: any) => [entry.name, entry]))(
    'gate chain contract: %s',
    async (_name: string, entry: any) => {
      const hostGatesInvoked: string[] = [];
      const report = await evaluateGateChain(
        chainInputOf(entry.gate_chain, hostGatesInvoked)
      );
      const expected = entry.expected;
      if (expected.hostGatesInvoked !== undefined) {
        expect(hostGatesInvoked).toEqual(expected.hostGatesInvoked);
      }
      if (expected.entries !== undefined) {
        expect(report.entries).toHaveLength(expected.entries);
      }
      if (expected.failedGate !== undefined) {
        expect(report.failedGate).toBe(expected.failedGate);
      }
      if (expected.gainStatus !== undefined) {
        expect(report.entries.find((gate) => gate.id === 'gain')?.status).toBe(
          expected.gainStatus
        );
      }
      if (expected.pruneSizeStatus !== undefined) {
        expect(
          report.entries.find((gate) => gate.id === 'prune_size')?.status
        ).toBe(expected.pruneSizeStatus);
      }
      if (expected.reachStatus !== undefined) {
        expect(report.entries.find((gate) => gate.id === 'reach')?.status).toBe(
          expected.reachStatus
        );
      }
      expect(gateChainAccepts(report)).toBe(expected.accepts);
    }
  );

  it.each(fixture.batch_completeness.map((entry: any) => [entry.name, entry]))(
    'batch completeness contract: %s',
    async (_name: string, entry: any) => {
      const result = await runAgentEvalBatch({
        agent: scriptedAgent() as any,
        ai: {} as any,
        tasks: tasksOf(entry.tasks),
        metric: async () => 1,
        scoreThreshold: 0.7,
        budget: { remaining: entry.budget },
        runsPerTask: entry.runsPerTask,
        ...(entry.discard.length > 0
          ? { classifyTermination: discardClassifier(entry.discard) }
          : {}),
      });
      const expected = entry.expected;
      expect(result.records).toHaveLength(expected.records);
      if (expected.recordTaskIds) {
        expect(result.records.map((record) => record.task.id)).toEqual(
          expected.recordTaskIds
        );
      }
      if (expected.executedRuns !== undefined) {
        expect(result.executedRuns).toBe(expected.executedRuns);
      }
      if (expected.discardedRuns !== undefined) {
        expect(result.discardedRuns).toBe(expected.discardedRuns);
      }
      if (expected.expectedRuns !== undefined) {
        expect(result.expectedRuns).toBe(expected.expectedRuns);
      }
      if (expected.discardRate !== undefined) {
        expect(result.termination.discardRate).toBeCloseTo(
          expected.discardRate,
          10
        );
      }
      if (expected.mean !== undefined) expect(result.mean).toBe(expected.mean);
      if (expected.tasksWithNoScoredAttempt !== undefined) {
        expect(result.termination.tasksWithNoScoredAttempt).toBe(
          expected.tasksWithNoScoredAttempt
        );
      }
      if (expected.truncatedAtTaskIndex === null) {
        expect(result.truncatedAtTaskIndex).toBeUndefined();
      } else if (expected.truncatedAtTaskIndex !== undefined) {
        expect(result.truncatedAtTaskIndex).toBe(expected.truncatedAtTaskIndex);
      }
      if (expected.exhausted !== undefined) {
        expect(result.exhausted).toBe(expected.exhausted);
      }
      if (expected.complete !== undefined) {
        expect(result.complete).toBe(expected.complete);
      }
    }
  );

  it('names an environment-incomplete evaluation distinctly from a budget one', async () => {
    const report = await evaluateGateChain({
      kind: 'curate',
      gain: {
        revalComplete: false,
        currentGain: 0,
        threshold: 0.05,
        incompleteFromEnvironmentFailures: true,
        tasksWithNoScoredAttempt: 1,
      },
    });
    expect(report.failedPredicate).toBe(
      fixture.rejection_reasons.environment_incomplete
    );
    expect(report.failedPredicate).not.toContain(
      fixture.rejection_reasons.forbidden_substring
    );
  });
});
