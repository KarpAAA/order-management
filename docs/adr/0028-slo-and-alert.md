# 0028 — Two SLIs, their objectives, and one alert

Date: 2026-10-10 Status: accepted

## Context

The metrics are there (ADR 0027). A dashboard is looked at when somebody already suspects
something. What is missing is the promise the system makes to its user, said as a number,
and somebody being told when it is broken.

The promise is about `place`: a user who places an order expects it to be paid for. And
`POST …/place` cannot say whether that happened: it answers 202 once the saga has begun, and
the payment ends minutes later in another process (ADR 0017). With the provider down every
`place` still succeeds.

## Decision

- **SLI 1, success of `place`**: of the payment attempts that ended, the share the system
  brought to an end.

  ```
  paid / (paid + failed{cause != "declined"})
  ```

  from `orders_paid_total` and `orders_payment_failed_total` (ADR 0027). A declined card is
  not a failure of the system and is in neither part. An order that goes back to DRAFT for
  lack of stock never asked for a payment and is not an attempt. No attempt ended in the
  window: no value.

- **SLI 2, latency of `place`**: the 95th percentile of
  `http_request_duration_seconds{route=".../place"}`.
- **The objectives**: 99 % of the attempts of 30 days succeed; p95 below 300 ms. The error
  budget is the other 1 %: `slo:place_success:error_budget_remaining` is the share of it
  that is left. Step 6.2 holds the system to both under load.
- **The SLIs are recording rules of Prometheus** (`devtools/observability/rules/slo.yaml`),
  mounted beside its configuration. The dashboard and the alert read the recorded series.
  Rules of Prometheus, because they can be tested: `slo.test.yaml` gives promtool six kinds
  of traffic and the value each must give (`pnpm test:rules`, the CI job `static`).
- **One alert, in Grafana, on the first SLI**: `PlaceSuccessRatioLow`, the 5-minute ratio
  below 0.99 for one minute. `noData` is OK: nothing ended, nothing was broken. It is a
  symptom (orders are not being paid), not a cause (the provider is down): the cause is on
  the dashboard the alert names.
- **The alert is a mail**, sent through the mail server of the dev stack: Grafana gets
  `GF_SMTP_*` for Mailpit. Firing and resolved are both told.
- **The rule, the contact point and the dashboard `OMS · SLO` are files**
  (`devtools/observability/grafana/`), read by Grafana at its start.

## Consequences

- The outage of the provider is seen in three places that agree: the circuit of payments
  opens, the ratio falls, the alert fires.
- The alert is late by design. The provider down at 17:12:07 was an alert at 17:15:44: a
  charge is tried for about two minutes before it is given up (ADR 0020), then the window
  has to hold enough failures, then the rule waits its minute. And it resolves some six
  minutes after the provider is back, when the failures have left the 5-minute window.
- A new reason of a failed payment has to be given a cause (`paymentFailureCause()`):
  unnamed, it is `declined` and does not count against the objective.

## What it looks like

```
$ docker compose stop fake-psp        # circuit_breaker_state → 2 within seconds
…                                     # orders_payment_failed_total{cause="provider_unavailable"} grows
                                      # sli:place_success:ratio_rate5m → 0.34
Mailpit: [FIRING:1] PlaceSuccessRatioLow (OMS page)
$ docker compose start fake-psp       # the circuit closes, the ratio climbs back
Mailpit: [RESOLVED] PlaceSuccessRatioLow (OMS page)
```

## Rejected

- **The SLI from the HTTP status of `place`**: 100 % with the provider down.
- **The rule as an alert rule of Prometheus with an Alertmanager**: a component the image
  does not have, for one rule. The roadmap names Grafana.
- **The SLI computed inside the Grafana rule**: nothing tests it.
- **Alerting on the circuit of payments**: a cause. It opens for a blip that costs no order.
- **A shorter window to make the alert fast**: one failed payment among five would fire it.
  Fast and slow together is what burn-rate rules are for.

## Known gaps

- **One alert.** Latency, the queues, a dead job, a parked message, the age of the outbox
  and the burn rate of the budget have metrics and no rule: second pass of the roadmap.
- **An attempt that never ends is in neither part of the ratio.** A saga that hangs shows
  as orders placed and not paid, on the dashboard only; the timeouts of the saga end it as
  `timeout`, which is counted.
- **The 30-day window is as long as the data of the dev volume.**
- **No silence, no escalation, no runbook**: a mail to one address.
- **The mail of the alert and the mails of notifications share one Mailpit.**

## What Step 5 starts from

- Every process has a port for `/metrics` and none for health: `/health/live` and
  `/health/ready` go on a probe port, with the graceful shutdown (`ops/observability.md` §4).
- The scrape targets are a static file for two ways to run the services; a cluster
  discovers them.
- The stack is one container with files mounted over its configuration, four of them now:
  ADR 0024 left the split into components for when that gets in the way.
