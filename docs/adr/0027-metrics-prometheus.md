# 0027 — Metrics: every process counts, Prometheus reads

Date: 2026-10-10 Status: accepted

## Context

A log line and a trace are about one request (ADR 0023, 0025). Neither answers "how many
orders a minute", "what share of them fails", "is the queue growing". Those are numbers over
time, and a number costs almost nothing to keep, which is why it can be kept for everything.

ADR 0024 settled the way: `prom-client` and `GET /metrics` in every process, pulled by the
Prometheus inside `lgtm`, not pushed over OTLP. Four of the five processes had no HTTP server.

## Decision

- **A port `METRICS`** (`shared/observability/metrics.ts`: `counter`, `gauge`, `histogram`),
  injected by token like `LOGGER`, implemented once on `prom-client`
  (`infrastructure/observability/prom.metrics.ts`). A copy in the four services.
- **A registry of its own per application**, not the global one of the library: the e2e
  suite runs several applications in one process.
- **Every process serves `GET /metrics` on a port of its own** (`METRICS_PORT`): a bare
  `node:http` server that knows one path. Unset, the api takes 9464, its worker 9465,
  payments 9466, inventory 9467, notifications 9468 (under `pnpm dev` they share a host); a
  container names 9464; `0` serves nothing (`.env.test`).
- **Every series carries `process`** (`api`, `worker`), set by the registry. `service` and
  `deployment` are labels of the scrape target.
- **The entries count where they already write their line**, with the same closed values:

  | Metric                                                                                       | Where                                    |
  | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
  | `http_request_duration_seconds{method, route, status}`                                       | `httpEntry`                              |
  | `use_case_duration_seconds{use_case, outcome}`                                               | `@UseCase()`                             |
  | `queue_job_duration_seconds{queue, job, outcome}`, `cron_last_success_timestamp_seconds`     | `JobScope`                               |
  | `queue_job_dead_total{queue, job}`                                                           | `JobScope.died()`, called by consumers   |
  | `broker_message_duration_seconds{queue, outcome}`                                            | `RabbitSubscribers`                      |
  | `broker_messages_retried_total{queue}`, `broker_messages_parked_total{queue}`                | `retry-or-park.ts`                       |
  | `outbox_pending`, `outbox_oldest_age_seconds`, `outbox_published_total`                      | `OutboxMetrics`, the runner of the relay |
  | `queue_jobs{queue, state}`                                                                   | `QueueDepthCollector` (worker)           |
  | `db_pool_connections{pool, state}`                                                           | `MeasuredPrismaPg`                       |
  | `outbound_call_duration_seconds{vendor, operation, status}`, `circuit_breaker_state{vendor}` | the gateway of payments                  |
  | `notifications_dispatched_total{outcome}`                                                    | the dispatcher of notifications          |

  RED of HTTP is one histogram: its count is the rate, its count by status the errors, its
  buckets the duration.

- **A gauge that is a fact of a store is asked at the scrape** (`collect`), not on a timer:
  the backlog of the outbox (one statement on the index of the relay), the depth of the
  BullMQ queues, the counters of the pool. One process reports a fact of the service: the
  worker. A read that fails shows no value for that scrape, never 0.
- **The business metrics are counted from the domain events, after the commit**:
  `orders_placed_total`, `orders_paid_total`, `orders_payment_failed_total{cause}`,
  `orders_returned_to_draft_total{cause}`, `orders_cancelled_total`,
  `orders_fulfilled_total`. A module registers the count of its events in `EventMeters`
  (`orders/infrastructure/order-events.meter.ts`), as it registers their translations, and
  `DomainEventPublisher` calls it through `afterCommit`. No use case counts.
- **A label takes its values from a closed set.** A route is its pattern, a use case its
  class, an outcome a code. The reason of a failed payment is the decline code of the
  provider, an open set: it is mapped to `cause` (`provider_unavailable`,
  `provider_rejected`, `timeout`, and `declined` for everything else).
- **No label names a tenant, an order or a user.** Every value of a label is a time series
  for every combination of the others: a histogram of 100 route-and-status pairs is 1 200
  series, and 6 million with 5 000 workspaces on it. Which tenant is a question for the logs
  and the traces, where the id is a field and not a dimension.
