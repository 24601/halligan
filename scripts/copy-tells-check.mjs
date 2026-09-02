#!/usr/bin/env node
/**
 * copy-tells-check: deterministic scan for LLM writing tells in repo copy.
 *
 * Scans an explicit root list with a bounded walk. Prose only: fenced code
 * blocks, inline code spans, and link targets are excluded so code and symbol
 * names are never rewritten by this gate.
 *
 * Usage:
 *   node scripts/copy-tells-check.mjs [--json] [--root <dir>] [--only <path>]...
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

export const FILE_COUNT_FLOOR = 10;
export const FILE_COUNT_CEILING_NOTICE = 2000;
const FILE_COUNT_HARD_STOP = 5000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.generated',
  'dist',
  'build',
  'public',
  'coverage',
  '.next',
  '.cache',
]);

export const ROOT_SPECS = [
  { kind: 'file', path: 'README.md' },
  { kind: 'dir', path: 'docs', exts: ['.md'], recursive: false },
  { kind: 'dir', path: 'src/ax/skills', exts: ['.md'], recursive: false },
  {
    kind: 'dir',
    path: 'playground/src',
    exts: ['.vue', '.ts', '.md'],
    recursive: true,
    optional: true,
  },
  {
    kind: 'dir',
    path: 'tools/copy',
    exts: ['.md'],
    recursive: true,
    optional: true,
  },
];

/** Words whose presence is a tell on its own. */
const VOCABULARY = [
  'delve',
  'delves',
  'delving',
  'tapestry',
  'testament',
  'crucial',
  'crucially',
  'pivotal',
  'robust',
  'robustly',
  'seamless',
  'seamlessly',
  'streamline',
  'streamlines',
  'streamlined',
  'streamlining',
  'empower',
  'empowers',
  'empowering',
  'elevate',
  'elevates',
  'elevating',
  'unlock',
  'unlocks',
  'unlocking',
  'foster',
  'fosters',
  'fostering',
  'effortless',
  'effortlessly',
  'meticulous',
  'meticulously',
  'showcase',
  'showcases',
  'showcasing',
  'moreover',
  'furthermore',
  'notably',
  'importantly',
];

const PHRASES = [
  {
    id: 'phrase-ever-evolving',
    re: /\bever[- ]evolving\b/i,
    label: 'ever-evolving',
  },
  {
    id: 'phrase-game-changer',
    re: /\bgame[- ]chang(er|ing)\b/i,
    label: 'game-changer',
  },
  {
    id: 'phrase-fast-paced',
    re: /\bin today'?s (fast[- ]paced|rapidly evolving)\b/i,
    label: "in today's fast-paced",
  },
  { id: 'phrase-at-its-core', re: /\bat its core\b/i, label: 'at its core' },
  {
    id: 'phrase-worth-noting',
    re: /\bit'?s worth noting\b/i,
    label: "it's worth noting",
  },
  {
    id: 'phrase-navigate-landscape',
    re: /\bnavigat(e|es|ing) the (ever[- ]changing )?landscape\b/i,
    label: 'navigate the landscape',
  },
  {
    id: 'phrase-not-only-but-also',
    re: /\bnot only\b[^.;!?]{0,80}?\bbut also\b/i,
    label: 'not only ... but also',
  },
  {
    id: 'phrase-heres-the-thing',
    re: /\bhere'?s the thing\b/i,
    label: "here's the thing",
  },
];

const EMOJI_RE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2190-\u21FF\u2600-\u27BF])/u;

/**
 * Rules that are not simple vocabulary lookups.
 * `scan` receives the prose line and returns matched labels.
 */
const STRUCTURAL_RULES = [
  {
    id: 'struct-not-x-its-y',
    severity: 'error',
    label: '"not X, it\'s Y" contrast',
    line: (text) =>
      /\bnot\s+(?:just\s+|merely\s+|only\s+|simply\s+)?[^,.;:!?]{2,60}[,]\s*(?:it'?s|it is|they'?re|but)\b/i.test(
        text
      ),
  },
  {
    id: 'struct-lets-dive',
    severity: 'error',
    label: '"let\'s dive"',
    line: (text) =>
      /\blet'?s\s+(dive|jump|get)\s+(in|into|started)\b/i.test(text),
  },
  {
    id: 'struct-in-conclusion',
    severity: 'error',
    label: '"in conclusion"',
    line: (text) => /\bin conclusion\b/i.test(text),
  },
  {
    id: 'struct-key-takeaways',
    severity: 'error',
    label: '"key takeaways"',
    line: (text) => /\bkey takeaways?\b/i.test(text),
  },
  {
    id: 'struct-rhetorical-question-opener',
    severity: 'warning',
    label: 'rhetorical-question opener',
    line: (text) =>
      /^\s*(?:So\s+)?(?:What|Why|How)\b[^?]{5,80}\?\s*$/.test(text),
  },
  {
    id: 'format-emoji-heading',
    severity: 'error',
    label: 'emoji at start of heading',
    line: (text) => {
      const m = /^#{1,6}\s+(.*)$/.exec(text);
      return m ? EMOJI_RE.test(m[1].trim()) : false;
    },
  },
];

