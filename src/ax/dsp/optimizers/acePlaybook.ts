import { getCrypto } from '../../util/crypto.js';
import type {
  AxACEApplicability,
  AxACEBullet,
  AxACEBulletEvidence,
  AxACECuratorOperation,
  AxACEHostEvidence,
  AxACEPlaybook,
  AxACEProvenance,
  AxACEVerificationResult,
} from './aceTypes.js';

const MAX_VERIFICATION_SUMMARY_CHARS = 500;

interface ApplyOperationsOptions {
  maxSectionSize?: number;
  allowDynamicSections?: boolean;
  enableAutoPrune?: boolean;
  protectedBulletIds?: ReadonlySet<string>;
  /** Trusted caller evidence; never accepted from curator JSON. */
  hostEvidence?: Readonly<AxACEHostEvidence>;
}

export type AxACEPlaybookRenderOptions = {
  /** Runtime condition tokens used to satisfy applicability constraints. */
  conditions?: readonly string[];
  /**
   * Inspection only: include structurally valid expired, deprecated,
   * superseded, and inapplicable bullets.
   */
  includeInactive?: boolean;
  /** @internal Ignore applicability while retaining lifecycle and expiry gates. */
  includeInapplicable?: boolean;
  /** ISO timestamp used for deterministic expiry evaluation. Defaults to now. */
  now?: string;
};

export type AxACEBulletChange = {
  bulletId: string;
  before?: AxACEBullet;
  after?: AxACEBullet;
};

/**
 * Create a fresh, empty playbook structure.
 */
export function createEmptyPlaybook(description?: string): AxACEPlaybook {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    sections: {},
    stats: {
      bulletCount: 0,
      helpfulCount: 0,
      harmfulCount: 0,
      tokenEstimate: 0,
    },
    updatedAt: timestamp,
    description,
  };
}

/**
 * Produce a deep clone to prevent accidental mutation of stored artifacts.
 */
export function clonePlaybook(
  playbook: Readonly<AxACEPlaybook>
): AxACEPlaybook {
  return JSON.parse(JSON.stringify(playbook)) as AxACEPlaybook;
}

/**
 * Lightweight token estimation based on character count (fallback when tiktoken
 * is unavailable). The constant (4 chars/token) approximates GPT-style tokenizers.
 */
export function estimateTokenCount(text: string): number {
  const avgCharsPerToken = 4;
  return Math.ceil(text.length / avgCharsPerToken);
}

/**
 * Apply curator operations (delta updates) to the playbook in-place.
 * Returns the list of bullet ids that were added or updated for auditing.
 */
export function applyCuratorOperations(
  playbook: AxACEPlaybook,
  operations: readonly AxACECuratorOperation[],
  options?: Readonly<ApplyOperationsOptions>
): {
  updatedBulletIds: string[];
  autoRemoved: AxACECuratorOperation[];
  changes: AxACEBulletChange[];
} {
  assertPlaybookMutable(playbook);
  for (const operation of operations) {
    assertCuratorOperation(operation);
  }
  assertHostEvidence(options?.hostEvidence);

  // Curator application is transactional. Persisted snapshots are caller-owned
  // and may be malformed at runtime despite their TypeScript type; never expose
  // a partially revised live playbook if validation or normalization fails.
  const staged = clonePlaybook(playbook);
  const result = applyCuratorOperationsInPlace(staged, operations, options);
  replacePlaybook(playbook, staged);
  return result;
}

