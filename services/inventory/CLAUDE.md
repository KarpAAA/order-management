# inventory-service

The third service of order-management (ROADMAP 3.6, `docs/adr/0016-inventory-service.md`).
It knows how much of a product is there and how much of it is held for orders, and it holds,
gives back and adjusts stock when asked by a command.
The root `CLAUDE.md` describes the api and the shared conventions; this file holds what differs.

## Project decisions

```
role-scope: none                # no users: every entry is a message, the only actor is a system one
authz: policy                   # InventoryPolicy: only `system:consumer:inventory` may change stock
ids: uuid7                      # of a reservation; a stock item is keyed by (workspace_id, product_id)
cross-module-fk: n/a            # one module; `product_id`, `order_id` and `workspace_id` belong to the api: plain columns
transactions: cls               # `@Transactional()` on the use case, joined to the transaction `inbox.once()` opens
tenancy: column                 # `workspace_id` on the row; no RLS, no scoped client (ADR 0012)
db-roles: owner + inventory_app # DATABASE_ADMIN_URL migrates and seeds; DATABASE_URL reads and writes rows, no DDL; DELETE on `outbox` and `inbox` only
outbox: yes                     # table `outbox` + a relay in this process (ADR 0014)
broker: rabbitmq                # in: queue `inventory.commands`; out: exchange `events`
queue: none                     # no BullMQ, no Redis
processes: worker               # one process: a broker consumer, the relay of the outbox, the cleanups of the outbox and the inbox; no HTTP
dlq: alert                      # a command given up → `inventory.commands.dlq` + Logger.error (Step 4: metric)
cron: none                      # the cleanups are timers of the process (`*_CLEANUP_INTERVAL_MS`)
validation: zod                 # messages through `parseMessage()` of @oms/contracts; env through zod
logs: stdout                    # Nest built-in Logger; pino in Step 4
testing: vitest                 # projects unit + e2e; the e2e suite stops at the service boundary
```

## Commands (from the repo root)

```
pnpm db:migrate:inventory                 # prisma migrate dev on postgres-inventory (5435)
pnpm db:seed:inventory                    # stock for the products of the api's seed (README → Seeded data)
pnpm db:explain:stock                     # four ways to reserve the last unit, and lock order (docs/perf/3.6-stock-locking.md)
pnpm --filter @oms/inventory dev          # watch mode (needs services/inventory/.env and pnpm build:contracts)
pnpm --filter @oms/inventory test         # unit: domain (+ property), use cases, adapter, policy, env, architecture (no Docker)
pnpm --filter @oms/inventory test:e2e     # Testcontainers: Postgres + RabbitMQ, a command in, rows and an event out
```

New migration: `pnpm --filter @oms/inventory exec prisma migrate dev --name <verb>_<object>`.

## Modules and their combinations

<!-- keep in sync with the first line of each *.module.ts -->

| Module    | Folders | Level | Read/write | Transports |
| --------- | ------- | ----- | ---------- | ---------- |
| inventory | layered | L4    | together   | worker     |

Process model: `src/entrypoints/main.worker.ts`, one image (`services/inventory/Dockerfile`).

## Gotchas specific to this service

- **Stock is read only through `StockRepository.lockMany()`**, inside a transaction:
  `SELECT … ORDER BY product_id FOR UPDATE`. Whoever decides on a stock level holds its row.
  A plain read of `stock_items` followed by a write sells the last unit twice, with no error
  (`docs/perf/3.6-stock-locking.md`). Do not add a `findById` to the port.
- **One order of locks for everybody.** `lockMany()` takes all the products of a command in
  one statement, ordered by `product_id`. A second call for more products in the same
  transaction, or a lock taken another way, brings deadlocks back
  (`test/inventory/concurrency.e2e-spec.ts`, INV-062, counts the ones Postgres had to break).
- **A reservation is saved before the stock is touched** in `ReleaseStockService`: its
  `version` is what lets one of two releases through. The other gets `ConcurrencyError`, is
  rolled back and delivered again.
