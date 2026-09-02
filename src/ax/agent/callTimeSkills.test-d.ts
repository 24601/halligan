/**
 * Compile-time contract for the call-time skill surface. Run by
 * `tsc -p tsconfig.typetests.json`; nothing here executes.
 *
 * The runtime tests cover the values; these cover the claims that only exist
 * in the type system — the closed marker shape, the deep readonly-ness that
 * stops a host mutating a returned marker, the two accepted skill forms, and
 * the guard's narrowing.
 */

import type { AxAgentSkillResult } from './agentInternal/skillsTypes.js';
import {
  type AxCallTimeSkillBinding,
  type AxCallTimeSkillNotExecuted,
  AxCallTimeSkillRuntime,
  axCallTimeSkillRuntime,
  axIsCallTimeSkillNotExecuted,
} from './callTimeSkills.js';
import type { AxWorkingStateDocument } from './workingState.js';

type Facts = { shipped: boolean };

// The house pattern: validation lives in the factory, so the constructor is
// private.
// @ts-expect-error — the constructor is private.
void new AxCallTimeSkillRuntime({} as never, {} as never);

// Both accepted skill forms: a catalog id and an inline result.
const byId: AxCallTimeSkillBinding = {
  qualifiedName: 'inventory.adjustStock',
  skill: 'stock-adjustment',
};
void byId;

const inline: AxAgentSkillResult = {
  id: 'stock-adjustment',
  name: 'Stock adjustment',
  content: 'body',
};
const byValue: AxCallTimeSkillBinding = {
  qualifiedName: 'inventory.adjustStock',
  skill: inline,
  maxInjections: 2,
  when: (state: Readonly<AxWorkingStateDocument<Facts>>) =>
    state.facts.shipped !== true,
};
void byValue;

// @ts-expect-error — a binding is readonly.
byValue.maxInjections = 3;

const refBinding: AxCallTimeSkillBinding = {
  qualifiedName: 'inventory.adjustStock',
  // @ts-expect-error — an executable-skill ref carries no body text, so it
  // cannot render a procedure; `skill` takes a catalog id or a skill result.
  skill: { id: 'stock-adjustment', version: '1.0.0' },
};
void refBinding;

declare const marker: AxCallTimeSkillNotExecuted;
const notExecuted: true = marker.__axNotExecuted;
const reason: 'skill_injected' = marker.reason;
const guidance: string = marker.guidance;
void notExecuted;
void reason;
void guidance;

// @ts-expect-error — the marker is frozen by construction and readonly by type.
marker.qualifiedName = 'other';

// @ts-expect-error — the reason vocabulary is closed.
const otherReason: AxCallTimeSkillNotExecuted['reason'] = 'executed';
void otherReason;

declare const value: unknown;
if (axIsCallTimeSkillNotExecuted(value)) {
  // The guard narrows, so a host can read the skill id without a cast.
  const skillId: string = value.skillId;
  void skillId;
}

const runtime = axCallTimeSkillRuntime([byId], {
  resolveSkill: (id: string) => ({ id, name: id, content: 'body' }),
});
const bound: ReadonlySet<string> = runtime.bound();
void bound;
const hook = runtime.register('inventory.adjustStock');
const hookResult: AxCallTimeSkillNotExecuted | undefined = hook?.();
void hookResult;
const injections: number = runtime.injections();
void injections;