function applyCuratorOperationsInPlace(
  playbook: AxACEPlaybook,
  operations: readonly AxACECuratorOperation[],
  options?: Readonly<ApplyOperationsOptions>
): {
  updatedBulletIds: string[];
  autoRemoved: AxACECuratorOperation[];
  changes: AxACEBulletChange[];
} {
  const updatedBullets: string[] = [];
  const autoRemoved: AxACECuratorOperation[] = [];
  const changes: AxACEBulletChange[] = [];
  const {
    maxSectionSize = Number.POSITIVE_INFINITY,
    allowDynamicSections = true,
    enableAutoPrune = false,
    protectedBulletIds,
    hostEvidence,
  } = options ?? {};

  const now = new Date().toISOString();

  const protectedIds = protectedBulletIds ?? new Set<string>();

  for (const op of operations) {
    if (!op.section) {
      continue;
    }

    if (!playbook.sections[op.section]) {
      if (!allowDynamicSections) {
        continue;
      }
      playbook.sections[op.section] = [];
    }

    const section = playbook.sections[op.section]!;

    switch (op.type) {
      case 'ADD': {
        const content = op.content?.trim() ?? '';
        if (!content) {
          continue;
        }

        if (section.length >= maxSectionSize) {
          if (!enableAutoPrune) {
            continue;
          }
          const pruned = pruneSectionForAddition(section, protectedIds);
          if (!pruned) {
            continue;
          }
          updatedBullets.push(pruned.id);
          changes.push({ bulletId: pruned.id, before: cloneBullet(pruned) });
          autoRemoved.push({
            type: 'REMOVE',
            section: op.section,
            bulletId: pruned.id,
            metadata: {
              ...(pruned.metadata ?? {}),
              autoPruned: true,
              removedAt: now,
            },
          });
        }

        const id = op.bulletId ?? generateBulletId(op.section);
        const bullet: AxACEBullet = {
          id,
          section: op.section,
          content,
          helpfulCount: 0,
          harmfulCount: 0,
          createdAt: now,
          updatedAt: now,
          metadata: op.metadata ? { ...op.metadata } : undefined,
          revision: 1,
          lineage: normalizeSupersedes(op.supersedes).length
            ? { supersedes: normalizeSupersedes(op.supersedes) }
            : undefined,
          evidence: mergeBulletEvidence(undefined, op.evidence, hostEvidence),
        };
        section.push(bullet);
        updatedBullets.push(id);
        applySupersession(playbook, op.supersedes, id, now, changes);
        changes.push({ bulletId: id, after: cloneBullet(bullet) });
        break;
      }
      case 'UPDATE': {
        const bullet = section.find((b) => b.id === op.bulletId);
        if (!bullet) {
          continue;
        }
        const before = cloneBullet(bullet);
        if (typeof op.content === 'string') {
          bullet.content = op.content;
        }
        bullet.updatedAt = now;
        if (op.metadata) {
          bullet.metadata = {
            ...(bullet.metadata ?? {}),
            ...op.metadata,
          };
        }
        const previousRevision = bullet.revision ?? 1;
        bullet.revision = previousRevision + 1;
        const supersedes = normalizeSupersedes(op.supersedes).filter(
          (id) => id !== bullet.id
        );
        bullet.lineage = {
          ...(bullet.lineage ?? {}),
          previousRevision,
          ...(supersedes.length > 0 ? { supersedes } : {}),
        };
        bullet.evidence = mergeBulletEvidence(
          bullet.evidence,
          op.evidence,
          hostEvidence
        );
        updatedBullets.push(bullet.id);
        applySupersession(playbook, supersedes, bullet.id, now, changes);
        changes.push({
          bulletId: bullet.id,
          before,
          after: cloneBullet(bullet),
        });
        break;
      }
      case 'REMOVE': {
        const idx = section.findIndex((b) => b.id === op.bulletId);
        if (idx >= 0) {
          const [removed] = section.splice(idx, 1);
          if (removed) {
            updatedBullets.push(removed.id);
            changes.push({
              bulletId: removed.id,
              before: cloneBullet(removed),
            });
          }
        }
        break;
      }
    }
  }

  recomputePlaybookStats(playbook);
  playbook.updatedAt = now;

  return { updatedBulletIds: updatedBullets, autoRemoved, changes };
}

/**
 * Increase the helpful/harmful counters reported by the Reflector stage.
 */
