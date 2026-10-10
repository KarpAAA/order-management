# order-management

Multi-tenant order management backend, built step by step as a learning project.
Current step: **Step 4: observability**, 4.6 done (see `docs/ROADMAP.md`; architecture: `docs/architecture.md`).
Four services: `services/api` (this file), `services/payments`, `services/inventory` and
`services/notifications` (their own decisions: `services/payments/CLAUDE.md`,
`services/inventory/CLAUDE.md`, `services/notifications/CLAUDE.md`). They share
`packages/contracts` and nothing else. The api orchestrates payments and inventory: placing
an order is a saga (ADR 0017). notifications only listens: it reads the events of an order
and writes to its user (ADR 0019).
The roadmap runs in two passes: Step 2 closed at 2.9, and 2.10–2.12, Kafka (3.8, 3.9, 3.14) and
the other deferred items wait in `docs/ROADMAP.md` → «Другий прохід». Do not build a deferred
item unless asked.

## Conventions

Rules in `.claude/rules/shared/` are shared across my Nest projects (symlink to
`C:\Users\ikarp\WebstormProjects\nest-conventions\rules`, created by its `link.ps1`). Do not
edit them here: tell me and I change them in the conventions repo. Project-specific
deviations go in `.claude/rules/project/` only.
When the code goes past the conventions because they did not foresee the case (not a choice
that is right for this project only), add an entry to `docs/conventions-backlog.md` in the same
change, in its template: what the conventions say, what we did, why, whether it is good, a
short example, the proposed change. That file is my queue for the conventions repo; a
project-only choice still goes to "Deviations" below.
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
outbox: yes                     # table `outbox` + a relay in the worker (ADR 0014); relayed to RabbitMQ, not to BullMQ
broker: rabbitmq                # between services only (ADR 0012): commands → exchange `commands`, events → `events`
queue: bullmq
processes: api+worker
dlq: alert                      # dead job → an `error` line of its consumer + `queue_job_dead_total`; a broker message given up → `<queue>.dlq` + an `error` line + `broker_messages_parked_total` (ADR 0027)
cron: bullmq                    # job schedulers on the owner's queue: maintain-order-event-partitions (orders), cleanup-outbox (outbox), cleanup-inbox (inbox), cleanup-idempotency-keys (idempotency)
idempotency-key: required       # on POST /orders and POST /orders/{id}/place only (ADR 0018); a row in the transaction of the write
validation: class-validator
swagger-prod: off
async-push: poll
logs: stdout                    # JSON lines, pino behind LOGGER, correlationId from CLS (ADR 0023), traceId + spanId of the active span; to Loki by the agent `alloy` in a container, by OTLP under `pnpm dev` (OTEL_LOGS_EXPORTER, ADR 0026); LOG_LEVEL, LOG_PRETTY
traces: otlp                    # the SDK is a preload (`node --require ./dist/instrumentation.js`); OTEL_EXPORTER_OTLP_ENDPOINT unset = off (ADR 0025)
metrics-endpoint: port          # GET /metrics on METRICS_PORT of every process (9464 api, 9465 worker; 0 = off), pulled by Prometheus (ADR 0027)
tracker: none
merge: merge-commit
testing: vitest                 # projects unit + e2e; test levels per requirement in docs/requirements.md
ci: github-actions              # PR + main: static (+ promtool on the SLO rules), unit, e2e, migrations, contracts, audit; PR: commits; main + nightly: mutation, contract, system
hooks: husky                    # pre-commit: lint-staged; commit-msg: commitlint + no AI trailers; pre-push: typecheck + unit
```

## Stack

NestJS 12.1, Prisma 7.10 (+ `@prisma/adapter-pg`), PostgreSQL 18, Redis 7, BullMQ 6,
RabbitMQ 4 (`@golevelup/nestjs-rabbitmq` 9: `AmqpConnection` + `@RabbitSubscribe`, not its module),
Node 24 LTS, TypeScript 6.0, pnpm 10 (workspaces: `services/*`, `packages/*`, `devtools/*`)

## Commands (CMD-friendly, from the repo root)

```
pnpm infra:up          # postgres, postgres-replica, pgbouncer, postgres-payments, postgres-inventory, postgres-notifications, redis, rabbitmq, mailpit, lgtm (Grafana on 3001, OTLP on 4317 / 4318), postgres-exporter, fake-psp (healthy)
pnpm db:migrate        # prisma migrate dev (api)
pnpm db:migrate:payments     # prisma migrate dev (payments, its own Postgres on 5434)
pnpm db:migrate:inventory    # prisma migrate dev (inventory, its own Postgres on 5435)
pnpm db:migrate:notifications   # prisma migrate dev (notifications, its own Postgres on 5436)
pnpm db:seed           # fixed-id dev data (README → Seeded data)
pnpm db:seed:inventory       # stock for the seeded products (inventory)
pnpm db:reset          # drop, migrate, seed
pnpm db:datagen        # Step 2 volume data after db:reset: 100 tenants, 2M orders (--scale smoke)
pnpm db:explain        # plans of the list queries on the datagen data (docs/perf/2.2-indexes-explain.md)
pnpm db:explain:partitions   # order_events pruning, DROP vs DELETE (docs/perf/2.3-partitioning.md)
pnpm db:explain:rls    # what oms_app sees, plans under the RLS policy (docs/perf/2.4-rls.md)
pnpm db:explain:pgbouncer    # 500 clients on 20 server connections, limits, the leak (docs/perf/2.7-pgbouncer.md)
pnpm db:explain:replica      # replication lag, read-your-writes with a 5 s delay (docs/perf/2.8-read-replica.md)
pnpm db:explain:cache        # catalog cache: hit vs database, hit ratio, 200 callers on an empty key (docs/perf/2.9-cache.md)
pnpm db:explain:stock        # four ways to reserve the last unit, lock order (docs/perf/3.6-stock-locking.md)
pnpm db:explain:resilience   # the PSP call: one call, retry, retry + breaker against a failing fake-psp (docs/perf/3.11-resilience.md)
pnpm dev               # contracts (tsc --watch) + api + worker + payments + inventory + notifications in watch mode
pnpm lint && pnpm typecheck
pnpm test              # every package: Vitest project unit of api (domain, VOs, policies, use cases, adapters, architecture) of payments (adapters (MSW), policy, architecture), of inventory (domain, use cases, adapter, policy, architecture) and of notifications (domain, templates, use cases, adapter, policy, architecture) + contracts (no Docker)
pnpm --filter @oms/contracts build   # packages/contracts → dist (CommonJS + .d.ts)
pnpm contracts:freeze  # release the contracts: schema + sample of a new version into packages/contracts/released; refuses an incompatible change (ADR 0021)
pnpm contracts:check   # released/ against the merge base with CONTRACTS_BASE_REF (main): nothing deleted, no sample changed, schemas compatible
pnpm test:e2e          # Vitest project e2e of api, then of inventory, notifications and payments: *.int-spec.ts + *.e2e-spec.ts (Testcontainers), each service to its boundary
pnpm test:contract     # Schemathesis vs /docs-json in compose project oms-contract (devtools/contract)
pnpm test:system       # the four services from their images in compose project oms-system, four scenarios through the HTTP API (devtools/system; SYSTEM_KEEP_STACK=1 leaves it up, pnpm system:down removes it)
pnpm test:migrations   # guard + fresh + drift (migrate diff) + upgrade on base seed (Testcontainers)
pnpm test:rules        # promtool on the SLO recording rules (devtools/observability/rules; Docker)
pnpm demo:orders       # a client that keeps placing orders in the seeded workspace: traffic for the dashboards (-- --interval 250, --count 50)
pnpm test:mutation     # Stryker on orders domain/ + application/ + money.ts; report only (reports/mutation)
docker compose --profile app up --build   # migrate + api + worker from one image; payments, inventory and notifications each from its own, with its migrate step; alloy (the agent that takes their log lines to Loki)
```

Root `lint`, `typecheck`, `test`, `test:e2e` and `dev` build `@oms/contracts` first; run through
a filter (`pnpm --filter @oms/api …`) they need `pnpm build:contracts` once.
New migration: `pnpm --filter @oms/api exec prisma migrate dev --name <verb>_<object>`
(`@oms/payments`, `@oms/inventory`, `@oms/notifications` for their databases).

## Modules and their combinations

<!-- keep in sync with the first line of each *.module.ts -->

| Module   | Folders        | Level | Read/write     | Transports   |
| -------- | -------------- | ----- | -------------- | ------------ |
| identity | layered (flat) | L1    | CQS            | http         |
| catalog  | layered (flat) | L1    | CQS            | http         |
| orders   | layered        | L4    | CQS + EventBus | http, worker |

Process model: `src/entrypoints/main.api.ts` + `main.worker.ts`, one image. The worker has
eight entries: the BullMQ queues `orders`, `outbox`, `inbox` and `idempotency` (cron ticks
only), the broker
queues `api.inventory-events`, `api.payment-events` and `api.saga-timeouts`, and the relay of
the outbox (a timer, `infrastructure/outbox/`).

## Gotchas specific to this project

- **A message between services is a contract in `packages/contracts`** (`@oms/contracts`,
  ADR 0011): a zod schema from `defineMessage(name, version, payload)`, in an envelope with
  `messageId`, `workspaceId`, `correlationId`. The exchange names live there too (`topology.ts`).
  Consequences:
  - an incompatible change (a removed or renamed field, a new type or meaning, a new required
    field) is a new file `<name>.v<N+1>.ts`; the old one stays and `name` never changes. Only an
    optional field may be added to an existing version;
  - a new contract is added to `contracts` in `registry.ts` and exported from `index.ts`
    (`registry.spec.ts` fails otherwise);
  - a command is named after its receiver, an event after its publisher;
  - `src/` imports `zod` and its own files only (lint): no id generator, no clock, no domain
    type. The sender passes `messageId` and `occurredAt`; money is `{ amountMinor, currency }`;
  - a producer builds with `Contract.create()`, a consumer reads with `parseMessage()`, never
    with a cast;
  - a schema is never `.strict()`: a consumer must keep reading a message that gained a field;
  - the package is consumed from `dist`: build it before whatever imports it.

- **A contract is tested against its released version, and a service against the map of
  parties** (ADR 0021; `packages/contracts/released/`, `src/parties.ts`, the entry
  `@oms/contracts/testing`). Consequences:
  - a new contract also needs its row in `parties.ts` and its example in
    `testing/examples.ts`, then `pnpm contracts:freeze`: `released.spec.ts` and
    `parties.spec.ts` fail otherwise;
  - `released/` is written by `contracts:freeze` only. A released version takes one change,
    a field that is not required; the script refuses anything else and names the `v<N+1>`
    file to create. Never edit or delete a released file to get a test through:
    `contracts:check` (CI job `contracts`) compares with the base branch;
  - a new routing key in a consumer, or a new `create()` in an adapter, is a change of a row
    in `parties.ts`: `src/modules/<m>/<m>.contract.spec.ts` of the service holds the
    bindings, the consumers and the adapters to it (CTR-020, 021, 030). A new adapter that
    writes a contract gets its line in `EMITTERS` there;
  - a new version gets its readers first: a row may name a consumer before a producer, not
    the other way round. The consumers branch on `message.name` only: the first `v2` makes
    its consumers tell the versions apart (CTR-021 fails until then);
  - `src/testing/` is the only part of the package that may import `node:`; `src/index.ts`
    never imports it, and no `src/` of a service does outside its tests;
  - an upgrade of zod that changes the generated JSON Schema fails CTR-002 with no contract
    changed: the files are deleted and frozen again on purpose, in a commit of its own.

- **Every event of an order carries its recipient** (ADR 0019): `recipient { userId, email }`,
  the user who created the order, read by `OrderEventsTranslator` when it writes the
  contract. notifications-service reads these events and nothing else. Consequences:
  - a domain event of orders starts with `OrderRef` (`workspaceId`, `orderId`, `createdBy`):
    `this.ref` in `Order`. A new reliable event of an order takes it first, and its
    translation spreads `await this.addressed(event)` into the payload;
  - a translation is asynchronous (`ReliableEvents`) and runs inside the transaction of the
    use case: it may read, never call the outside. A creator identity does not know
    (`UserNotFoundError`) fails the whole write;
  - the translator asks for the address through the port `OrderRecipients`
    (`application/order-recipients.reader.ts` over `IdentityFacade`): `infrastructure/` of a
    module may not import another module (lint). The address never enters `domain/`;
  - a hand-built test module that provides `OrderEventsTranslator` provides
    `ORDER_RECIPIENTS` too (`place-order.transaction.int-spec.ts`);
  - a subscriber makes a mail of one event: what a mail has to say goes into the contract of
    that event (the amount is in `order-paid` for this reason), never "the subscriber reads
    it from the event before";
  - the life of an order on `events` is six contracts: `orders.order-placed`, `-paid`,
    `-cancelled`, `-fulfilled`, `-payment-failed`, `-returned-to-draft`. An order cancelled
    on a failed charge publishes `-cancelled` only;
  - `recipient` and the amount of `order-paid` were added to `v1` as required fields, against
    the rule above, because no message of these contracts had a reader yet. The next
    required field is a `v2`.

- **Placing an order is a saga the api orchestrates** (ADR 0017): `place → reserve stock →
charge → PAID`, a command for every step and an answer back. Its state is `OrderSaga`, a
  row of `order_sagas` per `(order, paymentAttempt)`, beside `Order`: the saga says where the
  process is, the order what the client sees (`PENDING_PAYMENT` the whole time). Consequences:
  - `place` asks for the stock, not for the charge: `payments.charge-payment` is written when
    `inventory.stock-reserved` arrives (`confirm-stock-reservation.service.ts`). A test that
    answers payments first is refused by the saga;
  - a use case of the saga loads the saga and the order, lets `OrderSaga` accept the fact
    (anything it is not waiting for is an `InvalidStateError`: acknowledged), changes the
    order, saves both and sends through `OrderSagaSteps`. Never branch on the step in a use
    case to decide whether a fact is allowed: that table is `OrderSaga`
    (`domain/order-saga.spec.ts` pins it);
  - `OrderSagaSteps.save()` writes the timeout of a step that has just begun and gives the
    saga its deadline. A step that waits without `deadline_at` is refused by a CHECK;
  - the order gets its status when the question of money is settled, not when the saga ends:
    `PAYMENT_FAILED` or `CANCELLED` come with the saga still `RELEASING`. Do not wait for
    `stock-released` to tell the client. Its event is published at that moment too
    (`order-payment-failed`, `order-returned-to-draft`, `order-cancelled`);
  - a timeout is not a failure: of the reservation it gives the order back (`DRAFT`) and
    releases in the dark; of the charge it only sends `payments.cancel-payment` and the answer
    decides (`payment-succeeded` still pays the order); of a compensation it asks again and
    logs an error. Never end a saga or release stock on a charge that was not answered;
  - `cancel` of a `PENDING_PAYMENT` order goes through `saga.requestCancel()`: 204 while the
    stock is being reserved, 202 while the charge is under way
    (`AcceptedWhenPendingInterceptor`). `TRANSITIONS` allows `PENDING_PAYMENT → CANCELLED`,
    but only `CancelOrderService` and `FailOrderPaymentService` may use it;
  - a step that changes no status is `order.note(type, …)`: a history row with
    `fromStatus = toStatus`, saved with the order, so its version goes up. A client that
    cancels reads the order first;
  - `release-stock` is safe to send for an attempt that holds nothing or was never reserved
    (inventory remembers it, ADR 0016); `cancel-payment` likewise (payments, ADR 0017);
  - out of stock is `DRAFT` with `failureReason = out_of_stock`, not `PAYMENT_FAILED`;
  - an order written past `place` needs its saga: the seed, the migration and
    `orderFactory` (`sagaStep`) write one. Without it `cancel` and every answer are
    `ORDER_SAGA_NOT_FOUND`;
  - in the e2e suite `connectTestBroker()` answers every `reserve-stock` with
    `stock-reserved` by itself, so a test about payments sees its charge;
    `{ inventory: 'silent' }` hands inventory to the test (`saga*.e2e-spec.ts`). A test waits
    for the charge command before it answers as payments (`place()` in
    `payment-flow.e2e-spec.ts`);
  - the saga timeouts are ten minutes in `.env.test`; `saga-timeouts.e2e-spec.ts` sets short
    ones for itself, and ends every saga it starts: one left in `RELEASING` asks again for
    as long as the file runs.

- **A message for later is a row of the outbox with a delay** (ADR 0017;
  `infrastructure/messaging/delay-topology.ts`). `Outbox.appendDelayed({ queue, delayMs,
message })` addresses it to `<queue>.delay.<ms>` on the exchange `api.delayed`: a queue
  nobody reads, whose messages expire and are dead-lettered to `<queue>`. Consequences:
  - a delay must be listed for its queue in `rabbitConfig.delays`: the queues are declared
    with the consumer of `<queue>`, and a delay without one is refused by the broker
    (`mandatory`), which stops the relay behind that row;
  - one queue per delay, the delay in its name. A changed delay is a new queue; the old one
    empties by itself and stays until it is deleted;
  - the wait starts when the relay publishes: at the deadline or later, never before. A
    delayed message is not cancelled; its consumer decides whether it still counts;
  - no BullMQ delayed job for something that must not be lost: Redis is not in the
    transaction;
  - `orders.saga-step-timeout` is built with `defineMessage()` but is the api's own: not in
    `@oms/contracts`, validated by its consumer with its schema, unknown to `parseMessage()`.

- **Payment is a command to payments-service and an event back** (ADR 0012). The saga writes
  `payments.charge-payment` to the outbox (`OutboxPaymentChargeAdapter`); the worker reads
  `payments.payment-succeeded` / `-failed` / `-cancelled` from `api.payment-events`
  (`PaymentEventsConsumer`) and calls `CompleteOrderPayment` / `FailOrderPayment`. Consequences:
  - the api knows nothing about the PSP: no gateway port, no `PSP_*` setting. The command
    carries the amount and the idempotency key `<orderId>:<attempt>`;
  - the routing key of a message is its `name`; a queue is declared by the consumer that
    reads it, never by a publisher;
  - `@RabbitSubscribe` only in a `*.consumer.ts`, provided only by a `*.worker.module.ts`
    (lint + `test/architecture/process-graph.spec.ts`): the api process never consumes;
  - a consumer reads with `parseMessage()` and hands the message to `handleOnce()`
    (`orders/interface/worker/handle-once.ts`), which binds the tenant from the envelope
    (`runInWorkspace`) and calls one use case through `inbox.once()`. `InvalidStateError` =
    already settled, or not what the saga waits for → return (ack). Not a known contract, or a business refusal that will not change (`NotFoundError`)
    → `throw new UnprocessableMessageError(…)`. `ConflictError` and anything that is not a
    `DomainError` → let it out;
  - the PSP call is retried and guarded by a circuit breaker inside payments (ADR 0020):
    for the api nothing changed, an answer may just come sooner. `ORDER_SAGA_CHARGE_TIMEOUT_MS`
    must stay above what payments needs with the provider away (126 s by default);
  - `MessagingModule` stands in for the library's `RabbitMQModule`, whose static state allows
    one Nest application per process; the e2e suite runs several. Do not import
    `RabbitMQModule`;
  - the command carries `expiresAt`, the deadline of the saga step: handled later, payments
    charges nothing and answers `payment-failed` with `expired`;
  - the e2e suite has neither payments-service nor inventory-service: a test reads the
    commands and publishes the answers through `test/helpers/broker.ts` (`sent()`,
    `waitForSent()`, the builders of the answers), which also subscribes to `orders.*`
    (`broker.orderEvents()`). Each test file has its own RabbitMQ vhost (`db.ts`);
  - `RABBITMQ_PREFETCH=1` in `.env.test`: one message at a time, which is what makes "the
    event before this one was handled" provable (`drained()` in `payment-flow.e2e-spec.ts`).

- **A message whose handler throws is delivered again after a delay, then parked** (ADR 0013).
  Every queue a consumer reads has `<queue>.wait.<delayMs>` and `<queue>.dlq` beside it, all
  quorum queues, all declared by `RabbitSubscribers` (`infrastructure/messaging/`).
  Consequences:
  - `@RabbitSubscribe` carries `exchange`, `routingKey` and `queue` only. The arguments of the
    queue, the error handler (`retry-or-park.ts`) and the policy come from `rabbitConfig`;
  - a queue a consumer reads needs an entry in `rabbitConfig.retry` (`configuration.ts`) with
    its own `*_MAX_ATTEMPTS` (and optional `*_RETRY_DELAY_MS`): the process does not boot
    without one;
  - never `Nack(true)` and never a retry loop in a consumer: throw. `UnprocessableMessageError`
    = parked at once; anything else = `maxAttempts` deliveries, then parked. A parked message
    is an `error` in the log and is put back by hand (management UI → Move messages);
  - the second argument of a handler is the delivery (`{ attempt, last }`,
    `@shared/messaging/delivery`), not the raw amqp message;
  - the arguments of an existing queue cannot be changed (`PRECONDITION_FAILED` at boot): a
    change is a new queue name. The delay is part of the name of the wait queue for that
    reason. A dev broker with queues from 3.2: `rabbitmqctl delete_queue <name>` once;
  - a failed message returns behind the ones published meanwhile: nothing may rely on the
    order of messages in a queue;
  - in the e2e suite a redelivery is 200 ms away and the third delivery is the last
    (`.env.test`); "everything before this was handled" is `drained()` in
    `payment-flow.e2e-spec.ts`, which also waits for the wait queue to be empty;
  - `test/helpers/failing-orders.ts` makes the worker fail to load one order: the way to
    provoke a retry without stopping the database.

- **Nothing is published to the broker from a use case or an adapter: it is written to the
  outbox** (ADR 0014; `infrastructure/outbox/`). `Outbox.append()` inserts the message in the
  current transaction and throws outside one; the relay of the worker (`OutboxRelay`, one
  pass = one transaction) publishes the rows oldest first and marks them. Consequences:
  - a command is a port called inside `@Transactional()` (`PaymentChargeScheduler` →
    `OutboxPaymentChargeAdapter`); an event is a domain event with `delivery = 'reliable'`
    given to `publishAll()`. A reliable event needs a translation into its contract,
    registered by its module (`orders/infrastructure/order-events.translator.ts`):
    `publishAll()` throws for one that has none;
  - `AmqpConnection` is injected in `infrastructure/messaging/` and
    `infrastructure/outbox/rabbit-outbox.publisher.ts` only;
  - the id of a row is the `messageId` of its envelope; `correlationId` comes from
    `CorrelationContext` (CLS): a consumer calls `continue()` inside the scope of its message;
  - at-least-once: the relay may publish a message twice, with the same id. The inbox of the
    consumer absorbs it (below);
  - one relay at a time (`pg_try_advisory_xact_lock`), and the first message that cannot be
    published stops the ones behind it: order over throughput. Do not remove the lock to go
    faster;
  - a command is published `mandatory`, and so is a delayed message: while its receiver has
    not declared its queue, the row stays unpublished and the relay logs one error. An event
    needs no subscriber;
  - a row is addressed by its exchange and the name of its message; `routingKey` is set
    only by `appendDelayed()`, to name a queue;
  - the api app alone publishes nothing: an e2e test that waits for a command or an event
    needs the worker app (`createWorkerApp()`), and `OUTBOX_POLL_INTERVAL_MS=50` in `.env.test`;
  - `outbox` is not a tenant table (no `workspace_id`, no policy), and the relay and the
    cleanup use the unscoped `PrismaService`;
  - the relay and `Outbox` are copied in `services/payments` and `services/inventory`: a
    fix in one is made in the others. The passes of the relay are tested here (`test/outbox/`).
- **A broker message takes effect once per consumer: the consumer records it in the inbox**
  (ADR 0015; `infrastructure/inbox/`, port `INBOX` in `@shared/messaging/inbox`).
  `inbox.once(queue, messageId, handle)` opens a transaction, inserts `(consumer, message_id)`
  with `ON CONFLICT DO NOTHING` and calls `handle`; the `@Transactional()` use case inside
  joins it. Nothing inserted = a duplicate: `handle` is not called, the consumer acknowledges.
  Consequences:
  - a new broker consumer wraps its use case in `inbox.once()`, inside `runInWorkspace` (the
    tenant before the transaction), with the name of its queue as `consumer`;
  - whatever `handle` throws rolls the record back too: a failed message is not "seen", and
    its next delivery is handled. Never write the record in a transaction of its own;
  - a duplicate is the same `messageId`. Another message about the same fact (payments
    answering a second command, a late answer for an old attempt) is not one: the checks by
    state stay (`InvalidStateError` → ack), do not remove them "because there is an inbox";
  - only what the transaction holds is covered: a call to the outside inside a handler needs
    an idempotency key of its own;
  - `inbox` is not a tenant table and is not partitioned (the primary key could not hold the
    time and still catch a duplicate); `cleanup-inbox` deletes records older than
    `INBOX_RETENTION_DAYS`, on its own BullMQ queue `inbox`;
  - a test that publishes "the same event twice" must reuse the message object: the helpers
    of `test/helpers/broker.ts` give every call a new `messageId`;
  - the inbox is copied in `services/payments`, where the use case records the message itself
    (`Inbox.record()` in the transaction that settles the payment). The deliveries are tested
    here (`test/inbox/`).
- **A write with no key of its own requires an `Idempotency-Key`** (ADR 0018;
  `@Idempotent()`, `common/interceptors/idempotency.interceptor.ts`, the port `IDEMPOTENCY`
  in `@shared/http/idempotency`, `infrastructure/idempotency/`). On `POST /orders` and
  `POST /orders/{id}/place`: the interceptor opens a transaction, takes
  `pg_try_advisory_xact_lock` on the key, and either returns the stored answer or runs the
  handler and stores its answer in that transaction. Consequences:
  - the use case of such a route joins a transaction that began before it. It must not rely
    on "after my `@Transactional()` returns the row is committed": nothing that acts on the
    commit (a cache invalidation, a call to the outside) belongs in it;
  - a use case that opens its transaction in a fresh CLS scope (`createWorkspace`) does not
    join, and cannot be wrapped: that is why the other creating routes have no key. Their
    unique keys refuse a repetition (409);
  - only an answered request is recorded: whatever throws rolls the key back with the rest;
  - same key, same body → the stored status and body, the handler does not run; another
    body → 422; still being handled → 409 with `Retry-After`. Never wait on the lock;
  - `@Idempotent()` is route-level on purpose: its transaction has to commit inside the
    global interceptors (`Location`, read-your-writes). Do not make it global;
  - the route must be behind the auth guard: the key is scoped to `(user, method + path)`;
  - `idempotency_keys` is not a tenant table (no `workspace_id`, no policy), and its cleanup
    uses the unscoped `PrismaService`;
  - `api.http()` in the e2e suite sends a fresh key with every request; a test about the
    key sets or unsets the header.
- **One logger, and a correlation id nobody passes** (ADR 0023; `@shared/logger/logger`,
  `infrastructure/logger/`, `common/messaging/correlation-context.ts`). A class injects
  `LOGGER` and writes `log.info({ orderId }, 'order placed')`; pino writes a JSON line with
  the `correlationId` of the work under way, read from CLS. Consequences:
  - the fields first, then a message that is the same every time: no value inside the
    message, never `Logger` of Nest or `console` (lint). An error goes under `err`;
  - never a body, a payload, a header, an email or a token: ids, codes and counts. The
    redaction of pino is a net for eleven keys at three depths, not the rule;
  - `error` means somebody has to look; a 4xx, a retry and a message that was skipped are
    `warn` at most;
  - an entry opens the chain and writes its line: `httpEntry` (the `setup` of the CLS
    middleware: `x-correlation-id` when it is a UUID, the same header on the answer),
    `RabbitSubscribers` (the id of the message), `JobScope` (a job), `OutboxRelay` (a row).
    A new kind of entry does the same; a consumer, a job class and a use case never do;
  - what runs after a handler and outside its scope (`retry-or-park.ts`, a listener of an
    event emitter) has no chain: it opens one again (`correlation.run()`), or is bound to the
    scope (`AsyncResource.bind`);
  - `correlation.run()` and `runInWorkspace()` inherit the scope around them (nestjs-cls 7),
    a transaction included; `continue()` changes the chain of the scope it is called in;
  - a use case logs nothing by hand: `@UseCase()` writes its line (name, actor, duration,
    `ok` | the code of the `DomainError` | `error`), and the error itself is logged once, by
    the exception filter or by `retry-or-park`;
  - a job enqueued from a request or a message puts `correlationId` into its **data**
    (`JobScope` reads it). Today the queues carry scheduler ticks only: each run is a chain
    of its own;
  - a class built by hand (a test, a script) takes `silentLogger` or a `RecordingLogger`
    (`@shared/logger/`); an e2e app logs to memory, and `api.logs()` / `worker.logs()` give
    the lines (`test/helpers/log-capture.ts`, `test/observability/`);
  - the process name of a line (`api`, `worker`) comes from `ProcessNameModule.is()` in the
    entrypoint module;
  - the logger and the entry of the broker are copied in the three other services: a fix in
    one is made in the others.
- **The observability stack is one container of the dev infrastructure** (ADR 0024; `lgtm`
  in `docker-compose.yml`: Grafana, Loki, Tempo, Prometheus and an OpenTelemetry Collector).
  Traces are sent since 4.3. Consequences:
  - a service sends OTLP to the Collector (`localhost:4318` under `pnpm dev`, `lgtm:4318` in
    a container) and never writes to Loki, Tempo or Prometheus itself;
  - Grafana is on 3001 of the host: 3000 is the api;
  - its configuration is inside the image: a change is a file mounted over
    `/otel-lgtm/<name>.yaml`, and a dashboard made in the UI lives in the volume only;
  - the stack of the system tests starts without it (a profile nobody asks for in
    `docker-compose.system.yml`): a service must run with no Collector;
  - metrics are pulled from `/metrics` (ADR 0027), not sent to the Collector.
- **Every process counts, and Prometheus reads** (ADR 0027; `@shared/observability/metrics`,
  `infrastructure/observability/`). A class injects `METRICS` and asks for a counter, a
  gauge or a histogram; `GET /metrics` is a server of its own on `METRICS_PORT`.
  Consequences:
  - a label takes its values from a closed set: a route pattern, a class name, a code. Never
    an id of a tenant, an order or a user, never a reason somebody else writes: every value
    is a time series for every combination of the others (`metrics.e2e-spec.ts`, MET-037);
  - an entry counts where it writes its line (`httpEntry`, `@UseCase()`, `JobScope`,
    `RabbitSubscribers`, `retry-or-park.ts`, the runner of the relay). A use case, a
    consumer and a job class never count;
  - a business metric is counted from a domain event, after the commit: its module registers
    the count in `EventMeters` (`orders/infrastructure/order-events.meter.ts`), beside the
    translation. A new event to count is a line there; a new reason of a failed payment is a
    case of `paymentFailureCause()`, or it is `declined`;
  - a duration is in seconds (`secondsSince()`), a counter ends in `_total`;
  - a fact of a store (the backlog of the outbox, the depth of a queue) is a gauge with
    `collect`, asked at the scrape, and reported by the worker only: two processes would be
    added up. A read that fails shows no value, never 0;
  - `prom-client` is imported in `infrastructure/observability/` only, and the registry is
    the application's own, not the global one: the e2e suite runs several in a process;
  - a class built by hand takes `silentMetrics` or a `RecordingMetrics`
    (`@shared/observability/`); an e2e test reads `scrape(app)` (`test/helpers/metrics.ts`),
    and waits for a count that is made after the commit;
  - a histogram keeps the trace of an observation as an exemplar, read from the active
    span: nobody passes it;
  - the pool is the adapter's: `MeasuredPrismaPg` only says which pool was made. Do not hand
    Prisma a pool of ours;
  - a new process, or a new service, is a target in `devtools/observability/prometheus.yaml`
    (both ways to run it) and a port in `DEFAULT_PORTS`; a container names `METRICS_PORT`;
  - a dashboard, a rule and the alert are files of `devtools/observability/`: what is made
    in the UI of Grafana lives in the volume only. After a change:
    `docker compose up -d --force-recreate lgtm`;
  - the port, the registry, the server and the meters of the broker are copied in the three
    other services: a fix in one is made in the others.
- **`place` has two objectives, and the first is not read from HTTP** (ADR 0028;
  `devtools/observability/rules/slo.yaml`). `POST …/place` answers 202 with the provider
  down: the success of `place` is `paid / (paid + failed by the system)`, from the business
  counters. Consequences:
  - `declined` and `out_of_stock` are the system working, and are in neither part;
  - the SLIs are recording rules of Prometheus, so that `pnpm test:rules` can hold them to
    six kinds of traffic. A change of a rule is a change of `slo.test.yaml`;
  - one alert, in Grafana, on a symptom: `PlaceSuccessRatioLow`, a mail to Mailpit. It is
    minutes late by design (the retries of the charge, the window, `for`). The other rules
    wait in the second pass of the roadmap;
  - `pnpm demo:orders` is the traffic; `docker compose stop fake-psp` is the outage.
- **A log line carries its trace, and reaches Loki in two ways** (ADR 0026;
  `infrastructure/logger/pino.logger.ts`, `src/instrumentation.ts`, `devtools/alloy/config.alloy`).
  The `mixin` of the logger adds `traceId` and `spanId` of the active span, beside the
  correlation id. Consequences:
  - `correlationId` and `traceId` are two fields on purpose: the first may come from the
    caller and follows a delayed message, a timeout of the saga begins another trace. Never
    make one stand for the other;
  - a line outside a span has no `traceId` (a tick of the relay or of a scheduler). Do not
    open a span to give a line an id. A line about a row that kept a trace is written in
    that trace (`TRACE_SCOPE` in notifications, `runInTraceContext()` here);
  - the broker library logs through `LibraryLogger` (`infrastructure/messaging/`), which
    writes its report of a handler that threw at `debug`: the line of that delivery is the
    one of `retry-or-park.ts`. Do not hand the library a plain `NestLoggerAdapter`;
  - `pnpm db:reset` leaves RabbitMQ as it was: the delayed messages of orders that are gone
    are parked with an `error` (`ORDER_SAGA_NOT_FOUND`). Purge `api.saga-timeouts.dlq` after
    a reset, it is not a defect;
  - in a container the agent `alloy` reads stdout and pushes to Loki; under `pnpm dev` the
    process sends its lines over OTLP (`OTEL_LOGS_EXPORTER=otlp` in `.env`). The setting is
    `none` in every container of a compose file: with both, each line is stored twice;
  - `logRecordProcessors` is always passed to `NodeSDK`, empty when off: left out, the SDK
    reads `OTEL_LOGS_EXPORTER` itself and its default sends;
  - the instrumentation of pino only forwards the line (`disableLogCorrelation`): the ids
    are written by our logger, so a container, a test and a host process write the same line;
  - Loki has one label, `service_name` = `service.name` of the traces = `oms-<compose
service>`. An id is never a label: `trace_id`, `span_id`, `correlationId` and `context`
    are structured metadata, under the same names in both ways;
  - a new service of the `app` profile is a name in the `keep` rule of `config.alloy`;
  - Grafana is not provisioned: the data sources of the image join Loki and Tempo by
    `trace_id` and `service_name`, and we use its names;
  - `alloy` has a profile nobody asks for in `docker-compose.system.yml`, as `lgtm` has;
  - the mixin, the exporter and the setting are copied in the three other services: a fix
    in one is made in the others.
- **A trace is one for an order, and a row that waits carries it** (ADR 0025;
  `src/instrumentation.ts`, `common/tracing/trace-context.ts`). The SDK and the
  instrumentations of `http`, `pg`, `ioredis` and `amqplib` are a preload; our code only
  keeps the context where a timer takes the work over. Consequences:
  - `src/instrumentation.ts` is loaded with `node --require`, before any entrypoint, and is
    never imported: imported later it patches nothing and nothing fails. A new way to start
    a process (a script, a Dockerfile, a compose `command`) names it. It imports
    OpenTelemetry and `trace-context.ts` only;
  - `OTEL_EXPORTER_OTLP_ENDPOINT` unset or empty = no SDK: the tests and the stacks of the
    system and contract tests run so. Never make a service wait for the Collector;
  - `Outbox.append()` stores the `traceparent` of the active span in `outbox.trace_context`
    and the relay publishes the row in it. A new table whose rows are worked off later
    (by a timer, a job, another process) keeps the trace the same way:
    `captureTraceContext()` at the write, `runInTraceContext()` at the work;
  - `appendDelayed()` stores a link, not a parent: the relay publishes such a row with
    tracing suppressed and the header `x-trace-link`, and the consumer span begins a trace
    that points back. Do not make a timeout a child: the trace of an order would last as
    long as its timeout;
  - `pg` and `ioredis` trace only inside a trace (`requireParentSpan`): the relay and
    BullMQ poll. A span that is missing under a timer has no parent: open one, do not
    switch the option off;
  - a manual span comes from `inSpan()` and exists in two places: `@UseCase()` and
    `JobScope`. A use case never opens one by hand. The manual spans of the saga steps are
    deferred (second pass);
  - a span carries ids, codes and counts, as a log line does: never a body, an address or
    an id of a user. A `DomainError` is the `outcome` of a span, not its failure;
  - a job enqueued from a request puts `traceparent` into its data, beside
    `correlationId` (`captureTraceContext()`); `JobScope` reads both;
  - a unit test that looks at spans takes `recordingTracer()`
    (`common/tracing/__test__/recording-tracer.ts`): the provider is global to the file;
  - the carrier and the preload are copied in the three other services, without the link:
    a fix in one is made in the others.
- **The system as a whole is tested by four scenarios, not by a fifth suite of rules**
  (ADR 0022; `devtools/system`, `docker-compose.system.yml`, `pnpm test:system`). All four
  services from their images, and a test that knows what a client and an operator know: the
  HTTP API, `fake-psp` and Mailpit. Consequences:
  - a new way for an order to end, or a new service on its path, is a scenario there; a rule
    of one service is a test of that service, where the test plays the other side;
  - `devtools/system` imports nothing from `services/*` or `@oms/contracts`, and reads no
    database and no queue. What it cannot see through its three windows is a finding;
  - it waits with `eventually()` only, and for the history of the order (`STOCK_RELEASED`)
    where the order of two commands matters. Never a sleep;
  - a new queue with a consumer is a line in `CONSUMED_QUEUES` (`test/setup/global.ts`): the
    run starts when every queue has its consumer, and an event published before that is lost;
  - one file, serial, on a stack built from nothing: the scenarios spend the seeded stock
    and share the provider. A scenario gives the settings of `fake-psp` back, and none uses
    `failureRate` (it would open the circuit of payments for the next ones);
  - the stack differs from the `app` profile in one setting: `PSP_TIMEOUT_MS` /
    `PSP_CALL_BUDGET_MS` of payments, so that a charge can be under way long enough to be
    cancelled;
  - a change to a compose file, a Dockerfile, a migration step or the topology of the broker
    is what this suite is for: run it by hand, CI runs it on `main` and nightly only.
- **Tenant scoping has one choke point**: `src/infrastructure/database/tenant-scope.extension.ts`.
  Tenant models (Membership, Product, Order, OrderItem, OrderEvent, OrderSaga) are filtered by the
  workspace in CLS; a query without a tenant throws. Never inject `PrismaService` for tenant
  data: its only users are the extension, identity's documented cross-tenant reads
  (`asUser`), the partition adapter in orders (table structure, no tenant rows), and the relay
  and the cleanups of the outbox, of the inbox and of the idempotency keys (rows of no tenant).
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
- BullMQ 6 rejects `:` in custom job ids (no custom id is left since the charge job went).
- `@nestjs-cls/transactional-adapter-prisma` types clash with `exactOptionalPropertyTypes`;
  the host is typed via `DbTransactionAdapter` (see `database.tokens.ts`).
- Money in JSON is `{ amountMinor, currency }`; inside the code it is `bigint` (`Money` VO).

## Deviations from the conventions templates

- `eslint.config.mjs` is the template plus six additions (3: `@oms/contracts` is a layer of
  its own, importable from `infrastructure/`, a module's adapters and its consumers only;
  4: `@RabbitSubscribe` is an entry decorator; 5: `Logger` of `@nestjs/common` is not
  imported; 6: `src/instrumentation.ts` is a root of the process, like an entrypoint). The first two: the generated Prisma client,
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
- `devtools/system` is a level of tests the conventions do not have (`quality/testing.md`
  ends at e2e with fake vendors, one service): `docs/conventions-backlog.md` §22.
- A message between services has no integration event class in `<module>/events/`
  (`events.md` §1): its contract is the schema in `@oms/contracts`. Domain events stay classes.
  Why, and what to change in the conventions: `docs/conventions-backlog.md` §1–3.
- No `docs-json` diff in CI yet (`git-pr.md` §5): the nightly Schemathesis run checks the API
  against its own OpenAPI document; a committed `openapi.json` diff comes when a client does.
- `tsconfig.json` sets `strictPropertyInitialization: false`: DTO classes are filled by
  class-transformer and Nest, never by a constructor.
- `register` and `login` take no `Actor` (the caller is anonymous); `createWorkspace` has no
  policy call, because any signed-in user may create one (`principles.md` §2.2).
- The use cases of the saga call adapters inside `@Transactional()` (`write-service.md` §4
  forbids it for a call to the outside): `StockReservationScheduler`, `PaymentChargeScheduler`
  and `SagaTimeoutScheduler` write outbox rows through `txHost.tx` and call nothing. The outbox itself differs from `transactions.md` §5 in three
  ways (relayed to a broker through a port, the row carries its address, a command goes
  through it too): `docs/conventions-backlog.md` §8.
- The outbox has entry classes in `infrastructure/` (`outbox.consumer.ts`, `cleanup-outbox.job.ts`,
  `outbox-relay.runner.ts`, wired by `outbox.worker.module.ts`): it is a technical capability
  with work of its own, not a business module. `process-graph.spec.ts` checks that the api
  process gets none of them.
- `OutboxCleanup` is called by its job directly, with no use case and no `Actor`
  (`transport/cron.md` §1 asks for a use case): one `DELETE` on a table of no tenant.
- The inbox has the same shape: entry classes in `infrastructure/inbox/` (`inbox.consumer.ts`,
  `cleanup-inbox.job.ts`, wired by `inbox.worker.module.ts`), and `InboxCleanup` called by its
  job directly. So have the idempotency keys (`infrastructure/idempotency/`).
- The `Idempotency-Key` is required on two routes, not on every creating `POST`
  (`api-conventions.md` §5 allows that), and the transaction of those routes opens in an
  interceptor, around the use case (`write-service.md`: the use case owns the transaction):
  the key and the write have to be one transaction, as with the inbox
  (`docs/conventions-backlog.md` §17).
- `outbox` and `inbox` are not partitioned and are cleaned with `DELETE` (`db-general.md` §9
  asks for `PARTITION BY RANGE` on log-like tables): `docs/conventions-backlog.md` §9.
- `PaymentEventsConsumer` calls its use case through the inbox port, so the transaction opens
  around the use case, not in it (`transport/queues.md` §3: "no transaction" in a consumer):
  the record of the message and the use case have to be one transaction, and the consumer
  still holds no logic (`docs/conventions-backlog.md` §10).
- The saga is a second aggregate in `orders`, and its use cases save it together with the
  order in one transaction (`domain-model.md` §1: the aggregate is the consistency boundary):
  a step of the process and the status the client sees must not disagree. The timeouts are
  delayed messages of the broker, not BullMQ delayed jobs as the roadmap named them. Why,
  and what the conventions lack: `docs/conventions-backlog.md` §14, §15.
- `OrderSagaSteps` is an injectable of `application/` that is not a use case: the repository
  of the saga and the three ports a step sends through, as one collaborator. Six constructor
  dependencies are the limit (`code-style.md` §2), and every use case of the saga needs these
  four.
- `ConsumerScope` (`orders/infrastructure/`) is the tenant, the correlation, the inbox and
  the logger as one collaborator of the three broker consumers, for the same limit of six.
  It is in `infrastructure/` because a transport module may not import `interface/` (lint).
- The logger of a use case is a property the injector sets (`@UseCase()`), not a constructor
  parameter (`ops/logging.md` §1: injected by token): the decorator has no constructor of
  its own, and the logger does not count against the six (`docs/conventions-backlog.md` §25).
- The line of an HTTP request is written by the `setup` of the CLS middleware
  (`ops/logging.md` §3: `pino-http` or an interceptor), and a broker delivery, a job and a
  row of the outbox are entries the conventions do not name: `docs/conventions-backlog.md` §23.
  `redact` covers three depths, not any (§24).
- The metrics differ from `ops/observability.md` §1 in five ways: a registry per application
  (not the global one), `/metrics` served outside Nest by a server that starts in the frame
  every entrypoint imports (principles #12 asks for a transport module: every process serves
  it, and a worker has no HTTP application to put it in), the entry of the broker has
  metrics the rule does not name, a business metric is counted from a domain event and not
  from a use case, and no `db_query_duration_seconds` (`docs/conventions-backlog.md` §28).
- `RabbitSubscribers` gets `METRICS` as a property (`@Inject` on a field), not through its
  constructor, which is at the limit of six (`docs/conventions-backlog.md` §25).
- The traces differ from `ops/observability.md` §3 in four ways: the instrumentations are
  listed one by one (not `getNodeAutoInstrumentations`), the context of a job is in its data
  (not in its `opts` through a BullMQ instrumentation), a trace id is not the correlation
  id, and a row of the outbox, a delayed message and a notification carry the context, which
  the conventions do not foresee (`docs/conventions-backlog.md` §26).
- `POST …/orders/{id}/cancel` has two success statuses, 204 and 202
  (`http/controller.md`: one status per route): `docs/conventions-backlog.md` §16.
- `OrderSaga` does not extend `AggregateRoot`: it records no events, and its version is
  checked by the repository only (no client holds it).
- A message contract has tests the conventions do not ask for (`quality/testing.md` §5 knows
  the HTTP contract only): the released versions, the map of parties and a
  `<m>.contract.spec.ts` per service (`docs/conventions-backlog.md` §21). The spec sits at
  the root of the module, not beside one file: it covers the consumers and the adapters of
  the module together.
- A broker consumer has no rule file of its own (`transport/queues.md` is BullMQ): ack, reject
  and prefetch replace attempts, backoff and concurrency. What we do: `docs/conventions-backlog.md` §4, §7.
- `UnprocessableMessageError` extends `InfrastructureError` and lives in `shared/errors/`,
  with `Delivery` in `shared/messaging/`: a consumer is an entry class and may not import
  `infrastructure/` (lint), and both are plain types.
- `OrderRecipientsReader` is a class of `application/` that implements a port asked by
  `infrastructure/` (`domain/ports-adapters.md` puts an implementation in `infrastructure/`):
  it reads another module through its facade, which only `application/` may do
  (`docs/conventions-backlog.md` §19).
- Orders has a repository port although Postgres is the only implementation
  (`architecture.md` §4): it lets the use-case unit tests run on the in-memory repository in
  `application/__test__/`. Details: `.claude/rules/project/testing.md`.
- `DiscountInputDto` fields carry no `@ApiProperty`: the OpenAPI shape of `discount` is the
  `oneOf` of the `Discount*Dto` doc models (`order-input.dto.ts`).
- `/workspaces/{id}` is the tenant prefix and does not count as a nesting level, so
  `/workspaces/{id}/orders/{orderId}/events` is one level deep (`api-conventions.md` §1).
