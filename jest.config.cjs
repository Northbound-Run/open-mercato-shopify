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
