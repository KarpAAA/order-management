# 0014 — A message for the broker is written with the change, and relayed afterwards

Date: 2026-10-08 Status: accepted

## Context

Since ADR 0012 both services wrote to two places one after the other: the database, then the
broker. Nothing made the two one.

- **api.** `place` committed `PENDING_PAYMENT`, and an in-process handler published
  `payments.charge-payment` after the commit. A broker that was down, or a process that died
  in between, left an order waiting for a charge nobody had been asked for, in a status that
  cannot be cancelled. Nothing sent the command again.
- **payments.** The row was settled, then the answer was published. A charge could be made
  and never reported. Since ADR 0013 a publish that threw was covered by the redelivery of
  the command; a process that died between the two writes was covered only by luck.

Publishing first and committing after is no better: a command for an order that was rolled
back. There is no transaction across Postgres and RabbitMQ, so the two writes have to become
one write and a repetition.

## Decision

- **The message is a row.** Each service has a table `outbox`
  (`id`, `exchange`, `routing_key`, `payload`, `occurred_at`, `created_at`, `published_at`).
  A message is inserted in the transaction of the change it tells about, through
  `Outbox.append()`, which refuses to run outside a transaction. Either the order is
  `PENDING_PAYMENT` and the command exists, or neither.

- **The row holds the whole envelope**, as `Contract.create()` built it, and its address. The
  id of the row is the `messageId` of the envelope, chosen when the row is written: a message
  published twice is the same message to its reader.

- **A relay in the worker publishes the rows** (`OutboxRelay`, started by
  `OutboxRelayRunner`). One pass is one transaction:

  ```
  BEGIN
    pg_try_advisory_xact_lock          not taken → skip this pass
    SELECT … WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED
    one by one: publish → wait for the confirm     the first failure ends the pass
    UPDATE outbox SET published_at = now() WHERE id IN (the ones confirmed)
  COMMIT
  ```

  A pass that found a full batch is followed by the next at once; otherwise the relay sleeps
  `OUTBOX_POLL_INTERVAL_MS` (1 s). The api process writes rows and never publishes them.

- **Polling.** The application role goes through PgBouncer in transaction mode (ADR 0008),
  where `LISTEN` is lost with the connection after every commit.

- **One relay at a time**, by a transaction-level advisory lock. With two, each takes a part
  of the queue and the events of one order can leave in the wrong order; and a message that
  fails stops everything behind it for the same reason. Order is worth more here than
  throughput: one relay publishes hundreds of messages a second, and ROADMAP 3.8 (Kafka,
  keyed by order) needs the order. `FOR UPDATE SKIP LOCKED` stays in the query: it is what
  keeps a row from being taken twice if the lock is ever removed for throughput.

- **"Published" means confirmed.** The relay publishes on a confirm channel of its own and
  marks a row only after the broker's confirm. A broker that is away does not refuse a
  publish, it never answers, so every publish has a timeout (`OUTBOX_PUBLISH_TIMEOUT_MS`,
  5 s): the pass fails, its rows stay, the next pass tries again.

- **A command is published `mandatory`.** With no queue bound for it the broker hands the
  message back before it confirms, the publisher fails with `UnroutableMessageError`, and the
  row stays. An event is not mandatory: an event nobody subscribes to is not a loss.

- **The relay publishes through a port** (`OutboxPublisher`): RabbitMQ is its adapter today,
  Kafka the second one in ROADMAP 3.8. The table and the relay do not change.

- **Two ways into the outbox**, one per kind of message:
  - a **command** is an explicit call of a port inside the transaction of the use case:
    `PlaceOrderService` calls `PaymentChargeScheduler.schedule()`, and
    `OutboxPaymentChargeAdapter` appends the row. The saga of 3.7 sends its commands the same
    way;
  - an **event** goes through `EventPublisher.publishAll()`. A domain event with
    `delivery = 'reliable'` is translated by its module into the contracts it becomes
    (`ReliableEvents`, `orders/infrastructure/order-events.translator.ts`) and appended; an
    `in-process` event is dispatched after the commit, as before.

- **The life of an order is published**: `orders.order-placed`, `-paid`, `-cancelled`,
  `-fulfilled`, to the `events` exchange. Nobody subscribes yet (inventory 3.6,
  notifications 3.10).

- **payments settles and answers in one transaction.** The service got CLS transactions for
  it (`transactions: cls`). The provider is still called outside any transaction. A repeated
  command, and the delivery that lost a race, both answer with what is stored: a command is
  always answered.

