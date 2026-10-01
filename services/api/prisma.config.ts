import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads .env by itself; use the Node built-in loader (a missing file is fine).
try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell or the container
}

// The CLI migrates as the owner of the tables; the application connects as `oms_app` through
// DATABASE_URL and cannot run DDL (docs/adr/0006-row-level-security.md).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_ADMIN_URL'),
  },
});
