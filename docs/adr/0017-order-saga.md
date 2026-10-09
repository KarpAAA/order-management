# 0017 — Placing an order is a saga orchestrated by the api, its timeouts are delayed messages of the outbox

Date: 2026-10-10 Status: accepted

## Context

Placing an order now needs two other services: inventory holds the stock (3.6), payments
charges (3.2). No transaction spans the three databases. Until now `place` asked for the
charge and waited; where the process stood could only be read from the status of the order.
With a second step that is no longer enough:

- **A step that succeeded has to be undone when a later one fails.** Stock that is held for
  an order whose charge was declined stays held for ever.
- **An order waits for ever when nobody answers.** A command parked in the dead-letter queue
  of its receiver is answered only when an operator puts it back (known gap since 3.3).
- **`PENDING_PAYMENT` could not be cancelled** (known gap since Step 0): the cancellation
  would race with a charge that is under way.
- **There was no "out of stock"**: an order for a product that is not there was charged.

## Decision

- **Orchestration, in the api.** The api knows the whole process, sends a command for every
  step and reads the answer; inventory and payments know nothing of each other. The commands
  go through the outbox (ADR 0014), the answers through the inbox (ADR 0015).

- **The state of the process is a row of `order_sagas`, one per `(order, paymentAttempt)`.**
  A domain object of its own (`OrderSaga`), beside `Order`, in the module `orders`: the saga
  says where the process is, the order says what the customer sees. Placed again, an order
  starts a new saga, and a late answer of the old one finds the old row.

  ```
  RESERVING ──reserved──► CHARGING ──succeeded──► COMPLETED
      │ refused               │ failed ──────────────────────┐
      ▼                       │ timeout / cancel             ▼
   ABORTED                    ▼                          RELEASING ──released──► ABORTED
                      CANCELLING_PAYMENT ──cancelled / failed─┘
                              └──succeeded──► COMPLETED
  ```

  | What arrives                      | Saga                                           | Order                                     | Sent                              |
  | --------------------------------- | ---------------------------------------------- | ----------------------------------------- | --------------------------------- |
  | `place`                           | → `RESERVING`                                  | `PENDING_PAYMENT`                         | reserve-stock                     |
  | stock-reserved                    | `RESERVING` → `CHARGING`                       | —                                         | charge-payment (with `expiresAt`) |
  | stock-reservation-failed          | `RESERVING` → `ABORTED`                        | `DRAFT`, `out_of_stock`                   | —                                 |
  | payment-succeeded                 | `CHARGING`, `CANCELLING_PAYMENT` → `COMPLETED` | `PAID`                                    | —                                 |
  | payment-failed, payment-cancelled | `CHARGING`, `CANCELLING_PAYMENT` → `RELEASING` | `PAYMENT_FAILED`, or `CANCELLED` if asked | release-stock                     |
  | stock-released                    | `RELEASING` → `ABORTED`                        | —                                         | —                                 |
  | timeout of `RESERVING`            | → `RELEASING`                                  | `DRAFT`, `inventory_unavailable`          | release-stock                     |
  | timeout of `CHARGING`             | → `CANCELLING_PAYMENT`                         | —                                         | cancel-payment                    |
  | timeout of a compensation         | stays                                          | —                                         | the same command again, an error  |

  Every step that waits also writes its timeout. Anything that is not in the table is an
  `InvalidStateError`, which a consumer acknowledges: that is what makes an answer given
  twice, a late one and one for an earlier attempt harmless. Two messages of one saga at once
  meet at its `version`; the loser is delivered again and finds the step moved.

- **The charge is the pivot.** Before it everything can be undone (a reservation is released);
  after it nothing is left that can fail for a business reason.

- **The order leaves `PENDING_PAYMENT` as soon as the question of money is settled**, not
  when the saga ends: a declined order is `PAYMENT_FAILED` at once and can be placed again
  while the release of its stock is still on its way.

- **Out of stock gives the order back as a `DRAFT`**, with `failureReason = out_of_stock` and
  the shortages in its history. No charge was attempted, so `PAYMENT_FAILED` would be untrue,
  and what the customer does next is change the quantity.

- **A timeout says "I did not hear", never "it did not happen".** What follows depends on
  what an answer that is still on its way could mean:
  - _the reservation_: no money can have moved. The order goes back to `DRAFT` and a release
    is sent in the dark; inventory records it and a reservation that arrives later holds
    nothing (ADR 0016);
  - _the charge_: money may have moved, so nothing is decided on this side. The saga sends
    `payments.cancel-payment` and waits: payments ends an attempt that is still open and says
    so, or answers with how it had ended. A charge that was made first wins;
  - _a compensation_: the question cannot be answered from here. It is asked again on every
    timeout and an error is logged. The saga never ends "in the dark".

- **A charge command expires.** `payments.charge-payment` carries `expiresAt`, the deadline
  of the step. Payments charges nothing for a command it handles later: a service that was
  down for ten minutes does not charge a customer who gave up nine minutes ago, although the
  charge is in front of the cancellation in its queue.

- **payments can cancel an attempt, and take a charge back.** `cancel-payment` ends a
  `PENDING` row as `CANCELLED` in one transaction. It may be the first thing payments hears
  of the attempt: the row is then written without an amount, and the charge command finds
  it. A call to the provider that was in flight is voided when it returns
  (`services/payments/CLAUDE.md`).

- **Cancelling a `PENDING_PAYMENT` order is a request to its saga.** While the stock is being
  reserved the order is `CANCELLED` at once (204) and a release is sent in the dark. While
  the charge is under way the request is remembered and `cancel-payment` is sent (202): the
  order becomes `CANCELLED` when payments says nothing was charged, and `PAID` when the
  charge was first.

