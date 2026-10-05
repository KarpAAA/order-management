// Values global.ts hands to every test file via project.provide() / inject().
// Only strings cross the process boundary: containers and clients stay in global.ts.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Postgres server URL on its maintenance database; test files CREATE DATABASE through it. */
    pgServerUrl: string;
    redisUrl: string;
    /** The same server through PgBouncer (transaction mode), as the application role. */
    pgBouncerUrl: string;
    /** A hot standby of the same server, on its maintenance database, as the superuser. */
    pgReplicaUrl: string;
  }
}
