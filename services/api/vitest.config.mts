// Two projects in one run (docs/requirements.md → Test levels):
//  - unit: domain, value objects, policies, use cases, adapters. No infrastructure; `pnpm test`.
//  - e2e:  integration (*.int-spec.ts) and API (*.e2e-spec.ts) tests against Testcontainers;
//          `pnpm test:e2e`. SWC emits the decorator metadata Nest DI needs.
// `.mts`: the package is CommonJS, the config is ESM (same reason as eslint.config.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const src = (dir: string): string => fileURLToPath(new URL(`./src/${dir}`, import.meta.url));

// The containers of the suite are reached over IPv4. Testcontainers says `localhost`, which
// resolves to ::1 first on some machines, where the port forwarding of Docker does not
// answer: connections hang or are reset, in the client of Prisma and in its CLI. Not set
// for a Docker that is somewhere else (DOCKER_HOST), where the host is that one.
if (!process.env.DOCKER_HOST) process.env.TESTCONTAINERS_HOST_OVERRIDE ??= '127.0.0.1';

/** Test-only environment of the e2e project; the dev .env is never read there. */
const testEnv = parseEnv(readFileSync(new URL('./.env.test', import.meta.url), 'utf8'));

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
          // + architecture tests: lint rules and the Nest process graph, no Docker (ROADMAP 1.13)
          include: ['src/**/*.spec.ts', 'test/architecture/**/*.spec.ts'],
          // process-graph.spec.ts imports the entrypoint modules, and ConfigModule.forRoot
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
          include: ['test/**/*.e2e-spec.ts', 'test/**/*.int-spec.ts'],
          environment: 'node',
          env: testEnv,
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
