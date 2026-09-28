// Values global.ts hands to every test file via project.provide() / inject().
// Only strings cross the process boundary: containers and clients stay in global.ts.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Postgres server URL on its maintenance database; test files CREATE DATABASE through it. */
    pgServerUrl: string;
    redisUrl: string;
  }
}