/** Em dash and en dash: hard error, no allowlist, no inline escape. */
const DASH_RULE = {
  id: 'dash-em-en',
  severity: 'error',
  label: 'em dash / en dash',
};
const DASH_RE = /[—–]/g;

const TRIAD_RULE = {
  id: 'struct-bolded-lead-triad',
  severity: 'warning',
  label: 'three consecutive bolded-lead bullets',
};
const DENSITY_RULE = {
  id: 'format-dash-density',
  severity: 'warning',
  label: 'dash density above 1 per 120 words',
};

export const ALL_RULE_IDS = [
  'vocab',
  DASH_RULE.id,
  TRIAD_RULE.id,
  DENSITY_RULE.id,
  ...STRUCTURAL_RULES.map((r) => r.id),
  ...PHRASES.map((p) => p.id),
];

/** Words that are repo contract terms and never a tell. */
const ALWAYS_EXEMPT = new Set(['harness', 'harnesses', 'harnessed']);

function leverageExempt(text) {
  if (/wedge/i.test(text) || /\bhalligan\b/i.test(text)) return true;
  return /\b(mechanical|bar|fulcrum)\b/i.test(text);
}

function stripProse(rawLine) {
  return rawLine
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/https?:\/\/\S+/g, ' ');
}

function walkDir(dir, spec, out, budget) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= budget) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (spec.recursive) walkDir(full, spec, out, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!spec.exts.some((ext) => entry.name.endsWith(ext))) continue;
    out.push(full);
  }
}

export function collectFiles(root) {
  const files = [];
  for (const spec of ROOT_SPECS) {
    const abs = join(root, spec.path);
    if (!existsSync(abs)) {
      if (spec.optional) continue;
      throw new Error(`copy-tells: required root missing: ${spec.path}`);
    }
    if (spec.kind === 'file') {
      files.push(abs);
      continue;
    }
    if (!statSync(abs).isDirectory()) continue;
    walkDir(abs, spec, files, FILE_COUNT_HARD_STOP);
  }
  return files.sort();
}

