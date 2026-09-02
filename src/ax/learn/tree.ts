/**
 * The harness tree: one flat, diffable, digestible entry list over three ax
 * primitives that already exist (an actor instruction, a playbook bullet, a
 * catalog skill), plus the admission gate that decides what may enter it.
 *
 * The gate is the security-relevant half of this file. A tree persists
 * verbatim — into every release, into every gate decision, and into every
 * delivered copy — so a credential that reaches an entry reaches version
 * history, and a proposer that can write bullet evidence can write its own
 * promotion case. Admission therefore runs at seed, on every proposal, and
 * whenever persisted state loads, over every field of every kind including
 * model-authored free text.
 *
 * `axInspectHarnessTree` returns adjudication as DATA: every entry gets a
 * verdict, so one bad entry never hides the verdict on the rest and a proposer
 * gets a per-entry reason it can act on. `axAdmitHarnessTree` is the throwing
 * wrapper over it.
 */

import type { AxAgentCatalogSkill } from '../agent/agentInternal/skillsTypes.js';
import { estimateTokenCount } from '../dsp/optimizers/acePlaybook.js';
import type { AxACEBullet, AxACEPlaybook } from '../dsp/optimizers/aceTypes.js';
import { axEventCanonicalJson } from '../event/util.js';
import { sha256 } from '../util/crypto.js';
import { axAssertPersistableValue } from '../util/persistable.js';

import {
  AxHarnessAdmissionError,
  type AxHarnessAdmissionReason,
  type AxHarnessAdmissionReport,
  type AxHarnessEntry,
  type AxHarnessEntryInspection,
  type AxHarnessMutation,
  AxHarnessMutationError,
  AxHarnessRenderError,
  type AxHarnessRendering,
  type AxHarnessTree,
} from './types.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** One entry, as canonical JSON. */
const MAX_ENTRY_BYTES = 64 * 1024;
/** The whole tree, as canonical JSON. */
const MAX_TREE_BYTES = 1024 * 1024;

/** Path-segment rule for the two ids that become dedup keys downstream. */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The exact config keys each kind may carry. Anything else is refused. */
const CONFIG_KEYS: Readonly<Record<AxHarnessEntry['kind'], readonly string[]>> =
  {
    instruction: ['text'],
    playbookBullet: ['id', 'section', 'content', 'tags'],
    skill: ['skillId', 'name', 'description', 'content'],
  };

/**
 * Fields a proposer may never author on a bullet. They are REJECTED rather
 * than stripped: bullet evidence, counters, revision and lineage sit behind
 * Ax's evaluator boundary, and silently dropping them would teach a proposer
 * that writing them is harmless.
 */
const FORBIDDEN_BULLET_FIELDS = [
  'helpfulCount',
  'harmfulCount',
  'createdAt',
  'updatedAt',
  'revision',
  'lineage',
  'evidence',
] as const;

const KINDS: readonly AxHarnessEntry['kind'][] = [
  'instruction',
  'playbookBullet',
  'skill',
];

// ---------------------------------------------------------------------------
// Credential tripwire
// ---------------------------------------------------------------------------

/** Rule 1: a key whose NAME ends in a credential word. */
const CREDENTIAL_KEY =
  /(?:api[_-]?keys?(?:[_-]?env)?|tokens?|secrets?|passwords?|credentials?)$/i;

/** Rule 2: known credential literal shapes. */
const CREDENTIAL_LITERALS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/** A long opaque run: base64/hex-ish, 40 chars or more. */
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{40,}/g;
/** A credential word near an opaque run turns it into a match. */
const CREDENTIAL_WORD = /(?:api|key|token|secret|password|credential)/i;
/** How far either side of an opaque run a credential word still counts. */
const CREDENTIAL_WORD_WINDOW = 32;

/**
 * True when a string carries something shaped like a credential.
 *
 * This is a tripwire, not a secret scanner: it matches known prefixes and
 * long opaque runs sitting next to a credential word. A novel format under an
 * innocuous name is not caught, and the docs say so.
 */
