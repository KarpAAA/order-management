# 0026 — Logs in Loki, and a trace id on every line

Date: 2026-10-10 Status: accepted

## Context

Two signals exist and do not know each other. A log line says what happened and why, on
stdout of five processes, collected by nobody (ADR 0023). A trace says where the time went
and who called whom, in Tempo (ADR 0025), found by its id only. An incident starts from a
line (`error`), and the question after it is the whole request: without a common key the
trace is searched for by time and service name.

Loki has been there since ADR 0024, empty. That ADR also settled that the lines reach it in
two ways, because a process is run in two ways: as a container, and under `pnpm dev`.

## Decision

- **A line carries `traceId` and `spanId` of the span under way**, written by our logger:
  the `mixin` of pino reads `trace.getActiveSpan()`, beside the correlation id it already
  reads from CLS (`infrastructure/logger/pino.logger.ts`, a copy in the four services).
  Without an SDK the API of OpenTelemetry gives no span, and the line is what it was.
- **Two fields, `correlationId` and `traceId`.** They answer two questions. The correlation
  id may be chosen by the caller and follows a delayed message; a timeout of the saga begins
  a trace of its own that only links back (ADR 0025). "Everything about this order" is the
  correlation id, "this one chain of calls" is the trace.
- **In a container an agent reads stdout**: Grafana Alloy (`alloy`, `devtools/alloy/config.alloy`,
  profile `app`). It asks Docker for the output of the containers of the services and of
  `fake-psp`, and pushes the lines to Loki inside `lgtm`. A service knows nothing of it,
  which is what `logs: stdout` means.
- **Under `pnpm dev` the process sends its lines itself**, over OTLP to the Collector:
  `OTEL_LOGS_EXPORTER=otlp` adds a log exporter to the SDK of `src/instrumentation.ts`, and
  the instrumentation of pino hands every line to it, beside stdout. It only forwards: it
  writes no id into the line (`disableLogCorrelation`).
- **`OTEL_LOGS_EXPORTER` is `none` unless said**, and `none` in every container of the
  compose files. `.env.example` says `otlp`: it is the file of a process on the host.
- **`logRecordProcessors` is always given to the SDK**, empty when nothing is sent. Left
  out, the SDK reads `OTEL_LOGS_EXPORTER` itself, and its default is to send.
- **Loki has one label, `service_name`**, equal to `service.name` of the traces (`oms-api`,
  `oms-worker`, `oms-payments`, `oms-inventory`, `oms-notifications`, `oms-fake-psp`).
  Everything with many values is structured metadata, unindexed and still a filter:
  `trace_id`, `span_id`, `correlationId`, `context`. The agent uses the names a line sent
  over OTLP gets, so one query reads both. The level is `detected_level` in both.
- **Grafana is not provisioned.** The data sources of the image already join the two:
  Loki → Tempo on `trace_id`, Tempo → Loki with `{service_name="…"} | trace_id="…"`. We
  took its names instead of mounting a file of our own over its configuration.

## Consequences

- A line with an `error` has a button to its trace, and a span has "Logs for this span".
- One query finds an order in every service, whichever way the lines came:
  `{service_name=~"oms-.+"} | correlationId="<x-correlation-id of the answer>"`.
- Three packages more in each service (`exporter-logs-otlp-http`, `sdk-logs`,
  `instrumentation-pino`), loaded only when the SDK starts.
- The agent mounts the Docker socket, read-only: it can see every container of the machine.
  It reads the ones of the compose project `oms` and keeps how far it read in a volume
  (`alloy-data`), so a restart sends no line twice.
- A new service of the `app` profile is a name in the `keep` rule of `config.alloy`, and
  its `service.name` is `oms-<compose service>`: the join from a span to its logs is by that
  name.
- The stack of the system tests starts neither `lgtm` nor `alloy`.

## What it looks like

```
pnpm dev (host)                               docker compose --profile app
  process ── stdout (terminal)                  container ── stdout ── Docker
     │  OTLP /v1/logs, /v1/traces                   │ OTLP /v1/traces      │
     ▼                                              ▼                      ▼
  ┌─ lgtm ───────────────────────────────────────────────┐            alloy
  │  Collector ──┬─ logs   → Loki  ◄──────────────────────┼── push ───────┘
  │              └─ traces → Tempo                        │
  │  Grafana: Loki ⇄ Tempo by trace_id / service_name     │
  └───────────────────────────────────────────────────────┘
```

Checked by hand in both modes (2026-10-10), through the API of Grafana: an order placed and
paid, its lines found by the correlation id in `oms-api`, `oms-worker`, `oms-inventory`,
`oms-payments`, `oms-notifications` and `oms-fake-psp`, each once, all but the ones named
below with the `trace_id` of one trace that Tempo returns; the query of the Tempo link
returns the lines of a service for that trace.

## Rejected

- **`correlationId = traceId`** (`ops/observability.md` §3). Either a timeout continues the
  trace of its order, which then lasts ten minutes, or a search by the id loses half of
  what an order caused. And a caller could no longer name its chain.
- **The instrumentation of pino writing the ids.** It writes `trace_id` under its own
  names, only in a process started with the preload, and nothing in a unit test shows it.
  Three lines of ours beside the correlation id are tested like the rest of the logger.
- **`pino-opentelemetry-transport`.** A second exporter in a worker thread, with a
  `service.name` to repeat in the logger; the SDK is already in the process and names it.
- **The Collector reading the log files of Docker** (`filelog`). The path is inside the
  virtual machine of Docker Desktop; the socket is the same everywhere.
- **The agent sending OTLP to the Collector.** One conversion more to arrive in the same
  Loki. "A service knows the Collector only" is a rule for services.
- **A data source file of our own**, to keep `service` as the label ADR 0024 named. A copy
  of the configuration of the image to follow with every tag, for a name.

## Known gaps

- **The line differs between the two ways.** Through the agent it is the JSON the process
  wrote (`| json` reads its fields); over OTLP it is the message, with the fields beside it.
  The ids, `context`, `service_name` and the level have the same names in both.
- **A line written outside a span has no trace**: a tick of the relay or of a scheduler,
  and the lines of the dispatcher of notifications (`mail sent`, `notification given up`),
  written by its timer after the span of the send has ended. They carry the correlation id.
  The dispatcher line is the one worth fixing: an entry class may not import
  `infrastructure/tracing/` (lint), so it needs the trace of the notification handed to it.
- **`fake-psp` has no SDK**: its lines are collected and carry the correlation id only.
- **The click in Grafana was not automated**: the data on both sides and the two queries of
  the links were checked through the API; nothing in a test opens Explore.
- **No retention, no limits**: a `debug` level under `pnpm dev` goes to Loki as it is.
- **A line is lost with the Collector away** (the batch of the SDK is dropped after its
  retries); in a container the agent waits and sends later.

## What 4.5 starts from

- `service_name` is the name of a process in logs and traces: a metric takes the same.
- The data source of Prometheus in the image already has an exemplar link to Tempo
  (`trace_id`): a histogram that records exemplars gets the jump from a graph to a trace.
- Cardinality has been met once: ids are not labels in Loki, and are not labels of a metric.
- The first file mounted over the configuration of the image is still to come: the scrape
  targets of Prometheus (ADR 0024).