export function updateBulletFeedback(
  playbook: AxACEPlaybook,
  bulletId: string,
  tag: 'helpful' | 'harmful' | 'neutral'
): void {
  for (const section of Object.values(playbook.sections)) {
    const bullet = section.find((b) => b.id === bulletId);
    if (bullet) {
      if (tag === 'helpful') {
        bullet.helpfulCount += 1;
      } else if (tag === 'harmful') {
        bullet.harmfulCount += 1;
      }
      bullet.updatedAt = new Date().toISOString();
      recomputePlaybookStats(playbook);
      return;
    }
  }
}

/**
 * Render the playbook into a markdown-like instruction block that can be
 * appended to a system prompt.
 */
export function renderPlaybook(
  playbook: Readonly<AxACEPlaybook>,
  options?: Readonly<AxACEPlaybookRenderOptions>
): string {
  const visibleSections = Object.fromEntries(
    Object.entries(playbook.sections).map(([section, bullets]) => [
      section,
      bullets.filter((bullet) => isBulletApplicable(bullet, options)),
    ])
  );
  // An empty playbook (no bullets, no description) renders to nothing, so it
  // injects nothing into a program's context — a bare "## Context Playbook"
  // header would otherwise pollute the prompt (and perturb the prompt cache)
  // after e.g. a rolled-back improve() proposal loads an empty snapshot.
  const totalBullets = Object.values(visibleSections).reduce(
    (n, bullets) => n + bullets.length,
    0
  );
  if (totalBullets === 0 && !playbook.description) {
    return '';
  }

  const header = playbook.description
    ? `## Context Playbook\n${playbook.description.trim()}\n`
    : '## Context Playbook\n';

  const sections = Object.entries(visibleSections)
    .filter(([, bullets]) => bullets.length > 0)
    .map(([sectionName, bullets]) => {
      const body = bullets
        .map((bullet) => `- [${bullet.id}] ${bullet.content}`)
        .join('\n');
      return body
        ? `### ${sectionName}\n${body}`
        : `### ${sectionName}\n_(empty)_`;
    })
    .join('\n\n');

  return `${header}\n${sections}`.trim();
}

/** @internal Build the safe playbook view supplied to executable ACE stages. */
export function createExecutablePlaybookView(
  playbook: Readonly<AxACEPlaybook>,
  now?: string
): AxACEPlaybook {
  const view = clonePlaybook(playbook);
  for (const [section, bullets] of Object.entries(view.sections)) {
    view.sections[section] = bullets.filter((bullet) =>
      isBulletApplicable(bullet, { includeInapplicable: true, now })
    );
  }
  recomputePlaybookStats(view);
  return view;
}

/** Determine whether a bullet is active and applicable for retrieval/rendering. */
export function isBulletApplicable(
  bullet: Readonly<AxACEBullet>,
  options?: Readonly<AxACEPlaybookRenderOptions>
): boolean {
  if (
    !isRecord(bullet) ||
    typeof bullet.id !== 'string' ||
    typeof bullet.section !== 'string' ||
    typeof bullet.content !== 'string'
  ) {
    return false;
  }

  const evidence = bullet.evidence as unknown;
  if (!isEvidenceStructurallyValid(evidence)) {
    return false;
  }

  const typedEvidence = evidence as AxACEBulletEvidence | undefined;
  const lifecycle = typedEvidence?.lifecycle;
  const applicability = typedEvidence?.applicability;
  const runtimeConditions = options?.conditions;
  if (
    runtimeConditions !== undefined &&
    (!Array.isArray(runtimeConditions) ||
      runtimeConditions.some((condition) => typeof condition !== 'string'))
  ) {
    return false;
  }

  // Inspection can expose lifecycle-inactive records, but only after all
  // retrieval-affecting and audit metadata has passed structural validation.
  if (options?.includeInactive) {
    return true;
  }

  if (
    lifecycle?.status === 'deprecated' ||
    lifecycle?.status === 'superseded'
  ) {
    return false;
  }
  if (lifecycle?.expiresAt !== undefined) {
    const expiry = Date.parse(lifecycle.expiresAt);
    const now = Date.parse(options?.now ?? new Date().toISOString());
    if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) {
      return false;
    }
  }

  if (options?.includeInapplicable || applicability === undefined) {
    return true;
  }
  const allOf = conditionList(applicability.allOf);
  const anyOf = conditionList(applicability.anyOf);
  const noneOf = conditionList(applicability.noneOf);
  const conditions = new Set(runtimeConditions ?? []);
  if (allOf?.some((condition) => !conditions.has(condition))) {
    return false;
  }
  if (anyOf?.length && !anyOf.some((condition) => conditions.has(condition))) {
    return false;
  }
  if (noneOf?.some((condition) => conditions.has(condition))) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function conditionList(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) &&
    value.every((condition) => typeof condition === 'string')
    ? value
    : null;
}

