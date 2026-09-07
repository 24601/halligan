import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

const axIndex = fileURLToPath(new URL('../src/ax/index.ts', import.meta.url));
const axPackage = fileURLToPath(
  new URL('../src/ax/package.json', import.meta.url)
);

function readCommit(): string {
  if (process.env.PRY_COMMIT) return process.env.PRY_COMMIT.slice(0, 40);
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 40);
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readAxVersion(): string {
  try {
    return JSON.parse(readFileSync(axPackage, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The CSP ships as a `<meta http-equiv>` because GitHub Pages cannot set
 * headers. Vite's dev server injects its HMR stylesheets inline, so dev needs
 * `'unsafe-inline'` for styles and the built site does not: shipping one policy
 * that is loose enough for both would be a policy that never gets tested.
 */
function cspPlugin(): Plugin {
  return {
    name: 'pry-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const dev = Boolean(ctx.server);
        return html.replace(
          '%PRY_STYLE_SRC%',
          dev ? "'self' 'unsafe-inline'" : "'self'"
        );
      },
    },
  };
}

/**
 * `src/ax` is browser-neutral and `@ax-llm/ax-tools` is the node-only boundary.
 * A `node:` specifier in the emitted graph means that boundary was crossed, so
 * the build fails rather than shipping something that cannot run in a tab.
 */
function noNodeSpecifiers(): Plugin {
  return {
    name: 'pry-no-node-specifiers',
    apply: 'build',
    generateBundle(_options, bundle) {
      const offenders: string[] = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue;
        if (/(?:from|import)\s*\(?\s*["']node:/.test(chunk.code)) {
          offenders.push(fileName);
        }
      }
      if (offenders.length > 0) {
        this.error(
          `emitted bundle contains a node: specifier in ${offenders.join(', ')}`
        );
      }
    },
  };
}

/**
 * Geist is self-hosted (no external font host, so the CSP needs no third party
 * and Pry works offline after the first load). The two sans weights are
 * preloaded; the mono is not, because it only ever renders below the fold.
 */
function preloadFonts(): Plugin {
  const wanted = ['geist-latin-400-normal', 'geist-latin-700-normal'];
  let emitted: string[] = [];
  return {
    name: 'pry-preload-fonts',
    apply: 'build',
    generateBundle(_options, bundle) {
      emitted = Object.keys(bundle).filter(
        (name) =>
          name.endsWith('.woff2') && wanted.some((face) => name.includes(face))
      );
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (emitted.length === 0) return html;
        const base = process.env.PRY_BASE ?? '/';
        const links = emitted
          .map(
            (file) =>
              `<link rel="preload" as="font" type="font/woff2" crossorigin href="${base}${file}">`
          )
          .join('\n    ');
        return html.replace('</head>', `  ${links}\n  </head>`);
      },
    },
  };
}

export default defineConfig({
  base: process.env.PRY_BASE ?? '/',
  plugins: [vue(), cspPlugin(), preloadFonts(), noNodeSpecifiers()],
  resolve: {
    alias: {
      '@ax-llm/ax': axIndex,
    },
  },
  define: {
    __PRY_COMMIT__: JSON.stringify(readCommit()),
    __PRY_BUILD_TIME__: JSON.stringify(
      process.env.PRY_BUILD_TIME ?? new Date().toISOString()
    ),
    __PRY_AX_VERSION__: JSON.stringify(readAxVersion()),
  },
  build: {
    target: 'es2022',
    cssTarget: 'safari16',
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/src/ax/')) return 'ax';
          if (id.includes('/node_modules/minisearch/')) return 'finder';
          return undefined;
        },
      },
    },
  },
  server: { port: 5273, strictPort: false },
  preview: { port: 4173, strictPort: true },
});
