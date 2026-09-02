import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyIdentity,
  brandDescription,
  buildPlan,
  loadIdentity,
  metadataLeaks,
  npmWorkspaceDirs,
  parseArguments,
  readTomlValue,
  rewriteCargoToml,
  rewriteNpmManifest,
  rewritePom,
  rewritePyproject,
} from './apply-halligan-identity.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const identity = loadIdentity(repoRoot);
const workspaces = identity.npm.workspaces;
const metadata = identity.metadata;

describe('halligan identity map', () => {
  it('maps every npm workspace in the repository', () => {
    for (const dir of npmWorkspaceDirs) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')
      );
      expect(Object.keys(workspaces)).toContain(manifest.name);
    }
  });

  it('never publishes an upstream name', () => {
    for (const published of Object.values(workspaces)) {
      expect(published.startsWith('halligan')).toBe(true);
      expect(published.startsWith('@ax-llm/')).toBe(false);
    }
    expect(identity.pypi.published_distribution).not.toBe(
      identity.pypi.source_distribution
    );
    expect(identity.crates.published_crate).not.toBe(
      identity.crates.source_crate
    );
    expect(identity.maven.published.groupId).not.toBe(
      identity.maven.source.groupId
    );
  });

  it('keeps import-level identity on upstream names', () => {
    expect(identity.pypi.import_package).toBe('axllm');
    expect(identity.crates.lib_name).toBe('axllm');
    expect(identity.maven.java_package).toBe('dev.axllm.ax');
  });

  it('keeps the committed tree on upstream names', () => {
    const ax = JSON.parse(
      readFileSync(path.join(repoRoot, 'src/ax/package.json'), 'utf8')
    );
    expect(ax.name).toBe('@ax-llm/ax');
    const cargo = readFileSync(
      path.join(repoRoot, identity.crates.manifest),
      'utf8'
    );
    expect(readTomlValue(cargo, 'package', 'name')).toBe('axllm');
  });
});

describe('description branding', () => {
  it('prefixes once and only once', () => {
    expect(brandDescription('A library', metadata)).toBe('Halligan: A library');
    expect(brandDescription('Halligan: A library', metadata)).toBe(
      'Halligan: A library'
    );
    expect(brandDescription(undefined, metadata)).toBeUndefined();
  });
});

describe('argument parsing', () => {
  it('defaults to apply mode on a clean tree', () => {
    expect(parseArguments([])).toMatchObject({
      mode: 'apply',
      allowDirty: false,
    });
  });

  it('parses the check, verify and allow-dirty flags', () => {
    expect(parseArguments(['--check'])).toMatchObject({ mode: 'check' });
    expect(parseArguments(['--verify', '--allow-dirty'])).toMatchObject({
      mode: 'verify',
      allowDirty: true,
    });
  });

  it('rejects unknown arguments and a bare --root', () => {
    expect(() => parseArguments(['--publish'])).toThrow(/Unknown argument/);
    expect(() => parseArguments(['--root'])).toThrow(/requires a directory/);
  });
});

