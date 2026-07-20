// Standalone esbuild build for @northbound-run/sync-shopify.
//
// Open Mercato monorepo packages build via a shared `scripts/build-package.mjs` that is not
// published. This reproduces the same output contract for a standalone repo: transpile every
// src/**/*.{ts,tsx} to dist/ one-to-one (bundle: false), preserving directory structure, then
// append `.js` to relative import specifiers so the ESM output resolves under raw Node — the
// CLI, migrations, and the generator's cache-purge all `import()` the compiled files without a
// bundler. The shipped @open-mercato/sync-akeneo dist does the same.
//
// NOTE: the published tarball must contain BOTH src/ and dist/ (see package.json "files").
// `mercato module add` reads module identity and ejectability from src/modules/<id>/index.ts,
// so a dist-only package will not install.
//
// Decorators: MikroORM legacy decorators compile with experimentalDecorators +
// useDefineForClassFields:false (read from tsconfig.json). This package declares no entities
// today, but the settings are kept so adding one later needs no build change.
import { build } from 'esbuild'
import { glob } from 'glob'
import { readFile, rm, writeFile } from 'node:fs/promises'

const entryPoints = await glob('src/**/*.{ts,tsx}', {
  ignore: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.d.ts'],
  posix: true,
})

if (entryPoints.length === 0) {
  console.warn('[build] no source files matched src/**/*.{ts,tsx}')
}

await rm('dist', { recursive: true, force: true })

await build({
  entryPoints,
  outdir: 'dist',
  outbase: 'src',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  bundle: false,
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
})

// esbuild with bundle:false leaves relative specifiers extensionless; raw-Node ESM requires
// explicit extensions. Rewrite `from "./x"` / `import("./x")` / `export ... from "./x"` to
// append `.js` when the specifier has no extension. All relative imports here target files
// (no directory/index imports), so a bare `.js` append is always correct.
function addJsExtensions(code) {
  return code.replace(
    /(\b(?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\2/g,
    (full, pre, quote, spec) => (/\.[a-zA-Z0-9]+$/.test(spec) ? full : `${pre}${quote}${spec}.js${quote}`),
  )
}

const compiled = await glob('dist/**/*.js', { posix: true })
for (const file of compiled) {
  const original = await readFile(file, 'utf8')
  const rewritten = addJsExtensions(original)
  if (rewritten !== original) await writeFile(file, rewritten)
}

console.log(`[build] compiled ${entryPoints.length} files to dist/ (relative imports extension-normalized)`)
