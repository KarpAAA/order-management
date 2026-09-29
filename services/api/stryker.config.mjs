// Mutation testing: do the unit tests actually test? (conventions: quality/testing.md §4)
// Targets domain/ and application/, plus shared/domain/money.ts (project deviation:
// .claude/rules/project/testing.md). Unit suite only. Report only: no `break` threshold yet.
// `.mjs`: the package is CommonJS (same reason as eslint.config.mjs).

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // explicit: the default `@stryker-mutator/*` glob resolves next to core, which pnpm isolates
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker',
    './stryker.ignorers.mjs',
  ],
  ignorers: ['error-message'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.stryker.config.mts',
    related: true,
  },
  mutate: [
    'src/modules/**/domain/**/*.ts',
    'src/modules/**/application/**/*.ts',
    'src/shared/domain/money.ts',
    '!src/**/*.spec.ts',
    '!src/**/__test__/**',
  ],
  // a mutant that does not type-check is a CompileError, not a false survivor
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  thresholds: { high: 85, low: 70, break: null },
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
};