function isEvidenceStructurallyValid(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.confidence !== undefined &&
    (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))
  ) {
    return false;
  }
  if (
    value.evidenceCount !== undefined &&
    (typeof value.evidenceCount !== 'number' ||
      !Number.isFinite(value.evidenceCount) ||
      value.evidenceCount < 0)
  ) {
    return false;
  }
  if (!isApplicabilityStructurallyValid(value.applicability)) {
    return false;
  }
  if (!isLifecycleStructurallyValid(value.lifecycle)) {
    return false;
  }
  if (
    value.provenance !== undefined &&
    (!Array.isArray(value.provenance) ||
      value.provenance.some(
        (entry) =>
          !isRecord(entry) ||
          !['compile', 'online', 'agent-evolve', 'manual'].includes(
            String(entry.source)
          ) ||
          (entry.sourceRunId !== undefined &&
            typeof entry.sourceRunId !== 'string') ||
          conditionList(entry.feedbackIds) === null
      ))
  ) {
    return false;
  }
  if (
    value.verification !== undefined &&
    (!Array.isArray(value.verification) ||
      value.verification.some(
        (entry) =>
          !isRecord(entry) ||
          typeof entry.verifierId !== 'string' ||
          !['passed', 'failed', 'unknown'].includes(String(entry.result)) ||
          (entry.testId !== undefined && typeof entry.testId !== 'string') ||
          (entry.timestamp !== undefined &&
            typeof entry.timestamp !== 'string') ||
          (entry.summary !== undefined && typeof entry.summary !== 'string')
      ))
  ) {
    return false;
  }
  return true;
}

function isApplicabilityStructurallyValid(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      conditionList(value.allOf) !== null &&
      conditionList(value.anyOf) !== null &&
      conditionList(value.noneOf) !== null)
  );
}

function isLifecycleStructurallyValid(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.status !== undefined &&
    !['active', 'deprecated', 'superseded'].includes(String(value.status))
  ) {
    return false;
  }
  for (const field of ['expiresAt', 'supersededBy', 'reason'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return false;
    }
  }
  return (
    value.expiresAt === undefined ||
    (typeof value.expiresAt === 'string' &&
      Number.isFinite(Date.parse(value.expiresAt)))
  );
}

function assertPlaybookMutable(
  playbook: unknown
): asserts playbook is AxACEPlaybook {
  if (!isRecord(playbook) || !isRecord(playbook.sections)) {
    throw new TypeError('AxACE: playbook sections must be an object');
  }
  for (const [section, bullets] of Object.entries(playbook.sections)) {
    if (!Array.isArray(bullets)) {
      throw new TypeError(
        `AxACE: playbook section ${section} must be an array`
      );
    }
    for (const bullet of bullets) {
      if (
        !isRecord(bullet) ||
        typeof bullet.id !== 'string' ||
        typeof bullet.section !== 'string' ||
        typeof bullet.content !== 'string' ||
        !isEvidenceStructurallyValid(bullet.evidence) ||
        (bullet.metadata !== undefined && !isRecord(bullet.metadata)) ||
        (bullet.tags !== undefined && conditionList(bullet.tags) === null) ||
        !isLineageStructurallyValid(bullet.lineage)
      ) {
        throw new TypeError(`AxACE: bullet in section ${section} is malformed`);
      }
    }
  }
}