export const axHarnessLooksLikeCredential = (value: string): boolean => {
  if (CREDENTIAL_LITERALS.some((pattern) => pattern.test(value))) {
    return true;
  }
  OPAQUE_RUN.lastIndex = 0;
  for (
    let match = OPAQUE_RUN.exec(value);
    match !== null;
    match = OPAQUE_RUN.exec(value)
  ) {
    const start = Math.max(0, match.index - CREDENTIAL_WORD_WINDOW);
    const end = Math.min(
      value.length,
      match.index + match[0].length + CREDENTIAL_WORD_WINDOW
    );
    const before = value.slice(start, match.index);
    const after = value.slice(match.index + match[0].length, end);
    if (CREDENTIAL_WORD.test(before) || CREDENTIAL_WORD.test(after)) {
      OPAQUE_RUN.lastIndex = 0;
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

type Finding = Readonly<{ reason: AxHarnessAdmissionReason; path: string }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk every value under `root`, applying both tripwire rules.
 *
 * Rule 1 lands on the KEY (a credential-named key whose value is a string, or
 * an array containing one). Rule 2 lands on the VALUE, which is why free text
 * is walked too — model-authored prose is exactly the return leg a key can
 * come back through.
 */
function scanForCredentials(
  root: unknown,
  rootPath: string,
  findings: Finding[]
): void {
  // A tree arrives from a model, a proposer, or a persisted store, so it may
  // be cyclic or share references. `seen` keeps the walk total: a cycle must
  // be classified (`non-json-config`, below), never crash the inspector.
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string, key?: string): void => {
    if (typeof value === 'string') {
      if (key !== undefined && CREDENTIAL_KEY.test(key)) {
        findings.push({ reason: 'inline-credential', path });
      }
      if (axHarnessLooksLikeCredential(value)) {
        findings.push({ reason: 'credential-shaped-literal', path });
      }
      return;
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      if (key !== undefined && CREDENTIAL_KEY.test(key)) {
        const stringIndex = value.findIndex((item) => typeof item === 'string');
        if (stringIndex >= 0) {
          findings.push({
            reason: 'inline-credential',
            path: `${path}[${stringIndex}]`,
          });
        }
      }
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, `${path}.${childKey}`, childKey);
      }
    }
  };
  walk(root, rootPath);
}

/**
 * Canonical byte length, or `undefined` when the value cannot be canonicalized
 * at all.
 *
 * `axEventCanonicalJson` is a recursive `JSON.stringify`, so a cyclic entry
 * blows the stack. Sizing must therefore be able to FAIL rather than throw:
 * a cycle is `non-json-config` — the reason RFC §6.5 names first — and
 * `axInspectHarnessTree`'s contract is that a denial is data.
 */
function canonicalByteLength(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(axEventCanonicalJson(value as never))
      .byteLength;
  } catch {
    return undefined;
  }
}

function requireText(
  config: Record<string, unknown>,
  field: string,
  findings: Finding[]
): void {
  const value = config[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    findings.push({ reason: 'empty-text', path: `config.${field}` });
  }
}

function requireSegment(
  config: Record<string, unknown>,
  field: string,
  findings: Finding[]
): void {
  const value = config[field];
  if (typeof value !== 'string' || !NAME_SEGMENT.test(value)) {
    findings.push({ reason: 'invalid-name-segment', path: `config.${field}` });
  }
}

/** The target two entries of one kind must not share. */
function renderTarget(entry: AxHarnessEntry): string | undefined {
  if (entry.kind === 'skill') {
    const skillId = (entry.config as { skillId?: unknown }).skillId;
    return typeof skillId === 'string' ? `skill:${skillId}` : undefined;
  }
  if (entry.kind === 'playbookBullet') {
    const id = (entry.config as { id?: unknown }).id;
    return typeof id === 'string' ? `playbookBullet:${id}` : undefined;
  }
  return undefined;
}

/**
 * Inspect every entry of a tree and return a per-entry verdict.
 *
 * Pure. Never throws for a bad tree — a denial is data. The only thing it
 * refuses outright is a non-array argument, which is a programming error.
 */
