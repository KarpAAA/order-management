# 0005 — `order_events` partitioned by month, maintained by a worker job

Date: 2026-10-01 Status: accepted

## Context

`order_events` is append-only and only grows: 7.7 M rows and 2.9 GB on the Step 2 dataset,
with one index of 1 GB. Removing old history with `DELETE` writes every row to the WAL and
leaves the files as large as before. The key `(workspace_id, id, created_at)` was prepared for
range partitioning in ADR 0002, and no table references `order_events`.

## Decision

- `PARTITION BY RANGE (created_at)`, one partition per calendar month in UTC, named
  `order_events_YYYY_MM`. Hand-written SQL; the Prisma model stays an ordinary table.
- **No DEFAULT partition.** A month without a partition rejects the write (and, because the
  event is written in the order's transaction, the whole order change). A DEFAULT partition
  would hide a broken job and later block the creation of the proper partition.
- Partitions are created by a **BullMQ job scheduler** on the `orders` queue
  (`maintain-order-event-partitions`, daily at 03:00 UTC and once at every worker boot), not
  by `pg_partman`: the worker and Redis already exist, and the stock `postgres:18` image has
  no extension to install in compose, Testcontainers and CI.
- The job keeps `ORDER_EVENTS_PARTITIONS_AHEAD` (3) months ready, so it has to fail for months
  before a write is at risk; it fails loudly when a required month is still missing.
- **Retention is off by default** (`ORDER_EVENTS_RETENTION_MONTHS=0`). The history is shown to
  users through `GET /orders/{id}/events`; dropping it is a product decision per deployment.
  When set, old months are detached `CONCURRENTLY` and dropped.
- The history query bounds `created_at` by the order's `created_at … updated_at` (± 1 h for
  clock skew between api and worker), because `order_id` alone gives the planner nothing to
  prune by.
- Rejected: hash partitioning by `order_id` (one partition per lookup, but no retention by
  month); range partitioning by `order_id` (UUIDv7 carries the time, so one partition per
  lookup and retention both work, but it changes the key of ADR 0002 and ties the schema to
  v7 ids).

## Consequences

- Retention and archiving work on whole partitions: `DROP` in milliseconds, space returned.
- Inserts touch only the indexes of the current month, not one 1 GB index.
- A query on `order_events` without a `created_at` range probes every partition: 84 pages
  instead of 5 for one order's history, and planning time grows with the number of partitions.
- An event dated outside the months that have a partition cannot be written. Scripts that
  write old dates (datagen, a test) create the partition themselves.
- The job runs DDL as the application's database user, which owns the tables. Step 2.4 (RLS,
  the app role is no longer the owner) needs a separate owner connection for maintenance.
- Numbers: `docs/perf/2.3-partitioning.md`.
