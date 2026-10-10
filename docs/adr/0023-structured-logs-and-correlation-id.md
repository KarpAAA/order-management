# 0023 — Structured logs: one logger, JSON lines, a correlation id read from CLS

Date: 2026-10-10 Status: accepted

## Context

Placing one order writes log lines in five processes: the api, its worker, payments,
inventory and notifications. Until now each used the built-in logger of Nest, with the
values written into the text:

```
[Nest] 5310  - LOG [HttpPaymentGateway] psp charge call=2 status=503 durationMs=812
```

Two things were wrong with that line. It is text for a person: "every call slower than half
a second" is a regular expression per format, and what collects the logs in 4.2 filters by
fields. And it stands alone: with fifty orders under way nothing says whose call it was.

Half of the second problem was solved in Step 3 without being asked for. The envelope of
every message carries a `correlationId` (ADR 0011), the api kept it in CLS and continued it
from a consumer to the next command (ADR 0014), and the relay copied it into the AMQP
property. What was missing: the id of a request was made up when the first message was
written and never told to the caller; payments and inventory passed it as a field of a
command and did not hold it; notifications dropped it; and no log line had it.

## Decision

- **One logger per service, behind an interface** (`shared/logger/logger.ts`, the token
  `LOGGER`; pino in `infrastructure/logger/`). A class injects it and calls
  `log.info({ orderId }, 'order placed')`: the fields first, then a message that is the same
  every time. `Logger` of Nest and `console` are not imported (lint). What Nest and the
  broker library say goes through the same pino (`NestLoggerAdapter`, `app.useLogger()`).
- **A line is JSON on stdout**: `level` by name, `time`, `service` (and `process` in the api:
  `api` or `worker`), `context`, the fields, `msg`. `LOG_LEVEL` (default `info`) and
  `LOG_PRETTY` (default off; refused in production) choose the level and the form, never
  `NODE_ENV`.
- **The correlation id is added by the logger, from CLS** (`mixin`), on every line written
  inside a chain. Nobody passes it. The same store gives the id to the envelope of a
  message, so a line and the message it tells about cannot disagree. This is why the logger
  is ours and not `nestjs-pino`: that library keeps a store of its own, filled by its HTTP
  middleware, and four of the five processes serve no HTTP.
- **Every entry opens or continues the chain, and writes one line:**
  - an HTTP request: `x-correlation-id` of the caller when it is a UUID, a new id otherwise,
    and the same header on the answer (`common/http/http-entry.ts`, the `setup` of the CLS
    middleware). Only a UUID: the id goes into every message the request causes, where the
    contract requires one, and into a column of payments. The line: `method`, `route` as its
    pattern, `status`, `durationMs`, the actor;
  - a delivery of the broker: the AMQP property `correlationId`, or the one of the envelope,
    read before the body is checked against a contract (`RabbitSubscribers`, in the four
    services). The line: `queue`, `routingKey`, `messageId`, `attempt`, `durationMs`,
    `outcome`. What settles a failed message (`retry-or-park.ts`) runs after the handler,
    outside its scope, and opens the chain of the message again;
  - a BullMQ job: `correlationId` of its data, or a new id (`JobScope`). Today the queues
    carry scheduler ticks only, so every run starts a chain; the producer side is a rule,
    not code (a job enqueued from a request puts the id into its data);
  - a row of the outbox: the relay publishes it inside the chain of its envelope.
- **A use case of the api writes its own line** (`@UseCase()`): which one, for whom, how
  long, and `ok`, the code of the `DomainError`, or `error`. The error itself is logged
  once, by the entry that receives it: the exception filter (5xx at `error` with `err`, 4xx
  at `warn` with its code) or `retry-or-park`.
- **A chain that outlives its scope is kept in a row.** The mail of a notification is sent
  by a timer after the message was acknowledged: `notifications.correlation_id` keeps the id
  of the event, and the dispatcher tells about the mail inside that chain. payments did the
  same for its answers since 3.2 (`payments.correlation_id`).
- **The chain crosses the last boundary too**: payments names it to the provider
  (`x-correlation-id` on every call), and `fake-psp` logs its calls with it, in the same
  JSON shape.
- **Nothing a person could be found by, and no secret, is logged.** The rule is what is
  written: ids, codes and counts, never a body, a payload or a header
  (`ops/logging.md` §5). `redact` in pino is the net under it: eleven keys (`authorization`,
  `password`, `token`, `email`, …) at three depths. The dispatcher of notifications logs the
  reply code of the mail server, not its text, which names the address.

## Consequences

- One id finds everything an order caused: `docker compose logs | grep <id>` today, a query
  in Loki after 4.2. A client that sends `x-correlation-id` chooses that id; one that does
  not reads it from the answer.
