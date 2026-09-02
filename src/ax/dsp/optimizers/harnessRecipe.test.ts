import { describe, expect, it } from 'vitest';

import { axEventCanonicalJson } from '../../event/util.js';
import { sha256 } from '../../util/crypto.js';
import { axDigestStrength } from './digests.js';
import {
  axAssertHarnessStampFresh,
  axHarnessPortId,
  axHarnessRecipe,
  axHarnessRecipeVersion,
  axHarnessStamp,
  axIsCandidateStaleError,
  axIsHarnessPortId,
  axIsHarnessRecipeError,
  axIsHarnessStampStale,
} from './harnessRecipe.js';

const bindings = [
  { port: 'exec.dispatch', atomId: 'worker-pool', version: '3.1.0' },
  { port: 'memory.store', atomId: 'sqlite', version: '1.4.2' },
  { port: 'tools.registry', atomId: 'default', version: '0.9.0' },
];

describe('axHarnessPortId', () => {
  it('accepts a lowercase dotted port id', () => {
    expect(axIsHarnessPortId('exec.dispatch')).toBe(true);
    expect(axHarnessPortId('exec.dispatch')).toBe('exec.dispatch');
    // Nested segments and camelCase tails are allowed after the first segment.
    expect(axIsHarnessPortId('memory.longTerm.store')).toBe(true);
    expect(axIsHarnessPortId('a.b')).toBe(true);
  });

  it('rejects a malformed port id', () => {
    for (const bad of [
      'Exec.Dispatch',
      'exec',
      'exec..dispatch',
      '.exec',
      'exec.',
      '1exec.dispatch',
      'exec.Dispatch.',
      'exec dispatch',
      'exec.dispatch!',
      '',
      `${'a'.repeat(60)}.${'b'.repeat(10)}`,
    ]) {
      expect(axIsHarnessPortId(bad), bad).toBe(false);
      expect(() => axHarnessPortId(bad)).toThrowError(
        expect.objectContaining({ code: 'invalid_port', port: bad })
      );
    }
  });
});

describe('axHarnessRecipe', () => {
  it('digests a binding set independent of input order', async () => {
    const forward = await axHarnessRecipe({
      bindings,
      boundModelId: 'gpt-5',
    });
    const shuffled = await axHarnessRecipe({
      bindings: [bindings[2]!, bindings[0]!, bindings[1]!],
      boundModelId: 'gpt-5',
    });
    expect(forward.digest).toBe(shuffled.digest);
    // ...and the sorted binding list is what the digest was taken over.
    expect(forward.bindings.map((atom) => atom.port)).toEqual([
      'exec.dispatch',
      'memory.store',
      'tools.registry',
    ]);
    expect(forward.bindings).toEqual(shuffled.bindings);
    expect(forward.version).toBe(axHarnessRecipeVersion);
  });

  it('digests exactly the canonical bindings plus the bound model id', async () => {
    // The reuse claim is executable: this is `axEventCanonicalJson` and
    // WebCrypto, not a second serializer and not a truncated hash.
    const recipe = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    const expected = await sha256(
      axEventCanonicalJson({
        bindings: recipe.bindings,
        boundModelId: 'gpt-5',
      })
    );
    expect(recipe.digest).toBe(`sha256:${expected}`);
    expect(axDigestStrength(recipe.digest)).toBe('identity');
  });

  it('changes the digest when any atom version changes', async () => {
    const base = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    const bumped = await axHarnessRecipe({
      bindings: [
        { ...bindings[0]!, version: '3.1.1' },
        bindings[1]!,
        bindings[2]!,
      ],
      boundModelId: 'gpt-5',
    });
    expect(bumped.digest).not.toBe(base.digest);
  });

  it('changes the digest when an atom id changes', async () => {
    const base = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    const swapped = await axHarnessRecipe({
      bindings: [
        bindings[0]!,
        { ...bindings[1]!, atomId: 'postgres' },
        bindings[2]!,
      ],
      boundModelId: 'gpt-5',
    });
    expect(swapped.digest).not.toBe(base.digest);
  });

  it('changes the digest when boundModelId changes', async () => {
    // The model id is INSIDE the digest, so a recipe cannot be silently reused
    // across models: the same sockets tuned against a different model are a
    // different configuration.
    const a = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    const b = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5-mini' });
    expect(a.digest).not.toBe(b.digest);
  });

  it('rejects a malformed or duplicate port', async () => {
    await expect(
      axHarnessRecipe({
        bindings: [{ port: 'Exec.Dispatch', atomId: 'x', version: '1' }],
        boundModelId: 'gpt-5',
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid_port' }));
    await expect(
      axHarnessRecipe({
        bindings: [
          { port: 'exec.dispatch', atomId: 'a', version: '1' },
          { port: 'exec.dispatch', atomId: 'b', version: '1' },
        ],
        boundModelId: 'gpt-5',
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'duplicate_port',
        port: 'exec.dispatch',
      })
    );
  });

  it('rejects an empty binding set and an unusable model id', async () => {
    await expect(
      axHarnessRecipe({ bindings: [], boundModelId: 'gpt-5' })
    ).rejects.toThrowError(expect.objectContaining({ code: 'empty_bindings' }));
    for (const boundModelId of ['', '  gpt-5', 'x'.repeat(129)]) {
      await expect(
        axHarnessRecipe({ bindings, boundModelId })
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'invalid_model_id' })
      );
    }
  });

  it('rejects an unusable atom id or version', async () => {
    for (const atom of [
      { port: 'exec.dispatch', atomId: '', version: '1' },
      { port: 'exec.dispatch', atomId: ' pool', version: '1' },
      { port: 'exec.dispatch', atomId: 'x'.repeat(129), version: '1' },
      { port: 'exec.dispatch', atomId: 'pool', version: '' },
      { port: 'exec.dispatch', atomId: 'pool', version: '1 ' },
    ]) {
      await expect(
        axHarnessRecipe({ bindings: [atom], boundModelId: 'gpt-5' })
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'invalid_atom_id' })
      );
    }
  });

  it('deeply freezes the recipe it returns', async () => {
    const recipe = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(Object.isFrozen(recipe.bindings)).toBe(true);
    expect(Object.isFrozen(recipe.bindings[0])).toBe(true);
    // A recipe whose bindings can be edited after digesting is a digest that
    // proves nothing.
    expect(() => {
      (recipe.bindings as { push: (atom: unknown) => void }).push({
        port: 'x.y',
        atomId: 'z',
        version: '1',
      });
    }).toThrow();
  });

  it('recognizes its own error structurally across realms', async () => {
    const thrown = await axHarnessRecipe({
      bindings: [],
      boundModelId: 'gpt-5',
    }).catch((error: unknown) => error);
    expect(axIsHarnessRecipeError(thrown)).toBe(true);
    expect(
      axIsHarnessRecipeError({
        name: 'AxHarnessRecipeError',
        code: 'invalid_port',
      })
    ).toBe(true);
    expect(
      axIsHarnessRecipeError({
        name: 'AxHarnessRecipeError',
        code: 'nope',
      })
    ).toBe(false);
    expect(axIsHarnessRecipeError(new Error('nope'))).toBe(false);
  });
});

