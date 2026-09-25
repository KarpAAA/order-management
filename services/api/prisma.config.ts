import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads .env by itself; use the Node built-in loader (a missing file is fine).
try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell or the container
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
