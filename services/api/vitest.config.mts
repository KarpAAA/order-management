// Two projects in one run (docs/requirements.md → Test levels):
//  - unit: domain, value objects, policies, adapters against MSW. No infrastructure; `pnpm test`.
//  - e2e:  integration (*.int-spec.ts) and API (*.e2e-spec.ts) tests against Testcontainers;
//          `pnpm test:e2e`. SWC emits the decorator metadata Nest DI needs.
// `.mts`: the package is CommonJS, the config is ESM (same reason as eslint.config.mjs).
import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const src = (dir: string): string => fileURLToPath(new URL(`./src/${dir}`, import.meta.url));

export default defineConfig({
  resolve: {
    // mirrors compilerOptions.paths in tsconfig.json
    alias: {
      '@config': src('config'),
      '@common': src('common'),
      '@shared': src('shared'),
      '@infra': src('infrastructure'),
      '@modules': src('modules'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        plugins: [swc.vite()],
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts', 'test/**/*.int-spec.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // once per run: containers + migrated, seeded test_template
          globalSetup: ['test/setup/global.ts'],
          // once per file: a copy of the template as the file's own database
          setupFiles: ['test/setup/db.ts'],
        },
      },
    ],
  },
});
