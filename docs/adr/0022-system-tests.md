# 0022 — System tests: the four services from their images, four scenarios, three windows

Date: 2026-10-09 Status: accepted

## Context

Every service is tested to its boundary (ADR 0012): the e2e suite of the api reads the
commands from the broker and publishes the answers payments and inventory would give, the
suite of payments replaces the provider, the one of notifications publishes the events of
the api. Since 3.12 each service is also held to the contracts (ADR 0021). All of it proves
a service against **what its author thinks the other side does**.

Nothing ran the system put together. The compose file of the `app` profile, the Dockerfile
of each service, its migration step, the role it connects as, the queue a service declares
and the routing key another one publishes with, `PSP_BASE_URL` and `SMTP_HOST`: each of
these could be wrong with every suite green. ADR 0012 and ADR 0019 said so and pointed here.

What such a test is called depends on where the system ends. In the monolith of Step 1 the
e2e suite was the system test. After the split the suites stayed where they were and the
system grew around them: `*.e2e-spec.ts` is now the test of one service (a component test in
other vocabularies), and the test of the whole is a level above it.

## Decision

- **A compose project of its own, `oms-system`** (`docker-compose.system.yml`, an override
  of `docker-compose.yml` with the `app` profile, like `oms-contract`): every service from
  its image, PgBouncer and the replica included, both seeds as one-shot steps. It stands
  next to the dev stack: no host port except three.
- **The test is a client and an operator, and looks through three windows**: the HTTP API,
  the payment provider (`fake-psp`: its settings and what it was asked to charge) and the
  mailbox of the user (Mailpit). No database, no queue. The package `devtools/system`
  (`@oms/system-tests`) depends on no service and not on `@oms/contracts`; the seeded ids
  and the shapes it reads are written again in it.
- **Four scenarios, one per way an order ends** (`order-lifecycle.system-spec.ts`): paid;
  declined and placed again; out of stock; cancelled while its charge is under way. Each
  link between two services carries a real message at least once. The rules of a service (a
  duplicate, a late answer, a timeout of the saga) stay where a test can play the other
  side: here nobody can make payments answer twice.
- **A compensation is proven by behaviour.** inventory has no HTTP, so "the stock was given
  back" is the second attempt of the declined order getting the last unit of its product.
  "The charge was taken back" is `voidedAt` on the charge at the provider.
- **The only wait is `eventually()`**: look again until it is there, fail with the last
  value seen. A system test cannot hold a service at a step or ask whether a queue is
  empty (`drained()` of the e2e suites has no counterpart here).
- **A scenario waits for the history of the order where the order of two commands
  matters**: `STOCK_RELEASED` before the order is placed again. Without it the release and
  the new reservation reach inventory in one pass of the relay and are handled side by side.
- **The cancellation is made deterministic by widening its window, not by accepting two
  outcomes.** The test slows the provider to 5 s, waits until the provider says a call is
  under way (`inFlight` of `GET /admin/stats`, added to `fake-psp` for this), cancels (202),
  and expects `CANCELLED` and a voided charge. For a call to last 5 s, payments of this
  stack gets `PSP_TIMEOUT_MS=10000` and `PSP_CALL_BUDGET_MS=12000`: the one setting that
  differs from the `app` profile, still inside `ORDER_SAGA_CHARGE_TIMEOUT_MS`.
- **Every other setting is the default**, the one-second relays included: how long an order
  takes through the system is one of the things the run shows
  (`docs/perf/3.13-system-tests.md`).
- **The run starts from nothing**: volumes are removed first, images are built, the test
  runs on the host (`pnpm test:system`), the stack is removed. One file, one scenario at a
  time: the broker, the databases and the settings of the provider are one for the run.
  `SYSTEM_KEEP_STACK=1` leaves the stack up to look at.
- **The stack is ready when every queue has its consumer**, asked of the broker with
  `rabbitmqctl` by the setup (not by a test). Containers that run are not services that
  listen, and an event needs no subscriber (ADR 0014): `orders.order-placed` published
  before notifications has bound its queue is a mail nobody writes.
- **The logs of every container are saved** to `devtools/system/reports/stack.log` before
  the stack goes, and uploaded by CI: "the order did not become PAID in 30 s" names none of
  the four services.
- **CI: the job `system` of the nightly workflow** (push to `main`, nightly, by hand). Not
  on a pull request: minutes of image builds for a check of the assembly, which changes
  rarely.

## Consequences

- A new way for an order to end, or a new service on its path, is a scenario here. A new
  rule of one service is not.
