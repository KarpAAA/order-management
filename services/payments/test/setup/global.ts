// Vitest globalSetup: runs ONCE per `pnpm test:e2e`, in the main process, before any file.
//  1. Postgres and RabbitMQ in Testcontainers (random ports, never the dev containers);
//  2. `test_template` = the migrations (the real `prisma migrate deploy`);
//  3. hands the server URLs to the test files; each file copies the template (db.ts).
import { execSync } from 'node:child_process';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { adminQuery, APP_ROLE, databaseUrl, TEMPLATE_DB } from './database-url';
import { rabbitManagementUrl, startRabbit } from './rabbitmq';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return (
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
      .start()
  );
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, rabbit] = await Promise.all([startPostgres(), startRabbit()]);

  const serverUrl = databaseUrl(pg.getConnectionUri(), 'postgres');
  await adminQuery(serverUrl, `CREATE DATABASE ${TEMPLATE_DB}`);

  // The same command the Docker image runs: a broken or missing migration fails here.
  // An explicit URL wins over .env (process.loadEnvFile never overrides).
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_ADMIN_URL: databaseUrl(serverUrl, TEMPLATE_DB) },
    stdio: 'pipe',
  });
  // The migration creates the application role without a login; the environment adds it,
  // as devtools/postgres-payments/init does for the dev stack.
  await adminQuery(serverUrl, `ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}'`);

  project.provide('pgServerUrl', serverUrl);
  project.provide('rabbitUrl', rabbit.getAmqpUrl());
  project.provide('rabbitManagementUrl', rabbitManagementUrl(rabbit));

  return async () => {
    await Promise.all([pg.stop(), rabbit.stop()]);
  };
}