- **The correlation id lives in CLS** (`CorrelationContext`). A consumer continues the id of
  the message it handles; an HTTP request starts one. The command and the event of one
  `place` share it, and `orders.order-paid` carries the id of the charge command.

- **Not a tenant table.** No `workspace_id`, no Row-Level Security: the relay reads the rows
  of every tenant, and the tenant of a message is in its envelope. The application role has
  `SELECT, INSERT, UPDATE, DELETE` on it.

- **Retention: 7 days** for a published row (`OUTBOX_RETENTION_DAYS`); an unpublished row is
  never deleted. In the api a daily BullMQ job (`cleanup-outbox`); in payments, which has no
  queue, a timer of the process (`OUTBOX_CLEANUP_INTERVAL_MS`).

- **`OUTBOX_RELAY_ENABLED=false`** stops the relay without a deploy. Messages wait.

## Rejected

- **`LISTEN` / `NOTIFY`** to wake the relay: not through PgBouncer in transaction mode. It
  would also only shorten the delay, and still need the poll as the fallback.
- **Several relays** (`SKIP LOCKED` alone): no order between them. A relay per aggregate key
  keeps the order of one order and scales, at the price of a key column and a harder query;
  not needed at this volume.
- **Deleting a row once it is published**: the table stays small, and the record of what was
  sent and when, which an incident needs, is gone.
- **An alternate exchange** for a command with no queue: one more queue somebody has to
  watch, and the message is already kept, in the outbox.
- **A BullMQ job as the relay**: the relay would stop with Redis, and payments has no Redis.
- **Passing the transaction to the port** in payments (`publish(outcome, tx)`): a Prisma type
  in a port. CLS carries it instead.
- **A partial index** on the unpublished rows: Prisma cannot express it, and the drift check
  would have to be told to ignore it. `(published_at, id)` serves the relay and the cleanup.
- **Debezium** reading the table from the WAL: ROADMAP 3.14.

## Consequences

- An order never waits for a charge nobody was asked for, and a charge is never left
  unreported: the message exists exactly when the change does. Broker down: `place` still
  answers 202, and the command leaves when the broker is back.
- **At-least-once.** A pass that dies between the confirm and its commit publishes those
  messages again, with the same message id. Both consumers absorb a repetition by state; a
  table of seen ids is 3.5.
- A message reaches the broker up to one poll interval after the commit.
- Order holds within one service's outbox, by the id of the row (UUIDv7: time of writing,
  not of commit). Two transactions that overlap may be published in the other order; two
  events of one order cannot overlap, the version of the order serializes them.
- One message that cannot be published stops every message behind it, until somebody acts.
  The relay logs that once as an error and again when it recovers.
- A pass holds a transaction, and one pooled connection, for as long as its batch takes: at
  worst the publish timeout.
- `payments.payment-*` and the `orders.*` events are different messages about the same fact:
  payments tells what the provider did, orders what the order became.
- The outbox and the relay are copied in both services, like `infrastructure/messaging/`: a
  fix in one is made in the other. The passes of the relay are tested once, in the api.
- Known gaps, recorded in `docs/architecture.md`:
  - **Nobody is told that the relay is stuck** except through the log. A metric of the
    unpublished rows and of the age of the oldest comes with Step 4.
  - **payments has two migrations and no migration checker** (guard, drift, upgrade). Its
    e2e suite applies them to an empty database; drift was checked by hand for this one.

## What 3.5 starts from

Not decisions: the state 3.4 leaves behind, for whoever builds the inbox next.

- **Every message has a stable id**: `messageId` is the id of its outbox row, and a
  repetition by the relay, by the broker or by an operator carries the same one. The AMQP
  property `messageId` holds it too.
- **A repeated command is a new message.** payments answers a command it has already settled
  with a new outbox row, so a new `messageId` for the same fact. An inbox keyed by message id
  does not absorb that one; the state of the order still does.
- **Both consumers are idempotent by state today** (the attempt on the order, the unique row
  in payments), and `InvalidStateError` is acknowledged as "already done".
- **The consumer's use case already runs in a transaction** in both services: the place for
  the inbox row is that transaction.
- **A table that is not a tenant's** has a precedent: `outbox`, with its grant and without a
  policy (`test/tenancy/row-level-security.int-spec.ts` accepts it).
- **`broker.orderEvents()`** in the api's test helper reads what the api publishes.
