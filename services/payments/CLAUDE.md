# payments-service

The second service of order-management (ROADMAP 3.2, `docs/adr/0012-payments-service-over-rabbitmq.md`).
It charges one payment attempt of an order at the PSP when the api asks, cancels an attempt
that has not ended when the api takes the question back, and tells how the attempt ended.
The root `CLAUDE.md` describes the api and the shared conventions; this file holds what differs.

## Project decisions

```
role-scope: none                # no users: every entry is a message, the only actor is a system one
authz: policy                   # PaymentsPolicy: only `system:consumer:payments` may charge or cancel
ids: uuid7
cross-module-fk: n/a            # one module; `order_id` and `workspace_id` belong to the api: plain columns
transactions: cls               # `txHost.withTransaction()` in the use case: settle + outbox row; the provider is never called inside one
tenancy: column                 # `workspace_id` on the row; no RLS, no scoped client (ADR 0012)
db-roles: owner + payments_app  # DATABASE_ADMIN_URL migrates; DATABASE_URL reads and writes rows, no DDL; DELETE on `outbox` and `inbox` only
outbox: yes                     # table `outbox` + a relay in this process (ADR 0014)
broker: rabbitmq                # in: queue `payments.commands`; out: exchange `events`
queue: none                     # no BullMQ, no Redis
processes: worker               # one process: a broker consumer, the relay of the outbox, the cleanups of the outbox and the inbox; no HTTP
dlq: alert                      # a command given up → `payments.commands.dlq` + an `error` line (4.5: metric)
cron: none                      # the cleanups of the outbox and of the inbox are timers of the process (`*_CLEANUP_INTERVAL_MS`)
validation: zod                 # messages through `parseMessage()` of @oms/contracts; env through zod
logs: stdout                    # JSON lines, pino behind LOGGER, correlationId from CLS (ADR 0023); LOG_LEVEL, LOG_PRETTY
testing: vitest                 # projects unit + e2e; the e2e suite stops at the service boundary
```

## Commands (from the repo root)

