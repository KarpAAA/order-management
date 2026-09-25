// Reproduced from nest-conventions/templates/eslint.config.js.
// Project adjustments (each also listed in CLAUDE.md → "Deviations from the templates"):
//  1. `.mjs`: the package is CommonJS, the config uses ESM imports.
//  2. `entry` element for src/entrypoints (process roots: may import anything).
//  3. `interface` and `read` may import their own module's `domain`; `read` of a level-1
//     module may import its module root (errors.ts, *.dto.ts live there at L1) — DTOs use the domain
//     enums and limits (http/dto-validation.md §3 requires it; the template forgot it).
//  4. `max-params` is replaced by two selectors: 4 for functions, 6 for constructors
//     (Nest DI constructors; code-style.md §2 allows ≤ 6 dependencies).
//  5. eslint-plugin-boundaries pinned to 5.x: the template uses its API (mode, element-types).
//  6. Prisma-generated client and the prisma/ scripts are outside the layer map.
import boundaries from 'eslint-plugin-boundaries';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-worker/**',
      'node_modules/**',
      'prisma/migrations/**',
      'src/infrastructure/database/generated/**',
      'eslint.config.mjs',
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
        { type: 'entry', pattern: 'src/entrypoints/**' },
        { type: 'shared', pattern: 'src/shared/**' },
        { type: 'common', pattern: 'src/common/**' },
        { type: 'config', pattern: 'src/config/**' },
        { type: 'infra', pattern: 'src/infrastructure/**' },
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
      'boundaries/ignore': ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**', 'prisma/**', '*.ts'],
    },

    rules: {
      // ── types ─────────────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }], // Nest modules
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

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
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='queryRawUnsafe']",
          message: 'Use $queryRaw tagged template.',
        },
        {
          selector:
            ":function[params.length>4]:not(MethodDefinition[kind='constructor'] > FunctionExpression)",
          message: 'At most 4 parameters; the fifth becomes an options object (code-style.md §2).',
        },
        {
          selector: "MethodDefinition[kind='constructor'] > FunctionExpression[params.length>6]",
          message: 'At most 6 constructor dependencies; split the class (code-style.md §2).',
        },
      ],

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
            { from: 'infra', allow: ['shared', 'common', 'config', 'infra'] },
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
            {
              from: 'read',
              allow: [
                'shared',
                'common',
                'infra',
                ['domain', { module: '${from.module}' }],
                ['modroot', { module: '${from.module}' }],
                ['app', { module: '${from.module}' }],
                ['read', { module: '${from.module}' }],
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
                ['domain', { module: '${from.module}' }],
                ['ports', { module: '${from.module}' }],
                ['modinfra', { module: '${from.module}' }],
              ],
            },
            {
              from: 'interface',
              allow: [
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
              ],
            },
            { from: 'events', allow: ['shared'] },
            {
              from: 'modroot',
              allow: [
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
                ['interface', { module: '${from.module}' }],
                ['events', { module: '${from.module}' }],
                ['modroot', { module: '${from.module}' }],
                'modindex',
              ],
            },
            {
              from: 'modindex',
              allow: [
                ['modroot', { module: '${from.module}' }],
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
            {
              from: 'domain',
              disallow: [
                '@nestjs/*',
                '@prisma/client',
                'typeorm',
                'class-validator',
                'class-transformer',
                'axios',
                'stripe',
                'openai',
              ],
            },
            {
              from: 'ports',
              disallow: ['@nestjs/*', '@prisma/client', 'typeorm', 'stripe', 'openai'],
            },
            { from: 'app', disallow: ['@prisma/client', 'typeorm', 'stripe', 'openai', 'axios'] },
            { from: 'events', disallow: ['@nestjs/*', '@prisma/client'] },
          ],
        },
      ],
    },
  },

  // Prisma CLI requires a default export from its config file
  { files: ['prisma.config.ts'], rules: { 'import/no-default-export': 'off' } },

  // tests: relax size and assertion rules
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },

  prettier,
);
