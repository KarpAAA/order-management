// The type, async and import rules of services/api/eslint.config.mjs, without its layer map: this
// package has no layers. Its own rule is the opposite of a layer map: the package stays thin.
// `src/` may import `zod` (the only entry in `dependencies`) and its own files, nothing else: no
// Node built-ins, no service code, no helpers. Every service depends on this package, so whatever
// lands here is coupled to all of them (docs/adr/0011-message-contracts.md).
// `.mjs`: the package is CommonJS, and this config uses ESM imports and import.meta.

import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // eslint.config.mjs: outside the tsconfig program, so type-aware parsing cannot load it
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },

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
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // ── the package stays thin ────────────────────────────────────────────
      'import/no-nodejs-modules': 'error',
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, optionalDependencies: false, peerDependencies: false },
      ],
    },
  },

  // tests and the tool config use vitest, a devDependency
  {
    files: ['**/*.spec.ts', '*.config.{ts,mts,js,mjs}'],
    rules: {
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'import/no-default-export': 'off',
    },
  },

  prettier,
);