describe('axHarnessStamp', () => {
  it('leaves stale absent when no currentModelId is supplied', async () => {
    // Absent means "not evaluated", never "fresh". A host that never told Ax
    // which model it was running gets no staleness claim, in either direction.
    const recipe = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    const stamp = axHarnessStamp(recipe);
    expect(stamp).toEqual({
      recipeDigest: recipe.digest,
      boundModelId: 'gpt-5',
    });
    expect('stale' in stamp).toBe(false);
  });

  it('marks a candidate stale only when the bound model id changed', async () => {
    const recipe = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    expect('stale' in axHarnessStamp(recipe, 'gpt-5')).toBe(false);
    expect(axHarnessStamp(recipe, 'gpt-5-mini').stale).toBe(true);
    expect(axIsHarnessStampStale(axHarnessStamp(recipe), 'gpt-5')).toBe(false);
    expect(axIsHarnessStampStale(axHarnessStamp(recipe), 'claude-x')).toBe(
      true
    );
  });

  it('refuses a stale stamp only when the host asks it to', async () => {
    // Ax records staleness; refusing is the host's call, so the assertion is a
    // separate function rather than something the stamp does on construction.
    const recipe = await axHarnessRecipe({ bindings, boundModelId: 'gpt-5' });
    const stamp = axHarnessStamp(recipe, 'gpt-5-mini');
    expect(stamp.stale).toBe(true);
    expect(() => axAssertHarnessStampFresh(stamp, 'gpt-5')).not.toThrow();
    let thrown: unknown;
    try {
      axAssertHarnessStampFresh(stamp, 'gpt-5-mini');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'AxCandidateStaleError',
      code: 'bound_model_changed',
      boundModelId: 'gpt-5',
      observedModelId: 'gpt-5-mini',
    });
    expect(axIsCandidateStaleError(thrown)).toBe(true);
    expect(
      axIsCandidateStaleError({
        name: 'AxCandidateStaleError',
        code: 'bound_model_changed',
      })
    ).toBe(true);
    expect(axIsCandidateStaleError(new Error('nope'))).toBe(false);
  });
});
