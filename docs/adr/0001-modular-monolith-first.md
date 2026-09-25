# 0001 — Modular monolith first

Date: 2026-09-25 Status: accepted

## Context

The target system has five services (api, payments, inventory, notifications, analytics)
talking over RabbitMQ and Kafka. Building them all at once would mean designing service
boundaries before the domain is understood, and debugging distributed failures before the
single-process behaviour is correct.

## Decision

Step 0 is one `api` service: a modular monolith with three modules (`identity`, `catalog`,
`orders`) and strict boundaries:

- a module exports only its facade; other modules import only its `index.ts`
  (ESLint `no-restricted-imports` + `eslint-plugin-boundaries`);
- each table is owned by one module; no cross-module joins;
- the payment provider sits behind the `PaymentGateway` port in `orders`;
- the process model is final from day one: `main.api.ts` and `main.worker.ts`, one image.

## Consequences

- Step 3 extracts `payments-service` by adding a `PaymentGateway` adapter that talks to it
  and moving the charge logic out; `orders` domain and use cases stay as they are.
- Cross-module foreign keys are kept (`cross-module-fk: yes`) because identity, catalog and
  orders remain together in `api` even after Step 3.
- In-process events are enough for now; the enqueue-after-commit gap is accepted (ADR 0004).
