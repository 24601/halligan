#!/usr/bin/env node
// Applies the Halligan published-package identities from
// release/halligan-identity.json to a checkout, at publish time only.
//
// The repository deliberately keeps upstream ax-llm/ax names in its committed
// metadata so upstream syncs stay cheap. CI rewrites them to the fork's own
// published names right before uploading, and the rewritten state is never
// committed.
//
// The rewrite runs in two stages.
//
//   Source stage (before build): npm manifests, the import specifiers that
//   reference them, the workspace READMEs, the shipped skill docs, the CLI
//   banner, the node_modules links that keep esbuild externalising the core,
//   and the Python, Rust and Java manifests.
//
//   Dist stage (after build, before publish): each built dist/package.json,
//   notably the bin name, which scripts/postbuild.js writes unconditionally.
//
// Usage:
//   node scripts/apply-halligan-identity.mjs --check    print the plan, do not write
//   node scripts/apply-halligan-identity.mjs            apply the source stage
//   node scripts/apply-halligan-identity.mjs --dist     apply the dist stage
//   node scripts/apply-halligan-identity.mjs --verify   verify built dist output
//   ... --allow-dirty                                   permit a dirty working tree
//   ... --root <dir>                                    operate on another checkout
//   ... --skip-links                                    do not touch node_modules
//   ... --only npm|generated                            restrict --verify to one half
//   node scripts/apply-halligan-identity.mjs --list-dists  print the dist dirs to publish

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = path.resolve(scriptDir, '..');
export const identityRelativePath = 'release/halligan-identity.json';

export const sourceExtensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const skipDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.generated',
]);

export function parseArguments(argv) {
  const options = {
    mode: 'source',
    allowDirty: false,
    skipLinks: false,
    only: 'all',
    root: defaultRepoRoot,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.mode = 'check';
    else if (argument === '--verify') options.mode = 'verify';
    else if (argument === '--dist') options.mode = 'dist';
    else if (argument === '--list-dists') options.mode = 'list-dists';
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--skip-links') options.skipLinks = true;
    else if (argument === '--only') {
      const value = argv[index + 1];
      if (!['npm', 'generated', 'all'].includes(value)) {
        throw new Error('--only takes npm, generated, or all.');
      }
      options.only = value;
      index += 1;
    } else if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory.');
      options.root = path.resolve(value);
      index += 1;
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(argument)}. Usage: apply-halligan-identity.mjs [--check|--dist|--verify|--list-dists] [--only npm|generated|all] [--allow-dirty] [--skip-links] [--root <dir>]`
      );
    }
  }
  return options;
}

export function loadIdentity(root = defaultRepoRoot) {
  const file = path.join(root, identityRelativePath);
  if (!existsSync(file)) {
    throw new Error(`Identity map not found at ${file}.`);
  }
  const identity = JSON.parse(readFileSync(file, 'utf8'));
  if (identity.schema_version !== 1) {
    throw new Error(
      `Unsupported identity schema_version ${identity.schema_version}; this script implements 1.`
    );
  }
  for (const section of ['metadata', 'npm', 'pypi', 'crates', 'maven']) {
    if (!identity[section]) {
      throw new Error(`Identity map is missing the ${section} section.`);
    }
  }
  for (const field of ['dependency_fields', 'bundling_markers']) {
    if (!Array.isArray(identity.npm[field])) {
      throw new Error(`Identity map npm.${field} must be an array.`);
    }
  }
  return identity;
}

// ------------------------------------------------- workspace discovery

// Publishable workspaces come from the root package.json `workspaces` globs
// rather than a list in this file. A new publishable workspace must therefore
// appear in the identity map or `--check` fails, instead of being published
// silently under its upstream name by `npm publish --workspaces`.
export function discoverNpmWorkspaces(root) {
  const rootManifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8')
  );
  const patterns = rootManifest.workspaces ?? [];
  const include = patterns.filter((pattern) => !pattern.startsWith('!'));
  const exclude = new Set(
    patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1))
  );

  const directories = [];
  for (const pattern of include) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      const parentPath = path.join(root, parent);
      if (!existsSync(parentPath)) continue;
      for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relative = `${parent}/${entry.name}`;
        if (exclude.has(relative)) continue;
        directories.push(relative);
      }
    } else if (!exclude.has(pattern)) {
      directories.push(pattern);
    }
  }

  const workspaces = [];
  for (const relative of directories.sort()) {
    const manifestPath = path.join(root, relative, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const isPrivate = manifest.private === true || manifest.private === 'true';
    workspaces.push({
      dir: relative,
      name: manifest.name,
      manifest,
      manifestPath,
      publishable: !isPrivate && Boolean(manifest.scripts?.publish),
    });
  }
  return workspaces;
}

export function assertWorkspaceCoverage(workspaces, npmMap) {
  const published = new Set(Object.values(npmMap.workspaces));
  const unmapped = workspaces
    .filter((workspace) => workspace.publishable)
    .filter(
      (workspace) =>
        !Object.hasOwn(npmMap.workspaces, workspace.name) &&
        !published.has(workspace.name)
    );
  if (unmapped.length > 0) {
    throw new Error(
      `No Halligan identity mapping for publishable npm workspace(s): ${unmapped
        .map((workspace) => `${workspace.name} (${workspace.dir})`)
        .join(', ')}. Add them to ${identityRelativePath}.`
    );
  }
  return workspaces.filter((workspace) => workspace.publishable);
}

// ------------------------------------------------------------ metadata

// A description that already carries the prefix is left alone, so applying the
// identity twice never produces "Halligan: Halligan: ...".
export function brandDescription(description, metadata) {
  if (typeof description !== 'string' || description.length === 0) {
    return description;
  }
  return description.startsWith(metadata.description_prefix)
    ? description
    : `${metadata.description_prefix}${description}`;
}

// Longest first, so @ax-llm/ax-tools is matched before @ax-llm/ax.
export function mappedNamesByLength(workspaces) {
  return Object.entries(workspaces).sort(
    ([left], [right]) => right.length - left.length
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- npm

export function rewriteNpmManifest(
  manifest,
  workspaces,
  metadata,
  fields,
  options = {}
) {
  const changes = [];
  const published = new Set(Object.values(workspaces));
  const next = { ...manifest };
  const dependencyFields = fields ?? ['dependencies', 'peerDependencies'];
  const requireMapping = options.requireMapping !== false;

  if (Object.hasOwn(workspaces, manifest.name)) {
    next.name = workspaces[manifest.name];
    changes.push(`name ${manifest.name} -> ${next.name}`);
  } else if (requireMapping && !published.has(manifest.name)) {
    throw new Error(
      `No Halligan identity mapping for npm workspace ${JSON.stringify(manifest.name)}.`
    );
  }

  for (const field of dependencyFields) {
    const block = manifest[field];
    if (!block) continue;
    const rewritten = {};
    let touched = false;
    for (const [dependency, range] of Object.entries(block)) {
      const mapped = workspaces[dependency];
      if (mapped) {
        rewritten[mapped] = range;
        touched = true;
        changes.push(`${field}.${dependency} -> ${mapped}`);
      } else {
        rewritten[dependency] = range;
      }
    }
    if (touched) next[field] = rewritten;
  }

  if (metadata && options.applyMetadata !== false) {
    const record = (field, value) => {
      const current = JSON.stringify(readPath(next, field));
      if (current === JSON.stringify(value)) return;
      writePath(next, field, value);
      changes.push(`${field} -> ${JSON.stringify(value)}`);
    };
    if (next.repository) record('repository.url', metadata.repository_git_url);
    if (next.homepage !== undefined) record('homepage', metadata.homepage);
    if (next.bugs) record('bugs.url', metadata.issues_url);
    if (next.author !== undefined) record('author', metadata.author);
    if (next.description !== undefined) {
      record('description', brandDescription(next.description, metadata));
    }
  }

  return { manifest: next, changes };
}

// The dist manifest is what actually ships. postbuild.js copies the rewritten
// source manifest into dist/ but then sets `bin` unconditionally, so the bin
// name is remapped here rather than in the source stage.
export function rewriteDistManifest(manifest, npmMap, metadata) {
  const { manifest: next, changes } = rewriteNpmManifest(
    manifest,
    npmMap.workspaces,
    metadata,
    npmMap.dependency_fields
  );
  if (next.bin && npmMap.bin) {
    const rewritten = {};
    let touched = false;
    for (const [command, target] of Object.entries(next.bin)) {
      const mapped = npmMap.bin[command];
      if (mapped && mapped !== command) {
        rewritten[mapped] = target;
        touched = true;
        changes.push(`bin.${command} -> ${mapped}`);
      } else {
        rewritten[command] = target;
      }
    }
    if (touched) next.bin = rewritten;
  }
  return { manifest: next, changes };
}

// Any string anywhere in a published manifest that still names an upstream
// workspace is a leak. This is the hard gate behind `--check`.
export function residualUpstreamNames(value, workspaces, trail = '') {
  const sources = Object.keys(workspaces);
  const found = [];
  const walk = (node, at) => {
    if (typeof node === 'string') {
      for (const source of sources) {
        if (node.includes(source)) found.push(`${at}: ${node}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        for (const source of sources) {
          if (key.includes(source)) found.push(`${at}.${key} (key)`);
        }
        walk(item, at ? `${at}.${key}` : key);
      }
    }
  };
  walk(value, trail);
  return found;
}

