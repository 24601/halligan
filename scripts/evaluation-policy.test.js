import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const POLICY_FILES = Object.freeze({
  contributing: '.github/CONTRIBUTING.md',
  agents: 'AGENTS.md',
  template: '.github/PULL_REQUEST_TEMPLATE.md',
});

const REQUIRED_METHOD_SENTENCES = Object.freeze([
  'Claimed outcome improvement: a held-out hill-climbing comparison against a declared baseline.',
  'Latency or cost: a reproducible benchmark against a declared baseline.',
  'Recovery or durability: fault injection covering the claimed failure mode.',
  'Infrastructure: audit-fidelity and overhead checks.',
]);

const NEGATION_PREFIXES = Object.freeze([
  'do not ',
  'do not use ',
  'skip ',
  'omit ',
  'never ',
]);

function readRepoFile(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function unwrapMarkdownLines(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    const continuesWrappedParagraph =
      lines.length > 0 &&
      lines.at(-1) !== '' &&
      !/^\s*(?:[-*]|\d+\.|#{1,6}\s|```)/.test(line) &&
      !/^\s*- \*\*/.test(line);
    if (continuesWrappedParagraph) {
      lines[lines.length - 1] = `${lines.at(-1)} ${trimmed}`;
      continue;
    }
    lines.push(trimmed);
  }
  return lines.map((line) => line.replace(/\s+/g, ' ').trim());
}

function policyText(relativePath) {
  return unwrapMarkdownLines(readRepoFile(relativePath));
}

describe('evaluation policy lock', () => {
  const contributing = policyText(POLICY_FILES.contributing);
  const agents = policyText(POLICY_FILES.agents);
  const template = policyText(POLICY_FILES.template);

  it('keeps the required tests and evaluation sections in all three policy documents', () => {
    expect(contributing).toContain('## Tests and evaluation');
    expect(agents).toContain('## Tests And Evaluation');
    expect(template.some((line) => /^- \*\*Tests\*\*:/.test(line))).toBe(true);
    expect(template.some((line) => /^- \*\*Evaluation\*\*:/.test(line))).toBe(
      true
    );
  });

  it('requires the exact affirmative evaluation methods in all three documents', () => {
    for (const document of [contributing, agents, template]) {
      const joined = document.join('\n');
      for (const sentence of REQUIRED_METHOD_SENTENCES) {
        expect(joined).toContain(sentence);
        for (const prefix of NEGATION_PREFIXES) {
          expect(joined).not.toContain(`${prefix}${sentence}`);
          expect(joined).not.toContain(
            `${prefix}${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
          );
        }
      }
    }
  });

  it('keeps the required evidence, budget, exemption, and honesty language', () => {
    const contributingText = contributing.join(' ');
    const agentsText = agents.join(' ');
    const templateText = template.join(' ');

    for (const text of [contributingText, agentsText, templateText]) {
      expect(text).toMatch(/declared baseline/i);
      expect(text).toMatch(/calls, tokens, wall-clock time, and cost/i);
      expect(text).toMatch(/negative or regression results/i);
      expect(text).toMatch(/exact commands and artifacts/i);
      expect(text).toMatch(/hard-code outcomes/i);
      expect(text).toMatch(/not applicable/i);
    }

    expect(contributingText).toMatch(
      /Paid provider calls are not required in CI/
    );
    expect(templateText).toMatch(/Paid provider calls are not required in CI/);
    expect(agentsText).toMatch(/zero-cost\/live-evaluation rules/);
  });
});
