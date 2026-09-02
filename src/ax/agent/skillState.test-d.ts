/**
 * Compile-time contract for the `skillState` surface. Run by
 * `tsc -p tsconfig.typetests.json`; nothing here executes.
 *
 * The runtime tests cover the values; these cover the claims that only exist
 * in the type system — the `S` thread through the factory, the narrowing of
 * `AxProgramStateEnvelope['state']` from `unknown` to the working-state
 * document, and the house pattern that a runtime can only be built by its
 * factory.
 */

import type { AxProgramStateEnvelope } from '../event/types.js';
import type { AxExecutableSkillRef } from './executableSkills.js';
import {
  type AxSkillStateConfig,
  type AxSkillStateEnvelope,
  AxSkillStateRuntime,
  type AxSkillStateStep,
  type AxSkillStateTransition,
  axSkillStateRuntime,
} from './skillState.js';
import type { AxWorkingState } from './workingState.js';

type Facts = { shipped: boolean; itemsPacked: number };

// The house pattern: validation lives in the factory, so the constructor is
// private. This is the assertion the runtime test could not make — a JS-level
// `new` throws only because the argument destructure fails.
// @ts-expect-error — the constructor is private.
void new AxSkillStateRuntime<Facts>({} as never);

declare const envelope: AxSkillStateEnvelope<Facts>;

// The whole point of the narrowed envelope: `state` is the working-state
// document, not the base type's `unknown`.
const shipped: boolean = envelope.state.facts.shipped;
void shipped;
const baseState: unknown = ({} as AxProgramStateEnvelope).state;
void baseState;

// @ts-expect-error — the fact space is closed by the declared type.
void envelope.state.facts.notDeclared;

// @ts-expect-error — the envelope is readonly.
envelope.revision = 2;

declare const step: AxSkillStateStep<Facts>;
const revision: number = step.state.revision;
const observation: string = step.observation;
const skillBody: string = step.skill.content;
void revision;
void observation;
void skillBody;

declare const transition: AxSkillStateTransition<Facts>;
// `rationaleDigest` is optional: an absent rationale produces no digest.
const digest: string | undefined = transition.rationaleDigest;
void digest;
// `committedRevision` is NOT optional: the store is never absent.
const committed: number = transition.committedRevision;
void committed;
// @ts-expect-error — the transition record is readonly.
transition.accepted = false;
// @ts-expect-error — the rejection vocabulary is closed.
const rejection: AxSkillStateTransition<Facts>['rejection'] = 'timeout';
void rejection;

// A ref-shaped skill is accepted, and so is a resolved one.
const refConfig: AxSkillStateConfig<Facts> = {
  skill: { id: 'warehouse', version: '1.0.0' } satisfies AxExecutableSkillRef,
  resolveSkill: async (ref) => ({
    id: ref.id,
    name: 'Resolved',
    content: 'body',
  }),
};
void refConfig;

async function typed(state: AxWorkingState<Facts>): Promise<void> {
  // `S` threads from the working state through the factory to the step.
  const runtime = await axSkillStateRuntime<Facts>(
    { skill: { id: 'p', name: 'P', content: 'body' } },
    state
  );
  const packed: number = runtime.step().state.state.facts.itemsPacked;
  void packed;
  const transitions: readonly AxSkillStateTransition<Facts>[] =
    runtime.transitions();
  void transitions;
}
void typed;
