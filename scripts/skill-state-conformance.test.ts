/**
 * Executes the skillState transition conformance fixture against the real
 * runtime.
 *
 * What is pinned here is CORE-owned: the rationale digest (a real SHA-256 over
 * canonical bytes), the compare-and-set revision advance, the kernel's BOUNDED
 * single rebase, the mapping of a persistently lost write onto
 * `rejection: 'fence'`, and the rule that only an ACCEPTED transition enters
 * the ledger. The declared checker is a no-op, so no host-supplied verdict is
 * smuggled into a core-owned surface.
 *
 * The store below is written out in the runner rather than reused from
 * `AxInMemoryProgramStateStore` for two reasons the fixture states explicitly:
 * the scenario starts from a stored revision of 4 (a run that has already
 * committed), and the losing writer needs a competing writer that commits
 * immediately after each of its reads. Both are behaviours the declared
 * `AxProgramStateStore` contract permits; the assertions are about what the
 * KERNEL does when the store behaves that way.
 *
 * A stub that does not canonicalize and hash cannot produce the stored
 * rationale digest; a stub without real compare-and-set semantics accepts both
 * writers; a stub that records attempts rather than transitions fails the
 * ledger-length assertion.
 *
 * The fixture lives under `scripts/fixtures/` rather than `ir/conformance/`
 * for the reason recorded in `scripts/working-state-conformance.test.ts` and
 * in `docs/AGENT_WORKING_STATE.md`: working state is not ported to AxIR, and
 * every directory under `ir/conformance/` is executed by the generated
 * language packages.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { axSkillStateRuntime } from '../src/ax/agent/skillState.js';
import { axWorkingState } from '../src/ax/agent/workingState.js';
import type {
  AxProgramStateEnvelope,
  AxProgramStateStore,
} from '../src/ax/event/types.js';
import { AxManualEventClock } from '../src/ax/event/types.js';

const FIXTURE_PATH = 'scripts/fixtures/skill-state-transition.json';

type FixtureTransition = {
  name: string;
  patch: unknown[];
  rationale?: string;
  /** A competing writer commits immediately after each of this writer's reads. */
  concurrentWriter: boolean;
};

type Fixture = {
  input: {
    stateSignature: string;
    storedRevision: number;
    believedState: Record<string, unknown>;
    skill: { id: string; name: string; content: string };
    receipts: {
      ref: string;
      turn: number;
      at: number;
      call: { qualifiedName: string; arguments: unknown; result: unknown };
    }[];
    turn: number;
    fence: { deliveryId: string; fencingToken: number };
    transitions: FixtureTransition[];
  };
  expected: {
    transitions: {
      accepted: boolean;
      rejection?: string;
      committedRevision: number;
      recordedLedgerLength: number;
      rationaleDigest: string;
    }[];
    goalStatusesAfter: Record<string, string>;
    storedRevisionAfter: number;
    fenceSeenByStore: boolean;
  };
};

/**
 * A revision-seeded store. `advanceAfterLoad` models a competing writer that
 * commits immediately after each of our reads, which is the only way a bounded
 * single rebase can still lose.
 */
class SeededStore implements AxProgramStateStore {
  public advanceAfterLoad = false;
  public fences: unknown[] = [];
  private envelope: AxProgramStateEnvelope;

  constructor(revision: number, state: unknown, programVersion: string) {
    this.envelope = {
      schemaVersion: 1,
      programVersion,
      revision,
      state,
      updatedAt: 1_700_000_120_000,
    };
  }

  async load(): Promise<Readonly<AxProgramStateEnvelope>> {
    const snapshot = structuredClone(this.envelope);
    if (this.advanceAfterLoad) {
      this.envelope = {
        ...this.envelope,
        revision: this.envelope.revision + 1,
      };
    }
    return snapshot;
  }