describe('npm manifest rewrites', () => {
  it('renames the package and its intra-workspace dependencies', () => {
    const { manifest, changes } = rewriteNpmManifest(
      {
        name: '@ax-llm/ax-tools',
        version: '24.0.17',
        dependencies: {
          '@ax-llm/ax': '24.0.17',
          'better-sqlite3': '^12.11.1',
        },
        peerDependencies: { zod: '^3.24.0' },
        description: 'Ax tools package',
        repository: { type: 'git', url: 'https://github.com/ax-llm/ax.git' },
        homepage: 'https://github.com/ax-llm/ax#readme',
        bugs: { url: 'https://github.com/@ax-llm/ax/issues' },
        author: 'Vikram <https://twitter.com/dosco>',
      },
      workspaces,
      metadata
    );
    expect(manifest.name).toBe('halligan-tools');
    expect(manifest.dependencies).toEqual({
      halligan: '24.0.17',
      'better-sqlite3': '^12.11.1',
    });
    expect(manifest.dependencies['@ax-llm/ax']).toBeUndefined();
    expect(manifest.peerDependencies).toEqual({ zod: '^3.24.0' });
    expect(changes).toContain('dependencies.@ax-llm/ax -> halligan');
  });

  it('rewrites publish-time metadata to the fork', () => {
    const { manifest } = rewriteNpmManifest(
      {
        name: '@ax-llm/ax',
        description: 'The best library to work with LLMs',
        repository: { type: 'git', url: 'https://github.com/ax-llm/ax.git' },
        homepage: 'https://github.com/ax-llm/ax#readme',
        bugs: { url: 'https://github.com/@ax-llm/ax/issues' },
        author: 'Vikram <https://twitter.com/dosco>',
      },
      workspaces,
      metadata
    );
    expect(manifest.repository).toEqual({
      type: 'git',
      url: metadata.repository_git_url,
    });
    expect(manifest.homepage).toBe(metadata.homepage);
    expect(manifest.bugs.url).toBe(metadata.issues_url);
    expect(manifest.author).toBe(metadata.author);
    expect(manifest.description).toBe(
      'Halligan: The best library to work with LLMs'
    );
    expect(metadataLeaks(JSON.stringify(manifest))).toEqual([]);
  });

  it('leaves metadata alone when no metadata section is passed', () => {
    const { manifest } = rewriteNpmManifest(
      { name: '@ax-llm/ax', author: 'Vikram' },
      workspaces
    );
    expect(manifest.author).toBe('Vikram');
  });

  it('rewrites mapped peerDependencies too', () => {
    const { manifest } = rewriteNpmManifest(
      {
        name: '@ax-llm/ax-ai-sdk-provider',
        peerDependencies: { '@ax-llm/ax': '^24.0.0' },
      },
      workspaces,
      metadata
    );
    expect(manifest.peerDependencies).toEqual({ halligan: '^24.0.0' });
  });

  it('is idempotent on an already-rewritten manifest', () => {
    const once = rewriteNpmManifest(
      {
        name: '@ax-llm/ax-tools',
        dependencies: { '@ax-llm/ax': '24.0.17' },
        description: 'Ax tools package',
        author: 'Vikram',
      },
      workspaces,
      metadata
    );
    const twice = rewriteNpmManifest(once.manifest, workspaces, metadata);
    expect(twice.manifest).toEqual(once.manifest);
    expect(twice.changes).toEqual([]);
  });

  it('refuses a workspace with no mapping', () => {
    expect(() =>
      rewriteNpmManifest({ name: '@ax-llm/ax-unmapped' }, workspaces, metadata)
    ).toThrow(/No Halligan identity mapping/);
  });
});

describe('pyproject rewrites', () => {
  const source = [
    '[project]',
    'name = "axllm"',
    'version = "24.0.17"',
    'description = "Generated Ax runtime library"',
    'authors = [{ name = "Ax" }]',
    '',
    '[project.urls]',
    'Homepage = "https://axllm.dev"',
    'Repository = "https://github.com/ax-llm/ax"',
    '',
    '[tool.setuptools.packages.find]',
    'include = ["axllm", "axllm.*"]',
    '',
  ].join('\n');

  it('renames only the distribution, never the import package', () => {
    const { text, changes } = rewritePyproject(source, identity.pypi, metadata);
    expect(readTomlValue(text, 'project', 'name')).toBe('halligan-ax');
    expect(text).toContain('include = ["axllm", "axllm.*"]');
    expect(changes[0]).toBe('[project] name axllm -> halligan-ax');
  });

  it('rewrites urls, authors and description without touching the import package', () => {
    const { text } = rewritePyproject(source, identity.pypi, metadata);
    expect(readTomlValue(text, 'project.urls', 'Homepage')).toBe(
      metadata.homepage
    );
    expect(readTomlValue(text, 'project.urls', 'Repository')).toBe(
      metadata.repository_url
    );
    expect(text).toContain(`authors = [{ name = "${metadata.author}" }]`);
    expect(readTomlValue(text, 'project', 'description')).toBe(
      'Halligan: Generated Ax runtime library'
    );
    expect(metadataLeaks(text)).toEqual([]);
    expect(text).toContain('include = ["axllm", "axllm.*"]');
  });

  it('is idempotent', () => {
    const once = rewritePyproject(source, identity.pypi, metadata);
    const twice = rewritePyproject(once.text, identity.pypi, metadata);
    expect(twice.text).toBe(once.text);
    expect(twice.changes).toEqual([]);
  });

  it('refuses an unexpected distribution name', () => {
    expect(() =>
      rewritePyproject(
        '[project]\nname = "something-else"\n',
        identity.pypi,
        metadata
      )
    ).toThrow(/expected "axllm"/);
  });
});

