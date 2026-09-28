import { Client } from 'pg';

/** Migrated and seeded once per run (global.ts); every test file gets a copy (db.ts). */
export const TEMPLATE_DB = 'test_template';

/** The same server, another database: `postgres://u:p@host:port/<name>`. */
export function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** One statement on the server's maintenance connection (CREATE / DROP DATABASE). */
export async function adminQuery(serverUrl: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