- **Everything may run twice, and in either order.** The inbox absorbs the same message id.
  Another message for the same `(orderId, attempt)` finds the reservation and is only
  answered. A `release` with no reservation writes one as `RELEASED`, so the `reserve` that
  comes later holds nothing. `adjust` has no state that absorbs a repetition: only the inbox
  protects it. Keep every new command repeatable the same way.
- **A command is always answered, from the state.** `InventoryEventsPublisher` has a method
  per answer and takes the aggregate; the aggregates record no domain events. The answer to a
  repeated command is a new outbox row, so a new message id for the same fact.
- **What a thrown error does to the message** (`inventory.consumer.ts`): a `ConflictError`
  (another delivery wrote the same key first, a reservation changed) and anything that is not
  a `DomainError` → delivered again after `RABBITMQ_RETRY_DELAY_MS`, up to
  `INVENTORY_COMMANDS_MAX_ATTEMPTS`, then parked unanswered. Any other `DomainError` (stock
  below what is held, an attempt of another workspace) → parked at once. A shortage is not an
  error: it is a `REJECTED` reservation and an answer.
- **The tenant is a column.** Every query of `stock_items` filters by `workspace_id`;
  `(order_id, attempt)` is unique across workspaces, so `findByAttempt()` compares the
  workspace of the row with the one of the command and throws.
- **Three queues**: `inventory.commands`, `.wait.<delayMs>`, `.dlq`, declared by
  `RabbitSubscribers` from `rabbitConfig.retry`. The arguments of an existing queue cannot be
  changed: a change is a new name.
- **`infrastructure/` and `shared/` are copies** of the other services' (the relay and the
  outbox as in payments, the inbox in the form of the api: `inbox.once()` from the consumer,
  with the cleanup timer of payments). A fix in one copy is checked against the others.
  Nothing is imported from `services/api` or `services/payments`.
- **A new table** needs `GRANT … TO inventory_app` in its migration. No `DELETE` on
  `stock_items`, `reservations` and `reservation_lines`, and no `UPDATE` on the lines.
- CHECK constraints (`stock_items_levels` and others) live in the migration SQL; Prisma
  cannot express them and `migrate diff` does not see them.
- **The e2e suite**: each test file has its own database and RabbitMQ vhost; a redelivery is
  200 ms away and the third delivery is the last (`.env.test`). One process takes one command
  at a time (`RABBITMQ_PREFETCH=1`), which is what makes `handled()` a proof; the concurrency
  suite starts four processes instead. Stock a test starts from is written as the owner
  (`givenStock()` in `test/helpers/commands.ts`).

## Deviations from the conventions templates

- A use case writes two aggregates in one transaction (`domain-model.md` §1: the aggregate is
  the consistency boundary): the stock of several products and the reservation that holds
  them. The rule across them is the domain function `allocate()`
  (`docs/conventions-backlog.md` §11).
- `StockRepositoryPort` is `lockMany` / `insert` / `saveAll`, not the four standard methods,
  and locks pessimistically (`repository-mapper.md` §1 makes it the alternative)
  (`docs/conventions-backlog.md` §12).
- `StockItem` and `Reservation` do not extend `AggregateRoot` and record no domain events:
  an answer is read from the state (`docs/conventions-backlog.md` §13). `StockItem` has no
  `version` and no generated id: its key is the product, and its lock is the row.
- Repository ports although Postgres is the only implementation, as in `orders`: the use
  cases have unit tests on in-memory doubles (`application/__test__/`).
- The use cases are `@Injectable()` with `@Transactional()`, without the `@UseCase()` decorator
  of the api: the service has no `common/` and no in-process events to hold back until commit.
- The publisher port is called inside the transaction (`write-service.md` §4 forbids an
  adapter call there): it writes an outbox row and calls nothing
  (`docs/conventions-backlog.md` §8).
- The cleanups of the outbox and of the inbox are timers in the process, not scheduled jobs
  (`transport/cron.md`): the service has no queue.
- One migration, no migration checker and no mutation run (`docs/architecture.md` → Known gaps).
- `Actor` is the system actor only; `role-scope`, guards and HTTP rules do not apply.