function isLineageStructurallyValid(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    isRecord(value) &&
    (value.previousRevision === undefined ||
      (typeof value.previousRevision === 'number' &&
        Number.isFinite(value.previousRevision))) &&
    conditionList(value.supersedes) !== null
  );
}

function assertCuratorOperation(
  operation: unknown
): asserts operation is AxACECuratorOperation {
  if (
    !isRecord(operation) ||
    !['ADD', 'UPDATE', 'REMOVE'].includes(String(operation.type)) ||
    typeof operation.section !== 'string' ||
    (operation.content !== undefined &&
      typeof operation.content !== 'string') ||
    (operation.bulletId !== undefined &&
      typeof operation.bulletId !== 'string') ||
    (operation.metadata !== undefined && !isRecord(operation.metadata)) ||
    !isEvidenceStructurallyValid(operation.evidence) ||
    conditionList(operation.supersedes) === null
  ) {
    throw new TypeError('AxACE: curator operation is malformed');
  }
}

function assertHostEvidence(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (
    !isRecord(value) ||
    (value.source !== undefined &&
      !['compile', 'online', 'agent-evolve', 'manual'].includes(
        String(value.source)
      )) ||
    (value.sourceRunId !== undefined &&
      typeof value.sourceRunId !== 'string') ||
    conditionList(value.feedbackIds) === null ||
    (value.evidenceCount !== undefined &&
      (typeof value.evidenceCount !== 'number' ||
        !Number.isFinite(value.evidenceCount) ||
        value.evidenceCount < 0)) ||
    (value.confidence !== undefined &&
      (typeof value.confidence !== 'number' ||
        !Number.isFinite(value.confidence))) ||
    !isEvidenceStructurallyValid({ verification: value.verification })
  ) {
    throw new TypeError('AxACE: host evidence is malformed');
  }
}

function replacePlaybook(target: AxACEPlaybook, source: AxACEPlaybook): void {
  target.version = source.version;
  target.sections = source.sections;
  target.stats = source.stats;
  target.updatedAt = source.updatedAt;
  if (source.description === undefined) {
    delete target.description;
  } else {
    target.description = source.description;
  }
}

/**
 * Simple deterministic bullet id generator (section prefix + random suffix).
 * Aligns with paper examples like "calc-00001".
 */
export function generateBulletId(section: string): string {
  const normalized = section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 6);
  const bytes = new Uint8Array(4);
  getCrypto().getRandomValues(bytes);
  const randomHex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `${normalized || 'ctx'}-${randomHex}`;
}

function pruneSectionForAddition(
  section: AxACEBullet[],
  protectedIds: ReadonlySet<string>
): AxACEBullet | undefined {
  let candidateIndex = -1;
  let candidateScore: [number, number, number] | undefined;

  for (let index = 0; index < section.length; index += 1) {
    const bullet = section[index]!;
    if (protectedIds.has(bullet.id)) {
      continue;
    }

    const helpful = bullet.helpfulCount ?? 0;
    const harmful = bullet.harmfulCount ?? 0;
    const netScore = helpful - harmful * 2;
    const recency = Date.parse(bullet.updatedAt ?? bullet.createdAt);

    const score: [number, number, number] = [
      netScore,
      helpful,
      Number.isFinite(recency) ? recency : Number.POSITIVE_INFINITY,
    ];

    if (!candidateScore) {
      candidateIndex = index;
      candidateScore = score;
      continue;
    }

    const candidateBullet = section[candidateIndex]!;
    const candidateHelpful = candidateBullet.helpfulCount ?? 0;
    const candidateHarmful = candidateBullet.harmfulCount ?? 0;
    const candidateNet = candidateHelpful - candidateHarmful * 2;
    const candidateRecency = Date.parse(
      candidateBullet.updatedAt ?? candidateBullet.createdAt
    );
    const candidateVector: [number, number, number] = [
      candidateNet,
      candidateHelpful,
      Number.isFinite(candidateRecency)
        ? candidateRecency
        : Number.POSITIVE_INFINITY,
    ];

    if (
      score[0] < candidateVector[0] ||
      (score[0] === candidateVector[0] && score[1] < candidateVector[1]) ||
      (score[0] === candidateVector[0] &&
        score[1] === candidateVector[1] &&
        score[2] < candidateVector[2])
    ) {
      candidateIndex = index;
      candidateScore = score;
    }
  }

  if (candidateIndex === -1) {
    return undefined;
  }

  const [removed] = section.splice(candidateIndex, 1);
  return removed;
}