function readPath(target, dotted) {
  return dotted
    .split('.')
    .reduce((value, key) => (value == null ? value : value[key]), target);
}

function writePath(target, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cursor = target;
  for (const key of keys) {
    cursor[key] = { ...cursor[key] };
    cursor = cursor[key];
  }
  cursor[last] = value;
}

// -------------------------------------------------- import specifiers

// Renaming the dependency key alone is not enough: esbuild externalises only
// module names it finds in the manifest's dependency fields. Leaving
// `import ... from '@ax-llm/ax'` in the sources after the rename makes esbuild
// resolve it through the workspace link and inline the whole core into every
// dependent. Both halves have to move together.
export function rewriteImportSpecifiers(text, workspaces) {
  let next = text;
  let count = 0;
  for (const [source, published] of mappedNamesByLength(workspaces)) {
    // Syntactic import positions only. A blanket quoted-string rewrite would
    // also hit strings that merely look like a name, notably the
    // Symbol.for('@ax-llm/ax/...') interop keys, where changing the value is a
    // behaviour change rather than a rename.
    const pattern = new RegExp(
      `\\b(from|import|require)(\\s*\\(\\s*|\\s+)(['"])${escapeRegExp(source)}((?:/[^'"]*)?)\\3`,
      'g'
    );
    next = next.replace(pattern, (_match, keyword, gap, quote, subpath) => {
      count += 1;
      return `${keyword}${gap}${quote}${published}${subpath}${quote}`;
    });
  }
  return { text: next, count };
}

// A workspace importing its own package name is a self-reference. It resolves
// through the package's own exports map, which is fine at runtime but makes
// TypeScript's project-root inference ambiguous (TS2209) inside the monorepo
// once the name changes. Rewriting these to relative paths removes the
// ambiguity and is a strictly better specifier in the published declarations.
export function rewriteSelfReferences(text, selfName, relativeBase) {
  let next = text;
  let count = 0;
  const pattern = new RegExp(
    `\\b(from|import|require)(\\s*\\(\\s*|\\s+)(['"])${escapeRegExp(selfName)}((?:/[^'"]*)?)\\3`,
    'g'
  );
  next = next.replace(pattern, (_match, keyword, gap, quote, subpath) => {
    count += 1;
    const target = subpath ? subpath.slice(1) : 'index.js';
    const base = relativeBase === '' ? '.' : relativeBase;
    const specifier = base.startsWith('.')
      ? `${base}/${target}`
      : `./${base}/${target}`;
    return `${keyword}${gap}${quote}${specifier}${quote}`;
  });
  return { text: next, count };
}

// ------------------------------------------------------- shipped docs

// postbuild.js copies the workspace README and skills/*.md into dist/, so both
// are published surface. Install lines, import specifiers, the npm badge and
// the repository links all have to name the fork.
export function rewriteShippedDoc(text, workspaces, metadata) {
  let next = text;
  const changes = [];
  for (const [source, published] of mappedNamesByLength(workspaces)) {
    const pattern = new RegExp(escapeRegExp(source), 'g');
    const hits = (next.match(pattern) ?? []).length;
    if (hits > 0) {
      next = next.replace(pattern, published);
      changes.push(`${source} -> ${published} (${hits})`);
    }
  }
  if (metadata) {
    const repository = /https:\/\/github\.com\/ax-llm\/ax\b/g;
    const hits = (next.match(repository) ?? []).length;
    if (hits > 0) {
      next = next.replace(repository, metadata.repository_url);
      changes.push(`repository links -> ${metadata.repository_url} (${hits})`);
    }
  }
  return { text: next, changes };
}

