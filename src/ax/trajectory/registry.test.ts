import { describe, expect, it, vi } from 'vitest';

import {
  axDefaultTrajectoryTypes,
  axTrajectoryTypeRegistry,
  axTrajectoryUnknownDescriptor,
} from './registry.js';
import {
  AxTrajectoryRegistryError,
  type AxTrajectoryStepClass,
} from './types.js';

/**
 * The normative table from the RFC, transcribed independently of the
 * implementation so a silent edit to a descriptor fails here. Columns are
 * [type, stepClass, wakeable, wakeSignal, carriesSource, conversational,
 * visibleWork, neverRetriggersSelf, spillFields].
 */
const TABLE: readonly [
  string,
  AxTrajectoryStepClass,
  boolean,
  boolean | undefined,
  boolean,
  boolean | undefined,
  boolean | undefined,
  boolean | undefined,
  readonly string[] | undefined,
][] = [
  [
    'trajectory',
    'structural',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  ],
  [
    'fork',
    'structural',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  ],
  [
    'merge',
    'structural',
    true,
    false,
    false,
    undefined,
    true,
    undefined,
    ['content'],
  ],
  [
    'thought',
    'narrative',
    true,
    false,
    true,
    undefined,
    false,
    undefined,
    ['content'],
  ],
  [
    'action',
    'narrative',
    true,
    false,
    true,
    undefined,
    true,
    undefined,
    ['content'],
  ],
  [
    'observation',
    'narrative',
    true,
    false,
    true,
    undefined,
    true,
    undefined,
    ['content'],
  ],
  [
    'idle',
    'narrative',
    true,
    false,
    true,
    undefined,
    false,
    undefined,
    undefined,
  ],
  [
    'message',
    'narrative',
    true,
    false,
    true,
    true,
    true,
    undefined,
    ['content'],
  ],
  [
    'error',
    'narrative',
    true,
    false,
    true,
    undefined,
    false,
    true,
    ['content'],
  ],
  [
    'run',
    'machinery',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    ['command'],
  ],
  [
    'run-summary',
    'machinery',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    ['fullSummary'],
  ],
  [
    'runtime-output',
    'machinery',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    ['stdout', 'stderr'],
  ],
  [
    'feedback',
    'machinery',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    ['content'],
  ],
  [
    'reply-claim',
    'machinery',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  ],
  [
    'mind-wake',
    'machinery',
    true,
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  ],
  [
    'mind-idle',
    'machinery',
    true,
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  ],
  [
    'manual-trigger',
    'machinery',
    true,
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  ],
  [
    'mind-error',
    'machinery',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    ['reason'],
  ],
];

describe('axDefaultTrajectoryTypes', () => {
  it('pins the shipped step-type registry table row by row', () => {
    // Ships exactly the declared set: an added or removed row fails here.
    expect(axDefaultTrajectoryTypes.map((d) => d.type)).toEqual(
      TABLE.map(([type]) => type)
    );

    const registry = axTrajectoryTypeRegistry();
    for (const [
      type,
      stepClass,
      wakeable,
      wakeSignal,
      carriesSource,
      conversational,
      visibleWork,
      neverRetriggersSelf,
      spillFields,
    ] of TABLE) {
      const descriptor = registry.describe(type);
      expect(registry.has(type), `${type} is registered`).toBe(true);
      expect(descriptor.stepClass, `${type}.stepClass`).toBe(stepClass);
      expect(descriptor.wakeable, `${type}.wakeable`).toBe(wakeable);
      expect(descriptor.wakeSignal, `${type}.wakeSignal`).toBe(wakeSignal);
      expect(descriptor.carriesSource, `${type}.carriesSource`).toBe(
        carriesSource
      );
      expect(descriptor.conversational, `${type}.conversational`).toBe(
        conversational
      );
      expect(descriptor.visibleWork, `${type}.visibleWork`).toBe(visibleWork);
      expect(
        descriptor.neverRetriggersSelf,
        `${type}.neverRetriggersSelf`
      ).toBe(neverRetriggersSelf);
      expect(descriptor.spillFields, `${type}.spillFields`).toEqual(
        spillFields
      );
    }
  });

  it('ships no dropped-step type, because nothing is ever dropped', () => {
    expect(
      axDefaultTrajectoryTypes.some((d) => d.type.includes('dropped'))
    ).toBe(false);
  });

  it('never lets a machinery type carry a writer identity', () => {
    // I13 at the table level: the write boundary can only fail closed if the
    // shipped table itself never grants source to machinery.
    for (const descriptor of axDefaultTrajectoryTypes) {
      if (descriptor.stepClass === 'machinery') {
        expect(descriptor.carriesSource, descriptor.type).toBe(false);
      }
    }
  });
});