export const axInspectHarnessTree = (
  tree: AxHarnessTree
): Readonly<AxHarnessAdmissionReport> => {
  if (!Array.isArray(tree)) {
    throw new TypeError('axInspectHarnessTree: tree must be an array');
  }

  const seenIds = new Set<string>();
  const seenTargets = new Set<string>();
  const inspections: AxHarnessEntryInspection[] = [];
  const admitted: AxHarnessEntry[] = [];

  // The tree-level size cap is charged to every entry: an oversized tree is
  // not one entry's fault, and refusing it wholesale is what fails closed.
  // An unsizeable tree is not "not oversized": the entry that made it
  // unsizeable is denied `non-json-config` in the loop below.
  const treeBytes = canonicalByteLength(tree);
  const treeOversized = treeBytes !== undefined && treeBytes > MAX_TREE_BYTES;

  tree.forEach((raw, index) => {
    const findings: Finding[] = [];
    const entry = raw as AxHarnessEntry;
    const rawId = (entry as { id?: unknown })?.id;
    const entryId =
      typeof rawId === 'string' && rawId.length > 0
        ? rawId
        : `<index ${index}>`;

    if (!isPlainObject(entry)) {
      findings.push({ reason: 'non-json-config', path: '' });
      inspections.push(
        Object.freeze({ entryId, admitted: false, reasons: findings })
      );
      return;
    }

    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      findings.push({ reason: 'invalid-entry-id', path: 'id' });
    } else if (rawId.includes(':')) {
      // `:` is reserved: the installer builds slot names as `<prefix>:<id>`.
      findings.push({ reason: 'invalid-entry-id', path: 'id' });
    } else if (seenIds.has(rawId)) {
      findings.push({ reason: 'duplicate-entry-id', path: 'id' });
    } else {
      seenIds.add(rawId);
    }

    if (!KINDS.includes(entry.kind)) {
      findings.push({ reason: 'unknown-kind', path: 'kind' });
    }

    if (
      (entry as { disabled?: unknown }).disabled !== undefined &&
      typeof entry.disabled !== 'boolean'
    ) {
      findings.push({ reason: 'unknown-config-key', path: 'disabled' });
    }

    for (const key of Object.keys(entry)) {
      if (
        key !== 'id' &&
        key !== 'kind' &&
        key !== 'disabled' &&
        key !== 'config'
      ) {
        findings.push({ reason: 'unknown-config-key', path: key });
      }
    }

    const config = (entry as { config?: unknown }).config;
    if (!isPlainObject(config)) {
      findings.push({ reason: 'non-json-config', path: 'config' });
    } else {
      try {
        axAssertPersistableValue(config, 'config', {
          label: 'AxHarnessEntry config',
        });
      } catch {
        findings.push({ reason: 'non-json-config', path: 'config' });
      }

      if (KINDS.includes(entry.kind)) {
        const allowed = CONFIG_KEYS[entry.kind];
        for (const key of Object.keys(config)) {
          if (
            entry.kind === 'playbookBullet' &&
            (FORBIDDEN_BULLET_FIELDS as readonly string[]).includes(key)
          ) {
            findings.push({
              reason: 'forbidden-bullet-field',
              path: `config.${key}`,
            });
            continue;
          }
          if (!allowed.includes(key)) {
            findings.push({
              reason: 'unknown-config-key',
              path: `config.${key}`,
            });
          }
        }

        if (entry.kind === 'instruction') {
          requireText(config, 'text', findings);
        } else if (entry.kind === 'playbookBullet') {
          requireSegment(config, 'id', findings);
          requireText(config, 'section', findings);
          requireText(config, 'content', findings);
          const tags = config.tags;
          if (
            tags !== undefined &&
            (!Array.isArray(tags) ||
              tags.some((tag) => typeof tag !== 'string'))
          ) {
            findings.push({ reason: 'non-json-config', path: 'config.tags' });
          }
        } else {
          requireSegment(config, 'skillId', findings);
          requireText(config, 'name', findings);
          requireText(config, 'content', findings);
          if (
            config.description !== undefined &&
            typeof config.description !== 'string'
          ) {
            findings.push({
              reason: 'non-json-config',
              path: 'config.description',
            });
          }
        }
      }
    }

    // Both tripwire rules run over the WHOLE entry, not just `config`: free
    // text is a config value, and a credential can arrive in any of them.
    scanForCredentials(entry, '', findings);

    const target = renderTarget(entry);
    if (target !== undefined) {
      if (seenTargets.has(target)) {
        findings.push({
          reason: 'duplicate-render-target',
          path: entry.kind === 'skill' ? 'config.skillId' : 'config.id',
        });
      } else {
        seenTargets.add(target);
      }
    }

    const entryBytes = canonicalByteLength(entry);
    if (entryBytes === undefined) {
      // A cycle, or anything else `axEventCanonicalJson` cannot encode. The
      // entry cannot be persisted, digested or rendered, so it is denied with
      // the reason that says exactly that.
      findings.push({ reason: 'non-json-config', path: '' });
    } else if (entryBytes > MAX_ENTRY_BYTES) {
      findings.push({ reason: 'oversized-entry', path: '' });
    }
    if (treeOversized) {
      findings.push({ reason: 'oversized-tree', path: '' });
    }

    // Paths are normalized once, here, so a leading `.` from the whole-entry
    // walk never leaks into an error message or an inspection row.
    const reasons = findings.map((finding) =>
      Object.freeze({
        reason: finding.reason,
        path: finding.path.startsWith('.')
          ? finding.path.slice(1)
          : finding.path,
      })
    );
    const ok = reasons.length === 0;
    if (ok) admitted.push(entry);
    inspections.push(
      Object.freeze({ entryId, admitted: ok, reasons: Object.freeze(reasons) })
    );
  });

  return Object.freeze({
    admitted: Object.freeze(admitted),
    entries: Object.freeze(inspections),
    ok: inspections.every((inspection) => inspection.admitted),
  });
};