- A new consumer queue is a line in `CONSUMED_QUEUES` (`test/setup/global.ts`): without it
  the run may start before that service listens.
- The suite spends the seeded stock (the last unit of product 18) and reads the mailbox of
  a seeded user: it cannot run twice on one stack, and not in parallel with itself.
- The four scenarios share the provider: a scenario that changes its settings gives them
  back (`afterEach`), and none uses `failureRate`: failed calls would open the circuit of
  payments (ADR 0020) for the scenarios after it.
- Nothing promises the order of two mails (ADR 0019): a scenario compares sorted subjects.
- A red run is read in the log file, not in the assertion.
- The api, the provider and Mailpit are reached at `127.0.0.1`, not `localhost`: on Docker
  Desktop for Windows the IPv6 side of a published port answered late or not at all in the
  first minutes of a stack, and a request hung until it was reset.
- The root `package.json` and the lockfile are copied into every image before the install:
  a new root script rebuilds the dependency layer of all four. The first run after such a
  change takes minutes more.

## What it looks like

Tried on the finished suite, each change reverted afterwards. A green run is four scenarios
in about 22 s (`docs/perf/3.13-system-tests.md`).

| Change in `docker-compose.system.yml`                       | What the run shows                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PSP_BASE_URL` of payments names a host that is not there   | three scenarios red after 30 s each: "attempt 1 of order … to leave PENDING_PAYMENT", "the charge to be with the provider; last: 0". Out of stock stays green: it never reaches payments. `stack.log`: `psp charge call=1 status=none`, `delivery 1 of 4 failed, again in 30000 ms` |
| `SMTP_HOST` of notifications names a host that is not there | every order ends as it should (`place → PAID: 2.8 s`), and all four scenarios are red on "2 mail(s) to member@acme.test about order …; last: []". `stack.log` of notifications says nothing: a try that fails is a state of the row, not a log line                                 |

## Rejected

- **Testcontainers starting the four images from the test.** The compose file is what is
  deployed in this project; a second description of the stack in TypeScript would be the
  thing under test, written twice.
- **The runner as a container of the compose project** (as Schemathesis is). No host ports
  and one command, but a failing scenario cannot be run alone from the IDE, and the runner
  needs an image of its own.
- **Accepting either outcome of the cancellation** (`CANCELLED` with a void, or `PAID` when
  the cancellation came late). True to the system and worth nothing as a test: the branch
  that voids a charge would be run by luck.
- **Short relay intervals for the stack** (50 ms, as in `.env.test`). The run would be a
  few seconds faster and would measure a configuration nobody runs.
- **Reading the databases to assert.** A check of rows is the e2e suite of that service
  again. What cannot be seen through the three windows is something an operator cannot see
  either: a finding, not a reason to open a fourth.
- **The whole matrix of the saga here.** Each case would cost seconds and a place in a
  serial file, for rules the e2e suites prove in milliseconds with the other side in hand.
- **A run on every pull request.** See above; the contract tests of 3.12 are the fast check
  of the same links.

## Known gaps

- **A scenario that needs a failing service is not here**: a service stopped in the middle
  of a saga, a broker that restarts, a provider that is down. The timeouts they end in are
  minutes long by default. Step 6 (chaos).
- **The stack is not the production one**: one replica of everything, `fake-psp` and
  Mailpit in place of the outside.
- **A mail that cannot be sent is silent until it is given up.** With a wrong `SMTP_HOST`
  the run is red and the log of notifications is empty: a failed try sets `next_attempt_at`
  and logs nothing, only `FAILED` is a `Logger.error` (ADR 0019). Found here, not fixed here:
  Step 4 (a metric of pending notifications and of failed tries).
- **Readiness is asked of the broker**: the services have no health endpoint (Step 5).
- **`docker-compose.contract.yml` leaves the host ports of `postgres-inventory`,
  `postgres-notifications` and `mailpit` published**: `pnpm test:contract` next to a running
  dev stack collides on them. Not touched here.

## What 4.1 starts from

Not decisions: the state 3.13 leaves behind.

- **The system has no signal of its own that it is ready or that it is well.** The setup of
  the system tests asks the broker who listens, and a failed run is explained by reading
  the logs of fifteen containers by eye: no correlation id in them, no trace across the
  services, no metric of a relay or of a queue.
- **How long an order takes is known once, by hand** (`docs/perf/3.13-system-tests.md`):
  about three seconds from `place` to `PAID`, almost all of it relays waiting for their next
  look.
- **The stack of the `app` profile starts with one command and runs an order end to end**:
  what Step 4 instruments is there.
