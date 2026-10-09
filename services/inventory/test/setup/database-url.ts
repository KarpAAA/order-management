import { Client } from 'pg';

/** Migrated once per run (global.ts); every test file gets a copy (db.ts). */
export const TEMPLATE_DB = 'test_template';

/** The role the service under test connects as: no ownership, no DDL. */
export const APP_ROLE = 'inventory_app';

/** The same server, another database: `postgres://u:p@host:port/<name>`. */
export function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The same database as the application role (its password is its name, set in global.ts). */
export function appRoleUrl(url: string): string {
  const appUrl = new URL(url);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_ROLE;
  return appUrl.toString();
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
