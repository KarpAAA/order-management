# 0012 — payments-service behind RabbitMQ: a command in, an event out

Date: 2026-10-06 Status: accepted

## Context

Until now the worker of the api charged the PSP itself: `OrderPlaced` enqueued the BullMQ job
`charge-order`, and one use case read the order, called the provider and recorded the result
(ADR 0004). Step 3 splits the modular monolith along the boundaries the architecture tests
have guarded since 1.13, and payments is the first service to leave (ADR 0001).

Two things change at once: where the charge happens (another process, another database), and
how the two sides talk (a broker, with the contracts of ADR 0011).

## Decision

- **payments-service** (`services/payments`): its own image, database server and migrations.
  One process, a broker consumer; no HTTP. The module is `layered · L1 · together`: a payment
  has one or two rules, and with Prisma the ladder is 1 → 3. It keeps two outbound ports: the
  gateway (`http` / `fake`, two real implementations) and the events publisher (the outbox of
  3.4 becomes its second adapter).
- **The api asks with a command and is answered with an event.**
  - `payments.charge-payment` → direct exchange `commands` → queue `payments.commands`.
  - `payments.payment-succeeded` / `payments.payment-failed` → topic exchange `events` → queue
    `api.payment-events`.
  - The routing key is the `name` of the message. A queue belongs to the service that reads it
    and is declared by its consumer. The exchange names live in `@oms/contracts`
    (`topology.ts`): the address is part of the contract, and a producer and a consumer that
    disagree on it lose every message without an error.
- **The command carries what payments needs**: the amount and the idempotency key
  `<orderId>:<attempt>`. payments cannot read the order, and the key is chosen once, by the
  side that owns the attempt.
- **One row per (order, attempt)** in `payments`, created `PENDING` before the provider is
  called and settled once. A command is delivered at least once, so each step may run twice:
  the second delivery finds the row, the provider answers the same for the same key, and a
  settled row is answered again with what is stored.
- **`orders.psp_charge_id` stays** in the api. The charge id never changes once issued and
  arrives in the event that makes the order `PAID`, so the copy cannot go stale; reading an
  order never calls payments.
- **The tenant in payments is a column**, without Row-Level Security or a scoped client. Both
  layers of the api protect against a user reading another tenant's rows; no user reads this
  database, and the only way in is a command from the api. Two database roles remain: the
  owner migrates, `payments_app` reads and writes rows and cannot run DDL.
- **Nothing is shared but the contracts.** Errors, the actor, the clock, the id generator and
  the broker wiring are copied into the service. A shared package of helpers would couple the
  two deploys (ADR 0011).
- **`@golevelup/nestjs-rabbitmq`** for the connection (`AmqpConnection`) and the
  `@RabbitSubscribe` decorator, **without its `RabbitMQModule`**. That module keeps its
  connections and a "handlers are registered" flag in static fields: one Nest application per
  Node process. The e2e suites run two or three applications in one process (api + worker, two
  workers), where the second would get no consumer and closing one would close all. Each
  service has ~40 lines instead (`infrastructure/messaging/`): a connection per application,
  and a registrar that starts the decorated methods of that application's providers.
- **A broker consumer follows the rule of a queue consumer**: `@RabbitSubscribe` only in a
  `*.consumer.ts`, registered only by a `*.worker.module.ts`. Lint and the process-graph test
  enforce it in both services, so the api process publishes and never consumes.
- **Tests stop at the boundary of each service.** The api suite reads the command from the
  broker and publishes the events payments would answer with; the payments suite sends the
  command and reads the event. Each test file gets its own RabbitMQ vhost, as it gets its own
  database. The path through both services is 3.13.

## Rejected

- **A synchronous call from the api to payments** (HTTP): the api would be down when payments
  is, and a slow provider would hold api workers again. It is what the split is for.
- **The Nest microservices transport for RabbitMQ**: it hides exchanges and bindings behind
  message patterns and publishes to queues directly; an event with several subscribers does
  not fit, and the topology is the subject of this step.
- **The library's module, with the e2e suite changed to one application per process**: the
  tests would no longer boot the processes the way production does.
- **Row-Level Security in payments**: a second role with policies, `set_config` per
  transaction and a copy of the tenant-scope extension, against a threat that does not exist
  until a user can read this database.
- **Dropping `orders.psp_charge_id`**: a migration and an API change, or a call to payments on
  every read of an order.
- **A retry loop in payments, or `nack` with requeue**: the first is thrown away in 3.3, the
  second redelivers at once, which is a hot loop against a provider that is down.

## Consequences

- A slow or failing provider no longer occupies the workers of the api, and payments deploys
  and scales on its own.
- One function call became two messages. Each can be lost, repeated or late, and for now only
  repetition is handled. Known gaps, recorded in `docs/architecture.md`:
  - **No retry of a transient provider failure.** BullMQ gave five attempts; now the first
    failure ends the attempt as `psp_unavailable`. The user places the order again. Closed by
    3.3 (the command is redelivered with a delay) and 3.11 (the call itself is retried).
  - **A rejected message is lost.** A message that is not a known contract, or a handler that
    throws, is rejected without requeue and logged. Closed by 3.3 (dead-letter queue).
  - **Publishing is not atomic with the commit, on both sides.** The api may commit
    `PENDING_PAYMENT` and fail to send the command; payments may charge and fail to publish
    the answer. The second case is recovered by a repeated command, which nothing sends yet.
    Closed by 3.4 (outbox).
  - **Duplicates are absorbed by the state, not by a table of seen messages.** The attempt
    number on the order and the unique row in payments do it today; the inbox is 3.5.
  - **A command published while `payments.commands` does not exist is dropped.** The queue is
    durable and exists from the first start of payments on.
- Two builds of `@oms/contracts` run at the same time during a deploy; the version in the
  message exists for that (ADR 0011).
- payments has no migration checker (drift, upgrade on the base seed) and no mutation run
  yet: it has one migration, applied on an empty database by its e2e suite.