/**
 * Throwing wrapper over `axInspectHarnessTree`.
 *
 * Runs at seed, on every proposal, and when persisted state loads. Throws on
 * the FIRST denial while attaching the full report, so a caller that wants the
 * rest of the verdicts still has them.
 */
export const axAdmitHarnessTree = (tree: AxHarnessTree): AxHarnessTree => {
  const report = axInspectHarnessTree(tree);
  if (report.ok) return report.admitted;
  const denied = report.entries.find((entry) => !entry.admitted);
  const first = denied?.reasons[0];
  throw new AxHarnessAdmissionError(
    first?.reason ?? 'non-json-config',
    denied?.entryId ?? '<unknown>',
    first?.path ?? '',
    report
  );
};

// ---------------------------------------------------------------------------
// Content identity
// ---------------------------------------------------------------------------

/**
 * `sha256:<64 hex>` over the canonical admitted entry list, in tree order.
 *
 * Full sha256, never truncated and never `fnv1a64`: a consumer uses this to
 * answer "is my copy current", which a checksum cannot do. Order is part of
 * the identity because render order is.
 */
export const axHarnessContentId = async (
  tree: AxHarnessTree
): Promise<string> => {
  const admitted = axAdmitHarnessTree(tree);
  return `sha256:${await sha256(axEventCanonicalJson(admitted))}`;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const enabled = (tree: AxHarnessTree): AxHarnessTree =>
  tree.filter((entry) => entry.disabled !== true);

/**
 * Render a tree into the comparable composition.
 *
 * PURE — a function of its arguments only. `AxACEPlaybook` requires `version`,
 * `stats` and `updatedAt` and `AxACEBullet` requires `createdAt`/`updatedAt`,
 * so render cannot be both timestamp-producing and clock-free; the caller
 * supplies `now` from its injected clock. `now` is deliberately NOT part of
 * `contentId`, so two renders of one tree at different times keep one identity.
 */
export const axRenderHarnessTree = (
  tree: AxHarnessTree,
  options: Readonly<{ now: string }>
): Readonly<AxHarnessRendering> => {
  const { now } = options;
  if (typeof now !== 'string' || now.trim().length === 0) {
    throw new AxHarnessRenderError(
      'now',
      'axRenderHarnessTree: `now` must be a non-empty ISO timestamp string'
    );
  }

  const active = enabled(tree);

  const instructionText = active
    .filter((entry) => entry.kind === 'instruction')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => (entry.config as { text: string }).text.trim())
    .join('\n\n');

  const sections: Record<string, AxACEBullet[]> = {};
  const seenBulletIds = new Set<string>();
  let bulletCount = 0;
  let tokenEstimate = 0;
  for (const entry of active) {
    if (entry.kind !== 'playbookBullet') continue;
    const config = entry.config;
    if (seenBulletIds.has(config.id)) {
      throw new AxHarnessRenderError(
        `playbookBullet:${config.id}`,
        `axRenderHarnessTree: two bullets render onto id ${config.id}`
      );
    }
    seenBulletIds.add(config.id);
    // Counters, timestamps, revision, lineage and evidence are synthesized
    // HERE, by the installer's side of the boundary. Admission rejects an
    // entry that tried to carry them.
    const bullet: AxACEBullet = {
      id: config.id,
      section: config.section,
      content: config.content,
      helpfulCount: 0,
      harmfulCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(config.tags === undefined ? {} : { tags: [...config.tags] }),
    };
    const bucket = sections[config.section] ?? [];
    bucket.push(bullet);
    sections[config.section] = bucket;
    bulletCount += 1;
    tokenEstimate += estimateTokenCount(config.content);
  }

  const skills: AxAgentCatalogSkill[] = [];
  const seenSkillIds = new Set<string>();
  for (const entry of active) {
    if (entry.kind !== 'skill') continue;
    const config = entry.config;
    if (seenSkillIds.has(config.skillId)) {
      throw new AxHarnessRenderError(
        `skill:${config.skillId}`,
        `axRenderHarnessTree: two skills render onto id ${config.skillId}`
      );
    }
    seenSkillIds.add(config.skillId);
    skills.push({
      id: config.skillId,
      name: config.name,
      ...(config.description === undefined
        ? {}
        : { description: config.description }),
      content: config.content,
    });
  }

  const playbook: AxACEPlaybook = {
    version: 1,
    sections,
    stats: { bulletCount, helpfulCount: 0, harmfulCount: 0, tokenEstimate },
    updatedAt: now,
  };

  return Object.freeze({
    instructions: Object.freeze(
      instructionText.length > 0 ? { actor: instructionText } : {}
    ),
    playbook,
    skills: Object.freeze(skills),
  });
};

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function mergeConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Apply a composite proposal atomically: all mutations apply, or none do.
 *
 * Pure — the input tree is never touched, and a failure part-way leaves the
 * caller holding exactly what it passed in. The result is re-admitted, so a
 * proposal cannot smuggle past the gate by arriving as a mutation instead of
 * a whole tree.
 */
