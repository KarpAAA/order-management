# 0002 — Composite tenant keys and a single tenant choke point

Date: 2026-09-25 Status: accepted

## Context

Every workspace is a tenant. Step 2 shards by `workspace_id` with Citus, which requires the
distribution column in every primary key, unique constraint and foreign key of a distributed
table, and later adds Row-Level Security and schema-per-tenant. Retrofitting keys on live
tables is a rewrite; scattering `where workspaceId = …` over every query makes the switch to
RLS a codebase-wide change.

## Decision

- Tenant tables (`memberships`, `products`, `orders`, `order_items`, `order_events`) have
  PK `(workspace_id, id)`; FKs between them include `workspace_id`; uniques include it
  (`(workspace_id, sku)`). `users` and `workspaces` are global (future reference tables).
- `order_events` has PK `(workspace_id, id, created_at)` so it can be range-partitioned by
  `created_at` without a key change. Not partitioned in Step 0.
- Tenant filtering lives in exactly one place: a Prisma client extension
  (`infrastructure/database/tenant-scope.extension.ts`) that adds the tenant from CLS to
  every query on a tenant model, checks writes, and throws when no tenant is bound.

## Consequences

- Loading a tenant row "by id" without its workspace is impossible by construction.
- Non-member access returns 404: the workspace guard runs before any tenant query.
- The few cross-tenant reads (membership lookup, "my workspaces") use the unscoped client
  and are listed in `docs/architecture.md` → Tenancy.
- Step 2 changes the body of one file (to `SET LOCAL` + RLS); nothing in modules changes.
  As built (ADR 0006): the extension and the transaction adapter in `infrastructure/database/`,
  plus the three documented exceptions in `identity` and the partition adapter in `orders`.
