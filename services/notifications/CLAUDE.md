# notifications-service

The fourth service of order-management (ROADMAP 3.10, `docs/adr/0019-notifications-service.md`).
It writes a mail to the user of an order when an event about that order arrives, once per
fact.
The root `CLAUDE.md` describes the api and the shared conventions; this file holds what differs.

## Project decisions

```
role-scope: none                # no users: an entry is a message or a timer, the only actors are system ones
authz: policy                   # NotificationsPolicy: `system:consumer:notifications` asks, `system:dispatcher:notifications` sends
ids: uuid7                      # of a notification; its fact is (order_id, kind, attempt)
cross-module-fk: n/a            # one module; `order_id`, `recipient_user_id` and `workspace_id` belong to the api: plain columns
transactions: cls               # `@Transactional()` on the use case; the consumer's joins the transaction `inbox.once()` opens
tenancy: column                 # `workspace_id` on the row; no RLS, no scoped client (ADR 0012)
db-roles: owner + notifications_app # DATABASE_ADMIN_URL migrates; DATABASE_URL reads and writes rows, no DDL; DELETE for the retention
outbox: no                      # the service publishes nothing; `notifications` is its outbox towards the mail server
broker: rabbitmq                # in: queue `notifications.order-events` on the exchange `events`; out: nothing
mail: smtp                      # nodemailer behind the port `Mailer`; dev and tests: Mailpit
queue: none                     # no BullMQ, no Redis
processes: worker               # one process: a broker consumer, the dispatcher, the cleanups of the notifications and the inbox; no HTTP
dlq: alert                      # an event given up → `notifications.order-events.dlq` + Logger.error; a mail given up → `FAILED` + Logger.error (Step 4: metric)
cron: none                      # the dispatcher and the cleanups are timers of the process
validation: zod                 # messages through `parseMessage()` of @oms/contracts; env through zod
pii-encryption: no              # `recipient_email` is kept in clear for NOTIFICATIONS_RETENTION_DAYS
logs: stdout                    # Nest built-in Logger; pino in Step 4
testing: vitest                 # projects unit + e2e; the e2e suite stops at the service boundary
```

## Commands (from the repo root)

```
pnpm db:migrate:notifications                 # prisma migrate dev on postgres-notifications (5436)
pnpm --filter @oms/notifications dev          # watch mode (needs services/notifications/.env and pnpm build:contracts)
pnpm --filter @oms/notifications test         # unit: domain, templates, use cases, adapter, policy, env, architecture, the contracts (no Docker)
pnpm --filter @oms/notifications test:e2e     # Testcontainers: Postgres + RabbitMQ + Mailpit, an event in, a row and a mail out
```

New migration: `pnpm --filter @oms/notifications exec prisma migrate dev --name <verb>_<object>`.
What was sent in dev: Mailpit, http://localhost:8025.

## Modules and their combinations

<!-- keep in sync with the first line of each *.module.ts -->

| Module        | Folders | Level | Read/write | Transports |
| ------------- | ------- | ----- | ---------- | ---------- |
| notifications | layered | L4    | together   | worker     |

Process model: `src/entrypoints/main.worker.ts`, one image (`services/notifications/Dockerfile`).

## Gotchas specific to this service

- **The consumer never sends.** `OrderEventsConsumer` → `inbox.once()` →
  `RequestNotificationService` writes a `Notification` in `PENDING`, and that is all: a mail
  cannot be rolled back with the record of its message. `DispatchNotificationsJob` sends what
  is due. Do not call `Mailer` from the consumer or from `RequestNotificationService`.
- **A notice is made of its own event.** `OrderNotice` has a variant per event with
  everything its mail says, and `render()` is a pure function of it. The events of one order
  arrive in any order: never look for another notification of the order, never keep "the
  status of the order", never wait for an event. A mail that needs more needs it in the
  contract (`packages/contracts/src/orders/`), put there by the api.
- **One notification per fact: `UNIQUE (order_id, kind, attempt)`.** `insertIfAbsent()` is
  `ON CONFLICT DO NOTHING` and returns `false` for a fact that is already owed; that is not
  an error. `attempt` is the payment attempt of the event, 0 for what happens to an order
  once. A new kind of notice chooses its attempt in `attemptOf()`.
- **Three things absorb a repetition, each another kind**: the inbox (the same message), the
  unique key (another message about the same fact), the row lock of the dispatcher (two
  processes). Do not remove one "because the other is there".
