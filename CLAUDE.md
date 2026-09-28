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
cron: none                      # Step 0; BullMQ repeatable jobs when needed
validation: class-validator
swagger-prod: off
async-push: poll
logs: stdout                    # Nest built-in Logger in Step 0; pino in Step 4
traces: none
metrics-endpoint: none          # Step 4
tracker: none
merge: merge-commit
testing: vitest                 # projects unit + e2e; test levels per requirement in docs/requirements.md
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
pnpm dev               # api + worker in watch mode
pnpm lint && pnpm typecheck
pnpm test              # Vitest project unit: domain, VOs, policies (no Docker)
pnpm test:e2e          # Vitest project e2e: *.int-spec.ts + *.e2e-spec.ts (Testcontainers)
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
  data: its only users are the extension and identity's documented cross-tenant reads.
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

- `eslint.config.mjs` (not `.js`, package is CJS); `eslint-plugin-boundaries` pinned to 5.x
  (the template uses its API); `interface`/`read` may import own `domain`; L1 `read` may
  import its module root; `max-params` replaced by selectors (4 for functions, 6 for
  constructors); an `entry` element for `src/entrypoints`; `test/factories` may import module
  internals (domain + mapper). Details at the top of the file.
- Module core exports include the use cases and query services, for the module's own
  transport modules (Nest needs them exported to inject them into controllers/consumers).
