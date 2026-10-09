# 0013 — A failed message is delivered again after a delay, then parked

Date: 2026-10-08 Status: accepted

## Context

Since ADR 0012 one function call is two messages, and a message whose handling fails was
lost: a consumer returned `Nack(false)` for what it did not know, the connection rejected
whatever a handler threw, and the broker, told nowhere to put a rejected message, deleted it.
The cases were not rare ones:

- the database restarts while the worker records `payment-succeeded`: the charge is made, the
  order stays `PENDING_PAYMENT` for good;
- two workers get the same event, one saves, the other fails the version check;
- the provider does not answer for a few seconds: the attempt ended at once as
  `psp_unavailable`, and the user had to place the order again (PAY-006 was not implemented).

Putting the message back (`requeue`) is not an answer: it is redelivered within a
millisecond, and a failure that lasts a few seconds becomes thousands of attempts against
whatever is down.

## Decision

- **Three queues for every reader**, declared by the service that reads them:

  ```
  <exchange> ──► <queue> ──(rejected)──► <queue>.wait.<delayMs> ──(expired)──► <queue>
                    └──(given up: publish + ack)──► <queue>.dlq
  ```

  The broker cannot deliver later. A queue nobody consumes, whose messages expire
  (`x-message-ttl`) and are dead-lettered back, is the delay. The way back goes through the
  default exchange with the name of the queue, never through the exchange the message was
  published to: no other subscriber of an event gets it a second time.

- **Three ends of a message**, decided in one place (`retry-or-park.ts`):

  | What happened                                                                                 | What is done                                |
  | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
  | handled, or already handled (`InvalidStateError`)                                             | acknowledged                                |
  | `UnprocessableMessageError`: not a contract, a message of another queue, a business refusal   | parked in `<queue>.dlq` at once             |
  | anything else thrown (the database, a concurrent write, the provider, a bug), deliveries left | rejected → the wait queue → delivered again |
  | anything else thrown on the last delivery                                                     | parked in `<queue>.dlq`                     |

  Only what is known to be hopeless skips the retries. An unknown failure is retried: if it
  is hopeless too, the count stops it.

- **The broker counts.** The deliveries of a message are read from its `x-death` header
  (the entry of the queue with the reason `rejected`). Nothing is republished to count, so a
  rejection is one frame and cannot duplicate the message.

- **The policy is configuration, per queue**: `PAYMENTS_COMMANDS_MAX_ATTEMPTS` (4) and
  `PAYMENT_EVENTS_MAX_ATTEMPTS` (10), one delay `RABBITMQ_RETRY_DELAY_MS` (30 s) that a queue
  may override. The two numbers differ on purpose. A user watches `PENDING_PAYMENT` while a
  command is retried, and after the last delivery payments answers. Nobody waits for an event
  to be recorded, the charge is made by then, and giving up early only makes work for an
  operator. A queue a consumer reads without a policy does not boot.

- **The decorator names the queue; the registrar adds the rest.** `@RabbitSubscribe` is
  evaluated at import time and cannot read configuration, and the registrar
  (`RabbitSubscribers`) already starts every subscriber. It declares the wait and dead-letter
  queues, sets the arguments of the queue and the error handler, and hands the handler the
  delivery (`{ attempt, last }`) as its second argument.

- **payments answers on the last delivery.** A failure of the provider that may pass leaves
  `ChargePaymentService` while a delivery is left: the row stays `PENDING`, nothing is
  published, and the next delivery calls the provider with the same idempotency key. On the
  last one it is the outcome, `psp_unavailable`. Parking the command instead would leave the
  api without an answer; `payment-failed` is final for the attempt by contract.

- **Quorum queues.** Replicated when the broker is a cluster, the type RabbitMQ 4 recommends
  for data that must not be lost, and the only type that counts deliveries. Dead-lettering is
  `at-least-once` (with `x-overflow: reject-publish`, which the strategy requires): a message
  leaves a queue when the next one has it.

- **A message that kills its consumer** never reaches an error handler. The queue counts each
  time it takes a message back (`x-delivery-count`), and the registrar parks a message at
  `RABBITMQ_REDELIVERY_LIMIT` (10) before the handler sees it again.

- **A parked message keeps what is needed to judge it**: the body as it came, `x-parked-from`,
  `x-last-error`, and the broker's history under `x-parked-deaths`. The history moves aside
  because `x-death` is what deliveries are counted from: a message an operator puts back
  (the shovel plugins give the management UI "Move messages") is delivered afresh. Parking
  waits for the broker's confirm before the original is acknowledged.

