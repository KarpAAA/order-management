// Vitest globalSetup: runs ONCE per `pnpm test:e2e`, in the main process, before any file.
//  1. Postgres + Redis in Testcontainers (random ports, never the dev containers);
//  2. `test_template` = migrations (the real `prisma migrate deploy`) + test seed;
//  3. hands the server URLs to the test files; each file copies the template (db.ts).
import { execSync } from 'node:child_process';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

import { PrismaClient } from '@infra/database/generated/prisma/client';

import { seedTest } from '../seed/seed-test';

import { adminQuery, databaseUrl, TEMPLATE_DB } from './database-url';

import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18')
      // durability off: the database lives for one run, writes get much cheaper. Never in prod.
      .withCommand([
        'postgres',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
      ])
      .withTmpFs({ '/var/lib/postgresql': 'rw' })
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const serverUrl = databaseUrl(pg.getConnectionUri(), 'postgres');
  const templateUrl = databaseUrl(serverUrl, TEMPLATE_DB);
  await adminQuery(serverUrl, `CREATE DATABASE ${TEMPLATE_DB}`);

  // The same command the Docker image runs: a broken or missing migration fails here.
  // An explicit DATABASE_URL wins over .env (process.loadEnvFile never overrides).
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: templateUrl },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: templateUrl }) });
  try {
    await seedTest(prisma);
  } finally {
    // CREATE DATABASE … TEMPLATE fails while anyone is connected to the template
    await prisma.$disconnect();
  }

  project.provide('pgServerUrl', serverUrl);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}
