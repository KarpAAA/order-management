// Vitest globalSetup: runs ONCE per `pnpm test:e2e`, in the main process, before any file.
//  1. Postgres, Redis and RabbitMQ in Testcontainers (random ports, never the dev containers), plus a
//     PgBouncer in front of that Postgres and a streaming replica behind it, each for the one
//     file that tests that path;
//  2. `test_template` = migrations (the real `prisma migrate deploy`) + test seed;
//  3. hands the server URLs to the test files; each file copies the template (db.ts).
import { execSync } from 'node:child_process';

import { PrismaPg } from '@prisma/adapter-pg';
import { RedisContainer } from '@testcontainers/redis';
import { Network } from 'testcontainers';

import { PrismaClient } from '@infra/database/generated/prisma/client';

import { seedTest } from '../seed/seed-test';

import { adminQuery, APP_ROLE, databaseUrl, TEMPLATE_DB } from './database-url';
import { pgBouncerUrl, startPgBouncer } from './pgbouncer';
import { startPostgres } from './postgres';
import { rabbitManagementUrl, startRabbit } from './rabbitmq';
import { replicaUrl, startReplica } from './replica';

import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const network = await new Network().start();
  const [pg, redis, rabbit, pgBouncer, replica] = await Promise.all([
    startPostgres(network),
    new RedisContainer('redis:7-alpine').start(),
    startRabbit(),
    // connects to Postgres on a client's first query, so it may start beside it
    startPgBouncer(network),
    // waits for Postgres by itself, then copies it and streams everything after
    startReplica(network),
  ]);

  const serverUrl = databaseUrl(pg.getConnectionUri(), 'postgres');
  const templateUrl = databaseUrl(serverUrl, TEMPLATE_DB);
  await adminQuery(serverUrl, `CREATE DATABASE ${TEMPLATE_DB}`);

  // The same command the Docker image runs: a broken or missing migration fails here.
  // An explicit URL wins over .env (process.loadEnvFile never overrides).
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_ADMIN_URL: templateUrl },
    stdio: 'pipe',
  });
  // The migrations create the application role without a login; the environment adds it,
  // as devtools/postgres/init does for the dev stack.
  await adminQuery(serverUrl, `ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}'`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: templateUrl }) });
  try {
    await seedTest(prisma);
  } finally {
    // CREATE DATABASE … TEMPLATE fails while anyone is connected to the template
    await prisma.$disconnect();
  }

  project.provide('pgServerUrl', serverUrl);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('rabbitUrl', rabbit.getAmqpUrl());
  project.provide('rabbitManagementUrl', rabbitManagementUrl(rabbit));
  project.provide('pgBouncerUrl', pgBouncerUrl(pgBouncer));
  project.provide('pgReplicaUrl', replicaUrl(replica, serverUrl));

  return async () => {
    await Promise.all([pgBouncer.stop(), replica.stop(), pg.stop(), redis.stop(), rabbit.stop()]);
    await network.stop();
  };
}