/**
 * Remove duplicate bullets by normalized exact-content match. This intentionally
 * avoids semantic or embedding-based dedupe so ACE works without extra services.
 */
export function dedupePlaybookByContent(
  playbook: AxACEPlaybook,
  _similarityThreshold = 0.95,
  updatedBulletIds?: string[]
): void {
  const survivingIds = new Map<string, string>();
  for (const [sectionName, bullets] of Object.entries(playbook.sections)) {
    const seen = new Map<string, AxACEBullet>();
    const unique: AxACEBullet[] = [];

    for (const bullet of bullets) {
      const key = bullet.content.trim().toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        const isExplicitReplacement =
          existing.evidence?.lifecycle?.status === 'superseded' &&
          existing.evidence.lifecycle.supersededBy === bullet.id &&
          bullet.lineage?.supersedes?.includes(existing.id);
        if (isExplicitReplacement) {
          // Exact-content replacement is still a lifecycle transition. Keep
          // both records so the new id remains executable and every lineage,
          // history, and receipt reference continues to resolve.
          unique.push(bullet);
          seen.set(key, bullet);
          continue;
        }
        survivingIds.set(bullet.id, existing.id);
        // Merge counters if they are near-identical
        existing.helpfulCount += bullet.helpfulCount;
        existing.harmfulCount += bullet.harmfulCount;
        existing.updatedAt = bullet.updatedAt;
        existing.evidence = mergeStoredEvidence(
          existing.evidence,
          bullet.evidence
        );
        const supersedes = normalizeSupersedes([
          ...(existing.lineage?.supersedes ?? []),
          ...(bullet.lineage?.supersedes ?? []),
        ]);
        if (supersedes.length) {
          existing.lineage = {
            ...(existing.lineage ?? {}),
            supersedes,
          };
        }
      } else {
        seen.set(key, bullet);
        unique.push(bullet);
      }
    }

    playbook.sections[sectionName] = unique;
  }

  if (updatedBulletIds) {
    for (let index = 0; index < updatedBulletIds.length; index++) {
      const current = updatedBulletIds[index]!;
      updatedBulletIds[index] = survivingIds.get(current) ?? current;
    }
  }

  recomputePlaybookStats(playbook);
}

function recomputePlaybookStats(playbook: AxACEPlaybook): void {
  let bulletCount = 0;
  let helpfulCount = 0;
  let harmfulCount = 0;
  let tokenEstimate = 0;

  for (const bullets of Object.values(playbook.sections)) {
    for (const bullet of bullets) {
      bulletCount += 1;
      helpfulCount += bullet.helpfulCount;
      harmfulCount += bullet.harmfulCount;
      tokenEstimate += estimateTokenCount(bullet.content);
    }
  }

  playbook.stats = {
    bulletCount,
    helpfulCount,
    harmfulCount,
    tokenEstimate,
  };
}

