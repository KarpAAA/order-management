# 0015 — A consumer records the messages it has handled, in the transaction of their effect

Date: 2026-10-08 Status: accepted

## Context

A message reaches its consumer at least once. The broker delivers it again when the
acknowledgement was lost or the handler threw (ADR 0013), the relay of the sender publishes
it again when it died between the confirm and its commit (ADR 0014), and an operator may put
a parked message back. All of these carry the same `messageId`.

Until now both consumers absorbed a repetition by state: the api acknowledges an event for
an order that is no longer `PENDING_PAYMENT` or for another attempt, payments finds the row
of the attempt settled. That works because both have a state with transitions. The consumers
that come next do not: reserving stock twice reserves two units (3.6), a mail sent twice is
two mails (3.10). And it holds only as long as every use case is written with that in mind.

## Decision

- **Each service has a table `inbox`**: `(consumer, message_id)` as the primary key and
  `processed_at`. A row says that this consumer has handled this message.

- **The row is written in the transaction of what the message causes.** Both are committed or
  neither is:

  | Order of the two writes                    | A crash in between                            |
  | ------------------------------------------ | --------------------------------------------- |
  | the record, commit, then the effect        | recorded, never done: the message is lost     |
  | the effect, commit, then the record        | done, not recorded: the next delivery repeats |
  | read the record, the effect, then write it | two deliveries at once both pass the check    |
  | the record and the effect, one transaction | none of the above                             |

- **A duplicate is an insert that inserts nothing** (`createMany` with `skipDuplicates`, that
  is `ON CONFLICT DO NOTHING`), not a caught unique violation: an error would abort the
  transaction. The insert comes first in the transaction, so two deliveries of one message at
  the same moment meet at the primary key: the second waits for the first, then finds its row
  (a duplicate) or, after a rollback, no row, and handles the message itself.

- **`consumer` is the queue the message was read from.** One event of the exchange `events`
  will be read by several queues, and each of them handles it once.

- **api: the consumer wraps its use case.** `Inbox.once(consumer, messageId, handle)` opens
  the transaction, records the message and calls `handle`; the `@Transactional()` use case
  inside joins that transaction. The consumer binds the tenant first, as before: the
  transaction of the inbox is the one that tells Postgres its tenant. The port lives in
  `shared/messaging/` and its implementation in `infrastructure/inbox/`, because a consumer
  is an entry class and may not import `infrastructure/`.

- **payments: the use case records the message itself.** Its transaction is only its last
  step, after the call to the provider, which must stay outside any transaction. So
  `ChargePaymentCommand` carries the message id and the queue, and `Inbox.record()` is the
  first statement of the transaction that settles the payment and writes the answer. The use
  case has one entry, the consumer, so the message id in its command costs nothing.

- **payments no longer answers the same message twice.** Before 3.4 the answer could be
  lost, so a repeated command was answered again. Now the answer is committed with the
  settled row, and the same message again finds its record and does nothing. Another message
  for the same attempt (a new message id) is still answered with what is stored.

- **Not a tenant table**: no `workspace_id`, no Row-Level Security, like `outbox`. A row is an
  id and a time, there is nothing of a tenant in it to protect, and the cleanup deletes the
  rows of every tenant.

- **Not partitioned, cleaned with `DELETE`.** Retention is `INBOX_RETENTION_DAYS`, 7 days: a
  repetition comes within seconds or, from a dead-letter queue, when an operator gets to it.
  In the api a daily BullMQ job on a queue of its own (`cleanup-inbox`); in payments a timer
  of the process (`INBOX_CLEANUP_INTERVAL_MS`). A message that comes again after its record
  is gone is handled again, and then only state protects.

## Rejected

- **Partitions by time** (`data/db-general.md` §9 asks for them on log-like tables): the
  partition key must be part of the primary key, and `(consumer, message_id, processed_at)`
  no longer makes the same message a duplicate. Partitioning by the time of the sender
  (`occurredAt`) keeps the key, at the price of trusting another service's clock and of a
  write error for an old message with no partition. The row is small and the retention short.
- **A status on the row** (`received → processing → done`), to continue a handler that died
  between its steps. Where a handler has steps, the progress belongs to what it changes: the
  row of the payment is `PENDING` until the provider has answered. A process across services
  is the saga of 3.7.
- **`workspace_id` and a policy on the table**: nothing to isolate, and the cleanup would need
  a loop over the workspaces or a `SECURITY DEFINER` function.
- **The message id in the commands of the api's use cases**: the same use case serves HTTP,
  which has no message.
- **Dropping the checks by state**: a message with a new id about the same fact is not a
  duplicate to the inbox.

## Consequences

- A message takes effect once per consumer, whatever the use case behind it does. A handler
  with no state of its own to check is safe from the first day.
- Two layers now. The inbox absorbs the same message again; state still absorbs another
  message about the same fact (the answer of payments to a second command, a late answer for
  an old attempt). `InvalidStateError` is still acknowledged as "already done"; such a message
  is not recorded, because its transaction was rolled back, and the next copy is refused by
  state again.
- Only what is in the transaction is covered. A call to the outside made by a handler (the
  provider, a mail server) is repeated when the transaction fails after it, and needs a key
  of its own: the idempotency key of the charge stays.
- One more insert per message, and two deliveries of one message at once serialize on it.
- A failed handler leaves no record: the retry of ADR 0013 handles the message as if it had
  never come.
- The inbox is copied in both services, like the outbox. Its behaviour delivery by delivery
  is tested once, in the api (`test/inbox/inbox.int-spec.ts`).

## What 3.6 starts from

Not decisions: the state 3.5 leaves behind, for whoever builds inventory-service next.

- **A new consumer in the api** injects `INBOX` and wraps its use case in
  `inbox.once(<its queue>, message.messageId, …)`, inside `runInWorkspace`.
- **A new service** copies `infrastructure/inbox/` with the table and its grant. If its use
  case is one transaction, the consumer can wrap it as in the api; if it calls the outside
  first, as payments does, the use case records the message in its last transaction.
- **`ReserveStock` delivered twice** is the first command whose handler has no state that
  absorbs a repetition: the inbox is what makes it one reservation.
- **`failInsertsInto(table)`** (`services/payments/test/helpers/`) makes one write of a
  transaction fail inside Postgres: the way to prove that a set of rows commits together.
