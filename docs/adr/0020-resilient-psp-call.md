# 0020 — The call to the PSP: retried within the delivery, and not made while the provider is down

Date: 2026-10-09 Status: accepted

## Context

payments-service makes the only synchronous call to the outside in the system: `POST
/charges` (and `/void`) at the provider. Until now it was made once per delivery of the
command. A failure that may pass (5xx, 429, network, timeout) was thrown, the broker held
the command for 30 s and delivered it again, four times in all (ADR 0013). Two things were
wrong with that, both recorded as a known gap since 3.2:

- **A failure of 50 ms cost the order 30 s.** The only retry was the broker's, and its step
  is the delay of the wait queue. With a provider that fails half of its calls, every second
  order waited at least 30 s and one in sixteen ended `psp_unavailable`, with the provider
  there the whole time.
- **A provider that is down was called as if it were not.** Every command made its call,
  waited for the timeout holding one of the ten places of the consumer, and did so again on
  each delivery.

The conventions say to retry in exactly one layer, and for a call made from a queue that
layer is the queue (`transport/integrations.md` §3): retrying in both multiplies the calls
and holds the worker through the adapter's pauses. A circuit breaker is a "may".

## Decision

- **Two layers of retry, for two kinds of failure.** The gateway retries within the
  delivery: a few calls, pauses of milliseconds, for a provider that hiccups. The broker
  retries the delivery: 30 s apart, for a provider that is down, a database that is away, a
  process that died. The second was not touched. What the first gives up, it throws as the
  same retryable error as before, so the use case and the consumer did not change.

- **The retry: `PSP_MAX_RETRIES` more calls (2), after a pause that grows from
  `PSP_RETRY_INITIAL_DELAY_MS` (200) to `PSP_RETRY_MAX_DELAY_MS` (2000), with jitter.** Only
  a failure the gateway marks retryable is repeated. A decline, a refusal (other 4xx) and a
  malformed body are answers: repeating them gets the same one. The jitter is the
  decorrelated kind of the library: ten commands that failed in the same millisecond do not
  come back in the same millisecond.

- **The idempotency key is what makes the second call safe.** After a timeout nobody knows
  whether the provider charged. Every call of an operation carries the key of the command
  (`<orderId>:<attempt>`), as every delivery already did.

- **A pause the provider asks for is the pause** (`Retry-After` on a 429 or a 503, seconds
  or a date). One longer than `PSP_RETRY_MAX_DELAY_MS` is not sat out in the process: the
  operation fails at once and the command waits in the broker, where waiting costs nothing.

- **An operation has a time budget, `PSP_CALL_BUDGET_MS` (7 s), beside the timeout of one
  call, `PSP_TIMEOUT_MS` (2 s, was 3).** The budget ends a call that is under way and stops
  the retries; a pause that has begun is finished, so the worst case is the budget plus one
  pause. The command holds a place of the consumer for that long, and the saga of the api
  waits for the answer: `PAYMENTS_COMMANDS_MAX_ATTEMPTS × (budget + longest pause) + the
delays between the deliveries` = 4 × 9 s + 3 × 30 s = 126 s must stay below
  `ORDER_SAGA_CHARGE_TIMEOUT_MS` (150 s). A test of the env schema holds the defaults to it.

- **A circuit breaker counts the calls, not the operations.** The retry is outside it, so
  each call is one observation. Above `PSP_BREAKER_THRESHOLD` (0.8) failed calls among at
  least `PSP_BREAKER_MIN_CALLS` (10) in the last `PSP_BREAKER_WINDOW_MS` (10 s), the circuit
  opens: for `PSP_BREAKER_HALF_OPEN_MS` (10 s) no call is made and every operation fails at
  once, as retryable. Then one call is let through: if it passes the circuit closes, if not
  it opens again. It counts what the retry repeats and nothing else: a provider that
  declines or refuses is there.

- **The threshold is 80 %, not the usual half, because a retry stands in front of it.** A
  threshold says how bad a provider must be before a call is not worth making. Three calls
  at 50 % failures pass 87.5 % of the time: that provider is worth calling. At 0.5 the
  breaker opened on it every few seconds and 35 of 40 orders took 93 s, worse than before
  3.11; at 0.8 it stays closed there and still opens within a second on a provider that is
  down (`docs/perf/3.11-resilience.md`).

