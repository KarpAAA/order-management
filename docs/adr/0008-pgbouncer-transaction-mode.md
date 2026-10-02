# 0008 — PgBouncer in transaction mode for the application role

Date: 2026-10-02 Status: accepted

## Context

A Postgres connection is a process, and `max_connections` is 100. Every api or worker process
keeps a pool of its own (10 by default), and pools of different processes cannot lend each
other an idle connection: 10 api replicas and 3 workers already ask for 130. Since Step 2.4
every tenant query is a transaction of four statements, so a connection is held longer too.

## Decision

- **PgBouncer in `transaction` mode** between the application role and Postgres: a server
  connection belongs to a client from `BEGIN` to `COMMIT`. `session` mode would give each of
  the application's long-lived connections a server connection for good and save nothing;
  `statement` mode forbids the multi-statement transactions every tenant query now is.
- **Only `oms_app` goes through it.** The owner (`DATABASE_ADMIN_URL`: migrations, seed,
  datagen) is not in PgBouncer's user list and connects to Postgres directly: `prisma migrate`
  takes a session-level advisory lock, and long DDL does not belong in a shared pool.
- **Nothing may outlive a transaction on a connection**: no session-level `SET` or
  `set_config(…, false)`, no `pg_advisory_lock` (the `_xact_` variant is fine), no
  `LISTEN`, no temporary table kept after `COMMIT`, no SQL-level `PREPARE`. The code has none
  today; `app.workspace_id` and `app.user_id` are transaction-local (ADR 0006).
- **No Prisma flag.** `@prisma/adapter-pg` sends unnamed prepared statements as long as no
  `statementNameGenerator` is configured, and `PrismaService` configures none. The one new
  setting is `DATABASE_POOL_MAX`, the size of a process's pool.
- **Sizes of the local stack**: `max_client_conn = 500`, `default_pool_size = 20`.
- **Where it runs.** In compose it starts with the infra, and the application connects through
  it everywhere it runs for real: `pnpm dev` on the host, the containers of the `app` profile
  and the nightly contract run. The e2e suite connects to Postgres directly (a database per
  test file, and no pool to share); one int test file runs the application through a
  PgBouncer in Testcontainers (TEN-013).

## Consequences

- 500 client connections use 20 Postgres processes; throughput is the same as on direct
  connections, and a client that finds the pool busy waits instead of failing
  (`docs/perf/2.7-pgbouncer.md`).
- A session-level setting would now leak between tenants without an error: PgBouncer does not
  reset a server connection in transaction mode. The int test shows it on a pool of one.
- A transaction that waits (on a lock, or on anything outside the database) holds one of 20
  connections for everybody. The rule that adapters are never called inside a transaction
  matters more than before.
- PgBouncer's server connections count against `max_connections`: direct connections (the
  owner, a measuring script) share what is left.
- One more hop per statement, about 0.2 ms per tenant query on one host.
- One more thing to run and to watch: `SHOW POOLS` on the console database `pgbouncer`
  (user `stats` locally), `cl_waiting` being the number to alert on (Step 4).