function cloneBullet(bullet: Readonly<AxACEBullet>): AxACEBullet {
  return JSON.parse(JSON.stringify(bullet)) as AxACEBullet;
}

function normalizeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value)
    ),
  ].sort();
}

function normalizeSupersedes(values: readonly string[] | undefined): string[] {
  return normalizeStrings(values);
}

function normalizeApplicability(
  applicability: Readonly<AxACEApplicability> | undefined
): AxACEApplicability | undefined {
  if (!applicability) {
    return undefined;
  }
  const allOf = normalizeStrings(applicability.allOf);
  const anyOf = normalizeStrings(applicability.anyOf);
  const noneOf = normalizeStrings(applicability.noneOf);
  if (!allOf.length && !anyOf.length && !noneOf.length) {
    return undefined;
  }
  return {
    ...(allOf.length ? { allOf } : {}),
    ...(anyOf.length ? { anyOf } : {}),
    ...(noneOf.length ? { noneOf } : {}),
  };
}

function normalizeConfidence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

function normalizeVerification(
  values: readonly AxACEVerificationResult[] | undefined
): AxACEVerificationResult[] {
  const normalized = (values ?? [])
    .filter(
      (value) =>
        value &&
        typeof value.verifierId === 'string' &&
        value.verifierId.trim().length > 0 &&
        ['passed', 'failed', 'unknown'].includes(value.result)
    )
    .map((value) => ({
      verifierId: value.verifierId.trim(),
      ...(value.testId?.trim() ? { testId: value.testId.trim() } : {}),
      result: value.result,
      ...(value.timestamp ? { timestamp: value.timestamp } : {}),
      ...(value.summary?.trim()
        ? {
            summary: value.summary
              .trim()
              .slice(0, MAX_VERIFICATION_SUMMARY_CHARS),
          }
        : {}),
    }));
  const unique = new Map(
    normalized.map((value) => [
      `${value.verifierId}\u0000${value.testId ?? ''}\u0000${value.timestamp ?? ''}`,
      value,
    ])
  );
  return [...unique.values()].sort((a, b) =>
    `${a.verifierId}\u0000${a.testId ?? ''}\u0000${a.timestamp ?? ''}`.localeCompare(
      `${b.verifierId}\u0000${b.testId ?? ''}\u0000${b.timestamp ?? ''}`
    )
  );
}

function mergeProvenance(
  existing: readonly AxACEProvenance[] | undefined,
  host: Readonly<AxACEHostEvidence> | undefined
): AxACEProvenance[] | undefined {
  const next = [...(existing ?? [])];
  if (host) {
    const feedbackIds = normalizeStrings(host.feedbackIds);
    next.push({
      source: host.source ?? 'manual',
      ...(host.sourceRunId ? { sourceRunId: host.sourceRunId } : {}),
      ...(feedbackIds.length ? { feedbackIds } : {}),
    });
  }
  const grouped = new Map<string, AxACEProvenance>();
  for (const value of next) {
    const key = `${value.source}\u0000${value.sourceRunId ?? ''}`;
    const current = grouped.get(key);
    const feedbackIds = normalizeStrings([
      ...(current?.feedbackIds ?? []),
      ...(value.feedbackIds ?? []),
    ]);
    grouped.set(key, {
      source: value.source,
      ...(value.sourceRunId ? { sourceRunId: value.sourceRunId } : {}),
      ...(feedbackIds.length ? { feedbackIds } : {}),
    });
  }
  return grouped.size
    ? [...grouped.values()].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      )
    : undefined;
}