// --------------------------------------------------------- TOML helpers

// Minimal, deliberately narrow reader: finds `key = "value"` inside one
// top-level table. Enough for the two names this script owns, and it does not
// pretend to be a TOML parser.
export function readTomlValue(text, table, key) {
  const section = tomlSection(text, table);
  if (!section) return null;
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(
    section.body
  );
  return match ? match[1] : null;
}

function tomlSection(text, table) {
  const header = new RegExp(`^\\[${escapeRegExp(table)}\\][ \\t]*$`, 'm');
  const start = header.exec(text);
  if (!start) return null;
  const bodyStart = start.index + start[0].length;
  const rest = text.slice(bodyStart);
  const nextHeader = /^\[/m.exec(rest);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index : text.length;
  return {
    headerEnd: bodyStart,
    bodyEnd,
    body: text.slice(bodyStart, bodyEnd),
  };
}

function replaceTomlValue(text, table, key, value) {
  const section = tomlSection(text, table);
  if (!section) throw new Error(`TOML table [${table}] not found.`);
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"`, 'm');
  if (!pattern.test(section.body)) {
    throw new Error(`TOML key ${key} not found in [${table}].`);
  }
  const body = section.body.replace(pattern, `$1"${value}"`);
  return text.slice(0, section.headerEnd) + body + text.slice(section.bodyEnd);
}

function insertTomlValue(text, table, key, value) {
  return insertTomlLine(text, table, `${key} = "${value}"`);
}

function insertTomlLine(text, table, line) {
  const section = tomlSection(text, table);
  if (!section) throw new Error(`TOML table [${table}] not found.`);
  const body = `\n${line}${section.body}`;
  return text.slice(0, section.headerEnd) + body + text.slice(section.bodyEnd);
}

function hasTomlKey(text, table, key) {
  const section = tomlSection(text, table);
  if (!section) return false;
  return new RegExp(`^\\s*${key}\\s*=`, 'm').test(section.body);
}

function upsertTomlValue(text, table, key, value) {
  if (readTomlValue(text, table, key) === value)
    return { text, changed: false };
  const next = hasTomlKey(text, table, key)
    ? replaceTomlValue(text, table, key, value)
    : insertTomlValue(text, table, key, value);
  return { text: next, changed: true };
}

function upsertTomlLine(text, table, key, line) {
  const section = tomlSection(text, table);
  if (!section) throw new Error(`TOML table [${table}] not found.`);
  const pattern = new RegExp(`^[ \\t]*${key}\\s*=.*$`, 'm');
  const existing = pattern.exec(section.body);
  if (existing) {
    if (existing[0] === line) return { text, changed: false };
    const body = section.body.replace(pattern, line);
    return {
      text:
        text.slice(0, section.headerEnd) + body + text.slice(section.bodyEnd),
      changed: true,
    };
  }
  return { text: insertTomlLine(text, table, line), changed: true };
}

// -------------------------------------------------------------- PyPI

export function rewritePyproject(text, pypi, metadata) {
  const changes = [];
  let next = text;
  const current = readTomlValue(next, 'project', 'name');
  if (current === null) {
    throw new Error('pyproject.toml has no [project] name.');
  }
  if (current === pypi.source_distribution) {
    next = replaceTomlValue(
      next,
      'project',
      'name',
      pypi.published_distribution
    );
    changes.push(
      `[project] name ${pypi.source_distribution} -> ${pypi.published_distribution}`
    );
  } else if (current !== pypi.published_distribution) {
    throw new Error(
      `pyproject.toml [project] name is ${JSON.stringify(current)}; expected ${JSON.stringify(pypi.source_distribution)} or ${JSON.stringify(pypi.published_distribution)}.`
    );
  }

  if (metadata) {
    const description = readTomlValue(next, 'project', 'description');
    if (description !== null) {
      const branded = brandDescription(description, metadata);
      const applied = upsertTomlValue(next, 'project', 'description', branded);
      next = applied.text;
      if (applied.changed) changes.push(`[project] description -> ${branded}`);
    }
    // PEP 621 authors accept name and email only; url is not a valid key.
    const authors = `authors = [{ name = "${metadata.author}" }]`;
    const authorsApplied = upsertTomlLine(next, 'project', 'authors', authors);
    next = authorsApplied.text;
    if (authorsApplied.changed) {
      changes.push(`[project] authors -> ${metadata.author}`);
    }
    if (tomlSection(next, 'project.urls')) {
      for (const [key, value] of [
        ['Homepage', metadata.homepage],
        ['Repository', metadata.repository_url],
      ]) {
        const applied = upsertTomlValue(next, 'project.urls', key, value);
        next = applied.text;
        if (applied.changed) changes.push(`[project.urls] ${key} -> ${value}`);
      }
    }
  }

  if (!next.includes(`"${pypi.import_package}"`)) {
    throw new Error(
      `pyproject.toml no longer references the ${pypi.import_package} import package after the rewrite.`
    );
  }
  return { text: next, changes };
}

// -------------------------------------------------------------- crates.io

export function rewriteCargoToml(text, crates, metadata) {
  const changes = [];
  let next = text;
  const current = readTomlValue(next, 'package', 'name');
  if (current === null) throw new Error('Cargo.toml has no [package] name.');
  if (current === crates.source_crate) {
    next = replaceTomlValue(next, 'package', 'name', crates.published_crate);
    changes.push(
      `[package] name ${crates.source_crate} -> ${crates.published_crate}`
    );
  } else if (current !== crates.published_crate) {
    throw new Error(
      `Cargo.toml [package] name is ${JSON.stringify(current)}; expected ${JSON.stringify(crates.source_crate)} or ${JSON.stringify(crates.published_crate)}.`
    );
  }

  if (metadata) {
    const description = readTomlValue(next, 'package', 'description');
    if (description !== null) {
      const branded = brandDescription(description, metadata);
      const applied = upsertTomlValue(next, 'package', 'description', branded);
      next = applied.text;
      if (applied.changed) changes.push(`[package] description -> ${branded}`);
    }
    for (const [key, value] of [
      ['repository', metadata.repository_url],
      ['homepage', metadata.homepage],
      ['documentation', metadata.documentation_url],
    ]) {
      const applied = upsertTomlValue(next, 'package', key, value);
      next = applied.text;
      if (applied.changed) changes.push(`[package] ${key} -> ${value}`);
    }
    const authors = `authors = ["${metadata.author}"]`;
    const authorsApplied = upsertTomlLine(next, 'package', 'authors', authors);
    next = authorsApplied.text;
    if (authorsApplied.changed) {
      changes.push(`[package] authors -> ${metadata.author}`);
    }
  }

  const libName = readTomlValue(next, 'lib', 'name');
  if (libName === null) {
    next = insertTomlValue(next, 'lib', 'name', crates.lib_name);
    changes.push(`[lib] name = ${crates.lib_name} (added)`);
  } else if (libName !== crates.lib_name) {
    next = replaceTomlValue(next, 'lib', 'name', crates.lib_name);
    changes.push(`[lib] name ${libName} -> ${crates.lib_name}`);
  }

  return { text: next, changes };
}

// -------------------------------------------------------------- Maven

// Replaces one whole XML element, keeping the element's own indentation.
function replaceXmlBlock(text, tag, lines) {
  const pattern = new RegExp(`([ \\t]*)<${tag}>[\\s\\S]*?</${tag}>`);
  const match = pattern.exec(text);
  if (!match) return { text, changed: false };
  const indent = match[1];
  const rendered = lines
    .map((line, position) => (position === 0 ? line : `${indent}${line}`))
    .join('\n');
  const start = match.index + indent.length;
  const end = match.index + match[0].length;
  if (text.slice(start, end) === rendered) return { text, changed: false };
  return {
    text: text.slice(0, start) + rendered + text.slice(end),
    changed: true,
  };
}

export function rewritePom(text, maven, metadata) {
  const changes = [];
  let next = text;
  const { source, published, repository } = maven;

  const coordinates = new RegExp(
    `(<modelVersion>[^<]*</modelVersion>\\s*)<groupId>(${escapeRegExp(source.groupId)}|${escapeRegExp(published.groupId)})</groupId>(\\s*)<artifactId>(${escapeRegExp(source.artifactId)}|${escapeRegExp(published.artifactId)})</artifactId>`
  );
  const match = coordinates.exec(next);
  if (!match) {
    throw new Error(
      'pom.xml project coordinates were not found directly after <modelVersion>.'
    );
  }
  if (match[2] !== published.groupId || match[4] !== published.artifactId) {
    next = next.replace(
      coordinates,
      `$1<groupId>${published.groupId}</groupId>$3<artifactId>${published.artifactId}</artifactId>`
    );
    changes.push(
      `coordinates ${match[2]}:${match[4]} -> ${published.groupId}:${published.artifactId}`
    );
  }

  if (metadata) {
    const projectUrl = /(<name>[^<]*<\/name>\s*)<url>([^<]*)<\/url>/;
    const urlMatch = projectUrl.exec(next);
    if (urlMatch && urlMatch[2] !== metadata.homepage) {
      next = next.replace(projectUrl, `$1<url>${metadata.homepage}</url>`);
      changes.push(`project url -> ${metadata.homepage}`);
    }

    const scm = replaceXmlBlock(next, 'scm', [
      '<scm>',
      `  <url>${metadata.repository_url}</url>`,
      `  <connection>${metadata.repository_scm}</connection>`,
      `  <developerConnection>${metadata.repository_scm}</developerConnection>`,
      '</scm>',
    ]);
    next = scm.text;
    if (scm.changed) changes.push(`scm -> ${metadata.repository_url}`);

    const developers = replaceXmlBlock(next, 'developers', [
      '<developers>',
      '  <developer>',
      `    <id>${metadata.owner}</id>`,
      `    <name>${metadata.author}</name>`,
      `    <url>${metadata.author_url}</url>`,
      '  </developer>',
      '</developers>',
    ]);
    next = developers.text;
    if (developers.changed) changes.push(`developers -> ${metadata.author}`);

    const descriptionPattern = /<description>([^<]*)<\/description>/;
    const descriptionMatch = descriptionPattern.exec(next);
    if (descriptionMatch) {
      const branded = brandDescription(descriptionMatch[1], metadata);
      if (branded !== descriptionMatch[1]) {
        next = next.replace(
          descriptionPattern,
          `<description>${branded}</description>`
        );
        changes.push(`description -> ${branded}`);
      }
    }
  }

  if (!next.includes('<distributionManagement>')) {
    const block = [
      '  <!--',
      '    Halligan fork: generated Java artifacts publish to GitHub Packages, which',
      '    needs only GITHUB_TOKEN. The upstream `release` profile above targets the',
      '    Maven Central Portal and stays unused by this fork.',
      '  -->',
      '  <distributionManagement>',
      '    <repository>',
      `      <id>${repository.id}</id>`,
      `      <name>${repository.name}</name>`,
      `      <url>${repository.url}</url>`,
      '    </repository>',
      '  </distributionManagement>',
      '',
    ].join('\n');
    const closing = next.lastIndexOf('</project>');
    if (closing < 0) throw new Error('pom.xml has no closing </project> tag.');
    next = `${next.slice(0, closing)}${block}${next.slice(closing)}`;
    changes.push(`distributionManagement -> ${repository.url}`);
  }

  if (!next.includes(`${maven.java_package.replaceAll('.', '/')}/`)) {
    throw new Error(
      `pom.xml no longer references the ${maven.java_package} Java package after the rewrite.`
    );
  }

  return { text: next, changes };
}

// -------------------------------------------------------- source files

function collectSourceFiles(root, relativeDir) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirectories.has(entry.name)) continue;
        walk(path.join(directory, entry.name));
      } else if (sourceExtensions.includes(path.extname(entry.name))) {
        files.push(path.join(directory, entry.name));
      }
    }
  };
  walk(path.join(root, relativeDir));
  return files.sort();
}