export function loadAllowlist(root) {
  const path = join(root, 'scripts/copy-tells-allow.json');
  if (!existsSync(path)) return { files: {}, deferred: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { files: parsed.files ?? {}, deferred: parsed.deferred ?? {} };
}

function relPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

export function scanFile(file, relative_) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const findings = [];
  let inFence = false;
  let escapeForNextLine = null;
  let proseWords = 0;
  let dashCount = 0;
  let bulletRun = 0;

  const push = (rule, line, detail) => {
    findings.push({
      file: relative_,
      rule: rule.id,
      severity: rule.severity,
      line,
      label: rule.label,
      detail,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const escapeMatch = /<!--\s*tells:\s*allow\s+([^\s>]+)\s*-->/.exec(raw);
    const activeEscape = escapeForNextLine;
    escapeForNextLine = escapeMatch ? escapeMatch[1].toLowerCase() : null;

    const text = stripProse(raw);
    if (!text.trim()) {
      bulletRun = 0;
      continue;
    }
    proseWords += text.split(/\s+/).filter(Boolean).length;

    // Dash rule: no allowlist, no inline escape, no threshold.
    const dashes = text.match(DASH_RE);
    if (dashes) {
      dashCount += dashes.length;
      push(DASH_RULE, lineNo, `${dashes.length} dash character(s)`);
    }

    // Vocabulary.
    for (const word of VOCABULARY) {
      const re = new RegExp(`\\b${word}\\b`, 'i');
      if (!re.test(text)) continue;
      if (ALWAYS_EXEMPT.has(word)) continue;
      if (activeEscape === word) continue;
      push(
        { id: 'vocab', severity: 'error', label: `vocabulary tell "${word}"` },
        lineNo,
        word
      );
    }
    if (
      /\bleverag(e|es|ed|ing)\b/i.test(text) &&
      !leverageExempt(text) &&
      activeEscape !== 'leverage'
    ) {
      push(
        { id: 'vocab', severity: 'error', label: 'vocabulary tell "leverage"' },
        lineNo,
        'leverage'
      );
    }

    // Phrases.
    for (const phrase of PHRASES) {
      if (!phrase.re.test(text)) continue;
      if (activeEscape === phrase.label.toLowerCase()) continue;
      push(
        {
          id: phrase.id,
          severity: 'error',
          label: `phrase tell "${phrase.label}"`,
        },
        lineNo,
        phrase.label
      );
    }

    // Structural.
    for (const rule of STRUCTURAL_RULES) {
      if (rule.line(text)) push(rule, lineNo, rule.label);
    }

    // Bolded-lead bullet triads.
    if (/^\s*[-*]\s+\*\*[^*]+\*\*/.test(raw)) {
      bulletRun += 1;
      if (bulletRun === 3) push(TRIAD_RULE, lineNo, 'three in a row');
    } else {
      bulletRun = 0;
    }
  }

  if (proseWords >= 120 && dashCount / (proseWords / 120) > 1) {
    findings.push({
      file: relative_,
      rule: DENSITY_RULE.id,
      severity: DENSITY_RULE.severity,
      line: 0,
      label: DENSITY_RULE.label,
      detail: `${dashCount} dashes in ${proseWords} prose words`,
    });
  }

  return findings;
}

export function run(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const allow = options.allowlist ?? loadAllowlist(root);
  let files = collectFiles(root);
  if (options.only?.length) {
    const wanted = new Set(options.only);
    files = files.filter((f) => wanted.has(relPath(root, f)));
  }

  const notices = [];
  const configErrors = [];

  for (const [file, rules] of Object.entries(allow.files)) {
    for (const [rule, reason] of Object.entries(rules)) {
      if (typeof reason !== 'string' || reason.trim() === '') {
        configErrors.push(
          `allowlist entry ${file} -> ${rule} has an empty reason`
        );
      }
      if (rule === DASH_RULE.id) {
        configErrors.push(
          `allowlist entry ${file} -> ${rule} is not allowed: dashes have no allowlist`
        );
      }
    }
  }
  for (const [file, reason] of Object.entries(allow.deferred)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      configErrors.push(`deferred entry ${file} has an empty reason`);
    }
  }

  if (!options.only?.length) {
    if (files.length < FILE_COUNT_FLOOR) {
      configErrors.push(
        `inspected ${files.length} files, below the floor of ${FILE_COUNT_FLOOR}; the root list is probably wrong`
      );
    }
    if (files.length > FILE_COUNT_CEILING_NOTICE) {
      notices.push(
        `inspected ${files.length} files, above the notice ceiling of ${FILE_COUNT_CEILING_NOTICE}`
      );
    }
  }

  const findings = [];
  const perFile = {};
  for (const file of files) {
    const rel = relPath(root, file);
    const raw = scanFile(file, rel);
    const deferred = Object.hasOwn(allow.deferred, rel);
    const fileAllow = allow.files[rel] ?? {};
    const kept = [];
    for (const finding of raw) {
      if (deferred) {
        kept.push({ ...finding, severity: 'deferred' });
        continue;
      }
      if (
        Object.hasOwn(fileAllow, finding.rule) &&
        finding.rule !== DASH_RULE.id
      ) {
        kept.push({ ...finding, severity: 'allowed' });
        continue;
      }
      kept.push(finding);
    }
    perFile[rel] = {
      total: kept.length,
      error: kept.filter((f) => f.severity === 'error').length,
      warning: kept.filter((f) => f.severity === 'warning').length,
      allowed: kept.filter((f) => f.severity === 'allowed').length,
      deferred: kept.filter((f) => f.severity === 'deferred').length,
      dashes: kept.filter((f) => f.rule === DASH_RULE.id).length,
    };
    findings.push(...kept);
  }

  const errors = findings.filter((f) => f.severity === 'error');
  return {
    root,
    inspectedFiles: files.length,
    floor: FILE_COUNT_FLOOR,
    ceilingNotice: FILE_COUNT_CEILING_NOTICE,
    notices,
    configErrors,
    findings,
    perFile,
    errorCount: errors.length + configErrors.length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    ok: errors.length === 0 && configErrors.length === 0,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const only = [];
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') root = argv[i + 1];
    if (argv[i] === '--only') only.push(argv[i + 1]);
  }
  const result = run({ root, only });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `copy-tells: inspected ${result.inspectedFiles} files\n`
    );
    for (const notice of result.notices)
      process.stdout.write(`notice: ${notice}\n`);
    for (const problem of result.configErrors)
      process.stdout.write(`config error: ${problem}\n`);
    for (const finding of result.findings) {
      if (finding.severity === 'allowed' || finding.severity === 'deferred')
        continue;
      process.stdout.write(
        `${finding.severity}: ${finding.file}:${finding.line} ${finding.label} (${finding.rule})\n`
      );
    }
    const deferredFiles = Object.entries(result.perFile).filter(
      ([, v]) => v.deferred > 0
    );
    if (deferredFiles.length > 0) {
      process.stdout.write(
        `deferred (owned by a later rewrite pass): ${deferredFiles.length} files, ${deferredFiles.reduce((n, [, v]) => n + v.deferred, 0)} findings\n`
      );
    }
    process.stdout.write(
      `copy-tells: ${result.errorCount} errors, ${result.warningCount} warnings\n`
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).endsWith('copy-tells-check.mjs')
)
  main();
