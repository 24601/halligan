import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyPlan,
  assertWorkspaceCoverage,
  brandDescription,
  buildSourcePlan,
  discoverNpmWorkspaces,
  loadIdentity,
  metadataLeaks,
  parseArguments,
  readmeUpstreamLines,
  readTomlValue,
  residualUpstreamNames,
  rewriteCargoToml,
  rewriteDistManifest,
  rewriteImportSpecifiers,
  rewriteNpmManifest,
  rewritePom,
  rewritePyproject,
  rewriteSelfReferences,
  rewriteShippedDoc,
} from './apply-halligan-identity.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const identity = loadIdentity(repoRoot);
const npmMap = identity.npm;
const workspaces = npmMap.workspaces;
const metadata = identity.metadata;
const fields = npmMap.dependency_fields;

describe('halligan identity map', () => {
  it('covers every publishable workspace discovered from the root globs', () => {
    const discovered = discoverNpmWorkspaces(repoRoot);
    const publishable = discovered.filter((entry) => entry.publishable);
    expect(publishable.length).toBeGreaterThan(0);
    for (const workspace of publishable) {
      expect(Object.keys(workspaces)).toContain(workspace.name);
    }
    // src/examples is private and has no publish script, so it is not required
    // to be mapped, and src/data is excluded by the root globs.
    expect(discovered.map((entry) => entry.dir)).toContain('src/examples');
    expect(
      discovered.find((entry) => entry.dir === 'src/examples')?.publishable
    ).toBe(false);
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

  it('rewrites every dependency field, not just the runtime ones', () => {
    expect(fields).toEqual([
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
      'devDependencies',
    ]);
  });

  it('maps the bin name so the published CLI is not a conflicting ax shim', () => {
    expect(npmMap.bin).toEqual({ ax: 'halligan' });
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

describe('workspace coverage', () => {
  it('hard-fails on a publishable workspace with no mapping', () => {
    const discovered = [
      { name: '@ax-llm/ax', dir: 'src/ax', publishable: true },
      { name: '@ax-llm/ax-brand-new', dir: 'src/brand-new', publishable: true },
    ];
    expect(() => assertWorkspaceCoverage(discovered, npmMap)).toThrow(
      /@ax-llm\/ax-brand-new \(src\/brand-new\)/
    );
  });

  it('ignores private workspaces with no publish script', () => {
    const discovered = [
      { name: '@ax-llm/ax', dir: 'src/ax', publishable: true },
      { name: '@ax-llm/ax-examples', dir: 'src/examples', publishable: false },
    ];
    expect(assertWorkspaceCoverage(discovered, npmMap)).toHaveLength(1);
  });

  it('accepts a checkout that is already rewritten', () => {
    const discovered = [{ name: 'halligan', dir: 'src/ax', publishable: true }];
    expect(() => assertWorkspaceCoverage(discovered, npmMap)).not.toThrow();
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
  it('defaults to the source stage on a clean tree', () => {
    expect(parseArguments([])).toMatchObject({
      mode: 'source',
      allowDirty: false,
      only: 'all',
    });
  });

  it('parses the stage, scope and escape-hatch flags', () => {
    expect(parseArguments(['--check'])).toMatchObject({ mode: 'check' });
    expect(parseArguments(['--dist'])).toMatchObject({ mode: 'dist' });
    expect(
      parseArguments(['--verify', '--only', 'generated', '--skip-links'])
    ).toMatchObject({ mode: 'verify', only: 'generated', skipLinks: true });
    expect(parseArguments(['--allow-dirty'])).toMatchObject({
      allowDirty: true,
    });
  });

  it('rejects unknown arguments and bad values', () => {
    expect(() => parseArguments(['--publish'])).toThrow(/Unknown argument/);
    expect(() => parseArguments(['--root'])).toThrow(/requires a directory/);
    expect(() => parseArguments(['--only', 'maven'])).toThrow(/--only takes/);
  });
});

describe('npm manifest rewrites', () => {
  it('renames the package and all four dependency fields', () => {
    const { manifest, changes } = rewriteNpmManifest(
      {
        name: '@ax-llm/ax-tools',
        version: '24.0.17',
        dependencies: {
          '@ax-llm/ax': '24.0.17',
          'better-sqlite3': '^12.11.1',
        },
        peerDependencies: { '@ax-llm/ax': '^24.0.0' },
        optionalDependencies: { '@ax-llm/ax-ai-aws-bedrock': '24.0.17' },
        devDependencies: { '@ax-llm/ax-ai-sdk-provider': '24.0.17' },
      },
      workspaces,
      metadata,
      fields
    );
    expect(manifest.name).toBe('halligan-tools');
    expect(manifest.dependencies).toEqual({
      halligan: '24.0.17',
      'better-sqlite3': '^12.11.1',
    });
    expect(manifest.peerDependencies).toEqual({ halligan: '^24.0.0' });
    expect(manifest.optionalDependencies).toEqual({
      'halligan-aws-bedrock': '24.0.17',
    });
    expect(manifest.devDependencies).toEqual({
      'halligan-ai-sdk-provider': '24.0.17',
    });
    expect(changes).toContain(
      'optionalDependencies.@ax-llm/ax-ai-aws-bedrock -> halligan-aws-bedrock'
    );
    expect(residualUpstreamNames(manifest, workspaces)).toEqual([]);
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
      metadata,
      fields
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
    expect(residualUpstreamNames(manifest, workspaces)).toEqual([]);
  });

  it('leaves a private workspace name and metadata alone', () => {
    const { manifest } = rewriteNpmManifest(
      {
        name: '@ax-llm/ax-examples',
        author: 'Vikram',
        dependencies: { '@ax-llm/ax': '24.0.17' },
      },
      workspaces,
      metadata,
      fields,
      { requireMapping: false, applyMetadata: false }
    );
    expect(manifest.name).toBe('@ax-llm/ax-examples');
    expect(manifest.author).toBe('Vikram');
    expect(manifest.dependencies).toEqual({ halligan: '24.0.17' });
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
      metadata,
      fields
    );
    const twice = rewriteNpmManifest(
      once.manifest,
      workspaces,
      metadata,
      fields
    );
    expect(twice.manifest).toEqual(once.manifest);
    expect(twice.changes).toEqual([]);
  });

  it('refuses a publishable workspace with no mapping', () => {
    expect(() =>
      rewriteNpmManifest(
        { name: '@ax-llm/ax-unmapped' },
        workspaces,
        metadata,
        fields
      )
    ).toThrow(/No Halligan identity mapping/);
  });

  it('reports any residual upstream name anywhere in a manifest', () => {
    const leaked = residualUpstreamNames(
      { name: 'halligan-tools', keywords: ['@ax-llm/ax'] },
      workspaces
    );
    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toContain('@ax-llm/ax');
  });
});

describe('dist manifest rewrites', () => {
  it('remaps the bin name that postbuild sets unconditionally', () => {
    const { manifest, changes } = rewriteDistManifest(
      {
        name: '@ax-llm/ax',
        version: '24.0.17',
        bin: { ax: './cli/index.mjs' },
      },
      npmMap,
      metadata
    );
    expect(manifest.name).toBe('halligan');
    expect(manifest.bin).toEqual({ halligan: './cli/index.mjs' });
    expect(manifest.bin.ax).toBeUndefined();
    expect(changes).toContain('bin.ax -> halligan');
  });

  it('leaves an unmapped bin command alone and is idempotent', () => {
    const once = rewriteDistManifest(
      { name: '@ax-llm/ax', bin: { ax: './cli.mjs', other: './other.mjs' } },
      npmMap,
      metadata
    );
    expect(Object.keys(once.manifest.bin).sort()).toEqual([
      'halligan',
      'other',
    ]);
    const twice = rewriteDistManifest(once.manifest, npmMap, metadata);
    expect(twice.manifest).toEqual(once.manifest);
    expect(twice.changes).toEqual([]);
  });
});

describe('import specifier rewrites', () => {
  it('rewrites import, export, dynamic import and require positions', () => {
    const source = [
      "import { ai } from '@ax-llm/ax';",
      "import type { AxAPI } from '@ax-llm/ax/index.js';",
      "export { thing } from '@ax-llm/ax-tools';",
      "const mod = await import('@ax-llm/ax');",
      "const cjs = require('@ax-llm/ax-ai-aws-bedrock');",
      "import '@ax-llm/ax/side-effect.js';",
    ].join('\n');
    const { text, count } = rewriteImportSpecifiers(source, workspaces);
    expect(count).toBe(6);
    expect(text).toContain("from 'halligan'");
    expect(text).toContain("from 'halligan/index.js'");
    expect(text).toContain("from 'halligan-tools'");
    expect(text).toContain("import('halligan')");
    expect(text).toContain("require('halligan-aws-bedrock')");
    expect(text).toContain("import 'halligan/side-effect.js'");
    expect(text).not.toContain('@ax-llm/');
  });

  it('does not touch strings that are not import specifiers', () => {
    const source = [
      "const key = Symbol.for('@ax-llm/ax/agent-playbook-restore');",
      "const label = '@ax-llm/ax';",
      '// see @ax-llm/ax for details',
    ].join('\n');
    const { text, count } = rewriteImportSpecifiers(source, workspaces);
    expect(count).toBe(0);
    expect(text).toBe(source);
  });

  it('matches the longest name first', () => {
    const { text } = rewriteImportSpecifiers(
      "import x from '@ax-llm/ax-tools';",
      workspaces
    );
    expect(text).toContain("'halligan-tools'");
    expect(text).not.toContain('halligan-tools-tools');
  });

  it('is idempotent', () => {
    const once = rewriteImportSpecifiers(
      "import { ai } from '@ax-llm/ax';",
      workspaces
    );
    const twice = rewriteImportSpecifiers(once.text, workspaces);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });
});

describe('self-reference rewrites', () => {
  it('turns a package self-import into a relative path', () => {
    const source = [
      "import type { AxAPI } from '@ax-llm/ax/index.js';",
      "import { thing } from '@ax-llm/ax';",
    ].join('\n');
    const { text, count } = rewriteSelfReferences(
      source,
      '@ax-llm/ax',
      '../..'
    );
    expect(count).toBe(2);
    expect(text).toContain("from '../../index.js'");
    expect(text).not.toContain('@ax-llm/ax');
  });

  it('handles a file at the workspace root', () => {
    const { text } = rewriteSelfReferences(
      "import x from '@ax-llm/ax/util.js';",
      '@ax-llm/ax',
      ''
    );
    expect(text).toContain("from './util.js'");
  });

  it('leaves other packages alone', () => {
    const source = "import x from '@ax-llm/ax-tools';";
    expect(rewriteSelfReferences(source, '@ax-llm/ax', '..').text).toBe(source);
  });
});

describe('shipped doc rewrites', () => {
  const readme = [
    '# @ax-llm/ax-tools',
    '',
    '[![NPM Package](https://img.shields.io/npm/v/@ax-llm/ax?style=for-the-badge)](https://www.npmjs.com/package/@ax-llm/ax)',
    '',
    '```bash',
    'npm install @ax-llm/ax-tools',
    '```',
    '',
    "import { ax } from '@ax-llm/ax';",
    '',
    'See [docs](https://github.com/ax-llm/ax/blob/main/docs/API.md).',
    '',
  ].join('\n');

  it('rewrites install lines, imports, the badge and repository links', () => {
    const { text } = rewriteShippedDoc(readme, workspaces, metadata);
    expect(text).toContain('npm install halligan-tools');
    expect(text).toContain("from 'halligan'");
    expect(text).toContain('img.shields.io/npm/v/halligan?');
    expect(text).toContain('https://www.npmjs.com/package/halligan');
    expect(text).toContain(`${metadata.repository_url}/blob/main/docs/API.md`);
    expect(text).not.toContain('@ax-llm/');
    expect(readmeUpstreamLines(text)).toEqual([]);
  });

  it('flags an unrewritten doc', () => {
    expect(readmeUpstreamLines(readme).length).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    const once = rewriteShippedDoc(readme, workspaces, metadata);
    const twice = rewriteShippedDoc(once.text, workspaces, metadata);
    expect(twice.text).toBe(once.text);
    expect(twice.changes).toEqual([]);
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

  it('rewrites urls, authors and description', () => {
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

describe('applying the source stage to a fixture checkout', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'halligan-identity-'));
    for (const relative of [
      'release/halligan-identity.json',
      'package.json',
      identity.pypi.manifest,
      identity.crates.manifest,
      identity.maven.manifest,
    ]) {
      await cp(path.join(repoRoot, relative), path.join(fixture, relative), {
        recursive: true,
      });
    }
    for (const dir of ['src/ax', 'src/tools', 'src/aisdk', 'src/aws-bedrock']) {
      await cp(
        path.join(repoRoot, dir, 'package.json'),
        path.join(fixture, dir, 'package.json'),
        { recursive: true }
      );
    }
    // A dependent source file and a shipped README, enough to exercise the
    // specifier and doc passes without copying the whole tree.
    writeFileSync(
      path.join(fixture, 'src/tools/entry.ts'),
      "import { ai } from '@ax-llm/ax';\nexport const x = ai;\n"
    );
    writeFileSync(
      path.join(fixture, 'src/tools/README.md'),
      '# @ax-llm/ax-tools\n\nnpm install @ax-llm/ax-tools\n'
    );
    mkdirSync(path.join(fixture, 'src/ax/skills'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'src/ax/skills/ax-llm.md'),
      "Install with `npm install @ax-llm/ax`.\n\nimport { ai } from '@ax-llm/ax';\n"
    );
    mkdirSync(path.join(fixture, 'src/ax/cli'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'src/ax/cli/index.mjs'),
      "console.log('npx @ax-llm/ax setup-claude');\n"
    );
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
    const first = applyPlan(
      buildSourcePlan(fixture, identity, { skipLinks: true })
    );
    expect(first.some((step) => step.changes.length > 0)).toBe(true);

    const ax = JSON.parse(
      readFileSync(path.join(fixture, 'src/ax/package.json'), 'utf8')
    );
    expect(ax.name).toBe('halligan');
    expect(ax.author).toBe(metadata.author);
    const tools = JSON.parse(
      readFileSync(path.join(fixture, 'src/tools/package.json'), 'utf8')
    );
    expect(tools.name).toBe('halligan-tools');
    expect(tools.dependencies.halligan).toBe(tools.version);

    // The critical pairing: manifest and specifier move together.
    expect(
      readFileSync(path.join(fixture, 'src/tools/entry.ts'), 'utf8')
    ).toContain("from 'halligan'");
    const readme = readFileSync(
      path.join(fixture, 'src/tools/README.md'),
      'utf8'
    );
    expect(readme).toContain('npm install halligan-tools');
    expect(readmeUpstreamLines(readme)).toEqual([]);
    const skill = readFileSync(
      path.join(fixture, 'src/ax/skills/ax-llm.md'),
      'utf8'
    );
    expect(skill).toContain('npm install halligan');
    expect(readmeUpstreamLines(skill)).toEqual([]);
    expect(
      readFileSync(path.join(fixture, 'src/ax/cli/index.mjs'), 'utf8')
    ).toContain('npx halligan setup-claude');

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

    for (const text of [
      JSON.stringify(ax),
      JSON.stringify(tools),
      cargo,
      pyproject,
      pom,
    ]) {
      expect(metadataLeaks(text)).toEqual([]);
    }

    const before = snapshot(fixture);
    const second = buildSourcePlan(fixture, identity, { skipLinks: true });
    expect(second.every((step) => step.changes.length === 0)).toBe(true);
    applyPlan(second);
    expect(snapshot(fixture)).toEqual(before);
  });

  it('fails the plan when a publishable workspace has no mapping', () => {
    mkdirSync(path.join(fixture, 'src/newpkg'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'src/newpkg/package.json'),
      `${JSON.stringify(
        {
          name: '@ax-llm/ax-newpkg',
          version: '24.0.17',
          scripts: { publish: 'npm run build && cd dist && npm publish' },
        },
        null,
        2
      )}\n`
    );
    expect(() =>
      buildSourcePlan(fixture, identity, { skipLinks: true })
    ).toThrow(/@ax-llm\/ax-newpkg \(src\/newpkg\)/);
    rmSync(path.join(fixture, 'src/newpkg'), {
      recursive: true,
      force: true,
    });
  });
});

function snapshot(root) {
  const files = [
    identity.pypi.manifest,
    identity.crates.manifest,
    identity.maven.manifest,
    'src/tools/entry.ts',
    'src/tools/README.md',
    'src/ax/skills/ax-llm.md',
    'src/ax/cli/index.mjs',
    'src/ax/package.json',
    'src/tools/package.json',
    'src/aisdk/package.json',
    'src/aws-bedrock/package.json',
  ];
  return Object.fromEntries(
    files.map((relative) => [
      relative,
      readFileSync(path.join(root, relative), 'utf8'),
    ])
  );
}