// -------------------------------------------------------- node_modules

// esbuild only externalises a module it can also resolve, so the published
// names need links. The upstream links are replaced rather than kept alongside:
// two package names resolving to one directory makes TypeScript's project-root
// inference ambiguous (TS2209) as soon as an export-map subpath has to be
// resolved, which breaks the declaration build. After the source rewrite
// nothing in the checkout imports the upstream names any more.
export function workspaceLinkPlan(root, workspaces, npmMap) {
  const nodeModules = path.join(root, 'node_modules');
  if (!existsSync(nodeModules)) return { create: [], remove: [] };
  const create = [];
  const remove = [];
  for (const workspace of workspaces) {
    const published = npmMap.workspaces[workspace.name];
    if (!published) continue;
    create.push({
      linkPath: path.join(nodeModules, published),
      target: path.relative(nodeModules, path.join(root, workspace.dir)),
    });
    remove.push(path.join(nodeModules, workspace.name));
  }
  return { create, remove };
}

function applyWorkspaceLinks(plan) {
  for (const linkPath of plan.remove) {
    try {
      if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
    } catch {
      // nothing to remove
    }
  }
  for (const { linkPath, target } of plan.create) {
    mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
      else continue;
    } catch {
      // no existing entry
    }
    symlinkSync(target, linkPath, 'dir');
  }
}

