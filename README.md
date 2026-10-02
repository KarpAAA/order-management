# Order management: a multi-tenant backend, built step by step

A learning and portfolio project: a **multi-tenant order management backend** (workspaces,
users with roles, a product catalog, orders with an asynchronous payment flow) that grows one
area at a time: testing, database scaling, microservices and brokers, observability,
Kubernetes, load and chaos testing, AI.

**Current state: Step 0, the foundation.** One NestJS service (`services/api`) run as two
processes from one image: an HTTP **api** and a BullMQ **worker**. A tiny **fake-psp**
(`devtools/fake-psp`) plays an external payment provider.

## Architecture in one minute

- **Modular monolith** with strict module boundaries: `identity` (users, workspaces,
  memberships, roles), `catalog` (products), `orders` (lifecycle, calculations, payment).
  Modules talk only through facades; ESLint enforces it.
- **Tenancy**: every workspace is a tenant. Tenant tables have composite keys
  `(workspace_id, id)`; tenant filtering happens in exactly one place (a Prisma extension).
  A caller who is not a member of a workspace always gets 404.
- **Payments**: `place` → `PENDING_PAYMENT` → `202`; after the commit a BullMQ job charges the
  PSP (idempotency key per attempt, 3 s timeout, 5 retries with exponential backoff) and the
  order becomes `PAID` or `PAYMENT_FAILED`. The PSP sits behind a port with an HTTP adapter
  and an in-process fake.
- Money is BigInt minor units (JSON: `{ amountMinor, currency }`), ids are UUIDv7 from the
  domain, time comes from an injected `Clock`.

Details, diagrams (target architecture, modules, ERD, state machine, payment sequence) and
**known gaps**: [`docs/architecture.md`](docs/architecture.md).
Requirements for Step 1 tests: [`docs/requirements.md`](docs/requirements.md).
Decisions: [`docs/adr/`](docs/adr).

## Stack

Node.js 24 LTS · TypeScript 6 (strict) · pnpm 10 workspaces · NestJS 12 · Prisma 7 ·
PostgreSQL 18 · Redis 7 · BullMQ 6 · class-validator · zod (env) · nestjs-cls · Swagger ·
bull-board · argon2 + JWT.

PostgreSQL **18**, not 17: Step 2 adds Citus, and Citus 14 (Feb 2026) supports PG 18.

## Quick start (Windows CMD)

Prerequisites: Docker Desktop running, **Node 24** (`.node-version`), pnpm 10.

```cmd
pnpm install
copy services\api\.env.example services\api\.env
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- `pnpm infra:up`: Postgres, PgBouncer, Redis and fake-psp, waits until healthy.
- Two database roles (ADR 0006): `pnpm db:*` connect as the owner `oms`
  (`DATABASE_ADMIN_URL`); api and worker connect as `oms_app` (`DATABASE_URL`), which sees only
  the rows of the current workspace (Row-Level Security). A fresh Postgres volume gets the
  login of `oms_app` from `devtools/postgres/init`. A volume created earlier needs it once,
  after `pnpm db:migrate`:
  `docker compose exec postgres psql -U oms -d oms -c "ALTER ROLE oms_app LOGIN PASSWORD 'oms_app'"`
- PgBouncer (ADR 0008) pools the connections of `oms_app` in transaction mode on port 6432.
  api and worker connect through it, under `pnpm dev` and in the containers alike
  (`DATABASE_URL`); the owner (`DATABASE_ADMIN_URL`, port 5432) never does.
- `pnpm dev`: api and worker in watch mode, side by side.
- Then open `docs/requests.http` in WebStorm and run it top to bottom.

Everything in containers instead (api and worker from **one** image, migrations as a one-shot
step before them):

```cmd
docker compose --profile app up --build
```

Other scripts: `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm db:reset`,
`pnpm infra:down`.

## URLs

| What                          | URL                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------- |
| API                           | http://localhost:3000/v1                                                          |
| Swagger UI                    | http://localhost:3000/docs                                                        |
| OpenAPI JSON                  | http://localhost:3000/docs-json                                                   |
| bull-board (queues, dev only) | http://localhost:3000/admin/queues                                                |
| fake-psp                      | http://localhost:4010 (`GET /charges`, `POST /admin/config`, `POST /admin/reset`) |
| PgBouncer console             | `psql postgresql://stats:stats@localhost:6432/pgbouncer -c "SHOW POOLS"`          |

## Seeded data

Every user's password is **`Passw0rd!`**.

| Workspace | Id                                     | Currency | Tax             |
| --------- | -------------------------------------- | -------- | --------------- |
| acme      | `01990000-0000-7000-8000-a00000000000` | EUR      | 2000 bps (20 %) |
| globex    | `01990000-0000-7000-8000-b00000000000` | USD      | 0               |