- **A histogram keeps an exemplar**: an observation made inside a recorded trace stores its
  `trace_id` beside the bucket (the registry speaks OpenMetrics for that). Nobody passes
  it: it is read from the active span. Grafana turns it into a link to Tempo.
- **The broker and the databases measure themselves.** RabbitMQ has `rabbitmq_prometheus`
  (the detailed endpoint, per queue); the five Postgres servers are asked by one
  `postgres-exporter`. The pool of a process is ours to measure: no exporter sees a query
  that waits for a connection.
- **The configuration of Prometheus is a file of the repository**
  (`devtools/observability/prometheus.yaml`), mounted over the file of the image: its
  content, plus the targets. The targets of both ways to run the services are listed, the
  processes of the host and the containers of the `app` profile.
- **The dashboard is a file too**: `OMS · System` (`devtools/observability/grafana/`).

## Consequences

- A use case, the domain and a repository did not change. In `modules/` there is one new
  file per service that has something of its own to count.
- "Is it up" has an answer that is not silence: `up == 0`.
- A new entry, a new queue or a new use case is counted with no line written.
- A new label is a decision about cardinality, and `metrics.e2e-spec.ts` (MET-037) fails
  for an id on any label.

## What it looks like

```
$ curl -s localhost:9464/metrics | grep place
http_request_duration_seconds_bucket{le="0.1",method="POST",route="/v1/workspaces/:workspaceId/orders/:orderId/place",status="202",process="api"} 40 # {trace_id="a89a…9ab8",span_id="44ba…6646"} 0.0026
orders_placed_total{process="api"} 40
```

`pnpm demo:orders` gives the dashboards something to show.

## Rejected

- **Metrics over OTLP** (the SDK is already in the process, and `HttpInstrumentation` emits
  a duration histogram by itself): no port, no server in a worker, no file of targets. Not
  taken: a process that died is silence instead of `up == 0`; the route label and the
  buckets would be the library's; ADR 0024 and `ops/observability.md` §1 say pull, and so
  does a cluster (Step 5).
- **A pool of ours handed to the adapter of Prisma**: the documented way to reach the pool.
  Its life would become ours. The adapter is subclassed instead and only says which pool it
  made.
- **A counter in the use case**: counts a write that is rolled back, and puts the name of a
  metric into `application/`.
- **`reason` as a label**: whatever a provider writes there becomes a series.
- **A label `workspace_id` on the business metrics only**: the number of tenants is the
  number of series whichever metric carries it.

## Known gaps

- **The count of an event may run a moment before the commit** on the two routes with an
  `Idempotency-Key` and in a consumer (`inbox.once()`): the transaction is opened around the
  use case there, and `afterCommit` fires when the use case returns. A rollback after that
  leaves one count too many. Rare, and a counter is not a ledger.
- **`orders_cancelled_total` does not say why**: an order cancelled on a failed charge
  publishes `-cancelled` only (ADR 0017), and is not in `orders_payment_failed_total`.
- **No `use_case_duration_seconds` in payments, inventory and notifications**: they have no
  `@UseCase()`. The duration of their handler is `broker_message_duration_seconds`.
- **No `db_query_duration_seconds`** (`ops/observability.md` §1): the spans of `pg` say
  where the time of one request went; a histogram per model and action is not built.
- **`postgres-exporter` connects as the owner** of each dev database: the stack has no
  monitoring role. A deploy gives it a member of `pg_monitor`.
- **No exporter for PgBouncer and Redis.**
- **The targets of the way the services are not run are down** (`up == 0`), in one job.
  Step 5 discovers its targets.
- **Consumer lag of Kafka**: with 3.8.

## What 4.6 starts from

- `orders_paid_total` and `orders_payment_failed_total{cause}` are the two sides of "did the
  payment of a placed order come to an end": `place` itself answers 202 whatever happens.
- `http_request_duration_seconds` has the route of `place` as one value.
- Rules of Prometheus are files beside `prometheus.yaml`; Grafana reads every file of its
  provisioning folders.
