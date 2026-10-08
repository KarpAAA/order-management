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
transactions: cls               # `txHost.withTransaction()` in the use case: settle + outbox row; the provider is never called inside one
tenancy: column                 # `workspace_id` on the row; no RLS, no scoped client (ADR 0012)
db-roles: owner + payments_app  # DATABASE_ADMIN_URL migrates; DATABASE_URL reads and writes rows, no DDL; DELETE on `outbox` only
outbox: yes                     # table `outbox` + a relay in this process (ADR 0014)
broker: rabbitmq                # in: queue `payments.commands`; out: exchange `events`
queue: none                     # no BullMQ, no Redis
processes: worker               # one process: a broker consumer and the relay of the outbox; no HTTP
dlq: alert                      # a command given up → `payments.commands.dlq` + Logger.error (Step 4: metric)
cron: none                      # the cleanup of the outbox is a timer of the process (`OUTBOX_CLEANUP_INTERVAL_MS`)
validation: zod                 # messages through `parseMessage()` of @oms/contracts; env through zod
logs: stdout                    # Nest built-in Logger; pino in Step 4
testing: vitest                 # projects unit + e2e; the e2e suite stops at the service boundary
```

## Commands (from the repo root)

```
pnpm db:migrate:payments                  # prisma migrate dev on postgres-payments (5434)
pnpm --filter @oms/payments dev           # watch mode (needs services/payments/.env and pnpm build:contracts)
pnpm --filter @oms/payments test          # unit: adapters (MSW), policy, env, architecture (no Docker)
pnpm --filter @oms/payments test:e2e      # Testcontainers: Postgres + RabbitMQ, a command in, a row and an event out (through the outbox)
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
  answers with what is stored: a command is always answered. Keep every new step repeatable
  the same way.
- **One call to the provider per delivery** (ADR 0013). A failure that may pass
  (`InfrastructureError.retryable`) is thrown out of the use case while a delivery is left:
  the row stays `PENDING`, nothing is published, and the command comes again after
  `RABBITMQ_RETRY_DELAY_MS`. On the last delivery (`lastDelivery`, from the consumer) it is
  the outcome, `psp_unavailable`: the api waits for an answer, so a provider that is down is
  answered, never parked. Do not add a retry loop or `Nack(true)`: the call retried with
  backoff and a circuit breaker is 3.11.
- **A command that fails on something else** (the database, a bug) gets
  `PAYMENTS_COMMANDS_MAX_ATTEMPTS` deliveries and is then parked in `payments.commands.dlq`,
  with nothing answered: the order waits until an operator puts the command back (3.7 gives
  the api a timeout). A command that is not a known contract is parked at once
  (`UnprocessableMessageError`).
- **Three queues**: `payments.commands`, `.wait.<delayMs>`, `.dlq`, declared by
  `RabbitSubscribers` from `rabbitConfig.retry`. The decorator of the consumer names the
  exchange, the routing key and the queue only. The arguments of an existing queue cannot be
  changed: a change is a new name.
- **The answer is a row of the outbox, written in the transaction that settles the payment**
  (ADR 0014). `PaymentEventsPublisher.publish()` is called inside `txHost.withTransaction()`
  and appends; `Outbox.append()` throws outside a transaction. The relay of this process
  publishes the rows to `events`. Nothing in `modules/` touches `AmqpConnection`. The answer
  to a repeated command is a new row, so a new message id for the same fact.
- **Writes go through `txHost.tx`** (`TransactionHost<DbTransactionAdapter>`,
  `infrastructure/database/transactional.adapter.ts`), not through `PrismaService`: inside
  `withTransaction()` it is the transaction, outside it the client. The relay and the cleanup
  of the outbox use `PrismaService`: they open transactions of their own.
- **`infrastructure/outbox/` is a copy of the api's** (the relay, its runner, the publisher,
  `Outbox`), minus the translations of domain events and the BullMQ job. The passes of the
  relay are tested in the api (`services/api/test/outbox/`); here the e2e suite goes through
  it (`test/payments/outbox.e2e-spec.ts`).
- **Nothing is imported from `services/api`.** `src/shared/` and `src/infrastructure/messaging/`
  are copies, on purpose: the only shared code is `@oms/contracts`. A fix in one copy is
  checked against the other.
- **`MessagingModule`, not the library's `RabbitMQModule`** (static state, one Nest application
  per process; the e2e suite runs two).
- **A new table** needs `GRANT … TO payments_app` in its migration: the service does not own
  its tables. No `DELETE` is granted on `payments`: an attempt is a record of money. `outbox`
  has it: the retention deletes published messages.
- CHECK constraints (`payments_status_shape` and others) live in the migration SQL; Prisma
  cannot express them and `migrate diff` does not see them.
- The e2e suite replaces `PAYMENT_GATEWAY` with `test/doubles/test-psp.ts`; the HTTP adapter
  is tested against MSW. Each test file has its own database and its own RabbitMQ vhost.
  There a redelivery is 200 ms away and the third delivery is the last (`.env.test`).
  `test/helpers/broker.ts` reads a dead-letter queue (`take`), puts a message back (`put`),
  closes the service's connection from the broker's side (`killConnection`) and plays a
  consumer that dies with its message (`crashOn`).

## Deviations from the conventions templates

- An L1 module with `ports/` and `infrastructure/`: the gateway has two real implementations,
  but one or two rules do not justify a domain model (`docs/conventions-backlog.md` §6). The
  publisher port has one adapter since 3.4 (the outbox replaced the broker): it stays because
  it keeps `@oms/contracts` out of the use case, which may not import it (lint).
- The use case is `charge-payment.service.ts` at the module root and writes through the
  Prisma transaction host (L1). It has no `@UseCase()` decorator and no `@Transactional()`:
  only its last step is a transaction, opened with `txHost.withTransaction()`.
- The publisher port is called inside that transaction (`write-service.md` §4 forbids an
  adapter call there): it writes an outbox row and calls nothing
  (`docs/conventions-backlog.md` §8).
- The cleanup of the outbox is a timer in the process, not a scheduled job (`transport/cron.md`):
  the service has no queue.
- Two migrations, no migration checker and no mutation run yet (`docs/architecture.md` →
  Known gaps).
- `Actor` is the system actor only; `role-scope`, guards and HTTP rules do not apply.
