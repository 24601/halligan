import {
  AxTrajectoryBlobError,
  type AxTrajectoryBlobRef,
  type AxTrajectoryBlobStore,
  type AxTrajectoryFieldValue,
  type AxTrajectoryStep,
} from './types.js';
import {
  axTrajectoryTruncateUtf8,
  axTrajectoryUtf8ByteLength,
} from './util.js';

export interface AxTrajectorySpillPolicy {
  /** Any string field at or above this many UTF-8 bytes spills. Default 4096. */
  readonly spillBytes: number;
  /** Bytes of head kept inline on the step. Derived: spillBytes / 4. */
  readonly inlineBytes?: number;
  /** Spill fields not named by the registry descriptor too. Default true. */
  readonly genericSpill?: boolean;
}

export const axDefaultTrajectorySpillPolicy: Readonly<AxTrajectorySpillPolicy> =
  Object.freeze({ spillBytes: 4096, genericSpill: true });

export interface AxTrajectorySpillRequest {
  readonly trajectoryId: string;
  readonly stepId: string;
  readonly data: Readonly<Record<string, AxTrajectoryFieldValue>>;
  readonly blobs?: AxTrajectoryBlobStore;
  readonly policy?: Readonly<AxTrajectorySpillPolicy>;
  /** Registry-declared fields, consulted when genericSpill is false. */
  readonly spillFields?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AxTrajectorySpillResult {
  readonly data: Readonly<Record<string, AxTrajectoryFieldValue>>;
  readonly blobs: readonly Readonly<AxTrajectoryBlobRef>[];
  readonly spilled: readonly string[];
}

/** Bytes of inline head kept for a spilled field. */
export function axTrajectoryInlineBytes(
  policy: Readonly<AxTrajectorySpillPolicy>
): number {
  return policy.inlineBytes ?? Math.floor(policy.spillBytes / 4);
}

/**
 * Write side: move oversized string fields into the blob store. Generic by
 * default — a size-based rule on ANY string field, not an allowlist of the
 * two fields someone remembered, which is how a log grows unboundedly.
 */
export async function axSpillTrajectoryFields(
  request: Readonly<AxTrajectorySpillRequest>
): Promise<Readonly<AxTrajectorySpillResult>> {
  const policy = request.policy ?? axDefaultTrajectorySpillPolicy;
  const store = request.blobs;
  if (!store) {
    return { data: request.data, blobs: [], spilled: [] };
  }
  const generic = policy.genericSpill !== false;
  const declared = new Set(request.spillFields ?? []);
  const inlineBytes = axTrajectoryInlineBytes(policy);
  const data: Record<string, AxTrajectoryFieldValue> = { ...request.data };
  const refs: AxTrajectoryBlobRef[] = [];
  const spilled: string[] = [];

  for (const [field, value] of Object.entries(request.data)) {
    if (typeof value !== 'string') continue;
    if (!generic && !declared.has(field)) continue;
    const bytes = axTrajectoryUtf8ByteLength(value);
    if (bytes < policy.spillBytes) continue;
    const put = await store.put(
      {
        trajectoryId: request.trajectoryId,
        stepId: request.stepId,
        field,
        value,
      },
      request.signal
    );
    const head = axTrajectoryTruncateUtf8(value, inlineBytes);
    data[field] = head;
    refs.push({
      field,
      ref: put.ref,
      bytes: put.bytes,
      digest: put.digest,
      inlineBytes: axTrajectoryUtf8ByteLength(head),
      truncated: true,
    });
    spilled.push(field);
  }
  return { data, blobs: refs, spilled };
}

export interface AxTrajectoryResolveOptions {
  /** Resolve only these fields. Default: every spilled field. */
  readonly fields?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * The read-side deliverable. The write side is trivial; every consumer that
 * reads a potentially-large field must rehydrate or silently see a truncated
 * head. Verifies the digest and throws on mismatch or absence.
 */
export async function axResolveTrajectoryStep(
  step: Readonly<AxTrajectoryStep>,
  blobs: AxTrajectoryBlobStore | undefined,
  options?: Readonly<AxTrajectoryResolveOptions>
): Promise<Readonly<AxTrajectoryStep>> {
  const [resolved] = await axResolveTrajectorySteps([step], blobs, options);
  return resolved ?? step;
}

/** Batch form; exactly one blob fetch per distinct ref (the prepass). */
export async function axResolveTrajectorySteps(
  steps: readonly Readonly<AxTrajectoryStep>[],
  blobs: AxTrajectoryBlobStore | undefined,
  options?: Readonly<AxTrajectoryResolveOptions>
): Promise<readonly Readonly<AxTrajectoryStep>[]> {
  const wanted = options?.fields ? new Set(options.fields) : undefined;
  const selected = (ref: Readonly<AxTrajectoryBlobRef>): boolean =>
    !wanted || wanted.has(ref.field);

  const pending = new Map<string, Readonly<AxTrajectoryBlobRef>>();
  for (const step of steps) {
    for (const ref of step.blobs ?? []) {
      if (selected(ref) && !pending.has(ref.ref)) pending.set(ref.ref, ref);
    }
  }
  if (pending.size === 0) return steps;
  if (!blobs) {
    const first = [...pending.values()][0]!;
    throw new AxTrajectoryBlobError(
      `cannot rehydrate field "${first.field}": the store exposes no blob store`,
      'missing',
      first.ref,
      first.digest
    );
  }

  const values = new Map<string, string>();
  for (const ref of pending.values()) {
    values.set(ref.ref, await blobs.get(ref.ref, ref.digest, options?.signal));
  }

  return steps.map((step) => {
    const refs = step.blobs ?? [];
    if (refs.length === 0) return step;
    const data: Record<string, AxTrajectoryFieldValue> = { ...step.data };
    const keep: Readonly<AxTrajectoryBlobRef>[] = [];
    for (const ref of refs) {
      const value = selected(ref) ? values.get(ref.ref) : undefined;
      if (value === undefined) keep.push(ref);
      else data[ref.field] = value;
    }
    // Dropping resolved refs makes "already rehydrated" observable and keeps
    // a second resolve a no-op instead of a second fetch.
    return keep.length > 0
      ? { ...step, data, blobs: keep }
      : { ...step, data, blobs: undefined };
  });
}
