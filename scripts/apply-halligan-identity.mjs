#!/usr/bin/env node
// Applies the Halligan published-package identities from
// release/halligan-identity.json to a checkout, at publish time only.
//
// The repository deliberately keeps upstream ax-llm/ax names in its committed
// metadata so upstream syncs stay cheap. CI rewrites them to the fork's own
// published names right before uploading, and the rewritten state is never
// committed.
//
// Usage:
//   node scripts/apply-halligan-identity.mjs            apply the rewrites
//   node scripts/apply-halligan-identity.mjs --check    print the plan, do not write
//   node scripts/apply-halligan-identity.mjs --verify   apply, then run dry-run checks
//   ... --allow-dirty                                   permit a dirty working tree
//   ... --root <dir>                                    operate on another checkout

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = path.resolve(scriptDir, '..');
export const identityRelativePath = 'release/halligan-identity.json';

export const npmWorkspaceDirs = [
  'src/ax',
  'src/tools',
  'src/aisdk',
  'src/aws-bedrock',
];

export function parseArguments(argv) {
  const options = {
    mode: 'apply',
    allowDirty: false,
    root: defaultRepoRoot,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.mode = 'check';
    else if (argument === '--verify') options.mode = 'verify';
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory.');
      options.root = path.resolve(value);
      index += 1;
    } else {
      throw new Error(
        `Unknown argument ${JSON.stringify(argument)}. Usage: apply-halligan-identity.mjs [--check|--verify] [--allow-dirty] [--root <dir>]`
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
  return identity;
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

// ---------------------------------------------------------------- npm

export function rewriteNpmManifest(manifest, workspaces, metadata) {
  const changes = [];
  const published = new Set(Object.values(workspaces));
  const next = { ...manifest };

  if (Object.hasOwn(workspaces, manifest.name)) {
    next.name = workspaces[manifest.name];
    changes.push(`name ${manifest.name} -> ${next.name}`);
  } else if (!published.has(manifest.name)) {
    throw new Error(
      `No Halligan identity mapping for npm workspace ${JSON.stringify(manifest.name)}.`
    );
  }

  for (const field of ['dependencies', 'peerDependencies']) {
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

  if (metadata) {
    const record = (field, value) => {
      const current = JSON.stringify(readPath(next, field));
      if (current === JSON.stringify(value)) return;
      writePath(next, field, value);
      changes.push(`${field} -> ${JSON.stringify(value)}`);
    };
    if (next.repository) {
      record('repository.url', metadata.repository_git_url);
    }
    if (next.homepage !== undefined) record('homepage', metadata.homepage);
    if (next.bugs) record('bugs.url', metadata.issues_url);
    if (next.author !== undefined) record('author', metadata.author);
    if (next.description !== undefined) {
      record('description', brandDescription(next.description, metadata));
    }
  }

  return { manifest: next, changes };
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

// Sets `key = "value"` inside a table, inserting the key when it is absent.
// Returns { text, changed }.
function upsertTomlValue(text, table, key, value) {
  if (readTomlValue(text, table, key) === value)
    return { text, changed: false };
  const next = hasTomlKey(text, table, key)
    ? replaceTomlValue(text, table, key, value)
    : insertTomlValue(text, table, key, value);
  return { text: next, changed: true };
}

// Sets a whole raw line (used for array values such as `authors = [...]`).
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      `  <connection>${maven.repository_scm ?? metadata.repository_scm}</connection>`,
      `  <developerConnection>${maven.repository_scm ?? metadata.repository_scm}</developerConnection>`,
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

// -------------------------------------------------------------- driver

export function buildPlan(root, identity) {
  const steps = [];

  for (const dir of npmWorkspaceDirs) {
    const file = path.join(root, dir, 'package.json');
    if (!existsSync(file)) {
      throw new Error(`Expected npm workspace manifest at ${file}.`);
    }
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const { manifest: rewritten, changes } = rewriteNpmManifest(
      manifest,
      identity.npm.workspaces,
      identity.metadata
    );
    steps.push({
      label: `npm ${dir}`,
      file,
      changes,
      write: () =>
        writeFileSync(file, `${JSON.stringify(rewritten, null, 2)}\n`),
    });
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

export function applyIdentity(root, identity) {
  const steps = buildPlan(root, identity);
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
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
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

// Upstream project URLs and author must not survive into a published manifest.
// The dev.axllm.ax Java package and the axllm import package are deliberately
// not on this list: those are import-level identity and must survive.
export const upstreamMetadataMarkers = [
  'ax-llm',
  'axllm.dev',
  'twitter.com/dosco',
];

export function metadataLeaks(text) {
  return upstreamMetadataMarkers.filter((marker) => text.includes(marker));
}

export function verifyIdentity(root, identity) {
  const results = [];
  const fail = (name, detail) => results.push({ name, status: 'fail', detail });
  const pass = (name, detail) => results.push({ name, status: 'pass', detail });
  const skip = (name, detail) => results.push({ name, status: 'skip', detail });

  for (const dir of npmWorkspaceDirs) {
    const workspace = path.join(root, dir);
    const manifest = JSON.parse(
      readFileSync(path.join(workspace, 'package.json'), 'utf8')
    );
    const expected = Object.values(identity.npm.workspaces);
    const packed = runCapture(
      'npm',
      ['pack', '--dry-run', '--json'],
      workspace
    );
    if (!packed.ok) {
      fail(
        `npm pack ${dir}`,
        packed.stderr.trim().split('\n').slice(-3).join(' ')
      );
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
    if (!expected.includes(packedName)) {
      fail(
        `npm pack ${dir}`,
        `packed name ${packedName} is not a Halligan name`
      );
      continue;
    }
    const leakedDeps = [];
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (Object.hasOwn(identity.npm.workspaces, dependency)) {
          leakedDeps.push(`${field}.${dependency}`);
        }
      }
    }
    if (leakedDeps.length > 0) {
      fail(
        `npm pack ${dir}`,
        `unrewritten workspace deps: ${leakedDeps.join(', ')}`
      );
      continue;
    }
    const workspaceDeps = Object.entries({
      ...(manifest.dependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    })
      .filter(([name]) => expected.includes(name))
      .map(([name, range]) => `${name}@${range}`);
    const staleMetadata = metadataLeaks(JSON.stringify(manifest));
    if (manifest.author !== identity.metadata.author) {
      staleMetadata.push(`author ${manifest.author}`);
    }
    if (staleMetadata.length > 0) {
      fail(
        `npm pack ${dir}`,
        `upstream metadata left: ${staleMetadata.join(', ')}`
      );
      continue;
    }
    pass(
      `npm pack ${dir}`,
      `${packedName}@${manifest.version}${workspaceDeps.length ? ` deps: ${workspaceDeps.join(', ')}` : ''}, repo ${manifest.repository?.url ?? 'n/a'}, author ${manifest.author ?? 'n/a'}`
    );
  }

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
    const built = runCapture(
      'python3',
      [
        '-m',
        'build',
        '--sdist',
        '--outdir',
        'dist',
        identity.pypi.manifest.replace(/\/pyproject\.toml$/, ''),
      ],
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
        `import tomllib,sys;d=tomllib.load(open(sys.argv[1],'rb'));print(d['project']['name'])`,
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
  const groupId =
    /<modelVersion>[^<]*<\/modelVersion>\s*<groupId>([^<]*)<\/groupId>\s*<artifactId>([^<]*)<\/artifactId>/.exec(
      pomText
    );
  const mavenDir = path.dirname(path.join(root, identity.maven.manifest));
  if (
    !groupId ||
    groupId[1] !== identity.maven.published.groupId ||
    groupId[2] !== identity.maven.published.artifactId
  ) {
    fail('maven metadata', `coordinates ${groupId?.[1]}:${groupId?.[2]}`);
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
      `${groupId[1]}:${groupId[2]} -> ${identity.maven.repository.url}`
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
        `import sys,xml.etree.ElementTree as e;r=e.parse(sys.argv[1]).getroot();n={'m':'http://maven.apache.org/POM/4.0.0'};print(r.findtext('m:groupId',namespaces=n)+':'+r.findtext('m:artifactId',namespaces=n))`,
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

function main(argv) {
  const options = parseArguments(argv);
  const identity = loadIdentity(options.root);

  if (options.mode === 'check') {
    const steps = buildPlan(options.root, identity);
    console.log('Halligan publish-time identity plan:');
    for (const step of steps) {
      const relative = path.relative(options.root, step.file);
      if (step.changes.length === 0) {
        console.log(`  ${step.label} (${relative}): already applied`);
        continue;
      }
      console.log(`  ${step.label} (${relative}):`);
      for (const change of step.changes) console.log(`    - ${change}`);
    }
    return 0;
  }

  assertCleanTree(options.root, options.allowDirty);
  const steps = applyIdentity(options.root, identity);
  for (const step of steps) {
    const relative = path.relative(options.root, step.file);
    console.log(
      step.changes.length === 0
        ? `applied ${step.label} (${relative}): already applied`
        : `applied ${step.label} (${relative}): ${step.changes.join('; ')}`
    );
  }

  if (options.mode !== 'verify') return 0;

  console.log('\nHalligan identity verification:');
  const results = verifyIdentity(options.root, identity);
  for (const result of results) {
    console.log(`  [${result.status}] ${result.name}: ${result.detail}`);
  }
  return results.some((result) => result.status === 'fail') ? 1 : 0;
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
