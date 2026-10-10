# 0024 — The observability stack: Grafana, Loki, Tempo and Prometheus in one container

Date: 2026-10-10 Status: accepted

## Context

Five processes write JSON lines to stdout (ADR 0023), and that is all the system tells about
itself. Step 4 adds traces and metrics, and each of the three signals needs a store of its
own, because the data has another form: lines found by a few labels (Loki), trees of spans
found by a trace id (Tempo), series of numbers over time (Prometheus). Grafana stores none
of it and asks the three.

Before a service sends anything, there has to be somewhere to send it. This item builds
that side only.

## Decision

- **One container, `grafana/otel-lgtm`**, the image the roadmap names: Grafana, Loki, Tempo,
  Prometheus, Pyroscope and an OpenTelemetry Collector, wired to each other inside the
  image. The tag is pinned (`0.36.0`); dependabot follows `docker-compose.yml`.
- **The services will know one address, the Collector**: OTLP on `4317` (gRPC) and `4318`
  (HTTP). It hands logs to Loki, traces to Tempo and metrics to Prometheus. No service
  writes to a store itself, so a store can be replaced with no change in a service.
- **It is part of the dev infrastructure**: it starts with `pnpm infra:up`, because
  `pnpm dev` on the host has to send somewhere too. The three ports are published for that.
- **Grafana is on `3001` of the host**: `3000` is the api. Inside the compose network it
  stays `lgtm:3000`.
- **What it keeps is in a volume** (`lgtm-data` on `/data`): the three stores and the
  database of Grafana, so a dashboard made by hand outlives `pnpm infra:down`.
- **Its health is the check of the image** (`/otel-lgtm/docker/healthcheck.sh`: Grafana,
  Loki, Tempo, Prometheus and the Collector each answer), asked every 5 s and not every
  30 s: `infra:up` waits for it.
- **The stack of the system tests starts without it**: `docker-compose.system.yml` gives
  `lgtm` a profile nobody asks for. That suite has three windows (ADR 0022), and the ports
  would meet the ones of the dev stack. `pnpm test:contract` runs one service with its
  dependencies, and `lgtm` is nobody's dependency.

## Consequences

- `pnpm infra:up` starts one container more: an image of about 900 MB, a few hundred MB of
  memory, some ten seconds until it is healthy.
- Grafana has four data sources from the start (Loki, Tempo, Prometheus, Pyroscope), and
  each answers and is empty.
- Anyone who reaches port 3001 is an administrator of Grafana: the image lets an anonymous
  caller in. It is a dev stack on a developer's machine.
- The data sources, the configuration of the Collector and of the stores are files inside
  the image. A change is a file mounted over one of them (`/otel-lgtm/*.yaml`).

## What it looks like

```
api, worker, payments, inventory, notifications        (nothing sent yet)
        │  OTLP  4317 gRPC / 4318 HTTP
        ▼
  ┌─ lgtm ──────────────────────────────────────┐
  │  OTel Collector ──┬─ logs    → Loki         │
  │                   ├─ traces  → Tempo        │
  │                   └─ metrics → Prometheus   │
  │  Grafana :3000 (host 3001) reads the three  │
  └─────────────────────────────────────────────┘
```

`curl -X POST localhost:4318/v1/traces -H "Content-Type: application/json" -d "{}"` answers
`{"partialSuccess":{}}`: the receiver listens from the host.

## Rejected

- **Five containers, one per component.** The same data and the same OTLP address for the
  services, with four configuration files written by hand: what the Collector exports to,
  where Grafana finds each store. It is how the stack is deployed for real, and it shows the
  wiring the image hides. Left for when the files inside the image get in the way: 4.5
  mounts one (the scrape targets), 4.4 and 4.6 provision Grafana. Step 5 puts the stack into
  the cluster and decides again.
- **The distributed mode of Loki and Tempo, with object storage.** That is about volume and
  availability, which this project does not have, and it teaches nothing about what a
  service has to send.
- **A profile of its own (`--profile observability`).** One command more to remember, and a
  dev stack whose services send to nobody by default.
- **Collecting the logs here.** ADR 0023 left it to this item. A service would get a
  transport for its logs now and a second look at it two items later, when the OpenTelemetry
  SDK is in the process (4.3) and a line has a `traceId` (4.4). It is built once, in 4.4.

## Known gaps

- **Nothing is sent**: the stores are empty. Traces 4.3, logs 4.4, metrics 4.5.
- **Not a production stack**: one instance of everything on a local disk, no retention set,
  no login. The container down means no signal at all, Grafana included.
- **Nothing of Grafana is in the repository**: a dashboard or an alert made in the UI lives
  in the volume only. 4.5 and 4.6 provision theirs from files.
- **The containers of the `app` profile do not know the Collector**: no `OTEL_*` setting and
  no `depends_on`. 4.3.

## What 4.3 starts from

Not decisions of 4.3: what is there, and what was settled while this was planned.

- **The address of the Collector**: `http://localhost:4318` for a process under `pnpm dev`,
  `http://lgtm:4318` for a container of the `app` profile. Unset means "send nothing": the
  tests and the system stack have no Collector.
- **Metrics will be pulled** (4.5): `prom-client` and `GET /metrics` in every process, as
  `ops/observability.md` §1 asks, not pushed over OTLP. The Prometheus of the image scrapes
  nothing of ours: its targets are a file mounted over `/otel-lgtm/prometheus.yaml`, and
  they differ between `pnpm dev` (`host.docker.internal`) and the `app` profile (service
  names).
- **Logs reach Loki in two ways** (4.4): in a container an agent reads stdout, which is
  what `logs: stdout` means for a deploy; under `pnpm dev` the processes are not containers
  and pino sends OTLP itself, beside stdout. The labels are the few fields ADR 0023 names
  (`service`, `level`, `context`); a correlation id is a value to search for, never a label.
- **Pyroscope is in the image and no item of the roadmap uses it.**
