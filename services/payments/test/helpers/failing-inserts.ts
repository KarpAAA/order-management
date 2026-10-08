import { testDb } from '../setup/db';

/** Fault injection: every INSERT into `table` fails inside Postgres until restore(). */
export async function failInsertsInto(table: string): Promise<() => Promise<void>> {
  await testDb().$executeRawUnsafe(`
    CREATE FUNCTION inject_failure() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected failure: %', TG_TABLE_NAME; END
    $$ LANGUAGE plpgsql`);
  await testDb().$executeRawUnsafe(
    `CREATE TRIGGER inject_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION inject_failure()`,
  );
  return async () => {
    await testDb().$executeRawUnsafe(`DROP TRIGGER inject_failure ON ${table}`);
    await testDb().$executeRawUnsafe('DROP FUNCTION inject_failure()');
  };
}
