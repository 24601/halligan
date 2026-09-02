/**
 * Compile-time contract for the working-state surface. Run by
 * `tsc -p tsconfig.typetests.json`; nothing here executes.
 */

import type { AxEventVerifierResult } from '../event/types.js';
import type { AxStatePatchOp } from './statePatch.js';
import {
  type AxWorkingState,
  type AxWorkingStateChecker,
  type AxWorkingStateDocument,
  type AxWorkingStateGoal,
  type AxWorkingStateTraceStep,
  axWorkingState,
} from './workingState.js';

type Facts = { shipped: boolean; itemsPacked: number };

declare const document: AxWorkingStateDocument<Facts>;

// The host's fact space narrows through the generic.
const shipped: boolean = document.facts.shipped;
const packed: number = document.facts.itemsPacked;
void shipped;
void packed;

// `goals` is a keyed object indexed by string, so a lookup is possibly absent.
const maybeGoal: AxWorkingStateGoal | undefined = document.goals.g_pick;
void maybeGoal;

// @ts-expect-error — the fact space is closed by the declared type.
void document.facts.notDeclared;

// @ts-expect-error — the committed document is deeply readonly.
document.goals = {};

// The checker returns the SAME verdict type the event runtime's verifier
// returns; this fails to compile if the type were re-declared locally.
const checker: AxWorkingStateChecker<Facts> = (context) => {
  const verdict: AxEventVerifierResult =
    context.proposedState.facts.shipped === true
      ? { status: 'pass' }
      : { status: 'fail', failure: { code: 'not_shipped' } };
  return verdict;
};
void checker;

// `AxStatePatchOp` discriminates on `op`: a `remove` carries no `value`.
declare const removeOp: Extract<AxStatePatchOp, { op: 'remove' }>;
// @ts-expect-error — `remove` has no `value` property.
void removeOp.value;

declare const step: AxWorkingStateTraceStep;
// @ts-expect-error — the trace record is deeply readonly.
step.committed[0] = 'goal_add';

async function typed(): Promise<void> {
  const state: AxWorkingState<Facts> = await axWorkingState<Facts>(
    { stateSignature: 'shipped:boolean, itemsPacked:number' },
    { runId: 'ws:x:1', stage: 'executor' }
  );
  const facts: Readonly<Facts> = state.current().facts;
  void facts;
}
void typed;
