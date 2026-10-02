# 0007 — One tenancy mode: shared tables with Row-Level Security

Date: 2026-10-02 Status: accepted

## Context

The roadmap listed three tenancy modes to build one after another: shared tables with
Row-Level Security (2.4, ADR 0006), a schema per tenant (2.5) and a database per tenant (2.6).
A system is designed around one of them; the other two were to live on side branches for the
sake of their numbers. Building them means a strategy switch in the data layer, a migration
runner for N schemas and a client router, none of which the main line would keep.

## Decision

- The project stays on **shared tables + Row-Level Security**. Modes 2 and 3 are compared
  below and not built; no strategy switch enters the code.
- Why mode 1 fits here: the dataset is a few large tenants and many small ones (the small ones
  are where per-tenant objects cost most); the composite keys of ADR 0002 lead to Citus (2.11),
  which distributes shared tables; `order_events` is partitioned by month, and per-tenant
  schemas would multiply every partition by the number of tenants; "my workspaces" reads
  across tenants in one query (`own_memberships`).

|                                | 1. Shared tables + RLS         | 2. Schema per tenant                       | 3. Database per tenant                |
| ------------------------------ | ------------------------------ | ------------------------------------------ | ------------------------------------- |
| Isolation rests on             | a predicate in a policy        | name resolution (`search_path`)            | the connection                        |
| A bug in the code gives        | an empty result                | "relation does not exist"                  | the data is not reachable at all      |
| Weakest point                  | a new table without a policy   | a session-level `SET` leaking through pool | a wrong client taken from the cache   |
| Migration                      | once                           | N times, own runner                        | N times, the standard tool            |
| Tenants on different versions  | impossible                     | possible                                   | possible                              |
| Connections                    | one pool                       | one pool, if the ORM leaves names bare     | a pool per tenant                     |
| PgBouncer, transaction mode    | fits                           | fits with `SET LOCAL`                      | a pool per database, little is shared |
| Postgres catalog               | constant                       | grows with every tenant                    | a full catalog per tenant             |
| A query across tenants         | plain SQL                      | `UNION` over schemas                       | in application code only              |
| Remove a tenant                | `DELETE` of its rows           | `DROP SCHEMA`                              | `DROP DATABASE`                       |
| Backup / restore of one tenant | by hand                        | `pg_dump -n`                               | `pg_dump` of the database             |
| Noisy neighbour                | shared indexes, vacuum, cache  | own tables, shared server                  | can move to its own server            |
| Sharding with Citus (2.11)     | the natural next step          | does not combine                           | not needed: the databases are shards  |
| Tenants it carries             | tens of thousands and more     | hundreds to low thousands                  | tens to hundreds                      |
| Typical use                    | SaaS with many small customers | B2B, per-customer backup required          | enterprise, data residency            |

The table is from the documentation and common practice, not measured on this project's data:
the catalog size at 1000 schemas, the migration time over N schemas and the connection limit
of mode 3 were the experiments of 2.5 and 2.6.

## Consequences

- `docs/ROADMAP.md` marks 2.5 and 2.6 as covered in theory; Step 2 continues with 2.7.
- A hybrid stays possible later without a rewrite: most tenants on shared tables, one large
  customer on a database of its own. That is connection routing on top of mode 1, added when
  such a customer exists.
- With Prisma, mode 2 would first need an answer to whether the generated SQL qualifies table
  names with the schema: if it does, `search_path` is ignored and mode 2 needs a client per
  tenant, with the connection cost of mode 3. Not verified.