// -------------------------------------------------------------- plans

export function buildSourcePlan(root, identity, options = {}) {
  const npmMap = identity.npm;
  const all = discoverNpmWorkspaces(root);
  const publishable = assertWorkspaceCoverage(all, npmMap);
  const steps = [];

  for (const workspace of publishable) {
    const { manifest: rewritten, changes } = rewriteNpmManifest(
      workspace.manifest,
      npmMap.workspaces,
      identity.metadata,
      npmMap.dependency_fields
    );
    const residual = residualUpstreamNames(rewritten, npmMap.workspaces);
    if (residual.length > 0) {
      throw new Error(
        `${workspace.dir}/package.json still names upstream workspaces after the rewrite:\n${residual
          .map((entry) => `  - ${entry}`)
          .join('\n')}`
      );
    }
    steps.push({
      label: `npm ${workspace.dir}`,
      file: workspace.manifestPath,
      changes,
      write: () =>
        writeFileSync(
          workspace.manifestPath,
          `${JSON.stringify(rewritten, null, 2)}\n`
        ),
    });
  }

  // Private workspaces are never published, but they still depend on and import
  // the mapped names. Their manifests and sources move too, so the checkout
  // speaks one set of names and every workspace still resolves and builds.
  for (const workspace of all.filter((entry) => !entry.publishable)) {
    const { manifest: rewritten, changes } = rewriteNpmManifest(
      workspace.manifest,
      npmMap.workspaces,
      identity.metadata,
      npmMap.dependency_fields,
      { requireMapping: false, applyMetadata: false }
    );
    if (changes.length === 0) continue;
    steps.push({
      label: `npm ${workspace.dir} (private)`,
      file: workspace.manifestPath,
      changes,
      write: () =>
        writeFileSync(
          workspace.manifestPath,
          `${JSON.stringify(rewritten, null, 2)}\n`
        ),
    });
  }

  // Import specifiers across every workspace's sources, self-references
  // included: after the link replacement the upstream names stop resolving.
  for (const workspace of all) {
    const files = collectSourceFiles(root, workspace.dir);
    const edits = [];
    let total = 0;
    const workspaceRoot = path.join(root, workspace.dir);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const self = rewriteSelfReferences(
        text,
        workspace.name,
        path
          .relative(path.dirname(file), workspaceRoot)
          .split(path.sep)
          .join('/')
      );
      const { text: next, count } = rewriteImportSpecifiers(
        self.text,
        npmMap.workspaces
      );
      if (count + self.count > 0) {
        edits.push({ file, next });
        total += count + self.count;
      }
    }
    if (edits.length > 0) {
      steps.push({
        label: `imports ${workspace.dir}`,
        file: path.join(root, workspace.dir),
        changes: [
          `${total} specifier(s) in ${edits.length} file(s): ${edits
            .map((edit) => path.relative(root, edit.file))
            .slice(0, 3)
            .join(', ')}${edits.length > 3 ? ', ...' : ''}`,
        ],
        write: () => {
          for (const edit of edits) writeFileSync(edit.file, edit.next);
        },
      });
    }
  }

  // Published READMEs and shipped skill docs: postbuild copies both into dist/.
  for (const workspace of publishable) {
    const docs = [];
    const readme = path.join(root, workspace.dir, 'README.md');
    if (existsSync(readme)) docs.push(readme);
    const skillsDir = path.join(root, workspace.dir, 'skills');
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          docs.push(path.join(skillsDir, entry.name));
        }
      }
    }
    const edits = [];
    for (const file of docs.sort()) {
      const { text, changes } = rewriteShippedDoc(
        readFileSync(file, 'utf8'),
        npmMap.workspaces,
        identity.metadata
      );
      if (changes.length > 0) edits.push({ file, text });
    }
    if (edits.length > 0) {
      steps.push({
        label: `docs ${workspace.dir}`,
        file: path.join(root, workspace.dir),
        changes: [
          `${edits.length} shipped doc(s): ${edits
            .map((edit) =>
              path.relative(path.join(root, workspace.dir), edit.file)
            )
            .slice(0, 3)
            .join(', ')}${edits.length > 3 ? ', ...' : ''}`,
        ],
        write: () => {
          for (const edit of edits) writeFileSync(edit.file, edit.text);
        },
      });
    }
  }

  // CLI banner: the published bin is named halligan, so the help text must be.
  const cli = path.join(root, 'src/ax/cli/index.mjs');
  if (existsSync(cli)) {
    const { text, changes } = rewriteShippedDoc(
      readFileSync(cli, 'utf8'),
      npmMap.workspaces,
      null
    );
    steps.push({
      label: 'cli banner',
      file: cli,
      changes,
      write: () => writeFileSync(cli, text),
    });
  }

  if (!options.skipLinks) {
    const links = workspaceLinkPlan(root, publishable, npmMap);
    if (links.create.length > 0) {
      steps.push({
        label: 'node_modules links',
        file: path.join(root, 'node_modules'),
        changes: [
          ...links.create.map(
            ({ linkPath, target }) => `${path.basename(linkPath)} -> ${target}`
          ),
          ...links.remove.map(
            (linkPath) =>
              `remove ${path.relative(path.join(root, 'node_modules'), linkPath)}`
          ),
        ],
        write: () => applyWorkspaceLinks(links),
      });
    }
  }

  const pyprojectFile = path.join(root, identity.pypi.manifest);
  const pyproject = rewritePyproject(
    readFileSync(pyprojectFile, 'utf8'),
    identity.pypi,
    identity.metadata
  );
  steps.push({
    label: 'pypi',
    file: pyprojectFile,
    changes: pyproject.changes,
    write: () => writeFileSync(pyprojectFile, pyproject.text),
  });

  const cargoFile = path.join(root, identity.crates.manifest);
  const cargo = rewriteCargoToml(
    readFileSync(cargoFile, 'utf8'),
    identity.crates,
    identity.metadata
  );
  steps.push({
    label: 'crates.io',
    file: cargoFile,
    changes: cargo.changes,
    write: () => writeFileSync(cargoFile, cargo.text),
  });

  const pomFile = path.join(root, identity.maven.manifest);
  const pom = rewritePom(
    readFileSync(pomFile, 'utf8'),
    identity.maven,
    identity.metadata
  );
  steps.push({
    label: 'maven',
    file: pomFile,
    changes: pom.changes,
    write: () => writeFileSync(pomFile, pom.text),
  });

  return steps;
}

