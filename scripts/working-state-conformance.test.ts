/**
 * Executes the AxIR working-state conformance fixture against the real kernel.
 *
 * The fixture is only worth having if a hollow implementation cannot pass it.
 * This runner therefore drives `axWorkingState` end to end: it recomputes the
 * receipt fingerprint from the call recorded in the fixture (a stub that does
 * not canonicalize and hash cannot produce the stored value), commits the
 * seven-op patch, and asserts the committed classes, the parked reasons, the
 * resulting goal statuses and the compare-and-set revision advance.
 *
 * Lives in `scripts/` because it reads the fixture from disk and `src/ax` may
 * not use node builtins.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AxStatePatch } from '../src/ax/agent/statePatch.js';
import {
  axWorkingState,
  axWorkingStateReceiptFingerprint,
} from '../src/ax/agent/workingState.js';
import { AxInMemoryProgramStateStore } from '../src/ax/event/memoryStore.js';
import { AxManualEventClock } from '../src/ax/event/types.js';

const FIXTURE_PATH = 'ir/conformance/axagent/working-state-commit.json';

type Fixture = {
  input: {
    stateSignature: string;
    factDepthLimit: number;
    believedState: Record<string, unknown>;
    receipts: {
      ref: string;
      turn: number;
      at: number;
      fingerprint: string;
      call: { qualifiedName: string; arguments: unknown; result: unknown };
    }[];
    turn: number;
    patch: unknown[];
  };
  expected: {
    outcome: string;
    committedClasses: string[];
    parkedReasons: string[];
    revision: number;
    goalStatuses: Record<string, string>;
    facts: Record<string, unknown>;
    evidenceRefs: Record<string, string[]>;
  };
};

describe('axagent working-state commit conformance', () => {
  it('reproduces the fixture exactly, including the real receipt fingerprint', async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), FIXTURE_PATH), 'utf8')
    ) as Fixture;

    const state = await axWorkingState(
      {
        stateSignature: fixture.input.stateSignature,
        factDepthLimit: fixture.input.factDepthLimit,
        clock: new AxManualEventClock(1_700_000_120_000),
        store: new AxInMemoryProgramStateStore(),
        initial: fixture.input.believedState as never,
        // The fixture declares a no-op checker: only CORE-owned kernel
        // behaviour is pinned here, never a host-supplied verdict.
        checker: { id: 'noop', check: () => ({ status: 'pass' }) },
      },
      { runId: 'ws:conformance:1', stage: 'executor' }
    );

    for (const receipt of fixture.input.receipts) {
      const minted = await state.recordReceipt({
        qualifiedName: receipt.call.qualifiedName,
        arguments: receipt.call.arguments,
        result: receipt.call.result,
        turn: receipt.turn,
        at: receipt.at,
      });
      expect(minted.ref).toBe(receipt.ref);
      // A stub that does not canonicalize and hash cannot produce this.
      expect(minted.fingerprint).toBe(receipt.fingerprint);
      await expect(
        axWorkingStateReceiptFingerprint(receipt.call)
      ).resolves.toBe(receipt.fingerprint);
    }

    const outcome = await state.commit(fixture.input.patch as AxStatePatch, {
      action: 'await inventory.pick({order:"42"})',
      observation: '{"picked":3}',
      turn: fixture.input.turn,
      isError: false,
    });

    expect(outcome.outcome).toBe(fixture.expected.outcome);
    expect(outcome.committed.map((entry) => entry.class)).toEqual(
      fixture.expected.committedClasses
    );
    expect(outcome.parked.map((entry) => entry.reason)).toEqual(
      fixture.expected.parkedReasons
    );
    expect(outcome.revision).toBe(fixture.expected.revision);

    const document = state.current();
    for (const [goalId, status] of Object.entries(
      fixture.expected.goalStatuses
    )) {
      expect([goalId, document.goals[goalId]?.status]).toEqual([
        goalId,
        status,
      ]);
    }
    for (const [goalId, refs] of Object.entries(
      fixture.expected.evidenceRefs
    )) {
      expect([
        goalId,
        (document.goals[goalId]?.evidence ?? []).map((entry) => entry.ref),
      ]).toEqual([goalId, refs]);
    }
    expect(document.facts).toEqual(fixture.expected.facts);
  });
});
