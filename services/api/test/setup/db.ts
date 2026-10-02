// Vitest setupFiles for the e2e project: runs inside EVERY test file.
// The file gets its own database, copied from the migrated + seeded template, so files run
// in parallel and never share rows. Inside a file tests run in order and may build on each
// other; call truncateAll() between `describe`s when one needs a clean slate.
import { randomUUID } from 'node:crypto';

import { faker } from '@faker-js/faker';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, inject } from 'vitest';

import { PrismaClient } from '@infra/database/generated/prisma/client';

import { seedTest } from '../seed/seed-test';

import { adminQuery, appRoleUrl, databaseUrl, TEMPLATE_DB } from './database-url';

let prisma: PrismaClient | undefined;
let dbName: string | undefined;

beforeAll(async () => {
  const serverUrl = inject('pgServerUrl');
  dbName = `test_${randomUUID().replaceAll('-', '')}`;
  // FILE_COPY: a plain file copy, faster than the default WAL_LOG for a small template
  await adminQuery(
    serverUrl,
    `CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB} STRATEGY FILE_COPY`,
  );

  const url = databaseUrl(serverUrl, dbName);
  // the app under test boots against this database as the application role, like production
  process.env.DATABASE_URL = appRoleUrl(url);
  process.env.REDIS_URL = inject('redisUrl');
  // own BullMQ namespace too: a worker in one file never takes the jobs of another
  process.env.QUEUE_PREFIX = dbName;
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  faker.seed(20260928); // generated values repeat from run to run: a failure reproduces
});

afterAll(async () => {
  await prisma?.$disconnect();
  // FORCE: a closing app's pool (e.g. a worker's) may still hold a connection for a moment
  if (dbName)
    await adminQuery(inject('pgServerUrl'), `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

/**
 * The file's database as its owner, WITHOUT tenant scoping or Row-Level Security — for
 * factories and assertions, like prisma/seed.ts. The app itself goes through the scoped
 * client, as the application role.
 */
export function testDb(): PrismaClient {
  if (!prisma) throw new Error('testDb() is available from beforeAll on (test/setup/db.ts)');
  return prisma;
}

/** Empties every table and re-inserts the test seed. Between `describe`s, not every test. */
export async function truncateAll(): Promise<void> {
  const db = testDb();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
  await seedTest(db);
}