- A field has a name and a type: `durationMs > 500` is a filter, and `msg` can be counted.
- Every class that logs takes one dependency more. Where six were there already
  (`ChargePaymentService`), the logger is injected as a property, as `@UseCase()` does it;
  the three broker consumers of orders got their four shared collaborators as one
  (`ConsumerScope`).
- The use case of the dispatcher logs nothing and returns what it tried
  (`Dispatched`): its caller knows the chain, the use case does not need to.
- A failed try of a mail is a `warn` line now ("mail not sent, the next try is due later"):
  the silence ADR 0022 found is gone, the metric it asked for is still 4.5.
- The e2e suites of the four services log to memory (`LOG_DESTINATION` replaced), so a run
  is quiet and a test can read the lines of an app (`logs()`).
- The logger, the correlation context and the entry of the broker are copied into the four
  services, like the rest of `infrastructure/` (ADR 0012): a fix in one is made in the others.

## What it looks like

`POST /v1/workspaces/…/orders/…/place` with `x-correlation-id: 0199…a1`, the provider down:

```json
{"level":"info","service":"api","process":"api","correlationId":"0199…a1","context":"UseCase","useCase":"PlaceOrderService","actor":"0198…","durationMs":14,"outcome":"ok","msg":"use case"}
{"level":"info","service":"api","process":"api","correlationId":"0199…a1","context":"Http","method":"POST","route":"/v1/workspaces/:workspaceId/orders/:orderId/place","status":202,"durationMs":19,"msg":"http request"}
{"level":"info","service":"inventory","correlationId":"0199…a1","queue":"inventory.commands","routingKey":"inventory.reserve-stock","attempt":1,"durationMs":9,"outcome":"ok","msg":"message delivered"}
{"level":"warn","service":"payments","correlationId":"0199…a1","context":"HttpPaymentGateway","operation":"charge","call":2,"durationMs":812,"err":{"type":"PaymentGatewayError","message":"PSP unreachable or timed out"},"msg":"psp call"}
{"level":"info","service":"notifications","correlationId":"0199…a1","context":"DispatchNotificationsJob","notificationId":"0199…","orderId":"0199…","kind":"order-payment-failed","sendAttempts":1,"msg":"mail sent"}
```

## Rejected

- **`nestjs-pino`.** The shortest way for an HTTP service: the request line and the request
  id come with it. It keeps its own `AsyncLocalStorage`, though, beside the CLS that already
  holds the tenant, the transaction and the correlation id of the outbox: two stores that
  can disagree, and nothing in them for a message, a job or a timer.
- **Leaving the calls as they were and replacing the logger under them** (`useLogger`
  alone). Every line would be JSON with the values still inside `msg`: the form without the
  use.
- **Passing the correlation id as a parameter** (payments and inventory did, for the
  envelope of the answer). A log line three calls below the consumer would need it handed
  down through every signature.
- **Any string as `x-correlation-id`.** A caller could put a line break into every log line,
  and the first message of the request would fail its contract.
- **A static holder for the logger of `@UseCase()`.** The e2e suite runs the api and the
  worker in one process: the last application to boot got the lines of both. The logger is
  a property the injector sets.
- **Reading the logs of the containers in the system tests** (`devtools/system`). That suite
  looks through three windows and no fourth (ADR 0022); "one id in every service" is proven
  by each service at its boundary and looked at by hand on the stack.

## Known gaps

- **A line can be found, nothing collects it**: stdout of five processes. 4.2.
- **The correlation id is not a trace**: it says that lines belong together, not which call
  caused which or where the time went. 4.3, and `traceId` on every line in 4.4.
- **`redact` matches paths, not keys at any depth** (`ops/logging.md` §1 asks for any
  depth): a secret four levels down in a logged object would pass. The objects logged here
  are flat; `docs/conventions-backlog.md` §24.
- **No BullMQ job is enqueued from a request**, so the producer side of the correlation id
  has no code and no test: the rule is in `CLAUDE.md`.
- **A notification written before the column has no chain**: its mail is logged under a new
  id.
- **`correlationId` is not in the body of an error answer**, only in the header.
- **Kafka headers**: with 3.8, second pass.

## What 4.2 starts from

Not decisions: the state 4.1 leaves behind.

- **Every process writes JSON lines to stdout** with `level`, `time`, `service`, `context`,
  `msg` and, inside a chain, `correlationId`. Nothing reads them yet.
- **The fields worth indexing are few and known**: `service`, `level`, `context`. The
  correlation id, the ids of orders and messages are values to search for, not labels: one
  per request.
- **Three kinds of line repeat with a fixed shape**: `http request`, `message delivered`,
  `use case`. Each has `durationMs` and an outcome, which is what a first dashboard can be
  built on before there is a metric (4.5).
- **`error` means somebody has to look**: a parked message, a dead job, a relay that cannot
  publish, a compensation that is not answered, an open circuit, a mail given up. That is
  the list 4.6 alerts on.