- **A timeout is a delayed message of the outbox, not a BullMQ job.** The roadmap named a
  delayed job. A job is a second write, to Redis, beside the transaction that begins the
  step: a process that dies between the two leaves a step that waits without a limit, which
  is the gap this item closes. The outbox already solves that for the broker, so the timeout
  is one more row: `Outbox.appendDelayed()` addresses it to `<queue>.delay.<ms>` on the
  exchange `api.delayed`, a queue nobody reads whose messages expire and are dead-lettered to
  `api.saga-timeouts`. The same means as the retries of ADR 0013, and the same guarantees:
  quorum queues, `at-least-once` dead-lettering, published `mandatory`.
  - a delay is a queue of its own (the delay is part of the name), so a message never waits
    behind one with a longer delay;
  - the wait starts when the relay publishes: a timeout goes off at its deadline or later,
    never before;
  - a timeout is not cancelled when its step is answered. It arrives, finds the saga in
    another step and is acknowledged.

- **The timeout message is the api's own**: `orders.saga-step-timeout`, built with
  `defineMessage()` and validated by its consumer with its schema, but not in the registry
  of `@oms/contracts`. No other service sends or reads it.

- **The history of the order tells the steps**, the ones that change no status as well:
  `STOCK_RESERVED`, `STOCK_RELEASED`, `PAYMENT_TIMED_OUT`, `CANCELLATION_REQUESTED` are rows
  with `fromStatus = toStatus`. They are written by saving the order, so they bump its
  version like any other write.

## Rejected

- **Choreography**: inventory listens to `orders.order-placed`, payments to
  `inventory.stock-reserved`. No service would hold the process, and "what happens to an
  order nobody answered" would have no owner.
- **The step of the saga as columns of `orders`.** One row less to load, but the order would
  carry the state of one attempt only, and a late answer of an earlier attempt would have
  nothing to be refused by.
- **A BullMQ delayed job for the timeout**, with `deadline_at` as the truth and a sweeper for
  the jobs that were lost: three mechanisms for what one outbox row does. The sweeper would
  also have to read the sagas of every tenant, past Row-Level Security.
- **Giving up on a charge when its timeout goes off** (`PAYMENT_FAILED`, release the stock)
  and refunding a success that arrives later. The customer sees a charge and a refund, and
  the stock may be sold in between.
- **Waiting for the answer to the reservation before cancelling.** Not needed: a release
  that gets to inventory first is remembered there.
- **`PAYMENT_FAILED` for out of stock**, with the reason in `failureReason`: the status would
  say something that did not happen.
- **A limit on how often a compensation is asked for again.** After the last one the saga
  would end without knowing, or stay silent. An operator is told on every repetition instead.

## Consequences

- An order is never charged for stock that is not held, and stock is never held for an order
  that was not paid, once every message has been handled. Between the steps the world sees
  the half that is done: stock is held before the charge, and an order is `PAYMENT_FAILED`
  before its stock is free.
- `PENDING_PAYMENT` is the lock of the order while its saga runs: no edit, no second
  placing. The domain allows `cancel` from it; whether that is safe is the saga's decision,
  so `CancelOrderService` asks it.
- One more round trip before the charge: `place` → reserve → charge.
- Every answer bumps the version of the order (a history row). A client that cancels must
  read the order first; `place` returns no version anyway.
- A saga whose compensation is never answered asks again every
  `ORDER_SAGA_COMPENSATION_TIMEOUT_MS`, for as long as it takes. Each repetition is a command
  in the queue of a service that is down, and an error in the log.
- `ORDER_SAGA_CHARGE_TIMEOUT_MS` has to exceed what payments needs when the provider is
  away (every delivery of the command with its delays): a charge that would have gone
  through on a later delivery is given up otherwise.
- A changed timeout is a new delay queue. The old one empties by itself and stays until it
  is deleted.
- The outbox of the api may now address a queue (`routingKey`), not only an exchange by the
  name of the message. The copies in payments and inventory do not need it.
- Known gaps, recorded in `docs/architecture.md`:
  - **A void that fails on the last delivery of its charge command** leaves a cancelled
    attempt charged at the provider, with the command parked. Part of "no reconciliation
    with the PSP".
  - **Orders written past `place`** (datagen) have no saga: they cannot be cancelled, and an
    answer for them is parked. The seed and the test factory write one.
  - **Nothing takes the units of a paid order out of the stock**: they stay reserved (3.6).
  - **`inventory.adjust-stock` still has no sender.**

## What 3.10 starts from

Not decisions: the state 3.7 leaves behind, for whoever builds notifications-service next.

- **The events of an order on `events` are unchanged**: `orders.order-placed`, `-paid`,
  `-cancelled`, `-fulfilled`. An order that goes back to `DRAFT` (out of stock) or becomes
  `PAYMENT_FAILED` publishes nothing: a mail for those needs a new reliable domain event
  and its translation (`order-events.translator.ts`).
- **`orders.order-placed` is published when the order is placed, before its stock is
  reserved**: "we received your order", not "your order is confirmed".
- **`orders.order-cancelled` may follow `orders.order-placed`** now, and `order-paid` may
  follow a cancellation that was asked for and came too late.
- **A message a service sends to itself for later** is `Outbox.appendDelayed()` with a queue
  in `rabbitConfig.delays`: a reminder mail would be one.
- **`handleOnce()`** (`orders/interface/worker/`) is what a broker consumer of the api does
  around its use case; it is not shared with the other services.
