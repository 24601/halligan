import type { Equal, Expect } from '../../util/typetest.js';
import type { AxProgramSourceCapability } from '../programSource.js';
import type {
  AxHarnessAtom,
  AxHarnessPortId,
  AxHarnessRecipe,
  AxHarnessStamp,
  axHarnessRecipe,
} from './harnessRecipe.js';

/**
 * THE DOCTRINE PROOF.
 *
 * Free AST mutation inside a program, fixed named sockets around it. The two
 * vocabularies must not become interchangeable, because the moment a port id
 * can stand in for a program-source capability (or vice versa) the harness
 * starts describing the inside of the thing it is only supposed to surround.
 *
 * This is a TYPE-LEVEL proof on purpose. The obvious alternative — read this
 * file and assert it imports nothing from `programSource.ts` — proves only that
 * one file had no import on the day it was written, passes on a rename, and
 * breaks the moment the module is bundled or moved.
 */
declare const capability: AxProgramSourceCapability;
declare const portId: AxHarnessPortId;

// @ts-expect-error a program-source capability is not a harness port id
const _capabilityAsPort: AxHarnessPortId = capability;
// @ts-expect-error a harness port id is not a program-source capability
const _portAsCapability: AxProgramSourceCapability = portId;

// A component key is an ordinary string; it must not be usable as a socket name
// without going through the validating factory.
declare const componentKey: string;
const _atomFromKey: AxHarnessAtom = {
  // @ts-expect-error a component key is not a validated harness port id
  port: componentKey,
  atomId: 'worker-pool',
  version: '1.0.0',
};

/**
 * An atom is three strings and nothing else. This equality is what stops the
 * module from growing a `source`, `ast`, `capabilities` or `signature` member
 * later: adding one fails here, in a test whose comment says why.
 */
type _atomIsOnlyASocketBinding = Expect<
  Equal<keyof AxHarnessAtom, 'port' | 'atomId' | 'version'>
>;
type _recipeShape = Expect<
  Equal<
    keyof AxHarnessRecipe,
    'version' | 'bindings' | 'digest' | 'boundModelId'
  >
>;
type _stampShape = Expect<
  Equal<keyof AxHarnessStamp, 'recipeDigest' | 'boundModelId' | 'stale'>
>;

// The recipe is async because its digest is identity strength.
type _recipeIsAsync = Expect<
  Equal<ReturnType<typeof axHarnessRecipe>, Promise<AxHarnessRecipe>>
>;

declare const recipe: AxHarnessRecipe;
// @ts-expect-error a published recipe is read-only
recipe.boundModelId = 'other';
// @ts-expect-error the binding list is read-only
recipe.bindings.push({ port: portId, atomId: 'x', version: '1' });

declare const stamp: AxHarnessStamp;
// `stale` is `true | undefined`, never `false`: there is no way to express
// "evaluated and fresh" as a stored value, so absence cannot be misread as a
// freshness claim.
type _staleIsNeverFalse = Expect<
  Equal<AxHarnessStamp['stale'], true | undefined>
>;
// @ts-expect-error a stamp cannot claim freshness
const _fresh: AxHarnessStamp = { ...stamp, stale: false };
