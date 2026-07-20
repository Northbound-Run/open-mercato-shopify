/** @type {import('jest').Config} */
// Self-contained test config. Unit tests target pure, framework-runtime-free helpers (cursor,
// content hash, JSONL reassembly, cost/throttle arithmetic, money parsing, GID parsing, OAuth
// state). Modules under test import framework code as `import type` only, so ts-jest can
// transpile to CommonJS without loading @open-mercato/* ESM at runtime.
//
// NOTE: unlike the sync-google-sheets reference, tsconfig.json does NOT exclude __tests__, so
// test files are typechecked by `yarn typecheck`. `passWithNoTests` is deliberately absent —
// an empty run is a failure, not a pass.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        diagnostics: { ignoreCodes: [151001] },
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          // `moduleResolution: 'node'` predates package `exports` maps, so a specifier like
          // `@open-mercato/shared/modules/integrations/types` — which typecheck resolves fine under
          // `Bundler` — fails here with TS2307. There is no specifier that satisfies both, which
          // meant a tested module could not reference framework types *even as `import type`*, and
          // the workaround was hand-mirroring those types with all the drift risk that carries.
          // Mapping the subpaths to their real on-disk location fixes it for ts-jest only; the
          // build and `yarn typecheck` continue to use the exports map.
          baseUrl: '.',
          paths: {
            '@open-mercato/core/*': ['node_modules/@open-mercato/core/src/*'],
            '@open-mercato/shared/*': ['node_modules/@open-mercato/shared/src/*'],
            '@open-mercato/ui/*': ['node_modules/@open-mercato/ui/src/*'],
          },
          jsx: 'react-jsx',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          experimentalDecorators: true,
          useDefineForClassFields: false,
          target: 'ES2022',
          verbatimModuleSyntax: false,
          skipLibCheck: true,
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
}
