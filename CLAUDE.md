# order-management

Multi-tenant order management backend, built step by step as a learning project.
Current step: **Step 3: microservices and brokers** (see `docs/ROADMAP.md`; Step 0 foundation: `docs/architecture.md`).
The roadmap runs in two passes: Step 2 closed at 2.9, and 2.10–2.12, Kafka (3.8, 3.9, 3.14) and
the other deferred items wait in `docs/ROADMAP.md` → «Другий прохід». Do not build a deferred
item unless asked.

## Conventions

Rules in `.claude/rules/shared/` are shared across my Nest projects (symlink to
`C:\Users\ikarp\WebstormProjects\nest-conventions\rules`, created by its `link.ps1`). Do not
edit them here: tell me and I change them in the conventions repo. Project-specific
deviations go in `.claude/rules/project/` only.
Full architecture reference: `C:\Users\ikarp\WebstormProjects\nest-conventions\docs\architecture-full.md`
(read it when creating a module or unsure about a level).

## Project decisions

```
role-scope: contextual          # roles are per workspace (Membership), never on the actor
role-source: db                 # membership loaded per request by WorkspaceAccessGuard
authz: rbac
write-forbidden-status: 403     # member without permission → 403; NON-member → 404 always
refresh: none                   # never in this project: access token only
pii-encryption: no
ids: uuid7
cross-module-fk: yes            # identity/catalog/orders stay together in api, also in Step 3
transactions: cls
outbox: no                      # Step 0; Step 3 adds reliable events + outbox
queue: bullmq
processes: api+worker
dlq: alert                      # dead job → Logger.error in OrdersConsumer (Step 4: metric)
cron: bullmq                    # job schedulers on the module's queue; first: maintain-order-event-partitions
validation: class-validator
swagger-prod: off
async-push: poll
logs: stdout                    # Nest built-in Logger in Step 0; pino in Step 4
traces: none
metrics-endpoint: none          # Step 4
tracker: none
merge: merge-commit
testing: vitest                 # projects unit + e2e; test levels per requirement in docs/requirements.md
ci: github-actions              # PR + main: static, unit, e2e, migrations, audit; PR: commits; main + nightly: mutation, contract
hooks: husky                    # pre-commit: lint-staged; commit-msg: commitlint + no AI trailers; pre-push: typecheck + unit
```

## Stack

NestJS 12.1, Prisma 7.10 (+ `@prisma/adapter-pg`), PostgreSQL 18, Redis 7, BullMQ 6,
Node 24 LTS, TypeScript 6.0, pnpm 10 (workspaces)

## Commands (CMD-friendly, from the repo root)

```
pnpm infra:up          # postgres, postgres-replica, pgbouncer, redis, fake-psp (healthy)
pnpm db:migrate        # prisma migrate dev
pnpm db:seed           # fixed-id dev data (README → Seeded data)
pnpm db:reset          # drop, migrate, seed
pnpm db:datagen        # Step 2 volume data after db:reset: 100 tenants, 2M orders (--scale smoke)
pnpm db:explain        # plans of the list queries on the datagen data (docs/perf/2.2-indexes-explain.md)
pnpm db:explain:partitions   # order_events pruning, DROP vs DELETE (docs/perf/2.3-partitioning.md)
pnpm db:explain:rls    # what oms_app sees, plans under the RLS policy (docs/perf/2.4-rls.md)
pnpm db:explain:pgbouncer    # 500 clients on 20 server connections, limits, the leak (docs/perf/2.7-pgbouncer.md)
pnpm db:explain:replica      # replication lag, read-your-writes with a 5 s delay (docs/perf/2.8-read-replica.md)
pnpm db:explain:cache        # catalog cache: hit vs database, hit ratio, 200 callers on an empty key (docs/perf/2.9-cache.md)
pnpm dev               # api + worker in watch mode
pnpm lint && pnpm typecheck
pnpm test              # Vitest project unit: domain, VOs, policies, use cases, adapters (MSW), architecture (no Docker)
pnpm test:e2e          # Vitest project e2e: *.int-spec.ts + *.e2e-spec.ts (Testcontainers)
pnpm test:contract     # Schemathesis vs /docs-json in compose project oms-contract (devtools/contract)
pnpm test:migrations   # guard + fresh + drift (migrate diff) + upgrade on base seed (Testcontainers)
pnpm test:mutation     # Stryker on orders domain/ + application/ + money.ts; report only (reports/mutation)
docker compose --profile app up --build   # migrate + api + worker from one image
```

New migration: `pnpm --filter @oms/api exec prisma migrate dev --name <verb>_<object>`.

## Modules and their combinations

<!-- keep in sync with the first line of each *.module.ts -->