describe('axTrajectoryTypeRegistry', () => {
  it('classifies an unregistered type as unknown and fires onUnknownStepType once', () => {
    const onUnknownStepType = vi.fn();
    const registry = axTrajectoryTypeRegistry(undefined, {
      onUnknownStepType,
    });

    const first = registry.describe('host.custom');
    const second = registry.describe('host.custom');

    expect(registry.has('host.custom')).toBe(false);
    expect(first.stepClass).toBe('unknown');
    expect(first.wakeable).toBe(false);
    // Permissive on source so an unregistered host narrative type still writes.
    expect(first.carriesSource).toBe(true);
    expect(first.type).toBe('host.custom');
    expect(second.type).toBe('host.custom');
    // The fix is the visibility, not the default: once per distinct type.
    expect(onUnknownStepType).toHaveBeenCalledTimes(1);
    expect(onUnknownStepType).toHaveBeenCalledWith('host.custom');

    registry.describe('host.other');
    expect(onUnknownStepType).toHaveBeenCalledTimes(2);
  });

  it('exposes an unknown descriptor template that is not wakeable', () => {
    expect(axTrajectoryUnknownDescriptor.stepClass).toBe('unknown');
    expect(axTrajectoryUnknownDescriptor.wakeable).toBe(false);
  });

  it('merges host descriptors over the defaults and allows a stepClass override', () => {
    const registry = axTrajectoryTypeRegistry([
      {
        type: 'run',
        stepClass: 'narrative',
        wakeable: true,
        carriesSource: true,
      },
      {
        type: 'host.note',
        stepClass: 'narrative',
        wakeable: true,
        carriesSource: true,
      },
    ]);

    expect(registry.describe('run').stepClass).toBe('narrative');
    expect(registry.describe('run').carriesSource).toBe(true);
    expect(registry.has('host.note')).toBe(true);
    // Overriding one row leaves every other shipped row intact.
    expect(registry.describe('thought').stepClass).toBe('narrative');
    expect(registry.types).toHaveLength(axDefaultTrajectoryTypes.length + 1);
  });

  it('refuses to override neverRetriggersSelf on error', () => {
    expect(() =>
      axTrajectoryTypeRegistry([
        {
          type: 'error',
          stepClass: 'narrative',
          wakeable: true,
          carriesSource: true,
          neverRetriggersSelf: false,
        },
      ])
    ).toThrowError(
      expect.objectContaining({
        name: 'AxTrajectoryRegistryError',
        code: 'trajectory_registry_invalid',
        reason: 'protected_flag',
        type: 'error',
      })
    );
  });

  it('refuses to set carriesSource on a machinery type', () => {
    let caught: unknown;
    try {
      axTrajectoryTypeRegistry([
        {
          type: 'reply-claim',
          stepClass: 'machinery',
          wakeable: false,
          carriesSource: true,
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxTrajectoryRegistryError);
    expect((caught as AxTrajectoryRegistryError).reason).toBe('protected_flag');
  });

  it('rejects a duplicate type in a host registry', () => {
    expect(() =>
      axTrajectoryTypeRegistry([
        {
          type: 'host.note',
          stepClass: 'narrative',
          wakeable: true,
          carriesSource: true,
        },
        {
          type: 'host.note',
          stepClass: 'machinery',
          wakeable: false,
          carriesSource: false,
        },
      ])
    ).toThrowError(
      expect.objectContaining({ reason: 'duplicate_type', type: 'host.note' })
    );
  });

  it('rejects a descriptor with no type', () => {
    expect(() =>
      axTrajectoryTypeRegistry([
        {
          type: '',
          stepClass: 'narrative',
          wakeable: true,
          carriesSource: true,
        },
      ])
    ).toThrowError(expect.objectContaining({ reason: 'invalid_descriptor' }));
  });

  it('keeps host entries isolated between registries', () => {
    const custom = axTrajectoryTypeRegistry([
      {
        type: 'host.note',
        stepClass: 'narrative',
        wakeable: true,
        carriesSource: true,
      },
    ]);
    const plain = axTrajectoryTypeRegistry();
    expect(custom.has('host.note')).toBe(true);
    expect(plain.has('host.note')).toBe(false);
  });
});