export const axApplyHarnessMutations = (
  tree: AxHarnessTree,
  mutations: readonly AxHarnessMutation[]
): AxHarnessTree => {
  let next: AxHarnessEntry[] = tree.map((entry) => ({ ...entry }));

  for (const mutation of mutations) {
    const { op, id } = mutation;
    if (typeof id !== 'string' || id.trim().length === 0 || id.includes(':')) {
      throw new AxHarnessMutationError(
        op,
        String(id),
        `axApplyHarnessMutations: ${op} requires a non-empty root-level entry id without ':'`
      );
    }
    const index = next.findIndex((entry) => entry.id === id);

    if (op === 'create') {
      if (index >= 0) {
        throw new AxHarnessMutationError(
          op,
          id,
          `axApplyHarnessMutations: entry ${id} already exists`
        );
      }
      if (!isPlainObject(mutation.options)) {
        throw new AxHarnessMutationError(
          op,
          id,
          `axApplyHarnessMutations: create ${id} requires an options object`
        );
      }
      // The mutation's `id` wins over anything in `options`: the type forbids
      // an `id` there, but a JS caller can still pass one, and an entry whose
      // id disagreed with the mutation that created it would be unaddressable
      // by every later mutation.
      next = [...next, { ...mutation.options, id } as AxHarnessEntry];
      continue;
    }

    if (index < 0) {
      throw new AxHarnessMutationError(
        op,
        id,
        `axApplyHarnessMutations: entry ${id} does not exist`
      );
    }

    if (op === 'remove') {
      next = next.filter((_, position) => position !== index);
      continue;
    }

    if (!isPlainObject(mutation.options)) {
      throw new AxHarnessMutationError(
        op,
        id,
        `axApplyHarnessMutations: update ${id} requires an options object`
      );
    }
    const current = next[index] as unknown as Record<string, unknown>;
    const { config: configPatch, ...rootPatch } = mutation.options;
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(rootPatch)) {
      if (key === 'id') {
        throw new AxHarnessMutationError(
          op,
          id,
          'axApplyHarnessMutations: an update may not rename an entry'
        );
      }
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    if (configPatch !== undefined) {
      if (configPatch === null) {
        throw new AxHarnessMutationError(
          op,
          id,
          'axApplyHarnessMutations: an update may not delete config'
        );
      }
      if (!isPlainObject(configPatch)) {
        throw new AxHarnessMutationError(
          op,
          id,
          'axApplyHarnessMutations: config must be an object'
        );
      }
      merged.config = mergeConfig(
        isPlainObject(current.config) ? current.config : {},
        configPatch
      );
    }
    const updated = [...next];
    updated[index] = merged as unknown as AxHarnessEntry;
    next = updated;
  }

  return axAdmitHarnessTree(next);
};