| Module   | Folders        | Level | Read/write     | Transports   |
| -------- | -------------- | ----- | -------------- | ------------ |
| identity | layered (flat) | L1    | CQS            | http         |
| catalog  | layered (flat) | L1    | CQS            | http         |
| orders   | layered        | L4    | CQS + EventBus | http, worker |

Process model: `src/entrypoints/main.api.ts` + `main.worker.ts`, one image.

## Gotchas specific to this project

- **Tenant scoping has one choke point**: `src/infrastructure/database/tenant-scope.extension.ts`.
  Tenant models (Membership, Product, Order, OrderItem, OrderEvent) are filtered by the
  workspace in CLS; a query without a tenant throws. Never inject `PrismaService` for tenant
  data: its only users are the extension, identity's documented cross-tenant reads
  (`asUser`), and the partition adapter in orders (table structure, no tenant rows).
- **Row-Level Security is the second layer** (ADR 0006). Two database roles: `DATABASE_URL` is
  `oms_app` (api + worker: owns nothing, sees only rows of `app.workspace_id`),
  `DATABASE_ADMIN_URL` is the owner (Prisma CLI, seed, datagen, `testDb()` in tests; not in
  `env.schema.ts`). `app.workspace_id` is transaction-local and set in two places only:
  `transactional.adapter.ts` (first statement of `@Transactional()`) and the extension (wraps
  a query outside a transaction). Consequences:
  - bind the tenant BEFORE the transaction begins; bound later, the database stays closed;
  - the scoped root client (`READ_DB`) used inside `@Transactional()` runs on another
    connection and does not see that transaction's writes: use `txHost.tx` there;
  - raw SQL or the unscoped client on a tenant table returns nothing without `set_config`;
  - a new table needs `GRANT … TO oms_app` in its migration, and with a `workspace_id` also
    `ENABLE ROW LEVEL SECURITY` + the `tenant_isolation` policy (`migrate diff` sees neither;
    `test/tenancy/row-level-security.int-spec.ts` fails without them);
  - the app cannot run DDL: partitions go through `create_/drop_order_events_partition()`.
- **PgBouncer in transaction mode sits in front of `oms_app`** (ADR 0008; `pnpm dev`, the
  compose `app` profile and the nightly contract run; the e2e suite connects directly). A server
  connection serves another client after every `COMMIT`, so nothing may outlive a transaction
  on it: no session-level `SET` / `set_config(…, false)`, no `pg_advisory_lock` (use
  `pg_advisory_xact_lock`), no `LISTEN`, no `statementNameGenerator` on `PrismaPg`. A
  session-level tenant setting would leak to the next tenant without an error
  (`test/tenancy/pgbouncer.int-spec.ts`). The owner URL never points at PgBouncer.
- **`READ_DB` may be the read replica** (ADR 0009; `DATABASE_REPLICA_URL`, unset in the e2e
  suite except `test/replica/read-replica.e2e-spec.ts`). The request decides, never the query:
  `ReadRoutingInterceptor` allows the replica for `GET` only, and only once the replica has
  replayed the caller's last write (its WAL position, `ryw:<userId>` in Redis). Consequences:
  - a query service keeps using `READ_DB` and never chooses a server; a read that a write
    depends on is safe because it runs in a mutating request or a job, which read the primary;
  - a `GET` handler must not write, and a row written by the worker or by another user shows
    up in a `GET` only after the replication lag;
  - `PrismaService` and `txHost.tx` are always the primary; `GET /me` uses `PrismaService`
    because register and login are anonymous and leave no marker;
  - the replica is read-only and a copy of everything, roles and policies included: nothing is
    migrated or granted there.
- **The catalog's `get` and `list` are cached in Redis** (ADR 0010; `RedisCache`, keys in
  `catalog/catalog-cache.ts`, TTL `CATALOG_CACHE_TTL_SECONDS`, 0 = off). Consequences:
  - Redis knows no tenant: the workspace is part of the namespace, and a key is built in
    `catalog-cache.ts` only;
  - every write of `CatalogService` ends with `cache.invalidate(catalogNamespace(…))`, after
    its row is committed; a new write path that forgets it serves the old row for the TTL;
  - a write past the API (seed, datagen, `psql`, `testDb()` in a test) invalidates nothing: a
    test that changes a product it has already read through the API goes through the API;
  - a fill reads the primary (`ReadSource.requirePrimary`): on the replica it would store a
    row from before the change for everyone (`test/replica`, CCH-006);
  - `findSnapshots` is never cached: its price is copied into an order;
  - `CACHE_PREFIX` namespaces every cache key; the e2e suite gives each file its own.
