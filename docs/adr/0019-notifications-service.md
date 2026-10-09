# 0019 — notifications-service: a mail is a row first, and every mail is made of one event

Date: 2026-10-09 Status: accepted

## Context

The life of an order has been published to the `events` exchange since 3.4
(`orders.order-placed`, `-paid`, `-cancelled`, `-fulfilled`), and nobody has read it. The
roadmap gives the first reader to a fourth service that writes to the user of the order
(3.10): mails through Mailpit, no duplicate when a message is delivered again, and no mail
that depends on which event came first.

Three things make this service different from payments and inventory:

- **It is a subscriber, not a receiver.** The other two are sent commands and answer them.
  This one binds a queue of its own to an exchange the api already publishes to; the api does
  not know it exists and does not wait for it.
- **Its effect is outside the database.** A mail that left cannot be rolled back. The inbox
  (ADR 0015) makes a message take effect once _in the database_: it says so itself ("a call
  to the outside inside a handler needs an idempotency key of its own"). A mail sent inside
  `inbox.once()` goes out, the commit fails, the record of the message is rolled back, and
  the next delivery sends it again.
- **It has no state machine to hide behind.** The saga refuses what it is not waiting for
  (ADR 0017). Here every event is welcome, and the events of one order arrive in any order: a
  message whose handler failed returns behind the ones published meanwhile (ADR 0013), and
  two processes of the service take them in parallel.

And two things were missing on the side of the api:

- An order that goes back to `DRAFT` (out of stock, inventory silent) or becomes
  `PAYMENT_FAILED` published nothing (ADR 0017, known gaps). `place` answers 202 and the
  outcome comes later, up to the timeout of a saga step: the user may not be looking.
- An event named an order and nobody to write to. The address of a user is in `users`, in
  the database of the api.

## Decision

### The api

- **Every event of an order carries its recipient**: `recipient: { userId, email }`, the
  user who created the order (`Order.createdBy`), whoever acted on it. The alternatives were
  a copy of the users in notifications, fed by `identity.*` events, and an HTTP call back to
  the api. The copy brings the problem of order back (an event of an order before the event
  of its user), the call makes the mails stop when the api does, and needs an authentication
  between services that does not exist. With the address in the event, a mail needs one
  event and nothing else.
- **`orders.order-paid` carries the amount** as well, for the same reason: the mail that says
  "paid" does not read it from `order-placed`.
- **Two new events**: `orders.order-payment-failed` (`reason`, `amount`) and
  `orders.order-returned-to-draft` (`reason`: `out_of_stock` or `inventory_unavailable`).
  `Order.markPaymentFailed()` and `Order.returnToDraft()` record a reliable domain event, as
  the other transitions do.
- **The new fields are required in the existing `v1` contracts.** By ADR 0011 that is a new
  version. It is not one here because no message of these contracts was ever read, and no
  environment holds one that must survive: a dev database is reset. The next required field
  of a contract that has a reader is a `v2`.
- **The address is read by the translator, not by the use cases.** An order event is
  recorded by seven use cases; the domain event carries the id of the creator
  (`OrderRef`), and `OrderEventsTranslator` asks for the address when it builds the
  contract. A translation is asynchronous for that (`ReliableEvents`), and still runs inside
  the transaction of the use case: a user identity does not know fails the write. The
  translator is in `infrastructure/` and may not reach another module, so it asks through a
  port, `OrderRecipients`, implemented in `application/` over `IdentityFacade`. The address
  never enters the domain of orders.

### The service

- **A fourth service, `services/notifications`**, built like inventory (ADR 0016): its own
  image, one worker process, its own Postgres (`postgres-notifications`), a role
  `notifications_app` that owns nothing, the tenant as a column, `infrastructure/` and
  `shared/` copied. **No outbox**: it publishes nothing.
- **One queue, `notifications.order-events`**, bound to `events` with the six names, with
  its wait queue and its dead-letter queue (ADR 0013).
- **A mail is a row before it is a mail.** The consumer does not send. Inside
  `inbox.once()` it writes a `Notification` in `PENDING`: the record of the message and the
  mail the service now owes commit together, or neither does. A dispatcher of the same
  process sends what is due and marks it `SENT`. This is the outbox (ADR 0014) with a mail
  server in the place of the broker.

  ```
  (new) PENDING → SENT
        PENDING → PENDING     a try failed, the next one is due later
        PENDING → FAILED      the server refused it for good, or every try failed
  ```

- **Three things keep a mail from going twice**, each for another kind of repetition:

  | What repeats                                       | What absorbs it                                       |
  | -------------------------------------------------- | ----------------------------------------------------- |
  | the same message (the broker, the relay, a person) | the inbox: `(consumer, message_id)`                   |
  | another message about the same fact                | `UNIQUE (order_id, kind, attempt)` on `notifications` |
  | a dispatcher beside another one                    | `FOR UPDATE SKIP LOCKED` on the row it sends          |

  `attempt` is the payment attempt of the event, and 0 for what happens to an order once
  (cancelled, fulfilled): placed again after a failed payment, an order is told about its
  second attempt too.

- **A notice is a function of one event.** `OrderNotice` has a variant per event with
  everything its mail says; `render()` is pure. The consumer keeps nothing about an order
  and asks nothing about what came before. The mail names the order and says when the fact
  happened (`occurredAt` of the event), so one that arrives after a later one still reads
  true. The text is rendered when the event arrives and stored: what is sent is what was
  owed then.
- **The dispatcher sends one notification per transaction, with the mail server called
  inside it.** The transaction holds the row; the mail goes out; the row is marked; commit.
  Marking first and sending afterwards would lose the mail when the process dies in
  between. This order sends it twice instead, and only when the process dies between the
  answer of the server and the commit.
- **A failed try belongs to its notification, not to the queue.** It is recorded
  (`send_attempts`, `last_error`) and the next try is due after a wait that doubles
  (`NOTIFICATIONS_SEND_RETRY_DELAY_MS`); after `NOTIFICATIONS_MAX_SEND_ATTEMPTS` the
  notification is `FAILED` and an error is logged. An SMTP reply of class 5 is a refusal:
  `FAILED` at once. Unlike the relay of the outbox, nothing waits behind a mail that cannot
  go: the order of mails is not kept, on purpose.
- **Every try of one notification carries the same `Message-ID`**, made of its id. SMTP has
  no idempotency key; this is what a mail client, or a provider that looks, can recognize a
  repetition by.
- **A `Mailer` port** with one adapter, SMTP through nodemailer. The mail server is the
  thing that changes between environments (Mailpit here, a provider's API in production),
  which is what a port is for.
- **Retention**: a notification that was sent or given up is deleted after
  `NOTIFICATIONS_RETENTION_DAYS` (30) by a timer of the process: the row holds an address.

## Consequences

- The api does not know the service. Stopping it loses no mail: the events wait in its
  queue, and the notifications in its table.
- An address travels in the outbox of the api, in the broker and in `notifications`. All
  three keep it for a limited time (7 days, until consumed, 30 days).
- The user may get "paid" before "we received your order". Both are true, and each says
  when.
- Known gaps, recorded in `docs/architecture.md`:
  - **A mail can go twice**: a process that dies between the answer of the mail server and
    its commit sends that mail again, under the same `Message-ID`. Exactly once is not
    available over SMTP. A provider whose API takes an idempotency key closes it: the id of
    the notification is that key.
  - **"Sent" is "the mail server took it".** A bounce that comes later is not seen.
  - **A `FAILED` notification stays failed.** Somebody reads the log and sets the row back
    to `PENDING` by hand; Step 4 makes it an alert.
  - **The address is the one the user had when the event was written.** A user who changes
    it afterwards gets the mails of the events already published at the old one.
  - **No unsubscribe, no preferences, no language**: every event of an order is a mail in
    English to its creator.
  - **The path api → broker → notifications → mail is not run by a test**: each service is
    tested to its boundary (ROADMAP 3.13).

## What 3.11 starts from

Not decisions: the state 3.10 leaves behind.

- **A try that fails and is tried again later exists here in the simplest form**: a counter,
  a delay that doubles, a limit, on a row. No jitter, no circuit breaker: every notification
  finds out by itself that the mail server is away. `toMailDeliveryError()` is where
  "another try may help" is decided, from the SMTP reply.
- **The call payments → fake-psp still has no retry** (ADR 0012): that is the call 3.11 is
  about, and it happens before a transaction, not inside one as the mail does.
- **`Mailer.send()` promises a bounded wait** (three timeouts of `SMTP_TIMEOUT_MS`), because
  its caller holds a row. A breaker in front of it would answer at once instead.