export function buildDistPlan(root, identity) {
  const npmMap = identity.npm;
  const publishable = assertWorkspaceCoverage(
    discoverNpmWorkspaces(root),
    npmMap
  );
  const steps = [];
  for (const workspace of publishable) {
    const distManifestPath = path.join(
      root,
      workspace.dir,
      'dist',
      'package.json'
    );
    if (!existsSync(distManifestPath)) {
      throw new Error(
        `${path.relative(root, distManifestPath)} does not exist. Build the workspaces before the dist stage.`
      );
    }
    const manifest = JSON.parse(readFileSync(distManifestPath, 'utf8'));
    const { manifest: rewritten, changes } = rewriteDistManifest(
      manifest,
      npmMap,
      identity.metadata
    );
    const residual = residualUpstreamNames(rewritten, npmMap.workspaces);
    if (residual.length > 0) {
      throw new Error(
        `${path.relative(root, distManifestPath)} still names upstream workspaces:\n${residual
          .map((entry) => `  - ${entry}`)
          .join('\n')}`
      );
    }
    steps.push({
      label: `dist ${workspace.dir}`,
      file: distManifestPath,
      changes,
      write: () =>
        writeFileSync(
          distManifestPath,
          `${JSON.stringify(rewritten, null, 2)}\n`
        ),
    });
  }
  return steps;
}

// Core first, so the package its dependents declare exists on the registry
// before they are uploaded.
export function publishableDistDirs(root, identity) {
  const npmMap = identity.npm;
  const publishable = assertWorkspaceCoverage(
    discoverNpmWorkspaces(root),
    npmMap
  );
  const isCore = (workspace) =>
    workspace.name === npmMap.core_workspace ||
    workspace.name === npmMap.workspaces[npmMap.core_workspace];
  return [
    ...publishable.filter(isCore),
    ...publishable.filter((workspace) => !isCore(workspace)),
  ].map((workspace) => `${workspace.dir}/dist`);
}

export function applyPlan(steps) {
  for (const step of steps) {
    if (step.changes.length > 0) step.write();
  }
  return steps;
}

function assertCleanTree(root, allowDirty) {
  if (allowDirty) return;
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return; // not a git checkout; nothing to protect
  if (result.stdout.trim()) {
    throw new Error(
      'Working tree is dirty. The identity rewrite must never be committed; rerun with --allow-dirty only if you know the tree is disposable.'
    );
  }
}

// -------------------------------------------------------------- verify

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function hasCommand(command) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

export const upstreamMetadataMarkers = [
  'ax-llm',
  'axllm.dev',
  'twitter.com/dosco',
];

export function metadataLeaks(text) {
  return upstreamMetadataMarkers.filter((marker) => text.includes(marker));
}

// A published doc that still tells people to install or import an upstream name
// is broken regardless of what the manifest says.
export function readmeUpstreamLines(text) {
  return text
    .split('\n')
    .filter(
      (line) =>
        line.includes('@ax-llm/') &&
        (/npm\s+(install|i)\s/.test(line) ||
          /\bfrom\s+['"]/.test(line) ||
          /\brequire\(/.test(line))
    );
}

function distFiles(directory, extensions) {
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(full);
      }
    }
  };
  walk(directory);
  return files;
}

// esbuild rewrites nothing it externalises, so a bundled core shows up as the
// core's own module paths inside the dependent's sourcemaps. This survives
// minification and identifier mangling, unlike a symbol-name grep.
export function bundledCoreSources(distDir, coreDir) {
  const offenders = [];
  for (const map of distFiles(distDir, ['.map'])) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(map, 'utf8'));
    } catch {
      continue;
    }
    const sources = parsed.sources ?? [];
    const core = sources.filter((source) => source.includes(`/${coreDir}/`));
    if (core.length > 0) {
      offenders.push({ map, count: core.length, sample: core[0] });
    }
  }
  return offenders;
}

