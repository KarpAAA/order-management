import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads .env by itself; use the Node built-in loader (a missing file is fine).
try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell or the container
}

// The CLI migrates as the owner of the tables; the service connects as `payments_app` through
// DATABASE_URL and cannot run DDL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_ADMIN_URL'),
  },
});
