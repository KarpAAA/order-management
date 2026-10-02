# 0009 — Read replica: routing by request, read-your-writes by WAL position

Date: 2026-10-02 Status: accepted

## Context

Every read and every write goes to one Postgres. A streaming replica can take the reads, but
replication is asynchronous: the primary answers `COMMIT` without waiting for the replica, so
for a moment the replica shows the past. A user who creates an order and opens the list would
not find it; a `PATCH` built on a `version` read from the replica would get a 409.

Two facts of this codebase shape the solution:

- Since ADR 0006 every tenant query is a transaction (`set_config('app.workspace_id', …, true)`
  first). `@prisma/extension-read-replicas` sends everything inside a transaction to the
  primary (`if (transaction) return query(args)` in its source), so with it no tenant read
  would ever reach a replica. It also has no notion of read-your-writes.
- The same query-service method serves a screen (`GET /products`) and a write decision
  (`getWorkspaceTerms` for an order's tax). A stale value on a screen heals on refresh; a
  stale price copied into an order is stored for good.

## Decision

- **One asynchronous hot standby** (`postgres-replica` in compose), built with
  `pg_basebackup`, no replication slot. The application reaches it as `oms_app` through its
  own PgBouncer pool (`oms_replica`), `DATABASE_REPLICA_URL`. Unset: there is no replica, and
  nothing below is active (the e2e suite, except one file).
- **The request decides, not the query.** `ReadRoutingInterceptor` allows the replica for
  `GET`/`HEAD` only. A mutating request, a worker job and anything that never asked read the
  primary: what they read ends up in a write. Query services do not choose and did not change.
- **`READ_DB` is one handle** that forwards to the replica's or the primary's tenant-scoped
  client by a flag in CLS (`ReadSource`). The replica's client has the same tenant scope and
  the same Row-Level Security frame; `set_config` is allowed in a read-only transaction.
  Writes (`txHost.tx`) and `PrismaService` (membership check, `GET /me`, `asUser` reads) stay
  on the primary.
- **Read-your-writes by WAL position, per user, in Redis.** After a mutating request, before
  the response leaves, `ryw:<userId>` = `pg_current_wal_insert_lsn()` of the primary, TTL
  `READ_YOUR_WRITES_TTL_SECONDS` (60). Before a `GET` the replica is asked
  `pg_last_wal_replay_lsn() >= <that position>`: yes → replica, no → primary. No marker →
  replica. The marker is written after a failed request too: a request can fail after its
  commit, and a 409 is exactly when the caller needs the fresh row next.
- **Fallbacks.** The position cannot be read → the marker is `pinned` and the user reads the
  primary until it expires. Redis not answering → the replica, with a warning: a stale read
  is bounded harm, every read landing on the primary is not. The replica not answering the
  check → the primary: it would not answer the read either.

## Rejected

- **Pin the writer to the primary for N seconds, no position.** The same marker without the
  check. A short N misses a longer lag; a long N keeps the writer on the primary for nothing.
  With the position the TTL can be generous and costs nothing once the replica caught up.
- **A marker per workspace.** A colleague would also see the write at once, but a busy tenant
  would read the primary almost always. A colleague's stale `version` is caught by the
  optimistic lock, and the 409 marks the caller.
- **The position kept by the client** (a header it sends back): the server would depend on
  every client doing it right.
- **`synchronous_commit = remote_apply`** for the writes that matter: the replica becomes part
  of the write path (down → commits hang), and a long read on the replica delays replay and
  with it every such commit on the primary. "The writes that matter" are nearly all of them.
- **A routing proxy (Pgpool-II, PgCat)**: one more moving part beside PgBouncer that routes by
  parsing statements, and still no read-your-writes per user.
- **A replication slot**: the primary would keep WAL for a stopped replica without limit. On a
  developer machine that fills the disk; the price is that a replica which was down for too
  long is rebuilt (`docker compose rm -sv postgres-replica` and its volume).

## Consequences

- Lists, details and polling are served by the replica; the primary keeps writes, the reads
  of mutating requests and the reads of a user who has just written
  (`docs/perf/2.8-read-replica.md`).
- A `GET` with an actor costs one Redis `GET`, and one more round trip to the replica while a
  marker exists.
- Known limits, accepted:
  - The worker leaves no marker: after a charge, `PAID` appears with the replication lag. The
    client polls anyway.
  - A lag longer than the TTL serves the writer stale rows once the marker is gone.
  - Register and login are anonymous and leave no marker; `GET /me` reads the primary for
    that reason. Other rows of a brand-new user may lag.
  - The replica being down fails the `GET`s of users without a marker; a user with one falls
    back to the primary. Health checks and failover are Step 4.
  - A long query on the replica can be cancelled by replay (`hot_standby_feedback = on`
    avoids the common case, at the price of some bloat on the primary).
- A new table needs nothing: physical replication copies roles, grants and policies.
- Tests make the lag on demand by pausing WAL replay on the standby (RPL-001…005), so a
  replica that is provably in the past is read without a sleep.