export function verifyIdentity(root, identity, only = 'all') {
  const results = [];
  const fail = (name, detail) => results.push({ name, status: 'fail', detail });
  const pass = (name, detail) => results.push({ name, status: 'pass', detail });
  const skip = (name, detail) => results.push({ name, status: 'skip', detail });

  const npmMap = identity.npm;
  const publishable = assertWorkspaceCoverage(
    discoverNpmWorkspaces(root),
    npmMap
  );
  const publishedNames = Object.values(npmMap.workspaces);
  const corePublished = npmMap.workspaces[npmMap.core_workspace];
  const coreDir = publishable.find(
    (workspace) =>
      workspace.name === npmMap.core_workspace ||
      workspace.name === corePublished
  )?.dir;
  const coreLeaf = coreDir ? path.basename(coreDir) : 'ax';

  for (const workspace of only === 'generated' ? [] : publishable) {
    const label = `npm ${workspace.dir}`;
    const distDir = path.join(root, workspace.dir, 'dist');
    if (!existsSync(path.join(distDir, 'package.json'))) {
      fail(label, 'dist/package.json is missing; build before verifying');
      continue;
    }
    const manifest = JSON.parse(
      readFileSync(path.join(distDir, 'package.json'), 'utf8')
    );

    // The published artifact is the dist directory, so pack that, not source.
    const packed = runCapture('npm', ['pack', '--dry-run', '--json'], distDir);
    if (!packed.ok) {
      fail(label, packed.stderr.trim().split('\n').slice(-3).join(' '));
      continue;
    }
    let packedName = null;
    try {
      const parsed = JSON.parse(packed.stdout);
      const entry = Array.isArray(parsed)
        ? parsed[0]
        : Object.values(parsed)[0];
      packedName = entry?.name ?? null;
    } catch {
      packedName = null;
    }
    if (!publishedNames.includes(packedName)) {
      fail(label, `packed name ${packedName} is not a Halligan name`);
      continue;
    }

    const residual = residualUpstreamNames(manifest, npmMap.workspaces);
    if (residual.length > 0) {
      fail(label, `upstream names in dist manifest: ${residual.join(', ')}`);
      continue;
    }
    const stale = metadataLeaks(JSON.stringify(manifest));
    if (manifest.author !== identity.metadata.author) {
      stale.push(`author ${manifest.author}`);
    }
    if (stale.length > 0) {
      fail(label, `upstream metadata left: ${stale.join(', ')}`);
      continue;
    }

    if (manifest.bin) {
      const wrong = Object.keys(manifest.bin).filter((command) =>
        Object.hasOwn(npmMap.bin ?? {}, command)
      );
      if (wrong.length > 0) {
        fail(label, `dist bin still named ${wrong.join(', ')}`);
        continue;
      }
    }

    // Every mapped dependency must survive as an external import in the emitted
    // JavaScript and in the emitted type declarations. If it had been bundled,
    // esbuild would have dropped the specifier entirely.
    const mappedDeps = new Set();
    for (const field of npmMap.dependency_fields) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (publishedNames.includes(dependency)) mappedDeps.add(dependency);
      }
    }
    const emitted = distFiles(distDir, ['.js', '.cjs', '.mjs']).filter(
      (file) => !file.endsWith('.map')
    );
    const declarations = distFiles(distDir, ['.d.ts', '.d.cts']);
    // A mapped dependency may legitimately be type-only, in which case nothing
    // survives into the emitted JavaScript. Requiring it in the JS or in the
    // declarations catches a bundled core either way, because bundling erases
    // the specifier from both.
    const missingExternal = [];
    const externalIn = new Map();
    for (const dependency of mappedDeps) {
      const inJs = emitted.some((file) =>
        readFileSync(file, 'utf8').includes(dependency)
      );
      const inTypes = declarations.some((file) =>
        readFileSync(file, 'utf8').includes(dependency)
      );
      if (!inJs && !inTypes) missingExternal.push(dependency);
      else
        externalIn.set(
          dependency,
          inJs ? (inTypes ? 'js+types' : 'js') : 'types'
        );
    }
    if (missingExternal.length > 0) {
      fail(
        label,
        `declared dependency not externalised: ${missingExternal.join(', ')}`
      );
      continue;
    }

    // Nothing but the core itself may contain the core's own module graph.
    if (packedName !== corePublished) {
      const bundled = bundledCoreSources(distDir, coreLeaf);
      if (bundled.length > 0) {
        fail(
          label,
          `core bundled: ${bundled[0].count} core sources in ${path.relative(root, bundled[0].map)} (${bundled[0].sample})`
        );
        continue;
      }
      const markers = npmMap.bundling_markers.filter((marker) =>
        emitted.some((file) => readFileSync(file, 'utf8').includes(marker))
      );
      if (markers.length > 0) {
        fail(label, `core-only markers found in dist: ${markers.join(', ')}`);
        continue;
      }
    }

    const shipped = [
      path.join(distDir, 'README.md'),
      ...distFiles(path.join(distDir, 'skills'), ['.md']),
    ].filter((file) => existsSync(file));
    const offenders = shipped.flatMap((file) =>
      readmeUpstreamLines(readFileSync(file, 'utf8')).map(
        (line) => `${path.basename(file)}: ${line.trim()}`
      )
    );
    if (offenders.length > 0) {
      fail(
        label,
        `shipped doc still installs or imports upstream: ${offenders[0]}`
      );
      continue;
    }

    const size = distFiles(distDir, ['.js', '.cjs']).reduce(
      (total, file) => total + readFileSync(file).length,
      0
    );
    pass(
      label,
      `${packedName}@${manifest.version}${externalIn.size ? ` external deps: ${[...externalIn].map(([name, where]) => `${name} (${where})`).join(', ')}` : ''}${manifest.bin ? ` bin: ${Object.keys(manifest.bin).join(',')}` : ''}, ${shipped.length} shipped doc(s), js ${size} B`
    );
  }

  if (only === 'npm') return results;

  const pyprojectText = readFileSync(
    path.join(root, identity.pypi.manifest),
    'utf8'
  );
  const distribution = readTomlValue(pyprojectText, 'project', 'name');
  if (distribution !== identity.pypi.published_distribution) {
    fail('pypi metadata', `[project] name is ${distribution}`);
  } else if (!pyprojectText.includes(`"${identity.pypi.import_package}"`)) {
    fail(
      'pypi metadata',
      `import package ${identity.pypi.import_package} is gone`
    );
  } else if (metadataLeaks(pyprojectText).length > 0) {
    fail(
      'pypi metadata',
      `upstream metadata left: ${metadataLeaks(pyprojectText).join(', ')}`
    );
  } else {
    pass(
      'pypi metadata',
      `${distribution} (import package ${identity.pypi.import_package}), urls ${identity.metadata.homepage}`
    );
  }

  const pythonBuild = runCapture(
    'python3',
    ['-c', 'import build; print(build.__version__)'],
    root
  );
  if (pythonBuild.ok) {
    const packageDir = path.dirname(identity.pypi.manifest);
    const built = runCapture(
      'python3',
      ['-m', 'build', '--sdist', '--outdir', 'dist', packageDir],
      root
    );
    if (
      built.ok &&
      built.stdout.includes(identity.pypi.published_distribution)
    ) {
      pass('pypi sdist', `built ${identity.pypi.published_distribution} sdist`);
    } else {
      fail('pypi sdist', built.stderr.trim().split('\n').slice(-3).join(' '));
    }
  } else {
    const parsed = runCapture(
      'python3',
      [
        '-c',
        "import tomllib,sys;d=tomllib.load(open(sys.argv[1],'rb'));print(d['project']['name'])",
        identity.pypi.manifest,
      ],
      root
    );
    if (
      parsed.ok &&
      parsed.stdout.trim() === identity.pypi.published_distribution
    ) {
      pass(
        'pypi sdist',
        `python -m build is not installed; pyproject.toml parses and declares ${parsed.stdout.trim()}`
      );
    } else if (parsed.ok) {
      fail('pypi sdist', `pyproject.toml declares ${parsed.stdout.trim()}`);
    } else {
      skip(
        'pypi sdist',
        'python -m build and python3 are unavailable; metadata asserted instead'
      );
    }
  }

  const cargoText = readFileSync(
    path.join(root, identity.crates.manifest),
    'utf8'
  );
  const crateName = readTomlValue(cargoText, 'package', 'name');
  const libName = readTomlValue(cargoText, 'lib', 'name');
  if (
    crateName !== identity.crates.published_crate ||
    libName !== identity.crates.lib_name
  ) {
    fail(
      'crates metadata',
      `[package] name ${crateName}, [lib] name ${libName}`
    );
  } else if (metadataLeaks(cargoText).length > 0) {
    fail(
      'crates metadata',
      `upstream metadata left: ${metadataLeaks(cargoText).join(', ')}`
    );
  } else {
    pass(
      'crates metadata',
      `crate ${crateName}, lib ${libName}, repository ${readTomlValue(cargoText, 'package', 'repository')}`
    );
  }
  if (hasCommand('cargo')) {
    const listed = runCapture(
      'cargo',
      [
        'package',
        '--list',
        '--allow-dirty',
        '--manifest-path',
        identity.crates.manifest,
      ],
      root
    );
    if (listed.ok && listed.stdout.includes('src/lib.rs')) {
      pass(
        'cargo package --list',
        `${listed.stdout.trim().split('\n').length} files for crate ${crateName}`
      );
    } else {
      fail(
        'cargo package --list',
        listed.stderr.trim().split('\n').slice(-3).join(' ')
      );
    }
  } else {
    skip(
      'cargo package --list',
      'cargo is not installed; metadata asserted instead'
    );
  }

  const pomText = readFileSync(
    path.join(root, identity.maven.manifest),
    'utf8'
  );
  const coordinates =
    /<modelVersion>[^<]*<\/modelVersion>\s*<groupId>([^<]*)<\/groupId>\s*<artifactId>([^<]*)<\/artifactId>/.exec(
      pomText
    );
  const mavenDir = path.dirname(path.join(root, identity.maven.manifest));
  if (
    !coordinates ||
    coordinates[1] !== identity.maven.published.groupId ||
    coordinates[2] !== identity.maven.published.artifactId
  ) {
    fail(
      'maven metadata',
      `coordinates ${coordinates?.[1]}:${coordinates?.[2]}`
    );
  } else if (!pomText.includes(identity.maven.repository.url)) {
    fail('maven metadata', 'distributionManagement repository is missing');
  } else if (metadataLeaks(pomText).length > 0) {
    fail(
      'maven metadata',
      `upstream metadata left: ${metadataLeaks(pomText).join(', ')}`
    );
  } else {
    pass(
      'maven metadata',
      `${coordinates[1]}:${coordinates[2]} -> ${identity.maven.repository.url}`
    );
  }
  if (hasCommand('mvn')) {
    const evaluated = runCapture(
      'mvn',
      [
        '-q',
        '-B',
        '-ntp',
        'help:evaluate',
        '-Dexpression=project.artifactId',
        '-DforceStdout',
      ],
      mavenDir
    );
    if (
      evaluated.ok &&
      evaluated.stdout.includes(identity.maven.published.artifactId)
    ) {
      pass(
        'mvn help:evaluate',
        `artifactId ${identity.maven.published.artifactId}`
      );
    } else {
      fail(
        'mvn help:evaluate',
        evaluated.stderr.trim().split('\n').slice(-3).join(' ')
      );
    }
  } else {
    const parsed = runCapture(
      'python3',
      [
        '-c',
        "import sys,xml.etree.ElementTree as e;r=e.parse(sys.argv[1]).getroot();n={'m':'http://maven.apache.org/POM/4.0.0'};print(r.findtext('m:groupId',namespaces=n)+':'+r.findtext('m:artifactId',namespaces=n))",
        identity.maven.manifest,
      ],
      root
    );
    const expected = `${identity.maven.published.groupId}:${identity.maven.published.artifactId}`;
    if (parsed.ok && parsed.stdout.trim() === expected) {
      pass(
        'mvn help:evaluate',
        `mvn is not installed; pom.xml parses as well-formed XML declaring ${expected}`
      );
    } else if (parsed.ok) {
      fail('mvn help:evaluate', `pom.xml declares ${parsed.stdout.trim()}`);
    } else {
      skip(
        'mvn help:evaluate',
        'mvn and python3 are unavailable; pom text parsed instead'
      );
    }
  }

  return results;
}