| User               | Id                                     | acme   | globex |
| ------------------ | -------------------------------------- | ------ | ------ |
| owner@acme.test    | `01990000-0000-7000-8000-c000000000a1` | OWNER  | –      |
| admin@acme.test    | `01990000-0000-7000-8000-c000000000a2` | ADMIN  | –      |
| member@acme.test   | `01990000-0000-7000-8000-c000000000a3` | MEMBER | –      |
| viewer@acme.test   | `01990000-0000-7000-8000-c000000000a4` | VIEWER | –      |
| owner@globex.test  | `01990000-0000-7000-8000-c000000000b1` | –      | OWNER  |
| admin@globex.test  | `01990000-0000-7000-8000-c000000000b2` | –      | ADMIN  |
| member@globex.test | `01990000-0000-7000-8000-c000000000b3` | –      | MEMBER |
| viewer@globex.test | `01990000-0000-7000-8000-c000000000b4` | –      | VIEWER |
| both@example.test  | `01990000-0000-7000-8000-c000000000c1` | MEMBER | VIEWER |

**Products**: 18 per workspace, ids `…-a100000000NN` (acme) and `…-b100000000NN` (globex)
where `NN` = 01…12 in hex (1…18); SKUs `ACM-001…018` / `GBX-001…018`. Products 4, 11 and 16
(`…04`, `…0b`, `…10`) are **ARCHIVED**.

**Orders**: the same set in each workspace, ids `…-a2000000000N` (acme) / `…-b2000000000N` (globex):

| N   | Status          | Notes                                                     |
| --- | --------------- | --------------------------------------------------------- |
| 1   | DRAFT           | 1 item                                                    |
| 2   | DRAFT           | no items (placing it → 422)                               |
| 3   | PENDING_PAYMENT | has **no job**: shows the enqueue gap, stays pending      |
| 4   | PAID            | 2 items, 10 % discount                                    |
| 5   | PAYMENT_FAILED  | `insufficient_funds`, FIXED discount; can be placed again |
| 6   | FULFILLED       | full history                                              |
| 7   | CANCELLED       | cancelled from DRAFT                                      |

## Generated data (Step 2)

A volume dataset for the Step 2 experiments (indexes, partitioning, tenancy modes, sharding),
loaded **next to** the seed after a reset:

```
pnpm db:reset
pnpm db:datagen                      # full: 100 tenants, 2M orders, 24 months (~6 GB, minutes)
pnpm db:datagen --scale smoke        # 10 tenants, 20k orders, 6 months (seconds)
```

Flags: `--seed 42`, `--until <ISO date>` (default today 00:00 UTC, printed at start),
`--tenants`, `--orders`, `--months`. The same `--seed` and `--until` give byte-identical data.

- **Tenants** `gen-001…gen-100` follow a Zipf distribution: `gen-001` holds ~20 % of all
  orders, the long tail a few hundred each. Late tenants join during the window.
- **Orders** are built through the domain (`Order.draft` + real transitions + `OrderMapper`),
  so totals, CHECKs and history always match the status. Order times grow denser towards
  `until` and are loaded in time order with tenants interleaved, as production writes them.
  Ids are UUIDv7 stamped with the row's own `created_at`.
- **Users**: `owner@gen-001.datagen.local`, `user-01@gen-001.datagen.local`, … with the seed
  password. The last user of each tenant is a VIEWER.
- `order_events` is partitioned by month: the script creates the partitions of the whole
  window before loading (the migration and the worker job only cover the months around today).
- Loaded with `COPY` in 5000-order transactions, then `VACUUM ANALYZE`; the script prints
  table and index sizes (partitions summed into `order_events`, then one line per partition),
  the top tenants and the status mix. It refuses production, a non-local
  host, and a database that already has `gen-*` tenants.

Sizes later on (every `order_events_YYYY_MM` partition is its own line):

```sql
SELECT relname, n_live_tup,
       pg_size_pretty(pg_relation_size(relid))       AS heap,
       pg_size_pretty(pg_indexes_size(relid))        AS indexes,
       pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;
```

Plans on this data: `pnpm db:explain` (lists, `docs/perf/2.2-indexes-explain.md`),
`pnpm db:explain:partitions` (pruning, DROP vs DELETE, `docs/perf/2.3-partitioning.md`),
`pnpm db:explain:rls` (what the application role sees, plans under the policy,
`docs/perf/2.4-rls.md`) and `pnpm db:explain:pgbouncer` (500 clients on 20 server connections,
the two connection limits, a session-level setting leaking, `docs/perf/2.7-pgbouncer.md`).

## Simulating the payment provider

fake-psp reads `FAKE_PSP_LATENCY_MS`, `FAKE_PSP_FAILURE_RATE`, `FAKE_PSP_DECLINE_RATE` at start
(see `docker-compose.yml`) and can be changed at runtime without a restart:

```cmd
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"declineRate\":1}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"failureRate\":1,\"declineRate\":0}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"latencyMs\":4000}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"latencyMs\":200,\"failureRate\":0,\"declineRate\":0}"
curl http://localhost:4010/charges
```

- `declineRate: 1`: every new charge is declined → `PAYMENT_FAILED` with the decline code, no
  retry. Place the order again: a new attempt, a new idempotency key.