```
pnpm db:migrate:payments                  # prisma migrate dev on postgres-payments (5434)
pnpm --filter @oms/payments dev           # watch mode (needs services/payments/.env and pnpm build:contracts)
pnpm --filter @oms/payments test          # unit: adapters (MSW), policy, env, architecture, the contracts (no Docker)
pnpm --filter @oms/payments test:e2e      # Testcontainers: Postgres + RabbitMQ, a command in, a row and an event out (through the outbox)
pnpm db:explain:resilience                # the real gateway against fake-psp: one call, retry, retry + breaker (docs/perf/3.11-resilience.md)
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
  settled only while `PENDING` (`updateMany … where status = PENDING`). Keep every new step
  repeatable the same way.
- **A command is handled once per message id** (ADR 0015). `Inbox.record(queue, messageId)`
  is the first statement of the transaction that settles the payment and writes the answer,
  and of the one that answers a settled attempt again. False = the same message was recorded
  before: nothing is settled and nothing is answered, its answer is in the outbox since then.
  Another message for a settled attempt (a new id) is answered with what is stored. The use
  case records, not the consumer: the provider is called before that transaction, outside
  any. `Inbox.record()` throws outside a transaction. `infrastructure/inbox/` follows the
  api's inbox but is not a copy of it: there the consumer wraps the use case in `inbox.once()`.
- **An attempt may be cancelled at any moment** (ADR 0017; `cancel-payment.service.ts`).
  `payments.cancel-payment` ends a `PENDING` row as `CANCELLED` in one transaction, without
  the provider, and answers with what the row says: `payment-cancelled`, or the stored outcome
  when the attempt had ended. Consequences for the charge:
  - a cancellation may be the first thing heard of an attempt: its row has no amount
    (`payments_charge_known`), and the charge command that arrives later charges nothing;
  - a call to the provider may be in flight: `settle()` finds the row no longer `PENDING`,
    writes a successful charge on the cancelled row and `voidIfCharged()` takes it back at
    the provider. A `CANCELLED` row with a charge id and no `voided_at` is voided by the next
    delivery of its charge command. Do not answer `payment-succeeded` for such a row;
  - `amountMinor`, `currency` and `idempotencyKey` are nullable in the types for that one
    case: read them through `chargeOf()`.
- **A charge command may expire** (`expiresAt`, optional in the contract). Checked before
  every call to the provider: at or after that moment nothing is charged and the attempt ends
  `FAILED` with `expired`. The sender stopped waiting, and tells so with this field.
- **A failure of the provider that may pass is retried in two layers** (ADR 0013, ADR 0020).
  In the gateway, within the delivery: up to `PSP_MAX_RETRIES` more calls after a pause with
  jitter, inside `PSP_CALL_BUDGET_MS`. In the broker: what the gateway gives up
  (`InfrastructureError.retryable`) is thrown out of the use case while a delivery is left:
  the row stays `PENDING`, nothing is published, and the command comes again after
  `RABBITMQ_RETRY_DELAY_MS`. On the last delivery (`lastDelivery`, from the consumer) it is
  the outcome, `psp_unavailable`: the api waits for an answer, so a provider that is down is
  answered, never parked. Do not add a retry loop to the use case or the consumer, and no
  `Nack(true)`: the first layer is `resilient-call.ts` and nowhere else.
- **The gateway does not call a provider it holds for down** (ADR 0020;
  `infrastructure/resilient-call.ts`, `cockatiel`). Above `PSP_BREAKER_THRESHOLD` failed
  calls in the window the circuit is open for `PSP_BREAKER_HALF_OPEN_MS`: a charge or a void
  throws at once, retryable, with no call. Consequences:
  - to the use case an open circuit is "the provider is away": no new branch, no new failure
    code. On the last delivery the answer is `psp_unavailable` without one call made;
  - only a retryable `PaymentGatewayError` is repeated and counted. A new kind of failure
    of the provider is classified in the adapter (`retryable` or not) and nowhere else;
  - the idempotency key is what makes a second call safe: a new operation of the gateway
    that is not repeatable at the provider must not go through `calls.execute()` as it is;
  - one circuit for the provider, shared by `charge` and `void`, in the memory of the
    process. A test that makes the provider fail builds a gateway of its own
    (`httpGateway()` in `test/helpers/worker-app.ts`), or the failures of one test open the
    circuit of the next;
  - the time of a delivery is bounded by `PSP_CALL_BUDGET_MS` plus one pause. Raising the
    budget, the retries or the deliveries moves the worst case towards
    `ORDER_SAGA_CHARGE_TIMEOUT_MS` of the api: `env.schema.spec.ts` holds the defaults to it;
  - `cockatiel` is ESM only; the service is CommonJS and loads it with `require` (Node 24).
    Its `maxAttempts` counts the retries, not the calls.
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
  and `inbox` have it: the retention deletes old rows.
- CHECK constraints (`payments_status_shape` and others) live in the migration SQL; Prisma
  cannot express them and `migrate diff` does not see them.
- **A new value of a Postgres enum is a migration of its own**: it cannot be used in the
  transaction that adds it, and Prisma runs a migration file as one.
- The e2e suite replaces `PAYMENT_GATEWAY` with `test/doubles/test-psp.ts`; the HTTP adapter
  is tested against MSW, and once with the service around it
  (`test/payments/psp-resilience.e2e-spec.ts`: the real adapter on the port, MSW as the provider). Each test file has its own database and its own RabbitMQ vhost.
  There a redelivery is 200 ms away and the third delivery is the last (`.env.test`).
  `test/helpers/broker.ts` reads a dead-letter queue (`take`), puts a message back (`put`),
  closes the service's connection from the broker's side (`killConnection`) and plays a
  consumer that dies with its message (`crashOn`).
- **One logger, and a correlation id nobody passes** (ADR 0023; a copy of the api's:
  `@shared/logger/logger`, `infrastructure/logger/`, `infrastructure/correlation/`, the port
  `CORRELATION`). `RabbitSubscribers` runs every delivery in the chain of its message and
  writes its line (`message delivered`); `retry-or-park.ts` opens the chain again. A class
  injects `LOGGER`: fields first, a message that never changes, ids and codes only, never
  `Logger` of Nest (lint). A class built by hand takes `silentLogger`; the e2e app logs to
  memory (`app.logs()`). The gateway names the chain to the
  provider on every call (`x-correlation-id`); a gateway built by hand is given
  `{ current: () => undefined }`. The relay publishes each row in the chain of its envelope.
- **The service is held to its rows of the map of parties** (ADR 0021;
  `payments.contract.spec.ts`): what the queue is bound to, a released message of each
  command through the consumer, and every answer the adapter writes. A new command or a new
  answer is a row in `packages/contracts/src/parties.ts` first.

## Deviations from the conventions templates

- An L1 module with `ports/` and `infrastructure/`: the gateway has two real implementations,
  but one or two rules do not justify a domain model (`docs/conventions-backlog.md` §6). The
  publisher port has one adapter since 3.4 (the outbox replaced the broker): it stays because
  it keeps `@oms/contracts` out of the use case, which may not import it (lint).
- The use cases are `charge-payment.service.ts` and `cancel-payment.service.ts` at the module
  root and write through the Prisma transaction host (L1). No `@UseCase()` decorator and no
  `@Transactional()`: only the last step of a charge is a transaction, opened with
  `txHost.withTransaction()`. What both read from a row is in `payment-row.ts`.
- The publisher port is called inside that transaction (`write-service.md` §4 forbids an
  adapter call there): it writes an outbox row and calls nothing
  (`docs/conventions-backlog.md` §8).
- The cleanups of the outbox and of the inbox are timers in the process, not scheduled jobs
  (`transport/cron.md`): the service has no queue.
- `ChargePaymentCommand` and `CancelPaymentCommand` carry the message id and the queue of
  the command: the use case writes the inbox row in its own last transaction (`docs/conventions-backlog.md` §10).
- Five migrations, no migration checker and no mutation run yet (`docs/architecture.md` →
  Known gaps).
- `ChargePaymentService` gets its logger as a property (`@Inject(LOGGER)` on a field), not
  through the constructor: it has six dependencies (`code-style.md` §2), and the use cases of
  the api get theirs the same way, from `@UseCase()` (`docs/conventions-backlog.md` §25).
- `Actor` is the system actor only; `role-scope`, guards and HTTP rules do not apply.
- The call to the provider is retried in the adapter although it is made from a queue
  (`transport/integrations.md` §3: retry in exactly one layer), and a circuit breaker stands
  in front of it (a "may" there): `docs/conventions-backlog.md` §20.
- `prisma/explain/resilience.ts` touches no database and imports the adapter of the module
  (lint: addition 2): it lives with the `db:explain:*` scripts of the other services.