// -------------------------------------------------------------- CLI

function printPlan(title, steps, root) {
  console.log(title);
  for (const step of steps) {
    const relative = path.relative(root, step.file);
    if (step.changes.length === 0) {
      console.log(`  ${step.label} (${relative}): already applied`);
      continue;
    }
    console.log(`  ${step.label} (${relative}):`);
    for (const change of step.changes) console.log(`    - ${change}`);
  }
}

function main(argv) {
  const options = parseArguments(argv);
  const identity = loadIdentity(options.root);

  if (options.mode === 'check') {
    printPlan(
      'Halligan publish-time identity plan (source stage):',
      buildSourcePlan(options.root, identity, { skipLinks: options.skipLinks }),
      options.root
    );
    console.log(
      '\nThe dist stage runs after the build and remaps each dist/package.json, notably bin.'
    );
    return 0;
  }

  // The publish step loops over this rather than a hardcoded list, so a new
  // publishable workspace is published (and gated) without editing a workflow.
  if (options.mode === 'list-dists') {
    for (const dir of publishableDistDirs(options.root, identity)) {
      console.log(dir);
    }
    return 0;
  }

  if (options.mode === 'verify') {
    console.log('Halligan identity verification (post-build):');
    const results = verifyIdentity(options.root, identity, options.only);
    for (const result of results) {
      console.log(`  [${result.status}] ${result.name}: ${result.detail}`);
    }
    return results.some((result) => result.status === 'fail') ? 1 : 0;
  }

  assertCleanTree(options.root, options.allowDirty);
  const steps =
    options.mode === 'dist'
      ? buildDistPlan(options.root, identity)
      : buildSourcePlan(options.root, identity, {
          skipLinks: options.skipLinks,
        });
  applyPlan(steps);
  printPlan(
    `Halligan identity applied (${options.mode} stage):`,
    steps,
    options.root
  );
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`apply-halligan-identity: ${error.message}`);
    process.exit(1);
  }
}