- **The dispatcher calls the mail server inside its transaction**, one notification per
  transaction (`DispatchNotificationService`). The row is held by `FOR UPDATE SKIP LOCKED`
  until the commit. Marking the row before the send, in a transaction of its own, would lose
  the mail of a process that dies in between. The transaction has 45 s; `SMTP_TIMEOUT_MS`
  is 10 s at most, three times over. Raise one only with the other.
- **A mail can still go twice**: the process dies between the answer of the server and the
  commit. Every try carries the same `Message-ID` (`<notificationId@notifications.oms>`).
  Known gap, `docs/architecture.md`.
- **A try that fails is a state of the notification, not an exception.** `markSendFailed()`
  counts it and sets `next_attempt_at` (the delay doubles), or gives up: `FAILED`. Only
  `MailDeliveryError` with `retryable = false` (an SMTP reply of class 5,
  `toMailDeliveryError()`) gives up at once. A `FAILED` row is put back by hand:
  `UPDATE notifications SET status = 'PENDING', next_attempt_at = now(), settled_at = NULL`.
- **Nothing keeps the order of mails.** The dispatcher takes the notification that has
  waited longest, and one that waits for its next try does not hold the others. Unlike the
  relay of the outbox, there is no advisory lock and no "the first failure stops the pass".
- **The tenant is a column.** A notification is stored with the workspace of the envelope.
  `lockNextDue()` and the cleanup read across workspaces on purpose.
- **Three queues**: `notifications.order-events`, `.wait.<delayMs>`, `.dlq`, declared by
  `RabbitSubscribers` from `rabbitConfig.retry`. The queue is bound with the six names of
  the order events; a new event the service should tell about is a routing key in
  `OrderEventsConsumer`, a variant of `OrderNotice` and a case in `templates.ts`.
- **`infrastructure/` and `shared/` are copies** of inventory's, without the outbox. A fix in
  one copy is checked against the others. Nothing is imported from another service.
- **A new table** needs `GRANT … TO notifications_app` in its migration.
- CHECK constraints (`notifications_pending_is_due`, `notifications_settled_shape`) live in
  the migration SQL; Prisma cannot express them and `migrate diff` does not see them.
- **The e2e suite**: each test file has its own database and RabbitMQ vhost; the mail server
  (Mailpit) is one for the run, so a test asks for its mails by recipient and gives every
  user an address of its own (`newRecipient()`). Mailpit accepts `@example.test` only: an
  address elsewhere is refused with a 550, which is how a test meets a refusal. One process
  takes one event at a time (`RABBITMQ_PREFETCH=1`), which is what makes `handledUpTo()` a
  proof. `delivery.e2e-spec.ts` sends through `helpers/smtp-gate.ts`, a port of its own in
  front of Mailpit that can be closed and opened while the service runs.
- **The service is held to its rows of the map of parties** (ADR 0021;
  `notifications.contract.spec.ts`): what the queue is bound to, and a released message of
  each event through the consumer. A new event to tell about is a row in
  `packages/contracts/src/parties.ts` first.

## Deviations from the conventions templates

- The dispatcher calls an adapter (`Mailer`) inside `@Transactional()` (`write-service.md` §4
  forbids it): the transaction is what holds the row while its mail goes out
  (`docs/conventions-backlog.md` §18).
- `DispatchNotificationsJob` and `CleanupNotificationsJob` are `*.job.ts` classes driven by a
  timer of the process, not by a BullMQ schedule (`transport/cron.md`): the service has no
  queue. They are named jobs so that only the worker module may wire them (lint: an entry
  class).
- `CleanupNotificationsJob` calls `NotificationsCleanup` directly, with no use case and no
  `Actor` (`transport/cron.md` §1 asks for a use case): one `DELETE`, as the cleanup of the
  inbox.
- `Notification` does not extend `AggregateRoot`, records no domain events and has no
  `version`: its only writer after birth holds its row.
- `DELIVERY_POLICY` (tries and delay) is a value bound by the module from the configuration
  and injected into the use case: `application/` may not import `config/`.
- Repository and mailer ports although each has one implementation: the use cases have unit
  tests on in-memory doubles (`application/__test__/`), and the mail server is the thing
  that differs between environments.
- The use cases are `@Injectable()` with `@Transactional()`, without the `@UseCase()` decorator
  of the api: the service has no `common/` and no in-process events to hold back until commit.
- The cleanups are timers in the process, not scheduled jobs (`transport/cron.md`).
- One migration, no migration checker and no mutation run (`docs/architecture.md` → Known gaps).
- `Actor` is a system actor only; `role-scope`, guards and HTTP rules do not apply.