function mergeBulletEvidence(
  existing: Readonly<AxACEBulletEvidence> | undefined,
  curator: AxACECuratorOperation['evidence'],
  host: Readonly<AxACEHostEvidence> | undefined
): AxACEBulletEvidence | undefined {
  const confidence = normalizeConfidence(
    host?.confidence ?? curator?.confidence
  );
  const nextApplicability = normalizeApplicability(curator?.applicability);
  const applicability =
    nextApplicability ?? normalizeApplicability(existing?.applicability);
  const lifecycle = curator?.lifecycle
    ? {
        ...(existing?.lifecycle ?? {}),
        ...curator.lifecycle,
      }
    : existing?.lifecycle;
  const provenance = mergeProvenance(existing?.provenance, host);
  const verification = normalizeVerification([
    ...(existing?.verification ?? []),
    ...(host?.verification ?? []),
  ]);
  const hostIncrement =
    host?.evidenceCount ??
    (host
      ? Math.max(
          normalizeStrings(host.feedbackIds).length,
          host.verification?.length ?? 0,
          1
        )
      : 0);
  const evidenceCount = (existing?.evidenceCount ?? 0) + hostIncrement;

  if (
    confidence === undefined &&
    !applicability &&
    !lifecycle &&
    !provenance &&
    verification.length === 0 &&
    evidenceCount === 0
  ) {
    return undefined;
  }
  return {
    ...(confidence !== undefined
      ? { confidence }
      : existing?.confidence !== undefined
        ? { confidence: existing.confidence }
        : {}),
    ...(evidenceCount > 0 ? { evidenceCount } : {}),
    ...(applicability ? { applicability } : {}),
    ...(provenance ? { provenance } : {}),
    ...(verification.length ? { verification } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function applySupersession(
  playbook: AxACEPlaybook,
  supersedes: readonly string[] | undefined,
  supersededBy: string,
  now: string,
  changes: AxACEBulletChange[]
): void {
  for (const id of normalizeSupersedes(supersedes)) {
    if (id === supersededBy) {
      continue;
    }
    for (const bullets of Object.values(playbook.sections)) {
      const bullet = bullets.find((candidate) => candidate.id === id);
      if (!bullet) {
        continue;
      }
      const before = cloneBullet(bullet);
      bullet.updatedAt = now;
      const previousRevision = bullet.revision ?? 1;
      bullet.revision = previousRevision + 1;
      bullet.lineage = {
        ...(bullet.lineage ?? {}),
        previousRevision,
      };
      bullet.evidence = {
        ...(bullet.evidence ?? {}),
        lifecycle: {
          ...(bullet.evidence?.lifecycle ?? {}),
          status: 'superseded',
          supersededBy,
        },
      };
      changes.push({
        bulletId: id,
        before,
        after: cloneBullet(bullet),
      });
      break;
    }
  }
}

function mergeStoredEvidence(
  existing: Readonly<AxACEBulletEvidence> | undefined,
  incoming: Readonly<AxACEBulletEvidence> | undefined
): AxACEBulletEvidence | undefined {
  if (!existing) {
    return incoming
      ? (JSON.parse(JSON.stringify(incoming)) as AxACEBulletEvidence)
      : undefined;
  }
  if (!incoming) {
    return existing as AxACEBulletEvidence;
  }
  const provenance = new Map(
    [...(existing.provenance ?? []), ...(incoming.provenance ?? [])].map(
      (value) => [JSON.stringify(value), value]
    )
  );
  const verification = normalizeVerification([
    ...(existing.verification ?? []),
    ...(incoming.verification ?? []),
  ]);
  return {
    ...(incoming.confidence !== undefined
      ? { confidence: incoming.confidence }
      : existing.confidence !== undefined
        ? { confidence: existing.confidence }
        : {}),
    evidenceCount:
      (existing.evidenceCount ?? 0) + (incoming.evidenceCount ?? 0),
    ...((incoming.applicability ?? existing.applicability)
      ? { applicability: incoming.applicability ?? existing.applicability }
      : {}),
    ...(provenance.size
      ? {
          provenance: [...provenance.values()].sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b))
          ),
        }
      : {}),
    ...(verification.length ? { verification } : {}),
    ...((incoming.lifecycle ?? existing.lifecycle)
      ? { lifecycle: incoming.lifecycle ?? existing.lifecycle }
      : {}),
  };
}
