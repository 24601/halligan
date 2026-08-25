import { describe, expect, it, vi } from 'vitest';
import { AxEventComponentManager } from './components.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AxEventComponentManager', () => {
  it('activates dependencies first, deactivates dependents first, and rejects cycles', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'store',
      version: '1',
      activate: (context) => {
        lifecycle.push('store:activate');
        context.addDisposer('store', () => lifecycle.push('store:dispose'));
        return { ready: true };
      },
    });
    await manager.define({
      id: 'listener',
      version: '1',
      dependencies: ['store'],
      activate: (context) => {
        expect(context.dependency<{ ready: boolean }>('store').ready).toBe(
          true
        );
        lifecycle.push('listener:activate');
        context.addDisposer('listener', () =>
          lifecycle.push('listener:dispose')
        );
      },
    });

    await manager.activate('listener');
    await manager.deactivate('store');

    expect(lifecycle).toEqual([
      'store:activate',
      'listener:activate',
      'listener:dispose',
      'store:dispose',
    ]);

    const cyclic = new AxEventComponentManager();
    await cyclic.define({
      id: 'a',
      version: '1',
      dependencies: ['b'],
      activate: () => undefined,
    });
    await expect(
      cyclic.define({
        id: 'b',
        version: '1',
        dependencies: ['a'],
        activate: () => undefined,
      })
    ).rejects.toThrow('a -> b -> a');
    expect(cyclic.inspect('b')).toBeUndefined();
  });

  it('rolls back a failed activation transaction in reverse order', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'provider',
      version: '1',
      activate: (context) => {
        context.addDisposer('provider', () => lifecycle.push('provider'));
      },
    });
    await manager.define({
      id: 'consumer',
      version: '1',
      dependencies: ['provider'],
      activate: (context) => {
        context.addDisposer('first', () => lifecycle.push('first'));
        context.addDisposer('second', () => lifecycle.push('second'));
        throw new Error('activation fault');
      },
    });

    await expect(manager.activate('consumer')).rejects.toThrow(
      'activation transaction failed'
    );

    expect(lifecycle).toEqual(['second', 'first', 'provider']);
    expect(manager.inspect('provider')?.state).toBe('defined');
    expect(manager.inspect('consumer')).toMatchObject({
      state: 'failed',
      lastError: expect.anything(),
    });
  });

  it('disposes effects in reverse registration order and continues after errors', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'fallible',
      version: '1',
      activate: (context) => {
        context.addDisposer('last', () => lifecycle.push('last'));
        context.addDisposer('failing', () => {
          lifecycle.push('failing');
          throw new Error('dispose fault');
        });
        context.addDisposer('first', () => lifecycle.push('first'));
      },
    });
    await manager.activate();

    await expect(manager.deactivate()).rejects.toThrow(
      'Failed to deactivate 1 event component effect'
    );

    expect(lifecycle).toEqual(['first', 'failing', 'last']);
    expect(manager.inspect('fallible')).toMatchObject({
      state: 'failed',
      diagnostics: [expect.objectContaining({ code: 'disposer-failed' })],
    });
  });

  it('switches to a successful replacement only after candidate activation', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'adapter',
      version: '1',
      activate: (context) => {
        lifecycle.push('v1:activate');
        context.addDisposer('v1', () => lifecycle.push('v1:dispose'));
        return 'v1';
      },
    });
    await manager.activate();

    await manager.replace({
      id: 'adapter',
      version: '2',
      activate: (context) => {
        expect(manager.get('adapter')).toBe('v1');
        lifecycle.push('v2:activate');
        context.addDisposer('v2', () => lifecycle.push('v2:dispose'));
        return 'v2';
      },
    });

    expect(manager.get('adapter')).toBe('v2');
    expect(lifecycle).toEqual(['v1:activate', 'v2:activate', 'v1:dispose']);
  });

  it('keeps the prior component active when a replacement candidate fails', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'adapter',
      version: '1',
      activate: (context) => {
        context.addDisposer('v1', () => lifecycle.push('v1:dispose'));
        return 'v1';
      },
    });
    await manager.activate();

    await expect(
      manager.replace({
        id: 'adapter',
        version: '2',
        activate: (context) => {
          context.addDisposer('v2', () => lifecycle.push('v2:dispose'));
          throw new Error('candidate fault');
        },
      })
    ).rejects.toThrow('adapter@1 and its active dependents remain active');

    expect(manager.get('adapter')).toBe('v1');
    expect(manager.inspect('adapter')).toMatchObject({
      version: '1',
      state: 'active',
      diagnostics: [expect.objectContaining({ code: 'replacement-failed' })],
    });
    expect(lifecycle).toEqual(['v2:dispose']);
  });

  it('reactivates the active dependent closure against one replacement graph', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'provider',
      version: '1',
      activate: (context) => {
        context.addDisposer('provider-v1', () =>
          lifecycle.push('provider-v1:dispose')
        );
        return 'v1';
      },
    });
    await manager.define({
      id: 'consumer',
      version: '1',
      dependencies: ['provider'],
      activate: (context) => {
        const provider = context.dependency<string>('provider');
        lifecycle.push(`consumer:${provider}:activate`);
        context.addDisposer(`consumer-${provider}`, () =>
          lifecycle.push(
            `consumer-${context.dependency<string>('provider')}:dispose`
          )
        );
        return provider;
      },
    });
    await manager.activate();

    await manager.replace({
      id: 'provider',
      version: '2',
      activate: (context) => {
        lifecycle.push('provider-v2:activate');
        context.addDisposer('provider-v2', () =>
          lifecycle.push('provider-v2:dispose')
        );
        return 'v2';
      },
    });

    expect(manager.get('provider')).toBe('v2');
    expect(manager.get('consumer')).toBe('v2');
    expect(lifecycle).toEqual([
      'consumer:v1:activate',
      'provider-v2:activate',
      'consumer:v2:activate',
      'consumer-v1:dispose',
      'provider-v1:dispose',
    ]);
  });

  it('restores the complete prior graph when a staged dependent fails', async () => {
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'provider',
      version: '1',
      activate: (context) => {
        context.addDisposer('provider-v1', () =>
          lifecycle.push('provider-v1:dispose')
        );
        return 'v1';
      },
    });
    await manager.define({
      id: 'consumer',
      version: '1',
      dependencies: ['provider'],
      activate: (context) => {
        const provider = context.dependency<string>('provider');
        context.addDisposer(`consumer-${provider}`, () =>
          lifecycle.push(`consumer-${provider}:dispose`)
        );
        if (provider === 'v2') throw new Error('dependent candidate fault');
        return provider;
      },
    });
    await manager.activate();

    await expect(
      manager.replace({
        id: 'provider',
        version: '2',
        activate: (context) => {
          context.addDisposer('provider-v2', () =>
            lifecycle.push('provider-v2:dispose')
          );
          return 'v2';
        },
      })
    ).rejects.toThrow('provider@1 and its active dependents remain active');

    expect(manager.get('provider')).toBe('v1');
    expect(manager.get('consumer')).toBe('v1');
    expect(manager.inspect('provider')?.diagnostics).toEqual([
      expect.objectContaining({ code: 'replacement-failed' }),
    ]);
    expect(lifecycle).toEqual(['consumer-v2:dispose', 'provider-v2:dispose']);
  });

  it('serializes concurrent conflicting transitions', async () => {
    const gate = deferred();
    const lifecycle: string[] = [];
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'listener',
      version: '1',
      activate: async (context) => {
        lifecycle.push('activate:start');
        await gate.promise;
        context.addDisposer('listener', () => lifecycle.push('dispose'));
        lifecycle.push('activate:end');
      },
    });

    const activation = manager.activate();
    const deactivation = manager.deactivate();
    await Promise.resolve();
    expect(manager.inspect('listener')?.state).toBe('activating');
    gate.resolve();
    await Promise.all([activation, deactivation]);

    expect(lifecycle).toEqual(['activate:start', 'activate:end', 'dispose']);
    expect(manager.inspect('listener')?.state).toBe('defined');
  });

  it('makes repeated lifecycle calls idempotent', async () => {
    const activate = vi.fn();
    const dispose = vi.fn();
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'once',
      version: '1',
      activate: (context) => {
        activate();
        context.addDisposer('once', dispose);
      },
    });

    await manager.activate();
    await manager.activate();
    await manager.deactivate();
    await manager.deactivate();
    await manager.dispose();
    await manager.dispose();

    expect(activate).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.inspect('once')?.state).toBe('disposed');
  });

  it('aborts activation and rolls back registered effects', async () => {
    const controller = new AbortController();
    const dispose = vi.fn();
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'abortable',
      version: '1',
      activate: async (context) => {
        context.addDisposer('resource', dispose);
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true }
          );
        });
      },
    });

    const activation = manager.activate(undefined, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error('stop activation'));

    await expect(activation).rejects.toThrow('activation transaction failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.inspect('abortable')?.state).toBe('failed');
  });

  it('diagnoses acquisitions that fail to return a disposer', async () => {
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'leaky',
      version: '1',
      activate: (context) =>
        context.acquire('socket', () => ({ value: 'socket' }) as any),
    });

    await expect(manager.activate()).rejects.toThrow();
    expect(manager.inspect('leaky')?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'missing-disposer',
        effect: 'socket',
      }),
    ]);
  });

  it('does not claim to reverse an effect the host never registers', async () => {
    let unmanagedResources = 0;
    const manager = new AxEventComponentManager();
    await manager.define({
      id: 'unmanaged',
      version: '1',
      activate: () => {
        unmanagedResources++;
        throw new Error('after unmanaged effect');
      },
    });

    await expect(manager.activate()).rejects.toThrow();

    expect(unmanagedResources).toBe(1);
    expect(manager.inspect('unmanaged')?.diagnostics).toEqual([]);
  });
});
