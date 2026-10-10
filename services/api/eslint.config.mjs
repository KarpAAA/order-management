// Reproduced from nest-conventions/templates/eslint.config.mjs.
// Project additions (each also listed in CLAUDE.md → "Deviations from the conventions templates"):
//  1. The Prisma-generated client, prisma/ scripts and root tool files are outside the layer
//     map; Stryker's files, reports and dist-worker/ are not linted.
//  2. Test infrastructure (test/factories, test/helpers) may import module internals: a
//     factory persists through the domain and OrderMapper. test/setup/global.ts default-exports.
//  3. @oms/contracts (packages/contracts) is an element of its own: only what talks to the
//     broker may import it: infrastructure/, a module's adapters and its consumers.
//  4. @RabbitSubscribe is an entry decorator like @Processor: only in a *.consumer.ts.
//  5. `Logger` and `ConsoleLogger` of @nestjs/common are not imported: a class injects LOGGER.
//     The test helpers quiet Nest itself with a ConsoleLogger.
// `.mjs`: a Nest package is CommonJS, and this config uses ESM imports and import.meta.
// Requires: eslint@9, typescript-eslint, eslint-plugin-import, eslint-import-resolver-typescript,
//           eslint-plugin-boundaries@5 (the element-types API below), eslint-config-prettier

import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';

const RESTRICTED_SYNTAX = [
  {
    selector: "CallExpression[callee.property.name='queryRawUnsafe']",
    message: 'Use $queryRaw tagged template.',
  },
  // max-params would count DI constructors too; code-style.md §2 allows 6 dependencies there
  {
    selector:
      ":function[params.length>4]:not(MethodDefinition[kind='constructor'] > FunctionExpression)",
    message: 'At most 4 parameters; the fifth becomes an options object (code-style.md §2).',
  },
  {
    selector: "MethodDefinition[kind='constructor'] > FunctionExpression[params.length>6]",
    message: 'At most 6 constructor dependencies; split the class (code-style.md §2).',
  },
];

// own domain: DTOs use the domain enums and limits (dto-validation.md §3)
const INTERFACE_ALLOW = [
  'shared',
  'common',
  'config',
  ['domain', { module: '${from.module}' }],
  ['app', { module: '${from.module}' }],
  ['read', { module: '${from.module}' }],
  ['features', { module: '${from.module}' }],
  ['modinfra', { module: '${from.module}' }],
  ['modroot', { module: '${from.module}' }],
  'modindex',
];

// the core module and other root files: no `interface`, no `entryclass`; only `transport` wires those
const MODROOT_ALLOW = [
  'shared',
  'common',
  'config',
  'infra',
  ['domain', { module: '${from.module}' }],
  ['ports', { module: '${from.module}' }],
  ['app', { module: '${from.module}' }],
  ['features', { module: '${from.module}' }],
  ['read', { module: '${from.module}' }],
  ['modinfra', { module: '${from.module}' }],
  ['events', { module: '${from.module}' }],
  ['modroot', { module: '${from.module}' }],
  'modindex',
];

