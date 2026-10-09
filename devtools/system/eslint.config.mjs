// The type, async and import rules of services/api/eslint.config.mjs, without its layer map:
// this package has no layers and no source of its own, only tests. Its one rule is in
// package.json: no dependency on a service or on @oms/contracts. A system test knows what a
// client and an operator know (docs/adr/0022-system-tests.md).

import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // eslint.config.mjs: outside the tsconfig program, so type-aware parsing cannot load it
  { ignores: ['node_modules/**', 'reports/**', 'eslint.config.mjs'] },

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.json' } },
    },

    rules: {
      // ── types ─────────────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // ── hygiene ───────────────────────────────────────────────────────────
      'no-console': 'error',
      'no-warning-comments': ['error', { terms: ['todo'], location: 'anywhere' }],

      // ── imports ───────────────────────────────────────────────────────────
      'import/no-cycle': ['error', { maxDepth: 1 }],
      'import/no-default-export': 'error',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // vitest asks for a default export of its config and of its global setup
  {
    files: ['vitest.config.ts', 'test/setup/global.ts'],
    rules: { 'import/no-default-export': 'off' },
  },

  prettier,
);
