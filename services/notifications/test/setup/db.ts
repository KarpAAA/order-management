// Vitest setupFiles for the e2e project: runs inside EVERY test file.
// The file gets its own database, copied from the migrated template, and its own RabbitMQ
// vhost, so files run in parallel and never share rows or messages. The mail server is shared.
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, inject } from 'vitest';

import { PrismaClient } from '@infra/database/generated/prisma/client';

import { adminQuery, appRoleUrl, databaseUrl, TEMPLATE_DB } from './database-url';
import { createVhost, dropVhost } from './rabbitmq';

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
  // the service under test boots against this database as the application role, like production
  process.env.DATABASE_URL = appRoleUrl(url);
  process.env.RABBITMQ_URL = await createVhost(
    inject('rabbitManagementUrl'),
    inject('rabbitUrl'),
    dbName,
  );
  // one mail server for the run: a test tells its mails apart by their recipient
  process.env.SMTP_HOST = inject('smtpHost');
  process.env.SMTP_PORT = String(inject('smtpPort'));
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbName) {
    await dropVhost(inject('rabbitManagementUrl'), dbName);
    // FORCE: a closing app's pool may still hold a connection for a moment
    await adminQuery(inject('pgServerUrl'), `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  }
});

/** The file's database as its owner: for assertions, never for the service itself. */
export function testDb(): PrismaClient {
  if (!prisma) throw new Error('testDb() is available from beforeAll on (test/setup/db.ts)');
  return prisma;
}