- **An open circuit ends the retries of an operation too.** The error of the breaker is not
  one the retry handles: an operation whose second call opened the circuit makes no third.

- **One breaker for the provider, in the memory of the process.** A charge and a void fail
  for the same reasons and share it. Each replica of the service finds out by itself; a
  shared state would be one more thing to be down.

- **To the use case an open circuit is "the provider is away".** It throws while a delivery
  is left and answers `psp_unavailable` on the last one (ADR 0013), without a single call.
  No new failure code: the api and the client could do nothing different with it.

- **`cockatiel`** for the retry and the breaker (the library the conventions name), in the
  adapter only. The timeout of a call stays an `AbortSignal` of `fetch`, joined with the
  signal of the budget: it ends the request and the reading of its body alike.

## Consequences

- **A hiccup is no longer the client's business.** With the provider failing half of its
  calls, 40 of 40 orders are paid and 32 at once, where 36 were paid and 25 waited 30 s or
  more (`docs/perf/3.11-resilience.md`).
- **A provider that is down gets a quarter of the calls**: 19 for 20 orders instead of 80, and
  each command is turned away in under a millisecond instead of holding its place for the
  timeout. The client sees the same as before: `PENDING_PAYMENT`, then `PAYMENT_FAILED
psp_unavailable` after the last delivery, about 93 s.
- **Between "hiccups" and "down" the breaker is a guess.** A provider that fails 80 % of
  its calls for a while is treated as down, and the charges that would have passed on a
  third call are not attempted for 10 s. To see the breaker open on a provider that fails
  half of its calls, as the roadmap asks: `PSP_BREAKER_THRESHOLD=0.5`,
  `PSP_BREAKER_MIN_CALLS=5`.
- **Up to twelve calls for one attempt** (3 × 4 deliveries) where there were four. The
  provider must be idempotent by key for all of them, and the budget is what keeps a
  delivery short.
- **An open circuit spends deliveries.** A provider down for longer than the four
  deliveries (90 s) ends every attempt of that time as `psp_unavailable`, as before.
- **The state of the circuit is seen in the log only**: opened (error), half-open (warning),
  closed. No metric, no alert (Step 4).
- **A gateway remembers.** A test that makes the provider fail builds a gateway of its own,
  or the failures of one test open the circuit of the next.
- **Conventions**: two layers of retry against "exactly one"
  (`docs/conventions-backlog.md` §20).

## Rejected

- **One layer, in the broker: several wait queues with a growing delay**, and only the
  breaker in the process. One mechanism to understand, and no multiplication. But a queue
  per delay (a message leaves a wait queue only from its head, ADR 0013), no jitter for the
  same reason, a retry that costs two publishes, a delivery and a read of the payment where
  a second `fetch` would do, and one count of deliveries shared by "the provider hiccuped"
  and "the database is away".
- **One layer, in the process.** It lives in memory and holds an unacknowledged message
  while it waits: it cannot wait 30 s, does not survive a restart, and knows nothing of a
  failure that is not the provider's.
- **A breaker that opens after N failures in a row.** At 50 % five in a row happen once in
  thirty-two calls: it would open by chance and say nothing about the share.
- **Pausing the consumer while the circuit is open**, so that no delivery is spent. The
  commands would wait in the queue instead of failing, and the api would have to tell a
  provider that is down from a service that is: its saga timeout is the only clock it has.
- **A state of the circuit shared by the replicas** (Redis): payments has no Redis, and a
  breaker that needs a network call to decide is a second thing that can be away.
- **A failure code of its own for an open circuit.** Nothing downstream would act on it.

## What 3.12 starts from

Not decisions: the state 3.11 leaves behind.

- **The contracts did not change**: no message gained a field. `payments.payment-failed`
  with `psp_unavailable` means what it meant.
- **The only HTTP between two programs of this repository is payments → fake-psp**, and
  fake-psp is not a service of the system. There is still no synchronous call between
  services for a consumer-driven contract test to pin (the deferred Pact part of 3.12).
- **The gateway is tested against MSW, and once with the service around it**
  (`test/payments/psp-resilience.e2e-spec.ts`). The path api → broker → payments → provider
  is still run by hand only (`docs/perf/3.11-resilience.md` B): ROADMAP 3.13.