export default tseslint.config(
  // eslint.config.mjs: outside the tsconfig program, so type-aware parsing cannot load it
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'prisma/migrations/**',
      'eslint.config.mjs',
      // project: addition 1
      'dist-worker/**',
      'src/infrastructure/database/generated/**',
      'stryker.config.mjs',
      'stryker.ignorers.mjs',
      'reports/**',
      '.stryker-tmp/**',
    ],
  },

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin, boundaries },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.json' } },
      // ── layers, matched by path ─────────────────────────────────────────────
      'boundaries/elements': [
        // process roots (project-structure.md §1): they wire everything
        { type: 'entry', pattern: 'src/entrypoints/**' },
        // project: the tracing preload is a root of the process too, loaded before any
        // entrypoint with `node --require` (docs/adr/0025)
        { type: 'entry', pattern: 'src/instrumentation.ts', mode: 'file' },
        // project: addition 3. pnpm links the workspace package, so it resolves to a path, not to node_modules
        { type: 'contracts', pattern: '**/packages/contracts/**', mode: 'full' },
        { type: 'shared', pattern: 'src/shared/**' },
        { type: 'common', pattern: 'src/common/**' },
        { type: 'config', pattern: 'src/config/**' },
        { type: 'infra', pattern: 'src/infrastructure/**' },
        // classes that start working on their own (principles #12) and the transport modules that
        // wire them (project-structure.md §2); before `interface` and `modroot`: the first match wins
        {
          type: 'entryclass',
          pattern: 'src/modules/*/**/*.{controller,consumer,job,gateway}.ts',
          capture: ['module'],
          mode: 'file',
        },
        {
          type: 'transport',
          pattern: 'src/modules/*/*.{http,worker,ws}.module.ts',
          capture: ['module'],
          mode: 'file',
        },
        { type: 'domain', pattern: 'src/modules/*/domain/**', capture: ['module'] },
        { type: 'ports', pattern: 'src/modules/*/ports/**', capture: ['module'] },
        { type: 'app', pattern: 'src/modules/*/application/**', capture: ['module'] },
        { type: 'features', pattern: 'src/modules/*/features/**', capture: ['module'] },
        { type: 'read', pattern: 'src/modules/*/read/**', capture: ['module'] },
        { type: 'modinfra', pattern: 'src/modules/*/infrastructure/**', capture: ['module'] },
        { type: 'interface', pattern: 'src/modules/*/interface/**', capture: ['module'] },
        { type: 'events', pattern: 'src/modules/*/events/**', capture: ['module'] },
        // module-root files: file mode, the index first so it wins over modroot
        { type: 'modindex', pattern: 'src/modules/*/index.ts', capture: ['module'], mode: 'file' },
        { type: 'modroot', pattern: 'src/modules/*/*.ts', capture: ['module'], mode: 'file' },
      ],
      // __test__/: builders and arbitraries next to the code (testing.md §2); they import fast-check
      'boundaries/ignore': [
        '**/*.spec.ts',
        '**/*.e2e-spec.ts',
        '**/__test__/**',
        'test/**',
        'prisma/**',
        '*.ts',
        '*.mts',
      ], // project: addition 1
    },

    rules: {
      // ── types ─────────────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }], // @Module classes are empty
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }], // `status=${status}`

      // ── async ─────────────────────────────────────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/no-misused-promises': 'error',

      // ── size and hygiene ──────────────────────────────────────────────────
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      'no-warning-comments': ['error', { terms: ['todo'], location: 'anywhere' }], // use TODO(name, YYYY-MM)
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],

      // ── imports ───────────────────────────────────────────────────────────
      'import/no-cycle': ['error', { maxDepth: 1 }],
      'import/no-default-export': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          pathGroups: [
            { pattern: '@{shared,common,infra,config}/**', group: 'internal', position: 'before' },
            { pattern: '@modules/**', group: 'internal', position: 'after' },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modules/*/*', '!@modules/*/index'],
              message: 'Import a module only through its index.ts (facade).',
            },
            {
              group: ['../../modules/**', '../../../modules/**'],
              message: 'Cross-module imports use the @modules alias.',
            },
          ],
          // project: addition 5
          paths: [
            {
              name: '@nestjs/common',
              importNames: ['Logger', 'ConsoleLogger'],
              message:
                'Inject LOGGER (@shared/logger/logger): one logger, structured (ops/logging.md §1).',
            },
          ],
        },
      ],

      // ── layer boundaries ──────────────────────────────────────────────────
      'boundaries/no-unknown': 'error',
      'boundaries/no-unknown-files': 'error',
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'entry', allow: ['*'] },
            { from: 'shared', allow: ['shared'] },
            { from: 'common', allow: ['shared', 'common', 'config'] },
            { from: 'config', allow: ['shared', 'config'] },
            { from: 'infra', allow: ['shared', 'common', 'config', 'infra', 'contracts'] },
            { from: 'domain', allow: ['shared', ['domain', { module: '${from.module}' }]] },
            { from: 'ports', allow: ['shared', ['domain', { module: '${from.module}' }]] },
            {
              from: 'app',
              allow: [
                'shared',
                'common',
                ['domain', { module: '${from.module}' }],
                ['ports', { module: '${from.module}' }],
                ['app', { module: '${from.module}' }],
                ['events', { module: '${from.module}' }],
                'modindex',
              ],
            },
            {
              from: 'features',
              allow: [
                'shared',
                'common',
                ['domain', { module: '${from.module}' }],
                ['ports', { module: '${from.module}' }],
                ['read', { module: '${from.module}' }],
                ['events', { module: '${from.module}' }],
                ['modroot', { module: '${from.module}' }],
                'modindex',
              ],
            },
            // own domain: errors and enums (query-service.md); own root: the L1 *.dto.ts and errors.ts
            {
              from: 'read',
              allow: [
                'shared',
                'common',
                'infra',
                ['domain', { module: '${from.module}' }],
                ['app', { module: '${from.module}' }],
                ['read', { module: '${from.module}' }],
                ['modroot', { module: '${from.module}' }],
                'modindex',
              ],
            },
            {
              from: 'modinfra',
              allow: [
                'shared',
                'common',
                'config',
                'infra',
                'contracts',
                ['domain', { module: '${from.module}' }],
                ['ports', { module: '${from.module}' }],
                ['modinfra', { module: '${from.module}' }],
              ],
            },
            { from: 'interface', allow: INTERFACE_ALLOW },
            // own entry classes: the consumer routes a cron tick to `job.run()` (transport/queues.md §3)
            {
              from: 'entryclass',
              allow: [
                ...INTERFACE_ALLOW,
                'contracts',
                ['interface', { module: '${from.module}' }],
                ['entryclass', { module: '${from.module}' }],
              ],
            },
            { from: 'events', allow: ['shared'] },
            { from: 'modroot', allow: MODROOT_ALLOW },
            {
              from: 'transport',
              allow: [...MODROOT_ALLOW, ['entryclass', { module: '${from.module}' }]],
            },
            {
              from: 'modindex',
              allow: [
                ['modroot', { module: '${from.module}' }],
                ['transport', { module: '${from.module}' }],
                ['read', { module: '${from.module}' }],
                ['events', { module: '${from.module}' }],
              ],
            },
          ],
        },
      ],
      'boundaries/external': [
        'error',
        {
          default: 'allow',
          rules: [
            // allow-list: domain/ imports no package at all, only @shared/* and itself (principles #4)
            { from: 'domain', disallow: ['*', '@*/*'] },
            // @prisma/*, not @prisma/client: Prisma 7 generates the client into src/infrastructure
            { from: 'ports', disallow: ['@nestjs/*', '@prisma/*', 'typeorm', 'stripe', 'openai'] },
            { from: 'app', disallow: ['@prisma/*', 'typeorm', 'stripe', 'openai', 'axios'] },
            { from: 'events', disallow: ['@nestjs/*', '@prisma/*'] },
          ],
        },
      ],
    },
  },

  // entry decorators only in their own files: @Processor on a use case would make it a consumer
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.controller.ts', 'src/**/*.consumer.ts', 'src/**/*.gateway.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...RESTRICTED_SYNTAX,
        {
          selector:
            'Decorator > CallExpression[callee.name=/^(Controller|Processor|WebSocketGateway|RabbitSubscribe)$/]',
          message:
            '@Controller/@Processor/@WebSocketGateway/@RabbitSubscribe only in *.controller|consumer|gateway.ts (principles #12).',
        },
      ],
    },
  },

  // tool configs whose loader requires a default export
  {
    files: ['*.config.{ts,mts,js,mjs}'],
    rules: { 'import/no-default-export': 'off' },
  },

  // architecture tests (test/architecture/) prove the rules above fire: testing.md §6

  // int tests assemble a slice of one module from its internals (testing.md §3)
  {
    files: ['**/*.int-spec.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // project: addition 2
  {
    files: ['test/factories/**', 'test/helpers/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['test/setup/global.ts'],
    rules: { 'import/no-default-export': 'off' },
  },

  // tests: relax size and assertion rules
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/*.int-spec.ts', '**/__test__/**', 'test/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },

  prettier,
);
