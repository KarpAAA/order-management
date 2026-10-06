# payments-service

The second service of order-management (ROADMAP 3.2, `docs/adr/0012-payments-service-over-rabbitmq.md`).
It charges one payment attempt of an order at the PSP when the api asks, and tells how it ended.
The root `CLAUDE.md` describes the api and the shared conventions; this file holds what differs.

## Project decisions

```
role-scope: none                # no users: every entry is a message, the only actor is a system one
authz: policy                   # PaymentsPolicy: only `system:consumer:payments` may charge
ids: uuid7
cross-module-fk: n/a            # one module; `order_id` and `workspace_id` belong to the api: plain columns
transactions: none              # one statement per write; the provider is never called inside a transaction
tenancy: column                 # `workspace_id` on the row; no RLS, no scoped client (ADR 0012)
db-roles: owner + payments_app  # DATABASE_ADMIN_URL migrates; DATABASE_URL reads and writes rows, no DDL, no DELETE
outbox: no                      # 3.4; until then the event follows the row
broker: rabbitmq                # in: queue `payments.commands`; out: exchange `events`
queue: none                     # no BullMQ, no Redis
processes: worker               # one process, a broker consumer; no HTTP
dlq: alert                      # a rejected message → Logger.error, lost until 3.3
cron: none
validation: zod                 # messages through `parseMessage()` of @oms/contracts; env through zod
logs: stdout                    # Nest built-in Logger; pino in Step 4
testing: vitest                 # projects unit + e2e; the e2e suite stops at the service boundary
```

## Commands (from the repo root)

```
pnpm db:migrate:payments                  # prisma migrate dev on postgres-payments (5434)
pnpm --filter @oms/payments dev           # watch mode (needs services/payments/.env and pnpm build:contracts)
pnpm --filter @oms/payments test          # unit: adapters (MSW), policy, env, architecture (no Docker)
pnpm --filter @oms/payments test:e2e      # Testcontainers: Postgres + RabbitMQ, a command in, a row and an event out
```

New migration: `pnpm --filter @oms/payments exec prisma migrate dev --name <verb>_<object>`.

## Modules and their combinations

<!-- keep in sync with the first line of each *.module.ts -->

| Module   | Folders        | Level | Read/write | Transports |
| -------- | -------------- | ----- | ---------- | ---------- |
| payments | layered (flat) | L1    | together   | worker     |

Process model: `src/entrypoints/main.worker.ts`, one image (`services/payments/Dockerfile`).

## Gotchas specific to this service

- **Everything may run twice.** A command is delivered at least once. The row is unique per
  `(order_id, attempt)`, the provider gets the idempotency key of the command, and a row is
  settled only while `PENDING` (`updateMany … where status = PENDING`). Whoever comes second
  publishes what is stored. Keep every new step repeatable the same way.
- **One call to the provider, no retry.** A transient failure ends the attempt as
  `psp_unavailable`. Do not add a retry loop or `Nack(true)`: the command redelivered with a
  delay is 3.3, the call retried with backoff and a circuit breaker is 3.11.
- **The event is published after the row is saved, not atomically with it.** Do not "fix" it
  before 3.4 (outbox).
- **Nothing is imported from `services/api`.** `src/shared/` and `src/infrastructure/messaging/`
  are copies, on purpose: the only shared code is `@oms/contracts`. A fix in one copy is
  checked against the other.
- **`MessagingModule`, not the library's `RabbitMQModule`** (static state, one Nest application
  per process; the e2e suite runs two).
- **A new table** needs `GRANT … TO payments_app` in its migration: the service does not own
  its tables. No `DELETE` is granted on `payments`: an attempt is a record of money.
- CHECK constraints (`payments_status_shape` and others) live in the migration SQL; Prisma
  cannot express them and `migrate diff` does not see them.
- The e2e suite replaces `PAYMENT_GATEWAY` with `test/doubles/test-psp.ts`; the HTTP adapter
  is tested against MSW. Each test file has its own database and its own RabbitMQ vhost.

## Deviations from the conventions templates

- An L1 module with `ports/` and `infrastructure/`: the gateway has two real implementations
  and the publisher gets a second one in 3.4, but one or two rules do not justify a domain
  model (`docs/conventions-backlog.md` §6).
- The use case is `charge-payment.service.ts` at the module root and imports `PrismaService`
  (L1). It has no `@UseCase()` decorator: there is no unit of work to wrap.
- No migration checker and no mutation run yet (`docs/architecture.md` → Known gaps).
- `Actor` is the system actor only; `role-scope`, guards and HTTP rules do not apply.
