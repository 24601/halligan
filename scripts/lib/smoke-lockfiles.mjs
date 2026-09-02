import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const smokeLockfileRepoRoot = path.resolve(scriptDir, '..', '..');

// The Rust smoke crates depend on packages/rust by path. A path dependency has
// no checksum, so its Cargo.lock entry records only the version read from the
// dependency manifest. Every AxIR package regeneration that bumps the axllm
// version therefore makes each committed smoke lock stale, and the next
// `cargo build` silently rewrites it -- which is how a clean checkout ends up
// dirty after `npm test`. Refreshing the locks is part of package generation so
// the version bump and the lock update land in the same commit.
const AXLLM_PACKAGE_HEADING = '[[package]]\nname = "axllm"\nversion = "';

export function rustPackageManifestPath(repoRoot = smokeLockfileRepoRoot) {
  return path.join(repoRoot, 'packages', 'rust', 'Cargo.toml');
}

export async function readRustPackageVersion(repoRoot = smokeLockfileRepoRoot) {
  const manifest = await readFile(rustPackageManifestPath(repoRoot), 'utf8');
  const version = /^version = "([^"]+)"$/m.exec(manifest)?.[1];
  if (!version) {
    throw new Error(
      `could not read a version from ${rustPackageManifestPath(repoRoot)}`
    );
  }
  return version;
}

export async function listSmokeLockfiles(repoRoot = smokeLockfileRepoRoot) {
  const smokeRoot = path.join(repoRoot, 'tools', 'axir', 'smoke');
  const entries = await readdir(smokeRoot, { withFileTypes: true });
  const locks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lock = path.join(smokeRoot, entry.name, 'Cargo.lock');
    try {
      await readFile(lock, 'utf8');
    } catch {
      continue;
    }
    locks.push(lock);
  }
  return locks.sort();
}

export function setLockedAxllmVersion(lock, version) {
  const start = lock.indexOf(AXLLM_PACKAGE_HEADING);
  if (start === -1) {
    throw new Error('lockfile has no axllm package entry');
  }
  const valueStart = start + AXLLM_PACKAGE_HEADING.length;
  const valueEnd = lock.indexOf('"', valueStart);
  if (valueEnd === -1)
    throw new Error('lockfile axllm version is unterminated');
  return lock.slice(0, valueStart) + version + lock.slice(valueEnd);
}

export function lockedAxllmVersion(lock) {
  const start = lock.indexOf(AXLLM_PACKAGE_HEADING);
  if (start === -1) {
    throw new Error('lockfile has no axllm package entry');
  }
  const valueStart = start + AXLLM_PACKAGE_HEADING.length;
  const valueEnd = lock.indexOf('"', valueStart);
  if (valueEnd === -1)
    throw new Error('lockfile axllm version is unterminated');
  return lock.slice(valueStart, valueEnd);
}

/**
 * Rewrites every smoke Cargo.lock so its axllm entry matches the version in
 * packages/rust/Cargo.toml. Returns the relative paths that changed.
 */
export async function syncSmokeLockfiles({
  repoRoot = smokeLockfileRepoRoot,
  check = false,
} = {}) {
  const version = await readRustPackageVersion(repoRoot);
  const stale = [];
  for (const lock of await listSmokeLockfiles(repoRoot)) {
    const current = await readFile(lock, 'utf8');
    const next = setLockedAxllmVersion(current, version);
    if (next === current) continue;
    stale.push(path.relative(repoRoot, lock));
    if (!check) await writeFile(lock, next);
  }
  return { version, stale };
}
