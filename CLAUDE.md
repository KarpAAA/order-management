# order-management

Multi-tenant order management backend, built step by step as a learning project.
Current step: **Step 1: testing** (see `docs/ROADMAP.md`; Step 0 foundation: `docs/architecture.md`).

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
pnpm infra:up          # postgres, redis, fake-psp (healthy)
pnpm db:migrate        # prisma migrate dev
pnpm db:seed           # fixed-id dev data (README → Seeded data)
pnpm db:reset          # drop, migrate, seed
pnpm db:datagen        # Step 2 volume data after db:reset: 100 tenants, 2M orders (--scale smoke)
pnpm db:explain        # plans of the list queries on the datagen data (docs/perf/2.2-indexes-explain.md)
pnpm db:explain:partitions   # order_events pruning, DROP vs DELETE (docs/perf/2.3-partitioning.md)
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
  data: its only users are the extension, identity's documented cross-tenant reads, and the
  partition DDL adapter in orders (table structure, no tenant rows).
- **`order_events` is partitioned by month** (`created_at`, UTC, no DEFAULT partition): an
  event dated in a month without a partition fails the whole write. The migration creates the
  months around its run; the worker job `maintain-order-event-partitions` (boot + daily) keeps
  `ORDER_EVENTS_PARTITIONS_AHEAD` months ready; `db:datagen` creates its own window. A test or
  script that writes events with a far date creates the partition first (`createPartitionSql`).
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
  object: partition DDL runs statement by statement (`DETACH … CONCURRENTLY` cannot run in a
  transaction). Its adapter uses `$executeRawUnsafe`: identifiers and partition bounds cannot
  be bind parameters; both are built from two integers.
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