  async compareAndSet(
    _key: string,
    expectedRevision: number | undefined,
    state: Readonly<Omit<AxProgramStateEnvelope, 'revision'>>,
    fence?: Readonly<{ deliveryId: string; fencingToken: number }>
  ): Promise<Readonly<AxProgramStateEnvelope>> {
    this.fences.push(fence);
    if (this.envelope.revision !== expectedRevision) {
      throw new Error(
        `compare-and-set failed: expected ${String(expectedRevision)}, current ${this.envelope.revision}`
      );
    }
    this.envelope = {
      ...structuredClone(state),
      revision: this.envelope.revision + 1,
    };
    return structuredClone(this.envelope);
  }

  async delete(): Promise<void> {
    throw new Error('not used by this fixture');
  }

  revision(): number {
    return this.envelope.revision;
  }
}

describe('axagent skillState transition conformance', () => {
  it('reproduces the fixture exactly, including the rationale digest and the lost write', async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), FIXTURE_PATH), 'utf8')
    ) as Fixture;

    const store = new SeededStore(
      fixture.input.storedRevision,
      fixture.input.believedState,
      'ws:conformance:1'
    );

    const open = async () => {
      const state = await axWorkingState(
        {
          stateSignature: fixture.input.stateSignature,
          clock: new AxManualEventClock(1_700_000_120_000),
          store,
          storeKey: 'ax.workingState:conformance',
          fence: fixture.input.fence,
          initial: fixture.input.believedState as never,
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
      }
      const runtime = await axSkillStateRuntime(
        { skill: fixture.input.skill },
        state
      );
      return { state, runtime };
    };

    // Both writers open against the SAME stored revision, which is what makes
    // the second one concurrent rather than sequential.
    const writerA = await open();
    const writerB = await open();
    expect(writerA.state.currentRevision()).toBe(fixture.input.storedRevision);
    expect(writerB.state.currentRevision()).toBe(fixture.input.storedRevision);

    const writers = [writerA, writerB];
    for (const [index, declared] of fixture.input.transitions.entries()) {
      const writer = writers[index]!;
      store.advanceAfterLoad = declared.concurrentWriter;
      const transition = await writer.runtime.applyPatch(
        declared.patch,
        declared.rationale,
        {
          action: 'await inventory.pick({order:"42"})',
          observation: '{"picked":3}',
          turn: fixture.input.turn,
          isError: false,
        }
      );
      const expectedTransition = fixture.expected.transitions[index]!;

      expect([declared.name, transition.accepted]).toEqual([
        declared.name,
        expectedTransition.accepted,
      ]);
      expect([declared.name, transition.rejection]).toEqual([
        declared.name,
        expectedTransition.rejection,
      ]);
      expect([declared.name, transition.committedRevision]).toEqual([
        declared.name,
        expectedTransition.committedRevision,
      ]);
      // A stub that does not canonicalize and hash cannot produce this.
      expect([declared.name, transition.rationaleDigest]).toEqual([
        declared.name,
        expectedTransition.rationaleDigest,
      ]);
      // Only accepted transitions enter the ledger.
      expect([declared.name, writer.runtime.transitions().length]).toEqual([
        declared.name,
        expectedTransition.recordedLedgerLength,
      ]);
    }

    store.advanceAfterLoad = false;
    expect(store.revision()).toBe(fixture.expected.storedRevisionAfter);
    const document = writerA.state.current();
    for (const [goalId, status] of Object.entries(
      fixture.expected.goalStatusesAfter
    )) {
      expect([goalId, document.goals[goalId]?.status]).toEqual([
        goalId,
        status,
      ]);
    }
    // The configured delivery fence reaches the store on every write attempt.
    expect(store.fences.length).toBeGreaterThan(0);
    expect(
      store.fences.every(
        (fence) =>
          (fence as { fencingToken?: number } | undefined)?.fencingToken ===
          fixture.input.fence.fencingToken
      )
    ).toBe(fixture.expected.fenceSeenByStore);
  });
});
