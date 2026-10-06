// Two projects in one run, as in services/api:
//  - unit: adapters against MSW, policy, env, architecture. No infrastructure; `pnpm test`.
//  - e2e:  the service to its boundary (*.e2e-spec.ts) against Testcontainers: a command goes
//          in through RabbitMQ, a row and an event come out; `pnpm test:e2e`.
//          SWC emits the decorator metadata Nest DI needs.
// `.mts`: the package is CommonJS, the config is ESM (same reason as eslint.config.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const src = (dir: string): string => fileURLToPath(new URL(`./src/${dir}`, import.meta.url));

/** Test-only environment; the dev .env is never read there. */
const testEnv = parseEnv(readFileSync(new URL('./.env.test', import.meta.url), 'utf8'));

export default defineConfig({
  resolve: {
    // mirrors compilerOptions.paths in tsconfig.json
    alias: {
      '@config': src('config'),
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
          include: ['src/**/*.spec.ts', 'test/architecture/**/*.spec.ts'],
          // process-graph.spec.ts imports the entrypoint module, and ConfigModule.forRoot
          // validates the env on import; nothing connects, the placeholders are enough
          env: testEnv,
          environment: 'node',
        },
      },
      {
        extends: true,
        plugins: [swc.vite()],
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          environment: 'node',
          env: testEnv,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // once per run: containers + migrated test_template
          globalSetup: ['test/setup/global.ts'],
          // once per file: a copy of the template and a vhost of its own
          setupFiles: ['test/setup/db.ts'],
        },
      },
    ],
  },
});
