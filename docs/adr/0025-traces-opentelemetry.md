# 0025 — Traces: OpenTelemetry, and a context that survives a row

Date: 2026-10-12 Status: accepted

## Context

A correlation id (ADR 0023) says that lines of five processes belong to one piece of work.
It does not say what caused what, or where the time went: a query, a publish, a wait for the
relay and a call to the provider are not lines. A trace is that picture: a tree of spans
with one trace id, each knowing its parent. The store for it is there since ADR 0024.

Inside a process the context travels by itself (`AsyncLocalStorage`, as CLS does). Between
processes it is the W3C header `traceparent`, written by the sender and read by the
receiver. The instrumentations of `http`, `pg`, `ioredis` and `amqplib` do both.

They do not help where this system is built on purpose to let go of the request: work that
is written to a table and done later by a timer of another process. There are three such
places: the `outbox` of api, payments and inventory, the delayed messages of the saga, and
`notifications` (a row, then the dispatcher). The relay that publishes a row has no context
of the request that wrote it, so every hop through the broker would begin a trace of its own.

## Decision

- **The SDK is a preload**: `src/instrumentation.ts` in each service, loaded with
  `node --require ./dist/instrumentation.js` before any entrypoint (scripts, Dockerfiles,
  compose). An instrumentation replaces functions of a library when the library is required;
  required earlier, nothing is traced and nothing fails. The file imports OpenTelemetry and,
  in the api, one file of ours that imports nothing else.
- **No Collector named, no tracing**: `OTEL_EXPORTER_OTLP_ENDPOINT` unset or empty and the
  SDK does not start. `http://localhost:4318` under `pnpm dev`, `http://lgtm:4318` in the
  `app` profile, empty in the stacks of the system and contract tests.
- **One service name per process**: `oms-api`, `oms-worker` (one image, told apart by the
  entry file), `oms-payments`, `oms-inventory`, `oms-notifications`.
- **Instrumentations, one package each**: `http` and `nestjs-core` (api), `pg`, `ioredis`
  (api), `amqplib`, `undici` (payments: the `fetch` to the provider). `pg`, `ioredis` and
  `undici` trace only inside a trace: the relay and BullMQ ask the database and Redis
  several times a second with nobody waiting.
- **A row keeps the trace it was written in.** `outbox.trace_context` (jsonb, nullable):
  `Outbox.append()` stores the `traceparent` of the active span, and the relay publishes the
  row in that context, so the publish span, the `traceparent` of the message and everything
  its consumer does are children of the request. One trace from `place` to the mail.
- **A delayed message points at its trace and does not continue it.** `appendDelayed()`
  stores the `traceparent` as a link. The relay publishes such a row with tracing
  suppressed and the header `x-trace-link`; the consumer span begins a trace, and the
  `consumeHook` of the amqplib instrumentation adds the link. A timeout of the saga is due
  in ten minutes: as a child it would stretch the trace of every order to ten minutes.
- **A notification keeps it too**: `notifications.trace_context`, written by the repository
  with the row; the dispatcher hands it to the mailer, and `SmtpMailerAdapter` opens a manual
  span `smtp send` in it. nodemailer has no instrumentation.
- **A BullMQ job carries `traceparent` in its data**, beside `correlationId`, and `JobScope`
  runs the job as a span of it. A scheduler tick has none: its span begins a trace.
- **A use case is a span** (`@UseCase()`, api): the name of the class, `actor.kind`, and the
  outcome of its log line. A `DomainError` is an outcome; only anything else marks the span
  as failed.
- **Everything is sampled.** A dev stack with one user; a ratio is a decision of a deploy.
- **The same rule as for logs**: ids, codes and counts in a span. No body, no address. The
  `pg` instrumentation records the text of a statement, not its parameters.

## Consequences

- Four migrations (one nullable column each). A row written before them, or outside a
  trace, is published as before.
- The correlation id stays: a caller may name it, and every line has it whether or not a
  trace is sampled. They are two ids until 4.4 decides.
- The outbox and its relay are copies in three services, and the carrier
  (`trace-context.ts`) in four: a fix in one is made in the others.
- A span appears after its parent ended (the relay publishes later). Tempo shows it as it
  is: the gap is the wait for the relay.
- A redelivery through the wait queue keeps the headers of the message: every delivery is a
  span of the same trace.

## What it looks like

```
api      POST /workspaces/:id/orders/:id/place        ██
api        PlaceOrderService ─ pg: … INSERT outbox
worker       publish commands (reserve-stock)           ░█   ← the wait for the relay
inventory      process ─ pg ─ publish events              ██
worker           process api.inventory-events               ██
payments           process ─ POST fake-psp /charges           ████
worker               process api.payment-events                   ██
notifications          process order-paid ─ … ─ smtp send            ██

another trace, ten minutes later, with a link to the one above:
worker   process api.saga-timeouts
```

## Rejected

- **A span link at every hop of the outbox.** Honest about "the request ended", and six
  traces to click through for one order. The roadmap asks for one waterfall.
- **The timeout as a child.** One trace, ten minutes wide, with the two seconds that matter
  in its first pixel.
- **`import './instrumentation'` as the first line of an entrypoint.** It works until the
  import order rule of the linter moves it, and then nothing says so.
- **`getNodeAutoInstrumentations()`.** Some forty packages for five libraries, and spans of
  `fs`, `dns` and `net` to switch off one by one.
- **`bullmq-otel`**, which keeps the context in the options of a job. The queues carry
  scheduler ticks only; the data of the job already carries the correlation id, and one
  place (`JobScope`) reads both.
- **Tracing `fake-psp`.** A real provider sends nothing to our Tempo; the client span of the
  call shows its time.

## Known gaps

- **No test runs the whole path.** The unit tests hold the context through the row, the
  relay, the publisher, `JobScope`, `@UseCase()` and the mailer. That the preload is loaded
  first, and what the waterfall of four services looks like, was checked by hand: a span
  sent by `node --require ./dist/instrumentation.js` was read back from Tempo. The planned
  e2e test of the api (a `traceparent` on the command, an `x-trace-link` on the timeout) is
  not written; the instrumentations of `pg` and `amqplib` do patch under Vitest, so it can be.
- **No manual span for a step of the saga**, and no Kafka: second pass of the roadmap.
- **A trace id is on no log line**: 4.4.
- **The resource of a span names the host and the command line** (the default detectors of
  the SDK). Fine on a developer machine; a deploy chooses its detectors.
- **A message parked in a dead-letter queue keeps its `traceparent`**: put back days later,
  it continues a trace that Tempo may have dropped.

## What 4.4 starts from

- The SDK is in every process: `trace.getActiveSpan()` gives the `traceId` a log line needs.
- `ops/observability.md` §3 says "with OTel present, `correlationId = traceId`". Here they
  differ on purpose so far: the correlation id may come from the caller and follows a
  delayed message, the trace does not. 4.4 decides whether a line carries both.
- Logs to Loki: the container agent and the OTLP transport of pino, as ADR 0024 lists them.