- `failureRate: 1`: every call returns 503 → the job is retried (watch `/admin/queues`),
  then `PAYMENT_FAILED` with `psp_unavailable`.
- `latencyMs` above 3000: the api's 3 s timeout fires → handled like a failure.
- The same `Idempotency-Key` always returns the same response.

Set `PAYMENT_GATEWAY=fake` in `services/api/.env` to skip fake-psp entirely (in-process,
deterministic: amounts ending in `13` minor units are declined).

## Contract fuzzing (Schemathesis)

```cmd
pnpm test:contract     & rem fresh stack + seed in project oms-contract, then Schemathesis
pnpm contract:down     & rem remove the project and its volumes
```

Schemathesis generates requests from `/docs-json` and checks every response: no 5xx, only
documented status codes, bodies matching the schema, and the API accepting what the schema
allows (and rejecting what it forbids). It runs in its own compose project with no host
ports, so it works next to the dev stack and never touches dev data. The containers stay up
after a run for `docker compose -p oms-contract logs api`.

Config: `devtools/contract/schemathesis.toml`. It logs in as `owner@acme.test` by itself,
pins `workspaceId` to acme (a random one is a non-member → 404 at the guard) and draws
`orderId` / `productId` mostly from the seeded ids. Every failure prints a `curl` to reproduce it.

## Mutation testing (Stryker)

```cmd
pnpm test:mutation     & rem Stryker over the unit suite, report in services/api/reports/mutation
```

Stryker plants small bugs (mutants) in `orders` `domain/` + `application/` and in
`shared/domain/money.ts`, runs the unit tests covering each one, and reports the mutants no
test caught. A surviving mutant is a missing or too weak assertion. Report only for now: no
threshold fails the run. Repeated runs are incremental (`reports/stryker-incremental.json`).
Config: `services/api/stryker.config.mjs`.

## Migration checks

```cmd
pnpm test:migrations   & rem guard, fresh, drift, upgrade on a throwaway Postgres (Testcontainers)
```

Four steps against the merge base with `main` (`MIGRATIONS_BASE_REF` overrides the ref); the
first failure stops the run:

- **guard** (git only): no migration of the base edited, deleted or renamed, uncommitted
  edits included; new migrations sort after the base's last one. More than one new
  migration is a warning (one migration per PR).
- **fresh**: `prisma migrate deploy` of every migration on an empty database.
- **drift**: `prisma migrate diff` of that database against `schema.prisma`; on a
  difference it prints the SQL still missing (a forgotten `prisma migrate dev`). The
  hand-written CHECKs, roles, grants, policies and functions are invisible to it; the
  `*.int-spec.ts` tests cover them.
- **upgrade**, only when the branch adds migrations: a git worktree of the base installs,
  migrates and runs its own `prisma/seed.ts`, then this branch's new migrations run on top.
  Catches SQL that passes on an empty table and fails on data (`ADD COLUMN … NOT NULL`
  without a default).

Script: `services/api/prisma/check-migrations.ts`.

## CI and git hooks

Each check runs at the cheapest level that can catch its bug; a hook is a shortcut, CI is the
gate (a hook can be skipped, CI cannot).

| When                             | What                                                                                   | Where                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- |
| `git commit`                     | Prettier + ESLint `--fix` on staged files                                              | `.husky/pre-commit`, lint-staged |
| `git commit`                     | Conventional Commits (`commitlint.config.mjs`), no `Co-Authored-By` / `Claude-Session` | `.husky/commit-msg`              |
| `git push`                       | `pnpm typecheck && pnpm test`                                                          | `.husky/pre-push`                |
| every PR, every push to `main`   | static (format, lint, typecheck) → unit → e2e + migrations; audit; commits (PR)        | `.github/workflows/ci.yml`       |
| push to `main`, nightly, by hand | Stryker (incremental, report artifact), Schemathesis                                   | `.github/workflows/nightly.yml`  |
| weekly                           | dependency PRs, each through the full CI                                               | `.github/dependabot.yml`         |

Hooks install with `pnpm install` (`prepare`). By hand only: e2e and migration checks before
pushing a change to repositories or `schema.prisma`, `pnpm test:contract` while fixing DTOs,
Stryker on one file (`pnpm --filter @oms/api exec stryker run --mutate <file>`).

## Repository layout

```
services/api/        NestJS service: src/entrypoints/main.api.ts + main.worker.ts, one image
  prisma/            schema, migrations, seed
  src/entrypoints/   one module + one main per process
  src/config/        zod-validated env, typed namespaces
  src/common/        HTTP frame: guards, filter, decorators, DTOs, tenant context
  src/shared/        framework-free: errors, Actor, Money, Clock, ids, events, pagination
  src/infrastructure/ database (tenant choke point), queues, events
  src/modules/       identity (L1), catalog (L1), orders (L4)
devtools/fake-psp/   external PSP simulator (not part of the system)
docs/                architecture, requirements, ADRs, requests.http
```
