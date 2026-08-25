import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, 'scripts/gepa-legacy-fixture.ts');
const base =
  process.env.GEPA_COMPAT_BASE ??
  execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
const worktree = mkdtempSync(resolve(tmpdir(), 'ax-gepa-upstream-'));

const runFixture = (checkout: string, mode: 'omitted' | 'false') =>
  JSON.parse(
    execFileSync(process.execPath, ['--import=tsx', fixture, checkout, mode], {
      cwd: root,
      encoding: 'utf8',
    })
  );

try {
  execFileSync('git', ['worktree', 'add', '--detach', worktree, base], {
    cwd: root,
    stdio: 'ignore',
  });
  symlinkSync(resolve(root, 'node_modules'), resolve(worktree, 'node_modules'));
  for (const mode of ['omitted', 'false'] as const) {
    const upstream = runFixture(worktree, mode);
    const current = runFixture(root, mode);
    if (JSON.stringify(current) !== JSON.stringify(upstream)) {
      throw new Error(
        `GEPA ${mode} compatibility differs from ${base}\nupstream=${JSON.stringify(upstream)}\ncurrent=${JSON.stringify(current)}`
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({ base, modes: ['omitted', 'false'], compatible: true })}\n`
  );
} finally {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: root,
      stdio: 'ignore',
    });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}