describe('cargo rewrites', () => {
  const source = [
    '[package]',
    'name = "axllm"',
    'version = "24.0.17"',
    'description = "Generated Ax runtime library"',
    'repository = "https://github.com/ax-llm/ax"',
    '',
    '[lib]',
    'path = "src/lib.rs"',
    '',
    '[[bin]]',
    'name = "axllm-conformance"',
    '',
  ].join('\n');

  it('renames the crate and pins the library target to axllm', () => {
    const { text } = rewriteCargoToml(source, identity.crates, metadata);
    expect(readTomlValue(text, 'package', 'name')).toBe('halligan');
    expect(readTomlValue(text, 'lib', 'name')).toBe('axllm');
    expect(text).toContain('path = "src/lib.rs"');
    expect(text).toContain('name = "axllm-conformance"');
  });

  it('rewrites crate metadata to the fork', () => {
    const { text } = rewriteCargoToml(source, identity.crates, metadata);
    expect(readTomlValue(text, 'package', 'repository')).toBe(
      metadata.repository_url
    );
    expect(readTomlValue(text, 'package', 'homepage')).toBe(metadata.homepage);
    expect(readTomlValue(text, 'package', 'documentation')).toBe(
      metadata.documentation_url
    );
    expect(text).toContain(`authors = ["${metadata.author}"]`);
    expect(readTomlValue(text, 'package', 'description')).toBe(
      'Halligan: Generated Ax runtime library'
    );
    expect(metadataLeaks(text)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = rewriteCargoToml(source, identity.crates, metadata);
    const twice = rewriteCargoToml(once.text, identity.crates, metadata);
    expect(twice.text).toBe(once.text);
    expect(twice.changes).toEqual([]);
  });

  it('refuses an unexpected crate name', () => {
    expect(() =>
      rewriteCargoToml(
        '[package]\nname = "nope"\n\n[lib]\n',
        identity.crates,
        metadata
      )
    ).toThrow(/expected "axllm"/);
  });
});

describe('pom rewrites', () => {
  const source = [
    '<project>',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <groupId>dev.axllm</groupId>',
    '  <artifactId>ax</artifactId>',
    '  <version>24.0.17</version>',
    '  <name>Ax</name>',
    '  <url>https://axllm.dev</url>',
    '  <scm>',
    '    <url>https://github.com/ax-llm/ax</url>',
    '    <connection>scm:git:https://github.com/ax-llm/ax.git</connection>',
    '    <developerConnection>scm:git:https://github.com/ax-llm/ax.git</developerConnection>',
    '  </scm>',
    '  <description>Generated Ax runtime library.</description>',
    '  <developers>',
    '    <developer>',
    '      <id>ax-llm</id>',
    '      <name>Ax</name>',
    '      <url>https://github.com/ax-llm/ax</url>',
    '    </developer>',
    '  </developers>',
    '  <build>',
    '    <plugins>',
    '      <plugin>',
    '        <groupId>org.apache.maven.plugins</groupId>',
    '        <artifactId>maven-compiler-plugin</artifactId>',
    '        <configuration>',
    '          <includes><include>dev/axllm/ax/*.java</include></includes>',
    '        </configuration>',
    '      </plugin>',
    '    </plugins>',
    '  </build>',
    '</project>',
    '',
  ].join('\n');

  it('renames only the project coordinates, not plugin coordinates', () => {
    const { text } = rewritePom(source, identity.maven, metadata);
    expect(text).toContain('<groupId>io.github.24601</groupId>');
    expect(text).toContain('<artifactId>halligan</artifactId>');
    expect(text).toContain('<groupId>org.apache.maven.plugins</groupId>');
    expect(text).toContain('<artifactId>maven-compiler-plugin</artifactId>');
    expect(text).toContain('dev/axllm/ax/*.java');
  });

  it('rewrites project url, scm, developers and description', () => {
    const { text } = rewritePom(source, identity.maven, metadata);
    expect(text).toContain(`<url>${metadata.homepage}</url>`);
    expect(text).toContain(`<url>${metadata.repository_url}</url>`);
    expect(text).toContain(
      `<connection>${metadata.repository_scm}</connection>`
    );
    expect(text).toContain(`<name>${metadata.author}</name>`);
    expect(text).toContain(`<id>${metadata.owner}</id>`);
    expect(text).toContain(
      '<description>Halligan: Generated Ax runtime library.</description>'
    );
    // The Java package is import-level identity and must survive.
    expect(text).toContain('dev/axllm/ax/*.java');
    expect(text).not.toContain('github.com/ax-llm/ax');
    expect(text).not.toContain('https://axllm.dev');
  });

  it('adds a GitHub Packages distributionManagement block', () => {
    const { text } = rewritePom(source, identity.maven, metadata);
    expect(text).toContain('<distributionManagement>');
    expect(text).toContain(`<url>${identity.maven.repository.url}</url>`);
    expect(text.indexOf('</distributionManagement>')).toBeLessThan(
      text.indexOf('</project>')
    );
  });

  it('is idempotent', () => {
    const once = rewritePom(source, identity.maven, metadata);
    const twice = rewritePom(once.text, identity.maven, metadata);
    expect(twice.text).toBe(once.text);
    expect(twice.changes).toEqual([]);
  });

  it('refuses a pom whose coordinates are not where it expects', () => {
    expect(() =>
      rewritePom(
        '<project><groupId>dev.axllm</groupId></project>',
        identity.maven,
        metadata
      )
    ).toThrow(/coordinates were not found/);
  });
});

describe('applying the map to a fixture checkout', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'halligan-identity-'));
    for (const relative of [
      'release/halligan-identity.json',
      identity.pypi.manifest,
      identity.crates.manifest,
      identity.maven.manifest,
      ...npmWorkspaceDirs.map((dir) => `${dir}/package.json`),
    ]) {
      await cp(path.join(repoRoot, relative), path.join(fixture, relative), {
        recursive: true,
      });
    }
  });

  afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });

  it('leaves the real repository untouched', () => {
    expect(existsSync(path.join(fixture, 'src/ax/package.json'))).toBe(true);
    const ax = JSON.parse(
      readFileSync(path.join(repoRoot, 'src/ax/package.json'), 'utf8')
    );
    expect(ax.name).toBe('@ax-llm/ax');
  });

  it('rewrites every surface and is idempotent on a second pass', () => {
    const first = applyIdentity(fixture, identity);
    expect(first.some((step) => step.changes.length > 0)).toBe(true);

    const ax = JSON.parse(
      readFileSync(path.join(fixture, 'src/ax/package.json'), 'utf8')
    );
    expect(ax.name).toBe('halligan');
    const tools = JSON.parse(
      readFileSync(path.join(fixture, 'src/tools/package.json'), 'utf8')
    );
    expect(tools.name).toBe('halligan-tools');
    expect(tools.dependencies.halligan).toBe(tools.version);
    expect(tools.dependencies['@ax-llm/ax']).toBeUndefined();

    const cargo = readFileSync(
      path.join(fixture, identity.crates.manifest),
      'utf8'
    );
    expect(readTomlValue(cargo, 'package', 'name')).toBe('halligan');
    expect(readTomlValue(cargo, 'lib', 'name')).toBe('axllm');

    const pyproject = readFileSync(
      path.join(fixture, identity.pypi.manifest),
      'utf8'
    );
    expect(readTomlValue(pyproject, 'project', 'name')).toBe('halligan-ax');
    expect(pyproject).toContain('include = ["axllm", "axllm.*"]');

    const pom = readFileSync(
      path.join(fixture, identity.maven.manifest),
      'utf8'
    );
    expect(pom).toContain('<artifactId>halligan</artifactId>');
    expect(pom).toContain(identity.maven.repository.url);

    // No published manifest may carry upstream project metadata.
    for (const text of [
      JSON.stringify(ax),
      JSON.stringify(tools),
      cargo,
      pyproject,
      pom,
    ]) {
      expect(metadataLeaks(text)).toEqual([]);
    }
    expect(ax.author).toBe(identity.metadata.author);
    expect(ax.homepage).toBe(identity.metadata.homepage);
    expect(ax.bugs.url).toBe(identity.metadata.issues_url);
    expect(ax.description.startsWith('Halligan: ')).toBe(true);

    const before = snapshot(fixture);
    const second = buildPlan(fixture, identity);
    expect(second.every((step) => step.changes.length === 0)).toBe(true);
    applyIdentity(fixture, identity);
    expect(snapshot(fixture)).toEqual(before);
  });
});

function snapshot(root) {
  const files = [
    identity.pypi.manifest,
    identity.crates.manifest,
    identity.maven.manifest,
    ...npmWorkspaceDirs.map((dir) => `${dir}/package.json`),
  ];
  return Object.fromEntries(
    files.map((relative) => [
      relative,
      readFileSync(path.join(root, relative), 'utf8'),
    ])
  );
}
