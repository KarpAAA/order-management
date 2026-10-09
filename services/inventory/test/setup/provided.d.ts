// Values global.ts hands to every test file via project.provide() / inject().
// Only strings cross the process boundary: containers and clients stay in global.ts.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Postgres server URL on its maintenance database; test files CREATE DATABASE through it. */
    pgServerUrl: string;
    /** The broker on its default vhost; test files connect to a vhost of their own. */
    rabbitUrl: string;
    /** The broker's management API: test files create and drop their vhost through it. */
    rabbitManagementUrl: string;
  }
}