- **`order_events` is partitioned by month** (`created_at`, UTC, no DEFAULT partition): an
  event dated in a month without a partition fails the whole write. The migration creates the
  months around its run; the worker job `maintain-order-event-partitions` (boot + daily) keeps
  `ORDER_EVENTS_PARTITIONS_AHEAD` months ready; `db:datagen` creates its own window. A test or
  script that writes events with a far date creates the partition first (`createPartitionSql`,
  as the owner).
  Retention is off by default (`ORDER_EVENTS_RETENTION_MONTHS=0`).
- A query on `order_events` without a `created_at` range probes every partition: bound it,
  as `OrdersQueryService.listEvents` does with the order's `createdAt … updatedAt`.
- Workspace routes use `@WorkspaceScoped()` (membership guard → 404 for non-members) and their
  HTTP module must import `IdentityModule` (it provides `MEMBERSHIP_READER`).
- Invalid state transitions are `InvalidStateError` → **422** (conventions), not 409.
  409 = stale `version` or duplicate.
- Enqueue after commit is NOT atomic with the commit (Known gap → Step 3 outbox). Do not
  "fix" it with the outbox before Step 3.
- BullMQ 6 rejects `:` in custom job ids → `charge-<orderId>-<attempt>`.
- `@nestjs-cls/transactional-adapter-prisma` types clash with `exactOptionalPropertyTypes`;
  the host is typed via `DbTransactionAdapter` (see `database.tokens.ts`).
- Money in JSON is `{ amountMinor, currency }`; inside the code it is `bigint` (`Money` VO).

## Deviations from the conventions templates

- `eslint.config.mjs` is the template plus two additions: the generated Prisma client,
  `prisma/` and root tool files are outside the layer map; `test/factories`, `test/doubles`
  and `test/helpers` may import module internals. Details at the top of the file.
- Module core exports include the use cases and query services, for the module's own
  transport modules (Nest needs them exported to inject them into controllers/consumers).
  Orders also exports `OrdersQueue`: its worker module registers the cron scheduler on it.
- `MaintainOrderEventPartitionsService` is a use case with no `@Transactional()` and no domain
  object: partition DDL runs month by month. Its adapter calls two `SECURITY DEFINER`
  functions with two integers; the functions build the identifiers and bounds.
- `createWorkspace` has no `@Transactional()` decorator: it binds the new workspace as the
  tenant first (`runInWorkspace`) and opens the transaction inside, so Row-Level Security
  accepts the OWNER membership.
- `tenant-scope.extension.ts` reads Prisma's `__internalParams.transaction` (not public API)
  to tell a query inside a transaction from one outside; `tenant-scope.int-spec.ts` guards it.
- The N+1 guard (`countQueries`) counts data statements: `BEGIN`, `set_config` and `COMMIT`
  around a tenant query are not counted.
- The migration that partitions `order_events` copies the rows inside the migration
  (`migrations.md` §5 asks for a backfill job above ~100 k rows): the table is only that large
  in a regenerable datagen database. The production-size alternative is noted in the migration.
- Stryker also mutates `src/shared/domain/money.ts`, runs a unit-only vitest config, and the
  vitest runner is patched for Vitest 5. Details: `.claude/rules/project/testing.md`.
- `pnpm audit` exceptions live in `package.json` → `pnpm.auditConfig`, the reason next to the
  `overrides` in `pnpm-workspace.yaml` (JSON has no comments).
- No `docs-json` diff in CI yet (`git-pr.md` §5): the nightly Schemathesis run checks the API
  against its own OpenAPI document; a committed `openapi.json` diff comes when a client does.
- `tsconfig.json` sets `strictPropertyInitialization: false`: DTO classes are filled by
  class-transformer and Nest, never by a constructor.
- `register` and `login` take no `Actor` (the caller is anonymous); `createWorkspace` has no
  policy call, because any signed-in user may create one (`principles.md` §2.2).
- `SchedulePaymentChargeHandler` calls the scheduler port, not a use case (`events.md` §3): it
  only enqueues, and the Step 3 outbox replaces it.
- Orders has a repository port although Postgres is the only implementation
  (`architecture.md` §4): it lets the use-case unit tests run on the in-memory repository in
  `application/__test__/`. Details: `.claude/rules/project/testing.md`.
- `DiscountInputDto` fields carry no `@ApiProperty`: the OpenAPI shape of `discount` is the
  `oneOf` of the `Discount*Dto` doc models (`order-input.dto.ts`).
- `/workspaces/{id}` is the tenant prefix and does not count as a nesting level, so
  `/workspaces/{id}/orders/{orderId}/events` is one level deep (`api-conventions.md` §1).