- **`dlq: alert` stays**: a parked message is a `Logger.error`. A metric and an alert on the
  depth of the dead-letter queues come with Step 4.

## Rejected

- **`requeue`**: a hot loop (above).
- **Counting by republishing** (the consumer publishes a copy with its own attempt header to
  the wait queue and acknowledges the original): it would allow a growing delay, and it is
  two frames that can half-happen, on every failure. One delay was chosen, and with it the
  broker's count is enough.
- **Several wait queues for a growing delay**: an expired message leaves a queue only from
  its head, so each delay needs a queue of its own. Not needed for a gap of seconds; a
  provider that is down for minutes is the circuit breaker's case (3.11).
- **The delayed-message exchange plugin**: a plugin to install and operate, its delayed
  messages are not replicated, and it is not part of the RabbitMQ 4 distribution.
- **A policy instead of queue arguments**: a policy can be changed without recreating a queue,
  but it lives in the broker, apart from the code. Where it is missing, a rejected message is
  deleted and nothing fails: the defect this decision removes, silently. Arguments fail
  loudly at boot (`PRECONDITION_FAILED`), and the tests declare the same queues the same way.
- **Classic queues**: no count of deliveries, and no replication in RabbitMQ 4.
- **The broker's own delivery limit as the stop for a consumer-killing message**: measured,
  it does not work with this topology. At its limit (20) the broker dead-letters the message
  to the wait queue with the reason `delivery_limit`; from there it would return to the
  queue it came from without a rejection in between, which RabbitMQ treats as a cycle. With
  `at-least-once` the message then stays in the wait queue for good, counted in
  `messages_dlx` and invisible to a consumer. Hence the lower limit of our own, checked
  before the handler.
- **`forceDeleteAssertQueueErrorHandler`** of the library: a queue whose arguments changed
  would be deleted with its messages at boot.

## Consequences

- No message is lost to a failure of its handler; a failure that passes heals on its own.
- A transient failure of the provider no longer fails the attempt (PAY-006). The user sees
  `PENDING_PAYMENT` for up to `(attempts − 1) × delay`, 90 s by default, instead of a
  failure after 3 s.
- A failed message comes back behind the messages published meanwhile: order within a queue
  is not kept. Nothing relied on it: an event carries its payment attempt, and a stale one
  is acknowledged.
- More deliveries mean more repetitions. They are still absorbed by state (the attempt on
  the order, the unique row in payments); the inbox is 3.5.
- **The arguments of a queue cannot be changed.** A broker that has `payments.commands` or
  `api.payment-events` from 3.2 (classic, no arguments) refuses the new declaration: the
  queue is deleted once (`rabbitmqctl delete_queue`), which is acceptable while nothing is
  deployed. From here on, a change of arguments is a new queue name, with the old queue
  drained and removed.
- The delay is part of the name of the wait queue. Changing it creates a new wait queue; the
  old one hands back what it holds and stays behind empty, to be deleted by hand.
- Known gaps, recorded in `docs/architecture.md`:
  - **A command parked in payments leaves the api without an answer.** It happens when the
    last delivery fails on something other than the provider (the database of payments), or
    the command is not processable. The order stays `PENDING_PAYMENT` until an operator puts
    the message back. Closed by 3.7 (a saga step has a timeout).
  - **Nobody is told about a parked message** except through the log. Step 4.
  - **Putting a message back is manual**, through the management UI.

## What 3.4 starts from

Not decisions: the state 3.3 leaves behind, for whoever builds the outbox next.

- **Publishing still follows the commit**, on both sides (`RabbitPaymentChargeAdapter` in the
  api, `RabbitPaymentEventsPublisher` in payments). Retries made the second case milder: a
  publish that throws in payments is now redelivered, finds the row settled and publishes the
  stored outcome. A process that dies between the row and the publish is covered the same
  way only if its command was not acknowledged, which it was not.
- **The api side has no such cover**: `place` commits and publishes from an in-process event
  handler (`SchedulePaymentChargeHandler`); nothing redelivers a command that was never sent.
- **A relay will publish what consumers must tolerate twice**: the outbox is at-least-once
  as well, and both consumers already are.
- **The wiring is still copied** in `services/api` and `services/payments`
  (`src/infrastructure/messaging/`, `src/shared/messaging/`,
  `src/shared/errors/unprocessable-message.error.ts`): a change to one is made in the other.
- **`drained()` in the api's `payment-flow.e2e-spec.ts`** now also waits for the wait queue
  to be empty; a test of the relay that needs "everything before this was handled" can reuse
  it.
